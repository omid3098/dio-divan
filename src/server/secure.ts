// Owner-only permissions for what must stay secret: Divan's home folder (new files inherit them) and the API key. On
// Windows other accounts (service and sandbox users) are usually granted access to a user's folders through inheritance, so
// the access list is replaced by one entry, the current user's, with inheritance removed (`icacls`, by its absolute path).
// Elsewhere that is mode 0700 for folders and 0600 for files.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SYSTEM32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
const ICACLS = join(SYSTEM32, 'icacls.exe');
const WHOAMI = join(SYSTEM32, 'whoami.exe');
const POWERSHELL = join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');

let me: { name: string; sid: string } | undefined;
export function parseWindowsIdentity(text: string): { name: string; sid: string } {
  const found = /^"((?:[^"\r\n]|"")*)","(S-1-\d+(?:-\d+)+)"\s*$/mu.exec(text);
  if (!found)
    throw new Error('Could not read the Windows account SID for private Divan permissions.');
  return { name: (found[1] as string).replaceAll('""', '"'), sid: found[2] as string };
}
/** The account's SID for grants, and its name for reading existing permissions. */
function currentUser(): { name: string; sid: string } {
  if (!me) {
    const options = { encoding: 'utf8', windowsHide: true, timeout: 10_000 } as const;
    try {
      me = parseWindowsIdentity(execFileSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], options));
    } catch {
      try {
        me = parseWindowsIdentity(
          execFileSync(
            POWERSHELL,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent(); [Console]::WriteLine((\'"{0}","{1}"\' -f $identity.Name.Replace(\'"\', \'""\'), $identity.User.Value))',
            ],
            // A first Windows PowerShell start on a fresh or busy machine can take well over ten seconds.
            { ...options, timeout: 60_000 },
          ),
        );
      } catch {
        throw new Error(
          'Could not resolve the Windows account SID. Allow System32 whoami.exe or Windows PowerShell to run, then start Divan again. Permissions were not changed.',
        );
      }
    }
  }
  return me;
}

const icacls = (args: string[]): string =>
  execFileSync(ICACLS, args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

/** Only the current user may use `path`, and nothing is inherited from the folder above. */
export function ownerOnly(path: string, folder: boolean): void {
  if (process.platform !== 'win32') {
    chmodSync(path, folder ? 0o700 : 0o600);
    return;
  }
  // (OI)(CI): what is made inside a folder gets the same, so a temp file is born owner-only as well.
  const { sid } = currentUser();
  // Reset first: entries that were added to the file itself are not inherited, so removing inheritance alone leaves them.
  icacls([path, '/reset']);
  icacls([path, '/inheritance:r', '/grant:r', `*${sid}:${folder ? '(OI)(CI)F' : 'F'}`]);
}

/** Whether `path` is usable by the current user alone, with no inherited entry. */
export function isOwnerOnly(path: string): boolean {
  if (process.platform !== 'win32') return (statSync(path).mode & 0o077) === 0;
  const entries = icacls([path])
    .split(/\r?\n/u)
    .flatMap((line) => {
      // The first line starts with the path as it was given; every line then holds one entry, "who:(flags)".
      const found = /^(.+?):\((.*)$/u.exec(
        (line.startsWith(path) ? line.slice(path.length) : line).trim(),
      );
      return found
        ? [{ who: (found[1] as string).trim().toLowerCase(), flags: found[2] as string }]
        : [];
    });
  const mine = currentUser().name.toLowerCase();
  return (
    entries.length > 0 &&
    entries.every((entry) => entry.who === mine && !entry.flags.startsWith('I)'))
  );
}

/** Makes `path` owner-only when it is not already; the cheap check comes first. */
export function ensureOwnerOnly(path: string, folder: boolean): void {
  if (!isOwnerOnly(path)) ownerOnly(path, folder);
}

/**
 * The home folder and what holds a secret in it are owner-only after every start, not only for a home that is new: a home
 * made by an older version (or by another tool) may be readable by other accounts, and `server.json` holds the token that
 * fetches the API key. A folder made now is owner-only from the start, so what is made inside inherits it.
 */
export function secureHome(home: string): void {
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const entries = readdirSync(home);
  const own = new Set([
    'api-key',
    'server.json',
    'settings.json',
    'sessions',
    'generation.json',
    'unavailable.json',
    'api-index.json',
    'threads.json',
    'memory-ro-token',
    'server.sock',
  ]);
  if (
    entries.length &&
    !entries.some((name) => own.has(name) || /^settings\.corrupt-\d+(?:-\d+)?\.json$/u.test(name))
  )
    throw new Error(
      `DIVAN_HOME must be an empty folder or an existing Divan home: ${home}. Its permissions were not changed.`,
    );
  ensureOwnerOnly(home, true);
  for (const name of ['api-key', 'server.json']) {
    const file = join(home, name);
    if (existsSync(file)) ensureOwnerOnly(file, false);
  }
}
