// What the council form changed, as the page decides it (pure, so a test can pin it). The form is compared with the profile as the
// page last took it, council against council: a level's form is "changed" only when it differs from the level's RESOLVED
// council (`LevelView.effective`), never from what its stored overrides would derive, because a stored override can carry
// consequences the user never wrote (a model-only override of a seat makes the level pick that model's effort, so the diff
// against the derived council would show an effort override nobody asked for, and Discard could not clear it).

import { agentsOf, type Flow } from '../../../../src/shared/flow.ts';
import { diffLevel, hasLevelOverrides, REASONING_LEVELS } from '../../../../src/shared/levels.ts';
import { diffSettings } from '../../../../src/shared/settings.ts';
import type {
  LevelOverrides,
  LevelView,
  ReasoningLevel,
  SettingsFull,
} from '../../../../src/shared/types.ts';
import { councilFlow, overridesForDesign } from './design/council.ts';

/** A value written with its keys in order, so two equal objects compare equal as text. */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canon(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
export const same = (a: unknown, b: unknown): boolean => canon(a) === canon(b);

/** The same for a flow design: per agent (`nodes`), an agent the user did not touch keeps exactly the overrides it had. */
function nodeOverridesOf(baseline: LevelView, form: SettingsFull): LevelOverrides {
  const diff = diffLevel(baseline.derived, form);
  const stored = baseline.overrides.nodes ?? {};
  const nodes: NonNullable<LevelOverrides['nodes']> = {};
  const before = agentsOf(
    baseline.effective.flow ?? { version: 1, kind: 'custom', nodes: [], edges: [] },
  );
  for (const agent of agentsOf(form.flow ?? { version: 1, kind: 'custom', nodes: [], edges: [] })) {
    const was = before.find((item) => item.id === agent.id);
    const patch = was && same(was, agent) ? stored[agent.id] : diff.nodes?.[agent.id];
    if (patch && Object.keys(patch).length > 0) nodes[agent.id] = patch;
  }
  return Object.keys(nodes).length > 0 ? { nodes } : {};
}

/** What a level of the form holds in the overrides that are saved: the user's changes are diffed, the rest is kept as stored. */
export function levelOverridesOf(baseline: LevelView, form: SettingsFull): LevelOverrides {
  if (baseline.effective.flow && form.flow) return nodeOverridesOf(baseline, form);
  const diff = diffLevel(baseline.derived, form);
  const stored = baseline.overrides;
  const out: LevelOverrides = {};
  const seats: NonNullable<LevelOverrides['seats']> = {};
  for (const seat of form.seats) {
    const was = baseline.effective.seats.find((item) => item.id === seat.id);
    // a member the user did not touch keeps exactly the overrides it had
    const patch = was && same(was, seat) ? stored.seats?.[seat.id] : diff.seats?.[seat.id];
    if (patch && Object.keys(patch).length > 0) seats[seat.id] = patch;
  }
  if (Object.keys(seats).length > 0) out.seats = seats;
  const chairman = same(baseline.effective.chairman, form.chairman)
    ? stored.chairman
    : diff.chairman;
  if (chairman && Object.keys(chairman).length > 0) out.chairman = chairman;
  return out;
}

/** Whether the level's form differs from the level as the profile has it. */
export const levelChanged = (baseline: LevelView, form: SettingsFull): boolean =>
  !same(form, baseline.effective);

/** What the baseline of a form is made of (a part of the profile as the page last took it). */
export interface BaselineLike {
  revision: number;
  fingerprint: string;
  defaults: SettingsFull;
  levels: Record<ReasoningLevel, LevelView>;
  /** The base council as the page last took it (a flow design is compared with it to drop overrides that no longer fit). */
  base?: SettingsFull;
}

/**
 * The overrides a level keeps once the design has changed under them: only for agents that are still there, and not for an agent
 * whose assistant was changed (a model of another assistant would run on the wrong one).
 */
function fitting(
  overrides: LevelOverrides,
  wanted: SettingsFull,
  before: SettingsFull | undefined,
): LevelOverrides {
  if (!wanted.flow || !overrides.nodes) return overrides;
  const now = agentsOf(wanted.flow);
  const was = agentsOf(before?.flow ?? wanted.flow);
  const nodes: NonNullable<LevelOverrides['nodes']> = {};
  for (const [id, patch] of Object.entries(overrides.nodes)) {
    const agent = now.find((item) => item.id === id);
    if (!agent || was.find((item) => item.id === id)?.harness !== agent.harness) continue;
    nodes[id] = patch;
  }
  return Object.keys(nodes).length > 0 ? { nodes } : {};
}

/** The body of a save: the base council's overrides, every level's overrides (the untouched ones as stored), the default level. */
export function saveBody(
  wanted: {
    base: SettingsFull;
    levels: Record<ReasoningLevel, SettingsFull>;
    defaultLevel: ReasoningLevel;
  },
  base: BaselineLike,
) {
  const levels: Partial<Record<ReasoningLevel, LevelOverrides>> = {};
  // a council that became a design on this page: its saved level overrides (by seat) are carried over to the design's agents,
  // and a level cannot have been edited meanwhile (a level is read-only while the base has unsaved changes)
  const converted = wanted.base.flow !== undefined && base.base !== undefined && !base.base.flow;
  const before = converted
    ? { ...(base.base as SettingsFull), flow: councilFlow(base.base as SettingsFull) }
    : base.base;
  for (const level of REASONING_LEVELS) {
    const overrides = converted
      ? fitting(
          overridesForDesign(base.levels[level].overrides, wanted.base.flow as Flow),
          wanted.base,
          before,
        )
      : levelChanged(base.levels[level], wanted.levels[level])
        ? levelOverridesOf(base.levels[level], wanted.levels[level])
        : fitting(base.levels[level].overrides, wanted.base, before);
    if (hasLevelOverrides(overrides)) levels[level] = overrides;
  }
  const guard = { ifRevision: base.revision, ifFingerprint: base.fingerprint };
  // a flow design is saved as the design (its council overrides play no part)
  if (wanted.base.flow)
    return { flow: wanted.base.flow, levels, defaultLevel: wanted.defaultLevel, ...guard };
  return {
    overrides: diffSettings(base.defaults, wanted.base),
    levels,
    defaultLevel: wanted.defaultLevel,
    ...guard,
  };
}
