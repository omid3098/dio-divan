// How a council member reaches the memory server (Omid's decision):
//   - Claude Code and Codex use their OWN memory connection, as in normal use (the owner token of their own config); the
//     harness's flags and the allowlist (`src/shared/readonly-tools.ts`) keep them read-only.
//   - Grok and Pi use Divan's READ-ONLY token (`<home>/memory-ro-token`, a client of the memory server with a read profile):
//     the server itself refuses every write for it. Without that token they have no memory at all, and the owner tokens are
//     taken out of their environment.
//
// Nothing here prints or logs a token. A token travels to a child in an environment variable and is named in a config as
// `${VAR}`: it is not written into a file of ours at all (the token file itself is read at the moment a run starts).

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { MEMORY_SERVER, serversFor } from '../shared/readonly-tools.ts';
import type { HarnessId } from '../shared/types.ts';
import { cachedHermes, hermesKey } from './adapters/hermes-install.ts';
import { asRecord } from './adapters/util.ts';
import { defaultHome } from './store.ts';

/** The harnesses whose memory goes through Divan's read-only token, and not through their own connection. */
export const USES_READ_ONLY_TOKEN: readonly HarnessId[] = ['grok', 'pi'];

/** The file in Divan's home that holds the read-only token (owner-only). Read when a run starts; never printed or logged. */
export const RO_TOKEN_FILE = 'memory-ro-token';

/** The variable a member's child process gets the token in; its config names it as `${DIVAN_MEMORY_TOKEN}`. */
export const TOKEN_ENV = 'DIVAN_MEMORY_TOKEN';

const roTokenPath = (home: string) => join(home, RO_TOKEN_FILE);

/** `${NAME}`: how a harness's config names an environment variable (a header value is read from it when the harness starts). */
export const envRef = (name: string): string => ['$', '{', name, '}'].join('');

/** A token as the memory server issues it: printable characters only, no spaces, long enough to be one. */
const isToken = (text: string): boolean =>
  text.length >= 16 && text.length <= 512 && !/[^\x21-\x7e]/u.test(text);

/** The read-only token, or null when Divan has none (or the file holds something that is not a token). */
export function readReadOnlyToken(home: string = defaultHome()): string | null {
  try {
    const text = readFileSync(roTokenPath(home), 'utf8').trim();
    return isToken(text) ? text : null;
  } catch {
    return null;
  }
}

// ---------- the owner's own memory connection, per harness (to find the server's address, never to copy a secret) ----------

export interface MemoryEntry {
  /** The server's address; null for an entry that is not an HTTP one (a local process). */
  url: string | null;
  /** The entry as the harness's config holds it (JSON configs only): used as it is when no read-only token is kept. */
  raw: Record<string, unknown> | null;
  /** The environment variable the harness names its bearer token by (Codex's `bearer_token_env_var`), if any. */
  tokenEnv: string | null;
}

const claudeFile = () =>
  process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : join(homedir(), '.claude.json');
const codexFile = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const grokFile = () => join(process.env.GROK_HOME ?? join(homedir(), '.grok'), 'config.toml');
const piFile = () =>
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'mcp.json');

function readJson(file: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

/** The `key = "value"` lines of one `[mcp_servers.<name>]` table of a TOML file; nothing is run or evaluated. */
function tomlServer(file: string, name: string): Record<string, string> | null {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const out: Record<string, string> = {};
  let inside = false;
  let found = false;
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header) {
      inside = header[1]?.trim() === `mcp_servers.${name}`;
      found ||= inside;
      continue;
    }
    if (!inside) continue;
    const pair = /^\s*([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/u.exec(line);
    if (pair) out[pair[1] as string] = pair[2] as string;
  }
  return found ? out : null;
}

/** The names of the MCP servers a harness's own TOML config (Codex, Grok) defines. */
export function tomlServerNames(harness: 'codex' | 'grok'): string[] {
  try {
    const text = readFileSync(harness === 'codex' ? codexFile() : grokFile(), 'utf8');
    return [...text.matchAll(/^\s*\[mcp_servers\.("?)([^\]".]+)\1\]\s*$/gmu)].map(
      (found) => found[2] as string,
    );
  } catch {
    return [];
  }
}

