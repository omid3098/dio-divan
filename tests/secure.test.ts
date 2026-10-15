// The API key is for its owner alone: created owner-only, and an existing key that others could read is made owner-only again.
// (Windows access lists through `icacls`; elsewhere file modes.)

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isOwnerOnly, ownerOnly, parseWindowsIdentity, secureHome } from '../src/server/secure.ts';
import { loadApiKey } from '../src/server/security.ts';
import { writeFileAtomic } from '../src/server/store.ts';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'divan-secure-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const icacls = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
/** Lets other accounts read `path`: the group Users (by its well-known id) on Windows, group and others elsewhere. */
const exposeToOthers = (path: string, folder = false) => {
  if (process.platform === 'win32') {
    execFileSync(icacls, [path, '/grant', folder ? '*S-1-5-32-545:(OI)(CI)R' : '*S-1-5-32-545:R'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    chmodSync(path, folder ? 0o755 : 0o644);
  }
};

describe('the API key', () => {
  it('is created owner-only, in a home that is owner-only', async () => {
    ownerOnly(home, true);
    expect(isOwnerOnly(home)).toBe(true);
    const key = await loadApiKey(home);
    expect(key).toMatch(/^divan-/u);
    expect(isOwnerOnly(join(home, 'api-key'))).toBe(true);
    // no temp file is left behind
    expect(readFileSync(join(home, 'api-key'), 'utf8').trim()).toBe(key);
  });

  it('is found owner-only again at startup when someone else could read it', async () => {
    const key = await loadApiKey(home);
    const file = join(home, 'api-key');
    exposeToOthers(file);
    expect(isOwnerOnly(file)).toBe(false);
    expect(await loadApiKey(home)).toBe(key);
    expect(isOwnerOnly(file)).toBe(true);
  });
});

describe('the API key is made once, by whoever asks first', () => {
  it('concurrent first requests end with one key: every caller gets it, and it is the one in the file', async () => {
    ownerOnly(home, true);
    const keys = await Promise.all(Array.from({ length: 12 }, () => loadApiKey(home)));
    expect(new Set(keys).size).toBe(1);
    const file = join(home, 'api-key');
    expect(readFileSync(file, 'utf8').trim()).toBe(keys[0]);
    expect(keys[0]).toMatch(/^divan-[\w-]{43}$/u);
    expect(isOwnerOnly(file)).toBe(true);
    // no temp file is left behind
    expect(readdirSync(home)).toEqual(['api-key']);
  }, 60_000);

  it('a key that is there is never replaced, however many ask', async () => {
    ownerOnly(home, true);
    const key = await loadApiKey(home);
    const again = await Promise.all(Array.from({ length: 12 }, () => loadApiKey(home)));
    expect(again.every((other) => other === key)).toBe(true);
    expect(readFileSync(join(home, 'api-key'), 'utf8').trim()).toBe(key);
  });

  it('a file that is not a key (empty, too short) is replaced once, whole, and the new key is kept', async () => {
    ownerOnly(home, true);
    const file = join(home, 'api-key');
    for (const text of ['', 'short\n']) {
      writeFileSync(file, text);
      // it has long been there: nobody is writing it
      const longAgo = new Date(Date.now() - 60_000);
      utimesSync(file, longAgo, longAgo);
      const key = await loadApiKey(home);
      expect(key).toMatch(/^divan-/u);
      expect(readFileSync(file, 'utf8').trim()).toBe(key);
      expect(await loadApiKey(home)).toBe(key);
      expect(isOwnerOnly(file)).toBe(true);
      rmSync(file);
    }
  }, 20_000);

  it('a request that comes while the first is still writing waits for it and gets the same key', async () => {
    ownerOnly(home, true);
    const file = join(home, 'api-key');
    // the first writer has made the file and not written to it yet
    writeFileSync(file, '');
    const waiting = loadApiKey(home);
    await new Promise((resolve) => setTimeout(resolve, 150));
    writeFileSync(file, 'divan-written-by-the-first-writer-0123456789\n');
    expect(await waiting).toBe('divan-written-by-the-first-writer-0123456789');
  });
});

describe('a home that already exists', () => {
  it.skipIf(process.platform !== 'win32')(
    'uses system PowerShell when whoami fails, before resetting permissions',
    () => {
      const source = pathToFileURL(
        join(import.meta.dirname, '..', 'src', 'server', 'secure.ts'),
      ).href;
      const program = `
      import assert from 'node:assert/strict';
      import cp from 'node:child_process';
      import {syncBuiltinESMExports} from 'node:module';
      import {isAbsolute} from 'node:path';
      const original = cp.execFileSync;
      const calls = [];
      let denyPowerShell = false;
      cp.execFileSync = (file, args, options) => {
        calls.push({file, args});
        if (file.endsWith('whoami.exe')) throw new Error('injected whoami failure');
        if (file.endsWith('powershell.exe')) {
          assert.ok(isAbsolute(file));
          assert.ok(file.includes('System32'));
          assert.ok(args.includes('-NoProfile'));
          assert.equal(options.windowsHide, true);
          if (denyPowerShell) return 'invalid SID';
        }
        return original(file, args, options);
      };
      syncBuiltinESMExports();
      try {
        const secure = await import(${JSON.stringify(source)});
        secure.ownerOnly(${JSON.stringify(home)}, true);
        assert.ok(secure.isOwnerOnly(${JSON.stringify(home)}));
        assert.ok(calls[0].file.endsWith('whoami.exe'));
        assert.ok(calls[1].file.endsWith('powershell.exe'));
        assert.ok(calls[2].args.includes('/reset'));
        calls.length = 0;
        denyPowerShell = true;
        const fresh = await import(${JSON.stringify(`${source}?failed`)});
        assert.throws(() => fresh.ownerOnly(${JSON.stringify(home)}, true), /Allow System32/);
        assert.ok(!calls.some(call => call.args.includes('/reset')));
      } finally {
        cp.execFileSync = original;
        syncBuiltinESMExports();
      }
    `;
      execFileSync(process.execPath, ['--input-type=module', '-e', program], {
        windowsHide: true,
        stdio: 'pipe',
        timeout: 90_000,
      });
    },
    100_000,
  );

  it('recognizes a home containing only a suffixed settings backup', () => {
    writeFileSync(join(home, 'settings.corrupt-1791972000000-1.json'), 'backup');
    secureHome(home);
    expect(isOwnerOnly(home)).toBe(true);
  });
  it('refuses unrelated nonempty folders before changing their permissions', () => {
    writeFileSync(join(home, 'unrelated.txt'), 'keep');
    exposeToOthers(home, true);
    expect(() => secureHome(home)).toThrow('DIVAN_HOME must be an empty folder');
    expect(isOwnerOnly(home)).toBe(false);
    expect(readFileSync(join(home, 'unrelated.txt'), 'utf8')).toBe('keep');
  });

  it('reads a numeric SID without depending on the account name encoding', () => {
    for (const name of ['DOMAIN\\کاربر', 'DOMAIN\\????', 'DOMAIN\\A B'])
      expect(parseWindowsIdentity(`"${name}","S-1-5-21-123-456-789-1001"\r\n`).sid).toBe(
        'S-1-5-21-123-456-789-1001',
      );
    expect(() => parseWindowsIdentity('not an identity')).toThrow('account SID');
  });
  it('has its folder, its key and its state file made owner-only at every start', () => {
    // a home an older version made: readable by others, with a key and a state file in it
    mkdirSync(join(home, 'sessions'));
    writeFileSync(join(home, 'api-key'), 'divan-0123456789abcdef0123456789abcdef\n');
    writeFileSync(join(home, 'server.json'), '{"token":"web-token"}');
    for (const [name, folder] of [
      ['', true],
      ['api-key', false],
      ['server.json', false],
    ] as const) {
      exposeToOthers(join(home, name), folder);
      expect(isOwnerOnly(join(home, name)), `${name || 'home'} starts exposed`).toBe(false);
    }
    secureHome(home);
    for (const name of ['', 'api-key', 'server.json']) {
      expect(isOwnerOnly(join(home, name)), `${name || 'home'} is repaired`).toBe(true);
    }
  });

  it('the state file is written as a secret: owner-only from the moment it exists', async () => {
    ownerOnly(home, true);
    const file = join(home, 'server.json');
    await writeFileAtomic(file, '{"token":"t"}', true);
    expect(isOwnerOnly(file)).toBe(true);
    await writeFileAtomic(file, '{"token":"u"}', true); // replaced: still owner-only
    expect(isOwnerOnly(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('"u"');
  });
});
