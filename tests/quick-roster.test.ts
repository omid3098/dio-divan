import { expect, it, vi } from 'vitest';
import type { SettingsFull } from '../src/shared/types.ts';
import {
  needsRosterBaseline,
  readSeen,
  rosterChange,
  rosterOf,
  writeSeen,
} from '../web/src/pages/quick-roster.ts';

it('counts models from one harness separately and reports model changes without harness speed claims', () => {
  const effective: SettingsFull = {
    seats: ['opus', 'sonnet'].map((model) => ({
      id: model,
      harness: 'claude',
      model,
      enabled: true,
      effort: '',
      tools: false,
      memory: false,
      web: false,
    })),
    chairman: { harness: 'codex', model: 'gpt', effort: '' },
    budgets: { maxClaims: 8, maxWords: 50 },
  };
  const before = rosterOf({ effective }, { claude: 10 });
  expect(before.members).toEqual(['claude|opus', 'claude|sonnet']);
  effective.seats = effective.seats.map((seat) =>
    seat.model === 'sonnet' ? { ...seat, model: 'haiku' } : seat,
  );
  const after = rosterOf({ effective }, { claude: 90 });
  expect(rosterChange(before, after)).toEqual({
    added: ['claude|haiku'],
    removed: ['claude|sonnet'],
  });
  expect(rosterChange(after, rosterOf({ effective }, {}))).toBeNull();
});

it('upgrades the old harness-only roster and reports only provable changes', () => {
  const storage = new Map<string, string>([
    ['divan-quick-roster', JSON.stringify({ members: ['claude', 'codex', 'grok'], speeds: {} })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  try {
    const seen = readSeen();
    if (!seen) throw new Error('Missing migrated roster');
    expect(seen.members).toEqual(['claude', 'codex', 'grok']);
    expect(storage.has('divan-quick-roster-models')).toBe(true);
    const now = { members: ['claude|opus', 'codex|gpt', 'pi|glm'], speeds: {} };
    expect(rosterChange(seen, now)).toEqual({ added: ['pi|glm'], removed: ['grok'] });
    expect(
      rosterChange(seen, { ...now, members: ['claude|opus', 'codex|gpt', 'grok|grok-new'] }),
    ).toBeNull();
    writeSeen(now);
    expect(readSeen()).toEqual(now);
    expect(
      rosterChange(now, { ...now, members: ['claude|sonnet', 'codex|gpt', 'pi|glm'] }),
    ).toEqual({ added: ['claude|sonnet'], removed: ['claude|opus'] });
  } finally {
    vi.unstubAllGlobals();
  }
});

it('learns models on an unchanged legacy upgrade, then reports a model change', () => {
  const storage = new Map<string, string>([
    ['divan-quick-roster', JSON.stringify({ members: ['claude', 'codex', 'grok'], speeds: {} })],
  ]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  try {
    let seen = readSeen();
    const now = { members: ['claude|opus', 'codex|gpt', 'grok|grok'], speeds: {} };
    if (!seen) throw new Error('Missing migrated roster');
    expect(rosterChange(seen, now)).toBeNull();
    expect(needsRosterBaseline(seen, now)).toBe(true);
    // The component's baseline effect persists and updates its state together.
    writeSeen(now);
    seen = now;
    expect(readSeen()).toEqual(seen);
    expect(needsRosterBaseline(seen, now)).toBe(false);
    expect(
      rosterChange(seen, { ...now, members: ['claude|sonnet', 'codex|gpt', 'grok|grok'] }),
    ).toEqual({ added: ['claude|sonnet'], removed: ['claude|opus'] });
    expect(needsRosterBaseline({ members: ['claude', 'codex', 'pi'], speeds: {} }, now)).toBe(
      false,
    );
  } finally {
    vi.unstubAllGlobals();
  }
});
