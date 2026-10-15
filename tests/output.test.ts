// A long output is bounded, and its end (the final answer and the usage) always survives: a harness that streams every token
// of its thinking can print many megabytes before it says its last word. What a long stream adds up to is added up as its
// lines arrive, never read from the bounded buffer.

import { describe, expect, it } from 'vitest';
import { adapterFor, runWithAdapter } from '../src/server/adapters/index.ts';
import type { Adapter, RunSpec } from '../src/server/adapters/types.ts';
import { BoundedOutput, endsOf } from '../src/server/output.ts';
import { runProc } from '../src/server/proc.ts';

const MIB = 1024 * 1024;

/** A process that prints `noiseMiB` of JSON-lines noise (with `middle` printed once the noise is half done), then `final`. */
const printer = (noiseMiB: number, final: string[], middle: string[] = []) => `
const line = JSON.stringify({ type: 'noise', pad: 'x'.repeat(900) }) + '\\n';
const write = (text) => process.stdout.write(text);
const total = ${noiseMiB} * 1024 * 1024;
let written = 0;
let said = false;
while (written < total) {
  write(line);
  written += line.length;
  if (!said && written > total / 2) {
    said = true;
    for (const text of ${JSON.stringify(middle)}) write(text + '\\n');
  }
}
for (const text of ${JSON.stringify(final)}) write(text + '\\n');
`;

const spec: RunSpec = {
  harness: 'codex',
  model: 'm',
  effort: '',
  tools: false,
  memory: false,
  web: false,
  prompt: '',
  schema: {},
  idleMs: 60_000,
};

describe('the bound on an output', () => {
  it('a short output is kept whole, and says nothing was left out', () => {
    const out = new BoundedOutput(100, 100);
    out.push('{"a":1}\n');
    out.push('{"b":2}\n');
    expect(out.elided).toBe(false);
    expect(out.toString()).toBe('{"a":1}\n{"b":2}\n');
  });

  it('a long one keeps its beginning and its end, whole lines only, and says how much it left out', () => {
    const out = new BoundedOutput(60, 60);
    const lines = Array.from({ length: 100 }, (_, i) => `{"n":${String(i).padStart(3, '0')}}\n`);
    for (const line of lines) out.push(line);
    const text = out.toString();
    expect(out.elided).toBe(true);
    expect(text.startsWith('{"n":000}\n')).toBe(true);
    expect(text.endsWith('{"n":099}\n')).toBe(true);
    expect(text).toMatch(/\[\.\.\. \d+ characters of output left out \.\.\.\]\n/u);
    // every line in it is a whole line of the original, or the one note
    for (const line of text.split('\n').filter(Boolean)) {
      expect(line.startsWith('[...') || /^\{"n":\d{3}\}$/u.test(line), line).toBe(true);
    }
    expect(text.length).toBeLessThan(60 + 60 + 80);
  });

  it('endsOf keeps the first and the last of a long text, and a short one whole', () => {
    expect(endsOf('short', 10, 10)).toBe('short');
    const long = `${'a'.repeat(50)}${'z'.repeat(50)}`;
    const cut = endsOf(long, 10, 10);
    expect(cut.startsWith('a'.repeat(10))).toBe(true);
    expect(cut.endsWith('z'.repeat(10))).toBe(true);
    expect(cut).toContain('80 characters left out');
  });
});

describe('a process that prints more than the old limit of 8 MiB', () => {
  it('Codex: the final message and the usage come last and survive 10 MiB of noise before them', async () => {
    const message = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '{"answer":"THE-FINAL-ANSWER"}' },
    });
    const turn = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 300 },
    });
    const result = await runProc({
      command: process.execPath,
      args: ['-e', printer(10, [message, turn])],
      cwd: process.cwd(),
      idleMs: 60_000,
    });
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    // bounded: far less than what was printed
    expect(result.stdout.length).toBeLessThan(7 * MIB);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toMatch(/characters of output left out/u);
    const parsed = adapterFor('codex').parse(result, spec);
    expect(parsed.error).toBeNull();
    expect(parsed.text).toBe('{"answer":"THE-FINAL-ANSWER"}');
    expect(parsed.usage).toMatchObject({ input: 800, cached: 200, output: 300, total: 1300 });
  }, 60_000);

  it('Claude: the result event is last and survives', async () => {
    const final = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: '',
      structured_output: { answer: 'CLAUDE-FINAL' },
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
    });
    const result = await runProc({
      command: process.execPath,
      args: ['-e', printer(9, [final])],
      cwd: process.cwd(),
      idleMs: 60_000,
    });
    const parsed = adapterFor('claude').parse(result, { ...spec, harness: 'claude' });
    expect(parsed.error).toBeNull();
    expect(JSON.parse(parsed.text)).toEqual({ answer: 'CLAUDE-FINAL' });
    expect(parsed.usage?.output).toBe(20);
  }, 60_000);

  it('stderr is bounded as well, and its end (where the error is) is kept', async () => {
    const script = `
const line = 'e'.repeat(1000) + '\\n';
for (let i = 0; i < 3000; i += 1) process.stderr.write(line);
process.stderr.write('THE-LAST-ERROR\\n');
`;
    const result = await runProc({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      idleMs: 60_000,
    });
    expect(result.stderr.length).toBeLessThan(1 * MIB);
    expect(result.stderr.trimEnd().endsWith('THE-LAST-ERROR')).toBe(true);
  }, 60_000);
});

