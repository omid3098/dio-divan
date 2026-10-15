import { heldValue } from './harness-rules.ts';
import type { FormField } from './library.ts';
import type { Note } from './messages.ts';
import type {
  ChairmanOutput,
  ChairmanRun,
  ChairNode,
  JsonSchema,
  MemberOutput,
  SeatConfig,
  SeatRun,
  SessionSettings,
  SettingsFull,
} from './types.ts';

export interface ReportOutput {
  report: string;
}
export interface FlowAgent extends Omit<SeatConfig, 'enabled'> {
  enabled?: boolean;
  /** Where the editor draws the box: a design coordinate, apart from the session tree's layout and never part of a cache key. */
  position?: { x: number; y: number };
  /** The name the editor shows (never sent to a harness, never part of a cache key). */
  label?: string;
  kind: 'agent';
  form: string;
  prompt?: string;
  formInfo?: { name: string; fields: FormField[]; revision: number };
  rules: string;
  schema: JsonSchema;
  role: 'member' | 'writer' | 'critic' | 'chairman' | 'rewriter';
  required: string[];
  responses?: { ids: string[]; min: number };
}
export interface Flow {
  version: 1;
  kind: 'council' | 'custom';
  nodes: (
    | { id: string; kind: 'input' | 'output'; position?: { x: number; y: number } }
    | FlowAgent
    | FlowCondition
  )[];
  edges: {
    from: string;
    to: string;
    anonymous: boolean;
    gate?: 'yes' | 'no';
    fields?: string[];
    when?: { condition: string; exit: 'yes' | 'no' };
  }[];
}
export interface ConditionRule {
  field: string;
  op:
    | '<'
    | '<='
    | '>'
    | '>='
    | '='
    | '!='
    | 'is empty'
    | 'is not empty'
    | 'contains'
    | 'equals'
    | 'is true'
    | 'is false'
    | 'is'
    | 'is not'
    | 'count <'
    | 'count <='
    | 'count >'
    | 'count >='
    | 'count ='
    | 'count !=';
  value?: string | number;
}
export interface FlowCondition {
  id: string;
  kind: 'condition';
  position?: { x: number; y: number };
  mode: 'all' | 'any';
  rules: ConditionRule[];
}
export type StoredFlow = Omit<Flow, 'nodes'> & {
  nodes: (
    | Exclude<Flow['nodes'][number], FlowAgent>
    | Omit<FlowAgent, 'rules' | 'schema' | 'formInfo'>
  )[];
};
export const storedFlow = (flow: Flow): StoredFlow => ({
  ...flow,
  nodes: flow.nodes.map((node) => {
    if (node.kind !== 'agent') return structuredClone(node);
    const { rules: _rules, schema: _schema, formInfo: _info, ...ref } = node;
    return structuredClone(ref);
  }),
});
export interface ConditionStep {
  id: string;
  form: 'condition';
  run: Pick<SeatRun, 'state' | 'error' | 'startedAt' | 'endedAt'> &
    Partial<Omit<SeatRun<Record<string, unknown>>, 'state' | 'error' | 'startedAt' | 'endedAt'>>;
  result: boolean | null;
  reason?: 'matched' | 'not_matched' | 'missing_field' | 'source_failed' | 'inactive_branch';
  source: string;
  inputs: string[];
  aliases: Record<string, string>;
  attempts: number[];
}
export type FlowStep = (
  | ConditionStep
  | {
      id: string;
      form: 'custom';
      formId: string;
      run: SeatRun<Record<string, unknown>>;
      aliases: Record<string, string>;
      inputs: string[];
      attempts: number[];
    }
  | {
      id: string;
      form: 'member';
      run: SeatRun;
      aliases: Record<string, string>;
      inputs: string[];
      attempts: number[];
    }
  | {
      id: string;
      form: 'report';
      run: SeatRun<ReportOutput>;
      aliases: Record<string, string>;
      inputs: string[];
      attempts: number[];
    }
  | {
      id: string;
      form: 'answer';
      run: ChairmanRun;
      output: ChairmanOutput | null;
      aliases: Record<string, string>;
      inputs: string[];
      attempts: number[];
    }
) & {
  skipReason?: 'inactive_branch' | 'disabled' | 'unavailable' | 'family' | 'user';
  errorNote?: Note;
};

