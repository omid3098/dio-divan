// The ACP bridge (src/server/acp.ts). The pure parts first: the text of a prompt, a fork's handoff, and the options a client
// shows, the options checked against the protocol's own JSON Schema. Then the bridge as a client runs it, a `node` process on
// stdin and stdout, against a stand-in for Divan's `/v1/divan/threads` routes: every message it writes is checked against the
// schema, stdout is checked to carry nothing but protocol lines, and a prompt is checked to be answered exactly once. No
// harness is called and the real Divan home is never touched.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ConfigOption, configOptions, promptText, splitHandoff } from '../src/server/acp.ts';
import type { ProfileEntry } from '../src/server/launch.ts';

const root = join(import.meta.dirname, '..');
const ACP = join(root, 'src', 'server', 'acp.ts');

// ---------------------------------------------------------------------------------------------------------------------
// The protocol's schema.

const ajv = new Ajv2020({ strict: false, validateFormats: false, discriminator: true });
ajv.addSchema(
  JSON.parse(
    readFileSync(
      join(root, 'node_modules', '@agentclientprotocol', 'sdk', 'schema', 'schema.json'),
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

const text = (value: string) => ({ type: 'text', text: value });
const REF_A = '0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01.c_1a2b3c';
const REF_B = '0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01.c_4d5e6f';
// the closing line of an answer: a link that names its round in its address, and the line of the older versions
const closing = (ref: string, label = 'Open in Divan') =>
  `[${label}](http://127.0.0.1:47321/open/ticket?round=${ref})`;
const olderClosing = (ref: string) => `Dio Divan: http://127.0.0.1:47321/open/ticket ref:${ref}`;

describe('promptText', () => {
  const runtime = text(
    "<runtime_info>In case you're asked: you are running in T3 Code through the acpRegistry harness, as d1-default.</runtime_info>\n\n<pull_request_linking>Do not.</pull_request_linking>",
  );

  it('takes the user request out of the wrapper of a first prompt and drops the note about the client', () => {
    const first = text(
      '<t3_code_instructions>\n## T3 Code interaction mode: Default\nBe brief.\n</t3_code_instructions>\n\n<user_request>\nShould I move to Lisbon?\nOr to Porto?\n</user_request>',
    );
    expect(promptText([first, runtime])).toBe('Should I move to Lisbon?\nOr to Porto?');
  });

  it('leaves a plain later turn as it is, only trimmed', () => {
    expect(promptText([text('  And in a year?\n'), runtime])).toBe('And in a year?');
  });

  it('lets a /command through unchanged', () => {
    expect(promptText([text('/review the plan so far'), runtime])).toBe('/review the plan so far');
  });

  it('keeps tags that the user wrote inside the request, and a message that only talks about the wrapper', () => {
    const inner = 'Why does a prompt end with </user_request> and <user_request>?';
    expect(
      promptText([
        text(
          `<t3_code_instructions>\nrules\n</t3_code_instructions>\n\n<user_request>\n${inner}\n</user_request>`,
        ),
      ]),
    ).toBe(inner);
    expect(promptText([text(`Explain this: ${inner}`)])).toBe(`Explain this: ${inner}`);
  });

  it('takes the instructions off even when there is no request tag, and reads text blocks only', () => {
    expect(
      promptText([
        text('<t3_code_instructions>\nrules\n</t3_code_instructions>\n\nHello'),
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'resource_link', name: 'a', uri: 'file:///a' },
      ]),
    ).toBe('Hello');
  });

  it('joins several text blocks with a blank line, and an empty or odd prompt is empty', () => {
    expect(promptText([text('One'), text('Two')])).toBe('One\n\nTwo');
    expect(promptText([runtime])).toBe('');
    expect(promptText(undefined)).toBe('');
    expect(promptText('text')).toBe('');
    expect(promptText([null, 3, { type: 'text' }])).toBe('');
  });
});

describe('splitHandoff', () => {
  const header =
    'Context handoff (full_thread_summary):\nProvider context handoff. Thread: fork-1. Covered app runs: 1-2.';
  const user = '[Historical user; user_message; thread=src-1; run=r1; item=i1]\nWhat should I do?';
  const assistant = (ref: string, body: string) =>
    `[Historical assistant; assistant_message; thread=src-1; run=r1; item=i2]\n${body}\n\n${closing(ref)}`;

  it('takes the last round the handoff names as where a fork continues', () => {
    const handoff = [
      header,
      user,
      assistant(REF_A, 'First answer.'),
      assistant(REF_B, 'Second.'),
    ].join('\n\n');
    const split = splitHandoff(`${handoff}\n\nUser message:\nAnd if I wait a year?`);
    expect(split).toEqual({
      message: 'And if I wait a year?',
      from: {
        sessionId: '0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01',
        chairId: 'c_4d5e6f',
      },
      // the handoff goes along too: the server reads it only if that round no longer exists
      background: handoff,
    });
  });

  it('finds the round in the older closing line too, and in a Persian link', () => {
    const body = (line: string) =>
      `${header}\n\n${user}\n\n[Historical assistant]\nAnswer.\n\n${line}`;
    const ask = '\n\nUser message:\nNext';
    expect(splitHandoff(body(olderClosing(REF_A)) + ask).from?.chairId).toBe('c_1a2b3c');
    expect(splitHandoff(body(closing(REF_B, 'باز کردن در دیوان')) + ask).from?.chairId).toBe(
      'c_4d5e6f',
    );
    // the last one counts, whichever form it is in
    const mixed = `${header}\n\n${olderClosing(REF_A)}\n\n${closing(REF_B)}\n\n${olderClosing(REF_A)}`;
    expect(splitHandoff(mixed + ask).from?.chairId).toBe('c_1a2b3c');
  });

  it('keeps a handoff that names no round as the background', () => {
    const handoff = [
      header,
      user,
      '[Historical assistant; assistant_message; thread=src-1]\nHi.',
    ].join('\n\n');
    const split = splitHandoff(`${handoff}\n\nUser message:\nContinue.`);
    expect(split.message).toBe('Continue.');
    expect(split.from).toBeNull();
    expect(split.background).toBe(handoff);
  });

  it('splits at the last "User message:", so a history that has the words does not cut the message', () => {
    const handoff = `${header}\n\n[Historical user]\nUser message:\nold\n\n${assistant(REF_A, 'x')}`;
    const split = splitHandoff(`${handoff}\n\nUser message:\nNew one`);
    expect(split.message).toBe('New one');
    expect(split.from?.chairId).toBe('c_1a2b3c');
    expect(split.background).toBe(handoff);
  });

  it('is not fooled by text that is no handoff', () => {
    expect(splitHandoff('  Plain question  ')).toEqual({
      message: 'Plain question',
      from: null,
      background: null,
    });
    const quoted = `Please read this:\n${header}\n\nUser message:\nhello`;
    expect(splitHandoff(quoted).message).toBe(quoted);
    // a handoff with no message after it is no handoff either
    expect(splitHandoff(header).from).toBeNull();
    expect(splitHandoff(header).background).toBeNull();
  });
});

describe('configOptions', () => {
  const profiles: ProfileEntry[] = [
    { id: 'default', label: 'default', defaultLevel: 'medium' },
    { id: 'quick', label: 'quick', defaultLevel: 'low' },
    { id: 'deep', label: 'Deep think', defaultLevel: 'max' },
  ];

  it('validates against the official schema, one by one and as the answer of the methods', () => {
    const options = configOptions({ profile: 'default', level: 'medium' }, profiles);
    for (const option of options) expect(validate('SessionConfigOption', option)).toBe(true);
    expect(validate('NewSessionResponse', { sessionId: 'dv_x', configOptions: options })).toBe(
      true,
    );
    expect(validate('SetSessionConfigOptionResponse', { configOptions: options })).toBe(true);
    expect(validate('ResumeSessionResponse', { configOptions: options })).toBe(true);
    // the check is not a rubber stamp
    expect(validate('SessionConfigOption', { ...options[0], currentValue: 5 })).not.toBe(true);
  });

  it('offers the councils as d1- models and the four levels as the reasoning effort', () => {
    const [model, effort] = configOptions({ profile: 'quick', level: 'high' }, profiles) as [
      ConfigOption,
      ConfigOption,
    ];
    expect(model).toMatchObject({
      id: 'model',
      category: 'model',
      type: 'select',
      currentValue: 'd1-quick',
    });
    expect(model.options).toEqual([
      { value: 'd1-default', name: 'd1-default' },
      { value: 'd1-quick', name: 'd1-quick' },
      { value: 'd1-deep', name: 'd1-Deep think' },
    ]);
    // the client never applies these two values as a model
    expect(model.options.map((option) => option.value)).not.toContain('default');
    expect(model.options.map((option) => option.value)).not.toContain('auto');
    expect(effort).toMatchObject({
      id: 'effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'high',
    });
    expect(effort.options.map((option) => option.value)).toEqual(['low', 'medium', 'high', 'max']);
  });

  it('keeps the conversation’s own council in the list when it is no longer a profile', () => {
    const [model] = configOptions({ profile: 'gone', level: 'low' }, profiles) as [ConfigOption];
    expect(model.currentValue).toBe('d1-gone');
    expect(model.options.map((option) => option.value)).toContain('d1-gone');
    expect(validate('SessionConfigOption', model)).toBe(true);
  });

  it('reads the profiles from Divan’s settings.json when it is not given any', () => {
    const home = mkdtempSync(join(tmpdir(), 'divan-acp-opts-'));
    const before = process.env.DIVAN_HOME;
    try {
      writeFileSync(
        join(home, 'settings.json'),
        JSON.stringify({ profiles: { night: { name: 'Night', defaultLevel: 'high' } } }),
      );
      process.env.DIVAN_HOME = home;
      const [model] = configOptions({ profile: 'default', level: 'medium' }) as [ConfigOption];
      expect(model.options.map((option) => option.value)).toEqual([
        'd1-default',
        'd1-quick',
        'd1-night',
      ]);
    } finally {
      if (before === undefined) delete process.env.DIVAN_HOME;
      else process.env.DIVAN_HOME = before;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The bridge as a process, against a stand-in for the server.

type Json = Record<string, unknown>;
interface Msg {
  id?: number | string | null;
  method?: string;
  params?: { sessionId?: string; update?: Json & { sessionUpdate: string } };
  result?: Json;
  error?: { code: number; message: string };
}
interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Json | null;
}
/** A turn the stand-in is asked for: write the response, and learn whether the client hung up before it ended. */
interface Turn {
  res: ServerResponse;
  body: Json;
  hungUp: Promise<boolean>;
}

const KEY = 'k'.repeat(32);
const TOKEN = 'web-token';
const T3_SECRET = 'secret-t3-credential-must-not-travel';
const ID_BASE = 4294967296;
const line = (event: Json) => `${JSON.stringify(event)}\n`;

let stand: Server;
let standPort = 0;
let home: string;
let seen: Seen[] = [];
let onTurn: (turn: Turn) => void;
let onThread: (res: ServerResponse) => void;
const bridges: Bridge[] = [];

/** One `divan acp` process, spoken to the way T3 Code speaks to it. */
class Bridge {
  readonly child: ChildProcess;
  readonly stdout: string[] = [];
  readonly messages: Msg[] = [];
  errors = '';
  exited: Promise<number | null>;
  private serial = ID_BASE;
  private listeners = new Set<() => void>();
  private buffer = '';

  constructor(env: Record<string, string> = {}, extraScript = '') {
    const url = pathToFileURL(ACP).href;
    this.child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        '--input-type=module',
        '-e',
        `const { runAcp } = await import(${JSON.stringify(url)}); const running = runAcp(); ${extraScript} await running;`,
      ],
      {
        // DIVAN_FAKE: a launch that went wrong could never start real harnesses (the home's settings.json also names the
        // stand-in's own port, so such a launch fails at once with a busy port)
        env: {
          ...process.env,
          DIVAN_HOME: home,
          DIVAN_FAKE: '1',
          T3_ACP_MCP_AUTHORIZATION: T3_SECRET,
          ...env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    this.child.stdout?.setEncoding('utf8');
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      this.errors += chunk;
    });
    this.child.stdout?.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (let end = this.buffer.indexOf('\n'); end >= 0; end = this.buffer.indexOf('\n')) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        this.stdout.push(raw);
        this.messages.push(JSON.parse(raw) as Msg);
      }
      for (const listener of this.listeners) listener();
    });
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
    bridges.push(this);
  }

  write(message: Json): void {
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  /** Sends a request and waits for its response (by id). */
  request(method: string, params?: Json): Promise<Msg> {
    const id = this.serial;
    this.serial += 1;
    this.write({ id, method, params });
    return this.until((message) => message.id === id && message.method === undefined);
  }

  /** Sends a request without waiting; the response is `until`-ed by its id. */
  start(method: string, params?: Json): number {
    const id = this.serial;
    this.serial += 1;
    this.write({ id, method, params });
    return id;
  }

  notify(method: string, params?: Json): void {
    this.write({ method, params });
  }

  /** The first message, already here or still to come, that satisfies `test`. */
  until(test: (message: Msg) => boolean, ms = 15_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error(`no such message in time; got ${this.stdout.join(' | ')}`));
      }, ms);
      const check = () => {
        const found = this.messages.find(test);
        if (!found) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        resolve(found);
      };
      this.listeners.add(check);
      check();
    });
  }

  responsesTo(id: number): Msg[] {
    return this.messages.filter((message) => message.id === id && message.method === undefined);
  }

  updatesOf(sessionUpdate: string): Json[] {
    return this.messages.flatMap((message) =>
      message.method === 'session/update' && message.params?.update?.sessionUpdate === sessionUpdate
        ? [message.params.update]
        : [],
    );
  }

  async open(cwd = 'C:\\work\\project'): Promise<{ sessionId: string; options: ConfigOption[] }> {
    await this.request('initialize', { protocolVersion: 2, clientInfo: { name: 't3-code' } });
    const made = await this.request('session/new', {
      cwd,
      mcpServers: [
        { name: 't3-code', command: 'x', args: [], env: [{ name: 'K', value: T3_SECRET }] },
      ],
    });
    const result = made.result as { sessionId: string; configOptions: ConfigOption[] };
    return { sessionId: result.sessionId, options: result.configOptions };
  }

  /** Ends stdin as a client that quits does, and waits for the process to end. */
  async stop(): Promise<number | null> {
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill(), 10_000);
    const code = await this.exited;
    clearTimeout(timer);
    return code;
  }
}

