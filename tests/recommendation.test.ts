// The recommendation is shown above the answer, so the answer must not say it again: the prompt tells the chairman not to, and a
// first or a last paragraph that really restates THIS round's recommendation is cut as a fallback. A paragraph that only
// starts with the word is the answer's own and stays. A copy of the answer and the text of the endpoint start with the
// recommendation line.

import { describe, expect, it } from 'vitest';
import { parseChairman } from '../src/server/parse.ts';
import { chairmanRules, chairmanSchemaFor } from '../src/server/prompts.ts';
import {
  answerWithRecommendation,
  recommendationLine,
  restatesRecommendation,
  withoutRestatedRecommendation,
} from '../src/shared/text.ts';

const small = { choice: 'Start small', confidence: 0.7 };
const persian = { choice: 'کوچک شروع کن', confidence: 0.7 };

describe('the answer does not restate the recommendation', () => {
  it('cuts the one first line that is the recommendation and nothing else', () => {
    expect(
      withoutRestatedRecommendation(
        '**Recommendation:** start small.\n\nMeasure the cost first.',
        small,
      ),
    ).toBe('Measure the cost first.');
    expect(
      withoutRestatedRecommendation('**پیشنهاد:** کوچک شروع کن.\n\nهزینه را بسنج.', persian),
    ).toBe('هزینه را بسنج.');
    // the bold may close after the colon too, and the label may be plain
    expect(withoutRestatedRecommendation('**Recommendation**: Start small.\n\nBody.', small)).toBe(
      'Body.',
    );
    expect(withoutRestatedRecommendation('Recommendation: START SMALL\n\nBody.', small)).toBe(
      'Body.',
    );
  });

  it('accepts the known confidence decorations on that line, in both languages and with any digits', () => {
    for (const line of [
      '**Recommendation:** Start small (70%)',
      '**Recommendation:** Start small (confidence 70%)',
      '**Recommendation:** Start small (confidence: 70%).',
      '**Recommendation:** Start small · confidence 70%',
      '**Recommendation:** Start small - confidence 70%',
    ]) {
      expect(withoutRestatedRecommendation(`${line}\n\nBody.`, small)).toBe('Body.');
    }
    for (const line of [
      '**پیشنهاد:** کوچک شروع کن (اطمینان 70%)',
      '**پیشنهاد:** کوچک شروع کن (اطمینان ۷۰٪)',
      '**پیشنهاد:** کوچک شروع کن · اطمینان ۷۰٪',
    ]) {
      expect(withoutRestatedRecommendation(`${line}\n\nبدنه.`, persian)).toBe('بدنه.');
    }
    // the line recommendationLine writes is always cut
    expect(withoutRestatedRecommendation(`${recommendationLine(small)}\n\nBody.`, small)).toBe(
      'Body.',
    );
  });

  it('keeps a line that says more than the recommendation, and every other line', () => {
    // the reproduction: the recommendation is only the start of the line
    const funding = '**Recommendation:** Start small only after securing funding.\n\nBody.';
    expect(withoutRestatedRecommendation(funding, small)).toBe(funding);
    expect(restatesRecommendation(funding, small)).toBe(false);
    // the same at the end of the answer
    const last = 'Body.\n\n**Recommendation:** Start small only after securing funding.';
    expect(withoutRestatedRecommendation(last, small)).toBe(last);
    // another wording of it is not the recommendation either: in doubt the line stays
    const paraphrase =
      '**Recommendation:** start with a small reversible step.\n\nMeasure the cost first.';
    expect(withoutRestatedRecommendation(paraphrase, small)).toBe(paraphrase);
    const persianParaphrase = '**پیشنهاد:** با یک گام کوچک و برگشت‌پذیر شروع کن.\n\nهزینه را بسنج.';
    expect(withoutRestatedRecommendation(persianParaphrase, persian)).toBe(persianParaphrase);
    // a decoration that is more than the confidence, or another confidence than the one shown
    for (const line of [
      '**Recommendation:** Start small (70%) but check the budget',
      '**Recommendation:** Start small (confidence 70%, unless prices rise)',
      '**Recommendation:** Start small (confidence 95%)',
      // the number must be exactly the one shown (70%): a neighbour is another claim, and the line stays
      '**Recommendation:** Start small (69%)',
      '**Recommendation:** Start small (71%)',
      '**Recommendation:** Start small (confidence 71%)',
      '**Recommendation:** Start small · confidence 69%',
      '**Recommendation:** Start small, or wait',
    ]) {
      expect(withoutRestatedRecommendation(`${line}\n\nBody.`, small)).toBe(`${line}\n\nBody.`);
    }
    // and a longer line that starts with it
    const longer =
      '**Recommendation:** start small, but first confirm the budget with finance and with the legal team, because the contract renews in March.\n\nBody.';
    expect(withoutRestatedRecommendation(longer, small)).toBe(longer);
  });

  it('cuts exactly one line: a warning right after it stays, and so does anything after a list', () => {
    // the reproduction: the exact recommendation, a new line, then a warning in the same paragraph
    expect(
      withoutRestatedRecommendation(
        '**Recommendation:** Start small\nWarning: this only works if funding is secured.\n\nBody.',
        small,
      ),
    ).toBe('Warning: this only works if funding is secured.\n\nBody.');
    expect(
      withoutRestatedRecommendation(
        '**پیشنهاد:** کوچک شروع کن.\nمراحل کار:\n۱. هزینه را بسنج.\n\nدور ۱.',
        persian,
      ),
    ).toBe('مراحل کار:\n۱. هزینه را بسنج.\n\nدور ۱.');
    expect(
      withoutRestatedRecommendation(
        '**Recommendation:** start small.\n- Measure the cost.\n- Write an exit.\n\nDone.',
        small,
      ),
    ).toBe('- Measure the cost.\n- Write an exit.\n\nDone.');
    // a second restating line is not cut with the first
    expect(
      withoutRestatedRecommendation(
        '**Recommendation:** start small.\nMore.\n**Recommendation:** start small.',
        small,
      ),
    ).toBe('More.\n**Recommendation:** start small.');
  });

  it('cuts a last line that is the recommendation', () => {
    expect(
      withoutRestatedRecommendation(
        'Measure the cost first.\n\n**Recommendation:** start small.',
        small,
      ),
    ).toBe('Measure the cost first.');
    expect(
      withoutRestatedRecommendation(
        'Measure the cost first.\nWatch the budget.\n**Recommendation:** Start small (70%)',
        small,
      ),
    ).toBe('Measure the cost first.\nWatch the budget.');
  });

  it('keeps a paragraph that only starts with the word: it is the answer', () => {
    // the label of the example has no colon, and what follows is its own claim
    const prose =
      '**Recommendation** quality depends on keeping a second backup.\n\nThen measure the cost.';
    expect(withoutRestatedRecommendation(prose, small)).toBe(prose);
    // with a colon, but saying something else than the recommendation says
    const other =
      '**Recommendation:** quality depends on keeping a second backup.\n\nThen measure the cost.';
    expect(withoutRestatedRecommendation(other, small)).toBe(other);
    expect(restatesRecommendation(prose, small)).toBe(false);
    expect(restatesRecommendation(other, small)).toBe(false);
  });

  it('leaves everything else alone', () => {
    const plain = 'Measure the cost first.\n\nThe recommendation is in the middle of a sentence.';
    expect(withoutRestatedRecommendation(plain, small)).toBe(plain);
    // a middle line is not touched
    const middle = 'Intro.\n\n**Recommendation:** start small.\n\nOutro.';
    expect(withoutRestatedRecommendation(middle, small)).toBe(middle);
    // no recommendation, nothing is cut
    expect(withoutRestatedRecommendation('**Recommendation:** start small.\n\nBody.', null)).toBe(
      '**Recommendation:** start small.\n\nBody.',
    );
  });

  it('keeps an answer that is nothing but the recommendation', () => {
    expect(withoutRestatedRecommendation('**Recommendation:** start small.', small)).toBe(
      '**Recommendation:** start small.',
    );
    // and says that it is one, so that nobody adds the line a second time
    expect(restatesRecommendation('**Recommendation:** start small.', small)).toBe(true);
  });

  describe('as the chairman is parsed (the server)', () => {
    const budgets = { maxClaims: 5, maxWords: 30 };
    const schema = chairmanSchemaFor(budgets);
    const output = (extra: Record<string, unknown>) =>
      JSON.stringify({
        input_title: 'Title',
        title: 'Round',
        direction: 'Direction',
        answer: '**Recommendation:** start small.\n\nMeasure the cost first.',
        recommendation: { choice: 'Start small', confidence: 0.7 },
        questions_for_user: [],
        claims: [],
        seat_scores: [],
        ...extra,
      });
    const parse = (extra: Record<string, unknown>) =>
      parseChairman({ text: output(extra), schema, round: 1, labels: ['A', 'B'] });

    it('drops the restating paragraph, and says so', () => {
      const result = parse({});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.answer).toBe('Measure the cost first.');
      expect(result.trimmed.join(' ')).toMatch(/only restated the recommendation/u);
    });

    it('keeps a paragraph that only starts with the word', () => {
      const answer =
        '**Recommendation** quality depends on keeping a second backup.\n\nThen measure the cost.';
      const result = parse({ answer });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.answer).toBe(answer);
      expect(result.trimmed.join(' ')).not.toMatch(/restated/u);
    });

    it('keeps a recommendation-only answer, and any answer when the round has no recommendation', () => {
      const only = parse({ answer: '**Recommendation:** start small.' });
      expect(only.ok && only.value.answer).toBe('**Recommendation:** start small.');
      const none = parse({ recommendation: null });
      expect(none.ok && none.value.answer).toContain('**Recommendation:**');
    });
  });

  it('the chairman’s prompt tells it not to restate the recommendation', () => {
    const rules = chairmanRules({ maxClaims: 5, maxWords: 30 });
    expect(rules).toMatch(/Do not restate the "recommendation" inside "answer"/u);
    expect(rules).toMatch(/do not restate the recommendation, it is shown above the answer/u);
  });
});

