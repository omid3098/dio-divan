import { chairmanOf, seatsOf, storedFlow } from '../src/shared/flow.ts';
import { requireValue } from './fixtures.ts';
// The OpenAI-compatible endpoint, through a real server with the fake harnesses: its guard (a key, and no browser
// headers), the models it lists, a streamed and a plain answer, the cached repeat, branching from an echoed answer, a new
// session with the earlier conversation as background, identical concurrent requests sharing one run, a client that goes
// away, and the working folder.

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, parse } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { identityOf } from '../src/server/gateway.ts';
import { PortBusyError, type RunningServer, startServer } from '../src/server/server.ts';
import { SettingsService } from '../src/server/settings.ts';
import { DEFAULT_PORT, QUICK_BLOCKED } from '../src/shared/defaults.ts';
import { agentsOf } from '../src/shared/flow.ts';
import { estimateTokens } from '../src/shared/text.ts';
import type {
  ChairNode,
  ProfileView,
  SeatConfig,
  Session,
  SessionSummary,
  SettingsView,
} from '../src/shared/types.ts';
import { writerFlow } from './fixtures/flows.ts';

let server: RunningServer;
let home: string;
let webRoot: string;
let project: string;

beforeAll(async () => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
  home = mkdtempSync(join(tmpdir(), 'divan-v1-'));
  webRoot = mkdtempSync(join(tmpdir(), 'divan-v1web-'));
  project = mkdtempSync(join(tmpdir(), 'divan-v1proj-'));
  mkdirSync(join(project, 'src'));
  server = await startServer({ port: 0, home, webRoot });
});
afterAll(async () => {
  await server.close();
  for (const dir of [home, webRoot, project])
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Reply {
  status: number;
  body: string;
}

function call(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    host?: string;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? (text === undefined ? 'GET' : 'POST'),
        headers: {
          host: options.host ?? `127.0.0.1:${server.port}`,
          ...(text === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

const key = () => ({ authorization: `Bearer ${server.apiKey}` });
const web = () => ({ 'x-divan-token': server.token });
const api = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const reply = await call(`/api${path}`, { method, headers: web(), body });
  return JSON.parse(reply.body) as T;
};

interface Chunk {
  choices: {
    delta: { content?: string; reasoning_content?: string; role?: string };
    finish_reason: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  divan?: { session_id: string; round_id: string; cached: boolean };
  error?: { message: string; code: string };
}

/** A streamed answer: its reasoning text, its content, the last chunk with `divan`, the usage and whether it ended with [DONE]. */
function readStream(body: string) {
  const chunks: Chunk[] = [];
  let done = false;
  for (const block of body.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const data = line.slice(6);
    if (data === '[DONE]') done = true;
    else chunks.push(JSON.parse(data) as Chunk);
  }
  const text = (field: 'content' | 'reasoning_content') =>
    chunks.map((c) => c.choices[0]?.delta[field] ?? '').join('');
  return {
    chunks,
    reasoning: text('reasoning_content'),
    content: text('content'),
    divan: chunks.find((c) => c.divan)?.divan,
    usage: chunks.find((c) => c.usage)?.usage,
    done,
    error: chunks.find((c) => c.error)?.error,
  };
}

const ask = (
  messages: unknown[],
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  model = 'divan/default',
) =>
  call('/v1/chat/completions', {
    headers: { ...key(), ...headers },
    body: { model, messages, stream: true, stream_options: { include_usage: true }, ...extra },
  });

/** A profile of our own whose seats all run `model` (and the members `extra` seats' models). */
async function profileWith(name: string, model: string): Promise<string> {
  const made = await api<{ id: string }>('/profiles', 'POST', { name });
  await api(`/profiles/${made.id}`, 'PUT', {
    overrides: {
      seats: Object.fromEntries(['claude', 'codex', 'grok', 'pi'].map((id) => [id, { model }])),
    },
  });
  return made.id;
}

const sessions = () => api<SessionSummary[]>('/sessions');
const session = (id: string) => api<Session>(`/sessions/${id}`);

describe('the guard of /v1', () => {
  it('needs the API key, and refuses anything a browser sends, key or no key', async () => {
    expect((await call('/v1/models')).status).toBe(401);
    expect((await call('/v1/models', { headers: { authorization: 'Bearer nope' } })).status).toBe(
      401,
    );
    expect((await call('/v1/models', { headers: { 'x-divan-token': server.token } })).status).toBe(
      401,
    );
    expect((await call('/v1/models', { headers: key() })).status).toBe(200);
    // Node's own fetch (the OpenAI SDK, Pi) sends Sec-Fetch-Mode: cors alone, which a browser never does
    expect(
      (await call('/v1/models', { headers: { ...key(), 'sec-fetch-mode': 'cors' } })).status,
    ).toBe(200);
    // a browser page: an Origin, or Fetch-Metadata, whatever else it sends
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: `http://127.0.0.1:${server.port}` },
      { 'sec-fetch-site': 'same-origin' },
      { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-user': '?1' },
    ]) {
      const reply = await call('/v1/models', { headers: { ...key(), ...headers } });
      expect(reply.status, JSON.stringify(headers)).toBe(403);
      expect(JSON.parse(reply.body).error.code).toBe('browser_request');
    }
    expect(
      (
        await call('/v1/chat/completions', {
          method: 'OPTIONS',
          headers: { origin: 'https://x.test', 'access-control-request-method': 'POST' },
        })
      ).status,
    ).toBe(403);
    // DNS rebinding: a Host that is not ours
    expect((await call('/v1/models', { headers: key(), host: 'evil.example' })).status).toBe(403);
    // the web API's token does not open /v1, and the key does not open the web API
    expect((await call('/api/health', { headers: key() })).status).toBe(401);
  });

  it('lists the profiles as divan/<id>', async () => {
    const reply = await call('/v1/models', { headers: key() });
    const ids = (JSON.parse(reply.body) as { data: { id: string }[] }).data.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['divan/default', 'divan/quick']));
  });

  it('answers errors in the OpenAI shape', async () => {
    const reply = await call('/v1/chat/completions', {
      headers: key(),
      body: { model: 'divan/nothing', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(reply.status).toBe(404);
    expect(JSON.parse(reply.body).error).toMatchObject({ code: 'model_not_found' });
    const bad = await call('/v1/chat/completions', { headers: key(), body: { model: 'default' } });
    expect(bad.status).toBe(400);
  });
});

describe('asking the council', () => {
  const Q1 = 'Should we build the desktop app or the web app first?';
  let firstContent = '';
  let sessionId = '';
  let chairId = '';

  it('streams progress as reasoning, then the answer, the questions and a link, with the usage', async () => {
    const before = (await sessions()).length;
    const reply = await ask([{ role: 'user', content: Q1 }]);
    expect(reply.status).toBe(200);
    const out = readStream(reply.body);
    expect(out.done).toBe(true);
    expect(out.error).toBeUndefined();
    // progress: seats start and finish with an anonymous stance, then the chairman
    expect(out.reasoning).toMatch(/Member [A-D] started/u);
    expect(out.reasoning).toMatch(/Member [A-D] done: \S/u);
    expect(out.reasoning).toMatch(/Chairman reading 4 answers/u);
    expect(out.reasoning).not.toMatch(/claude|codex|grok|fake-/iu);
    // content: the answer, the questions, then the link line
    expect(out.content).toMatch(/Recommendation/u);
    expect(out.content).toMatch(/Questions for you:\n- What is the monthly cost/u);
    // the closing line, alone on the last line: a link that opens the round (a one-time address), the round's own name
    // inside its address and nothing else in sight
    expect(out.content).toMatch(
      /\n\n\[Open in Divan\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)$/u,
    );
    expect(out.content).not.toMatch(/Dio Divan:|ref:/u);
    expect(out.chunks.at(-1)?.choices).toEqual([]);
    expect(out.usage?.total_tokens).toBeGreaterThan(1000);
    expect(out.divan?.cached).toBe(false);
    firstContent = out.content;
    sessionId = out.divan?.session_id as string;
    chairId = out.divan?.round_id as string;

    // the round is an ordinary session of origin api, and the usage is the round's own total
    const list = await sessions();
    expect(list).toHaveLength(before + 1);
    const summary = list.find((item) => item.id === sessionId);
    expect(summary).toMatchObject({ origin: 'api', rounds: 1 });
    const chair = (await session(sessionId)).nodes[chairId] as ChairNode;
    expect(out.usage?.total_tokens).toBe(chair.usage.total);
  });

  it('a plain request returns one JSON answer with the same shape', async () => {
    const reply = await call('/v1/chat/completions', {
      headers: key(),
      body: { model: 'default', messages: [{ role: 'user', content: Q1 }] },
    });
    expect(reply.status).toBe(200);
    const body = JSON.parse(reply.body);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('divan/default');
    expect(body.choices[0].message.content).toMatch(
      /\n\n\[Open in Divan\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)$/u,
    );
    expect(body.divan.cached).toBe(true); // the streamed request above already answered it
  });

  it('the same request again is answered from the cache: no new round, no tokens', async () => {
    const before = await sessions();
    const reply = await ask([{ role: 'user', content: Q1 }]);
    const out = readStream(reply.body);
    expect(out.divan).toMatchObject({ cached: true, session_id: sessionId, round_id: chairId });
    expect(out.usage?.total_tokens).toBe(0);
    expect(out.content.split('\n\n[Open in Divan](')[0]).toBe(
      firstContent.split('\n\n[Open in Divan](')[0],
    );
    expect(out.reasoning).toBe('');
    const after = await sessions();
    expect(after.map((s) => [s.id, s.rounds, s.tokens])).toEqual(
      before.map((s) => [s.id, s.rounds, s.tokens]),
    );
  });

  it('a conversation continued after an answer is a new round from that answer; going back makes a branch', async () => {
    const before = await sessions();
    const next = readStream(
      (
        await ask([
          { role: 'user', content: Q1 },
          { role: 'assistant', content: firstContent },
          { role: 'user', content: 'And what about the budget?' },
        ])
      ).body,
    );
    expect(next.divan?.session_id).toBe(sessionId);
    expect(next.divan?.cached).toBe(false);
    expect(await sessions()).toHaveLength(before.length); // no new session
    let state = await session(sessionId);
    const chairs = () =>
      Object.values(state.nodes).filter((n): n is ChairNode => n.kind === 'chair');
    expect(chairs()).toHaveLength(2);
    expect(chairs().find((c) => c.round === 2)?.parentId).toBeDefined();

    // the client goes back to the first answer and asks something else: a second child of it
    const branch = readStream(
      (
        await ask([
          { role: 'user', content: Q1 },
          { role: 'assistant', content: firstContent },
          { role: 'user', content: 'Forget that, what about hiring?' },
        ])
      ).body,
    );
    expect(branch.divan?.session_id).toBe(sessionId);
    state = await session(sessionId);
    expect(chairs()).toHaveLength(3);
    const parents = chairs()
      .filter((c) => c.round === 2)
      .map((c) => (state.nodes[c.parentId as string] as { parentId: string }).parentId);
    expect(parents).toEqual([chairId, chairId]);
    // the answer to the continued conversation is itself remembered: its echo continues from it
    const again = readStream(
      (
        await ask([
          { role: 'user', content: Q1 },
          { role: 'assistant', content: firstContent },
          { role: 'user', content: 'And what about the budget?' },
        ])
      ).body,
    );
    expect(again.divan?.cached).toBe(true);
  });

  it('the closing link is in the language of the answer, streamed or not', async () => {
    const Q = 'کدام پایگاه داده را برای یک تیم دو نفره انتخاب کنیم؟';
    const link =
      /\n\n\[باز کردن در دیوان\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)$/u;
    const streamed = readStream((await ask([{ role: 'user', content: Q }])).body);
    expect(streamed.content).toMatch(link);
    const plain = await call('/v1/chat/completions', {
      headers: key(),
      body: { model: 'default', messages: [{ role: 'user', content: Q }] },
    });
    expect(JSON.parse(plain.body).choices[0].message.content).toMatch(link);
  });

  it('the link opens the round once: the query that names it is not part of the one-time address', async () => {
    const reply = await call('/v1/chat/completions', {
      headers: key(),
      body: { model: 'default', messages: [{ role: 'user', content: Q1 }] },
    });
    const content = JSON.parse(reply.body).choices[0].message.content as string;
    const found = /\]\((http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[^)]+)\)$/u.exec(content);
    expect(found).not.toBeNull();
    const [linkedSession, linkedChair] =
      new URL(found?.[1] as string).searchParams.get('round')?.split('.') ?? [];
    const opened = await fetch(found?.[1] as string, { redirect: 'manual' });
    expect(opened.status).toBe(302);
    expect(opened.headers.get('location')).toContain(
      `to=${encodeURIComponent(`/s/${linkedSession}/n/${linkedChair}`)}`,
    );
    const expired = await fetch(found?.[1] as string, { redirect: 'manual' });
    expect(expired.status).toBe(302);
    expect(expired.headers.get('location')).toBe('/#expired');
  });

  it('a conversation from before, whose answer ends with the older line, still continues from its round', async () => {
    const before = await sessions();
    const older = `An answer the client has rewritten.\n\nDio Divan: http://127.0.0.1:1/open/old ref:${sessionId}.${chairId}`;
    const next = readStream(
      (
        await ask([
          { role: 'user', content: Q1 },
          { role: 'assistant', content: older },
          { role: 'user', content: 'And what about support?' },
        ])
      ).body,
    );
    expect(next.divan?.session_id).toBe(sessionId);
    expect(await sessions()).toHaveLength(before.length); // the round it names, not a new session
    const state = await session(sessionId);
    const made = state.nodes[next.divan?.round_id as string] as ChairNode;
    const parent = state.nodes[made.parentId as string] as { parentId: string };
    expect(parent.parentId).toBe(chairId);
  });

  it('a conversation we do not know becomes a new session, the earlier part as background (only user and assistant text)', async () => {
    const before = await sessions();
    const out = readStream(
      (
        await ask(
          [
            {
              role: 'system',
              content: 'You are a coding agent. Current working directory: Z:/nowhere',
            },
            { role: 'user', content: 'I am choosing a database.' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 't1', type: 'function', function: { name: 'read', arguments: '{}' } },
              ],
            },
            { role: 'tool', tool_call_id: 't1', content: 'TOOL-RESULT-SHOULD-NOT-APPEAR' },
            { role: 'assistant', content: 'Postgres or SQLite are the usual picks.' },
            { role: 'user', content: 'Which one for a two-person team?' },
          ],
          { tools: [{ type: 'function', function: { name: 'read' } }] },
        )
      ).body,
    );
    expect(out.divan?.cached).toBe(false);
    const list = await sessions();
    expect(list).toHaveLength(before.length + 1);
    const made = await session(out.divan?.session_id as string);
    expect(made.origin?.kind).toBe('api');
    expect((made.nodes[made.rootId] as { text: string }).text).toBe(
      'Which one for a two-person team?',
    );
    expect(made.background).toContain('user: I am choosing a database.');
    expect(made.background).toContain('assistant: Postgres or SQLite');
    expect(made.background).not.toContain('TOOL-RESULT');
    expect(made.background).not.toContain('coding agent');
    // the members saw it as its own section of the context
    const chair = Object.values(made.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    expect(chair.context.map((row) => row.kind)).toEqual(['rules', 'background', 'question']);
    expect(seatsOf(chair)[0]?.prompt).toContain('<background>');
  });

  it('a long earlier conversation is kept as background up to about 30k tokens: the newest turns, the oldest dropped', async () => {
    // 60 turns of about 1000 tokens each: 60k tokens before the question
    const turns = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `long ${String(i).padStart(2, '0')}: ${'word '.repeat(800)}`,
    }));
    const out = readStream(
      (
        await ask([
          ...turns,
          { role: 'user', content: 'So what should we do now, after all that?' },
        ])
      ).body,
    );
    expect(out.divan?.cached).toBe(false);
    const made = await session(out.divan?.session_id as string);
    const background = made.background as string;
    expect(estimateTokens(background)).toBeLessThanOrEqual(30_000);
    expect(estimateTokens(background)).toBeGreaterThan(25_000);
    expect(background).toContain('long 59:');
    expect(background).toContain('long 35:');
    expect(background).not.toContain('long 00:');
    // the members saw it, as before: its own section, with its size
    const chair = Object.values(made.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    const row = chair.context.find((item) => item.kind === 'background');
    expect(row?.tokens).toBeGreaterThan(25_000);
    expect(seatsOf(chair)[0]?.prompt).toContain('long 59:');
    expect(seatsOf(chair)[0]?.prompt).not.toContain('long 00:');
  }, 60_000);

  it('an empty last user message is a next round without comment', async () => {
    const out = readStream(
      (
        await ask([
          { role: 'user', content: Q1 },
          { role: 'assistant', content: firstContent },
          { role: 'user', content: '' },
        ])
      ).body,
    );
    expect(out.divan?.session_id).toBe(sessionId);
    const state = await session(sessionId);
    const nexts = Object.values(state.nodes).filter((n) => n.kind === 'next');
    expect(nexts).toHaveLength(1);
  });

  it('a profile revision or a folder that differs is not the same request', async () => {
    const other = await ask([{ role: 'user', content: Q1 }], {}, {}, 'divan/quick');
    expect(readStream(other.body).divan?.cached).toBe(false);
  });
});

