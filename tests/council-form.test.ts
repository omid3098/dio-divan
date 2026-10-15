// The council form: what counts as a change. A level that holds a stored override that carries a consequence the user never wrote
// (a model-only override of a seat makes the level pick that model's effort) is not changed until the user changes something,
// Discard brings it back to exactly that, and a save keeps the stored overrides of what was not touched.

import { describe, expect, it } from 'vitest';
import { type Detection, resolveLevel } from '../src/server/settings.ts';
import { type Flow, flowCouncil } from '../src/shared/flow.ts';
import { diffLevel } from '../src/shared/levels.ts';
import type {
  HarnessModels,
  LevelOverrides,
  LevelView,
  ReasoningLevel,
  SeatConfig,
  SettingsFull,
} from '../src/shared/types.ts';
import { agentOf, removeNode, setPlaces } from '../web/src/pages/councils/design/edit.ts';
import { levelChanged, levelOverridesOf, saveBody } from '../web/src/pages/councils/form-diff.ts';
import { writerFlow } from './fixtures/flows.ts';

const model = (id: string, efforts: string[]) => ({
  id,
  label: id,
  efforts,
  defaultEffort: efforts.at(-1) ?? '',
});
const claude: HarnessModels = {
  harness: 'claude',
  models: [model('m1', ['low', 'medium', 'high', 'max']), model('m2', ['low', 'medium'])],
  listed: true,
  defaultModel: 'm1',
  note: null,
  fallbackEfforts: [],
  fetchedAt: '',
};
const codex: HarnessModels = {
  ...claude,
  harness: 'codex',
  models: [model('c1', ['low', 'medium', 'high', 'max'])],
  defaultModel: 'c1',
};
const seat = (id: string, harness: SeatConfig['harness'], modelId: string): SeatConfig => ({
  id,
  enabled: true,
  harness,
  model: modelId,
  effort: 'high',
  tools: harness === 'codex',
  memory: false,
  web: false,
});
const base: SettingsFull = {
  seats: [seat('claude', 'claude', 'm1'), seat('codex', 'codex', 'c1')],
  chairman: { harness: 'pi', model: 'p1', effort: 'high' },
  budgets: { maxClaims: 5, maxWords: 30 },
};
const detection: Detection = {
  status: [
    { id: 'claude', installed: true, usable: true, note: null },
    { id: 'codex', installed: true, usable: true, note: null },
    { id: 'pi', installed: true, usable: true, note: null },
  ],
  models: [claude, codex, { ...claude, harness: 'pi', models: [model('p1', ['low', 'high'])] }],
  defaults: base,
  detectedAt: '',
};

/** A level as the server resolves it for stored overrides: the council it runs and the one it derives. */
function levelView(stored: LevelOverrides): LevelView {
  const resolved = resolveLevel(detection, base, 'high', stored, new Map());
  return {
    effective: resolved.effective,
    derived: resolved.derived,
    overrides: stored,
    fingerprint: 'fp',
    skipped: [],
    notes: [],
  };
}

describe('a stored model-only override', () => {
  const stored: LevelOverrides = { seats: { claude: { model: 'm2' } } };
  const view = levelView(stored);

  it('really carries a consequence: the level picked the new model’s effort', () => {
    const resolved = view.effective.seats.find((item) => item.id === 'claude');
    expect(resolved?.model).toBe('m2');
    expect(resolved?.effort).not.toBe('high'); // m2 has no "high"
    // the diff against what the level derives is therefore not what was stored
    const diff = diffLevel(view.derived, view.effective);
    expect(diff.seats?.claude).toHaveProperty('effort');
  });

  it('is not a change: the untouched form equals the level as the profile has it', () => {
    expect(levelChanged(view, view.effective)).toBe(false);
    // and the overrides it holds are the stored ones, not a bigger diff
    expect(levelOverridesOf(view, view.effective)).toEqual(stored);
  });

  it('Discard has something to clear only when the user changed something', () => {
    const edited: SettingsFull = {
      ...view.effective,
      seats: view.effective.seats.map((item) =>
        item.id === 'codex' ? { ...item, effort: 'low' } : item,
      ),
    };
    expect(levelChanged(view, edited)).toBe(true);
    // back to the profile's own council: not a change any more
    expect(levelChanged(view, view.effective)).toBe(false);
  });

  it('a change to another member keeps this one’s stored override exactly', () => {
    const edited: SettingsFull = {
      ...view.effective,
      seats: view.effective.seats.map((item) =>
        item.id === 'codex' ? { ...item, effort: 'low' } : item,
      ),
    };
    expect(levelOverridesOf(view, edited)).toEqual({
      seats: { claude: { model: 'm2' }, codex: { effort: 'low' } },
    });
  });

  it('a save of an untouched form sends the stored overrides of every level as they are', () => {
    const levels = Object.fromEntries(
      (['low', 'medium', 'high', 'max'] as const).map((level) => [
        level,
        level === 'high' ? view : { ...levelView({}), overrides: {} },
      ]),
    ) as Parameters<typeof saveBody>[1]['levels'];
    const body = saveBody(
      {
        base,
        levels: Object.fromEntries(
          Object.entries(levels).map(([level, one]) => [level, one.effective]),
        ) as Parameters<typeof saveBody>[0]['levels'],
        defaultLevel: 'medium',
      },
      { revision: 3, fingerprint: 'fp', defaults: base, levels },
    );
    expect(body.levels).toEqual({ high: stored });
    expect(body.ifRevision).toBe(3);
  });
});

