import { resolveFlow } from '../src/server/library.ts';
// A council on the canvas (web/src/pages/councils/design/council.ts): it is drawn like a design, an edit it can say keeps it a
// council, an edit it cannot makes it a design, and the form saves that design with the level overrides the council had. Pure
// functions only: the page itself is in e2e/run.mjs.

import { describe, expect, it } from 'vitest';
import { flowForms } from '../src/server/flow-templates.ts';
import { type Detection, resolveLevel } from '../src/server/settings.ts';
import { agentsOf, canonicalFlow } from '../src/shared/flow.ts';
import { diffSettings } from '../src/shared/settings.ts';
import type {
  HarnessModels,
  LevelOverrides,
  LevelView,
  ReasoningLevel,
  SeatConfig,
  SettingsFull,
} from '../src/shared/types.ts';
import {
  councilFlow,
  councilIds,
  councilOfFlow,
  designOf,
  draftLevel,
  overridesForDesign,
} from '../web/src/pages/councils/design/council.ts';
import {
  addAgent,
  agentOf,
  connect,
  disconnect,
  type FormDefaults,
  normalizeFlow,
  patchAgent,
  problemOf,
  removeNode,
  setForm,
  setLabel,
  setMinimum,
  setPlaces,
  visibleEdges,
} from '../web/src/pages/councils/design/edit.ts';
import { saveBody } from '../web/src/pages/councils/form-diff.ts';
import { writerFlow } from './fixtures/flows.ts';

const FORMS: FormDefaults = (() => {
  const flow = writerFlow();
  const of = (form: 'report' | 'member' | 'answer') => {
    const agent = agentsOf(flow).find((item) => item.form === form);
    if (!agent) throw new Error(form);
    return { rules: agent.rules, schema: agent.schema };
  };
  return {
    report: of('report'),
    member: of('member'),
    answer: { ...of('answer'), directRules: flowForms().answer.directRules },
  };
})();

const member = (id: string, enabled = true): SeatConfig => ({
  id,
  enabled,
  harness: 'pi',
  model: 'fake-1',
  effort: 'medium',
  tools: false,
  memory: false,
  web: false,
});
const council: SettingsFull = {
  seats: [member('a'), member('b'), member('c'), member('d')],
  chairman: { harness: 'pi', model: 'fake-2', effort: 'medium' },
  budgets: { maxClaims: 5, maxWords: 30 },
};
const KEEP = ['a', 'b', 'c', 'd'];
const NEW_AGENT = { harness: 'pi', model: 'fake-1', effort: 'low' } as const;

describe('a council is drawn like a design', () => {
  it('has Input, each member, the chairman who waits for two of them, and the answer', () => {
    const flow = councilFlow(council);
    expect(flow.kind).toBe('council');
    expect(flow.nodes.map((node) => node.id)).toEqual([
      'input',
      'a',
      'b',
      'c',
      'd',
      'chairman',
      'output',
    ]);
    expect(agentOf(flow, 'chairman')?.responses).toEqual({ ids: ['a', 'b', 'c', 'd'], min: 2 });
    expect(flow.edges).toHaveLength(10);
    // the chairman is fed by the members: Input needs no line to it
    expect(visibleEdges(flow)).toHaveLength(9);
    // the design editor's own moves leave a drawn council as it is
    expect(canonicalFlow(normalizeFlow(flow))).toBe(canonicalFlow(flow));
  });

  it('draws a member that is switched off, off; a council always needs two member answers, showing a shortage', () => {
    const flow = councilFlow({ ...council, seats: [member('a'), member('b', false)] });
    expect(agentOf(flow, 'b')?.enabled).toBe(false);
    expect(agentOf(flow, 'a')).not.toHaveProperty('enabled');
    expect(
      agentOf(councilFlow({ ...council, seats: [member('a')] }), 'chairman')?.responses?.min,
    ).toBe(2);
    expect(agentOf(councilFlow({ ...council, seats: [] }), 'chairman')?.responses).toEqual({
      ids: [],
      min: 2,
    });
    // the boxes that are not members keep out of a member's way, as in a council that runs
    expect(councilIds([{ id: 'chairman' }, { id: 'input' }])).toEqual({
      input: 'input_',
      output: 'output',
      chairman: 'chairman_',
    });
  });
});

