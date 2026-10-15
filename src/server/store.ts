import {
  chairmanOf,
  compileCouncil,
  type FlowStep,
  invalidateDescendants,
  releasableSteps,
  runsOf,
  seatsOf,
} from '../shared/flow.ts';
// Storage: one JSON file per session in <home>/sessions. A write goes to a temp file in the same folder, is flushed and
// renamed over the session, so a crash leaves either the old file or the new one, never half of one. A round is saved as
// `running` before it starts; on startup every leftover running round becomes `interrupted`.
//
// While a round's members are still answering, what the finished ones said stays in memory: every save goes through
// `serializeSession`, which withholds the current round's member outputs until all its seats have settled. A member that
// can read files therefore never finds a sibling's answer on disk, whichever save (progress, layout, rename) runs.

import { randomBytes } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
} from 'node:fs';
import { open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chairmanKey, speedKey } from '../shared/defaults.ts';
import { REASONING_LEVELS } from '../shared/levels.ts';
import { estimateTokens, shorten } from '../shared/text.ts';
import type {
  ChairNode,
  ReasoningLevel,
  SeatRun,
  Session,
  SessionNode,
  SessionSummary,
  SettingsFile,
} from '../shared/types.ts';
import { ownerOnly } from './secure.ts';

export function defaultHome(): string {
  return process.env.DIVAN_HOME ?? join(homedir(), '.dio-divan');
}

/**
 * Atomically replaces `file` with `text`: temp file, flush to disk, rename. A `secret` file is owner-only from the moment
 * it exists, before anything is written to it.
 */
