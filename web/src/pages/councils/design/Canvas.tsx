// The canvas of a design: the boxes, the lines, the palette that adds an agent, the zoom, and the checks. On Base the design is
// edited here (move a box, draw a line from one box's lower dot to another's upper dot, select a line and delete it, or a box and
// delete it); at a level the canvas only shows the level (what each agent runs at, who is off) and nothing on it can be drawn.
// Where a box sits is a design coordinate (`position` in the design); until a box is dragged the layout decides.

import {
  Background,
  BackgroundVariant,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  getViewportForBounds,
  MarkerType,
  type NodeChange,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  AlertTriangleIcon,
  CheckIcon,
  LayoutGridIcon,
  MaximizeIcon,
  PlusIcon,
  SplitIcon,
  XIcon,
} from 'lucide-react';
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { NoteText } from '@/components/bidi';
import { Button } from '@/components/ui/button';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { agentsOf, type Flow } from '../../../../../src/shared/flow.ts';
import type { HarnessId, HarnessInfo, ReasoningLevel } from '../../../../../src/shared/types.ts';
import { sourceOf } from './condition.ts';
import {
  type ConnectionProblem,
  clearPlaces,
  connect,
  connectionProblem,
  depthsOf,
  disconnect,
  type EdgeRef,
  edgeKey,
  isAgent,
  isCondition,
  MAX_NODES,
  nodeOf,
  type Place,
  type Problem,
  removeNode,
  setPlaces,
  visibleEdges,
  wireRole,
} from './edit.ts';
import { boundsOfPlaces, layoutFlow, sizeOf } from './layout.ts';
import {
  type DesignEdgeData,
  type DesignNode,
  type DesignNodeData,
  edgeTypes,
  nodeTypes,
} from './nodes.tsx';

/** What is selected on the canvas: a box, or a line (by its two ends and, for a line of a condition, the exit it leaves from). */
export type Selection = { kind: 'node'; id: string } | ({ kind: 'edge' } & EdgeRef);

/** The most members a council has. */
export const MAX_MEMBERS = 8;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.2;
const PADDING = 0.12;
const DRAG_THRESHOLD = 5;
const CONTROLS_STYLE = {
  '--xy-controls-button-background-color-props': 'var(--card)',
  '--xy-controls-button-background-color-hover-props': 'var(--muted)',
  '--xy-controls-button-color-props': 'var(--foreground)',
  '--xy-controls-button-border-color-props': 'var(--border)',
} as CSSProperties;

const REFUSED: Record<ConnectionProblem, Key> = {
  self: 'flow.refused.self',
  missing: 'flow.refused.missing',
  'from-output': 'flow.refused.fromOutput',
  'to-input': 'flow.refused.toInput',
  duplicate: 'flow.refused.duplicate',
  'output-needs-answer': 'flow.refused.outputNeedsAnswer',
  'output-taken': 'flow.refused.outputTaken',
  'input-redundant': 'flow.refused.inputRedundant',
  'answer-feeds-agent': 'flow.refused.answerFeedsAgent',
  cycle: 'flow.refused.cycle',
  'gate-to-output': 'flow.refused.gateToOutput',
  'condition-needs-agent': 'flow.refused.conditionNeedsAgent',
  'condition-needs-fields': 'flow.refused.conditionNeedsFields',
  'condition-taken': 'flow.refused.conditionTaken',
};

