// What the new-session card says changed between the council it showed and the one the server has now.

import { describe, expect, it } from 'vitest';
import type { LevelView, SeatConfig, SettingsFull } from '../src/shared/types.ts';
import { councilChanges, councilNews } from '../web/src/pages/council-change.ts';

const seat = (
  id: string,
  harness: SeatConfig['harness'],
  model: string,
  effort = 'high',
): SeatConfig => ({
  id,
  enabled: true,
  harness,
  model,
  effort,
  tools: false,
  memory: false,
  web: false,
});
const council = (seats: SeatConfig[]): SettingsFull => ({
  seats,
  chairman: { harness: 'pi', model: 'p1', effort: 'high' },
  budgets: { maxClaims: 5, maxWords: 30 },
});
const before = council([
  seat('claude', 'claude', 'm1'),
  seat('codex', 'codex', 'c1'),
  seat('grok', 'grok', 'g1'),
]);

describe('what changed in a council', () => {
  it('says nothing about a council that is the same (a revision or a timing that moved is not a change)', () => {
    expect(councilChanges(before, structuredClone(before))).toEqual([]);
  });

  it('a member that is now off (no credit), gone, or new', () => {
    const after = council([
      seat('claude', 'claude', 'm1'),
      { ...seat('codex', 'codex', 'c1'), enabled: false },
      seat('pi', 'pi', 'p9'),
    ]);
    expect(councilChanges(before, after)).toEqual([
      { kind: 'seatOff', id: 'codex', harness: 'codex' },
      { kind: 'seatAdded', id: 'pi', harness: 'pi' },
      { kind: 'seatRemoved', id: 'grok', harness: 'grok' },
    ]);
    // and the other way round
    expect(councilChanges(after, before)).toContainEqual({
      kind: 'seatOn',
      id: 'codex',
      harness: 'codex',
    });
  });

  it('a model or an effort that is not the same any more, with both values', () => {
    const after = council([
      seat('claude', 'claude', 'm2', 'medium'),
      seat('codex', 'codex', 'c1'),
      seat('grok', 'grok', 'g1'),
    ]);
    expect(councilChanges(before, after)).toEqual([
      { kind: 'seatModel', id: 'claude', harness: 'claude', from: 'm1', to: 'm2' },
      { kind: 'seatEffort', id: 'claude', harness: 'claude', from: 'high', to: 'medium' },
    ]);
  });

  it('an assistant that is another, the chairman, and the limits', () => {
    const after: SettingsFull = {
      ...before,
      seats: [seat('claude', 'pi', 'm1'), ...before.seats.slice(1)],
      chairman: { harness: 'claude', model: 'm3', effort: 'low' },
      budgets: { ...before.budgets, maxWords: 31 },
    };
    expect(councilChanges(before, after)).toEqual([
      { kind: 'seatHarness', id: 'claude', harness: 'pi', from: 'claude', to: 'pi' },
      { kind: 'chairmanHarness', from: 'pi', to: 'claude' },
      { kind: 'chairmanModel', from: 'p1', to: 'm3' },
      { kind: 'chairmanEffort', from: 'high', to: 'low' },
      { kind: 'limits' },
    ]);
  });

  it('what a member that is off would run on is not news', () => {
    const off = (model: string) =>
      council([
        { ...seat('claude', 'claude', model), enabled: false },
        seat('codex', 'codex', 'c1'),
      ]);
    expect(councilChanges(off('m1'), off('m2'))).toEqual([]);
  });
});

describe('a member that has just gone off or on', () => {
  it('is said once: what it runs on is not news when it is off, or was off', () => {
    const on = council([seat('claude', 'claude', 'm1', 'high'), seat('codex', 'codex', 'c1')]);
    const off = council([
      seat('claude', 'claude', 'm1', 'high'),
      { ...seat('codex', 'codex', ''), enabled: false, effort: '' },
    ]);
    expect(councilChanges(on, off)).toEqual([{ kind: 'seatOff', id: 'codex', harness: 'codex' }]);
    expect(councilChanges(off, on)).toEqual([{ kind: 'seatOn', id: 'codex', harness: 'codex' }]);
  });
});

