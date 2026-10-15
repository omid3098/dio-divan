// The trust boundary of the local server. Anything that can reach 127.0.0.1 could ask it to start agents, so every API
// and SSE call needs the per-server token, and the Host, Origin and Fetch-Metadata headers must say the call comes from
// our own page: no other website can drive the server, and DNS rebinding fails on the Host check.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { ensureOwnerOnly, ownerOnly } from './secure.ts';
import { writeFileAtomic } from './store.ts';

export const TOKEN_HEADER = 'x-divan-token';

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export type Verdict = { ok: true } | { ok: false; status: number; code: string };

function sameToken(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Host names our server answers to. */
export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export interface GuardOptions {
  token: string;
  port: number;
}

/**
 * `api`: needs the token, a matching Host, a matching Origin when one is sent, no cross-site Fetch-Metadata, and a JSON
 * body type on anything that changes state. `static`: the page itself carries no secret, so it needs only the Host check.
 */
export function checkRequest(
  req: IncomingMessage,
  kind: 'api' | 'static',
  options: GuardOptions,
): Verdict {
  const hosts = allowedHosts(options.port);
  const host = req.headers.host;
  if (!host || !hosts.includes(host.toLowerCase()))
    return { ok: false, status: 403, code: 'bad_host' };
  if (kind === 'static') return { ok: true };

  const origin = req.headers.origin;
  if (origin !== undefined && !hosts.some((allowed) => origin === `http://${allowed}`)) {
    return { ok: false, status: 403, code: 'bad_origin' };
  }
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, status: 403, code: 'cross_site' };
  }
  const given = req.headers[TOKEN_HEADER];
  if (!sameToken(Array.isArray(given) ? given[0] : given, options.token)) {
    return { ok: false, status: 401, code: 'bad_token' };
  }
  const method = req.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    const type = req.headers['content-type'] ?? '';
    const hasBody =
      req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0';
    if (hasBody && !/^application\/json\b/iu.test(type)) {
      return { ok: false, status: 415, code: 'bad_content_type' };
    }
  }
  return { ok: true };
}

// ---------- the OpenAI-compatible endpoint (/v1) ----------

/** How long a key file that was just made is given to be written (a slow PC, a security scan) before it is called empty. */
const KEY_WRITE_GRACE_MS = 10_000;

/** The persistent key clients send as a Bearer token: made once, kept in the home folder. */
export async function loadApiKey(home: string): Promise<string> {
  const file = join(home, 'api-key');
  const usable = (): string | null => {
    try {
      const key = readFileSync(file, 'utf8').trim();
      return key.length >= 24 ? key : null;
    } catch {
      return null;
    }
  };
  mkdirSync(home, { recursive: true });
  const key = `divan-${randomBytes(32).toString('base64url')}`;
  for (let attempt = 0; ; attempt += 1) {
    const have = usable();
    if (have) {
      // An existing key that other accounts could read (an older file, a changed folder) is made owner-only again.
      ensureOwnerOnly(file, false);
      return have;
    }
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      // An exclusive create: a key somebody else made is never replaced.
      handle = await open(file, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The file is there. If it was made a moment ago its writer may not have finished (wait for it and read what it wrote,
      // however slow a loaded PC is); a file that has long been there and is not a key (empty, too short) is replaced, whole.
      const fresh = (() => {
        try {
          return Date.now() - statSync(file).mtimeMs < KEY_WRITE_GRACE_MS;
        } catch {
          return true;
        }
      })();
      if (fresh && attempt < KEY_WRITE_GRACE_MS / 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        continue;
      }
      await writeFileAtomic(file, `${key}\n`, true);
      return key;
    }
    try {
      // Owner-only before the secret is written, so it is never readable by another account, not even for a moment.
      ownerOnly(file, false);
      await handle.writeFile(`${key}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return key;
  }
}

/**
 * `/v1` is for programs, never for web pages. A browser always sends `Origin` on a cross-origin request and always adds
 * `Sec-Fetch-Site` and `Sec-Fetch-Dest` (names a page's script cannot set or remove), so a request carrying any of those
 * is refused before anything else: a website cannot call it, with or without a key. `Sec-Fetch-Mode` alone does not
 * count: Node's own `fetch` (what the OpenAI SDK and Pi use) sends just that one. Then the Host must be ours and the
 * Bearer key must match.
 */
export function checkApiRequest(
  req: IncomingMessage,
  options: { key: string; port: number },
): Verdict {
  const host = req.headers.host;
  if (!host || !allowedHosts(options.port).includes(host.toLowerCase())) {
    return { ok: false, status: 403, code: 'bad_host' };
  }
  const fromBrowser = ['origin', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user'].some(
    (name) => req.headers[name] !== undefined,
  );
  if (fromBrowser) return { ok: false, status: 403, code: 'browser_request' };
  const header = req.headers.authorization;
  const given = /^Bearer\s+(\S+)\s*$/iu.exec(typeof header === 'string' ? header : '')?.[1];
  if (!sameToken(given, options.key)) return { ok: false, status: 401, code: 'bad_key' };
  return { ok: true };
}

export const SECURITY_HEADERS: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};
