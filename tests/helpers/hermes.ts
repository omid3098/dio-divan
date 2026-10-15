import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { runProc } from '../../src/server/proc.ts';

export const hermesAssets = resolve(import.meta.dirname, '../../src/server/adapters/hermes');
/**
 * The suites that run the real Hermes Python code need a disposable Windows installation of Hermes that only a lab holds
 * (`HERMES_TEST_LAYOUT`, below). Without one (a clean CI machine, any other system) they are skipped, not failed.
 */
export const hermesLayoutReady =
  process.platform === 'win32' && Boolean(process.env.HERMES_TEST_LAYOUT);
export function hermesFixture() {
  const root = process.env.HERMES_TEST_LAYOUT;
  const lab = resolve(tmpdir(), 'divan-hermes-lab');
  if (!root || !resolve(root).startsWith(`${lab}\\`) || !existsSync(root))
    throw new Error(
      'HERMES_TEST_LAYOUT must name a disposable selected installation. Never use a live layout.',
    );
  const state = readdirSync(join(root, 'installs'))
    .map((id) => join(root, 'installs', id))
    .find((p) => existsSync(join(p, 'facts.json')));
  if (!state) throw new Error('Missing disposable facts');
  const facts = JSON.parse(readFileSync(join(state, 'facts.json'), 'utf8'));
  const venv = facts.packages.venv.environment as string;
  const cfg = readFileSync(join(venv, 'pyvenv.cfg'), 'utf8');
  const runtime = /^home = (.+)$/mu.exec(cfg)?.[1]?.trim();
  if (!runtime) throw new Error('Missing disposable runtime');
  const basePython = join(runtime, 'python.exe');
  const python = join(venv, 'Scripts', 'python.exe');
  const temp = mkdtempSync(join(tmpdir(), 'divan-hermes-test-'));
  const run = join(temp, 'runs', 'own');
  const control = join(temp, 'control');
  const managed = join(temp, 'managed-absent');
  const copied = join(run, 'home', 'read-material');
  for (const name of [
    'home',
    'profile',
    'scratch',
    'temp',
    'appdata',
    'localappdata',
    'xdg-config',
    'xdg-cache',
    'xdg-data',
    'xdg-state',
  ])
    mkdirSync(join(run, name), { recursive: true });
  mkdirSync(control);
  mkdirSync(join(temp, 'runs/sibling'));
  writeFileSync(join(temp, 'runs/sibling/secret.txt'), 'SIBLING BYTES');
  mkdirSync(copied);
  writeFileSync(join(control, 'secret.txt'), 'PROTECTED BYTES');
  writeFileSync(join(temp, 'canary.txt'), 'READ CANARY\nsecond line');
  writeFileSync(join(temp, 'hardlink.txt'), 'HARDLINK SECRET');
  linkSync(join(temp, 'hardlink.txt'), join(temp, 'hardlink-alias.txt'));
  writeFileSync(join(copied, 'own.txt'), 'COPIED TEXT');
  const win = process.env.SystemRoot ?? 'C:\\Windows';
  const { root: drive } = parse(join(run, 'profile'));
  const env: Record<string, string> = {
    SystemRoot: win,
    WINDIR: win,
    ComSpec: join(win, 'System32/cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: join(win, 'System32'),
    HOME: join(run, 'profile'),
    USERPROFILE: join(run, 'profile'),
    HOMEDRIVE: drive.slice(0, 2),
    HOMEPATH: join(run, 'profile').slice(2),
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
    LAB_KEY: 'synthetic-fixture-key',
  };
  const config = {
    model: {
      default: 'fixture-model',
      provider: 'custom:fixture',
      base_url: 'http://127.0.0.1:1/v1',
    },
    providers: {
      fixture: {
        base_url: 'http://127.0.0.1:1/v1',
        key_env: 'LAB_KEY',
        api_mode: 'chat_completions',
        models: ['fixture-model'],
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
    platform_toolsets: { cli: ['file', 'skills'] },
    memory: { memory_enabled: false, user_profile_enabled: false },
    session: { auto_title: false },
    plugins: { enabled: [] },
    hooks: { outbound: [] },
    mcp_servers: {},
    fallback_model: null,
  };
  const policy = {
    root,
    source: join(venv, '..', 'workspace'),
    state,
    python,
    basePython,
    home: join(control, 'discovery-home'),
    config,
    managed,
    scratch: join(run, 'scratch'),
    blocked: [join(temp, 'runs'), control],
    copied,
    tools: true,
    memory: false,
    web: false,
    services: {},
  };
  const policyFile = join(control, 'policy.json');
  function save() {
    writeFileSync(policyFile, JSON.stringify(policy));
    writeFileSync(join(run, 'home', 'config.yaml'), JSON.stringify(config));
    writeFileSync(join(run, 'home', '.env'), '');
  }
  save();
  mkdirSync(policy.home);
  writeFileSync(join(policy.home, 'config.yaml'), JSON.stringify(config));
  writeFileSync(join(policy.home, '.env'), 'LAB_KEY=synthetic-fixture-key\n');
  writeFileSync(join(policy.home, 'AGENTS.md'), 'SYNTHETIC INSTRUCTIONS');
  writeFileSync(join(policy.home, 'SOUL.md'), 'SYNTHETIC SOUL');
  mkdirSync(join(policy.home, 'memories'));
  writeFileSync(join(policy.home, 'memories/fact.md'), 'SYNTHETIC MEMORY');
  mkdirSync(join(policy.home, 'skills/sample'), { recursive: true });
  writeFileSync(join(policy.home, 'skills/sample/SKILL.md'), '!`echo NO > forbidden.txt`');
  const routeCases = join(control, 'route-cases');
  mkdirSync(routeCases);
  const entry = config.providers.fixture;
  const memoryEntry = {
    url: 'https://memory.invalid/mcp',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the placeholder text itself is what the fixture config holds
    headers: { Authorization: 'Bearer ${LAB_KEY}' },
    tools: { include: ['search', 'put_page', 'delete_page', 'approve_proposal'] },
  };
  const casesData = {
    modern: config,
    legacy: { model: config.model, custom_providers: [{ name: 'fixture', ...entry }] },
    transport: {
      model: config.model,
      providers: { fixture: { ...entry, api_mode: undefined, transport: 'responses' } },
    },
    disabled: { model: config.model, providers: { fixture: { ...entry, enabled: false } } },
    oauth: { model: config.model, providers: { fixture: { ...entry, oauth: true } } },
    moa: { model: config.model, providers: { fixture: { ...entry, models: ['moa:unsafe'] } } },
    'moa-config': {
      ...config,
      moa: {
        active_preset: 'unsafe',
        presets: { unsafe: { reference_models: ['a', 'b'], aggregator: 'c', enabled: true } },
      },
      fallback_model: 'moa:unsafe',
      fallback_models: ['moa:unsafe', 'virtual:unsafe'],
      providers: {
        fixture: {
          ...entry,
          models: {
            'fixture-model': {},
            'moa:unsafe': {},
            'MoA:unsafe': {},
            'virtual:unsafe': {},
            fanout: { reference_models: ['a', 'b'] },
            virtual: { virtual: true },
          },
        },
        fanout: { ...entry, reference_models: ['a', 'b'] },
        virtual: { ...entry, virtual: true },
        fallback: { ...entry, fallback_model: 'other' },
      },
    },
    command: { model: config.model, providers: { fixture: { ...entry, key_cmd: 'unsafe' } } },
    cacheOnly: { providers: {} },
    ambiguous: {
      model: config.model,
      providers: { fixture: entry },
      custom_providers: [{ name: 'fixture', ...entry }],
    },
    'memory-renamed': { ...config, mcp_servers: { memrepo: memoryEntry } },
    'memory-fallback': { ...config, mcp_servers: { memory: memoryEntry } },
    'memory-duplicate': { ...config, mcp_servers: { memory: memoryEntry, memrepo: memoryEntry } },
    'memory-mismatch': {
      ...config,
      mcp_servers: { memory: { ...memoryEntry, url: 'https://different.invalid/mcp' } },
    },
    'memory-literal': {
      ...config,
      mcp_servers: { memrepo: { ...memoryEntry, headers: { Authorization: 'Bearer literal' } } },
    },
    'memory-headers': {
      ...config,
      mcp_servers: {
        memrepo: { ...memoryEntry, headers: { ...memoryEntry.headers, Extra: 'unsupported' } },
      },
    },
    'memory-stdio': {
      ...config,
      mcp_servers: { memrepo: { ...memoryEntry, command: 'unsupported' } },
    },
    'non-chat': {
      ...config,
      providers: {
        fixture: {
          ...entry,
          models: {
            'fixture-model': { mode: 'image_generation' },
            'gpt-fixture': { chat: false },
            'typed-image': { type: 'image' },
            'embedding-task': { task: 'embeddings' },
            'no-chat-capability': { capabilities: { chat: false } },
            'embedding-endpoint': { supported_endpoints: ['/v1/embeddings'] },
            'empty-capabilities': { capabilities: {}, supported_endpoints: ['/v1/embeddings'] },
            'chat-list-embeddings': {
              capabilities: ['chat'],
              supported_endpoints: ['/v1/embeddings'],
            },
            'chat-endpoint': { capabilities: {}, supported_endpoints: ['/v1/chat/completions'] },
            'gpt-image-unmarked': {},
          },
        },
      },
    },
  };
  for (const [name, value] of Object.entries(casesData)) {
    const folder = join(routeCases, name);
    mkdirSync(folder);
    writeFileSync(join(folder, 'config.yaml'), JSON.stringify(value));
    writeFileSync(
      join(folder, 'provider_models_cache.json'),
      JSON.stringify({
        'custom:http://127.0.0.1:1/v1#synthetic': {
          models:
            name === 'moa-config'
              ? ['fixture-model', 'gpt-fixture', 'moa:unsafe', 'fanout']
              : ['gpt-fixture'],
        },
      }),
    );
  }
  const metadata = join(control, 'metadata-cases');
  mkdirSync(metadata);
  for (const name of [
    'schema',
    'stamp',
    'missing',
    'lock',
    'version',
    'runtime',
    'dependencies',
    'broken',
  ]) {
    const state = join(metadata, name);
    const environment = join(state, 'environments/selected/venv');
    mkdirSync(environment, { recursive: true });
    const changed = structuredClone(facts);
    changed.packages.venv.environment = name === 'missing' ? join(state, 'missing') : environment;
    if (name === 'schema') changed.schema = 99;
    if (name === 'stamp') changed.packages.venv.stamp = 'unsupported';
    if (name === 'lock') changed.packages.venv.resolved_lock = join(state, 'wrong.lock');
    writeFileSync(
      join(environment, 'pyvenv.cfg'),
      name === 'version'
        ? cfg.replace(/^version_info = .+$/mu, 'version_info = 0.0.0')
        : name === 'runtime'
          ? cfg.replace(/^home = .+$/mu, `home = ${control}`)
          : cfg,
    );
    writeFileSync(
      join(state, 'facts.json'),
      name === 'broken' ? '{broken' : JSON.stringify(changed),
    );
  }
  const cases = join(control, 'config-cases');
  mkdirSync(cases);
  for (const name of [
    'absent',
    'empty',
    'nonempty',
    'utf16',
    'directory',
    'dangling',
    'unreadable',
  ]) {
    const folder = join(cases, name);
    mkdirSync(folder);
    const file = join(folder, '.env');
    if (name === 'empty') writeFileSync(file, '');
    if (name === 'nonempty' || name === 'unreadable') writeFileSync(file, 'SYNTHETIC=key');
    if (name === 'utf16') writeFileSync(file, Buffer.from('SYNTHETIC=key', 'utf16le'));
    if (name === 'directory') mkdirSync(file);
    if (name === 'dangling') symlinkSync(join(cases, 'missing'), file, 'junction');
    if (name === 'unreadable')
      execFileSync(join(win, 'System32/icacls.exe'), [file, '/deny', '*S-1-1-0:(R)'], {
        windowsHide: true,
        stdio: 'pipe',
      });
  }
  const managedCases = join(control, 'managed-cases');
  mkdirSync(managedCases);
  for (const [name, text] of Object.entries({
    compatible: '{"plugins":{"enabled":[]}}',
    conflict: '{"plugins":{"enabled":["unsafe"]}}',
    moa: '{"moa":{"active_preset":"unsafe"}}',
    malformed: 'x: [',
    duplicate: 'plugins: {}\nplugins: {}\n',
    alias: 'x: &x {}\ny: *x',
    env: '{}',
  })) {
    mkdirSync(join(managedCases, name));
    writeFileSync(join(managedCases, name, 'config.yaml'), text);
    if (name === 'env') writeFileSync(join(managedCases, name, '.env'), 'UNSAFE=synthetic');
  }
  const aliases = join(run, 'aliases');
  mkdirSync(aliases);
  symlinkSync(control, join(aliases, 'protected'), 'junction');
  symlinkSync('\\\\127.0.0.1\\divan-missing-share', join(aliases, 'remote'), 'junction');
  mkdirSync(join(copied, 'swap'));
  writeFileSync(join(copied, 'swap/secret.txt'), 'SAFE HANDLE');
  symlinkSync(join(copied, 'swap'), join(aliases, 'swap'), 'junction');
  execFileSync(join(win, 'System32/icacls.exe'), [run, '/setintegritylevel', '(OI)(CI)L'], {
    windowsHide: true,
    stdio: 'pipe',
  });
  const stamp = execFileSync(
    basePython,
    [
      '-I',
      '-S',
      '-B',
      '-c',
      `import sys;sys.path.insert(0,sys.argv[1]);from launcher import *;h=ok(open_process(0x1000,False,int(sys.argv[2])));print(creation(h));close(h)`,
      hermesAssets,
      String(process.pid),
    ],
    { env, encoding: 'utf8', windowsHide: true },
  ).trim();
  return {
    temp,
    run,
    control,
    policy,
    policyFile,
    env,
    python,
    basePython,
    stamp,
    save,
    async execute(
      script: string,
      args: string[] = [],
      stdin = '',
      onStdout?: (chunk: string) => void,
    ) {
      return runProc({
        command: basePython,
        args: [
          '-I',
          '-S',
          '-B',
          join(hermesAssets, 'launcher.py'),
          join(run, 'scratch'),
          String(process.pid),
          stamp,
          python,
          '-I',
          '-B',
          script,
          policyFile,
          ...args,
        ],
        env,
        envMode: 'replace',
        cwd: dirname(policyFile),
        stdin,
        ...(onStdout ? { onStdout } : {}),
        // Leave the 150-second test deadline time to reap the owned process and remove its fixture.
        idleMs: 140_000,
        maxMs: 140_000,
      });
    },
    async executeCommand(
      command: string,
      args: string[],
      stdin = '',
      childEnv: NodeJS.ProcessEnv = env,
    ) {
      return runProc({
        command: basePython,
        args: [
          '-I',
          '-S',
          '-B',
          join(hermesAssets, 'launcher.py'),
          join(run, 'scratch'),
          String(process.pid),
          stamp,
          command,
          ...args,
        ],
        env: childEnv,
        envMode: 'replace',
        cwd: dirname(policyFile),
        stdin,
        idleMs: 60_000,
        maxMs: 120_000,
      });
    },
    close() {
      execFileSync(
        join(win, 'System32/icacls.exe'),
        [join(cases, 'unreadable/.env'), '/remove:d', '*S-1-1-0'],
        { windowsHide: true, stdio: 'pipe' },
      );
      rmSync(temp, { recursive: true, force: true });
    },
  };
}
