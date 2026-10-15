import type { JsonSchema } from './types.ts';

export interface FormField {
  name: string;
  type: 'text' | 'markdown' | 'number' | 'boolean' | 'choice' | 'list';
  description: string;
  required: boolean;
  options?: string[];
  maxWords?: number;
  min?: number;
  max?: number;
  maxItems?: number;
}
export interface PromptEntry {
  id: string;
  name: string;
  form: string | null;
  inputs: 'with' | 'without' | 'any';
  text: string;
  revision: number;
}
export interface FormEntry {
  id: string;
  name: string;
  fields: FormField[];
  revision: number;
}
export interface Library {
  prompts: PromptEntry[];
  forms: FormEntry[];
}
export interface LibraryView {
  prompts: (PromptEntry & { builtin: boolean; usedBy: string[] })[];
  forms: (FormEntry & { builtin: boolean; usedBy: string[]; schema: JsonSchema })[];
}
export const BUILTIN_FORMS = ['report', 'member', 'answer'];
export const builtinForm = (id: string): boolean => BUILTIN_FORMS.includes(id);
export const emptyLibrary = (): Library => ({ prompts: [], forms: [] });

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
  }
}
export function validateEntry(entry: { id: string; name: string; revision: number }): void {
  if (!/^[a-z][a-z0-9_-]{0,47}$/u.test(entry.id) || builtinForm(entry.id))
    throw new LibraryError('entry_id');
  if (typeof entry.name !== 'string' || !entry.name.trim() || entry.name.length > 100)
    throw new LibraryError('entry_name');
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 1)
    throw new LibraryError('entry_revision');
}
export function validatePrompt(entry: PromptEntry): void {
  validateEntry(entry);
  if (
    entry.form !== null &&
    (typeof entry.form !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/u.test(entry.form))
  )
    throw new LibraryError('prompt_form');
  if (!['with', 'without', 'any'].includes(entry.inputs)) throw new LibraryError('prompt_inputs');
  if (typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 64000)
    throw new LibraryError('prompt_text');
}

/** Provider schemas deliberately carry no local bounds: all CLIs can use this small subset. */
export function compileForm(fields: FormField[]): JsonSchema {
  if (!Array.isArray(fields) || fields.length < 1 || fields.length > 30)
    throw new LibraryError('form_fields');
  const properties: JsonSchema = {};
  const integer = (value: number | undefined, min: number, max: number): boolean =>
    value === undefined || (Number.isSafeInteger(value) && value >= min && value <= max);
  for (const field of fields) {
    if (
      !field ||
      !/^[a-z][a-z0-9_]{0,31}$/u.test(field.name) ||
      Object.hasOwn(properties, field.name)
    )
      throw new LibraryError('field_name');
    if (
      !['text', 'markdown', 'number', 'boolean', 'choice', 'list'].includes(field.type) ||
      typeof field.required !== 'boolean'
    )
      throw new LibraryError('field_type');
    if (typeof field.description !== 'string' || field.description.length > 2000)
      throw new LibraryError('field_description');
    if (!integer(field.maxWords, 1, 8000) || !integer(field.maxItems, 0, 100))
      throw new LibraryError('field_limit');
    if (
      [field.min, field.max].some(
        (v) =>
          v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e12),
      ) ||
      (field.min !== undefined && field.max !== undefined && field.min > field.max)
    )
      throw new LibraryError('field_bounds');
    if (
      (field.options !== undefined && field.type !== 'choice') ||
      ((field.min !== undefined || field.max !== undefined) && field.type !== 'number') ||
      (field.maxItems !== undefined && field.type !== 'list') ||
      (field.maxWords !== undefined && !['text', 'markdown', 'list'].includes(field.type))
    )
      throw new LibraryError('field_limit_type');
    let schema: JsonSchema;
    if (field.type === 'choice') {
      if (
        !Array.isArray(field.options) ||
        !field.options.length ||
        field.options.length > 50 ||
        new Set(field.options).size !== field.options.length ||
        field.options.some((v) => typeof v !== 'string' || !v.trim() || v.length > 200)
      )
        throw new LibraryError('field_options');
      schema = { type: 'string', enum: field.options };
    } else if (field.type === 'list') schema = { type: 'array', items: { type: 'string' } };
    else schema = { type: ['text', 'markdown'].includes(field.type) ? 'string' : field.type };
    properties[field.name] = {
      ...(field.required ? schema : { anyOf: [schema, { type: 'null' }] }),
      description: field.description,
    };
  }
  const schema = {
    type: 'object',
    properties,
    required: fields.map((f) => f.name),
    additionalProperties: false,
  };
  if (JSON.stringify(schema).length > 64000) throw new LibraryError('form_size');
  return schema;
}

export function fieldSection(fields: FormField[]): string {
  return `Output fields (return exactly these keys; optional keys must be null when absent)\n${fields
    .map((f) => {
      const limits = [
        f.type,
        f.required ? 'required' : 'nullable',
        ...(['text', 'markdown', 'list'].includes(f.type)
          ? [
              `at most ${f.maxWords ?? (f.type === 'markdown' ? 8000 : 2000)} words${f.type === 'list' ? ' per item' : ''}, 64000 characters per text`,
            ]
          : []),
        ...(f.min === undefined ? [] : [`minimum ${f.min}`]),
        ...(f.max === undefined ? [] : [`maximum ${f.max}`]),
        ...(f.type === 'list' ? [`at most ${f.maxItems ?? 20} items`] : []),
        ...(f.options ? [`one of ${JSON.stringify(f.options)}`] : []),
      ];
      return `${f.name}: ${f.description} (${limits.join('; ')})`;
    })
    .join('\n')}`;
}