export interface CanvasProps {
  flow: Flow;
  names: Record<string, string>;
  infos: Map<HarnessId, HarnessInfo>;
  /** The level shown, or null on Base (where the design is edited). */
  level: ReasoningLevel | null;
  /** The level's flow as it is derived, to mark what the user changed for this level. */
  derived: Flow | null;
  selection: Selection | null;
  onSelect: (next: Selection | null) => void;
  onChange: (next: Flow) => void;
  problem: Problem | null;
  /** The problem, worded; null when the design is valid. */
  problemText: string | null;
  /** Adds an agent (null: not now, for example while the standard prompts load). */
  onAdd: (() => void) | null;
  /** Adds a condition (null: a council has none: it becomes a design first). */
  onAddCondition: (() => void) | null;
  readOnly: boolean;
  /** Changes when the view should be framed again (a box added or removed, a level chosen). */
  fitKey: string;
  mirror: boolean;
  dark: boolean;
  /** What sits at the end of the verdict's row (the design's default level). */
  extra?: ReactNode;
  /**
   * A council, not a design: the boxes keep the automatic layout (no place is stored for a council), the palette adds a member
   * or a writer, and the row below the canvas says what drawing a line does instead of the design's verdict.
   */
  council: boolean;
  /** Whether a line can be drawn or deleted (not in Quick, which cannot become a design). */
  connectable: boolean;
  /** Whether a box can be deleted (a default member of a council cannot: it is switched off). */
  removable: (id: string) => boolean;
  /** A council on Base has no effort of its own: its boxes show none. */
  hideEffort: boolean;
  /** Adds a writer to a council (null: not now). */
  onAddWriter: (() => void) | null;
  /** A council has the most members it may have. */
  memberFull: boolean;
  /** The sentence in the row below the canvas for a council (null: none). */
  note: string | null;
}

