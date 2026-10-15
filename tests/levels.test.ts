// The reasoning levels: what a client's effort means, the efforts a level asks of a model, and the council a level derives
// from a profile's base council (the pure part; the profile views and the endpoint are tested through the server).

import { describe, expect, it } from 'vitest';
import { eligibleFlow } from '../src/server/eligibility.ts';
import { resolveLevel } from '../src/server/settings.ts';
import { speedKey } from '../src/shared/defaults.ts';
import { agentsOf } from '../src/shared/flow.ts';
import {
  DEFAULT_LEVEL,
  deriveLevel,
  diffLevel,
  effortForLevel,
  hasLevelOverrides,
  isLevel,
  LOW_MEMBERS,
  levelOfEffort,
  PI_THINKING_LEVEL_MAP,
  REASONING_LEVELS,
} from '../src/shared/levels.ts';
import type {
  HarnessId,
  HarnessModels,
  ReasoningLevel,
  SeatConfig,
  SettingsFull,
} from '../src/shared/types.ts';
import { writerFlow } from './fixtures/flows.ts';

const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];

const listing = (
  harness: HarnessId,
  models: { id: string; efforts?: string[] }[],
  out: string[] = [],
): HarnessModels => ({
  harness,
  models: models.map((model) => ({
    id: model.id,
    label: model.id,
    efforts: model.efforts ?? efforts,
    defaultEffort: 'medium',
  })),
  listed: true,
  defaultModel: models[0]?.id ?? '',
  unavailable: out.map((id) => ({
    id,
    until: new Date(Date.now() + 3_600_000).toISOString(),
    reason: 'x',
  })),
  note: null,
  fallbackEfforts: [],
  fetchedAt: '',
});

const seat = (harness: HarnessId, model: string, effort = 'xhigh', enabled = true): SeatConfig => ({
  id: harness,
  enabled,
  harness,
  model,
  effort,
  tools: false,
  memory: false,
  web: false,
});

const base = (): SettingsFull => ({
  seats: [
    seat('claude', 'claude-opus-5'),
    seat('codex', 'gpt-6-sol'),
    seat('grok', 'grok-5'),
    seat('pi', 'deepseek-flash'),
  ],
  chairman: { harness: 'claude', model: 'claude-opus-5', effort: 'high' },
  budgets: { maxClaims: 5, maxWords: 30 },
});

const models = (out: Record<string, string[]> = {}): HarnessModels[] => [
  listing('claude', [{ id: 'claude-opus-5' }], out.claude),
  listing('codex', [{ id: 'gpt-6-sol' }], out.codex),
  listing('grok', [{ id: 'grok-5' }], out.grok),
  listing('pi', [{ id: 'deepseek-flash', efforts: ['low', 'high'] }], out.pi),
];

/** The measured seconds of the base council's seat of each assistant (kept per assistant AND model). */
const latency = (seconds: Partial<Record<HarnessId, number>>) =>
  new Map(
    base().seats.flatMap((one): [string, number][] => {
      const value = seconds[one.harness];
      return value === undefined ? [] : [[speedKey(one.harness, one.model), value]];
    }),
  );

