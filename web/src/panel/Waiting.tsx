import {
  agentIdentity,
  chairmanOf,
  finalAgent,
  isDirectAnswer,
  orderedAgents,
  seatsOf,
  stepOf,
} from '../../../src/shared/flow.ts';
// A round that is running: stages (members answer, the chairman writes, answer ready), the clock against the usual time,
// the members' live state (thinking, tokens so far, last sign of work) with «Stop waiting for this member», the note that it
// is safe to close the tab, what was sent, and the previous answer folded away. No member text is shown while waiting, so
// nobody anchors on a raw answer before the chairman has read them all.

import { CheckIcon, ChevronDownIcon, CircleDotIcon, CircleIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { skipSeat } from '@/actions';
import { branchLabelText, branchNames } from '@/canvas/branches';
import { Bidi } from '@/components/bidi';
import { Markdown } from '@/components/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { HARNESS_LABEL } from '@/fa';
import { useFormat } from '@/i18n/format';
import { translate, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import { useAppState } from '@/store';
import type { ChairNode, SeatRun, Session } from '../../../src/shared/types.ts';
import { stageOf } from './stage.ts';

/** A member that has shown no sign of work for this long is called out (the server stops it only after ten minutes). */
export const STALE_AFTER_S = 60;

/** The current time, ticking every second while `on`. */
export function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/** How long rounds take: the shortest and the longest of this session's own finished rounds, else what this PC has measured. */
export function typicalRange(
  session: Session,
  fallback: { min: number; max: number; count: number } | null,
): { min: number; max: number; count: number } | null {
  const own = Object.values(session.nodes).flatMap((node) =>
    node.kind === 'chair' && node.status === 'done' && node.endedAt
      ? [(new Date(node.endedAt).getTime() - new Date(node.startedAt).getTime()) / 1000]
      : [],
  );
  return own.length > 0
    ? { min: Math.min(...own), max: Math.max(...own), count: own.length }
    : fallback;
}

/** One stage of the round. Its label is never cut: it wraps, and a count goes on a second line. */
function StageBox({
  state,
  children,
  detail,
  testid,
}: {
  state: 'done' | 'live' | 'next';
  children: React.ReactNode;
  /** A second line (the count of members done). */
  detail?: React.ReactNode;
  testid: string;
}) {
  return (
    <li
      data-testid={testid}
      data-state={state}
      className={cn(
        'flex min-w-0 flex-1 items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        state === 'live' && 'border-ring bg-muted/50',
        state === 'next' && 'text-muted-foreground',
      )}
      aria-current={state === 'live' ? 'step' : undefined}
    >
      {state === 'done' ? (
        <CheckIcon className="mt-0.5 size-4 shrink-0" />
      ) : state === 'live' ? (
        <Spinner className="mt-0.5 size-4 shrink-0" aria-label={translate('status.running')} />
      ) : (
        <CircleIcon className="mt-0.5 size-4 shrink-0" />
      )}
      <span className="flex min-w-0 flex-col">
        <span className={cn(state === 'live' && 'shimmer')}>{children}</span>
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </span>
    </li>
  );
}

function MemberLive({
  chair,
  seat,
  name,
  now,
  sessionId,
  custom = false,
}: {
  chair: ChairNode;
  seat: SeatRun;
  /** The assistant's name: while waiting a member is its assistant, never a letter (the letters belong to the answers). */
  name: string;
  now: number;
  sessionId: string;
  custom?: boolean;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const [stopping, setStopping] = useState(false);
  const [asking, setAsking] = useState(false);
  const live = seat.state === 'running';
  // the chairman needs two valid answers: stopping this member must say so when fewer than two others could still answer
  const others = seatsOf(chair).filter(
    (other) =>
      other.label !== seat.label &&
      (other.state === 'done' || other.state === 'running' || other.state === 'pending'),
  ).length;
  const since = seat.lastSignalAt ?? seat.startedAt;
  const seconds = since ? Math.max(0, Math.round((now - new Date(since).getTime()) / 1000)) : null;
  // quiet until a minute has passed with no sign of work; then it says so, ticking, and the way out gets prominent
  const stale = live && seconds !== null && seconds >= STALE_AFTER_S;
  async function stop() {
    setAsking(false);
    setStopping(true);
    try {
      await skipSeat(sessionId, chair.id, seat.label);
    } catch {
      toast.add({ title: translate('waiting.stopFailed'), type: 'error' });
    } finally {
      setStopping(false);
    }
  }
  return (
    <li
      className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2"
      data-testid="member-live"
      data-state={seat.state}
      data-stale={stale || undefined}
    >
      <span className="flex min-w-0 flex-1 flex-col text-sm">
        <span className="flex flex-wrap items-center gap-x-1.5">
          {live || stopping ? (
            <Spinner className="size-3.5" aria-label={t('seat.state.running')} />
          ) : null}
          <span className="font-medium" translate="no" data-testid="member-name">
            {name}
          </span>
          <span className="text-muted-foreground">·</span>
          <span className={cn(live && !stopping && 'shimmer')}>
            {stopping
              ? t('waiting.stopping')
              : live
                ? t('waiting.thinking')
                : f.seatState(seat.state, seat.error)}
          </span>
        </span>
        {stale ? (
          <span
            className="text-xs font-medium text-amber-700 dark:text-amber-400"
            data-testid="member-stale"
            role="status"
          >
            {t('waiting.stale', { time: f.duration((seconds ?? 0) * 1000) })}
          </span>
        ) : live ? (
          <span className="text-xs text-muted-foreground" data-testid="member-signal">
            {seat.thinkingTokens
              ? `${t('waiting.tokens', { n: f.num(seat.thinkingTokens) })} · `
              : ''}
            {seconds !== null
              ? seat.lastSignalAt
                ? t('waiting.lastSignal', { s: seconds })
                : t('waiting.started', { s: seconds })
              : ''}
          </span>
        ) : null}
      </span>
      {live ? (
        <Button
          variant={stale ? 'default' : 'outline'}
          size="xs"
          data-testid="skip-member"
          disabled={stopping}
          onClick={() => (custom || others < 2 ? setAsking(true) : void stop())}
        >
          {t('waiting.skip')}
        </Button>
      ) : seat.state === 'done' && seat.startedAt && seat.endedAt ? (
        // the state is said once, by the word; the badge is the time it took
        <Badge variant="secondary" data-testid="member-time">
          {f.duration(new Date(seat.endedAt).getTime() - new Date(seat.startedAt).getTime())}
        </Badge>
      ) : null}
      <Dialog open={asking} onOpenChange={setAsking}>
        <DialogContent className="sm:max-w-sm" data-testid="skip-warning">
          <DialogHeader>
            <DialogTitle>{t('waiting.skipWarnTitle')}</DialogTitle>
            <DialogDescription>
              {custom ? t('flow.stopWarning') : t('waiting.skipWarn', { count: others })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>
              {t('waiting.skipKeep')}
            </Button>
            <Button variant="destructive" data-testid="skip-anyway" onClick={() => void stop()}>
              {t('waiting.skipAnyway')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function Waiting({ session, chair }: { session: Session; chair: ChairNode }) {
  const { t } = useI18n();
  const f = useFormat();
  const now = useNow(true);
  const byLevel = useAppState(
    (state) =>
      (session.settings.level
        ? state.meta?.typicalRoundRangeByLevel?.[session.settings.level]
        : null) ??
      state.meta?.typicalRoundRange ??
      null,
  );
  const typical = typicalRange(session, byLevel);
  const usual = f.typical(typical?.min ?? 0, typical?.max ?? 0, typical?.count ?? 0);
  const elapsed = now - new Date(chair.startedAt).getTime();
  const share = typical ? Math.min(100, (elapsed / 1000 / Math.max(1, usual.upper)) * 100) : null;
  const stage = stageOf(chair);
  const flow = session.settings.flow?.kind === 'custom' ? session.settings.flow : undefined;
  // «taking longer than usual» is about waiting for members: once the chairman has the round it says so no more
  const overdue = typical !== null && elapsed / 1000 > usual.upper && stage === 'members';
  const answered = seatsOf(chair).filter((seat) => seat.state === 'done').length;
  // the rows follow the council's own order, not the letters': the order of the letters would pair a letter with a name
  const rows = useMemo(() => {
    const order = (seatId: string) =>
      session.settings.seats.findIndex((seat) => seat.id === seatId);
    return seatsOf(chair).sort((a, b) => order(a.seatId) - order(b.seatId));
  }, [chair, session.settings.seats]);
  const nameOf = (seat: SeatRun) => {
    const base = HARNESS_LABEL[seat.harness] ?? seat.harness;
    if (flow) {
      const agent = flow.nodes.find((node) => node.id === seat.seatId);
      if (agent?.kind === 'agent')
        return `${t(`flow.role.${isDirectAnswer(agent) ? 'assistant' : agent.role}`)} ${agentIdentity(flow, agent.id).match(/\d+$/u)?.[0] ?? ''} · ${base} ${seat.model}`;
    }
    // two members of one assistant are told apart by their model
    return rows.filter((other) => other.harness === seat.harness).length > 1
      ? `${base} ${seat.model}`
      : base;
  };
  // once the conversation has branches the round says which one it is in
  const branch = useMemo(() => branchNames(session.nodes).get(chair.id), [session.nodes, chair.id]);
  const branchText = branch === undefined ? null : branchLabelText(branch, t);

  // what Omid sent for this round, and the round before it
  const input = chair.parentId ? session.nodes[chair.parentId] : undefined;
  const previous = input?.parentId ? session.nodes[input.parentId] : undefined;
  const sent = input && input.kind !== 'chair' ? input : null;

  return (
    <div className="flex flex-col gap-5" data-testid="waiting" aria-busy="true">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs tracking-wide text-muted-foreground uppercase">
          <span>
            {t('map.round', { n: chair.round })}
            {branchText ? ` · ${branchText}` : ''}
          </span>
          <Badge variant="secondary" data-testid="running-pill">
            <Spinner className="size-3" aria-label={t('status.running')} />
            {t('status.running')}
          </Badge>
        </div>
        <h2 className="text-lg font-semibold">{t('waiting.title')}</h2>
      </div>

      {flow ? (
        <ol
          className="flex flex-col gap-2"
          aria-label={t('flow.steps')}
          aria-live="polite"
          data-testid="flow-stages"
        >
          {orderedAgents(flow).map((agent) => {
            const run = stepOf(chair, agent.id)?.run;
            return (
              <StageBox
                key={agent.id}
                testid={`flow-stage-${agent.id}`}
                state={
                  run?.state === 'running' ? 'live' : run?.state === 'pending' ? 'next' : 'done'
                }
                detail={run ? f.seatState(run.state, run.error) : undefined}
              >
                {t(`flow.role.${isDirectAnswer(agent) ? 'assistant' : agent.role}`)}{' '}
                {agentIdentity(flow, agent.id).match(/\d+$/u)?.[0] ?? ''} · {agent.model}
              </StageBox>
            );
          })}
        </ol>
      ) : (
        <ol
          className="flex flex-col gap-2 sm:flex-row"
          aria-label={t('waiting.stages')}
          aria-live="polite"
        >
          <StageBox
            testid="stage-members"
            state={stage === 'members' ? 'live' : 'done'}
            detail={
              <span data-testid="answered-count">
                {t('waiting.stageMembersCount', { k: answered, n: seatsOf(chair).length })}
              </span>
            }
          >
            {t('waiting.stageMembers')}
          </StageBox>
          <StageBox
            testid="stage-chairman"
            state={stage === 'chairman' ? 'live' : stage === 'ready' ? 'done' : 'next'}
          >
            {t('waiting.stageChairman')}
          </StageBox>
          <StageBox testid="stage-ready" state={stage === 'ready' ? 'done' : 'next'}>
            {t('waiting.stageReady')}
          </StageBox>
        </ol>
      )}

      <div className="flex flex-col gap-2">
        <Progress value={share ?? 0} className="items-center gap-x-3 gap-y-2" data-testid="clock">
          <ProgressLabel>
            <span className="font-mono text-lg tabular-nums" dir="ltr" data-testid="elapsed">
              {f.clock(elapsed)}
            </span>
          </ProgressLabel>
          <ProgressValue className="ms-auto">
            {() =>
              typical
                ? overdue
                  ? t('waiting.overdue')
                  : t('waiting.usually', { time: usual.text })
                : t('waiting.unknown')
            }
          </ProgressValue>
        </Progress>
        <p className="sr-only" data-testid="typical-duration">
          {typical
            ? overdue
              ? t('waiting.overdue')
              : t('waiting.usually', { time: usual.text })
            : t('waiting.unknown')}
        </p>
        {overdue ? (
          <p className="text-sm text-muted-foreground">{t('waiting.overdueLong')}</p>
        ) : null}
      </div>

      <section className="flex flex-col" aria-label={t('waiting.members')}>
        <ul className="divide-y rounded-lg border px-3">
          {rows.map((seat) => (
            <MemberLive
              key={seat.label}
              chair={chair}
              seat={seat}
              name={nameOf(seat)}
              now={now}
              sessionId={session.id}
              custom={!!flow}
            />
          ))}
        </ul>
        {chairmanOf(chair).state === 'running' ? (
          <p className="mt-2 flex items-center gap-2 text-sm">
            <Spinner className="size-3.5" aria-label={t('seat.state.running')} />
            <span className="shimmer">
              {flow
                ? t(
                    `flow.role.${isDirectAnswer(finalAgent(flow)) ? 'assistant' : finalAgent(flow).role}`,
                  )
                : t('waiting.chairmanWriting')}
            </span>
          </p>
        ) : null}
      </section>

      <p
        className="flex items-start gap-2 rounded-lg border bg-muted/40 p-3 text-sm text-muted-foreground"
        data-testid="leave-note"
      >
        <CircleDotIcon className="mt-0.5 size-4 shrink-0" />
        {t('waiting.leave')}
      </p>

      {sent ? (
        <section className="flex flex-col gap-1.5 rounded-lg border p-3" data-testid="you-sent">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('waiting.youSent')}
          </h3>
          {sent.kind === 'next' ? (
            <p className="text-sm text-muted-foreground">{t('waiting.critiqueSent')}</p>
          ) : (
            <>
              {sent.answers?.map((pair) => (
                <p key={pair.question} className="text-sm">
                  <Bidi as="span" text={pair.question} className="text-muted-foreground" />{' '}
                  <Bidi as="b" text={pair.answer} />
                </p>
              ))}
              {sent.text ? (
                <Bidi as="p" text={sent.text} className="text-sm whitespace-pre-wrap" />
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {previous?.kind === 'chair' && previous.status === 'done' ? (
        <Collapsible data-testid="previous-answer">
          <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
            <span className="text-muted-foreground">
              {t('waiting.previous', { n: previous.round })}
            </span>
            <Bidi as="span" text={previous.title} className="min-w-0 flex-1 truncate font-medium" />
            <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pt-3">
            <Markdown text={previous.answer} answer />
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
