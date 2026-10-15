// The untrusted boundary: everything a harness prints is text we did not write. This module takes the first JSON object
// out of it (in one linear pass, with hard size limits), cuts it to the budgets and records what it cut, validates it
// against the JSON Schema, and strips self-identification before the chairman sees a member's words. Nothing here
// executes or renders the text.

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import type { ReportOutput } from '../shared/flow.ts';
import { compileForm, type FormField } from '../shared/library.ts';
import { type MessageCode, type MessageParams, type Note, note } from '../shared/messages.ts';
import { trimToLimit, withoutRestatedRecommendation, withoutRoundPrefix } from '../shared/text.ts';
import type {
  ChairClaim,
  ChairmanOutput,
  ClaimStatus,
  JsonSchema,
  Lens,
  MemberOutput,
} from '../shared/types.ts';

/** A harness's whole output above this size is refused before anything is parsed. */
export const MAX_OUTPUT_CHARS = 256 * 1024;
/** A parsed, cut response above this serialized size is refused (a member's report alone may run to 8000 words). */
export const MAX_RESPONSE_CHARS = 512 * 1024;

/** No trimming, clamping, or prose recovery: branch predicates see the original validated values. */
export function parseCustom(args: {
  text: string;
  fields: FormField[];
}): ParseResult<Record<string, unknown>> {
  const raw = extractFirstJson(args.text);
  const validate = validatorFor(compileForm(args.fields));
  const invalid = (
    code: MessageCode,
    params: MessageParams,
  ): ParseResult<Record<string, unknown>> => {
    const errorNote = note(code, params);
    return { ok: false, error: errorNote.message, errorNote };
  };
  if (!isObject(raw)) return invalid('custom_form_invalid', { field: 'answer' });
  if (!validate(raw)) {
    const first = validate.errors?.[0];
    return invalid('custom_form_invalid', {
      field:
        first?.instancePath.slice(1) ||
        first?.params.missingProperty ||
        first?.params.additionalProperty ||
        'answer',
    });
  }
  for (const field of args.fields) {
    const value = raw[field.name];
    if (value === null) continue;
    if (
      typeof value === 'number' &&
      ((field.min !== undefined && value < field.min) ||
        (field.max !== undefined && value > field.max))
    )
      return invalid('custom_form_bounds', {
        field: field.name,
        min: field.min ?? '-∞',
        max: field.max ?? '∞',
      });
    if (Array.isArray(value) && value.length > (field.maxItems ?? 20))
      return invalid('custom_form_items', { field: field.name, max: field.maxItems ?? 20 });
    const texts =
      typeof value === 'string' ? [value] : Array.isArray(value) ? (value as string[]) : [];
    if (
      texts.some(
        (text) =>
          text.length > 64000 ||
          text.trim().split(/\s+/u).filter(Boolean).length >
            (field.maxWords ?? (field.type === 'markdown' ? 8000 : 2000)),
      )
    )
      return invalid('custom_form_words', {
        field: field.name,
        max: field.maxWords ?? (field.type === 'markdown' ? 8000 : 2000),
        maxChars: 64000,
      });
  }
  return { ok: true, value: raw, trimmed: [] };
}

/** Reports have no summary fallback: reject empty or oversized text before normal field trimming. */
export function parseReport(args: { text: string; schema: JsonSchema }): ParseResult<ReportOutput> {
  const raw = extractFirstJson(args.text);
  if (
    !isObject(raw) ||
    Object.keys(raw).length !== 1 ||
    typeof raw.report !== 'string' ||
    !raw.report.trim() ||
    raw.report.length > 64000 ||
    raw.report.trim().split(/\s+/u).length > 8000
  ) {
    return { ok: false, error: 'empty, oversized or invalid report' };
  }
  const result = parseWith(args.text, args.schema, () => {});
  return result.ok ? { ...result, value: result.value as unknown as ReportOutput } : result;
}
/**
 * Characters allowed per word of a field's word limit, and the most any one field may hold. The characters of a link are not
 * counted (and a link is one word): a claim is never cut at its source.
 */
