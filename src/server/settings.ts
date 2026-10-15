// Settings: what this PC has (detected), what Omid changed (overrides, stored apart) and the two laid together
// (effective). A profile is a named set of them: `default` (the detected defaults) and `quick` (the defaults reduced to
// the quickest seats) always exist, and custom ones are made by creating or duplicating. A new session starts from a
// profile's effective settings; a session's own copy is locked once it starts. `divan/<id>` names a profile as a model.

import { createHash } from 'node:crypto';
import {
  chairmanFamilyClash,
  computeDefaults,
  DEFAULT_BUDGETS,
  DEFAULT_PORT,
  HARNESS_LABEL,
  HARNESS_ORDER,
  isUnavailable,
  pickEffort,
  pickModel,
  QUICK_BLOCKED,
  quickProfile,
  speedKey,
  usableCandidates,
} from '../shared/defaults.ts';
import {
  agentsOf,
  canonicalFlow,
  type Flow,
  finalAgent,
  flowCouncil,
  validateFlow,
} from '../shared/flow.ts';
import {
  HARNESS_RULES,
  normalizeToggles,
  TOGGLE_KEYS,
  toggleProblem,
} from '../shared/harness-rules.ts';
import {
  DEFAULT_LEVEL,
  deriveLevel,
  effortForLevel,
  isLevel,
  REASONING_LEVELS,
} from '../shared/levels.ts';
import {
  compileForm,
  emptyLibrary,
  type FormEntry,
  type Library,
  type LibraryView,
  type PromptEntry,
  validateEntry,
  validatePrompt,
} from '../shared/library.ts';
import { type Note, note } from '../shared/messages.ts';
import type {
  Budgets,
  HarnessId,
  HarnessModels,
  HarnessStatus,
  JsonSchema,
  LevelOverrides,
  LevelView,
  ProfileBase,
  ProfileRecord,
  ProfileView,
  ReasoningLevel,
  SeatConfig,
  SettingsFile,
  SettingsFull,
  SettingsOverrides,
  SettingsView,
} from '../shared/types.ts';
import { DetectionError, detect, type Found } from './detection.ts';

export { detect } from './detection.ts';

import { eligibleFlow } from './eligibility.ts';
import { EngineError } from './engine.ts';
import { executableFlow, FLOW_TEMPLATES, flowTemplate } from './flow-templates.ts';
import { libraryView, referencesOf, resolveFlow, storedFlow } from './library.ts';
import type { Store } from './store.ts';

export interface Detection {
  status: HarnessStatus[];
  models: HarnessModels[];
  defaults: SettingsFull;
  detectedAt: string;
}

// ---------- overrides over defaults ----------

const NUMBER_FIELDS: (keyof Budgets)[] = ['maxClaims', 'maxWords'];

/** Checks one seat against this PC. A field that no longer fits falls back to `fallback`'s, with a note. */
function fitSeat(
  seat: SeatConfig,
  fallback: SeatConfig | null,
  detection: Detection,
  notes: Note[],
): SeatConfig | null {
  const usable = (id: HarnessId) =>
    detection.status.find((item) => item.id === id)?.usable === true;
  const listFor = (id: HarnessId) => detection.models.find((item) => item.harness === id);
  const label = seat.id;
  let next = { ...seat };
  // A deliberate manual-only choice survives discovery failures and catalogue changes.
  if (HARNESS_RULES[next.harness].manualOnly) return normalizeToggles(next.harness, next);
  if (!usable(next.harness)) {
    if (!fallback) {
      notes.push(note('seat_harness_gone_dropped', { seat: label }));
      return null;
    }
    notes.push(note('seat_harness_gone', { seat: label }));
    return { ...fallback, enabled: seat.enabled && fallback.enabled };
  }
  const list = listFor(next.harness);
  if (list?.listed && next.model && !list.models.some((model) => model.id === next.model)) {
    const model =
      fallback &&
      fallback.harness === next.harness &&
      list.models.some((m) => m.id === fallback.model)
        ? list.models.find((m) => m.id === fallback.model)
        : pickModel(list.models, list.defaultModel);
    notes.push(note('seat_model_gone', { seat: label }));
    next = { ...next, model: model?.id ?? '', effort: pickEffort(model) };
  }
  const held = normalizeToggles(next.harness, next);
  for (const key of TOGGLE_KEYS) {
    if (held[key] !== next[key]) {
      notes.push(
        note(held[key] ? 'seat_toggle_on' : 'seat_toggle_off', { seat: label, toggle: key }),
      );
    }
  }
  next = held;
  const info = list?.models.find((model) => model.id === next.model);
  if (info && next.effort !== '' && !info.efforts.includes(next.effort)) {
    notes.push(note('seat_effort_gone', { seat: label }));
    next.effort = pickEffort(info);
  }
  return next;
}

/**
 * A council with overrides on top, from any base council (the detected defaults, the quick profile, or a level's derived
 * council); an override that no longer fits this PC is dropped with a note.
 */
function layer(
  detection: Detection,
  base: SettingsFull,
  overrides: SettingsOverrides,
): { effective: SettingsFull; notes: Note[] } {
  const notes: Note[] = [];
  const seats: SeatConfig[] = [];
  for (const seatBase of base.seats) {
    const patch = overrides.seats?.[seatBase.id];
    const merged: SeatConfig = { ...seatBase, ...(patch ?? {}), id: seatBase.id };
    const seat = patch ? fitSeat(merged, seatBase, detection, notes) : merged;
    if (seat) seats.push(seat);
  }
  for (const extra of overrides.extraSeats ?? []) {
    if (seats.some((seat) => seat.id === extra.id)) continue;
    const seat = fitSeat(extra, null, detection, notes);
    if (seat) seats.push(seat);
  }
  for (const id of Object.keys(overrides.seats ?? {})) {
    if (!base.seats.some((seat) => seat.id === id)) {
      notes.push(note('seat_not_in_defaults', { seat: id }));
    }
  }
  const chairman = fitChairman(detection, base.chairman, overrides.chairman, notes);
  const budgets: Budgets = { ...base.budgets };
  for (const field of NUMBER_FIELDS) {
    const value = overrides.budgets?.[field];
    if (typeof value === 'number' && Number.isFinite(value)) budgets[field] = value;
  }
  return { effective: { seats, chairman, budgets }, notes };
}

