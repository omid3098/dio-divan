// Library: the prompts and the output forms the models of a design refer to. Two tabs (Prompts, Output forms); a list on one side and
// the editor of the selected entry on the other. A built-in entry is read-only and can be duplicated; the person's own can be made,
// edited (an explicit save, with the 409 screen), duplicated and deleted, and a deletion the server refuses says which models use the
// entry. Editing an entry changes every model that uses it from then on (a started session keeps what it started with).

import { BookMarkedIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useI18n } from '@/i18n/index.tsx';
import { currentLeaveGuard, goTo, navigate } from '@/leave-guard';
import type { LibraryTab, Route } from '@/router';
import type { LibraryView } from '../../../src/shared/library.ts';
import type { Meta } from '../../../src/shared/types.ts';
import { type EntryView, loadLibrary } from './library/api.ts';
import { EntryEditor } from './library/EntryEditor.tsx';
import { EntryList } from './library/EntryList.tsx';

const hashOf = (tab: LibraryTab, id?: string): string => `#/library/${tab}${id ? `/${id}` : ''}`;

export function Library({
  meta,
  route,
}: {
  meta: Meta;
  route: Extract<Route, { name: 'library' }>;
}) {
  const { t } = useI18n();
  const tab: LibraryTab = route.tab ?? 'prompts';
  const [library, setLibrary] = useState<LibraryView | null>(null);
  const [failed, setFailed] = useState(false);
  /** A new entry that has not been saved: which kind, and a counter so that «New» again starts from nothing. */
  const [draft, setDraft] = useState<{ kind: LibraryTab; seq: number } | null>(null);

  useEffect(() => {
    let live = true;
    loadLibrary().then(
      (found) => live && setLibrary(found),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // a draft belongs to its tab and to «no entry selected»
  useEffect(() => {
    setDraft((now) => (now && (now.kind !== tab || route.id) ? null : now));
  }, [tab, route.id]);

  /** Starts a new entry: after the open one, if it has something unsaved, is dealt with. */
  const startDraft = useCallback(() => {
    const go = () => {
      if (route.id) goTo(hashOf(tab));
      setDraft((now) => ({ kind: tab, seq: (now?.seq ?? 0) + 1 }));
    };
    const guard = currentLeaveGuard();
    if (guard?.dirty()) guard.ask(go, 'library', t('library.goal.new'));
    else go();
  }, [route.id, tab, t]);

  const entries = (library?.[tab] ?? []) as EntryView[];
  const selected = route.id ? entries.find((entry) => entry.id === route.id) : undefined;
  const showDraft = draft !== null && draft.kind === tab && !route.id;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="library" data-tab={tab}>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2">
        <h2 className="text-base font-semibold">{t('nav.library')}</h2>
        <Tabs value={tab} onValueChange={(next) => navigate(hashOf(next as LibraryTab))}>
          <TabsList aria-label={t('nav.library')}>
            <TabsTrigger value="prompts" data-testid="library-tab-prompts">
              {t('library.tab.prompts')}
            </TabsTrigger>
            <TabsTrigger value="forms" data-testid="library-tab-forms">
              {t('library.tab.forms')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <p
          className="hidden min-w-0 flex-1 text-xs text-muted-foreground lg:block"
          data-testid="library-intro"
        >
          {t('library.intro')}
        </p>
      </div>

      {failed ? (
        <p className="p-6 text-sm text-destructive" role="alert">
          {t('library.loadFailed')}
        </p>
      ) : !library ? (
        <p className="p-6 text-sm text-muted-foreground">{t('load.loading')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-60 w-full shrink-0 flex-col overflow-hidden border-b md:max-h-none md:w-72 md:border-b-0 md:border-e">
            <EntryList
              kind={tab}
              library={library}
              selectedId={route.id ?? null}
              draftName={showDraft ? '' : null}
              onNew={startDraft}
              newDisabled={false}
            />
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {showDraft ? (
              <EntryEditor
                key={`${tab}:new:${draft.seq}`}
                kind={tab}
                entry={null}
                library={library}
                profiles={meta.settings.profiles}
                onLibrary={setLibrary}
                onGo={goTo}
              />
            ) : selected ? (
              <EntryEditor
                key={`${tab}:${selected.id}`}
                kind={tab}
                entry={selected}
                library={library}
                profiles={meta.settings.profiles}
                onLibrary={setLibrary}
                onGo={goTo}
              />
            ) : route.id ? (
              <Empty className="m-6 border" data-testid="library-missing">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BookMarkedIcon />
                  </EmptyMedia>
                  <EmptyTitle>{t('library.missingTitle')}</EmptyTitle>
                  <EmptyDescription>{t('library.missingText')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Empty className="m-6 border" data-testid="library-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <BookMarkedIcon />
                  </EmptyMedia>
                  <EmptyTitle>{t('library.emptyTitle')}</EmptyTitle>
                  <EmptyDescription>
                    {t(tab === 'prompts' ? 'library.emptyPrompts' : 'library.emptyForms')}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </main>
        </div>
      )}
    </div>
  );
}
