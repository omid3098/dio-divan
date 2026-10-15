// The ACP bridge: `divan acp` makes the council an agent that any Agent Client Protocol client can run (T3 Code runs it
// as a "Local command" provider named Divan). It speaks newline-delimited JSON-RPC 2.0 on stdin and stdout; stdout carries
// nothing else (one compact message per line, no blank line), and everything for a human goes to stderr.
//
// The bridge holds no council of its own. One bridge process is one T3 thread: it keeps the thread's choices (the council
// and the reasoning level, the folder) and asks the one Divan server, over its `/v1/divan/threads/<id>/turns` route, to run a
// round for each prompt; the route streams the round's progress and answer as NDJSON, which becomes ACP updates here. Closing
// that stream cancels the round on the server. Divan only gives counsel: the bridge never calls the client's tools, and it
// ignores the MCP servers the client offers in `session/new` (they carry the client's own credential).
//
// `initialize` and `session/new` are cheap and side-effect free (the client also runs them as a short probe, in a process it
// kills at once): they never start the server and never write anything. The server is started, through the launcher, by the
// first thing that needs it: a prompt, or the resume of a thread.
//
// This file imports only `node:*`, `./launch.ts` and `../shared/*`, so a bridge never loads the engine or the server.

import { randomUUID } from 'node:crypto';
import { CONTINUE_TEXT } from '../shared/acp-text.ts';
import { isLevel, REASONING_LEVELS } from '../shared/levels.ts';
import { VERSION } from '../shared/package-root.ts';
import { lastRound, type RoundRef } from '../shared/round-link.ts';
import type { ReasoningLevel } from '../shared/types.ts';
import { divanHome, ensureServer, type ProfileEntry, profilesFromSettings } from './launch.ts';

type Json = Record<string, unknown>;
type RpcId = string | number;

/** The client's models are Divan's profiles: the value `d1-default`, `d1-quick`, … and the label `d1-` and the profile's name. */
const MODEL_PREFIX = 'd1-';
/** Where a thread's name has to fit on the server (`/v1/divan/threads/:id`). */
const THREAD_ID = /^[A-Za-z0-9_-]{8,128}$/u;
const PLAN_STATUSES = new Set(['pending', 'in_progress', 'completed']);

const LEVEL_NAMES: Record<ReasoningLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

/** A JSON-RPC error that is meant for the client. */
class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/** One running `session/prompt`: it is answered exactly once, by whichever of the stream's end and a cancel comes first. */
interface Prompt {
  id: RpcId;
  controller: AbortController;
  answered: boolean;
}

/** What the bridge keeps of one conversation. */
export interface SessionState {
  cwd: string | null;
  /** The profile id, without the `d1-` of the model value. */
  profile: string;
  level: ReasoningLevel;
  /** Whether the user picked the level; until then it follows the profile's own default level. */
  levelChosen: boolean;
  active: Prompt | null;
  /**
   * The turn the server has not admitted yet: set when a prompt starts, cleared when the server says it admitted the round.
   * A cancel that lands before that leaves the user's message with nobody but this bridge, so the client's "continue"
   * button (which sends only `Continue where you left off.`) sends this turn again.
   */
  unadmitted: Turn | null;
}

export interface ConfigOption {
  id: string;
  name: string;
  category: string;
  type: 'select';
  currentValue: string;
  options: { value: string; name: string }[];
}

const sessions = new Map<string, SessionState>();

// ---------------------------------------------------------------------------------------------------------------------
// The words that make a prompt, and the options a client shows.

/**
 * The user's own text of a prompt. A client may wrap the first message in its instructions
 * (`<t3_code_instructions>…</t3_code_instructions>\n\n<user_request>\n<text>\n</user_request>`) and always ends the prompt with
 * a note about itself (`<runtime_info>…`); the council must see neither. Only text blocks count.
 */
