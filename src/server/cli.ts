// `divan` (the npm package `dio-divan`; the script is bin/dio-divan.mjs): starts the local server or reopens the running one.
//   divan [--port N]                start the server detached (it runs `divan serve`), print its port and sign-in address
//                                   and open that address in the default browser (not with DIVAN_NO_OPEN=1); if one already
//                                   runs, only open it. The port is fixed (settings.json "port", else the built-in default)
//                                   so that clients such as Pi always find the endpoint; --port 0 picks a free one, for tests
//   divan serve [--port N] [--open] the server in the foreground; --open also opens the URL in the default browser
//   divan start [--port N]          start the server detached and exit once it answers, for a person in a terminal; if one
//                                   already runs, report it
//   divan start --no-wait           start the server detached, print its process id and exit at once, without waiting for it
//                                   (what Pi and T3 Code run, and then wait for it themselves: the launcher is gone within
//                                   moments, so the server is in nobody's process tree, which a harness kills whole)
//   divan stop                      stop the server that is running, by its PID
//   divan acp                       the Agent Client Protocol bridge for T3 Code (bin/dio-divan.mjs, never loads this file)

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  BIN,
  configuredPort,
  processExists,
  readServerState,
  runningServer,
  type ServerState,
  serverEnv,
  stateFile,
} from './launch.ts';
import { AlreadyRunningError } from './lock.ts';
import { killTree } from './proc.ts';
import { PortBusyError, startServer, VERSION } from './server.ts';
import { defaultHome, writeFileAtomic } from './store.ts';

const START_WAIT_MS = 20_000;
/** A connect to a loopback port either answers at once or never will (see `probePort`). */
const PROBE_MS = 1000;
/**
 * The launcher gives the detached server the path of a file in a private temporary folder; a server that cannot start writes
 * its reason there (stderr is not kept), and the launcher prints it. Nothing is written once the server is up.
 */
const START_ERROR_ENV = 'DIVAN_START_ERROR';

/** What a TCP connect to a loopback port said: `busy` (it answered), `free` (refused) or `unknown` (anything else). */
export type PortState = 'busy' | 'free' | 'unknown';

/**
 * Looks at a port before the server is started, only to give a fast, clear message when it is taken. Only a refusal means
 * free: on some networks (WSL with mirrored networking) a closed loopback port hangs instead of refusing, so a time-out or any
 * other error says nothing, and the server's own bind decides.
 */
export function probePort(
  port: number,
  timeoutMs = PROBE_MS,
  connect: typeof createConnection = createConnection,
): Promise<PortState> {
  return new Promise((done) => {
    const probe = connect({ port, host: '127.0.0.1' });
    const settle = (state: PortState) => {
      probe.destroy();
      done(state);
    };
    probe.once('connect', () => settle('busy'));
    probe.once('error', (error: NodeJS.ErrnoException) =>
      settle(error.code === 'ECONNREFUSED' ? 'free' : 'unknown'),
    );
    probe.setTimeout(timeoutMs, () => settle('unknown'));
  });
}

/** What a server that could not start tells the launcher that waits for it (nothing when no one is waiting). */
function recordStartError(error: unknown): void {
  const file = process.env[START_ERROR_ENV];
  delete process.env[START_ERROR_ENV];
  if (!file) return;
  try {
    writeFileSync(file, error instanceof Error ? error.message : String(error), {
      flag: 'wx',
      mode: 0o600,
    });
  } catch {
    // the launcher falls back to its own sentence
  }
}

/**
 * `divan start`: the server as a detached process of its own, so that whoever ran this (and may be killed with its whole
 * process tree, as T3 Code does) does not take it down. With `wait` it returns once the server answers (a person in a
 * terminal); without it, as soon as the process exists, printing only its process id: the caller waits for the server itself
 * and has the launcher out of the way at once.
 */
