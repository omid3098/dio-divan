import { chairmanOf, seatsOf } from '../../../src/shared/flow.ts';
// The details of a round, in a non-modal drawer over the map (the answer never moves): Council, Claims, Context and Cost, as
// Tabs. The identity switch lives in the Council tab and is per round: it is off whenever another round is shown.

import { CheckIcon, ChevronDownIcon, XIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Bidi, Mono, Pct } from '@/components/bidi';
import { CopyButton } from '@/components/copy-button';
import { Markdown } from '@/components/markdown';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { HARNESS_LABEL, piOnlyChairs } from '@/fa';
import { useFormat } from '@/i18n/format';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { cn } from '@/lib/utils';
import type { Detail } from '@/router';
import { chairSpend } from '@/spend';
import { buildContext } from '../../../src/shared/context.ts';
import type {
  ChairNode,
  ClaimStatus,
  ContextRow,
  SeatRun,
  SeatState,
  Session,
} from '../../../src/shared/types.ts';
import { CONTEXT_KIND, isLong, readable, WRITTEN } from './context-text.ts';

export interface DetailsState {
  tab: Detail;
  /** The member whose row is open (and a counter that changes whenever another «See member» asks for it). */
  member: { label: string; ping: number } | null;
}

/** Where the drawer sits: the box of the map column (or of the whole body when the map is a tab of its own). */
export interface Anchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

const LABELS: Record<Detail, Key> = {
  council: 'detail.council',
  claims: 'detail.claims',
  context: 'detail.context',
  cost: 'detail.cost',
};
export const DETAIL_TABS: Detail[] = ['council', 'claims', 'context', 'cost'];
/** The states a member's call can be in: the ones the interface has a word for. */
const SEAT_STATES: ReadonlySet<string> = new Set([
  'pending',
  'running',
  'done',
  'failed',
  'timeout',
  'invalid',
  'skipped',
  'blocked',
]);

// ---------- Council ----------

function Letter({ label }: { label: string }) {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted font-mono text-xs font-semibold"
      translate="no"
    >
      {label}
    </span>
  );
}

/**
 * A member's full report as Markdown (no raw HTML or links: the member's text is data), the first lines of it with «Show all»
 * when it is long. Members answer in English, so the report reads left to right.
 */
function MemberReport({ text }: { text: string }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const long = text.length > 900 || text.split('\n').length > 12;
  return (
    <div className="flex flex-col items-start gap-1" data-testid="member-report">
      <h4 className="text-xs font-medium text-muted-foreground">{t('council.report')}</h4>
      <div dir="ltr" className={cn('w-full', long && !all && 'max-h-60 overflow-hidden')}>
        <Markdown text={text} className="text-sm leading-6" />
      </div>
      {long ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={all}
          onClick={() => setAll((value) => !value)}
        >
          {all ? t('ctx.showLess') : t('ctx.showAll')}
        </button>
      ) : null}
    </div>
  );
}

