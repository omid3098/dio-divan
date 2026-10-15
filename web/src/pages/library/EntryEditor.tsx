// The editor of one Library entry (the right-hand side of the page): its name and id, which models use it, its body (a prompt's text and
// what it is for; an output form's fields), and the explicit save: a bar that says what is unsaved, saves, discards, and handles a
// 409 (the entry changed somewhere else: load the other version, or keep yours and save over it). A built-in entry is shown
// read-only with «Duplicate». The page that holds it asks before it is left with something unsaved (the leave guard).

import { AlertTriangleIcon, CheckIcon, CopyIcon, RefreshCwIcon, Trash2Icon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Mono } from '@/components/bidi';
import { CopyButton } from '@/components/copy-button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { type LeaveTarget, setLeaveGuard } from '@/leave-guard';
import { isolate } from '@/lib/isolate';
import type { LibraryView } from '../../../../src/shared/library.ts';
import type { ProfileView } from '../../../../src/shared/types.ts';
import { ConfirmDialog, LeaveDialog } from '../councils/dialogs.tsx';
import {
  deleteEntry,
  type EntryView,
  type FormView,
  type Kind,
  type PromptView,
  problemText,
  refreshMeta,
  usersOf,
} from './api.ts';
import { InUseDialog } from './dialogs.tsx';
import { BuiltinForm, FormEditor } from './FormEditor.tsx';
import { fieldProblems, previewSchema } from './fields.ts';
import { idProblem, suggestEntryId } from './ids.ts';
import { entryName, modelsOf } from './labels.ts';
import { NewEntryDialog } from './NewEntryDialog.tsx';
import { MAX_PROMPT, PromptEditor } from './PromptEditor.tsx';
import { useEntryForm } from './use-entry-form.ts';
import type { FormValues, PromptValues, Values } from './values.ts';

