import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Engine } from '../src/server/engine.ts';
import { Gateway, identityOf } from '../src/server/gateway.ts';
import { builtinPrompts, resolveFlow } from '../src/server/library.ts';
import { parseCustom, validateSchema } from '../src/server/parse.ts';
import { SettingsService } from '../src/server/settings.ts';
import { Store } from '../src/server/store.ts';
import { agentsOf, storedFlow } from '../src/shared/flow.ts';
import { compileForm, type FormField } from '../src/shared/library.ts';
import { branchFlow, branchLibrary } from './fixtures/flows.ts';
import { requireValue } from './fixtures.ts';

let home: string;
let store: Store;
let settings: SettingsService;
beforeEach(async () => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '2';
  home = mkdtempSync(join(tmpdir(), 'divan-library-'));
  store = new Store(home);
  await store.init();
  settings = new SettingsService(store);
  await settings.view();
});
afterEach(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
async function model() {
  for (const form of branchLibrary.forms)
    await settings.editLibrary('forms', 'POST', undefined, { ...form });
  for (const prompt of branchLibrary.prompts)
    await settings.editLibrary('prompts', 'POST', undefined, { ...prompt });
  const made = await settings.create('Branch model');
  await settings.update(made.id, { flow: branchFlow() });
  return made.id;
}
it('200 settings reads reuse compiled schemas, and schema edits still validate before saving', async () => {
  await model();
  await settings.view();
  const compile = vi.spyOn(Ajv.prototype, 'compile');
  try {
    for (let i = 0; i < 200; i++) await settings.view();
    expect(compile).not.toHaveBeenCalled();
    const schema = {
      type: 'object',
      properties: { cache_probe: { type: 'number' } },
      additionalProperties: false,
    };
    validateSchema(schema);
    validateSchema({ additionalProperties: false, properties: schema.properties, type: 'object' });
    expect(compile).toHaveBeenCalledTimes(1);
    expect(() => validateSchema({ type: 'not-a-json-type' })).toThrow();
    const cache = (compile.mock.instances[0] as unknown as { _cache: Map<object, unknown> })._cache;
    for (const [compiled] of compile.mock.calls)
      if (typeof compiled === 'object') expect(cache.has(compiled)).toBe(false);
  } finally {
    compile.mockRestore();
  }
}, 20000);

it.each([
  ['custom_form_invalid', { score: 'bad', note: 'ok' }, { field: 'score' }],
  ['custom_form_bounds', { score: 11, note: 'ok' }, { field: 'score', min: 0, max: 10 }],
  [
    'custom_form_words',
    { score: 5, note: 'word '.repeat(31) },
    { field: 'note', max: 30, maxChars: 64000 },
  ],
  ['custom_form_items', { items: ['a', 'b'] }, { field: 'items', max: 1 }],
] as const)('%s keeps a readable error and coded parameters', (code, value, params) => {
  const fields: FormField[] =
    code === 'custom_form_items'
      ? [{ name: 'items', type: 'list', description: '', required: true, maxItems: 1 }]
      : requireValue(branchLibrary.forms[0]).fields;
  const parsed = parseCustom({ fields, text: JSON.stringify(value) });
  expect(parsed).toMatchObject({ ok: false, errorNote: { code, params } });
  if (!parsed.ok) {
    expect(parsed.error).toBe(parsed.errorNote?.message);
    expect(parsed.error).not.toContain(code);
  }
});
it('resolves a snapshot, freezes sessions, and separates cache and concurrent work after library edits', async () => {
  const id = await model();
  await settings.update(id, { flow: branchFlow('fake-slow') });
  const first = requireValue(await settings.profile(id));
  const oldIdentity = identityOf(first, []);
  const gateway = new Gateway(new Engine(store, () => {}), store, settings);
  const request = { model: id, messages: [{ role: 'user', content: 'What should I do?' }] };
  const a = await gateway.submit(request),
    b = await gateway.submit(request);
  const session = requireValue(store.get(requireValue(store.list()[0]).id));
  const frozen = JSON.stringify(session.settings.flow);
  const entry = requireValue((await settings.library()).prompts.find((p) => p.id === 'check'));
  expect(entry.usedBy).toEqual([id]);
  await settings.editLibrary('prompts', 'PUT', 'check', {
    text: 'New task text. Return the requested fields.',
    ifRevision: 1,
  });
  const next = requireValue(await settings.profile(id));
  expect(next.fingerprint).not.toBe(first.fingerprint);
  expect(identityOf(next, [])).not.toBe(oldIdentity);
  const changed = await gateway.submit(request);
  const [old, shared, fresh] = await Promise.all([a.done, b.done, changed.done]);
  expect(shared.sessionId).toBe(old.sessionId);
  expect(fresh.sessionId).not.toBe(old.sessionId);
  expect(fresh.cached).toBe(false);
  expect(JSON.stringify(session.settings.flow)).toBe(frozen);
  expect((await (await gateway.submit(request)).done).cached).toBe(true);
  const form = requireValue((await settings.library()).forms.find((f) => f.id === 'assessment'));
  await settings.editLibrary('forms', 'PUT', 'assessment', {
    fields: form.fields.map((f) => (f.name === 'score' ? { ...f, max: 20 } : f)),
    ifRevision: 1,
  });
  expect(identityOf(requireValue(await settings.profile(id)), [])).not.toBe(identityOf(next, []));
  expect(
    store
      .readSettings()
      .profiles[id]?.flow?.nodes.some((n) => n.kind === 'agent' && ('rules' in n || 'schema' in n)),
  ).toBe(false);
}, 10000);
it('refuses used deletion, stale writes and condition-breaking edits atomically, including prompt-to-form uses', async () => {
  const id = await model();
  const before = JSON.stringify(store.readSettings());
  await expect(settings.editLibrary('forms', 'DELETE', 'assessment', {})).rejects.toMatchObject({
    code: 'library_in_use',
    details: { models: [id], prompts: [] },
  });
  await expect(settings.editLibrary('prompts', 'DELETE', 'check', {})).rejects.toMatchObject({
    code: 'library_in_use',
  });
  await expect(
    settings.editLibrary('forms', 'PUT', 'assessment', { ifRevision: 0 }),
  ).rejects.toMatchObject({ code: 'library_stale', details: { entry: { revision: 1 } } });
  await expect(
    settings.editLibrary('forms', 'PUT', 'assessment', {
      ifRevision: 1,
      fields: [{ name: 'note', type: 'text', required: true, description: 'note' }],
    }),
  ).rejects.toMatchObject({ code: 'library_invalidates_model' });
  expect(JSON.stringify(store.readSettings())).toBe(before);
  await settings.remove(id);
  await settings.editLibrary('prompts', 'PUT', 'check', { form: 'assessment', ifRevision: 1 });
  await expect(settings.editLibrary('forms', 'DELETE', 'assessment', {})).rejects.toMatchObject({
    code: 'library_in_use',
    details: { prompts: ['check'] },
  });
});
it('an invalid stored flow blocks only that model, without crashing the settings view', async () => {
  const id = await model();
  await store.updateSettings((file) => {
    requireValue(file.profiles[id]).flow = storedFlow(branchFlow());
    const n = file.profiles[id]?.flow?.nodes.find((n) => n.kind === 'agent');
    if (n?.kind === 'agent') n.prompt = 'gone';
    return file;
  });
  const view = await settings.view();
  expect(view.profiles.find((p) => p.id === id)?.blocked).toMatchObject({ code: 'flow_invalid' });
  expect(view.profiles.find((p) => p.id === 'default')?.blocked).toBeUndefined();
  await store.updateSettings((file) => {
    requireValue(file.profiles[id]).flow = {} as import('../src/shared/flow.ts').StoredFlow;
    return file;
  });
  expect((await settings.profile(id))?.blocked?.code).toBe('flow_invalid');
  await expect(settings.library()).resolves.toHaveProperty('prompts');
});
it('strict custom forms keep literal fields, nullable keys, bounds and list caps without clamping or prose recovery', () => {
  const fields: FormField[] = [
    { name: 'votes', type: 'number', description: 'score', required: true, min: 2, max: 4 },
    {
      name: 'register',
      type: 'choice',
      description: 'class',
      required: true,
      options: ['yes', 'no'],
    },
    {
      name: 'memory_facts',
      type: 'list',
      description: 'notes',
      required: false,
      maxItems: 1,
      maxWords: 2,
    },
  ];
  const schema = compileForm(fields);
  expect(schema.required).toEqual(['votes', 'register', 'memory_facts']);
  expect(JSON.stringify(schema)).not.toMatch(/minimum|maximum|maxItems|x-maxWords/u);
  expect(
    parseCustom({ fields, text: '{"votes":3,"register":"yes","memory_facts":null}' }),
  ).toMatchObject({ ok: true, value: { votes: 3 } });
  for (const value of [
    { votes: 1, register: 'yes', memory_facts: [] },
    { votes: 3, register: 'bad', memory_facts: [] },
    { votes: 3, register: 'yes', memory_facts: ['a', 'b'] },
    { votes: 3, register: 'yes', memory_facts: ['too many words'] },
    { votes: 3, register: 'yes' },
    { votes: '3', register: 'yes', memory_facts: null },
    { votes: 3, register: 'yes', memory_facts: null, extra: true },
  ])
    expect(parseCustom({ fields, text: JSON.stringify(value) }).ok).toBe(false);
  expect(parseCustom({ fields, text: 'A long report '.repeat(40) }).ok).toBe(false);
  const flow = branchFlow();
  requireValue(agentsOf(flow).find((a) => a.id === 'source')).role = 'rewriter';
  expect(() => resolveFlow(flow, branchLibrary)).not.toThrow();
  expect(builtinPrompts().find((p) => p.id === 'divan.critic')?.text).toContain(
    'Criticise the supplied draft: check its claims at their sources',
  );
});
