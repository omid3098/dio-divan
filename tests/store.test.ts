import { agentsOf, chairmanOf, type FlowStep, seatsOf } from '../src/shared/flow.ts';
import { requireValue } from './fixtures.ts';
// Atomic storage and crash recovery: a session is never half written, and a round that was running when the process
// died comes back as interrupted.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOwnerOnly } from '../src/server/secure.ts';
import { sanitizeOverrides } from '../src/server/settings.ts';
import { Store, serializeSession, summarize } from '../src/server/store.ts';
import { speedKey } from '../src/shared/defaults.ts';
import type { ChairNode, SeatRun, Session } from '../src/shared/types.ts';
import { writerFlow } from './fixtures/flows.ts';
import { chairNode, sessionOf, userNode } from './fixtures.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-test-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function seatOf(seatId: string, label: string, state: SeatRun['state']): SeatRun {
  const [template] = seatsOf(chairNode('x', 'u0', 1));
  if (!template) throw new Error('fixture has no seat');
  return { ...template, seatId, label, state };
}

function runningSession(): Session {
  const chair = chairNode('c1', 'u0', 1, {
    status: 'running',
    seats: [seatOf('S1', 'A', 'done'), seatOf('S2', 'B', 'running'), seatOf('S3', 'C', 'pending')],
  });
  chairmanOf(chair).state = 'pending';
  return sessionOf([userNode('u0', null, 'Q'), chair], 'run-1');
}

