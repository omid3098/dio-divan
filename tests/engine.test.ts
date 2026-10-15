import { chairmanOf, seatsOf } from '../src/shared/flow.ts';
// The round engine with the fake harnesses: one seat's exception never ends a round, persistence failures are handled,
// a retry keeps the spend, a cancel stops only its round, and a configuration the council rules forbid is refused.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as agents from '../src/server/adapters/index.ts';
import type { RunSpec } from '../src/server/adapters/types.ts';
import { planOf } from '../src/server/divan-api.ts';
import { Engine, EngineError } from '../src/server/engine.ts';
import { slugify } from '../src/server/settings.ts';
import { type Overlay, Store, serializeSession } from '../src/server/store.ts';
import { chairmanKey, computeDefaults } from '../src/shared/defaults.ts';
import { classifyFailure, SKIPPED_BY_USER, SKIPPED_SAME_FAMILY } from '../src/shared/failure.ts';
import { agentsOf, compileCouncil, type FlowStep, finalAgent, stepOf } from '../src/shared/flow.ts';
import { type Note, note } from '../src/shared/messages.ts';
import type {
  ChairNode,
  HarnessModels,
  ServerEvent,
  Session,
  SessionNode,
} from '../src/shared/types.ts';
import { flowInput, singleFlow, writerFlow } from './fixtures/flows.ts';
import { requireValue } from './fixtures.ts';

beforeAll(() => {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '5';
});

it('Hermes is refused at admission and launch on a non-Windows platform, even in fake mode', async () => {
  const { engine } = await setup();
  const flow = singleFlow();
  const assistant = agentsOf(flow)[0];
  if (!assistant) throw new Error('fixture assistant');
  assistant.harness = 'hermes';
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    await expect(engine.createSession({ ...flowInput(), seats: [], flow })).rejects.toMatchObject({
      code: 'hermes_platform',
    });
    expect(
      (
        await agents.runAgent({
          harness: 'hermes',
          model: 'fake-1',
          effort: '',
          tools: false,
          memory: false,
          web: false,
          prompt: 'fixture',
          schema: { type: 'object' },
          idleMs: 1000,
        })
      ).error,
    ).toBe(note('hermes_platform').message);
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});

it('one assistant answers directly with the fakes and continues without member inputs', async () => {
  const { engine } = await setup();
  const session = await engine.createSession({ ...flowInput(), seats: [], flow: singleFlow() });
  const first = chairOf(session);
  await until(() => first.status !== 'running');
  expect(first.status).toBe('done');
  expect(first.steps).toHaveLength(1);
  expect(first.answer).toContain('Which reversible step');
  expect(first.agreement).toBeNull();
  expect(first.dissent).toBeNull();
  expect(first.seatScores).toEqual([]);
  expect(chairmanOf(first).input).not.toMatch(/member|chairman|report|council/iu);
  expect(planOf(session, first)).toEqual([
    { content: 'Assistant · Pi · fake-1 · medium', status: 'completed' },
  ]);
  const next = await engine.startRound(session.id, first.id, 'What about the budget?');
  const second = session.nodes[next.chairId] as ChairNode;
  await until(() => second.status !== 'running');
  expect(second.status).toBe('done');
  expect(second.answer).toContain('What about the budget');
  expect(chairmanOf(second).input).toContain('<address_form>formal</address_form>');
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-eng-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/**
 * A store whose saves can be made to fail, whose writes can be made slow (the real race: a write in progress while other
 * saves queue behind it), and that remembers what each save wrote.
 */
class FlakyStore extends Store {
  failWhen: ((session: Session, finals: SessionNode[]) => boolean) | null = null;
  /** Milliseconds a write of the text that holds a finished round takes. */
  slowFinalMs = 0;
  /** A write this returns a promise for waits for it (it can reject: the disk fails after the write was started). */
  holdWrite: ((text: string) => Promise<void> | undefined) | null = null;
  /** What each save wrote, parsed. */
  written: Session[] = [];
  override async save(session: Session, over: Overlay = {}): Promise<void> {
    if (this.failWhen?.(session, over.nodes ?? [])) throw new Error('disk full');
    this.written.push(JSON.parse(serializeSession(session, over)) as Session);
    return super.save(session, over);
  }
  protected override async write(file: string, text: string): Promise<void> {
    await this.holdWrite?.(text);
    if (
      this.slowFinalMs > 0 &&
      /"status":"done"/u.test(text) &&
      Object.values((JSON.parse(text) as Session).nodes).some(
        (node) => node.kind === 'chair' && chairmanOf(node).state === 'done',
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, this.slowFinalMs));
    }
    return super.write(file, text);
  }
}

async function setup() {
  const store = new FlakyStore(home);
  await store.init();
  const events: ServerEvent[] = [];
  const engine = new Engine(store, (event) => events.push(event));
  return { store, engine, events };
}

const seat = (id: string, model: string, harness: 'claude' | 'codex' | 'grok' | 'pi' = 'pi') => ({
  id,
  enabled: true,
  harness,
  model,
  effort: '',
  tools: harness === 'codex' || harness === 'grok',
  memory: false,
  web: false,
});
const budgets = { maxClaims: 5, maxWords: 30 };
const input = (models: string[]) => ({
  question: 'سنجش',
  seats: models.map((model, index) => seat(`s${index}`, model)),
  chairman: { harness: 'pi' as const, model: 'fake-2', effort: '' },
  budgets,
});
const chairOf = (session: Session, round = 1) =>
  Object.values(session.nodes).find(
    (n): n is ChairNode => n.kind === 'chair' && n.round === round,
  ) as ChairNode;

describe('flow barriers and recovery', () => {
  it('a version-1 partial retry atomically drops legacy payloads and advances the format', async () => {
    const { engine, store } = await setup();
    const started = await engine.createSessionWithRound(input(['fake-1', 'fake-fail']));
    expect(await started.round.done).toBe('failed');
    const { session } = started;
    const chair = chairOf(session);
    chair.seats = structuredClone(seatsOf(chair));
    chair.chairman = structuredClone(chairmanOf(chair));
    delete chair.steps;
    session.schemaVersion = 1;
    const old = chair.seats.find((run) => run.state === 'done') as NonNullable<
      ChairNode['seats']
    >[number];
    old.rawOutput = 'OLD-RAW-SECRET';
    (old.sanitized as NonNullable<typeof old.sanitized>).report = 'OLD-REPORT-SECRET';
    await store.save(session);
    for (const seat of session.settings.seats) seat.model = 'fake-hang';
    const before = structuredClone(chair);
    store.failWhen = () => true;
    await expect(engine.rerun(session.id, chair.id)).rejects.toMatchObject({ code: 'save_failed' });
    expect(chair).toEqual(before);
    expect(session.schemaVersion).toBe(1);
    store.failWhen = null;
    await engine.rerun(session.id, chair.id);
    const retry = engine.follow(session.id, chair.id);
    try {
      await until(() => seatsOf(chair).every((run) => run.state === 'running'));
      await engine.rename(session.id, 'during replacement calls');
      const text = readFileSync(join(home, 'sessions', `${session.id}.json`), 'utf8');
      expect(text).not.toMatch(/OLD-(RAW|REPORT)-SECRET/u);
      const saved = JSON.parse(text) as Session;
      expect(saved.schemaVersion).toBe(2);
      expect(session.schemaVersion).toBe(2);
      for (const node of [chair, chairOf(saved)]) {
        expect(node.steps).toHaveLength(3);
        expect(node).not.toHaveProperty('seats');
        expect(node).not.toHaveProperty('chairman');
      }
    } finally {
      retry?.cancel();
      await retry?.done;
    }
  });

  it.each(['council', 'writer'])(
    'recovery preserves released activity for %s and treats old missing counts as unknown',
    async (layout) => {
      const { engine, store } = await setup();
      const original = agents.runAgent;
      const counts = { file: 14, memory: 6, thread: 2, web: 3, other: 0 };
      vi.spyOn(agents, 'runAgent').mockImplementation(async (spec) => {
        for (const kind of ['file', 'memory', 'thread', 'web'] as const)
          spec.onSignal?.({
            tools: Array.from({ length: counts[kind] }, () => ({
              kind,
              name: 'read',
              target: 'PRIVATE-TARGET',
            })),
          });
        return original(spec);
      });
      const started = await engine.createSessionWithRound({
        ...flowInput(),
        ...(layout === 'writer' ? { flow: writerFlow() } : {}),
      });
      await started.round.done;
      const snapshot = store.written.find((saved) => {
        const steps = chairOf(saved).steps ?? [];
        return (
          steps
            .filter((step) => step.form === 'member')
            .every((step) => step.run.state === 'done') &&
          steps.find((step) => step.form === 'answer')?.run.state === 'pending'
        );
      }) as Session;
      expect(snapshot).toBeDefined();
      const members = (chairOf(snapshot).steps ?? []).filter((step) => step.form === 'member');
      for (const member of members) {
        expect(member.run.activity).toEqual(counts);
        expect(member.run.toolLog).toBeUndefined();
        expect(member.run.rawOutput).toBe('');
      }
      for (const historical of [false, true]) {
        const saved = structuredClone(snapshot);
        const missing = chairOf(saved).steps?.find((step) => step.form === 'member')?.run;
        if (historical && missing) delete missing.activity;
        const crashHome = join(home, `activity-${historical}`);
        mkdirSync(join(crashHome, 'sessions'), { recursive: true });
        writeFileSync(join(crashHome, 'sessions', `${saved.id}.json`), JSON.stringify(saved));
        const recovered = new Store(crashHome);
        await recovered.init();
        const session = recovered.get(saved.id) as Session;
        const round = chairOf(session);
        const before = round.attempts.length;
        const retry = new Engine(recovered, () => {});
        await retry.rerun(session.id, round.id);
        await retry.follow(session.id, round.id)?.done;
        expect(round.status).toBe('done');
        expect(round.attempts.length - before).toBe(1);
        const prompt = chairmanOf(round).input;
        expect(
          prompt.match(/read 14 files, 6 memory pages, 2 threads and 3 web pages/gu),
        ).toHaveLength(members.length - Number(historical));
        expect(prompt).not.toContain('used no file, memory, thread or web');
        if (historical)
          expect(prompt).toContain(
            `Member ${layout === 'writer' && missing ? stepOf(round, 'rewriter')?.aliases[missing.seatId] : missing?.label}: activity was not recorded for this run.`,
          );
      }
    },
  );

  it.each(['writer', 'critic3', 'rewriter'])(
    'cancellation during %s stops the wave and starts no dependent call',
    async (id) => {
      const { engine } = await setup();
      const started = await engine.createSessionWithRound({
        ...flowInput(),
        flow: writerFlow({ [id]: 'fake-hang' }),
      });
      const chair = chairOf(started.session);
      await until(() => stepOf(chair, id)?.run.state === 'running');
      started.round.cancel();
      expect(await started.round.done).toBe('cancelled');
      expect(chair.steps?.some((step) => step.run.state === 'running')).toBe(false);
      if (id === 'writer') expect(chair.attempts).toHaveLength(1);
      if (id === 'critic3')
        expect(chair.attempts.some((attempt) => attempt.kind === 'chairman')).toBe(false);
      expect(chair.usage.total).toBeGreaterThan(0);
    },
  );

  it('atomically removes a saved critic response before retrying its failed peers', async () => {
    const { engine } = await setup();
    const started = await engine.createSessionWithRound({
      ...flowInput(),
      flow: writerFlow({ critic2: 'fake-fail', critic3: 'fake-fail' }),
    });
    await started.round.done;
    const chair = chairOf(started.session);
    const file = join(home, 'sessions', `${started.session.id}.json`);
    expect(
      (
        stepOf(chairOf(JSON.parse(readFileSync(file, 'utf8')) as Session), 'critic1') as Extract<
          FlowStep,
          { form: 'member' }
        >
      ).run.sanitized,
    ).not.toBeNull();
    await engine.rerun(started.session.id, chair.id);
    const saved = chairOf(JSON.parse(readFileSync(file, 'utf8')) as Session);
    expect(
      (stepOf(saved, 'critic1') as Extract<FlowStep, { form: 'member' }>).run.sanitized,
    ).toBeNull();
    expect((stepOf(saved, 'critic1') as Extract<FlowStep, { form: 'member' }>).run.rawOutput).toBe(
      '',
    );
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.attempts.filter((attempt) => attempt.seatId === 'critic1')).toHaveLength(1);
    expect(chair.attempts.filter((attempt) => attempt.seatId === 'writer')).toHaveLength(1);
  });
  it('runs both fake layouts end to end, with only one stored step list and critic-only scores', async () => {
    const { engine } = await setup();
    for (const flow of [undefined, writerFlow()]) {
      const started = await engine.createSessionWithRound({
        ...flowInput(),
        ...(flow ? { flow } : {}),
      });
      expect(await started.round.done).toBe('done');
      const chair = chairOf(started.session);
      expect(chair.seats).toBeUndefined();
      expect(chair.chairman).toBeUndefined();
      expect(started.session.schemaVersion).toBe(2);
      expect(chair.steps).toHaveLength(flow ? 5 : 4);
      const refs = chair.steps?.flatMap((step) => step.attempts).sort((a, b) => a - b);
      expect(refs).toEqual(chair.attempts.map((_, index) => index));
      if (flow) {
        expect(stepOf(chair, 'writer')?.run.state).toBe('done');
        for (const critic of chair.steps?.filter((step) => step.form === 'member') ?? []) {
          expect((critic.run as { prompt: string }).prompt).toContain('<<<UPSTREAM');
          expect((critic.run as { prompt: string }).prompt).toContain(
            'Criticise the supplied draft',
          );
          expect(
            (critic as Extract<FlowStep, { form: 'member' }>).run.parsed?.votes,
          ).toBeUndefined();
        }
        expect(chair.agreement?.of).toBe(3);
        expect(chair.seatScores).toHaveLength(3);
        expect(chairmanOf(chair).input.match(/^<question>/gmu)).toHaveLength(1);
      }
    }
  });

  it('reuses every durable barrier after a crash, without repeating saved prerequisites', async () => {
    const { engine, store } = await setup();
    const started = await engine.createSessionWithRound({ ...flowInput(), flow: writerFlow() });
    await started.round.done;
    const chair = chairOf(started.session);
    const states = (snapshot: Session) =>
      (snapshot.nodes[chair.id] as ChairNode).steps as FlowStep[];
    const snapshots = [
      store.written.find((s) => states(s).every((step) => step.run.state === 'pending')),
      store.written.find(
        (s) => states(s)[0]?.run.state === 'done' && states(s)[1]?.run.state === 'pending',
      ),
      store.written.find(
        (s) =>
          states(s)
            .filter((step) => step.form === 'member')
            .every((step) => step.run.state === 'done') &&
          states(s).at(-1)?.run.state === 'pending',
      ),
      store.written.find((s) => (s.nodes[chair.id] as ChairNode).status === 'done'),
    ];
    expect(snapshots.every(Boolean)).toBe(true);
    for (const [index, snapshot] of snapshots.entries()) {
      const crashHome = join(home, `barrier-${index}`);
      mkdirSync(join(crashHome, 'sessions'), { recursive: true });
      writeFileSync(
        join(crashHome, 'sessions', `${started.session.id}.json`),
        JSON.stringify(snapshot),
      );
      const recovered = new Store(crashHome);
      await recovered.init();
      const session = recovered.get(started.session.id) as Session;
      const round = chairOf(session);
      const before = round.attempts.length;
      if (index < 3) {
        const retry = new Engine(recovered, () => {});
        await retry.rerun(session.id, round.id);
        await retry.follow(session.id, round.id)?.done;
        expect(round.status).toBe('done');
        expect(round.attempts.length - before).toBe([5, 4, 1][index]);
      } else expect(round.status).toBe('done');
    }
  });

  it('keeps the draft safe through layout/rename saves, and withholds critics and input-bearing prompts', async () => {
    const { engine, store } = await setup();
    const started = await engine.createSessionWithRound({
      ...flowInput(),
      flow: writerFlow({ critic3: 'fake-hang' }),
    });
    const chair = chairOf(started.session);
    await until(
      () =>
        chair.steps?.filter((step) => step.form === 'member' && step.run.state === 'done')
          .length === 2,
    );
    await engine.rename(started.session.id, 'during critics');
    await engine.setLayout(started.session.id, { opId: 'flow-layout', direction: 'LR', nodes: {} });
    const text = readFileSync(join(home, 'sessions', `${started.session.id}.json`), 'utf8');
    const saved = chairOf(JSON.parse(text) as Session);
    expect(stepOf(saved, 'writer')).toMatchObject({
      run: {
        state: 'done',
        parsed: null,
        rawOutput: '',
        sanitized: { report: expect.any(String) },
      },
    });
    for (const step of saved.steps ?? []) {
      if (step.form === 'answer') expect(step.run.input).toBe('');
      else {
        expect(step.run.prompt).toBe('');
        if (step.form === 'member') expect(step.run.sanitized).toBeNull();
      }
    }
    started.round.cancel();
    expect(await started.round.done).toBe('cancelled');
    expect(
      store.written.some((snapshot) => stepOf(chairOf(snapshot), 'writer')?.run.state === 'done'),
    ).toBe(true);
  });

  it('a failed checkpoint starts no downstream call, and a failed retry write changes nothing', async () => {
    const { engine, store } = await setup();
    store.failWhen = (session) => {
      const round = Object.values(session.nodes).find(
        (node): node is ChairNode => node.kind === 'chair',
      );
      return !!round && stepOf(round, 'writer')?.run.state === 'done';
    };
    const started = await engine.createSessionWithRound({ ...flowInput(), flow: writerFlow() });
    expect(await started.round.done).toBe('failed');
    const chair = chairOf(started.session);
    expect(chair.attempts).toHaveLength(1);
    const before = structuredClone(chair);
    await expect(engine.rerun(started.session.id, chair.id)).rejects.toMatchObject({
      code: 'save_failed',
    });
    expect(chair).toEqual(before);
    store.failWhen = null;
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(chair.attempts.filter((attempt) => attempt.seatId === 'writer')).toHaveLength(1);
  });

  it('a failed final write never announces success, and a retry publishes without asking again', async () => {
    const { engine, store, events } = await setup();
    store.failWhen = (_session, finals) =>
      finals.some((node) => node.kind === 'chair' && node.status === 'done');
    const started = await engine.createSessionWithRound({
      ...flowInput(),
      flow: writerFlow({ critic3: 'fake-fail' }),
    });
    expect(await started.round.done).toBe('failed');
    const chair = chairOf(started.session);
    expect(chair.attempts).toHaveLength(5);
    expect(
      events.some(
        (event) =>
          event.type === 'node' && event.node.kind === 'chair' && event.node.status === 'done',
      ),
    ).toBe(false);
    store.failWhen = null;
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(chair.attempts).toHaveLength(5);
  });

  it('a draft and one critic cannot finish; lenses and invalid graphs are refused before admission', async () => {
    const { engine, store } = await setup();
    const started = await engine.createSessionWithRound({
      ...flowInput(),
      flow: writerFlow({ critic2: 'fake-invalid', critic3: 'fake-fail' }),
    });
    expect(await started.round.done).toBe('failed');
    expect(stepOf(chairOf(started.session), 'rewriter')?.run.state).toBe('blocked');
    expect(chairOf(started.session).steps?.some((step) => step.run.state === 'pending')).toBe(
      false,
    );
    const count = store.list().length;
    await expect(
      engine.createSession({ ...flowInput(), flow: writerFlow(), lensMode: 'angle' }),
    ).rejects.toMatchObject({ code: 'flow_lenses' });
    const bad = writerFlow();
    bad.edges.push({ from: 'rewriter', to: 'writer', anonymous: true });
    await expect(engine.createSession({ ...flowInput(), flow: bad })).rejects.toMatchObject({
      code: 'bad_flow',
    });
    const badSchema = writerFlow();
    const answerSchema = requireValue(
      agentsOf(badSchema).find((agent) => agent.form === 'answer'),
    ).schema;
    answerSchema.required = ['title', 'answer'];
    answerSchema.properties = { title: { type: 'string' }, answer: { type: 'string' } };
    await expect(engine.createSession({ ...flowInput(), flow: badSchema })).rejects.toMatchObject({
      code: 'bad_flow',
    });
    expect(store.list()).toHaveLength(count);
  });
});

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

