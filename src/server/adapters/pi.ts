// Pi: `pi --mode json` with the prompt on stdin. A member has Pi's full reach as in normal use (its AGENTS.md and CLAUDE.md
// context files load; the memory server through Pi's built-in MCP client), and read-only is ENFORCED: only the read tools
// and the allowlisted MCP tool names are active (`--tools`, the writers also in `--exclude-tools`), no extension but Pi's
// MCP client and our own is ever loaded, and our extension's `tool_call` guard blocks anything else (any other tool or MCP
// call, any read of a history path). Pi has no web search tool.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import { allowedMcp, deniedMcp, MEMORY_SERVER, T3_SERVER } from '../../shared/readonly-tools.ts';
import type { HarnessModels, ModelInfo } from '../../shared/types.ts';
import {
  envRef,
  memoryEntry,
  memoryUrl,
  readReadOnlyToken,
  scrubbedEnv,
  TOKEN_ENV,
} from '../memory-access.ts';
import { validPayload } from '../parse.ts';
import type { ProcResult } from '../proc.ts';
import { resolveCommand } from '../proc.ts';
import { memberServers, t3Launch } from '../t3-access.ts';
import { toolEvent } from './activity.ts';
import { hiddenFolders } from './paths.ts';
import type { Adapter, CommandBuild, ParsedRun, RunSpec, StreamWatcher } from './types.ts';
import {
  asRecord,
  failure,
  jsonLines,
  lineWatcher,
  makeUsage,
  num,
  oddPath,
  projectPrompt,
  runList,
} from './util.ts';

/** Pi's read-only built-in tools: the only built-ins a member has. */
const READ_TOOLS = ['read', 'grep', 'find', 'ls'];

/** Only a provider/model table row is a model; prose and recursive Divan providers are not. */
export function piModelRows(out: string, levels: string[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const line of out.split('\n')) {
    const row =
      /^\s*(\S+)\s+(\S+)\s+(\d+(?:\.\d+)?[kKmM]?)\s+(\d+(?:\.\d+)?[kKmM]?)\s+(yes|no)(?:\s+(yes|no))?\s*$/u.exec(
        line,
      );
    if (!row || row[1]?.toLowerCase() === 'divan') continue;
    const id = `${row[1]}/${row[2]}`;
    const efforts = row[5] === 'yes' ? levels : [];
    if (!models.some((model) => model.id === id))
      models.push({
        id,
        label: id,
        efforts,
        defaultEffort: efforts.includes('medium') ? 'medium' : '',
      });
  }
  return models;
}

/** What the extension of a run is told: which tools may run, which paths are closed, where the project is. */
interface Guard {
  /** The project folder the member reads (absolute), or none. */
  project: string | undefined;
  /** Every tool that may run, by name: the read tools and the allowlisted MCP tools. Anything else is blocked. */
  allowed: string[];
  /** Folders a read must not touch (absolute). */
  closed: string[];
  schema: RunSpec['schema'];
}

/**
 * Pi's own limits that would stop a call before Divan's idle window does: its HTTP idle timeout (five minutes by default)
 * is raised to 30 minutes, and the 16.4K output a gateway model is given by default (thinking is part of it) is raised, by a
 * small extension of the run's own that rewrites the request before it is sent. The same extension is the guard of the run.
 *
 * The timeout is a Pi setting, and Pi reads settings from its agent directory (the user's: never written, linked or copied
 * here) and from the `.pi` of the folder it runs in when it trusts that folder. So every run, with a project folder or
 * without, runs in OUR OWN empty folder, which it trusts (`--approve`), with the settings (and the MCP file) in that
 * folder's `.pi`. A project folder is given to the member as an absolute path (Pi's read, grep, find and ls take absolute
 * paths and are not confined to the folder Pi runs in), which also means that nothing of the project's own (settings,
 * hooks, extensions) can ever be loaded: Pi never runs there.
 */