describe('storage', () => {
  it('backs up damaged settings owner-only before a settings write can replace them', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1791972000000);
    const older = join(home, 'settings.corrupt-1791972000000.json');
    writeFileSync(older, 'older damaged settings');
    const broken = '{ models: not valid JSON';
    writeFileSync(join(home, 'settings.json'), broken);
    const store = new Store(home);
    try {
      expect(store.readSettings().profiles).toEqual({});
    } finally {
      clock.mockRestore();
    }
    expect(store.settingsBackup).toBe('settings.corrupt-1791972000000-1.json');
    expect(readFileSync(older, 'utf8')).toBe('older damaged settings');
    const backup = join(home, store.settingsBackup as string);
    expect(readFileSync(backup, 'utf8')).toBe(broken);
    expect(isOwnerOnly(backup)).toBe(true);
    await store.updateSettings((settings) => ({ ...settings, port: 12345 }));
    expect(store.readSettings().port).toBe(12345);
    expect(readFileSync(backup, 'utf8')).toBe(broken);
  });
  it('reads a version-1 round through selectors without migrating or rewriting its file on load', async () => {
    const old = sessionOf([userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1)], 'legacy-read');
    old.schemaVersion = 1;
    const chair = old.nodes.c1 as ChairNode;
    chair.status = 'done';
    const text = JSON.stringify(old);
    mkdirSync(join(home, 'sessions'), { recursive: true });
    const file = join(home, 'sessions', `${old.id}.json`);
    writeFileSync(file, text);
    const store = new Store(home);
    await store.init();
    const loaded = requireValue(store.get(old.id));
    expect(loaded.settings.flow).toBeUndefined();
    expect(loaded.schemaVersion).toBe(1);
    expect(seatsOf(loaded.nodes.c1 as ChairNode)).toEqual(seatsOf(chair));
    expect(chairmanOf(loaded.nodes.c1 as ChairNode)).toEqual(chairmanOf(chair));
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
  it('every flow save releases only sanitised authorised text, including prompts, diagnostics and activity', () => {
    const flow = writerFlow();
    const chair = chairNode('c1', 'u0', 1, { status: 'running' });
    const template = seatsOf(chair)[0] as SeatRun;
    chair.steps = agentsOf(flow).map((agent): FlowStep => {
      const base = { id: agent.id, aliases: {}, inputs: [], attempts: [] };
      if (agent.form === 'answer')
        return {
          ...base,
          form: 'answer',
          output: null,
          run: { ...chairmanOf(chair), state: 'pending', input: 'PROMPT-SECRET' },
        };
      const run = {
        ...template,
        seatId: agent.id,
        state: 'pending' as const,
        prompt: 'PROMPT-SECRET',
        rawOutput: 'RAW-SECRET',
        error: 'DIAGNOSTIC-SECRET',
        activity: { file: 1, memory: 0, web: 0, thread: 0, other: 0 },
        toolLog: [{ at: 'now', kind: 'file' as const, name: 'Read', target: 'TARGET-SECRET' }],
        parsed: null,
        sanitized: null,
      };
      return agent.form === 'report'
        ? {
            ...base,
            form: 'report',
            run: {
              ...run,
              state: 'done',
              parsed: { report: 'UNSTRIPPED-SECRET' },
              sanitized: { report: 'SAFE-DRAFT' },
            },
          }
        : { ...base, form: 'member', run };
    });
    const session = sessionOf([userNode('u0', null, 'Q'), chair]);
    session.schemaVersion = 2;
    session.settings.flow = flow;
    for (const over of [
      {},
      { name: 'rename' },
      { layout: { direction: 'LR' as const } },
      { nodes: [{ ...chair, position: { x: 1, y: 2 } }] },
    ]) {
      const text = serializeSession(session, over);
      expect(text).toContain('SAFE-DRAFT');
      for (const hidden of [
        'RAW-SECRET',
        'UNSTRIPPED-SECRET',
        'PROMPT-SECRET',
        'DIAGNOSTIC-SECRET',
        'TARGET-SECRET',
        'toolLog',
      ])
        expect(text).not.toContain(hidden);
      expect(JSON.parse(text).nodes.c1).not.toHaveProperty('seats');
      expect(JSON.parse(text).nodes.c1).not.toHaveProperty('chairman');
      const steps = (JSON.parse(text).nodes.c1 as ChairNode).steps ?? [];
      expect(steps[0]?.run.activity).toEqual({ file: 1, memory: 0, web: 0, thread: 0, other: 0 });
      expect(steps.slice(1).every((step) => step.run.activity === undefined)).toBe(true);
    }
    expect(chair.steps[0]?.run.rawOutput).toBe('RAW-SECRET');
  });
  it('writes one JSON file per session, atomically, and reads it back identical', async () => {
    const store = new Store(home);
    await store.init();
    const session = sessionOf([userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1)], 'abc');
    await store.save(session);
    const names = readdirSync(join(home, 'sessions'));
    expect(names).toEqual(['abc.json']); // no temp file left behind
    const again = new Store(home);
    await again.init();
    expect(again.get('abc')).toEqual(
      JSON.parse(readFileSync(join(home, 'sessions', 'abc.json'), 'utf8')),
    );
    expect(again.get('abc')?.nodes.c1).toBeDefined();
  });

  it('keeps writes of one session in order: the last save wins', async () => {
    const store = new Store(home);
    await store.init();
    const session = sessionOf([userNode('u0', null, 'Q')], 'order');
    session.name = 'one';
    void store.save(session);
    session.name = 'two';
    void store.save(session);
    session.name = 'three';
    await store.save(session);
    await store.flush();
    const onDisk = JSON.parse(
      readFileSync(join(home, 'sessions', 'order.json'), 'utf8'),
    ) as Session;
    expect(onDisk.name).toBe('three');
  });

  it('a crash in the middle of a write loses nothing: the old file stays whole and the temp file is swept', async () => {
    const store = new Store(home);
    await store.init();
    const session = sessionOf([userNode('u0', null, 'Q'), chairNode('c1', 'u0', 1)], 'crash');
    await store.save(session);
    // the process died after writing half of a new version to its temp file, before the rename
    writeFileSync(
      join(home, 'sessions', 'crash.json.123.deadbeef.tmp'),
      '{"schemaVersion":1,"id":"crash","nodes":{',
    );
    const restarted = new Store(home);
    const report = await restarted.init();
    expect(report.unreadable).toEqual([]);
    expect(restarted.get('crash')?.nodes.c1).toBeDefined();
    expect(readdirSync(join(home, 'sessions'))).toEqual(['crash.json']);
  });

  it('marks a leftover running round as interrupted, with its unfinished seats and chairman failed', async () => {
    const store = new Store(home);
    await store.init();
    await store.save(runningSession());
    // restart: a new store reads the file the way a new process would
    const restarted = new Store(home);
    const report = await restarted.init();
    expect(report.recovered).toEqual(['run-1']);
    const chair = restarted.get('run-1')?.nodes.c1 as ChairNode;
    expect(chair.status).toBe('interrupted');
    // the seat that had answered held its answer in memory only: it comes back failed, with nothing to show
    expect(seatsOf(chair).map((seat) => seat.state)).toEqual(['failed', 'failed', 'failed']);
    expect(seatsOf(chair)[0]?.error).toMatch(/only in memory/u);
    expect(seatsOf(chair)[0]?.parsed).toBeNull();
    expect(seatsOf(chair)[1]?.error).toBe('interrupted');
    expect(chairmanOf(chair).state).toBe('failed');
    // and the recovery was saved, so a second restart finds nothing to recover
    const third = new Store(home);
    expect((await third.init()).recovered).toEqual([]);
    const reloaded = third.get('run-1');
    expect((reloaded?.nodes.c1 as ChairNode | undefined)?.status).toBe('interrupted');
  });

  it('a recovered round has a newer content revision than the running one a page last saw, so the page takes it over', async () => {
    const store = new Store(home);
    await store.init();
    const session = runningSession();
    // the page saw the round running at this revision (a clock reading, as the server makes them)
    const seen = Date.now() - 5000;
    (session.nodes.c1 as ChairNode).rev = seen;
    await store.save(session);
    const restarted = new Store(home);
    await restarted.init();
    const chair = restarted.get('run-1')?.nodes.c1 as ChairNode;
    expect(chair.status).toBe('interrupted');
    expect(chair.rev).toBeGreaterThan(seen);
  });

  it('keeps the answers of a running round out of every save until all its members have settled', async () => {
    const store = new Store(home);
    await store.init();
    const session = runningSession();
    const chair = session.nodes.c1 as ChairNode;
    for (const run of [...seatsOf(chair), chairmanOf(chair)]) {
      run.activity = { file: 2, memory: 0, thread: 0, web: 0, other: 0 };
      run.toolLog = [{ at: 'now', kind: 'file', name: 'read', target: 'TOOL-TARGET-SECRET' }];
    }
    chair.attempts = [
      {
        kind: 'seat',
        seatId: 'S1',
        label: 'A',
        harness: 'claude',
        model: 'm',
        state: 'done',
        error: 'raw failure text of A',
        usage: { input: 10, output: 5, cached: 0, total: 15, source: 'harness' },
        promptTokens: 10,
        councilTokens: 15,
        startedAt: null,
        endedAt: null,
      },
    ];
    const file = join(home, 'sessions', 'run-1.json');
    // any kind of save: progress, a layout change, a rename
    for (const touch of [
      () => undefined,
      () => {
        session.layout.direction = 'LR';
      },
      () => {
        session.name = 'renamed';
      },
    ]) {
      touch();
      await store.save(session);
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('MEMBER-RAW-SECRET');
      expect(text).not.toContain('MEMBER-PARSED-SECRET');
      expect(text).not.toContain('raw failure text');
      expect(text).not.toContain('TOOL-TARGET-SECRET');
      expect(text).not.toContain('"activity"');
      expect(text).not.toContain('"toolLog"');
      // the spend is still on the books
      expect(JSON.parse(text).nodes.c1.attempts[0].usage.total).toBe(15);
    }
    // the live session still has everything
    expect(seatsOf(chair)[0]?.rawOutput).toContain('MEMBER-RAW-SECRET');
    // every member has settled: now the answers are written
    for (const seat of seatsOf(chair)) seat.state = 'done';
    await store.save(session);
    expect(readFileSync(file, 'utf8')).toContain('MEMBER-RAW-SECRET');
    expect(readFileSync(file, 'utf8')).toContain('TOOL-TARGET-SECRET');
  });

  it('never deletes an unreadable session file: it is set aside for a human', async () => {
    const store = new Store(home);
    await store.init();
    writeFileSync(join(home, 'sessions', 'broken.json'), '{"schemaVersion":1,');
    const restarted = new Store(home);
    const report = await restarted.init();
    expect(report.unreadable).toEqual(['broken.json']);
    const names = readdirSync(join(home, 'sessions'));
    expect(names.some((name) => name.startsWith('broken.json.corrupt-'))).toBe(true);
    expect(restarted.list()).toEqual([]);
  });

  it('memory follows the disk: a write that fails registers no new session and raises no timestamp', async () => {
    class FailingStore extends Store {
      failing = false;
      protected override async write(file: string, text: string): Promise<void> {
        if (this.failing) throw new Error('disk full');
        return super.write(file, text);
      }
    }
    const store = new FailingStore(home);
    await store.init();
    const fresh = sessionOf([userNode('u0', null, 'Q')], 'fresh');
    store.failing = true;
    await expect(store.save(fresh)).rejects.toThrow('disk full');
    expect(store.get('fresh')).toBeUndefined();
    expect(store.list()).toEqual([]);
    store.failing = false;
    await store.save(fresh);
    const stamped = fresh.updatedAt;
    store.failing = true;
    await expect(store.save(fresh)).rejects.toThrow('disk full');
    expect(fresh.updatedAt).toBe(stamped);
    expect(store.get('fresh')).toBe(fresh);
  });

  it('a deleted session is never written again: not by a save after the delete, nor by one queued before it', async () => {
    class SlowStore extends Store {
      hold: Promise<void> | null = null;
      protected override async write(file: string, text: string): Promise<void> {
        await this.hold;
        return super.write(file, text);
      }
    }
    const store = new SlowStore(home);
    await store.init();
    const session = sessionOf([userNode('u0', null, 'Q')], 'gone');
    await store.save(session);
    let release: () => void = () => undefined;
    store.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = store.save(session); // waits in the queue when the delete begins
    queued.catch(() => undefined);
    const deleting = store.delete('gone');
    await expect(store.save(session)).rejects.toThrow('deleted');
    release();
    await deleting;
    await expect(queued).rejects.toThrow('deleted');
    await store.flush();
    expect(readdirSync(join(home, 'sessions'))).toEqual([]);
    expect(store.get('gone')).toBeUndefined();
    expect(store.isDeleted('gone')).toBe(true);
  });

  it('refuses a session id that is not a plain name', async () => {
    const store = new Store(home);
    await store.init();
    const session = sessionOf([userNode('u0', null, 'Q')], '../../evil');
    expect(() => store.save(session)).toThrow();
  });
});

