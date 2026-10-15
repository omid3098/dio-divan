import { type FlowStep, seatsOf } from '../../src/shared/flow.ts';
// A small external store: one state object, subscribers, and a hook that re-renders on the slice a component reads.

import { useSyncExternalStore } from 'react';
import type { Meta, ServerEvent, Session, SessionSummary } from '../../src/shared/types.ts';
import { api } from './api.ts';
import { forgetSession, reconcileDirection, reconcileNode, setLayoutSink } from './layout-sync.ts';

export interface AppState {
  meta: Meta | null;
  sessions: SessionSummary[];
  /** The session open in the editor. */
  session: Session | null;
  /** null until the first answer (or failure) of the live stream: «connecting», not an alarm. */
  connected: boolean | null;
  loadError: string | null;
  /** Sessions whose deletion can still be undone: they are gone from every list, and deleted when the toast times out. */
  pendingDelete: string[];
  /** For each session the time of its last change that the user has seen: a session changed since is «Ready». */
  seen: Record<string, string>;
}

const SEEN_KEY = 'divan-seen';

function loadSeen(): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}

let state: AppState = {
  meta: null,
  sessions: [],
  session: null,
  connected: null,
  loadError: null,
  pendingDelete: [],
  seen: loadSeen() ?? {},
};
// The first run on this browser has no record: whatever exists then counts as seen, so nothing is «Ready» out of the blue.
let seenIsNew = loadSeen() === null;
const listeners = new Set<() => void>();

export function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const getState = () => state;

export function useAppState<T>(select: (current: AppState) => T): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => select(state),
  );
}

// ---------- the sessions the user can see ----------

function saveSeen(seen: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // storage that is off only loses the «Ready» marks
  }
}

/** The list of sessions arrived (a first load, or a reload after the stream dropped). */
export function setSessionList(list: SessionSummary[]): void {
  let seen = state.seen;
  if (seenIsNew) {
    seenIsNew = false;
    seen = Object.fromEntries(list.map((item) => [item.id, item.updatedAt]));
    saveSeen(seen);
  }
  setState({ sessions: list, seen });
}

/** The user has looked at a session as it is now. */
export function markSeen(id: string): void {
  const item = state.sessions.find((entry) => entry.id === id);
  if (!item || state.seen[id] === item.updatedAt) return;
  const seen = { ...state.seen, [id]: item.updatedAt };
  saveSeen(seen);
  setState({ seen });
}

/** A session with an answer the user has not opened yet: finished, and changed since it was last seen. */
export const isReady = (item: SessionSummary, seen: Record<string, string>): boolean =>
  !item.running && item.rounds > 0 && (seen[item.id] ?? '') < item.updatedAt;

export function hideSession(id: string): void {
  setState({ pendingDelete: [...state.pendingDelete, id] });
}
export function unhideSession(id: string): void {
  setState({ pendingDelete: state.pendingDelete.filter((item) => item !== id) });
}

// The live stream and a read of a session race: a read that was answered before a round finished can arrive after the event
// that said it finished. So while a session is being read the events wait, and are applied once the read is laid in.
let reading = 0;
const held: ServerEvent[] = [];

/** Where the live stream's events come in: applied at once, unless a session is being read (then after the read). */
export function receiveEvent(event: ServerEvent): void {
  if (reading > 0) held.push(event);
  else applyEvent(event);
}

/** Reads a session and lays it in with `apply`; the events that came in meanwhile are applied after it, in order. */
export async function readSession(
  fetchSession: () => Promise<Session>,
  apply: (fresh: Session) => void,
): Promise<void> {
  reading += 1;
  try {
    apply(await fetchSession());
  } finally {
    reading -= 1;
    if (reading === 0) for (const event of held.splice(0)) applyEvent(event);
  }
}

/**
 * Reads what this PC says about itself again (the councils, and how long a round usually takes at each level). The page that
 * waits for a round reads the usual time from here, as the first page does: so it is read again whenever a round has finished.
 */
