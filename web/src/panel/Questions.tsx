// The chairman's questions, as a strip pinned directly above the composer, so «what you do next» is always in view: one line
// while it is closed («The chairman asks 2 questions · answer»), and the one-at-a-time flow (shadcn Questionnaire: a progress
// count, Previous, Skip, Next and, on the last step, «Done») in a card INSIDE the panel when it is open: the card takes room from
// the answer's scroll area instead of covering it, so the answer stays on screen, scrollable and re-readable while it is answered.
// An answered question says so and shows its answer. After «Done» the strip closes to «✓ 1 answer ready · press Send» (and the
// Send button is lit): a closed strip never looks as if the answers had been sent. What is answered is kept by the session page
// (`answers`) and goes out with the comment as one structured input, sent from the composer, which says exactly what Send will
// send. Skip only moves on.

import { CheckIcon, ChevronUpIcon, MessageCircleQuestionIcon } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSkip,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from '@/components/ui/questionnaire';
import { useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import { textDirection } from '../../../src/shared/text.ts';

export function Questions({
  questions,
  answers,
  onAnswer,
  onDone,
  ready,
}: {
  questions: string[];
  /** One text per question, `''` when it was not answered. */
  answers: string[];
  onAnswer: (index: number, value: string) => void;
  /** The last step is done: the composer takes the cursor. */
  onDone: () => void;
  /** «Done» was pressed and nothing was changed since: the answers wait for Send. */
  ready: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const answered = (index: number) => (answers[index] ?? '').trim() !== '';
  const answeredCount = questions.filter((_question, index) => answered(index)).length;
  const items = questions.map((_question, index) => ({ name: `q${index}`, required: false }));
  const first = Math.max(
    0,
    questions.findIndex((_question, index) => !answered(index)),
  );
  const [current, setCurrent] = useState(first);
  // the answers are in and wait for Send
  const waiting = ready && answeredCount > 0 && !open;
  return (
    <section
      className="border-t bg-muted/30"
      aria-label={t('questions.title')}
      data-testid="questions"
      data-open={open || undefined}
      data-ready={waiting || undefined}
    >
      {open ? (
        <div
          className="mx-2 mt-2 flex max-h-[45vh] shrink-0 flex-col gap-3 overflow-y-auto rounded-lg border bg-background p-4"
          data-testid="questions-card"
        >
          <div className="flex flex-col gap-0.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('questions.title')}
            </h3>
            <p className="text-sm text-muted-foreground">{t('questions.hint')}</p>
          </div>
          <Questionnaire
            items={items}
            defaultItem={`q${first}`}
            onItemChange={(name) => setCurrent(Number(name.slice(1)))}
            onSubmit={(event) => {
              event.preventDefault();
              setOpen(false);
              onDone();
            }}
          >
            <div className="flex items-center gap-2">
              <QuestionnaireProgress data-testid="questions-progress">
                {t('questions.progress', { current: current + 1, total: questions.length })}
              </QuestionnaireProgress>
              {answered(current) ? (
                <Badge variant="secondary" data-testid="question-answered">
                  <CheckIcon />
                  {t('questions.answered')}
                </Badge>
              ) : null}
            </div>
            {questions.map((question, index) => (
              <QuestionnaireItem key={question} name={`q${index}`}>
                <QuestionnaireTitle
                  dir={textDirection(question) ?? undefined}
                  data-testid="question-title"
                >
                  {question}
                </QuestionnaireTitle>
                <QuestionnaireInput
                  aria-label={question}
                  data-testid={`answer-${index}`}
                  dir={textDirection(answers[index] ?? '') ?? undefined}
                  value={answers[index] ?? ''}
                  placeholder={t('questions.placeholder')}
                  onChange={(event) => onAnswer(index, event.target.value)}
                />
              </QuestionnaireItem>
            ))}
            <QuestionnaireActions>
              <QuestionnairePrevious>{t('questions.previous')}</QuestionnairePrevious>
              <QuestionnaireSkip>{t('questions.skip')}</QuestionnaireSkip>
              <QuestionnaireNext>{t('questions.next')}</QuestionnaireNext>
              <QuestionnaireSubmit data-testid="questions-done">
                {t('questions.done')}
              </QuestionnaireSubmit>
            </QuestionnaireActions>
          </Questionnaire>
        </div>
      ) : null}
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-2 text-start text-sm outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50"
        aria-expanded={open}
        data-testid="questions-toggle"
        onClick={() => {
          if (!open) setCurrent(first);
          setOpen((value) => !value);
        }}
      >
        <MessageCircleQuestionIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate" data-testid="questions-strip-text">
          {waiting ? (
            <span
              className="font-medium text-emerald-700 dark:text-emerald-400"
              data-testid="questions-ready"
            >
              {t('questions.ready', { count: answeredCount })}
            </span>
          ) : (
            <>
              {t('questions.strip', { count: questions.length })}
              {answeredCount > 0 ? (
                <span className="text-muted-foreground">
                  {' · '}
                  {t('questions.answeredOf', { k: answeredCount, n: questions.length })}
                </span>
              ) : null}
            </>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1 font-medium">
          {open ? t('questions.close') : waiting ? t('questions.change') : t('questions.answer')}
          <ChevronUpIcon className={cn('size-4 transition-transform', open && 'rotate-180')} />
        </span>
      </button>
    </section>
  );
}
