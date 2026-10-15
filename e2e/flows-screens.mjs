// Screenshots of the flow editor (Councils: a council or a design on a canvas), with the fake harnesses (nothing is called) and a
// headless Chrome with a profile of its own: at 1000 and 1400 px, English and Persian: the design with an agent selected, a design
// with a problem, a reasoning level, the new-council dialog with its two starting points, a plain council on the canvas (nothing
// selected, a member, the chairman, Low, the question that turns it into a design, the design it becomes, the settings sheet), and
// at 900 px the inspector as a sheet; and the 1400 px design in the dark theme. Also the Library (its prompts and output forms:
// a built-in entry, one of the person's own, the field builder and the JSON Schema preview, a new form with a problem in a field,
// the conflict bar, a refused deletion), the pickers of an agent's prompt and output form, a design with a condition (its box and
// its inspector), the inspector of a line (the fields it carries, how an agent uses it, a gate), and a problem of a condition in
// plain words, at 1000 and 1400 px, in English and Persian, in the light theme. The files go to .evidence/flows/.
//   node e2e/flows-screens.mjs        (build the web editor first: pnpm build)

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { branchFlow, branchLibrary, conditionalWireFlow } from '../tests/fixtures/flows.ts';
import { launch, openBrowser } from './harness.mjs';

const out = join(import.meta.dirname, '..', '.evidence', 'flows');
mkdirSync(out, { recursive: true });
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

/** One scene in one language, width and theme, in a browser of its own. */
async function scene({ lang, width, theme = 'light' }, run) {
  const opened = await openBrowser({ viewport: { width, height: 900 }, theme, lang });
  try {
    await opened.page.goto(server.url);
    await opened.page.waitForSelector('[data-testid=home]');
    await run(opened.page, (name) =>
      opened.page.screenshot({ path: join(out, `${lang}-${theme}-${width}-${name}.png`) }),
    );
    // a refusal the page shows (409: an entry in use, an entry changed elsewhere) is logged by the browser and is no error
    const errors = opened.errors.filter((error) => !/status of 409/u.test(error));
    if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`);
  } finally {
    await opened.close();
  }
}

/** Opens the design and waits for its lines to be drawn and the view to settle. */
async function openDesign(page, id) {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#/models/${id}`);
  await page.waitForSelector('[data-testid=flow-designer]');
  await page.waitForSelector('.react-flow__edge', { state: 'attached' });
  await page.waitForTimeout(900);
}
const pick = async (page, id) => {
  await page.locator(`.react-flow__node[data-id="${id}"]`).click();
  await page.waitForTimeout(500);
};