describe('custom flow levels', () => {
  it('blocks unavailable prerequisites and insufficient responses, and keeps only independent agents apart from the final family', () => {
    const graph = writerFlow();
    const names = {
      writer: 'claude-opus',
      rewriter: 'claude-opus',
      critic1: 'gpt-sol',
      critic2: 'grok',
      critic3: 'deepseek',
    };
    for (const agent of agentsOf(graph)) agent.model = names[agent.id as keyof typeof names];
    const out = (ids: string[]) =>
      ids.map((id) => ({
        harness: 'pi' as const,
        model: names[id as keyof typeof names],
        until: new Date(Date.now() + 60000).toISOString(),
        reason: 'rate',
      }));
    expect(eligibleFlow(graph, [], Date.now(), true).run.map((agent) => agent.id)).toContain(
      'writer',
    );
    for (const [ids, blocked] of [
      [['critic1'], false],
      [['critic1', 'critic2'], true],
      [['writer'], true],
    ] as const)
      expect(eligibleFlow(graph, out([...ids])).blocked).toBe(blocked);
    const critic = agentsOf(graph).find((agent) => agent.id === 'critic1');
    if (!critic) throw new Error('Missing critic');
    critic.model = names.writer;
    const plan = eligibleFlow(graph, [], Date.now(), true);
    expect(plan.sameFamily.map((agent) => agent.id)).toEqual(['critic1']);
    expect(plan.run.map((agent) => agent.id)).toContain('writer');
    expect(plan.blocked).toBe(false);
  });
  it('derives every agent without low pruning, and applies only node-id overrides through the resolver', () => {
    const flow = writerFlow();
    const council = { ...base(), flow };
    const detection = {
      defaults: council,
      detectedAt: '',
      status: [],
      models: [listing('pi', [{ id: 'fake-1' }, { id: 'fake-2', efforts: ['low', 'high'] }])],
    };
    const resolved = resolveLevel(
      detection,
      council,
      'low',
      {
        nodes: {
          writer: { model: 'fake-2' },
          critic2: { enabled: false },
          rewriter: { effort: 'high' },
        },
      },
      new Map(),
    );
    expect(agentsOf(resolved.derived.flow as typeof flow)).toHaveLength(5);
    expect(
      agentsOf(resolved.derived.flow as typeof flow).every(
        (agent) => agent.effort === 'low' && agent.enabled !== false,
      ),
    ).toBe(true);
    expect(
      agentsOf(resolved.effective.flow as typeof flow).find((agent) => agent.id === 'writer'),
    ).toMatchObject({ model: 'fake-2', effort: 'low' });
    expect(
      agentsOf(resolved.effective.flow as typeof flow).find((agent) => agent.id === 'rewriter'),
    ).toMatchObject({ model: 'fake-1', effort: 'high' });
    expect(diffLevel(resolved.derived, resolved.effective)).toEqual({
      nodes: {
        writer: { model: 'fake-2' },
        critic2: { enabled: false },
        rewriter: { effort: 'high' },
      },
    });
    expect(hasLevelOverrides({ nodes: { writer: { model: 'fake-2' } } })).toBe(true);
    expect(flow).toEqual(writerFlow());
  });
});

describe('what a client’s effort means', () => {
  it('off, none, minimal and low are low; medium is medium; high and xhigh are high; max is max', () => {
    const expected: Record<string, ReasoningLevel> = {
      off: 'low',
      none: 'low',
      minimal: 'low',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'high',
      max: 'max',
    };
    for (const [effort, level] of Object.entries(expected)) {
      expect(levelOfEffort(effort), effort).toBe(level);
      expect(levelOfEffort(` ${effort.toUpperCase()} `), effort).toBe(level);
    }
  });

  it('anything else is no answer, so the profile’s own level applies', () => {
    for (const value of ['', 'ultra', 'banana', 3, null, undefined, {}, ['high']]) {
      expect(levelOfEffort(value), String(value)).toBeUndefined();
    }
  });

  it('Pi’s thinking-level map is the same mapping, level by level', () => {
    for (const [pi, level] of Object.entries(PI_THINKING_LEVEL_MAP)) {
      expect(levelOfEffort(pi), pi).toBe(level);
    }
    expect(Object.keys(PI_THINKING_LEVEL_MAP).sort()).toEqual(
      ['high', 'low', 'max', 'medium', 'minimal', 'off', 'xhigh'].sort(),
    );
  });

  it('the levels, their order and their default', () => {
    expect(REASONING_LEVELS).toEqual(['low', 'medium', 'high', 'max']);
    expect(DEFAULT_LEVEL).toBe('medium');
    expect(REASONING_LEVELS.every(isLevel)).toBe(true);
    expect(isLevel('xhigh')).toBe(false);
  });
});

