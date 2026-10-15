// The tree layout: a node that is new is placed where it overlaps nothing (and next to its parent, also when the parent was
// dragged somewhere else), while pinned nodes never move.

import { describe, expect, it } from 'vitest';
import type { SessionNode } from '../src/shared/types.ts';
import { computeLayout, NODE_H, NODE_W } from '../web/src/canvas/layout.ts';
import { revealed } from '../web/src/canvas/view.ts';
import { chairNode, tree, userNode } from './fixtures.ts';

const at = (node: SessionNode, x: number, y: number, pinned = false): SessionNode => ({
  ...node,
  position: { x, y },
  pinned,
});

function overlaps(positions: Record<string, { x: number; y: number }>): string[] {
  const ids = Object.keys(positions);
  const bad: string[] = [];
  for (const [i, a] of ids.entries()) {
    for (const b of ids.slice(i + 1)) {
      const pa = positions[a] as { x: number; y: number };
      const pb = positions[b] as { x: number; y: number };
      if (Math.abs(pa.x - pb.x) < NODE_W && Math.abs(pa.y - pb.y) < NODE_H) bad.push(`${a}/${b}`);
    }
  }
  return bad;
}

describe('layout', () => {
  it('a round that grows from a dragged (pinned) node stays next to it, with the gap for the seat dots', () => {
    const first = layoutOf();
    // Omid dragged the second input far away and pinned it; a new round grows from the chairman node below it
    const nodes = tree([
      at(userNode('u0', null, 'Q'), first.u0.x, first.u0.y),
      at(chairNode('c1', 'u0', 1), first.c1.x, first.c1.y),
      at(userNode('u1', 'c1', 'a'), 700, 380, true),
      at(chairNode('c2', 'u1', 2), 700, 560),
      userNode('u2', 'c2', 'new'), // no position yet
      chairNode('c3', 'u2', 3), // no position yet
    ]);
    const out = computeLayout(nodes, 'TB', true);
    expect(out.u1).toEqual({ x: 700, y: 380 }); // a pinned node never moves
    expect(overlaps(out)).toEqual([]);
    // the new input sits below c2 and the new chairman node below it, the full gap apart (92 px of dots between)
    expect((out.u2 as { y: number }).y - (out.c2 as { y: number }).y).toBeGreaterThanOrEqual(
      NODE_H + 92 - 1,
    );
    expect((out.c3 as { y: number }).y - (out.u2 as { y: number }).y).toBeGreaterThanOrEqual(
      NODE_H + 92 - 1,
    );
    // and it follows the dragged node's column, not the place it would have had
    expect(Math.abs((out.u2 as { x: number }).x - (out.c2 as { x: number }).x)).toBeLessThan(
      NODE_W,
    );
  });

  it('what is stored for a node that was not pinned never decides where it sits (a stale or late save is ignored)', () => {
    // the QC tree: round 1, branch A and branch B under it, B three levels deep; the first input of B is edited, which adds
    // a sibling. The stored positions of the unpinned nodes are those of an older layout, all in one column.
    const stale = (node: SessionNode): SessionNode => at(node, 0, 54 * node.id.length);
    const list: SessionNode[] = [
      userNode('u0', null, 'Q'),
      chairNode('c1', 'u0', 1),
      userNode('a', 'c1', 'A'),
      chairNode('ca', 'a', 2),
      userNode('b', 'c1', 'B'),
      chairNode('cb', 'b', 2),
      userNode('b2', 'cb', 'B deeper'),
      chairNode('cb2', 'b2', 3),
      userNode('b3', 'cb2', 'B deepest'),
      chairNode('cb3', 'b3', 4),
      userNode('e', 'c1', 'B edited'),
      chairNode('ce', 'e', 2),
    ];
    const fresh = computeLayout(tree(list), 'TB', true);
    const withStale = computeLayout(tree(list.map(stale)), 'TB', true);
    expect(withStale).toEqual(fresh);
    expect(overlaps(withStale)).toEqual([]);
    // the three siblings sit side by side on one row
    const row = ['a', 'b', 'e'].map((id) => (withStale[id] as { y: number }).y);
    expect(new Set(row).size).toBe(1);
    const columns = ['a', 'b', 'e'].map((id) => (withStale[id] as { x: number }).x);
    expect(new Set(columns).size).toBe(3);
  });

  it('every direction leaves nothing overlapping, with many branches', () => {
    const list: SessionNode[] = [userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1)];
    for (let i = 0; i < 4; i += 1) {
      list.push(userNode(`u${i + 1}`, 'c1', `input ${i}`), chairNode(`k${i}`, `u${i + 1}`, 2));
    }
    for (const direction of ['TB', 'LR'] as const) {
      expect(overlaps(computeLayout(tree(list), direction, false)), direction).toEqual([]);
    }
  });
});

function layoutOf() {
  const out = computeLayout(
    tree([userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1), userNode('u1', 'c1', 'a')]),
    'TB',
    false,
  );
  return out as Record<'u0' | 'c1' | 'u1', { x: number; y: number }>;
}

describe('the view', () => {
  const size = { width: 800, height: 600 };
  const minimap = { left: 12, top: 12, right: 180, bottom: 124 };

  it('a node under the minimap is moved out from under it, with the zoom untouched', () => {
    const view = { x: 0, y: 0, zoom: 1 };
    const node = { x: 40, y: 30 }; // under the minimap (the first 12..180 by 12..124)
    const next = revealed(view, node, size, [minimap]);
    expect(next.zoom).toBe(1);
    const left = node.x * next.zoom + next.x;
    const top = node.y * next.zoom + next.y;
    const clear =
      left >= minimap.right ||
      left + NODE_W <= minimap.left ||
      top >= minimap.bottom ||
      top + NODE_H <= minimap.top;
    expect(clear).toBe(true);
    // inside the canvas
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left + NODE_W).toBeLessThanOrEqual(size.width);
    expect(top + NODE_H).toBeLessThanOrEqual(size.height);
  });

  it('a node cut off by the edge is brought in; one in view and clear of every panel does not move the view', () => {
    const still = { x: 0, y: 0, zoom: 1 };
    expect(revealed(still, { x: 400, y: 300 }, size, [minimap])).toEqual(still);
    const next = revealed({ x: 0, y: 0, zoom: 1 }, { x: 760, y: 590 }, size, []);
    expect(760 + next.x + NODE_W).toBeLessThanOrEqual(size.width);
    expect(590 + next.y + NODE_H).toBeLessThanOrEqual(size.height);
  });
});
