// The quick profile's chairman: the chairman is the slow part of a round, so it is chosen for speed, from a family that no
// kept seat uses, on low reasoning.

import { describe, expect, it } from 'vitest';
import { applyOverrides, resolveLevel } from '../src/server/settings.ts';
import {
  chairmanFamilyClash,
  chairmanKey,
  computeDefaults,
  NO_QUICK_FAMILY,
  QUICK_TWO_MEMBERS,
  quickProfile,
  sameModel,
  speedKey,
} from '../src/shared/defaults.ts';
import type { Note } from '../src/shared/messages.ts';
import { modelFamily } from '../src/shared/text.ts';
import type { HarnessId, HarnessModels, SettingsFull } from '../src/shared/types.ts';

const model = (id: string, efforts = ['low', 'medium', 'high']) => ({
  id,
  label: id,
  efforts,
  defaultEffort: 'medium',
});

const item = (
  harness: HarnessId,
  ids: string[],
  out: string[] = [],
  efforts?: string[],
): HarnessModels => ({
  harness,
  models: ids.map((id) => model(id, efforts)),
  listed: true,
  defaultModel: ids[0] ?? '',
  unavailable: out.map((id) => ({
    id,
    until: new Date(Date.now() + 3_600_000).toISOString(),
    reason: 'x',
  })),
  note: null,
  fallbackEfforts: [],
  fetchedAt: '',
});

const seat = (harness: HarnessId, id: string) => ({
  id: harness,
  enabled: true,
  harness,
  model: id,
  effort: 'high',
  tools: false,
  memory: false,
  web: false,
});

function setup(piModels: string[], out: string[] = []) {
  const models = [
    item('claude', ['claude-opus-a']),
    item('codex', ['gpt-a']),
    item('grok', ['grok-a']),
    item('pi', piModels, out),
  ];
  const defaults: SettingsFull = {
    seats: [
      seat('claude', 'claude-opus-a'),
      seat('codex', 'gpt-a'),
      seat('grok', 'grok-a'),
      { ...seat('pi', ''), enabled: false },
    ],
    chairman: { harness: 'pi', model: 'litellm/deepseek/deepseek-v4-pro', effort: 'high' },
    budgets: { maxClaims: 5, maxWords: 30 },
  };
  return { models, defaults };
}

describe('the quick profile chairman', () => {
  it('with nothing measured: a known-fast (lightweight) model of a free family, on low reasoning', () => {
    const { models, defaults } = setup([
      'litellm/chatgpt/gpt-6-luna', // the family of a kept seat: not free
      'litellm/deepseek/deepseek-v4-pro',
      'litellm/deepseek/deepseek-flash',
    ]);
    const quick = quickProfile(defaults, models, new Map());
    expect(quick.chairman).toEqual({
      harness: 'pi',
      model: 'litellm/deepseek/deepseek-flash',
      effort: 'low',
      tools: true,
      memory: false,
    });
    // the three quick seats stay, on low reasoning, and none shares the chairman's family
    expect(quick.seats.filter((one) => one.enabled)).toHaveLength(3);
    expect(quick.seats.every((one) => one.effort === 'low' || one.model === '')).toBe(true);
    expect(chairmanFamilyClash(quick.seats, quick.chairman)).toBe(false);
    // Both base and Quick default chairman memory on only when that harness can connect.
    const pi = models.find((item) => item.harness === 'pi') as HarnessModels;
    pi.memoryReady = true;
    expect(computeDefaults(models).chairman.memory).toBe(true);
    expect(quickProfile(defaults, models, new Map()).chairman.memory).toBe(true);
  });

  it('the fastest measured model at the level it would run at beats one nobody has timed', () => {
    const { models, defaults } = setup([
      'litellm/deepseek/deepseek-v4-pro',
      'litellm/deepseek/deepseek-flash',
    ]);
    const measured = new Map([
      [chairmanKey('pi', 'litellm/deepseek/deepseek-v4-pro', 'low'), 41],
      [chairmanKey('pi', 'litellm/deepseek/deepseek-flash', 'low'), 55],
    ]);
    expect(quickProfile(defaults, models, new Map(), measured).chairman.model).toBe(
      'litellm/deepseek/deepseek-v4-pro',
    );
    // a time measured at another level says nothing about low: the known-fast model stays first
    const slowAtMedium = new Map([
      [chairmanKey('pi', 'litellm/deepseek/deepseek-v4-pro', 'medium'), 118],
    ]);
    expect(quickProfile(defaults, models, new Map(), slowAtMedium).chairman.model).toBe(
      'litellm/deepseek/deepseek-flash',
    );
  });

  it('never a model that is out, and never a family a kept seat uses; medium when low is not offered, nothing when the model has no levels', () => {
    const { models, defaults } = setup(
      ['litellm/deepseek/deepseek-flash', 'litellm/deepseek/deepseek-v4-pro'],
      ['litellm/deepseek/deepseek-flash'],
    );
    expect(quickProfile(defaults, models, new Map()).chairman.model).toBe(
      'litellm/deepseek/deepseek-v4-pro',
    );
    const noLow = setup(['litellm/deepseek/deepseek-flash']);
    noLow.models[3] = item('pi', ['litellm/deepseek/deepseek-flash'], [], ['medium', 'high']);
    expect(quickProfile(noLow.defaults, noLow.models, new Map()).chairman.effort).toBe('medium');
    const none = setup(['litellm/deepseek/deepseek-flash']);
    none.models[3] = item('pi', ['litellm/deepseek/deepseek-flash'], [], []);
    expect(quickProfile(none.defaults, none.models, new Map()).chairman.effort).toBe('');
  });
});

