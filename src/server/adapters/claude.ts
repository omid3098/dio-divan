// Claude Code: `claude -p` with streamed JSON events (`stream-json`, partial messages) and a native JSON schema: every event
// is a sign of work, and the thinking is counted as it streams. A member has Claude Code's full reach, as in normal use
// (the user's settings, CLAUDE.md and hooks load: `--setting-sources user`), and read-only is ENFORCED: `dontAsk` with no
// prompts, a read-only `--tools` list, only the MCP servers of the allowlist (`--strict-mcp-config`, `src/shared/
// readonly-tools.ts`), explicit tool names in `--allowedTools` (never a whole server or a wildcard), the known writers
// denied by name, and the folders of Divan and of the harnesses denied to the read tools. The memory server is reached with
// Claude Code's OWN connection, as in normal use. The T3 threads server (a local process of Divan's) comes in with the tools.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { type Note, note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import { allowedMcp, deniedMcp, MEMORY_SERVER, T3_SERVER } from '../../shared/readonly-tools.ts';
import type { HarnessModels, ModelInfo, ToolEvent } from '../../shared/types.ts';
import { envRef, memoryEntry, scrubbedEnv } from '../memory-access.ts';
import { type ProcResult, resolveCommand } from '../proc.ts';
import { memberServers, t3Launch } from '../t3-access.ts';
import { toolEvent } from './activity.ts';
import { hiddenFolders, homeRelative } from './paths.ts';
import type { Adapter, CommandBuild, ParsedRun, RunSpec, StreamWatcher } from './types.ts';
import {
  asRecord,
  failure,
  jsonLines,
  lineWatcher,
  makeUsage,
  num,
  runListResult,
  unlisted,
} from './util.ts';

/** The few words Claude Code's own (long) system prompt is replaced with; the rules come in the message. */
const MEMBER_SYSTEM =
  'You are a careful analyst. Follow the instructions in the user message exactly and return only what they ask for. You only read: you never write, change, send or delete anything.';

/**
 * Claude Code's own request timeout (`API_TIMEOUT_MS`, ten minutes by default): raised so that it never stops a call before
 * Divan's idle window does. While the call streams, Divan decides.
 */
const API_TIMEOUT_MS = '1800000';

export function claudeAuth(result: ProcResult): Note | null {
  if (!result.spawnError && !result.timedOut) {
    try {
      const status = JSON.parse(result.stdout) as { loggedIn?: unknown };
      if (result.code === 0 && status.loggedIn === true) return null;
      if ((result.code === 0 || result.code === 1) && status.loggedIn === false)
        return note('claude_not_logged_in');
    } catch {
      /* An invalid status is unknown, not signed out. */
    }
  }
  return note('claude_login_unknown');
}

/**
 * The memory server's entry for the run's `--mcp-config` file, and the variables it needs in the child's environment: the
 * entry the user's own Claude Code config holds. A header value travels in the environment and the file names it as
 * `${VAR}`: no token is ever written into a temporary file.
 */
function memoryConnection(): {
  entry: Record<string, unknown>;
  env: Record<string, string>;
} | null {
  const own = memoryEntry('claude');
  if (!own?.raw) return null;
  const entry = structuredClone(own.raw);
  const env: Record<string, string> = {};
  const headers = asRecord(entry.headers);
  if (headers) {
    let index = 0;
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value !== 'string') continue;
      const name = `DIVAN_MEMORY_HEADER_${index++}`;
      env[name] = value;
      headers[key] = envRef(name);
    }
  }
  return { entry, env };
}

/** A path as Claude's permission rules write it: `~/x` under the home folder, else `//absolute/path`. */
function claudePath(folder: string): string {
  const rel = homeRelative(folder);
  if (rel.startsWith('~')) return rel;
  return `//${rel.replace(/^([A-Za-z]):/u, '$1')}`;
}

/** Claude Code's read-only built-in tools and its web tools. */
const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

const configDir = () => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

/**
 * Claude Code has no command that lists models. It does cache its own model catalogue (the one its /model picker
 * reads); a missing cache falls back to Claude Code's documented aliases.
 */
interface Catalog {
  models: ModelInfo[];
  short: Map<string, string>;
}