/** The chairman with a patch on top, checked against this PC like a seat. */
function fitChairman(
  detection: Detection,
  base: SettingsFull['chairman'],
  patch: Partial<SettingsFull['chairman']> | undefined,
  notes: Note[],
): SettingsFull['chairman'] {
  let chairman = { ...base, ...(patch ?? {}) };
  if (patch) {
    const probe = fitSeat(
      {
        id: 'chairman',
        enabled: true,
        ...chairman,
        tools: chairman.tools ?? true,
        memory: false,
        web: false,
      },
      {
        id: 'chairman',
        enabled: true,
        ...base,
        tools: base.tools ?? true,
        memory: false,
        web: false,
      },
      detection,
      notes,
    );
    if (probe)
      chairman = {
        ...chairman,
        harness: probe.harness,
        model: probe.model,
        effort: probe.effort,
        tools: probe.tools,
      };
  }
  const ready =
    detection.models.find((item) => item.harness === chairman.harness)?.memoryReady === true;
  const requested =
    patch?.memory ?? (chairman.harness === base.harness ? base.memory : undefined) ?? ready;
  const { tools, memory } = normalizeToggles(chairman.harness, {
    tools: chairman.tools ?? true,
    memory: requested,
    web: false,
  });
  const { memory: _was, ...rest } = chairman;
  return { ...rest, tools, memory };
}

/** The defaults with the overrides on top; an override that no longer fits this PC is dropped with a note. */
export function applyOverrides(
  detection: Detection,
  overrides: SettingsOverrides,
): { effective: SettingsFull; notes: Note[] } {
  return layer(detection, detection.defaults, overrides);
}

/**
 * The council of one level: the base council derived for the level (`deriveLevel`), with the profile's overrides at that
 * level laid over it. This is the ONE resolver of (profile, level): every consumer (the view, a session start, the endpoint,
 * the cache identity) takes its council from here.
 */
export function resolveLevel(
  detection: Detection,
  base: SettingsFull,
  level: ReasoningLevel,
  overrides: LevelOverrides | undefined,
  latency: ReadonlyMap<string, number>,
  library?: Library,
  schemas?: Map<string, JsonSchema>,
): { derived: SettingsFull; effective: SettingsFull; notes: Note[] } {
  const derived = deriveLevel(base, level, { models: detection.models, latency });
  const notes: Note[] = [];
  const infoOf = (harness: HarnessId, id: string) =>
    detection.models.find((item) => item.harness === harness)?.models.find((m) => m.id === id);
  if (derived.flow) {
    const effective = structuredClone(derived);
    for (const agent of agentsOf(effective.flow as Flow)) {
      const patch = overrides?.nodes?.[agent.id];
      if (!patch) continue;
      Object.assign(agent, patch);
      if (patch.effort === undefined && (patch.model !== undefined || patch.harness !== undefined))
        agent.effort = effortForLevel(level, infoOf(agent.harness, agent.model), agent.effort);
    }
    if (library) {
      derived.flow = resolveFlow(derived.flow as Flow, library, DEFAULT_BUDGETS, false, schemas);
      effective.flow = resolveFlow(
        effective.flow as Flow,
        library,
        DEFAULT_BUDGETS,
        false,
        schemas,
      );
    }
    return { derived, effective: { ...effective, ...flowCouncil(effective.flow as Flow) }, notes };
  }
  const seats = derived.seats.map((seat): SeatConfig => {
    const patch = overrides?.seats?.[seat.id];
    if (!patch) return seat;
    const merged: SeatConfig = { ...seat, ...patch, id: seat.id };
    // another model, no effort given: the effort is the level's for that model
    if (patch.effort === undefined && (patch.model !== undefined || patch.harness !== undefined)) {
      merged.effort = effortForLevel(level, infoOf(merged.harness, merged.model), seat.effort);
    }
    return fitSeat(merged, seat, detection, notes) ?? seat;
  });
  const chairmanPatch = overrides?.chairman;
  let chairman = fitChairman(detection, derived.chairman, chairmanPatch, notes);
  if (chairmanPatch && chairmanPatch.effort === undefined && chairmanPatch.model !== undefined) {
    chairman = {
      ...chairman,
      effort: effortForLevel(
        level,
        infoOf(chairman.harness, chairman.model),
        derived.chairman.effort,
      ),
    };
  }
  return { derived, effective: { seats, chairman, budgets: derived.budgets }, notes };
}

