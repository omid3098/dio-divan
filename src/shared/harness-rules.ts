// What each harness can and cannot do under the rule that council members only read. One table, read by the adapters
// (their `info`), the defaults, the server (which rejects an impossible configuration) and the setup screen.
// A toggle's lines are message codes (`<code>_short`: the one plain line setup shows on a seat; `<code>_note`: the full
// explanation, behind the details), worded in the interface's language by the client; the English is carried along.

import { MESSAGES, type MessageCode, type Note, note } from './messages.ts';
import type { HarnessId, ToggleMode, ToggleSupport } from './types.ts';

export type ToggleKey = 'tools' | 'memory' | 'web';
export const TOGGLE_KEYS: ToggleKey[] = ['tools', 'memory', 'web'];

/** A toggle with something to say: its code is the stem of two messages. */
const said = (mode: ToggleMode, code: string): ToggleSupport => ({
  mode,
  code,
  short: MESSAGES[`${code}_short` as MessageCode],
  note: MESSAGES[`${code}_note` as MessageCode],
});

const free: ToggleSupport = { mode: 'free', code: '', short: '', note: '' };

export interface HarnessRule {
  /** False: the harness is refused as a member and as the chairman. */
  supported: boolean;
  manualOnly?: boolean;
  unenforced?: boolean;
  /** The reason shown in setup when it is not supported. */
  unsupportedNote: Note | null;
  tools: ToggleSupport;
  memory: ToggleSupport;
  web: ToggleSupport;
}

export const HARNESS_RULES: Record<HarnessId, HarnessRule> = {
  hermes: {
    supported: true,
    unsupportedNote: null,
    tools: said('free', 'hermes_tools'),
    memory: said('free', 'hermes_memory'),
    web: said('blocked', 'hermes_web'),
  },
  claude: {
    supported: true,
    unsupportedNote: null,
    // Full reach with read-only enforced: the read tools, the memory server's read tools, code and mail reading; the folders of
    // Divan and of the harnesses' own folders and credential files are denied to them.
    tools: free,
    memory: said('free', 'claude_memory'),
    web: free,
  },
  codex: {
    supported: true,
    unsupportedNote: null,
    tools: said('forced-on', 'codex_tools'),
    memory: said('free', 'codex_memory'),
    web: free,
  },
  agy: {
    supported: true,
    manualOnly: true,
    unenforced: true,
    unsupportedNote: null,
    tools: said('uncontrolled', 'agy_controlled'),
    memory: said('uncontrolled', 'agy_controlled'),
    web: said('uncontrolled', 'agy_controlled'),
  },
  grok: {
    supported: true,
    unsupportedNote: null,
    tools: said('forced-on', 'grok_tools'),
    memory: said('free', 'grok_memory'),
    web: free,
  },
  pi: {
    supported: true,
    unsupportedNote: null,
    tools: said('free', 'pi_tools'),
    memory: said('free', 'pi_memory'),
    web: said('blocked', 'pi_web'),
  },
};

/** The value a toggle is held at: true when forced on, false when blocked, null when free. */
export function heldValue(harness: HarnessId, key: ToggleKey): boolean | null {
  const mode = HARNESS_RULES[harness][key].mode;
  return mode === 'forced-on' ? true : mode === 'blocked' ? false : null;
}

/** The seat's toggles with every forced-on and blocked one put at the value the harness holds it at. */
export function normalizeToggles<T extends Record<ToggleKey, boolean>>(
  harness: HarnessId,
  seat: T,
): T {
  const next = { ...seat };
  for (const key of TOGGLE_KEYS) {
    const held = heldValue(harness, key);
    if (held !== null) next[key] = held as T[ToggleKey];
  }
  return next;
}

/** The reason a configuration is impossible for the harness (a toggle off that cannot be off, or on that cannot be on). */
export function toggleProblem(harness: HarnessId, seat: Record<ToggleKey, boolean>): Note | null {
  if (!HARNESS_RULES[harness].supported) return HARNESS_RULES[harness].unsupportedNote;
  for (const key of TOGGLE_KEYS) {
    const held = heldValue(harness, key);
    if (held !== null && seat[key] !== held) {
      return note(held ? 'toggle_forced_on' : 'toggle_blocked', { toggle: key });
    }
  }
  return null;
}
