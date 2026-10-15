// The Context table says what the members were sent: the row of the asker's own input shows the whole of it (every answer and the
// comment), not only its first line, and its token count is the count of all of it.

import { describe, expect, it } from 'vitest';
import { buildContext } from '../src/shared/context.ts';
import type { ChairNode, ContextRow } from '../src/shared/types.ts';
import { chairNode, userNode } from './fixtures.ts';

const MODULE = '../web/src/panel/context-text.ts';
interface Module {
  readable(row: ContextRow, rulesLine: string): string;
  isLong(text: string): boolean;
  WRITTEN: ReadonlySet<string>;
}

describe('the row of the asker’s own input', async () => {
  const { readable, isLong, WRITTEN } = (await import(MODULE)) as Module;
  const answers = [
    { question: 'What is the monthly cost at full scale?', answer: 'About two hundred dollars.' },
    { question: 'Who maintains it?', answer: 'Nobody yet.' },
  ];
  const comment = 'Please be blunt, and tell me what you would drop first.';
  const root = userNode('u0', null, 'Should I build it?');
  const chair = chairNode('c1', 'u0', 1) as ChairNode;
  const built = buildContext({
    nodes: { u0: root, c1: chair },
    rootId: 'u0',
    fromChairId: 'c1',
    newInput: { answers, comment },
    rules: 'RULES',
    critiqueInstruction: 'CRITIQUE',
  });
  const row = built.rows.find((one) => one.kind === 'new') as ContextRow;

  it('shows every answer and the comment, with the questions they answer', () => {
    const text = readable(row, '');
    expect(text).toContain('Q: What is the monthly cost at full scale?');
    expect(text).toContain('A: About two hundred dollars.');
    expect(text).toContain('Q: Who maintains it?');
    expect(text).toContain('A: Nobody yet.');
    expect(text).toContain(comment);
  });

  it('its token count covers all of it, not the first line', () => {
    const firstLine = 'Q: What is the monthly cost at full scale?';
    expect(row.tokens).toBeGreaterThan(Math.ceil(firstLine.length / 4) + 20);
    expect(row.text).toContain(comment);
  });

  it('a long one is clamped (and offers «Show all»), a short one is not', () => {
    expect(WRITTEN.has('new')).toBe(true);
    expect(WRITTEN.has('input')).toBe(true);
    expect(isLong(readable(row, ''))).toBe(true);
    expect(isLong('A short comment.')).toBe(false);
  });

  it('the rows that are not the asker’s own words stay one readable line', () => {
    const rules = built.rows.find((one) => one.kind === 'rules') as ContextRow;
    expect(readable(rules, 'Rules the members follow')).toBe('Rules the members follow');
    expect(WRITTEN.has('rules')).toBe(false);
  });
});
