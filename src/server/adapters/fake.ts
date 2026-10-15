// The built-in fake harness (DIVAN_FAKE=1): deterministic canned JSON, no process and no subscription. The model id picks
// a behaviour: fake-slow, fake-fail, fake-invalid, fake-prose (a Markdown report with no JSON), fake-timeout (silent: stopped when the idle window passes), fake-stall
// (one sign of work, then silent), fake-think (works for a while sending signs of work and thinking tokens, never stopped),
// fake-long (over every budget), fake-nocredit (an account that is out), fake-ratelimit, fake-hang (silent until cancelled),
// fake-throw, fake-nofolder (answers without a project folder, and says so); anything else answers normally. A fake claude seat opens its stance with "As Claude," so the self-identification stripping can be seen at work.

import { note } from '../../shared/messages.ts';
import { estimateTokens } from '../../shared/text.ts';
import type { HarnessId, HarnessModels, Usage } from '../../shared/types.ts';
import type { AgentRun } from './index.ts';
import type { RunSpec } from './types.ts';

const hash = (text: string): number => {
  let h = 2166136261;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
};

export function fakeModels(harness: HarnessId): HarnessModels {
  const efforts = ['low', 'medium', 'high', 'max'];
  return {
    harness,
    models: [
      ...(harness === 'pi' ? ['litellm/deepseek/deepseek-flash', 'google/gemini-pro'] : []),
      'fake-1',
      'fake-2',
      'fake-slow',
      'fake-fail',
      'fake-invalid',
      'fake-prose',
      'fake-timeout',
      'fake-long',
      'fake-hang',
      'fake-throw',
      'fake-nocredit',
      'fake-ratelimit',
      'fake-nofolder',
      'fake-think',
      'fake-stall',
      'fake-flaky',
    ].map((id) => ({ id, label: id, efforts, defaultEffort: 'medium' })),
    listed: true,
    defaultModel: 'fake-1',
    note: note('models_fake'),
    fallbackEfforts: efforts,
    fetchedAt: new Date().toISOString(),
  };
}

const STANCES = [
  'Prefer the cheaper reversible option first.',
  'Delay the commitment until one number is known.',
  'Go ahead, but cap the downside in writing.',
  'The safer path wins unless speed matters most.',
  'Split the decision into a small test and a full commitment.',
];
const CLAIMS = [
  'The reversible option keeps your choices open at low cost.',
  'One missing number decides the outcome and can be measured this week.',
  'Fixed costs are the main risk and they grow with every month of delay.',
  'Most regret in such decisions comes from skipping a cheap test.',
  'A written exit condition makes the commitment safer.',
  'The upside is real but smaller than it looks at first sight.',
  'Speed matters only if a competitor can close the gap.',
  'Past choices should not drive the next one.',
];

/** The lenses the fake planner returns, in this order (a real planner writes them for the question; these are for tests). */
export const FAKE_LENSES = [
  'Which assumption, if wrong, would change the recommendation?',
  'What does the asker really want from this decision?',
  'What evidence in the context supports or weakens the main option?',
  'Which constraint, cost or deadline is most likely to bind first?',
  'What would a reversible first step look like, if one exists?',
  'Which alternative has the asker not considered?',
  'What happens if nothing is done?',
  'Who else is affected, and how would they react?',
];

/** The newest words the asker wrote in a member's prompt: the new input, else the question. */
function inputOf(prompt: string): string {
  const section = (tag: string) =>
    new RegExp(String.raw`^<${tag}[^>]*>\n([\s\S]*?)\n</${tag}>`, 'mu').exec(prompt)?.[1];
  return section('new_user_input') ?? section('question') ?? '';
}

