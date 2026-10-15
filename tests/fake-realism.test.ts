// The fake harnesses stand in for real ones in test mode, so they must look like real use: a call costs about 15k tokens of the
// harness's own overhead plus the text it reads plus a thousand to a few thousand tokens of answer, a round of four members and
// a chairman about 100k. The usage the app shows then looks real, and the chairman's
// titles and answers read like a person's: the first sentence of what was written, and an answer that answers it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine.ts';
import { Store } from '../src/server/store.ts';
import type { ChairNode, ReasoningLevel, SeatConfig, Session } from '../src/shared/types.ts';

let home: string;
beforeAll(() => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-real-'));
  // the tests of the realism run at the scale of a real call
  process.env.DIVAN_FAKE_USAGE = '1';
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
afterAll(() => {
  process.env.DIVAN_FAKE_USAGE = '0.05';
});

const HARNESSES = ['claude', 'codex', 'grok', 'pi'] as const;
const seats = (effort: string): SeatConfig[] =>
  HARNESSES.map((harness) => ({
    id: harness,
    enabled: true,
    harness,
    model: 'fake-1',
    effort,
    // codex and grok always have their tools on
    tools: harness === 'codex' || harness === 'grok',
    memory: false,
    web: false,
  }));
const chairman = { harness: 'pi' as const, model: 'fake-2', effort: 'medium' };
const budgets = { maxClaims: 5, maxWords: 30 };

async function setup() {
  const store = new Store(home);
  await store.init();
  return { store, engine: new Engine(store, () => undefined) };
}

const chairOf = (session: Session, round = 1) =>
  Object.values(session.nodes).find(
    (node): node is ChairNode => node.kind === 'chair' && node.round === round,
  ) as ChairNode;

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

const start = (
  engine: Engine,
  question: string,
  extra: { level?: ReasoningLevel; effort?: string } = {},
) =>
  engine.createSession({
    question,
    seats: seats(extra.effort ?? 'medium'),
    chairman,
    budgets,
    level: extra.level ?? 'medium',
  });

describe('a fake call costs what a real one does', () => {
  it('reports about 15k tokens of overhead beyond the prompt, and 1k to 3k of answer, more at a higher effort', async () => {
    const { engine } = await setup();
    const outputs: Record<string, number> = {};
    for (const effort of ['low', 'max']) {
      const session = await start(engine, 'Should I move?', { effort });
      const chair = chairOf(session);
      await until(() => chair.status !== 'running');
      expect(chair.status).toBe('done');
      const calls = (chair.attempts ?? []).filter((call) => call.kind === 'seat');
      expect(calls).toHaveLength(4);
      for (const call of calls) {
        const usage = call.usage;
        expect(usage?.source).toBe('harness');
        // the prompt plus the harness's overhead
        expect(usage?.input ?? 0).toBeGreaterThanOrEqual(call.promptTokens + 13_000);
        expect(usage?.input ?? 0).toBeLessThanOrEqual(call.promptTokens + 17_000);
        expect(usage?.output ?? 0).toBeGreaterThanOrEqual(900);
        expect(usage?.output ?? 0).toBeLessThanOrEqual(3_300);
        expect(usage?.total).toBe((usage?.input ?? 0) + (usage?.output ?? 0));
      }
      outputs[effort] = calls.reduce((sum, call) => sum + (call.usage?.output ?? 0), 0) / 4;
    }
    expect(outputs.low).toBeLessThan(outputs.max as number);
    expect(outputs.low).toBeLessThan(1_300);
    expect(outputs.max).toBeGreaterThan(2_700);
  });

  it('a round of four members and a chairman costs about as much as a real one (about 100k)', async () => {
    const { engine } = await setup();
    const session = await start(engine, 'Should I leave my stable job to start a company?');
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.usage.total).toBeGreaterThan(70_000);
    expect(chair.usage.total).toBeLessThan(130_000);
  });
});

