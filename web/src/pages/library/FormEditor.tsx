// The body of an output form: a field builder, and a read-only preview of the JSON Schema Divan will give the assistants. A form is a
// flat list of up to 30 fields; each has a name, a type, a description, whether it is required, and the limits its type allows
// (words for text, Markdown and the items of a list; a smallest and a largest number; the choices of a choice; the most items of a
// list). Fields move up and down. The built-in forms are shown read-only, from their schemas: their fields are nested, so they
// cannot be copied into this builder, and the page says so.

import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { Mono } from '@/components/bidi';
import { CopyButton } from '@/components/copy-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { FormField } from '../../../../src/shared/library.ts';
import { reasonText } from './api.ts';
import {
  DEFAULTS,
  FIELD_TYPES,
  type FieldProblem,
  type FieldType,
  fieldProblems,
  fieldsOfSchema,
  LIMITS,
  MAX_DESCRIPTION,
  MAX_FIELDS,
  moveField,
  newField,
  previewSchema,
  retype,
} from './fields.ts';

/** A whole number as it is typed; empty means «not set». Partial text stays while typing, and the field gets a number only when it is one. */
function LimitInput({
  value,
  placeholder,
  invalid,
  disabled,
  label,
  testid,
  onValue,
}: {
  value: number | undefined;
  placeholder: string;
  invalid: boolean;
  disabled: boolean;
  label: string;
  testid: string;
  onValue: (next: number | undefined) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  useEffect(() => {
    setText((now) =>
      (now.trim() === '' && value === undefined) || Number(now) === value
        ? now
        : value === undefined
          ? ''
          : String(value),
    );
  }, [value]);
  const id = useId();
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        dir="ltr"
        className="h-8 w-24 font-mono"
        data-testid={testid}
        aria-invalid={invalid}
        placeholder={placeholder}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          const raw = event.target.value;
          setText(raw);
          if (raw.trim() === '') onValue(undefined);
          else if (Number.isFinite(Number(raw))) onValue(Number(raw));
        }}
      />
    </div>
  );
}

/** The choices of a choice field, one to a line: the lines are the options. */
function OptionsInput({
  options,
  invalid,
  disabled,
  testid,
  label,
  onValue,
}: {
  options: string[];
  invalid: boolean;
  disabled: boolean;
  testid: string;
  label: string;
  onValue: (next: string[]) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(options.join('\n'));
  useEffect(() => {
    setText((now) => {
      const mine = now
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return JSON.stringify(mine) === JSON.stringify(options) ? now : options.join('\n');
    });
  }, [options]);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Textarea
        dir="auto"
        className="min-h-16 font-mono text-[13px]"
        data-testid={testid}
        aria-label={label}
        aria-invalid={invalid}
        placeholder={t('library.optionsPlaceholder')}
        disabled={disabled}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          onValue(
            event.target.value
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          );
        }}
      />
    </div>
  );
}

