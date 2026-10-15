// The address of the page: a hash route (`#/s/<session>/n/<round>?detail=council`), so the token in the fragment and the
// route live together and the server needs no route of its own. The selected round and the open details are part of the
// address (Dio Docs TBL-20) and are written with `replaceState`, so choosing a round adds no history entry.

import { isLevel } from '../../src/shared/levels.ts';
import type { ReasoningLevel } from '../../src/shared/types.ts';
import { syncEntry } from './navigation.ts';

export const DETAILS = ['council', 'claims', 'context', 'cost'] as const;
export type Detail = (typeof DETAILS)[number];
export const isDetail = (value: unknown): value is Detail =>
  typeof value === 'string' && (DETAILS as readonly string[]).includes(value);

/** A tab of the councils page: the base council, or one of the four reasoning levels. */
export type CouncilTab = 'base' | ReasoningLevel;

/** A tab of the Library page: its prompts or its output forms. */
export type LibraryTab = 'prompts' | 'forms';
export const isLibraryTab = (value: unknown): value is LibraryTab =>
  value === 'prompts' || value === 'forms';

export type Route =
  | { name: 'home' }
  | { name: 'sessions' }
  | { name: 'connect' }
  | { name: 'settings' }
  | { name: 'councils'; id?: string; tab?: CouncilTab }
  | { name: 'library'; tab?: LibraryTab; id?: string }
  | { name: 'session'; id: string; node?: string; detail?: Detail };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/u, '').split('?');
  const params = new URLSearchParams(query);
  const session = /^\/s\/([A-Za-z0-9_-]+)(?:\/n\/([A-Za-z0-9_-]+))?/u.exec(path);
  if (session?.[1]) {
    const detail = params.get('detail');
    return {
      name: 'session',
      id: session[1],
      ...(session[2] ? { node: session[2] } : {}),
      ...(isDetail(detail) ? { detail } : {}),
    };
  }
  if (/^\/(models|councils)(?:\/|$)/u.test(path)) {
    const id = /^\/(?:models|councils)\/([A-Za-z0-9_-]+)/u.exec(path)?.[1];
    const tab = params.get('level');
    return {
      name: 'councils',
      ...(id ? { id } : {}),
      ...(tab === 'base' || isLevel(tab) ? { tab: tab as CouncilTab } : {}),
    };
  }
  const library = /^\/library(?:\/(prompts|forms)(?:\/([A-Za-z0-9_.-]+))?)?\/?$/u.exec(path);
  if (library)
    return {
      name: 'library',
      ...(isLibraryTab(library[1]) ? { tab: library[1] } : {}),
      ...(library[2] ? { id: library[2] } : {}),
    };
  if (path.startsWith('/connect')) return { name: 'connect' };
  if (path.startsWith('/settings')) return { name: 'settings' };
  if (path.startsWith('/sessions')) return { name: 'sessions' };
  return { name: 'home' };
}

export function routeHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'sessions':
      return '#/sessions';
    case 'connect':
      return '#/connect';
    case 'settings':
      return '#/settings';
    case 'councils':
      return `#/models${route.id ? `/${route.id}` : ''}${route.tab ? `?level=${route.tab}` : ''}`;
    case 'library':
      return `#/library${route.tab ? `/${route.tab}${route.id ? `/${route.id}` : ''}` : ''}`;
    case 'session':
      return `#/s/${route.id}${route.node ? `/n/${route.node}` : ''}${route.detail ? `?detail=${route.detail}` : ''}`;
  }
}

/**
 * Writes the address without adding a history entry and without raising a route change (the numbered state is kept). The
 * navigation's record of where the page is follows it: a Back that is undone later must come back to THIS address.
 */
export function replaceRoute(route: Route): void {
  const hash = routeHash(route);
  if (window.location.hash === hash) return;
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}${hash}`,
  );
  syncEntry(hash);
}
