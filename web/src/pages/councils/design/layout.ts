// Where the boxes of a design sit. Automatic: a layered layout (dagre) of the drawn lines, top to bottom (the council is four
// members wide, which a sideways layout would squeeze). A box the user has dragged keeps the place stored in the design
// (`position`); these are design coordinates, kept in the design and never mixed with the session tree's layout. In a
// right-to-left interface the automatic places are mirrored, so the first agent of a row sits at the start, on the right.

import dagre from '@dagrejs/dagre';
import type { Flow } from '../../../../../src/shared/flow.ts';
import { type Place, visibleEdges } from './edit.ts';

export const AGENT_W = 192;
export const AGENT_H = 116;
export const AGY_AGENT_H = 180;
export const IO_W = 240;
export const IO_H = 56;
export const COND_W = 192;
export const COND_H = 128;

export const sizeOf = (kind: string, harness?: string): { width: number; height: number } =>
  kind === 'agent'
    ? { width: AGENT_W, height: harness === 'agy' ? AGY_AGENT_H : AGENT_H }
    : kind === 'condition'
      ? { width: COND_W, height: COND_H }
      : { width: IO_W, height: IO_H };

/** Where a box sits in its row among the targets of a condition: the Yes targets first, the No targets last, the rest between. */
function gateRank(flow: Flow, id: string): number {
  const gates = flow.edges.filter((edge) => edge.to === id && edge.gate).map((edge) => edge.gate);
  if (gates.length === 0 || (gates.includes('yes') && gates.includes('no'))) return 1;
  return gates.includes('yes') ? 0 : 2;
}

/** Top-left places of every box: the stored place of a dragged one, else the layout's. */
export function layoutFlow(flow: Flow, mirror: boolean): Record<string, Place> {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: 'TB', ranksep: 84, nodesep: 24, marginx: 0, marginy: 0 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of flow.nodes)
    graph.setNode(node.id, sizeOf(node.kind, node.kind === 'agent' ? node.harness : undefined));
  for (const edge of visibleEdges(flow)) graph.setEdge(edge.from, edge.to);
  dagre.layout(graph);
  const automatic: Record<string, Place> = {};
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  for (const node of flow.nodes) {
    const at = graph.node(node.id);
    const { width, height } = sizeOf(node.kind, node.kind === 'agent' ? node.harness : undefined);
    automatic[node.id] = { x: at.x - width / 2, y: at.y - height / 2 };
    left = Math.min(left, at.x - width / 2);
    right = Math.max(right, at.x + width / 2);
  }
  // the layout may turn a row around: the boxes of a row keep the design's own order (the first one at the start)
  const rows = new Map<number, string[]>();
  for (const node of flow.nodes) {
    // a row is a rank of the layout: its boxes share a middle line (a condition is taller than an agent)
    const y = Math.round(graph.node(node.id).y);
    rows.set(y, [...(rows.get(y) ?? []), node.id]);
  }
  for (const ids of rows.values()) {
    // the Yes line of a condition leaves from its start side, the No line from its end side: their targets sit that way round
    ids.sort((a, b) => gateRank(flow, a) - gateRank(flow, b));
    const slots = ids.map((id) => (automatic[id] as Place).x).sort((a, b) => a - b);
    ids.forEach((id, index) => {
      (automatic[id] as Place).x = slots[index] as number;
    });
  }
  const out: Record<string, Place> = {};
  for (const node of flow.nodes) {
    const { width } = sizeOf(node.kind);
    const place = automatic[node.id] as Place;
    out[node.id] = node.position ?? {
      x: Math.round(mirror ? left + right - (place.x + width) : place.x),
      y: Math.round(place.y),
    };
  }
  return out;
}

/** The smallest box that holds every box of the design (for framing). */
export function boundsOfPlaces(flow: Flow, places: Record<string, Place>) {
  const rects = flow.nodes.map((node) => {
    const at = places[node.id] as Place;
    return {
      x: at.x,
      y: at.y,
      ...sizeOf(node.kind, node.kind === 'agent' ? node.harness : undefined),
    };
  });
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rects.map((r) => r.x + r.width)) - x,
    height: Math.max(...rects.map((r) => r.y + r.height)) - y,
  };
}
