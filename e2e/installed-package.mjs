// Only an installed artifact, own homes/free ports and fake harnesses. Never prints a key or sign-in token.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { processExists } from '../src/server/launch.ts';
import { killTree, resolveCommand } from '../src/server/proc.ts';
import { fillT3Database, makeT3Database, THREAD_A } from '../tests/helpers/t3-fixture.ts';
import { installedHermes } from './installed-hermes.mjs';
import { checkNpmIsolation, npmEnvironment } from './npm-isolation.mjs';

const root = join(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'divan-firstrun-pack-'));
const install = join(temp, 'install');
const home = join(temp, 'home');
const neutral = join(temp, 'neutral');
for (const folder of [install, home, neutral]) mkdirSync(folder);
writeFileSync(
  join(install, 'package.json'),
  JSON.stringify({ name: 'divan-package-fixture', private: true }),
);
const pids = [];
const live = new Set();
const checks = [];
const env = {
  ...npmEnvironment(temp, install),
  DIVAN_FAKE: '1',
  DIVAN_FAKE_DELAY_MS: '5',
  DIVAN_NO_OPEN: '1',
  DIVAN_HOME: home,
  DIVAN_T3_DB: join(temp, 'missing.sqlite'),
  USERPROFILE: neutral,
  HOME: neutral,
};
const npm = resolveCommand('npm');
const pi = resolveCommand('pi');
assert.ok(npm, 'npm is installed');

function run(command, args, options = {}) {
  return new Promise((done, fail) => {
    if (command === npm.command) {
      const cwd = options.cwd ?? install;
      const childEnv = options.env ?? env;
      assert.ok(!Object.keys(childEnv).some((key) => /^NODE_/iu.test(key)));
      const within = (path) =>
        !relative(temp, path).startsWith('..') && !isAbsolute(relative(temp, path));
      assert.ok(within(cwd) && existsSync(join(cwd, 'package.json')));
      for (const key of ['cache', 'logs_dir', 'userconfig', 'globalconfig', 'prefix']) {
        assert.ok(within(childEnv[`npm_config_${key}`]), key);
      }
    }
    const child = spawn(command, args, {
      cwd: install,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    pids.push(child.pid);
    live.add(child);
    child.once('close', () => live.delete(child));
    let out = '';
    let err = '';
    child.stdout.on('data', (part) => {
      out += part;
    });
    child.stderr.on('data', (part) => {
      err += part;
    });
    child.on('error', fail);
    child.on('close', (code) =>
      code === 0
        ? done({ out, err })
        : fail(
            new Error(
              `Process ${child.pid} exited ${code}: ${err.replace(/#token=[a-f0-9]+/gu, '#token=[redacted]').slice(-1500)}`,
            ),
          ),
    );
  });
}
function rpc(file, args, rpcEnv = env) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd: install,
    env: rpcEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  pids.push(child.pid);
  live.add(child);
  child.once('close', () => live.delete(child));
  const pending = new Map();
  let text = '';
  let next = 0;
  child.stdout.on('data', (part) => {
    text += part;
    let cut = text.indexOf('\n');
    while (cut !== -1) {
      const line = text.slice(0, cut);
      text = text.slice(cut + 1);
      const value = JSON.parse(line);
      if (value.id !== undefined) {
        pending.get(value.id)?.(value);
        pending.delete(value.id);
      }
      cut = text.indexOf('\n');
    }
  });
  child.stderr.on('data', () => {});
  return {
    child,
    async request(method, params) {
      const id = ++next;
      const response = new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`RPC timeout: ${method}`)), 30000);
        pending.set(id, (value) => {
          clearTimeout(timer);
          done(value);
        });
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      return response;
    },
    async close() {
      child.stdin.end();
      await new Promise((done) => child.once('close', done));
    },
  };
}
const freePort = () =>
  new Promise((done) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => done(port));
    });
  });
