import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { note } from '../../shared/messages.ts';
import { withoutT3 } from '../launch.ts';
import { ownerOnly } from '../secure.ts';
import { defaultHome } from '../store.ts';
import {
  HERMES_ASSETS,
  type HermesLayout,
  type HermesRoute,
  hermesKey,
  systemEnvironment,
  verifyHermesBytecode,
} from './hermes-install.ts';
import { hermesServices } from './hermes-services.ts';
import { hiddenFolders } from './paths.ts';
import type { RunSpec } from './types.ts';

export function hermesEnvironment(
  run: string,
  managed: string,
  secrets: Record<string, string>,
): Record<string, string> {
  const profile = join(run, 'profile');
  const env: Record<string, string> = {
    ...systemEnvironment(),
    HOME: profile,
    USERPROFILE: profile,
    HOMEDRIVE: profile.slice(0, 2),
    HOMEPATH: profile.slice(2),
    APPDATA: join(run, 'appdata'),
    LOCALAPPDATA: join(run, 'localappdata'),
    TEMP: join(run, 'temp'),
    TMP: join(run, 'temp'),
    TMPDIR: join(run, 'temp'),
    XDG_CONFIG_HOME: join(run, 'xdg-config'),
    XDG_CACHE_HOME: join(run, 'xdg-cache'),
    XDG_DATA_HOME: join(run, 'xdg-data'),
    XDG_STATE_HOME: join(run, 'xdg-state'),
    HERMES_HOME: join(run, 'home'),
    HERMES_MANAGED_DIR: managed,
    HERMES_DISABLE_LAZY_INSTALLS: '1',
    HERMES_NO_UPDATE_CHECK: '1',
    HERMES_NON_INTERACTIVE: '1',
    HERMES_ACCEPT_HOOKS: '0',
    TERMINAL_HOME_MODE: 'profile',
    TERMINAL_CWD: join(run, 'scratch'),
    HF_HUB_OFFLINE: '1',
    DISABLE_TELEMETRY: '1',
  };
  const names = new Set(Object.keys(env).map((name) => name.toUpperCase()));
  for (const [name, value] of Object.entries(secrets)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,99}$/u.test(name) ||
      names.has(name.toUpperCase()) ||
      value.includes('\0')
    )
      throw new Error(note('hermes_guard').message);
    names.add(name.toUpperCase());
    env[name] = value;
  }
  return withoutT3(env) as Record<string, string>;
}

export function removeHermesPair(
  run: string,
  control: string,
  identities: [number, number][],
): void {
  for (const [index, path] of [run, control].entries()) {
    const info = lstatSync(path);
    const expected = identities[index];
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      !expected ||
      info.dev !== expected[0] ||
      info.ino !== expected[1] ||
      realpathSync.native(path).toLowerCase() !== resolve(path).toLowerCase()
    )
      throw new Error(note('hermes_cleanup').message);
  }
  for (const path of [run, control]) rmSync(path, { recursive: true });
}

