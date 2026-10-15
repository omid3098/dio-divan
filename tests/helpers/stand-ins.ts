// Inert stand-ins for the assistants' command-line programs, so that a test of what an adapter builds does not depend on
// which of `claude`, `codex`, `grok` and `pi` this computer has (a clean CI machine has none), and never runs a real one.
// The adapters resolve a command on PATH (`resolveCommand`, src/server/proc.ts); the stand-ins are found the same way:
// an executable script on Unix, an npm-style `.cmd` shim on Windows, both running one Node script. By default that script
// prints a line and exits; a test that needs a program with some behaviour (one that hangs) passes the script's source.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

/**
 * Puts a stand-in for each name in `dir` and puts `dir` first on PATH (`only`: alone on it, so that no real program can be
 * found at all). Returns the function that puts PATH back.
 */
export function installStandIns(
  dir: string,
  names: readonly string[],
  options: { body?: string; only?: boolean } = {},
): () => void {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const script = join(dir, `${name}-stand-in.js`);
    writeFileSync(
      script,
      options.body ??
        `console.error(${JSON.stringify(`stand-in for ${name}: not a real assistant`)});\n`,
    );
    if (process.platform === 'win32') {
      writeFileSync(join(dir, `${name}.cmd`), `@ECHO off\r\n"%~dp0${name}-stand-in.js" %*\r\n`);
    } else {
      const file = join(dir, name);
      writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
      chmodSync(file, 0o755);
    }
  }
  const was = process.env.PATH;
  process.env.PATH = options.only || !was ? dir : `${dir}${delimiter}${was}`;
  return () => {
    if (was === undefined) delete process.env.PATH;
    else process.env.PATH = was;
  };
}
