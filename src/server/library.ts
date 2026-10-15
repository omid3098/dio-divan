import { DEFAULT_BUDGETS } from '../shared/defaults.ts';
import { agentsOf, type Flow, type StoredFlow, storedFlow, validateFlow } from '../shared/flow.ts';
import {
  builtinForm,
  compileForm,
  emptyLibrary,
  fieldSection,
  type Library,
  type LibraryView,
  type PromptEntry,
} from '../shared/library.ts';
import type { Budgets, JsonSchema } from '../shared/types.ts';
import { validateSchema } from './parse.ts';
import {
  CRITIC_TASK,
  chairmanRules,
  chairmanSchemaFor,
  directAnswerRules,
  memberRules,
  memberSchemaFor,
  REPORT_RULES,
  reportSchemaFor,
} from './prompts.ts';

export function builtinPrompts(
  budgets: Budgets = DEFAULT_BUDGETS,
  background = false,
  memory = false,
  tools = true,
): PromptEntry[] {
  const entry = (
    id: string,
    name: string,
    form: string,
    inputs: PromptEntry['inputs'],
    text: string,
  ): PromptEntry => ({ id, name, form, inputs, text, revision: 1 });
  return [
    entry('divan.member', 'Member', 'member', 'any', memberRules(budgets, background)),
    entry(
      'divan.chairman',
      'Chairman',
      'answer',
      'with',
      chairmanRules(budgets, memory, 'off', tools),
    ),
    entry('divan.direct', 'Direct answer', 'answer', 'without', directAnswerRules(budgets)),
    entry('divan.report', 'Report', 'report', 'any', REPORT_RULES),
    entry(
      'divan.critic',
      'Critic',
      'member',
      'with',
      `${memberRules(budgets, background)}\n\n${CRITIC_TASK}`,
    ),
  ];
}
export const builtinSchema = (id: string, budgets: Budgets = DEFAULT_BUDGETS): JsonSchema =>
  id === 'report'
    ? reportSchemaFor()
    : id === 'member'
      ? memberSchemaFor(budgets)
      : chairmanSchemaFor(budgets);

/** Stored references and runtime snapshots are different objects. Resolve after the access/effort overrides. */
export function resolveFlow(
  input: StoredFlow | Flow,
  library: Library = emptyLibrary(),
  budgets = DEFAULT_BUDGETS,
  background = false,
  schemas = new Map<string, JsonSchema>(),
): Flow {
  const flow = structuredClone(input) as Flow;
  for (const node of agentsOf(flow)) {
    const prompt = [
      ...builtinPrompts(budgets, background, node.memory, node.tools),
      ...library.prompts,
    ].find((p) => p.id === node.prompt);
    if (!prompt) throw new Error(`prompt_missing:${node.prompt ?? ''}`);
    if (builtinForm(node.form)) {
      const key = `${node.form}:${JSON.stringify(budgets)}`;
      if (!schemas.has(key)) schemas.set(key, builtinSchema(node.form, budgets));
      node.schema = schemas.get(key) as JsonSchema;
      node.formInfo = { name: node.form, fields: [], revision: 1 };
      node.rules = prompt.text;
    } else {
      const form = library.forms.find((f) => f.id === node.form);
      if (!form) throw new Error(`form_missing:${node.form}`);
      if (!schemas.has(form.id)) schemas.set(form.id, compileForm(form.fields));
      node.schema = schemas.get(form.id) as JsonSchema;
      node.formInfo = {
        name: form.name,
        fields: structuredClone(form.fields),
        revision: form.revision,
      };
      node.rules = `${prompt.text}\n\n${fieldSection(form.fields)}`;
    }
    validateSchema(node.schema);
  }
  validateFlow(flow);
  return flow;
}
export const referencesOf = (flow: StoredFlow | Flow): { prompts: string[]; forms: string[] } => ({
  prompts: (Array.isArray(flow.nodes) ? flow.nodes : []).flatMap((n) =>
    n?.kind === 'agent' && n.prompt ? [n.prompt] : [],
  ),
  forms: (Array.isArray(flow.nodes) ? flow.nodes : []).flatMap((n) =>
    n?.kind === 'agent' ? [n.form] : [],
  ),
});
export function libraryView(
  library: Library,
  flows: { id: string; flow?: StoredFlow | undefined }[],
): LibraryView {
  const users = (kind: 'prompts' | 'forms', id: string) =>
    flows
      .filter((p) =>
        p.flow
          ? referencesOf(p.flow)[kind].includes(id)
          : (kind === 'prompts'
              ? ['divan.member', 'divan.chairman']
              : ['member', 'answer']
            ).includes(id),
      )
      .map((p) => p.id)
      .sort();
  return {
    prompts: [...builtinPrompts(), ...library.prompts].map((p) => ({
      ...p,
      builtin: p.id.startsWith('divan.'),
      usedBy: users('prompts', p.id),
    })),
    forms: [
      ...['report', 'member', 'answer'].map((id) => ({
        id,
        name: id,
        fields:
          id === 'report'
            ? [
                {
                  name: 'report',
                  type: 'markdown' as const,
                  description: 'Full Markdown report',
                  required: true,
                  maxWords: 8000,
                },
              ]
            : [],
        revision: 1,
      })),
      ...library.forms,
    ].map((f) => ({
      ...f,
      builtin: builtinForm(f.id),
      usedBy: users('forms', f.id),
      schema: builtinForm(f.id) ? builtinSchema(f.id) : compileForm(f.fields),
    })),
  };
}
export { storedFlow };