export async function startDetached(
  home: string,
  port: number | undefined,
  wait: boolean,
  bare = false,
  probe: (port: number) => Promise<PortState> = probePort,
): Promise<void> {
  let existing = await runningServer(home);
  if (!existing && wait) {
    const wanted = port ?? configuredPort(home);
    const state = wanted === 0 ? 'free' : await probe(wanted);
    if (state !== 'busy') existing = await runningServer(home);
    if (state === 'busy') {
      // Another launcher may have bound the port just before writing its state.
      const deadline = Date.now() + 2000;
      do {
        existing = await runningServer(home);
        if (existing) break;
        await new Promise((done) => setTimeout(done, 100));
      } while (Date.now() < deadline);
      if (!existing) throw new PortBusyError(wanted, home);
    }
  }
  if (existing) {
    if (wait) reportRunning(existing, port);
    console.log(
      wait
        ? `Dio Divan is already running (pid ${existing.pid}).\n${bare ? `Port ${existing.port}\n` : ''}${existing.url}`
        : existing.pid,
    );
    return;
  }
  // A launcher that waits is told why the server could not start (the file is private and removed on every way out); one that
  // does not wait is gone by then.
  const errorFolder = wait ? mkdtempSync(join(tmpdir(), 'divan-start-')) : null;
  try {
    const errorFile = errorFolder ? join(errorFolder, 'error.txt') : null;
    // A neutral folder and an absolute home: the server must not keep the caller's folder (a T3 worktree) as its working
    // directory, which Windows then cannot delete or rename while Divan runs.
    const child = spawn(
      process.execPath,
      [BIN, 'serve', ...(port !== undefined ? ['--port', String(port)] : [])],
      {
        cwd: homedir(),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...serverEnv(),
          DIVAN_HOME: resolve(home),
          ...(errorFile ? { [START_ERROR_ENV]: errorFile } : {}),
        },
      },
    );
    let exit: string | null = null;
    child.on('error', (error) => {
      exit = error.message;
    });
    child.on('exit', (code, signal) => {
      // A server that finds another one running exits 0: that one is waited for below.
      if (code !== 0) exit = `exit code ${code ?? signal}`;
    });
    child.unref();
    if (!wait) {
      // the process id exists once the process has been spawned; a spawn that failed says so by an error
      await new Promise<void>((done) => {
        child.once('spawn', done);
        child.once('error', done);
      });
      if (child.pid === undefined || exit !== null)
        throw new Error(`Dio Divan could not be started (${exit ?? 'no process'}).`);
      console.log(child.pid);
      return;
    }
    const deadline = Date.now() + START_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 250));
      const live = await runningServer(home);
      if (live) {
        if (live.pid !== child.pid) reportRunning(live, port);
        console.log(
          `Dio Divan is running (pid ${live.pid}).\n${bare ? `Port ${live.port}\n` : ''}${live.url}`,
        );
        return;
      }
      if (exit !== null) {
        // the server's own reason when it left one (a busy port, a refused home, a path too long for the lock)
        throw new Error(
          readStartError(errorFile) ||
            `Dio Divan stopped while starting (${exit}). Run divan serve in a terminal to see why.`,
        );
      }
    }
    throw new Error(`Dio Divan did not start within ${START_WAIT_MS / 1000} seconds.`);
  } finally {
    if (errorFolder) rmSync(errorFolder, { recursive: true, force: true });
  }
}

/** The reason a server that could not start left for the launcher, or an empty string. */
function readStartError(file: string | null): string {
  try {
    return file ? readFileSync(file, 'utf8').trim() : '';
  } catch {
    return '';
  }
}

/**
 * Opens the address in the default browser. It never throws: a missing or failing opener is said plainly and the address,
 * which the caller has printed, is what the person uses (nothing worse than that: the server goes on).
 */
export async function openInBrowser(url: string): Promise<void> {
  if (process.env.DIVAN_NO_OPEN === '1') return;
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command as string, args as string[], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  const problem = await new Promise<string | null>((done) => {
    const timer = setTimeout(() => done(null), 2000);
    child.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      done(error.code === 'ENOENT' ? `no ${command} was found` : error.message);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? null : `${command} exited with code ${code}`);
    });
  });
  child.unref();
  if (problem)
    console.error(`Could not open a browser (${problem}). Open the address above yourself.`);
}

function reportRunning(state: ServerState, port?: number): void {
  if (state.version && state.version !== VERSION)
    console.error(
      `Divan ${state.version} is running but ${VERSION} is installed; run divan stop, then divan.`,
    );
  if (port !== undefined && port !== state.port)
    console.error(`Using the running Divan on port ${state.port}; --port ${port} is ignored.`);
}

const USAGE = `Usage: divan [--port N]             Start in the background and open the browser\n  divan serve [--port N] [--open]    Run in the foreground\n  divan start [--port N] [--no-wait] Start in the background; --no-wait prints its PID\n  divan stop                        Stop the running server\n  divan acp                         Connect an ACP client (such as T3 Code)\n  divan --help | --version           Show help or the installed version\nDIVAN_HOME: settings, sessions and keys (default ~/.dio-divan)\nDIVAN_NO_OPEN=1: do not open a browser\nDefault port: 47321; --port applies to this run only.`;

/** The `divan` command. A server that cannot start tells the launcher waiting for it why (`recordStartError`). */
export async function runCli(argv: string[]): Promise<void> {
  try {
    await run(argv);
  } catch (error) {
    recordStartError(error);
    throw error;
  }
}

