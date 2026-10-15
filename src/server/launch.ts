// Launching the one Divan server, for every client that needs it: the CLI (`divan start`), the ACP bridge (T3 Code)
// and, by a copy of the same rule, the Pi extension. Every bridge process loads this file, so it imports only `node:*` and
// `../shared/*`: never the engine or the server.
//
// A client never starts the server as its own child. The client of a harness (T3 Code, Pi) stops a process by killing its
// whole tree, and a server that is a descendant of the client would die with it. The client runs a short-lived launcher
// (`divan start`) that starts the server detached and exits, so the server's parent is gone and it is in nobody's tree.

import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_PORT } from '../shared/defaults.ts';
import { DEFAULT_LEVEL, isLevel } from '../shared/levels.ts';
import { PACKAGE_ROOT } from '../shared/package-root.ts';
import type { ReasoningLevel } from '../shared/types.ts';

export interface ServerState {
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt?: string;
  version?: string;
}

/** The same rule as `defaultHome` in store.ts (a test asserts that they agree), kept here so that this file stands apart. */
export function divanHome(): string {
  return process.env.DIVAN_HOME ?? join(homedir(), '.dio-divan');
}

export const stateFile = (home: string) => join(home, 'server.json');

/** The state file of a running server, or null when it is missing or not what the server writes. */
export function readServerState(home: string): ServerState | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(home), 'utf8')) as Partial<ServerState> | null;
    if (
      !state ||
      !Number.isInteger(state.pid) ||
      !Number.isInteger(state.port) ||
      typeof state.token !== 'string'
    )
      return null;
    const port = state.port as number;
    return {
      ...state,
      pid: state.pid as number,
      port,
      token: state.token,
      url:
        typeof state.url === 'string'
          ? state.url
          : `http://127.0.0.1:${port}/#token=${state.token}`,
    };
  } catch {
    return null;
  }
}

/**
 * Whether the server in `state` answers its health check AND is the process the file names: the answer carries the server's
 * own pid, so a stale file whose port another program now holds (any 2xx would pass for a plain status check) is not
 * taken for a Divan, and `stop` never acts on a process that only reused the number.
 */
export async function serverHealthy(state: ServerState, timeoutMs = 2500): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      headers: { 'x-divan-token': state.token },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; pid?: unknown } | null;
    return body?.ok === true && body.pid === state.pid;
  } catch {
    return false;
  }
}

/** Whether a process with this id exists (signal 0 only asks; a process of another account answers EPERM and exists). */
export function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * The state of a server that answers its health check, or null. A failed check says little (a busy server can be slow, and
 * only the server writes the file, once): the file is removed as stale only when the process it names is gone, and only if it
 * still names that process, so a live server is never left without its file.
 */
export async function runningServer(home: string): Promise<ServerState | null> {
  const state = readServerState(home);
  if (!state) return null;
  if (await serverHealthy(state)) return state;
  if (!processExists(state.pid)) {
    const now = readServerState(home);
    if (now && now.pid === state.pid && now.token === state.token)
      rmSync(stateFile(home), { force: true });
  }
  return null;
}

function readSettingsFile(home: string): { port?: unknown; profiles?: unknown } | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    return value && typeof value === 'object' ? (value as { port?: unknown }) : null;
  } catch {
    return null;
  }
}

/** The port Divan listens on: `port` of its settings.json when that is a real port, else the built-in default. */
export function configuredPort(home: string): number {
  const port = readSettingsFile(home)?.port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORT;
}

/** The key `/v1` wants, from the file the server keeps (`api-key`), or null while the server has not made one. */
export function readApiKey(home: string): string | null {
  try {
    const key = readFileSync(join(home, 'api-key'), 'utf8').trim();
    return key.length >= 24 ? key : null;
  } catch {
    return null;
  }
}

/**
 * An environment without T3 Code's credential for its own tools (`T3_ACP_*`, whatever the case) and `ELECTRON_RUN_AS_NODE`
 * (it would make a node child behave as Electron). It must never reach the Divan server or the harnesses it runs, who could
 * call T3 with it: so every place that starts a process of ours uses this, `runProc` above all (a server started in the
 * foreground from a T3 terminal carries the credential too).
 */
export function withoutT3(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    const name = key.toUpperCase();
    if (name.startsWith('T3_ACP_') || name === 'ELECTRON_RUN_AS_NODE') continue;
    env[key] = value;
  }
  return env;
}

/** The environment of a Divan server that a launcher starts: `withoutT3`, and it never opens a browser by itself. */
export function serverEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...withoutT3(base), DIVAN_NO_OPEN: '1' };
}

/** The `divan` command's script. */
export const BIN = join(PACKAGE_ROOT, 'bin', 'dio-divan.mjs');

const LAUNCHER_WAIT_MS = 30_000;
const POLL_MS = 250;
/** How much of the launcher's last output goes into an error: enough for its reason, not a log. */
const OUTPUT_TAIL = 1500;

/**
 * Runs `divan start --no-wait` and waits for it: the launcher starts the server detached, prints the server's process id
 * and exits at once. Resolves with that id. Never inherits the caller's stdio (it may be a protocol channel). The launcher
 * is gone within moments of starting the server, so a harness that kills the bridge's whole process tree (T3 Code) finds the
 * server in nobody's tree; the server may still be starting, and is waited for by `waitForServer`.
 */