/** The protocol lines the bridge wrote, each one checked: JSON-RPC 2.0, a response or a notification, nothing else. */
function expectCleanStdout(bridge: Bridge): void {
  expect(bridge.stdout.length).toBeGreaterThan(0);
  for (const raw of bridge.stdout) {
    expect(raw, 'a blank line on stdout').not.toBe('');
    const message = JSON.parse(raw) as Json;
    expect(message.jsonrpc).toBe('2.0');
    expect('result' in message || 'error' in message || typeof message.method === 'string').toBe(
      true,
    );
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'divan-acp-home-'));
  writeFileSync(join(home, 'api-key'), `${KEY}\n`);
  stand = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      const entry: Seen = {
        method: req.method ?? '',
        path: url.pathname,
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Json) : null,
      };
      seen.push(entry);
      if (url.pathname === '/api/health') {
        // like the server's own: the pid is how the bridge knows this is the process server.json names
        res
          .writeHead(req.headers['x-divan-token'] === TOKEN ? 200 : 401)
          .end(JSON.stringify({ ok: true, pid: process.pid }));
        return;
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            error: { message: 'Authentication failed: wrong credentials, please log in again.' },
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.pathname.endsWith('/turns')) {
        const hungUp = new Promise<boolean>((resolve) =>
          res.on('close', () => resolve(!res.writableEnded)),
        );
        onTurn({ res, body: entry.body as Json, hungUp });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/v1/divan/threads/')) {
        onThread(res);
        return;
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => stand.listen(0, '127.0.0.1', resolve));
  standPort = (stand.address() as AddressInfo).port;
  // The home names the stand-in's own port as the server's port: if the bridge ever launched a server of its own (the
  // stand-in was slow to answer a health check), that server could not take the port and would fail at once.
  writeFileSync(
    join(home, 'settings.json'),
    JSON.stringify({
      port: standPort,
      profiles: {
        sprint: { name: 'Sprint', base: 'quick' },
        'Bad Id': { name: 'Nope' },
      },
    }),
  );
  writeFileSync(
    join(home, 'server.json'),
    JSON.stringify({
      pid: process.pid,
      port: standPort,
      token: TOKEN,
      url: `http://127.0.0.1:${standPort}/`,
    }),
  );
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    stand.closeAllConnections();
    stand.close(() => resolve());
  });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  // by default a round is admitted and answers
  onTurn = answerTurn;
  onThread = (res) => {
    res
      .writeHead(404, { 'content-type': 'application/json' })
      .end('{"error":{"message":"no thread"}}');
  };
});

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    bridge.child.stdin?.end();
    const timer = setTimeout(() => bridge.child.kill(), 5000);
    await bridge.exited;
    clearTimeout(timer);
  }
});

