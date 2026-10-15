// The endpoint's brain, with no HTTP in it: a client's conversation goes in, a round of the council (or a cached answer)
// comes out. It maps the conversation onto Divan's tree (conversation.ts), starts rounds through the engine, lets
// identical concurrent requests share one run, and cancels a round when the last client waiting for it goes away.

import { createHash } from 'node:crypto';
import { canonicalFlow } from '../shared/flow.ts';
import { levelOfEffort } from '../shared/levels.ts';
import { answerWithRecommendation, textDirection } from '../shared/text.ts';
import type {
  ChairNode,
  HarnessStatus,
  ProfileView,
  ReasoningLevel,
  SeatConfig,
  Session,
} from '../shared/types.ts';
import { backgroundOf, canonicalize, exactKey, plan, remember, type Turn } from './conversation.ts';
import { folderFor } from './cwd.ts';
import { detect } from './detection.ts';
import { eligibleFlow } from './eligibility.ts';
import { type Engine, EngineError, type RoundEvent, type RoundHandle } from './engine.ts';
import { executableFlow, frozenFlow } from './flow-templates.ts';
import type { SettingsService } from './settings.ts';
import type { ApiRef, Store, UnavailableEntry } from './store.ts';

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface GatewayRequest {
  /** `divan/<profile id>` or just the id. */
  model: string;
  messages: unknown;
  /** The `x-divan-cwd` header, URI-encoded. */
  cwdHeader?: string | undefined;
  /** Who is asking, when it says so. */
  client?: string | null | undefined;
  /** The reasoning effort the client asked for (`reasoning_effort`, as the endpoint received it): it picks the level. */
  effort?: unknown;
  /** Fires when the client has gone (its connection closed): also while the round is still being admitted. */
  signal?: AbortSignal | undefined;
}

export interface Answer {
  cached: boolean;
  sessionId: string;
  chairId: string;
  /** The chairman's answer, then its questions for the user; the closing link is added by the caller. */
  content: string;
  /** What the harnesses reported for the round (all zero for a cached answer: it cost nothing now). */
  usage: { prompt: number; completion: number; total: number; cached: number };
  /** What the round originally cost, also for a cached answer. */
  roundTotal: number;
}

export interface Pending {
  profileId: string;
  language: 'fa' | 'en';
  /** Things the client may want to know before the answer (a working folder that was refused). */
  notes: string[];
  /** The round's progress, replayed from its start; nothing for a cached answer. */
  subscribe(listener: (event: RoundEvent) => void): () => void;
  done: Promise<Answer>;
  /** This client is gone: the round is cancelled when nobody else waits for it. */
  release(): void;
}

interface Started {
  handle: RoundHandle;
  done: Promise<Answer>;
}
interface InFlight {
  clients: number;
  ready: Promise<Started>;
  /** Aborted when the last client leaves before the round was launched: nothing is admitted or asked after that. */
  admission: AbortController;
  /** The round, once it was launched (a round whose clients all left meanwhile is cancelled at once). */
  started: Started | null;
}

/**
 * What a cached answer is an answer of: the profile (its id, its generation, which is never reused even when a profile is
 * deleted and made again), the level, and what the profile resolves to at that level right now (the seats
 * that would run, the chairman, the budgets). A change in availability, detection or measured speed changes the seats, so it
 * misses the cache; so does asking at another level.
 */
export function identityOf(
  profile: ProfileView,
  out: UnavailableEntry[],
  level: ReasoningLevel = profile.defaultLevel,
  session?: Session,
  background = false,
  status?: HarnessStatus[],
): string {
  const settings = session?.settings ?? profile.levels[level].effective;
  const flow = session ? frozenFlow(session.settings) : executableFlow(settings, background);
  const plan = eligibleFlow(
    flow,
    out,
    Date.now(),
    session?.settings.separateChairman ?? profile.base === 'quick',
    status,
  );
  // The seats that would actually run now, not those the settings name: a model that went out of credit changes the
  // council even when a seat was chosen explicitly and the settings did not change.
  const resolved = JSON.stringify({
    flow: canonicalFlow(flow),
    run: plan.run.map((agent) => agent.id).sort(),
    skipped: plan.skipped.map(({ seat }) => seat.id).sort(),
    family: plan.sameFamily.map((agent) => agent.id).sort(),
    budgets: settings.budgets,
    ...(session ? { sessionId: session.id } : {}),
  });
  const hash = createHash('sha256').update(resolved).digest('hex').slice(0, 16);
  // Custom-flow edits are fully covered by the execution hash; canvas saves only raise the stale-save revision.
  const revision =
    flow.kind === 'custom' ? 'flow' : (session?.origin?.profileRevision ?? profile.revision);
  return `${profile.id}.${session?.origin?.profileGeneration ?? profile.generation}.${revision}.${level}.${hash}`;
}

