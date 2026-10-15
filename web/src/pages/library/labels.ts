// The words the Library page uses for its entries: an output form by its name (the built-in ones as the canvas names them), what a
// prompt is for, and the models that use an entry.

import { hasKey, type I18n, type Key } from '@/i18n/index.tsx';
import { profileName } from '@/lib/profile';
import type { LibraryView } from '../../../../src/shared/library.ts';
import type { ProfileView } from '../../../../src/shared/types.ts';
import type { EntryView, Kind } from './api.ts';

type Say = I18n['t'];

/** An output form by its name: the built-in ones as the canvas names them, the others by the name they were given. */
export function formName(library: LibraryView, id: string, t: Say): string {
  const form = library.forms.find((item) => item.id === id);
  if (!form) return id;
  return form.builtin ? t(`flow.form.${form.id}` as Key) : form.name;
}

/** What a prompt is written for: «Member answer · with inputs». */
export function promptFor(
  library: LibraryView,
  prompt: Pick<LibraryView['prompts'][number], 'form' | 'inputs'>,
  t: Say,
): string {
  const form = prompt.form === null ? t('library.anyForm') : formName(library, prompt.form, t);
  return `${form} · ${t(`library.inputs.${prompt.inputs}.short` as Key)}`;
}

/** The models that use an entry, by the name the person sees (an id the list does not have keeps its id). */
export function modelsOf(
  ids: readonly string[],
  profiles: readonly ProfileView[],
  t: Say,
): { id: string; name: string }[] {
  return ids.map((id) => {
    const profile = profiles.find((item) => item.id === id);
    return { id, name: profile ? profileName(profile, t) : id };
  });
}

/** An entry by its name: the built-in ones in the language of the page (the server's names are English), the others as they were named. */
export function entryName(entry: EntryView, kind: Kind, t: Say): string {
  if (!entry.builtin) return entry.name;
  if (kind === 'forms') return t(`flow.form.${entry.id}` as Key);
  const key = `library.prompt.${entry.id}`;
  return hasKey(key) ? t(key as Key) : entry.name;
}
