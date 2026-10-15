import { describe, expect, it } from 'vitest';
import { progressLine } from '../src/server/openai.ts';
import { chairmanSchemaFor, memberSchemaFor } from '../src/server/prompts.ts';
import {
  agentsOf,
  chairmanOf,
  compileCouncil,
  type Flow,
  type FlowStep,
  finalInputsReady,
  scheduleFlow,
  seatsOf,
  validateFlow,
} from '../src/shared/flow.ts';
import { flowInput, singleFlow, writerFlow } from './fixtures/flows.ts';
import { chairNode, sessionOf, userNode } from './fixtures.ts';

describe('flow validation and scheduling', () => {
  it('accepts an agy model slug and rejects a display name at admission', () => {
    const flow = singleFlow();
    const agent = agentsOf(flow)[0];
    if (!agent) throw new Error('missing fixture agent');
    agent.harness = 'agy';
    agent.model = 'gemini-3.8-flash';
    agent.effort = '';
    expect(() => validateFlow(flow)).not.toThrow();
    agent.model = 'Gemini 3.8 Flash (High)';
    expect(() => validateFlow(flow)).toThrow();
  });
  it('accepts three nodes and a final answer with no agent inputs', () => {
    const flow = singleFlow();
    expect(flow.nodes).toHaveLength(3);
    expect(() => validateFlow(flow)).not.toThrow();
    expect(agentsOf(flow)[0]).toMatchObject({ required: [], form: 'answer', web: false });
    expect(agentsOf(flow)[0]?.responses).toBeUndefined();
    expect(finalInputsReady(flow, { seats: [] })).toEqual({ answers: 0, minimum: 0, enough: true });
  });
  it('custom flow progress follows the question language, including roles and failure reasons', () => {
    expect(progressLine({ type: 'seat-start', label: 'A', identity: 'Writer' }, 'fa')).toBe(
      'نویسنده شروع کرد.',
    );
    expect(
      progressLine({ type: 'seat-done', label: 'B', stance: '', identity: 'Critic 2' }, 'fa'),
    ).toBe('منتقد 2 پاسخ داد.');
    expect(
      progressLine(
        { type: 'seat-failed', label: 'B', reason: 'invalid', identity: 'Critic 2' },
        'fa',
      ),
    ).toBe('منتقد 2 پاسخ نداد (خروجی نامعتبر).');
    expect(progressLine({ type: 'chairman', answers: 2, identity: 'Rewriter' }, 'fa')).toBe(
      'بازنویس در حال خواندن 2 پاسخ است.',
    );
    expect(progressLine({ type: 'seat-note', label: 'B', identity: 'Critic 2' }, 'fa')).toBe(
      'منتقد 2 بدون پوشهٔ پروژه پاسخ داد.',
    );
    expect(progressLine({ type: 'seat-start', label: 'A', identity: 'Writer' }, 'en')).toBe(
      'Writer started.',
    );
  });
  it('accepts both layouts, including the stored council rules and schemas', () => {
    const settings = sessionOf([userNode('u0', null, 'Q')]).settings;
    settings.seats = flowInput().seats;
    settings.memberSchema = memberSchemaFor(settings.budgets);
    settings.chairmanSchema = chairmanSchemaFor(settings.budgets);
    const council = compileCouncil(settings);
    expect(() => validateFlow(council)).not.toThrow();
    expect(agentsOf(council)[0]?.rules).toBe(settings.rules);
    expect(agentsOf(council).at(-1)?.schema).toBe(settings.chairmanSchema);
    expect(() => validateFlow(writerFlow())).not.toThrow();
  });

  it.each([
    ['cycle', (flow: Flow) => flow.edges.push({ from: 'rewriter', to: 'writer', anonymous: true })],
    ['duplicate', (flow: Flow) => flow.nodes.push(flow.nodes[1] as Flow['nodes'][number])],
    [
      'dangling',
      (flow: Flow) => flow.edges.push({ from: 'absent', to: 'writer', anonymous: true }),
    ],
    ['unreachable', (flow: Flow) => flow.nodes.push({ id: 'alone', kind: 'input' })],
    [
      'dead end',
      (flow: Flow) => {
        flow.edges = flow.edges.filter((edge) => edge.from !== 'critic3');
      },
    ],
    [
      'minimum',
      (flow: Flow) => {
        const agent = agentsOf(flow).at(-1);
        if (agent?.responses) agent.responses.min = 4;
      },
    ],
    [
      'form',
      (flow: Flow) => {
        const agent = agentsOf(flow).at(-1);
        if (agent) agent.form = 'report';
      },
    ],
    [
      'web',
      (flow: Flow) => {
        const agent = agentsOf(flow).at(-1);
        if (agent) agent.web = true;
      },
    ],
    [
      'size',
      (flow: Flow) => {
        while (flow.nodes.length < 19)
          flow.nodes.push({ id: `n${flow.nodes.length}`, kind: 'input' });
      },
    ],
  ] as const)('rejects %s before admission', (_name, damage) => {
    const flow = writerFlow();
    damage(flow);
    expect(() => validateFlow(flow)).toThrow(/invalid flow/u);
  });

  it('waits for all peers; the draft never counts toward the critic quorum; blocked dependencies propagate', () => {
    const flow = writerFlow();
    const template = chairNode('c1', 'u0', 1);
    const templateSeat = seatsOf(template)[0];
    if (!templateSeat) throw new Error('fixture missing seat');
    const steps = agentsOf(flow).map((agent): FlowStep => {
      const base = { id: agent.id, aliases: {}, inputs: [], attempts: [] };
      if (agent.form === 'answer')
        return {
          ...base,
          form: 'answer',
          output: null,
          run: { ...chairmanOf(template), state: 'pending' },
        };
      const run = {
        ...templateSeat,
        state: 'pending' as const,
        parsed: null,
        sanitized: null,
      };
      return agent.form === 'member'
        ? { ...base, form: 'member', run }
        : { ...base, form: 'report', run };
    });
    expect(scheduleFlow(flow, steps).ready).toEqual(['writer']);
    const writer = steps[0] as Extract<FlowStep, { form: 'report' }>;
    writer.run.state = 'done';
    writer.run.sanitized = { report: 'DRAFT' };
    expect(finalInputsReady(flow, { steps })).toEqual({ answers: 0, minimum: 2, enough: false });
    expect(scheduleFlow(flow, steps).ready).toEqual(['critic1', 'critic2', 'critic3']);
    const critic = steps[1] as Extract<FlowStep, { form: 'member' }>;
    critic.run.state = 'done';
    critic.run.sanitized = { report: 'CRITIC' } as typeof critic.run.sanitized;
    expect(finalInputsReady(flow, { steps })).toEqual({ answers: 1, minimum: 2, enough: false });
    const last = steps[3] as Extract<FlowStep, { form: 'member' }>;
    last.run.state = 'done';
    last.run.sanitized = critic.run.sanitized;
    expect(finalInputsReady(flow, { steps }).enough).toBe(true);
    const final = agentsOf(flow).at(-1);
    if (final?.responses) final.responses.min = 3;
    expect(finalInputsReady(flow, { steps }).enough).toBe(false);
    if (final?.responses) final.responses.min = 2;
    writer.run.state = 'failed';
    expect(finalInputsReady(flow, { steps }).enough).toBe(false);
    writer.run.state = 'done';
    last.run.state = 'pending';
    (steps[2] as FlowStep).run.state = 'failed';
    expect(scheduleFlow(flow, steps).ready).toEqual(['critic3']);
    (steps[3] as FlowStep).run.state = 'skipped';
    expect(scheduleFlow(flow, steps).blocked).toEqual(['rewriter']);
    writer.run.state = 'failed';
    expect(scheduleFlow(flow, steps).ready).toEqual([]);
  });
});