it('long flows keep round labels unique, progress attached to step ids and recipient aliases local', async () => {
  const { engine } = await setup();
  const flow = writerFlow({ writer: 'fake-1' });
  const writer = requireValue(
    flow.nodes.find((node) => node.kind === 'agent' && node.id === 'writer'),
  );
  if (writer.kind !== 'agent') throw new Error('writer missing');
  flow.nodes.push({
    ...structuredClone(writer),
    id: 'writer2',
    model: 'fake-hang',
    required: ['writer'],
  });
  flow.edges.push({ from: 'writer', to: 'writer2', anonymous: true });
  for (const node of flow.nodes)
    if (node.kind === 'agent' && node.id !== 'writer' && node.id !== 'writer2')
      node.required = ['writer2'];
  for (const edge of flow.edges)
    if (edge.from === 'writer' && edge.to !== 'writer2') edge.from = 'writer2';
  const started = await engine.createSessionWithRound({ ...flowInput(), flow });
  const chair = chairOf(started.session);
  const events: import('../src/server/engine.ts').RoundEvent[] = [];
  started.round.subscribe((event) => events.push(event));
  try {
    await until(() => stepOf(chair, 'writer2')?.run.state === 'running');
    const labels = seatsOf(chair).map((run) => run.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(
      events.filter((event) => event.type === 'seat-done').map((event) => event.identity),
    ).toEqual(['Writer 1']);
    expect(
      events.find((event) => event.type === 'seat-start' && event.identity === 'Writer 2')?.stepId,
    ).toBe('writer2');
    engine.skipSeat(started.session.id, chair.id, {
      label: requireValue(seatsOf(chair).find((run) => run.seatId === 'writer2')).label,
    });
    expect(await started.round.done).toBe('failed');
    expect(stepOf(chair, 'writer2')?.run.state).toBe('skipped');
  } finally {
    started.round.cancel();
    await started.round.done;
  }
  requireValue(agentsOf(flow).find((agent) => agent.id === 'writer2')).model = 'fake-1';
  const completed = await engine.createSessionWithRound({ ...flowInput(), flow });
  const completeEvents: import('../src/server/engine.ts').RoundEvent[] = [];
  completed.round.subscribe((event) => completeEvents.push(event));
  expect(await completed.round.done).toBe('done');
  const final = chairOf(completed.session);
  expect(
    completeEvents.filter((event) => event.type === 'seat-done' && event.identity === 'Writer 2'),
  ).toHaveLength(1);
  const critics = seatsOf(final)
    .filter((seat) => seat.seatId.startsWith('critic'))
    .map((seat) => seat.label)
    .sort();
  expect(final.seatScores.map((score) => score.label).sort()).toEqual(critics);
  expect(
    final.claims.flatMap((claim) => claim.from).every((label) => critics.includes(label)),
  ).toBe(true);
});

describe('a round survives its seats', () => {
  it('a thrown adapter exception settles that seat and the round still finishes', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-throw', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    const bySeat = (id: string) => seatsOf(chair).find((s) => s.seatId === id);
    expect([bySeat('s0')?.state, bySeat('s1')?.state, bySeat('s2')?.state]).toEqual([
      'done',
      'failed',
      'done',
    ]);
    expect(seatsOf(chair).some((s) => s.state === 'running' || s.state === 'pending')).toBe(false);
    expect(bySeat('s1')?.error).toMatch(/threw on purpose/u);
    // the call that threw is still on the books
    expect(chair.attempts.filter((a) => a.kind === 'seat')).toHaveLength(3);
  });

  it('fewer than two valid seats fails the round without leaving a seat running', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-throw', 'fake-throw', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('failed');
    expect(seatsOf(chair).every((s) => s.state !== 'running' && s.state !== 'pending')).toBe(true);
  });
});