// ---------- what the council form saves for a design ----------

const flowModel = (id: string, efforts: string[]) => ({
  id,
  label: id,
  efforts,
  defaultEffort: efforts.at(-1) ?? '',
});
const flowPi: HarnessModels = {
  harness: 'pi',
  models: [
    flowModel('fake-1', ['low', 'medium', 'high', 'max']),
    flowModel('fake-2', ['low', 'medium']),
  ],
  listed: true,
  defaultModel: 'fake-1',
  note: null,
  fallbackEfforts: [],
  fetchedAt: '',
};
const flowBase: SettingsFull = {
  flow: writerFlow(),
  ...flowCouncil(writerFlow()),
  budgets: { maxClaims: 5, maxWords: 30 },
};
const flowDetection: Detection = {
  status: [{ id: 'pi', installed: true, usable: true, note: null }],
  models: [flowPi],
  defaults: flowBase,
  detectedAt: '',
};
function flowLevelView(level: ReasoningLevel, stored: LevelOverrides): LevelView {
  const resolved = resolveLevel(flowDetection, flowBase, level, stored, new Map());
  return {
    effective: resolved.effective,
    derived: resolved.derived,
    overrides: stored,
    fingerprint: 'fp',
    skipped: [],
    notes: [],
  };
}
const flowBaselineOf = (stored: Partial<Record<ReasoningLevel, LevelOverrides>> = {}) => {
  const levels = Object.fromEntries(
    (['low', 'medium', 'high', 'max'] as const).map((level) => [
      level,
      flowLevelView(level, stored[level] ?? {}),
    ]),
  ) as Record<ReasoningLevel, LevelView>;
  return { revision: 4, fingerprint: 'fp', defaults: flowBase, base: flowBase, levels };
};
const flowFormOf = (baseline: ReturnType<typeof flowBaselineOf>) => ({
  base: baseline.base,
  levels: Object.fromEntries(
    Object.entries(baseline.levels).map(([level, view]) => [level, view.effective]),
  ) as Record<ReasoningLevel, SettingsFull>,
  defaultLevel: 'medium' as const,
});

describe('what the form saves for a design', () => {
  it('an untouched form saves the design with the revision and fingerprint it saw, and the stored level overrides as they are', () => {
    const stored = { high: { nodes: { writer: { model: 'fake-2' } } } };
    const baseline = flowBaselineOf(stored);
    const body = saveBody(flowFormOf(baseline), baseline);
    expect(body).toMatchObject({ ifRevision: 4, ifFingerprint: 'fp', defaultLevel: 'medium' });
    expect(body).not.toHaveProperty('overrides');
    expect((body as { flow: Flow }).flow).toEqual(flowBase.flow);
    expect(body.levels).toEqual(stored);
  });

  it('a move of a box is an unsaved change, and is sent with the design', () => {
    const baseline = flowBaselineOf();
    const form = flowFormOf(baseline);
    const moved = {
      ...form,
      base: { ...form.base, flow: setPlaces(form.base.flow as Flow, { writer: { x: 40, y: 80 } }) },
    };
    const body = saveBody(moved, baseline) as { flow: Flow };
    expect(agentOf(body.flow, 'writer')?.position).toEqual({ x: 40, y: 80 });
  });

  it('a level is a change of one agent: only that agent’s override is written, the others keep theirs', () => {
    const stored = { high: { nodes: { writer: { model: 'fake-2' } } } };
    const baseline = flowBaselineOf(stored);
    const view = baseline.levels.high;
    expect(levelChanged(view, view.effective)).toBe(false);
    expect(levelOverridesOf(view, view.effective)).toEqual(stored.high);
    const edited: SettingsFull = {
      ...view.effective,
      flow: {
        ...(view.effective.flow as Flow),
        nodes: (view.effective.flow as Flow).nodes.map((node) =>
          node.id === 'critic3' ? { ...(node as object), enabled: false } : node,
        ) as Flow['nodes'],
      },
    };
    expect(levelChanged(view, edited)).toBe(true);
    expect(levelOverridesOf(view, edited)).toEqual({
      nodes: { writer: { model: 'fake-2' }, critic3: { enabled: false } },
    });
    const form = {
      ...flowFormOf(baseline),
      levels: { ...flowFormOf(baseline).levels, high: edited },
    };
    expect((saveBody(form, baseline).levels.high as LevelOverrides).nodes?.critic3).toEqual({
      enabled: false,
    });
  });

  it('overrides for an agent that is gone, or whose assistant changed, are not sent on', () => {
    const stored = { low: { nodes: { critic3: { enabled: false }, writer: { model: 'fake-2' } } } };
    const baseline = flowBaselineOf(stored);
    const form = flowFormOf(baseline);
    const removed = {
      ...form,
      base: { ...form.base, flow: removeNode(form.base.flow as Flow, 'critic3') },
    };
    expect(saveBody(removed, baseline).levels.low).toEqual({
      nodes: { writer: { model: 'fake-2' } },
    });
    const other = {
      ...form,
      base: {
        ...form.base,
        flow: {
          ...(form.base.flow as Flow),
          nodes: (form.base.flow as Flow).nodes.map((node) =>
            node.id === 'writer' ? { ...(node as object), harness: 'codex' } : node,
          ) as Flow['nodes'],
        },
      },
    };
    expect(saveBody(other, baseline).levels.low).toEqual({
      nodes: { critic3: { enabled: false } },
    });
  });
});
