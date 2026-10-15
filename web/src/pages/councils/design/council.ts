// A council drawn as a design, and the way back. A council (no stored design) is shown on the same canvas as a design: Input, each
// member, the chairman, the answer. Every edit on that canvas is turned back into a council when the council can say it
// (`councilOfFlow`: a model, an effort, access, a member on or off, a member added or removed); one it cannot say (a wire, a
// writer, a form, a prompt, a response minimum other than 2) makes it a design (`designOf`), after the person agreed.
// Pure functions, so a test can pin them. The drawn flow of a council carries no prompts: it is only drawn, never run.

import { agentsOf, type Flow, type FlowAgent, finalAgent } from '../../../../../src/shared/flow.ts';
import { heldValue } from '../../../../../src/shared/harness-rules.ts';
import { deriveLevel, effortForLevel } from '../../../../../src/shared/levels.ts';
import type {
  ChairmanConfig,
  HarnessId,
  HarnessModels,
  JsonSchema,
  LevelOverrides,
  ReasoningLevel,
  SeatConfig,
  SettingsFull,
} from '../../../../../src/shared/types.ts';
import { type FormDefaults, normalizeFlow, syncAnswerRules } from './edit.ts';

const STUB_SCHEMA: JsonSchema = { type: 'object', properties: {} };

/** The ids of the three boxes that are not members: the same rule as the council that runs (`compileCouncil`). */
export function councilIds(seats: readonly { id: string }[]): {
  input: string;
  output: string;
  chairman: string;
} {
  const used = new Set(seats.map((seat) => seat.id));
  const unique = (base: string): string => {
    let id = base;
    while (used.has(id)) id += '_';
    used.add(id);
    return id;
  };
  return { input: unique('input'), output: unique('output'), chairman: unique('chairman') };
}

/**
 * The council as a flow, for the canvas: every member (a member that is switched off is drawn off), the chairman who waits for
 * two of them, and the lines between. The chairman's wait is what `normalizeFlow` keeps (two, or fewer when fewer members), so
 * a drawn council is a fixed point of the design editor's own moves.
 */
export function councilFlow(settings: SettingsFull): Flow {
  const ids = councilIds(settings.seats);
  const members: FlowAgent[] = settings.seats.map((seat) => ({
    id: seat.id,
    kind: 'agent',
    role: 'member',
    form: 'member',
    prompt: 'divan.member',
    harness: seat.harness,
    model: seat.model,
    effort: seat.effort,
    tools: seat.tools,
    memory: seat.memory,
    web: seat.web,
    ...(seat.enabled ? {} : { enabled: false }),
    rules: '',
    schema: STUB_SCHEMA,
    required: [],
  }));
  const chairman: FlowAgent = {
    id: ids.chairman,
    kind: 'agent',
    role: 'chairman',
    form: 'answer',
    prompt: 'divan.chairman',
    harness: settings.chairman.harness,
    model: settings.chairman.model,
    effort: settings.chairman.effort,
    tools: heldValue(settings.chairman.harness, 'tools') ?? settings.chairman.tools !== false,
    memory: settings.chairman.memory === true,
    web: false,
    rules: '',
    schema: STUB_SCHEMA,
    required: [],
    responses: { ids: members.map((member) => member.id), min: 2 },
  };
  return {
    version: 1,
    kind: 'council',
    nodes: [
      { id: ids.input, kind: 'input' },
      ...members,
      chairman,
      { id: ids.output, kind: 'output' },
    ],
    edges: [
      ...members.map((member) => ({ from: ids.input, to: member.id, anonymous: false })),
      { from: ids.input, to: ids.chairman, anonymous: false },
      ...members.map((member) => ({ from: member.id, to: ids.chairman, anonymous: true })),
      { from: ids.chairman, to: ids.output, anonymous: false },
    ],
  };
}

/** What makes two flows the same shape: the boxes, their forms and waits, and the lines (not the settings of an agent). */
function shapeOf(flow: Flow): string {
  return JSON.stringify({
    nodes: flow.nodes
      .map((node) =>
        node.kind === 'agent'
          ? [
              node.id,
              node.kind,
              node.form,
              node.role,
              [...node.required].sort(),
              node.responses ? [[...node.responses.ids].sort(), node.responses.min] : null,
            ]
          : [node.id, node.kind],
      )
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'en')),
    edges: flow.edges.map((edge) => `${edge.from}>${edge.to}:${edge.anonymous}`).sort(),
  });
}

const sameSeat = (a: SeatConfig, b: SeatConfig): boolean =>
  a.enabled === b.enabled &&
  a.harness === b.harness &&
  a.model === b.model &&
  a.effort === b.effort &&
  a.tools === b.tools &&
  a.memory === b.memory &&
  a.web === b.web;

/**
 * The council that `flow` stands for, or null when a council cannot say it. `keep` are the members that cannot go (the profile's
 * default members: a council drops one by switching it off). A flow is a council's when it has the council's shape (the members
 * answering on their own, the chairman waiting for two, and nothing else) whatever the settings of its agents are.
 */