describe('Pi: its usage is added up as the lines arrive, whatever the buffer still holds', () => {
  const message = (role: string, text: string, input: number, output: number) =>
    JSON.stringify({
      type: 'message_end',
      message: {
        role,
        content: [{ type: 'text', text }],
        stopReason: 'stop',
        usage: { input, output, cacheRead: 0, cacheWrite: 0 },
      },
    });
  const piWith = (script: string): Adapter => ({
    ...adapterFor('pi'),
    build: () => ({ command: process.execPath, args: ['-e', script] }),
  });
  const piSpec: RunSpec = { ...spec, harness: 'pi' };
  /** The start of a child script: `out` writes a line, `flood()` is a tool result of 500,000 characters (built in the child). */
  const prelude = `
const out = (text) => process.stdout.write(text + String.fromCharCode(10));
const flood = () => JSON.stringify({ type: 'message_end', message: { role: 'toolResult', content: [{ type: 'text', text: 'T'.repeat(500000) }], usage: { input: 7, output: 7 } } });
`;

  it('assistant usage after a flood of tool results is still counted; the last assistant message is the answer', async () => {
    // an early assistant message (10 in, 20 out), then 5 MiB of bulky tool results that fill the buffers many times over,
    // then the assistant's next message (100 in, 200 out) and its last one (1000 in, 2000 out) with the answer
    const script = `${prelude}
out(${JSON.stringify(message('assistant', 'first thought', 10, 20))});
for (let i = 0; i < 10; i += 1) out(flood());
out(${JSON.stringify(message('assistant', 'second thought', 100, 200))});
for (let i = 0; i < 10; i += 1) out(flood());
out(${JSON.stringify(message('assistant', '{"answer":"PI-FINAL"}', 1000, 2000))});
`;
    const run = await runWithAdapter(piWith(script), piSpec);
    expect(run.error).toBeNull();
    expect(run.text).toBe('{"answer":"PI-FINAL"}');
    // all three assistant messages, and none of the tool results (7 each): 1110 in, 2220 out
    expect(run.usage).toMatchObject({ input: 1110, output: 2220 });
  }, 60_000);

  it('the buffer really did lose the middle: read from the buffer alone the usage is short, and the stream’s own count is right', async () => {
    // an assistant message (10 in, 20 out) in the middle of a flood, and the last one (100, 200) at the end
    const script = `${prelude}
for (let i = 0; i < 8; i += 1) out(flood());
out(${JSON.stringify(message('assistant', 'in the middle', 10, 20))});
for (let i = 0; i < 20; i += 1) out(flood());
out(${JSON.stringify(message('assistant', 'last', 100, 200))});
`;
    const result = await runProc({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      idleMs: 60_000,
    });
    expect(result.truncated).toBe(true);
    expect(adapterFor('pi').parse(result, piSpec).usage).toMatchObject({ input: 100, output: 200 });
    // the same run through the adapter: nothing is lost
    const run = await runWithAdapter(piWith(script), piSpec);
    expect(run.text).toBe('last');
    expect(run.usage).toMatchObject({ input: 110, output: 220 });
  }, 60_000);

  it('a run that was not cut is read from its output as before', async () => {
    const script = `
const out = (text) => process.stdout.write(text + '\\n');
out(${JSON.stringify(message('assistant', 'one', 1, 2))});
out(${JSON.stringify(message('assistant', 'two', 3, 4))});
`;
    const run = await runWithAdapter(piWith(script), piSpec);
    expect(run.text).toBe('two');
    expect(run.usage).toMatchObject({ input: 4, output: 6 });
  });
});
