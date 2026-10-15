import { requireValue } from './fixtures.ts';
// The ACP bridge end to end, as T3 Code drives it: the real `node --disable-warning=ExperimentalWarning bin/dio-divan.mjs acp`
// with pipes for stdin and stdout, a temporary Divan home and the fake harnesses. The first prompt starts the real Divan server
// through the launcher, so the bridge, the launcher, `/v1/divan/threads` and the engine run together. Everything the bridge
// writes is checked against the protocol's own JSON Schema, stdout is checked to carry nothing but one-line JSON-RPC 2.0
// messages, and the T3 credential in the bridge's environment is followed to see that it stops at the bridge. The pure parts and
// the bridge against a stand-in server are in `acp-unit.test.ts`.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validateCwd } from '../src/server/cwd.ts';
import { BIN, readServerState, serverHealthy } from '../src/server/launch.ts';
import { killTree } from '../src/server/proc.ts';
import type { ThreadRecord } from '../src/server/store.ts';
import type { ChairNode, Session } from '../src/shared/types.ts';
import { writerFlow } from './fixtures/flows.ts';

const LONG = 120_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A value that must be there: the test fails with the name of what is missing, not with a null. */
function got<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The protocol's schema.

const ajv = new Ajv2020({ strict: false, validateFormats: false, discriminator: true });
ajv.addSchema(
  JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        '..',
        'node_modules',
        '@agentclientprotocol',
        'sdk',
        'schema',
        'schema.json',
      ),
      'utf8',
    ),
  ),
  'acp',
);
/** Whether a value is a valid instance of a definition of the official ACP schema (the errors, else). */
function validate(definition: string, value: unknown): string | true {
  const check = ajv.compile({ $ref: `acp#/$defs/${definition}` });
  return check(value) ? true : ajv.errorsText(check.errors);
}

/** The definition of the answer to each request the bridge serves. */
const RESPONSE_OF: Record<string, string> = {
  initialize: 'InitializeResponse',
  'session/new': 'NewSessionResponse',
  'session/resume': 'ResumeSessionResponse',
  'session/set_config_option': 'SetSessionConfigOptionResponse',
  'session/prompt': 'PromptResponse',
};

interface Step {
  content: string;
  priority: string;
  status: string;
}
interface Update {
  sessionUpdate: string;
  messageId?: string;
  entries?: Step[];
  content?: { type: string; text: string };
  used?: number;
  size?: number;
}
interface Rpc {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: { sessionId?: string; update?: Update };
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}
interface Option {
  id: string;
  category: string;
  currentValue: string;
  options: { value: string; name: string }[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The bridge, as a client runs it.

let home: string;
let probeDir: string;
let project: string;
let scratch: string;
const SECRET = 'T3-CREDENTIAL-d2f1c7a98e4b5036';
const bridges: Bridge[] = [];

/** What T3 puts in the environment of an agent it starts, and the settings of a test run of Divan. */
function bridgeEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DIVAN_HOME: home,
    DIVAN_FAKE: '1',
    DIVAN_FAKE_DELAY_MS: '150',
    // every node process of the tree (the bridge, the launcher, the server) writes down which T3 variables it can see
    DIVAN_PROBE_DIR: probeDir,
    NODE_OPTIONS: [
      process.env.NODE_OPTIONS,
      `--import=${pathToFileURL(join(scratch, 'probe.mjs')).href}`,
    ]
      .filter(Boolean)
      .join(' '),
    T3_ACP_MCP_AUTHORIZATION: `Bearer ${SECRET}`,
    T3_ACP_MCP_ENDPOINT: 'http://127.0.0.1:9/mcp',
    T3_ACP_MCP_NODE: process.execPath,
    T3_ACP_MCP_ENTRYPOINT: join(scratch, 'no-such-bridge.mjs'),
    ELECTRON_RUN_AS_NODE: '1',
  };
}

class Bridge {
  readonly child = spawnBridge();
  readonly messages: Rpc[] = [];
  /** Everything the bridge did that a client would not accept; a test ends with none. */
  readonly problems: string[] = [];
  stdout = '';
  stderr = '';
  private partial = '';
  private exited = false;
  readonly exit: Promise<number | null>;
  private nextId = 2 ** 32;
  private readonly sent = new Map<number, string>();
  private readonly answered = new Map<number, number>();

  constructor() {
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdout += chunk;
      this.partial += chunk;
      for (let end = this.partial.indexOf('\n'); end >= 0; end = this.partial.indexOf('\n')) {
        const line = this.partial.slice(0, end);
        this.partial = this.partial.slice(end + 1);
        this.onLine(line);
      }
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    this.exit = new Promise((resolve) => {
      this.child.once('close', (code) => {
        this.exited = true;
        if (this.partial !== '')
          this.problems.push(`stdout ended in a partial line: ${this.partial}`);
        resolve(code);
      });
    });
    bridges.push(this);
  }

  private problem(text: string): void {
    this.problems.push(text.slice(0, 600));
  }

