// Where the user is in the history, and what a Back, a Forward or a typed address does when a form has something unsaved.
//
// Every history entry the app visits is numbered in `history.state` (`n`). The app records the entry it is on (`entry`: its
// address and its number). When a form asks to stay, a Back or a Forward is undone by moving the history the same number of
// entries the other way, which adds and drops nothing, and once the user has decided it is replayed by moving it again: never
// with `pushState`, and never with `go(0)` (that reloads the page). The address changes that raise no event (`replaceRoute`:
// the selected round, the open tab) are recorded too, so the record is never behind the address.

import { consumeBypass, currentLeaveGuard, goTo, targetFor, traverse } from './leave-guard.ts';

interface Entry {
  hash: string;
  n: number;
}

let entry: Entry = { hash: '', n: 0 };
/** The number of the entry an undo is moving the history back to (its own hash change is not a navigation). */
let restoring: number | null = null;

const stateNumber = (): number | null => {
  const n = (window.history.state as { n?: number } | null)?.n;
  return typeof n === 'number' ? n : null;
};

/** The entry the app starts on: numbered once, and kept by the browser across a reload. */
export function startNavigation(): void {
  let n = stateNumber();
  if (n === null) {
    n = 0;
    window.history.replaceState({ ...((window.history.state as object | null) ?? {}), n }, '');
  }
  entry = { hash: window.location.hash, n };
  restoring = null;
}

/** The address was rewritten in place (no entry added, no event): the record follows it. */
export function syncEntry(hash: string): void {
  entry = { ...entry, hash };
}

export const currentEntry = (): Entry => entry;

export interface NavigationHooks {
  /** An address with a token was pasted into this tab: take it. */
  onToken(): void;
  /** The page is now at this address. */
  onRoute(hash: string): void;
}

/** A hash change: a link, Back, Forward or a typed address. Asks the open form first when it would lose something. */
export function handleHashChange(hooks: NavigationHooks): void {
  const arrived = window.location.hash;
  const n = stateNumber();
  const undoing = restoring;
  restoring = null;
  if (/token=/u.test(arrived)) {
    hooks.onToken();
  } else if (undoing !== null && n === undoing) {
    // the history was moved back to where the page is (the form chose to stay): nothing changed
    entry = { hash: arrived, n };
    return;
  } else if (!consumeBypass()) {
    const guard = currentLeaveGuard();
    // an entry of this page, a step away (a hash change that is not a step, such as the page's own rewrite, is not asked about)
    const delta = n === null ? 1 : n - entry.n;
    if (guard?.dirty() && delta !== 0) {
      // Back, Forward or an address typed in: the history goes back to where the page is, and the form asks what to do
      restoring = entry.n;
      window.history.go(-delta);
      guard.ask(
        () => (n === null ? goTo(arrived) : traverse(delta)),
        targetFor(arrived),
        undefined,
        arrived,
      );
      return;
    }
  }
  // the entry is numbered the first time it is visited
  let at = stateNumber();
  if (at === null) {
    at = entry.n + 1;
    window.history.replaceState({ ...((window.history.state as object | null) ?? {}), n: at }, '');
  }
  entry = { hash: window.location.hash, n: at };
  hooks.onRoute(window.location.hash);
}
