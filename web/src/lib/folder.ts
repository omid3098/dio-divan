// Small helpers for a working folder and for where a session came from; pure, so a test can pin them.

/** The last segment of a folder path («E:\w\dio-divan» → «dio-divan»); the whole path when it has none (a drive root). */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/u, '');
  const last = trimmed.split(/[\\/]/u).pop() ?? '';
  return last === '' ? path.trim() : last;
}

/**
 * The name a session's client goes by in the lists. The server keeps `origin.client` as the first word of the client's
 * `x-divan-client` header, else of its User-Agent: Pi sends `pi`, T3 Code is told by a name that has «t3» in it; any other client
 * keeps the name it gave.
 */
export function clientName(client: string | undefined): string | null {
  const raw = (client ?? '').trim();
  if (!raw) return null;
  if (/^pi($|[-_.])/iu.test(raw)) return 'Pi';
  if (/t3/iu.test(raw)) return 'T3 Code';
  return raw;
}
