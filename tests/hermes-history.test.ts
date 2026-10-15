import * as childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import {
  cleanHistoryEnv,
  queryHermesHistory,
  readHermesHistory,
} from '../src/server/hermes-history.ts';
import { hermesFixture, hermesLayoutReady } from './helpers/hermes.ts';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

function database(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); CREATE INDEX message_session ON messages(session_id,id)',
  );
  return db;
}
describe('Hermes history, disposable SQLite only', () => {
  it('paginates 1203 titles and 10305 interleaved rows without omitting older eligible text, and bounds escaped MCP bytes', () => {
    const temp = mkdtempSync(join(tmpdir(), 'divan-hermes-history-'));
    const path = join(temp, 'history.db');
    const db = database(path);
    try {
      db.exec('BEGIN');
      const session = db.prepare('INSERT INTO sessions VALUES(?,?,?)');
      for (let n = 1; n <= 1203; n++) session.run(`s${n}`, `${'x'.repeat(180)}needle ${n}`, n);
      const message = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)');
      for (let n = 1; n <= 10305; n++)
        message.run(
          n,
          's1',
          n % 3 === 0 ? 'tool' : n % 2 === 0 ? 'user' : 'assistant',
          n === 1 ? '\0\\"'.repeat(40000) : `body ${n}`,
          n,
          n % 2,
        );
      db.exec('COMMIT');
      const sessions: string[] = [],
        messages: string[] = [];
      let cursor: string | null = null;
      do {
        const page = queryHermesHistory(path, 'search', {
          query: 'needle',
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        sessions.push(...page.rows.map((row) => row.id as string));
        cursor = page.nextCursor;
      } while (cursor);
      expect(sessions).toHaveLength(1203);
      expect(new Set(sessions).size).toBe(1203);
      expect(sessions.at(-1)).toBe('s1');
      do {
        const page = queryHermesHistory(path, 'read', {
          sessionId: 's1',
          limit: 300,
          ...(cursor ? { cursor } : {}),
        });
        messages.push(...page.rows.map((row) => row.id as string));
        expect(
          Buffer.byteLength(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'x'.repeat(128),
              result: { content: [{ type: 'text', text: JSON.stringify(page) }] },
            }),
          ),
        ).toBeLessThanOrEqual(128 * 1024);
        cursor = page.nextCursor;
      } while (cursor);
      expect(messages).toHaveLength(6870);
      expect(new Set(messages).size).toBe(6870);
      expect(messages.at(-1)).toBe('1');
      const nul = queryHermesHistory(path, 'read', { sessionId: 's1', cursor: '2', limit: 1 });
      expect(nul.rows[0]?.content).toContain('\0');
      expect(nul.rows[0]?.clipped).toBe(true);
      session.run('nul-title', 'before\0needle سلام', 1204);
      expect(queryHermesHistory(path, 'search', { query: 'سلام' }).rows[0]?.title).toBe(
        'before\0needle سلام',
      );
      const empty = queryHermesHistory(path, 'read', {
        sessionId: 's1',
        cursor: '10306',
        limit: 1,
      });
      expect(empty.rows).toEqual([]);
      expect(empty.nextCursor).toBe('10305');
      expect(empty.inspected).toBe(1);
      expect(
        queryHermesHistory(path, 'search', { query: "';DROP TABLE sessions;--" }).rows,
      ).toEqual([]);
      expect(() => queryHermesHistory(path, 'unknown', {})).toThrow();
      for (const args of [
        { sessionId: 's1', cursor: '0' },
        { sessionId: 's1', cursor: '9223372036854775808' },
        { sessionId: "';DROP TABLE messages;--" },
        { sessionId: 's1', limit: 301 },
        { sessionId: 's1', path },
      ])
        expect(() => queryHermesHistory(path, 'read', args)).toThrow();
      db.exec('DROP INDEX message_session; CREATE INDEX wrong ON messages(id,session_id)');
      expect(() => queryHermesHistory(path, 'read', { sessionId: 's1' })).toThrow();
    } finally {
      db.close();
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it('H: rejects incompatible table/column/rowid/index shapes and accepts the supported rowid index', () => {
    const temp = mkdtempSync(join(tmpdir(), 'divan-hermes-schema-'));
    const path = join(temp, 'history.db');
    const cases = [
      'DROP TABLE sessions; CREATE VIEW sessions AS SELECT 1 AS id,2 AS title,3 AS started_at',
      'DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,started_at REAL) WITHOUT ROWID',
      'ALTER TABLE sessions ADD COLUMN rowid INTEGER',
      'ALTER TABLE messages RENAME COLUMN content TO wrong',
      'DROP INDEX message_session; CREATE INDEX wrong ON messages(id,session_id)',
      'DROP INDEX message_session; CREATE INDEX wrong ON messages(session_id,role,id)',
      'DROP INDEX message_session; CREATE INDEX wrong ON messages(session_id,id) WHERE active=1',
      'DROP TABLE messages; CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,timestamp REAL,active INTEGER); CREATE INDEX wrong ON messages(session_id,id)',
    ];
    try {
      for (const sql of cases) {
        const db = database(path);
        db.exec(sql);
        db.close();
        expect(() => queryHermesHistory(path, 'read', { sessionId: 's1' }), sql).toThrow();
        rmSync(path);
      }
      const db = database(path);
      db.exec('DROP INDEX message_session; CREATE INDEX supported ON messages(session_id)');
      db.close();
      expect(queryHermesHistory(path, 'read', { sessionId: 's1' }).rows).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it('H: a stalled owned query worker is killed at the five-second deadline', async () => {
    const original =
      await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let pid = 0;
    const spawn = vi
      .mocked(childProcess.spawn)
      .mockImplementationOnce((...args: Parameters<typeof childProcess.spawn>) => {
        const child = original.spawn(
          process.execPath,
          [
            '-e',
            "process.stdin.resume();const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.prepare('WITH RECURSIVE work(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM work) SELECT sum(n) FROM work').get()",
          ],
          args[2],
        );
        pid = child.pid ?? 0;
        return child;
      });
    try {
      const started = Date.now();
      await expect(
        readHermesHistory('synthetic', 'synthetic', 'search', { query: 'fixture' }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(12000);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      spawn.mockImplementation(original.spawn);
    }
  }, 15000);
  it.skipIf(!hermesLayoutReady)(
    'an actual Low worker reads a WAL-only commit while a connected writer is paused, leaving all bytes unchanged',
    async () => {
      const fixture = hermesFixture();
      const path = join(fixture.control, 'history.db');
      const db = database(path);
      try {
        db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('wal', 'WAL-only canary', 1);
        const files = [path, `${path}-wal`, `${path}-shm`];
        const before = files.map((file) => readFileSync(file));
        const result = await fixture.executeCommand(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
          ],
          JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
          cleanHistoryEnv(path, fixture.basePython),
        );
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout).rows[0].id).toBe('wal');
        expect(files.map((file) => readFileSync(file))).toEqual(before);
        const request = (id: number, method: string, params?: unknown) =>
          JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
        const input = `${[
          request(1, 'initialize'),
          request(2, 'tools/list'),
          request(3, 'tools/call', {
            name: 'hermes_history_search',
            arguments: { query: 'WAL-only' },
          }),
          request(4, 'tools/call', { name: 'writer', arguments: {} }),
          request(5, 'unknown'),
          '{bad',
          'x'.repeat(17000),
        ].join('\n')}\n`;
        const mcp = await fixture.executeCommand(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            join(import.meta.dirname, '../src/server/hermes-history-mcp.ts'),
          ],
          input,
          cleanHistoryEnv(path, fixture.basePython),
        );
        expect(mcp.code, mcp.stderr).toBe(0);
        const replies = mcp.stdout
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(replies).toHaveLength(7);
        expect(replies[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual([
          'hermes_history_search',
          'hermes_history_read',
        ]);
        expect(replies[2].result.content[0].text).toContain('WAL-only');
        expect(replies.slice(3).every((reply) => reply.error)).toBe(true);
        expect(files.map((file) => readFileSync(file))).toEqual(before);
        // Only the paused fixture writer changes these bytes; the Low readers cannot repair them.
        for (const suffix of ['-wal', '-shm']) {
          const copied = join(fixture.control, `missing${suffix}.db`);
          files.forEach((file, index) => {
            writeFileSync(copied + ['', '-wal', '-shm'][index], readFileSync(file));
          });
          rmSync(copied + suffix);
          const absent = await fixture.executeCommand(
            process.execPath,
            [
              '--disable-warning=ExperimentalWarning',
              join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
            ],
            JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
            cleanHistoryEnv(copied, fixture.basePython),
          );
          expect(absent.code).toBe(125);
        }
        const bad = join(fixture.control, 'corrupt.db');
        writeFileSync(bad, 'corrupt synthetic database');
        const corrupt = await fixture.executeCommand(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
          ],
          JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
          cleanHistoryEnv(bad, fixture.basePython),
        );
        expect(corrupt.code).toBe(125);
        for (const suffix of ['-wal', '-shm']) {
          const stale = join(fixture.control, `stale${suffix}.db`);
          files.forEach((file, index) => {
            writeFileSync(stale + ['', '-wal', '-shm'][index], readFileSync(file));
          });
          writeFileSync(stale + suffix, Buffer.alloc(100));
          const result = await fixture.executeCommand(
            process.execPath,
            [
              '--disable-warning=ExperimentalWarning',
              join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
            ],
            JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
            cleanHistoryEnv(stale, fixture.basePython),
          );
          expect(result.code).toBe(125);
        }
        const unsafe = join(fixture.run, 'home/low.db');
        database(unsafe).close();
        const refused = await fixture.executeCommand(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
          ],
          JSON.stringify({ action: 'search', args: { query: 'fixture' } }),
          cleanHistoryEnv(unsafe, fixture.basePython),
        );
        expect(refused.code).toBe(125);
        const locked = join(fixture.control, 'locked.db');
        const lock = database(locked);
        lock.exec('BEGIN EXCLUSIVE');
        try {
          const blocked = await fixture.executeCommand(
            process.execPath,
            [
              '--disable-warning=ExperimentalWarning',
              join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
            ],
            JSON.stringify({ action: 'search', args: { query: 'fixture' } }),
            cleanHistoryEnv(locked, fixture.basePython),
          );
          expect(blocked.code).toBe(125);
          expect(blocked.durationMs).toBeLessThan(8000);
        } finally {
          lock.exec('ROLLBACK');
          lock.close();
        }
        let writes = 0;
        const timer = setInterval(() => {
          writes++;
          db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(
            `writer${writes}`,
            'WAL-only writer',
            writes,
          );
        }, 100);
        try {
          const concurrent = await fixture.executeCommand(
            process.execPath,
            [
              '--disable-warning=ExperimentalWarning',
              join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
            ],
            JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
            cleanHistoryEnv(path, fixture.basePython),
          );
          expect(concurrent.code, concurrent.stderr).toBe(0);
          expect(writes).toBeGreaterThan(0);
        } finally {
          clearInterval(timer);
        }
        expect(
          db.prepare("SELECT count(*) AS n FROM sessions WHERE id LIKE 'writer%'").get()?.n,
        ).toBe(writes);
        const paused = files.map((file) => readFileSync(file));
        const final = await fixture.executeCommand(
          process.execPath,
          [
            '--disable-warning=ExperimentalWarning',
            join(import.meta.dirname, '../src/server/hermes-history-worker.ts'),
          ],
          JSON.stringify({ action: 'search', args: { query: 'WAL-only' } }),
          cleanHistoryEnv(path, fixture.basePython),
        );
        expect(final.code).toBe(0);
        expect(files.map((file) => readFileSync(file))).toEqual(paused);
      } finally {
        db.close();
        fixture.close();
      }
    },
    150_000,
  );
});