describe('how long a round usually takes, per level', () => {
  const finished = (id: string, level: 'low' | 'max' | undefined, seconds: number) => {
    const start = Date.parse('2026-10-10T10:00:00Z');
    const session = sessionOf(
      [
        userNode('u0', null, 'Q'),
        chairNode('c1', 'u0', 1, {
          startedAt: new Date(start).toISOString(),
          endedAt: new Date(start + seconds * 1000).toISOString(),
        }),
      ],
      id,
    );
    if (level) session.settings.level = level;
    return session;
  };

  it('a level’s range holds only the rounds of sessions that ran at it; the overall one holds all', async () => {
    const store = new Store(home);
    await store.init();
    await store.save(finished('a', 'low', 20));
    await store.save(finished('b', 'low', 40));
    await store.save(finished('c', 'max', 300));
    await store.save(finished('d', undefined, 100));
    expect(store.typicalRoundRange('low')).toEqual({ min: 20, max: 40, count: 2 });
    expect(store.typicalRoundRange('max')).toEqual({ min: 300, max: 300, count: 1 });
    expect(store.typicalRoundRange('high')).toBeNull();
    expect(store.typicalRoundRange()).toEqual({ min: 20, max: 300, count: 4 });
    const byLevel = store.typicalRoundRangeByLevel();
    expect(Object.keys(byLevel)).toEqual(['low', 'medium', 'high', 'max']);
    expect(byLevel.low?.count).toBe(2);
    expect(byLevel.medium).toBeNull();
    expect(byLevel.max?.min).toBe(300);
  });
});

