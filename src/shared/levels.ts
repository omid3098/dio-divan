// Reasoning levels. Every Divan model (a profile) answers at one of four levels: low, medium, high, max. A level is a
// council: the profile's base council with the efforts the level calls for (`deriveLevel`, here), and whatever the profile
// overrides at that level (laid over it by the server's one resolver, `SettingsService`). Nothing else differs between levels.

import { isUnavailable, speedRank } from './defaults.ts';
import { agentsOf, flowCouncil } from './flow.ts';
import type {
  HarnessId,
  HarnessModels,
  LevelOverrides,
  ModelInfo,
  ReasoningLevel,
  SeatConfig,
  SettingsFull,
} from './types.ts';

export const REASONING_LEVELS: readonly ReasoningLevel[] = ['low', 'medium', 'high', 'max'];

/** The level a request that names none runs at, unless the profile says another. */
export const DEFAULT_LEVEL: ReasoningLevel = 'medium';

export const isLevel = (value: unknown): value is ReasoningLevel =>
  typeof value === 'string' && (REASONING_LEVELS as readonly string[]).includes(value);

/**
 * What a client's reasoning effort means here (OpenAI's `reasoning_effort`, and the values Pi's thinking selector sends):
 * off and minimal are low, low is low, medium is medium, high and xhigh are high, max is max. Anything else is no answer.
 */
export function levelOfEffort(raw: unknown): ReasoningLevel | undefined {
  if (typeof raw !== 'string') return undefined;
  switch (raw.trim().toLowerCase()) {
    case 'off':
    case 'none':
    case 'minimal':
    case 'low':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
    case 'xhigh':
      return 'high';
    case 'max':
      return 'max';
    default:
      return undefined;
  }
}

/**
 * What Pi's thinking selector sends for each of its levels, as the `thinkingLevelMap` of a Divan model: the same mapping as
 * `levelOfEffort`, written out (Pi puts the mapped value in `reasoning_effort`).
 */
export const PI_THINKING_LEVEL_MAP: Record<string, ReasoningLevel> = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'max',
};

/** The efforts in order, weakest first; one that is not in the table (a harness's own name for something) counts as medium. */
const EFFORT_RANK: Record<string, number> = {
  none: 0,
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};
const WANTED: Record<ReasoningLevel, number> = { low: 2, medium: 3, high: 4, max: 6 };

/**
 * The effort a model runs at for a level, from the efforts it offers: the one with that name when it has it, else the
 * nearest (the weaker first for low and medium, the stronger first for high); max is the model's highest. A model that
 * offers no efforts (the harness takes it from the model id, or has none) keeps what it has.
 */
export function effortForLevel(
  level: ReasoningLevel,
  info: Pick<ModelInfo, 'efforts'> | undefined,
  current: string,
): string {
  const offered = info?.efforts ?? [];
  if (offered.length === 0) return current;
  const rank = (effort: string) => EFFORT_RANK[effort] ?? 3;
  if (level === 'max') {
    return [...offered].sort((a, b) => rank(b) - rank(a))[0] ?? current;
  }
  const want = WANTED[level];
  // "off" and "none" are not a level of thinking to ask for: only when nothing else is offered
  const usable = offered.filter((effort) => rank(effort) > 0);
  const among = usable.length > 0 ? usable : offered;
  return (
    [...among].sort((a, b) => {
      const da = Math.abs(rank(a) - want);
      const db = Math.abs(rank(b) - want);
      if (da !== db) return da - db;
      // a tie between a weaker and a stronger effort: low and medium take the weaker, high the stronger
      return level === 'high' ? rank(b) - rank(a) : rank(a) - rank(b);
    })[0] ?? current
  );
}

export interface LevelContext {
  /** What each harness lists (with what is out of credit), to know which efforts a model offers and which seats can run. */
  models: HarnessModels[];
  /** The mean seconds a seat call took, per assistant and model (`speedKey`): the slowest member is the one dropped at low. */
  latency: ReadonlyMap<string, number>;
}

/** How many members the `low` level keeps at most. */
export const LOW_MEMBERS = 3;

const infoOf = (models: HarnessModels[], harness: HarnessId, id: string): ModelInfo | undefined =>
  models.find((item) => item.harness === harness)?.models.find((model) => model.id === id);