describe('a round keeps its own identity', () => {
  const Q = 'Which database should a two-person team start with?';
  it('two rounds that produced the same words are told apart by the round the answer names; by the words alone they are unknown', async () => {
    const first = readStream((await ask([{ role: 'user', content: Q }])).body);
    const second = readStream(
      (await ask([{ role: 'user', content: Q }], {}, {}, 'divan/quick')).body,
    );
    expect(first.divan?.session_id).not.toBe(second.divan?.session_id);
    // the same words (the fake chairman writes the same answer for the same round number)
    const words = (content: string) => content.split('\n\n[Open in Divan](')[0];
    expect(words(first.content)).toBe(words(second.content));
    const before = (await sessions()).length;
    // (each conversation goes on with the model it began with: a session's council is locked at its level)
    const follow = async (assistant: string, model = 'divan/default') =>
      readStream(
        (
          await ask(
            [
              { role: 'user', content: Q },
              { role: 'assistant', content: assistant },
              { role: 'user', content: 'And for hosting?' },
            ],
            {},
            {},
            model,
          )
        ).body,
      );
    // with the closing line the client sends back, the right session continues, whichever it is
    expect((await follow(first.content)).divan?.session_id).toBe(first.divan?.session_id);
    expect((await follow(second.content, 'divan/quick')).divan?.session_id).toBe(
      second.divan?.session_id,
    );
    expect((await sessions()).length).toBe(before);
    // without it, the words fit two rounds: never a guess, a new session
    const guess = await follow(words(first.content) as string);
    expect([first.divan?.session_id, second.divan?.session_id]).not.toContain(
      guess.divan?.session_id,
    );
    expect((await sessions()).length).toBe(before + 1);
  }, 20_000);
});

