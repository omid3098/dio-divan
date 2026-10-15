// Small HTTP helpers shared by the web API and the OpenAI-compatible endpoint.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { messageText } from '../shared/messages.ts';
import { SECURITY_HEADERS } from './security.ts';

/** A failure with an HTTP status and a code; the caller decides how to word it (the two APIs answer differently). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** The body of a request as a JSON object; refuses anything larger than `limit` bytes or not an object. */
export async function readJson(
  req: IncomingMessage,
  limit = 1_000_000,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'too_big', messageText('too_big'));
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'bad_json', messageText('bad_json'));
}