/** Keeps only the shapes and fields an overrides file may hold. */
export function sanitizeOverrides(input: unknown): SettingsOverrides {
  const out: SettingsOverrides = {};
  if (!input || typeof input !== 'object') return out;
  const source = input as Record<string, unknown>;
  const text = (value: unknown, max = 120) =>
    typeof value === 'string' && value.length <= max ? value : undefined;
  const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
  const harness = (value: unknown): HarnessId | undefined =>
    HARNESS_ORDER.find((id) => id === value);
  const seatPatch = (value: unknown): Record<string, unknown> => {
    const patch: Record<string, unknown> = {};
    if (!value || typeof value !== 'object') return patch;
    const raw = value as Record<string, unknown>;
    const fields: [string, unknown][] = [
      ['enabled', flag(raw.enabled)],
      ['harness', harness(raw.harness)],
      ['model', text(raw.model)],
      ['effort', text(raw.effort, 24)],
      ['tools', flag(raw.tools)],
      ['memory', flag(raw.memory)],
      ['web', flag(raw.web)],
    ];
    for (const [key, field] of fields) if (field !== undefined) patch[key] = field;
    return patch;
  };
  if (source.seats && typeof source.seats === 'object') {
    const seats: Record<string, Partial<Omit<SeatConfig, 'id'>>> = {};
    for (const [id, patch] of Object.entries(source.seats as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]{1,16}$/u.test(id)) continue;
      const clean = seatPatch(patch);
      if (Object.keys(clean).length > 0) seats[id] = clean as Partial<Omit<SeatConfig, 'id'>>;
    }
    if (Object.keys(seats).length > 0) out.seats = seats;
  }
  if (Array.isArray(source.extraSeats)) {
    const extra: SeatConfig[] = [];
    for (const raw of source.extraSeats.slice(0, 8)) {
      const id = text((raw as { id?: unknown })?.id, 16);
      const patch = seatPatch(raw) as Partial<SeatConfig>;
      if (id && /^[A-Za-z0-9_-]+$/u.test(id) && patch.harness) {
        extra.push({
          id,
          enabled: patch.enabled ?? true,
          harness: patch.harness,
          model: patch.model ?? '',
          effort: patch.effort ?? '',
          tools: patch.tools ?? false,
          memory: patch.memory ?? false,
          web: patch.web ?? false,
        });
      }
    }
    if (extra.length > 0) out.extraSeats = extra;
  }
  if (source.chairman && typeof source.chairman === 'object') {
    const raw = source.chairman as Record<string, unknown>;
    const chairman: Record<string, unknown> = {};
    if (harness(raw.harness)) chairman.harness = raw.harness;
    if (text(raw.model) !== undefined) chairman.model = raw.model;
    if (text(raw.effort, 24) !== undefined) chairman.effort = raw.effort;
    if (flag(raw.tools) !== undefined) chairman.tools = raw.tools;
    if (flag(raw.memory) !== undefined) chairman.memory = raw.memory;
    if (Object.keys(chairman).length > 0) out.chairman = chairman;
  }
  if (source.budgets && typeof source.budgets === 'object') {
    const raw = source.budgets as Record<string, unknown>;
    const budgets: Partial<Budgets> = {};
    for (const field of NUMBER_FIELDS) {
      const value = raw[field];
      if (typeof value === 'number' && Number.isFinite(value)) budgets[field] = value;
    }
    if (Object.keys(budgets).length > 0) out.budgets = budgets;
  }
  return out;
}

/** The overrides of one level: seats (enabled, harness, model, effort) and the chairman, nothing else. */
export function sanitizeLevelOverrides(input: unknown): LevelOverrides {
  const out: LevelOverrides = {};
  if (!input || typeof input !== 'object') return out;
  const rawNodes = (input as { nodes?: unknown }).nodes;
  if (rawNodes !== undefined) {
    if (!rawNodes || typeof rawNodes !== 'object' || Array.isArray(rawNodes))
      throw new EngineError('bad_levels');
    const nodes: NonNullable<LevelOverrides['nodes']> = {};
    for (const [id, raw] of Object.entries(rawNodes)) {
      if (
        !/^[A-Za-z0-9_-]{1,32}$/u.test(id) ||
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw)
      )
        throw new EngineError('bad_levels');
      const patch = raw as Record<string, unknown>;
      if (
        Object.keys(patch).some(
          (key) => !['enabled', 'harness', 'model', 'effort'].includes(key),
        ) ||
        (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') ||
        (patch.harness !== undefined && !HARNESS_ORDER.includes(patch.harness as HarnessId)) ||
        (patch.model !== undefined &&
          (typeof patch.model !== 'string' || !/^[A-Za-z0-9._:/@+-]{1,120}$/u.test(patch.model))) ||
        (patch.effort !== undefined &&
          (typeof patch.effort !== 'string' || !/^[A-Za-z0-9._-]{0,24}$/u.test(patch.effort)))
      )
        throw new EngineError('bad_levels');
      nodes[id] = structuredClone(patch);
    }
    if (Object.keys(nodes).length) out.nodes = nodes;
  }
  const clean = sanitizeOverrides({
    seats: (input as { seats?: unknown }).seats,
    chairman: (input as { chairman?: unknown }).chairman,
  });
  if (clean.seats) {
    const seats: NonNullable<LevelOverrides['seats']> = {};
    for (const [id, patch] of Object.entries(clean.seats)) {
      const kept: Record<string, unknown> = {};
      for (const field of ['enabled', 'harness', 'model', 'effort'] as const) {
        if (patch[field] !== undefined) kept[field] = patch[field];
      }
      if (Object.keys(kept).length > 0) seats[id] = kept;
    }
    if (Object.keys(seats).length > 0) out.seats = seats;
  }
  if (clean.chairman) out.chairman = clean.chairman;
  return out;
}

/** The per-level overrides a request holds: unknown levels are refused, a level with nothing to override is left out. */
export function sanitizeLevels(input: unknown): NonNullable<ProfileRecord['levels']> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new EngineError('bad_levels');
  }
  const out: NonNullable<ProfileRecord['levels']> = {};
  for (const [level, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!isLevel(level)) throw new EngineError('bad_levels');
    const clean = sanitizeLevelOverrides(raw);
    if (Object.keys(clean).length > 0) out[level] = clean;
  }
  return out;
}

// ---------- profiles ----------

export const AUTO_PROFILE_NAMES: Record<ProfileBase, string> = {
  default: 'Default',
  quick: 'Quick',
};

