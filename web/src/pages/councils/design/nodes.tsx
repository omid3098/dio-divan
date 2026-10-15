// The boxes and lines of a design on the canvas. Shape and icon tell the kinds apart, colour only marks state (as on the session
// tree): Input and Output are grey pills, an agent is a card. The output form is a tag on the card's top edge, the effort is a
// four-step meter with its word, and tools, memory and web are three plain chips beside a lock (read-only is said once, in the
// inspector). Who wrote an answer is never drawn: a group of answers is one chip on the agent that waits for them.

import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
} from '@xyflow/react';
import {
  CheckIcon,
  FileTextIcon,
  FlagIcon,
  LockIcon,
  MessageSquareTextIcon,
  ShuffleIcon,
  SigmaIcon,
  SplitIcon,
  UserRoundIcon,
  XIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { BaseNode } from '@/components/flow/base-node';
import { HARNESS_LABEL } from '@/fa';
import { hasKey, type Key, useI18n } from '@/i18n/index.tsx';
import { useNotes } from '@/i18n/notes.tsx';
import { cn } from '@/lib/utils';
import type { FlowAgent, FlowCondition } from '../../../../../src/shared/flow.ts';
import { note } from '../../../../../src/shared/messages.ts';
import type { HarnessInfo, ReasoningLevel } from '../../../../../src/shared/types.ts';
import { AGENT_H, AGENT_W, AGY_AGENT_H, COND_H, COND_W, IO_H, IO_W } from './layout.ts';
import { effortStrength, INITIALS } from './names.ts';
import { RuleSummary } from './RuleText.tsx';

export interface DesignNodeData extends Record<string, unknown> {
  kind: 'input' | 'output' | 'agent' | 'condition';
  agent?: FlowAgent;
  /** A condition: its rules, and the name of the agent it reads (null: none yet). */
  condition?: { node: FlowCondition; source: string | null };
  /** The canvas is mirrored (a right-to-left interface): the exits of a condition swap sides so Yes stays at the start. */
  mirror: boolean;
  name: string;
  /** The response group of an agent (the least answers it waits for, of how many that are on). */
  group: { min: number; of: number } | null;
  info: HarnessInfo | undefined;
  /** The level this canvas shows (a level edits only effort, model and on/off), or null on Base. */
  level: ReasoningLevel | null;
  changed: boolean;
  off: boolean;
  problem: boolean;
  /** A council on Base has no effort of its own (each level sets it): the box does not show one. */
  hideEffort: boolean;
}

export type DesignNode = Node<DesignNodeData>;

const FORM_ICON = {
  report: FileTextIcon,
  member: MessageSquareTextIcon,
  answer: SigmaIcon,
} as const;

/** The little handle that a line is drawn from or to; small and quiet until the box is hovered or selected. */
const HANDLE =
  '!size-2 !border !border-muted-foreground !bg-background transition-opacity group-hover/box:!opacity-100';

function EffortMeter({ effort }: { effort: string }) {
  const strength = effortStrength(effort);
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" translate="no">
      <span className="flex items-end gap-px" aria-hidden="true">
        {[1, 2, 3, 4].map((step) => (
          <span
            key={step}
            style={{ height: 3 + step * 2 }}
            className={cn(
              'w-[3px] rounded-[1px]',
              step <= strength ? 'bg-foreground' : 'bg-border',
            )}
          />
        ))}
      </span>
      <bdi dir="ltr" className="font-mono">
        {effort || '—'}
      </bdi>
    </span>
  );
}

type Chip = 'on' | 'off' | 'closed';

function chipState(
  agent: FlowAgent,
  key: 'tools' | 'memory' | 'web',
  info: HarnessInfo | undefined,
): Chip {
  const mode = info?.[key].mode ?? 'free';
  if (mode === 'blocked' || (key === 'web' && agent.form === 'answer')) return 'closed';
  if (mode === 'forced-on' || agent[key]) return 'on';
  return 'off';
}

const CHIP_STYLE: Record<Chip, string> = {
  on: 'bg-muted font-medium text-foreground',
  off: 'border border-dashed text-muted-foreground',
  closed: 'border border-dashed text-muted-foreground/60',
};