export const agentsOf = (flow: Flow): FlowAgent[] =>
  flow.nodes.filter((node): node is FlowAgent => node.kind === 'agent');
export const isDirectAnswer = (agent: FlowAgent): boolean =>
  agent.form === 'answer' && !agent.required.length && !agent.responses?.ids.length;
export const finalAgent = (flow: Flow): FlowAgent => {
  const output = flow.nodes.find((node) => node.kind === 'output');
  const id = flow.edges.find((edge) => edge.to === output?.id)?.from;
  return agentsOf(flow).find((agent) => agent.id === id) as FlowAgent;
};

/** Compatibility views are derived from the graph, never another editable runtime copy. */
export function flowCouncil(flow: Flow): Pick<SettingsFull, 'seats' | 'chairman'> {
  const final = finalAgent(flow);
  return {
    seats: orderedAgents(flow)
      .filter((agent) => agent.form !== 'answer')
      .map((agent) => ({
        id: agent.id,
        enabled: agent.enabled !== false,
        harness: agent.harness,
        model: agent.model,
        effort: agent.effort,
        tools: agent.tools,
        memory: agent.memory,
        web: agent.web,
      })),
    chairman: {
      harness: final.harness,
      model: final.model,
      effort: final.effort,
      tools: final.tools,
      memory: final.memory,
    },
  };
}

/** A design that cannot run: the first reason found, and the boxes it is about (when it names any). The message is the old one. */
export class FlowError extends Error {
  readonly reason: string;
  readonly ids: string[];
  constructor(reason: string, ids: string[] = []) {
    super(`invalid flow: ${reason}`);
    this.reason = reason;
    this.ids = ids;
  }
}

