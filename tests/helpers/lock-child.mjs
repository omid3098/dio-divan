// A process that tries to take the single-instance lock of the home folder given as argument 2. It prints "won" or
// "lost", then, when it won, holds the lock for argument 3 milliseconds (or, with "crash", ends without releasing it).
import { AlreadyRunningError, acquireLock } from '../../src/server/lock.ts';

const [home, hold = '0'] = process.argv.slice(2);
try {
  const release = await acquireLock(home);
  console.log('won');
  if (hold === 'crash') process.exit(0);
  await new Promise((done) => setTimeout(done, Number(hold)));
  await release();
} catch (error) {
  console.log(error instanceof AlreadyRunningError ? 'lost' : `error: ${error?.message}`);
}
