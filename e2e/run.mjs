import { chairmanOf, seatsOf } from '../src/shared/flow.ts';
// End to end, with the fake harnesses, through the real server and a headless browser: the shadcn interface from Home to the
// map. It starts a session from Home (the council and its level chosen there), edits a council on the Councils page (explicit
// save, 409, a failed save, the leave guard, levels), reads the answer, opens the details drawer (and checks that no identity
// is ever in the page while names are hidden), answers the chairman's questions, branches, edits an input, stops a round and
// stops waiting for a member, then checks Sessions, Connect, Settings (language and theme), the 900 / 1100 / 1400 px layouts
// and the Persian (right to left) interface. Nothing here calls a real model.
//   node e2e/run.mjs        (build the web editor first: pnpm build)

import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeModels } from '../src/server/adapters/fake.ts';
import { HARNESS_LABEL, HARNESS_ORDER } from '../src/shared/defaults.ts';
import { branchFlow, branchLibrary, flowInput, writerFlow } from '../tests/fixtures/flows.ts';
import { launch } from './harness.mjs';

// a member that is silent is stopped when the idle window passes: here it is three seconds, not ten minutes
process.env.DIVAN_IDLE_MS = '3000';
// the fake harnesses report a real call's tokens (about 15k of overhead each, a round of about 100k); most of this run asks
// many rounds of one session, so it runs at a tenth of that, and the section about the real scale sets it back
process.env.DIVAN_FAKE_USAGE = '0.1';

const inventory = (ids) => ({
  status: ids.map((id) => ({ id, installed: true, usable: true, note: null })),
  models: ids.map(fakeModels),
  detectedAt: '',
});
process.env.DIVAN_FAKE_DETECTION = JSON.stringify(
  inventory(HARNESS_ORDER.filter((id) => id !== 'hermes')),
);

const app = await launch({ viewport: { width: 1440, height: 900 } });
const { page, server } = app;
const origin = new URL(server.url).origin;
const headers = { 'x-divan-token': server.token, 'content-type': 'application/json' };
const call = async (path, method = 'GET', body) => {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return response.json();
};
const sessions = () => call('/sessions');
/** One profile as the server has it (the `default` one unless named). */
const profileOf = async (id = 'default') =>
  (await call('/meta')).settings.profiles.find((item) => item.id === id);
const sessionOf = async (id) => call(`/sessions/${id ?? (await sessions())[0].id}`);
const chairs = (session) =>
  Object.values(session.nodes)
    .filter((node) => node.kind === 'chair')
    .sort((a, b) => a.round - b.round);
const step = (name) => console.log(`- ${name}`);
const go = async (hash) => {
  await page.evaluate((value) => {
    window.location.hash = value;
  }, hash);
  await page.waitForTimeout(250);
};
const seat = (id, harness, model, tools = false) => ({
  id,
  enabled: true,
  harness,
  model,
  effort: '',
  tools,
  memory: false,
  web: false,
});
const budgets = { maxClaims: 5, maxWords: 30 };
const make = (question, seats, chairman = { harness: 'pi', model: 'fake-2', effort: '' }) =>
  call('/sessions', 'POST', { question, seats, chairman, budgets });

