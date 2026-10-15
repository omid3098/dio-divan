// Small things the interface says: dates and times in Persian text, the one sentence about a member that is missing, the
// plain line for a failed round, markdown marks taken out of a preview line, and the profile id that can be changed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine.ts';
import { SettingsService } from '../src/server/settings.ts';
import { Store, summarize } from '../src/server/store.ts';
import { usableCandidates } from '../src/shared/defaults.ts';
import { type Note, note } from '../src/shared/messages.ts';
import { faDateTime, ltr } from '../src/shared/text.ts';
import type { ChairNode } from '../src/shared/types.ts';
import {
  failureLine,
  missingLine,
  plainText,
  roundFailureLine,
  SEAT_STATE,
  seatStateWord,
  seconds,
  typicalDuration,
} from '../web/src/fa.ts';
import { chairNode, tree, userNode } from './fixtures.ts';

beforeAll(() => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
});

describe('a date and time in Persian text', () => {
  it('uses the Persian calendar, Latin digits, the Persian comma and 24-hour time', () => {
    // 2026-10-11 02:46 in a fixed zone offset is not assumed: format a local time and read it back through the parts
    const local = new Date(2026, 9, 11, 2, 46);
    const text = faDateTime(local);
    expect(text).toMatch(/^\d{4}\/\d{2}\/\d{2}، \d{2}:\d{2}$/u);
    expect(text).not.toContain(',');
    expect(text.endsWith('، 02:46')).toBe(true);
    // 2026-10-11 is 1405/07/19
    expect(text.startsWith('1405/07/19')).toBe(true);
    // and a machine value keeps its left-to-right shape inside the Persian text
    expect(ltr('litellm/zai')).toBe('⁦litellm/zai⁩');
  });
});

describe('a member that did not answer, in one clean sentence', () => {
  it('says what kind of absence it was, why, and never stutters; a time-out is never «لغو شد»', () => {
    expect(missingLine('skipped', 'skipped: no credit')).toEqual({
      verb: 'این دور شرکت نکرد',
      why: 'اعتبار مدلش تمام شده',
    });
    expect(missingLine('skipped', 'skipped: rate limited').why).toBe('مدلش محدودیت سرعت دارد');
    const line = (state: Parameters<typeof missingLine>[0], error: string | null) => {
      const part = missingLine(state, error);
      return `عضو B ${part.verb}: ${part.why}.`;
    };
    // one colon, one full stop: never «پاسخ نداد: رد شد: اعتبار ندارد»
    expect(line('skipped', 'skipped: no credit')).toBe(
      'عضو B این دور شرکت نکرد: اعتبار مدلش تمام شده.',
    );
    expect(missingLine('timeout', 'timeout')).toEqual({
      verb: 'پاسخ نداد',
      why: '10 دقیقه هیچ نشانه‌ای از کار نداد و متوقف شد',
    });
    expect(missingLine('failed', '402 insufficient balance').why).toBe('اعتبار مدلش تمام شده');
    expect(missingLine('failed', 'boom').why).toBe('اجرایش ناموفق بود');
    expect(seatStateWord('timeout', 'timeout')).toBe('زمان پاسخ تمام شد');
    expect(SEAT_STATE.timeout).toBe('زمان پاسخ تمام شد');
    expect(failureLine('timeout', 'timeout')).not.toContain('لغو');
    expect(seatStateWord('failed', 'cancelled')).toBe('لغو شد');
    expect(seatStateWord('skipped', 'skipped: no credit')).toBe('شرکت نکرد');
  });
});