describe('concurrent and abandoned requests', () => {
  const Q = 'A question that takes a little while to answer.';

  it('identical concurrent requests share one run', async () => {
    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '300';
    try {
      const before = await sessions();
      const [a, b] = await Promise.all([
        ask([{ role: 'user', content: Q }]),
        ask([{ role: 'user', content: Q }]),
      ]);
      const [x, y] = [readStream(a.body), readStream(b.body)];
      expect(x.divan?.session_id).toBe(y.divan?.session_id);
      expect(x.divan?.round_id).toBe(y.divan?.round_id);
      expect((await sessions()).length).toBe(before.length + 1);
      // both followed the same progress
      expect(x.reasoning).toBe(y.reasoning);
      expect(x.reasoning).toMatch(/Chairman reading/u);
      const made = await session(x.divan?.session_id as string);
      expect(Object.values(made.nodes).filter((n) => n.kind === 'chair')).toHaveLength(1);
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
  });

  /** A profile whose members hang until they are cancelled. */
  async function hangingProfile(): Promise<string> {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'hang test' });
    const view = await api<{ profiles: { id: string; effective: { seats: { id: string }[] } }[] }>(
      `/profiles/${made.id}`,
      'PUT',
      {
        overrides: {
          seats: Object.fromEntries(
            ['claude', 'codex', 'grok', 'pi'].map((id) => [id, { model: 'fake-hang' }]),
          ),
        },
      },
    );
    expect(view.profiles.some((p) => p.id === made.id)).toBe(true);
    return made.id;
  }

  /** Starts a streamed request that the test can walk away from; resolves once the round is running. */
  function start(model: string, content: string): { abort: () => void; ended: Promise<void> } {
    const text = JSON.stringify({
      model,
      stream: true,
      messages: [{ role: 'user', content }],
    });
    let request_: ReturnType<typeof request> | undefined;
    const ended = new Promise<void>((resolve) => {
      request_ = request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${server.port}`,
            'content-type': 'application/json',
            ...key(),
          },
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () => resolve());
          res.on('close', () => resolve());
        },
      );
      request_.on('error', () => resolve());
      request_.end(text);
    });
    return { abort: () => request_?.destroy(), ended };
  }

  async function chairOf(content: string): Promise<ChairNode | undefined> {
    const list = await sessions();
    const found = list.find((item) => item.question === content);
    if (!found) return undefined;
    const made = await session(found.id);
    return Object.values(made.nodes).find((n): n is ChairNode => n.kind === 'chair');
  }

  async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it('a client that goes away cancels the round only when no other client is waiting for it', async () => {
    const id = await hangingProfile();
    const content = 'Cancel me when the last client leaves.';
    const first = start(`divan/${id}`, content);
    await until(async () => {
      const chair = await chairOf(content);
      return !!chair && seatsOf(chair).some((s) => s.state === 'running');
    });
    const second = start(`divan/${id}`, content);
    await new Promise((r) => setTimeout(r, 200));
    first.abort();
    await new Promise((r) => setTimeout(r, 400));
    // one client is left: the round runs on
    expect((await chairOf(content))?.status).toBe('running');
    second.abort();
    await until(async () => (await chairOf(content))?.status === 'cancelled');
    const chair = await chairOf(content);
    expect(chair?.usage.total).toBeGreaterThan(0); // the spend of a cancelled round is counted
    await Promise.all([first.ended, second.ended]);
  });
});

describe('a long wait and the fixed port', () => {
  it('sends a keepalive while the council works, at least every 15 seconds', async () => {
    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '600';
    process.env.DIVAN_KEEPALIVE_MS = '100';
    try {
      const reply = await ask([
        { role: 'user', content: 'A question that makes the stream wait.' },
      ]);
      expect(reply.body).toMatch(/^: keepalive$/mu);
      expect(readStream(reply.body).done).toBe(true); // comment lines do not disturb the stream
      // the built-in interval is within the limit
      const { KEEPALIVE_MS } = await import('../src/server/openai.ts');
      expect(KEEPALIVE_MS).toBeLessThanOrEqual(15_000);
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
      delete process.env.DIVAN_KEEPALIVE_MS;
    }
  });

  it('fails clearly when the port is busy and never picks another; the default and the configured port come from settings', async () => {
    const other = mkdtempSync(join(tmpdir(), 'divan-v1other-'));
    try {
      const failed = startServer({ port: server.port, home: other, webRoot });
      await expect(failed).rejects.toBeInstanceOf(PortBusyError);
      await expect(failed).rejects.toThrow(
        new RegExp(`Port ${server.port} is already in use`, 'u'),
      );
      await expect(failed).rejects.toThrow(/does not pick another port/u);
      // the lock of that home was given back: it can start once the port is free
      const free = await startServer({ port: 0, home: other, webRoot });
      await free.close();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    const settings = new SettingsService(server.store);
    expect(settings.port()).toBe(DEFAULT_PORT);
    await settings.setPort(51234);
    expect(settings.port()).toBe(51234);
    await expect(settings.setPort(80)).rejects.toMatchObject({ code: 'bad_port' });
    await server.store.updateSettings((file) => {
      delete file.port;
      return file;
    });
    expect(settings.port()).toBe(DEFAULT_PORT);
  });
});

describe('the working folder', () => {
  it('says so when a member answered without the folder (its tool could not keep the folder’s own files out)', async () => {
    const id = await profileWith('no folder test', 'fake-nofolder');
    const out = readStream(
      (
        await ask(
          [{ role: 'user', content: 'Folder note?' }],
          {},
          { 'x-divan-cwd': encodeURIComponent(project) },
          `divan/${id}`,
        )
      ).body,
    );
    // in the progress, anonymously
    expect(out.reasoning).toMatch(/Member [A-D] answered without the project folder\./u);
    expect(out.reasoning).not.toMatch(/fake/u);
    // on every such seat, with the reason
    const made = await session(out.divan?.session_id as string);
    const chair = Object.values(made.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    expect(seatsOf(chair).length).toBeGreaterThan(0);
    for (const seat of seatsOf(chair)) expect(seat.folderNote).toMatch(/working folder not used/u);
  });

  it('uses a valid folder from the header, with read-only tools on, and tells the chairman nothing of it', async () => {
    const out = readStream(
      (
        await ask(
          [{ role: 'user', content: 'What is in this project folder?' }],
          {},
          { 'x-divan-cwd': encodeURIComponent(project), 'x-divan-client': 'pi' },
        )
      ).body,
    );
    const made = await session(out.divan?.session_id as string);
    const chair = Object.values(made.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    expect(chair.cwd?.toLowerCase()).toBe(realpathSync.native(project).toLowerCase());
    // the session keeps the folder in its settings, as a session started on the web does: that is where the chip, the settings
    // and "what the members saw" read it
    expect(made.settings.cwd?.toLowerCase()).toBe(realpathSync.native(project).toLowerCase());
    expect(seatsOf(chair).every((seat) => seat.tools)).toBe(true); // tools on for every seat that can have them
    expect(made.origin).toMatchObject({ kind: 'api', client: 'pi' });
    expect(chairmanOf(chair).input).not.toContain(project);
  });

  it('reads the folder from the system prompt when no header is sent, and drops one that is not allowed', async () => {
    const fromPrompt = readStream(
      (
        await ask([
          { role: 'system', content: `<cwd>\n${project.split('\\').join('/')}\n</cwd>` },
          { role: 'user', content: 'Folder from the system prompt?' },
        ])
      ).body,
    );
    const a = await session(fromPrompt.divan?.session_id as string);
    const chairA = Object.values(a.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    expect(chairA.cwd).toBeTruthy();

    const refused = readStream(
      (
        await ask(
          [{ role: 'user', content: 'A forbidden folder?' }],
          {},
          { 'x-divan-cwd': encodeURIComponent(process.env.SystemRoot ?? 'C:\\Windows') },
        )
      ).body,
    );
    expect(refused.reasoning).toMatch(/working folder not used/u);
    const b = await session(refused.divan?.session_id as string);
    const chairB = Object.values(b.nodes).find(
      (n): n is ChairNode => n.kind === 'chair',
    ) as ChairNode;
    expect(chairB.cwd).toBeUndefined();
    expect(b.settings.cwd).toBeUndefined();
    // the folder of the system prompt is kept in the settings too, and the next round of the conversation runs in it
    const promptSession = await session(fromPrompt.divan?.session_id as string);
    expect(promptSession.settings.cwd?.toLowerCase()).toBe(
      realpathSync.native(project).toLowerCase(),
    );
  });

  it('a conversation continued with the same folder stays in it: the settings do not change, every round has the folder', async () => {
    const first = readStream(
      (
        await ask(
          [{ role: 'user', content: 'A folder that lasts?' }],
          {},
          { 'x-divan-cwd': encodeURIComponent(project) },
        )
      ).body,
    );
    const again = readStream(
      (
        await ask(
          [
            { role: 'user', content: 'A folder that lasts?' },
            { role: 'assistant', content: first.content },
            { role: 'user', content: 'And the next step?' },
          ],
          {},
          { 'x-divan-cwd': encodeURIComponent(project) },
        )
      ).body,
    );
    expect(again.divan?.session_id).toBe(first.divan?.session_id);
    const made = await session(first.divan?.session_id as string);
    const rounds = Object.values(made.nodes).filter((n): n is ChairNode => n.kind === 'chair');
    expect(rounds.length).toBe(2);
    expect(made.settings.cwd?.toLowerCase()).toBe(realpathSync.native(project).toLowerCase());
    for (const round of rounds)
      expect(round.cwd?.toLowerCase()).toBe(realpathSync.native(project).toLowerCase());
  });
});

describe('a session from the endpoint is named by what the chairman called its question', () => {
  it('the name is the chairman’s title once the first round has it, not the first words of the question', async () => {
    const question =
      'Should I leave my stable job to start a company with two friends next spring?';
    const out = readStream((await ask([{ role: 'user', content: question }])).body);
    const made = await session(out.divan?.session_id as string);
    const root = made.nodes[made.rootId] as { title: string; text: string };
    // the chairman titled the question (the fake's title is a shorter one than the name the session started with)
    expect(root.title).not.toBe(root.text);
    expect(made.name).toBe(root.title);
    expect(made.name).not.toContain('two friends');
    const listed = (await sessions()).find((item) => item.id === made.id);
    expect(listed?.name).toBe(root.title);
    expect(listed?.title).toBe(root.title);
  });

  it('a session started on the web keeps its name: only a session of the endpoint is renamed this way', async () => {
    const view = (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === 'default',
    ) as ProfileView;
    const question = `Named by the asker's own words ${Math.random()}`;
    const reply = await call('/api/sessions', {
      headers: web(),
      body: {
        question,
        profileId: view.id,
        revision: view.revision,
        fingerprint: view.fingerprint,
      },
    });
    const made = JSON.parse(reply.body) as Session;
    const end = Date.now() + 15_000;
    for (;;) {
      const chair = Object.values((await session(made.id)).nodes).find(
        (n): n is ChairNode => n.kind === 'chair',
      ) as ChairNode;
      if (chair.status !== 'running') break;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect((await session(made.id)).name).toBe(question);
  });
});

describe('changing a profile through the web API: all of it, or none of it', () => {
  const put = (id: string, body: unknown) =>
    call(`/api/profiles/${id}`, { method: 'PUT', headers: web(), body });
  const profiles = async () =>
    (
      await api<{ settings: { profiles: { id: string; name: string; revision: number }[] } }>(
        '/meta',
      )
    ).settings.profiles;

  it('a request with a bad field changes nothing: an id with a name that is refused does not rename; an id that is not a string is bad_id', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Atomic one' });
    const before = (await profiles()).find((item) => item.id === made.id);
    const refused = await put(made.id, { id: 'atomic-new', name: '' });
    expect(refused.status).toBe(400);
    expect(JSON.parse(refused.body).error).toBe('bad_name');
    const after = await profiles();
    expect(after.find((item) => item.id === made.id)).toEqual(before);
    expect(after.find((item) => item.id === 'atomic-new')).toBeUndefined();
    // and an id that is not a string is refused with bad_id
    const made2 = await api<{ id: string }>('/profiles', 'POST', { name: 'Atomic two' });
    for (const id of [123, true, null, ['a'], { x: 1 }]) {
      const reply = await put(made2.id, { id });
      expect(reply.status, JSON.stringify(id)).toBe(400);
      expect(JSON.parse(reply.body).error).toBe('bad_id');
    }
    expect((await profiles()).some((item) => item.id === made2.id)).toBe(true);
  });

  it('an id, a name and overrides given together are applied in one write: one revision', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Atomic three' });
    const before = (await profiles()).find((item) => item.id === made.id);
    const reply = await put(made.id, {
      id: 'atomic-three-x',
      name: 'Renamed three',
      overrides: { seats: { claude: { model: 'fake-2' } } },
    });
    expect(reply.status).toBe(200);
    const after = await profiles();
    expect(after.find((item) => item.id === made.id)).toBeUndefined();
    const moved = after.find((item) => item.id === 'atomic-three-x');
    expect(moved?.name).toBe('Renamed three');
    expect(moved?.revision).toBe((before?.revision ?? 0) + 1);
  });

  it('a save is made against the revision and the settings fingerprint the writer saw: an outdated one is refused (409, with the profile as it is) and writes nothing', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Explicit save' });
    const read = async () =>
      (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
        (item) => item.id === made.id,
      ) as ProfileView;
    const seen = await read();
    const mine = { seats: { claude: { model: 'fake-2' } } };
    // another page saves first
    const first = await put(made.id, {
      overrides: mine,
      ifRevision: seen.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(first.status).toBe(200);
    // this writer still holds the old revision: refused, nothing written, the current profile comes with the refusal
    const late = await put(made.id, {
      overrides: { budgets: { maxWords: 9 } },
      ifRevision: seen.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(late.status).toBe(409);
    const refusal = JSON.parse(late.body) as { error: string; profile: ProfileView; view: unknown };
    expect(refusal.error).toBe('stale');
    expect(refusal.profile.revision).toBe(seen.revision + 1);
    expect(refusal.profile.overrides).toEqual(mine);
    expect(refusal.view).toBeDefined();
    const now = await read();
    expect(now.effective.budgets.maxWords).toBe(seen.effective.budgets.maxWords);
    // the settings in force moved (a model ran out of credit, say) though the revision did not: refused as well
    const outdated = await put(made.id, {
      overrides: {},
      ifRevision: now.revision,
      ifFingerprint: 'not-what-is-in-force',
    });
    expect(outdated.status).toBe(409);
    expect((await read()).revision).toBe(now.revision);
    // against both as they are now, it takes; a rename sends the name alone and does not touch the settings
    const saved = await put(made.id, {
      overrides: { budgets: { maxWords: 9 } },
      ifRevision: now.revision,
      ifFingerprint: now.fingerprint,
    });
    expect(saved.status).toBe(200);
    const after = await read();
    expect(after.revision).toBe(now.revision + 1);
    expect(after.effective.budgets.maxWords).toBe(9);
    await put(made.id, { name: 'Explicit saved', ifRevision: after.revision });
    expect((await read()).overrides).toEqual(after.overrides);
  });

  it('a quick profile whose chairman shares a family with a member is not offered, does not start, and says why', async () => {
    const quick = async () =>
      (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
        (item) => item.id === 'quick',
      ) as ProfileView;
    const member = (await quick()).effective.seats.find((seat) => seat.enabled) as SeatConfig;
    try {
      await put('quick', {
        overrides: { chairman: { harness: member.harness, model: member.model, effort: '' } },
      });
      expect((await quick()).blocked).toEqual(QUICK_BLOCKED);
      const listed = JSON.parse((await call('/v1/models', { headers: key() })).body) as {
        data: { id: string }[];
      };
      expect(listed.data.map((item) => item.id)).not.toContain('divan/quick');
      const refused = await ask([{ role: 'user', content: 'hi' }], {}, {}, 'divan/quick');
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).error).toMatchObject({ code: 'profile_blocked' });
      // the web API refuses a start from it too, with the reason
      const start = await call('/api/sessions', {
        headers: web(),
        body: {
          question: 'ok?',
          profileId: 'quick',
          revision: (await quick()).revision,
          fingerprint: (await quick()).fingerprint,
        },
      });
      expect(start.status).toBe(409);
      expect(JSON.parse(start.body).error).toBe('quick_blocked');
    } finally {
      await call('/api/profiles/quick', { method: 'PUT', headers: web(), body: { overrides: {} } });
    }
    expect((await quick()).blocked).toBeUndefined();
  });

  it('a session starts from the profile as it is stored at the revision the page names, not from a form it sends; a revision that has moved on is a 409', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Start from stored' });
    const read = async () =>
      (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
        (item) => item.id === made.id,
      ) as ProfileView;
    const seen = await read();
    const saved = await put(made.id, {
      overrides: { budgets: { maxWords: 33 } },
      ifRevision: seen.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(saved.status).toBe(200);
    const stored = await read();
    // a page that still holds the old revision is refused, with the current profile for its conflict screen
    const late = await call('/api/sessions', {
      headers: web(),
      body: {
        question: 'late?',
        profileId: made.id,
        revision: seen.revision,
        fingerprint: seen.fingerprint,
      },
    });
    expect(late.status).toBe(409);
    expect(JSON.parse(late.body)).toMatchObject({
      error: 'stale',
      profile: { revision: stored.revision },
    });
    expect((await sessions()).some((item) => item.question === 'late?')).toBe(false);
    // at the current revision it starts, from the stored settings (what the body says about seats is not read)
    const started = await call('/api/sessions', {
      headers: web(),
      body: {
        question: 'stored?',
        profileId: made.id,
        revision: stored.revision,
        fingerprint: stored.fingerprint,
        budgets: { maxClaims: 1, maxWords: 5 },
      },
    });
    expect(started.status).toBe(201);
    const session = JSON.parse(started.body) as Session;
    expect(session.settings.budgets.maxWords).toBe(33);
    expect(session.settings.seats).toEqual(stored.levels[stored.defaultLevel].effective.seats);
    expect(session.settings.level).toBe(stored.defaultLevel);
    // an unknown profile is a 404
    const none = await call('/api/sessions', {
      headers: web(),
      body: { question: 'x?', profileId: 'no-such-profile', revision: 1, fingerprint: 'x' },
    });
    expect(none.status).toBe(404);
    // a start without the fingerprint of what the page showed is not a start
    const bare = await call('/api/sessions', {
      headers: web(),
      body: { question: 'bare?', profileId: made.id, revision: stored.revision },
    });
    expect(bare.status).toBe(400);
  });

  it('a start is refused when the council changed behind the same revision: fake-1 went out of credit after the form showed it', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Same revision' });
    const read = async () =>
      (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
        (item) => item.id === made.id,
      ) as ProfileView;
    const modelOf = (profile: ProfileView) =>
      profile.effective.seats.find((seat) => seat.harness === 'claude')?.model;
    const seen = await read();
    expect(modelOf(seen)).toBe('fake-1');
    // the model leaves the council without any write to the profile: the revision does not move, the settings in force do
    await server.store.addUnavailable({
      harness: 'claude',
      model: 'fake-1',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '429 rate limit',
    });
    try {
      const now = await read();
      expect(now.revision).toBe(seen.revision);
      expect(modelOf(now)).not.toBe('fake-1');
      const before = (await sessions()).length;
      const start = await call('/api/sessions', {
        headers: web(),
        body: {
          question: 'which council?',
          profileId: made.id,
          revision: seen.revision,
          fingerprint: seen.fingerprint,
        },
      });
      expect(start.status).toBe(409);
      expect(JSON.parse(start.body)).toMatchObject({
        error: 'stale',
        profile: { revision: seen.revision, fingerprint: now.fingerprint },
      });
      expect((await sessions()).length).toBe(before); // nothing ran
      // with what the page shows now, it starts: and the council is the one it showed
      const again = await call('/api/sessions', {
        headers: web(),
        body: {
          question: 'which council?',
          profileId: made.id,
          revision: now.revision,
          fingerprint: now.fingerprint,
        },
      });
      expect(again.status).toBe(201);
      const session = JSON.parse(again.body) as Session;
      expect(session.settings.seats).toEqual(now.levels[now.defaultLevel].effective.seats);
    } finally {
      await server.store.addUnavailable({
        harness: 'claude',
        model: 'fake-1',
        until: new Date(Date.now() - 1000).toISOString(),
        reason: 'back',
      });
    }
  });

  it('a profile can be made with an id of its own, which must be free and plain', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', {
      name: 'تحلیل مالی',
      id: 'finance',
    });
    expect(made.id).toBe('finance');
    const taken = await call('/api/profiles', {
      method: 'POST',
      headers: web(),
      body: { name: 'Another', id: 'finance' },
    });
    expect(taken.status).toBe(409);
    const bad = await call('/api/profiles', {
      method: 'POST',
      headers: web(),
      body: { name: 'Another', id: 'Not Plain' },
    });
    expect(bad.status).toBe(400);
    expect((await profiles()).filter((item) => item.name === 'Another')).toHaveLength(0);
  });
});