function readCatalog(): Catalog | null {
  const dir = join(configDir(), 'cache', 'model-catalog');
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.startsWith('published'))
    .map((name) => join(dir, name));
  let best: (Catalog & { at: number }) | null = null;
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as {
        fetchedAt?: number;
        catalog?: { config?: { id?: string; models?: unknown[] } };
      };
      const config = data.catalog?.config;
      if (config?.id !== 'cc' || !Array.isArray(config.models)) continue;
      const models: ModelInfo[] = [];
      const short = new Map<string, string>();
      for (const raw of config.models as Record<string, unknown>[]) {
        const id = typeof raw.id === 'string' ? raw.id : null;
        if (!id) continue;
        const thinking = raw.thinking as
          | { effort_options?: { id?: string; badge?: { message?: string } }[] }
          | undefined;
        const options = thinking?.effort_options ?? [];
        const efforts = options.flatMap((option) =>
          typeof option.id === 'string' ? [option.id] : [],
        );
        const recommended = options.find((option) => option.badge?.message === 'Recommended');
        if (typeof raw.short_name === 'string' && !short.has(raw.short_name.toLowerCase())) {
          short.set(raw.short_name.toLowerCase(), id);
        }
        models.push({
          id,
          label: typeof raw.name === 'string' ? raw.name : id,
          efforts,
          defaultEffort: recommended?.id ?? efforts.find((e) => e === 'medium') ?? efforts[0] ?? '',
        });
      }
      const at = num(data.fetchedAt);
      if (models.length > 0 && (!best || at > best.at)) best = { at, models, short };
    } catch {
      // unreadable cache file: try the next
    }
  }
  return best ? { models: best.models, short: best.short } : null;
}

/** The model Claude Code starts on: `model` in its settings (an id or an alias such as opus), found in the catalogue. */
function ownDefault(catalog: Catalog): string {
  try {
    const settings = JSON.parse(readFileSync(join(configDir(), 'settings.json'), 'utf8')) as {
      model?: unknown;
    };
    if (typeof settings.model !== 'string') return '';
    const wanted = settings.model
      .replace(/\[[^\]]*\]$/u, '')
      .trim()
      .toLowerCase();
    return (
      catalog.models.find((model) => model.id === wanted)?.id ?? catalog.short.get(wanted) ?? ''
    );
  } catch {
    return '';
  }
}

export function claudeAliases(): HarnessModels {
  return {
    ...unlisted('claude', note('models_claude_aliases'), ['low', 'medium', 'high', 'xhigh', 'max']),
    aliases: true,
    models: ['opus', 'sonnet', 'haiku'].map((id) => ({
      id,
      label: id,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
    })),
    defaultModel: 'opus',
  };
}

