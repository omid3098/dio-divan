// The Library page's pure parts (web/src/pages/library): the field builder (what it refuses is what the server's `compileForm`
// refuses), moving and retyping a field, the schema the builder previews, the id of a new entry, and the values a form holds and
// sends. The page itself is in e2e/run.mjs.

import { describe, expect, it } from 'vitest';
import { libraryView } from '../src/server/library.ts';
import { compileForm, type FormField } from '../src/shared/library.ts';
import {
  fieldProblems,
  fieldsOfSchema,
  freshName,
  moveField,
  newField,
  previewSchema,
  retype,
} from '../web/src/pages/library/fields.ts';
import { ENTRY_ID, idProblem, suggestEntryId } from '../web/src/pages/library/ids.ts';
import {
  blankValues,
  bodyOf,
  type FormValues,
  type PromptValues,
  sameValues,
  valuesOf,
} from '../web/src/pages/library/values.ts';
import { branchLibrary } from './fixtures/flows.ts';

const field = (over: Partial<FormField> = {}): FormField => ({
  name: 'score',
  type: 'number',
  description: 'Score',
  required: true,
  ...over,
});

describe('the field builder refuses what the server refuses', () => {
  const cases: [string, FormField[]][] = [
    ['a name with a capital', [field({ name: 'Score' })]],
    ['a name that starts with a digit', [field({ name: '1st' })]],
    ['a name that is too long', [field({ name: 'a'.repeat(33) })]],
    ['two fields with one name', [field(), field()]],
    ['a description that is too long', [field({ description: 'x'.repeat(2001) })]],
    ['a word limit of 0', [field({ type: 'text', maxWords: 0 })]],
    ['a word limit above 8,000', [field({ type: 'text', maxWords: 8001 })]],
    ['a word limit that is not whole', [field({ type: 'text', maxWords: 2.5 })]],
    ['more than 100 items', [field({ type: 'list', maxItems: 101 })]],
    ['a smallest above the largest', [field({ min: 5, max: 1 })]],
    ['a number too large', [field({ max: 1e13 })]],
    ['a choice with no option', [field({ type: 'choice', options: [] })]],
    ['a choice with a repeated option', [field({ type: 'choice', options: ['a', 'a'] })]],
    ['a choice with a blank option', [field({ type: 'choice', options: ['a', ' '] })]],
    ['a choice with a long option', [field({ type: 'choice', options: ['x'.repeat(201)] })]],
  ];
  const fine: [string, FormField[]][] = [
    ['a number with bounds', [field({ min: 0, max: 10 })]],
    ['text with a word limit', [field({ name: 'note', type: 'text', maxWords: 30 })]],
    ['a list with limits', [field({ name: 'risks', type: 'list', maxItems: 0, maxWords: 1 })]],
    ['a choice', [field({ name: 'verdict', type: 'choice', options: ['pass', 'fail'] })]],
    ['a yes/no, optional', [field({ name: 'ok', type: 'boolean', required: false })]],
  ];

  for (const [name, fields] of cases) {
    it(`flags ${name}, and the server's compileForm throws`, () => {
      expect(fieldProblems(fields).some(Boolean)).toBe(true);
      expect(() => compileForm(fields)).toThrow();
    });
  }
  for (const [name, fields] of fine) {
    it(`accepts ${name}, and compileForm builds a schema`, () => {
      expect(fieldProblems(fields).every((problem) => problem === null)).toBe(true);
      expect(() => compileForm(fields)).not.toThrow();
    });
  }

  it('says which field, and why, by position', () => {
    expect(
      fieldProblems([
        field(),
        field({ name: 'Bad' }),
        field({ name: 'score' }),
        field({ name: 'pick', type: 'choice', options: [] }),
      ]),
    ).toEqual([null, 'name', 'duplicate', 'options']);
  });
});

