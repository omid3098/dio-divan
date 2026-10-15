// The shell: the providers (theme, language, direction, toasts), the hash router with its leave guard, the live connection
// and the shadcn sidebar layout (sidebar, header bar, page).

import { useCallback, useEffect, useState } from 'react';
import type { Meta, Session, SessionSummary } from '../../src/shared/types.ts';
import { ApiError, api, connectEvents, hasToken, initToken } from './api.ts';
import { AppSidebar } from './components/app-sidebar.tsx';
import { CommandPalette } from './components/command-palette.tsx';
import { SessionActionsProvider, useSessionActions } from './components/session-actions.tsx';
import { SessionSettings } from './components/session-settings.tsx';
import { SiteHeader } from './components/site-header.tsx';
import { SidebarInset, SidebarProvider } from './components/ui/sidebar.tsx';
import { Toaster } from './components/ui/toast.tsx';
import { TooltipProvider } from './components/ui/tooltip.tsx';
import { I18nProvider, translate, useI18n } from './i18n/index.tsx';
import { reconcileSession, resumeLayoutSync } from './layout-sync.ts';
import { currentLeaveGuard, goTo, targetFor } from './leave-guard.ts';
import { handleHashChange, startNavigation } from './navigation.ts';
import { Connect } from './pages/Connect.tsx';
import { Councils } from './pages/Councils.tsx';
import { Home } from './pages/Home.tsx';
import { Library } from './pages/Library.tsx';
import { SessionPage } from './pages/Session.tsx';
import { Sessions } from './pages/Sessions.tsx';
import { Settings } from './pages/Settings.tsx';
import { parseRoute, type Route, replaceRoute } from './router.ts';
import {
  getState,
  readSession,
  receiveEvent,
  setSessionList,
  setState,
  useAppState,
} from './store.ts';
import { ThemeProvider } from './theme.tsx';

const SIDEBAR_KEY = 'divan-sidebar';
/** Whether the sidebar is open: remembered separately for a session page (the rail by default) and for the rest. */
function readSidebar(): { session: boolean; other: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(SIDEBAR_KEY) ?? '{}') as Partial<{
      session: boolean;
      other: boolean;
    }>;
    return { session: stored.session ?? false, other: stored.other ?? true };
  } catch {
    return { session: false, other: true };
  }
}