/** Validate the executable graph before any round is admitted. Context is implicit, never a response. */
export function validateFlow(flow: Flow): void {
  const fail = (reason: string, ids: string[] = []): never => {
    throw new FlowError(reason, ids);
  };
  if (
    flow.version !== 1 ||
    !['council', 'custom'].includes(flow.kind) ||
    !Array.isArray(flow.nodes) ||
    !Array.isArray(flow.edges)
  )
    fail('format');
  if (flow.nodes.length < 3 || flow.nodes.length > 18 || flow.edges.length > 80) fail('size');
  const ids = new Set<string>();
  for (const node of flow.nodes) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(node.id) || ids.has(node.id))
      fail('duplicate or invalid id', [node.id]);
    if (!['agent', 'input', 'output', 'condition'].includes(node.kind))
      fail('node kind', [node.id]);
    ids.add(node.id);
  }
  const inputs = flow.nodes.filter((node) => node.kind === 'input');
  const outputs = flow.nodes.filter((node) => node.kind === 'output');
  if (inputs.length !== 1 || outputs.length !== 1) fail('one input and output required');
  const edges = new Set<string>();
  for (const edge of flow.edges) {
    const key = `${edge.from}:${edge.to}:${edge.gate ?? 'data'}`;
    if (
      !ids.has(edge.from) ||
      !ids.has(edge.to) ||
      edges.has(key) ||
      typeof edge.anonymous !== 'boolean'
    )
      fail('edge', [edge.from, edge.to]);
    edges.add(key);
    const from = flow.nodes.find((node) => node.id === edge.from);
    const to = flow.nodes.find((node) => node.id === edge.to);
    if (from?.kind === 'output' || to?.kind === 'input') fail('connection', [edge.from, edge.to]);
    if (
      edge.when !== undefined &&
      (from?.kind !== 'agent' ||
        to?.kind !== 'agent' ||
        edge.gate !== undefined ||
        !edge.when ||
        typeof edge.when !== 'object' ||
        Array.isArray(edge.when) ||
        flow.nodes.find((node) => node.id === edge.when?.condition)?.kind !== 'condition' ||
        !['yes', 'no'].includes(edge.when.exit))
    )
      fail('when', [edge.from, edge.to]);
    if (
      from?.kind === 'condition'
        ? !['yes', 'no'].includes(edge.gate ?? '') ||
          (to?.kind !== 'agent' && to?.kind !== 'condition')
        : edge.gate !== undefined
    )
      fail('gate', [edge.from, edge.to]);
    if (
      edge.fields !== undefined &&
      (from?.kind !== 'agent' ||
        from.form === 'report' ||
        to?.kind !== 'agent' ||
        !Array.isArray(edge.fields) ||
        !edge.fields.length ||
        new Set(edge.fields).size !== edge.fields.length ||
        edge.fields.some((field) => !Object.hasOwn(from.schema?.properties ?? {}, field)))
    )
      fail('fields', [edge.from, edge.to]);
  }
  const links = dependencyLinks(flow);
  const walk = (id: string, reverse = false, seen = new Set<string>()): Set<string> => {
    if (seen.has(id)) return seen;
    seen.add(id);
    for (const edge of links.filter((edge) => (reverse ? edge.to : edge.from) === id))
      walk(reverse ? edge.from : edge.to, reverse, seen);
    return seen;
  };
  const forward = walk(inputs[0]?.id ?? '');
  const backward = walk(outputs[0]?.id ?? '', true);
  if (forward.size !== ids.size || backward.size !== ids.size)
    fail(
      'unreachable or dead end',
      [...ids].filter((id) => !forward.has(id) || !backward.has(id)),
    );
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.includes(id)) fail('cycle', visiting.slice(visiting.indexOf(id)));
    if (visited.has(id)) return;
    visiting.push(id);
    for (const edge of links.filter((edge) => edge.from === id)) visit(edge.to);
    visiting.pop();
    visited.add(id);
  };
  visit(inputs[0]?.id ?? '');
  const finalEdges = flow.edges.filter((edge) => edge.to === outputs[0]?.id);
  if (finalEdges.length !== 1 || finalAgent(flow)?.form !== 'answer')
    fail('one final answer producer required', [
      ...new Set([
        ...finalEdges.map((edge) => edge.from),
        ...agentsOf(flow)
          .filter((agent) => agent.form === 'answer')
          .map((agent) => agent.id),
        ...(finalEdges.length === 0 ? [outputs[0]?.id ?? ''] : []),
      ]),
    ]);
  if (finalAgent(flow).web) fail('final answer web must be off', [finalAgent(flow).id]);
  for (const agent of agentsOf(flow)) {
    if (
      !['member', 'writer', 'critic', 'chairman', 'rewriter'].includes(agent.role) ||
      (agent.enabled !== undefined && typeof agent.enabled !== 'boolean') ||
      typeof agent.model !== 'string' ||
      !/^[A-Za-z0-9._:/@+-]{1,120}$/u.test(agent.model) ||
      typeof agent.effort !== 'string' ||
      !/^[A-Za-z0-9._-]{0,24}$/u.test(agent.effort) ||
      !['claude', 'codex', 'grok', 'pi', 'agy', 'hermes'].includes(agent.harness) ||
      [agent.tools, agent.memory, agent.web].some((value) => typeof value !== 'boolean') ||
      typeof agent.form !== 'string' ||
      !agent.form.trim() ||
      !Array.isArray(agent.required) ||
      typeof agent.rules !== 'string' ||
      !agent.rules.trim() ||
      !agent.schema ||
      agent.schema.type !== 'object'
    )
      fail('agent form', [agent.id]);
    if (agent.rules.length > 64000 || JSON.stringify(agent.schema).length > 64000)
      fail('agent size', [agent.id]);
    const fields = Object.keys(agent.schema.properties ?? {});
    if (
      agent.form === 'report'
        ? fields.length !== 1 || fields[0] !== 'report'
        : agent.form === 'member'
          ? !fields.includes('stance') || !fields.includes('claims')
          : agent.form === 'answer'
            ? !fields.includes('answer') || !fields.includes('title')
            : false
    )
      fail('incompatible form', [agent.id]);
    const supplied = flow.edges
      .filter((edge) => edge.to === agent.id && edge.from !== inputs[0]?.id && !edge.gate)
      .map((edge) => edge.from);
    const declared = [...agent.required, ...(agent.responses?.ids ?? [])];
    if (
      new Set(declared).size !== declared.length ||
      declared.length !== supplied.length ||
      declared.some((id) => !supplied.includes(id))
    )
      fail('dependency declaration', [agent.id]);
    if (
      agent.responses &&
      (!Number.isInteger(agent.responses.min) ||
        agent.responses.min < 1 ||
        agent.responses.min > agent.responses.ids.length)
    )
      fail('impossible minimum', [agent.id]);
    if (
      agent.enabled !== false &&
      (agent.required.some(
        (id) => agentsOf(flow).find((item) => item.id === id)?.enabled === false,
      ) ||
        (agent.responses &&
          agent.responses.ids.filter(
            (id) => agentsOf(flow).find((item) => item.id === id)?.enabled !== false,
          ).length < agent.responses.min))
    )
      fail('disabled prerequisite', [agent.id]);
  }
  for (const condition of conditionsOf(flow)) validateCondition(flow, condition, fail);
  if (finalAgent(flow).enabled === false) fail('disabled output', [finalAgent(flow).id]);
}

