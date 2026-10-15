// Quick picks the three fastest assistants on this PC by their measured speed, so its members can change from one visit to the
// next. The page remembers which assistants Quick had the last time the user looked, and says so when that is not what it has
// now (Ãƒâ€šÃ‚Â«Quick now uses Grok instead of Pi (Pi got slower)Ãƒâ€šÃ‚Â»). Pure, so that a test can pin it.

import type { HarnessId, ProfileView } from '../../../src/shared/types.ts';

/** What the user saw of Quick: its members, and how fast each assistant was (mean seconds of a call; absent: not measured). */
export interface QuickRoster {
  members: string[];
  speeds: Partial<Record<HarnessId, number>>;
}

/** The members the Quick council has now (the base council's members that are on), in a fixed order, with the measured speeds of every assistant. */
export function rosterOf(
  profile: Pick<ProfileView, 'effective'>,
  speeds: Partial<Record<HarnessId, number>>,
): QuickRoster {
  const members = [
    ...new Set(
      profile.effective.seats
        .filter((seat) => seat.enabled)
        .map((seat) => `${seat.harness}|${seat.model}`),
    ),
  ].sort();
  return { members, speeds: { ...speeds } };
}

export interface RosterChange {
  /** Assistants Quick uses now that it did not. */
  added: string[];
  /** Assistants Quick no longer uses. */
  removed: string[];
  /**
   * Why, when the speeds say: an assistant it dropped got slower (`slower`), or one it took up got faster (`faster`). Absent
   * when the page has no numbers to say it with.
   */
  reason?: { kind: 'slower' | 'faster'; harness: HarnessId };
}

/** What differs between the roster the user last saw and the one Quick has now; null when it is the same. */
export function rosterChange(seen: QuickRoster, now: QuickRoster): RosterChange | null {
  const added = now.members.filter(
    (member) =>
      !seen.members.includes(member) && !seen.members.includes(member.split('|')[0] ?? ''),
  );
  const removed = seen.members.filter(
    (member) =>
      !now.members.some(
        (current) =>
          current === member || (!member.includes('|') && current.startsWith(`${member}|`)),
      ),
  );
  if (added.length === 0 && removed.length === 0) return null;
  return { added, removed };
}

/** Unknown legacy models need a current baseline when no membership change can be proved. */
export function needsRosterBaseline(seen: QuickRoster | null, now: QuickRoster): boolean {
  return (
    seen === null ||
    (seen.members.some((member) => !member.includes('|')) && rosterChange(seen, now) === null)
  );
}

const KEY = 'divan-quick-roster-models';

/** The roster the user last saw, or null (never, or unreadable). */
export function readSeen(): QuickRoster | null {
  try {
    const raw = JSON.parse(
      localStorage.getItem(KEY) ?? localStorage.getItem('divan-quick-roster') ?? 'null',
    ) as Partial<QuickRoster> | null;
    if (!raw || !Array.isArray(raw.members)) return null;
    const roster = {
      members: raw.members.filter((member): member is string => typeof member === 'string'),
      speeds: raw.speeds && typeof raw.speeds === 'object' ? raw.speeds : {},
    };
    if (localStorage.getItem(KEY) === null) writeSeen(roster);
    return roster;
  } catch {
    return null;
  }
}

export function writeSeen(roster: QuickRoster): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(roster));
  } catch {
    // storage that is off only means the note comes again
  }
}
