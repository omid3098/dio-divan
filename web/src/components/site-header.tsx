// The header bar: the sidebar toggle, the title (a session's, renamed in place), the command palette, the connection light,
// the token meter, "Session settings" (read-only) and the Test-mode badge.

import { FolderIcon, InfoIcon, LockIcon, SearchIcon } from 'lucide-react';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { renameSession } from '@/actions';
import { Mono } from '@/components/bidi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { toast } from '@/components/ui/toast';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useFormat } from '@/i18n/format';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { folderName } from '@/lib/folder';
import { cn } from '@/lib/utils';
import type { Route } from '@/router';
import { chairSpend } from '@/spend';
import { useAppState } from '@/store';
import { textDirection } from '../../../src/shared/text.ts';

const TITLE_KEY: Record<string, Key> = {
  home: 'nav.newSession',
  sessions: 'sessions.title',
  councils: 'nav.councils',
  library: 'nav.library',
  connect: 'nav.connect',
  settings: 'nav.settings',
};

/** The session's own title, a button that becomes a field: Enter saves, Escape leaves it as it was. */
function SessionTitle({ id, title }: { id: string; title: string }) {
  const { t } = useI18n();
  const rounds = useAppState((state) => state.sessions.find((item) => item.id === id)?.rounds ?? 0);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) field.current?.select();
  }, [editing]);

  async function commit() {
    const next = value.trim();
    setEditing(false);
    if (!next || next === title) return;
    try {
      await renameSession(id, next);
    } catch {
      toast.add({ title: t('sessions.renameFailed'), type: 'error' });
    }
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) void commit();
    if (event.key === 'Escape') setEditing(false);
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {editing ? (
        <input
          ref={field}
          data-testid="title-input"
          className="h-7 min-w-0 max-w-96 flex-1 rounded-md border bg-background px-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          dir={textDirection(value) ?? undefined}
          value={value}
          aria-label={t('common.rename')}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKey}
          onBlur={() => void commit()}
        />
      ) : (
        <button
          type="button"
          data-testid="session-title"
          title={t('common.rename')}
          className="min-w-0 max-w-96 truncate rounded-md px-1.5 py-1 text-start text-sm font-medium hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          dir={textDirection(title) ?? undefined}
          onClick={() => {
            setValue(title);
            setEditing(true);
          }}
        >
          {title}
        </button>
      )}
      {rounds > 0 ? (
        <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
          · {t('header.rounds', { count: rounds })}
        </span>
      ) : null}
    </div>
  );
}

/** The session's working folder: its last path segment as a small muted chip, the whole path in a tooltip. */
function FolderChip({ path }: { path: string }) {
  const { t } = useI18n();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="hidden max-w-40 shrink-0 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:inline-flex"
            aria-label={t('header.folder', { name: folderName(path) })}
            data-testid="folder-chip"
          />
        }
      >
        <FolderIcon className="size-3 shrink-0" />
        <span className="truncate" dir="auto">
          {folderName(path)}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <Mono data-testid="folder-chip-path">{path}</Mono>
      </TooltipContent>
    </Tooltip>
  );
}

/** What the council has used in this session so far: the figures the harnesses reported, no estimate and no limit. */
function TokenMeter({ used }: { used: number }) {
  const { t, lang } = useI18n();
  const f = useFormat();
  return (
    <span
      // the figures are written in the style of the rest of the screen (in Persian, «89 هزار», as the chips say it)
      dir={lang === 'fa' ? 'rtl' : 'ltr'}
      className={cn(
        'shrink-0 text-xs tabular-nums text-muted-foreground',
        lang !== 'fa' && 'font-mono',
      )}
      title={t('header.tokensHint')}
      data-testid="token-meter"
    >
      <span className="sr-only">{t('header.tokens')} </span>
      {f.compactText(used)} {t('cost.tokens')}
    </span>
  );
}

export function SiteHeader({
  route,
  onOpenPalette,
  onOpenSettings,
}: {
  route: Route;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useI18n();
  const meta = useAppState((state) => state.meta);
  const connected = useAppState((state) => state.connected);
  const session = useAppState((state) => state.session);
  const summaries = useAppState((state) => state.sessions);
  const open = route.name === 'session' && session?.id === route.id ? session : null;
  const title = open ? (summaries.find((item) => item.id === open.id)?.title ?? open.name) : null;
  const used = open
    ? Object.values(open.nodes).reduce(
        (sum, node) => sum + (node.kind === 'chair' ? chairSpend(node).total : 0),
        0,
      )
    : 0;
  const connection = connected === null ? 'connecting' : connected ? 'up' : 'down';

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
      <SidebarTrigger aria-label={t('nav.toggleSidebar')} />
      <Separator orientation="vertical" className="my-auto h-4" />
      {open && title !== null ? (
        <>
          <SessionTitle id={open.id} title={title} />
          {open.settings.cwd ? <FolderChip path={open.settings.cwd} /> : null}
        </>
      ) : (
        <h1 className="truncate text-sm font-medium" data-testid="page-title">
          {route.name === 'session' ? t('nav.session') : t(TITLE_KEY[route.name] ?? 'nav.home')}
        </h1>
      )}

      <div className="ms-auto flex min-w-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          // below about 1000 px the search is an icon: the title, the meter and the buttons all have to fit
          className="w-8 shrink-0 justify-center px-0 text-muted-foreground min-[1000px]:w-56 min-[1000px]:justify-start min-[1000px]:px-2.5"
          data-testid="palette-button"
          aria-label={t('header.search')}
          title={t('header.search')}
          onClick={onOpenPalette}
        >
          <SearchIcon />
          <span className="hidden flex-1 truncate text-start min-[1000px]:inline">
            {t('header.search')}
          </span>
          <Kbd className="hidden min-[1000px]:inline-flex" dir="ltr">
            Ctrl K
          </Kbd>
        </Button>
        <span
          className={cn(
            'size-2 shrink-0 rounded-full',
            connection === 'up'
              ? 'bg-emerald-500'
              : connection === 'down'
                ? 'bg-destructive'
                : 'bg-muted-foreground/50',
          )}
          data-testid="connection"
          data-state={connection}
          role="img"
          title={t(`conn.${connection}`)}
          aria-label={t(`conn.${connection}`)}
        />
        {open ? <TokenMeter used={used} /> : null}
        {open ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={onOpenSettings}
                  aria-label={t('header.sessionSettings')}
                  data-testid="session-settings-button"
                />
              }
            >
              <LockIcon />
              <span className="hidden min-[1000px]:inline">{t('header.sessionSettings')}</span>
            </TooltipTrigger>
            <TooltipContent>{t('header.sessionSettings')}</TooltipContent>
          </Tooltip>
        ) : null}
        {meta?.fake ? (
          <Badge variant="outline" title={t('header.testModeHint')} data-testid="test-mode">
            <InfoIcon />
            <span className="hidden sm:inline">{t('header.testMode')}</span>
          </Badge>
        ) : null}
      </div>
    </header>
  );
}