/** Stable topological order includes gates and code-only conditions. */
export const dependencyLinks = (flow: Flow): { from: string; to: string }[] =>
  flow.edges.flatMap((edge) => [
    { from: edge.from, to: edge.to },
    ...(edge.when ? [{ from: edge.when.condition, to: edge.to }] : []),
  ]);
export function orderedNodes(flow: Flow): (FlowAgent | FlowCondition)[] {
  const links = dependencyLinks(flow);
  const remaining = new Map(
    flow.nodes
      .filter((n): n is FlowAgent | FlowCondition => n.kind === 'agent' || n.kind === 'condition')
      .map((n) => [n.id, n]),
  );
  const ordered: (FlowAgent | FlowCondition)[] = [];
  while (remaining.size) {
    const wave = [...remaining.values()]
      .filter((node) => links.filter((e) => e.to === node.id).every((e) => !remaining.has(e.from)))
      .sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (!wave.length) throw new FlowError('cycle');
    for (const node of wave) {
      ordered.push(node);
      remaining.delete(node.id);
    }
  }
  return ordered;
}
export const orderedAgents = (flow: Flow): FlowAgent[] =>
  orderedNodes(flow).filter((n): n is FlowAgent => n.kind === 'agent');
export const conditionsOf = (flow: Flow): FlowCondition[] =>
  flow.nodes.filter((n): n is FlowCondition => n.kind === 'condition');
export const maxCalls = (flow: Flow): number =>
  agentsOf(flow).filter((a) => a.enabled !== false).length;

/** Protocol identities contain no editor labels or anonymous recipient aliases. */
export function agentIdentity(flow: Flow, id: string): string {
  const ordered = orderedAgents(flow);
  const agent = ordered.find((item) => item.id === id);
  if (!agent) return 'Step';
  if (isDirectAnswer(agent)) return 'Assistant';
  const role = {
    member: 'Member',
    writer: 'Writer',
    critic: 'Critic',
    chairman: 'Chairman',
    rewriter: 'Rewriter',
  }[agent.role];
  const peers = ordered.filter((item) => item.role === agent.role);
  return peers.length > 1 ? `${role} ${peers.findIndex((item) => item.id === id) + 1}` : role;
}

/** Only executable fields enter a cache key; object key and graph array order do not matter. */
export function canonicalFlow(flow: Flow): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b, 'en'))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return JSON.stringify(
    stable({
      version: flow.version,
      kind: flow.kind,
      nodes: flow.nodes
        .map((node) =>
          node.kind === 'agent'
            ? {
                id: node.id,
                kind: node.kind,
                role: node.role,
                form: node.form,
                enabled: node.enabled !== false,
                harness: node.harness,
                model: node.model,
                effort: node.effort,
                tools: node.tools,
                memory: node.memory,
                web: node.web,
                rules: node.rules,
                schema: node.schema,
                ...(node.formInfo ? { fields: node.formInfo.fields } : {}),
                required: [...node.required].sort(),
                ...(node.responses
                  ? { responses: { ids: [...node.responses.ids].sort(), min: node.responses.min } }
                  : {}),
              }
            : node.kind === 'condition'
              ? { id: node.id, kind: node.kind, mode: node.mode, rules: node.rules }
              : { id: node.id, kind: node.kind },
        )
        .sort((a, b) => a.id.localeCompare(b.id, 'en')),
      edges: flow.edges
        .map(({ from, to, anonymous, gate, fields, when }) => ({
          from,
          to,
          anonymous,
          ...(gate ? { gate } : {}),
          ...(fields ? { fields: [...fields].sort() } : {}),
          ...(when ? { when: { condition: when.condition, exit: when.exit } } : {}),
        }))
        .sort((a, b) =>
          `${a.from}:${a.to}:${a.gate ?? ''}`.localeCompare(
            `${b.from}:${b.to}:${b.gate ?? ''}`,
            'en',
          ),
        ),
    }),
  );
}

