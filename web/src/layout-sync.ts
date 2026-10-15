// Where the nodes are: the server decides, the page asks.
//
// Every node has a `layoutRev`, which the server raises each time it changes the node's place or pin. A write (a drag, or
// «چیدن» for every node at once) names the revision the page last saw of each node it moves; the server applies it only if
// all of them still match, and otherwise answers 409 with the places that are now true, which the page adopts. A write that
// is sent again (its answer was lost) carries the same id and is answered, not applied, again.
//
// What has not been acknowledged is kept in memory only, per session: per node the newest place not yet sent (an edit made
// while a write is on its way waits and replaces an older one), and the write on its way. Nothing is stored: a reload loses
// what was not sent, so the page asks before it is left (`beforeunload`).
//
// What arrives is compared by revision, never by time: an event or a read whose node is older than what the page has seen
// is ignored for that node, a newer one wins (and drops the page's own unsent edit of it), the same one is shown with the
// page's unsent edit laid over it. The revision the page knows of a node only ever rises (an answer that arrives late, after
// a newer event, cannot lower it), and the newest place the server has told is kept, so that when the page's own edit is
// answered and stops covering the node, the node shows that place.

import { useSyncExternalStore } from 'react';
import type { LayoutDirection, Session, SessionNode } from '../../src/shared/types.ts';
import { ApiError, api } from './api.ts';
import { translate } from './i18n/index.tsx';

const FIRST_RETRY_MS = 3000;
const LAST_RETRY_MS = 30_000;
const NOTICE_MS = 8000;

interface Place {
  x: number;
  y: number;
  pinned: boolean;
}

interface Outgoing {
  opId: string;
  direction?: LayoutDirection;
  nodes: Record<string, Place & { rev: number }>;
}

/** A node as the server last said it, with its revision. */
interface Told {
  position: { x: number; y: number } | null;
  pinned: boolean;
  rev: number;
}

interface SessionSync {
  /** The newest revision seen of each node, from reads, events, answers. It never goes down. */
  known: Map<string, number>;
  /** The newest place the server told for each node (from reads, events, refusals). */
  told: Map<string, Told>;
  /** The newest place of each node that has not been sent. */
  pending: Map<string, Place>;
  pendingDirection: LayoutDirection | null;
  /** The write on its way, kept as it was sent until it is answered (a retry sends it unchanged). */
  inflight: Outgoing | null;
}

const sessions = new Map<string, SessionSync>();

function sync(sessionId: string): SessionSync {
  let found = sessions.get(sessionId);
  if (!found) {
    found = {
      known: new Map(),
      told: new Map(),
      pending: new Map(),
      pendingDirection: null,
      inflight: null,
    };
    sessions.set(sessionId, found);
  }
  return found;
}

/** A session that is gone (deleted here or elsewhere): nothing of its layout is kept or sent any more. */
export function forgetSession(sessionId: string): void {
  if (sessions.delete(sessionId)) notify();
}

/** What the store does with what the layout decides: take places, pins, revisions and the direction into the open session. */
export interface LayoutSink {
  apply(
    sessionId: string,
    change: {
      direction?: LayoutDirection;
      nodes?: Record<
        string,
        { position?: { x: number; y: number } | null; pinned?: boolean; layoutRev?: number }
      >;
    },
  ): void;
}
let sink: LayoutSink | null = null;
export const setLayoutSink = (next: LayoutSink): void => {
  sink = next;
};

// ---------- what the page shows ----------

export interface LayoutSyncStatus {
  /** Nodes whose place the server has not acknowledged yet, by session. */
  waiting: Record<string, number>;
  /** A write failed (the network, a server error) and is tried again. */
  failed: boolean;
  /** The server did not accept the page's token (it was restarted): sending waits until the page is connected again. */
  authNeeded: boolean;
  /** A write the server refused for good, said once. */
  notice: string | null;
}

const listeners = new Set<() => void>();
let snapshot: LayoutSyncStatus = { waiting: {}, failed: false, authNeeded: false, notice: null };
let paused = false;
let failed = false;
let notice: string | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  const waiting: Record<string, number> = {};
  for (const [id, state] of sessions) {
    const count = new Set([...state.pending.keys(), ...Object.keys(state.inflight?.nodes ?? {})])
      .size;
    if (count > 0) waiting[id] = count;
  }
  snapshot = { waiting, failed, authNeeded: paused, notice };
  for (const listener of listeners) listener();
}

export const layoutSyncStatus = (): LayoutSyncStatus => snapshot;

