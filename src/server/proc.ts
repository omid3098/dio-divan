// Running one harness process: no shell, the prompt on stdin, a watchdog on its output that kills the whole process tree
// when it has been silent too long (and no other limit: while it keeps writing it is never stopped), and a registry of live
// children so a server shutdown can stop exactly the processes it started (by PID).

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { processExists, withoutT3 } from './launch.ts';
import { BoundedOutput, HEAD_OUTPUT, STDERR_OUTPUT, TAIL_OUTPUT } from './output.ts';

export interface ProcSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  envMode?: 'replace';
  stdin?: string;
  /**
   * The only limit on a run of a harness: it is stopped when this long passes after its last output (any chunk on stdout is
   * a sign of work) with no new one. While it keeps writing it is never stopped, however long it takes.
   */
  idleMs: number;
  /** A wall-clock limit for housekeeping commands (listing models, a trust check), never for a member or the chairman. */
  maxMs?: number;
  /** Every chunk of stdout, as it arrives. */
  onStdout?: (chunk: string) => void;
  /** Aborting it kills the process tree; the result says `cancelled`. */
  signal?: AbortSignal;
}

export interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** Stopped because it was silent for `idleMs` (or, for a housekeeping command, ran past `maxMs`). */
  timedOut: boolean;
  /** The caller aborted the run (a cancelled round). */
  cancelled: boolean;
  /** The output was longer than is kept: its middle is left out (see `BoundedOutput`). */
  truncated?: boolean;
  /** Set when the process could not be started at all. */
  spawnError: string | null;
  durationMs: number;
}

/** After a timeout or a cancel the run settles by itself once the kill had this long, whatever the kill does. */
const KILL_GRACE_MS = 5000;
const live = new Set<ChildProcess>();

/** taskkill by its absolute path, so a planted taskkill.exe on PATH or in the working folder is never run. */
export const TASKKILL = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');

/**
 * Kills `pid` and everything it started. Resolves true when the kill went through (or the process was already gone),
 * false when it could not be done: the caller then still settles the run on its own.
 */
export async function killTree(pid: number): Promise<boolean> {
  if (process.platform !== 'win32') {
    // Children can have survived their parent; calls own a group, foreground servers may not.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* No process group, or already gone. */
    }
    if (processExists(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* Check the outcome below. */
      }
    }
    const killed = Date.now() + 1000;
    while (processExists(pid) && Date.now() < killed)
      await new Promise((done) => setTimeout(done, 50));
    return !processExists(pid);
  }
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      let done = false;
      const settle = (ok: boolean) => {
        if (!done) {
          done = true;
          resolve(ok);
        }
      };
      try {
        const killer = spawn(TASKKILL, ['/T', '/F', '/PID', String(pid)], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => settle(false));
        // 0: killed. 128: no such process, which means it is already gone.
        killer.on('exit', (code) => settle(code === 0 || code === 128));
        setTimeout(() => settle(false), KILL_GRACE_MS).unref();
      } catch {
        settle(false);
      }
    }
  });
}

/**
 * Set once a shutdown has begun: nothing is started after that, whatever was waiting to go on to its next call (a detection's
 * next probe, a round's next member), or it would outlive the server.
 */
let closing = false;

/** A server that starts (again, in a process that has closed one: tests) may run children. */
export function allowChildren(): void {
  closing = false;
}

/** Stops every child this server started, and refuses to start another one (`allowChildren` lifts that). */
export async function killAllChildren(): Promise<void> {
  closing = true;
  await Promise.all(
    [...live].map((child) => (child.pid ? killTree(child.pid) : Promise.resolve(true))),
  );
}

