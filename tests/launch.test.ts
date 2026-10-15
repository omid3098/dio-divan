// Launching the one server: the environment a launched server gets (no T3 credential), the profiles and port a client reads
// from settings.json without a server, and `divan start`, the launcher that leaves the server in nobody's process tree.

import { type ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import { type createConnection, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInBrowser, probePort, startDetached } from '../src/server/cli.ts';
import {
  BIN,
  configuredPort,
  divanHome,
  ensureServer,
  processExists,
  profilesFromSettings,
  readApiKey,
  readServerState,
  runningServer,
  serverEnv,
  serverHealthy,
  withoutT3,
} from '../src/server/launch.ts';
import { killTree, runProc } from '../src/server/proc.ts';
import { defaultHome } from '../src/server/store.ts';
import { DEFAULT_PORT } from '../src/shared/defaults.ts';
import { VERSION } from '../src/shared/package-root.ts';

let home: string;
const saved = { fake: process.env.DIVAN_FAKE };
const started: string[] = [];
const stalled: Server[] = [];
const argumentChildren = new Set<ChildProcess>();
let cleaningArguments = false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-launch-'));
  process.env.DIVAN_FAKE = '1';
  cleaningArguments = false;
});
afterEach(async () => {
  cleaningArguments = true;
  await Promise.all(
    [...argumentChildren].map(async (child) => {
      const closed = new Promise<void>((done) => child.once('close', () => done()));
      if (child.pid) await killTree(child.pid);
      await closed;
    }),
  );
  // every server this test started is stopped by its pid
  for (const dir of started.splice(0)) {
    const state = readServerState(dir);
    if (state) await killTree(state.pid);
  }
  for (const server of stalled.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  if (saved.fake === undefined) delete process.env.DIVAN_FAKE;
  else process.env.DIVAN_FAKE = saved.fake;
  rmSync(home, { recursive: true, force: true });
});

const writeSettings = (settings: unknown) =>
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** The pid of a process that has just exited: a stale server.json names one like it. */
const exitedPid = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('exit', () => resolve(child.pid as number));
  });

describe('the environment of a launched server', () => {
  it('takes out T3 Code’s credential and ELECTRON_RUN_AS_NODE, whatever their case, and keeps the rest', () => {
    const env = serverEnv({
      PATH: '/bin',
      DIVAN_HOME: 'x',
      T3_ACP_MCP_AUTHORIZATION: 'Bearer secret',
      T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:1/',
      t3_acp_mcp_node: 'node',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      T3_OTHER: 'kept',
    });
    expect(env).toEqual({ PATH: '/bin', DIVAN_HOME: 'x', T3_OTHER: 'kept', DIVAN_NO_OPEN: '1' });
  });

  it('withoutT3 is the same without DIVAN_NO_OPEN, and leaves its argument alone', () => {
    const base = {
      PATH: '/bin',
      T3_ACP_MCP_AUTHORIZATION: 'Bearer secret',
      ELECTRON_RUN_AS_NODE: '1',
    };
    expect(withoutT3(base)).toEqual({ PATH: '/bin' });
    expect(base.T3_ACP_MCP_AUTHORIZATION).toBe('Bearer secret');
  });

  it('defaults to the process environment and does not change it', () => {
    process.env.T3_ACP_MCP_ENDPOINT = 'http://127.0.0.1:1/';
    try {
      expect(serverEnv().T3_ACP_MCP_ENDPOINT).toBeUndefined();
      expect(serverEnv().DIVAN_NO_OPEN).toBe('1');
      expect(process.env.T3_ACP_MCP_ENDPOINT).toBe('http://127.0.0.1:1/');
    } finally {
      delete process.env.T3_ACP_MCP_ENDPOINT;
    }
  });
});