describe('reasoning levels: low, medium, high, max', () => {
  const LEVELS = ['low', 'medium', 'high', 'max'] as const;
  const put = (id: string, body: unknown) =>
    call(`/api/profiles/${id}`, { method: 'PUT', headers: web(), body });
  const view = async (id: string) =>
    (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === id,
    ) as ProfileView;
  const start = (profile: ProfileView, extra: Record<string, unknown> = {}) =>
    call('/api/sessions', {
      headers: web(),
      body: {
        question: `Which level? ${Math.random()}`,
        profileId: profile.id,
        revision: profile.revision,
        fingerprint: profile.fingerprint,
        ...extra,
      },
    });

  it('every profile holds a council for each level, derived from its base council', async () => {
    const profile = await view('default');
    expect(Object.keys(profile.levels).sort()).toEqual([...LEVELS].sort());
    expect(profile.defaultLevel).toBe('medium');
    expect((await view('quick')).defaultLevel).toBe('low');
    const running = (council: { seats: SeatConfig[] }) =>
      council.seats.filter((seat) => seat.enabled);
    for (const level of LEVELS) {
      const { effective, derived, overrides, blocked } = profile.levels[level];
      // every effort is the level's (the fake models offer all four), the chairman's too
      expect(running(effective).map((seat) => seat.effort)).toEqual(
        running(effective).map(() => level),
      );
      expect(effective.chairman.effort).toBe(level);
      // with no override of the profile the level is exactly what is derived
      expect(overrides).toEqual({});
      expect(effective).toEqual(derived);
      expect(blocked).toBeUndefined();
    }
    // low drops the slowest member when more than three run; the other levels keep them all
    expect(running(profile.effective).length).toBeGreaterThan(3);
    expect(running(profile.levels.low.effective)).toHaveLength(3);
    for (const level of ['medium', 'high', 'max'] as const) {
      expect(running(profile.levels[level].effective)).toHaveLength(
        running(profile.effective).length,
      );
    }
    // a dropped member is only switched off, never removed
    expect(profile.levels.low.effective.seats).toHaveLength(profile.effective.seats.length);
  });

  it('editing the Default council, and running rounds on it, never changes Quick: only the speed of the models Quick uses does', async () => {
    const quickBefore = await view('quick');
    const councilsOf = (profile: ProfileView) => JSON.stringify(profile.levels);
    // the Default council is pinned to a very slow model for one member, and a round is run on it
    const first = await view('default');
    const pin = await put('default', {
      overrides: { seats: { pi: { model: 'fake-slow' } } },
      ifRevision: first.revision,
      ifFingerprint: first.fingerprint,
    });
    expect(pin.status).toBe(200);
    expect(councilsOf(await view('quick'))).toBe(councilsOf(quickBefore));
    const pinned = await view('default');
    const started = await start(pinned, {
      level: 'medium',
      fingerprint: pinned.levels.medium.fingerprint,
    });
    expect(started.status).toBe(201);
    const made = JSON.parse(started.body) as Session;
    for (let waited = 0; waited < 200; waited += 1) {
      const now = await session(made.id);
      if (
        !Object.values(now.nodes).some((node) => node.kind === 'chair' && node.status === 'running')
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // the slow model's seconds were measured, for the slow model; Quick (which never runs it) is the council it was
    const meta = await api<{ settings: SettingsView }>('/meta');
    expect(
      councilsOf(meta.settings.profiles.find((item) => item.id === 'quick') as ProfileView),
    ).toBe(councilsOf(quickBefore));
    // and the speed of each assistant's own default model is what the page is told Quick goes by
    expect(meta.settings.speeds.pi ?? 0).toBeLessThan(5);
    // put the Default council back as it was
    const now = await view('default');
    await put('default', {
      overrides: {},
      ifRevision: now.revision,
      ifFingerprint: now.fingerprint,
    });
  });

  it('a start is refused when a member that was pinned lost its model, though no setting moved: the council that runs is the one the page shows', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Pinned member' });
    const first = await view(made.id);
    // the writer pins the claude member to fake-1: it stays in the settings whatever happens to the model
    const pin = await put(made.id, {
      overrides: { seats: { claude: { model: 'fake-1' } } },
      ifRevision: first.revision,
      ifFingerprint: first.fingerprint,
    });
    expect(pin.status).toBe(200);
    const seen = await view(made.id);
    const claudeOf = (profile: ProfileView) =>
      profile.levels.medium.effective.seats.find((seat) => seat.harness === 'claude');
    expect(claudeOf(seen)?.model).toBe('fake-1');
    expect(seen.levels.medium.skipped).toEqual([]);
    await server.store.addUnavailable({
      harness: 'claude',
      model: 'fake-1',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '429 rate limit',
    });
    try {
      const now = await view(made.id);
      // no setting moved: the revision and the council as written are the same ...
      expect(now.revision).toBe(seen.revision);
      expect(claudeOf(now)).toEqual(claudeOf(seen));
      // ... but the member will not be asked, and the level says so
      expect(now.levels.medium.skipped).toEqual([{ id: claudeOf(now)?.id, reason: 'out' }]);
      expect(now.levels.medium.fingerprint).not.toBe(seen.levels.medium.fingerprint);
      // so the profile's own fingerprint moved with it (it covers every level's)
      expect(now.fingerprint).not.toBe(seen.fingerprint);
      const before = (await sessions()).length;
      for (const fingerprint of [seen.levels.medium.fingerprint, seen.fingerprint]) {
        const refused = await start(seen, { level: 'medium', fingerprint });
        expect(refused.status).toBe(409);
        expect(JSON.parse(refused.body)).toMatchObject({ error: 'stale' });
      }
      expect((await sessions()).length).toBe(before); // nothing ran
      // with what the page shows now it starts
      expect(
        (await start(now, { level: 'medium', fingerprint: now.levels.medium.fingerprint })).status,
      ).toBe(201);
    } finally {
      await server.store.addUnavailable({
        harness: 'claude',
        model: 'fake-1',
        until: new Date(Date.now() - 1000).toISOString(),
        reason: 'back',
      });
    }
    // it is asked again once the model is back, and that moves the fingerprint again
    const back = await view(made.id);
    expect(back.levels.medium.skipped).toEqual([]);
    expect(back.levels.medium.fingerprint).toBe(seen.levels.medium.fingerprint);
  });

  it('every execution toggle is part of the level’s fingerprint: tools, memory, web, the chairman’s memory, efforts and models', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Toggles move it' });
    const fingerprints = new Map<string, string>();
    let seen = await view(made.id);
    fingerprints.set('start', seen.levels.medium.fingerprint);
    const change = async (name: string, overrides: Record<string, unknown>, levels?: unknown) => {
      const before = seen;
      const saved = await put(made.id, {
        overrides,
        ...(levels ? { levels } : {}),
        ifRevision: before.revision,
        ifFingerprint: before.fingerprint,
      });
      expect(saved.status, name).toBe(200);
      seen = await view(made.id);
      const fingerprint = seen.levels.medium.fingerprint;
      // each change is a council the page has not shown before
      expect([...fingerprints.values()], name).not.toContain(fingerprint);
      fingerprints.set(name, fingerprint);
    };
    // (tools, memory and web start on or off by the harness's rules; each change here is away from where the seat starts)
    await change('tools', { seats: { claude: { tools: false } } });
    await change('memory', { seats: { claude: { tools: false, memory: true } } });
    await change('web', { seats: { claude: { tools: false, memory: true, web: false } } });
    // an effort is the level's own: the base council does not set it
    await change(
      'effort',
      { seats: { claude: { tools: false, memory: true, web: false } } },
      { medium: { seats: { claude: { effort: 'high' } } } },
    );
    await change(
      'model',
      { seats: { claude: { tools: false, memory: true, web: false, model: 'fake-2' } } },
      { medium: { seats: { claude: { effort: 'high' } } } },
    );
    await change(
      'chairman memory',
      {
        seats: { claude: { tools: false, memory: true, web: false, model: 'fake-2' } },
        chairman: { harness: 'claude', memory: true },
      },
      { medium: { seats: { claude: { effort: 'high' } } } },
    );
  });

  it('what a member that is off would run on does not move the fingerprint of a level where it is off', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Off member' });
    const first = await view(made.id);
    const off = await put(made.id, {
      levels: { high: { seats: { pi: { enabled: false } } } },
      ifRevision: first.revision,
      ifFingerprint: first.fingerprint,
    });
    expect(off.status).toBe(200);
    const seen = await view(made.id);
    const next = await put(made.id, {
      overrides: { seats: { pi: { model: 'fake-1' } } },
      ifRevision: seen.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(next.status).toBe(200);
    const now = await view(made.id);
    // the member is on at medium, so medium moved; at high it is off and nothing it would run on is part of the council
    expect(now.levels.medium.fingerprint).not.toBe(seen.levels.medium.fingerprint);
    expect(now.levels.high.fingerprint).toBe(seen.levels.high.fingerprint);
    expect(
      (await start(now, { level: 'high', fingerprint: now.levels.high.fingerprint })).status,
    ).toBe(201);
  });

  it('a level’s overrides are saved against the revision and fingerprint, change that level alone, and move the fingerprint', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Levels one' });
    const seen = await view(made.id);
    const patch = { high: { seats: { pi: { enabled: false } }, chairman: { effort: 'low' } } };
    const saved = await put(made.id, {
      levels: patch,
      ifRevision: seen.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(saved.status).toBe(200);
    const now = await view(made.id);
    expect(now.revision).toBe(seen.revision + 1);
    expect(now.fingerprint).not.toBe(seen.fingerprint);
    expect(now.levels.high.overrides).toEqual(patch.high);
    expect(now.levels.high.effective.seats.find((seat) => seat.id === 'pi')?.enabled).toBe(false);
    expect(now.levels.high.effective.chairman.effort).toBe('low');
    // what the level derives is untouched, and so are the other levels and the base
    expect(now.levels.high.derived).toEqual(seen.levels.high.derived);
    for (const level of ['low', 'medium', 'max'] as const) {
      expect(now.levels[level].effective).toEqual(seen.levels[level].effective);
      expect(now.levels[level].overrides).toEqual({});
    }
    expect(now.effective).toEqual(seen.effective);
    // the old fingerprint no longer takes
    const late = await put(made.id, {
      levels: {},
      ifRevision: now.revision,
      ifFingerprint: seen.fingerprint,
    });
    expect(late.status).toBe(409);
    expect((await view(made.id)).levels.high.overrides).toEqual(patch.high);
    // the same overrides again change nothing (no new revision); an empty list clears them
    await put(made.id, { levels: patch });
    expect((await view(made.id)).revision).toBe(now.revision);
    await put(made.id, { levels: {} });
    const cleared = await view(made.id);
    expect(cleared.levels.high.overrides).toEqual({});
    expect(cleared.levels.high.effective).toEqual(seen.levels.high.effective);
  });

  it('a level that does not exist, or a malformed list, is refused and writes nothing', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Levels two' });
    const seen = await view(made.id);
    for (const levels of [{ extreme: {} }, ['low'], 'high']) {
      const reply = await put(made.id, { levels });
      expect(reply.status, JSON.stringify(levels)).toBe(400);
      expect(JSON.parse(reply.body).error).toBe('bad_levels');
    }
    const badDefault = await put(made.id, { defaultLevel: 'extreme' });
    expect(badDefault.status).toBe(400);
    expect(JSON.parse(badDefault.body).error).toBe('bad_level');
    expect((await view(made.id)).revision).toBe(seen.revision);
    // the level a request that names none runs at
    expect((await put(made.id, { defaultLevel: 'high' })).status).toBe(200);
    const after = await view(made.id);
    expect(after.defaultLevel).toBe('high');
    expect(after.revision).toBe(seen.revision + 1);
  });

  it('a session starts at the level named (else the profile’s own), with that level’s council, and is locked at it', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Levels three' });
    await put(made.id, { levels: { max: { seats: { grok: { enabled: false } } } } });
    const profile = await view(made.id);
    const atMax = await start(profile, { level: 'max' });
    expect(atMax.status).toBe(201);
    const maxSession = JSON.parse(atMax.body) as Session;
    expect(maxSession.settings.level).toBe('max');
    expect(maxSession.settings.seats).toEqual(profile.levels.max.effective.seats);
    expect(maxSession.settings.seats.find((seat) => seat.id === 'grok')?.enabled).toBe(false);
    expect(maxSession.settings.chairman.effort).toBe('max');
    const byDefault = JSON.parse((await start(profile)).body) as Session;
    expect(byDefault.settings.level).toBe('medium');
    expect(byDefault.settings.seats).toEqual(profile.levels.medium.effective.seats);
    const bad = await start(profile, { level: 'extreme' });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toBe('bad_level');
  });

  it('a level that cannot run is refused alone: the others of the profile still start and are still offered', async () => {
    const quick = await view('quick');
    const member = quick.levels.max.effective.seats.find((seat) => seat.enabled) as SeatConfig;
    try {
      const saved = await put('quick', {
        levels: { max: { chairman: { harness: member.harness, model: member.model, effort: '' } } },
      });
      expect(saved.status).toBe(200);
      const now = await view('quick');
      expect(now.levels.max.blocked).toEqual(QUICK_BLOCKED);
      expect(now.levels.low.blocked).toBeUndefined();
      expect(now.blocked).toBeUndefined();
      // the web API refuses a start at that level, with the reason, and starts at another
      const refused = await start(now, { level: 'max' });
      expect(refused.status).toBe(409);
      expect(JSON.parse(refused.body).error).toBe('quick_blocked');
      expect((await start(now, { level: 'low' })).status).toBe(201);
      // so does the endpoint: it is asked at max by reasoning_effort
      const viaEndpoint = await ask(
        [{ role: 'user', content: 'Blocked at max?' }],
        { reasoning_effort: 'max' },
        {},
        'divan/quick',
      );
      expect(viaEndpoint.status).toBe(409);
      expect(JSON.parse(viaEndpoint.body).error).toMatchObject({ code: 'profile_blocked' });
      expect(
        (await ask([{ role: 'user', content: 'Fine at low?' }], {}, {}, 'divan/quick')).status,
      ).toBe(200);
      const listed = JSON.parse((await call('/v1/models', { headers: key() })).body) as {
        data: { id: string }[];
      };
      expect(listed.data.map((item) => item.id)).toContain('divan/quick');
    } finally {
      await put('quick', { levels: {} });
    }
  });

  it('/v1/models lists every profile as a reasoning model, with its levels and its default level', async () => {
    const listed = JSON.parse((await call('/v1/models', { headers: key() })).body) as {
      data: {
        id: string;
        divan: { name: string; reasoning: boolean; levels: string[]; default_level: string };
      }[];
    };
    const byId = new Map(listed.data.map((item) => [item.id, item.divan]));
    for (const model of listed.data) {
      expect(model.divan.reasoning).toBe(true);
      expect(model.divan.levels).toEqual([...LEVELS]);
    }
    expect(byId.get('divan/default')?.default_level).toBe('medium');
    expect(byId.get('divan/quick')?.default_level).toBe('low');
  });

  it('reasoning_effort picks the level: off, minimal and low are low; high and xhigh are high; nothing is the profile’s own', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ reasoning_effort: 'off' }, 'low'],
      [{ reasoning_effort: 'minimal' }, 'low'],
      [{ reasoning_effort: 'low' }, 'low'],
      [{ reasoning_effort: 'medium' }, 'medium'],
      [{ reasoning_effort: 'high' }, 'high'],
      [{ reasoning_effort: 'xhigh' }, 'high'],
      [{ reasoning_effort: 'max' }, 'max'],
      [{ reasoning: { effort: 'max' } }, 'max'],
      [{}, 'medium'],
      [{ reasoning_effort: 'something-else' }, 'medium'],
    ];
    for (const [index, [extra, level]] of cases.entries()) {
      const out = readStream(
        (await ask([{ role: 'user', content: `Which level, case ${index}?` }], extra)).body,
      );
      expect(out.error, JSON.stringify(extra)).toBeUndefined();
      const made = await session(out.divan?.session_id as string);
      expect(made.settings.level, JSON.stringify(extra)).toBe(level);
      const chair = Object.values(made.nodes).find(
        (node): node is ChairNode => node.kind === 'chair',
      ) as ChairNode;
      // the council that ran is the level’s
      expect(
        seatsOf(chair)
          .filter((seat) => seat.state === 'done')
          .every((s) => s.effort === level),
      ).toBe(true);
      expect(chairmanOf(chair).effort).toBe(level);
    }
    // a profile of its own default level is used when the client names none
    const quick = readStream(
      (await ask([{ role: 'user', content: 'Quick default level?' }], {}, {}, 'divan/quick')).body,
    );
    expect((await session(quick.divan?.session_id as string)).settings.level).toBe('low');
  }, 20_000);

  it('the level is part of the cache identity, and a conversation goes on at the level it began at', async () => {
    const Q = 'Is the cache per level?';
    const first = readStream(
      (await ask([{ role: 'user', content: Q }], { reasoning_effort: 'low' })).body,
    );
    expect(first.divan?.cached).toBe(false);
    // the same question at another level is another answer
    const high = readStream(
      (await ask([{ role: 'user', content: Q }], { reasoning_effort: 'high' })).body,
    );
    expect(high.divan?.cached).toBe(false);
    expect(high.divan?.session_id).not.toBe(first.divan?.session_id);
    // and at the first level again it is the cached one
    const again = readStream(
      (await ask([{ role: 'user', content: Q }], { reasoning_effort: 'low' })).body,
    );
    expect(again.divan).toMatchObject({ cached: true, session_id: first.divan?.session_id });
    // a follow-up at the same level continues the session; at another level it is a new session
    const followUp = async (effort: string) =>
      readStream(
        (
          await ask(
            [
              { role: 'user', content: Q },
              { role: 'assistant', content: first.content },
              { role: 'user', content: `And at ${effort}?` },
            ],
            { reasoning_effort: effort },
          )
        ).body,
      );
    const same = await followUp('low');
    expect(same.divan?.session_id).toBe(first.divan?.session_id);
    const other = await followUp('max');
    expect(other.divan?.session_id).not.toBe(first.divan?.session_id);
    expect((await session(other.divan?.session_id as string)).settings.level).toBe('max');
  });
});

