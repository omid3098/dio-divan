// The form of one council (a profile) as an explicit save. What the user changes stays on the page; nothing is sent by itself.
// The form is compared with the profile as the page last took it (its baseline: revision, settings fingerprint, defaults, the
// base council and every level), not with the live profile, which can move for reasons that are not the user's (a model that
// ran out of credit). A save sends the base council's overrides, every level's overrides and the default level against the
// revision and the fingerprint the page last had; if the profile has moved on the server answers 409 with the current profile
// and the local edits stay until the user chooses (reload discards them). «Saved» is shown after the server's acknowledgement
// only; a failure is shown with a way to try again.

import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '@/api';
import { translate } from '@/i18n/index.tsx';
import { setState } from '@/store';
import { REASONING_LEVELS } from '../../../../src/shared/levels.ts';
import type {
  LevelView,
  Meta,
  ProfileView,
  ReasoningLevel,
  SettingsFull,
  SettingsView,
} from '../../../../src/shared/types.ts';

export type Phase = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

export interface CouncilForm {
  /** The base council: every level derives from it. */
  base: SettingsFull;
  /** The council at each level as the form has it: what the level derives, with the user's overrides laid over it. */
  levels: Record<ReasoningLevel, SettingsFull>;
  defaultLevel: ReasoningLevel;
}

/** What the server acknowledged: the profile's revision and the fingerprint of the settings in force at that revision. */
export interface Saved {
  revision: number;
  fingerprint: string;
}

interface Baseline extends Saved {
  defaults: SettingsFull;
  base: SettingsFull;
  levels: Record<ReasoningLevel, LevelView>;
  defaultLevel: ReasoningLevel;
}

const baselineOf = (profile: ProfileView): Baseline => ({
  revision: profile.revision,
  fingerprint: profile.fingerprint,
  defaults: profile.defaults,
  base: profile.effective,
  levels: profile.levels,
  defaultLevel: profile.defaultLevel,
});

export const formOf = (profile: ProfileView): CouncilForm => ({
  base: profile.effective,
  levels: Object.fromEntries(
    REASONING_LEVELS.map((level) => [level, profile.levels[level].effective]),
  ) as Record<ReasoningLevel, SettingsFull>,
  defaultLevel: profile.defaultLevel,
});

import { levelChanged, same, saveBody } from './form-diff.ts';

