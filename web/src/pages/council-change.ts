// What changed between the council a page showed and the one the server has now (pure, so a test can pin it): a member that is
// now off or gone or new, another assistant, model or effort, tools, memory or web of a member, the chairman's assistant, model,
// effort and memory, the limits, and a member that is on but will not be asked now (or will be asked again). The new-session card
// says it in words, one line each, before it asks again. It covers everything the level's fingerprint covers, so a start that
// the server refuses for a changed council always has something to say (and never adopts a different council silently).

import type { HarnessId, LevelView, SettingsFull } from '../../../src/shared/types.ts';

type Skipped = LevelView['skipped'];
export type SeatToggle = 'tools' | 'memory' | 'web';

export type CouncilChange =
  | { kind: 'seatOff' | 'seatOn' | 'seatRemoved' | 'seatAdded'; id: string; harness: HarnessId }
  | { kind: 'seatHarness'; id: string; harness: HarnessId; from: HarnessId; to: HarnessId }
  | { kind: 'seatModel' | 'seatEffort'; id: string; harness: HarnessId; from: string; to: string }
  | { kind: 'seatToggle'; id: string; harness: HarnessId; toggle: SeatToggle; on: boolean }
  | { kind: 'seatSkipped'; id: string; harness: HarnessId; reason: 'out' | 'family' | 'missing' }
  | { kind: 'seatBack'; id: string; harness: HarnessId }
  | { kind: 'chairmanHarness'; from: HarnessId; to: HarnessId }
  | { kind: 'chairmanModel' | 'chairmanEffort'; from: string; to: string }
  | { kind: 'chairmanMemory' | 'chairmanTools'; on: boolean }
  | { kind: 'limits' }
  /** The council is not the same, in a way this page has no words for: it still says so. */
  | { kind: 'other' };

const TOGGLES: SeatToggle[] = ['tools', 'memory', 'web'];

/**
 * The changes that turn `before` into `after`, members in the order of `after` (removed ones last), then the chairman, then the
 * limits. `skipped` (the members that are on and will not be asked) is compared when both are given.
 */
export function councilChanges(
  before: SettingsFull,
  after: SettingsFull,
  skipped?: { before: Skipped; after: Skipped },
): CouncilChange[] {
  const out: CouncilChange[] = [];
  const was = new Map(before.seats.map((seat) => [seat.id, seat]));
  for (const seat of after.seats) {
    const old = was.get(seat.id);
    if (!old) {
      if (seat.enabled) out.push({ kind: 'seatAdded', id: seat.id, harness: seat.harness });
      continue;
    }
    if (old.enabled && !seat.enabled)
      out.push({ kind: 'seatOff', id: seat.id, harness: old.harness });
    else if (!old.enabled && seat.enabled)
      out.push({ kind: 'seatOn', id: seat.id, harness: seat.harness });
    // what a member that is (or has just been) off runs on is not news: it is said that it is on or off, and that is all
    if (!old.enabled || !seat.enabled) continue;
    if (old.harness !== seat.harness) {
      out.push({
        kind: 'seatHarness',
        id: seat.id,
        harness: seat.harness,
        from: old.harness,
        to: seat.harness,
      });
    }
    if (old.model !== seat.model) {
      out.push({
        kind: 'seatModel',
        id: seat.id,
        harness: seat.harness,
        from: old.model,
        to: seat.model,
      });
    }
    if (old.effort !== seat.effort) {
      out.push({
        kind: 'seatEffort',
        id: seat.id,
        harness: seat.harness,
        from: old.effort,
        to: seat.effort,
      });
    }
    for (const toggle of TOGGLES) {
      if (old[toggle] !== seat[toggle]) {
        out.push({
          kind: 'seatToggle',
          id: seat.id,
          harness: seat.harness,
          toggle,
          on: seat[toggle],
        });
      }
    }
  }
  const now = new Set(after.seats.map((seat) => seat.id));
  for (const seat of before.seats) {
    if (!now.has(seat.id) && seat.enabled) {
      out.push({ kind: 'seatRemoved', id: seat.id, harness: seat.harness });
    }
  }
  if (skipped) {
    // a member that is on in both councils and will not be asked now (or will be asked again); one that was switched on or
    // off is said by that line alone
    const seatOf = new Map(after.seats.map((seat) => [seat.id, seat]));
    const hadSeat = (id: string) => was.get(id)?.enabled === true;
    const wasSkipped = new Map(skipped.before.map((item) => [item.id, item.reason]));
    const nowSkipped = new Map(skipped.after.map((item) => [item.id, item.reason]));
    for (const [id, reason] of nowSkipped) {
      const seat = seatOf.get(id);
      if (seat?.enabled && hadSeat(id) && wasSkipped.get(id) !== reason) {
        out.push({ kind: 'seatSkipped', id, harness: seat.harness, reason });
      }
    }
    for (const id of wasSkipped.keys()) {
      const seat = seatOf.get(id);
      if (seat?.enabled && hadSeat(id) && !nowSkipped.has(id)) {
        out.push({ kind: 'seatBack', id, harness: seat.harness });
      }
    }
  }
  if (before.chairman.harness !== after.chairman.harness) {
    out.push({
      kind: 'chairmanHarness',
      from: before.chairman.harness,
      to: after.chairman.harness,
    });
  }
  if (before.chairman.model !== after.chairman.model) {
    out.push({ kind: 'chairmanModel', from: before.chairman.model, to: after.chairman.model });
  }
  if (before.chairman.effort !== after.chairman.effort) {
    out.push({ kind: 'chairmanEffort', from: before.chairman.effort, to: after.chairman.effort });
  }
  if ((before.chairman.memory === true) !== (after.chairman.memory === true)) {
    out.push({ kind: 'chairmanMemory', on: after.chairman.memory === true });
  }
  if ((before.chairman.tools !== false) !== (after.chairman.tools !== false)) {
    out.push({ kind: 'chairmanTools', on: after.chairman.tools !== false });
  }
  if (
    before.budgets.maxClaims !== after.budgets.maxClaims ||
    before.budgets.maxWords !== after.budgets.maxWords
  ) {
    out.push({ kind: 'limits' });
  }
  return out;
}

/**
 * What is new in `fresh` over `shown`, two views of the same level: nothing when their fingerprints are the same (the council is
 * the same, whatever moved behind it), and else at least one line: the changes found, or `other` when the fingerprint moved
 * for a reason this page cannot name. A start never takes a different council without the card saying so.
 */
export function councilNews(shown: LevelView, fresh: LevelView): CouncilChange[] {
  if (shown.fingerprint === fresh.fingerprint) return [];
  const lines = councilChanges(shown.effective, fresh.effective, {
    before: shown.skipped ?? [],
    after: fresh.skipped ?? [],
  });
  return lines.length > 0 ? lines : [{ kind: 'other' }];
}