describe('what a client reads from the home without a server', () => {
  it('the home is the one the server uses', () => {
    expect(divanHome()).toBe(defaultHome());
  });

  it('the port: settings.json when it is a real port, else the built-in one', () => {
    expect(configuredPort(home)).toBe(DEFAULT_PORT);
    writeSettings({ port: 51234 });
    expect(configuredPort(home)).toBe(51234);
    for (const port of [0, 70000, 1.5, '4000', null]) {
      writeSettings({ port });
      expect(configuredPort(home), String(port)).toBe(DEFAULT_PORT);
    }
    writeFileSync(join(home, 'settings.json'), 'not json');
    expect(configuredPort(home)).toBe(DEFAULT_PORT);
  });

  it('the API key: trimmed, and only if the server would accept it', () => {
    expect(readApiKey(home)).toBeNull();
    writeFileSync(join(home, 'api-key'), 'short\n');
    expect(readApiKey(home)).toBeNull();
    writeFileSync(join(home, 'api-key'), '  divan-0123456789012345678901234567\n');
    expect(readApiKey(home)).toBe('divan-0123456789012345678901234567');
  });

  it('the state file: numeric pid and port and a string token, else nothing', () => {
    expect(readServerState(home)).toBeNull();
    const file = join(home, 'server.json');
    for (const text of [
      'not json',
      'null',
      '{}',
      '{"pid":"1","port":2,"token":"t"}',
      '{"pid":1,"port":"2","token":"t"}',
      '{"pid":1,"port":2,"token":3}',
    ]) {
      writeFileSync(file, text);
      expect(readServerState(home), text).toBeNull();
    }
    writeFileSync(file, '{"pid":1,"port":2,"token":"t","url":"http://127.0.0.1:2/#token=t"}');
    expect(readServerState(home)).toMatchObject({ pid: 1, port: 2, token: 't' });
  });

  it('a server that does not answer is not healthy; runningServer removes its file once the process it names is gone', async () => {
    const port = await freePort();
    writeFileSync(
      join(home, 'server.json'),
      JSON.stringify({
        pid: await exitedPid(),
        port,
        token: 't',
        url: `http://127.0.0.1:${port}/`,
      }),
    );
    const state = readServerState(home);
    expect(state).not.toBeNull();
    expect(await serverHealthy(state as never, 500)).toBe(false);
    expect(await runningServer(home)).toBeNull();
    expect(readServerState(home)).toBeNull();
  });

  it('a failed health check never removes the file of a process that is still alive', async () => {
    const port = await freePort();
    const file = JSON.stringify({
      pid: process.pid,
      port,
      token: 't',
      url: `http://127.0.0.1:${port}/`,
    });
    writeFileSync(join(home, 'server.json'), file);
    expect(processExists(process.pid)).toBe(true);
    expect(await runningServer(home)).toBeNull();
    expect(readFileSync(join(home, 'server.json'), 'utf8')).toBe(file);
  });

  it('a slow check does not remove a file that was rewritten meanwhile by a server that came up', async () => {
    // a program that takes the connection and never answers: the check runs into its time limit (2.5 s)
    const silent = httpServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    stalled.push(silent);
    const { port } = silent.address() as { port: number };
    const entry = (pid: number, token: string) =>
      JSON.stringify({ pid, port, token, url: `http://127.0.0.1:${port}/` });
    writeFileSync(join(home, 'server.json'), entry(await exitedPid(), 'old'));
    const checking = runningServer(home);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const fresh = entry(process.pid, 'new');
    writeFileSync(join(home, 'server.json'), fresh);
    expect(await checking).toBeNull();
    expect(readFileSync(join(home, 'server.json'), 'utf8')).toBe(fresh);
  }, 30_000);

  it('the health check must be answered by the recorded process: any other 2xx is not a Divan', async () => {
    let answer = '{"ok":true,"pid":1}';
    const stand = httpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(answer);
    });
    await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', resolve));
    stalled.push(stand);
    const { port } = stand.address() as { port: number };
    const state = { pid: 4242, port, token: 't', url: `http://127.0.0.1:${port}/` };
    for (const body of [
      '{"ok":true,"pid":1}',
      '{"ok":true}',
      '{"pid":4242}',
      '{"ok":false,"pid":4242}',
      '<html>hi</html>',
      'null',
      '4242',
    ]) {
      answer = body;
      expect(await serverHealthy(state), body).toBe(false);
    }
    answer = '{"ok":true,"version":"x","pid":4242}';
    expect(await serverHealthy(state)).toBe(true);
    // and so a stale file that another program answers for is neither used nor acted on
    answer = '<html>a dev server</html>';
    writeFileSync(join(home, 'server.json'), JSON.stringify(state));
    expect(await runningServer(home)).toBeNull();
  });
});