function memberJson(spec: RunSpec, seed: number, long: boolean): string {
  // lens modes: a member that answers a lens alone reports a finding (and may give no recommendation)
  const onlyLens =
    /Answer this investigative question about it, using all the context: (.*?) Report what you find/u.exec(
      spec.prompt,
    )?.[1];
  // ... and one with an additional angle investigates it besides
  const angle = /Your additional angle: (.*?) Investigate it where relevant/u.exec(
    spec.prompt,
  )?.[1];
  const round2 = /^<latest_answer round=/mu.test(spec.prompt);
  const claimIds = [...spec.prompt.matchAll(/^- (R\d+-C\d+) \[/gmu)].map(
    (match) => match[1] as string,
  );
  const count = long ? 8 : 3 + (seed % 3);
  const claims = Array.from({ length: count }, (_, i) => ({
    text: long
      ? `${CLAIMS[(seed + i) % CLAIMS.length]} ${'This sentence is padded to run over the word budget. '.repeat(4)}`
      : (CLAIMS[(seed + i) % CLAIMS.length] as string),
    confidence: Number((0.5 + ((seed + i) % 5) / 10).toFixed(2)),
  }));
  const stance = onlyLens
    ? `Nothing significant found on the lens: ${onlyLens}`.slice(0, 160)
    : `${spec.harness === 'claude' ? 'As Claude, I say: ' : ''}${STANCES[seed % STANCES.length]}`;
  if (onlyLens)
    claims.unshift({
      text: `Outside my lens: the cost of waiting is not measured.`,
      confidence: 0.4,
    });
  if (angle)
    claims.push({
      text: `On my angle (${angle.slice(0, 80)}): no sign that it changes the plan.`,
      confidence: 0.5,
    });
  // the full report comes first, as in a real answer: a few Markdown lines that quote the input the member was given
  const report = [
    '## Main findings',
    '',
    onlyLens
      ? `On the lens "${onlyLens.slice(0, 80)}": nothing significant found.`
      : `On "${quoteOf(inputOf(spec.prompt))}": begin with the cheapest step that can be undone.`,
    '',
    '## Details',
    '',
    ...claims.slice(0, 3).map((claim) => `- ${claim.text}`),
    '',
    'Source: none (a fake run reads nothing).',
  ].join('\n');
  const out: Record<string, unknown> = {
    report,
    stance,
    recommendation: onlyLens
      ? null
      : {
          choice: seed % 2 === 0 ? 'Start small and measure' : 'Wait for the missing number',
          why: 'It limits the downside while the unknowns are still large.',
          confidence: Number((0.55 + (seed % 4) / 10).toFixed(2)),
        },
    options: [
      { name: 'Start small', for: 'Cheap and reversible.', against: 'Slower to reach scale.' },
      { name: 'Commit fully', for: 'Fastest route to the upside.', against: 'Hard to undo.' },
    ],
    claims,
    risks: ['Costs grow while you wait.', 'The estimate may be off by a lot.'],
    unknowns: ['What is the monthly cost at full scale?'],
    would_change_my_mind: 'A measured result that beats the estimate by half.',
    // a member with memory brings back what it found there; one without has none
    memory_facts: spec.memory
      ? [{ fact: 'The asker runs a team of two with a small budget.', source: 'projects/team' }]
      : [],
  };
  if (round2) {
    out.votes = claimIds.slice(0, 3).map((id, i) => ({
      claim: id,
      vote: (['agree', 'unsure', 'disagree'] as const)[(seed + i) % 3],
      why: 'Matches my own reading of the numbers.',
    }));
  }
  return JSON.stringify(out);
}

// ---------- what a call costs, as a real harness reports it ----------
//
// A real call reads far more than the prompt: the harness adds its own system prompt, tool definitions and hooks (about 15k
// tokens whatever the question), and answers with a thousand to a few thousand tokens, more at a higher effort. A round of four
// members and a chairman costs about 100k in real use, so the fake reports on that scale and the usage the app shows looks real.

/** What each assistant's harness adds to every call before it reads the prompt (tokens). */
const OVERHEAD: Record<string, number> = {
  claude: 16_000,
  codex: 15_000,
  grok: 14_000,
  pi: 15_000,
  agy: 15_000,
};
/** The tokens of an answer by effort: from about 1k to about 3k. */
const OUTPUT: Record<string, number> = { low: 1_000, medium: 1_800, high: 2_400, max: 3_000 };

/** `DIVAN_FAKE_USAGE`: the scale of the overhead and the answer (1: as real; the unit tests run at a small fraction). */
const usageScale = (): number => {
  const scale = Number(process.env.DIVAN_FAKE_USAGE ?? '1');
  return Number.isFinite(scale) && scale >= 0 ? scale : 1;
};

function usageOf(spec: RunSpec, text: string, seed: number): Usage {
  const scale = usageScale();
  const input =
    estimateTokens(spec.prompt) + Math.round((OVERHEAD[spec.harness] ?? 15_000) * scale);
  // a few percent either way, the same for the same assistant and model
  const spread = 0.95 + (seed % 11) / 100;
  const output = Math.max(
    Math.ceil(text.length / 4),
    Math.round((OUTPUT[spec.effort] ?? OUTPUT.medium ?? 1_800) * spread * scale),
  );
  return { input, output, cached: 0, total: input + output, source: 'harness' };
}

// ---------- titles and quotes from what the asker wrote ----------

/** Words a title should not end on («Should I leave my stable job as a»): a cut backs up over them. */
const DANGLING = new Set(
  `a an the and or but if of to in on at for with from by as is are was be i my me we our you your it its that this than so
  و در به از که را با این آن برای یا اگر هم تا بر`
    .split(/\s+/u)
    .filter(Boolean),
);

/** The first sentence of a text, without the «Q:» of an answer to a question. */
function firstSentence(text: string): string {
  const flat = text.replace(/^\s*Q:\s*/u, '').trim();
  return (/^[^\n]*?[.!?؟…](?=\s|$)/u.exec(flat)?.[0] ?? flat.split('\n')[0] ?? '').trim();
}

const TRAILING = /[\s,;:،؛\-–—.!?؟…"“”«»()]+$/u;

/**
 * A title from the first sentence of `text`: the sentence as it is written (small words and all), cut after at most `max` words
 * at a word boundary, never ending on a small word, and marked with «…» when it was cut. Empty when there is no text.
 */
function titleOf(text: string, max: number): string {
  const words = firstSentence(text).split(/\s+/u).filter(Boolean);
  if (words.length === 0) return '';
  const cut = words.length > max;
  let kept = words.slice(0, max);
  while (cut && kept.length > 2 && DANGLING.has((kept.at(-1) ?? '').toLowerCase()))
    kept = kept.slice(0, -1);
  const title = kept.join(' ').replace(TRAILING, '');
  return cut ? `${title}…` : title;
}

/** A short quotation of the latest words of the asker: its first sentence, at most twelve words. */
function quoteOf(text: string): string {
  const words = firstSentence(text).split(/\s+/u).filter(Boolean);
  const quote = words.slice(0, 12).join(' ').replace(TRAILING, '');
  return words.length > 12 ? `${quote}…` : quote;
}

// What the chairman may ask, one question at a time, never one the asker has already answered.
const QUESTIONS_EN = [
  'What is the monthly cost at full scale?',
  'Who will maintain it after the launch?',
  'What would make you stop?',
];
const QUESTIONS_FA = [
  'هزینهٔ ماهانه در مقیاس کامل چقدر است؟',
  'بعد از عرضه چه کسی نگهداری‌اش می‌کند؟',
  'چه چیزی باعث می‌شود متوقف شوید؟',
];

function chairmanJson(spec: RunSpec, seed: number): string {
  const round = Number(/<round>(\d+)<\/round>/u.exec(spec.prompt)?.[1] ?? '1');
  const sample =
    /<reply_language_sample>\n([\s\S]*?)\n<\/reply_language_sample>/u.exec(spec.prompt)?.[1] ?? '';
  const persian = /\p{Script=Arabic}/u.test(sample);
  const members: { label: string; claims: { text: string }[] }[] = [];
  for (const match of spec.prompt.matchAll(
    /<<<MEMBER ([A-Z]) (\w+)>>>\n([\s\S]*?)\n<<<END MEMBER \1 \2>>>/gu,
  )) {
    try {
      members.push({
        label: match[1] as string,
        ...(JSON.parse(match[3] as string) as { claims: { text: string }[] }),
      });
    } catch {
      // a member block that is not JSON is skipped
    }
  }
  const statuses = ['accepted', 'accepted', 'open', 'rejected'] as const;
  const claims = members.slice(0, 4).map((_member, i) => ({
    id: `X${i + 1}`,
    text: persian
      ? `ادعای نمونهٔ ${i + 1} در دور ${round}`
      : `Sample claim ${i + 1} of round ${round}`,
    status: statuses[i % statuses.length],
    from: members.slice(0, i + 1).map((other) => other.label),
  }));
  // Titles follow the newest input, so two branches of the same round come out with different titles: three to five words that
  // say what it is about, as the real chairman writes them (never the first words, never «Round N»).
  const critique = /^<instruction>$/mu.test(spec.prompt);
  // the title is the first sentence of what the asker wrote last, cut to about six words: it reads as the asker wrote it
  const subjectTitle = titleOf(sample, 6);
  const critiqueTitle = titleOf(sample, 4);
  const excerpt = quoteOf(sample);
  const answered = new Set(
    [...spec.prompt.matchAll(/^Q: (.+)$/gmu)].map((match) => (match[1] as string).trim()),
  );
  const nextQuestion = (persian ? QUESTIONS_FA : QUESTIONS_EN).find(
    (question) => !answered.has(question),
  );
  // asked for only while the session has not chosen: «تو» in the asker's text is informal, anything else formal
  const asksRegister = Boolean(
    (spec.schema as { properties?: Record<string, unknown> } | undefined)?.properties?.register,
  );
  return JSON.stringify({
    ...(asksRegister
      ? {
          register:
            persian && /(?:^|\s)(?:تو|توی|برات|بگو)(?:\s|$)/u.test(sample) ? 'informal' : 'formal',
        }
      : {}),
    input_title: subjectTitle || (persian ? 'ورودی' : 'Input'),
    title: critique
      ? `${persian ? 'نقد' : 'Critique'}: ${critiqueTitle || (persian ? 'پاسخ پیشین' : 'the last answer')}`
      : subjectTitle || (persian ? 'پاسخ' : 'Answer'),
    direction:
      round <= 1
        ? persian
          ? 'ابتدا کوچک شروع کن'
          : 'Start small first'
        : critique
          ? persian
            ? 'بدون ورودی تازه دوباره بررسی شد'
            : 'Re-examined without new input'
          : persian
            ? 'با ورودی تازه تنظیم شد'
            : 'Adjusted for the new input',
    // the first line answers what the asker wrote last, so the rounds of a session differ and a comment can be seen to count
    answer: persian
      ? `${
          critique
            ? 'با نگاهی دوباره به پاسخ قبلی: گام ارزان و برگشت‌پذیر هنوز اول است.'
            : round <= 1
              ? `برای «${excerpt}»: با ارزان‌ترین گامی شروع کن که برگردانده می‌شود.`
              : `با توجه به «${excerpt}»: گام اول را کوچک و برگشت‌پذیر نگه دار.`
        }\n\nمراحل کار:\n۱. هزینهٔ ثابت را پیش از تعهد بسنج.\n۲. یک شرط خروج بنویس.`
      : `${
          critique
            ? 'Looking again at the last answer: the cheap, reversible step still comes first.'
            : round <= 1
              ? `On "${excerpt}": begin with the cheapest step that can be undone.`
              : `Taking "${excerpt}" into account: keep the first step small and reversible.`
        }\n\n- Measure the fixed cost before committing.\n- Write down an exit condition.`,
    recommendation: { choice: persian ? 'کوچک شروع کن' : 'Start small', confidence: 0.7 },
    questions_for_user: nextQuestion ? [nextQuestion] : [],
    claims,
    seat_scores: members.map((member, i) => ({ label: member.label, score: 5 + ((seed + i) % 5) })),
    // the members whose own recommendation is the final one: those that chose to start small
    agreement: members.length
      ? {
          agree: members.filter((_member, i) => (seed + i) % 2 === 0).length,
          of: members.length,
        }
      : null,
    dissent: members.every((_member, i) => (seed + i) % 2 === 0)
      ? null
      : persian
        ? 'بعضی اعضا صبر برای یک عدد را ترجیح دادند؛ آن دیدگاه به شرط اندازه‌گیری تبدیل شد.'
        : 'Some members preferred to wait for one number; that view became a condition to measure.',
  });
}

export async function runFake(spec: RunSpec): Promise<AgentRun> {
  const seed = hash(`${spec.harness}|${spec.model}`);
  const isChairman = 'input_title' in (spec.schema.properties ?? {});
  const isPlanner = 'lenses' in (spec.schema.properties ?? {});
  const base = Number(process.env.DIVAN_FAKE_DELAY_MS ?? '120');
  const started = Date.now();
  // Waits, but ends early (and says so) when the round is cancelled.
  const wait = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (spec.signal?.aborted) return resolve(true);
      const timer = setTimeout(() => resolve(false), ms);
      spec.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        { once: true },
      );
    });
  const done = (
    text: string,
    error: string | null = null,
    extra: Partial<AgentRun> = {},
  ): AgentRun => ({
    text,
    usage: error ? null : usageOf(spec, text, seed),
    error,
    timedOut: false,
    cancelled: false,
    durationMs: Date.now() - started,
    diagnostics: error ?? '',
    ...extra,
  });
  const cancelled = () => done('', 'cancelled', { cancelled: true });
  // a sign of work, as a real harness's output would be
  let thinking = 0;
  const sign = () => spec.onSignal?.({ thinkingTokens: thinking });

  if (await wait(base + (seed % 200))) return cancelled();
  sign();
  if (spec.model === 'fake-slow' && (await wait(2500))) return cancelled();
  if (spec.model === 'fake-hang' && (await wait(60_000))) return cancelled();
  if (spec.model === 'fake-timeout') {
    // silent: nothing is ever sent, so the idle window is all there is
    if (await wait(spec.idleMs)) return cancelled();
    return done('', 'timeout', { timedOut: true });
  }
  if (spec.model === 'fake-stall') {
    // one more sign, then silence until the idle window passes
    thinking = 10;
    sign();
    if (await wait(spec.idleMs)) return cancelled();
    return done('', 'timeout', { timedOut: true });
  }
  if (spec.model === 'fake-think') {
    // works well past the idle window, sending a sign every so often and growing its thinking: never stopped
    const total = Number(process.env.DIVAN_FAKE_THINK_MS ?? '1500');
    const step = Math.max(10, Math.floor(spec.idleMs / 3));
    for (let spent = 0; spent < total; spent += step) {
      if (await wait(step)) return cancelled();
      thinking += 120;
      sign();
    }
  }
  if (spec.model === 'fake-throw') throw new Error('the fake adapter threw on purpose');
  if (spec.model === 'fake-fail') return done('', 'the fake harness failed on purpose');
  if (spec.model === 'fake-flaky' && spec.attempt !== 2) {
    return done('', 'Connection closed', { usage: usageOf(spec, '', seed) });
  }
  if (spec.model === 'fake-ratelimit') {
    return done('', '429 Too Many Requests: rate limit reached, retry in a minute');
  }
  if (spec.model.endsWith('fake-nocredit')) {
    return done(
      '',
      '429: {"message":"Insufficient balance or no resource package. Please recharge."}',
    );
  }
  if (spec.model === 'fake-invalid') return done('I could not decide, so here is no JSON at all.');
  if (isPlanner) {
    // the lens planner (lens modes): deterministic lenses; the chairman's model name picks a bad day for it
    if (spec.model.includes('lens-fail')) return done('', 'the fake planner failed on purpose');
    if (spec.model.includes('lens-bad')) return done('I will not give any JSON.');
    const wanted = Number(/- At most (\d+)\./u.exec(spec.prompt)?.[1] ?? '0');
    const count = spec.model.includes('lens-none')
      ? 0
      : spec.model.includes('lens-few')
        ? Math.min(1, wanted)
        : Math.min(wanted, FAKE_LENSES.length);
    return done(
      JSON.stringify({
        lenses: FAKE_LENSES.slice(0, count).map((question) => ({
          question,
          why: 'It may change what the council recommends.',
        })),
      }),
    );
  }
  // fake-prose: a member that did the work and returned its report as plain Markdown, with no JSON object
  if (spec.model === 'fake-prose' && !isChairman) {
    const { report } = JSON.parse(memberJson(spec, seed, false)) as { report: string };
    return done(report);
  }
  const isReport = spec.schema.required?.length === 1 && spec.schema.required[0] === 'report';
  const custom =
    !!spec.formFields ||
    (!isReport &&
      !isChairman &&
      !('stance' in spec.schema.properties && 'claims' in spec.schema.properties));
  const schemaValue = (schema: RunSpec['schema'], field = ''): unknown => {
    if (schema.anyOf)
      return schemaValue(
        schema.anyOf.find((s: RunSpec['schema']) => s.type !== 'null') ?? schema.anyOf[0],
        field,
      );
    if (schema.enum) return schema.enum[0];
    if (schema.type === 'object')
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, value]) => [
          key,
          schemaValue(value as RunSpec['schema'], key),
        ]),
      );
    if (schema.type === 'array')
      return spec.formFields?.find((f) => f.name === field)?.maxItems === 0
        ? []
        : [schemaValue(schema.items, field)];
    if (schema.type === 'boolean') return true;
    if (schema.type === 'number' || schema.type === 'integer') {
      const bounds = spec.formFields?.find((f) => f.name === field);
      const min = bounds?.min ?? schema.minimum ?? Math.min(0, bounds?.max ?? schema.maximum ?? 0);
      const max = bounds?.max ?? schema.maximum ?? Math.max(10, min);
      return (min + max) / 2;
    }
    if (schema.type === 'null') return null;
    const limit = spec.formFields?.find((f) => f.name === field)?.maxWords ?? 2000;
    return `fake ${field}`.split(/\s+/u).slice(0, limit).join(' ');
  };
  const text = custom
    ? JSON.stringify(
        spec.model === 'fake-branch-low'
          ? { score: 1, note: 'private source fact' }
          : schemaValue(spec.schema),
      )
    : isReport
      ? JSON.stringify({
          report: `## Draft\n\nOn "${quoteOf(inputOf(spec.prompt))}": begin with a reversible step.\n\nCheck the cost, the evidence and the strongest countercase before committing.\n\nSource: none (a fake run reads nothing).`,
        })
      : isChairman
        ? chairmanJson(spec, seed)
        : memberJson(spec, seed, spec.model === 'fake-long');
  // A harness that cannot keep a project folder's own files out answers without the folder, and says so.
  const folderNote =
    spec.model === 'fake-nofolder' && spec.cwd
      ? {
          folderNote:
            'working folder not used by fake: the folder is trusted, so its own hooks would load',
        }
      : {};
  // Real harnesses wrap JSON in prose or a fence now and then; the fake does it for one seat in three.
  return done(
    seed % 3 === 0 ? `Here is my answer:\n\`\`\`json\n${text}\n\`\`\`` : text,
    null,
    folderNote,
  );
}
