// The default configuration, worked out from what this PC has. No model id is written down here: every id comes from a
// harness's own model list. The selection rules, in order:
//   1. One seat per working harness, on its own default model, or else the first non-lightweight model of its list
//      (CLIs list their best model first), with high reasoning where the model offers it.
//   2. The chairman is a model whose family no seat uses. Pi is preferred when it has one; then any other harness.
//      With none, the best available model is chosen and setup shows the family warning.
//   3. Pi's seat takes a model of a family that no other seat and not the chairman uses; with none left it stays off.
// A model that ran out of credit or is rate limited is never picked (a harness with nothing else gets a seat that is off).

import { HARNESS_RULES, normalizeToggles } from './harness-rules.ts';
import { type Note, note } from './messages.ts';
import { modelFamily } from './text.ts';
import type {
  Budgets,
  HarnessId,
  HarnessModels,
  ModelInfo,
  SeatConfig,
  SettingsFull,
} from './types.ts';

/** Whether a model recently failed for lack of credit (itself, or its whole provider). */
export function isUnavailable(item: HarnessModels, id: string, now = Date.now()): boolean {
  return (item.unavailable ?? []).some(
    (entry) =>
      new Date(entry.until).getTime() > now &&
      (entry.id === id || (entry.prefix !== undefined && id.startsWith(entry.prefix))),
  );
}

export const HARNESS_ORDER: HarnessId[] = ['claude', 'codex', 'agy', 'grok', 'pi', 'hermes'];

/** The port the endpoint (`/v1`) listens on unless settings say otherwise: a fixed address for clients such as Pi. */
export const DEFAULT_PORT = 47321;

/** The brief's budgets: the answer form of a member (there is no limit on the tokens a session uses). */
export const DEFAULT_BUDGETS: Budgets = {
  maxClaims: 8,
  maxWords: 50,
};

/**
 * The only limit on a member (and on the chairman): while it keeps sending signs of work (any event on its output stream)
 * Divan never stops it; it is stopped when this long passes after its last sign with no new one (Omid's rule, 2026-10-10).
 */
export const IDLE_STOP_MS = 10 * 60 * 1000;

/** Words in a model id that mark a smaller, cheaper model; a "strongest" pick passes over them. */
const LIGHTWEIGHT = new Set([
  'flash',
  'lite',
  'mini',
  'nano',
  'fast',
  'spark',
  'haiku',
  'luna',
  'small',
  'tiny',
]);

/** Whole words of the model's own name (the part after the last "/"), so a provider such as "litellm" does not count. */
const isLightweight = (id: string): boolean =>
  (id.split('/').at(-1) ?? id)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .some((word) => LIGHTWEIGHT.has(word));

/** The model to use: the harness's default, else the first listed that is not lightweight, else the first. */
export function pickModel(models: ModelInfo[], preferred = ''): ModelInfo | undefined {
  return (
    models.find((model) => model.id === preferred) ??
    models.find((model) => !isLightweight(model.id)) ??
    models[0]
  );
}

/** High reasoning where the model offers it; otherwise the model's own default; '' when none can be set. */
export function pickEffort(model: ModelInfo | undefined): string {
  if (!model || model.efforts.length === 0) return '';
  if (model.efforts.includes('high')) return 'high';
  return model.defaultEffort || (model.efforts.at(-1) ?? '');
}

const familyOf = (harness: HarnessId, model: ModelInfo) => modelFamily(model.id, harness);

/** Routes and effort suffixes do not make two models. An unversioned alias is not another version. */
export function sameModel(a: string, b: string): boolean {
  const own = (id: string) =>
    (id.split('/').at(-1) ?? '')
      .toLowerCase()
      .replace(/:(?:off|minimal|low|medium|high|max|xhigh)$/u, '')
      .replace(/^claude-/u, '')
      .replace(/-latest$/u, '')
      .replace(/-20\d{2}(?:-?\d{2}){2}$/u, '')
      .replace(/(?<=\d)\.(?=\d)/gu, '-');
  const left = own(a);
  const right = own(b);
  return (
    left === right ||
    (!/\d/u.test(left) && right.startsWith(`${left}-`)) ||
    (!/\d/u.test(right) && left.startsWith(`${right}-`))
  );
}