describe('what a failed round says without the identity', () => {
  it("keeps the engine's own sentences and tells the chairman's failure by its kind", () => {
    expect(roundFailureLine('کمتر از دو عضو خروجی معتبر دادند.')).toBe(
      'کمتر از دو عضو خروجی معتبر دادند.',
    );
    expect(roundFailureLine('رئیس ناموفق بود: timeout')).toBe(
      'رئیس 10 دقیقه هیچ نشانه‌ای از کار نداد و متوقف شد.',
    );
    expect(roundFailureLine('رئیس ناموفق بود: 429 rate limit')).toBe('مدل رئیس محدودیت سرعت دارد.');
    expect(roundFailureLine('رئیس ناموفق بود: 402 insufficient balance')).toBe(
      'اعتبار مدل رئیس تمام شده.',
    );
    expect(roundFailureLine('cancelled')).toBeNull();
    expect(roundFailureLine(null)).toBeNull();
    // a raw harness text is never repeated before the reveal
    expect(roundFailureLine('anthropic/claude-x said: boom')).toBeNull();
  });
});

describe('a preview line is plain text', () => {
  it('takes bold, code and heading marks out', () => {
    expect(plainText('**Rules** for `member` answers')).toBe('Rules for member answers');
    expect(plainText('## A heading')).toBe('A heading');
    expect(plainText('__also bold__ text')).toBe('also bold text');
    expect(plainText('2 * 3 stays')).toBe('2 * 3 stays');
  });
});

describe('the session list', () => {
  it("carries the newest finished round's direction, and nothing before there is one", () => {
    const older = { ...chairNode('c1', 'u0', 1), direction: 'first direction' };
    const newer = { ...chairNode('c2', 'u1', 2), direction: 'newest direction' };
    const nodes = tree([userNode('u0', null, 'Q'), older, userNode('u1', 'c1', 'a'), newer]);
    const session = {
      id: 's1',
      name: 'Q',
      createdAt: 'x',
      updatedAt: 'y',
      rootId: 'u0',
      nodes,
    } as never;
    const withTimes = (chair: ChairNode, at: string) => ({ ...chair, createdAt: at });
    nodes.c1 = withTimes(older, '2026-01-01T00:00:00.000Z');
    nodes.c2 = withTimes(newer, '2026-01-02T00:00:00.000Z');
    expect(summarize(session).direction).toBe('newest direction');
    const none = {
      id: 's2',
      name: 'Q',
      createdAt: 'x',
      updatedAt: 'y',
      rootId: 'u0',
      nodes: tree([userNode('u0', null, 'Q')]),
    } as never;
    expect(summarize(none).direction).toBeUndefined();
  });
});

