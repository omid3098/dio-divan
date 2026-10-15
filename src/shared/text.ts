// Small text helpers used on both sides: word counting and cutting, token estimates and the direction rule of Dio Docs
// RTL-6 (any Persian character makes a block RTL).

/** A sentence ends at one of these followed by a space or the end of the text. */
const SENTENCE_END = /[.!?؟۔](?=\s|$)/gu;

/** A link: `http://` or `https://` and everything up to the next white space (so also inside a Markdown link, `[name](https://…)`). */
const LINK = /https?:\/\/\S+/gu;

/** How many characters of `text` count toward a character limit: all of them except those of a link. */
function countedChars(text: string): number {
  return text.replace(LINK, '').length;
}

/** The index in `text` after `count` counted characters: a link is passed whole and uses none of them. */
function indexAfterCounted(text: string, count: number): number {
  let left = count;
  let at = 0;
  for (const link of text.matchAll(LINK)) {
    const start = link.index ?? 0;
    if (start - at > left) break;
    left -= start - at;
    at = start + link[0].length;
  }
  return Math.min(text.length, at + left);
}

/**
 * Cuts `text` to a word limit and a character limit at a boundary, never inside a word (ZWNJ stays inside a word): at the
 * end of the last whole sentence when that keeps most of the text, else after the last whole word, and ends with «…» so
 * the cut is visible. `by` says which limit cut it (empty: nothing was cut). A single "word" longer than the character
 * limit has no boundary and is cut where the limit falls. A link is one word (it has no white space in it) and its
 * characters do not count toward the character limit, so a claim is never cut at its source.
 */
export function trimToLimit(
  text: string,
  limits: { maxWords?: number; maxChars?: number },
): { text: string; by: ('words' | 'chars')[] } {
  const whole = text.trim();
  let out = whole;
  const by: ('words' | 'chars')[] = [];
  const { maxWords, maxChars } = limits;
  if (typeof maxWords === 'number') {
    const starts = [...whole.matchAll(/\S+/gu)];
    const first = starts[maxWords];
    if (first?.index !== undefined) {
      out = whole.slice(0, first.index).trimEnd();
      by.push('words');
    }
  }
  if (typeof maxChars === 'number' && countedChars(out) > maxChars) {
    // room for the «…»
    const end = indexAfterCounted(out, maxChars - 1);
    const inWord = /\S/u.test(out.charAt(end - 1)) && /\S/u.test(out.charAt(end));
    out = out.slice(0, end);
    if (inWord) {
      const space = out.search(/\s\S*$/u);
      if (space > 0) out = out.slice(0, space);
    }
    by.push('chars');
  }
  if (by.length === 0) return { text: whole, by };
  // the last whole sentence, when it keeps at least 40% of what is left
  let sentence = -1;
  for (const match of out.matchAll(SENTENCE_END)) sentence = (match.index ?? 0) + 1;
  if (sentence >= out.length * 0.4 && sentence < out.length) {
    return { text: `${out.slice(0, sentence)} …`, by };
  }
  const clean = out.replace(/[\s,;:،؛\-–—]+$/u, '');
  return { text: /[.!?؟۔]$/u.test(clean) ? `${clean} …` : `${clean}…`, by };
}

/**
 * A token estimate for text: Latin and digits count one token per 4 characters, every other script (Persian) one
 * per 2.2. It only estimates; harness-reported usage replaces it wherever the harness gives numbers.
 */
export function estimateTokens(text: string): number {
  let latin = 0;
  let other = 0;
  for (const char of text) {
    if (char.charCodeAt(0) < 0x250) latin += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(latin / 4 + other / 2.2));
}

/**
 * A date and time for Persian text: the Persian calendar, Latin digits (Dio Docs RTL-14), the Persian comma and 24-hour
 * time: «1405/07/19، 02:46». (`toLocaleString` writes a Latin comma, which does not belong inside Persian text.)
 */
