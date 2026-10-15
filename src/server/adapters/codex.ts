// Codex: `codex exec --json` with a native output schema. Codex has no switch that removes its shell tool, so "tools
// off" here means a read-only sandbox in an empty folder (reported to the user in setup). Read-only is enforced: `-s read-only`,
// `approval_policy="never"` (and the reviewer `user`, so a guardian model never approves anything), no user config file
// (`--ignore-user-config`: its MCP servers, plugins and hooks stay out; the global AGENTS.md still loads, accepted by Omid), and
// with memory on the memory server, and with tools on Divan's T3 threads server, are added by `-c` alone with `enabled_tools` = the
// allowlist, every other tool refused. Web
// is set by `web_search`. On Windows the shell runs in Codex's restricted-token sandbox (`windows.sandbox="unelevated"`): it
// reads and every write is refused (checked with real calls on 2026-10-13); without it every command was refused by policy, and
// the elevated sandbox fails here without a machine-wide setup.
//
// Why `exec` and not `codex app-server` (tried with real calls, 2026-10-10): the app-server has no `--ignore-user-config`, so
// the user's MCP servers start unless each one is switched off by name (found with `config/read`), and for the current models
// (`default_reasoning_summary: none`) it streams no reasoning at all: the reasoning items are empty and there are no
// `item/reasoning/*` events, only a `thread/tokenUsage/updated` after each sampling request. So it shows no more signs of work
// than `exec --json` does (an event per finished item), and a Codex call that reasons silently for ten minutes is stopped.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { type Note, note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import {
  MEMORY_READ_TOOLS,
  MEMORY_SERVER,
  T3_SERVER,
  T3_TOOLS,
} from '../../shared/readonly-tools.ts';
import type { HarnessModels, ModelInfo } from '../../shared/types.ts';
import { memoryEntry, memoryUrl, scrubbedEnv } from '../memory-access.ts';
import type { ProcResult } from '../proc.ts';
import { resolveCommand } from '../proc.ts';
import { memberServers, t3Launch } from '../t3-access.ts';
import { toolEvent } from './activity.ts';
import type { Adapter, CommandBuild, ParsedRun, RunSpec, StreamWatcher } from './types.ts';
import {
  asRecord,
  failure,
  jsonLines,
  lineWatcher,
  makeUsage,
  num,
  runList,
  runListResult,
} from './util.ts';

/** `model` at the top of Codex's config.toml, when it is one of the listed models. */
function ownDefault(models: ModelInfo[]): string {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const top = readFileSync(join(home, 'config.toml'), 'utf8').split(/^\s*\[/mu)[0] ?? '';
    const id = /^\s*model\s*=\s*"([^"]+)"/mu.exec(top)?.[1];
    return id && models.some((model) => model.id === id) ? id : '';
  } catch {
    return '';
  }
}

/** What replaces Codex's own long base instructions for a member run. */
const MEMBER_INSTRUCTIONS =
  'You are a careful analyst. Follow the instructions in the user message exactly and return only what they ask for. You only read: you never write, change, send or delete anything.';

/** Codex features a council member never uses; each one adds its own text and tool definitions to every call. */
const TRIMMED_FEATURES = [
  'multi_agent',
  'apps',
  'plugins',
  'image_generation',
  'computer_use',
  'browser_use',
  'hooks',
  'goals',
  'skill_search',
];

/**
 * The `-c` settings that add the memory server (the only server a member has: `--ignore-user-config` leaves the user's out):
 * its address, the bearer token read from the environment variable the user's own Codex config names (Codex keeps its own
 * connection, as in normal use: `MEMORY_TOKEN_CODEX` is not taken out of its environment), ONLY the read tools offered,
 * every other tool refused (the default approval is "prompt", which `never` turns into a refusal), and the read tools
 * approved one by one. Layer 1 is the only lock: `enabled_tools` is a whitelist, so a tool the server adds later is not
 * offered either.
 */
function memoryConnection():
  | { args: string[]; env: Record<string, string>; keep: string[] }
  | { error: string } {
  const own = memoryEntry('codex');
  const url = own?.url ?? memoryUrl('codex');
  if (!url) return { error: 'the memory MCP server is not configured in Codex' };
  const tokenEnv = own?.tokenEnv ?? 'MEMORY_TOKEN_CODEX';
  if (!process.env[tokenEnv]) {
    return {
      error: `the memory token variable ${tokenEnv} is not set, so Codex cannot reach the memory server`,
    };
  }
  const server = `mcp_servers.${MEMORY_SERVER}`;
  const args = [
    '-c',
    `${server}.url=${JSON.stringify(url)}`,
    '-c',
    `${server}.bearer_token_env_var=${JSON.stringify(tokenEnv)}`,
    ...onlyTools(server, MEMORY_READ_TOOLS),
  ];
  return { args, env: {}, keep: [tokenEnv] };
}

