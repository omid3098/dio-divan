// The library as the design editor uses it (pure, so a test can pin it): which prompts and output forms FIT an agent, how a picked
// entry is written into the agent, and the one-line previews the pickers show. A node refers to library entries by id; the
// editor's copy of the entry's text and schema is only what the server will regenerate on save (it is what a check of the design
// reads: the fields of a form, whether a prompt is empty).

import type { Flow, FlowAgent } from '../../../../../src/shared/flow.ts';
import type { LibraryView } from '../../../../../src/shared/library.ts';
import { agentOf, feedersOf, nodeOf, patchAgent } from './edit.ts';

export type PromptView = LibraryView['prompts'][number];
export type FormView = LibraryView['forms'][number];

/** What an agent's neighbours ask of its output form and its prompt. */
export interface AgentContext {
  /** Other agents lead into it (so a prompt for "no inputs" does not fit). */
  withInputs: boolean;
  /** It gives the answer Output takes: the form has to be the final answer form. */
  feedsOutput: boolean;
  /** It feeds another agent: the final answer form cannot. */
  feedsAgent: boolean;
  /** It is what a condition reads: it needs fields, so not a report. */
  feedsCondition: boolean;
}

export function contextOf(flow: Flow, agent: FlowAgent): AgentContext {
  const out = flow.edges.filter((edge) => edge.from === agent.id && !edge.gate);
  const kinds = out.map((edge) => nodeOf(flow, edge.to)?.kind);
  return {
    withInputs: feedersOf(flow, agent.id).length > 0,
    feedsOutput: kinds.includes('output'),
    feedsAgent: kinds.includes('agent'),
    feedsCondition: kinds.includes('condition'),
  };
}

/** Whether an output form can be the form of an agent in this place of the design. */
export function formFits(form: FormView, context: AgentContext): boolean {
  if (context.feedsOutput && form.id !== 'answer') return false;
  if (context.feedsAgent && form.id === 'answer') return false;
  if (context.feedsCondition && (form.id === 'report' || form.id === 'answer')) return false;
  return true;
}

/** Whether a prompt is written for this form and for this many inputs. */
export function promptFits(prompt: PromptView, formId: string, withInputs: boolean): boolean {
  return (
    (prompt.form === null || prompt.form === formId) &&
    (prompt.inputs === 'any' || prompt.inputs === (withInputs ? 'with' : 'without'))
  );
}

/** The prompts to offer: the ones that fit, and the one the agent has now. `all` offers every prompt. */
export function promptsFor(
  library: LibraryView,
  agent: FlowAgent,
  context: AgentContext,
  all = false,
): PromptView[] {
  return library.prompts.filter(
    (prompt) =>
      all || prompt.id === agent.prompt || promptFits(prompt, agent.form, context.withInputs),
  );
}

/** The forms to offer: the ones that fit here, and the one the agent has now. `all` offers every form. */
export function formsFor(
  library: LibraryView,
  agent: FlowAgent,
  context: AgentContext,
  all = false,
): FormView[] {
  return library.forms.filter((form) => all || form.id === agent.form || formFits(form, context));
}

/**
 * The prompt to give an agent whose form changed. A prompt written for the new form wins (its own if it has one, else the standard
 * one, else one of the person's): so a form changed and changed back brings the standard prompt back. Where none is written for it,
 * the agent keeps its own prompt when that fits any form, else the person's first one that does.
 */
export function promptAfterForm(
  library: LibraryView,
  agent: FlowAgent,
  formId: string,
  withInputs: boolean,
): PromptView | undefined {
  const fitting = library.prompts.filter((prompt) => promptFits(prompt, formId, withInputs));
  const current = fitting.find((prompt) => prompt.id === agent.prompt);
  if (current && current.form === formId) return current;
  const standard: Record<string, string> = {
    report: 'divan.report',
    member: withInputs ? 'divan.critic' : 'divan.member',
    answer: withInputs ? 'divan.chairman' : 'divan.direct',
  };
  const specific = fitting.filter((prompt) => prompt.form === formId);
  return (
    specific.find((prompt) => prompt.id === standard[formId]) ??
    specific.find((prompt) => !prompt.builtin) ??
    specific[0] ??
    current ??
    fitting.find((prompt) => !prompt.builtin) ??
    fitting[0]
  );
}

/** What of an output form an agent holds: its form, its schema and the display data the server freezes. */
function formPatch(form: FormView): Partial<FlowAgent> {
  return {
    form: form.id,
    schema: structuredClone(form.schema),
    formInfo: {
      name: form.builtin ? form.id : form.name,
      fields: form.builtin ? [] : structuredClone(form.fields),
      revision: form.revision,
    },
  };
}

/** The agent with another output form (and, when its prompt no longer fits, a prompt that does). */
export function applyForm(flow: Flow, id: string, form: FormView, library: LibraryView): Flow {
  const agent = agentOf(flow, id);
  if (!agent) return flow;
  const prompt = promptAfterForm(library, agent, form.id, feedersOf(flow, id).length > 0);
  return patchAgent(flow, id, {
    ...formPatch(form),
    ...(prompt ? { prompt: prompt.id, rules: prompt.text } : {}),
  });
}

/** The agent with another prompt. */
export function applyPrompt(flow: Flow, id: string, prompt: PromptView): Flow {
  return patchAgent(flow, id, { prompt: prompt.id, rules: prompt.text });
}

const MARKS = /[#*_`>|]/gu;
/** One short plain line of a prompt: its first line with words in it, without Markdown marks. */
export function promptPreview(text: string, max = 110): string {
  const line =
    text
      .split(/\r?\n/u)
      .map((item) => item.replace(MARKS, '').replace(/\s+/gu, ' ').trim())
      .find((item) => item.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The names of the fields of an output form (its schema's top-level properties: a built-in form has no field list of its own). */
export const fieldNamesOf = (form: Pick<FormView, 'schema'>): string[] =>
  Object.keys((form.schema?.properties ?? {}) as Record<string, unknown>);

/** One short line about a form: its fields. */
export function formPreview(form: Pick<FormView, 'schema'>, max = 110): string {
  const line = fieldNamesOf(form).join(', ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