export function EntryEditor({
  kind,
  entry,
  library,
  profiles,
  onLibrary,
  onGo,
}: {
  kind: Kind;
  /** The saved entry; null is a new one that has not been saved. */
  entry: EntryView | null;
  library: LibraryView;
  profiles: readonly ProfileView[];
  onLibrary: (next: LibraryView) => void;
  /** Goes to an address the person has already decided to go to (the leave guard is not asked again). */
  onGo: (hash: string) => void;
}) {
  const { t, lang } = useI18n();
  const builtin = entry?.builtin === true;
  const created = entry === null;
  const taken = (library[kind] as EntryView[]).map((item) => item.id);
  const [typedId, setTypedId] = useState<string | null>(null);
  /** The id a new entry will be saved under (read when it is saved). */
  const idNow = useRef('');

  const form = useEntryForm({
    kind,
    entry,
    draftId: () => idNow.current,
    onLibrary,
    onSaved: (id, wasCreated) => {
      if (wasCreated) onGo(`#/library/${kind}/${id}`);
    },
  });
  const { values, change, dirty, phase, problem, conflict } = form;
  const draftId =
    typedId ?? suggestEntryId(values.name, kind === 'prompts' ? 'prompt' : 'form', taken);
  idNow.current = draftId;
  const draftIdProblem = created ? idProblem(draftId, taken) : null;
  const readOnly = builtin || phase === 'saving';
  const [busy, setBusy] = useState<'leave' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'delete' | 'reload' | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const [inUse, setInUse] = useState<{ models: string[]; prompts: string[] } | null>(null);
  const [leaving, setLeaving] = useState<{ go: () => void; goal: string } | null>(null);
  const frozen = phase === 'saving' || busy !== null;

  /** Why the form cannot be saved as it is, in words, or null. */
  const blocker = ((): string | null => {
    if (builtin) return null;
    if (values.name.trim() === '' || values.name.length > 100) return t('library.blocker.name');
    if (created && draftIdProblem) return t('library.blocker.id');
    if (kind === 'prompts') {
      const text = (values as PromptValues).text;
      return text.trim() === '' || text.length > MAX_PROMPT ? t('library.blocker.prompt') : null;
    }
    const fields = (values as FormValues).fields;
    return fieldProblems(fields).some(Boolean) || !('schema' in previewSchema(fields))
      ? t('library.blocker.fields')
      : null;
  })();

  // the leave guard: a link, Back, Forward and «New» ask before the edits are lost
  const unsaved = useRef(false);
  unsaved.current = dirty || phase === 'saving' || phase === 'conflict';
  const asking = useRef((_go: () => void, _goal: string): void => undefined);
  asking.current = (go, goal) => {
    if (unsaved.current) setLeaving({ go, goal });
    else go();
  };
  const goalFor = useRef((_target: LeaveTarget, _hash?: string): string => '');
  goalFor.current = (target, hash) => {
    const id = /^#\/models\/([A-Za-z0-9_-]+)/u.exec(hash ?? '')?.[1];
    const model = profiles.find((item) => item.id === id);
    if (target === 'councils' && model) return t('councils.goal.openCouncil', { name: model.name });
    return t(`councils.goal.${target}` as Key);
  };
  useEffect(() => {
    setLeaveGuard({
      dirty: () => unsaved.current,
      ask: (proceed, target, goal, hash) =>
        asking.current(proceed, goal ?? goalFor.current(target, hash)),
    });
    return () => setLeaveGuard(null);
  }, []);

  /** Saves, then goes on: nothing goes on unless the latest form was acknowledged. */
  async function saveThen(go: () => void) {
    setBusy('leave');
    try {
      if (await form.save()) go();
    } finally {
      setBusy(null);
    }
  }

  const remove = useCallback(async () => {
    if (!entry) return;
    setConfirming(null);
    setBusy('delete');
    setError(null);
    try {
      onLibrary(await deleteEntry(kind, entry.id));
      void refreshMeta();
      onGo(`#/library/${kind}`);
    } catch (failure) {
      const users = usersOf(failure);
      if (users) setInUse(users);
      else setError(problemText(failure));
    } finally {
      setBusy(null);
    }
  }, [entry, kind, onGo, onLibrary]);

  const title = entry
    ? entryName(entry, kind, t)
    : t(kind === 'prompts' ? 'library.newPrompt' : 'library.newForm');
  const models = entry ? modelsOf(entry.usedBy, profiles, t) : [];
  const formPrompts =
    kind === 'forms' && entry ? library.prompts.filter((prompt) => prompt.form === entry.id) : [];

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="library-editor"
      data-entry-id={entry?.id ?? 'new'}
      data-builtin={builtin || undefined}
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6 sm:px-6">
          <header className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {builtin ? (
                <h2
                  className="min-w-0 flex-1 truncate text-lg font-semibold"
                  dir="auto"
                  data-testid="entry-title"
                >
                  {title}
                </h2>
              ) : (
                <Input
                  dir="auto"
                  className="h-9 min-w-0 flex-1 text-base font-semibold"
                  data-testid="entry-name"
                  aria-label={t('library.name')}
                  placeholder={t('library.namePlaceholder')}
                  maxLength={100}
                  disabled={frozen}
                  value={values.name}
                  onChange={(event) =>
                    change((now) => ({ ...now, name: event.target.value }) as Values)
                  }
                />
              )}
              {builtin ? (
                <Badge variant="secondary" data-testid="entry-builtin">
                  {t('library.builtinBadge')}
                </Badge>
              ) : null}
              {entry ? (
                <span className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="entry-duplicate"
                    disabled={frozen || dirty}
                    title={dirty ? t('library.saveFirst') : undefined}
                    onClick={() => setDuplicating(true)}
                  >
                    <CopyIcon />
                    {t('library.duplicate')}
                  </Button>
                  {builtin ? null : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      data-testid="entry-delete"
                      disabled={frozen}
                      onClick={() => setConfirming('delete')}
                    >
                      <Trash2Icon />
                      {t('common.delete')}
                    </Button>
                  )}
                </span>
              ) : null}
            </div>
            {entry ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                {t('library.id')} <Mono data-testid="entry-id">{entry.id}</Mono>
                <CopyButton text={entry.id} size="xs" />
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <label htmlFor="entry-id-input">{t('library.id')}</label>
                  <Input
                    id="entry-id-input"
                    dir="ltr"
                    className="h-7 w-56 font-mono text-xs"
                    data-testid="entry-id-input"
                    maxLength={48}
                    spellCheck={false}
                    aria-invalid={draftIdProblem !== null}
                    disabled={frozen}
                    value={draftId}
                    onChange={(event) => setTypedId(event.target.value.toLowerCase())}
                  />
                </div>
                <span className="text-xs text-muted-foreground">
                  {draftIdProblem === 'taken'
                    ? t('library.idTaken')
                    : draftIdProblem === 'pattern'
                      ? t('library.idBad')
                      : t('library.idFixed')}
                </span>
              </div>
            )}
            {builtin ? (
              <Alert data-testid="entry-builtin-note">
                <AlertDescription>
                  {t('library.builtinNote')}{' '}
                  {kind === 'forms' && entry?.id !== 'report' ? t('library.builtinFormNote') : ''}
                </AlertDescription>
              </Alert>
            ) : null}
          </header>

          {entry ? (
            <section
              className="flex flex-col gap-2"
              aria-labelledby="used-by"
              data-testid="entry-used-by"
            >
              <h3 id="used-by" className="text-sm font-semibold">
                {t('library.usedBy')}
              </h3>
              {models.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {models.map((model) => (
                    <li key={model.id}>
                      <a
                        href={`#/models/${model.id}`}
                        data-testid="used-by-model"
                        data-model-id={model.id}
                        className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span dir="auto">{model.name}</span>
                        <Mono className="text-xs text-muted-foreground">divan/{model.id}</Mono>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="used-by-none">
                  {t('library.usedByNone')}
                </p>
              )}
              {formPrompts.length > 0 ? (
                <p
                  className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                  data-testid="form-prompts"
                >
                  {t('library.formPrompts')}
                  {formPrompts.map((prompt: PromptView) => (
                    <a
                      key={prompt.id}
                      href={`#/library/prompts/${prompt.id}`}
                      className="rounded-md border px-1.5 py-0.5 text-foreground hover:bg-muted"
                    >
                      <span dir="auto">{entryName(prompt, 'prompts', t)}</span>
                    </a>
                  ))}
                </p>
              ) : null}
            </section>
          ) : null}

          {kind === 'prompts' ? (
            <PromptEditor
              library={library}
              values={values as PromptValues}
              readOnly={readOnly}
              onChange={(next) => change(next)}
            />
          ) : builtin ? (
            <BuiltinForm schema={(entry as FormView).schema as Record<string, unknown>} />
          ) : (
            <FormEditor
              fields={(values as FormValues).fields}
              readOnly={readOnly}
              onChange={(fields) => change({ ...(values as FormValues), fields })}
            />
          )}
          {error ? (
            <Alert variant="destructive" role="alert" data-testid="entry-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      </div>

      {/* the save bar */}
      {!builtin && (dirty || phase !== 'idle') ? (
        <div
          className="flex flex-wrap items-center gap-3 border-t bg-background px-4 py-3 sm:px-6"
          data-testid="savebar"
          data-phase={phase}
        >
          {dirty ? (
            <span
              className="flex items-center gap-2 text-sm font-medium"
              data-testid="dirty-marker"
            >
              <span className="size-2 rounded-full bg-foreground" aria-hidden="true" />
              {t('councils.unsaved')}
            </span>
          ) : null}
          {phase === 'saving' ? (
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              role="status"
              data-cue="saving"
              data-testid="save-cue"
            >
              <Spinner className="size-3.5" aria-label={t('councils.saving')} />
              {t('councils.saving')}
            </span>
          ) : null}
          {phase === 'saved' && !dirty ? (
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              role="status"
              data-cue="saved"
              data-testid="save-cue"
            >
              <CheckIcon className="size-3.5" />
              {t('library.saved')}
            </span>
          ) : null}
          {phase === 'error' ? (
            <span
              className="flex flex-wrap items-center gap-2 text-sm text-destructive"
              role="alert"
              data-testid="save-error"
            >
              {t('councils.saveFailed', { problem: problem ?? '' })}
              <Button
                variant="outline"
                size="sm"
                data-testid="save-retry"
                onClick={() => void form.save()}
              >
                <RefreshCwIcon />
                {t('common.retry')}
              </Button>
            </span>
          ) : null}
          {phase === 'conflict' && conflict ? (
            <span
              className="flex flex-wrap items-center gap-2 text-sm"
              role="alert"
              data-testid="save-conflict"
            >
              {t('library.conflict', { name: isolate(conflict.name, lang) })}
              <Button
                variant="outline"
                size="sm"
                data-testid="conflict-load"
                disabled={busy !== null}
                onClick={() => setConfirming('reload')}
              >
                <RefreshCwIcon />
                {t('library.conflictLoad')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                data-testid="conflict-keep"
                disabled={busy !== null}
                onClick={form.keepMine}
              >
                {t('library.conflictKeep')}
              </Button>
            </span>
          ) : null}
          {blocker && dirty ? (
            <span
              className="flex items-center gap-1.5 text-sm"
              data-testid="save-blocker"
              title={blocker}
            >
              <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
              {blocker}
            </span>
          ) : null}
          {dirty && phase !== 'conflict' ? (
            <span className="ms-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="entry-discard"
                disabled={frozen}
                onClick={form.discard}
              >
                {t('councils.discard')}
              </Button>
              <Button
                size="sm"
                data-testid="entry-save"
                disabled={frozen || blocker !== null}
                onClick={() => void form.save()}
              >
                {t('library.save')}
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}

      {confirming === 'delete' && entry ? (
        <ConfirmDialog
          title={t('library.deleteTitle')}
          text={t('library.deleteText', { name: isolate(entryName(entry, kind, t), lang) })}
          confirm={t('common.delete')}
          testid="confirm-delete-entry"
          onConfirm={() => void remove()}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {confirming === 'reload' ? (
        <ConfirmDialog
          title={t('library.reloadTitle')}
          text={t('library.reloadText')}
          confirm={t('councils.discard')}
          testid="confirm-reload"
          onConfirm={() => {
            setConfirming(null);
            form.loadOther();
          }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {duplicating && entry ? (
        <NewEntryDialog
          kind={kind}
          from={{ id: entry.id, name: entryName(entry, kind, t) }}
          taken={taken}
          onClose={() => setDuplicating(false)}
          onDone={(view, id) => {
            setDuplicating(false);
            onLibrary(view);
            onGo(`#/library/${kind}/${id}`);
          }}
        />
      ) : null}
      {inUse && entry ? (
        <InUseDialog
          name={entryName(entry, kind, t)}
          models={inUse.models}
          prompts={inUse.prompts}
          library={library}
          profiles={profiles}
          onClose={() => setInUse(null)}
        />
      ) : null}
      {leaving ? (
        <LeaveDialog
          council={values.name.trim() || title}
          goal={leaving.goal}
          blocked={blocker}
          onStay={() => setLeaving(null)}
          onDiscard={() => {
            const { go } = leaving;
            setLeaving(null);
            form.discard();
            go();
          }}
          onSave={() => {
            const { go } = leaving;
            setLeaving(null);
            void saveThen(go);
          }}
        />
      ) : null}
    </div>
  );
}
