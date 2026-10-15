// The server words nothing itself: every sentence is a code with parameters and an English template, and the web app has
// the same code in both of its languages. This pins the table, the helpers and the rule that no Persian text is written
// into the server's responses.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HARNESS_RULES, TOGGLE_KEYS } from '../src/shared/harness-rules.ts';
import {
  fill,
  isNote,
  MESSAGES,
  type MessageCode,
  messageText,
  note,
} from '../src/shared/messages.ts';
import { messagesEn } from '../web/src/i18n/messages-en.ts';
import { messagesFa } from '../web/src/i18n/messages-fa.ts';

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/gu)].map((found) => found[1] as string).sort();
const ARABIC = /\p{Script=Arabic}/u;

describe('the table of messages', () => {
  const codes = Object.keys(MESSAGES) as MessageCode[];

  it('has an English template for every code and no Persian in them', () => {
    expect(codes.length).toBeGreaterThan(50);
    for (const code of codes) {
      expect(MESSAGES[code], code).not.toMatch(ARABIC);
      expect(MESSAGES[code].trim(), code).not.toBe('');
    }
  });

  it('is worded in Persian under the same code, with the same placeholders (drift guard)', () => {
    expect(Object.keys(messagesFa).sort()).toEqual(codes.map((code) => `msg.${code}`).sort());
    for (const code of codes) {
      const key = `msg.${code}` as const;
      expect(messagesFa[key], key).toMatch(ARABIC);
      expect(placeholders(messagesFa[key]), key).toEqual(placeholders(MESSAGES[code]));
      // the English catalogue of the web app is the server's template
      expect(messagesEn[key], key).toBe(MESSAGES[code]);
    }
  });

  it('has both lines of every toggle a harness explains', () => {
    for (const rule of Object.values(HARNESS_RULES)) {
      for (const key of TOGGLE_KEYS) {
        const support = rule[key];
        if (support.code === '') {
          expect(support).toMatchObject({ short: '', note: '' });
          continue;
        }
        expect(`${support.code}_short` in MESSAGES, support.code).toBe(true);
        expect(`${support.code}_note` in MESSAGES, support.code).toBe(true);
        expect(support.short).toBe(MESSAGES[`${support.code}_short` as MessageCode]);
        expect(support.note).toBe(MESSAGES[`${support.code}_note` as MessageCode]);
      }
    }
    expect(HARNESS_RULES.agy.unenforced).toBe(true);
  });
});

describe('notes', () => {
  it('fill the placeholders: numbers grouped, a toggle by its word, a time in UTC', () => {
    expect(fill('{a} and {b}', { a: 1234567, b: 'x' })).toBe('1,234,567 and x');
    expect(fill('{missing} stays', {})).toBe('{missing} stays');
    expect(
      messageText('library_invalidates_model', { model: 'check', level: 'high', reason: 'fields' }),
    ).toBe('This edit makes model check invalid at High (fields).');
    expect(messageText('toggle_forced_on', { toggle: 'memory' })).toBe(
      '“Memory” is always on for this assistant and cannot be turned off.',
    );
    expect(
      messageText('unavailable_model', {
        model: 'm',
        harness: 'Pi',
        until: '2026-10-11T02:46:00Z',
      }),
    ).toBe(
      'The model m (Pi) was left out of the defaults until 2026-10-11 02:46 UTC: its credit or quota ran out or is limited.',
    );
  });

  it('carry the code and the parameters, and the English message', () => {
    expect(note('no_question')).toEqual({ code: 'no_question', message: 'Write the question.' });
    const coded = note('few_members_skipped', { skipped: 2 });
    expect(coded).toEqual({
      code: 'few_members_skipped',
      params: { skipped: 2 },
      message:
        'Fewer than two members gave a valid output (2 did not take part, because their model is not available).',
    });
    expect(isNote(coded)).toBe(true);
    expect(isNote('plain text')).toBe(false);
    expect(isNote(null)).toBe(false);
    expect(isNote({ code: 'x' })).toBe(false);
  });
});

/** Files that may hold Persian: the fake harness's canned answers, text handling, a prompt's example and the /v1 client's language. */
const MAY_HOLD_PERSIAN = new Set([
  join('server', 'adapters', 'fake.ts'),
  join('server', 'gateway.ts'),
  join('server', 'openai.ts'),
  join('server', 'prompts.ts'),
  join('server', 'settings.ts'), // the table that turns a Persian profile name into a readable id
  join('shared', 'text.ts'),
]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('the server writes no Persian into its responses', () => {
  it('holds no Persian outside comments, apart from the files that work on Persian text', () => {
    const root = join(import.meta.dirname, '..', 'src');
    const found: string[] = [];
    for (const file of sources(root)) {
      const relative = file.slice(root.length + 1);
      if (MAY_HOLD_PERSIAN.has(relative)) continue;
      for (const [index, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (ARABIC.test(line) && !/^\s*(\/\/|\*|\/\*)/u.test(line))
          found.push(`${relative}:${index + 1}`);
      }
    }
    expect(found).toEqual([]);
  });
});
