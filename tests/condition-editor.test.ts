// The editing of a condition and of the Library's parts in a design (web/src/pages/councils/design): a condition and its Yes and No
// lines, the checks a rule can have, the fields a line carries and how an agent uses an answer, the entries a picker offers, and the
// new checks of a design in words. Pure functions only: the canvas and the pages are in e2e/run.mjs.

import { describe, expect, it } from 'vitest';
import { flowForms } from '../src/server/flow-templates.ts';
import { libraryView } from '../src/server/library.ts';
import { agentsOf, type Flow, type FlowCondition, maxCalls } from '../src/shared/flow.ts';
import {
  defaultRule,
  fieldsOfAgent,
  kindOf,
  OPS,
  ruleProblem,
  sourceOf,
  valueKind,
  withField,
  withOp,
} from '../web/src/pages/councils/design/condition.ts';
import { describeProblem } from '../web/src/pages/councils/design/describe.ts';
import {
  addAgent,
  addCondition,
  agentOf,
  connect,
  connectionProblem,
  controllingConditions,
  depthsOf,
  disconnect,
  type FormDefaults,
  normalizeFlow,
  problemOf,
  removeNode,
  roleFor,
  setCondition,
  setWireFields,
  setWireRole,
  setWireWhen,
  visibleEdges,
  wireFields,
  wireRole,
} from '../web/src/pages/councils/design/edit.ts';
import { layoutFlow, sizeOf } from '../web/src/pages/councils/design/layout.ts';
import {
  applyForm,
  applyPrompt,
  contextOf,
  formPreview,
  formsFor,
  promptAfterForm,
  promptPreview,
  promptsFor,
} from '../web/src/pages/councils/design/library.ts';
import { agentNames } from '../web/src/pages/councils/design/names.ts';
import { branchLibrary, conditionalWireFlow, singleFlow } from './fixtures/flows.ts';

const library = libraryView(branchLibrary, []);
const FORMS = flowForms() as unknown as FormDefaults;
const base = { harness: 'pi', model: 'fake-1', effort: 'medium' } as const;
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;
const conditionOf = (flow: Flow): FlowCondition =>
  flow.nodes.find((node): node is FlowCondition => node.kind === 'condition') as FlowCondition;

/** A design made by the editor's own moves: an assessor (the Library's «assessment» form), a condition, two writers, the final agent. */
function built(): Flow {
  let flow = singleFlow();
  const assess = addAgent(flow, base, FORMS);
  flow = applyForm(
    assess.flow,
    assess.id,
    library.forms.find((f) => f.id === 'assessment') as never,
    library,
  );
  const cond = addCondition(flow);
  flow = connect(cond.flow, assess.id, cond.id);
  const yes = addAgent(flow, base, FORMS, 'report');
  const no = addAgent(yes.flow, base, FORMS, 'report');
  flow = no.flow;
  flow = connect(flow, cond.id, yes.id, 'yes');
  flow = connect(flow, cond.id, no.id, 'no');
  return flow;
}

