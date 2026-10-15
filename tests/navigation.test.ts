// Back and Forward with a form that has something unsaved: the form asks, a Back that is refused returns to EXACTLY the entry
// and address the user was on (also after the page rewrote its own address in place: the selected tab), and an approved one
// goes exactly where it was heading. Nothing reloads (`history.go(0)` would), and no entry is added or dropped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The page's own modules are loaded by a path in a variable: they use the browser's types, which this folder's typecheck (the
// server's, without them) must not follow.
const GUARD = '../web/src/leave-guard.ts';
const NAVIGATION = '../web/src/navigation.ts';
const ROUTER = '../web/src/router.ts';
interface Guard {
  goTo(hash: string): void;
  setLeaveGuard(
    guard: { dirty(): boolean; ask(proceed: () => void, target: string): void } | null,
  ): void;
}
interface Navigation {
  handleHashChange(hooks: { onToken(): void; onRoute(hash: string): void }): void;
  startNavigation(): void;
}
interface Router {
  replaceRoute(route: { name: 'councils'; id?: string; tab?: string }): void;
}
let goTo: Guard['goTo'];
let setLeaveGuard: Guard['setLeaveGuard'];
let handleHashChange: Navigation['handleHashChange'];
let startNavigation: Navigation['startNavigation'];
let replaceRoute: Router['replaceRoute'];

/** A browser's history: entries with a number in their state, `go`, `replaceState` and the `hashchange` it raises (later, as a browser does). */
class FakeBrowser {
  entries: { hash: string; state: unknown }[] = [{ hash: '#/', state: null }];
  index = 0;
  goCalls: number[] = [];
  reloads = 0;
  private listeners: (() => void)[] = [];
  readonly location = {
    get: () => this.entries[this.index]?.hash ?? '',
  };
  readonly window = {
    location: {
      get hash(): string {
        return browser.entries[browser.index]?.hash ?? '';
      },
      set hash(value: string) {
        const next = value.startsWith('#') ? value : `#${value}`;
        if (next === this.hash) return;
        browser.entries.splice(browser.index + 1);
        browser.entries.push({ hash: next, state: null });
        browser.index += 1;
        browser.raise();
      },
      pathname: '/',
      search: '',
    },
    history: {
      get state(): unknown {
        return browser.entries[browser.index]?.state ?? null;
      },
      replaceState: (state: unknown, _title: string, url?: string) => {
        const entry = browser.entries[browser.index];
        if (!entry) return;
        entry.state = state;
        if (url?.includes('#')) entry.hash = `#${url.split('#')[1]}`;
      },
      go: (delta: number) => browser.go(delta),
    },
    addEventListener: (_type: string, listener: () => void) => {
      browser.listeners.push(listener);
    },
  };

  go(delta: number): void {
    this.goCalls.push(delta);
    if (delta === 0) {
      this.reloads += 1;
      return;
    }
    const target = this.index + delta;
    if (target < 0 || target >= this.entries.length) return;
    const was = this.entries[this.index]?.hash;
    this.index = target;
    // a browser raises `hashchange` only when the address differs
    if (this.entries[this.index]?.hash !== was) this.raise();
  }

  raise(): void {
    queueMicrotask(() => {
      for (const listener of this.listeners) listener();
    });
  }
}

let browser: FakeBrowser;
let routes: string[];
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
type Ask = { proceed: () => void; target: string };
let asked: Ask[];
let dirty: boolean;

beforeEach(async () => {
  vi.resetModules();
  browser = new FakeBrowser();
  routes = [];
  asked = [];
  dirty = false;
  (globalThis as unknown as { window: unknown }).window = browser.window;
  ({ goTo, setLeaveGuard } = (await import(GUARD)) as Guard);
  ({ handleHashChange, startNavigation } = (await import(NAVIGATION)) as Navigation);
  ({ replaceRoute } = (await import(ROUTER)) as Router);
  startNavigation();
  browser.window.addEventListener('hashchange', () =>
    handleHashChange({ onToken: () => undefined, onRoute: (hash) => routes.push(hash) }),
  );
  setLeaveGuard({
    dirty: () => dirty,
    ask: (proceed, target) => asked.push({ proceed, target }),
  });
});
afterEach(() => {
  setLeaveGuard(null);
  (globalThis as unknown as { window?: unknown }).window = undefined;
});

