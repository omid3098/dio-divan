// How a client's conversation (OpenAI chat messages) maps onto Divan's tree. The messages are cut down to what matters
// (user and assistant text), hashed, and looked up:
//   the same conversation, profile and folder      -> the round that answered it (a cached answer);
//   a conversation continued after an answer of ours -> a new round from that answer's node (a branch when it already
//                                                        has children: this is how a client's own branches become Divan's);
//   anything else                                  -> a new session, the earlier conversation kept as background.
// An answer of ours ends with a link to its round (`src/shared/round-link.ts`), which names the round in its address,
// separate from the one-time login ticket in the same link. When the client sends that link back it is the identity of the
// round and is preferred; without it the text of the answer is compared, and a text that more than one round could have
// produced is treated as unknown.
// Pure functions: no HTTP and no engine, so the front end of the endpoint and the tests share them.

import { createHash } from 'node:crypto';
import { closingRound, withoutRoundLink } from '../shared/round-link.ts';
import { estimateTokens } from '../shared/text.ts';
import type { ApiIndex, ApiRef } from './store.ts';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
  /** The round an assistant turn names in its closing link, when it still has that link. */
  ref?: ApiRef;
}

const TEXT_PARTS = new Set(['text', 'input_text', 'output_text']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      const record = part as { type?: unknown; text?: unknown } | null;
      return record && TEXT_PARTS.has(String(record.type)) && typeof record.text === 'string'
        ? record.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

const normalize = (text: string): string => text.replace(/\r\n?/gu, '\n').trim();

/** An assistant answer as it is compared: without our closing link (either form). */
export const canonicalAssistant = (text: string): string =>
  normalize(withoutRoundLink(normalize(text)));

export interface Canonical {
  /** Only user and assistant text, same roles merged, ending with a user turn (an empty one when the client sent none). */
  turns: Turn[];
  /** System and developer messages, only for finding the working folder. */
  system: string;
}

/**
 * Keeps user and assistant text and nothing else: system messages, tool definitions, tool calls and their results are
 * left out. A message that is only a tool call has no text and disappears.
 */
export function canonicalize(messages: unknown): Canonical {
  const turns: Turn[] = [];
  const system: string[] = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const record = message as { role?: unknown; content?: unknown } | null;
    if (!record || typeof record !== 'object') continue;
    const text = normalize(textOf(record.content));
    if (record.role === 'system' || record.role === 'developer') {
      if (text) system.push(text);
      continue;
    }
    if (record.role !== 'user' && record.role !== 'assistant') continue;
    const cleaned = record.role === 'assistant' ? canonicalAssistant(text) : text;
    if (!cleaned) continue;
    const ref = record.role === 'assistant' ? closingRound(text) : undefined;
    const last = turns.at(-1);
    if (last?.role === record.role) {
      last.text = `${last.text}\n\n${cleaned}`;
      if (ref) last.ref = ref;
    } else {
      turns.push({ role: record.role, text: cleaned, ...(ref ? { ref } : {}) });
    }
  }
  if (turns.at(-1)?.role !== 'user') turns.push({ role: 'user', text: '' });
  return { turns, system: system.join('\n\n') };
}

const sha = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 40);

/** Only what the words are: a round's name in a closing line is not part of a conversation's identity. */
const plainTurns = (turns: Turn[]) => turns.map(({ role, text }) => ({ role, text }));

/**
 * What the answer is an answer of: the profile and what it resolves to, the folder, and the conversation up to the last
 * user message, with the rounds its answers name (the same words after two different rounds are two different requests).
 */
export const exactKey = (turns: Turn[], identity: string, cwd: string | null): string =>
  sha([
    'exact',
    identity,
    cwd ?? '',
    plainTurns(turns),
    turns.flatMap((turn) => (turn.ref ? [`${turn.ref.sessionId}.${turn.ref.chairId}`] : [])),
  ]);

/** A conversation that ends with an answer (the form a client sends back before its next message). */
export const prefixKey = (turns: Turn[]): string => sha(['prefix', plainTurns(turns)]);