export function AgentNode({ data, selected }: NodeProps<DesignNode>) {
  const { agent, name, group, info, level, changed, off, problem, hideEffort } = data;
  const { t, dir } = useI18n();
  const noted = useNotes();
  if (!agent) return null;
  const Icon = FORM_ICON[agent.form as 'report' | 'member' | 'answer'] ?? FORM_ICON.report;
  return (
    <div
      className="group/box relative"
      style={{ width: AGENT_W, height: agent.harness === 'agy' ? AGY_AGENT_H : AGENT_H }}
      data-testid="design-node"
      data-node-id={agent.id}
      data-form={agent.form}
      data-off={off || undefined}
      data-problem={problem || undefined}
    >
      {group ? (
        <span
          data-testid="group-chip"
          dir={dir}
          className="absolute -top-8 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          <ShuffleIcon className="size-3" aria-hidden="true" />
          {t('flow.group', { min: group.min, of: group.of })}
          {group.of < group.min ? ` · ${t('flow.shortage', { n: group.min - group.of })}` : ''}
        </span>
      ) : null}
      <span className="absolute -top-2.5 start-3 z-10 flex items-center gap-1 rounded-full border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground">
        <Icon className="size-3" aria-hidden="true" />
        {hasKey(`flow.form.${agent.form}`)
          ? t(`flow.form.${agent.form}` as Key)
          : (agent.formInfo?.name ?? agent.form)}
      </span>
      {off ? (
        <span
          data-testid="off-badge"
          className="absolute -top-2.5 end-3 z-10 rounded-full border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground"
        >
          {level
            ? t('flow.offAtLevel', { level: t(`level.${level}` as Key) })
            : t('flow.switchedOff')}
        </span>
      ) : null}
      <BaseNode
        className={cn(
          'flex h-full flex-col justify-between gap-1.5 px-3 pt-3.5 pb-3 text-start',
          off && 'border-dashed opacity-60',
          problem && 'border-amber-500/70 ring-2 ring-amber-500/25',
          selected && 'border-foreground/60 ring-2 ring-foreground/15',
        )}
      >
        <div className="flex items-center gap-2">
          <span
            className="grid size-6 shrink-0 place-items-center rounded border bg-muted font-mono text-[10px] font-semibold"
            translate="no"
          >
            {INITIALS[agent.harness] ?? '??'}
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="auto">
            {name}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            {changed ? (
              <span
                className="size-1.5 rounded-full bg-amber-500"
                title={t('flow.changedHere')}
                data-testid="changed-dot"
              />
            ) : null}
            {hideEffort ? null : <EffortMeter effort={agent.effort} />}
          </span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" dir="ltr" translate="no">
          {HARNESS_LABEL[agent.harness] ?? agent.harness} · {agent.model || '—'}
        </p>
        {agent.harness === 'agy' ? (
          <p
            className="text-[10px] leading-4"
            data-testid="agy-warning"
            title={noted.text(note('agy_controlled_note'))}
          >
            {noted.node(note('agy_warning'))}
          </p>
        ) : (
          <div className="flex items-center gap-1.5">
            <LockIcon
              className="size-3 shrink-0 text-muted-foreground"
              aria-label={t('flow.readOnly')}
            />
            {(['tools', 'memory', 'web'] as const).map((key) => {
              const state = chipState(agent, key, info);
              return (
                <span
                  key={key}
                  data-chip={key}
                  data-state={state}
                  className={cn('rounded px-1.5 text-[10px] leading-5', CHIP_STYLE[state])}
                >
                  {t(`ss.${key}`)}
                </span>
              );
            })}
          </div>
        )}
      </BaseNode>
      <Handle type="target" position={Position.Top} id="t" className={HANDLE} />
      <Handle type="source" position={Position.Bottom} id="s" className={HANDLE} />
      {/* the two handles a line that skips boxes goes round by: drawn into, never by hand */}
      <Handle
        type="source"
        position={Position.Right}
        id="rs"
        isConnectable={false}
        className="!opacity-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="rt"
        isConnectable={false}
        className="!opacity-0"
      />
    </div>
  );
}

export function IONode({ data, selected }: NodeProps<DesignNode>) {
  const { kind, name, problem } = data;
  const { t } = useI18n();
  const input = kind === 'input';
  const Icon = input ? UserRoundIcon : FlagIcon;
  return (
    <div
      className="group/box relative"
      style={{ width: IO_W, height: IO_H }}
      data-testid="design-node"
      data-kind={kind}
      data-problem={problem || undefined}
    >
      <span className="absolute -top-2.5 end-5 z-10 rounded-full border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground">
        {t(input ? 'flow.input.kind' : 'flow.output.kind')}
      </span>
      <div
        className={cn(
          'flex h-full items-center gap-3 rounded-full border bg-muted/60 ps-4 pe-5 hover:ring-1',
          problem && 'border-amber-500/70 ring-2 ring-amber-500/25',
          selected && 'border-foreground/60 ring-2 ring-foreground/15',
        )}
      >
        <span className="grid size-8 shrink-0 place-items-center rounded-full border bg-background">
          <Icon className="size-4" aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {t(input ? 'flow.input.sub' : 'flow.output.sub')}
          </span>
        </span>
      </div>
      {input ? (
        <>
          <Handle type="source" position={Position.Bottom} id="s" className={HANDLE} />
          {/* nothing can be sent to Input: this handle only lets a dropped line say so */}
          <Handle type="target" position={Position.Top} id="t" className="!opacity-0" />
        </>
      ) : (
        <>
          <Handle type="target" position={Position.Top} id="t" className={HANDLE} />
          <Handle type="source" position={Position.Bottom} id="s" className="!opacity-0" />
        </>
      )}
    </div>
  );
}

