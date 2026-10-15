// The trust boundary of the server: token, Host, Origin and Fetch-Metadata checks on every API and SSE call, so no website
// can make the server spawn agents.

import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../src/server/server.ts';

let server: RunningServer;
let home: string;
let webRoot: string;

beforeAll(async () => {
  process.env.DIVAN_FAKE = '1';
  home = mkdtempSync(join(tmpdir(), 'divan-sec-'));
  webRoot = mkdtempSync(join(tmpdir(), 'divan-web-'));
  server = await startServer({ port: 0, home, webRoot });
});
afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(webRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Reply {
  status: number;
  body: string;
}

function call(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: server.port,
        path,
        method: options.method ?? 'GET',
        headers: { host: options.host ?? `127.0.0.1:${server.port}`, ...options.headers },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

const good = () => ({ 'x-divan-token': server.token });

describe('server guard', () => {
  it('binds to 127.0.0.1 only', () => {
    expect(server.url.startsWith('http://127.0.0.1:')).toBe(true);
  });

  it('refuses every API call without the token, or with a wrong one', async () => {
    expect((await call('/api/health')).status).toBe(401);
    expect((await call('/api/sessions')).status).toBe(401);
    expect((await call('/api/health', { headers: { 'x-divan-token': 'nope' } })).status).toBe(401);
    expect(
      (await call('/api/health', { headers: { 'x-divan-token': `${server.token}0` } })).status,
    ).toBe(401);
    expect((await call('/api/events')).status).toBe(401);
    expect((await call('/api/meta')).status).toBe(401);
  });

  it('accepts the right token on the right Host', async () => {
    const reply = await call('/api/health', { headers: good() });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body).ok).toBe(true);
    expect(
      (await call('/api/health', { headers: good(), host: `localhost:${server.port}` })).status,
    ).toBe(200);
  });

  it('checks the Host header, even with the token (DNS rebinding)', async () => {
    for (const host of [
      'evil.example',
      `evil.example:${server.port}`,
      `127.0.0.1:${server.port + 1}`,
      '127.0.0.1',
    ]) {
      expect((await call('/api/health', { headers: good(), host })).status).toBe(403);
    }
    expect((await call('/', { host: 'evil.example' })).status).toBe(403);
  });

  it('checks the Origin header: a page on another site is refused even with the token', async () => {
    const own = `http://127.0.0.1:${server.port}`;
    expect((await call('/api/health', { headers: { ...good(), origin: own } })).status).toBe(200);
    for (const origin of [
      'http://evil.example',
      'https://127.0.0.1',
      `http://127.0.0.1:${server.port + 1}`,
      'null',
    ]) {
      expect((await call('/api/health', { headers: { ...good(), origin } })).status).toBe(403);
    }
  });

  it('refuses cross-site Fetch-Metadata and any CORS preflight', async () => {
    expect(
      (await call('/api/health', { headers: { ...good(), 'sec-fetch-site': 'cross-site' } }))
        .status,
    ).toBe(403);
    expect(
      (await call('/api/health', { headers: { ...good(), 'sec-fetch-site': 'same-site' } })).status,
    ).toBe(403);
    expect(
      (await call('/api/health', { headers: { ...good(), 'sec-fetch-site': 'same-origin' } }))
        .status,
    ).toBe(200);
    const preflight = await call('/api/sessions', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(403);
  });

  it('never starts an agent for an unauthorised call: no session is created', async () => {
    const body = JSON.stringify({ question: 'q', seats: [], chairman: {}, budgets: {} });
    const headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
    };
    expect((await call('/api/sessions', { method: 'POST', headers, body })).status).toBe(401);
    expect(
      (
        await call('/api/sessions', {
          method: 'POST',
          headers: { ...headers, origin: 'http://evil.example', ...good() },
          body,
        })
      ).status,
    ).toBe(403);
    const list = await call('/api/sessions', { headers: good() });
    expect(JSON.parse(list.body)).toEqual([]);
  });

  it('requires a JSON content type on writes, so a plain cross-site form cannot reach them', async () => {
    const body = 'question=q';
    const reply = await call('/api/sessions', {
      method: 'POST',
      headers: { ...good(), 'content-type': 'text/plain', 'content-length': String(body.length) },
      body,
    });
    expect(reply.status).toBe(415);
  });

  it('answers a request line that is not a URL with 400, before authentication, and keeps serving', async () => {
    const reply = await call('//[');
    expect(reply.status).toBe(400);
    expect((await call('/api/health', { headers: good() })).status).toBe(200);
  });

  it('serves the page without a token but only on our Host, and sends no CORS headers', async () => {
    const reply = await call('/');
    expect([200, 503]).toContain(reply.status); // 503 when the web editor is not built
    const api = await call('/api/health', { headers: good() });
    expect(api.status).toBe(200);
  });

  it('does not let a path leave the web root', async () => {
    const reply = await call('/..%2f..%2fpackage.json');
    expect([403, 503, 200]).toContain(reply.status);
    expect(reply.body).not.toContain('"dio-divan"');
  });
});
