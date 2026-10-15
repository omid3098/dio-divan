// The OpenAI-compatible face of the council: `GET /v1/models` lists the profiles as `divan/<id>`, and `POST
// /v1/chat/completions` asks the council like a model, streaming or not. Progress goes in the `reasoning_content` field
// of the stream's deltas (the field Pi's openai-completions provider reads first, and the one llama.cpp and DeepSeek use);
// the content is the chairman's answer, its questions and a closing link to the round in the web app.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REASONING_LEVELS } from '../shared/levels.ts';
import { messageText } from '../shared/messages.ts';
import { roundLink } from '../shared/round-link.ts';
import type { ProfileView } from '../shared/types.ts';
import type { RoundEvent } from './engine.ts';
import { type Answer, type Gateway, GatewayError, linkLabel, type Pending } from './gateway.ts';
import { HttpError, readJson, sendJson } from './http.ts';
import { SECURITY_HEADERS } from './security.ts';

/** Largest request body: a long conversation with its system prompt and tool definitions. */
export const BODY_LIMIT = 16 * 1024 * 1024;
/** A comment line at least this often keeps an idle stream alive through proxies and client timeouts (the tests shorten it). */
export const KEEPALIVE_MS = 10_000;
export const keepaliveMs = (): number => Number(process.env.DIVAN_KEEPALIVE_MS) || KEEPALIVE_MS;

export interface V1Deps {
  gateway: Gateway;
  profiles: () => Promise<ProfileView[]>;
  /** The link to a round in the web app (a one-time address that also signs the browser in). */
  link: (sessionId: string, chairId: string) => string;
}

const errorType = (status: number): string =>
  status === 401
    ? 'authentication_error'
    : status >= 500
      ? 'server_error'
      : 'invalid_request_error';

export function sendApiError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  sendJson(res, status, { error: { message, type: errorType(status), param: null, code } });
}