export function councilOfFlow(
  flow: Flow,
  current: SettingsFull,
  keep: readonly string[],
): SettingsFull | null {
  const ids = councilIds(current.seats);
  const agents = agentsOf(flow);
  const finals = agents.filter((agent) => agent.form === 'answer');
  const chair = finals[0];
  if (finals.length !== 1 || !chair || chair.id !== ids.chairman) return null;
  const members = agents.filter((agent) => agent.id !== chair.id);
  if (members.some((agent) => agent.form !== 'member')) return null;
  // a council has no prompt of its own to change, no name for a box and no place for it: whatever carries one is a design's
  if (
    agents.some((agent) => agent.rules !== '' || agent.label !== undefined) ||
    flow.nodes.some((node) => node.position !== undefined)
  )
    return null;
  if (keep.some((id) => !members.some((agent) => agent.id === id))) return null;
  const seats = members.map((agent): SeatConfig => {
    const made: SeatConfig = {
      id: agent.id,
      enabled: agent.enabled !== false,
      harness: agent.harness,
      model: agent.model,
      effort: agent.effort,
      tools: agent.tools,
      memory: agent.memory,
      web: agent.web,
    };
    const was = current.seats.find((seat) => seat.id === agent.id);
    return was && sameSeat(was, made) ? was : made;
  });
  const was = current.chairman;
  const chairman: ChairmanConfig =
    was.harness === chair.harness &&
    was.model === chair.model &&
    was.effort === chair.effort &&
    (heldValue(was.harness, 'tools') ?? was.tools !== false) === chair.tools &&
    (was.memory === true) === chair.memory
      ? was
      : {
          harness: chair.harness,
          model: chair.model,
          effort: chair.effort,
          tools: chair.tools,
          memory: chair.memory,
        };
  const next: SettingsFull = { ...current, seats, chairman };
  return shapeOf(councilFlow(next)) === shapeOf(flow) ? next : null;
}

/** The design a council becomes: its flow with every agent given the standard prompt and answer form of its output form. */
export function designOf(flow: Flow, forms: FormDefaults): Flow {
  return syncAnswerRules(
    normalizeFlow({
      ...flow,
      kind: 'custom',
      nodes: flow.nodes.map((node) =>
        node.kind === 'agent'
          ? {
              ...node,
              rules: forms[node.form as 'member' | 'answer'].rules,
              schema: structuredClone(forms[node.form as 'member' | 'answer'].schema),
            }
          : node,
      ),
    }),
    forms,
  );
}

/**
 * What a council's saved overrides of one level become on the design it turns into: a member's is the same agent's, the
 * chairman's is the agent that gives the final answer. Only what an agent of a design can be overridden in (enabled, assistant,
 * model, effort) is carried; what the design no longer has is dropped.
 */
export function overridesForDesign(overrides: LevelOverrides, design: Flow): LevelOverrides {
  const nodes: NonNullable<LevelOverrides['nodes']> = {};
  const has = (id: string) => agentsOf(design).some((agent) => agent.id === id);
  const keep = (patch: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = {};
    for (const field of ['enabled', 'harness', 'model', 'effort']) {
      if (patch?.[field] !== undefined) out[field] = patch[field];
    }
    return out;
  };
  for (const [id, patch] of Object.entries(overrides.seats ?? {})) {
    const kept = keep(patch);
    if (has(id) && Object.keys(kept).length > 0) nodes[id] = kept;
  }
  const chair = finalAgent(design).id;
  const kept = keep(overrides.chairman);
  if (Object.keys(kept).length > 0) nodes[chair] = kept;
  return Object.keys(nodes).length > 0 ? { nodes } : {};
}

const infoOf = (models: readonly HarnessModels[], harness: HarnessId, id: string) =>
  models.find((item) => item.harness === harness)?.models.find((model) => model.id === id);

/**
 * A level of a design that is not saved yet (a council turned into a design on this page): the efforts the level calls for and the
 * overrides the council had at it, laid over the design, as the server will resolve them once it is saved. For showing only.
 */
export function draftLevel(
  base: SettingsFull,
  level: ReasoningLevel,
  stored: LevelOverrides,
  models: readonly HarnessModels[],
): { derived: Flow; effective: Flow } {
  const derived = deriveLevel(base, level, { models: [...models], latency: new Map() })
    .flow as Flow;
  const effective = structuredClone(derived);
  const patches = overridesForDesign(stored, effective).nodes ?? {};
  for (const agent of agentsOf(effective)) {
    const patch = patches[agent.id];
    if (!patch) continue;
    Object.assign(agent, patch);
    if (patch.effort === undefined && (patch.model !== undefined || patch.harness !== undefined))
      agent.effort = effortForLevel(
        level,
        infoOf(models, agent.harness, agent.model),
        agent.effort,
      );
  }
  return { derived, effective };
}
