// The id of a Library entry (what a node refers to): 1 to 48 of a-z, 0-9, `_` and `-`, starting with a letter, and never the name of
// a built-in output form. It is suggested from the name (its Latin words) and can be changed until the entry is saved.

export const ENTRY_ID = /^[a-z][a-z0-9_-]{0,47}$/u;
const RESERVED = ['report', 'member', 'answer'];

/** Whether an id is allowed for a new entry (the pattern, not a built-in form's name, not one that is taken). */
export const idProblem = (id: string, taken: readonly string[]): 'pattern' | 'taken' | null =>
  !ENTRY_ID.test(id) || RESERVED.includes(id) ? 'pattern' : taken.includes(id) ? 'taken' : null;

/** An id to start from: the Latin words of the name as a slug, else `<kind>-<n>` for the first n that is free. */
export function suggestEntryId(
  name: string,
  base: 'prompt' | 'form',
  taken: readonly string[],
): string {
  const slug = (name.match(/[A-Za-z0-9]+/gu) ?? [])
    .join('-')
    .toLowerCase()
    .replace(/^[^a-z]+/u, '')
    .slice(0, 48)
    .replace(/-+$/u, '');
  if (slug && idProblem(slug, taken) === null) return slug;
  for (let n = 1; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (idProblem(candidate, taken) === null) return candidate;
  }
}