describe('a condition in the editor', () => {
  it('is added, joined to one agent and given two exits; each step is a move the editor allows', () => {
    const flow = built();
    const condition = conditionOf(flow);
    expect(condition).toMatchObject({ id: 'condition', mode: 'all', rules: [] });
    expect(flow.edges).toContainEqual({ from: 'agent', to: 'condition', anonymous: false });
    expect(flow.edges).toContainEqual({
      from: 'condition',
      to: 'agent2',
      anonymous: false,
      gate: 'yes',
    });
    expect(flow.edges).toContainEqual({
      from: 'condition',
      to: 'agent3',
      anonymous: false,
      gate: 'no',
    });
    // a gate carries no answer: neither the condition nor its targets are a feeder of anything
    expect(agentOf(flow, 'agent2')?.required).toEqual([]);
    expect(sourceOf(flow, 'condition')?.id).toBe('agent');
    expect(maxCalls(flow)).toBe(agentsOf(flow).length);
  });

  it('names its boxes («Condition», «Condition 2») with the agents', () => {
    const flow = addCondition(built()).flow;
    const names = agentNames(flow, t as never);
    expect(names.condition).toBe('flow.cond.nameN {"n":1}');
    expect(names.condition2).toBe('flow.cond.nameN {"n":2}');
    expect(agentNames(built(), t as never).condition).toBe('flow.cond.name');
  });

  it('is refused the lines that can never be right, with the reason', () => {
    const flow = built();
    // it reads one agent; Input has no fields; a report has none either; the final answer ends the design
    expect(connectionProblem(flow, 'input', 'condition')).toBe('condition-needs-agent');
    expect(connectionProblem(flow, 'agent2', 'condition')).toBe('condition-needs-fields');
    expect(connectionProblem(flow, 'agent', 'condition')).toBe('duplicate');
    const other = addAgent(flow, base, FORMS, 'member');
    expect(connectionProblem(other.flow, other.id, 'condition')).toBe('condition-taken');
    expect(connectionProblem(flow, 'assistant', 'condition')).toBe('answer-feeds-agent');
    // a gate goes to an agent or a condition, never to Output, never twice, never back
    expect(connectionProblem(flow, 'condition', 'output', 'yes')).toBe('gate-to-output');
    expect(connectionProblem(flow, 'condition', 'agent2', 'yes')).toBe('duplicate');
    expect(connectionProblem(flow, 'condition', 'agent', 'yes')).toBe('cycle');
    expect(connectionProblem(flow, 'condition', 'agent2', 'no')).toBeNull();
    // only a condition has exits; a line from a condition always says which
    expect(connectionProblem(flow, 'agent', 'agent2', 'yes')).toBe('missing');
    expect(connectionProblem(flow, 'condition', 'assistant')).toBe('missing');
  });

  it('hides Input’s line to a box a condition leads to, and a deleted gate gives the line back when nothing else leads there', () => {
    const flow = built();
    expect(visibleEdges(flow).some((e) => e.from === 'input' && e.to === 'agent2')).toBe(false);
    expect(flow.edges.some((e) => e.from === 'input' && e.to === 'agent2')).toBe(true);
    const lost = disconnect(flow, 'condition', 'agent2', 'yes');
    expect(lost.edges.some((e) => e.from === 'condition' && e.to === 'agent2')).toBe(false);
    expect(visibleEdges(lost).some((e) => e.from === 'input' && e.to === 'agent2')).toBe(true);
    // the other exit of the same condition is untouched
    expect(
      lost.edges.some((e) => e.from === 'condition' && e.to === 'agent3' && e.gate === 'no'),
    ).toBe(true);
  });

  it('the Yes and No of one condition may lead to the same box, and each is its own line', () => {
    const flow = built();
    const both = connect(flow, 'condition', 'agent3', 'yes');
    expect(both.edges.filter((e) => e.from === 'condition' && e.to === 'agent3')).toHaveLength(2);
    const one = disconnect(both, 'condition', 'agent3', 'yes');
    expect(one.edges.filter((e) => e.from === 'condition' && e.to === 'agent3')).toEqual([
      { from: 'condition', to: 'agent3', anonymous: false, gate: 'no' },
    ]);
  });

  it('is removed with its lines; the agents it led to are kept and still lead to the answer', () => {
    const flow = removeNode(built(), 'condition');
    expect(flow.nodes.some((n) => n.kind === 'condition')).toBe(false);
    expect(flow.edges.some((e) => e.from === 'condition' || e.to === 'condition')).toBe(false);
    expect(agentOf(flow, 'agent2')).toBeDefined();
  });

  it('takes a rule from the fields of what it reads and is a valid design with the exits drawn', () => {
    let flow = built();
    const field = fieldsOfAgent(sourceOf(flow, 'condition'))[0];
    expect(field).toMatchObject({ name: 'score', kind: 'number' });
    // no rule yet: the design says so
    expect(problemOf(flow)?.reason).not.toBeNull();
    flow = setCondition(flow, 'condition', {
      rules: [{ field: 'score', op: '>=', value: 5 }],
    });
    // the two writers are alternatives: each is «one of the answers» of the final agent
    flow = setWireRole(flow, 'agent2', 'assistant', 'group');
    flow = setWireRole(flow, 'agent3', 'assistant', 'group');
    expect(agentOf(flow, 'assistant')?.responses).toEqual({ ids: ['agent2', 'agent3'], min: 1 });
    // the assessor still feeds the final agent as a required answer, as drawn by «Agent»
    expect(agentOf(flow, 'assistant')?.required).toEqual(['agent']);
    expect(problemOf(flow)).toBeNull();
  });
});

