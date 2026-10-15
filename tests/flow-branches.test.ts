import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agents from '../src/server/adapters/index.ts';
import { planOf } from '../src/server/divan-api.ts';
import { eligibleFlow } from '../src/server/eligibility.ts';
import { Engine } from '../src/server/engine.ts';
import { interruptRunning, Store, serializeSession } from '../src/server/store.ts';
import {
  agentsOf,
  type ConditionStep,
  canonicalFlow,
  evaluateCondition,
  finalInputsReady,
  invalidateDescendants,
  maxCalls,
  orderedNodes,
  projectOutput,
  releasableSteps,
  scheduleFlow,
  stepOf,
  validateFlow,
  wireState,
} from '../src/shared/flow.ts';
import type { ChairNode, Session } from '../src/shared/types.ts';
import { branchFlow, conditionalWireFlow, flowInput } from './fixtures/flows.ts';
import { requireValue } from './fixtures.ts';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('conditional data wires', () => {
  it('readiness includes the final and can use a fallback despite a missing branch', () => {
    const flow = branchFlow();
    for (const agent of agentsOf(flow)) agent.harness = agent.id === 'yes' ? 'grok' : 'claude';
    const status = [
      { id: 'claude' as const, installed: true, usable: true, note: null },
      { id: 'grok' as const, installed: false, usable: false, note: null },
    ];
    expect(eligibleFlow(flow, [], Date.now(), false, status).blocked).toBe(false);
    const final = requireValue(agentsOf(flow).find((agent) => agent.id === 'final'));
    final.harness = 'grok';
    expect(eligibleFlow(flow, [], Date.now(), false, status).blocked).toBe(true);
    final.harness = 'claude';
    expect(
      eligibleFlow(
        flow,
        [
          {
            harness: 'claude',
            model: final.model,
            until: new Date(Date.now() + 60000).toISOString(),
            reason: 'out',
          },
        ],
        Date.now(),
        false,
        status,
      ).blocked,
    ).toBe(true);
  });
  async function startWire(model = 'fake-1', exit: 'yes' | 'no' = 'yes') {
    process.env.DIVAN_FAKE = '1';
    process.env.DIVAN_FAKE_DELAY_MS = '2';
    const store = new Store(homeOf());
    await store.init();
    const engine = new Engine(store, () => {});
    const flow = conditionalWireFlow(model);
    requireValue(flow.edges.find((edge) => edge.when)).when = { condition: 'decision', exit };
    requireValue(flow.edges.find((edge) => edge.gate)).gate = exit === 'yes' ? 'no' : 'yes';
    const started = await engine.createSessionWithRound({
      ...flowInput(),
      flow,
    });
    await started.round.done;
    return { store, engine, session: started.session, chair: chairOf(started.session) };
  }

  it.each([
    ['fake-1', true, 'yes', ['report'], 3],
    ['fake-branch-low', false, 'yes', ['rewriter'], 4],
    ['fake-1', true, 'no', ['rewriter'], 4],
    ['fake-branch-low', false, 'no', ['report'], 3],
  ] as const)(
    'delivers only the selected payload on %s (decision %s, wire %s), without a pass-through call',
    async (model, verdict, exit, inputs, calls) => {
      const { session, chair } = await startWire(model, exit);
      const direct = inputs[0] === 'report';
      expect(chair.status).toBe('done');
      expect(stepOf(chair, 'decision')).toMatchObject({ result: verdict });
      expect(stepOf(chair, 'final')?.inputs).toEqual(inputs);
      expect(stepOf(chair, 'rewriter')).toMatchObject(
        direct
          ? { skipReason: 'inactive_branch', inputs: [] }
          : { inputs: ['report', 'judge'], run: { state: 'done' } },
      );
      expect(chair.attempts).toHaveLength(calls);
      expect(maxCalls(requireValue(session.settings.flow))).toBe(4);
      const final = requireValue(stepOf(chair, 'final'));
      if (final.form !== 'answer') throw new Error('fixture');
      const report = requireValue(stepOf(chair, 'report'));
      expect(final.run.input).toContain(`<<<UPSTREAM ${final.aliases[inputs[0] as string]} `);
      if (!direct)
        expect(final.run.input).not.toContain(`<<<UPSTREAM ${final.aliases[report.id]} `);
    },
  );

  it('waits for every decision even with an active OR gate; inactive wires ignore producer state', async () => {
    const { chair } = await startWire('fake-branch-low');
    const flow = conditionalWireFlow();
    const steps = requireValue(chair.steps);
    const final = requireValue(stepOf(chair, 'final'));
    const decision = stepOf(chair, 'decision') as ConditionStep;
    final.run.state = 'pending';
    // The No gate is already active; the separate conditional data decision must still resolve.
    flow.nodes.push({
      id: 'other',
      kind: 'condition',
      mode: 'all',
      rules: [{ field: 'score', op: '>=', value: 5 }],
    });
    flow.edges.push(
      { from: 'judge', to: 'other', anonymous: false },
      { from: 'decision', to: 'final', gate: 'no', anonymous: false },
    );
    requireValue(flow.edges.find((e) => e.when)).when = { condition: 'other', exit: 'yes' };
    const other: ConditionStep = {
      ...structuredClone(decision),
      id: 'other',
      result: null,
      run: { state: 'pending', error: null, startedAt: null, endedAt: null },
    };
    steps.push(other);
    for (const state of ['pending', 'failed'] as const) {
      other.run.state = state;
      expect(wireState(flow, steps, 'report', 'final')).toBe('waiting');
      expect(scheduleFlow(flow, steps).ready).not.toContain('final');
      expect(finalInputsReady(flow, chair).enough).toBe(false);
    }
    other.run.state = 'done';
    other.result = false;
    for (const state of ['running', 'failed', 'done'] as const) {
      requireValue(stepOf(chair, 'report')).run.state = state;
      expect(wireState(flow, steps, 'report', 'final')).toBe('inactive');
      expect(scheduleFlow(flow, steps).ready).toContain('final');
      expect(finalInputsReady(flow, chair)).toEqual({ answers: 1, minimum: 1, enough: true });
    }
    other.run.state = 'skipped';
    expect(wireState(flow, steps, 'report', 'final')).toBe('inactive');
    requireValue(agentsOf(flow).find((a) => a.id === 'final')).required = ['report'];
    expect(scheduleFlow(flow, steps).skipped).toContain('final');
    expect(finalInputsReady(flow, chair).enough).toBe(false);
  });

  it('keeps minima unchanged for scheduling, admission and stop-rest', async () => {
    const { chair } = await startWire();
    const flow = conditionalWireFlow();
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    requireValue(stepOf(chair, 'final')).run.state = 'pending';
    requireValue(final.responses).min = 2;
    expect(eligibleFlow(flow, []).blocked).toBe(true);
    expect(scheduleFlow(flow, requireValue(chair.steps)).blocked).toContain('final');
    expect(finalInputsReady(flow, chair)).toEqual({ answers: 1, minimum: 2, enough: false });
    requireValue(final.responses).min = 1;
    expect(eligibleFlow(flow, []).blocked).toBe(false);
    expect(finalInputsReady(flow, chair).enough).toBe(true);
    const decision = stepOf(chair, 'decision') as ConditionStep;
    decision.result = false;
    const rewriter = requireValue(stepOf(chair, 'rewriter'));
    rewriter.run.state = 'running';
    expect(finalInputsReady(flow, chair).enough).toBe(false);
    decision.run.state = 'skipped';
    expect(scheduleFlow(flow, requireValue(chair.steps)).ready).not.toContain('final');
    rewriter.run.state = 'skipped';
    rewriter.skipReason = 'inactive_branch';
    expect(scheduleFlow(flow, requireValue(chair.steps)).skipped).toContain('final');
  });

  it('defers availability until decisions resolve and preserves inactive required absence', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = conditionalWireFlow('fake-branch-low');
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    final.required = ['report'];
    final.responses = { ids: ['rewriter'], min: 1 };
    final.model = 'fake-unavailable-final';
    await store.addUnavailable({
      harness: 'pi',
      model: final.model,
      reason: 'rate limited',
      until: new Date(Date.now() + 60000).toISOString(),
    });
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    const snapshots: string[] = [];
    const chair = chairOf(started.session);
    started.round.subscribe((event) => {
      if (event.type === 'seat-start')
        snapshots.push(requireValue(stepOf(chair, 'final')).run.state);
    });
    await started.round.done;
    expect(snapshots[0]).toBe('pending');
    expect(stepOf(chair, 'final')).toMatchObject({
      skipReason: 'inactive_branch',
      run: { state: 'skipped' },
    });
  });

  it('settles an all-inactive response group before availability on retry, keeping its fallback inactive', async () => {
    process.env.DIVAN_FAKE = '1';
    process.env.DIVAN_FAKE_DELAY_MS = '2';
    const flow = branchFlow();
    const judge = requireValue(agentsOf(flow).find((a) => a.id === 'source'));
    judge.id = 'judge';
    const producer = requireValue(agentsOf(flow).find((a) => a.id === 'yes'));
    producer.id = 'producer';
    producer.model = 'fake-producer';
    const fallback = requireValue(agentsOf(flow).find((a) => a.id === 'no'));
    fallback.id = 'fallback';
    const recipient = {
      ...judge,
      id: 'recipient',
      model: 'fake-unavailable-recipient',
      responses: { ids: ['producer'], min: 1 },
    };
    const decision = requireValue(flow.nodes.find((n) => n.kind === 'condition'));
    const fallbackDecision = { ...decision, id: 'fallback-decision' };
    flow.nodes.push(recipient, fallbackDecision);
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    final.required = ['producer'];
    final.responses = { ids: ['judge', 'recipient', 'fallback'], min: 1 };
    flow.edges = [
      { from: 'input', to: 'producer', anonymous: false },
      { from: 'input', to: 'judge', anonymous: false },
      { from: 'judge', to: 'decision', anonymous: false },
      {
        from: 'producer',
        to: 'recipient',
        anonymous: true,
        when: { condition: 'decision', exit: 'no' },
      },
      { from: 'recipient', to: 'fallback-decision', anonymous: false },
      { from: 'fallback-decision', to: 'fallback', gate: 'no', anonymous: false },
      { from: 'producer', to: 'final', anonymous: true },
      {
        from: 'judge',
        to: 'final',
        anonymous: true,
        when: { condition: 'decision', exit: 'yes' },
      },
      {
        from: 'recipient',
        to: 'final',
        anonymous: true,
        when: { condition: 'fallback-decision', exit: 'yes' },
      },
      { from: 'fallback', to: 'final', anonymous: true },
      { from: 'final', to: 'output', anonymous: false },
    ];
    const runAgent = agents.runAgent;
    let producerCalls = 0;
    vi.spyOn(agents, 'runAgent').mockImplementation((spec) =>
      runAgent(
        spec.model === producer.model && producerCalls++ === 0
          ? { ...spec, model: 'fake-fail' }
          : spec,
      ),
    );
    const store = new Store(homeOf());
    await store.init();
    await store.addUnavailable({
      harness: 'pi',
      model: recipient.model,
      reason: 'rate limited',
      until: new Date(Date.now() + 60000).toISOString(),
    });
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    expect(chair.status).toBe('failed');
    expect(stepOf(chair, 'decision')).toMatchObject({ result: true });
    for (const id of ['recipient', 'fallback-decision', 'fallback'])
      expect(stepOf(chair, id)).toMatchObject({ skipReason: 'inactive_branch' });
    const settings = structuredClone(started.session.settings);
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(stepOf(chair, 'final')?.inputs).toEqual(['producer', 'judge']);
    for (const id of ['recipient', 'fallback-decision', 'fallback'])
      expect(stepOf(chair, id)).toMatchObject({
        skipReason: 'inactive_branch',
        run: { state: 'skipped' },
      });
    expect(chair.attempts.filter((a) => a.seatId === 'judge')).toHaveLength(1);
    expect(chair.attempts.filter((a) => a.seatId === 'producer')).toHaveLength(2);
    expect(chair.attempts.some((a) => a.seatId === 'fallback')).toBe(false);
    expect(started.session.settings).toEqual(settings);
  });

  it('recomputes needed producers after invalidating a retry decision and finishes in one retry', async () => {
    process.env.DIVAN_FAKE = '1';
    process.env.DIVAN_FAKE_DELAY_MS = '2';
    const flow = conditionalWireFlow();
    const producer = requireValue(agentsOf(flow).find((a) => a.id === 'report'));
    producer.model = 'fake-producer';
    const judge = requireValue(agentsOf(flow).find((a) => a.id === 'judge'));
    judge.model = 'fake-judge';
    judge.required = [];
    requireValue(agentsOf(flow).find((a) => a.id === 'rewriter')).required = ['judge'];
    flow.edges = flow.edges.filter(
      (e) => !(e.from === 'report' && ['judge', 'rewriter'].includes(e.to)),
    );
    flow.edges.push({ from: 'input', to: 'judge', anonymous: false });
    requireValue(flow.edges.find((e) => e.from === 'rewriter' && e.to === 'final')).when = {
      condition: 'decision',
      exit: 'no',
    };
    const runAgent = agents.runAgent;
    const failed = new Set<string>();
    vi.spyOn(agents, 'runAgent').mockImplementation((spec) => {
      if ([producer.model, judge.model].includes(spec.model) && !failed.has(spec.model)) {
        failed.add(spec.model);
        return runAgent({ ...spec, model: 'fake-fail' });
      }
      return runAgent(spec);
    });
    const store = new Store(homeOf());
    await store.init();
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    expect(chair.status).toBe('failed');
    for (const id of ['report', 'judge']) expect(stepOf(chair, id)?.run.state).toBe('failed');
    expect(stepOf(chair, 'decision')).toMatchObject({ result: false, reason: 'source_failed' });
    expect(stepOf(chair, 'rewriter')?.run.state).toBe('blocked');
    const settings = structuredClone(started.session.settings);
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(stepOf(chair, 'decision')).toMatchObject({ result: true });
    expect(stepOf(chair, 'final')?.inputs).toEqual(['report']);
    for (const id of ['report', 'judge'])
      expect(chair.attempts.filter((a) => a.seatId === id)).toHaveLength(2);
    expect(stepOf(chair, 'rewriter')).toMatchObject({ skipReason: 'inactive_branch' });
    expect(started.session.settings).toEqual(settings);
  });

  it('withholds unresolved and inactive payloads across every save, but excludes inactive required readers', async () => {
    const { session, chair } = await startWire();
    const flow = requireValue(session.settings.flow);
    const report = requireValue(stepOf(chair, 'report'));
    if (report.form !== 'report') throw new Error('fixture');
    report.run.sanitized = report.run.parsed = { report: 'PRIVATE DRAFT' };
    report.run.rawOutput = 'PRIVATE RAW';
    report.run.prompt = 'PRIVATE PROMPT';
    report.run.toolLog = [
      { kind: 'file', target: 'PRIVATE FILE', name: 'read', at: new Date().toISOString() },
    ];
    requireValue(stepOf(chair, 'final')).run.state = 'pending';
    const decision = stepOf(chair, 'decision') as ConditionStep;
    chair.status = 'running';
    for (const state of ['pending', 'done'] as const) {
      decision.run.state = state;
      decision.result = false;
      requireValue(stepOf(chair, 'rewriter')).run.state = 'pending';
      for (const over of [{}, { name: 'renamed' }, { layout: session.layout }])
        expect(serializeSession(session, over)).not.toContain('PRIVATE');
      expect(releasableSteps(flow, requireValue(chair.steps)).has('report')).toBe(false);
    }
    decision.result = true;
    requireValue(stepOf(chair, 'rewriter')).run.state = 'skipped';
    expect(serializeSession(session)).toContain('PRIVATE DRAFT');
    expect(serializeSession(session)).not.toContain('PRIVATE RAW');
    // An inactive response still leaves final a reader of its alternative; an inactive required wire excludes it.
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    final.required = ['report'];
    final.responses = { ids: ['rewriter'], min: 1 };
    decision.result = false;
    expect(releasableSteps(flow, requireValue(chair.steps)).has('report')).toBe(true);
  });

  it('recovers a lost judge, flips the decision and retries the needed rewriter instead of counting the inactive draft', async () => {
    const { session, chair } = await startWire();
    chair.status = 'running';
    requireValue(stepOf(chair, 'final')).run.state = 'pending';
    const before = chair.attempts.length;
    const home = homeOf();
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', `${session.id}.json`), serializeSession(session));
    const store = new Store(home);
    await store.init();
    const recovered = requireValue(store.get(session.id)),
      round = chairOf(recovered);
    expect(stepOf(round, 'report')?.run.state).toBe('done');
    expect(stepOf(round, 'decision')).toMatchObject({ result: null, run: { state: 'failed' } });
    expect(stepOf(round, 'rewriter')?.run.state).toBe('failed');
    requireValue(
      agentsOf(requireValue(recovered.settings.flow)).find((a) => a.id === 'judge'),
    ).model = 'fake-branch-low';
    requireValue(stepOf(round, 'judge')).run.model = 'fake-branch-low';
    const engine = new Engine(store, () => {});
    await engine.rerun(recovered.id, round.id);
    const live = engine.follow(recovered.id, round.id);
    let savedBeforeCall = false;
    live?.subscribe((event) => {
      if (event.type === 'seat-start' && event.stepId === 'judge') {
        const saved = JSON.parse(
          readFileSync(join(home, 'sessions', `${session.id}.json`), 'utf8'),
        ) as Session;
        const savedReport = stepOf(chairOf(saved), 'report');
        savedBeforeCall = savedReport?.form === 'report' && savedReport.run.sanitized === null;
      }
    });
    await live?.done;
    expect(savedBeforeCall).toBe(true);
    expect(round.status).toBe('done');
    expect(stepOf(round, 'decision')).toMatchObject({ result: false });
    expect(stepOf(round, 'final')?.inputs).toEqual(['rewriter']);
    expect(round.attempts.slice(before).map((a) => a.seatId)).toEqual(['judge', 'rewriter', null]);
    expect(round.attempts.filter((a) => a.seatId === 'report')).toHaveLength(1);
    // Losing just the decision also reaches final through its implied link.
    expect(
      invalidateDescendants(requireValue(recovered.settings.flow), requireValue(round.steps), [
        'decision',
      ]),
    ).toEqual(new Set(['decision', 'rewriter', 'final']));
    expect(round.attempts).toHaveLength(before + 3);
  });

  it('validates edge shape, exit uses, implied cycles and identity', () => {
    const flow = conditionalWireFlow();
    expect(() => validateFlow(flow)).not.toThrow();
    expect(
      orderedNodes(flow)
        .map((node) => node.id)
        .indexOf('decision'),
    ).toBeLessThan(
      orderedNodes(flow)
        .map((node) => node.id)
        .indexOf('final'),
    );
    const edge = requireValue(flow.edges.find((e) => e.when));
    const base = canonicalFlow(flow);
    edge.when = { condition: 'another', exit: 'yes' };
    expect(canonicalFlow(flow)).not.toBe(base);
    edge.when = { condition: 'decision', exit: 'no' };
    expect(canonicalFlow(flow)).not.toBe(base);
    delete edge.when;
    expect(canonicalFlow(flow)).not.toBe(base);
    expect(() => validateFlow(flow)).toThrow('condition exits');
    for (const when of [
      null,
      [],
      { condition: 'report', exit: 'yes' },
      { condition: 'missing', exit: 'yes' },
      { condition: 'decision', exit: 'maybe' },
    ]) {
      edge.when = when as unknown as NonNullable<typeof edge.when>;
      expect(() => validateFlow(flow)).toThrow('when');
    }
    edge.when = { condition: 'decision', exit: 'yes' };
    for (const forbidden of flow.edges.filter(
      (e) =>
        e !== edge &&
        (e.gate || ['input', 'output', 'decision'].includes(e.to) || e.from === 'input'),
    )) {
      forbidden.when = edge.when;
      expect(() => validateFlow(flow)).toThrow('when');
      delete forbidden.when;
    }
    requireValue(flow.edges.find((e) => e.to === 'judge')).when = edge.when;
    expect(() => validateFlow(flow)).toThrow('cycle');
  });
});
const homeOf = () => {
  const home = mkdtempSync(join(tmpdir(), 'divan-branches-'));
  homes.push(home);
  return home;
};
const chairOf = (session: Session): ChairNode =>
  Object.values(session.nodes).find((n): n is ChairNode => n.kind === 'chair') as ChairNode;