/** A malformed graph is a client error, including malformed objects that fail before graph traversal. */
function checkedFlow(
  input: unknown,
  library: Library = emptyLibrary(),
  schemas?: Map<string, JsonSchema>,
): Flow {
  try {
    const flow = resolveFlow(input as Flow, library, DEFAULT_BUDGETS, false, schemas);
    validateFlow(flow);
    if (flow.kind !== 'custom') throw new Error('custom profile flow required');
    for (const agent of agentsOf(flow)) {
      const problem = toggleProblem(agent.harness, agent);
      if (problem) throw EngineError.of(problem);
    }
    return flow;
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError('bad_flow', 400, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
/** What the editor keeps beside the executable graph (names and places): not part of a cache key, but it is saved. */
const looksOf = (flow: Flow): string =>
  JSON.stringify(
    [...flow.nodes]
      .sort((a, b) => a.id.localeCompare(b.id, 'en'))
      .map((node) => [node.id, 'label' in node ? node.label : undefined, node.position]),
  );
const isAuto = (id: string): id is ProfileBase => id === 'default' || id === 'quick';
const MAX_PROFILES = 30;

/** Persian letters as Latin ones, so a Persian profile name makes a readable id («تحلیل سریع» -> "tahlil-sari"). */
const TRANSLITERATION: Record<string, string> = {
  آ: 'a',
  ا: 'a',
  أ: 'a',
  إ: 'e',
  ب: 'b',
  پ: 'p',
  ت: 't',
  ث: 's',
  ج: 'j',
  چ: 'ch',
  ح: 'h',
  خ: 'kh',
  د: 'd',
  ذ: 'z',
  ر: 'r',
  ز: 'z',
  ژ: 'zh',
  س: 's',
  ش: 'sh',
  ص: 's',
  ض: 'z',
  ط: 't',
  ظ: 'z',
  ع: 'a',
  غ: 'gh',
  ف: 'f',
  ق: 'gh',
  ک: 'k',
  ك: 'k',
  گ: 'g',
  ل: 'l',
  م: 'm',
  ن: 'n',
  و: 'v',
  ه: 'h',
  ة: 'h',
  ی: 'y',
  ي: 'y',
  ئ: 'y',
  ؤ: 'v',
  ء: '',
  '‌': '-',
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
};
const transliterate = (text: string): string =>
  [...text].map((char) => TRANSLITERATION[char] ?? char).join('');

/** A stable id for a profile: lower case letters, digits and hyphens; a name with no letters at all falls back to "profile". */
export function slugify(name: string): string {
  const slug = transliterate(name)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32)
    .replace(/-+$/u, '');
  return slug || 'profile';
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** The profile moved on since the writer saw it. */
class Stale extends Error {}

/** A short digest of what is in force for a profile, so a save made against outdated defaults (a model that ran out) is refused. */
const fingerprint = (
  defaults: SettingsFull,
  effective: SettingsFull,
  levels: Record<ReasoningLevel, SettingsFull>,
  defaultLevel: ReasoningLevel,
  /** The fingerprint of each level: what a start checks, so a profile's own fingerprint covers every one of them. */
  started: Record<ReasoningLevel, string>,
): string =>
  createHash('sha256')
    .update(JSON.stringify({ defaults, effective, levels, defaultLevel, started }))
    .digest('hex')
    .slice(0, 16);

/**
 * A short digest of the council a level RUNS: what a start at that level is checked against. It covers everything a round
 * does with the council: the level, every member that is on (assistant, model, effort, tools, memory, web), the chairman
 * (assistant, model, effort, tools, memory), the limits, and which of the members that are on will really be asked now (a model that
 * ran out of credit changes the council without changing a setting). A member that is off is only "off": what it would run
 * on changes nothing, so it moves nothing here.
 */
const levelFingerprint = (
  level: ReasoningLevel,
  council: SettingsFull,
  skipped: LevelView['skipped'],
): string =>
  createHash('sha256')
    .update(
      JSON.stringify({
        level,
        seats: council.seats.map((seat) => (seat.enabled ? seat : { id: seat.id, enabled: false })),
        chairman: council.chairman,
        budgets: council.budgets,
        flow: canonicalFlow(executableFlow(council)),
        skipped,
      }),
    )
    .digest('hex')
    .slice(0, 16);

const cleanLevel = (value: unknown): ReasoningLevel => {
  if (!isLevel(value)) throw new EngineError('bad_level');
  return value;
};

const cleanRevision = (value: unknown): number => {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new EngineError('bad_op');
  }
  return value as number;
};

/** A profile id the caller gave: a plain string of lower case Latin letters, digits and hyphens. */
const cleanId = (value: unknown): string => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!ID_PATTERN.test(text)) {
    throw new EngineError('bad_id');
  }
  return text;
};

const cleanName = (name: unknown): string => {
  const text = typeof name === 'string' ? name.replace(/\s+/gu, ' ').trim() : '';
  if (!text || text.length > 40) {
    throw new EngineError('bad_name');
  }
  return text;
};

export class SettingsService {
  private store: Store;
  private found: Found | null = null;

  constructor(store: Store) {
    this.store = store;
  }

  private singleSettings(view: SettingsView, base: SettingsFull): SettingsFull {
    const candidates = usableCandidates(
      view.models.filter(
        (item) => view.status.find((status) => status.id === item.harness)?.usable,
      ),
    );
    if (!candidates.length) throw new EngineError('no_assistant', 409);
    return { ...base, seats: candidates };
  }

  async view(refresh = false): Promise<SettingsView> {
    if (!this.found || refresh) {
      try {
        this.found = await detect(refresh);
      } catch (error) {
        if (error instanceof DetectionError) throw EngineError.of(note('detection_failed'), 502);
        throw error;
      }
    }
    return this.build(this.store.readSettings());
  }

