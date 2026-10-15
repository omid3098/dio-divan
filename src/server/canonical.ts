// The one true name of a folder. A junction, a symlink or a drive substitution gives a folder a second name; anything that
// compares folders (the single-instance lock, the folders kept from the council, the working folder of a request) compares
// these real names, so an alias is never a way around it.

import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** `\\?\C:\x` is `C:\x`; `\\?\UNC\server\share` stays remote. */
const plain = (path: string): string => path.replace(/^\\\\\?\\(?=[A-Za-z]:)/u, '');

/** The real path of `path`, resolving its nearest existing ancestor when the leaf does not exist yet. */
export function canonical(path: string): string {
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(plain(realpathSync.native(ancestor)), ...missing.reverse());
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return resolve(path);
      missing.push(ancestor.slice(parent.length).replace(/^[\\/]/u, ''));
      ancestor = parent;
    }
  }
}

/** A folder on another machine (`\\server\share`, `\\?\UNC\…`, or a drive letter that maps to one once resolved). */
export const isRemote = (path: string): boolean => plain(path).startsWith('\\\\');
