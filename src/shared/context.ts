// The context builder: the one place that decides what a member receives. It is pure, so the server runs it for a
// round and the editor runs it for the preview, and the tests pin its invariant.
//
// For a round started from chairman node C, a member receives, in this order:
//   the rules (fixed per session, first so the provider's prompt cache stays warm),
//   the background (only a session made through the endpoint has one: the client's earlier conversation, cut short),
//   the root question, then (when the asker wrote one) the context he added to it,
//   every user-written input on the path from the root, in order,
//   for each earlier chairman node on the path only its title and direction,
//   for C its full answer, its claims (id, text, status) and its questions for the user,
//   and last the new user input, or the fixed critique instruction when there is none.
// It never receives a member's raw or parsed output from any round, nor anything from another branch.

import { estimateTokens } from './text.ts';
import type { ChairNode, ContextRow, QuestionAnswer, RoundInput, SessionNode } from './types.ts';

/** How long the context the asker adds to a question may be. */
export const MAX_CONTEXT_CHARS = 4000;

export interface BuiltContext {
  rows: ContextRow[];
  /** Everything after the rules. */
  body: string;
  /** The rules, then the body: exactly what a member receives. */
  prompt: string;
  /** Sum of the rows' token estimates. */
  tokens: number;
  /** The latest text Omid wrote on this path (the question when he wrote nothing since): the chairman answers in its language. */
  languageSample: string;
}

export interface BuildContextArgs {
  nodes: Record<string, SessionNode>;
  rootId: string;
  /** The chairman node the round starts from; null for round 1, which has the question only. */
  fromChairId: string | null;
  /**
   * The new user input: a comment (a string), or answers to the chairman's questions with an optional comment; null or empty
   * for "next round without comment".
   */
  newInput: RoundInput | null;
  rules: string;
  critiqueInstruction: string;
  /** The earlier conversation of an endpoint client; null or empty for a web session. */
  background?: string | null;
}

/** What an input is made of once it is cleaned: the answers that say something, and the comment. */
export interface InputParts {
  answers: QuestionAnswer[];
  comment: string;
}

/** The parts of an input (null when it holds nothing): an old plain string is a comment alone. */
export function inputParts(input: RoundInput | null | undefined): InputParts | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') {
    const comment = input.trim();
    return comment ? { answers: [], comment } : null;
  }
  const answers = (input.answers ?? [])
    .map((item) => ({
      question: String(item.question ?? '').trim(),
      answer: String(item.answer ?? '').trim(),
    }))
    .filter((item) => item.answer);
  const comment = (input.comment ?? '').trim();
  return answers.length > 0 || comment ? { answers, comment } : null;
}

/** An input as the members read it: «Q: … / A: …» pairs, then the comment. */
export function renderInput(parts: InputParts): string {
  const pairs = parts.answers.map((item) => `Q: ${item.question}\nA: ${item.answer}`);
  return [...pairs, ...(parts.comment ? [parts.comment] : [])].join('\n\n');
}

/** The words the asker wrote in an input, for the language of the reply and for a short title. */
export const wordsOf = (parts: InputParts): string =>
  parts.comment || parts.answers.map((item) => item.answer).join(' ');

/** The input a node holds (a user node: its answers and its comment). */
export function inputOfNode(node: {
  text: string;
  answers?: QuestionAnswer[] | undefined;
}): InputParts | null {
  return inputParts({ answers: node.answers ?? [], comment: node.text });
}

/** Root to `id`, following parent links. */
export function pathTo(nodes: Record<string, SessionNode>, id: string): SessionNode[] {
  const path: SessionNode[] = [];
  const seen = new Set<string>();
  let current: SessionNode | undefined = nodes[id];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? nodes[current.parentId] : undefined;
  }
  return path;
}

// Our own delimiters must not be forgeable by text inside a section (an answer is derived from untrusted member text). The
// members' tags and the chairman's (its round, address form, language sample, the context and the member outputs, and the
// member-output delimiters) are all defused here, so the one function serves both inputs.
const TAGS =
  /<(\/?)(background|question|question_context|user_input|earlier_round|latest_answer|new_user_input|instruction|round|address_form|reply_language_sample|context|context_the_members_received|member_outputs|member_memory_facts|upstream_outputs)\b/giu;