/** Every run-compatible discovered candidate, including a model reserved for the chairman. */
export function usableCandidates(models: HarnessModels[]): SeatConfig[] {
  return HARNESS_ORDER.filter(
    (id) => HARNESS_RULES[id].supported && !HARNESS_RULES[id].manualOnly,
  ).flatMap((harness) => {
    const item = models.find((item) => item.harness === harness);
    if (!item) return [];
    const live = item.models.filter(
      (model) => !model.id.startsWith('divan/') && !isUnavailable(item, model.id),
    );
    const preferred = pickModel(live, item.defaultModel);
    return [...(preferred ? [preferred] : []), ...live.filter((model) => model !== preferred)].map(
      (model) => seatOf(harness, model, item.memoryReady === true),
    );
  });
}

function seatOf(
  harness: HarnessId,
  model: ModelInfo | undefined,
  memoryReady: boolean,
): SeatConfig {
  // Members use each harness's full reach, read-only enforced: tools, memory and web start ON wherever the harness can keep
  // them read-only (a toggle it cannot is put off by `normalizeToggles`); memory only where a connection to the memory
  // server can be built on this PC.
  return normalizeToggles(harness, {
    id: harness,
    // A harness that could not list its models gets a seat that stays off until Omid types a model.
    enabled: model !== undefined,
    harness,
    model: model?.id ?? '',
    effort: pickEffort(model),
    tools: true,
    memory: memoryReady,
    web: true,
  });
}

export const HARNESS_LABEL: Record<HarnessId, string> = {
  hermes: 'Hermes',
  claude: 'Claude Code',
  codex: 'Codex',
  agy: 'agy',
  grok: 'Grok',
  pi: 'Pi',
};

/**
 * `usable`: the model lists of the harnesses that work headless on this PC. `notes` collects what the defaults had to
 * leave out and why. A model that is unavailable (no credit, rate limited) is never picked: a harness with nothing
 * else gets a default seat that stays off. No two default seats share a model or a family.
 */