describe('an edit a council can say keeps it a council', () => {
  const flow = councilFlow(council);

  it('a model, access, a member on or off, and the chairman', () => {
    const model = councilOfFlow(patchAgent(flow, 'a', { model: 'fake-2' }), council, KEEP);
    expect(model?.seats[0]?.model).toBe('fake-2');
    // what was not touched is the very same object
    expect(model?.seats[1]).toBe(council.seats[1]);
    expect(model?.chairman).toBe(council.chairman);
    const off = councilOfFlow(patchAgent(flow, 'c', { enabled: false }), council, KEEP);
    expect(off?.seats.map((seat) => seat.enabled)).toEqual([true, true, false, true]);
    const tools = councilOfFlow(patchAgent(flow, 'b', { tools: true }), council, KEEP);
    expect(tools?.seats[1]?.tools).toBe(true);
    const chair = councilOfFlow(patchAgent(flow, 'chairman', { model: 'fake-1' }), council, KEEP);
    expect(chair?.chairman.model).toBe('fake-1');
    expect(chair?.seats).toEqual(council.seats);
    const noTools = councilOfFlow(patchAgent(flow, 'chairman', { tools: false }), council, KEEP);
    expect(noTools?.chairman.tools).toBe(false);
    expect(agentOf(councilFlow(noTools as SettingsFull), 'chairman')?.tools).toBe(false);
    expect(diffSettings(council, noTools as SettingsFull).chairman).toEqual({ tools: false });
    // nothing changed: the council itself
    expect(councilOfFlow(flow, council, KEEP)).toEqual(council);
  });

  it('a member added or removed; a default member cannot be removed, only switched off', () => {
    const more = { ...council, seats: [...council.seats, member('x1')] };
    expect(councilOfFlow(councilFlow(more), council, KEEP)?.seats).toHaveLength(5);
    const gone = removeNode(flow, 'd');
    expect(councilOfFlow(gone, council, ['a', 'b', 'c'])?.seats.map((seat) => seat.id)).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(councilOfFlow(gone, council, KEEP)).toBeNull();
  });
});

describe('an edit a council cannot say makes it a design', () => {
  const flow = councilFlow(council);

  it.each([
    ['a line between two members', connect(flow, 'a', 'b')],
    ['a line taken away', disconnect(flow, 'a', 'chairman')],
    ['a response minimum other than two', setMinimum(flow, 'chairman', 3)],
    ['another output form', setForm(flow, 'a', 'report', FORMS)],
    ['a writer', addAgent(flow, NEW_AGENT, FORMS, 'report').flow],
    ['a prompt', patchAgent(flow, 'a', { rules: 'Always answer in French.' })],
    ['a name', setLabel(flow, 'a', 'The first')],
    ['a place', setPlaces(flow, { a: { x: 1, y: 2 } })],
  ])('%s', (_what, next) => {
    expect(councilOfFlow(next, council, KEEP)).toBeNull();
  });

  it('becomes a valid design: standard prompts, the writer’s draft required by the final agent', () => {
    const made = addAgent(flow, NEW_AGENT, FORMS, 'report');
    const design = designOf(made.flow, FORMS);
    expect(design.kind).toBe('custom');
    expect(() => resolveFlow(design)).not.toThrow();
    expect(problemOf(design)).toBeNull();
    expect(agentOf(design, 'a')?.rules).toBe(FORMS.member.rules);
    expect(agentOf(design, 'chairman')).toMatchObject({ role: 'rewriter', required: [made.id] });
    // the council as it is, with nothing changed, is a design too (the «Make it a design» button); a switched-off member stays off
    const seats = [member('a'), member('b'), member('c', false)];
    const off = designOf(councilFlow({ ...council, seats }), FORMS);
    expect(problemOf(off)).toBeNull();
    expect(agentOf(off, 'c')?.enabled).toBe(false);
  });

  it('carries a council’s level overrides to the design’s agents: members by id, the chairman as the final agent', () => {
    const design = designOf(councilFlow(council), FORMS);
    expect(
      overridesForDesign(
        {
          seats: { a: { model: 'fake-2', enabled: false }, gone: { model: 'x' } },
          chairman: { model: 'fake-1', memory: true },
        },
        design,
      ),
    ).toEqual({ nodes: { a: { model: 'fake-2', enabled: false }, chairman: { model: 'fake-1' } } });
    expect(overridesForDesign({}, design)).toEqual({});
  });
});

// ---------- what the form saves for a council that became a design ----------

