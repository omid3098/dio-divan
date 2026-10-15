// The single-instance lock is held by the operating system. Several processes racing for it (a stale lock, a start-up at
// the same moment) must produce exactly one winner, and a crashed owner must never block the next start.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlreadyRunningError, acquireLock } from '../src/server/lock.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-lock-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const child = join(import.meta.dirname, 'helpers', 'lock-child.mjs');

/** Starts a contender; resolves with what it printed ("won" or "lost") once it has decided. */
function contender(hold: string): Promise<{ answer: string; finished: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [child, home, hold], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    const finished = new Promise<void>((done) => proc.on('close', () => done()));
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('\n')) resolve({ answer: out.trim(), finished });
    });
    proc.on('error', reject);
    proc.on('close', () => resolve({ answer: out.trim() || 'no answer', finished }));
  });
}

describe('one instance per home', () => {
  it.skipIf(process.platform === 'win32')(
    'explains a Unix socket path that is too long',
    async () => {
      const name = 'long'.repeat(35);
      // the folder is named (its real path, which the lock uses), with the limit and the way out; DIVAN_HOME is not blamed
      const error = await acquireLock(join(home, name)).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toMatch(/^The Divan folder /u);
      expect(message).toContain(name);
      expect(message).toContain('too long for the single-instance lock');
      expect(message).toContain('at most 88 bytes');
      expect(message).toMatch(/Set DIVAN_HOME to a shorter folder path\.$/u);
    },
  );
  it('takes the lock, refuses a second owner, and frees it on release', async () => {
    const release = await acquireLock(home);
    await expect(acquireLock(home)).rejects.toBeInstanceOf(AlreadyRunningError);
    await release();
    const again = await acquireLock(home);
    await again();
  });

  it('a junction to the home is the same home: it takes the same lock', async () => {
    const alias = join(tmpdir(), `divan-lock-alias-${Date.now()}`);
    symlinkSync(home, alias, 'junction');
    try {
      const release = await acquireLock(home);
      await expect(acquireLock(alias)).rejects.toBeInstanceOf(AlreadyRunningError);
      await release();
      // and the other way round
      const viaAlias = await acquireLock(alias);
      await expect(acquireLock(home)).rejects.toBeInstanceOf(AlreadyRunningError);
      await viaAlias();
    } finally {
      // removes the link, never the folder it leads to (a junction on Windows, a symbolic link elsewhere)
      rmSync(alias, { force: true });
    }
  });

  it('exactly one of several processes starting at the same moment wins', async () => {
    const racers = await Promise.all(Array.from({ length: 6 }, () => contender('1500')));
    const answers = racers.map((racer) => racer.answer);
    expect(answers.filter((answer) => answer === 'won')).toHaveLength(1);
    expect(answers.filter((answer) => answer === 'lost')).toHaveLength(5);
    await Promise.all(racers.map((racer) => racer.finished));
    // the winner released it on its way out
    const next = await contender('0');
    expect(next.answer).toBe('won');
    await next.finished;
  }, 30_000);

  it('an owner that crashed without releasing leaves nothing stale: the next start wins at once', async () => {
    const crashed = await contender('crash');
    expect(crashed.answer).toBe('won');
    await crashed.finished;
    // several contenders race for what the dead owner left behind: still exactly one winner
    const racers = await Promise.all(Array.from({ length: 5 }, () => contender('800')));
    expect(racers.map((r) => r.answer).filter((a) => a === 'won')).toHaveLength(1);
    await Promise.all(racers.map((racer) => racer.finished));
  }, 30_000);
});
