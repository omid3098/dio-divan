import { seatsOf } from '../src/shared/flow.ts';
// The Pi extension's provider, with the fake harnesses (no model is called): the extension lists `divan/<profile>` models
// from Divan's own settings.json WITHOUT starting Divan; the first request to one starts it (lazily, on the port the settings
// name), and the answer comes back with the council's progress as the model's thinking. Pi runs with a configuration folder
// of its own, so nothing of Omid's is read or changed; the home and the port are ours (a temporary folder, a free port) and
// the server the extension starts is stopped by its PID.
//   node e2e/pi-provider.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killTree, resolveCommand } from '../src/server/proc.ts';
import { isOwnerOnly } from '../src/server/secure.ts';

const root = join(import.meta.dirname, '..');
const base = mkdtempSync(join(tmpdir(), 'divan-pi-'));
const home = join(base, 'home');
const agentDir = join(base, 'pi-agent');
const project = join(base, 'project');
for (const dir of [home, agentDir, project]) mkdirSync(dir, { recursive: true });

// The port Divan will be started on (the extension reads it from settings.json): a free one, never Omid's.
const freePort = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ version: 2, port: freePort, profiles: {} }),
);

// A home an older version made: readable by other accounts, with a key and a state file already in it. The server must
// repair all three at its start, not only make a new home safe.
const icacls = join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'icacls.exe');
const exposeToOthers = (path, folder) => {
  if (process.platform === 'win32') {
    spawnSync(icacls, [path, '/grant', folder ? '*S-1-5-32-545:(OI)(CI)R' : '*S-1-5-32-545:R'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    chmodSync(path, folder ? 0o755 : 0o644);
  }
};
const STALE = '{"token":"stale"}';
writeFileSync(join(home, 'api-key'), 'divan-0123456789abcdef0123456789abcdef\n');
writeFileSync(join(home, 'server.json'), STALE);
for (const [name, folder] of [
  ['', true],
  ['api-key', false],
  ['server.json', false],
]) {
  exposeToOthers(join(home, name), folder);
  assert.equal(isOwnerOnly(join(home, name)), false, `${name || 'the home'} starts exposed`);
}

const piEnv = {
  ...process.env,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: '1',
  DIVAN_HOME: home,
  DIVAN_NO_OPEN: '1',
  // what the server the extension starts lazily inherits: the fake harnesses
  DIVAN_FAKE: '1',
  DIVAN_FAKE_DELAY_MS: '60',
};
const piArgs = [
  '--offline',
  '--no-extensions',
  '-e',
  join(root, 'pi-extension', 'index.ts'),
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
  '--no-mcp',
  '--no-session',
];
function pi(args) {
  // Pi's own script run by node, with the arguments exactly as given (a shell would split the prompt into words).
  const found = resolveCommand('pi');
  if (!found) throw new Error('pi is not installed');
  const result = spawnSync(found.command, [...found.prefix, ...piArgs, ...args], {
    cwd: project,
    env: piEnv,
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

/** Whether something answers on the port the settings name. */
const listening = async () => {
  try {
    await fetch(`http://127.0.0.1:${freePort}/api/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};

try {
  assert.equal(await listening(), false, 'no Divan is running at the start');

  console.log('\n$ pi --list-models divan');
  const listed = pi(['--list-models', 'divan']);
  console.log(listed.out.trim() || listed.err.trim());
  assert.equal(listed.code, 0);
  assert.match(listed.out, /divan\s+default/u);
  assert.match(listed.out, /divan\s+quick/u);
  assert.equal(await listening(), false, 'listing the models did not start Divan');
  assert.equal(
    readFileSync(join(home, 'server.json'), 'utf8'),
    STALE,
    'and wrote nothing of its own',
  );

  console.log(
    '\n$ pi -p --mode json --model divan/default "Which first: a desktop app or a web app?"',
  );
  const asked = pi([
    '-p',
    '--mode',
    'json',
    '--model',
    'divan/default',
    'Which first: a desktop app or a web app?',
  ]);
  assert.equal(asked.code, 0, asked.err);
  assert.equal(
    await listening(),
    true,
    'the first request started Divan, on the port the settings name',
  );
  const state = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
  assert.equal(state.port, freePort);
  console.log(
    `server started by the first request: port ${state.port} (fake harnesses), home ${home}`,
  );
  // the old home was repaired at that start: the folder, the key and the state file (whose token fetches the key)
  for (const name of ['', 'api-key', 'server.json']) {
    assert.equal(
      isOwnerOnly(join(home, name)),
      true,
      `${name || 'the home folder'} is owner-only after the start`,
    );
  }
  console.log(
    'an old, exposed home was repaired: the home folder, api-key and server.json are owner-only',
  );

  const events = asked.out
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  const update = (kind) =>
    events.filter((e) => e.type === 'message_update' && e.assistantMessageEvent?.type === kind);
  const thinking = update('thinking_delta')
    .map((e) => e.assistantMessageEvent.delta)
    .join('');
  const text = update('text_delta')
    .map((e) => e.assistantMessageEvent.delta)
    .join('');
  const last = events
    .filter((e) => e.type === 'message_end' && e.message?.role === 'assistant')
    .at(-1);
  console.log(
    `thinking (the council's progress):\n${thinking
      .trim()
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}`,
  );
  console.log(
    `answer:\n${text
      .trim()
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}`,
  );
  console.log(`usage reported to Pi: ${JSON.stringify(last?.message?.usage)}`);
  assert.match(thinking, /Member [A-D] started/u, 'progress arrives as reasoning');
  assert.match(thinking, /Chairman reading 4 answers/u);
  assert.match(text, /Recommendation/u, 'the chairman’s answer is the reply');
  assert.match(
    text,
    /\[Open in Divan\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)\s*$/u,
    'the closing link, with the round named in its address',
  );
  assert.doesNotMatch(text, /Dio Divan:|ref:/u, 'no log-like line');
  assert.ok((last?.message?.usage?.totalTokens ?? last?.message?.usage?.total ?? 0) > 0, 'usage');

  // the session the endpoint made: from Pi, in Pi's folder, with read-only tools on for the members, at a level
  const response = await fetch(`http://127.0.0.1:${state.port}/api/sessions`, {
    headers: { 'x-divan-token': state.token },
  });
  const [summary] = await response.json();
  assert.equal(summary.origin, 'api');
  assert.equal(summary.client, 'pi');
  const session = await (
    await fetch(`http://127.0.0.1:${state.port}/api/sessions/${summary.id}`, {
      headers: { 'x-divan-token': state.token },
    })
  ).json();
  const chair = Object.values(session.nodes).find((node) => node.kind === 'chair');
  assert.ok(
    chair.cwd?.toLowerCase().endsWith('project'),
    `Pi's folder reached the round: ${chair.cwd}`,
  );
  assert.ok(
    seatsOf(chair).every((seat) => seat.tools),
    'members read with tools on',
  );
  assert.ok(
    ['low', 'medium', 'high', 'max'].includes(session.settings.level),
    'the council ran at a level',
  );
  console.log(
    `\nsession ${summary.id}: origin api, client ${summary.client}, level ${session.settings.level}, folder ${chair.cwd}`,
  );
  console.log('\npi provider check passed');
} catch (error) {
  console.error('pi provider check FAILED:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  // the server the extension started (detached): stopped by its PID, never by name
  try {
    const started = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8'));
    if (typeof started.pid === 'number') await killTree(started.pid);
  } catch {
    // nothing was started
  }
  rmSync(base, { recursive: true, force: true });
}
