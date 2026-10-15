import { seatsOf } from '../../../src/shared/flow.ts';
// The nodes of the map, on React Flow UI's parts (BaseNode, NodeStatusIndicator, PlaceholderNode). Two nodes per round that
// tell apart by shape and icon, never by colour (colour only marks state):
//   input   a pill with a person: what Omid wrote (a round sent without a comment: a pill with a loop, dashed)
//   answer  a squared card with a sigma: the chairman's answer, its title and how many members answered
//   ghost   the dashed placeholder of the input that comes next
// A running round has the travelling border, a stopped or failed one the error border.

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { Repeat2Icon, SigmaIcon, UserRoundIcon } from 'lucide-react';
import { type CSSProperties, createContext, useContext } from 'react';
import { BaseNode } from '@/components/flow/base-node';
import { type NodeStatus, NodeStatusIndicator } from '@/components/flow/node-status-indicator';
import { PlaceholderNode } from '@/components/flow/placeholder-node';
import { useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { LayoutDirection, SessionNode } from '../../../src/shared/types.ts';
import type { BranchLabel } from './branches.ts';
import { NODE_H, NODE_W } from './layout.ts';

export interface FlowData extends Record<string, unknown> {
  node: SessionNode | null;
  /** The ghost: `continue` under a round, `branch` beside the child it already has, `edit` beside an input being edited. */
  ghost?: { kind: 'continue' | 'branch' | 'edit'; round: number | null };
  lit: boolean;
  dim: boolean;
  direction: LayoutDirection;
  /** The tree grows from the right (a right-to-left interface). */
  mirror: boolean;
  /** 2, 3, … for every node of a branch that is not the first line of the tree (its name is «Branch 2»); `main` for the first line once there are branches. */
  branch: BranchLabel | null;
  /** For a round sent without a comment: the number of the round it is the critique of. */
  critiqueOf: number | null;
}

interface NodeActions {
  /** Puts the cursor where the next input is written (the ghost was pressed). */
  focusComposer: () => void;
}
const Actions = createContext<NodeActions>({ focusComposer: () => undefined });
export const NodeActionsProvider = Actions.Provider;

export const sourcePos = (direction: LayoutDirection, mirror: boolean): Position =>
  direction === 'TB' ? Position.Bottom : mirror ? Position.Left : Position.Right;
export const targetPos = (direction: LayoutDirection, mirror: boolean): Position =>
  direction === 'TB' ? Position.Top : mirror ? Position.Right : Position.Left;

const flat = (text: string) => text.replace(/\s+/gu, ' ').trim();

/** The mark at the node's top edge: «Edited». (The branch is named in the node's own kicker.) */
function Marks({ edited }: { edited: boolean }) {
  const { t } = useI18n();
  if (!edited) return null;
  return (
    <span className="absolute -top-2.5 end-4 z-10 flex gap-1">
      <span
        data-testid="edited-badge"
        className="rounded-full border bg-background px-1.5 text-[10px] leading-4 text-muted-foreground"
      >
        {t('map.edited')}
      </span>
    </span>
  );
}

/** «Branch 2», or «Main» for the first line of a conversation that has branches: the name of the branch a node is in, in its kicker. */
function BranchName({ branch }: { branch: BranchLabel | null }) {
  const { t, tx } = useI18n();
  if (!branch) return null;
  return (
    <span data-testid="branch-name" className="shrink-0 text-muted-foreground">
      {'· '}
      {branch === 'main' ? t('map.main') : tx('map.branch', { n: <bdi>{branch}</bdi> })}
    </span>
  );
}

function statusOf(node: SessionNode): { status: NodeStatus | undefined; word: string | null } {
  if (node.kind !== 'chair') return { status: undefined, word: null };
  switch (node.status) {
    case 'running':
      return { status: 'loading', word: 'running' };
    case 'failed':
      return { status: 'error', word: 'failed' };
    case 'cancelled':
    case 'interrupted':
      return { status: 'error', word: 'stopped' };
    default:
      return { status: undefined, word: null };
  }
}

export function FlowNode({ data, selected }: NodeProps<Node<FlowData>>) {
  const { node, lit, dim, direction, mirror, branch, critiqueOf, ghost } = data;
  const { t, tx } = useI18n();
  const actions = useContext(Actions);
  const size = { width: NODE_W, height: NODE_H };

  if (ghost) {
    return (
      <div style={size} data-ghost={ghost.kind} className="dv-node dv-node--ghost">
        <PlaceholderNode
          className="flex h-full w-full flex-col items-center justify-center gap-0.5 rounded-md"
          source={sourcePos(direction, mirror)}
          target={targetPos(direction, mirror)}
          onClick={actions.focusComposer}
        >
          <span className="text-xs font-medium">
            {ghost.kind === 'edit'
              ? t('map.ghostEdit')
              : ghost.kind === 'branch'
                ? t('map.ghostBranch', { n: ghost.round ?? 0 })
                : t('map.ghostContinue')}
          </span>
        </PlaceholderNode>
      </div>
    );
  }
  if (!node) return null;

  const { status, word } = statusOf(node);
  const wordText =
    word === 'running'
      ? t('seat.state.running')
      : word === 'failed'
        ? t('map.failed')
        : word === 'stopped'
          ? t('map.stopped')
          : null;
  const common = {
    'data-selected': selected || undefined,
    'data-lit': lit || undefined,
    'data-dim': dim || undefined,
    'data-status': node.kind === 'chair' ? node.status : undefined,
    'data-id': node.id,
  };

  if (node.kind === 'chair') {
    const answered = seatsOf(node).filter((seat) => seat.state === 'done').length;
    const title =
      node.status === 'running'
        ? t('map.working')
        : node.title ||
          (node.status === 'cancelled' || node.status === 'interrupted'
            ? t('map.stopped')
            : t('map.failed'));
    return (
      <NodeStatusIndicator status={status}>
        <BaseNode
          {...common}
          style={{ ...size, '--node-radius': 'var(--radius-md)' } as CSSProperties}
          className={cn(
            // off the lit path only the border and the background fade: the title and the kicker stay readable
            'dv-node dv-node--chair flex flex-col justify-center gap-1 rounded-md px-3 py-1.5 transition-colors data-dim:border-border/60 data-dim:bg-card/60',
            selected && 'bg-muted',
          )}
        >
          <Handle
            type="target"
            position={targetPos(direction, mirror)}
            isConnectable={false}
            className="opacity-0"
          />
          <span className="flex items-center gap-1.5 text-[11px] leading-4 text-muted-foreground">
            <SigmaIcon className="size-3.5 shrink-0" aria-hidden="true" />
            <span data-testid="node-round" className="font-medium text-foreground">
              {tx('map.round', { n: <bdi>{node.round}</bdi> })}
            </span>
            <BranchName branch={branch} />
            {node.status === 'done' ? (
              // every number is an isolate of its own: a right-to-left line must not reorder «3 of 4 · 70%»
              <span className="truncate">
                {seatsOf(node).length > 0
                  ? tx('map.answered', {
                      k: <bdi>{answered}</bdi>,
                      n: <bdi>{seatsOf(node).length}</bdi>,
                    })
                  : null}
                {node.recommendation ? (
                  <>
                    {seatsOf(node).length > 0 ? ' · ' : null}
                    <bdi>{Math.round(node.recommendation.confidence * 100)}%</bdi>
                  </>
                ) : null}
              </span>
            ) : wordText ? (
              <span className="truncate">{wordText}</span>
            ) : null}
          </span>
          <b
            dir="auto"
            className="dv-node__title line-clamp-2 text-[13px] leading-[1.2] font-semibold"
          >
            {title}
          </b>
          <Marks edited={false} />
          <Handle
            type="source"
            position={sourcePos(direction, mirror)}
            isConnectable={false}
            className="opacity-0"
          />
        </BaseNode>
      </NodeStatusIndicator>
    );
  }

  const isNext = node.kind === 'next';
  const text = isNext
    ? critiqueOf
      ? tx('map.critiqueOf', { n: <bdi>{critiqueOf}</bdi> })
      : t('map.critique')
    : flat(node.text) || flat(node.title);
  const edited = node.kind === 'user' && node.editedFrom !== undefined;
  return (
    <BaseNode
      {...common}
      style={{ ...size, '--node-radius': '9999px' } as CSSProperties}
      className={cn(
        'dv-node flex items-center gap-2 rounded-full bg-muted/50 px-3 transition-colors data-dim:border-border/60 data-dim:bg-muted/30',
        isNext ? 'dv-node--next border-dashed' : 'dv-node--user',
        selected && 'bg-muted',
      )}
    >
      <Handle
        type="target"
        position={targetPos(direction, mirror)}
        isConnectable={false}
        className="opacity-0"
      />
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground"
        aria-hidden="true"
      >
        {isNext ? <Repeat2Icon className="size-4" /> : <UserRoundIcon className="size-4" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex gap-1 text-[11px] leading-4 text-muted-foreground">
          {isNext ? t('map.critique') : t('map.you')}
          <BranchName branch={branch} />
        </span>
        <span dir="auto" className="dv-node__title line-clamp-2 text-xs leading-4">
          {text}
        </span>
      </span>
      <Marks edited={edited} />
      <Handle
        type="source"
        position={sourcePos(direction, mirror)}
        isConnectable={false}
        className="opacity-0"
      />
    </BaseNode>
  );
}
