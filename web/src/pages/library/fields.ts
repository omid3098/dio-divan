// The field builder of an output form, without the screen (pure, so a test can pin it). A form is a flat list of fields; each has a
// name, a type (text, Markdown, number, yes/no, choice, list), a description, whether it is required, and the limits its type allows.
// The server turns the list into the JSON Schema every assistant is given (`compileForm`, src/shared/library.ts) and is the judge;
// `fieldProblems` says in advance, field by field, what it would refuse, so the page can show it next to the field.

import { compileForm, type FormField } from '../../../../src/shared/library.ts';

export type FieldType = FormField['type'];
export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'markdown',
  'number',
  'boolean',
  'choice',
  'list',
];
export const MAX_FIELDS = 30;
export const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
export const MAX_DESCRIPTION = 2000;
export const MAX_OPTIONS = 50;

/** The limits each type allows (the server refuses a limit of another type). */
export const LIMITS: Record<FieldType, readonly (keyof FormField)[]> = {
  text: ['maxWords'],
  markdown: ['maxWords'],
  number: ['min', 'max'],
  boolean: [],
  choice: ['options'],
  list: ['maxItems', 'maxWords'],
};

/** What a limit is when it is left empty (said next to the field). */
export const DEFAULTS = { text: 2000, markdown: 8000, listItems: 20, listWords: 2000 } as const;

/** A name no field has: `field`, `field_2`, … */
export function freshName(fields: readonly FormField[], base = 'field'): string {
  const used = new Set(fields.map((field) => field.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

export const newField = (fields: readonly FormField[]): FormField => ({
  name: freshName(fields),
  type: 'text',
  description: '',
  required: true,
});

/** The field as another type: the name, the description and «required» stay; a limit the new type does not allow goes. */
export function retype(field: FormField, type: FieldType): FormField {
  const out: FormField = {
    name: field.name,
    type,
    description: field.description,
    required: field.required,
  };
  for (const key of LIMITS[type]) {
    if (key === 'options') out.options = type === field.type ? (field.options ?? []) : [];
    else if (field[key] !== undefined && type === field.type)
      Object.assign(out, { [key]: field[key] });
  }
  // text and Markdown (and a list's items) share «word limit»: it carries over between them
  if (field.maxWords !== undefined && LIMITS[type].includes('maxWords'))
    out.maxWords = field.maxWords;
  return out;
}

/** The fields with one moved from `from` to `to` (a move past either end does nothing). */
export function moveField<T>(items: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= items.length || from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved as T);
  return next;
}

export type FieldProblem =
  | 'name'
  | 'duplicate'
  | 'description'
  | 'maxWords'
  | 'maxItems'
  | 'bounds'
  | 'options';

const whole = (value: number | undefined, min: number, max: number): boolean =>
  value === undefined || (Number.isSafeInteger(value) && value >= min && value <= max);
const finite = (value: number | undefined): boolean =>
  value === undefined || (Number.isFinite(value) && Math.abs(value) <= 1e12);

/** What is wrong with each field, by position (null: nothing). These are the checks `compileForm` makes. */
export function fieldProblems(fields: readonly FormField[]): (FieldProblem | null)[] {
  return fields.map((field, index): FieldProblem | null => {
    if (!NAME_PATTERN.test(field.name)) return 'name';
    if (fields.findIndex((item) => item.name === field.name) !== index) return 'duplicate';
    if (field.description.length > MAX_DESCRIPTION) return 'description';
    if (!whole(field.maxWords, 1, 8000)) return 'maxWords';
    if (!whole(field.maxItems, 0, 100)) return 'maxItems';
    if (!finite(field.min) || !finite(field.max)) return 'bounds';
    if (field.min !== undefined && field.max !== undefined && field.min > field.max)
      return 'bounds';
    if (field.type === 'choice') {
      const options = field.options ?? [];
      if (
        options.length < 1 ||
        options.length > MAX_OPTIONS ||
        new Set(options).size !== options.length ||
        options.some((option) => !option.trim() || option.length > 200)
      )
        return 'options';
    }
    return null;
  });
}

/** The JSON Schema the server will give the assistants for these fields, or the reason it cannot (its own word for it). */
export function previewSchema(
  fields: readonly FormField[],
): { schema: Record<string, unknown> } | { reason: string } {
  try {
    return { schema: compileForm(structuredClone([...fields])) as Record<string, unknown> };
  } catch (error) {
    return { reason: error instanceof Error ? error.message : 'form_fields' };
  }
}

/** The fields of a built-in form, read from its schema (a built-in form has no field list of its own on the server). */
export interface SchemaField {
  name: string;
  type: string;
  description: string;
  required: boolean;
}
export function fieldsOfSchema(schema: Record<string, unknown> | undefined): SchemaField[] {
  const properties = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : []);
  return Object.entries(properties).map(([name, property]) => {
    const inner =
      (property.anyOf as Record<string, unknown>[] | undefined)?.find(
        (item) => item.type !== 'null',
      ) ?? property;
    const type = Array.isArray(inner.enum) ? 'choice' : String(inner.type ?? 'object');
    return {
      name,
      type,
      description: typeof property.description === 'string' ? property.description : '',
      required: required.has(name),
    };
  });
}