const HTTP_IDLE_MS = 1_800_000;
const RAISED_OUTPUT_TOKENS = 65_536;
const limitsExtension = (
  guard: Guard,
): string => `// Divan: a model whose output limit is Pi's generic 16384 (what it gives a model it knows nothing about) gets more room, so
// deep thinking is not cut. Any other limit was chosen by someone and stays. And the guard of a member that only reads.
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = ${JSON.stringify(guard.project ?? null)};
const ALLOWED = new Set(${JSON.stringify(guard.allowed)});
const CLOSED = ${JSON.stringify(guard.closed)};
const WINDOWS = process.platform === 'win32';
const IGNORE_CASE = WINDOWS || process.platform === 'darwin';

const real = (path) => {
  let ancestor = resolve(path);
  const missing = [];
  for (;;) {
    try {
      const out = join(realpathSync.native(ancestor), ...missing.reverse());
      return IGNORE_CASE ? out.toLowerCase() : out;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      missing.push(ancestor.slice(parent.length).replace(/^[\\\\/]/u, ''));
      ancestor = parent;
    }
  }
};
const CLOSED_REAL = CLOSED.map(real);
const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const isClosed = (path) => path === null || CLOSED_REAL.some((root) => root !== null && inside(path, root));
const holdsClosed = (path) => path === null || CLOSED_REAL.some((root) => root !== null && root !== path && inside(root, path));

const stripped = (given) => (given.startsWith('@') ? given.slice(1) : given);
const isRelative = (text) => !isAbsolute(text) && !text.startsWith('~') && !text.startsWith('file:');
/** The absolute path a call means: relative to the project (or to where Pi runs), '~' as the home folder. */
const absolute = (text) => {
  if (text.startsWith('file:')) return fileURLToPath(text);
  if (text === '~') return homedir();
  if (text.startsWith('~/') || text.startsWith('~' + sep)) return resolve(homedir(), text.slice(2));
  return resolve(PROJECT ?? process.cwd(), text);
};

export default function (pi) {
  pi.registerTool({
    name: 'submit_answer', label: 'Submit answer',
    description: 'Submit your finished answer in the requested form. This completes the task.',
    parameters: ${JSON.stringify(guard.schema)},
    constrainedSampling: { type: 'json_schema', strict: 'prefer' },
    async execute(_id, args) {
      return { content: [{ type: 'text', text: 'Answer submitted.' }], details: { submission: args }, terminate: true };
    },
  });
  pi.on('before_provider_request', (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return undefined;
    const room = Math.min(${RAISED_OUTPUT_TOKENS}, Math.floor((ctx.model?.contextWindow ?? 128000) / 2));
    const out = { ...payload };
    let changed = false;
    for (const key of ['max_tokens', 'max_completion_tokens']) {
      if (out[key] === 16384 && out[key] < room) {
        out[key] = room;
        changed = true;
      }
    }
    return changed ? out : undefined;
  });

  // The guard. Only the tools of the allowlist run (the --tools list says so too; this is the second lock): any other tool,
  // and any MCP call that is not named, is blocked. A read of a closed path is blocked, and so is a search that would walk
  // into one from above. Pi runs in an empty scratch folder and reads the project by absolute paths: a relative path a member
  // gives is taken to be under the project, and an omitted one is the project itself.
  pi.on('tool_call', (event) => {
    const name = event.toolName;
    if (!ALLOWED.has(name)) {
      return { block: true, reason: 'This tool is not available: you only read, with the tools you were given.' };
    }
    if (!['read', 'grep', 'find', 'ls'].includes(name)) return undefined;
    const input = event.input;
    if (!input || typeof input !== 'object') return undefined;
    const given = input.path;
    if (given !== undefined && given !== null && typeof given !== 'string') return undefined;
    const wanted = typeof given === 'string' && given !== '' ? stripped(given) : null;
    let target;
    if (wanted === null) {
      if (name === 'read') return undefined;
      target = PROJECT ?? process.cwd();
      if (PROJECT) input.path = PROJECT;
    } else {
      try {
        target = absolute(wanted);
      } catch {
        return { block: true, reason: 'This path is not valid.' };
      }
      if (PROJECT && isRelative(wanted)) input.path = target;
    }
    const path = real(target);
    if (isClosed(path)) {
      return { block: true, reason: 'This path is closed to you: it holds private assistant files.' };
    }
    if (name === 'grep' && holdsClosed(path)) {
      return { block: true, reason: 'This search would read closed files: search a narrower folder.' };
    }
    return undefined;
  });
}
`;