/** Polls `check` (which may be async) until it is truthy. */
async function until(check, timeout = 15_000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end)
      throw new Error(`timed out waiting for: ${check.toString().slice(0, 140)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** The page is quiet: no round is running in the editor. */
async function idle(timeout = 30_000) {
  await page.waitForFunction(
    () => !document.querySelector('[data-testid=editor][data-running]'),
    null,
    { timeout },
  );
  await page.waitForTimeout(300);
}

/**
 * Deletes a session; when the page has it open it leaves for Home by itself, and that is waited for (a later move of the test
 * would otherwise be overtaken by it).
 */
async function drop(id) {
  const open = await page.evaluate((value) => window.location.hash.includes(value), id);
  await call(`/sessions/${id}`, 'DELETE');
  if (open)
    await page.waitForFunction(() => window.location.hash === '#/', null, { timeout: 8000 });
}

/** Picks an option of a shadcn Select by its trigger's test id. */
async function pick(testid, name) {
  await page.getByTestId(testid).click();
  // a list that was closed stays in the page (at no height): only the open one is searched
  await page
    .locator('[data-slot=select-content][data-open]')
    .getByRole('option', { name, exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector('[data-slot=select-content][data-open]'),
  );
}

/** Selects a box of the Councils canvas (a member by its seat id, `chairman`, an agent of a design) and waits for its inspector. */
async function box(id) {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await page.waitForFunction(
    (value) =>
      document
        .querySelector('[data-testid=inspector-agent], [data-testid=inspector-level]')
        ?.getAttribute('data-agent-id') === value,
    id,
  );
}
/** Selects a box and picks a model for it. */
async function pickModel(id, name) {
  await box(id);
  await pick('agent-model', name);
}
/** The model a box shows in its inspector. */
async function modelOf(id) {
  await box(id);
  return page.getByTestId('agent-model').innerText();
}
/** The sheet with the settings of the whole council. */
async function openSettings() {
  await page.getByTestId('council-settings').click();
  await page.getByTestId('council-settings-sheet').waitFor();
}
async function closeSettings() {
  await page.keyboard.press('Escape');
  await page.getByTestId('council-settings-sheet').waitFor({ state: 'detached' });
}

try {
  // ====================================================================================================================
  step(
    'Home: the question first; an empty ask says what is missing; the council is shown, not edited',
  );
  await page.waitForSelector('[data-testid=home]');
  assert.notEqual(await page.getByTestId('connection').getAttribute('data-state'), 'down');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
  assert.match(
    await page.locator('label[for=question]').innerText(),
    /What do you need to decide\?/u,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'question',
    'the question has the focus',
  );
  assert.equal(
    await page.getByRole('button', { name: /Adjust/u }).count(),
    0,
    'no session-only Adjust',
  );
  assert.equal(await page.getByText('(changed)').count(), 0, 'no «(changed)» marker');
  assert.match(await page.getByTestId('council-card').innerText(), /4 assistants answer blind/u);
  assert.equal(
    (
      await page.locator('[data-testid=council-seats] li [data-testid=seat-name]').allInnerTexts()
    ).join(','),
    'Claude Code,Codex,Grok,Pi',
  );
  assert.match(await page.getByTestId('council-chair').innerText(), /Chair: Pi/u);
  // no estimate and no cap: nothing is asked of /api/estimate, no budget is shown, and with no round measured yet there is
  // no «usually» line either
  const estimateAsks = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/estimate')) estimateAsks.push(request.url());
  });
  assert.equal(await page.getByTestId('usual').count(), 0, 'no round measured yet: no usual time');
  assert.equal(await page.getByText(/session budget/u).count(), 0, 'no budget, no estimate');
  assert.equal(await page.getByTestId('start').isEnabled(), true, 'the button is on at rest');
  await page.getByTestId('start').click();
  assert.match(
    await page.getByTestId('question-error').innerText(),
    /Write your question first\./u,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'question',
    'and the field has the focus again',
  );
  assert.equal((await sessions()).length, 0, 'nothing started');
  // Ctrl+Enter works from anywhere on the page: from a level button, an empty question takes the cursor and says so
  await page.getByTestId('level-low').click();
  await page.getByTestId('level-medium').click();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'level-medium',
    'the focus is on a button, not in a text box',
  );
  // the message from the click above is cleared by typing, so the one from the key is the one that is seen
  await page.fill('#question', 'x');
  await page.fill('#question', '');
  assert.equal(await page.getByTestId('question-error').count(), 0);
  await page.getByTestId('level-medium').focus();
  await page.keyboard.press('Control+Enter');
  await page.getByTestId('question-error').waitFor();
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'question',
    'an empty question takes the cursor',
  );
  assert.equal((await sessions()).length, 0, 'and nothing started');
  // the level is a plain choice, with no number behind it
  await page.getByTestId('level-max').click();
  await page.getByTestId('level-medium').click();
  // a draft survives a reload
  await page.fill('#question', 'A draft that must not be lost');
  await page.fill('#context', 'Two people, six months');
  await page.reload();
  await page.waitForSelector('[data-testid=home]');
  assert.equal(await page.inputValue('#question'), 'A draft that must not be lost');
  assert.equal(await page.inputValue('#context'), 'Two people, six months');
  assert.equal(estimateAsks.length, 0, 'the page never asked the server for an estimate');
  await page.fill('#question', '');
  await page.fill('#context', '');
  await page.evaluate(() => {
    sessionStorage.removeItem('divan-question');
    sessionStorage.removeItem('divan-context');
  });

  // ====================================================================================================================
  step(
    'Home → Edit this council: the Councils page opens on that level; nothing is edited on Home',
  );
  await page.getByTestId('level-low').click();
  await page.getByTestId('edit-council').click();
  await page.waitForSelector('[data-testid=council-editor]');
  assert.equal(
    await page.getByTestId('tab-low').getAttribute('aria-selected'),
    'true',
    'the level that was chosen is open',
  );
  // a council opens on the canvas, drawn like a design; what belongs to the whole council waits in a sheet
  assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
  assert.match(await page.getByTestId('mode-badge').innerText(), /^Council$/u);
  await openSettings();
  assert.match(
    await page.getByTestId('profile-describe').innerText(),
    /The assistants and the chairman that answer when you ask with this model\./u,
  );
  assert.match(
    await page.getByTestId('profile-more-text').innerText(),
    /saved into this model, for everything that uses it/u,
  );
  await closeSettings();
  await page.getByTestId('tab-base').click();
  await page.waitForSelector('.react-flow__edge', { state: 'attached' });
  assert.equal(await page.getByTestId('seat-list').count(), 0, 'no list of members');
  assert.equal(
    await page.locator('[data-testid=design-node][data-form=member]').count(),
    4,
    'four members',
  );
  assert.equal(
    await page.locator('[data-testid=design-node][data-form=answer]').count(),
    1,
    'and the chairman',
  );
  assert.equal(
    await page.locator('[data-testid=design-node][data-kind]').count(),
    2,
    'Input and Output',
  );
  await box('claude');
  assert.equal(await page.getByTestId('agent-effort').count(), 0, 'the base has no effort');
  assert.equal(
    await page.getByTestId('no-base-effort').count(),
    1,
    'the base council has no effort: each level sets it',
  );
  await box('chairman');
  assert.equal(await page.getByTestId('agent-tools').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByTestId('agent-memory').count(), 1, 'Tools beside Memory');
  assert.equal(await page.getByTestId('agent-web').count(), 0, 'the council final never has web');
  await page.getByTestId('agent-tools').click();
  assert.equal(await page.getByTestId('agent-tools').getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page.getByTestId('design-dialog').count(),
    0,
    'chairman access keeps a council',
  );
  await page.getByTestId('cancel-changes').click();
  assert.equal(await page.getByTestId('agent-tools').getAttribute('aria-pressed'), 'true');
  for (const harness of ['Codex', 'Grok']) {
    await pick('agent-harness', harness);
    assert.equal(await page.getByTestId('agent-tools').isDisabled(), true);
    assert.equal(await page.getByTestId('agent-tools').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.getByTestId('agent-tools').getAttribute('title'), 'the forced-on reason');
    await page.getByTestId('cancel-changes').click();
  }
  await box('claude');

  step(
    'Councils: a change stays on the page until a button saves it; discard puts it back; «Saved» comes after the server has it',
  );
  const revisionBefore = (await profileOf()).revision;
  assert.equal(await page.getByTestId('dirty-marker').count(), 0, 'nothing unsaved at first');
  await pickModel('claude', 'fake-slow');
  await page.getByTestId('dirty-marker').waitFor();
  assert.match(
    await page.getByTestId('save-profile').innerText(),
    /^Save “.+”$/u,
    'the button names the council',
  );
  assert.equal((await page.getByTestId('cancel-changes').innerText()).trim(), 'Discard changes');
  await page.waitForTimeout(1200);
  assert.equal((await profileOf()).revision, revisionBefore, 'nothing is sent by itself');
  await page.getByTestId('cancel-changes').click();
  assert.match(await modelOf('claude'), /fake-1/u, 'discard puts the form back');
  assert.equal(await page.getByTestId('dirty-marker').count(), 0);
  await pickModel('claude', 'fake-slow');
  await page.getByTestId('save-profile').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=save-cue]')?.dataset.cue === 'saved',
  );
  assert.equal(
    (await page.getByTestId('save-cue').innerText()).trim(),
    'Saved. New sessions use it; sessions already started keep the model they started with.',
    'a save says what it touches',
  );
  const saved = await profileOf();
  assert.deepEqual(Object.keys(saved.overrides), ['seats']);
  assert.deepEqual(saved.overrides.seats, { claude: { model: 'fake-slow' } });
  assert.equal(saved.revision, revisionBefore + 1);
  await page.reload();
  await page.waitForSelector('[data-testid=council-editor]');
  await page.getByTestId('tab-base').click();
  assert.match(await modelOf('claude'), /fake-slow/u, 'it persisted');

  step('Councils: Reset asks first, says what is lost, and then saves the defaults');
  await openSettings();
  await page.getByTestId('reset-profile').click();
  assert.match(await page.getByTestId('confirm-dialog').innerText(), /cannot be undone/u);
  await page.getByTestId('confirm-cancel').click();
  assert.match(await modelOf('claude'), /fake-slow/u, 'cancel keeps the change');
  await openSettings();
  await page.getByTestId('reset-profile').click();
  await page.getByTestId('confirm-reset').click();
  await until(async () => Object.keys((await profileOf()).overrides).length === 0);
  assert.equal(await page.getByTestId('dirty-marker').count(), 0, 'and it is saved, not pending');

  step(
    'Councils: a level overrides one member for that level only; the row says so; the base is locked meanwhile',
  );
  await page.getByTestId('tab-high').click();
  assert.equal(await page.getByTestId('flow-designer').getAttribute('data-level'), 'high');
  assert.equal(
    await page.getByTestId('level-overrides').innerText(),
    'Nothing is overridden at this level.',
  );
  await box('codex');
  assert.equal(await page.getByTestId('origin').count(), 0, 'nothing says overridden yet');
  await pick('level-agent-effort', 'low');
  await page.getByTestId('dirty-marker').waitFor();
  assert.match(await page.getByTestId('inspector-level').innerText(), /Overridden/u);
  assert.equal(await page.getByTestId('level-overrides').innerText(), '1 override at this level.');
  await page.getByTestId('tab-base').click();
  await page.getByTestId('levels-first').waitFor();
  assert.equal(
    await page.getByTestId('agent-model').isDisabled(),
    true,
    'the base cannot be edited while a level has unsaved changes',
  );
  await page.getByTestId('tab-high').click();
  await page.getByTestId('save-profile').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=save-cue]')?.dataset.cue === 'saved',
  );
  const withLevel = await profileOf();
  assert.deepEqual(withLevel.levels.high.overrides.seats, { codex: { effort: 'low' } });
  assert.equal(
    withLevel.levels.high.effective.seats.find((item) => item.id === 'codex').effort,
    'low',
  );
  assert.equal(
    withLevel.levels.medium.effective.seats.find((item) => item.id === 'codex').effort,
    'medium',
    'other levels are untouched',
  );
  assert.equal(
    withLevel.effective.seats.find((item) => item.id === 'codex').effort,
    withLevel.defaults.seats.find((item) => item.id === 'codex').effort,
    'and so is the base council',
  );
  await page.getByTestId('reset-level').click();
  await page.getByTestId('save-profile').click();
  await until(async () => !(await profileOf()).levels.high.overrides.seats);

  step(
    'Councils: another page saved first: the save is refused (409), the edits stay until «Reload» (which asks)',
  );
  await page.getByTestId('tab-base').click();
  const current = await profileOf();
  await pickModel('claude', 'fake-slow');
  const other = await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      overrides: { budgets: { maxWords: 17 } },
      ifRevision: current.revision,
      ifFingerprint: current.fingerprint,
    }),
  });
  assert.equal(other.status, 200);
  await page.getByTestId('save-profile').click();
  await page.getByTestId('save-conflict').waitFor();
  assert.match(await page.getByTestId('save-conflict').innerText(), /changed somewhere else/u);
  assert.match(await modelOf('claude'), /fake-slow/u, 'the local edit is still there');
  assert.equal(
    (await profileOf()).overrides.seats,
    undefined,
    'nothing of the refused save was written',
  );
  assert.equal(
    (await profileOf()).overrides.budgets.maxWords,
    17,
    'and the other page’s save is intact',
  );
  await page.getByTestId('reload-profile').click();
  assert.match(await page.getByTestId('confirm-dialog').innerText(), /thrown away/u);
  await page.getByTestId('confirm-cancel').click();
  assert.equal(await page.getByTestId('save-conflict').count(), 1, 'cancel keeps the conflict');
  await page.getByTestId('reload-profile').click();
  await page.getByTestId('confirm-reload').click();
  await page.getByTestId('save-conflict').waitFor({ state: 'detached' });
  assert.match(await modelOf('claude'), /fake-1/u, 'the local edit is let go');
  await openSettings();
  assert.equal(
    await page.getByTestId('budget-maxWords').inputValue(),
    '17',
    'and the other page’s change is shown',
  );
  await closeSettings();
  await call('/profiles/default', 'PUT', { overrides: {} });
  await page.reload();
  await page.waitForSelector('[data-testid=council-editor]');
  await page.getByTestId('tab-base').click();

  step(
    'Councils: a save that fails is said, with «Try again»; the leave guard asks (a link, Back): stay, discard, or save and go',
  );
  await pickModel('claude', 'fake-slow');
  await page.route('**/api/profiles/default', (route) => route.abort());
  await page.getByTestId('save-profile').click();
  await page.getByTestId('save-error').waitFor({ timeout: 5000 });
  assert.match(await page.getByTestId('save-error').innerText(), /Not saved/u);
  assert.equal(await page.getByTestId('dirty-marker').count(), 1, 'the form keeps its change');
  await page.unroute('**/api/profiles/default');
  // a sidebar link asks first
  await page.getByTestId('nav-connect').click();
  await page.getByTestId('leave-dialog').waitFor();
  assert.match(
    await page.getByTestId('leave-save').innerText(),
    /^Save and go to Connect$/u,
    'the save names where it goes',
  );
  assert.equal((await page.getByTestId('leave-discard').innerText()).trim(), 'Discard changes');
  await page.getByTestId('leave-stay').click();
  // a council in the list: the button says which one, not just «Councils»
  await page.locator('[data-testid=council-list] a[data-profile-id=quick]').click();
  await page.getByTestId('leave-dialog').waitFor();
  assert.equal(
    (await page.getByTestId('leave-save').innerText()).trim(),
    'Save and open Quick',
    'the save names the council it opens',
  );
  await page.getByTestId('leave-stay').click();
  assert.equal(
    await page.evaluate(() => window.location.hash.startsWith('#/models')),
    true,
    'stay: nothing moved',
  );
  assert.match(await modelOf('claude'), /fake-slow/u, 'and the edit is there');
  // Back asks too, and when it stays the history is where it was
  await page.goBack();
  await page.getByTestId('leave-dialog').waitFor();
  await page.getByTestId('leave-stay').click();
  assert.equal(
    await page.evaluate(() => window.location.hash.startsWith('#/models')),
    true,
    'Back: the page stays',
  );
  // the list of councils asks as well; discard throws the edit away and goes on
  await page.locator('[data-testid=council-list] a[data-profile-id=quick]').click();
  await page.getByTestId('leave-dialog').waitFor();
  await page.getByTestId('leave-discard').click();
  await page.waitForFunction(() => window.location.hash.startsWith('#/models/quick'));
  assert.equal((await profileOf()).overrides.seats, undefined, 'discarding saved nothing');
  await page.locator('[data-testid=council-list] a[data-profile-id=default]').click();
  await page.getByTestId('tab-base').click();
  await pickModel('claude', 'fake-slow');
  await page.getByTestId('nav-connect').click();
  await page.getByTestId('leave-save').click();
  await page.waitForFunction(() => window.location.hash === '#/connect');
  assert.equal(
    (await profileOf()).overrides.seats.claude.model,
    'fake-slow',
    'save: kept, then moved',
  );
  await call('/profiles/default', 'PUT', { overrides: {} });

  step(
    'Councils: new, duplicate, rename, id, delete; a Persian name asks for an id in Latin letters',
  );
  await go('#/models');
  await page.waitForSelector('[data-testid=council-editor]');
  await page
    .getByTestId('profile-duplicate')
    .waitFor({ state: 'attached' })
    .catch(() => undefined);
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-duplicate').click();
  assert.equal(
    await page.getByTestId('name-input').inputValue(),
    'Copy of Default',
    'the copy starts with a name',
  );
  await page.getByTestId('name-input').fill('My fast copy');
  assert.equal(await page.getByTestId('name-id').count(), 0, 'a Latin name keeps the automatic id');
  await page.getByTestId('name-ok').click();
  await until(async () => Boolean(await profileOf('my-fast-copy')));
  assert.equal((await profileOf('my-fast-copy')).auto, false);
  await page.waitForFunction(() => window.location.hash.startsWith('#/models/my-fast-copy'));
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-rename').click();
  await page.getByTestId('name-input').fill('Renamed copy');
  await page.getByTestId('name-ok').click();
  await until(async () => (await profileOf('my-fast-copy')).name === 'Renamed copy');
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-id-edit').click();
  await page.getByTestId('profile-id-input').fill('Not a plain id');
  assert.equal(
    await page.getByTestId('profile-id-save').isDisabled(),
    true,
    'a bad id cannot be saved',
  );
  await page.getByTestId('profile-id-input').fill('quick');
  await page.getByTestId('profile-id-save').click();
  await page.getByTestId('profile-id-problem').waitFor();
  await page.getByTestId('profile-id-input').fill('fast-analysis');
  await page.getByTestId('profile-id-save').click();
  await until(async () => Boolean(await profileOf('fast-analysis')));
  await page.waitForFunction(() => window.location.hash.startsWith('#/models/fast-analysis'));
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-delete').click();
  assert.match(await page.getByTestId('confirm-dialog').innerText(), /cannot be undone/u);
  await page.getByTestId('confirm-cancel').click();
  assert.ok(await profileOf('fast-analysis'), 'cancel keeps the council');
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-delete').click();
  await page.getByTestId('confirm-delete-profile').click();
  await until(async () => !(await profileOf('fast-analysis')));
  assert.equal(
    (await fetch(`${origin}/api/profiles/quick`, { method: 'DELETE', headers })).status,
    400,
    'the automatic councils cannot be deleted',
  );
  // a Persian name: the id is asked for, suggested, and must be plain
  await page.getByTestId('profile-new').click();
  await page.getByTestId('name-input').fill('تحلیل سریع');
  await page.getByTestId('name-id').waitFor();
  assert.match(
    await page.getByTestId('name-id').inputValue(),
    /^profile-\d+$/u,
    'an id is suggested',
  );
  await page.getByTestId('name-id').fill('Not a plain id');
  assert.equal(await page.getByTestId('name-ok').isDisabled(), true);
  assert.match(
    await page.getByTestId('name-disabled-reason').innerText(),
    /lowercase, digits and hyphens/u,
  );
  await page.getByTestId('name-id').fill('analysis-one');
  await page.getByTestId('name-ok').click();
  await until(async () => Boolean(await profileOf('analysis-one')));
  assert.equal((await profileOf('analysis-one')).name, 'تحلیل سریع');
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('profile-delete').click();
  await page.getByTestId('confirm-delete-profile').click();
  await until(async () => !(await profileOf('analysis-one')));

  // ====================================================================================================================
  step(
    'Councils: enforced access toggles; manual agy choices carry a plain warning and uncontrolled capabilities',
  );
  await go('#/models/default');
  await page.waitForSelector('[data-testid=council-editor]');
  await page.getByTestId('tab-base').click();
  const expected = {
    claude: { tools: 'free', memory: 'free', web: 'free' },
    codex: { tools: 'forced-on', memory: 'free', web: 'free' },
    grok: { tools: 'forced-on', memory: 'free', web: 'free' },
    pi: { tools: 'free', memory: 'free', web: 'blocked' },
  };
  for (const [id, modes] of Object.entries(expected)) {
    await box(id);
    for (const [key, mode] of Object.entries(modes)) {
      assert.equal(
        await page.getByTestId(`agent-${key}`).getAttribute('data-mode'),
        mode,
        `${id} ${key}`,
      );
      assert.equal(
        await page.getByTestId(`agent-${key}`).isDisabled(),
        mode !== 'free',
        `${id} ${key} is held`,
      );
    }
  }
  // on and off are plain: a check, a word, a solid border for on; forced and blocked ones stay disabled with their reason
  const stateOf = (key) =>
    page.getByTestId(`agent-${key}`).evaluate((el) => ({
      state: el.getAttribute('data-state'),
      word: el.querySelector('[data-testid=toggle-state]')?.textContent?.trim(),
      check: Boolean(el.querySelector('svg')),
      solid: getComputedStyle(el).borderStyle,
    }));
  const onLook = { state: 'on', word: 'on', check: true, solid: 'solid' };
  const offLook = { state: 'off', word: 'off', check: false, solid: 'dashed' };
  // whichever way a free toggle starts, a click turns it the other way, and each way looks as it says
  await box('claude');
  const startedOn = (await stateOf('tools')).state === 'on';
  assert.deepEqual(await stateOf('tools'), startedOn ? onLook : offLook);
  await page.getByTestId('agent-tools').click();
  assert.deepEqual(await stateOf('tools'), startedOn ? offLook : onLook);
  await page.getByTestId('agent-tools').click();
  assert.equal((await stateOf('tools')).state, startedOn ? 'on' : 'off', 'and back');
  await box('codex');
  assert.deepEqual(await stateOf('tools'), { ...onLook, word: 'always on' });
  // a blocked toggle stays off and disabled (Pi has no web search)
  await box('pi');
  assert.deepEqual(await stateOf('web'), { ...offLook, word: 'off' });
  assert.equal(await page.getByTestId('agent-web').isDisabled(), true);
  // «Check again» and the assistants this PC cannot use are in the settings sheet
  await openSettings();
  await page.getByTestId('recheck').hover();
  await page.getByText('Look for installed assistants and models again').waitFor();
  assert.equal(
    await page.getByTestId('unusable').count(),
    0,
    'all fake assistants, including manual-only agy, are usable',
  );
  await closeSettings();
  await box('codex');
  const codexHint = await page.getByTestId('agent-hint').locator('p').innerText();
  assert.ok(
    codexHint.includes('anonymity is not guaranteed') && codexHint.length < 140,
    'codex: one short line',
  );
  assert.equal(await page.getByTestId('agent-notes').count(), 0, 'details folded');
  await page.getByTestId('agent-hint-details').click();
  assert.ok(
    (await page.getByTestId('agent-notes').innerText()).length > 40,
    'the details say more',
  );
  const beforeManual = await profileOf();
  for (const id of ['claude', 'chairman']) {
    const previous =
      id === 'chairman'
        ? beforeManual.effective.chairman
        : beforeManual.effective.seats.find((seat) => seat.id === id);
    await box(id);
    await pick('agent-harness', 'agy');
    const inspector = page.getByTestId('inspector-agent');
    assert.match(
      await inspector.getByTestId('agy-warning').innerText(),
      /can write files and run commands.*Divan cannot stop it/u,
    );
    assert.match(
      await inspector.getByTestId('agent-hint').innerText(),
      /own settings control tools, memory and web/u,
    );
    for (const key of ['tools', 'memory'])
      assert.equal(
        await inspector.getByTestId(`agent-${key}`).getAttribute('data-mode'),
        'uncontrolled',
      );
    await page
      .locator(`[data-testid="design-node"][data-node-id="${id}"]`)
      .getByTestId('agy-warning')
      .waitFor();
    await pick('agent-harness', HARNESS_LABEL[previous.harness] ?? previous.harness);
    await pick('agent-model', previous.model);
  }

  // ====================================================================================================================
  step(
    'Home → start: the council and level chosen there are what the session is made from (profile, revision, fingerprint, level)',
  );
  // one member is slow and one fails: the council is edited on the Councils page and saved, as the owner decided
  await pickModel('grok', 'fake-slow');
  await pickModel('pi', 'fake-fail');
  await page.getByTestId('save-profile').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid=save-cue]')?.dataset.cue === 'saved',
  );
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  // the page opens at the council's own level, whatever was used last
  assert.equal(
    await page
      .locator('[data-testid=level-picker] [aria-pressed=true]')
      .getAttribute('data-testid'),
    'level-medium',
    'Home opens at the default level of the council',
  );
  await page.fill('#question', 'For my personal app, is SQLite or Postgres better?');
  await page.fill('#context', 'A single user, one laptop');
  await page.getByTestId('level-high').click();
  let startBody = null;
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'POST') startBody = route.request().postDataJSON();
    route.continue();
  });
  // asked with Ctrl+Enter while the focus is on the level button that was just chosen
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('[data-testid=editor]');
  await page.unroute('**/api/sessions');
  const profile = await profileOf();
  assert.deepEqual(Object.keys(startBody).sort(), [
    'context',
    'fingerprint',
    'level',
    'profileId',
    'question',
    'revision',
  ]);
  assert.equal(startBody.profileId, 'default');
  assert.equal(startBody.level, 'high');
  assert.equal(startBody.revision, profile.revision);
  assert.equal(
    startBody.fingerprint,
    profile.levels.high.fingerprint,
    'the fingerprint of the council of that level',
  );
  assert.equal(startBody.question, 'For my personal app, is SQLite or Postgres better?');
  assert.equal(startBody.context, 'A single user, one laptop', 'the context is its own field');
  let session = await sessionOf();
  assert.equal(session.settings.level, 'high', 'the session is locked at the level');
  assert.equal(session.settings.seats.find((item) => item.harness === 'grok').model, 'fake-slow');

  step(
    'Waiting: stages, a clock, the members’ live state, the note that the tab can be closed, a draft that is kept',
  );
  await page.waitForSelector('[data-testid=waiting]', { timeout: 15_000 });
  assert.match(await page.getByTestId('elapsed').innerText(), /^\d\d:\d\d$/u);
  assert.equal(
    await page.getByTestId('stage-members').getAttribute('data-state'),
    'live',
    'the live step is the members',
  );
  assert.equal(await page.getByTestId('stage-ready').getAttribute('data-state'), 'next');
  assert.match(await page.getByTestId('leave-note').innerText(), /You can close this tab/u);
  assert.equal(await page.getByTestId('running-pill').count(), 1);
  assert.equal(
    (await page.locator('[data-testid=waiting] .shimmer').count()) > 0,
    true,
    'shimmer text on the live step',
  );
  assert.ok((await page.getByTestId('typical-duration').innerText()).length > 0);
  // while a round runs: the composer drafts, Send is Stop round, critique is off
  await page.locator('#composer-input').fill('A thought that came while waiting');
  assert.equal(
    await page.getByTestId('cancel-round').isVisible(),
    true,
    'Stop round takes the place of Send',
  );
  // «Ask for critique» is not offered while this round runs, and the box does not look locked while it is drafted in
  assert.equal(await page.getByTestId('critique').count(), 0, 'no critique while the round runs');
  assert.equal(
    await page
      .locator('[data-testid=composer] [data-slot=input-group]')
      .evaluate((el) => getComputedStyle(el).opacity),
    '1',
    'the composer looks live',
  );
  assert.match(
    await page.getByTestId('composer-hint').innerText(),
    /Draft now; send when round 1 is done\./u,
  );
  // the sidebar says it is running
  assert.equal(
    await page.locator('[data-testid=sidebar-session] [data-status=running]').count(),
    1,
  );
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 40_000 });
  await idle();
  assert.equal(
    await page.inputValue('#composer-input'),
    'A thought that came while waiting',
    'the draft survived the round finishing',
  );
  await page.fill('#composer-input', '');
  session = await sessionOf();
  const round1 = chairs(session)[0];
  assert.equal(round1.status, 'done');
  assert.deepEqual(
    seatsOf(round1)
      .map((item) => item.state)
      .sort(),
    ['done', 'done', 'done', 'failed'],
  );

  // ====================================================================================================================
  step(
    'The answer is the hero: kicker, chips, recommendation with one muted agreement line, the answer, a folded split row',
  );
  assert.match(await page.getByTestId('kicker').innerText(), /Round 1 · Answer for you/iu);
  assert.equal((await page.getByTestId('chips').locator('button').allInnerTexts()).length, 4);
  assert.match(await page.getByTestId('chip-council').innerText(), /3 of 4 answered/u);
  const claimsChip = await page.getByTestId('chip-claims').innerText();
  assert.match(claimsChip, /^\d+ claims? (used|rejected|open)( · \d+ (rejected|open))*$/u);
  assert.doesNotMatch(claimsChip, /(^|[ ·])0 /u, 'a zero count is not shown');
  assert.match(claimsChip, /open/u, 'the open claim is counted');
  assert.match(await page.getByTestId('chip-cost').innerText(), /tokens/u);
  // a member that did not answer is one muted line beside the confidence, not an alert
  assert.match(
    await page.getByTestId('missing-members').innerText(),
    /Written without member \w \(failed\)/u,
  );
  assert.equal(
    await page.getByTestId('missing-members').locator('xpath=ancestor::*[@role="alert"]').count(),
    0,
  );
  const recommendation = await page.getByTestId('recommendation').innerText();
  assert.match(recommendation, /Start small/u);
  assert.match(
    await page.getByTestId('agreement').innerText(),
    /Confidence 70%( · \d of \d members agree)?/u,
  );
  assert.equal(
    await page
      .getByTestId('agreement')
      .evaluate((el) => getComputedStyle(el).color !== getComputedStyle(document.body).color),
    true,
    'agreement is a muted line',
  );
  assert.equal(await page.locator('[data-testid=answer] ul > li').count(), 2, 'the list items');
  const answerBox = await page.getByTestId('answer').boundingBox();
  // «where the council split»: folded; it opens to the sentence and links to the members
  const split = page.getByTestId('split');
  assert.equal(await split.count(), 1, 'there is dissent in this round');
  assert.equal(
    await page
      .getByTestId('dissent-text')
      .isVisible()
      .catch(() => false),
    false,
    'folded',
  );
  await split.locator('button').first().click();
  assert.match(await page.getByTestId('dissent-text').innerText(), /preferred to wait/u);
  await split.locator('button').first().click();

  step('«Copy answer» puts the chairman’s answer on the clipboard and says so');
  await app.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.getByTestId('copy-answer').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid=copy-answer]')?.textContent?.includes('Copied'),
  );
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(
    copied.split(String.fromCharCode(13)).join(''),
    `**Recommendation:** ${round1.recommendation.choice} (confidence ${Math.round(round1.recommendation.confidence * 100)}%)\n\n${round1.answer}`,
    'the recommendation line first (with its confidence), then the answer',
  );

  step(
    'The details drawer opens over the map, non-modal: the answer does not move and stays usable; the address says what is open',
  );
  await page.getByTestId('chip-council').click();
  await page.getByTestId('details-drawer').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId('chip-council').getAttribute('aria-expanded'), 'true');
  assert.match(await page.evaluate(() => window.location.hash), /detail=council/u);
  const movedBox = await page.getByTestId('answer').boundingBox();
  assert.ok(
    Math.abs(movedBox.x - answerBox.x) < 1 && Math.abs(movedBox.y - answerBox.y) < 1,
    'the answer never moves',
  );
  const drawerBox = await page.getByTestId('details-drawer').boundingBox();
  const mapBox = await page.getByTestId('map').boundingBox();
  assert.ok(
    Math.abs(drawerBox.x - mapBox.x) < 3 && Math.abs(drawerBox.width - mapBox.width) < 3,
    'the drawer covers the map column and nothing else',
  );
  assert.ok(drawerBox.x >= answerBox.x + answerBox.width - 1, 'and not the answer');
  await page.locator('#composer-input').fill('typed with the drawer open');
  assert.equal(
    await page.inputValue('#composer-input'),
    'typed with the drawer open',
    'non-modal: the composer works',
  );
  await page.fill('#composer-input', '');
  assert.equal(await page.getByTestId('detail-tab-council').getAttribute('aria-selected'), 'true');
  // closing and opening the details by a click that does not scroll anything leaves the answer exactly where it was
  const placeOfAnswer = () =>
    page.evaluate(() => ({
      scroll: document.querySelector('[data-testid=panel-body]').scrollTop,
      kicker: document.querySelector('[data-testid=kicker]').getBoundingClientRect().top,
      panel: document.querySelector('[data-testid=chair-panel]').getBoundingClientRect().top,
    }));
  const placed = await placeOfAnswer();
  await page.evaluate(() => document.querySelector('[data-testid=chip-council]').click());
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  assert.deepEqual(await placeOfAnswer(), placed, 'closing the details moves nothing');
  await page.evaluate(() => document.querySelector('[data-testid=chip-council]').click());
  await page.getByTestId('details-drawer').waitFor();
  await page.waitForTimeout(600);
  assert.deepEqual(await placeOfAnswer(), placed, 'opening the details moves nothing');

  step(
    'Council tab: names are hidden; hidden mode shows what the chairman saw; the reveal shows identity, raw output and error detail',
  );
  assert.equal(await page.getByTestId('reveal-switch').getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('[data-testid=seat-identity]').count(), 0);
  assert.equal(
    await page.locator('[data-testid=seat-identity-line]').count(),
    0,
    'no name on a row',
  );
  const claudeLabel = seatsOf(round1).find((item) => item.harness === 'claude').label;
  const failedLabel = seatsOf(round1).find((item) => item.state === 'failed').label;
  await page.locator(`#seat-${claudeLabel} button`).first().click();
  const hiddenClaude = await page.locator(`#seat-${claudeLabel}`).innerText();
  assert.ok(
    !hiddenClaude.includes('As Claude') && hiddenClaude.includes('[AI]'),
    'self-identification is stripped while hidden',
  );
  assert.ok(
    !(await page.locator(`#seat-${failedLabel}`).innerText()).includes('on purpose'),
    'no error detail while hidden',
  );
  // the member's full report: Markdown (its heading is a heading), quoting the input the member was given
  const report = page.locator(`#seat-${claudeLabel} [data-testid=member-report]`);
  assert.ok(
    (await report.locator('h3').first().innerText()).includes('Main findings'),
    'the report is shown as Markdown',
  );
  assert.match(await report.innerText(), /On "[^"]+": begin with the cheapest step/u);
  assert.ok(
    chairmanOf(round1).input.includes('[AI]') && !chairmanOf(round1).input.includes('As Claude'),
    'the chairman got the same text',
  );
  await page.getByTestId('reveal-switch').click();
  assert.equal(
    (await page.locator('[data-testid=seat-identity]').count()) >= 1,
    true,
    'the open member shows its identity',
  );
  // and so does every row, not only the opened one: «A · Codex fake-1 medium»
  const rows = await page.locator('[data-testid=member-row]').count();
  assert.equal(await page.locator('[data-testid=seat-identity-line]').count(), rows, 'every row');
  for (const line of await page.locator('[data-testid=seat-identity-line]').allInnerTexts()) {
    assert.match(line, /^(Claude Code|Codex|Grok|Pi)\s+\S+/u, line);
  }
  assert.ok(
    (await page.locator(`#seat-${claudeLabel}`).innerText()).includes('As Claude'),
    'the member’s own words after the reveal',
  );
  await page.locator(`#seat-${failedLabel} button`).first().click();
  await page.locator(`#seat-${failedLabel} details summary`).first().click();
  assert.ok(
    (await page.locator(`#seat-${failedLabel}`).innerText()).includes('on purpose'),
    'error detail after the reveal',
  );
  await page.getByTestId('reveal-switch').click();

  step('Claims, Context and Cost tabs');
  await page.getByTestId('detail-tab-claims').click();
  assert.ok(
    (await page.getByTestId('claims-tab').locator('section').count()) >= 2,
    'the ledger, once, in groups',
  );
  assert.match(await page.getByTestId('claims-tab').innerText(), /used \(\d+\)/iu);
  await page.getByTestId('detail-tab-context').click();
  const contextText = await page.getByTestId('context-tab').innerText();
  assert.match(contextText, /Raw member answers/u);
  assert.equal(
    (await page.locator('[data-testid=ctx-never]').count()) >= 4,
    true,
    'what members never get, as good news, in both tables',
  );
  assert.match(contextText, /Never sent/u);
  await page.locator('[data-testid=context-exact] button').first().click();
  assert.equal(
    await page.getByTestId('context-exact-prompt').textContent(),
    seatsOf(round1)[0].prompt,
    'the exact text is the prompt the members got',
  );
  await page.locator('#composer-input').fill('DRAFT-IN-THE-COMPOSER');
  await page.waitForTimeout(150);
  await page.locator('[data-testid=context-next-exact] button').first().click();
  assert.ok(
    (await page.getByTestId('context-next-exact-prompt').textContent()).includes(
      'DRAFT-IN-THE-COMPOSER',
    ),
    'the next-round preview includes the draft',
  );
  await page.fill('#composer-input', '');
  await page.getByTestId('detail-tab-cost').click();
  const costText = await page.getByTestId('cost-tab').innerText();
  assert.match(costText, /Chairman/u);
  assert.match(costText, /Session total/u);
  assert.match(costText, /\b\d+ ms|\d+(\.\d)? s\b/u, 'times in words');
  // Escape closes it; the chip again opens and closes it
  await page.keyboard.press('Escape');
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  assert.doesNotMatch(await page.evaluate(() => window.location.hash), /detail=/u);
  await page.getByTestId('chip-cost').click();
  await page.getByTestId('details-drawer').waitFor();
  assert.equal(
    await page.getByTestId('detail-tab-cost').getAttribute('aria-selected'),
    'true',
    'a chip opens its own tab',
  );
  await page.getByTestId('chip-cost').click();
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });

  // ====================================================================================================================
  step(
    'The chairman’s questions: one at a time with a progress count; answers and a comment go out as one structured input',
  );
  // pinned directly above the composer, one line while it is closed
  const strip = page.getByTestId('questions');
  assert.match(
    await page.getByTestId('questions-toggle').innerText(),
    /The answer includes 1 question/u,
  );
  assert.equal(await page.getByTestId('questions-card').count(), 0, 'closed: one line');
  const stripBox = await strip.boundingBox();
  const composerBox = await page.getByTestId('composer').boundingBox();
  assert.ok(
    Math.abs(stripBox.y + stripBox.height - composerBox.y) < 2,
    'the strip sits directly above the composer',
  );
  const bodyClosed = await page.getByTestId('panel-body').boundingBox();
  await page.getByTestId('questions-toggle').click();
  // the card opens INSIDE the panel and takes room from the answer's scroll area: it never covers the answer
  const bodyOpen = await page.getByTestId('panel-body').boundingBox();
  const cardBox = await page.getByTestId('questions-card').boundingBox();
  assert.ok(bodyOpen.height < bodyClosed.height - 40, 'the answer area gave the card its room');
  assert.ok(
    cardBox.y >= bodyOpen.y + bodyOpen.height - 1,
    'the card sits below the answer, not over it',
  );
  assert.ok(
    (await page.getByTestId('kicker').boundingBox()).y >= bodyOpen.y - 1,
    'the answer is still where it was, readable',
  );
  assert.match(await page.getByTestId('questions-progress').innerText(), /Question 1 of 1/u);
  assert.match(await page.getByTestId('question-title').innerText(), /monthly cost/u);
  assert.equal(await page.getByTestId('question-answered').count(), 0, 'not answered yet');
  await page.getByTestId('questions-toggle').click();
  let roundBody = null;
  await page.route('**/api/sessions/*/rounds', (route) => {
    if (route.request().method() === 'POST') roundBody = route.request().postDataJSON();
    route.continue();
  });
  // nothing written: Send does not run a round and says what to do
  await page.getByTestId('send').click();
  await page.getByTestId('need-input').waitFor();
  assert.match(
    await page.getByTestId('need-input').innerText(),
    /Answer a question or write a comment/u,
  );
  assert.equal(roundBody, null);
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('answer-0').fill('About 40 euros a month');
  // an answered question says so, and shows its answer
  await page.getByTestId('question-answered').waitFor();
  assert.equal(await page.getByTestId('answer-0').inputValue(), 'About 40 euros a month');
  await page.getByTestId('questions-toggle').click();
  assert.match(await page.getByTestId('questions-toggle').innerText(), /1 of 1 answered/u);
  await page.locator('#composer-input').fill('And what if the data grows?');
  // the composer says exactly what Send will send
  assert.match(
    await page.getByTestId('composer-sends').innerText(),
    /Sends 1 answer \+ your comment/u,
  );
  // the answers are kept per round: another node and back loses none
  await page.locator(`.react-flow__node[data-id="${session.rootId}"]`).click();
  await page.getByTestId('user-panel').waitFor();
  await page.locator(`.react-flow__node[data-id="${chairs(session)[0].id}"]`).click();
  await page.getByTestId('chair-panel').waitFor();
  assert.match(await page.getByTestId('questions-toggle').innerText(), /1 of 1 answered/u);
  await page.getByTestId('questions-toggle').click();
  assert.equal(await page.getByTestId('answer-0').inputValue(), 'About 40 euros a month');
  await page.getByTestId('questions-toggle').click();
  await page.locator('#composer-input').fill('And what if the data grows?');
  await page.locator('#composer-input').press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  assert.deepEqual(roundBody.answers, [
    { question: 'What is the monthly cost at full scale?', answer: 'About 40 euros a month' },
  ]);
  assert.equal(roundBody.comment, 'And what if the data grows?');
  await idle();
  session = await sessionOf();
  const round2 = chairs(session)[1];
  assert.equal(round2.status, 'done');
  const comment = session.nodes[round2.parentId];
  assert.equal(comment.text, 'And what if the data grows?');
  assert.equal(
    comment.answers[0].answer,
    'About 40 euros a month',
    'the answers are stored with the input',
  );
  assert.ok(
    seatsOf(round2).some((item) => item.parsed?.votes?.length),
    'round 2 carries votes',
  );
  assert.ok(
    chairmanOf(round2).input.includes('About 40 euros a month'),
    'the chairman got the answer',
  );
  // the Context table shows the whole of the input (the answer and the comment), clamped with «Show all», and counts all of it
  await page.getByTestId('chip-context').click();
  await page.getByTestId('context-tab').waitFor();
  const inputCell = page.getByTestId('ctx-text-new');
  const inputText = await inputCell.innerText();
  assert.ok(
    inputText.includes('About 40 euros a month') &&
      inputText.includes('And what if the data grows?'),
    `the input row shows all of it: ${inputText}`,
  );
  assert.match(inputText, /Show all/u, 'a long input is clamped and offers «Show all»');
  await inputCell.getByRole('button', { name: 'Show all' }).click();
  assert.match(await inputCell.innerText(), /Show less/u);
  await page.getByTestId('chip-context').click();
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  // the Questionnaire alone: answers without a comment, sent from the questions themselves
  // (round 2 asks the next question: the one that was answered is never asked again)
  await page.getByTestId('questions-toggle').click();
  assert.match(await page.getByTestId('question-title').innerText(), /Who will maintain it/u);
  await page.getByTestId('answer-0').fill('Roughly 90 euros');
  // «Done» hands the cursor to the composer, which says that the answer goes with the message; there is no second Send
  await page.getByTestId('questions-done').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'composer-input');
  assert.match(await page.getByTestId('composer-sends').innerText(), /^Sends 1 answer$/u);
  // after «Done» the strip is closed and says the answers are READY, not sent; Send is lit
  assert.equal(await page.getByTestId('questions-card').count(), 0, 'the card closed');
  assert.match(
    await page.getByTestId('questions-ready').innerText(),
    /^✓ 1 answer ready · press Send$/u,
    'a closed strip never looks as if it had been sent',
  );
  assert.equal(await page.getByTestId('send').getAttribute('data-ready'), 'true', 'Send is lit');
  // changing an answer takes it back to «not done»
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('answer-0').fill('Roughly 90 euros a month');
  await page.getByTestId('questions-toggle').click();
  assert.equal(
    await page.getByTestId('questions-ready').count(),
    0,
    'edited: not ready until Done',
  );
  assert.equal(await page.getByTestId('send').getAttribute('data-ready'), null);
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('questions-done').click();
  assert.equal(await page.getByTestId('send').getAttribute('data-ready'), 'true');
  await page.getByTestId('send').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 3);
  assert.equal(roundBody.comment, undefined);
  assert.equal(roundBody.answers[0].answer, 'Roughly 90 euros a month');
  await idle();
  await page.unroute('**/api/sessions/*/rounds');

  // ====================================================================================================================
  step(
    'The map: two nodes per round, apart by shape and icon; the ghost shows where the next input goes; the path is lit',
  );
  session = await sessionOf();
  const kinds = await page.$$eval('.react-flow__node', (els) =>
    els.map((el) => ({
      kind: el.querySelector('.dv-node')?.className.match(/dv-node--(user|next|chair|ghost)/u)?.[1],
      icon: el
        .querySelector('.dv-node svg')
        ?.getAttribute('class')
        ?.match(/lucide-[a-z0-9-]+/u)?.[0],
      radius: el.querySelector('.dv-node')
        ? getComputedStyle(el.querySelector('.dv-node')).borderRadius
        : '',
    })),
  );
  assert.equal(
    kinds.filter((item) => item.kind === 'user').length,
    3,
    'the question and two inputs',
  );
  assert.equal(kinds.filter((item) => item.kind === 'chair').length, 3, 'one answer per round');
  assert.equal(
    kinds.filter((item) => item.kind === 'ghost').length,
    1,
    'and the ghost of the next input',
  );
  const userNode = kinds.find((item) => item.kind === 'user');
  const chairNode = kinds.find((item) => item.kind === 'chair');
  assert.notEqual(userNode.icon, chairNode.icon, 'different icons');
  assert.notEqual(userNode.radius, chairNode.radius, 'and different shapes (a pill and a card)');
  assert.match(await page.locator('[data-ghost]').innerText(), /Next round continues here/u);
  // selecting round 1 (it has a child): the ghost says a new branch; the path to the root is lit, the rest is dimmed
  await page.locator(`.react-flow__node[data-id="${round1.id}"]`).click();
  assert.match(await page.locator('[data-ghost]').innerText(), /New branch from round 1/u);
  assert.equal(
    await page.$$eval('.dv-node[data-lit]', (els) => els.length),
    2,
    'round 1 and the question',
  );
  assert.ok(
    (await page.$$eval('.dv-node[data-dim]', (els) => els.length)) >= 4,
    'the rest is dimmed',
  );

  step(
    'Branching: a comment on a round that has children makes a branch; «Ask for critique» makes a round without a comment',
  );
  assert.match(
    await page.getByTestId('composer-hint').innerText(),
    /starts a new branch from round 1/u,
  );
  await page.locator('#composer-input').fill('A different thought on round one');
  await page.locator('#composer-input').press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 4);
  await idle();
  await page.locator(`.react-flow__node[data-id="${round1.id}"]`).click();
  await page.getByTestId('critique').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 5);
  await idle();
  session = await sessionOf();
  const children = Object.values(session.nodes).filter((node) => node.parentId === round1.id);
  assert.equal(children.length, 3, 'three branches under round 1');
  assert.deepEqual(children.map((node) => node.kind).sort(), ['next', 'user', 'user']);
  const next = children.find((node) => node.kind === 'next');
  assert.match(
    chairs(session)
      .find((node) => node.parentId === next.id)
      .context.map((row) => row.kind)
      .join(','),
    /instruction$/u,
    'the fixed critique instruction',
  );
  const names = await page.locator('[data-testid=branch-name]').allInnerTexts();
  // once there are branches the original line is named too: no two rounds read the same
  assert.deepEqual([...new Set(names.map((name) => name.replace(/^·\s*/u, '')))].sort(), [
    'Branch 2',
    'Branch 3',
    'Main',
  ]);
  await page.locator(`.react-flow__node[data-id="${round1.id}"]`).click();
  assert.match(
    await page.getByTestId('kicker').innerText(),
    /Round 1 · Answer for you · Main/iu,
    'the answer header names the line too',
  );
  assert.ok(names.length > 2, 'the whole chain of a branch is named, not only its first input');
  // a critique node says what it is the critique of
  assert.match(
    await page.locator('.dv-node--next .dv-node__title').first().innerText(),
    /^Critique of round \d+$/u,
  );

  step(
    'Editing an input makes a sibling branch (the layout is checked in layout.mjs); the root question cannot be edited',
  );
  const firstInput = Object.values(session.nodes).find(
    (node) =>
      node.kind === 'user' && node.parentId === round1.id && node.text.startsWith('And what'),
  );
  await page.locator(`.react-flow__node[data-id="${firstInput.id}"]`).click();
  assert.match(await page.locator('[data-ghost]').innerText(), /edited input goes here/u);
  await page.locator('#edit-input').fill('And what if the data grows a lot?');
  assert.match(await page.getByTestId('edit-hint').innerText(), /becomes a new branch beside it/u);
  assert.equal(await page.getByTestId('user-answers').count(), 1, 'its answers are shown with it');
  await page.getByTestId('edit-run').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 6);
  await idle();
  session = await sessionOf();
  const edited = Object.values(session.nodes).find((node) => node.editedFrom === firstInput.id);
  assert.ok(edited, 'the edited copy exists');
  assert.equal(
    session.nodes[firstInput.id].text,
    'And what if the data grows?',
    'the original is untouched',
  );
  assert.equal(edited.parentId, round1.id, 'a sibling');
  assert.deepEqual(edited.answers, firstInput.answers, 'with the same answers');
  assert.equal(await page.locator('[data-testid=edited-badge]').count(), 1);
  await page.locator(`.react-flow__node[data-id="${session.rootId}"]`).click();
  assert.equal(await page.getByTestId('edit-run').count(), 0, 'the question has no edit');
  assert.match(await page.getByTestId('user-panel').innerText(), /cannot be edited/u);
  assert.equal(await page.getByTestId('ask-again').count(), 1, '«Ask again with changes»');
  // the context typed on Home is the root's own field: shown in its panel, and read by every member after the question
  assert.equal(session.nodes[session.rootId].context, 'A single user, one laptop');
  assert.match(await page.getByTestId('user-context').innerText(), /A single user, one laptop/u);
  const firstRound = Object.values(session.nodes).find(
    (node) => node.kind === 'chair' && node.round === 1,
  );
  assert.ok(
    seatsOf(firstRound)[0].prompt.includes(
      '<question_context>\nA single user, one laptop\n</question_context>',
    ),
    'the members read the context in a block of its own',
  );

  step(
    'Moving to another round hides the members again, and no identity is in the page at any moment of the switch',
  );
  await page.locator(`.react-flow__node[data-id="${round2.id}"]`).click();
  await page.getByTestId('chip-council').click();
  await page.getByTestId('reveal-switch').click();
  assert.equal(await page.getByTestId('reveal-switch').getAttribute('aria-checked'), 'true');
  await page.locator('[data-testid=member-row] button').first().click();
  assert.ok((await page.locator('[data-testid=seat-identity]').count()) > 0, 'revealed');
  // From this frame on every change of the page is recorded: an identity (a model, an assistant's name, a line that carries
  // them) that enters the page at any moment of the switch, even one removed again before it was painted, is caught.
  await page.evaluate(() => {
    const words = ['fake-1', 'fake-2', 'fake-slow', 'fake-fail', 'Claude Code', 'Codex', 'Grok'];
    const seen = [];
    const scan = (text, where) => {
      for (const word of words) if (text.includes(word)) seen.push(`${where}: ${word}`);
    };
    const visit = (node) => {
      if (node.nodeType === Node.TEXT_NODE) scan(node.textContent ?? '', 'text');
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches('[data-testid=seat-identity], [data-testid=chairman-identity]'))
        seen.push('an identity line');
      for (const name of ['title', 'aria-label', 'value'])
        scan(node.getAttribute(name) ?? '', name);
      for (const child of node.childNodes) visit(child);
    };
    window.__identitySeen = seen;
    window.__identityObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of record.addedNodes) visit(added);
        if (record.type === 'characterData') scan(record.target.textContent ?? '', 'text');
        if (record.type === 'attributes')
          scan(record.target.getAttribute(record.attributeName) ?? '', record.attributeName);
      }
    });
    window.__identityObserver.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['title', 'aria-label', 'value'],
    });
  });
  // the drawer lies over the map: it is closed, another round is picked, and its council is opened
  await page.keyboard.press('Escape');
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  await page.locator(`.react-flow__node[data-id="${round1.id}"]`).click();
  await page.getByTestId('chip-council').click();
  await page.getByTestId('details-drawer').waitFor();
  await page.locator('[data-testid=member-row] button').first().click();
  await page.waitForTimeout(500);
  const flashed = await page.evaluate(() => {
    window.__identityObserver.disconnect();
    return window.__identitySeen;
  });
  assert.deepEqual(flashed, [], 'an identity was in the page while the round was switched');
  assert.equal(
    await page.getByTestId('reveal-switch').getAttribute('aria-checked'),
    'false',
    'the switch is per round',
  );
  assert.equal(
    await page.locator('[data-testid=seat-identity]').count(),
    0,
    'and nothing of the other round’s reveal is left',
  );
  await page.keyboard.press('Escape');

  step('The locked session settings open read-only, with the level');
  await page.getByRole('button', { name: 'Session settings' }).click();
  await page.getByTestId('session-settings').waitFor();
  assert.equal(
    await page
      .locator('[data-testid=session-settings] select, [data-testid=session-settings] input')
      .count(),
    0,
  );
  assert.equal(await page.getByTestId('ss-level').innerText(), 'High');
  assert.equal(await page.locator('[data-testid=session-seats] > li').count(), 4);
  await page.keyboard.press('Escape');
  await page.getByTestId('session-settings').waitFor({ state: 'detached' });

  // ====================================================================================================================
  step(
    'Waiting is live: a member that works shows thinking, tokens so far and its last sign of work; «Stop waiting for this member»',
  );
  process.env.DIVAN_FAKE_THINK_MS = '120000';
  const think = await make('A question whose member thinks for a long time', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-think'),
  ]);
  await go(`#/s/${think.id}`);
  await page.waitForSelector('[data-testid=waiting]', { timeout: 15_000 });
  await page.waitForFunction(
    () =>
      /\d+ tokens so far/u.test(
        document.querySelector('[data-testid=member-signal]')?.textContent ?? '',
      ),
    null,
    { timeout: 15_000 },
  );
  assert.match(await page.getByTestId('member-signal').innerText(), /last activity \d+ s ago/u);
  assert.match(
    await page.locator('[data-testid=member-live][data-state=running]').innerText(),
    /Thinking…/u,
  );
  // the member that is working can be left: the round goes on without it
  await page.getByTestId('skip-member').click();
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  const skippedRound = chairs(await sessionOf(think.id))[0];
  assert.equal(skippedRound.status, 'done');
  assert.equal(seatsOf(skippedRound).find((item) => item.harness === 'pi').state, 'skipped');
  assert.match(
    await page.getByTestId('missing-members').innerText(),
    /Written without member \w \(did not take part\)/u,
  );
  await drop(think.id);

  step(
    'Stopping waiting when fewer than two answers could remain warns first; Stop round asks, and counts the spend',
  );
  const thin = await make('A question with too few members left', [
    seat('a', 'claude', 'fake-fail'),
    seat('b', 'codex', 'fake-think', true),
    seat('c', 'pi', 'fake-1'),
  ]);
  await go(`#/s/${thin.id}`);
  await page.waitForSelector('[data-testid=waiting]', { timeout: 15_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid=member-live][data-state=running]').length > 0,
  );
  await page.getByTestId('skip-member').click();
  await page.getByTestId('skip-warning').waitFor();
  assert.match(
    await page.getByTestId('skip-warning').innerText(),
    /Only 1 other answer can still arrive/u,
  );
  await page.getByRole('button', { name: 'Keep waiting' }).click();
  await page.getByTestId('cancel-round').click();
  await page.getByTestId('confirm-stop').click();
  await until(async () => chairs(await sessionOf(thin.id))[0].status === 'cancelled');
  const stopped = chairs(await sessionOf(thin.id))[0];
  assert.ok(stopped.usage.total > 0, 'its spend is counted');
  assert.ok(seatsOf(stopped).every((item) => item.state !== 'running' && item.state !== 'pending'));
  await page.waitForSelector('.dv-node--chair[data-status="cancelled"]');
  assert.match(await page.getByTestId('round-failed').innerText(), /stopped/u);
  assert.match(await page.getByTestId('composer-closed').innerText(), /did not finish/u);
  await drop(thin.id);
  process.env.DIVAN_FAKE_THINK_MS = '';

  step(
    'A member that was silent is stopped when the idle window passes, and the word is «Stopped»; a left-out member is said once',
  );
  const silent = await make('A question with a silent member', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-stall'),
  ]);
  await go(`#/s/${silent.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 40_000 });
  const silentRound = chairs(await sessionOf(silent.id))[0];
  const timedOut = seatsOf(silentRound).find((item) => item.state === 'timeout');
  assert.ok(timedOut, 'one member was stopped');
  const missing = await page.getByTestId('missing-members').innerText();
  assert.match(missing, new RegExp(`Written without member ${timedOut.label} \\(stopped\\)`, 'u'));
  assert.ok(!missing.includes('cancel'), 'and the notice never says cancelled');
  await page.getByTestId('chip-council').click();
  assert.match(await page.locator(`#seat-${timedOut.label}`).innerText(), /Stopped/u);
  await page.keyboard.press('Escape');
  await drop(silent.id);

  const failedRound = await make(
    'A round that fails',
    [seat('a', 'claude', 'fake-1'), seat('b', 'codex', 'fake-1', true), seat('c', 'pi', 'fake-2')],
    { harness: 'pi', model: 'fake-fail', effort: '' },
  );
  await go(`#/s/${failedRound.id}`);
  await page.getByTestId('round-failed').waitFor({ timeout: 30_000 });
  const failedText = await page.getByTestId('round-failed').innerText();
  assert.ok(failedText.includes('The chairman’s run failed'), `one plain line: ${failedText}`);
  assert.ok(!failedText.includes('on purpose'), 'no raw text before the reveal');
  assert.match(failedText, /Run again/u);
  await drop(failedRound.id);

  // ====================================================================================================================
  step(
    'All sessions: rows with their status; rename; delete is undoable and only goes through when the toast times out',
  );
  await go('#/sessions');
  await page.waitForSelector('[data-testid=session-row]');
  assert.ok((await page.getByTestId('session-row').count()) >= 1);
  const rowTitle = await page.locator('[data-testid=session-row] a span').first().innerText();
  assert.match(
    await page.getByTestId('session-row').first().innerText(),
    /rounds? · [\d,]+ tokens/u,
  );
  await page.getByTestId('row-menu').first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByTestId('rename-input').fill('Database choice');
  await page.getByTestId('rename-ok').click();
  await until(async () => (await sessions()).some((item) => item.name === 'Database choice'));
  await page.getByTestId('row-menu').first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.locator('[data-slot=toast]').getByText('Session deleted').waitFor();
  assert.equal(
    await page.getByTestId('session-row').count(),
    0,
    'it is gone from the list at once',
  );
  assert.equal((await sessions()).length, 1, 'but not from the server yet');
  await page.locator('[data-slot=toast]').getByRole('button', { name: 'Undo' }).click();
  await page.getByTestId('session-row').first().waitFor();
  assert.equal((await sessions()).length, 1, 'Undo: still there');
  assert.ok(rowTitle.length > 0);
  await page.waitForTimeout(500);
  const kept = (await sessions())[0];
  await page.getByTestId('row-menu').first().click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await until(async () => (await sessions()).length === 0, 20_000);
  await page.getByTestId('sessions-empty').waitFor();
  assert.ok(kept.id);

  // ====================================================================================================================
  step(
    'Connect: the address, the key (masked, shown, copied), the port explained, the models at four levels, a test',
  );
  await go('#/connect');
  await page.waitForSelector('[data-testid=endpoint]');
  assert.equal(
    await page.getByTestId('endpoint-url').innerText(),
    `http://127.0.0.1:${server.port}/v1`,
  );
  assert.match(await page.getByTestId('endpoint-key').innerText(), /^divan-.{0,6}•+/u);
  await page.getByRole('button', { name: 'Show', exact: true }).click();
  assert.equal(await page.getByTestId('endpoint-key').innerText(), server.apiKey);
  await page.getByTestId('copy-key').click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid=copy-key]')?.textContent?.includes('Copied'),
  );
  // this copy runs on a port that is not the saved one: one sentence says which clients use, and what saving does
  const connectText = await page.getByTestId('connect').innerText();
  assert.ok(
    connectText.includes(
      `Clients use port ${server.port} now; a port saved here takes effect at the next start.`,
    ),
    'which port clients use, in one sentence',
  );
  assert.notEqual(
    await page.getByTestId('endpoint-port').inputValue(),
    String(server.port),
    'the Port field shows the saved port',
  );
  // the Pi command has the real folder of the extension on this PC, not a placeholder
  assert.ok(!connectText.includes('<dio-divan folder>'), 'no placeholder');
  assert.match(connectText, /pi install \S*pi-extension/u);
  // the test sits with the endpoint (above the models), not at the foot of the page
  const testBox = await page.getByTestId('test-connection').boundingBox();
  const modelsBox = await page.getByTestId('models').boundingBox();
  assert.ok(testBox.y < modelsBox.y, 'the test button is in the endpoint card');
  const models = await page.getByTestId('models').innerText();
  assert.ok(models.includes('divan/default') && models.includes('divan/quick'));
  assert.ok(
    ['Low', 'Medium', 'High', 'Max'].every((level) => models.includes(level)),
    'every council at four levels',
  );
  await page.getByRole('tab', { name: 'T3 Code' }).click();
  // the panel of the tab that was open before may still be on its way out for a moment: read once only one panel shows
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid=connect] [role=tabpanel]')].filter((panel) =>
        panel.checkVisibility(),
      ).length === 1,
  );
  // T3 Code is its own provider (ACP, a local command): the tab gives the executable and the arguments, not a base URL
  const t3Tab = await page.locator('[data-testid=connect] [role=tabpanel]:visible').innerText();
  // (the path of node may hold a space, as `C:\Program Files\nodejs\node.exe` does)
  assert.match(t3Tab, /Executable\s+.*node/iu, 'the T3 Code tab names the executable');
  assert.match(t3Tab, /dio-divan\.mjs/u, 'the T3 Code tab gives the bridge script');
  assert.match(t3Tab, /^\s*acp\s*$/mu, 'the T3 Code tab gives the acp argument');
  assert.ok(!t3Tab.includes('API key'), 'the T3 Code tab asks for no key');
  assert.match(t3Tab, /d1-default/u, 'the T3 Code tab names the models');
  await page.getByTestId('test-connection').click();
  await page.locator('[data-testid=test-result][data-result=ok]').waitFor();
  // the server called its own /v1/models with the key: the models it listed are counted
  assert.match(
    await page.getByTestId('test-result').innerText(),
    /The server answers; no assistant was called · \d+ models?/u,
  );

  step(
    'Settings: the language applies at once without a reload (the shell mirrors), the mode and a shadcn theme preset apply at once',
  );
  await go('#/settings');
  await page.waitForSelector('[data-testid=settings]');
  await page.getByTestId('language-fa').click();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  assert.equal(await page.locator('html').getAttribute('lang'), 'fa');
  const sidebarBox = await page.locator('[data-slot=sidebar-container]').boundingBox();
  assert.ok(
    sidebarBox.x > 700,
    `the sidebar is on the right in Persian (x ${Math.round(sidebarBox.x)})`,
  );
  assert.equal(await page.getByTestId('nav-settings').innerText(), 'تنظیمات');
  await page.getByTestId('language-en').click();
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
  assert.equal(await page.getByTestId('nav-settings').innerText(), 'Settings');
  await page.getByTestId('mode-dark').click();
  assert.equal(
    await page.evaluate(() => document.documentElement.classList.contains('dark')),
    true,
  );
  assert.equal(await page.evaluate(() => localStorage.getItem('divan-theme')), 'dark');
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.getByTestId('mode-light').click();
  assert.notEqual(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    darkBackground,
  );
  const neutralPrimary = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--primary'),
  );
  await page.getByTestId('preset-blue').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.preset), 'blue');
  assert.notEqual(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary'),
    ),
    neutralPrimary,
    'a preset changes the colours',
  );
  await page.getByTestId('preset-neutral').click();
  // the palette: sessions, places, language, theme
  await page.keyboard.press('Control+k');
  await page.getByTestId('palette-input').fill('connect');
  await page
    .getByRole('option', { name: /Connect/u })
    .first()
    .click();
  await page.waitForFunction(() => window.location.hash === '#/connect');

  // ====================================================================================================================
  step(
    'Layouts at 1400, 1100 and 900 px: side by side while there is room, two tabs when there is not; the page never scrolls',
  );
  const big = await make('A session for the layouts', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
  ]);
  await go(`#/s/${big.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  const noScroll = () =>
    page.evaluate(() => ({
      doc:
        document.scrollingElement.scrollHeight <= innerHeight &&
        document.scrollingElement.scrollWidth <= innerWidth,
      top: document.scrollingElement.scrollTop,
    }));
  for (const [width, split] of [
    [1400, true],
    [1100, true],
    [900, false],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(500);
    const panel = await page.getByTestId('answer-panel').boundingBox();
    const tabs = await page.getByTestId('tabs').count();
    if (split) {
      assert.equal(tabs, 0, `${width}px: no tabs`);
      assert.ok(
        panel.width >= 400 && panel.width <= 640,
        `${width}px: the answer is a reading column (${Math.round(panel.width)}px)`,
      );
      const map = await page.getByTestId('map').boundingBox();
      assert.ok(map.width >= 380, `${width}px: and the map has room (${Math.round(map.width)}px)`);
    } else {
      assert.equal(tabs, 1, `${width}px: the answer and the map are tabs`);
      assert.equal(
        await page.getByTestId('tab-panel').getAttribute('aria-selected'),
        'true',
        'the answer first',
      );
      assert.equal(
        await page.getByTestId('map').isVisible(),
        false,
        'the map waits behind its tab',
      );
      await page.getByTestId('tab-tree').click();
      await page.waitForTimeout(500);
      assert.equal(await page.getByTestId('map').isVisible(), true);
      assert.ok(
        (await page.locator('.react-flow__node').count()) >= 3,
        'the question, the round and the ghost',
      );
      await page.getByTestId('tab-panel').click();
    }
    // the tokens used are shown at every width, as a figure with no cap beside it
    const meter = page.getByTestId('token-meter');
    assert.equal(await meter.isVisible(), true, `${width}px: the meter`);
    assert.match((await meter.innerText()).replace(/\s+/gu, ' '), / \d+(\.\d+)?k? tokens$/u);
    const state = await noScroll();
    assert.equal(state.doc, true, `${width}px: the page does not scroll`);
    assert.equal(state.top, 0);
  }
  // the drawer in tabs mode covers the whole body, and closes
  await page.getByTestId('chip-council').click();
  await page.getByTestId('details-drawer').waitFor();
  const narrowDrawer = await page.getByTestId('details-drawer').boundingBox();
  assert.ok(
    narrowDrawer.width >= 800,
    `at 900px the drawer has the page's width (${Math.round(narrowDrawer.width)}px)`,
  );
  await page.getByTestId('details-close').click();
  await page.setViewportSize({ width: 1440, height: 900 });
  await drop(big.id);

  // ====================================================================================================================
  step(
    'Persian: the shell mirrors, the answer is at the inline start, every block takes its own direction, machine values stay left to right',
  );
  const fa = await make('برای نسخهٔ اول، اپ دسکتاپ بسازیم یا وب‌اپ؟', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
  ]);
  await page.evaluate(() => localStorage.setItem('divan-lang', 'fa'));
  await page.goto(`${origin}/#/s/${fa.id}`);
  await page.reload();
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  const faPanel = await page.getByTestId('answer-panel').boundingBox();
  const faMap = await page.getByTestId('map').boundingBox();
  assert.ok(faPanel.x > faMap.x, 'the answer is at the start (right), the map at the end');
  const faSidebar = await page.locator('[data-slot=sidebar-container]').boundingBox();
  assert.ok(faSidebar.x > faPanel.x, 'and the sidebar is on the far right');
  const directions = await page.$$eval('[data-testid=answer] p, [data-testid=answer] li', (els) =>
    els.map((el) => [el.textContent.slice(0, 20), el.getAttribute('dir')]),
  );
  assert.ok(
    directions.some(([, dir]) => dir === 'rtl'),
    'a Persian block is right to left',
  );
  // a list in Persian keeps its markers inside the panel
  const listBox = await page.locator('[data-testid=answer] ol').first().boundingBox();
  assert.ok(
    listBox && listBox.x >= faPanel.x && listBox.x + listBox.width <= faPanel.x + faPanel.width + 1,
    'the list stays inside the panel',
  );
  await page.getByTestId('chip-council').click();
  await page.getByTestId('details-drawer').waitFor();
  const faDrawer = await page.getByTestId('details-drawer').boundingBox();
  assert.ok(Math.abs(faDrawer.x - faMap.x) < 3, 'the drawer opens over the map, at the end side');
  const memberDirs = await page.$$eval('[data-testid=member-row]', (els) =>
    els.map((el) => getComputedStyle(el).direction),
  );
  assert.ok(memberDirs.length >= 2);
  await page.keyboard.press('Escape');
  // the roster on Home says the levels in Persian (a model id stays a machine value, left to right)
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  const faRoster = await page.getByTestId('council-seats').innerText();
  assert.ok(faRoster.includes('متوسط'), `the efforts are in Persian: ${faRoster}`);
  assert.ok(!/\b(low|medium|high|max)\b/u.test(faRoster), 'no English level name in the roster');
  assert.match(faRoster, /fake-/u, 'a model stays as it is');
  // a level that overrides a member's effort says so in one muted line, and the effort is Persian there too (both languages
  // render this line from the same code: it must not break the page)
  const forFa = await profileOf();
  const overrode = await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: { medium: { seats: { claude: { effort: 'high' } } } },
      ifRevision: forFa.revision,
      ifFingerprint: forFa.fingerprint,
    }),
  });
  assert.equal(overrode.status, 200);
  await page.reload();
  await page.waitForSelector('[data-testid=home]');
  assert.match(
    await page.getByTestId('level-overrides').innerText(),
    /زیاد/u,
    'the override line is in Persian',
  );
  const afterFa = await profileOf();
  await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: {},
      ifRevision: afterFa.revision,
      ifFingerprint: afterFa.fingerprint,
    }),
  });
  assert.equal(await page.getByTestId('council-slug').count(), 0, 'no divan/default on Home');
  assert.equal(
    (await page.getByTestId('council-card').innerText()).includes('divan/'),
    false,
    'the model name for other tools stays on Councils and Connect',
  );
  await go(`#/s/${fa.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  // latin digits in the interface, in both languages
  assert.doesNotMatch(
    await page.locator('body').innerText(),
    /[۰-۹]/u,
    'no Persian digits in the chrome',
  );
  await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
  await page.reload();
  await page.waitForSelector('[data-testid=editor]');
  assert.equal(await page.locator('html').getAttribute('dir'), 'ltr');
  const enPanel = await page.getByTestId('answer-panel').boundingBox();
  const enMap = await page.getByTestId('map').boundingBox();
  assert.ok(enPanel.x < enMap.x, 'in English the answer is on the left');
  // the title of a Persian session in the English interface takes its own direction while the row keeps its place
  assert.equal(await page.getByTestId('session-title').getAttribute('dir'), 'rtl');
  await drop(fa.id);

  // ====================================================================================================================
  step(
    'The endpoint answers like a model; a session from it carries an api badge and its link opens that round once',
  );
  const ask = async () => {
    const response = await fetch(`${origin}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${server.apiKey}`,
        'content-type': 'application/json',
        'x-divan-client': 'e2e',
      },
      body: JSON.stringify({
        model: 'divan/quick',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'Which first: a desktop app or a web app?' }],
      }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const chunks = text
      .split('\n\n')
      .map((block) => block.split('\n').find((line) => line.startsWith('data: ')))
      .filter((line) => line && line !== 'data: [DONE]')
      .map((line) => JSON.parse(line.slice(6)));
    return {
      content: chunks.map((c) => c.choices[0]?.delta.content ?? '').join(''),
      divan: chunks.find((c) => c.divan)?.divan,
    };
  };
  const streamed = await ask();
  assert.match(
    streamed.content,
    /\n\n\[Open in Divan\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)$/u,
    'the closing link: alone on the last line, the round named in its address',
  );
  await go('#/sessions');
  await page.waitForSelector('[data-testid=session-row]');
  // a session that came through /v1 says where from, in the list and in the sidebar (the client name the server stored)
  assert.equal((await page.getByTestId('api-badge').innerText()).trim(), 'from e2e');
  assert.equal((await page.getByTestId('sidebar-origin').first().innerText()).trim(), 'from e2e');
  const linkUrl = /\]\((\S+)\)$/u.exec(streamed.content)[1];
  const second = await app.browser.newContext();
  const fresh = await second.newPage();
  await fresh.goto(linkUrl);
  await fresh.waitForSelector('[data-testid=editor]');
  assert.match(fresh.url(), new RegExp(`#/s/${streamed.divan.session_id}`, 'u'));
  assert.equal((await fresh.goto(linkUrl)).status(), 200, 'the expired link opens its page');
  await fresh.getByText('This sign-in link has expired', { exact: false }).waitFor();
  await second.close();
  await call(`/sessions/${streamed.divan.session_id}`, 'DELETE');

  // ====================================================================================================================
  step(
    'What a fresh tester found: a member that goes quiet is called out; the council card says what really changed; titles, critique and branches say what they are; the level group has roving focus',
  );
  // -- a member with no sign of work for a minute says so (the clock is moved on in a tab of its own), and the way out gets prominent
  process.env.DIVAN_FAKE_THINK_MS = '300000';
  const quietSession = await make('A question with a member that goes quiet', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'pi', 'fake-1'),
    seat('c', 'grok', 'fake-think', true),
  ]);
  const quietContext = await app.browser.newContext({ viewport: { width: 1300, height: 900 } });
  const quiet = await quietContext.newPage();
  await quiet.clock.install();
  await quiet.goto(server.url);
  await quiet.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/s/${quietSession.id}`);
  await quiet.waitForSelector('[data-testid=waiting]');
  await quiet.waitForSelector('[data-testid=member-live][data-state=running]');
  await quiet.clock.resume();
  assert.equal(
    await quiet.getByTestId('member-stale').count(),
    0,
    'quiet before a minute has passed',
  );
  const quietClass = await quiet.getByTestId('skip-member').getAttribute('class');
  assert.ok(!quietClass.includes('bg-primary'), 'the way out is plain until then');
  await quiet.clock.fastForward(65_000);
  await quiet.getByTestId('member-stale').waitFor();
  assert.match(await quiet.getByTestId('member-stale').innerText(), /^No sign of work for 1 min/u);
  assert.ok(
    (await quiet.getByTestId('skip-member').getAttribute('class')).includes('bg-primary'),
    '«Stop waiting for this member» is prominent then',
  );
  await quietContext.close();
  const quietChair = chairs(await sessionOf(quietSession.id))[0];
  await call(`/sessions/${quietSession.id}/rounds/${quietChair.id}/cancel`, 'POST', {});
  await until(async () => chairs(await sessionOf(quietSession.id))[0].status !== 'running');
  process.env.DIVAN_FAKE_THINK_MS = '';
  await drop(quietSession.id);

  // -- Home: Tab lands on the level that is selected, and the arrow keys move inside the group
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  const selectedLevel = await page
    .locator('[data-testid=level-picker] [aria-pressed=true]')
    .getAttribute('data-testid');
  await page.getByTestId('council-select').focus();
  await page.keyboard.press('Tab');
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    selectedLevel,
    'Tab lands on the selected level',
  );
  await page.keyboard.press('ArrowRight');
  assert.notEqual(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    selectedLevel,
    'an arrow key moves inside the group',
  );
  assert.match(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? ''),
    /^level-/u,
  );

  // -- a revision that moved behind the page is no change of the council: the ask goes through, no card
  await page.fill('#question', 'Should we price our analytics tool per seat or per usage?');
  const forThePage = await profileOf();
  const bumped = await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: { max: { seats: { claude: { effort: 'low' } } } },
      ifRevision: forThePage.revision,
      ifFingerprint: forThePage.fingerprint,
    }),
  });
  assert.equal(bumped.status, 200);
  await page.getByTestId('start').click();
  await page.waitForSelector('[data-testid=editor]');
  await idle();
  const priced = await sessionOf();
  const pricedRound = chairs(priced)[0];
  assert.equal(pricedRound.status, 'done');
  // the fake chairman writes a title the way a person would: the first sentence of the question as it was written (small words
  // kept), cut at a word boundary to about six words; never `Round N`
  assert.ok(!/^round/iu.test(pricedRound.title), `title: ${pricedRound.title}`);
  const pricedTitle = (await sessions())[0].title;
  assert.equal(
    pricedTitle,
    'Should we price our analytics tool…',
    'the first sentence, cut at a word boundary',
  );
  // the profile is put back as it was
  const bumpedProfile = await profileOf();
  await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: {},
      ifRevision: bumpedProfile.revision,
      ifFingerprint: bumpedProfile.fingerprint,
    }),
  });

  // -- a critique says what it is the critique of; a round after the first says what it changed; branching is a button
  await page.getByTestId('critique').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await idle();
  assert.match(await page.getByTestId('kicker').innerText(), /Round 2 · Critique of round 1/iu);
  assert.ok((await page.getByTestId('direction').innerText()).length > 0, 'what round 2 changed');
  assert.match(
    await page.locator('.dv-node--next .dv-node__title').first().innerText(),
    /^Critique of round 1$/u,
  );
  assert.match(await page.getByTestId('answer-title').innerText(), /^Critique: /u);
  assert.match(await page.getByTestId('branch-here').innerText(), /Continue from here/u);
  await page.locator(`.react-flow__node[data-id="${pricedRound.id}"]`).click();
  await page.getByTestId('chair-panel').waitFor();
  assert.match(await page.getByTestId('branch-here').innerText(), /Branch from this round/u);
  await page.getByTestId('branch-here').click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'composer-input');
  assert.match(
    await page.getByTestId('composer-hint').innerText(),
    /starts a new branch from round 1/u,
  );
  assert.equal(
    await page.getByTestId('direction').count(),
    0,
    'the first round has no direction line',
  );
  await drop(priced.id);

  // -- the council really changed behind the page (a model ran out of credit): the card says WHAT, with one button to go on
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  await page.fill('#question', 'Does the card say what changed?');
  await server.store.addUnavailable({
    harness: 'codex',
    model: 'fake-1',
    prefix: '',
    until: new Date(Date.now() + 25_000).toISOString(),
    reason: '402 insufficient balance',
  });
  const sessionsBefore = (await sessions()).length;
  await page.getByTestId('start').click();
  await page.getByTestId('council-changed').waitFor();
  assert.match(await page.getByTestId('council-diff').innerText(), /Codex is now off/u);
  assert.match(
    await page.getByTestId('council-why').innerText(),
    /All models of Codex were left out of the defaults/u,
  );
  assert.equal((await sessions()).length, sessionsBefore, 'nothing was started');
  await page.getByTestId('ask-updated').click();
  await page.waitForSelector('[data-testid=editor]');
  const updated = await sessionOf();
  assert.equal(updated.settings.seats.find((item) => item.harness === 'codex').enabled, false);
  await idle();
  await drop(updated.id);

  // ====================================================================================================================
  step(
    'Behind the page: a toggle that changed, and a pinned member whose model ran out; the card says what, and nothing starts silently',
  );
  const putDefault = async (edit) => {
    const was = await profileOf();
    const response = await fetch(`${origin}/api/profiles/default`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ...edit(was),
        ifRevision: was.revision,
        ifFingerprint: was.fingerprint,
      }),
    });
    assert.equal(response.status, 200);
  };
  // the council as the owner left it on the earlier pages is put back to plain defaults first
  await putDefault(() => ({ overrides: {}, levels: {} }));
  await server.store.addUnavailable({
    harness: 'codex',
    model: 'fake-1',
    until: new Date(Date.now() - 1000).toISOString(),
    reason: 'back',
  });
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  await page.fill('#question', 'Does a toggle that changed behind the page stop the start?');
  // only a toggle is changed (Claude Code loses its tools): no member, model or effort moved, but the council is not the same
  await putDefault((was) => ({
    overrides: { ...was.overrides, seats: { ...was.overrides.seats, claude: { tools: false } } },
  }));
  const countBeforeToggle = (await sessions()).length;
  await page.getByTestId('start').click();
  await page.getByTestId('council-changed').waitFor();
  assert.match(
    await page.getByTestId('council-diff').innerText(),
    /Claude Code: Tools is now off/u,
    'the toggle is said',
  );
  assert.equal((await sessions()).length, countBeforeToggle, 'nothing was started');
  await page.getByTestId('ask-updated').click();
  await page.waitForSelector('[data-testid=editor]');
  assert.equal(
    (await sessionOf()).settings.seats.find((item) => item.harness === 'claude').tools,
    false,
    'and the session is the council that was shown on the card',
  );
  await idle();
  await drop((await sessions())[0].id);
  // a member pinned to a model by the owner stays in the settings when that model runs out, but it is not asked
  await putDefault(() => ({ overrides: { seats: { pi: { model: 'fake-1' } } }, levels: {} }));
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  await page.fill('#question', 'Does a pinned member that ran out stop the start?');
  await server.store.addUnavailable({
    harness: 'pi',
    model: 'fake-1',
    until: new Date(Date.now() + 25_000).toISOString(),
    reason: '429 rate limit',
  });
  const countBeforePinned = (await sessions()).length;
  await page.getByTestId('start').click();
  await page.getByTestId('council-changed').waitFor();
  assert.match(
    await page.getByTestId('council-diff').innerText(),
    /Pi will not answer now/u,
    'the member that will not be asked is said',
  );
  assert.equal((await sessions()).length, countBeforePinned, 'nothing was started');
  await page.getByTestId('ask-updated').click();
  await page.waitForSelector('[data-testid=editor]');
  await idle();
  await drop((await sessions())[0].id);
  await server.store.addUnavailable({
    harness: 'pi',
    model: 'fake-1',
    until: new Date(Date.now() - 1000).toISOString(),
    reason: 'back',
  });
  await putDefault(() => ({ overrides: {}, levels: {} }));

  // ====================================================================================================================
  step(
    'Quick picks the three fastest assistants and says so; when its roster is not what the user saw, it says which took the place of which',
  );
  await go('#/models/quick');
  await page.evaluate(() => localStorage.removeItem('divan-quick-roster-models'));
  await page.reload();
  await page.waitForSelector('[data-testid=council-editor]');
  assert.equal(
    (await page.getByTestId('quick-line').innerText()).trim(),
    'Quick selects 3 member models for speed and keeps the chairman from another company. Its roster can change.',
  );
  // the first sight is remembered silently
  assert.equal(
    await page.getByTestId('quick-roster-note').count(),
    0,
    'nothing to compare with yet',
  );
  const quickNow = (await profileOf('quick')).effective.seats
    .filter((item) => item.enabled)
    .map((item) => `${item.harness}|${item.model}`)
    .sort();
  assert.deepEqual(
    JSON.parse(await page.evaluate(() => localStorage.getItem('divan-quick-roster-models')))
      .members,
    quickNow,
    'the roster seen is kept in this browser',
  );
  // the user last saw another roster (one assistant in the place of another): the page says what changed
  const absentHarness = ['claude', 'codex', 'grok', 'pi'].find(
    (name) => !quickNow.some((item) => item.startsWith(`${name}|`)),
  );
  const absent = `${absentHarness}|previous-model`;
  const dropped = quickNow[0];
  const seenBefore = [...quickNow.filter((name) => name !== dropped), absent].sort();
  await page.evaluate(
    (roster) => localStorage.setItem('divan-quick-roster-models', JSON.stringify(roster)),
    { members: seenBefore, speeds: {} },
  );
  await page.reload();
  await page.waitForSelector('[data-testid=council-editor]');
  const label = { claude: 'Claude Code', codex: 'Codex', grok: 'Grok', pi: 'Pi' };
  assert.equal(
    (await page.getByTestId('quick-roster-note').innerText()).replace(/\s*Got it\s*$/u, '').trim(),
    `Quick now uses ${label[dropped.split('|')[0]]} (${dropped.split('|')[1]}) instead of ${label[absentHarness]} (previous-model).`,
  );
  await page.getByTestId('quick-roster-ok').click();
  assert.equal(await page.getByTestId('quick-roster-note').count(), 0, 'seen');
  await page.reload();
  await page.waitForSelector('[data-testid=council-editor]');
  assert.equal(await page.getByTestId('quick-roster-note').count(), 0, 'and it stays seen');
  // Home says the same line under Quick
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  await pick('council-select', 'Quick');
  assert.match(
    await page.getByTestId('quick-line').innerText(),
    /^Quick selects \d+ member models/u,
  );
  assert.equal(
    await page
      .locator('[data-testid=level-picker] [aria-pressed=true]')
      .getAttribute('data-testid'),
    'level-low',
    'and Quick opens at its own default level',
  );
  await pick('council-select', 'Default');
  assert.equal(
    await page
      .locator('[data-testid=level-picker] [aria-pressed=true]')
      .getAttribute('data-testid'),
    'level-medium',
    'another council opens at its own',
  );

  // ====================================================================================================================
  step(
    'The fake reports what a real call costs (about 100k a round); the page shows that real usage, and Home says how long a round usually takes once one has run',
  );
  for (const old of await sessions()) await call(`/sessions/${old.id}`, 'DELETE');
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  assert.equal(await page.getByTestId('usual').count(), 0, 'nothing has run: no usual time');
  process.env.DIVAN_FAKE_USAGE = '1';
  const plain = await profileOf();
  const realStart = await call('/sessions', 'POST', {
    question: 'Should I leave my stable job to start a company?',
    profileId: 'default',
    revision: plain.revision,
    fingerprint: plain.levels.medium.fingerprint,
    level: 'medium',
  });
  await until(async () => chairs(await sessionOf(realStart.id))[0]?.status === 'done', 30_000);
  const actual = (await sessions())[0].tokens;
  assert.ok(
    actual > 70_000 && actual < 130_000,
    `a round costs about 100k, as a real one: ${actual}`,
  );
  process.env.DIVAN_FAKE_USAGE = '0.1';
  // the header shows what the harnesses reported for the session, as it is: no cap, no estimate
  await go(`#/s/${realStart.id}`);
  await page.waitForSelector('[data-testid=token-meter]');
  const shown = /(\d+(?:\.\d+)?)k tokens$/u.exec(
    (await page.getByTestId('token-meter').innerText()).replace(/\s+/gu, ' '),
  );
  assert.ok(shown, 'the meter shows the tokens used');
  assert.ok(
    Math.abs(Number(shown[1]) * 1000 - actual) <= 1000,
    `the meter shows the real usage: ${shown[1]}k against ${actual}`,
  );
  // and the cost tab: this round and the session total are the same real figure, with no budget left to count
  await page.getByTestId('chip-cost').click();
  await page.getByTestId('details-drawer').waitFor();
  const realCostText = await page.getByTestId('cost-tab').innerText();
  assert.match(realCostText, /Session total/u);
  assert.doesNotMatch(realCostText, /Budget left/u);
  await page.getByTestId('details-close').click();
  // Home now says how long a round usually takes (measured), and still shows no token estimate
  await page.reload();
  await page.getByTestId('chair-panel').waitFor();
  await go('#/');
  await page.waitForSelector('[data-testid=home]');
  await page.fill('#question', 'Should I leave my stable job to start a company?');
  await page.getByTestId('usual').waitFor();
  assert.match(await page.getByTestId('usual').innerText(), /^Usually /u);
  assert.equal(await page.getByText(/session budget/u).count(), 0, 'and no token estimate');
  await page.fill('#question', '');
  await drop(realStart.id);

  // ====================================================================================================================
  step(
    'A critique sends nothing from the drafts, so it clears none; an address typed, Back and Forward select the round they name',
  );
  const drafty = await make('Is a draft kept when a critique is asked?', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
  ]);
  await go(`#/s/${drafty.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  const draftyFirst = chairs(await sessionOf(drafty.id))[0];
  await page.locator('#composer-input').fill('A comment I have not sent');
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('answer-0').fill('An answer I have not sent');
  await page.getByTestId('questions-toggle').click();
  let critiqueBody = null;
  await page.route('**/api/sessions/*/rounds', (route) => {
    if (route.request().method() === 'POST') critiqueBody = route.request().postDataJSON();
    route.continue();
  });
  await page.getByTestId('critique').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await page.unroute('**/api/sessions/*/rounds');
  assert.equal(critiqueBody.text, undefined);
  assert.equal(
    critiqueBody.answers,
    undefined,
    'the critique sent neither the comment nor the answers',
  );
  await idle();
  const draftyRounds = chairs(await sessionOf(drafty.id));
  assert.equal(draftyRounds.length, 2);
  // back to the first round: its comment and its answer are still there, as the user left them
  await page.locator(`.react-flow__node[data-id="${draftyFirst.id}"]`).click();
  await page.getByTestId('chair-panel').waitFor();
  assert.equal(
    await page.inputValue('#composer-input'),
    'A comment I have not sent',
    'the comment is kept',
  );
  assert.match(
    await page.getByTestId('questions-toggle').innerText(),
    /1 of 1 answered/u,
    'and so is the answer',
  );
  // typed addresses, Back and Forward select the round they name (never the first one the page opened with)
  const kickerNow = async () =>
    (await page.getByTestId('kicker').innerText()).replace(/\s+/gu, ' ');
  await go(`#/s/${drafty.id}/n/${draftyRounds[1].id}`);
  await page.waitForFunction(() =>
    /Round 2/iu.test(document.querySelector('[data-testid=kicker]')?.textContent ?? ''),
  );
  assert.match(await kickerNow(), /Round 2/iu, 'a typed address selects round 2');
  await go(`#/s/${drafty.id}/n/${draftyFirst.id}`);
  await page.waitForFunction(() =>
    /Round 1/iu.test(document.querySelector('[data-testid=kicker]')?.textContent ?? ''),
  );
  assert.match(await kickerNow(), /Round 1/iu, 'and round 1 again');
  assert.equal(
    await page.inputValue('#composer-input'),
    'A comment I have not sent',
    'with its draft',
  );
  await page.goBack();
  await page.waitForFunction(() =>
    /Round 2/iu.test(document.querySelector('[data-testid=kicker]')?.textContent ?? ''),
  );
  assert.match(
    await kickerNow(),
    /Round 2/iu,
    'Back selects the round of the address it returns to',
  );
  await page.goForward();
  await page.waitForFunction(() =>
    /Round 1/iu.test(document.querySelector('[data-testid=kicker]')?.textContent ?? ''),
  );
  assert.match(await kickerNow(), /Round 1/iu, 'and Forward the one it goes to');
  await page.fill('#composer-input', '');
  await drop(drafty.id);

  // ====================================================================================================================
  step(
    'There is no token cap: a session goes on past any total (an old client’s cap is ignored); the composer shows no cap warning, no raise and no continue in a new session, and the critique button is plain',
  );
  process.env.DIVAN_FAKE_USAGE = '1';
  const capSeats = [seat('a', 'claude', 'fake-1'), seat('b', 'pi', 'fake-2')];
  const piChair = { harness: 'pi', model: 'fake-2', effort: '' };
  const uncapped = await call('/sessions', 'POST', {
    question: 'Should we hire a second engineer now?',
    seats: capSeats,
    chairman: piChair,
    budgets: { maxClaims: 5, maxWords: 30 },
  });
  assert.deepEqual(
    uncapped.settings.budgets,
    { maxClaims: 5, maxWords: 30 },
    'the cap an old client sent is not stored',
  );
  await until(async () => chairs(await sessionOf(uncapped.id))[0]?.status === 'done', 30_000);
  await go(`#/s/${uncapped.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid=composer]');
  for (const gone of ['cap-warning', 'cap-raise', 'cap-continue', 'composer-estimate']) {
    assert.equal(await page.getByTestId(gone).count(), 0, `${gone} is gone`);
  }
  assert.equal(
    await page.getByTestId('send').isDisabled(),
    false,
    'Send is never blocked by a cap',
  );
  assert.equal(
    (await page.getByTestId('critique').innerText()).trim(),
    'Ask for critique',
    'the critique button states no cost',
  );
  // one round already used more than the 100k the old client asked for after the second: the critique runs in one click
  await page.getByTestId('critique').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await idle();
  const used = (await sessions()).find((item) => item.id === uncapped.id)?.tokens ?? 0;
  assert.ok(used > 100000, `two rounds used ${used} tokens, past the old client's cap`);
  // Session settings says nothing about a cap or a raise
  await page.getByTestId('session-settings-button').click();
  await page.getByTestId('session-settings').waitFor();
  assert.equal(await page.getByTestId('budget-events').count(), 0);
  assert.doesNotMatch(
    await page.getByTestId('session-settings').innerText(),
    /cap|budget raised/iu,
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('session-settings').waitFor({ state: 'detached' });
  process.env.DIVAN_FAKE_USAGE = '0.1';
  await drop(uncapped.id);

  // ====================================================================================================================
  step(
    'Stop round: with two answers in, the default writes the answer from them and «Stop everything» is the other, destructive way; with fewer it says why; waiting rows name the assistant, never a letter',
  );
  const stuckSeats = [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
    seat('d', 'grok', 'fake-hang', true),
  ];
  const stuck = await make('Which database should we pick?', stuckSeats);
  await go(`#/s/${stuck.id}`);
  await page.waitForSelector('[data-testid=waiting]', { timeout: 15_000 });
  await page.waitForFunction(() =>
    /3 of 4 done/u.test(document.querySelector('[data-testid=answered-count]')?.textContent ?? ''),
  );
  // the rows say which assistant is which, in the council's own order, and never pair a letter with a name
  assert.deepEqual(
    await page.locator('[data-testid=member-live] [data-testid=member-name]').allInnerTexts(),
    ['Claude Code', 'Codex', 'Pi', 'Grok'],
  );
  const waitingText = await page.getByTestId('waiting').innerText();
  assert.doesNotMatch(waitingText, /\bmember [A-D]\b/u);
  assert.equal(
    await page.locator('[data-testid=member-live] span.font-mono').count(),
    0,
    'no letter badge on a waiting row',
  );
  assert.match(
    await page.locator('[data-testid=member-live][data-state=running]').innerText(),
    /^Grok\s+·\s+Thinking…/u,
    'the stuck one is named',
  );
  await page.getByTestId('cancel-round').click();
  await page.getByTestId('stop-dialog').waitFor();
  assert.equal(await page.getByTestId('stop-dialog').getAttribute('data-salvage'), 'true');
  assert.match(await page.getByTestId('stop-text').innerText(), /^3 members have answered\./u);
  assert.equal(
    await page.getByTestId('stop-rest').innerText(),
    'Stop waiting for the rest and write the answer now',
  );
  assert.equal(await page.getByTestId('confirm-stop').innerText(), 'Stop everything');
  // the default (the focused one) is the salvage
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid')),
    'stop-rest',
    'the default action is to write the answer',
  );
  await page.getByTestId('stop-rest').click();
  await until(async () => chairs(await sessionOf(stuck.id))[0]?.status === 'done', 15_000);
  const salvaged = chairs(await sessionOf(stuck.id))[0];
  assert.deepEqual(
    seatsOf(salvaged)
      .map((item) => item.state)
      .sort(),
    ['done', 'done', 'done', 'skipped'],
  );
  assert.ok(salvaged.answer.length > 0, 'the chairman wrote the answer from the three');
  await page.waitForSelector('[data-testid=answer]');
  assert.match(await page.getByTestId('missing-members').innerText(), /Written without member \w/u);
  await drop(stuck.id);
  // with fewer than two answers there is nothing to write: the dialog says so, and only stops
  const few = await make('Which queue should we use?', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'pi', 'fake-hang'),
    seat('c', 'grok', 'fake-hang', true),
  ]);
  await go(`#/s/${few.id}`);
  await page.waitForSelector('[data-testid=waiting]', { timeout: 15_000 });
  await page.waitForFunction(() =>
    /1 of 3 done/u.test(document.querySelector('[data-testid=answered-count]')?.textContent ?? ''),
  );
  await page.getByTestId('cancel-round').click();
  await page.getByTestId('stop-dialog').waitFor();
  assert.equal(await page.getByTestId('stop-dialog').getAttribute('data-salvage'), null);
  assert.equal(await page.getByTestId('stop-rest').count(), 0, 'nothing to write yet');
  assert.match(
    await page.getByTestId('stop-text').innerText(),
    /needs 2 responses and all its required inputs/u,
  );
  await page.getByTestId('confirm-stop').click();
  await until(async () => chairs(await sessionOf(few.id))[0]?.status === 'cancelled', 15_000);
  await drop(few.id);

  // ====================================================================================================================
  step(
    'Send keeps what was typed after it was sent: an edit made while the request is in flight is not cleared by its success',
  );
  const inflight = await make('Is an edit kept while a send is in flight?', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
  ]);
  await go(`#/s/${inflight.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  const inflightFirst = chairs(await sessionOf(inflight.id))[0];
  await page.locator('#composer-input').fill('The comment that is sent');
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('answer-0').fill('The answer that is sent');
  await page.getByTestId('questions-toggle').click();
  let sentBody = null;
  await page.route('**/api/sessions/*/rounds', async (route) => {
    if (route.request().method() === 'POST') {
      sentBody = route.request().postDataJSON();
      // the request is in flight for a while: the user goes on typing
      await new Promise((resolve) => setTimeout(resolve, 900));
    }
    await route.continue();
  });
  await page.locator('#composer-input').press('Control+Enter');
  await page.locator('#composer-input').fill('The comment that is sent, and more typed meanwhile');
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('answer-0').fill('The answer that is sent, and more typed meanwhile');
  await page.getByTestId('questions-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await page.unroute('**/api/sessions/*/rounds');
  assert.equal(
    sentBody.comment,
    'The comment that is sent',
    'what was sent is what was typed at the send',
  );
  assert.equal(sentBody.answers[0].answer, 'The answer that is sent');
  await idle();
  // back on the round it was sent from: the later edits are still there
  await page.locator(`.react-flow__node[data-id="${inflightFirst.id}"]`).click();
  await page.getByTestId('chair-panel').waitFor();
  assert.equal(
    await page.inputValue('#composer-input'),
    'The comment that is sent, and more typed meanwhile',
    'the comment typed after the send is kept',
  );
  await page.getByTestId('questions-toggle').click();
  assert.equal(
    await page.getByTestId('answer-0').inputValue(),
    'The answer that is sent, and more typed meanwhile',
    'and so is the answer',
  );
  await page.getByTestId('questions-toggle').click();
  await page.fill('#composer-input', '');
  await drop(inflight.id);

  // ====================================================================================================================
  step(
    'At 1280×800: the questions card takes room from the answer instead of covering it, the ask bar stays in view, and the header fits at 900 px',
  );
  const tall = await make('Should we move the billing service to its own team?', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'grok', 'fake-1', true),
    seat('d', 'pi', 'fake-2'),
  ]);
  await page.setViewportSize({ width: 1280, height: 800 });
  await go(`#/s/${tall.id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  await page.getByTestId('questions-toggle').click();
  await page.getByTestId('questions-card').waitFor();
  const roomBody = await page.getByTestId('panel-body').boundingBox();
  const roomCard = await page.getByTestId('questions-card').boundingBox();
  const roomPanel = await page.getByTestId('chair-panel').boundingBox();
  assert.ok(
    roomCard.y >= roomBody.y + roomBody.height - 1,
    'the card is below the answer area, not over it',
  );
  assert.ok(
    roomBody.height >= 150,
    `the answer area keeps room to read: ${Math.round(roomBody.height)}px`,
  );
  assert.ok(
    roomCard.y + roomCard.height <= roomPanel.y + roomPanel.height,
    'and the card is inside the panel',
  );
  // the answer is still the answer: its first lines are on screen, and it scrolls
  assert.ok((await page.getByTestId('kicker').boundingBox()).y >= roomBody.y - 1);
  await page.getByTestId('panel-body').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  assert.ok(
    await page.getByTestId('panel-body').evaluate((el) => el.scrollHeight >= el.clientHeight),
    'the answer area scrolls',
  );
  await page.getByTestId('questions-toggle').click();
  // what the chips say
  assert.match(await page.getByTestId('chip-claims').innerText(), /claims? (used|rejected|open)/u);
  assert.equal((await page.getByTestId('chip-context').innerText()).trim(), 'What assistants saw');
  await page.getByTestId('chip-council').click();
  await page.getByTestId('details-drawer').waitFor();
  assert.match(
    await page.locator('[data-testid=member-row]').first().innerText(),
    /Chairman’s score:\s*\d+\/10/u,
    'the chairman’s rating has a visible label',
  );
  await page.getByTestId('detail-tab-context').click();
  assert.equal(
    (await page.getByTestId('detail-tab-context').innerText()).trim(),
    'What assistants saw',
  );
  assert.match(
    await page.getByTestId('context-gap').innerText(),
    /Each assistant also adds its own instructions and tools, so its input in Cost is larger/u,
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  // the round that asks for a critique does not read «Adjusted for the new input»
  await page.getByTestId('critique').click();
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await idle();
  assert.equal(await page.getByTestId('direction').innerText(), 'Re-examined without new input');
  // Home: with four members and an override line the ask button is in the window, and it says how long a round usually takes
  const forHome = await profileOf();
  await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: { medium: { seats: { claude: { effort: 'high' } } } },
      ifRevision: forHome.revision,
      ifFingerprint: forHome.fingerprint,
    }),
  });
  await go('#/');
  await page.reload();
  await page.waitForSelector('[data-testid=home]');
  await page.waitForSelector('[data-testid=level-overrides]');
  const askBox = await page.getByTestId('start').boundingBox();
  assert.ok(
    askBox.y >= 0 && askBox.y + askBox.height <= 800,
    `the ask button is in the window: ${JSON.stringify(askBox)}`,
  );
  assert.match(await page.getByTestId('usual').innerText(), /^Usually /u, 'how long a round takes');
  // a level button is a plain choice: no cost in a tooltip, no number of rounds
  await page.getByTestId('level-high').hover();
  assert.equal(await page.getByTestId('level-tip-high').count(), 0);
  assert.equal(await page.getByText(/rounds? in the budget|session budget/u).count(), 0);
  const afterHome = await profileOf();
  await fetch(`${origin}/api/profiles/default`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      levels: {},
      ifRevision: afterHome.revision,
      ifFingerprint: afterHome.fingerprint,
    }),
  });
  // the session page's rail has a Sessions button that opens the list
  await go(`#/s/${tall.id}`);
  await page.waitForSelector('[data-testid=chair-panel]');
  await page.getByTestId('rail-sessions-button').click();
  await page.getByTestId('rail-sessions-list').waitFor();
  assert.ok((await page.getByTestId('rail-session').count()) >= 1, 'the sessions are listed');
  await page.keyboard.press('Escape');
  // the header at 900 px: nothing is clipped, the search and the session settings are icons
  await page.setViewportSize({ width: 900, height: 800 });
  await page.waitForTimeout(500);
  const header = await page.evaluate(() => {
    const bar = document.querySelector('header');
    const rights = [...bar.querySelectorAll('*')].map((el) => el.getBoundingClientRect().right);
    return {
      scroll: bar.scrollWidth,
      client: bar.clientWidth,
      right: Math.max(...rights),
      width: window.innerWidth,
    };
  });
  assert.ok(
    header.scroll <= header.client + 1,
    `the header does not overflow: ${JSON.stringify(header)}`,
  );
  assert.ok(header.right <= header.width + 1, 'and nothing is cut at the right edge');
  assert.ok(
    (await page.getByTestId('palette-button').boundingBox()).width < 50,
    'the search is an icon',
  );
  assert.equal(await page.getByTestId('test-mode').isVisible(), true);
  await page.getByTestId('session-settings-button').hover();
  await page.getByText('Session settings', { exact: true }).last().waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  // All sessions: the line under a session is its newest recommendation, never «Adjusted for the new input»
  await go('#/sessions');
  await page.waitForSelector('[data-testid=session-row]', { timeout: 10_000 });
  const listText = await page.getByTestId('session-list').innerText();
  assert.match(listText, /Start small · 70%/u, 'the newest recommendation');
  assert.doesNotMatch(listText, /Adjusted for the new input/u);
  await drop(tall.id);

  // ====================================================================================================================
  step(
    'Persian: one compact token style on a screen (the meter and the chips agree), and the sidebar toggle is localized',
  );
  const faTokens = await make('آیا خدمت صورت‌حساب را به تیم جدا بدهیم؟', [
    seat('a', 'claude', 'fake-1'),
    seat('b', 'codex', 'fake-1', true),
    seat('c', 'pi', 'fake-2'),
  ]);
  await page.evaluate(() => localStorage.setItem('divan-lang', 'fa'));
  await page.goto(`${origin}/#/s/${faTokens.id}`);
  await page.reload();
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  const meterText = await page.getByTestId('token-meter').innerText();
  const chipText = await page.getByTestId('chip-cost').innerText();
  assert.match(meterText, /هزار|\d/u);
  // the same style: both use the Persian word for thousand, or neither does
  assert.equal(
    /هزار/u.test(meterText),
    /هزار/u.test(chipText),
    `meter «${meterText}», chip «${chipText}»`,
  );
  assert.equal(
    (await page.locator('[data-sidebar=trigger] .sr-only').first().innerText()).trim(),
    'باز و بسته کردن نوار کناری',
    'the hidden text of the sidebar toggle is Persian',
  );
  await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
  await page.reload();
  await page.waitForSelector('[data-testid=chair-panel]');
  await drop(faTokens.id);

  // ====================================================================================================================
  step(
    'A working folder: the Home field (an unusable path is said inline, a recent folder is offered), the session keeps it, shows it as a chip and in its settings',
  );
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'divan-e2e-project-')));
  await go('#/');
  await page.reload();
  await page.waitForSelector('[data-testid=home]');
  if ((await page.getByTestId('folder-clear').count()) > 0)
    await page.getByTestId('folder-clear').click();
  assert.equal(
    (await page.getByTestId('folder-help').innerText()).trim(),
    'No folder: assistants still have the access this model gives them',
    'the empty state says what it means',
  );
  // a path that cannot be used: the server's reason is under the field, and nothing starts
  await page.fill('#question', 'Does the working folder reach the members?');
  await page.fill('#folder', 'Z:\\no\\such\\folder');
  const folderSessions = (await sessions()).length;
  await page.keyboard.press('Control+Enter');
  await page.getByTestId('folder-error').waitFor();
  assert.match(
    await page.getByTestId('folder-error').innerText(),
    /The working folder cannot be used: /u,
  );
  assert.equal(
    (await sessions()).length,
    folderSessions,
    'a folder that cannot be used starts nothing',
  );
  // a real folder: the error goes, and the session starts with it
  await page.fill('#folder', project);
  await page.getByTestId('folder-error').waitFor({ state: 'detached' });
  assert.match(
    await page.getByTestId('folder-help').innerText(),
    /Assistants can read in this folder/u,
  );
  let startedWith = null;
  await page.route('**/api/sessions', (route) => {
    if (route.request().method() === 'POST') startedWith = route.request().postDataJSON();
    route.continue();
  });
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('[data-testid=editor]');
  await page.unroute('**/api/sessions');
  assert.equal(startedWith.cwd, project, 'the folder is sent as cwd');
  const inFolder = await sessionOf();
  assert.equal(inFolder.settings.cwd, project, 'the session keeps it');
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await idle();
  // the chip: the last segment, muted, with the whole path in a tooltip
  const segment = project.split(/[\\/]/u).pop();
  assert.equal((await page.getByTestId('folder-chip').innerText()).trim(), segment);
  await page.getByTestId('folder-chip').hover();
  await page.getByTestId('folder-chip-path').waitFor();
  assert.equal(await page.getByTestId('folder-chip-path').innerText(), project);
  // the session's settings show it, read-only
  await page.getByTestId('session-settings-button').click();
  await page.getByTestId('session-settings').waitFor();
  assert.equal(await page.getByTestId('ss-folder-path').innerText(), project);
  assert.equal(
    await page.locator('[data-testid=session-settings] input').count(),
    0,
    'it is read-only',
  );
  await page.keyboard.press('Escape');
  await page.getByTestId('session-settings').waitFor({ state: 'detached' });
  // what members saw lists it
  await page.getByTestId('chip-context').click();
  await page.getByTestId('context-folder').waitFor();
  assert.ok((await page.getByTestId('context-folder').innerText()).includes(project));
  await page.getByTestId('chip-context').click();
  await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
  // a branch uses the same folder: every round of the session does
  await page.locator('#composer-input').fill('A comment in the same folder');
  await page.locator('#composer-input').press('Control+Enter');
  await page.waitForFunction(() => document.querySelectorAll('.dv-node--chair').length === 2);
  await idle();
  assert.ok(
    chairs(await sessionOf(inFolder.id)).every((round) => round.status === 'done'),
    'the second round ran in it too',
  );
  // Home remembers the folder, and offers the recent ones
  await go('#/');
  await page.reload();
  await page.waitForSelector('[data-testid=home]');
  assert.equal(await page.inputValue('#folder'), project, 'the last folder used is remembered');
  await page.getByTestId('folder-clear').click();
  await page.getByTestId('folder').focus();
  await page.getByTestId('folder-list').waitFor();
  assert.equal(
    await page
      .locator('[data-testid=folder-option]')
      .first()
      .innerText()
      .then((text) => text.includes(project)),
    true,
    'the recent folder is offered',
  );
  await page.locator('[data-testid=folder-option]').first().click();
  assert.equal(await page.inputValue('#folder'), project, 'and picking it fills the field');
  await page.getByTestId('folder-clear').click();
  await page.evaluate(() => localStorage.removeItem('divan-folder'));
  await page.fill('#question', '');
  await drop(inFolder.id);

  // Phase 1 custom graphs enter through the engine fixture seam; no HTTP/profile contract is added.
  for (const flow of [undefined, writerFlow()]) {
    const started = await server.engine.createSessionWithRound({
      ...flowInput(),
      ...(flow ? { flow } : {}),
    });
    assert.equal(await started.round.done, 'done');
    const round = chairs(started.session)[0];
    assert.equal(round.steps.length, flow ? 5 : 4);
    await go(`#/s/${started.session.id}`);
    await page.getByTestId('answer').waitFor();
    await page.reload();
    await page.getByTestId('answer').waitFor();
    assert.ok((await page.getByTestId('answer').innerText()).trim());
    await drop(started.session.id);
  }

  {
    // ====================================================================================================================
    step(
      'Councils: every council is drawn on a canvas, a design starts from a template, is checked as it changes, saved with the explicit form and kept after a reload; a council becomes a design only when an edit asks for it',
    );
    const nodeBox = async (id) => page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
    const centerOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const nodeCount = () => page.locator('.react-flow__node').count();
    const edgeCount = () => page.locator('.react-flow__edge').count();
    /** The Library entry an agent's picker (prompt or form) has now, and picking another from its list. */
    const entryOf = (testid) => page.getByTestId(testid).getAttribute('data-value');
    const pickEntry = async (testid, id) => {
      await page.getByTestId(testid).click();
      await page
        .locator(
          `[data-testid="${testid}-list"] [data-testid=picker-option][data-entry-id="${id}"]`,
        )
        .click();
      await page.waitForFunction(
        ([id2, value]) => document.querySelector(`[data-testid="${id2}"]`)?.dataset.value === value,
        [testid, id],
      );
    };
    const pickNode = async (id) => {
      await page.locator(`.react-flow__node[data-id="${id}"]`).click();
      await page.waitForTimeout(250);
    };
    /** A point of an edge on the screen (`at`: how far along it, 0 to 1; the ends of a fan are alone, the middle is shared). */
    const edgePoint = (id, at) =>
      page.evaluate(
        ({ edge, fraction }) => {
          const path = document.querySelector(
            `.react-flow__edge[data-id="${edge}"] path.react-flow__edge-interaction`,
          );
          const point = path.getPointAtLength(path.getTotalLength() * fraction);
          const m = path.getScreenCTM();
          return { x: point.x * m.a + point.y * m.c + m.e, y: point.x * m.b + point.y * m.d + m.f };
        },
        { edge: id, fraction: at },
      );
    const pickEdge = async (id, at) => {
      const point = await edgePoint(id, at);
      await page.mouse.click(point.x, point.y);
      await page.getByTestId('inspector-edge').waitFor();
    };
    /** Draws a line by hand: from a box's lower dot to the dot (or the box) another one has. */
    const draw = async (from, to, targetHandle = 't', sourceHandle = 's') => {
      const start = await page
        .locator(
          `.react-flow__node[data-id="${from}"] .react-flow__handle[data-handleid="${sourceHandle}"]`,
        )
        .boundingBox();
      const end = await page
        .locator(
          `.react-flow__node[data-id="${to}"] .react-flow__handle[data-handleid="${targetHandle}"]`,
        )
        .boundingBox();
      await page.mouse.move(centerOf(start).x, centerOf(start).y);
      await page.mouse.down();
      await page.mouse.move(centerOf(end).x, centerOf(end).y, { steps: 12 });
      await page.mouse.up();
      await page.waitForTimeout(350);
    };

    // today's council opens on the canvas too, drawn as a council and with no list of members
    await go('#/models/default');
    await page.getByTestId('flow-designer').waitFor();
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
    assert.equal(
      await page.getByTestId('seat-list').count(),
      0,
      'a council has no list of members',
    );
    assert.equal(
      await page
        .locator('[data-testid=council-list] a[data-profile-id=default]')
        .getAttribute('aria-current'),
      'page',
    );

    // the new-council dialog offers the two starting points; the first is the plain council
    await page.getByTestId('profile-new').click();
    await page.getByTestId('template-choice').waitFor();
    assert.equal(
      await page.getByTestId('template-council').isChecked(),
      true,
      'a council is the default start',
    );
    await page.getByTestId('name-input').fill('Plain one');
    await page.getByTestId('name-ok').click();
    await until(async () => Boolean(await profileOf('plain-one')));
    assert.equal(
      (await profileOf('plain-one')).effective.flow,
      undefined,
      'the council template has no flow',
    );
    // a council made with the «Council» start opens on the canvas, as a council
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
    assert.equal(await nodeCount(), 7, 'Input, four members, the chairman and Output');
    assert.equal(await page.getByTestId('design-dialog').count(), 0, 'no question is asked');
    await page.getByTestId('profile-menu').click();
    await page.getByTestId('profile-delete').click();
    await page.getByTestId('confirm-delete-profile').click();
    await until(async () => !(await profileOf('plain-one')));
    await page.waitForFunction(() => window.location.hash === '#/models/default');

    step(
      'Models: One assistant creates a three-box model with direct rules; old council links redirect',
    );
    await page.getByTestId('profile-new').click();
    await page.getByTestId('template-single').waitFor();
    assert.equal(
      await page.getByRole('dialog').getByRole('heading').innerText(),
      'New Divan model',
    );
    await page.getByTestId('template-single').check();
    await page.getByTestId('name-input').fill('Single assistant');
    await page.getByTestId('name-ok').click();
    await page.waitForFunction(() => window.location.hash.startsWith('#/models/single-assistant'));
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.equal(await nodeCount(), 3);
    await pickNode('assistant');
    assert.match(await page.getByTestId('flow-inspector').innerText(), /Assistant/u);
    assert.equal(await entryOf('agent-prompt'), 'divan.direct');
    await go('#/councils/single-assistant?level=high');
    await page.waitForFunction(
      () => window.location.hash === '#/models/single-assistant?level=high',
    );
    assert.equal(await nodeCount(), 3);
    step('a single answer has neutral Context/Cost tabs and critique input in both languages');
    const singleProfile = await profileOf('single-assistant');
    const singleSession = await call('/sessions', 'POST', {
      profileId: singleProfile.id,
      revision: singleProfile.revision,
      fingerprint: singleProfile.levels.medium.fingerprint,
      level: 'medium',
      question: 'Explain one reversible next step.',
    });
    await until(async () => chairs(await sessionOf(singleSession.id)).at(-1).status === 'done');
    for (const lang of ['en', 'fa']) {
      await page.evaluate((value) => localStorage.setItem('divan-lang', value), lang);
      const latest = chairs(await sessionOf(singleSession.id)).at(-1);
      await page.goto(`${origin}/#/s/${singleSession.id}/n/${latest.id}`);
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('lang'), lang);
      await page.getByTestId('chair-panel').waitFor();
      await page.getByTestId('chip-context').click();
      await page.getByTestId('detail-tab-context').waitFor();
      assert.equal(await page.getByTestId('detail-tab-council').count(), 0);
      assert.equal(await page.getByTestId('members-english').count(), 0);
      assert.equal(await page.getByTestId('reveal-switch').count(), 0);
      await page.getByTestId('detail-tab-cost').click();
      await page.getByTestId('cost-tab').waitFor();
      await page.getByTestId('details-close').click();
      await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
      await page.getByTestId('critique').click();
      await idle();
      const next = Object.values((await sessionOf(singleSession.id)).nodes)
        .filter((node) => node.kind === 'next')
        .at(-1);
      await page.locator(`.react-flow__node[data-id="${next.id}"]`).dispatchEvent('click');
      await page.getByTestId('user-panel').waitFor();
      const critiqueText = await page.getByTestId('user-panel').innerText();
      assert.ok(
        critiqueText.includes(
          lang === 'en'
            ? 'You added nothing; the last answer was critiqued.'
            : 'نظری ندادید؛ آخرین پاسخ نقد شد.',
        ),
        `${lang}: ${critiqueText}`,
      );
    }
    await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
    await page.goto(`${origin}/#/models/single-assistant?level=high`);
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.getByTestId('profile-menu').click();
    await page.getByTestId('profile-delete').click();
    await page.getByTestId('confirm-delete-profile').click();
    await until(async () => !(await profileOf('single-assistant')));
    await page.waitForFunction(() => window.location.hash === '#/models/default');

    step(
      'a council edited on the canvas stays a council; a line or a writer asks first (Cancel changes nothing), and the save sends the design with the levels carried over',
    );
    await call('/profiles', 'POST', { name: 'Becomes design', id: 'becomes-design' });
    await call('/profiles/becomes-design', 'PUT', {
      overrides: { budgets: { maxWords: 17 } },
      levels: { high: { seats: { codex: { effort: 'low' } } } },
    });
    await go('#/models/becomes-design');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await page.waitForTimeout(400);
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
    // what a council can say is edited without a question: a model, a member off, a member added and removed
    await pickModel('claude', 'fake-slow');
    await box('grok');
    await page.getByTestId('agent-on').click();
    assert.equal(
      await page.locator('.react-flow__node[data-id="grok"] [data-testid=off-badge]').count(),
      1,
      'a member that is off is drawn off',
    );
    await page.getByTestId('palette-agent').click();
    await page.waitForTimeout(300);
    assert.equal(await nodeCount(), 8);
    assert.match(
      (await page.getByTestId('inspector-agent').getAttribute('data-agent-id')) ?? '',
      /^x/u,
      'the new member is selected',
    );
    await page.getByTestId('agent-delete').click();
    await page.waitForTimeout(300);
    assert.equal(await nodeCount(), 7);
    await box('codex');
    assert.equal(
      await page.getByTestId('agent-delete').count(),
      0,
      'a default member is switched off, not removed',
    );
    assert.equal(await page.getByTestId('agent-reset').count(), 1);
    assert.equal(await page.getByTestId('design-dialog').count(), 0, 'no question yet');
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
    // a line between two members is not a council's: the question says what changes
    const linesBefore = await edgeCount();
    await draw('claude', 'codex');
    await page.getByTestId('design-dialog').waitFor();
    assert.equal(
      (await page.getByTestId('design-dialog-text').innerText()).trim(),
      'This council becomes a design. At Low a design keeps all its steps and only lowers efforts; a council turns its slowest member off.',
    );
    assert.match(
      await page.getByTestId('design-dialog-limits').innerText(),
      /17 words per claim/u,
      'a council with its own answer limits says they give way',
    );
    await page.getByTestId('design-cancel').click();
    await page.getByTestId('design-dialog').waitFor({ state: 'detached' });
    assert.equal(await edgeCount(), linesBefore, 'Cancel draws nothing');
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'council');
    assert.match(await modelOf('claude'), /fake-slow/u, 'and keeps the edits a council can say');
    await draw('claude', 'codex');
    await page.getByTestId('design-dialog').waitFor();
    await page.getByTestId('design-continue').click();
    await page.getByTestId('design-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'design');
    assert.match(await page.getByTestId('mode-badge').innerText(), /^Design$/u);
    assert.equal(await page.locator('.react-flow__edge[data-id="claude>codex"]').count(), 1);
    assert.equal(
      await page.locator('.react-flow__edge[data-id="input>codex"]').count(),
      0,
      'codex is fed by the line now: Input needs none',
    );
    assert.equal((await profileOf('becomes-design')).effective.flow, undefined, 'not saved yet');
    await page.getByTestId('design-valid').waitFor();
    await box('claude');
    assert.equal(
      await entryOf('agent-prompt'),
      'divan.member',
      'a design selects the standard prompt',
    );
    // a level of a design that is not saved yet is drawn from it, read-only until Base is saved
    await page.getByTestId('tab-high').click();
    await page.getByTestId('base-first').waitFor();
    assert.equal(await page.locator('.react-flow__node[data-id="codex"]').count(), 1);
    await page.getByTestId('tab-base').click();
    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    const converted = await profileOf('becomes-design');
    assert.equal(converted.effective.flow.kind, 'custom');
    assert.equal(converted.effective.flow.nodes.find((n) => n.id === 'grok').enabled, false);
    assert.equal(converted.effective.flow.nodes.find((n) => n.id === 'claude').model, 'fake-slow');
    assert.deepEqual(
      converted.levels.high.overrides,
      { nodes: { codex: { effort: 'low' } } },
      'the level the council had is carried to the design’s agent',
    );
    assert.equal(
      converted.levels.low.effective.flow.nodes.filter((n) => n.enabled === false).length,
      1,
      'a design keeps all its steps at Low: only the one that was switched off is off',
    );
    // «Back to Divan's defaults» takes the design away too
    await openSettings();
    await page.getByTestId('reset-profile').click();
    assert.match(await page.getByTestId('confirm-dialog').innerText(), /stops being a design/u);
    await page.getByTestId('confirm-reset').click();
    await until(async () => (await profileOf('becomes-design')).effective.flow === undefined);
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=flow-designer]')?.dataset.mode === 'council',
    );
    assert.equal(Object.keys((await profileOf('becomes-design')).overrides).length, 0);
    assert.equal(await page.getByTestId('dirty-marker').count(), 0);
    await call('/profiles/becomes-design', 'DELETE');

    step('condition design: custom forms, library API, both branches on fakes');
    for (const form of branchLibrary.forms) await call('/library/forms', 'POST', form);
    for (const prompt of branchLibrary.prompts) await call('/library/prompts', 'POST', prompt);
    for (const [model, outcome] of [
      ['fake-1', true],
      ['fake-branch-low', false],
    ]) {
      const made = await call('/profiles', 'POST', { name: `Branch ${model}` });
      const updated = await call(`/profiles/${made.id}`, 'PUT', { flow: branchFlow(model) });
      assert.equal(updated.profiles.find((p) => p.id === made.id).blocked, undefined);
      const profile = await profileOf(made.id);
      const started = await call('/sessions', 'POST', {
        profileId: made.id,
        revision: profile.revision,
        fingerprint: profile.levels.medium.fingerprint,
        level: 'medium',
        question: 'Choose a reversible next step.',
      });
      assert.ok(started.id, JSON.stringify(started));
      await until(async () => chairs(await sessionOf(started.id)).at(-1).status !== 'running');
      const round = chairs(await sessionOf(started.id)).at(-1);
      assert.equal(round.status, 'done');
      assert.equal(round.steps.find((s) => s.id === 'decision').result, outcome);
      assert.equal(round.steps.find((s) => s.id === (outcome ? 'yes' : 'no')).run.state, 'done');
      assert.equal(
        round.steps.find((s) => s.id === (outcome ? 'no' : 'yes')).run.error,
        'inactive_branch',
      );
      const library = await call('/library');
      assert.ok(library.forms.find((f) => f.id === 'assessment').usedBy.includes(made.id));
      const refused = await call('/library/forms/assessment', 'DELETE');
      assert.equal(refused.error, 'library_in_use');
      await call(`/sessions/${started.id}`, 'DELETE');
      await call(`/profiles/${made.id}`, 'DELETE');
    }

    step(
      'conditional data wire: build draft → judge → condition, direct Yes or rewritten No, with one final',
    );
    // These long wires share their first stretch; dispatch to the exact line instead of guessing a crossing.
    const pickWire = async (id) => {
      await page
        .locator(`.react-flow__edge[data-id="${id}"] path.react-flow__edge-interaction`)
        .dispatchEvent('click');
      await page.getByTestId('inspector-edge').waitFor();
    };
    const drawWire = async (from, to, target = 't', source = 's') => {
      await page.getByTestId('design-fit').click();
      await page.waitForTimeout(500);
      await draw(from, to, target, source);
      const id = source === 'yes' || source === 'no' ? `${from}:${source}>${to}` : `${from}>${to}`;
      await page.locator(`.react-flow__edge[data-id="${id}"]`).waitFor({ state: 'attached' });
    };
    await call('/profiles', 'POST', {
      name: 'Conditional draft',
      id: 'conditional-draft',
      template: 'single',
    });
    await go('#/models/conditional-draft');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.getByTestId('palette-agent').click();
    await pickEntry('agent-form', 'report');
    await page.getByTestId('agent-name').fill('Draft');
    await page.getByTestId('palette-agent').click();
    await pickEntry('agent-form', 'assessment');
    await page.getByTestId('agent-name').fill('Judge');
    await drawWire('agent', 'agent2');
    await pickWire('agent2>assistant');
    await page.getByTestId('edge-delete').click();
    await page.getByTestId('palette-condition').click();
    await drawWire('agent2', 'condition');
    await pickNode('condition');
    await page.getByTestId('rule-add').click();
    await pick('rule-op-0', '≥ at least');
    await page.getByTestId('rule-value-0').fill('5');
    await page.getByTestId('palette-agent').click();
    await pickEntry('agent-form', 'report');
    await page.getByTestId('agent-name').fill('Rewrite');
    await drawWire('condition', 'agent3', 't', 'no');
    await drawWire('agent', 'agent3');
    await drawWire('agent2', 'agent3');
    await pickWire('agent2>agent3');
    await page.getByTestId('edge-role-required').click();
    await pickWire('agent>assistant');
    assert.equal(await page.getByTestId('edge-when').innerText(), 'Always');
    await page.getByTestId('edge-when').click();
    await page.getByTestId('edge-when-condition-yes').click();
    await page.getByTestId('edge-role-group').click();
    await pickWire('agent3>assistant');
    await page.getByTestId('edge-role-group').click();
    await page.getByTestId('design-valid').waitFor();
    assert.equal(
      await nodeCount(),
      7,
      'four agents, one condition, input and output; no pass-through',
    );
    assert.equal(await page.getByTestId('when-chip').innerText(), 'only if Yes');
    await pickWire('agent>agent2');
    await page.getByTestId('edge-when').click();
    assert.equal(
      await page.getByTestId('edge-when-condition-yes').count(),
      0,
      'the judge cannot wait on its own decision',
    );
    await page.getByTestId('edge-when-always').click();
    for (const [threshold, outcome] of [
      [5, true],
      [8, false],
    ]) {
      await pickNode('condition');
      await page.getByTestId('rule-value-0').fill(String(threshold));
      await page.getByTestId('save-profile').click();
      await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
      const profile = await profileOf('conditional-draft');
      const flow = profile.effective.flow;
      assert.deepEqual(
        flow.edges.find((edge) => edge.from === 'agent' && edge.to === 'assistant').when,
        { condition: 'condition', exit: 'yes' },
      );
      assert.deepEqual(flow.nodes.find((node) => node.id === 'assistant').responses, {
        ids: ['agent', 'agent3'],
        min: 1,
      });
      assert.deepEqual(flow.nodes.find((node) => node.id === 'agent3').required, [
        'agent',
        'agent2',
      ]);
      const started = await call('/sessions', 'POST', {
        profileId: profile.id,
        revision: profile.revision,
        fingerprint: profile.levels.medium.fingerprint,
        level: 'medium',
        question: 'Choose a reversible next step.',
      });
      assert.ok(started.id, JSON.stringify(started));
      await until(async () => chairs(await sessionOf(started.id)).at(-1).status !== 'running');
      const round = chairs(await sessionOf(started.id)).at(-1);
      assert.equal(round.status, 'done');
      assert.equal(round.steps.find((step) => step.id === 'condition').result, outcome);
      assert.deepEqual(round.steps.find((step) => step.id === 'assistant').inputs, [
        outcome ? 'agent' : 'agent3',
      ]);
      assert.equal(round.attempts.length, outcome ? 3 : 4);
      const input = round.steps.find((step) => step.id === 'assistant').run.input;
      const aliases = round.steps.find((step) => step.id === 'assistant').aliases;
      assert.equal(input.includes(`<<<UPSTREAM ${aliases.agent} `), outcome);
      await drop(started.id);
    }
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await pickWire('agent>assistant');
    assert.match(await page.getByTestId('edge-when').innerText(), /Yes/u);
    await call('/profiles/conditional-draft', 'DELETE');

    step(
      'Library: two tabs; a built-in entry is read-only; a prompt and an output form are made, moved, saved; the conflict screen; the leave guard; a copy of a built-in',
    );
    const items = () => page.locator('[data-testid=library-item]');
    const item = (id) => page.locator(`[data-testid=library-item][data-entry-id="${id}"]`);
    const fieldNames = () =>
      page.locator('[data-testid=field-name]').evaluateAll((list) => list.map((el) => el.value));
    const pickLike = async (testid, text) => {
      await page.getByTestId(testid).click();
      await page
        .locator('[data-slot=select-content][data-open] [role=option]')
        .filter({ hasText: text })
        .first()
        .click();
      await page.waitForFunction(
        () => !document.querySelector('[data-slot=select-content][data-open]'),
      );
    };
    await go('#/library');
    await page.getByTestId('library').waitFor();
    assert.equal(await page.getByTestId('library').getAttribute('data-tab'), 'prompts');
    assert.equal(await page.getByTestId('page-title').innerText(), 'Library');
    for (const id of [
      'divan.member',
      'divan.chairman',
      'divan.direct',
      'divan.report',
      'divan.critic',
    ]) {
      await item(id).waitFor();
      assert.equal(await item(id).count(), 1, `${id} is listed`);
    }
    // a built-in prompt is read-only: Duplicate, no Delete, no Save
    await item('divan.chairman').click();
    await page.getByTestId('entry-builtin-note').waitFor();
    assert.equal(await page.getByTestId('prompt-text').getAttribute('readonly'), '');
    assert.equal(await page.getByTestId('entry-duplicate').count(), 1);
    assert.equal(await page.getByTestId('entry-delete').count(), 0);
    assert.equal(await page.getByTestId('savebar').count(), 0);
    assert.match(await page.getByTestId('entry-used-by').innerText(), /Default/u);

    // a new prompt: the id follows the name; it cannot be saved without its text
    await page.getByTestId('library-new').click();
    await page.getByTestId('entry-name').fill('Assess strictly');
    assert.equal(await page.getByTestId('entry-id-input').inputValue(), 'assess-strictly');
    assert.equal(await page.getByTestId('entry-save').isDisabled(), true);
    assert.match(await page.getByTestId('save-blocker').innerText(), /prompt text/u);
    await page
      .getByTestId('prompt-text')
      .fill('Judge the question strictly. Return the requested fields only.');
    assert.equal(
      await page.getByTestId('prompt-length').innerText(),
      `${'Judge the question strictly. Return the requested fields only.'.length} / 64,000`,
    );
    await page.getByTestId('entry-save').click();
    await page.waitForFunction(() => window.location.hash === '#/library/prompts/assess-strictly');
    await item('assess-strictly').waitFor();
    let lib = await call('/library');
    assert.equal(
      lib.prompts.find((p) => p.id === 'assess-strictly').text,
      'Judge the question strictly. Return the requested fields only.',
    );

    // a new output form: a field builder
    await page.getByTestId('library-tab-forms').click();
    await page.waitForFunction(() => window.location.hash === '#/library/forms');
    for (const id of ['report', 'member', 'answer']) {
      await item(id).waitFor();
      assert.equal(await item(id).count(), 1, `${id} form is listed`);
    }
    await page.getByTestId('library-new').click();
    await page.getByTestId('entry-name').fill('Verdict');
    assert.equal(
      await page.getByTestId('field-row').count(),
      1,
      'a new form has one field to fill in',
    );
    await page.getByTestId('field-name').fill('Bad name');
    assert.match(await page.getByTestId('field-problem').innerText(), /lower-case letters/u);
    assert.equal(await page.getByTestId('entry-save').isDisabled(), true);
    await page.getByTestId('field-name').fill('score');
    await pick('field-type', 'Number');
    await page.getByTestId('field-description').fill('Score from 0 to 10');
    await page.getByTestId('field-min').fill('0');
    await page.getByTestId('field-max').fill('10');
    await page.getByTestId('field-add').click();
    const second = page.getByTestId('field-row').nth(1);
    await second.getByTestId('field-name').fill('verdict');
    await second.getByTestId('field-type').click();
    await page
      .locator('[data-slot=select-content][data-open]')
      .getByRole('option', { name: 'Choice', exact: true })
      .click();
    assert.match(
      await second.getByTestId('field-problem').innerText(),
      /1 to 50 different options/u,
      'a choice with no option says so',
    );
    await second.getByTestId('field-options').fill('pass\nfail');
    assert.equal(await page.getByTestId('field-problem').count(), 0);
    // the fields move
    await page.getByTestId('field-row').nth(0).getByTestId('field-down').click();
    assert.deepEqual(await fieldNames(), ['verdict', 'score']);
    await page.getByTestId('field-row').nth(1).getByTestId('field-up').click();
    assert.deepEqual(await fieldNames(), ['score', 'verdict']);
    // the preview is the schema the server sends: no local limits in it, the choice as an enum
    await page.getByTestId('schema-toggle').click();
    const schemaText = await page.getByTestId('schema-json').innerText();
    assert.match(schemaText, /"score"/u);
    assert.match(schemaText, /"enum"/u);
    assert.doesNotMatch(schemaText, /minimum/u);
    await page.getByTestId('entry-save').click();
    await page.waitForFunction(() => window.location.hash === '#/library/forms/verdict');
    await item('verdict').waitFor();
    lib = await call('/library');
    assert.deepEqual(lib.forms.find((f) => f.id === 'verdict').fields, [
      {
        name: 'score',
        type: 'number',
        description: 'Score from 0 to 10',
        required: true,
        min: 0,
        max: 10,
      },
      {
        name: 'verdict',
        type: 'choice',
        description: '',
        required: true,
        options: ['pass', 'fail'],
      },
    ]);
    await item('member').waitFor();
    assert.equal(await item('member').count(), 1);

    // an entry changed somewhere else: the edits stay; keep mine (the next save replaces the other), or load the other
    await go('#/library/prompts/assess-strictly');
    await page.getByTestId('prompt-text').fill('My stricter text.');
    const revision = () =>
      call('/library').then((l) => l.prompts.find((p) => p.id === 'assess-strictly'));
    const other = await call('/library/prompts/assess-strictly', 'PUT', {
      ifRevision: (await revision()).revision,
      text: 'Text from another page.',
    });
    assert.ok(other.prompts, 'the other page saved');
    await page.getByTestId('entry-save').click();
    await page.getByTestId('save-conflict').waitFor();
    assert.equal(await page.getByTestId('prompt-text').inputValue(), 'My stricter text.');
    assert.equal(
      await page.getByTestId('entry-save').count(),
      0,
      'no save until the person chooses',
    );
    await page.getByTestId('conflict-keep').click();
    await page.getByTestId('entry-save').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    assert.equal((await revision()).text, 'My stricter text.');
    await page.getByTestId('prompt-text').fill('Third text.');
    await call('/library/prompts/assess-strictly', 'PUT', {
      ifRevision: (await revision()).revision,
      text: 'Fourth, from elsewhere.',
    });
    await page.getByTestId('entry-save').click();
    await page.getByTestId('save-conflict').waitFor();
    await page.getByTestId('conflict-load').click();
    await page.getByTestId('confirm-reload').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid=prompt-text]')?.value === 'Fourth, from elsewhere.',
    );
    assert.equal(await page.getByTestId('dirty-marker').count(), 0);
    assert.equal((await revision()).text, 'Fourth, from elsewhere.');
    // restore the text of the entry (the design below reads it)
    await page
      .getByTestId('prompt-text')
      .fill('Judge the question strictly. Return the requested fields only.');
    await page.getByTestId('entry-save').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();

    // an edit that is not saved: a link asks first; Cancel keeps it, Discard changes goes
    await page.getByTestId('entry-name').fill('Assess very strictly');
    await item('check').click();
    await page.getByTestId('leave-dialog').waitFor();
    await page.getByTestId('leave-stay').click();
    assert.equal(await page.getByTestId('entry-name').inputValue(), 'Assess very strictly');
    assert.equal(
      await page.evaluate(() => window.location.hash),
      '#/library/prompts/assess-strictly',
    );
    await item('check').click();
    await page.getByTestId('leave-dialog').waitFor();
    await page.getByTestId('leave-discard').click();
    await page.waitForFunction(() => window.location.hash === '#/library/prompts/check');

    // a copy of a built-in prompt; a copy of a built-in form with nested fields says why it cannot be made
    await go('#/library/prompts/divan.report');
    await page.getByTestId('entry-duplicate').click();
    await page.getByTestId('new-entry-dialog').waitFor();
    assert.equal(await page.getByTestId('new-entry-id').inputValue(), 'copy-of-report-writer');
    await page.getByTestId('new-entry-ok').click();
    await page.waitForFunction(
      () => window.location.hash === '#/library/prompts/copy-of-report-writer',
    );
    assert.match(
      await page.getByTestId('prompt-text').inputValue(),
      /report/iu,
      'the copy has the text of the built-in prompt',
    );
    await page.getByTestId('entry-delete').click();
    await page.getByTestId('confirm-delete-entry').click();
    await page.waitForFunction(() => window.location.hash === '#/library/prompts');
    await item('copy-of-report-writer').waitFor({ state: 'detached' });
    assert.equal(await item('copy-of-report-writer').count(), 0, 'an unused entry is deleted');
    await go('#/library/forms/member');
    await item('member').waitFor();
    const formsListed = await items().count();
    await page.getByTestId('entry-duplicate').click();
    await page.getByTestId('new-entry-ok').click();
    await page.getByTestId('new-entry-problem').waitFor();
    assert.match(
      await page.getByTestId('new-entry-problem').innerText(),
      /nested fields .* cannot be duplicated/u,
    );
    await page.getByTestId('new-entry-dialog').getByRole('button', { name: 'Cancel' }).click();
    await page.getByTestId('new-entry-dialog').waitFor({ state: 'detached' });
    assert.equal(await items().count(), formsListed, 'nothing was made');

    step(
      'a condition in a design: added from the palette, read from an agent, its rules in words, Yes and No wired, fields picked on a wire, saved, run, and checked in plain words',
    );
    await call('/profiles', 'POST', { name: 'Branching', id: 'branching', template: 'single' });
    await go('#/models/branching');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.match(
      await page.getByTestId('max-calls').innerText(),
      /^up to 1 assistant call a round$/u,
      'the header says the most calls a round makes',
    );
    assert.match(
      await page.locator('[data-profile-id=branching]').getAttribute('title'),
      /up to 1 assistant call a round/u,
      'and so does the tooltip of the models strip',
    );
    // an assessor: it answers with the form «Verdict» and the prompt «Assess strictly»
    await page.getByTestId('palette-agent').click();
    await page.getByTestId('inspector-agent').waitFor();
    assert.match(
      await page.getByTestId('max-calls').innerText(),
      /up to 2 assistant calls a round/u,
    );
    assert.equal(await entryOf('agent-form'), 'member');
    await pickEntry('agent-form', 'verdict');
    assert.notEqual(
      await entryOf('agent-prompt'),
      'divan.member',
      'a prompt that fits the form is chosen',
    );
    // only the prompts that fit are listed; the others are one click away
    await page.getByTestId('agent-prompt').click();
    assert.equal(
      await page
        .locator('[data-testid=agent-prompt-list] [data-entry-id="divan.chairman"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator('[data-testid=agent-prompt-list] [data-entry-id="assess-strictly"]')
        .count(),
      1,
    );
    assert.equal(
      await page.locator('[data-testid=agent-prompt-list] [data-entry-id="divan.member"]').count(),
      0,
      'the prompts written for another form are left out',
    );
    await page.locator('[data-testid=agent-prompt-list] [data-testid=picker-show-all]').click();
    assert.equal(
      await page
        .locator('[data-testid=agent-prompt-list] [data-entry-id="divan.chairman"]')
        .count(),
      1,
      'Show all lists the others too',
    );
    await page.locator('[data-testid=agent-prompt-list] [data-entry-id="assess-strictly"]').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid=agent-prompt]')?.dataset.value === 'assess-strictly',
    );
    assert.match(await page.getByTestId('agent-prompt-name').innerText(), /^Assess strictly$/u);
    assert.match(
      await page.getByTestId('inspector-agent').innerText(),
      /Agent · answers as a member|Verdict/u,
    );

    // the condition: not joined yet, so the design says so; then it reads the assessor
    await page.getByTestId('palette-condition').click();
    await page.getByTestId('inspector-condition').waitFor();
    assert.equal(
      await page.getByTestId('design-problem').getAttribute('data-reason'),
      'unreachable or dead end',
    );
    assert.match(
      await page.getByTestId('condition-no-input').innerText(),
      /Nothing is joined yet/u,
    );
    // a box that was just added is framed by the view for a moment: its dots are drawn at when it has settled
    await page.waitForTimeout(600);
    await draw('agent', 'condition');
    assert.equal(await page.locator('.react-flow__edge[data-id="agent>condition"]').count(), 1);
    // a line the editor refuses says why: Input has no fields to check
    await draw('input', 'condition');
    assert.match(
      await page.getByTestId('design-refused').innerText(),
      /Your question has no fields/u,
    );
    await page.locator('.react-flow__node[data-id="condition"]').click();
    await page.getByTestId('inspector-condition').waitFor();
    assert.match(await page.getByTestId('condition-source').innerText(), /Member/u);
    assert.match(await page.getByTestId('condition-no-rules').innerText(), /No rule yet/u);
    await page.getByTestId('rule-add').click();
    assert.match(
      await page.locator('.react-flow__node[data-id="condition"]').innerText(),
      /score\s*<\s*0/u,
      'the box says the rule in words',
    );
    await pick('rule-op-0', '≥ at least');
    await page.getByTestId('rule-value-0').fill('5');
    assert.match(
      await page
        .locator('.react-flow__node[data-id="condition"] [data-testid=condition-rule]')
        .innerText(),
      /score\s*≥\s*5/u,
    );
    // a second rule on a choice field, any or all of them; then it is taken away again
    await page.getByTestId('rule-add').click();
    await pickLike('rule-field-1', 'verdict');
    assert.match(
      await page
        .locator('.react-flow__node[data-id="condition"] [data-testid=condition-rule]')
        .innerText(),
      /score\s*≥\s*5 and verdict is pass/u,
    );
    await page.getByTestId('mode-any').click();
    assert.match(
      await page
        .locator('.react-flow__node[data-id="condition"] [data-testid=condition-rule]')
        .innerText(),
      /score\s*≥\s*5 or verdict is pass/u,
    );
    await page.getByTestId('rule-remove-1').click();
    assert.equal(await page.getByTestId('rule-row').count(), 1);
    assert.equal(
      await page.getByTestId('condition-mode').count(),
      0,
      'one rule needs no «all or any»',
    );
    assert.match(await page.getByTestId('condition-failed').innerText(), /is No\.$/u);
    assert.match(await page.getByTestId('exit-yes').innerText(), /leads nowhere yet/u);

    // two writers, one for each exit: Yes and No are drawn from the condition's own dots
    await page.getByTestId('palette-agent').click();
    await pickEntry('agent-form', 'report');
    await page.getByTestId('palette-agent').click();
    await pickEntry('agent-form', 'report');
    assert.equal(
      await nodeCount(),
      7,
      'Input, the assessor, the condition, two writers, the final agent and Output',
    );
    await page.waitForTimeout(600);
    await draw('condition', 'agent2', 't', 'yes');
    await draw('condition', 'agent3', 't', 'no');
    assert.equal(
      await page.locator('.react-flow__edge[data-id="condition:yes>agent2"]').count(),
      1,
    );
    assert.equal(await page.locator('.react-flow__edge[data-id="condition:no>agent3"]').count(), 1);
    assert.deepEqual(
      await page
        .locator('[data-testid=gate-chip]')
        .evaluateAll((list) => list.map((el) => el.dataset.gate).sort()),
      ['no', 'yes'],
      'a gate is drawn with its Yes or No',
    );
    // a line from a Yes dot to the same box twice, to Output, or back is refused with its reason
    await page.getByTestId('design-fit').click();
    await page.waitForTimeout(500);
    await draw('condition', 'output', 't', 'yes');
    assert.match(
      await page.getByTestId('design-refused').innerText(),
      /not straight to the answer/u,
    );
    // the two answers of the final agent are alternatives: «one of the answers», and at least one is enough
    await page.locator('.react-flow__node[data-id="assistant"]').click();
    await page.getByTestId('response-group').waitFor();
    assert.equal(await page.getByTestId('group-min').innerText(), '1');
    await page.getByTestId('design-valid').waitFor();
    assert.match(
      await page.getByTestId('max-calls').innerText(),
      /up to 4 assistant calls a round/u,
    );

    // the fields of a line: all, or the ones ticked (the receiving agent sees nothing else); the line says so
    await pickEdge('agent>assistant', 0.55);
    await page.getByTestId('edge-fields-some').click();
    assert.equal(await page.getByTestId('edge-field-score').isChecked(), true);
    await page.getByTestId('edge-field-verdict').uncheck();
    assert.equal(
      await page.getByTestId('edge-field-score').isDisabled(),
      true,
      'a line carries one field at least',
    );
    assert.match(await page.getByTestId('fields-chip').innerText(), /^1 of 2 fields$/u);
    await page.getByTestId('edge-fields-all').click();
    assert.equal(await page.getByTestId('fields-chip').count(), 0);
    await page.getByTestId('edge-fields-some').click();
    await page.getByTestId('edge-field-verdict').uncheck();
    // how the final agent uses each answer: the two sides of the condition are alternatives
    await pickEdge('agent2>assistant', 0.5);
    assert.equal(await page.getByTestId('edge-role-group').getAttribute('aria-pressed'), 'true');
    assert.equal(
      await page.getByTestId('edge-fields-all').count(),
      0,
      'a report has no fields to pick',
    );
    // a gate: what it means
    await pickEdge('condition:yes>agent2', 0.5);
    assert.match(
      await page.getByTestId('inspector-edge').innerText(),
      /runs only when .* says Yes/u,
    );
    assert.equal(await page.getByTestId('inspector-edge').getAttribute('data-gate'), 'yes');

    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    const branching = await profileOf('branching');
    const saved = branching.effective.flow;
    assert.equal(saved.nodes.find((n) => n.kind === 'condition').rules[0].op, '>=');
    assert.deepEqual(saved.edges.find((e) => e.from === 'agent' && e.to === 'assistant').fields, [
      'score',
    ]);
    assert.deepEqual(saved.nodes.find((n) => n.id === 'assistant').responses, {
      ids: ['agent2', 'agent3'],
      min: 1,
    });
    assert.equal(branching.blocked, undefined);
    assert.equal(branching.levels.medium.blocked, undefined);

    // it runs on the fakes: the assessor scores 5, so the Yes side writes and the No side is skipped
    const startedBranch = await call('/sessions', 'POST', {
      profileId: 'branching',
      revision: branching.revision,
      fingerprint: branching.levels.medium.fingerprint,
      level: 'medium',
      question: 'Choose a reversible next step.',
    });
    assert.ok(startedBranch.id, JSON.stringify(startedBranch));
    await until(async () => chairs(await sessionOf(startedBranch.id)).at(-1).status !== 'running');
    const branchRound = chairs(await sessionOf(startedBranch.id)).at(-1);
    assert.equal(branchRound.status, 'done');
    assert.equal(branchRound.steps.find((s) => s.id === 'condition').result, true);
    assert.equal(branchRound.steps.find((s) => s.id === 'agent2').run.state, 'done');
    assert.equal(branchRound.steps.find((s) => s.id === 'agent3').run.error, 'inactive_branch');
    await drop(startedBranch.id);

    // the Library knows who uses an entry: its models are links, and a used entry cannot be deleted
    await go('#/library/forms/verdict');
    await page.getByTestId('entry-used-by').waitFor();
    assert.equal(
      await page.locator('[data-testid=used-by-model][data-model-id=branching]').count(),
      1,
      'the form is used by the model',
    );
    await page.getByTestId('entry-delete').click();
    await page.getByTestId('confirm-delete-entry').click();
    await page.getByTestId('in-use-dialog').waitFor();
    assert.equal(
      await page.locator('[data-testid=in-use-models] a[data-model-id=branching]').count(),
      1,
      'the refusal names the models that use it',
    );
    assert.match(
      await page.getByTestId('in-use-dialog').innerText(),
      /cannot be deleted while something uses it/u,
    );
    await page.getByTestId('in-use-close').click();
    assert.ok(
      (await call('/library')).forms.find((f) => f.id === 'verdict'),
      'still there',
    );
    await go('#/library/prompts/assess-strictly');
    assert.equal(
      await page.locator('[data-testid=used-by-model][data-model-id=branching]').count(),
      1,
      'and the prompt is used by it',
    );
    await page.locator('[data-testid=used-by-model][data-model-id=branching]').click();
    await page.waitForFunction(() => window.location.hash === '#/models/branching');
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });

    // «Open in Library» and «New from this…» in the pickers
    await box('agent');
    await page.getByTestId('agent-prompt').click();
    await page.locator('[data-testid=agent-prompt-list] [data-testid=picker-open-library]').click();
    await page.waitForFunction(() => window.location.hash === '#/library/prompts/assess-strictly');
    await page.goBack();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await box('agent');
    await page.getByTestId('agent-prompt').click();
    await page.locator('[data-testid=agent-prompt-list] [data-testid=picker-new-from]').click();
    await page.getByTestId('new-entry-name').fill('Assess strictly, second');
    await page.getByTestId('new-entry-ok').click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid=agent-prompt]')?.dataset.value ===
        'assess-strictly-second',
    );
    assert.ok(
      (await call('/library')).prompts.find((p) => p.id === 'assess-strictly-second'),
      'the copy exists in the Library',
    );
    await page.getByTestId('dirty-marker').waitFor();
    await page.getByTestId('cancel-changes').click();
    await page.getByTestId('dirty-marker').waitFor({ state: 'detached' });

    // the new checks appear on the canvas, in plain words, with the boxes they are about marked
    await pickEdge('condition:no>agent3', 0.5);
    await page.getByTestId('edge-delete').click();
    await page.getByTestId('design-problem').waitFor();
    assert.equal(
      await page.getByTestId('design-problem').getAttribute('data-reason'),
      'condition exits',
    );
    assert.match(
      await page.getByTestId('design-problem').innerText(),
      /“Condition” needs a line for Yes and a line for No\./u,
    );
    assert.equal(
      await page.locator('[data-testid=design-node][data-node-id=condition][data-problem]').count(),
      1,
      'the condition is marked',
    );
    assert.equal(await page.getByTestId('save-profile').isDisabled(), true);
    await page.getByTestId('design-problem-show').click();
    await page.getByTestId('inspector-condition').waitFor();
    await page.getByTestId('cancel-changes').click();
    await page.getByTestId('design-valid').waitFor();
    // the assessor's form changes to one without the field the rule checks
    await box('agent');
    await pickEntry('agent-form', 'member');
    await page.getByTestId('design-problem').waitFor();
    assert.equal(
      await page.getByTestId('design-problem').getAttribute('data-reason'),
      'condition field',
    );
    assert.match(
      await page.getByTestId('design-problem').innerText(),
      /“Condition” checks a field that “Member” does not have/u,
    );
    assert.equal(
      await page.locator('[data-testid=design-node][data-node-id=agent][data-problem]').count(),
      1,
    );
    await page.getByTestId('design-problem-show').click();
    assert.equal(
      (await page.getByTestId('rule-problem').count()) > 0,
      true,
      'the rule that cannot be checked says so',
    );
    await page.getByTestId('cancel-changes').click();
    await page.getByTestId('design-valid').waitFor();
    // at a level nothing of the condition is edited
    await page.getByTestId('tab-low').click();
    await page.getByTestId('level-note').waitFor();
    await page.locator('.react-flow__node[data-id="condition"]').click();
    await page.getByTestId('inspector-condition').waitFor();
    assert.equal(await page.getByTestId('rule-add').isDisabled(), true);
    assert.equal(await page.getByTestId('condition-delete').isDisabled(), true);
    await page.getByTestId('tab-base').click();
    await call('/profiles/branching', 'DELETE');

    step(
      'the Library and a condition in Persian: right to left, the Yes at the start, the call count',
    );
    await call('/profiles', 'POST', { name: 'شرط‌دار', id: 'faranch', template: 'single' });
    await page.evaluate(() => localStorage.setItem('divan-lang', 'fa'));
    await go('#/library/forms');
    await page.reload();
    await page.getByTestId('library').waitFor();
    assert.equal(await page.getByTestId('page-title').innerText(), 'کتابخانه');
    assert.equal(await page.getByTestId('library-tab-forms').innerText(), 'شکل‌های خروجی');
    assert.equal(await page.getByTestId('library-tab-prompts').innerText(), 'پرامپت‌ها');
    await item('verdict').click();
    await page.getByTestId('field-row').first().waitFor();
    assert.equal(await page.getByTestId('entry-delete').innerText(), 'پاک‌کردن');
    await go('#/models/faranch');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.match(
      await page.getByTestId('max-calls').innerText(),
      /^حداکثر 1 اجرای دستیار در هر دور$/u,
    );
    assert.equal(await page.getByTestId('palette-condition').innerText(), 'شرط');
    await page.getByTestId('palette-condition').click();
    await page.getByTestId('inspector-condition').waitFor();
    // the names in a Persian sentence are isolated (U+2068 to U+2069): the words around them read the same without
    assert.match(
      (await page.getByTestId('design-problem').innerText()).replace(/[⁦-⁩]/gu, ''),
      /^«شرط» وصل نیست/u,
    );
    const yes = await page.locator('[data-node-id=condition] [data-exit=yes]').boundingBox();
    const no = await page.locator('[data-node-id=condition] [data-exit=no]').boundingBox();
    assert.ok(yes.x > no.x, 'in Persian the Yes sits at the start, on the right');
    await call('/profiles/faranch', 'DELETE');
    await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await call('/library/forms/verdict', 'DELETE');
    await call('/library/prompts/assess-strictly-second', 'DELETE');
    await call('/library/prompts/assess-strictly', 'DELETE');
    await go('#/models/default');
    await page.getByTestId('flow-designer').waitFor();

    step('a writer added to a council asks first; in Persian the question is in Persian');
    await call('/profiles', 'POST', { name: 'Writer start', id: 'writer-start' });
    await page.evaluate(() => localStorage.setItem('divan-lang', 'fa'));
    await go('#/models/writer-start');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await page.getByTestId('palette-writer').click();
    await page.getByTestId('design-dialog').waitFor();
    assert.equal(
      (await page.getByTestId('design-dialog-text').innerText()).trim(),
      'این شورا به یک طرح تبدیل می‌شود. در سطح «کم» طرح همهٔ گام‌هایش را نگه می‌دارد و فقط استدلال‌ها را کم می‌کند؛ شورا کندترین عضو را خاموش می‌کند.',
    );
    await page.getByTestId('design-cancel').click();
    await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await page.getByTestId('palette-writer').click();
    await page.getByTestId('design-dialog').waitFor();
    await page.getByTestId('design-continue').click();
    await page.getByTestId('design-dialog').waitFor({ state: 'detached' });
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-mode'), 'design');
    assert.equal(await nodeCount(), 8, 'a writer was added');
    await page.getByTestId('design-valid').waitFor();
    assert.equal(await page.getByTestId('inspector-agent').getAttribute('data-agent-id'), 'agent');
    assert.equal(await entryOf('agent-form'), 'report');
    await page.getByTestId('cancel-changes').click();
    await page.waitForFunction(
      () => document.querySelector('[data-testid=flow-designer]')?.dataset.mode === 'council',
    );
    assert.equal(await nodeCount(), 7, 'Discard brings the council back');
    await call('/profiles/writer-start', 'DELETE');

    step('Quick never becomes a design: what would make it one is off, with one line');
    await go('#/models/quick');
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.match(
      await page.getByTestId('council-note').innerText(),
      /cannot become a design\. Duplicate it to design one\./u,
    );
    assert.equal(await page.getByTestId('palette-writer').isDisabled(), true);
    const quickSeats = (await profileOf('quick')).effective.seats.filter((item) => item.enabled);
    await box(quickSeats[0].id);
    assert.equal(await page.getByTestId('council-edit-form').count(), 0);
    assert.equal(await page.getByTestId('council-no-design').count(), 1);
    await box('chairman');
    assert.equal(await page.getByTestId('group-more').isDisabled(), true);
    const quickLines = await edgeCount();
    await draw(quickSeats[0].id, quickSeats[1].id);
    assert.equal(await page.getByTestId('design-dialog').count(), 0);
    assert.equal(await edgeCount(), quickLines, 'no line is drawn');
    assert.equal(await page.getByTestId('dirty-marker').count(), 0);
    await go('#/models/default');
    await page.getByTestId('flow-designer').waitFor();

    await page.getByTestId('profile-new').click();
    await page.getByTestId('name-input').fill('Draft and critics');
    await page.getByTestId('template-writer-critics').check();
    await page.getByTestId('name-ok').click();
    await until(async () => Boolean(await profileOf('draft-and-critics')));
    await page.waitForFunction(() => window.location.hash.startsWith('#/models/draft-and-critics'));
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    assert.equal(await page.getByTestId('seat-list').count(), 0, 'a design has no list of members');
    assert.equal(await nodeCount(), 8, 'Input, a writer, four critics, a rewriter and Output');
    assert.equal(
      await edgeCount(),
      11,
      'the lines that are drawn (Input needs no line to a critic)',
    );
    await page.getByTestId('design-valid').waitFor();
    assert.match(await page.getByTestId('group-chip').innerText(), /At least 2 of 4 · anonymous/u);
    assert.match(await page.getByTestId('required-chip').innerText(), /Draft · required/u);
    assert.equal(await page.getByTestId('design-palette').count(), 1);
    assert.match(await page.getByTestId('flow-inspector').innerText(), /Select an agent/u);
    assert.equal(
      (await page
        .locator('[data-testid=council-list] a[data-profile-id=draft-and-critics] svg')
        .count()) > 0,
      true,
    );

    step(
      'the inspector edits an agent; a name and a prompt are unsaved changes, and undo brings the prompt back',
    );
    await call('/library/prompts', 'POST', {
      id: 'e2e-report',
      name: 'Evidence report',
      from: 'divan.report',
      text: 'Write a report and name your sources.',
    });
    await pickNode('writer');
    assert.equal(await page.getByTestId('inspector-agent').getAttribute('data-agent-id'), 'writer');
    assert.match(
      await page.getByTestId('inspector-agent').innerText(),
      /Read-only · never writes/u,
    );
    assert.match(await page.getByTestId('inspector-agent').innerText(), /anonymity|Pi has no web/u);
    assert.equal(await entryOf('agent-form'), 'report');
    await page.getByTestId('agent-name').fill('Drafter');
    await page.getByTestId('dirty-marker').waitFor();
    assert.match(
      await page.locator('.react-flow__node[data-id="writer"]').innerText(),
      /Drafter/u,
      'the box shows the name',
    );
    await pickEntry('agent-form', 'assessment');
    assert.match(await page.getByTestId('inspector-agent').innerText(), /Assessment/u);
    await pickEntry('agent-form', 'report');
    const prompt = await entryOf('agent-prompt');
    assert.equal(prompt, 'divan.report');
    await pickEntry('agent-prompt', 'e2e-report');
    assert.equal(await entryOf('agent-prompt'), 'e2e-report');
    await pickEntry('agent-prompt', 'divan.report');
    await page.getByTestId('agent-name').fill('Drafter');
    await pickNode('rewriter');
    assert.match(
      await page.getByTestId('receives-draft').innerText(),
      /Draft from Drafter · required/u,
    );
    assert.equal(await page.getByTestId('group-min').innerText(), '2');
    await page.getByTestId('group-more').click();
    assert.equal(await page.getByTestId('group-min').innerText(), '3');
    assert.match(await page.getByTestId('group-chip').innerText(), /At least 3 of 4/u);
    await page.getByTestId('group-fewer').click();
    assert.equal(await page.getByTestId('group-min').innerText(), '2');
    assert.equal(
      await page.getByTestId('agent-web').getAttribute('data-mode'),
      'blocked',
      'the final answer has no web',
    );

    step('a line that can never be right is refused with its reason; nothing changes');
    const before = { nodes: await nodeCount(), edges: await edgeCount() };
    await draw('claude', 'input');
    assert.match(
      await page.getByTestId('design-refused').innerText(),
      /nothing can be sent to it/u,
    );
    await draw('claude', 'output');
    assert.match(
      await page.getByTestId('design-refused').innerText(),
      /Only the agent that gives the final answer/u,
    );
    await draw('claude', 'writer');
    assert.match(await page.getByTestId('design-refused').innerText(), /loop/u);
    await draw('rewriter', 'claude');
    assert.match(
      await page.getByTestId('design-refused').innerText(),
      /final answer ends the design/u,
    );
    assert.deepEqual(
      { nodes: await nodeCount(), edges: await edgeCount() },
      before,
      'no line was added',
    );
    await page.getByTestId('design-valid').waitFor();

    step('a line is selected and deleted, and drawn again; the design is checked as it changes');
    await pickEdge('writer>claude', 0.85);
    assert.match(
      await page.getByTestId('inspector-edge').innerText(),
      /needs this draft before it starts/u,
    );
    await page.getByTestId('edge-delete').click();
    await page.waitForTimeout(300);
    // the critic is fed by Input again (the line was hidden while the writer fed it)
    assert.equal(await page.locator('.react-flow__edge[data-id="writer>claude"]').count(), 0);
    assert.equal(await page.locator('.react-flow__edge[data-id="input>claude"]').count(), 1);
    await page.getByTestId('design-valid').waitFor();
    await draw('writer', 'claude');
    assert.equal(
      await page.locator('.react-flow__edge[data-id="writer>claude"]').count(),
      1,
      'the line is back',
    );
    assert.equal(await page.locator('.react-flow__edge[data-id="input>claude"]').count(), 0);
    assert.equal(await edgeCount(), before.edges);
    assert.match(await page.getByTestId('inspector-edge').innerText(), /needs this draft/u);
    // a box nothing leads out of is a problem, said in words, with a way to find it, and the design cannot be saved
    await pickEdge('claude>rewriter', 0.15);
    await page.getByTestId('edge-delete').click();
    await page.getByTestId('design-problem').waitFor();
    assert.match(
      await page.getByTestId('design-problem').innerText(),
      /“Critic 1” is not connected/u,
    );
    assert.equal(
      await page.getByTestId('design-problem').getAttribute('data-reason'),
      'unreachable or dead end',
    );
    assert.equal(
      await page.getByTestId('save-profile').isDisabled(),
      true,
      'a design that cannot run is not saved',
    );
    assert.match(await page.getByTestId('save-blocker').innerText(), /Fix the design to save/u);
    await page.getByTestId('design-problem-show').click();
    assert.equal(await page.getByTestId('inspector-agent').getAttribute('data-agent-id'), 'claude');
    // leaving with it asks, and cannot save it either
    await page.getByTestId('nav-connect').click();
    await page.getByTestId('leave-dialog').waitFor();
    assert.equal(await page.getByTestId('leave-save').isDisabled(), true);
    assert.match(await page.getByTestId('leave-blocked').innerText(), /Fix the design to save/u);
    await page.getByTestId('leave-stay').click();
    await draw('claude', 'rewriter');
    await page.getByTestId('design-valid').waitFor();
    assert.equal(await page.getByTestId('save-profile').isDisabled(), false);

    step('an agent is added from the palette and deleted; the group counts it');
    await page.getByTestId('palette-agent').click();
    await page.waitForTimeout(400);
    assert.equal(await nodeCount(), 9);
    assert.equal(await page.getByTestId('inspector-agent').getAttribute('data-agent-id'), 'agent');
    await page.getByTestId('design-valid').waitFor();
    await pickNode('rewriter');
    assert.match(await page.getByTestId('group-chip').innerText(), /At least 2 of 5/u);
    await pickNode('agent');
    await page.getByTestId('agent-delete').click();
    await page.waitForTimeout(300);
    assert.equal(await nodeCount(), 8);

    step(
      'a box is moved: that is an unsaved change too; the save sends the design and keeps places, names and the prompt',
    );
    const writerBefore = await nodeBox('writer');
    await page.mouse.move(writerBefore.x + 30, writerBefore.y + 60);
    await page.mouse.down();
    await page.mouse.move(writerBefore.x + 130, writerBefore.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const writerAfter = await nodeBox('writer');
    assert.ok(writerAfter.x - writerBefore.x > 60, 'the box followed the pointer');
    const revisionBefore = (await profileOf('draft-and-critics')).revision;
    assert.equal(
      (await profileOf('draft-and-critics')).effective.flow.nodes.find((n) => n.id === 'writer')
        .position,
      undefined,
      'nothing is saved by itself',
    );
    // the level a request that names none runs at is part of the same form
    await pick('default-level', 'High');
    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    const savedProfile = await profileOf('draft-and-critics');
    assert.equal(savedProfile.revision, revisionBefore + 1);
    assert.equal(savedProfile.defaultLevel, 'high');
    const savedWriter = savedProfile.effective.flow.nodes.find((n) => n.id === 'writer');
    assert.equal(savedWriter.label, 'Drafter');
    assert.ok(savedWriter.position, 'the place is kept in the design');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await page.waitForTimeout(500);
    assert.match(
      await page.locator('.react-flow__node[data-id="writer"]').innerText(),
      /Drafter/u,
      'the name is kept',
    );
    const reloaded = await nodeBox('writer');
    const critic = await nodeBox('claude');
    assert.ok(
      reloaded.x > critic.x,
      'the box is where it was left (to the right of the first critic)',
    );
    // Arrange puts every box back to the layout; saving it clears the stored places
    await page.getByTestId('design-arrange').click();
    await page.getByTestId('dirty-marker').waitFor();
    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    assert.equal(
      (await profileOf('draft-and-critics')).effective.flow.nodes.some((n) => 'position' in n),
      false,
      'no place is stored once the layout decides',
    );

    step(
      'a level shows what it runs and changes one agent for that level only; Base and a level are saved apart',
    );
    await page.getByTestId('tab-low').click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('flow-designer').getAttribute('data-level'), 'low');
    assert.equal(await page.getByTestId('design-palette').count(), 0, 'a level does not add boxes');
    await pickNode('claude');
    await page.getByTestId('inspector-level').waitFor();
    await page.getByTestId('level-agent-on').click();
    await page.getByTestId('dirty-marker').waitFor();
    assert.match(
      await page.locator('.react-flow__node[data-id="claude"]').innerText(),
      /Off at Low/u,
    );
    assert.match(await page.getByTestId('group-chip').innerText(), /At least 2 of 3/u);
    await page.getByTestId('tab-base').click();
    await page.getByTestId('levels-first').waitFor();
    await page.getByTestId('tab-low').click();
    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    const lowSaved = await profileOf('draft-and-critics');
    assert.deepEqual(lowSaved.levels.low.overrides, { nodes: { claude: { enabled: false } } });
    assert.equal(
      lowSaved.effective.flow.nodes.find((n) => n.id === 'claude').enabled === false,
      false,
      'the design itself keeps the agent',
    );
    await pickNode('claude');
    await page.getByTestId('level-agent-reset').click();
    assert.match(
      await page.locator('.react-flow__node[data-id="claude"]').innerText(),
      /Claude Code/u,
    );
    await page.getByTestId('cancel-changes').click();
    await page.getByTestId('tab-base').click();

    step('a design that moved on elsewhere is a conflict: the edits stay, reload asks first');
    await pickNode('writer');
    await page.getByTestId('agent-name').fill('Another name');
    await call('/profiles/draft-and-critics', 'PUT', { name: 'Changed elsewhere' });
    await page.getByTestId('save-profile').click();
    await page.getByTestId('save-conflict').waitFor();
    assert.match(
      await page.locator('.react-flow__node[data-id="writer"]').innerText(),
      /Another name/u,
    );
    await page.getByTestId('reload-profile').click();
    await page.getByTestId('confirm-reload').click();
    await page.getByTestId('save-conflict').waitFor({ state: 'detached' });
    assert.match(await page.locator('.react-flow__node[data-id="writer"]').innerText(), /Drafter/u);

    step(
      'from 1000 px the inspector is docked; below it is a sheet; the page never scrolls sideways',
    );
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.waitForTimeout(500);
    await pickNode('claude');
    await page.getByTestId('flow-inspector').waitFor();
    assert.equal(await page.getByTestId('flow-inspector-sheet').count(), 0);
    const docked = await page.getByTestId('flow-inspector').boundingBox();
    assert.ok(docked.width >= 280 && docked.width <= 330, `docked at its width: ${docked.width}`);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
      'no sideways scroll at 1000 px',
    );
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(500);
    assert.equal(await page.getByTestId('flow-inspector').count(), 0, 'no dock below 1000 px');
    await pickNode('claude');
    await page.getByTestId('flow-inspector-sheet').waitFor();
    assert.match(
      await page.getByTestId('flow-inspector-sheet').innerText(),
      /Read-only · never writes/u,
    );
    await page.keyboard.press('Escape');
    await page.getByTestId('flow-inspector-sheet').waitFor({ state: 'detached' });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      true,
      'no sideways scroll at 900 px',
    );

    step(
      'in Persian the design is right to left, the first agent of a row is at the start, digits stay Latin',
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => localStorage.setItem('divan-lang', 'fa'));
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.waitForSelector('.react-flow__edge', { state: 'attached' });
    await page.waitForTimeout(500);
    assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
    const first = await nodeBox('claude');
    const last = await nodeBox('pi');
    assert.ok(first.x > last.x, 'the first critic is at the start (the right)');
    const dock = await page.getByTestId('flow-inspector').boundingBox();
    const canvas = await page.getByTestId('design-canvas').boundingBox();
    assert.ok(dock.x < canvas.x, 'the inspector is at the end (the left)');
    const chip = await page.getByTestId('group-chip').innerText();
    assert.match(chip, /2 از 4/u);
    assert.equal(/[۰-۹]/u.test(chip), false, 'Latin digits');
    assert.match(await page.getByTestId('design-valid').innerText(), /طرح درست است/u);
    await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();

    step('a design is a council like the others: it is listed, copied and deleted');
    assert.equal(
      await page.locator('[data-testid=council-list] a[data-profile-id=draft-and-critics]').count(),
      1,
    );
    await page.getByTestId('profile-menu').click();
    await page.getByTestId('profile-duplicate').click();
    await page.getByTestId('name-input').fill('Copy of the design');
    await page.getByTestId('name-ok').click();
    await until(async () => Boolean(await profileOf('copy-of-the-design')));
    await page.getByTestId('flow-designer').waitFor();
    assert.deepEqual(
      (await profileOf('copy-of-the-design')).effective.flow.nodes.map((n) => n.id),
      (await profileOf('draft-and-critics')).effective.flow.nodes.map((n) => n.id),
    );
    for (const id of ['copy-of-the-design', 'draft-and-critics']) {
      await go(`#/models/${id}`);
      // the page has changed council (it is remounted) before the menu is used
      await page.waitForFunction(
        (value) =>
          document
            .querySelector('[data-testid=council-list] a[aria-current=page]')
            ?.getAttribute('data-profile-id') === value,
        id,
      );
      await page.getByTestId('flow-designer').waitFor();
      await page.waitForTimeout(400);
      await page.getByTestId('profile-menu').click();
      await page.getByTestId('profile-delete').click();
      await page.getByTestId('confirm-delete-profile').click();
      await until(async () => !(await profileOf(id)));
      await page.waitForFunction(() => window.location.hash === '#/models/default');
    }
  }

  if (process.platform === 'win32') {
    step(
      'Hermes: select and save a fake flow; both languages state the Windows/read/usage limits; one fake answer',
    );
    process.env.DIVAN_FAKE_DETECTION = JSON.stringify(inventory(HARNESS_ORDER));
    await call('/detect', 'POST');
    await call('/profiles', 'POST', {
      name: 'Hermes fixture',
      id: 'hermes-fixture',
      template: 'single',
    });
    await go('#/models/hermes-fixture');
    await page.reload();
    await page.getByTestId('flow-designer').waitFor();
    await page.locator('[data-testid=design-node][data-node-id=assistant]').click();
    await pick('agent-harness', 'Hermes');
    await pick('agent-model', 'fake-1');
    assert.equal(await page.getByTestId('agent-web').isDisabled(), true);
    await page.getByTestId('save-profile').click();
    await page.locator('[data-testid=save-cue][data-cue=saved]').waitFor();
    const profile = await profileOf('hermes-fixture');
    assert.equal(profile.effective.flow.nodes.find((n) => n.kind === 'agent').harness, 'hermes');
    const started = await call('/sessions', 'POST', {
      question: 'Hermes fake answer',
      profileId: profile.id,
      revision: profile.revision,
      fingerprint: profile.levels.medium.fingerprint,
      level: 'medium',
    });
    assert.ok(started.id, JSON.stringify(started));
    await until(async () => chairs(await sessionOf(started.id)).at(-1)?.status === 'done');
    assert.match(chairs(await sessionOf(started.id)).at(-1).answer, /Hermes fake answer/u);
    await go('#/');
    for (const lang of ['en', 'fa']) {
      await page.evaluate((value) => localStorage.setItem('divan-lang', value), lang);
      await page.reload();
      await page.getByTestId('home').waitFor();
      await page.getByTestId('assistants-card').evaluate((element) => {
        element.open = true;
      });
      const text = await page.locator('[data-assistant=hermes]').innerText();
      assert.match(text, lang === 'en' ? /this is not a network sandbox/u : /قفل شبکه نیست/u);
      assert.match(
        text,
        lang === 'en' ? /background calls may not be included/u : /فراخوانی‌های جانبی/u,
      );
    }
    await page.evaluate(() => localStorage.setItem('divan-lang', 'en'));
  }
  // The only expected browser errors are the refusals the run made on purpose.
  const unexpected = app.errors.filter(
    (text) =>
      !text.includes('net::ERR_FAILED') &&
      !text.includes('status of 409') &&
      !text.includes('status of 404') &&
      !text.includes('status of 400'),
  );
  assert.deepEqual(unexpected, [], 'no page errors');
  console.log('e2e passed');
} catch (error) {
  console.error('e2e FAILED:', error instanceof Error ? (error.stack ?? error.message) : error);
  await page.screenshot({ path: 'e2e-failure.png' }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await app.close();
}
