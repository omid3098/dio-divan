// The inspector of a design or a council: what is selected, edited. An agent on Base: its name, whether it takes part, what it
// receives (the conversation, a draft it must have, the group of answers it waits for), its assistant, model and effort, its access
// (always read-only), its output form and its system prompt. In a council (`council`) the name, the form and the prompt are the
// standard ones: they are said, not edited, and a button turns the council into a design; the base council has no effort of its own
// (each level sets it). At a level only what a level can change: whether the agent takes part, its model and its effort. Input and
// Output say what they are; a line says what it carries (and which of its fields, and how the agent it reaches uses it) and can be
// deleted; a condition has its own panel (ConditionPanel). Docked from 1000 px, a sheet below (see DesignPage).

import {
  CheckIcon,
  InfoIcon,
  LockIcon,
  MinusIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Toggle } from '@/components/ui/toggle';
import { HARNESS_LABEL } from '@/fa';
import { hasKey, type Key, useI18n } from '@/i18n/index.tsx';
import { useNotes } from '@/i18n/notes.tsx';
import { isolate } from '@/lib/isolate';
import { cn } from '@/lib/utils';
import { pickEffort } from '../../../../../src/shared/defaults.ts';
import type { Flow, FlowAgent } from '../../../../../src/shared/flow.ts';
import { heldValue, TOGGLE_KEYS, type ToggleKey } from '../../../../../src/shared/harness-rules.ts';
import type { LibraryView } from '../../../../../src/shared/library.ts';
import { note } from '../../../../../src/shared/messages.ts';
import type {
  HarnessId,
  HarnessInfo,
  ReasoningLevel,
  SettingsView,
} from '../../../../../src/shared/types.ts';
import { toggleText } from '../harness-text.ts';
import { EffortSelect, HarnessSelect, ModelSelect, OriginBadge, pickFor } from '../rows.tsx';
import type { Selection } from './Canvas.tsx';
import { ConditionPanel } from './ConditionPanel.tsx';
import { EdgePanel } from './EdgePanel.tsx';
import {
  agentOf,
  type FormDefaults,
  feedersOf,
  isCondition,
  nodeOf,
  patchAgent,
  removeNode,
  setLabel,
  setMinimum,
} from './edit.ts';
import { INITIALS } from './names.ts';
import { Heading, Row } from './parts.tsx';
import { FormPicker, PromptPicker } from './pickers.tsx';

/** What the inspector needs to know when the flow is a council (not a design). */
export interface CouncilContext {
  /** The box of the chairman. */
  chairmanId: string;
  /** A member the profile's defaults have: it is reset or switched off, not removed. */
  isDefault: (id: string) => boolean;
  /** Whether the member differs from the profile's defaults. */
  differs: (id: string) => boolean;
  onReset: (id: string) => void;
  /** Asks to turn the council into a design (null: it cannot become one, as Quick). */
  onDesign: (() => void) | null;
  /** Pi is the chairman and has no seat among the members. */
  piOnly: boolean;
}

export interface InspectorProps {
  flow: Flow;
  /** The level's flow as it is derived (at a level), to say what was changed and to go back to it. */
  derived: Flow | null;
  /** The design as last saved (on Base), for undoing a change of the prompt. */
  baseline: Flow | null;
  names: Record<string, string>;
  level: ReasoningLevel | null;
  selection: Selection | null;
  view: SettingsView;
  infos: Map<HarnessId, HarnessInfo>;
  forms: FormDefaults | null;
  /** The Library's prompts and output forms (null while they load or when they could not be read). */
  library: LibraryView | null;
  /** An entry was made from a picker: the Library as it is now. */
  onLibrary: (next: LibraryView) => void;
  disabled: boolean;
  /** Set when the flow is a council. */
  council: CouncilContext | null;
  onChange: (next: Flow) => void;
  onSelect: (next: Selection | null) => void;
}

/** The model of an agent changed: the effort stays when the new model offers it, else it is that model's own. */
function modelPatch(view: SettingsView, agent: FlowAgent, model: string): Partial<FlowAgent> {
  const info = view.models
    .find((item) => item.harness === agent.harness)
    ?.models.find((m) => m.id === model);
  return {
    model,
    effort: info
      ? info.efforts.includes(agent.effort)
        ? agent.effort
        : pickEffort(info)
      : agent.effort,
  };
}

