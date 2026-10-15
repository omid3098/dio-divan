// What each harness says about a toggle (tools, memory, web). The server sends the code of the toggle's two lines
// (`<code>_short`, `<code>_note`, see `src/shared/harness-rules.ts`) with their English; the catalogues word them
// (`msg.<code>_short`, `msg.<code>_note`) in the language in force.

import { hasKey, translate } from '@/i18n/index.tsx';
import type { ToggleSupport } from '../../../../src/shared/types.ts';

export interface Line {
  short: string;
  note: string;
}

/** The two lines of a toggle in the language in force: the catalogue's, else the server's English. */
export function toggleText(support: Pick<ToggleSupport, 'code' | 'short' | 'note'>): Line {
  const short = `msg.${support.code}_short`;
  const note = `msg.${support.code}_note`;
  return {
    short: hasKey(short) ? translate(short) : support.short,
    note: hasKey(note) ? translate(note) : support.note,
  };
}
