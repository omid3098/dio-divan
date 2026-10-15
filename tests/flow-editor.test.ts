import { branchFlow } from './fixtures/flows.ts';
// The editing of a flow design (web/src/pages/councils/design): the moves that keep a design consistent while it is drawn, the
// verdict (which is `validateFlow`'s, never a second validation) with the boxes it is about, the layout, the words of a problem,
// and what the council form saves for a design. Pure functions only: the canvas itself is in e2e/run.mjs.

import { describe, expect, it } from 'vitest';
import { flowForms } from '../src/server/flow-templates.ts';
import { agentsOf, canonicalFlow, type Flow, FlowError, validateFlow } from '../src/shared/flow.ts';
import { blockerOf, describeProblem } from '../web/src/pages/councils/design/describe.ts';
import {
  addAgent,
  agentOf,
  clearPlaces,
  connect,
  connectionProblem,
  depthsOf,
  disconnect,
  type FormDefaults,
  normalizeFlow,
  patchAgent,
  problemOf,
  removeNode,
  setForm,
  setLabel,
  setMinimum,
  setPlaces,
  syncAnswerRules,
  visibleEdges,
} from '../web/src/pages/councils/design/edit.ts';
import { layoutFlow } from '../web/src/pages/councils/design/layout.ts';
import { agentNames } from '../web/src/pages/councils/design/names.ts';
import { singleFlow, writerFlow } from './fixtures/flows.ts';

const FORMS: FormDefaults = (() => {
  const flow = writerFlow();
  const of = (form: 'report' | 'member' | 'answer') => {
    const agent = agentsOf(flow).find((item) => item.form === form);
    if (!agent) throw new Error(form);
    return { rules: agent.rules, schema: agent.schema };
  };
  return {
    report: of('report'),
    member: of('member'),
    answer: { ...of('answer'), directRules: flowForms().answer.directRules },
  };
})();
const word = (note: { message: string }) => note.message;
const t = (key: string, params?: Record<string, string | number>) =>
  params ? `${key} ${JSON.stringify(params)}` : key;

