// The inspector of a condition. A condition looks at the answer of ONE agent and sends the design down its Yes line or its No line;
// it runs in code, instantly, and no assistant is asked. Its rules are limited to what the input's output form has: a field, a check
// that field's type allows, and a value. A failed, skipped or missing input, or a field that is empty, goes to «No». At a level
// nothing is edited here (a level changes models, efforts and who takes part), so the panel only says what the condition does.

import { PlusIcon, SplitIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Mono } from '@/components/bidi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { isolate } from '@/lib/isolate';
import type { ConditionRule, Flow, FlowCondition } from '../../../../../src/shared/flow.ts';
import type { Selection } from './Canvas.tsx';
import {
  defaultRule,
  fieldsOfAgent,
  MAX_RULES,
  OP_SLUG,
  OPS,
  type Op,
  ruleProblem,
  type SourceField,
  SYMBOL,
  sourceOf,
  valueKind,
  withField,
  withOp,
} from './condition.ts';
import { removeNode, setCondition } from './edit.ts';
import { Heading, quoted } from './parts.tsx';

/** A number as the person types it: partial text («-», «1.») is kept while typing, and the rule gets a number only when it is one. */
function NumberField({
  value,
  integer,
  disabled,
  invalid,
  testid,
  label,
  onValue,
}: {
  value: number | undefined;
  integer: boolean;
  disabled: boolean;
  invalid: boolean;
  testid: string;
  label: string;
  onValue: (next: number) => void;
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value));
  // the rule changed from outside (another check, another field): the text follows it
  useEffect(() => {
    setText((now) =>
      Number(now) === value && now.trim() !== '' ? now : value === undefined ? '' : String(value),
    );
  }, [value]);
  return (
    <Input
      type="text"
      inputMode={integer ? 'numeric' : 'decimal'}
      dir="ltr"
      className="h-8 font-mono"
      data-testid={testid}
      aria-label={label}
      aria-invalid={invalid}
      disabled={disabled}
      value={text}
      onChange={(event) => {
        const raw = event.target.value;
        setText(raw);
        const parsed = Number(raw);
        if (raw.trim() !== '' && Number.isFinite(parsed) && (!integer || Number.isInteger(parsed)))
          onValue(parsed);
      }}
    />
  );
}

