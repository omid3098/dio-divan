// The chairman's answer: numbered steps written with Persian digits become real list items, and a single new line is a line
// break, so the steps do not run into one paragraph.

import { describe, expect, it } from 'vitest';
import { normalizeAnswer } from '../src/shared/text.ts';

describe('the chairman’s answer as Markdown', () => {
  it('numbered steps in any digits become list items, on a paragraph of their own after their lead-in', () => {
    expect(normalizeAnswer('۱. اول\n۲. دوم')).toBe('1. اول\n2. دوم');
    expect(normalizeAnswer('۱) اول\n۲) دوم')).toBe('1. اول\n2. دوم');
    expect(normalizeAnswer('١- اول\n٢- دوم')).toBe('1. اول\n2. دوم');
    expect(normalizeAnswer('1) first\n2) second')).toBe('1. first\n2. second');
    expect(normalizeAnswer('۱۲. دوازدهم')).toBe('12. دوازدهم');
    expect(normalizeAnswer('مراحل کار:\n۱. اول\n۲. دوم')).toBe('مراحل کار:\n\n1. اول\n2. دوم');
    // even when the first step is not number 1 (it could not interrupt a paragraph otherwise)
    expect(normalizeAnswer('متن\n۳. سوم')).toBe('متن\n\n3. سوم');
    // bullets that are already Markdown stay, kept together with their lead-in
    expect(normalizeAnswer('گام‌ها\n- اول\n- دوم')).toBe('گام‌ها\n\n- اول\n- دوم');
  });

  it('a single new line is a line break and a blank line a paragraph; no break inside a list or before a heading', () => {
    expect(normalizeAnswer('سطر اول\nسطر دوم\n\nبند دوم')).toBe('سطر اول  \nسطر دوم\n\nبند دوم');
    expect(normalizeAnswer('۱. اول\n۲. دوم\n۳. سوم')).toBe('1. اول\n2. دوم\n3. سوم');
    expect(normalizeAnswer('متن\n## عنوان')).toBe('متن\n## عنوان');
  });

  it('leaves alone what is not a step (a year, a decimal, a date, a number in a sentence), fenced code, and nothing', () => {
    for (const text of [
      '۲۰۲۶ سال خوبی بود',
      '3.5 میلیون',
      '2026-10-10 است',
      'در ۲.۵ ثانیه',
      '۱۲۳',
      '```\n۱. این کد است\nخط دوم\n```',
      'یک خط',
      '',
    ]) {
      expect(normalizeAnswer(text)).toBe(text);
    }
  });
});
