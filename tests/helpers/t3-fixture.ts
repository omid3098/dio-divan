// A tiny T3 Code database for the tests: the three tables the T3 threads server reads, with the columns it reads (the layout of
// T3's own `statev2.sqlite`, found by reading it read-only). The real database is never used by a test.

import { DatabaseSync } from 'node:sqlite';

export const THREAD_A = '93ef2b0b-d576-4a75-a177-d08cded0d170';
export const THREAD_A2 = '93ef2b0b-ffff-4000-8000-000000000002';
export const THREAD_C = 'c0ffee00-1111-4222-8333-444455556666';
export const THREAD_DELETED = 'dddddddd-1111-4222-8333-444455556666';
export const THREAD_LONG = 'aaaa0000-1111-4222-8333-444455556666';
export const THREAD_HUGE = 'bbbb0000-1111-4222-8333-444455556666';
export const THREAD_EMPTY = 'eeee0000-1111-4222-8333-444455556666';

export const TITLE_A = 'تحلیل پیشنهاد توییت کارپاتی';

const SCHEMA = `
create table projection_projects (project_id text primary key, title text, workspace_root text);
create table orchestration_v2_projection_threads (
  thread_id text primary key, project_id text, title text, default_provider text,
  created_at text, updated_at text, archived_at text, deleted_at text, payload_json text);
create table orchestration_v2_projection_messages (
  message_id text primary key, thread_id text, run_id text, node_id text, role text, streaming integer,
  created_at text, updated_at text, payload_json text);
create index orchestration_v2_projection_messages_thread_created_idx
  on orchestration_v2_projection_messages (thread_id, created_at, message_id);
`;

let serial = 0;

export interface Fixture {
  /** The writer connection (T3 itself, in a live database): open until `close`. */
  db: DatabaseSync;
  addThread: (thread: {
    id: string;
    title: string;
    project?: string;
    updated: string;
    created?: string;
    deleted?: boolean;
    archived?: boolean;
  }) => void;
  addMessage: (message: {
    thread: string;
    role: string;
    text: string;
    at: string;
    files?: number;
  }) => void;
  close: () => void;
}

/** Makes the database file (in WAL mode, as T3's is) and returns the writer that fills it. */
export function makeT3Database(file: string): Fixture {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.prepare('insert into projection_projects values (?, ?, ?)').run(
    'p1',
    'agent-office',
    'E:/w/agent-office',
  );
  db.prepare('insert into projection_projects values (?, ?, ?)').run(
    'p2',
    'dio-divan',
    'E:/w/dio-divan',
  );
  return {
    db,
    addThread: (thread) => {
      db.prepare(
        'insert into orchestration_v2_projection_threads values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        thread.id,
        thread.project ?? 'p1',
        thread.title,
        'codex',
        thread.created ?? thread.updated,
        thread.updated,
        thread.archived ? thread.updated : null,
        thread.deleted ? thread.updated : null,
        '{}',
      );
    },
    addMessage: (message) => {
      serial += 1;
      const id = `message-${serial}`;
      db.prepare(
        'insert into orchestration_v2_projection_messages values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        id,
        message.thread,
        `run-${message.thread}`,
        `node-${id}`,
        message.role,
        0,
        message.at,
        message.at,
        JSON.stringify({
          id,
          threadId: message.thread,
          role: message.role,
          text: message.text,
          attachments: Array.from({ length: message.files ?? 0 }, (_, index) => ({ id: index })),
          streaming: false,
          createdAt: message.at,
        }),
      );
    },
    close: () => db.close(),
  };
}

const at = (minute: number) => `2026-10-08T20:${String(minute).padStart(2, '0')}:00.000Z`;

/** The threads every test reads: a normal one, a twin by prefix, a deleted one, a long one, one huge message, and an empty one. */
export function fillT3Database(fixture: Fixture): void {
  const { addThread, addMessage } = fixture;
  addThread({ id: THREAD_A, title: TITLE_A, updated: '2026-10-09T18:07:42.021Z', created: at(51) });
  addMessage({
    thread: THREAD_A,
    role: 'user',
    text: 'Is this tweet a good idea? 100% sure?',
    at: at(51),
  });
  addMessage({ thread: THREAD_A, role: 'reasoning', text: 'SECRET-REASONING', at: at(52) });
  addMessage({
    thread: THREAD_A,
    role: 'assistant',
    text: 'Yes, if you cite the paper.',
    at: at(53),
  });
  addMessage({ thread: THREAD_A, role: 'assistant', text: '   ', at: at(54) });
  addMessage({ thread: THREAD_A, role: 'tool', text: 'SECRET-TOOL-OUTPUT', at: at(55) });
  addMessage({ thread: THREAD_A, role: 'user', text: 'کارپاتی چه گفت؟', at: at(56), files: 2 });
  addMessage({
    thread: THREAD_A,
    role: 'assistant',
    text: 'He said the budget is small.',
    at: at(57),
  });

  addThread({
    id: THREAD_A2,
    title: 'A twin thread',
    project: 'p2',
    updated: '2026-10-07T10:00:00.000Z',
  });
  addMessage({ thread: THREAD_A2, role: 'user', text: 'twin question', at: at(1) });

  addThread({
    id: THREAD_C,
    title: 'Pricing plan',
    project: 'p2',
    updated: '2026-10-09T09:00:00.000Z',
    archived: true,
  });
  addMessage({ thread: THREAD_C, role: 'user', text: 'What should the pricing be?', at: at(10) });
  addMessage({
    thread: THREAD_C,
    role: 'assistant',
    text: 'Charge by the seat; keep the budget flat.',
    at: at(11),
  });

  addThread({
    id: THREAD_DELETED,
    title: 'Old plan',
    updated: '2026-10-09T20:00:00.000Z',
    deleted: true,
  });
  addMessage({ thread: THREAD_DELETED, role: 'user', text: 'budget budget budget', at: at(20) });

  addThread({ id: THREAD_LONG, title: 'A very long thread', updated: '2026-10-09T12:00:00.000Z' });
  for (let i = 1; i <= 40; i += 1) {
    addMessage({
      thread: THREAD_LONG,
      role: i % 2 === 1 ? 'user' : 'assistant',
      text: `message ${String(i).padStart(2, '0')} ${'x'.repeat(2000)}`,
      at: `2026-10-09T11:${String(i).padStart(2, '0')}:00.000Z`,
    });
  }

  addThread({ id: THREAD_HUGE, title: 'One huge message', updated: '2026-10-09T13:00:00.000Z' });
  addMessage({
    thread: THREAD_HUGE,
    role: 'assistant',
    text: `START ${'y'.repeat(100_000)} END`,
    at: at(30),
  });

  addThread({ id: THREAD_EMPTY, title: 'Nothing said', updated: '2026-10-09T14:00:00.000Z' });
}