const MEMBER_DELIMITER = /<<<(\s*END\s+)?(MEMBER|FACTS|UPSTREAM)\b/giu;
/** Text from outside with every tag and delimiter of ours turned into a harmless look-alike (`‹question`). */
export const defuse = (text: string): string =>
  text.replace(TAGS, '‹$1$2').replace(MEMBER_DELIMITER, '‹‹‹$1$2');

function section(tag: string, attrs: string, inner: string): string {
  return `<${tag}${attrs}>\n${defuse(inner.trim())}\n</${tag}>`;
}

function latestText(node: ChairNode): string {
  const claims = node.claims.map((claim) => `- ${claim.id} [${claim.status}] ${claim.text}`);
  const questions = node.questionsForUser.map((question) => `- ${question}`);
  // the recommendation is not part of the answer's prose (the page shows it apart), so it goes in beside it
  const recommendation = node.recommendation
    ? [
        `recommendation: ${node.recommendation.choice.trim()} (confidence ${Math.round(node.recommendation.confidence * 100)}%)`,
      ]
    : [];
  return [
    `title: ${node.title}`,
    `direction: ${node.direction}`,
    ...recommendation,
    'answer:',
    node.answer.trim(),
    'claims:',
    ...(claims.length > 0 ? claims : ['- (none)']),
    'questions_for_user:',
    ...(questions.length > 0 ? questions : ['- (none)']),
  ].join('\n');
}

export function buildContext(args: BuildContextArgs): BuiltContext {
  const { nodes, rootId, fromChairId, rules, critiqueInstruction } = args;
  const newInput = inputParts(args.newInput);
  const rows: ContextRow[] = [
    { kind: 'rules', ref: '', text: rules, tokens: estimateTokens(rules) },
  ];
  const blocks: string[] = [];
  const push = (kind: ContextRow['kind'], ref: string, text: string, block: string) => {
    rows.push({ kind, ref, text, tokens: estimateTokens(block) });
    blocks.push(block);
  };
  const background = args.background?.trim();
  if (background) push('background', '', background, section('background', '', background));

  const path = fromChairId ? pathTo(nodes, fromChairId) : pathTo(nodes, rootId);
  let language = '';
  let inputs = 0;
  for (const [index, node] of path.entries()) {
    if (node.kind === 'chair') {
      if (index === path.length - 1) {
        const text = latestText(node);
        push(
          'latest',
          String(node.round),
          text,
          section('latest_answer', ` round="${node.round}"`, text),
        );
      } else {
        const text = `title: ${node.title}\ndirection: ${node.direction}`;
        push(
          'summary',
          String(node.round),
          text,
          section('earlier_round', ` n="${node.round}"`, text),
        );
      }
    } else if (index === 0) {
      language = node.text;
      push('question', '', node.text, section('question', '', node.text));
      // what the asker added about the situation: a block of its own, right after the question
      const added = node.kind === 'user' ? node.context?.trim() : '';
      if (added) push('context', '', added, section('question_context', '', added));
    } else if (node.kind === 'user') {
      const parts = inputOfNode(node);
      if (!parts) continue;
      const text = renderInput(parts);
      inputs += 1;
      language = wordsOf(parts);
      push('input', String(inputs), text, section('user_input', ` n="${inputs}"`, text));
    }
    // A "next round without comment" node holds no user-written input, so it adds nothing.
  }
  if (fromChairId) {
    if (newInput) {
      const text = renderInput(newInput);
      language = wordsOf(newInput);
      push('new', '', text, section('new_user_input', '', text));
    } else {
      push('instruction', '', critiqueInstruction, section('instruction', '', critiqueInstruction));
    }
  }

  const body = blocks.join('\n\n');
  return {
    rows,
    body,
    prompt: `${rules}\n\n${body}\n`,
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
    languageSample: language,
  };
}
