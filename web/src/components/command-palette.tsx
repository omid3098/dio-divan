// The command palette (shadcn Command in a dialog): sessions, the places of the app, the language and the theme.
// Ctrl K (or Cmd K) opens it from anywhere.

import {
  BookMarkedIcon,
  FolderOpenIcon,
  LanguagesIcon,
  MessageSquarePlusIcon,
  MoonIcon,
  PlugIcon,
  SettingsIcon,
  SunIcon,
  SunMoonIcon,
  UsersIcon,
} from 'lucide-react';
import { useEffect } from 'react';
import { ListText } from '@/components/bidi';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { type LangPref, useI18n } from '@/i18n/index.tsx';
import { navigate } from '@/leave-guard';
import { useAppState } from '@/store';
import { type Mode, useTheme } from '@/theme';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, setPref } = useI18n();
  const { setMode } = useTheme();
  const sessions = useAppState((state) => state.sessions);
  const hidden = useAppState((state) => state.pendingDelete);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'k' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onOpenChange]);

  const run = (action: () => void) => () => {
    onOpenChange(false);
    action();
  };
  // a navigation goes through the same guard as a link (the council form may have something unsaved)
  const to = (hash: string) => run(() => navigate(hash));
  const languages: [LangPref, string][] = [
    ['auto', t('settings.langAuto')],
    ['en', 'English'],
    ['fa', 'فارسی'],
  ];
  const modes: [Mode, string, typeof SunIcon][] = [
    ['light', t('settings.themeLight'), SunIcon],
    ['dark', t('settings.themeDark'), MoonIcon],
    ['system', t('settings.themeSystem'), SunMoonIcon],
  ];

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('palette.title')}
      description={t('palette.placeholder')}
    >
      <Command>
        <CommandInput placeholder={t('palette.placeholder')} data-testid="palette-input" />
        <CommandList>
          <CommandEmpty>{t('palette.empty')}</CommandEmpty>
          <CommandGroup heading={t('palette.go')}>
            <CommandItem value="new session" onSelect={to('#/')}>
              <MessageSquarePlusIcon />
              {t('nav.newSession')}
            </CommandItem>
            <CommandItem value="all sessions" onSelect={to('#/sessions')}>
              <FolderOpenIcon />
              {t('nav.allSessions')}
            </CommandItem>
            <CommandItem value="councils" onSelect={to('#/models')}>
              <UsersIcon />
              {t('nav.councils')}
            </CommandItem>
            <CommandItem value="library prompts forms" onSelect={to('#/library')}>
              <BookMarkedIcon />
              {t('nav.library')}
            </CommandItem>
            <CommandItem value="connect" onSelect={to('#/connect')}>
              <PlugIcon />
              {t('nav.connect')}
            </CommandItem>
            <CommandItem value="settings" onSelect={to('#/settings')}>
              <SettingsIcon />
              {t('nav.settings')}
            </CommandItem>
          </CommandGroup>
          {sessions.length > 0 ? (
            <CommandGroup heading={t('palette.sessions')}>
              {sessions
                .filter((item) => !hidden.includes(item.id))
                .slice(0, 30)
                .map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.title} ${item.id}`}
                    onSelect={to(`#/s/${item.id}`)}
                  >
                    <ListText text={item.title} className="flex-1" />
                  </CommandItem>
                ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading={t('palette.language')}>
            {languages.map(([pref, label]) => (
              <CommandItem
                key={pref}
                value={`language ${label}`}
                onSelect={run(() => setPref(pref))}
              >
                <LanguagesIcon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading={t('palette.theme')}>
            {modes.map(([mode, label, Icon]) => (
              <CommandItem key={mode} value={`theme ${label}`} onSelect={run(() => setMode(mode))}>
                <Icon />
                {label}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