const readState = () => JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
let bin;
let shim;
function divan(args) {
  if (process.platform !== 'win32') return run(shim, args);
  // Only fixture-owned paths and fixed options reach cmd; no question or user text.
  assert.ok([shim, ...args].every((value) => !/["&|<>^%!\r\n]/u.test(value)));
  return run(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    ['/d', '/s', '/c', `""${shim}" ${args.map((value) => `"${value}"`).join(' ')}"`],
    { windowsVerbatimArguments: true },
  );
}
let active;
let packedArtifact;
try {
  await checkNpmIsolation(temp, run);
  checks.push(
    'hostile npm workspace/Node environment: sentinel empty, no preload marker, private pack/install, parent files untouched',
  );
  if (process.argv.includes('--isolation-only')) {
    console.log('Hostile npm isolation passed.');
  } else {
    const tarballIndex = process.argv.indexOf('--tarball');
    const given = tarballIndex < 0 ? null : resolve(process.argv[tarballIndex + 1]);
    const packed = given
      ? null
      : await run(npm.command, [
          ...npm.prefix,
          'pack',
          root,
          '--prefix',
          install,
          '--json',
          '--ignore-scripts',
          '--pack-destination',
          temp,
        ]);
    const pack = given
      ? {
          name: 'dio-divan',
          filename: basename(given),
          size: statSync(given).size,
          integrity: `sha512-${createHash('sha512').update(readFileSync(given)).digest('base64')}`,
          files: (await run('tar', ['-tzf', given])).out
            .trim()
            .split(/\r?\n/u)
            .filter((path) => !path.endsWith('/'))
            .map((path) => ({ path: path.replace(/^package\//u, '') })),
        }
      : JSON.parse(packed.out)[0];
    if (given) copyFileSync(given, join(temp, pack.filename));
    assert.equal(pack.name, 'dio-divan');
    assert.ok(pack.files.every((file) => !/^(?:src|tests|e2e|\.evidence)\//u.test(file.path)));
    const artifactDir = given ? dirname(given) : join(root, '.evidence', 'npm-pack');
    mkdirSync(artifactDir, { recursive: true });
    if (!given) copyFileSync(join(temp, pack.filename), join(artifactDir, pack.filename));
    packedArtifact = {
      path: join(artifactDir, pack.filename),
      integrity: pack.integrity,
      files: pack.files.length,
      bytes: pack.size,
    };
    await run(npm.command, [
      ...npm.prefix,
      'install',
      '--local',
      '--prefix',
      install,
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temp, pack.filename),
    ]);
    const pkg = join(install, 'node_modules', 'dio-divan');
    bin = join(pkg, 'bin', 'dio-divan.mjs');
    assert.ok(existsSync(bin));
    shim = join(
      install,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'divan.cmd' : 'divan',
    );
    assert.ok(existsSync(shim), 'installed divan shim');
    assert.deepEqual(JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).bin, {
      divan: 'bin/dio-divan.mjs',
    });
    for (const file of pack.files.filter((file) => /\.(?:js|mjs|ts|md|html)$/u.test(file.path))) {
      assert.doesNotMatch(
        readFileSync(join(pkg, file.path), 'utf8'),
        /(?:[Rr]un dio-divan\b|\bdio-divan (?:serve|start|stop|--|memory-ro-token))/u,
        file.path,
      );
    }
    assert.ok(!existsSync(join(pkg, 'src')));
    assert.ok(!existsSync(join(install, 'node_modules', 'react')));
    assert.ok(existsSync(join(pkg, 'schemas', 'member.schema.json')));
    checks.push(
      'tarball installed outside checkout, production dependencies only, no install build',
    );
    for (const name of ['launcher.py', 'bootstrap.py', 'guard.py', 'readers.py', 'supported.json'])
      assert.ok(existsSync(join(pkg, 'dist/server/adapters/hermes', name)), name);
    checks.push(
      (await installedHermes(pkg))
        ? 'installed Hermes assets and emitted helper paths; copied selected runtime, empty catalog and one loopback fake-provider answer'
        : 'installed Hermes assets present (the run needs Windows and HERMES_TEST_LAYOUT, a disposable copy)',
    );

    const acp = rpc(bin, ['acp']);
    const init = await acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'fixture', version: '1' },
    });
    assert.equal(
      init.result.agentInfo.version,
      JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version,
    );
    assert.ok(
      (await acp.request('session/new', { cwd: neutral, mcpServers: [] })).result.sessionId,
    );
    assert.ok(!existsSync(join(home, 'server.json')));
    await acp.close();
    checks.push(
      'installed ACP initialize/session-new leaves server stopped, correct package version',
    );

    const port = await freePort();
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ version: 2, port, profiles: {} }));
    const first = await divan(['--port', String(port)]);
    active = readState();
    pids.push(active.pid);
    assert.ok(first.out.includes(`#token=${active.token}`));
    assert.ok(first.out.includes(`Port ${port}`));
    assert.equal(first.out.split(active.url).length - 1, 1);
    const reopened = await divan([]);
    assert.equal(readState().pid, active.pid);
    assert.ok(reopened.out.includes(`#token=${active.token}`));
    assert.equal(reopened.out.split(active.url).length - 1, 1);
    const origin = `http://127.0.0.1:${port}`;
    const html = await (await fetch(origin)).text();
    assert.match(html, /<div id="root">/u);
    const asset = /src="([^"]+\.js)"/u.exec(html)?.[1];
    assert.ok(asset);
    assert.equal((await fetch(new URL(asset, `${origin}/`))).status, 200);
    const meta = await (
      await fetch(`${origin}/api/meta`, { headers: { 'x-divan-token': active.token } })
    ).json();
    // The server names real paths; a temporary folder can have another name (macOS /var is /private/var).
    const same = (path) => realpathSync.native(path);
    assert.equal(same(meta.endpoint.piExtension), same(join(pkg, 'pi-extension')));
    assert.equal(same(meta.endpoint.acp.args.at(-2)), same(bin));
    const profile = meta.settings.profiles.find((item) => item.id === 'default');
    const started = await fetch(`${origin}/api/sessions`, {
      method: 'POST',
      headers: { 'x-divan-token': active.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        question: 'Package fixture only',
        profileId: 'default',
        revision: profile.revision,
        fingerprint: profile.levels.medium.fingerprint,
      }),
    });
    assert.equal(started.status, 201, 'schema-backed fake session');
    checks.push(
      'bare start/reopen, actual port/authenticated address, web JS, installed endpoint paths and schemas',
    );
    await divan(['stop']);
    active = null;

    const detached = await divan(['start', '--no-wait', '--port', String(port)]);
    assert.match(detached.out, /^\d+\r?\n$/u);
    const detachedPid = Number(detached.out.trim());
    pids.push(detachedPid);
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(home, 'server.json'))) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    active = readState();
    assert.equal(active.pid, detachedPid);
    await divan(['stop']);
    active = null;
    checks.push('installed divan shim: bare/reopen one address, start --no-wait PID-only, stop');

    const foreground = spawn(process.execPath, [bin, 'serve', '--port', String(port)], {
      cwd: install,
      env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    pids.push(foreground.pid);
    live.add(foreground);
    foreground.once('close', () => live.delete(foreground));
    foreground.stdout.on('data', () => {});
    foreground.stderr.on('data', () => {});
    for (let i = 0; i < 100; i++) {
      if (existsSync(join(home, 'server.json'))) break;
      await new Promise((done) => setTimeout(done, 100));
    }
    active = readState();
    assert.equal(active.pid, foreground.pid);
    await divan(['stop']);
    active = null;
    checks.push('serve remains foreground and stop removes its state');

    const db = join(temp, 't3-fixture.sqlite');
    const fixture = makeT3Database(db);
    fillT3Database(fixture);
    fixture.close();
    const helperModule = await import(
      pathToFileURL(join(pkg, 'dist', 'server', 't3-access.js')).href
    );
    assert.ok(helperModule.T3_SCRIPT.endsWith('t3-mcp.js'));
    const helper = rpc(helperModule.T3_SCRIPT, [], { ...env, DIVAN_T3_DB: db });
    assert.ok(
      (
        await helper.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'fixture', version: '1' },
        })
      ).result,
    );
    const read = await helper.request('tools/call', {
      name: 't3_thread_read',
      arguments: { threadId: THREAD_A },
    });
    assert.ok(JSON.stringify(read).includes('Is this tweet a good idea?'));
    await helper.close();
    checks.push('emitted T3 helper launches and reads fixture database');

    assert.ok(pi, 'Pi is installed for its loader proof');
    const piDir = join(temp, 'pi-profile');
    mkdirSync(piDir);
    // Offline catalogue fixture only: this provider is never selected for a prompt.
    writeFileSync(
      join(piDir, 'models.json'),
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: 'http://127.0.0.1:1/v1',
            api: 'openai-completions',
            apiKey: 'fixture-not-a-secret',
            models: [
              {
                id: 'gpt-fixture',
                name: 'Fixture',
                reasoning: true,
                input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      }),
    );
    const args = [
      ...pi.prefix,
      '--offline',
      '--no-extensions',
      '-e',
      join(pkg, 'pi-extension', 'index.ts'),
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--no-mcp',
      '--no-session',
    ];
    const piEnv = {
      ...env,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      PI_CODING_AGENT_DIR: piDir,
      PI_OFFLINE: '1',
    };
    const listed = await run(pi.command, [...args, '--list-models'], { env: piEnv });
    assert.match(listed.out, /divan\s+default/u);
    assert.ok(!existsSync(join(home, 'server.json')), 'listing is lazy');
    // Discovery matching the run policy cannot recursively list extension-provided Divan models.
    const without = await run(
      pi.command,
      [...pi.prefix, '--offline', '--no-extensions', '--list-models'],
      { env: piEnv },
    );
    assert.doesNotMatch(without.out, /^\s*divan\s+/mu);
    const { piModelRows } = await import(
      pathToFileURL(join(pkg, 'dist', 'server', 'adapters', 'pi.js')).href
    );
    assert.deepEqual(
      piModelRows(without.out, ['low', 'medium']).map((model) => model.id),
      ['fixture/gpt-fixture'],
    );
    checks.push(
      'actual Pi table output parses the offline fixture model, with recursive Divan entries absent',
    );
    await run(
      pi.command,
      [
        ...args,
        '--model',
        'divan/default',
        '--mode',
        'json',
        '-p',
        'Installed package fake fixture only',
      ],
      { env: piEnv },
    );
    active = readState();
    pids.push(active.pid);
    assert.equal(active.port, port);
    await divan(['stop']);
    active = null;
    checks.push(
      'Pi loads packaged TypeScript under node_modules, lists lazily, first fake request starts emitted server; no Divan rows with run-compatible discovery',
    );
  }
} finally {
  if (active) await killTree(active.pid);
  for (const child of live) if (child.pid) await killTree(child.pid);
  if (existsSync(join(home, 'server.json'))) await killTree(readState().pid);
  const uniquePids = [...new Set(pids)].filter((pid) => pid !== undefined);
  for (let i = 0; i < 40 && uniquePids.some(processExists); i++)
    await new Promise((done) => setTimeout(done, 50));
  const remaining = uniquePids.filter(processExists);
  const report = {
    node: process.version,
    checks,
    pids: uniquePids,
    stopped: remaining.length === 0,
    remaining,
    temp,
    artifact: packedArtifact,
  };
  mkdirSync(join(root, '.evidence'), { recursive: true });
  writeFileSync(
    join(
      root,
      '.evidence',
      process.argv.includes('--isolation-only') ? 'npm-isolation.json' : 'installed-package.json',
    ),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  assert.deepEqual(remaining, [], 'all owned verifier processes stopped');
  rmSync(temp, { recursive: true, force: true });
}
console.log(
  `Installed package: ${checks.length} checks passed; owned processes stopped. Evidence: .evidence/installed-package.json`,
);