async function run(argv: string[]): Promise<void> {
  if (argv.length === 1 && ['--help', '-h', '--version', '-v'].includes(argv[0] ?? '')) {
    console.log(argv[0] === '--help' || argv[0] === '-h' ? USAGE : VERSION);
    return;
  }
  const command = argv[0]?.startsWith('-') || argv.length === 0 ? '' : argv[0];
  if (!['', 'serve', 'start', 'stop'].includes(command ?? ''))
    throw new Error(`Unknown command: ${command}\n${USAGE}`);
  const options = command ? argv.slice(1) : argv;
  const seen = new Set<string>();
  for (let i = 0; i < options.length; i++) {
    const option = options[i] ?? '';
    if (seen.has(option)) throw new Error(USAGE);
    seen.add(option);
    if (option === '--port' && command !== 'stop') {
      const value = options[++i];
      if (!value) throw new Error(USAGE);
      if (!/^\d+$/u.test(value)) throw new Error(`--port needs a number from 0 to 65535\n${USAGE}`);
      if (Number(value) > 65535) throw new Error('--port needs a number from 0 to 65535');
    } else if (
      !(
        (option === '--open' && command === 'serve') ||
        (option === '--no-wait' && command === 'start')
      )
    ) {
      throw new Error(USAGE);
    }
  }
  process.on('uncaughtException', (error) => {
    console.error(error.message);
    process.exit(1);
  });
  // A promise nobody awaited that rejects is reported, never fatal: a round's failure must not take the server down.
  process.on('unhandledRejection', (reason) => {
    console.error(
      'unhandled rejection:',
      reason instanceof Error ? reason.message : String(reason),
    );
  });
  const home = defaultHome();
  if (existsSync(home) && !statSync(home).isDirectory())
    throw new Error('DIVAN_HOME must name a folder, not a file.');
  if (argv[0] === 'stop') {
    const state = await runningServer(home);
    if (!state) {
      console.log('Dio Divan is not running.');
      return;
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(state.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      const deadline = Date.now() + 12_000;
      while (processExists(state.pid) && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 50));
    }
    const stopped = await killTree(state.pid);
    const deadline = Date.now() + 1000;
    while (processExists(state.pid) && Date.now() < deadline)
      await new Promise((done) => setTimeout(done, 50));
    if (!stopped || processExists(state.pid))
      throw new Error(`Could not stop Dio Divan (pid ${state.pid}).`);
    if (readServerState(home)?.pid === state.pid) rmSync(stateFile(home), { force: true });
    console.log(`Stopped Dio Divan (pid ${state.pid}).`);
    return;
  }
  const open = argv.includes('--open');
  const portIndex = argv.indexOf('--port');
  const port = portIndex !== -1 ? Number(argv[portIndex + 1]) : undefined;
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535))
    throw new Error('--port needs a number from 0 to 65535');

  if (argv[0] === 'start') {
    await startDetached(home, port, !argv.includes('--no-wait'));
    return;
  }
  if (argv[0] !== 'serve') {
    await startDetached(home, port, true, true);
    const live = await runningServer(home);
    if (!live) throw new Error('Dio Divan stopped. Run divan serve to see why.');
    await openInBrowser(live.url);
    return;
  }
  const existing = await runningServer(home);
  if (existing) {
    reportRunning(existing, port);
    console.log(`Dio Divan is already running (pid ${existing.pid}).\n${existing.url}`);
    if (open) await openInBrowser(existing.url);
    return;
  }
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer({ ...(port !== undefined ? { port } : {}), home });
  } catch (error) {
    // A busy port is reported as it is: never another port picked silently.
    if (error instanceof PortBusyError) throw error;
    if (!(error instanceof AlreadyRunningError)) throw error;
    // Another instance holds the lock: it may still be starting. Reuse it once it answers.
    for (let i = 0; i < 40; i += 1) {
      const live = await runningServer(home);
      if (live) {
        reportRunning(live, port);
        console.log(`Dio Divan is already running (pid ${live.pid}).\n${live.url}`);
        if (open) await openInBrowser(live.url);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`${error.message}, but it does not answer. Stop it with: divan stop`);
  }
  await mkdir(home, { recursive: true });
  const state: ServerState = {
    pid: process.pid,
    port: server.port,
    token: server.token,
    url: server.url,
    startedAt: new Date().toISOString(),
    version: VERSION,
  };
  // The state file holds the token of the web API (which hands out the API key): a secret, owner-only like the key.
  await writeFileAtomic(stateFile(home), JSON.stringify(state, null, 2), true);
  // up: nothing to tell the launcher any more, and the harnesses this server starts must not inherit its path
  delete process.env[START_ERROR_ENV];
  console.log(
    `Dio Divan ${VERSION}${process.env.DIVAN_FAKE === '1' ? ' (fake harnesses)' : ''}\n${server.url}`,
  );
  if (open) await openInBrowser(server.url);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    try {
      if (existsSync(stateFile(home)) && readServerState(home)?.pid === process.pid)
        rmSync(stateFile(home), { force: true });
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