/**
 * A condition: where the design splits. It reads one agent, says its rule in words, and has two exits, Yes and No. The exits are
 * labelled cells along its lower edge with their dots beneath them; the label, not the side, says which is which, and in a
 * right-to-left interface the canvas is mirrored, so Yes sits at the start (the right) there as it does on the left in English.
 */
export function ConditionNode({ data, selected, id }: NodeProps<DesignNode>) {
  const { condition, name, problem, mirror, level } = data;
  const { t, dir } = useI18n();
  if (!condition) return null;
  const exits = (mirror ? ['no', 'yes'] : ['yes', 'no']) as ('yes' | 'no')[];
  return (
    <div
      className="group/box relative"
      style={{ width: COND_W, height: COND_H }}
      data-testid="design-node"
      data-kind="condition"
      data-node-id={id}
      data-problem={problem || undefined}
    >
      <span className="absolute -top-2.5 start-3 z-10 flex items-center gap-1 rounded-full border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground">
        <SplitIcon className="size-3" aria-hidden="true" />
        {t('flow.cond.kind')}
      </span>
      <BaseNode
        className={cn(
          'flex h-full flex-col overflow-hidden text-start',
          problem && 'border-amber-500/70 ring-2 ring-amber-500/25',
          selected && 'border-foreground/60 ring-2 ring-foreground/15',
        )}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-1 px-3 pt-3.5">
          <span className="truncate text-sm font-semibold" dir="auto">
            {name}
          </span>
          <p
            className="truncate text-start text-xs text-muted-foreground"
            dir={dir}
            data-testid="condition-reads"
          >
            {condition.source
              ? t('flow.cond.reads', { name: condition.source })
              : t('flow.cond.noInput')}
          </p>
          <div className="line-clamp-2 min-h-0 text-xs leading-4" data-testid="condition-rule">
            <RuleSummary node={condition.node} />
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-2 border-t text-[11px]" dir="ltr">
          {exits.map((exit, index) => (
            <span
              key={exit}
              data-exit={exit}
              dir={dir}
              title={t(exit === 'yes' ? 'flow.cond.yesTitle' : 'flow.cond.noTitle')}
              className={cn(
                'flex h-7 items-center justify-center gap-1 font-medium',
                index === 0 ? 'border-e' : '',
                level !== null && 'text-muted-foreground',
              )}
            >
              {exit === 'yes' ? (
                <CheckIcon className="size-3" aria-hidden="true" />
              ) : (
                <XIcon className="size-3" aria-hidden="true" />
              )}
              {t(exit === 'yes' ? 'flow.cond.yes' : 'flow.cond.no')}
            </span>
          ))}
        </div>
      </BaseNode>
      <Handle type="target" position={Position.Top} id="t" className={HANDLE} />
      {exits.map((exit, index) => (
        <Handle
          key={exit}
          type="source"
          position={Position.Bottom}
          id={exit}
          style={{ left: index === 0 ? '25%' : '75%' }}
          title={t(exit === 'yes' ? 'flow.cond.yesTitle' : 'flow.cond.noTitle')}
          className={HANDLE}
        />
      ))}
      {/* the two handles a line that skips boxes goes round by: drawn into, never by hand */}
      <Handle
        type="source"
        position={Position.Right}
        id="rs"
        isConnectable={false}
        className="!opacity-0"
      />
      <Handle
        type="target"
        position={Position.Right}
        id="rt"
        isConnectable={false}
        className="!opacity-0"
      />
    </div>
  );
}

export interface DesignEdgeData extends Record<string, unknown> {
  /** `required`: a draft the receiving agent must have; `group`: one answer of its response group; `plain` otherwise. */
  role: 'plain' | 'required' | 'group';
  /** The exit of a condition this line leaves from: a gate carries no answer, it only lets the next box run. */
  gate?: 'yes' | 'no';
  when?: 'yes' | 'no';
  /** The line carries only some of its source's fields. */
  fields?: { picked: number; total: number };
  /** Goes round the boxes between (it skips a level of the design), along this x of the canvas. */
  side: boolean;
  lane: number;
  /** The edge is about what is shown as a problem. */
  muted: boolean;
  problem?: boolean;
}