function FieldCard({
  index,
  count,
  field,
  problem,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  index: number;
  count: number;
  field: FormField;
  problem: FieldProblem | null;
  disabled: boolean;
  onChange: (next: FormField) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const limits = LIMITS[field.type];
  const wordsDefault =
    field.type === 'markdown'
      ? DEFAULTS.markdown
      : field.type === 'list'
        ? DEFAULTS.listWords
        : DEFAULTS.text;
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border bg-card p-3"
      data-testid="field-row"
      data-field={field.name}
      data-problem={problem ?? undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          dir="ltr"
          className="h-8 min-w-0 flex-1 basis-32 font-mono"
          data-testid="field-name"
          aria-label={t('library.field.name')}
          aria-invalid={problem === 'name' || problem === 'duplicate'}
          maxLength={32}
          spellCheck={false}
          disabled={disabled}
          value={field.name}
          onChange={(event) => onChange({ ...field, name: event.target.value })}
        />
        <Select
          value={field.type}
          items={FIELD_TYPES.map((type) => ({
            value: type,
            label: t(`library.type.${type}` as Key),
          }))}
          disabled={disabled}
          onValueChange={(next) => next && onChange(retype(field, next as FieldType))}
        >
          <SelectTrigger
            size="sm"
            className="w-32 shrink-0"
            data-testid="field-type"
            aria-label={t('library.field.type')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {FIELD_TYPES.map((type) => (
              <SelectItem key={type} value={type}>
                {t(`library.type.${type}` as Key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <label className="flex shrink-0 items-center gap-1.5 text-xs" htmlFor={`${id}-required`}>
          <Switch
            id={`${id}-required`}
            size="sm"
            data-testid="field-required"
            checked={field.required}
            disabled={disabled}
            onCheckedChange={(required) => onChange({ ...field, required })}
          />
          {t('library.field.required')}
        </label>
        {disabled ? null : (
          <span className="ms-auto flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="field-up"
              aria-label={t('library.field.up')}
              title={t('library.field.up')}
              disabled={index === 0}
              onClick={() => onMove(index - 1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="field-down"
              aria-label={t('library.field.down')}
              title={t('library.field.down')}
              disabled={index === count - 1}
              onClick={() => onMove(index + 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              data-testid="field-remove"
              aria-label={t('library.field.remove')}
              title={t('library.field.remove')}
              disabled={count <= 1}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          </span>
        )}
      </div>
      <Input
        dir="auto"
        className="h-8"
        data-testid="field-description"
        aria-label={t('library.field.description')}
        aria-invalid={problem === 'description'}
        placeholder={t('library.field.descriptionPlaceholder')}
        maxLength={MAX_DESCRIPTION}
        disabled={disabled}
        value={field.description}
        onChange={(event) => onChange({ ...field, description: event.target.value })}
      />
      {limits.length > 0 ? (
        <div className="flex flex-wrap items-end gap-3" data-testid="field-limits">
          {limits.includes('maxWords') ? (
            <LimitInput
              value={field.maxWords}
              placeholder={String(wordsDefault)}
              invalid={problem === 'maxWords'}
              disabled={disabled}
              label={t(
                field.type === 'list' ? 'library.field.itemWords' : 'library.field.maxWords',
              )}
              testid="field-maxWords"
              onValue={(maxWords) => {
                const { maxWords: _was, ...rest } = field;
                onChange(maxWords === undefined ? rest : { ...rest, maxWords });
              }}
            />
          ) : null}
          {limits.includes('min') ? (
            <LimitInput
              value={field.min}
              placeholder="—"
              invalid={problem === 'bounds'}
              disabled={disabled}
              label={t('library.field.min')}
              testid="field-min"
              onValue={(min) => {
                const { min: _was, ...rest } = field;
                onChange(min === undefined ? rest : { ...rest, min });
              }}
            />
          ) : null}
          {limits.includes('max') ? (
            <LimitInput
              value={field.max}
              placeholder="—"
              invalid={problem === 'bounds'}
              disabled={disabled}
              label={t('library.field.max')}
              testid="field-max"
              onValue={(max) => {
                const { max: _was, ...rest } = field;
                onChange(max === undefined ? rest : { ...rest, max });
              }}
            />
          ) : null}
          {limits.includes('maxItems') ? (
            <LimitInput
              value={field.maxItems}
              placeholder={String(DEFAULTS.listItems)}
              invalid={problem === 'maxItems'}
              disabled={disabled}
              label={t('library.field.maxItems')}
              testid="field-maxItems"
              onValue={(maxItems) => {
                const { maxItems: _was, ...rest } = field;
                onChange(maxItems === undefined ? rest : { ...rest, maxItems });
              }}
            />
          ) : null}
          {limits.includes('options') ? (
            <div className="min-w-0 flex-1 basis-48">
              <OptionsInput
                options={field.options ?? []}
                invalid={problem === 'options'}
                disabled={disabled}
                testid="field-options"
                label={t('library.field.options')}
                onValue={(options) => onChange({ ...field, options })}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {problem ? (
        <p className="text-xs text-destructive" data-testid="field-problem" role="alert">
          {t(`library.fieldProblem.${problem}` as Key)}
        </p>
      ) : null}
    </li>
  );
}

/** The schema as it will be sent, as read-only text; an invalid form says why there is none. */
function SchemaPreview({
  schema,
  reason,
}: {
  schema: Record<string, unknown> | null;
  reason: string | null;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const text = schema ? JSON.stringify(schema, null, 2) : '';
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border"
      aria-labelledby="schema-title"
      data-testid="schema-preview"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-start text-sm font-medium"
          aria-expanded={open}
          data-testid="schema-toggle"
          onClick={() => setOpen((now) => !now)}
        >
          <ChevronDownIcon
            className={cn(
              'size-4 shrink-0 transition-transform',
              open ? '' : '-rotate-90 rtl:rotate-90',
            )}
            aria-hidden="true"
          />
          <span id="schema-title">{t('library.schema.title')}</span>
        </button>
        {schema ? <CopyButton text={text} size="xs" data-testid="schema-copy" /> : null}
      </div>
      {open ? (
        <div className="flex flex-col gap-2 border-t p-3">
          <p className="text-xs text-muted-foreground">{t('library.schema.hint')}</p>
          {schema ? (
            <pre
              dir="ltr"
              className="max-h-96 overflow-auto rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed"
              data-testid="schema-json"
            >
              {text}
            </pre>
          ) : (
            <p className="text-sm text-destructive" data-testid="schema-error" role="status">
              {reason ? reasonText(reason) : ''}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** The fields of a form of the person's own: the builder. */
export function FormEditor({
  fields,
  readOnly,
  onChange,
}: {
  fields: FormField[];
  readOnly: boolean;
  onChange: (next: FormField[]) => void;
}) {
  const { t } = useI18n();
  const problems = fieldProblems(fields);
  const preview = previewSchema(fields);
  const set = (index: number, next: FormField) =>
    onChange(fields.map((item, at) => (at === index ? next : item)));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{t('library.fields')}</h3>
        <span
          className="text-xs tabular-nums text-muted-foreground"
          dir="ltr"
          data-testid="field-count"
        >
          {fields.length} / {MAX_FIELDS}
        </span>
      </div>
      <ul className="flex flex-col gap-3" data-testid="field-list">
        {fields.map((field, index) => (
          <FieldCard
            // a field's name is what the page edits, so the position is what tells fields apart while it is edited
            // biome-ignore lint/suspicious/noArrayIndexKey: names change as they are typed
            key={index}
            index={index}
            count={fields.length}
            field={field}
            problem={problems[index] ?? null}
            disabled={readOnly}
            onChange={(next) => set(index, next)}
            onMove={(to) => onChange(moveField(fields, index, to))}
            onRemove={() => onChange(fields.filter((_, at) => at !== index))}
          />
        ))}
      </ul>
      {readOnly ? null : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="field-add"
          disabled={fields.length >= MAX_FIELDS}
          onClick={() => onChange([...fields, newField(fields)])}
        >
          <PlusIcon />
          {t('library.field.add')}
        </Button>
      )}
      <p className="text-xs text-muted-foreground">{t('library.fieldsHint')}</p>
      <SchemaPreview
        schema={'schema' in preview ? preview.schema : null}
        reason={'reason' in preview ? preview.reason : null}
      />
    </div>
  );
}

/** A built-in output form: its fields as its schema has them, read-only. */
export function BuiltinForm({ schema }: { schema: Record<string, unknown> }) {
  const { t } = useI18n();
  const fields = fieldsOfSchema(schema);
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold">{t('library.fields')}</h3>
      <ul className="flex flex-col gap-2" data-testid="builtin-fields">
        {fields.map((field) => (
          <li
            key={field.name}
            className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2"
            data-testid="field-row"
            data-field={field.name}
          >
            <span className="flex flex-wrap items-center gap-2">
              <Mono className="text-sm font-medium">{field.name}</Mono>
              <Badge variant="secondary">{t(`library.type.${field.type}` as Key)}</Badge>
              {field.required ? (
                <span className="text-xs text-muted-foreground">{t('library.field.required')}</span>
              ) : null}
            </span>
            {field.description ? (
              <span className="text-xs text-muted-foreground" dir="auto">
                {field.description}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <SchemaPreview schema={schema} reason={null} />
    </div>
  );
}