export function computeDefaults(
  usable: HarnessModels[],
  budgets: Budgets = DEFAULT_BUDGETS,
  notes: Note[] = [],
  retainedIds: string[] = [],
): SettingsFull {
  const now = Date.now();
  usable = usable.filter(
    (item) => HARNESS_RULES[item.harness].supported && !HARNESS_RULES[item.harness].manualOnly,
  );
  const oneAssistant =
    usable.filter((item) =>
      item.models.some(
        (model) => !model.id.startsWith('divan/') && !isUnavailable(item, model.id, now),
      ),
    ).length === 1;
  const byHarness = new Map(
    usable.map((item) => {
      const live = item.models.filter(
        (model) =>
          !model.id.startsWith('divan/') &&
          modelFamily(model.id, item.harness) !== 'unknown' &&
          !isUnavailable(item, model.id, now),
      );
      if (
        item.models.length > 0 &&
        item.models.every((model) => isUnavailable(item, model.id, now))
      ) {
        notes.push(note('harness_no_credit', { harness: HARNESS_LABEL[item.harness] }));
      }
      return [item.harness, { ...item, models: live }];
    }),
  );
  const own = (harness: HarnessId, exclude: Set<string> = new Set()): ModelInfo | undefined => {
    const item = byHarness.get(harness);
    if (!item) return undefined;
    const allowed = item.models.filter((model) => !exclude.has(familyOf(harness, model)));
    return pickModel(allowed, item.defaultModel);
  };

  // 1. one seat per working harness (Pi's comes after the chairman is known)
  const seats = new Map<HarnessId, SeatConfig>();
  for (const harness of HARNESS_ORDER) {
    if (harness !== 'pi' && byHarness.has(harness))
      seats.set(
        harness,
        seatOf(harness, own(harness), byHarness.get(harness)?.memoryReady === true),
      );
  }
  const used = new Set(
    [...seats.values()]
      .filter((seat) => seat.enabled)
      .map((seat) => modelFamily(seat.model, seat.harness)),
  );

  // 2. the chairman: Pi first, then any harness, on a family no seat uses
  const unusedIn = (harness: HarnessId): string[] => {
    const families: string[] = [];
    for (const model of byHarness.get(harness)?.models ?? []) {
      const family = familyOf(harness, model);
      if (!used.has(family) && !families.includes(family)) families.push(family);
    }
    return families;
  };
  const inFamily = (harness: HarnessId, family: string) =>
    pickModel(
      (byHarness.get(harness)?.models ?? []).filter((model) => familyOf(harness, model) === family),
    );

  let chairman: SettingsFull['chairman'] | null = null;
  let chairmanFamily = '';
  for (const harness of ['pi', ...HARNESS_ORDER.filter((id) => id !== 'pi')] as HarnessId[]) {
    const [family] = unusedIn(harness);
    if (!family) continue;
    const model = inFamily(harness, family);
    if (!model) continue;
    chairman = { harness, model: model.id, effort: pickEffort(model) };
    chairmanFamily = family;
    break;
  }

  // 3. Pi's seat: a family that no other seat and not the chairman uses. None left: the seat stays off, with a note.
  if (byHarness.has('pi')) {
    const taken = new Set([...used, ...(chairmanFamily ? [chairmanFamily] : [])]);
    const free = own('pi', taken);
    seats.set('pi', seatOf('pi', free, byHarness.get('pi')?.memoryReady === true));
  }

  const candidates = usableCandidates([...byHarness.values()]);
  const families = new Set(candidates.map((seat) => modelFamily(seat.model, seat.harness)));
  const chairOrder = ['pi', ...HARNESS_ORDER.filter((id) => id !== 'pi')];
  const chairCandidates = [...candidates].sort(
    (a, b) => chairOrder.indexOf(a.harness) - chairOrder.indexOf(b.harness),
  );
  const unique = (items: SeatConfig[]) => {
    const kept: SeatConfig[] = [];
    for (const item of items)
      if (
        !kept.some(
          (other) =>
            other.harness === item.harness ||
            modelFamily(other.model, other.harness) === modelFamily(item.model, item.harness),
        )
      )
        kept.push(item);
    return kept;
  };
  let selected = unique([...seats.values()].filter((seat) => seat.enabled));
  if (!chairman || selected.length < 2) {
    chairman = null;
    selected = [];
    for (const chair of chairCandidates) {
      const family = modelFamily(chair.model, chair.harness);
      const remaining = candidates.filter(
        (seat) => modelFamily(seat.model, seat.harness) !== family,
      );
      let members = unique(remaining);
      if (members.length < 2 && (families.size === 2 || oneAssistant)) {
        members = [];
        for (const first of remaining) {
          const options = remaining.filter(
            (seat) =>
              (oneAssistant || seat.harness !== 'pi' || first.harness !== 'pi') &&
              modelFamily(first.model, first.harness) === modelFamily(seat.model, seat.harness) &&
              !sameModel(first.model, seat.model),
          );
          const chosen = pickModel(
            options
              .map((seat) =>
                byHarness.get(seat.harness)?.models.find((model) => model.id === seat.model),
              )
              .filter((model): model is ModelInfo => model !== undefined),
          );
          const second = oneAssistant
            ? options.find((seat) => seat.model === chosen?.id)
            : options[0];
          if (second) {
            members = [first, second];
            break;
          }
        }
      }
      if (members.length < 2) continue;
      selected = members;
      chairman = { harness: chair.harness, model: chair.model, effort: chair.effort };
      break;
    }
    if (!chairman && families.size === 1) {
      const first = candidates.find((seat) => oneAssistant || seat.harness !== 'pi');
      const second = first && candidates.find((seat) => !sameModel(first.model, seat.model));
      if (first && second) {
        selected = [first, second];
        const thirdModel = pickModel(
          HARNESS_ORDER.flatMap((harness) => byHarness.get(harness)?.models ?? []).filter(
            (model) => !sameModel(model.id, first.model) && !sameModel(model.id, second.model),
          ),
        );
        const third = candidates.find((seat) => seat.model === thirdModel?.id);
        const chair = third ?? candidates[0];
        if (chair) chairman = { harness: chair.harness, model: chair.model, effort: chair.effort };
      }
    }
  }
  if (!chairman) {
    const chair = candidates[0];
    chairman = {
      harness: chair?.harness ?? 'pi',
      model: chair?.model ?? '',
      effort: chair?.effort ?? '',
    };
  }
  // Keep the original harness seats when reserved or unavailable, so stored on/off and level patches keep their owner.
  for (const seat of seats.values()) seat.enabled = false;
  const extra: SeatConfig[] = [];
  for (const seat of selected) {
    const base = seats.get(seat.harness);
    if (!base?.enabled) seats.set(seat.harness, { ...seat, enabled: true, id: seat.harness });
    else extra.push({ ...seat, enabled: true, id: `${seat.harness}-2` });
  }

  const ordered = HARNESS_ORDER.flatMap((harness) => {
    const seat = seats.get(harness);
    return seat ? [seat, ...extra.filter((item) => item.harness === harness)] : [];
  });
  // Referenced members keep their override owner even when their harness disappears.
  for (const id of retainedIds) {
    const harness = HARNESS_ORDER.find(
      (one) => !HARNESS_RULES[one].manualOnly && (id === one || id === `${one}-2`),
    );
    if (!harness || ordered.some((seat) => seat.id === id)) continue;
    const first = seats.get(harness);
    const model = byHarness
      .get(harness)
      ?.models.find((model) => !first || !sameModel(first.model, model.id));
    ordered.push({
      ...seatOf(harness, model, byHarness.get(harness)?.memoryReady === true),
      id,
      enabled: false,
    });
  }
  if (
    (byHarness.get('pi')?.models.length ?? 0) > 0 &&
    !ordered.some((seat) => seat.harness === 'pi' && seat.enabled)
  )
    notes.push(
      note(chairman.harness === 'pi' ? 'pi_not_member_chairman' : 'pi_not_member', {
        harness: HARNESS_LABEL.pi,
      }),
    );
  chairman.tools = HARNESS_RULES[chairman.harness].tools.mode !== 'blocked';
  if (oneAssistant && selected.length >= 2)
    notes.push(note('one_assistant_council', { harness: HARNESS_LABEL[chairman.harness] }));
  else if (oneAssistant && families.size >= 2 && selected.length < 2)
    notes.push(
      note('one_assistant_pair_missing', {
        harness: HARNESS_LABEL[candidates[0]?.harness ?? 'pi'],
      }),
    );
  chairman.memory =
    HARNESS_RULES[chairman.harness].memory.mode !== 'blocked' &&
    byHarness.get(chairman.harness)?.memoryReady === true;
  return { seats: ordered, chairman, budgets };
}