/** The memory server as a harness has it in its own config, or null when it has none. */
export function memoryEntry(harness: HarnessId, name = 'memory'): MemoryEntry | null {
  if (harness === 'hermes') {
    const own = name === 'memory' ? cachedHermes()?.memory : null;
    return own
      ? {
          url: own.url,
          raw: {
            url: own.url,
            headers: { Authorization: `Bearer ${envRef(own.headerEnv)}` },
            tools: { include: serversFor('hermes', { tools: false, memory: true })[0]?.read },
            resources: false,
            prompts: false,
          },
          tokenEnv: own.headerEnv,
        }
      : null;
  }
  if (harness === 'claude' || harness === 'pi') {
    const servers = asRecord(readJson(harness === 'claude' ? claudeFile() : piFile())?.mcpServers);
    const raw = asRecord(servers?.[name]);
    return raw ? { url: typeof raw.url === 'string' ? raw.url : null, raw, tokenEnv: null } : null;
  }
  if (harness === 'codex' || harness === 'grok') {
    const table = tomlServer(harness === 'codex' ? codexFile() : grokFile(), name);
    return table
      ? { url: table.url ?? null, raw: null, tokenEnv: table.bearer_token_env_var ?? null }
      : null;
  }
  return null;
}

/** The memory server's address: from this harness's own config, else from another harness's (it is the same server). */
export function memoryUrl(harness: HarnessId): string | null {
  const order: HarnessId[] = [harness, 'claude', 'codex', 'pi', 'grok'];
  for (const id of order) {
    const url = memoryEntry(id)?.url;
    if (url) return url;
  }
  return null;
}

// ---------- the child's environment ----------

const OWNER_TOKEN_NAME = /MEMORY.*(TOKEN|KEY|SECRET)|(TOKEN|KEY|SECRET).*MEMORY/iu;

/**
 * Environment variables a member's child process must not inherit: any that holds a memory token (`MEMORY_TOKEN_CODEX`
 * and the like), as `undefined` (which removes it from the child's environment). `keep` names the one the harness's own
 * memory connection reads, when no read-only token is in use. Our own `DIVAN_MEMORY_TOKEN` is never scrubbed.
 */
export function scrubbedEnv(keep: readonly string[] = []): Record<string, undefined> {
  const out: Record<string, undefined> = {};
  for (const name of Object.keys(process.env)) {
    if (name === TOKEN_ENV || keep.includes(name)) continue;
    if (OWNER_TOKEN_NAME.test(name)) out[name] = undefined;
  }
  return out;
}

/**
 * Whether a member of this harness can be given the memory: the harness is allowed it (`serversFor`) and a connection can
 * be built. Claude Code and Codex use their own (the entry of their config, and for Codex the variable that holds its
 * token); Grok and Pi need the read-only token, and the memory server's address from any config.
 */
export function memoryReady(harness: HarnessId): boolean {
  if (harness === 'hermes') {
    const found = cachedHermes();
    return (
      found !== undefined &&
      found.memory !== null &&
      found.layout !== undefined &&
      hermesKey(found.memory.headerEnv, found.layout.home) !== null
    );
  }
  if (
    !serversFor(harness, { tools: false, memory: true }).some(
      (server) => server.name === MEMORY_SERVER,
    )
  ) {
    return false;
  }
  if (USES_READ_ONLY_TOKEN.includes(harness)) {
    return readReadOnlyToken() !== null && memoryUrl(harness) !== null;
  }
  const own = memoryEntry(harness);
  if (harness === 'codex')
    return own !== null && Boolean(process.env[own.tokenEnv ?? 'MEMORY_TOKEN_CODEX']);
  return own !== null;
}
