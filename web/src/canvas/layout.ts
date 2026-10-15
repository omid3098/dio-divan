// Auto layout with dagre. The tree is laid out top-down (TB) or sideways (LR) and, in a right-to-left interface, mirrored across
// the vertical axis (Dio Docs RTL-12): the first branch sits at the start, on the right.
// Nodes Omid dragged (pinned) keep their place; a node placed automatically is pushed clear of them.

import dagre from '@dagrejs/dagre';
import type { LayoutDirection, Position, SessionNode } from '../../../src/shared/types.ts';

export const NODE_W = 232;
export const NODE_H = 72;
const GAP = 20;

const SPACING: Record<LayoutDirection, { rank: number; node: number }> = {
  // The seat dots live in the gap between a round's input and its chairman node, so the gap is wide.
  TB: { rank: 92, node: 44 },
  // Sideways the dots fan out vertically, so rows keep a little more room than their height and levels stay close.
  LR: { rank: 104, node: 40 },
};

/**
 * Top-left positions for every node. `keepPinned`: nodes with `pinned` keep their stored position. `mirror`: the tree grows
 * from the right (a right-to-left interface); otherwise from the left.
 */
export function computeLayout(
  nodes: Record<string, SessionNode>,
  direction: LayoutDirection,
  keepPinned: boolean,
  mirror = true,
): Record<string, Position> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({
    rankdir: direction,
    ranksep: SPACING[direction].rank,
    nodesep: SPACING[direction].node,
    marginx: 0,
    marginy: 0,
  });
  graph.setDefaultEdgeLabel(() => ({}));
  const ordered = Object.values(nodes).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const node of ordered) graph.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const node of ordered) {
    if (node.parentId && nodes[node.parentId]) graph.setEdge(node.parentId, node.id);
  }
  dagre.layout(graph);

  const out: Record<string, Position> = {};
  for (const node of ordered) {
    const placed = graph.node(node.id);
    // Mirrored: the centre x becomes -x, so earlier siblings come out on the right.
    out[node.id] = {
      x: Math.round((mirror ? -placed.x : placed.x) - NODE_W / 2),
      y: Math.round(placed.y - NODE_H / 2),
    };
  }

  if (keepPinned) {
    const dagrePlace = structuredClone(out);
    for (const node of ordered) if (node.pinned && node.position) out[node.id] = node.position;
    // A node that is not pinned follows its parent: it sits where the layout puts it relative to the parent, measured from
    // the parent's real place. So the round that grows from a node Omid dragged stays next to it, with the whole gap
    // between an input and its chairman node (where the seat dots are) kept, instead of landing on top of it.
    for (const node of ordered) {
      if ((node.pinned && node.position) || !node.parentId || !nodes[node.parentId]) continue;
      const parent = out[node.parentId] as Position;
      const wasParent = dagrePlace[node.parentId] as Position;
      const was = dagrePlace[node.id] as Position;
      out[node.id] = { x: parent.x + (was.x - wasParent.x), y: parent.y + (was.y - wasParent.y) };
    }
  }
  // Nodes must overlap nothing: push an automatically placed node away from whatever it touches, along the axis
  // with the smaller overlap. A pinned node never moves.
  const isFixed = (node: SessionNode) => keepPinned && node.pinned && node.position !== null;
  for (let pass = 0; pass < 24; pass += 1) {
    let moved = false;
    for (let i = 0; i < ordered.length; i += 1) {
      for (let j = i + 1; j < ordered.length; j += 1) {
        const a = ordered[i] as SessionNode;
        const b = ordered[j] as SessionNode;
        if (isFixed(a) && isFixed(b)) continue;
        const [mover, still] = isFixed(b) ? [a, b] : [b, a];
        const mine = out[mover.id] as Position;
        const other = out[still.id] as Position;
        const overlapX = NODE_W + GAP - Math.abs(mine.x - other.x);
        const overlapY = NODE_H + GAP - Math.abs(mine.y - other.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapY <= overlapX) mine.y += (mine.y >= other.y ? 1 : -1) * overlapY;
        else mine.x += (mine.x >= other.x ? 1 : -1) * overlapX;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return out;
}
