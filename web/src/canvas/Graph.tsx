// The tree on a React Flow canvas. Two nodes per round (see `nodes.tsx`): Omid's input and the chairman's answer, and a
// dashed ghost for the input that comes next. The view never frames the tree smaller than a readable zoom (0.85) by itself:
// a big tree is framed at the selected path (or the newest round) and the rest is reached by panning. The toolbar is one
// «⋯» menu (direction, arrange, and the overview minimap, which is off until asked for) beside the zoom controls.
//
// Where a node sits is decided here, from the tree, every time the tree changes: every node that Omid has not dragged is
// placed by a fresh layout of the whole tree. A stored position is used only for a node he pinned by dragging it, so a
// stale or late-saved position can never leave two branches on top of each other. The view is framed from those places
// (not from what the canvas has measured yet), clear of the toolbar, the controls and the minimap.

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ControlButton,
  Controls,
  type Edge,
  type EdgeProps,
  getViewportForBounds,
  MiniMap,
  type Node,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { MaximizeIcon, MoreHorizontalIcon } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/i18n/index.tsx';
import { useTheme } from '@/theme';
import { pathTo } from '../../../src/shared/context.ts';
import type {
  ChairNode,
  LayoutDirection,
  Position,
  Session,
  SessionNode,
} from '../../../src/shared/types.ts';
import { branchNames } from './branches.ts';
import { computeLayout, NODE_H, NODE_W } from './layout.ts';
import { type FlowData, FlowNode, NodeActionsProvider, sourcePos, targetPos } from './nodes.tsx';
import { type Box, boundsOf, revealed, type View } from './view.ts';

/** The smallest zoom a view is framed at on its own: text stays readable. A bigger tree is panned, not shrunk. */
export const READABLE_ZOOM = 0.85;
const PADDING = 0.15;
/** A press that moves the pointer less than this many pixels is a click (selects), not a drag (pins). */
const DRAG_THRESHOLD = 5;
/** The minimap: smaller than the library's default, so it hides less of a small canvas. */
const MAP_SIZE = { width: 168, height: 112 };
/** How far out the view can be zoomed by hand and by «fit the whole tree»; only automatic framing keeps READABLE_ZOOM. */
const MANUAL_MIN_ZOOM = 0.1;
const MINIMAP_KEY = 'divan-minimap';
/** The strip along the top of the canvas that the toolbar takes: nothing is framed under it. */
const TOOLBAR_STRIP = 56;
const GHOST_PREFIX = 'ghost:';
/** The controls take the theme's own surfaces (React Flow reads these variables from the style of the component). */
const CONTROLS_STYLE = {
  '--xy-controls-button-background-color-props': 'var(--card)',
  '--xy-controls-button-background-color-hover-props': 'var(--muted)',
  '--xy-controls-button-color-props': 'var(--foreground)',
  '--xy-controls-button-border-color-props': 'var(--border)',
} as CSSProperties;

/** The panels on the canvas (toolbar, controls, minimap) as boxes in the canvas's own pixels. */
function panelBoxes(holder: HTMLElement): Box[] {
  const origin = holder.getBoundingClientRect();
  return [...holder.querySelectorAll<HTMLElement>('.react-flow__panel')]
    .map((panel) => panel.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.left - origin.left,
      top: rect.top - origin.top,
      right: rect.right - origin.left,
      bottom: rect.bottom - origin.top,
    }));
}

/** A connection from a node to its child: a smooth curve, lit on the selected path and dim off it. */
function FlowEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  data,
}: EdgeProps<Edge<{ state: 'lit' | 'dim' | 'plain'; ghost?: boolean }>>) {
  const horizontal = Math.abs(targetX - sourceX) >= Math.abs(targetY - sourceY);
  const half = horizontal ? (sourceX + targetX) / 2 : (sourceY + targetY) / 2;
  const d = horizontal
    ? `M${sourceX},${sourceY} C${half},${sourceY} ${half},${targetY} ${targetX},${targetY}`
    : `M${sourceX},${sourceY} C${sourceX},${half} ${targetX},${half} ${targetX},${targetY}`;
  const state = data?.state ?? 'plain';
  return (
    <BaseEdge
      path={d}
      className={
        state === 'lit' ? 'dv-edge is-lit' : state === 'dim' ? 'dv-edge is-dim' : 'dv-edge'
      }
      style={{
        stroke: state === 'lit' ? 'var(--foreground)' : 'var(--muted-foreground)',
        strokeWidth: state === 'lit' ? 1.75 : 1.25,
        strokeOpacity: state === 'dim' ? 0.3 : state === 'lit' ? 0.55 : 0.5,
        strokeDasharray: data?.ghost ? '4 4' : undefined,
      }}
    />
  );
}

