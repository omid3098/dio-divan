// The settings of a council or a design that no box holds, in a sheet opened from the bar: what the council is for, the limits of a
// member's answer (a council), the assistants this PC cannot use with «Check again», and «Back to Divan's defaults». They are the
// parts of the old list-style editor that belong to the whole council and not to one member, so they are reachable whatever is
// selected on the canvas and at any width.

import { RefreshCwIcon, RotateCcwIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { HARNESS_LABEL } from '@/fa';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { useNotes } from '@/i18n/notes.tsx';
import type { Budgets, ProfileView, SettingsView } from '../../../../../src/shared/types.ts';
import type { CouncilForm } from '../use-council-form.ts';

const FIELDS: [keyof Budgets, Key, Key][] = [
  ['maxClaims', 'councils.maxClaims', 'councils.maxClaimsHint'],
  ['maxWords', 'councils.maxWords', 'councils.maxWordsHint'],
];

export function CouncilSettings({
  open,
  onOpenChange,
  profile,
  view,
  form,
  setForm,
  design,
  readOnly,
  frozen,
  overridden,
  checking,
  onCheck,
  onReset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: ProfileView;
  view: SettingsView;
  form: CouncilForm;
  setForm: Dispatch<SetStateAction<CouncilForm>>;
  design: boolean;
  readOnly: boolean;
  frozen: boolean;
  /** There is something saved to take away (a change, a level change, a design). */
  overridden: boolean;
  checking: boolean;
  onCheck: () => void;
  onReset: () => void;
}) {
  const { t, dir } = useI18n();
  const noted = useNotes();
  const unusable = view.status.filter((item) => !item.usable);
  const setBudget = (key: keyof Budgets, raw: string) => {
    const value = Number(raw);
    setForm((current) => ({
      ...current,
      base: {
        ...current.base,
        budgets: { ...current.base.budgets, [key]: Number.isFinite(value) ? value : 0 },
      },
    }));
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side={dir === 'rtl' ? 'left' : 'right'}
        className="w-96 max-w-[92vw] gap-0 overflow-y-auto p-0"
        data-testid="council-settings-sheet"
        initialFocus={false}
      >
        <SheetHeader>
          <SheetTitle>{t(design ? 'flow.settings.titleDesign' : 'flow.settings.title')}</SheetTitle>
          <SheetDescription data-testid="profile-more-text">
            {t('councils.sharedNote')}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          <div className="flex flex-col gap-1 text-sm">
            <p data-testid="profile-describe">
              {t(design ? 'flow.settings.purposeDesign' : 'councils.purpose')}
            </p>
            <p className="text-muted-foreground">
              {profile.auto
                ? profile.id === 'quick'
                  ? t('councils.describeQuick')
                  : t('councils.describeDefault')
                : profile.base === 'quick'
                  ? t('councils.describeCustomQuick')
                  : t('councils.describeCustom')}
              {profile.auto ? ` ${t('councils.autoMeaning')}` : ''}
            </p>
          </div>

          {design ? null : (
            <section className="flex flex-col gap-3" aria-labelledby="settings-format">
              <h3 id="settings-format" className="text-sm font-medium">
                {t('councils.format')}
              </h3>
              <div className="grid gap-4 rounded-lg border p-4">
                <Field>
                  <FieldLabel>{t('councils.template')}</FieldLabel>
                  <p className="flex h-8 items-center text-sm" data-testid="template">
                    {t('councils.templateName')}
                  </p>
                </Field>
                {FIELDS.map(([key, label, hint]) => (
                  <Field key={key}>
                    <FieldLabel htmlFor={`budget-${key}`}>{t(label)}</FieldLabel>
                    <Input
                      id={`budget-${key}`}
                      data-testid={`budget-${key}`}
                      type="number"
                      inputMode="numeric"
                      dir="ltr"
                      className="font-mono"
                      disabled={readOnly}
                      value={form.base.budgets[key]}
                      onChange={(event) => setBudget(key, event.target.value)}
                    />
                    <FieldDescription>{t(hint)}</FieldDescription>
                  </Field>
                ))}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-2" aria-labelledby="settings-assistants">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="settings-assistants" className="text-sm font-medium">
                {t('flow.settings.assistants')}
              </h3>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={checking}
                      onClick={onCheck}
                      data-testid="recheck"
                    />
                  }
                >
                  <RefreshCwIcon className={checking ? 'animate-spin' : undefined} />
                  {checking ? t('councils.checking') : t('councils.recheck')}
                </TooltipTrigger>
                <TooltipContent>{t('councils.recheckHint')}</TooltipContent>
              </Tooltip>
            </div>
            {unusable.length > 0 ? (
              // the assistants this PC cannot use, in one line with the reason of each (not as members of the list)
              <p className="text-xs text-muted-foreground" data-testid="unusable">
                <b>{t('councils.unusableTitle')}</b>{' '}
                {unusable.map((item, index) => (
                  <span key={item.id}>
                    {index > 0 ? '; ' : ''}
                    <span translate="no">{HARNESS_LABEL[item.id]}</span> (
                    {item.note ? noted.node(item.note) : t('councils.unusable.other')})
                  </span>
                ))}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{t('flow.settings.allUsable')}</p>
            )}
          </section>

          <section
            className="flex flex-col gap-3 rounded-lg border border-destructive/30 p-4"
            aria-labelledby="danger-heading"
          >
            <h3 id="danger-heading" className="text-sm font-medium">
              {t('councils.danger')}
            </h3>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                variant="destructive"
                size="sm"
                data-testid="reset-profile"
                disabled={frozen || !overridden}
                onClick={onReset}
              >
                <RotateCcwIcon />
                {t('councils.resetDefaults')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t(design ? 'flow.settings.resetHintDesign' : 'councils.resetHint')}
              </span>
            </div>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