describe('a design stays consistent while it is edited', () => {
  it('answer prompts follow inputs, while an edited prompt survives wiring and form changes', () => {
    const forms = flowForms();
    const single = singleFlow();
    expect(agentOf(single, 'assistant')?.rules).toBe(forms.answer.directRules);
    const made = addAgent(single, { harness: 'pi', model: 'fake-1', effort: 'medium' }, forms);
    expect(agentOf(made.flow, 'assistant')?.rules).toBe(forms.answer.rules);
    const direct = syncAnswerRules(removeNode(made.flow, made.id), forms);
    expect(agentOf(direct, 'assistant')?.rules).toBe(forms.answer.directRules);
    const edited = {
      ...direct,
      nodes: direct.nodes.map((node) =>
        node.kind === 'agent' ? { ...node, rules: 'My own prompt' } : node,
      ),
    };
    expect(
      agentOf(
        addAgent(edited, { harness: 'pi', model: 'fake-1', effort: 'medium' }, forms).flow,
        'assistant',
      )?.rules,
    ).toBe('My own prompt');
    expect(agentOf(setForm(edited, 'assistant', 'report', forms), 'assistant')?.rules).toBe(
      'My own prompt',
    );
    expect(agentOf(setForm(single, 'assistant', 'report', forms), 'assistant')?.rules).toBe(
      forms.report.rules,
    );
    const converted = setForm(
      setForm(single, 'assistant', 'report', forms),
      'assistant',
      'answer',
      forms,
    );
    expect(agentOf(converted, 'assistant')?.rules).toBe(forms.answer.directRules);
  });
  it('leaves a valid design as it is: the declarations already follow from the lines', () => {
    const flow = writerFlow();
    expect(canonicalFlow(normalizeFlow(flow))).toBe(canonicalFlow(flow));
    expect(problemOf(flow)).toBeNull();
  });

  it('a new agent joins the answer of the final agent and Input feeds it; the design stays valid', () => {
    const { flow, id } = addAgent(
      writerFlow(),
      { harness: 'pi', model: 'fake-1', effort: 'low' },
      FORMS,
    );
    expect(problemOf(flow)).toBeNull();
    const rewriter = agentOf(flow, 'rewriter');
    expect(rewriter?.responses?.ids).toContain(id);
    // the minimum is kept, not raised
    expect(rewriter?.responses?.min).toBe(2);
    expect(agentOf(flow, id)).toMatchObject({
      form: 'member',
      role: 'member',
      tools: false,
      web: false,
    });
    expect(flow.edges).toContainEqual({ from: 'input', to: id, anonymous: false });
    expect(flow.edges).toContainEqual({ from: id, to: 'rewriter', anonymous: true });
    // it comes after the boxes of its row, before the agent that gives the final answer
    const order = flow.nodes.map((node) => node.id);
    expect(order.indexOf(id)).toBe(order.indexOf('rewriter') - 1);
  });

  it('removing an agent takes its lines, keeps the minimum within the group and never leaves a box without a way in', () => {
    let flow = writerFlow();
    flow = removeNode(flow, 'critic3');
    flow = removeNode(flow, 'critic2');
    expect(agentOf(flow, 'rewriter')?.responses).toEqual({ ids: ['critic1'], min: 1 });
    expect(problemOf(flow)).toBeNull();
    // the only agent that fed a box is gone: Input feeds it again
    const lonely = removeNode(writerFlow(), 'writer');
    expect(lonely.edges.filter((edge) => edge.to === 'critic1').map((edge) => edge.from)).toEqual([
      'input',
    ]);
    expect(agentOf(lonely, 'critic1')?.required).toEqual([]);
    expect(agentOf(lonely, 'critic1')?.role).toBe('member');
    // Input and Output stay
    expect(removeNode(writerFlow(), 'output').nodes).toHaveLength(writerFlow().nodes.length);
  });

  it('drawing and deleting a line moves the declarations: a report is a required draft, member answers are a group', () => {
    let flow = disconnect(writerFlow(), 'writer', 'critic2');
    expect(agentOf(flow, 'critic2')).toMatchObject({ required: [], role: 'member' });
    flow = connect(flow, 'writer', 'critic2');
    expect(agentOf(flow, 'critic2')).toMatchObject({ required: ['writer'], role: 'critic' });
    expect(flow.edges).toContainEqual({ from: 'writer', to: 'critic2', anonymous: true });
    expect(problemOf(flow)).toBeNull();
    // taking the last line to a box brings Input back
    const cut = disconnect(disconnect(writerFlow(), 'critic1', 'rewriter'), 'critic2', 'rewriter');
    expect(agentOf(cut, 'rewriter')?.responses).toEqual({ ids: ['critic3'], min: 1 });
  });

  it('a minimum cannot leave its group', () => {
    const flow = writerFlow();
    expect(agentOf(setMinimum(flow, 'rewriter', 3), 'rewriter')?.responses?.min).toBe(3);
    expect(agentOf(setMinimum(flow, 'rewriter', 9), 'rewriter')?.responses?.min).toBe(3);
    expect(agentOf(setMinimum(flow, 'rewriter', 0), 'rewriter')?.responses?.min).toBe(1);
  });

  it('another output form takes that form’s prompt and schema, and its role; the final agent never gets web', () => {
    let flow = writerFlow();
    flow = setForm(flow, 'critic1', 'report', FORMS);
    expect(agentOf(flow, 'critic1')).toMatchObject({
      form: 'report',
      role: 'writer',
      rules: FORMS.report.rules,
    });
    // it feeds the rewriter as a draft now, not as one of the answers
    expect(agentOf(flow, 'rewriter')?.required).toContain('critic1');
    expect(agentOf(flow, 'rewriter')?.responses?.ids).not.toContain('critic1');
    const web = { ...writerFlow() };
    const writer = agentOf(web, 'writer');
    expect(writer).toBeDefined();
    const toAnswer = setForm(
      {
        ...web,
        nodes: web.nodes.map((node) =>
          node.id === 'writer' ? { ...(node as object), web: true } : node,
        ) as Flow['nodes'],
      },
      'writer',
      'answer',
      FORMS,
    );
    expect(agentOf(toAnswer, 'writer')?.web).toBe(false);
  });

  it('a name is kept apart from the executable design and an empty one takes it away', () => {
    const named = setLabel(writerFlow(), 'writer', 'The drafter');
    expect(agentOf(named, 'writer')?.label).toBe('The drafter');
    expect(canonicalFlow(named)).toBe(canonicalFlow(writerFlow()));
    expect(agentOf(setLabel(named, 'writer', ''), 'writer')).not.toHaveProperty('label');
    expect(agentNames(named, t as never).writer).toBe('The drafter');
    expect(agentNames(writerFlow(), t as never)).toMatchObject({
      writer: 'flow.role.writer',
      critic1: 'flow.role.critic 1',
      critic3: 'flow.role.critic 3',
      rewriter: 'flow.role.rewriter',
    });
  });
});

