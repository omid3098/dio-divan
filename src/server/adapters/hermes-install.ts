// Read-only discovery. No Hermes import, live lease, model command, login or repair.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type Note, note } from '../../shared/messages.ts';
import { canonical as canonicalPath } from '../canonical.ts';
import { withoutT3 } from '../launch.ts';
import { memoryUrl } from '../memory-access.ts';
import { ownerOnly } from '../secure.ts';
import { defaultHome } from '../store.ts';
import { asRecord } from './util.ts';

export const HERMES_ASSETS = fileURLToPath(new URL('./hermes/', import.meta.url));
const SUPPORTED_REVISION = (
  JSON.parse(readFileSync(join(HERMES_ASSETS, 'supported.json'), 'utf8')) as {
    source_commit: string;
  }
).source_commit.slice(0, 12);
export interface HermesLayout {
  root: string;
  source: string;
  state: string;
  home: string;
  python: string;
  basePython: string;
  managed: string;
  parentCreated: string;
  configInput?: { identity: number[]; hash: string };
  validation?: Record<string, unknown>;
  bytecode?: string;
  bytecodeKey?: string;
  bytecodeReceipt?: string;
}
export interface HermesRoute {
  id: string;
  provider: string;
  endpoint: string;
  protocol: 'chat_completions';
  model: string;
  keyEnv: string;
  default: boolean;
}
export interface HermesDiscovery {
  installed: boolean;
  layout?: HermesLayout;
  routes: HermesRoute[];
  memory: { url: string; headerEnv: string } | null;
  memoryProblem?: Note;
  moaExcluded?: boolean;
  problem: Note | null;
}

export const hermesHome = () =>
  resolve(
    process.env.HERMES_HOME ??
      join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'hermes'),
  );
export const hermesRoots = () => [
  hermesHome(),
  join(homedir(), '.hermes'),
  ...(process.env.HERMES_PROFILE_HOME ? [resolve(process.env.HERMES_PROFILE_HOME)] : []),
];
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

export function hermesKey(
  name: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(name) ||
    /^(?:PATH$|COMSPEC$|SYSTEMROOT$|WINDIR$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|TEMP$|TMP$|TMPDIR$|XDG_|HERMES_|TERMINAL_|PYTHON|NODE_|BASH_ENV$|ENV$|.*PROXY|T3_ACP_|ELECTRON_RUN_AS_NODE$|NPM_CONFIG)/iu.test(
      name,
    )
  )
    return null;
  const values = Object.entries(env).filter(([key]) => key.toUpperCase() === name.toUpperCase());
  if (values.length > 1) return null;
  const literal = (value: unknown) =>
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 4096 &&
    ![...value].some((char) => char.charCodeAt(0) <= 32 || '$`'.includes(char))
      ? value
      : null;
  if (values.length) return literal(values[0]?.[1]);
  try {
    const file = join(home, '.env');
    if (!statSync(file).isFile() || statSync(file).size > 1024 * 1024) return null;
    const text = readFileSync(file, 'utf8');
    if (text.includes('\0')) return null;
    const matches = text.split(/\r?\n/u).flatMap((line) => {
      const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u.exec(line);
      if (pair?.[1]?.toUpperCase() !== name.toUpperCase()) return [];
      const value = pair[2] ?? '';
      return [
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
          ? value.slice(1, -1)
          : value,
      ];
    });
    return matches.length === 1 ? literal(matches[0]) : null;
  } catch {
    return null;
  }
}

export function resolveHermesRoutes(
  raw: unknown,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): HermesRoute[] {
  if (!Array.isArray(raw)) return [];
  const result: HermesRoute[] = [];
  const ids = new Set<string>();
  for (const item of raw) {
    const route = asRecord(item);
    if (
      !route ||
      typeof route.provider !== 'string' ||
      typeof route.model !== 'string' ||
      typeof route.endpoint !== 'string' ||
      typeof route.keyEnv !== 'string' ||
      route.protocol !== 'chat_completions' ||
      !/^[A-Za-z0-9][A-Za-z0-9_./:-]{0,199}$/u.test(route.model) ||
      route.model.length > 96 ||
      !/^[A-Za-z0-9_-]{1,64}$/u.test(route.provider) ||
      route.enabled === false ||
      ['disabled', 'oauth', 'moa', 'virtual', 'key_cmd', 'key_command', 'fallback'].some(
        (key) => route[key],
      )
    )
      continue;
    try {
      const url = new URL(route.endpoint);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /(?:^|\/)divan\//u.test(route.model) ||
        /^(?:moa:|virtual:)/iu.test(route.model)
      )
        continue;
      if (
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        [String(47321), String(process.env.DIVAN_PORT ?? '')].includes(url.port)
      )
        continue;
      if (!hermesKey(route.keyEnv, home, env)) continue;
      const endpoint = url.href.replace(/\/$/u, '');
      const id = `hermes/${hash(JSON.stringify([route.provider, endpoint, route.protocol, route.model])).slice(0, 16)}/${route.model}`;
      if (ids.has(id)) return [];
      ids.add(id);
      result.push({
        id,
        provider: route.provider,
        endpoint,
        protocol: 'chat_completions',
        model: route.model,
        keyEnv: route.keyEnv,
        default: route.default === true,
      });
    } catch {
      /* Invalid endpoints never become model ids or diagnostics. */
    }
  }
  return result;
}