export async function refreshMeta(): Promise<void> {
  try {
    setState({ meta: await api<Meta>('/meta') });
  } catch {
    // the next change reads it again
  }
}

/** Applies one server event to the state. */
export function applyEvent(event: ServerEvent): void {
  if (event.type === 'node') {
    const session = state.session;
    if (session && session.id === event.sessionId) {
      // what the round says about a node's place is compared by revision with what the page has seen and has not sent
      const node = reconcileNode(event.sessionId, event.node, session.nodes[event.node.id]);
      setState({ session: { ...session, nodes: { ...session.nodes, [node.id]: node } } });
    }
  } else if (event.type === 'seat') {
    // a member that is working showed a sign of work: its time and thinking tokens, live (at most once a second)
    const session = state.session;
    const chair = session?.id === event.sessionId ? session.nodes[event.chairId] : undefined;
    // a sign at or below the revision the page already has of the round is older than what it shows (a completion it saw in a
    // read, a previous attempt): it never sets a seat back
    if (session && chair?.kind === 'chair' && event.rev > (chair.rev ?? 0)) {
      const seats = seatsOf(chair).map((seat) =>
        seat.seatId === event.seatId
          ? {
              ...seat,
              state: event.state,
              lastSignalAt: event.lastSignalAt,
              thinkingTokens: event.thinkingTokens,
            }
          : seat,
      );
      setState({
        session: {
          ...session,
          nodes: {
            ...session.nodes,
            [chair.id]: chair.steps
              ? {
                  ...chair,
                  steps: chair.steps.map(
                    (step): FlowStep =>
                      step.form !== 'answer' && step.id === event.seatId
                        ? ({
                            ...step,
                            run: {
                              ...step.run,
                              state: event.state,
                              lastSignalAt: event.lastSignalAt,
                              thinkingTokens: event.thinkingTokens,
                            },
                          } as FlowStep)
                        : step,
                  ),
                  rev: event.rev,
                }
              : { ...chair, seats, rev: event.rev },
          },
        },
      });
    }
  } else if (event.type === 'session') {
    // a round that has just finished is one more measured round: the usual time moves
    if (
      state.sessions.find((item) => item.id === event.session.id)?.running &&
      !event.session.running
    ) {
      void refreshMeta();
    }
    const rest = state.sessions.filter((item) => item.id !== event.session.id);
    const session = state.session;
    setState({
      sessions: [event.session, ...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      ...(session && session.id === event.session.id
        ? {
            session: {
              ...session,
              name: event.session.name,
              layout: { direction: reconcileDirection(session.id, event.layout.direction) },
            },
          }
        : {}),
    });
  } else if (event.type === 'deleted') {
    forgetSession(event.sessionId);
    setState({
      sessions: state.sessions.filter((item) => item.id !== event.sessionId),
      pendingDelete: state.pendingDelete.filter((item) => item !== event.sessionId),
      ...(state.session?.id === event.sessionId ? { session: null } : {}),
    });
  }
}

// What the layout decides (a drag shown at once, the places the server answered with) goes into the open session.
setLayoutSink({
  apply(sessionId, change) {
    const session = state.session;
    if (!session || session.id !== sessionId) return;
    const nodes = { ...session.nodes };
    for (const [id, next] of Object.entries(change.nodes ?? {})) {
      const node = nodes[id];
      if (!node) continue;
      nodes[id] = {
        ...node,
        ...(next.position !== undefined ? { position: next.position } : {}),
        ...(next.pinned !== undefined ? { pinned: next.pinned } : {}),
        ...(next.layoutRev !== undefined ? { layoutRev: next.layoutRev } : {}),
      };
    }
    setState({
      session: {
        ...session,
        nodes,
        ...(change.direction ? { layout: { direction: change.direction } } : {}),
      },
    });
  },
});