export async function writeFileAtomic(file: string, text: string, secret = false): Promise<void> {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const handle = await open(temp, 'w', secret ? 0o600 : 0o666);
  try {
    if (secret) ownerOnly(temp, false);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // Windows can refuse a rename for a moment while a scanner holds the target; try a few times.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temp, file);
      return;
    } catch (error) {
      if (attempt >= 8) {
        await rm(temp, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export function summarize(session: Session): SessionSummary {
  const chairs = Object.values(session.nodes).filter(
    (node): node is ChairNode => node.kind === 'chair',
  );
  const root = session.nodes[session.rootId];
  const finished = chairs
    .filter((chair) => chair.status === 'done')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const latest = finished.find((chair) => chair.direction.trim());
  const recommended = finished.find((chair) => chair.recommendation?.choice.trim());
  // What the list calls a session: the name Omid gave it, else the chairman's title of the question (like the tree shows it),
  // else the first words of the question while no round has titled it yet.
  const asked = root && root.kind !== 'chair' ? root.text : session.settings.question;
  const named = session.name !== shorten(asked, 60);
  const chairTitle =
    root && root.kind !== 'chair' && root.title !== shorten(root.text, 40) ? root.title : '';
  return {
    id: session.id,
    name: session.name,
    title: !named && chairTitle ? chairTitle : session.name,
    question: asked,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    rounds: chairs.filter((chair) => chair.status === 'done').length,
    ...(latest ? { direction: latest.direction.trim() } : {}),
    ...(recommended?.recommendation
      ? {
          recommendation: {
            choice: recommended.recommendation.choice.trim(),
            confidence: recommended.recommendation.confidence,
          },
        }
      : {}),
    tokens: chairs.reduce((sum, chair) => sum + chair.usage.total, 0),
    running: chairs.some((chair) => chair.status === 'running'),
    origin: session.origin?.kind ?? 'web',
    ...(session.origin?.client ? { client: session.origin.client } : {}),
  };
}

/** What a seat's error says on disk while its round is still running (the real text stays in memory). */
export const WITHHELD = 'withheld until the round is saved whole';

const unsettled = (seat: SeatRun) => seat.state === 'pending' || seat.state === 'running';

/** The round as the disk may have it while some member is still answering: no outputs, parsed answers or diagnostics. */
function withheld(node: ChairNode): ChairNode {
  const { activity: _chairActivity, toolLog: _chairLog, ...chairman } = chairmanOf(node);
  return {
    ...node,
    seats: seatsOf(node).map((seat) => {
      const { activity: _activity, toolLog: _log, ...rest } = seat;
      return {
        ...rest,
        rawOutput: '',
        parsed: null,
        sanitized: null,
        trimmed: [],
        error: seat.error ? WITHHELD : null,
      };
    }),
    chairman,
    attempts: (node.attempts ?? []).map((attempt) => ({
      ...attempt,
      error: attempt.error ? WITHHELD : null,
    })),
  };
}

/**
 * What a save writes in place of the live session's own: nodes (a round about to start, a round about to finish), the layout
 * and the name a mutation is about to give it, and the time. The live session is left as it is: a mutation applies its
 * change to memory only after the write has succeeded.
 */
export interface Overlay {
  nodes?: SessionNode[];
  layout?: Session['layout'];
  name?: string;
  updatedAt?: string;
  schemaVersion?: Session['schemaVersion'];
}

/**
 * The text written to disk, with the overlay laid over the live session. A running round with a seat still pending or
 * running is withheld.
 */
export function serializeSession(session: Session, over: Overlay = {}): string {
  const nodes: Record<string, SessionNode> = { ...session.nodes };
  for (const node of over.nodes ?? []) nodes[node.id] = node;
  for (const [id, stored] of Object.entries(nodes)) {
    let node = stored;
    if (node.kind === 'chair' && node.steps) {
      const { seats: _seats, chairman: _chairman, ...canonical } = node;
      node = canonical;
      nodes[id] = node;
    }
    if (
      node.kind === 'chair' &&
      node.steps &&
      node.steps.some((step) => step.run.state === 'pending' || step.run.state === 'running')
    ) {
      const released = releasableSteps(
        session.settings.flow ?? compileCouncil(session.settings),
        node.steps,
      );
      nodes[id] = {
        ...node,
        steps: node.steps.map((step): FlowStep => {
          if (step.form === 'condition') return step;
          const { activity, toolLog: _log, folderNote: _folder, ...run } = step.run;
          const base = { ...run, rawOutput: '', trimmed: [], error: run.error ? WITHHELD : null };
          if (step.form === 'answer')
            return { ...step, output: null, run: { ...base, input: '' } as typeof step.run };
          return {
            ...step,
            run: {
              ...base,
              ...(released.has(step.id) && activity ? { activity } : {}),
              prompt: '',
              parsed: null,
              sanitized: released.has(step.id) ? step.run.sanitized : null,
            },
          } as FlowStep;
        }),
        attempts: node.attempts.map((attempt) => ({
          ...attempt,
          error: attempt.error ? WITHHELD : null,
        })),
      };
    } else if (
      node.kind === 'chair' &&
      node.status === 'running' &&
      seatsOf(node).some(unsettled)
    ) {
      nodes[id] = withheld(node);
    }
  }
  return JSON.stringify({
    ...session,
    ...(over.schemaVersion ? { schemaVersion: over.schemaVersion } : {}),
    ...(over.layout ? { layout: over.layout } : {}),
    ...(over.name !== undefined ? { name: over.name } : {}),
    ...(over.updatedAt !== undefined ? { updatedAt: over.updatedAt } : {}),
    nodes,
  });
}

const NOW = () => new Date().toISOString();

// Content revisions (`NodeBase.rev`) do not depend on the clock: a revision is the start's generation (a number that goes up by
// one every time a server starts on this home, kept in generation.json) times a span, plus a counter that goes up with every
// revision this process makes. So a revision made after a restart is above every one made before it, whatever the clock
// says and whatever was or was not saved. The base keeps them above the clock readings (milliseconds) of the earlier build.
const REV_BASE = 2e12;
const REV_SPAN = 1e9;

/**
 * Marks every round still `running` as `interrupted` (its seats and chairman that had not finished as `failed`). A
 * call that was in flight has cost something that is unknown: it is recorded as an attempt with an estimate, so the
 * meter does not forget it.
 */
export function interruptRunning(session: Session, nextRev: () => number): boolean {
  let changed = false;
  for (const node of Object.values(session.nodes)) {
    if (node.kind !== 'chair' || node.status !== 'running') continue;
    node.status = 'interrupted';
    node.error = 'interrupted';
    node.endedAt = NOW();
    // a page that last saw this round running must take this over it
    node.rev = nextRev();
    node.attempts = node.attempts ?? [];
    const lost = (
      kind: 'seat' | 'chairman',
      seatId: string | null,
      label: string | null,
      call: {
        harness: SeatRun['harness'];
        model: string;
        prompt: string;
        promptTokens?: number;
        startedAt: string | null;
      },
    ) => {
      const input = call.promptTokens ?? estimateTokens(call.prompt);
      node.attempts.push({
        kind,
        seatId,
        label,
        harness: call.harness,
        model: call.model,
        state: 'failed',
        error: 'interrupted',
        usage: { input, output: 0, cached: 0, total: input, source: 'estimate' },
        promptTokens: input,
        councilTokens: input,
        startedAt: call.startedAt,
        endedAt: NOW(),
      });
    };
    for (const seat of runsOf(node)) {
      const step = node.steps?.find((s) => s.id === seat.seatId);
      if (seat.state === 'skipped' && step?.skipReason) {
        seat.error = step.skipReason;
        continue;
      }
      if (seat.state === 'pending' || seat.state === 'running') {
        if (seat.state === 'running') lost('seat', seat.seatId, seat.label, seat);
        seat.state = 'failed';
        seat.error = 'interrupted';
        seat.endedAt = NOW();
      } else if (seat.error === WITHHELD || (seat.state === 'done' && !seat.sanitized)) {
        // It had answered, but its answer was held in memory until the round was saved whole: it is gone, and its
        // call is already on the books (an attempt), so nothing is added to the spend.
        seat.state = 'failed';
        seat.error = 'interrupted: the answer was only in memory';
      }
    }
    for (const attempt of node.attempts)
      if (attempt.error === WITHHELD) attempt.error = 'interrupted';
    if (chairmanOf(node).state === 'pending' || chairmanOf(node).state === 'running') {
      if (chairmanOf(node).state === 'running') {
        lost('chairman', null, null, { ...chairmanOf(node), prompt: chairmanOf(node).input });
      }
      chairmanOf(node).state = 'failed';
      chairmanOf(node).error = 'interrupted';
      chairmanOf(node).endedAt = NOW();
    }
    if (node.steps && session.settings.flow) {
      const lostSources = node.steps
        .filter(
          (s) =>
            (s.run.state === 'failed' && s.run.error?.startsWith('interrupted')) ||
            (s.form === 'condition' &&
              (s.run.state === 'pending' ||
                s.run.state === 'running' ||
                (s.run.state === 'done' && s.result === null))),
        )
        .map((s) => s.id);
      const invalid = invalidateDescendants(session.settings.flow, node.steps, lostSources);
      for (const step of node.steps)
        if (invalid.has(step.id)) {
          step.run.state = 'failed';
          step.run.error = 'interrupted';
        }
    }
    const planner = node.attempts
      .filter((x) => x.kind === 'planner')
      .reduce((n, x) => n + (x.usage?.total ?? 0), 0);
    node.usage = {
      members: node.attempts
        .filter((x) => x.kind === 'seat')
        .reduce((n, x) => n + (x.usage?.total ?? 0), 0),
      chairman: node.attempts
        .filter((x) => x.kind === 'chairman')
        .reduce((n, x) => n + (x.usage?.total ?? 0), 0),
      ...(planner > 0 ? { planner } : {}),
      total: node.attempts.reduce((n, x) => n + (x.usage?.total ?? 0), 0),
      council: node.attempts.reduce((n, x) => n + x.councilTokens, 0),
      cached: node.attempts.reduce((n, x) => n + (x.usage?.cached ?? 0), 0),
      estimated: node.attempts.some((x) => x.usage?.source === 'estimate'),
    };
    changed = true;
  }
  return changed;
}

export class Store {
  settingsBackup: string | undefined;
  readonly home: string;
  readonly sessionsDir: string;
  private sessions = new Map<string, Session>();
  private queues = new Map<string, Promise<unknown>>();
  private deleted = new Set<string>();

  constructor(home: string = defaultHome()) {
    this.home = home;
    this.sessionsDir = join(home, 'sessions');
  }

  /** Loads every session; leftover temp files are removed and running rounds become interrupted. */
  /** This start's generation (see the revisions above); 0 until `init`. */
  private generation = 0;
  private revCounter = 0;

  /** The next content revision: above every one made before it, by this process and by every one that ran on this home before. */
  nextRev(): number {
    this.revCounter += 1;
    return REV_BASE + this.generation * REV_SPAN + this.revCounter;
  }

  async init(): Promise<{ recovered: string[]; unreadable: string[] }> {
    mkdirSync(this.sessionsDir, { recursive: true });
    // a new start: its generation is one above the last one that ran here
    this.generation = (
      await this.update<{ n?: number }>('generation.json', {}, (current) => ({
        n: Math.max(0, Math.floor(Number(current.n) || 0)) + 1,
      }))
    ).n as number;
    const recovered: string[] = [];
    const unreadable: string[] = [];
    for (const name of readdirSync(this.sessionsDir)) {
      const file = join(this.sessionsDir, name);
      if (name.endsWith('.tmp')) {
        rmSync(file, { force: true });
        continue;
      }
      if (!name.endsWith('.json')) continue;
      try {
        const session = JSON.parse(readFileSync(file, 'utf8')) as Session;
        if (![1, 2].includes(session.schemaVersion) || !session.nodes || !session.id)
          throw new Error('shape');
        // a session from before nodes had a layout revision: every node starts at 0
        for (const node of Object.values(session.nodes)) node.layoutRev ??= 0;
        this.sessions.set(session.id, session);
        if (interruptRunning(session, () => this.nextRev())) {
          recovered.push(session.id);
          await this.save(session);
        }
      } catch {
        // Keep the unreadable file for a human; never overwrite it.
        renameSync(file, `${file}.corrupt-${Date.now()}`);
        unreadable.push(name);
      }
    }
    return { recovered, unreadable };
  }

  /** How long the latest 10 finished rounds of every session took, in seconds. */
  private recentRoundSeconds(level?: ReasoningLevel): number[] {
    return (
      [...this.sessions.values()]
        // a level asks for the rounds of the sessions that ran at it
        .filter((session) => level === undefined || session.settings.level === level)
        .flatMap((session) => Object.values(session.nodes))
        .flatMap((node) =>
          node.kind === 'chair' && node.status === 'done' && node.endedAt ? [node] : [],
        )
        .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)))
        .slice(0, 10)
        .map(
          (node) =>
            (new Date(node.endedAt as string).getTime() - new Date(node.startedAt).getTime()) /
            1000,
        )
    );
  }

  /** How long a round usually takes: the mean of the latest 10 finished rounds of every session, in seconds. */
  typicalRoundSeconds(): number | null {
    const lengths = this.recentRoundSeconds();
    return lengths.length > 0 ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null;
  }

  /** The shortest and the longest of those rounds: a round with a comment, or deeper in the tree, is not the mean. */
  typicalRoundRange(level?: ReasoningLevel): { min: number; max: number; count: number } | null {
    const lengths = this.recentRoundSeconds(level);
    return lengths.length > 0
      ? { min: Math.min(...lengths), max: Math.max(...lengths), count: lengths.length }
      : null;
  }

  /** The same range for each level (null where no round of a session at that level has finished). */
  typicalRoundRangeByLevel(): Record<
    ReasoningLevel,
    { min: number; max: number; count: number } | null
  > {
    return Object.fromEntries(
      REASONING_LEVELS.map((level) => [level, this.typicalRoundRange(level)]),
    ) as Record<ReasoningLevel, { min: number; max: number; count: number } | null>;
  }

  /**
   * Mean seconds a finished seat call took, per assistant and model (`speedKey`), over the last 20 such calls of each (every
   * session). The model is part of the key: a council pinned to a slow model must not make the assistant look slow to the
   * councils that use another one (Quick ranks by it).
   */
  measuredLatency(): Map<string, number> {
    const calls = [...this.sessions.values()]
      .flatMap((session) => Object.values(session.nodes))
      .flatMap((node) => (node.kind === 'chair' ? (node.attempts ?? []) : []))
      .filter((a) => a.kind === 'seat' && a.state === 'done' && a.startedAt && a.endedAt)
      .sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt)));
    const seconds = new Map<string, number[]>();
    for (const call of calls) {
      const key = speedKey(call.harness, call.model);
      const list = seconds.get(key) ?? [];
      if (list.length >= 20) continue;
      list.push(
        (new Date(call.endedAt as string).getTime() -
          new Date(call.startedAt as string).getTime()) /
          1000,
      );
      seconds.set(key, list);
    }
    return new Map(
      [...seconds].map(([harness, list]) => [
        harness,
        list.reduce((a, b) => a + b, 0) / list.length,
      ]),
    );
  }

  /**
   * Mean seconds a finished chairman call took, per harness, model and reasoning level (`chairmanKey`), over the latest 10
   * such calls of each (every session). The quick profile chooses its chairman by it.
   */
  measuredChairmanLatency(): Map<string, number> {
    const calls = [...this.sessions.values()]
      .flatMap((session) => Object.values(session.nodes))
      .flatMap((node) =>
        node.kind === 'chair'
          ? (node.attempts ?? []).map((attempt) => ({ attempt, effort: chairmanOf(node).effort }))
          : [],
      )
      .filter(
        ({ attempt }) =>
          attempt.kind === 'chairman' &&
          attempt.state === 'done' &&
          attempt.startedAt &&
          attempt.endedAt,
      )
      .sort((a, b) => String(b.attempt.endedAt).localeCompare(String(a.attempt.endedAt)));
    const seconds = new Map<string, number[]>();
    for (const { attempt, effort } of calls) {
      const key = chairmanKey(attempt.harness, attempt.model, effort);
      const list = seconds.get(key) ?? [];
      if (list.length >= 10) continue;
      list.push(
        (new Date(attempt.endedAt as string).getTime() -
          new Date(attempt.startedAt as string).getTime()) /
          1000,
      );
      seconds.set(key, list);
    }
    return new Map(
      [...seconds].map(([key, list]) => [key, list.reduce((a, b) => a + b, 0) / list.length]),
    );
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()]
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  private fileOf(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/u.test(id)) throw new Error('bad session id');
    return join(this.sessionsDir, `${id}.json`);
  }

  /**
   * Saves the session; writes for one session run in order. The overlay replaces parts of the live session in the written
   * text only. Memory follows the disk: a session is registered, and its `updatedAt` raised, only once the write has
   * succeeded, so a failed write leaves both as they were. A session that was deleted is never written again.
   */
  save(session: Session, over: Overlay = {}): Promise<void> {
    const file = this.fileOf(session.id);
    if (this.deleted.has(session.id)) return Promise.reject(new Error('the session was deleted'));
    const stamp = NOW();
    const text = serializeSession(session, { ...over, updatedAt: stamp });
    const previous = this.queues.get(session.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        // a write that was queued before the delete must not bring the file back
        if (this.deleted.has(session.id)) throw new Error('the session was deleted');
        await this.write(file, text);
        session.updatedAt = stamp;
        this.sessions.set(session.id, session);
      });
    this.queues.set(session.id, next);
    return next;
  }

  /** The one place a session's text reaches the disk (tests make it slow to reproduce write races). */
  protected write(file: string, text: string): Promise<void> {
    return writeFileAtomic(file, text);
  }

  /**
   * Removes the session. It is marked deleted FIRST (a tombstone: no save of it is accepted from then on, so nothing queued
   * behind the delete can bring it back), then its file goes and it leaves memory. If the file cannot be removed the mark is
   * taken back and the session stays, intact.
   */
  async delete(id: string): Promise<void> {
    const file = this.fileOf(id);
    this.deleted.add(id);
    try {
      const previous = this.queues.get(id) ?? Promise.resolve();
      await previous.catch(() => undefined);
      await rm(file, { force: true });
    } catch (error) {
      this.deleted.delete(id);
      throw error;
    }
    this.sessions.delete(id);
    this.queues.delete(id);
  }

  /** Whether the session was deleted (its id is never used again). */
  isDeleted(id: string): boolean {
    return this.deleted.has(id);
  }

  /** Resolves when every queued write has reached the disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.catch(() => undefined)));
  }

  // ---------- small JSON files in the home folder ----------

  private readJson<T>(name: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.home, name), 'utf8')) as T;
    } catch (error) {
      if (name === 'settings.json' && error instanceof SyntaxError) {
        const file = join(this.home, name);
        ownerOnly(file, false);
        const stem = `settings.corrupt-${Date.now()}`;
        let backup = `${stem}.json`;
        for (let suffix = 1; ; suffix++) {
          const target = join(this.home, backup);
          try {
            // An exclusive copy never replaces an older backup, and works where hard links do not (FAT, some shares).
            copyFileSync(file, target, constants.COPYFILE_EXCL);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
              backup = `${stem}-${suffix}.json`;
              continue;
            }
            throw new Error(
              `Could not preserve damaged settings as ${backup}; settings.json was kept.`,
              { cause: error },
            );
          }
          try {
            ownerOnly(target, false);
          } catch (error) {
            rmSync(target, { force: true });
            throw new Error(
              `Could not make the backup ${backup} private; settings.json was kept.`,
              { cause: error },
            );
          }
          break;
        }
        unlinkSync(file);
        this.settingsBackup = backup;
      } else if (name === 'settings.json' && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      return fallback;
    }
  }

  /**
   * Read, change, write one file of the home folder. Updates to a file run one after the other, each reading what the
   * one before wrote, so two writers at once never lose an entry.
   */
  private update<T>(name: string, fallback: T, edit: (current: T) => T): Promise<T> {
    const file = join(this.home, name);
    const previous = this.queues.get(file) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        const next = edit(this.readJson(name, fallback));
        mkdirSync(this.home, { recursive: true });
        await writeFileAtomic(file, JSON.stringify(next, null, 2));
        return next;
      });
    this.queues.set(file, run);
    return run;
  }

  // ---------- settings: profiles and the port ----------

  readSettings(): SettingsFile {
    return migrate(this.readJson<unknown>('settings.json', {}));
  }

  /** The working folders sessions were started with, newest first: those that still exist, at most `RECENT_FOLDERS`. */
  readRecentFolders(): string[] {
    const list = this.readSettings().recentFolders;
    return (Array.isArray(list) ? list : [])
      .filter((folder): folder is string => typeof folder === 'string' && existsSync(folder))
      .slice(0, RECENT_FOLDERS);
  }

  /** Puts a folder first in the list of recent ones (once). A failure to write it never fails what asked. */
  async rememberFolder(folder: string): Promise<void> {
    try {
      await this.updateSettings((file) => {
        const same = (other: string) =>
          process.platform === 'win32'
            ? other.toLowerCase() === folder.toLowerCase()
            : other === folder;
        const others = (file.recentFolders ?? []).filter((other) => !same(other));
        return { ...file, recentFolders: [folder, ...others].slice(0, RECENT_FOLDERS * 2) };
      });
    } catch {
      // the list is a convenience
    }
  }

  updateSettings(edit: (file: SettingsFile) => SettingsFile): Promise<SettingsFile> {
    return this.update<unknown>('settings.json', {}, (current) =>
      edit(migrate(current)),
    ) as Promise<SettingsFile>;
  }

  // ---------- models that ran out of credit or are rate limited ----------

  /** Entries that have not expired yet. */
  readUnavailable(): UnavailableEntry[] {
    const data = this.readJson<{ items?: UnavailableEntry[] }>('unavailable.json', {});
    const nowMs = Date.now();
    return (Array.isArray(data.items) ? data.items : []).filter(
      (item) => typeof item.model === 'string' && new Date(item.until).getTime() > nowMs,
    );
  }

  /** Remembers a model (or, with `prefix`, a whole provider); writes queue, so concurrent ones lose nothing. */
  async addUnavailable(entry: UnavailableEntry): Promise<void> {
    await this.update<{ items?: UnavailableEntry[] }>('unavailable.json', {}, (current) => {
      const nowMs = Date.now();
      const items = (Array.isArray(current.items) ? current.items : []).filter(
        (item) =>
          new Date(item.until).getTime() > nowMs &&
          !(item.harness === entry.harness && item.model === entry.model),
      );
      items.push(entry);
      return { items };
    });
  }

  // ---------- the endpoint: conversation index ----------

  readApiIndex(): ApiIndex {
    const data = this.readJson<{ exact?: ApiIndex['exact']; prefixes?: Record<string, unknown> }>(
      'api-index.json',
      {},
    );
    // An older index held one round per text; now a text may name several (and then it names none of them).
    const prefixes = Object.fromEntries(
      Object.entries(data.prefixes ?? {}).map(([key, value]) => [
        key,
        (Array.isArray(value) ? value : [value]) as ApiRef[],
      ]),
    );
    return { exact: data.exact ?? {}, prefixes };
  }

  updateApiIndex(edit: (index: ApiIndex) => ApiIndex): Promise<ApiIndex> {
    return this.update<unknown>('api-index.json', {}, () =>
      edit(this.readApiIndex()),
    ) as Promise<ApiIndex>;
  }

  // ---------- the endpoint: conversations of a client that keeps its own thread (T3 Code) ----------

  /** The threads file as it is; a record that is not one is dropped. */
  readThreads(): ThreadIndex {
    const data = this.readJson<{ threads?: unknown } | null>('threads.json', {});
    const threads: Record<string, ThreadRecord> = {};
    if (data?.threads && typeof data.threads === 'object') {
      for (const [id, value] of Object.entries(data.threads)) {
        const record = threadRecord(value);
        if (record) threads[id] = record;
      }
    }
    return { threads };
  }

  updateThreads(edit: (index: ThreadIndex) => ThreadIndex): Promise<ThreadIndex> {
    return this.update<unknown>('threads.json', {}, () =>
      edit(this.readThreads()),
    ) as Promise<ThreadIndex>;
  }
}

