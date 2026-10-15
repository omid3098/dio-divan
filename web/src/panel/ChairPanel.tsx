import { compileCouncil, finalInputsReady, seatsOf } from '../../../src/shared/flow.ts';
// The panel of a round: the answer is the hero (the recommendation first, then the answer prose); members, claims, context,
// time and cost are a row of small chips that open the details drawer over the map, so the answer never moves. Where the
// council split is one folded row, the chairman's questions are asked one at a time, and the composer sits at the foot.

import {
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  GitBranchIcon,
  SquareIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { cancelRound, rerunRound, skipRest } from '@/actions';
import { branchLabelText, branchNames } from '@/canvas/branches';
import { Bidi, Pct } from '@/components/bidi';
import { copyText } from '@/components/copy-button';
import { Markdown } from '@/components/markdown';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { toast } from '@/components/ui/toast';
import type { Submitted } from '@/drafts';
import { useFormat } from '@/i18n/format';
import { type Key, useI18n } from '@/i18n/index.tsx';
import type { Detail } from '@/router';
import { chairSpend } from '@/spend';
import {
  answerWithRecommendation,
  withoutRestatedRecommendation,
} from '../../../src/shared/text.ts';
import type { ChairNode, QuestionAnswer, Session } from '../../../src/shared/types.ts';
import { Composer } from './Composer.tsx';
import { Questions } from './Questions.tsx';
import { Waiting } from './Waiting.tsx';

export function ChairPanel({
  session,
  chair,
  running,
  openDetail,
  onToggleDetail,
  onSeeMember,
  onStarted,
  answers,
  onAnswer,
  onSent,
  onUnclear,
  onSelectNode,
  onFocusComposer,
  comment,
  onComment,
  focusSignal,
}: {
  session: Session;
  chair: ChairNode;
  running: boolean;
  /** The tab of the details drawer that is open for this round, or null. */
  openDetail: Detail | null;
  onToggleDetail: (tab: Detail) => void;
  /** «See member C»: the drawer opens on that member. */
  onSeeMember: (label: string) => void;
  onStarted: (chairId: string) => void;
  /** The answers typed to the chairman's questions (kept by the session page: another node and back loses none). */
  answers: string[];
  onAnswer: (index: number, value: string) => void;
  /** The round was sent: what was sent (as it was when it was sent) is used up; anything typed since stays. */
  onSent: (chairId: string, submitted: Submitted, questions: string[]) => void;
  onUnclear: () => void;
  /** Moves the selection to another node (the parent round, after a cancelled one). */
  onSelectNode: (id: string) => void;
  /** Puts the cursor in the composer (the branch or the continuation starts there). */
  onFocusComposer: () => void;
  comment: string;
  onComment: (value: string) => void;
  focusSignal: number;
}) {
  const { t } = useI18n();
  const f = useFormat();
  const [copied, setCopied] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [doneSignal, setDoneSignal] = useState(0);
  // «Done» was pressed on the chairman's questions and nothing was changed since: the answers wait for Send
  const [ready, setReady] = useState(false);

  const isRunning = chair.status === 'running';
  const children = useMemo(
    () => Object.values(session.nodes).filter((node) => node.parentId === chair.id).length,
    [session.nodes, chair.id],
  );
  const answered = seatsOf(chair).filter((item) => item.state === 'done').length;
  const missing = seatsOf(chair).filter(
    (item) => item.state !== 'done' && item.state !== 'pending' && item.state !== 'running',
  );
  const spend = chairSpend(chair);
  const duration = chair.endedAt
    ? new Date(chair.endedAt).getTime() - new Date(chair.startedAt).getTime()
    : null;
  const claimCount = (status: string) =>
    chair.claims.filter((claim) => claim.status === status).length;
  // only what there is: «2 used · 1 open», never «0 rejected»
  // and the first part says what they are: «2 claims used · 1 rejected · 1 open»
  const claimsText = (
    [
      [claimCount('accepted'), 'chip.claimsUsed'],
      [claimCount('rejected'), 'chip.claimsRejected'],
      [claimCount('open'), 'chip.claimsOpen'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, key], index) =>
      index === 0 ? t(`${key}First` as Key, { count }) : t(key as Key, { n: count }),
    )
    .join(' · ');
  // the members that did not answer, said once in a muted line (not an alert): «written without member C (failed)»
  const withoutLine = missing.length
    ? t(chair.status === 'done' ? 'panel.without' : 'panel.noAnswerFrom', {
        count: missing.length,
        members: missing
          .map((item) => `${item.label} (${f.seatState(item.state, item.error).toLowerCase()})`)
          .join(', '),
      })
    : null;
  // once the conversation has branches every round says which one it is in: "Main" for the first line, "Branch 2" for the next
  const branch = useMemo(() => branchNames(session.nodes).get(chair.id), [session.nodes, chair.id]);
  const branchText = branch === undefined ? null : branchLabelText(branch, t);
  const title =
    chair.title ||
    (chair.status === 'cancelled' || chair.status === 'interrupted'
      ? t('panel.stoppedRound')
      : t('panel.failedRound'));
  // The round before this one: where a cancelled or failed round can be left to continue from.
  const parentInput = chair.parentId ? session.nodes[chair.parentId] : undefined;
  const previousRound = parentInput?.parentId ?? null;
  // a round sent without a comment is the critique of the round it hangs from
  const critiqueOf =
    parentInput?.kind === 'next' && previousRound && session.nodes[previousRound]?.kind === 'chair'
      ? (session.nodes[previousRound] as ChairNode).round
      : null;
  // the points the council split on: the claims that did not make it into the answer (one at least, since it did split)
  const splitPoints = Math.max(
    1,
    chair.claims.filter((claim) => claim.status !== 'accepted').length,
  );
  const rejectedFrom = [
    ...new Set(
      chair.claims.filter((claim) => claim.status === 'rejected').flatMap((claim) => claim.from),
    ),
  ].sort();

  // what was answered of the chairman's questions (only the answered ones go out)
  const questions = chair.status === 'done' ? chair.questionsForUser : [];
  const answeredPairs: QuestionAnswer[] = questions.flatMap((question, index) =>
    (answers[index] ?? '').trim() ? [{ question, answer: (answers[index] ?? '').trim() }] : [],
  );

  async function copyAnswer() {
    // the recommendation line first (with its confidence), then the answer: what an endpoint client gets
    const ok = await copyText(answerWithRecommendation(chair.answer, chair.recommendation));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }
  async function stop() {
    setStopping(false);
    try {
      await cancelRound(session.id, chair.id);
    } catch (error) {
      console.error(error);
    }
  }
  // «Stop waiting for the rest»: the members still working are left out and the chairman writes from those that answered
  async function stopWaitingForTheRest() {
    setStopping(false);
    try {
      await skipRest(session.id, chair.id);
    } catch {
      toast.add({ title: t('stop.restFailed'), type: 'error' });
    }
  }
  const {
    answers: answersIn,
    minimum,
    enough,
  } = finalInputsReady(session.settings.flow ?? compileCouncil(session.settings), chair);
  const waitingForInputs = seatsOf(chair).some((run) => ['pending', 'running'].includes(run.state));
  const salvage = enough && waitingForInputs;
  async function rerun() {
    try {
      await rerunRound(session.id, chair.id);
    } catch (error) {
      onUnclear();
      console.error(error);
    }
  }

  const chip = (tab: Detail, testid: string, content: React.ReactNode) => (
    <Button
      variant="outline"
      size="sm"
      data-testid={testid}
      aria-expanded={openDetail === tab}
      aria-controls="details-drawer"
      onClick={() => onToggleDetail(tab)}
    >
      {content}
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="chair-panel">
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="panel-body">
        {isRunning ? (
          <Waiting session={session} chair={chair} />
        ) : (
          <article className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2">
              <span
                className="text-xs tracking-wide text-muted-foreground uppercase"
                data-testid="kicker"
              >
                {chair.status === 'done'
                  ? critiqueOf
                    ? t('answer.kickerCritique', { n: chair.round, of: critiqueOf })
                    : t('answer.kicker', { n: chair.round })
                  : t('map.round', { n: chair.round })}
                {branchText ? <span data-testid="kicker-branch"> · {branchText}</span> : null}
              </span>
              {chair.status === 'done' ? (
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="branch-here"
                    onClick={onFocusComposer}
                  >
                    <GitBranchIcon />
                    {children > 0 ? t('answer.branchHere') : t('answer.continueHere')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="copy-answer"
                    onClick={() => void copyAnswer()}
                  >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? t('answer.copied') : t('answer.copy')}
                  </Button>
                </span>
              ) : null}
            </div>
            <Bidi
              as="h2"
              text={title}
              className="text-xl leading-snug font-semibold text-balance"
              data-testid="answer-title"
            />
            {chair.round > 1 && chair.direction.trim() ? (
              // what this round changed against the one before it
              <Bidi
                as="p"
                text={chair.direction}
                className="-mt-2 text-sm text-muted-foreground"
                data-testid="direction"
              />
            ) : null}

            <div className="flex flex-wrap gap-2" data-testid="chips">
              {seatsOf(chair).length > 0
                ? chip(
                    'council',
                    'chip-council',
                    <>
                      {missing.length > 0 ? (
                        <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />
                      ) : null}
                      <span data-testid="answered-count">
                        {t('chip.council', { k: answered, n: seatsOf(chair).length })}
                      </span>
                    </>,
                  )
                : null}
              {chair.claims.length > 0 ? chip('claims', 'chip-claims', claimsText) : null}
              {chip('context', 'chip-context', t('chip.context'))}
              {chip(
                'cost',
                'chip-cost',
                <>
                  {duration !== null ? <span>{f.duration(duration)}</span> : null}
                  {spend.total > 0 ? (
                    <span>
                      {duration !== null ? '· ' : ''}
                      {t('chip.tokens', { n: f.compactText(spend.total) })}
                    </span>
                  ) : null}
                  {duration === null && spend.total === 0 ? t('chip.cost') : null}
                </>,
              )}
            </div>

            {chair.status === 'failed' ||
            chair.status === 'interrupted' ||
            chair.status === 'cancelled' ? (
              <Alert variant="destructive" data-testid="round-failed">
                <TriangleAlertIcon />
                <AlertTitle>
                  {chair.status === 'interrupted'
                    ? t('panel.interrupted')
                    : chair.status === 'cancelled'
                      ? t('panel.cancelled')
                      : t('panel.failed')}
                </AlertTitle>
                <AlertDescription className="flex flex-col items-start gap-2">
                  {f.roundFailureLine(chair) ? <span>{f.roundFailureLine(chair)}</span> : null}
                  {f.roundHasDetail(chair) && chair.error !== f.roundFailureLine(chair) ? (
                    <span className="text-muted-foreground">{t('panel.technicalHint')}</span>
                  ) : null}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={running}
                    onClick={() => void rerun()}
                  >
                    {t('panel.rerun')}
                  </Button>
                </AlertDescription>
              </Alert>
            ) : null}

            {withoutLine && !(chair.status === 'done' && chair.recommendation) ? (
              <p className="text-sm text-muted-foreground" data-testid="missing-members">
                {withoutLine}
              </p>
            ) : null}

            {chair.status === 'done' ? (
              <>
                {chair.recommendation ? (
                  <section
                    className="flex flex-col gap-1.5 rounded-lg border bg-muted/40 p-4"
                    data-testid="recommendation"
                  >
                    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {t('answer.recommendation')}
                    </h3>
                    <Bidi
                      as="p"
                      text={chair.recommendation.choice}
                      className="text-base font-semibold"
                    />
                    <p className="text-sm text-muted-foreground" data-testid="agreement">
                      {t('answer.confidence')} <Pct value={chair.recommendation.confidence} />
                      {chair.agreement
                        ? ` · ${t('answer.agree', { k: chair.agreement.agree, n: chair.agreement.of })}`
                        : ''}
                      {withoutLine ? (
                        <span data-testid="missing-members"> · {withoutLine}</span>
                      ) : null}
                    </p>
                  </section>
                ) : null}

                <div data-testid="answer">
                  <Markdown
                    text={withoutRestatedRecommendation(chair.answer, chair.recommendation)}
                    answer
                    className="text-base leading-7"
                  />
                </div>

                {chair.dissent ? (
                  <Collapsible data-testid="split">
                    <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
                      <span className="flex-1 font-medium">
                        {t('split.titleCount', { count: splitPoints })}
                      </span>
                      <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="flex flex-col gap-2 px-3 pt-3 text-sm">
                      <Bidi as="p" text={chair.dissent} data-testid="dissent-text" />
                      <div className="flex flex-wrap gap-1.5">
                        {rejectedFrom.map((label) => (
                          <Button
                            key={label}
                            variant="outline"
                            size="xs"
                            onClick={() => onSeeMember(label)}
                          >
                            {t('split.see', { label })}
                          </Button>
                        ))}
                        <Button variant="ghost" size="xs" onClick={() => onToggleDetail('claims')}>
                          {t('split.claims')}
                        </Button>
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}
              </>
            ) : null}
          </article>
        )}
      </div>
      {questions.length > 0 ? (
        <Questions
          questions={questions}
          answers={answers}
          onAnswer={(index, value) => {
            setReady(false);
            onAnswer(index, value);
          }}
          onDone={() => {
            setReady(true);
            setDoneSignal((count) => count + 1);
          }}
          ready={ready}
        />
      ) : null}
      <Composer
        session={session}
        chair={chair}
        running={running}
        hasChildren={children > 0}
        comment={comment}
        onComment={onComment}
        answers={answeredPairs}
        sendReady={ready && answeredPairs.length > 0}
        onStarted={(chairId, submitted) => {
          if (submitted) onSent(chair.id, submitted, questions);
          onStarted(chairId);
        }}
        onUnclear={onUnclear}
        previousRound={previousRound}
        onSelectNode={onSelectNode}
        onStop={() => setStopping(true)}
        focusSignal={focusSignal + doneSignal}
      />
      <Dialog open={stopping} onOpenChange={setStopping}>
        <DialogContent
          className="sm:max-w-md"
          data-testid="stop-dialog"
          data-salvage={salvage || undefined}
        >
          <DialogHeader>
            <DialogTitle>{t('stop.title')}</DialogTitle>
            <DialogDescription data-testid="stop-text">
              {!waitingForInputs
                ? t('stop.textAnswer')
                : salvage
                  ? t('stop.textSalvage', { count: answersIn })
                  : t('stop.textTooFew', { count: answersIn, minimum })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:flex-wrap">
            <Button variant="outline" onClick={() => setStopping(false)}>
              {t('stop.keep')}
            </Button>
            <Button
              variant={salvage ? 'outline' : 'destructive'}
              className={salvage ? 'text-destructive' : undefined}
              data-testid="confirm-stop"
              onClick={() => void stop()}
            >
              <SquareIcon />
              {salvage ? t('stop.everything') : t('composer.stop')}
            </Button>
            {salvage ? (
              <Button
                data-testid="stop-rest"
                autoFocus
                onClick={() => void stopWaitingForTheRest()}
              >
                {t('stop.rest')}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
