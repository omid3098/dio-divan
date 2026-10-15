// The form of one Library entry as an explicit save, like the council form: what the person changes stays on the page; nothing is
// sent by itself. The form is compared with the entry as the page last took it (its baseline: the revision and the values). A save
// sends them with that revision; if the entry has moved on, the server answers 409 `library_stale` with the current entry, the
// edits stay, and the person chooses: load the other version (the edits are dropped) or keep theirs (the next save is made against
// the current revision and replaces the other version). «Saved» is shown after the server's acknowledgement only.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/api';
import { translate } from '@/i18n/index.tsx';
import type { LibraryView } from '../../../../src/shared/library.ts';
import {
  createEntry,
  type EntryView,
  type Kind,
  loadLibrary,
  problemText,
  refreshMeta,
  saveEntry,
} from './api.ts';
import { blankValues, bodyOf, sameValues, type Values, valuesOf } from './values.ts';

export type Phase = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

export function useEntryForm({
  kind,
  entry,
  draftId,
  onLibrary,
  onSaved,
}: {
  kind: Kind;
  /** The saved entry (null: a new one, which is saved under the id `draftId` gives when it is saved). */
  entry: EntryView | null;
  draftId: () => string;
  /** The Library as the server has it after a change. */
  onLibrary: (next: LibraryView) => void;
  /** The entry was saved (a new one gets its place in the address). */
  onSaved: (id: string, created: boolean) => void;
}) {
  const [baseline, setBaseline] = useState<{ revision: number; values: Values }>(() => ({
    revision: entry?.revision ?? 0,
    values: entry ? valuesOf(kind, entry) : blankValues(kind),
  }));
  const [values, setValues] = useState<Values>(baseline.values);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  /** After a 409: the entry as the server has it now. */
  const [other, setOther] = useState<EntryView | null>(null);
  const dirty = !sameValues(values, baseline.values);

  const latest = useRef({ values, baseline, draftId, entry });
  latest.current = { values, baseline, draftId, entry };
  const running = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // an entry that moved on without edits here (a copy made, another page) is shown as it is now; one with edits is not touched:
  // its save is then refused, and the person chooses
  useEffect(() => {
    if (!entry) return;
    const now = latest.current;
    if (entry.revision === now.baseline.revision || running.current) return;
    if (!sameValues(now.values, now.baseline.values)) return;
    const next = { revision: entry.revision, values: valuesOf(kind, entry) };
    setBaseline(next);
    setValues(next.values);
  }, [entry, kind]);

  // a page left with edits that were not saved would lose them: the browser asks first
  useEffect(() => {
    if (!dirty) return;
    const ask = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [dirty]);

  /** A change made by the person: shown at once, kept on the page until it is saved. */
  const change = useCallback((next: Values | ((now: Values) => Values)) => {
    setValues(next);
    setPhase((now) => (now === 'saved' ? 'idle' : now));
  }, []);

  /** Sends the form. Resolves true when the server has what was sent (or there was nothing to send). */
  const save = useCallback((): Promise<boolean> => {
    if (running.current) return running.current;
    const task = (async (): Promise<boolean> => {
      const sent = latest.current.values;
      const base = latest.current.baseline;
      const id = latest.current.entry?.id ?? latest.current.draftId();
      const created = latest.current.entry === null;
      if (!created && sameValues(sent, base.values)) return true;
      setPhase('saving');
      setProblem(null);
      try {
        const view = created
          ? await createEntry(kind, { id, ...bodyOf(kind, sent) })
          : await saveEntry(kind, id, base.revision, bodyOf(kind, sent) as never);
        onLibrary(view);
        const saved = view[kind].find((item) => item.id === id) as EntryView | undefined;
        void refreshMeta();
        if (!saved) return false;
        const next = { revision: saved.revision, values: valuesOf(kind, saved) };
        setBaseline(next);
        // what the server keeps is what the form shows, unless the person has gone on editing while it was sent
        if (sameValues(latest.current.values, sent)) setValues(next.values);
        setPhase('saved');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setPhase((now) => (now === 'saved' ? 'idle' : now)), 3500);
        onSaved(id, created);
        return sameValues(latest.current.values, sent);
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === 'library_stale' &&
          error.body.entry
        ) {
          setOther(error.body.entry as EntryView);
          setPhase('conflict');
          return false;
        }
        setPhase('error');
        setProblem(
          error instanceof ApiError ? problemText(error) : translate('common.serverError'),
        );
        return false;
      }
    })();
    running.current = task;
    return task.finally(() => {
      running.current = null;
    });
  }, [kind, onLibrary, onSaved]);

  /** «Discard changes»: the form goes back to the entry as the page last took it. */
  const discard = useCallback(() => {
    setValues(latest.current.baseline.values);
    setPhase('idle');
    setProblem(null);
    setOther(null);
  }, []);

  /** After a 409, the other version is taken as the truth: the edits are gone. */
  const loadOther = useCallback(() => {
    if (!other) return;
    const next = { revision: other.revision, values: valuesOf(kind, other) };
    setBaseline(next);
    setValues(next.values);
    setOther(null);
    setPhase('idle');
    void loadLibrary().then(onLibrary, () => undefined);
  }, [kind, onLibrary, other]);

  /** After a 409, the edits stay: they are now compared with the other version, and the next save replaces it. */
  const keepMine = useCallback(() => {
    if (!other) return;
    setBaseline({ revision: other.revision, values: valuesOf(kind, other) });
    setOther(null);
    setPhase('idle');
  }, [kind, other]);

  return {
    values,
    change,
    baseline,
    dirty,
    phase,
    problem,
    conflict: other,
    save,
    discard,
    loadOther,
    keepMine,
  };
}
