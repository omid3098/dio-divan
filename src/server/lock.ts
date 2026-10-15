// The single-instance lock of a home folder. It is held by the operating system, not by a file we have to judge:
//   Windows: a named pipe that the process listens on. Only one process can create it, and the kernel frees it the moment
//            the owner dies (crash, kill), so there is no stale lock to recover and nothing two contenders can both win.
//   Elsewhere: a Unix socket in the home folder. A socket file left by a crash is told from a live one by connecting to
//            it, and taking over a dead one is serialised by an exclusively created recovery file, under which ownership
//            is read again (this path is not exercised on Windows).
// With the lock held, no other live instance can be touching the sessions or their temp files.

import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { canonical } from './canonical.ts';

export class AlreadyRunningError extends Error {
  /** The owner's PID when the state file names it, else 0. */
  readonly pid: number;
  constructor(pid: number) {
    super(pid > 0 ? `Dio Divan is already running (pid ${pid})` : 'Dio Divan is already running');
    this.pid = pid;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A Unix socket path may be about this long (108 bytes on Linux, 104 on macOS, less a margin). */
const SOCKET_PATH_MAX = 100;

/**
 * What identifies this home to the operating system: its real name, so a junction or symlink to the same folder takes the
 * same lock (the folder is made first, as a name can only be resolved for something that exists).
 */
export function lockName(home: string): string {
  mkdirSync(home, { recursive: true });
  const real = canonical(home);
  if (process.platform === 'win32') {
    const id = createHash('sha1').update(real.toLowerCase()).digest('hex').slice(0, 16);
    return `\\\\.\\pipe\\dio-divan-${id}`;
  }
  const socket = join(real, 'server.sock');
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX) {
    // Say what is too long (the real path: the lock uses it, also behind a short link) and the way out; DIVAN_HOME may never
    // have been set, so it is the remedy and not the cause.
    const room = SOCKET_PATH_MAX - Buffer.byteLength(socket) + Buffer.byteLength(real);
    throw new Error(
      `The Divan folder ${real} (${Buffer.byteLength(real)} bytes) is too long for the single-instance lock on this system, which allows at most ${room} bytes. Set DIVAN_HOME to a shorter folder path.`,
    );
  }
  return socket;
}

function ownerPid(home: string): number {
  try {
    const state = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')) as { pid?: unknown };
    return typeof state.pid === 'number' ? state.pid : 0;
  } catch {
    return 0;
  }
}

/** Listens on `name`; `null` when somebody else already does. */
function listen(name: string): Promise<Server | null> {
  return new Promise((done, fail) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') done(null);
      else fail(error);
    });
    server.listen(name, () => {
      server.removeAllListeners('error');
      server.on('error', () => undefined);
      done(server);
    });
  });
}

/** Whether something answers on the socket (a live owner), as opposed to a file a crash left behind. */
function answers(name: string): Promise<boolean> {
  return new Promise((done) => {
    const probe = createConnection(name);
    probe.once('connect', () => {
      probe.destroy();
      done(true);
    });
    probe.once('error', () => done(false));
    setTimeout(() => {
      probe.destroy();
      done(true);
    }, 2000).unref();
  });
}

async function takeOverSocket(home: string, name: string): Promise<Server | null> {
  const recovery = `${name}.recover`;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(recovery, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // Another contender is recovering; a recovery file nobody removed for a minute is a crashed one's.
      try {
        if (Date.now() - statSync(recovery).mtimeMs > 60_000) rmSync(recovery, { force: true });
      } catch {
        // gone already
      }
      await sleep(100);
      continue;
    }
    try {
      // Ownership is read again under the recovery lock: only one contender at a time gets to judge it stale.
      if (await answers(name)) return null;
      rmSync(name, { force: true });
      return await listen(name);
    } finally {
      closeSync(fd);
      rmSync(recovery, { force: true });
    }
  }
  throw new Error(`could not take the single-instance lock in ${home}`);
}

/** Takes the lock, or throws AlreadyRunningError. Returns the function that releases it. */
export async function acquireLock(home: string): Promise<() => Promise<void>> {
  const name = lockName(home);
  let server = await listen(name);
  if (!server && process.platform !== 'win32') server = await takeOverSocket(home, name);
  if (!server) throw new AlreadyRunningError(ownerPid(home));
  const owned = server;
  return () =>
    new Promise<void>((done) => {
      owned.close(() => {
        if (process.platform !== 'win32') rmSync(name, { force: true });
        done();
      });
    });
}
