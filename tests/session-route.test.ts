// The session page follows the address it is at: a typed address, Back and Forward select the round and the details the address
// names, so the page never shows another round than the one in the address bar. (The page rewrites its own address as the user
// selects; that is not an arrival and does not come through here.)

import { describe, expect, it } from 'vitest';

const MODULE = '../web/src/pages/session-route.ts';
interface Selection {
  selectedId: string | null;
  detail: string | null;
}
type RouteSelection = (
  session: { nodes: Record<string, { id: string; kind: string; createdAt: string }> },
  route: { node?: string; detail?: string },
  remembered: string | null,
) => Selection;

const session = {
  nodes: {
    u1: { id: 'u1', kind: 'user', createdAt: '2026-10-10T00:00:00Z' },
    c1: { id: 'c1', kind: 'chair', createdAt: '2026-10-10T00:01:00Z' },
    u2: { id: 'u2', kind: 'user', createdAt: '2026-10-10T00:02:00Z' },
    c2: { id: 'c2', kind: 'chair', createdAt: '2026-10-10T00:03:00Z' },
    c3: { id: 'c3', kind: 'chair', createdAt: '2026-10-10T00:04:00Z' },
  },
};

describe('the round and the details an address selects', async () => {
  const { routeSelection } = (await import(MODULE)) as { routeSelection: RouteSelection };

  it('the round the address names, and its details', () => {
    expect(routeSelection(session, { node: 'c2' }, null)).toEqual({
      selectedId: 'c2',
      detail: null,
    });
    expect(routeSelection(session, { node: 'c1', detail: 'cost' }, 'c3')).toEqual({
      selectedId: 'c1',
      detail: 'cost',
    });
    // an input node can be named too
    expect(routeSelection(session, { node: 'u2' }, null).selectedId).toBe('u2');
  });

  it('typed address, Back and Forward: every arrival selects the round it names, not the first one', () => {
    // the page was opened at round 1, the user went to round 3 (the page rewrote its address), then arrives at round 1 again,
    // then round 2, then Forward to round 3 with the details of the cost
    let shown = routeSelection(session, { node: 'c1' }, null);
    expect(shown.selectedId).toBe('c1');
    shown = routeSelection(session, { node: 'c2' }, 'c1');
    expect(shown.selectedId).toBe('c2');
    shown = routeSelection(session, { node: 'c3', detail: 'cost' }, 'c2');
    expect(shown).toEqual({ selectedId: 'c3', detail: 'cost' });
    // and back to an address with no details closes them
    shown = routeSelection(session, { node: 'c2' }, 'c3');
    expect(shown).toEqual({ selectedId: 'c2', detail: null });
  });

  it('an address with no round takes the one the sidebar remembers, else the newest', () => {
    expect(routeSelection(session, {}, 'c1').selectedId).toBe('c1');
    expect(routeSelection(session, {}, null).selectedId).toBe('c3');
    // a remembered or a named round that is not in the session is ignored
    expect(routeSelection(session, {}, 'gone').selectedId).toBe('c3');
    expect(routeSelection(session, { node: 'gone' }, 'c1').selectedId).toBe('c3');
  });

  it('a session with no round selects none', () => {
    expect(routeSelection({ nodes: { u1: session.nodes.u1 } }, { node: 'x' }, null)).toEqual({
      selectedId: null,
      detail: null,
    });
  });
});
