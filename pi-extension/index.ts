// Pi extension for Dio Divan.
//   provider `divan`   the council as models: every Divan profile is a model (`divan/default`, `divan/quick`, …) that Pi
//            asks like any OpenAI-compatible model. Every model is a reasoning model: Pi's thinking level picks the council's
//            level (low, medium, high, max). Progress arrives as the model's thinking, the answer as its reply. The provider
//            sends Pi's working folder (`x-divan-cwd`), so the council's members can read the project.
//   /divan   starts Dio Divan if it is not running (through the launcher `divan start`, which starts the server detached
//            and exits), then shows its URL. It opens the browser only for the explicit command; DIVAN_NO_OPEN=1
//            turns that off (tests).
//
// Divan is started lazily. At Pi's startup the models are listed from Divan's own `settings.json` (its profiles) and
// Divan is NOT started; it is started by the first real use: the `/divan` command, or the first prompt to a divan model
// (`before_agent_start`, which Pi awaits before the agent loop makes its request; `before_provider_request` is the net).
//
// This extension never writes in Divan's home folder: the server alone makes the folder and the API key (owner-only, under
// its single-instance lock), so two Pi instances starting at once cannot race it. It reads the key after the server is up,
// and gives it to the provider then (a provider can be registered again, and takes effect at once); until then the provider
// holds a placeholder that no server accepts.
//
// Install: use the pi install command and path shown on Connect.
// Try once: pi -e "<the path Connect shows>/index.ts"

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface Ui {
  notify(message: string, level?: 'info' | 'warning' | 'error'): void;
}
interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** Pi's thinking level -> the `reasoning_effort` Pi sends (null: the level does not exist for this model). */
  thinkingLevelMap?: Record<string, string | null>;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}
interface Pi {
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string, ctx: { ui: Ui }) => Promise<void> },
  ): void;
  registerProvider(
    name: string,
    config: {
      name?: string;
      baseUrl: string;
      apiKey: string;
      api: 'openai-completions';
      headers?: Record<string, string>;
      models: ProviderModel[];
    },
  ): void;
  on(
    event: 'before_agent_start' | 'before_provider_request',
    handler: (event: unknown, ctx: { model?: { provider?: string } }) => Promise<undefined>,
  ): unknown;
}

interface State {
  pid: number;
  port: number;
  token: string;
  url: string;
}

/**
 * Copies of two things of Divan's own (`src/shared/defaults.ts`: DEFAULT_PORT, and `src/shared/levels.ts`:
 * PI_THINKING_LEVEL_MAP), so that this folder stands alone; a test of the repo asserts that they are the same.
 */
const DEFAULT_PORT = 47321;
const THINKING_LEVEL_MAP: Record<string, string | null> = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

const home = () => process.env.DIVAN_HOME ?? join(homedir(), '.dio-divan');
const stateFile = () => join(home(), 'server.json');

function readState(): State | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as State;
    return typeof state.port === 'number' && typeof state.token === 'string' ? state : null;
  } catch {
    return null;
  }
}

