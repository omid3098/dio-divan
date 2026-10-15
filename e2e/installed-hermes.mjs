// Installed JavaScript/Python only; the selected installation and keys are disposable fixtures.
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hermesFixture } from '../tests/helpers/hermes.ts';

export async function installedHermes(pkg) {
  // The run needs a disposable copy of a supported installation (tests/helpers/hermes.ts); CI has none.
  if (process.platform !== 'win32' || !process.env.HERMES_TEST_LAYOUT) return false;
  const fixture = hermesFixture();
  const names = [
    'LOCALAPPDATA',
    'HERMES_HOME',
    'HERMES_MANAGED_DIR',
    'DIVAN_HOME',
    'LAB_KEY',
    'DIVAN_T3_DB',
  ];
  const saved = names.map((name) => process.env[name]);
  const local = join(fixture.temp, 'local');
  mkdirSync(local);
  symlinkSync(fixture.policy.root, join(local, 'hermes'), 'junction');
  Object.assign(process.env, {
    LOCALAPPDATA: local,
    HERMES_HOME: fixture.policy.home,
    HERMES_MANAGED_DIR: fixture.policy.managed,
    DIVAN_HOME: fixture.temp,
    LAB_KEY: 'synthetic-fixture-key',
    DIVAN_T3_DB: join(fixture.temp, 'missing.sqlite'),
  });
  let requests = 0;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.end('{"data":[{"id":"fixture-model"}]}');
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/api/show') {
      res.end('{"model_info":{"general.context_length":131072}}');
      return;
    }
    const request = JSON.parse(body);
    assert.deepEqual(request.tools ?? [], []);
    requests++;
    const response = {
      id: 'synthetic',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: { content: '{"ok":true}' }, finish_reason: null }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(
      `data: ${JSON.stringify(response)}\n\ndata: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
    fixture.policy.config.model.base_url = endpoint;
    fixture.policy.config.providers.fixture.base_url = endpoint;
    writeFileSync(join(fixture.policy.home, 'config.yaml'), JSON.stringify(fixture.policy.config));
    const { hermesAdapter } = await import(
      pathToFileURL(join(pkg, 'dist/server/adapters/hermes.js')).href
    );
    const { runWithAdapter } = await import(
      pathToFileURL(join(pkg, 'dist/server/adapters/index.js')).href
    );
    const models = await hermesAdapter.listModels();
    assert.equal(models.note, null);
    const result = await runWithAdapter(hermesAdapter, {
      harness: 'hermes',
      model: models.models[0].id,
      effort: '',
      tools: false,
      memory: false,
      web: false,
      idleMs: 60000,
      prompt: 'Return exactly {"ok":true}.',
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    });
    assert.equal(result.error, null);
    assert.deepEqual(JSON.parse(result.text), { ok: true });
    assert.equal(requests, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(() => done()));
    names.forEach((name, index) => {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    });
    fixture.close();
  }
  return true;
}
