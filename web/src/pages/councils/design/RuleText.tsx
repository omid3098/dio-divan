// A condition's rules in words: «score ≥ 8», «verdict is pass», «note is empty». A field and a value are machine text (a name from
// the output form, a number, a choice): they stay left to right, in mono, inside a sentence that runs in the interface's direction.
// The same words are written as a plain string for a tooltip (`ruleString`), with Unicode isolates where a node cannot be used.

import type { ReactNode } from 'react';
import { Mono } from '@/components/bidi';
import { type Key, useI18n } from '@/i18n/index.tsx';
import type { ConditionRule, FlowCondition } from '../../../../../src/shared/flow.ts';
import { ltr } from '../../../../../src/shared/text.ts';
import { OP_SLUG, SYMBOL, valueKind } from './condition.ts';
import { quoted } from './parts.tsx';

/** One rule as a sentence. */
export function RuleSentence({ rule }: { rule: ConditionRule }) {
  const { tx, lang } = useI18n();
  const value = rule.value === undefined ? '' : String(rule.value);
  const symbol = SYMBOL[rule.op];
  if (symbol)
    return (
      <Mono>
        {rule.field} {symbol} {value}
      </Mono>
    );
  const shown = valueKind(rule.op) === 'text' ? quoted(value, lang) : value;
  const parts: Record<string, ReactNode> = {
    field: <Mono>{rule.field}</Mono>,
    value: <Mono>{shown}</Mono>,
  };
  return (
    <>
      {tx(`flow.rule.${OP_SLUG[rule.op]}` as Key, parts, {
        count: typeof rule.value === 'number' ? rule.value : 0,
      })}
    </>
  );
}

/** The rules of a condition on its box: the first two, then «+N more». */
export function RuleSummary({ node }: { node: FlowCondition }) {
  const { t, dir, lang } = useI18n();
  if (node.rules.length === 0)
    return (
      <span className="text-muted-foreground" dir={dir}>
        {t('flow.cond.noRules')}
      </span>
    );
  const shown = node.rules.slice(0, 2);
  const more = node.rules.length - shown.length;
  return (
    <span dir={dir} className="block text-start" title={ruleStrings(node, t, lang)}>
      {shown.map((rule, index) => (
        // the rules of a condition have no id of their own: the position is their identity while it is read
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed short list read as a sentence
        <span key={index}>
          {index > 0 ? ` ${t(node.mode === 'all' ? 'flow.cond.and' : 'flow.cond.or')} ` : null}
          <RuleSentence rule={rule} />
        </span>
      ))}
      {more > 0 ? (
        <span className="text-muted-foreground"> {t('flow.cond.more', { count: more })}</span>
      ) : null}
    </span>
  );
}

type Say = (key: Key, params?: Record<string, string | number>) => string;

/** One rule as plain text (a tooltip, a sentence of a problem). */
export function ruleString(rule: ConditionRule, t: Say, lang = 'en'): string {
  const value = rule.value === undefined ? '' : String(rule.value);
  const symbol = SYMBOL[rule.op];
  if (symbol) return ltr(`${rule.field} ${symbol} ${value}`);
  const shown = valueKind(rule.op) === 'text' ? quoted(value, lang) : value;
  return t(`flow.rule.${OP_SLUG[rule.op]}` as Key, {
    field: ltr(rule.field),
    value: ltr(shown),
    count: typeof rule.value === 'number' ? rule.value : 0,
  });
}

/** All the rules of a condition as plain text, joined by its «and» or «or». */
export function ruleStrings(node: FlowCondition, t: Say, lang = 'en'): string {
  return node.rules
    .map((rule) => ruleString(rule, t, lang))
    .join(` ${t(node.mode === 'all' ? 'flow.cond.and' : 'flow.cond.or')} `);
}
