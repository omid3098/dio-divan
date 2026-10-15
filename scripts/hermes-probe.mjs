// One launch, no Engine retry. The Medium parent owns both the ledger and the request counter.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withoutT3 } from '../src/server/launch.ts';
import { ownerOnly } from '../src/server/secure.ts';
import { note } from '../src/shared/messages.ts';

// Filled from the independently scanned pack result; this script is not shipped in the archive.
export const FIX12_SHA256 = '9ef6eb0a6a50cdafc00694ea6eeb6961b355156c1ed07ad0fa4871c46bb0ba71';

function failureEvidence(error, stage) {
  // Never retain exception messages: native errors can include config, paths or credentials.
  return {
    stage,
    reason:
      ['hermes_policy', 'hermes_guard', 'hermes_route', 'hermes_cleanup'].find(
        (code) => error?.message === note(code).message,
      ) ??
      (['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError'].includes(error?.name)
        ? error.name
        : 'Error'),
    ...(/^(?:hermes_[a-z_]+|E[A-Z]{2,24})$/u.test(error?.code ?? '') ? { code: error.code } : {}),
    frames: [...String(error?.stack ?? '').matchAll(/[\\/]([\w-]+\.(?:mjs|js|ts)):(\d+):\d+/gu)]
      .slice(0, 8)
      .map((match) => `${match[1]}:${match[2]}`),
  };
}

export async function withProbeSlot(ledger, archiveHash, launch, options = {}) {
  assert.equal(process.platform, 'win32', 'Windows Low is required');
  const folder = dirname(resolve(ledger));
  mkdirSync(folder, { recursive: true });
  ownerOnly(folder, true);
  const lock = `${ledger}.lock`;
  const handle = openSync(lock, 'wx');
  let server;
  try {
    ownerOnly(lock, false);
    const state = existsSync(ledger)
      ? JSON.parse(readFileSync(ledger, 'utf8'))
      : { version: 1, archiveHash, slots: [] };
    assert.equal(state.version, 1);
    assert.equal(state.archiveHash, archiveHash, 'Ledger belongs to another archive');
    assert.ok(
      Array.isArray(state.slots) && state.slots.length < 5,
      'Five-slot allowance exhausted',
    );
    assert.ok(
      state.slots.every(
        (slot) =>
          ['done', 'failed'].includes(slot.state) &&
          Number.isInteger(slot.requests) &&
          slot.requests >= 0 &&
          slot.requests <= 1,
      ),
      'Unresolved attempt count: reconcile before another launch',
    );
    const slot = { state: 'reserved', requests: null, refused: 0, evidence: [] };
    state.slots.push(slot);
    function save() {
      // A torn write fails closed next time; a reservation is never refunded.
      if (!existsSync(ledger)) closeSync(openSync(ledger, 'wx', 0o600));
      ownerOnly(ledger, false);
      writeFileSync(ledger, JSON.stringify(state, null, 2), { flush: true });
    }
    save();
    let requests = 0;
    let refused = 0;
    const token = randomUUID();
    server = createServer(async (req, res) => {
      if (
        req.method !== 'POST' ||
        !['/attempt', '/evidence'].includes(req.url) ||
        req.headers.authorization !== `Bearer ${token}`
      ) {
        req.resume();
        res.writeHead(403).end();
      } else if (req.url === '/evidence') {
        try {
          let body = '';
          for await (const chunk of req) {
            body += chunk;
            assert.ok(Buffer.byteLength(body) <= 128 * 1024);
          }
          assert.ok(options.observe && slot.evidence.length < 10);
          slot.evidence.push(options.observe(JSON.parse(body)));
          save();
          res.end('RECORDED');
        } catch {
          slot.invalidEvidence = true;
          save();
          res.writeHead(403).end();
        }
      } else if (requests >= 1) {
        req.resume();
        refused++;
        slot.refused = refused;
        save();
        res.writeHead(403).end();
      } else {
        req.resume();
        requests++;
        // Persist the count BEFORE authorising the provider send.
        slot.requests = requests;
        save();
        res.end('ALLOW');
      }
    });
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(0, '127.0.0.1', done);
    });
    const port = server.address().port;
    assert.notEqual(port, 47321);
    try {
      const result = await launch({
        url: `http://127.0.0.1:${port}/attempt`,
        token,
        ...(options.observe ? { evidence: true } : {}),
      });
      if (options.recordResult) {
        slot.result = options.recordResult(result);
        assert.ok(Buffer.byteLength(JSON.stringify(slot.result)) <= 4096);
        save();
      }
      const summary = {
        result,
        requests,
        refused,
        evidence: slot.evidence,
        invalidEvidence: slot.invalidEvidence === true,
        slotsUsed: state.slots.length,
      };
      options.verify?.(summary);
      Object.assign(slot, { state: 'done', requests, refused });
      save();
      return summary;
    } catch (error) {
      Object.assign(slot, { state: 'failed', requests, refused });
      slot.failure = slot.result?.failure ?? failureEvidence(error, options.stage?.() ?? 'probe');
      save();
      throw error;
    }
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    closeSync(handle);
    rmSync(lock);
  }
}