describe('a member that returns its report as plain text', () => {
  it('is a valid answer: the chairman sees its report and is told the summary is empty, and two such answers are enough', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-prose', 'fake-prose', 'fake-fail']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    const prose = seatsOf(chair).filter((s) => s.model === 'fake-prose');
    expect(prose.map((s) => s.state)).toEqual(['done', 'done']);
    for (const s of prose) {
      expect(s.error).toBeNull();
      expect(s.sanitized).toMatchObject({ reportOnly: true, stance: '', recommendation: null });
      expect(s.sanitized?.report).toBe(s.rawOutput.trim());
      expect(chairmanOf(chair).input).toContain(
        `Member ${s.label}: it returned its report as plain text; its summary fields are empty.`,
      );
    }
    expect(chairmanOf(chair).input).toContain('## Main findings');
  });
});

describe('persistence', () => {
  it('restores the session when the admission save fails', async () => {
    const { engine, store } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    const before = Object.keys(session.nodes).sort();
    store.failWhen = () => true;
    await expect(engine.startRound(session.id, chairOf(session).id, 'نظر')).rejects.toMatchObject({
      code: 'save_failed',
    });
    expect(Object.keys(session.nodes).sort()).toEqual(before);
    store.failWhen = null;
    await expect(engine.startRound(session.id, chairOf(session).id, 'نظر')).resolves.toBeDefined();
  });
});

describe('read-only chairman and activity', () => {
  it.each(['claude', 'pi'] as const)(
    'freezes tools off for a %s chairman, including with a working folder and later rounds',
    async (harness) => {
      const { engine, store } = await setup();
      const original = agents.runAgent;
      const specs: RunSpec[] = [];
      vi.spyOn(agents, 'runAgent').mockImplementation(async (spec) => {
        if ('input_title' in spec.schema.properties) specs.push(spec);
        return original(spec);
      });
      const started = await engine.createSessionWithRound({
        ...input(['fake-1', 'fake-1']),
        folder: home,
        chairman: { harness, model: 'fake-2', effort: '', tools: false, memory: false },
      });
      expect(await started.round.done).toBe('done');
      const { session } = started;
      expect(session.settings.chairman.tools).toBe(false);
      expect(finalAgent(compileCouncil(session.settings)).tools).toBe(false);
      expect(session.settings.chairmanRules).not.toContain('Check before you write');
      const next = await engine.startRound(session.id, started.round.chairId, 'And next?');
      expect(await next.done).toBe('done');
      expect(specs).toHaveLength(2);
      for (const spec of specs)
        expect(spec).toMatchObject({
          tools: false,
          memory: false,
          web: false,
          cwd: realpathSync.native(home),
        });
      const saved = JSON.parse(
        readFileSync(join(store.home, 'sessions', `${session.id}.json`), 'utf8'),
      );
      expect(finalAgent(saved.settings.flow).tools).toBe(false);
      expect(chairmanOf(chairOf(session)).tools).toBe(false);
    },
  );

  it.each(['codex', 'grok'] as const)(
    'refuses an explicit tools-off %s chairman at session admission',
    async (harness) => {
      const { engine } = await setup();
      await expect(
        engine.createSessionWithRound({
          ...input(['fake-1', 'fake-1']),
          chairman: { harness, model: 'fake-2', effort: '', tools: false, memory: false },
        }),
      ).rejects.toMatchObject({ code: 'toggle_forced_on' });
    },
  );

  it('passes tools and the folder to the chairman, stores bounded activity, and writes supervision NDJSON', async () => {
    const { engine } = await setup();
    const original = agents.runAgent;
    const specs: RunSpec[] = [];
    vi.spyOn(agents, 'runAgent').mockImplementation(async (spec) => {
      specs.push(spec);
      for (let i = 0; i < 305; i++) {
        spec.onSignal?.({ tools: [{ kind: 'file', name: 'read', target: 'x'.repeat(220) }] });
      }
      spec.onSignal?.({
        tools: [
          { kind: 'memory', name: 'mcp__memory__search', target: 'plan' },
          { kind: 'thread', name: 'mcp__t3__t3_thread_read', target: 'thread-123' },
          { kind: 'web', name: 'web_search', target: 'source' },
          { kind: 'other', name: 'inspect', target: '' },
        ],
      });
      return original(spec);
    });
    const file = join(home, 'tools.ndjson');
    const was = process.env.DIVAN_TOOL_LOG;
    process.env.DIVAN_TOOL_LOG = file;
    try {
      const session = await engine.createSession({
        ...input(['fake-1', 'fake-1']),
        folder: home,
        chairman: { harness: 'codex', model: 'fake-2', effort: '', memory: false },
      });
      const chair = chairOf(session);
      await until(() => chair.status !== 'running');
      expect(chair.status).toBe('done');
      // the chairman is the one codex call with the chairman's schema; a round an earlier test left running also goes
      // through this spy, and its (pi) chairman is not the one under test
      const chairman = specs.find(
        (spec) => spec.harness === 'codex' && 'input_title' in spec.schema.properties,
      );
      expect(chairman).toMatchObject({
        tools: true,
        memory: false,
        web: false,
        cwd: realpathSync.native(home),
      });
      for (const run of [...seatsOf(chair), chairmanOf(chair)]) {
        expect(run.activity).toEqual({ file: 305, memory: 1, thread: 1, web: 1, other: 1 });
        expect(run.toolLog).toHaveLength(300);
        expect(run.toolLog?.every(({ target }) => target.length <= 200)).toBe(true);
      }
      const chairmanInput = chairmanOf(chair).input;
      expect(chairmanInput).toContain(
        'in this run it read 305 files, 1 memory page, 1 thread and 1 web page.',
      );
      expect(chairmanInput).not.toContain('mcp__memory__search');
      // the log is process-wide: a round an earlier test left running writes to it too, so only this session's lines count
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((event) => event.sessionId === session.id);
      expect(lines).toHaveLength(309 * 3);
      expect(new Set(lines.map(({ seatId }) => seatId))).toEqual(new Set(['s0', 's1', 'chairman']));
      expect(lines.every((event) => event.chairId === chair.id && event.target.length <= 200)).toBe(
        true,
      );
      const saved = JSON.parse(readFileSync(join(home, 'sessions', `${session.id}.json`), 'utf8'));
      expect(chairmanOf(saved.nodes[chair.id]).activity).toEqual(chairmanOf(chair).activity);
    } finally {
      if (was === undefined) delete process.env.DIVAN_TOOL_LOG;
      else process.env.DIVAN_TOOL_LOG = was;
    }
  });
});

describe('spend', () => {
  it('retries each flaky member and chairman once, keeping both calls and their reported usage', async () => {
    const { engine } = await setup();
    const session = await engine.createSession({
      ...input(['fake-flaky', 'fake-flaky']),
      chairman: { harness: 'pi', model: 'fake-flaky', effort: '', memory: false },
    });
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(chair.attempts).toHaveLength(6);
    for (const id of ['s0', 's1', null]) {
      const attempts = chair.attempts.filter((attempt) => attempt.seatId === id);
      expect(attempts.map((attempt) => attempt.state)).toEqual(['failed', 'done']);
      expect(attempts[0]?.error).toBe('Connection closed');
      expect(attempts.every((attempt) => attempt.usage?.source === 'harness')).toBe(true);
    }
    expect(chair.usage.total).toBe(
      chair.attempts.reduce((sum, attempt) => sum + (attempt.usage?.total ?? 0), 0),
    );
  });

  it.each([
    ['ECONNRESET', 2],
    ['ETIMEDOUT', 2],
    ['Connection refused', 2],
    ['socket hang up', 2],
    ['APIConnectionError', 2],
    ['HTTP 503', 2],
    ['{"status_code":503}', 2],
    ['overloaded', 2],
    ['429 overloaded', 1],
    ['Insufficient balance; HTTP 503', 1],
    ['timeout', 1],
    ['invalid output', 1],
    ['cancelled', 1],
  ])('connection policy for %s: at most %i calls', async (error, calls) => {
    const original = agents.runAgent;
    vi.spyOn(agents, 'runAgent').mockImplementation(async (spec) => {
      if (spec.model !== 'fake-flaky') return original(spec);
      return {
        text: '',
        usage: null,
        error: String(error),
        timedOut: error === 'timeout',
        cancelled: error === 'cancelled',
        durationMs: 1,
        diagnostics: String(error),
      };
    });
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1', 'fake-flaky']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.attempts.filter((attempt) => attempt.seatId === 's2')).toHaveLength(Number(calls));
  });

  it('a retry keeps the spend of the failed attempts and adds its own', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-fail', 'fake-fail']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('failed');
    const first = chair.usage.total;
    expect(first).toBeGreaterThan(0);
    expect(chair.attempts).toHaveLength(3);
    await engine.rerun(session.id, chair.id);
    await until(() => chair.status !== 'running');
    expect(chair.attempts).toHaveLength(5); // the reusable valid step is not asked twice
    expect(chair.usage.total).toBeGreaterThan(first);
    expect(chair.usage.council).toBeGreaterThan(0);
  });
});

describe('cancelling a round', () => {
  it('stops only that round, keeps it visible as cancelled and counts its spend', async () => {
    const { engine } = await setup();
    const a = await engine.createSession(input(['fake-hang', 'fake-hang', 'fake-1']));
    const b = await engine.createSession(input(['fake-hang', 'fake-hang', 'fake-1']));
    const chairA = chairOf(a);
    const chairB = chairOf(b);
    await until(() => seatsOf(chairA).some((s) => s.state === 'running'));
    engine.cancelRound(a.id, chairA.id);
    await until(() => chairA.status !== 'running');
    expect(chairA.status).toBe('cancelled');
    expect(seatsOf(chairA).filter((s) => s.error === 'cancelled').length).toBeGreaterThanOrEqual(2);
    expect(chairA.usage.total).toBeGreaterThan(0);
    expect(chairB.status).toBe('running');
    expect(() => engine.cancelRound(a.id, chairA.id)).toThrow(EngineError);
    engine.cancelRound(b.id, chairB.id);
    await until(() => chairB.status !== 'running');
    // a cancelled round can be run again
    await engine.rerun(a.id, chairA.id);
    engine.cancelRound(a.id, chairA.id);
    await until(() => chairA.status !== 'running');
  });
});

describe('what the council rules forbid is refused by the engine too', () => {
  it('admits deliberate agy choices as a member and as the chairman', async () => {
    const { engine } = await setup();
    const withAgy = input(['fake-1', 'fake-1']);
    withAgy.seats[0] = seat('s0', 'fake-1', 'pi');
    (withAgy.seats[0] as { harness: string }).harness = 'agy';
    expect((await engine.createSession(withAgy)).settings.seats[0]?.harness).toBe('agy');
    const asChairman = {
      ...input(['fake-1', 'fake-1']),
      chairman: { harness: 'agy' as const, model: 'x', effort: '' },
    };
    expect((await engine.createSession(asChairman)).settings.chairman.harness).toBe('agy');
  });

  it('refuses a toggle the harness cannot have that way', async () => {
    const { engine } = await setup();
    const base = input(['fake-1', 'fake-1']);
    // Pi cannot do web; Codex cannot turn tools off
    await expect(
      engine.createSession({
        ...base,
        seats: [{ ...seat('a', 'fake-1', 'pi'), web: true }, seat('b', 'fake-1')],
      }),
    ).rejects.toMatchObject({ code: 'toggle_blocked' });
    await expect(
      engine.createSession({
        ...base,
        seats: [{ ...seat('a', 'fake-1', 'codex'), tools: false }, seat('b', 'fake-1')],
      }),
    ).rejects.toMatchObject({ code: 'toggle_forced_on' });
    // Claude's memory and tools are free
    const ok = await engine.createSession({
      ...base,
      seats: [{ ...seat('a', 'fake-1', 'claude'), tools: true, memory: true }, seat('b', 'fake-1')],
    });
    expect(ok.settings.seats[0]?.memory).toBe(true);
  });
});