export function prepareHermes(
  layout: HermesLayout,
  route: HermesRoute,
  spec: RunSpec,
  memory: { url: string; headerEnv: string } | null = null,
) {
  if (process.platform !== 'win32') throw new Error(note('hermes_platform').message);
  verifyHermesBytecode(layout);
  const home = realpathSync.native(defaultHome());
  for (const parent of [join(home, 'runs'), join(home, 'hermes-control')]) {
    if (
      existsSync(parent) &&
      (lstatSync(parent).isSymbolicLink() ||
        realpathSync.native(parent).toLowerCase() !== resolve(parent).toLowerCase())
    )
      throw new Error(note('hermes_guard').message);
  }
  const run = join(home, 'runs', randomUUID());
  const control = join(home, 'hermes-control', randomUUID());
  for (const root of [layout.root, layout.home]) {
    if (
      [run, control].some((path) => {
        const from = relative(root, path);
        return !isAbsolute(from) && from !== '..' && !from.startsWith(`..${sep}`);
      })
    )
      throw new Error(note('hermes_guard').message);
  }
  for (const path of [run, control]) {
    mkdirSync(path, { recursive: true });
    ownerOnly(path, true);
  }
  const identities = [run, control].map((path) => {
    const info = lstatSync(path);
    return [info.dev, info.ino] as [number, number];
  });
  try {
    for (const name of [
      'home',
      'scratch',
      'profile',
      'temp',
      'appdata',
      'localappdata',
      'xdg-config',
      'xdg-cache',
      'xdg-data',
      'xdg-state',
    ])
      mkdirSync(join(run, name));
    const copied = join(run, 'home/read-material');
    mkdirSync(copied);
    let bytes = 0,
      entries = 0;
    function copy(source: string, target: string) {
      if (!existsSync(source)) return;
      const info = lstatSync(source);
      if (
        ++entries > 2000 ||
        info.isSymbolicLink() ||
        realpathSync.native(source).toLowerCase() !== resolve(source).toLowerCase()
      )
        throw new Error(note('hermes_policy').message);
      if (info.isDirectory()) {
        mkdirSync(target, { recursive: true });
        for (const name of readdirSync(source)) {
          // Hermes keeps hub caches, archives and locks in root-level dot entries, not skills.
          if (source === join(layout.home, 'skills') && name.startsWith('.')) continue;
          copy(join(source, name), join(target, name));
        }
      } else if (info.isFile() && info.nlink === 1 && info.size <= 4 * 1024 * 1024) {
        bytes += info.size;
        if (bytes > 16 * 1024 * 1024) throw new Error(note('hermes_policy').message);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
      } else throw new Error(note('hermes_policy').message);
    }
    for (const name of [
      'AGENTS.md',
      'SOUL.md',
      ...(spec.memory ? ['memories'] : []),
      ...(spec.tools ? ['skills'] : []),
    ])
      copy(join(layout.home, name), join(copied, name));
    const config = {
      model: {
        default: route.model,
        provider: `custom:${route.provider}`,
        base_url: route.endpoint,
      },
      providers: {
        [route.provider]: {
          base_url: route.endpoint,
          key_env: route.keyEnv,
          api_mode: route.protocol,
          models: [route.model],
        },
      },
      auth: { adopt_external_logins: false },
      nous: { guest: false },
      updates: { check: false },
      agent: { api_max_retries: 1, auto_recovery_cycles: 0 },
      compression: { enabled: false },
      auxiliary: {
        background_review: { enabled: false },
        title_generation: { enabled: false, model_upgrade_enabled: false },
      },
      streaming: { enabled: false },
      approvals: { mode: 'deny', single_query_mode: 'deny' },
      terminal: {
        backend: 'local',
        cwd: join(run, 'scratch'),
        shell_init_files: [],
        auto_source_bashrc: false,
      },
      platform_toolsets: { cli: spec.tools ? ['file', 'skills'] : [] },
      memory: { memory_enabled: false, user_profile_enabled: false },
      session: { auto_title: false },
      plugins: { enabled: [] },
      hooks: { outbound: [] },
      mcp_servers: {},
      fallback_model: null,
    };
    const policyFile = join(control, 'policy.json');
    const grants = hermesServices(layout, spec.tools, spec.memory ? memory : null);
    writeFileSync(
      policyFile,
      JSON.stringify({
        ...layout,
        config,
        scratch: join(run, 'scratch'),
        copied,
        blocked: [...hiddenFolders(), layout.root, layout.home],
        tools: spec.tools,
        memory: spec.memory,
        web: false,
        services: grants.services,
      }),
    );
    ownerOnly(policyFile, false);
    writeFileSync(join(run, 'home/config.yaml'), JSON.stringify(config));
    writeFileSync(join(run, 'home/.env'), '');
    execFileSync(
      join(systemEnvironment().SystemRoot as string, 'System32/icacls.exe'),
      [run, '/setintegritylevel', '(OI)(CI)L'],
      { windowsHide: true, stdio: 'pipe' },
    );
    const key = hermesKey(route.keyEnv, layout.home);
    if (!key) throw new Error(note('hermes_route').message);
    const env = hermesEnvironment(run, layout.managed, { [route.keyEnv]: key, ...grants.secrets });
    const instructions = ['AGENTS.md', 'SOUL.md']
      .filter((name) => existsSync(join(copied, name)))
      .map((name) => readFileSync(join(copied, name), 'utf8'))
      .join('\n\n');
    let memoryText = '';
    function memories(path: string) {
      if (!existsSync(path)) return;
      for (const name of readdirSync(path)) {
        const file = join(path, name);
        if (lstatSync(file).isDirectory()) memories(file);
        else if (/\.(?:md|txt)$/iu.test(name))
          memoryText += `\n${name}\n${readFileSync(file, 'utf8')}`;
      }
    }
    if (spec.memory) memories(join(copied, 'memories'));
    return {
      run,
      control,
      policyFile,
      env,
      instructions,
      memoryText:
        memoryText.length > 240000
          ? `${memoryText.slice(0, 240000)}\n[Copied memory text clipped.]`
          : memoryText,
      copied,
      cleanup: () => removeHermesPair(run, control, identities),
      args: [
        '-I',
        '-S',
        '-B',
        join(HERMES_ASSETS, 'launcher.py'),
        join(run, 'scratch'),
        String(process.pid),
        layout.parentCreated,
        layout.python,
        '-I',
        '-B',
        '-X',
        `pycache_prefix=${layout.bytecode ?? join(control, 'bytecode-empty')}`,
        join(HERMES_ASSETS, 'bootstrap.py'),
        policyFile,
        'chat',
        '--query-file',
        '-',
        '--format',
        'stream-json',
        '--source',
        'tool',
        '--provider',
        `custom:${route.provider}`,
        '-m',
        route.model,
        ...(spec.effort ? ['--reasoning', spec.effort] : []),
        '-t',
        spec.tools ? 'file,skills' : 'none',
      ],
    };
  } catch (error) {
    removeHermesPair(run, control, identities);
    throw error;
  }
}