export function Inspector(props: InspectorProps) {
  const { flow, selection, level } = props;
  const { t } = useI18n();
  const node = selection?.kind === 'node' ? nodeOf(flow, selection.id) : undefined;
  if (selection?.kind === 'edge')
    return (
      <EdgePanel
        key={`${selection.from}:${selection.gate ?? ''}>${selection.to}`}
        flow={flow}
        edge={selection}
        names={props.names}
        level={level}
        disabled={props.disabled}
        onChange={props.onChange}
        onSelect={props.onSelect}
      />
    );
  if (!node)
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center"
        data-testid="inspector-empty"
      >
        <span className="text-sm font-medium">{t('flow.empty.title')}</span>
        <span className="text-xs text-muted-foreground">{t('flow.empty.text')}</span>
      </div>
    );
  if (isCondition(node))
    return (
      <ConditionPanel
        key={node.id}
        flow={flow}
        node={node}
        names={props.names}
        readOnly={props.disabled || level !== null}
        onChange={props.onChange}
        onSelect={props.onSelect}
      />
    );
  if (node.kind !== 'agent')
    return (
      <div className="flex flex-col gap-3 p-4" data-testid="inspector-io">
        <Heading>{t(node.kind === 'input' ? 'flow.input.name' : 'flow.output.name')}</Heading>
        <p className="text-sm text-muted-foreground">
          {t(node.kind === 'input' ? 'flow.inputInfo' : 'flow.outputInfo')}
        </p>
      </div>
    );
  return level === null ? (
    <BasePanel {...props} agent={node} />
  ) : (
    <LevelPanel {...props} agent={node} level={level} />
  );
}

// ---------- an agent on Base ----------

