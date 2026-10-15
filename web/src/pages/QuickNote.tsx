// What the user is told about the Quick council: it picks the three fastest assistants on this PC, so it can change as their
// speed changes, and when it is not what the user saw last time, which assistant replaced which. The last roster seen is kept in
// this browser (`quick-roster.ts`); «Got it» makes the current one the one seen.

import { useEffect, useState } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { HARNESS_LABEL } from '@/fa';
import { useI18n } from '@/i18n/index.tsx';
import type { HarnessId, ProfileView, SettingsView } from '../../../src/shared/types.ts';
import {
  needsRosterBaseline,
  type QuickRoster,
  readSeen,
  rosterChange,
  rosterOf,
  writeSeen,
} from './quick-roster.ts';

export function QuickNote({
  profile,
  speeds,
}: {
  profile: ProfileView;
  speeds: SettingsView['speeds'];
}) {
  const { t, lang } = useI18n();
  // the automatic Quick is the council that follows the speeds; one built on it has members of its own
  const auto = profile.auto && profile.id === 'quick';
  const now = rosterOf(profile, speeds);
  const [seen, setSeen] = useState<QuickRoster | null>(readSeen);
  // First visits and unchanged legacy rosters learn the current models without a notice.
  const first = auto && needsRosterBaseline(seen, now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a missing model baseline is written here; a change waits for «Got it»
  useEffect(() => {
    if (!first) return;
    writeSeen(now);
    setSeen(now);
  }, [first]);
  const change = auto && seen ? rosterChange(seen, now) : null;

  const name = (harness: HarnessId) => HARNESS_LABEL[harness] ?? harness;
  const list = (items: string[]) =>
    items
      .map((item) => {
        const [harness, model] = item.split('|');
        return `${name(harness as HarnessId)} (${model ?? t('quick.modelUnknown')})`;
      })
      .join(lang === 'fa' ? '، ' : ', ');
  const sentence = (() => {
    if (!change) return '';
    const one = change.added.length === 1 && change.removed.length === 1;
    const params = { now: list(change.added), before: list(change.removed) };
    if (one && change.reason?.kind === 'slower') {
      return t('quick.changedSlower', { ...params, who: name(change.reason.harness) });
    }
    if (one && change.reason?.kind === 'faster') {
      return t('quick.changedFaster', { ...params, who: name(change.reason.harness) });
    }
    if (change.added.length === 0) return t('quick.changedOnlyRemoved', params);
    if (change.removed.length === 0) return t('quick.changedOnlyAdded', params);
    return t(one ? 'quick.changed' : 'quick.changedMany', params);
  })();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground" data-testid="quick-line">
        {t('quick.line', { n: now.members.length })}
      </p>
      {change ? (
        <Alert data-testid="quick-roster-note">
          <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{sentence}</span>
            <Button
              variant="outline"
              size="xs"
              data-testid="quick-roster-ok"
              onClick={() => {
                writeSeen(now);
                setSeen(now);
              }}
            >
              {t('quick.gotIt')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