describe('the effort a model runs at for a level', () => {
  const of = (level: ReasoningLevel, offered: string[], current = 'medium') =>
    effortForLevel(level, { efforts: offered }, current);

  it('is the effort of that name when the model has it; max is the model’s highest', () => {
    expect(of('low', efforts)).toBe('low');
    expect(of('medium', efforts)).toBe('medium');
    expect(of('high', efforts)).toBe('high');
    expect(of('max', efforts)).toBe('max');
    expect(of('max', ['low', 'medium', 'high'])).toBe('high');
    expect(of('max', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh');
  });

  it('is the nearest effort otherwise: the weaker for low and medium, the stronger for high', () => {
    expect(of('medium', ['low', 'high'])).toBe('low');
    expect(of('high', ['low', 'medium'])).toBe('medium');
    expect(of('high', ['medium', 'xhigh'])).toBe('xhigh');
    expect(of('low', ['medium', 'high'])).toBe('medium');
  });

  it('does not ask for "off" or "none" while anything else is offered', () => {
    expect(of('low', ['none', 'low', 'high'])).toBe('low');
    expect(of('low', ['none', 'medium'])).toBe('medium');
    expect(of('low', ['none'])).toBe('none');
  });

  it('keeps what a model has when it offers no efforts (the harness takes them from the id)', () => {
    expect(of('max', [], 'kept')).toBe('kept');
    expect(effortForLevel('high', undefined, '')).toBe('');
  });
});

describe('the council a level derives from the base council', () => {
  const derive = (level: ReasoningLevel, latencies = latency({}), listed = models()) =>
    deriveLevel(base(), level, { models: listed, latency: latencies });

  it('medium, high and max put every effort, the chairman’s too, at that level, keeping all the members', () => {
    for (const level of ['medium', 'high', 'max'] as const) {
      const out = derive(level);
      expect(out.seats.filter((item) => item.enabled)).toHaveLength(4);
      expect(out.chairman.effort).toBe(level);
      // the Pi model offers only low and high: medium is the weaker, max is its highest
      const expected = {
        medium: ['medium', 'medium', 'medium', 'low'],
        high: ['high', 'high', 'high', 'high'],
        max: ['max', 'max', 'max', 'high'],
      }[level];
      expect(out.seats.map((item) => item.effort)).toEqual(expected);
    }
  });

  it('does not change anything else in the base council, and does not change the base', () => {
    const before = base();
    const out = deriveLevel(before, 'max', { models: models(), latency: latency({}) });
    expect(before).toEqual(base());
    expect(out.budgets).toEqual(before.budgets);
    expect(out.seats.map((item) => [item.id, item.harness, item.model, item.enabled])).toEqual(
      before.seats.map((item) => [item.id, item.harness, item.model, item.enabled]),
    );
  });

  it('low drops the slowest member when more than three would run', () => {
    expect(LOW_MEMBERS).toBe(3);
    const out = derive('low', latency({ claude: 10, codex: 40, grok: 20, pi: 5 }));
    expect(out.seats.find((item) => item.id === 'codex')?.enabled).toBe(false);
    expect(out.seats.filter((item) => item.enabled)).toHaveLength(3);
    expect(out.seats).toHaveLength(4); // switched off, never removed
    expect(out.chairman.effort).toBe('low');
    expect(out.seats.every((item) => item.effort === 'low')).toBe(true);
  });

  it('low drops no one when three or fewer would run: a seat that is off or out of credit does not count', () => {
    const off = deriveLevel(
      {
        ...base(),
        seats: base().seats.map((item) =>
          item.id === 'grok' ? { ...item, enabled: false } : item,
        ),
      },
      'low',
      { models: models(), latency: latency({ codex: 40 }) },
    );
    expect(off.seats.filter((item) => item.enabled)).toHaveLength(3);
    const out = derive('low', latency({ codex: 40 }), models({ grok: ['grok-5'] }));
    expect(out.seats.filter((item) => item.enabled)).toHaveLength(4); // the seat that cannot run is not dropped by this
    expect(out.seats.find((item) => item.id === 'codex')?.enabled).toBe(true);
  });

  it('with nothing measured, the family order decides which member is the slowest', () => {
    const out = derive('low');
    expect(out.seats.filter((item) => item.enabled)).toHaveLength(3);
  });

  it('only low changes who runs', () => {
    for (const level of ['medium', 'high', 'max'] as const) {
      const out = derive(level, latency({ codex: 40, claude: 1, grok: 2, pi: 3 }));
      expect(out.seats.every((item) => item.enabled)).toBe(true);
    }
  });
});

describe('the edit of a level as a difference from what it derives', () => {
  const derived = (): SettingsFull =>
    deriveLevel(base(), 'high', { models: models(), latency: latency({}) });

  it('no change is no override', () => {
    expect(diffLevel(derived(), derived())).toEqual({});
    expect(hasLevelOverrides({})).toBe(false);
  });

  it('keeps only the seats, the chairman and the fields that differ', () => {
    const edited = derived();
    (edited.seats.find((item) => item.id === 'pi') as SeatConfig).enabled = false;
    (edited.seats.find((item) => item.id === 'grok') as SeatConfig).model = 'grok-5-fast';
    edited.chairman.effort = 'low';
    edited.chairman.memory = true;
    edited.chairman.tools = false;
    const overrides = diffLevel(derived(), edited);
    expect(overrides).toEqual({
      seats: { pi: { enabled: false }, grok: { model: 'grok-5-fast' } },
      chairman: { effort: 'low', memory: true, tools: false },
    });
    expect(hasLevelOverrides(overrides)).toBe(true);
  });

  it('a seat the level does not derive is ignored: a level cannot add one', () => {
    const edited = derived();
    edited.seats.push({ ...seat('pi', 'x'), id: 'extra' });
    expect(diffLevel(derived(), edited)).toEqual({});
  });

  it('memory that was off and is still off is no difference', () => {
    const edited = derived();
    edited.chairman.memory = false;
    edited.chairman.tools = true;
    expect(diffLevel(derived(), edited)).toEqual({});
  });
});