function BasePanel(props: InspectorProps & { agent: FlowAgent }) {
  const { agent, flow, view, infos, forms, disabled, names, council, library } = props;
  const { t, lang } = useI18n();
  const noted = useNotes();
  const info = infos.get(agent.harness);
  const gates = flow.edges.filter((edge) => edge.to === agent.id && edge.gate);
  const feeders = feedersOf(flow, agent.id);
  const patch = (next: Partial<FlowAgent>) => props.onChange(patchAgent(flow, agent.id, next));
  const feedsOutput = flow.edges.some(
    (edge) => edge.from === agent.id && nodeOf(flow, edge.to)?.kind === 'output',
  );
  const group = agent.responses;
  const groupOn = group ? group.ids.filter((id) => agentOf(flow, id)?.enabled !== false).length : 0;
  const isChairman = council !== null && agent.id === council.chairmanId;
  /** A council's box: its name, form and prompt are the standard ones, and the base council has no effort of its own. */
  const standard = council !== null;
  const keys: ToggleKey[] = isChairman ? ['tools', 'memory'] : [...TOGGLE_KEYS];
  const listed = view.models.find((item) => item.harness === agent.harness);
  return (
    <div className="flex flex-col gap-5 p-4" data-testid="inspector-agent" data-agent-id={agent.id}>
      <div className="flex items-center gap-2">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted font-mono text-xs font-semibold"
          translate="no"
        >
          {INITIALS[agent.harness] ?? '??'}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          {standard ? (
            <span
              className="truncate px-1 text-sm font-semibold"
              dir="auto"
              data-testid="agent-title"
            >
              {names[agent.id]}
            </span>
          ) : (
            <Input
              value={agent.label ?? ''}
              placeholder={names[agent.id] ?? t('flow.name.placeholder')}
              aria-label={t('flow.name')}
              data-testid="agent-name"
              dir="auto"
              maxLength={40}
              disabled={disabled}
              className="h-7 border-transparent bg-transparent px-1 text-sm font-semibold shadow-none hover:border-input focus-visible:border-ring"
              onChange={(event) => props.onChange(setLabel(flow, agent.id, event.target.value))}
              onBlur={(event) => {
                const clean = event.target.value.replace(/\s+/gu, ' ').trim();
                if (clean !== (agent.label ?? '')) props.onChange(setLabel(flow, agent.id, clean));
              }}
            />
          )}
          <span className="px-1 text-xs text-muted-foreground">
            {hasKey(`flow.agentLine.${agent.form}`)
              ? t(`flow.agentLine.${agent.form}` as Key)
              : (agent.formInfo?.name ?? agent.form)}
          </span>
        </div>
        {isChairman ? null : council?.isDefault(agent.id) ? (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="agent-reset"
            aria-label={t('councils.resetSeat')}
            title={t('councils.resetSeat')}
            disabled={disabled || !council.differs(agent.id)}
            onClick={() => council.onReset(agent.id)}
          >
            <RotateCcwIcon />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            data-testid="agent-delete"
            aria-label={t(council ? 'councils.removeSeat' : 'flow.deleteAgent')}
            title={t(council ? 'councils.removeSeat' : 'flow.deleteAgent')}
            disabled={disabled}
            onClick={() => {
              props.onChange(removeNode(flow, agent.id));
              props.onSelect(null);
            }}
          >
            <Trash2Icon />
          </Button>
        )}
      </div>

      {agent.form !== 'answer' ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={agent.enabled !== false}
              disabled={disabled}
              data-testid="agent-on"
              onCheckedChange={(enabled) => patch({ enabled })}
              aria-label={t('flow.base.takesPart')}
            />
            {t('flow.base.takesPart')}
          </div>
          {agent.enabled === false ? (
            <p className="text-xs text-muted-foreground">{t('flow.base.off')}</p>
          ) : null}
          {council?.isDefault(agent.id) ? (
            <p className="text-xs text-muted-foreground">{t('flow.council.defaultMember')}</p>
          ) : null}
        </div>
      ) : null}

      <section className="flex flex-col gap-2" aria-labelledby="in-receives">
        <h3 id="in-receives" className="text-sm font-semibold">
          {t('flow.receives')}
        </h3>
        <p className="flex items-start gap-1.5 text-xs">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span>
            {t('flow.receives.context')}{' '}
            <span className="text-muted-foreground">· {t('flow.receives.contextNote')}</span>
          </span>
        </p>
        {gates.map((edge) => (
          <p key={`${edge.from}:${edge.gate}`} className="text-xs" data-testid="receives-gate">
            {t(edge.gate === 'yes' ? 'flow.receives.gateYes' : 'flow.receives.gateNo', {
              name: isolate(names[edge.from] ?? edge.from, lang),
            })}
          </p>
        ))}
        {feeders.length === 0 ? (
          <p className="text-xs">
            {t('flow.receives.question')}{' '}
            <span className="text-muted-foreground">· {t('flow.receives.questionNote')}</span>
          </p>
        ) : null}
        {agent.required.map((id) => (
          <p key={id} className="text-xs" data-testid="receives-draft">
            {t('flow.receives.draft', { name: names[id] ?? id })}{' '}
            <span className="text-muted-foreground">· {t('flow.receives.draftNote')}</span>
          </p>
        ))}
        {group ? (
          <div
            className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3"
            data-testid="response-group"
          >
            <span className="text-sm font-medium">
              {t('flow.group.title', { count: group.ids.length })}
            </span>
            <div className="flex items-center gap-2 text-sm">
              <span>{t('flow.group.use')}</span>
              <span className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={t('flow.group.fewer')}
                  data-testid="group-fewer"
                  disabled={disabled || group.min <= 1 || (standard && !council?.onDesign)}
                  onClick={() => props.onChange(setMinimum(flow, agent.id, group.min - 1))}
                >
                  <MinusIcon />
                </Button>
                <span className="w-5 text-center font-mono" data-testid="group-min">
                  {group.min}
                </span>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label={t('flow.group.more')}
                  data-testid="group-more"
                  disabled={
                    disabled || group.min >= group.ids.length || (standard && !council?.onDesign)
                  }
                  onClick={() => props.onChange(setMinimum(flow, agent.id, group.min + 1))}
                >
                  <PlusIcon />
                </Button>
              </span>
              <span className="text-muted-foreground">{t('flow.group.of', { n: groupOn })}</span>
            </div>
            <p className="text-xs text-muted-foreground">{t('flow.group.anonymous')}</p>
            <p className="text-xs text-muted-foreground">
              {t('flow.group.rule', { min: group.min })}
            </p>
            {standard ? (
              <p className="text-xs text-muted-foreground">{t('flow.council.minimum')}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="in-assistant">
        <h3 id="in-assistant" className="text-sm font-semibold">
          {t('flow.runsOn')}
        </h3>
        <Row label={t('councils.assistant')}>
          <HarnessSelect
            view={view}
            id="agent-harness"
            value={agent.harness}
            disabled={disabled}
            className="w-full"
            onChange={(harness) => patch({ harness, ...pickFor(view, harness) })}
          />
        </Row>
        <Row label={t('councils.model')}>
          <ModelSelect
            view={view}
            harness={agent.harness}
            model={agent.model}
            idPrefix="agent"
            disabled={disabled}
            className="w-full"
            onChange={(next) => patch(modelPatch(view, agent, next.model))}
          />
        </Row>
        {standard ? (
          <p className="text-xs text-muted-foreground" data-testid="no-base-effort">
            {t('flow.council.noEffort')}
          </p>
        ) : (
          <Row label={t('level.caption')}>
            <EffortSelect
              view={view}
              harness={agent.harness}
              model={agent.model}
              effort={agent.effort}
              idPrefix="agent"
              disabled={disabled}
              className="w-full"
              onChange={(effort) => patch({ effort })}
            />
          </Row>
        )}
        {listed?.listed === false && listed.note ? (
          <p className="text-xs text-muted-foreground">{noted.node(listed.note)}</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2" aria-labelledby="in-access">
        {agent.harness === 'agy' ? (
          <p className="text-xs" data-testid="agy-warning">
            {noted.node(note('agy_warning'))}
          </p>
        ) : null}
        <Heading
          aside={
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              {agent.harness === 'agy' ? (
                noted.node(note('agy_unenforced'))
              ) : (
                <>
                  <LockIcon className="size-3" />
                  {t('flow.access.readonly')}
                </>
              )}
            </span>
          }
        >
          <span id="in-access">{t('flow.access')}</span>
        </Heading>
        <div className="flex flex-wrap gap-1.5">
          {keys.map((key) => (
            <AccessToggle
              key={key}
              name={key}
              agent={agent}
              info={info}
              disabled={disabled}
              onChange={(value) => patch({ [key]: value })}
            />
          ))}
        </div>
        {isChairman && agent.harness !== 'agy' ? (
          <p className="text-xs text-muted-foreground">{t('councils.chairmanHint')}</p>
        ) : null}
        {council && !isChairman && !council.isDefault(agent.id) ? (
          <p className="text-xs text-muted-foreground" data-testid="access-hint">
            {t('councils.accessHint')}
          </p>
        ) : null}
        {isChairman && council?.piOnly ? (
          <p className="text-xs text-muted-foreground" data-testid="pi-chair-note">
            {t('piOnly')}
          </p>
        ) : null}
        <AccessNotes agent={agent} info={info} keys={keys} />
      </section>

      {standard ? (
        <section className="flex flex-col gap-2" aria-labelledby="in-standard">
          <h3 id="in-standard" className="text-sm font-semibold">
            {t('flow.council.formTitle')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('flow.council.form')}</p>
          {council?.onDesign ? (
            <Button
              variant="outline"
              size="sm"
              className="self-start"
              data-testid="council-edit-form"
              disabled={disabled || forms === null}
              onClick={council.onDesign}
            >
              {t('flow.council.makeDesign')}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="council-no-design">
              {t('flow.council.quickCannot')}
            </p>
          )}
        </section>
      ) : (
        <>
          <section className="flex flex-col gap-2" aria-labelledby="in-form">
            <h3 id="in-form" className="text-sm font-semibold">
              {t('flow.outputForm')}
            </h3>
            {library ? (
              <FormPicker
                flow={flow}
                agent={agent}
                library={library}
                disabled={disabled}
                labelledby="in-form"
                onChange={props.onChange}
                onLibrary={props.onLibrary}
              />
            ) : (
              <p className="text-xs text-muted-foreground" data-testid="library-loading">
                {t('flow.pick.loading')}
              </p>
            )}
            {feedsOutput && agent.form !== 'answer' ? (
              <p
                className="rounded-md border border-amber-500/40 p-2 text-xs"
                data-testid="form-feeds-output"
              >
                {t('flow.formFeedsOutput')}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('flow.pick.formHint')}</p>
          </section>

          <section className="flex flex-col gap-2" aria-labelledby="in-prompt">
            <Heading>
              <span id="in-prompt">{t('flow.prompt')}</span>
            </Heading>
            {library ? (
              <PromptPicker
                flow={flow}
                agent={agent}
                library={library}
                disabled={disabled}
                labelledby="in-prompt"
                onChange={props.onChange}
                onLibrary={props.onLibrary}
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t('flow.pick.loading')}</p>
            )}
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <LockIcon className="mt-0.5 size-3 shrink-0" />
              {t('flow.pick.promptHint')}
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * What the assistant says about each access switch that matters here (a held one always, a free one only while it is on, as a
 * warning): one short line, and the full notes behind «Details».
 */
function AccessNotes({
  agent,
  info,
  keys,
}: {
  agent: FlowAgent;
  info: HarnessInfo | undefined;
  keys: readonly ToggleKey[];
}) {
  const { t } = useI18n();
  const [details, setDetails] = useState(false);
  const noted = useNotes();
  if (agent.harness === 'agy')
    return (
      <p className="text-xs text-muted-foreground" data-testid="agent-hint">
        {noted.node(note('agy_controlled_note'))}
      </p>
    );
  const notes = keys.flatMap((key) => {
    const rule = info?.[key];
    const held = heldValue(agent.harness, key);
    const finalWeb = key === 'web' && agent.form === 'answer';
    const closed = held === false || finalWeb;
    if (!rule?.note || (held === null && !agent[key] && !closed)) return [];
    const line = toggleText(rule);
    return [
      {
        key,
        short: finalWeb && held === null ? t('flow.access.webFinal') : line.short || line.note,
        note: line.note,
      },
    ];
  });
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid="agent-hint">
      <p className="flex items-start gap-1.5">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
        <span>{notes.map((entry) => entry.short).join(' ')}</span>
      </p>
      <Button
        variant="link"
        size="xs"
        className="self-start"
        aria-expanded={details}
        data-testid="agent-hint-details"
        onClick={() => setDetails((value) => !value)}
      >
        {details ? t('common.hide') : t('common.details')}
      </Button>
      {details ? (
        <ul className="flex flex-col gap-1 ps-5" data-testid="agent-notes">
          {notes.map((entry) => (
            <li key={entry.key}>
              <b className="text-foreground">{t(`ss.${entry.key}`)}:</b> {entry.note}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AccessToggle({
  name,
  agent,
  info,
  disabled,
  onChange,
}: {
  name: ToggleKey;
  agent: FlowAgent;
  info: HarnessInfo | undefined;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const noted = useNotes();
  const mode = info?.[name].mode ?? 'free';
  if (mode === 'uncontrolled')
    return (
      <span
        className="text-xs text-muted-foreground"
        data-testid={`agent-${name}`}
        data-mode="uncontrolled"
      >
        {t(`ss.${name}`)} · {noted.node(note('agy_controlled_short'))}
      </span>
    );
  const finalWeb = name === 'web' && agent.form === 'answer';
  const held = mode === 'forced-on' ? true : mode === 'blocked' || finalWeb ? false : null;
  const on = held ?? agent[name];
  return (
    <Toggle
      variant="outline"
      size="sm"
      pressed={on}
      disabled={disabled || held !== null}
      data-testid={`agent-${name}`}
      data-mode={finalWeb ? 'blocked' : mode}
      data-state={on ? 'on' : 'off'}
      onPressedChange={() => onChange(!agent[name])}
      // on is unmistakable (a check, a tinted fill, a solid border); off is plain and dashed; a held one stays disabled
      className={cn(
        'gap-1.5',
        on
          ? 'border-primary bg-primary/15 font-semibold text-foreground hover:bg-primary/20 aria-pressed:bg-primary/15'
          : 'border-dashed text-muted-foreground',
      )}
      title={info ? toggleText(info[name]).note || undefined : undefined}
    >
      {on ? <CheckIcon aria-hidden="true" /> : null}
      {t(`ss.${name}`)}
      <span className="text-xs font-normal text-muted-foreground" data-testid="toggle-state">
        {mode === 'forced-on'
          ? t('councils.alwaysOn')
          : held === false
            ? t('councils.closed')
            : on
              ? t('councils.toggleOn')
              : t('councils.toggleOff')}
      </span>
    </Toggle>
  );
}

// ---------- an agent at a level ----------

function LevelPanel(props: InspectorProps & { agent: FlowAgent; level: ReasoningLevel }) {
  const { agent, flow, view, disabled, level, names } = props;
  const { t } = useI18n();
  const noted = useNotes();
  const derived = props.derived ? agentOf(props.derived, agent.id) : undefined;
  const changed =
    derived !== undefined &&
    (derived.model !== agent.model ||
      derived.effort !== agent.effort ||
      (derived.enabled !== false) !== (agent.enabled !== false));
  const patch = (next: Partial<FlowAgent>) => props.onChange(patchAgent(flow, agent.id, next));
  const levelName = t(`level.${level}` as Key);
  return (
    <div className="flex flex-col gap-5 p-4" data-testid="inspector-level" data-agent-id={agent.id}>
      <div className="flex items-center gap-2">
        <span
          className="grid size-9 shrink-0 place-items-center rounded-md border bg-muted font-mono text-xs font-semibold"
          translate="no"
        >
          {INITIALS[agent.harness] ?? '??'}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-semibold" dir="auto">
            {names[agent.id]}
          </span>
          <span className="text-xs text-muted-foreground">
            {hasKey(`flow.agentLine.${agent.form}`)
              ? t(`flow.agentLine.${agent.form}` as Key)
              : (agent.formInfo?.name ?? agent.form)}{' '}
            · {HARNESS_LABEL[agent.harness] ?? agent.harness}
          </span>
        </div>
        {changed ? <OriginBadge origin="override" /> : null}
      </div>
      <section className="flex flex-col gap-3">
        {agent.harness === 'agy' ? (
          <p className="text-xs" data-testid="agy-warning">
            {noted.node(note('agy_warning'))}
          </p>
        ) : null}
        <Heading>{t('flow.level.title', { level: levelName })}</Heading>
        <div className="flex items-center gap-2 text-sm">
          <Switch
            checked={agent.enabled !== false}
            disabled={disabled || agent.form === 'answer'}
            data-testid="level-agent-on"
            onCheckedChange={(enabled) => patch({ enabled })}
            aria-label={t('flow.level.takesPart')}
          />
          {t('flow.level.takesPart')}
        </div>
        {agent.form === 'answer' ? (
          <p className="text-xs text-muted-foreground">{t('flow.level.alwaysOn')}</p>
        ) : null}
        {agent.enabled === false ? (
          <p className="text-xs text-muted-foreground">{t('flow.level.off')}</p>
        ) : null}
        <Row label={t('councils.model')}>
          <ModelSelect
            view={view}
            harness={agent.harness}
            model={agent.model}
            idPrefix="level-agent"
            disabled={disabled}
            className="w-full"
            onChange={(next) => patch(modelPatch(view, agent, next.model))}
          />
        </Row>
        <Row label={t('level.caption')}>
          <EffortSelect
            view={view}
            harness={agent.harness}
            model={agent.model}
            effort={agent.effort}
            idPrefix="level-agent"
            disabled={disabled}
            className="w-full"
            onChange={(effort) => patch({ effort })}
          />
        </Row>
        <p className="text-xs text-muted-foreground">{t('flow.level.derived')}</p>
        {changed && derived ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            data-testid="level-agent-reset"
            disabled={disabled}
            onClick={() =>
              patch({
                enabled: derived.enabled !== false,
                model: derived.model,
                effort: derived.effort,
              })
            }
          >
            <RotateCcwIcon />
            {t('councils.resetToLevel')}
          </Button>
        ) : null}
      </section>
      <p className="text-xs text-muted-foreground">{t('flow.level.fixed')}</p>
    </div>
  );
}
