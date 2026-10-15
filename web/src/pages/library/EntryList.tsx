// The list of one tab of the Library: the entries of the person's own first, then the built-in ones. Each row says what the entry is
// for in one line and how many models use it; a new, unsaved entry is the first row until it is saved.

import { PlusIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { LibraryView } from '../../../../src/shared/library.ts';
import type { EntryView, FormView, Kind } from './api.ts';
import { entryName, promptFor } from './labels.ts';

export function EntryList({
  kind,
  library,
  selectedId,
  draftName,
  onNew,
  newDisabled,
}: {
  kind: Kind;
  library: LibraryView;
  selectedId: string | null;
  /** A new entry that is not saved yet (its name so far; null: none). */
  draftName: string | null;
  onNew: () => void;
  newDisabled: boolean;
}) {
  const { t } = useI18n();
  const entries = library[kind] as EntryView[];
  const own = entries.filter((entry) => !entry.builtin);
  const builtin = entries.filter((entry) => entry.builtin);
  const sub = (entry: EntryView): string =>
    kind === 'prompts'
      ? promptFor(library, entry as LibraryView['prompts'][number], t)
      : t('library.fieldCount', {
          count: Math.max(
            (entry as FormView).fields.length,
            Object.keys(((entry as FormView).schema?.properties ?? {}) as object).length,
          ),
        });
  const row = (entry: EntryView) => (
    <li key={entry.id}>
      <a
        href={`#/library/${kind}/${entry.id}`}
        data-testid="library-item"
        data-entry-id={entry.id}
        aria-current={entry.id === selectedId ? 'page' : undefined}
        className={cn(
          'flex flex-col gap-0.5 rounded-lg border border-transparent px-3 py-2 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
          entry.id === selectedId && 'border-border bg-muted',
        )}
      >
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
            {entryName(entry, kind, t)}
          </span>
          {entry.usedBy.length > 0 ? (
            <Badge variant="secondary" className="shrink-0" data-testid="library-used-count">
              {t('library.usedByCount', { count: entry.usedBy.length })}
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-muted-foreground" dir="auto">
          {sub(entry)}
        </span>
      </a>
    </li>
  );
  return (
    <nav
      className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3"
      aria-label={t(kind === 'prompts' ? 'library.tab.prompts' : 'library.tab.forms')}
      data-testid="library-list"
    >
      <Button
        variant="outline"
        size="sm"
        className="justify-between"
        data-testid="library-new"
        disabled={newDisabled}
        onClick={onNew}
      >
        {t(kind === 'prompts' ? 'library.newPrompt' : 'library.newForm')}
        <PlusIcon />
      </Button>
      <section className="flex flex-col gap-1" aria-labelledby={`lib-own-${kind}`}>
        <h3 id={`lib-own-${kind}`} className="px-3 text-xs font-medium text-muted-foreground">
          {t('library.yours')}
        </h3>
        <ul className="flex flex-col gap-0.5">
          {draftName !== null ? (
            <li>
              <span
                className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm"
                data-testid="library-draft"
              >
                <span className="truncate font-medium" dir="auto">
                  {draftName.trim() || t('library.untitled')}
                </span>
                <span className="text-xs text-muted-foreground">{t('library.notSaved')}</span>
              </span>
            </li>
          ) : null}
          {own.map(row)}
        </ul>
        {own.length === 0 && draftName === null ? (
          <p className="px-3 text-xs text-muted-foreground" data-testid="library-none">
            {t(kind === 'prompts' ? 'library.nonePrompts' : 'library.noneForms')}
          </p>
        ) : null}
      </section>
      <section className="flex flex-col gap-1" aria-labelledby={`lib-built-${kind}`}>
        <h3 id={`lib-built-${kind}`} className="px-3 text-xs font-medium text-muted-foreground">
          {t('library.builtin')}
        </h3>
        <ul className="flex flex-col gap-0.5">{builtin.map(row)}</ul>
      </section>
    </nav>
  );
}
