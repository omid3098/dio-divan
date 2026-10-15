// The local HTTP server: the web editor's JSON API and Server-Sent Events, the built web editor, and the
// OpenAI-compatible endpoint under /v1 (with the threads of T3 Code's bridge under /v1/divan/). It binds to 127.0.0.1 only.
// The web API passes the guard in security.ts (the per-server token); /v1 passes its own (the persistent API key, and no
// browser headers at all).

import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { DEFAULT_PORT } from '../shared/defaults.ts';
import { isLevel } from '../shared/levels.ts';
import { MESSAGES, type MessageCode, type MessageParams, messageText } from '../shared/messages.ts';
import { PACKAGE_ROOT, VERSION } from '../shared/package-root.ts';
import type { EndpointInfo, Meta, RoundInput, ServerEvent } from '../shared/types.ts';
import { harnessInfos, isFake } from './adapters/index.ts';
import { validateCwd } from './cwd.ts';
import { handleDivan } from './divan-api.ts';
import { Engine, EngineError, type LayoutOp } from './engine.ts';
import { FLOW_TEMPLATES, flowForms } from './flow-templates.ts';
import { Gateway, GatewayError } from './gateway.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { acquireLock } from './lock.ts';
import { handleV1, sendApiError } from './openai.ts';
import { allowChildren, killAllChildren } from './proc.ts';
import { secureHome } from './secure.ts';
import {
  checkApiRequest,
  checkRequest,
  loadApiKey,
  newToken,
  SECURITY_HEADERS,
} from './security.ts';
import { SettingsService } from './settings.ts';
import { defaultHome, Store } from './store.ts';
import { Threads } from './threads.ts';

export { VERSION };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export class PortBusyError extends Error {
  readonly port: number;
  constructor(port: number, home = defaultHome()) {
    super(
      `Port ${port} is already in use. Close the program using it, or use divan --port N for this run only. For a lasting port, set "port" in ${join(home, 'settings.json')}, or use the Port field on Connect. Divan does not pick another port by itself.`,
    );
    this.port = port;
  }
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  /** The key `/v1` clients send as a Bearer token. */
  apiKey: string;
  store: Store;
  engine: Engine;
  close(): Promise<void>;
}

export interface StartOptions {
  /** 0 picks a free port; absent uses the configured port (the built-in default unless settings say otherwise). */
  port?: number;
  home?: string;
  /** The built web editor (dist/web). */
  webRoot?: string;
}

/**
 * An error answer: `error` is the stable code; `params` (when the message has any) and the English `message` ride with it. A
 * code of the message table (the guard's too) has its English text, so a client can word it; any other code is its own message.
 */
function fail(
  res: ServerResponse,
  status: number,
  code: string,
  message?: string,
  details?: Record<string, unknown>,
  params?: MessageParams,
): void {
  const text =
    message ?? (Object.hasOwn(MESSAGES, code) ? messageText(code as MessageCode, params) : code);
  sendJson(res, status, { error: code, message: text, ...(params ? { params } : {}), ...details });
}

/** An error answer for a code of the message table. */
function failCode(
  res: ServerResponse,
  status: number,
  code: MessageCode,
  params?: MessageParams,
): void {
  fail(res, status, code, messageText(code, params), undefined, params);
}

/**
 * The working folder a request names (`cwd`): nothing when it names none, its real path when it can be used, else the reason
 * it cannot (the engine checks it again where it is used).
 */
function workingFolder(value: unknown): { path: string } | { reason: string } | null {
  if (value === undefined || value === null || value === '') return null;
  const verdict = validateCwd(value);
  return verdict.ok ? { path: verdict.path } : { reason: verdict.reason };
}

/**
 * The input a request carries: `{answers: [{question, answer}], comment}` (answers to the chairman's questions, then a comment),
 * or an older plain `text`. Null when it holds nothing.
 */
