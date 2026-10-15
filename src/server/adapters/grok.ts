// Grok CLI: `grok --prompt-file <file> --output-format streaming-json` (its events stream: every one is a sign of work, and its
// `thought` events are the thinking). A member has Grok's full reach as in normal use (its config, its rules and the Claude
// compatibility rules load; its cross-session memory writes are off), and read-only is ENFORCED: `--permission-mode dontAsk`
// (the user's config says always-approve; under it Grok runs an MCP tool only if its server marks the tool read-only, and the
// read tools of the memory server are marked so), a read-only `--tools` list, and the credential and history paths denied to
// its read tools. Without memory its MCP meta-tools are removed (`--disallowed-tools search_tool,use_tool`). With memory the
// run is in an empty scratch folder of ours whose `.grok/config.toml` replaces the user's memory entry with Divan's READ-ONLY
// token (the server refuses every write for it; the owner's token is never given to Grok), switches the user's other MCP
// servers off, and has the writers denied by name besides. Web is `--disable-web-search` when off.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import {
  allowedMcp,
  deniedMcp,
  grokMcpName,
  MEMORY_SERVER,
  T3_SERVER,
} from '../../shared/readonly-tools.ts';
import type { HarnessModels, ModelInfo, ToolEvent } from '../../shared/types.ts';
import {
  envRef,
  memoryUrl,
  readReadOnlyToken,
  scrubbedEnv,
  TOKEN_ENV,
  tomlServerNames,
} from '../memory-access.ts';
import type { ProcResult } from '../proc.ts';
import { resolveCommand, runProc } from '../proc.ts';
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
  oddPath,
  projectPrompt,
  runListResult,
} from './util.ts';

/** The few words Grok's own system prompt is replaced with. */
const MEMBER_SYSTEM =
  'You are a careful analyst. Follow the instructions in the user message exactly and return only what they ask for. You only read: you never write, change, send or delete anything.';

/** Grok's own idle limit on an inference call, in seconds: 30 minutes, well above Divan's ten-minute window. */
const GROK_IDLE_SECS = 1800;

/** Grok's read-only tools and web tools, by their internal ids (`--tools`). */
const READ_ONLY_TOOLS = ['read_file', 'grep', 'list_dir'];
const WEB_TOOLS = ['web_search', 'web_fetch'];

const grokHome = () => process.env.GROK_HOME ?? join(homedir(), '.grok');

/** Reasoning efforts per model, from the cache that `grok models` keeps in the grok home. */
function cachedEfforts(): Map<string, { efforts: string[]; current: string }> {
  const out = new Map<string, { efforts: string[]; current: string }>();
  try {
    const file = join(grokHome(), 'models_cache.json');
    if (!existsSync(file)) return out;
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      models?: Record<string, { info?: Record<string, unknown> }>;
    };
    for (const [id, entry] of Object.entries(data.models ?? {})) {
      const info = entry.info ?? {};
      if (info.supports_reasoning_effort !== true) continue;
      const list = (info.reasoning_efforts as { id?: string }[] | undefined) ?? [];
      out.set(id, {
        efforts: list.flatMap((item) => (typeof item.id === 'string' ? [item.id] : [])),
        current: typeof info.reasoning_effort === 'string' ? info.reasoning_effort : '',
      });
    }
  } catch {
    // no cache: the models list without efforts
  }
  return out;
}

export function grokListingProblem(result: ProcResult) {
  const text = `${result.stdout}\n${result.stderr}`;
  if (
    /not authenticated|unauthenticated|not signed in|not logged in|please (?:log|sign) in/iu.test(
      text,
    )
  )
    return note('grok_not_logged_in');
  if (result.spawnError || result.timedOut || result.code !== 0) return note('grok_login_unknown');
  return null;
}