describe('the checks a rule can have', () => {
  const flow = built();
  const fields = fieldsOfAgent(sourceOf(flow, 'condition'));

  it('are the type’s own, the same strings the server holds a rule to', () => {
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ['score', 'number'],
      ['note', 'text'],
    ]);
    expect(OPS.number).toEqual(['<', '<=', '>', '>=', '=', '!=']);
    expect(OPS.boolean).toEqual(['is true', 'is false']);
    expect(OPS.choice).toEqual(['is', 'is not']);
    expect(OPS.list).toContain('count >=');
    expect(valueKind('is empty')).toBe('none');
    expect(valueKind('count <')).toBe('count');
    expect(valueKind('contains')).toBe('text');
    expect(valueKind('is')).toBe('choice');
    expect(valueKind('>=')).toBe('number');
  });

  it('a field of a built-in form is read from its schema; a nested one has no check', () => {
    const member = agentsOf(singleFlow())[0];
    expect(member).toBeDefined();
    const names = fieldsOfAgent(agentOf(addAgent(singleFlow(), base, FORMS).flow, 'agent')).map(
      (f) => f.name,
    );
    expect(names).toContain('stance');
    expect(names).toContain('claims');
    // `recommendation` is an object or null: nothing can be asked of it
    expect(names).not.toContain('recommendation');
    expect(kindOf({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('text');
    expect(kindOf({ type: 'object' })).toBeNull();
    expect(kindOf({ type: 'string', enum: ['a', 'b'] })).toBe('choice');
  });

  it('a new rule is valid; changing the field or the check keeps what still fits and repairs the rest', () => {
    const first = fields[0];
    const second = fields[1];
    if (!first || !second) throw new Error('fields');
    const rule = defaultRule(first);
    expect(rule).toEqual({ field: 'score', op: '<', value: 0 });
    expect(ruleProblem(rule, fields)).toBeNull();
    // a number rule moved to a text field: «<» is not a text check, so the first text check, with no value left over
    expect(withField({ ...rule, value: 7 }, second)).toEqual({ field: 'note', op: 'is empty' });
    expect(withOp({ field: 'note', op: 'is empty' }, second, 'contains')).toEqual({
      field: 'note',
      op: 'contains',
      value: '',
    });
    expect(withOp({ field: 'score', op: '<', value: 4 }, first, '>=')).toEqual({
      field: 'score',
      op: '>=',
      value: 4,
    });
  });

  it('says what is wrong with a rule', () => {
    expect(ruleProblem({ field: 'gone', op: '<', value: 1 }, fields)).toBe('field');
    expect(ruleProblem({ field: 'score', op: 'contains', value: 'x' }, fields)).toBe('op');
    expect(ruleProblem({ field: 'score', op: '<' }, fields)).toBe('value');
    expect(ruleProblem({ field: 'score', op: '<', value: Number.NaN }, fields)).toBe('value');
    expect(ruleProblem({ field: 'note', op: 'is empty', value: 'x' }, fields)).toBe('value');
    expect(ruleProblem({ field: 'note', op: 'equals', value: 'x' }, fields)).toBeNull();
  });
});

describe('what a line carries and how an agent uses it', () => {
  it('Only when offers valid controllers, keeps projections and dependency roles, and can return to Always', () => {
    const flow = conditionalWireFlow();
    expect(controllingConditions(flow, 'report', 'judge')).toEqual([]);
    expect(controllingConditions(flow, 'report', 'final').map((node) => node.id)).toEqual([
      'decision',
    ]);
    expect(controllingConditions(flow, 'input', 'report')).toEqual([]);
    const changed = setWireWhen(flow, 'report', 'final', { condition: 'decision', exit: 'no' });
    expect(
      changed.edges.find((edge) => edge.from === 'report' && edge.to === 'final')?.when,
    ).toEqual({ condition: 'decision', exit: 'no' });
    expect(agentOf(changed, 'final')?.responses).toEqual({ ids: ['report', 'rewriter'], min: 1 });
    const projected = setWireFields(changed, 'judge', 'rewriter', ['score']);
    const conditional = setWireWhen(projected, 'judge', 'rewriter', {
      condition: 'decision',
      exit: 'no',
    });
    expect(
      conditional.edges.find((edge) => edge.from === 'judge' && edge.to === 'rewriter'),
    ).toMatchObject({ fields: ['score'], when: { condition: 'decision', exit: 'no' } });
    expect(setWireWhen(flow, 'report', 'judge', { condition: 'decision', exit: 'yes' })).toBe(flow);
    expect(
      setWireWhen(changed, 'report', 'final', undefined).edges.find(
        (edge) => edge.from === 'report' && edge.to === 'final',
      )?.when,
    ).toBeUndefined();
    const deleted = removeNode(flow, 'decision');
    expect(deleted.edges.some((edge) => edge.when?.condition === 'decision')).toBe(false);
    expect(deleted.edges.some((edge) => edge.from === 'report' && edge.to === 'final')).toBe(false);
    const invalid = structuredClone(flow);
    const edge = invalid.edges.find((item) => item.when);
    if (!edge) throw new Error('fixture');
    edge.when = { condition: 'missing', exit: 'yes' };
    const problem = problemOf(invalid);
    if (!problem) throw new Error('fixture');
    expect(problem).toMatchObject({ reason: 'when', ids: ['report', 'final'] });
    expect(
      describeProblem(
        problem,
        invalid,
        agentNames(invalid, t as never),
        t as never,
        (note) => note.message,
      ),
    ).toContain('flow.problem.when');
  });
  it('narrows to some fields, drops a field its source no longer has, and carries everything when all are chosen', () => {
    let flow = built();
    flow = setWireRole(flow, 'agent', 'assistant', 'group');
    expect(wireFields(flow, 'agent', 'assistant')).toEqual(['score', 'note']);
    flow = setWireFields(flow, 'agent', 'assistant', ['note']);
    expect(flow.edges.find((e) => e.from === 'agent' && e.to === 'assistant')?.fields).toEqual([
      'note',
    ]);
    // choosing every field is the whole answer again
    flow = setWireFields(flow, 'agent', 'assistant', ['note', 'score']);
    expect(
      flow.edges.find((e) => e.from === 'agent' && e.to === 'assistant')?.fields,
    ).toBeUndefined();
    // the source changes form: a field it no longer has leaves the line, and a line with none left carries everything
    flow = setWireFields(flow, 'agent', 'assistant', ['note']);
    const member = library.forms.find((f) => f.id === 'member');
    if (!member) throw new Error('member');
    const changed = applyForm(flow, 'agent', member as never, library);
    expect(
      changed.edges.find((e) => e.from === 'agent' && e.to === 'assistant')?.fields,
    ).toBeUndefined();
    expect(problemOf(changed)?.reason).not.toBe('fields');
  });

  it('has no fields to pick for Input, a report, a gate or a line into a condition', () => {
    const flow = built();
    expect(wireFields(flow, 'input', 'agent')).toBeNull();
    expect(wireFields(flow, 'agent2', 'assistant')).toBeNull();
    expect(wireFields(flow, 'condition', 'agent2')).toBeNull();
    expect(wireFields(flow, 'agent', 'condition')).toBeNull();
    expect(wireFields(flow, 'agent', 'assistant')).toEqual(['score', 'note']);
  });

  it('a wire is required or one of the answers; only a design with a condition keeps the choice', () => {
    const flow = built();
    // drawn from a report, it is a required draft by default
    expect(wireRole(flow, 'agent2', 'assistant')).toBe('required');
    const group = setWireRole(flow, 'agent2', 'assistant', 'group');
    expect(wireRole(group, 'agent2', 'assistant')).toBe('group');
    expect(agentOf(group, 'assistant')?.responses).toEqual({ ids: ['agent2'], min: 1 });
    const back = setWireRole(group, 'agent2', 'assistant', 'required');
    expect(wireRole(back, 'agent2', 'assistant')).toBe('required');
    expect(agentOf(back, 'assistant')?.responses?.ids ?? []).not.toContain('agent2');
    // without a condition the role follows from the form again
    const plain = normalizeFlow({
      ...group,
      nodes: group.nodes.filter((n) => n.kind !== 'condition'),
      edges: group.edges.filter((e) => e.from !== 'condition' && e.to !== 'condition'),
    });
    expect(wireRole(plain, 'agent2', 'assistant')).toBe('required');
  });

  it('a custom form answers as a member does, not as a chairman', () => {
    expect(roleFor('assessment', false)).toBe('member');
    expect(roleFor('assessment', true)).toBe('critic');
    expect(roleFor('report', false)).toBe('writer');
    expect(roleFor('answer', true)).toBe('rewriter');
    expect(agentOf(built(), 'agent')?.role).toBe('member');
  });
});

describe('the Yes and No sit the way round the layout says', () => {
  it('puts the Yes target before the No target in the row, and the condition is as wide as an agent', () => {
    const flow = built();
    const places = layoutFlow(flow, false);
    expect((places.agent2 as { x: number }).x).toBeLessThan((places.agent3 as { x: number }).x);
    expect(sizeOf('condition').width).toBe(sizeOf('agent').width);
    // swapped nodes keep the same sides: Yes first whatever the order of the boxes
    const swapped: Flow = {
      ...flow,
      nodes: [...flow.nodes].sort((a, b) => (a.id === 'agent3' ? -1 : b.id === 'agent3' ? 1 : 0)),
    };
    const again = layoutFlow(swapped, false);
    expect((again.agent2 as { x: number }).x).toBeLessThan((again.agent3 as { x: number }).x);
    // mirrored for a right-to-left interface: Yes at the start, which is the right
    const mirrored = layoutFlow(flow, true);
    expect((mirrored.agent2 as { x: number }).x).toBeGreaterThan(
      (mirrored.agent3 as { x: number }).x,
    );
    const depth = depthsOf(flow) as Record<string, number>;
    expect(depth.agent2).toBe((depth.condition as number) + 1);
  });
});

describe('the new checks of a design appear as problems, in words', () => {
  const names = (flow: Flow) => agentNames(flow, t as never);
  const word = (note: { message: string }) => note.message;
  const say = (flow: Flow) => {
    const problem = problemOf(flow);
    if (!problem) throw new Error('no problem');
    return { problem, text: describeProblem(problem, flow, names(flow), t as never, word) };
  };
  const valid = (): Flow => {
    let flow = built();
    flow = setCondition(flow, 'condition', { rules: [{ field: 'score', op: '>=', value: 5 }] });
    flow = setWireRole(flow, 'agent2', 'assistant', 'group');
    return setWireRole(flow, 'agent3', 'assistant', 'group');
  };

  it('a condition with no rule, a field its input does not have, a check or value that is not allowed', () => {
    const empty = setCondition(valid(), 'condition', { rules: [] });
    expect(say(empty)).toMatchObject({
      problem: { reason: 'condition rules', ids: ['condition'] },
      text: 'flow.problem.condRules {"name":"flow.cond.name"}',
    });
    const gone = setCondition(valid(), 'condition', {
      rules: [{ field: 'verdict', op: 'is empty' }],
    });
    expect(say(gone)).toMatchObject({
      problem: { reason: 'condition field', ids: ['condition', 'agent'] },
    });
    expect(say(gone).text).toContain('flow.problem.condField');
    const wrongOp = setCondition(valid(), 'condition', {
      rules: [{ field: 'score', op: 'contains', value: 'x' }],
    });
    expect(say(wrongOp).problem.reason).toBe('condition operator');
    const noValue = setCondition(valid(), 'condition', { rules: [{ field: 'score', op: '>=' }] });
    expect(say(noValue).problem.reason).toBe('condition value');
  });

  it('a condition that reads nothing, or has one exit, or reads a report', () => {
    const flow = valid();
    const unread = disconnect(flow, 'agent', 'condition');
    expect(say(unread).problem.reason).toBe('unreachable or dead end');
    // reconnect through a report: the editor refuses the line, so the design is checked through the data
    const oneExit = disconnect(flow, 'condition', 'agent3', 'no');
    expect(say(oneExit).problem).toMatchObject({ reason: 'condition exits', ids: ['condition'] });
    const report = {
      ...flow,
      edges: flow.edges.map((e) => (e.to === 'condition' ? { ...e, from: 'agent2' } : e)),
    };
    expect(['condition input', 'cycle', 'dependency declaration']).toContain(
      say(report).problem.reason,
    );
  });

  it('a line that carries fields its source does not have, and a gate that does not start at a condition', () => {
    const flow = valid();
    const withFields = {
      ...flow,
      edges: flow.edges.map((e) =>
        e.from === 'agent' && e.to === 'assistant' ? { ...e, fields: ['verdict'] } : e,
      ),
    };
    expect(say(withFields).problem).toMatchObject({
      reason: 'fields',
      ids: ['agent', 'assistant'],
    });
    expect(say(withFields).text).toContain('flow.problem.fields');
    const badGate = {
      ...flow,
      edges: flow.edges.map((e) =>
        e.from === 'agent' && e.to === 'condition' ? { ...e, gate: 'yes' as const } : e,
      ),
    };
    expect(say(badGate).problem).toMatchObject({ reason: 'gate', ids: ['agent', 'condition'] });
    expect(say(badGate).text).toContain('flow.problem.gate');
  });

  it('a design with a condition and no rule is not valid, with one it is, and a second final answer is refused', () => {
    expect(problemOf(valid())).toBeNull();
    // the agent that feeds Output must have the final answer form
    const member = library.forms.find((f) => f.id === 'member');
    if (!member) throw new Error('member');
    const notFinal = applyForm(valid(), 'assistant', member as never, library);
    expect(problemOf(notFinal)?.reason).toBe('one final answer producer required');
  });
});

describe('what a picker offers', () => {
  const flow = built();
  const agent = agentOf(flow, 'agent');
  if (!agent) throw new Error('agent');

  it('lists the prompts written for the agent’s form and its inputs, and the one it has', () => {
    const context = contextOf(flow, agent);
    // it feeds the condition and (as drawn by «Agent») the final agent; nothing leads into it but the question
    expect(context).toEqual({
      withInputs: false,
      feedsOutput: false,
      feedsAgent: true,
      feedsCondition: true,
    });
    const ids = promptsFor(library, agent, context).map((p) => p.id);
    expect(ids).toContain('check');
    expect(ids).toContain(agent.prompt);
    // a prompt for the chairman (with inputs, for the answer form) does not fit an assessor
    expect(ids).not.toContain('divan.chairman');
    expect(promptsFor(library, agent, context, true).map((p) => p.id)).toContain('divan.chairman');
  });

  it('lists the forms this place allows: not Report or the final answer for what a condition reads', () => {
    const forms = formsFor(library, agent, contextOf(flow, agent)).map((f) => f.id);
    expect(forms).toContain('assessment');
    expect(forms).toContain('member');
    expect(forms).not.toContain('report');
    expect(forms).not.toContain('answer');
    const final = agentOf(flow, 'assistant');
    if (!final) throw new Error('final');
    // the agent that gives the final answer can only have the final answer form
    expect(formsFor(library, final, contextOf(flow, final)).map((f) => f.id)).toEqual(['answer']);
  });

  it('picks a prompt that fits when the form changes, and keeps one that still does', () => {
    const member = agentOf(addAgent(singleFlow(), base, FORMS).flow, 'agent');
    if (!member) throw new Error('member');
    expect(promptAfterForm(library, member, 'report', false)?.id).toBe('divan.report');
    expect(promptAfterForm(library, member, 'assessment', false)?.id).toBe('check');
    // a prompt written for the new form wins; «Check» is written for any form, so it stays only where none is
    const checked = { ...member, prompt: 'check' };
    expect(promptAfterForm(library, checked, 'report', false)?.id).toBe('divan.report');
    expect(promptAfterForm(library, checked, 'assessment', false)?.id).toBe('check');
    // one the person wrote for the new form is kept
    const own = libraryView(
      {
        ...branchLibrary,
        prompts: [
          ...branchLibrary.prompts,
          {
            id: 'mine',
            name: 'Mine',
            form: 'report',
            inputs: 'any',
            text: 'My report.',
            revision: 1,
          },
        ],
      },
      [],
    );
    expect(promptAfterForm(own, { ...member, prompt: 'mine' }, 'report', false)?.id).toBe('mine');
    expect(promptAfterForm(own, { ...member, prompt: 'check' }, 'report', false)?.id).toBe(
      'divan.report',
    );
  });

  it('writes the picked form and prompt into the agent: its schema, its form data and a fitting prompt', () => {
    const assessment = library.forms.find((f) => f.id === 'assessment');
    if (!assessment) throw new Error('assessment');
    const flow2 = applyForm(
      addAgent(singleFlow(), base, FORMS).flow,
      'agent',
      assessment as never,
      library,
    );
    const set = agentOf(flow2, 'agent');
    expect(set?.form).toBe('assessment');
    expect(set?.formInfo).toMatchObject({ name: 'Assessment', revision: 1 });
    expect(Object.keys(set?.schema.properties ?? {})).toEqual(['score', 'note']);
    expect(set?.prompt).toBe('check');
    const prompt = library.prompts.find((p) => p.id === 'divan.report');
    if (!prompt) throw new Error('prompt');
    const again = agentOf(applyPrompt(flow2, 'agent', prompt), 'agent');
    expect(again?.prompt).toBe('divan.report');
    expect(again?.rules).toBe(prompt.text);
  });

  it('says in one line what an entry is', () => {
    expect(promptPreview('\n\n## Rules\n\n**Be** brief.\nMore.')).toBe('Rules');
    expect(promptPreview('x'.repeat(300)).length).toBeLessThanOrEqual(110);
    expect(formPreview({ schema: { type: 'object', properties: { score: {}, note: {} } } })).toBe(
      'score, note',
    );
  });
});
