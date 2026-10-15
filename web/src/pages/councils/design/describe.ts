// A design's problem in plain words. The verdict is `validateFlow`'s (see `problemOf`); this only words it, naming the boxes it is
// about by the names the person sees.

import type { en } from '@/i18n/en.ts';
import type { Flow } from '../../../../../src/shared/flow.ts';
import { REASONING_LEVELS } from '../../../../../src/shared/levels.ts';
import type { Note } from '../../../../../src/shared/messages.ts';
import type { ReasoningLevel } from '../../../../../src/shared/types.ts';
import { agentOf, type Problem, problemOf } from './edit.ts';
import { agentNames, type Say } from './names.ts';

type Key = keyof typeof en;
/** Words a harness's own refusal (a coded sentence) in the language in force. */
export type Word = (note: Note) => string;

const SIMPLE: Record<string, Key> = {
  format: 'flow.problem.format',
  size: 'flow.problem.size',
  'one input and output required': 'flow.problem.oneIO',
  edge: 'flow.problem.edge',
  connection: 'flow.problem.connection',
  'one final answer producer required': 'flow.problem.final',
};
const NAMED: Record<string, Key> = {
  'duplicate or invalid id': 'flow.problem.id',
  'node kind': 'flow.problem.kind',
  'final answer web must be off': 'flow.problem.finalWeb',
  'role form': 'flow.problem.role',
  'agent size': 'flow.problem.size.agent',
  'incompatible form': 'flow.problem.role',
  'dependency declaration': 'flow.problem.dependency',
  'impossible minimum': 'flow.problem.minimum',
  'disabled prerequisite': 'flow.problem.disabled',
  'critic input': 'flow.problem.critic',
  'disabled output': 'flow.problem.disabledOutput',
  gate: 'flow.problem.gate',
  when: 'flow.problem.when',
  fields: 'flow.problem.fields',
  'condition input': 'flow.problem.condInput',
  'condition rules': 'flow.problem.condRules',
  'condition operator': 'flow.problem.condOperator',
  'condition value': 'flow.problem.condValue',
  'condition exits': 'flow.problem.condExits',
};

/** The names a person sees for the boxes of a design (agents by their names, Input and Output by theirs). */
export function boxName(flow: Flow, names: Record<string, string>, id: string, t: Say): string {
  const node = flow.nodes.find((item) => item.id === id);
  if (node?.kind === 'input') return t('flow.input.name');
  if (node?.kind === 'output') return t('flow.output.name');
  return names[id] ?? id;
}

export function describeProblem(
  problem: Problem,
  flow: Flow,
  names: Record<string, string>,
  t: Say,
  word: Word,
): string {
  const name = (id: string | undefined) => boxName(flow, names, id ?? '', t);
  const first = name(problem.ids[0]);
  const { reason } = problem;
  if (reason === 'access' && problem.note)
    return t('flow.problem.access', { name: first, reason: word(problem.note) });
  if (reason === 'unreachable or dead end') {
    return problem.ids.length > 1
      ? t('flow.problem.lostMany', { name: first, count: problem.ids.length - 1 })
      : t('flow.problem.lost', { name: first });
  }
  if (reason === 'condition field')
    return t('flow.problem.condField', { name: first, source: name(problem.ids[1]) });
  if (reason === 'cycle')
    return t('flow.problem.cycle', { names: problem.ids.map((id) => `“${name(id)}”`).join(', ') });
  if (reason === 'agent form') {
    const agent = agentOf(flow, problem.ids[0] ?? '');
    if (agent && !agent.model) return t('flow.problem.model', { name: first });
    if (agent && !agent.rules.trim()) return t('flow.problem.prompt', { name: first });
    return t('flow.problem.agent', { name: first });
  }
  const simple = SIMPLE[reason];
  if (simple) return t(simple);
  const named = NAMED[reason];
  if (named) return t(named, { name: first });
  return t('flow.problem.format');
}

/** The same for a level's design: the sentence says which level it is about. */
export function describeLevelProblem(
  problem: Problem,
  flow: Flow,
  names: Record<string, string>,
  level: ReasoningLevel,
  t: Say,
  word: Word,
): string {
  return t('flow.problem.atLevel', {
    level: t(`level.${level}` as Key),
    problem: describeProblem(problem, flow, names, t, word),
  });
}

/**
 * What stops the design from being saved, in words, or null: the first problem of the design on Base, else of a level the user
 * changed (a level's design is checked too, because a level can switch an agent off). The server refuses the same designs.
 */
export function blockerOf(
  form: {
    base: { flow?: Flow | undefined };
    levels: Record<ReasoningLevel, { flow?: Flow | undefined }>;
  },
  changed: Record<ReasoningLevel, boolean>,
  t: Say,
  word: Word,
): string | null {
  const base = form.base.flow;
  if (base) {
    const problem = problemOf(base);
    if (problem) return describeProblem(problem, base, agentNames(base, t), t, word);
  }
  for (const level of REASONING_LEVELS) {
    const flow = form.levels[level].flow;
    if (!flow || !changed[level]) continue;
    const problem = problemOf(flow);
    if (problem) return describeLevelProblem(problem, flow, agentNames(flow, t), level, t, word);
  }
  return null;
}
