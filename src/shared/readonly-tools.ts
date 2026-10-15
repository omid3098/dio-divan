// The one list of what a council member may call besides the harness's own read tools. Members use each harness's normal
// reach (its settings, instructions, MCP servers and memory), and read-only is kept by an allowlist: a tool of an MCP server is
// reachable only if it is named here, and everything not named is denied. The adapters build every harness's flags from this
// table. Two servers are in it: the memory server (the "memory" toggle) and Divan's own T3 threads server (the "tools"
// toggle, a small local process that reads T3 Code's database read-only); any browser or REPL server is never offered.

import type { HarnessId } from './types.ts';

/** The seat toggle that brings a server in. */
export type McpToggle = 'tools' | 'memory';

export interface ReadOnlyServer {
  /** The name the harness knows the server by (`mcp__<name>__<tool>` in Claude Code and Pi). */
  name: string;
  toggle: McpToggle;
  /** The harnesses it is offered to. None: off. */
  harnesses: readonly HarnessId[];
  /** The only tools a member may call. */
  read: readonly string[];
  /** Tools known to write, send, delete or index: denied by name as well, so they are not even declared to the model. */
  write: readonly string[];
}

/** The memory server's name in every harness's config. */
export const MEMORY_SERVER = 'memory';

/** Divan's T3 threads server (`src/server/t3-mcp.ts`): it reads T3 Code's local conversations, nothing else. */
export const T3_SERVER = 't3';

/** Its three tools, all read-only. */
export const T3_TOOLS: readonly string[] = ['t3_thread_read', 't3_thread_search', 't3_thread_list'];

export const READ_ONLY_SERVERS: readonly ReadOnlyServer[] = [
  {
    name: MEMORY_SERVER,
    toggle: 'memory',
    // Claude Code and Codex reach the server with their own connection; Grok and Pi only with Divan's read-only token
    // (`src/server/memory-access.ts`). Grok runs an MCP tool under `dontAsk` only if the server marks it read-only, and the
    // six read tools carry that mark.
    harnesses: ['claude', 'codex', 'grok', 'pi', 'hermes'],
    read: ['whoami', 'search', 'get_page', 'list_pages', 'recent_changes', 'ask'],
    write: [
      'put_page',
      'add_timeline_entry',
      'delete_page',
      'approve_proposal',
      'reject_proposal',
      'list_proposals',
    ],
  },
  {
    name: T3_SERVER,
    toggle: 'tools',
    harnesses: ['claude', 'codex', 'grok', 'pi', 'hermes'],
    read: T3_TOOLS,
    // the server has no tool that writes
    write: [],
  },
  {
    name: 'hermes_history',
    toggle: 'tools',
    harnesses: ['hermes'],
    read: ['hermes_history_search', 'hermes_history_read'],
    write: [],
  },
];

/** Servers that must never reach a member: they drive a browser or run code. (They are not in the table, the only way in.) */
export const NEVER_SERVERS: readonly string[] = [
  'codex-browser',
  'node_repl',
  'cua_repl',
  'codex_app',
  'code-review',
  'chrome',
  'browser',
  'computer-use',
];

export interface Toggles {
  tools: boolean;
  memory: boolean;
}

/** The servers a seat reaches in a harness: those offered to it whose toggle is on. */
export function serversFor(
  harness: HarnessId,
  toggles: Toggles,
  table: readonly ReadOnlyServer[] = READ_ONLY_SERVERS,
): ReadOnlyServer[] {
  return table.filter((server) => server.harnesses.includes(harness) && toggles[server.toggle]);
}

/** `mcp__server__tool`, as Claude Code and Pi name an MCP tool. */
export const mcpName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/** `server__tool`, as Grok names an MCP tool. */
export const grokMcpName = (server: string, tool: string): string => `${server}__${tool}`;

/** The names of the tools a member may call on these servers. */
export const allowedMcp = (
  servers: readonly ReadOnlyServer[],
  name: (server: string, tool: string) => string = mcpName,
): string[] => servers.flatMap((server) => server.read.map((tool) => name(server.name, tool)));

/** The names of the tools of these servers that are denied by name besides (known writers). */
export const deniedMcp = (
  servers: readonly ReadOnlyServer[],
  name: (server: string, tool: string) => string = mcpName,
): string[] => servers.flatMap((server) => server.write.map((tool) => name(server.name, tool)));

/** The memory server's read tools (what the harness's memory connection is limited to). */
export const MEMORY_READ_TOOLS: readonly string[] =
  READ_ONLY_SERVERS.find((server) => server.name === MEMORY_SERVER)?.read ?? [];