function runLauncher(home: string, waitMs: number): Promise<number> {
  return new Promise((done, fail) => {
    let output = '';
    let printed = '';
    let settled = false;
    let limit: NodeJS.Timeout | undefined;
    const finish = (pid: number | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      if (pid instanceof Error) fail(pid);
      else done(pid);
    };
    const failed = (what: string) => {
      const tail = output.trim().slice(-OUTPUT_TAIL);
      finish(new Error(tail ? `${what}: ${tail}` : what));
    };
    // A neutral folder and an absolute home: the launcher and the server it starts must not keep the client's folder (a T3
    // worktree) as their working directory, which Windows then cannot delete or rename while Divan runs.
    const child = spawn(
      process.execPath,
      [BIN, 'start', '--no-wait', '--port', String(configuredPort(home))],
      {
        cwd: homedir(),
        env: { ...serverEnv(), DIVAN_HOME: resolve(home) },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout.on('data', (chunk: Buffer) => {
      printed += chunk.toString('utf8');
      collect(chunk);
    });
    child.stderr.on('data', collect);
    child.on('error', (error) => failed(`Dio Divan could not be started (${error.message})`));
    // `close` waits for the pipes to drain, so the last lines of the launcher are in `output` when it is judged.
    child.on('close', (code, signal) => {
      if (code !== 0) return failed(`Dio Divan did not start (exit code ${code ?? signal})`);
      const pid = Number(printed.trim());
      if (Number.isInteger(pid) && pid > 0) finish(pid);
      else failed('Dio Divan could not be started (the launcher gave no process id)');
    });
    limit = setTimeout(() => {
      child.kill();
      failed(`Dio Divan did not start within ${Math.round(waitMs / 1000)} seconds`);
    }, waitMs);
  });
}

/** A server that answers, with the API key of `/v1` and the address of `/v1`. */
export interface ReadyServer {
  state: ServerState;
  apiKey: string;
  baseUrl: string;
}

/**
 * Waits for the server that process `pid` is starting to answer. The file and the health check say when it is up; the
 * process itself says when it is not going to be (it printed its reason nowhere: it has no console), so a start that failed
 * is reported at once and not after the whole wait.
 */
async function waitForServer(home: string, pid: number, waitMs: number): Promise<ServerState> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    // asked before the file is read: a server that is found up is used, and one that is gone with no file is a failed start
    const alive = processExists(pid);
    const state = await runningServer(home);
    if (state) return state;
    if (!alive)
      throw new Error(
        'Dio Divan stopped while starting. Run divan serve in a terminal to see why.',
      );
    if (Date.now() >= deadline)
      throw new Error(`Dio Divan did not start within ${Math.round(waitMs / 1000)} seconds`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function bringUp(home: string, waitMs: number): Promise<ReadyServer> {
  let state = readServerState(home);
  if (!state || !(await serverHealthy(state))) {
    const started = Date.now();
    const pid = await runLauncher(home, waitMs);
    state = await waitForServer(home, pid, Math.max(0, waitMs - (Date.now() - started)));
  }
  const apiKey = readApiKey(home);
  if (!apiKey) {
    throw new Error(
      `Dio Divan is running but has not made its API key (${join(home, 'api-key')}); stop it and start it again`,
    );
  }
  return { state, apiKey, baseUrl: `http://127.0.0.1:${state.port}/v1` };
}

const starting = new Map<string, Promise<ReadyServer>>();

/**
 * The running server, its API key and its `/v1` address; starts the server (through the launcher) when none answers.
 * Calls in one process share one start.
 */
export function ensureServer(
  home: string = divanHome(),
  options: { waitMs?: number } = {},
): Promise<ReadyServer> {
  let pending = starting.get(home);
  if (!pending) {
    pending = bringUp(home, options.waitMs ?? LAUNCHER_WAIT_MS).finally(() => {
      starting.delete(home);
    });
    starting.set(home, pending);
  }
  return pending;
}

export interface ProfileEntry {
  id: string;
  label: string;
  defaultLevel: ReasoningLevel;
}

/** A profile id as the server accepts one (`ID_PATTERN` in settings.ts). */
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/**
 * The profiles a client lists, read from Divan's own settings.json with no server: `default` and `quick`, then the custom
 * ones. A missing or broken file gives just the two automatic profiles.
 */
export function profilesFromSettings(home: string): ProfileEntry[] {
  const records = readSettingsFile(home)?.profiles;
  const profiles: Record<
    string,
    { name?: unknown; base?: unknown; defaultLevel?: unknown } | null
  > =
    records && typeof records === 'object' && !Array.isArray(records)
      ? (records as Record<string, never>)
      : {};
  const entry = (id: string, label: string): ProfileEntry => {
    const record = profiles[id];
    const defaultLevel = isLevel(record?.defaultLevel)
      ? record.defaultLevel
      : record?.base === 'quick' || id === 'quick'
        ? 'low'
        : DEFAULT_LEVEL;
    return { id, label, defaultLevel };
  };
  const entries = [entry('default', 'default'), entry('quick', 'quick')];
  for (const [id, record] of Object.entries(profiles)) {
    if (!PROFILE_ID.test(id) || entries.some((known) => known.id === id)) continue;
    const name = typeof record?.name === 'string' ? record.name.trim() : '';
    entries.push(entry(id, name || id));
  }
  return entries;
}