  /**
   * The profiles as they are for a settings file: its overrides laid over what this PC has (detected earlier) and what is
   * out of credit now. Synchronous, so a write can check what a writer saw against it inside the serialized settings update.
   */
  private build(file: SettingsFile): SettingsView {
    if (!this.found) throw new Error('detect first');
    const schemas = new Map<string, JsonSchema>();
    const now = Date.now();
    // Models that recently ran out of credit (or are rate limited) are marked, and the defaults pass them over.
    const unavailable = this.store.readUnavailable();
    const models: HarnessModels[] = this.found.models.map((item) => ({
      ...item,
      unavailable: unavailable
        .filter((entry) => entry.harness === item.harness && new Date(entry.until).getTime() > now)
        .map((entry) => ({
          id: entry.model,
          until: entry.until,
          reason: entry.reason,
          ...(entry.prefix !== undefined ? { prefix: entry.prefix } : {}),
        })),
    }));
    const usable = new Set(this.found.status.filter((item) => item.usable).map((item) => item.id));
    const notes: Note[] = [];
    if (this.store.settingsBackup)
      notes.push(note('settings_corrupt', { file: this.store.settingsBackup }));
    const quickNotes: Note[] = [];
    const defaults = computeDefaults(
      models.filter((item) => usable.has(item.harness)),
      DEFAULT_BUDGETS,
      notes,
      [
        ...new Set(
          Object.values(file.profiles).flatMap((record) => [
            ...Object.keys(record.overrides?.seats ?? {}),
            ...Object.values(record.levels ?? {}).flatMap((level) =>
              Object.keys(level.seats ?? {}),
            ),
          ]),
        ),
      ],
    );
    const bases: Record<ProfileBase, SettingsFull> = {
      default: defaults,
      quick: quickProfile(
        defaults,
        models.filter((item) => usable.has(item.harness)),
        this.store.measuredLatency(),
        this.store.measuredChairmanLatency(),
        quickNotes,
      ),
    };
    const ids = ['default', 'quick', ...Object.keys(file.profiles).filter((id) => !isAuto(id))];
    const latency = this.store.measuredLatency();
    const isOut = (seat: SeatConfig): boolean => {
      const item = models.find((entry) => entry.harness === seat.harness);
      return item ? isUnavailable(item, seat.model, now) : false;
    };
    const profiles = ids.map((id): ProfileView => {
      const record = file.profiles[id];
      const base: ProfileBase = record?.base ?? (isAuto(id) ? id : 'default');
      const detection: Detection = {
        status: this.found?.status ?? [],
        models,
        defaults: bases[base],
        detectedAt: this.found?.detectedAt ?? '',
      };
      const overrides = record?.overrides ?? {};
      const applied = applyOverrides(detection, overrides);
      let invalid: Note | undefined;
      if (record?.flow) {
        try {
          const flow = checkedFlow(record.flow, file.library ?? emptyLibrary(), schemas);
          applied.effective = { ...applied.effective, flow, ...flowCouncil(flow) };
        } catch (error) {
          invalid = note('flow_invalid', {
            reason:
              error instanceof EngineError
                ? (error.params?.reason ?? error.message)
                : String(error),
          });
        }
      }
      // the council of every level, from the base council by the one resolver
      const defaultLevel = record?.defaultLevel ?? (base === 'quick' ? 'low' : DEFAULT_LEVEL);
      const levels = {} as Record<ReasoningLevel, LevelView>;
      for (const level of REASONING_LEVELS) {
        const stored = record?.levels?.[level];
        let levelInvalid = invalid;
        let resolved: ReturnType<typeof resolveLevel>;
        try {
          resolved = resolveLevel(
            detection,
            applied.effective,
            level,
            stored,
            latency,
            file.library ?? emptyLibrary(),
            schemas,
          );
          if (resolved.effective.flow)
            for (const agent of agentsOf(resolved.effective.flow)) {
              const problem = toggleProblem(agent.harness, agent);
              if (problem) throw EngineError.of(problem);
            }
        } catch (error) {
          levelInvalid = note('flow_invalid', {
            reason:
              error instanceof EngineError
                ? (error.params?.reason ?? error.message)
                : String(error),
          });
          resolved = { derived: applied.effective, effective: applied.effective, notes: [] };
        }
        const flow = resolved.effective.flow;
        const running = flow
          ? agentsOf(flow).filter(
              (agent) =>
                ['member', 'critic'].includes(agent.role) &&
                agent.enabled !== false &&
                !isOut({ ...agent, enabled: true }),
            )
          : resolved.effective.seats.filter((seat) => seat.enabled && !isOut(seat));
        // the members that are on and will not be asked now: the same function the round and the cache use
        const short = !flow && resolved.effective.seats.filter((seat) => seat.enabled).length < 2;
        const plan = short
          ? { skipped: [], sameFamily: [], blocked: true, missing: [] }
          : eligibleFlow(
              executableFlow(resolved.effective),
              unavailable,
              now,
              base === 'quick',
              detection.status,
            );
        const candidates = usableCandidates(models.filter((item) => usable.has(item.harness)));
        const noCandidate = candidates.length === 0;
        const candidateCount = new Set(candidates.map((seat) => seat.model)).size;
        const readiness =
          noCandidate && short
            ? note('no_assistant')
            : short
              ? (notes.find((item) => item.code === 'one_assistant_pair_missing') ??
                note(candidateCount === 1 ? 'council_shortage_one' : 'council_shortage', {
                  count: candidateCount,
                  required: 2,
                }))
              : plan.blocked
                ? note('flow_unavailable')
                : undefined;
        const skipped: LevelView['skipped'] = [
          ...plan.skipped.map(({ seat }) => ({ id: seat.id, reason: 'out' as const })),
          ...plan.sameFamily.map((seat) => ({ id: seat.id, reason: 'family' as const })),
          ...plan.missing.map((agent) => ({ id: agent.id, reason: 'missing' as const })),
        ];
        levels[level] = {
          effective: resolved.effective,
          derived: resolved.derived,
          overrides: stored ?? {},
          skipped,
          fingerprint: levelFingerprint(level, resolved.effective, skipped),
          ...(readiness ? { blocked: readiness } : {}),
          ...(base === 'quick' &&
          chairmanFamilyClash(
            running.map((agent) => ({ ...agent, enabled: true })),
            flow ? finalAgent(flow) : resolved.effective.chairman,
          )
            ? { blocked: QUICK_BLOCKED }
            : {}),
          ...(levelInvalid ? { blocked: levelInvalid } : {}),
          notes: [
            ...resolved.notes,
            ...((flow
              ? agentsOf(flow).filter((agent) => agent.enabled !== false)
              : [
                  ...resolved.effective.seats.filter((seat) => seat.enabled),
                  resolved.effective.chairman,
                ]
            ).some((agent) => agent.harness === 'agy')
              ? [note('agy_warning')]
              : []),
            ...((flow
              ? agentsOf(flow)
              : [...resolved.effective.seats, resolved.effective.chairman]
            ).some((agent) => agent.harness === 'hermes')
              ? [note('hermes_tools_note'), note('hermes_usage')]
              : []),
          ],
        };
      }

      return {
        id,
        name: isAuto(id) ? AUTO_PROFILE_NAMES[id] : (record?.name ?? id),
        auto: isAuto(id),
        base,
        revision: record?.revision ?? 1,
        generation: record?.generation ?? 0,
        fingerprint: fingerprint(
          bases[base],
          applied.effective,
          Object.fromEntries(
            REASONING_LEVELS.map((level) => [level, levels[level].effective]),
          ) as Record<ReasoningLevel, SettingsFull>,
          defaultLevel,
          Object.fromEntries(
            REASONING_LEVELS.map((level) => [level, levels[level].fingerprint]),
          ) as Record<ReasoningLevel, string>,
        ),
        // `quick` keeps the chairman's family apart from the members': without that a level of it does not run
        ...(levels[defaultLevel].blocked ? { blocked: levels[defaultLevel].blocked } : {}),
        defaults: bases[base],
        effective: applied.effective,
        overrides,
        defaultLevel,
        levels,
        notes: base === 'quick' ? [...quickNotes, ...applied.notes] : applied.notes,
      };
    });
    for (const entry of unavailable) {
      // all models of a harness, the models of a provider ("litellm/zai"), or one model
      const harness = HARNESS_LABEL[entry.harness];
      const until = entry.until;
      if (entry.prefix === '') notes.push(note('unavailable_harness', { harness, until }));
      else if (entry.prefix !== undefined) {
        const provider = entry.prefix.replace(/\/$/u, '');
        notes.push(note('unavailable_provider', { provider, harness, until }));
      } else notes.push(note('unavailable_model', { model: entry.model, harness, until }));
    }
    const speeds: SettingsView['speeds'] = {};
    for (const seat of defaults.seats) {
      const seconds = latency.get(speedKey(seat.harness, seat.model));
      if (seconds !== undefined) speeds[seat.harness] = seconds;
    }
    return {
      profiles,
      notes,
      status: this.found.status,
      models,
      detectedAt: this.found.detectedAt,
      speeds,
    };
  }

