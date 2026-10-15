// What stands between the user and a page that has something unsaved. The page that has it (the councils form) registers a
// guard; the router asks it before any in-app navigation (a sidebar link, Back, Forward), so the edits are never lost without
// a choice: save, throw them away, or stay. `beforeunload` covers leaving the app itself.

export type LeaveTarget =
  | 'home'
  | 'sessions'
  | 'councils'
  | 'library'
  | 'connect'
  | 'settings'
  | 'session';

export interface LeaveGuard {
  /** Whether leaving now would lose something. */
  dirty(): boolean;
  /**
   * Asks what to do; `proceed` runs only if the answer lets the page go. `target` says where it goes, `goal` names it (a
   * council), and `hash` is the address it goes to, for a page that names the place by what is there («open Quick»).
   */
  ask(proceed: () => void, target: LeaveTarget, goal?: string, hash?: string): void;
}

let guard: LeaveGuard | null = null;
/** Until when the next hash change is one the user has already decided (it lapses: a decision that moves nothing is not kept). */
let bypassUntil = 0;
const BYPASS_MS = 1500;

export const setLeaveGuard = (next: LeaveGuard | null): void => {
  guard = next;
};

export const currentLeaveGuard = (): LeaveGuard | null => guard;

/** Goes to `hash` without asking again: the user has already decided (or there was nothing to decide). */
export function goTo(hash: string): void {
  if (window.location.hash === hash) return;
  bypassUntil = Date.now() + BYPASS_MS;
  window.location.hash = hash;
}

/** Moves the history by `delta` entries without asking again (replaying a Back or a Forward the user has approved). */
export function traverse(delta: number): void {
  // `go(0)` reloads the page: there is nothing to replay
  if (delta === 0) return;
  bypassUntil = Date.now() + BYPASS_MS;
  window.history.go(delta);
}

/** Whether the hash change that just fired was one `goTo` made (it is then not asked about). */
export function consumeBypass(): boolean {
  const was = Date.now() < bypassUntil;
  bypassUntil = 0;
  return was;
}

/** Where going to a hash leads. */
export function targetFor(hash: string): LeaveTarget {
  if (hash === '' || hash === '#' || hash === '#/') return 'home';
  if (hash.startsWith('#/sessions')) return 'sessions';
  if (hash.startsWith('#/models') || hash.startsWith('#/councils')) return 'councils';
  if (hash.startsWith('#/library')) return 'library';
  if (hash.startsWith('#/connect')) return 'connect';
  if (hash.startsWith('#/settings')) return 'settings';
  return 'session';
}

/** An in-app navigation by code: asks the open form first when it has something unsaved, as a click on a link does. */
export function navigate(hash: string, goal?: string): void {
  const open = guard;
  if (open?.dirty()) open.ask(() => goTo(hash), targetFor(hash), goal, hash);
  else goTo(hash);
}