describe('the bridge process: the handshake', () => {
  it('answers initialize in the v1 shape with the id exactly as sent, and touches nothing', async () => {
    const before = readdirSync(home).sort();
    const bridge = new Bridge();
    const reply = await bridge.request('initialize', {
      protocolVersion: 2,
      info: { name: 't3-code', version: '0.0.0' },
      clientInfo: { name: 't3-code', version: '0.0.0' },
    });
    expect(reply.id).toBe(ID_BASE);
    expect(validate('InitializeResponse', reply.result)).toBe(true);
    expect(reply.result).toMatchObject({
      protocolVersion: 1,
      agentInfo: { name: 'dio-divan', title: 'Divan' },
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: { resume: {} },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
    });
    expect('info' in (reply.result as Json)).toBe(false);
    expect((reply.result as { agentInfo: { version: string } }).agentInfo.version).toBe(
      (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version,
    );

    const made = await bridge.request('session/new', {
      cwd: 'C:\\work\\project',
      mcpServers: [
        {
          name: 't3-code',
          command: 'node',
          args: ['acp-mcp-bridge'],
          env: [{ name: 'T3_ACP_MCP_AUTHORIZATION', value: T3_SECRET }],
        },
      ],
    });
    expect(validate('NewSessionResponse', made.result)).toBe(true);
    const result = made.result as { sessionId: string; configOptions: ConfigOption[] };
    expect(result.sessionId).toMatch(/^dv_[0-9a-f-]{36}$/u);
    const [model, effort] = result.configOptions as [ConfigOption, ConfigOption];
    expect(model.options.map((option) => option.value)).toEqual([
      'd1-default',
      'd1-quick',
      'd1-sprint',
    ]);
    expect(model.options.map((option) => option.name)).toEqual([
      'd1-default',
      'd1-quick',
      'd1-Sprint',
    ]);
    expect(model.currentValue).toBe('d1-default');
    expect(effort.currentValue).toBe('medium');

    expect((await bridge.request('authenticate', { methodId: 'x' })).result).toEqual({});
    // no server was asked, and nothing was written in the home
    expect(seen).toEqual([]);
    expect(readdirSync(home).sort()).toEqual(before);
    expect(await bridge.stop()).toBe(0);
    expectCleanStdout(bridge);
    expect(bridge.errors).toBe('');
  });

  it('ignores blank lines, responses, notifications it does not know and $/ messages; answers an unknown request', async () => {
    const bridge = new Bridge();
    bridge.child.stdin?.write('\n   \n');
    bridge.write({ id: 99, result: {} });
    bridge.notify('$/cancel_request', { requestId: 1 });
    bridge.notify('notifications/whatever');
    bridge.notify('session/cancel', { sessionId: 'dv_nothing_runs_here' });
    const reply = await bridge.request('session/fork', { sessionId: 'x' });
    expect(reply.error?.code).toBe(-32601);
    const odd = await bridge.request('$/anything');
    expect(odd.error?.code).toBe(-32601);
    // nothing but those two answers was written
    expect(bridge.stdout).toHaveLength(2);
    expect(await bridge.stop()).toBe(0);
  });

  it('keeps what a library prints with console.log off stdout', async () => {
    const bridge = new Bridge(
      {},
      "console.log('NOISE'); console.info('MORE'); console.warn('WARN');",
    );
    await bridge.open();
    await bridge.stop();
    expect(bridge.errors).toContain('NOISE');
    expect(bridge.errors).toContain('WARN');
    expect(bridge.stdout.join('\n')).not.toContain('NOISE');
    expectCleanStdout(bridge);
  });
});

describe('the bridge process: the options', () => {
  it('follows the council’s own level until the level is chosen, then keeps the choice', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const level = async (configId: string, value: string) => {
      const reply = await bridge.request('session/set_config_option', {
        sessionId,
        configId,
        value,
      });
      expect(validate('SetSessionConfigOptionResponse', reply.result)).toBe(true);
      const options = (reply.result as { configOptions: ConfigOption[] }).configOptions;
      expect(options.map((option) => option.id)).toEqual(['model', 'effort']);
      return { model: options[0]?.currentValue, effort: options[1]?.currentValue };
    };
    expect(await level('model', 'd1-quick')).toEqual({ model: 'd1-quick', effort: 'low' });
    expect(await level('model', 'd1-sprint')).toEqual({ model: 'd1-sprint', effort: 'low' });
    expect(await level('model', 'd1-default')).toEqual({ model: 'd1-default', effort: 'medium' });
    expect(await level('effort', 'max')).toEqual({ model: 'd1-default', effort: 'max' });
    // the level was chosen: another council does not move it
    expect(await level('model', 'd1-quick')).toEqual({ model: 'd1-quick', effort: 'max' });
  });

  it('refuses a council, a level, an option or a session it does not know', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const code = async (params: Json) =>
      (await bridge.request('session/set_config_option', params)).error?.code;
    expect(await code({ sessionId, configId: 'model', value: 'd1-nope' })).toBe(-32602);
    expect(await code({ sessionId, configId: 'model', value: 'quick' })).toBe(-32602);
    expect(await code({ sessionId, configId: 'effort', value: 'extreme' })).toBe(-32602);
    expect(await code({ sessionId, configId: 'mode', value: 'x' })).toBe(-32602);
    expect(await code({ sessionId, configId: 'effort', value: 3 })).toBe(-32602);
    expect(await code({ sessionId: 'dv_unknown', configId: 'effort', value: 'low' })).toBe(-32602);
    expect(await code({ configId: 'effort', value: 'low' })).toBe(-32602);
  });
});

