// The editing of a flow design, without the screen (pure, so a test can pin it). A design is a `Flow` (src/shared/flow.ts): one
// Input, agents, one Output, and the lines between them. The editor never writes a second validation: whether a design can run is
// `validateFlow`'s answer (here `problemOf`, which also says WHICH boxes it is about). What lives here are the editing moves that
// keep a design consistent while it is drawn:
//   - a box's role, its required inputs and its response group are not typed in, they follow from the lines and the output forms
//     (`normalizeFlow`): a report that feeds an agent is a required draft, member answers that feed an agent are its response group;
//   - a line that can never be right is refused when it is drawn (`connectionProblem`), with the reason;
//   - the Input needs no line to an agent that other agents feed (every agent reads the conversation anyway); the line is kept in
//     the data and drawn only for an agent nothing else feeds (`visibleEdges`).

import {
  agentsOf,
  conditionsOf,
  dependencyLinks,
  type Flow,
  type FlowAgent,
  type FlowCondition,
  FlowError,
  isDirectAnswer,
  validateFlow,
} from '../../../../../src/shared/flow.ts';
import { normalizeToggles, toggleProblem } from '../../../../../src/shared/harness-rules.ts';
import type { Note } from '../../../../../src/shared/messages.ts';
import type { HarnessId, JsonSchema } from '../../../../../src/shared/types.ts';

export type Form = 'report' | 'member' | 'answer';
export type FlowNode = Flow['nodes'][number];
export type FlowEdge = Flow['edges'][number];
/** A line is told apart by its two ends and, for a gate, by which exit of the condition it leaves from. */
export interface EdgeRef {
  from: string;
  to: string;
  gate?: 'yes' | 'no';
}
export const edgeKey = (edge: EdgeRef): string =>
  edge.gate ? `${edge.from}:${edge.gate}>${edge.to}` : `${edge.from}>${edge.to}`;
const sameEdge = (edge: FlowEdge, ref: EdgeRef): boolean =>
  edge.from === ref.from && edge.to === ref.to && (edge.gate ?? undefined) === ref.gate;
export type FormDefaults = Record<Form, { rules: string; schema: JsonSchema }> & {
  answer: { rules: string; directRules: string; schema: JsonSchema };
};

/** Connections select the answer's standard prompt; a prompt the person edited stays theirs. */
export function syncAnswerRules(flow: Flow, forms: FormDefaults): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.kind === 'agent' &&
      node.form === 'answer' &&
      [forms.answer.rules, forms.answer.directRules].includes(node.rules)
        ? {
            ...node,
            prompt: isDirectAnswer(node) ? 'divan.direct' : 'divan.chairman',
            rules: isDirectAnswer(node) ? forms.answer.directRules : forms.answer.rules,
          }
        : node,
    ),
  };
}
export interface Place {
  x: number;
  y: number;
}

/** The most boxes and lines a design may have (what `validateFlow` allows). */
export const MAX_NODES = 18;

export const isAgent = (node: FlowNode | undefined): node is FlowAgent => node?.kind === 'agent';
export const isCondition = (node: FlowNode | undefined): node is FlowCondition =>
  node?.kind === 'condition';
export const inputOf = (flow: Flow): string => flow.nodes.find((n) => n.kind === 'input')?.id ?? '';
export const outputOf = (flow: Flow): string =>
  flow.nodes.find((n) => n.kind === 'output')?.id ?? '';
export const nodeOf = (flow: Flow, id: string): FlowNode | undefined =>
  flow.nodes.find((node) => node.id === id);
export const agentOf = (flow: Flow, id: string): FlowAgent | undefined => {
  const node = nodeOf(flow, id);
  return isAgent(node) ? node : undefined;
};
export const conditionOf = (flow: Flow, id: string): FlowCondition | undefined => {
  const node = nodeOf(flow, id);
  return isCondition(node) ? node : undefined;
};