describe('the fake chairman writes like a person', () => {
  const run = async (question: string, comment?: string) => {
    const { engine } = await setup();
    const session = await start(engine, question);
    const first = chairOf(session);
    await until(() => first.status !== 'running');
    let second: ChairNode | null = null;
    if (comment !== undefined) {
      await engine.startRound(session.id, first.id, comment);
      await until(() => chairOf(session, 2)?.status === 'done');
      second = chairOf(session, 2);
    }
    return { session, first, second };
  };

  it('the title is the first sentence as it was written, cut at a word boundary to about six words', async () => {
    const { session, first } = await run(
      'Should I leave my stable job as a senior engineer to start a company?',
    );
    expect(first.title).toBe('Should I leave my stable job…');
    expect((session.nodes[session.rootId] as { title: string }).title).toBe(first.title);
    // a short question is its own title
    const short = await run('Is it worth moving to Berlin?');
    expect(short.first.title).toBe('Is it worth moving to Berlin');
  });

  it('keeps the small words and never ends on one: no bag of keywords', async () => {
    const cases: [string, string][] = [
      [
        'I want to know whether we should hire a first salesperson now. Thoughts?',
        'I want to know whether…',
      ],
      ['What should the price of the plan be for small teams?', 'What should the price…'],
      ['آیا شغل پایدارم را رها کنم و شرکت خودم را بزنم؟', 'آیا شغل پایدارم را رها کنم…'],
    ];
    for (const [question, expected] of cases) {
      const { first } = await run(question);
      // a cut that would end on a small word backs up over it
      expect(first.title).toBe(expected);
    }
  });

  it('the answer answers what was written last: the question, then the comment', async () => {
    const { first, second } = await run(
      'Should we price per seat or per usage?',
      'Our biggest customer runs a pilot with forty users next month.',
    );
    expect(first.answer).toContain('Should we price per seat or per usage');
    expect(second?.answer).toContain(
      'Our biggest customer runs a pilot with forty users next month',
    );
    expect(second?.answer).not.toBe(first.answer);
    // no stray «Round N.» paragraph in either
    expect(first.answer).not.toMatch(/^Round \d+\.?$/mu);
    expect(second?.answer).not.toMatch(/^Round \d+\.?$/mu);
    expect(first.answer.trim().endsWith('.')).toBe(true);
    // and the second round's title follows the comment
    expect(second?.title).toBe('Our biggest customer runs a pilot…');
  });

  it('in Persian the title and the answer are in Persian and quote the asker', async () => {
    const { first } = await run('آیا شغل پایدارم را رها کنم و شرکت خودم را بزنم؟');
    expect(first.title).toMatch(/^آیا شغل/u);
    expect(first.title).not.toMatch(/[A-Za-z]/u);
    expect(first.answer).toContain('آیا شغل پایدارم را رها کنم و شرکت خودم را بزنم');
    expect(first.answer).not.toMatch(/^دور \d+\.?$/mu);
  });
});

describe('a critique is not «adjusted for the new input»', () => {
  it('the direction of a critique round says there was no new input, and the list tells the recommendation', async () => {
    const { engine } = await setup();
    const session = await start(engine, 'Should I leave my stable job to start a company?');
    const first = chairOf(session);
    await until(() => first.status !== 'running');
    await engine.startRound(session.id, first.id, null);
    await until(() => chairOf(session, 2)?.status === 'done');
    expect(chairOf(session, 2).direction).toBe('Re-examined without new input');
    // a round with an input is still adjusted for it
    await engine.startRound(session.id, first.id, 'Our biggest customer wants a pilot.');
    await until(
      () =>
        Object.values(session.nodes).filter(
          (node) => node.kind === 'chair' && node.status === 'done',
        ).length === 3,
    );
    const withInput = Object.values(session.nodes).filter(
      (node): node is ChairNode =>
        node.kind === 'chair' &&
        node.round === 2 &&
        node.direction === 'Adjusted for the new input',
    );
    expect(withInput).toHaveLength(1);
    // the list's preview line is the newest recommendation
    const { summarize } = await import('../src/server/store.ts');
    expect(summarize(session).recommendation).toEqual({ choice: 'Start small', confidence: 0.7 });
  });
});