describe('the bridge process: a prompt', () => {
  const wrapped = (message: string) => [
    text(
      `<t3_code_instructions>\nrules\n</t3_code_instructions>\n\n<user_request>\n${message}\n</user_request>`,
    ),
    text('<runtime_info>You are running in T3 Code.</runtime_info>'),
  ];

  it('sends the user’s own text and the conversation’s choices, and turns the stream into updates before the answer', async () => {
    onTurn = ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.write(line({ type: 'note', text: 'The folder was not used.' }));
      const plan = (a: string, b: string) => [
        { content: 'Claude Code · opus', status: a },
        { content: 'Chairman · Codex · gpt', status: b },
      ];
      // the second line is cut in the middle, between two writes, and a keep-alive blank line comes between events
      res.write(
        line({ type: 'round', sessionId: 's', chairId: 'c', plan: plan('pending', 'pending') }),
      );
      res.write(line({ type: 'progress', text: 'Claude Code · opus answered after 1m 42s.' }));
      const next = line({ type: 'plan', plan: plan('in_progress', 'pending') });
      res.write(next.slice(0, 20));
      setTimeout(() => {
        res.write(`${next.slice(20)}\n\n`);
        // a line with no text, or with text that is not text, says nothing
        res.write(line({ type: 'progress', text: '' }));
        res.write(line({ type: 'progress', text: 7 }));
        res.write(line({ type: 'progress' }));
        res.write(
          line({
            type: 'progress',
            text: 'All members are in. The chairman (Codex · gpt · max) is reading 1 answers.',
          }),
        );
        res.write(line({ type: 'plan', plan: plan('completed', 'in_progress') }));
        res.write(line({ type: 'unknown-event', anything: true }));
        res.end(
          line({
            type: 'answer',
            sessionId: 's',
            chairId: 'c',
            content: `Stay.\n\n${closing(REF_A)}`,
            usage: { round: 100, session: 250 },
          }),
        );
      }, 50);
    };
    const bridge = new Bridge();
    const { sessionId } = await bridge.open('C:\\work\\project');
    await bridge.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'd1-sprint',
    });
    await bridge.request('session/set_config_option', {
      sessionId,
      configId: 'effort',
      value: 'high',
    });
    const id = bridge.start('session/prompt', { sessionId, prompt: wrapped('Should I stay?') });
    const reply = await bridge.until((message) => message.id === id);
    expect(reply.result).toEqual({ stopReason: 'end_turn' });
    expect(validate('PromptResponse', reply.result)).toBe(true);

    const request = seen.find((entry) => entry.path.endsWith('/turns'));
    expect(request?.method).toBe('POST');
    expect(request?.path).toBe(`/v1/divan/threads/${sessionId}/turns`);
    expect(request?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request?.headers['x-divan-client']).toBe('t3-code');
    expect(request?.headers['content-type']).toBe('application/json');
    expect(request?.body).toEqual({
      profile: 'sprint',
      level: 'high',
      text: 'Should I stay?',
      cwd: 'C:\\work\\project',
      from: null,
      background: null,
    });
    // what T3 puts in its own environment and session never reaches the server
    expect(JSON.stringify(seen)).not.toContain(T3_SECRET);

    // the updates: all before the response, in order, each valid for the schema
    const updates = bridge.messages.filter((message) => message.method === 'session/update');
    const place = bridge.messages.indexOf(reply);
    for (const update of updates) {
      expect(bridge.messages.indexOf(update)).toBeLessThan(place);
      expect(update.params?.sessionId).toBe(sessionId);
      expect(validate('SessionNotification', update.params)).toBe(true);
    }
    expect(updates.map((message) => message.params?.update?.sessionUpdate)).toEqual([
      'agent_thought_chunk',
      'plan',
      'agent_thought_chunk',
      'plan',
      'agent_thought_chunk',
      'plan',
      'agent_message_chunk',
      'usage_update',
    ]);
    // the note and every line of the live report are thoughts, each a message of its own (its own messageId), with a line break
    const thoughts = bridge.updatesOf('agent_thought_chunk');
    expect(thoughts.map((update) => (update.content as Json).text)).toEqual([
      'The folder was not used.\n',
      'Claude Code · opus answered after 1m 42s.\n',
      'All members are in. The chairman (Codex · gpt · max) is reading 1 answers.\n',
    ]);
    for (const update of thoughts) {
      expect(update.messageId).toEqual(expect.any(String));
      expect((update.content as Json).type).toBe('text');
    }
    expect(new Set(thoughts.map((update) => update.messageId)).size).toBe(thoughts.length);
    expect(bridge.updatesOf('plan').at(-1)).toEqual({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Claude Code · opus', priority: 'medium', status: 'completed' },
        { content: 'Chairman · Codex · gpt', priority: 'medium', status: 'in_progress' },
      ],
    });
    expect(bridge.updatesOf('agent_message_chunk')[0]).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `Stay.\n\n${closing(REF_A)}` },
    });
    expect(bridge.updatesOf('usage_update')[0]).toEqual({
      sessionUpdate: 'usage_update',
      used: 250,
      size: 0,
    });
    expect(await bridge.stop()).toBe(0);
    expectCleanStdout(bridge);
    expect(bridge.errors).toBe('');
  });

  it('gives a fork’s handoff to the server as the round it continues and as background, and a handoff with no round as background alone', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const handoff = [
      'Context handoff (full_thread_summary):\nThread: fork.',
      `[Historical assistant; assistant_message; thread=src]\nOld.\n\n${closing(REF_B)}`,
    ].join('\n\n');
    await bridge.request('session/prompt', {
      sessionId,
      prompt: [
        text(`${handoff}\n\nUser message:\nWhat if I wait?`),
        text('<runtime_info>x</runtime_info>'),
      ],
    });
    expect(seen.at(-1)?.body).toMatchObject({
      text: 'What if I wait?',
      from: { sessionId: '0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01', chairId: 'c_4d5e6f' },
      background: handoff,
    });
    const other = await bridge.open();
    await bridge.request('session/prompt', {
      sessionId: other.sessionId,
      prompt: [
        text(
          'Context handoff (full_thread_summary):\n[Historical user]\nHi\n\nUser message:\nGo on',
        ),
      ],
    });
    expect(seen.at(-1)?.body).toMatchObject({
      text: 'Go on',
      from: null,
      background: 'Context handoff (full_thread_summary):\n[Historical user]\nHi',
    });
  });

  it('turns a failed round into an error of the prompt, with the link to open it', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const fail = async (event: Json) => {
      onTurn = ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(line(event));
      };
      return (await bridge.request('session/prompt', { sessionId, prompt: wrapped('Q?') })).error;
    };
    expect(
      await fail({
        type: 'error',
        code: 'round_failed',
        message: 'Two members must answer.',
        link: 'http://127.0.0.1:1/open/t',
      }),
    ).toEqual({
      code: -32603,
      message: 'Two members must answer. Open it in Divan: http://127.0.0.1:1/open/t',
    });
    expect(
      await fail({ type: 'error', code: 'busy', message: 'Divan is busy.', link: null }),
    ).toEqual({
      code: -32603,
      message: 'Divan is busy.',
    });
    // a stream that ends with neither an answer nor an error
    expect(await fail({ type: 'plan', plan: [{ content: 'a', status: 'pending' }] })).toEqual({
      code: -32603,
      message: 'Divan stopped answering.',
    });
    // the thread is usable afterwards
    onTurn = answerTurn;
    expect(
      (await bridge.request('session/prompt', { sessionId, prompt: wrapped('Again?') })).result,
    ).toEqual({
      stopReason: 'end_turn',
    });
  });

  it('turns a refusal before the stream into an error, and keeps the words T3 misreads out of it', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    onTurn = ({ res }) => {
      res.writeHead(409, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          error: {
            message:
              'This council is blocked: its chairman shares a family. Authentication and credentials are fine; log in is not needed.',
            code: 'profile_blocked',
          },
        }),
      );
    };
    const reply = await bridge.request('session/prompt', { sessionId, prompt: wrapped('Q?') });
    expect(reply.error?.code).toBe(-32603);
    expect(reply.error?.message).toMatch(/^This council is blocked/u);
    expect(reply.error?.message).not.toMatch(
      /\b(?:authenticat(?:e|ed|es|ing|ion)|credentials?|log(?:[\s-]+)?in)\b/iu,
    );
    onTurn = ({ res }) => {
      res.writeHead(500).end('not json');
    };
    expect(
      (await bridge.request('session/prompt', { sessionId, prompt: wrapped('Q?') })).error?.message,
    ).toBe('Divan answered with status 500.');
  });

  it('refuses an empty message, an unknown session, and a second prompt while one runs', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const empty = await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('<runtime_info>x</runtime_info>')],
    });
    expect(empty.error?.code).toBe(-32602);
    const unknown = await bridge.request('session/prompt', {
      sessionId: 'dv_nope',
      prompt: [text('Hi')],
    });
    expect(unknown.error?.code).toBe(-32602);
    // no server was asked for either
    expect(seen).toEqual([]);

    let release: () => void = () => undefined;
    onTurn = ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      release = () =>
        res.end(line({ type: 'answer', content: 'Done.', usage: { round: 1, session: 1 } }));
    };
    const first = bridge.start('session/prompt', { sessionId, prompt: [text('First')] });
    await bridgeWaitsForTurn();
    const second = await bridge.request('session/prompt', { sessionId, prompt: [text('Second')] });
    expect(second.error?.code).toBe(-32603);
    expect(bridge.responsesTo(first)).toHaveLength(0);
    release();
    expect((await bridge.until((message) => message.id === first)).result).toEqual({
      stopReason: 'end_turn',
    });
  });
});