function threadRecord(value: unknown): ThreadRecord | null {
  const item = value as Record<string, unknown> | null;
  if (!item || typeof item !== 'object') return null;
  const ref = (pair: unknown): ApiRef | null => {
    const found = pair as { sessionId?: unknown; chairId?: unknown } | null;
    return found && typeof found.sessionId === 'string' && typeof found.chairId === 'string'
      ? { sessionId: found.sessionId, chairId: found.chairId }
      : null;
  };
  const level = REASONING_LEVELS.find((candidate) => candidate === item.level);
  if (
    typeof item.sessionId !== 'string' ||
    typeof item.profileId !== 'string' ||
    !level ||
    typeof item.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    sessionId: item.sessionId,
    chairId: typeof item.chairId === 'string' ? item.chairId : null,
    last: ref(item.last),
    profileId: item.profileId,
    level,
    cwd: typeof item.cwd === 'string' ? item.cwd : null,
    client: typeof item.client === 'string' ? item.client : null,
    updatedAt: item.updatedAt,
  };
}

/**
 * A conversation of a client that keeps its own thread: which session holds it and where it stands. `sessionId` is the session of
 * the tip (the last round whose answer was delivered), or, while there is no tip, of the last round started.
 */
export interface ThreadRecord {
  sessionId: string;
  /** The tip: the last round whose answer reached the client; null before the first one does. */
  chairId: string | null;
  /** The last round started for the thread, whatever became of it (a cancelled or failed one can be run again). */
  last: ApiRef | null;
  profileId: string;
  level: ReasoningLevel;
  cwd: string | null;
  client: string | null;
  updatedAt: string;
}