export function promptText(blocks: unknown): string {
  const text = (Array.isArray(blocks) ? blocks : [])
    .flatMap((block: unknown) => {
      const record = block as { type?: unknown; text?: unknown } | null;
      return record?.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
    .filter((part) => !part.trim().startsWith('<runtime_info>'))
    .join('\n\n');
  let rest = text.trimStart();
  // only the wrapper at the start is taken off: a message that talks about these tags keeps them
  const instructionsEnd = '</t3_code_instructions>';
  if (rest.startsWith('<t3_code_instructions>')) {
    const close = rest.indexOf(instructionsEnd);
    if (close >= 0) rest = rest.slice(close + instructionsEnd.length).trimStart();
  }
  const requestStart = '<user_request>';
  const requestEnd = '</user_request>';
  const whole = rest.trimEnd();
  if (whole.startsWith(requestStart) && whole.endsWith(requestEnd)) {
    return whole.slice(requestStart.length, whole.length - requestEnd.length).trim();
  }
  return rest.trim();
}

export interface Split {
  message: string;
  /** The round a forked conversation continues: the last one the handoff names. */
  from: RoundRef | null;
  /**
   * The earlier conversation as text, always sent with the message: the server continues from the round `from` names when
   * that round still exists and reads the background only otherwise (the round was deleted, or is in another Divan home).
   */
  background: string | null;
}

/**
 * A client that starts a fork or a new session from an old thread puts the old conversation in front of the message:
 * `Context handoff (…):` … `\n\nUser message:\n<text>`. The text after the last `User message:` is the message; the last round
 * of ours that the handoff names (in the closing link of an answer) is where the fork continues; the handoff itself always goes along as background.
 */
export function splitHandoff(text: string): Split {
  const marker = '\n\nUser message:\n';
  const cut = text.lastIndexOf(marker);
  if (!text.startsWith('Context handoff (') || cut < 0) {
    return { message: text.trim(), from: null, background: null };
  }
  const handoff = text.slice(0, cut);
  const message = text.slice(cut + marker.length).trim();
  return {
    message,
    from: lastRound(handoff) ?? null,
    background: handoff.trim() || null,
  };
}

/**
 * The options the client shows for a conversation: the council as the model (`d1-<profile>`) and the reasoning level.
 * Built from Divan's own settings each time, so a profile made in the meantime is there; the conversation's own profile is
 * always among them.
 */
export function configOptions(
  state: Pick<SessionState, 'profile' | 'level'>,
  profiles: ProfileEntry[] = profilesFromSettings(divanHome()),
): ConfigOption[] {
  const models = profiles.map((profile) => ({
    value: MODEL_PREFIX + profile.id,
    name: MODEL_PREFIX + profile.label,
  }));
  const current = MODEL_PREFIX + state.profile;
  if (!models.some((model) => model.value === current)) {
    models.push({ value: current, name: current });
  }
  return [
    {
      id: 'model',
      name: 'Council',
      category: 'model',
      type: 'select',
      currentValue: current,
      options: models,
    },
    {
      id: 'effort',
      name: 'Reasoning',
      category: 'thought_level',
      type: 'select',
      currentValue: state.level,
      options: REASONING_LEVELS.map((level) => ({ value: level, name: LEVEL_NAMES[level] })),
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------
// The wire.

/** The only writer of stdout: one compact message and its newline. */
function send(message: Json): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(message: string): void {
  process.stderr.write(`divan acp: ${message.slice(0, 500)}\n`);
}

/**
 * A client reads a few words in an error (signing in, credentials) as a request to sign in, whatever the error is about; an
 * error of ours is never that.
 */
const plain = (text: string): string =>
  text.replace(/\b(?:authenticat\w*|credentials?|log(?:[\s-]+)?in)\b/giu, 'access check');

const reasonOf = (error: unknown): string =>
  plain(error instanceof Error ? error.message : String(error));

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function errorOf(error: unknown): { code: number; message: string } {
  return error instanceof RpcError
    ? { code: error.code, message: plain(error.message) }
    : { code: -32603, message: reasonOf(error) };
}

function sessionOf(id: unknown): SessionState {
  const session = typeof id === 'string' ? sessions.get(id) : undefined;
  if (!session) throw new RpcError(-32602, 'Unknown session.');
  return session;
}

function defaultLevelOf(profile: string, profiles: ProfileEntry[]): ReasoningLevel {
  return profiles.find((entry) => entry.id === profile)?.defaultLevel ?? 'medium';
}

// ---------------------------------------------------------------------------------------------------------------------
// The methods that answer by returning.

function initialize(): unknown {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'dio-divan', title: 'Divan', version: VERSION },
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { resume: {} },
    },
    authMethods: [],
  };
}

function newSession(params: Json): unknown {
  const sessionId = `dv_${randomUUID()}`;
  const state: SessionState = {
    cwd: typeof params.cwd === 'string' && params.cwd ? params.cwd : null,
    profile: 'default',
    level: defaultLevelOf('default', profilesFromSettings(divanHome())),
    levelChosen: false,
    active: null,
    unadmitted: null,
  };
  sessions.set(sessionId, state);
  return { sessionId, configOptions: configOptions(state) };
}

function setConfigOption(params: Json): unknown {
  const session = sessionOf(params.sessionId);
  const { configId, value } = params;
  if (typeof value !== 'string') throw new RpcError(-32602, 'The value of an option is text.');
  const profiles = profilesFromSettings(divanHome());
  if (configId === 'model') {
    const chosen = profiles.find((profile) => MODEL_PREFIX + profile.id === value);
    if (chosen) {
      session.profile = chosen.id;
      if (!session.levelChosen) session.level = chosen.defaultLevel;
    } else if (value !== MODEL_PREFIX + session.profile) {
      throw new RpcError(-32602, `Unknown council: ${value}`);
    }
  } else if (configId === 'effort') {
    if (!isLevel(value)) throw new RpcError(-32602, `Unknown reasoning level: ${value}`);
    session.level = value;
    session.levelChosen = true;
  } else {
    throw new RpcError(-32602, `Unknown option: ${String(configId)}`);
  }
  return { configOptions: configOptions(session, profiles) };
}

/** The running server, started through the launcher when needed: its `/v1` address and the headers every request carries. */
async function server(): Promise<{ root: string; headers: Record<string, string> }> {
  try {
    const { state, apiKey } = await ensureServer();
    return {
      root: `http://127.0.0.1:${state.port}/v1`,
      headers: { authorization: `Bearer ${apiKey}`, 'x-divan-client': 't3-code' },
    };
  } catch (error) {
    throw new RpcError(-32603, `Dio Divan could not start: ${reasonOf(error)}`);
  }
}

/** The reason in a failed answer of the server (`{error: {message}}`), else its status. */
async function failureOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } };
    const message = body?.error?.message;
    if (typeof message === 'string' && message) return plain(message);
  } catch {
    // not the server's error shape
  }
  return `Divan answered with status ${response.status}.`;
}

