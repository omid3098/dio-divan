// Shared builders for the tests: a minimal session tree.

import type { ChairNode, Session, SessionNode, UserNode } from '../src/shared/types.ts';

export const RULES = 'RULES-LINE-ONE\nRULES-LINE-TWO';
export function requireValue<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Required fixture value is missing');
  return value;
}
export const CRITIQUE = 'CRITIQUE-INSTRUCTION';

export function userNode(
  id: string,
  parentId: string | null,
  text: string,
  kind: 'user' | 'next' = 'user',
): UserNode {
  return {
    id,
    kind,
    parentId,
    text,
    title: text.slice(0, 20),
    position: null,
    pinned: false,
    layoutRev: 0,
    createdAt: '2026-10-10T00:00:00Z',
  };
}

export function chairNode(
  id: string,
  parentId: string,
  round: number,
  fields: Partial<ChairNode> = {},
): ChairNode {
  return {
    id,
    kind: 'chair',
    parentId,
    position: null,
    pinned: false,
    layoutRev: 0,
    createdAt: '2026-10-10T00:00:00Z',
    round,
    status: 'done',
    title: `title-${id}`,
    direction: `direction-${id}`,
    answer: `answer-${id}`,
    recommendation: null,
    questionsForUser: [`question-${id}`],
    claims: [{ id: `R${round}-C1`, text: `claim-${id}`, status: 'accepted', from: ['A'] }],
    seatScores: [],
    labelMap: { A: 'S1' },
    seats: [
      {
        seatId: 'S1',
        label: 'A',
        harness: 'claude',
        model: 'm',
        effort: '',
        tools: false,
        memory: false,
        web: false,
        state: 'done',
        prompt: 'PROMPT',
        rawOutput: `MEMBER-RAW-SECRET-${id}`,
        sanitized: null,
        parsed: {
          stance: `MEMBER-PARSED-SECRET-${id}`,
          recommendation: { choice: 'c', why: 'w', confidence: 0.5 },
          options: [],
          claims: [],
          risks: [],
          unknowns: [],
          would_change_my_mind: '',
        },
        trimmed: [],
        error: null,
        usage: null,
        startedAt: null,
        endedAt: null,
      },
    ],
    chairman: {
      state: 'done',
      harness: 'pi',
      model: 'm',
      effort: '',
      input: 'CHAIRMAN-INPUT',
      rawOutput: '',
      trimmed: [],
      error: null,
      usage: null,
      startedAt: null,
      endedAt: null,
    },
    context: [],
    contextTokens: 0,
    usage: { members: 0, chairman: 0, total: 0, council: 0, cached: 0, estimated: false },
    attempts: [],
    error: null,
    startedAt: '2026-10-10T00:00:00Z',
    endedAt: null,
    ...fields,
  };
}

export function tree(nodes: SessionNode[]): Record<string, SessionNode> {
  return Object.fromEntries(nodes.map((node) => [node.id, node]));
}

export function sessionOf(nodes: SessionNode[], id = 'sess-1'): Session {
  return {
    schemaVersion: 1,
    id,
    name: 'test',
    createdAt: '2026-10-10T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
    settings: {
      question: 'Q',
      seats: [],
      chairman: { harness: 'pi', model: 'm', effort: '' },
      template: 'important-decision',
      budgets: { maxClaims: 5, maxWords: 30 },
      rules: RULES,
      chairmanRules: 'CR',
      critiqueInstruction: CRITIQUE,
      memberSchema: {},
      chairmanSchema: {},
    },
    rootId: nodes[0]?.id ?? 'u0',
    nodes: tree(nodes),
    layout: { direction: 'TB' },
  };
}
