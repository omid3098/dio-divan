// The working folder of a new session, on Home: a combobox. Type a path, or pick one of the folders the last sessions were started
// with. Empty is allowed (no folder). The list is the page's own (not a popover), so the cursor never leaves the text box;
// the arrow keys move in it, Enter takes the highlighted one, Escape closes it.

import { FolderIcon, XIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { Mono } from '@/components/bidi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n/index.tsx';
import { folderName } from '@/lib/folder';

export function FolderField({
  id,
  value,
  onChange,
  recent,
  invalid,
  describedBy,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** The folders the last sessions were started with, newest first. */
  recent: string[];
  invalid: boolean;
  describedBy?: string;
}) {
  const { t } = useI18n();
  const list = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = value.trim().toLowerCase();
  // what matches what is typed (everything while it is empty); the path that is typed in full is not offered again
  const shown = useMemo(
    () =>
      recent.filter(
        (path) =>
          path.toLowerCase() !== typed && (typed === '' || path.toLowerCase().includes(typed)),
      ),
    [recent, typed],
  );
  const expanded = open && shown.length > 0;
  const pick = (path: string) => {
    onChange(path);
    setOpen(false);
    setActive(-1);
  };

  return (
    <div className="relative">
      <div className="relative">
        <FolderIcon className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          data-testid="folder"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={expanded && active >= 0 ? `${list}-${active}` : undefined}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          className="ps-8 pe-9 font-mono text-sm placeholder:font-sans"
          value={value}
          placeholder={t('home.folderPlaceholder')}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
              setActive((at) => (shown.length === 0 ? -1 : (at + 1) % shown.length));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setOpen(true);
              setActive((at) => (shown.length === 0 ? -1 : (at <= 0 ? shown.length : at) - 1));
            } else if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
              // Enter takes the highlighted folder; with none highlighted it does nothing (the question is asked from its own box)
              if (expanded && active >= 0 && shown[active]) {
                event.preventDefault();
                pick(shown[active] as string);
              }
            } else if (event.key === 'Escape' && expanded) {
              event.preventDefault();
              setOpen(false);
            }
          }}
        />
        {value ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute end-1.5 top-1/2 -translate-y-1/2"
            aria-label={t('home.folderClear')}
            data-testid="folder-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChange('')}
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div
          id={list}
          role="listbox"
          aria-label={t('home.folderRecent')}
          data-testid="folder-list"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {shown.map((path, index) => (
            <div
              key={path}
              id={`${list}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              data-testid="folder-option"
              className="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-sm aria-selected:bg-muted hover:bg-muted"
              // mouse down, not click: the text box keeps the focus, so the list is not closed before the choice is made
              onMouseDown={(event) => {
                event.preventDefault();
                pick(path);
              }}
              onKeyDown={undefined}
            >
              <span className="font-medium" dir="auto">
                {folderName(path)}
              </span>
              <Mono className="truncate text-xs text-muted-foreground">{path}</Mono>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