describe('a model without credit', () => {
  it('an account that is out is remembered for a day, a plain rate limit for an hour, and writes never lose one', async () => {
    const { engine, store } = await setup();
    const session = await engine.createSession({
      ...input([
        'fake-1',
        'fake-nocredit',
        'fake-ratelimit',
        'anthropic/fake-nocredit',
        'litellm/zai/fake-nocredit',
        'fake-1',
      ]),
      seats: [
        ...input([
          'fake-1',
          'fake-nocredit',
          'fake-ratelimit',
          'anthropic/fake-nocredit',
          'litellm/zai/fake-nocredit',
          'fake-1',
        ]).seats,
        seat('c', 'fake-nocredit', 'claude'),
      ],
    });
    await until(() => chairOf(session).status !== 'running');
    await until(() => store.readUnavailable().length >= 5);
    const hours = (entry: { until: string }) =>
      (new Date(entry.until).getTime() - Date.now()) / 3_600_000;
    const byModel = Object.fromEntries(store.readUnavailable().map((e) => [e.model, e]));
    expect(hours(byModel['fake-nocredit'] as { until: string })).toBeGreaterThan(23);
    // Pi names providers inside its ids: two parts name one provider, three a gateway's vendor; every other harness is out whole
    expect(byModel['fake-nocredit']?.prefix).toBe('');
    expect(byModel['anthropic/fake-nocredit']?.prefix).toBe('anthropic/');
    expect(byModel['litellm/zai/fake-nocredit']?.prefix).toBe('litellm/zai/');
    expect(store.readUnavailable().find((e) => e.harness === 'claude')?.prefix).toBe('');
    expect(hours(byModel['fake-ratelimit'] as { until: string })).toBeLessThan(1.01);
    expect(hours(byModel['fake-ratelimit'] as { until: string })).toBeGreaterThan(0.9);
    expect(byModel['fake-ratelimit']?.prefix).toBeUndefined();

    // many writers at once: nothing is lost
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        store.addUnavailable({ harness: 'codex', model: `m-${i}`, until: future, reason: 'x' }),
      ),
    );
    expect(store.readUnavailable().filter((e) => e.harness === 'codex')).toHaveLength(25);
    expect(store.readUnavailable().some((e) => e.model === 'fake-nocredit')).toBe(true);
  });

  it('is passed over by the defaults', async () => {
    const { store } = await setup();
    void store;

    const model = (id: string) => ({ id, label: id, efforts: ['high'], defaultEffort: 'high' });
    const piModels = (until: string): HarnessModels => ({
      harness: 'pi',
      models: [
        model('litellm/zai/glm-5.3'),
        model('litellm/deepseek/deepseek-v4-pro'),
        model('litellm/xai/grok-4.6'),
      ],
      listed: true,
      defaultModel: '',
      unavailable: [{ id: 'litellm/zai/glm-5.3', until, reason: '429 insufficient balance' }],
      note: null,
      fallbackEfforts: [],
      fetchedAt: '',
    });
    const claude: HarnessModels = {
      ...piModels(''),
      harness: 'claude',
      models: [model('claude-opus-5-5')],
      unavailable: [],
    };
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const defaults = computeDefaults([claude, piModels(future)]);
    expect(defaults.seats.find((s) => s.harness === 'pi')?.model).not.toBe('litellm/zai/glm-5.3');
    // an account that is out takes the vendor's other models with it
    const wholeVendor = piModels(future);
    wholeVendor.models.push(model('litellm/zai/glm-5.3-flash'));
    wholeVendor.unavailable = [
      { id: 'litellm/zai/glm-5.3', prefix: 'litellm/zai/', until: future, reason: 'no balance' },
    ];
    const picked = computeDefaults([claude, wholeVendor]);
    expect(
      [picked.seats.find((s) => s.harness === 'pi')?.model, picked.chairman.model].join(' '),
    ).not.toContain('litellm/zai/');
    const expired = computeDefaults([claude, piModels(new Date(Date.now() - 1000).toISOString())]);
    expect([
      expired.seats.find((s) => s.harness === 'pi')?.model,
      expired.chairman.model,
    ]).toContain('litellm/zai/glm-5.3');
  });
});

describe('the answers of the current round stay in memory until every member has settled', () => {
  it('no save, whatever its cause, writes a finished member before its slow sibling is done', async () => {
    const { engine, store } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-slow', 'fake-1']));
    const chair = chairOf(session);
    const file = join(home, 'sessions', `${session.id}.json`);
    await until(() => seatsOf(chair).filter((s) => s.state === 'done').length === 2);
    // the slow seat is still running; saves of every kind happen meanwhile
    await engine.rename(session.id, 'renamed while running');
    await engine.setLayout(session.id, { opId: 'op-direction-1', direction: 'LR', nodes: {} });
    await new Promise((resolve) => setTimeout(resolve, 400)); // the debounced progress save
    expect(seatsOf(chair).some((s) => s.state === 'running')).toBe(true);
    const text = readFileSync(file, 'utf8');
    const onDisk = JSON.parse(text) as Session;
    const seats = seatsOf(onDisk.nodes[chair.id] as ChairNode);
    expect(seats.every((seat) => seat.parsed === null && seat.rawOutput === '')).toBe(true);
    for (const seat of seatsOf(chair).filter((s) => s.parsed)) {
      expect(text).not.toContain(seat.parsed?.stance as string);
    }
    // the same holds for every write the store made so far
    for (const written of store.written) {
      const node = written.nodes[chair.id] as ChairNode | undefined;
      if (node?.status !== 'running' || seatsOf(node).every((s) => s.state !== 'running')) continue;
      expect(seatsOf(node).every((s) => s.parsed === null)).toBe(true);
    }
    await until(() => chair.status !== 'running');
    // once all members settled and before the chairman ran, the answers were written
    const afterMembers = store.written.find((w) => {
      const node = w.nodes[chair.id] as ChairNode | undefined;
      return (
        node?.status === 'running' &&
        chairmanOf(node).state === 'pending' &&
        seatsOf(node).every((s) => s.state !== 'running' && s.state !== 'pending') &&
        seatsOf(node).some((s) => s.sanitized !== null)
      );
    });
    expect(afterMembers).toBeDefined();
    const final = JSON.parse(readFileSync(file, 'utf8')) as Session;
    expect(seatsOf(final.nodes[chair.id] as ChairNode).filter((s) => s.parsed)).toHaveLength(3);
  });
});

describe('finalization: a round is done when its final save is, and nothing queued behind it undoes it', () => {
  it('layout and rename saves during the final write serialize the finished round; no child, no cancel, no announcement before', async () => {
    const { engine, store, events } = await setup();
    store.slowFinalMs = 500;
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    const chair = chairOf(session);
    const file = join(home, 'sessions', `${session.id}.json`);
    // the chairman has answered and the final write is under way (it takes half a second)
    await until(() => chairmanOf(chair).state === 'done');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(chair.status).toBe('running');
    // saves that arrive now queue behind the final one: they must write the finished round, not the running one
    // a drag during the final write: where the node is now (and that it is pinned) is not lost
    const layout = engine.setLayout(session.id, {
      opId: 'op-final-write',
      direction: 'LR',
      nodes: { [chair.id]: { x: 123, y: 456, pinned: true, rev: 0 } },
    });
    const renaming = engine.rename(session.id, 'renamed during the final save');
    // a start that arrives now waits its turn behind the final write, and is then served from the finished round
    const early = engine.startRound(session.id, chair.id, 'too early');
    expect(() => engine.cancelRound(session.id, chair.id)).toThrow(EngineError);
    const done = (e: ServerEvent) =>
      e.type === 'node' &&
      e.node.kind === 'chair' &&
      e.node.id === chair.id &&
      e.node.status === 'done';
    expect(events.some(done)).toBe(false);
    await Promise.all([layout, renaming]);
    await until(() => chair.status === 'done');
    expect(events.some(done)).toBe(true);
    expect((await early).chairId).not.toBe(chair.id);
    expect(chair.status).toBe('done'); // it was done before the child began
    await engine.flush();
    // the disk agrees with memory: done, with the rename and the layout that were queued behind it
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Session;
    expect((onDisk.nodes[chair.id] as ChairNode).status).toBe('done');
    expect(onDisk.name).toBe('renamed during the final save');
    expect(onDisk.layout.direction).toBe('LR');
    expect((onDisk.nodes[chair.id] as ChairNode).position).toEqual({ x: 123, y: 456 });
    expect((onDisk.nodes[chair.id] as ChairNode).pinned).toBe(true);
    expect((onDisk.nodes[chair.id] as ChairNode).layoutRev).toBe(1);
    // a restart finds nothing to recover
    const restarted = new Store(home);
    expect((await restarted.init()).recovered).toEqual([]);
    const restored = restarted.get(session.id) as Session;
    expect((restored.nodes[chair.id] as ChairNode).status).toBe('done');
  });

  it('never announces a success the disk does not have, and never rejects unhandled', async () => {
    const { engine, store, events } = await setup();
    // a finished round cannot be saved
    store.failWhen = (_s, finals) => finals.some((n) => n.kind === 'chair' && n.status === 'done');
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('failed');
    expect(chair.errorNote?.code).toBe('round_save_failed');
    expect(chair.error).toMatch(/Saving the round failed/u);
    const announced = events.filter(
      (e) => e.type === 'node' && e.node.id === chair.id && e.node.kind === 'chair',
    );
    expect(
      announced.some(
        (e) => e.type === 'node' && e.node.kind === 'chair' && e.node.status === 'done',
      ),
    ).toBe(false);
  });
});

describe('the round handle', () => {
  it('done resolves after the final save, subscribe replays and follows, and cancel stops the round', async () => {
    const { engine, store } = await setup();
    store.slowFinalMs = 100;
    const { round } = await engine.createSessionWithRound(input(['fake-1', 'fake-slow', 'fake-1']));
    const seen: string[] = [];
    const stop = round.subscribe((event) => seen.push(event.type));
    const status = await round.done;
    expect(status).toBe('done');
    // when done resolved the final save had happened
    const onDisk = JSON.parse(
      readFileSync(join(home, 'sessions', `${round.sessionId}.json`), 'utf8'),
    ) as Session;
    expect((onDisk.nodes[round.chairId] as ChairNode).status).toBe('done');
    expect(seen.filter((t) => t === 'seat-start')).toHaveLength(3);
    expect(seen).toContain('chairman');
    expect(seen.at(-1)).toBe('end');
    // a late subscriber gets the whole story, and cleans up
    const late: string[] = [];
    round.subscribe((event) => late.push(event.type))();
    expect(late).toEqual(seen);
    stop();

    const hung = await engine.createSessionWithRound(input(['fake-hang', 'fake-hang', 'fake-1']));
    await until(() => seatsOf(chairOf(hung.session)).some((s) => s.state === 'running'));
    hung.round.cancel();
    expect(await hung.round.done).toBe('cancelled');
  });
});

