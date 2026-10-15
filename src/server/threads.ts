// The mapping of a client's own threads onto Divan's tree, with no HTTP in it. T3 Code keeps a thread of its own and says which
// one each turn belongs to; the record behind that id (store.ts `ThreadRecord`) tells which session holds the conversation, where
// its tip is (the last round whose answer reached the client) and which round was started last. So a turn goes on from the tip, a
// cancelled one can be run again, and a fork (a new thread that names the round it continues) becomes a branch of that round.
// Unlike the stateless chat endpoint (gateway.ts) there is no cache, no sharing of identical requests and no hashing of messages:
// the client names the thread, and the thread names the round.

import { CONTINUE_TEXT } from '../shared/acp-text.ts';
import { inputOfNode, pathTo, renderInput } from '../shared/context.ts';
import { estimateTokens } from '../shared/text.ts';
import type { ChairNode, ProfileView, ReasoningLevel, Session } from '../shared/types.ts';
import { BACKGROUND_TOKENS, backgroundOf, type Turn } from './conversation.ts';
import { type Engine, EngineError, type RoundHandle } from './engine.ts';
import { answerText } from './gateway.ts';
import type { ApiRef, Store, ThreadIndex, ThreadRecord } from './store.ts';

/** The most threads the index keeps; the least recently updated are dropped first. */
export const KEEP_THREADS = 2000;

/**
 * How long a turn waits for the round its thread started last to let go. A client that cancels and sends its next message at once
 * (T3 Code's "steer") reaches us while the cancelled round is still stopping its members and saving; the wait is only a net, so a
 * round that never ends cannot hold the thread for ever.
 */
export const SETTLE_MS = 15_000;

const RERUNNABLE: ReadonlySet<ChairNode['status']> = new Set<ChairNode['status']>([
  'failed',
  'cancelled',
  'interrupted',
]);

type SessionOf = (sessionId: string) => Session | undefined;

const now = () => new Date().toISOString();

function chairOf(sessionOf: SessionOf, ref: ApiRef): ChairNode | undefined {
  const node = sessionOf(ref.sessionId)?.nodes[ref.chairId];
  return node?.kind === 'chair' ? node : undefined;
}

/**
 * What a record still stands for. Its tip counts while that round exists and is finished, its last round while that exists; a
 * record with neither (the session was deleted) is no record at all.
 */
export function standing(
  record: ThreadRecord,
  sessionOf: SessionOf,
): { tip: ApiRef | null; last: ApiRef | null } | null {
  const tip = record.chairId ? { sessionId: record.sessionId, chairId: record.chairId } : null;
  const liveTip = tip && chairOf(sessionOf, tip)?.status === 'done' ? tip : null;
  const liveLast = record.last && chairOf(sessionOf, record.last) ? record.last : null;
  return liveTip || liveLast ? { tip: liveTip, last: liveLast } : null;
}

/** The end of a text, cut to about `maxTokens` (the part nearest the question is the part kept); null when it is empty. */
export function keepEnd(
  text: string | null | undefined,
  maxTokens = BACKGROUND_TOKENS,
): string | null {
  const whole = text?.trim() ?? '';
  if (!whole) return null;
  if (estimateTokens(whole) <= maxTokens) return whole;
  let tail = whole.slice(-maxTokens * 8);
  while (tail.length > 0 && estimateTokens(`…${tail}`) > maxTokens) {
    tail = tail.slice(Math.ceil(tail.length * 0.1));
  }
  return tail ? `…${tail}` : null;
}

/**
 * The conversation of a session up to a finished round, as the background of a session that goes on from it: the root question,
 * each input the asker wrote and each answer the council gave (as the client received it), cut like any background.
 */
export function conversationUpTo(session: Session, chairId: string): string | null {
  const turns: Turn[] = [];
  for (const node of pathTo(session.nodes, chairId)) {
    if (node.kind === 'chair') {
      turns.push({ role: 'assistant', text: answerText(node) });
      continue;
    }
    const parts = inputOfNode(node);
    if (parts) turns.push({ role: 'user', text: renderInput(parts) });
  }
  // what the session itself was given before its first question comes first
  return keepEnd([session.background, backgroundOf(turns)].filter(Boolean).join('\n\n'));
}

export type TurnAction =
  /** A failed, cancelled or interrupted round, run again. */
  | { kind: 'rerun'; ref: ApiRef }
  /** A round that finished although its client had left: its answer, not yet delivered, is what "continue" asks for. */
  | { kind: 'deliver'; ref: ApiRef }
  /** The thread's last round is running again (run again on the web): "continue" shows that round, it asks nothing. */
  | { kind: 'follow'; ref: ApiRef }
  /** A new round from a finished one, in its own session (a branch when it already has children). */
  | { kind: 'branch'; ref: ApiRef }
  /** A new session, the earlier conversation as its background. */
  | { kind: 'new'; background: string | null };

