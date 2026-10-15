// The pickers a council and a design share: the assistant, the model, the reasoning effort, and the badge that says where a value
// comes from (inherited, from the level, or overridden).

import { Mono } from '@/components/bidi';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { HARNESS_LABEL } from '@/fa';
import { useI18n } from '@/i18n/index.tsx';
import { useNotes } from '@/i18n/notes.tsx';
import { cn } from '@/lib/utils';
import { pickEffort, pickModel } from '../../../../src/shared/defaults.ts';
import { HARNESS_RULES } from '../../../../src/shared/harness-rules.ts';
import type { HarnessId, HarnessModels, SettingsView } from '../../../../src/shared/types.ts';

export const ORDER: HarnessId[] = ['claude', 'codex', 'agy', 'grok', 'pi', 'hermes'];

const modelsOf = (view: SettingsView, harness: HarnessId): HarnessModels | undefined =>
  view.models.find((item) => item.harness === harness);

export function pickFor(view: SettingsView, harness: HarnessId) {
  const list = modelsOf(view, harness);
  const model = list ? pickModel(list.models, list.defaultModel) : undefined;
  return { model: model?.id ?? '', effort: pickEffort(model) };
}

// ---------- pickers ----------

export function HarnessSelect({
  view,
  value,
  onChange,
  id,
  disabled,
  className,
}: {
  view: SettingsView;
  value: HarnessId;
  onChange: (next: HarnessId) => void;
  id: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const notes = useNotes();
  // Manual-only assistants are offered here, never in automatic defaults.
  const items = ORDER.filter(
    (harness) => HARNESS_RULES[harness].supported || harness === value,
  ).map((harness) => {
    const status = view.status.find((item) => item.id === harness);
    const usable = status?.usable === true;
    return {
      value: harness,
      label: `${HARNESS_LABEL[harness]}${usable ? '' : ` (${t('councils.unavailable')})`}`,
      usable,
      // why it cannot be used, in the language in force
      why: !usable && status?.note ? notes.text(status.note) : undefined,
    };
  });
  return (
    <Select
      value={value}
      items={items}
      onValueChange={(next) => next && onChange(next as HarnessId)}
      disabled={disabled ?? false}
    >
      <SelectTrigger
        id={id}
        size="sm"
        className={cn('w-36', className)}
        aria-label={t('councils.assistant')}
        data-testid={id}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            disabled={!item.usable && item.value !== value}
            title={item.why}
            data-harness={item.value}
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The model of a seat or the chairman: a list when the assistant can list its models, else a field to type the id in. */
export function ModelSelect({
  view,
  harness,
  model,
  onChange,
  idPrefix,
  disabled,
  className,
}: {
  view: SettingsView;
  harness: HarnessId;
  model: string;
  onChange: (next: { model: string }) => void;
  idPrefix: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const list = modelsOf(view, harness);
  const info = list?.models.find((item) => item.id === model);
  // Models that recently ran out of credit or quota (24 hours) are marked.
  const out = (list?.unavailable ?? []).filter(
    (entry) => new Date(entry.until).getTime() > Date.now(),
  );
  const isOut = (id: string) =>
    out.some(
      (entry) => entry.id === id || (entry.prefix !== undefined && id.startsWith(entry.prefix)),
    );
  if (!list?.listed) {
    return (
      <Input
        id={`${idPrefix}-model`}
        data-testid={`${idPrefix}-model`}
        className={cn('h-7 w-56 font-mono text-xs', className)}
        aria-label={t('councils.modelTyped')}
        placeholder={t('councils.modelPlaceholder')}
        dir="ltr"
        spellCheck={false}
        value={model}
        disabled={disabled ?? false}
        onChange={(event) => onChange({ model: event.target.value.trim() })}
      />
    );
  }
  const items = [
    ...(model === '' || !info
      ? [
          {
            value: model,
            label: model === '' ? t('councils.pickModel') : `${model} (${t('councils.unlisted')})`,
          },
        ]
      : []),
    ...list.models.map((item) => ({
      value: item.id,
      label: `${item.label === item.id ? item.id : `${item.label} · ${item.id}`}${isOut(item.id) ? ` (${t('councils.noCredit')})` : ''}`,
    })),
  ];
  return (
    <Select
      value={model}
      items={items}
      onValueChange={(next) => next !== null && onChange({ model: next })}
      disabled={disabled ?? false}
    >
      <SelectTrigger
        id={`${idPrefix}-model`}
        size="sm"
        className={cn('w-56 font-mono text-xs', className)}
        aria-label={t('councils.model')}
        data-testid={`${idPrefix}-model`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false} className="min-w-64">
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="font-mono text-xs">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function EffortSelect({
  view,
  harness,
  model,
  effort,
  onChange,
  idPrefix,
  disabled,
  className,
}: {
  view: SettingsView;
  harness: HarnessId;
  model: string;
  effort: string;
  onChange: (next: string) => void;
  idPrefix: string;
  disabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const list = modelsOf(view, harness);
  const info = list?.models.find((item) => item.id === model);
  const efforts = info ? info.efforts : (list?.fallbackEfforts ?? []);
  const items =
    efforts.length === 0
      ? [
          {
            value: '',
            label: info || list?.listed ? t('councils.effortInName') : t('councils.effortNone'),
          },
        ]
      : [
          ...(efforts.includes(effort)
            ? []
            : [{ value: effort, label: effort || t('councils.effortUnset') }]),
          ...efforts.map((item) => ({ value: item, label: item })),
        ];
  return (
    <Select
      value={effort}
      items={items}
      onValueChange={(next) => next !== null && onChange(next)}
      disabled={(disabled ?? false) || efforts.length === 0}
    >
      <SelectTrigger
        id={`${idPrefix}-effort`}
        size="sm"
        className={cn('w-28 font-mono text-xs', className)}
        aria-label={t('councils.effort')}
        data-testid={`${idPrefix}-effort`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value} className="font-mono text-xs">
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export type Origin = 'inherited' | 'level' | 'override';

const ORIGIN_VARIANT: Record<Origin, 'outline' | 'secondary' | 'default'> = {
  inherited: 'outline',
  level: 'secondary',
  override: 'default',
};

export function OriginBadge({ origin }: { origin: Origin }) {
  const { t } = useI18n();
  return (
    <Badge variant={ORIGIN_VARIANT[origin]} data-origin={origin} data-testid="origin">
      {t(`councils.origin.${origin}`)}
    </Badge>
  );
}

export { Mono };
