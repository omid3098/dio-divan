import { agentsOf, canonicalFlow, chairmanOf, seatsOf } from '../src/shared/flow.ts';
import { writerFlow } from './fixtures/flows.ts';
import { requireValue } from './fixtures.ts';
// The threads of a client that keeps its own conversation (T3 Code through its ACP bridge): `/v1/divan/threads/:id` and its turns,
// through a real server with the fake harnesses. The guard, the stream of a turn (the checklist, the answer and its closing line),
// the mapping onto Divan's tree (a turn goes on from the tip, a level change starts a new session with the conversation as its
// background, a fork becomes a branch), the folder that is refused, a client that leaves, the "continue" button, and the pure parts.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateCwd } from '../src/server/cwd.ts';
import {
  durationText,
  heartbeatOf,
  planOf,
  progressOf,
  tokensText,
} from '../src/server/divan-api.ts';
import { EngineError } from '../src/server/engine.ts';
import { type RunningServer, startServer } from '../src/server/server.ts';
import { Store, type ThreadRecord } from '../src/server/store.ts';
import {
  conversationUpTo,
  keepEnd,
  planTurn,
  SETTLE_MS,
  standing,
  Threads,
  withThread,
  withTip,
} from '../src/server/threads.ts';
import { CONTINUE_TEXT } from '../src/shared/acp-text.ts';
import { HARNESS_LABEL } from '../src/shared/defaults.ts';
import { SKIPPED_BY_USER, SKIPPED_SAME_FAMILY } from '../src/shared/failure.ts';
import { estimateTokens } from '../src/shared/text.ts';
import type { ChairNode, ProfileView, SeatRun, Session } from '../src/shared/types.ts';

let server: RunningServer;
let home: string;
let webRoot: string;
let project: string;

