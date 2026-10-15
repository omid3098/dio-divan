// Lens modes (an experiment): a lens is a short investigative question made for the asker's question by a planner call before
// the members start. In `angle` every member answers the whole question and also investigates its lens (one member, the
// anchor, has none); in `only` every member answers ONLY its lens, and the chairman alone answers the asker. This file holds
// the pure parts: which mode a word is, how the planner's lenses are handed out, and what a seat was assigned.

import type { Lens, LensMode, SeatLens } from '../shared/types.ts';

export const LENS_MODES: readonly LensMode[] = ['off', 'angle', 'only'];

export const isLensMode = (value: unknown): value is LensMode =>
  typeof value === 'string' && (LENS_MODES as readonly string[]).includes(value);

/** A lens question is at most this many words (the code cuts a longer one). */
export const MAX_LENS_WORDS = 30;
/** The reason that goes with a lens, at most this many words. */
export const MAX_LENS_WHY_WORDS = 25;

/** How many lenses a round of `members` members asks the planner for: one less than the members in `angle`, as many in `only`. */
export function lensesWanted(mode: Exclude<LensMode, 'off'>, members: number): number {
  return Math.max(0, mode === 'angle' ? members - 1 : members);
}

/** In-place Fisher-Yates shuffle with the given source of randomness. */
function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

export interface Assignment {
  /** `angle`: the seat that has no lens. */
  anchorSeatId?: string;
  assignment: Record<string, SeatLens>;
  /** Members meant to have a lens that have none, because there were fewer lenses than members to give them to. */
  unassigned: number;
}

/**
 * Hands the lenses out. `seatIds` are the members that take part, in the council's order. In `angle` the first of them is the
 * anchor (deterministic, and recorded) and the others get one lens each at random; in `only` there is no anchor and every
 * member gets one lens at random. A member left without a lens answers the question as asked.
 */
export function assignLenses(args: {
  mode: Exclude<LensMode, 'off'>;
  seatIds: readonly string[];
  lenses: readonly Lens[];
  random?: () => number;
}): Assignment {
  const random = args.random ?? Math.random;
  const assignment: Record<string, SeatLens> = {};
  let anchorSeatId: string | undefined;
  const receivers = [...args.seatIds];
  if (args.mode === 'angle') {
    anchorSeatId = receivers.shift();
    if (anchorSeatId !== undefined) assignment[anchorSeatId] = 'anchor';
  }
  const order = shuffled(receivers, random);
  let unassigned = 0;
  for (const [index, seatId] of order.entries()) {
    const lens = args.lenses[index];
    assignment[seatId] = lens ?? null;
    if (!lens) unassigned += 1;
  }
  return { ...(anchorSeatId !== undefined ? { anchorSeatId } : {}), assignment, unassigned };
}