function RuleRow({
  index,
  rule,
  fields,
  disabled,
  onChange,
  onRemove,
}: {
  index: number;
  rule: ConditionRule;
  fields: SourceField[];
  disabled: boolean;
  onChange: (next: ConditionRule) => void;
  onRemove: () => void;
}) {
  const { t, lang } = useI18n();
  const field = fields.find((item) => item.name === rule.field);
  const problem = ruleProblem(rule, fields);
  const kind = valueKind(rule.op);
  const ops = field ? OPS[field.kind] : [];
  const opLabel = (op: Op) => (
    <span className="flex items-baseline gap-2">
      {SYMBOL[op] ? <Mono>{SYMBOL[op]}</Mono> : null}
      {SYMBOL[op] ? ' ' : null}
      {t(`flow.op.${OP_SLUG[op]}` as Key)}
    </span>
  );
  const fieldItems = [
    ...(field ? [] : [{ value: rule.field, label: rule.field }]),
    ...fields.map((item) => ({ value: item.name, label: item.name })),
  ];
  return (
    <div
      className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-2.5"
      data-testid="rule-row"
      data-problem={problem ?? undefined}
    >
      <div className="flex items-center gap-2">
        <Select
          value={rule.field}
          items={fieldItems}
          disabled={disabled}
          onValueChange={(next) => {
            const picked = fields.find((item) => item.name === next);
            if (picked) onChange(withField(rule, picked));
          }}
        >
          <SelectTrigger
            size="sm"
            className="min-w-0 flex-1"
            data-testid={`rule-field-${index}`}
            aria-label={t('flow.cond.field')}
            aria-invalid={problem === 'field'}
          >
            <SelectValue>
              {(value: string) => (
                <Mono className="truncate">{value || t('flow.cond.pickField')}</Mono>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {fields.map((item) => (
              <SelectItem key={item.name} value={item.name}>
                <span className="flex w-full items-baseline justify-between gap-3">
                  <Mono>{item.name}</Mono>{' '}
                  <span className="text-xs text-muted-foreground">
                    {t(`library.type.${item.kind}` as Key)}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid={`rule-remove-${index}`}
          aria-label={t('flow.cond.removeRule')}
          title={t('flow.cond.removeRule')}
          disabled={disabled}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>
      {field ? (
        <div className="flex items-center gap-2">
          <Select
            value={rule.op}
            items={ops.map((op) => ({ value: op, label: opLabel(op) }))}
            disabled={disabled}
            onValueChange={(next) => next && onChange(withOp(rule, field, next as Op))}
          >
            <SelectTrigger
              size="sm"
              className="min-w-0 flex-1"
              data-testid={`rule-op-${index}`}
              aria-label={t('flow.cond.check')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {ops.map((op) => (
                <SelectItem key={op} value={op}>
                  {opLabel(op)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {kind === 'number' || kind === 'count' ? (
            <div className="w-20 shrink-0">
              <NumberField
                value={typeof rule.value === 'number' ? rule.value : undefined}
                integer={kind === 'count'}
                disabled={disabled}
                invalid={problem === 'value'}
                testid={`rule-value-${index}`}
                label={t('flow.cond.value')}
                onValue={(next) => onChange({ ...rule, value: next })}
              />
            </div>
          ) : kind === 'text' ? (
            <Input
              dir="auto"
              className="h-8 w-28 shrink-0"
              maxLength={2000}
              data-testid={`rule-value-${index}`}
              aria-label={t('flow.cond.value')}
              aria-invalid={problem === 'value'}
              disabled={disabled}
              value={typeof rule.value === 'string' ? rule.value : ''}
              onChange={(event) => onChange({ ...rule, value: event.target.value })}
            />
          ) : kind === 'choice' ? (
            <Select
              value={typeof rule.value === 'string' ? rule.value : ''}
              items={(field.options ?? []).map((option) => ({ value: option, label: option }))}
              disabled={disabled}
              onValueChange={(next) => next !== null && onChange({ ...rule, value: next })}
            >
              <SelectTrigger
                size="sm"
                className="w-28 shrink-0"
                data-testid={`rule-value-${index}`}
                aria-label={t('flow.cond.value')}
                aria-invalid={problem === 'value'}
              >
                <SelectValue>
                  {(value: string) => <Mono className="truncate">{value}</Mono>}
                </SelectValue>
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {(field.options ?? []).map((option) => (
                  <SelectItem key={option} value={option}>
                    <Mono>{option}</Mono>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      ) : null}
      {problem === 'field' ? (
        <p className="text-xs text-destructive" data-testid="rule-problem">
          {t('flow.cond.fieldGone', { field: isolate(rule.field, lang) })}
        </p>
      ) : problem === 'value' ? (
        <p className="text-xs text-destructive" data-testid="rule-problem">
          {t(`flow.cond.valueBad.${kind === 'none' ? 'text' : kind}` as Key)}
        </p>
      ) : null}
    </div>
  );
}

export function ConditionPanel({
  flow,
  node,
  names,
  readOnly,
  onChange,
  onSelect,
}: {
  flow: Flow;
  node: FlowCondition;
  names: Record<string, string>;
  /** At a level, or while the page is saving: the panel only says what the condition does. */
  readOnly: boolean;
  onChange: (next: Flow) => void;
  onSelect: (next: Selection | null) => void;
}) {
  const { t, lang } = useI18n();
  const source = sourceOf(flow, node.id);
  const fields = fieldsOfAgent(source);
  const exits = (['yes', 'no'] as const).map((exit) => ({
    exit,
    to: flow.edges
      .filter((edge) => edge.from === node.id && edge.gate === exit)
      .map((edge) => names[edge.to] ?? edge.to),
  }));
  const setRules = (rules: ConditionRule[]) => onChange(setCondition(flow, node.id, { rules }));
  const first = fields[0];
  return (
    <div
      className="flex flex-col gap-5 p-4"
      data-testid="inspector-condition"
      data-condition-id={node.id}
    >
      <div className="flex items-center gap-2">
        <span className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted">
          <SplitIcon className="size-4" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span
            className="truncate px-1 text-sm font-semibold"
            dir="auto"
            data-testid="condition-title"
          >
            {names[node.id]}
          </span>
          <span className="px-1 text-xs text-muted-foreground">{t('flow.cond.line')}</span>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="condition-delete"
          aria-label={t('flow.cond.delete')}
          title={t('flow.cond.delete')}
          disabled={readOnly}
          onClick={() => {
            onChange(removeNode(flow, node.id));
            onSelect(null);
          }}
        >
          <Trash2Icon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t('flow.cond.info')}</p>

      <section className="flex flex-col gap-2" aria-labelledby="cond-reads">
        <Heading>
          <span id="cond-reads">{t('flow.cond.readsTitle')}</span>
        </Heading>
        {source ? (
          <div className="flex items-center justify-between gap-2 text-sm">
            <span
              className="min-w-0 truncate font-medium"
              dir="auto"
              data-testid="condition-source"
            >
              {names[source.id]}
            </span>
            <Button
              variant="outline"
              size="xs"
              onClick={() => onSelect({ kind: 'node', id: source.id })}
            >
              {t('flow.cond.select')}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="condition-no-input">
            {t('flow.cond.inputNone')}
          </p>
        )}
        {source && fields.length === 0 ? (
          <p className="text-xs text-destructive">{t('flow.cond.noFields')}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="cond-rules">
        <Heading>
          <span id="cond-rules">{t('flow.cond.rules')}</span>
        </Heading>
        {node.rules.length > 1 ? (
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground" id="cond-mode">
              {t('flow.cond.mode')}
            </span>
            <ToggleGroup
              variant="outline"
              spacing={0}
              size="sm"
              aria-labelledby="cond-mode"
              value={[node.mode]}
              disabled={readOnly}
              onValueChange={(value) =>
                value[0] &&
                onChange(setCondition(flow, node.id, { mode: value[0] as 'all' | 'any' }))
              }
              data-testid="condition-mode"
            >
              <ToggleGroupItem value="all" data-testid="mode-all">
                {t('flow.cond.modeAll')}
              </ToggleGroupItem>
              <ToggleGroupItem value="any" data-testid="mode-any">
                {t('flow.cond.modeAny')}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        ) : null}
        {node.rules.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="condition-no-rules">
            {source && fields.length > 0
              ? t('flow.cond.noRulesYet')
              : t('flow.cond.noRulesNoInput')}
          </p>
        ) : null}
        {node.rules.map((rule, index) => (
          <RuleRow
            // the rules have no id of their own: their position is how they are told apart
            // biome-ignore lint/suspicious/noArrayIndexKey: a short list edited in place
            key={index}
            index={index}
            rule={rule}
            fields={fields}
            disabled={readOnly}
            onChange={(next) =>
              setRules(node.rules.map((item, at) => (at === index ? next : item)))
            }
            onRemove={() => setRules(node.rules.filter((_, at) => at !== index))}
          />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          data-testid="rule-add"
          disabled={readOnly || !first || node.rules.length >= MAX_RULES}
          onClick={() => first && setRules([...node.rules, defaultRule(first)])}
        >
          <PlusIcon />
          {t('flow.cond.addRule')}
        </Button>
      </section>

      <section className="flex flex-col gap-1.5" aria-labelledby="cond-exits">
        <Heading>
          <span id="cond-exits">{t('flow.cond.exits')}</span>
        </Heading>
        {exits.map(({ exit, to }) => (
          <p key={exit} className="text-xs" data-testid={`exit-${exit}`}>
            <b>{t(exit === 'yes' ? 'flow.cond.yes' : 'flow.cond.no')}</b>{' '}
            <span className="text-muted-foreground">
              {to.length > 0
                ? t('flow.cond.leadsTo', {
                    names: to.map((name) => quoted(isolate(name, lang), lang)).join(', '),
                  })
                : t('flow.cond.leadsNowhere')}
            </span>
          </p>
        ))}
        <p className="pt-1 text-xs text-muted-foreground" data-testid="condition-failed">
          {t('flow.cond.failed')}
        </p>
      </section>
    </div>
  );
}