describe('the answer with its recommendation line (a copy, the endpoint)', () => {
  it('starts with the recommendation and its confidence, then the answer', () => {
    expect(answerWithRecommendation('Measure the cost first.', small)).toBe(
      '**Recommendation:** Start small (confidence 70%)\n\nMeasure the cost first.',
    );
    expect(answerWithRecommendation('هزینه را بسنج.', persian)).toBe(
      '**پیشنهاد:** کوچک شروع کن (اطمینان 70%)\n\nهزینه را بسنج.',
    );
    expect(recommendationLine({ choice: 'Wait', confidence: 0.655 })).toBe(
      '**Recommendation:** Wait (confidence 66%)',
    );
  });

  it('is the answer alone when there is no recommendation, or when it already says it', () => {
    expect(answerWithRecommendation('Measure the cost first.', null)).toBe(
      'Measure the cost first.',
    );
    const old = '**Recommendation:** start small.\n\nMeasure the cost first.';
    expect(answerWithRecommendation(old, small)).toBe(old);
  });
});

describe('a title says what the round is about, never the round', () => {
  it('loses a «Round N:» in front of it, in both languages and with any digits', async () => {
    const { withoutRoundPrefix } = await import('../src/shared/text.ts');
    expect(withoutRoundPrefix('Round 2: Wife returns to work')).toBe('Wife returns to work');
    expect(withoutRoundPrefix('round 12 - Part-time at the bank')).toBe('Part-time at the bank');
    expect(withoutRoundPrefix('Round 2 – Wife returns')).toBe('Wife returns');
    expect(withoutRoundPrefix('دور ۳: بازگشت همسر به کار')).toBe('بازگشت همسر به کار');
    expect(withoutRoundPrefix('دور ۱۲ - بازگشت')).toBe('بازگشت');
    // the title keeps its own digits
    expect(withoutRoundPrefix('دور ۳: ۵ سال سرمایه‌گذاری')).toBe('۵ سال سرمایه‌گذاری');
    expect(withoutRoundPrefix('Round 3: 5 years of saving')).toBe('5 years of saving');
    expect(withoutRoundPrefix('Roundabout cost')).toBe('Roundabout cost');
    expect(withoutRoundPrefix('Round 2:')).toBe('Round 2:');
  });

  it('keeps a title whose number is part of what it says', async () => {
    const { withoutRoundPrefix } = await import('../src/shared/text.ts');
    // a range written with Persian digits is not a round
    expect(withoutRoundPrefix('دور ۳-۵ ساله سرمایه‌گذاری')).toBe('دور ۳-۵ ساله سرمایه‌گذاری');
    expect(withoutRoundPrefix('دور ۳ - ۵ ساله سرمایه‌گذاری')).toBe('دور ۳ - ۵ ساله سرمایه‌گذاری');
    // a decimal number, a range, a thousands separator
    expect(withoutRoundPrefix('Round 3.5 to nearest integer')).toBe('Round 3.5 to nearest integer');
    expect(withoutRoundPrefix('Round 3-5 weeks')).toBe('Round 3-5 weeks');
    expect(withoutRoundPrefix('Round 3 - 5 weeks')).toBe('Round 3 - 5 weeks');
    // extra whitespace after the dash does not make a range into a prefix (Latin and Persian digits, any dash, tabs)
    expect(withoutRoundPrefix('Round 3 -  5 weeks')).toBe('Round 3 -  5 weeks');
    expect(withoutRoundPrefix('Round 3 –   5 weeks')).toBe('Round 3 –   5 weeks');
    expect(withoutRoundPrefix('Round 3 — 	 5 weeks')).toBe('Round 3 — 	 5 weeks');
    expect(withoutRoundPrefix('دور ۳ –  ۵ ساله')).toBe('دور ۳ –  ۵ ساله');
    expect(withoutRoundPrefix('دور ۳ -    ۵ ساله سرمایه‌گذاری')).toBe(
      'دور ۳ -    ۵ ساله سرمایه‌گذاری',
    );
    // while a real prefix with a wide gap still goes
    expect(withoutRoundPrefix('Round 3 -  Part-time at the bank')).toBe('Part-time at the bank');
    expect(withoutRoundPrefix('دور ۳ –  بازگشت همسر')).toBe('بازگشت همسر');
    expect(withoutRoundPrefix('Round 3,000 units')).toBe('Round 3,000 units');
    expect(withoutRoundPrefix('Round 3 pricing')).toBe('Round 3 pricing');
    expect(withoutRoundPrefix('دور ۲.۵ درصد')).toBe('دور ۲.۵ درصد');
  });

  it('is applied to the chairman’s title and input title as they are parsed', () => {
    const schema = chairmanSchemaFor({ maxClaims: 5, maxWords: 30 });
    const result = parseChairman({
      text: JSON.stringify({
        input_title: 'Round 1: Leave my job',
        title: 'Round 1: Leaving the stable job',
        direction: 'd',
        answer: 'Body.',
        recommendation: null,
        questions_for_user: [],
        claims: [],
        seat_scores: [],
      }),
      schema,
      round: 1,
      labels: ['A'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe('Leaving the stable job');
    expect(result.value.input_title).toBe('Leave my job');
  });

  it('the chairman is asked for a short specific title and never to re-ask an answered question', () => {
    const rules = chairmanRules({ maxClaims: 5, maxWords: 30 });
    expect(rules).toMatch(/3 to 5 words: what this round is about/u);
    expect(rules).toMatch(/never the first words of the input and never «Round N»/u);
    expect(rules).toMatch(/Never ask again a question that is answered there/u);
  });
});
