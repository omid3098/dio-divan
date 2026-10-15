import { DEFAULT_BUDGETS } from '../shared/defaults.ts';
import { agentsOf, compileCouncil, type Flow, type FlowAgent, finalAgent } from '../shared/flow.ts';
import { heldValue } from '../shared/harness-rules.ts';
import { note } from '../shared/messages.ts';
import type { JsonSchema, SessionSettings, SettingsFull } from '../shared/types.ts';
import {
  chairmanRules,
  chairmanSchemaFor,
  directAnswerRules,
  memberRules,
  memberSchemaFor,
  REPORT_RULES,
  reportSchemaFor,
} from './prompts.ts';

export const FLOW_TEMPLATES = [
  { id: 'council', name: note('flow_template_council') },
  { id: 'writer-critics', name: note('flow_template_writer_critics') },
  { id: 'single', name: note('flow_template_single') },
] as const;

/** The standard system prompt and answer schema of each output form: what the editor gives a new agent, or an agent whose form changes. */
export function flowForms(): Record<
  'report' | 'member' | 'answer',
  { rules: string; schema: JsonSchema }
> & {
  answer: { rules: string; directRules: string; schema: JsonSchema };
} {
  return {
    report: { rules: REPORT_RULES, schema: reportSchemaFor() },
    member: { rules: memberRules(DEFAULT_BUDGETS), schema: memberSchemaFor(DEFAULT_BUDGETS) },
    answer: {
      rules: chairmanRules(DEFAULT_BUDGETS, false, 'off', true),
      directRules: directAnswerRules(DEFAULT_BUDGETS),
      schema: chairmanSchemaFor(DEFAULT_BUDGETS),
    },
  };
}

/** Copy the writer into a separate rewriting call; no live coupling or shared conversation. */
export function executableFlow(settings: SettingsFull, background = false): Flow {
  return (
    settings.flow ??
    compileCouncil({
      ...settings,
      question: '',
      template: 'important-decision',
      rules: memberRules(settings.budgets, background),
      memberSchema: memberSchemaFor(settings.budgets),
      chairmanRules: chairmanRules(
        settings.budgets,
        settings.chairman.memory === true,
        'off',
        heldValue(settings.chairman.harness, 'tools') ?? settings.chairman.tools !== false,
      ),
      chairmanSchema: chairmanSchemaFor(settings.budgets),
      critiqueInstruction: '',
    })
  );
}

export const frozenFlow = (settings: SessionSettings): Flow =>
  settings.flow ?? compileCouncil(settings);

export function flowTemplate(settings: SettingsFull, template = 'writer-critics'): Flow {
  if (template === 'single') {
    const seat = settings.seats.find((seat) => seat.enabled);
    if (!seat) throw new Error('single template needs an enabled assistant');
    const { enabled: _enabled, ...config } = seat;
    const agent: FlowAgent = {
      ...config,
      id: 'assistant',
      kind: 'agent',
      role: 'chairman',
      prompt: 'divan.direct',
      form: 'answer',
      web: false,
      rules: directAnswerRules(DEFAULT_BUDGETS),
      schema: chairmanSchemaFor(DEFAULT_BUDGETS),
      required: [],
    };
    return {
      version: 1,
      kind: 'custom',
      nodes: [{ id: 'input', kind: 'input' }, agent, { id: 'output', kind: 'output' }],
      edges: [
        { from: 'input', to: agent.id, anonymous: false },
        { from: agent.id, to: 'output', anonymous: false },
      ],
    };
  }
  const { flow: _flow, ...base } = settings;
  const council = executableFlow(base);
  const used = new Set(council.nodes.map((node) => node.id));
  const idFor = (base: string) => {
    let id = base;
    while (used.has(id)) id += '_';
    used.add(id);
    return id;
  };
  const writer: FlowAgent = {
    ...finalAgent(council),
    id: idFor('writer'),
    role: 'writer',
    prompt: 'divan.report',
    form: 'report',
    rules: REPORT_RULES,
    schema: reportSchemaFor(),
    required: [],
  };
  delete writer.responses;
  const critics: FlowAgent[] = agentsOf(council)
    .filter((agent) => agent.form === 'member')
    .map((agent) => ({ ...agent, role: 'critic', prompt: 'divan.critic', required: [writer.id] }));
  const rewriter: FlowAgent = {
    ...writer,
    id: idFor('rewriter'),
    role: 'rewriter',
    prompt: 'divan.chairman',
    form: 'answer',
    rules: finalAgent(council).rules,
    schema: finalAgent(council).schema,
    required: [writer.id],
    responses: { ids: critics.map((agent) => agent.id), min: 2 },
  };
  const input = council.nodes.find((node) => node.kind === 'input') as {
    id: string;
    kind: 'input';
  };
  const output = council.nodes.find((node) => node.kind === 'output') as {
    id: string;
    kind: 'output';
  };
  return {
    version: 1,
    kind: 'custom',
    nodes: [input, writer, ...critics, rewriter, output],
    edges: [
      { from: input.id, to: writer.id, anonymous: false },
      ...critics.flatMap((critic) => [
        { from: input.id, to: critic.id, anonymous: false },
        { from: writer.id, to: critic.id, anonymous: true },
        { from: critic.id, to: rewriter.id, anonymous: true },
      ]),
      { from: writer.id, to: rewriter.id, anonymous: true },
      { from: rewriter.id, to: output.id, anonymous: false },
    ],
  };
}