/** Whether the server answers AND is the process server.json names (its health answer carries its own pid). */
async function healthy(state: State): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`, {
      headers: { 'x-divan-token': state.token },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { ok?: unknown; pid?: unknown } | null;
    return body?.ok === true && body.pid === state.pid;
  } catch {
    return false;
  }
}

/** The port Divan listens on: `port` of its settings.json, else the built-in default. */
function settingsPort(settings: { port?: unknown } | null): number {
  const port = settings?.port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : DEFAULT_PORT;
}

/** Divan's settings.json (its profiles and port), or null when it has none yet. */
function readSettings(): {
  port?: unknown;
  profiles?: Record<string, { name?: unknown } | null>;
} | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(home(), 'settings.json'), 'utf8'));
    return value && typeof value === 'object' ? (value as ReturnType<typeof readSettings>) : null;
  } catch {
    return null;
  }
}

/** The models Pi lists: the automatic profiles `default` and `quick`, then the custom ones. Read from the file, no server. */
function modelsFromSettings(settings: ReturnType<typeof readSettings>): ProviderModel[] {
  const labels = new Map<string, string>([
    ['default', 'default'],
    ['quick', 'quick'],
  ]);
  for (const [id, record] of Object.entries(settings?.profiles ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(id) || labels.has(id)) continue;
    const name = typeof record?.name === 'string' && record.name.trim() ? record.name.trim() : id;
    labels.set(id, name);
  }
  return [...labels].map(([id, label]) => ({
    id,
    // «D1» reads as «Divan»; T3 Code drops a leading provider name («· default»).
    name: `D1 · ${label}`,
    // every profile is a reasoning model: Pi's thinking level is the council's level
    reasoning: true,
    thinkingLevelMap: THINKING_LEVEL_MAP,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  }));
}

/** Not a key: the provider holds it until Divan has been started and has made the key. No server accepts it. */
const PENDING_KEY = 'divan-key-not-made-yet-start-divan';

/**
 * The key `/v1` wants, from the file Divan keeps (`api-key` in its home folder), or null while Divan has not made it. Only
 * ever read here: Divan makes the key (and its folder) itself, owner-only, so nothing of the kind is done twice or without
 * the access list Divan gives it.
 */
function readKey(): string | null {
  try {
    const key = readFileSync(join(home(), 'api-key'), 'utf8').trim();
    return key.length >= 24 ? key : null;
  } catch {
    return null;
  }
}

let starting: Promise<State> | null = null;

/** The running server's state; starts one (detached, on `port`) when none answers. One start at a time. */
function ensureServer(port: number, waitMs = 20_000): Promise<State> {
  starting ??= start(port, waitMs).finally(() => {
    starting = null;
  });
  return starting;
}

async function start(port: number, waitMs: number): Promise<State> {
  const existing = readState();
  if (existing && (await healthy(existing))) return existing;

  const bin = fileURLToPath(new URL('../bin/dio-divan.mjs', import.meta.url));
  if (!existsSync(bin)) throw new Error(`Dio Divan was not found at ${bin}`);
  // The launcher (`divan start --no-wait`) starts the server detached and exits at once, so the server is not a
  // descendant of this process: a harness that stops Pi by killing its whole process tree (T3 Code does) does not take Divan
  // down with it, not even while it is starting. It runs in a neutral folder with an absolute home, so that neither keeps
  // Pi's folder (a T3 worktree) as its working directory, which Windows then cannot delete or rename while Divan runs.
  const child = spawn(process.execPath, [bin, 'start', '--no-wait', '--port', String(port)], {
    cwd: homedir(),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...serverEnv(), DIVAN_HOME: resolve(home()) },
  });
  child.on('error', () => undefined);
  child.unref();

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const state = readState();
    if (state && (await healthy(state))) return state;
  }
  throw new Error(`Dio Divan did not start within ${Math.round(waitMs / 1000)} seconds`);
}

/**
 * A copy of `serverEnv` in src/server/launch.ts (this folder stands alone): the environment without T3 Code's credential for
 * its own tools (`T3_ACP_*`) and `ELECTRON_RUN_AS_NODE`, so that neither reaches Divan or the harnesses it runs.
 */
function serverEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const name = key.toUpperCase();
    if (!name.startsWith('T3_ACP_') && name !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  }
  return { ...env, DIVAN_NO_OPEN: '1' };
}

function open(url: string): void {
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
  child.on('error', () => undefined);
  child.unref();
}

export default async function divan(pi: Pi): Promise<void> {
  const settings = readSettings();
  // A server that is already running says its own port; otherwise the one Divan will start on.
  const running = readState();
  const port = running && (await healthy(running)) ? running.port : settingsPort(settings);
  const models = modelsFromSettings(settings);
  /** The key the provider was last registered with (null: the placeholder); undefined until a registration has succeeded. */
  let registered: string | null | undefined;

  /** The council as models: listed without starting Divan, with the key as far as it is known. */
  const provide = (key: string | null) => {
    pi.registerProvider('divan', {
      name: 'Dio Divan',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: key ?? PENDING_KEY,
      api: 'openai-completions',
      // Pi's working folder and name: the members read the project there (read-only), and the session says who asked.
      headers: { 'x-divan-cwd': encodeURIComponent(process.cwd()), 'x-divan-client': 'pi' },
      models,
    });
    // remembered only once Pi has taken it: a registration that failed is tried again by the next use
    registered = key;
  };

  /** Divan is running (started now if it was not), and the provider holds its key, whatever it was before. */
  const ready = async (): Promise<State> => {
    const state = await ensureServer(port);
    const key = readKey();
    if (!key) {
      throw new Error(
        `Dio Divan is running but has not made its API key (${join(home(), 'api-key')}); stop it and start it again`,
      );
    }
    if (key !== registered) provide(key);
    return state;
  };

  pi.registerCommand('divan', {
    description: 'Start Dio Divan (the council of AI agents) and show its URL',
    handler: async (_args, ctx) => {
      try {
        const state = await ready();
        ctx.ui.notify(`Dio Divan: ${state.url}`, 'info');
        open(state.url);
      } catch (error) {
        ctx.ui.notify(
          `Dio Divan did not start: ${error instanceof Error ? error.message : String(error)}`,
          'error',
        );
      }
    },
  });

  // The first prompt to a divan model starts Divan, before the agent loop asks for the key: Pi awaits this event. The same
  // on the request itself, in case a request comes by another way (the key is then there for the next one).
  for (const event of ['before_agent_start', 'before_provider_request'] as const) {
    pi.on(event, async (_event, ctx) => {
      if (ctx.model?.provider === 'divan') await ready();
      return undefined;
    });
  }

  // If the provider cannot be registered Pi starts as it always did, without it (the next use of a divan model tries again).
  try {
    provide(readKey());
  } catch {
    // no provider this time
  }
}
