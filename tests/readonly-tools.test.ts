// The one allowlist of what a member may call (src/shared/readonly-tools.ts): its invariants.

import { describe, expect, it } from 'vitest';
import {
  allowedMcp,
  deniedMcp,
  grokMcpName,
  MEMORY_READ_TOOLS,
  MEMORY_SERVER,
  mcpName,
  NEVER_SERVERS,
  READ_ONLY_SERVERS,
  serversFor,
  T3_SERVER,
  T3_TOOLS,
} from '../src/shared/readonly-tools.ts';
import type { HarnessId } from '../src/shared/types.ts';

describe('the allowlist', () => {
  it('names every tool one by one: no wildcard, no whole server, a read tool is never also a writer', () => {
    for (const server of READ_ONLY_SERVERS) {
      expect(server.name, server.name).toMatch(/^[A-Za-z0-9_-]+$/u);
      for (const tool of [...server.read, ...server.write]) {
        expect(tool, `${server.name} ${tool}`).toMatch(/^[a-z0-9_]+$/u);
      }
      for (const tool of server.read) expect(server.write).not.toContain(tool);
      expect(new Set(server.read).size, server.name).toBe(server.read.length);
    }
    const all = [...allowedMcp(READ_ONLY_SERVERS), ...deniedMcp(READ_ONLY_SERVERS)];
    expect(all.some((name) => name.includes('*') || name.endsWith('__'))).toBe(false);
  });

  it('holds the memory server and the T3 threads server, and no browser or REPL server', () => {
    expect(READ_ONLY_SERVERS.map((server) => server.name)).toEqual([
      MEMORY_SERVER,
      T3_SERVER,
      'hermes_history',
    ]);
    for (const server of READ_ONLY_SERVERS) expect(NEVER_SERVERS).not.toContain(server.name);
    for (const never of ['codex-browser', 'node_repl', 'cua_repl'])
      expect(NEVER_SERVERS).toContain(never);
  });

  it('the memory server: the six read tools, and every writer denied by name', () => {
    expect(MEMORY_READ_TOOLS).toEqual([
      'whoami',
      'search',
      'get_page',
      'list_pages',
      'recent_changes',
      'ask',
    ]);
    expect(deniedMcp(READ_ONLY_SERVERS).map((name) => name.replace('mcp__memory__', ''))).toEqual([
      'put_page',
      'add_timeline_entry',
      'delete_page',
      'approve_proposal',
      'reject_proposal',
      'list_proposals',
    ]);
  });

  it('the T3 threads server: three read tools, no writer', () => {
    expect(T3_TOOLS).toEqual(['t3_thread_read', 't3_thread_search', 't3_thread_list']);
    const server = READ_ONLY_SERVERS.find((item) => item.name === T3_SERVER);
    expect(server?.read).toEqual(T3_TOOLS);
    expect(server?.write).toEqual([]);
    expect(server?.toggle).toBe('tools');
  });

  it('who gets what: the memory server by the memory toggle, the T3 server by the tools toggle', () => {
    const names = (harness: HarnessId, tools: boolean, memory: boolean) =>
      serversFor(harness, { tools, memory }).map((server) => server.name);
    for (const harness of ['claude', 'codex', 'grok', 'pi'] as const) {
      expect(names(harness, false, true), harness).toEqual(['memory']);
      expect(names(harness, true, false), harness).toEqual(['t3']);
      expect(names(harness, true, true), harness).toEqual(['memory', 't3']);
      expect(names(harness, false, false), harness).toEqual([]);
    }
    expect(names('agy', true, true)).toEqual([]);
  });

  it('tool names as each harness writes them', () => {
    expect(mcpName('memory', 'search')).toBe('mcp__memory__search');
    expect(grokMcpName('memory', 'search')).toBe('memory__search');
    expect(allowedMcp(READ_ONLY_SERVERS)).toHaveLength(11);
    expect(mcpName('t3', 't3_thread_read')).toBe('mcp__t3__t3_thread_read');
    expect(grokMcpName('t3', 't3_thread_read')).toBe('t3__t3_thread_read');
  });
});
