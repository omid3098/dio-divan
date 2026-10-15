// How a client's conversation maps onto Divan's tree, and which working folders may be used.

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonical, isRemote } from '../src/server/canonical.ts';
import {
  BACKGROUND_TOKENS,
  backgroundOf,
  canonicalAssistant,
  canonicalize,
  plan,
  remember,
} from '../src/server/conversation.ts';
import { cwdFromSystemPrompt, folderFor, validateCwd } from '../src/server/cwd.ts';
import type { ApiIndex, ApiRef } from '../src/server/store.ts';
import { closingRound, lastRound, roundLink, withoutRoundLink } from '../src/shared/round-link.ts';
import { estimateTokens } from '../src/shared/text.ts';

const empty: ApiIndex = { exact: {}, prefixes: {} };
const ref: ApiRef = { sessionId: 's1', chairId: 'c1' };
const alive = () => true;
const UUID = '11111111-1111-1111-1111-111111111111';

describe('canonical messages', () => {
  it('keeps only user and assistant text, in order, ending with a user turn', () => {
    const { turns, system } = canonicalize([
      { role: 'system', content: 'SYSTEM PROMPT. Current working directory: C:/p' },
      { role: 'developer', content: 'DEV' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'one' },
          { type: 'image_url', image_url: {} },
        ],
      },
      { role: 'assistant', content: null, tool_calls: [{ id: 't' }] },
      { role: 'tool', content: 'TOOL RESULT' },
      { role: 'assistant', content: 'two' },
      { role: 'assistant', content: '  three  ' },
      { role: 'user', content: 'four\r\nlines' },
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'two\n\nthree' },
      { role: 'user', text: 'four\nlines' },
    ]);
    expect(system).toContain('SYSTEM PROMPT');
    expect(system).toContain('DEV');
    // a conversation that ends with an answer gets an empty user turn: "next round without comment"
    expect(
      canonicalize([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]).turns.at(-1),
    ).toEqual({
      role: 'user',
      text: '',
    });
    expect(canonicalize('nonsense').turns).toEqual([{ role: 'user', text: '' }]);
  });

  it('compares an answer without our closing link line, in either form', () => {
    const answer = 'The answer.\n\nQuestions for you:\n- one?';
    const named: ApiRef = { sessionId: UUID, chairId: 'c_0a1b' };
    const open = (label: string) =>
      roundLink('http://127.0.0.1:47321/open/abc_DEF-1', named, label);
    expect(canonicalAssistant(`${answer}\n\n${open('Open in Divan')}`)).toBe(answer);
    expect(canonicalAssistant(`${answer}\n\n${open('باز کردن در دیوان')}`)).toBe(answer);
    expect(canonicalAssistant(`${answer}\r\n\r\n${open('Open in Divan')}  \r\n`)).toBe(answer);
    // a link of ours whose round a client has changed a little is still taken off
    expect(canonicalAssistant(`${answer}\n\n[Open in Divan](http://x/open/t?round=s1.c1)`)).toBe(
      answer,
    );
    // the line of the older versions: the address alone, or with the round
    expect(
      canonicalAssistant(`${answer}\n\nDio Divan: http://127.0.0.1:47321/open/abc_DEF-1`),
    ).toBe(answer);
    expect(
      canonicalAssistant(`${answer}\r\n\r\nDio Divan: http://x/open/zzz ref:${UUID}.c_0a1b  \r\n`),
    ).toBe(answer);
    expect(canonicalAssistant(answer)).toBe(answer);
    // a link that is not ours, at the end of an answer, stays
    const other = 'See [the docs](https://example.com/page?id=2) for the rest.';
    expect(canonicalAssistant(`${answer}\n\n${other}`)).toBe(`${answer}\n\n${other}`);
  });

  it('names a round in the address of the link and finds the last one, in either form', () => {
    const a: ApiRef = { sessionId: UUID, chairId: 'c_0a1b' };
    const b: ApiRef = { sessionId: UUID.replaceAll('1', '2'), chairId: 'c_ff' };
    const line = roundLink('http://127.0.0.1:47321/open/TICKET', a, 'Open in Divan');
    expect(line).toBe(`[Open in Divan](http://127.0.0.1:47321/open/TICKET?round=${UUID}.c_0a1b)`);
    expect(lastRound(line)).toEqual(a);
    const two = `one ${line}\n\ntwo ${roundLink('http://x/open/T2', b, 'x')}\n\nmore`;
    expect(lastRound(two)).toEqual(b);
    // an address that already has a query names it after an ampersand
    expect(lastRound(`http://x/open/T?a=1&round=${UUID}.c_9`)).toEqual({
      sessionId: UUID,
      chairId: 'c_9',
    });
    // the older line, alone or before the new one
    expect(lastRound(`Dio Divan: http://x/open/T ref:${UUID}.c_0a1b`)).toEqual(a);
    expect(lastRound(`Dio Divan: http://x/open/T ref:${UUID}.c_0a1b\n\n${line}`)).toEqual(a);
    expect(lastRound('nothing here, ref:short.c_1 and ?round=x')).toBeUndefined();
    // and it is cut off again, with the blank lines before it
    expect(withoutRoundLink(`text\n\n${line}\n`)).toBe('text');
    expect(withoutRoundLink('text')).toBe('text');
    // a text built to be slow is not
    const started = performance.now();
    withoutRoundLink('[a](x'.repeat(100_000));
    withoutRoundLink('Dio Divan: x'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('cuts only the closing line of ours: another link that has a round in it stays', () => {
    // a fixtures page is not our link, at the end of a sentence or alone
    const fixtures =
      'Answer text.\n\nSee [Round 2 fixtures](https://league.example/fixtures?round=2)';
    expect(canonicalAssistant(fixtures)).toBe(fixtures);
    expect(withoutRoundLink('[Round 2](https://x?round=2)')).toBe('[Round 2](https://x?round=2)');
    // our path with another query before the round is not the line we write either
    const other = 'Text.\n\n[Open](http://x/open/t?a=1&round=2)';
    expect(withoutRoundLink(other)).toBe(other);
    // a link of ours that is not on a line of its own is not the closing line
    const named: ApiRef = { sessionId: UUID, chairId: 'c_0a1b' };
    const line = roundLink('http://x/open/T', named, 'Open in Divan');
    expect(withoutRoundLink(`The council said X; see ${line}`)).toBe(
      `The council said X; see ${line}`,
    );
    // and our own closing line is still cut, in both forms
    expect(withoutRoundLink(`Answer.\n\n${line}`)).toBe('Answer.');
    expect(withoutRoundLink(`Answer.\n\nDio Divan: http://x/open/T ref:${UUID}.c_0a1b`)).toBe(
      'Answer.',
    );
    expect(withoutRoundLink(line)).toBe('');
    // a text built to be slow, line after line, is not
    const started = performance.now();
    withoutRoundLink(`[a](${'/open/'.repeat(60)}\n`.repeat(2_000));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('reads the round of the closing line only, never one named elsewhere in a text', () => {
    const named: ApiRef = { sessionId: UUID, chairId: 'c_0a1b' };
    const line = roundLink('http://x/open/T', named, 'Open in Divan');
    expect(closingRound(`Answer.\n\n${line}\n`)).toEqual(named);
    expect(closingRound(`Answer.\r\n\r\nDio Divan: http://x/open/T ref:${UUID}.c_0a1b  `)).toEqual(
      named,
    );
    // quoted before more text, or beside other words on the last line: not the closing line
    expect(closingRound(`See ${line} for the round. My own view: do Y first.`)).toBeUndefined();
    expect(closingRound(`Answer.\n\nSee ${line}`)).toBeUndefined();
    expect(closingRound('Answer.\n\nDio Divan: http://x/open/T')).toBeUndefined();
    // `lastRound` still finds a round wherever it stands (a handoff quotes our answers inside its own text)
    expect(lastRound(`See ${line} for the round.`)).toEqual(named);
  });
});

describe('what a conversation maps to', () => {
  const link = (text: string, n: number, to: ApiRef = ref) =>
    `${text}\n\n${roundLink(`http://127.0.0.1:1/open/t${n}`, to, 'Open in Divan')}`;
  const q1 = canonicalize([{ role: 'user', content: 'Q1' }]).turns;
  // the identity of what answered: profile, generation, revision and the resolved settings
  const idOf = (revision = 3, resolved = 'h1', profile = 'default', generation = 1) =>
    `${profile}.${generation}.${revision}.${resolved}`;

  it('the same conversation, profile and folder is the cached round; any difference is not', () => {
    const stored = remember(empty, q1, 'A1', idOf(), '/p', ref);
    expect(plan(q1, stored, alive, idOf(), '/p')).toEqual({ kind: 'cached', ref });
    for (const different of [
      plan(q1, stored, alive, idOf(4), '/p'), // the profile was edited
      plan(q1, stored, alive, idOf(3, 'h2'), '/p'), // what it resolves to changed (a model went out, a seat is slower)
      plan(q1, stored, alive, idOf(3, 'h1', 'default', 2), '/p'), // deleted and made again: a new generation
      plan(q1, stored, alive, idOf(3, 'h1', 'quick'), '/p'),
      plan(q1, stored, alive, idOf(), null), // another folder
      plan(
        canonicalize([{ role: 'user', content: 'Q1 changed' }]).turns,
        stored,
        alive,
        idOf(),
        '/p',
      ),
    ]) {
      expect(different.kind).toBe('new');
    }
    // a round whose session was deleted is not served
    expect(plan(q1, stored, () => false, idOf(), '/p').kind).toBe('new');
  });

  it('a conversation continued after an answer is a branch from that answer, whatever the closing line says', () => {
    const stored = remember(empty, q1, 'A1', idOf(), null, ref);
    const continued = canonicalize([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: link('A1', 7) }, // another ticket than when it was stored
      { role: 'user', content: 'Q2' },
    ]).turns;
    expect(plan(continued, stored, alive, idOf(), null)).toEqual({
      kind: 'branch',
      ref,
      text: 'Q2',
    });
    // the profile may differ: the branch continues the session it belongs to
    expect(plan(continued, stored, alive, idOf(9, 'x', 'quick'), '/other').kind).toBe('branch');
    // an empty last message is a round without comment
    const quiet = canonicalize([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1' },
    ]).turns;
    expect(plan(quiet, stored, alive, idOf(), null)).toEqual({ kind: 'branch', ref, text: null });
    // a different earlier answer is not ours
    const stranger = canonicalize([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'something else' },
      { role: 'user', content: 'Q2' },
    ]).turns;
    expect(plan(stranger, stored, alive, idOf(), null).kind).toBe('new');
  });

  it('the round an answer names is the round: it wins over the text, and over a text that two rounds could have produced', () => {
    const one: ApiRef = {
      sessionId: '11111111-1111-1111-1111-111111111111',
      chairId: 'c_00000001',
    };
    const two: ApiRef = {
      sessionId: '22222222-2222-2222-2222-222222222222',
      chairId: 'c_00000002',
    };
    // two sessions answered the same question with the same words
    let index = remember(empty, q1, 'SAME WORDS', idOf(1, 'a', 'default', 1), null, one);
    index = remember(index, q1, 'SAME WORDS', idOf(1, 'a', 'quick', 2), null, two);
    const echoed = (to: ApiRef | null) =>
      canonicalize([
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: to ? link('SAME WORDS', 1, to) : 'SAME WORDS' },
        { role: 'user', content: 'Q2' },
      ]).turns;
    // with the line the client sends back, the right round continues
    expect(plan(echoed(one), index, alive, idOf(), null)).toMatchObject({
      kind: 'branch',
      ref: one,
    });
    expect(plan(echoed(two), index, alive, idOf(), null)).toMatchObject({
      kind: 'branch',
      ref: two,
    });
    // a conversation from before, whose answers end with the older line, still names its round
    const older = (to: ApiRef) =>
      canonicalize([
        { role: 'user', content: 'Q1' },
        {
          role: 'assistant',
          content: `SAME WORDS\n\nDio Divan: http://127.0.0.1:1/open/t1 ref:${to.sessionId}.${to.chairId}`,
        },
        { role: 'user', content: 'Q2' },
      ]).turns;
    expect(plan(older(two), index, alive, idOf(), null)).toMatchObject({
      kind: 'branch',
      ref: two,
    });
    expect(plan(older(one), index, alive, idOf(), null)).toMatchObject({
      kind: 'branch',
      ref: one,
    });
    // with the words alone it is ambiguous, and an ambiguous text is unknown: a new session, never a guess
    expect(plan(echoed(null), index, alive, idOf(), null).kind).toBe('new');
    // one live candidate is not ambiguous (the other round was deleted)
    expect(
      plan(echoed(null), index, (r) => r === one || r.chairId === 'c_00000001', idOf(), null),
    ).toMatchObject({
      kind: 'branch',
      ref: one,
    });
    // a round that is gone cannot be named: the words decide
    const gone = (r: ApiRef) => r.chairId !== 'c_00000002';
    expect(plan(echoed(two), index, gone, idOf(), null)).toMatchObject({
      kind: 'branch',
      ref: one,
    });
  });

  it('a round another model’s message quotes is not the round that message continues', () => {
    const named: ApiRef = { sessionId: UUID, chairId: 'c_0a1b' };
    const quoted = roundLink('http://127.0.0.1:1/open/t1', named, 'Open in Divan');
    const other = `The council said X; see ${quoted} for the round. My own view: do Y first.`;
    const turns = canonicalize([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: link('A1', 1, named) },
      { role: 'user', content: 'Q2' },
      { role: 'assistant', content: other },
      { role: 'user', content: 'Q3, given your view' },
    ]).turns;
    // our own answer names its round by its closing line; the other model's quotes it mid-text and names nothing
    expect(turns[1]?.ref).toEqual(named);
    expect(turns[3]?.ref).toBeUndefined();
    expect(turns[3]?.text).toBe(other);
    expect(plan(turns, empty, alive, idOf(), null)).toEqual({
      kind: 'new',
      question: 'Q3, given your view',
      background: `user: Q1\n\nassistant: A1\n\nuser: Q2\n\nassistant: ${other}`,
    });
  });

  it('no match: a new session with the last user message as its question and the earlier turns as background', () => {
    const turns = canonicalize([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'the real question' },
    ]).turns;
    const decision = plan(turns, empty, alive, idOf(), null);
    expect(decision).toEqual({
      kind: 'new',
      question: 'the real question',
      background: 'user: first\n\nassistant: reply',
    });
    expect(plan(q1, empty, alive, idOf(), null)).toEqual({
      kind: 'new',
      question: 'Q1',
      background: null,
    });
  });

  it('keeps the index bounded, dropping the oldest keys', () => {
    let index = empty;
    for (let i = 0; i < 30; i += 1) {
      index = remember(
        index,
        canonicalize([{ role: 'user', content: `q${i}` }]).turns,
        'a',
        idOf(),
        null,
        ref,
        10,
      );
    }
    expect(Object.keys(index.exact)).toHaveLength(10);
    expect(Object.keys(index.prefixes)).toHaveLength(10);
  });

  it('the background is bounded to about 30k tokens by default: the newest turns, the oldest dropped first', () => {
    expect(BACKGROUND_TOKENS).toBe(30_000);
    // 120 turns of about 1000 tokens: 120k tokens in all
    const turns = Array.from({ length: 120 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${String(i).padStart(3, '0')}: ${'word '.repeat(800)}`,
    }));
    const text = backgroundOf(turns) as string;
    expect(estimateTokens(text)).toBeLessThanOrEqual(BACKGROUND_TOKENS);
    expect(estimateTokens(text)).toBeGreaterThan(BACKGROUND_TOKENS * 0.9);
    // the newest turns are all there, in order; the oldest are gone
    expect(text).toContain('turn 119:');
    expect(text).toContain('turn 100:');
    expect(text).not.toContain('turn 000:');
    expect(text).not.toContain('turn 050:');
    const shown = [...text.matchAll(/turn (\d{3}):/gu)].map((found) => Number(found[1]));
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(shown.at(-1)).toBe(119);
    // a conversation that fits is kept whole
    expect(backgroundOf(turns.slice(0, 20))).toContain('turn 000:');
    // the old 3k cap is not what applies any more
    expect(estimateTokens(text)).toBeGreaterThan(3000);
  });

  it('the background is bounded to the cap it is given: the newest turns, a cut turn at its start', () => {
    const turns = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: `turn ${i}: ${'word '.repeat(150)}`,
    }));
    const text = backgroundOf(turns, 3000) as string;
    expect(estimateTokens(text)).toBeLessThanOrEqual(3000);
    expect(text).toContain('turn 39:');
    expect(text).not.toContain('turn 0:');
    const huge = backgroundOf(
      [{ role: 'user', text: `START ${'x '.repeat(40_000)} END` }],
      3000,
    ) as string;
    expect(estimateTokens(huge)).toBeLessThanOrEqual(3000);
    expect(huge).toContain('END');
    expect(huge).not.toContain('START');
    expect(backgroundOf([])).toBeNull();
  });
});

describe('the working folder', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses Unix roots and system folders through their real paths',
    () => {
      for (const folder of [
        '/',
        '/etc',
        '/usr',
        '/bin',
        '/sbin',
        '/proc',
        '/dev',
        '/sys',
        '/boot',
        '/System',
      ].filter(existsSync))
        expect(validateCwd(folder).ok, folder).toBe(false);
    },
  );
  let base: string;
  let project: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'divan-cwd-'));
    project = join(base, 'project');
    mkdirSync(project);
    writeFileSync(join(base, 'a-file.txt'), 'x');
    process.env.DIVAN_HOME = join(base, 'home');
    mkdirSync(join(base, 'home', 'sessions'), { recursive: true });
  });
  afterEach(() => {
    delete process.env.DIVAN_HOME;
    rmSync(base, { recursive: true, force: true });
  });

  it('accepts an absolute, existing folder as its real path, and refuses what is not a usable project folder, with the reason', () => {
    const verdict = validateCwd(project);
    expect(verdict.ok).toBe(true);
    expect(validateCwd(`"${project}"`).ok).toBe(true);
    expect(validateCwd(project.split('\\').join('/')).ok).toBe(true);
    const windows = process.platform === 'win32';
    const system = windows ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc';
    const files = windows ? (process.env.ProgramFiles ?? 'C:\\Program Files') : '/usr';
    const systemReason = windows ? /Windows or Program Files/u : /system folder/u;
    const refused: [unknown, RegExp][] = [
      ['', /empty/u],
      [42, /empty/u],
      ['relative/path', /absolute/u],
      [join(base, 'missing'), /not exist/u],
      [join(base, 'a-file.txt'), /not a folder/u],
      [parse(project).root, /drive root/u],
      [system, systemReason],
      [windows ? join(system, 'System32') : '/bin', systemReason],
      [files, systemReason],
      ['\\\\server\\share\\x', /absolute local/u],
      [join(base, 'home'), /keeps from the council/u],
      [join(base, 'home', 'sessions'), /keeps from the council/u],
    ];
    for (const [value, reason] of refused) {
      const verdict = validateCwd(value);
      expect(verdict.ok, String(value)).toBe(false);
      if (!verdict.ok) expect(verdict.reason, String(value)).toMatch(reason);
    }
  });

  it('a junction or symlink is judged by where it leads, never by its own name', () => {
    const system =
      process.platform === 'win32' ? (process.env.SystemRoot ?? 'C:\\Windows') : '/etc';
    const alias = (target: string, name: string) => {
      const link = join(base, name);
      symlinkSync(target, link, 'junction');
      return link;
    };
    const homeAlias = alias(join(base, 'home'), 'alias-home');
    const toHome = validateCwd(homeAlias);
    expect(toHome.ok).toBe(false);
    if (!toHome.ok) expect(toHome.reason).toMatch(/keeps from the council/u);
    expect(canonical(join(homeAlias, 'missing.json'))).toBe(
      canonical(join(base, 'home', 'missing.json')),
    );
    const toSessions = validateCwd(alias(join(base, 'home', 'sessions'), 'alias-sessions'));
    expect(toSessions.ok).toBe(false);
    const toSystem = validateCwd(alias(system, 'alias-system'));
    expect(toSystem.ok).toBe(false);
    if (!toSystem.ok) expect(toSystem.reason).toMatch(/Windows or Program Files|system folder/u);
    // an alias of a real project is fine, and is used by its real name
    const toProject = validateCwd(alias(project, 'alias-project'));
    expect(toProject.ok).toBe(true);
    if (toProject.ok) expect(toProject.path.toLowerCase()).toBe(canonical(project).toLowerCase());
  });

  it('a folder on another machine is refused, however it is written', () => {
    for (const remote of ['\\\\server\\share', '\\\\?\\UNC\\server\\share\\x']) {
      expect(isRemote(remote), remote).toBe(true);
    }
    expect(isRemote('\\\\?\\C:\\work')).toBe(false);
    expect(isRemote('C:\\work')).toBe(false);
    expect(validateCwd('\\\\server\\share\\x').ok).toBe(false);
  });

  it('finds the folder in the common system prompts, and the header wins', () => {
    expect(cwdFromSystemPrompt('<cwd>\nC:/w/my project\n</cwd>')).toBe('C:/w/my project');
    expect(
      cwdFromSystemPrompt('<environment_context>\n  <cwd>C:\\w\\p</cwd>\n</environment_context>'),
    ).toBe('C:\\w\\p');
    expect(
      cwdFromSystemPrompt(
        '# env\n - Primary working directory: E:\\w\\dio-divan\n - Is a git repo',
      ),
    ).toBe('E:\\w\\dio-divan');
    expect(cwdFromSystemPrompt('Current working directory: /home/u/p')).toBe('/home/u/p');
    expect(cwdFromSystemPrompt('nothing here')).toBeNull();
    expect(folderFor(encodeURIComponent(project), 'Current working directory: /elsewhere')).toEqual(
      {
        path: validateCwd(project).ok ? (validateCwd(project) as { path: string }).path : '',
        note: null,
      },
    );
    expect(folderFor(undefined, `<cwd>\n${project}\n</cwd>`).path).toBeTruthy();
    expect(folderFor(undefined, 'no folder').path).toBeNull();
    expect(folderFor(encodeURIComponent(parse(project).root), '').note).toMatch(
      /not used \(a drive root\)/u,
    );
  });
});
