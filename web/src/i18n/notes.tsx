// The server's messages in the language in force. The server sends a code and parameters (and an English text as a fallback,
// `src/shared/messages.ts`); the catalogues hold `msg.<code>` in each language. A code the catalogues do not know yet (a
// newer server) is shown in the server's English.

import type { ReactNode } from 'react';
import { Ltr, Mono } from '@/components/bidi';
import type { MessageParams } from '../../../src/shared/messages.ts';
import { faDateTime } from '../../../src/shared/text.ts';
import { currentLang, hasKey, type Key, type Params, translate, useI18n } from './index.tsx';

/** What the server sends for a sentence: the code, its parameters and its English text. */
export interface Coded {
  code: string;
  params?: MessageParams | undefined;
  message: string;
}

const groups = new Intl.NumberFormat('en-US');
const dateEn = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** Parameters ready for a sentence: toggle/level by their interface words, a local-calendar time, numbers grouped. */
function wordParams(
  params: MessageParams | undefined,
  skip: ReadonlySet<string> = new Set(),
): Params {
  const out: Params = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (skip.has(name)) continue;
    if (name === 'toggle') out[name] = translate(`ss.${value}` as Key);
    else if (name === 'level' && hasKey(`level.${value}`))
      out[name] = translate(`level.${value}` as Key);
    else if (name === 'until') {
      out[name] =
        currentLang() === 'fa' ? faDateTime(String(value)) : dateEn.format(new Date(String(value)));
    } else out[name] = typeof value === 'number' ? groups.format(value) : value;
  }
  return out;
}

/** The text of a sentence from the server, in the language in force. */
export function noteText(note: Coded): string {
  const key = `msg.${note.code}`;
  return hasKey(key) ? translate(key, wordParams(note.params)) : note.message;
}

/** Parameters that are machine values: a model, a provider, a seat id keep their shape in a right-to-left sentence. */
const MONO = new Set(['model', 'provider', 'seat', 'file', 'path', 'folder']);
const ISLAND = new Set(['harness', 'detail', 'time']);

/** Sentences from the server as text, or as nodes whose machine values are set left to right. */
export function useNotes(): { text: (note: Coded) => string; node: (note: Coded) => ReactNode } {
  const { tx } = useI18n();
  return {
    text: noteText,
    node: (note) => {
      const key = `msg.${note.code}`;
      if (!hasKey(key)) return note.message;
      const raw = note.params ?? {};
      const parts: Record<string, ReactNode> = {};
      for (const [name, value] of Object.entries(raw)) {
        if (MONO.has(name)) parts[name] = <Mono>{String(value)}</Mono>;
        else if (ISLAND.has(name)) parts[name] = <Ltr>{String(value)}</Ltr>;
      }
      return tx(key, parts, wordParams(raw, new Set([...MONO, ...ISLAND])));
    },
  };
}

/** A stable React key for a note. */
export const noteKey = (note: Coded): string => `${note.code}:${JSON.stringify(note.params ?? {})}`;