/** What a turn does, and the thread's tip once it is admitted (the old one, or the round a fork names). */
export interface TurnPlan {
  action: TurnAction;
  tip: ApiRef | null;
}

/**
 * What a turn of a thread does. The record is the thread's own history; without a usable one the client's `from` (the round a fork
 * continues) stands in for its tip, and without that the turn starts a new session. A tip is continued in its own session only when
 * that session has the profile and level asked for now (a session's council is locked at its level); otherwise the conversation up
 * to the tip becomes the background of a new session.
 */
export function planTurn(input: {
  record: ThreadRecord | undefined;
  text: string;
  from: ApiRef | null;
  profileId: string;
  level: ReasoningLevel;
  profileGeneration?: number;
  /** What the client sent as the earlier conversation of a thread this server has not seen. */
  background: string | null;
  sessionOf: SessionOf;
}): TurnPlan {
  const { sessionOf } = input;
  const matches = (session: Session | undefined) =>
    session?.origin?.profileId === input.profileId &&
    session.settings.level === input.level &&
    (input.profileGeneration === undefined ||
      (session.origin.profileGeneration ?? 0) === input.profileGeneration);
  const known = input.record ? standing(input.record, sessionOf) : null;
  const lastSession = known?.last ? sessionOf(known.last.sessionId) : undefined;
  if (known?.last && matches(lastSession) && input.text.trim() === CONTINUE_TEXT) {
    const status = chairOf(sessionOf, known.last)?.status;
    if (status && RERUNNABLE.has(status)) {
      return { action: { kind: 'rerun', ref: known.last }, tip: known.tip };
    }
    // a round that ended `done` after the client had gone (or that was run again on the web) was never delivered
    const isTip =
      known.tip?.sessionId === known.last.sessionId && known.tip.chairId === known.last.chairId;
    if (status === 'done' && !isTip) {
      return { action: { kind: 'deliver', ref: known.last }, tip: known.tip };
    }
    // still running after the wait (a round run again on the web takes longer than SETTLE_MS): the button's words are not a question
    if (status === 'running')
      return { action: { kind: 'follow', ref: known.last }, tip: known.tip };
  }
  let tip = known?.tip ?? null;
  if (!tip && input.from && chairOf(sessionOf, input.from)?.status === 'done') tip = input.from;
  if (!tip) return { action: { kind: 'new', background: keepEnd(input.background) }, tip: null };
  const session = sessionOf(tip.sessionId) as Session;
  if (matches(session)) {
    return { action: { kind: 'branch', ref: tip }, tip };
  }
  return { action: { kind: 'new', background: conversationUpTo(session, tip.chairId) }, tip };
}

/** The index with this thread's record written, newest last, and no more than `keep` threads (the least recently updated go). */
export function withThread(
  index: ThreadIndex,
  threadId: string,
  record: ThreadRecord,
  keep = KEEP_THREADS,
): ThreadIndex {
  const threads = { ...index.threads, [threadId]: record };
  const ids = Object.keys(threads);
  if (ids.length > keep) {
    const oldest = ids
      .sort((a, b) =>
        (threads[a] as ThreadRecord).updatedAt.localeCompare(
          (threads[b] as ThreadRecord).updatedAt,
        ),
      )
      .slice(0, ids.length - keep);
    for (const id of oldest) delete threads[id];
  }
  return { threads };
}

/** The index with the thread's tip moved to `ref`, only while `ref` is still the last round started for it. */
export function withTip(
  index: ThreadIndex,
  threadId: string,
  ref: ApiRef,
  updatedAt = now(),
): ThreadIndex {
  const record = index.threads[threadId];
  if (
    !record?.last ||
    record.last.sessionId !== ref.sessionId ||
    record.last.chairId !== ref.chairId
  ) {
    return index;
  }
  return {
    threads: {
      ...index.threads,
      [threadId]: { ...record, sessionId: ref.sessionId, chairId: ref.chairId, updatedAt },
    },
  };
}

/** Resolves when `done` has settled, when `signal` fires, or after `ms`, whichever comes first (never rejects). */
function waitFor(done: Promise<unknown>, signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    done.then(finish, finish);
  });
}