/**
 * The council a level derives from the base council, before any override of the profile:
 *   low    every effort low; the slowest member dropped when more than three would run; the chairman low;
 *   medium every effort medium;  high every effort high;
 *   max    every effort max, or the highest its model offers.
 * "Every effort" is the members' and the chairman's. Which members run is decided as everywhere else (a seat whose model is
 * out of credit does not count); a dropped member is only switched off, never removed.
 */
export function deriveLevel(
  base: SettingsFull,
  level: ReasoningLevel,
  context: LevelContext,
): SettingsFull {
  const { models, latency } = context;
  const out: SettingsFull = structuredClone(base);
  if (out.flow) {
    for (const agent of agentsOf(out.flow)) {
      agent.effort = effortForLevel(
        level,
        infoOf(models, agent.harness, agent.model),
        agent.effort,
      );
    }
    return { ...out, ...flowCouncil(out.flow) };
  }
  for (const seat of out.seats) {
    seat.effort = effortForLevel(level, infoOf(models, seat.harness, seat.model), seat.effort);
  }
  out.chairman.effort = effortForLevel(
    level,
    infoOf(models, out.chairman.harness, out.chairman.model),
    out.chairman.effort,
  );
  if (level === 'low') {
    const running = out.seats.filter((seat) => {
      const item = models.find((entry) => entry.harness === seat.harness);
      return seat.enabled && !(item && isUnavailable(item, seat.model));
    });
    if (running.length > LOW_MEMBERS) {
      const slowest = [...running].sort((a, b) => {
        const [ga, ta] = speedRank(a, latency);
        const [gb, tb] = speedRank(b, latency);
        return gb - ga || tb - ta;
      })[0] as SeatConfig;
      slowest.enabled = false;
    }
  }
  return out;
}

/**
 * What differs between a council and the one its level derives: the overrides that turn `derived` into `edited`. The edit of
 * a level in the web app is saved as this. Seats are by id; a seat that is not in `derived` is ignored (a level cannot add one).
 */
export function diffLevel(derived: SettingsFull, edited: SettingsFull): LevelOverrides {
  const out: LevelOverrides = {};
  if (derived.flow && edited.flow) {
    const nodes: NonNullable<LevelOverrides['nodes']> = {};
    for (const agent of agentsOf(edited.flow)) {
      const base = agentsOf(derived.flow).find((item) => item.id === agent.id);
      if (!base) continue;
      const patch: NonNullable<LevelOverrides['nodes']>[string] = {};
      for (const field of ['enabled', 'harness', 'model', 'effort'] as const) {
        if (
          (field === 'enabled' ? agent.enabled !== false : agent[field]) !==
          (field === 'enabled' ? base.enabled !== false : base[field])
        )
          Object.assign(patch, {
            [field]: field === 'enabled' ? agent.enabled !== false : agent[field],
          });
      }
      if (Object.keys(patch).length) nodes[agent.id] = patch;
    }
    if (Object.keys(nodes).length) out.nodes = nodes;
    return out;
  }
  const known = new Map(derived.seats.map((seat) => [seat.id, seat]));
  const seats: NonNullable<LevelOverrides['seats']> = {};
  for (const seat of edited.seats) {
    const base = known.get(seat.id);
    if (!base) continue;
    const changed: Record<string, unknown> = {};
    for (const field of ['enabled', 'harness', 'model', 'effort'] as const) {
      if (seat[field] !== base[field]) changed[field] = seat[field];
    }
    if (Object.keys(changed).length > 0) seats[seat.id] = changed;
  }
  if (Object.keys(seats).length > 0) out.seats = seats;
  const chairman: Record<string, unknown> = {};
  for (const field of ['harness', 'model', 'effort'] as const) {
    if (edited.chairman[field] !== derived.chairman[field])
      chairman[field] = edited.chairman[field];
  }
  if ((edited.chairman.memory ?? false) !== (derived.chairman.memory ?? false)) {
    chairman.memory = edited.chairman.memory ?? false;
  }
  if ((edited.chairman.tools ?? true) !== (derived.chairman.tools ?? true)) {
    chairman.tools = edited.chairman.tools ?? true;
  }
  if (Object.keys(chairman).length > 0) out.chairman = chairman;
  return out;
}

export const hasLevelOverrides = (overrides: LevelOverrides | undefined): boolean =>
  Object.keys(overrides?.nodes ?? {}).length > 0 ||
  Object.keys(overrides?.seats ?? {}).length > 0 ||
  Object.keys(overrides?.chairman ?? {}).length > 0;
