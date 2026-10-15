// A field that goes over its limit is cut at the end of a sentence or a word, never inside a word, and says so with «…».

import { describe, expect, it } from 'vitest';
import { shorten, trimToLimit } from '../src/shared/text.ts';

describe('cutting a field to its limits', () => {
  it('keeps a field that fits; cuts after the last whole sentence, else after the last whole word, with «…»', () => {
    expect(trimToLimit('A short claim.', { maxWords: 5, maxChars: 100 })).toEqual({
      text: 'A short claim.',
      by: [],
    });
    const sentences =
      'First sentence here. Second sentence follows. Third one goes on and on forever';
    const cut = trimToLimit(sentences, { maxWords: 8 });
    expect(cut.by).toEqual(['words']);
    expect(cut.text).toBe('First sentence here. Second sentence follows. …');
    expect(trimToLimit('one two three four five six seven', { maxWords: 4 })).toEqual({
      text: 'one two three four…',
      by: ['words'],
    });
  });

  it('never cuts inside a word to meet a character limit; one endless word is cut where the limit falls; both limits apply in order', () => {
    const text = 'alpha beta gamma delta epsilon zeta';
    for (let limit = 8; limit < text.length; limit += 1) {
      const cut = trimToLimit(text, { maxChars: limit });
      expect(cut.text.length, `limit ${limit}`).toBeLessThanOrEqual(limit + 2);
      expect(cut.text.endsWith('…'), `limit ${limit}`).toBe(true);
      for (const word of cut.text.replace(/ ?…$/u, '').split(' ')) {
        expect(text.split(' '), `limit ${limit}: "${word}"`).toContain(word);
      }
    }
    expect(trimToLimit('x'.repeat(500), { maxChars: 40 })).toEqual({
      text: `${'x'.repeat(39)}…`,
      by: ['chars'],
    });
    expect(trimToLimit('aaaa bbbb cccc dddd eeee ffff', { maxWords: 5, maxChars: 12 })).toEqual({
      text: 'aaaa bbbb…',
      by: ['words', 'chars'],
    });
  });

  it('a link is one word and its characters are not counted: the cut is never at a source', () => {
    const link = `https://example.com/${'a'.repeat(300)}`;
    const claim = `Rent is fixed, see ${link} and [the lease](${link}) for the terms.`;
    // 11 words and 300+ characters of link: kept whole under a limit that counts the words around the links only
    expect(trimToLimit(claim, { maxWords: 11, maxChars: 80 })).toEqual({ text: claim, by: [] });
    // one more word than the limit is still cut at a word, and a link is not split
    const cut = trimToLimit(claim, { maxWords: 5, maxChars: 80 });
    expect(cut.by).toEqual(['words']);
    expect(cut.text).toBe('Rent is fixed, see https://example.com/'.concat('a'.repeat(300), '…'));
    // the characters around a link still count, and a cut that falls after a link keeps the whole link
    const long = `${'word '.repeat(10)}${link} ${'word '.repeat(30)}`;
    const trimmed = trimToLimit(long, { maxChars: 100 });
    expect(trimmed.by).toEqual(['chars']);
    expect(trimmed.text.endsWith('…')).toBe(true);
    expect(trimmed.text.replaceAll(link, '').length).toBeLessThanOrEqual(101);
    expect(trimmed.text).toContain(link);
    const before = trimToLimit(`${'word '.repeat(10)}${link}`, { maxChars: 30 });
    expect(before.text.includes('https')).toBe(false);
  });

  it('cuts Persian text at a word or a sentence too, and keeps the half-space inside a word', () => {
    const text =
      'می‌توانید از یک وب‌اپ ساده شروع کنید. سپس بر پایهٔ بازخورد واقعی تصمیم بگیرید و هزینهٔ ثابت را کم نگه دارید';
    expect(trimToLimit(text, { maxWords: 12 }).text).toBe('می‌توانید از یک وب‌اپ ساده شروع کنید. …');
    expect(trimToLimit('می‌توانید از وب‌اپ ساده شروع کنید', { maxWords: 3 }).text).toBe(
      'می‌توانید از وب‌اپ…',
    );
  });
});

describe('a title or a subtitle', () => {
  it('is cut after a whole word, with «…», and never inside a word', () => {
    expect(shorten('اگر بودجه فقط برای یک نفر باشد چه می‌شود', 20)).toBe('اگر بودجه فقط برای…');
    expect(shorten('a short title', 40)).toBe('a short title');
    expect(shorten('one two three four five', 12)).toBe('one two…');
    for (let max = 6; max < 30; max += 1) {
      const text = 'alpha beta gamma delta epsilon zeta';
      const cut = shorten(text, max);
      expect([...cut].length, `max ${max}`).toBeLessThanOrEqual(max);
      const words = cut.replace(/…$/u, '').split(' ').filter(Boolean);
      for (const word of words) expect(text.split(' '), `max ${max}: ${word}`).toContain(word);
    }
    // one endless word has no boundary
    expect(shorten('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
