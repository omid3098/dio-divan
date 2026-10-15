import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `src/shared` and `dist/shared` have the same depth under the package root. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const VERSION: string = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
).version;