describe('stopping the wait for one member, and answering the chairman’s questions', () => {
  const put = (id: string, body: unknown) =>
    call(`/api/profiles/${id}`, { method: 'PUT', headers: web(), body });
  const view = async (id: string) =>
    (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === id,
    ) as ProfileView;
  const wait = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const roundOf = async (sessionId: string, chairId: string) =>
    (await session(sessionId)).nodes[chairId] as ChairNode;
  const seatIn = (chair: ChairNode, seatId: string) =>
    seatsOf(chair).find((item) => item.seatId === seatId) as NonNullable<
      ChairNode['seats']
    >[number];

  it('POST .../skip leaves one member out while the round goes on, and refuses what it cannot skip', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Hanging one' });
    await put(made.id, { overrides: { seats: { claude: { model: 'fake-hang' } } } });
    const profile = await view(made.id);
    const started = await call('/api/sessions', {
      headers: web(),
      body: {
        question: 'Will one member be left out?',
        profileId: profile.id,
        revision: profile.revision,
        fingerprint: profile.fingerprint,
      },
    });
    expect(started.status).toBe(201);
    const created = JSON.parse(started.body) as Session;
    const chairId = Object.values(created.nodes).find((node) => node.kind === 'chair')
      ?.id as string;
    await wait(async () => {
      const chair = await roundOf(created.id, chairId);
      return seatIn(chair, 'claude').state === 'running' && seatIn(chair, 'codex').state === 'done';
    });
    const label = seatIn(await roundOf(created.id, chairId), 'claude').label;
    const skip = (body: unknown) =>
      call(`/api/sessions/${created.id}/rounds/${chairId}/skip`, { headers: web(), body });
    // a member that is not in the round, then the one that hangs
    const unknown = await skip({ label: 'nobody' });
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.body).error).toBe('bad_seat');
    // a seat id is not a label: it is named in a field of its own, and exactly one of the two is given
    const asLabel = await skip({ label: 'claude' });
    expect(asLabel.status).toBe(404);
    expect(JSON.parse(asLabel.body).error).toBe('bad_seat');
    for (const body of [
      {},
      { label, seatId: 'claude' },
      // both properties present is refused whatever the second holds
      { label, seatId: 42 },
      { label, seatId: null },
      { label: null, seatId: 'claude' },
      { label, seatId: '' },
      // and the one that is chosen must be a name
      { label: 7 },
      { label: '' },
      { label: null },
      { seatId: 7 },
      { seatId: '' },
      { seatId: ['claude'] },
    ]) {
      const refused = await skip(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(JSON.parse(refused.body).error).toBe('bad_op');
    }
    expect((await roundOf(created.id, chairId)).status).toBe('running');
    expect((await skip({ label })).status).toBe(202);
    await wait(async () => (await roundOf(created.id, chairId)).status !== 'running');
    const chair = await roundOf(created.id, chairId);
    expect(chair.status).toBe('done');
    expect(seatIn(chair, 'claude')).toMatchObject({ state: 'skipped' });
    expect(seatIn(chair, 'codex').state).toBe('done');
    // the round is over: nothing is being waited for
    const late = await skip({ label });
    expect(late.status).toBe(409);
    expect(JSON.parse(late.body).error).toBe('not_running');
    // and a round that does not exist
    const none = await call(`/api/sessions/${created.id}/rounds/no-such/skip`, {
      headers: web(),
      body: { label },
    });
    expect(none.status).toBe(404);
  });

  it('a round started with answers and a comment gives the members «Q: … / A: …» pairs, then the comment', async () => {
    const first = readStream(
      (await ask([{ role: 'user', content: 'Answers to the chairman, how?' }])).body,
    );
    const sessionId = first.divan?.session_id as string;
    const chairId = first.divan?.round_id as string;
    const body = {
      fromNodeId: chairId,
      answers: [
        { question: 'What is the monthly cost?', answer: 'About two hundred dollars.' },
        { question: 'Who maintains it?', answer: 'Nobody yet.' },
      ],
      comment: 'Please be blunt.',
    };
    const started = await call(`/api/sessions/${sessionId}/rounds`, { headers: web(), body });
    expect(started.status).toBe(202);
    const ids = JSON.parse(started.body) as { userId: string; chairId: string };
    await wait(async () => (await roundOf(sessionId, ids.chairId)).status !== 'running');
    const state = await session(sessionId);
    const chair = state.nodes[ids.chairId] as ChairNode;
    expect(chair.status).toBe('done');
    const user = state.nodes[ids.userId] as { text: string; answers?: unknown };
    expect(user.text).toBe('Please be blunt.');
    expect(user.answers).toEqual(body.answers);
    const prompt = seatsOf(chair)[0]?.prompt ?? '';
    expect(prompt).toContain(
      'Q: What is the monthly cost?\nA: About two hundred dollars.\n\nQ: Who maintains it?\nA: Nobody yet.\n\nPlease be blunt.',
    );
    // an old plain `text` is still a comment
    const plain = await call(`/api/sessions/${sessionId}/rounds`, {
      headers: web(),
      body: { fromNodeId: ids.chairId, text: 'Just a comment.' },
    });
    expect(plain.status).toBe(202);
    const plainIds = JSON.parse(plain.body) as { userId: string; chairId: string };
    await wait(async () => (await roundOf(sessionId, plainIds.chairId)).status !== 'running');
    const plainUser = (await session(sessionId)).nodes[plainIds.userId] as {
      text: string;
      answers?: unknown;
    };
    expect(plainUser.text).toBe('Just a comment.');
    expect(plainUser.answers ?? []).toEqual([]);
  });
});

