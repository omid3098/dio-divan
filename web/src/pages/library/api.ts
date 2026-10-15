// What the Library page and the pickers ask the server: the entries (prompts and output forms), and the words for what it refuses.
// The server owns the rules (src/server/library.ts, SettingsService.editLibrary); the pages only show what it answered.

import { ApiError, api } from '@/api';
import { hasKey, type Key, translate } from '@/i18n/index.tsx';
import { setState } from '@/store';
import type { FormEntry, LibraryView, PromptEntry } from '../../../../src/shared/library.ts';
import type { Meta } from '../../../../src/shared/types.ts';
import type { Kind } from './values.ts';

export type { EntryView, FormView, Kind, PromptView } from './values.ts';

export const loadLibrary = () => api<LibraryView>('/library');

export const createEntry = (kind: Kind, body: Record<string, unknown>) =>
  api<LibraryView>(`/library/${kind}`, 'POST', body);

export const saveEntry = (
  kind: Kind,
  id: string,
  ifRevision: number,
  body: Partial<Omit<PromptEntry, 'id' | 'revision'>> | Partial<Omit<FormEntry, 'id' | 'revision'>>,
) => api<LibraryView>(`/library/${kind}/${encodeURIComponent(id)}`, 'PUT', { ...body, ifRevision });

export const deleteEntry = (kind: Kind, id: string) =>
  api<LibraryView>(`/library/${kind}/${encodeURIComponent(id)}`, 'DELETE');

/** A change to an entry changes the models that use it (their resolved prompts, forms and fingerprints): the page's list is read again. */
export async function refreshMeta(): Promise<void> {
  try {
    setState({ meta: await api<Meta>('/meta') });
  } catch {
    // the list is read again with the next load; a failed read must not turn a saved entry into an error
  }
}

/** The reasons the server gives for an entry it refuses (`bad_library {reason}`), said in plain words by `library.reason.<reason>`. */
export function reasonText(reason: string): string {
  const key = `library.reason.${reason}`;
  return hasKey(key) ? translate(key as Key) : translate('library.reason.other', { reason });
}

/** What a refusal says, in the language in force: the server's reason in plain words for an invalid entry, else its own sentence. */
export function problemText(error: unknown): string {
  if (!(error instanceof ApiError)) return translate('common.serverError');
  if (error.code === 'bad_library' && typeof error.params?.reason === 'string')
    return reasonText(error.params.reason);
  return error.message;
}

/** The models (and prompts) a refused deletion names. */
export function usersOf(error: unknown): { models: string[]; prompts: string[] } | null {
  if (!(error instanceof ApiError) || error.code !== 'library_in_use') return null;
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return { models: list(error.body.models), prompts: list(error.body.prompts) };
}
