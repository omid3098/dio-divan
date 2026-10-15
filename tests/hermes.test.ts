import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withProbeSlot } from '../scripts/hermes-probe.mjs';
import { hermesAssets, hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

describe.skipIf(!hermesLayoutReady)('Hermes mandatory gate, disposable selected layout', () => {
  it.each(['outage', 'disconnect', 'empty', 'partly-used', 'second-send'])(
    'one provider attempt per protected probe: %s',
    async (scenario) => {
      const fixture = hermesFixture();
      const tools = scenario === 'second-send';
      fixture.policy.tools = tools;
      fixture.policy.config.platform_toolsets.cli = tools ? ['file', 'skills'] : [];
      const paths: string[] = [];
      const catalogs: number[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        if (req.url === '/api/show') {
          res.end('{"model_info":{"general.context_length":131072}}');
          return;
        }
        if (req.method === 'GET') {
          res.end('{"data":[{"id":"fixture-model"}]}');
          return;
        }
        paths.push(req.url ?? '');
        catalogs.push((JSON.parse(body).tools ?? []).length);
        if (scenario === 'disconnect') {
          req.socket.destroy();
          return;
        }
        if (scenario === 'outage' && paths.length <= 5) {
          res.writeHead(500, { 'content-type': 'application/json', 'retry-after': '0.01' });
          res.end('{"error":{"message":"synthetic transient outage","type":"server_error"}}');
          return;
        }
        const delta = tools
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'probe-read',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: JSON.stringify({ path: join(fixture.temp, 'canary.txt') }),
                  },
                },
              ],
            }
          : { content: scenario === 'empty' ? '' : 'READY' };
        const chunk = {
          id: 'synthetic',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason: null }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
        );
      });
      const ledger = join(fixture.control, 'probe/ledger.json');
      const archiveHash = 'synthetic-fix11';
      const prior = scenario === 'partly-used' ? 4 : 0;
      if (prior) {
        mkdirSync(join(fixture.control, 'probe'));
        writeFileSync(
          ledger,
          JSON.stringify({
            version: 1,
            archiveHash,
            slots: Array.from({ length: prior }, () => ({ state: 'done', requests: 1 })),
          }),
        );
      }
      try {
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        const port = (server.address() as { port: number }).port;
        fixture.policy.config.model.base_url = `http://127.0.0.1:${port}/v1`;
        fixture.policy.config.providers.fixture.base_url = fixture.policy.config.model.base_url;
        const launch = () =>
          withProbeSlot(ledger, archiveHash, async (attemptCounter) => {
            // A concurrent operator cannot reserve another slot while this child is alive.
            await expect(
              withProbeSlot(ledger, archiveHash, async () => {
                throw new Error('must not launch');
              }),
            ).rejects.toThrow();
            Object.assign(fixture.policy, { attemptCounter });
            fixture.save();
            return fixture.execute(
              join(hermesAssets, 'bootstrap.py'),
              [
                'chat',
                '--query-file',
                '-',
                '--format',
                'stream-json',
                '--source',
                'tool',
                '--provider',
                'custom:fixture',
                '-m',
                'fixture-model',
                '-t',
                tools ? 'file,skills' : 'none',
              ],
              'Reply with exactly READY.',
            );
          });
        const counts = [];
        // Two launches bound the most Divan's own single connection retry can spend.
        for (let i = 0; i < (scenario === 'outage' ? 2 : 1); i++) {
          const summary = await launch();
          expect(summary.requests).toBe(1);
          expect(
            summary.result.timedOut || summary.result.cancelled || summary.result.spawnError,
          ).toBeFalsy();
          expect(summary.result.code).toBe(scenario === 'partly-used' ? 0 : 125);
          if (scenario === 'partly-used') expect(summary.result.stdout).toContain('READY');
          if (scenario === 'second-send') expect(summary.refused).toBe(1);
          counts.push({
            requests: summary.requests,
            refused: summary.refused,
            code: summary.result.code,
          });
        }
        expect(paths).toEqual(Array(scenario === 'outage' ? 2 : 1).fill('/v1/chat/completions'));
        if (!tools) expect(catalogs).toEqual(paths.map(() => 0));
        if (prior) await expect(launch()).rejects.toThrow('Five-slot allowance exhausted');
        const saved = JSON.parse(readFileSync(ledger, 'utf8'));
        expect(saved.slots).toHaveLength(prior + counts.length);
        expect(saved.slots.every((slot: { requests: number }) => slot.requests === 1)).toBe(true);
        writeFileSync(
          join(process.cwd(), `.evidence/fix11-${scenario}.json`),
          JSON.stringify(
            { scenario, counts, paths, catalogs, slotsUsed: saved.slots.length },
            null,
            2,
          ),
        );
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        fixture.close();
      }
    },
    300_000,
  );
  it.each([true, false])(
    'boots the selected venv through the production bootstrap with a loopback fake provider, tools=%s',
    async (tools) => {
      const fixture = hermesFixture();
      fixture.policy.tools = tools;
      fixture.policy.config.platform_toolsets.cli = tools ? ['file', 'skills'] : [];
      let requests = 0;
      const catalogs: string[][] = [];
      const results: string[] = [];
      const server = createServer(async (req, res) => {
        let body = '';
        for await (const part of req) body += part;
        if (req.url === '/api/show') {
          res.end('{"model_info":{"general.context_length":131072}}');
          return;
        }
        if (req.method === 'GET') {
          res.end('{"data":[{"id":"fixture-model"}]}');
          return;
        }
        requests++;
        const parsed = JSON.parse(body);
        catalogs.push(
          (parsed.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name),
        );
        const finished = parsed.messages.some((msg: { role: string; content: string }) => {
          if (msg.role === 'tool') results.push(msg.content);
          return msg.role === 'tool';
        });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = {
          id: 'synthetic',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [
            {
              index: 0,
              delta:
                finished || !tools
                  ? { content: '{"ok":true}' }
                  : {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'synthetic-call',
                          type: 'function',
                          function: {
                            name: 'read_file',
                            arguments: JSON.stringify({ path: join(fixture.temp, 'canary.txt') }),
                          },
                        },
                      ],
                    },
              finish_reason: null as string | null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        const ending = {
          ...chunk,
          choices: [
            { index: 0, delta: {}, finish_reason: finished || !tools ? 'stop' : 'tool_calls' },
          ],
        };
        res.end(`data: ${JSON.stringify(ending)}\n\ndata: [DONE]\n\n`);
      });
      try {
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        const port = (server.address() as { port: number }).port;
        fixture.policy.config.model.base_url = `http://127.0.0.1:${port}/v1`;
        fixture.policy.config.providers.fixture.base_url = fixture.policy.config.model.base_url;
        fixture.save();
        const result = await fixture.execute(
          join(hermesAssets, 'bootstrap.py'),
          [
            'chat',
            '--query-file',
            '-',
            '--format',
            'stream-json',
            '--source',
            'tool',
            '--provider',
            'custom:fixture',
            '-m',
            'fixture-model',
            '-t',
            tools ? 'file,skills' : 'none',
          ],
          'Read the fixture canary then answer with exactly {"ok":true}.',
        );
        expect(result.code, JSON.stringify({ ...result, stdout: undefined })).toBe(0);
        expect(result.stdout).toContain('"type": "result"');
        expect(requests).toBe(tools ? 2 : 1);
        expect(
          catalogs.every((list) =>
            list.every((name) => ['read_file', 'search_files', 'skill_view'].includes(name)),
          ),
        ).toBe(true);
        if (tools) expect(results.join('')).toContain('READ CANARY');
        else expect(catalogs).toEqual([[]]);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        fixture.close();
      }
    },
    150_000,
  );
  for (const suite of [
    'Inventory',
    'C',
    'G',
    'P',
    'C-replace',
    'C-candidates',
    'C-moa',
    'P-swap',
    'G-toggle:00',
    'G-toggle:01',
    'G-toggle:10',
    'G-toggle:11',
    'G-fatal',
    'G-import',
  ]) {
    it(`suite ${suite}: protected config/dispatch/reader boundary under actual Low`, async () => {
      const fixture = hermesFixture();
      let requests = 0;
      const server = createServer((req, res) => {
        if (suite === 'C-moa') requests++;
        req.resume();
        if (req.method === 'GET') res.end('{"data":[{"id":"fixture-model"}]}');
        else if (req.url === '/api/show')
          res.end('{"model_info":{"general.context_length":131072}}');
        else {
          requests++;
          res.end('{"error":"No provider request is allowed by this boundary table"}');
        }
      });
      try {
        await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
        const port = (server.address() as { port: number }).port;
        fixture.policy.config.model.base_url = `http://127.0.0.1:${port}/v1`;
        fixture.policy.config.providers.fixture.base_url = fixture.policy.config.model.base_url;
        fixture.save();
        const result = await fixture.execute(
          join(
            import.meta.dirname,
            suite === 'Inventory' ? 'fixtures/hermes/inventory.py' : 'fixtures/hermes/contracts.py',
          ),
          [hermesAssets, suite],
          '',
          (chunk) => {
            if (chunk.includes('REPLACE READY')) {
              const managed = join(fixture.control, 'managed-cases/compatible');
              renameSync(managed, `${managed}-old`);
              mkdirSync(managed);
              writeFileSync(join(managed, 'config.yaml'), '{"plugins":{"enabled":[]}}');
              writeFileSync(join(fixture.run, 'scratch/replaced'), 'ready');
            }
            if (chunk.includes('SWAP READY')) {
              const alias = join(fixture.run, 'aliases/swap');
              rmSync(alias);
              symlinkSync(fixture.control, alias, 'junction');
              writeFileSync(join(fixture.run, 'scratch/swapped'), 'ready');
            }
          },
        );
        expect(result.code, JSON.stringify({ ...result, stdout: undefined })).toBe(
          suite === 'G-fatal' || suite === 'G-import' || suite === 'C-moa' ? 125 : 0,
        );
        if (result.code === 0)
          expect(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')).toMatchObject({
            low: true,
          });
        if (suite === 'C-moa')
          expect(JSON.parse(result.stdout.trim())).toEqual({
            low: true,
            moa: 'absent',
            explicitRoutes: 2,
          });
        if (suite === 'G-fatal') expect(result.durationMs).toBeLessThan(15000);
        expect(requests, 'zero forbidden callback/initialization/provider requests').toBe(0);
        expect(result.stdout).not.toContain('PROTECTED BYTES');
      } finally {
        server.closeAllConnections();
        await new Promise<void>((done) => server.close(() => done()));
        fixture.close();
      }
    }, 150_000);
  }
});
