#!/usr/bin/env node
// The `divan` command (npm package `dio-divan`): starts the local server (or reports the one already running) and prints its URL.
// `divan acp` is the Agent Client Protocol bridge for T3 Code: it is dispatched before the CLI is imported, so that a
// bridge process (one per T3 thread) never loads the server code. An error is written to stderr: stdout of the bridge
// carries protocol messages only.
import { existsSync } from 'node:fs';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 21)) {
  console.error('Dio Divan needs Node 24.21 or newer. Update Node and run divan again.');
  process.exit(1);
}
const argv = process.argv.slice(2);
const source = existsSync(new URL('../src/server/cli.ts', import.meta.url));
const entry = (name) =>
  new URL(source ? `../src/server/${name}.ts` : `../dist/server/${name}.js`, import.meta.url).href;

const main =
  argv[0] === 'acp'
    ? argv.length === 1
      ? import(entry('acp')).then(({ runAcp }) => runAcp())
      : Promise.reject(new Error('Usage: divan acp'))
    : import(entry('cli')).then(({ runCli }) => runCli(argv));

main.catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
