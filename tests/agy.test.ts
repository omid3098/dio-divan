import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import type { RunSpec } from '../src/server/adapters/types.ts';
import type { ProcResult } from '../src/server/proc.ts';

const run = vi.hoisted(() => vi.fn());
vi.mock('../src/server/proc.ts', () => ({
  resolveCommand: () => ({ command: 'agy-fixture', prefix: [] }),
  runProc: run,
}));
const root = mkdtempSync(join(tmpdir(), 'divan-agy-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const spec: RunSpec = {
  harness: 'agy',
  model: 'gemini-3.8-flash',
  effort: 'low',
  tools: false,
  memory: false,
  web: false,
  idleMs: 1000,
  prompt: `Q\n${'x'.repeat(80000)}`,
  cwd: '/project',
  schema: {
    type: 'object',
    title: 'private identity',
    properties: { ok: { type: 'boolean', description: 'private rules' } },
    required: ['ok'],
    additionalProperties: false,
  },
};
const proc = (stdout = '', over: Partial<ProcResult> = {}): ProcResult => ({
  stdout,
  stderr: '',
  code: 0,
  timedOut: false,
  cancelled: false,
  spawnError: null,
  durationMs: 1,
  ...over,
});
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'adapters', name), 'utf8');

it('sends long context on stdin, a blind schema from a file, and the project as data from an empty scratch folder', async () => {
  const { agyAdapter } = await import('../src/server/adapters/agy.ts');
  const built = await agyAdapter.build(spec, join(root, 'io'), join(root, 'work'));
  if ('error' in built) throw new Error(built.error);
  expect(built.args).toEqual([
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--json-schema',
    join(root, 'io', 'schema.json'),
    '--model',
    spec.model,
    '--effort',
    'low',
    '--print-timeout',
    '0',
  ]);
  expect(built.args.join(' ').length).toBeLessThan(1000);
  expect(built.cwd).toBe(join(root, 'work'));
  const input = JSON.parse(built.stdin ?? '');
  expect(input.event).toBe('user');
  expect(input.message.content).toContain(spec.prompt);
  expect(input.message.content).toContain('"/project"');
  expect(readFileSync(join(root, 'io', 'schema.json'), 'utf8')).not.toMatch(
    /private|description|title/u,
  );
  const display = await agyAdapter.build(
    { ...spec, effort: '', model: 'Gemini 3.8 Flash (High)' },
    join(root, 'io'),
    join(root, 'work'),
  );
  if ('error' in display) throw new Error(display.error);
  expect(display.args).not.toContain('--effort');
});

it('reads the real nested result, keeps the validated submission over chatter, and counts per-step usage once on interruption', async () => {
  const { agyAdapter } = await import('../src/server/adapters/agy.ts');
  const stream = fixture('agy-answer.jsonl');
  expect(agyAdapter.parse(proc(stream), spec)).toEqual({
    text: '{"ok":true}',
    error: null,
    usage: { input: 24156, output: 34, cached: 0, total: 24190, source: 'harness' },
  });
  const watcher = agyAdapter.watch?.(spec);
  for (let i = 0; i < stream.length; i += 7) watcher?.push(stream.slice(i, i + 7));
  expect(watcher?.streamed?.()).toEqual(agyAdapter.parse(proc(stream), spec));
  const partial = stream
    .split('\n')
    .filter((line) => !line.includes('"event":"result"'))
    .join('\n');
  expect(agyAdapter.parse(proc(partial, { cancelled: true, code: null }), spec).usage?.total).toBe(
    24190,
  );
  const step = JSON.stringify({
    event: 'step_update',
    step_update: {
      step_index: 1,
      state: 'DONE',
      step_type: 'agent_response',
      usage: {
        input_tokens: 100,
        output_tokens: 30,
        cache_read_tokens: 80,
        thinking_tokens: 20,
        total_tokens: 130,
      },
    },
  });
  expect(agyAdapter.parse(proc(`${step}\n${step}\n`), spec).usage).toEqual({
    input: 20,
    cached: 80,
    output: 30,
    total: 130,
    source: 'harness',
  });
  expect(
    agyAdapter.parse(
      proc('', { code: 1, stderr: 'flags provided but not defined: -input-format' }),
      spec,
    ).error,
  ).toContain('does not support stream-json');
  expect(
    agyAdapter.parse(
      proc(
        '{"event":"result","result":{"status":"ERROR","error":"provider failed","usage":{"input_tokens":12,"output_tokens":0,"total_tokens":12}}}\n',
      ),
      spec,
    ),
  ).toMatchObject({ error: 'provider failed', usage: { total: 12 } });
});

it('deduplicates documented tool steps, strips URL credentials and arguments, and leaves write-capable activity running', async () => {
  const { agyAdapter } = await import('../src/server/adapters/agy.ts');
  const watcher = agyAdapter.watch?.(spec);
  const tools = [];
  const stream = fixture('agy-tools.jsonl');
  for (let i = 0; i < stream.length; i += 7)
    tools.push(...(watcher?.push(stream.slice(i, i + 7))?.tools ?? []));
  expect(tools).toEqual([
    { kind: 'file', name: 'view_file', target: '/project/notes.md' },
    { kind: 'file', name: 'run_command', target: '' },
    { kind: 'web', name: 'read_url_content', target: 'https://example.test/page' },
    { kind: 'other', name: 'write_to_file', target: '/scratch/file' },
  ]);
  expect(JSON.stringify(tools)).not.toContain('secret');
});

it('checks stdin support before catalogue discovery and falls back only to typed ids when JSON listing is unsupported', async () => {
  vi.resetModules();
  run.mockReset().mockResolvedValueOnce(proc('old help')).mockResolvedValue(proc(''));
  let { agyAdapter } = await import('../src/server/adapters/agy.ts');
  expect((await agyAdapter.listModels()).note?.code).toBe('agy_incompatible');
  expect(run).toHaveBeenCalledTimes(1);
  vi.resetModules();
  run
    .mockReset()
    .mockResolvedValueOnce(proc('--input-format text, stream-json'))
    .mockResolvedValue(
      proc('', { code: 1, stderr: 'flags provided but not defined: -output-format' }),
    );
  ({ agyAdapter } = await import('../src/server/adapters/agy.ts'));
  expect(await agyAdapter.listModels()).toMatchObject({
    listed: false,
    models: [],
    note: { code: 'agy_models_typed' },
  });
  expect(run.mock.calls[1]?.[0].args).toEqual(['models', '--output-format', 'json']);
  expect(
    run.mock.calls.every(
      ([args]) => args.cwd.startsWith(tmpdir()) && args.env.DIVAN_MEMORY_TOKEN === undefined,
    ),
  ).toBe(true);
});