describe("the chairman is not from the members' families", () => {
  const seatOf = (harness: HarnessId, id: string, enabled = true) => ({
    ...seat(harness, id),
    enabled,
  });
  const budgets = { maxClaims: 5, maxWords: 30 };

  it('when the quickest three leave no family, the slowest of them gives its place to the next seat that does (three stay)', () => {
    // four seats; Pi's is of the same family as Codex's, so only the Grok family is left to the chairman if Grok is dropped
    const models = [
      item('claude', ['claude-a']),
      item('codex', ['gpt-a']),
      item('grok', ['grok-a']),
      item('pi', ['litellm/chatgpt/gpt-b']),
    ];
    const defaults: SettingsFull = {
      seats: [
        seatOf('claude', 'claude-a'),
        seatOf('codex', 'gpt-a'),
        seatOf('grok', 'grok-a'),
        seatOf('pi', 'litellm/chatgpt/gpt-b'),
      ],
      chairman: { harness: 'grok', model: 'grok-a', effort: 'high' },
      budgets,
    };
    const latency = new Map<string, number>([
      [speedKey('claude', 'claude-a'), 10],
      [speedKey('codex', 'gpt-a'), 20],
      [speedKey('grok', 'grok-a'), 30],
      [speedKey('pi', 'litellm/chatgpt/gpt-b'), 40],
    ]);
    const notes: Note[] = [];
    const quick = quickProfile(defaults, models, latency, new Map(), notes);
    // Claude, Codex and Grok are the quickest three but use every family: Grok (the slowest of them) steps aside for Pi
    expect(quick.seats.filter((one) => one.enabled).map((one) => one.harness)).toEqual([
      'claude',
      'codex',
      'pi',
    ]);
    expect(quick.chairman.model).toBe('grok-a');
    expect(chairmanFamilyClash(quick.seats, quick.chairman)).toBe(false);
    expect(notes).toEqual([]);
  });

  it('a model a council was pinned to does not change Quick: only the speed of the models Quick uses does', () => {
    const models = [
      item('claude', ['claude-a']),
      item('codex', ['gpt-a']),
      item('grok', ['grok-a']),
      item('pi', ['litellm/chatgpt/gpt-b', 'deepseek-slow-pinned']),
    ];
    const defaults: SettingsFull = {
      seats: [
        seatOf('claude', 'claude-a'),
        seatOf('codex', 'gpt-a'),
        seatOf('grok', 'grok-a'),
        seatOf('pi', 'litellm/chatgpt/gpt-b'),
      ],
      chairman: { harness: 'claude', model: 'claude-a', effort: 'high' },
      budgets,
    };
    const roster = (latency: Map<string, number>) =>
      quickProfile(defaults, models, latency)
        .seats.filter((one) => one.enabled)
        .map((one) => one.harness)
        .sort();
    const own = new Map<string, number>([
      [speedKey('claude', 'claude-a'), 30],
      [speedKey('codex', 'gpt-a'), 20],
      [speedKey('grok', 'grok-a'), 25],
      [speedKey('pi', 'litellm/chatgpt/gpt-b'), 5],
    ]);
    const before = roster(own);
    expect(before).toContain('pi');
    // the user pinned Pi to a very slow model in the Default council and ran rounds on it: that is another model's speed
    const pinned = new Map(own).set(speedKey('pi', 'deepseek-slow-pinned'), 600);
    expect(roster(pinned)).toEqual(before);
    // while the model Quick itself uses getting slow does change it: that is the design
    const slower = new Map(own).set(speedKey('pi', 'litellm/chatgpt/gpt-b'), 600);
    expect(roster(slower)).not.toContain('pi');
  });

  it('with no such seat, two members are enough, and it is said', () => {
    const models = [
      item('claude', ['claude-a']),
      item('codex', ['gpt-a']),
      item('grok', ['grok-a']),
    ];
    const defaults: SettingsFull = {
      seats: [seatOf('claude', 'claude-a'), seatOf('codex', 'gpt-a'), seatOf('grok', 'grok-a')],
      chairman: { harness: 'grok', model: 'grok-a', effort: 'high' },
      budgets,
    };
    const notes: Note[] = [];
    const quick = quickProfile(defaults, models, new Map(), new Map(), notes);
    expect(quick.seats.filter((one) => one.enabled).map((one) => one.harness)).toEqual([
      'claude',
      'codex',
    ]);
    expect(quick.chairman.model).toBe('grok-a');
    expect(notes).toEqual([QUICK_TWO_MEMBERS]);
  });

  it('with no free family even for two members, quick is not built: the default chairman stays and a note says so', () => {
    // two seats, two families, no other model: every chairman would share a family with a member
    const models = [item('claude', ['claude-a']), item('codex', ['gpt-a'])];
    const defaults: SettingsFull = {
      seats: [seatOf('claude', 'claude-a'), seatOf('codex', 'gpt-a')],
      chairman: { harness: 'claude', model: 'claude-a', effort: 'high' },
      budgets,
    };
    const notes: Note[] = [];
    const quick = quickProfile(defaults, models, new Map(), new Map(), notes);
    expect(notes).toEqual([NO_QUICK_FAMILY]);
    expect(NO_QUICK_FAMILY.code).toBe('no_quick_family');
    expect(quick.chairman.model).toBe('claude-a'); // the defaults' chairman, left for Omid to set by hand
    // and so it cannot run as it is: the chairman is of the family of a member
    expect(chairmanFamilyClash(quick.seats, quick.chairman)).toBe(true);
    expect(quick.seats.filter((one) => one.enabled)).toHaveLength(2);
  });
});