describe('the context of a question and the test of the endpoint', () => {
  const profileOf = async (id = 'default') =>
    (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === id,
    ) as ProfileView;
  const startWith = async (extra: Record<string, unknown>) => {
    const profile = await profileOf();
    return call('/api/sessions', {
      headers: web(),
      body: {
        question: 'Should I move?',
        profileId: profile.id,
        revision: profile.revision,
        fingerprint: profile.fingerprint,
        ...extra,
      },
    });
  };
  const waitFor = async (check: () => Promise<boolean>, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('POST /api/sessions keeps the context on the root node, apart from the question, and every member reads it after the question', async () => {
    const made = await startWith({ context: '  I am in Berlin until March.  ' });
    expect(made.status).toBe(201);
    const created = JSON.parse(made.body) as Session;
    const root = created.nodes[created.rootId] as { text: string; context?: string };
    // trimmed, and not appended to the question
    expect(root.text).toBe('Should I move?');
    expect(root.context).toBe('I am in Berlin until March.');
    const chairId = Object.values(created.nodes).find((node) => node.kind === 'chair')
      ?.id as string;
    const chairOf = async () => (await session(created.id)).nodes[chairId] as ChairNode;
    await waitFor(async () => (await chairOf()).status !== 'running');
    const done = await chairOf();
    expect(done.status).toBe('done');
    const prompt = seatsOf(done).find((seat) => seat.prompt)?.prompt ?? '';
    expect(prompt).toContain(
      '<question>\nShould I move?\n</question>\n\n<question_context>\nI am in Berlin until March.\n</question_context>',
    );
    expect(chairmanOf(done).input).toContain('<question_context>\nI am in Berlin until March.');
    expect(done.context.map((row) => row.kind)).toEqual(['rules', 'question', 'context']);
    // the list says nothing different: the question is the question
    const listed = (await api<SessionSummary[]>('/sessions')).find(
      (item) => item.id === created.id,
    );
    expect(listed?.question).toBe('Should I move?');
  });

  it('a context that is empty is no context, one that is too long is refused with a code, and one that is not text is refused', async () => {
    const blank = JSON.parse((await startWith({ context: '   ' })).body) as Session;
    expect((blank.nodes[blank.rootId] as { context?: string }).context).toBeUndefined();
    const longest = await startWith({ context: 'x'.repeat(4000) });
    expect(longest.status).toBe(201);
    const tooLong = await startWith({ context: 'x'.repeat(4001) });
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.body)).toMatchObject({
      error: 'long_context',
      params: { max: 4000 },
      message: 'The context is too long (at most 4,000 characters).',
    });
    // whitespace around a text that fits does not count against it
    expect((await startWith({ context: `  ${'x'.repeat(4000)}  ` })).status).toBe(201);
    for (const context of [7, null, ['a'], { a: 1 }]) {
      const refused = await startWith({ context });
      expect(refused.status, JSON.stringify(context)).toBe(400);
      expect(JSON.parse(refused.body).error).toBe('bad_op');
    }
  });

  it('a start is checked against the council of its own level: the level’s fingerprint is as good as the profile’s', async () => {
    const profile = await profileOf();
    const levelFingerprints = Object.values(profile.levels).map((view) => view.fingerprint);
    expect(new Set(levelFingerprints).size).toBe(4);
    for (const view of Object.values(profile.levels))
      expect(view.fingerprint).toMatch(/^[0-9a-f]{16}$/u);
    const startWithFingerprint = (fingerprint: string, level: string) =>
      startWith({ level, fingerprint, revision: profile.revision });
    // the high level's own fingerprint starts a session at high
    const ok = await startWithFingerprint(profile.levels.high.fingerprint, 'high');
    expect(ok.status).toBe(201);
    // the profile's fingerprint still does, as it always did
    expect((await startWithFingerprint(profile.fingerprint, 'high')).status).toBe(201);
    // another level's fingerprint is not this level's council
    const other = await startWithFingerprint(profile.levels.low.fingerprint, 'high');
    expect(other.status).toBe(409);
    expect(JSON.parse(other.body).error).toBe('stale');
    // and neither is nonsense
    expect((await startWithFingerprint('0'.repeat(16), 'high')).status).toBe(409);
  });

  it('the endpoint says where the Pi extension is on this PC, as an absolute folder that exists', async () => {
    const info = (await api<{ piExtension: string }>('/endpoint')) as { piExtension: string };
    expect(isAbsolute(info.piExtension)).toBe(true);
    expect(info.piExtension.endsWith('pi-extension')).toBe(true);
    expect(existsSync(join(info.piExtension, 'package.json'))).toBe(true);
    // the same is in the meta the page reads
    const meta = await api<{ endpoint: { piExtension: string } }>('/meta');
    expect(meta.endpoint.piExtension).toBe(info.piExtension);
  });

  it('the endpoint says how T3 Code starts Divan as its own provider: node, and the absolute bin to run with acp', async () => {
    const { acp } = await api<{ acp: { command: string; args: string[] } }>('/endpoint');
    expect(acp.command).toBe(process.execPath);
    expect(acp.args[0]).toBe('--disable-warning=ExperimentalWarning');
    expect(acp.args.at(-1)).toBe('acp');
    const bin = acp.args[1] as string;
    expect(isAbsolute(bin)).toBe(true);
    expect(bin.endsWith('dio-divan.mjs')).toBe(true);
    expect(existsSync(bin)).toBe(true);
    // the same is in the meta the page reads
    const meta = await api<{ endpoint: { acp: unknown } }>('/meta');
    expect(meta.endpoint.acp).toEqual(acp);
  });

  it('POST /api/endpoint/test calls the endpoint with its key and lists the models', async () => {
    const reply = await call('/api/endpoint/test', { headers: web(), body: {} });
    expect(reply.status).toBe(200);
    const result = JSON.parse(reply.body) as { ok: boolean; baseUrl: string; models: string[] };
    expect(result.ok).toBe(true);
    expect(result.baseUrl).toBe(`http://127.0.0.1:${server.port}/v1`);
    expect(result.models).toContain('divan/default');
    // the answer never carries the key
    expect(reply.body).not.toContain(server.apiKey);
    expect((await call('/api/endpoint/test', { body: {} })).status).toBeGreaterThanOrEqual(400);
  });

  it('every refusal of the web API is a code with an English message, never Persian text', async () => {
    const samples = [
      await call('/api/sessions/no-such', { headers: web() }),
      await call('/api/profiles/no-such', { method: 'PUT', headers: web(), body: { name: 'x' } }),
      await call('/api/profiles', { headers: web(), body: { name: '' } }),
      await startWith({ level: 'extreme' }),
    ];
    for (const sample of samples) {
      expect(sample.status).toBeGreaterThanOrEqual(400);
      const body = JSON.parse(sample.body) as { error: string; message: string };
      expect(body.error).toMatch(/^[a-z_]+$/u);
      expect(body.message).not.toMatch(/\p{Script=Arabic}/u);
    }
    expect(JSON.parse(samples[0]?.body ?? '{}')).toMatchObject({
      error: 'no_session',
      message: 'Session not found.',
    });
  });
});