/**
 * The role an agent plays follows from its output form and whether a report feeds it. Only the final answer form is a chairman
 * or a rewriter; a library form (one of the person's own) answers as a member does.
 */
export const roleFor = (form: string, hasRequired: boolean): FlowAgent['role'] =>
  form === 'report'
    ? 'writer'
    : form === 'answer'
      ? hasRequired
        ? 'rewriter'
        : 'chairman'
      : hasRequired
        ? 'critic'
        : 'member';

/** The agents that feed this one (not the Input), in the order of the design's boxes. */
export function feedersOf(flow: Flow, id: string): FlowAgent[] {
  const from = new Set(flow.edges.filter((edge) => edge.to === id).map((edge) => edge.from));
  return agentsOf(flow).filter((agent) => from.has(agent.id));
}

/**
 * The declarations of every agent rebuilt from the lines and the forms: what it must have (a report that feeds it) and its
 * response group (member answers that feed it, the minimum kept within what the group can give). Nothing else changes.
 */
export function normalizeFlow(flow: Flow): Flow {
  const branched = flow.nodes.some((node) => node.kind === 'condition');
  const nodes = flow.nodes.map((node) => {
    if (!isAgent(node)) return node;
    const sources = feedersOf(flow, node.id);
    const required = sources
      .filter((source) =>
        branched
          ? node.required.includes(source.id) ||
            (!node.responses?.ids.includes(source.id) && source.form !== 'member')
          : source.form !== 'member',
      )
      .map((s) => s.id);
    const group = sources
      .filter((source) =>
        branched
          ? node.responses?.ids.includes(source.id) ||
            (!node.required.includes(source.id) && source.form === 'member')
          : source.form === 'member',
      )
      .map((s) => s.id);
    const next: FlowAgent = {
      ...node,
      required,
      role: roleFor(node.form, required.length > 0),
    };
    if (group.length > 0) {
      // a group starts at two answers, as a council's chairman waits for two; in a design with a condition its answers are more often
      // alternatives (one side or the other runs), so it starts at one: a minimum of two could never be met
      const min = node.responses?.min ?? (branched ? 1 : Math.min(2, group.length));
      next.responses = { ids: group, min: Math.max(1, Math.min(min, group.length)) };
    } else delete next.responses;
    return next;
  });
  return { ...flow, nodes, edges: flow.edges.map((edge) => fitFields(flow, edge)) };
}

/** The fields a line carries stay within the fields its source has now; a line that would carry none, or cannot carry fields, carries everything. */
function fitFields(flow: Flow, edge: FlowEdge): FlowEdge {
  if (edge.fields === undefined) return edge;
  const source = agentOf(flow, edge.from);
  const target = agentOf(flow, edge.to);
  const have = Object.keys(source?.schema?.properties ?? {});
  const kept = edge.fields.filter((name) => have.includes(name));
  if (!source || !target || edge.gate || source.form === 'report' || kept.length === 0) {
    const { fields: _gone, ...rest } = edge;
    return rest;
  }
  return kept.length === edge.fields.length ? edge : { ...edge, fields: kept };
}

const hasEdge = (flow: Flow, from: string, to: string, gate?: 'yes' | 'no'): boolean =>
  flow.edges.some((edge) => sameEdge(edge, { from, to, ...(gate ? { gate } : {}) }));

/**
 * A line from Input to an agent that something else feeds (another agent, or a condition's Yes or No) says nothing the other
 * lines do not: it is kept, not drawn.
 */
export function visibleEdges(flow: Flow): FlowEdge[] {
  const input = inputOf(flow);
  const fed = new Set(
    flow.edges
      .filter((edge) => {
        const from = nodeOf(flow, edge.from);
        return edge.from !== input && (isAgent(from) || isCondition(from));
      })
      .map((e) => e.to),
  );
  return flow.edges.filter((edge) => !(edge.from === input && fed.has(edge.to)));
}