try {
  const names = { en: 'Writer and critics', fa: 'نویسنده و منتقدان' };
  const made = {};
  const single = {};
  for (const lang of ['en', 'fa']) {
    single[lang] = (
      await call('/profiles', 'POST', {
        name: lang === 'en' ? 'One assistant' : 'یک دستیار',
        id: `single-${lang}`,
        template: 'single',
      })
    ).id;
    made[lang] = (
      await call('/profiles', 'POST', {
        name: names[lang],
        id: `writer-critics-${lang}`,
        template: 'writer-critics',
      })
    ).id;
  }
  const plainNames = { en: 'Plain council', fa: 'شورای ساده' };
  const plain = {};
  for (const lang of ['en', 'fa']) {
    plain[lang] = (
      await call('/profiles', 'POST', { name: plainNames[lang], id: `plain-council-${lang}` })
    ).id;
  }
  for (const lang of ['en', 'fa']) {
    for (const width of [1000, 1400]) {
      // a council is drawn like a design; an edit it cannot say turns it into one, after a question
      await scene({ lang, width }, async (page, shot) => {
        await openDesign(page, plain[lang]);
        await shot('council');
        await pick(page, 'claude');
        await shot('council-member');
        await pick(page, 'chairman');
        await shot('council-chairman');
        await page.getByTestId('tab-low').click();
        await page.waitForTimeout(700);
        await shot('council-level-low');
        await page.getByTestId('tab-base').click();
        await page.waitForTimeout(500);
        await page.getByTestId('palette-writer').click();
        await page.getByTestId('design-dialog').waitFor();
        await page.waitForTimeout(400);
        await shot('council-convert');
        await page.getByTestId('design-continue').click();
        await page.getByTestId('design-dialog').waitFor({ state: 'detached' });
        await page.waitForTimeout(900);
        await shot('council-designed');
        await page.getByTestId('cancel-changes').click();
        await page.waitForTimeout(500);
        await page.getByTestId('council-settings').click();
        await page.getByTestId('council-settings-sheet').waitFor();
        await page.waitForTimeout(600);
        await shot('council-settings');
      });
      await scene({ lang, width }, async (page, shot) => {
        await openDesign(page, made[lang]);
        await shot('design');
        await pick(page, 'writer');
        await shot('design-writer');
        await pick(page, 'rewriter');
        await shot('design-rewriter');
        // a problem: a critic that nothing leads out of
        const point = await page.evaluate(() => {
          const path = document.querySelector(
            '.react-flow__edge[data-id="claude>rewriter"] path.react-flow__edge-interaction',
          );
          const at = path.getPointAtLength(path.getTotalLength() * 0.15);
          const m = path.getScreenCTM();
          return { x: at.x * m.a + at.y * m.c + m.e, y: at.x * m.b + at.y * m.d + m.f };
        });
        await page.mouse.click(point.x, point.y);
        await page.getByTestId('edge-delete').click();
        await page.getByTestId('design-problem').waitFor();
        await page.waitForTimeout(400);
        await shot('design-problem');
        await page.getByTestId('cancel-changes').click();
        await page.getByTestId('tab-low').click();
        await page.waitForTimeout(500);
        await pick(page, 'claude');
        await page.getByTestId('level-agent-on').click();
        await page.waitForTimeout(500);
        await shot('design-level-low');
        await page.getByTestId('cancel-changes').click();
        await page.getByTestId('tab-base').click();
        await page.getByTestId('profile-new').click();
        await page.getByTestId('template-choice').waitFor();
        await page.getByTestId('template-writer-critics').check();
        await shot('new-model');
      });
    }
    await scene({ lang, width: 1400 }, async (page, shot) => {
      await openDesign(page, single[lang]);
      await shot('single-model');
      await pick(page, 'assistant');
      await shot('single-assistant');
      await page.getByTestId('profile-new').click();
      await page.getByTestId('template-single').check();
      await shot('new-model');
    });
    await scene({ lang, width: 900 }, async (page, shot) => {
      await openDesign(page, made[lang]);
      await pick(page, 'writer');
      await page.getByTestId('flow-inspector-sheet').waitFor();
      await page.waitForTimeout(400);
      await shot('design-sheet');
    });
  }

  // ----- the Library, the pickers, a condition and a line -----
  for (const form of branchLibrary.forms) await call('/library/forms', 'POST', form);
  for (const prompt of branchLibrary.prompts) await call('/library/prompts', 'POST', prompt);
  await call('/library/forms', 'POST', {
    id: 'verdict',
    name: 'Verdict',
    fields: [
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
        description: 'Pass or fail',
        required: true,
        options: ['pass', 'fail'],
      },
      {
        name: 'reasons',
        type: 'list',
        description: 'Why, in short points',
        required: false,
        maxItems: 5,
        maxWords: 25,
      },
      {
        name: 'summary',
        type: 'markdown',
        description: 'One paragraph for the person',
        required: false,
        maxWords: 120,
      },
    ],
  });
  await call('/library/prompts', 'POST', {
    id: 'assess-strictly',
    name: 'Assess strictly',
    form: 'verdict',
    inputs: 'without',
    text: 'You assess one proposal.\n\nHow to work\n- Read what the person gave you and check each claim against its source.\n- Score the proposal from 0 to 10; a proposal that cannot be checked scores low.\n- Say why in short points.\n\nReturn exactly the fields listed below and nothing else.',
  });
  const labels = {
    en: { source: 'Assessor', yes: 'Plan to go ahead', no: 'Warning to stop' },
    fa: { source: 'ارزیاب', yes: 'طرح پیشروی', no: 'هشدار توقف' },
  };
  const branchNames = { en: 'Check, then go ahead or stop', fa: 'بررسی، سپس ادامه یا توقف' };
  const branch = {};
  for (const lang of ['en', 'fa']) {
    branch[lang] = (
      await call('/profiles', 'POST', { name: branchNames[lang], id: `branch-${lang}` })
    ).id;
    const flow = branchFlow('fake-1');
    for (const key of ['source', 'yes', 'no'])
      flow.nodes.find((n) => n.id === key).label = labels[lang][key];
    // the assessor also gives the final agent its score, and nothing else of its answer
    flow.nodes.find((n) => n.id === 'final').required = ['source'];
    flow.edges.push({ from: 'source', to: 'final', anonymous: true, fields: ['score'] });
    await call(`/profiles/${branch[lang]}`, 'PUT', { flow });
  }
  const pickEdge = async (page, id, at) => {
    const point = await page.evaluate(
      ({ edge, fraction }) => {
        const path = document.querySelector(
          `.react-flow__edge[data-id="${edge}"] path.react-flow__edge-interaction`,
        );
        const here = path.getPointAtLength(path.getTotalLength() * fraction);
        const m = path.getScreenCTM();
        return { x: here.x * m.a + here.y * m.c + m.e, y: here.x * m.b + here.y * m.d + m.f };
      },
      { edge: id, fraction: at },
    );
    await page.mouse.click(point.x, point.y);
    await page.getByTestId('inspector-edge').waitFor();
    await page.waitForTimeout(400);
  };
  const go = async (page, hash, wait = 700) => {
    await page.evaluate((value) => {
      window.location.hash = value;
    }, hash);
    await page.waitForTimeout(wait);
  };
  for (const lang of ['en', 'fa']) {
    for (const width of [1000, 1400]) {
      await scene({ lang, width }, async (page, shot) => {
        await go(page, '#/library/prompts/assess-strictly');
        await shot('library-prompt');
        await go(page, '#/library/prompts/divan.chairman');
        await shot('library-prompt-builtin');
        await go(page, '#/library/forms/verdict');
        await shot('library-form');
        await page.getByTestId('schema-toggle').click();
        await page.waitForTimeout(300);
        await page.getByTestId('schema-preview').scrollIntoViewIfNeeded();
        await shot('library-form-schema');
        await go(page, '#/library/forms/member');
        await shot('library-form-builtin');
        // a refused deletion names the models that use the form
        await go(page, '#/library/forms/assessment');
        await page.getByTestId('entry-delete').click();
        await page.getByTestId('confirm-delete-entry').click();
        await page.getByTestId('in-use-dialog').waitFor();
        await page.waitForTimeout(300);
        await shot('library-in-use');
      });
      // an edit that is not saved stays on the page: a new form with a problem in a field
      await scene({ lang, width }, async (page, shot) => {
        // a new form: a field with a name the server would refuse, and a choice with no option
        await go(page, '#/library/forms');
        await page.getByTestId('library-new').click();
        await page.getByTestId('entry-name').fill(lang === 'en' ? 'Risk check' : 'بررسی خطر');
        await page.getByTestId('field-name').fill('Risk level');
        await page.getByTestId('field-add').click();
        const second = page.getByTestId('field-row').nth(1);
        await second.getByTestId('field-type').click();
        await page.locator('[data-slot=select-content][data-open] [role=option]').nth(4).click();
        await page.waitForTimeout(400);
        await shot('library-form-new-problem');
      });
      await scene({ lang, width }, async (page, shot) => {
        // the entry changed somewhere else
        await go(page, '#/library/prompts/check');
        await page
          .getByTestId('prompt-text')
          .fill('Assess the question with care. Return the requested fields.');
        const check = (await call('/library')).prompts.find((p) => p.id === 'check');
        await call('/library/prompts/check', 'PUT', {
          ifRevision: check.revision,
          text: 'Assess the question. Return the requested fields (edited elsewhere).',
        });
        await page.getByTestId('entry-save').click();
        await page.getByTestId('save-conflict').waitFor();
        await page.waitForTimeout(300);
        await shot('library-conflict');
      });
      await scene({ lang, width }, async (page, shot) => {
        await openDesign(page, branch[lang]);
        await shot('condition-design');
        await pick(page, 'decision');
        await shot('condition-inspector');
        // a second rule: the choice of «all» or «any» appears
        await page.getByTestId('rule-add').click();
        await page.waitForTimeout(500);
        await shot('condition-two-rules');
        await page.getByTestId('cancel-changes').click();
        await pick(page, 'source');
        await page.getByTestId('agent-form').click();
        await page.waitForTimeout(400);
        await shot('picker-form');
        await page.mouse.click(30, 450);
        await page.getByTestId('agent-prompt').click();
        await page.waitForTimeout(400);
        await shot('picker-prompt');
        await page.mouse.click(30, 450);
        await pickEdge(page, 'source>final', 0.5);
        await shot('edge-fields');
        await pickEdge(page, 'yes>final', 0.5);
        await shot('edge-role');
        await pickEdge(page, 'decision:yes>yes', 0.5);
        await shot('edge-gate');
        // the condition with one exit: said in words, with the box marked
        await page.getByTestId('edge-delete').click();
        await page.getByTestId('design-problem').waitFor();
        await page.waitForTimeout(500);
        await shot('condition-problem');
      });
    }
  }
  for (const lang of ['en', 'fa']) {
    const id = `conditional-wire-${lang}`;
    await call('/profiles', 'POST', {
      id,
      name:
        lang === 'en'
          ? 'Check the draft, rewrite if needed'
          : 'بررسی پیش‌نویس، بازنویسی در صورت نیاز',
    });
    const flow = conditionalWireFlow();
    const names =
      lang === 'en'
        ? { report: 'Draft', judge: 'Judge the draft', rewriter: 'Rewrite', final: 'Final answer' }
        : {
            report: 'پیش‌نویس',
            judge: 'ارزیابی پیش‌نویس',
            rewriter: 'بازنویسی',
            final: 'پاسخ نهایی',
          };
    for (const node of flow.nodes) if (node.kind === 'agent') node.label = names[node.id];
    await call(`/profiles/${id}`, 'PUT', { flow });
    await scene({ lang, width: 1400 }, async (page, shot) => {
      await openDesign(page, id);
      await shot('conditional-wire-design');
      await page
        .locator('.react-flow__edge[data-id="report>final"] path.react-flow__edge-interaction')
        .dispatchEvent('click');
      await page.getByTestId('edge-when').waitFor();
      await shot('conditional-wire-inspector');
      await page.getByTestId('edge-when').click();
      await page.getByTestId('edge-when-decision-no').waitFor();
      await page.waitForTimeout(300);
      await shot('conditional-wire-choices');
    });
  }
  await scene({ lang: 'en', width: 1400, theme: 'dark' }, async (page, shot) => {
    await openDesign(page, made.en);
    await pick(page, 'rewriter');
    await shot('design-rewriter');
  });
  console.log(`screenshots in ${out}`);
} catch (error) {
  console.error('flows screens FAILED:', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  await app.close();
}