  /** Every line of stdout is one compact JSON-RPC 2.0 message that the protocol's schema accepts. */
  private onLine(line: string): void {
    let message: Rpc;
    try {
      message = JSON.parse(line) as Rpc;
    } catch {
      this.problem(`a line that is not JSON: ${JSON.stringify(line)}`);
      return;
    }
    if (JSON.stringify(message) !== line) this.problem(`not one compact line: ${line}`);
    if (message.jsonrpc !== '2.0') this.problem(`not JSON-RPC 2.0: ${line}`);
    const extra = Object.keys(message).filter(
      (key) => !['jsonrpc', 'id', 'method', 'params', 'result', 'error'].includes(key),
    );
    if (extra.length > 0) this.problem(`unknown keys ${extra.join(',')}: ${line}`);
    this.messages.push(message);
    if (message.method !== undefined) {
      if (message.id !== undefined) this.problem(`the agent made a request: ${line}`);
      const verdict =
        message.method === 'session/update'
          ? validate('SessionNotification', message.params)
          : `a notification that is not a session update: ${message.method}`;
      if (verdict !== true) this.problem(`${verdict}: ${line}`);
      return;
    }
    const id = message.id;
    const method = typeof id === 'number' ? this.sent.get(id) : undefined;
    if (typeof id !== 'number' || method === undefined) {
      this.problem(`an answer to nothing we asked: ${line}`);
      return;
    }
    this.answered.set(id, (this.answered.get(id) ?? 0) + 1);
    if ((this.answered.get(id) ?? 0) > 1) this.problem(`answered twice: ${line}`);
    if ('result' in message === 'error' in message) {
      this.problem(`neither or both of result and error: ${line}`);
      return;
    }
    const verdict = message.error
      ? validate('Error', message.error)
      : validate(RESPONSE_OF[method] ?? 'unknown', message.result);
    if (verdict !== true) this.problem(`${method}: ${verdict}: ${line}`);
  }

  private write(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** A request, answered by its result or error message. */
  call(method: string, params: unknown, ms = 90_000): Promise<Rpc> {
    const id = this.nextId++;
    this.sent.set(id, method);
    this.write({ id, method, params });
    return this.waitFor(
      (m) => m.id === id && m.method === undefined,
      0,
      ms,
      `the answer to ${method}`,
    );
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** The first message from `from` on that `matches`. */
  async waitFor(
    matches: (message: Rpc) => boolean,
    from: number,
    ms: number,
    what: string,
  ): Promise<Rpc> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.messages.slice(from).find(matches);
      if (found) return found;
      if (this.exited || Date.now() > deadline) {
        throw new Error(
          `No ${what} (${this.exited ? 'the bridge ended' : 'timed out'}). stderr: ${this.stderr}`,
        );
      }
      await sleep(10);
    }
  }

  /** A client that is done: stdin closes and the bridge ends by itself, with nothing left unsaid. */
  async close(): Promise<number | null> {
    this.child.stdin.end();
    const code = await Promise.race([this.exit, sleep(10_000).then(() => 'late' as const)]);
    if (code === 'late') {
      await killTree(got(this.child.pid, 'the bridge pid'));
      throw new Error(`The bridge did not end when stdin closed. stderr: ${this.stderr}`);
    }
    return code;
  }
}

