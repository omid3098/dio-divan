// The project folder a client of the endpoint works in. The client sends it (`x-divan-cwd`) or, failing that, it is read
// from the system prompt the client's agent wrote. Members read in that folder, so it is checked before it is used: a
// real directory, and never the root of a drive, a Windows or Program Files folder, or a folder Divan keeps apart from
// its council (its own home and the harnesses' history folders).

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { hiddenFolders } from './adapters/paths.ts';
import { canonical, isRemote } from './canonical.ts';

export type CwdVerdict = { ok: true; path: string } | { ok: false; reason: string };

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;

/** Whether `path` is `folder` or inside it. */
function inside(path: string, folder: string): boolean {
  const lower = (text: string) =>
    process.platform === 'win32' || process.platform === 'darwin' ? text.toLowerCase() : text;
  const p = lower(path);
  const f = lower(folder);
  return p === f || p.startsWith(f.endsWith(sep) ? f : f + sep);
}

/** Folders a council member has no business reading as a project (besides those Divan hides). */
function systemFolders(): string[] {
  const env = (name: string) => process.env[name];
  return (
    process.platform === 'win32'
      ? [
          env('SystemRoot'),
          env('windir'),
          env('ProgramFiles'),
          env('ProgramFiles(x86)'),
          env('ProgramData'),
        ]
      : [
          '/etc',
          '/usr',
          '/bin',
          '/sbin',
          '/System',
          '/proc',
          '/dev',
          '/sys',
          '/boot',
          '/lib',
          '/lib64',
        ]
  )
    .filter((folder): folder is string => Boolean(folder))
    .flatMap((folder) => [resolve(folder), canonical(folder)]);
}

/** A folder that exists and may be used as a working folder, as its real path; else the reason it may not. */
export function validateCwd(value: unknown): CwdVerdict {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: 'empty' };
  const text = value.trim().replace(/^["'`]+|["'`]+$/gu, '');
  if (text.length > 500 || text.includes('\0')) return { ok: false, reason: 'not a path' };
  if (!isAbsolute(text) || text.startsWith('\\\\') || text.startsWith('//')) {
    return { ok: false, reason: 'not an absolute local path' };
  }
  let real: string;
  try {
    // Every name a folder has (a junction, a symlink, a mapped drive) resolves to its real one, and only that is judged.
    real = canonical(realpathSync.native(resolve(text)));
    if (!statSync(real).isDirectory()) return { ok: false, reason: 'not a folder' };
  } catch {
    return { ok: false, reason: 'does not exist' };
  }
  if (isRemote(real)) return { ok: false, reason: 'a folder on another machine' };
  if (samePath(parse(real).root, real)) return { ok: false, reason: 'a drive root' };
  if (systemFolders().some((folder) => inside(real, folder))) {
    return {
      ok: false,
      reason:
        process.platform === 'win32' ? 'a Windows or Program Files folder' : 'a system folder',
    };
  }
  const hidden = [...hiddenFolders(), canonical(join(homedir(), '.dio-divan'))];
  if (hidden.some((folder) => inside(real, folder))) {
    return { ok: false, reason: 'a folder that Divan keeps from the council' };
  }
  return { ok: true, path: real };
}

// What an agent's own system prompt says about where it works: Pi and Codex wrap it in <cwd>…</cwd>, Pi and Claude
// Code write a labelled line.
const CWD_PATTERNS = [
  /<cwd>\s*([^\r\n<]+?)\s*<\/cwd>/iu,
  /^\s*[-*]?\s*Primary working directory:\s*(.+?)\s*$/imu,
  /^\s*[-*]?\s*Current working directory:\s*(.+?)\s*$/imu,
  /^\s*[-*]?\s*(?:Working directory|cwd):\s*(.+?)\s*$/imu,
];

/** The working folder a system prompt names, or null. It is only a candidate: `validateCwd` decides. */
export function cwdFromSystemPrompt(text: string): string | null {
  for (const pattern of CWD_PATTERNS) {
    const found = pattern.exec(text)?.[1];
    if (found) return found;
  }
  return null;
}

/** The folder for a request: the header when it is sent, else the system prompt's; with the reason when unusable. */
export function folderFor(
  header: string | undefined,
  systemText: string,
): { path: string | null; note: string | null } {
  let candidate: string | null = null;
  if (header) {
    try {
      candidate = decodeURIComponent(header);
    } catch {
      candidate = header;
    }
  } else {
    candidate = cwdFromSystemPrompt(systemText);
  }
  if (!candidate) return { path: null, note: null };
  const verdict = validateCwd(candidate);
  return verdict.ok
    ? { path: verdict.path, note: null }
    : { path: null, note: `working folder not used (${verdict.reason})` };
}