const nodeTypes = { flow: FlowNode };
const edgeTypes = { flow: FlowEdge };

export interface Ghost {
  /** The node the ghost hangs from. */
  parentId: string;
  kind: 'continue' | 'branch' | 'edit';
  round: number | null;
}

export interface GraphProps {
  session: Session;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Positions after a drag (the dragged node becomes pinned). */
  onDragStop: (id: string, x: number, y: number) => void;
  onArrange: () => void;
  onDirection: (direction: LayoutDirection) => void;
  /** The input that comes next, drawn as a dashed placeholder; null when nothing can be continued from the selection. */
  ghost: Ghost | null;
  /** The ghost was pressed: the composer takes the cursor. */
  onFocusComposer: () => void;
  /** Changes whenever the canvas should be framed again (a round started, Arrange, a layout switch, the tab shown). */
  fitKey: string;
  disabled: boolean;
}

/** A node as the layout sees the ghost: an unpinned input that is newer than everything else. */
function ghostNode(ghost: Ghost): SessionNode {
  return {
    id: `${GHOST_PREFIX}${ghost.parentId}`,
    parentId: ghost.parentId,
    position: null,
    pinned: false,
    layoutRev: 0,
    createdAt: '9999-12-31T23:59:59.999Z',
    kind: 'user',
    text: '',
    title: '',
  };
}

