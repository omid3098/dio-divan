import type { CreateInput } from '../../src/server/engine.ts';
import { flowTemplate } from '../../src/server/flow-templates.ts';
import { resolveFlow } from '../../src/server/library.ts';
import {
  CRITIC_TASK,
  chairmanRules,
  chairmanSchemaFor,
  memberRules,
  memberSchemaFor,
  REPORT_RULES,
  reportSchemaFor,
} from '../../src/server/prompts.ts';
import type { Flow, FlowAgent } from '../../src/shared/flow.ts';
import type { Library } from '../../src/shared/library.ts';

export const branchLibrary: Library = {
  prompts: [
    {
      id: 'check',
      name: 'Check',
      form: null,
      inputs: 'any',
      text: 'Assess the question. Return the requested fields.',
      revision: 1,
    },
  ],
  forms: [
    {
      id: 'assessment',
      name: 'Assessment',
      revision: 1,
      fields: [
        { name: 'score', type: 'number', description: 'Score', required: true, min: 0, max: 10 },
        { name: 'note', type: 'text', description: 'Evidence', required: true, maxWords: 30 },
      ],
    },
  ],
};
export function branchFlow(model = 'fake-1'): Flow {
  const final = singleFlow().nodes.find((n): n is FlowAgent => n.kind === 'agent') as FlowAgent;
  const source = {
    ...final,
    id: 'source',
    form: 'assessment',
    prompt: 'check',
    role: 'member' as const,
    model,
    tools: false,
  };
  const branch = (id: string): FlowAgent => ({
    ...final,
    id,
    form: 'report',
    prompt: 'divan.report',
    role: 'writer',
    tools: false,
    required: [],
  });
  return resolveFlow(
    {
      version: 1,
      kind: 'custom',
      nodes: [
        { id: 'input', kind: 'input' },
        source,
        {
          id: 'decision',
          kind: 'condition',
          mode: 'all',
          rules: [{ field: 'score', op: '>=', value: 5 }],
        },
        branch('yes'),
        branch('no'),
        {
          ...final,
          id: 'final',
          prompt: 'divan.chairman',
          tools: false,
          responses: { ids: ['yes', 'no'], min: 1 },
        },
        { id: 'output', kind: 'output' },
      ],
      edges: [
        { from: 'input', to: 'source', anonymous: false },
        { from: 'source', to: 'decision', anonymous: false },
        { from: 'decision', to: 'yes', gate: 'yes', anonymous: false },
        { from: 'decision', to: 'no', gate: 'no', anonymous: false },
        { from: 'yes', to: 'final', anonymous: true },
        { from: 'no', to: 'final', anonymous: true },
        { from: 'final', to: 'output', anonymous: false },
      ],
    },
    branchLibrary,
  );
}

export function singleFlow(): Flow {
  const { seats, chairman, budgets } = flowInput();
  return flowTemplate({ seats, chairman, budgets }, 'single');
}

/** Direct draft on Yes; only No spends another call rewriting it. */
export function conditionalWireFlow(model = 'fake-1'): Flow {
  const base = branchFlow(model);
  const agent = (id: string) =>
    base.nodes.find(
      (node): node is FlowAgent => node.kind === 'agent' && node.id === id,
    ) as FlowAgent;
  const condition = base.nodes.find((node) => node.kind === 'condition') as Flow['nodes'][number];
  return resolveFlow(
    {
      version: 1,
      kind: 'custom',
      nodes: [
        { id: 'input', kind: 'input' },
        { ...agent('yes'), id: 'report' },
        { ...agent('source'), id: 'judge', required: ['report'] },
        condition,
        { ...agent('no'), id: 'rewriter', required: ['report', 'judge'] },
        { ...agent('final'), responses: { ids: ['report', 'rewriter'], min: 1 } },
        { id: 'output', kind: 'output' },
      ],
      edges: [
        { from: 'input', to: 'report', anonymous: false },
        { from: 'report', to: 'judge', anonymous: true },
        { from: 'judge', to: 'decision', anonymous: false },
        {
          from: 'report',
          to: 'final',
          anonymous: true,
          when: { condition: 'decision', exit: 'yes' },
        },
        { from: 'decision', to: 'rewriter', gate: 'no', anonymous: false },
        { from: 'report', to: 'rewriter', anonymous: true },
        { from: 'judge', to: 'rewriter', anonymous: true },
        { from: 'rewriter', to: 'final', anonymous: true },
        { from: 'final', to: 'output', anonymous: false },
      ],
    },
    branchLibrary,
  );
}

export function flowInput(models: Record<string, string> = {}): CreateInput {
  const budgets = { maxClaims: 5, maxWords: 30 };
  return {
    question: 'Which reversible step should I take?',
    budgets,
    seats: ['critic1', 'critic2', 'critic3'].map((id) => ({
      id,
      enabled: true,
      harness: 'pi',
      model: models[id] ?? 'fake-1',
      effort: 'medium',
      tools: true,
      memory: false,
      web: false,
    })),
    chairman: {
      harness: 'pi',
      model: models.rewriter ?? 'fake-2',
      effort: 'medium',
      memory: false,
    },
  };
}

/** The layout copies the writer configuration; it never shares a harness conversation. */
export function writerFlow(models: Record<string, string> = {}): Flow {
  const input = flowInput(models);
  const writer: FlowAgent = {
    id: 'writer',
    kind: 'agent',
    role: 'writer',
    prompt: 'divan.report',
    form: 'report',
    harness: 'pi',
    model: models.writer ?? 'fake-1',
    effort: 'medium',
    tools: true,
    memory: false,
    web: false,
    rules: REPORT_RULES,
    schema: reportSchemaFor(),
    required: [],
  };
  const critics: FlowAgent[] = input.seats.map(({ enabled: _enabled, ...seat }) => ({
    ...seat,
    kind: 'agent',
    role: 'critic',
    prompt: 'divan.critic',
    form: 'member',
    rules: `${memberRules(input.budgets)}\n\n${CRITIC_TASK}`,
    schema: memberSchemaFor(input.budgets),
    required: ['writer'],
  }));
  const rewriter: FlowAgent = {
    ...writer,
    id: 'rewriter',
    role: 'rewriter',
    prompt: 'divan.chairman',
    form: 'answer',
    model: models.rewriter ?? writer.model,
    rules: chairmanRules(input.budgets, false, 'off', true),
    schema: chairmanSchemaFor(input.budgets),
    required: ['writer'],
    responses: { ids: critics.map((critic) => critic.id), min: 2 },
  };
  return {
    version: 1,
    kind: 'custom',
    nodes: [
      { id: 'input', kind: 'input' },
      writer,
      ...critics,
      rewriter,
      { id: 'output', kind: 'output' },
    ],
    edges: [
      { from: 'input', to: 'writer', anonymous: false },
      ...critics.flatMap((critic) => [
        { from: 'writer', to: critic.id, anonymous: true },
        { from: 'input', to: critic.id, anonymous: false },
        { from: critic.id, to: 'rewriter', anonymous: true },
      ]),
      { from: 'writer', to: 'rewriter', anonymous: true },
      { from: 'rewriter', to: 'output', anonymous: false },
    ],
  };
}
