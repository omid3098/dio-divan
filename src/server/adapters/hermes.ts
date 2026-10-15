import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import type { HarnessModels, Usage } from '../../shared/types.ts';
import type { ProcResult } from '../proc.ts';
import { discoverHermes, type HermesDiscovery } from './hermes-install.ts';
import { prepareHermes } from './hermes-run.ts';
import type { Adapter, ParsedRun, StreamWatcher } from './types.ts';
import { asRecord, jsonLines, lineWatcher, num, oddPath, projectPrompt } from './util.ts';

function reader() {
  let text = '',
    terminal = '',
    error: string | null = null;
  let usage: Usage | null = null;
  let finished = false;
  const calls = new Set<string>();
  const read = (): ParsedRun => ({
    text,
    usage,
    error: error ?? (finished ? null : note('hermes_guard').message),
  });
  const add = (event: Record<string, unknown>) => {
    if (event.type === 'result') {
      const signature = JSON.stringify([event.text, event.exit_code, event.tokens, event.error]);
      if (finished && signature !== terminal) error = note('hermes_guard').message;
      finished = true;
      terminal = signature;
      if (typeof event.text !== 'string' || event.exit_code !== 0 || event.error)
        error = note('hermes_guard').message;
      else text = event.text;
      const tokens = asRecord(event.tokens);
      if (
        tokens &&
        ['input', 'output'].every(
          (key) => Number.isSafeInteger(tokens[key]) && Number(tokens[key]) >= 0,
        ) &&
        ['cache_read', 'cache_write', 'total'].every(
          (key) =>
            tokens[key] === undefined ||
            (Number.isSafeInteger(tokens[key]) && Number(tokens[key]) >= 0),
        )
      ) {
        // Hermes' canonical input bucket excludes reads from cache; cache writes are uncached input.
        const input = num(tokens.input) + num(tokens.cache_write),
          cached = num(tokens.cache_read),
          output = num(tokens.output);
        usage = { input, cached, output, total: input + cached + output, source: 'harness' };
        if (tokens.total !== undefined && tokens.total !== usage.total)
          error = note('hermes_guard').message;
      } else if (tokens) {
        usage = null;
        error = note('hermes_guard').message;
      }
    } else if (event.type === 'text' && typeof event.text === 'string' && !finished)
      text = (text + event.text).slice(-64000);
    else if (event.type === 'error') error = note('hermes_guard').message;
    if (
      event.type !== 'tool_use' ||
      typeof event.name !== 'string' ||
      typeof event.tool_call_id !== 'string' ||
      calls.has(event.tool_call_id)
    )
      return;
    calls.add(event.tool_call_id);
    const input = asRecord(event.input);
    const target = input?.path ?? input?.slug ?? input?.threadId ?? input?.sessionId;
    const name = event.name;
    return {
      tools: [
        {
          name: name.slice(0, 100),
          kind: name.startsWith('mcp_memory_')
            ? ('memory' as const)
            : name.startsWith('mcp_t3_') || name.startsWith('mcp_hermes_history_')
              ? ('thread' as const)
              : ['read_file', 'search_files', 'skill_view'].includes(name)
                ? ('file' as const)
                : ('other' as const),
          target:
            typeof target === 'string' && !oddPath(target) && !target.startsWith('http')
              ? target.slice(0, 200)
              : '',
        },
      ],
    };
  };
  return { add, read };
}

export function hermesModels(found: HermesDiscovery): HarnessModels {
  return {
    harness: 'hermes',
    models: found.routes.map((route) => ({
      id: route.id,
      label: `${route.provider} · ${route.model}`,
      efforts: ['low', 'medium', 'high', 'xhigh'],
      defaultEffort: 'medium',
    })),
    listed: true,
    defaultModel: found.routes.find((route) => route.default)?.id ?? '',
    note: found.problem ?? found.memoryProblem ?? (found.moaExcluded ? note('hermes_moa') : null),
    fallbackEfforts: [],
    fetchedAt: new Date().toISOString(),
    memoryReady: found.memory !== null,
  };
}

export const hermesAdapter: Adapter = {
  info: { id: 'hermes', label: 'Hermes', ...HARNESS_RULES.hermes },
  async listModels() {
    return hermesModels(await discoverHermes());
  },
  async check() {
    return (await discoverHermes()).problem;
  },
  async build(spec) {
    if (process.platform !== 'win32') return { error: note('hermes_platform').message };
    if (spec.web) return { error: note('hermes_web_note').message };
    const found = await discoverHermes();
    const route = found.routes.find((route) => route.id === spec.model);
    if (found.problem || !found.layout || !route)
      return { error: (found.problem ?? note('hermes_route')).message };
    if (spec.memory && !found.memory) return { error: note('hermes_guard').message };
    const run = prepareHermes(found.layout, route, spec, found.memory);
    const schema = JSON.stringify(providerSchema(spec.schema));
    return {
      command: found.layout.basePython,
      args: run.args,
      env: run.env,
      envMode: 'replace',
      cwd: run.control,
      cleanup: run.cleanup,
      stdin: `${projectPrompt(spec.prompt, spec.cwd)}\n\nReturn only JSON matching this anonymous schema: ${schema}\n\nInstructions:\n${run.instructions}\n\nCopied memory text:\n${run.memoryText}\n\nPermitted copied read material: ${JSON.stringify(run.copied)}`,
    };
  },
  watch(): StreamWatcher {
    const state = reader();
    return { ...lineWatcher(state.add), streamed: state.read };
  },
  parse(result: ProcResult) {
    const state = reader();
    for (const event of jsonLines(result.stdout)) state.add(event);
    const parsed = state.read();
    if (result.code !== 0 || result.spawnError || result.timedOut)
      parsed.error = note(result.code === 125 ? 'hermes_guard' : 'hermes_install').message;
    return parsed;
  },
};