const reaches = (flow: Flow, from: string, target: string): boolean => {
  const seen = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === target) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return dependencyLinks(flow)
      .filter((edge) => edge.from === id)
      .some((edge) => walk(edge.to));
  };
  return walk(from);
};

export type ConnectionProblem =
  | 'self'
  | 'missing'
  | 'from-output'
  | 'to-input'
  | 'duplicate'
  | 'output-needs-answer'
  | 'output-taken'
  | 'input-redundant'
  | 'answer-feeds-agent'
  | 'cycle'
  | 'gate-to-output'
  | 'condition-needs-agent'
  | 'condition-needs-fields'
  | 'condition-taken';

/**
 * Why a line from `from` to `to` can never be part of a design that runs (so it is not drawn), or null when it can. These are
 * the moves a hand can make on the canvas; whether the design as a whole is complete is `problemOf`. `gate` is the exit of a
 * condition the line leaves from (the only lines that have one).
 */
export function connectionProblem(
  flow: Flow,
  from: string,
  to: string,
  gate?: 'yes' | 'no',
): ConnectionProblem | null {
  const a = nodeOf(flow, from);
  const b = nodeOf(flow, to);
  if (!a || !b) return 'missing';
  if (from === to) return 'self';
  if (a.kind === 'output') return 'from-output';
  if (b.kind === 'input') return 'to-input';
  // the lines of a condition are its Yes and its No; only a condition has them
  if (isCondition(a) !== (gate !== undefined)) return 'missing';
  if (hasEdge(flow, from, to, gate)) return 'duplicate';
  if (isCondition(a)) {
    if (b.kind === 'output') return 'gate-to-output';
    return reaches(flow, to, from) ? 'cycle' : null;
  }
  if (b.kind === 'output') {
    if (!isAgent(a) || a.form !== 'answer') return 'output-needs-answer';
    if (flow.edges.some((edge) => edge.to === to)) return 'output-taken';
    return null;
  }
  if (isCondition(b)) {
    if (!isAgent(a)) return 'condition-needs-agent';
    if (a.form === 'answer') return 'answer-feeds-agent';
    if (a.form === 'report') return 'condition-needs-fields';
    if (flow.edges.some((edge) => edge.to === to && !edge.gate)) return 'condition-taken';
    return reaches(flow, to, from) ? 'cycle' : null;
  }
  if (a.kind === 'input' && (feedersOf(flow, to).length > 0 || hasGate(flow, to)))
    return 'input-redundant';
  if (isAgent(a) && a.form === 'answer') return 'answer-feeds-agent';
  if (reaches(flow, to, from)) return 'cycle';
  return null;
}

const hasGate = (flow: Flow, id: string): boolean =>
  flow.edges.some((edge) => edge.to === id && edge.gate !== undefined);

/**
 * Draws a line (the caller has checked `connectionProblem`). Between agents a line is anonymous: who wrote it is never told.
 * What a condition reads and the lines it sends are not answers of agents, so they are not anonymous.
 */
export function connect(flow: Flow, from: string, to: string, gate?: 'yes' | 'no'): Flow {
  if (hasEdge(flow, from, to, gate)) return flow;
  const anonymous = gate === undefined && isAgent(nodeOf(flow, from)) && isAgent(nodeOf(flow, to));
  return normalizeFlow({
    ...flow,
    edges: [...flow.edges, { from, to, anonymous, ...(gate ? { gate } : {}) }],
  });
}

/** Takes a line away. An agent left with nothing leading to it gets its line from Input back, so it is not lost by accident. */
export function disconnect(flow: Flow, from: string, to: string, gate?: 'yes' | 'no'): Flow {
  const input = inputOf(flow);
  let edges = flow.edges.filter((edge) => !sameEdge(edge, { from, to, ...(gate ? { gate } : {}) }));
  const target = nodeOf(flow, to);
  const source = nodeOf(flow, from);
  if (
    from !== input &&
    isAgent(target) &&
    (isAgent(source) || isCondition(source)) &&
    !edges.some((edge) => edge.to === to)
  )
    edges = [...edges, { from: input, to, anonymous: false }];
  return normalizeFlow({ ...flow, edges });
}

