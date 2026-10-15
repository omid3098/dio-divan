// Overrides are only the fields Omid changed. The web app works out the difference between what it shows (the
// effective settings) and the detected defaults, and stores that; the server lays the overrides over the defaults.

import type {
  Budgets,
  ChairmanConfig,
  SeatConfig,
  SettingsFull,
  SettingsOverrides,
} from './types.ts';

const SEAT_FIELDS = ['enabled', 'harness', 'model', 'effort', 'tools', 'memory', 'web'] as const;
const CHAIRMAN_FIELDS = ['harness', 'model', 'effort', 'tools', 'memory'] as const;
const BUDGET_FIELDS = ['maxClaims', 'maxWords'] as const;

/** The fields of `effective` that differ from `defaults`; seats Omid added are kept whole. */
export function diffSettings(defaults: SettingsFull, effective: SettingsFull): SettingsOverrides {
  const out: SettingsOverrides = {};
  const known = new Map(defaults.seats.map((seat) => [seat.id, seat]));
  const seats: Record<string, Partial<Omit<SeatConfig, 'id'>>> = {};
  const extraSeats: SeatConfig[] = [];
  for (const seat of effective.seats) {
    const base = known.get(seat.id);
    if (!base) {
      extraSeats.push(seat);
      continue;
    }
    const changed: Record<string, unknown> = {};
    for (const field of SEAT_FIELDS) if (seat[field] !== base[field]) changed[field] = seat[field];
    if (Object.keys(changed).length > 0)
      seats[seat.id] = changed as Partial<Omit<SeatConfig, 'id'>>;
  }
  if (Object.keys(seats).length > 0) out.seats = seats;
  if (extraSeats.length > 0) out.extraSeats = extraSeats;

  const chairman: Record<string, unknown> = {};
  for (const field of CHAIRMAN_FIELDS) {
    // Absent tools are on; absent memory is off.
    const was =
      field === 'tools'
        ? (defaults.chairman.tools ?? true)
        : field === 'memory'
          ? (defaults.chairman.memory ?? false)
          : defaults.chairman[field];
    const now =
      field === 'tools'
        ? (effective.chairman.tools ?? true)
        : field === 'memory'
          ? (effective.chairman.memory ?? false)
          : effective.chairman[field];
    if (now !== was) chairman[field] = now;
  }
  if (Object.keys(chairman).length > 0) out.chairman = chairman as Partial<ChairmanConfig>;

  const budgets: Record<string, unknown> = {};
  for (const field of BUDGET_FIELDS) {
    if (effective.budgets[field] !== defaults.budgets[field])
      budgets[field] = effective.budgets[field];
  }
  if (Object.keys(budgets).length > 0) out.budgets = budgets as Partial<Budgets>;
  return out;
}

export const hasOverrides = (overrides: SettingsOverrides): boolean =>
  Object.keys(overrides.seats ?? {}).length > 0 ||
  (overrides.extraSeats?.length ?? 0) > 0 ||
  Object.keys(overrides.chairman ?? {}).length > 0 ||
  Object.keys(overrides.budgets ?? {}).length > 0;
