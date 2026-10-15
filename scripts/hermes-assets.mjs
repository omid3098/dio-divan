import { cpSync, rmSync } from 'node:fs';

const destination = new URL('../dist/server/adapters/hermes/', import.meta.url);
rmSync(destination, { recursive: true, force: true });

cpSync(new URL('../src/server/adapters/hermes/', import.meta.url), destination, {
  recursive: true,
  filter: (path) => !path.includes('__pycache__') && !path.endsWith('.pyc'),
});