/** The user opens the councils page and changes its tab (the page rewrites its address in place), then edits something. */
async function onCouncilsWithTabChanged() {
  goTo('#/models/default');
  await flush();
  expect(routes.at(-1)).toBe('#/models/default');
  replaceRoute({ name: 'councils', id: 'default', tab: 'high' });
  dirty = true;
}

describe('Back with something unsaved', () => {
  it('returns to exactly the entry and address the user was on, and asks once', async () => {
    await onCouncilsWithTabChanged();
    const entries = browser.entries.length;
    browser.go(-1); // the user presses Back
    await flush();
    // back where it was: the same entry, the same address (the tab included), nothing added or dropped, no reload
    expect(browser.index).toBe(1);
    expect(browser.window.location.hash).toBe('#/models/default?level=high');
    expect(browser.entries.length).toBe(entries);
    expect(browser.reloads).toBe(0);
    expect(browser.goCalls).toEqual([-1, 1]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.target).toBe('home');
    // the page did not navigate: the route is still the councils page
    expect(routes.at(-1)).toBe('#/models/default');
  });

  it('stays when the user cancels: nothing else moves', async () => {
    await onCouncilsWithTabChanged();
    browser.go(-1);
    await flush();
    const calls = [...browser.goCalls];
    // (the form was cancelled: it never calls `proceed`)
    await flush();
    expect(browser.goCalls).toEqual(calls);
    expect(browser.index).toBe(1);
    expect(browser.reloads).toBe(0);
    // and a second Back asks again, as the first did
    browser.go(-1);
    await flush();
    expect(asked).toHaveLength(2);
    expect(browser.index).toBe(1);
    expect(browser.goCalls.filter((delta) => delta === 0)).toEqual([]);
  });

  it('goes exactly back when the user approves', async () => {
    await onCouncilsWithTabChanged();
    browser.go(-1);
    await flush();
    dirty = false; // the edits were saved or thrown away
    asked[0]?.proceed();
    await flush();
    expect(browser.index).toBe(0);
    expect(browser.window.location.hash).toBe('#/');
    expect(routes.at(-1)).toBe('#/');
    expect(browser.reloads).toBe(0);
    expect(browser.goCalls).toEqual([-1, 1, -1]);
  });

  it('is not asked about when nothing is unsaved', async () => {
    await onCouncilsWithTabChanged();
    dirty = false;
    browser.go(-1);
    await flush();
    expect(asked).toEqual([]);
    expect(browser.index).toBe(0);
    expect(routes.at(-1)).toBe('#/');
  });
});

describe('Forward and a typed address with something unsaved', () => {
  it('a Forward that is refused comes back to the entry it left, and replays when approved', async () => {
    goTo('#/models/default');
    await flush();
    goTo('#/connect');
    await flush();
    browser.go(-1); // back to the councils page, nothing unsaved yet
    await flush();
    replaceRoute({ name: 'councils', id: 'default', tab: 'low' });
    dirty = true;
    browser.go(1); // Forward to the connect page
    await flush();
    expect(browser.index).toBe(1);
    expect(browser.window.location.hash).toBe('#/models/default?level=low');
    expect(asked).toHaveLength(1);
    dirty = false;
    asked[0]?.proceed();
    await flush();
    expect(browser.index).toBe(2);
    expect(routes.at(-1)).toBe('#/connect');
    expect(browser.reloads).toBe(0);
  });

  it('an address typed in (a new entry) is undone by moving back one entry, and replayed by going to it', async () => {
    await onCouncilsWithTabChanged();
    browser.window.location.hash = '#/settings';
    await flush();
    expect(browser.index).toBe(1);
    expect(browser.window.location.hash).toBe('#/models/default?level=high');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.target).toBe('settings');
    dirty = false;
    asked[0]?.proceed();
    await flush();
    expect(browser.window.location.hash).toBe('#/settings');
    expect(routes.at(-1)).toBe('#/settings');
    expect(browser.reloads).toBe(0);
  });

  it('never moves the history by zero (which reloads the page)', async () => {
    await onCouncilsWithTabChanged();
    browser.go(-1);
    await flush();
    dirty = false;
    asked[0]?.proceed();
    await flush();
    expect(browser.goCalls).not.toContain(0);
  });
});