export function compileCouncil(settings: SessionSettings): Flow {
  const members: FlowAgent[] = settings.seats
    .filter((seat) => seat.enabled)
    .map(({ enabled: _enabled, ...seat }) => ({
      ...seat,
      kind: 'agent',
      form: 'member',
      prompt: 'divan.member',
      role: 'member',
      rules: settings.rules,
      schema: settings.memberSchema,
      required: [],
    }));
  const used = new Set(members.map((member) => member.id));
  const unique = (base: string): string => {
    let id = base;
    while (used.has(id)) id += '_';
    used.add(id);
    return id;
  };
  const input = unique('input');
  const output = unique('output');
  const id = unique('chairman');
  const chairman: FlowAgent = {
    ...settings.chairman,
    id,
    kind: 'agent',
    form: 'answer',
    prompt: 'divan.chairman',
    role: 'chairman',
    tools: heldValue(settings.chairman.harness, 'tools') ?? settings.chairman.tools !== false,
    memory: settings.chairman.memory === true,
    web: false,
    rules: settings.chairmanRules,
    schema: settings.chairmanSchema,
    required: [],
    responses: { ids: members.map((member) => member.id), min: 2 },
  };
  return {
    version: 1,
    kind: 'council',
    nodes: [{ id: input, kind: 'input' }, ...members, chairman, { id: output, kind: 'output' }],
    edges: [
      ...members.map((member) => ({ from: input, to: member.id, anonymous: false })),
      { from: input, to: id, anonymous: false },
      ...members.map((member) => ({ from: member.id, to: id, anonymous: true })),
      { from: id, to: output, anonymous: false },
    ],
  };
}

const good = (step: FlowStep | undefined): boolean =>
  !!step &&
  step.run.state === 'done' &&
  step.form !== 'condition' &&
  (step.form === 'answer' ? !!step.output : !!step.run.sanitized);
const waiting = (step: FlowStep | undefined): boolean =>
  !!step && ['pending', 'running'].includes(step.run.state);

type WireSteps = readonly { id: string; run: { state: string }; result?: boolean | null }[];
/** A wire's decision belongs to its recipient, never to its producer's run. */
export function wireState(
  flow: Flow,
  steps: WireSteps,
  from: string,
  to: string,
): 'active' | 'inactive' | 'waiting' {
  const when = flow.edges.find((edge) => edge.from === from && edge.to === to && !edge.gate)?.when;
  if (!when) return 'active';
  const condition = steps.find((step) => step.id === when.condition);
  if (condition?.run.state === 'skipped') return 'inactive';
  if (condition?.run.state !== 'done' || typeof condition.result !== 'boolean') return 'waiting';
  return condition.result === (when.exit === 'yes') ? 'active' : 'inactive';
}
export const wireDecisionsResolved = (flow: Flow, steps: WireSteps, to: string): boolean =>
  flow.edges
    .filter((edge) => edge.to === to && edge.when)
    .every((edge) => wireState(flow, steps, edge.from, to) !== 'waiting');

