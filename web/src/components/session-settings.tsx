// "Session settings": the settings a session was started with, read-only. They were fixed when the session started.

import { LockIcon } from 'lucide-react';
import { useState } from 'react';
import { Bidi, Mono } from '@/components/bidi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { HARNESS_LABEL, piOnlyChairs } from '@/fa';
import { useI18n } from '@/i18n/index.tsx';
import { useNotes } from '@/i18n/notes.tsx';
import { finalAgent, isDirectAnswer, orderedAgents } from '../../../src/shared/flow.ts';
import { note } from '../../../src/shared/messages.ts';
import type { Session } from '../../../src/shared/types.ts';

export function SessionSettings({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const noted = useNotes();
  const { settings } = session;
  const flow = settings.flow?.kind === 'custom' ? settings.flow : undefined;
  const final = settings.flow ? finalAgent(settings.flow) : undefined;
  const access =
    (final?.harness ?? settings.chairman.harness) === 'agy'
      ? noted.node(note('agy_controlled_note'))
      : final || settings.chairman.tools !== undefined
        ? t('ss.chairmanAccess', {
            tools: t((final?.tools ?? settings.chairman.tools) ? 'common.on' : 'common.off'),
            memory: t((final?.memory ?? settings.chairman.memory) ? 'common.on' : 'common.off'),
          })
        : t(settings.chairman.memory === true ? 'ss.chairmanMemory' : 'ss.chairmanPlain');
  const members = flow
    ? orderedAgents(flow).map((agent) => ({ ...agent, enabled: agent.enabled !== false }))
    : settings.seats.map((seat) => ({ ...seat, role: 'member' as const }));
  const [showRules, setShowRules] = useState(false);
  const flag = (label: string, on: boolean) => (
    <span key={label} className="text-xs text-muted-foreground" data-on={on || undefined}>
      {label} {on ? t('common.on') : t('common.off')}
    </span>
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85svh] gap-4 overflow-y-auto sm:max-w-xl"
        data-testid="session-settings"
      >
        <DialogHeader>
          {members.some((member) => member.harness === 'hermes') ||
          (final?.harness ?? settings.chairman.harness) === 'hermes' ? (
            <p className="text-xs text-muted-foreground">
              {noted.node(note('hermes_tools_note'))} {noted.node(note('hermes_usage'))}
            </p>
          ) : null}
          <DialogTitle>{t('header.sessionSettings')}</DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <LockIcon className="size-3.5" />
            {t('ss.locked')}
          </DialogDescription>
        </DialogHeader>
        {members.some((seat) => seat.harness === 'agy') ||
        (final?.harness ?? settings.chairman.harness) === 'agy' ? (
          <p className="text-sm" data-testid="agy-warning">
            {noted.node(note('agy_warning'))}
          </p>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('ss.question')}
          </h3>
          <Bidi as="p" text={settings.question} className="text-sm whitespace-pre-wrap" />
        </section>

        {settings.cwd ? (
          <section className="flex flex-col gap-1.5" data-testid="ss-folder">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('ss.folder')}
            </h3>
            <Mono className="text-sm break-all" data-testid="ss-folder-path">
              {settings.cwd}
            </Mono>
            <p className="text-xs text-muted-foreground">{t('home.folderSet')}</p>
          </section>
        ) : null}

        {settings.level ? (
          <section className="flex items-center gap-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('level.label')}
            </h3>
            <Badge variant="secondary" data-testid="ss-level">
              {t(`level.${settings.level}`)}
            </Badge>
          </section>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {flow ? t('flow.steps') : t('ss.members')}
          </h3>
          <ul className="flex flex-col divide-y rounded-lg border" data-testid="session-seats">
            {members.map((seat) => (
              <li
                key={seat.id}
                className="flex flex-col gap-1 px-3 py-2 text-sm"
                data-off={!seat.enabled || undefined}
              >
                <span className="flex flex-wrap items-center gap-x-2">
                  {flow ? <span>{t(`flow.role.${seat.role}`)}</span> : null}
                  <span className="font-medium" translate="no">
                    {HARNESS_LABEL[seat.harness] ?? seat.harness}
                  </span>
                  <Mono>{seat.model || '—'}</Mono>
                  {seat.effort ? (
                    <Mono className="text-muted-foreground">{seat.effort}</Mono>
                  ) : null}
                  {seat.enabled ? null : <Badge variant="outline">{t('common.off')}</Badge>}
                </span>
                <span className="flex flex-wrap gap-x-3">
                  {seat.harness === 'agy' ? (
                    <span className="text-xs text-muted-foreground">
                      {noted.node(note('agy_controlled_note'))}
                    </span>
                  ) : (
                    <>
                      {flag(t('ss.tools'), seat.tools)}
                      {flag(t('ss.memory'), seat.memory)}
                      {flag(t('ss.web'), seat.web)}
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {flow ? <p className="text-xs text-muted-foreground">{access}</p> : null}
        </section>

        {!flow ? (
          <section className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('ss.chairman')}
            </h3>
            <p className="flex flex-wrap items-center gap-x-2 text-sm">
              <span className="font-medium" translate="no">
                {HARNESS_LABEL[settings.chairman.harness] ?? settings.chairman.harness}
              </span>
              <Mono>{settings.chairman.model}</Mono>
              {settings.chairman.effort ? (
                <Mono className="text-muted-foreground">{settings.chairman.effort}</Mono>
              ) : null}
            </p>
            <p className="text-xs text-muted-foreground">{access}</p>
            {piOnlyChairs(settings.chairman, settings.seats) ? (
              <p className="text-xs text-muted-foreground" data-testid="pi-chair-note">
                {t('piOnly')}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="flex flex-col gap-1.5">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t('ss.format')}
          </h3>
          <p className="text-sm">
            {t('ss.formatLine', {
              claims: settings.budgets.maxClaims,
              words: settings.budgets.maxWords,
            })}
          </p>
        </section>

        <Button
          variant="link"
          size="sm"
          className="self-start px-0"
          onClick={() => setShowRules((value) => !value)}
        >
          {showRules ? t('ss.hideRules') : t('ss.showRules')}
        </Button>
        {showRules ? (
          <section className="flex flex-col gap-2">
            {flow ? (
              orderedAgents(flow).map((agent) => (
                <div key={agent.id}>
                  <p className="text-sm">
                    {t(`flow.role.${isDirectAnswer(agent) ? 'assistant' : agent.role}`)} ·{' '}
                    <Mono>{agent.id}</Mono>
                  </p>
                  <pre
                    dir="ltr"
                    className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
                  >
                    {agent.rules}
                  </pre>
                  <pre
                    dir="ltr"
                    className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs"
                  >
                    {JSON.stringify(agent.schema, null, 2)}
                  </pre>
                </div>
              ))
            ) : (
              <>
                <pre
                  dir="ltr"
                  className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap"
                >
                  {settings.rules}
                </pre>
                <pre
                  dir="ltr"
                  className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs"
                >
                  {JSON.stringify(settings.memberSchema, null, 2)}
                </pre>
              </>
            )}
          </section>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
