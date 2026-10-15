import { seatsOf } from '../src/shared/flow.ts';
// A session read and the live stream race: a read that was answered before a round finished can arrive after the event that
// said it finished, and then the page would wait for a round that is over. The events wait while a session is being read, and
// a node older than the one the page has never replaces it (the content revision, `NodeBase.rev`).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ChairNode,
  ServerEvent,
  Session,
  SessionNode,
  SessionSummary,
} from '../src/shared/types.ts';
import { chairNode, sessionOf, userNode } from './fixtures.ts';

const asked = vi.hoisted(() => ({ paths: [] as string[], answer: null as unknown }));
vi.mock('../web/src/api.ts', () => ({
  ApiError: class ApiError extends Error {},
  api: async (path: string) => {
    asked.paths.push(path);
    if (asked.answer === null) throw new Error('no server in this test');
    return asked.answer;
  },
}));

// The page's own modules are loaded by a path in a variable: they use the browser's types, which this folder's typecheck (the
// server's, without them) must not follow.
const STORE = '../web/src/store.ts';
const SYNC = '../web/src/layout-sync.ts';
interface Page {
  setState(patch: { session: Session | null }): void;
  getState(): { session: Session | null; meta: unknown };
  receiveEvent(event: ServerEvent): void;
  readSession(fetchSession: () => Promise<Session>, apply: (fresh: Session) => void): Promise<void>;
  setSessionList(list: SessionSummary[]): void;
  reconcileNode<T extends SessionNode>(sessionId: string, incoming: T, local?: T): T;
  reconcileSession(session: Session, local?: Session | null): Session;
}

async function page(): Promise<Page> {
  vi.resetModules();
  const store = (await import(STORE)) as Omit<Page, 'reconcileNode' | 'reconcileSession'>;
  const sync = (await import(SYNC)) as Pick<Page, 'reconcileNode' | 'reconcileSession'>;
  return { ...store, ...sync };
}

const SESSION_ID = 'sess-1';
const chair = (rev: number, fields: Partial<ChairNode> = {}): ChairNode =>
  chairNode('c1', 'u0', 1, { rev, ...fields });
const snapshot = (node: ChairNode): Session =>
  sessionOf([userNode('u0', null, 'Q'), node], SESSION_ID);
const nodeEvent = (node: ChairNode): ServerEvent => ({ type: 'node', sessionId: SESSION_ID, node });
const chairOf = (session: Session | null) => session?.nodes.c1 as ChairNode;

describe('a node older than the one the page has', () => {
  let p: Awaited<ReturnType<typeof page>>;
  beforeEach(async () => {
    p = await page();
  });

  it('never replaces it: a running snapshot does not undo a finished round', () => {
    const finished = chair(900, { status: 'done', title: 'Finished' });
    const older = chair(500, { status: 'running', title: '' });
    const merged = p.reconcileNode(SESSION_ID, older, finished);
    expect(merged.status).toBe('done');
    expect((merged as ChairNode).title).toBe('Finished');
  });

  it('is replaced by a newer one, and by one of the same revision (a read that has seen later changes)', () => {
    const running = chair(500, { status: 'running' });
    expect(p.reconcileNode(SESSION_ID, chair(900, { status: 'done' }), running).status).toBe(
      'done',
    );
    expect(p.reconcileNode(SESSION_ID, chair(500, { status: 'failed' }), running).status).toBe(
      'failed',
    );
  });

  it('is only about what the node says: its place still follows its layout revision', () => {
    const local = chair(900, { status: 'done', position: { x: 1, y: 1 }, layoutRev: 1 });
    const incoming = chair(500, {
      status: 'running',
      position: { x: 50, y: 60 },
      pinned: true,
      layoutRev: 4,
    });
    const merged = p.reconcileNode(SESSION_ID, incoming, local);
    expect(merged.status).toBe('done');
    expect(merged.position).toEqual({ x: 50, y: 60 });
    expect(merged.pinned).toBe(true);
    expect(merged.layoutRev).toBe(4);
  });

  it('a node from before the field (no revision) is the oldest', () => {
    const local = chair(10, { status: 'done' });
    const { rev: _gone, ...old } = chair(0, { status: 'running' });
    expect(p.reconcileNode(SESSION_ID, old as ChairNode, local).status).toBe('done');
    expect(p.reconcileNode(SESSION_ID, local, old as ChairNode).status).toBe('done');
  });
});