describe('moving, adding and retyping fields', () => {
  it('moves a field and does nothing past either end', () => {
    expect(moveField(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveField(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(moveField(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moveField(['a', 'b', 'c'], 2, 3)).toEqual(['a', 'b', 'c']);
  });

  it('adds a field with a name no field has, and it is valid', () => {
    expect(freshName([])).toBe('field');
    expect(freshName([field({ name: 'field' }), field({ name: 'field_2' })])).toBe('field_3');
    const next = newField([field({ name: 'field' })]);
    expect(next).toMatchObject({ name: 'field_2', type: 'text', required: true });
    expect(fieldProblems([field({ name: 'field' }), next]).every((p) => p === null)).toBe(true);
  });

  it('keeps what a new type allows and drops a limit it does not (the server refuses one of another type)', () => {
    const number = field({ min: 0, max: 10 });
    expect(retype(number, 'text')).toEqual({
      name: 'score',
      type: 'text',
      description: 'Score',
      required: true,
    });
    const text = field({ name: 'note', type: 'text', maxWords: 30 });
    // the word limit carries over between text, Markdown and the items of a list
    expect(retype(text, 'markdown').maxWords).toBe(30);
    expect(retype(text, 'list').maxWords).toBe(30);
    expect(retype(text, 'number').maxWords).toBeUndefined();
    // a choice starts with no options, which is flagged until some are written
    const choice = retype(text, 'choice');
    expect(choice.options).toEqual([]);
    expect(fieldProblems([choice])).toEqual(['options']);
    // every retyped field is still one compileForm can read once it is complete
    for (const type of ['text', 'markdown', 'number', 'boolean', 'list'] as const) {
      expect(() => compileForm([retype(text, type)])).not.toThrow();
    }
  });
});

describe('the schema the builder previews', () => {
  it('is the schema the server will send, or the reason there is none', () => {
    const fields = [field(), field({ name: 'note', type: 'text', required: false, maxWords: 30 })];
    const preview = previewSchema(fields);
    expect('schema' in preview && preview.schema).toEqual(compileForm(fields));
    expect(previewSchema([field({ name: 'Bad' })])).toEqual({ reason: 'field_name' });
    expect(previewSchema([])).toEqual({ reason: 'form_fields' });
    expect(previewSchema([field({ min: 3, max: 1 })])).toEqual({ reason: 'field_bounds' });
  });

  it('reads the fields of a built-in form from its schema: type, description, required', () => {
    const view = libraryView(branchLibrary, []);
    const report = view.forms.find((form) => form.id === 'report');
    expect(fieldsOfSchema(report?.schema)).toEqual([
      expect.objectContaining({ name: 'report', type: 'string', required: true }),
    ]);
    const member = view.forms.find((form) => form.id === 'member');
    const byName = Object.fromEntries(fieldsOfSchema(member?.schema).map((f) => [f.name, f]));
    // the built-in member form is nested: a list of objects and an object that may be null
    expect(byName.claims?.type).toBe('array');
    expect(byName.recommendation?.type).toBe('object');
    expect(byName.stance).toMatchObject({ type: 'string', required: true });
    const assessment = view.forms.find((form) => form.id === 'assessment');
    expect(fieldsOfSchema(assessment?.schema).map((f) => [f.name, f.type])).toEqual([
      ['score', 'number'],
      ['note', 'string'],
    ]);
    const choice = compileForm([field({ name: 'v', type: 'choice', options: ['a', 'b'] })]);
    expect(fieldsOfSchema(choice)[0]?.type).toBe('choice');
  });
});

describe('the id of a new entry', () => {
  it('is suggested from the Latin words of the name, never a built-in form’s name or one that is taken', () => {
    expect(suggestEntryId('Check list', 'prompt', [])).toBe('check-list');
    expect(suggestEntryId('Check list', 'prompt', ['check-list'])).toBe('prompt-1');
    expect(suggestEntryId('Check list', 'prompt', ['check-list', 'prompt-1'])).toBe('prompt-2');
    // a name with no Latin letters, and a name that would be a built-in form's id, fall back to a numbered one
    expect(suggestEntryId('بررسی', 'form', [])).toBe('form-1');
    expect(suggestEntryId('Report', 'form', [])).toBe('form-1');
    // an id starts with a letter
    expect(suggestEntryId('2 cats', 'prompt', [])).toBe('cats');
    expect(suggestEntryId('x'.repeat(80), 'prompt', [])).toHaveLength(48);
    expect(ENTRY_ID.test(suggestEntryId('A_b c', 'prompt', []))).toBe(true);
  });

  it('says what is wrong with an id', () => {
    expect(idProblem('good-id_1', [])).toBeNull();
    expect(idProblem('Good', [])).toBe('pattern');
    expect(idProblem('1abc', [])).toBe('pattern');
    expect(idProblem('', [])).toBe('pattern');
    expect(idProblem('answer', [])).toBe('pattern');
    expect(idProblem('mine', ['mine'])).toBe('taken');
  });
});

describe('the values a form holds and sends', () => {
  const view = libraryView(branchLibrary, []);

  it('are a copy of the entry: editing them never touches it', () => {
    const entry = view.forms.find((form) => form.id === 'assessment');
    if (!entry) throw new Error('assessment');
    const values = valuesOf('forms', entry) as FormValues;
    expect(values.name).toBe('Assessment');
    expect(sameValues(values, valuesOf('forms', entry))).toBe(true);
    values.fields[0] = { ...(values.fields[0] as FormField), name: 'changed' };
    expect(entry.fields[0]?.name).toBe('score');
    expect(sameValues(values, valuesOf('forms', entry))).toBe(false);
  });

  it('start a new entry blank, and a new form with one field to fill in', () => {
    expect(blankValues('prompts')).toEqual({ name: '', form: null, inputs: 'any', text: '' });
    const form = blankValues('forms') as FormValues;
    expect(form.fields).toHaveLength(1);
    expect(fieldProblems(form.fields)).toEqual([null]);
  });

  it('are sent trimmed in the name, with what the server wants and nothing it does not', () => {
    const prompt = view.prompts.find((p) => p.id === 'check');
    if (!prompt) throw new Error('check');
    const values = { ...(valuesOf('prompts', prompt) as PromptValues), name: '  Check  ' };
    expect(bodyOf('prompts', values)).toEqual({
      name: 'Check',
      form: null,
      inputs: 'any',
      text: prompt.text,
    });
    expect(bodyOf('forms', { name: ' Form ', fields: [field()] })).toEqual({
      name: 'Form',
      fields: [field()],
    });
  });
});
