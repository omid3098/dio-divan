import { agentIdentity, chairmanOf, orderedNodes, seatsOf, stepOf } from '../shared/flow.ts';
// The routes under `/v1/divan/`: the threads of a client that keeps its own conversation and only needs Divan to answer its
// turns (T3 Code, through its ACP bridge). They sit behind the same guard as `/v1` (the API key, no browser headers) and answer
// errors before a stream starts in the same shape.
//   GET  /v1/divan/threads/:id         where a thread stands (its tip), or 404
//   POST /v1/divan/threads/:id/turns   one turn, answered as a stream of JSON lines (NDJSON):
//     {type:'note', text}                                     something the client may want to know (a folder that was not used, a
//                                                             session that is busy so the turn starts a new one)
//     {type:'round', sessionId, chairId, plan}                the round was admitted; `plan` is its checklist
//     {type:'plan', plan}                                     the checklist changed (a member finished, the chairman began)
//     {type:'progress', text}                                 one line of the round's live report (who answered, who did not, the
//                                                             chairman began, a heartbeat every minute): English whatever the language
//                                                             of the asker, naming the assistants, never a member's letter or words
//     {type:'answer', sessionId, chairId, content, usage}     the end, with the answer and its closing line
//     {type:'error', code, message, link}                     the end, when there is no answer
// A bare newline every few seconds keeps the connection alive through a long silence. A client that closes the connection
// cancels the round, and the thread's tip stays where it was.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HARNESS_LABEL, IDLE_STOP_MS } from '../shared/defaults.ts';
import { SKIPPED_BY_USER, SKIPPED_SAME_FAMILY } from '../shared/failure.ts';
import { isLevel } from '../shared/levels.ts';
import { messageText } from '../shared/messages.ts';
import { roundLink } from '../shared/round-link.ts';
import type { ChairNode, HarnessId, ProfileView, SeatRun, Session } from '../shared/types.ts';
import { validateCwd } from './cwd.ts';
import { EngineError, type RoundEvent, type RoundHandle } from './engine.ts';
import { answerText, linkLabel } from './gateway.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { BODY_LIMIT, clientName, keepaliveMs, sendApiError } from './openai.ts';
import { SECURITY_HEADERS } from './security.ts';
import type { ApiRef, Store } from './store.ts';
import type { Threads } from './threads.ts';

export interface DivanDeps {
  threads: Threads;
  store: Store;
  profiles: () => Promise<ProfileView[]>;
  /** The link to a round in the web app (a one-time address that also signs the browser in). */
  link: (sessionId: string, chairId: string) => string;
}

/** The client's own id of a thread: what a bridge makes up for its session (`__proto__` is no name for a key of the index). */
const THREAD_ID = /^(?!__proto__$)[A-Za-z0-9_-]{8,128}$/u;