const flat = (text: string, max = 160): string => {
  const one = text.replace(/\s+/gu, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

const REASON_FA = {
  failed: 'ناموفق',
  timeout: 'زمان پاسخ تمام شد',
  invalid: 'خروجی نامعتبر',
  cancelled: 'لغو شد',
  skipped: 'این دور شرکت نکرد، چون مدلش در دسترس نیست',
};

/** One short progress line, in the language of the question; null for events that say nothing. */
export function progressLine(event: RoundEvent, language: 'fa' | 'en'): string | null {
  const fa = language === 'fa';
  if (event.identity) {
    const roles: Record<string, string> = {
      Assistant: 'دستیار',
      Writer: 'نویسنده',
      Critic: 'منتقد',
      Member: 'عضو',
      Chairman: 'رئیس',
      Rewriter: 'بازنویس',
      Step: 'مرحله',
    };
    const step = fa
      ? event.identity.replace(/^[A-Za-z]+/u, (role) => roles[role] ?? role)
      : event.identity;
    switch (event.type) {
      case 'seat-start':
        return fa ? `${step} شروع کرد.` : messageText('flow_step_started', { step });
      case 'seat-done':
        return fa ? `${step} پاسخ داد.` : messageText('flow_step_answered', { step, time: '' });
      case 'seat-failed':
        return fa
          ? `${step} پاسخ نداد (${REASON_FA[event.reason]}).`
          : messageText('flow_step_failed', { step, reason: event.reason });
      case 'seat-note':
        return fa ? `${step} بدون پوشهٔ پروژه پاسخ داد.` : messageText('flow_step_folder', { step });
      case 'chairman':
        if (event.answers === 0)
          return fa ? `${step} شروع کرد.` : messageText('flow_step_started', { step });
        return fa
          ? `${step} در حال خواندن ${event.answers} پاسخ است.`
          : messageText('flow_answer_started', { step, answers: event.answers });
      default:
        return null;
    }
  }
  switch (event.type) {
    case 'seat-start':
      return fa ? `عضو ${event.label} شروع کرد.` : `Member ${event.label} started.`;
    case 'seat-done': {
      // a member that returned its report as plain text has no stance
      const said = flat(event.stance);
      if (!said) return fa ? `عضو ${event.label} تمام کرد.` : `Member ${event.label} done.`;
      return fa ? `عضو ${event.label} تمام کرد: ${said}` : `Member ${event.label} done: ${said}`;
    }
    case 'seat-failed':
      return fa
        ? `عضو ${event.label} ناموفق: ${REASON_FA[event.reason]}`
        : `Member ${event.label} failed: ${event.reason}`;
    case 'seat-note':
      // anonymous like everything else here: which tool it was is on the seat card
      return fa
        ? `عضو ${event.label} بدون پوشهٔ پروژه پاسخ داد.`
        : `Member ${event.label} answered without the project folder.`;
    case 'chairman':
      return fa
        ? `رئیس ${event.answers} پاسخ را می‌خواند.`
        : `Chairman reading ${event.answers} answers.`;
    default:
      return null;
  }
}

const usageBlock = (answer: Answer) => ({
  prompt_tokens: answer.usage.prompt,
  completion_tokens: answer.usage.completion,
  total_tokens: answer.usage.total,
  prompt_tokens_details: { cached_tokens: answer.usage.cached },
});

/** The first word of a User-Agent, as a client name ("pi-coding-agent/1.1" -> "pi-coding-agent"). */
export function clientName(req: IncomingMessage): string | null {
  const named = req.headers['x-divan-client'];
  const agent = req.headers['user-agent'];
  const raw = (typeof named === 'string' ? named : typeof agent === 'string' ? agent : '')
    .split(/[\s/]/u)[0]
    ?.replace(/[^\w.-]/gu, '')
    .slice(0, 40);
  return raw || null;
}

function listModels(profiles: ProfileView[]) {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    // a profile that cannot run at its default level now (`quick` without a free family for its chairman) is not offered
    data: profiles
      .filter((profile) => !profile.blocked)
      .map((profile) => ({
        id: `divan/${profile.id}`,
        object: 'model',
        created,
        owned_by: 'dio-divan',
        // every profile is a reasoning model: `reasoning_effort` picks the level (see `levelOfEffort`)
        divan: {
          name: profile.name,
          reasoning: true,
          levels: REASONING_LEVELS,
          default_level: profile.defaultLevel,
        },
      })),
  };
}

/** Routes one authenticated `/v1` request. Errors that escape are answered by the caller in the OpenAI shape. */
export async function handleV1(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: V1Deps,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (url.pathname === '/v1/models' && method === 'GET') {
    return sendJson(res, 200, listModels(await deps.profiles()));
  }
  if (url.pathname === '/v1/chat/completions' && method === 'POST') {
    return chat(req, res, deps);
  }
  return sendApiError(res, 404, 'not_found', `no such endpoint: ${method} ${url.pathname}`);
}

async function chat(req: IncomingMessage, res: ServerResponse, deps: V1Deps): Promise<void> {
  // The client may leave at any moment, also before the council has even been asked: it is watched from the first line, and
  // a client that is gone when its request comes back from the gateway lets go of the round at once.
  let gone = false;
  let finished = false;
  let pending: Pending | null = null;
  const left = new AbortController();
  res.on('close', () => {
    if (finished) return;
    gone = true;
    left.abort(); // also tells a round that is still being admitted
    pending?.release();
  });
  const body = await readJson(req, BODY_LIMIT);
  if (
    typeof body.model !== 'string' ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    throw new HttpError(400, 'bad_request', '"model" and a non-empty "messages" list are required');
  }
  const stream = body.stream === true;
  const wantUsage =
    (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
  const cwd = req.headers['x-divan-cwd'];
  const asked = await deps.gateway.submit({
    model: body.model,
    messages: body.messages,
    cwdHeader: typeof cwd === 'string' ? cwd : undefined,
    client: clientName(req),
    // OpenAI's `reasoning_effort`, or the nested form of the Responses API
    effort: body.reasoning_effort ?? (body.reasoning as { effort?: unknown } | undefined)?.effort,
    signal: left.signal,
  });
  if (gone) {
    asked.release();
    return;
  }
  pending = asked;
  const model = `divan/${asked.profileId}`;
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-${randomUUID()}`;

  if (!stream) {
    try {
      const answer = await asked.done;
      const link = deps.link(answer.sessionId, answer.chairId);
      finished = true;
      return sendJson(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: `${answer.content}\n\n${roundLink(link, answer, linkLabel(answer.content))}`,
            },
            finish_reason: 'stop',
          },
        ],
        usage: usageBlock(answer),
        divan: { session_id: answer.sessionId, round_id: answer.chairId, cached: answer.cached },
      });
    } catch (error) {
      finished = true;
      if (error instanceof GatewayError) {
        return sendApiError(res, error.status, error.code, error.message);
      }
      throw error;
    }
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (text: string) => {
    if (!res.writableEnded && !res.destroyed) res.write(text);
  };
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, extra = {}) =>
    write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...extra,
      })}\n\n`,
    );
  const reason = (line: string) => chunk({ reasoning_content: `${line}\n` });

  chunk({ role: 'assistant', content: '' });
  for (const note of asked.notes) reason(note);
  const keepalive = setInterval(() => write(': keepalive\n\n'), keepaliveMs());
  const unsubscribe = asked.subscribe((event) => {
    const line = progressLine(event, asked.language);
    if (line) reason(line);
  });
  try {
    const answer = await asked.done;
    chunk({ content: answer.content });
    const link = deps.link(answer.sessionId, answer.chairId);
    chunk({ content: `\n\n${roundLink(link, answer, linkLabel(answer.content))}` });
    chunk({}, 'stop', {
      divan: { session_id: answer.sessionId, round_id: answer.chairId, cached: answer.cached },
    });
    if (wantUsage) {
      write(
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: usageBlock(answer) })}\n\n`,
      );
    }
  } catch (error) {
    const known = error instanceof GatewayError;
    write(
      `data: ${JSON.stringify({
        error: {
          message: known ? error.message : 'internal error',
          type: errorType(known ? error.status : 500),
          code: known ? error.code : 'internal',
        },
      })}\n\n`,
    );
  } finally {
    finished = true;
    clearInterval(keepalive);
    unsubscribe();
    write('data: [DONE]\n\n');
    if (!res.writableEnded) res.end();
  }
}