/** The default round: admitted, with one step, and answered. */
function answerTurn({ res }: Turn): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.write(line({ type: 'round', plan: [{ content: 'Claude Code · opus', status: 'pending' }] }));
  res.end(
    line({
      type: 'answer',
      content: `Fine.\n\n${closing(REF_A)}`,
      usage: { round: 1, session: 1 },
    }),
  );
}

/** Waits until the stand-in has been asked for a turn. */
async function bridgeWaitsForTurn(): Promise<void> {
  const until = Date.now() + 10_000;
  while (!seen.some((entry) => entry.path.endsWith('/turns'))) {
    if (Date.now() > until) throw new Error('the bridge never asked for a turn');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the bridge process: cancel', () => {
  it('answers a cancelled prompt at once, exactly once, and the server hears the connection close', async () => {
    let turn: Turn | undefined;
    onTurn = (given) => {
      turn = given;
      given.res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      given.res.write(
        line({ type: 'round', plan: [{ content: 'Claude Code · opus', status: 'in_progress' }] }),
      );
    };
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const id = bridge.start('session/prompt', { sessionId, prompt: [text('A long question')] });
    await bridge.until((message) => message.method === 'session/update');
    bridge.notify('session/cancel', { sessionId });
    const reply = await bridge.until((message) => message.id === id);
    expect(reply.result).toEqual({ stopReason: 'cancelled' });
    expect(validate('PromptResponse', reply.result)).toBe(true);
    expect(await (turn as Turn).hungUp).toBe(true);
    // whatever the server still says is not heard, and a second cancel changes nothing
    bridge.notify('session/cancel', { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bridge.responsesTo(id)).toHaveLength(1);
    const place = bridge.messages.indexOf(reply);
    expect(bridge.messages.slice(place + 1)).toEqual([]);

    // the next prompt of the thread is a prompt like any other, with its own single answer
    onTurn = answerTurn;
    const next = await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.')],
    });
    expect(next.result).toEqual({ stopReason: 'end_turn' });
    expect(seen.at(-1)?.body).toMatchObject({ text: 'Continue where you left off.' });
    expect(bridge.responsesTo(id)).toHaveLength(1);
    expectCleanStdout(bridge);
  });

  it('cancels before the server has answered at all, and when the answer arrives at the same moment', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    // 1. the server has not even sent its headers
    let held: Turn | undefined;
    onTurn = (given) => {
      held = given;
    };
    const first = bridge.start('session/prompt', { sessionId, prompt: [text('Question one')] });
    await bridgeWaitsForTurn();
    bridge.notify('session/cancel', { sessionId });
    expect((await bridge.until((message) => message.id === first)).result).toEqual({
      stopReason: 'cancelled',
    });
    expect(await (held as Turn).hungUp).toBe(true);

    // 2. the answer is on its way, or already there, when the cancel is sent: over many tries, from before to after
    for (let round = 0; round < 15; round += 1) {
      onTurn = ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.end(line({ type: 'answer', content: 'Done.', usage: { round: 1, session: 1 } }));
      };
      const id = bridge.start('session/prompt', { sessionId, prompt: [text(`Question ${round}`)] });
      await new Promise((resolve) => setTimeout(resolve, round * 3));
      bridge.notify('session/cancel', { sessionId });
      const reply = await bridge.until((message) => message.id === id);
      expect(['end_turn', 'cancelled']).toContain(reply.result?.stopReason);
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(bridge.responsesTo(id), `prompt ${round}`).toHaveLength(1);
      // a prompt that was answered is the last thing said about it
      const place = bridge.messages.findIndex((message) => message.id === id);
      expect(
        bridge.messages.slice(place + 1).filter((message) => message.method === 'session/update'),
      ).toEqual([]);
      seen = [];
    }
    expect(await bridge.stop()).toBe(0);
    expectCleanStdout(bridge);
  });

  it('sends the cancelled message again when the client’s continue button follows a cancel the server never admitted', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    const handoff = [
      'Context handoff (full_thread_summary):\nThread: fork.',
      `[Historical assistant; assistant_message; thread=src]\nOld.\n\n${closing(REF_B)}`,
    ].join('\n\n');
    // the server has not even sent its headers when the cancel comes: no round was admitted
    let held: Turn | undefined;
    onTurn = (given) => {
      held = given;
    };
    const first = bridge.start('session/prompt', {
      sessionId,
      prompt: [text(`${handoff}\n\nUser message:\nShould I move to Linear?`)],
    });
    await bridgeWaitsForTurn();
    bridge.notify('session/cancel', { sessionId });
    expect((await bridge.until((message) => message.id === first)).result).toEqual({
      stopReason: 'cancelled',
    });
    expect(await (held as Turn).hungUp).toBe(true);

    // the continue button sends only its own sentence; the bridge puts the real message, and what came with it, back
    seen = [];
    onTurn = answerTurn;
    const resumed = await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.'), text('<runtime_info>x</runtime_info>')],
    });
    expect(resumed.result).toEqual({ stopReason: 'end_turn' });
    expect(seen.at(-1)?.body).toMatchObject({
      text: 'Should I move to Linear?',
      from: { sessionId: '0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01', chairId: 'c_4d5e6f' },
      background: handoff,
    });

    // that round was admitted (the stream said so), so the server can run it again itself: the sentence goes as it is
    const again = await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.')],
    });
    expect(again.result).toEqual({ stopReason: 'end_turn' });
    expect(seen.at(-1)?.body).toMatchObject({
      text: 'Continue where you left off.',
      from: null,
      background: null,
    });
    expectCleanStdout(bridge);
  });

  it('sends the sentence as it is when nothing was cancelled before admission, and a new message replaces the remembered one', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    onTurn = answerTurn;
    await bridge.request('session/prompt', { sessionId, prompt: [text('Question one')] });
    await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.')],
    });
    expect(seen.at(-1)?.body).toMatchObject({ text: 'Continue where you left off.' });

    // two cancels before admission: the continue button repeats the latest message, not the first
    onTurn = () => undefined;
    for (const message of ['Question two', 'Question three']) {
      seen = [];
      const id = bridge.start('session/prompt', { sessionId, prompt: [text(message)] });
      await bridgeWaitsForTurn();
      bridge.notify('session/cancel', { sessionId });
      await bridge.until((reply) => reply.id === id);
    }
    onTurn = answerTurn;
    seen = [];
    await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.')],
    });
    expect(seen.at(-1)?.body).toMatchObject({ text: 'Question three' });
  });

  it('closes the stream of a running prompt when the client goes away, then ends', async () => {
    let turn: Turn | undefined;
    onTurn = (given) => {
      turn = given;
      given.res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      given.res.write(
        line({ type: 'round', plan: [{ content: 'Claude Code · opus', status: 'in_progress' }] }),
      );
    };
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    bridge.start('session/prompt', { sessionId, prompt: [text('A long question')] });
    await bridge.until((message) => message.method === 'session/update');
    expect(await bridge.stop()).toBe(0);
    expect(await (turn as Turn).hungUp).toBe(true);
    expect(bridge.errors).toBe('');
  });
});