describe('a line that can never be right is refused, with the reason', () => {
  const flow = writerFlow();
  it.each([
    ['writer', 'writer', 'self'],
    ['critic1', 'writer', 'cycle'],
    ['rewriter', 'writer', 'answer-feeds-agent'],
    ['critic1', 'rewriter', 'duplicate'],
    ['output', 'writer', 'from-output'],
    ['writer', 'input', 'to-input'],
    ['writer', 'output', 'output-needs-answer'],
    ['critic1', 'output', 'output-needs-answer'],
    ['rewriter', 'output', 'duplicate'],
    ['input', 'critic1', 'duplicate'],
    ['rewriter', 'critic1', 'answer-feeds-agent'],
    ['writer', 'nowhere', 'missing'],
  ])('%s to %s: %s', (from, to, why) => {
    expect(connectionProblem(flow, from as string, to as string)).toBe(why);
  });

  it('Input needs no line to a box that other agents feed', () => {
    const cut = disconnect(
      {
        ...writerFlow(),
        edges: writerFlow().edges.filter((edge) => edge.to !== 'critic1' || edge.from !== 'input'),
      },
      'writer',
      'critic1',
    );
    // the writer's line is gone, so Input feeds it again (and that is not redundant)
    expect(connectionProblem(cut, 'input', 'critic1')).toBe('duplicate');
    expect(connectionProblem(writerFlow(), 'input', 'critic1')).toBe('duplicate');
    const fed = {
      ...writerFlow(),
      edges: writerFlow().edges.filter((edge) => !(edge.from === 'input' && edge.to === 'critic1')),
    };
    expect(connectionProblem(fed, 'input', 'critic1')).toBe('input-redundant');
  });

  it('allows what a design can have: a draft to a critic, a second critic into the group, Input to a box nothing feeds', () => {
    const open = disconnect(writerFlow(), 'writer', 'critic1');
    expect(connectionProblem(open, 'writer', 'critic1')).toBeNull();
    const alone = disconnect(writerFlow(), 'critic1', 'rewriter');
    expect(connectionProblem(alone, 'critic1', 'rewriter')).toBeNull();
    // Output takes only one line: a second agent that gives the answer must wait for the first to go
    const made = setForm(writerFlow(), 'critic1', 'answer', FORMS);
    expect(connectionProblem(made, 'critic1', 'output')).toBe('output-taken');
  });
});

describe('the verdict is validateFlow’s, with the boxes it is about', () => {
  it('names the box that is left out', () => {
    const flow = disconnect(disconnect(writerFlow(), 'critic3', 'rewriter'), 'writer', 'critic3');
    // Input still feeds it, but nothing leads from it to Output
    const problem = problemOf(flow);
    expect(problem?.reason).toBe('unreachable or dead end');
    expect(problem?.ids).toEqual(['critic3']);
    expect(
      describeProblem(problem as never, flow, agentNames(flow, t as never), t as never, word),
    ).toContain('flow.problem.lost');
  });

  it('says no box gives the final answer when the form is not the final one', () => {
    const flow = setForm(writerFlow(), 'rewriter', 'member', FORMS);
    const problem = problemOf(flow);
    expect(problem?.reason).toBe('one final answer producer required');
    expect(problem?.ids).toContain('rewriter');
  });

  it('refuses a design with an agent that is switched off and needed (the rewriter waits for a draft)', () => {
    const flow = writerFlow();
    const off = {
      ...flow,
      nodes: flow.nodes.map((node) =>
        node.id === 'writer' ? { ...(node as object), enabled: false } : node,
      ),
    } as Flow;
    const problem = problemOf(off);
    expect(problem?.reason).toBe('disabled prerequisite');
    expect(problem?.ids).toEqual(['critic1']);
  });

  it('the blocker of the form is the first problem, on Base before any level', () => {
    const ok = writerFlow();
    const broken = removeNode(ok, 'rewriter');
    const form = {
      base: { flow: broken },
      levels: { low: { flow: ok }, medium: { flow: ok }, high: { flow: ok }, max: { flow: ok } },
    };
    const none = { low: false, medium: false, high: false, max: false };
    expect(blockerOf(form, none, t as never, word)).toContain('flow.problem');
    expect(blockerOf({ ...form, base: { flow: ok } }, none, t as never, word)).toBeNull();
    // a level the user changed is checked too
    const bad = {
      ...form,
      base: { flow: ok },
      levels: { ...form.levels, low: { flow: broken } },
    };
    expect(blockerOf(bad, { ...none, low: true }, t as never, word)).toContain(
      'flow.problem.atLevel',
    );
    expect(blockerOf(bad, none, t as never, word)).toBeNull();
  });
});

