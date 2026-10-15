// The panel of an input node: what was written, what the round it started received (one chip opens the Context tab), and the
// edit that becomes a sibling branch. The root question cannot be edited: «Ask again with changes» opens Home with it.

import { PencilIcon, Repeat2Icon, UserRoundIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { startRound } from '@/actions';
import { ApiError } from '@/api';
import { Bidi } from '@/components/bidi';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { useI18n } from '@/i18n/index.tsx';
import { navigate } from '@/leave-guard';
import type { Detail } from '@/router';
import { textDirection } from '../../../src/shared/text.ts';
import type { ChairNode, Session, UserNode } from '../../../src/shared/types.ts';

export function UserPanel({
  session,
  node,
  running,
  openDetail,
  onToggleDetail,
  onStarted,
  onUnclear,
  focusSignal,
}: {
  session: Session;
  node: UserNode;
  running: boolean;
  openDetail: Detail | null;
  onToggleDetail: (tab: Detail) => void;
  onStarted: (chairId: string) => void;
  onUnclear: () => void;
  focusSignal: number;
}) {
  const { t } = useI18n();
  const isRoot = node.id === session.rootId;
  const [text, setText] = useState(node.text);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusSignal > 0) field.current?.focus();
  }, [focusSignal]);
  const round = Object.values(session.nodes).find(
    (candidate): candidate is ChairNode =>
      candidate.kind === 'chair' && candidate.parentId === node.id,
  );
  const heading = isRoot
    ? t('user.root')
    : node.kind === 'next'
      ? t('user.critique')
      : t('user.yours');
  const original = node.editedFrom ? session.nodes[node.editedFrom] : undefined;

  async function edit() {
    if (!node.parentId || sending || running) return;
    setSending(true);
    setProblem(null);
    try {
      const started = await startRound(
        session.id,
        node.parentId,
        { ...(node.answers ? { answers: node.answers } : {}), comment: text },
        node.id,
      );
      onStarted(started.chairId);
    } catch (error) {
      if (error instanceof ApiError) setProblem(error.message);
      else {
        setProblem(t('user.unclear'));
        onUnclear();
      }
    } finally {
      setSending(false);
    }
  }

  function askAgain() {
    try {
      sessionStorage.setItem('divan-question', node.text);
      if (node.context) sessionStorage.setItem('divan-context', node.context);
      else sessionStorage.removeItem('divan-context');
    } catch {
      // storage that is off only loses the prefill
    }
    navigate('#/');
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="user-panel">
      <div
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4"
        data-testid="panel-body"
      >
        <div className="flex items-center gap-2 text-xs tracking-wide text-muted-foreground uppercase">
          <span className="flex size-6 items-center justify-center rounded-full border bg-muted">
            {node.kind === 'next' ? (
              <Repeat2Icon className="size-3.5" />
            ) : (
              <UserRoundIcon className="size-3.5" />
            )}
          </span>
          <span>{heading}</span>
          {node.editedFrom ? (
            <span className="rounded-full border px-1.5 normal-case" data-testid="edited-mark">
              {t('map.edited')}
              {original && original.kind !== 'chair' ? ` · ${t('user.fromOther')}` : ''}
            </span>
          ) : null}
        </div>

        {node.kind === 'next' ? (
          <p className="text-sm text-muted-foreground">{t('user.critiqueText')}</p>
        ) : (
          <>
            {node.answers && node.answers.length > 0 ? (
              <ul className="flex flex-col gap-2" data-testid="user-answers">
                {node.answers.map((pair) => (
                  <li
                    key={pair.question}
                    className="flex flex-col gap-0.5 rounded-lg border p-3 text-sm"
                  >
                    <Bidi as="span" text={pair.question} className="text-muted-foreground" />
                    <Bidi as="b" text={pair.answer} className="font-medium" />
                  </li>
                ))}
              </ul>
            ) : null}
            {node.text ? (
              <Bidi
                as="p"
                text={node.text}
                className="text-base leading-7 whitespace-pre-wrap"
                data-testid="user-text"
              />
            ) : null}
            {isRoot && node.context ? (
              <div className="flex flex-col gap-1 border-s-2 ps-3" data-testid="user-context">
                <span className="text-xs tracking-wide text-muted-foreground uppercase">
                  {t('user.context')}
                </span>
                <Bidi
                  as="p"
                  text={node.context}
                  className="text-sm leading-6 whitespace-pre-wrap text-muted-foreground"
                />
              </div>
            ) : null}
          </>
        )}

        {round ? (
          <div className="flex flex-col gap-2">
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-testid="chip-context"
              aria-expanded={openDetail === 'context'}
              onClick={() => onToggleDetail('context')}
            >
              {t('user.whatSaw')}
            </Button>
            <p className="text-sm text-muted-foreground">{t('user.pathNote')}</p>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 border-t bg-background p-3">
        {isRoot ? (
          <>
            <p className="text-sm text-muted-foreground">{t('user.rootLocked')}</p>
            <div>
              <Button size="sm" variant="outline" data-testid="ask-again" onClick={askAgain}>
                <PencilIcon />
                {t('home.askAgain')}
              </Button>
            </div>
          </>
        ) : (
          <>
            {problem ? (
              <Alert variant="destructive">
                <AlertDescription>{problem}</AlertDescription>
              </Alert>
            ) : null}
            <InputGroup>
              <InputGroupTextarea
                id="edit-input"
                data-testid="edit-input"
                ref={field}
                rows={2}
                className="max-h-40 min-h-14 text-sm"
                dir={textDirection(text) ?? undefined}
                value={text}
                disabled={running}
                aria-label={t('user.editLabel')}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === 'Enter' &&
                    (event.ctrlKey || event.metaKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    void edit();
                  }
                }}
              />
              <InputGroupAddon align="block-end">
                <span className="text-xs text-muted-foreground">{t('user.editCost')}</span>
                <InputGroupButton
                  variant="default"
                  size="sm"
                  className="ms-auto"
                  data-testid="edit-run"
                  disabled={running || sending}
                  onClick={() => void edit()}
                >
                  <PencilIcon />
                  {t('user.editRun')}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <p className="text-xs text-muted-foreground" data-testid="edit-hint">
              {t('user.editHint')}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