describe('the profiles a client lists', () => {
  const auto = [
    { id: 'default', label: 'default', defaultLevel: 'medium' },
    { id: 'quick', label: 'quick', defaultLevel: 'low' },
  ];

  it('a missing or broken settings file gives default and quick', () => {
    expect(profilesFromSettings(home)).toEqual(auto);
    for (const text of ['not json', '[]', 'null', '{"profiles":[]}', '{"profiles":"x"}']) {
      writeFileSync(join(home, 'settings.json'), text);
      expect(profilesFromSettings(home), text).toEqual(auto);
    }
  });

  it('custom profiles follow, labelled by their name or else their id; invalid ids and duplicates are left out', () => {
    writeSettings({
      profiles: {
        default: { name: 'Renamed', base: 'default' },
        'fast-one': { name: '  Fast One ', base: 'default' },
        'plain-id': { base: 'default' },
        'blank-name': { name: '   ' },
        'Not A Slug': { name: 'bad' },
        '-leading': { name: 'bad' },
        [`a${'b'.repeat(32)}`]: { name: 'too long' },
        'not-a-record': null,
      },
    });
    expect(profilesFromSettings(home)).toEqual([
      ...auto,
      { id: 'fast-one', label: 'Fast One', defaultLevel: 'medium' },
      { id: 'plain-id', label: 'plain-id', defaultLevel: 'medium' },
      { id: 'blank-name', label: 'blank-name', defaultLevel: 'medium' },
      { id: 'not-a-record', label: 'not-a-record', defaultLevel: 'medium' },
    ]);
  });

  it('the default level: the record’s own when it is a level, else low for quick and what is based on quick, else medium', () => {
    writeSettings({
      profiles: {
        default: { defaultLevel: 'high' },
        quick: { defaultLevel: 'bogus' },
        'on-quick': { base: 'quick' },
        'on-quick-high': { base: 'quick', defaultLevel: 'max' },
        'on-default': { base: 'default', defaultLevel: 'low' },
        odd: { defaultLevel: 3 },
      },
    });
    expect(
      Object.fromEntries(profilesFromSettings(home).map((p) => [p.id, p.defaultLevel])),
    ).toEqual({
      default: 'high',
      quick: 'low',
      'on-quick': 'low',
      'on-quick-high': 'max',
      'on-default': 'low',
      odd: 'medium',
    });
  });
});

