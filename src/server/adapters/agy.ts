// agy is a manual, warned exception: its own settings control access; no Divan toggle enforces read-only use.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { type Note, note } from '../../shared/messages.ts';
import { providerSchema } from '../../shared/provider-schema.ts';
import type { HarnessModels, ModelInfo, Usage } from '../../shared/types.ts';
import { scrubbedEnv } from '../memory-access.ts';
import { type ProcResult, resolveCommand, runProc } from '../proc.ts';
import { toolEvent } from './activity.ts';
import type { Adapter, ParsedRun, StreamWatcher } from './types.ts';
import {
  asRecord,
  failure,
  jsonLines,
  lineWatcher,
  num,
  oddPath,
  projectPrompt,
  unlisted,
} from './util.ts';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const env = () => ({ ...scrubbedEnv(), DIVAN_MEMORY_TOKEN: undefined });

async function command(args: string[]): Promise<ProcResult> {
  const found = resolveCommand('agy');
  if (!found) throw new Error('agy is not installed');
  const work = mkdtempSync(join(tmpdir(), 'divan-agy-list-'));
  try {
    return await runProc({
      command: found.command,
      args: [...found.prefix, ...args],
      cwd: work,
      env: env(),
      idleMs: 60000,
      maxMs: 60000,
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Cache only the installed stdin contract; model discovery still belongs to each explicit detection cycle. */
let compatible: Promise<Note | null> | undefined;
const check = () => {
  compatible ??= command(['--help'])
    .then((result) => {
      if (result.spawnError || result.timedOut || result.code !== 0)
        throw new Error(failure(result, 'agy help failed'));
      return /--input-format[^\n]*stream-json/u.test(result.stdout + result.stderr)
        ? null
        : note('agy_incompatible');
    })
    .catch((error) => {
      return note('models_list_failed', {
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  return compatible;
};

function usageOf(raw: unknown): Usage | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);
  const cached = num(usage.cache_read_tokens);
  const total = typeof usage.total_tokens === 'number' ? num(usage.total_tokens) : input + output;
  // agy's input includes cached tokens, and output includes thinking: neither is added a second time.
  return total
    ? { input: Math.max(0, input - cached), output, cached, total, source: 'harness' }
    : null;
}

function reader() {
  let text = '';
  let error: string | null = null;
  let finalUsage: Usage | null = null;
  let finished = false;
  const usage = new Map<number, Usage>();
  const thinking = new Map<number, number>();
  const tools = new Set<number>();
  const read = () => ({
    text,
    error,
    usage: finished
      ? finalUsage
      : [...usage.values()].reduce<Usage | null>(
          (sum, item) =>
            sum
              ? {
                  input: sum.input + item.input,
                  output: sum.output + item.output,
                  cached: sum.cached + item.cached,
                  total: sum.total + item.total,
                  source: 'harness',
                }
              : item,
          null,
        ),
  });
  const add = (event: Record<string, unknown>) => {
    if (event.event === 'result') {
      const result = asRecord(event.result);
      if (!result) return;
      finished = true;
      if (result.structured_output !== undefined) text = JSON.stringify(result.structured_output);
      else if (typeof result.response === 'string') text = result.response;
      finalUsage = usageOf(result.usage);
      error =
        result.status === 'SUCCESS'
          ? null
          : typeof result.error === 'string'
            ? result.error
            : `agy: ${String(result.status)}`;
      return { thinkingTokens: num(asRecord(result.usage)?.thinking_tokens) };
    }
    if (event.event !== 'step_update') return;
    const step = asRecord(event.step_update);
    if (!step || typeof step.step_index !== 'number') return;
    const index = step.step_index;
    const counted = usageOf(step.usage);
    if (counted) usage.set(index, counted);
    if (asRecord(step.usage)) thinking.set(index, num(asRecord(step.usage)?.thinking_tokens));
    if (step.step_type === 'agent_response' && typeof step.text_delta === 'string')
      text = (text + step.text_delta).slice(-64000);
    const sign = { thinkingTokens: [...thinking.values()].reduce((a, b) => a + b, 0) };
    if (step.step_type !== 'tool' || tools.has(index)) return sign;
    const info = asRecord(step.tool_info);
    const name = typeof step.tool_name === 'string' ? step.tool_name : info?.name;
    if (typeof name !== 'string') return sign;
    tools.add(index);
    const params = asRecord(info?.parameters);
    // Keep only bounded file/URL targets, never commands, tool output, headers or complete arguments.
    const target =
      params?.TargetFile ??
      params?.AbsolutePath ??
      params?.SearchDirectory ??
      params?.Url ??
      params?.file_path;
    let path = typeof target === 'string' && !oddPath(target) ? target.slice(0, 200) : '';
    if (/^https?:/iu.test(path)) {
      try {
        const url = new URL(path);
        path = `${url.origin}${url.pathname}`;
      } catch {
        path = '';
      }
    }
    return { ...sign, tools: [toolEvent(name.slice(0, 100), { path })] };
  };
  return { add, read };
}

export const agyAdapter: Adapter = {
  info: { id: 'agy', label: 'agy', ...HARNESS_RULES.agy },
  check,
  async listModels(): Promise<HarnessModels> {
    compatible = undefined;
    const problem = await check();
    if (problem) return unlisted('agy', problem, EFFORTS);
    const result = await command(['models', '--output-format', 'json']);
    // Installed 1.3.4 refuses the JSON listing flag; never fall back to a backend-contacting human catalogue.
    if (result.spawnError || result.timedOut)
      throw new Error(failure(result, 'agy model listing failed'));
    if (result.code !== 0) {
      if (
        /flags? (?:provided but )?not defined[^\n]*output-format|unknown (?:option|flag)[^\n]*output-format/iu.test(
          result.stderr + result.stdout,
        )
      )
        return unlisted('agy', note('agy_models_typed'), EFFORTS);
      throw new Error(failure(result, 'agy model listing failed'));
    }
    let data: unknown;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      return unlisted('agy', note('agy_models_typed'), EFFORTS);
    }
    const rows = Array.isArray(data) ? data : asRecord(data)?.models;
    const models: ModelInfo[] = Array.isArray(rows)
      ? rows.flatMap((raw) => {
          const row = asRecord(raw);
          const id = row?.id ?? row?.slug;
          if (typeof id !== 'string' || !id || id.length > 120 || id.startsWith('divan/'))
            return [];
          return [
            {
              id,
              label: typeof row?.name === 'string' ? row.name : id,
              efforts: Array.isArray(row?.efforts)
                ? row.efforts.filter(
                    (e): e is string => typeof e === 'string' && EFFORTS.includes(e),
                  )
                : [],
              defaultEffort: '',
            },
          ];
        })
      : [];
    return {
      ...unlisted('agy', models.length ? null : note('agy_models_typed'), EFFORTS),
      models,
      listed: models.length > 0,
    };
  },
  async cwdProblem(cwd) {
    return oddPath(cwd) ? 'the folder name holds a control character or a line separator' : null;
  },
  build(spec, ioDir, workDir) {
    const found = resolveCommand('agy');
    if (!found) return { error: 'agy is not installed' };
    mkdirSync(ioDir, { recursive: true });
    const schema = join(ioDir, 'schema.json');
    writeFileSync(schema, JSON.stringify(providerSchema(spec.schema)));
    return {
      command: found.command,
      args: [
        ...found.prefix,
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--json-schema',
        schema,
        '--model',
        spec.model,
        ...(spec.effort ? ['--effort', spec.effort] : []),
        '--print-timeout',
        '0',
      ],
      cwd: workDir,
      env: env(),
      stdin: `${JSON.stringify({
        event: 'user',
        message: { content: projectPrompt(spec.prompt, spec.cwd) },
      })}\n`,
    };
  },
  watch(): StreamWatcher {
    const tally = reader();
    const watcher = lineWatcher(tally.add);
    return { push: (chunk) => watcher.push(chunk), streamed: tally.read };
  },
  parse(result): ParsedRun {
    const tally = reader();
    for (const event of jsonLines(result.stdout)) tally.add(event);
    const read = tally.read();
    if (
      /flags? (?:provided but )?not defined[^\n]*input-format|unknown (?:option|flag)[^\n]*input-format/iu.test(
        result.stderr + result.stdout,
      )
    )
      read.error = note('agy_incompatible').message;
    else if (result.spawnError || result.timedOut || result.code !== 0)
      read.error ??= failure(result, 'agy failed');
    else if (!read.text && !read.error) read.error = failure(result, 'no agy answer in the output');
    return read;
  },
};