// ---------- the quick profile ----------

/** How many seats the quick profile keeps. */
export const QUICK_SEATS = 3;

/**
 * Families by how fast their harnesses answered on this PC (one real round: Claude Code 18 s, Codex 22 s, Grok 80 s);
 * only a prior, used for a seat nobody has timed yet.
 */
const FAMILY_SPEED = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'zhipu',
  'alibaba',
  'meta',
  'mistral',
  'moonshot',
  'xai',
];

/**
 * The key a measured speed is kept under: the assistant AND its model. The same assistant on another model is another speed, so
 * a model that Quick does not use (one a council was pinned to) never moves what Quick ranks by.
 */
export const speedKey = (harness: HarnessId, model: string): string => `${harness}|${model}`;

/**
 * How quick a seat is: measured seats first (by their mean seconds per call), then the unmeasured by their family's place in
 * `FAMILY_SPEED`. Smaller is quicker; compared as a pair.
 */
export function speedRank(
  seat: Pick<SeatConfig, 'harness' | 'model'>,
  latency: ReadonlyMap<string, number>,
): [number, number] {
  const seconds = latency.get(speedKey(seat.harness, seat.model));
  if (seconds !== undefined) return [0, seconds];
  const place = FAMILY_SPEED.indexOf(modelFamily(seat.model, seat.harness));
  return [1, place === -1 ? FAMILY_SPEED.length : place];
}

