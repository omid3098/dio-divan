// What a council member must not read, wherever the harness has path rules (Claude Code and Grok) and in the Pi extension's
// guard: Divan's own home (it holds every saved session, with the other members' answers and other branches), the
// harnesses' own folders (history, sessions). Members use each harness's normal reach, but never these.

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { canonical } from '../canonical.ts';
import { defaultHome } from '../store.ts';

/** Where each harness keeps its own files: its usual folder, and the one an environment variable moves it to (both are closed). */
const where = (usual: string[], variable: string | undefined): string[] => [
  join(homedir(), ...usual),
  ...(variable ? [variable] : []),
];
const claudeDirs = () => where(['.claude'], process.env.CLAUDE_CONFIG_DIR);
const codexDirs = () => where(['.codex'], process.env.CODEX_HOME);
const grokDirs = () => where(['.grok'], process.env.GROK_HOME);
const piDirs = () => where(['.pi', 'agent'], process.env.PI_CODING_AGENT_DIR);
const hermesDirs = () => [
  join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'hermes'),
  ...where(['.hermes'], process.env.HERMES_HOME),
  ...(process.env.HERMES_PROFILE_HOME ? [process.env.HERMES_PROFILE_HOME] : []),
];

const bothNames = (paths: string[]): string[] => [
  ...new Set(paths.flatMap((path) => [resolve(path), canonical(path)])),
];

/** The folders kept from the council, by the name they are known by and by their real name (an alias is no way round). */
export function hiddenFolders(): string[] {
  const home = homedir();
  return bothNames([
    defaultHome(),
    join(home, '.dio-divan'),
    join(home, '.claude'),
    join(home, '.codex'),
    join(home, '.grok'),
    join(home, '.pi'),
    join(home, '.gemini'),
    join(home, '.agents'),
    ...claudeDirs(),
    ...codexDirs(),
    ...grokDirs(),
    ...piDirs(),
    ...hermesDirs(),
  ]);
}

/** `~/rest` for a path under the user's home, else the absolute path with forward slashes. */
export function homeRelative(folder: string): string {
  const home = resolve(homedir());
  if (folder === home || folder.startsWith(home + sep)) {
    return `~${folder.slice(home.length).split(sep).join('/')}`;
  }
  return folder.split(sep).join('/');
}