function Shell() {
  const { t } = useI18n();
  const [tokenRevision, setTokenRevision] = useState(0);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const meta = useAppState((state) => state.meta);
  const session = useAppState((state) => state.session);
  const sessions = useAppState((state) => state.sessions);
  const loadError = useAppState((state) => state.loadError);
  const actions = useSessionActions();
  const [loading, setLoading] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebar, setSidebar] = useState(readSidebar);
  // On a narrow window the councils page needs the room for its editor: the sidebar is the rail there (until it is opened by hand)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1000px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1000px)');
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const onCouncils = route.name === 'councils';
  useEffect(() => {
    if (route.name === 'councils' && window.location.hash.startsWith('#/councils'))
      replaceRoute(route);
  }, [route]);
  useEffect(() => {
    if (onCouncils && narrow) setSidebar((now) => ({ ...now, other: false }));
    else if (!onCouncils) setSidebar(readSidebar());
  }, [onCouncils, narrow]);

  // Where the user is in the history, and Back and Forward with a form that has something unsaved: see `navigation.ts`.
  useState(startNavigation);
  useEffect(() => {
    const onHash = () =>
      handleHashChange({
        // The server was restarted and printed a new address: pasted into this tab it changes only the fragment, so the page
        // is not lost. It takes the new token and sends what it was keeping for the layout.
        onToken: () => {
          initToken();
          setTokenRevision((value) => value + 1);
          resumeLayoutSync();
        },
        onRoute: (hash) => setRoute(parseRoute(hash)),
      });
    // A link in the shell asks the open form first (a click on it would otherwise just leave).
    const onClick = (event: MouseEvent) => {
      const guard = currentLeaveGuard();
      if (!guard?.dirty() || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = (event.target as Element | null)?.closest?.('a[href^="#/"]');
      if (!link) return;
      const hash = link.getAttribute('href') ?? '#/';
      event.preventDefault();
      guard.ask(() => goTo(hash), targetFor(hash), undefined, hash);
    };
    window.addEventListener('hashchange', onHash);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('hashchange', onHash);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  // First load, then the live stream; a fresh same-tab token starts this connection again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: tokenRevision deliberately restarts loading after sign-in.
  useEffect(() => {
    if (window.location.hash === '#expired') {
      setState({ loadError: translate('msg.link_expired') });
      return;
    }
    if (!hasToken()) {
      setState({ loadError: translate('load.noToken') });
      return;
    }
    let first = true;
    const load = async () => {
      try {
        const [loadedMeta, list] = await Promise.all([
          api<Meta>('/meta'),
          api<SessionSummary[]>('/sessions'),
        ]);
        setState({ meta: loadedMeta, loadError: null });
        setSessionList(list);
        const open = parseRoute(window.location.hash);
        if (open.name === 'session') {
          await readSession(
            () => api<Session>(`/sessions/${open.id}`),
            (fresh) => setState({ session: reconcileSession(fresh, getState().session) }),
          ).catch(() => undefined);
        }
      } catch (error) {
        setState({
          loadError: error instanceof ApiError ? error.message : translate('load.noServer'),
        });
      }
    };
    void load();
    return connectEvents(receiveEvent, (up) => {
      setState({ connected: up });
      if (up && !first) void load();
      first = false;
    });
  }, [tokenRevision]);

  // Opening a session reads it whole.
  const sessionId = route.name === 'session' ? route.id : null;
  useEffect(() => {
    if (!sessionId) return;
    if (session?.id === sessionId) return;
    let cancelled = false;
    setLoading(true);
    readSession(
      () => api<Session>(`/sessions/${sessionId}`),
      (loaded) => {
        if (!cancelled) setState({ session: reconcileSession(loaded, getState().session) });
      },
    )
      .catch(() => {
        if (!cancelled) goTo('#/');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, session?.id]);

  const reload = useCallback(() => {
    const open = parseRoute(window.location.hash);
    if (open.name !== 'session') return;
    readSession(
      () => api<Session>(`/sessions/${open.id}`),
      (fresh) => setState({ session: reconcileSession(fresh, getState().session) }),
    ).catch(() => undefined);
  }, []);

  // the tab says where it is
  const label = sessions.find((item) => route.name === 'session' && item.id === route.id)?.title;
  useEffect(() => {
    const where =
      route.name === 'session'
        ? (label ?? (session?.id === route.id ? session.name : t('nav.session')))
        : route.name === 'home'
          ? t('nav.newSession')
          : route.name === 'sessions'
            ? t('sessions.title')
            : route.name === 'councils'
              ? t('nav.councils')
              : route.name === 'library'
                ? t('nav.library')
                : route.name === 'connect'
                  ? t('nav.connect')
                  : t('nav.settings');
    document.title = `${where} · Dio Divan`;
  }, [route, session, label, t]);

  const kind = route.name === 'session' ? 'session' : 'other';
  const onSidebar = (open: boolean) => {
    const next = { ...sidebar, [kind]: open };
    setSidebar(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, JSON.stringify(next));
    } catch {
      // storage that is off only loses the choice
    }
  };

  return (
    <SidebarProvider
      open={sidebar[kind]}
      onOpenChange={onSidebar}
      className="h-svh min-h-0 overflow-hidden"
    >
      <AppSidebar route={route} onRename={actions.rename} onDelete={actions.remove} />
      <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden" data-testid="shell">
        <SiteHeader
          route={route}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {loadError ? (
            <div className="p-6">
              <div
                role="alert"
                className="max-w-xl rounded-lg border border-destructive/40 bg-destructive/5 p-4"
              >
                <p className="font-medium">{t('load.failed')}</p>
                <p className="text-sm text-muted-foreground">{loadError}</p>
              </div>
            </div>
          ) : !meta ? (
            <p className="p-6 text-sm text-muted-foreground">{t('load.loading')}</p>
          ) : route.name === 'home' ? (
            <Home meta={meta} />
          ) : route.name === 'sessions' ? (
            <Sessions />
          ) : route.name === 'councils' ? (
            <Councils meta={meta} route={route} />
          ) : route.name === 'library' ? (
            <Library meta={meta} route={route} />
          ) : route.name === 'connect' ? (
            <Connect meta={meta} />
          ) : route.name === 'settings' ? (
            <Settings />
          ) : session && session.id === route.id ? (
            <SessionPage key={session.id} session={session} route={route} reload={reload} />
          ) : (
            <p className="p-6 text-sm text-muted-foreground">{loading ? t('load.loading') : ''}</p>
          )}
        </div>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {session ? (
        <SessionSettings session={session} open={settingsOpen} onOpenChange={setSettingsOpen} />
      ) : null}
    </SidebarProvider>
  );
}

export function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <Toaster>
          <TooltipProvider>
            <SessionActionsProvider>
              <Shell />
            </SessionActionsProvider>
          </TooltipProvider>
        </Toaster>
      </I18nProvider>
    </ThemeProvider>
  );
}