describe('first-run default rosters', () => {
  it.each([
    { name: 'none', lists: [], count: 0, clash: false },
    { name: 'one model', lists: [item('claude', ['opus'])], count: 0, clash: false },
    {
      name: 'one company, two models',
      lists: [item('claude', ['opus', 'sonnet'])],
      count: 2,
      clash: true,
    },
    {
      name: 'one company, third chairman',
      lists: [item('claude', ['opus', 'sonnet', 'haiku'])],
      count: 2,
      clash: true,
    },
    {
      name: 'two companies, distinct member models',
      lists: [item('claude', ['opus', 'sonnet']), item('codex', ['gpt-a'])],
      count: 2,
      clash: false,
    },
    {
      name: 'two companies, no pair',
      lists: [item('claude', ['opus']), item('codex', ['gpt-a'])],
      count: 0,
      clash: false,
    },
    {
      name: 'three native companies',
      lists: [item('claude', ['opus']), item('codex', ['gpt-a']), item('grok', ['grok-a'])],
      count: 2,
      clash: false,
    },
    {
      name: 'Pi alone',
      lists: [item('pi', ['anthropic/opus', 'openai/gpt-a', 'google/gemini'])],
      count: 0,
      clash: false,
    },
    {
      name: 'two companies with one Pi member',
      lists: [item('claude', ['opus']), item('codex', ['gpt-a']), item('pi', ['anthropic/sonnet'])],
      count: 2,
      clash: false,
    },
    {
      name: 'one company with one Pi member',
      lists: [item('claude', ['opus']), item('pi', ['anthropic/sonnet'])],
      count: 2,
      clash: true,
    },
    {
      name: 'two Pi member seats stay out of scope',
      lists: [item('codex', ['gpt-a']), item('pi', ['anthropic/opus', 'anthropic/sonnet'])],
      count: 0,
      clash: false,
    },
    {
      name: 'unknown routers',
      lists: [item('pi', ['openai/custom-a', 'anthropic/custom-b'])],
      count: 0,
      clash: false,
    },
  ])('$name', ({ lists, count, clash }) => {
    const notes: Note[] = [];
    const defaults = computeDefaults(lists, undefined, notes);
    const members = defaults.seats.filter((seat) => seat.enabled);
    expect(members).toHaveLength(count);
    expect(new Set(defaults.seats.map((seat) => seat.id)).size).toBe(defaults.seats.length);
    expect(chairmanFamilyClash(members, defaults.chairman)).toBe(clash);
    if (count === 2 && lists.length === 1 && lists[0]?.models.length === 3)
      expect(defaults.chairman.model).toBe('haiku');
    expect(members.filter((seat) => seat.harness === 'pi').length).toBeLessThanOrEqual(
      lists.length === 1 ? 2 : 1,
    );
    if (members.some((seat) => seat.harness === 'pi'))
      expect(
        notes.some(
          (note) => note.code === 'pi_not_member' || note.code === 'pi_not_member_chairman',
        ),
      ).toBe(false);
    if (lists.length === 3 && !lists.some((item) => item.harness === 'pi'))
      expect(defaults.chairman.harness).toBe('claude');
  });
  it.each([
    ['openai/claude-opus', 'anthropic'],
    ['anthropic/gpt-a', 'openai'],
    ['litellm/google/gemini', 'google'],
    ['openai/custom', 'unknown'],
    ['router-a/custom', 'unknown'],
    ['router-b/custom', 'unknown'],
  ])('classifies %s by its own model name', (model, family) =>
    expect(modelFamily(model, 'pi')).toBe(family),
  );
  it('does not infer a company from an opaque native model id', () => {
    for (const harness of ['claude', 'codex', 'grok'])
      expect(modelFamily('custom-model', harness)).toBe('unknown');
  });
});

