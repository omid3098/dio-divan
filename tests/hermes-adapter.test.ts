import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hermesAdapter, hermesModels } from '../src/server/adapters/hermes.ts';
import {
  discoverHermes,
  hermesKey,
  inspectHermes,
  resolveHermesRoutes,
} from '../src/server/adapters/hermes-install.ts';
import {
  hermesEnvironment,
  prepareHermes,
  removeHermesPair,
} from '../src/server/adapters/hermes-run.ts';
import { runWithAdapter, settleRun } from '../src/server/adapters/index.ts';
import type { Adapter, RunSpec } from '../src/server/adapters/types.ts';
import { note } from '../src/shared/messages.ts';

vi.mock('../src/server/adapters/hermes-install.ts', async (original) => {
  const actual = await original<typeof import('../src/server/adapters/hermes-install.ts')>();
  return { ...actual, discoverHermes: vi.fn(actual.discoverHermes) };
});

import * as memoryAccess from '../src/server/memory-access.ts';
import type { ProcResult } from '../src/server/proc.ts';
import { runProc } from '../src/server/proc.ts';
import { HARNESS_RULES } from '../src/shared/harness-rules.ts';
import { MEMORY_READ_TOOLS, serversFor } from '../src/shared/readonly-tools.ts';
import { hermesAssets, hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

const spec: RunSpec = {
  harness: 'hermes',
  model: 'fixture',
  effort: 'low',
  tools: true,
  memory: false,
  web: false,
  idleMs: 1000,
  prompt: 'fixture',
  schema: { type: 'object' },
};
const proc = (stdout: string, overrides: Partial<ProcResult> = {}): ProcResult => ({
  stdout,
  stderr: '',
  code: 0,
  timedOut: false,
  cancelled: false,
  spawnError: null,
  durationMs: 1,
  ...overrides,
});
const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, 'fixtures/adapters', `hermes-${name}.jsonl`), 'utf8');
it('A: synthetic streams deduplicate exact activity, strip secrets, preserve cumulative usage and refuse missing/conflicting terminal records', () => {
  expect(hermesAdapter.parse(proc(fixture('read')), spec)).toMatchObject({
    text: '{"ok":true}',
    error: null,
    usage: { input: 100, cached: 40, output: 20, total: 160 },
  });
  expect(hermesAdapter.parse(proc(fixture('usage')), spec).usage?.total).toBe(170);
  expect(hermesAdapter.parse(proc(fixture('read'), { code: 125 }), spec).error).not.toBeNull();
  expect(
    hermesAdapter.parse(proc('{"type":"text","text":"earlier"}\n'), spec).error,
  ).not.toBeNull();
  expect(hermesAdapter.parse(proc(fixture('read') + fixture('usage')), spec).error).not.toBeNull();
  expect(
    hermesAdapter.parse(
      proc(
        '{"type":"result","exit_code":0,"text":"ok","tokens":{"input":10,"output":1,"total":999}}\n',
      ),
      spec,
    ).error,
  ).not.toBeNull();
  expect(
    hermesAdapter.parse(proc('{"type":"result","exit_code":0,"text":"ok"}\n'), spec).usage,
  ).toBeNull();
  const watched = hermesAdapter.watch?.(spec);
  const events = [];
  for (const char of fixture('tools')) events.push(...(watched?.push(char)?.tools ?? []));
  expect(events.map((event) => event.kind)).toEqual(['file', 'memory', 'thread', 'thread']);
  expect(JSON.stringify(events)).not.toContain('synthetic-private');
  const failed = settleRun(
    hermesAdapter,
    spec,
    proc(fixture('error'), { code: 1, stderr: 'synthetic-private-key' }),
  );
  expect(failed.diagnostics).toBe('');
  expect(failed.error).not.toContain('synthetic-private-key');
  expect(failed.usage?.total).toBe(8);
});
it.skipIf(process.platform !== 'win32')(
  'Hermes reports a missing home before inspecting an install, and names the supported revision for an unsupported install',
  () => {
    const temp = mkdtempSync(join(tmpdir(), 'divan-hermes-discovery-'));
    try {
      const root = join(temp, 'install');
      const home = join(temp, 'missing-home');
      expect(inspectHermes(root, home).problem).toEqual(
        note('hermes_home_missing', { path: home }),
      );
      mkdirSync(join(root, 'hermes-agent'), { recursive: true });
      mkdirSync(home);
      const revision = (
        JSON.parse(readFileSync(join(hermesAssets, 'supported.json'), 'utf8')) as {
          source_commit: string;
        }
      ).source_commit.slice(0, 12);
      expect(inspectHermes(root, home).problem).toEqual(note('hermes_unsupported', { revision }));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);

it('A: route tuples distinguish endpoints/protocols, literal keys only; Hermes remains unavailable until the whole mandatory gate passes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'divan-hermes-routes-'));
  try {
    writeFileSync(join(home, '.env'), 'FIXTURE_KEY=synthetic-key\n');
    const route = {
      provider: 'fixture',
      endpoint: 'https://fixture.invalid/v1',
      protocol: 'chat_completions',
      model: 'gpt-6-luna',
      keyEnv: 'FIXTURE_KEY',
    };
    const routes = resolveHermesRoutes(
      [route, { ...route, endpoint: 'https://second.invalid/v1' }],
      home,
      {},
    );
    expect(routes).toHaveLength(2);
    expect(routes[0]?.id).not.toBe(routes[1]?.id);
    for (const bad of [
      { ...route, protocol: 'responses' },
      { ...route, endpoint: 'https://key:secret@fixture.invalid/v1' },
      { ...route, keyEnv: 'MISSING' },
      { ...route, model: 'divan/default' },
      { ...route, model: 'moa:fixture' },
      { ...route, enabled: false },
      { ...route, oauth: true },
      { ...route, key_cmd: 'unsafe' },
    ])
      expect(resolveHermesRoutes([bad], home, {})).toEqual([]);
    expect(hermesKey('FIXTURE_KEY', home, { FIXTURE_KEY: '$(unsafe)' })).toBeNull();
    expect((await discoverHermes(join(home, 'missing'))).problem).not.toBeNull();
    if (process.platform === 'win32')
      vi.mocked(discoverHermes).mockResolvedValueOnce({
        installed: false,
        routes: [],
        memory: null,
        problem: note('hermes_install'),
      });
    expect('error' in (await hermesAdapter.build(spec, home, home))).toBe(true);
    expect(HARNESS_RULES.hermes.web.mode).toBe('blocked');
    expect(
      serversFor('hermes', { tools: true, memory: false }).map((server) => server.name),
    ).toEqual(['t3', 'hermes_history']);
    if (process.platform === 'win32') {
      const env = hermesEnvironment(home, home, { FIXTURE_KEY: 'synthetic' });
      expect(env.PATH).toMatch(/System32$/u);
      expect(
        Object.keys(env).some((name) => /NODE_|PYTHON|PROXY|T3_ACP_|BASH_ENV/iu.test(name)),
      ).toBe(false);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it.skipIf(!hermesLayoutReady)(
  'A/E: static discovery, copied texts and clean actual launcher/Low environments; adapter abort waits before cleanup',
  async () => {
    const fixture = hermesFixture();
    const saved = process.env.DIVAN_HOME;
    process.env.DIVAN_HOME = fixture.temp;
    const inherited = ['nOdE_oPtIoNs', 'PYTHONPATH', 'BASH_ENV', 'HTTPS_PROXY', 'T3_ACP_FIX7'];
    const previous = inherited.map((key) => process.env[key]);
    for (const key of inherited) process.env[key] = 'synthetic-control';
    let prepared: ReturnType<typeof prepareHermes> | undefined;
    const memoryUrl = vi
      .spyOn(memoryAccess, 'memoryUrl')
      .mockReturnValue('https://memory.invalid/mcp');
    try {
      const config = JSON.parse(
        readFileSync(join(fixture.control, 'route-cases/moa-config/config.yaml'), 'utf8'),
      );
      config.mcp_servers = JSON.parse(
        readFileSync(join(fixture.control, 'route-cases/memory-renamed/config.yaml'), 'utf8'),
      ).mcp_servers;
      writeFileSync(join(fixture.policy.home, 'config.yaml'), JSON.stringify(config));
      const found = inspectHermes(fixture.policy.root, fixture.policy.home);
      expect(found.problem).toBeNull();
      expect(found.routes.map((route) => route.model)).toEqual(['fixture-model']);
      expect(hermesModels(found).note).toEqual(note('hermes_moa'));
      expect(found.memory).toEqual({ url: 'https://memory.invalid/mcp', headerEnv: 'LAB_KEY' });
      expect(
        hermesModels({ ...found, memory: null, memoryProblem: note('hermes_memory_unavailable') })
          .note,
      ).toEqual(note('hermes_memory_unavailable'));
      expect(JSON.stringify(found)).not.toContain('synthetic-fixture-key');
      const route = found.routes[0];
      expect(route).toBeDefined();
      vi.mocked(discoverHermes).mockResolvedValueOnce(found);
      const command = await hermesAdapter.build(
        {
          ...spec,
          model: route?.id ?? '',
          schema: {
            title: 'PRIVATE NODE',
            type: 'object',
            properties: { ok: { type: 'boolean', description: 'PRIVATE FORM' } },
            required: ['ok'],
          },
        },
        fixture.control,
        fixture.run,
      );
      expect('error' in command).toBe(false);
      if ('error' in command) throw new Error(command.error);
      expect(command.args).toContain('--query-file');
      expect(command.args).toContain('stream-json');
      expect(command.args).not.toContain('--max-turns');
      expect(command.args).not.toContain('--yolo');
      expect(command.envMode).toBe('replace');
      expect(command.stdin).not.toContain('PRIVATE NODE');
      expect(command.stdin).not.toContain('PRIVATE FORM');
      expect(command.stdin).toContain('"ok":{"type":"boolean"}');
      await command.cleanup?.();
      prepared = prepareHermes(
        found.layout as NonNullable<typeof found.layout>,
        route as NonNullable<typeof route>,
        { ...spec, tools: true, memory: false },
      );
      expect(prepared.instructions).toContain('SYNTHETIC INSTRUCTIONS');
      const generated = JSON.parse(readFileSync(join(prepared.run, 'home/config.yaml'), 'utf8'));
      expect(generated).not.toHaveProperty('moa');
      expect(generated.fallback_model).toBeNull();
      expect(JSON.parse(readFileSync(prepared.policyFile, 'utf8')).config).toEqual(generated);
      expect(prepared.instructions).toContain('SYNTHETIC SOUL');
      expect(prepared.memoryText).toBe('');
      expect(existsSync(join(prepared.copied, 'memories'))).toBe(false);
      expect(readFileSync(join(prepared.copied, 'skills/sample/SKILL.md'), 'utf8')).toContain(
        '!`echo',
      );
      expect(readFileSync(prepared.policyFile, 'utf8')).not.toContain('synthetic-fixture-key');
      const code = 'import os,json;print(json.dumps(sorted(os.environ)))';
      const medium = await runProc({
        command: fixture.basePython,
        args: ['-I', '-S', '-B', '-c', code],
        cwd: prepared.control,
        env: prepared.env,
        envMode: 'replace',
        idleMs: 5000,
      });
      const low = await fixture.executeCommand(
        fixture.python,
        ['-I', '-B', '-c', code],
        '',
        prepared.env,
      );
      for (const result of [medium, low]) {
        expect(result.code, result.stderr).toBe(0);
        const names = JSON.parse(result.stdout) as string[];
        expect(names).toContain('LAB_KEY');
        expect(
          names.some((name) =>
            /^(?:NODE_|PYTHON|BASH_ENV|ENV$|.*PROXY|T3_ACP_|ELECTRON)/iu.test(name),
          ),
        ).toBe(false);
      }
      prepared.cleanup();
      prepared = undefined;
      prepared = prepareHermes(
        found.layout as NonNullable<typeof found.layout>,
        route as NonNullable<typeof route>,
        { ...spec, tools: false, memory: true },
        found.memory,
      );
      const policy = JSON.parse(readFileSync(prepared.policyFile, 'utf8'));
      expect(Object.keys(policy.services)).toEqual(['memory']);
      expect(Object.keys(policy.services.memory.tools)).toEqual(MEMORY_READ_TOOLS);
      expect(policy.services.memory.url).toBe('https://memory.invalid/mcp');
      expect(JSON.stringify(policy)).not.toMatch(/memrepo|put_page|delete_page|approve_proposal/u);
      expect(policy.config.mcp_servers).toEqual({});
      expect(prepared.memoryText).toContain('SYNTHETIC MEMORY');
      expect(existsSync(join(prepared.copied, 'skills'))).toBe(false);
      prepared.cleanup();
      prepared = undefined;
      // The lifecycle hook owns a real Low job; its fake child never imports Hermes or calls a service.
      const controller = new AbortController();
      let lowPid = 0,
        descendant = 0,
        cleaned = false;
      let output = '';
      const adapter: Adapter = {
        ...hermesAdapter,
        watch() {
          return {
            push(chunk) {
              output += chunk;
              lowPid = Number(/LOW (\d+)/u.exec(output)?.[1] ?? 0);
              descendant = Number(/DESC (\d+)/u.exec(output)?.[1] ?? 0);
              if (lowPid && descendant) controller.abort();
              return {};
            },
          };
        },
        build() {
          return {
            command: fixture.basePython,
            args: [
              '-I',
              '-S',
              '-B',
              join(hermesAssets, 'launcher.py'),
              join(fixture.run, 'scratch'),
              String(process.pid),
              fixture.stamp,
              fixture.python,
              '-I',
              '-B',
              '-c',
              "import os,sys,subprocess,time;print('LOW '+str(os.getpid()),flush=True);p=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(120)'],creationflags=0x08000000);print('DESC '+str(p.pid),flush=True);time.sleep(120)",
            ],
            env: fixture.env,
            envMode: 'replace',
            cwd: fixture.control,
            cleanup() {
              expect(() => process.kill(lowPid, 0)).toThrow();
              expect(() => process.kill(descendant, 0)).toThrow();
              cleaned = true;
            },
          };
        },
      };
      const result = await runWithAdapter(adapter, {
        ...spec,
        idleMs: 20000,
        signal: controller.signal,
      });
      expect(result.cancelled).toBe(true);
      expect(cleaned).toBe(true);
      expect(lowPid).toBeGreaterThan(0);
      expect(descendant).toBeGreaterThan(0);
    } finally {
      memoryUrl.mockRestore();
      prepared?.cleanup();
      if (saved === undefined) delete process.env.DIVAN_HOME;
      else process.env.DIVAN_HOME = saved;
      inherited.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      fixture.close();
    }
  },
  150000,
);

it('L: substituted cleanup roots preserve an outside canary', () => {
  const temp = mkdtempSync(join(tmpdir(), 'divan-hermes-cleanup-'));
  const run = join(temp, 'run'),
    control = join(temp, 'control'),
    outside = join(temp, 'outside');
  for (const path of [run, control, outside]) mkdirSync(path);
  writeFileSync(join(outside, 'canary'), 'keep');
  const identities = [run, control].map((path) => {
    const info = lstatSync(path);
    return [info.dev, info.ino] as [number, number];
  });
  try {
    renameSync(run, `${run}-old`);
    symlinkSync(outside, run, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => removeHermesPair(run, control, identities)).toThrow();
    expect(readFileSync(join(outside, 'canary'), 'utf8')).toBe('keep');
    expect(existsSync(control)).toBe(true);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

it.skipIf(!hermesLayoutReady)(
  'P: preparation refuses a protected child beginning with .. and permits a separate local drive',
  () => {
    const fixture = hermesFixture();
    const saved = process.env.DIVAN_HOME;
    let prepared: ReturnType<typeof prepareHermes> | undefined;
    let other: string | undefined;
    const route = {
      id: 'fixture',
      provider: 'fixture',
      endpoint: 'http://127.0.0.1:1/v1',
      protocol: 'chat_completions' as const,
      model: 'fixture-model',
      keyEnv: 'LAB_KEY',
      default: true,
    };
    try {
      const nested = join(fixture.temp, '..protected-child');
      mkdirSync(nested);
      process.env.DIVAN_HOME = nested;
      const layout = {
        ...fixture.policy,
        root: fixture.temp,
        home: fixture.policy.home,
        parentCreated: fixture.stamp,
      };
      expect(() => {
        prepared = prepareHermes(layout, route, spec);
      }).toThrow();
      expect(existsSync(join(nested, 'runs'))).toBe(false);
      other = mkdtempSync(join(process.cwd(), '.evidence', 'fix7-drive-'));
      process.env.DIVAN_HOME = other;
      prepared = prepareHermes({ ...layout, root: fixture.policy.root }, route, spec);
      expect(existsSync(prepared.policyFile)).toBe(true);
      prepared.cleanup();
      prepared = undefined;
    } finally {
      prepared?.cleanup();
      if (saved === undefined) delete process.env.DIVAN_HOME;
      else process.env.DIVAN_HOME = saved;
      if (other) rmSync(other, { recursive: true, force: true });
      fixture.close();
    }
  },
);