/** Runs `divan <args>` with a Divan home of this test (or the `env` given); resolves with the exit code and what it printed. */
function cli(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...serverEnv(), DIVAN_HOME: home, ...options.env },
      ...(options.cwd ? { cwd: options.cwd } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      out += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

const waitFor = async <T>(
  what: string,
  probe: () => Promise<T | null | false>,
  ms = 20_000,
): Promise<T> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

describe('divan start', () => {
  it('port 0 starts on an assigned free port without probing the invalid TCP destination 0', async () => {
    started.push(home);
    const result = await cli(['start', '--port', '0']);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain('--port 0 is ignored');
    const live = await runningServer(home);
    expect(live).not.toBeNull();
    if (live) {
      expect(live.port).not.toBe(0);
      expect(live.port).not.toBe(47321);
    }
  });
  it('a paused port probe lets another launcher’s server bind and reuses it', async () => {
    const port = await freePort();
    const source = join(import.meta.dirname, '..', 'src', 'server');
    const program = `
      import assert from 'node:assert/strict';
      import net from 'node:net';
      import {rmSync} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const {startServer} = await import(${JSON.stringify(pathToFileURL(join(source, 'server.ts')).href)});
      const {writeFileAtomic} = await import(${JSON.stringify(pathToFileURL(join(source, 'store.ts')).href)});
      const {stateFile} = await import(${JSON.stringify(pathToFileURL(join(source, 'launch.ts')).href)});
      const original = net.createConnection;
      let peer, paused = false;
      net.createConnection = (...args) => {
        const socket = original(...args);
        const emit = socket.emit;
        socket.emit = function(event, ...values) {
          if (!paused && event === 'error' && values[0].code === 'ECONNREFUSED') {
            paused = true;
            startServer({home:process.env.DIVAN_HOME,port:${port}}).then(async server => {
              peer = server;
              await writeFileAtomic(stateFile(process.env.DIVAN_HOME), JSON.stringify({pid:process.pid,port:server.port,token:server.token,url:server.url}), true);
              emit.call(this, event, ...values);
            }).catch(error => emit.call(this, 'error', error));
            return true;
          }
          return emit.call(this, event, ...values);
        };
        return socket;
      };
      syncBuiltinESMExports();
      const log = console.log;
      console.log = () => {};
      try {
        const {runCli} = await import(${JSON.stringify(pathToFileURL(join(source, 'cli.ts')).href)});
        await runCli(['start','--port',${JSON.stringify(String(port))}]);
        const {runningServer} = await import(${JSON.stringify(pathToFileURL(join(source, 'launch.ts')).href)});
        assert.ok(paused && peer, 'the TCP probe was paused before the peer bound');
        assert.equal((await runningServer(process.env.DIVAN_HOME)).pid, process.pid);
      } finally {
        console.log = log;
        net.createConnection = original;
        syncBuiltinESMExports();
        if (peer) await peer.close();
        rmSync(stateFile(process.env.DIVAN_HOME), {force:true});
      }
    `;
    started.push(home);
    const result = await runProc({
      command: process.execPath,
      args: ['--input-type=module', '-e', program],
      cwd: home,
      env: { ...serverEnv(), DIVAN_HOME: home },
      idleMs: 25_000,
      maxMs: 25_000,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(readServerState(home)).toBeNull();
  }, 30_000);
  it('stop waits for a foreground server and its separately grouped call to exit', async () => {
    const port = await freePort();
    const source = join(import.meta.dirname, '..', 'src', 'server');
    const program = `
      import { runCli } from ${JSON.stringify(pathToFileURL(join(source, 'cli.ts')).href)};
      import { runProc } from ${JSON.stringify(pathToFileURL(join(source, 'proc.ts')).href)};
      await runCli(['serve', '--port', ${JSON.stringify(String(port))}]);
      await runProc({command:process.execPath,args:['-e','console.log(process.pid);setInterval(()=>{},1000)'],cwd:process.cwd(),idleMs:60000,onStdout:chunk=>process.stdout.write('CHILD '+chunk)});
    `;
    let callPid = 0;
    const foreground = spawn(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...serverEnv(), DIVAN_HOME: home },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    foreground.stdout.on('data', (chunk: Buffer) => {
      const found = /CHILD (\d+)/u.exec(chunk.toString());
      if (found) callPid = Number(found[1]);
    });
    const exited = new Promise((done) => foreground.once('close', done));
    try {
      const state = await waitFor('foreground server', () => runningServer(home));
      expect(state.pid).toBe(foreground.pid);
      await waitFor('the separately grouped call', async () => callPid || null);
      const result = await cli(['stop']);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain('Stopped Dio Divan');
      await exited;
      expect(processExists(state.pid)).toBe(false);
      await waitFor('the call to exit', async () => !processExists(callPid), 2000);
      expect(readServerState(home)).toBeNull();
    } finally {
      if (foreground.pid && processExists(foreground.pid)) await killTree(foreground.pid);
      if (callPid && processExists(callPid)) await killTree(callPid);
    }
  }, 30_000);

  it('starts the server detached and exits; a second start reports it; the server outlives the launcher', async () => {
    const port = await freePort();
    started.push(home);
    const [first, racing] = await Promise.all([
      cli(['start', '--port', String(port)]),
      cli(['start', '--port', String(port)]),
    ]);
    expect(first.code, first.out).toBe(0);
    expect(racing.code, racing.out).toBe(0);
    const state = readServerState(home);
    expect(state?.port).toBe(port);
    const manifestVersion = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
    ).version;
    expect(VERSION).toBe(manifestVersion);
    expect(state?.version).toBe(manifestVersion);
    expect((await cli(['--version'])).out).toBe(manifestVersion);
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'x-divan-token': state?.token ?? '' },
    });
    expect(((await health.json()) as { version: string }).version).toBe(manifestVersion);
    expect(first.out).toMatch(
      new RegExp(`^Dio Divan is (?:already )?running \\(pid ${state?.pid}\\)\\.\\n`, 'u'),
    );
    expect(await serverHealthy(state as never)).toBe(true);
    // the launcher has exited and the server is not its child any more: it still answers
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await serverHealthy(state as never)).toBe(true);
    expect(() => process.kill(state?.pid as number, 0)).not.toThrow();

    const second = await cli(['start', '--port', String(port)]);
    expect(second.code, second.out).toBe(0);
    expect(second.out).toMatch(
      new RegExp(`^Dio Divan is already running \\(pid ${state?.pid}\\)\\.\\n`, 'u'),
    );
    expect(readServerState(home)?.pid).toBe(state?.pid);
    writeFileSync(join(home, 'server.json'), JSON.stringify({ ...state, version: '0.0.0' }));
    const other = await cli(['--port', String(await freePort())]);
    expect(other.out).toContain(
      `Divan 0.0.0 is running but ${VERSION} is installed; run divan stop, then divan`,
    );
    expect(other.out).toContain(`Using the running Divan on port ${port}`);
    expect(other.out).toContain('is ignored');
  }, 60_000);

  it('--no-wait prints the server’s process id and exits without waiting for it to answer', async () => {
    const port = await freePort();
    started.push(home);
    const first = await cli(['start', '--no-wait', '--port', String(port)]);
    expect(first.code, first.out).toBe(0);
    expect(first.out).toMatch(/^\d+$/u);
    const pid = Number(first.out);
    // the server it started is the one that writes server.json, with that very pid
    const state = await waitFor('the server', () => runningServer(home));
    expect(state.pid).toBe(pid);
    // with a server running it prints that server’s id, again alone
    const again = await cli(['start', '--no-wait', '--port', String(port)]);
    expect(again.code, again.out).toBe(0);
    expect(again.out).toBe(String(pid));
  }, 60_000);

  it('--no-wait keeps PID-only output without waiting for a failed start', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      const result = await cli(['start', '--no-wait', '--port', String(port)]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/^\d+$/u);
      await waitFor('the failed server to be gone', async () => !processExists(Number(result.out)));
      expect(readServerState(home)).toBeNull();
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 60_000);

  it('a port that is taken is a clear failure of the launcher, with its reason', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      const result = await cli(['start', '--port', String(port)]);
      expect(result.code).toBe(1);
      expect(result.out).toContain(`Port ${port} is already in use`);
      expect(result.out).toContain('for this run only');
      expect(result.out).toContain(join(home, 'settings.json'));
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 60_000);

  it('a bad port is refused before anything starts', async () => {
    const result = await cli(['start', '--port', '99999']);
    expect(result.code).toBe(1);
    expect(result.out).toBe('--port needs a number from 0 to 65535');
  }, 60_000);

  it('the server does not keep the folder it was started from, and a relative home still points at the same place', async () => {
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'divan-cwd-')));
    const project = join(parent, 'worktree');
    // os.homedir() reads these: the neutral folder is one of ours, so a mistake cannot reach the real profile
    const neutral = join(parent, 'deep', 'neutral');
    mkdirSync(project);
    mkdirSync(neutral, { recursive: true });
    const absolute = join(parent, 'rhome');
    started.push(absolute);
    try {
      // the home is named relative to the folder the launcher runs in; the server runs somewhere else
      const result = await cli(['start', '--port', String(await freePort())], {
        cwd: project,
        env: { DIVAN_HOME: '../rhome', USERPROFILE: neutral, HOME: neutral },
      });
      expect(result.code, result.out).toBe(0);
      const state = readServerState(absolute);
      expect(state, 'server.json in the home the relative name points to').not.toBeNull();
      expect(await serverHealthy(state as never)).toBe(true);
      // Windows cannot rename a folder that is some process's working directory: neither the launcher nor the server holds it
      renameSync(project, join(parent, 'worktree-moved'));
      expect(await serverHealthy(state as never)).toBe(true);
    } finally {
      for (const dir of started.splice(0)) {
        const state = readServerState(dir);
        if (state) await killTree(state.pid);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});