  /** The profile a request names (the endpoint's `divan/<id>`), or undefined. */
  async profile(id: string): Promise<ProfileView | undefined> {
    return (await this.view()).profiles.find((item) => item.id === id);
  }

  /** The profile's record, made on first use for the two automatic ones; an unknown custom id is an error. */
  private record(file: SettingsFile, id: string): ProfileRecord {
    let record = file.profiles[id];
    if (!record) {
      if (!isAuto(id)) throw new EngineError('no_profile', 404);
      record = { base: id, revision: 1, overrides: {} };
      file.profiles[id] = record;
    }
    return record;
  }

  /**
   * One change to a profile: its id (its name on the endpoint, `divan/<id>`), its name or its overrides (the whole set, as
   * the form holds it). Every field that is given is checked first, and then all of them are applied together in ONE write: a
   * request that is refused changes nothing, and one that is accepted raises the revision once. `ifRevision` is what the
   * writer saw; `ifFingerprint` is the settings it saw in force (the defaults and the effective settings, which also move
   * when a model runs out of credit): if either is outdated the write is refused with 409 and the current profile.
   */
  async update(
    id: string,
    patch: {
      id?: unknown;
      name?: unknown;
      overrides?: unknown;
      flow?: unknown;
      /** The per-level overrides as a whole (levels not in it have none); each is cleaned like the base overrides. */
      levels?: unknown;
      /** The level a request that names none runs at. */
      defaultLevel?: unknown;
      ifRevision?: unknown;
      ifFingerprint?: unknown;
    },
  ): Promise<{ id: string; view: SettingsView }> {
    const nextId = patch.id === undefined ? id : cleanId(patch.id);
    const renamed = patch.name === undefined ? undefined : cleanName(patch.name);
    const overrides =
      patch.overrides === undefined ? undefined : sanitizeOverrides(patch.overrides);
    const levels = patch.levels === undefined ? undefined : sanitizeLevels(patch.levels);
    const defaultLevel =
      patch.defaultLevel === undefined ? undefined : cleanLevel(patch.defaultLevel);
    const ifRevision = patch.ifRevision === undefined ? undefined : cleanRevision(patch.ifRevision);
    let flow =
      patch.flow === undefined ? undefined : patch.flow === null ? null : (patch.flow as Flow);
    await this.view(); // what this PC has is known before the serialized update, which cannot wait for it
    try {
      await this.store.updateSettings((file) => {
        const record = this.record(file, id);
        if (ifRevision !== undefined && record.revision !== ifRevision) throw new Stale();
        // the settings in force are compared inside the same serialized update as the revision, against this very file
        if (
          patch.ifFingerprint !== undefined &&
          this.build(file).profiles.find((item) => item.id === id)?.fingerprint !==
            patch.ifFingerprint
        ) {
          throw new Stale();
        }
        if (nextId !== id) {
          if (isAuto(id)) {
            throw new EngineError('auto_profile');
          }
          if (isAuto(nextId) || file.profiles[nextId]) {
            throw new EngineError('id_taken', 409);
          }
        }
        if (flow) flow = checkedFlow(flow, file.library ?? emptyLibrary());
        let changed = nextId !== id;
        if (
          flow !== undefined &&
          (flow === null
            ? record.flow !== undefined
            : JSON.stringify(storedFlow(flow)) !==
                (record.flow ? JSON.stringify(record.flow) : '') ||
              looksOf(flow) !== (record.flow ? looksOf(record.flow as Flow) : ''))
        ) {
          if (flow) record.flow = storedFlow(flow);
          else delete record.flow;
          changed = true;
        }
        if (
          overrides !== undefined &&
          JSON.stringify(overrides) !== JSON.stringify(record.overrides)
        ) {
          record.overrides = overrides;
          changed = true;
        }
        if (
          levels !== undefined &&
          JSON.stringify(levels) !== JSON.stringify(record.levels ?? {})
        ) {
          if (Object.keys(levels).length > 0) record.levels = levels;
          else delete record.levels;
          changed = true;
        }
        if (defaultLevel !== undefined && defaultLevel !== record.defaultLevel) {
          record.defaultLevel = defaultLevel;
          changed = true;
        }
        if (renamed !== undefined && !isAuto(id) && renamed !== record.name) {
          record.name = renamed;
          changed = true;
        }
        const candidate = this.build(file).profiles.find((item) => item.id === id) as ProfileView;
        for (const level of REASONING_LEVELS) {
          const resolved = candidate.levels[level].effective.flow;
          if (
            resolved &&
            (Object.keys(record.levels?.[level]?.seats ?? {}).length ||
              Object.keys(record.levels?.[level]?.chairman ?? {}).length)
          )
            throw new EngineError('bad_levels');
          const patches = record.levels?.[level]?.nodes;
          if (
            patches &&
            Object.keys(patches).some(
              (nodeId) => !resolved || !agentsOf(resolved).some((agent) => agent.id === nodeId),
            )
          )
            throw new EngineError('bad_levels');
          if (candidate.levels[level].blocked?.code === 'flow_invalid')
            throw EngineError.of(candidate.levels[level].blocked as Note);
        }
        if (changed) record.revision += 1;
        if (nextId !== id) {
          file.profiles[nextId] = record;
          delete file.profiles[id];
        }
        return file;
      });
    } catch (error) {
      if (error instanceof Stale) throw await this.stale(await this.view(), id);
      throw error;
    }
    return { id: nextId, view: await this.view() };
  }