const SYSTEM =
  'You are a careful analyst. Follow the instructions in the user message exactly and return only what they ask for. You only read: you never write, change, send or delete anything.';

/** The system prompt: with a project folder, where it is (Pi does not run in it; a relative path is taken to be under it). */
const systemFor = (project: string | undefined): string =>
  projectPrompt(SYSTEM, project).replace(
    'give your tools absolute paths under it.',
    'give your tools absolute paths under it (a relative or missing path is taken to be under it).',
  );

/**
 * The run's `.pi/mcp.json`: Pi's MCP servers are the ones of the allowlist and no others (the T3 threads server is a stdio entry
 * of ours). The memory server is a full entry of
 * ours (its address, and Divan's READ-ONLY token by `${DIVAN_MEMORY_TOKEN}`: Pi never uses the owner's token, and without the
 * read-only token it has no memory), exposed directly so that its tools are declared by name. Every other server the user has
 * is switched off (a server added later too, by the `--tools` list).
 */
function mcpConfig(
  servers: readonly { name: string }[],
  token: string | null,
): { file: Record<string, unknown>; env: Record<string, string> } | { error: string } {
  const user = asRecord(asRecord(readJson(piMcpFile()))?.mcpServers) ?? {};
  const entries: Record<string, unknown> = {};
  for (const name of Object.keys(user)) entries[name] = { enabled: false };
  const env: Record<string, string> = {};
  for (const server of servers) {
    if (server.name === MEMORY_SERVER) {
      const url = memoryEntry('pi')?.url ?? memoryUrl('pi');
      if (!token) {
        return {
          error:
            "Pi has no memory without the read-only memory token (the memory-ro-token file in Divan's home)",
        };
      }
      if (!url)
        return {
          error: 'the memory server’s address is not known: it is in no assistant’s config',
        };
      entries[server.name] = {
        url,
        exposure: 'direct',
        timeout: 120,
        headers: { Authorization: `Bearer ${envRef(TOKEN_ENV)}` },
      };
      env[TOKEN_ENV] = token;
    } else if (server.name === T3_SERVER) {
      // Divan's own small server that reads T3 Code's threads, read-only (a local process)
      entries[server.name] = { ...t3Launch(), exposure: 'direct', timeout: 120 };
    }
  }
  return { file: { autoEnableCodemode: false, mcpServers: entries }, env };
}

const piDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
const piMcpFile = () => join(piDir(), 'mcp.json');
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Pi thinking levels as `pi --help` prints them. */
async function thinkingLevels(): Promise<string[]> {
  try {
    const help = await runList('pi', ['--help']);
    const line = /--thinking <level>\s+Set thinking level:\s*([^\n]+)/u.exec(help)?.[1];
    const levels = (line ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    return levels.length > 0 ? levels : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  } catch {
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  }
}

/** Pi's own default: `defaultProvider` and `defaultModel` in its settings, when listed. */
function ownDefault(models: ModelInfo[]): string {
  try {
    const home = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as {
      defaultProvider?: string;
      defaultModel?: string;
    };
    const id = `${settings.defaultProvider}/${settings.defaultModel}`;
    return models.some((model) => model.id === id) ? id : '';
  } catch {
    return '';
  }
}

/**
 * What the finished assistant messages of a Pi stream add up to: the text of the last one, the usage of all of them, and how
 * the last one ended. Tool results (which can be bulky) and every other event are not counted. It is fed event by event, as
 * the lines arrive from the process (`watch`) as well as from a whole output (`parse`), so a long stream's usage never
 * depends on what a bounded buffer still holds.
 */
class PiTally {
  text = '';
  submission: string | null = null;
  pending = new Map<string, unknown>();
  input = 0;
  output = 0;
  cached = 0;
  error: string | null = null;
  private schema: RunSpec['schema'] | undefined;
  constructor(schema?: RunSpec['schema']) {
    this.schema = schema;
  }

  add(event: Record<string, unknown>): void {
    if (event.toolName === 'submit_answer') {
      const id = String(event.toolCallId ?? '');
      if (event.type === 'tool_execution_start' && !this.pending.has(id))
        this.pending.set(id, event.args);
      if (event.type === 'tool_execution_end') {
        const details = asRecord(asRecord(event.result)?.details);
        const original = this.pending.get(id);
        if (
          event.isError === false &&
          details &&
          Object.hasOwn(details, 'submission') &&
          original &&
          (!this.schema || validPayload(this.schema, original))
        )
          this.submission = JSON.stringify(original);
        this.pending.delete(id);
      }
    }
    if (event.type !== 'message_end') return;
    const message = event.message as
      | {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
          usage?: Record<string, unknown>;
        }
      | undefined;
    if (message?.role !== 'assistant') return;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const call = asRecord(part);
        if (
          call?.type === 'toolCall' &&
          call.name === 'submit_answer' &&
          typeof call.id === 'string'
        )
          this.pending.set(call.id, call.arguments);
      }
      const parts = (message.content as { type?: string; text?: string }[])
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text);
      this.text = parts.join('');
    } else if (typeof message.content === 'string') {
      this.text = message.content;
    }
    const u = message.usage ?? {};
    this.input += num(u.input) + num(u.cacheWrite);
    this.output += num(u.output);
    this.cached += num(u.cacheRead);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.error = message.errorMessage ?? `stop reason: ${message.stopReason}`;
    } else {
      this.error = null;
    }
  }

  usage() {
    return makeUsage(this.input, this.output, this.cached);
  }
}