export interface TurnRequest {
  /** The client's own id of its thread. */
  threadId: string;
  profile: ProfileView;
  level: ReasoningLevel;
  text: string;
  /** The working folder, already checked (null: none). */
  cwd: string | null;
  /** The round a fork of another thread continues. */
  from: ApiRef | null;
  background: string | null;
  client: string | null;
  /** Fires when the client has gone: nothing is admitted after it, and the round it started is stopped. */
  signal: AbortSignal;
  /**
   * Called, before the new session is made, when the turn would have gone on in the session of the thread's tip but another round
   * of that session is running (one session runs one round at a time): it starts a session of its own instead, and the client
   * may want to be told.
   */
  onBusySession?: () => void;
}

/** What a client may ask about a thread. */
export interface ThreadView {
  id: string;
  sessionId: string;
  /** The tip: the last round whose answer reached the client. */
  chairId: string | null;
  profileId: string;
  level: ReasoningLevel;
  cwd: string | null;
}

export class Threads {
  private engine: Engine;
  private store: Store;
  /** The newest start of each thread that has not finished (see `start`); in memory only, it orders the requests of this process. */
  private starting = new Map<string, Promise<void>>();

  constructor(engine: Engine, store: Store) {
    this.engine = engine;
    this.store = store;
  }

  private sessionOf: SessionOf = (sessionId) => this.store.get(sessionId);

  /** The thread as it stands, or null when it is unknown or its sessions are gone. */
  view(threadId: string): ThreadView | null {
    const record = this.store.readThreads().threads[threadId];
    const known = record ? standing(record, this.sessionOf) : null;
    if (!record || !known) return null;
    return {
      id: threadId,
      sessionId: record.sessionId,
      chairId: known.tip?.chairId ?? null,
      profileId: record.profileId,
      level: record.level,
      cwd: record.cwd,
    };
  }

  /**
   * Admits the round a turn calls for and writes the thread's record with it (its last round is the new one; the tip stays where it
   * was until the answer is delivered). Refusals are the engine's (`EngineError`).
   */
  start(request: TurnRequest): Promise<RoundHandle> {
    // One start of a thread at a time: a steer that arrives while the previous turn is still being admitted would read the record
    // before that turn has written its round into it, and plan from a state that is about to change. A turn is entered into the
    // chain before anything is awaited, so a third one waits for the second, not beside it; its place in the chain lasts until the
    // turn before it has ended too, so a turn that gives up waiting does not let the next one pass the admission in progress.
    const previous = this.starting.get(request.threadId);
    const mine = (async () => {
      if (previous) {
        await waitFor(previous, request.signal, SETTLE_MS);
        if (request.signal.aborted) throw new EngineError('cancelled', 499);
      }
      return this.begin(request);
    })();
    const slot: Promise<void> = Promise.allSettled([previous, mine]).then(() => {
      if (this.starting.get(request.threadId) === slot) this.starting.delete(request.threadId);
    });
    this.starting.set(request.threadId, slot);
    return mine;
  }

  /** Admission and HTTP preflight select the same frozen action, including `last` for continue. */
  plan(
    request: Pick<TurnRequest, 'threadId' | 'profile' | 'level' | 'text' | 'from' | 'background'>,
    record = this.store.readThreads().threads[request.threadId],
  ): TurnPlan {
    return planTurn({
      record,
      text: request.text,
      from: request.from,
      profileId: request.profile.id,
      level: request.level,
      profileGeneration: request.profile.generation,
      background: request.background,
      sessionOf: this.sessionOf,
    });
  }

  private async begin(request: TurnRequest): Promise<RoundHandle> {
    const record = await this.settled(request);
    const { action, tip } = this.plan(request, record);
    let handle: RoundHandle;
    if (action.kind === 'deliver') {
      // nothing to ask: the round is finished and is the thread's last, so delivering its answer moves the tip to it
      return this.finished(action.ref);
    }
    if (action.kind === 'follow') {
      // nothing to ask either: the round is the thread's last and still running, so this turn shows it and delivers it when done
      return (
        this.engine.follow(action.ref.sessionId, action.ref.chairId) ?? this.finished(action.ref)
      );
    }
    if (action.kind === 'rerun') {
      await this.engine.rerun(action.ref.sessionId, action.ref.chairId);
      handle =
        this.engine.follow(action.ref.sessionId, action.ref.chairId) ?? this.finished(action.ref);
      if (request.signal.aborted) handle.cancel();
      await this.remember(request.threadId, { ...(record as ThreadRecord), updatedAt: now() });
      return handle;
    }
    if (action.kind === 'branch') {
      try {
        handle = await this.engine.startRound(
          action.ref.sessionId,
          action.ref.chairId,
          request.text,
          {
            cwd: request.cwd,
            signal: request.signal,
          },
        );
      } catch (error) {
        if (!(error instanceof EngineError) || error.code !== 'busy') throw error;
        // Another round of the tip's session is running (another thread of the client, a fork, the web app). A session runs one
        // round at a time, so this turn does not wait for it: it starts a session of its own with the conversation so far.
        const busy = this.sessionOf(action.ref.sessionId);
        if (!busy) throw error;
        request.onBusySession?.();
        handle = await this.newSession(request, conversationUpTo(busy, action.ref.chairId), busy);
      }
    } else {
      handle = await this.newSession(request, action.background);
    }
    const last = { sessionId: handle.sessionId, chairId: handle.chairId };
    await this.remember(request.threadId, {
      sessionId: tip?.sessionId ?? last.sessionId,
      chairId: tip?.chairId ?? null,
      last,
      profileId: request.profile.id,
      level: request.level,
      cwd: request.cwd,
      client: request.client,
      updatedAt: now(),
    });
    return handle;
  }

