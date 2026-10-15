// What a round has cost, from every call it made (failed and cancelled ones included), live while it runs.

import type { ChairNode } from '../../src/shared/types.ts';

export interface Spend {
  /** Everything the harnesses report: input, cached input and output. */
  total: number;
  cached: number;
  /** The text the council exchanged (prompts plus outputs), a secondary figure. */
  council: number;
  /** True when some call's usage is an estimate (the harness reported none). */
  estimated: boolean;
}

export function chairSpend(chair: ChairNode): Spend {
  const attempts = chair.attempts ?? [];
  if (attempts.length === 0) {
    return {
      total: chair.usage.total,
      cached: chair.usage.cached ?? 0,
      council: chair.usage.council ?? 0,
      estimated: chair.usage.estimated,
    };
  }
  return {
    total: attempts.reduce((sum, attempt) => sum + (attempt.usage?.total ?? 0), 0),
    cached: attempts.reduce((sum, attempt) => sum + (attempt.usage?.cached ?? 0), 0),
    council: attempts.reduce((sum, attempt) => sum + attempt.councilTokens, 0),
    estimated: attempts.some((attempt) => attempt.usage?.source === 'estimate'),
  };
}
