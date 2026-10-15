import {
  checkHistory,
  HERMES_HISTORY_DB,
  HERMES_HISTORY_PYTHON,
  queryHermesHistory,
} from './hermes-history.ts';

try {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16384) throw new Error('bounded');
  }
  const { action, args } = JSON.parse(input);
  const path = process.env[HERMES_HISTORY_DB],
    python = process.env[HERMES_HISTORY_PYTHON];
  if (!path || !python || typeof args !== 'object' || args === null || Array.isArray(args))
    throw new Error('invalid');
  const identity = checkHistory(path, python);
  const result = queryHermesHistory(path, action, args);
  if (checkHistory(path, python) !== identity) throw new Error('changed');
  process.stdout.write(JSON.stringify(result));
} catch {
  process.exitCode = 125;
}