/** `-c` settings that offer a server's read tools only and approve each one (all others are refused, nothing is ever asked). */
function onlyTools(server: string, tools: readonly string[]): string[] {
  return [
    '-c',
    `${server}.enabled_tools=[${tools.map((tool) => JSON.stringify(tool)).join(', ')}]`,
    '-c',
    `${server}.default_tools_approval_mode="prompt"`,
    ...tools.flatMap((tool) => ['-c', `${server}.tools.${tool}.approval_mode="approve"`]),
  ];
}

/** The `-c` settings that add Divan's T3 threads server (a local process that reads T3 Code's database, read-only). */
function t3Connection(): string[] {
  const launch = t3Launch();
  const server = `mcp_servers.${T3_SERVER}`;
  return [
    '-c',
    `${server}.command=${JSON.stringify(launch.command)}`,
    '-c',
    `${server}.args=[${launch.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    ...Object.entries(launch.env).flatMap(([name, value]) => [
      '-c',
      `${server}.env.${name}=${JSON.stringify(value)}`,
    ]),
    ...onlyTools(server, T3_TOOLS),
  ];
}

export function codexAuth(result: ProcResult): Note | null {
  if (!result.spawnError && !result.timedOut && !result.cancelled) {
    if (result.code === 0) return null;
    if (result.code === 1 && /^Not logged in\s*$/imu.test(`${result.stdout}\n${result.stderr}`))
      return note('codex_not_logged_in');
  }
  return note('codex_login_unknown');
}

export const codexAdapter: Adapter = {
  info: { id: 'codex', label: 'Codex', ...HARNESS_RULES.codex },

  async check(): Promise<Note | null> {
    try {
      return codexAuth(await runListResult('codex', ['login', 'status']));
    } catch {
      return note('codex_login_unknown');
    }
  },

  async listModels(): Promise<HarnessModels> {
    const out = await runList('codex', ['debug', 'models']);
    const data = JSON.parse(out) as
      | { models?: Record<string, unknown>[] }
      | Record<string, unknown>[];
    const list = Array.isArray(data) ? data : (data.models ?? []);
    const models: ModelInfo[] = [];
    const ranked = [...list].sort((a, b) => num(a.priority) - num(b.priority));
    for (const raw of ranked) {
      if (typeof raw.slug !== 'string' || raw.visibility !== 'list') continue;
      const levels = (raw.supported_reasoning_levels as { effort?: string }[] | undefined) ?? [];
      models.push({
        id: raw.slug,
        label: typeof raw.display_name === 'string' ? raw.display_name : raw.slug,
        efforts: levels.flatMap((level) =>
          typeof level.effort === 'string' ? [level.effort] : [],
        ),
        defaultEffort:
          typeof raw.default_reasoning_level === 'string' ? raw.default_reasoning_level : '',
      });
    }
    return {
      harness: 'codex',
      models,
      listed: true,
      defaultModel: ownDefault(models),
      note: note('models_codex'),
      fallbackEfforts: ['low', 'medium', 'high', 'xhigh'],
      fetchedAt: new Date().toISOString(),
    };
  },

  build(spec: RunSpec, ioDir: string): CommandBuild | { error: string } {
    const found = resolveCommand('codex');
    if (!found) return { error: 'codex is not installed' };
    const schemaFile = join(ioDir, 'schema.json');
    writeFileSync(schemaFile, JSON.stringify(providerSchema(spec.schema)));
    const args = [
      ...found.prefix,
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-rules',
      '-s',
      'read-only',
      '-m',
      spec.model,
      '--output-schema',
      schemaFile,
      '-c',
      'approval_policy="never"',
      '-c',
      `web_search="${spec.web ? 'live' : 'disabled'}"`,
    ];
    if (spec.effort) args.push('-c', `model_reasoning_effort="${spec.effort}"`);
    // Never the user config: its MCP servers could change things, and members only read.
    args.push('--ignore-user-config');
    // A member needs none of Codex's base prompt for coding: a short one replaces it, and the optional blocks go.
    const instructions = join(ioDir, 'instructions.md');
    writeFileSync(instructions, MEMBER_INSTRUCTIONS);
    args.push('-c', `model_instructions_file="${instructions.split('\\').join('/')}"`);
    for (const key of [
      'include_permissions_instructions',
      'include_apps_instructions',
      'include_environment_context',
    ]) {
      args.push('-c', `${key}=false`);
    }
    args.push('-c', 'skills.bundled.enabled=false');
    // In a project folder its AGENTS.md is not read (its own config and hooks need trust, which the ignored user config held).
    if (spec.cwd) args.push('-c', 'project_doc_max_bytes=0');
    for (const feature of TRIMMED_FEATURES) args.push('--disable', feature);
    // Nothing is ever approved by anyone: not by a prompt (there is none) and not by a reviewer model (the user's config would
    // have chosen one; without it the setting is explicit all the same).
    args.push('-c', 'approvals_reviewer="user"');
    let keep: string[] = [];
    const env: Record<string, string | undefined> = {};
    const servers = memberServers('codex', spec);
    if (servers.some((server) => server.name === MEMORY_SERVER)) {
      const connection = memoryConnection();
      if ('error' in connection) return connection;
      args.push(...connection.args);
      Object.assign(env, connection.env);
      keep = connection.keep;
    }
    if (servers.some((server) => server.name === T3_SERVER)) args.push(...t3Connection());
    // an owner's memory token is not for the child (its shell could read the environment): only the one it needs is left
    Object.assign(env, scrubbedEnv(keep));
    if (process.platform === 'win32') {
      args.push('-c', 'windows.sandbox="unelevated"');
      // the Store build of PowerShell (under WindowsApps) cannot start under a restricted token: without those folders on
      // the PATH Codex picks Windows PowerShell, which can
      const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
      env[key] = (process.env[key] ?? '')
        .split(';')
        .filter((dir) => dir && !/WindowsApps/iu.test(dir))
        .join(';');
    }
    args.push('-');
    return { command: found.command, args, stdin: spec.prompt, env };
  },

  watch(): StreamWatcher {
    const seen = new Set<string>();
    return lineWatcher((event) => {
      if (event.type !== 'item.started' && event.type !== 'item.completed') return undefined;
      const item = asRecord(event.item);
      if (
        !item ||
        !['command_execution', 'mcp_tool_call', 'web_search'].includes(String(item.type))
      )
        return undefined;
      if (typeof item.id === 'string') {
        if (seen.has(item.id)) return undefined;
        seen.add(item.id);
      }
      const name = typeof item.tool === 'string' ? item.tool : String(item.type);
      return {
        tools: [
          toolEvent(
            name,
            item.arguments ?? item,
            typeof item.server === 'string' ? item.server : '',
          ),
        ],
      };
    });
  },

  parse(result: ProcResult): ParsedRun {
    const events = jsonLines(result.stdout);
    let text = '';
    let usage: ParsedRun['usage'] = null;
    let error: string | null = null;
    let failed: string | null = null;
    for (const event of events) {
      const type = event.type;
      if (type === 'item.completed') {
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') text = item.text;
      } else if (type === 'turn.completed') {
        const u = (event.usage ?? {}) as Record<string, unknown>;
        usage = makeUsage(
          num(u.input_tokens) - num(u.cached_input_tokens),
          num(u.output_tokens),
          num(u.cached_input_tokens),
        );
      } else if (type === 'turn.failed' || type === 'error') {
        const message = (event.error as { message?: string } | undefined)?.message ?? event.message;
        const reason = typeof message === 'string' ? message : 'harness reported an error';
        // A failed turn is an error even when partial text came out; a bare `error` event may only be a retry notice.
        if (type === 'turn.failed') failed = reason;
        else error = reason;
      }
    }
    // Hard failures stay errors even when partial text came out: a spawn error, a timeout, a failed turn, a bad exit.
    const badExit = result.code !== null && result.code !== 0;
    if (result.spawnError || result.timedOut)
      return { text, usage, error: failure(result, 'failed') };
    if (failed) return { text, usage, error: failed };
    if (badExit)
      return { text, usage, error: error ?? failure(result, `exited with ${result.code}`) };
    if (!text) return { text, usage, error: error ?? failure(result, 'no message in the output') };
    return { text, usage, error: null };
  },
};