describe('stopping the wait for the rest, and what is gone (over HTTP)', () => {
  const seat = (id: string, harness: string, model: string, tools = false) => ({
    id,
    enabled: true,
    harness,
    model,
    effort: '',
    tools,
    memory: false,
    web: false,
  });
  const make = async (models: string[]) =>
    JSON.parse(
      (
        await call('/api/sessions', {
          headers: web(),
          body: {
            question: 'Should we raise the budget?',
            seats: models.map((model, index) => seat(`s${index}`, 'pi', model)),
            chairman: { harness: 'pi', model: 'fake-2', effort: '' },
            // an old client may still send a cap: it is ignored
            budgets: { maxClaims: 5, maxWords: 30, tokenCap: 1000 },
          },
        })
      ).body,
    ) as Session;
  const settle = async (id: string, ms = 10_000) => {
    const end = Date.now() + ms;
    for (;;) {
      const now = await session(id);
      const chairs = Object.values(now.nodes).filter(
        (node): node is ChairNode => node.kind === 'chair',
      );
      if (chairs.length > 0 && chairs.every((chair) => chair.status !== 'running')) return now;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it('there is no token cap, no estimate and no continue-in-a-new-session: those routes and fields are gone', async () => {
    const made = await make(['fake-1', 'fake-1']);
    const done = await settle(made.id);
    const round = Object.values(done.nodes).find(
      (node): node is ChairNode => node.kind === 'chair',
    ) as ChairNode;
    // a tokenCap sent by an old client is ignored: the session keeps only the limits there are
    expect(done.settings.budgets).toEqual({ maxClaims: 5, maxWords: 30 });
    for (const path of [
      '/api/estimate',
      `/api/sessions/${made.id}/estimate`,
      `/api/sessions/${made.id}/budget`,
      `/api/sessions/${made.id}/continue`,
    ]) {
      const reply = await call(path, { headers: web(), body: { fromNodeId: round.id, cap: 1 } });
      expect(reply.status, path).toBe(404);
      expect(JSON.parse(reply.body).error, path).toBe('not_found');
    }
  });

  it('POST /rounds/:id/skip-rest stops the wait for the members still working, once two have answered', async () => {
    const made = await make(['fake-1', 'fake-1', 'fake-hang']);
    const chairId =
      (await session(made.id)).rootId &&
      (Object.values((await session(made.id)).nodes).find((node) => node.kind === 'chair')
        ?.id as string);
    for (let at = 0; at < 300; at += 1) {
      const now = (await session(made.id)).nodes[chairId] as ChairNode;
      if (seatsOf(now).filter((seat) => seat.state === 'done').length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const reply = await call(`/api/sessions/${made.id}/rounds/${chairId}/skip-rest`, {
      headers: web(),
      body: {},
    });
    expect(reply.status).toBe(202);
    expect(JSON.parse(reply.body)).toEqual({ skipped: 1 });
    const done = await settle(made.id);
    const chair = done.nodes[chairId] as ChairNode;
    expect(chair.status).toBe('done');
    expect(
      seatsOf(chair)
        .map((seat) => seat.state)
        .sort(),
    ).toEqual(['done', 'done', 'skipped']);
    // a round that has ended refuses
    const late = await call(`/api/sessions/${made.id}/rounds/${chairId}/skip-rest`, {
      headers: web(),
      body: {},
    });
    expect(late.status).toBe(409);
    expect(JSON.parse(late.body).error).toBe('not_running');
  });
});

describe('the working folder of a session: every member, every round, every branch', () => {
  const view = async () =>
    (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === 'default',
    ) as ProfileView;
  const startBody = async (extra: Record<string, unknown>) => {
    const profile = await view();
    return {
      question: `Which folder? ${Math.random()}`,
      profileId: profile.id,
      revision: profile.revision,
      fingerprint: profile.fingerprint,
      ...extra,
    };
  };
  const waitDone = async (sessionId: string, chairId: string) => {
    const end = Date.now() + 15_000;
    for (;;) {
      const chair = (await session(sessionId)).nodes[chairId] as ChairNode;
      if (chair.status !== 'running') return chair;
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const firstRound = (made: Session) =>
    Object.values(made.nodes).find((node): node is ChairNode => node.kind === 'chair') as ChairNode;
  const cleanup: string[] = [];
  const folder = (name: string) => {
    const path = mkdtempSync(join(tmpdir(), `divan-folder-${name}-`));
    cleanup.push(path);
    return path;
  };
  afterAll(() => {
    for (const path of cleanup)
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('is stored in the session’s settings, and the first round runs with it', async () => {
    const project = folder('a');
    const reply = await call('/api/sessions', {
      headers: web(),
      body: await startBody({ cwd: project }),
    });
    expect(reply.status).toBe(201);
    const made = JSON.parse(reply.body) as Session;
    expect(made.settings.cwd?.toLowerCase()).toBe(realpathSync.native(project).toLowerCase());
    const first = await waitDone(made.id, firstRound(made).id);
    expect(first.cwd).toBe(made.settings.cwd);
    // the members were given the folder: tools are on for them, as for the endpoint's x-divan-cwd
    expect(seatsOf(first).every((seat) => seat.state !== 'pending')).toBe(true);
    expect(seatsOf(first).filter((seat) => seat.tools).length).toBeGreaterThan(0);
  });

  it('a later round and a branch run with the same folder, with nothing said again', async () => {
    const project = folder('b');
    const made = JSON.parse(
      (await call('/api/sessions', { headers: web(), body: await startBody({ cwd: project }) }))
        .body,
    ) as Session;
    const first = await waitDone(made.id, firstRound(made).id);
    const rounds: ChairNode[] = [];
    // a second round from the first, then another from the first again: a branch
    for (const comment of ['And the budget?', 'Or hiring instead?']) {
      const started = await call(`/api/sessions/${made.id}/rounds`, {
        headers: web(),
        body: { fromNodeId: first.id, comment },
      });
      expect(started.status).toBe(202);
      const ids = JSON.parse(started.body) as { chairId: string };
      rounds.push(await waitDone(made.id, ids.chairId));
    }
    expect(rounds.map((round) => round.cwd)).toEqual([made.settings.cwd, made.settings.cwd]);
    expect(rounds[0]?.parentId).not.toBe(rounds[1]?.parentId);
  });

  it('no folder is no folder: the settings hold none and no round has one', async () => {
    const made = JSON.parse(
      (await call('/api/sessions', { headers: web(), body: await startBody({}) })).body,
    ) as Session;
    expect(made.settings.cwd).toBeUndefined();
    expect((await waitDone(made.id, firstRound(made).id)).cwd).toBeUndefined();
  });

  it('a folder that cannot be used is refused with the reason, before anything starts', async () => {
    const before = (await sessions()).length;
    const driveRoot = parse(process.cwd()).root;
    // Divan's own home (the one every test file is given by tests/setup.ts), and a folder inside it
    const divanHome = process.env.DIVAN_HOME as string;
    const divanSub = join(divanHome, 'sub');
    mkdirSync(divanSub, { recursive: true });
    const cases: [unknown, RegExp][] = [
      [join(tmpdir(), 'divan-no-such-folder-0123'), /does not exist/u],
      ['relative/folder', /absolute/u],
      [driveRoot, /drive root/u],
      [divanHome, /keeps from the council/u],
      [divanSub, /keeps from the council/u],
      [7, /empty/u],
    ];
    for (const [cwd, reason] of cases) {
      const reply = await call('/api/sessions', { headers: web(), body: await startBody({ cwd }) });
      expect(reply.status, String(cwd)).toBe(400);
      const body = JSON.parse(reply.body) as {
        error: string;
        params?: { reason?: string };
        message: string;
      };
      expect(body.error, String(cwd)).toBe('bad_cwd');
      expect(body.message, String(cwd)).toMatch(reason);
    }
    expect((await sessions()).length).toBe(before);
    // an empty one is no folder
    const empty = await call('/api/sessions', {
      headers: web(),
      body: await startBody({ cwd: '' }),
    });
    expect(empty.status).toBe(201);
    expect(JSON.parse(empty.body).settings.cwd).toBeUndefined();
  });

  it('the recent folders: newest first, once each, only those that still exist, at most eight', async () => {
    const one = folder('r1');
    const two = folder('r2');
    for (const path of [one, two, one]) {
      await call('/api/sessions', { headers: web(), body: await startBody({ cwd: path }) });
    }
    let recent = (await api<{ recentFolders: string[] }>('/meta')).recentFolders;
    expect(recent.slice(0, 2).map((path) => path.toLowerCase())).toEqual(
      [one, two].map((path) => realpathSync.native(path).toLowerCase()),
    );
    expect(new Set(recent.map((path) => path.toLowerCase())).size).toBe(recent.length);
    // a folder that is gone drops out of the list
    const twoReal = realpathSync.native(two).toLowerCase();
    rmSync(two, { recursive: true, force: true });
    recent = (await api<{ recentFolders: string[] }>('/meta')).recentFolders;
    expect(recent.map((path) => path.toLowerCase())).not.toContain(twoReal);
    expect(recent.length).toBeLessThanOrEqual(8);
    for (let i = 0; i < 10; i += 1) {
      await call('/api/sessions', {
        headers: web(),
        body: await startBody({ cwd: folder(`many${i}`) }),
      });
    }
    expect(
      (await api<{ recentFolders: string[] }>('/meta')).recentFolders.length,
    ).toBeLessThanOrEqual(8);
  }, 120_000);
});

describe('lens modes at the API: lensMode on a new session', () => {
  const view = async () =>
    (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
      (item) => item.id === 'default',
    ) as ProfileView;
  const startBody = async (extra: Record<string, unknown>) => {
    const profile = await view();
    return {
      question: `Which lens? ${Math.random()}`,
      profileId: profile.id,
      revision: profile.revision,
      fingerprint: profile.fingerprint,
      ...extra,
    };
  };
  const waitDone = async (sessionId: string) => {
    const end = Date.now() + 20_000;
    for (;;) {
      const made = await session(sessionId);
      const chair = Object.values(made.nodes).find((n): n is ChairNode => n.kind === 'chair');
      if (chair && chair.status !== 'running') return { made, chair };
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  it('off is the default, and "off" says it too: nothing is stored, no planner runs', async () => {
    for (const extra of [{}, { lensMode: 'off' }]) {
      const reply = await call('/api/sessions', { headers: web(), body: await startBody(extra) });
      expect(reply.status).toBe(201);
      const { made, chair } = await waitDone((JSON.parse(reply.body) as Session).id);
      expect(made.settings.lensMode).toBeUndefined();
      expect(chair.lensMode).toBeUndefined();
      expect(chair.lensPlan).toBeUndefined();
      expect(chair.attempts.some((a) => a.kind === 'planner')).toBe(false);
    }
  });

  it('angle and only are kept in the session’s settings, and the round records its lenses', async () => {
    for (const mode of ['angle', 'only'] as const) {
      const reply = await call('/api/sessions', {
        headers: web(),
        body: await startBody({ lensMode: mode }),
      });
      expect(reply.status).toBe(201);
      const created = JSON.parse(reply.body) as Session;
      expect(created.settings.lensMode).toBe(mode);
      const { made, chair } = await waitDone(created.id);
      expect(made.settings.lensMode).toBe(mode);
      expect(chair.status).toBe('done');
      expect(chair.lensMode).toBe(mode);
      const members = seatsOf(chair).length;
      expect(chair.lensPlan?.requested).toBe(mode === 'angle' ? members - 1 : members);
      expect(chair.lensPlan?.lenses).toHaveLength(chair.lensPlan?.requested ?? -1);
      const anchors = seatsOf(chair).filter((s) => s.lens === 'anchor');
      expect(anchors).toHaveLength(mode === 'angle' ? 1 : 0);
      expect(seatsOf(chair).filter((s) => s.lens && s.lens !== 'anchor')).toHaveLength(
        mode === 'angle' ? members - 1 : members,
      );
      expect(chair.usage.planner).toBeGreaterThan(0);
      expect(made.settings.chairmanRules).toMatch(/Lenses \(this session gave each member/u);
    }
  });

  it('a word that is not a mode is 400 bad_lens_mode; no session is made', async () => {
    const before = (await sessions()).length;
    for (const bad of ['Angle', 'both', 3, null, true, ['angle']]) {
      const reply = await call('/api/sessions', {
        headers: web(),
        body: await startBody({ lensMode: bad }),
      });
      expect(reply.status, JSON.stringify(bad)).toBe(400);
      expect(JSON.parse(reply.body).error).toBe('bad_lens_mode');
    }
    expect((await sessions()).length).toBe(before);
  });
});

describe('flow profiles and templates', () => {
  it('rejects incompatible output contracts atomically and persists position-only saves without changing execution identity', async () => {
    const made = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
      name: 'Flow regression',
      template: 'writer-critics',
    });
    let profile = requireValue(made.view.profiles.find((item) => item.id === made.id));
    const save = (body: unknown) =>
      call(`/api/profiles/${made.id}`, { method: 'PUT', headers: web(), body });
    for (const damage of [
      (agent: import('../src/shared/flow.ts').FlowAgent) => {
        agent.form = 'missing-form';
      },
      (agent: import('../src/shared/flow.ts').FlowAgent) => {
        agent.prompt = 'missing-prompt';
      },
      (agent: import('../src/shared/flow.ts').FlowAgent) => {
        agent.form = 'report';
      },
    ]) {
      const flow = writerFlow();
      damage(requireValue(agentsOf(flow).find((agent) => agent.form === 'answer')));
      const refused = await save({ flow, name: 'Must not stick' });
      expect(refused.status).toBe(400);
      expect(JSON.parse(refused.body).error).toBe('bad_flow');
      expect(
        requireValue(
          (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
            (item) => item.id === made.id,
          ),
        ),
      ).toEqual(profile);
    }
    const flow = structuredClone(requireValue(profile.effective.flow));
    requireValue(agentsOf(flow)[0]).position = { x: 400, y: 250 };
    const before = profile;
    const saved = await save({
      flow,
      ifRevision: before.revision,
      ifFingerprint: before.fingerprint,
    });
    expect(saved.status).toBe(200);
    profile = requireValue(
      (JSON.parse(saved.body) as SettingsView).profiles.find((item) => item.id === made.id),
    );
    expect(agentsOf(requireValue(profile.effective.flow))[0]?.position).toEqual({ x: 400, y: 250 });
    expect(identityOf(profile, [])).toBe(identityOf(before, []));
    expect(profile.levels.medium.fingerprint).toBe(before.levels.medium.fingerprint);
    expect(profile.revision).toBe(before.revision + 1);
    expect(
      (
        await save({
          flow: before.effective.flow,
          ifRevision: before.revision,
          ifFingerprint: before.fingerprint,
        })
      ).status,
    ).toBe(409);
    expect(server.store.readSettings().profiles[made.id]?.flow).toEqual(storedFlow(flow));
  });
  it('creates both layouts, saves a flow and its node levels atomically, and refuses invalid and stale saves', async () => {
    const templates = await api<{ id: string; name: { code: string } }[]>('/flow-templates');
    expect(templates.map((item) => item.id)).toEqual(['council', 'writer-critics', 'single']);
    expect(templates.every((item) => item.name.code.startsWith('flow_template_'))).toBe(true);
    const single = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
      name: 'One assistant',
      template: 'single',
    });
    const singleProfile = requireValue(
      single.view.profiles.find((profile) => profile.id === single.id),
    );
    expect(singleProfile.effective.flow?.nodes).toHaveLength(3);
    const first = requireValue(
      single.view.profiles[0]?.effective.seats.find((seat) => seat.enabled),
    );
    const only = requireValue(agentsOf(requireValue(singleProfile.effective.flow))[0]);
    expect(only).toMatchObject({
      harness: first.harness,
      model: first.model,
      effort: first.effort,
      tools: first.tools,
      memory: first.memory,
      web: false,
    });
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      expect(singleProfile.levels[level].blocked).toBeFalsy();
      expect(agentsOf(requireValue(singleProfile.levels[level].effective.flow))).toHaveLength(1);
      expect(agentsOf(requireValue(singleProfile.levels[level].effective.flow))[0]).toMatchObject({
        effort: level,
      });
    }
    const council = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
      name: 'Council template',
      template: 'council',
    });
    expect(
      council.view.profiles.find((profile) => profile.id === council.id)?.effective.flow,
    ).toBeUndefined();
    const made = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
      name: 'Flow template',
      template: 'writer-critics',
    });
    let profile = requireValue(made.view.profiles.find((profile) => profile.id === made.id));
    expect(
      agentsOf(requireValue(profile.effective.flow)).filter((agent) => agent.role === 'critic')
        .length,
    ).toBeGreaterThanOrEqual(2);
    const flow = writerFlow();
    const save = (body: unknown) =>
      call(`/api/profiles/${made.id}`, { method: 'PUT', headers: web(), body });
    const accepted = await save({
      flow,
      name: 'Saved flow',
      levels: { high: { nodes: { writer: { model: 'fake-2' }, critic3: { enabled: false } } } },
      defaultLevel: 'high',
      ifRevision: profile.revision,
      ifFingerprint: profile.fingerprint,
    });
    expect(accepted.status).toBe(200);
    const saved = requireValue(
      (JSON.parse(accepted.body) as SettingsView).profiles.find((item) => item.id === made.id),
    );
    expect(saved.revision).toBe(profile.revision + 1);
    expect(
      agentsOf(requireValue(saved.levels.high.effective.flow)).find(
        (agent) => agent.id === 'writer',
      ),
    ).toMatchObject({ model: 'fake-2', effort: 'high' });
    expect(agentsOf(requireValue(saved.levels.low.effective.flow))).toHaveLength(5);
    expect(
      (
        await save({
          flow,
          name: 'Stale change',
          ifRevision: profile.revision,
          ifFingerprint: profile.fingerprint,
        })
      ).status,
    ).toBe(409);
    const cycle = writerFlow();
    cycle.edges.push({ from: 'rewriter', to: 'writer', anonymous: false });
    const disabled = writerFlow();
    requireValue(agentsOf(disabled).find((agent) => agent.id === 'writer')).enabled = false;
    const schema = writerFlow();
    requireValue(agentsOf(schema)[0]).form = 'unknown';
    for (const body of [
      { flow: {} },
      { flow: cycle },
      { flow: disabled },
      { flow: schema },
      { levels: { high: { nodes: { missing: { model: 'fake-1' } } } } },
      { levels: { low: { nodes: { critic1: { enabled: false }, critic2: { enabled: false } } } } },
    ]) {
      expect((await save({ ...body, name: 'Must not be saved' })).status).toBe(400);
      profile = requireValue(
        (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
          (item) => item.id === made.id,
        ),
      );
      expect(profile.revision).toBe(saved.revision);
      expect(profile.name).toBe('Saved flow');
    }
    const copied = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
      name: 'Copied flow',
      from: made.id,
    });
    expect(copied.view.profiles.find((item) => item.id === copied.id)?.effective.flow).toEqual(
      saved.effective.flow,
    );
    const listed = JSON.parse((await call('/v1/models', { headers: key() })).body).data;
    expect(
      listed.find((item: { id: string }) => item.id === `divan/${made.id}`).divan,
    ).toMatchObject({
      reasoning: true,
      default_level: 'high',
      levels: ['low', 'medium', 'high', 'max'],
    });
    const start = await call('/api/sessions', {
      headers: web(),
      body: {
        question: 'A flow in the web client',
        profileId: made.id,
        revision: saved.revision,
        fingerprint: saved.fingerprint,
        lensMode: 'angle',
      },
    });
    expect(start.status).toBe(400);
    expect(JSON.parse(start.body).error).toBe('flow_lenses');
    await save({ flow: null, levels: {} });
    expect(
      (await api<{ settings: SettingsView }>('/meta')).settings.profiles.find(
        (item) => item.id === made.id,
      )?.effective.flow,
    ).toBeUndefined();
  }, 20_000);

  it('runs custom node levels through /v1 and the web, with private step progress and total usage', async () => {
    const made = await api<{ id: string }>('/profiles', 'POST', { name: 'Client flow' });
    const updated = await api<SettingsView>(`/profiles/${made.id}`, 'PUT', {
      flow: writerFlow(),
      levels: { low: { nodes: { critic3: { enabled: false } } } },
    });
    const profile = requireValue(updated.profiles.find((item) => item.id === made.id));
    const out = readStream(
      (
        await ask(
          [{ role: 'user', content: 'Flow output across clients' }],
          { reasoning_effort: 'low' },
          {},
          `divan/${made.id}`,
        )
      ).body,
    );
    expect(out.done).toBe(true);
    const ran = await session(requireValue(out.divan).session_id);
    const chair = ran.nodes[requireValue(out.divan).round_id] as ChairNode;
    expect(ran.settings.flow).toEqual(profile.levels.low.effective.flow);
    expect(chair.steps).toHaveLength(5);
    expect(requireValue(chair.steps).find((step) => step.id === 'critic3')?.run.state).toBe(
      'skipped',
    );
    expect(out.reasoning).toContain('Writer started.');
    expect(out.reasoning).toContain('Rewriter is reading 2 responses.');
    expect(out.reasoning).not.toMatch(/Member [A-Z]|Critic [A-Z]|stance|Option|Findings/u);
    expect(requireValue(out.usage).total_tokens).toBe(
      chair.attempts.reduce((sum, call) => sum + (call.usage?.total ?? 0), 0),
    );
    const webMade = await api<Session>('/sessions', 'POST', {
      question: 'Web flow',
      profileId: made.id,
      revision: profile.revision,
      fingerprint: profile.levels.high.fingerprint,
      level: 'high',
    });
    expect(webMade.settings.flow).toEqual(profile.levels.high.effective.flow);
    expect(webMade.origin).toMatchObject({ profileId: made.id, profileLevel: 'high' });
  });
});