/** The thread records by the client's own thread id. */
export interface ThreadIndex {
  threads: Record<string, ThreadRecord>;
}

/** A conversation the endpoint has answered: the round that holds the answer. */
export interface ApiRef {
  sessionId: string;
  chairId: string;
}

/** Hashes of conversations to rounds, so the same request is answered from the cache and a continued one branches. */
export interface ApiIndex {
  /** profile, folder and the whole conversation up to the last user message. */
  exact: Record<string, ApiRef>;
  /** the conversation as a client sends it back after an answer (it ends with that answer): every round that text may mean. */
  prefixes: Record<string, ApiRef[]>;
}

export interface UnavailableEntry {
  harness: SeatRun['harness'];
  model: string;
  /** The account behind a provider is out: models starting with this are unavailable too ('' is every model of the harness). */
  prefix?: string;
  until: string;
  reason: string;
}

/** A settings file of an older shape (one set of overrides) becomes the current one, with a `default` profile. */
/** How many recent working folders the list shows. */
const RECENT_FOLDERS = 8;

function migrate(current: unknown): SettingsFile {
  const data = (current ?? {}) as Record<string, unknown>;
  if (data.version === 2 && data.profiles && typeof data.profiles === 'object') {
    return data as unknown as SettingsFile;
  }
  const file: SettingsFile = { version: 2, profiles: {} };
  // the port is the endpoint's address that clients have: a valid one is kept whatever shape the rest of the file has
  const port = data.port;
  if (typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535) {
    file.port = port;
  }
  if (data.overrides && typeof data.overrides === 'object') {
    file.profiles.default = {
      base: 'default',
      revision: 1,
      overrides: data.overrides as SettingsFile['profiles'][string]['overrides'],
    };
  }
  return file;
}