/**
 * The defaults reduced for speed: the `QUICK_SEATS` seats with the lowest measured latency (unmeasured ones after the
 * measured, quickest family first), the rest off, and every seat on low reasoning (medium when low is not offered).
 * `latency` is the mean seconds of a finished seat call per assistant and model (`speedKey`).
 *
 * The chairman is not from the members' families (the rule of the defaults: a chairman that shares a family with a member
 * favours it, and the family would have to change every round). So a family is reserved for it: if the quickest three seats
 * leave none, the slowest of them gives its place to the next seat when that leaves one, and with no such choice the council
 * is two members; with no free family even then, `quick` is not built: it is the quickest three seats on the defaults'
 * chairman, a note says so (`no_quick_family`), and setup shows the family warning, to be
 * set by hand.
 *
 * The chairman is the slow part of a round, so it is chosen for speed too: from the models of the families that are free, the
 * one with the lowest measured time at the reasoning level it would run at (`chairmanLatency`, keyed by `chairmanKey`); a
 * model nobody has timed yet comes after the timed ones, a known-fast one (a lightweight model, then the quicker families)
 * first. It runs on low reasoning (medium when low is not offered).
 */
export const chairmanKey = (harness: HarnessId, model: string, effort: string): string =>
  `${harness}|${model}|${effort}`;

export const NO_QUICK_FAMILY: Note = note('no_quick_family');
/** The reason `quick` does not run: its chairman is of the same family as a member. */
export const QUICK_BLOCKED: Note = note('quick_blocked');

/** Whether the chairman is of the same model family as one of the members that run (what `quick` must never have). */
export function chairmanFamilyClash(
  seats: readonly { harness: string; model: string; enabled?: boolean }[],
  chairman: { harness: string; model: string },
): boolean {
  const family = modelFamily(chairman.model, chairman.harness);
  return seats.some(
    (seat) =>
      seat.enabled !== false &&
      (family === 'unknown' ||
        modelFamily(seat.model, seat.harness) === 'unknown' ||
        modelFamily(seat.model, seat.harness) === family),
  );
}

export const QUICK_TWO_MEMBERS: Note = note('quick_two_members');

