// What the members saw, section by section in plain words (never raw JSON): one readable line per context row.

import type { Key } from '@/i18n/index.tsx';
import type { ContextRow } from '../../../src/shared/types.ts';
import { plainText } from '../fa.ts';

export const CONTEXT_KIND: Record<ContextRow['kind'], Key> = {
  rules: 'ctx.rules',
  background: 'ctx.background',
  question: 'ctx.question',
  context: 'ctx.context',
  input: 'ctx.input',
  summary: 'ctx.summary',
  latest: 'ctx.latest',
  new: 'ctx.new',
  instruction: 'ctx.instruction',
};

const firstLine = (text: string): string => text.split('\n').find((line) => line.trim()) ?? '';

/**
 * The rows that are what somebody wrote: the table shows the whole of it (every answer and the comment of an input, the whole
 * question and context), clamped with an expand. Its token count is the count of all of it.
 */
export const WRITTEN: ReadonlySet<ContextRow['kind']> = new Set([
  'background',
  'question',
  'context',
  'input',
  'new',
]);

/** One row's content as a person would read it: the last answer by its text, an earlier round by title and direction. */
export function readable(row: ContextRow, rulesLine: string): string {
  if (row.kind === 'rules') return rulesLine;
  if (row.kind === 'latest') {
    const lines = row.text.split('\n');
    const at = lines.findIndex((line) => line.startsWith('answer:'));
    const answer = lines
      .slice(at + 1)
      .find((line) => line.trim() && !/^claims:|^questions_for_user:/u.test(line));
    return plainText(answer ?? firstLine(row.text).replace(/^title:\s*/u, ''));
  }
  if (row.kind === 'summary') {
    const title = /^title:\s*(.*)$/mu.exec(row.text)?.[1] ?? '';
    const direction = /^direction:\s*(.*)$/mu.exec(row.text)?.[1] ?? '';
    return plainText([title, direction].filter(Boolean).join(' — '));
  }
  if (WRITTEN.has(row.kind)) return plainText(row.text.trim());
  return plainText(firstLine(row.text));
}

/** Whether a row's text is long enough to be clamped (and then offers «Show all»). */
export const isLong = (text: string): boolean => text.length > 220 || text.split('\n').length > 3;