/** Removes an agent or a condition with its lines (Input and Output stay). */
export function removeNode(flow: Flow, id: string): Flow {
  const node = nodeOf(flow, id);
  if (!isAgent(node) && !isCondition(node)) return flow;
  const input = inputOf(flow);
  const gone = flow.edges.filter(
    (edge) => edge.from === id || edge.to === id || edge.when?.condition === id,
  );
  let edges = flow.edges.filter(
    (edge) => edge.from !== id && edge.to !== id && edge.when?.condition !== id,
  );
  for (const edge of gone) {
    if (edge.from !== id) continue;
    const target = nodeOf(flow, edge.to);
    if (isAgent(target) && !edges.some((item) => item.to === target.id))
      edges = [...edges, { from: input, to: target.id, anonymous: false }];
  }
  return normalizeFlow({ ...flow, nodes: flow.nodes.filter((item) => item.id !== id), edges });
}

/** An id no box has: `agent`, `agent2`, … (a design's ids are 1 to 32 letters, digits, `_` and `-`). */
export function freshId(flow: Flow, base = 'agent'): string {
  const used = new Set(flow.nodes.map((node) => node.id));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}

export interface NewAgent {
  harness: HarnessId;
  model: string;
  effort: string;
}

/**
 * A new agent that answers as a member: fed from Input, and joining the answer of the agent that gives the final one (when
 * there is one). It starts with the form's standard prompt, and with tools, memory and web off.
 */
export function addAgent(
  flow: Flow,
  base: NewAgent,
  forms: FormDefaults,
  form: Form = 'member',
): { flow: Flow; id: string } {
  const id = freshId(flow);
  const toggles = normalizeToggles(base.harness, { tools: false, memory: false, web: false });
  const agent: FlowAgent = {
    id,
    kind: 'agent',
    role: roleFor(form, false),
    form,
    harness: base.harness,
    model: base.model,
    effort: base.effort,
    ...toggles,
    prompt: form === 'answer' ? 'divan.direct' : `divan.${form}`,
    rules: forms[form].rules,
    schema: structuredClone(forms[form].schema),
    required: [],
  };
  const final = flow.edges.find((edge) => edge.to === outputOf(flow))?.from;
  const edges: FlowEdge[] = [
    ...flow.edges,
    { from: inputOf(flow), to: id, anonymous: false },
    ...(final && isAgent(nodeOf(flow, final)) && form !== 'answer'
      ? [{ from: id, to: final, anonymous: true }]
      : []),
  ];
  // the new box comes after the boxes of its row: before the agent that gives the final answer, else before Output
  const nodes = [...flow.nodes];
  const at = nodes.findIndex((node) => node.id === final);
  nodes.splice(at >= 0 ? at : nodes.findIndex((node) => node.kind === 'output'), 0, agent);
  return { flow: syncAnswerRules(normalizeFlow({ ...flow, nodes, edges }), forms), id };
}

/** Changes what an agent is (not what feeds it). A harness change fits the access switches to what that harness can keep read-only. */
export function patchAgent(flow: Flow, id: string, patch: Partial<FlowAgent>): Flow {
  return normalizeFlow({
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.id !== id || !isAgent(node)) return node;
      const next: FlowAgent = { ...node, ...patch };
      if (patch.harness !== undefined || patch.tools !== undefined || patch.memory !== undefined)
        Object.assign(next, normalizeToggles(next.harness, next));
      // the agent that gives the final answer never searches the web
      if (next.form === 'answer') next.web = false;
      return next;
    }),
  });
}

