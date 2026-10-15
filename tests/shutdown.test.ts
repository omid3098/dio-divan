// A shutdown leaves no child behind: once it has begun nothing new is started, so an assistant check that is in flight does not
// go on to its next probe after the one that was running was killed (found on clean Linux: `divan stop` printed "Stopped" while
// `codex login status`, the check's next command, started during the shutdown, outlived the server).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processExists } from '../src/server/launch.ts';
import { allowChildren, killAllChildren, runProc } from '../src/server/proc.ts';
import { installStandIns } from './helpers/stand-ins.ts';

let scratch: string;
const saved: Record<string, string | undefined> = {};
const env = (name: string, value: string | undefined) => {
  if (!(name in saved)) saved[name] = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
let removeStandIns: (() => void) | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'divan-shutdown-'));
});
afterEach(async () => {
  removeStandIns?.();
  removeStandIns = undefined;
  allowChildren();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    delete saved[name];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const lines = (file: string) =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
    : [];

describe('shutdown', () => {
  it('once it has begun the runner starts nothing, and starts again for the next server', async () => {
    const marker = join(scratch, 'ran');
    const run = () =>
      runProc({
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`],
        cwd: scratch,
        idleMs: 10_000,
      });
    await killAllChildren();
    const refused = await run();
    expect(refused.cancelled).toBe(true);
    expect(refused.spawnError).toBeNull();
    expect(existsSync(marker)).toBe(false);
    allowChildren();
    expect((await run()).code).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  it('an assistant check in flight does not start its next probe after the shutdown killed the running one', async () => {
    const log = join(scratch, 'probes.log');
    // Every call of the stand-in `codex` notes its pid and arguments and then hangs. The first probe is `codex debug models`,
    // the next one `codex login status`: with no shutdown, that one would be started after the first is killed.
    removeStandIns = installStandIns(join(scratch, 'bin'), ['codex'], {
      only: true,
      body: `require('node:fs').appendFileSync(process.env.DIVAN_STAND_IN_LOG, process.pid + ' ' + process.argv.slice(2).join(' ') + '\\n');\nsetInterval(() => {}, 1000);\n`,
    });
    env('DIVAN_STAND_IN_LOG', log);
    env('DIVAN_FAKE', undefined);
    env('DIVAN_FAKE_DETECTION', undefined);
    // Hermes is looked for on Windows only, in these places: none of them holds an installation of this computer
    for (const name of [
      'LOCALAPPDATA',
      'HERMES_HOME',
      'HERMES_PROFILE_HOME',
      'USERPROFILE',
      'HOME',
    ]) {
      mkdirSync(join(scratch, name));
      env(name, join(scratch, name));
    }
    const { detect } = await import('../src/server/detection.ts');
    const checking = detect(true);
    const began = Date.now();
    while (lines(log).length === 0 && Date.now() - began < 20_000)
      await new Promise((done) => setTimeout(done, 50));
    expect(lines(log)).toHaveLength(1);
    const first = Number(lines(log)[0]?.split(' ')[0]);
    expect(processExists(first)).toBe(true);

    await killAllChildren();
    // the check ends at once (its probes were killed or refused), not after the 60 seconds a hanging probe is given
    const ended = await Promise.race([
      checking.then(() => true),
      new Promise<boolean>((done) => setTimeout(() => done(false), 15_000)),
    ]);
    expect(ended).toBe(true);
    expect(lines(log)).toHaveLength(1);
    expect(processExists(first)).toBe(false);
  }, 60_000);
});