describe('a session file from before the cap was removed', () => {
  it('loads with its extra fields (the cap, the budget events, the link to the session it continued) ignored', async () => {
    const chair = chairNode('c1', 'u0', 1);
    const session = sessionOf([userNode('u0', null, 'Q'), chair], 'old');
    const text = JSON.stringify({
      ...session,
      settings: { ...session.settings, budgets: { maxClaims: 5, maxWords: 30, tokenCap: 600_000 } },
      budgetEvents: [{ at: '2026-10-10T00:00:00Z', from: 300_000, to: 600_000, beforeRound: 2 }],
      continuedFrom: { sessionId: 'earlier', nodeId: 'c9', title: 'Earlier' },
    });
    const dir = join(home, 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'old.json'), text);
    const store = new Store(home);
    await store.init();
    const loaded = store.get('old');
    expect(loaded?.nodes.c1).toBeDefined();
    expect(summarize(loaded as Session).tokens).toBe(chair.usage.total);
    // reading it changes nothing on disk
    expect(readFileSync(join(dir, 'old.json'), 'utf8')).toBe(text);
  });
});

describe('settings.json of an older shape', () => {
  const written = (text: string) => {
    writeFileSync(join(home, 'settings.json'), text);
    return new Store(home);
  };

  it('keeps a valid port when the file has no profiles (or no version)', async () => {
    const old = written(JSON.stringify({ port: 48123, overrides: { budgets: { maxWords: 40 } } }));
    await old.init();
    const file = old.readSettings();
    expect(file.port).toBe(48123);
    expect(file.version).toBe(2);
    expect(file.profiles.default?.overrides).toEqual({ budgets: { maxWords: 40 } });
    // version 2, but without profiles
    const half = written(JSON.stringify({ version: 2, port: 49000 }));
    await half.init();
    expect(half.readSettings().port).toBe(49000);
  });

  it('keeps a file of the current shape as it is, port included', async () => {
    const current = written(JSON.stringify({ version: 2, port: 47500, profiles: {} }));
    await current.init();
    expect(current.readSettings()).toEqual({ version: 2, port: 47500, profiles: {} });
  });

  it('a profile that still carries a token cap loads, and the cap is ignored', () => {
    // the cap was removed (Omid, 2026-10-11): the settings of an older version may still hold one
    expect(sanitizeOverrides({ budgets: { maxWords: 40, tokenCap: 600_000 } })).toEqual({
      budgets: { maxWords: 40 },
    });
    expect(sanitizeOverrides({ budgets: { tokenCap: 600_000 } })).toEqual({});
  });

  it('drops a port that is not one', async () => {
    for (const port of [80, 70000, 5000.5, '5000', null]) {
      const store = written(JSON.stringify({ port, overrides: {} }));
      await store.init();
      expect(store.readSettings().port, String(port)).toBeUndefined();
    }
  });
});

