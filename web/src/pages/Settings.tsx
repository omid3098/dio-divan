// Settings → Appearance: the interface language (Auto from the browser, English, فارسی), the mode (light, dark, system)
// and shadcn's theme presets. Every choice applies at once, without a reload, and is kept per browser.

import { CheckIcon, MoonIcon, SunIcon, SunMoonIcon } from 'lucide-react';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { type LangPref, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import { type Mode, useTheme } from '@/theme';
import { PRESETS } from '@/themes';

const LANGUAGES: [LangPref, string | null][] = [
  ['auto', null],
  ['en', 'English'],
  ['fa', 'فارسی'],
];

export function Settings() {
  const { t, pref, setPref } = useI18n();
  const { mode, setMode, preset, setPreset, dark } = useTheme();
  const modes: [Mode, string, typeof SunIcon][] = [
    ['light', t('settings.themeLight'), SunIcon],
    ['dark', t('settings.themeDark'), MoonIcon],
    ['system', t('settings.themeSystem'), SunMoonIcon],
  ];

  return (
    <div className="h-full overflow-y-auto" data-testid="settings">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
        <div>
          <h2 className="text-lg font-semibold">{t('settings.appearance')}</h2>
          <p className="text-sm text-muted-foreground">{t('settings.appearanceHint')}</p>
        </div>
        <FieldGroup>
          <Field>
            <FieldLabel id="lang-label">{t('settings.language')}</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={0}
              aria-labelledby="lang-label"
              value={[pref]}
              onValueChange={(value) => value[0] && setPref(value[0] as LangPref)}
              data-testid="language-picker"
            >
              {LANGUAGES.map(([id, label]) => (
                <ToggleGroupItem
                  key={id}
                  value={id}
                  data-testid={`language-${id}`}
                  lang={id === 'fa' ? 'fa' : undefined}
                >
                  {label ?? t('settings.langAuto')}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <FieldDescription>{t('settings.languageHint')}</FieldDescription>
          </Field>

          <Field>
            <FieldLabel id="mode-label">{t('settings.mode')}</FieldLabel>
            <ToggleGroup
              variant="outline"
              spacing={0}
              aria-labelledby="mode-label"
              value={[mode]}
              onValueChange={(value) => value[0] && setMode(value[0] as Mode)}
              data-testid="mode-picker"
            >
              {modes.map(([id, label, Icon]) => (
                <ToggleGroupItem key={id} value={id} data-testid={`mode-${id}`}>
                  <Icon />
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <FieldSet>
            <FieldLegend variant="label">{t('settings.preset')}</FieldLegend>
            <FieldDescription>{t('settings.presetHint')}</FieldDescription>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
              {PRESETS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={preset === item.id}
                  data-testid={`preset-${item.id}`}
                  onClick={() => setPreset(item.id)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm capitalize outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                    preset === item.id && 'border-ring bg-muted',
                  )}
                >
                  <span
                    className="size-4 shrink-0 rounded-full border"
                    style={{ background: dark ? item.dark : item.light }}
                    aria-hidden="true"
                  />
                  <span className="flex-1 truncate" translate="no" dir="ltr">
                    {item.id}
                  </span>
                  {preset === item.id ? <CheckIcon className="size-4" /> : null}
                </button>
              ))}
            </div>
          </FieldSet>
        </FieldGroup>
      </div>
    </div>
  );
}