describe('first-run readiness shared by the web and client entrances', () => {
  it('no discovered assistant has one reason in the web, v1 and ACP thread envelopes; Single gives a coded conflict', async () => {
    const baseline = (await api<{ settings: SettingsView }>('/meta')).settings;
    process.env.DIVAN_FAKE_DETECTION = JSON.stringify({
      status: baseline.status.map((item) => ({
        ...item,
        installed: false,
        usable: false,
        note: null,
      })),
      models: [],
      detectedAt: '',
    });
    try {
      const view = await api<SettingsView>('/detect', 'POST');
      const profile = view.profiles.find((item) => item.id === 'default') as ProfileView;
      expect(profile.levels.medium.blocked?.code).toBe('no_assistant');
      const fromWeb = await call('/api/sessions', {
        headers: web(),
        body: {
          profileId: 'default',
          level: 'medium',
          question: 'Do not send this',
          revision: profile.revision,
          fingerprint: profile.levels.medium.fingerprint,
        },
      });
      expect(fromWeb.status).toBe(409);
      expect(JSON.parse(fromWeb.body).error).toBe('no_assistant');
      for (const [path, body] of [
        [
          '/v1/chat/completions',
          { model: 'divan/default', messages: [{ role: 'user', content: 'Do not send this' }] },
        ],
        [
          '/v1/divan/threads/first_run_boundary/turns',
          { profile: 'default', text: 'Do not send this' },
        ],
      ] as const) {
        const reply = await call(path, { headers: key(), body });
        expect(reply.status).toBe(409);
        const error = JSON.parse(reply.body).error;
        expect(error.code).toBe('profile_blocked');
        expect(error.message).toBe(profile.levels.medium.blocked?.message);
      }
      const single = await call('/api/profiles', {
        headers: web(),
        body: { name: 'Unavailable single', template: 'single' },
      });
      expect(single.status).toBe(409);
      expect(JSON.parse(single.body).error).toBe('no_assistant');
    } finally {
      delete process.env.DIVAN_FAKE_DETECTION;
      await api('/detect', 'POST');
    }
  });
});
