// What a session address selects: the round and the open details. The same rule starts the page and follows every address
// the user arrives at later (a typed address, Back, Forward), so the page never shows a round other than the one the address
// names. Pure, so that it can be tested without a page.

import type { ChairNode, Session } from '../../../src/shared/types.ts';
import type { Detail } from '../router.ts';

export interface RouteSelection {
  selectedId: string | null;
  detail: Detail | null;
}

/**
 * The round and the details an address selects. The round the address names, when it is in the session; else the one the
 * sidebar remembers for it; else the newest round. Details are those of the address, none when it names none.
 */
export function routeSelection(
  session: Pick<Session, 'nodes'>,
  route: { node?: string; detail?: Detail },
  remembered: string | null,
): RouteSelection {
  const chairs = Object.values(session.nodes).filter(
    (node): node is ChairNode => node.kind === 'chair',
  );
  const latest = [...chairs].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const wanted = route.node ?? remembered;
  return {
    selectedId: wanted && session.nodes[wanted] ? wanted : (latest?.id ?? null),
    detail: route.detail ?? null,
  };
}