const model = (id: string, efforts: string[]) => ({
  id,
  label: id,
  efforts,
  defaultEffort: efforts.at(-1) ?? '',
});
const pi: HarnessModels = {
  harness: 'pi',
  models: [model('fake-1', ['low', 'medium', 'high', 'max']), model('fake-2', ['low', 'medium'])],
  listed: true,
  defaultModel: 'fake-1',
  note: null,
  fallbackEfforts: [],
  fetchedAt: '',
};
const detection: Detection = {
  status: [{ id: 'pi', installed: true, usable: true, note: null }],
  models: [pi],
  defaults: council,
  detectedAt: '',
};
function levelView(level: ReasoningLevel, stored: LevelOverrides): LevelView {
  const resolved = resolveLevel(detection, council, level, stored, new Map());
  return {
    effective: resolved.effective,
    derived: resolved.derived,
    overrides: stored,
    fingerprint: 'fp',
    skipped: [],
    notes: [],
  };
}
const LEVELS: ReasoningLevel[] = ['low', 'medium', 'high', 'max'];
const baselineOf = (stored: Partial<Record<ReasoningLevel, LevelOverrides>> = {}) => ({
  revision: 4,
  fingerprint: 'fp',
  defaults: council,
  base: council,
  levels: Object.fromEntries(
    LEVELS.map((level) => [level, levelView(level, stored[level] ?? {})]),
  ) as Record<ReasoningLevel, LevelView>,
});
const formOf = (baseline: ReturnType<typeof baselineOf>) => ({
  base: baseline.base,
  levels: Object.fromEntries(
    Object.entries(baseline.levels).map(([level, view]) => [level, view.effective]),
  ) as Record<ReasoningLevel, SettingsFull>,
  defaultLevel: 'medium' as const,
});

describe('what the form saves for a council that became a design', () => {
  it('sends the design, and the levels’ overrides by agent: nothing a council kept by seat is sent', () => {
    const baseline = baselineOf({
      high: { seats: { b: { model: 'fake-2' } }, chairman: { effort: 'low' } },
      low: { seats: { a: { enabled: false } } },
    });
    const form = formOf(baseline);
    const design = designOf(addAgent(councilFlow(council), NEW_AGENT, FORMS, 'report').flow, FORMS);
    const body = saveBody({ ...form, base: { ...council, flow: design } }, baseline);
    expect(body).toMatchObject({ ifRevision: 4, ifFingerprint: 'fp', defaultLevel: 'medium' });
    expect(body).not.toHaveProperty('overrides');
    expect((body as { flow: typeof design }).flow).toEqual(design);
    expect(body.levels).toEqual({
      high: { nodes: { b: { model: 'fake-2' }, chairman: { effort: 'low' } } },
      low: { nodes: { a: { enabled: false } } },
    });
  });

  it('does not carry a model of an assistant a member no longer runs on', () => {
    const baseline = baselineOf({ high: { seats: { b: { model: 'fake-2' } } } });
    const form = formOf(baseline);
    const design = designOf(councilFlow(council), FORMS);
    const other = {
      ...design,
      nodes: design.nodes.map((node) =>
        node.id === 'b' ? { ...(node as object), harness: 'codex' } : node,
      ),
    } as typeof design;
    const body = saveBody({ ...form, base: { ...council, flow: other } }, baseline);
    expect(body.levels).toEqual({});
  });

  it('a council saved as a council is saved as before: overrides of the base, no design', () => {
    const baseline = baselineOf({ high: { seats: { b: { model: 'fake-2' } } } });
    const body = saveBody(formOf(baseline), baseline);
    expect(body).not.toHaveProperty('flow');
    expect(body.levels).toEqual({ high: { seats: { b: { model: 'fake-2' } } } });
  });

  it('shows the levels of a design that is not saved yet as the server will resolve them', () => {
    const design = designOf(councilFlow(council), FORMS);
    const base = { ...council, flow: design };
    const low = draftLevel(base, 'low', { seats: { a: { model: 'fake-2' } } }, [pi]);
    // the efforts the level calls for; every step is kept
    expect(agentsOf(low.derived).map((agent) => agent.effort)).toEqual(Array(5).fill('low'));
    expect(agentsOf(low.derived)).toHaveLength(5);
    expect(agentOf(low.effective, 'a')?.model).toBe('fake-2');
    expect(agentOf(low.effective, 'a')?.effort).toBe('low');
    expect(agentOf(low.derived, 'a')?.model).toBe('fake-1');
    const max = draftLevel(base, 'max', {}, [pi]);
    expect(agentOf(max.derived, 'a')?.effort).toBe('max');
  });
});
