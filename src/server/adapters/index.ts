// The adapter registry and the one function that runs a harness: a fresh empty working folder, a separate folder for
// the schema and prompt files, the process with its timeout, then the adapter's own parse of what came out.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HARNESS_RULES } from '../../shared/harness-rules.ts';
import { note } from '../../shared/messages.ts';
import type { HarnessId, HarnessInfo, HarnessModels } from '../../shared/types.ts';
import { memoryReady } from '../memory-access.ts';
import { endsOf } from '../output.ts';
import { type ProcResult, runProc } from '../proc.ts';
import { agyAdapter } from './agy.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';
import { fakeModels, runFake } from './fake.ts';
import { grokAdapter } from './grok.ts';
import { hermesAdapter } from './hermes.ts';
import { piAdapter } from './pi.ts';
import type { Adapter, ParsedRun, RunSpec, StreamWatcher } from './types.ts';

const ADAPTERS: Record<HarnessId, Adapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  agy: agyAdapter,
  grok: grokAdapter,
  pi: piAdapter,
  hermes: hermesAdapter,
};

export const adapterFor = (id: HarnessId): Adapter => ADAPTERS[id];

export const HARNESS_IDS = Object.keys(ADAPTERS) as HarnessId[];

/** `DIVAN_FAKE=1`: every harness answers from the built-in fake (tests only). */
export const isFake = (): boolean => process.env.DIVAN_FAKE === '1';

export function harnessInfos(): HarnessInfo[] {
  return HARNESS_IDS.map((id) => ADAPTERS[id].info);
}

export interface AgentRun extends ParsedRun {
  timedOut: boolean;
  /** The caller aborted the run (a cancelled round). */
  cancelled: boolean;
  durationMs: number;
  /** The process's stdout and stderr, kept (cut) only when the run failed, for the stored raw output. */
  diagnostics: string;
  /** Set when the project folder was not used because the harness could not keep its own project files out. */
  folderNote?: string;
}

/** `DIVAN_DUMP_DIR`: keeps each harness's raw stdout and stderr in that folder, to study an output format (debugging only). */
function dump(spec: RunSpec, stdout: string, stderr: string): void {
  const dir = process.env.DIVAN_DUMP_DIR;
  if (!dir || spec.harness === 'hermes') return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${spec.harness}-${Date.now()}.stdout.txt`), stdout);
    if (stderr) writeFileSync(join(dir, `${spec.harness}-${Date.now()}.stderr.txt`), stderr);
  } catch {
    // a dump that cannot be written never fails a run
  }
}

/**
 * What a finished process means for the round. The adapter reads whatever the process printed first, whatever stopped it:
 * a cancelled or timed-out run keeps the usage and text it had already reported, and only what is missing is estimated.
 */
export function settleRun(
  adapter: Adapter,
  spec: RunSpec,
  result: ProcResult,
  watcher?: StreamWatcher,
): AgentRun {
  const stopped = {
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    durationMs: result.durationMs,
  };
  // short, and from both ends: what a harness says last is where its error is
  const diagnostics =
    spec.harness === 'hermes'
      ? ''
      : `${endsOf(result.stdout, 8_000, 12_000)}${result.stderr ? `\n--- stderr ---\n${endsOf(result.stderr, 1_500, 3_500)}` : ''}`;
  let parsed: ParsedRun | null = null;
  let unreadable: string | null = null;
  try {
    parsed = adapter.parse(result, spec);
    // An output too long to be kept whole has its middle left out: what a harness reports message by message (its usage) is
    // then what the stream added up to as it arrived, never what the buffer still holds.
    const seen = result.truncated ? watcher?.streamed?.() : undefined;
    if (parsed && seen) {
      parsed = {
        ...parsed,
        text: seen.text || parsed.text,
        usage: seen.usage ?? parsed.usage,
        ...(spec.harness === 'hermes' && seen.error ? { error: seen.error } : {}),
      };
    }
  } catch (error) {
    unreadable = `could not read the output: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (result.cancelled) {
    return {
      text: parsed?.text ?? '',
      usage: parsed?.usage ?? null,
      error: 'cancelled',
      ...stopped,
      diagnostics,
    };
  }
  if (!parsed) {
    return { text: '', usage: null, error: unreadable ?? 'unreadable', ...stopped, diagnostics };
  }
  return { ...parsed, ...stopped, diagnostics: parsed.error !== null ? diagnostics : '' };
}

const failedRun = (error: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  text: '',
  usage: null,
  error,
  timedOut: false,
  cancelled: false,
  durationMs: 0,
  diagnostics: '',
  ...extra,
});

