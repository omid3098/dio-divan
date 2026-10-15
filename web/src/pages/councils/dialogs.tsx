// The dialogs of the councils page: a name for a council (new, copy, rename), its id, a confirmation, and the question asked
// when the page is left with unsaved changes (save and go on, discard, or stay).

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

/** A name with a letter outside the Latin script: its automatic id would be a transliteration nobody can read. */
export const needsReadableId = (name: string): boolean =>
  [...name].some((char) => /\p{L}/u.test(char) && !/\p{Script=Latin}/u.test(char));

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/**
 * An id to start from: the Latin words of the name as a slug, else `council-<n>` for the first n that is free. It is only a
 * suggestion, in the field, for the user to keep or change.
 */
export function suggestId(name: string, taken: string[]): string {
  const slug = (name.match(/[A-Za-z0-9]+/gu) ?? [])
    .join('-')
    .toLowerCase()
    .slice(0, 32)
    .replace(/-+$/u, '');
  if (ID_PATTERN.test(slug) && !taken.includes(slug)) return slug;
  for (let n = 1; ; n += 1) {
    const candidate = `profile-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A starting point of a new council: today's council, or a design (the server's own templates). */
export interface TemplateChoice {
  id: string;
  label: string;
  hint: string;
}

export function NameDialog({
  title,
  initial,
  askId,
  taken,
  templates,
  onSubmit,
  onClose,
}: {
  title: string;
  initial: string;
  /** A council that is made (new or a copy) gets an id: asked for when the name is not Latin. */
  askId: boolean;
  /** The ids that are in use (a suggestion never repeats one). */
  taken: string[];
  /** A new council starts from one of these (the first is the plain council); copies and renames have none. */
  templates?: TemplateChoice[];
  /** Resolves with a problem to show (the dialog stays open), or null when it is done. `template` is a start other than the plain council. */
  onSubmit: (name: string, id?: string, template?: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const [template, setTemplate] = useState<string | null>(null);
  const chosen = template ?? templates?.[0]?.id;
  // the id the user typed; until then the suggestion stands in it (and follows the name)
  const [typedId, setTypedId] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const wantsId = askId && needsReadableId(name);
  const id = typedId ?? suggestId(name, taken);
  const why =
    name.trim() === ''
      ? t('councils.nameEmpty')
      : wantsId && !ID_PATTERN.test(id)
        ? t('councils.idBad')
        : null;
  const ready = why === null && !sending;

  async function submit() {
    if (!ready) return;
    setSending(true);
    setProblem(
      await onSubmit(
        name.trim(),
        wantsId ? id : undefined,
        chosen && chosen !== templates?.[0]?.id ? chosen : undefined,
      ),
    );
    setSending(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="council-name">{t('councils.name')}</FieldLabel>
          <Input
            id="council-name"
            data-testid="name-input"
            autoFocus
            dir="auto"
            maxLength={40}
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
        {templates && templates.length > 1 ? (
          <fieldset className="flex flex-col gap-2" data-testid="template-choice">
            <legend className="mb-1 text-sm font-medium">{t('flow.startFrom')}</legend>
            {templates.map((item) => (
              <label
                key={item.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${chosen === item.id ? 'border-foreground/40 bg-muted' : ''}`}
              >
                <input
                  type="radio"
                  name="template"
                  className="mt-1"
                  value={item.id}
                  checked={chosen === item.id}
                  data-testid={`template-${item.id}`}
                  onChange={() => setTemplate(item.id)}
                />
                <span className="flex flex-col gap-0.5">
                  <span className="font-medium">{item.label}</span>
                  <span className="text-xs text-muted-foreground">{item.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {wantsId ? (
          <Field>
            <FieldLabel htmlFor="council-id">{t('councils.idLabel')}</FieldLabel>
            <div className="flex items-center gap-1" dir="ltr">
              <Mono>divan/</Mono>
              <Input
                id="council-id"
                data-testid="name-id"
                dir="ltr"
                maxLength={32}
                spellCheck={false}
                placeholder="finance"
                value={id}
                aria-invalid={id !== '' && !ID_PATTERN.test(id)}
                onChange={(event) => {
                  setTypedId(event.target.value.toLowerCase());
                  setProblem(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit();
                }}
              />
            </div>
            <FieldDescription data-testid="name-id-hint">{t('councils.idHint')}</FieldDescription>
          </Field>
        ) : null}
        {why ? (
          <p className="text-sm text-muted-foreground" data-testid="name-disabled-reason">
            {why}
          </p>
        ) : null}
        {problem ? (
          <FieldError data-testid="name-problem" role="alert">
            {problem}
          </FieldError>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="name-ok" disabled={!ready} onClick={() => void submit()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The id of a council of one's own (what other tools call it): changing it makes the old name stop working. */
export function IdDialog({
  current,
  onSubmit,
  onClose,
}: {
  current: string;
  /** Resolves with a problem to show, or null when the id was changed. */
  onSubmit: (id: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const valid = ID_PATTERN.test(value);
  async function save() {
    if (!valid) return;
    if (value === current) {
      onClose();
      return;
    }
    setProblem(await onSubmit(value));
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="id-editor">
        <DialogHeader>
          <DialogTitle>{t('councils.idTitle')}</DialogTitle>
          <DialogDescription>
            {valid ? t('councils.idChangeNote', { id: current }) : t('councils.idBad')}
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="council-id-edit">{t('councils.idLabelShort')}</FieldLabel>
          <div className="flex items-center gap-1" dir="ltr">
            <Mono>divan/</Mono>
            <Input
              id="council-id-edit"
              data-testid="profile-id-input"
              autoFocus
              dir="ltr"
              maxLength={32}
              spellCheck={false}
              value={value}
              aria-invalid={!valid}
              onChange={(event) => {
                setValue(event.target.value.toLowerCase());
                setProblem(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save();
              }}
            />
          </div>
        </Field>
        {problem ? (
          <FieldError role="alert" data-testid="profile-id-problem">
            {problem}
          </FieldError>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="profile-id-save" disabled={!valid} onClick={() => void save()}>
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({
  title,
  text,
  confirm,
  testid,
  onConfirm,
  onClose,
}: {
  title: string;
  text: string;
  confirm: string;
  testid: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="confirm-dialog">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus data-testid="confirm-cancel" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" data-testid={testid} onClick={onConfirm}>
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Asked before the first edit that a council cannot express (a line, a writer, a form, a prompt, a minimum other than two): the
 * council becomes a design. What changes is said in plain words; nothing is saved until the person saves.
 */
export function DesignDialog({
  level,
  limits,
  ready,
  onContinue,
  onCancel,
}: {
  /** The name of the lowest reasoning level, as the sentence says it. */
  level: string;
  /** The council's answer limits when they are not the standard ones (a design uses the standard member form). */
  limits: { claims: number; words: number } | null;
  /** The standard prompts are loaded (a design cannot be made before). */
  ready: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="design-dialog">
        <DialogHeader>
          <DialogTitle>{t('flow.convert.title')}</DialogTitle>
          <DialogDescription data-testid="design-dialog-text">
            {t('flow.convert.text', { level })}
          </DialogDescription>
          {limits ? (
            <p className="text-sm text-muted-foreground" data-testid="design-dialog-limits">
              {t('flow.convert.limits', limits)}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t('flow.convert.saved')}</p>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus data-testid="design-cancel" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="design-continue" disabled={!ready} onClick={onContinue}>
            {t('flow.convert.continue')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What is asked when the page is left with changes that are not saved: save and go on, discard them, or stay. */
export function LeaveDialog({
  council,
  goal,
  blocked,
  onSave,
  onDiscard,
  onStay,
}: {
  council: string;
  /** Where the user was going, as the end of «Save and …». */
  goal: string;
  /** Why the changes cannot be saved as they are (a design that cannot run), or null. */
  blocked?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog open onOpenChange={(open) => !open && onStay()}>
      <DialogContent className="sm:max-w-md" data-testid="leave-dialog">
        <DialogHeader>
          <DialogTitle>{t('councils.unsaved')}</DialogTitle>
          <DialogDescription>{t('councils.leaveText', { name: council })}</DialogDescription>
          {blocked ? (
            <p className="text-sm text-muted-foreground" data-testid="leave-blocked">
              {t('flow.fixToSave')} {blocked}
            </p>
          ) : null}
        </DialogHeader>
        <DialogFooter className="flex-wrap">
          <Button variant="outline" autoFocus data-testid="leave-stay" onClick={onStay}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" data-testid="leave-discard" onClick={onDiscard}>
            {t('councils.discard')}
          </Button>
          <Button
            data-testid="leave-save"
            disabled={Boolean(blocked)}
            title={blocked ?? undefined}
            onClick={onSave}
          >
            {t('councils.saveAnd', { goal })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
