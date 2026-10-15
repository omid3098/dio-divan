// Talking to the local server: every call carries the per-server token (kept in sessionStorage after it is read once
// from the URL fragment, which the server never sees). Live progress comes over Server-Sent Events read with fetch, so
// the token travels in a header and never in a URL.

import type { MessageParams } from '../../src/shared/messages.ts';
import type { ServerEvent } from '../../src/shared/types.ts';
import { noteText } from './i18n/notes.tsx';

const TOKEN_KEY = 'divan-token';

/**
 * Reads `#token=…` once, stores it and clears the fragment. A link an endpoint client was given adds `&to=/s/<session>/n/<round>`:
 * the page opens on that round.
 */
export function initToken(): void {
  const found = /token=([a-f0-9]+)/u.exec(window.location.hash);
  if (found?.[1]) {
    sessionStorage.setItem(TOKEN_KEY, found[1]);
    const to = /[#&]to=([^&]+)/u.exec(window.location.hash)?.[1];
    const target = to ? decodeURIComponent(to) : '';
    const hash = /^\/s\/[A-Za-z0-9_-]+(?:\/n\/[A-Za-z0-9_-]+)?$/u.test(target)
      ? `#${target}`
      : '#/';
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  }
}

const token = () => sessionStorage.getItem(TOKEN_KEY) ?? '';
export const hasToken = () => token() !== '';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  /** The whole answer of the server (a 409 carries the current state the caller must adopt). */
  readonly body: Record<string, unknown>;
  /** The parameters of the code, when the message has any. */
  readonly params: MessageParams | undefined;
  /** The `message` is the code worded in the language in force (the server's English when the code is not known here). */
  constructor(status: number, code: string, message: string, body: Record<string, unknown> = {}) {
    const params =
      body.params && typeof body.params === 'object' ? (body.params as MessageParams) : undefined;
    super(noteText({ code, params, message }));
    this.params = params;
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      'x-divan-token': token(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const info = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      info.error ?? 'error',
      info.message ?? `HTTP ${response.status}`,
      (data && typeof data === 'object' ? data : {}) as Record<string, unknown>,
    );
  }
  return data as T;
}

/** Opens the event stream; reconnects after a drop. Returns a function that closes it. */
export function connectEvents(
  onEvent: (event: ServerEvent) => void,
  onStatus: (connected: boolean) => void,
): () => void {
  let stopped = false;
  let controller: AbortController | null = null;

  const run = async () => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const response = await fetch('/api/events', {
          headers: { 'x-divan-token': token() },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(String(response.status));
        onStatus(true);
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut = buffer.indexOf('\n\n');
          while (cut !== -1) {
            const block = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            const data = block
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trim())
              .join('');
            if (data) {
              try {
                onEvent(JSON.parse(data) as ServerEvent);
              } catch {
                // a malformed event is skipped
              }
            }
            cut = buffer.indexOf('\n\n');
          }
        }
      } catch {
        // fall through to the retry
      }
      onStatus(false);
      if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