export function systemEnvironment(): Record<string, string> {
  // Worker environment keys are case-sensitive even on Windows.
  const root = Object.entries(process.env).find(([key]) => key.toUpperCase() === 'SYSTEMROOT')?.[1];
  if (
    !root ||
    !/^[A-Z]:[\\/]/iu.test(root) ||
    realpathSync.native(root).toLowerCase() !== resolve(root).toLowerCase()
  )
    throw new Error(note('hermes_guard').message);
  return {
    SystemRoot: root,
    WINDIR: root,
    ComSpec: join(root, 'System32/cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: join(root, 'System32'),
    TEMP: tmpdir(),
    TMP: tmpdir(),
  };
}

export function inspectHermesLayout(
  root: string,
  home: string,
  validation?: Record<string, unknown>,
): HermesLayout {
  root = realpathSync.native(root);
  const states = readdirSync(join(root, 'installs'))
    .map((key) => join(root, 'installs', key))
    .filter((path) => existsSync(join(path, 'facts.json')));
  if (states.length !== 1) throw new Error(note('hermes_install').message);
  const state = states[0] as string;
  for (const file of [
    'manifest.json',
    '.hermes-update-in-progress',
    'hermes-agent/.update-incomplete',
    'hermes-agent/.lazy-refresh-incomplete',
    'hermes-agent/.git/hermes-update-pull',
    ...['.repair-incomplete', 'publication.json', 'source-completion-pending'].map((file) =>
      join('installs', state.split(/[\\/]/u).at(-1) as string, file),
    ),
  ]) {
    if (existsSync(join(root, file))) throw new Error(note('hermes_changed').message);
  }
  const facts = JSON.parse(readFileSync(join(state, 'facts.json'), 'utf8'));
  const venv = realpathSync.native(facts.packages.venv.environment);
  const source = join(venv, '..', 'workspace');
  const runtime = /^home = (.+)$/mu
    .exec(readFileSync(join(venv, 'pyvenv.cfg'), 'utf8'))?.[1]
    ?.trim();
  if (!runtime) throw new Error(note('hermes_install').message);
  const basePython = join(runtime, 'python.exe');
  const supported = JSON.parse(readFileSync(join(HERMES_ASSETS, 'supported.json'), 'utf8'));
  for (const [file, expected] of Object.entries(supported.runtime)) {
    if (hash(readFileSync(join(runtime, file))) !== expected)
      throw new Error(note('hermes_changed').message);
  }
  const managed = resolve(process.env.HERMES_MANAGED_DIR?.trim() || '/etc/hermes');
  const layout: HermesLayout = {
    root,
    source,
    state,
    home: realpathSync.native(home),
    python: join(venv, 'Scripts/python.exe'),
    basePython,
    managed,
    parentCreated: '',
    ...(validation ? { validation } : {}),
  };
  const checked = JSON.parse(
    execFileSync(basePython, ['-I', '-S', '-B', join(HERMES_ASSETS, 'install.py')], {
      input: JSON.stringify(layout),
      env: withoutT3(systemEnvironment()),
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  if (checked.ok !== true || !/^\d+$/u.test(checked.parentCreated))
    throw new Error(note('hermes_guard').message);
  layout.parentCreated = checked.parentCreated;
  layout.validation = checked.validation;
  return layout;
}

const discoveries = new Map<string, HermesDiscovery>();
const checking = new Map<string, Promise<HermesDiscovery>>();

/** This Medium verifier never receives a pycache prefix; Python imports cannot consume the cache. */
export function verifyHermesBytecode(layout: HermesLayout): void {
  if (!layout.bytecode) return;
  try {
    execFileSync(
      layout.basePython,
      ['-I', '-S', '-B', join(HERMES_ASSETS, 'bytecode.py'), '--verify'],
      {
        input: JSON.stringify(layout),
        env: withoutT3(systemEnvironment()),
        windowsHide: true,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    throw new Error(note('hermes_guard').message);
  }
}
function unchanged(found: HermesDiscovery): boolean {
  const layout = found.layout;
  if (!layout?.validation || !layout.configInput) return false;
  try {
    const receipt = layout.validation as {
      manifest: string;
      files: Record<string, (string | number)[]>;
      directories: Record<string, (string | number)[]>;
    };
    if (
      receipt.manifest !== hash(readFileSync(join(HERMES_ASSETS, 'supported.json'))) ||
      layout.configInput.hash !== hash(readFileSync(join(layout.home, 'config.yaml')))
    )
      return false;
    const pending = [
      'manifest.json',
      '.hermes-update-in-progress',
      'hermes-agent/.update-incomplete',
      'hermes-agent/.lazy-refresh-incomplete',
      'hermes-agent/.git/hermes-update-pull',
    ].map((file) => join(layout.root, file));
    pending.push(
      ...['.repair-incomplete', 'publication.json', 'source-completion-pending'].map((file) =>
        join(layout.state, file),
      ),
    );
    if (
      pending.some((path) => {
        try {
          lstatSync(path);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          return false;
        }
      })
    )
      return false;
    for (const [directory, records] of [
      [true, receipt.directories],
      [false, receipt.files],
    ] as const) {
      for (const [path, stamp] of Object.entries(records)) {
        const info = lstatSync(path, { bigint: true });
        const ticks = (value: string | number | undefined) =>
          (BigInt(value ?? 0) - 116444736000000000n) * 100n;
        if (
          info.isSymbolicLink() ||
          info.isDirectory() !== directory ||
          (!directory && (!info.isFile() || info.nlink !== BigInt(stamp[3] ?? 0))) ||
          info.dev !== BigInt(stamp[0] ?? 0) ||
          info.ino !== ((BigInt(stamp[1] ?? 0) << 32n) | BigInt(stamp[2] ?? 0)) ||
          (!directory && info.size !== ((BigInt(stamp[4] ?? 0) << 32n) | BigInt(stamp[5] ?? 0))) ||
          (stamp.length > 3 &&
            (info.mtimeNs !== ticks(stamp[6]) || info.ctimeNs !== ticks(stamp[7])))
        )
          return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
const defaultRoot = () =>
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'hermes');
const canonical = (path: string) => canonicalPath(path).toLowerCase();
const discoveryKey = (root: string, home: string) =>
  JSON.stringify([
    canonical(root),
    canonical(home),
    process.env.HERMES_MANAGED_DIR ?? '',
    memoryUrl('claude'),
  ]);

/** Synchronous consumers only see completed discovery; they never start slow validation. */
export function cachedHermes(
  root = defaultRoot(),
  home = hermesHome(),
): HermesDiscovery | undefined {
  return discoveries.get(discoveryKey(root, home));
}

export function discoverHermes(
  root = defaultRoot(),
  home = hermesHome(),
): Promise<HermesDiscovery> {
  const key = discoveryKey(root, home);
  const active = checking.get(key);
  if (active) return active;
  const task = new Promise<HermesDiscovery>((done, fail) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        hermesInspection: true,
        root,
        home,
        validation: discoveries.get(key)?.layout?.validation,
        previous: discoveries.get(key),
        cacheHome: join(defaultHome(), 'hermes-bytecode'),
      },
    });
    worker.once('message', done);
    worker.once('error', fail);
    worker.once('exit', (code) => {
      if (code !== 0) fail(new Error(note('hermes_install').message));
    });
  })
    .then((found) => {
      discoveries.set(key, found);
      return found;
    })
    .finally(() => checking.delete(key));
  checking.set(key, task);
  return task;
}

/** Static inspection under Low. This does not import or start Hermes, or contact any service. */
export function inspectHermes(
  root: string,
  home: string,
  validation?: Record<string, unknown>,
  cacheHome?: string,
): HermesDiscovery {
  if (process.platform !== 'win32')
    return { installed: false, routes: [], memory: null, problem: note('hermes_platform') };
  if (!existsSync(home) || !statSync(home).isDirectory())
    return {
      installed: false,
      routes: [],
      memory: null,
      problem: note('hermes_home_missing', { path: home }),
    };
  const missing: HermesDiscovery = {
    installed: existsSync(join(root, 'hermes-agent')),
    routes: [],
    memory: null,
    problem: note('hermes_install'),
  };
  let temp: string | undefined;
  let stage: 'hermes_install' | 'hermes_policy' | 'hermes_route' = 'hermes_install';
  try {
    const layout = inspectHermesLayout(root, home, validation);
    temp = mkdtempSync(join(tmpdir(), 'divan-hermes-inspect-'));
    ownerOnly(temp, true);
    const run = join(temp, 'run');
    mkdirSync(run);
    execFileSync(
      join(systemEnvironment().SystemRoot as string, 'System32/icacls.exe'),
      [run, '/setintegritylevel', '(OI)(CI)L'],
      { windowsHide: true, stdio: 'pipe' },
    );
    const policy = join(temp, 'policy.json');
    // Other assistants supply the address; Hermes discovery cannot supply its own authority.
    const canonicalMemoryUrl = memoryUrl('claude');
    writeFileSync(policy, JSON.stringify({ ...layout, memoryUrl: canonicalMemoryUrl }));
    ownerOnly(policy, false);
    stage = 'hermes_policy';
    const output = execFileSync(
      layout.basePython,
      [
        '-I',
        '-S',
        '-B',
        join(HERMES_ASSETS, 'launcher.py'),
        run,
        String(process.pid),
        layout.parentCreated,
        layout.python,
        '-I',
        '-B',
        '-X',
        `pycache_prefix=${join(temp, 'bytecode')}`,
        join(HERMES_ASSETS, 'candidates.py'),
        policy,
      ],
      {
        cwd: temp,
        env: { ...systemEnvironment(), HOME: run, USERPROFILE: run, TEMP: run, TMP: run },
        windowsHide: true,
        encoding: 'utf8',
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
    const found = JSON.parse(output);
    if (found.configInput) layout.configInput = found.configInput;
    const files = asRecord(layout.validation?.files);
    if (files && Array.isArray(found.configStamp))
      files[realpathSync.native(join(layout.home, 'config.yaml'))] = found.configStamp;
    if (cacheHome) {
      const bytecodeKey = hash(
        JSON.stringify([
          layout.validation,
          layout.configInput,
          layout.managed,
          hash(readFileSync(join(HERMES_ASSETS, 'bytecode-modules.json'))),
        ]),
      );
      const bytecode = join(cacheHome, bytecodeKey);
      if (!existsSync(cacheHome)) {
        mkdirSync(cacheHome, { recursive: true });
        ownerOnly(cacheHome, true);
      }
      if (!existsSync(bytecode)) {
        mkdirSync(bytecode);
        ownerOnly(bytecode, true);
      }
      layout.bytecode = bytecode;
      layout.bytecodeKey = bytecodeKey;
      const prepared = JSON.parse(
        execFileSync(layout.basePython, ['-I', '-S', '-B', join(HERMES_ASSETS, 'bytecode.py')], {
          input: JSON.stringify(layout),
          env: withoutT3(systemEnvironment()),
          windowsHide: true,
          encoding: 'utf8',
          timeout: 120_000,
          maxBuffer: 1024 * 1024,
        }),
      );
      if (prepared.ok !== true || !/^[a-f0-9]{64}$/u.test(prepared.receiptHash))
        throw new Error(note('hermes_guard').message);
      layout.bytecodeReceipt = prepared.receiptHash;
    }
    stage = 'hermes_route';
    const routes = resolveHermesRoutes(found.routes, home);
    const own = asRecord(found.memory);
    let memory: HermesDiscovery['memory'] = null;
    if (
      own &&
      typeof own.url === 'string' &&
      URL.canParse(own.url) &&
      (!canonicalMemoryUrl || own.url === canonicalMemoryUrl) &&
      typeof own.headerEnv === 'string' &&
      hermesKey(own.headerEnv, home)
    ) {
      const url = new URL(own.url);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        memory = { url: url.href, headerEnv: own.headerEnv };
    }
    return {
      installed: true,
      layout,
      routes,
      memory,
      ...(!memory && (found.memoryRejected || own)
        ? { memoryProblem: note('hermes_memory_unavailable') }
        : {}),
      moaExcluded: found.moaExcluded === true,
      problem: routes.length ? null : note('hermes_route'),
    };
  } catch (error) {
    const code = (['hermes_changed', 'hermes_guard'] as const).find(
      (code) => error instanceof Error && error.message === note(code).message,
    );
    return {
      ...missing,
      problem:
        code === 'hermes_changed' || (stage === 'hermes_install' && missing.installed)
          ? note('hermes_unsupported', { revision: SUPPORTED_REVISION })
          : note(code ?? stage),
    };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

if (!isMainThread && workerData?.hermesInspection) {
  parentPort?.postMessage(
    workerData.previous && unchanged(workerData.previous)
      ? workerData.previous
      : inspectHermes(
          workerData.root,
          workerData.home,
          workerData.validation,
          workerData.cacheHome,
        ),
  );
}
