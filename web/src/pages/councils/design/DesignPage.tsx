// The page of a council or a flow design: a slim bar (the council's name and id, the reasoning levels, the menu), the canvas and the
// inspector (docked at 19 rem from 1000 px, a sheet below). A council is drawn like a design (Input, each member, the chairman, the
// answer) and stays a council while the edits are ones a council can say; an edit it cannot (a line, a writer, a form, a prompt, a
// response minimum other than two) turns it into a design, after a question (`DesignDialog`). The page is part of the explicit
// council form: an edit stays on the page until «Save», the save bar and the leave guard are the page's own (Councils.tsx). Base
// edits the council or the design; a level shows what that level runs and changes only an agent's model, effort and on/off, for
// that level only (saved as `levels.<level>`).

import { RotateCcwIcon } from 'lucide-react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { piOnlyChairs } from '@/fa';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { noteText } from '@/i18n/notes.tsx';
import { isolate } from '@/lib/isolate';
import { useTheme } from '@/theme';
import { DEFAULT_BUDGETS } from '../../../../../src/shared/defaults.ts';
import { type Flow, flowCouncil, maxCalls } from '../../../../../src/shared/flow.ts';
import { HARNESS_RULES } from '../../../../../src/shared/harness-rules.ts';
import { REASONING_LEVELS } from '../../../../../src/shared/levels.ts';
import type { LibraryView } from '../../../../../src/shared/library.ts';
import type {
  HarnessId,
  HarnessInfo,
  LevelView,
  Meta,
  ProfileView,
  ReasoningLevel,
  SettingsFull,
} from '../../../../../src/shared/types.ts';
import { DesignDialog } from '../dialogs.tsx';
import { levelOverridesOf, same } from '../form-diff.ts';
import { ORDER, pickFor } from '../rows.tsx';
import type { CouncilForm } from '../use-council-form.ts';
import { DesignCanvas, MAX_MEMBERS, type Selection } from './Canvas.tsx';
import { councilFlow, councilIds, councilOfFlow, designOf, draftLevel } from './council.ts';
import { describeLevelProblem, describeProblem } from './describe.ts';
import {
  addAgent,
  addCondition,
  type FormDefaults,
  nodeOf,
  problemOf,
  syncAnswerRules,
} from './edit.ts';
import { type CouncilContext, Inspector } from './Inspector.tsx';
import { agentNames } from './names.ts';

