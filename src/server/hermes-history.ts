import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { HERMES_ASSETS } from './adapters/hermes-install.ts';
import { killTree } from './proc.ts';

export const HERMES_HISTORY_DB = 'DIVAN_HERMES_HISTORY_DB';
export const HERMES_HISTORY_PYTHON = 'DIVAN_HERMES_HISTORY_PYTHON';
const MAX_CURSOR = 9223372036854775807n;
const MAX_RESPONSE = 128 * 1024;
type Args = Record<string, unknown>;
interface HistoryRow {
  id?: string;
  title?: string;
  role?: string;
  content?: string;
  active?: boolean;
  startedAt?: number;
  timestamp?: number;
  clipped?: boolean;
}
export interface HistoryPage {
  rows: HistoryRow[];
  inspected: number;
  nextCursor: string | null;
  truncated: boolean;
  order: string;
  coverage: string;
}
export class HermesHistoryError extends Error {
  constructor() {
    super('Hermes history is unavailable for the protected reader.');
  }
}

function cursor(value: unknown): bigint | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value))
    throw new HermesHistoryError();
  const number = BigInt(value);
  if (number > MAX_CURSOR) throw new HermesHistoryError();
  return number;
}
function limit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 1 || value > max)
    throw new HermesHistoryError();
  return value;
}

export function boundHistory(page: HistoryPage): HistoryPage {
  const bytes = () =>
    Buffer.byteLength(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'x'.repeat(128),
        result: { content: [{ type: 'text', text: JSON.stringify(page) }] },
      }),
    );
  while (bytes() > MAX_RESPONSE) {
    const row = page.rows.findLast((row) => (row.content?.length ?? 0) > 0);
    if (!row) throw new HermesHistoryError();
    row.content = (row.content ?? '').slice(0, Math.floor((row.content?.length ?? 0) / 2));
    row.clipped = page.truncated = true;
  }
  return page;
}

function schema(db: DatabaseSync) {
  for (const [table, columns] of [
    ['sessions', ['id', 'title', 'started_at']],
    ['messages', ['id', 'session_id', 'role', 'content', 'timestamp', 'active']],
  ] as const) {
    const kind = db.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(table);
    if (kind?.type !== 'table' || /WITHOUT\s+ROWID/iu.test(String(kind.sql)))
      throw new HermesHistoryError();
    const actual = db.prepare(`PRAGMA table_info(${table})`).all();
    if (actual.some((row) => ['rowid', '_rowid_', 'oid'].includes(String(row.name).toLowerCase())))
      throw new HermesHistoryError();
    if (!columns.every((column) => actual.some((row) => row.name === column)))
      throw new HermesHistoryError();
    const textColumns = table === 'sessions' ? ['id', 'title'] : ['session_id', 'role', 'content'];
    if (textColumns.some((name) => !actual.some((row) => row.name === name && row.type === 'TEXT')))
      throw new HermesHistoryError();
    if (
      table === 'messages' &&
      (!actual.some((row) => row.name === 'id' && row.pk === 1 && row.type === 'INTEGER') ||
        actual.filter((row) => Number(row.pk) > 0).length !== 1)
    )
      throw new HermesHistoryError();
  }
  const indexed = db
    .prepare('PRAGMA index_list(messages)')
    .all()
    .some((index) => {
      if (index.partial !== 0) return false;
      const columns = db
        .prepare('SELECT * FROM pragma_index_xinfo(?) ORDER BY seqno')
        .all(String(index.name));
      return (
        columns[0]?.name === 'session_id' &&
        columns[0]?.desc === 0 &&
        columns[0]?.coll === 'BINARY' &&
        (columns[1]?.name === 'id' || columns[1]?.cid === -1) &&
        columns[1]?.desc === 0
      );
    });
  if (!indexed) throw new HermesHistoryError();
}