const CHARS_PER_WORD = 8;
const FIELD_CHAR_CAP = 100_000;
/** A string with no word limit (an id, a label). */
const FREE_STRING_CAP = 200;
/** JSON.parse attempts per scan, and rescans after a stray "{". */
const MAX_ATTEMPTS = 50;
const MAX_RESCANS = 8;

const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addKeyword({ keyword: 'x-maxWords', schemaType: 'number' });

const validators = new Map<string, ReturnType<typeof ajv.compile>>();
const canonicalSchema = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalSchema)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonicalSchema(item)]),
        )
      : value;
function validatorFor(schema: JsonSchema) {
  const { $id: _id, ...rest } = schema;
  const key = createHash('sha256')
    .update(JSON.stringify(canonicalSchema(rest)))
    .digest('hex');
  let validate = validators.get(key);
  if (!validate) {
    try {
      validate = ajv.compile(rest);
    } finally {
      // AJV's strong schema cache must not outlive our bounded validator cache, including failed compilation.
      ajv.removeSchema(rest);
    }
    if (validators.size >= 128) validators.delete(validators.keys().next().value as string);
    validators.set(key, validate);
  }
  return validate;
}
export const validPayload = (schema: JsonSchema, value: unknown): boolean =>
  !!validatorFor(schema)(value);

/** Compile before admitting a profile: malformed schemas must not spend a harness call. */
export function validateSchema(schema: JsonSchema, contract?: JsonSchema): void {
  validatorFor(schema);
  if (contract) {
    // Limits and annotations may vary; the parser's complete field structure may not.
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shape)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .filter(
                  ([key]) =>
                    ![
                      '$schema',
                      '$id',
                      'title',
                      'description',
                      'x-maxWords',
                      'minItems',
                      'maxItems',
                      'minLength',
                      'maxLength',
                      'minimum',
                      'maximum',
                    ].includes(key),
                )
                .map(([key, item]) => [
                  key,
                  key === 'properties'
                    ? Object.fromEntries(
                        Object.entries(item as JsonSchema).map(([name, field]) => [
                          name,
                          shape(field),
                        ]),
                      )
                    : ['required', 'enum'].includes(key) && Array.isArray(item)
                      ? [...item].sort()
                      : shape(item),
                ]),
            )
          : value;
    if (!isDeepStrictEqual(shape(schema), shape(contract)))
      throw new Error('incompatible form schema');
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The first JSON object in `text`, even inside prose or a code fence. One pass finds every balanced "{...}" (strings
 * are skipped only inside an object, so stray quotes in prose do not matter); the candidates are tried from the
 * earliest start, at most 50 parses. A stray unclosed "{" makes a rescan from just after it (at most 8 times), so the
 * work stays linear in the size, which is itself limited.
 */
