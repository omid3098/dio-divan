// The composer at the foot of a round's panel (shadcn InputGroup): a comment, «Ask for critique» (the round without a
// comment) and «Send» (the answers to the chairman's questions plus the comment, as one structured input). Ctrl Enter sends.
// While a round runs it stays open for drafting (Send is replaced by «Stop round» on the round that is running). A message
// whose delivery is unclear is never sent again by itself.

import { GitBranchIcon, Repeat2Icon, SendIcon, SquareIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { startRound } from '@/actions';
import { ApiError } from '@/api';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { Kbd } from '@/components/ui/kbd';
import type { Submitted } from '@/drafts';
import { useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import { textDirection } from '../../../src/shared/text.ts';
import type { ChairNode, QuestionAnswer, Session } from '../../../src/shared/types.ts';

export function Composer({
  session,
  chair,
  running,
  hasChildren,
  comment,
  onComment,
  answers,
  sendReady,
  onStarted,
  onUnclear,
  previousRound,
  onSelectNode,
  onStop,
  focusSignal,
}: {
  session: Session;
  chair: ChairNode;
  /** A round is running somewhere in the session. */
  running: boolean;
  hasChildren: boolean;
  /** The draft, kept by the panel so «what members will see next» can show it. */
  comment: string;
  onComment: (value: string) => void;
  /** What was answered of the chairman's questions (only the answered ones). */
  answers: QuestionAnswer[];
  /** The answers were finished («Done») and wait for Send: the button is lit. */
  sendReady: boolean;
  /** A round began. `submitted`: what was sent with it, as it was when it was sent (null for a critique, which sends none of it). */
  onStarted: (chairId: string, submitted: Submitted | null) => void;
  /** The server did not answer: reload the session to see whether the round began. */
  onUnclear: () => void;
  previousRound: string | null;
  onSelectNode: (id: string) => void;
  /** This round is the one running: «Stop round» takes the place of Send. */
  onStop: () => void;
  /** Changes when something asks for the cursor (the ghost node, the N key, the end of the chairman's questions). */
  focusSignal: number;
}) {
  const { t } = useI18n();
  const [sending, setSending] = useState(false);
  const [needInput, setNeedInput] = useState(false);
  const [problem, setProblem] = useState<{ kind: 'error' | 'unclear'; message: string } | null>(
    null,
  );
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (focusSignal > 0) field.current?.focus();
  }, [focusSignal]);

  const thisRunning = chair.status === 'running';
  const canSend = chair.status === 'done' && !running && !sending;
  const hasInput = comment.trim() !== '' || answers.length > 0;
  // exactly what Send will send: the answers and the comment («2 answers + your comment»)
  const sends = [
    answers.length > 0 ? t('composer.sendsAnswers', { count: answers.length }) : null,
    comment.trim() !== '' ? t('composer.sendsComment') : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' + ');

  async function send(critique: boolean) {
    if (!canSend) return;
    if (!critique && !hasInput) {
      setNeedInput(true);
      field.current?.focus();
      return;
    }
    setSending(true);
    setProblem(null);
    setNeedInput(false);
    // what is sent is what is typed NOW: a later edit, while the request is in flight, is not part of it
    const submitted: Submitted | null = critique ? null : { comment, answers };
    try {
      const started = await startRound(session.id, chair.id, submitted);
      // only what was sent is used up (the page clears what still is exactly that); a critique sends neither the comment nor the
      // answers, so both stay
      onStarted(started.chairId, submitted);
    } catch (error) {
      if (error instanceof ApiError) {
        setProblem({ kind: 'error', message: error.message });
      } else {
        // No answer came back: the round may or may not have started. Look, but never send again by ourselves.
        setProblem({ kind: 'unclear', message: t('composer.unclear') });
        onUnclear();
      }
    } finally {
      setSending(false);
    }
  }

  // A round that did not finish cannot be continued from: say so, and offer the round before it.
  if (chair.status !== 'done' && !thisRunning) {
    return (
      <div className="flex flex-col gap-2 border-t p-3" data-testid="composer-closed">
        <p className="text-sm text-muted-foreground">
          {previousRound ? t('composer.closedPrev') : t('composer.closedNew')}
        </p>
        {previousRound ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              data-testid="continue-previous"
              onClick={() => onSelectNode(previousRound)}
            >
              {t('composer.continuePrev')}
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t bg-background p-3" data-testid="composer">
      {problem ? (
        <Alert variant={problem.kind === 'error' ? 'destructive' : 'default'}>
          <AlertDescription>{problem.message}</AlertDescription>
        </Alert>
      ) : null}
      {/* the box stays as it is while it is drafted in: only a disabled button dims itself */}
      <InputGroup className="has-disabled:bg-transparent has-disabled:opacity-100 dark:has-disabled:bg-input/30">
        <InputGroupTextarea
          id="composer-input"
          ref={field}
          data-testid="composer-input"
          rows={2}
          className="max-h-40 min-h-14 text-sm"
          dir={textDirection(comment) ?? undefined}
          value={comment}
          placeholder={t('composer.placeholder')}
          aria-label={t('composer.label')}
          onChange={(event) => {
            onComment(event.target.value);
            setNeedInput(false);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              !(event.ctrlKey || event.metaKey) ||
              event.nativeEvent.isComposing
            )
              return;
            event.preventDefault();
            if (!thisRunning) void send(false);
          }}
        />
        <InputGroupAddon align="block-end" className="flex-wrap">
          {thisRunning ? null : (
            <InputGroupButton
              variant="outline"
              size="sm"
              data-testid="critique"
              disabled={!canSend}
              onClick={() => void send(true)}
            >
              <Repeat2Icon />
              {t('composer.critique')}
            </InputGroupButton>
          )}
          <span className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
            {sends ? (
              <span className="text-foreground" data-testid="composer-sends">
                {t('composer.sends', { what: sends })}
              </span>
            ) : null}
          </span>
          {thisRunning ? (
            <InputGroupButton
              variant="destructive"
              size="sm"
              data-testid="cancel-round"
              onClick={onStop}
            >
              <SquareIcon />
              {t('composer.stop')}
            </InputGroupButton>
          ) : (
            <InputGroupButton
              variant="default"
              size="sm"
              data-testid="send"
              data-ready={sendReady && canSend ? 'true' : undefined}
              className={cn(
                sendReady &&
                  canSend &&
                  'ring-2 ring-primary/40 ring-offset-2 ring-offset-background',
              )}
              disabled={!canSend}
              onClick={() => void send(false)}
            >
              <SendIcon className="rtl:-scale-x-100" />
              {t('composer.send')}
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
      {needInput ? (
        <p className="text-sm text-destructive" role="alert" data-testid="need-input">
          {t('composer.needInput')}
        </p>
      ) : null}
      <p
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
        data-testid="composer-hint"
      >
        {thisRunning ? (
          t('composer.draftNow', { n: chair.round })
        ) : running ? (
          t('composer.runningElsewhere')
        ) : hasChildren ? (
          <>
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span>
              <Kbd dir="ltr">Ctrl Enter</Kbd> {t('composer.branchHint', { n: chair.round })}
            </span>
          </>
        ) : (
          <span>
            <Kbd dir="ltr">Ctrl Enter</Kbd> {t('composer.continueHint')}
          </span>
        )}
      </p>
    </div>
  );
}