describe("a profile of one's own can have another id", () => {
  let home: string;
  let store: Store;
  let settings: SettingsService;
  let engine: Engine;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'divan-id-'));
    store = new Store(home);
    await store.init();
    engine = new Engine(store, () => undefined);
    settings = new SettingsService(store);
  });
  afterEach(async () => {
    await engine.flush();
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('reuses an untouched first-run single atomically, preserves edited models, and leaves deliberate creation non-idempotent', async () => {
    const view = await settings.view();
    const candidate = usableCandidates(
      view.models.filter(
        (item) => view.status.find((status) => status.id === item.harness)?.usable,
      ),
    )[0];
    if (!candidate) throw new Error('Missing fake candidate');
    const firstRun = { harness: candidate.harness, model: candidate.model };
    const [one, two] = await Promise.all([
      settings.create('Single', undefined, undefined, 'single', firstRun),
      settings.create('Single', undefined, undefined, 'single', firstRun),
    ]);
    expect(one.id).toBe(two.id);
    const another = await settings.create('Single', undefined, undefined, 'single');
    expect(another.id).not.toBe(one.id);
    await settings.update(one.id, { defaultLevel: 'max' });
    expect((await settings.create('Single', undefined, undefined, 'single', firstRun)).id).toBe(
      another.id,
    );
    const edited = structuredClone((await settings.profile(another.id))?.effective.flow);
    if (!edited) throw new Error('Missing single flow');
    const agent = edited.nodes.find((node) => node.kind === 'agent');
    if (agent?.kind !== 'agent') throw new Error('Missing assistant');
    await settings.editLibrary('prompts', 'POST', undefined, {
      from: 'divan.direct',
      id: 'linked-direct',
      name: 'Linked direct',
    });
    agent.prompt = 'linked-direct';
    await settings.update(another.id, { flow: edited });
    const linkedCopy = await settings.create('Linked copy', another.id);
    expect((await settings.create('Single', undefined, undefined, 'single', firstRun)).id).not.toBe(
      linkedCopy.id,
    );
    agent.memory = !agent.memory;
    await settings.update(another.id, { flow: edited });
    const fresh = await settings.create('Single', undefined, undefined, 'single', firstRun);
    expect([one.id, another.id]).not.toContain(fresh.id);
    expect((await settings.profile(another.id))?.effective.flow).toEqual(edited);
    await expect(
      settings.create('Single', undefined, undefined, 'single', { ...firstRun, model: 'changed' }),
    ).rejects.toMatchObject({ code: 'first_run_changed' });
    await store.updateSettings((file) => {
      for (let i = Object.keys(file.profiles).length; i < 30; i++)
        file.profiles[`limit-${i}`] = {
          name: `Other ${i}`,
          base: 'default',
          revision: 1,
          overrides: {},
        };
      return file;
    });
    expect((await settings.create('Single', undefined, undefined, 'single', firstRun)).id).toBe(
      fresh.id,
    );
    await expect(
      settings.create('Deliberate', undefined, undefined, 'single'),
    ).rejects.toMatchObject({ code: 'too_many' });
  });

  it('keeps the profile (name, settings, generation), moves it to the new id, and raises the revision', async () => {
    const made = await settings.create('تحلیل مالی');
    expect(made.id).toMatch(/^[a-z0-9-]+$/u);
    await settings.update(made.id, { overrides: { seats: { claude: { model: 'fake-2' } } } });
    const before = (await settings.profile(made.id)) as NonNullable<
      Awaited<ReturnType<SettingsService['profile']>>
    >;
    const result = await settings.update(made.id, { id: 'finance' });
    expect(result.id).toBe('finance');
    expect(await settings.profile(made.id)).toBeUndefined();
    const after = (await settings.profile('finance')) as NonNullable<typeof before>;
    expect(after.name).toBe('تحلیل مالی');
    expect(after.generation).toBe(before.generation);
    expect(after.revision).toBe(before.revision + 1);
    expect(after.overrides).toEqual(before.overrides);
  });

  it('refuses an id that is not a plain id, one that is taken, and the id of an automatic profile', async () => {
    const one = await settings.create('One');
    const two = await settings.create('Two');
    await expect(settings.update(one.id, { id: 'Not Plain' })).rejects.toMatchObject({
      code: 'bad_id',
    });
    await expect(settings.update(one.id, { id: '' })).rejects.toMatchObject({ code: 'bad_id' });
    await expect(settings.update(one.id, { id: two.id })).rejects.toMatchObject({
      code: 'id_taken',
    });
    await expect(settings.update(one.id, { id: 'default' })).rejects.toMatchObject({
      code: 'id_taken',
    });
    await expect(settings.update('quick', { id: 'speedy' })).rejects.toMatchObject({
      code: 'auto_profile',
    });
    // nothing changed, and an unchanged id is not a change
    expect(await settings.profile(one.id)).toBeDefined();
    const before = (await settings.profile(one.id))?.revision;
    await settings.update(one.id, { id: one.id });
    expect((await settings.profile(one.id))?.revision).toBe(before);
  });

  it('says what is out of credit with a code and parameters: a provider, a whole assistant, a model', async () => {
    const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
    await store.addUnavailable({
      harness: 'pi',
      model: 'litellm/zai/glm-5.2',
      prefix: 'litellm/zai/',
      until,
      reason: '402 no credit',
    });
    await store.addUnavailable({
      harness: 'claude',
      model: 'fake-1',
      prefix: '',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'no credit',
    });
    const notes = (await settings.view()).notes;
    // the provider without its cut-off slash, with the time as an ISO text for the client to format
    expect(notes).toContainEqual(
      note('unavailable_provider', { provider: 'litellm/zai', harness: 'Pi', until }),
    );
    expect(notes.find((item) => item.code === 'unavailable_harness')?.params).toMatchObject({
      harness: 'Claude Code',
    });
    // every note is English text besides its code: the server words nothing in Persian
    for (const item of notes) expect(item.message).not.toMatch(/\p{Script=Arabic}/u);
    expect(notes.find((item) => item.code === 'unavailable_provider')?.message).toMatch(
      /^The models of litellm\/zai \(Pi\) were left out of the defaults until 2026-10-\d\d \d\d:\d\d UTC/u,
    );
  });
});