export function faDateTime(date: Date | string | number): string {
  const parts = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(date));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}/${get('month')}/${get('day')}، ${get('hour')}:${get('minute')}`;
}

/** Wraps a machine value (a provider, a model id) so it keeps its left-to-right shape inside Persian text. */
export const ltr = (text: string): string => `\u2066${text}\u2069`;

/**
 * A short single-line cut for titles and subtitles: at most `max` characters, cut after a whole word (never inside one) and
 * ended with «…». A single word longer than the limit has no boundary and is cut where the limit falls.
 */
export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = [...flat];
  if (chars.length <= max) return flat;
  const room = chars.slice(0, max - 1);
  // inside a word when the cut falls between two letters: back up to the end of the word before
  const inside = chars[max - 1] !== ' ' && room.at(-1) !== ' ';
  const space = room.lastIndexOf(' ');
  const kept = inside && space > 0 ? room.slice(0, space) : room;
  return `${kept.join('').replace(/[\s,;:،؛\-–—]+$/u, '')}…`;
}

const PERSIAN = /\p{Script=Arabic}/u;
const LATIN = /\p{Script=Latin}/u;
// URLs, paths, email addresses and hashes do not count (RTL-6).
const TECHNICAL = new RegExp(
  [
    String.raw`(?:https?://|www\.)\S+`,
    String.raw`(?:[A-Za-z]:[\\/]|\.{0,2}[\\/])\S+`,
    String.raw`\b\S+@\S+\.\S+\b`,
    String.raw`\b[0-9a-f]{7,}\b`,
  ].join('|'),
  'giu',
);

/** 'rtl', 'ltr', or null when no letter counts (Dio Docs RTL-6). */
export function textDirection(text: string): 'rtl' | 'ltr' | null {
  const readable = text.replace(TECHNICAL, ' ');
  if (PERSIAN.test(readable)) return 'rtl';
  return LATIN.test(readable) ? 'ltr' : null;
}

/** A model family, used for the setup warning when the chairman shares a family with a member. */
export function modelFamily(model: string, harness?: string): string {
  // Router names are transport, not company evidence. Classify the model's own name only.
  const id = (model.split('/').at(-1) ?? '').toLowerCase();
  if (/claude|opus|sonnet|haiku|fable|anthropic/u.test(id)) return 'anthropic';
  if (/gpt|chatgpt|codex|\bo[134]\b|openai/u.test(id)) return 'openai';
  if (/gemini|gemma|google/u.test(id)) return 'google';
  if (/grok|xai/u.test(id)) return 'xai';
  if (/deepseek/u.test(id)) return 'deepseek';
  if (/glm|zai|zhipu/u.test(id)) return 'zhipu';
  if (/qwen|alibaba/u.test(id)) return 'alibaba';
  if (/llama|meta/u.test(id)) return 'meta';
  if (/mistral|mixtral/u.test(id)) return 'mistral';
  if (/kimi|moonshot/u.test(id)) return 'moonshot';
  // Synthetic native fixture ids represent their harness's company; opaque real ids prove nothing.
  if (/^fake-/u.test(model)) {
    if (harness === 'claude') return 'anthropic';
    if (harness === 'codex') return 'openai';
    if (harness === 'grok') return 'xai';
  }
  return 'unknown';
}

// ---------- the chairman's answer as Markdown ----------

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toLatinDigits = (text: string): string =>
  text.replace(/[۰-۹٠-٩]/gu, (digit) =>
    String(Math.max(PERSIAN_DIGITS.indexOf(digit), ARABIC_INDIC_DIGITS.indexOf(digit))),
  );