/** The stop dialog and engine count only the final recipient's valid response group. */
export function finalInputsReady(
  flow: Flow,
  chair: Pick<ChairNode, 'steps' | 'seats'>,
): { answers: number; minimum: number; enough: boolean } {
  const final = finalAgent(flow);
  const valid = (id: string): boolean =>
    chair.steps
      ? good(chair.steps.find((step) => step.id === id))
      : !!chair.seats?.some(
          (seat) => seat.seatId === id && seat.state === 'done' && seat.sanitized,
        );
  const active = (id: string): boolean =>
    wireState(flow, chair.steps ?? [], id, final.id) === 'active';
  const answers = (final.responses?.ids ?? []).filter((id) => active(id) && valid(id)).length;
  const minimum = final.responses?.min ?? 0;
  return {
    answers,
    minimum,
    enough:
      gateState(flow, chair.steps ?? [], final.id) === 'active' &&
      wireDecisionsResolved(flow, chair.steps ?? [], final.id) &&
      final.required.every((id) => active(id) && valid(id)) &&
      answers >= minimum,
  };
}
export function gateState(
  flow: Flow,
  steps: FlowStep[],
  id: string,
): 'active' | 'inactive' | 'waiting' {
  const gates = flow.edges.filter((e) => e.to === id && e.gate);
  if (!gates.length) return 'active';
  const peers = gates.map((e) => steps.find((s) => s.id === e.from));
  if (peers.some((s) => !s || waiting(s) || s.run.state === 'failed')) return 'waiting';
  return gates.some((e, i) => {
    const s = peers[i];
    return s?.form === 'condition' && s.run.state === 'done' && s.result === (e.gate === 'yes');
  })
    ? 'active'
    : 'inactive';
}
export const branchSkipped = (step: FlowStep | undefined): boolean =>
  step?.run.state === 'skipped' &&
  (step.skipReason === 'inactive_branch' || step.run.error === 'inactive_branch');
/** Wait for every gate and every response peer; never shrink a quorum on an inactive branch. */
export function scheduleFlow(
  flow: Flow,
  steps: FlowStep[],
): { ready: string[]; blocked: string[]; skipped: string[]; conditions: string[] } {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const ready: string[] = [],
    blocked: string[] = [],
    skipped: string[] = [],
    conditions: string[] = [];
  for (const node of orderedNodes(flow)) {
    if (byId.get(node.id)?.run.state !== 'pending') continue;
    const gate = gateState(flow, steps, node.id);
    if (gate === 'waiting') continue;
    if (gate === 'inactive') {
      skipped.push(node.id);
      continue;
    }
    if (node.kind === 'condition') {
      const source = byId.get(conditionSource(flow, node.id));
      if (!source || waiting(source) || source.run.error?.startsWith('interrupted')) continue;
      if (branchSkipped(source)) skipped.push(node.id);
      else conditions.push(node.id);
      continue;
    }
    if (!wireDecisionsResolved(flow, steps, node.id)) continue;
    const dependencies = (ids: string[]) =>
      ids.map((id) => ({
        step: byId.get(id),
        inactive: wireState(flow, steps, id, node.id) === 'inactive',
      }));
    const required = dependencies(node.required);
    const peers = dependencies(node.responses?.ids ?? []);
    const absent = (peer: (typeof required)[number]) => peer.inactive || branchSkipped(peer.step);
    if (required.some(absent)) {
      skipped.push(node.id);
      continue;
    }
    if ([...required, ...peers].some((peer) => !peer.inactive && waiting(peer.step))) continue;
    if (required.some((peer) => !good(peer.step))) blocked.push(node.id);
    else if (
      node.responses &&
      peers.filter((peer) => !peer.inactive && good(peer.step)).length < node.responses.min
    ) {
      if (peers.every(absent)) skipped.push(node.id);
      else blocked.push(node.id);
    } else ready.push(node.id);
  }
  return { ready, blocked, skipped, conditions };
}
export const conditionSource = (flow: Flow, id: string): string =>
  flow.edges.find((e) => e.to === id && !e.gate)?.from ?? '';
export const outputOfStep = (step: FlowStep): Record<string, unknown> | null =>
  step.form === 'condition'
    ? null
    : step.form === 'answer'
      ? (step.output as unknown as Record<string, unknown>)
      : (step.run.sanitized as unknown as Record<string, unknown>);