function Canvas(props: GraphProps) {
  const { session, selectedId, ghost } = props;
  const { t, dir } = useI18n();
  const { dark } = useTheme();
  const mirror = dir === 'rtl';
  const flow = useReactFlow();
  const holder = useRef<HTMLDivElement>(null);
  const direction = session.layout.direction;
  const path = useMemo(
    () => new Set(selectedId ? pathTo(session.nodes, selectedId).map((node) => node.id) : []),
    [session.nodes, selectedId],
  );
  const branches = useMemo(() => branchNames(session.nodes), [session.nodes]);

  // Where every node sits: a fresh layout of the whole tree (the ghost included), pinned nodes at their stored places. Never
  // the stored place of a node that was not pinned: that is only a copy of an older layout.
  const all = useMemo(() => {
    if (!ghost) return session.nodes;
    const extra = ghostNode(ghost);
    return { ...session.nodes, [extra.id]: extra };
  }, [session.nodes, ghost]);
  const placed = useMemo(
    () => computeLayout(all, direction, true, mirror),
    [all, direction, mirror],
  );

  const built = useMemo(() => {
    const nodes: Node<FlowData>[] = Object.values(all).map((node) => {
      const isGhost = node.id.startsWith(GHOST_PREFIX);
      return {
        id: node.id,
        type: 'flow',
        position: placed[node.id] ?? { x: 0, y: 0 },
        data: {
          node: isGhost ? null : node,
          ...(isGhost && ghost ? { ghost: { kind: ghost.kind, round: ghost.round } } : {}),
          lit: path.has(node.id),
          dim: !isGhost && selectedId !== null && !path.has(node.id),
          direction,
          mirror,
          branch: branches.get(node.id) ?? null,
          // a round sent without a comment is the critique of the round it hangs from
          critiqueOf:
            node.kind === 'next' && node.parentId && all[node.parentId]?.kind === 'chair'
              ? (all[node.parentId] as ChairNode).round
              : null,
        },
        width: NODE_W,
        height: NODE_H,
        selected: node.id === selectedId,
        draggable: !isGhost,
        selectable: !isGhost,
      };
    });
    const edges: Edge[] = Object.values(all)
      .filter((node) => node.parentId)
      .map((node) => {
        const isGhost = node.id.startsWith(GHOST_PREFIX);
        const lit = path.has(node.id);
        return {
          id: `e-${node.parentId}-${node.id}`,
          source: node.parentId as string,
          target: node.id,
          type: 'flow',
          data: { state: lit ? 'lit' : selectedId !== null ? 'dim' : 'plain', ghost: isGhost },
          selectable: false,
          focusable: false,
        };
      });
    return { nodes, edges };
  }, [all, placed, direction, mirror, path, selectedId, branches, ghost]);

  // While a node is dragged its position lives here; otherwise the layout rules.
  const [dragged, setDragged] = useState<Record<string, { x: number; y: number }>>({});
  const nodes = useMemo(
    () =>
      built.nodes.map((node) =>
        dragged[node.id]
          ? { ...node, position: dragged[node.id] as { x: number; y: number } }
          : node,
      ),
    [built.nodes, dragged],
  );
  const onNodesChange = useCallback((changes: NodeChange<Node<FlowData>>[]) => {
    setDragged((current) => {
      const next = { ...current };
      for (const change of changes) {
        if (change.type === 'position' && change.position) next[change.id] = change.position;
      }
      return next;
    });
  }, []);

  // The latest tree, places and selection, for the framing code (which runs from timers and observers).
  const latest = useRef({
    session,
    selectedId,
    laid: placed as Record<string, Position>,
    placed: placed as Record<string, Position>,
  });
  latest.current = { session, selectedId, laid: placed, placed: { ...placed, ...dragged } };

  // The view the code last asked for. A pan or zoom that is still gliding is not the place to measure the next one from.
  const intended = useRef<{ view: View; at: number } | null>(null);
  const currentView = useCallback((): View => {
    const asked = intended.current;
    return asked && Date.now() - asked.at < 900 ? asked.view : flow.getViewport();
  }, [flow]);
  const goTo = useCallback(
    (view: View, duration: number) => {
      intended.current = { view, at: Date.now() };
      void flow.setViewport(view, duration > 0 ? { duration } : undefined);
    },
    [flow],
  );

  /** The node the view is about: the selected one, else the newest round. */
  const subject = useCallback((): string | null => {
    const { session: current, selectedId: chosen } = latest.current;
    if (chosen && current.nodes[chosen]) return chosen;
    const newest = Object.values(current.nodes)
      .filter((node) => node.kind === 'chair')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return newest?.id ?? null;
  }, []);

  /** The view that shows the whole tree if it stays readable, else its newest part; the toolbar's strip stays free. */
  const frame = useCallback(
    (duration: number) => {
      const box = holder.current;
      if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
      const { session: current, placed: places } = latest.current;
      const rect = (id: string) => {
        const at = places[id];
        return at ? { x: at.x, y: at.y, width: NODE_W, height: NODE_H } : null;
      };
      // the ghost counts: the input that comes next is part of what the view is about
      const every = Object.keys(places)
        .filter((id) => current.nodes[id] || id.startsWith(GHOST_PREFIX))
        .flatMap((id) => rect(id) ?? []);
      if (every.length === 0) return;
      const panels = panelBoxes(box);
      // The strip along the top that the toolbar takes: nothing is framed under it.
      const toolbar = box.querySelector<HTMLElement>('.dv-toolbar');
      // never less than a toolbar's worth, even when it has not been laid out yet (the very first frame)
      const top = Math.max(
        TOOLBAR_STRIP,
        toolbar ? toolbar.getBoundingClientRect().bottom - box.getBoundingClientRect().top + 16 : 0,
      );
      const width = box.clientWidth;
      const height = Math.max(120, box.clientHeight - top);
      const end = subject();
      // what the view is about: the end of the selected path and the input that comes next from it
      const focus = end
        ? [
            ...pathTo(current.nodes, end)
              .slice(-4)
              .flatMap((node) => rect(node.id) ?? []),
            ...[rect(`${GHOST_PREFIX}${end}`)].flatMap((box) => box ?? []),
          ]
        : [];
      const everything = boundsOf(every);
      const whole = getViewportForBounds(everything, width, height, 0.01, 1.1, PADDING);
      // Everything, if it stays readable. Else the end of the tree: along the direction the tree grows (down in a vertical
      // layout) only the newest part, but across it the tree's whole width, when that stays readable too, so no branch is
      // cropped at the side. Failing that, only the end of the tree, left to be panned from there.
      let framed = getViewportForBounds(everything, width, height, READABLE_ZOOM, 1.1, PADDING);
      if (whole.zoom < READABLE_ZOOM && focus.length > 0) {
        const newest = boundsOf(focus);
        const across =
          current.layout.direction === 'TB'
            ? { x: everything.x, y: newest.y, width: everything.width, height: newest.height }
            : { x: newest.x, y: everything.y, width: newest.width, height: everything.height };
        const wide = getViewportForBounds(across, width, height, 0.01, 1.1, PADDING);
        framed =
          wide.zoom >= READABLE_ZOOM
            ? wide
            : getViewportForBounds(newest, width, height, READABLE_ZOOM, 1.1, PADDING);
      }
      let view: View = { x: framed.x, y: framed.y + top, zoom: framed.zoom };
      // The node the view is about is never under a panel (the minimap used to cover the newest round).
      const at = end ? places[end] : undefined;
      if (at) {
        view = revealed(view, at, { width: box.clientWidth, height: box.clientHeight }, panels);
      }
      goTo(view, duration);
    },
    [goTo, subject],
  );

  // Frame again when asked to. The places are known from the tree, so nothing waits for the canvas to measure itself.
  const first = useRef(true);
  useEffect(() => {
    void props.fitKey;
    const timer = setTimeout(
      () => {
        frame(first.current ? 0 : 220);
        first.current = false;
      },
      first.current ? 30 : 20,
    );
    return () => clearTimeout(timer);
  }, [props.fitKey, frame]);

  // ... and when the canvas changes size (a window resize, the sidebar or the panel opening or closing).
  useEffect(() => {
    const box = holder.current;
    if (!box) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let size = `${box.clientWidth}x${box.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const now = `${box.clientWidth}x${box.clientHeight}`;
      if (now === size) return;
      size = now;
      clearTimeout(timer);
      timer = setTimeout(() => frame(0), 160);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [frame]);

  // A node selected from somewhere else (a button in the panel) is panned into view if it is cut off, and out from under the
  // minimap or the controls. The zoom is left alone: selecting a node never zooms the tree in or out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a change of the selection moves the view
  useEffect(() => {
    if (!selectedId) return;
    const box = holder.current;
    const at = latest.current.placed[selectedId];
    if (!box || !at || box.clientWidth === 0) return;
    const current = currentView();
    const next = revealed(
      current,
      at,
      { width: box.clientWidth, height: box.clientHeight },
      panelBoxes(box),
    );
    if (next.x !== current.x || next.y !== current.y) goTo(next, 200);
  }, [selectedId]);

  // The minimap: off until asked for (the map menu), for a tree of six nodes or more; the choice is kept for next time.
  const [mapOn, setMapOn] = useState(() => localStorage.getItem(MINIMAP_KEY) === 'on');
  const hasMap = Object.keys(session.nodes).length >= 6;
  const showMap = hasMap && mapOn;
  const toggleMap = (next: boolean) => {
    localStorage.setItem(MINIMAP_KEY, next ? 'on' : 'off');
    setMapOn(next);
  };
  // a minimap that comes back must not lie on the node that is selected
  // biome-ignore lint/correctness/useExhaustiveDependencies: only showing the map again moves the view
  useEffect(() => {
    if (!showMap) return;
    const timer = setTimeout(() => {
      const box = holder.current;
      const id = latest.current.selectedId;
      const at = id ? latest.current.placed[id] : undefined;
      if (!box || !at || box.clientWidth === 0) return;
      const current = currentView();
      const next = revealed(
        current,
        at,
        { width: box.clientWidth, height: box.clientHeight },
        panelBoxes(box),
      );
      if (next.x !== current.x || next.y !== current.y) goTo(next, 200);
    }, 30);
    return () => clearTimeout(timer);
  }, [showMap]);

  /**
   * The explicit «fit the whole tree»: EVERY node in the view, however far out that is (down to MANUAL_MIN_ZOOM), clear of
   * the toolbar and, when it is shown, of the minimap. The readable zoom is only for the framing the page does by itself.
   */
  const fitAll = useCallback(
    (duration: number) => {
      const box = holder.current;
      if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
      const { session: current, placed: places } = latest.current;
      const every = Object.keys(current.nodes).flatMap((id) => {
        const at = places[id];
        return at ? [{ x: at.x, y: at.y, width: NODE_W, height: NODE_H }] : [];
      });
      if (every.length === 0) return;
      const origin = box.getBoundingClientRect().top;
      const bottoms = ['.dv-toolbar', '.react-flow__minimap'].map(
        (selector) => box.querySelector(selector)?.getBoundingClientRect().bottom ?? origin,
      );
      const top = Math.max(TOOLBAR_STRIP, Math.max(...bottoms) - origin + 16);
      const framed = getViewportForBounds(
        boundsOf(every),
        box.clientWidth,
        Math.max(120, box.clientHeight - top),
        MANUAL_MIN_ZOOM,
        1.1,
        PADDING,
      );
      goTo({ x: framed.x, y: framed.y + top, zoom: framed.zoom }, duration);
    },
    [goTo],
  );

  return (
    <NodeActionsProvider value={{ focusComposer: props.onFocusComposer }}>
      <div className="dv-canvas h-full w-full" dir="ltr" ref={holder} data-testid="canvas">
        <ReactFlow
          nodes={nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={dark ? 'dark' : 'light'}
          onNodesChange={onNodesChange}
          onNodeClick={(_event, node) => {
            if (!node.id.startsWith(GHOST_PREFIX)) props.onSelect(node.id);
          }}
          onPaneClick={() => props.onSelect(null)}
          onNodeDragStop={(_event, node) => {
            setDragged((current) => {
              const { [node.id]: _gone, ...rest } = current;
              return rest;
            });
            // A press that did not move the node is not a drag: nothing is pinned.
            const was = latest.current.laid[node.id];
            if (
              was &&
              Math.abs(was.x - node.position.x) < 1 &&
              Math.abs(was.y - node.position.y) < 1
            )
              return;
            props.onDragStop(node.id, node.position.x, node.position.y);
          }}
          onMoveStart={(event) => {
            // a pan or zoom by hand: from now on the view is where the hand left it
            if (event) intended.current = null;
          }}
          nodeDragThreshold={DRAG_THRESHOLD}
          nodeClickDistance={DRAG_THRESHOLD}
          nodesConnectable={false}
          nodesFocusable
          edgesFocusable={false}
          elementsSelectable
          minZoom={MANUAL_MIN_ZOOM}
          maxZoom={1.6}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          selectionKeyCode={null}
          proOptions={{ hideAttribution: false }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          aria-label={t('map.label')}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls
            showInteractive={false}
            showFitView={false}
            position="bottom-left"
            style={CONTROLS_STYLE}
          >
            <ControlButton
              className="react-flow__controls-fitview"
              title={t('map.fit')}
              aria-label={t('map.fit')}
              data-testid="fit-all"
              onClick={() => fitAll(200)}
            >
              <MaximizeIcon />
            </ControlButton>
          </Controls>
          {showMap ? (
            <MiniMap
              className="dv-minimap"
              position="top-left"
              style={MAP_SIZE}
              pannable
              zoomable
              ariaLabel={t('map.overview')}
              nodeBorderRadius={4}
              nodeColor="var(--muted-foreground)"
              bgColor="var(--card)"
              maskStrokeColor="var(--border)"
              maskStrokeWidth={1}
              maskColor="color-mix(in oklch, var(--background) 70%, transparent)"
              onClick={(_event, position) => {
                // a click on the map brings that place of the tree to the middle of the view
                const box = holder.current;
                if (!box) return;
                const { zoom } = currentView();
                goTo(
                  {
                    zoom,
                    x: box.clientWidth / 2 - position.x * zoom,
                    y: box.clientHeight / 2 - position.y * zoom,
                  },
                  200,
                );
              }}
            />
          ) : null}
          <Panel
            position="top-right"
            className="dv-toolbar flex items-center gap-1.5"
            data-testid="map-toolbar"
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon-sm"
                    data-testid="map-menu"
                    aria-label={t('map.menu')}
                    title={t('map.menu')}
                  />
                }
              >
                <MoreHorizontalIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuRadioGroup
                  value={direction}
                  onValueChange={(value) => props.onDirection(value as LayoutDirection)}
                >
                  <DropdownMenuRadioItem
                    value="TB"
                    closeOnClick
                    data-testid="dir-TB"
                    disabled={props.disabled}
                    title={t('map.verticalHint')}
                  >
                    {t('map.vertical')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    value="LR"
                    closeOnClick
                    data-testid="dir-LR"
                    disabled={props.disabled}
                    title={t('map.horizontalHint')}
                  >
                    {t('map.horizontal')}
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuItem
                  data-testid="arrange"
                  disabled={props.disabled}
                  onClick={props.onArrange}
                >
                  {t('map.arrange')}
                </DropdownMenuItem>
                {hasMap ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuCheckboxItem
                      data-testid="minimap-toggle"
                      checked={showMap}
                      closeOnClick
                      onCheckedChange={toggleMap}
                    >
                      {t('map.overviewShort')}
                    </DropdownMenuCheckboxItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </Panel>
        </ReactFlow>
      </div>
    </NodeActionsProvider>
  );
}

export function Graph(props: GraphProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}

export { sourcePos, targetPos };