describe('the default seats never repeat a family and never use a model that is out', () => {
  const model = (id: string) => ({ id, label: id, efforts: ['high'], defaultEffort: 'high' });
  const item = (
    harness: HarnessModels['harness'],
    ids: string[],
    unavailable: HarnessModels['unavailable'] = [],
    defaultModel = '',
  ): HarnessModels => ({
    harness,
    models: ids.map(model),
    listed: true,
    defaultModel,
    unavailable,
    note: null,
    fallbackEfforts: [],
    fetchedAt: '',
  });
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  it('Pi’s seat takes a family no member and not the chairman uses', () => {
    const notes: Note[] = [];
    const defaults = computeDefaults(
      [
        item('claude', ['claude-opus-5-5']),
        item('codex', ['gpt-6.1-sol']),
        item('grok', ['grok-4.7']),
        item(
          'pi',
          [
            'litellm/chatgpt/gpt-6.1-sol', // the same family as Codex's seat
            'litellm/xai/grok-4.6', // the same family as Grok's seat
            'litellm/deepseek/deepseek-v4-pro',
            'litellm/zai/glm-5.3',
          ],
          [],
          'litellm/chatgpt/gpt-6.1-sol', // Pi's own default is a taken family
        ),
      ],
      undefined,
      notes,
    );
    const families = defaults.seats
      .filter((seat) => seat.enabled)
      .map((seat) => `${seat.harness}:${seat.model}`);
    const piSeat = defaults.seats.find((seat) => seat.harness === 'pi');
    expect(piSeat?.enabled).toBe(true);
    expect(piSeat?.model).toMatch(/deepseek|glm/u);
    expect(piSeat?.model).not.toBe(defaults.chairman.model);
    expect(new Set(families).size).toBe(families.length);
    expect(notes).toEqual([]);
  });

  it('Pi can supply one genuinely different sibling model in a two-company council', () => {
    const notes: Note[] = [];
    const defaults = computeDefaults(
      [
        item('claude', ['claude-opus-5-5']),
        item('codex', ['gpt-6.1-sol']),
        item('pi', [
          'litellm/chatgpt/gpt-6-sol',
          'litellm/chatgpt/gpt-6.1-sol',
          'litellm/anthropic/claude-opus-5-5',
        ]),
      ],
      undefined,
      notes,
    );
    const piSeat = defaults.seats.find((seat) => seat.harness === 'pi');
    expect(piSeat?.enabled).toBe(true);
    expect(piSeat?.model).toBe('litellm/chatgpt/gpt-6-sol');
    expect(notes).toEqual([]);
    expect(defaults.chairman.harness).toBe('pi');
    expect(defaults.chairman.model).toBe('litellm/anthropic/claude-opus-5-5');
    // The two members share a company; the chairman is separate.
    const seatModels = defaults.seats.filter((s) => s.enabled).map((s) => s.model);
    expect(new Set(seatModels).size).toBe(seatModels.length);
  });

  it('a harness whose models are all out gets a default seat that is off, never a model from the unavailable list; a single model out is passed over', () => {
    const notes: Note[] = [];
    const defaults = computeDefaults(
      [
        item(
          'claude',
          ['claude-opus-5-5', 'claude-sonnet-5-5'],
          [
            {
              id: 'claude-opus-5-5',
              prefix: '',
              until: future(),
              reason: 'credit balance is too low',
            },
          ],
        ),
        item('codex', ['gpt-6.1-sol']),
        item('pi', ['litellm/deepseek/deepseek-v4-pro', 'litellm/zai/glm-5.3']),
      ],
      undefined,
      notes,
    );
    const claude = defaults.seats.find((seat) => seat.harness === 'claude');
    expect(claude?.enabled).toBe(false);
    expect(claude?.model).toBe('');
    expect(notes).toContainEqual(note('harness_no_credit', { harness: 'Claude Code' }));
    for (const seat of defaults.seats) expect(seat.model).not.toMatch(/^claude-/u);
    expect(defaults.chairman.model).not.toMatch(/^claude-/u);
    // only the unavailable model is skipped when others of the harness remain
    const partial = computeDefaults([
      item(
        'claude',
        ['claude-opus-5-5', 'claude-sonnet-5-5'],
        [{ id: 'claude-opus-5-5', until: future(), reason: '429 rate limit' }],
      ),
      item('codex', ['gpt-6.1-sol']),
    ]);
    expect(partial.seats.find((seat) => seat.harness === 'claude')?.model).toBe(
      'claude-sonnet-5-5',
    );
  });
});