export interface PlanStep {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// The words this server writes itself for the client are protocol text in English, whatever the language of the asker: the
// checklist (the client shows it beside the asker's own text, and a line of mixed directions reads badly), the live report below
// and this note. (The closing link of an answer is the one exception, and it is in the language of the answer: see `linkLabel`.)
const CHAIRMAN = 'Chairman';
const UNANSWERED = ' — did not answer';
const SKIPPED = ' — skipped';
const BUSY_NOTE =
  'Another round of this Divan session is running, so this question starts a new session with the conversation so far.';

/** The working folder a turn names, checked as for any request: the folder, or the reason it is not used. */
function folderOf(cwd: string | null): { path: string | null; note: string | null } {
  if (!cwd) return { path: null, note: null };
  const verdict = validateCwd(cwd);
  return verdict.ok
    ? { path: verdict.path, note: null }
    : { path: null, note: `working folder not used (${verdict.reason})` };
}

/** `Codex · gpt-6-astra · high`: the assistant, its model and the reasoning level it was asked for (each left out when empty). */
const named = (harness: HarnessId, model: string, effort = ''): string =>
  [HARNESS_LABEL[harness], model, effort].filter(Boolean).join(' · ');

/** The members of a round in the council's own order. */
function membersOf(session: Session, chair: ChairNode): SeatRun[] {
  if (session.settings.flow?.kind === 'custom') return seatsOf(chair);
  return session.settings.seats.flatMap((config) => {
    const seat = seatsOf(chair).find((item) => item.seatId === config.id);
    return seat ? [seat] : [];
  });
}

/**
 * The checklist of a round: one step per member in the council's own order, then the chairman. It names who is working and the
 * reasoning level asked of each (fixed for the round, so a step keeps its text while it runs: the client counts a step whose text
 * changes as a new one), and never says who said what: no letters (they are shuffled every round and are the blindness), and
 * nothing a member wrote.
 */
export function planOf(session: Session, chair: ChairNode): PlanStep[] {
  if (session.settings.flow?.kind === 'custom' && chair.steps) {
    return orderedNodes(session.settings.flow).map((agent) => {
      const run = stepOf(chair, agent.id)?.run;
      const role = agentIdentity(
        session.settings.flow as NonNullable<Session['settings']['flow']>,
        agent.id,
      );
      if (agent.kind === 'condition') {
        const step = stepOf(chair, agent.id);
        const reasons = {
          matched: messageText('flow_condition_matched'),
          not_matched: messageText('flow_condition_not_matched'),
          missing_field: messageText('flow_condition_missing_field'),
          source_failed: messageText('flow_condition_source_failed'),
          inactive_branch: messageText('flow_branch_skipped'),
        };
        const reason = step?.form === 'condition' && step.reason ? reasons[step.reason] : '';
        return {
          content: `Condition ${agent.id}${reason ? ` — ${reason}` : run?.state && !['pending', 'running', 'done'].includes(run.state) ? UNANSWERED : ''}`,
          status: run?.state === 'pending' ? 'pending' : 'completed',
        };
      }
      const name = `${role} · ${named(agent.harness, agent.model, agent.effort)}`;
      return {
        content:
          name +
          (run?.state === 'skipped'
            ? stepOf(chair, agent.id)?.skipReason === 'inactive_branch' ||
              run.error === 'inactive_branch'
              ? ' — inactive branch'
              : SKIPPED
            : run?.state && !['pending', 'running', 'done'].includes(run.state)
              ? UNANSWERED
              : ''),
        status:
          run?.state === 'pending'
            ? 'pending'
            : run?.state === 'running'
              ? 'in_progress'
              : 'completed',
      };
    });
  }
  const members = membersOf(session, chair);
  const steps: PlanStep[] = members.map((seat, index) => {
    const rawName = named(seat.harness, seat.model, seat.effort);
    const name =
      members.filter((item) => named(item.harness, item.model, item.effort) === rawName).length > 1
        ? `Member ${index + 1} · ${rawName}`
        : rawName;
    switch (seat.state) {
      case 'pending':
        return { content: name, status: 'pending' };
      case 'running':
        return { content: name, status: 'in_progress' };
      case 'done':
        return { content: name, status: 'completed' };
      case 'skipped':
        return { content: `${name}${SKIPPED}`, status: 'completed' };
      default:
        return { content: `${name}${UNANSWERED}`, status: 'completed' };
    }
  });
  const run = chairmanOf(chair);
  const name = `${CHAIRMAN} · ${named(run.harness, run.model, run.effort)}`;
  steps.push(
    run.state === 'pending' || (run.state === 'blocked' && run.startedAt === null)
      ? { content: name, status: 'pending' }
      : run.state === 'running'
        ? { content: name, status: 'in_progress' }
        : run.state === 'done'
          ? { content: name, status: 'completed' }
          : { content: `${name}${UNANSWERED}`, status: 'completed' },
  );
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------------
// The live report: one plain English line for each thing that happens, which the client shows as the council's thinking.

/** `45s`, `1m 42s`, `12m`. */
export function durationText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes < 10 && rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/** A time in a line that comes once a minute: whole minutes from nearly one on (`3m`, not `3m 1s`). */
const roughly = (ms: number): string =>
  ms >= 50_000 ? `${Math.floor((ms + 10_000) / 60_000)}m` : durationText(ms);

/** `850`, `14k`. */
export const tokensText = (count: number): string =>
  count < 1000 ? String(count) : `${Math.round(count / 1000)}k`;

/** How long ago `since` was, at `at` (0 for no time). */
const elapsed = (since: string | null | undefined, at: number): number =>
  since ? Math.max(0, at - Date.parse(since)) : 0;

const UNANSWERED_WHY: Record<'timeout' | 'failed' | 'invalid' | 'cancelled', string> = {
  timeout: `timed out after ${IDLE_STOP_MS / 60_000} minutes without a sign of work`,
  failed: 'failed',
  invalid: 'gave an answer that could not be read',
  cancelled: 'cancelled',
};

/** Why a member was left out, from its error text (the constants and the words the web app tells it by). */
function skippedWhy(error: string | null): string {
  if (error === messageText('flow_step_disabled')) return messageText('flow_step_disabled');
  if (error === SKIPPED_SAME_FAMILY) return 'same model family as the chairman';
  if (error === SKIPPED_BY_USER) return 'stopped by the user';
  return (error ?? '').includes('rate') ? 'rate limited' : 'out of credit';
}

/**
 * The line an event of a round adds to the live report, or null when it says nothing new. A member is named as in the checklist
 * and never by letter, and nothing a member wrote (its stance, its answer) is ever in a line: the report says who works, not who
 * said what.
 */
export function progressOf(event: RoundEvent, chair: ChairNode): string | null {
  const seatOf = (label: string): SeatRun | undefined =>
    seatsOf(chair).find((seat) =>
      event.stepId ? seat.seatId === event.stepId : seat.label === label,
    );
  switch (event.type) {
    case 'seat-done': {
      const seat = seatOf(event.label);
      if (!seat) return null;
      const took =
        seat.startedAt && seat.endedAt
          ? ` after ${durationText(Date.parse(seat.endedAt) - Date.parse(seat.startedAt))}`
          : '';
      return event.identity
        ? messageText('flow_step_answered', {
            step: `${event.identity} · ${named(seat.harness, seat.model)}`,
            time: took,
          })
        : `${named(seat.harness, seat.model)} answered${took}.`;
    }
    case 'seat-failed': {
      const seat = seatOf(event.label);
      if (!seat) return null;
      const name = `${event.identity ? `${event.identity} · ` : ''}${named(seat.harness, seat.model)}`;
      if (event.identity)
        return messageText(event.reason === 'skipped' ? 'flow_step_skipped' : 'flow_step_failed', {
          step: name,
          reason:
            event.reason === 'skipped' ? skippedWhy(seat.error) : UNANSWERED_WHY[event.reason],
        });
      return event.reason === 'skipped'
        ? `${name} was skipped (${skippedWhy(seat.error)}).`
        : `${name} did not answer (${UNANSWERED_WHY[event.reason]}).`;
    }
    case 'seat-note': {
      const seat = seatOf(event.label);
      return seat
        ? event.identity
          ? messageText('flow_step_folder', {
              step: `${event.identity} · ${named(seat.harness, seat.model)}`,
            })
          : `${named(seat.harness, seat.model)} answered without the project folder.`
        : null;
    }
    case 'chairman': {
      const run = chairmanOf(chair);
      if (event.identity && event.answers === 0)
        return messageText('flow_step_started', {
          step: `${event.identity} (${named(run.harness, run.model, run.effort)})`,
        });
      if (event.identity)
        return messageText('flow_answer_started', {
          step: `${event.identity} (${named(run.harness, run.model, run.effort)})`,
          answers: event.answers,
        });
      return `All members are in. The chairman (${named(run.harness, run.model, run.effort)}) is reading ${event.answers} answers.`;
    }
    default:
      return null;
  }
}

/** A member that has shown no sign of work for this long is said to be silent (the web app says it from the same minute). */
const SILENT_MS = 60_000;

/** The heartbeat of a round that is running: how long it has been going, and what each member still working is doing. */
export function heartbeatOf(session: Session, chair: ChairNode, at: number): string {
  const working = membersOf(session, chair).filter((seat) => seat.state === 'running');
  if (working.length > 0) {
    const parts = working.map((seat) => {
      const silent = elapsed(seat.lastSignalAt ?? seat.startedAt, at);
      const doing =
        silent >= SILENT_MS
          ? `no sign of work for ${roughly(silent)}`
          : seat.thinkingTokens
            ? `${tokensText(seat.thinkingTokens)} thinking tokens`
            : 'working';
      const flow = session.settings.flow;
      return `${flow?.kind === 'custom' ? `${agentIdentity(flow, seat.seatId)} · ` : ''}${HARNESS_LABEL[seat.harness]} ${doing}`;
    });
    return `Working for ${roughly(elapsed(chair.startedAt, at))}: ${parts.join(', ')}.`;
  }
  return chairmanOf(chair).state === 'running'
    ? messageText('flow_working', {
        step:
          session.settings.flow?.kind === 'custom'
            ? agentIdentity(
                session.settings.flow,
                session.settings.flow.nodes.find(
                  (node) => node.kind === 'agent' && node.form === 'answer',
                )?.id ?? '',
              )
            : 'Chairman',
        time: roughly(elapsed(chairmanOf(chair).startedAt, at)),
      })
    : `Working for ${roughly(elapsed(chair.startedAt, at))}.`;
}

/** How often the heartbeat is sent: a minute (`DIVAN_PROGRESS_MS` shortens it for tests). */
export const PROGRESS_MS = 60_000;
export const progressMs = (): number => Number(process.env.DIVAN_PROGRESS_MS) || PROGRESS_MS;

/** The profile a turn names: `d1-<id>` (the bridge's model value) and `divan/<id>` both name the profile `<id>`. */
function findProfile(profiles: ProfileView[], asked: string): ProfileView | undefined {
  const bare = asked.trim().replace(/^divan\//u, '');
  // a profile may itself be called `d1-…`: its own id is tried first
  return (
    profiles.find((profile) => profile.id === bare) ??
    profiles.find((profile) => profile.id === bare.replace(/^d1-/u, ''))
  );
}

interface TurnBody {
  profile: string;
  level: unknown;
  text: string;
  cwd: string | null;
  from: ApiRef | null;
  background: string | null;
}

const badRequest = (what: string) =>
  new HttpError(400, 'bad_request', `the body of a turn is JSON with ${what}`);

function turnBody(body: Record<string, unknown>): TurnBody {
  const optionalText = (value: unknown, name: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') throw badRequest(`"${name}" as text`);
    return value;
  };
  if (typeof body.profile !== 'string' || body.profile.trim() === '') {
    throw badRequest('"profile" (a profile id)');
  }
  if (typeof body.text !== 'string') throw badRequest('"text" (the message)');
  const from = body.from as { sessionId?: unknown; chairId?: unknown } | null | undefined;
  if (
    from !== undefined &&
    from !== null &&
    (typeof from !== 'object' ||
      typeof from.sessionId !== 'string' ||
      typeof from.chairId !== 'string')
  ) {
    throw badRequest('"from" as {sessionId, chairId}');
  }
  if (body.text.trim() === '') throw new HttpError(400, 'empty_message', 'the message is empty');
  return {
    profile: body.profile,
    level: body.level,
    text: body.text,
    cwd: optionalText(body.cwd, 'cwd'),
    from: from ? { sessionId: from.sessionId as string, chairId: from.chairId as string } : null,
    background: optionalText(body.background, 'background'),
  };
}

/** Routes one authenticated `/v1/divan/` request. Errors that escape are answered by the caller in the OpenAI shape. */
export async function handleDivan(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: DivanDeps,
): Promise<void> {
  const method = req.method ?? 'GET';
  const found = /^\/v1\/divan\/threads\/([^/]+)(\/turns)?$/u.exec(url.pathname);
  if (found) {
    const id = found[1] as string;
    if (!THREAD_ID.test(id)) {
      return sendApiError(
        res,
        400,
        'bad_thread',
        'a thread id is 8 to 128 letters, digits, "_" or "-"',
      );
    }
    if (!found[2] && method === 'GET') {
      const view = deps.threads.view(id);
      if (!view) return sendApiError(res, 404, 'no_thread', `no thread "${id}" is known here`);
      return sendJson(res, 200, view);
    }
    if (found[2] && method === 'POST') return turn(req, res, id, deps);
  }
  return sendApiError(res, 404, 'not_found', `no such endpoint: ${method} ${url.pathname}`);
}

/** The error text of a round, without the words T3 Code reads as a sign that its provider needs signing in. */
const calm = (text: string): string =>
  text
    .replace(/\bauthenticat\w*/giu, 'access check')
    .replace(/\bcredentials?\b/giu, 'access details')
    .replace(/\blog(?:[\s-]+)?in\b/giu, 'sign in');

async function turn(
  req: IncomingMessage,
  res: ServerResponse,
  threadId: string,
  deps: DivanDeps,
): Promise<void> {
  // The client may leave at any moment, also before the council has been asked: it is watched from the first line.
  let gone = false;
  let finished = false;
  let handle: RoundHandle | null = null;
  const left = new AbortController();
  res.on('close', () => {
    if (finished) return;
    gone = true;
    left.abort(); // also tells a round that is still being admitted
    handle?.cancel();
  });

  const body = turnBody(await readJson(req, BODY_LIMIT));
  const profile = findProfile(await deps.profiles(), body.profile);
  if (!profile) {
    throw new HttpError(404, 'model_not_found', `no profile named "${body.profile}"`);
  }
  const level = isLevel(body.level) ? body.level : profile.defaultLevel;
  const { action } = deps.threads.plan({
    threadId,
    profile,
    level,
    text: body.text,
    from: body.from,
    background: body.background,
  });
  if (profile.levels[level].blocked && action.kind === 'new') {
    throw new HttpError(409, 'profile_blocked', profile.levels[level].blocked.message);
  }
  if (gone) return;
  const folder = folderOf(body.cwd);

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const write = (text: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  };
  // one object a line: JSON never holds a raw newline, and the two line separators of JavaScript are escaped too
  const send = (event: Record<string, unknown>) =>
    write(
      `${JSON.stringify(event).replace(/[\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16)}`)}\n`,
    );
  const keepalive = setInterval(() => write('\n'), keepaliveMs());
  let heartbeat: NodeJS.Timeout | null = null;
  let unsubscribe: (() => void) | null = null;
  try {
    if (folder.note) send({ type: 'note', text: folder.note });
    handle = await deps.threads.start({
      threadId,
      profile,
      level,
      text: body.text,
      cwd: folder.path,
      from: body.from,
      background: body.background,
      client: clientName(req),
      signal: left.signal,
      onBusySession: () => send({ type: 'note', text: BUSY_NOTE }),
    });
    if (gone) {
      handle.cancel();
      return;
    }
    const started = handle;
    const session = deps.store.get(started.sessionId);
    if (!session) throw new EngineError('no_session', 404);
    const chairOf = () => session.nodes[started.chairId] as ChairNode;

    // The checklist follows the round's own state, and is sent only when it has changed (a sign of work changes nothing).
    const first = planOf(session, chairOf());
    let sent = JSON.stringify(first);
    send({ type: 'round', sessionId: started.sessionId, chairId: started.chairId, plan: first });
    const refresh = () => {
      const plan = planOf(session, chairOf());
      const text = JSON.stringify(plan);
      if (text === sent) return;
      sent = text;
      send({ type: 'plan', plan });
    };
    // The live report: a line for what happens to a member or to the chairman, and a heartbeat for as long as the round runs.
    const report = (text: string) => send({ type: 'progress', text });
    heartbeat = setInterval(() => {
      if (chairOf().status === 'running') report(heartbeatOf(session, chairOf(), Date.now()));
    }, progressMs());
    // The state is read a moment after the event: a seat that fails unexpectedly announces it just before it changes.
    let scheduled = false;
    unsubscribe = started.subscribe((event) => {
      const line = progressOf(event, chairOf());
      if (line) report(line);
      if (event.type === 'seat-signal' || event.type === 'seat-note' || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        refresh();
      });
    });
    const status = await started.done;
    // nothing is reported after the round has ended
    clearInterval(heartbeat);
    refresh();

    const chair = chairOf();
    const ref = { sessionId: started.sessionId, chairId: started.chairId };
    if (status !== 'done') {
      const why = status === 'cancelled' ? 'the round was cancelled' : (chair.error ?? status);
      return send({
        type: 'error',
        code: status === 'cancelled' ? 'round_cancelled' : 'round_failed',
        message: calm(`the council could not answer: ${why}`),
        link: deps.link(ref.sessionId, ref.chairId),
      });
    }
    if (gone) return;
    // the answer is about to be delivered: its round is the thread's tip from now on
    await deps.threads.deliver(threadId, ref, () => !gone);
    if (gone) return;
    const text = answerText(chair);
    const sessionTokens = Object.values(session.nodes).reduce(
      (sum, node) => sum + (node.kind === 'chair' ? node.usage.total : 0),
      0,
    );
    send({
      type: 'answer',
      ...ref,
      content: `${text}\n\n${roundLink(deps.link(ref.sessionId, ref.chairId), ref, linkLabel(text))}`,
      usage: { round: chair.usage.total, session: sessionTokens },
    });
  } catch (error) {
    if (!(error instanceof EngineError || error instanceof HttpError)) console.error(error);
    send({
      type: 'error',
      code: error instanceof EngineError || error instanceof HttpError ? error.code : 'internal',
      message:
        error instanceof EngineError || error instanceof HttpError
          ? calm(error.message)
          : 'internal error',
      link: null,
    });
  } finally {
    finished = true;
    clearInterval(keepalive);
    if (heartbeat) clearInterval(heartbeat);
    unsubscribe?.();
    if (!res.writableEnded) res.end();
  }
}