function roundInput(body: Record<string, unknown>): RoundInput | null {
  const answers = Array.isArray(body.answers)
    ? (body.answers as unknown[]).slice(0, 10).flatMap((item) => {
        const pair = item as { question?: unknown; answer?: unknown } | null;
        return pair && typeof pair.answer === 'string'
          ? [
              {
                question: typeof pair.question === 'string' ? pair.question : '',
                answer: pair.answer,
              },
            ]
          : [];
      })
    : [];
  const comment =
    typeof body.comment === 'string'
      ? body.comment
      : typeof body.text === 'string'
        ? body.text
        : '';
  if (answers.length === 0) return comment.trim() ? comment : null;
  return { answers, comment };
}

/** A link a client was given opens the web app once and signs the browser in, then it is gone. */
const TICKET_MINUTES = 30;

export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const home = options.home ?? defaultHome();
  const webRoot = resolve(options.webRoot ?? join(PACKAGE_ROOT, 'dist', 'web'));
  const token = newToken();
  allowChildren();
  // The home, the key and the state file are owner-only after every start (an old home is repaired, a new one made so).
  secureHome(home);
  // One instance per home: taken before the store is read, so recovery never races another live server.
  const releaseLock = await acquireLock(home);
  const store = new Store(home);
  let apiKey: string;
  try {
    await store.init();
    apiKey = await loadApiKey(home);
  } catch (error) {
    await releaseLock();
    throw error;
  }

  const clients = new Set<ServerResponse>();
  const broadcast = (event: ServerEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) client.write(line);
  };
  const engine = new Engine(store, broadcast);
  const settings = new SettingsService(store);
  const gateway = new Gateway(engine, store, settings);
  const wanted = options.port ?? settings.port();

  let port = 0;
  const tickets = new Map<string, { path: string; until: number }>();

  const endpoint = (): EndpointInfo => ({
    port,
    configuredPort: settings.port(),
    defaultPort: DEFAULT_PORT,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    piExtension: join(PACKAGE_ROOT, 'pi-extension'),
    // T3 Code runs Divan as a provider of its own with this command (node cannot be given a .mjs as the executable itself)
    acp: {
      command: process.execPath,
      args: [
        '--disable-warning=ExperimentalWarning',
        join(PACKAGE_ROOT, 'bin', 'dio-divan.mjs'),
        'acp',
      ],
    },
  });

  const meta = async (): Promise<Meta> => ({
    version: VERSION,
    fake: isFake(),
    typicalRoundSeconds: store.typicalRoundSeconds(),
    typicalRoundRange: store.typicalRoundRange(),
    typicalRoundRangeByLevel: store.typicalRoundRangeByLevel(),
    harnesses: harnessInfos(),
    settings: await settings.view(),
    platform: process.platform,
    endpoint: endpoint(),
    recentFolders: store.readRecentFolders(),
  });

  /** The answer of `POST /api/endpoint/test`: the models the endpoint lists, or the reason it could not be read. */
  async function testEndpoint(): Promise<Record<string, unknown>> {
    const baseUrl = endpoint().baseUrl;
    const refused = (code: MessageCode, params?: MessageParams) => ({
      ok: false,
      baseUrl,
      code,
      ...(params ? { params } : {}),
      message: messageText(code, params),
    });
    try {
      const reply = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (reply.status === 401) return refused('endpoint_rejected');
      if (!reply.ok) return refused('endpoint_unreachable', { detail: `HTTP ${reply.status}` });
      const body = (await reply.json()) as { data?: { id?: unknown }[] };
      const models = (body.data ?? []).flatMap((item) =>
        typeof item.id === 'string' ? [item.id] : [],
      );
      return { ok: true, baseUrl, models };
    } catch (error) {
      return refused('endpoint_unreachable', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** The closing link of an answer: a one-time address that opens that round in the web app. */
  const link = (sessionId: string, chairId: string): string => {
    const now = Date.now();
    for (const [id, ticket] of tickets) if (ticket.until < now) tickets.delete(id);
    if (tickets.size > 200) tickets.delete(tickets.keys().next().value as string);
    const id = randomBytes(18).toString('base64url');
    tickets.set(id, { path: `/s/${sessionId}/n/${chairId}`, until: now + TICKET_MINUTES * 60_000 });
    return `http://127.0.0.1:${port}/open/${id}`;
  };

  function open(res: ServerResponse, id: string): void {
    const ticket = tickets.get(id);
    tickets.delete(id);
    if (!ticket || ticket.until < Date.now()) {
      res.writeHead(302, { ...SECURITY_HEADERS, Location: '/#expired' });
      res.end();
      return;
    }
    res.writeHead(302, {
      ...SECURITY_HEADERS,
      Location: `/#token=${token}&to=${encodeURIComponent(ticket.path)}`,
    });
    res.end();
  }

  async function api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
    const [a, id, b, c, d] = parts;

    if (a === 'health' && method === 'GET')
      return sendJson(res, 200, { ok: true, version: VERSION, pid: process.pid });
    if (a === 'meta' && method === 'GET') return sendJson(res, 200, await meta());
    // Detect again what this PC has (the refresh button in setup).
    if (a === 'detect' && method === 'POST') return sendJson(res, 200, await settings.view(true));

    // Tries the endpoint the way a client would: this server calls its own `/v1/models` on the loopback address with the key.
    if (a === 'endpoint' && id === 'test' && method === 'POST')
      return sendJson(res, 200, await testEndpoint());

    // The endpoint: the address clients use, the key they send, and the port (changed here, used at the next start).
    if (a === 'endpoint') {
      if (method === 'GET') return sendJson(res, 200, { ...endpoint(), key: apiKey });
      if (method === 'PUT') {
        const body = await readJson(req);
        await settings.setPort(body.port);
        return sendJson(res, 200, { ...endpoint(), key: apiKey });
      }
      return fail(res, 405, 'method');
    }

    if (a === 'library') {
      if (!id && method === 'GET') return sendJson(res, 200, await settings.library());
      if (id !== 'prompts' && id !== 'forms') return fail(res, 404, 'not_found');
      if ((!b && method === 'POST') || (b && (method === 'PUT' || method === 'DELETE'))) {
        const body = method === 'DELETE' ? {} : await readJson(req);
        return sendJson(
          res,
          method === 'POST' ? 201 : 200,
          await settings.editLibrary(id, method as 'POST' | 'PUT' | 'DELETE', b, body),
        );
      }
      return fail(res, 405, 'method');
    }

    // Profiles: named settings, which are also the endpoint's models (`divan/<id>`).
    if (a === 'flow-templates' && method === 'GET') return sendJson(res, 200, FLOW_TEMPLATES);
    if (a === 'flow-forms' && method === 'GET') return sendJson(res, 200, flowForms());
    if (a === 'profiles') {
      if (!id) {
        if (method !== 'POST') return fail(res, 405, 'method');
        const body = await readJson(req);
        return sendJson(
          res,
          201,
          await settings.create(body.name, body.from, body.id, body.template, body.firstRun),
        );
      }
      if (!b) {
        if (method === 'PUT') {
          const body = await readJson(req);
          // id, name and overrides: each one that is given is checked, and then they are applied together in one write
          const { view } = await settings.update(id, {
            id: body.id,
            name: body.name,
            overrides: body.overrides,
            flow: body.flow,
            levels: body.levels,
            defaultLevel: body.defaultLevel,
            ifRevision: body.ifRevision,
            ifFingerprint: body.ifFingerprint,
          });
          return sendJson(res, 200, view);
        }
        if (method === 'DELETE') return sendJson(res, 200, await settings.remove(id));
        return fail(res, 405, 'method');
      }
      return fail(res, 404, 'not_found');
    }

    if (a === 'events' && method === 'GET') {
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`data: ${JSON.stringify({ type: 'hello' } satisfies ServerEvent)}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (a !== 'sessions') return fail(res, 404, 'not_found');

    if (!id) {
      if (method === 'GET') return sendJson(res, 200, store.list());
      if (method === 'POST') {
        const body = await readJson(req);
        const named = typeof body.name === 'string' ? { name: body.name } : {};
        // From the setup page: the profile, its revision and the fingerprint of the settings the page showed, nothing else. The
        // session is built from that very snapshot (a profile that has moved on in either way is a 409), never from a form.
        const from =
          typeof body.profileId === 'string'
            ? await settings.at(
                body.profileId,
                body.revision,
                body.fingerprint,
                isLevel(body.level) ? body.level : undefined,
              )
            : undefined;
        // the council is the level's: the profile's default level when none is named
        if (body.level !== undefined && !isLevel(body.level)) {
          return failCode(res, 400, 'bad_level');
        }
        if (body.context !== undefined && typeof body.context !== 'string') {
          return failCode(res, 400, 'bad_op');
        }
        // what the asker adds besides the question (the engine trims it and refuses one that is too long)
        const added = typeof body.context === 'string' ? { context: body.context } : {};
        // the session's working folder (checked by the engine; remembered for the Home field once the session has started)
        const folder = workingFolder(body.cwd);
        if (folder && 'reason' in folder)
          return failCode(res, 400, 'bad_cwd', { reason: folder.reason });
        const where = folder ? { folder: folder.path } : {};
        // the lens mode (an experiment): "off" (the default), "angle" or "only"; the engine refuses any other word
        const lens = body.lensMode !== undefined ? { lensMode: body.lensMode } : {};
        const level = from ? (isLevel(body.level) ? body.level : from.defaultLevel) : undefined;
        const council = from && level ? from.levels[level] : undefined;
        if (council?.blocked) {
          return fail(
            res,
            409,
            council.blocked.code,
            council.blocked.message,
            undefined,
            council.blocked.params,
          );
        }
        const session = await engine.createSession(
          from && council && level
            ? {
                ...named,
                ...added,
                ...where,
                ...lens,
                question: body.question as string,
                seats: council.effective.seats,
                chairman: council.effective.chairman,
                budgets: council.effective.budgets,
                ...(council.effective.flow ? { flow: council.effective.flow } : {}),
                origin: {
                  kind: 'web',
                  profileId: from.id,
                  profileRevision: from.revision,
                  profileGeneration: from.generation,
                  profileLevel: level,
                },
                level,
                // `quick` keeps its chairman's family apart, in every round of the session
                ...(from.base === 'quick' ? { separateChairman: true } : {}),
              }
            : {
                ...named,
                ...added,
                ...where,
                ...lens,
                question: body.question as string,
                seats: body.seats as never,
                chairman: body.chairman as never,
                budgets: body.budgets as never,
              },
        );
        if (session.settings.cwd) await store.rememberFolder(session.settings.cwd);
        return sendJson(res, 201, session);
      }
      return fail(res, 405, 'method');
    }
    const session = store.get(id);
    if (!session) return failCode(res, 404, 'no_session');

    if (!b) {
      if (method === 'GET') return sendJson(res, 200, session);
      if (method === 'PATCH') {
        const body = await readJson(req);
        return sendJson(res, 200, await engine.rename(id, String(body.name ?? '')));
      }
      if (method === 'DELETE') {
        await engine.deleteSession(id);
        return sendJson(res, 200, { ok: true });
      }
      return fail(res, 405, 'method');
    }
    if (b === 'rounds' && method === 'POST') {
      const body = await readJson(req);
      if (c && d === 'rerun') {
        await engine.rerun(id, c);
        return sendJson(res, 202, { ok: true });
      }
      if (c && d === 'cancel') {
        engine.cancelRound(id, c);
        return sendJson(res, 202, { ok: true });
      }
      // «منتظرش نمی‌مانم»: stop waiting for one member of a running round, named by its label in the round or, apart, by its
      // seat id (never both, and never one list for the two)
      // the rest of the members that are still working, at once (the chairman then writes from those that answered)
      if (c && d === 'skip-rest') {
        return sendJson(res, 202, { skipped: engine.skipRemaining(id, c) });
      }
      if (c && d === 'skip') {
        const hasLabel = Object.hasOwn(body, 'label');
        const hasSeat = Object.hasOwn(body, 'seatId');
        const chosen = hasLabel ? body.label : body.seatId;
        // exactly one of the two properties, and what it holds is a name
        if (hasLabel === hasSeat || typeof chosen !== 'string' || chosen === '') {
          return failCode(res, 400, 'bad_op');
        }
        engine.skipSeat(id, c, hasLabel ? { label: chosen } : { seatId: chosen });
        return sendJson(res, 202, { ok: true });
      }
      if (c) return fail(res, 404, 'not_found');
      const started = await engine.startRound(id, String(body.fromNodeId ?? ''), roundInput(body), {
        ...(typeof body.editedFrom === 'string' ? { editedFrom: body.editedFrom } : {}),
      });
      return sendJson(res, 202, { userId: started.userId, chairId: started.chairId });
    }
    if (b === 'layout' && method === 'PUT') {
      const body = await readJson(req);
      const nodes: LayoutOp['nodes'] = {};
      if (body.nodes && typeof body.nodes === 'object') {
        for (const [key, value] of Object.entries(body.nodes as Record<string, unknown>)) {
          nodes[key] = value as LayoutOp['nodes'][string];
        }
      }
      return sendJson(
        res,
        200,
        await engine.setLayout(id, {
          opId: body.opId as string,
          ...(body.direction === 'TB' || body.direction === 'LR'
            ? { direction: body.direction }
            : {}),
          nodes,
        }),
      );
    }
    return fail(res, 404, 'not_found');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const requested = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/u, '');
    let file = resolve(webRoot, requested || 'index.html');
    if (file !== webRoot && !file.startsWith(webRoot + sep)) {
      fail(res, 403, 'forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('The web editor is not built. Run: pnpm build');
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Content-Length': statSync(file).size,
    });
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }

  const v1Deps = {
    gateway,
    profiles: async () => (await settings.view()).profiles,
    link,
  };
  const divanDeps = { threads: new Threads(engine, store), store, profiles: v1Deps.profiles, link };
  const v1Messages: Record<string, string> = {
    bad_host: 'the Host header is not this server’s',
    browser_request: 'browsers may not call /v1: it is for programs',
    bad_key: 'missing or wrong API key (send it as a Bearer token)',
  };

  const server = createServer((req, res) => {
    // A request line that is not a URL is answered 400 before authentication and routing, and never throws.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return fail(res, 400, 'bad_url');
    }
    if (url.pathname === '/v1' || url.pathname.startsWith('/v1/')) {
      const verdict = checkApiRequest(req, { key: apiKey, port });
      if (!verdict.ok) {
        return sendApiError(
          res,
          verdict.status,
          verdict.code,
          v1Messages[verdict.code] ?? verdict.code,
        );
      }
      // the threads of a client that keeps its own conversation (T3 Code) are under /v1/divan/, behind the same guard
      const routed = url.pathname.startsWith('/v1/divan/')
        ? handleDivan(req, res, url, divanDeps)
        : handleV1(req, res, url, v1Deps);
      routed.catch((error: unknown) => {
        if (res.headersSent) return res.end();
        if (
          error instanceof HttpError ||
          error instanceof GatewayError ||
          error instanceof EngineError
        ) {
          return sendApiError(res, error.status, error.code, error.message);
        }
        console.error(error);
        return sendApiError(res, 500, 'internal', 'internal error');
      });
      return;
    }
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const verdict = checkRequest(req, isApi ? 'api' : 'static', { token, port });
    if (!verdict.ok) return fail(res, verdict.status, verdict.code);
    if (req.method === 'OPTIONS') return fail(res, 403, 'no_cors');
    if (!isApi) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method');
      try {
        if (url.pathname.startsWith('/open/')) open(res, url.pathname.slice('/open/'.length));
        else serveStatic(req, res, url);
      } catch {
        fail(res, 400, 'bad_path');
      }
      return;
    }
    api(req, res, url).catch((error: unknown) => {
      if (res.headersSent) return res.end();
      if (error instanceof EngineError || error instanceof HttpError) {
        return fail(
          res,
          error.status,
          error.code,
          error.message,
          error instanceof EngineError ? error.details : undefined,
          error instanceof EngineError ? error.params : undefined,
        );
      }
      console.error(error);
      return failCode(res, 500, 'internal');
    });
  });
  server.on('clientError', (_error, socket) => socket.destroy());

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        rejectListen(error.code === 'EADDRINUSE' ? new PortBusyError(wanted, home) : error),
      );
      server.listen(wanted, '127.0.0.1', () => resolveListen());
    });
  } catch (error) {
    await store.flush();
    await releaseLock();
    throw error;
  }
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/#token=${token}`,
    port,
    token,
    apiKey,
    store,
    engine,
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await killAllChildren();
      await engine.flush();
      await releaseLock();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}