/** A numbered step at the start of a line: «۱.» «٢)» «3-» then a space and the text. */
const NUMBERED_STEP = /^(\s*)([0-9٠-٩۰-۹]+)[ \t]*[.)\-–][ \t]+(?=\S)/u;
const BULLET = /^\s*[-*•][ \t]+\S/u;
const FENCE = /^\s*(```|~~~)/u;

// ---------- the recommendation and the answer ----------
//
// The web app shows the recommendation in a box above the answer, so the answer should not say it again. The prompt tells the
// chairman not to. As a fallback ONE line is cut, the first or the last line of the answer, and only when that line IS this
// round's recommendation and nothing else: a label («Recommendation:» «پیشنهاد:»), exactly the words of the recommendation and
// at most a known confidence («(70%)», «· confidence 70%»). A line that says anything more is the answer's own, and so is
// every other line. When in doubt the line stays: a repeated line costs nothing, a lost warning costs a decision.

export interface RecommendationLike {
  choice: string;
  confidence: number;
}

const MARKUP = /(?:\*\*|__)/gu;
/** «Recommendation:» «پیشنهاد:» at the start of a line, once the bold markers are taken out; what follows is group 1. */
const LABELLED = /^(?:Recommendation|پیشنهاد)\s*[:：]\s*(.*)$/iu;
/** The confidence a line may end with, and nothing else: «(70%)» «(confidence 70%)» «(اطمینان 70%)» «· confidence 70%». */
const CONFIDENCE =
  /\s*(?:\(\s*(?:confidence|اطمینان)?\s*:?\s*(\d{1,3})\s*[%٪]\s*\)|[·•|—–-]\s*(?:confidence|اطمینان)\s*:?\s*(\d{1,3})\s*[%٪])\s*[.!?؟]*\s*$/iu;

/** The words of a text as a comparison sees them: lower case, Latin digits, no marks, no punctuation. */
const wordsOf = (text: string): string[] =>
  toLatinDigits(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

/** Whether a line is the recommendation's own line: its label, its words, at most its confidence. */
function isRecommendationLine(line: string, recommendation: RecommendationLike): boolean {
  const labelled = LABELLED.exec(toLatinDigits(line).replace(MARKUP, '').trim());
  if (!labelled) return false;
  let rest = labelled[1] ?? '';
  const confidence = CONFIDENCE.exec(rest);
  if (confidence) {
    const said = Number(confidence[1] ?? confidence[2]);
    // another number than the one shown above (69% or 71% where it shows 70%) is not this recommendation's decoration: keep the line
    if (said !== Math.round(recommendation.confidence * 100)) return false;
    rest = rest.slice(0, confidence.index);
  }
  const given = wordsOf(recommendation.choice);
  const wording = wordsOf(rest);
  return given.length > 0 && given.join(' ') === wording.join(' ');
}

/**
 * The answer without the one first or last line that is the recommendation's own line (`found`: there was one). The blank
 * lines that held it apart from the rest go with it; an answer that would be left empty is returned as it was.
 */
function stripRestated(
  answer: string,
  recommendation: RecommendationLike,
): { text: string; found: boolean } {
  const lines = answer.replace(/\r\n?/gu, '\n').trim().split('\n');
  const last = lines.length - 1;
  let at = -1;
  if (isRecommendationLine(lines[0] ?? '', recommendation)) at = 0;
  else if (last > 0 && isRecommendationLine(lines[last] ?? '', recommendation)) at = last;
  if (at < 0) return { text: answer, found: false };
  const rest = lines.filter((_, index) => index !== at);
  const text = rest.join('\n').trim();
  return { text: text === '' ? answer : text, found: true };
}

/** Whether the answer already says the recommendation (a first or last paragraph does, or it is nothing else). */
export function restatesRecommendation(
  answer: string,
  recommendation: RecommendationLike | null,
): boolean {
  return recommendation ? stripRestated(answer, recommendation).found : false;
}

/** The answer without a first or last paragraph that restates the recommendation shown above it; as it is when there is none. */
export function withoutRestatedRecommendation(
  answer: string,
  recommendation: RecommendationLike | null,
): string {
  return recommendation ? stripRestated(answer, recommendation).text : answer;
}

/**
 * «Round 3:» «Round 3 –» «دور ۳:» at the start of a title: the round, then a colon, or a dash with a space on both sides. A
 * number that goes on («3.5» «3-5» «3,000») or a dash that is part of a range («۳-۵ ساله») is not a round prefix, and neither
 * is a dash before another number, after any amount of white space («Round 3 - 5 weeks», «Round 3 -  5 weeks»).
 */
const ROUND_PREFIX =
  /^(?:round|دور)\s*[0-9]+(?![0-9.,٫٬/])(?:\s*[:：]|\s+[-–—]\s+(?!\s*[0-9]))\s*/iu;

/**
 * A title without a «Round 3:» in front of it (also «دور ۳:»): the round is said by the page's own kicker, so the title text never
 * repeats it. Only a prefix that cannot be anything else is cut; a title that is only that (nothing after the prefix) is
 * returned as it was.
 */
export function withoutRoundPrefix(title: string): string {
  const whole = title.trim();
  // the digits are read as Latin ones for the match only; the rest of the title keeps its own
  const prefix = ROUND_PREFIX.exec(toLatinDigits(whole));
  if (!prefix) return whole;
  const cut = whole.slice(prefix[0].length).trim();
  return cut === '' ? whole : cut;
}

const ARABIC_SCRIPT = /\p{Script=Arabic}/u;

/** The recommendation as one line of text, with its confidence («**Recommendation:** Start small (confidence 70%)»). */
export function recommendationLine(recommendation: RecommendationLike, persian = false): string {
  const percent = Math.round(recommendation.confidence * 100);
  return persian
    ? `**پیشنهاد:** ${recommendation.choice.trim()} (اطمینان ${percent}%)`
    : `**Recommendation:** ${recommendation.choice.trim()} (confidence ${percent}%)`;
}

/**
 * The answer as text for somebody who has no box above it (a copy of it, a client of the endpoint): the recommendation line
 * first, then the answer, unless the answer already says it.
 */
export function answerWithRecommendation(
  answer: string,
  recommendation: RecommendationLike | null,
): string {
  const body = answer.trim();
  const choice = recommendation?.choice.trim();
  if (!recommendation || !choice || restatesRecommendation(body, recommendation)) return body;
  return `${recommendationLine(recommendation, ARABIC_SCRIPT.test(body) || ARABIC_SCRIPT.test(choice))}\n\n${body}`;
}

/**
 * The chairman's answer made ready for Markdown. A model writes steps as «۱. …» «۲. …» (Persian digits) on lines that the
 * Markdown of the page would run into one paragraph: such a marker becomes a real list item («1. …»), a list starts on a
 * paragraph of its own, and a single new line is a line break (the way a chat shows it), as the writer meant. Fenced code is
 * left as it is.
 */
export function normalizeAnswer(text: string): string {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const out: string[] = [];
  const isItem: boolean[] = [];
  let inFence = false;
  for (const raw of lines) {
    if (FENCE.test(raw)) inFence = !inFence;
    if (inFence || FENCE.test(raw)) {
      out.push(raw);
      isItem.push(false);
      continue;
    }
    const step = NUMBERED_STEP.exec(raw);
    const item = step !== null || BULLET.test(raw);
    const line = step
      ? `${step[1]}${toLatinDigits(step[2] as string)}. ${raw.slice(step[0].length)}`
      : raw;
    // a list starts on a paragraph of its own
    const before = out.at(-1);
    if (item && !isItem.at(-1) && before !== undefined && before.trim() !== '') {
      out.push('');
      isItem.push(false);
    }
    out.push(line);
    isItem.push(item);
  }
  // a single new line inside a paragraph is a line break (two spaces before it)
  let fenced = false;
  return out
    .map((line, index) => {
      if (FENCE.test(line)) fenced = !fenced;
      const next = out[index + 1];
      if (fenced || FENCE.test(line)) return line;
      if (line.trim() === '' || next === undefined || next.trim() === '') return line;
      if (isItem[index + 1] || /^\s{0,3}#{1,6}\s/u.test(next)) return line;
      return line.endsWith('  ') ? line : `${line}  `;
    })
    .join('\n');
}

/**
 * JSON that cannot break out of its line: JSON escapes the quote, the backslash and every control character, and the line
 * separators JSON leaves as they are (NEL, U+2028, U+2029) are escaped here, so text that came from a member is never more
 * than a string value.
 */
const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATORS = new RegExp(
  `[${[0x85, 0x2028, 0x2029].map((code) => String.fromCharCode(code)).join('')}]`,
  'gu',
);
export const lineSafeJson = (value: unknown, indent?: number): string =>
  JSON.stringify(value, null, indent).replace(
    LINE_SEPARATORS,
    (char) => `${BACKSLASH}u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
