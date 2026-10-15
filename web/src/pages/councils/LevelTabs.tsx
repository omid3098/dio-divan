// The tabs of a council: Base (where the council or the design is made) and the four reasoning levels (what each level derives from
// it, and what is overridden there). A tab that can only be read until the other one is saved or discarded says so.

import { Fragment } from 'react';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { type Key, useI18n } from '@/i18n/index.tsx';
import type { CouncilTab } from '@/router';
import { REASONING_LEVELS } from '../../../../src/shared/levels.ts';
import type { ReasoningLevel } from '../../../../src/shared/types.ts';

export const TABS: CouncilTab[] = ['base', ...REASONING_LEVELS];

export function LevelTabs({
  tab,
  onTab,
  baseDirty,
  anyLevelDirty,
  levelDirty,
  className,
}: {
  tab: CouncilTab;
  onTab: (next: CouncilTab) => void;
  baseDirty: boolean;
  anyLevelDirty: boolean;
  levelDirty: Record<ReasoningLevel, boolean>;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => onTab(value as CouncilTab)}
      data-testid="level-tabs"
      className={className}
    >
      <TabsList className="w-full sm:w-fit" aria-label={t('level.label')}>
        {TABS.map((item) => (
          <Fragment key={item}>
            <TabsTrigger
              value={item}
              data-testid={`tab-${item}`}
              className="gap-1.5"
              title={
                item === 'base'
                  ? anyLevelDirty
                    ? t('councils.levelsFirstTip')
                    : undefined
                  : baseDirty
                    ? t('councils.baseFirstTip')
                    : undefined
              }
            >
              {item === 'base' ? t('level.base') : t(`level.${item}` as Key)}
              {item === 'base' ? (
                baseDirty ? (
                  <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />
                ) : null
              ) : levelDirty[item] ? (
                <span className="size-1.5 rounded-full bg-foreground" aria-hidden="true" />
              ) : null}
            </TabsTrigger>
            {/* Base is where the four levels come from, not a fifth level */}
            {item === 'base' ? (
              <Separator orientation="vertical" className="mx-1 h-4 self-center" />
            ) : null}
          </Fragment>
        ))}
      </TabsList>
    </Tabs>
  );
}
