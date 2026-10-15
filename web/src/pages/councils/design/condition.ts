// The fields, checks and words of a condition (pure, so a test can pin them). A condition reads ONE agent whose answer has fields
// and decides Yes or No by rules over the top-level fields of that answer. What a field can be asked is decided by its type, the
// same way `validateFlow` decides it (src/shared/flow.ts): the editor offers only what the server accepts, and the server stays the
// judge. A rule is a field, a check (`op`) and, for most checks, a value.

import type { ConditionRule, Flow, FlowAgent } from '../../../../../src/shared/flow.ts';
import type { JsonSchema } from '../../../../../src/shared/types.ts';
import { agentOf } from './edit.ts';

export type Op = ConditionRule['op'];
export type FieldKind = 'number' | 'text' | 'boolean' | 'choice' | 'list';

/** A top-level field of an agent's answer that a rule can ask about. */
export interface SourceField {
  name: string;
  kind: FieldKind;
  /** The choices of a choice field. */
  options?: string[];
  description: string;
}

/** The checks each kind of field has: the strings are exactly the server's. */
export const OPS: Record<FieldKind, readonly Op[]> = {
  number: ['<', '<=', '>', '>=', '=', '!='],
  text: ['is empty', 'is not empty', 'contains', 'equals'],
  boolean: ['is true', 'is false'],
  choice: ['is', 'is not'],
  list: [
    'is empty',
    'is not empty',
    'count <',
    'count <=',
    'count >',
    'count >=',
    'count =',
    'count !=',
  ],
};

/** A check with no value to compare with. */
export const NO_VALUE: ReadonlySet<Op> = new Set<Op>([
  'is true',
  'is false',
  'is empty',
  'is not empty',
]);

/** The name of a check in the catalogues (`flow.op.<slug>`, `flow.rule.<slug>`). */
export const OP_SLUG: Record<Op, string> = {
  '<': 'lt',
  '<=': 'le',
  '>': 'gt',
  '>=': 'ge',
  '=': 'eq',
  '!=': 'ne',
  'is empty': 'empty',
  'is not empty': 'notEmpty',
  contains: 'contains',
  equals: 'equals',
  'is true': 'true',
  'is false': 'false',
  is: 'is',
  'is not': 'isNot',
  'count <': 'countLt',
  'count <=': 'countLe',
  'count >': 'countGt',
  'count >=': 'countGe',
  'count =': 'countEq',
  'count !=': 'countNe',
};

/** The checks that are written as a symbol: «score ≥ 8». */
export const SYMBOL: Partial<Record<Op, string>> = {
  '<': '<',
  '<=': '≤',
  '>': '>',
  '>=': '≥',
  '=': '=',
  '!=': '≠',
};

/** What kind of value a check takes. */
export type ValueKind = 'none' | 'number' | 'count' | 'text' | 'choice';
export function valueKind(op: Op): ValueKind {
  if (NO_VALUE.has(op)) return 'none';
  if (op.startsWith('count ')) return 'count';
  if (op === 'is' || op === 'is not') return 'choice';
  if (op === 'contains' || op === 'equals') return 'text';
  return 'number';
}

const MAX_TEXT = 2000;
export const MAX_RULES = 30;

/** The kind of one property of a JSON Schema as a rule sees it, or null when no rule can ask about it. */
export function kindOf(schema: JsonSchema | undefined): FieldKind | null {
  if (!schema) return null;
  const inner: JsonSchema =
    (schema.anyOf as JsonSchema[] | undefined)?.find((item) => item.type !== 'null') ?? schema;
  if (inner.type === 'number') return 'number';
  if (inner.type === 'boolean') return 'boolean';
  if (inner.type === 'array') return 'list';
  if (Array.isArray(inner.enum)) return 'choice';
  if (inner.type === 'string') return 'text';
  return null;
}

/** The fields of an agent's answer a rule can ask about, in the order of its form. */
export function fieldsOfAgent(agent: FlowAgent | undefined): SourceField[] {
  const properties = (agent?.schema?.properties ?? {}) as Record<string, JsonSchema>;
  const out: SourceField[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    const kind = kindOf(schema);
    if (!kind) continue;
    const inner: JsonSchema =
      (schema.anyOf as JsonSchema[] | undefined)?.find((item) => item.type !== 'null') ?? schema;
    out.push({
      name,
      kind,
      ...(kind === 'choice' ? { options: (inner.enum as string[]).map(String) } : {}),
      description: typeof schema.description === 'string' ? schema.description : '',
    });
  }
  return out;
}

/** The agent a condition reads (its one data line), or undefined. */
export function sourceOf(flow: Flow, id: string): FlowAgent | undefined {
  const line = flow.edges.find((edge) => edge.to === id && !edge.gate);
  return line ? agentOf(flow, line.from) : undefined;
}

/** A new rule on a field: the first check the field has, with a value that is allowed. */
export function defaultRule(field: SourceField): ConditionRule {
  const op = OPS[field.kind][0] as Op;
  return withOp({ field: field.name, op }, field, op);
}

/** The rule with another check: the value stays when it still fits, else it is a value the check allows. */
export function withOp(rule: ConditionRule, field: SourceField, op: Op): ConditionRule {
  const kind = valueKind(op);
  const { value, ...rest } = rule;
  const next: ConditionRule = { ...rest, op };
  if (kind === 'none') return next;
  if ((kind === 'number' || kind === 'count') && typeof value === 'number')
    return { ...next, value: kind === 'count' ? Math.max(0, Math.trunc(value)) : value };
  if (kind === 'text' && typeof value === 'string') return { ...next, value };
  if (kind === 'choice' && typeof value === 'string' && field.options?.includes(value))
    return { ...next, value };
  return {
    ...next,
    value: kind === 'choice' ? (field.options?.[0] ?? '') : kind === 'text' ? '' : 0,
  };
}

/** The rule on another field: the check stays when the new field has it, else it is the new field's first. */
export function withField(rule: ConditionRule, field: SourceField): ConditionRule {
  const op = (OPS[field.kind] as readonly Op[]).includes(rule.op) ? rule.op : OPS[field.kind][0];
  return withOp(
    { field: field.name, op: op as Op, ...(rule.value !== undefined ? { value: rule.value } : {}) },
    field,
    op as Op,
  );
}

/** What is wrong with one rule, or null (the same limits `validateFlow` holds it to). */
export type RuleProblem = 'field' | 'op' | 'value';
export function ruleProblem(rule: ConditionRule, fields: SourceField[]): RuleProblem | null {
  const field = fields.find((item) => item.name === rule.field);
  if (!field) return 'field';
  if (!(OPS[field.kind] as readonly Op[]).includes(rule.op)) return 'op';
  const kind = valueKind(rule.op);
  if (kind === 'none') return rule.value === undefined ? null : 'value';
  const value = rule.value;
  if (kind === 'number')
    return typeof value === 'number' && Number.isFinite(value) ? null : 'value';
  if (kind === 'count')
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? null : 'value';
  if (typeof value !== 'string' || value.length > MAX_TEXT) return 'value';
  if (kind === 'choice' && !field.options?.includes(value)) return 'value';
  return null;
}

/** Whether the rules can be given to the server as they are. */
export const rulesReady = (rules: ConditionRule[], fields: SourceField[]): boolean =>
  rules.length >= 1 &&
  rules.length <= MAX_RULES &&
  rules.every((rule) => ruleProblem(rule, fields) === null);