describe('the events that come in while a session is being read', () => {
  let p: Awaited<ReturnType<typeof page>>;
  beforeEach(async () => {
    p = await page();
  });

  /** A read that is answered when `answer` is called. */
  const slowRead = (value: Session) => {
    let answer: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      answer = resolve;
    });
    return {
      answer,
      fetch: async () => {
        await done;
        return value;
      },
    };
  };

  it('wait, and are applied after it: the finished round stays finished', async () => {
    // the page has the round running (revision 500); a read is asked; the round finishes (event, 900); then the read is answered
    // with what the server had when it was asked (running, 500)
    p.setState({ session: snapshot(chair(500, { status: 'running' })) });
    const read = slowRead(snapshot(chair(500, { status: 'running' })));
    const reading = p.readSession(read.fetch, (fresh) =>
      p.setState({ session: p.reconcileSession(fresh, p.getState().session) }),
    );
    p.receiveEvent(nodeEvent(chair(900, { status: 'done', title: 'Finished' })));
    // nothing is applied while the read is out
    expect(chairOf(p.getState().session).status).toBe('running');
    read.answer();
    await reading;
    expect(chairOf(p.getState().session).status).toBe('done');
    expect(chairOf(p.getState().session).title).toBe('Finished');
  });

  it('are applied in the order they came, and an event older than the read changes nothing', async () => {
    p.setState({ session: snapshot(chair(100, { status: 'running' })) });
    // the read already has the finished round (900); the events held are the older ones
    const read = slowRead(snapshot(chair(900, { status: 'done', title: 'Finished' })));
    const reading = p.readSession(read.fetch, (fresh) =>
      p.setState({ session: p.reconcileSession(fresh, p.getState().session) }),
    );
    p.receiveEvent(nodeEvent(chair(300, { status: 'running', title: '' })));
    p.receiveEvent(nodeEvent(chair(600, { status: 'running', title: '' })));
    read.answer();
    await reading;
    expect(chairOf(p.getState().session).status).toBe('done');
    // and with nothing being read, events are applied at once again
    p.receiveEvent(nodeEvent(chair(1200, { status: 'failed' })));
    expect(chairOf(p.getState().session).status).toBe('failed');
  });

  it('are applied also when the read fails', async () => {
    p.setState({ session: snapshot(chair(500, { status: 'running' })) });
    const reading = p.readSession(
      async () => {
        throw new Error('network');
      },
      () => undefined,
    );
    p.receiveEvent(nodeEvent(chair(900, { status: 'done' })));
    await expect(reading).rejects.toThrow('network');
    expect(chairOf(p.getState().session).status).toBe('done');
  });
});

describe('how long a round usually takes', () => {
  const summary = (running: boolean): SessionSummary => ({
    id: SESSION_ID,
    name: 'n',
    title: 't',
    question: 'q',
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
    rounds: running ? 0 : 1,
    tokens: 0,
    running,
    origin: 'web',
  });

  it('is read again when a round has finished, so the waiting screen knows what the first page knows', async () => {
    const p = await page();
    asked.paths.length = 0;
    const meta = { typicalRoundRange: { min: 5, max: 10, count: 3 } };
    asked.answer = meta;
    p.setSessionList([summary(true)]);
    // a session that is still running changes: nothing to read
    p.receiveEvent({ type: 'session', session: summary(true), layout: { direction: 'TB' } });
    expect(asked.paths).toEqual([]);
    // the round ends: one more measured round, so the usual time is read again
    p.receiveEvent({ type: 'session', session: summary(false), layout: { direction: 'TB' } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(asked.paths).toEqual(['/meta']);
    expect(p.getState().meta).toEqual(meta);
    asked.answer = null;
  });
});

describe('a sign of work that was held, and the completion that came after it', () => {
  let p: Awaited<ReturnType<typeof page>>;
  beforeEach(async () => {
    p = await page();
  });

  const seatOf = (session: Session | null) => seatsOf(chairOf(session))[0];
  const signEvent = (rev: number): Extract<ServerEvent, { type: 'seat' }> => ({
    type: 'seat',
    rev,
    sessionId: SESSION_ID,
    chairId: 'c1',
    seatId: 'S1',
    label: 'A',
    state: 'running',
    lastSignalAt: '2026-10-10T00:00:05Z',
    thinkingTokens: 10,
  });
  const withSeat = (
    rev: number,
    state: 'running' | 'done',
    thinkingTokens: number | null = null,
  ) => {
    const node = chair(rev, { status: 'running' });
    node.seats = seatsOf(node).map((one) => ({
      ...one,
      seatId: 'S1',
      label: 'A',
      state,
      thinkingTokens,
    }));
    return node;
  };

  it('never sets a seat back to running: the stream dropped, the read shows it completed, the old sign is drained', async () => {
    // the page has the seat running; a sign (revision 600) comes in while a read is out; the stream dropped and missed the
    // completion; the read shows the seat completed (revision 900)
    p.setState({ session: snapshot(withSeat(500, 'running')) });
    const read = slowRead(snapshot(withSeat(900, 'done')));
    const reading = p.readSession(read.fetch, (fresh) =>
      p.setState({ session: p.reconcileSession(fresh, p.getState().session) }),
    );
    p.receiveEvent(signEvent(600));
    read.answer();
    await reading;
    // the held sign is older than the round the page now has: it is dropped
    expect(seatOf(p.getState().session)?.state).toBe('done');
    expect(chairOf(p.getState().session).rev).toBe(900);
  });

  it('a sign from a previous attempt is dropped too, a newer one is applied, and one that is not newer is dropped', () => {
    // the seat runs again after a run again (round revision 900); the old attempt's last sign arrives late
    p.setState({ session: snapshot(withSeat(900, 'running')) });
    p.receiveEvent(signEvent(700));
    expect(seatOf(p.getState().session)?.thinkingTokens ?? null).toBe(null);
    p.receiveEvent(signEvent(1000));
    expect(seatOf(p.getState().session)?.thinkingTokens).toBe(10);
    expect(chairOf(p.getState().session).rev).toBe(1000);
    p.receiveEvent({ ...signEvent(1000), thinkingTokens: 99 });
    expect(seatOf(p.getState().session)?.thinkingTokens).toBe(10);
  });
});

/** A read that is answered when `answer` is called. */
function slowRead(value: Session) {
  let answer: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    answer = resolve;
  });
  return {
    answer,
    fetch: async () => {
      await done;
      return value;
    },
  };
}
