// How a council member's harness starts Divan's T3 threads server (`src/server/t3-mcp.ts`), and which servers a seat reaches:
// the allowlist (`src/shared/readonly-tools.ts`) less the T3 server on a computer that has no T3 Code database.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  type ReadOnlyServer,
  serversFor,
  T3_SERVER,
  type Toggles,
} from '../shared/readonly-tools.ts';
import type { HarnessId } from '../shared/types.ts';
import { T3_DB_ENV, t3Available, t3DbPath } from './t3-threads.ts';

/** The server's script (run by `node`, which strips the types itself). */
export const T3_SCRIPT = fileURLToPath(
  new URL(import.meta.url.endsWith('.js') ? './t3-mcp.js' : './t3-mcp.ts', import.meta.url),
);

export interface T3Launch {
  command: string;
  args: string[];
  /** The database file, so the server never depends on the harness passing the home folder on. */
  env: Record<string, string>;
}

/** The command that starts the server: this Node, the script, and the database path in its environment. */
export function t3Launch(): T3Launch {
  return {
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', T3_SCRIPT],
    env: { [T3_DB_ENV]: t3DbPath() },
  };
}

/** The servers a seat reaches in a harness: the allowlist's, minus the T3 server where there is no T3 database to read. */
export function memberServers(harness: HarnessId, toggles: Toggles): ReadOnlyServer[] {
  return serversFor(harness, toggles).filter(
    (server) =>
      server.name !== T3_SERVER || (harness === 'hermes' ? existsSync(t3DbPath()) : t3Available()),
  );
}