/** Opens a thread the client knew before (it was idle, or the client was restarted) from the server's record of it. */
async function resumeSession(params: Json): Promise<unknown> {
  const sessionId = params.sessionId;
  if (typeof sessionId !== 'string' || !THREAD_ID.test(sessionId)) {
    throw new RpcError(-32602, 'Unknown session.');
  }
  const { root, headers } = await server();
  let response: Response;
  try {
    response = await fetch(`${root}/divan/threads/${sessionId}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new RpcError(-32603, `Divan did not answer: ${reasonOf(error)}`);
  }
  if (response.status === 404) {
    throw new RpcError(-32002, 'Divan does not know this conversation.');
  }
  if (!response.ok) throw new RpcError(-32603, await failureOf(response));
  const record = (await response.json().catch(() => null)) as {
    profileId?: unknown;
    level?: unknown;
    cwd?: unknown;
  } | null;
  const state: SessionState = {
    cwd:
      typeof params.cwd === 'string' && params.cwd
        ? params.cwd
        : typeof record?.cwd === 'string'
          ? record.cwd
          : null,
    profile: typeof record?.profileId === 'string' ? record.profileId : 'default',
    level: isLevel(record?.level) ? record.level : 'medium',
    levelChosen: true,
    active: sessions.get(sessionId)?.active ?? null,
    unadmitted: sessions.get(sessionId)?.unadmitted ?? null,
  };
  sessions.set(sessionId, state);
  return { configOptions: configOptions(state) };
}

async function handle(method: string, params: Json): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return initialize();
    case 'authenticate':
      return {};
    case 'session/new':
      return newSession(params);
    case 'session/set_config_option':
      return setConfigOption(params);
    case 'session/resume':
      return resumeSession(params);
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/** Answers a request with what `run` returns, or with its error. */
async function answer(id: RpcId, run: () => Promise<unknown>): Promise<void> {
  let message: Json;
  try {
    message = { jsonrpc: '2.0', id, result: await run() };
  } catch (error) {
    message = { jsonrpc: '2.0', id, error: errorOf(error) };
  }
  send(message);
}

// ---------------------------------------------------------------------------------------------------------------------
// A prompt: one round on the server.

/** Answers a prompt, once: the second and every later attempt is dropped (a cancel and the stream's end can race). */
function finish(
  session: SessionState,
  prompt: Prompt,
  reply: { result: unknown } | { error: { code: number; message: string } },
): void {
  if (prompt.answered) return;
  prompt.answered = true;
  if (session.active === prompt) session.active = null;
  send({ jsonrpc: '2.0', id: prompt.id, ...reply });
}

const failWith = (code: number, message: string) => ({ error: { code, message: plain(message) } });

/** A `session/update`; none is sent once its prompt has been answered. */
function update(sessionId: string, prompt: Prompt, content: Json): void {
  if (prompt.answered) return;
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: content },
  });
}

const textBlock = (value: string): Json => ({ type: 'text', text: value });

/**
 * A line for the client's "thinking" area (a note, a line of the round's live report). Each line is a message of its own, with
 * a `messageId` of its own: T3 Code adds the chunks of one message together and shows the whole as a single run-on line (it
 * collapses the line breaks), while a chunk with a new `messageId` closes the one before and is shown as a row of its own.
 */
function thought(sessionId: string, prompt: Prompt, text: string): void {
  update(sessionId, prompt, {
    sessionUpdate: 'agent_thought_chunk',
    messageId: randomUUID(),
    content: textBlock(`${text}\n`),
  });
}

/** The plan the server sent as the client's checklist; a step it cannot read is left out. */
function planEntries(plan: unknown): Json[] {
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((step: unknown) =>
    isObject(step) &&
    typeof step.content === 'string' &&
    step.content &&
    typeof step.status === 'string' &&
    PLAN_STATUSES.has(step.status)
      ? [{ content: step.content, priority: 'medium', status: step.status }]
      : [],
  );
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function parseLine(line: string): Json | null {
  if (!line) return null;
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : null;
  } catch {
    log('a line of the server was not JSON');
    return null;
  }
}

/** The events of the server's NDJSON stream; the blank lines that keep the connection alive are skipped. */
async function* eventsOf(body: ReadableStream<Uint8Array>): AsyncGenerator<Json> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const event = parseLine(pending.slice(0, end).trim());
      pending = pending.slice(end + 1);
      if (event) yield event;
    }
  }
  const last = parseLine((pending + decoder.decode()).trim());
  if (last) yield last;
}

interface Turn {
  message: string;
  from: Split['from'];
  background: string | null;
}

/** Asks the server for the round and turns its stream into updates; ends with the prompt's answer (or a cancel did). */
async function runTurn(
  sessionId: string,
  session: SessionState,
  prompt: Prompt,
  turn: Turn,
): Promise<void> {
  const { root, headers } = await server();
  // a cancel that came while the server was starting
  if (prompt.answered) return;
  const response = await fetch(`${root}/divan/threads/${sessionId}/turns`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      profile: session.profile,
      level: session.level,
      text: turn.message,
      cwd: session.cwd,
      from: turn.from,
      background: turn.background,
    }),
    signal: prompt.controller.signal,
  });
  if (!response.ok) {
    return finish(session, prompt, failWith(-32603, await failureOf(response)));
  }
  if (!response.body) {
    return finish(session, prompt, failWith(-32603, 'Divan stopped answering.'));
  }
  for await (const event of eventsOf(response.body)) {
    if (prompt.answered) return;
    switch (event.type) {
      case 'note':
      case 'progress':
        if (typeof event.text === 'string' && event.text) thought(sessionId, prompt, event.text);
        break;
      case 'round':
      case 'plan': {
        // the server has the round now, and it can run it again itself
        session.unadmitted = null;
        const entries = planEntries(event.plan);
        if (entries.length > 0) update(sessionId, prompt, { sessionUpdate: 'plan', entries });
        break;
      }
      case 'answer': {
        if (typeof event.content !== 'string') {
          return finish(
            session,
            prompt,
            failWith(-32603, 'Divan sent an answer that cannot be read.'),
          );
        }
        update(sessionId, prompt, {
          sessionUpdate: 'agent_message_chunk',
          content: textBlock(event.content),
        });
        const used = isObject(event.usage) ? event.usage.session : undefined;
        if (isCount(used)) {
          update(sessionId, prompt, { sessionUpdate: 'usage_update', used, size: 0 });
        }
        return finish(session, prompt, { result: { stopReason: 'end_turn' } });
      }
      case 'error': {
        const message = typeof event.message === 'string' ? event.message : 'The round failed.';
        const link = typeof event.link === 'string' && event.link ? event.link : null;
        return finish(
          session,
          prompt,
          failWith(-32603, link ? `${message} Open it in Divan: ${link}` : message),
        );
      }
    }
  }
  finish(session, prompt, failWith(-32603, 'Divan stopped answering.'));
}

function startPrompt(id: RpcId, params: Json): void {
  const reject = (code: number, message: string) =>
    send({ jsonrpc: '2.0', id, error: { code, message } });
  const sessionId = typeof params.sessionId === 'string' ? params.sessionId : '';
  const session = sessions.get(sessionId);
  if (!session) {
    reject(-32602, 'Unknown session.');
    return;
  }
  const asked = splitHandoff(promptText(params.prompt));
  if (!asked.message) {
    reject(-32602, 'The message is empty.');
    return;
  }
  if (session.active) {
    reject(-32603, 'A request is already running in this conversation.');
    return;
  }
  // The client's "continue" after a cancel that came before the server admitted the round: the server has no round to run
  // again and the literal sentence is no question, so the message that was cancelled is sent again.
  const turn = asked.message === CONTINUE_TEXT && session.unadmitted ? session.unadmitted : asked;
  session.unadmitted = turn;
  // from here on a cancel can reach the prompt, even while the server is still starting
  const prompt: Prompt = { id, controller: new AbortController(), answered: false };
  session.active = prompt;
  runTurn(sessionId, session, prompt, turn).catch((error: unknown) => {
    if (prompt.answered) return;
    log(reasonOf(error));
    finish(
      session,
      prompt,
      error instanceof RpcError
        ? failWith(error.code, error.message)
        : failWith(-32603, 'Divan stopped answering.'),
    );
  });
}

/** `session/cancel`: the running prompt is ended at once, and what the server still says is not heard. */
function cancel(params: Json): void {
  const session = typeof params.sessionId === 'string' ? sessions.get(params.sessionId) : undefined;
  const prompt = session?.active;
  if (!session || !prompt) return;
  prompt.controller.abort();
  finish(session, prompt, { result: { stopReason: 'cancelled' } });
}

// ---------------------------------------------------------------------------------------------------------------------

function onLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    log('a line of the client was not JSON');
    return;
  }
  if (!isObject(message)) return;
  const { id, method, params } = message;
  // a response to something we never asked
  if (typeof method !== 'string') return;
  const args = isObject(params) ? params : {};
  if (method === 'session/cancel') {
    cancel(args);
    return;
  }
  // a notification: nothing to answer, known or not
  if (typeof id !== 'string' && typeof id !== 'number') return;
  if (method === 'session/prompt') startPrompt(id, args);
  else void answer(id, () => handle(method, args));
}

/** Serves the protocol on stdin and stdout until the client closes stdin, then ends the process. */
export async function runAcp(): Promise<void> {
  // stdout is the protocol: whatever a library prints with console.log goes to stderr instead
  for (const name of ['log', 'info', 'debug', 'warn'] as const) {
    console[name] = (...args: unknown[]) => console.error(...args);
  }
  // the client is gone: nothing is left to tell it
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('error', () => undefined);
  const closed = new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  process.stdin.setEncoding('utf8');
  let pending = '';
  process.stdin.on('data', (chunk: string) => {
    pending += chunk;
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      if (line) onLine(line);
    }
  });
  await closed;
  // closing a prompt's stream cancels its round on the server; nobody is left to be told how it ended
  for (const session of sessions.values()) {
    if (!session.active) continue;
    session.active.answered = true;
    session.active.controller.abort();
  }
  await new Promise<void>((done) => process.stdout.write('', () => done()));
  process.exit(0);
}