export const piAdapter: Adapter = {
  info: { id: 'pi', label: 'Pi', ...HARNESS_RULES.pi },

  async listModels(): Promise<HarnessModels> {
    const out = await runList('pi', ['--no-extensions', '--list-models']);
    const levels = await thinkingLevels();
    const models = piModelRows(out, levels);
    return {
      harness: 'pi',
      models,
      listed: true,
      defaultModel: ownDefault(models),
      note: note('models_pi'),
      fallbackEfforts: levels,
      fetchedAt: new Date().toISOString(),
    };
  },

  /** The project's path goes into the member's system prompt: a name that could write more of it is not used. */
  async cwdProblem(cwd: string): Promise<string | null> {
    return oddPath(cwd) ? 'the folder name holds a control character or a line separator' : null;
  },

  build(spec: RunSpec, ioDir: string, workDir: string): CommandBuild | { error: string } {
    const found = resolveCommand('pi');
    if (!found) return { error: 'pi is not installed' };
    const args = [
      ...found.prefix,
      '--mode',
      'json',
      '--no-session',
      '--offline',
      // No extension but the two named below (Pi's own MCP client, and ours): the user's packages and extensions stay out.
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--system-prompt',
      systemFor(spec.cwd),
      '--model',
      spec.model,
    ];
    if (spec.effort) args.push('--thinking', spec.effort);
    // Every run, with a project folder or without, runs in OUR OWN empty folder, which it trusts: a settings file of ours there
    // turns Pi's automatic retries off (a model that is out of credit fails at once instead of after a minute of back-off) and
    // raises its HTTP idle timeout. The folder is ours and empty, so trusting it is safe. A project folder is not run in and
    // not trusted: the member is told its absolute path (see `systemFor`), so none of its own files is ever loaded.
    mkdirSync(join(workDir, '.pi'), { recursive: true });
    writeFileSync(
      join(workDir, '.pi', 'settings.json'),
      JSON.stringify({ retry: { enabled: false }, httpIdleTimeoutMs: HTTP_IDLE_MS }),
    );
    args.push('--approve');

    // The MCP servers of the allowlist and no others: Pi's built-in MCP client is loaded only when there is one, with a
    // `.pi/mcp.json` of the run's own. Every tool is named in `--tools`, and the known writers also in `--exclude-tools`.
    const servers = memberServers('pi', spec);
    const env: Record<string, string | undefined> = { ...scrubbedEnv() };
    if (servers.length > 0) {
      const config = mcpConfig(servers, readReadOnlyToken());
      if ('error' in config) return config;
      writeFileSync(join(workDir, '.pi', 'mcp.json'), JSON.stringify(config.file));
      Object.assign(env, config.env);
      args.push('--extension', 'builtin:mcp');
    }
    const mcpAllowed = allowedMcp(servers);
    const tools = [...(spec.tools ? READ_TOOLS : []), ...mcpAllowed, 'submit_answer'];
    if (tools.length > 0) args.push('--tools', tools.join(','));
    else args.push('--no-tools');
    const denied = deniedMcp(servers);
    if (denied.length > 0) args.push('--exclude-tools', denied.join(','));

    // our extension: the output room, and the guard (the same lists, and the paths a read must not reach)
    const limits = join(ioDir, 'divan-limits.mjs');
    writeFileSync(
      limits,
      limitsExtension({
        project: spec.cwd,
        allowed: tools,
        closed: hiddenFolders(),
        schema: providerSchema(spec.schema),
      }),
    );
    args.push('--extension', limits);
    // `cwd`: where the process runs, whatever folder the member reads (see `CommandBuild.cwd`)
    return {
      command: found.command,
      args,
      stdin: `${spec.prompt}\nFinish by calling submit_answer with your answer in the requested form.`,
      env,
      cwd: workDir,
    };
  },

  /**
   * The thinking so far, counted from the streamed thinking text (about four characters a token); and, as the lines arrive,
   * what the finished assistant messages add up to (`streamed`), for an output too long to be kept whole.
   */
  watch(spec: RunSpec): StreamWatcher {
    let chars = 0;
    const tally = new PiTally(spec.schema);
    const watcher = lineWatcher((event) => {
      tally.add(event);
      if (
        event.type === 'tool_execution_start' &&
        typeof event.toolName === 'string' &&
        event.toolName !== 'submit_answer'
      ) {
        return { tools: [toolEvent(event.toolName, event.args)] };
      }
      if (event.type !== 'message_update') return undefined;
      const inner = asRecord(event.assistantMessageEvent);
      if (inner?.type === 'thinking_delta' && typeof inner.delta === 'string') {
        chars += inner.delta.length;
      }
      return chars > 0 ? { thinkingTokens: Math.ceil(chars / 4) } : undefined;
    });
    return {
      push: (chunk) => watcher.push(chunk),
      streamed: () => ({
        text: tally.submission ?? tally.text,
        usage: tally.usage(),
        error: tally.error,
      }),
    };
  },

  parse(result: ProcResult, spec: RunSpec): ParsedRun {
    const tally = new PiTally(spec.schema);
    for (const event of jsonLines(result.stdout)) tally.add(event);
    const text = tally.submission ?? tally.text;
    let { error } = tally;
    // A stopped run is an error whatever it printed; a non-zero exit is one even when text came out. Text and usage stay.
    const badExit = result.code !== null && result.code !== 0;
    if (result.spawnError || result.timedOut) error = failure(result, 'failed');
    else if (badExit) error = error ?? failure(result, `exited with ${result.code}`);
    else if (!text && !error) error = failure(result, 'no assistant message in the output');
    return { text, usage: tally.usage(), error: text && !error ? null : error };
  },
};
