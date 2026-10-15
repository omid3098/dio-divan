// What a box is called on the canvas and in the messages: the name the user gave it, else its role («Critic 2»: the number only
// when several agents have the same role). The name is for the person; it never reaches an agent.

import type { en } from '@/i18n/en.ts';
import {
  agentsOf,
  type Flow,
  type FlowAgent,
  isDirectAnswer,
} from '../../../../../src/shared/flow.ts';

type Key = keyof typeof en;
/** What says a sentence of the interface in the language in force (the page's `t`). */
export type Say = (key: Key, params?: Record<string, string | number>) => string;

const LABEL_MAX = 40;

/** A name the user typed, cleaned (one line, bounded); '' when it says nothing. */
export const cleanLabel = (value: unknown): string =>
  typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, LABEL_MAX) : '';

export function roleName(role: FlowAgent['role'], t: Say): string {
  return t(`flow.role.${role}` as Key);
}

/** The names of all the agents of a design, and of its conditions («Condition», or «Condition 2» when there are several). */
export function agentNames(flow: Flow, t: Say): Record<string, string> {
  const agents = agentsOf(flow);
  const out: Record<string, string> = {};
  const conditions = flow.nodes.filter((node) => node.kind === 'condition');
  conditions.forEach((node, index) => {
    out[node.id] =
      conditions.length > 1 ? t('flow.cond.nameN', { n: index + 1 }) : t('flow.cond.name');
  });
  for (const agent of agents) {
    const own = cleanLabel(agent.label);
    if (own) {
      out[agent.id] = own;
      continue;
    }
    const same = agents.filter((item) => item.role === agent.role);
    out[agent.id] =
      same.length > 1
        ? `${roleName(agent.role, t)} ${same.findIndex((item) => item.id === agent.id) + 1}`
        : isDirectAnswer(agent)
          ? t('flow.role.assistant')
          : roleName(agent.role, t);
  }
  return out;
}

/** The two letters of an assistant on its box. */
export const INITIALS: Record<string, string> = {
  claude: 'Cc',
  codex: 'Cx',
  grok: 'Gk',
  pi: 'Pi',
  agy: 'Ag',
};

/** How strong an effort is, 0 to 4, for the little meter: none, low, medium, high, and the highest. */
export function effortStrength(effort: string): number {
  switch (effort) {
    case 'none':
    case 'off':
    case '':
      return 0;
    case 'minimal':
    case 'low':
      return 1;
    case 'medium':
      return 2;
    case 'high':
      return 3;
    case 'xhigh':
    case 'max':
      return 4;
    default:
      // a harness's own name for an effort: counted as medium, as everywhere else
      return 2;
  }
}