/** A stand-in for `net.createConnection`: its socket does what `act` says (nothing at all is a connect that hangs). */
const fakeConnect = (act: (socket: Socket) => void): typeof createConnection =>
  (() => {
    const socket = new EventEmitter() as Socket;
    socket.destroy = () => socket;
    socket.setTimeout = ((ms: number, onTimeout: () => void) => {
      setTimeout(onTimeout, ms);
      return socket;
    }) as Socket['setTimeout'];
    queueMicrotask(() => act(socket));
    return socket;
  }) as unknown as typeof createConnection;

describe('before the server starts', () => {
  it('a connect that answers is a busy port, a refusal a free one, and anything else (a time-out, another error) is unknown', async () => {
    const port = await freePort();
    expect(await probePort(port)).toBe('free');
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      expect(await probePort(port)).toBe('busy');
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
    // on some networks (WSL with mirrored networking) a closed loopback port hangs instead of refusing
    expect(
      await probePort(
        port,
        20,
        fakeConnect(() => undefined),
      ),
    ).toBe('unknown');
    const failing = (code: string) =>
      fakeConnect((socket) => socket.emit('error', Object.assign(new Error(code), { code })));
    expect(await probePort(port, 1000, failing('ETIMEDOUT'))).toBe('unknown');
    expect(await probePort(port, 1000, failing('ECONNREFUSED'))).toBe('free');
  });

  it('a probe that cannot tell does not stop the start: the server starts on a free port', async () => {
    const port = await freePort();
    started.push(home);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await startDetached(home, port, true, false, async () => 'unknown');
    } finally {
      log.mockRestore();
    }
    expect(readServerState(home)?.port).toBe(port);
  }, 60_000);

  it('a probe that cannot tell on a taken port ends with the same busy-port message, from the server’s own bind', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      const failed = await startDetached(home, port, true, false, async () => 'unknown').catch(
        (error: unknown) => error as Error,
      );
      expect(failed).toBeInstanceOf(Error);
      expect((failed as Error).message).toContain(`Port ${port} is already in use`);
      expect((failed as Error).message).toContain(join(home, 'settings.json'));
      expect((failed as Error).message).not.toContain('stopped while starting');
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 60_000);

  it('a server that cannot start tells the launcher why, and the launcher leaves nothing behind', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'divan-launch-tmp-'));
    const clean = mkdtempSync(join(tmpdir(), 'divan-launch-clean-'));
    // os.tmpdir() reads these: the launcher's private folder is made in ours, so it can be seen to be gone
    const tmp = { TMP: scratch, TEMP: scratch, TMPDIR: scratch };
    try {
      // a folder that is not a Divan home is refused before anything else
      const unrelated = join(home, 'unrelated');
      mkdirSync(unrelated);
      writeFileSync(join(unrelated, 'notes.txt'), 'not Divan');
      const refused = await cli(['start', '--port', String(await freePort())], {
        env: { DIVAN_HOME: unrelated, ...tmp },
      });
      expect(refused.code).toBe(1);
      expect(refused.out).toContain('must be an empty folder or an existing Divan home');
      expect(refused.out).not.toContain('stopped while starting');
      expect(readdirSync(scratch)).toEqual([]);
      // a home too long for the lock's socket path (not on Windows, whose lock is a named pipe)
      if (process.platform !== 'win32') {
        const long = join(home, 'long'.repeat(35));
        const tooLong = await cli(['start', '--port', String(await freePort())], {
          env: { DIVAN_HOME: long, ...tmp },
        });
        expect(tooLong.code).toBe(1);
        expect(tooLong.out).toContain(long);
        expect(tooLong.out).toContain('too long for the single-instance lock');
        expect(tooLong.out).toContain('Set DIVAN_HOME to a shorter folder path.');
        expect(readdirSync(scratch)).toEqual([]);
      }
      // a start that works leaves nothing either
      started.push(clean);
      const fine = await cli(['start', '--port', String(await freePort())], {
        env: { DIVAN_HOME: clean, ...tmp },
      });
      expect(fine.code, fine.out).toBe(0);
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      for (const dir of started.splice(0)) {
        const state = readServerState(dir);
        if (state) await killTree(state.pid);
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      rmSync(scratch, { recursive: true, force: true });
      rmSync(clean, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('the browser opener', () => {
  const opener =
    process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  /** Runs `openInBrowser` with PATH set to `path` and returns what it reported on stderr. */
  const reported = async (path: string): Promise<string[]> => {
    const saved = { path: process.env.PATH, noOpen: process.env.DIVAN_NO_OPEN };
    delete process.env.DIVAN_NO_OPEN;
    process.env.PATH = path;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await openInBrowser('http://127.0.0.1:1/#token=none');
      return errors.mock.calls.map((call) => String(call[0]));
    } finally {
      errors.mockRestore();
      if (saved.path === undefined) delete process.env.PATH;
      else process.env.PATH = saved.path;
      if (saved.noOpen === undefined) delete process.env.DIVAN_NO_OPEN;
      else process.env.DIVAN_NO_OPEN = saved.noOpen;
    }
  };

  it('says plainly that no opener was found, never a spawn error, and does not throw', async () => {
    const empty = join(home, 'empty-path');
    mkdirSync(empty);
    expect(await reported(empty)).toEqual([
      `Could not open a browser (no ${opener} was found). Open the address above yourself.`,
    ]);
  });

  it.skipIf(process.platform === 'win32')('says plainly that the opener failed', async () => {
    const bin = join(home, 'failing-opener');
    mkdirSync(bin);
    writeFileSync(join(bin, opener), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(await reported(bin)).toEqual([
      `Could not open a browser (${opener} exited with code 3). Open the address above yourself.`,
    ]);
  });
});

describe('ensureServer', () => {
  it('starts the server through the launcher, once for concurrent calls, and then reuses it', async () => {
    const port = await freePort();
    mkdirSync(home, { recursive: true });
    writeSettings({ version: 2, port, profiles: {} });
    started.push(home);
    const first = ensureServer(home);
    const second = ensureServer(home);
    expect(second).toBe(first);
    const ready = await first;
    expect(ready.state.port).toBe(port);
    expect(ready.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    expect(ready.apiKey).toBe(readFileSync(join(home, 'api-key'), 'utf8').trim());
    // the key is accepted by /v1, and a second call finds the same server
    const models = await fetch(`${ready.baseUrl}/models`, {
      headers: { authorization: `Bearer ${ready.apiKey}` },
    });
    expect(models.status).toBe(200);
    const again = await ensureServer(home);
    expect(again.state.pid).toBe(ready.state.pid);
  }, 60_000);

  it('a server that cannot start is reported as soon as its process is gone, not after the whole wait', async () => {
    const port = await freePort();
    writeSettings({ version: 2, port, profiles: {} });
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      const began = Date.now();
      await expect(ensureServer(home, { waitMs: 55_000 })).rejects.toThrow(
        /^Dio Divan stopped while starting\. Run divan serve in a terminal to see why\.$/u,
      );
      expect(Date.now() - began).toBeLessThan(40_000);
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  }, 60_000);

  it('a launcher that takes too long is stopped, with a time-out error', async () => {
    const port = await freePort();
    writeSettings({ version: 2, port, profiles: {} });
    started.push(home);
    await expect(ensureServer(home, { waitMs: 1 })).rejects.toThrow(
      /^Dio Divan did not start within 0 seconds/u,
    );
  }, 60_000);

  it('the launcher and the server do not keep the folder the caller runs in as their working directory', async () => {
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'divan-launch-proj-')));
    const port = await freePort();
    mkdirSync(home, { recursive: true });
    writeSettings({ version: 2, port, profiles: {} });
    started.push(home);
    const before = process.cwd();
    process.chdir(project);
    try {
      await ensureServer(home);
    } finally {
      process.chdir(before);
    }
    try {
      renameSync(project, `${project}-moved`);
    } finally {
      rmSync(`${project}-moved`, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 60_000);
});

it('validates CLI help, version and invalid arguments before touching server state', async () => {
  const untouched = join(home, 'untouched');
  for (const [args, ok, output] of [
    [['--help'], true, 'Usage: divan'],
    [['-h'], true, 'Usage: divan'],
    [['--version'], true, VERSION],
    [['-v'], true, VERSION],
    [['strt'], false, 'Usage: divan'],
    [['stop', '--help'], false, 'Usage: divan'],
    [['acp', '--help'], false, 'Usage: divan'],
    [['start', '--wat'], false, 'Usage: divan'],
    [['--open'], false, 'Usage: divan'],
    [['serve', '--port'], false, 'Usage: divan'],
    [['start', '--port', '1', '--port', '2'], false, 'Usage: divan'],
  ] as const) {
    if (cleaningArguments) return;
    const result = await new Promise<{ code: number | null; out: string; err: string }>(
      (done, fail) => {
        const child = spawn(process.execPath, [BIN, ...args], {
          cwd: home,
          env: { ...serverEnv(), DIVAN_HOME: untouched, DIVAN_FAKE: '1' },
          windowsHide: true,
        });
        argumentChildren.add(child);
        child.once('close', () => argumentChildren.delete(child));
        let out = '';
        let err = '';
        child.stdout.on('data', (part) => {
          out += part;
        });
        child.stderr.on('data', (part) => {
          err += part;
        });
        child.once('error', fail);
        child.once('close', (code) => done({ code, out, err }));
      },
    );
    expect(result.code === 0, args.join(' ')).toBe(ok);
    expect(ok ? result.out : result.err).toContain(output);
    expect(existsSync(untouched)).toBe(false);
  }
}, 30_000);

it('explains unknown commands, bad ports and a home that is a file', async () => {
  for (const command of ['bogus', 'version']) {
    const result = await cli([command]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(new RegExp(`^Unknown command: ${command}\\nUsage: divan`, 'u'));
  }
  const port = await cli(['serve', '--port', 'abc']);
  expect(port.code).toBe(1);
  expect(port.out).toMatch(/^--port needs a number from 0 to 65535\nUsage: divan/u);
  const file = join(home, 'home-file');
  writeFileSync(file, 'synthetic');
  const result = await cli(['serve', '--port', '0'], { env: { DIVAN_HOME: file } });
  expect(result.code).toBe(1);
  expect(result.out).toBe('DIVAN_HOME must name a folder, not a file.');
});