  /** The 409 of a write made against a profile that has moved on: it carries the profile as it is now, and the whole list. */
  private stale(view: SettingsView, id: string): EngineError {
    return new EngineError('stale', 409, undefined, {
      profile: view.profiles.find((item) => item.id === id),
      view,
    });
  }

  /**
   * The profile a session may start from: the one the caller saw, by its revision AND the fingerprint of the settings that
   * were in force (a model that went out of credit changes what runs without changing the revision). Both are compared with
   * the very snapshot returned, which is what the session is built from. A profile that has moved on in either way is
   * refused with 409 (the current profile and list ride with it), an unknown one with 404.
   */
  async at(
    id: string,
    revision: unknown,
    fingerprint: unknown,
    level?: ReasoningLevel,
  ): Promise<ProfileView> {
    const wanted = cleanRevision(revision);
    if (typeof fingerprint !== 'string' || fingerprint === '') {
      throw new EngineError('bad_op');
    }
    const view = await this.view();
    const profile = view.profiles.find((item) => item.id === id);
    if (!profile) throw new EngineError('no_profile', 404);
    // what matters to a start is its level's council: the profile's own fingerprint (every level) is accepted too, as it always was
    const current =
      profile.fingerprint === fingerprint ||
      profile.levels[level ?? profile.defaultLevel].fingerprint === fingerprint;
    if (profile.revision !== wanted || !current) {
      throw this.stale(view, id);
    }
    return profile;
  }

  /**
   * A new profile on the detected defaults, or (with `from`) a copy of that profile as it is now. `wanted` is an id the
   * caller chose (it must be free); without one the id is made from the name.
   */
  async create(
    name: unknown,
    from?: unknown,
    wanted?: unknown,
    template?: unknown,
    firstRun?: unknown,
  ): Promise<{ id: string; view: SettingsView }> {
    const title = cleanName(name);
    const chosen = wanted === undefined || wanted === '' ? undefined : cleanId(wanted);
    let created = '';
    if (template !== undefined && !FLOW_TEMPLATES.some((item) => item.id === template))
      throw new EngineError('bad_flow_template');
    if (
      firstRun !== undefined &&
      (template !== 'single' ||
        from !== undefined ||
        chosen !== undefined ||
        !firstRun ||
        typeof firstRun !== 'object' ||
        Array.isArray(firstRun))
    )
      throw new EngineError('bad_op');
    await this.view();
    await this.store.updateSettings((file) => {
      if (chosen && (isAuto(chosen) || file.profiles[chosen])) {
        throw new EngineError('id_taken', 409);
      }
      let id = chosen ?? slugify(title);
      for (let n = 2; isAuto(id) || file.profiles[id]; n += 1) id = `${slugify(title)}-${n}`;
      const source = typeof from === 'string' && from ? this.record(file, from) : null;
      const view = this.build(file);
      const baseSettings =
        view.profiles.find((profile) => profile.id === from)?.effective ??
        (view.profiles.find((profile) => profile.id === 'default')?.effective as SettingsFull);
      const singleSettings =
        template === 'single' ? this.singleSettings(view, baseSettings) : baseSettings;
      if (firstRun !== undefined) {
        const asked = firstRun as Record<string, unknown>;
        const candidate = singleSettings.seats[0];
        if (!candidate || asked.harness !== candidate.harness || asked.model !== candidate.model)
          throw new EngineError('first_run_changed', 409);
      }
      const flow =
        template === undefined
          ? source?.flow
          : template === 'council'
            ? undefined
            : flowTemplate(singleSettings, template as string);
      if (flow) checkedFlow(flow, file.library ?? emptyLibrary());
      if (firstRun !== undefined && flow) {
        const expected = checkedFlow(flow, file.library ?? emptyLibrary());
        const identity = canonicalFlow(expected);
        for (const [existing, record] of Object.entries(file.profiles)) {
          if (
            isAuto(existing) ||
            record.revision !== 1 ||
            record.base !== 'default' ||
            !record.flow ||
            Object.keys(record.overrides).length ||
            Object.keys(record.levels ?? {}).length ||
            (record.defaultLevel ?? DEFAULT_LEVEL) !== DEFAULT_LEVEL
          )
            continue;
          try {
            const resolved = checkedFlow(record.flow, file.library ?? emptyLibrary());
            if (
              finalAgent(resolved).prompt === finalAgent(expected).prompt &&
              canonicalFlow(resolved) === identity
            ) {
              created = existing;
              return file;
            }
          } catch {
            // An invalid saved design cannot be reused; keep it for its owner to fix.
          }
        }
      }
      if (Object.keys(file.profiles).filter((id) => !isAuto(id)).length >= MAX_PROFILES)
        throw new EngineError('too_many');
      const generation = file.nextGeneration ?? 1;
      file.nextGeneration = generation + 1;
      file.profiles[id] = {
        name: title,
        base: source?.base ?? 'default',
        revision: 1,
        generation,
        overrides: structuredClone(source?.overrides ?? {}),
        ...(flow ? { flow: storedFlow(checkedFlow(flow, file.library ?? emptyLibrary())) } : {}),
        ...(template === undefined && source?.levels
          ? { levels: structuredClone(source.levels) }
          : {}),
        ...(source?.defaultLevel ? { defaultLevel: source.defaultLevel } : {}),
      };
      created = id;
      return file;
    });
    return { id: created, view: await this.view() };
  }