function spawnBridge() {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, 'acp'], {
    env: bridgeEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// What T3 sends, and what a turn is made of.

const text = (value: string) => ({ type: 'text', text: value });
const RUNTIME = text(
  "<runtime_info>In case you're asked: you are running in T3 Code through the acpRegistry harness, as d1-default.</runtime_info>\n\n<pull_request_linking>Do not link pull requests.</pull_request_linking>",
);
/** The first prompt of a session: T3 wraps the user's message in its own instructions. */
const firstPrompt = (user: string) => [
  text(
    `<t3_code_instructions>\n## T3 Code interaction mode: Default\nAnswer plainly and do not use tools.\n</t3_code_instructions>\n\n<user_request>\n${user}\n</user_request>`,
  ),
  RUNTIME,
];
/** A later prompt carries the user's text as it is. */
const laterPrompt = (user: string) => [text(user), RUNTIME];

interface Answered {
  reply: Rpc;
  kinds: string[];
  plans: Step[][];
  /** The lines of the live report, as the client's "thinking" area gets them. */
  thoughts: string[];
  message: string;
  used: number | undefined;
  ref: { sessionId: string; chairId: string };
}

/** A prompt that is answered normally: its updates all come before the answer, the checklist ends complete, the reply is end_turn. */
async function ask(bridge: Bridge, sessionId: string, blocks: unknown[]): Promise<Answered> {
  const from = bridge.messages.length;
  const reply = await bridge.call('session/prompt', { sessionId, prompt: blocks });
  const turn = bridge.messages.slice(from);
  expect(turn.at(-1), 'the answer to the prompt comes after every update').toBe(reply);
  expect(reply.error).toBeUndefined();
  expect(reply.result).toEqual({ stopReason: 'end_turn' });
  const updates = turn.slice(0, -1).map((message) => {
    expect(message.method).toBe('session/update');
    expect(message.params?.sessionId).toBe(sessionId);
    return got(message.params?.update, 'the update');
  });
  const kinds = updates.map((update) => update.sessionUpdate);
  // the checklist first, then the answer, then the meter
  expect(kinds.slice(-2)).toEqual(['agent_message_chunk', 'usage_update']);
  const lead = kinds.slice(0, -2);
  expect(lead.length).toBeGreaterThanOrEqual(2);
  // the checklist and the live report (the client's "thinking" area), nothing else
  expect(new Set(lead)).toEqual(new Set(['plan', 'agent_thought_chunk']));
  const plans = updates.flatMap((update) =>
    update.sessionUpdate === 'plan' ? [update.entries ?? []] : [],
  );
  const reports = updates.filter((update) => update.sessionUpdate === 'agent_thought_chunk');
  const thoughts = reports.map((update) => got(update.content, 'the content of a thought').text);
  // each line is a message of its own (the client would join the chunks of one message into a single run-on line)
  const ids = reports.map((update) => update.messageId);
  expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
  expect(thoughts.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(
    true,
  );

  const first = got(plans[0], 'the first checklist');
  const last = got(plans.at(-1), 'the last checklist');
  expect(
    first.some((step) => step.status !== 'completed'),
    'the round had begun, not ended',
  ).toBe(true);
  expect(last.every((step) => step.status === 'completed')).toBe(true);
  // one step per member and one for the chairman, in the same order and with the same words from the first update to the last
  expect(first.length).toBeGreaterThanOrEqual(3);
  expect(first.at(-1)?.content.startsWith('Chairman · ')).toBe(true);
  expect(first.slice(0, -1).every((step) => !step.content.startsWith('Chairman'))).toBe(true);
  // the report names who answered, as the checklist names them, and says when the chairman began, with its level
  const answered = last
    .slice(0, -1)
    .filter((step) => !/ — (?:did not answer|skipped)$/u.test(step.content))
    .map((step) => step.content.replace(/ · \w+$/u, ''));
  expect(answered.length).toBeGreaterThanOrEqual(2);
  for (const name of answered) {
    expect(thoughts.filter((line) => line.startsWith(`${name} answered after `))).toHaveLength(1);
  }
  const begins = thoughts.findIndex((line) => line.startsWith('All members are in.'));
  expect(begins, 'the chairman began').toBeGreaterThan(-1);
  expect(thoughts[begins]).toBe(
    `All members are in. The chairman (${first.at(-1)?.content.replace(/^Chairman · /u, '')}) is reading ${answered.length} answers.\n`,
  );
  for (const name of answered) {
    expect(thoughts.findIndex((line) => line.startsWith(name))).toBeLessThan(begins);
  }
  for (const line of thoughts) expect(line).not.toMatch(/(^|[\s·(])[A-E]($|[\s·).,:])/u);
  for (const plan of plans) {
    expect(plan.map((step) => step.content)).toEqual(first.map((step) => step.content));
    expect(plan.every((step) => step.priority === 'medium')).toBe(true);
    // never a member's letter, never what a member said
    expect(plan.some((step) => /\b[A-Z]\b/u.test(step.content))).toBe(false);
  }

  const chunk = got(
    updates.find((update) => update.sessionUpdate === 'agent_message_chunk'),
    'the answer',
  );
  const message = got(chunk.content, 'the content of the answer').text;
  // the closing line is a link to the round, alone on the last line; the round's name is in its address
  const closing =
    /\n\n\[Open in Divan\]\(http:\/\/127\.0\.0\.1:\d+\/open\/[\w-]+\?round=([0-9a-f-]{36})\.(c_[0-9a-f]+)\)$/u.exec(
      message,
    );
  expect(closing, 'the answer ends with the closing line of a round').not.toBeNull();
  expect(message).not.toMatch(/Dio Divan:|ref:/u);
  const meter = got(
    updates.find((update) => update.sessionUpdate === 'usage_update'),
    'the meter',
  );
  expect(meter.size).toBe(0);
  expect(Number.isSafeInteger(meter.used) && (meter.used as number) > 0).toBe(true);
  return {
    reply,
    kinds,
    plans,
    thoughts,
    message,
    used: meter.used,
    ref: {
      sessionId: got(closing?.[1], 'the session of the ref'),
      chairId: got(closing?.[2], 'the round of the ref'),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the server keeps.

const session = (id: string): Session =>
  JSON.parse(readFileSync(join(home, 'sessions', `${id}.json`), 'utf8')) as Session;
const chairsOf = (made: Session): ChairNode[] =>
  Object.values(made.nodes).filter((node): node is ChairNode => node.kind === 'chair');
const chairOf = (id: string, chairId: string): ChairNode =>
  got(
    chairsOf(session(id)).find((chair) => chair.id === chairId),
    `round ${chairId}`,
  );
const threads = (): Record<string, ThreadRecord> =>
  (
    JSON.parse(readFileSync(join(home, 'threads.json'), 'utf8')) as {
      threads: Record<string, ThreadRecord>;
    }
  ).threads;

async function until(done: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(50);
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

/** The regular files under a folder, with their text (not a socket such as the lock's `server.sock`, which cannot be read). */
function filesUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(path);
    return entry.isFile() ? [{ path, text: readFileSync(path, 'utf8') }] : [];
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'divan-acp-home-'));
  probeDir = mkdtempSync(join(tmpdir(), 'divan-acp-probe-'));
  project = mkdtempSync(join(tmpdir(), 'divan-acp-project-'));
  scratch = mkdtempSync(join(tmpdir(), 'divan-acp-scratch-'));
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({ version: 2, port: await freePort(), profiles: {} }),
  );
  // a module every node process of the tree loads first: it writes down which T3 variables the process can see
  writeFileSync(
    join(scratch, 'probe.mjs'),
    `import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.DIVAN_PROBE_DIR;
if (dir) {
  const leaked = Object.keys(process.env).filter((key) => key.toUpperCase().startsWith('T3_ACP_') || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE');
  writeFileSync(join(dir, process.pid + '.json'), JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), leaked }));
}
`,
  );
});

afterEach(() => {
  for (const bridge of bridges) expect(bridge.problems).toEqual([]);
});

afterAll(async () => {
  for (const bridge of bridges) {
    if (bridge.child.exitCode === null && bridge.child.pid) await killTree(bridge.child.pid);
  }
  // the server was started by the launcher and is nobody's child: it is stopped by its pid
  const state = readServerState(home);
  if (state) await killTree(state.pid);
  for (const dir of [home, probeDir, project, scratch]) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

const QUESTION = 'Should I move to Lisbon or to Porto?';
const FOLLOW_UP = 'And what if I wait a year?';
const THIRD = 'What about Porto, then?';
const BRANCH = 'What if I went to Faro instead?';
const REBUILD = 'Now answer quickly: rent or buy?';

/** What the tests pass on to each other, in the order a user would do these things. */
const flow: {
  a?: Bridge;
  sidA?: string;
  first?: Answered;
  second?: Answered;
  third?: Answered;
  fork?: Answered;
  lowered?: Answered;
  cancelled?: { sessionId: string; chairId: string };
  b?: Bridge;
  c?: Bridge;
  d?: Bridge;
} = {};

describe('the bridge as T3 Code runs it', () => {
  it(
    'answers initialize in the v1 shape, with no info, resume advertised and no loadSession',
    async () => {
      const a = new Bridge();
      flow.a = a;
      // T3's request is a hybrid of the v1 and v2 shapes
      const reply = await a.call('initialize', {
        protocolVersion: 2,
        info: { name: 't3-code', version: '1.0.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 't3-code', version: '1.0.0' },
      });
      expect(reply.id).toBe(2 ** 32);
      const result = got(reply.result, 'the result');
      expect(result.protocolVersion).toBe(1);
      expect('info' in result).toBe(false);
      const capabilities = result.agentCapabilities as {
        loadSession: boolean;
        sessionCapabilities: { resume?: unknown };
      };
      expect(capabilities.loadSession).toBe(false);
      expect(capabilities.sessionCapabilities.resume).toEqual({});
      expect(result.agentInfo).toMatchObject({ name: 'dio-divan', title: 'Divan' });
      expect(result.authMethods).toEqual([]);
    },
    LONG,
  );

  it(
    'makes a session and offers the councils and the levels, and starts nothing',
    async () => {
      const a = got(flow.a, 'the bridge');
      const made = await a.call('session/new', {
        cwd: project,
        // T3 offers its own tools here with a credential in a header; the bridge ignores them
        mcpServers: [
          {
            type: 'http',
            name: 't3',
            url: 'http://127.0.0.1:9/mcp',
            headers: [{ name: 'Authorization', value: `Bearer ${SECRET}` }],
          },
        ],
      });
      const result = got(made.result, 'the result');
      const sessionId = result.sessionId as string;
      flow.sidA = sessionId;
      expect(sessionId).toMatch(/^dv_[0-9a-f-]{36}$/u);
      const options = result.configOptions as Option[];
      const model = got(
        options.find((option) => option.id === 'model'),
        'the model option',
      );
      expect(model.category).toBe('model');
      expect(model.currentValue).toBe('d1-default');
      expect(model.options.map((option) => option.value)).toEqual(['d1-default', 'd1-quick']);
      const effort = got(
        options.find((option) => option.id === 'effort'),
        'the effort option',
      );
      expect(effort.category).toBe('thought_level');
      expect(effort.currentValue).toBe('medium');
      expect(effort.options.map((option) => option.value)).toEqual([
        'low',
        'medium',
        'high',
        'max',
      ]);
    },
    LONG,
  );

  it(
    'changes the council and the level by set_config_option, and refuses what it does not know',
    async () => {
      const a = got(flow.a, 'the bridge');
      const sessionId = got(flow.sidA, 'the session');
      const level = (reply: Rpc) =>
        (got(reply.result, 'the result').configOptions as Option[]).map(
          (option) => option.currentValue,
        );
      // until the level is chosen, it follows the council: quick is a low-level council
      expect(
        level(
          await a.call('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: 'd1-quick',
          }),
        ),
      ).toEqual(['d1-quick', 'low']);
      expect(
        level(
          await a.call('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: 'd1-default',
          }),
        ),
      ).toEqual(['d1-default', 'medium']);
      // once it is chosen, it stays
      await a.call('session/set_config_option', { sessionId, configId: 'effort', value: 'max' });
      expect(
        level(
          await a.call('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: 'd1-quick',
          }),
        ),
      ).toEqual(['d1-quick', 'max']);
      await a.call('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'd1-default',
      });
      expect(
        level(
          await a.call('session/set_config_option', {
            sessionId,
            configId: 'effort',
            value: 'medium',
          }),
        ),
      ).toEqual(['d1-default', 'medium']);
      for (const params of [
        { sessionId, configId: 'model', value: 'd1-nowhere' },
        { sessionId, configId: 'effort', value: 'extreme' },
        { sessionId, configId: 'mode', value: 'x' },
        { sessionId: 'dv_unknown', configId: 'effort', value: 'low' },
      ]) {
        const refused = await a.call('session/set_config_option', params);
        expect(refused.error?.code, JSON.stringify(params)).toBe(-32602);
      }
      // an unknown method is the protocol's own error
      expect((await a.call('session/fork', { sessionId })).error?.code).toBe(-32601);
      // nothing so far touched Divan: no server, nothing written in its home
      expect(existsSync(join(home, 'server.json'))).toBe(false);
      expect(readdirSync(home)).toEqual(['settings.json']);
    },
    LONG,
  );

  it(
    'the first prompt, in T3’s wrappers, starts Divan and gets the checklist, the answer and the meter',
    async () => {
      const a = got(flow.a, 'the bridge');
      const sessionId = got(flow.sidA, 'the session');
      const first = await ask(a, sessionId, firstPrompt(QUESTION));
      flow.first = first;

      // the server was started by the launcher, and it answers
      const state = got(readServerState(home), 'server.json');
      expect(await serverHealthy(state)).toBe(true);

      // what the council was asked is the user's own text, from a client that names itself
      const made = session(first.ref.sessionId);
      expect(made.settings.question).toBe(QUESTION);
      expect((made.nodes[made.rootId] as { text: string }).text).toBe(QUESTION);
      expect(made.origin).toMatchObject({
        kind: 'api',
        profileId: 'default',
        profileLevel: 'medium',
      });
      expect(made.origin?.client).toContain('t3');
      expect(made.settings.level).toBe('medium');
      expect(made.settings.cwd?.toLowerCase()).toBe(
        (validateCwd(project) as { path: string }).path.toLowerCase(),
      );
      expect(chairOf(made.id, first.ref.chairId).status).toBe('done');
      // the T3 wrapper and note never reached the council
      expect(JSON.stringify(made.nodes)).not.toContain('t3_code_instructions');
      expect(JSON.stringify(made.nodes)).not.toContain('runtime_info');

      // the thread is the bridge's session id, and its tip is the round that was delivered
      expect(threads()[sessionId]).toMatchObject({
        sessionId: first.ref.sessionId,
        chairId: first.ref.chairId,
        client: 't3-code',
        profileId: 'default',
        level: 'medium',
      });
    },
    LONG,
  );

  it(
    'a second prompt goes on in the same Divan session, from the round before',
    async () => {
      const a = got(flow.a, 'the bridge');
      const first = got(flow.first, 'the first answer');
      const second = await ask(a, got(flow.sidA, 'the session'), laterPrompt(FOLLOW_UP));
      flow.second = second;
      expect(second.ref.sessionId).toBe(first.ref.sessionId);
      expect(second.ref.chairId).not.toBe(first.ref.chairId);
      const made = session(second.ref.sessionId);
      expect(chairsOf(made)).toHaveLength(2);
      const chair = chairOf(made.id, second.ref.chairId);
      const input = made.nodes[chair.parentId as string] as {
        text: string;
        parentId: string | null;
      };
      expect(input.text).toBe(FOLLOW_UP);
      expect(input.parentId).toBe(first.ref.chairId);
    },
    LONG,
  );

  it(
    'a bridge killed with its whole process tree, as T3 does, leaves the server running',
    async () => {
      const a = got(flow.a, 'the bridge');
      await killTree(got(a.child.pid, 'the pid of the bridge'));
      await a.exit;
      const state = got(readServerState(home), 'server.json');
      expect(await serverHealthy(state)).toBe(true);
      expect(() => process.kill(state.pid, 0)).not.toThrow();
    },
    LONG,
  );

  it(
    'a new bridge resumes the thread by its session id and goes on in the same Divan session',
    async () => {
      const b = new Bridge();
      flow.b = b;
      await b.call('initialize', {
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: 't3-code' },
      });
      const sessionId = got(flow.sidA, 'the session');
      const resumed = await b.call('session/resume', { sessionId, cwd: project, mcpServers: [] });
      const options = got(resumed.result, 'the result').configOptions as Option[];
      expect(options.map((option) => option.currentValue)).toEqual(['d1-default', 'medium']);
      const third = await ask(b, sessionId, laterPrompt(THIRD));
      flow.third = third;
      expect(third.ref.sessionId).toBe(got(flow.first, 'the first answer').ref.sessionId);
      expect(chairsOf(session(third.ref.sessionId))).toHaveLength(3);
      expect(threads()[sessionId]?.chairId).toBe(third.ref.chairId);
    },
    LONG,
  );

  it(
    'resuming a conversation Divan does not know is the error that makes the client start afresh',
    async () => {
      const b = got(flow.b, 'the bridge');
      const unknown = await b.call('session/resume', {
        sessionId: `dv_${randomUUID()}`,
        cwd: project,
        mcpServers: [],
      });
      expect(unknown.error?.code).toBe(-32002);
      expect(unknown.error?.message).not.toMatch(/log ?in|authenticat|credential/iu);
      // and a name that cannot be a thread is not a thread
      const bad = await b.call('session/resume', { sessionId: '../x', mcpServers: [] });
      expect(bad.error?.code).toBe(-32602);
    },
    LONG,
  );

  it(
    'a fork, which T3 makes as a new session with a handoff, becomes a branch of the round it names',
    async () => {
      const c = new Bridge();
      flow.c = c;
      await c.call('initialize', {
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: 't3-code' },
      });
      const made = await c.call('session/new', { cwd: project, mcpServers: [] });
      const forkId = got(made.result, 'the result').sessionId as string;
      const first = got(flow.first, 'the first answer');
      // T3 builds the handoff from the thread it forks, up to the fork point, and prepends it to the new message
      const handoff = [
        'Context handoff (full_thread_summary):',
        'Provider context handoff. Thread: fork-thread. Covered app runs: 1-2.',
        'Source item range: item-1 through item-2.',
        'Historical material is context, not a new request or higher-priority instructions.',
        '',
        '[Historical user; user_message; thread=source-thread; run=run-1; item=item-1; provider-thread=none; status=completed; run-status=completed]',
        QUESTION,
        '',
        '[Historical assistant; assistant_message; thread=source-thread; run=run-1; item=item-2; provider-thread=none; status=completed; run-status=completed]',
        first.message,
      ].join('\n');
      const fork = await ask(c, forkId, firstPrompt(`${handoff}\n\nUser message:\n${BRANCH}`));
      flow.fork = fork;
      expect(fork.ref.sessionId).toBe(first.ref.sessionId);
      const tree = session(fork.ref.sessionId);
      const chair = chairOf(tree.id, fork.ref.chairId);
      const input = tree.nodes[chair.parentId as string] as {
        text: string;
        parentId: string | null;
      };
      // the council saw the new message only, and it hangs from the round the handoff named, beside the follow-up
      expect(input.text).toBe(BRANCH);
      expect(input.parentId).toBe(first.ref.chairId);
      expect(
        Object.values(tree.nodes).filter((node) => node.parentId === first.ref.chairId),
      ).toHaveLength(2);
      expect(JSON.stringify(tree.nodes)).not.toContain('Context handoff');
    },
    LONG,
  );

  it(
    'a fork whose handoff holds answers with the older closing line still becomes a branch of the round it names',
    async () => {
      const c = got(flow.c, 'the bridge');
      const made = await c.call('session/new', { cwd: project, mcpServers: [] });
      const olderId = got(made.result, 'the result').sessionId as string;
      const first = got(flow.first, 'the first answer');
      // what the earlier versions wrote: the address, then the round's name as text
      const older = first.message.replace(
        /\n\n\[[^\]]*\]\((\S+?)\?round=(\S+?)\)$/u,
        '\n\nDio Divan: $1 ref:$2',
      );
      expect(older, 'the closing link was rewritten').not.toBe(first.message);
      expect(older).toContain(` ref:${first.ref.sessionId}.${first.ref.chairId}`);
      const handoff = [
        'Context handoff (full_thread_summary):',
        'Provider context handoff. Thread: older-fork. Covered app runs: 1-2.',
        '',
        '[Historical user; user_message; thread=source-thread; run=run-1; item=item-1; provider-thread=none; status=completed; run-status=completed]',
        QUESTION,
        '',
        '[Historical assistant; assistant_message; thread=source-thread; run=run-1; item=item-2; provider-thread=none; status=completed; run-status=completed]',
        older,
      ].join('\n');
      const asked = 'What if I went to Braga instead?';
      const fork = await ask(c, olderId, firstPrompt(`${handoff}\n\nUser message:\n${asked}`));
      expect(fork.ref.sessionId).toBe(first.ref.sessionId);
      const tree = session(fork.ref.sessionId);
      const input = tree.nodes[chairOf(tree.id, fork.ref.chairId).parentId as string] as {
        text: string;
        parentId: string | null;
      };
      expect(input.text).toBe(asked);
      expect(input.parentId).toBe(first.ref.chairId);
    },
    LONG,
  );

  it(
    'another level on the same thread is a new Divan session that carries the conversation as its background',
    async () => {
      const c = got(flow.c, 'the bridge');
      const forkId = got(
        Object.entries(threads()).find(
          ([, record]) => record.chairId === got(flow.fork, 'the fork').ref.chairId,
        )?.[0],
        'the fork thread',
      );
      const set = await c.call('session/set_config_option', {
        sessionId: forkId,
        configId: 'effort',
        value: 'low',
      });
      const options = got(set.result, 'the result').configOptions as Option[];
      expect(options.map((option) => option.currentValue)).toEqual(['d1-default', 'low']);
      const lowered = await ask(c, forkId, laterPrompt(REBUILD));
      flow.lowered = lowered;
      const before = got(flow.first, 'the first answer');
      expect(lowered.ref.sessionId).not.toBe(before.ref.sessionId);
      const made = session(lowered.ref.sessionId);
      expect(made.settings.level).toBe('low');
      expect(made.origin?.profileLevel).toBe('low');
      expect(made.settings.question).toBe(REBUILD);
      expect(chairsOf(made)).toHaveLength(1);
      // the new session was given the conversation up to the fork's tip
      expect(made.background).toContain(QUESTION);
      expect(made.background).toContain(BRANCH);
      expect(threads()[forkId]).toMatchObject({
        sessionId: made.id,
        chairId: lowered.ref.chairId,
        level: 'low',
      });
    },
    LONG,
  );

  it(
    'a cancel is answered at once, once, and the round ends cancelled; "Continue where you left off." runs it again',
    async () => {
      const d = new Bridge();
      flow.d = d;
      await d.call('initialize', {
        protocolVersion: 2,
        clientCapabilities: {},
        clientInfo: { name: 't3-code' },
      });
      const made = await d.call('session/new', { cwd: project, mcpServers: [] });
      const sessionId = got(made.result, 'the result').sessionId as string;

      const from = d.messages.length;
      const pending = d.call('session/prompt', {
        sessionId,
        prompt: firstPrompt('Should I sell the flat?'),
      });
      // the round is admitted and its checklist has arrived; the members are still working
      await d.waitFor(
        (message) => message.params?.update?.sessionUpdate === 'plan',
        from,
        60_000,
        'the first checklist',
      );
      const cancelledAt = Date.now();
      d.notify('session/cancel', { sessionId });
      const reply = await pending;
      expect(Date.now() - cancelledAt, 'T3 waits ten seconds at most').toBeLessThan(2_000);
      expect(reply.error).toBeUndefined();
      expect(reply.result).toEqual({ stopReason: 'cancelled' });

      // nothing more is said for that prompt, and the answer is not given twice (the server's end of the stream is gone)
      const after = d.messages.length;
      await sleep(1_500);
      expect(d.messages).toHaveLength(after);

      // on the server the round ends cancelled, and the thread's tip stays where it was (nowhere: nothing was delivered)
      const record = got(threads()[sessionId], 'the record of the thread');
      const last = got(record.last, 'the last round of the thread');
      flow.cancelled = last;
      expect(record.chairId).toBeNull();
      await until(
        () => chairOf(last.sessionId, last.chairId).status === 'cancelled',
        'the round to end cancelled',
      );
      expect(threads()[sessionId]?.chairId).toBeNull();

      // T3's resume button runs the same round again
      const again = await ask(d, sessionId, laterPrompt('Continue where you left off.'));
      expect(again.ref).toEqual(last);
      expect(chairOf(last.sessionId, last.chairId).status).toBe('done');
      expect(chairsOf(session(last.sessionId))).toHaveLength(1);
      expect(threads()[sessionId]?.chairId).toBe(last.chairId);
    },
    LONG,
  );

  it(
    'ends by itself when the client closes stdin, with nothing left unsaid',
    async () => {
      for (const name of ['b', 'c', 'd'] as const) {
        const bridge = got(flow[name], `bridge ${name}`);
        expect(await bridge.close(), name).toBe(0);
        expect(bridge.stderr, name).not.toContain(SECRET);
      }
    },
    LONG,
  );

  it(
    'keeps T3’s credential to the bridge: the launcher and the server never had it, and nothing holds it',
    async () => {
      const records = readdirSync(probeDir).map(
        (name) =>
          JSON.parse(readFileSync(join(probeDir, name), 'utf8')) as {
            pid: number;
            argv: string[];
            leaked: string[];
          },
      );
      const bridgePids = new Set(bridges.map((bridge) => bridge.child.pid));
      const server = got(readServerState(home), 'server.json');
      // the control: the bridges did have the credential in their environment
      const ofBridges = records.filter((record) => bridgePids.has(record.pid));
      expect(ofBridges).toHaveLength(bridges.length);
      for (const record of ofBridges) {
        expect(record.leaked.map((name) => name.toUpperCase()).sort()).toEqual([
          'ELECTRON_RUN_AS_NODE',
          'T3_ACP_MCP_AUTHORIZATION',
          'T3_ACP_MCP_ENDPOINT',
          'T3_ACP_MCP_ENTRYPOINT',
          'T3_ACP_MCP_NODE',
        ]);
      }
      // everything else the bridge started: the launcher, and the server it left running
      const others = records.filter((record) => !bridgePids.has(record.pid));
      expect(
        others.some((record) => record.argv[0] === 'start'),
        'the launcher ran',
      ).toBe(true);
      expect(
        others.some((record) => record.pid === server.pid),
        'the server ran',
      ).toBe(true);
      for (const record of others)
        expect(record.leaked, `process ${record.pid} ${record.argv.join(' ')}`).toEqual([]);

      // and the credential itself is nowhere on disk or on a pipe
      for (const file of filesUnder(home)) expect(file.text, file.path).not.toContain(SECRET);
      for (const bridge of bridges) {
        expect(bridge.stdout).not.toContain(SECRET);
        expect(bridge.stderr).not.toContain(SECRET);
      }
    },
    LONG,
  );
});

