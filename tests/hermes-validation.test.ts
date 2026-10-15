import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { discoverHermes, verifyHermesBytecode } from '../src/server/adapters/hermes-install.ts';
import { prepareHermes } from '../src/server/adapters/hermes-run.ts';
import { runProc } from '../src/server/proc.ts';
import { ownerOnly } from '../src/server/secure.ts';
import { hermesAssets, hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

it.skipIf(!hermesLayoutReady)(
  'validation receipts refuse same-ID content changes, Low code and replaced held ancestors',
  async () => {
    const fixture = hermesFixture();
    try {
      ownerOnly(fixture.control, true);
      const result = await runProc({
        command: fixture.basePython,
        args: [
          '-I',
          '-S',
          '-B',
          join(import.meta.dirname, 'fixtures/hermes/validation.py'),
          fixture.policyFile,
          hermesAssets,
        ],
        cwd: fixture.control,
        env: fixture.env,
        envMode: 'replace',
        idleMs: 60_000,
        maxMs: 60_000,
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain('VALIDATION CANARIES OK');
    } finally {
      fixture.close();
    }
  },
  65_000,
);

it.skipIf(!hermesLayoutReady)(
  'cache reuse refuses altered bytes, inventory, protection and Low-forged json bytecode before launch',
  async () => {
    const fixture = hermesFixture();
    const names = ['DIVAN_HOME', 'DIVAN_NO_OPEN', 'DIVAN_PORT', 'HERMES_MANAGED_DIR'] as const;
    const previous = names.map((name) => process.env[name]);
    Object.assign(process.env, {
      DIVAN_HOME: fixture.temp,
      DIVAN_NO_OPEN: '1',
      DIVAN_PORT: '0',
      HERMES_MANAGED_DIR: fixture.policy.managed,
    });
    try {
      const found = await discoverHermes(fixture.policy.root, fixture.policy.home);
      expect(found.problem).toBeNull();
      const layout = found.layout;
      const route = found.routes[0];
      if (!layout?.bytecode || !route) throw new Error('Missing fixture cache');
      const cache = layout.bytecode;
      verifyHermesBytecode(layout);
      const target = readdirSync(cache, { recursive: true })
        .map(String)
        .find((name) => /[\\/]Lib[\\/]json[\\/]__init__\.cpython-\d+\.pyc$/u.test(name));
      if (!target) throw new Error('Missing cached json');
      const file = join(cache, target);
      const original = readFileSync(file);
      const spec = {
        harness: 'hermes' as const,
        model: route.id,
        effort: 'low',
        tools: false,
        memory: false,
        web: false,
        prompt: 'No model call permitted.',
        schema: {},
        idleMs: 20_000,
      };
      const refused = () => expect(() => prepareHermes(layout, route, spec)).toThrow();
      const marker = join(cache, 'ready.json');
      const receipt = JSON.parse(readFileSync(marker, 'utf8'));
      const extra = join(cache, 'extra.pyc');
      writeFileSync(extra, original);
      refused();
      unlinkSync(extra);
      verifyHermesBytecode(layout);
      const payload = join(fixture.control, 'payload.pyc');
      execFileSync(
        fixture.basePython,
        [
          '-I',
          '-S',
          '-B',
          '-c',
          'import sys,importlib.util,importlib._bootstrap_external as b;from pathlib import Path;source=Path(sys.argv[1])/"Lib/json/__init__.py";code=compile("import os;os.write(1,b\'UNTRUSTED_CACHE_EXECUTED\\\\n\');os._exit(73)",str(source),"exec");Path(sys.argv[2]).write_bytes(b._code_to_hash_pyc(code,importlib.util.source_hash(source.read_bytes()),checked=True))',
          join(fixture.basePython, '..'),
          payload,
        ],
        { env: fixture.env, windowsHide: true },
      );
      expect(readFileSync(payload).subarray(0, 16)).toEqual(original.subarray(0, 16));
      // Even an intact Medium label cannot authenticate a forged checked-source-hash payload.
      writeFileSync(file, readFileSync(payload));
      refused();
      writeFileSync(file, original);
      execFileSync(
        join(fixture.env.SystemRoot ?? 'C:\\Windows', 'System32/icacls.exe'),
        [file, '/setintegritylevel', 'L'],
        { windowsHide: true, stdio: 'pipe' },
      );
      const attack = await fixture.executeCommand(fixture.python, [
        '-I',
        '-S',
        '-B',
        '-c',
        'import sys;from pathlib import Path;Path(sys.argv[1]).write_bytes(Path(sys.argv[2]).read_bytes());print("LOW_OVERWRITE_OK")',
        file,
        payload,
      ]);
      expect(attack.code, attack.stderr).toBe(0);
      expect(attack.stdout).toContain('LOW_OVERWRITE_OK');
      expect(readFileSync(file)).toEqual(readFileSync(payload));
      refused();
      const reused = await discoverHermes(fixture.policy.root, fixture.policy.home);
      expect(reused.layout?.bytecode).toBe(cache);
      expect(() => prepareHermes(reused.layout ?? layout, route, spec)).toThrow();
      expect(readdirSync(join(fixture.temp, 'runs'))).toEqual(['own', 'sibling']);
      writeFileSync(
        '.evidence/fix14-cache-attack.json',
        JSON.stringify(
          {
            lowOverwrite: true,
            parentRefused: true,
            cacheConsumerStarts: 0,
            untrustedCodeExecuted: false,
            modelRequests: 0,
            cases: ['extra file', 'Medium forged bytes', 'Low forged checked-hash bytecode'],
            receiptFileCount: Object.keys(receipt.inventory.entries).length,
          },
          null,
          2,
        ),
      );
    } finally {
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
      fixture.close();
    }
  },
  180_000,
);

it.skipIf(!hermesLayoutReady)(
  'two concurrent production validators keep the unchanged 60-second deadline',
  async () => {
    const fixture = hermesFixture();
    try {
      const results = await Promise.all(
        [0, 1].map(async () => {
          const started = performance.now();
          const result = await runProc({
            command: fixture.basePython,
            args: ['-I', '-S', '-B', join(hermesAssets, 'install.py')],
            cwd: fixture.control,
            env: fixture.env,
            envMode: 'replace',
            stdin: JSON.stringify(fixture.policy),
            idleMs: 60_000,
            maxMs: 60_000,
          });
          expect(result.code, result.stderr).toBe(0);
          expect(JSON.parse(result.stdout).ok).toBe(true);
          return {
            elapsedMs: performance.now() - started,
            code: result.code,
            timedOut: result.timedOut,
          };
        }),
      );
      writeFileSync('.evidence/fix14-concurrency.json', JSON.stringify(results, null, 2));
    } finally {
      fixture.close();
    }
  },
  65_000,
);