it.each([
  { ids: ['gpt-a', 'gpt-b', 'deepseek-pro'], members: ['gpt-a', 'gpt-b'], chair: 'deepseek-pro' },
  { ids: ['deepseek-pro', 'gpt-a', 'gpt-b'], members: ['gpt-a', 'gpt-b'], chair: 'deepseek-pro' },
  {
    ids: ['gpt-a', 'gpt-b', 'deepseek-pro', 'deepseek-flash'],
    members: ['deepseek-pro', 'deepseek-flash'],
    chair: 'gpt-a',
  },
  {
    ids: ['gpt-a', 'gpt-b', 'deepseek-pro', 'gemini-pro'],
    members: ['gpt-a', 'gpt-b'],
    chair: 'deepseek-pro',
  },
  { ids: ['gpt-a', 'deepseek-pro'], members: [], chair: 'gpt-a' },
  {
    ids: ['openai/gpt-a', 'litellm/gpt-a:high', 'deepseek-pro'],
    members: [],
    chair: 'openai/gpt-a',
  },
  { ids: ['custom-a', 'custom-b', 'divan/default'], members: [], chair: '' },
  { ids: ['gpt-a', 'gpt-b', 'gpt-c'], members: ['gpt-a', 'gpt-b'], chair: 'gpt-c' },
])('one Pi assistant: $ids', ({ ids, members, chair }) => {
  const notes: Note[] = [];
  const list = item('pi', ids);
  const manual = item('agy', ['gemini-a', 'gemini-b']);
  const defaults = computeDefaults([list, manual], undefined, notes);
  expect(defaults.seats.filter((seat) => seat.enabled).map((seat) => seat.model)).toEqual(members);
  expect(defaults.chairman.model).toBe(chair);
  expect(defaults.seats.some((seat) => seat.harness === 'agy')).toBe(false);
  if (members.length) {
    expect(defaults.seats.filter((seat) => seat.enabled).map((seat) => seat.id)).toEqual([
      'pi',
      'pi-2',
    ]);
    expect(notes.find((entry) => entry.code === 'one_assistant_council')?.params?.harness).toBe(
      'Pi',
    );
    const quick = quickProfile(
      defaults,
      [list, manual],
      new Map(),
      new Map([[chairmanKey('pi', chair, 'low'), 1]]),
    );
    expect(quick.chairman.harness).not.toBe('agy');
    expect(quick.seats.filter((seat) => seat.enabled).some((seat) => seat.harness === 'agy')).toBe(
      false,
    );
  }
  const retained = computeDefaults([], undefined, [], ['pi', 'pi-2']);
  expect(retained.seats.map((seat) => seat.id)).toEqual(['pi', 'pi-2']);
});

