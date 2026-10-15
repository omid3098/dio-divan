// Screenshots of the interface, with the fake harnesses (nothing is called) and a headless Chrome with a profile of its own:
// at 1400 px, English and Persian, light and dark: Home, a session with an answer, the details drawer (its four tabs), a round
// that is waiting, a round that failed (its message comes from a code), Councils (the base council and a level with an
// override), Connect (after the test) and Settings; Home has a context; and the session at 900,
// 1100 and 1400 px. The files go to .evidence/shadcn/.
//   node e2e/screens.mjs        (build the web editor first: pnpm build)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch, openBrowser } from './harness.mjs';

const out = join(import.meta.dirname, '..', '.evidence', 'shadcn');
mkdirSync(out, { recursive: true });
process.env.DIVAN_FAKE_THINK_MS = '300000';
process.env.DIVAN_FAKE_USAGE = '0.1';
const app = await launch({ viewport: { width: 1400, height: 900 } });
const { server } = app;
const origin = new URL(server.url).origin;
const headers = { 'x-divan-token': server.token, 'content-type': 'application/json' };
const call = async (path, method = 'GET', body) =>
  (
    await fetch(`${origin}/api${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  ).json();
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
const idle = async (id) => {
  for (let i = 0; i < 300; i += 1) {
    const session = await call(`/sessions/${id}`);
    if (!Object.values(session.nodes).some((n) => n.kind === 'chair' && n.status === 'running')) {
      return session;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('a round did not finish');
};

try {
  // one session per language: three rounds and a branch; in round 1 one member fails, so the panel has something to say
  const questions = {
    en: [
      'For the first version of our task tool, should we build a desktop app or a simple web app?',
      'What if the budget covers only one person?',
      'Which one reaches real feedback sooner?',
      'And what if customers only have phones?',
    ],
    fa: [
      'برای نسخهٔ اول ابزار مدیریت وظایف، اپ دسکتاپ بسازیم یا یک وب‌اپ ساده؟',
      'اگر بودجه فقط برای یک نفر باشد چه؟',
      'کدام یک زودتر به بازخورد واقعی می‌رسد؟',
      'و اگر مشتری‌ها فقط موبایل داشته باشند؟',
    ],
  };
  const made = {};
  for (const lang of ['en', 'fa']) {
    const [question, a, b, c] = questions[lang];
    const session = await call('/sessions', 'POST', {
      question,
      seats: [
        seat('a', 'claude', 'fake-1'),
        seat('b', 'codex', 'fake-1', true),
        seat('c', 'grok', 'fake-1', true),
        seat('d', 'pi', 'fake-fail'),
      ],
      chairman: { harness: 'pi', model: 'fake-2', effort: '' },
      budgets,
    });
    let state = await idle(session.id);
    const round = (n) =>
      Object.values(state.nodes).find((x) => x.kind === 'chair' && x.round === n);
    const say = async (from, text) => {
      await call(`/sessions/${session.id}/rounds`, 'POST', { fromNodeId: from, text });
      state = await idle(session.id);
    };
    await say(round(1).id, a);
    await say(round(2).id, b);
    await say(round(1).id, c);
    // a critique round: «Ask for critique» from round 3 (a round sent without a comment)
    await call(`/sessions/${session.id}/rounds`, 'POST', { fromNodeId: round(3).id });
    state = await idle(session.id);
    const critique = Object.values(state.nodes).find(
      (node) => node.kind === 'chair' && state.nodes[node.parentId]?.kind === 'next',
    );
    made[lang] = {
      id: session.id,
      first: round(1).id,
      second: round(2).id,
      critique: critique?.id,
    };
  }
  // a round that failed: two of three members fail, so the server says "fewer than two valid answers" with a code
  const failed = {};
  const failQuestions = {
    en: 'Should we rewrite the billing module before the launch?',
    fa: 'آیا ماژول صورت‌حساب را پیش از عرضه بازنویسی کنیم؟',
  };
  for (const lang of ['en', 'fa']) {
    const session = await call('/sessions', 'POST', {
      question: failQuestions[lang],
      seats: [
        seat('a', 'claude', 'fake-1'),
        seat('b', 'codex', 'fake-fail', true),
        seat('c', 'grok', 'fake-fail', true),
      ],
      chairman: { harness: 'pi', model: 'fake-2', effort: '' },
      budgets,
    });
    await idle(session.id);
    failed[lang] = session.id;
  }
  // a round that is waiting: one member thinks for a long time (a council of three)
  const waiting = await call('/sessions', 'POST', {
    question: 'Should the first release include the sharing feature?',
    seats: [
      seat('a', 'claude', 'fake-1'),
      seat('b', 'codex', 'fake-1', true),
      seat('c', 'pi', 'fake-think'),
    ],
    chairman: { harness: 'pi', model: 'fake-2', effort: '' },
    budgets,
  });
  // a council with a level that overrides one member, for the Councils pages
  const profile = (await call('/meta')).settings.profiles.find((item) => item.id === 'default');
  await call('/profiles/default', 'PUT', {
    levels: { high: { seats: { codex: { effort: 'low' } } } },
    ifRevision: profile.revision,
    ifFingerprint: profile.fingerprint,
  });

  for (const lang of ['en', 'fa']) {
    for (const theme of ['light', 'dark']) {
      const tag = `${lang}-${theme}`;
      const b = await openBrowser({ viewport: { width: 1400, height: 900 }, theme, lang });
      const { page } = b;
      const shot = async (name) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: join(out, `${tag}-${name}.png`) });
      };
      const crops = join(out, 'crops');
      mkdirSync(crops, { recursive: true });
      const clip = async (name, locators, pad = 12) => {
        const boxes = [];
        for (const locator of locators) {
          const box = await locator.boundingBox();
          if (box) boxes.push(box);
        }
        const x = Math.max(0, Math.min(...boxes.map((b) => b.x)) - pad);
        const y = Math.max(0, Math.min(...boxes.map((b) => b.y)) - pad);
        const right = Math.max(...boxes.map((b) => b.x + b.width)) + pad;
        const bottom = Math.max(...boxes.map((b) => b.y + b.height)) + pad;
        await page.screenshot({
          path: join(crops, `${lang}-${name}.png`),
          clip: { x, y, width: right - x, height: bottom - y },
        });
      };
      try {
        await page.goto(server.url);
        await page.waitForSelector('[data-testid=home]');
        await page.fill('#question', questions[lang][0]);
        await page.fill(
          '#context',
          lang === 'en'
            ? 'Two people, six months, a small budget; customers mostly use phones.'
            : 'دو نفر، شش ماه، بودجهٔ کم؛ بیشتر مشتری‌ها از موبایل استفاده می‌کنند.',
        );
        await page.evaluate(() => document.getElementById('context')?.blur());
        // at High the council overrides one member: the card says so in one muted line
        await page.getByTestId('level-high').click();
        await page.waitForSelector('[data-testid=level-overrides]');
        await shot('home');
        // the sidebar with titles of both languages, one of them running
        if (theme === 'light') await clip('sidebar', [page.getByTestId('sidebar-sessions')], 4);
        await page.fill('#question', '');
        await page.fill('#context', '');
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, `#/s/${made[lang].id}/n/${made[lang].second}`);
        await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]');
        await page.waitForTimeout(900);
        await shot('session');
        // the chairman's questions: a strip pinned above the composer; opened, the one-at-a-time flow in a card over the answer
        await page.getByTestId('questions-toggle').click();
        await page.getByTestId('questions-card').waitFor();
        await page
          .getByTestId('answer-0')
          .fill(lang === 'en' ? 'About 40 euros a month' : 'حدود ۴۰ یورو در ماه');
        await page.getByTestId('question-answered').waitFor();
        await page
          .getByTestId('composer-input')
          .fill(lang === 'en' ? 'And what if the data grows?' : 'و اگر داده‌ها بزرگ شوند؟');
        await shot('questions-open');
        // «Done»: the strip closes to «✓ 1 answer ready · press Send» and Send is lit (a closed strip never looks sent)
        await page.getByTestId('questions-done').click();
        await page.getByTestId('questions-ready').waitFor();
        await shot('questions-ready');
        await page.getByTestId('questions-toggle').click();
        await page.getByTestId('answer-0').fill('');
        await page.getByTestId('questions-toggle').click();
        await page.getByTestId('composer-input').fill('');
        // a critique round: its header says what it is the critique of, and a round after the first shows what it changed
        // (through Home, so the session opens afresh on that round)
        await page.evaluate(() => {
          window.location.hash = '#/';
        });
        await page.waitForSelector('[data-testid=home]');
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, `#/s/${made[lang].id}/n/${made[lang].critique}`);
        await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]');
        await page.waitForTimeout(800);
        await shot('critique');
        await page.evaluate(() => {
          window.location.hash = '#/';
        });
        await page.waitForSelector('[data-testid=home]');
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, `#/s/${made[lang].id}/n/${made[lang].second}`);
        await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]');
        await page.waitForTimeout(600);
        // close-ups of the places where a right-to-left line mixes with Latin text and digits (both languages, light)
        if (theme === 'light') {
          // 1. the kicker of an answer node on the map («Round 2 · 3 of 4 · 70%»), with the input pill above it
          await clip('map-nodes', [
            page.locator('.react-flow__node:has(.dv-node--user)').nth(1),
            page.locator('.react-flow__node:has(.dv-node--chair)').nth(1),
          ]);
          // 3. the tokens line of a member (the Council tab, a member opened)
          await page.getByTestId('chip-council').click();
          await page.getByTestId('details-drawer').waitFor();
          await page.locator('[data-testid=member-row] button').first().click();
          await page.waitForTimeout(400);
          await clip('member-meta', [page.locator('[data-testid=member-row]').first()]);
          await page.keyboard.press('Escape');
          await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
        }
        for (const tab of ['council', 'claims', 'context', 'cost']) {
          await page.getByTestId(`chip-${tab}`).click();
          await page.getByTestId('details-drawer').waitFor();
          if (tab === 'council')
            await page.locator('[data-testid=member-row] button').first().click();
          await shot(`drawer-${tab}`);
          await page.keyboard.press('Escape');
          await page.getByTestId('details-drawer').waitFor({ state: 'detached' });
        }
        // the round that is waiting
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, `#/s/${waiting.id}`);
        await page.waitForSelector('[data-testid=waiting]');
        await page
          .waitForFunction(
            () =>
              /\d/u.test(document.querySelector('[data-testid=member-signal]')?.textContent ?? ''),
            null,
            { timeout: 15_000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(1500);
        await shot('waiting');
        // the round that failed: the line under the alert is worded from the code
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, `#/s/${failed[lang]}`);
        await page.waitForSelector('[data-testid=round-failed]');
        await shot('failed');
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, '#/models/default');
        await page.waitForSelector('[data-testid=council-editor]');
        await page.waitForSelector('.react-flow__edge', { state: 'attached' });
        await page.waitForTimeout(700);
        await shot('councils-base');
        // Tools, Memory and Web: on has a check, a word and a solid border, off is dashed; held ones are disabled with the reason
        await page.locator('.react-flow__node[data-id="claude"]').click();
        await page.getByTestId('agent-tools').click();
        await page.getByTestId('agent-web').click();
        await shot('councils-toggles');
        await page.getByTestId('agent-tools').click();
        await page.getByTestId('agent-web').click();
        await page.getByTestId('tab-high').click();
        await shot('councils-level-high');
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, '#/connect');
        await page.waitForSelector('[data-testid=endpoint]');
        await page.getByTestId('test-connection').click();
        await page.locator('[data-testid=test-result][data-result=ok]').waitFor();
        await shot('connect');
        if (theme === 'light') {
          // 4. the command block: left to right as a whole, the button at its physical right, clear of the command
          const block = page.locator('[data-testid=connect] [role=tabpanel] .relative').first();
          await block.scrollIntoViewIfNeeded();
          const box = await block.boundingBox();
          await page.screenshot({
            path: join(out, 'crops', `${lang}-connect-code.png`),
            clip: { x: box.x - 12, y: box.y - 40, width: box.width + 24, height: box.height + 64 },
          });
        }
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, '#/settings');
        await page.waitForSelector('[data-testid=settings]');
        await shot('settings');
      } finally {
        await b.close();
      }
    }
  }

  // a member with no sign of work for more than a minute: the clock of a tab of its own is moved on
  {
    const quietContext = await app.browser.newContext({ viewport: { width: 1400, height: 900 } });
    const quiet = await quietContext.newPage();
    await quiet.clock.install();
    await quiet.goto(server.url);
    await quiet.evaluate((hash) => {
      window.location.hash = hash;
    }, `#/s/${waiting.id}`);
    await quiet.waitForSelector('[data-testid=waiting]');
    await quiet.waitForSelector('[data-testid=member-live][data-state=running]');
    await quiet.clock.resume();
    await quiet.clock.fastForward(75_000);
    await quiet.getByTestId('member-stale').waitFor();
    await quiet.waitForTimeout(500);
    await quiet.screenshot({ path: join(out, 'en-light-stale-member.png') });
    await quietContext.close();
  }

  // Councils at 900 px: the sidebar is the rail, so the editor has the room
  {
    const narrow = await openBrowser({
      viewport: { width: 900, height: 900 },
      theme: 'light',
      lang: 'en',
    });
    try {
      await narrow.page.goto(server.url);
      await narrow.page.evaluate((hash) => {
        window.location.hash = hash;
      }, '#/models/default');
      await narrow.page.waitForSelector('[data-testid=council-editor]');
      await narrow.page.waitForTimeout(700);
      await narrow.page.screenshot({ path: join(out, 'width-900-councils.png') });
    } finally {
      await narrow.close();
    }
  }

  // the council changed behind the page (a model ran out of credit): the card says what, with one button to go on
  {
    const changed = await openBrowser({
      viewport: { width: 1400, height: 900 },
      theme: 'light',
      lang: 'en',
    });
    try {
      await changed.page.goto(server.url);
      await changed.page.waitForSelector('[data-testid=home]');
      await changed.page.fill('#question', 'Should the first release include the sharing feature?');
      await server.store.addUnavailable({
        harness: 'codex',
        model: 'fake-1',
        prefix: '',
        until: new Date(Date.now() + 3_600_000).toISOString(),
        reason: '402 insufficient balance',
      });
      await changed.page.getByTestId('start').click();
      await changed.page.getByTestId('council-changed').waitFor();
      await changed.page.getByTestId('ask-updated').scrollIntoViewIfNeeded();
      await changed.page.waitForTimeout(500);
      await changed.page.screenshot({ path: join(out, 'en-light-council-changed.png') });
    } finally {
      await changed.close();
    }
  }

  // Quick: its line, and the note that its roster is not the one the user saw (one assistant in the place of another)
  {
    // the model that ran out of credit for the shot above is back
    await server.store.addUnavailable({
      harness: 'codex',
      model: 'fake-1',
      prefix: '',
      until: new Date(Date.now() - 1000).toISOString(),
      reason: 'back',
    });
    const quick = await openBrowser({
      viewport: { width: 1400, height: 900 },
      theme: 'light',
      lang: 'en',
    });
    try {
      await quick.page.goto(server.url);
      await quick.page.waitForSelector('[data-testid=home]');
      const now = (await call('/meta')).settings.profiles
        .find((item) => item.id === 'quick')
        .effective.seats.filter((item) => item.enabled)
        .map((item) => item.harness)
        .sort();
      const other = ['claude', 'codex', 'grok', 'pi'].find((name) => !now.includes(name));
      const before = [...now.slice(1), other].sort();
      await quick.page.evaluate(
        (roster) => localStorage.setItem('divan-quick-roster', JSON.stringify(roster)),
        { members: before, speeds: {} },
      );
      await quick.page.evaluate((hash) => {
        window.location.hash = hash;
      }, '#/models/quick');
      await quick.page.waitForSelector('[data-testid=quick-roster-note]');
      await quick.page.waitForTimeout(600);
      await quick.page.screenshot({ path: join(out, 'en-light-quick-roster-note.png') });
    } finally {
      await quick.close();
    }
  }

  // the session at the three widths that matter (English, light)
  const b = await openBrowser({
    viewport: { width: 1400, height: 900 },
    theme: 'light',
    lang: 'en',
  });
  try {
    await b.page.goto(server.url);
    await b.page.waitForSelector('[data-testid=home]');
    for (const width of [900, 1100, 1400]) {
      await b.page.setViewportSize({ width, height: 900 });
      await b.page.evaluate((hash) => {
        window.location.hash = hash;
      }, `#/s/${made.en.id}/n/${made.en.second}`);
      await b.page.reload();
      await b.page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]');
      await b.page.waitForTimeout(900);
      await b.page.screenshot({ path: join(out, `width-${width}-session.png`) });
      if (width < 980 + 56) {
        await b.page
          .getByTestId('tab-tree')
          .click()
          .catch(() => undefined);
        await b.page.waitForTimeout(700);
        await b.page.screenshot({ path: join(out, `width-${width}-map.png`) });
      }
    }
  } finally {
    await b.close();
  }
  // Home once a round has been measured: it says how long a round usually takes. Nothing else was measured, so one round of a real
  // size is run on the default council (the fixtures above ran at a tenth of a real call)
  {
    // every session goes (a round that is still waiting is stopped first), so nothing but the round below is measured
    for (const old of await call('/sessions')) {
      const state = await call(`/sessions/${old.id}`);
      for (const node of Object.values(state.nodes)) {
        if (node.kind === 'chair' && node.status === 'running') {
          await call(`/sessions/${old.id}/rounds/${node.id}/cancel`, 'POST', {});
        }
      }
      await idle(old.id);
      const gone = await call(`/sessions/${old.id}`, 'DELETE');
      if (gone.error) throw new Error(`could not delete ${old.id}: ${JSON.stringify(gone)}`);
    }
    if ((await call('/sessions')).length > 0) throw new Error('sessions are left');
    process.env.DIVAN_FAKE_USAGE = '1';
    const plain = (await call('/meta')).settings.profiles.find((item) => item.id === 'default');
    const run = await call('/sessions', 'POST', {
      question: 'For the first version, should we build a desktop app or a simple web app?',
      profileId: 'default',
      revision: plain.revision,
      fingerprint: plain.levels[plain.defaultLevel].fingerprint,
      level: plain.defaultLevel,
    });
    await idle(run.id);
    process.env.DIVAN_FAKE_USAGE = '0.1';
    for (const lang of ['en', 'fa']) {
      const measured = await openBrowser({
        viewport: { width: 1400, height: 900 },
        theme: 'light',
        lang,
      });
      try {
        await measured.page.goto(server.url);
        await measured.page.waitForSelector('[data-testid=home]');
        await measured.page.fill('#question', questions[lang][0]);
        await measured.page.getByTestId('usual').waitFor();
        await measured.page.evaluate(() => document.getElementById('question')?.blur());
        await measured.page.waitForTimeout(600);
        await measured.page.screenshot({ path: join(out, `${lang}-light-home-measured.png`) });
      } finally {
        await measured.close();
      }
    }
    await call(`/sessions/${run.id}`, 'DELETE');
  }
  console.log(`screenshots in ${out}`);
} catch (error) {
  console.error('screens FAILED:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await app.close();
}