describe('the bridge process: resuming a thread', () => {
  it('opens a thread the server knows with its council, level and folder, then asks with them', async () => {
    onThread = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'x',
          sessionId: 's',
          chairId: 'c_1',
          profileId: 'quick',
          level: 'high',
          cwd: 'C:\\old',
        }),
      );
    };
    const bridge = new Bridge();
    await bridge.request('initialize', { protocolVersion: 2 });
    const sessionId = 'dv_0b9d3a52-7c1e-4f0a-8d44-5e6f7a8b9c01';
    const reply = await bridge.request('session/resume', {
      sessionId,
      cwd: 'C:\\now',
      mcpServers: [],
    });
    expect(validate('ResumeSessionResponse', reply.result)).toBe(true);
    const options = (reply.result as { configOptions: ConfigOption[] }).configOptions;
    expect(options.map((option) => option.currentValue)).toEqual(['d1-quick', 'high']);
    const thread = seen.find((entry) => entry.method === 'GET' && entry.path.includes('/threads/'));
    expect(thread?.path).toBe(`/v1/divan/threads/${sessionId}`);
    expect(thread?.headers.authorization).toBe(`Bearer ${KEY}`);

    // the level of a resumed thread is the thread's own: another council does not move it
    const after = await bridge.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'd1-default',
    });
    expect((after.result as { configOptions: ConfigOption[] }).configOptions[1]?.currentValue).toBe(
      'high',
    );
    await bridge.request('session/prompt', { sessionId, prompt: [text('Next?')] });
    expect(seen.at(-1)?.body).toMatchObject({ profile: 'default', level: 'high', cwd: 'C:\\now' });
    expectCleanStdout(bridge);
  });

  it('keeps the message of a cancel the server never admitted across a resume of the same thread', async () => {
    const bridge = new Bridge();
    const { sessionId } = await bridge.open();
    onTurn = () => undefined;
    const first = bridge.start('session/prompt', { sessionId, prompt: [text('Stay or go?')] });
    await bridgeWaitsForTurn();
    bridge.notify('session/cancel', { sessionId });
    await bridge.until((message) => message.id === first);

    onThread = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: sessionId,
          sessionId: 's',
          chairId: null,
          profileId: 'quick',
          level: 'low',
          cwd: null,
        }),
      );
    };
    expect((await bridge.request('session/resume', { sessionId, cwd: 'C:\\x' })).error).toBe(
      undefined,
    );
    onTurn = answerTurn;
    seen = [];
    await bridge.request('session/prompt', {
      sessionId,
      prompt: [text('Continue where you left off.')],
    });
    expect(seen.at(-1)?.body).toMatchObject({
      text: 'Stay or go?',
      profile: 'quick',
      level: 'low',
    });
  });

  it('says so when the server does not know the thread, so the client starts a new session', async () => {
    const bridge = new Bridge();
    const reply = await bridge.request('session/resume', {
      sessionId: 'dv_00000000-aaaa-bbbb-cccc-000000000000',
      cwd: 'C:\\x',
    });
    expect(reply.error).toEqual({
      code: -32002,
      message: 'Divan does not know this conversation.',
    });
    const bad = await bridge.request('session/resume', { sessionId: '../etc', cwd: 'C:\\x' });
    expect(bad.error?.code).toBe(-32602);
    onThread = (res) => {
      res
        .writeHead(500, { 'content-type': 'application/json' })
        .end('{"error":{"message":"The index is broken."}}');
    };
    const broken = await bridge.request('session/resume', {
      sessionId: 'dv_00000000-aaaa-bbbb-cccc-000000000001',
      cwd: 'C:\\x',
    });
    expect(broken.error).toEqual({ code: -32603, message: 'The index is broken.' });
  });
});

