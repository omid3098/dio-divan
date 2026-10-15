// Which seats will actually run right now. A model that is known to be out of credit or rate limited is not asked, so
// the round that would start does not have those seats. This one function answers it for everything that depends on the
// answer: the round itself (the seat is skipped, no call, no spend), the members a level reports as not taking part (`LevelView.skipped`), and
// the identity of a cached answer (the cached council is not the council that would run now).

import {
  agentsOf,
  conditionSource,
  conditionsOf,
  type Flow,
  finalAgent,
  orderedNodes,
  wireState,
} from '../shared/flow.ts';
import { modelFamily } from '../shared/text.ts';
import type { HarnessStatus } from '../shared/types.ts';
import type { UnavailableEntry } from './store.ts';

interface SeatLike {
  harness: string;
  model: string;
  enabled?: boolean;
}

/**
 * The entry that rules `model` out, if one does: an account that is out (a provider prefix: the longer reason) before a
 * plain rate limit of that model, and only an entry that has not expired.
 */
export function outFor(
  entries: UnavailableEntry[],
  harness: string,
  model: string,
  now = Date.now(),
): UnavailableEntry | undefined {
  return entries
    .filter(
      (entry) =>
        entry.harness === harness &&
        new Date(entry.until).getTime() > now &&
        (entry.model === model || (entry.prefix !== undefined && model.startsWith(entry.prefix))),
    )
    .sort((a, b) => Number(b.prefix !== undefined) - Number(a.prefix !== undefined))[0];
}

/**
 * The enabled seats split into those that run, those that are skipped (with what rules them out: a model known to be out),
 * and, when the session keeps its chairman apart (`apart`: `quick`), those left out because they are of the chairman's
 * family. A seat that is out is not also counted as being of that family.
 */
export function eligibleSeats<T extends SeatLike>(
  seats: T[],
  entries: UnavailableEntry[],
  now = Date.now(),
  apart?: { harness: string; model: string },
): { run: T[]; skipped: { seat: T; entry: UnavailableEntry }[]; sameFamily: T[] } {
  const run: T[] = [];
  const skipped: { seat: T; entry: UnavailableEntry }[] = [];
  const sameFamily: T[] = [];
  const family = apart ? modelFamily(apart.model, apart.harness) : null;
  for (const seat of seats) {
    if (seat.enabled === false) continue;
    const entry = outFor(entries, seat.harness, seat.model, now);
    if (entry) skipped.push({ seat, entry });
    else if (
      family !== null &&
      (family === 'unknown' ||
        modelFamily(seat.model, seat.harness) === 'unknown' ||
        modelFamily(seat.model, seat.harness) === family)
    )
      sameFamily.push(seat);
    else run.push(seat);
  }
  return { run, skipped, sameFamily };
}

/** Writers are prerequisites, never independent votes of the final judge's family. */
export function eligibleFlow(
  flow: Flow,
  entries: UnavailableEntry[],
  now = Date.now(),
  apart = false,
  status?: HarnessStatus[],
) {
  const final = finalAgent(flow);
  const independent = agentsOf(flow).filter((agent) => ['member', 'critic'].includes(agent.role));
  const plan = eligibleSeats(independent, entries, now, apart ? final : undefined);
  const rest = agentsOf(flow).filter((agent) => !independent.includes(agent));
  const other = eligibleSeats(rest, entries, now);
  const missing = [...plan.run, ...other.run].filter(
    (agent) => status && status.find((item) => item.id === agent.harness)?.usable !== true,
  );
  const run = [...plan.run, ...other.run].filter((agent) => !missing.includes(agent));
  const available = new Set(run.map((a) => a.id));
  const conditions = conditionsOf(flow);
  let feasible = false;
  // With at most 18 boxes, enumerating code-only branch choices is small and catches impossible cross-branch quorums.
  for (let mask = 0; mask < 2 ** conditions.length && !feasible; mask++) {
    const states = new Map<string, 'done' | 'skipped' | 'blocked'>();
    const decisions = new Map<string, boolean>();
    for (const node of orderedNodes(flow)) {
      const gates = flow.edges.filter((e) => e.to === node.id && e.gate);
      if (
        gates.length &&
        !gates.some(
          (e) => states.get(e.from) === 'done' && decisions.get(e.from) === (e.gate === 'yes'),
        )
      ) {
        states.set(node.id, 'skipped');
        continue;
      }
      if (node.kind === 'condition') {
        const source = states.get(conditionSource(flow, node.id));
        if (source === 'skipped') states.set(node.id, 'skipped');
        else {
          states.set(node.id, 'done');
          decisions.set(
            node.id,
            source === 'done' && !!(mask & (2 ** conditions.findIndex((c) => c.id === node.id))),
          );
        }
      } else {
        const controls = [...states].map(([id, state]) => ({
          id,
          run: { state },
          result: decisions.get(id) ?? null,
        }));
        const dependency = (id: string) =>
          wireState(flow, controls, id, node.id) === 'inactive' ? 'skipped' : states.get(id);
        const required = node.required.map(dependency);
        const peers = node.responses?.ids.map(dependency) ?? [];
        const state = required.includes('skipped')
          ? 'skipped'
          : !available.has(node.id) || required.some((s) => s !== 'done')
            ? 'blocked'
            : node.responses && peers.filter((s) => s === 'done').length < node.responses.min
              ? peers.every((s) => s === 'skipped')
                ? 'skipped'
                : 'blocked'
              : 'done';
        states.set(node.id, state);
      }
    }
    feasible = states.get(final.id) === 'done';
  }
  return {
    run,
    skipped: [...plan.skipped, ...other.skipped],
    sameFamily: plan.sameFamily,
    missing,
    blocked: !feasible,
  };
}
