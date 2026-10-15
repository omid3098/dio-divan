import {
  agentIdentity,
  agentsOf,
  branchSkipped,
  chairmanOf,
  compileCouncil,
  conditionSource,
  evaluateCondition,
  type Flow,
  type FlowAgent,
  type FlowStep,
  finalAgent,
  finalInputsReady,
  gateState,
  invalidateDescendants,
  orderedNodes,
  outputOfStep,
  projectOutput,
  type ReportOutput,
  replaceChairman,
  runsOf,
  scheduleFlow,
  seatsOf,
  stepOf,
  validateFlow,
  wireDecisionsResolved,
  wireState,
} from '../shared/flow.ts';
// The engine: creates sessions and runs rounds. A round is (a user node, a chairman node). Seats run in parallel and
// blind; the chairman sees only sanitized, validated, budget-capped member JSON. Nothing starts without a call from the
// API, which only runs on Omid's click: there is no auto mode. This file imports no HTTP or web code, so another front
// end can drive it: `startRound` / `cancelRound` in, ServerEvents out.

import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  buildContext,
  type InputParts,
  inputOfNode,
  inputParts,
  MAX_CONTEXT_CHARS,
  wordsOf,
} from '../shared/context.ts';
import { chairmanFamilyClash, IDLE_STOP_MS, QUICK_BLOCKED } from '../shared/defaults.ts';
import {
  ACCOUNT_OUT,
  CONNECTION_FAILURE,
  RATE_LIMIT,
  SKIPPED_BY_USER,
  SKIPPED_SAME_FAMILY,
} from '../shared/failure.ts';
import { HARNESS_RULES, heldValue, toggleProblem } from '../shared/harness-rules.ts';
import { builtinForm, compileForm } from '../shared/library.ts';
import {
  type MessageCode,
  type MessageParams,
  messageText,
  type Note,
  note,
} from '../shared/messages.ts';
import { estimateTokens, shorten } from '../shared/text.ts';
import type {
  Attempt,
  Budgets,
  ChairmanConfig,
  ChairmanRun,
  ChairNode,
  HarnessStatus,
  LayoutDirection,
  LensMode,
  LensPlan,
  MemberOutput,
  ReasoningLevel,
  RoundInput,
  SeatConfig,
  SeatRun,
  ServerEvent,
  Session,
  SessionNode,
  SessionOrigin,
  SessionSettings,
  ToolEvent,
  Usage,
  UserNode,
} from '../shared/types.ts';
import { type AgentRun, HARNESS_IDS, harnessInfos, isFake, runAgent } from './adapters/index.ts';
import type { RunSpec } from './adapters/types.ts';
import { validateCwd } from './cwd.ts';
import { detect } from './detection.ts';
import { eligibleFlow, eligibleSeats } from './eligibility.ts';
import { assignLenses, isLensMode, lensesWanted } from './lens.ts';
import { memoryReady } from './memory-access.ts';
import {
  parseChairman,
  parseCustom,
  parseMember,
  parsePlanner,
  parseReport,
  stripSelfIdentificationDeep,
  validateSchema,
} from './parse.ts';
import {
  CRITIQUE_INSTRUCTION,
  chairmanInput,
  chairmanRules,
  chairmanSchemaFor,
  lensMemberPrompt,
  lensOnlyMemberSchema,
  memberRules,
  memberSchemaFor,
  nativeSchema,
  plannerInput,
  plannerRules,
  plannerSchemaFor,
  reportSchemaFor,
  upstreamInput,
} from './prompts.ts';
import { type Overlay, type Store, summarize } from './store.ts';

/**
 * A refusal: a message `code` (the stable name of the error in the API) with its `params`; the English `message` is
 * made from them, and a client words the code in its own language (see `shared/messages.ts`).
 */
export class EngineError extends Error {
  readonly code: MessageCode;
  readonly status: number;
  readonly params: MessageParams | undefined;
  /** What the refusal adds to the answer's body (the current state a writer must adopt, for a 409). */
  readonly details: Record<string, unknown> | undefined;
  constructor(
    code: MessageCode,
    status = 400,
    params?: MessageParams,
    details?: Record<string, unknown>,
  ) {
    super(messageText(code, params));
    this.code = code;
    this.status = status;
    this.params = params;
    this.details = details;
  }

  /** A refusal that says what a note already says (a toggle that cannot be set so, a harness that is not supported). */
  static of(problem: Note, status = 400): EngineError {
    return new EngineError(problem.code, status, problem.params);
  }
}

/**
 * One write to the layout: where some nodes are and whether they are pinned (a drag pins, «چیدن» unpins and places all),
 * each against the revision of the node its writer saw, and optionally the direction. All of it is applied, or none.
 */
export interface LayoutOp {
  /** Names this write: the same id again is the same write, answered with the same answer. */
  opId: string;
  direction?: LayoutDirection;
  nodes: Record<string, { x: number; y: number; pinned: boolean; rev: number }>;
}

export interface LayoutAck {
  ok: true;
  /** The new revision of every node the write changed. */
  nodes: Record<string, { layoutRev: number }>;
}

const OP_ID = /^[A-Za-z0-9_-]{6,64}$/u;
/** How many answered writes a session remembers (a retry of one of them is answered again, not applied again). */
const REMEMBERED_OPS = 200;