  /**
   * The thread's record once the round it started last has let go. A client that cancels and sends its next message at once
   * reaches us while the cancelled round is still being stopped and saved: planning from that moment would find it `running`
   * (so a "continue" would not run it again, and a new message would be refused as busy). The wait ends when the round has ended,
   * when the client has gone (nothing is admitted then) or after `SETTLE_MS`.
   */
  private async settled(request: TurnRequest): Promise<ThreadRecord | undefined> {
    const last = this.store.readThreads().threads[request.threadId]?.last;
    const running = last ? this.engine.follow(last.sessionId, last.chairId) : null;
    if (running) {
      await waitFor(running.done, request.signal, SETTLE_MS);
      if (request.signal.aborted) throw new EngineError('cancelled', 499);
    }
    // read again: what the round did while it was winding down is part of the state to plan from
    return this.store.readThreads().threads[request.threadId];
  }

  /** A new session for the turn, with `background` as the conversation before it, in the council the profile has at this level. */
  private async newSession(
    request: TurnRequest,
    background: string | null,
    frozen?: Session,
  ): Promise<RoundHandle> {
    const problem = !frozen && request.profile.levels[request.level].blocked;
    if (problem) throw EngineError.of(problem, 409);
    const council = frozen?.settings ?? request.profile.levels[request.level].effective;
    const created = await this.engine.createSessionWithRound({
      question: request.text,
      seats: council.seats,
      chairman: council.chairman,
      budgets: council.budgets,
      ...(council.flow?.kind === 'custom' ? { flow: council.flow } : {}),
      ...(frozen ? { frozenSettings: frozen.settings } : {}),
      level: request.level,
      separateChairman: frozen
        ? frozen.settings.separateChairman === true
        : request.profile.base === 'quick',
      origin: {
        kind: 'api',
        ...(request.client ? { client: request.client } : {}),
        profileId: request.profile.id,
        profileRevision: frozen?.origin?.profileRevision ?? request.profile.revision,
        profileGeneration: frozen?.origin?.profileGeneration ?? request.profile.generation,
        profileLevel: request.level,
      },
      ...(background ? { background } : {}),
      cwd: request.cwd ?? frozen?.settings.cwd ?? null,
      // the session keeps the folder in its settings, as a session started on the web does
      ...(request.cwd ? { folder: request.cwd } : {}),
      signal: request.signal,
    });
    return created.round;
  }

  /**
   * The answer is about to reach the client: its round becomes the thread's tip, if `open` still says the client is there. A tip
   * that cannot be written costs the thread its place, not the turn its answer (already paid for): the client gets the answer.
   */
  async deliver(threadId: string, ref: ApiRef, open: () => boolean): Promise<void> {
    try {
      await this.store.updateThreads((index) => (open() ? withTip(index, threadId, ref) : index));
    } catch (error) {
      console.error(
        '[divan] could not move the thread tip:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** A record that cannot be written costs the thread its memory, not the turn its answer. */
  private async remember(threadId: string, record: ThreadRecord): Promise<void> {
    try {
      await this.store.updateThreads((index) => withThread(index, threadId, record));
    } catch (error) {
      console.error(
        '[divan] could not write the thread:',
        error instanceof Error ? error.message : error,
      );
    }
  }

  /** A round that ended before anyone could follow it: nothing to wait for or stop, its status is what it is. */
  private finished(ref: ApiRef): RoundHandle {
    const chair = chairOf(this.sessionOf, ref) as ChairNode;
    return {
      sessionId: ref.sessionId,
      userId: chair.parentId ?? '',
      chairId: ref.chairId,
      done: Promise.resolve(chair.status),
      cancel: () => undefined,
      subscribe: () => () => undefined,
    };
  }
}
