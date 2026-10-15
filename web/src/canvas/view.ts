// The geometry of the canvas view, without the canvas: the box that holds the nodes, and the smallest move of the view
// that shows a node and keeps it out from under the panels (toolbar, controls, minimap).

import { NODE_H, NODE_W } from './layout.ts';

/** The space kept between a node that must stay visible and a panel on the canvas (the minimap, the controls). */
const CLEARANCE = 12;

/** The smallest box that holds all the nodes. */
export function boundsOf(list: { x: number; y: number; width: number; height: number }[]) {
  const x = Math.min(...list.map((item) => item.x));
  const y = Math.min(...list.map((item) => item.y));
  return {
    x,
    y,
    width: Math.max(...list.map((item) => item.x + item.width)) - x,
    height: Math.max(...list.map((item) => item.y + item.height)) - y,
  };
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface View {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Moves the view the least that brings the node into the canvas, a margin inside its edges, and out from under every
 * panel. The zoom never changes. A node cannot be kept clear of a panel when there is nowhere else to go: it is then
 * left where it is.
 */
export function revealed(
  view: View,
  node: { x: number; y: number },
  size: { width: number; height: number },
  panels: Box[],
): View {
  const margin = 24;
  let { x, y } = view;
  const { zoom } = view;
  const width = NODE_W * zoom;
  const height = NODE_H * zoom;
  const inside = (start: number, extent: number, room: number): number =>
    start >= margin && start + extent <= room - margin
      ? 0
      : start < margin
        ? margin - start
        : room - margin - (start + extent);
  x += inside(node.x * zoom + x, width, size.width);
  y += inside(node.y * zoom + y, height, size.height);
  for (let pass = 0; pass < 4; pass += 1) {
    const left = node.x * zoom + x;
    const top = node.y * zoom + y;
    const hit = panels.find(
      (panel) =>
        left < panel.right + CLEARANCE &&
        left + width > panel.left - CLEARANCE &&
        top < panel.bottom + CLEARANCE &&
        top + height > panel.top - CLEARANCE,
    );
    if (!hit) break;
    // The four ways out of that panel; the shortest one that keeps the node inside the canvas wins.
    const ways = [
      { dx: hit.left - CLEARANCE - (left + width), dy: 0 },
      { dx: hit.right + CLEARANCE - left, dy: 0 },
      { dx: 0, dy: hit.top - CLEARANCE - (top + height) },
      { dx: 0, dy: hit.bottom + CLEARANCE - top },
    ]
      .filter(
        ({ dx, dy }) =>
          left + dx >= margin &&
          left + dx + width <= size.width - margin &&
          top + dy >= margin &&
          top + dy + height <= size.height - margin,
      )
      .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));
    const best = ways[0];
    if (!best) break;
    x += best.dx;
    y += best.dy;
  }
  return { x, y, zoom };
}
