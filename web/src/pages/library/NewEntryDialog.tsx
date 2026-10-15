// «New from this…» and «Duplicate»: a copy of a Library entry under a name and an id of its own. The server makes the copy (it knows
// what a copy of a built-in is) and may refuse it; its reason is said in plain words and the dialog stays open.

import { useState } from 'react';
import { Mono } from '@/components/bidi';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n/index.tsx';
import { isolate } from '@/lib/isolate';
import type { LibraryView } from '../../../../src/shared/library.ts';
import { createEntry, type Kind, problemText } from './api.ts';
import { idProblem, suggestEntryId } from './ids.ts';

export function NewEntryDialog({
  kind,
  from,
  taken,
  onClose,
  onDone,
}: {
  kind: Kind;
  from: { id: string; name: string };
  /** The ids of this kind that are in use. */
  taken: readonly string[];
  onClose: () => void;
  /** The entry was made: the Library as it is now, and the new id. */
  onDone: (view: LibraryView, id: string) => void;
}) {
  const { t, lang } = useI18n();
  const [name, setName] = useState(t('library.copyOf', { name: from.name }));
  const [typedId, setTypedId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const id = typedId ?? suggestEntryId(name, kind === 'prompts' ? 'prompt' : 'form', taken);
  const idWhy = idProblem(id, taken);
  const why = name.trim() === '' ? t('library.nameEmpty') : null;
  const ready = why === null && idWhy === null && !sending;

  async function submit() {
    if (!ready) return;
    setSending(true);
    try {
      const view = await createEntry(kind, { id, name: name.trim(), from: from.id });
      onDone(view, id);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="new-entry-dialog">
        <DialogHeader>
          <DialogTitle>
            {t(kind === 'prompts' ? 'library.newFromPrompt' : 'library.newFromForm')}
          </DialogTitle>
          <DialogDescription>
            {t(kind === 'prompts' ? 'library.newFromPromptText' : 'library.newFromFormText', {
              name: isolate(from.name, lang),
            })}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="new-entry-name">{t('library.name')}</FieldLabel>
          <Input
            id="new-entry-name"
            data-testid="new-entry-name"
            autoFocus
            dir="auto"
            maxLength={100}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
            }}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="new-entry-id">{t('library.id')}</FieldLabel>
          <Input
            id="new-entry-id"
            data-testid="new-entry-id"
            dir="ltr"
            className="font-mono"
            maxLength={48}
            spellCheck={false}
            value={id}
            aria-invalid={idWhy !== null}
            onChange={(event) => {
              setTypedId(event.target.value.toLowerCase());
              setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
            }}
          />
          <FieldDescription>
            {idWhy === 'taken' ? (
              t('library.idTaken')
            ) : idWhy === 'pattern' ? (
              t('library.idBad')
            ) : (
              <>
                {t('library.idHint')} <Mono>{id}</Mono>
              </>
            )}
          </FieldDescription>
        </Field>
        {why ? <p className="text-sm text-muted-foreground">{why}</p> : null}
        {problem ? (
          <FieldError data-testid="new-entry-problem" role="alert">
            {problem}
          </FieldError>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="new-entry-ok" disabled={!ready} onClick={() => void submit()}>
            {t('library.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