export function extractFirstJson(text: string): unknown {
  if (text.length > MAX_OUTPUT_CHARS) return undefined;
  let from = 0;
  for (let scan = 0; scan < MAX_RESCANS && from < text.length; scan += 1) {
    const spans: [number, number][] = [];
    const stack: number[] = [];
    let inString = false;
    let escaped = false;
    for (let i = from; i < text.length; i += 1) {
      const char = text[i];
      if (stack.length === 0) {
        if (char === '{') stack.push(i);
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') stack.push(i);
      else if (char === '}') {
        const start = stack.pop();
        if (start !== undefined) spans.push([start, i]);
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    for (const [start, end] of spans.slice(0, MAX_ATTEMPTS)) {
      try {
        const value: unknown = JSON.parse(text.slice(start, end + 1));
        if (isObject(value)) return value;
      } catch {
        // not JSON: the next candidate
      }
    }
    const stray = stack[0];
    if (stray === undefined) break;
    from = stray + 1;
  }
  return undefined;
}

/** Walks `value` along `schema`: cuts arrays and strings to their limits, clamps numbers, drops unknown keys. */
function coerce(value: unknown, schema: JsonSchema, path: string, trimmed: string[]): unknown {
  if (Array.isArray(schema.anyOf)) {
    if (value === null && schema.anyOf.some((branch: JsonSchema) => branch.type === 'null')) {
      return null;
    }
    const branch = schema.anyOf.find((candidate: JsonSchema) => candidate.type !== 'null');
    return branch ? coerce(value, branch, path, trimmed) : value;
  }
  if (Array.isArray(schema.enum) && typeof value === 'string') {
    // a word of the list in another case is that word
    const hit = schema.enum.find(
      (word: unknown) =>
        typeof word === 'string' && word.toLowerCase() === value.trim().toLowerCase(),
    );
    if (hit !== undefined) return hit;
  }
  switch (schema.type) {
    case 'object': {
      if (!isObject(value)) return value;
      const out: Record<string, unknown> = {};
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      for (const [key, child] of Object.entries(properties)) {
        if (key in value) {
          out[key] = coerce(value[key], child, `${path}${path ? '.' : ''}${key}`, trimmed);
        }
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) return value;
      let items = value;
      if (typeof schema.maxItems === 'number' && items.length > schema.maxItems) {
        trimmed.push(`${path}: ${items.length} → ${schema.maxItems}`);
        items = items.slice(0, schema.maxItems);
      }
      return items.map((item, index) =>
        coerce(item, schema.items ?? {}, `${path}[${index}]`, trimmed),
      );
    }
    case 'string': {
      if (typeof value !== 'string') return value;
      const max = schema['x-maxWords'];
      const original = value.trim();
      // Words are not enough: a "word" can be a megabyte, so every field has a character limit too.
      const maxChars =
        typeof max === 'number'
          ? Math.min(FIELD_CHAR_CAP, Math.max(40, max * CHARS_PER_WORD))
          : FREE_STRING_CAP;
      // A cut is made at the end of a sentence or a word and says so with «…»: never in the middle of a word.
      const cut = trimToLimit(original, {
        ...(typeof max === 'number' ? { maxWords: max } : {}),
        maxChars,
      });
      if (cut.by.includes('words')) trimmed.push(`${path}: ${max}+ words → ${max}`);
      if (cut.by.includes('chars')) {
        trimmed.push(`${path}: ${original.length} chars → ${maxChars}`);
      }
      return cut.text;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return value;
      let next = value;
      if (typeof schema.minimum === 'number') next = Math.max(schema.minimum, next);
      if (typeof schema.maximum === 'number') next = Math.min(schema.maximum, next);
      if (next !== value) trimmed.push(`${path}: ${value} → ${next}`);
      return next;
    }
    default:
      return value;
  }
}

export type ParseResult<T> =
  | { ok: true; value: T; trimmed: string[] }
  /** `lacksFields`: there was no JSON object, or the only thing wrong with it is that required fields are missing. */
  | { ok: false; error: string; errorNote?: Note; lacksFields?: true };

function validate(
  schema: JsonSchema,
  data: unknown,
): { error: string; lacksFields: boolean } | null {
  const check = validatorFor(schema);
  if (check(data)) return null;
  const errors = check.errors ?? [];
  const first = errors[0];
  return {
    error: first ? `${first.instancePath || '/'} ${first.message ?? 'is invalid'}` : 'invalid',
    lacksFields: errors.length > 0 && errors.every((error) => error.keyword === 'required'),
  };
}

/** The shared front half: size limit, first JSON object, cut, validate, serialized size. */
function parseWith(
  text: string,
  schema: JsonSchema,
  adjust: (data: Record<string, unknown>, trimmed: string[]) => void,
  /** Changes what was read before it is cut to the budgets (a word that is not wanted must not use up a budget). */
  prepare?: (raw: Record<string, unknown>) => void,
): ParseResult<Record<string, unknown>> {
  if (typeof text !== 'string') return { ok: false, error: 'no text in the output' };
  if (text.length > MAX_OUTPUT_CHARS) {
    return { ok: false, error: `output is larger than ${MAX_OUTPUT_CHARS / 1024} KB` };
  }
  const raw = extractFirstJson(text);
  if (raw === undefined) {
    return { ok: false, error: 'no JSON object in the output', lacksFields: true };
  }
  const trimmed: string[] = [];
  if (isObject(raw)) prepare?.(raw);
  const data = coerce(raw, schema, '', trimmed);
  if (!isObject(data)) return { ok: false, error: 'the JSON is not an object' };
  adjust(data, trimmed);
  const problem = validate(schema, data);
  if (problem) {
    return {
      ok: false,
      error: problem.error,
      ...(problem.lacksFields ? { lacksFields: true as const } : {}),
    };
  }
  if (JSON.stringify(data).length > MAX_RESPONSE_CHARS) {
    return {
      ok: false,
      error: `response is larger than ${MAX_RESPONSE_CHARS / 1024} KB after cutting`,
    };
  }
  return { ok: true, value: data, trimmed };
}

export interface ParseMemberArgs {
  text: string;
  schema: JsonSchema;
  round: number;
  /** Claim ids of the previous chairman node (round 2 on); votes on any other id are dropped. */
  previousClaimIds: string[];
  /** Whether this member ran with memory: only then may `memory_facts` hold anything. */
  memory?: boolean;
}

/** The least text (after trimming) that is kept as a member's report when it did not return the form. */
export const MIN_REPORT_ONLY_CHARS = 200;

/**
 * A member that worked but did not return the form: its plain text (no JSON object, or an object that holds no member field,
 * such as a snippet inside prose) is its report, cut like the report field, and every other field is empty or null. An object
 * that is a member's answer with fields missing is not prose: only its own `report` counts. Too short a text is no report.
 */
function reportOnlyOf(text: string, schema: JsonSchema): ParseResult<MemberOutput> | null {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const raw = extractFirstJson(text);
  let source = text;
  if (isObject(raw) && Object.keys(raw).some((key) => Object.hasOwn(properties, key))) {
    source = typeof raw.report === 'string' ? raw.report : '';
  }
  if (source.trim().length < MIN_REPORT_ONLY_CHARS) return null;
  // an attempt at the JSON that was cut off or broken is not prose: it would only show JSON syntax as a report
  if (raw === undefined && /^\s*(?:```[a-z]*\s*)?\{/iu.test(text)) return null;
  const trimmed: string[] = [];
  const report = coerce(
    source,
    properties.report ?? { type: 'string', 'x-maxWords': 8000 },
    'report',
    trimmed,
  ) as string;
  return {
    ok: true,
    trimmed,
    value: {
      report,
      reportOnly: true,
      stance: '',
      recommendation: null,
      options: [],
      claims: [],
      risks: [],
      unknowns: [],
      would_change_my_mind: '',
      memory_facts: [],
    },
  };
}

/**
 * Member output: first JSON object, cut to the budgets, validated. Invalid output is not retried. Substantial text with no
 * JSON object, or an object that only lacks the summary fields, is kept as a report-only answer (`reportOnly`).
 */
export function parseMember(args: ParseMemberArgs): ParseResult<MemberOutput> {
  const result = parseWith(args.text, args.schema, (data, trimmed) => {
    if (args.round <= 1) {
      if ('votes' in data) trimmed.push('votes: dropped (round 1)');
      delete data.votes;
    } else if (Array.isArray(data.votes)) {
      const known = new Set(args.previousClaimIds);
      const kept = data.votes.filter(
        (vote: unknown) => isObject(vote) && known.has(String(vote.claim)),
      );
      if (kept.length !== data.votes.length) {
        trimmed.push(`votes: ${data.votes.length - kept.length} on unknown claim ids dropped`);
      }
      data.votes = kept;
    }
    // the facts of a member without memory are none, whatever it wrote; an absent list is an empty one
    if (Array.isArray(data.memory_facts) && data.memory_facts.length > 0 && args.memory !== true) {
      trimmed.push(`memory_facts: ${data.memory_facts.length} dropped (no memory)`);
      data.memory_facts = [];
    } else if (!Array.isArray(data.memory_facts)) {
      data.memory_facts = [];
    }
  });
  if (result.ok) {
    return { ok: true, value: result.value as unknown as MemberOutput, trimmed: result.trimmed };
  }
  return (result.lacksFields && reportOnlyOf(args.text, args.schema)) || result;
}

/**
 * What the lens planner returned: its lenses, with an empty question dropped and a question that repeats another dropped. The
 * schema (`plannerSchemaFor`) carries the most it may return, and the code cuts a longer list and every question to 30 words.
 * An answer with no lens is a valid answer (no useful distinctions); an output that is not the shape is an error.
 */
export function parsePlanner(args: {
  text: string;
  schema: JsonSchema;
}): ParseResult<{ lenses: Lens[] }> {
  let dropped = 0;
  const result = parseWith(
    args.text,
    args.schema,
    (_data, trimmed) => {
      if (dropped > 0) trimmed.push(`lenses: ${dropped} empty or repeated dropped`);
    },
    (raw) => {
      if (!Array.isArray(raw.lenses)) return;
      // before the list is cut to the most asked for: an empty or repeated lens must not take a place a good one could have had
      const seen = new Set<string>();
      raw.lenses = raw.lenses.filter((item: unknown) => {
        if (!isObject(item)) return true;
        // a lens whose reason was left out is still a lens
        if (item.why === undefined) item.why = '';
        const key = String(item.question ?? '')
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, ' ')
          .trim();
        if (key === '' || seen.has(key)) {
          dropped += 1;
          return false;
        }
        seen.add(key);
        return true;
      });
    },
  );
  return result.ok
    ? { ok: true, value: result.value as unknown as { lenses: Lens[] }, trimmed: result.trimmed }
    : result;
}

export interface ParseChairmanArgs {
  text: string;
  schema: JsonSchema;
  round: number;
  /** The labels used this round. */
  labels: string[];
  /**
   * `only` lens mode: the members reported findings on their lenses and did not answer the question, so "agreement" counts the
   * members whose findings bear on the recommendation: `of` is the chairman's own number (at most the members it was given).
   */
  lensOnly?: boolean;
}

const STATUSES: ClaimStatus[] = ['accepted', 'rejected', 'open'];

/** Chairman output: as for a member, then ids are assigned by the code and labels are checked against the round's. */
export function parseChairman(args: ParseChairmanArgs): ParseResult<ChairmanOutput> {
  // the round is said by the page's kicker: a title never starts with «Round N:» (taken off before the five words are counted)
  const result = parseWith(
    args.text,
    args.schema,
    () => undefined,
    (raw) => {
      for (const field of ['title', 'input_title']) {
        if (typeof raw[field] === 'string') raw[field] = withoutRoundPrefix(raw[field]);
      }
    },
  );
  if (!result.ok) return result;
  const out = result.value as unknown as ChairmanOutput;
  if (!out.answer.trim()) return { ok: false, error: '/answer is empty' };
  // the page shows the recommendation above the answer: a paragraph that says it again is cut
  if (out.recommendation) {
    const cleaned = withoutRestatedRecommendation(out.answer, out.recommendation);
    if (cleaned !== out.answer.trim()) {
      result.trimmed.push('answer: a paragraph that only restated the recommendation dropped');
    }
    out.answer = cleaned;
  }
  const form = String(out.register ?? '')
    .trim()
    .toLowerCase();
  if (form === 'formal' || form === 'informal') out.register = form;
  else delete out.register;
  const labels = new Set(args.labels);
  const credited = out.claims.flatMap((claim) => claim.from).length;
  out.claims = out.claims.map(
    (claim, index): ChairClaim => ({
      id: `R${args.round}-C${index + 1}`,
      text: claim.text,
      status: STATUSES.includes(claim.status) ? claim.status : 'open',
      from: [...new Set(claim.from.map((label) => label.trim().toUpperCase()))].filter((label) =>
        labels.has(label),
      ),
    }),
  );
  const kept = out.claims.flatMap((claim) => claim.from).length;
  if (kept < credited)
    result.trimmed.push(`claims: ${credited - kept} credit(s) to unknown members dropped`);
  // how far the council agreed: `of` is how many answers the chairman was given, `agree` cannot exceed it
  const given = args.labels.length;
  const agreement = out.agreement as unknown;
  if (isObject(agreement) && Number.isFinite(agreement.agree) && Number.isFinite(agreement.of)) {
    // lens `only`: `of` is the members whose findings bear on the recommendation (the chairman's number, within the members it
    // was given); otherwise it is how many answers the chairman was given
    const of = args.lensOnly
      ? Math.max(0, Math.min(given, Math.round(Number(agreement.of))))
      : given;
    const agree = Math.max(0, Math.min(of, Math.round(Number(agreement.agree))));
    if (Number(agreement.of) !== of || Number(agreement.agree) !== agree) {
      result.trimmed.push(`agreement: ${agreement.agree} of ${agreement.of} → ${agree} of ${of}`);
    }
    out.agreement = args.lensOnly && of === 0 ? null : { agree, of };
  } else {
    out.agreement = null;
  }
  // where the members split: absent or empty is none
  out.dissent = typeof out.dissent === 'string' && out.dissent.trim() ? out.dissent.trim() : null;
  const scored = out.seat_scores.length;
  const seen = new Set<string>();
  out.seat_scores = out.seat_scores.filter((entry) => {
    const label = entry.label.trim().toUpperCase();
    entry.label = label;
    if (!labels.has(label) || seen.has(label)) return false;
    seen.add(label);
    return true;
  });
  if (out.seat_scores.length < scored) {
    result.trimmed.push(
      `seat_scores: ${scored - out.seat_scores.length} for unknown members dropped`,
    );
  }
  return { ok: true, value: out, trimmed: result.trimmed };
}

// ---------- Self-identification ----------

export const NAME_PLACEHOLDER = '[AI]';

// Vendors and the model families they ship. Whole words, any case; "Pi" only as the capitalised word.
const VENDORS = [
  'anthropic',
  'openai',
  'google',
  'deepmind',
  'x\\.ai',
  'xai',
  'deepseek',
  'zhipu',
  'z\\.ai',
  'alibaba',
  'moonshot',
  'mistral',
  'meta',
  'microsoft',
];
const MODELS = [
  'claude',
  'opus',
  'sonnet',
  'haiku',
  'fable',
  'codex',
  'chatgpt',
  'gpt[-\\w.]*',
  'gemini',
  'gemma',
  'bard',
  'antigravity',
  'agy',
  'hermes',
  'grok',
  'glm[-\\w.]*',
  'qwen[-\\w.]*',
  'llama[-\\w.]*',
  'copilot',
  'kimi',
];
// Words that continue a model name ("Claude Opus 5.5", "Gemini 3.8 Flash", "Grok-4.7").
const CONTINUES =
  '(?:[ -](?:\\d[\\w.]*|opus|sonnet|haiku|fable|flash|pro|ultra|mini|nano|astra|sol|luna|terra|code|build|fast|turbo|plus|max|v\\d[\\w.]*))*';
const NOT_WORD = '(?<![\\p{L}\\p{N}])';
const NOT_WORD_AFTER = '(?![\\p{L}\\p{N}])';
// "I am OpenAI's biggest fan" names a vendor, not the speaker: a possessive after the name is not self-identification.
const NOT_POSSESSIVE = "(?!['’]s\\b)";

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The names a member could call itself: the base list plus this session's own harness and model names. */
function nameAlternatives(identities: string[]): string {
  const own = identities
    .flatMap((identity) => [identity, identity.split('/').at(-1) ?? identity])
    .map((identity) => identity.trim())
    .filter((identity) => identity.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((identity) => escapeRegExp(identity).replace(/\s+/gu, '\\s+'));
  return [...own, ...MODELS, ...VENDORS].join('|');
}

/**
 * Strips self-identification, nothing else: "I am X", "my name is X", "As X, …", a signature line, and a vendor named
 * as the maker of the speaker ("a model trained by Y"). A name that is part of the advice ("use Claude for writing",
 * "built by Google") stays. `identities` are this session's seat names (harness labels, model ids and labels).
 */
export function stripSelfIdentification(
  text: string,
  identities: string[] = [],
): { text: string; count: number } {
  let count = 0;
  const mark = () => {
    count += 1;
    return NAME_PLACEHOLDER;
  };
  const names = nameAlternatives(identities);
  const name = `(?:${names})${CONTINUES}`;
  const vendor = `(?:${VENDORS.join('|')})`;
  const first =
    "(?:I am|I'm|I’m|I was|my name is|my name's|speaking as|writing as|answering as|responding as)";
  const flags = 'giu';
  let out = text;

  // "I am X", "I'm an AI named X", "my name is X"
  out = out.replace(
    new RegExp(
      `(${NOT_WORD}${first}\\s+(?:an?\\s+|the\\s+)?(?:(?:AI|LLM|assistant|model|chatbot)\\s+(?:called|named|known as)\\s+)?)(${name})${NOT_WORD_AFTER}${NOT_POSSESSIVE}`,
      flags,
    ),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  // "As X, I think" (the comma, colon or dash is what makes it self-identification)
  out = out.replace(
    new RegExp(`(${NOT_WORD}as\\s+(?:an?\\s+)?(?:AI\\s+)?)(${name})(?=\\s*[,:—–]|\\s+-\\s)`, flags),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  // A signature line: "— X"
  out = out.replace(
    new RegExp(`^(\\s*[-–—~]\\s*)(${name})\\s*$`, 'gimu'),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  // "a model trained by Y", "I'm made by Y": the speaker's own maker
  out = out.replace(
    new RegExp(
      `(${NOT_WORD}(?:I'm|I’m|I am|I was|as an?|being an?)\\s+(?:[\\w-]+\\s+){0,5}?(?:model|AI|assistant|chatbot|LLM)\\b[^.!?\\n]{0,40}?\\b(?:by|from)\\s+)(${vendor})${NOT_WORD_AFTER}`,
      flags,
    ),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  // "I am [AI] from Google"
  out = out.replace(
    new RegExp(`(\\[AI\\][^.!?\\n]{0,80}?\\b(?:by|from)\\s+)(${vendor})${NOT_WORD_AFTER}`, flags),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  // "I am Pi": only the capitalised word counts
  out = out.replace(
    new RegExp(`(${NOT_WORD}${first}\\s+(?:an?\\s+|the\\s+)?)(Pi)(?!\\.\\d|[\\p{L}\\p{N}])`, 'gu'),
    (_all, lead: string) => `${lead}${mark()}`,
  );
  return { text: out, count };
}

/** A copy of `value` with every string passed through `stripSelfIdentification`. */
export function stripSelfIdentificationDeep<T>(
  value: T,
  identities: string[] = [],
): { value: T; count: number } {
  let count = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = stripSelfIdentification(node, identities);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, walk(child)]));
    }
    return node;
  };
  return { value: walk(value) as T, count };
}