/**
 * One call through one adapter: a fresh empty working folder (or the project folder, when the harness can keep the
 * folder's own files out), the process with its silence watchdog, then the adapter's own parse of what came out. Whatever happens,
 * a project folder that was not used is said in `folderNote` of the result: success or failure, the client must know that
 * the member answered without it.
 */
export async function runWithAdapter(adapter: Adapter, spec: RunSpec): Promise<AgentRun> {
  const base = mkdtempSync(join(tmpdir(), 'divan-run-'));
  const work = join(base, 'work');
  const io = join(base, 'io');
  mkdirSync(work);
  mkdirSync(io);
  let folderNote: string | undefined;
  let cleanup: (() => void | Promise<void>) | undefined;
  let outcome: AgentRun | undefined;
  const noted = (run: AgentRun): AgentRun => {
    outcome = folderNote ? { ...run, folderNote } : run;
    return outcome;
  };
  try {
    // A project folder is used only when the harness can leave the folder's own settings and hooks alone.
    let folder = spec.cwd;
    if (folder && adapter.cwdProblem) {
      const problem = await adapter
        .cwdProblem(folder, spec)
        .catch(
          (error: unknown) =>
            `could not check: ${error instanceof Error ? error.message : String(error)}`,
        );
      if (problem) {
        folderNote = `working folder not used by ${spec.harness}: ${problem}`;
        console.error(`[divan] ${folderNote}`);
        folder = undefined;
      }
    }
    // One adapter's exception ends one call, never the round: whatever goes wrong becomes this call's error.
    const { cwd: _asked, ...rest } = spec;
    const built = await adapter.build(folder ? { ...rest, cwd: folder } : rest, io, work);
    if ('error' in built) return noted(failedRun(built.error));
    cleanup = built.cleanup;
    // every chunk of the output is a sign of work; what the adapter can read of it says how much thinking there has been
    const watcher = adapter.watch?.(spec);
    const result = await runProc({
      command: built.command,
      args: built.args,
      cwd: built.cwd ?? folder ?? work,
      ...(built.env ? { env: built.env } : {}),
      ...(built.envMode ? { envMode: built.envMode } : {}),
      ...(built.stdin !== undefined ? { stdin: built.stdin } : {}),
      idleMs: spec.idleMs,
      onStdout: (chunk) => {
        // the watcher reads every chunk, whether or not anybody listens for the signs
        const sign = watcher?.push(chunk);
        spec.onSignal?.(sign ?? {});
      },
      ...(spec.signal ? { signal: spec.signal } : {}),
    });
    dump(spec, result.stdout, result.stderr);
    return noted(settleRun(adapter, spec, result, watcher));
  } catch (error) {
    return noted(
      failedRun(
        spec.harness === 'hermes'
          ? note('hermes_guard').message
          : error instanceof Error
            ? error.message
            : String(error),
      ),
    );
  } finally {
    try {
      await cleanup?.();
    } catch {
      if (outcome) outcome.error = note('hermes_cleanup').message;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
}

export async function runAgent(spec: RunSpec): Promise<AgentRun> {
  if (spec.harness === 'hermes' && process.platform !== 'win32')
    return failedRun(note('hermes_platform').message);
  if (!HARNESS_RULES[spec.harness]?.supported) {
    return failedRun(
      `${spec.harness} is not supported: ${HARNESS_RULES[spec.harness]?.unsupportedNote?.message ?? 'unknown harness'}`,
    );
  }
  if (isFake()) return runFake(spec);
  return runWithAdapter(ADAPTERS[spec.harness], spec);
}

// ---------- model lists, cached for the life of the server ----------

const cache = new Map<HarnessId, HarnessModels>();

export async function modelsFor(harness: HarnessId, refresh = false): Promise<HarnessModels> {
  const cached = cache.get(harness);
  if (cached && !refresh) return cached;
  let models: HarnessModels;
  if (isFake()) {
    models = fakeModels(harness);
  } else {
    try {
      models = await ADAPTERS[harness].listModels();
    } catch (error) {
      models = {
        harness,
        models: [],
        listed: false,
        defaultModel: '',
        note: note('models_list_failed', {
          detail: error instanceof Error ? error.message : String(error),
        }),
        fallbackEfforts: [],
        fetchedAt: new Date().toISOString(),
      };
    }
  }
  // a real harness can be given the memory when its own config (or Divan's read-only token) lets a connection be built
  if (!isFake() && harness !== 'hermes') models = { ...models, memoryReady: memoryReady(harness) };
  cache.set(harness, models);
  return models;
}