async function start(model = 'fake-1') {
  process.env.DIVAN_FAKE = '1';
  process.env.DIVAN_FAKE_DELAY_MS = '2';
  const store = new Store(homeOf());
  await store.init();
  const engine = new Engine(store, () => {});
  const started = await engine.createSessionWithRound({ ...flowInput(), flow: branchFlow(model) });
  await started.round.done;
  return { store, engine, session: started.session, chair: chairOf(started.session) };
}
describe('conditions and branches', () => {
  it('reruns an active unavailable branch after the limit clears, without retrying the source or inactive branch', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = branchFlow();
    requireValue(agentsOf(flow).find((a) => a.id === 'yes')).model = 'fake-available-later';
    const unavailable = {
      harness: 'pi' as const,
      model: 'fake-available-later',
      reason: 'rate limited',
    };
    await store.addUnavailable({
      ...unavailable,
      until: new Date(Date.now() + 60000).toISOString(),
    });
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    expect(chair.status).toBe('failed');
    expect(stepOf(chair, 'decision')).toMatchObject({ result: true });
    expect(stepOf(chair, 'yes')).toMatchObject({
      skipReason: 'unavailable',
      run: { state: 'skipped' },
    });
    expect(stepOf(chair, 'no')).toMatchObject({ skipReason: 'inactive_branch' });
    expect(chair.attempts).toHaveLength(1);
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('failed');
    expect(chair.attempts).toHaveLength(1);
    await store.addUnavailable({ ...unavailable, until: new Date(0).toISOString() });
    expect(store.readUnavailable()).toEqual([]);
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(stepOf(chair, 'yes')?.run.state).toBe('done');
    expect(stepOf(chair, 'no')?.skipReason).toBe('inactive_branch');
    expect(chair.attempts.map((a) => a.seatId)).toEqual(['source', 'yes', null]);
  });

  it('retries a needed user-skipped branch and retains the settled gate', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = branchFlow();
    requireValue(agentsOf(flow).find((a) => a.id === 'yes')).model = 'fake-slow';
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    const chair = chairOf(started.session);
    started.round.subscribe((event) => {
      if (event.type === 'seat-start' && event.stepId === 'yes')
        queueMicrotask(() => engine.skipSeat(started.session.id, chair.id, { seatId: 'yes' }));
    });
    await started.round.done;
    expect(chair.status).toBe('failed');
    expect(stepOf(chair, 'yes')).toMatchObject({ skipReason: 'user' });
    requireValue(
      agentsOf(requireValue(started.session.settings.flow)).find((a) => a.id === 'yes'),
    ).model = 'fake-1';
    requireValue(stepOf(chair, 'yes')).run.model = 'fake-1';
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(stepOf(chair, 'decision')).toMatchObject({ result: true });
    expect(chair.attempts.filter((a) => a.seatId === 'source')).toHaveLength(1);
    expect(stepOf(chair, 'yes')?.skipReason).toBeUndefined();
  });

  it('keeps a sufficient response group when retrying a failed final agent', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = branchFlow();
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    final.model = 'fake-fail';
    // A failed independent peer is optional once the active branch has answered.
    const peer = {
      ...requireValue(agentsOf(flow).find((a) => a.id === 'yes')),
      id: 'optional',
      model: 'fake-fail',
    };
    flow.nodes.push(peer);
    requireValue(final.responses).ids.push(peer.id);
    flow.edges.push(
      { from: 'input', to: peer.id, anonymous: false },
      { from: peer.id, to: 'final', anonymous: true },
    );
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    expect(chair.status).toBe('failed');
    const before = chair.attempts.length;
    requireValue(
      agentsOf(requireValue(started.session.settings.flow)).find((a) => a.id === 'final'),
    ).model = 'fake-2';
    const step = requireValue(stepOf(chair, 'final'));
    step.run.model = 'fake-2';
    await engine.rerun(started.session.id, chair.id);
    await engine.follow(started.session.id, chair.id)?.done;
    expect(chair.status).toBe('done');
    expect(chair.attempts.slice(before).map((a) => a.seatId)).toEqual([null]);
  });

  it('keeps custom-form error codes and parameters on the saved step', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = branchFlow();
    requireValue(agentsOf(flow).find((a) => a.id === 'source')).model = 'fake-invalid';
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    const saved = JSON.parse(
      readFileSync(join(store.home, 'sessions', `${started.session.id}.json`), 'utf8'),
    ) as Session;
    expect(stepOf(chairOf(saved), 'source')).toMatchObject({
      errorNote: { code: 'custom_form_invalid', params: { field: 'answer' } },
      run: { state: 'invalid', error: 'The answer does not match the requested form at answer.' },
    });
    expect(chair.status).toBe('done');
  });
  it('projects custom fields into an actual recipient prompt, including the final agent', async () => {
    process.env.DIVAN_FAKE = '1';
    const store = new Store(homeOf());
    await store.init();
    const flow = branchFlow();
    const yes = requireValue(agentsOf(flow).find((a) => a.id === 'yes'));
    yes.required = ['source'];
    flow.edges.push({ from: 'source', to: 'yes', fields: ['score'], anonymous: true });
    const final = requireValue(agentsOf(flow).find((a) => a.id === 'final'));
    final.required = ['source'];
    flow.edges.push({ from: 'source', to: 'final', fields: ['score'], anonymous: true });
    const engine = new Engine(store, () => {});
    const started = await engine.createSessionWithRound({ ...flowInput(), flow });
    await started.round.done;
    const chair = chairOf(started.session);
    expect(chair.status).toBe('done');
    const recipient = requireValue(stepOf(chair, 'yes'));
    if (recipient.form !== 'report') throw new Error('fixture');
    expect(recipient.run.prompt).toContain('{"score":5}');
    expect(recipient.run.prompt).not.toContain('"note"');
    const answer = requireValue(stepOf(chair, 'final'));
    if (answer.form !== 'answer') throw new Error('fixture');
    expect(answer.run.input).toContain('{"score":5}');
    expect(answer.run.input).not.toContain('"note"');
  });
  it.each([
    ['fake-1', true, 'yes'],
    ['fake-branch-low', false, 'no'],
    ['fake-fail', false, 'no'],
  ] as const)('runs %s through the expected branch on fakes', async (model, result, branch) => {
    const { session, chair } = await start(model);
    expect(chair.status).toBe('done');
    expect(stepOf(chair, 'decision')).toMatchObject({ result, run: { state: 'done' } });
    expect(stepOf(chair, branch)?.run.state).toBe('done');
    expect(stepOf(chair, branch === 'yes' ? 'no' : 'yes')).toMatchObject({
      run: { state: 'skipped', error: 'inactive_branch' },
    });
    expect(chair.attempts).toHaveLength(3);
    expect(
      planOf(session, chair).find((s) => s.content.startsWith('Condition decision'))?.content,
    ).toMatch(/match|did not answer/u);
    expect(maxCalls(session.settings.flow as NonNullable<Session['settings']['flow']>)).toBe(4);
  });
  it('pins inactive, OR-gate, required-input, quorum and missing-field rules', async () => {
    const { chair } = await start();
    const flow = branchFlow();
    const steps = chair.steps ?? [];
    for (const s of steps) s.run.state = 'pending';
    const source = stepOf(chair, 'source');
    if (source?.form !== 'custom') throw new Error('fixture');
    source.run.state = 'failed';
    source.run.error = 'interrupted';
    expect(scheduleFlow(flow, steps).conditions).toEqual([]);
    source.run.error = 'failed';
    expect(scheduleFlow(flow, steps).conditions).toEqual(['decision']);
    const decision = stepOf(chair, 'decision') as ConditionStep;
    decision.run.state = 'skipped';
    decision.run.error = 'inactive_branch';
    expect(scheduleFlow(flow, steps).skipped).toEqual(['no', 'yes']);
    decision.run.state = 'done';
    decision.result = true;
    expect(scheduleFlow(flow, steps).ready).toContain('yes');
    expect(finalInputsReady(flow, chair).enough).toBe(false);
    const final = agentsOf(flow).find((a) => a.id === 'final');
    if (!final) throw new Error('fixture');
    final.required = ['source'];
    source.run.state = 'skipped';
    source.run.error = 'inactive_branch';
    expect(scheduleFlow(flow, steps).skipped).toContain('final');
    source.run.error = 'skipped by user';
    for (const id of ['yes', 'no']) {
      const s = stepOf(chair, id);
      if (s) {
        s.run.state = 'skipped';
        s.run.error = 'inactive_branch';
      }
    }
    expect(scheduleFlow(flow, steps).blocked).toContain('final');
    final.required = [];
    expect(scheduleFlow(flow, steps).skipped).toContain('final');
    const condition = flow.nodes.find((n) => n.kind === 'condition');
    if (condition?.kind !== 'condition') throw new Error('fixture');
    expect(
      evaluateCondition(
        {
          ...condition,
          mode: 'any',
          rules: [
            { field: 'score', op: '>=', value: 1 },
            { field: 'note', op: 'contains', value: 'yes' },
          ],
        },
        { score: 8, note: null },
      ),
    ).toEqual({ result: false, reason: 'missing_field' });
    flow.edges.push({ from: 'decision', to: 'yes', gate: 'no', anonymous: false });
    expect(scheduleFlow(flow, steps).ready).not.toContain('yes');
    requireValue(stepOf(chair, 'yes')).run.state = 'pending';
    decision.result = false;
    expect(scheduleFlow(flow, steps).ready).toContain('yes');
  });
  it('rejects invalid rules, gates and field picks; identity includes each', () => {
    const flow = branchFlow();
    const base = canonicalFlow(flow);
    const condition = flow.nodes.find((n) => n.kind === 'condition');
    if (condition?.kind !== 'condition') throw new Error('fixture');
    requireValue(condition.rules[0]).value = 8;
    expect(canonicalFlow(flow)).not.toBe(base);
    requireValue(condition.rules[0]).field = 'missing';
    expect(() => validateFlow(flow)).toThrow('condition field');
    requireValue(condition.rules[0]).field = 'score';
    requireValue(condition.rules[0]).op = 'contains';
    expect(() => validateFlow(flow)).toThrow('condition operator');
    const projected = branchFlow();
    requireValue(projected.edges.find((e) => e.from === 'source' && e.to === 'decision')).fields = [
      'score',
    ];
    expect(() => validateFlow(projected)).toThrow('fields');
  });
  it('eligibility cannot count mutually exclusive peers toward a minimum of two', () => {
    const flow = branchFlow();
    expect(eligibleFlow(flow, []).blocked).toBe(false);
    requireValue(requireValue(agentsOf(flow).find((a) => a.id === 'final')).responses).min = 2;
    expect(eligibleFlow(flow, []).blocked).toBe(true);
  });
  it('withholds full payload for a partial wire across every save, and recovery clears dependent decisions', async () => {
    const { session, chair } = await start();
    const flow = requireValue(session.settings.flow);
    const yes = requireValue(agentsOf(flow).find((a) => a.id === 'yes'));
    yes.required = ['source'];
    flow.edges.push({ from: 'source', to: 'yes', fields: ['score'], anonymous: true });
    expect(projectOutput(flow, 'source', 'yes', { score: 5, note: 'private' })).toEqual({
      score: 5,
    });
    const source = stepOf(chair, 'source');
    if (source?.form !== 'custom') throw new Error('fixture');
    source.run.parsed = source.run.sanitized = { score: 5, note: 'PRIVATE SOURCE' };
    source.run.prompt = 'PRIVATE PROMPT';
    source.run.rawOutput = 'PRIVATE RAW';
    requireValue(stepOf(chair, 'yes')).run.state = 'pending';
    requireValue(stepOf(chair, 'final')).run.state = 'pending';
    chair.status = 'running';
    for (const over of [{}, { name: 'renamed' }, { layout: session.layout }]) {
      const text = serializeSession(session, over);
      expect(text).not.toContain('PRIVATE');
      const restored = JSON.parse(text) as Session;
      interruptRunning(restored, () => 1);
      const recovered = chairOf(restored);
      expect(stepOf(recovered, 'decision')).toMatchObject({
        result: null,
        run: { state: 'failed', error: 'interrupted' },
      });
      expect(stepOf(recovered, 'no')?.run.state).toBe('failed');
    }
    source.run.sanitized = { score: 1, note: 'changed' };
    invalidateDescendants(flow, requireValue(chair.steps), ['source']);
    expect(stepOf(chair, 'decision')?.run.state).toBe('pending');
    expect(stepOf(chair, 'yes')?.run.state).toBe('pending');
    expect(stepOf(chair, 'no')?.run.state).toBe('pending');
  });
  it('recovers a withheld source from disk, reruns it, and recomputes the other branch', async () => {
    const { session, chair } = await start();
    chair.status = 'running';
    requireValue(stepOf(chair, 'final')).run.state = 'pending';
    const home = homeOf();
    mkdirSync(join(home, 'sessions'), { recursive: true });
    writeFileSync(join(home, 'sessions', `${session.id}.json`), serializeSession(session));
    const store = new Store(home);
    await store.init();
    const recovered = requireValue(store.get(session.id));
    const round = chairOf(recovered);
    const flow = requireValue(recovered.settings.flow);
    requireValue(agentsOf(flow).find((a) => a.id === 'source')).model = 'fake-branch-low';
    const source = requireValue(stepOf(round, 'source'));
    if (source.form === 'custom') source.run.model = 'fake-branch-low';
    const engine = new Engine(store, () => {});
    await engine.rerun(recovered.id, round.id);
    await engine.follow(recovered.id, round.id)?.done;
    expect(round.status).toBe('done');
    expect(stepOf(round, 'decision')).toMatchObject({ result: false });
    expect(stepOf(round, 'no')?.run.state).toBe('done');
    expect(
      JSON.parse(readFileSync(join(home, 'sessions', `${session.id}.json`), 'utf8')).nodes[round.id]
        .status,
    ).toBe('done');
  });
});
