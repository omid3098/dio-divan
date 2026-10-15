import { chairmanOf, seatsOf } from '../src/shared/flow.ts';
// ONE real round through the web interface, with the REAL harnesses (it costs Omid's subscriptions): the `quick` profile is
// picked in setup, the question typed and «شروع سشن» pressed, in a headless browser. It starts the real Divan server
// with a folder of its own (.evidence/home), records the time and the tokens, and saves screenshots and report.json under
// .evidence/. Nothing here opens a window or touches Omid's Chrome or his real Dio Divan folder.
//   node e2e/acceptance.mjs

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { killTree } from '../src/server/proc.ts';
import { openBrowser } from './harness.mjs';

const root = join(import.meta.dirname, '..');
const evidence = join(root, '.evidence');
const home = join(evidence, 'home');
const raw = join(evidence, 'raw');
// What the earlier real rounds learned about this PC's accounts (a model out of balance) is kept, as a real home would.
const memory = join(evidence, 'unavailable.keep.json');
if (existsSync(join(home, 'unavailable.json'))) {
  copyFileSync(join(home, 'unavailable.json'), memory);
}
rmSync(home, { recursive: true, force: true });
rmSync(raw, { recursive: true, force: true });
mkdirSync(home, { recursive: true });
mkdirSync(raw, { recursive: true });
if (existsSync(memory)) copyFileSync(memory, join(home, 'unavailable.json'));

const QUESTION =
  'تیم ما دو نفره است و بودجهٔ کمی داریم. می‌خواهیم یک ابزار مدیریت وظایف برای فریلنسرها بسازیم. برای نسخهٔ اول، اپ دسکتاپ با Electron بسازیم یا یک وب‌اپ ساده؟ کدام را انتخاب کنیم و چرا؟';

const server = spawn(
  process.execPath,
  [join(root, 'bin', 'dio-divan.mjs'), 'serve', '--port', '0'],
  {
    env: {
      ...process.env,
      DIVAN_HOME: home,
      DIVAN_DUMP_DIR: raw,
      DIVAN_NO_OPEN: '1',
      DIVAN_FAKE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  },
);
let url = '';
let out = '';
server.stdout.on('data', (chunk) => {
  out += chunk;
  const found = /(http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+)/u.exec(out);
  if (found) url = found[1];
});
server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
for (let i = 0; i < 100 && !url; i += 1) await new Promise((r) => setTimeout(r, 100));
if (!url) {
  await killTree(server.pid);
  throw new Error('the server did not print its URL');
}
const base = new URL(url);
const token = /token=([a-f0-9]+)/u.exec(url)[1];
const web = async (path) =>
  (await fetch(`${base.origin}/api${path}`, { headers: { 'x-divan-token': token } })).json();
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const shot = (page, name, options = {}) =>
  page.screenshot({ path: join(evidence, `${name}.png`), ...options });
const seconds = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 1000 : null);

const report = { question: QUESTION };
let browser = null;
try {
  browser = await openBrowser({ viewport: { width: 1440, height: 900 }, theme: 'light' });
  const { page } = browser;
  await page.goto(url);
  await page.waitForSelector('[data-testid=home]');
  // the council is chosen on Home (the web app shows it; it is edited on the Councils page): the quick one, at its own level
  await page.getByTestId('council-select').click();
  await page
    .locator('[data-slot=select-content][data-open]')
    .getByRole('option', { name: /Quick/u })
    .click();
  await page.waitForTimeout(800);
  await page.fill('#question', QUESTION);
  const meta = await web('/meta');
  const quick = meta.settings.profiles.find((item) => item.id === 'quick');
  report.quickProfile = {
    revision: quick.revision,
    seats: quick.effective.seats.map((seat) => ({
      harness: seat.harness,
      model: seat.model,
      effort: seat.effort,
      enabled: seat.enabled,
      tools: seat.tools,
    })),
    chairman: quick.effective.chairman,
    notes: [...meta.settings.notes, ...quick.notes],
  };
  // a quick that cannot run here (no family of its own for the chairman) is not started: nothing real is called
  if (quick.blocked) throw new Error(`quick cannot run on this PC: ${quick.blocked}`);
  report.chips = await page.locator('[data-testid=council-seats] li').allInnerTexts();
  await shot(page, '20-setup-quick');
  log(`quick profile: ${report.chips.join(' | ').replace(/\s+/gu, ' ')}`);

  log('starting the round from the interface (real harnesses)');
  const started = Date.now();
  await page.click('[data-testid=start]');
  await page.waitForSelector('[data-testid=editor]');
  await page.waitForSelector('[data-testid=waiting]');
  await page.waitForTimeout(9000);
  report.whileRunning = {
    elapsedShown: await page.getByTestId('elapsed').innerText(),
    waiting: (await page.getByTestId('waiting').innerText()).replace(/\s+/gu, ' '),
    answeredLine: (await page.getByTestId('answered-count').innerText()).trim(),
  };
  await shot(page, '21-round-running');
  const id = (await web('/sessions'))[0].id;
  let session;
  for (;;) {
    session = await web(`/sessions/${id}`);
    if (!Object.values(session.nodes).some((n) => n.kind === 'chair' && n.status === 'running'))
      break;
    if (Date.now() - started > 600_000) throw new Error('the round did not finish in time');
    await new Promise((r) => setTimeout(r, 1500));
  }
  const wall = (Date.now() - started) / 1000;
  await page.waitForSelector('[data-testid=answer]');
  await page.waitForTimeout(1000);
  await shot(page, '22-round-done');
  const chair = Object.values(session.nodes).find((node) => node.kind === 'chair');
  log(`round: ${chair.status} in ${wall.toFixed(0)} s, usage ${JSON.stringify(chair.usage)}`);
  report.round = {
    status: chair.status,
    wallClockSeconds: wall,
    usage: chair.usage,
    answeredLine: (await page.getByTestId('answered-count').innerText()).trim(),
    title: chair.title,
    answerWords: chair.answer.split(/\s+/u).length,
    seats: seatsOf(chair).map((seat) => ({
      harness: seat.harness,
      model: seat.model,
      effort: seat.effort,
      tools: seat.tools,
      state: seat.state,
      error: seat.error ? String(seat.error).slice(0, 200) : null,
      seconds: seconds(seat.startedAt, seat.endedAt),
      usage: seat.usage,
    })),
    chairman: {
      harness: chairmanOf(chair).harness,
      model: chairmanOf(chair).model,
      effort: chairmanOf(chair).effort,
      state: chairmanOf(chair).state,
      seconds: seconds(chairmanOf(chair).startedAt, chairmanOf(chair).endedAt),
      usage: chairmanOf(chair).usage,
    },
    attempts: chair.attempts.length,
  };
  report.pageErrors = browser.errors;
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  log('done; evidence saved');
} catch (error) {
  console.error('acceptance FAILED:', error instanceof Error ? error.message : error);
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await killTree(server.pid);
}