describe('a model that is known to be out is not asked', () => {
  it('its seat is skipped at the start of every round, also of a session already running, and costs nothing', async () => {
    const { engine, store } = await setup();
    const session = await engine.createSession({
      ...input(['fake-1', 'fake-1', 'fake-2']),
      chairman: { harness: 'pi', model: 'fake-3', effort: '' },
    });
    await until(() => chairOf(session).status === 'done');
    const first = chairOf(session);
    expect(seatsOf(first).every((seat) => seat.state === 'done')).toBe(true);
    // the model of the third seat (and a whole provider, in the second case) runs out between the rounds
    await store.addUnavailable({
      harness: 'pi',
      model: 'fake-2',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: '429 rate limit',
    });
    await engine.startRound(session.id, first.id, 'And now?');
    await until(() => chairOf(session, 2)?.status === 'done');
    const second = chairOf(session, 2);
    const skipped = seatsOf(second).filter((seat) => seat.state === 'skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.model).toBe('fake-2');
    expect(skipped[0]?.error).toBe('skipped: rate limited');
    expect(skipped[0]?.startedAt).toBeNull();
    // it was never run: no call, no spend
    expect(second.attempts.filter((a) => a.kind === 'seat')).toHaveLength(2);
    expect(classifyFailure('skipped', skipped[0]?.error ?? null)).toBe('skipped');
    // an account that is out says so in the reason
    await store.addUnavailable({
      harness: 'pi',
      model: 'fake-nocredit',
      prefix: '',
      until: new Date(Date.now() + 3_600_000).toISOString(),
      reason: 'no balance',
    });
    const dead = await engine.createSession(input(['fake-1', 'fake-2', 'fake-nocredit']));
    await until(() => chairOf(dead).status !== 'running');
    // every pi seat is out (the empty prefix): the round fails at once, saying why, without a single call
    const failed = chairOf(dead);
    expect(failed.status).toBe('failed');
    expect(failed.errorNote?.code).toBe('few_members_skipped');
    expect(failed.error).toMatch(/did not take part/u);
    expect(failed.attempts).toHaveLength(0);
    expect(seatsOf(failed).every((seat) => seat.state === 'skipped')).toBe(true);
    expect(seatsOf(failed)[0]?.error).toBe('skipped: no credit');
  });
});

describe('the client that asked leaves while its round is being admitted', () => {
  it('before the write: nothing is admitted; during it: the round ends cancelled and no member is ever asked', async () => {
    const { engine, store } = await setup();
    // already gone: refused (499), no session, no file
    const gone = new AbortController();
    gone.abort();
    await expect(
      engine.createSessionWithRound({ ...input(['fake-1', 'fake-1']), signal: gone.signal }),
    ).rejects.toMatchObject({ code: 'cancelled', status: 499 });
    expect(store.list()).toEqual([]);
    // it leaves while the first write is held: the session exists (it was written), its round is stopped before any member
    const leaving = new AbortController();
    let release: () => void = () => undefined;
    let held = false;
    store.holdWrite = () => {
      held = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const admitting = engine.createSessionWithRound({
      ...input(['fake-1', 'fake-1']),
      signal: leaving.signal,
    });
    await until(() => held);
    leaving.abort();
    store.holdWrite = null;
    release();
    const { session, round } = await admitting;
    expect(await round.done).toBe('cancelled');
    const chair = chairOf(session);
    expect(chair.status).toBe('cancelled');
    expect(chair.attempts).toHaveLength(0); // no call, no spend
    expect(seatsOf(chair).every((seat) => seat.startedAt === null && seat.state === 'failed')).toBe(
      true,
    );
    expect(chairmanOf(chair).state).toBe('pending'); // the chairman was not asked either
    // a start from a done round whose client is gone is refused the same way
    const alive = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(alive).status === 'done');
    const late = new AbortController();
    late.abort();
    await expect(
      engine.startRound(alive.id, chairOf(alive).id, 'too late', { signal: late.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(Object.values(alive.nodes).filter((node) => node.kind === 'chair')).toHaveLength(1);
  });
});

describe('a session that keeps its chairman apart (quick)', () => {
  it('leaves out, round after round, a member of the chairman’s family that became available again, and says so', async () => {
    const { engine, store } = await setup();
    const day = 3_600_000;
    const quickInput = () => ({
      ...input(['fake-1', 'fake-1', 'deepseek-member']),
      chairman: { harness: 'pi' as const, model: 'deepseek-chair', effort: '' },
      seats: [
        seat('s0', 'fake-1', 'claude'),
        seat('s1', 'fake-1', 'codex'),
        seat('s2', 'deepseek-member'),
      ],
    });
    // the third seat is of the chairman's family (pi/fake-2) but its model is out, so the start is allowed
    await store.addUnavailable({
      harness: 'pi',
      model: 'deepseek-member',
      until: new Date(Date.now() + day).toISOString(),
      reason: '429 rate limit',
    });
    const session = await engine.createSession({
      ...quickInput(),
      separateChairman: true,
    });
    expect(session.settings.separateChairman).toBe(true);
    await until(() => chairOf(session).status === 'done');
    expect(seatsOf(chairOf(session)).filter((seat) => seat.state === 'skipped')).toHaveLength(1);
    // it comes back: it would run beside a chairman of its own family, so it is left out of this round too
    await store.addUnavailable({
      harness: 'pi',
      model: 'deepseek-member',
      until: new Date(Date.now() - 1000).toISOString(),
      reason: 'back',
    });
    await engine.startRound(session.id, chairOf(session).id, 'And now?');
    await until(() => chairOf(session, 2)?.status === 'done');
    const second = chairOf(session, 2);
    const left = seatsOf(second).filter((seat) => seat.state === 'skipped');
    expect(left.map((seat) => seat.error)).toEqual([SKIPPED_SAME_FAMILY]);
    expect(left[0]?.startedAt).toBeNull();
    expect(second.attempts.filter((a) => a.kind === 'seat')).toHaveLength(2); // never run: no call
    // a session that does not ask for it runs the same member
    const plain = await engine.createSession(quickInput());
    await until(() => chairOf(plain).status === 'done');
    expect(seatsOf(chairOf(plain)).every((seat) => seat.state === 'done')).toBe(true);
  });
});

describe('what the engine measures for the quick profile', () => {
  it('the time of a finished chairman call is kept per model and reasoning level', async () => {
    const { engine, store } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    const measured = store.measuredChairmanLatency();
    expect([...measured.keys()]).toEqual([chairmanKey('pi', 'fake-2', '')]);
    expect(measured.get(chairmanKey('pi', 'fake-2', ''))).toBeGreaterThanOrEqual(0);
    // a seat call is not a chairman call
    expect(measured.has(chairmanKey('pi', 'fake-1', ''))).toBe(false);
  });
});

describe('layout writes: the server decides, a stale writer adopts its answer', () => {
  async function ready() {
    const { engine, store, events } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    const chair = chairOf(session);
    const root = session.nodes[session.rootId] as SessionNode;
    return {
      engine,
      store,
      events,
      session,
      chair,
      root,
      node: (id: string) => session.nodes[id] as SessionNode,
    };
  }

  it('a write whose save fails changes nothing and is announced to nobody (5xx), so its retry is not a conflict', async () => {
    const { engine, store, events, session, chair, node } = await ready();
    await engine.flush();
    const write = {
      opId: 'op-disk-full',
      direction: 'LR' as const,
      nodes: { [chair.id]: { x: 70, y: 80, pinned: true, rev: 0 } },
    };
    const announced = events.length;
    store.failWhen = () => true;
    await expect(engine.setLayout(session.id, write)).rejects.toMatchObject({
      status: 500,
      code: 'save_failed',
    });
    expect(node(chair.id)).toMatchObject({ position: null, pinned: false, layoutRev: 0 });
    expect(session.layout.direction).toBe('TB');
    expect(events).toHaveLength(announced);
    // the disk is back: the same write, against the same revision, takes (a failure is not remembered as an answer)
    store.failWhen = null;
    const retry = await engine.setLayout(session.id, write);
    expect(retry.nodes[chair.id]).toEqual({ layoutRev: 1 });
    expect(node(chair.id)).toMatchObject({ position: { x: 70, y: 80 }, pinned: true });
    expect(session.layout.direction).toBe('LR');
    expect(events.at(-1)).toMatchObject({ type: 'session', layout: { direction: 'LR' } });
    // and what a session's layout writes left behind goes with the session
    await engine.deleteSession(session.id);
    expect(
      (engine as unknown as { layoutAnswers: Map<string, unknown> }).layoutAnswers.has(session.id),
    ).toBe(false);
  });

  it('a layout write held in flight and then failed leaves nothing on disk, and the rename queued behind it starts from the previous state', async () => {
    const { engine, store, session, chair, node } = await ready();
    await engine.flush();
    const file = join(home, 'sessions', `${session.id}.json`);
    let fail: () => void = () => undefined;
    let held = false;
    store.holdWrite = (text) => {
      if (!text.includes('"direction":"LR"')) return undefined;
      held = true;
      return new Promise<void>((_, reject) => {
        fail = () => reject(new Error('disk full'));
      });
    };
    const layout = engine.setLayout(session.id, {
      opId: 'op-held-then-failed',
      direction: 'LR',
      nodes: { [chair.id]: { x: 70, y: 80, pinned: true, rev: 0 } },
    });
    layout.catch(() => undefined);
    await until(() => held);
    const renaming = engine.rename(session.id, 'renamed behind a layout write');
    // the layout write is still under way: neither it nor the rename is the session's yet
    expect(node(chair.id).position).toBeNull();
    expect(session.name).not.toBe('renamed behind a layout write');
    store.holdWrite = null;
    fail();
    await expect(layout).rejects.toMatchObject({ status: 500, code: 'save_failed' });
    await renaming;
    // the rename was written from the state before the failed layout: the disk has the name, and nothing of the layout
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as Session;
    expect(onDisk.name).toBe('renamed behind a layout write');
    expect(onDisk.layout.direction).toBe('TB');
    expect((onDisk.nodes[chair.id] as ChairNode).position).toBeNull();
    expect((onDisk.nodes[chair.id] as ChairNode).layoutRev).toBe(0);
    expect(session.layout.direction).toBe('TB');
    expect(node(chair.id)).toMatchObject({ position: null, pinned: false, layoutRev: 0 });
  });

  it('a session deleted with layout writes queued behind it does not come back: they are refused (404) and write nothing', async () => {
    const { engine, store, session, chair } = await ready();
    await engine.flush();
    const file = join(home, 'sessions', `${session.id}.json`);
    let release: () => void = () => undefined;
    let held = false;
    store.holdWrite = (text) => {
      if (!text.includes('"direction":"LR"')) return undefined;
      held = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const before = engine.setLayout(session.id, {
      opId: 'op-before-delete',
      direction: 'LR',
      nodes: { [chair.id]: { x: 1, y: 2, pinned: true, rev: 0 } },
    });
    await until(() => held);
    const deleting = engine.deleteSession(session.id);
    const after = [1, 2, 3].map((n) =>
      engine.setLayout(session.id, {
        opId: `op-after-delete-${n}`,
        nodes: { [chair.id]: { x: n, y: n, pinned: true, rev: n } },
      }),
    );
    const renamed = engine.rename(session.id, 'renamed after the delete');
    const writes = store.written.length;
    store.holdWrite = null;
    release();
    await before;
    await deleting;
    for (const attempt of [...after, renamed]) {
      await expect(attempt).rejects.toMatchObject({ status: 404, code: 'no_session' });
    }
    await engine.flush();
    expect(existsSync(file)).toBe(false);
    expect(store.get(session.id)).toBeUndefined();
    expect(store.written).toHaveLength(writes); // nothing was written after the delete
    expect(store.list().some((item) => item.id === session.id)).toBe(false);
    // and a restart finds nothing of it
    const restarted = new Store(home);
    await restarted.init();
    expect(restarted.list()).toEqual([]);
  });

  it("applies a write whose revision is the node's, raises the revision, and says the new one", async () => {
    const { engine, session, chair, node } = await ready();
    const ack = await engine.setLayout(session.id, {
      opId: 'op-first-drag',
      nodes: { [chair.id]: { x: 10.4, y: 20.6, pinned: true, rev: 0 } },
    });
    expect(ack).toEqual({ ok: true, nodes: { [chair.id]: { layoutRev: 1 } } });
    expect(node(chair.id).position).toEqual({ x: 10, y: 21 });
    expect(node(chair.id).pinned).toBe(true);
    expect(node(chair.id).layoutRev).toBe(1);
  });

  it('refuses a stale write with the current place and revision, and changes nothing (409)', async () => {
    const { engine, session, chair, root, node } = await ready();
    await engine.setLayout(session.id, {
      opId: 'op-tab-one',
      nodes: { [chair.id]: { x: 100, y: 100, pinned: true, rev: 0 } },
    });
    // another tab, which still sees revision 0 of the chairman node and of the root, writes both
    const stale = engine.setLayout(session.id, {
      opId: 'op-tab-two',
      nodes: {
        [chair.id]: { x: 999, y: 999, pinned: true, rev: 0 },
        [root.id]: { x: 5, y: 5, pinned: true, rev: 0 },
      },
    });
    await expect(stale).rejects.toMatchObject({ status: 409, code: 'stale' });
    const refused = (await stale.catch((error) => error)) as EngineError;
    expect(refused.details).toEqual({
      direction: 'TB',
      nodes: {
        [chair.id]: { position: { x: 100, y: 100 }, pinned: true, layoutRev: 1 },
        [root.id]: { position: null, pinned: false, layoutRev: 0 },
      },
    });
    // all or none: the root node, whose revision was right, was not moved either
    expect(node(root.id).position).toBeNull();
    expect(node(root.id).layoutRev).toBe(0);
    expect(node(chair.id).position).toEqual({ x: 100, y: 100 });
  });

  it('the same write id is the same write: answered again, applied once', async () => {
    const { engine, session, chair, node } = await ready();
    const op = {
      opId: 'op-retried-1',
      nodes: { [chair.id]: { x: 40, y: 50, pinned: true, rev: 0 } },
    };
    const first = await engine.setLayout(session.id, op);
    const again = await engine.setLayout(session.id, op); // the answer was lost: the client sends it again
    expect(again).toEqual(first);
    expect(node(chair.id).layoutRev).toBe(1);
    // a refused write is answered the same way again, too
    const stale = {
      opId: 'op-retried-2',
      nodes: { [chair.id]: { x: 1, y: 1, pinned: true, rev: 0 } },
    };
    await expect(engine.setLayout(session.id, stale)).rejects.toMatchObject({ status: 409 });
    await expect(engine.setLayout(session.id, stale)).rejects.toMatchObject({ status: 409 });
    expect(node(chair.id).position).toEqual({ x: 40, y: 50 });
  });

  it('«چیدن» is one write over all its nodes: unpinned and placed, or all refused', async () => {
    const { engine, session, chair, root, node } = await ready();
    await engine.setLayout(session.id, {
      opId: 'op-pin-chair',
      nodes: { [chair.id]: { x: 300, y: 300, pinned: true, rev: 0 } },
    });
    // an arrange made against the revisions the writer saw before that drag is refused whole
    await expect(
      engine.setLayout(session.id, {
        opId: 'op-arrange-stale',
        direction: 'LR',
        nodes: {
          [root.id]: { x: 0, y: 0, pinned: false, rev: 0 },
          [chair.id]: { x: 0, y: 200, pinned: false, rev: 0 },
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(session.layout.direction).toBe('TB');
    expect(node(chair.id).pinned).toBe(true);
    // with the revisions as they are, it takes: both unpinned and placed, the direction changed
    await engine.setLayout(session.id, {
      opId: 'op-arrange-good',
      direction: 'LR',
      nodes: {
        [root.id]: { x: 0, y: 0, pinned: false, rev: 0 },
        [chair.id]: { x: 0, y: 200, pinned: false, rev: 1 },
      },
    });
    expect(session.layout.direction).toBe('LR');
    expect(node(chair.id)).toMatchObject({
      pinned: false,
      position: { x: 0, y: 200 },
      layoutRev: 2,
    });
    expect(node(root.id)).toMatchObject({ pinned: false, position: { x: 0, y: 0 }, layoutRev: 1 });
  });

  it('refuses what is not a write: no id, an unknown node, a place that is not a number', async () => {
    const { engine, session, chair } = await ready();
    const bad = (op: object) => engine.setLayout(session.id, op as never);
    await expect(
      bad({ nodes: { [chair.id]: { x: 1, y: 1, pinned: true, rev: 0 } } }),
    ).rejects.toMatchObject({
      code: 'bad_op',
    });
    await expect(
      bad({ opId: 'op-unknown-node', nodes: { nope: { x: 1, y: 1, pinned: true, rev: 0 } } }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      bad({ opId: 'op-bad-number', nodes: { [chair.id]: { x: 'a', y: 1, pinned: true, rev: 0 } } }),
    ).rejects.toMatchObject({
      code: 'bad_op',
    });
    await expect(bad({ opId: 'op-empty-write', nodes: {} })).rejects.toMatchObject({
      code: 'bad_op',
    });
  });
});

describe('what a failure means, and small details of nodes and profiles', () => {
  it('classifies a failed call in a few kinds', () => {
    expect(
      classifyFailure('failed', '429: {"message":"Insufficient balance or no resource package"}'),
    ).toBe('credit');
    expect(classifyFailure('failed', '429 Too Many Requests: rate limit reached')).toBe('rate');
    expect(classifyFailure('timeout', 'timeout')).toBe('timeout');
    expect(classifyFailure('invalid', 'no JSON object')).toBe('invalid');
    expect(classifyFailure('failed', 'cancelled')).toBe('cancelled');
    expect(classifyFailure('failed', 'something else')).toBe('other');
  });

  it('a round sent without a comment keeps its input title, also when it was cancelled; an edited input remembers its original', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    const first = chairOf(session);
    const next = await engine.startRound(session.id, first.id, null);
    await until(() => chairOf(session, 2)?.status === 'done');
    const nextNode = session.nodes[next.userId];
    expect(nextNode?.kind === 'next' && nextNode.title).toBe('No comment');
    // an edit: a new input beside the first, which says what it is a version of
    const comment = await engine.startRound(session.id, first.id, 'a comment');
    await until(
      () =>
        session.nodes[comment.chairId]?.kind === 'chair' &&
        (session.nodes[comment.chairId] as ChairNode).status === 'done',
    );
    const edited = await engine.startRound(session.id, first.id, 'a better comment', {
      editedFrom: comment.userId,
    });
    const editedNode = session.nodes[edited.userId];
    expect(editedNode?.kind === 'user' && editedNode.editedFrom).toBe(comment.userId);
    await edited.done;
  });

  it('a Persian profile name makes a readable id, not "profile-2"', () => {
    expect(slugify('تحلیل سریع')).not.toMatch(/^profile/u);
    expect(slugify('تحلیل سریع')).toMatch(/^[a-z]+-[a-z]+$/u);
    expect(slugify('My fast copy')).toBe('my-fast-copy');
    expect(slugify('۱۲۳')).toBe('123');
    expect(slugify('???')).toBe('profile');
  });
});

describe('how the chairman addresses the asker is chosen once, by the first round, and told to every later one', () => {
  const askerInformal = {
    ...{ question: 'تو بگو، برای شروع کدام پایگاه داده بهتر است؟' },
  };

  it("round 1 chooses (from the asker's own text); the session keeps it and every later chairman call is told it", async () => {
    const { engine } = await setup();
    const session = await engine.createSession({
      ...input(['fake-1', 'fake-1']),
      ...askerInformal,
    });
    await until(() => chairOf(session).status === 'done');
    expect(session.register).toBe('informal');
    // round 1 had no form to be told; the chairman was asked to choose and the schema it got had the field
    const first = chairmanOf(chairOf(session)).input;
    expect(first).not.toMatch(/^<address_form>/mu); // the rules mention the tag; the input has none yet
    expect(first).toContain('"register"');
    const started = await engine.startRound(session.id, chairOf(session).id, 'و بعد؟');
    await started.done;
    const second = chairmanOf(chairOf(session, 2)).input;
    expect(second).toMatch(/^<address_form>informal<\/address_form>$/mu);
    expect(session.register).toBe('informal'); // later rounds do not change it
  });

  it('a question that does not use «تو» is addressed formally', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    expect(session.register).toBe('formal');
  });

  it('a session from before the field has none and is addressed formally from round 2', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    await until(() => chairOf(session).status === 'done');
    delete session.register; // as if the session had been made before the field existed
    const started = await engine.startRound(session.id, chairOf(session).id, 'ادامه');
    await started.done;
    expect(chairmanOf(chairOf(session, 2)).input).toMatch(
      /^<address_form>formal<\/address_form>$/mu,
    );
  });
});

/** An engine whose idle window is short, so the waiting rule can be seen with the fake harnesses. */
async function setupIdle(idleMs: number) {
  const store = new FlakyStore(home);
  await store.init();
  const events: ServerEvent[] = [];
  const engine = new Engine(store, (event) => events.push(event), { idleMs });
  return { store, engine, events };
}

const seatOf = (chair: ChairNode, id: string) =>
  seatsOf(chair).find((item) => item.seatId === id) as NonNullable<ChairNode['seats']>[number];

describe('the waiting rule: a member is stopped only after it has been silent for the idle window', () => {
  it('a member that sends nothing is stopped when the window passes, and the round goes on without it', async () => {
    const { engine } = await setupIdle(300);
    const session = await engine.createSession(input(['fake-1', 'fake-timeout', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    const silent = seatOf(chair, 's1');
    expect(silent.state).toBe('timeout');
    expect(silent.error).toBe('timeout');
    // it was waited for the window (and not the old fixed limit)
    const waited = Date.parse(silent.endedAt as string) - Date.parse(silent.startedAt as string);
    expect(waited).toBeGreaterThanOrEqual(250);
    expect(waited).toBeLessThan(5000);
    expect(seatOf(chair, 's0').state).toBe('done');
    expect(seatOf(chair, 's2').state).toBe('done');
  });

  it('a member that showed a sign and went silent is stopped one window after its last sign', async () => {
    const { engine } = await setupIdle(300);
    const session = await engine.createSession(input(['fake-1', 'fake-stall', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    const stalled = seatOf(chair, 's1');
    expect(stalled.state).toBe('timeout');
    // the last sign it sent is on the seat, with the thinking it had reported
    expect(stalled.thinkingTokens).toBe(10);
    expect(Date.parse(stalled.lastSignalAt as string)).toBeGreaterThanOrEqual(
      Date.parse(stalled.startedAt as string),
    );
    expect(Date.parse(stalled.lastSignalAt as string)).toBeLessThanOrEqual(
      Date.parse(stalled.endedAt as string),
    );
  });

  it('a member that keeps working is never stopped, however long it takes; its signs are announced', async () => {
    const was = process.env.DIVAN_FAKE_THINK_MS;
    process.env.DIVAN_FAKE_THINK_MS = '1200';
    try {
      const { engine, events } = await setupIdle(300);
      const session = await engine.createSession(input(['fake-1', 'fake-think', 'fake-1']));
      const chair = chairOf(session);
      await until(() => chair.status !== 'running');
      expect(chair.status).toBe('done');
      const worker = seatOf(chair, 's1');
      // it took four windows, and was not stopped
      expect(worker.state).toBe('done');
      expect(
        Date.parse(worker.endedAt as string) - Date.parse(worker.startedAt as string),
      ).toBeGreaterThan(900);
      expect(worker.thinkingTokens).toBeGreaterThan(300);
      const signs = events.filter(
        (event): event is Extract<ServerEvent, { type: 'seat' }> =>
          event.type === 'seat' && event.seatId === 's1',
      );
      expect(signs.length).toBeGreaterThanOrEqual(1);
      // at most one announcement a second per member, each with the state, the time of the sign and the thinking so far
      expect(signs.length).toBeLessThanOrEqual(3);
      // each sign is a newer revision of the round than the one before it, and the finished round is newer than all of them
      for (const [index, sign] of signs.entries()) {
        expect(sign.rev).toBeGreaterThan(signs[index - 1]?.rev ?? 0);
      }
      expect(chair.rev).toBeGreaterThan(signs.at(-1)?.rev ?? 0);
      for (const sign of signs) {
        expect(sign).toMatchObject({
          sessionId: session.id,
          chairId: chair.id,
          label: worker.label,
          state: 'running',
        });
        expect(typeof sign.lastSignalAt).toBe('string');
        expect(typeof sign.rev).toBe('number');
        expect(sign.thinkingTokens === null || typeof sign.thinkingTokens === 'number').toBe(true);
      }
    } finally {
      if (was === undefined) delete process.env.DIVAN_FAKE_THINK_MS;
      else process.env.DIVAN_FAKE_THINK_MS = was;
    }
  });
});

describe('«منتظرش نمی‌مانم»: stop waiting for one member', () => {
  const running = (chair: ChairNode, id: string) => seatOf(chair, id).state === 'running';

  it('stops that member alone: it is left out as skipped, what it cost is counted, and the round finishes', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-hang', 'fake-1']));
    const chair = chairOf(session);
    await until(() => running(chair, 's1') && seatOf(chair, 's0').state === 'done');
    engine.skipSeat(session.id, chair.id, { label: seatOf(chair, 's1').label });
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    const skipped = seatOf(chair, 's1');
    expect(skipped.state).toBe('skipped');
    expect(skipped.error).toBe(SKIPPED_BY_USER);
    expect(skipped.usage).not.toBeNull();
    expect(seatOf(chair, 's0').state).toBe('done');
    expect(seatOf(chair, 's2').state).toBe('done');
    // its call is on the books like any other
    expect(chair.attempts.filter((a) => a.kind === 'seat' && a.seatId === 's1')).toHaveLength(1);
    // the chairman read the two answers that were given
    expect(chairmanOf(chair).input).not.toContain(`<<<MEMBER ${skipped.label} `);
    expect(chairmanOf(chair).input.match(/<<<MEMBER \w+ /gu)).toHaveLength(2);
  });

  it('a member can also be named by its seat id, in a field of its own', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-hang', 'fake-1']));
    const chair = chairOf(session);
    await until(() => running(chair, 's1'));
    engine.skipSeat(session.id, chair.id, { seatId: 's1' });
    await until(() => chair.status !== 'running');
    expect(seatOf(chair, 's1').state).toBe('skipped');
  });

  it('a label is looked up as a label only: a seat id that equals another member’s label cannot stop the wrong member', async () => {
    const { engine } = await setup();
    // seat ids "B" and "x"; the labels are drawn at random, so try until the seat "B" is labelled "A" (and "x" is "B")
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const session = await engine.createSession({
        ...input(['fake-hang', 'fake-hang']),
        seats: [seat('B', 'fake-hang'), seat('x', 'fake-hang')],
      });
      const chair = chairOf(session);
      await until(() => seatsOf(chair).every((item) => item.state === 'running'));
      const byLabel = (label: string) =>
        seatsOf(chair).find((item) => item.label === label) as NonNullable<
          ChairNode['seats']
        >[number];
      if (byLabel('A').seatId !== 'B') {
        engine.cancelRound(session.id, chair.id);
        await until(() => chair.status !== 'running');
        continue;
      }
      // here: {label: 'A', seatId: 'B'} and {label: 'B', seatId: 'x'}. Skipping the label "B" stops the member labelled B.
      engine.skipSeat(session.id, chair.id, { label: 'B' });
      await until(() => byLabel('B').state === 'skipped');
      expect(byLabel('B').seatId).toBe('x');
      expect(byLabel('A').state).toBe('running');
      // a seat id is not a label: "x" is no label of this round, "B" is no seat id of the other member
      expect(() => engine.skipSeat(session.id, chair.id, { label: 'x' })).toThrowError(
        expect.objectContaining({ code: 'bad_seat' }),
      );
      // and by seat id it is the seat id that counts: "B" is the member labelled A
      engine.skipSeat(session.id, chair.id, { seatId: 'B' });
      await until(() => byLabel('A').state === 'skipped');
      await until(() => chair.status !== 'running');
      return;
    }
    throw new Error('the labels never came out as the test needs');
  });

  it('the chairman still needs two valid answers: skipping the only other member fails the round', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-hang', 'fake-1']));
    const chair = chairOf(session);
    await until(() => running(chair, 's0') && seatOf(chair, 's1').state === 'done');
    engine.skipSeat(session.id, chair.id, { seatId: 's0' });
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('failed');
    expect(seatOf(chair, 's0').state).toBe('skipped');
  });

  it('refuses a member that is not in the round, one that is not running, and a round that is over', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-hang', 'fake-1']));
    const chair = chairOf(session);
    await until(() => running(chair, 's1') && seatOf(chair, 's0').state === 'done');
    expect(() => engine.skipSeat(session.id, chair.id, { label: 'nobody' })).toThrowError(
      expect.objectContaining({ code: 'bad_seat', status: 404 }),
    );
    // one that has finished is not waited for any more
    expect(() => engine.skipSeat(session.id, chair.id, { seatId: 's0' })).toThrowError(
      expect.objectContaining({ code: 'not_running', status: 409 }),
    );
    expect(() => engine.skipSeat(session.id, 'no-such-node', { seatId: 's1' })).toThrowError(
      expect.objectContaining({ code: 'bad_node' }),
    );
    engine.skipSeat(session.id, chair.id, { seatId: 's1' });
    await until(() => chair.status !== 'running');
    expect(() => engine.skipSeat(session.id, chair.id, { seatId: 's1' })).toThrowError(
      expect.objectContaining({ code: 'not_running' }),
    );
  });

  it('cancelling the round is not skipping: a cancelled member is failed, not skipped', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-hang', 'fake-1']));
    const chair = chairOf(session);
    await until(() => running(chair, 's1'));
    engine.cancelRound(session.id, chair.id);
    await until(() => chair.status !== 'running');
    expect(seatOf(chair, 's1').state).not.toBe('skipped');
  });
});

describe('what members find in their memory, and the chairman’s own memory', () => {
  const withMemory = (models: string[], memoryIds: string[]) => ({
    ...input(models),
    seats: models.map((model, index) => ({
      ...seat(`s${index}`, model, memoryIds.includes(`s${index}`) ? 'claude' : 'pi'),
      memory: memoryIds.includes(`s${index}`),
    })),
  });

  it('a member with memory brings its facts, a member without has none, and the chairman is given them apart', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(withMemory(['fake-1', 'fake-1', 'fake-1'], ['s0']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(seatOf(chair, 's0').parsed?.memory_facts).toEqual([
      { fact: 'The asker runs a team of two with a small budget.', source: 'projects/team' },
    ]);
    expect(seatOf(chair, 's1').parsed?.memory_facts).toEqual([]);
    const text = chairmanOf(chair).input;
    const label = seatOf(chair, 's0').label;
    // a block of the code's own for this member (its label and the nonce), the facts as one line of JSON
    const nonce = /<member_outputs untrusted="true" delimiter="(\w+)">/u.exec(text)?.[1];
    expect(text).toContain(`<member_memory_facts untrusted="true" delimiter="${nonce}">`);
    const line = text.split(`<<<FACTS ${label} ${nonce}>>>\n`)[1]?.split('\n')[0] ?? '';
    expect(JSON.parse(line)).toEqual([
      { fact: 'The asker runs a team of two with a small budget.', source: 'projects/team' },
    ]);
    expect(text).toContain(`<<<END FACTS ${label} ${nonce}>>>`);
    // and no other member has a block
    expect(text.match(/<<<FACTS /gu)).toHaveLength(1);
    // told once: not again inside the member's block
    expect(text.split('team of two').length - 1).toBe(1);
    // and the rule about them is in the chairman's rules
    expect(text).toMatch(/do not ask the asker questions that those facts already answer/u);
  });

  it('with no member memory there is no facts section', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chairmanOf(chair).input).not.toContain('<member_memory_facts untrusted');
  });

  it('Claude Code, Codex, Grok and Pi can keep memory read-only: it is accepted for a member of each', async () => {
    const { engine } = await setup();
    for (const harness of ['claude', 'codex', 'grok', 'pi'] as const) {
      const session = await engine.createSession({
        ...input(['fake-1', 'fake-1']),
        seats: [
          seat('s0', 'fake-1', harness),
          { ...seat('s1', 'fake-1', 'pi'), memory: false },
        ].map((item, index) => (index === 0 ? { ...item, memory: true } : item)),
      });
      expect(session.settings.seats[0]?.memory, harness).toBe(true);
    }
  });

  it('the chairman’s memory is on only when asked, with its sentence in the rules, and is kept in the session', async () => {
    const { engine } = await setup();
    const plain = await engine.createSession(input(['fake-1', 'fake-1']));
    expect(plain.settings.chairman.memory).toBe(false);
    expect(plain.settings.chairmanRules).not.toMatch(/read-only access to the asker.s memory/u);
    const remembering = await engine.createSession({
      ...input(['fake-1', 'fake-1']),
      chairman: { harness: 'claude', model: 'fake-2', effort: '', memory: true },
    });
    expect(remembering.settings.chairman.memory).toBe(true);
    expect(remembering.settings.chairmanRules).toMatch(/read-only access to the asker.s memory/u);
    const chair = chairOf(remembering);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(chairmanOf(chair).memory).toBe(true);
  });
});

describe('the chairman’s dissent and agreement are stored with the round', () => {
  it('agreement is how many of the answers it was given, dissent is null exactly when all agree', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-1', 'fake-1', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(chair.agreement).not.toBeNull();
    expect(chair.agreement?.of).toBe(4);
    expect(chair.agreement?.agree).toBeGreaterThanOrEqual(0);
    expect(chair.agreement?.agree).toBeLessThanOrEqual(4);
    expect(chair.dissent === null).toBe(chair.agreement?.agree === chair.agreement?.of);
    // and they survive a reload from disk
    const store = new Store(home);
    await store.init();
    const loaded = store.get(session.id) as Session;
    const again = loaded.nodes[chair.id] as ChairNode;
    expect(again.agreement).toEqual(chair.agreement);
    expect(again.dissent).toEqual(chair.dissent);
  });

  it('of counts the answers the chairman was given, not the seats', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-fail', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(chair.agreement?.of).toBe(2);
  });
});

describe('a session at a level', () => {
  it('keeps the level it was started at', async () => {
    const { engine } = await setup();
    for (const level of ['low', 'medium', 'high', 'max'] as const) {
      const session = await engine.createSession({ ...input(['fake-1', 'fake-1']), level });
      expect(session.settings.level).toBe(level);
      await until(() => chairOf(session).status !== 'running');
    }
  });
});

describe('what a node says is announced with a content revision that only goes up', () => {
  it('every announcement of a round is newer than the one before it, and the last is the finished round', async () => {
    const store = new FlakyStore(home);
    await store.init();
    const revs: number[] = [];
    const states: string[] = [];
    const engine = new Engine(store, (event) => {
      if (event.type === 'node' && event.node.kind === 'chair') {
        revs.push(event.node.rev ?? 0);
        states.push(event.node.status);
      }
    });
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(revs.length).toBeGreaterThanOrEqual(2);
    for (const [index, rev] of revs.entries()) {
      expect(rev, `announcement ${index}`).toBeGreaterThan(revs[index - 1] ?? 0);
    }
    expect(states.at(-1)).toBe('done');
    // a page that has the last one takes nothing older, and what a read says about the node is at least as new as the events
    expect(chair.rev).toBe(revs.at(-1));
    expect(store.get(session.id)?.nodes[chair.id]?.rev).toBe(revs.at(-1));
  });

  it('what is saved is exactly the revision that was announced: a restart reads the same one', async () => {
    const store = new FlakyStore(home);
    await store.init();
    const revs: number[] = [];
    const engine = new Engine(store, (event) => {
      if (event.type === 'node' && event.node.kind === 'chair') revs.push(event.node.rev ?? 0);
    });
    const session = await engine.createSession(input(['fake-1', 'fake-1']));
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    await engine.flush();
    const announced = revs.at(-1) as number;
    // a new process on the same home reads the finished round with the revision that finished it announced
    const restarted = new Store(home);
    await restarted.init();
    const reloaded = restarted.get(session.id)?.nodes[chair.id] as ChairNode;
    expect(reloaded.status).toBe('done');
    expect(reloaded.rev).toBe(announced);
    // and whatever the next process announces is above it
    expect(restarted.nextRev()).toBeGreaterThan(announced);
  });

  it('a run again is announced newer than the failed round it replaces', async () => {
    const store = new FlakyStore(home);
    await store.init();
    const seen: Record<string, number> = {};
    const engine = new Engine(store, (event) => {
      if (event.type === 'node' && event.node.kind === 'chair')
        seen[event.node.status] = event.node.rev ?? 0;
    });
    const session = await engine.createSession(input(['fake-fail', 'fake-fail']));
    const chair = chairOf(session);
    await until(() => chair.status === 'failed');
    const failedAt = seen.failed ?? 0;
    expect(failedAt).toBeGreaterThan(0);
    await engine.rerun(session.id, chair.id);
    await until(() => chair.status === 'failed' && (seen.running ?? 0) > failedAt);
    expect(seen.running).toBeGreaterThan(failedAt);
  });
});

describe('the fake chairman writes titles the way the real one is asked to', () => {
  const ask = (question: string) => ({ ...input(['fake-1', 'fake-1']), question });

  it('three to five words that say what the round is about: never the first words, never «Round N»', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(
      ask('Should I leave my stable job as a senior engineer to start a company?'),
    );
    const chair = chairOf(session);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    // the first sentence as it was written, cut at a word boundary to about six words
    expect(chair.title).toBe('Should I leave my stable job…');
    expect(chair.title).not.toMatch(/^round/iu);
    const root = session.nodes[session.rootId] as { title: string };
    expect(root.title).toBe('Should I leave my stable job…');
    // a later round's title follows its own input, and a critique says so
    const next = await engine.startRound(
      session.id,
      chair.id,
      'Also: my wife could return to work in six months',
    );
    await until(() => chairOf(session, 2)?.status === 'done');
    expect(chairOf(session, 2).title).toBe('Also: my wife could return…');
    expect(chairOf(session, 2).direction).not.toBe(chair.direction);
    const critique = await engine.startRound(session.id, chairOf(session, 2).id, null);
    await until(
      () =>
        session.nodes[critique.chairId]?.kind === 'chair' &&
        (session.nodes[critique.chairId] as ChairNode).status === 'done',
    );
    const round3 = session.nodes[critique.chairId] as ChairNode;
    expect(round3.title).toMatch(/^Critique: /u);
    expect(round3.title).not.toBe(chairOf(session, 2).title);
    expect(next.chairId).toBeDefined();
  });

  it('never asks again a question the asker has answered', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(ask('Should we price per seat or per usage?'));
    const first = chairOf(session);
    await until(() => first.status !== 'running');
    expect(first.questionsForUser).toEqual(['What is the monthly cost at full scale?']);
    await engine.startRound(session.id, first.id, {
      answers: [{ question: 'What is the monthly cost at full scale?', answer: 'About 40 euros' }],
      comment: '',
    });
    await until(() => chairOf(session, 2)?.status === 'done');
    expect(chairOf(session, 2).questionsForUser).toEqual([
      'Who will maintain it after the launch?',
    ]);
    await engine.startRound(session.id, chairOf(session, 2).id, {
      answers: [{ question: 'Who will maintain it after the launch?', answer: 'Nobody yet' }],
      comment: '',
    });
    await until(() => chairOf(session, 3)?.status === 'done');
    expect(chairOf(session, 3).questionsForUser).toEqual(['What would make you stop?']);
  });
});

describe('there is no token cap: the usage is shown, never limited', () => {
  it('a round starts whatever the session has used; a tokenCap sent by an old client is ignored and not stored', async () => {
    const before = process.env.DIVAN_FAKE_USAGE;
    // a round costs what a real one does here (about 60k for two members and a chairman)
    process.env.DIVAN_FAKE_USAGE = '1';
    try {
      const { engine } = await setup();
      const session = await engine.createSession({
        ...input(['fake-1', 'fake-1']),
        budgets: { maxClaims: 5, maxWords: 30, tokenCap: 1000 } as never,
      });
      expect(session.settings.budgets).toEqual({ maxClaims: 5, maxWords: 30 });
      const first = chairOf(session);
      await until(() => first.status !== 'running');
      expect(first.status).toBe('done');
      await engine.startRound(session.id, first.id, 'And the budget?');
      await until(() => chairOf(session, 2)?.status === 'done');
      expect(first.usage.total + chairOf(session, 2).usage.total).toBeGreaterThan(1000);
    } finally {
      process.env.DIVAN_FAKE_USAGE = before;
    }
  });
});

describe('«Stop waiting for the rest» writes the answer from the members that answered', () => {
  it('stops every member still working, and the chairman writes from the others', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(
      input(['fake-1', 'fake-1', 'fake-hang', 'fake-hang']),
    );
    const chair = chairOf(session);
    await until(() => seatsOf(chair).filter((seat) => seat.state === 'done').length === 2);
    const stopped = engine.skipRemaining(session.id, chair.id);
    expect(stopped).toBe(2);
    await until(() => chair.status !== 'running');
    expect(chair.status).toBe('done');
    expect(seatsOf(chair).filter((seat) => seat.state === 'skipped')).toHaveLength(2);
    expect(seatsOf(chair).filter((seat) => seat.state === 'done')).toHaveLength(2);
    expect(chair.answer.length).toBeGreaterThan(0);
  });

  it('needs two answers: with fewer nothing is stopped and the round goes on', async () => {
    const { engine } = await setup();
    const session = await engine.createSession(input(['fake-1', 'fake-hang', 'fake-hang']));
    const chair = chairOf(session);
    await until(() => seatsOf(chair).filter((seat) => seat.state === 'done').length === 1);
    expect(() => engine.skipRemaining(session.id, chair.id)).toThrowError(
      expect.objectContaining({ code: 'too_few_answers', status: 409 }),
    );
    expect(seatsOf(chair).filter((seat) => seat.state === 'running')).toHaveLength(2);
    // the round that is not running refuses too
    engine.cancelRound(session.id, chair.id);
    await until(() => chair.status !== 'running');
    expect(() => engine.skipRemaining(session.id, chair.id)).toThrowError(
      expect.objectContaining({ code: 'not_running', status: 409 }),
    );
    expect(() => engine.skipRemaining(session.id, 'nope')).toThrowError(
      expect.objectContaining({ code: 'bad_node', status: 404 }),
    );
  });
});
