// This fixed T3 reader starts under Low, rather than borrowing a medium HTTP service.
import { checkHistory, HERMES_HISTORY_PYTHON } from './hermes-history.ts';
import { t3DbPath } from './t3-threads.ts';

try {
  const python = process.env[HERMES_HISTORY_PYTHON];
  if (!python) throw new Error('unavailable');
  checkHistory(t3DbPath(), python);
  const { serveT3 } = await import('./t3-mcp.ts');
  serveT3(() => checkHistory(t3DbPath(), python));
} catch {
  process.exitCode = 125;
}