describe('a flow through the ACP bridge', () => {
  it(
    'lists a flow profile, emits distinct steps in deterministic order and counts all calls',
    async () => {
      const bridge = new Bridge();
      await bridge.call('initialize', { protocolVersion: 1, clientCapabilities: {} });
      const created = got(
        (await bridge.call('session/new', { cwd: project, mcpServers: [] })).result,
        'the new bridge session',
      );
      const sessionId = created.sessionId;
      // Starting the first turn starts the fake server through the bridge's ordinary launcher.
      await bridge.call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Start the fake server.' }],
      });
      const state = got(readServerState(home), 'the running fake server');
      const web = async (path: string, method: string, body: unknown) => {
        const reply = await fetch(`http://127.0.0.1:${state.port}/api${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-divan-token': state.token },
          body: JSON.stringify(body),
        });
        expect(reply.status).toBeLessThan(300);
        return reply.json();
      };
      const made = (await web('/profiles', 'POST', { name: 'ACP flow' })) as { id: string };
      const graph = writerFlow();
      graph.nodes.reverse();
      graph.edges.reverse();
      await web(`/profiles/${made.id}`, 'PUT', { flow: graph });
      const selected = got(
        (
          await bridge.call('session/set_config_option', {
            sessionId,
            configId: 'model',
            value: `d1-${made.id}`,
          })
        ).result,
        'the model option',
      );
      expect(
        requireValue(
          (selected.configOptions as Option[]).find((option) => option.id === 'model'),
        ).options.map((option) => option.value),
      ).toContain(`d1-${made.id}`);
      const start = bridge.messages.length;
      const reply = await bridge.call('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Inspect the source without leaking the draft.' }],
      });
      expect(reply.result).toMatchObject({ stopReason: 'end_turn' });
      const updates = bridge.messages
        .slice(start)
        .flatMap((message) => (message.params?.update ? [message.params.update] : []));
      const plans = updates.flatMap((update) =>
        update.sessionUpdate === 'plan' ? [requireValue(update.entries)] : [],
      );
      const first = got(plans[0], 'the initial flow plan');
      expect(first.map((step) => step.content.split(' · ')[0])).toEqual([
        'Writer',
        'Critic 1',
        'Critic 2',
        'Critic 3',
        'Rewriter',
      ]);
      expect(new Set(first.map((step) => step.content)).size).toBe(5);
      expect(requireValue(plans.at(-1)).every((step) => step.status === 'completed')).toBe(true);
      for (const plan of plans)
        expect(plan.map((step) => step.content)).toEqual(first.map((step) => step.content));
      for (const update of updates.filter((item) => item.sessionUpdate === 'agent_thought_chunk'))
        expect(requireValue(update.content).text).not.toMatch(
          /Member [A-Z]|Findings|recommendation/u,
        );
      const message = requireValue(
        requireValue(updates.find((update) => update.sessionUpdate === 'agent_message_chunk'))
          .content,
      ).text;
      const ref = requireValue(/\?round=([\w-]+)\.(c_[\w]+)\)/u.exec(message));
      const chair = chairOf(requireValue(ref[1]), requireValue(ref[2]));
      expect(chair.steps).toHaveLength(5);
      expect(chair.attempts).toHaveLength(5);
      expect(
        requireValue(updates.find((update) => update.sessionUpdate === 'usage_update')).used,
      ).toBe(chair.usage.total);
      expect(bridge.problems).toEqual([]);
      await bridge.close();
    },
    LONG,
  );
});
