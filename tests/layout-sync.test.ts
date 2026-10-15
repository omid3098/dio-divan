// Where the nodes are: the server decides by revision, the page asks. The page's side: what has not been acknowledged is
// kept in memory, coalesced per node, sent one write at a time against the revisions the page has seen; a refusal (409) is
// adopted, a lost answer is retried with the same write id, a token the server does not know pauses sending, and what
// arrives is compared by revision, not by time.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Engine, EngineError } from '../src/server/engine.ts';
import { Store } from '../src/server/store.ts';
import type { Session, SessionNode } from '../src/shared/types.ts';
import { chairNode, sessionOf, tree, userNode } from './fixtures.ts';

const { ApiError } = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly body: Record<string, unknown>;
    constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
      super(message);
      this.status = status;
      this.code = code;
      this.body = body;
    }
  },
}));

// ---------- the server: the real engine, over a store that keeps its writes in memory ----------

/** What the server has of a node, as the page would see it. */
interface Stored {
  x: number;
  y: number;
  pinned: boolean;
  rev: number;
}
const server = {
  engine: null as Engine | null,
  requests: [] as {
    opId: string;
    nodes: Record<string, Stored & { rev: number }>;
    direction?: string;
  }[],
  /** Called with each request before it is answered; may throw (the network, a 5xx, a 401) or wait. */
  before: async (_n: number): Promise<void> => undefined,
};

/** The engine's own answer to a layout write; its refusals reach the page as the API's errors do. */
async function put(body: unknown): Promise<unknown> {
  try {
    return await (server.engine as Engine).setLayout('s1', body as never);
  } catch (error) {
    if (error instanceof EngineError) {
      throw new ApiError(error.status, error.code, error.message, error.details ?? {});
    }
    throw error;
  }
}

vi.mock('../web/src/api.ts', () => ({
  ApiError,
  api: async (path: string, _method: string, body: never) => {
    expect(path).toBe('/sessions/s1/layout');
    server.requests.push(JSON.parse(JSON.stringify(body)));
    await server.before(server.requests.length);
    return put(body);
  },
}));

class MemoryStore extends Store {
  protected override async write(): Promise<void> {}
}

let store: MemoryStore;
/** The node as the server has it now. */
const live = (id: string): SessionNode => store.get('s1')?.nodes[id] as SessionNode;
const stored = (id: string): Stored => {
  const node = live(id);
  return {
    x: node.position?.x ?? Number.NaN,
    y: node.position?.y ?? Number.NaN,
    pinned: node.pinned,
    rev: node.layoutRev,
  };
};

// ---------- a page (a tab): its own copy of the module, with a sink that records what it is told ----------

interface Sink {
  apply(
    sessionId: string,
    change: { direction?: string; nodes?: Record<string, Record<string, unknown>> },
  ): void;
}
interface Page {
  moveNode(sessionId: string, nodeId: string, x: number, y: number): void;
  arrangeNodes(
    sessionId: string,
    places: Record<string, { x: number; y: number }>,
    direction: 'TB' | 'LR',
  ): void;
  reconcileNode<T>(sessionId: string, incoming: T, local?: T): T;
  reconcileSession(session: Session, local?: Session | null): Session;
  reconcileDirection(sessionId: string, incoming: 'TB' | 'LR'): 'TB' | 'LR';
  layoutSyncStatus(): {
    waiting: Record<string, number>;
    failed: boolean;
    authNeeded: boolean;
    notice: string | null;
  };
  retryLayoutSync(): void;
  resumeLayoutSync(): void;
  forgetSession(sessionId: string): void;
  setLayoutSink(sink: Sink): void;
  told: {
    sessionId: string;
    change: { direction?: string; nodes?: Record<string, Record<string, unknown>> };
  }[];
}

// The page's own module is loaded by a path in a variable: it uses the browser's types, which this folder's typecheck
// (the server's, without them) must not follow.
const SYNC = '../web/src/layout-sync.ts';

