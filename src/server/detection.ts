import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { HARNESS_ORDER } from '../shared/defaults.ts';
import { HARNESS_RULES } from '../shared/harness-rules.ts';
import { note } from '../shared/messages.ts';
import type { HarnessId, HarnessModels, HarnessStatus } from '../shared/types.ts';
import { claudeAliases } from './adapters/claude.ts';
import { hermesModels } from './adapters/hermes.ts';
import { discoverHermes } from './adapters/hermes-install.ts';
import { adapterFor, isFake, modelsFor } from './adapters/index.ts';
import { resolveCommand } from './proc.ts';

export interface Found {
  status: HarnessStatus[];
  models: HarnessModels[];
  detectedAt: string;
}

let last: Found | undefined;
let checking: Promise<Found> | undefined;

export class DetectionError extends Error {}

/**
 * Where an official installer puts an assistant's program, when that is documented: Claude Code's installer writes
 * `~/.local/bin/claude` (`claude.exe` on Windows) and edits no shell profile; Grok's PowerShell installer writes
 * `%USERPROFILE%\.grok\bin\grok.exe` (its macOS and Linux location is not documented, so it is not looked for). The program is
 * only found there, never run from there: a person who has it installed there but not on PATH is told to put it on PATH.
 */
export function offPathProgram(id: HarnessId): string | null {
  const windows = process.platform === 'win32';
  const folder =
    id === 'claude'
      ? join(homedir(), '.local', 'bin')
      : id === 'grok' && windows
        ? join(homedir(), '.grok', 'bin')
        : null;
  const file = folder ? join(folder, windows ? `${id}.exe` : id) : null;
  return file && existsSync(file) ? file : null;
}

/** One explicit shared check; a failed assistant keeps its previous result. */
export function detect(refresh = false): Promise<Found> {
  if (last && !refresh) return Promise.resolve(last);
  if (checking) return checking;
  checking = find(refresh)
    .then((found) => {
      for (const [index, item] of found.status.entries()) {
        if (
          [
            'models_list_failed',
            'grok_login_unknown',
            'claude_login_unknown',
            'codex_login_unknown',
          ].includes(item.note?.code ?? '')
        ) {
          const previous = last?.status.find((old) => old.id === item.id);
          if (previous && refresh) {
            found.status[index] = { ...previous, notRechecked: true };
            found.models = found.models.filter((list) => list.harness !== item.id);
            found.models.push(...(last?.models.filter((list) => list.harness === item.id) ?? []));
          }
        }
      }
      const claude = found.status.find((item) => item.id === 'claude');
      const list = found.models.find((item) => item.harness === 'claude');
      if (claude?.usable && list && !list.listed && !list.models.length) {
        Object.assign(list, claudeAliases());
        claude.note = note('models_claude_aliases');
      }
      found.models.sort(
        (a, b) => HARNESS_ORDER.indexOf(a.harness) - HARNESS_ORDER.indexOf(b.harness),
      );
      last = found;
      return found;
    })
    .finally(() => {
      checking = undefined;
    });
  return checking;
}

async function find(refresh: boolean): Promise<Found> {
  // Test-only inventory, never consulted by a real server.
  if (isFake() && process.env.DIVAN_FAKE_DETECTION) {
    const found = JSON.parse(process.env.DIVAN_FAKE_DETECTION) as Found;
    return { ...found, detectedAt: new Date().toISOString() };
  }
  const models: HarnessModels[] = [];
  const status = await Promise.all(
    HARNESS_ORDER.map(async (id): Promise<HarnessStatus> => {
      if (id === 'hermes' && !isFake()) {
        const found = await discoverHermes();
        const list = hermesModels(found);
        models.push(list);
        return {
          id,
          installed: found.installed,
          usable: found.problem === null && found.routes.length > 0,
          note: list.note,
        };
      }
      if (id === 'hermes' && process.platform !== 'win32')
        return { id, installed: false, usable: false, note: note('hermes_platform') };
      const installed = isFake() ? HARNESS_RULES[id].supported : resolveCommand(id) !== null;
      if (!installed) {
        const found = isFake() ? null : offPathProgram(id);
        return {
          id,
          installed: false,
          usable: false,
          note: found
            ? note('harness_off_path', { path: found, folder: dirname(found) })
            : note('harness_missing'),
        };
      }
      if (!HARNESS_RULES[id].supported)
        return { id, installed: true, usable: false, note: HARNESS_RULES[id].unsupportedNote };
      const list = await modelsFor(id, refresh);
      models.push(list);
      const problem = isFake() ? null : await adapterFor(id).check?.();
      if (problem) return { id, installed: true, usable: false, note: problem };
      if (
        ['models_list_failed', 'grok_not_logged_in', 'grok_login_unknown'].includes(
          list.note?.code ?? '',
        )
      )
        return { id, installed: true, usable: false, note: list.note };
      if (list.models.length === 0) {
        // Keep the signed-in empty state usable so the documented alias fallback below can fill it.
        return {
          id,
          installed: true,
          usable:
            (id === 'claude' && !list.listed) ||
            (id === 'agy' && list.note?.code === 'agy_models_typed'),
          note:
            id === 'agy' || id === 'hermes'
              ? list.note
              : note(id === 'claude' ? 'models_claude_none' : 'harness_no_models'),
        };
      }
      return {
        id,
        installed: true,
        usable: true,
        note: list.aliases ? note('models_claude_aliases') : null,
      };
    }),
  );
  return {
    status,
    models: HARNESS_ORDER.flatMap((id) => models.filter((item) => item.harness === id)),
    detectedAt: new Date().toISOString(),
  };
}