/** The name the user gives a box (an empty one takes the name away: the box is called by its role again). */
export function setLabel(flow: Flow, id: string, label: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.id !== id || !isAgent(node)) return node;
      const { label: _was, ...rest } = node;
      return label ? { ...rest, label } : rest;
    }),
  };
}

/** Another output form: replace standard prompts only, keeping the person's own text. */
export function setForm(flow: Flow, id: string, form: Form, forms: FormDefaults): Flow {
  const agent = agentOf(flow, id);
  if (!agent || agent.form === form) return flow;
  const standard = [...Object.values(forms).map((item) => item.rules), forms.answer.directRules];
  return syncAnswerRules(
    patchAgent(flow, id, {
      form,
      rules: standard.includes(agent.rules) ? forms[form].rules : agent.rules,
      schema: structuredClone(forms[form].schema),
    }),
    forms,
  );
}

/** How many answers of its response group an agent waits for (1 up to the size of the group). */
export function setMinimum(flow: Flow, id: string, min: number): Flow {
  return normalizeFlow({
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === id && isAgent(node) && node.responses
        ? { ...node, responses: { ...node.responses, min } }
        : node,
    ),
  });
}

/** A new condition, not joined to anything yet: it reads one agent (its answer's fields) and sends Yes or No. */
export function addCondition(flow: Flow): { flow: Flow; id: string } {
  const id = freshId(flow, 'condition');
  const node: FlowCondition = { id, kind: 'condition', mode: 'all', rules: [] };
  const nodes = [...flow.nodes];
  const final = flow.edges.find((edge) => edge.to === outputOf(flow))?.from;
  const at = nodes.findIndex((item) => item.id === final);
  nodes.splice(at >= 0 ? at : nodes.findIndex((item) => item.kind === 'output'), 0, node);
  return { flow: normalizeFlow({ ...flow, nodes }), id };
}

/** Changes how a condition decides: `all` or `any` of its rules, and the rules. */
export function setCondition(
  flow: Flow,
  id: string,
  patch: Partial<Pick<FlowCondition, 'mode' | 'rules'>>,
): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) =>
      node.id === id && isCondition(node) ? { ...node, ...patch } : node,
    ),
  };
}

/** How the wire from `from` is declared on `to`: a draft it must have, one of the answers it waits for, or neither. */
export function wireRole(flow: Flow, from: string, to: string): 'required' | 'group' | null {
  const target = agentOf(flow, to);
  if (target?.required.includes(from)) return 'required';
  if (target?.responses?.ids.includes(from)) return 'group';
  return null;
}

/**
 * Declares a wire as required or as one of a group. Only a design with a condition keeps the choice: there, the answers of the
 * two sides of a condition are alternatives (one of them never runs), so each is «one of the answers» and never «required».
 * Without a condition the role follows from the source's form, as it always did.
 */
export function setWireRole(
  flow: Flow,
  from: string,
  to: string,
  role: 'required' | 'group',
): Flow {
  return normalizeFlow({
    ...flow,
    nodes: flow.nodes.map((node) => {
      if (node.id !== to || !isAgent(node)) return node;
      const required = node.required.filter((id) => id !== from);
      const ids = (node.responses?.ids ?? []).filter((id) => id !== from);
      const next: FlowAgent = {
        ...node,
        required: role === 'required' ? [...required, from] : required,
      };
      if (role === 'group') {
        next.responses = { ids: [...ids, from], min: node.responses?.min ?? 1 };
      } else if (ids.length > 0) {
        next.responses = { ids, min: Math.min(node.responses?.min ?? 1, ids.length) };
      } else delete next.responses;
      return next;
    }),
  });
}