async function openPage(): Promise<Page> {
  vi.resetModules();
  const page = (await import(SYNC)) as Page;
  page.told = [];
  page.setLayoutSink({ apply: (sessionId, change) => page.told.push({ sessionId, change }) });
  return page;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const node = (id: string, rev: number, x = 0, y = 0, pinned = false) => ({
  ...userNode(id, 'c1', id),
  position: { x, y },
  pinned,
  layoutRev: rev,
});

let unloadHandler: ((event: { preventDefault(): void; returnValue: unknown }) => void) | undefined;

beforeEach(async () => {
  store = new MemoryStore('unused');
  await store.save(
    sessionOf(
      [
        userNode('u0', null, 'Q'),
        userNode('u1', 'u0', 'one'),
        chairNode('c1', 'u1', 1),
        userNode('u2', 'c1', 'two'),
      ],
      's1',
    ),
  );
  server.engine = new Engine(store, () => undefined);
  vi.useFakeTimers();
  server.requests = [];
  server.before = async () => undefined;
  unloadHandler = undefined;
  vi.stubGlobal('window', {
    addEventListener: (type: string, handler: typeof unloadHandler) => {
      if (type === 'beforeunload') unloadHandler = handler;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('sending what the user changed', () => {
  it('a drag is shown at once and sent with the revision the page has seen', async () => {
    const page = await openPage();
    page.reconcileNode('s1', node('u1', 3));
    page.moveNode('s1', 'u1', 10.4, 20.6);
    expect(page.told[0]?.change.nodes?.u1).toMatchObject({
      position: { x: 10, y: 21 },
      pinned: true,
    });
    await settle();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.nodes.u1).toEqual({ x: 10, y: 21, pinned: true, rev: 3 });
  });

  it('what is made while a write is on its way waits, per node only the newest, and goes as one next write', async () => {
    const page = await openPage();
    let release: () => void = () => undefined;
    server.before = (n) =>
      n === 1 ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    for (const x of [2, 3, 4]) page.moveNode('s1', 'u1', x, x); // three drags of the same node meanwhile
    page.moveNode('s1', 'c1', 9, 9);
    expect(server.requests).toHaveLength(1); // one at a time
    expect(page.layoutSyncStatus().waiting).toEqual({ s1: 2 });
    release();
    await settle();
    expect(server.requests).toHaveLength(2);
    // the next write has the newest place of u1, and the revision the first write was acknowledged with
    expect(server.requests[1]?.nodes.u1).toEqual({ x: 4, y: 4, pinned: true, rev: 1 });
    expect(server.requests[1]?.nodes.c1).toEqual({ x: 9, y: 9, pinned: true, rev: 0 });
    expect(page.layoutSyncStatus().waiting).toEqual({});
    expect(stored('u1')).toMatchObject({ x: 4, rev: 2 });
  });

  it('«چیدن» is one write: every node unpinned and placed, with the direction', async () => {
    const page = await openPage();
    page.reconcileNode('s1', node('u1', 2, 5, 5, true));
    Object.assign(live('u1'), { position: { x: 5, y: 5 }, pinned: true, layoutRev: 2 });
    page.arrangeNodes('s1', { u1: { x: 0, y: 0 }, c1: { x: 0, y: 100 } }, 'LR');
    await settle();
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      direction: 'LR',
      nodes: { u1: { pinned: false, rev: 2 }, c1: { pinned: false, rev: 0 } },
    });
    expect(store.get('s1')?.layout.direction).toBe('LR');
    expect(page.reconcileDirection('s1', 'TB')).toBe('TB'); // acknowledged: nothing of the page's own is laid over it
  });
});

describe('a stale write (409): the page adopts the server state and does not send again', () => {
  it('two tabs write the same node: whichever the server took first stands, and the other adopts it and sends nothing again', async () => {
    // A's write is on its way (base revision 0); B, which also saw revision 0, is acknowledged first
    const tabA = await openPage();
    tabA.reconcileNode('s1', node('u1', 0));
    let release: () => void = () => undefined;
    server.before = () => new Promise<void>((resolve) => (release = resolve));
    tabA.moveNode('s1', 'u1', 100, 100);
    await settle();
    const tabB = await openPage();
    tabB.reconcileNode('s1', node('u1', 0));
    server.before = async () => undefined;
    tabB.moveNode('s1', 'u1', 500, 500);
    await settle();
    expect(stored('u1')).toMatchObject({ x: 500, y: 500, rev: 1 });
    release();
    await settle();
    expect(stored('u1')).toMatchObject({ x: 500, y: 500, rev: 1 });
    expect(server.requests).toHaveLength(2);
    expect(tabA.told.at(-1)?.change.nodes?.u1).toEqual({
      position: { x: 500, y: 500 },
      pinned: true,
      layoutRev: 1,
    });
    expect(tabA.layoutSyncStatus()).toMatchObject({ waiting: {}, failed: false, notice: null });
    // the other order: C writes first and is applied, D (same revision seen) is the one refused
    const tabC = await openPage();
    tabC.reconcileNode('s1', node('u2', 0));
    tabC.moveNode('s1', 'u2', 100, 100);
    await settle();
    const tabD = await openPage();
    tabD.reconcileNode('s1', node('u2', 0));
    tabD.moveNode('s1', 'u2', 500, 500);
    await settle();
    expect(stored('u2')).toMatchObject({ x: 100, y: 100, rev: 1 });
    expect(tabD.told.at(-1)?.change.nodes?.u2).toMatchObject({
      position: { x: 100, y: 100 },
      layoutRev: 1,
    });
  });

  it("a refused «چیدن» is refused whole, and the page takes the server's places and direction", async () => {
    const tabA = await openPage();
    tabA.reconcileNode('s1', node('u1', 0));
    tabA.reconcileNode('s1', node('c1', 0));
    // moved by another tab meanwhile
    Object.assign(live('c1'), { position: { x: 7, y: 7 }, pinned: true, layoutRev: 1 });
    (store.get('s1') as Session).layout.direction = 'LR';
    tabA.arrangeNodes('s1', { u1: { x: 0, y: 0 }, c1: { x: 0, y: 100 } }, 'TB');
    await settle();
    expect(live('u1').position).toBeNull(); // u1, whose revision was right, was not moved either
    const told = tabA.told.at(-1)?.change;
    expect(told?.direction).toBe('LR');
    expect(told?.nodes?.c1).toMatchObject({ position: { x: 7, y: 7 }, pinned: true, layoutRev: 1 });
    expect(tabA.reconcileDirection('s1', 'LR')).toBe('LR');
  });
});

describe('a write whose answer was lost is sent again as the same write', () => {
  it('the retry carries the same id and the server answers it without applying it twice', async () => {
    const page = await openPage();
    let first = true;
    server.before = async () => {
      if (!first) return;
      first = false;
      // the server will apply this write, but its answer never reaches the page
      await put(server.requests[0]);
      throw new TypeError('Failed to fetch');
    };
    page.moveNode('s1', 'u1', 5, 5);
    await settle();
    expect(page.layoutSyncStatus()).toMatchObject({ failed: true, waiting: { s1: 1 } });
    await vi.advanceTimersByTimeAsync(3100);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.opId).toBe(server.requests[0]?.opId);
    expect(stored('u1')).toMatchObject({ x: 5, rev: 1 }); // applied once
    expect(page.layoutSyncStatus()).toMatchObject({ failed: false, waiting: {} });
  });

  it('a new edit waits for the pause too, and goes after the write that failed', async () => {
    const page = await openPage();
    let down = true;
    server.before = async () => {
      if (down) throw new TypeError('Failed to fetch');
    };
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    expect(server.requests).toHaveLength(1);
    page.moveNode('s1', 'c1', 2, 2); // a new edit during the pause: nothing is sent for it yet
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.requests).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(2200);
    expect(server.requests.map((request) => Object.keys(request.nodes))).toEqual([
      ['u1'],
      ['u1'],
      ['c1'],
    ]);
    expect(page.layoutSyncStatus().waiting).toEqual({});
  });

  it('a server error backs off with a growing pause; the retry on request does not wait', async () => {
    const page = await openPage();
    server.before = async () => {
      throw new ApiError(503, 'unavailable', 'down');
    };
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    await vi.advanceTimersByTimeAsync(3100); // 1st retry
    expect(server.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3100); // the pause has grown to 6 s: not yet
    expect(server.requests).toHaveLength(2);
    server.before = async () => undefined;
    page.retryLayoutSync();
    await settle();
    expect(server.requests).toHaveLength(3);
    expect(page.layoutSyncStatus()).toMatchObject({ failed: false, waiting: {} });
  });
});

describe('a token the server does not know (401, 403)', () => {
  it('keeps what is waiting, pauses sending, says it, and sends after the page is connected again', async () => {
    const page = await openPage();
    server.before = async () => {
      throw new ApiError(401, 'no_token', 'no token'); // a 403 is the same
    };
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    expect(page.layoutSyncStatus()).toMatchObject({ authNeeded: true, waiting: { s1: 1 } });
    page.moveNode('s1', 'c1', 2, 2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.requests).toHaveLength(1); // nothing is sent while it is paused, however long
    server.before = async () => undefined; // the server knows the new token
    page.resumeLayoutSync();
    await settle();
    expect(page.layoutSyncStatus()).toMatchObject({ authNeeded: false, waiting: {} });
    expect(server.requests.map((request) => Object.keys(request.nodes))).toEqual([
      ['u1'],
      ['u1'],
      ['c1'],
    ]);
    expect(stored('u1')).toMatchObject({ x: 1, rev: 1 });
    expect(stored('c1')).toMatchObject({ x: 2, rev: 1 });
  });
});

describe('a write the server refuses for good (400, 404)', () => {
  it('is dropped and said, and what follows is sent; a session that is gone is forgotten with what was kept for it', async () => {
    const page = await openPage();
    server.before = async (n) => {
      if (n === 1) throw new ApiError(400, 'bad_op', 'not valid');
    };
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    expect(page.layoutSyncStatus().notice).toContain('not valid');
    expect(page.layoutSyncStatus().waiting).toEqual({});
    page.moveNode('s1', 'c1', 2, 2);
    await settle();
    expect(stored('c1')).toMatchObject({ x: 2, rev: 1 });
    // a 404: the session is gone, so nothing more is kept or sent for it
    server.before = async () => {
      throw new ApiError(404, 'not_found', 'gone');
    };
    page.moveNode('s1', 'u1', 3, 3);
    page.moveNode('s1', 'c1', 4, 4);
    await settle();
    expect(page.layoutSyncStatus().notice).toContain('no longer exists');
    expect(page.layoutSyncStatus().failed).toBe(false);
    expect(page.layoutSyncStatus().waiting).toEqual({});
  });
});

describe('what arrives is compared by revision', () => {
  it("an older node (an event sent before the page's write was acknowledged) is ignored for its place", async () => {
    const page = await openPage();
    const local = node('u1', 0, 1, 1);
    page.reconcileNode('s1', node('u1', 0));
    page.moveNode('s1', 'u1', 50, 60);
    await settle(); // acknowledged: revision 1
    const stale = page.reconcileNode('s1', node('u1', 0, 9, 9), {
      ...local,
      position: { x: 50, y: 60 },
      pinned: true,
      layoutRev: 1,
    });
    expect(stale.position).toEqual({ x: 50, y: 60 });
    expect(stale.pinned).toBe(true);
  });

  it("a newer node wins over the page's unsent edit, and drops it", async () => {
    const page = await openPage();
    page.reconcileNode('s1', node('u1', 0));
    server.before = () => new Promise<void>(() => undefined); // never answered: the first write stays on its way
    page.moveNode('s1', 'c1', 1, 1);
    await settle();
    page.moveNode('s1', 'u1', 50, 60); // unsent: it waits behind the write on its way
    expect(page.layoutSyncStatus().waiting).toEqual({ s1: 2 });
    const shown = page.reconcileNode('s1', node('u1', 4, 700, 800));
    expect(shown.position).toEqual({ x: 700, y: 800 });
    expect(page.layoutSyncStatus().waiting).toEqual({ s1: 1 }); // only the write on its way is left
  });

  it("the same revision is shown with the page's own unsent edit laid over it", async () => {
    const page = await openPage();
    page.reconcileNode('s1', node('u1', 2, 1, 1));
    server.before = () => new Promise<void>(() => undefined);
    page.moveNode('s1', 'u1', 50, 60);
    await settle();
    const shown = page.reconcileNode('s1', node('u1', 2, 1, 1));
    expect(shown).toMatchObject({ position: { x: 50, y: 60 }, pinned: true });
  });

  it('an answer that arrives late never lowers the revision the page knows, and the newest place heard shows once its own edit stops covering the node', async () => {
    const page = await openPage();
    page.reconcileNode('s1', node('u1', 0));
    let release: () => void = () => undefined;
    server.before = () => new Promise<void>((resolve) => (release = resolve));
    page.moveNode('s1', 'u1', 100, 100); // on its way, against revision 0
    await settle();
    // another tab moved the node after that (revision 4); the page hears it before the answer comes
    const heard = page.reconcileNode('s1', node('u1', 4, 700, 800, true));
    expect(heard.position).toEqual({ x: 100, y: 100 }); // the page's own write still covers it
    release();
    await settle(); // acknowledged with revision 1: lower than what the page has heard
    expect(page.told.at(-1)?.change.nodes?.u1).toEqual({
      position: { x: 700, y: 800 },
      pinned: true,
      layoutRev: 4,
    });
    // the next write is made against revision 4, not 1
    server.before = async () => undefined;
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    expect(server.requests.at(-1)?.nodes.u1?.rev).toBe(4);
    // a refusal that is older than something heard does not bring an older place back
    expect(page.told.at(-1)?.change.nodes?.u1).toMatchObject({
      position: { x: 700, y: 800 },
      layoutRev: 4,
    });
  });

  it('a deleted session releases what the page kept for it', async () => {
    const page = await openPage();
    server.before = () => new Promise<void>(() => undefined);
    page.moveNode('s1', 'u1', 1, 1);
    await settle();
    expect(page.layoutSyncStatus().waiting).toEqual({ s1: 1 });
    page.forgetSession('s1');
    expect(page.layoutSyncStatus().waiting).toEqual({});
    // a session of that id seen again starts from nothing: the old revision does not hold the new one back
    expect(page.reconcileNode('s1', node('u1', 0, 9, 9)).position).toEqual({ x: 9, y: 9 });
  });

  it("a whole session is laid node by node; the open copy is kept where the server's is older", async () => {
    const page = await openPage();
    const fresh = {
      id: 's1',
      layout: { direction: 'TB' },
      nodes: tree([userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1)]),
    } as unknown as Session;
    const first = page.reconcileSession(fresh, null);
    expect(first.nodes.c1?.layoutRev).toBe(0);
    page.moveNode('s1', 'c1', 5, 5);
    await settle();
    const older = page.reconcileSession(fresh, {
      ...fresh,
      nodes: {
        ...fresh.nodes,
        c1: {
          ...(fresh.nodes.c1 as unknown as object),
          position: { x: 5, y: 5 },
          pinned: true,
          layoutRev: 1,
        },
      },
    } as unknown as Session);
    expect(older.nodes.c1).toMatchObject({ position: { x: 5, y: 5 }, pinned: true });
  });
});

describe('a page that is left with places not sent asks first', () => {
  it('prevents the unload while something is not acknowledged, and not otherwise', async () => {
    const page = await openPage();
    const event = { preventDefault: vi.fn(), returnValue: undefined as unknown };
    unloadHandler?.(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
    server.before = () => new Promise<void>(() => undefined);
    page.moveNode('s1', 'u1', 1, 1);
    unloadHandler?.(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.returnValue).toBe('');
  });
});