const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomBytes(4).toString('hex')}`;
const anonymousAliases = (ids: string[]): Record<string, string> => {
  const labels = ids.map((_, index) => String.fromCharCode(65 + index));
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [labels[i], labels[j]] = [labels[j] as string, labels[i] as string];
  }
  return Object.fromEntries(ids.map((id, index) => [id, labels[index] as string]));
};
const log = (what: string, error: unknown) =>
  console.error(`[divan] ${what}: ${error instanceof Error ? error.message : String(error)}`);

const SAFE_ID = /^[A-Za-z0-9._:/@+-]{1,120}$/u;
const SAFE_EFFORT = /^[A-Za-z0-9._-]{0,24}$/u;

export const ACCOUNT_OUT_HOURS = 24;
export const RATE_LIMIT_HOURS = 1;

/** What the engine tells a listener about one round: short, anonymous, in the order it happens. */
export type RoundEvent = (
  | { type: 'seat-start'; label: string }
  | { type: 'seat-done'; label: string; stance: string }
  | {
      type: 'seat-failed';
      label: string;
      reason: 'failed' | 'timeout' | 'invalid' | 'cancelled' | 'skipped';
    }
  | { type: 'seat-note'; label: string }
  /** A member showed a sign of work (at most once a second per member). */
  | { type: 'seat-signal'; label: string; thinkingTokens: number | null }
  | { type: 'chairman'; answers: number }
  | { type: 'end'; status: ChairNode['status'] }
) & { stepId?: string; identity?: string };

/** A started round: wait for it (`done` resolves after the final save), stop it, or follow its progress. */
export interface RoundHandle {
  sessionId: string;
  userId: string;
  chairId: string;
  done: Promise<ChairNode['status']>;
  cancel(): void;
  /** Replays what has happened so far, then follows; the returned function stops listening. */
  subscribe(listener: (event: RoundEvent) => void): () => void;
}

interface ActiveRound {
  session: Session;
  controller: AbortController;
  done: Promise<void>;
  events: RoundEvent[];
  listeners: Set<(event: RoundEvent) => void>;
  /** The round is past its calls and is being saved: it can no longer be cancelled. */
  finalizing: boolean;
  /** One controller per member that is working: stopping the wait for one member aborts only its call. */
  seatControllers: Map<string, AbortController>;
  /** The members the asker stopped waiting for (their call was aborted for that, not for the round). */
  skippedByUser: Set<string>;
}

export interface CreateInput {
  /** Internal busy-session split: keep the original session's locked contract. */
  frozenSettings?: SessionSettings;
  /** The profile's resolved executable flow; absent compiles today's council. */
  flow?: Flow;
  name?: string;
  question: string;
  /** What the asker adds about the situation, apart from the question (trimmed, at most `MAX_CONTEXT_CHARS`); the council reads it right after the question. */
  context?: string;
  seats: SeatConfig[];
  chairman: ChairmanConfig;
  budgets: Budgets;
  /** The level the council was resolved at (kept in the session's settings; absent for a council that is not a profile's). */
  level?: ReasoningLevel;
  /** `quick`: the chairman must be of a family none of the members that run is; a start that breaks it is refused. */
  separateChairman?: boolean;
  origin?: SessionOrigin;
  /** Earlier conversation of an endpoint client, given to the members as context. */
  background?: string;
  /** A project folder the members read in during round 1 (already validated by the caller). */
  cwd?: string | null;
  /**
   * The session's working folder: kept in its settings, and every round of the session and of its branches runs with it. It is
   * checked here (a real folder that may be used); a folder that may not is refused.
   */
  folder?: string;
  /** The session's lens mode (an experiment, see `LensMode`); absent is `off`. A word that is not a mode is refused (`bad_lens_mode`). */
  lensMode?: unknown;
  /** The only client left the request: no round is admitted after it fires, and no member starts once it has. */
  signal?: AbortSignal;
}

function checkBudgets(budgets: Budgets): void {
  const within = (value: number, min: number, max: number) =>
    Number.isFinite(value) && Number.isInteger(value) && value >= min && value <= max;
  if (!within(budgets.maxClaims, 1, 10) || !within(budgets.maxWords, 5, 80)) {
    throw new EngineError('bad_budgets');
  }
}

/** `seat`: the number of the seat in the request; absent for the chairman. */
function checkModel(model: unknown, effort: unknown, seat?: number): void {
  if (typeof model !== 'string' || !SAFE_ID.test(model)) {
    if (seat === undefined) throw new EngineError('bad_chairman_model');
    throw new EngineError('bad_seat_model', 400, { seat });
  }
  if (typeof effort !== 'string' || !SAFE_EFFORT.test(effort)) {
    if (seat === undefined) throw new EngineError('bad_chairman_effort');
    throw new EngineError('bad_seat_effort', 400, { seat });
  }
}

const estimateUsage = (prompt: string, output: string): Usage => {
  const input = estimateTokens(prompt);
  const out = estimateTokens(output);
  return { input, output: out, cached: 0, total: input + out, source: 'estimate' };
};

/**
 * The schema a member answers in. A member that answers a lens alone (`only` mode) may give no recommendation; every other
 * member answers in the session's schema.
 */
function memberSchemaOf(
  schema: Session['settings']['memberSchema'],
  chair: ChairNode,
  seat: SeatRun,
) {
  return chair.lensMode === 'only' && seat.lens && seat.lens !== 'anchor'
    ? lensOnlyMemberSchema(schema)
    : schema;
}

/** The names a member could call itself in this session: harness labels and the seats' and chairman's model names. */
function identitiesOf(settings: SessionSettings): string[] {
  const labels = new Map(harnessInfos().map((info) => [info.id, info.label]));
  const names = new Set<string>();
  for (const seat of [
    ...settings.seats,
    settings.chairman,
    ...(settings.flow ? agentsOf(settings.flow) : []),
  ]) {
    const label = labels.get(seat.harness);
    if (label) names.add(label);
    if (seat.model) names.add(seat.model);
  }
  return [...names];
}

export class Engine {
  private store: Store;
  private emitEvent: (event: ServerEvent) => void;
  private pending = new Map<string, NodeJS.Timeout>();
  /** The rounds in flight, by chairman node id: aborting one stops only that round's processes. */
  private rounds = new Map<string, ActiveRound>();
  /** The one queue of changes of each session (see `mutate`). */
  private queues = new Map<string, Promise<unknown>>();
  /** The answers of the layout writes a session has taken, newest last, by write id. */
  private readonly layoutAnswers = new Map<string, Map<string, LayoutAck | EngineError>>();

  /** How long a member may be silent before it is stopped: `IDLE_STOP_MS`, shorter only in tests. */
  private idleMs: number;
  /** When a sign of work of a member was last announced (a sign is announced at most once a second per member). */
  private announced = new WeakMap<
    SeatRun<MemberOutput | ReportOutput | Record<string, unknown>>,
    number
  >();

  constructor(store: Store, emit: (event: ServerEvent) => void, options: { idleMs?: number } = {}) {
    this.store = store;
    this.emitEvent = emit;
    // DIVAN_IDLE_MS shortens the window for tests with the fake harnesses; a real run always has the ten minutes
    this.idleMs = options.idleMs ?? (Number(process.env.DIVAN_IDLE_MS) || IDLE_STOP_MS);
  }

  // ---------- sessions ----------

  async createSession(input: CreateInput): Promise<Session> {
    return (await this.createSessionWithRound(input)).session;
  }

  /** Creates a session and starts its first round; the handle follows that round. */
  async createSessionWithRound(
    input: CreateInput,
  ): Promise<{ session: Session; round: RoundHandle }> {
    if (input.signal?.aborted) throw new EngineError('cancelled', 499);
    const question = typeof input.question === 'string' ? input.question.trim() : '';
    if (!question) throw new EngineError('no_question');
    if (question.length > 20_000) throw new EngineError('long_question');
    const context = typeof input.context === 'string' ? input.context.trim() : '';
    if (context.length > MAX_CONTEXT_CHARS) {
      throw new EngineError('long_context', 400, { max: MAX_CONTEXT_CHARS });
    }
    // the session's working folder: a real folder that may be used, as its real name
    let folder: string | undefined;
    if (input.folder !== undefined) {
      const verdict = validateCwd(input.folder);
      if (!verdict.ok) throw new EngineError('bad_cwd', 400, { reason: verdict.reason });
      folder = verdict.path;
    }
    // the lens mode: a word of the list, else refused before anything is created
    if (input.lensMode !== undefined && !isLensMode(input.lensMode)) {
      throw new EngineError('bad_lens_mode');
    }
    const lensMode: LensMode = isLensMode(input.lensMode) ? input.lensMode : 'off';
    if (input.flow?.kind === 'custom' && lensMode !== 'off') throw new EngineError('flow_lenses');
    if (input.flow) {
      try {
        validateFlow(input.flow);
        for (const agent of agentsOf(input.flow))
          validateSchema(
            agent.schema,
            agent.form === 'report'
              ? reportSchemaFor()
              : agent.form === 'member'
                ? memberSchemaFor(input.budgets)
                : agent.form === 'answer'
                  ? chairmanSchemaFor(input.budgets)
                  : compileForm(agent.formInfo?.fields ?? []),
          );
      } catch {
        throw new EngineError('bad_flow');
      }
      if (input.flow.kind !== 'custom') throw new EngineError('bad_flow');
      input = {
        ...input,
        seats: agentsOf(input.flow)
          .filter((agent) => agent.form !== 'answer')
          .map((agent) => ({ ...agent, enabled: agent.enabled !== false })),
        chairman: finalAgent(input.flow),
      };
    }
    checkBudgets(input.budgets);
    if (
      !Array.isArray(input.seats) ||
      (!input.flow && input.seats.length < 1) ||
      input.seats.length > (input.flow ? 16 : 8)
    ) {
      throw new EngineError('bad_seats');
    }
    const ids = new Set<string>();
    const seats: SeatConfig[] = input.seats.map((seat, index) => {
      if (!HARNESS_IDS.includes(seat.harness)) throw new EngineError('bad_harness');
      if (seat.harness === 'hermes' && process.platform !== 'win32')
        throw EngineError.of(note('hermes_platform'));
      const flags = {
        tools: seat.tools === true,
        memory: seat.memory === true,
        web: seat.web === true,
      };
      // An unsupported harness, or a toggle that cannot be the way it is set, is refused here whatever the UI sent.
      const problem = toggleProblem(seat.harness, flags);
      if (problem) throw EngineError.of(problem);
      if (seat.enabled) checkModel(seat.model, seat.effort, index + 1);
      const id =
        typeof seat.id === 'string' && /^[A-Za-z0-9_-]{1,32}$/u.test(seat.id)
          ? seat.id
          : `S${index + 1}`;
      if (ids.has(id)) throw new EngineError('bad_seats');
      ids.add(id);
      return {
        id,
        enabled: seat.enabled === true,
        harness: seat.harness,
        model: seat.model,
        effort: seat.effort,
        ...flags,
      };
    });
    if (!input.flow && seats.filter((seat) => seat.enabled).length < 2) {
      throw new EngineError('few_seats');
    }
    if (!HARNESS_IDS.includes(input.chairman.harness)) {
      throw new EngineError('bad_harness');
    }
    if (input.chairman.harness === 'hermes' && process.platform !== 'win32')
      throw EngineError.of(note('hermes_platform'));
    const unsupported = HARNESS_RULES[input.chairman.harness].unsupportedNote;
    if (unsupported) throw EngineError.of(unsupported);
    checkModel(input.chairman.model, input.chairman.effort);
    const chairmanTools =
      input.chairman.tools ?? heldValue(input.chairman.harness, 'tools') !== false;
    const chairmanMemory =
      input.chairman.memory ??
      (heldValue(input.chairman.harness, 'memory') !== false &&
        !isFake() &&
        memoryReady(input.chairman.harness));
    const chairmanProblem = toggleProblem(input.chairman.harness, {
      tools: chairmanTools,
      memory: chairmanMemory,
      web: false,
    });
    if (chairmanProblem) throw EngineError.of(chairmanProblem);
    if (
      input.separateChairman &&
      chairmanFamilyClash(
        eligibleSeats(
          input.flow
            ? seats.filter(
                (seat) =>
                  agentsOf(input.flow as Flow).find((agent) => agent.id === seat.id)?.role ===
                    'critic' ||
                  agentsOf(input.flow as Flow).find((agent) => agent.id === seat.id)?.role ===
                    'member',
              )
            : seats,
          this.store.readUnavailable(),
        ).run,
        input.chairman,
      )
    ) {
      throw EngineError.of(QUICK_BLOCKED, 409);
    }

    const settings: SessionSettings = {
      question,
      seats,
      chairman: {
        harness: input.chairman.harness,
        model: input.chairman.model,
        effort: input.chairman.effort,
        tools: chairmanTools,
        memory: chairmanMemory,
      },
      template: 'important-decision',
      // only the limits there are: a stored copy never carries a field that is not one
      budgets: {
        maxClaims: input.budgets.maxClaims,
        maxWords: input.budgets.maxWords,
      },
      ...(input.level ? { level: input.level } : {}),
      ...(input.separateChairman ? { separateChairman: true } : {}),
      ...(folder ? { cwd: folder } : {}),
      ...(lensMode !== 'off' ? { lensMode } : {}),
      rules: memberRules(input.budgets, Boolean(input.background)),
      chairmanRules: chairmanRules(input.budgets, chairmanMemory, lensMode, chairmanTools),
      critiqueInstruction: CRITIQUE_INSTRUCTION,
      memberSchema: memberSchemaFor(input.budgets),
      chairmanSchema: chairmanSchemaFor(input.budgets),
    };
    if (input.frozenSettings)
      Object.assign(settings, structuredClone(input.frozenSettings), { question });
    settings.flow = structuredClone(
      input.frozenSettings?.flow ?? input.flow ?? compileCouncil(settings),
    );
    validateFlow(settings.flow);
    for (const agent of agentsOf(settings.flow)) {
      if (!HARNESS_IDS.includes(agent.harness)) throw new EngineError('bad_harness');
      if (agent.harness === 'hermes' && process.platform !== 'win32')
        throw EngineError.of(note('hermes_platform'));
      checkModel(agent.model, agent.effort);
      const problem = toggleProblem(agent.harness, agent);
      if (problem) throw EngineError.of(problem);
    }
    const rootId = newId('u');
    const root: UserNode = {
      id: rootId,
      kind: 'user',
      parentId: null,
      text: question,
      ...(context ? { context } : {}),
      title: shorten(question, 40),
      position: null,
      pinned: false,
      layoutRev: 0,
      createdAt: now(),
    };
    const session: Session = {
      schemaVersion: 2,
      id: randomUUID(),
      name: shorten(input.name?.trim() || question, 60),
      createdAt: now(),
      updatedAt: now(),
      origin: input.origin ?? { kind: 'web' },
      ...(input.background ? { background: input.background } : {}),
      settings,
      rootId,
      nodes: { [rootId]: root },
      layout: { direction: 'TB' },
    };
    // The first round is admitted as the session's first change: the session and its round are written together, and
    // nothing is registered (no file, no entry in the list) unless that write succeeds.
    const round = await this.mutate(
      session.id,
      () => this.admit(session, null, null, input.cwd ?? folder ?? null, undefined, input.signal),
      session,
    );
    return { session, round };
  }

  /**
   * Every change to a session goes through here: ONE queue per session. A change works out its new state, writes it, and
   * only then makes it the session's own and announces it; it runs to the end before the next one starts, so nothing is
   * ever written from a state that later fails. A change that fails leaves memory and disk as they were and the next one
   * starts from that. A deleted session refuses (404) whatever is still queued behind its deletion, without a write.
   * A change never waits for another change of the same session (it would wait for itself).
   */
  private mutate<T>(
    sessionId: string,
    change: (session: Session) => Promise<T>,
    known?: Session,
  ): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const turn = previous
      .catch(() => undefined)
      .then(() => {
        const session = known ?? this.store.get(sessionId);
        if (!session || this.store.isDeleted(sessionId)) {
          throw new EngineError('no_session', 404);
        }
        return change(session);
      });
    this.queues.set(sessionId, turn);
    const done = () => {
      if (this.queues.get(sessionId) === turn) this.queues.delete(sessionId);
    };
    turn.then(done, done);
    return turn;
  }

  async rename(sessionId: string, name: string): Promise<Session> {
    const next = shorten(name, 80);
    if (!next) throw new EngineError('no_name');
    return this.mutate(sessionId, async (session) => {
      await this.persist(session, { name: next });
      session.name = next;
      this.emitSession(session);
      return session;
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.mutate(sessionId, async (session) => {
      if (summarize(session).running) {
        throw new EngineError('running', 409);
      }
      this.clearPending(sessionId);
      // marked deleted first, then the file goes (see `Store.delete`): nothing queued behind this can bring it back
      await this.store.delete(sessionId);
      this.layoutAnswers.delete(sessionId);
      this.emitEvent({ type: 'deleted', sessionId });
    });
  }

  /**
   * Applies a layout write if every node it names is still at the revision its writer saw; else refuses all of it with a
   * 409 that carries the current place of those nodes. A write that was answered before is answered again, never applied
   * twice (a client whose answer was lost sends it again). The new state is worked out apart from the live session,
   * written, and only when the write has succeeded does it become the session's state and get announced. A write that
   * fails leaves everything as it was and answers 5xx, so the writer's retry is not a conflict.
   */
  async setLayout(sessionId: string, op: LayoutOp): Promise<LayoutAck> {
    if (typeof op.opId !== 'string' || !OP_ID.test(op.opId)) {
      throw new EngineError('bad_op');
    }
    const entries = Object.entries(op.nodes ?? {});
    return this.mutate(sessionId, async (session) => {
      const answers =
        this.layoutAnswers.get(session.id) ?? new Map<string, LayoutAck | EngineError>();
      const remember = (answer: LayoutAck | EngineError) => {
        answers.set(op.opId, answer);
        if (answers.size > REMEMBERED_OPS) answers.delete(answers.keys().next().value as string);
        this.layoutAnswers.set(session.id, answers);
      };
      const answered = answers.get(op.opId);
      if (answered instanceof EngineError) throw answered;
      if (answered) return answered;
      if (entries.length === 0 && !op.direction) {
        throw new EngineError('bad_op');
      }
      for (const [id, next] of entries) {
        if (!session.nodes[id]) throw new EngineError('bad_node', 404);
        if (
          !Number.isFinite(next.x) ||
          !Number.isFinite(next.y) ||
          typeof next.pinned !== 'boolean' ||
          !Number.isInteger(next.rev) ||
          next.rev < 0
        ) {
          throw new EngineError('bad_op');
        }
      }
      if (entries.some(([id, next]) => (session.nodes[id]?.layoutRev ?? 0) !== next.rev)) {
        const refused = new EngineError('stale', 409, undefined, {
          direction: session.layout.direction,
          nodes: Object.fromEntries(
            entries.map(([id]) => {
              const node = session.nodes[id] as SessionNode;
              return [
                id,
                { position: node.position, pinned: node.pinned, layoutRev: node.layoutRev ?? 0 },
              ];
            }),
          ),
        });
        remember(refused);
        throw refused;
      }

      // the new state, apart from the live one
      const next = entries.map(([id, place]) => ({
        ...(session.nodes[id] as SessionNode),
        position: { x: Math.round(place.x), y: Math.round(place.y) },
        pinned: place.pinned,
        layoutRev: ((session.nodes[id] as SessionNode).layoutRev ?? 0) + 1,
      }));
      await this.persist(session, {
        nodes: next,
        ...(op.direction ? { layout: { direction: op.direction } } : {}),
      });
      // written: now it is the session's state, and now it is announced
      const ack: LayoutAck = { ok: true, nodes: {} };
      for (const written of next) {
        const node = session.nodes[written.id] as SessionNode;
        node.position = written.position;
        node.pinned = written.pinned;
        node.layoutRev = written.layoutRev;
        ack.nodes[written.id] = { layoutRev: written.layoutRev };
      }
      if (op.direction) session.layout.direction = op.direction;
      this.emitSession(session);
      remember(ack);
      return ack;
    });
  }

  // ---------- rounds ----------

  /** Starts a round from chairman node `fromChairId` (the new input is a child of it); `text` null = no comment. */
  async startRound(
    sessionId: string,
    fromChairId: string,
    text: RoundInput | null,
    options: { cwd?: string | null; editedFrom?: string; signal?: AbortSignal } = {},
  ): Promise<RoundHandle> {
    return this.mutate(sessionId, async (session) => {
      const from = session.nodes[fromChairId];
      if (from?.kind !== 'chair') throw new EngineError('bad_node', 404);
      // A round that is still being saved is not done yet, whatever its status says on the way there.
      if (from.status !== 'done' || this.rounds.has(fromChairId)) {
        throw new EngineError('not_done', 409);
      }
      const input = inputParts(text);
      if (input && JSON.stringify(input).length > 40_000) throw new EngineError('long_input');
      return this.admit(
        session,
        fromChairId,
        input,
        // the round runs in the session's folder (a branch too), unless the request names another
        options.cwd ?? session.settings.cwd ?? null,
        options.editedFrom,
        options.signal,
      );
    });
  }

  /** Stops the processes of this one round. The round stays visible as cancelled, with its spend counted. */
  cancelRound(sessionId: string, chairId: string): void {
    const session = this.require(sessionId);
    const chair = session.nodes[chairId];
    if (chair?.kind !== 'chair') throw new EngineError('bad_node', 404);
    const running = this.rounds.get(chairId);
    if (!running || chair.status !== 'running' || running.finalizing) {
      throw new EngineError('not_running', 409);
    }
    running.controller.abort();
  }

  /** Runs a failed, cancelled or interrupted round again (the chairman alone when two member answers are valid). */
  async rerun(sessionId: string, chairId: string): Promise<void> {
    await this.mutate(sessionId, async (session) => {
      const chair = session.nodes[chairId];
      if (chair?.kind !== 'chair') throw new EngineError('bad_node', 404);
      if (chair.status === 'done' || chair.status === 'running') {
        throw new EngineError('not_failed', 409);
      }
      this.assertIdle(session);
      const user = session.nodes[chair.parentId ?? ''];
      if (!user || user.kind === 'chair') throw new EngineError('bad_node', 404);
      const fromChairId = user.parentId;
      const newInput = user.kind === 'user' && user.parentId ? inputOfNode(user) : null;
      const keepSeats =
        seatsOf(chair).filter((seat) => seat.state === 'done' && seat.sanitized).length >= 2;
      // the round as it will be, apart from the live one; it becomes the live one's only once it is written
      const next = structuredClone(chair);
      next.status = 'running';
      next.error = null;
      delete next.errorNote;
      next.endedAt = null;
      if (next.steps) {
        this.prepareRetry(session, next);
      } else if (!keepSeats) {
        // the seats are made again, so the lenses are too: the planner runs again, and its call is one more attempt
        delete next.lensPlan;
        this.resetSeats(session, next, fromChairId, newInput);
      } else this.resetChairman(next);
      if (!next.steps) {
        next.steps = [
          ...seatsOf(next).map(
            (run): FlowStep => ({
              id: run.seatId,
              form: 'member',
              run,
              aliases: {},
              inputs: [],
              attempts: [],
            }),
          ),
          {
            id: finalAgent(session.settings.flow ?? compileCouncil(session.settings)).id,
            form: 'answer',
            run: chairmanOf(next),
            output: null,
            aliases: {},
            inputs: [],
            attempts: [],
          },
        ];
      }
      delete next.seats;
      delete next.chairman;
      await this.persist(session, { nodes: [next], schemaVersion: 2 });
      session.schemaVersion = 2;
      Object.assign(chair, next);
      // (an assign does not remove what `next` no longer has)
      delete chair.seats;
      delete chair.chairman;
      if (!next.lensPlan) delete chair.lensPlan;
      this.emitNode(session, chair);
      this.emitSession(session);
      this.launch(session, chair.id, fromChairId, newInput, keepSeats);
    });
  }

  private require(sessionId: string): Session {
    const session = this.store.get(sessionId);
    if (!session) throw new EngineError('no_session', 404);
    return session;
  }

  private assertIdle(session: Session): void {
    if (summarize(session).running) {
      throw new EngineError('busy', 409);
    }
  }

  /**
   * The change that starts a round: its new nodes are worked out, written (saved as running first: a crash from here on
   * leaves an interrupted round, never a lost one), and only then become the session's, announced and launched.
   */
  private async admit(
    session: Session,
    fromChairId: string | null,
    given: RoundInput | null,
    cwd: string | null,
    editedFrom?: string,
    signal?: AbortSignal,
  ): Promise<RoundHandle> {
    const input = inputParts(given);
    // the client that asked may have gone while this waited its turn: then nothing is admitted at all
    if (signal?.aborted) throw new EngineError('cancelled', 499);
    this.assertIdle(session);
    let userId = session.rootId;
    let createdUser: UserNode | null = null;
    if (fromChairId) {
      userId = newId('u');
      createdUser = {
        id: userId,
        kind: input ? 'user' : 'next',
        parentId: fromChairId,
        text: input?.comment ?? '',
        ...(input && input.answers.length > 0 ? { answers: input.answers } : {}),
        title: input ? shorten(wordsOf(input), 30) : messageText('no_comment'),
        ...(editedFrom && session.nodes[editedFrom] ? { editedFrom } : {}),
        position: null,
        pinned: false,
        layoutRev: 0,
        createdAt: now(),
      };
    }
    const prevRound = fromChairId ? (session.nodes[fromChairId] as ChairNode).round : 0;
    const chair: ChairNode = {
      id: newId('c'),
      kind: 'chair',
      parentId: userId,
      position: null,
      pinned: false,
      layoutRev: 0,
      createdAt: now(),
      round: prevRound + 1,
      status: 'running',
      title: '',
      direction: '',
      answer: '',
      recommendation: null,
      questionsForUser: [],
      claims: [],
      seatScores: [],
      labelMap: {},
      seats: [],
      chairman: {
        state: 'pending',
        harness: session.settings.chairman.harness,
        model: session.settings.chairman.model,
        effort: session.settings.chairman.effort,
        ...(session.settings.chairman.memory ? { memory: true } : {}),
        tools:
          session.settings.chairman.tools ??
          heldValue(session.settings.chairman.harness, 'tools') !== false,
        input: '',
        rawOutput: '',
        trimmed: [],
        error: null,
        usage: null,
        startedAt: null,
        endedAt: null,
      },
      context: [],
      contextTokens: 0,
      usage: { members: 0, chairman: 0, total: 0, council: 0, cached: 0, estimated: false },
      attempts: [],
      ...(cwd ? { cwd } : {}),
      // lens modes work on the FIRST round of a session; a later round (a follow-up, a branch) is an ordinary one
      ...(!fromChairId && session.settings.lensMode && session.settings.lensMode !== 'off'
        ? { lensMode: session.settings.lensMode }
        : {}),
      error: null,
      startedAt: now(),
      endedAt: null,
    };
    this.resetSeats(session, chair, fromChairId, input);
    const added: SessionNode[] = [...(createdUser ? [createdUser] : []), chair];
    await this.persist(session, { nodes: added, schemaVersion: 2 });
    session.schemaVersion = 2;
    for (const node of added) session.nodes[node.id] = node;
    if (createdUser) this.emitNode(session, createdUser);
    this.emitNode(session, chair);
    this.emitSession(session);
    return this.launch(session, chair.id, fromChairId, input, false, userId, signal);
  }

  /** Builds the context, shuffles the labels and creates the pending seats of a round. */
  private resetSeats(
    session: Session,
    chair: ChairNode,
    fromChairId: string | null,
    input: InputParts | null,
  ): void {
    const { settings } = session;
    const context = buildContext({
      nodes: session.nodes,
      rootId: session.rootId,
      fromChairId,
      newInput: input,
      rules: settings.rules,
      critiqueInstruction: settings.critiqueInstruction,
      background: session.background ?? null,
    });
    chair.context = context.rows;
    chair.contextTokens = context.tokens;
    const enabled = settings.seats.filter((seat) => seat.enabled);
    const labels = enabled.map((_, index) => String.fromCharCode(65 + index));
    for (let i = labels.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [labels[i], labels[j]] = [labels[j] as string, labels[i] as string];
    }
    chair.labelMap = {};
    const seats = enabled.map((seat, index): SeatRun => {
      const label = labels[index] as string;
      chair.labelMap[label] = seat.id;
      return {
        seatId: seat.id,
        label,
        harness: seat.harness,
        model: seat.model,
        effort: seat.effort,
        // With a project folder the members read it (Omid's rule): tools go on wherever the harness can have them on.
        tools: seat.tools || (chair.cwd ? heldValue(seat.harness, 'tools') !== false : false),
        memory: seat.memory,
        web: seat.web,
        state: 'pending',
        prompt: context.prompt,
        rawOutput: '',
        parsed: null,
        sanitized: null,
        trimmed: [],
        error: null,
        usage: null,
        startedAt: null,
        endedAt: null,
      };
    });
    seats.sort((a, b) => a.label.localeCompare(b.label));
    chair.seats = seats;
    this.resetChairman(chair);
    const flow = settings.flow ?? compileCouncil(settings);
    const final = finalAgent(flow);
    if (flow.kind === 'council') {
      chair.steps = [
        ...seats.map(
          (run): FlowStep => ({
            id: run.seatId,
            form: 'member',
            run,
            aliases: {},
            inputs: [],
            attempts: [],
          }),
        ),
        {
          id: final.id,
          form: 'answer',
          run: chairmanOf(chair),
          output: null,
          aliases: {},
          inputs: [],
          attempts: [],
        },
      ];
    } else {
      chair.labelMap = {};
      chair.steps = orderedNodes(flow).map((agent, index): FlowStep => {
        if (agent.kind === 'condition')
          return {
            id: agent.id,
            form: 'condition',
            source: conditionSource(flow, agent.id),
            result: null,
            run: { state: 'pending', error: null, startedAt: null, endedAt: null },
            aliases: {},
            inputs: [],
            attempts: [],
          };
        const label = String.fromCharCode(65 + index);
        chair.labelMap[label] = agent.id;
        const run = {
          seatId: agent.id,
          label,
          harness: agent.harness,
          model: agent.model,
          effort: agent.effort,
          tools:
            agent.id === final.id
              ? agent.tools
              : agent.tools || (!!chair.cwd && heldValue(agent.harness, 'tools') !== false),
          memory: agent.memory,
          web: agent.web,
          state: 'pending' as const,
          prompt: '',
          rawOutput: '',
          parsed: null,
          sanitized: null,
          trimmed: [],
          error: null,
          usage: null,
          startedAt: null,
          endedAt: null,
        };
        const base = {
          id: agent.id,
          aliases: anonymousAliases([...agent.required, ...(agent.responses?.ids ?? [])]),
          inputs: [],
          attempts: [],
        };
        if (agent.id === final.id)
          return {
            ...base,
            form: 'answer',
            output: null,
            run: {
              state: 'pending',
              harness: agent.harness,
              model: agent.model,
              effort: agent.effort,
              tools: agent.tools,
              memory: agent.memory,
              input: '',
              rawOutput: '',
              trimmed: [],
              error: null,
              usage: null,
              startedAt: null,
              endedAt: null,
            },
          };
        return agent.form === 'report'
          ? { ...base, form: 'report', run }
          : agent.form === 'member'
            ? { ...base, form: 'member', run }
            : { ...base, form: 'custom', formId: agent.form, run };
      });
      chair.labelMap = {};
      for (const step of chair.steps)
        if (step.form !== 'answer' && step.form !== 'condition') {
          chair.labelMap[step.run.label] = step.id;
        }
    }
    delete chair.seats;
    delete chair.chairman;
  }

  /** Gives each member its lens (or none) from the plan, and builds the text it will receive. */
  private handOutLenses(session: Session, chair: ChairNode, plan: LensPlan, body: string): void {
    for (const seat of seatsOf(chair)) {
      if (seat.state !== 'pending') continue;
      const lens = plan.assignment[seat.seatId];
      if (lens === undefined) {
        delete seat.lens;
        continue;
      }
      seat.lens = lens;
      seat.prompt = lensMemberPrompt({
        mode: plan.mode,
        lens,
        rules: session.settings.rules,
        body,
      });
    }
  }

  private resetChairman(chair: ChairNode): void {
    replaceChairman(chair, {
      ...chairmanOf(chair),
      state: 'pending',
      input: '',
      activity: { file: 0, memory: 0, web: 0, thread: 0, other: 0 },
      toolLog: [],
      rawOutput: '',
      trimmed: [],
      error: null,
      usage: null,
      startedAt: null,
      endedAt: null,
    });
  }

  /** Reuse durable good inputs; an already satisfied optional quorum never retries failed peers. */
  private prepareRetry(session: Session, chair: ChairNode): void {
    const flow = session.settings.flow ?? compileCouncil(session.settings);
    const steps = chair.steps as FlowStep[];
    const reusable = (id: string): boolean => {
      const step = stepOf(chair, id);
      return (
        !!step &&
        (step.run.state === 'done' || (step.form === 'condition' && branchSkipped(step))) &&
        !!(step.form === 'condition'
          ? step.result !== null || branchSkipped(step)
          : step.form === 'answer'
            ? step.output
            : step.run.sanitized) &&
        flow.edges
          .filter((edge) => edge.to === id && (edge.gate || edge.when))
          .every((edge) => reusable(edge.when?.condition ?? edge.from)) &&
        ((step.form === 'condition' && step.reason === 'source_failed') ||
          step.inputs.every(reusable))
      );
    };
    for (const step of steps)
      if (step.run.state === 'done' && !reusable(step.id)) step.run.state = 'failed';
    const needed = new Set<string>();
    const need = (id: string): void => {
      const step = stepOf(chair, id);
      if (
        !step ||
        needed.has(id) ||
        step.skipReason === 'inactive_branch' ||
        step.skipReason === 'disabled'
      )
        return;
      needed.add(id);
      if (
        step.run.state === 'done' &&
        (step.form === 'condition'
          ? step.result !== null
          : step.form === 'answer'
            ? step.output
            : step.run.sanitized)
      )
        return;
      for (const edge of flow.edges.filter((edge) => edge.to === id && (edge.gate || edge.when)))
        need(edge.when?.condition ?? edge.from);
      if (step.form === 'condition') {
        need(step.source);
        return;
      }
      const agent = agentsOf(flow).find((item) => item.id === id);
      if (!agent) return;
      for (const required of agent.required)
        if (wireState(flow, steps, required, id) !== 'inactive') need(required);
      const valid =
        agent.responses?.ids.filter((peer) => {
          const run = stepOf(chair, peer);
          return (
            wireState(flow, steps, peer, id) === 'active' &&
            run?.form !== 'answer' &&
            run?.form !== 'condition' &&
            run?.run.state === 'done' &&
            run.run.sanitized
          );
        }) ?? [];
      for (const peer of valid.length >= (agent.responses?.min ?? 0)
        ? valid
        : (agent.responses?.ids ?? []))
        if (wireState(flow, steps, peer, id) !== 'inactive') need(peer);
    };
    need(finalAgent(flow).id);
    if (flow.kind === 'custom' && flow.nodes.some((n) => n.kind === 'condition')) {
      const invalidated = new Set<string>();
      while (true) {
        const retries = steps
          .filter((step) => needed.has(step.id) && !reusable(step.id) && !invalidated.has(step.id))
          .map((step) => step.id);
        if (!retries.length) break;
        for (const id of invalidateDescendants(flow, steps, retries)) invalidated.add(id);
        // Invalidated controls can expose inputs hidden by the previous decision.
        needed.clear();
        need(finalAgent(flow).id);
      }
      return;
    }
    for (const step of steps) {
      const usable =
        step.run.state === 'done' &&
        (step.form === 'condition'
          ? step.result !== null
          : step.form === 'answer'
            ? step.output
            : step.run.sanitized);
      if (!needed.has(step.id) || usable) continue;
      step.run.state = 'pending';
      delete step.skipReason;
      delete step.errorNote;
      step.run.error = null;
      if (step.form === 'condition') {
        step.result = null;
        delete step.reason;
        continue;
      }
      step.run.rawOutput = '';
      step.run.trimmed = [];
      delete step.run.activity;
      delete step.run.toolLog;
      delete step.run.folderNote;
      step.run.startedAt = null;
      step.run.endedAt = null;
      step.run.usage = null;
      if (step.form === 'answer') {
        step.run.input = '';
        step.output = null;
      } else {
        step.run.prompt = '';
        step.run.parsed = null;
        step.run.sanitized = null;
      }
    }
    // Frozen output cannot survive changed prerequisites. Rebuild only the steps actually being retried.
    if (
      flow.kind === 'council' &&
      steps.some((step) => step.form === 'member' && step.run.state === 'pending')
    ) {
      // Reused answers keep their original tasks; a partial retry uses the same complete assignment.
      if (!seatsOf(chair).some((seat) => seat.state === 'done' && seat.sanitized))
        delete chair.lensPlan;
      const user = session.nodes[chair.parentId ?? ''];
      const context = buildContext({
        nodes: session.nodes,
        rootId: session.rootId,
        fromChairId: user?.parentId ?? null,
        newInput: user && user.kind !== 'chair' && user.parentId ? inputOfNode(user) : null,
        rules: session.settings.rules,
        critiqueInstruction: session.settings.critiqueInstruction,
        background: session.background ?? null,
      });
      for (const step of steps)
        if (step.form !== 'answer' && step.run.state === 'pending')
          step.run.prompt = context.prompt;
      if (chair.lensPlan) this.handOutLenses(session, chair, chair.lensPlan, context.body);
    }
  }

  /**
   * Lens modes: ONE stateless call on the chairman's harness and model (the same effort), with no tools, no memory and no
   * folder, whose input is the question as the asker wrote it and the context the asker added. It returns the lenses (at most
   * as many as the members need: the members minus the anchor in `angle`, the members in `only`); the code cuts them, hands
   * them out at random (the anchor of `angle` is the first enabled seat of the council that takes part) and builds each
   * member's text. A planner that fails, or returns fewer lenses than there are members, never fails the round: the members
   * left without a lens answer the question as asked, and the plan records it. The call is counted in the round's usage.
   */
  private async planLenses(
    session: Session,
    chair: ChairNode,
    fromChairId: string | null,
    input: InputParts | null,
    signal: AbortSignal,
  ): Promise<void> {
    const mode = chair.lensMode;
    if (!mode || mode === 'off') return;
    const { settings } = session;
    const asked = new Set(
      seatsOf(chair)
        .filter((seat) => seat.state === 'pending')
        .map((s) => s.seatId),
    );
    // the council's order, among the members that take part
    const seatIds = settings.seats
      .filter((seat) => seat.enabled && asked.has(seat.id))
      .map((seat) => seat.id);
    const wanted = lensesWanted(mode, seatIds.length);
    const root = session.nodes[session.rootId];
    const planner: LensPlan['planner'] = {
      state: 'skipped',
      harness: settings.chairman.harness,
      model: settings.chairman.model,
      error: null,
      usage: null,
      trimmed: [],
      startedAt: null,
      endedAt: null,
    };
    let lenses: LensPlan['lenses'] = [];
    if (wanted > 0 && root?.kind === 'user') {
      const schema = plannerSchemaFor(wanted);
      const prompt = plannerInput(plannerRules(wanted, mode), root.text, root.context);
      planner.startedAt = now();
      let result: AgentRun;
      try {
        result = await runAgent({
          harness: settings.chairman.harness,
          model: settings.chairman.model,
          effort: settings.chairman.effort,
          tools: false,
          memory: false,
          web: false,
          prompt,
          schema: nativeSchema(schema, false, false, false),
          idleMs: this.idleMs,
          signal,
        });
      } catch (error) {
        result = {
          text: '',
          usage: null,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
          cancelled: false,
          durationMs: 0,
          diagnostics: '',
        };
      }
      planner.endedAt = now();
      planner.usage = result.usage ?? estimateUsage(prompt, result.text || result.diagnostics);
      if (result.cancelled) {
        planner.state = 'failed';
        planner.error = 'cancelled';
      } else if (result.timedOut || result.error !== null) {
        planner.state = 'failed';
        planner.error = result.timedOut ? 'timeout' : result.error;
        this.noteIfUnavailable(
          settings.chairman.harness,
          settings.chairman.model,
          `${planner.error} ${result.diagnostics}`,
        );
      } else {
        let parsed: ReturnType<typeof parsePlanner>;
        try {
          parsed = parsePlanner({ text: result.text, schema });
        } catch (error) {
          parsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (parsed.ok) {
          planner.state = 'done';
          planner.trimmed = parsed.trimmed;
          lenses = parsed.value.lenses.slice(0, wanted);
        } else {
          planner.state = 'invalid';
          planner.error = parsed.error;
        }
      }
      this.recordAttempt(chair, {
        kind: 'planner',
        seatId: null,
        // the Cost table names a call by its label
        label: 'planner',
        harness: settings.chairman.harness,
        model: settings.chairman.model,
        state: planner.state,
        error: planner.error,
        usage: planner.usage,
        prompt,
        raw: result.error !== null ? result.diagnostics || result.text : result.text,
        startedAt: planner.startedAt,
        endedAt: planner.endedAt,
      });
    }
    const handed = assignLenses({ mode, seatIds, lenses });
    const plan: LensPlan = {
      mode,
      requested: wanted,
      lenses,
      ...(handed.anchorSeatId !== undefined ? { anchorSeatId: handed.anchorSeatId } : {}),
      assignment: handed.assignment,
      unassigned: handed.unassigned,
      planner,
    };
    chair.lensPlan = plan;
    const context = buildContext({
      nodes: session.nodes,
      rootId: session.rootId,
      fromChairId,
      newInput: input,
      rules: settings.rules,
      critiqueInstruction: settings.critiqueInstruction,
      background: session.background ?? null,
    });
    this.handOutLenses(session, chair, plan, context.body);
    this.touch(session, chair);
  }

  /** Runs the round in the background; nothing it does can reject or end the process. */
  private launch(
    session: Session,
    chairId: string,
    fromChairId: string | null,
    input: InputParts | null,
    keepSeats: boolean,
    userId = (session.nodes[chairId] as ChairNode).parentId ?? '',
    gone?: AbortSignal,
  ): RoundHandle {
    const entry: ActiveRound = {
      session,
      controller: new AbortController(),
      done: Promise.resolve(),
      events: [],
      listeners: new Set(),
      finalizing: false,
      seatControllers: new Map(),
      skippedByUser: new Set(),
    };
    // The client that asked can leave at any moment, also while the round was being admitted: its leaving stops the round, and
    // a round whose client is already gone starts no member at all (`execute` looks before it asks anybody).
    if (gone?.aborted) entry.controller.abort();
    else gone?.addEventListener('abort', () => entry.controller.abort(), { once: true });
    // Registered before the first await of the round: from here until the final save the round counts as busy.
    this.rounds.set(chairId, entry);
    entry.done = this.execute(
      session,
      chairId,
      fromChairId,
      input,
      keepSeats,
      entry.controller.signal,
    )
      .catch((error) => log('a round ended with an unexpected error', error))
      .finally(() => this.rounds.delete(chairId));
    return this.handleOf(session, session.nodes[chairId] as ChairNode, entry, userId);
  }

  /** A handle on a round that is running now, by the session and the node it was started for. */
  private handleOf(
    session: Session,
    chair: ChairNode,
    entry: ActiveRound,
    userId: string,
  ): RoundHandle {
    return {
      sessionId: session.id,
      userId,
      chairId: chair.id,
      done: entry.done.then(() => chair.status),
      cancel: () => {
        if (!entry.finalizing) entry.controller.abort();
      },
      subscribe: (listener) => {
        for (const event of entry.events) listener(event);
        entry.listeners.add(listener);
        return () => entry.listeners.delete(listener);
      },
    };
  }

  /**
   * A handle on a round that is running now, or null when it is not. `rerun` starts a round and returns nothing; a front end
   * that wants to follow what it started asks for the handle here, the same one `startRound` would have returned.
   */
  follow(sessionId: string, chairId: string): RoundHandle | null {
    const session = this.store.get(sessionId);
    const chair = session?.nodes[chairId];
    const entry = this.rounds.get(chairId);
    if (!session || chair?.kind !== 'chair' || !entry) return null;
    return this.handleOf(session, chair, entry, chair.parentId ?? '');
  }

  /** Tells whoever follows this round (a front end other than the web app) what just happened. */
  private progress(chairId: string, event: RoundEvent): void {
    const entry = this.rounds.get(chairId);
    if (!entry) return;
    const flow = entry.session.settings.flow;
    const chair = entry.session.nodes[chairId] as ChairNode;
    if (flow?.kind === 'custom') {
      const label = 'label' in event ? event.label : undefined;
      const step =
        event.type === 'chairman'
          ? finalAgent(flow)
          : event.stepId
            ? agentsOf(flow).find((agent) => agent.id === event.stepId)
            : 'label' in event
              ? agentsOf(flow).find((agent) => {
                  const step = stepOf(chair, agent.id);
                  return (
                    step &&
                    step.form !== 'answer' &&
                    step.form !== 'condition' &&
                    step.run.label === label
                  );
                })
              : undefined;
      if (step) event = { ...event, stepId: step.id, identity: agentIdentity(flow, step.id) };
    }
    entry.events.push(event);
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch (error) {
        log('a round listener failed', error);
      }
    }
  }

  private async execute(
    session: Session,
    chairId: string,
    fromChairId: string | null,
    input: InputParts | null,
    _keepSeats: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const chair = session.nodes[chairId] as ChairNode;
    const flow = session.settings.flow ?? compileCouncil(session.settings);
    try {
      if (!chair.steps) throw new Error('round has no flow steps');
      const previousClaimIds = fromChairId
        ? (session.nodes[fromChairId] as ChairNode).claims.map((claim) => claim.id)
        : [];
      const status = (await detect(false)).status;
      while (true) {
        if (signal.aborted) {
          for (const run of runsOf(chair).filter((run) => run.state === 'pending')) {
            run.state = 'failed';
            run.error = 'cancelled';
            run.endedAt = now();
          }
          await this.finish(session, chair, 'cancelled', 'cancelled');
          return;
        }
        const completed = stepOf(chair, finalAgent(flow).id);
        if (completed?.form === 'answer' && completed.run.state === 'done' && completed.output) {
          await this.finish(session, chair, 'done', null);
          return;
        }
        if (flow.kind !== 'custom') this.skipUnavailable(session, chair, status);
        if (chair.lensMode && chair.lensMode !== 'off' && !chair.lensPlan)
          await this.planLenses(session, chair, fromChairId, input, signal);
        let scheduled = scheduleFlow(flow, chair.steps);
        while (
          scheduled.blocked.length ||
          scheduled.skipped.length ||
          scheduled.conditions.length
        ) {
          for (const id of [...scheduled.blocked, ...scheduled.skipped]) {
            const step = stepOf(chair, id) as FlowStep;
            step.run.state = scheduled.skipped.includes(id) ? 'skipped' : 'blocked';
            if (scheduled.skipped.includes(id)) step.skipReason = 'inactive_branch';
            step.run.error = scheduled.skipped.includes(id)
              ? 'inactive_branch'
              : messageText('flow_unavailable');
            step.run.endedAt = now();
            if (step.form === 'condition') {
              step.result = null;
              step.reason = 'inactive_branch';
            }
          }
          for (const id of scheduled.conditions) {
            const step = stepOf(chair, id);
            const node = flow.nodes.find((n) => n.id === id);
            if (step?.form !== 'condition' || node?.kind !== 'condition') continue;
            const source = stepOf(chair, step.source);
            const verdict = evaluateCondition(
              node,
              source?.run.state === 'done' ? outputOfStep(source) : null,
            );
            step.inputs = [step.source];
            step.result = verdict.result;
            step.reason = verdict.reason;
            step.run.state = 'done';
            step.run.startedAt = now();
            step.run.endedAt = now();
          }
          scheduled = scheduleFlow(flow, chair.steps);
        }
        // A gate resolved in this checkpoint can expose a delayed model that became unavailable meanwhile.
        this.skipUnavailable(session, chair, status);
        scheduled = scheduleFlow(flow, chair.steps);
        if (scheduled.blocked.length || scheduled.skipped.length || scheduled.conditions.length)
          continue;
        if (!scheduled.ready.length) {
          const skipped = runsOf(chair).filter((run) => run.state === 'skipped').length;
          await this.finish(
            session,
            chair,
            'failed',
            flow.kind === 'custom'
              ? note('flow_unavailable')
              : skipped
                ? note('few_members_skipped', { skipped })
                : note('few_members'),
          );
          return;
        }
        const wave = scheduled.ready.map(
          (id) => stepOf(chair, id) as Exclude<FlowStep, { form: 'condition' }>,
        );
        // The queued checkpoint must succeed before any dependent call starts.
        this.clearPending(session.id);
        await this.saveLive(session);
        const settled = await Promise.allSettled(
          wave.map(async (step) => {
            const agent = agentsOf(flow).find((item) => item.id === step.id) as FlowAgent;
            const upstream = [...agent.required, ...(agent.responses?.ids ?? [])].flatMap((id) => {
              const peer = stepOf(chair, id);
              return peer &&
                wireState(flow, chair.steps ?? [], id, step.id) === 'active' &&
                peer.form !== 'answer' &&
                peer.form !== 'condition' &&
                peer.run.state === 'done' &&
                peer.run.sanitized
                ? [peer]
                : [];
            });
            step.inputs = upstream.map((peer) => peer.id);
            if (step.form === 'answer') {
              const valid = upstream.filter(
                (peer): peer is Extract<FlowStep, { form: 'member' }> =>
                  peer.form === 'member' &&
                  !flow.edges.find((e) => e.from === peer.id && e.to === step.id)?.fields,
              );
              const drafts = upstream.filter(
                (peer): peer is Extract<FlowStep, { form: 'report' }> => peer.form === 'report',
              );
              await this.runChairman(
                session,
                chair,
                fromChairId,
                input,
                valid.map((peer) =>
                  flow.kind === 'custom'
                    ? { ...peer.run, label: step.aliases[peer.id] as string }
                    : peer.run,
                ),
                signal,
                agent,
                drafts,
                upstream,
              );
            } else {
              if (flow.kind === 'custom') {
                const context = buildContext({
                  nodes: session.nodes,
                  rootId: session.rootId,
                  fromChairId,
                  newInput: input,
                  rules: agent.rules,
                  critiqueInstruction: session.settings.critiqueInstruction,
                  background: session.background ?? null,
                });
                step.run.prompt = `${agent.rules}\n\n${context.body}\n\n${upstreamInput(upstream.map((peer) => ({ label: step.aliases[peer.id] as string, output: projectOutput(flow, peer.id, step.id, peer.run.sanitized as unknown as Record<string, unknown>) })))}\n`;
              }
              await this.runSeat(session, chair, step.run, previousClaimIds, signal, agent);
            }
          }),
        );
        for (const [index, result] of settled.entries()) {
          const step = wave[index] as FlowStep;
          if (result.status === 'rejected' && step.form !== 'answer' && step.form !== 'condition')
            this.settleSeatAsFailed(chair, step.run, result.reason);
          if (step.run.state === 'pending' || step.run.state === 'running') {
            step.run.state = 'failed';
            step.run.error = messageText('flow_step_unfinished');
            step.run.endedAt = now();
          }
        }
        if (chair.status !== 'running') return;
        this.clearPending(session.id);
        await this.saveLive(session);
      }
    } catch (error) {
      await this.finish(
        session,
        chair,
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * The seats of this round that will not run are marked skipped, and never run: those whose model is in the unavailable
   * cache right now, and, in a session that keeps its chairman apart (`quick`), those of the chairman's family (checked at
   * the start of every round and retry, so a member that became available again is not run beside a same-family chairman).
   */
  private skipUnavailable(session: Session, chair: ChairNode, status?: HarnessStatus[]): void {
    const flow = session.settings.flow;
    if (flow) {
      const plan = eligibleFlow(
        flow,
        this.store.readUnavailable(),
        Date.now(),
        session.settings.separateChairman,
        status,
      );
      const mark = (id: string, error: string, reason: 'disabled' | 'unavailable' | 'family') => {
        const step = stepOf(chair, id);
        if (step?.run.state !== 'pending') return;
        if (gateState(flow, chair.steps ?? [], id) !== 'active') return;
        if (!wireDecisionsResolved(flow, chair.steps ?? [], id)) return;
        const agent = agentsOf(flow).find((item) => item.id === id);
        if (
          agent?.required.some(
            (peer) => wireState(flow, chair.steps ?? [], peer, id) === 'inactive',
          )
        )
          return;
        step.run.state = step.form === 'answer' ? 'blocked' : 'skipped';
        step.skipReason = reason;
        step.run.error = error;
        step.run.endedAt = now();
        if (step.form !== 'answer' && step.form !== 'condition')
          this.progress(chair.id, {
            type: 'seat-failed',
            label: step.run.label,
            stepId: step.id,
            reason: 'skipped',
          });
      };
      for (const agent of agentsOf(flow))
        if (agent.enabled === false) mark(agent.id, messageText('flow_step_disabled'), 'disabled');
      for (const { seat, entry } of plan.skipped)
        mark(
          seat.id,
          entry.prefix !== undefined ? 'skipped: no credit' : 'skipped: rate limited',
          'unavailable',
        );
      for (const agent of plan.missing)
        mark(agent.id, messageText('assistant_missing', { harness: agent.harness }), 'unavailable');
      for (const agent of plan.sameFamily) mark(agent.id, SKIPPED_SAME_FAMILY, 'family');
      return;
    }
    // The same function that decides the cache identity says which seats do not run (`eligibleSeats`).
    const { skipped, sameFamily } = eligibleSeats(
      runsOf(chair).filter((seat) => seat.state === 'pending'),
      this.store.readUnavailable(),
      Date.now(),
      session.settings.separateChairman && session.settings.flow?.kind !== 'custom'
        ? session.settings.chairman
        : undefined,
    );
    for (const { seat, entry } of skipped) {
      seat.state = 'skipped';
      seat.error = entry.prefix !== undefined ? 'skipped: no credit' : 'skipped: rate limited';
      seat.endedAt = now();
      this.progress(chair.id, {
        type: 'seat-failed',
        label: seat.label,
        stepId: seat.seatId,
        reason: 'skipped',
      });
    }
    for (const seat of sameFamily) {
      seat.state = 'skipped';
      seat.error = SKIPPED_SAME_FAMILY;
      seat.endedAt = now();
      this.progress(chair.id, {
        type: 'seat-failed',
        label: seat.label,
        stepId: seat.seatId,
        reason: 'skipped',
      });
    }
  }

  /** One seat's call: never throws; the seat ends in done, failed, timeout or invalid, and the call is recorded. */
  private async runSeat(
    session: Session,
    chair: ChairNode,
    seat: SeatRun<MemberOutput | ReportOutput | Record<string, unknown>>,
    previousClaimIds: string[],
    signal: AbortSignal,
    agent?: FlowAgent,
  ): Promise<void> {
    const { settings } = session;
    seat.state = 'running';
    seat.activity = { file: 0, memory: 0, web: 0, thread: 0, other: 0 };
    seat.toolLog = [];
    seat.startedAt = now();
    seat.promptTokens = estimateTokens(seat.prompt);
    seat.lastSignalAt = seat.startedAt;
    this.progress(chair.id, { type: 'seat-start', label: seat.label, stepId: seat.seatId });
    this.touch(session, chair);
    // This member's call can be stopped on its own («منتظرش نمی‌مانم»): its own controller, beside the round's.
    const own = new AbortController();
    const round = this.rounds.get(chair.id);
    round?.seatControllers.set(seat.seatId, own);
    let run: AgentRun;
    try {
      run = await this.callWithRetry(chair, seat, {
        harness: seat.harness,
        model: seat.model,
        effort: seat.effort,
        tools: seat.tools,
        memory: seat.memory,
        web: seat.web,
        prompt: seat.prompt,
        ...(agent?.formInfo?.fields.length ? { formFields: agent.formInfo.fields } : {}),
        schema:
          agent && !builtinForm(agent.form)
            ? agent.schema
            : agent?.form === 'answer'
              ? nativeSchema(agent.schema, false, session.register === undefined)
              : nativeSchema(
                  agent?.form === 'report'
                    ? agent.schema
                    : memberSchemaOf(
                        agent?.schema ?? settings.memberSchema,
                        chair,
                        seat as SeatRun,
                      ),
                  chair.round > 1,
                  false,
                  seat.memory,
                ),
        // the only limit: ten minutes after its last sign of work
        idleMs: this.idleMs,
        onSignal: (sign) => {
          this.sign(session, chair, seat, sign);
          for (const tool of sign.tools ?? []) this.tool(session, chair, seat, tool);
        },
        ...(chair.cwd ? { cwd: chair.cwd } : {}),
        signal: AbortSignal.any([signal, own.signal]),
      });
    } catch (error) {
      this.settleSeatAsFailed(chair, seat, error);
      this.touch(session, chair);
      return;
    } finally {
      round?.seatControllers.delete(seat.seatId);
    }
    seat.endedAt = now();
    if (run.folderNote) {
      seat.folderNote = run.folderNote;
      this.progress(chair.id, { type: 'seat-note', label: seat.label, stepId: seat.seatId });
    }
    seat.usage = run.usage ?? estimateUsage(seat.prompt, run.text || run.diagnostics);
    const stoppedWaiting = round?.skippedByUser.has(seat.seatId) === true && !signal.aborted;
    if (run.timedOut) {
      // A call that went silent for ten minutes is a time-out, even when the round was cancelled while it was being stopped.
      seat.state = 'timeout';
      seat.error = 'timeout';
      seat.rawOutput = run.diagnostics || run.text;
    } else if (run.cancelled && stoppedWaiting) {
      // the asker stopped waiting for this member: it is left out, and what it cost is counted
      seat.state = 'skipped';
      seat.error = SKIPPED_BY_USER;
      const step = stepOf(chair, seat.seatId);
      if (step) step.skipReason = 'user';
      seat.rawOutput = run.diagnostics || run.text;
    } else if (run.cancelled) {
      seat.state = 'failed';
      seat.error = 'cancelled';
      seat.rawOutput = run.diagnostics || run.text;
    } else if (run.error !== null) {
      seat.state = 'failed';
      seat.error = run.error;
      seat.rawOutput = run.diagnostics || run.text;
      this.noteIfUnavailable(seat.harness, seat.model, `${run.error} ${run.diagnostics}`);
    } else {
      seat.rawOutput = run.text;
      try {
        const parsed =
          agent && !builtinForm(agent.form)
            ? parseCustom({ text: run.text, fields: agent.formInfo?.fields ?? [] })
            : agent?.form === 'answer'
              ? parseChairman({
                  text: run.text,
                  schema: agent.schema,
                  round: chair.round,
                  labels: [],
                })
              : agent?.form === 'report'
                ? parseReport({ text: run.text, schema: agent.schema })
                : parseMember({
                    text: run.text,
                    schema: memberSchemaOf(
                      agent?.schema ?? settings.memberSchema,
                      chair,
                      seat as SeatRun,
                    ),
                    round: chair.round,
                    previousClaimIds,
                    memory: seat.memory,
                  });
        if (parsed.ok) {
          seat.state = 'done';
          seat.parsed = parsed.value as unknown as NonNullable<typeof seat.parsed>;
          seat.sanitized =
            agent && !builtinForm(agent.form)
              ? (parsed.value as unknown as NonNullable<typeof seat.sanitized>)
              : (stripSelfIdentificationDeep(parsed.value, identitiesOf(settings))
                  .value as NonNullable<typeof seat.sanitized>);
          seat.trimmed = parsed.trimmed;
        } else {
          seat.state = 'invalid';
          seat.error = parsed.error;
          const step = stepOf(chair, seat.seatId);
          if (step && parsed.errorNote) step.errorNote = parsed.errorNote;
        }
      } catch (error) {
        seat.state = 'invalid';
        seat.error = `could not read the output: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    this.recordAttempt(chair, {
      kind: 'seat',
      seatId: seat.seatId,
      label: seat.label,
      harness: seat.harness,
      model: seat.model,
      state: seat.state,
      error: seat.error,
      usage: seat.usage,
      prompt: seat.prompt,
      raw: seat.rawOutput,
      startedAt: seat.startedAt,
      endedAt: seat.endedAt,
    });
    this.progress(
      chair.id,
      seat.state === 'done' && seat.sanitized
        ? {
            type: 'seat-done',
            label: seat.label,
            stepId: seat.seatId,
            stance:
              'stance' in seat.sanitized && typeof seat.sanitized.stance === 'string'
                ? seat.sanitized.stance
                : '',
          }
        : {
            type: 'seat-failed',
            label: seat.label,
            stepId: seat.seatId,
            reason:
              seat.state === 'skipped'
                ? 'skipped'
                : seat.state === 'timeout'
                  ? 'timeout'
                  : run.cancelled && !stoppedWaiting
                    ? 'cancelled'
                    : seat.state === 'invalid'
                      ? 'invalid'
                      : 'failed',
          },
    );
    this.touch(session, chair);
  }

  /**
   * A member showed a sign of work: when, and the thinking tokens its harness has reported so far. Announced at most once a
   * second per member, as the `seat` event of the server and as a `seat-signal` of the round.
   */
  private sign(
    session: Session,
    chair: ChairNode,
    seat: SeatRun<MemberOutput | ReportOutput | Record<string, unknown>>,
    sign: { thinkingTokens?: number | null },
  ): void {
    seat.lastSignalAt = now();
    if (typeof sign.thinkingTokens === 'number') seat.thinkingTokens = sign.thinkingTokens;
    const last = this.announced.get(seat) ?? 0;
    if (Date.now() - last < 1000) return;
    this.announced.set(seat, Date.now());
    // the round's content changed: the revision the event carries is the one a read of the round has from now on, so a page can
    // tell this sign from a later state (a seat that completed meanwhile) whatever order they reach it in
    chair.rev = this.store.nextRev();
    this.emitEvent({
      type: 'seat',
      rev: chair.rev,
      sessionId: session.id,
      chairId: chair.id,
      seatId: seat.seatId,
      label: seat.label,
      state: seat.state,
      lastSignalAt: seat.lastSignalAt,
      thinkingTokens: seat.thinkingTokens ?? null,
    });
    this.progress(chair.id, {
      type: 'seat-signal',
      label: seat.label,
      stepId: seat.seatId,
      thinkingTokens: seat.thinkingTokens ?? null,
    });
  }

  /**
   * «منتظرش نمی‌مانم»: stops waiting for one member of a round that is running. Its call is stopped and the member is left out
   * (`skipped`, what it cost counted); the round goes on with the others (the chairman still needs two valid answers).
   * The member is named by its label in this round (`{label}`) or, apart, by its seat id (`{seatId}`): the two are never
   * looked up in one list, so a seat id that equals another member's label cannot stop the wrong member.
   */
  skipSeat(
    sessionId: string,
    chairId: string,
    target: { label: string } | { seatId: string },
  ): void {
    const session = this.require(sessionId);
    const chair = session.nodes[chairId];
    if (chair?.kind !== 'chair') throw new EngineError('bad_node', 404);
    const round = this.rounds.get(chairId);
    const member =
      'label' in target
        ? runsOf(chair).find((item) => item.label === target.label)
        : runsOf(chair).find((item) => item.seatId === target.seatId);
    if (!member) throw new EngineError('bad_seat', 404);
    if (
      !round ||
      chair.status !== 'running' ||
      round.finalizing ||
      member.state !== 'running' ||
      !round.seatControllers.has(member.seatId)
    ) {
      throw new EngineError('not_running', 409);
    }
    round.skippedByUser.add(member.seatId);
    round.seatControllers.get(member.seatId)?.abort();
  }

  /**
   * «Stop waiting for the rest»: stops the wait for every member that is still working, so the chairman writes the answer from
   * the members that have answered. It needs two valid answers (the chairman's rule); else nothing is stopped and the round
   * goes on. Answers how many members were stopped.
   */
  skipRemaining(sessionId: string, chairId: string): number {
    const session = this.require(sessionId);
    const chair = session.nodes[chairId];
    if (chair?.kind !== 'chair') throw new EngineError('bad_node', 404);
    const round = this.rounds.get(chairId);
    if (!round || chair.status !== 'running' || round.finalizing) {
      throw new EngineError('not_running', 409);
    }
    const flow = session.settings.flow ?? compileCouncil(session.settings);
    const { enough } = finalInputsReady(flow, chair);
    if (!enough) throw new EngineError('too_few_answers', 409);
    let stopped = 0;
    for (const member of runsOf(chair)) {
      if (member.state !== 'running' || !round.seatControllers.has(member.seatId)) continue;
      round.skippedByUser.add(member.seatId);
      round.seatControllers.get(member.seatId)?.abort();
      stopped += 1;
    }
    return stopped;
  }

  private settleSeatAsFailed(
    chair: ChairNode,
    seat: SeatRun<MemberOutput | ReportOutput | Record<string, unknown>>,
    reason: unknown,
  ): void {
    log(`seat ${seat.label} (${seat.harness}) failed unexpectedly`, reason);
    const wasRunning = seat.state === 'running';
    this.progress(chair.id, {
      type: 'seat-failed',
      label: seat.label,
      stepId: seat.seatId,
      reason: 'failed',
    });
    seat.state = 'failed';
    seat.error = reason instanceof Error ? reason.message : String(reason);
    seat.endedAt = seat.endedAt ?? now();
    seat.usage = seat.usage ?? estimateUsage(seat.prompt, '');
    // A call that was started has cost something: it is recorded even though it ended in an exception.
    if (wasRunning || seat.startedAt) {
      this.recordAttempt(chair, {
        kind: 'seat',
        seatId: seat.seatId,
        label: seat.label,
        harness: seat.harness,
        model: seat.model,
        state: seat.state,
        error: seat.error,
        usage: seat.usage,
        prompt: seat.prompt,
        raw: '',
        startedAt: seat.startedAt,
        endedAt: seat.endedAt,
      });
    }
  }

  private async runChairman(
    session: Session,
    chair: ChairNode,
    fromChairId: string | null,
    input: InputParts | null,
    valid: SeatRun[],
    signal: AbortSignal,
    agent?: FlowAgent,
    _drafts: Extract<FlowStep, { form: 'report' }>[] = [],
    upstream: Exclude<FlowStep, { form: 'answer' | 'condition' }>[] = [],
  ): Promise<void> {
    const { settings } = session;
    const context = buildContext({
      nodes: session.nodes,
      rootId: session.rootId,
      fromChairId,
      newInput: input,
      rules: settings.rules,
      critiqueInstruction: settings.critiqueInstruction,
      background: session.background ?? null,
    });
    const run = chairmanOf(chair);
    run.state = 'running';
    run.tools =
      agent?.tools ?? settings.chairman.tools ?? heldValue(run.harness, 'tools') !== false;
    run.activity = { file: 0, memory: 0, web: 0, thread: 0, other: 0 };
    run.toolLog = [];
    run.startedAt = now();
    run.input = chairmanInput({
      rules: agent?.rules ?? settings.chairmanRules,
      round: chair.round,
      context,
      // the form is the session's: chosen by the first round, then told to every chairman call (a session from before it
      // is addressed formally)
      ...(session.register || chair.round > 1
        ? { addressForm: session.register ?? ('formal' as const) }
        : {}),
      members: valid.map((seat) => ({
        label: seat.label,
        output: seat.sanitized as NonNullable<SeatRun['sanitized']>,
        ...(seat.activity ? { activity: seat.activity } : {}),
        // lens modes: what each member was assigned, told to the chairman beside its anonymous answer
        ...(chair.lensMode && chair.lensMode !== 'off' ? { lens: seat.lens ?? null } : {}),
      })),
    });
    if (settings.flow?.kind === 'custom' && agent)
      run.input += `\n\n${upstreamInput(upstream.filter((peer) => peer.form !== 'member' || settings.flow?.edges.find((e) => e.from === peer.id && e.to === agent.id)?.fields).map((peer) => ({ label: stepOf(chair, agent.id)?.aliases[peer.id] ?? '', output: projectOutput(settings.flow as Flow, peer.id, agent.id, peer.run.sanitized as unknown as Record<string, unknown>) })))}`;
    run.promptTokens = estimateTokens(run.input);
    this.progress(chair.id, { type: 'chairman', answers: valid.length });
    this.touch(session, chair);
    let result: AgentRun;
    try {
      result = await this.callWithRetry(chair, run, {
        harness: run.harness,
        model: run.model,
        effort: run.effort,
        tools: run.tools === true,
        memory: run.memory === true,
        web: false,
        prompt: run.input,
        schema: nativeSchema(
          agent?.schema ?? settings.chairmanSchema,
          false,
          session.register === undefined,
        ),
        idleMs: this.idleMs,
        ...(chair.cwd ? { cwd: chair.cwd } : {}),
        onSignal: (sign) => {
          for (const tool of sign.tools ?? []) this.tool(session, chair, run, tool);
        },
        signal,
      });
    } catch (error) {
      result = {
        text: '',
        usage: null,
        error: error instanceof Error ? error.message : String(error),
        timedOut: false,
        cancelled: false,
        durationMs: 0,
        diagnostics: '',
      };
    }
    run.endedAt = now();
    if (result.folderNote) run.folderNote = result.folderNote;
    run.usage = result.usage ?? estimateUsage(run.input, result.text || result.diagnostics);
    run.rawOutput = result.error !== null ? result.diagnostics || result.text : result.text;
    const record = (state: string, error: string | null) =>
      this.recordAttempt(chair, {
        kind: 'chairman',
        seatId: null,
        label: null,
        harness: run.harness,
        model: run.model,
        state,
        error,
        usage: run.usage,
        prompt: run.input,
        raw: run.rawOutput,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      });
    if (result.cancelled) {
      run.state = 'failed';
      run.error = 'cancelled';
      record('failed', 'cancelled');
      await this.finish(session, chair, 'cancelled', 'cancelled');
      return;
    }
    if (result.timedOut || result.error !== null) {
      run.state = 'failed';
      run.error = result.timedOut ? 'timeout' : result.error;
      record('failed', run.error);
      this.noteIfUnavailable(run.harness, run.model, `${run.error} ${result.diagnostics}`);
      await this.finish(
        session,
        chair,
        'failed',
        note('chairman_failed', { detail: run.error ?? '' }),
      );
      return;
    }
    let parsed: ReturnType<typeof parseChairman>;
    try {
      parsed = parseChairman({
        text: result.text,
        schema: agent?.schema ?? settings.chairmanSchema,
        round: chair.round,
        // Only the members whose answers the chairman was given can be credited or scored.
        labels: valid.map((seat) => seat.label),
        lensOnly: chair.lensMode === 'only',
      });
    } catch (error) {
      parsed = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (!parsed.ok) {
      run.state = 'failed';
      run.error = parsed.error;
      record('invalid', parsed.error);
      await this.finish(
        session,
        chair,
        'failed',
        note('chairman_invalid', { detail: parsed.error }),
      );
      return;
    }
    const out = parsed.value;
    const step = chair.steps?.find((item) => item.form === 'answer');
    if (step?.form === 'answer') step.output = out;
    const roundLabel = (label: string): string => {
      const member = valid.find((seat) => seat.label === label);
      return member
        ? (seatsOf(chair).find((seat) => seat.seatId === member.seatId)?.label ?? label)
        : label;
    };
    run.state = 'done';
    run.trimmed = parsed.trimmed;
    record('done', null);
    chair.title = out.title;
    // the first round's choice of how to address the asker is the session's from then on
    if (out.register && session.register === undefined) session.register = out.register;
    chair.direction = out.direction;
    chair.answer = out.answer;
    chair.recommendation = out.recommendation;
    chair.questionsForUser = out.questions_for_user;
    chair.claims = out.claims.map((claim) => ({ ...claim, from: claim.from.map(roundLabel) }));
    chair.seatScores = out.seat_scores.map((score) => ({
      ...score,
      label: roundLabel(score.label),
    }));
    chair.dissent = out.dissent ?? null;
    chair.agreement = out.agreement ?? null;
    const user = chair.parentId ? session.nodes[chair.parentId] : undefined;
    // A round sent without a comment has no input to title: it keeps its "no comment" title.
    if (user && user.kind === 'user') user.title = out.input_title;
    await this.finish(session, chair, 'done', null);
  }

  // ---------- spend ----------

  private tool(
    session: Session,
    chair: ChairNode,
    run: SeatRun<MemberOutput | ReportOutput | Record<string, unknown>> | ChairmanRun,
    event: ToolEvent,
  ): void {
    const tool = { ...event, target: event.target.slice(0, 200), at: now() };
    run.activity ??= { file: 0, memory: 0, web: 0, thread: 0, other: 0 };
    run.activity[tool.kind] += 1;
    run.toolLog ??= [];
    if (run.toolLog.length < 300) run.toolLog.push(tool);
    const file = process.env.DIVAN_TOOL_LOG;
    if (file) {
      try {
        appendFileSync(
          file,
          `${JSON.stringify({
            ...tool,
            sessionId: session.id,
            chairId: chair.id,
            seatId: 'seatId' in run ? run.seatId : 'chairman',
            harness: run.harness,
          })}\n`,
        );
      } catch {
        // Supervision logging must not fail a call or its round.
      }
    }
  }

  /** A connection failure gets one immediate retry; the failed call remains an attempt with its own usage. */
  private async callWithRetry(
    chair: ChairNode,
    call: SeatRun<MemberOutput | ReportOutput | Record<string, unknown>> | ChairmanRun,
    spec: RunSpec,
  ): Promise<AgentRun> {
    const invoke = async () => {
      try {
        return await runAgent(spec);
      } catch (error) {
        return {
          text: '',
          usage: null,
          error: error instanceof Error ? error.message : String(error),
          timedOut: false,
          cancelled: false,
          durationMs: 0,
          diagnostics: '',
        };
      }
    };
    const first = await invoke();
    const error = `${first.error ?? ''} ${first.diagnostics}`;
    if (
      first.error === null ||
      first.timedOut ||
      first.cancelled ||
      spec.signal?.aborted ||
      ACCOUNT_OUT.test(error) ||
      RATE_LIMIT.test(error) ||
      !CONNECTION_FAILURE.test(error)
    )
      return first;
    this.recordAttempt(chair, {
      kind: 'seatId' in call ? 'seat' : 'chairman',
      seatId: 'seatId' in call ? call.seatId : null,
      label: 'seatId' in call ? call.label : null,
      harness: call.harness,
      model: call.model,
      state: 'failed',
      error: first.error,
      usage: first.usage,
      prompt: spec.prompt,
      raw: first.text || first.diagnostics,
      startedAt: call.startedAt,
      endedAt: now(),
    });
    call.startedAt = now();
    spec.attempt = 2;
    return invoke();
  }

  private recordAttempt(
    chair: ChairNode,
    call: {
      kind: Attempt['kind'];
      seatId: string | null;
      label: string | null;
      harness: Attempt['harness'];
      model: string;
      state: string;
      error: string | null;
      usage: Usage | null;
      prompt: string;
      raw: string;
      startedAt: string | null;
      endedAt: string | null;
    },
  ): void {
    const promptTokens = estimateTokens(call.prompt);
    const usage = call.usage ?? estimateUsage(call.prompt, call.raw);
    chair.attempts = chair.attempts ?? [];
    chair.attempts.push({
      kind: call.kind,
      seatId: call.seatId,
      label: call.label,
      harness: call.harness,
      model: call.model,
      state: call.state,
      error: call.error,
      usage,
      promptTokens,
      councilTokens:
        promptTokens + (usage.source === 'harness' ? usage.output : estimateTokens(call.raw)),
      startedAt: call.startedAt,
      endedAt: call.endedAt,
    });
    const step = chair.steps?.find((item) =>
      call.kind === 'chairman'
        ? item.form === 'answer'
        : call.kind === 'seat' && item.id === call.seatId,
    );
    step?.attempts.push(chair.attempts.length - 1);
  }

  /** Round totals from every attempt (retries and failed calls included), so a retry never erases spend. */
  private sumUsage(chair: ChairNode): ChairNode['usage'] {
    const attempts = chair.attempts ?? [];
    const sum = (kind: Attempt['kind'], pick: (attempt: Attempt) => number) =>
      attempts
        .filter((attempt) => attempt.kind === kind)
        .reduce((total, attempt) => total + pick(attempt), 0);
    const total = (attempt: Attempt) => attempt.usage?.total ?? 0;
    const members = sum('seat', total);
    const chairman = sum('chairman', total);
    const planner = sum('planner', total);
    return {
      members,
      chairman,
      ...(planner > 0 ? { planner } : {}),
      total: members + chairman + planner,
      council: attempts.reduce((all, attempt) => all + attempt.councilTokens, 0),
      cached: attempts.reduce((all, attempt) => all + (attempt.usage?.cached ?? 0), 0),
      estimated: attempts.some((attempt) => attempt.usage?.source === 'estimate'),
    };
  }

  /**
   * A model that fails for lack of credit or quota is remembered. An account that is out (no balance, no resource
   * package) takes its whole provider down for 24 hours; a plain rate limit passes over that one model for an hour.
   */
  private noteIfUnavailable(harness: SeatRun['harness'], model: string, text: string): void {
    const accountOut = ACCOUNT_OUT.test(text);
    if (!accountOut && !RATE_LIMIT.test(text)) return;
    const segments = model.split('/');
    // Only Pi names providers inside its model ids: "anthropic/claude-x" is out as "anthropic/", a gateway id such as
    // "litellm/zai/glm" as "litellm/zai/". Any other harness is out as a whole (the empty prefix).
    const prefix =
      harness === 'pi' && segments.length >= 2 ? `${segments.slice(0, -1).join('/')}/` : '';
    this.store
      .addUnavailable({
        harness,
        model,
        until: new Date(
          Date.now() + (accountOut ? ACCOUNT_OUT_HOURS : RATE_LIMIT_HOURS) * 3_600_000,
        ).toISOString(),
        reason: text.replace(/\s+/gu, ' ').trim().slice(0, 160),
        ...(accountOut ? { prefix } : {}),
      })
      .catch((error) => log('could not remember an unavailable model', error));
  }

  /**
   * Ends the round, as one change of the session: the finished state is written whole first (the live node stays `running`,
   * so nothing can continue from it and nothing is announced that the disk does not have), then it is published.
   */
  private async finish(
    session: Session,
    chair: ChairNode,
    status: ChairNode['status'],
    failure: string | Note | null,
  ): Promise<void> {
    // a failure with a code is worded by the client; a plain text (a harness's own, or 'cancelled') is shown as it is
    const coded = typeof failure === 'object' && failure !== null ? failure : null;
    const error: string | null = coded ? coded.message : (failure as string | null);
    const entry = this.rounds.get(chair.id);
    if (entry) entry.finalizing = true;
    this.clearPending(session.id);
    try {
      await this.mutate(session.id, async () => {
        // a session from a client of the endpoint is named by what the chairman called its question, as soon as it has
        const renamed = status === 'done' ? this.chairmanName(session, chair) : undefined;
        // the revision this announcement will have is made first, so that what is saved is exactly what is announced
        let final: ChairNode = {
          ...chair,
          rev: this.store.nextRev(),
          status,
          error,
          ...(coded ? { errorNote: coded } : {}),
          endedAt: now(),
          usage: this.sumUsage(chair),
        };
        if (!coded) delete final.errorNote;
        try {
          await this.persist(session, {
            nodes: [final],
            ...(renamed ? { name: renamed } : {}),
          });
          if (renamed) session.name = renamed;
        } catch (saveError) {
          if (final.status === 'done') {
            const saveNote = note('round_save_failed', {
              detail: saveError instanceof Error ? saveError.message : String(saveError),
            });
            final = { ...final, status: 'failed', error: saveNote.message, errorNote: saveNote };
          }
        }
        chair.status = final.status;
        chair.error = final.error;
        if (final.errorNote) chair.errorNote = final.errorNote;
        else delete chair.errorNote;
        chair.endedAt = final.endedAt;
        chair.usage = final.usage;
        if (final.rev !== undefined) chair.rev = final.rev;
        this.emitNode(session, chair, { bump: false });
        const user = chair.parentId ? session.nodes[chair.parentId] : undefined;
        if (user) this.emitNode(session, user);
        this.emitSession(session);
      });
    } catch (queueError) {
      log('the finished round could not be published', queueError);
    }
    this.progress(chair.id, { type: 'end', status: chair.status });
  }

  /**
   * The name a session of the endpoint takes from its first round: the chairman's title of the question, in place of the first
   * words of the question the session was named with. A session the asker has named, or that was made on the web (which shows
   * the chairman's title in its place without renaming), is left alone.
   */
  private chairmanName(session: Session, chair: ChairNode): string | undefined {
    if (session.origin?.kind !== 'api' || chair.parentId !== session.rootId) return undefined;
    const root = session.nodes[session.rootId];
    if (!root || root.kind === 'chair') return undefined;
    if (session.name !== shorten(root.text, 60)) return undefined;
    const title = shorten(root.title, 60);
    return title !== '' && root.title !== shorten(root.text, 40) ? title : undefined;
  }

  // ---------- events and saving ----------

  /** A write that surfaces its failure as an EngineError (the change then leaves things as they were). */
  private async persist(session: Session, over: Overlay = {}): Promise<void> {
    try {
      await this.store.save(session, over);
    } catch (error) {
      log('could not save the session', error);
      throw new EngineError('save_failed', 500, {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Writes the session as it is (a round's progress, the answers of its members): one more change in its queue. */
  private saveLive(session: Session): Promise<void> {
    return this.mutate(session.id, (live) => this.persist(live));
  }

  private clearPending(sessionId: string): void {
    const timer = this.pending.get(sessionId);
    if (timer) clearTimeout(timer);
    this.pending.delete(sessionId);
  }

  /** Announces a change and saves it a moment later (calls settle in bursts); a failed save is logged, never thrown. */
  private touch(session: Session, chair: ChairNode): void {
    this.emitNode(session, chair);
    if (this.pending.has(session.id)) return;
    this.pending.set(
      session.id,
      setTimeout(() => {
        this.pending.delete(session.id);
        this.saveLive(session).catch(() => undefined); // a failed write is logged by `persist`; a deleted session is gone
      }, 150),
    );
  }

  /**
   * Announces a node. Every announcement is a newer revision of what it says (see `NodeBase.rev`), made here; a caller that has
   * saved the node under its revision already (`finish`) passes `bump: false` and announces exactly what it saved.
   */
  private emitNode(session: Session, node: SessionNode, options: { bump?: boolean } = {}): void {
    if (options.bump !== false) node.rev = this.store.nextRev();
    this.emitEvent({ type: 'node', sessionId: session.id, node });
  }

  private emitSession(session: Session): void {
    this.emitEvent({ type: 'session', session: summarize(session), layout: session.layout });
  }

  /** Aborts every round in flight, waits (briefly) for them to settle, and waits for the pending saves. */
  async flush(): Promise<void> {
    const running = [...this.rounds.values()];
    for (const { controller } of running) controller.abort();
    await Promise.race([
      Promise.allSettled(running.map((round) => round.done)),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (let pass = 0; pass < 3 && this.queues.size > 0; pass += 1) {
      await Promise.allSettled([...this.queues.values()]);
    }
    await this.store.flush();
  }
}