function Inner(props: CanvasProps) {
  const { flow, level, selection, mirror, readOnly } = props;
  const { t } = useI18n();
  const rf = useReactFlow();
  const holder = useRef<HTMLDivElement>(null);
  const editable = level === null && !readOnly;
  /** A line can be drawn or deleted, and a box deleted. */
  const wired = editable && props.connectable;
  const [refused, setRefused] = useState<string | null>(null);

  const places = useMemo(() => layoutFlow(flow, mirror), [flow, mirror]);
  const [dragged, setDragged] = useState<Record<string, Place>>({});
  /** What the canvas measured of each box: handed back to it, or it forgets where the dots are every time the design changes. */
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const depth = useMemo(() => depthsOf(flow), [flow]);
  const trouble = useMemo(() => new Set(props.problem?.ids ?? []), [props.problem]);

  const built = useMemo(() => {
    // a line a problem is about: the checks of a line (its Yes or No, the fields it carries) name the two boxes it joins
    const reason = props.problem?.reason;
    const lineTrouble = (edge: Flow['edges'][number]): boolean =>
      (reason === 'cycle' &&
        !!edge.when &&
        trouble.has(edge.when.condition) &&
        trouble.has(edge.to)) ||
      ((reason === 'gate' || reason === 'fields' || reason === 'when') &&
        trouble.has(edge.from) &&
        trouble.has(edge.to) &&
        (reason === 'gate'
          ? isCondition(nodeOf(flow, edge.from))
          : reason === 'when'
            ? edge.when !== undefined
            : edge.fields !== undefined));
    const groupOf = (id: string) => {
      const agent = nodeOf(flow, id);
      if (!isAgent(agent) || !agent.responses) return null;
      const on = agent.responses.ids.filter((one) => {
        const other = nodeOf(flow, one);
        return isAgent(other) && other.enabled !== false;
      }).length;
      return { min: agent.responses.min, of: on };
    };
    const nodes: DesignNode[] = flow.nodes.map((node) => {
      const agent = isAgent(node) ? node : undefined;
      const condition = isCondition(node) ? node : undefined;
      const base = props.derived
        ? agentsOf(props.derived).find((item) => item.id === node.id)
        : undefined;
      const data: DesignNodeData = {
        kind: node.kind,
        ...(agent ? { agent } : {}),
        ...(condition
          ? {
              condition: {
                node: condition,
                source: props.names[sourceOf(flow, condition.id)?.id ?? ''] ?? null,
              },
            }
          : {}),
        mirror,
        name:
          agent || condition
            ? (props.names[node.id] ?? node.id)
            : t(node.kind === 'input' ? 'flow.input.name' : 'flow.output.name'),
        group: groupOf(node.id),
        info: agent ? props.infos.get(agent.harness) : undefined,
        level,
        changed:
          level !== null &&
          agent !== undefined &&
          base !== undefined &&
          (base.model !== agent.model ||
            base.effort !== agent.effort ||
            (base.enabled !== false) !== (agent.enabled !== false)),
        off: agent?.enabled === false,
        problem: trouble.has(node.id),
        hideEffort: props.hideEffort,
      };
      return {
        id: node.id,
        type: agent ? 'agent' : condition ? 'condition' : 'io',
        position: dragged[node.id] ?? (places[node.id] as Place),
        data,
        ...(measured[node.id] ? { measured: measured[node.id] } : {}),
        selected: selection?.kind === 'node' && selection.id === node.id,
        draggable: editable && !props.council,
        deletable:
          editable &&
          (condition !== undefined || (agent !== undefined && props.removable(node.id))),
      };
    });
    const edges: Edge<DesignEdgeData>[] = visibleEdges(flow).map((edge) => {
      const from = nodeOf(flow, edge.from);
      const to = nodeOf(flow, edge.to);
      const side = (depth[edge.to] ?? 0) - (depth[edge.from] ?? 0) > 1;
      // a line that skips a level goes round, clear of every box on its way
      const lane = side
        ? Math.max(
            ...flow.nodes
              .filter(
                (box) =>
                  (depth[box.id] ?? 0) >= (depth[edge.from] ?? 0) &&
                  (depth[box.id] ?? 0) <= (depth[edge.to] ?? 0),
              )
              .map(
                (box) => (dragged[box.id] ?? (places[box.id] as Place)).x + sizeOf(box.kind).width,
              ),
          ) + 28
        : 0;
      const role: DesignEdgeData['role'] =
        isAgent(from) && isAgent(to) && !edge.gate
          ? (wireRole(flow, edge.from, edge.to) ?? 'plain')
          : 'plain';
      const total = isAgent(from) ? Object.keys(from.schema?.properties ?? {}).length : 0;
      return {
        id: edgeKey(edge),
        source: edge.from,
        target: edge.to,
        type: 'design',
        sourceHandle: side ? 'rs' : (edge.gate ?? 's'),
        targetHandle: side ? 'rt' : 't',
        selected:
          selection?.kind === 'edge' &&
          selection.from === edge.from &&
          selection.to === edge.to &&
          selection.gate === edge.gate,
        deletable: wired,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: 'var(--muted-foreground)',
        },
        data: {
          role,
          side,
          lane,
          muted: false,
          ...(edge.gate ? { gate: edge.gate } : {}),
          ...(edge.when ? { when: edge.when.exit } : {}),
          ...(edge.fields && total > 0 ? { fields: { picked: edge.fields.length, total } } : {}),
          problem: lineTrouble(edge),
        },
      };
    });
    return { nodes, edges };
  }, [
    flow,
    places,
    dragged,
    measured,
    depth,
    selection,
    trouble,
    level,
    editable,
    wired,
    props.council,
    props.removable,
    props.hideEffort,
    props.derived,
    props.names,
    props.infos,
    props.problem,
    mirror,
    t,
  ]);

  // ----- framing -----
  const moved = useRef(false);
  /** The view the framing last asked for. */
  const intended = useRef<{ x: number; y: number; zoom: number } | null>(null);
  const sideLines = built.edges.some((edge) => edge.data?.side === true);
  const latest = useRef({ flow, places, laneRoom: { side: sideLines } });
  latest.current = { flow, places, laneRoom: { side: sideLines } };
  const frame = useCallback(
    (duration: number) => {
      const box = holder.current;
      if (!box || box.clientWidth === 0 || box.clientHeight === 0) return;
      const { flow: current, places: laid } = latest.current;
      // a line that goes round the boxes (and its chip) needs room at the side
      const rooms = Object.values(latest.current.laneRoom).some(Boolean) ? 88 : 0;
      const bounds = boundsOfPlaces(current, laid);
      const view = getViewportForBounds(
        { ...bounds, width: bounds.width + rooms },
        box.clientWidth,
        box.clientHeight,
        MIN_ZOOM,
        1,
        PADDING,
      );
      intended.current = view;
      void rf.setViewport(view, duration > 0 ? { duration } : undefined);
    },
    [rf],
  );
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of the key frames the design again
  useEffect(() => {
    moved.current = false;
    const timer = setTimeout(
      () => {
        frame(first.current ? 0 : 200);
        first.current = false;
      },
      first.current ? 30 : 20,
    );
    return () => clearTimeout(timer);
  }, [props.fitKey, frame]);
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
      timer = setTimeout(() => {
        if (!moved.current) frame(0);
      }, 160);
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [frame]);

  // a line that was refused is told once, and goes away by itself
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(() => setRefused(null), 8000);
    return () => clearTimeout(timer);
  }, [refused]);

  // ----- editing -----
  const onNodesChange = useCallback((changes: NodeChange<DesignNode>[]) => {
    setDragged((current) => {
      const next = { ...current };
      for (const change of changes) {
        if (change.type === 'position' && change.position) next[change.id] = change.position;
      }
      return next;
    });
    setMeasured((current) => {
      let next = current;
      for (const change of changes) {
        if (change.type !== 'dimensions' || !change.dimensions) continue;
        const { width, height } = change.dimensions;
        if (current[change.id]?.width === width && current[change.id]?.height === height) continue;
        next = { ...next, [change.id]: { width, height } };
      }
      return next;
    });
  }, []);

  const tell = (from: string, to: string, gate?: 'yes' | 'no') => {
    const why = connectionProblem(flow, from, to, gate);
    if (why) setRefused(t(REFUSED[why]));
    return why;
  };

  /** The exit of a condition a connection leaves from (a line drawn from any other dot has none). */
  const gateOf = (handle: string | null | undefined): 'yes' | 'no' | undefined =>
    handle === 'yes' || handle === 'no' ? handle : undefined;

  /** The first box a problem is about is selected and brought to the middle of the view; a problem of a line selects the line. */
  const show = (ids: string[]) => {
    const id = ids[0];
    const at = id ? places[id] : undefined;
    if (!id || !at) return;
    const reason = props.problem?.reason;
    const line =
      reason === 'gate' || reason === 'fields' || reason === 'when'
        ? flow.edges.find(
            (edge) =>
              edge.from === ids[0] &&
              edge.to === ids[1] &&
              (reason === 'fields' ? edge.fields !== undefined : true),
          )
        : undefined;
    props.onSelect(
      line
        ? { kind: 'edge', from: line.from, to: line.to, ...(line.gate ? { gate: line.gate } : {}) }
        : { kind: 'node', id },
    );
    const box = nodeOf(flow, id);
    const size = sizeOf(box?.kind ?? 'agent', box?.kind === 'agent' ? box.harness : undefined);
    void rf.setCenter(at.x + size.width / 2, at.y + size.height / 2, {
      zoom: Math.max(rf.getZoom(), 0.85),
      duration: 200,
    });
  };

  const onConnect = (connection: Connection) => {
    if (!wired || !connection.source || !connection.target) return;
    const gate = gateOf(connection.sourceHandle);
    if (tell(connection.source, connection.target, gate)) return;
    setRefused(null);
    props.onChange(connect(flow, connection.source, connection.target, gate));
    props.onSelect({
      kind: 'edge',
      from: connection.source,
      to: connection.target,
      ...(gate ? { gate } : {}),
    });
  };

  return (
    <div className="flex h-full w-full flex-col">
      <div className="dv-canvas min-h-0 flex-1" dir="ltr" ref={holder} data-testid="design-canvas">
        <ReactFlow
          nodes={built.nodes}
          edges={built.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={props.dark ? 'dark' : 'light'}
          onNodesChange={onNodesChange}
          onNodeClick={(_event, node) => props.onSelect({ kind: 'node', id: node.id })}
          onEdgeClick={(_event, edge) =>
            props.onSelect({
              kind: 'edge',
              from: edge.source,
              to: edge.target,
              ...(edge.data?.gate ? { gate: edge.data.gate } : {}),
            })
          }
          onPaneClick={() => props.onSelect(null)}
          onNodeDragStop={(_event, node) => {
            setDragged((current) => {
              const { [node.id]: _gone, ...rest } = current;
              return rest;
            });
            const was = places[node.id];
            // a press that did not move the box is a click, not a move
            if (
              !editable ||
              props.council ||
              (was &&
                Math.abs(was.x - node.position.x) < 1 &&
                Math.abs(was.y - node.position.y) < 1)
            )
              return;
            props.onChange(setPlaces(flow, { [node.id]: node.position }));
          }}
          onMoveEnd={(event, view) => {
            // a pan or zoom by hand (not the framing, and not a click that only touched the canvas): from now on the view is the person's
            const asked = intended.current;
            if (
              event &&
              asked &&
              (Math.abs(view.x - asked.x) > 2 ||
                Math.abs(view.y - asked.y) > 2 ||
                Math.abs(view.zoom - asked.zoom) > 0.005)
            )
              moved.current = true;
          }}
          nodesConnectable={wired}
          isValidConnection={(connection) =>
            wired &&
            connectionProblem(
              flow,
              connection.source,
              connection.target,
              gateOf(connection.sourceHandle),
            ) === null
          }
          onConnect={onConnect}
          onConnectEnd={(_event, state) => {
            // a line let go over a box it cannot join says why; one let go on empty canvas is just dropped
            if (!wired || state.isValid || !state.fromNode || !state.toNode) return;
            tell(state.fromNode.id, state.toNode.id, gateOf(state.fromHandle?.id));
          }}
          connectionRadius={24}
          onBeforeDelete={async ({ nodes: gone, edges: lines }) => {
            if (!editable) return false;
            let next = flow;
            const dead = new Set(gone.map((node) => node.id));
            for (const node of gone) next = removeNode(next, node.id);
            for (const line of lines)
              if (wired && !dead.has(line.source) && !dead.has(line.target))
                next = disconnect(
                  next,
                  line.source,
                  line.target,
                  (line.data as DesignEdgeData | undefined)?.gate,
                );
            if (next !== flow) {
              props.onChange(next);
              props.onSelect(null);
            }
            return false;
          }}
          deleteKeyCode={editable ? ['Backspace', 'Delete'] : null}
          nodeDragThreshold={DRAG_THRESHOLD}
          nodeClickDistance={DRAG_THRESHOLD}
          nodesFocusable
          edgesFocusable
          elementsSelectable
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          zoomOnDoubleClick={false}
          selectionKeyCode={null}
          proOptions={{ hideAttribution: false }}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          aria-label={t('flow.canvas')}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls
            orientation="horizontal"
            showInteractive={false}
            showFitView={false}
            position={mirror ? 'top-left' : 'top-right'}
            style={CONTROLS_STYLE}
          >
            <ControlButton
              title={t('flow.fit')}
              aria-label={t('flow.fit')}
              data-testid="design-fit"
              onClick={() => {
                moved.current = false;
                frame(200);
              }}
            >
              <MaximizeIcon />
            </ControlButton>
            {editable && !props.council ? (
              <ControlButton
                title={t('flow.arrange')}
                aria-label={t('flow.arrange')}
                data-testid="design-arrange"
                onClick={() => {
                  props.onChange(clearPlaces(flow));
                  moved.current = false;
                }}
              >
                <LayoutGridIcon />
              </ControlButton>
            ) : null}
          </Controls>
          {editable ? (
            <Panel
              position={mirror ? 'top-right' : 'top-left'}
              className="flex w-40 flex-col gap-1 rounded-lg border bg-card p-1.5 text-sm shadow-xs"
              data-testid="design-palette"
            >
              <span className="px-1.5 pt-0.5 pb-1 text-xs text-muted-foreground">
                {t('flow.palette')}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="justify-between"
                data-testid="palette-agent"
                disabled={
                  props.onAdd === null ||
                  (props.council ? props.memberFull : flow.nodes.length >= MAX_NODES)
                }
                title={
                  props.council
                    ? props.memberFull
                      ? t('flow.palette.fullMembers', { max: MAX_MEMBERS })
                      : t('councils.accessHint')
                    : flow.nodes.length >= MAX_NODES
                      ? t('flow.palette.full', { max: MAX_NODES })
                      : undefined
                }
                onClick={() => props.onAdd?.()}
              >
                {t(props.council ? 'flow.palette.member' : 'flow.palette.agent')}
                <PlusIcon />
              </Button>
              {props.council ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="justify-between"
                  data-testid="palette-writer"
                  disabled={
                    props.onAddWriter === null ||
                    !props.connectable ||
                    flow.nodes.length >= MAX_NODES
                  }
                  title={t('flow.palette.writerHint')}
                  onClick={() => props.onAddWriter?.()}
                >
                  {t('flow.palette.writer')}
                  <PlusIcon />
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="justify-between"
                data-testid="palette-condition"
                disabled={
                  props.onAddCondition === null || props.council || flow.nodes.length >= MAX_NODES
                }
                title={
                  props.council
                    ? t('flow.palette.conditionCouncil')
                    : flow.nodes.length >= MAX_NODES
                      ? t('flow.palette.full', { max: MAX_NODES })
                      : t('flow.palette.conditionHint')
                }
                onClick={() => props.onAddCondition?.()}
              >
                <span className="flex items-center gap-1.5">
                  <SplitIcon className="size-3.5" aria-hidden="true" />
                  {t('flow.palette.condition')}
                </span>
                <PlusIcon />
              </Button>
              {(['input', 'output'] as const).map((kind) => (
                <span
                  key={kind}
                  className="flex h-7 items-center justify-between rounded-md px-2.5 text-[0.8rem] text-muted-foreground"
                  title={t('flow.palette.there')}
                  data-testid={`palette-${kind}`}
                >
                  {t(`flow.palette.${kind}`)}
                  <CheckIcon className="size-3.5" />
                </span>
              ))}
            </Panel>
          ) : null}
          {refused ? (
            <Panel position={mirror ? 'bottom-right' : 'bottom-left'} className="max-w-80">
              <div
                role="status"
                data-testid="design-refused"
                className="flex items-start gap-2 rounded-lg border bg-card p-2.5 text-xs shadow-xs"
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                <span className="flex-1">{refused}</span>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('flow.refused.dismiss')}
                  onClick={() => setRefused(null)}
                >
                  <XIcon />
                </Button>
              </div>
            </Panel>
          ) : null}
        </ReactFlow>
      </div>
      {/* the verdict has a row of its own, so nothing on the canvas lies under it and the view does not move when it changes */}
      <div
        className="flex h-12 shrink-0 items-center gap-3 border-t bg-background px-4"
        dir={mirror ? 'rtl' : 'ltr'}
        data-testid="design-status"
      >
        {props.council ? (
          <p
            data-testid="council-note"
            className="min-w-0 text-xs text-muted-foreground"
            title={props.note ?? undefined}
          >
            <span className="line-clamp-2">{props.note}</span>
          </p>
        ) : props.problemText ? (
          <div
            data-testid="design-problem"
            data-reason={props.problem?.reason}
            className="flex min-w-0 items-center gap-2"
          >
            <AlertTriangleIcon className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="line-clamp-2 min-w-0 text-xs" title={props.problemText}>
              <NoteText text={props.problemText} />
            </span>
            {props.problem && props.problem.ids.length > 0 ? (
              <Button
                variant="outline"
                size="xs"
                className="shrink-0"
                data-testid="design-problem-show"
                onClick={() => show(props.problem?.ids ?? [])}
              >
                {t('flow.problem.show')}
              </Button>
            ) : null}
          </div>
        ) : (
          <div data-testid="design-valid" className="flex items-center gap-1.5 text-xs font-medium">
            <CheckIcon className="size-3.5" />
            {t('flow.valid')}
          </div>
        )}
        {props.extra ? <div className="ms-auto shrink-0">{props.extra}</div> : null}
      </div>
    </div>
  );
}

export function DesignCanvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <Inner {...props} />
    </ReactFlowProvider>
  );
}
