// The values of a Library entry as the edit form holds them (pure, so a test can pin it): a prompt's name, form, inputs and text; an
// output form's name and fields. What the form compares with the saved entry, and what a save sends.

import type { FormField, LibraryView } from '../../../../src/shared/library.ts';

export type Kind = 'prompts' | 'forms';
export type PromptView = LibraryView['prompts'][number];
export type FormView = LibraryView['forms'][number];
export type EntryView = PromptView | FormView;

export interface PromptValues {
  name: string;
  form: string | null;
  inputs: 'with' | 'without' | 'any';
  text: string;
}
export interface FormValues {
  name: string;
  fields: FormField[];
}
export type Values = PromptValues | FormValues;

/** The values of an entry as the form shows them (a copy: the form never edits the entry it was made from). */
export function valuesOf(kind: Kind, entry: EntryView): Values {
  if (kind === 'prompts') {
    const prompt = entry as PromptView;
    return { name: prompt.name, form: prompt.form, inputs: prompt.inputs, text: prompt.text };
  }
  return { name: entry.name, fields: structuredClone((entry as FormView).fields) };
}

/** A new entry, before it is saved. */
export function blankValues(kind: Kind): Values {
  return kind === 'prompts'
    ? { name: '', form: null, inputs: 'any', text: '' }
    : { name: '', fields: [{ name: 'answer', type: 'text', description: '', required: true }] };
}

export const sameValues = (a: Values, b: Values): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** What the server is sent for these values. */
export const bodyOf = (kind: Kind, values: Values): Record<string, unknown> =>
  kind === 'prompts'
    ? {
        name: values.name.trim(),
        form: (values as PromptValues).form,
        inputs: (values as PromptValues).inputs,
        text: (values as PromptValues).text,
      }
    : { name: values.name.trim(), fields: (values as FormValues).fields };