const READERS = [
  'read_file',
  'search_files',
  'skill_view',
  ...['whoami', 'search', 'get_page', 'list_pages', 'recent_changes', 'ask'].map(
    (name) => `mcp_memory_${name}`,
  ),
  ...['t3_thread_read', 't3_thread_search', 't3_thread_list'].map((name) => `mcp_t3_${name}`),
  'mcp_hermes_history_hermes_history_search',
  'mcp_hermes_history_hermes_history_read',
];
const TOOL = {
  read: 'read_file',
  memory: 'mcp_memory_search',
  history: 'mcp_hermes_history_hermes_history_search',
};
const equal = (a, b) => {
  try {
    assert.deepEqual(a, b);
    return true;
  } catch {
    return false;
  }
};
function probeContract(input) {
  const probe = input.probe;
  assert.ok(probe && ['startup', 'read', 'memory', 'history'].includes(probe.kind));
  assert.equal(input.tools, ['read', 'history'].includes(probe.kind));
  assert.equal(input.memory, probe.kind === 'memory');
  if (probe.kind === 'startup') return;
  assert.ok(probe.args && typeof probe.expect === (probe.kind === 'history' ? 'object' : 'string'));
  if (probe.kind === 'read') {
    assert.deepEqual(Object.keys(probe.args).sort(), ['limit', 'offset', 'path']);
    assert.equal(probe.args.offset, 1);
    assert.equal(probe.args.limit, 1);
    assert.ok(typeof probe.args.path === 'string' && probe.args.path.length <= 2000);
    assert.ok(
      probe.expect.length > 0 &&
        probe.expect.length <= 200 &&
        ![...probe.expect].some((char) => char.charCodeAt(0) < 32),
    );
  } else {
    assert.deepEqual(Object.keys(probe.args).sort(), ['limit', 'query']);
    assert.equal(probe.args.limit, probe.kind === 'memory' ? 5 : 1);
    assert.ok(
      typeof probe.args.query === 'string' &&
        probe.args.query.length >= 2 &&
        probe.args.query.length <= 200,
    );
    if (probe.kind === 'memory') assert.match(probe.expect, /^[a-zA-Z0-9_/-]{1,200}$/u);
    else {
      assert.deepEqual(Object.keys(probe.expect).sort(), ['id', 'title']);
      for (const value of Object.values(probe.expect))
        assert.ok(
          typeof value === 'string' &&
            value.length > 0 &&
            value.length <= 200 &&
            ![...value].some((char) => char.charCodeAt(0) < 32),
        );
    }
  }
}
function observeProbe(probe, event) {
  if (event.type === 'catalog') {
    assert.ok(Array.isArray(event.names) && event.names.length <= READERS.length);
    const writersAbsent = event.names.every((name) => READERS.includes(name));
    return {
      type: 'catalog',
      names: event.names.filter((name) => READERS.includes(name)),
      writersAbsent,
      expectedPresent:
        probe.kind === 'startup'
          ? event.names.length === 0
          : event.names.includes(TOOL[probe.kind]),
    };
  }
  assert.equal(event.type, 'tool');
  const named = event.name === TOOL[probe.kind];
  const argumentsAllowed = named && equal(event.args, probe.args);
  let decisive = null;
  if (argumentsAllowed && event.denied === false) {
    let value = typeof event.result === 'string' ? JSON.parse(event.result) : event.result;
    assert.ok(value && typeof value === 'object' && !value.error && !value.isError);
    if (Array.isArray(value.content)) {
      assert.equal(value.content.length, 1);
      assert.equal(value.content[0].type, 'text');
      value = JSON.parse(value.content[0].text);
    }
    if (probe.kind === 'read' && value.content === probe.expect) decisive = probe.expect;
    const pages = Array.isArray(value) ? value : value.results;
    if (
      probe.kind === 'memory' &&
      Array.isArray(pages) &&
      pages.some((row) => row.slug === probe.expect)
    )
      decisive = probe.expect;
    if (
      probe.kind === 'history' &&
      Array.isArray(value.rows) &&
      value.rows.some((row) => row.id === probe.expect.id && row.title === probe.expect.title)
    )
      decisive = probe.expect;
  }
  return {
    type: 'tool',
    name: named ? TOOL[probe.kind] : 'unexpected',
    argumentsAllowed,
    ...(argumentsAllowed ? { args: probe.args } : {}),
    decisive,
    denied: event.denied === true,
  };
}
function verifyProbe(probe, summary) {
  assert.equal(summary.invalidEvidence, false);
  assert.equal(summary.requests, 1);
  const result = summary.result;
  assert.equal(result.cancelled || result.timedOut || result.spawnError, false);
  const catalogs = summary.evidence.filter((item) => item.type === 'catalog');
  assert.equal(catalogs.length, probe.kind === 'startup' ? 1 : 2);
  assert.ok(catalogs.every((item) => item.writersAbsent && item.expectedPresent));
  const actions = summary.evidence.filter((item) => item.type === 'tool');
  if (probe.kind === 'startup') {
    assert.equal(summary.refused, 0);
    assert.equal(result.code, 0);
    assert.equal(result.normal, true);
    assert.equal(result.ready, true);
    assert.equal(actions.length, 0);
  } else {
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, TOOL[probe.kind]);
    assert.equal(actions[0].argumentsAllowed, true);
    assert.deepEqual(actions[0].decisive, probe.expect);
    assert.equal(actions[0].denied, false);
    assert.equal(summary.refused, 1);
    assert.equal(result.code, 125);
    assert.equal(result.normal, false);
  }
}

