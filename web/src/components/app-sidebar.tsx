// The shell's sidebar (shadcn Sidebar): the brand, the newest sessions with their Running / Ready badges and "All sessions",
// and Councils, Connect and Settings in the footer. It is on the end side in Persian (`side="right"`).

import {
  BookMarkedIcon,
  EllipsisIcon,
  FolderOpenIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
  Trash2Icon,
  UsersIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { ListText } from '@/components/bidi';
import { DivanMark } from '@/components/divan-mark';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n/index.tsx';
import { clientName } from '@/lib/folder';
import type { Route } from '@/router';
import { isReady, useAppState } from '@/store';
import type { SessionSummary } from '../../../src/shared/types.ts';

const SHOWN = 12;
const ALL_SESSIONS = '#/sessions';

/**
 * The sessions, for the collapsed rail (a session page folds the sidebar to icons, which would hide the list): one button that
 * opens the same list in a popover, with «All sessions» at its foot.
 */
function CollapsedSessions({ openId }: { openId: string | null }) {
  const { t, dir } = useI18n();
  const sessions = useAppState((state) => state.sessions);
  const hidden = useAppState((state) => state.pendingDelete);
  const seen = useAppState((state) => state.seen);
  const [open, setOpen] = useState(false);
  const shown = useMemo(
    () => sessions.filter((item) => !hidden.includes(item.id)).slice(0, SHOWN),
    [sessions, hidden],
  );
  return (
    <SidebarGroup
      className="hidden group-data-[collapsible=icon]:block"
      data-testid="rail-sessions"
    >
      <SidebarMenu>
        <SidebarMenuItem>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <SidebarMenuButton
                  tooltip={t('nav.sessions')}
                  aria-label={t('nav.sessions')}
                  data-testid="rail-sessions-button"
                />
              }
            >
              <MessagesSquareIcon />
              <span>{t('nav.sessions')}</span>
            </PopoverTrigger>
            <PopoverContent
              side={dir === 'rtl' ? 'left' : 'right'}
              align="start"
              className="w-72 gap-1 p-1"
              data-testid="rail-sessions-list"
            >
              {shown.length === 0 ? (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">{t('nav.noSessions')}</p>
              ) : null}
              <ul className="flex flex-col">
                {shown.map((item) => {
                  const status = item.running
                    ? t('status.running')
                    : isReady(item, seen)
                      ? t('status.ready')
                      : null;
                  return (
                    <li key={item.id}>
                      <a
                        href={`#/s/${item.id}${lastNode(item.id)}`}
                        data-testid="rail-session"
                        aria-current={openId === item.id ? 'page' : undefined}
                        className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:bg-muted"
                        onClick={() => setOpen(false)}
                      >
                        <ListText text={item.title} className="flex-1" />
                        {status ? (
                          <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
                <li>
                  <a
                    href={ALL_SESSIONS}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
                    onClick={() => setOpen(false)}
                  >
                    <FolderOpenIcon className="size-4" />
                    {t('nav.allSessions')}
                  </a>
                </li>
              </ul>
            </PopoverContent>
          </Popover>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function AppSidebar({
  route,
  onRename,
  onDelete,
}: {
  route: Route;
  onRename: (session: SessionSummary) => void;
  onDelete: (session: SessionSummary) => void;
}) {
  const { t, dir } = useI18n();
  const sessions = useAppState((state) => state.sessions);
  const hidden = useAppState((state) => state.pendingDelete);
  const seen = useAppState((state) => state.seen);
  const shown = useMemo(
    () => sessions.filter((item) => !hidden.includes(item.id)).slice(0, SHOWN),
    [sessions, hidden],
  );
  const openId = route.name === 'session' ? route.id : null;

  return (
    <Sidebar side={dir === 'rtl' ? 'right' : 'left'} dir={dir} collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip={t('nav.home')}
              render={<a href="#/" aria-label={`${t('app.name')}, ${t('nav.home')}`} />}
            >
              <DivanMark size={22} />
              <span
                className="font-semibold group-data-[collapsible=icon]:hidden"
                dir="ltr"
                translate="no"
              >
                {t('app.name')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <CollapsedSessions openId={openId} />
        <SidebarGroup
          className="group-data-[collapsible=icon]:hidden"
          data-testid="sidebar-sessions"
        >
          <SidebarGroupLabel>{t('nav.sessions')}</SidebarGroupLabel>
          <SidebarGroupAction
            title={t('nav.newSession')}
            render={<a href="#/" data-testid="new-session" aria-label={t('nav.newSession')} />}
          >
            <PlusIcon />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {shown.length === 0 ? (
                <li className="px-2 py-1.5 text-sm text-muted-foreground">{t('nav.noSessions')}</li>
              ) : null}
              {shown.map((item) => {
                const ready = isReady(item, seen);
                // the status is a spinner or a dot; the word is the row's tooltip and is read out
                const status = item.running
                  ? t('status.running')
                  : ready
                    ? t('status.ready')
                    : null;
                return (
                  <SidebarMenuItem key={item.id} data-testid="sidebar-session">
                    <SidebarMenuButton
                      size="sm"
                      isActive={openId === item.id}
                      className={status ? 'pe-8' : undefined}
                      title={status ? `${item.title} · ${status}` : undefined}
                      render={<a href={`#/s/${item.id}${lastNode(item.id)}`} />}
                    >
                      <ListText text={item.title} className="flex-1" />
                      {item.origin === 'api' ? (
                        // a session that came through /v1 (Pi, T3 Code) says so
                        <span
                          className="shrink-0 text-[10px] text-sidebar-foreground/60"
                          data-testid="sidebar-origin"
                        >
                          <bdi dir="ltr">
                            {clientName(item.client)
                              ? t('sessions.from', { name: clientName(item.client) as string })
                              : t('sessions.fromEndpoint')}
                          </bdi>
                        </span>
                      ) : null}
                      {status ? <span className="sr-only">{status}</span> : null}
                    </SidebarMenuButton>
                    {status ? (
                      <SidebarMenuBadge
                        data-status={item.running ? 'running' : 'ready'}
                        className="transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0"
                      >
                        {item.running ? (
                          <Spinner className="size-3.5" aria-hidden="true" />
                        ) : (
                          <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                        )}
                      </SidebarMenuBadge>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <SidebarMenuAction
                            showOnHover
                            aria-label={t('common.more')}
                            data-testid="session-menu"
                          />
                        }
                      >
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="inline-end" align="start">
                        <DropdownMenuItem onClick={() => onRename(item)}>
                          <PencilIcon />
                          {t('common.rename')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={item.running}
                          onClick={() => onDelete(item)}
                        >
                          <Trash2Icon />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                );
              })}
              <SidebarMenuItem>
                <SidebarMenuButton
                  size="sm"
                  isActive={route.name === 'sessions'}
                  className="text-sidebar-foreground/70"
                  render={<a href="#/sessions" data-testid="all-sessions" />}
                >
                  <FolderOpenIcon />
                  <span>{t('nav.allSessions')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.newSession')}
              className="hidden group-data-[collapsible=icon]:flex"
              render={<a href="#/" aria-label={t('nav.newSession')} />}
            >
              <PlusIcon />
              <span>{t('nav.newSession')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.councils')}
              isActive={route.name === 'councils'}
              render={<a href="#/models" data-testid="nav-councils" />}
            >
              <UsersIcon />
              <span>{t('nav.councils')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.library')}
              isActive={route.name === 'library'}
              render={<a href="#/library" data-testid="nav-library" />}
            >
              <BookMarkedIcon />
              <span>{t('nav.library')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.connect')}
              isActive={route.name === 'connect'}
              render={<a href="#/connect" data-testid="nav-connect" />}
            >
              <PlugIcon />
              <span>{t('nav.connect')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={t('nav.settings')}
              isActive={route.name === 'settings'}
              render={<a href="#/settings" data-testid="nav-settings" />}
            >
              <SettingsIcon />
              <span>{t('nav.settings')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

/** Opening a session from the sidebar goes to the round the user last had open there. */
const NODE_KEY = 'divan-last-node';
export function lastNodeOf(sessionId: string): string | null {
  try {
    const map = JSON.parse(localStorage.getItem(NODE_KEY) ?? '{}') as Record<string, string>;
    return map[sessionId] ?? null;
  } catch {
    return null;
  }
}
export function rememberNode(sessionId: string, nodeId: string): void {
  try {
    const map = JSON.parse(localStorage.getItem(NODE_KEY) ?? '{}') as Record<string, string>;
    if (map[sessionId] === nodeId) return;
    map[sessionId] = nodeId;
    localStorage.setItem(NODE_KEY, JSON.stringify(map));
  } catch {
    // storage that is off only loses the place
  }
}
function lastNode(sessionId: string): string {
  const node = lastNodeOf(sessionId);
  return node ? `/n/${node}` : '';
}