describe('everything the fingerprint covers has a line', () => {
  const view = (
    effective: SettingsFull,
    fingerprint: string,
    skipped: LevelView['skipped'] = [],
  ): LevelView => ({
    effective,
    derived: effective,
    overrides: {},
    fingerprint,
    skipped,
    notes: [],
  });

  it('tools, memory and web of a member, each with its new state', () => {
    const after = council([
      { ...seat('claude', 'claude', 'm1'), tools: true, web: true },
      seat('codex', 'codex', 'c1'),
      seat('grok', 'grok', 'g1'),
    ]);
    expect(councilChanges(before, after)).toEqual([
      { kind: 'seatToggle', id: 'claude', harness: 'claude', toggle: 'tools', on: true },
      { kind: 'seatToggle', id: 'claude', harness: 'claude', toggle: 'web', on: true },
    ]);
    expect(councilChanges(after, before)).toEqual([
      { kind: 'seatToggle', id: 'claude', harness: 'claude', toggle: 'tools', on: false },
      { kind: 'seatToggle', id: 'claude', harness: 'claude', toggle: 'web', on: false },
    ]);
    const memory = council([
      { ...seat('claude', 'claude', 'm1'), memory: true },
      seat('codex', 'codex', 'c1'),
      seat('grok', 'grok', 'g1'),
    ]);
    expect(councilChanges(before, memory)).toEqual([
      { kind: 'seatToggle', id: 'claude', harness: 'claude', toggle: 'memory', on: true },
    ]);
  });

  it('the chairman’s memory', () => {
    const after: SettingsFull = { ...before, chairman: { ...before.chairman, memory: true } };
    expect(councilChanges(before, after)).toEqual([{ kind: 'chairmanMemory', on: true }]);
    expect(councilChanges(after, before)).toEqual([{ kind: 'chairmanMemory', on: false }]);
    // absent and false are the same
    expect(
      councilChanges(before, { ...before, chairman: { ...before.chairman, memory: false } }),
    ).toEqual([]);
  });

  it('the chairman’s tools, with absent meaning on', () => {
    const after = { ...before, chairman: { ...before.chairman, tools: false } };
    expect(councilChanges(before, after)).toEqual([{ kind: 'chairmanTools', on: false }]);
    expect(councilChanges(after, before)).toEqual([{ kind: 'chairmanTools', on: true }]);
    expect(
      councilChanges(before, { ...before, chairman: { ...before.chairman, tools: true } }),
    ).toEqual([]);
  });

  it('a member that is on and will not be asked now, and one that will be asked again', () => {
    const out: LevelView['skipped'] = [{ id: 'codex', reason: 'out' }];
    expect(councilChanges(before, before, { before: [], after: out })).toEqual([
      { kind: 'seatSkipped', id: 'codex', harness: 'codex', reason: 'out' },
    ]);
    expect(councilChanges(before, before, { before: out, after: [] })).toEqual([
      { kind: 'seatBack', id: 'codex', harness: 'codex' },
    ]);
    expect(
      councilChanges(before, before, {
        before: out,
        after: [{ id: 'codex', reason: 'family' }],
      }),
    ).toEqual([{ kind: 'seatSkipped', id: 'codex', harness: 'codex', reason: 'family' }]);
    // a member switched off is said by that line alone
    const off = council([
      seat('claude', 'claude', 'm1'),
      { ...seat('codex', 'codex', 'c1'), enabled: false },
      seat('grok', 'grok', 'g1'),
    ]);
    expect(councilChanges(before, off, { before: [], after: [] })).toEqual([
      { kind: 'seatOff', id: 'codex', harness: 'codex' },
    ]);
    expect(councilChanges(before, off, { before: out, after: [] })).toEqual([
      { kind: 'seatOff', id: 'codex', harness: 'codex' },
    ]);
  });

  it('REPRODUCTION: a pinned member lost its model; the settings are the same, the council that runs is not', () => {
    const shown = view(before, 'fp-a');
    const fresh = view(before, 'fp-b', [{ id: 'codex', reason: 'out' }]);
    expect(councilNews(shown, fresh)).toEqual([
      { kind: 'seatSkipped', id: 'codex', harness: 'codex', reason: 'out' },
    ]);
  });

  it('REPRODUCTION: only a toggle changed; the start does not take the new council without saying so', () => {
    const tools = council([
      seat('claude', 'claude', 'm1'),
      seat('codex', 'codex', 'c1'),
      { ...seat('grok', 'grok', 'g1'), tools: true },
    ]);
    expect(councilNews(view(before, 'fp-a'), view(tools, 'fp-b'))).toEqual([
      { kind: 'seatToggle', id: 'grok', harness: 'grok', toggle: 'tools', on: true },
    ]);
  });

  it('is nothing for the same council, whatever moved behind it, and never nothing for a different one', () => {
    // the same fingerprint: the same council (a revision or a timing moved)
    expect(councilNews(view(before, 'same'), view(structuredClone(before), 'same'))).toEqual([]);
    // a different fingerprint with nothing this page can name: still a line, never a silent start
    expect(councilNews(view(before, 'fp-a'), view(structuredClone(before), 'fp-b'))).toEqual([
      { kind: 'other' },
    ]);
  });
});