export function queryHermesHistory(path: string, action: string, args: Args): HistoryPage {
  if (
    typeof args !== 'object' ||
    args === null ||
    Array.isArray(args) ||
    (action !== 'search' && action !== 'read') ||
    Object.keys(args).some(
      (key) => ![action === 'search' ? 'query' : 'sessionId', 'cursor', 'limit'].includes(key),
    )
  )
    throw new HermesHistoryError();
  const before = cursor(args.cursor);
  const max = limit(args.limit, action === 'search' ? 20 : 100, action === 'search' ? 100 : 300);
  if (
    action === 'search' &&
    (typeof args.query !== 'string' || args.query.trim().length < 2 || args.query.length > 200)
  )
    throw new HermesHistoryError();
  if (
    action === 'read' &&
    (typeof args.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(args.sessionId))
  )
    throw new HermesHistoryError();
  const db = new DatabaseSync(path, { readOnly: true, timeout: 1000 });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    schema(db);
    const page: HistoryPage = {
      rows: [],
      inspected: 0,
      nextCursor: null,
      truncated: false,
      order: 'insertion-descending; per-call snapshot',
      coverage:
        action === 'search'
          ? 'titles only'
          : 'user/assistant, including inactive; other roles inspected and omitted',
    };
    const statement = db.prepare(
      action === 'search'
        ? `SELECT rowid AS cursor,id,substr(CAST(title AS BLOB),1,240001) AS title,typeof(title) AS field_type,length(CAST(title AS BLOB))>240000 AS oversized,started_at FROM sessions WHERE rowid>0 ${before === null ? '' : 'AND rowid<?'} ORDER BY rowid DESC LIMIT 500`
        : `SELECT id AS cursor,role,substr(CAST(content AS BLOB),1,240000) AS content,typeof(content) AS field_type,length(CAST(content AS BLOB))>240000 AS clipped,timestamp,active FROM messages WHERE session_id=? AND id>0 ${before === null ? '' : 'AND id<?'} ORDER BY id DESC LIMIT ?`,
    );
    statement.setReadBigInts(true);
    const values =
      action === 'search'
        ? [...(before === null ? [] : [before])]
        : [String(args.sessionId), ...(before === null ? [] : [before]), max];
    let body = 0;
    let last: bigint | undefined;
    for (const row of statement.iterate(...values)) {
      page.inspected++;
      last = row.cursor as bigint;
      if (last <= 0n || last > MAX_CURSOR) throw new HermesHistoryError();
      if (action === 'search') {
        if (!['text', 'null'].includes(String(row.field_type))) throw new HermesHistoryError();
        // SQLite's text length/substr stops at NUL; a bounded byte slice preserves the complete text.
        const title =
          row.title === null ? '' : Buffer.from(row.title as Uint8Array).toString('utf8');
        if (row.oversized || title.length > 60000) throw new HermesHistoryError();
        if (!title.toLowerCase().includes(String(args.query).toLowerCase())) continue;
        if (typeof row.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(row.id))
          throw new HermesHistoryError();
        page.rows.push({
          id: row.id,
          title: title.slice(0, 160),
          startedAt: Number(row.started_at),
          clipped: title.length > 160,
        });
        page.truncated ||= title.length > 160;
        if (page.rows.length >= max) break;
      } else {
        if (!['user', 'assistant'].includes(String(row.role))) continue;
        if (!['text', 'null'].includes(String(row.field_type))) throw new HermesHistoryError();
        const raw =
          row.content === null ? '' : Buffer.from(row.content as Uint8Array).toString('utf8');
        const text = raw.slice(0, 60000 - body);
        body += text.length;
        const clipped = Boolean(row.clipped) || text.length !== raw.length;
        page.rows.push({
          id: String(last),
          role: String(row.role),
          content: text,
          timestamp: Number(row.timestamp),
          active: Boolean(row.active),
          clipped,
        });
        page.truncated ||= clipped;
        if (body >= 60000) break;
      }
    }
    if (last !== undefined) {
      const older =
        action === 'search'
          ? db.prepare('SELECT 1 FROM sessions WHERE rowid>0 AND rowid<? LIMIT 1').get(last)
          : db
              .prepare('SELECT 1 FROM messages WHERE session_id=? AND id>0 AND id<? LIMIT 1')
              .get(String(args.sessionId), last);
      page.nextCursor = older ? String(last) : null;
    }
    return boundHistory(page);
  } catch {
    throw new HermesHistoryError();
  } finally {
    db.close();
  }
}

export function checkHistory(path: string, python: string): string {
  if (process.platform !== 'win32') throw new HermesHistoryError();
  try {
    const output = execFileSync(
      python,
      [
        '-I',
        '-S',
        '-B',
        join(HERMES_ASSETS, 'history-check.py'),
        path,
        process.execPath,
        fileURLToPath(import.meta.url),
      ],
      { windowsHide: true, env: cleanHistoryEnv(path, python), encoding: 'utf8', timeout: 3000 },
    );
    const result = JSON.parse(output);
    if (result.ok !== true) throw new HermesHistoryError();
    return JSON.stringify(result.objects);
  } catch {
    throw new HermesHistoryError();
  }
}

export function cleanHistoryEnv(path: string, python: string): NodeJS.ProcessEnv {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    [HERMES_HISTORY_DB]: path,
    [HERMES_HISTORY_PYTHON]: python,
  };
}

export function readHermesHistory(
  path: string,
  python: string,
  action: string,
  args: Args,
): Promise<HistoryPage> {
  const script = fileURLToPath(
    new URL(
      import.meta.url.endsWith('.js') ? './hermes-history-worker.js' : './hermes-history-worker.ts',
      import.meta.url,
    ),
  );
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], {
      windowsHide: true,
      env: cleanHistoryEnv(path, python),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let output = '',
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      if (child.pid) void killTree(child.pid);
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (Buffer.byteLength(output) > MAX_RESPONSE) {
        failed = true;
        if (child.pid) void killTree(child.pid);
      }
    });
    child.stdin.on('error', () => {
      failed = true;
    });
    child.on('error', () => {
      clearTimeout(timer);
      fail(new HermesHistoryError());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (failed || code !== 0) throw new HermesHistoryError();
        done(JSON.parse(output));
      } catch {
        fail(new HermesHistoryError());
      }
    });
    child.stdin.end(JSON.stringify({ action, args }));
  });
}