describe('content revisions do not depend on the clock', () => {
  it('a revision made after a restart is above every one made before it, whatever the clock says', async () => {
    const first = new Store(home);
    await first.init();
    const before = [first.nextRev(), first.nextRev(), first.nextRev()];
    expect(before[1]).toBeGreaterThan(before[0] as number);
    expect(before[2]).toBeGreaterThan(before[1] as number);
    // the clock was set back to 1970 before the next start
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const second = new Store(home);
      await second.init();
      const after = [second.nextRev(), second.nextRev()];
      expect(after[0]).toBeGreaterThan(Math.max(...before));
      expect(after[1]).toBeGreaterThan(after[0] as number);
      // and a third start, with the clock still wrong
      const third = new Store(home);
      await third.init();
      expect(third.nextRev()).toBeGreaterThan(after[1] as number);
    } finally {
      clock.mockRestore();
    }
  });

  it('a revision never goes down within a start, when the clock is moved back', async () => {
    const store = new Store(home);
    await store.init();
    const one = store.nextRev();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(5);
    try {
      expect(store.nextRev()).toBeGreaterThan(one);
    } finally {
      clock.mockRestore();
    }
  });

  it('a recovered round is above every revision a page may have seen of it, saved or not', async () => {
    const first = new Store(home);
    await first.init();
    const session = runningSession();
    const chair = session.nodes.c1 as ChairNode;
    // the round was announced many times (the page saw the last one); only an earlier revision was ever saved
    chair.rev = first.nextRev();
    await first.save(session);
    const seenByThePage = Array.from({ length: 50 }, () => first.nextRev()).at(-1) as number;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const restarted = new Store(home);
      const report = await restarted.init();
      expect(report.recovered).toEqual(['run-1']);
      const recovered = restarted.get('run-1')?.nodes.c1 as ChairNode;
      expect(recovered.status).toBe('interrupted');
      expect(recovered.rev).toBeGreaterThan(seenByThePage);
      // what was saved by the recovery is that revision, so a second restart finds the same
      const third = new Store(home);
      await third.init();
      expect((third.get('run-1')?.nodes.c1 as ChairNode | undefined)?.rev).toBe(recovered.rev);
    } finally {
      clock.mockRestore();
    }
  });
});

describe('what is measured is kept per assistant and model', () => {
  const attempt = (
    harness: 'claude' | 'pi',
    model: string,
    seconds: number,
    total = 20_000,
    kind: 'seat' | 'chairman' = 'seat',
  ) => ({
    kind,
    seatId: kind === 'seat' ? harness : null,
    label: null,
    harness,
    model,
    state: 'done',
    error: null,
    usage: { input: total - 1000, output: 1000, cached: 0, total, source: 'harness' as const },
    promptTokens: 1000,
    councilTokens: 2000,
    startedAt: '2026-10-10T00:00:00.000Z',
    endedAt: new Date(Date.parse('2026-10-10T00:00:00.000Z') + seconds * 1000).toISOString(),
  });

  it('a model a council was pinned to never moves the speed of the assistant on another model', async () => {
    const store = new Store(home);
    await store.init();
    const chair = chairNode('c1', 'u0', 1, {
      attempts: [
        attempt('pi', 'fake-1', 5),
        attempt('pi', 'fake-slow', 90),
        attempt('claude', 'fake-1', 8),
      ],
    });
    await store.save(sessionOf([userNode('u0', null, 'Q'), chair], 'speed'));
    const speeds = store.measuredLatency();
    // Quick ranks Pi by its own model's seconds; the slow model of another council is another entry
    expect(speeds.get(speedKey('pi', 'fake-1'))).toBe(5);
    expect(speeds.get(speedKey('pi', 'fake-slow'))).toBe(90);
    expect(speeds.get(speedKey('claude', 'fake-1'))).toBe(8);
    expect(speeds.size).toBe(3);
  });
});