export function useLayoutSync(): LayoutSyncStatus {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

const unsaved = (): boolean =>
  [...sessions.values()].some((state) => state.pending.size > 0 || state.inflight !== null);

// A page that is left with places not sent would lose them: the browser asks first.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (!unsaved()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

// ---------- the user's own changes ----------

/** Places nodes (a drag pins one; «چیدن» unpins and places all, with the direction): shown at once, sent soon. */
function place(
  sessionId: string,
  places: Record<string, Place>,
  direction?: LayoutDirection,
): void {
  const state = sync(sessionId);
  const shown: Record<string, { position: { x: number; y: number }; pinned: boolean }> = {};
  for (const [id, at] of Object.entries(places)) {
    const rounded = { x: Math.round(at.x), y: Math.round(at.y) };
    state.pending.set(id, { ...rounded, pinned: at.pinned });
    shown[id] = { position: rounded, pinned: at.pinned };
  }
  if (direction) state.pendingDirection = direction;
  sink?.apply(sessionId, { nodes: shown, ...(direction ? { direction } : {}) });
  notify();
  void flush();
}

/** A node dragged to (x, y): pinned there. */
export const moveNode = (sessionId: string, nodeId: string, x: number, y: number): void =>
  place(sessionId, { [nodeId]: { x, y, pinned: true } });

/** «چیدن»: every node unpinned and at its place in the new layout, and the direction: one write, all or none. */
export function arrangeNodes(
  sessionId: string,
  places: Record<string, { x: number; y: number }>,
  direction: LayoutDirection,
): void {
  place(
    sessionId,
    Object.fromEntries(Object.entries(places).map(([id, at]) => [id, { ...at, pinned: false }])),
    direction,
  );
}

// ---------- laying what arrives against what the page knows ----------

/**
 * One node as the server says it (an event or a read), against what the page has seen and has not sent. Its place is decided by
 * the layout revision (below); what it says (status, answer, members) by its content revision: a node older than the one the
 * page has is not news, so a read that was answered before a round finished never lands on top of the event that said so.
 */
export function reconcileNode<T extends SessionNode>(sessionId: string, incoming: T, local?: T): T {
  const laid = reconcilePlace(sessionId, incoming, local);
  if (local && (incoming.rev ?? 0) < (local.rev ?? 0)) {
    return {
      ...local,
      position: laid.position,
      pinned: laid.pinned,
      layoutRev: laid.layoutRev,
    };
  }
  return laid;
}

/** The place of a node as the server says it, with the page's own unsent edit laid over it. */
function reconcilePlace<T extends SessionNode>(sessionId: string, incoming: T, local?: T): T {
  const state = sync(sessionId);
  const rev = incoming.layoutRev ?? 0;
  const seen = state.known.get(incoming.id);
  if (seen !== undefined && rev < seen) {
    // older than what the page has seen: its place is not news
    return local
      ? { ...incoming, position: local.position, pinned: local.pinned, layoutRev: local.layoutRev }
      : incoming;
  }
  if (seen === undefined || rev > seen) {
    state.known.set(incoming.id, rev);
    state.told.set(incoming.id, { position: incoming.position, pinned: incoming.pinned, rev });
    // somebody else moved it: that wins over the page's own unsent edit, unless a write of the page's is on its way (its
    // answer says what is true)
    if (!state.inflight?.nodes[incoming.id] && state.pending.delete(incoming.id)) notify();
  }
  const mine = state.pending.get(incoming.id) ?? state.inflight?.nodes[incoming.id];
  return mine ? { ...incoming, position: { x: mine.x, y: mine.y }, pinned: mine.pinned } : incoming;
}

/** The direction of a session as the server says it, with the page's own unsent «چیدن» laid over it. */
export function reconcileDirection(sessionId: string, incoming: LayoutDirection): LayoutDirection {
  const state = sync(sessionId);
  return state.pendingDirection ?? state.inflight?.direction ?? incoming;
}

/** A whole session as the server says it, node by node; `local` is the open copy, kept where the server's is older. */
export function reconcileSession(session: Session, local?: Session | null): Session {
  const same = local && local.id === session.id ? local : null;
  const nodes: Record<string, SessionNode> = {};
  for (const [id, node] of Object.entries(session.nodes)) {
    const mine = same?.nodes[id];
    nodes[id] = reconcileNode(session.id, node, mine);
  }
  return {
    ...session,
    nodes,
    layout: {
      ...session.layout,
      direction: reconcileDirection(session.id, session.layout.direction),
    },
  };
}

// ---------- sending ----------

let sending = false;
let retryDelay = FIRST_RETRY_MS;
let backoffUntil = 0;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

const newOpId = (): string =>
  `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The pending places of a session as one write, against the revisions the page has seen. */
function build(state: SessionSync): Outgoing {
  const nodes: Outgoing['nodes'] = {};
  for (const [id, place] of state.pending) nodes[id] = { ...place, rev: state.known.get(id) ?? 0 };
  const op: Outgoing = {
    opId: newOpId(),
    nodes,
    ...(state.pendingDirection ? { direction: state.pendingDirection } : {}),
  };
  state.pending = new Map();
  state.pendingDirection = null;
  return op;
}

function say(message: string): void {
  notice = message;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    notify();
  }, NOTICE_MS);
}

interface Conflict {
  direction?: LayoutDirection;
  nodes?: Record<
    string,
    { position: { x: number; y: number } | null; pinned: boolean; layoutRev: number }
  >;
}

async function flush(): Promise<void> {
  if (sending || paused || Date.now() < backoffUntil) return;
  sending = true;
  clearTimeout(retryTimer);
  try {
    for (;;) {
      const entry = [...sessions].find(
        ([, state]) => state.inflight || state.pending.size > 0 || state.pendingDirection,
      );
      if (!entry) break;
      const [sessionId, state] = entry;
      if (!state.inflight) state.inflight = build(state);
      const op = state.inflight;
      try {
        const answer = await api<{ nodes?: Record<string, { layoutRev: number }> }>(
          `/sessions/${sessionId}/layout`,
          'PUT',
          { opId: op.opId, ...(op.direction ? { direction: op.direction } : {}), nodes: op.nodes },
        );
        const revs: NonNullable<Parameters<LayoutSink['apply']>[1]['nodes']> = {};
        for (const id of Object.keys(op.nodes)) {
          const acked = answer.nodes?.[id]?.layoutRev ?? (op.nodes[id]?.rev ?? 0) + 1;
          const told = state.told.get(id);
          if (told && told.rev > acked && !state.pending.has(id)) {
            // somebody moved it after this write: that place is the truth, and the page's own edit no longer covers it
            revs[id] = { layoutRev: told.rev, position: told.position, pinned: told.pinned };
          } else {
            revs[id] = { layoutRev: Math.max(acked, state.known.get(id) ?? 0) };
          }
          state.known.set(id, Math.max(acked, state.known.get(id) ?? 0));
        }
        state.inflight = null;
        sink?.apply(sessionId, { nodes: revs });
        failed = false;
        retryDelay = FIRST_RETRY_MS;
        notify();
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          // somebody moved those nodes meanwhile: the server's places are the truth, nothing is sent again
          const truth = error.body as Conflict;
          const adopted: NonNullable<Conflict['nodes']> = {};
          for (const [id, place] of Object.entries(truth.nodes ?? {})) {
            // the refusal can be older than something already heard (an event): the newer of the two is the truth
            const heard = state.told.get(id);
            const newest =
              heard && heard.rev > place.layoutRev
                ? { position: heard.position, pinned: heard.pinned, layoutRev: heard.rev }
                : place;
            state.known.set(id, Math.max(newest.layoutRev, state.known.get(id) ?? 0));
            state.told.set(id, {
              position: newest.position,
              pinned: newest.pinned,
              rev: newest.layoutRev,
            });
            state.pending.delete(id);
            adopted[id] = newest;
          }
          state.inflight = null;
          state.pendingDirection = null;
          sink?.apply(sessionId, {
            nodes: adopted,
            ...(truth.direction ? { direction: truth.direction } : {}),
          });
          notify();
          continue;
        }
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          // the server does not know this page's token (it was restarted): what is kept waits for a connection
          paused = true;
          notify();
          return;
        }
        if (error instanceof ApiError && (error.status === 400 || error.status === 404)) {
          // the server will never take this one: it is dropped, and said
          state.inflight = null;
          if (error.status === 404) sessions.delete(sessionId);
          say(
            error.status === 404
              ? translate('layout.sessionGone')
              : translate('layout.rejected', { reason: error.message }),
          );
          notify();
          continue;
        }
        // the network, or a server error: the same write is sent again after a pause (a new edit waits for it too)
        failed = true;
        backoffUntil = Date.now() + retryDelay;
        retryTimer = setTimeout(() => void flush(), retryDelay);
        retryDelay = Math.min(retryDelay * 2, LAST_RETRY_MS);
        notify();
        return;
      }
    }
  } finally {
    sending = false;
  }
}

/** Sends now, without waiting for the pause (the user asked), after a network or server failure. */
export function retryLayoutSync(): void {
  backoffUntil = 0;
  void flush();
}

/** The page is connected again (a new token was given): what was kept is sent. */
export function resumeLayoutSync(): void {
  paused = false;
  backoffUntil = 0;
  notify();
  void flush();
}