export const grokAdapter: Adapter = {
  info: { id: 'grok', label: 'Grok', ...HARNESS_RULES.grok },

  /**
   * Grok loads a project's hooks, instructions, skills and MCP servers when the folder is in its trust store (a grant also
   * covers the folders below a trusted one). Divan cannot switch that off, so a trusted folder is not used.
   */
  async cwdProblem(cwd: string, spec: RunSpec): Promise<string | null> {
    // With an MCP server the run is in a scratch folder and the project is only a path in the system prompt
    if (memberServers('grok', spec).length > 0) {
      return oddPath(cwd) ? 'the folder name holds a control character or a line separator' : null;
    }
    const found = resolveCommand('grok');
    if (!found) return 'grok is not installed';
    const result = await runProc({
      command: found.command,
      args: [...found.prefix, 'inspect', '--json'],
      cwd,
      env: { GROK_FOLDER_TRUST: '1' },
      idleMs: 20_000,
      maxMs: 20_000,
    });
    const data = (() => {
      try {
        return JSON.parse(result.stdout) as { projectTrusted?: unknown };
      } catch {
        return null;
      }
    })();
    if (data?.projectTrusted === false) return null;
    return data?.projectTrusted === true
      ? 'the folder is trusted in Grok, so its own hooks, rules and MCP servers would load'
      : 'could not tell whether the folder is trusted in Grok';
  },

  async listModels(): Promise<HarnessModels> {
    const result = await runListResult('grok', ['models']);
    const problem = grokListingProblem(result);
    if (problem)
      return {
        harness: 'grok',
        models: [],
        listed: false,
        defaultModel: '',
        note: problem,
        fallbackEfforts: [],
        fetchedAt: new Date().toISOString(),
      };
    const out = result.stdout;
    const efforts = cachedEfforts();
    const models: ModelInfo[] = [];
    let defaultModel = '';
    for (const line of out.split('\n')) {
      const match = /^\s+[*-]\s+(\S+)(\s+\(default\))?/u.exec(line);
      if (!match?.[1]) continue;
      const id = match[1];
      if (match[2]) defaultModel = id;
      const known = efforts.get(id);
      models.push({
        id,
        label: id,
        efforts: known?.efforts ?? [],
        defaultEffort: known?.current ?? '',
      });
    }
    return {
      harness: 'grok',
      models,
      listed: true,
      defaultModel,
      note: note('models_grok'),
      fallbackEfforts: ['low', 'medium', 'high', 'xhigh'],
      fetchedAt: new Date().toISOString(),
    };
  },

  build(spec: RunSpec, ioDir: string, workDir: string): CommandBuild | { error: string } {
    const found = resolveCommand('grok');
    if (!found) return { error: 'grok is not installed' };
    const promptFile = join(ioDir, 'prompt.txt');
    writeFileSync(promptFile, spec.prompt);
    const servers = memberServers('grok', spec);
    const memory = servers.some((server) => server.name === MEMORY_SERVER);
    // any MCP server (the memory, the T3 threads): the run is in our scratch folder, with a config of ours
    const scratch = servers.length > 0;
    const token = readReadOnlyToken();
    if (memory && !token) {
      return {
        error:
          "Grok has no memory without the read-only memory token (the memory-ro-token file in Divan's home)",
      };
    }
    const url = memory ? memoryUrl('grok') : null;
    if (memory && !url) {
      return { error: 'the memory server’s address is not known: it is in no assistant’s config' };
    }
    const args = [
      ...found.prefix,
      '--prompt-file',
      promptFile,
      '--output-format',
      'streaming-json',
      '--json-schema',
      JSON.stringify(providerSchema(spec.schema)),
      '-m',
      spec.model,
      '--no-subagents',
      '--no-plan',
      '--permission-mode',
      'dontAsk',
      // Grok's own long system prompt is replaced by a short one; the rules come in the message. (With memory it runs in a
      // scratch folder, and a project is a path it is told.)
      '--system-prompt-override',
      scratch ? projectPrompt(MEMBER_SYSTEM, spec.cwd) : MEMBER_SYSTEM,
    ];
    // Members only read: an allowlist of read-only tools (internal tool ids), plus the web tools when web is on.
    // An empty list means "no filter" to Grok (tested: it then offers its shell and edit tools), so with nothing wanted the
    // list holds one read-only tool.
    const allowed = [...(spec.tools ? READ_ONLY_TOOLS : []), ...(spec.web ? WEB_TOOLS : [])];
    const listed = allowed.length > 0 ? allowed : [READ_ONLY_TOOLS[2] as string];
    if (scratch) {
      // The meta-tools that reach MCP stay, for the servers of the allowlist alone: the others are switched off in the scratch
      // config, and the writers are denied by name besides (the memory server refuses them for the read-only token as well).
      args.push('--tools', [...listed, 'search_tool', 'use_tool'].join(','));
      for (const name of deniedMcp(servers, grokMcpName)) {
        args.push('--deny', `MCPTool(${name})`);
      }
      // Under `dontAsk` an MCP tool of a local (stdio) server is refused unless it is allowed by name (found by running Grok
      // against the T3 threads server: "User cancelled the execution"); a server over HTTP that marks its tool read-only runs
      // without. So every tool of the allowlist is allowed by name, one rule each (never a server, never a wildcard); `--deny`
      // wins over `--allow`, so a writer stays refused.
      for (const name of allowedMcp(servers, grokMcpName)) {
        args.push('--allow', `MCPTool(${name})`);
      }
    } else {
      args.push('--tools', listed.join(','));
      // Its MCP meta-tools are added to every tool list on their own; they go, so no MCP server (the user's memory server, a
      // browser server imported from the Claude config) is reachable at all.
      args.push('--disallowed-tools', 'search_tool,use_tool');
    }
    // Blindness: its read tools must not reach Divan's saved sessions or the harnesses' own folders.
    for (const folder of hiddenFolders()) {
      for (const tool of ['Read', 'Grep'])
        args.push('--deny', `${tool}(${homeRelative(folder)}/**)`);
    }
    if (spec.effort) args.push('--reasoning-effort', spec.effort);
    if (!spec.web) args.push('--disable-web-search');
    // Its own cross-session memory writes nothing. Its Claude-compatibility scans keep the user's instructions (rules,
    // agents) but not the Claude config's MCP servers, hooks and skills (the imported permission rules cannot be switched off;
    // they only add denials and questions).
    const env: Record<string, string | undefined> = { GROK_MEMORY: '0', ...scrubbedEnv() };
    if (scratch) {
      // The scratch folder's own `.grok/config.toml` is what replaces the user's memory entry (and adds the T3 threads server),
      // and Grok reads a project's config only with the folder trust check off: safe here, since the folder is ours and holds
      // nothing else. The memory token is named in the file as `${DIVAN_MEMORY_TOKEN}` and travels in the environment.
      env.GROK_FOLDER_TRUST = '0';
      if (memory) env[TOKEN_ENV] = token as string;
      mkdirSync(join(workDir, '.grok'), { recursive: true });
      const launch = t3Launch();
      const sections: string[] = [];
      for (const server of servers) {
        if (server.name === MEMORY_SERVER) {
          sections.push(
            `[mcp_servers.${MEMORY_SERVER}]`,
            `url = ${JSON.stringify(url)}`,
            `headers = { Authorization = ${JSON.stringify(`Bearer ${envRef(TOKEN_ENV)}`)} }`,
            '',
          );
        } else if (server.name === T3_SERVER) {
          const vars = Object.entries(launch.env).map(
            ([name, value]) => `${name} = ${JSON.stringify(value)}`,
          );
          sections.push(
            `[mcp_servers.${T3_SERVER}]`,
            `command = ${JSON.stringify(launch.command)}`,
            `args = [${launch.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
            `env = { ${vars.join(', ')} }`,
            '',
          );
        }
      }
      const config = [
        ...sections,
        // every other server of the user's own Grok config is switched off
        ...tomlServerNames('grok')
          .filter((name) => !servers.some((server) => server.name === name))
          .flatMap((name) => [`[mcp_servers.${JSON.stringify(name)}]`, 'enabled = false', '']),
      ].join('\n');
      writeFileSync(join(workDir, '.grok', 'config.toml'), config);
    } else if (spec.cwd) {
      // Folder trust stays on: a project's own hooks, rules, skills and MCP servers load only from a trusted folder.
      env.GROK_FOLDER_TRUST = '1';
    }
    for (const cell of ['MCPS', 'HOOKS', 'SKILLS']) env[`GROK_CLAUDE_${cell}_ENABLED`] = '0';
    // Grok's own wait for a silent model (`[models] inference_idle_timeout_secs`) is raised above Divan's idle window, so it
    // never stops a call first. (The overlay takes sections `models`, `features`, `toolset` and `shell_environment_policy`
    // only: an MCP or permission setting here would be dropped, so none is made.)
    env.GROK_CONFIG = JSON.stringify({ models: { inference_idle_timeout_secs: GROK_IDLE_SECS } });
    return { command: found.command, args, env, ...(scratch ? { cwd: workDir } : {}) };
  },

  /**
   * The thinking so far: the reasoning tokens a `usage` event reports, else counted from the `thought` text as it streams
   * (about four characters a token), the larger of the two.
   */
  watch(): StreamWatcher {
    let chars = 0;
    let reported = 0;
    const seen = new Set<string>();
    return lineWatcher((event) => {
      const tools: ToolEvent[] = [];
      if (event.type === 'tool_call' || event.type === 'tool_use') {
        const call = asRecord(event.data) ?? asRecord(event.tool_call) ?? event;
        const fn = asRecord(call.function);
        const name = call.name ?? call.toolName ?? fn?.name;
        const id = call.id ?? call.toolCallId;
        if (typeof name === 'string' && (typeof id !== 'string' || !seen.has(id))) {
          if (typeof id === 'string') seen.add(id);
          let input = call.rawInput ?? call.arguments ?? call.input ?? call.args ?? fn?.arguments;
          if (typeof input === 'string') {
            try {
              input = JSON.parse(input);
            } catch {
              /* a plain target stays text */
            }
          }
          tools.push(toolEvent(name, input, typeof call.server === 'string' ? call.server : ''));
        }
      }
      if (event.type === 'thought' && typeof event.data === 'string') chars += event.data.length;
      else if (event.type === 'usage') {
        reported = Math.max(reported, num(asRecord(event.usage)?.reasoning_tokens));
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
    const end = [...events].reverse().find((event) => event.type === 'end') ?? null;
    // the answer streams as `text` events; the schema-checked object, when there is one, arrives with the end
    const streamed = events
      .filter((event) => event.type === 'text' && typeof event.data === 'string')
      .map((event) => event.data as string)
      .join('');
    const usageOf = (usage: Record<string, unknown>) =>
      // `input_tokens` is what was not cached; `output_tokens` already holds the reasoning tokens.
      makeUsage(
        num(usage.input_tokens),
        num(usage.output_tokens),
        num(usage.cache_read_input_tokens),
      );
    const lastUsage = [...events].reverse().find((event) => event.type === 'usage');
    const reported = usageOf(asRecord(end?.usage) ?? asRecord(lastUsage?.usage) ?? {});
    const failed = events.find((event) => event.type === 'error');
    if (!end) {
      return {
        text: streamed || result.stdout,
        usage: reported,
        error:
          stopped ??
          (typeof failed?.message === 'string' ? failed.message : null) ??
          failure(result, 'no result in the output'),
      };
    }
    const structured = end.structuredOutput;
    const text =
      structured && typeof structured === 'object' ? JSON.stringify(structured) : streamed;
    if (stopped) return { text, usage: reported, error: stopped };
    // A non-zero exit is an error even when text came out; the text and usage stay for diagnostics.
    if (result.code !== 0 && result.code !== null) {
      return { text, usage: reported, error: failure(result, `exited with ${result.code}`) };
    }
    const reason = typeof end.stopReason === 'string' ? end.stopReason : 'end_turn';
    if (!text) {
      return {
        text,
        usage: reported,
        error:
          reason === 'end_turn'
            ? failure(result, 'no text in the output')
            : `stop reason: ${reason}`,
      };
    }
    return { text, usage: reported, error: null };
  },
};
