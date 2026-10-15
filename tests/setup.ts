// Every test file starts with a Divan home of its own, so that no test can read or write the real one (its sessions, its
// API key, the read-only memory token, T3's database). A test that wants another home sets `DIVAN_HOME` itself.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const own = process.env.DIVAN_HOME ? null : mkdtempSync(join(tmpdir(), 'divan-test-home-'));
if (own) process.env.DIVAN_HOME = own;
// T3 Code's database is not there for a test: no run is given the T3 threads server unless the test makes a fixture and names it
// in `DIVAN_T3_DB`. (The real database of this computer is never read by a test.)
process.env.DIVAN_T3_DB ??= join(process.env.DIVAN_HOME as string, 'no-t3-database.sqlite');
afterAll(() => {
  if (own) rmSync(own, { recursive: true, force: true });
});