export const claudeAdapter: Adapter = {
  info: { id: 'claude', label: 'Claude Code', ...HARNESS_RULES.claude },

  async listModels(): Promise<HarnessModels> {
    const catalog = readCatalog();
    if (catalog) {
      return {
        harness: 'claude',
        models: catalog.models,
        listed: true,
        defaultModel: ownDefault(catalog),
        note: note('models_claude_cache'),
        fallbackEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        fetchedAt: new Date().toISOString(),
      };
    }
    return claudeAliases();
  },

  async check(): Promise<Note | null> {
    try {
      return claudeAuth(await runListResult('claude', ['auth', 'status']));
    } catch {
      return note('claude_login_unknown');
    }
  },

  build(spec: RunSpec, ioDir: string): CommandBuild | { error: string } {
    const found = resolveCommand('claude');
    if (!found) return { error: 'claude is not installed' };
    const args = [
      ...found.prefix,
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--model',
      spec.model,
      // Nothing is saved: a member's session would hold its answer for the next member to find.
      '--no-session-persistence',
      '--disable-slash-commands',
      '--json-schema',
      JSON.stringify(providerSchema(spec.schema)),
      '--system-prompt',
      MEMBER_SYSTEM,
    ];
    if (spec.effort) args.push('--effort', spec.effort);

    // The user's settings load as in normal use (CLAUDE.md, hooks, rules); a project's own settings never do.
    args.push('--setting-sources', 'user');

    // Only the MCP servers of the allowlist (the memory server), whatever the user's config has (a browser server never): a
    // file of our own, read with `--strict-mcp-config`. The claude.ai connectors are not fetched.
    const servers = memberServers('claude', spec);
    const mcp: Record<string, unknown> = {};
    const env: Record<string, string | undefined> = {
      API_TIMEOUT_MS,
      // a memory token of another assistant is not for the child
      ...scrubbedEnv(),
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
    };
    for (const server of servers) {
      if (server.name === MEMORY_SERVER) {
        const connection = memoryConnection();
        if (!connection) return { error: 'the memory MCP server is not configured in Claude Code' };
        mcp[server.name] = connection.entry;
        Object.assign(env, connection.env);
      } else if (server.name === T3_SERVER) {
        // Divan's own small server that reads T3 Code's threads, read-only (a local process)
        mcp[server.name] = { type: 'stdio', ...t3Launch() };
      }
    }
    const mcpFile = join(ioDir, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: mcp }));
    args.push('--strict-mcp-config', '--mcp-config', mcpFile);

    // Read-only is enforced: nothing is asked (`dontAsk`, no prompts), the built-in tools are the read-only ones, and the tools
    // allowed are named one by one.
    const builtIn = [...(spec.tools ? READ_ONLY_TOOLS : []), ...(spec.web ? WEB_TOOLS : [])];
    args.push(
      '--tools',
      builtIn.join(','),
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
    );
    const allowed = [...builtIn, ...allowedMcp(servers)];
    if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));

    // Denied by name: the known writers of the allowlisted servers (a name the harness does not even declare to the model),
    // and, with read tools, the folders of Divan and of the harnesses.
    const denied = [...deniedMcp(servers)];
    if (spec.tools) {
      for (const tool of ['Read', 'Grep', 'Glob']) {
        for (const folder of hiddenFolders()) denied.push(`${tool}(${claudePath(folder)}/**)`);
      }
    }
    if (denied.length > 0) args.push('--disallowedTools', denied.join(','));
    return { command: found.command, args, stdin: spec.prompt, env };
  },

  /**
   * The thinking so far: what the stream says it has used (`output_tokens_details.thinking_tokens`, which arrives with the
   * message), else counted from the thinking text as it streams (about four characters a token), the larger of the two.
   */
  watch(): StreamWatcher {
    let chars = 0;
    let reported = 0;
    const blocks = new Map<number, { id: string; name: string; input: unknown; json: string }>();
    const seen = new Set<string>();
    return lineWatcher((event) => {
      const tools: ToolEvent[] = [];
      const add = (block: Record<string, unknown>) => {
        if (block.type !== 'tool_use' || typeof block.name !== 'string') return;
        // Claude Code's own channel for the schema-checked answer (`--json-schema`), not a tool the member chose to use
        if (block.name === 'StructuredOutput') return;
        const id = typeof block.id === 'string' ? block.id : '';
        if (id && seen.has(id)) return;
        if (id) seen.add(id);
        tools.push(toolEvent(block.name, block.input));
      };
      if (event.type === 'assistant') {
        const content = asRecord(event.message)?.content;
        if (Array.isArray(content)) {
          for (const block of content) add(asRecord(block) ?? {});
        }
      }
      const inner = asRecord(event.event);
      if (event.type === 'stream_event' && inner?.type === 'content_block_start') {
        const block = asRecord(inner.content_block);
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          blocks.set(Number(inner.index), {
            id: typeof block.id === 'string' ? block.id : '',
            name: block.name,
            input: block.input,
            json: '',
          });
        }
      } else if (inner?.type === 'content_block_stop') {
        const block = blocks.get(Number(inner.index));
        blocks.delete(Number(inner.index));
        if (block) {
          try {
            add({
              ...block,
              type: 'tool_use',
              input: block.json ? JSON.parse(block.json) : block.input,
            });
          } catch {
            // A final assistant message can still supply the complete input.
          }
        }
      } else if (inner?.type === 'content_block_delta') {
        const delta = asRecord(inner.delta);
        const block = blocks.get(Number(inner.index));
        if (block && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
          block.json = (block.json + delta.partial_json).slice(0, 64_000);
        }
        if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          chars += delta.thinking.length;
        }
      } else if (inner?.type === 'message_delta') {
        const details = asRecord(asRecord(inner.usage)?.output_tokens_details);
        reported = Math.max(reported, num(details?.thinking_tokens));
      }
      const thinking = Math.max(reported, Math.ceil(chars / 4));
      return thinking > 0 || tools.length
        ? {
            ...(thinking > 0 ? { thinkingTokens: thinking } : {}),
            ...(tools.length ? { tools } : {}),
          }
        : undefined;
    });
  },

  parse(result: ProcResult): ParsedRun {
    // A run that was stopped or never started is an error whatever it printed; what it did print is still read.
    const stopped = result.spawnError || result.timedOut ? failure(result, 'failed') : null;
    const events = jsonLines(result.stdout);
    const event = [...events].reverse().find((entry) => entry.type === 'result') ?? null;
    if (!event) {
      // no final result (the run was stopped, or died): what the stream said of its usage so far is kept
      const last = [...events]
        .reverse()
        .map((entry) => asRecord(asRecord(entry.event)?.usage))
        .find((usage) => usage !== null);
      const partial = last
        ? makeUsage(
            num(last.input_tokens) + num(last.cache_creation_input_tokens),
            num(last.output_tokens),
            num(last.cache_read_input_tokens),
          )
        : null;
      return {
        text: result.stdout,
        usage: partial,
        error: stopped ?? failure(result, 'no result in the output'),
      };
    }
    const usage = asRecord(event.usage) ?? {};
    const input = num(usage.input_tokens) + num(usage.cache_creation_input_tokens);
    const run = makeUsage(input, num(usage.output_tokens), num(usage.cache_read_input_tokens));
    const structured = event.structured_output;
    const text =
      structured && typeof structured === 'object'
        ? JSON.stringify(structured)
        : typeof event.result === 'string'
          ? event.result
          : '';
    if (stopped) return { text, usage: run, error: stopped };
    if (event.is_error === true) {
      return { text, usage: run, error: text.slice(0, 300) || 'harness reported an error' };
    }
    // A non-zero exit is an error even when text came out; the text and usage stay for diagnostics.
    if (result.code !== 0 && result.code !== null) {
      return { text, usage: run, error: failure(result, `exited with ${result.code}`) };
    }
    return { text, usage: run, error: text ? null : failure(result, 'no text in the output') };
  },
};
