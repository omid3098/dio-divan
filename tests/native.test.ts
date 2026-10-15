// The server runs on Node's own TypeScript support, with no build step: only syntax that can be erased is allowed (no
// parameter properties, enums or namespaces). Vitest compiles the full language and would not notice one, so every entry
// of the server and the Pi extension is loaded here by a plain `node`, as the real thing is.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

describe('the sources load under Node’s own TypeScript support', () => {
  for (const entry of [
    'src/server/server.ts',
    'src/server/cli.ts',
    'src/server/launch.ts',
    'src/server/acp.ts',
    'src/server/adapters/index.ts',
    'src/server/output.ts',
    'src/server/proc.ts',
    'pi-extension/index.ts',
  ]) {
    it(entry, () => {
      const url = pathToFileURL(join(root, entry)).href;
      const out = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `await import(${JSON.stringify(url)}); console.log('loaded');`,
        ],
        { encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      expect(out.trim()).toBe('loaded');
    });
  }
});