export function projectOutput(
  flow: Flow,
  from: string,
  to: string,
  output: Record<string, unknown>,
): Record<string, unknown> {
  const fields = flow.edges.find((e) => e.from === from && e.to === to && !e.gate)?.fields;
  return fields ? Object.fromEntries(fields.map((f) => [f, output[f]])) : output;
}
/** Gates never grant access, and partial access never permits the whole payload on disk. */
export function releasableSteps(flow: Flow, steps: FlowStep[]): Set<string> {
  const remaining = steps.filter(
    (s) =>
      s.form !== 'condition' &&
      waiting(s) &&
      gateState(flow, steps, s.id) !== 'inactive' &&
      !agentsOf(flow)
        .find((agent) => agent.id === s.id)
        ?.required.some(
          (id) =>
            wireState(flow, steps, id, s.id) === 'inactive' ||
            branchSkipped(steps.find((peer) => peer.id === id)),
        ),
  );
  return new Set(
    steps
      .filter(
        (s) =>
          good(s) &&
          remaining.every((reader) =>
            flow.edges.some((e) => {
              if (e.from !== s.id || e.to !== reader.id || e.gate) return false;
              if (wireState(flow, steps, s.id, reader.id) !== 'active') return false;
              const output = outputOfStep(s);
              return !e.fields || Object.keys(output ?? {}).every((f) => e.fields?.includes(f));
            }),
          ),
      )
      .map((s) => s.id),
  );
}

export function evaluateCondition(
  node: FlowCondition,
  output: Record<string, unknown> | null,
): { result: boolean; reason: NonNullable<ConditionStep['reason']> } {
  if (!output) return { result: false, reason: 'source_failed' };
  if (node.rules.some((r) => output[r.field] === null || output[r.field] === undefined))
    return { result: false, reason: 'missing_field' };
  const compare = (a: number, op: string, b: number): boolean =>
    ({ '<': a < b, '<=': a <= b, '>': a > b, '>=': a >= b, '=': a === b, '!=': a !== b })[op] ??
    false;
  const results = node.rules.map((r) => {
    const value = output[r.field];
    if (r.op.startsWith('count '))
      return compare((value as string[]).length, r.op.slice(6), r.value as number);
    if (typeof value === 'number') return compare(value, r.op, r.value as number);
    if (r.op === 'is true') return value === true;
    if (r.op === 'is false') return value === false;
    if (r.op === 'is empty')
      return Array.isArray(value) ? !value.length : !(value as string).trim();
    if (r.op === 'is not empty')
      return Array.isArray(value) ? !!value.length : !!(value as string).trim();
    if (r.op === 'contains') return (value as string).includes(r.value as string);
    if (r.op === 'is not') return value !== r.value;
    return value === r.value;
  });
  const result = node.mode === 'all' ? results.every(Boolean) : results.some(Boolean);
  return { result, reason: result ? 'matched' : 'not_matched' };
}
function validateCondition(
  flow: Flow,
  node: FlowCondition,
  fail: (reason: string, ids?: string[]) => never,
): void {
  const input = flow.edges.filter((e) => e.to === node.id && !e.gate);
  const source = agentsOf(flow).find((a) => a.id === input[0]?.from);
  if (input.length !== 1 || !source || source.form === 'report') fail('condition input', [node.id]);
  if (
    !['all', 'any'].includes(node.mode) ||
    !Array.isArray(node.rules) ||
    !node.rules.length ||
    node.rules.length > 30
  )
    fail('condition rules', [node.id]);
  for (const r of node.rules) {
    const schema = source.schema.properties?.[r.field];
    const field = schema?.anyOf?.find((f: JsonSchema) => f.type !== 'null') ?? schema;
    if (!field) fail('condition field', [node.id, source.id]);
    const ops =
      field.type === 'number'
        ? ['<', '<=', '>', '>=', '=', '!=']
        : field.type === 'boolean'
          ? ['is true', 'is false']
          : field.type === 'array'
            ? [
                'is empty',
                'is not empty',
                'count <',
                'count <=',
                'count >',
                'count >=',
                'count =',
                'count !=',
              ]
            : field.enum
              ? ['is', 'is not']
              : field.type === 'string'
                ? ['is empty', 'is not empty', 'contains', 'equals']
                : [];
    if (!ops.includes(r.op)) fail('condition operator', [node.id]);
    const noValue = ['is true', 'is false', 'is empty', 'is not empty'].includes(r.op);
    if (
      noValue
        ? r.value !== undefined
        : field.type === 'number' || r.op.startsWith('count ')
          ? typeof r.value !== 'number' ||
            !Number.isFinite(r.value) ||
            (r.op.startsWith('count ') && (!Number.isInteger(r.value) || r.value < 0))
          : typeof r.value !== 'string' ||
            r.value.length > 2000 ||
            (field.enum && !field.enum.includes(r.value))
    )
      fail('condition value', [node.id]);
  }
  if (
    !flow.edges.some(
      (e) =>
        (e.from === node.id && e.gate === 'yes') ||
        (e.when?.condition === node.id && e.when.exit === 'yes'),
    ) ||
    !flow.edges.some(
      (e) =>
        (e.from === node.id && e.gate === 'no') ||
        (e.when?.condition === node.id && e.when.exit === 'no'),
    )
  )
    fail('condition exits', [node.id]);
}
/** A lost or rerun source invalidates decisions and every descendant, even a previously skipped one. */
export function invalidateDescendants(
  flow: Flow,
  steps: FlowStep[],
  sources: string[],
): Set<string> {
  const invalid = new Set(sources);
  const links = dependencyLinks(flow);
  for (const node of orderedNodes(flow))
    if (links.some((e) => e.to === node.id && invalid.has(e.from))) invalid.add(node.id);
  for (const step of steps) {
    if (!invalid.has(step.id)) continue;
    step.run.state = 'pending';
    delete step.skipReason;
    delete step.errorNote;
    step.run.error = null;
    step.run.startedAt = null;
    step.run.endedAt = null;
    step.run.usage = null;
    delete step.run.promptTokens;
    if (step.form !== 'answer') {
      delete step.run.lastSignalAt;
      delete step.run.thinkingTokens;
    }
    delete step.run.folderNote;
    step.inputs = [];
    if (step.form === 'condition') {
      step.result = null;
      delete step.reason;
    } else {
      step.run.rawOutput = '';
      step.run.trimmed = [];
      delete step.run.activity;
      delete step.run.toolLog;
      if (step.form === 'answer') {
        step.output = null;
        step.run.input = '';
      } else {
        step.run.parsed = null;
        step.run.sanitized = null;
        step.run.prompt = '';
      }
    }
  }
  return invalid;
}