/** Whether the window is at least this wide (the inspector is docked from 1000 px, a sheet below). */
function useWide(min: number): boolean {
  const query = `(min-width: ${min}px)`;
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setWide(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  return wide;
}

export function DesignPage({
  meta,
  profile,
  form,
  setForm,
  baseline,
  tab,
  readOnly,
  header,
  notices,
}: {
  meta: Meta;
  profile: ProfileView;
  form: CouncilForm;
  setForm: Dispatch<SetStateAction<CouncilForm>>;
  baseline: {
    defaults: SettingsFull;
    base: SettingsFull;
    levels: Record<ReasoningLevel, LevelView>;
  };
  tab: 'base' | ReasoningLevel;
  readOnly: boolean;
  /** The bar above the canvas: the council's name, the levels, the menu. It is told the most calls the design makes in a round. */
  header: (calls: number) => ReactNode;
  /** What must be said before editing (a level cannot be edited while Base has unsaved changes, and the other way round). */
  notices: ReactNode;
}) {
  const { t, dir, lang } = useI18n();
  const { dark } = useTheme();
  const view = meta.settings;
  const docked = useWide(1000);
  const level = tab === 'base' ? null : tab;
  /** A design has its own flow in the form; a council is drawn from its members and its chairman. */
  const design = form.base.flow !== undefined;
  /** Quick follows the speed of the assistants on this PC: it never becomes a design (a copy of it can). */
  const quick = profile.auto && profile.id === 'quick';
  const settings = level === null ? form.base : form.levels[level];
  const stored = level === null ? undefined : baseline.levels[level];

  const flow: Flow = useMemo(() => {
    if (!design) return councilFlow(settings);
    if (level === null) return form.base.flow as Flow;
    // a council turned into a design on this page and not saved yet has no design for its levels: they are drawn from it
    return (
      form.levels[level].flow ??
      draftLevel(form.base, level, (stored as LevelView).overrides, view.models).effective
    );
  }, [design, settings, level, form.base, form.levels, stored, view.models]);
  const derived: Flow | null = useMemo(() => {
    if (level === null || !stored) return null;
    if (!design) return councilFlow(stored.derived);
    return (
      stored.derived.flow ?? draftLevel(form.base, level, stored.overrides, view.models).derived
    );
  }, [design, level, stored, form.base, view.models]);
  const names = useMemo(() => agentNames(flow, t), [flow, t]);
  const infos = useMemo(
    () => new Map<HarnessId, HarnessInfo>(meta.harnesses.map((item) => [item.id, item])),
    [meta.harnesses],
  );
  const defaultIds = useMemo(
    () => new Set(baseline.defaults.seats.map((seat) => seat.id)),
    [baseline.defaults],
  );
  const chairmanId = useMemo(() => councilIds(form.base.seats).chairman, [form.base.seats]);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [sheet, setSheet] = useState(false);
  const [forms, setForms] = useState<FormDefaults | null>(null);
  /** The Library's prompts and output forms: what the pickers offer and what a condition's rules can ask about. */
  const [library, setLibrary] = useState<LibraryView | null>(null);
  /** An edit a council cannot say, waiting for the person to agree that the council becomes a design. */
  const [ask, setAsk] = useState<{ flow: Flow; select?: string } | null>(null);

  // the standard prompt and schema of each output form (the server owns them): for a new agent, and for a change of form
  useEffect(() => {
    let live = true;
    api<FormDefaults>('/flow-forms')
      .then((found) => live && setForms(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  // read again whenever another box is selected: an entry made on another page, or in another tab, is there when it is asked for
  const chosen = selected?.kind === 'node' ? selected.id : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the selection is only the moment to read again
  useEffect(() => {
    let live = true;
    api<LibraryView>('/library')
      .then((found) => live && setLibrary(found))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [chosen]);

  // a selection that no longer exists (the box was deleted, or this design does not have it) is none
  const selection =
    selected?.kind === 'node'
      ? nodeOf(flow, selected.id)
        ? selected
        : null
      : selected &&
          flow.edges.some(
            (e) => e.from === selected.from && e.to === selected.to && e.gate === selected.gate,
          )
        ? selected
        : null;

  const problem = useMemo(() => (design ? problemOf(flow) : null), [design, flow]);
  // the names inside a Persian sentence are isolated, so a Latin name does not turn the quotation marks around it
  const spoken = useMemo(
    () => Object.fromEntries(Object.entries(names).map(([id, name]) => [id, isolate(name, lang)])),
    [names, lang],
  );
  const problemText = problem
    ? level === null
      ? describeProblem(problem, flow, spoken, t, noteText)
      : describeLevelProblem(problem, flow, spoken, level, t, noteText)
    : null;

  const usable = () =>
    ORDER.find(
      (id) => !HARNESS_RULES[id].manualOnly && view.status.find((item) => item.id === id)?.usable,
    ) ?? 'claude';

  /** A change to what is drawn: a council takes it when it can say it, else asks; a design takes it as its own. */
  const change = (next: Flow) => {
    if (design && forms) next = syncAnswerRules(next, forms);
    if (!design) {
      const target = level === null ? form.base : form.levels[level];
      const keep = level === null ? [...defaultIds] : target.seats.map((seat) => seat.id);
      const fit = councilOfFlow(next, target, keep);
      if (fit) {
        setForm((current) =>
          level === null
            ? { ...current, base: fit }
            : { ...current, levels: { ...current.levels, [level]: fit } },
        );
      } else if (level === null && !quick) setAsk({ flow: next });
      return;
    }
    setForm((current) =>
      level === null
        ? { ...current, base: { ...current.base, flow: next } }
        : {
            ...current,
            levels: { ...current.levels, [level]: { ...current.levels[level], flow: next } },
          },
    );
  };

  /** The council is a design from now on (unsaved until saved): every agent has its standard prompt and form. */
  const convert = () => {
    if (!ask || !forms) return;
    const next = designOf(ask.flow, forms);
    setForm((current) => ({
      ...current,
      base: { ...current.base, flow: next, ...flowCouncil(next) },
    }));
    if (ask.select) setSelected({ kind: 'node', id: ask.select });
    setAsk(null);
  };

  /** Adds an agent to a design: it answers as a member and joins the answer of the agent that gives the final one. */
  const add = () => {
    if (!forms) return;
    const harness = usable();
    const made = addAgent(flow, { harness, ...pickFor(view, harness) }, forms);
    change(made.flow);
    setSelected({ kind: 'node', id: made.id });
    if (!docked) setSheet(true);
  };

  /** Adds a condition to a design: not joined to anything yet (it reads one agent and sends Yes or No). */
  const addCond = () => {
    const made = addCondition(flow);
    change(made.flow);
    setSelected({ kind: 'node', id: made.id });
    if (!docked) setSheet(true);
  };

  /** Adds a member to a council (a seat, as the list did). */
  const addMember = () => {
    const harness = usable();
    const id = `x${Date.now().toString(36).slice(-4)}`;
    setForm((current) => ({
      ...current,
      base: {
        ...current.base,
        seats: [
          ...current.base.seats,
          {
            id,
            enabled: true,
            harness,
            ...pickFor(view, harness),
            tools: false,
            memory: false,
            web: false,
          },
        ],
      },
    }));
    setSelected({ kind: 'node', id });
    if (!docked) setSheet(true);
  };

  /** A writer in a council: an agent that writes a report is not a member, so the council asks first. */
  const addWriter = () => {
    if (!forms || quick) return;
    const harness = usable();
    const made = addAgent(flow, { harness, ...pickFor(view, harness) }, forms, 'report');
    setAsk({ flow: made.flow, select: made.id });
  };

  const resetMember = (id: string) => {
    const was = baseline.defaults.seats.find((seat) => seat.id === id);
    if (!was) return;
    setForm((current) => ({
      ...current,
      base: {
        ...current.base,
        seats: current.base.seats.map((seat) => (seat.id === id ? was : seat)),
      },
    }));
  };

  const select = (next: Selection | null) => {
    setSelected(next);
    if (next && !docked) setSheet(true);
  };

  const baselineFlow = baseline.base.flow ?? null;
  const council: CouncilContext | null = design
    ? null
    : {
        chairmanId,
        isDefault: (id) => defaultIds.has(id),
        differs: (id) => {
          const was = baseline.defaults.seats.find((seat) => seat.id === id);
          const now = form.base.seats.find((seat) => seat.id === id);
          return was !== undefined && now !== undefined && !same(was, now);
        },
        onReset: resetMember,
        onDesign: quick ? null : () => setAsk({ flow }),
        piOnly: piOnlyChairs(form.base.chairman, form.base.seats),
      };
  const inspector = (
    <Inspector
      flow={flow}
      derived={derived}
      baseline={baselineFlow}
      names={names}
      level={level}
      selection={selection}
      view={view}
      infos={infos}
      forms={forms}
      library={library}
      onLibrary={setLibrary}
      disabled={readOnly}
      council={council}
      onChange={change}
      onSelect={select}
    />
  );

  // what this level overrides in the form now (not only in what was saved)
  const levelName = level ? t(`level.${level}` as Key) : '';
  const overrides = (() => {
    if (!level || !stored) return 0;
    const current = levelOverridesOf(stored, form.levels[level]);
    return (
      Object.keys(current.nodes ?? {}).length +
      Object.keys(current.seats ?? {}).length +
      (current.chairman ? 1 : 0)
    );
  })();
  const limits =
    form.base.budgets.maxClaims !== DEFAULT_BUDGETS.maxClaims ||
    form.base.budgets.maxWords !== DEFAULT_BUDGETS.maxWords
      ? { claims: form.base.budgets.maxClaims, words: form.base.budgets.maxWords }
      : null;

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="flow-designer"
      data-level={tab}
      data-mode={design ? 'design' : 'council'}
    >
      {header(maxCalls(flow))}
      {notices}
      {level ? (
        <div
          className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-1.5 text-xs text-muted-foreground"
          data-testid="level-note"
        >
          <span>
            {design
              ? t('flow.levelNote', { level: levelName })
              : t('councils.levelIntro', { level: levelName })}
          </span>
          <span className="ms-auto flex items-center gap-2">
            <span data-testid="level-overrides">
              {overrides === 0
                ? t('councils.noOverrides')
                : t('councils.overrides', { count: overrides })}
            </span>
            <Button
              variant="outline"
              size="xs"
              data-testid="reset-level"
              disabled={readOnly || overrides === 0}
              onClick={() =>
                setForm((current) => ({
                  ...current,
                  levels: { ...current.levels, [level]: (stored as LevelView).derived },
                }))
              }
            >
              <RotateCcwIcon />
              {t('councils.resetLevel', { level: levelName })}
            </Button>
          </span>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <DesignCanvas
            flow={flow}
            names={names}
            infos={infos}
            level={level}
            derived={derived}
            selection={selection}
            onSelect={select}
            onChange={change}
            problem={problem}
            problemText={problemText}
            onAdd={design ? (forms ? add : null) : addMember}
            onAddCondition={design ? addCond : null}
            readOnly={readOnly}
            fitKey={`${profile.id}:${tab}:${flow.nodes.length}`}
            mirror={dir === 'rtl'}
            dark={dark}
            council={!design}
            connectable={design || !quick}
            removable={(id) => design || (id !== chairmanId && !defaultIds.has(id))}
            hideEffort={!design && level === null}
            onAddWriter={!design && forms ? addWriter : null}
            memberFull={form.base.seats.length >= MAX_MEMBERS}
            note={design ? null : t(quick ? 'flow.council.noteQuick' : 'flow.council.note')}
            extra={
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                {t('councils.defaultLevel')}
                <Select
                  value={form.defaultLevel}
                  items={REASONING_LEVELS.map((item) => ({
                    value: item,
                    label: t(`level.${item}` as Key),
                  }))}
                  disabled={readOnly}
                  onValueChange={(next) =>
                    next &&
                    setForm((current) => ({ ...current, defaultLevel: next as ReasoningLevel }))
                  }
                >
                  <SelectTrigger
                    size="sm"
                    className="w-28"
                    data-testid="default-level"
                    aria-label={t('councils.defaultLevel')}
                    title={t('councils.defaultLevelHint', { id: profile.id })}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    {REASONING_LEVELS.map((item) => (
                      <SelectItem key={item} value={item}>
                        {t(`level.${item}` as Key)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </span>
            }
          />
        </div>
        {docked ? (
          <aside
            className="w-76 shrink-0 overflow-y-auto border-s bg-card/50"
            data-testid="flow-inspector"
            aria-label={t('flow.inspector')}
          >
            {inspector}
          </aside>
        ) : (
          <Sheet open={sheet && selection !== null} onOpenChange={setSheet}>
            <SheetContent
              side={dir === 'rtl' ? 'left' : 'right'}
              className="w-80 max-w-[90vw] gap-0 overflow-y-auto p-0"
              data-testid="flow-inspector-sheet"
              initialFocus={false}
            >
              <SheetHeader className="sr-only">
                <SheetTitle>{t('flow.inspector')}</SheetTitle>
                <SheetDescription>{t('flow.empty.text')}</SheetDescription>
              </SheetHeader>
              <div className="pt-8">{inspector}</div>
            </SheetContent>
          </Sheet>
        )}
      </div>
      {ask ? (
        <DesignDialog
          level={t('level.low')}
          limits={limits}
          ready={forms !== null}
          onContinue={convert}
          onCancel={() => setAsk(null)}
        />
      ) : null}
    </div>
  );
}