beforeAll(async () => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
  home = mkdtempSync(join(tmpdir(), 'divan-threads-'));
  webRoot = mkdtempSync(join(tmpdir(), 'divan-threadsweb-'));
  project = mkdtempSync(join(tmpdir(), 'divan-threadsproj-'));
  server = await startServer({ port: 0, home, webRoot });
});
afterAll(async () => {
  await server.close();
  for (const dir of [home, webRoot, project])
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface DivanEvent {
  type: string;
  [key: string]: unknown;
}

interface Step {
  content: string;
  status: string;
}

const key = () => ({ authorization: `Bearer ${server.apiKey}` });
const web = () => ({ 'x-divan-token': server.token });

/** One request to the server; the body of the reply is kept whole. */
function call(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    const text = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? (text === undefined ? 'GET' : 'POST'),
        headers: {
          host: `127.0.0.1:${server.port}`,
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
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            type: String(res.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

const eventsOf = (body: string): DivanEvent[] =>
  body
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as DivanEvent);

let counter = 0;
const newThread = (name: string) => {
  counter += 1;
  return `${name}-${Date.now().toString(36)}-${counter}`;
};

const turnBody = (text: string, extra: Record<string, unknown> = {}) => ({
  profile: 'd1-default',
  level: 'low',
  text,
  ...extra,
});

/** A turn, run to its end: the status, the events and the raw body. */
async function turn(
  thread: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = { 'x-divan-client': 't3-code' },
) {
  const reply = await call(`/v1/divan/threads/${thread}/turns`, {
    headers: { ...key(), ...headers },
    body,
  });
  return { ...reply, events: reply.status === 200 ? eventsOf(reply.body) : [] };
}

/** A turn that is left open: its events as they arrive, a way to wait for one, and a way to hang up. */
function openTurn(thread: string, body: Record<string, unknown>) {
  const events: DivanEvent[] = [];
  let pending = '';
  let req: ReturnType<typeof request> | undefined;
  const ended = new Promise<void>((resolve) => {
    req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: `/v1/divan/threads/${thread}/turns`,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${server.port}`,
          'content-type': 'application/json',
          'x-divan-client': 't3-code',
          ...key(),
        },
      },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() as string;
          for (const line of lines) if (line.trim()) events.push(JSON.parse(line) as DivanEvent);
        });
        res.on('end', () => resolve());
        res.on('close', () => resolve());
      },
    );
    req.on('error', () => resolve());
    req.end(JSON.stringify(body));
  });
  return {
    events,
    ended,
    hangUp: () => req?.destroy(),
    async event(type: string): Promise<DivanEvent> {
      await until(async () => events.some((event) => event.type === type));
      return events.find((event) => event.type === type) as DivanEvent;
    },
  };
}

async function until(check: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const thread = (id: string) => call(`/v1/divan/threads/${id}`, { headers: key() });
const session = (id: string): Session => server.store.get(id) as Session;
const chairs = (id: string): ChairNode[] =>
  Object.values(session(id).nodes).filter((node): node is ChairNode => node.kind === 'chair');
const answerOf = (events: DivanEvent[]) =>
  events.find((event) => event.type === 'answer') as DivanEvent;
const planOfEvent = (event: DivanEvent | undefined) => (event?.plan ?? []) as Step[];

/** A profile of our own whose seats run these models (the others keep theirs). */
async function profileWith(name: string, models: Record<string, string>): Promise<string> {
  const made = JSON.parse(
    (await call('/api/profiles', { headers: web(), body: { name } })).body,
  ) as { id: string };
  const seats = Object.fromEntries(
    Object.entries(models).map(([harness, model]) => [harness, { model }]),
  );
  const saved = await call(`/api/profiles/${made.id}`, {
    method: 'PUT',
    headers: web(),
    body: { overrides: { seats } },
  });
  expect(saved.status).toBe(200);
  return made.id;
}

describe('the guard and the validation', () => {
  it('needs the API key and refuses a browser, like /v1', async () => {
    const id = newThread('guard');
    expect((await call(`/v1/divan/threads/${id}`)).status).toBe(401);
    expect((await call(`/v1/divan/threads/${id}/turns`, { body: turnBody('hi') })).status).toBe(
      401,
    );
    const browser = await call(`/v1/divan/threads/${id}`, {
      headers: { ...key(), origin: 'https://evil.example' },
    });
    expect(browser.status).toBe(403);
    expect(JSON.parse(browser.body).error.code).toBe('browser_request');
    const browserPost = await call(`/v1/divan/threads/${id}/turns`, {
      headers: { ...key(), 'sec-fetch-site': 'cross-site' },
      body: turnBody('hi'),
    });
    expect(browserPost.status).toBe(403);
    // the web API's token does not open it
    expect((await call(`/v1/divan/threads/${id}`, { headers: web() })).status).toBe(401);
  });

  it('answers errors before the stream in the OpenAI shape', async () => {
    const id = newThread('errors');
    const shape = (reply: { body: string }) => JSON.parse(reply.body).error as { code: string };
    expect(shape(await thread('short')).code).toBe('bad_thread');
    expect(shape(await thread('__proto__')).code).toBe('bad_thread');
    const badId = await call('/v1/divan/threads/short/turns', {
      headers: key(),
      body: turnBody('hi'),
    });
    expect(badId.status).toBe(400);
    expect(shape(badId).code).toBe('bad_thread');
    const unknown = await thread(id);
    expect(unknown.status).toBe(404);
    expect(shape(unknown).code).toBe('no_thread');
    expect((await call('/v1/divan/nothing', { headers: key() })).status).toBe(404);

    const refused = async (body: unknown, status: number, code: string) => {
      const reply = await call(`/v1/divan/threads/${id}/turns`, { headers: key(), body });
      expect(reply.status, JSON.stringify(body)).toBe(status);
      expect(shape(reply).code, JSON.stringify(body)).toBe(code);
    };
    await refused(turnBody('hi', { profile: 'd1-nope' }), 404, 'model_not_found');
    await refused(turnBody('   '), 400, 'empty_message');
    await refused(turnBody(7 as never), 400, 'bad_request');
    await refused({ text: 'hi', level: 'low' }, 400, 'bad_request');
    await refused(turnBody('hi', { from: { sessionId: 3 } }), 400, 'bad_request');
    await refused(turnBody('hi', { cwd: 5 }), 400, 'bad_request');
    // nothing was written for any of them
    expect((await thread(id)).status).toBe(404);
  });

  it('refuses a level that is blocked, with the reason', async () => {
    const meta = JSON.parse((await call('/api/meta', { headers: web() })).body) as {
      settings: { profiles: ProfileView[] };
    };
    const quick = meta.settings.profiles.find((item) => item.id === 'quick') as ProfileView;
    const member = quick.levels.max.effective.seats.find((seat) => seat.enabled);
    const saved = await call('/api/profiles/quick', {
      method: 'PUT',
      headers: web(),
      body: {
        levels: {
          max: { chairman: { harness: member?.harness, model: member?.model, effort: '' } },
        },
      },
    });
    expect(saved.status).toBe(200);
    const refused = await call(`/v1/divan/threads/${newThread('blocked')}/turns`, {
      headers: key(),
      body: turnBody('Blocked?', { profile: 'd1-quick', level: 'max' }),
    });
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body).error.code).toBe('profile_blocked');
  });
});

describe('a conversation of one thread', () => {
  const id = newThread('talk');
  const first = 'Should I rent or buy a flat in Berlin?';
  let firstEvents: DivanEvent[] = [];
  let tip = '';

  it('the first turn makes a session of the client, with a checklist that names the members and never letters', async () => {
    const reply = await turn(id, turnBody(first, { cwd: project }));
    expect(reply.status).toBe(200);
    expect(reply.type).toMatch(/^application\/x-ndjson/u);
    firstEvents = reply.events;
    const types = firstEvents.map((event) => event.type);
    expect(types[0]).toBe('round');
    expect(types.at(-1)).toBe('answer');
    expect(types.slice(1, -1).every((type) => type === 'plan' || type === 'progress')).toBe(true);

    // the checklist: a step per member, then the chairman; no letters, no member's words; ticked off one by one at the end
    const opened = planOfEvent(firstEvents[0]);
    expect(opened.length).toBeGreaterThanOrEqual(3);
    expect(opened.at(-1)?.content).toMatch(/^Chairman · /u);
    // each step names the assistant, its model and the reasoning level the round asked of it ("low" was asked here)
    for (const step of opened.slice(0, -1)) {
      expect(step.content).toMatch(/^(Claude Code|Codex|Grok|Pi) · \S+ · low$/u);
    }
    expect(opened.at(-1)?.content).toMatch(/^Chairman · (Claude Code|Codex|Grok|Pi) · \S+ · low$/u);
    expect(opened.every((step) => ['pending', 'in_progress'].includes(step.status))).toBe(true);
    const everyStep = firstEvents.flatMap((event) => planOfEvent(event));
    for (const step of everyStep) {
      expect(Object.keys(step).sort()).toEqual(['content', 'status']);
      expect(step.content).not.toMatch(/(^|[\s·])[A-E]($|[\s·—])/u);
      expect(step.content).not.toMatch(/Member|stance|recommend/iu);
    }
    const lastPlan = planOfEvent(firstEvents.filter((event) => event.type === 'plan').at(-1));
    expect(lastPlan.map((step) => step.content)).toEqual(opened.map((step) => step.content));
    expect(lastPlan.every((step) => step.status === 'completed')).toBe(true);
    // each plan event differs from the one before it (a sign of work changes nothing on the checklist)
    const plans = firstEvents
      .filter((event) => event.type === 'round' || event.type === 'plan')
      .map((e) => JSON.stringify(e.plan));
    expect(new Set(plans).size).toBe(plans.length);

    const answer = answerOf(firstEvents);
    tip = answer.chairId as string;
    // the closing line: a link to the round, alone on the last line, that carries the round's name in its address
    expect(String(answer.content)).toMatch(
      new RegExp(
        `\\n\\n\\[Open in Divan\\]\\(http://127\\.0\\.0\\.1:${server.port}/open/[\\w-]+\\?round=${answer.sessionId}\\.${answer.chairId}\\)$`,
        'u',
      ),
    );
    expect((answer.usage as { round: number }).round).toBeGreaterThan(0);
    expect((answer.usage as { session: number }).session).toBe(
      (answer.usage as { round: number }).round,
    );
    expect(firstEvents[0]).toMatchObject({ sessionId: answer.sessionId, chairId: answer.chairId });

    const made = session(answer.sessionId as string);
    expect(made.origin).toMatchObject({
      kind: 'api',
      client: 't3-code',
      profileId: 'default',
      profileLevel: 'low',
    });
    expect(made.settings.level).toBe('low');
    expect(made.settings.question).toBe(first);
    expect(made.settings.cwd?.toLowerCase()).toBe(
      (validateCwd(project) as { path: string }).path.toLowerCase(),
    );
    expect(chairs(made.id)).toHaveLength(1);
    expect(chairs(made.id)[0]?.status).toBe('done');
  });

  it('reports the round line by line, in English, naming the assistants and never a letter or a word of a member', () => {
    const answer = answerOf(firstEvents);
    const round = chairs(answer.sessionId as string)[0] as ChairNode;
    const reports = firstEvents.filter((event) => event.type === 'progress');
    for (const event of reports) expect(Object.keys(event).sort()).toEqual(['text', 'type']);
    const lines = reports.map((event) => String(event.text));

    // a line for each member that answered, with the time it took; the step's name without the level
    const members = seatsOf(round).filter((seat) => seat.state === 'done');
    expect(members.length).toBeGreaterThanOrEqual(2);
    for (const seat of members) {
      const name = `${HARNESS_LABEL[seat.harness]} · ${seat.model}`;
      const own = lines.filter((line) => line.startsWith(`${name} `));
      expect(own, name).toHaveLength(1);
      expect(own[0]).toMatch(/^.+ answered after \d+(?:s|m(?: \d+s)?)\.$/u);
    }
    // then the chairman, once every member is in, with its level
    const run = chairmanOf(round);
    const chairmanLine = `All members are in. The chairman (${HARNESS_LABEL[run.harness]} · ${run.model} · ${run.effort}) is reading ${members.length} answers.`;
    expect(lines.filter((line) => line.startsWith('All members are in'))).toEqual([chairmanLine]);
    const memberLines = lines.filter((line) => / answered after /u.test(line));
    expect(memberLines).toHaveLength(members.length);
    expect(lines.indexOf(chairmanLine)).toBeGreaterThan(
      Math.max(...memberLines.map((line) => lines.indexOf(line))),
    );

    // the round's own events come in their order: admitted first, answered last, the report between
    const types = firstEvents.map((event) => event.type);
    expect(types[0]).toBe('round');
    expect(types.at(-1)).toBe('answer');
    expect(types.filter((type) => type === 'progress')).toHaveLength(lines.length);
    // no letter, no stance, no word of a member in any line
    for (const line of lines) {
      expect(line).not.toMatch(/(^|[\s·(])[A-E]($|[\s·).,:])/u);
      expect(line).not.toMatch(/\bMember\b|stance/iu);
      for (const seat of seatsOf(round)) {
        const stance = seat.sanitized?.stance ?? '';
        expect(stance.length).toBeGreaterThan(5);
        expect(line).not.toContain(stance);
      }
    }
    // a quick round has no heartbeat (the first comes a minute in) and no line of the other kinds
    expect(lines.every((line) => !line.startsWith('Working for'))).toBe(true);
  });

  it('shows the tip of the thread once the answer was delivered', async () => {
    const reply = await thread(id);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toEqual({
      id,
      sessionId: answerOf(firstEvents).sessionId,
      chairId: tip,
      profileId: 'default',
      level: 'low',
      cwd: (validateCwd(project) as { path: string }).path,
    });
  });

  it('goes on from the tip in the same session, with the same profile and level', async () => {
    const reply = await turn(id, turnBody('And if the rates fall next year?'));
    const answer = answerOf(reply.events);
    expect(answer.sessionId).toBe(answerOf(firstEvents).sessionId);
    expect(answer.chairId).not.toBe(tip);
    const rounds = chairs(answer.sessionId as string);
    expect(rounds).toHaveLength(2);
    const second = rounds.find((chair) => chair.id === answer.chairId) as ChairNode;
    const input = session(answer.sessionId as string).nodes[second.parentId as string];
    expect(input?.kind).toBe('user');
    expect(input?.parentId).toBe(tip);
    // the session total adds the rounds up
    const total = rounds.reduce((sum, chair) => sum + chair.usage.total, 0);
    expect((answer.usage as { session: number }).session).toBe(total);
    expect(JSON.parse((await thread(id)).body).chairId).toBe(answer.chairId);
    tip = answer.chairId as string;
  });

  it('starts a new session when the level changes, with the conversation so far as its background', async () => {
    const before = answerOf(firstEvents).sessionId as string;
    const reply = await turn(id, turnBody('So what do I do first?', { level: 'high' }));
    const answer = answerOf(reply.events);
    expect(answer.sessionId).not.toBe(before);
    const made = session(answer.sessionId as string);
    expect(made.settings.level).toBe('high');
    expect(made.settings.question).toBe('So what do I do first?');
    expect(made.background).toContain(`user: ${first}`);
    expect(made.background).toContain('assistant: ');
    expect(made.background).toContain('And if the rates fall next year?');
    expect(made.origin).toMatchObject({ kind: 'api', profileLevel: 'high' });
    const view = JSON.parse((await thread(id)).body);
    expect(view).toMatchObject({ sessionId: made.id, chairId: answer.chairId, level: 'high' });
  });
});

describe('a fork', () => {
  it('becomes a branch of the round it continues when the profile and level match', async () => {
    const original = newThread('origin');
    const opened = await turn(
      original,
      turnBody('Which language should the service be written in?'),
    );
    const root = answerOf(opened.events);
    const sessionId = root.sessionId as string;
    await turn(original, turnBody('What about hiring?'));
    expect(chairs(sessionId)).toHaveLength(2);

    // a fork is a thread the server has not seen, whose first message names the round it continues
    const fork = newThread('fork');
    const reply = await turn(
      fork,
      turnBody('Suppose we only have two engineers.', {
        from: { sessionId, chairId: root.chairId },
        background: 'something the server must not need',
      }),
    );
    const answer = answerOf(reply.events);
    expect(answer.sessionId).toBe(sessionId);
    const rounds = chairs(sessionId);
    expect(rounds).toHaveLength(3);
    const branch = rounds.find((chair) => chair.id === answer.chairId) as ChairNode;
    expect(session(sessionId).nodes[branch.parentId as string]?.parentId).toBe(root.chairId);
    expect(session(sessionId).background).toBeUndefined();
    // and the fork goes on from its own round afterwards
    const view = JSON.parse((await thread(fork)).body);
    expect(view).toMatchObject({ sessionId, chairId: answer.chairId });
    const more = answerOf((await turn(fork, turnBody('And with five?'))).events);
    expect(more.sessionId).toBe(sessionId);
    expect(chairs(sessionId)).toHaveLength(4);
    // the original thread is where it was
    expect(JSON.parse((await thread(original)).body).chairId).not.toBe(more.chairId);
  });

  it('starts a new session with the round it names as background when the level differs', async () => {
    const original = newThread('origin2');
    const root = answerOf(
      (await turn(original, turnBody('Is a monorepo worth it for us?'))).events,
    );
    const reply = await turn(
      newThread('fork2'),
      turnBody('Even for a small team?', {
        level: 'medium',
        from: { sessionId: root.sessionId, chairId: root.chairId },
      }),
    );
    const answer = answerOf(reply.events);
    expect(answer.sessionId).not.toBe(root.sessionId);
    expect(session(answer.sessionId as string).background).toContain(
      'Is a monorepo worth it for us?',
    );
    expect(session(answer.sessionId as string).settings.level).toBe('medium');
  });

  it('is a new session with the client’s own background when the round it names does not exist', async () => {
    const reply = await turn(
      newThread('fork3'),
      turnBody('Where were we?', {
        from: { sessionId: '00000000-0000-4000-8000-000000000000', chairId: 'c_00000000' },
        background: 'user: we were choosing a database\n\nassistant: Postgres',
      }),
    );
    const made = session(answerOf(reply.events).sessionId as string);
    expect(made.background).toBe('user: we were choosing a database\n\nassistant: Postgres');
  });
});

describe('members that do not answer', () => {
  const finalPlan = (events: DivanEvent[]) =>
    planOfEvent(events.filter((event) => event.type === 'plan').at(-1));
  /** The lines of the live report of a turn, in order. */
  const reportOf = (events: DivanEvent[]) =>
    events.filter((event) => event.type === 'progress').map((event) => String(event.text));
  const byHarness = (plan: Step[]) =>
    Object.fromEntries(plan.map((step) => [step.content.split(' · ')[0], step.content]));

  it('are ticked off with the reason: one that failed, one that was left out, one that threw', async () => {
    const profile = await profileWith('plan words', { claude: 'fake-fail', codex: 'fake-2' });
    // a model that is known to be out is not asked at all
    await server.store.addUnavailable({
      harness: 'codex',
      model: 'fake-2',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '429 rate limit',
    });
    const reply = await turn(
      newThread('words'),
      turnBody('Who answers?', { profile, level: 'medium' }),
    );
    // the level the round asked of each member is in its step ("medium" here), and the status words stay English
    const words = byHarness(finalPlan(reply.events));
    expect(words['Claude Code']).toBe('Claude Code · fake-fail · medium — did not answer');
    expect(words.Codex).toBe('Codex · fake-2 · medium — skipped');
    expect(words.Grok).toBe('Grok · fake-1 · medium');
    expect(words.Pi).toBe('Pi · google/gemini-pro · medium');
    expect(finalPlan(reply.events).every((step) => step.status === 'completed')).toBe(true);
    expect(answerOf(reply.events).type).toBe('answer');
    // and the live report says what became of them, without letters
    const lines = reportOf(reply.events);
    expect(lines).toContain('Claude Code · fake-fail did not answer (failed).');
    expect(lines).toContain('Codex · fake-2 was skipped (rate limited).');
    expect(lines.filter((line) => line.includes('fake-fail'))).toHaveLength(1);

    // a member that throws is announced a moment before its state changes: the checklist still says what became of it
    const threw = await profileWith('plan throws', { pi: 'fake-throw' });
    const second = await turn(
      newThread('throws'),
      turnBody('Who answers now?', { profile: threw, level: 'medium' }),
    );
    expect(byHarness(finalPlan(second.events)).Pi).toBe(
      'Pi · fake-throw · medium — did not answer',
    );
    expect(answerOf(second.events).type).toBe('answer');
    expect(reportOf(second.events)).toContain('Pi · fake-throw did not answer (failed).');
  });

  it('say in the live report why a member is out or went without the folder: no credit, an answer that cannot be read, no project folder', async () => {
    const profile = await profileWith('report words', {
      pi: 'fake-nocredit',
      grok: 'fake-invalid',
      claude: 'fake-nofolder',
    });
    // the account behind a provider is out: every model with this prefix is left out
    await server.store.addUnavailable({
      harness: 'pi',
      model: 'fake-nocredit',
      prefix: 'fake-nocredit',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '402 no credit',
    });
    const reply = await turn(
      newThread('why'),
      turnBody('Why are they out?', { profile, level: 'medium', cwd: project }),
    );
    const lines = reportOf(reply.events);
    expect(lines).toContain('Pi · fake-nocredit was skipped (out of credit).');
    // a member whose harness could not keep the folder's own files out answers without the folder, and the report says so
    expect(lines).toContain('Claude Code · fake-nofolder answered without the project folder.');
    expect(lines).toContain(
      'Grok · fake-invalid did not answer (gave an answer that could not be read).',
    );
    expect(answerOf(reply.events).type).toBe('answer');
  });

  it('a round that cannot answer ends with an error and a link, leaves no tip, and can be run again', async () => {
    const profile = await profileWith('plan fails', {
      claude: 'fake-fail',
      codex: 'fake-fail',
      grok: 'fake-fail',
    });
    const id = newThread('failing');
    const reply = await turn(id, turnBody('Nobody can answer this', { profile, level: 'medium' }));
    expect(reply.events.some((event) => event.type === 'answer')).toBe(false);
    expect(reply.events.at(-1)).toMatchObject({ type: 'error', code: 'round_failed' });
    const failure = reply.events.at(-1) as DivanEvent;
    expect(String(failure.message)).toBe(
      'the council could not answer: Fewer than two members gave a valid output.',
    );
    expect(String(failure.link)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/open\//u);
    // the chairman never began
    expect(finalPlan(reply.events).at(-1)).toEqual({
      content: expect.stringMatching(/^Chairman · /u),
      status: 'pending',
    });
    const round = reply.events[0] as DivanEvent;
    const view = JSON.parse((await thread(id)).body);
    expect(view).toMatchObject({ sessionId: round.sessionId, chairId: null });
    // "continue" runs the failed round again (it fails again here), and names the same round
    const again = await turn(id, turnBody(CONTINUE_TEXT, { profile, level: 'medium' }));
    expect(again.events[0]).toMatchObject({ type: 'round', chairId: round.chairId });
    expect(again.events.at(-1)).toMatchObject({ type: 'error', code: 'round_failed' });
  });
});

describe('the working folder', () => {
  it('says so when the folder cannot be used, and goes on without it', async () => {
    const missing = join(tmpdir(), 'divan-threads-no-such-folder');
    const reply = await turn(
      newThread('folder'),
      turnBody('A question without a folder', { cwd: missing }),
    );
    expect(reply.events[0]).toMatchObject({ type: 'note' });
    expect(String(reply.events[0]?.text)).toMatch(/working folder not used \(does not exist\)/u);
    const answer = answerOf(reply.events);
    expect(session(answer.sessionId as string).settings.cwd).toBeUndefined();
  });
});

describe('a client that leaves, and the continue button', () => {
  it('cancels the round, leaves the tip where it was, and runs the same round again on "continue"', async () => {
    const id = newThread('leave');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;

    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '1500';
    let cancelled: string;
    try {
      const open = openTurn(id, turnBody('A question the client will not wait for'));
      const round = await open.event('round');
      cancelled = round.chairId as string;
      expect(round.sessionId).toBe(sessionId);
      open.hangUp();
      await open.ended;
      await until(() => (session(sessionId).nodes[cancelled] as ChairNode).status === 'cancelled');
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
    // the tip is the round whose answer was delivered; the cancelled one is only the last started
    expect(JSON.parse((await thread(id)).body).chairId).toBe(first.chairId);
    expect(chairs(sessionId)).toHaveLength(2);

    const again = await turn(id, turnBody(CONTINUE_TEXT));
    const answer = answerOf(again.events);
    expect(again.events[0]).toMatchObject({ type: 'round', sessionId, chairId: cancelled });
    expect(answer.chairId).toBe(cancelled);
    expect(chairs(sessionId)).toHaveLength(2);
    expect((session(sessionId).nodes[cancelled] as ChairNode).status).toBe('done');
    expect(JSON.parse((await thread(id)).body).chairId).toBe(cancelled);
    // the same words once the last round is done are an ordinary message
    const ordinary = answerOf((await turn(id, turnBody(CONTINUE_TEXT))).events);
    expect(ordinary.chairId).not.toBe(cancelled);
    expect(chairs(sessionId)).toHaveLength(3);
  });
});

describe('a message that follows a cancel at once (T3 Code steers by cancelling and sending the next message)', () => {
  /** A turn the client leaves as soon as the round is admitted, without waiting for the server to notice. */
  async function leaveAtOnce(id: string, text: string) {
    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '1500';
    try {
      const open = openTurn(id, turnBody(text));
      const round = await open.event('round');
      // the members are waiting now; whatever comes after them is quick
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
      open.hangUp();
      return round;
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
  }

  it('waits for the cancelled round to let go, then goes on from the tip', async () => {
    const id = newThread('steer');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;
    const cancelled = (await leaveAtOnce(id, 'A question the client will change')).chairId;

    const steered = await turn(id, turnBody('Actually, a different question'));
    expect(steered.events.some((event) => event.type === 'error')).toBe(false);
    const answer = answerOf(steered.events);
    expect(answer.sessionId).toBe(sessionId);
    expect((session(sessionId).nodes[cancelled as string] as ChairNode).status).toBe('cancelled');
    // the new message hangs from the tip, beside the cancelled round
    const made = session(sessionId).nodes[answer.chairId as string] as ChairNode;
    expect(session(sessionId).nodes[made.parentId as string]?.parentId).toBe(first.chairId);
    expect(chairs(sessionId)).toHaveLength(3);
    expect(JSON.parse((await thread(id)).body).chairId).toBe(answer.chairId);
  });

  it('waits for the turn before it while that turn is still being admitted, so the message is answered here and not in a new session', async () => {
    const id = newThread('admitting');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;

    // the write that admits the next turn is slow (a big session, a busy disk)
    const write = server.store.save.bind(server.store);
    let slowed = false;
    let writing: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const save = vi.spyOn(server.store, 'save').mockImplementation(async (saved, over) => {
      if (!slowed && saved.id === sessionId) {
        slowed = true;
        writing();
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return write(saved, over);
    });
    try {
      const open = openTurn(id, turnBody('A question the client will change'));
      await started;
      open.hangUp();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const steered = await turn(id, turnBody('Actually, a different question'));
      // the thread's own round is not "another round running": no note, no new session
      expect(steered.events.map((event) => event.type)).not.toContain('note');
      expect(steered.events.map((event) => event.type)).not.toContain('error');
      const answer = answerOf(steered.events);
      expect(answer.sessionId).toBe(sessionId);
      expect(chairs(sessionId)).toHaveLength(3);
      expect(session(sessionId).settings.question).toBe('First, a short question');
      expect(JSON.parse((await thread(id)).body)).toMatchObject({
        sessionId,
        chairId: answer.chairId,
      });
    } finally {
      save.mockRestore();
    }
  });

  it('runs the cancelled round again when the next message is "continue"', async () => {
    const id = newThread('steercont');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;
    const cancelled = (await leaveAtOnce(id, 'A question the client will not wait for')).chairId;

    const again = await turn(id, turnBody(CONTINUE_TEXT));
    expect(again.events.some((event) => event.type === 'error')).toBe(false);
    expect(again.events[0]).toMatchObject({ type: 'round', sessionId, chairId: cancelled });
    expect(answerOf(again.events).chairId).toBe(cancelled);
    expect((session(sessionId).nodes[cancelled as string] as ChairNode).status).toBe('done');
    // no round was made for the words of the button
    expect(chairs(sessionId)).toHaveLength(2);
  });

  it('keeps the checklist and the live report in English for a Persian conversation, also in the round it runs again', async () => {
    /** Every word the server wrote itself for the client in a turn: the checklists, the report and the notes (not the answer). */
    const ownWords = (events: DivanEvent[]) =>
      events.flatMap((event) =>
        event.type === 'answer'
          ? []
          : event.type === 'note' || event.type === 'progress'
            ? [String(event.text)]
            : planOfEvent(event).map((step) => step.content),
      );
    const persian = /\p{Script=Arabic}/u;
    const id = newThread('steerfa');
    const first = await turn(id, turnBody('آیا بهتر است خانه اجاره کنم یا بخرم؟'));
    expect(planOfEvent(first.events[0]).at(-1)?.content).toMatch(/^Chairman · /u);
    const spoken = ownWords(first.events);
    expect(spoken.length).toBeGreaterThan(5);
    expect(spoken.filter((text) => persian.test(text))).toEqual([]);
    // only the closing link is worded in the language of the answer
    expect(String(answerOf(first.events).content)).toMatch(
      /\n\n\[باز کردن در دیوان\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=[0-9a-f-]{36}\.c_[0-9a-f]+\)$/u,
    );
    const cancelled = (await leaveAtOnce(id, 'اگر نرخ سود کم شود چه؟')).chairId;

    // T3 sends the same English words whatever the language of the conversation
    const again = await turn(id, turnBody(CONTINUE_TEXT));
    expect(again.events[0]).toMatchObject({ type: 'round', chairId: cancelled });
    expect(planOfEvent(again.events[0]).at(-1)?.content).toMatch(/^Chairman · /u);
    const last = planOfEvent(again.events.filter((event) => event.type === 'plan').at(-1));
    expect(last.at(-1)).toEqual({
      content: expect.stringMatching(/^Chairman · .+ · low$/u),
      status: 'completed',
    });
    expect(ownWords(again.events).filter((text) => persian.test(text))).toEqual([]);
  });
});

describe('a round that finished although the client had left', () => {
  it('is delivered on "continue" and nothing is asked again', async () => {
    const id = newThread('late');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;

    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '1500';
    let cancelled: string;
    try {
      const open = openTurn(id, turnBody('A question the client will not wait for'));
      cancelled = (await open.event('round')).chairId as string;
      open.hangUp();
      await open.ended;
      await until(() => (session(sessionId).nodes[cancelled] as ChairNode).status === 'cancelled');
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
    // the answer was never shown; the round is run again on the web page and ends
    const rerun = await call(`/api/sessions/${sessionId}/rounds/${cancelled}/rerun`, {
      method: 'POST',
      headers: web(),
      body: {},
    });
    expect(rerun.status).toBe(202);
    await until(() => (session(sessionId).nodes[cancelled] as ChairNode).status === 'done');
    expect(JSON.parse((await thread(id)).body).chairId).toBe(first.chairId);

    const again = await turn(id, turnBody(CONTINUE_TEXT));
    expect(again.events[0]).toMatchObject({ type: 'round', sessionId, chairId: cancelled });
    const answer = answerOf(again.events);
    expect(answer.chairId).toBe(cancelled);
    expect(String(answer.content)).toContain(
      (session(sessionId).nodes[cancelled] as ChairNode).answer,
    );
    // the council was not asked the words of the button
    expect(chairs(sessionId)).toHaveLength(2);
    expect(
      Object.values(session(sessionId).nodes).some(
        (node) => node.kind === 'user' && node.text === CONTINUE_TEXT,
      ),
    ).toBe(false);
    expect(JSON.parse((await thread(id)).body).chairId).toBe(cancelled);
  });
});

describe('a round that is still running when "continue" arrives', () => {
  it('is shown, not branched from: the council is not asked the words of the button', async () => {
    const id = newThread('running');
    const first = answerOf((await turn(id, turnBody('First, a short question'))).events);
    const sessionId = first.sessionId as string;

    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '1500';
    let cancelled: string;
    const realSetTimeout = globalThis.setTimeout;
    // the thread waits SETTLE_MS (15 s) for a round it started; here it waits 150 ms, which the rerun outlasts
    const waits = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((handler: () => void, ms?: number) =>
        realSetTimeout(handler, ms === SETTLE_MS ? 150 : ms)) as unknown as typeof setTimeout);
    try {
      const open = openTurn(id, turnBody('A question the client will not wait for'));
      cancelled = (await open.event('round')).chairId as string;
      open.hangUp();
      await open.ended;
      await until(() => (session(sessionId).nodes[cancelled] as ChairNode).status === 'cancelled');
      // run again on the web page, and "continue" pressed while it goes on
      process.env.DIVAN_FAKE_DELAY_MS = '600';
      const rerun = await call(`/api/sessions/${sessionId}/rounds/${cancelled}/rerun`, {
        method: 'POST',
        headers: web(),
        body: {},
      });
      expect(rerun.status).toBe(202);
      const again = await turn(id, turnBody(CONTINUE_TEXT));
      expect(waits.mock.calls.some(([, ms]) => ms === SETTLE_MS)).toBe(true);
      // no note that another round is running, no error, and the round is the thread's own
      expect(again.events.map((event) => event.type)).not.toContain('note');
      expect(again.events.map((event) => event.type)).not.toContain('error');
      expect(again.events[0]).toMatchObject({ type: 'round', sessionId, chairId: cancelled });
      expect(answerOf(again.events).chairId).toBe(cancelled);
    } finally {
      waits.mockRestore();
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
    expect((session(sessionId).nodes[cancelled] as ChairNode).status).toBe('done');
    // nothing was made for the words of the button, in this session or another
    expect(chairs(sessionId)).toHaveLength(2);
    expect(
      Object.values(session(sessionId).nodes).some(
        (node) => node.kind === 'user' && node.text === CONTINUE_TEXT,
      ),
    ).toBe(false);
    expect(JSON.parse((await thread(id)).body)).toMatchObject({ sessionId, chairId: cancelled });
  }, 20_000);
});

describe('a tip that cannot be written', () => {
  it('does not turn a finished answer into an error', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing = vi
      .spyOn(server.store, 'updateThreads')
      .mockRejectedValue(new Error('disk full'));
    try {
      const reply = await turn(newThread('nowrite'), turnBody('Will the answer still arrive?'));
      expect(reply.events.at(-1)?.type).toBe('answer');
      expect(reply.events.some((event) => event.type === 'error')).toBe(false);
      expect(quiet).toHaveBeenCalledWith('[divan] could not move the thread tip:', 'disk full');
    } finally {
      failing.mockRestore();
      quiet.mockRestore();
    }
  });
});

describe('two threads that share a session', () => {
  const english =
    'Another round of this Divan session is running, so this question starts a new session with the conversation so far.';

  /** Thread A has an answer; a fork of it (thread B) is running in the same session when A sends its next message. */
  async function busyFork(question: string, forkText: string, nextText: string, note: string) {
    const a = newThread('shared');
    const root = answerOf((await turn(a, turnBody(question))).events);
    const sessionId = root.sessionId as string;

    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '1500';
    const fork = openTurn(
      newThread('shared-fork'),
      turnBody(forkText, { from: { sessionId, chairId: root.chairId } }),
    );
    try {
      const round = await fork.event('round');
      expect(round.sessionId).toBe(sessionId); // it is a branch of A's session
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }

    // the session is busy with B's round: A's turn is not refused, it gets a session of its own
    const next = await turn(a, turnBody(nextText));
    expect(next.events[0]).toEqual({ type: 'note', text: note });
    expect(next.events.some((event) => event.type === 'error')).toBe(false);
    const answer = answerOf(next.events);
    expect(answer.sessionId).not.toBe(sessionId);
    const made = session(answer.sessionId as string);
    expect(made.settings.question).toBe(nextText);
    expect(made.background).toContain(question);
    expect(made.background).toContain('assistant: ');
    expect(made.origin).toMatchObject({ kind: 'api', profileId: 'default', profileLevel: 'low' });
    expect(JSON.parse((await thread(a)).body)).toMatchObject({
      sessionId: made.id,
      chairId: answer.chairId,
    });

    // and B's round, in the old session, was not disturbed
    await fork.ended;
    expect(answerOf(fork.events).sessionId).toBe(sessionId);
    expect(chairs(sessionId)).toHaveLength(2);
  }

  it('starts a new session with the conversation so far, and says so', async () => {
    await busyFork(
      'Which language should the service be written in?',
      'Suppose we only have two engineers.',
      'What about hiring?',
      english,
    );
  });

  it('says so in English also to a Persian question', async () => {
    await busyFork(
      'آیا بهتر است خانه اجاره کنم یا بخرم؟',
      'اگر فقط دو مهندس داشته باشیم؟',
      'درباره استخدام چه؟',
      english,
    );
  });
});

describe('a folder name that is not valid text', () => {
  it('is a folder that cannot be used, not a failure of the server', async () => {
    const reply = await turn(
      newThread('surrogate'),
      turnBody('Where does this run?', { cwd: `${project}\ud800` }),
    );
    expect(reply.status).toBe(200);
    expect(reply.events[0]).toMatchObject({ type: 'note' });
    expect(String(reply.events[0]?.text)).toMatch(/working folder not used/u);
    expect(answerOf(reply.events).type).toBe('answer');
  });
});

describe('a long silence', () => {
  it('sends a bare newline every so often, and every other line is a JSON object', async () => {
    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '500';
    process.env.DIVAN_KEEPALIVE_MS = '100';
    try {
      const reply = await turn(
        newThread('quiet'),
        turnBody('A question that makes the stream wait'),
      );
      expect(reply.body).toMatch(/\n\n/u);
      expect(answerOf(reply.events).type).toBe('answer');
    } finally {
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
      delete process.env.DIVAN_KEEPALIVE_MS;
    }
  });
});

describe('the heartbeat of a round that is running', () => {
  const PERIOD = 97;
  /** The intervals made with the heartbeat's period while it runs, and whether each was cleared. */
  function watchHeartbeats() {
    const made: { id: unknown; cleared: boolean }[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const set = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      ms?: number,
    ) => {
      const id = realSet(handler, ms);
      if (ms === PERIOD) made.push({ id, cleared: false });
      return id;
    }) as never);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: never) => {
      const own = made.find((item) => item.id === id);
      if (own) own.cleared = true;
      realClear(id);
    }) as never);
    return {
      made,
      stop: () => {
        set.mockRestore();
        clear.mockRestore();
      },
    };
  }
  const lines = (events: DivanEvent[]) =>
    events.filter((event) => event.type === 'progress').map((event) => String(event.text));

  /** Runs `body` with a fast heartbeat and slow members, and returns the intervals it made (all of them must be cleared). */
  async function fast<T>(body: (watch: ReturnType<typeof watchHeartbeats>) => Promise<T>) {
    const delay = process.env.DIVAN_FAKE_DELAY_MS;
    process.env.DIVAN_FAKE_DELAY_MS = '500';
    process.env.DIVAN_PROGRESS_MS = String(PERIOD);
    const watch = watchHeartbeats();
    try {
      return await body(watch);
    } finally {
      watch.stop();
      delete process.env.DIVAN_PROGRESS_MS;
      process.env.DIVAN_FAKE_DELAY_MS = delay as string;
    }
  }

  it('says how long it has been, and what each member is doing, then what the chairman is doing, and stops with the answer', async () => {
    await fast(async (watch) => {
      const reply = await turn(newThread('beat'), turnBody('A question that takes a while'));
      const report = lines(reply.events);
      // Between calls/checkpoints a heartbeat can truthfully report elapsed time alone.
      const members = report.filter((line) => line.startsWith('Working for') && line.includes(':'));
      const chairman = report.filter((line) => line.startsWith('Chairman working for'));
      expect(members.length).toBeGreaterThanOrEqual(2);
      expect(chairman.length).toBeGreaterThanOrEqual(2);
      // only the members that are working, by the name of their assistant, with no letter
      const partOf = '(?:Claude Code|Codex|Grok|Pi) (?:working|\\d+k? thinking tokens)';
      for (const line of members) {
        expect(line).toMatch(new RegExp(`^Working for \\d+s: ${partOf}(?:, ${partOf})*\\.$`, 'u'));
      }
      for (const line of chairman) expect(line).toMatch(/^Chairman working for \d+s\.$/u);
      // in the order of the round: the members' beats, then the chairman's line, then its beats; the answer closes the stream
      const begins = report.findIndex((line) => line.startsWith('All members are in'));
      expect(begins).toBeGreaterThan(-1);
      expect(members.every((line) => report.indexOf(line) < begins)).toBe(true);
      expect(chairman.every((line) => report.indexOf(line) > begins)).toBe(true);
      expect(reply.events.at(-1)?.type).toBe('answer');
      // one interval for the turn, and it is gone
      expect(watch.made).toHaveLength(1);
      expect(watch.made[0]?.cleared).toBe(true);
    });
  });

  it('is cleared when the round fails', async () => {
    const profile = await profileWith('beat fails', {
      claude: 'fake-fail',
      codex: 'fake-fail',
      grok: 'fake-fail',
    });
    await fast(async (watch) => {
      const reply = await turn(
        newThread('beatfail'),
        turnBody('Nobody can answer this one', { profile, level: 'medium' }),
      );
      expect(reply.events.at(-1)).toMatchObject({ type: 'error', code: 'round_failed' });
      expect(watch.made).toHaveLength(1);
      expect(watch.made[0]?.cleared).toBe(true);
    });
  });

  it('is cleared when the client leaves, and nothing more is sent to it', async () => {
    await fast(async (watch) => {
      process.env.DIVAN_FAKE_DELAY_MS = '1500';
      const open = openTurn(newThread('beatleave'), turnBody('A question the client leaves'));
      const round = await open.event('round');
      await until(() => lines(open.events).some((line) => line.startsWith('Working for')));
      open.hangUp();
      await open.ended;
      const sessionId = round.sessionId as string;
      await until(
        () =>
          (session(sessionId).nodes[round.chairId as string] as ChairNode).status === 'cancelled',
      );
      await until(() => watch.made.length === 1 && watch.made.every((item) => item.cleared));
    });
  });
});

describe('the checklist and the live report, as functions of a round', () => {
  const seat = (
    id: string,
    state: SeatRun['state'],
    model = 'm1',
    extra: Partial<SeatRun> = {},
  ): SeatRun =>
    ({
      seatId: id,
      label: 'Z',
      harness: 'pi',
      model,
      effort: 'high',
      state,
      ...extra,
    }) as SeatRun;
  const sessionWith = (order: string[]) =>
    ({ settings: { seats: order.map((id) => ({ id })) } }) as unknown as Session;
  const chairWith = (
    seats: SeatRun[],
    state: NonNullable<ChairNode['chairman']>['state'],
    extra: Partial<ChairNode> = {},
    chairman: Partial<ChairNode['chairman']> = {},
  ) =>
    ({
      seats,
      chairman: { state, harness: 'claude', model: 'big', effort: 'max', ...chairman },
      ...extra,
    }) as unknown as ChairNode;

  it('follows the council’s order, not the labels, words each state, and names the level asked of each', () => {
    const plan = planOf(
      sessionWith(['a', 'b', 'c', 'd', 'e', 'f']),
      chairWith(
        [
          seat('f', 'timeout', 'm6'),
          seat('e', 'skipped', 'm5'),
          seat('d', 'failed', 'm4'),
          seat('c', 'pending', 'm3'),
          seat('b', 'running', 'm2'),
          seat('a', 'done', '', { effort: '' }),
        ],
        'pending',
      ),
    );
    expect(plan).toEqual([
      // no model and no level: just the assistant
      { content: 'Pi', status: 'completed' },
      { content: 'Pi · m2 · high', status: 'in_progress' },
      { content: 'Pi · m3 · high', status: 'pending' },
      { content: 'Pi · m4 · high — did not answer', status: 'completed' },
      { content: 'Pi · m5 · high — skipped', status: 'completed' },
      { content: 'Pi · m6 · high — did not answer', status: 'completed' },
      { content: 'Chairman · Claude Code · big · max', status: 'pending' },
    ]);
  });

  it('keeps a step’s text from the start of the round to the member’s end', () => {
    const one = sessionWith(['a']);
    const at = (state: SeatRun['state']) =>
      (planOf(one, chairWith([seat('a', state, 'm1')], 'pending'))[0] as { content: string })
        .content;
    expect(at('pending')).toBe('Pi · m1 · high');
    expect(at('running')).toBe(at('pending'));
    expect(at('done')).toBe(at('pending'));
  });

  it('words the chairman’s states in English, and leaves the level out when it is empty', () => {
    const one = sessionWith(['a']);
    const last = (
      state: NonNullable<ChairNode['chairman']>['state'],
      chairman: Partial<ChairNode['chairman']> = {},
    ) => planOf(one, chairWith([seat('a', 'done')], state, {}, chairman)).at(-1);
    expect(last('running')).toEqual({
      content: 'Chairman · Claude Code · big · max',
      status: 'in_progress',
    });
    expect(last('done')?.status).toBe('completed');
    expect(last('failed')).toEqual({
      content: 'Chairman · Claude Code · big · max — did not answer',
      status: 'completed',
    });
    expect(last('pending', { effort: '' })?.content).toBe('Chairman · Claude Code · big');
    const skipped = planOf(one, chairWith([seat('a', 'skipped')], 'pending'))[0];
    expect(skipped?.content).toBe('Pi · m1 · high — skipped');
  });

  it('says a number of seconds and minutes, and of tokens, in a few characters', () => {
    expect(durationText(0)).toBe('0s');
    expect(durationText(45_000)).toBe('45s');
    expect(durationText(59_400)).toBe('59s');
    expect(durationText(60_000)).toBe('1m');
    expect(durationText(102_000)).toBe('1m 42s');
    expect(durationText(9 * 60_000 + 5_000)).toBe('9m 5s');
    expect(durationText(12 * 60_000 + 30_000)).toBe('12m');
    expect(tokensText(850)).toBe('850');
    expect(tokensText(999)).toBe('999');
    expect(tokensText(14_000)).toBe('14k');
    expect(tokensText(14_400)).toBe('14k');
  });

  describe('the line an event adds', () => {
    const members = [
      seat('a', 'done', 'gpt-6-astra', {
        label: 'C',
        harness: 'codex',
        startedAt: '2026-10-12T10:00:00.000Z',
        endedAt: '2026-10-12T10:01:42.000Z',
      }),
      seat('b', 'timeout', 'grok-4.7', { label: 'D', harness: 'grok' }),
      seat('c', 'skipped', 'm3', { label: 'E', error: 'skipped: no credit' }),
    ];
    const chair = chairWith(members, 'running');
    /** The line for an event of the round in which member `label` is as `over` changes it. */
    const lineWith = (
      event: Parameters<typeof progressOf>[0],
      label: string,
      over: Partial<SeatRun>,
    ) =>
      progressOf(
        event,
        chairWith(
          members.map((member) => (member.label === label ? { ...member, ...over } : member)),
          'running',
        ),
      );

    it('says who answered and how long it took, by the name in the checklist and never by letter', () => {
      expect(progressOf({ type: 'seat-done', label: 'C', stance: 'a secret stance' }, chair)).toBe(
        'Codex · gpt-6-astra answered after 1m 42s.',
      );
      // a member with no times (an older node) is still named
      expect(
        lineWith({ type: 'seat-done', label: 'C', stance: 'x' }, 'C', {
          startedAt: null,
          endedAt: null,
        }),
      ).toBe('Codex · gpt-6-astra answered.');
    });

    it('says why a member did not answer', () => {
      const failed = (reason: 'timeout' | 'failed' | 'invalid' | 'cancelled') =>
        progressOf({ type: 'seat-failed', label: 'D', reason }, chair);
      expect(failed('timeout')).toBe(
        'Grok · grok-4.7 did not answer (timed out after 10 minutes without a sign of work).',
      );
      expect(failed('failed')).toBe('Grok · grok-4.7 did not answer (failed).');
      expect(failed('invalid')).toBe(
        'Grok · grok-4.7 did not answer (gave an answer that could not be read).',
      );
      expect(failed('cancelled')).toBe('Grok · grok-4.7 did not answer (cancelled).');
    });

    it('says why a member was left out, from its error text', () => {
      const skipped = (error: string | null) =>
        lineWith({ type: 'seat-failed', label: 'E', reason: 'skipped' }, 'E', { error });
      expect(skipped('skipped: no credit')).toBe('Pi · m3 was skipped (out of credit).');
      expect(skipped('skipped: rate limited')).toBe('Pi · m3 was skipped (rate limited).');
      expect(skipped(SKIPPED_SAME_FAMILY)).toBe(
        'Pi · m3 was skipped (same model family as the chairman).',
      );
      expect(skipped(SKIPPED_BY_USER)).toBe('Pi · m3 was skipped (stopped by the user).');
      expect(skipped('disabled in this flow')).toBe('Pi · m3 was skipped (disabled in this flow).');
    });

    it('says that a member answered without the project folder, and when the chairman begins', () => {
      expect(progressOf({ type: 'seat-note', label: 'E' }, chair)).toBe(
        'Pi · m3 answered without the project folder.',
      );
      expect(progressOf({ type: 'chairman', answers: 4 }, chair)).toBe(
        'All members are in. The chairman (Claude Code · big · max) is reading 4 answers.',
      );
      expect(
        progressOf(
          { type: 'chairman', answers: 2 },
          chairWith(members, 'running', {}, { effort: '' }),
        ),
      ).toBe('All members are in. The chairman (Claude Code · big) is reading 2 answers.');
    });

    it('says nothing for a sign of work, a start or the end, nor for a member it does not know', () => {
      for (const event of [
        { type: 'seat-start', label: 'C' },
        { type: 'seat-signal', label: 'C', thinkingTokens: 5 },
        { type: 'end', status: 'done' },
        { type: 'seat-done', label: 'Q', stance: 'x' },
        { type: 'seat-failed', label: 'Q', reason: 'failed' },
        { type: 'seat-note', label: 'Q' },
      ] as const) {
        expect(progressOf(event, chair), JSON.stringify(event)).toBeNull();
      }
    });
  });

  describe('the heartbeat', () => {
    const t0 = Date.parse('2026-10-12T10:00:00.000Z');
    const at = (seconds: number) => t0 + seconds * 1000;
    const iso = (seconds: number) => new Date(at(seconds)).toISOString();
    const running = (
      id: string,
      harness: SeatRun['harness'],
      extra: Partial<SeatRun> = {},
    ): SeatRun =>
      seat(id, 'running', 'm', { harness, startedAt: iso(0), lastSignalAt: iso(0), ...extra });

    it('says how long, and for each member still working its thinking tokens or how long it has been silent', () => {
      const chair = chairWith(
        [
          running('a', 'claude', { lastSignalAt: iso(178), thinkingTokens: 14_000 }),
          running('b', 'codex', { lastSignalAt: iso(60) }),
          running('c', 'grok', { lastSignalAt: iso(170), thinkingTokens: 8_200 }),
          seat('d', 'done', 'm', { harness: 'pi' }),
        ],
        'pending',
        { startedAt: iso(0) },
      );
      expect(heartbeatOf(sessionWith(['a', 'b', 'c', 'd']), chair, at(180))).toBe(
        'Working for 3m: Claude Code 14k thinking tokens, Codex no sign of work for 2m, Grok 8k thinking tokens.',
      );
    });

    it('says a member is working when it has shown signs and reported no thinking', () => {
      const chair = chairWith([running('a', 'pi', { lastSignalAt: iso(40) })], 'pending', {
        startedAt: iso(0),
      });
      expect(heartbeatOf(sessionWith(['a']), chair, at(45))).toBe('Working for 45s: Pi working.');
    });

    it('tells a silent member by its silence, whatever it said before, from the minute on', () => {
      const chair = chairWith(
        [running('a', 'claude', { lastSignalAt: iso(0), thinkingTokens: 850 })],
        'pending',
        { startedAt: iso(0) },
      );
      expect(heartbeatOf(sessionWith(['a']), chair, at(49))).toBe(
        'Working for 49s: Claude Code 850 thinking tokens.',
      );
      expect(heartbeatOf(sessionWith(['a']), chair, at(60))).toBe(
        'Working for 1m: Claude Code no sign of work for 1m.',
      );
    });

    it('counts a member that has not signalled yet from the time it started', () => {
      const chair = chairWith(
        [running('a', 'claude', { lastSignalAt: null, startedAt: iso(5) })],
        'pending',
        { startedAt: iso(0) },
      );
      expect(heartbeatOf(sessionWith(['a']), chair, at(125))).toBe(
        'Working for 2m: Claude Code no sign of work for 2m.',
      );
    });

    it('follows the council’s order and lists only the members still running', () => {
      const chair = chairWith(
        [
          running('d', 'pi', { lastSignalAt: iso(9) }),
          seat('c', 'failed', 'm', { harness: 'grok' }),
          running('a', 'claude', { lastSignalAt: iso(9) }),
          seat('b', 'skipped', 'm', { harness: 'codex' }),
        ],
        'pending',
        { startedAt: iso(0) },
      );
      expect(heartbeatOf(sessionWith(['a', 'b', 'c', 'd']), chair, at(10))).toBe(
        'Working for 10s: Claude Code working, Pi working.',
      );
    });

    it('is about the chairman once the members are done', () => {
      const chair = chairWith(
        [seat('a', 'done'), seat('b', 'failed')],
        'running',
        { startedAt: iso(0) },
        { startedAt: iso(30) },
      );
      const session = sessionWith(['a', 'b']);
      expect(heartbeatOf(session, chair, at(150))).toBe('Chairman working for 2m.');
      expect(heartbeatOf(session, chair, at(45))).toBe('Chairman working for 15s.');
    });

    it('still says the round is going when nobody is working yet', () => {
      const chair = chairWith([seat('a', 'pending')], 'pending', { startedAt: iso(0) });
      expect(heartbeatOf(sessionWith(['a']), chair, at(61))).toBe('Working for 1m.');
    });
  });
});

describe('the mapping, as functions', () => {
  const ref = (sessionId: string, chairId: string) => ({ sessionId, chairId });
  const chair = (id: string, parentId: string, status: ChairNode['status'] = 'done') =>
    ({
      id,
      kind: 'chair',
      parentId,
      status,
      round: 1,
      answer: `answer of ${id}`,
      recommendation: null,
      questionsForUser: [],
    }) as unknown as ChairNode;
  const user = (id: string, parentId: string | null, text: string) => ({
    id,
    kind: 'user',
    parentId,
    text,
  });
  const made = (
    id: string,
    level: string,
    profileId: string,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      id,
      origin: { kind: 'api', profileId },
      settings: { level },
      rootId: 'u1',
      nodes: {
        u1: user('u1', null, 'the question'),
        c1: chair('c1', 'u1'),
        u2: user('u2', 'c1', 'the follow-up'),
        c2: chair('c2', 'u2'),
        u3: user('u3', 'c2', 'one more'),
        c3: chair('c3', 'u3', 'cancelled'),
      },
      ...extra,
    }) as unknown as Session;
  const sessions: Record<string, Session> = { s1: made('s1', 'low', 'default') };
  const sessionOf = (id: string) => sessions[id];
  const record = (over: Partial<ThreadRecord> = {}): ThreadRecord => ({
    sessionId: 's1',
    chairId: 'c2',
    last: ref('s1', 'c3'),
    profileId: 'default',
    level: 'low',
    cwd: null,
    client: 't3-code',
    updatedAt: '2026-10-11T10:00:00.000Z',
    ...over,
  });
  const plan = (over: Partial<Parameters<typeof planTurn>[0]> = {}) =>
    planTurn({
      record: record(),
      text: 'next',
      from: null,
      profileId: 'default',
      level: 'low',
      background: null,
      sessionOf,
      ...over,
    });

  it('runs a cancelled round again on the continue button, and nothing else', () => {
    expect(plan({ text: ` ${CONTINUE_TEXT}\n` }).action).toEqual({
      kind: 'rerun',
      ref: ref('s1', 'c3'),
    });
    // a finished last round, or the words with no record, are an ordinary message
    const done = { sessionId: 's1', chairId: 'c2', last: ref('s1', 'c2') };
    expect(plan({ text: CONTINUE_TEXT, record: record(done) }).action.kind).toBe('branch');
    expect(plan({ text: CONTINUE_TEXT, record: undefined }).action.kind).toBe('new');
  });

  it('delivers a round that finished after the client left, on the continue button only', () => {
    // the tip is c1; c2 was the last round started and it is done: its answer never reached the client
    const late = record({ chairId: 'c1', last: ref('s1', 'c2') });
    expect(plan({ text: CONTINUE_TEXT, record: late })).toEqual({
      action: { kind: 'deliver', ref: ref('s1', 'c2') },
      tip: ref('s1', 'c1'),
    });
    expect(plan({ text: 'next', record: late }).action.kind).toBe('branch');
  });

  it('waits for the round the thread started last, no longer than SETTLE_MS, and not at all once the client is gone', async () => {
    const running = made('s3', 'low', 'default');
    (running.nodes.c3 as ChairNode).status = 'running';
    const store = {
      readThreads: () => ({ threads: { t: record({ sessionId: 's3', last: ref('s3', 'c3') }) } }),
      get: (id: string) => (id === 's3' ? running : undefined),
    };
    const startRound = vi.fn().mockRejectedValue(new Error('reached the engine'));
    const engine = {
      follow: () => ({ done: new Promise<never>(() => undefined) }),
      startRound,
    };
    const threads = new Threads(engine as never, store as never);
    const turnOf = (signal: AbortSignal) => ({
      threadId: 't',
      profile: { id: 'default' } as ProfileView,
      level: 'low' as const,
      text: 'next',
      cwd: null,
      from: null,
      background: null,
      client: null,
      signal,
    });
    vi.useFakeTimers();
    try {
      const waiting = expect(threads.start(turnOf(new AbortController().signal))).rejects.toThrow(
        'reached the engine',
      );
      await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
      expect(startRound).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(startRound).toHaveBeenCalledTimes(1);

      // a client that leaves while it waits ends the wait, and nothing is asked
      const left = new AbortController();
      const leaving = expect(threads.start(turnOf(left.signal))).rejects.toBeInstanceOf(
        EngineError,
      );
      left.abort();
      await leaving;
      expect(startRound).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('follows a last round that is running again on the continue button: it is neither branched from nor asked', () => {
    const running = made('s4', 'low', 'default');
    (running.nodes.c3 as ChairNode).status = 'running';
    sessions.s4 = running;
    const again = record({ sessionId: 's4', chairId: 'c2', last: ref('s4', 'c3') });
    expect(plan({ text: CONTINUE_TEXT, record: again })).toEqual({
      action: { kind: 'follow', ref: ref('s4', 'c3') },
      tip: ref('s4', 'c2'),
    });
    // also when the thread has no tip yet: the button's words never become a question
    const noTip = record({ sessionId: 's4', chairId: null, last: ref('s4', 'c3') });
    expect(plan({ text: CONTINUE_TEXT, record: noTip }).action).toEqual({
      kind: 'follow',
      ref: ref('s4', 'c3'),
    });
    // any other message is an ordinary one
    expect(plan({ text: 'next', record: again }).action.kind).toBe('branch');
  });

  it('follows that round when the wait for it ends, instead of asking the council the button’s words', async () => {
    const running = made('s5', 'low', 'default');
    (running.nodes.c3 as ChairNode).status = 'running';
    const store = {
      readThreads: () => ({ threads: { t: record({ sessionId: 's5', last: ref('s5', 'c3') }) } }),
      get: (id: string) => (id === 's5' ? running : undefined),
    };
    const followed = { sessionId: 's5', chairId: 'c3' };
    const engine = {
      follow: () => ({ ...followed, done: new Promise<never>(() => undefined) }),
      startRound: vi.fn(),
      createSessionWithRound: vi.fn(),
    };
    const threads = new Threads(engine as never, store as never);
    vi.useFakeTimers();
    try {
      const started = threads.start({
        threadId: 't',
        profile: { id: 'default' } as ProfileView,
        level: 'low',
        text: CONTINUE_TEXT,
        cwd: null,
        from: null,
        background: null,
        client: null,
        signal: new AbortController().signal,
      });
      await vi.advanceTimersByTimeAsync(SETTLE_MS);
      expect(await started).toMatchObject(followed);
      expect(engine.startRound).not.toHaveBeenCalled();
      expect(engine.createSessionWithRound).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the turns of one thread one at a time, in order, and a turn that leaves does not let the next pass', async () => {
    const gates: (() => void)[] = [];
    const order: string[] = [];
    const engine = {
      follow: () => null,
      createSessionWithRound: async (input: { question: string }) => {
        order.push(`begin ${input.question}`);
        await new Promise<void>((resolve) => gates.push(resolve));
        order.push(`end ${input.question}`);
        return { round: { sessionId: 's', chairId: input.question } };
      },
    };
    const store = {
      readThreads: () => ({ threads: {} }),
      get: () => undefined,
      updateThreads: async () => ({ threads: {} }),
    };
    const threads = new Threads(engine as never, store as never);
    const profile = {
      id: 'default',
      base: 'default',
      revision: 1,
      generation: 1,
      levels: { low: { effective: { seats: [], chairman: {}, budgets: {} } } },
    } as unknown as ProfileView;
    const turnOf = (text: string, threadId = 't', signal = new AbortController().signal) => ({
      threadId,
      profile,
      level: 'low' as const,
      text,
      cwd: null,
      from: null,
      background: null,
      client: null,
      signal,
    });
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

    const left = new AbortController();
    const one = threads.start(turnOf('one'));
    const two = threads.start(turnOf('two', 't', left.signal));
    const three = threads.start(turnOf('three'));
    const elsewhere = threads.start(turnOf('elsewhere', 'u'));
    await settle();
    // the first of the thread is being admitted; another thread is not held by it
    expect(order).toEqual(['begin one', 'begin elsewhere']);
    // the second gives up waiting: the third still waits for the first
    left.abort();
    await expect(two).rejects.toBeInstanceOf(EngineError);
    await settle();
    expect(order).toEqual(['begin one', 'begin elsewhere']);
    gates[0]?.();
    await one;
    await settle();
    expect(order).toEqual(['begin one', 'begin elsewhere', 'end one', 'begin three']);
    gates[1]?.();
    gates[2]?.();
    await Promise.all([three, elsewhere]);
    expect(order).not.toContain('begin two');
  });

  it('goes on from the tip when the profile and level match, else makes a session with the conversation', () => {
    expect(plan().action).toEqual({ kind: 'branch', ref: ref('s1', 'c2') });
    expect(plan().tip).toEqual(ref('s1', 'c2'));
    const other = plan({ level: 'high' });
    expect(other.action.kind).toBe('new');
    expect(other.tip).toEqual(ref('s1', 'c2'));
    const background = (other.action as { background: string }).background;
    expect(background).toBe(
      'user: the question\n\nassistant: answer of c1\n\nuser: the follow-up\n\nassistant: answer of c2',
    );
    expect(plan({ profileId: 'quick' }).action.kind).toBe('new');
  });

  it('uses the round a fork names only without a tip of its own, and only a finished one', () => {
    expect(plan({ record: undefined, from: ref('s1', 'c1') })).toEqual({
      action: { kind: 'branch', ref: ref('s1', 'c1') },
      tip: ref('s1', 'c1'),
    });
    // a record with no tip yet (the first turn never finished) is as no record
    const noTip = record({ chairId: null, last: ref('s1', 'c3') });
    expect(plan({ record: noTip, from: ref('s1', 'c1') }).action.kind).toBe('branch');
    expect(plan({ record: noTip }).action).toEqual({ kind: 'new', background: null });
    // the round named is not finished, or not there
    expect(plan({ record: undefined, from: ref('s1', 'c3') }).action.kind).toBe('new');
    expect(plan({ record: undefined, from: ref('gone', 'c1') }).action.kind).toBe('new');
    // the client’s own background is what a new session gets
    expect(plan({ record: undefined, background: 'earlier talk' }).action).toEqual({
      kind: 'new',
      background: 'earlier talk',
    });
  });

  it('counts a record whose sessions are gone as no record', () => {
    expect(standing(record({ sessionId: 'gone', last: ref('gone', 'c3') }), sessionOf)).toBeNull();
    expect(standing(record(), sessionOf)).toEqual({ tip: ref('s1', 'c2'), last: ref('s1', 'c3') });
    // a tip that is no finished round any more is no tip
    expect(standing(record({ chairId: 'c3' }), sessionOf)).toEqual({
      tip: null,
      last: ref('s1', 'c3'),
    });
    expect(
      plan({ record: record({ sessionId: 'gone', last: ref('gone', 'c3') }) }).action.kind,
    ).toBe('new');
  });

  it('keeps what the session itself was given before its first question, ahead of the new background', () => {
    const given = made('s2', 'low', 'default', { background: 'what came before' });
    expect(conversationUpTo(given, 'c1')).toBe(
      'what came before\n\nuser: the question\n\nassistant: answer of c1',
    );
  });

  it('keeps no more than 2000 threads, the most recently updated', () => {
    let index = { threads: {} as Record<string, ThreadRecord> };
    for (const n of [3, 1, 5, 2, 4]) {
      index = withThread(index, `t${n}`, record({ updatedAt: `2026-10-11T10:0${n}:00.000Z` }), 3);
    }
    expect(Object.keys(index.threads).sort()).toEqual(['t3', 't4', 't5']);
    // writing one again keeps it in
    index = withThread(index, 't3', record({ updatedAt: '2026-10-11T11:00:00.000Z' }), 3);
    index = withThread(index, 't6', record({ updatedAt: '2026-10-11T10:09:00.000Z' }), 3);
    expect(Object.keys(index.threads).sort()).toEqual(['t3', 't5', 't6']);
  });

  it('moves the tip only to the round that was last started', () => {
    const index = { threads: { t: record({ chairId: 'c1', last: ref('s1', 'c3') }) } };
    expect(withTip(index, 't', ref('s1', 'c2'))).toBe(index);
    expect(withTip(index, 'other', ref('s1', 'c3'))).toBe(index);
    expect(withTip(index, 't', ref('s1', 'c3')).threads.t).toMatchObject({
      sessionId: 's1',
      chairId: 'c3',
    });
  });

  it('cuts a long text from its start, keeping the end that is nearest the question', () => {
    expect(keepEnd('  short  ')).toBe('short');
    expect(keepEnd('   ')).toBeNull();
    expect(keepEnd(null)).toBeNull();
    const long = `${'old words '.repeat(5000)}the end that matters`;
    const kept = keepEnd(long, 1000) as string;
    expect(estimateTokens(kept)).toBeLessThanOrEqual(1000);
    expect(kept.startsWith('…')).toBe(true);
    expect(kept.endsWith('the end that matters')).toBe(true);
  });

  it('reads a threads file with care: a record that is not one is dropped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'divan-threads-file-'));
    try {
      const fileStore = new Store(dir);
      expect(fileStore.readThreads()).toEqual({ threads: {} });
      writeThreads(dir, {
        threads: {
          good: record(),
          noLevel: { ...record(), level: 'extreme' },
          noSession: { ...record(), sessionId: 3 },
          nothing: null,
        },
      });
      expect(Object.keys(fileStore.readThreads().threads)).toEqual(['good']);
      writeThreads(dir, 'not an object');
      expect(fileStore.readThreads()).toEqual({ threads: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function writeThreads(dir: string, value: unknown): void {
  writeFileSync(join(dir, 'threads.json'), JSON.stringify(value));
}

describe('threads with frozen custom flows', () => {
  it('busy forks keep the frozen configuration even when the edited profile is blocked', async () => {
    const profile = await profileWith('busy frozen flow', {});
    const graph = writerFlow({ critic1: 'fake-slow', critic2: 'fake-slow', critic3: 'fake-slow' });
    await call(`/api/profiles/${profile}`, {
      method: 'PUT',
      headers: web(),
      body: { flow: graph },
    });
    const root = answerOf(
      (
        await turn(
          newThread('frozenroot'),
          turnBody('Original frozen question', { profile, level: 'medium', cwd: project }),
        )
      ).events,
    );
    const original = structuredClone(session(root.sessionId as string).settings);
    const changed = writerFlow({ writer: 'fake-unavailable' });
    requireValue(agentsOf(changed)[0]).rules += ' NEW-RULE';
    await call(`/api/profiles/${profile}`, {
      method: 'PUT',
      headers: web(),
      body: { flow: changed },
    });
    await server.store.addUnavailable({
      harness: 'pi',
      model: 'fake-unavailable',
      until: new Date(Date.now() + 3600000).toISOString(),
      reason: '429 rate limit',
    });
    const from = { sessionId: root.sessionId, chairId: root.chairId };
    const first = openTurn(
      newThread('busyfork1'),
      turnBody('First branch', { profile, level: 'medium', from }),
    );
    await first.event('round');
    const second = await turn(
      newThread('busyfork2'),
      turnBody('Second branch', { profile, level: 'medium', from }),
    );
    const answer = answerOf(second.events);
    try {
      expect(answer).toBeDefined();
      const forked = session(answer.sessionId as string);
      expect(forked.id).not.toBe(root.sessionId);
      expect(forked.settings).toEqual({ ...original, question: 'Second branch' });
      expect((forked.nodes[answer.chairId as string] as ChairNode).cwd).toBe(original.cwd);
      expect(second.events.some((event) => event.type === 'note')).toBe(true);
    } finally {
      first.hangUp();
      await first.ended;
    }
  }, 15000);

  it('continue checks the cancelled last session after a profile switch, rather than the delivered old tip', async () => {
    const id = newThread('switchedcontinue');
    const root = answerOf((await turn(id, turnBody('Profile A answer'))).events);
    const profile = await profileWith('continue frozen B', {});
    await call(`/api/profiles/${profile}`, {
      method: 'PUT',
      headers: web(),
      body: {
        flow: writerFlow({ critic1: 'fake-slow', critic2: 'fake-slow', critic3: 'fake-slow' }),
      },
    });
    const stopped = openTurn(id, turnBody('Profile B question', { profile, level: 'medium' }));
    const last = await stopped.event('round');
    stopped.hangUp();
    await stopped.ended;
    await until(
      () =>
        (session(last.sessionId as string).nodes[last.chairId as string] as ChairNode).status ===
        'cancelled',
    );
    expect(JSON.parse((await thread(id)).body).sessionId).toBe(root.sessionId);
    await call(`/api/profiles/${profile}`, {
      method: 'PUT',
      headers: web(),
      body: { flow: writerFlow({ writer: 'fake-blocked-B' }) },
    });
    await server.store.addUnavailable({
      harness: 'pi',
      model: 'fake-blocked-B',
      until: new Date(Date.now() + 3600000).toISOString(),
      reason: '429 rate limit',
    });
    const continued = await turn(id, turnBody(CONTINUE_TEXT, { profile, level: 'medium' }));
    expect(continued.status).toBe(200);
    expect(answerOf(continued.events)).toMatchObject({
      sessionId: last.sessionId,
      chairId: last.chairId,
    });
  });
  it('continues reusable steps, forks on its snapshot, and starts anew on a profile or level switch', async () => {
    const profile = await profileWith('thread flow', {});
    const graph = writerFlow({ critic1: 'fake-slow', critic2: 'fake-slow', critic3: 'fake-slow' });
    expect(
      (
        await call(`/api/profiles/${profile}`, {
          method: 'PUT',
          headers: web(),
          body: { flow: graph },
        })
      ).status,
    ).toBe(200);
    const id = newThread('custom');
    const opened = openTurn(id, turnBody('Original flow question', { profile, level: 'medium' }));
    const round = await opened.event('round');
    const originalId = round.sessionId as string;
    const frozen = canonicalFlow(requireValue(session(originalId).settings.flow));
    await until(() =>
      requireValue((session(originalId).nodes[round.chairId as string] as ChairNode).steps)
        .filter((step) => step.form === 'member')
        .some((step) => step.run.state === 'running'),
    );
    opened.hangUp();
    await opened.ended;
    const changed = writerFlow();
    requireValue(agentsOf(changed)[0]).rules += ' Updated profile instructions.';
    expect(
      (
        await call(`/api/profiles/${profile}`, {
          method: 'PUT',
          headers: web(),
          body: { flow: changed },
        })
      ).status,
    ).toBe(200);
    const resumed = await turn(id, turnBody(CONTINUE_TEXT, { profile, level: 'medium' }));
    const answer = answerOf(resumed.events);
    expect(answer.sessionId).toBe(originalId);
    const recovered = session(originalId);
    expect(canonicalFlow(requireValue(recovered.settings.flow))).toBe(frozen);
    expect(
      requireValue(
        requireValue((recovered.nodes[answer.chairId as string] as ChairNode).steps).find(
          (step) => step.id === 'writer',
        ),
      ).attempts,
    ).toHaveLength(1);
    const checklist = planOfEvent(resumed.events[0]);
    expect(checklist.map((step) => step.content.split(' · ')[0])).toEqual([
      'Writer',
      'Critic 1',
      'Critic 2',
      'Critic 3',
      'Rewriter',
    ]);
    expect(new Set(checklist.map((step) => step.content)).size).toBe(5);
    for (const event of resumed.events)
      if (event.type === 'progress')
        expect(event.text).not.toMatch(/Member [A-Z]|Findings|recommendation/u);
    const from = { sessionId: originalId, chairId: answer.chairId };
    const fork = answerOf(
      (
        await turn(
          newThread('flowfork'),
          turnBody('A fork from the flow', { profile, level: 'medium', from }),
        )
      ).events,
    );
    expect(fork.sessionId).toBe(originalId);
    const switched = answerOf(
      (await turn(id, turnBody('Another profile', { profile: 'default', level: 'medium' }))).events,
    );
    expect(switched.sessionId).not.toBe(originalId);
    const leveled = answerOf(
      (
        await turn(
          newThread('flowlevel'),
          turnBody('Another level', { profile, level: 'low', from }),
        )
      ).events,
    );
    expect(leveled.sessionId).not.toBe(originalId);
    expect(session(leveled.sessionId as string).settings.level).toBe('low');
    expect(
      (await call(`/api/profiles/${profile}`, { method: 'DELETE', headers: web() })).status,
    ).toBe(200);
    expect(
      (
        await call('/api/profiles', {
          headers: web(),
          body: { name: 'Remade thread flow', id: profile },
        })
      ).status,
    ).toBe(201);
    expect(
      answerOf(
        (
          await turn(
            newThread('flowremade'),
            turnBody('A remade profile', { profile, level: 'medium', from }),
          )
        ).events,
      ).sessionId,
    ).not.toBe(originalId);
  }, 15000);
});