async function main() {
  const root = resolve(import.meta.dirname, '..');
  const [inputFile] = process.argv.slice(2);
  assert.ok(inputFile, 'Pass a reviewed probe JSON file');
  const input = JSON.parse(readFileSync(inputFile, 'utf8'));
  const fake = process.argv.includes('--fake-provider');
  const archive = join(root, '.evidence/npm-pack/fix12/dio-divan-0.1.0.tgz');
  assert.equal(
    createHash('sha256').update(readFileSync(archive)).digest('hex'),
    FIX12_SHA256,
    'Wrong fix12 archive',
  );
  const stage0 = JSON.parse(
    readFileSync(fake ? input.stage0 : join(root, '.evidence/fix12-stage0.json'), 'utf8'),
  );
  assert.equal(stage0.sha256, FIX12_SHA256);
  assert.equal(
    stage0.driverSha256,
    createHash('sha256')
      .update(readFileSync(fileURLToPath(import.meta.url)))
      .digest('hex'),
  );
  for (const gate of fake
    ? ['syntheticFixture']
    : ['inventory', 'focused', 'installed', 'artifactScan', 'lowCanary', 'reviewAccepted'])
    assert.equal(stage0[gate], true, `Stage-0 gate missing: ${gate}`);
  assert.equal(process.platform, 'win32');
  assert.ok(input.root && input.home && input.routeId && input.ledger && input.prompt);
  assert.equal(input.web, false);
  assert.equal(typeof input.tools, 'boolean');
  assert.equal(typeof input.memory, 'boolean');
  probeContract(input);
  if (fake) {
    for (const [path, parent] of [
      [input.root, join(tmpdir(), 'divan-hermes-lab')],
      [input.home, tmpdir()],
    ]) {
      const canonical = realpathSync(path).toLowerCase();
      assert.ok(canonical.startsWith(`${realpathSync(parent).toLowerCase()}\\`));
    }
  }
  const privateHome = mkdtempSync(join(tmpdir(), 'divan-hermes-probe-'));
  ownerOnly(privateHome, true);
  const previous = process.env.DIVAN_HOME;
  process.env.DIVAN_HOME = privateHome;
  process.env.DIVAN_NO_OPEN = '1';
  process.env.DIVAN_PORT = '0';
  try {
    const entries = spawnSync('tar', ['-tzf', archive], { windowsHide: true, encoding: 'utf8' });
    assert.equal(entries.status, 0);
    const files = entries.stdout.trim().split(/\r?\n/u);
    assert.equal(files.length, stage0.fileCount);
    assert.ok(
      files.every((file) => file.startsWith('package/') && !file.split('/').includes('..')),
    );
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', privateHome], { windowsHide: true });
    assert.equal(unpack.status, 0);
    const packed = (file) => pathToFileURL(join(privateHome, 'package/dist/server', file)).href;
    const { discoverHermes } = await import(packed('adapters/hermes-install.js'));
    const { prepareHermes } = await import(packed('adapters/hermes-run.js'));
    const { hermesAdapter } = await import(packed('adapters/hermes.js'));
    const { runProc } = await import(packed('proc.js'));
    const ledgerFolder = dirname(resolve(input.ledger));
    mkdirSync(ledgerFolder, { recursive: true });
    ownerOnly(ledgerFolder, true);
    // Keep the protected compilation cache with the parent ledger, outside the disposable Low run.
    process.env.DIVAN_HOME = ledgerFolder;
    const found = await discoverHermes(input.root, input.home);
    process.env.DIVAN_HOME = privateHome;
    if (found.problem)
      throw Object.assign(new Error('Discovery failed'), { code: found.problem.code });
    assert.ok(found.layout);
    if (input.memory) assert.ok(found.memory, 'Read-only memory route missing');
    const route = found.routes.find((item) => item.id === input.routeId);
    assert.ok(route, 'Exact reviewed route missing; no substitution');
    if (fake) {
      const loopback = (value) => {
        const url = new URL(value);
        assert.equal(url.protocol, 'http:');
        assert.equal(url.hostname, '127.0.0.1');
        assert.ok(url.port && url.port !== '47321');
      };
      loopback(route.endpoint);
      assert.equal(route.keyEnv, 'LAB_KEY');
      if (input.memory) {
        loopback(found.memory.url);
        assert.equal(found.memory.headerEnv, 'LAB_MEMORY_KEY');
      }
    }
    assert.equal(realpathSync(ledgerFolder).toLowerCase(), ledgerFolder.toLowerCase());
    const medium = spawnSync(
      found.layout.basePython,
      [
        '-I',
        '-S',
        '-B',
        '-c',
        'import sys;sys.path.insert(0,sys.argv[1]);from windows import protected;from pathlib import Path; p=Path(sys.argv[2]);protected(p,directory=True); f=p/sys.argv[3]; protected(f,directory=False) if f.exists() else None',
        join(privateHome, 'package/dist/server/adapters/hermes'),
        ledgerFolder,
        input.ledger.split(/[\\/]/u).at(-1),
      ],
      { env: withoutT3(process.env), windowsHide: true, encoding: 'utf8' },
    );
    assert.equal(medium.status, 0, 'Ledger and all ancestors must be protected from Low writes');
    const spec = {
      harness: 'hermes',
      model: route.id,
      effort: 'low',
      tools: input.tools,
      memory: input.memory,
      web: false,
      prompt: input.prompt,
      schema: {},
      idleMs: 600_000,
    };
    let stage = 'preparation';
    const summary = await withProbeSlot(
      resolve(input.ledger),
      FIX12_SHA256,
      async (attemptCounter) => {
        const prepared = prepareHermes(found.layout, route, spec, found.memory);
        try {
          const policy = JSON.parse(readFileSync(prepared.policyFile, 'utf8'));
          policy.attemptCounter = attemptCounter;
          writeFileSync(prepared.policyFile, JSON.stringify(policy));
          stage = 'launcher';
          const result = await runProc({
            command: found.layout.basePython,
            args: prepared.args,
            cwd: prepared.control,
            env: prepared.env,
            envMode: 'replace',
            stdin: input.prompt,
            idleMs: spec.idleMs,
          });
          const guardStage = /^Divan Hermes guard failure: ([a-z]+)$/mu.exec(result.stderr)?.[1];
          const kind = /^Divan Hermes failure kind: ([A-Za-z]+)$/mu.exec(result.stderr)?.[1];
          const failure = {
            stage: guardStage ? `bootstrap:${guardStage}` : stage,
            reason: result.spawnError
              ? 'spawn_failed'
              : result.timedOut
                ? 'timed_out'
                : (kind ?? 'process_failed'),
            exitCode: result.code,
          };
          stage = 'verification';
          const parsed = hermesAdapter.parse(result, spec);
          return {
            code: result.code,
            usage: parsed.usage,
            ready: parsed.text.trim() === 'READY',
            normal: parsed.error === null,
            cancelled: result.cancelled,
            timedOut: result.timedOut,
            spawnError: result.spawnError !== null,
            ...(result.code !== 0 || result.spawnError || result.timedOut ? { failure } : {}),
          };
        } finally {
          prepared.cleanup();
        }
      },
      {
        stage: () => stage,
        recordResult: (result) => result,
        observe: (event) => observeProbe(input.probe, event),
        verify: (summary) => verifyProbe(input.probe, summary),
      },
    );
    console.log(JSON.stringify(summary));
  } finally {
    if (previous === undefined) delete process.env.DIVAN_HOME;
    else process.env.DIVAN_HOME = previous;
    rmSync(privateHome, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const line = /hermes-probe\.mjs:(\d+)/u.exec(error.stack ?? '')?.[1] ?? '?';
    const code = /^hermes_[a-z_]+$/u.test(error.code ?? '') ? `, ${error.code}` : '';
    console.error(
      `Hermes probe refused or failed (driver line ${line}${code}); inspect the parent ledger. No automatic retry.`,
    );
    process.exitCode = 1;
  });
}