function MemberRow({ chair, seat, reveal }: { chair: ChairNode; seat: SeatRun; reveal: boolean }) {
  const { t, dir } = useI18n();
  const f = useFormat();
  const score = chair.seatScores.find((entry) => entry.label === seat.label)?.score;
  const verdicts = chair.claims.filter((claim) => claim.from.includes(seat.label));
  // Hidden mode shows what the chairman saw (self-identification removed); the member's own words come with the reveal.
  const parsed = reveal ? seat.parsed : seat.sanitized;
  const duration =
    seat.startedAt && seat.endedAt
      ? new Date(seat.endedAt).getTime() - new Date(seat.startedAt).getTime()
      : null;
  const failed = seat.state !== 'done' && seat.state !== 'pending' && seat.state !== 'running';
  const facts = reveal ? (seat.parsed?.memory_facts ?? []) : [];
  return (
    <AccordionItem
      value={seat.label}
      id={`seat-${seat.label}`}
      data-state={seat.state}
      data-testid="member-row"
      className="scroll-mt-2"
    >
      <AccordionTrigger className="gap-3 px-1 hover:no-underline">
        <Letter label={seat.label} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          {reveal ? (
            // «Show names» names every member on its row, not only inside the opened one: «A · Codex fake-1 medium»
            <span
              className="flex flex-wrap items-center gap-x-1.5 text-xs font-medium"
              data-testid="seat-identity-line"
              translate="no"
            >
              {HARNESS_LABEL[seat.harness] ?? seat.harness}
              <Mono className="font-normal text-muted-foreground">{seat.model}</Mono>
              {seat.effort ? (
                <Mono className="font-normal text-muted-foreground">{seat.effort}</Mono>
              ) : null}
            </span>
          ) : null}
          {parsed ? (
            <>
              {parsed.reportOnly ? (
                // the member returned its report as plain text: it has no summary
                <span
                  className="text-start text-sm font-normal text-muted-foreground"
                  data-testid="report-only"
                >
                  {t('council.reportOnly')}
                </span>
              ) : (
                <Bidi
                  as="span"
                  text={parsed.stance}
                  className="line-clamp-2 text-start text-sm font-normal"
                />
              )}
              {parsed.recommendation ? (
                // a member that answered a lens alone may have no recommendation
                <span className="flex flex-wrap items-center gap-x-1.5 text-xs font-normal text-muted-foreground">
                  <span>{t('council.recommends')}</span>
                  <Bidi as="bdi" text={parsed.recommendation.choice} />
                  <span>·</span>
                  <Pct value={parsed.recommendation.confidence} />
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-sm font-normal text-muted-foreground">
              {failed ? f.failureLine(seat.state, seat.error) : f.seatState(seat.state, null)}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {seat.trimmed.length > 0 ? (
            <Badge variant="outline">{t('council.shortened')}</Badge>
          ) : null}
          {score !== undefined ? (
            <Badge variant="secondary" title={t('council.scoreHint')}>
              {t('council.score')} <bdi dir="ltr">{score}/10</bdi>
            </Badge>
          ) : null}
          {failed ? (
            <Badge variant="destructive">{f.seatState(seat.state, seat.error)}</Badge>
          ) : null}
        </span>
      </AccordionTrigger>
      <AccordionContent className="flex flex-col gap-3 ps-10 pe-1">
        {reveal ? (
          <p
            className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
            data-testid="seat-identity"
          >
            <span className="font-medium">{HARNESS_LABEL[seat.harness] ?? seat.harness}</span>
            <Mono>{seat.model}</Mono>
            {seat.effort ? <Mono>{seat.effort}</Mono> : null}
            {seat.harness === 'agy' ? (
              <span className="text-muted-foreground">{t('msg.agy_controlled_short')}</span>
            ) : (
              <>
                {seat.tools ? <Badge variant="outline">{t('ss.tools')}</Badge> : null}
                {seat.memory ? <Badge variant="outline">{t('ss.memory')}</Badge> : null}
                {seat.web ? <Badge variant="outline">{t('ss.web')}</Badge> : null}
              </>
            )}
          </p>
        ) : null}
        {seat.folderNote ? (
          <p className="text-xs text-muted-foreground" data-testid="folder-note">
            {t('council.noFolder')}
            {reveal ? <span dir="auto"> {seat.folderNote}</span> : null}
          </p>
        ) : null}
        {parsed?.report?.trim() ? <MemberReport text={parsed.report} /> : null}
        {parsed && parsed.claims.length > 0 ? (
          <ul className="flex flex-col gap-1.5 text-sm" dir="ltr">
            {parsed.claims.map((claim) => (
              <li key={claim.text} className="flex gap-2">
                <span className="mt-2 size-1 shrink-0 rounded-full bg-muted-foreground" />
                <span dir="ltr" className="min-w-0 flex-1">
                  {claim.text}{' '}
                  <span className="text-xs text-muted-foreground">
                    <Pct value={claim.confidence} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        {verdicts.length > 0 ? (
          <div className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-muted-foreground">{t('council.verdicts')}</h4>
            <ul className="flex flex-col gap-1 text-sm">
              {verdicts.map((claim) => (
                <li key={claim.id} className="flex items-start gap-2" data-status={claim.status}>
                  <ClaimMark status={claim.status} />
                  <Bidi as="span" text={claim.text} className="min-w-0 flex-1" />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {facts.length > 0 ? (
          <div className="flex flex-col gap-1" data-testid="memory-facts">
            <h4 className="text-xs font-medium text-muted-foreground">{t('council.facts')}</h4>
            <ul className="flex flex-col gap-1 text-sm">
              {facts.map((fact) => (
                <li key={fact.fact} dir="ltr">
                  {fact.fact} <Mono className="text-xs text-muted-foreground">{fact.source}</Mono>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {failed && !parsed ? (
          <p className="text-sm text-muted-foreground">{f.failureLine(seat.state, seat.error)}</p>
        ) : null}
        {failed && reveal && (seat.error || seat.rawOutput) ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              {t('common.details')}
            </summary>
            {seat.error ? (
              <p dir="auto" className="mt-1">
                {seat.error}
              </p>
            ) : null}
            {seat.rawOutput ? (
              <pre
                dir="ltr"
                className="mt-1 overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap"
              >
                {seat.rawOutput}
              </pre>
            ) : null}
          </details>
        ) : null}
        <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {duration !== null ? <span>{f.duration(duration)}</span> : null}
          {seat.usage ? (
            <span dir={dir}>
              {t('council.tokensInOut', {
                input: f.num(seat.usage.input),
                output: f.num(seat.usage.output),
              })}
            </span>
          ) : null}
          {seat.trimmed.length > 0 ? <span>{t('council.shortenedLong')}</span> : null}
        </p>
        {reveal && seat.rawOutput && !failed ? (
          <details className="text-xs">
            <summary className="cursor-pointer text-muted-foreground">{t('council.raw')}</summary>
            <pre
              dir="ltr"
              className="mt-1 overflow-x-auto rounded bg-muted p-2 whitespace-pre-wrap"
            >
              {seat.rawOutput}
            </pre>
          </details>
        ) : null}
      </AccordionContent>
    </AccordionItem>
  );
}

export function ClaimMark({ status }: { status: ClaimStatus }) {
  const f = useFormat();
  return (
    <span
      className={cn(
        'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px]',
        status === 'accepted' && 'bg-foreground text-background',
        status === 'rejected' && 'border-destructive text-destructive',
        status === 'open' && 'border-dashed text-muted-foreground',
      )}
      title={f.claimWord(status)}
    >
      {status === 'accepted' ? (
        <CheckIcon className="size-3" />
      ) : status === 'rejected' ? (
        <XIcon className="size-3" />
      ) : (
        '?'
      )}
      <span className="sr-only">{f.claimWord(status)}</span>
    </span>
  );
}

function CouncilTab({
  chair,
  reveal,
  onReveal,
  member,
}: {
  chair: ChairNode;
  reveal: boolean;
  onReveal: (next: boolean) => void;
  member: DetailsState['member'];
}) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useOpenMember(member);
  return (
    <div className="flex flex-col gap-4" data-testid="council-tab">
      {lang === 'fa' ? (
        // what the Persian reader is shown: the members' words are English, the chairman writes in the question's language
        <p className="text-xs text-muted-foreground" data-testid="members-english">
          {t('council.membersEnglish')}
        </p>
      ) : null}
      <Field orientation="horizontal">
        <FieldContent>
          <FieldLabel htmlFor="reveal-switch">{t('council.showNames')}</FieldLabel>
          <FieldDescription>{t('council.showNamesHint')}</FieldDescription>
        </FieldContent>
        <Switch
          id="reveal-switch"
          data-testid="reveal-switch"
          checked={reveal}
          onCheckedChange={onReveal}
          aria-label={t('council.showNamesAria')}
        />
      </Field>
      {reveal && piOnlyChairs(chairmanOf(chair), seatsOf(chair)) ? (
        <p className="text-xs text-muted-foreground" data-testid="pi-chair-note">
          {t('piOnly')}
        </p>
      ) : null}
      {reveal && chairmanOf(chair).state !== 'pending' ? (
        <p className="flex flex-wrap items-center gap-x-2 text-xs" data-testid="chairman-identity">
          <span className="text-muted-foreground">{t('ss.chairman')}</span>
          <span className="font-medium">
            {HARNESS_LABEL[chairmanOf(chair).harness] ?? chairmanOf(chair).harness}
          </span>
          <Mono>{chairmanOf(chair).model}</Mono>
          {chairmanOf(chair).effort ? <Mono>{chairmanOf(chair).effort}</Mono> : null}
        </p>
      ) : null}
      <Accordion
        value={open}
        onValueChange={(value) => setOpen(value as string[])}
        className="divide-y-0"
      >
        {seatsOf(chair).map((seat) => (
          <MemberRow key={seat.label} chair={chair} seat={seat} reveal={reveal} />
        ))}
      </Accordion>
    </div>
  );
}

/** The open member row, one at a time; «See member C» opens one and scrolls to it. */
function useOpenMember(member: DetailsState['member']) {
  const [open, setOpen] = useState<string[]>([]);
  const last = useRef(-1);
  useEffect(() => {
    if (!member || member.ping === last.current) return;
    last.current = member.ping;
    setOpen([member.label]);
    requestAnimationFrame(() =>
      document
        .getElementById(`seat-${member.label}`)
        ?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
    );
  }, [member]);
  return [open, setOpen] as const;
}

// ---------- Claims ----------

function ClaimsTab({ chair }: { chair: ChairNode }) {
  const { t } = useI18n();
  const f = useFormat();
  const answered = seatsOf(chair).filter((seat) => seat.state === 'done').length;
  const groups: ClaimStatus[] = ['accepted', 'rejected', 'open'];
  if (chair.claims.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyTitle>{t('claims.emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('claims.emptyText')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="claims-tab">
      <p className="text-xs text-muted-foreground" data-testid="claims-legend">
        {t('claims.legend')}
      </p>
      {groups.map((status) => {
        const list = chair.claims.filter((claim) => claim.status === status);
        if (list.length === 0) return null;
        return (
          <section key={status} className="flex flex-col gap-2" data-status={status}>
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {f.claimWord(status)} ({list.length})
            </h3>
            <ul className="flex flex-col gap-2">
              {list.map((claim) => (
                <li key={claim.id} className="flex items-start gap-2 text-sm">
                  <ClaimMark status={claim.status} />
                  <Bidi as="span" text={claim.text} className="min-w-0 flex-1" />
                  <span
                    className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                    title={t('claims.who')}
                  >
                    {claim.from.map((label) => (
                      <span key={label} className="rounded border px-1 font-mono" translate="no">
                        {label}
                      </span>
                    ))}
                    <span>{t('claims.count', { k: claim.from.length, n: answered })}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

// ---------- Context ----------

/** One row's text: the whole of what was written, three lines of it with «Show all» when it is longer. */
function ContextText({ row }: { row: ContextRow }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const text = readable(row, t('ctx.rulesLine'));
  const long = WRITTEN.has(row.kind) && isLong(text);
  return (
    <div className="flex flex-col items-start gap-1" data-testid={`ctx-text-${row.kind}`}>
      <Bidi
        as="span"
        text={text}
        className={cn('whitespace-pre-line', !all && 'line-clamp-3')}
        title={long ? undefined : row.text}
      />
      {long ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          aria-expanded={all}
          onClick={() => setAll((value) => !value)}
        >
          {all ? t('ctx.showLess') : t('ctx.showAll')}
        </button>
      ) : null}
    </div>
  );
}

function ContextTable({ rows, tokens }: { rows: ContextRow[]; tokens: number }) {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <Table aria-label={t('ctx.table')}>
      <TableHeader>
        <TableRow>
          <TableHead className="w-40 text-xs font-medium text-muted-foreground">
            {t('ctx.colPart')}
          </TableHead>
          <TableHead className="text-xs font-medium text-muted-foreground">
            {t('ctx.colText')}
          </TableHead>
          <TableHead className="w-16 text-end text-xs font-medium text-muted-foreground">
            {t('ctx.colTokens')}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.kind}-${row.ref}`}>
            <TableHead className="w-40 font-normal whitespace-normal text-muted-foreground">
              {t(CONTEXT_KIND[row.kind], { ref: row.ref })}
            </TableHead>
            <TableCell className="whitespace-normal">
              <ContextText row={row} />
            </TableCell>
            <TableCell className="w-16 text-end font-mono text-xs text-muted-foreground tabular-nums">
              {f.compactText(row.tokens)}
            </TableCell>
          </TableRow>
        ))}
        {(['ctx.neverRaw', 'ctx.neverBranches'] as const).map((key) => (
          <TableRow key={key} className="text-muted-foreground" data-testid="ctx-never">
            <TableHead className="w-40 font-normal whitespace-normal">{t(key)}</TableHead>
            <TableCell className="whitespace-normal">
              <span className="inline-flex items-center gap-1">
                <CheckIcon className="size-3.5" />
                {t('ctx.never')}
              </span>
            </TableCell>
            <TableCell className="w-16 text-end font-mono text-xs tabular-nums">0</TableCell>
          </TableRow>
        ))}
        <TableRow>
          <TableHead className="w-40 font-medium whitespace-normal">{t('ctx.total')}</TableHead>
          <TableCell />
          <TableCell className="w-16 text-end font-mono text-xs tabular-nums">
            ≈{f.compactText(tokens)}
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

function ExactText({ prompt, testid }: { prompt: string; testid: string }) {
  const { t } = useI18n();
  const f = useFormat();
  return (
    <Collapsible data-testid={testid}>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50">
        <span className="flex-1">{t('ctx.exact', { chars: f.num(prompt.length) })}</span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-aria-expanded:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-1 pt-2">
        <div className="flex justify-end">
          <CopyButton text={prompt} label={t('ctx.copyText')} />
        </div>
        <pre
          dir="ltr"
          className="mt-1 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
          data-testid={`${testid}-prompt`}
        >
          {prompt}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ContextTab({
  session,
  chair,
  draft,
}: {
  session: Session;
  chair: ChairNode;
  draft: string;
}) {
  const { t } = useI18n();
  // What the next round from here will receive, with the comment being typed.
  const next = useMemo(
    () =>
      chair.status === 'done'
        ? buildContext({
            nodes: session.nodes,
            rootId: session.rootId,
            fromChairId: chair.id,
            newInput: draft,
            rules: session.settings.rules,
            critiqueInstruction: session.settings.critiqueInstruction,
            background: session.background ?? null,
          })
        : null,
    [
      chair.status,
      chair.id,
      session.nodes,
      session.rootId,
      session.settings,
      session.background,
      draft,
    ],
  );
  return (
    <div className="flex flex-col gap-5" data-testid="context-tab">
      {seatsOf(chair).length > 0 ? (
        <p className="text-sm text-muted-foreground">{t('ctx.intro')}</p>
      ) : null}
      {/* the two tabs count differently: what we send is not all a member reads (its harness adds its own text) */}
      <p className="text-sm text-muted-foreground" data-testid="context-gap">
        {t('ctx.gap')}
      </p>
      {session.settings.cwd ? (
        // the folder is part of what members were given: every member read in it, in every round
        <p className="text-sm" data-testid="context-folder">
          <span className="text-muted-foreground">{t('ctx.folder')}: </span>
          <Mono className="break-all">{session.settings.cwd}</Mono>
        </p>
      ) : null}
      <section className="flex flex-col gap-2" data-testid="context-preview">
        <h3 className="text-sm font-medium">{t('ctx.thisRound')}</h3>
        <ContextTable rows={chair.context} tokens={chair.contextTokens} />
        {session.settings.flow?.kind === 'custom' && chair.steps ? (
          chair.steps.map((step) => (
            <div key={step.id}>
              <p className="text-sm font-medium">
                {t('flow.steps')} · <Mono>{step.id}</Mono>
              </p>
              <ExactText
                prompt={step.form === 'answer' ? step.run.input : (step.run.prompt ?? '')}
                testid={`context-exact-${step.id}`}
              />
            </div>
          ))
        ) : (
          <ExactText prompt={seatsOf(chair)[0]?.prompt ?? ''} testid="context-exact" />
        )}
      </section>
      {next ? (
        <section className="flex flex-col gap-2" data-testid="context-next">
          <h3 className="text-sm font-medium">{t('ctx.nextRound')}</h3>
          <ContextTable rows={next.rows} tokens={next.tokens} />
          <ExactText prompt={next.prompt} testid="context-next-exact" />
        </section>
      ) : null}
    </div>
  );
}

// ---------- Cost ----------

function CostTab({ chair, sessionUsed }: { chair: ChairNode; sessionUsed: number }) {
  const { t } = useI18n();
  const f = useFormat();
  const spend = chairSpend(chair);
  const attempts = chair.attempts ?? [];
  const duration = chair.endedAt
    ? new Date(chair.endedAt).getTime() - new Date(chair.startedAt).getTime()
    : null;
  const time = (start: string | null, end: string | null) =>
    start && end ? f.duration(new Date(end).getTime() - new Date(start).getTime()) : '—';
  const sum = (pick: (usage: { input: number; output: number; cached: number }) => number) =>
    attempts.reduce((total, attempt) => total + (attempt.usage ? pick(attempt.usage) : 0), 0);
  return (
    <div className="flex flex-col gap-4" data-testid="cost-tab">
      <Table aria-label={t('cost.table')}>
        <TableHeader>
          <TableRow>
            <TableHead>{t('cost.who')}</TableHead>
            <TableHead className="text-end">{t('cost.time')}</TableHead>
            <TableHead className="text-end">{t('cost.in')}</TableHead>
            <TableHead className="text-end">{t('cost.out')}</TableHead>
            <TableHead className="text-end">{t('cost.cached')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...attempts]
            .sort((a, b) =>
              a.kind === 'chairman'
                ? 1
                : b.kind === 'chairman'
                  ? -1
                  : (a.label ?? '').localeCompare(b.label ?? ''),
            )
            .map((attempt, index) => (
              // the same member can have more than one call (a retry), so the position is part of the key
              // biome-ignore lint/suspicious/noArrayIndexKey: calls are appended, never reordered
              <TableRow key={`${attempt.label ?? 'chair'}-${index}`}>
                <TableCell>
                  {attempt.kind === 'chairman' ? (
                    t(seatsOf(chair).length ? 'cost.chairman' : 'cost.assistant')
                  ) : (
                    <span className="font-mono" translate="no">
                      {attempt.label}
                    </span>
                  )}
                  <span className="ms-2 text-xs text-muted-foreground">
                    {attempt.kind === 'seat' && attempt.state !== 'done'
                      ? SEAT_STATES.has(attempt.state)
                        ? f.seatState(attempt.state as SeatState, attempt.error)
                        : attempt.state
                      : ''}
                  </span>
                </TableCell>
                <TableCell className="text-end font-mono text-xs tabular-nums">
                  {time(attempt.startedAt, attempt.endedAt)}
                </TableCell>
                <TableCell className="text-end font-mono text-xs tabular-nums">
                  {attempt.usage ? f.num(attempt.usage.input) : '—'}
                </TableCell>
                <TableCell className="text-end font-mono text-xs tabular-nums">
                  {attempt.usage ? f.num(attempt.usage.output) : '—'}
                </TableCell>
                <TableCell className="text-end font-mono text-xs tabular-nums">
                  {attempt.usage ? f.num(attempt.usage.cached) : '—'}
                </TableCell>
              </TableRow>
            ))}
          <TableRow className="font-medium">
            <TableCell>{t('cost.round')}</TableCell>
            <TableCell className="text-end font-mono text-xs tabular-nums">
              {duration !== null ? f.duration(duration) : '—'}
            </TableCell>
            <TableCell className="text-end font-mono text-xs tabular-nums">
              {f.num(sum((usage) => usage.input))}
            </TableCell>
            <TableCell className="text-end font-mono text-xs tabular-nums">
              {f.num(sum((usage) => usage.output))}
            </TableCell>
            <TableCell className="text-end font-mono text-xs tabular-nums">
              {f.num(sum((usage) => usage.cached))}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('cost.roundTotal')}</dt>
        <dd className="font-mono text-xs tabular-nums" dir="ltr">
          {f.num(spend.total)} {t('cost.tokens')}
          {spend.estimated ? ` (${t('cost.estimated')})` : ''}
        </dd>
        <dt className="text-muted-foreground">{t('cost.session')}</dt>
        <dd className="font-mono text-xs tabular-nums" dir="ltr">
          {f.num(sessionUsed)} {t('cost.tokens')}
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">{t('cost.hint')}</p>
    </div>
  );
}

// ---------- the drawer ----------

export function DetailsDrawer({
  open,
  onOpenChange,
  anchor,
  session,
  chair,
  state,
  onTab,
  reveal,
  onReveal,
  draft,
  sessionUsed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  anchor: Anchor | null;
  session: Session;
  chair: ChairNode;
  state: DetailsState;
  onTab: (tab: Detail) => void;
  reveal: boolean;
  onReveal: (next: boolean) => void;
  draft: string;
  sessionUsed: number;
}) {
  const { t, dir } = useI18n();
  const tabs = DETAIL_TABS.filter((tab) => tab !== 'council' || seatsOf(chair).length > 0);
  const activeTab = tabs.includes(state.tab) ? state.tab : 'context';
  const content: Record<Detail, ReactNode> = {
    council: <CouncilTab chair={chair} reveal={reveal} onReveal={onReveal} member={state.member} />,
    claims: <ClaimsTab chair={chair} />,
    context: <ContextTab session={session} chair={chair} draft={draft} />,
    cost: <CostTab chair={chair} sessionUsed={sessionUsed} />,
  };
  // The drawer slides in from the end side of the page; its box is the map's (it sits over the map, not over the answer).
  const side = dir === 'rtl' ? 'left' : 'right';
  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      modal={false}
      swipeDirection={side}
      disablePointerDismissal
    >
      <DrawerContent
        data-testid="details-drawer"
        className="rounded-none border bg-background after:hidden data-[swipe-axis=x]:inset-y-auto"
        style={
          anchor
            ? {
                top: anchor.top,
                left: anchor.left,
                width: anchor.width,
                height: anchor.height,
                right: 'auto',
                bottom: 'auto',
                ['--drawer-content-width' as string]: `${anchor.width}px`,
                ['--drawer-content-height' as string]: `${anchor.height}px`,
              }
            : undefined
        }
      >
        <DrawerHeader className="flex-row items-start justify-between gap-2 p-4 pb-2">
          <div className="flex flex-col gap-0.5">
            <DrawerTitle data-testid="details-title">
              {t('detail.title', { n: chair.round })}
            </DrawerTitle>
            <DrawerDescription className="sr-only">{t('detail.description')}</DrawerDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common.close')}
            data-testid="details-close"
            onClick={() => onOpenChange(false)}
          >
            <XIcon />
          </Button>
        </DrawerHeader>
        <Tabs
          value={activeTab}
          onValueChange={(value) => onTab(value as Detail)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="px-4">
            <TabsList className="w-full">
              {tabs.map((tab) => (
                <TabsTrigger key={tab} value={tab} data-testid={`detail-tab-${tab}`}>
                  {t(LABELS[tab])}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
          {tabs.map((tab) => (
            <TabsContent
              key={tab}
              value={tab}
              className="min-h-0 flex-1 overflow-y-auto p-4"
              data-testid={`detail-panel-${tab}`}
            >
              {tab === activeTab ? content[tab] : null}
            </TabsContent>
          ))}
        </Tabs>
      </DrawerContent>
    </Drawer>
  );
}