export function runProc(spec: ProcSpec): Promise<ProcResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Bounded: a long stream keeps its beginning and, above all, its end (the final answer and usage).
    const stdout = new BoundedOutput(HEAD_OUTPUT, TAIL_OUTPUT);
    const stderr = new BoundedOutput(STDERR_OUTPUT / 4, STDERR_OUTPUT);
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: NodeJS.Timeout | undefined;
    let hard: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let stopping = false;
    let killing: Promise<boolean> | undefined;
    const finish = (code: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      clearTimeout(grace);
      spec.signal?.removeEventListener('abort', onAbort);
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.elided,
        code,
        timedOut,
        cancelled,
        spawnError,
        durationMs: Date.now() - started,
      });
    };
    // Kill the tree; the run settles when the process closes, or after the grace period whatever happens to the kill.
    const stop = () => {
      if (settled) return;
      stopping = true;
      clearTimeout(timer);
      const pid = child?.pid;
      if (pid) {
        killing = killTree(pid).then((ok) => {
          if (!ok) child?.kill('SIGKILL');
          return ok;
        });
      }
      clearTimeout(grace);
      if (spec.envMode !== 'replace') grace = setTimeout(() => finish(null, null), KILL_GRACE_MS);
    };
    function onAbort() {
      cancelled = true;
      stop();
    }
    if (closing || spec.signal?.aborted) {
      cancelled = true;
      finish(null, null);
      return;
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    // the watchdog: re-armed by every sign of work, so a run that keeps writing is never stopped
    const arm = () => {
      if (stopping) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, spec.idleMs);
    };
    arm();
    if (spec.maxMs !== undefined) {
      hard = setTimeout(() => {
        timedOut = true;
        stop();
      }, spec.maxMs);
    }
    try {
      if (spec.envMode === 'replace') {
        const names = new Set<string>();
        for (const [name, value] of Object.entries(spec.env ?? {})) {
          if (
            !name ||
            /[=\0]/u.test(name) ||
            value?.includes('\0') ||
            names.has(name.toUpperCase())
          )
            throw new Error('Invalid replacement environment');
          names.add(name.toUpperCase());
        }
      }
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        // T3 Code's credential is never passed on, whatever started this server (see `withoutT3`)
        env: withoutT3(
          spec.envMode === 'replace' ? (spec.env ?? {}) : { ...process.env, ...spec.env },
        ) as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish(null, error instanceof Error ? error.message : String(error));
      return;
    }
    const proc = child;
    live.add(proc);
    proc.stdout?.setEncoding('utf8');
    proc.stderr?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      stdout.push(chunk);
      arm();
      try {
        spec.onStdout?.(chunk);
      } catch {
        // a watcher that fails never ends a run
      }
    });
    proc.stderr?.on('data', (chunk: string) => {
      stderr.push(chunk);
    });
    proc.on('error', (error) => finish(null, error.message));
    proc.on('close', async (code) => {
      live.delete(proc);
      if (spec.envMode === 'replace') await killing;
      finish(code, null);
    });
    proc.stdin?.on('error', () => undefined);
    if (spec.stdin !== undefined) proc.stdin?.end(spec.stdin, 'utf8');
    else proc.stdin?.end();
  });
}

/**
 * Finds a command on PATH. A Windows npm shim (`name.cmd`) is resolved to `node <script.js>` so the prompt and the
 * arguments never pass through cmd.exe.
 */
export function resolveCommand(name: string): { command: string; prefix: string[] } | null {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = join(dir, `${name}${ext}`);
      if (!existsSync(file)) continue;
      if (ext === '.cmd') {
        const shim = readFileSync(file, 'utf8');
        const target = [
          ...shim.matchAll(/"(?:[A-Z_]+=)?%(?:dp0|~dp0)%?\\?([^"]+?\.(?:js|mjs|cjs|exe))"/giu),
        ]
          .reverse()
          .find((match) => match[1] && existsSync(join(dir, match[1])))?.[1];
        const script = target ? join(dir, target) : null;
        if (script && existsSync(script))
          return /\.exe$/iu.test(script)
            ? { command: script, prefix: [] }
            : { command: process.execPath, prefix: [script] };
        continue;
      }
      if (ext === '' && process.platform === 'win32') continue;
      return { command: file, prefix: [] };
    }
  }
  return null;
}