it('keeps a deliberate agy choice through unavailable or changed detection and retains Pi extra-seat level overrides', () => {
  const models = [item('pi', ['gpt-a', 'gpt-b', 'deepseek-pro'])];
  const defaults = computeDefaults(models);
  const manual = {
    ...defaults.seats[0],
    id: 'manual',
    harness: 'agy' as const,
    enabled: true,
    model: 'chosen-display',
    effort: '',
    tools: false,
    memory: false,
    web: false,
  };
  for (const lists of [[], [item('agy', ['different'])]]) {
    const detection = {
      defaults,
      models: lists,
      status: [{ id: 'agy' as const, installed: true, usable: false, note: null }],
      detectedAt: '',
    };
    const applied = applyOverrides(detection, {
      extraSeats: [manual],
      chairman: { harness: 'agy', model: 'chosen-chair', effort: '' },
    });
    expect(applied.effective.seats.find((seat) => seat.id === 'manual')).toEqual(manual);
    expect(applied.effective.chairman).toMatchObject({
      harness: 'agy',
      model: 'chosen-chair',
      effort: '',
    });
  }
  const reserved = computeDefaults(
    [item('pi', ['gpt-a', 'deepseek-pro'])],
    undefined,
    [],
    ['pi-2'],
  );
  expect(reserved.seats.find((seat) => seat.id === 'pi-2')?.enabled).toBe(false);
  const restored = computeDefaults(models, undefined, [], ['pi-2']);
  const resolved = resolveLevel(
    {
      defaults: restored,
      models,
      status: [{ id: 'pi', installed: true, usable: true, note: null }],
      detectedAt: '',
    },
    restored,
    'high',
    { seats: { 'pi-2': { effort: 'low' } } },
    new Map(),
  );
  expect(resolved.effective.seats.find((seat) => seat.id === 'pi-2')).toMatchObject({
    enabled: true,
    effort: 'low',
    model: 'gpt-b',
  });
});

it('retains a former second member as disabled so profile and level overrides still have their stable owner', () => {
  const defaults = computeDefaults(
    [item('claude', ['opus', 'sonnet']), item('codex', ['gpt-a']), item('grok', ['grok-a'])],
    undefined,
    [],
    ['claude-2'],
  );
  expect(defaults.seats.find((seat) => seat.id === 'claude-2')).toMatchObject({
    harness: 'claude',
    model: 'sonnet',
    enabled: false,
  });
});

it('cannot prove Quick separation with an unknown chairman or member company', () => {
  expect(
    chairmanFamilyClash([seat('claude', 'opus')], { harness: 'pi', model: 'router/custom' }),
  ).toBe(true);
  expect(
    chairmanFamilyClash([seat('pi', 'router/custom')], { harness: 'codex', model: 'gpt-a' }),
  ).toBe(true);
});

it.each([
  ['claude-sonnet-4-5', 'anthropic/claude-sonnet-4-5-20250929', true],
  ['gpt-4o', 'openai/gpt-4o-2024-08-06', true],
  ['opus', 'claude-opus-4-1', true],
  ['claude-opus-4.1:off', 'router/claude-opus-4-1:minimal', true],
  ['claude-opus-4-1', 'claude-sonnet-4-5', false],
])('routes, snapshots and effort aliases do not make a second member: %s, %s', (a, b, same) =>
  expect(sameModel(a, b)).toBe(same),
);

it('retains a missing original harness seat so its override can use a discovered target', () => {
  const models = [item('codex', ['gpt-a', 'gpt-c']), item('grok', ['grok-a'])];
  const defaults = computeDefaults(models, undefined, [], ['claude']);
  expect(defaults.seats.find((seat) => seat.id === 'claude')).toMatchObject({
    harness: 'claude',
    enabled: false,
  });
  const result = resolveLevel(
    {
      defaults,
      models,
      status: models.map((item) => ({
        id: item.harness,
        installed: true,
        usable: true,
        note: null,
      })),
      detectedAt: '',
    },
    defaults,
    'medium',
    { seats: { claude: { harness: 'codex', model: 'gpt-c', enabled: true } } },
    new Map(),
  );
  expect(result.effective.seats.find((seat) => seat.id === 'claude')).toMatchObject({
    harness: 'codex',
    model: 'gpt-c',
    enabled: true,
  });
  expect(result.notes.some((note) => note.code === 'seat_not_in_defaults')).toBe(false);
});