export function quickProfile(
  defaults: SettingsFull,
  models: HarnessModels[],
  latency: ReadonlyMap<string, number>,
  chairmanLatency: ReadonlyMap<string, number> = new Map(),
  notes: Note[] = [],
): SettingsFull {
  const infoOf = (harness: HarnessId, id: string) =>
    models.find((item) => item.harness === harness)?.models.find((model) => model.id === id);
  const effortFor = (harness: HarnessId, id: string, current: string, order: string[]) => {
    const info = infoOf(harness, id);
    if (!info || info.efforts.length === 0) return current;
    return order.find((effort) => info.efforts.includes(effort)) ?? pickEffort(info);
  };
  const rank = (seat: SeatConfig) => speedRank(seat, latency);
  const out = (seat: SeatConfig) => {
    const item = models.find((entry) => entry.harness === seat.harness);
    return item ? isUnavailable(item, seat.model) : false;
  };
  // a seat on a model that is out is never one of the quick seats, whatever the defaults say; the quickest first
  const ranked = defaults.seats
    .filter((seat) => seat.enabled && !out(seat) && !HARNESS_RULES[seat.harness].manualOnly)
    .sort((a, b) => {
      const [ga, ta] = rank(a);
      const [gb, tb] = rank(b);
      return ga - gb || ta - tb;
    });

  const harnesses = new Set<HarnessId>([
    ...defaults.seats.map((seat) => seat.harness),
    defaults.chairman.harness,
  ]);
  /** The models a chairman can be, fastest first, from the families that `taken` leaves free. */
  const chairmen = (taken: Set<string>) =>
    models
      .filter(
        (item) =>
          harnesses.has(item.harness) &&
          HARNESS_RULES[item.harness].supported &&
          !HARNESS_RULES[item.harness].manualOnly,
      )
      .flatMap((item) =>
        item.models
          .filter(
            (model) =>
              !model.id.startsWith('divan/') &&
              familyOf(item.harness, model) !== 'unknown' &&
              !isUnavailable(item, model.id) &&
              !taken.has(familyOf(item.harness, model)),
          )
          .map((model) => {
            const effort = effortFor(item.harness, model.id, '', ['low', 'medium']);
            const seconds = chairmanLatency.get(chairmanKey(item.harness, model.id, effort));
            const place = FAMILY_SPEED.indexOf(familyOf(item.harness, model));
            const order: [number, number, number] =
              seconds !== undefined
                ? [0, seconds, 0]
                : [1, isLightweight(model.id) ? 0 : 1, place === -1 ? FAMILY_SPEED.length : place];
            return { harness: item.harness, model: model.id, effort, order };
          }),
      )
      .sort(
        (a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.order[2] - b.order[2],
      );
  const familiesOf = (seats: SeatConfig[]) =>
    new Set(seats.map((seat) => modelFamily(seat.model, seat.harness)));

  // the quickest set of members that leaves a family for the chairman: three if there is one, else two
  let kept: SeatConfig[] | null = null;
  let chairman: SettingsFull['chairman'] | null = null;
  for (const size of [QUICK_SEATS, 2]) {
    if (kept || ranked.length < size) continue;
    const sets = combinations(ranked, size).sort(
      (a, b) =>
        a.reduce((sum, seat) => sum + ranked.indexOf(seat), 0) -
        b.reduce((sum, seat) => sum + ranked.indexOf(seat), 0),
    );
    for (const set of sets) {
      const fastest = chairmen(familiesOf(set))[0];
      if (!fastest) continue;
      kept = set;
      chairman = {
        harness: fastest.harness,
        model: fastest.model,
        effort: fastest.effort,
        tools: HARNESS_RULES[fastest.harness].tools.mode !== 'blocked',
        memory:
          HARNESS_RULES[fastest.harness].memory.mode !== 'blocked' &&
          models.find((item) => item.harness === fastest.harness)?.memoryReady === true,
      };
      break;
    }
    if (kept && size < QUICK_SEATS && ranked.length > size) notes.push(QUICK_TWO_MEMBERS);
  }
  if (!kept) {
    // no family can be kept free: the quickest three, the defaults' chairman, and a note to be set by hand
    kept = ranked.slice(0, QUICK_SEATS);
    const fallback = HARNESS_RULES[defaults.chairman.harness].manualOnly
      ? (usableCandidates(models)[0] ?? { harness: 'pi' as const, model: '', effort: '' })
      : defaults.chairman;
    chairman = {
      ...fallback,
      effort: effortFor(fallback.harness, fallback.model, fallback.effort, ['low', 'medium']),
    };
    notes.push(NO_QUICK_FAMILY);
  }
  const keep = new Set(kept.map((seat) => seat.id));
  return {
    seats: defaults.seats.map((seat) => ({
      ...seat,
      enabled: keep.has(seat.id),
      effort: effortFor(seat.harness, seat.model, seat.effort, ['low', 'medium']),
    })),
    chairman: chairman as SettingsFull['chairman'],
    budgets: defaults.budgets,
  };
}

/** Every way to choose `size` of `items`, in the order of their places. */
function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  return items.flatMap((item, index) =>
    combinations(items.slice(index + 1), size - 1).map((rest) => [item, ...rest]),
  );
}