export function useCouncilForm(meta: Meta, profile: ProfileView) {
  const [baseline, setBaseline] = useState<Baseline>(() => baselineOf(profile));
  const [form, setFormState] = useState<CouncilForm>(() => formOf(profile));
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState<string | null>(null);
  /** After a 409: the profile as the server has it now. */
  const [moved, setMoved] = useState<{ profile: ProfileView; view: SettingsView | null } | null>(
    null,
  );

  // the base council and the levels are edited apart: a level is derived from the base, so a base that is not saved yet has no
  // levels to show (and the other way round)
  const baseDirty = !same(form.base, baseline.base) || form.defaultLevel !== baseline.defaultLevel;
  // a level is changed when its form differs from the level as the profile has it (resolved), not from what it derives
  const levelDirty = Object.fromEntries(
    REASONING_LEVELS.map((level) => [
      level,
      levelChanged(baseline.levels[level], form.levels[level]),
    ]),
  ) as Record<ReasoningLevel, boolean>;
  const anyLevelDirty = REASONING_LEVELS.some((level) => levelDirty[level]);
  const dirty = baseDirty || anyLevelDirty;

  // the latest values, for the functions that outlive a render
  const latest = useRef({ form, baseline, dirty });
  latest.current = { form, baseline, dirty };
  const running = useRef<Promise<Saved | null> | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const path = `/profiles/${encodeURIComponent(profile.id)}`;

  /** The list the page shows. */
  const publish = useCallback(
    (next: SettingsView) => {
      setState({ meta: { ...meta, settings: next } });
    },
    [meta],
  );

  /** Takes a profile as the truth: it is the baseline and the form shows it; the local edits are gone. */
  const load = useCallback(
    (next: ProfileView, view: SettingsView | null) => {
      if (view) publish(view);
      setBaseline(baselineOf(next));
      setFormState(formOf(next));
      setPhase('idle');
      setProblem(null);
      setMoved(null);
    },
    [publish],
  );

  // A form with nothing changed follows the profile when it moves (a refresh of what this PC has); one with edits does not:
  // its save is then refused, and the user chooses.
  useEffect(() => {
    const now = latest.current;
    if (now.dirty || phase === 'saving' || phase === 'conflict') return;
    if (
      profile.revision !== now.baseline.revision ||
      profile.fingerprint !== now.baseline.fingerprint
    ) {
      setBaseline(baselineOf(profile));
      setFormState(formOf(profile));
    }
  }, [profile, phase]);

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

  useEffect(
    () => () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    },
    [],
  );

  /** A refusal that says the profile has moved on (409 with the profile): the conflict is shown, the local edits stay. */
  const conflictFrom = useCallback((error: unknown): boolean => {
    if (!(error instanceof ApiError) || error.status !== 409 || !error.body.profile) return false;
    setMoved({
      profile: error.body.profile as ProfileView,
      view: (error.body.view as SettingsView | undefined) ?? null,
    });
    setPhase('conflict');
    return true;
  }, []);

  /**
   * Sends the form (or `wanted`, a form to save at once, with `reset` to drop every override) as the profile's overrides.
   * Resolves with the revision and the fingerprint the server has afterwards when it has the form that was sent (or there was
   * nothing to send); null after a refusal or a failure, which is then shown, and when the form is no longer the one that was
   * sent (nothing goes on from a form that was not acknowledged).
   */
  const save = useCallback(
    (options?: { reset?: boolean }): Promise<Saved | null> => {
      if (running.current) return running.current;
      const task = (async (): Promise<Saved | null> => {
        const sent = latest.current.form;
        const base = latest.current.baseline;
        if (!options?.reset && !latest.current.dirty)
          return { revision: base.revision, fingerprint: base.fingerprint };
        setPhase('saving');
        setProblem(null);
        try {
          // «Back to Divan's defaults»: no override, no level change, and a design goes back to being a council
          const body = options?.reset
            ? {
                overrides: {},
                levels: {},
                ...(base.base.flow ? { flow: null } : {}),
                defaultLevel: profile.base === 'quick' ? 'low' : 'medium',
                ifRevision: base.revision,
                ifFingerprint: base.fingerprint,
              }
            : saveBody(sent, base);
          const view = await api<SettingsView>(path, 'PUT', body);
          const mine = view.profiles.find((item) => item.id === profile.id);
          publish(view);
          if (!mine) return null;
          setBaseline(baselineOf(mine));
          // what the server keeps is what the form shows, unless the form is not what was sent any more
          const unchanged = options?.reset === true || same(latest.current.form, sent);
          if (unchanged) setFormState(formOf(mine));
          setPhase('saved');
          if (savedTimer.current) clearTimeout(savedTimer.current);
          savedTimer.current = setTimeout(
            () => setPhase((now) => (now === 'saved' ? 'idle' : now)),
            3500,
          );
          return unchanged ? { revision: mine.revision, fingerprint: mine.fingerprint } : null;
        } catch (error) {
          if (conflictFrom(error)) return null;
          setPhase('error');
          setProblem(error instanceof ApiError ? error.message : translate('common.serverError'));
          return null;
        }
      })();
      running.current = task;
      return task.finally(() => {
        running.current = null;
      });
    },
    [conflictFrom, path, profile.id, profile.base, publish],
  );

  /** A change made by the user: shown at once, kept on the page until it is saved. */
  const setForm: Dispatch<SetStateAction<CouncilForm>> = useCallback((update) => {
    setFormState(update);
    setPhase((now) => (now === 'saved' ? 'idle' : now));
  }, []);

  /** «Discard changes»: the form goes back to the profile; after a 409, to the profile as it is now. */
  const cancel = useCallback(() => {
    if (moved) load(moved.profile, moved.view);
    else {
      setFormState(formOf({ ...profile, ...restoreFrom(latest.current.baseline, profile) }));
      setPhase('idle');
      setProblem(null);
    }
  }, [load, moved, profile]);

  /** The baseline follows a change of the profile's name or revision that did not touch its settings (a rename). */
  const rebase = useCallback(
    (view: SettingsView, id = profile.id) => {
      publish(view);
      const mine = view.profiles.find((item) => item.id === id);
      if (mine) setBaseline(baselineOf(mine));
    },
    [profile.id, publish],
  );

  return {
    form,
    setForm,
    dirty,
    baseDirty,
    anyLevelDirty,
    levelDirty,
    phase,
    problem,
    moved: moved !== null,
    baseline,
    save,
    cancel,
    rebase,
    conflictFrom,
    publish,
    load,
  };
}

/** The profile's settings as the baseline has them (what the form goes back to when the changes are discarded). */
function restoreFrom(
  baseline: Baseline,
  profile: ProfileView,
): Pick<ProfileView, 'effective' | 'levels' | 'defaultLevel'> {
  return {
    effective: baseline.base,
    levels: baseline.levels,
    defaultLevel: baseline.defaultLevel ?? profile.defaultLevel,
  };
}