  async library(): Promise<LibraryView> {
    const file = this.store.readSettings();
    return libraryView(
      file.library ?? emptyLibrary(),
      [...new Set(['default', 'quick', ...Object.keys(file.profiles)])].map((id) => ({
        id,
        flow: file.profiles[id]?.flow,
      })),
    );
  }

  /** The entry and every dependent level are validated in one settings transaction. */
  async editLibrary(
    kind: 'prompts' | 'forms',
    method: 'POST' | 'PUT' | 'DELETE',
    id: string | undefined,
    patch: Record<string, unknown>,
  ): Promise<LibraryView> {
    await this.view();
    await this.store.updateSettings((file) => {
      file.library ??= emptyLibrary();
      const library = file.library;
      const view = libraryView(
        library,
        Object.entries(file.profiles).map(([key, p]) => ({ id: key, flow: p.flow })),
      );
      const current = view[kind].find((e) => e.id === id);
      if (method !== 'POST' && !current) throw new EngineError('library_missing', 404);
      if (current?.builtin) throw new EngineError('library_builtin', 409);
      const formUsers =
        kind === 'forms' ? library.prompts.filter((p) => p.form === id).map((p) => p.id) : [];
      if (method === 'DELETE') {
        if (current?.usedBy.length || formUsers.length)
          throw new EngineError('library_in_use', 409, undefined, {
            models: current?.usedBy ?? [],
            prompts: formUsers,
          });
        if (kind === 'forms') library.forms = library.forms.filter((e) => e.id !== id);
        else library.prompts = library.prompts.filter((e) => e.id !== id);
        return file;
      }
      if (method === 'PUT' && patch.ifRevision !== current?.revision)
        throw new EngineError('library_stale', 409, undefined, { entry: current });
      const from =
        method === 'POST' && typeof patch.from === 'string'
          ? view[kind].find((e) => e.id === patch.from)
          : undefined;
      if (patch.from !== undefined && !from) throw new EngineError('library_missing', 404);
      if (kind === 'forms' && from?.builtin && ['member', 'answer'].includes(from.id))
        throw new EngineError('bad_library', 400, { reason: 'builtin_form_not_flat' });
      const entry = {
        ...(method === 'PUT' ? current : from),
        ...patch,
        id: method === 'PUT' ? id : patch.id,
        revision: method === 'PUT' ? (current?.revision ?? 0) + 1 : 1,
      } as PromptEntry | FormEntry;
      try {
        validateEntry(entry);
        if (kind === 'prompts') {
          validatePrompt(entry as PromptEntry);
          const form = (entry as PromptEntry).form;
          if (form && !view.forms.some((f) => f.id === form))
            throw new Error('prompt_form_missing');
        } else {
          compileForm((entry as FormEntry).fields);
        }
      } catch (error) {
        throw new EngineError('bad_library', 400, {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      if (method === 'POST' && view[kind].some((e) => e.id === entry.id))
        throw new EngineError('library_id_taken', 409);
      if (library.prompts.length + library.forms.length >= 200 && method === 'POST')
        throw new EngineError('too_many');
      // Pick the storage keys explicitly: view-only metadata and duplicate request keys never enter settings.json.
      if (kind === 'prompts') {
        const p = entry as PromptEntry;
        library.prompts = [
          ...library.prompts.filter((old) => old.id !== p.id),
          {
            id: p.id,
            name: p.name,
            form: p.form,
            inputs: p.inputs,
            text: p.text,
            revision: p.revision,
          },
        ];
      } else {
        const f = entry as FormEntry;
        library.forms = [
          ...library.forms.filter((old) => old.id !== f.id),
          { id: f.id, name: f.name, fields: f.fields, revision: f.revision },
        ];
      }
      const dependents = Object.entries(file.profiles)
        .filter(([, p]) => p.flow && referencesOf(p.flow)[kind].includes(entry.id))
        .map(([key]) => key);
      const candidate = this.build(file);
      for (const model of dependents) {
        const profile = candidate.profiles.find((p) => p.id === model);
        for (const level of REASONING_LEVELS)
          if (profile?.levels[level].blocked?.code === 'flow_invalid')
            throw new EngineError('library_invalidates_model', 409, {
              model,
              level,
              reason: profile.levels[level].blocked?.params?.reason ?? '',
            });
      }
      return file;
    });
    return this.library();
  }

  async remove(id: string): Promise<SettingsView> {
    if (isAuto(id)) {
      throw new EngineError('auto_profile_delete');
    }
    await this.store.updateSettings((file) => {
      this.record(file, id);
      delete file.profiles[id];
      return file;
    });
    return this.view();
  }

  // ---------- the endpoint's port ----------

  /** The port the endpoint listens on: the configured one, else the built-in default. */
  port(): number {
    return this.store.readSettings().port ?? DEFAULT_PORT;
  }

  async setPort(value: unknown): Promise<number> {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new EngineError('bad_port');
    }
    await this.store.updateSettings((file) => {
      file.port = value;
      return file;
    });
    return value;
  }
}