describe('the bridge process: a server that cannot be reached', () => {
  it('fails the prompt with the reason, in plain words, and stays usable', async () => {
    // a running server that has made no API key: the launcher is not needed to see that
    const empty = mkdtempSync(join(tmpdir(), 'divan-acp-nokey-'));
    try {
      mkdirSync(empty, { recursive: true });
      writeFileSync(join(empty, 'server.json'), readFileSync(join(home, 'server.json')));
      // the stand-in's port again, so that a launch of a server here could not bind it
      writeFileSync(join(empty, 'settings.json'), JSON.stringify({ port: standPort }));
      const bridge = new Bridge({ DIVAN_HOME: empty });
      const { sessionId } = await bridge.open();
      const reply = await bridge.request('session/prompt', { sessionId, prompt: [text('Hello?')] });
      expect(reply.error?.code).toBe(-32603);
      expect(reply.error?.message).toMatch(
        /^Dio Divan could not start: Dio Divan is running but has not made its API key/u,
      );
      // nothing was sent to the server, and the thread can ask again
      expect(seen.some((entry) => entry.path.endsWith('/turns'))).toBe(false);
      writeFileSync(join(empty, 'api-key'), `${KEY}\n`);
      expect(
        (await bridge.request('session/prompt', { sessionId, prompt: [text('Hello again?')] }))
          .result,
      ).toEqual({
        stopReason: 'end_turn',
      });
      expectCleanStdout(bridge);
    } finally {
      for (const bridge of bridges.splice(0)) {
        bridge.child.stdin?.end();
        await bridge.exited;
      }
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
