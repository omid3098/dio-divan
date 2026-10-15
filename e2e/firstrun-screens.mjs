import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fakeModels } from '../src/server/adapters/fake.ts';
import { detect } from '../src/server/detection.ts';
import { note } from '../src/shared/messages.ts';
import { launch, openBrowser } from './harness.mjs';

const out = join(import.meta.dirname, '..', '.evidence', 'firstrun-built');
mkdirSync(out, { recursive: true });
const ids = ['claude', 'codex', 'grok', 'pi', 'agy', 'hermes'];
// Claude Code installed where its installer puts it, but not on this terminal's PATH
const offPathFolder =
  process.platform === 'win32' ? String.raw`C:\Users\you\.local\bin` : '/home/you/.local/bin';
const offPathProgram = join(offPathFolder, process.platform === 'win32' ? 'claude.exe' : 'claude');
const inventory = (state) => {
  const on =
    state === 'hermes-inventory' || state === 'hermes-platform'
      ? ['hermes']
      : state === 'agy-only'
        ? ['agy']
        : state === 'one-assistant' || state === 'agy-installed'
          ? state === 'agy-installed'
            ? ['pi', 'agy']
            : ['pi']
          : state === 'one-company' || state === 'aliases'
            ? ['claude']
            : state === 'two-companies' || state === 'two-singles'
              ? ['claude', 'codex']
              : state === 'unknown-company'
                ? ['codex', 'grok']
                : state === 'all'
                  ? ['claude', 'codex', 'grok', 'pi']
                  : [];
  const models = on.map((harness) => {
    const modelIds =
      harness === 'hermes'
        ? ['hermes/fixture/gpt-a', 'hermes/fixture/gpt-b', 'hermes/fixture/deepseek-pro']
        : state === 'one-assistant' || state === 'agy-installed' || state === 'agy-only'
          ? harness === 'agy'
            ? ['gemini-3.8-flash']
            : ['litellm/chatgpt/gpt-a', 'litellm/chatgpt/gpt-b', 'litellm/deepseek/deepseek-pro']
          : state === 'aliases'
            ? []
            : state === 'two-singles'
              ? [harness === 'claude' ? 'opus' : 'gpt-a']
              : state === 'unknown-company' && harness === 'grok'
                ? ['build', 'composer']
                : harness === 'claude'
                  ? ['opus', 'sonnet', 'haiku']
                  : harness === 'codex'
                    ? ['gpt-a', 'gpt-b']
                    : harness === 'grok'
                      ? ['grok-a']
                      : ['litellm/deepseek/deepseek-flash', 'google/gemini-pro'];
    return {
      ...fakeModels(harness),
      listed: state !== 'aliases',
      models: modelIds.map((id) => ({
        id,
        label: id,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      })),
      defaultModel: modelIds[0] ?? '',
    };
  });
  return {
    models,
    detectedAt: '',
    status: ids.map((id) => ({
      id,
      installed: on.includes(id) || (state === 'signed-out' && id === 'claude'),
      usable: on.includes(id) && state !== 'hermes-platform',
      note:
        state === 'hermes-platform' && id === 'hermes'
          ? note('hermes_platform')
          : on.includes(id)
            ? null
            : state === 'off-path' && id === 'claude'
              ? note('harness_off_path', { path: offPathProgram, folder: offPathFolder })
              : note(
                  state === 'signed-out' && id === 'claude'
                    ? 'claude_not_logged_in'
                    : 'harness_missing',
                ),
    })),
  };
};
const app = await launch({ lang: 'en', viewport: { width: 1400, height: 1000 } });
let captures = 0;
const expandedOnly = process.argv.includes('--expanded-only');
const states = [
  'no-assistant',
  'signed-out',
  'aliases',
  'unknown-company',
  'two-singles',
  'one-company',
  'two-companies',
  'all',
  'one-assistant',
  'agy-only',
  'agy-installed',
  'hermes-inventory',
  'hermes-platform',
  'off-path',
];
const fromIndex = process.argv.indexOf('--from');
const firstState = fromIndex < 0 ? 0 : states.indexOf(process.argv[fromIndex + 1]);
assert.ok(firstState >= 0, '--from names an inventory');
try {
  for (const state of process.argv.includes('--recovery-only') ? [] : states.slice(firstState)) {
    process.env.DIVAN_FAKE_DETECTION = JSON.stringify(inventory(state));
    await detect(true);
    await fetch(`http://127.0.0.1:${app.server.port}/api/detect`, {
      method: 'POST',
      headers: { 'x-divan-token': app.server.token },
    });
    if (state === 'aliases') {
      const single = await fetch(`http://127.0.0.1:${app.server.port}/api/profiles`, {
        method: 'POST',
        headers: { 'x-divan-token': app.server.token, 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Alias single fixture',
          id: 'alias-single',
          template: 'single',
        }),
      });
      assert.equal(single.status, 201, 'Claude aliases can create a single model');
    }
    if (state === 'agy-installed') {
      const headers = { 'x-divan-token': app.server.token, 'content-type': 'application/json' };
      const created = await fetch(`http://127.0.0.1:${app.server.port}/api/profiles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Manual agy', id: 'agy-single', template: 'single' }),
      });
      assert.equal(created.status, 201);
      const made = await created.json();
      const defaults = made.view.profiles.find((item) => item.id === 'default');
      assert.ok(!defaults.effective.seats.some((seat) => seat.harness === 'agy'));
      assert.notEqual(defaults.effective.chairman.harness, 'agy');
      const flow = made.view.profiles.find((item) => item.id === made.id).effective.flow;
      Object.assign(
        flow.nodes.find((node) => node.kind === 'agent'),
        { harness: 'agy', model: 'gemini-3.8-flash', tools: false, memory: false, web: false },
      );
      const saved = await fetch(`http://127.0.0.1:${app.server.port}/api/profiles/${made.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ flow }),
      });
      assert.equal(saved.status, 200);
    }
    for (const lang of ['en', 'fa'])
      for (const width of [1400, 1000, 900])
        for (const theme of ['light', 'dark']) {
          const opened = await openBrowser({
            lang,
            theme,
            viewport: { width, height: width === 1000 ? 900 : 1000 },
          });
          try {
            if (state === 'agy-installed')
              await opened.context.addInitScript(() =>
                localStorage.setItem('divan-profile', 'agy-single'),
              );
            // Hermes is Windows-only: this state is shown as it reads on macOS and Linux
            if (state === 'hermes-platform')
              await opened.page.route('**/api/meta', async (route) => {
                const meta = await (await route.fetch()).json();
                meta.platform = 'linux';
                await route.fulfill({ json: meta });
              });
            await opened.page.goto(app.server.url);
            await opened.page.getByTestId('assistants-card').waitFor();
            await opened.page.getByTestId('question').fill('A draft stays until I Ask.');
            const card = opened.page.getByTestId('assistants-card');
            if (state === 'no-assistant' || state === 'agy-only') {
              assert.equal(await card.evaluate((element) => element.open), true);
              await card.getByTestId('check-assistants').waitFor();
              await card.locator('summary').click();
              assert.equal(await card.evaluate((element) => element.open), false);
              await card.locator('summary').click();
            }
            if (state === 'agy-only') {
              assert.equal(await opened.page.getByTestId('use-single').count(), 0);
              assert.match(
                await opened.page.getByTestId('council-blocked').textContent(),
                /Choose it by hand in Models|خودتان انتخابش کنید/u,
              );
            }
            if (width === 1000 && ['one-company', 'two-companies', 'aliases'].includes(state)) {
              const warning = await opened.page.getByTestId('company-note').boundingBox();
              const ask = await opened.page.getByTestId('start').boundingBox();
              assert.ok(warning && warning.y >= 0 && warning.y + warning.height <= 900);
              assert.ok(ask && ask.y >= 0 && ask.y + ask.height <= 900);
            }
            if (state === 'two-singles') {
              const single = await opened.page.getByTestId('use-single').boundingBox();
              assert.ok(
                single &&
                  single.y >= 0 &&
                  single.y + single.height <= (width === 1000 ? 900 : 1000),
              );
            }
            if (!expandedOnly) {
              await opened.page.screenshot({
                path: join(out, `${state}-${lang}-${width}-${theme}-collapsed.png`),
                fullPage: true,
              });
              captures++;
            }
            if (!(await card.evaluate((element) => element.open)))
              await card.locator('summary').click();
            await card.getByTestId('check-assistants').waitFor();
            if (state === 'aliases') assert.ok((await card.textContent()).includes('opus'));
            if (state === 'unknown-company') await card.getByTestId('unknown-company').waitFor();
            if (state === 'hermes-platform') {
              // one plain sentence: no Windows text, no setup link, nothing to copy
              const row = card.locator('[data-assistant="hermes"]');
              assert.equal(await row.locator('p').count(), 1);
              assert.equal(await row.locator('a, .ds-command').count(), 0);
              assert.doesNotMatch(
                await row.textContent(),
                /Low integrity|Windows stops|ویندوز جلوی|سطح دسترسی پایین/u,
              );
              assert.match(await row.locator('p').textContent(), /Windows only|فقط روی ویندوز/u);
            }
            if (state === 'off-path') {
              // installed, but its folder is not on PATH: where it is and what to do, and no install command
              const row = card.locator('[data-assistant="claude"]');
              const text = await row.textContent();
              assert.ok(text.includes(offPathProgram) && text.includes(offPathFolder));
              assert.equal(await row.locator('.ds-command').count(), 0);
              assert.doesNotMatch(text, /install.sh|install.ps1|not installed|نصب نیست/u);
              assert.match(text, /PATH/u);
            }
            const height = await opened.page
              .getByTestId('home')
              .evaluate((element) => element.scrollHeight);
            // The app's inner scroll area and sticky Ask footer otherwise clip an element capture.
            await opened.page.setViewportSize({ width, height: Math.ceil(height) + 300 });
            await card.scrollIntoViewIfNeeded();
            const button = await opened.page.getByTestId('check-assistants').boundingBox();
            assert.ok(
              button && button.y >= 0 && button.y + button.height < Math.ceil(height) + 300,
            );
            await opened.page.getByTestId('assistants-card').screenshot({
              path: join(out, `${state}-${lang}-${width}-${theme}-expanded.png`),
            });
            captures++;
            if (expandedOnly) continue;
            await opened.page.setViewportSize({ width, height: 1000 });
            assert.equal(
              await opened.page.locator('[data-assistant="agy"]').count(),
              state === 'agy-installed' || state === 'agy-only' ? 1 : 0,
            );
            if (state === 'one-assistant') {
              await opened.page.getByTestId('one-program-note').waitFor();
              assert.ok(
                (await opened.page.getByTestId('one-program-note').textContent()).includes('Pi'),
              );
              assert.equal(await opened.page.getByTestId('start').isDisabled(), false);
            }
            if (state === 'agy-installed') {
              await opened.page.getByTestId('ask-bar').getByTestId('agy-warning').waitFor();
              assert.doesNotMatch(
                await opened.page.getByTestId('use-single').textContent(),
                /agy/u,
              );
              if (width === 1400 && theme === 'light') {
                await opened.page.getByTestId('start').click();
                await opened.page.getByTestId('answer').waitFor();
                await opened.page.getByTestId('session-settings-button').click();
                const settings = opened.page.getByTestId('session-settings');
                await settings.getByTestId('agy-warning').waitFor();
                assert.doesNotMatch(await settings.textContent(), /web off\.|وب خاموش است/u);
                await opened.page.screenshot({
                  path: join(out, `agy-frozen-${lang}.png`),
                  fullPage: true,
                  animations: 'disabled',
                });
                captures++;
              }
            }
            assert.equal(
              await opened.page.evaluate(
                () => document.documentElement.scrollWidth > window.innerWidth,
              ),
              false,
            );
            if (state === 'no-assistant' || state === 'signed-out')
              assert.equal(await opened.page.getByTestId('start').isDisabled(), true);
            if (state === 'one-company' || state === 'two-companies')
              await opened.page.getByTestId('company-note').waitFor();
            // Shared refresh preserves the draft and a failed refresh retains the last inventory and shows the failure.
            if (state === 'all' && lang === 'en' && width === 1400 && theme === 'light') {
              const before = await opened.page.getByTestId('council-seats').textContent();
              await opened.page.route('**/api/detect', (route) =>
                route.fulfill({
                  status: 502,
                  contentType: 'application/json',
                  body: JSON.stringify({ error: 'detection_failed', message: 'The check failed.' }),
                }),
              );
              await opened.page.getByTestId('check-assistants').click();
              await opened.page.getByTestId('assistants-card').getByRole('alert').waitFor();
              assert.equal(await opened.page.getByTestId('council-seats').textContent(), before);
              assert.equal(
                await opened.page.getByTestId('question').inputValue(),
                'A draft stays until I Ask.',
              );
              await opened.page.screenshot({
                path: join(out, 'check-failed-keeps-result.png'),
                fullPage: true,
              });
              captures++;
            }
            if (state === 'two-singles' && width === 1400 && theme === 'light') {
              await opened.page.getByTestId('use-single').click();
              await opened.page.waitForFunction(
                () => !document.querySelector('[data-testid="start"]').disabled,
              );
              assert.equal(
                await opened.page.getByTestId('question').inputValue(),
                'A draft stays until I Ask.',
              );
              await opened.page.getByTestId('start').click();
              await opened.page.getByTestId('answer').waitFor();
              assert.doesNotMatch(
                await opened.page.locator('.dv-node--chair').innerText(),
                /0 of 0|0 از 0/u,
              );
              assert.doesNotMatch(
                await opened.page.getByTestId('questions-strip-text').innerText(),
                /chairman|رئیس/iu,
              );
              assert.equal(
                (await opened.page.getByTestId('chip-context').innerText()).trim(),
                lang === 'en' ? 'What assistants saw' : 'آنچه دستیارها دیدند',
              );
              await opened.page.screenshot({
                path: join(out, `single-answer-${lang}.png`),
                fullPage: true,
              });
              captures++;
            }
            assert.deepEqual(
              opened.errors.filter((error) => !error.includes('status of 502')),
              [],
            );
          } finally {
            await opened.close();
          }
        }
  }
  if (!expandedOnly) {
    for (const lang of ['en', 'fa']) {
      const opened = await openBrowser({ lang, viewport: { width: 1000, height: 800 } });
      try {
        await opened.page.goto(`http://127.0.0.1:${app.server.port}/open/expired-ticket`);
        await opened.page
          .getByRole('alert')
          .getByText(lang === 'fa' ? /نشانی ورود منقضی شده است/u : /This sign-in link has expired/u)
          .waitFor();
      } finally {
        await opened.close();
      }
    }
  }
  if (!expandedOnly) {
    process.env.DIVAN_FAKE_DETECTION = JSON.stringify(inventory('one-assistant'));
    await detect(true);
    await fetch(`http://127.0.0.1:${app.server.port}/api/detect`, {
      method: 'POST',
      headers: { 'x-divan-token': app.server.token },
    });
    // Same-tab recovery from a stale token, including a draft from the previous page lifetime.
    const page = app.page;
    await page.goto(app.server.url);
    await page.getByTestId('question').fill('Keep this draft through sign-in recovery.');
    await page.evaluate(() => sessionStorage.setItem('divan-token', '0'.repeat(48)));
    await page.reload();
    await page.getByText('Run divan again.', { exact: false }).first().waitFor();
    await page.goto(app.server.url);
    await page.getByTestId('question').waitFor();
    assert.equal(
      await page.getByTestId('question').inputValue(),
      'Keep this draft through sign-in recovery.',
    );
    assert.ok(!(await page.evaluate(() => location.hash)).includes('token='));
    await page.evaluate(() => {
      sessionStorage.removeItem('divan-token');
    });
    await page.reload();
    await page.getByText('Run divan again.', { exact: false }).first().waitFor();
    await page.goto(app.server.url);
    await page.getByTestId('question').waitFor();
    assert.equal(
      await page.getByTestId('question').inputValue(),
      'Keep this draft through sign-in recovery.',
    );
    await page.route('**/api/meta', async (route) => {
      const response = await route.fetch();
      const meta = await response.json();
      meta.settings.profiles.reverse();
      await route.fulfill({ json: meta });
    });
    await page.evaluate(() => localStorage.setItem('divan-profile', 'deleted-profile'));
    await page.goto(`${app.server.url.split('#')[0]}#/new`);
    await page.reload();
    await page.getByTestId('question').waitFor();
    assert.equal(
      await page.locator('a[href="#/models/default?level=medium"]').count(),
      1,
      'a deleted selection falls back to default even when it is not the first profile',
    );
    await app.context.addInitScript(() => {
      const get = Storage.prototype.getItem;
      const set = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key === 'divan-profile') throw new Error('Storage denied');
        return get.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key === 'divan-profile') throw new Error('Storage denied');
        return set.call(this, key, value);
      };
    });
    await page.reload();
    await page.getByTestId('question').waitFor();
    await page.getByTestId('question').fill('A choice still works without storage.');
    await page.getByTestId('use-single').click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="council-card"] a[href*="#/models/"]')
          ?.getAttribute('href')
          ?.includes('default') === false,
    );
    assert.equal(
      await page.getByTestId('question').inputValue(),
      'A choice still works without storage.',
    );
    assert.ok(
      !(await page.evaluate(() => location.hash)).startsWith('#/s/'),
      'Single keeps the question for a separate Ask',
    );
  }
  console.log(
    expandedOnly
      ? `${captures} corrected expanded-card captures: ${out}`
      : `${captures} first-run captures; both languages/themes, ${states.length} inventories, 1000×900 visibility, refresh failure and same-tab recovery passed: ${out}`,
  );
} finally {
  delete process.env.DIVAN_FAKE_DETECTION;
  await detect(true);
  await app.close();
}