describe('what is drawn', () => {
  it('draws no line from Input to a box that other agents feed', () => {
    const flow = writerFlow();
    const drawn = visibleEdges(flow).map((edge) => `${edge.from}>${edge.to}`);
    expect(drawn).toContain('input>writer');
    expect(drawn.some((edge) => edge.startsWith('input>critic'))).toBe(false);
    expect(flow.edges.some((edge) => edge.from === 'input' && edge.to === 'critic1')).toBe(true);
    // the draft goes round: it skips the row of critics
    const depth = depthsOf(flow);
    expect((depth.rewriter as number) - (depth.writer as number)).toBe(2);
    expect((depth.critic1 as number) - (depth.writer as number)).toBe(1);
  });

  it('lays the design out top to bottom, a row in the design’s order, mirrored in a right-to-left interface', () => {
    const flow = writerFlow();
    const ltr = layoutFlow(flow, false);
    expect((ltr.input?.y as number) < (ltr.writer?.y as number)).toBe(true);
    expect((ltr.writer?.y as number) < (ltr.critic1?.y as number)).toBe(true);
    expect((ltr.critic3?.y as number) < (ltr.rewriter?.y as number)).toBe(true);
    expect((ltr.rewriter?.y as number) < (ltr.output?.y as number)).toBe(true);
    expect((ltr.critic1?.x as number) < (ltr.critic2?.x as number)).toBe(true);
    expect((ltr.critic2?.x as number) < (ltr.critic3?.x as number)).toBe(true);
    const rtl = layoutFlow(flow, true);
    expect((rtl.critic1?.x as number) > (rtl.critic2?.x as number)).toBe(true);
    expect((rtl.critic2?.x as number) > (rtl.critic3?.x as number)).toBe(true);
  });

  it('a box that was moved keeps the place saved in the design; Arrange takes every place away', () => {
    const moved = setPlaces(writerFlow(), { writer: { x: 401.4, y: 250.2 } });
    expect(layoutFlow(moved, false).writer).toEqual({ x: 401, y: 250 });
    expect(layoutFlow(moved, true).writer).toEqual({ x: 401, y: 250 });
    // a place is not part of what runs
    expect(canonicalFlow(moved)).toBe(canonicalFlow(writerFlow()));
    const cleared = clearPlaces(moved);
    expect(cleared.nodes.some((node) => 'position' in node)).toBe(false);
  });
});

describe('what the editor takes from the server side', () => {
  it('a refused design says why and which boxes: the same error, the same message as before', () => {
    const cycle = writerFlow();
    cycle.edges.push({ from: 'critic1', to: 'writer', anonymous: false });
    let caught: unknown;
    try {
      validateFlow(cycle);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FlowError);
    expect((caught as Error).message).toBe('invalid flow: cycle');
    expect((caught as FlowError).reason).toBe('cycle');
    expect((caught as FlowError).ids.sort()).toEqual(['critic1', 'writer']);
    const lost = disconnect(disconnect(writerFlow(), 'critic3', 'rewriter'), 'writer', 'critic3');
    expect(() => validateFlow(lost)).toThrow(/unreachable or dead end/u);
    try {
      validateFlow(lost);
    } catch (error) {
      expect((error as FlowError).ids).toEqual(['critic3']);
    }
  });

  it('serves the standard prompt and schema of each output form', () => {
    const forms = flowForms();
    expect(Object.keys(forms).sort()).toEqual(['answer', 'member', 'report']);
    expect(Object.keys(forms.report.schema.properties)).toEqual(['report']);
    expect(forms.member.schema.properties).toHaveProperty('claims');
    expect(forms.answer.schema.properties).toHaveProperty('answer');
    for (const form of Object.values(forms)) expect(form.rules.trim()).not.toBe('');
  });
});

it('an inspector edit preserves the response join of alternative report branches', () => {
  const flow = branchFlow();
  const edited = patchAgent(flow, 'yes', { effort: 'high' });
  expect(agentOf(edited, 'final')?.responses).toEqual({ ids: ['yes', 'no'], min: 1 });
  expect(agentOf(edited, 'final')?.required).toEqual([]);
});
