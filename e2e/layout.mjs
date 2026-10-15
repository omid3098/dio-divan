// End to end, fake harnesses, a headless browser: the tree on the canvas. The steps of the QC report (a branch A, a branch B
// three levels deep, then the first input of B edited into a sibling), a stale layout write refused by the server, a real pointer drag
// that moves a node and is still there after a reload, the minimap and the toolbar never covering the selected node, the
// view framed again after «چیدن» and after an edit, a session opened again, and the page that never scrolls.
//   node e2e/layout.mjs        (build the web editor first: pnpm build)
//
// Every check runs and is reported, so a failure shows all of what is wrong, not only the first thing.

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';

// DIVAN_SHOTS=<folder>: screenshots of the key moments go there (the evidence of the report).
const shotsDir = process.env.DIVAN_SHOTS;
if (shotsDir) mkdirSync(shotsDir, { recursive: true });

const app = await launch({ viewport: { width: 1440, height: 900 } });
const { page, server } = app;
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
const failures = [];
async function check(name, run) {
  try {
    await run();
    console.log(`- ok: ${name}`);
  } catch (error) {
    failures.push(name);
    // an assertion says what is wrong; any other error comes with where it happened
    const text = error?.name === 'AssertionError' ? error.message : (error?.stack ?? String(error));
    console.log(`- FAILED: ${name}\n    ${text.split('\n').join('\n    ')}`);
  }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  if (shotsDir) await app.page.screenshot({ path: join(shotsDir, `${name}.png`) });
};
async function until(check, timeout = 20_000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await check()) return;
    if (Date.now() > end)
      throw new Error(`timed out waiting for: ${check.toString().slice(0, 120)}`);
    await wait(150);
  }
}
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
const sessionOf = (id) => call(`/sessions/${id}`);
/** Unpins every pinned node of a session by a layout write against the revisions the server has. */
async function unpinAll(sessionId) {
  const session = await sessionOf(sessionId);
  const nodes = {};
  for (const node of Object.values(session.nodes)) {
    if (node.pinned) {
      nodes[node.id] = {
        x: node.position.x,
        y: node.position.y,
        pinned: false,
        rev: node.layoutRev,
      };
    }
  }
  if (Object.keys(nodes).length === 0) return;
  const answer = await call(`/sessions/${sessionId}/layout`, 'PUT', {
    opId: `e2e-unpin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    nodes,
  });
  assert.equal(answer.ok, true, `unpinned: ${JSON.stringify(answer)}`);
}
const chairs = (session) => Object.values(session.nodes).filter((node) => node.kind === 'chair');
const running = (session) => chairs(session).some((node) => node.status === 'running');
async function settle(id) {
  await until(async () => !running(await sessionOf(id)));
  // the canvas places and frames what arrived
  await wait(700);
}

// ---------- measuring the page ----------

const nodeRects = () =>
  page.$$eval('.react-flow__node', (els) =>
    els.map((el) => {
      const b = el.getBoundingClientRect();
      return { id: el.getAttribute('data-id'), x: b.x, y: b.y, w: b.width, h: b.height };
    }),
  );
const canvasRect = () =>
  page.$eval('.dv-canvas', (el) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
const panelRects = () =>
  page.$$eval('.dv-canvas .react-flow__panel', (els) =>
    els
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          id: el.className.split(' ').slice(0, 3).join('.'),
          x: b.x,
          y: b.y,
          w: b.width,
          h: b.height,
        };
      })
      .filter((rect) => rect.w > 0 && rect.h > 0),
  );
const meets = (a, b, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
const inside = (box, frame, margin = 0) =>
  box.x >= frame.x + margin &&
  box.y >= frame.y + margin &&
  box.x + box.w <= frame.x + frame.w - margin &&
  box.y + box.h <= frame.y + frame.h - margin;

async function assertTreeIsClean(label) {
  const nodes = await nodeRects();
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      assert.equal(
        meets(nodes[i], nodes[j]),
        false,
        `${label}: nodes ${nodes[i].id} and ${nodes[j].id} overlap (${JSON.stringify([nodes[i], nodes[j]])})`,
      );
    }
  }
}

/** The nodes of one parent stand on one row (top to bottom layout) and side by side. */
async function assertSiblingsSideBySide(session, parentId, label) {
  const rects = new Map((await nodeRects()).map((rect) => [rect.id, rect]));
  const kids = Object.values(session.nodes).filter((node) => node.parentId === parentId);
  const boxes = kids.map((node) => rects.get(node.id));
  assert.ok(boxes.every(Boolean), `${label}: every sibling is on the canvas`);
  const rows = new Set(boxes.map((box) => Math.round(box.y)));
  assert.equal(rows.size, 1, `${label}: siblings stand on one row (rows ${[...rows]})`);
  const columns = new Set(boxes.map((box) => Math.round(box.x)));
  assert.equal(columns.size, kids.length, `${label}: siblings stand in separate columns`);
}

/** Every branch under a node is fully on the canvas: nothing is cropped at the side. */
async function assertBranchesVisible(session, parentId, label) {
  const canvas = await canvasRect();
  const rects = new Map((await nodeRects()).map((rect) => [rect.id, rect]));
  for (const node of Object.values(session.nodes).filter((item) => item.parentId === parentId)) {
    const rect = rects.get(node.id);
    assert.ok(
      rect && inside(rect, canvas),
      `${label}: branch ${node.id} is cropped ${JSON.stringify([rect, canvas])}`,
    );
  }
}

/** The selected node is fully on the canvas and under no panel (the toolbar, the controls, the minimap). */
async function assertSelectedIsClear(label) {
  const id = await page.evaluate(
    () =>
      document
        .querySelector('.react-flow__node:has(.dv-node[data-selected])')
        ?.getAttribute('data-id') ?? null,
  );
  assert.ok(id, `${label}: a node is selected`);
  const node = (await nodeRects()).find((rect) => rect.id === id);
  const canvas = await canvasRect();
  assert.ok(
    inside(node, canvas),
    `${label}: the selected node is on the canvas ${JSON.stringify([node, canvas])}`,
  );
  for (const panel of await panelRects()) {
    assert.equal(
      meets(node, panel),
      false,
      `${label}: the selected node lies under ${panel.id} ${JSON.stringify([node, panel])}`,
    );
  }
}

const zoomOf = async () => {
  const rect = (await nodeRects())[0];
  return rect.w / 232;
};

// ---------- driving the page the way a hand does ----------

/** Brings a node fully onto the canvas by zooming out (the controls), as far as it takes. */
async function bringInView(id) {
  for (let tries = 0; tries < 8; tries += 1) {
    const node = (await nodeRects()).find((rect) => rect.id === id);
    const canvas = await canvasRect();
    if (
      node &&
      inside(node, canvas, 12) &&
      !(await panelRects()).some((panel) => meets(node, panel))
    )
      return;
    await page.locator('.react-flow__controls-zoomout').click();
    await wait(350);
  }
}

/** A click as a real hand makes it: the pointer wobbles by a few pixels between pressing and releasing. */
async function click(id, { wobble = [3, 2] } = {}) {
  await bringInView(id);
  const box = await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox();
  assert.ok(box, `node ${id} is on the page`);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + wobble[0], y + wobble[1] / 2);
  await page.mouse.move(x + wobble[0] / 2, y + wobble[1]);
  await page.mouse.up();
  await wait(300);
}

/** The map's «⋯» menu holds the direction, Arrange and the overview: open it and take one of them. */
async function fromMenu(testid) {
  await page.getByTestId('map-menu').click();
  await page.getByTestId(testid).click();
}

async function send(text) {
  const box = page.locator('#composer-input');
  await box.fill(text);
  await box.press('Control+Enter');
}

// ---------- the QC steps ----------

let id = '';
let tree = {};
const pinnedNodes = async () =>
  Object.values((await sessionOf(id)).nodes)
    .filter((node) => node.pinned)
    .map((node) => node.id);

try {
  const made = await call('/sessions', 'POST', {
    question: 'کدام پایگاه داده برای شروع بهتر است؟',
    seats: [
      seat('a', 'claude', 'fake-1'),
      seat('b', 'codex', 'fake-1', true),
      seat('c', 'pi', 'fake-2'),
    ],
    chairman: { harness: 'pi', model: 'fake-2', effort: '' },
    budgets: { maxClaims: 5, maxWords: 30 },
  });
  id = made.id;
  await page.goto(`${origin}/#/s/${id}`);
  await page.waitForSelector('[data-testid=chair-panel] [data-testid=answer]', { timeout: 30_000 });
  await settle(id);
  const round1 = chairs(await sessionOf(id))[0];

  // 1-2: a comment makes branch A
  await send('شاخهٔ الف: اگر داده‌ها بزرگ شوند؟');
  await until(async () => chairs(await sessionOf(id)).length === 2);
  await settle(id);

  // 3: select round 1 (a click), another comment makes branch B
  await check('step 3: a click on round 1 selects it and pins nothing', async () => {
    await click(round1.id);
    await page.waitForSelector(
      `.react-flow__node[data-id="${round1.id}"] .dv-node[data-selected]`,
      { timeout: 3000 },
    );
    assert.deepEqual(await pinnedNodes(), [], 'a click is not a drag');
  });
  await page.locator(`.react-flow__node[data-id="${round1.id}"]`).dispatchEvent('click');
  await send('شاخهٔ ب: و اگر بودجه کم باشد؟');
  await until(async () => chairs(await sessionOf(id)).length === 3);
  await settle(id);

  // 4: on B, a round without a comment, then one more round
  await page.getByTestId('critique').click();
  await until(async () => chairs(await sessionOf(id)).length === 4);
  await settle(id);
  await send('یک دور دیگر روی شاخهٔ ب');
  await until(async () => chairs(await sessionOf(id)).length === 5);
  await settle(id);
  tree = await sessionOf(id);
  const kids = Object.values(tree.nodes).filter((node) => node.parentId === round1.id);
  const branchA = kids.find((node) => node.text?.startsWith('شاخهٔ الف'));
  const branchB = kids.find((node) => node.text?.startsWith('شاخهٔ ب'));
  assert.ok(branchA && branchB, 'both branches exist');

  await check(
    'the map toolbar is one «⋯» menu; the minimap is off until it is asked for there, and the choice is kept',
    async () => {
      assert.equal(await page.locator('.react-flow__minimap').count(), 0, 'off by default');
      assert.equal(await page.getByTestId('dir-TB').count(), 0, 'the layout tools are folded away');
      assert.equal(await page.getByTestId('arrange').count(), 0);
      assert.equal(await page.locator('.react-flow__controls-zoomin').count(), 1, 'zoom stays');
      await page.getByTestId('map-menu').click();
      assert.equal(await page.getByTestId('minimap-toggle').getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByTestId('dir-TB').getAttribute('aria-checked'), 'true');
      await page.getByTestId('minimap-toggle').click();
      await wait(400);
      assert.equal(await page.locator('.react-flow__minimap').count(), 1, 'shown from the menu');
    },
  );
  await shot('b1-before-edit');
  await check(
    'every line of every node fits its box (nothing is cut mid-word by the edge)',
    async () => {
      const clipped = await page.$$eval('.dv-node__title', (els) =>
        els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
      );
      assert.deepEqual(clipped, []);
    },
  );
  await check('before the edit: the tree is clean', async () =>
    assertTreeIsClean('before the edit'),
  );

  // 5: select B's first user node (a click), edit its text, press the button
  let edited;
  await check('step 5: a click on the first input of B selects it and pins nothing', async () => {
    await click(branchB.id);
    await page.waitForSelector(
      `.react-flow__node[data-id="${branchB.id}"] .dv-node[data-selected]`,
      { timeout: 3000 },
    );
    assert.deepEqual(await pinnedNodes(), [], 'a click is not a drag');
  });
  // whatever the click did, the node is selected for the edit
  await page.locator(`.react-flow__node[data-id="${branchB.id}"]`).dispatchEvent('click');
  await page.locator('#edit-input').fill('شاخهٔ ب، ویرایش‌شده: و اگر بودجه خیلی کم باشد؟');
  await page.getByTestId('edit-run').click();
  await until(async () => chairs(await sessionOf(id)).length === 6);
  await settle(id);
  tree = await sessionOf(id);
  edited = Object.values(tree.nodes).find((node) => node.editedFrom === branchB.id);
  assert.ok(edited, 'the edited copy exists as a sibling');

  await shot('b1-after-edit');
  await check('after the edit: nothing overlaps, no dot lies on a node', async () =>
    assertTreeIsClean('after the edit'),
  );
  await check('after the edit: A, B and the edited copy stand side by side on one row', async () =>
    assertSiblingsSideBySide(tree, round1.id, 'after the edit'),
  );
  await check(
    'after the edit: the view is framed on the new round, clear of the minimap and the toolbar',
    async () => assertSelectedIsClear('after the edit'),
  );
  await check('after the edit: no branch is cropped at the side', async () =>
    assertBranchesVisible(tree, round1.id, 'after the edit'),
  );
  await check('after the edit: nobody was pinned by the clicks', async () =>
    assert.deepEqual(await pinnedNodes(), []),
  );

  // a write made against old revisions (a late save, another tab) is refused by the server and changes nothing
  await check(
    'a stale layout write is refused with 409 and the current places; the tree is not disturbed',
    async () => {
      const before = Object.fromEntries(
        Object.values((await sessionOf(id)).nodes).map((node) => [
          node.id,
          [node.position, node.pinned, node.layoutRev],
        ]),
      );
      const stale = (opId) =>
        fetch(`${origin}/api/sessions/${id}/layout`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            opId,
            nodes: {
              [branchA.id]: { x: 0, y: 54, pinned: true, rev: 99 },
              [branchB.id]: { x: 0, y: 54, pinned: true, rev: 0 },
            },
          }),
        });
      const reply = await stale(`e2e-stale-${Date.now()}`);
      assert.equal(reply.status, 409);
      const refusal = await reply.json();
      assert.equal(refusal.error, 'stale');
      assert.ok(
        refusal.nodes[branchA.id] && refusal.nodes[branchB.id],
        'the current place of every node of the write',
      );
      assert.equal(refusal.nodes[branchB.id].layoutRev, tree.nodes[branchB.id].layoutRev ?? 0);
      // all or none: the node whose revision was right was not moved either
      const after = Object.fromEntries(
        Object.values((await sessionOf(id)).nodes).map((node) => [
          node.id,
          [node.position, node.pinned, node.layoutRev],
        ]),
      );
      assert.deepEqual(after, before, 'nothing changed');
      await wait(500);
      await assertTreeIsClean('after a refused write');
      await assertSiblingsSideBySide(await sessionOf(id), round1.id, 'after a refused write');
    },
  );

  // «چیدن»: the view is framed again, and it is the tree that is framed
  await check('«چیدن» frames the tree again', async () => {
    // pan the canvas away by hand first
    const canvas = await canvasRect();
    await page.mouse.move(canvas.x + canvas.w / 2, canvas.y + 200);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.w / 2 + 160, canvas.y + 330, { steps: 6 });
    await page.mouse.up();
    await wait(300);
    await fromMenu('arrange');
    await wait(900);
    await shot('b1-after-arrange');
    await assertTreeIsClean('after «چیدن»');
    await assertSelectedIsClear('after «چیدن»');
  });

  // the minimap: the newest round, selected, is clear of it also in the other direction
  await check(
    'in the horizontal layout the selected round is also clear of the minimap',
    async () => {
      await fromMenu('dir-LR');
      await wait(1000);
      await assertTreeIsClean('horizontal');
      await assertSelectedIsClear('horizontal');
      await fromMenu('dir-TB');
      await wait(1000);
    },
  );

  // a session opened again is framed from scratch
  await check(
    'a session opened again is framed: the newest round is in view and clear',
    async () => {
      await page.goto(`${origin}/#/`);
      await page.waitForSelector('[data-testid=home]');
      await page.goto(`${origin}/#/s/${id}`);
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      await assertTreeIsClean('opened again');
      await assertSelectedIsClear('opened again');
      await assertBranchesVisible(await sessionOf(id), round1.id, 'opened again');
    },
  );

  // the explicit fit button shows the whole tree; the minimap can be clicked and put away
  const viewOf = () =>
    page.evaluate(() => {
      const matrix = new DOMMatrix(
        getComputedStyle(document.querySelector('.react-flow__viewport')).transform,
      );
      return { x: matrix.e, y: matrix.f, zoom: matrix.a };
    });
  await check(
    '«جا دادن همهٔ درخت در نما» puts EVERY node in view, below the readable zoom if it takes that, clear of the panels',
    async () => {
      await page.goto(`${origin}/#/s/${id}`);
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const total = Object.keys((await sessionOf(id)).nodes).length;
      assert.ok(total >= 10, `a big tree (${total} nodes)`);
      // the automatic framing keeps the readable zoom, so part of this tree is out of view
      assert.ok((await viewOf()).zoom >= 0.74, 'framed readable on its own');
      await page.locator('.react-flow__controls-fitview').click();
      await wait(800);
      await shot('b1-fit-all');
      const canvas = await canvasRect();
      // (the ghost of the next input is on the canvas too, and is not a node of the session)
      const nodes = (await nodeRects()).filter((rect) => !rect.id.startsWith('ghost:'));
      assert.equal(nodes.length, total);
      const panels = await panelRects();
      for (const node of nodes) {
        assert.ok(
          inside(node, canvas),
          `node ${node.id} is in view ${JSON.stringify([node, canvas])}`,
        );
        for (const panel of panels) {
          assert.equal(meets(node, panel), false, `node ${node.id} is under ${panel.id}`);
        }
      }
      const zoom = (await viewOf()).zoom;
      assert.ok(zoom < 0.74 && zoom >= 0.1, `fitted below the readable zoom (${zoom})`);
      // and the hand can zoom out that far too
      for (let i = 0; i < 6; i += 1) await page.locator('.react-flow__controls-zoomout').click();
      await wait(500);
      assert.ok((await viewOf()).zoom <= 0.2, `zoomed out by hand to ${(await viewOf()).zoom}`);
      await page.locator('.react-flow__controls-fitview').click();
      await wait(600);
    },
  );
  await check('the minimap pans the view when it is clicked', async () => {
    const map = await page.locator('.react-flow__minimap').boundingBox();
    assert.ok(map, 'the minimap is shown for a big tree');
    // zoom in so that there is somewhere to pan to
    for (let i = 0; i < 4; i += 1) await page.locator('.react-flow__controls-zoomin').click();
    await wait(500);
    const before = await viewOf();
    await page.mouse.click(map.x + map.width * 0.75, map.y + map.height * 0.8);
    await wait(500);
    const after = await viewOf();
    assert.ok(
      Math.abs(after.x - before.x) > 20 || Math.abs(after.y - before.y) > 20,
      `a click on the map moved the view (${JSON.stringify(before)} then ${JSON.stringify(after)})`,
    );
    assert.equal(after.zoom, before.zoom, 'without changing the zoom');
  });
  await check('the minimap can be hidden and shown again, and the choice is kept', async () => {
    await page.getByTestId('map-menu').click();
    assert.equal(await page.getByTestId('minimap-toggle').getAttribute('aria-checked'), 'true');
    await page.getByTestId('minimap-toggle').click();
    await wait(300);
    assert.equal(await page.locator('.react-flow__minimap').count(), 0, 'hidden');
    await page.reload();
    await page.waitForSelector('.react-flow__node');
    await wait(700);
    assert.equal(
      await page.locator('.react-flow__minimap').count(),
      0,
      'still hidden after a reload',
    );
    await fromMenu('minimap-toggle');
    await wait(300);
    assert.equal(await page.locator('.react-flow__minimap').count(), 1, 'shown again');
    // and the node that is selected is clear of it again
    await wait(400);
    await assertSelectedIsClear('after the minimap came back');
  });

  // a smaller tree is shown whole when it fits at a readable size
  await check('a tree that fits at a readable size is shown whole when it is opened', async () => {
    const small = await call('/sessions', 'POST', {
      question: 'پرسش کوتاه',
      seats: [
        seat('a', 'claude', 'fake-1'),
        seat('b', 'codex', 'fake-1', true),
        seat('c', 'pi', 'fake-2'),
      ],
      chairman: { harness: 'pi', model: 'fake-2', effort: '' },
      budgets: { maxClaims: 5, maxWords: 30 },
    });
    assert.ok(small.id, `the small session was made: ${JSON.stringify(small)}`);
    await settle(small.id);
    const first = chairs(await sessionOf(small.id))[0];
    for (const text of ['شاخهٔ یک', 'شاخهٔ دو']) {
      await call(`/sessions/${small.id}/rounds`, 'POST', { fromNodeId: first.id, text });
      await settle(small.id);
    }
    await page.goto(`${origin}/#/`);
    await page.waitForSelector('[data-testid=home]');
    await page.goto(`${origin}/#/s/${small.id}`);
    await page.waitForSelector('.react-flow__node');
    await wait(900);
    const canvas = await canvasRect();
    const nodes = (await nodeRects()).filter((rect) => !rect.id.startsWith('ghost:'));
    assert.equal(nodes.length, 6);
    for (const node of nodes)
      assert.ok(
        inside(node, canvas),
        `node ${node.id} is cut off ${JSON.stringify([node, canvas])}`,
      );
    // and no node is under the toolbar
    const toolbar = (await panelRects()).find((panel) => panel.id.includes('dv-toolbar'));
    for (const node of nodes) {
      assert.equal(meets(node, toolbar), false, `node ${node.id} lies under the toolbar`);
    }
    assert.ok((await zoomOf()) >= 0.74, 'at a readable size');
    await page.goto(`${origin}/#/s/${id}`);
    await page.waitForSelector('.react-flow__node');
    await wait(700);
  });

  // ---------- a drag is never lost: not to the events of a round, not to a failed save, not to a reload ----------
  /** A real pointer drag of a node by (dx, dy) screen pixels, in ten steps. */
  async function dragBy(nodeId, dx, dy) {
    await bringInView(nodeId);
    const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
    assert.ok(box, `node ${nodeId} is on the page`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
    await page.mouse.up();
  }
  const rectOfNode = async (nodeId) => (await nodeRects()).find((rect) => rect.id === nodeId);

  await check(
    'a drag made while a round runs is not overwritten by that round’s events (the save is slow, the events are not)',
    async () => {
      process.env.DIVAN_FAKE_DELAY_MS = '700';
      try {
        const made = await call('/sessions', 'POST', {
          question: 'سنجش رویدادهای دور',
          seats: [
            seat('a', 'claude', 'fake-1'),
            seat('b', 'codex', 'fake-1', true),
            seat('c', 'pi', 'fake-slow'),
          ],
          chairman: { harness: 'pi', model: 'fake-2', effort: '' },
          budgets: { maxClaims: 5, maxWords: 30 },
        });
        assert.ok(made.id, 'the session was made');
        await page.goto(`${origin}/#/s/${made.id}`);
        const firstChair = chairs(await sessionOf(made.id))[0];
        await page.waitForSelector(`.react-flow__node[data-id="${firstChair.id}"]`);
        await wait(500);
        // the answer to a layout save comes late; what the round says meanwhile comes at once
        await page.route('**/api/sessions/*/layout', async (route) => {
          await wait(2600);
          await route.continue().catch(() => undefined);
        });
        const chairId = chairs(await sessionOf(made.id))[0].id;
        const before = await rectOfNode(chairId);
        await dragBy(chairId, 110, 30);
        await wait(300);
        const dropped = await rectOfNode(chairId);
        assert.ok(
          dropped.x - before.x > 80,
          `the node moved with the pointer (${dropped.x - before.x})`,
        );
        // for the next four seconds the node stays where it was dropped, whatever the round sends
        const wandered = [];
        for (let i = 0; i < 40; i += 1) {
          await wait(100);
          const now = await rectOfNode(chairId);
          if (Math.abs(now.x - dropped.x) > 4 || Math.abs(now.y - dropped.y) > 4) {
            wandered.push(
              `${i * 100} ms: ${Math.round(now.x - dropped.x)},${Math.round(now.y - dropped.y)}`,
            );
          }
        }
        assert.deepEqual(wandered, [], 'the dropped node was moved by the round’s events');
        await page.unroute('**/api/sessions/*/layout');
        await settle(made.id);
        const stored = (await sessionOf(made.id)).nodes[chairId];
        assert.equal(stored.pinned, true, 'the pin reached the server');
        const last = await rectOfNode(chairId);
        assert.ok(
          Math.abs(last.x - dropped.x) <= 4 && Math.abs(last.y - dropped.y) <= 4,
          'and the node is still where it was dropped when the round is saved',
        );
      } finally {
        process.env.DIVAN_FAKE_DELAY_MS = '';
        await page.unroute('**/api/sessions/*/layout').catch(() => undefined);
      }
    },
  );

  /** The place of a node relative to its parent, in flow units: the same whatever the zoom is. */
  const offsetIn = async (pg, nodeId, parentId) => {
    const rects = await pg.$$eval('.react-flow__node', (els) =>
      els.map((el) => {
        const b = el.getBoundingClientRect();
        return { id: el.getAttribute('data-id'), x: b.x, y: b.y, w: b.width };
      }),
    );
    const node = rects.find((rect) => rect.id === nodeId);
    const from = rects.find((rect) => rect.id === parentId);
    const z = node.w / 232;
    return { x: Math.round((node.x - from.x) / z), y: Math.round((node.y - from.y) / z) };
  };

  await check(
    'a drag whose save fails is kept and shown, sent again when the network is back, and the page asks before it is left',
    async () => {
      await page.goto(`${origin}/#/s/${id}`);
      await unpinAll(id);
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const session = await sessionOf(id);
      const target = Object.values(session.nodes).find((node) => node.id === edited.id);
      const offset = () => offsetIn(page, target.id, target.parentId);
      let moved = { x: 0, y: 0 };
      await page.route('**/api/sessions/*/layout', (route) => route.abort());
      try {
        await dragBy(target.id, 70, 50);
        await wait(900);
        moved = await offset();
        assert.equal(
          (await sessionOf(id)).nodes[target.id].pinned,
          false,
          'the server has not got it',
        );
        assert.equal(
          await page.getByTestId('layout-failed').isVisible(),
          true,
          'a save that fails is shown to the user, not only logged',
        );
        assert.ok(
          Math.abs((await offset()).x - moved.x) <= 1,
          'and the node stays where it was dropped',
        );
        // leaving the page now would lose it (nothing is stored): the browser is asked first
        let prompt = null;
        page.once('dialog', async (dialog) => {
          prompt = dialog.type();
          await dialog.dismiss();
        });
        await page.reload({ timeout: 4000 }).catch(() => undefined);
        assert.equal(
          prompt,
          'beforeunload',
          'the page asks before it is left with a change that was not saved',
        );
        assert.ok(Math.abs((await offset()).x - moved.x) <= 1, 'and it stayed');
      } finally {
        await page.unroute('**/api/sessions/*/layout').catch(() => undefined);
      }
      // the network is back: «تلاش دوباره» sends the same change
      await page.getByTestId('layout-retry').click();
      await until(async () => (await sessionOf(id)).nodes[target.id].pinned === true, 15_000);
      await wait(500);
      assert.equal(await page.getByTestId('layout-failed').count(), 0, 'the notice is gone');
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const final = await offset();
      assert.ok(
        Math.abs(final.x - moved.x) <= 2 && Math.abs(final.y - moved.y) <= 2,
        'and it is on the server',
      );
      await unpinAll(id);
    },
  );

  await check(
    'a token the server does not know pauses the layout saves, says so, and sends after the page is connected again',
    async () => {
      await page.goto(`${origin}/#/s/${id}`);
      await unpinAll(id);
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const target = (await sessionOf(id)).nodes[edited.id];
      await page.route('**/api/sessions/*/layout', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'bad_token', message: 'token' }),
        }),
      );
      try {
        await dragBy(target.id, 60, 40);
        await wait(900);
        assert.equal((await sessionOf(id)).nodes[target.id].pinned, false, 'not sent');
        assert.match(await page.getByTestId('layout-auth').innerText(), /Reconnect needed/u);
        assert.equal(
          await page.getByTestId('layout-failed').count(),
          0,
          'it is not the retrying kind of failure',
        );
        await wait(3500); // the pause of a network failure would have retried by now: nothing is sent
      } finally {
        await page.unroute('**/api/sessions/*/layout').catch(() => undefined);
      }
      await page.getByTestId('layout-retry').click();
      await until(async () => (await sessionOf(id)).nodes[target.id].pinned === true, 15_000);
      await wait(300);
      assert.equal(await page.getByTestId('layout-auth').count(), 0, 'connected again');
      await unpinAll(id);
    },
  );

  await check(
    "two tabs: the second tab's drag of the same node is kept by the server, and the first tab's late write is refused and adopts it",
    async () => {
      const second = await app.context.newPage();
      try {
        await page.goto(`${origin}/#/s/${id}`);
        await unpinAll(id);
        await page.reload();
        // a tab of its own has its own token: it is opened with the address the server printed
        await second.goto(server.url);
        await second.waitForSelector('[data-testid=home]');
        await second.goto(`${origin}/#/s/${id}`);
        await second.waitForSelector('.react-flow__node');
        await page.waitForSelector('.react-flow__node');
        await wait(900);
        const target = (await sessionOf(id)).nodes[edited.id];
        // the first tab's write is slow
        await page.route('**/api/sessions/*/layout', async (route) => {
          await wait(2500);
          await route.continue().catch(() => undefined);
        });
        await dragBy(target.id, 90, 0);
        // the second tab drags the same node the other way and is saved at once
        const box = await second.locator(`.react-flow__node[data-id="${target.id}"]`).boundingBox();
        await second.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await second.mouse.down();
        await second.mouse.move(box.x + box.width / 2 - 90, box.y + box.height / 2 + 30, {
          steps: 10,
        });
        await second.mouse.up();
        await until(async () => (await sessionOf(id)).nodes[target.id].pinned === true, 10_000);
        const seconds = (await sessionOf(id)).nodes[target.id];
        // the first tab's write arrives with the old revision: refused, nothing changes on the server
        await wait(3500);
        const final = (await sessionOf(id)).nodes[target.id];
        assert.deepEqual(
          final.position,
          seconds.position,
          "the server kept the second tab's place",
        );
        assert.equal(final.layoutRev, seconds.layoutRev, 'and wrote nothing more');
        await wait(500);
        const mine = await offsetIn(page, target.id, target.parentId);
        const theirs = await offsetIn(second, target.id, target.parentId);
        assert.ok(
          Math.abs(mine.x - theirs.x) <= 2 && Math.abs(mine.y - theirs.y) <= 2,
          `the first tab shows what is true now: ${JSON.stringify(mine)} and ${JSON.stringify(theirs)}`,
        );
        assert.equal(await page.getByTestId('layout-failed').count(), 0, 'it is not a failure');
      } finally {
        await page.unroute('**/api/sessions/*/layout').catch(() => undefined);
        await second.close().catch(() => undefined);
        await unpinAll(id);
      }
    },
  );

  // ---------- the drag: a real pointer moves a node, pins it, and the place is still there after a reload ----------
  await check(
    'a real pointer drag moves a node, pins it, and the place survives a reload',
    async () => {
      await unpinAll(id);
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const session = await sessionOf(id);
      const target = Object.values(session.nodes).find(
        (node) =>
          node.kind === 'user' &&
          node.id !== session.rootId &&
          node.parentId !== null &&
          node.id === edited.id,
      );
      await bringInView(target.id);
      const parent = session.nodes[target.parentId];
      const rectOf = async (nodeId) => (await nodeRects()).find((rect) => rect.id === nodeId);
      const before = await rectOf(target.id);
      const parentBefore = await rectOf(parent.id);
      const zoom = before.w / 232;
      await page.mouse.move(before.x + before.w / 2, before.y + before.h / 2);
      await page.mouse.down();
      await page.mouse.move(before.x + before.w / 2 + 70, before.y + before.h / 2 + 50, {
        steps: 10,
      });
      await page.mouse.up();
      await until(async () => (await sessionOf(id)).nodes[target.id].pinned === true);
      await wait(800); // the node glides to its place
      const stored = (await sessionOf(id)).nodes[target.id];
      assert.ok(stored.position, 'a position is stored');
      const after = await rectOf(target.id);
      // it followed the pointer: by about (70, 50) screen pixels (React Flow does not count the move that starts a drag)
      assert.ok(
        after.x - before.x >= 55 &&
          after.x - before.x <= 72 &&
          after.y - before.y >= 38 &&
          after.y - before.y <= 52,
        `the node followed the pointer (moved ${after.x - before.x}, ${after.y - before.y})`,
      );
      const offset = async () => {
        const node = await rectOf(target.id);
        const from = await rectOf(parent.id);
        const z = node.w / 232;
        return { x: Math.round((node.x - from.x) / z), y: Math.round((node.y - from.y) / z) };
      };
      const moved = await offset();
      assert.ok(zoom > 0 && parentBefore, 'measured');
      // after a reload the same place, relative to its parent, whatever the zoom is
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const again = await offset();
      assert.ok(
        Math.abs(again.x - moved.x) <= 2 && Math.abs(again.y - moved.y) <= 2,
        `the moved place persisted: ${JSON.stringify(moved)} then ${JSON.stringify(again)}`,
      );
      const reloaded = (await sessionOf(id)).nodes[target.id];
      assert.deepEqual(reloaded.position, stored.position);
      assert.equal(reloaded.pinned, true);
      // and nothing else was pinned, and nothing overlaps
      assert.deepEqual(await pinnedNodes(), [target.id]);
      await assertTreeIsClean('after the drag');
    },
  );

  // ---------- the panel: the answer keeps its room while a comment is written ----------
  await check(
    'at 800 px high the answer keeps at least 40% of the panel, before and while a comment is written, on a past node',
    async () => {
      await page.setViewportSize({ width: 1440, height: 800 });
      await page.goto(`${origin}/#/s/${id}`);
      await page.reload();
      await page.waitForSelector('.react-flow__node');
      await wait(900);
      const sizes = async () =>
        page.evaluate(() => {
          const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
          const panel = box('[data-testid=chair-panel], [data-testid=user-panel]');
          const body = box('[data-testid=panel-body]');
          const field = box('#composer-input, #edit-input');
          return {
            panel: panel.height,
            body: body.height,
            fieldTop: field?.top ?? 0,
            fieldBottom: field?.bottom ?? 0,
            panelBottom: panel.bottom,
            hint:
              document
                .querySelector('[data-testid=composer-hint], [data-testid=edit-hint]')
                ?.getBoundingClientRect().height ?? 0,
          };
        });
      // a past round (it has children): its comment box
      const past = chairs(await sessionOf(id)).find((node) => node.round === 1);
      await page.locator(`.react-flow__node[data-id="${past.id}"]`).dispatchEvent('click');
      await page.waitForSelector('#composer-input');
      let now = await sizes();
      assert.ok(
        now.body >= now.panel * 0.4,
        `the answer has ${Math.round((now.body / now.panel) * 100)}% of the panel before`,
      );
      assert.ok(now.hint < 40, `the hint is one compact line (${now.hint}px)`);
      await page.locator('#composer-input').focus();
      await page
        .locator('#composer-input')
        .fill('نظری که روی یک دور قدیمی نوشته می‌شود و چند خط دارد و باز هم ادامه دارد');
      await wait(300);
      now = await sizes();
      assert.ok(
        now.body >= now.panel * 0.4,
        `the answer has ${Math.round((now.body / now.panel) * 100)}% of the panel while writing`,
      );
      assert.ok(now.fieldBottom <= now.panelBottom + 1, 'the box stays inside the panel');
      // an input of the past (its edit): the same
      const input = Object.values((await sessionOf(id)).nodes).find(
        (node) => node.id === edited.id,
      );
      await page.locator(`.react-flow__node[data-id="${input.id}"]`).dispatchEvent('click');
      await page.waitForSelector('#edit-input');
      now = await sizes();
      assert.ok(
        now.body >= now.panel * 0.4,
        `the user panel has ${Math.round((now.body / now.panel) * 100)}% for its text before`,
      );
      await page.locator('#edit-input').focus();
      await wait(300);
      now = await sizes();
      assert.ok(
        now.body >= now.panel * 0.4,
        `and while the edit is written (${Math.round((now.body / now.panel) * 100)}%)`,
      );
      await page.setViewportSize({ width: 1440, height: 900 });
    },
  );

  // ---------- the page never scrolls ----------
  await check(
    'the shell is exactly the window; opening and scrolling the answer and the details never moves the page',
    async () => {
      await unpinAll(id);
      await page.reload();
      await page.waitForSelector('[data-testid=panel-body]');
      // a round (the page may have reopened on an input)
      await page.locator(`.react-flow__node[data-id="${round1.id}"]`).dispatchEvent('click');
      await page.waitForSelector('[data-testid=chair-panel]');
      await wait(900);
      const metrics = () =>
        page.evaluate(() => {
          const shell = document.querySelector('[data-slot=sidebar-wrapper]');
          const bar = document.querySelector('header');
          return {
            inner: innerHeight,
            shell: Math.round(shell.getBoundingClientRect().height),
            barTop: Math.round(bar.getBoundingClientRect().top),
            docScroll: document.scrollingElement.scrollTop,
            docHeight: document.scrollingElement.scrollHeight,
            shellScroll: shell.scrollTop,
            panelScroll: document.querySelector('[data-testid=panel-body]')?.scrollTop ?? -1,
          };
        });
      const before = await metrics();
      assert.equal(
        before.shell,
        before.inner,
        `the shell is exactly the window (${before.shell} in ${before.inner})`,
      );
      assert.ok(
        before.docHeight <= before.inner,
        `the document is not taller than the window (${before.docHeight} > ${before.inner})`,
      );
      await shot('b3-before-details');
      // a chip opens the details over the map; a long member list scrolls inside the drawer, never the page
      await page.getByTestId('chip-council').click();
      await page.getByTestId('details-drawer').waitFor();
      await wait(600);
      await page.locator('[data-testid=member-row] button').first().click();
      await wait(600);
      await shot('b3-after-details');
      const after = await metrics();
      assert.equal(after.barTop, before.barTop, 'the header bar did not move');
      assert.equal(after.barTop, 0);
      assert.equal(after.docScroll, 0);
      assert.equal(after.shellScroll, 0);
      assert.equal(after.panelScroll, before.panelScroll, 'and the answer did not scroll');
      await page.keyboard.press('Escape');
    },
  );
} catch (error) {
  failures.push(`the run itself: ${error.message}`);
  console.log(`- the run stopped: ${error.stack ?? error}`);
}

// the layout saves that were refused on purpose (the route is aborted) are the only errors that are expected
const unexpected = app.errors.filter(
  (text) =>
    !text.includes('net::ERR_FAILED') &&
    !text.includes('status of 401') &&
    !text.includes('status of 409'),
);
if (unexpected.length > 0) {
  failures.push('page errors');
  console.log(`- page errors:\n    ${unexpected.join('\n    ')}`);
}
await app.close();
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed:\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('\nthe tree layout e2e passed');