const LINE_STYLE = (
  selected: boolean,
  muted: boolean,
  role: DesignEdgeData['role'],
  gate: boolean,
  problem: boolean,
): CSSProperties => ({
  stroke: problem
    ? 'var(--color-amber-500)'
    : selected
      ? 'var(--foreground)'
      : 'var(--muted-foreground)',
  strokeWidth: selected ? 2 : gate ? 1.75 : 1.25,
  strokeOpacity: problem ? 0.9 : selected ? 0.8 : muted ? 0.3 : gate ? 0.8 : 0.55,
  // a gate is dotted (it carries no answer); a required draft is dashed
  strokeDasharray: gate ? '1.5 5' : role === 'required' ? '5 4' : undefined,
  strokeLinecap: gate ? 'round' : undefined,
});

/** The chips on a line say a sentence of the interface, so they run in the interface's direction (the canvas itself is left to right). */
const CHIP =
  'nodrag nopan pointer-events-none absolute flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground';

export function DesignEdge(props: EdgeProps<Edge<DesignEdgeData>>) {
  const { sourceX, sourceY, targetX, targetY, selected, data, markerEnd } = props;
  const { t, dir } = useI18n();
  const side = data?.side === true;
  // a line that goes round runs along its lane; its chip sits on the last stretch, beside the box it ends at
  const reach = Math.max(28, (data?.lane ?? 0) - Math.max(sourceX, targetX));
  const [path, bendX, bendY] = side
    ? getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition: Position.Right,
        targetX,
        targetY,
        targetPosition: Position.Right,
        borderRadius: 14,
        offset: reach,
      })
    : getSmoothStepPath({
        sourceX,
        sourceY,
        sourcePosition: Position.Bottom,
        targetX,
        targetY,
        targetPosition: Position.Top,
        borderRadius: 16,
      });
  const labelX = side ? (Math.max(sourceX, targetX) + reach + targetX) / 2 : bendX;
  const labelY = side ? targetY : bendY;
  const role = data?.role ?? 'plain';
  const gate = data?.gate;
  const at = (x: number, y: number) => ({
    transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
  });
  return (
    <>
      <BaseEdge
        path={path}
        {...(markerEnd ? { markerEnd } : {})}
        interactionWidth={22}
        style={LINE_STYLE(
          selected === true,
          data?.muted === true,
          role,
          gate !== undefined,
          data?.problem === true,
        )}
      />
      <EdgeLabelRenderer>
        {data?.when ? (
          <span
            data-testid="when-chip"
            data-exit={data.when}
            dir={dir}
            className={cn(CHIP, 'z-10 font-medium text-foreground')}
            style={side ? at(sourceX + 50, sourceY) : at(sourceX, sourceY + 26)}
          >
            {data.when === 'yes' ? (
              <CheckIcon className="size-3" aria-hidden="true" />
            ) : (
              <XIcon className="size-3" aria-hidden="true" />
            )}
            {t(data.when === 'yes' ? 'flow.edge.onlyYes' : 'flow.edge.onlyNo')}
          </span>
        ) : null}
        {gate ? (
          // a gate says which exit it leaves from, close to the condition (the line is long and may turn before it arrives)
          <span
            data-testid="gate-chip"
            data-gate={gate}
            dir={dir}
            className={cn(CHIP, 'z-10 font-medium text-foreground')}
            style={side ? at(sourceX + 30, sourceY) : at(sourceX, sourceY + 26)}
          >
            {gate === 'yes' ? (
              <CheckIcon className="size-3" aria-hidden="true" />
            ) : (
              <XIcon className="size-3" aria-hidden="true" />
            )}
            {t(gate === 'yes' ? 'flow.cond.yes' : 'flow.cond.no')}
          </span>
        ) : null}
        {role === 'required' && side ? (
          <span data-testid="required-chip" dir={dir} className={CHIP} style={at(labelX, labelY)}>
            {t('flow.required')}
          </span>
        ) : null}
        {data?.fields ? (
          <span
            data-testid="fields-chip"
            dir={dir}
            className={cn(CHIP, 'font-medium text-foreground')}
            style={at(labelX, role === 'required' && side ? labelY + 22 : labelY)}
          >
            {t('flow.edge.fieldCount', { n: data.fields.picked, total: data.fields.total })}
          </span>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

export const nodeTypes = { agent: AgentNode, io: IONode, condition: ConditionNode };
export const edgeTypes = { design: DesignEdge };
