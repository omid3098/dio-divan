import { seatsOf } from '../src/shared/flow.ts';
import { requireValue } from './fixtures.ts';
// The gateway and the /v1 handler on their own (real engine and store, fake harnesses): what a cached answer is an answer of,
// the in-flight registry, and a client that leaves before the council has been asked.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Engine } from '../src/server/engine.ts';
import { type Answer, Gateway, identityOf, type Pending } from '../src/server/gateway.ts';
import { handleV1 } from '../src/server/openai.ts';
import { SettingsService } from '../src/server/settings.ts';
import { Store } from '../src/server/store.ts';
import { agentsOf, type Flow, finalAgent } from '../src/shared/flow.ts';
import { roundLink } from '../src/shared/round-link.ts';
import type { ChairNode } from '../src/shared/types.ts';
import { writerFlow } from './fixtures/flows.ts';

beforeAll(() => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
});

let home: string;
let store: Store;
let engine: Engine;
let settings: SettingsService;
let gateway: Gateway;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'divan-gw-'));
  store = new Store(home);
  await store.init();
  engine = new Engine(store, () => undefined);
  settings = new SettingsService(store);
  gateway = new Gateway(engine, store, settings);
});
afterEach(async () => {
  await engine.flush();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ask = async (model = 'default', content = 'Which first?'): Promise<Answer> =>
  (await gateway.submit({ model, messages: [{ role: 'user', content }] })).done;

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('flow identities and frozen branches', () => {
  it('resolves chairman tools per profile and level, moving both fingerprints and the execution cache identity', async () => {
    const made = await settings.create('chairman tools');
    await settings.update(made.id, {
      overrides: { chairman: { harness: 'claude', memory: false } },
    });
    const on = requireValue(await settings.profile(made.id));
    const sameRevision = structuredClone(on);
    sameRevision.levels.medium.effective.chairman.tools = false;
    expect(identityOf(sameRevision, [])).not.toBe(identityOf(on, []));
    await settings.update(made.id, {
      overrides: { chairman: { harness: 'claude', tools: false, memory: false } },
      levels: { high: { chairman: { tools: true } } },
    });
    const off = requireValue(await settings.profile(made.id));
    expect(off.fingerprint).not.toBe(on.fingerprint);
    expect(off.levels.medium.fingerprint).not.toBe(on.levels.medium.fingerprint);
    expect(off.effective.chairman.tools).toBe(false);
    expect(off.levels.medium.effective.chairman.tools).toBe(false);
    expect(off.levels.high.effective.chairman.tools).toBe(true);
    const answer = await ask(made.id);
    const session = requireValue(store.get(answer.sessionId));
    expect(finalAgent(requireValue(session.settings.flow)).tools).toBe(false);
    expect(session.settings.chairmanRules).not.toContain('Check before you write');
    for (const harness of ['codex', 'grok'] as const) {
      await settings.update(made.id, {
        overrides: { chairman: { harness, tools: false } },
        levels: { high: { chairman: { tools: false } } },
      });
      const forced = requireValue(await settings.profile(made.id));
      expect(forced.effective.chairman.tools).toBe(true);
      expect(forced.levels.high.effective.chairman.tools).toBe(true);
      expect(forced.notes).toContainEqual(
        expect.objectContaining({
          code: 'seat_toggle_on',
          params: { seat: 'chairman', toggle: 'tools' },
        }),
      );
    }
  });

  it('hashes execution, schemas, access, wires and quorum, independent of canvas and object/array order', async () => {
    const made = await settings.create('flow identity');
    await settings.update(made.id, { flow: writerFlow() });
    const profile = requireValue(await settings.profile(made.id));
    const original = identityOf(profile, []);
    const changed = structuredClone(profile);
    const flow = requireValue(changed.levels.medium.effective.flow);
    flow.nodes.reverse();
    flow.edges.reverse();
    requireValue(agentsOf(flow)[0]).position = { x: 12, y: 43 };
    expect(identityOf(changed, [])).toBe(original);
    const edits = [
      (flow: Flow) => {
        requireValue(agentsOf(flow)[0]).rules += ' Check the sources.';
      },
      (flow: Flow) => {
        requireValue(agentsOf(flow)[0]).schema.description = 'A different form';
      },
      (flow: Flow) => {
        requireValue(agentsOf(flow)[0]).tools = false;
      },
      (flow: Flow) => {
        requireValue(flow.edges[0]).anonymous = !requireValue(flow.edges[0]).anonymous;
      },
      (flow: Flow) => {
        requireValue(requireValue(agentsOf(flow).find((agent) => agent.responses)).responses).min =
          3;
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(profile);
      edit(requireValue(copy.levels.medium.effective.flow));
      expect(identityOf(copy, [])).not.toBe(original);
    }
    expect(
      identityOf(profile, [{ harness: 'pi', model: 'fake-1', until: future(), reason: 'rate' }]),
    ).not.toBe(original);
  });

  it('shares a flow call, counts every step, freezes branches after edits, and separates a profile switch', async () => {
    const made = await settings.create('flow gateway');
    await settings.update(made.id, { flow: writerFlow() });
    const request = { model: made.id, messages: [{ role: 'user', content: 'First flow turn' }] };
    const [one, two] = await Promise.all([gateway.submit(request), gateway.submit(request)]);
    const [first, shared] = await Promise.all([one.done, two.done]);
    expect(shared.sessionId).toBe(first.sessionId);
    const session = requireValue(store.get(first.sessionId));
    const firstChair = session.nodes[first.chairId] as ChairNode;
    expect(firstChair.steps).toHaveLength(5);
    expect(first.usage.total).toBe(
      firstChair.attempts.reduce((sum, call) => sum + (call.usage?.total ?? 0), 0),
    );
    await expect((await gateway.submit(request)).done).resolves.toMatchObject({ cached: true });
    const edited = writerFlow();
    await settings.editLibrary('prompts', 'POST', undefined, {
      id: 'new-report',
      name: 'New report',
      from: 'divan.report',
      text: 'Write a report. NEW RULE',
    });
    requireValue(agentsOf(edited).find((agent) => agent.id === 'writer')).prompt = 'new-report';
    await settings.update(made.id, { flow: edited });
    const messages = [
      ...request.messages,
      {
        role: 'assistant',
        content: `${first.content}\n\n${roundLink('http://localhost/open/t', first, 'Open in Divan')}`,
      },
      { role: 'user', content: 'Follow the flow' },
    ];
    const next = await (await gateway.submit({ model: made.id, messages })).done;
    expect(next.sessionId).toBe(first.sessionId);
    expect(requireValue(store.get(next.sessionId)).settings.flow).toEqual(session.settings.flow);
    expect((await (await gateway.submit({ model: made.id, messages })).done).cached).toBe(true);
    expect(
      (await (await gateway.submit({ model: made.id, messages: request.messages })).done).cached,
    ).toBe(false);
    const other = await settings.create('other flow', made.id);
    expect((await (await gateway.submit({ model: other.id, messages })).done).sessionId).not.toBe(
      first.sessionId,
    );
    await settings.remove(made.id);
    await settings.create('Remade flow', undefined, made.id);
    await settings.update(made.id, { flow: edited });
    expect((await (await gateway.submit({ model: made.id, messages })).done).sessionId).not.toBe(
      first.sessionId,
    );
  }, 10000);
});

describe('what a cached answer is an answer of', () => {
  it('a change in what the profile resolves to (availability, deletion and remaking) misses the cache', async () => {
    const first = await ask();
    expect(first.cached).toBe(false);
    expect((await ask()).cached).toBe(true);

    // a model went out of credit: the seats that would run are not the ones that answered
    await store.addUnavailable({
      harness: 'claude',
      model: 'fake-1',
      prefix: '',
      until: future(),
      reason: 'no credit',
    });
    const afterOutage = await ask();
    expect(afterOutage.cached).toBe(false);
    expect(afterOutage.sessionId).not.toBe(first.sessionId);
    expect((await ask()).cached).toBe(true);

    // a profile deleted and made again with the same name and the same settings is not the one that answered
    const made = await settings.create('mine');
    const answered = await ask(made.id);
    expect((await ask(made.id)).cached).toBe(true);
    await settings.remove(made.id);
    const remade = await settings.create('mine');
    expect(remade.id).toBe(made.id);
    expect((await settings.profile(made.id))?.revision).toBe(1);
    const again = await ask(made.id);
    expect(again.cached).toBe(false);
    expect(again.sessionId).not.toBe(answered.sessionId);
  }, 20_000);
});

describe('a seat chosen explicitly', () => {
  it('a model that is chosen by an override and then goes out of credit misses the cache (the council that would run changed)', async () => {
    // the override names a model of its own: the defaults never knew it
    await settings.update('default', { overrides: { seats: { claude: { model: 'fake-2' } } } });
    const first = await ask();
    expect(first.cached).toBe(false);
    expect((await ask()).cached).toBe(true);
    await store.addUnavailable({
      harness: 'claude',
      model: 'fake-2',
      until: future(),
      reason: '429 rate limit',
    });
    // nothing in the settings changed, yet the seats that would run did
    const profile = await settings.profile('default');
    expect(profile?.effective.seats.find((seat) => seat.harness === 'claude')?.model).toBe(
      'fake-2',
    );
    const second = await ask();
    expect(second.cached).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    const chair = store.get(second.sessionId)?.nodes[second.chairId] as ChairNode;
    expect(seatsOf(chair).find((seat) => seat.harness === 'claude')?.state).toBe('skipped');
  });
});

describe('the in-flight registry', () => {
  /** A profile whose members hang until they are cancelled. */
  async function hanging(): Promise<string> {
    const made = await settings.create('hang');
    await settings.update(made.id, {
      overrides: {
        seats: Object.fromEntries(
          ['claude', 'codex', 'grok', 'pi'].map((id) => [id, { model: 'fake-hang' }]),
        ),
      },
    });
    return made.id;
  }

  it('an entry is removed only by its own end: a newer request that took the key is never forgotten', async () => {
    const id = await hanging();
    const messages = [{ role: 'user', content: 'Hold on.' }];
    const a = await gateway.submit({ model: id, messages });
    a.done.catch(() => undefined);
    a.release(); // nobody waits: the round is cancelled and the entry forgotten
    const b = await gateway.submit({ model: id, messages });
    b.done.catch(() => undefined);
    // a's round ends now (cancelled): its end must not take b's entry with it
    await new Promise((resolve) => setTimeout(resolve, 300));
    const c = await gateway.submit({ model: id, messages });
    c.done.catch(() => undefined);
    expect(store.list().length).toBe(2); // a's session and b's: c joined b's run
    b.release();
    c.release();
    await Promise.allSettled([a.done, b.done, c.done]);
    const rounds = store
      .list()
      .flatMap((item) => Object.values(store.get(item.id)?.nodes ?? {}))
      .filter((node): node is ChairNode => node.kind === 'chair');
    expect(rounds.every((round) => round.status === 'cancelled')).toBe(true);
  });
});

describe('a client that leaves before the council has been asked', () => {
  it('while the round is being admitted: nothing is admitted and no member is asked', async () => {
    const left = new AbortController();
    const asking = gateway.submit({
      model: 'default',
      messages: [{ role: 'user', content: 'Gone already?' }],
      signal: left.signal,
    });
    left.abort(); // the connection closed before the run was even registered
    await expect(asking).rejects.toMatchObject({ status: 499, code: 'cancelled' });
    expect(store.list()).toEqual([]);
    // the next identical request is not stuck behind it
    const again = await gateway.submit({
      model: 'default',
      messages: [{ role: 'user', content: 'Gone already?' }],
    });
    expect((await again.done).cached).toBe(false);
  });

  it('lets go of the round as soon as the gateway hands it back', async () => {
    let released = 0;
    let gate: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
      gate = resolve;
    });
    // a gateway that takes its time before it answers, and counts what is released
    const slow = {
      async submit(): Promise<Pending> {
        await opened;
        return {
          profileId: 'default',
          language: 'en',
          notes: [],
          subscribe: () => () => undefined,
          done: new Promise<Answer>(() => undefined),
          release: () => {
            released += 1;
          },
        };
      },
    } as unknown as Gateway;
    const server = createServer((req, res) => {
      handleV1(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), {
        gateway: slow,
        profiles: async () => [],
        link: () => 'http://x',
      }).catch(() => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const body = JSON.stringify({
      model: 'default',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => undefined);
    req.end(body);
    // the request has arrived and the gateway is still thinking: the client goes away
    await new Promise((resolve) => setTimeout(resolve, 150));
    req.destroy();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(released).toBe(0);
    gate();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(released).toBe(1);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  });
});

describe('the text an endpoint client gets', () => {
  const node = (answer: string, choice: string | null) =>
    ({
      answer,
      questionsForUser: [],
      recommendation: choice === null ? null : { choice, confidence: 0.7 },
    }) as unknown as ChairNode;

  it('starts with the recommendation, which the web app shows in a box above the answer instead', async () => {
    const { answerText } = await import('../src/server/gateway.ts');
    expect(answerText(node('Measure the cost first.', 'Start small'))).toBe(
      '**Recommendation:** Start small (confidence 70%)\n\nMeasure the cost first.',
    );
    expect(answerText(node('هزینه را بسنج.', 'کوچک شروع کن'))).toBe(
      '**پیشنهاد:** کوچک شروع کن (اطمینان 70%)\n\nهزینه را بسنج.',
    );
    // no recommendation, nothing to add
    expect(answerText(node('Measure the cost first.', null))).toBe('Measure the cost first.');
  });

  it('does not say it twice when the answer already does (an older round)', async () => {
    const { answerText } = await import('../src/server/gateway.ts');
    const old = '**Recommendation:** start small.\n\nMeasure the cost first.';
    expect(answerText(node(old, 'Start small'))).toBe(old);
  });
});