export type Plan =
  | { kind: 'cached'; ref: ApiRef }
  | { kind: 'branch'; ref: ApiRef; text: string | null }
  | { kind: 'new'; question: string; background: string | null };

const sameRef = (a: ApiRef, b: ApiRef): boolean =>
  a.sessionId === b.sessionId && a.chairId === b.chairId;

/**
 * What to do with a canonical conversation. `alive` says whether a stored reference still points at a finished round
 * (its session may have been deleted since).
 */
export function plan(
  turns: Turn[],
  index: ApiIndex,
  alive: (ref: ApiRef) => boolean,
  identity: string,
  cwd: string | null,
): Plan {
  const last = turns.at(-1) as Turn;
  const exact = index.exact[exactKey(turns, identity, cwd)];
  if (exact && alive(exact)) return { kind: 'cached', ref: exact };
  const before = turns.slice(0, -1);
  const previous = before.at(-1);
  // The round the client names is the round, whatever the text says.
  if (previous?.ref && alive(previous.ref)) {
    return { kind: 'branch', ref: previous.ref, text: last.text || null };
  }
  // Without it only the text is left: a text that exactly one live round could have produced is that round's.
  const candidates = (before.length > 0 ? (index.prefixes[prefixKey(before)] ?? []) : []).filter(
    (ref, at, all) => alive(ref) && all.findIndex((other) => sameRef(other, ref)) === at,
  );
  if (candidates.length === 1) {
    return { kind: 'branch', ref: candidates[0] as ApiRef, text: last.text || null };
  }
  return { kind: 'new', question: last.text, background: backgroundOf(before) };
}

/** What to store once the round answered `turns` with `answer`. */
export function remember(
  index: ApiIndex,
  turns: Turn[],
  answer: string,
  identity: string,
  cwd: string | null,
  ref: ApiRef,
  keep = 2000,
): ApiIndex {
  const exact = { ...index.exact };
  const prefixes = { ...index.prefixes };
  const exactId = exactKey(turns, identity, cwd);
  const prefixId = prefixKey([...turns, { role: 'assistant', text: canonicalAssistant(answer) }]);
  // a re-inserted key moves to the end, so the oldest are the ones dropped
  delete exact[exactId];
  exact[exactId] = ref;
  const known = prefixes[prefixId] ?? [];
  delete prefixes[prefixId];
  prefixes[prefixId] = [...known.filter((other) => !sameRef(other, ref)), ref].slice(-8);
  const trim = (map: Record<string, unknown>) => {
    const keys = Object.keys(map);
    for (const key of keys.slice(0, Math.max(0, keys.length - keep))) delete map[key];
  };
  trim(exact);
  trim(prefixes);
  return { exact, prefixes };
}

/**
 * How much of a client's earlier conversation a new session keeps as its background, in tokens (Omid, 2026-10-10: an app that
 * sends a long conversation expects the council to see most of it; the first cap, 3k, cut it to the last few turns).
 */
export const BACKGROUND_TOKENS = 30_000;

/**
 * The earlier conversation as context for a new session: the latest turns that fit about `maxTokens`, oldest first. The oldest
 * turns are the ones dropped; the turn that straddles the limit is kept from its end.
 */
export function backgroundOf(turns: Turn[], maxTokens = BACKGROUND_TOKENS): string | null {
  const blocks: string[] = [];
  let left = maxTokens;
  for (const turn of [...turns].reverse()) {
    const text = `${turn.role}: ${turn.text}`;
    if (estimateTokens(text) > left) {
      // The turn that does not fit is cut at its start (its end is the part nearest the question) and ends the list.
      const head = `${turn.role}: …`;
      let tail = turn.text.slice(-Math.max(0, left) * 8);
      while (tail.length > 0 && estimateTokens(head + tail) > left) {
        tail = tail.slice(Math.ceil(tail.length * 0.1));
      }
      if (tail.length > 0) blocks.push(head + tail);
      break;
    }
    blocks.push(text);
    left -= estimateTokens(text);
  }
  return blocks.length > 0 ? blocks.reverse().join('\n\n') : null;
}
