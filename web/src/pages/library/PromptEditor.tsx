// The body of a prompt: what it is for (the output form it is written for, and whether it expects answers from other agents) and its
// text, in a large monospace area with its length. A built-in prompt is shown read-only. The text is the whole prompt: for an output
// form of the person's own the list of its fields is added after it by Divan.

import { useId } from 'react';
import { Mono } from '@/components/bidi';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { LibraryView } from '../../../../src/shared/library.ts';
import { textDirection } from '../../../../src/shared/text.ts';
import { formName } from './labels.ts';
import type { PromptValues } from './values.ts';

export const MAX_PROMPT = 64000;
const ANY = '*';
const INPUTS = ['any', 'with', 'without'] as const;

export function PromptEditor({
  library,
  values,
  readOnly,
  onChange,
}: {
  library: LibraryView;
  values: PromptValues;
  readOnly: boolean;
  onChange: (next: PromptValues) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const forms = [
    { value: ANY, label: t('library.anyForm') },
    ...library.forms.map((form) => ({ value: form.id, label: formName(library, form.id, t) })),
  ];
  const length = values.text.length;
  const custom =
    values.form !== null && !library.forms.find((form) => form.id === values.form)?.builtin;
  return (
    <div className="flex flex-col gap-5">
      <Field>
        <FieldLabel id={`${id}-form`}>{t('library.promptForm')}</FieldLabel>
        <Select
          value={values.form ?? ANY}
          items={forms}
          disabled={readOnly}
          onValueChange={(next) =>
            next && onChange({ ...values, form: next === ANY ? null : next })
          }
        >
          <SelectTrigger
            className="w-full max-w-sm"
            aria-labelledby={`${id}-form`}
            data-testid="prompt-form"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {forms.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldDescription>{t('library.promptFormHint')}</FieldDescription>
      </Field>

      <Field>
        <FieldLabel id={`${id}-inputs`}>{t('library.promptInputs')}</FieldLabel>
        <ToggleGroup
          variant="outline"
          spacing={0}
          aria-labelledby={`${id}-inputs`}
          value={[values.inputs]}
          disabled={readOnly}
          data-testid="prompt-inputs"
          onValueChange={(next) =>
            next[0] && onChange({ ...values, inputs: next[0] as PromptValues['inputs'] })
          }
        >
          {INPUTS.map((item) => (
            <ToggleGroupItem key={item} value={item} data-testid={`prompt-inputs-${item}`}>
              {t(`library.inputs.${item}.label` as Key)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <FieldDescription>{t(`library.inputs.${values.inputs}.hint` as Key)}</FieldDescription>
      </Field>

      <Field>
        <div className="flex items-baseline justify-between gap-3">
          <FieldLabel htmlFor={`${id}-text`}>{t('library.promptText')}</FieldLabel>
          <span
            className={cn(
              'text-xs tabular-nums text-muted-foreground',
              length > MAX_PROMPT && 'text-destructive',
            )}
            dir="ltr"
            data-testid="prompt-length"
          >
            {length.toLocaleString('en-US')} / {MAX_PROMPT.toLocaleString('en-US')}
          </span>
        </div>
        <Textarea
          id={`${id}-text`}
          data-testid="prompt-text"
          dir={textDirection(values.text) ?? 'auto'}
          spellCheck={false}
          readOnly={readOnly}
          aria-invalid={length > MAX_PROMPT || (!readOnly && values.text.trim() === '')}
          className="max-h-[60vh] min-h-72 font-mono text-[13px] leading-relaxed"
          placeholder={t('library.promptPlaceholder')}
          value={values.text}
          onChange={(event) => onChange({ ...values, text: event.target.value })}
        />
        <FieldDescription>
          {t('library.promptTextHint')}
          {custom ? ` ${t('library.promptCustomHint')}` : ''}
        </FieldDescription>
        {length > MAX_PROMPT ? (
          <p className="text-xs text-destructive">
            {t('library.reason.prompt_text')} <Mono>{MAX_PROMPT.toLocaleString('en-US')}</Mono>
          </p>
        ) : null}
      </Field>
    </div>
  );
}