/** `divan/default` and `default` both name the profile `default`. */
export const profileOf = (model: unknown): string =>
  String(model ?? '')
    .trim()
    .replace(/^divan\//u, '');

/** What the round cost, as an OpenAI usage block: the harnesses' own numbers, retries and failed calls included. */
function usageOf(chair: ChairNode): Answer['usage'] {
  const calls = chair.attempts ?? [];
  const sum = (pick: (u: NonNullable<ChairNode['attempts'][number]['usage']>) => number) =>
    calls.reduce((all, call) => all + (call.usage ? pick(call.usage) : 0), 0);
  return {
    prompt: sum((u) => u.input + u.cached),
    completion: sum((u) => u.output),
    total: chair.usage.total,
    cached: sum((u) => u.cached),
  };
}

const ARABIC = /\p{Script=Arabic}/u;

/**
 * The chairman's answer and then its questions for the user, as one text. The web app shows the recommendation in a box above
 * the answer, so the answer itself does not say it; a client of the endpoint has no such box, so the text starts with it
 * (unless the answer already does, as the answer of an older round does).
 */
export function answerText(chair: ChairNode): string {
  const parts = [answerWithRecommendation(chair.answer, chair.recommendation)];
  if (chair.questionsForUser.length > 0) {
    const title = ARABIC.test(chair.answer) ? 'پرسش‌هایی از شما' : 'Questions for you';
    parts.push(`${title}:\n${chair.questionsForUser.map((q) => `- ${q}`).join('\n')}`);
  }
  return parts.join('\n\n');
}

/** The words of the closing link that opens a round in the web app, in the language of the answer. */
export const linkLabel = (text: string): string =>
  ARABIC.test(text) ? 'باز کردن در دیوان' : 'Open in Divan';

export class Gateway {
  private engine: Engine;
  private store: Store;
  private settings: SettingsService;
  private inflight = new Map<string, InFlight>();

  constructor(engine: Engine, store: Store, settings: SettingsService) {
    this.engine = engine;
    this.store = store;
    this.settings = settings;
  }

  private alive = (ref: ApiRef): boolean => {
    const node = this.store.get(ref.sessionId)?.nodes[ref.chairId];
    return node?.kind === 'chair' && node.status === 'done';
  };

  async submit(request: GatewayRequest): Promise<Pending> {
    const profile = await this.settings.profile(profileOf(request.model));
    if (!profile) {
      throw new GatewayError(404, 'model_not_found', `no model named "${request.model}"`);
    }
    // the level the client asked for (its reasoning effort), else the profile's own
    const level = levelOfEffort(request.effort) ?? profile.defaultLevel;
    const { turns, system } = canonicalize(request.messages);
    const folder = folderFor(request.cwdHeader, system);
    const language =
      textDirection(turns.map((turn) => turn.text).join(' ')) === 'rtl' ? 'fa' : 'en';
    const notes = folder.note ? [folder.note] : [];
    const index = this.store.readApiIndex();
    const planned = plan(
      turns,
      { exact: {}, prefixes: index.prefixes },
      this.alive,
      '',
      folder.path,
    );
    const previous = planned.kind === 'branch' ? this.store.get(planned.ref.sessionId) : undefined;
    const frozen =
      previous &&
      previous.settings.level === level &&
      previous.origin?.profileId === profile.id &&
      (previous.origin.profileGeneration ?? 0) === profile.generation
        ? previous
        : undefined;
    const decision =
      planned.kind === 'cached' || (planned.kind === 'branch' && !frozen)
        ? ({
            kind: 'new',
            question: turns.at(-1)?.text ?? '',
            background: backgroundOf(turns.slice(0, -1)),
          } as const)
        : planned;
    const identity = identityOf(
      profile,
      this.store.readUnavailable(),
      level,
      frozen,
      decision.kind === 'new' && !!decision.background,
      (await detect(false)).status,
    );
    if (decision.kind === 'new' && profile.levels[level].blocked)
      throw new GatewayError(409, 'profile_blocked', profile.levels[level].blocked.message);
    const key = exactKey(turns, identity, folder.path);

    // Everything from here to the registration is synchronous, so two identical requests can never both start a run.
    const running = this.inflight.get(key);
    if (running) {
      running.clients += 1;
      const leave = this.joined(running, key, request.signal);
      return this.pending(profile.id, language, notes, leave, await running.ready);
    }
    const cached = index.exact[key];
    if (cached && this.alive(cached)) {
      const answer = this.cachedAnswer(cached);
      return {
        profileId: profile.id,
        language,
        notes,
        subscribe: () => () => undefined,
        done: Promise.resolve(answer),
        release: () => undefined,
      };
    }
    const admission = new AbortController();
    const entry: InFlight = {
      clients: 1,
      admission,
      started: null,
      ready: this.start(
        decision,
        turns,
        profile,
        identity,
        folder.path,
        request.client ?? null,
        admission.signal,
        level,
      ),
    };
    this.inflight.set(key, entry);
    // Only this entry is ever removed by its own end: a newer request may have taken the key since (after a release).
    const forget = () => {
      if (this.inflight.get(key) === entry) this.inflight.delete(key);
    };
    entry.ready.then((started) => {
      entry.started = started;
      // every client left while the round was being admitted: it is stopped before it can ask a member anything
      if (entry.clients <= 0) started.handle.cancel();
      void started.done.finally(forget).catch(() => undefined);
    }, forget);
    // the client is counted from now, and leaves when it says so or when its connection closes, whichever comes first
    const leave = this.joined(entry, key, request.signal);
    return this.pending(profile.id, language, notes, leave, await entry.ready);
  }

  /**
   * One client of a run: it leaves once (when it releases, or when its signal fires), and the last one to leave stops the
   * admission of the round, or the round itself if it has been launched.
   */
  private joined(entry: InFlight, key: string, signal: AbortSignal | undefined): () => void {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      entry.clients -= 1;
      if (entry.clients <= 0) {
        entry.admission.abort();
        entry.started?.handle.cancel();
        if (this.inflight.get(key) === entry) this.inflight.delete(key);
      }
    };
    if (signal?.aborted) leave();
    else signal?.addEventListener('abort', leave, { once: true });
    return leave;
  }

  private pending(
    profileId: string,
    language: 'fa' | 'en',
    notes: string[],
    leave: () => void,
    started: Started,
  ): Pending {
    return {
      profileId,
      language,
      notes,
      subscribe: (listener) => started.handle.subscribe(listener),
      done: started.done,
      release: leave,
    };
  }

  private cachedAnswer(ref: ApiRef): Answer {
    const chair = this.store.get(ref.sessionId)?.nodes[ref.chairId] as ChairNode;
    return {
      cached: true,
      sessionId: ref.sessionId,
      chairId: ref.chairId,
      content: answerText(chair),
      usage: { prompt: 0, completion: 0, total: 0, cached: 0 },
      roundTotal: chair.usage.total,
    };
  }

  /** Starts the round the plan calls for and returns its handle and the promise of its answer. */
  private async start(
    decision: Exclude<ReturnType<typeof plan>, { kind: 'cached' }>,
    turns: Turn[],
    profile: ProfileView,
    identity: string,
    cwd: string | null,
    client: string | null,
    signal: AbortSignal,
    level: ReasoningLevel,
  ): Promise<Started> {
    let handle: RoundHandle;
    try {
      if (decision.kind === 'branch') {
        handle = await this.engine.startRound(
          decision.ref.sessionId,
          decision.ref.chairId,
          decision.text,
          { cwd, signal },
        );
      } else {
        if (!decision.question) {
          throw new GatewayError(400, 'empty_message', 'the last user message is empty');
        }
        const council = profile.levels[level].effective;
        const seats: SeatConfig[] = council.seats;
        handle = (
          await this.engine.createSessionWithRound({
            question: decision.question,
            seats,
            chairman: council.chairman,
            budgets: council.budgets,
            ...(council.flow ? { flow: council.flow } : {}),
            level,
            separateChairman: profile.base === 'quick',
            origin: {
              kind: 'api',
              ...(client ? { client } : {}),
              profileId: profile.id,
              profileRevision: profile.revision,
              profileGeneration: profile.generation,
              profileLevel: level,
            },
            ...(decision.background ? { background: decision.background } : {}),
            cwd,
            // the session keeps the folder in its settings, as a session started on the web does (the chip, the settings
            // and "what the members saw" show it from there)
            ...(cwd ? { folder: cwd } : {}),
            signal,
          })
        ).round;
      }
    } catch (error) {
      if (error instanceof EngineError) {
        throw new GatewayError(error.status, error.code, error.message);
      }
      throw error;
    }
    const done = handle.done.then(async (status) => {
      const chair = this.store.get(handle.sessionId)?.nodes[handle.chairId] as
        | ChairNode
        | undefined;
      if (!chair || status !== 'done') {
        const why = status === 'cancelled' ? 'the round was cancelled' : (chair?.error ?? status);
        throw new GatewayError(502, 'round_failed', `the council could not answer: ${why}`);
      }
      const content = answerText(chair);
      const ref = { sessionId: handle.sessionId, chairId: handle.chairId };
      await this.store
        .updateApiIndex((index) => remember(index, turns, content, identity, cwd, ref))
        .catch((error) => console.error('[divan] could not index the answer:', error));
      return {
        cached: false,
        ...ref,
        content,
        usage: usageOf(chair),
        roundTotal: chair.usage.total,
      };
    });
    // A failed round is reported to whoever waits for it; nobody waiting must not become an unhandled rejection.
    done.catch(() => undefined);
    return { handle, done };
  }
}
