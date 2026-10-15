// The Pi extension: the divan models are listed from Divan's own settings.json without starting Divan; Divan starts on the
// first real use (the /divan command, or the first request to a divan model).

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
import { createServer, type Server } from 'node:http';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import divan from '../pi-extension/index.ts';
import { killTree } from '../src/server/proc.ts';
import { isOwnerOnly } from '../src/server/secure.ts';
import { DEFAULT_PORT } from '../src/shared/defaults.ts';
import { PI_THINKING_LEVEL_MAP } from '../src/shared/levels.ts';
import { writerFlow } from './fixtures/flows.ts';

interface Registered {
  name: string;
  config: {
    name?: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    headers?: Record<string, string>;
    models: {
      id: string;
      name: string;
      reasoning: boolean;
      thinkingLevelMap?: Record<string, string | null>;
    }[];
  };
}

type Notify = (message: string, level?: string) => void;
type Hook = (event: unknown, ctx: { model?: { provider?: string } }) => Promise<undefined>;

/** A stand-in for Pi's extension API that remembers what the extension registered. */
function fakePi(failRegistrations: number[] = []) {
  const providers: Registered[] = [];
  let calls = 0;
  const commands = new Map<
    string,
    (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>
  >();
  const hooks = new Map<string, Hook>();
  const pi = {
    registerProvider: (name: string, config: Registered['config']) => {
      calls += 1;
      // an injected failure: the call with this number (counting from 1) throws, and registers nothing
      if (failRegistrations.includes(calls))
        throw new Error(`injected failure of registration ${calls}`);
      providers.push({ name, config });
    },
    registerCommand: (
      name: string,
      options: { handler: (args: string, ctx: { ui: { notify: Notify } }) => Promise<void> },
    ) => {
      commands.set(name, options.handler);
    },
    on: (event: string, handler: Hook) => {
      hooks.set(event, handler);
    },
  };
  return { pi, providers, commands, hooks };
}

const saved = {
  home: process.env.DIVAN_HOME,
  noOpen: process.env.DIVAN_NO_OPEN,
  fake: process.env.DIVAN_FAKE,
};
let home: string;
const cleanup: (() => Promise<void> | void)[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-piext-'));
  process.env.DIVAN_HOME = home;
  process.env.DIVAN_NO_OPEN = '1';
  process.env.DIVAN_FAKE = '1';
});
afterEach(async () => {
  for (const undo of cleanup.splice(0)) await undo();
  for (const [key, value] of [
    ['DIVAN_HOME', saved.home],
    ['DIVAN_NO_OPEN', saved.noOpen],
    ['DIVAN_FAKE', saved.fake],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = netServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = netServer();
    probe.on('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });

const writeSettings = (settings: unknown) =>
  writeFileSync(join(home, 'settings.json'), JSON.stringify(settings));

describe('listing the models', () => {
  it('lists the profiles of settings.json as reasoning models, without starting Divan', async () => {
    const port = await freePort();
    writeSettings({
      version: 2,
      port,
      profiles: {
        default: { base: 'default', revision: 1, overrides: {} },
        'fast-one': {
          name: 'Fast One',
          base: 'default',
          revision: 1,
          overrides: {},
          flow: writerFlow(),
        },
        'plain-id': { base: 'quick', revision: 1, overrides: {} },
        'Not A Slug': { name: 'bad', base: 'default', revision: 1, overrides: {} },
      },
    });
    const { pi, providers } = fakePi();
    await divan(pi as never);
    expect(providers).toHaveLength(1);
    const { name, config } = providers[0] as Registered;
    expect(name).toBe('divan');
    expect(config.baseUrl).toBe(`http://127.0.0.1:${port}/v1`);
    expect(config.api).toBe('openai-completions');
    expect(config.models.map((model) => model.id)).toEqual([
      'default',
      'quick',
      'fast-one',
      'plain-id',
    ]);
    expect(config.models.map((model) => model.name)).toEqual([
      'D1 · default',
      'D1 · quick',
      'D1 · Fast One',
      'D1 · plain-id',
    ]);
    for (const model of config.models) {
      expect(model.reasoning).toBe(true);
      // Pi's thinking levels map to the levels of the council, exactly as the endpoint reads them
      expect(model.thinkingLevelMap).toEqual(PI_THINKING_LEVEL_MAP);
    }
    // Pi’s folder and name travel with every request
    expect(config.headers).toEqual({
      'x-divan-cwd': encodeURIComponent(process.cwd()),
      'x-divan-client': 'pi',
    });
    // Divan was not started: no state file, nothing on the port
    expect(existsSync(join(home, 'server.json'))).toBe(false);
    expect(await listening(port)).toBe(false);
  });

  it('with no settings.json the built-in port and the two automatic profiles', async () => {
    const { pi, providers } = fakePi();
    await divan(pi as never);
    const { config } = providers[0] as Registered;
    // the port is Divan’s own default (the extension keeps a copy of it so that it stands alone)
    expect(config.baseUrl).toBe(`http://127.0.0.1:${DEFAULT_PORT}/v1`);
    expect(config.models.map((model) => model.id)).toEqual(['default', 'quick']);
  });

  it('a port that is not a port, or a settings file that is not JSON, falls back to the default', async () => {
    for (const text of [
      '{"port": "47321x"}',
      '{"port": 0}',
      '{"port": 70000}',
      'not json',
      '[]',
      'null',
    ]) {
      writeFileSync(join(home, 'settings.json'), text);
      const { pi, providers } = fakePi();
      await divan(pi as never);
      expect((providers[0] as Registered).config.baseUrl, text).toBe(
        `http://127.0.0.1:${DEFAULT_PORT}/v1`,
      );
    }
  });

  it('the key is read from Divan’s api-key file; until Divan has made one the provider holds a placeholder, and nothing is written', async () => {
    // no key yet: a placeholder that no server accepts, and the extension writes nothing in Divan's home
    const first = fakePi();
    await divan(first.pi as never);
    const placeholder = (first.providers[0] as Registered).config.apiKey;
    expect(placeholder).toBeTruthy();
    expect(placeholder.startsWith('divan-')).toBe(true);
    expect(existsSync(join(home, 'api-key'))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    // a key Divan made is used as it is
    writeFileSync(join(home, 'api-key'), 'divan-0123456789012345678901234567\n');
    const second = fakePi();
    await divan(second.pi as never);
    expect((second.providers[0] as Registered).config.apiKey).toBe(
      'divan-0123456789012345678901234567',
    );
    // a file that is not a key (too short for Divan to accept) is not used, and not replaced here either
    writeFileSync(join(home, 'api-key'), 'short\n');
    const third = fakePi();
    await divan(third.pi as never);
    expect((third.providers[0] as Registered).config.apiKey).toBe(placeholder);
    expect(readFileSync(join(home, 'api-key'), 'utf8')).toBe('short\n');
  });

  it('a Divan home that does not exist is not created by the extension', async () => {
    const fresh = join(home, 'not-yet');
    process.env.DIVAN_HOME = fresh;
    const { pi, providers } = fakePi();
    await divan(pi as never);
    expect(providers).toHaveLength(1);
    expect(existsSync(fresh)).toBe(false);
  });
});

const STAND_IN_KEY = 'divan-key-of-the-stand-in-0123456789';

describe('starting Divan on first use', () => {
  /** A stand-in for a running Divan: answers /api/health, and is recorded in server.json as the real one is. */
  async function runningStandIn(
    withKey = true,
  ): Promise<{ port: number; requests: string[]; server: Server }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    writeFileSync(
      join(home, 'server.json'),
      JSON.stringify({
        pid: process.pid,
        port,
        token: 't'.repeat(64),
        url: `http://127.0.0.1:${port}/#token=${'t'.repeat(64)}`,
      }),
    );
    if (withKey) writeFileSync(join(home, 'api-key'), `${STAND_IN_KEY}\n`);
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return { port, requests, server };
  }

  const stopServer = async (dir: string) => {
    try {
      const state = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as { pid: number };
      await killTree(state.pid);
    } catch {
      // it never started
    }
  };
  const stateOf = (dir: string) =>
    JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8')) as {
      pid: number;
      port: number;
      token: string;
    };
  const lastKey = (providers: Registered[]) => providers.at(-1)?.config.apiKey as string;
  const authenticates = async (port: number, key: string) =>
    (
      await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { authorization: `Bearer ${key}` },
      })
    ).status;

  it('a Divan that is already running is used as it is: its port, no second one started', async () => {
    const running = await runningStandIn();
    const { pi, providers, commands, hooks } = fakePi();
    await divan(pi as never);
    expect((providers[0] as Registered).config.baseUrl).toBe(`http://127.0.0.1:${running.port}/v1`);
    // a prompt to a divan model waits for Divan and finds it healthy; a request to another provider is not touched at all
    for (const event of ['before_agent_start', 'before_provider_request']) {
      await hooks.get(event)?.({}, { model: { provider: 'divan' } });
      const before = running.requests.length;
      await hooks.get(event)?.({}, { model: { provider: 'anthropic' } });
      await hooks.get(event)?.({}, {});
      expect(running.requests.length, event).toBe(before);
    }
    expect(running.requests.every((url) => url === '/api/health')).toBe(true);
    // the command shows the address
    const notes: string[] = [];
    await commands.get('divan')?.('', { ui: { notify: (message) => notes.push(message) } });
    expect(notes).toEqual([
      expect.stringMatching(/^Dio Divan: http:\/\/127\.0\.0\.1:\d+\/#token=/u),
    ]);
  });

  it('the first prompt to a divan model starts Divan, which makes its home and its key owner-only; the provider then holds that key', async () => {
    // a home with only its settings in it (the extension lists the models from there): the server makes it owner-only and makes the key
    const fresh = join(home, 'fresh');
    process.env.DIVAN_HOME = fresh;
    const port = await freePort();
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'settings.json'), JSON.stringify({ version: 2, port, profiles: {} }));
    cleanup.push(() => stopServer(fresh));
    const { pi, providers, hooks } = fakePi();
    await divan(pi as never);
    const before = (providers[0] as Registered).config.apiKey;
    expect(await listening(port)).toBe(false);
    // another provider's prompt does not start it
    await hooks.get('before_agent_start')?.({}, { model: { provider: 'openai' } });
    expect(existsSync(join(fresh, 'server.json'))).toBe(false);
    expect(existsSync(join(fresh, 'api-key'))).toBe(false);

    await hooks.get('before_agent_start')?.({}, { model: { provider: 'divan' } });
    // it listens on the port the models were listed with, and the key is the one the server made
    expect(stateOf(fresh).port).toBe(port);
    const made = readFileSync(join(fresh, 'api-key'), 'utf8').trim();
    expect(made).toMatch(/^divan-[\w-]{43}$/u);
    expect(providers.length).toBeGreaterThan(1);
    expect(lastKey(providers)).toBe(made);
    expect(lastKey(providers)).not.toBe(before);
    expect(await authenticates(port, lastKey(providers))).toBe(200);
    expect(await authenticates(port, before)).toBe(401);
    // the home and the key have the server's owner-only access list, not what a bare create would give
    expect(isOwnerOnly(fresh)).toBe(true);
    expect(isOwnerOnly(join(fresh, 'api-key'))).toBe(true);
  }, 60_000);

  it('a health answer that is not from the recorded process is not Divan: the extension keeps to the port of the settings', async () => {
    // server.json names this process, but what answers on its port says another pid (or none): a program that only reuses the port
    const settingsPort = await freePort();
    writeSettings({ version: 2, port: settingsPort, profiles: {} });
    for (const body of ['{"ok":true}', '{"ok":true,"pid":1}', '<html>a dev server</html>']) {
      const foreign = createServer((_req, res) => {
        res.writeHead(200).end(body);
      });
      await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve));
      const { port } = foreign.address() as { port: number };
      writeFileSync(
        join(home, 'server.json'),
        JSON.stringify({
          pid: process.pid,
          port,
          token: 't'.repeat(64),
          url: `http://127.0.0.1:${port}/`,
        }),
      );
      const { pi, providers } = fakePi();
      await divan(pi as never);
      expect((providers[0] as Registered).config.baseUrl, body).toBe(
        `http://127.0.0.1:${settingsPort}/v1`,
      );
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it('Divan is started in a neutral folder: the folder Pi runs in is not held by it', async () => {
    const fresh = join(home, 'fresh');
    process.env.DIVAN_HOME = fresh;
    const port = await freePort();
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'settings.json'), JSON.stringify({ version: 2, port, profiles: {} }));
    cleanup.push(() => stopServer(fresh));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'divan-piext-proj-')));
    cleanup.push(() => rmSync(`${project}-moved`, { recursive: true, force: true }));
    cleanup.push(() => rmSync(project, { recursive: true, force: true }));
    const before = process.cwd();
    const { pi, hooks } = fakePi();
    process.chdir(project);
    try {
      await divan(pi as never);
      await hooks.get('before_agent_start')?.({}, { model: { provider: 'divan' } });
    } finally {
      process.chdir(before);
    }
    expect(stateOf(fresh).port).toBe(port);
    // Windows cannot rename a folder that is some process's working directory
    renameSync(project, `${project}-moved`);
  }, 60_000);

  it('two Pi instances starting at once end up with one server and one key, and both authenticate', async () => {
    const fresh = join(home, 'fresh');
    process.env.DIVAN_HOME = fresh;
    const port = await freePort();
    mkdirSync(fresh);
    writeFileSync(join(fresh, 'settings.json'), JSON.stringify({ version: 2, port, profiles: {} }));
    cleanup.push(() => stopServer(fresh));
    // two instances of the extension, as two Pi processes have: each with its own module state
    vi.resetModules();
    const first = (await import('../pi-extension/index.ts')).default;
    vi.resetModules();
    const second = (await import('../pi-extension/index.ts')).default;
    const a = fakePi();
    const b = fakePi();
    await first(a.pi as never);
    await second(b.pi as never);
    expect(await listening(port)).toBe(false);
    // both of them are prompted at the same moment
    await Promise.all([
      a.hooks.get('before_agent_start')?.({}, { model: { provider: 'divan' } }),
      b.hooks.get('before_agent_start')?.({}, { model: { provider: 'divan' } }),
    ]);
    const key = readFileSync(join(fresh, 'api-key'), 'utf8').trim();
    expect(lastKey(a.providers)).toBe(key);
    expect(lastKey(b.providers)).toBe(key);
    expect(await authenticates(port, lastKey(a.providers))).toBe(200);
    expect(await authenticates(port, lastKey(b.providers))).toBe(200);
    // one key file and nothing else of its kind, and one server answering on the port
    expect(readdirSync(fresh).filter((name) => name.startsWith('api-key'))).toEqual(['api-key']);
    expect(isOwnerOnly(join(fresh, 'api-key'))).toBe(true);
    expect(stateOf(fresh).port).toBe(port);
  }, 60_000);

  it('a registration that fails is tried again by the next use: the key is remembered only once Pi has taken it', async () => {
    // Divan runs and has made its key; the registration with that key (the 2nd call: the 1st was the placeholder at load) fails once
    await runningStandIn(false);
    const { pi, providers, hooks } = fakePi([2]);
    await divan(pi as never);
    expect(providers).toHaveLength(1);
    expect(providers[0]?.config.apiKey.startsWith('divan-')).toBe(true);
    expect(providers[0]?.config.apiKey).not.toBe(STAND_IN_KEY);
    writeFileSync(join(home, 'api-key'), `${STAND_IN_KEY}\n`);
    const hook = hooks.get('before_agent_start');
    const ctx = { model: { provider: 'divan' } };
    await expect(hook?.({}, ctx)).rejects.toThrow(/injected failure of registration 2/u);
    // nothing was registered, and nothing was remembered as registered
    expect(providers).toHaveLength(1);
    // the next use tries again and the key is in
    await hook?.({}, ctx);
    expect(providers).toHaveLength(2);
    expect(lastKey(providers)).toBe(STAND_IN_KEY);
    // and once it is in, a further use registers nothing more
    await hooks.get('before_provider_request')?.({}, ctx);
    await hook?.({}, ctx);
    expect(providers).toHaveLength(2);
  });

  it('a registration that failed when Pi started is tried again by the first use', async () => {
    await runningStandIn();
    const { pi, providers, hooks } = fakePi([1]);
    await divan(pi as never);
    expect(providers).toHaveLength(0);
    await hooks.get('before_agent_start')?.({}, { model: { provider: 'divan' } });
    expect(providers).toHaveLength(1);
    expect(lastKey(providers)).toBe(STAND_IN_KEY);
  });

  it('Divan up but no usable key is a clear error, for the hook and for the command; the key arriving later is used', async () => {
    await runningStandIn(false);
    const { pi, providers, commands, hooks } = fakePi();
    await divan(pi as never);
    const hook = hooks.get('before_agent_start');
    const ctx = { model: { provider: 'divan' } };
    await expect(hook?.({}, ctx)).rejects.toThrow(/has not made its API key/u);
    // a file that is not a key (too short for Divan to accept) is no key either
    writeFileSync(join(home, 'api-key'), 'short\n');
    await expect(hooks.get('before_provider_request')?.({}, ctx)).rejects.toThrow(
      /has not made its API key/u,
    );
    const notes: { message: string; level: string | undefined }[] = [];
    await commands.get('divan')?.('', {
      ui: { notify: (message, level) => notes.push({ message, level }) },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.level).toBe('error');
    expect(notes[0]?.message).toMatch(/has not made its API key/u);
    // the placeholder is all the provider holds meanwhile
    expect(providers).toHaveLength(1);
    writeFileSync(join(home, 'api-key'), `${STAND_IN_KEY}\n`);
    await hook?.({}, ctx);
    expect(lastKey(providers)).toBe(STAND_IN_KEY);
  });
});
