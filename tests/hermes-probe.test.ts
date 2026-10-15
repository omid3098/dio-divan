import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { FIX12_SHA256, withProbeSlot } from '../scripts/hermes-probe.mjs';
import { resolveHermesRoutes } from '../src/server/adapters/hermes-install.ts';
import { prepareHermes } from '../src/server/adapters/hermes-run.ts';
import { runProc } from '../src/server/proc.ts';
import { hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

it.skipIf(!hermesLayoutReady)(
  'production tools-on preparation skips Hermes bookkeeping, preserves skill text and reaches a fake provider',
  async () => {
    const fixture = hermesFixture();
    const saved = process.env.DIVAN_HOME;
    process.env.DIVAN_HOME = fixture.temp;
    let requests = 0;
    let prepared: ReturnType<typeof prepareHermes> | undefined;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      if (req.method === 'GET' || req.url === '/api/show') {
        res.setHeader('content-type', 'application/json');
        res.end(
          req.method === 'GET' ? '{"data":[]}' : '{"model_info":{"general.context_length":131072}}',
        );
        return;
      }
      requests++;
      expect(
        JSON.parse(body).tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'read_file',
        ),
      ).toBe(true);
      res.setHeader('content-type', 'text/event-stream');
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta: { content: 'READY' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    try {
      const skills = join(fixture.policy.home, 'skills');
      // Real layout: 31 root entries, a 41.6 MB hub cache and a 2841-byte instruction file.
      for (const name of ['.hub/index-cache', '.archive', '.curator_backups', '.locks'])
        mkdirSync(join(skills, name), { recursive: true });
      writeFileSync(join(skills, '.hub/index-cache/hermes-index.json'), Buffer.alloc(41560130, 32));
      for (const name of [
        '.bundled_manifest',
        '.curator_ledger.jsonl',
        '.curator_state',
        '.curator_suppressed',
        '.usage.json',
        '.usage.json.lock',
      ])
        writeFileSync(join(skills, name), 'PRIVATE BOOKKEEPING');
      for (let i = 0; i < 20; i++) {
        mkdirSync(join(skills, `skill-${i}`));
        writeFileSync(join(skills, `skill-${i}/SKILL.md`), 'SYNTHETIC SKILL');
      }
      expect(readdirSync(skills)).toHaveLength(31);
      mkdirSync(join(skills, 'sample/.references'));
      writeFileSync(join(skills, 'sample/.references/note.md'), 'SUPPORT TEXT');
      writeFileSync(join(fixture.policy.home, 'AGENTS.md'), 'x'.repeat(2841));
      writeFileSync(join(fixture.policy.home, 'SOUL.md'), '');
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as { port: number }).port;
      expect(port).not.toBe(47321);
      const route = {
        id: 'fixture',
        provider: 'fixture',
        endpoint: `http://127.0.0.1:${port}/v1`,
        protocol: 'chat_completions' as const,
        model: 'fixture-model',
        keyEnv: 'LAB_KEY',
        default: true,
      };
      const layout = { ...fixture.policy, parentCreated: fixture.stamp };
      const spec = {
        harness: 'hermes' as const,
        model: route.id,
        effort: 'low',
        tools: true,
        memory: false,
        web: false,
        prompt: 'Reply READY.',
        schema: {},
        idleMs: 120000,
      };
      prepared = prepareHermes(layout, route, spec);
      expect(readdirSync(join(prepared.copied, 'skills'))).toHaveLength(21);
      expect(readFileSync(join(prepared.copied, 'skills/sample/.references/note.md'), 'utf8')).toBe(
        'SUPPORT TEXT',
      );
      const policy = JSON.parse(readFileSync(prepared.policyFile, 'utf8'));
      const run = prepared;
      const summary = await withProbeSlot(
        join(fixture.control, 'good/ledger.json'),
        'synthetic',
        async (attemptCounter) => {
          policy.attemptCounter = attemptCounter;
          writeFileSync(run.policyFile, JSON.stringify(policy));
          const result = await runProc({
            command: fixture.basePython,
            args: run.args,
            cwd: run.control,
            env: run.env,
            envMode: 'replace',
            stdin: spec.prompt,
            idleMs: spec.idleMs,
          });
          expect(result.code, result.stderr).toBe(0);
          expect(result.stdout).toContain('READY');
        },
      );
      expect(summary.requests).toBe(1);
      expect(requests).toBe(1);
      prepared.cleanup();
      prepared = undefined;
      // Genuine skill files still obey the old size limit; failure evidence retains no error text.
      const oversized = join(skills, 'sample/large.txt');
      writeFileSync(oversized, Buffer.alloc(4 * 1024 * 1024 + 1));
      const ledger = join(fixture.control, 'bad/ledger.json');
      await expect(
        withProbeSlot(ledger, 'synthetic', async () => prepareHermes(layout, route, spec), {
          stage: () => 'preparation',
        }),
      ).rejects.toThrow();
      const slot = JSON.parse(readFileSync(ledger, 'utf8')).slots[0];
      expect(slot).toMatchObject({
        state: 'failed',
        requests: 0,
        failure: { stage: 'preparation', reason: 'hermes_policy' },
      });
      expect(slot.failure.frames).toContainEqual(expect.stringMatching(/^hermes-run.ts:\d+$/u));
      expect(JSON.stringify(slot)).not.toMatch(
        /PRIVATE BOOKKEEPING|synthetic-fixture-key|large.txt|Users/u,
      );
      rmSync(oversized);
    } finally {
      prepared?.cleanup();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      if (saved === undefined) delete process.env.DIVAN_HOME;
      else process.env.DIVAN_HOME = saved;
      fixture.close();
    }
  },
  180000,
);