describe('the chairman’s form of address', () => {
  it('the schema asks for the form only while the session has not chosen one', async () => {
    const { nativeSchema, chairmanSchemaFor } = await import('../src/server/prompts.ts');
    const chairman = chairmanSchemaFor({
      maxClaims: 5,
      maxWords: 30,
    });
    const asked = nativeSchema(chairman, false, true) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(asked.properties.register).toEqual({ enum: ['formal', 'informal'] });
    expect(asked.required).toContain('register');
    const later = nativeSchema(chairman, false, false) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect('register' in later.properties).toBe(false);
    expect(later.required).not.toContain('register');
  });
});

describe('what the setup banner says is plain Persian', () => {
  it('a Pi seat that finds no free family says so in one sentence', async () => {
    const { computeDefaults } = await import('../src/shared/defaults.ts');
    const model = (id: string) => ({ id, label: id, efforts: [], defaultEffort: '' });
    const item = (harness: 'claude' | 'codex' | 'grok' | 'pi', ids: string[]) => ({
      harness,
      models: ids.map(model),
      listed: true,
      defaultModel: ids[0] ?? '',
      unavailable: [],
      note: null,
      fallbackEfforts: [],
      fetchedAt: '',
    });
    const notes: Note[] = [];
    computeDefaults(
      [
        item('claude', ['claude-a']),
        item('codex', ['gpt-a']),
        item('pi', ['litellm/anthropic/claude-a', 'litellm/chatgpt/gpt-a']),
      ],
      undefined,
      notes,
    );
    expect(notes).toEqual([note('pi_not_member', { harness: 'Pi' })]);
    // when Pi is the chairman, the note says that Pi is only that («رئیس: Pi» is on the same screen)
    const asChairman: Note[] = [];
    const defaults = computeDefaults(
      [
        item('claude', ['claude-a']),
        item('codex', ['gpt-a']),
        item('pi', [
          'litellm/anthropic/claude-b',
          'litellm/chatgpt/gpt-b',
          'litellm/deepseek/deepseek-c',
        ]),
      ],
      undefined,
      asChairman,
    );
    expect(defaults.chairman.harness).toBe('pi');
    expect(asChairman[0]?.code).toBe('pi_not_member_chairman');
  });
});

describe('durations in Persian, with Latin digits', () => {
  it('seconds and milliseconds are written with Persian units', () => {
    expect(seconds(399)).toBe('399 میلی‌ثانیه');
    expect(seconds(37_000)).toBe('37 ثانیه');
    expect(seconds(6_234)).toBe('6.2 ثانیه');
    expect(seconds(142_000)).toBe('142 ثانیه');
  });

  it('what a round usually takes is a range whenever two or more were measured; «حدود» only for a single measurement', () => {
    expect(typicalDuration(37, 62, 5)).toEqual({ text: '30 تا 70 ثانیه', upper: 70 });
    expect(typicalDuration(40.2, 42, 3).text).toBe('40 تا 45 ثانیه'); // close together, still a range
    expect(typicalDuration(41, 41, 1).text).toBe('حدود 40 ثانیه');
    expect(typicalDuration(100, 170, 4).text).toBe('1 تا 3 دقیقه');
    expect(typicalDuration(40, 400, 4).text).toBe('40 ثانیه تا 7 دقیقه');
  });
});