/** Conditions whose implied link to the recipient cannot make a cycle. */
export function controllingConditions(flow: Flow, from: string, to: string): FlowCondition[] {
  if (!agentOf(flow, from) || !agentOf(flow, to)) return [];
  return conditionsOf(flow).filter((condition) => !reaches(flow, to, condition.id));
}
export function setWireWhen(flow: Flow, from: string, to: string, when: FlowEdge['when']): Flow {
  if (
    !agentOf(flow, from) ||
    !agentOf(flow, to) ||
    (when && !controllingConditions(flow, from, to).some((node) => node.id === when.condition))
  )
    return flow;
  return {
    ...flow,
    edges: flow.edges.map((edge) => {
      if (edge.from !== from || edge.to !== to || edge.gate) return edge;
      const { when: _was, ...rest } = edge;
      return when ? { ...rest, when } : rest;
    }),
  };
}
/** The top-level fields a wire from `from` to `to` can be narrowed to (none: it carries the whole answer, or the source has no fields). */
export function wireFields(flow: Flow, from: string, to: string): string[] | null {
  const source = agentOf(flow, from);
  const target = agentOf(flow, to);
  const edge = flow.edges.find((item) => item.from === from && item.to === to && !item.gate);
  if (!source || !target || !edge || source.form === 'report') return null;
  const names = Object.keys(source.schema?.properties ?? {});
  return names.length > 0 ? names : null;
}

/** Narrows a wire to some of its source's fields (null: the whole answer). Choosing every field is the same as the whole answer. */
export function setWireFields(flow: Flow, from: string, to: string, fields: string[] | null): Flow {
  const names = wireFields(flow, from, to);
  if (!names) return flow;
  const chosen = fields ? names.filter((name) => fields.includes(name)) : [];
  const whole = chosen.length === 0 || chosen.length === names.length;
  return {
    ...flow,
    edges: flow.edges.map((edge) => {
      if (edge.from !== from || edge.to !== to || edge.gate) return edge;
      const { fields: _was, ...rest } = edge;
      return whole ? rest : { ...rest, fields: chosen };
    }),
  };
}

/** The boxes' places on the canvas (design coordinates, kept in the design and apart from the session tree's layout). */
export function setPlaces(flow: Flow, places: Record<string, Place>): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const place = places[node.id];
      return place
        ? { ...node, position: { x: Math.round(place.x), y: Math.round(place.y) } }
        : node;
    }),
  };
}

/** Every box back to the automatic arrangement. */
export function clearPlaces(flow: Flow): Flow {
  return {
    ...flow,
    nodes: flow.nodes.map((node) => {
      const { position: _position, ...rest } = node;
      return rest as FlowNode;
    }),
  };
}

/** What stops a design from running: the first reason `validateFlow` finds and the boxes it is about, or the access a harness cannot keep. */
export interface Problem {
  reason: string;
  ids: string[];
  /** A harness's own refusal of an access switch (a coded sentence, worded by the page). */
  note?: Note;
}

export function problemOf(flow: Flow): Problem | null {
  try {
    validateFlow(flow);
  } catch (error) {
    if (error instanceof FlowError) return { reason: error.reason, ids: error.ids };
    return { reason: 'format', ids: [] };
  }
  for (const agent of agentsOf(flow)) {
    const note = toggleProblem(agent.harness, agent);
    if (note) return { reason: 'access', ids: [agent.id], note };
  }
  return null;
}

/** How deep each box is: the longest way from Input. A line that skips a level is drawn around the boxes between. */
export function depthsOf(flow: Flow): Record<string, number> {
  const depth: Record<string, number> = {};
  const edges = visibleEdges(flow);
  const walk = (id: string, seen: Set<string>): number => {
    if (id in depth) return depth[id] as number;
    if (seen.has(id)) return 0;
    seen.add(id);
    const incoming = edges.filter((edge) => edge.to === id).map((edge) => edge.from);
    const value = incoming.length ? Math.max(...incoming.map((from) => walk(from, seen) + 1)) : 0;
    seen.delete(id);
    depth[id] = value;
    return value;
  };
  for (const node of flow.nodes) walk(node.id, new Set());
  return depth;
}
