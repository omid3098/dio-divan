// "All sessions": every session as a row (title in its own direction, the newest recommendation, rounds, tokens, last activity)
// with its status; rename and delete (undoable) sit in the row's menu.

import {
  CheckIcon,
  EllipsisIcon,
  FolderOpenIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { useMemo } from 'react';
import { ListText } from '@/components/bidi';
import { useSessionActions } from '@/components/session-actions';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { useFormat } from '@/i18n/format';
import { useI18n } from '@/i18n/index.tsx';
import { clientName } from '@/lib/folder';
import { isReady, useAppState } from '@/store';
import type { SessionSummary } from '../../../src/shared/types.ts';

const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/**
 * What a row says besides its name: the recommendation of the newest finished round (else its direction). A session that has none yet shows
 * its question, but only when the name does not already say it (the name is usually the question, cut short).
 */
function subtitle(item: SessionSummary): string {
  // the newest recommendation (with its confidence); a direction only when no round has recommended anything
  if (item.recommendation) {
    return `${item.recommendation.choice} · ${Math.round(item.recommendation.confidence * 100)}%`;
  }
  if (item.direction) return item.direction;
  const title = flat(item.title).replace(/…$/u, '');
  return flat(item.question).startsWith(title) ? '' : item.question;
}

export function Sessions() {
  const { t } = useI18n();
  const f = useFormat();
  const actions = useSessionActions();
  const all = useAppState((state) => state.sessions);
  const hidden = useAppState((state) => state.pendingDelete);
  const seen = useAppState((state) => state.seen);
  const sessions = useMemo(() => all.filter((item) => !hidden.includes(item.id)), [all, hidden]);

  return (
    <div className="h-full overflow-y-auto" data-testid="session-list">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t('sessions.title')}</h2>
          <Button render={<a href="#/" />} size="sm">
            <PlusIcon />
            {t('nav.newSession')}
          </Button>
        </div>

        {sessions.length === 0 ? (
          <Empty className="border" data-testid="sessions-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpenIcon />
              </EmptyMedia>
              <EmptyTitle>{t('sessions.emptyTitle')}</EmptyTitle>
              <EmptyDescription>{t('sessions.emptyText')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<a href="#/" />}>{t('nav.newSession')}</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {sessions.map((item) => {
              const ready = isReady(item, seen);
              const sub = subtitle(item);
              return (
                <li
                  key={item.id}
                  className="group/row relative flex items-center"
                  data-testid="session-row"
                >
                  <a
                    href={`#/s/${item.id}`}
                    className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    <span className="flex items-center gap-2">
                      <ListText text={item.title} className="text-sm font-medium" />
                      {item.origin === 'api' ? (
                        <Badge
                          variant="outline"
                          data-testid="api-badge"
                          title={
                            item.client
                              ? t('sessions.fromApi', { client: item.client })
                              : t('sessions.fromApiPlain')
                          }
                        >
                          <bdi dir="ltr">
                            {clientName(item.client)
                              ? t('sessions.from', { name: clientName(item.client) as string })
                              : t('sessions.fromEndpoint')}
                          </bdi>
                        </Badge>
                      ) : null}
                    </span>
                    {sub ? <ListText text={sub} className="text-sm text-muted-foreground" /> : null}
                    <span className="text-xs text-muted-foreground">
                      {t('sessions.meta', {
                        rounds: t('header.rounds', { count: item.rounds }),
                        tokens: f.num(item.tokens),
                        ago: f.ago(item.updatedAt),
                      })}
                    </span>
                  </a>
                  <div className="flex shrink-0 items-center gap-2 pe-3 ps-1">
                    {item.running || ready ? (
                      <Badge variant={item.running ? 'secondary' : 'outline'}>
                        {item.running ? (
                          <Spinner className="size-3" aria-label={t('status.running')} />
                        ) : (
                          <CheckIcon />
                        )}
                        {item.running ? t('status.running') : t('status.ready')}
                      </Badge>
                    ) : null}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('common.more')}
                            data-testid="row-menu"
                          />
                        }
                      >
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => actions.rename(item)}>
                          <PencilIcon />
                          {t('common.rename')}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          disabled={item.running}
                          onClick={() => actions.remove(item)}
                        >
                          <Trash2Icon />
                          {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
