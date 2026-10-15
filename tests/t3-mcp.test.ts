// The T3 threads server as a harness runs it: a `node` process that speaks MCP over stdio (src/server/t3-mcp.ts), started with the
// command Divan gives the harnesses, against a fixture database.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { T3_SCRIPT, t3Launch } from '../src/server/t3-access.ts';
import { T3_TOOLS } from '../src/shared/readonly-tools.ts';
import {
  type Fixture,
  fillT3Database,
  makeT3Database,
  THREAD_A,
  TITLE_A,
} from './helpers/t3-fixture.ts';

let folder: string;
let writer: Fixture;
let child: ChildProcess;
let output = '';
let errors = '';
const waiting = new Map<number, (message: Answer) => void>();
let serial = 0;

function send(message: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}
/** What a reply holds, as far as the tests look (a reply has either `result` or `error`). */
interface Answer {
  result: {
    protocolVersion: string;
    capabilities: object;
    serverInfo: { name: string };
    tools: unknown;
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  error: { code: number; message: string };
}
function rpc(method: string, params?: unknown): Promise<Answer> {
  serial += 1;
  const id = serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer to ${method}`)), 15_000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'divan-t3mcp-'));
  const file = join(folder, 'statev2.sqlite');
  writer = makeT3Database(file);
  fillT3Database(writer);
  // the command a harness is given, with the fixture as the database
  const launch = t3Launch();
  child = spawn(launch.command, launch.args, {
    env: { ...process.env, DIVAN_T3_DB: file },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    errors += chunk;
  });
  let pending = '';
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const message = JSON.parse(line) as Answer & { id?: number };
      if (typeof message.id === 'number') waiting.get(message.id)?.(message);
    }
  });
});
afterAll(async () => {
  child.stdin?.end();
  await new Promise((resolve) => child.once('exit', resolve));
  writer.close();
  rmSync(folder, { recursive: true, force: true });
});

describe('the T3 threads MCP server', () => {
  it('is started by `node` on the TypeScript file itself, with the database in its environment', () => {
    const launch = t3Launch();
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(['--disable-warning=ExperimentalWarning', T3_SCRIPT]);
    expect(T3_SCRIPT).toMatch(/src[\\/]server[\\/]t3-mcp\.ts$/u);
    expect(Object.keys(launch.env)).toEqual(['DIVAN_T3_DB']);
  });

  it('initializes, and offers the tools capability only', async () => {
    const reply = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(Object.keys(reply.result.capabilities)).toEqual(['tools']);
    expect(reply.result.serverInfo.name).toBe('divan-t3');
    // an older version a client asks for is answered in kind; one it does not know gets the server's own
    expect(
      (await rpc('initialize', { protocolVersion: '2024-11-05' })).result.protocolVersion,
    ).toBe('2024-11-05');
    expect(
      (await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion,
    ).toBe('2025-06-18');
    // a notification gets no answer
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect((await rpc('ping')).result).toEqual({});
  });

  it('lists exactly the three read tools, each marked read-only, with a schema', async () => {
    const reply = await rpc('tools/list');
    const tools = reply.result.tools as {
      name: string;
      inputSchema: { type: string; required?: string[] };
      annotations: Record<string, unknown>;
    }[];
    expect(tools.map((tool) => tool.name)).toEqual([...T3_TOOLS]);
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
    }
    expect(tools[0]?.inputSchema.required).toEqual(['threadId']);
    expect(tools[1]?.inputSchema.required).toEqual(['query']);
  });

  it('reads, searches and lists through tools/call', async () => {
    const read = await rpc('tools/call', {
      name: 't3_thread_read',
      arguments: { threadId: THREAD_A },
    });
    expect(read.result.isError).toBeUndefined();
    expect(read.result.content[0]?.type).toBe('text');
    expect(read.result.content[0]?.text).toContain(`Title: ${TITLE_A}`);
    const found = await rpc('tools/call', {
      name: 't3_thread_search',
      arguments: { query: 'کارپاتی' },
    });
    expect(found.result.content[0]?.text).toContain(THREAD_A);
    const listed = await rpc('tools/call', { name: 't3_thread_list', arguments: { limit: 2 } });
    expect(listed.result.content[0]?.text.match(/^- /gmu)).toHaveLength(2);
    const bare = await rpc('tools/call', { name: 't3_thread_list' });
    expect(bare.result.isError).toBeUndefined();
  });

  it('a bad argument is a tool error the model can read; an unknown tool or method is a protocol error', async () => {
    const bad = await rpc('tools/call', {
      name: 't3_thread_read',
      arguments: { threadId: 'nope' },
    });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]?.text).toMatch(/must be a T3 Code thread id/u);
    const missing = await rpc('tools/call', { name: 't3_thread_read', arguments: {} });
    expect(missing.result.isError).toBe(true);
    const unknown = await rpc('tools/call', { name: 't3_thread_send', arguments: {} });
    expect(unknown.error.code).toBe(-32602);
    expect((await rpc('resources/list')).error.code).toBe(-32601);
  });

  it('prints protocol messages only: nothing else on stdout, nothing on stderr', async () => {
    for (const line of output.split('\n').filter(Boolean)) {
      expect(JSON.parse(line).jsonrpc).toBe('2.0');
    }
    expect(errors).toBe('');
  });
});