export const chairmanOf = (chair: ChairNode): ChairmanRun =>
  (chair.steps?.find((step) => step.form === 'answer')?.run as ChairmanRun) ??
  (chair.chairman as ChairmanRun);
/** Reports get an ephemeral member view for today's panel; no second copy is stored. */
export const reportMember = (output: ReportOutput): MemberOutput => ({
  ...output,
  reportOnly: true,
  stance: '',
  recommendation: null,
  options: [],
  claims: [],
  risks: [],
  unknowns: [],
  would_change_my_mind: '',
  memory_facts: [],
});
export function seatsOf(chair: Pick<ChairNode, 'steps' | 'seats'>): SeatRun[] {
  return chair.steps
    ? chair.steps.flatMap((step) =>
        step.form === 'answer' || step.form === 'condition'
          ? []
          : step.form === 'member'
            ? [step.run]
            : [
                {
                  ...step.run,
                  parsed: step.run.parsed
                    ? reportMember(
                        step.form === 'custom'
                          ? { report: JSON.stringify(step.run.parsed, null, 2) }
                          : step.run.parsed,
                      )
                    : null,
                  sanitized: step.run.sanitized
                    ? reportMember(
                        step.form === 'custom'
                          ? { report: JSON.stringify(step.run.sanitized, null, 2) }
                          : step.run.sanitized,
                      )
                    : null,
                },
              ],
      )
    : (chair.seats ?? []);
}
export const runsOf = (
  chair: ChairNode,
): SeatRun<MemberOutput | ReportOutput | Record<string, unknown>>[] =>
  chair.steps
    ? chair.steps.flatMap((step) =>
        step.form === 'answer' || step.form === 'condition' ? [] : [step.run],
      )
    : (chair.seats ?? []);
export const stepOf = (chair: ChairNode, id: string): FlowStep | undefined =>
  chair.steps?.find((step) => step.id === id);
export function replaceChairman(chair: ChairNode, run: ChairmanRun): void {
  const step = chair.steps?.find((step) => step.form === 'answer');
  if (step) step.run = run;
  else chair.chairman = run;
}