it.skipIf(!hermesLayoutReady)(
  'actual probe CLI: four one-request actions, reserve, strict failures and durable sanitized evidence',
  async () => {
    const fixture = hermesFixture();
    const artifact = JSON.parse(readFileSync('.evidence/fix14-tarball.json', 'utf8'));
    // Exercise this round's archive without changing the still-closed real-probe driver.
    const driver = resolve('.evidence/fix14-probe-driver.mjs');
    writeFileSync(
      driver,
      'if (!process.argv.includes("--fake-provider")) throw new Error("Fake fixture only");\n' +
        readFileSync('scripts/hermes-probe.mjs', 'utf8')
          .replaceAll(FIX12_SHA256, artifact.sha256)
          .replaceAll('npm-pack/fix12/', 'npm-pack/fix14/'),
    );
    const stage0 = join(fixture.control, 'stage0.json');
    const ledger = join(fixture.control, 'allowance/ledger.json');
    let kind = 'startup';
    let bad = '';
    let requests = 0;
    let memoryCalls = 0;
    const catalogs: string[][] = [];
    const args = {
      read: { path: join(fixture.temp, 'canary.txt'), offset: 1, limit: 1 },
      memory: { query: 'fixture needle', limit: 5 },
      history: { query: 'fixture needle', limit: 1 },
    };
    const expected = {
      read: 'READ CANARY',
      memory: 'fixture/page',
      history: { id: 'fixture-id', title: 'fixture needle title' },
    };
    const tools = {
      read: 'read_file',
      memory: 'mcp_memory_search',
      history: 'mcp_hermes_history_hermes_history_search',
    };
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      res.setHeader('content-type', 'application/json');
      if (req.url === '/memory') {
        const rpc = JSON.parse(body);
        if (rpc.method === 'notifications/initialized') {
          res.end('{}');
          return;
        }
        if (rpc.method === 'tools/call') {
          memoryCalls++;
          expect(rpc.params).toEqual({ name: 'search', arguments: args.memory });
        }
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result:
              rpc.method === 'initialize'
                ? {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    serverInfo: { name: 'fixture', version: '1' },
                  }
                : {
                    content: [
                      {
                        type: 'text',
                        text: JSON.stringify([
                          { slug: expected.memory, snippet: 'NEVER RETAIN MEMORY BODY' },
                        ]),
                      },
                    ],
                  },
          }),
        );
        return;
      }
      if (req.method === 'GET') {
        res.end('{"data":[{"id":"fixture-model"}]}');
        return;
      }
      if (req.url === '/api/show') {
        res.end('{"model_info":{"general.context_length":131072}}');
        return;
      }
      requests++;
      catalogs.push(
        (JSON.parse(body).tools ?? []).map(
          (tool: { function: { name: string } }) => tool.function.name,
        ),
      );
      if (bad === 'unrelated125') {
        res.writeHead(500).end('{"error":{"message":"synthetic outage"}}');
        return;
      }
      const action = kind as keyof typeof tools;
      const delta =
        kind === 'startup'
          ? { content: bad === 'ready' ? 'WRONG' : 'READY' }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: 'fixture-action',
                  type: 'function',
                  function: { name: tools[action], arguments: JSON.stringify(args[action]) },
                },
              ],
            };
      const chunk = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture-model',
        choices: [{ index: 0, delta, finish_reason: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: kind === 'startup' ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      );
    });
    try {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as { port: number }).port;
      expect(port).not.toBe(47321);
      const endpoint = `http://127.0.0.1:${port}/v1`;
      fixture.policy.config.providers.fixture.base_url = endpoint;
      fixture.policy.config.model.base_url = endpoint;
      writeFileSync(
        join(fixture.policy.home, 'config.yaml'),
        JSON.stringify({
          ...fixture.policy.config,
          mcp_servers: {
            memory: {
              url: `http://127.0.0.1:${port}/memory`,
              headers: { Authorization: ['Bearer $', '{LAB_MEMORY_KEY}'].join('') },
            },
          },
        }),
      );
      const db = new DatabaseSync(join(fixture.policy.home, 'state.db'));
      db.exec(
        'CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); CREATE INDEX message_session ON messages(session_id,id)',
      );
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
        expected.history.id,
        expected.history.title,
        1,
      );
      db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(
        1,
        expected.history.id,
        'user',
        'NEVER RETAIN HISTORY BODY',
        1,
        1,
      );
      db.close();
      const route = resolveHermesRoutes(
        [
          {
            provider: 'fixture',
            model: 'fixture-model',
            endpoint,
            keyEnv: 'LAB_KEY',
            protocol: 'chat_completions',
          },
        ],
        fixture.policy.home,
        { LAB_KEY: 'synthetic' },
      )[0];
      expect(route).toBeDefined();
      writeFileSync(
        stage0,
        JSON.stringify({
          sha256: artifact.sha256,
          driverSha256: createHash('sha256').update(readFileSync(driver)).digest('hex'),
          syntheticFixture: true,
          fileCount: artifact.fileCount,
        }),
      );
      const input = join(fixture.control, 'input.json');
      const runs: {
        kind: string;
        failure: string;
        code: number | null;
        requests: number;
        durationMs: number;
      }[] = [];
      async function launch(selected: string, failure = '', selectedLedger = ledger) {
        kind = selected;
        bad = failure;
        const before = requests;
        const probe =
          kind === 'startup'
            ? { kind }
            : {
                kind,
                args: args[kind as keyof typeof args],
                expect:
                  failure === 'result' ? 'WRONG CANARY' : expected[kind as keyof typeof expected],
              };
        writeFileSync(
          input,
          JSON.stringify({
            root: fixture.policy.root,
            home: fixture.policy.home,
            routeId: route?.id,
            ledger: selectedLedger,
            stage0,
            probe,
            tools: ['read', 'history'].includes(kind),
            memory: kind === 'memory',
            web: false,
            prompt: 'Perform the one reviewed action.',
          }),
        );
        const result = await runProc({
          command: process.execPath,
          args: [driver, input, '--fake-provider'],
          cwd: process.cwd(),
          env: {
            HERMES_MANAGED_DIR: fixture.policy.managed,
            LAB_MEMORY_KEY: 'synthetic-memory-key',
            DIVAN_NO_OPEN: '1',
            DIVAN_PORT: '0',
          },
          idleMs: 180_000,
          maxMs: 180_000,
        });
        runs.push({
          kind,
          failure,
          code: result.code,
          requests: requests - before,
          durationMs: result.durationMs,
        });
        expect(result.timedOut || result.cancelled || result.spawnError).toBeFalsy();
        return result;
      }
      for (const selected of ['startup', 'read', 'memory', 'history']) {
        const result = await launch(selected);
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).requests).toBe(1);
        expect(JSON.parse(result.stdout).refused).toBe(selected === 'startup' ? 0 : 1);
      }
      expect(memoryCalls).toBe(1);
      expect((await launch('startup', 'ready')).code).toBe(1);
      expect((await launch('startup')).code).toBe(1); // No sixth launch/request.
      expect(requests).toBe(5);
      const state = JSON.parse(readFileSync(ledger, 'utf8'));
      expect(state.slots.map((slot: { state: string }) => slot.state)).toEqual([
        'done',
        'done',
        'done',
        'done',
        'failed',
      ]);
      expect(state.slots.every((slot: { requests: number }) => slot.requests === 1)).toBe(true);
      const failedLedger = join(fixture.control, 'failed/ledger.json');
      expect((await launch('read', 'result', failedLedger)).code).toBe(1);
      const failed = JSON.parse(readFileSync(failedLedger, 'utf8'));
      expect(failed.slots[0]).toMatchObject({ state: 'failed', requests: 1, refused: 1 });
      expect(failed.slots[0].evidence.some((item: { type: string }) => item.type === 'tool')).toBe(
        true,
      );
      const unrelated = join(fixture.control, 'unrelated/ledger.json');
      expect((await launch('startup', 'unrelated125', unrelated)).code).toBe(1);
      expect(JSON.parse(readFileSync(unrelated, 'utf8')).slots[0].refused).toBe(0);
      for (const saved of [state, failed]) {
        expect(JSON.stringify(saved)).not.toMatch(
          /NEVER RETAIN|synthetic-memory-key|second line|snippet|tool_call_id/u,
        );
      }
      for (const row of runs.slice(0, 5)) expect(row.requests).toBe(1);
      const evidenceRoot = '.evidence/fix14-probe-cli';
      mkdirSync(evidenceRoot, { recursive: true });
      writeFileSync(
        join(evidenceRoot, 'results.json'),
        JSON.stringify(
          {
            runs,
            catalogs,
            allowance: state,
            failure: failed,
            unrelated: JSON.parse(readFileSync(unrelated, 'utf8')),
          },
          null,
          2,
        ),
      );
      // CLI removes every private child home; the parent records are still readable here.
      expect(existsSync(failedLedger)).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      fixture.close();
    }
  },
  600_000,
);
