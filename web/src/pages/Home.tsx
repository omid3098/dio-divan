// Home: a new session. The question first (and an optional context), then the council that will answer, shown and not edited
// here (the council is edited on the Councils page), the reasoning level, how long a round usually takes and one button.

import { AlertTriangleIcon, ArrowRightIcon, CheckIcon, UsersIcon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { startSession } from '@/actions';
import { ApiError, api } from '@/api';
import { ListText, Mono } from '@/components/bidi';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { HARNESS_LABEL } from '@/fa';
import { useFormat } from '@/i18n/format';
import { type Key, useI18n } from '@/i18n/index.tsx';
import { type Coded, noteKey, useNotes } from '@/i18n/notes.tsx';
import { navigate } from '@/leave-guard';
import { profileName } from '@/lib/profile';
import { isReady, setState, useAppState } from '@/store';
import { MAX_CONTEXT_CHARS } from '../../../src/shared/context.ts';
import { usableCandidates } from '../../../src/shared/defaults.ts';
import { agentsOf } from '../../../src/shared/flow.ts';
import { REASONING_LEVELS } from '../../../src/shared/levels.ts';
import { note } from '../../../src/shared/messages.ts';
import { modelFamily, textDirection } from '../../../src/shared/text.ts';
import type {
  LevelView,
  Meta,
  ProfileView,
  ReasoningLevel,
  SessionSummary,
} from '../../../src/shared/types.ts';
import { AssistantsCard } from './AssistantsCard.tsx';
import { type CouncilChange, councilNews } from './council-change.ts';
import { FolderField } from './FolderField.tsx';
import { QuickNote } from './QuickNote.tsx';

const QUESTION_KEY = 'divan-question';
const CONTEXT_KEY = 'divan-context';
const PROFILE_KEY = 'divan-profile';
/** The folder the last session was started with on this page: the field opens with it. */
const FOLDER_KEY = 'divan-folder';

/** A draft kept for the tab: it survives a reload and a change of council, and is cleared when the session starts. */
function useDraft(key: string): [string, (next: string) => void] {
  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  const set = (next: string) => {
    setValue(next);
    try {
      if (next) sessionStorage.setItem(key, next);
      else sessionStorage.removeItem(key);
    } catch {
      // storage that is off only loses the protection against a reload
    }
  };
  return [value, set];
}

/** The notes that apply to a council at a level (the PC's, the profile's, the level's): what the page knew of why it is as it is. */
function notesOf(
  settings: Meta['settings'],
  profile: ProfileView | undefined,
  level: ReasoningLevel,
) {
  return [...settings.notes, ...(profile?.notes ?? []), ...(profile?.levels[level].notes ?? [])];
}

export function Home({ meta }: { meta: Meta }) {
  const { t, tx, lang } = useI18n();
  const noted = useNotes();
  const f = useFormat();
  const profiles = meta.settings.profiles;
  const [profileId, setProfileId] = useState(() => {
    try {
      return localStorage.getItem(PROFILE_KEY) ?? 'default';
    } catch {
      return 'default';
    }
  });
  const profile: ProfileView =
    profiles.find((item) => item.id === profileId) ??
    (profiles.find((item) => item.id === 'default') as ProfileView);
  // The page opens at the council's own default level, not at the last one used (a Max test must not make the next session Max).
  // A level picked here stays for this visit and for the council it was picked on; another council starts at its own.
  const [levelPref, setLevelPref] = useState<{ profile: string; level: ReasoningLevel } | null>(
    null,
  );
  const level = levelPref?.profile === profile.id ? levelPref.level : profile.defaultLevel;
  const view = profile.levels[level];
  const [question, setQuestion] = useDraft(QUESTION_KEY);
  const [context, setContext] = useDraft(CONTEXT_KEY);
  // the working folder (optional): remembered from the last start; the server's reason it cannot be used is said under the field
  const [folder, setFolder] = useState(() => {
    try {
      return localStorage.getItem(FOLDER_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [folderProblem, setFolderProblem] = useState<string | null>(null);
  const cwd = folder.trim();
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The council changed since this page showed it: what changed, and the notes that say why (new ones). */
  const [changed, setChanged] = useState<{ lines: CouncilChange[]; notes: Coded[] } | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  // the question has the focus when the page opens (a desktop page; FRM-20)
  useEffect(() => {
    if (window.matchMedia('(min-width: 768px)').matches) field.current?.focus();
  }, []);

  const sessions = useAppState((state) => state.sessions);
  const hidden = useAppState((state) => state.pendingDelete);
  const seen = useAppState((state) => state.seen);
  const live = useMemo(
    () =>
      sessions
        .filter((item) => !hidden.includes(item.id) && (item.running || isReady(item, seen)))
        .slice(0, 4),
    [sessions, hidden, seen],
  );

  const flow = view.effective.flow?.kind === 'custom' ? view.effective.flow : null;
  const running = flow
    ? agentsOf(flow).filter((agent) => agent.enabled !== false)
    : view.effective.seats.filter((seat) => seat.enabled);
  const unavailable = running.filter(
    (seat) => meta.settings.status.find((item) => item.id === seat.harness)?.usable === false,
  );
  // members that are on and will not be asked now (their model is out of credit, or they are of the chairman's family)
  const skipped = running.filter(
    (seat) => !unavailable.includes(seat) && view.skipped.some((item) => item.id === seat.id),
  );
  const answering = running.length - unavailable.length - skipped.length;
  // what the level changes in this council beyond what the level itself derives (one muted line)
  const overrides = levelChanges();

  // how long a round usually takes at this level: the shortest and the longest finished rounds on this PC, else all levels' (null: none yet)
  const range = meta.typicalRoundRangeByLevel?.[level] ?? meta.typicalRoundRange ?? null;
  const usual = range ? f.typical(range.min, range.max, range.count).text : null;

  // the efforts of the four levels have names in Persian (the roster is read in Persian); any other (a harness's own word) stays
  // (a function declaration: `levelChanges()` is called above, before this line)
  function effortName(effort: string): string {
    return lang === 'fa' && (REASONING_LEVELS as readonly string[]).includes(effort)
      ? t(`level.${effort}` as Key)
      : effort;
  }

  function levelChanges(): ReactNode[] {
    const out: ReactNode[] = [];
    const nameOf = (id: string) => {
      const seat = view.effective.seats.find((item) => item.id === id);
      return seat ? (HARNESS_LABEL[seat.harness] ?? seat.harness) : id;
    };
    for (const [id, patch] of Object.entries(view.overrides.seats ?? {})) {
      const name = nameOf(id);
      if (patch.enabled === false) out.push(t('home.ovOff', { name }));
      if (patch.effort !== undefined) {
        out.push(
          t('home.ovEffort', { name, effort: effortName(patch.effort) || t('level.medium') }),
        );
      }
      if (patch.model !== undefined) {
        out.push(tx('home.ovModel', { model: <Mono>{patch.model}</Mono> }, { name }));
      }
    }
    const chairman = view.overrides.chairman;
    if (chairman?.model !== undefined) {
      out.push(tx('home.ovChairmanModel', { model: <Mono>{chairman.model}</Mono> }));
    }
    if (chairman?.effort !== undefined) {
      out.push(t('home.ovChairmanEffort', { effort: effortName(chairman.effort) }));
    }
    return out;
  }

  function choose(id: string) {
    setProfileId(id);
    try {
      localStorage.setItem(PROFILE_KEY, id);
    } catch {
      /* The in-memory choice still works. */
    }
    // the council opens at its own default level
    setLevelPref(null);
    setProblem(null);
    setChanged(null);
  }
  function chooseLevel(next: ReasoningLevel) {
    setLevelPref({ profile: profile.id, level: next });
    setProblem(null);
    setChanged(null);
  }

  /** Starts the session from `from` (the council as the server has it now): its revision and the fingerprint of the level asked. */
  async function start(from: ProfileView) {
    const made = await startSession({
      question,
      ...(context.trim() ? { context } : {}),
      ...(cwd ? { cwd } : {}),
      profileId: from.id,
      level,
      revision: from.revision,
      fingerprint: from.levels[level].fingerprint,
    });
    // the folder is the one this page starts with next time
    try {
      if (cwd) localStorage.setItem(FOLDER_KEY, cwd);
      else localStorage.removeItem(FOLDER_KEY);
    } catch {
      // storage that is off only loses the memory of the folder
    }
    try {
      sessionStorage.removeItem(QUESTION_KEY);
      sessionStorage.removeItem(CONTEXT_KEY);
    } catch {
      /* Storage may be disabled. */
    }
    setState({ session: null });
    navigate(`#/s/${made.id}`);
  }

  /** Takes the council as the server has it now; says what is different from the one that was shown (null: nothing is). */
  function noticeChange(
    shown: LevelView,
    shownNotes: Coded[],
    settings: Meta['settings'],
  ): { fresh: ProfileView; news: { lines: CouncilChange[]; notes: Coded[] } | null } | null {
    const fresh = settings.profiles.find((item) => item.id === profile.id);
    if (!fresh) return null;
    // the fingerprints decide whether it is the same council; the lines say what is different (and `other` when nothing names it)
    const lines = councilNews(shown, fresh.levels[level]);
    const known = new Set(shownNotes.map(noteKey));
    const notes = notesOf(settings, fresh, level).filter((note) => !known.has(noteKey(note)));
    return { fresh, news: lines.length > 0 ? { lines, notes } : null };
  }

  /**
   * The ask. The council is read again first and compared with what the page shows: the same council starts at once (a
   * revision or a timing that moved behind the page is no change to the council that was asked for); a different one is not
   * started silently: the card says WHAT changed, and one button asks with the updated council.
   */
  async function ask(accepted = false) {
    if (busy || view.blocked) return;
    if (!question.trim()) {
      setEmpty(true);
      field.current?.focus();
      return;
    }
    setBusy(true);
    setProblem(null);
    const shown = view;
    const shownNotes = notesOf(meta.settings, profile, level);
    try {
      let from = profile;
      if (!accepted) {
        const current = await api<Meta>('/meta').catch(() => null);
        if (current) {
          const seen = noticeChange(shown, shownNotes, current.settings);
          setState({ meta: current });
          if (seen?.news) {
            setChanged(seen.news);
            return;
          }
          if (seen) from = seen.fresh;
        }
      }
      setChanged(null);
      await start(from);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.body.view) {
        // it changed between the read and the start: the card says what is different now
        const settings = error.body.view as Meta['settings'];
        setState({ meta: { ...meta, settings } });
        const seen = noticeChange(shown, shownNotes, settings);
        if (error.code === 'stale' && seen?.news) setChanged(seen.news);
        else if (error.code === 'stale' && seen) {
          // the same council behind a newer revision: asked again once with it
          try {
            await start(seen.fresh);
          } catch (again) {
            setProblem(again instanceof ApiError ? again.message : t('common.serverError'));
          }
        } else setProblem(error.message);
      } else if (error instanceof ApiError && error.code === 'bad_cwd') {
        // the folder cannot be used: the reason is under its field, and the cursor goes there
        setFolderProblem(error.message);
        document.getElementById('folder')?.focus();
      } else {
        setProblem(error instanceof ApiError ? error.message : t('common.serverError'));
      }
    } finally {
      setBusy(false);
    }
  }

  /** One line of the card for one change. */
  function changeLine(change: CouncilChange): ReactNode {
    const name = (harness: string) =>
      HARNESS_LABEL[harness as keyof typeof HARNESS_LABEL] ?? harness;
    const mono = (value: string) => <Mono>{value || '–'}</Mono>;
    switch (change.kind) {
      case 'seatOff':
        return t('home.diffSeatOff', { name: name(change.harness) });
      case 'seatOn':
        return t('home.diffSeatOn', { name: name(change.harness) });
      case 'seatRemoved':
        return t('home.diffSeatRemoved', { name: name(change.harness) });
      case 'seatAdded':
        return t('home.diffSeatAdded', { name: name(change.harness) });
      case 'seatHarness':
        return t('home.diffSeatHarness', { name: name(change.from), to: name(change.to) });
      case 'seatModel':
        return tx(
          'home.diffSeatModel',
          { from: mono(change.from), to: mono(change.to) },
          { name: name(change.harness) },
        );
      case 'seatEffort':
        return tx(
          'home.diffSeatEffort',
          { from: mono(change.from), to: mono(change.to) },
          { name: name(change.harness) },
        );
      case 'chairmanHarness':
        return t('home.diffChairmanHarness', { from: name(change.from), to: name(change.to) });
      case 'chairmanModel':
        return tx('home.diffChairmanModel', { from: mono(change.from), to: mono(change.to) });
      case 'chairmanEffort':
        return tx('home.diffChairmanEffort', { from: mono(change.from), to: mono(change.to) });
      case 'seatToggle':
        return t(change.on ? 'home.diffToggleOn' : 'home.diffToggleOff', {
          name: name(change.harness),
          toggle: t(`ss.${change.toggle}`),
        });
      case 'seatSkipped':
        if (change.reason === 'missing')
          return noted.node(note('assistant_missing', { harness: name(change.harness) }));
        return t(change.reason === 'family' ? 'home.diffSeatFamily' : 'home.diffSeatSkipped', {
          name: name(change.harness),
        });
      case 'seatBack':
        return t('home.diffSeatBack', { name: name(change.harness) });
      case 'chairmanMemory':
        return t(change.on ? 'home.diffChairmanMemoryOn' : 'home.diffChairmanMemoryOff');
      case 'chairmanTools':
        return t(change.on ? 'home.diffToggleOn' : 'home.diffToggleOff', {
          name: t('ss.chairman'),
          toggle: t('ss.tools'),
        });
      case 'other':
        return t('home.diffOther');
      case 'limits':
        return t('home.diffLimits');
    }
  }

  // Ctrl+Enter asks from anywhere on the page, not only from inside a text box (focus is often on a level button or the council
  // picker when it is pressed). An empty question is answered by `ask` itself: it takes the cursor and says so.
  const askNow = useRef(ask);
  askNow.current = ask;
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
      if (event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      void askNow.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const chair = view.effective.chairman;
  const execution = flow
    ? agentsOf(flow).filter((agent) => agent.enabled !== false)
    : [...running, chair];
  const usesAgy = execution.some((agent) => agent.harness === 'agy');
  const oneProgram =
    !flow && running.length >= 2 && new Set(execution.map((agent) => agent.harness)).size === 1;
  const names = [
    ...new Set(
      execution.filter((agent) => agent.model).map((agent) => HARNESS_LABEL[agent.harness]),
    ),
  ].join(lang === 'fa' ? '، ' : ', ');
  const candidates = usableCandidates(
    meta.settings.models.filter(
      (item) => meta.settings.status.find((status) => status.id === item.harness)?.usable,
    ),
  );
  const candidate = candidates[0];
  const agyOnly =
    !candidate &&
    meta.settings.status.some((item) => item.id === 'agy' && item.usable) &&
    !meta.settings.status.some((item) => item.id !== 'agy' && item.usable);
  const [makingSingle, setMakingSingle] = useState(false);
  const creatingSingle = useRef(false);
  async function single() {
    if (!candidate || creatingSingle.current) return;
    creatingSingle.current = true;
    setMakingSingle(true);
    try {
      const made = await api<{ id: string; view: Meta['settings'] }>('/profiles', 'POST', {
        name: noted.text(
          note('home_single_name', {
            harness: HARNESS_LABEL[candidate.harness] ?? candidate.harness,
          }),
        ),
        template: 'single',
        firstRun: { harness: candidate.harness, model: candidate.model },
      });
      setState({ meta: { ...meta, settings: made.view } });
      choose(made.id);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : t('common.serverError'));
    } finally {
      creatingSingle.current = false;
      setMakingSingle(false);
    }
  }
  const memberFamilies = new Set(running.map((agent) => modelFamily(agent.model, agent.harness)));
  const chairFamily = modelFamily(chair.model, chair.harness);
  const companyNames: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    xai: 'xAI',
    google: 'Google',
    deepseek: 'DeepSeek',
    zhipu: 'Zhipu',
    alibaba: 'Alibaba',
    meta: 'Meta',
    mistral: 'Mistral',
    moonshot: 'Moonshot',
  };

  return (
    <div className="h-full overflow-y-auto" data-testid="home">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 sm:py-12">
        <Field data-invalid={empty || undefined}>
          <FieldLabel htmlFor="question" className="text-2xl font-semibold tracking-tight">
            {t('home.title')}
          </FieldLabel>
          <Textarea
            id="question"
            ref={field}
            data-testid="question"
            rows={4}
            className="max-h-80 min-h-28 text-base leading-7 md:text-base"
            dir={textDirection(question) ?? undefined}
            value={question}
            placeholder={t('home.placeholder')}
            aria-invalid={empty || undefined}
            onChange={(event) => {
              setQuestion(event.target.value);
              if (event.target.value.trim()) setEmpty(false);
            }}
          />
          {empty ? <FieldError data-testid="question-error">{t('home.empty')}</FieldError> : null}
          <FieldDescription>{t('home.hint')}</FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="context">{t('home.context')}</FieldLabel>
          <Textarea
            id="context"
            data-testid="context"
            rows={2}
            maxLength={MAX_CONTEXT_CHARS}
            className="max-h-48 min-h-14"
            dir={textDirection(context) ?? undefined}
            value={context}
            placeholder={t('home.contextPlaceholder')}
            onChange={(event) => setContext(event.target.value)}
          />
          <FieldDescription>{t('home.contextHint')}</FieldDescription>
        </Field>

        <Field data-invalid={folderProblem !== null || undefined}>
          <FieldLabel htmlFor="folder">{t('home.folder')}</FieldLabel>
          <FolderField
            id="folder"
            value={folder}
            onChange={(next) => {
              setFolder(next);
              setFolderProblem(null);
            }}
            recent={meta.recentFolders ?? []}
            invalid={folderProblem !== null}
            describedBy="folder-help"
          />
          {folderProblem ? (
            <FieldError id="folder-help" data-testid="folder-error">
              {folderProblem}
            </FieldError>
          ) : (
            <FieldDescription id="folder-help" data-testid="folder-help">
              {cwd ? t('home.folderSet') : t('home.folderEmpty')}
            </FieldDescription>
          )}
        </Field>

        <section
          aria-labelledby="council-heading"
          className="flex flex-col gap-4"
          data-testid="council-card"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="council-heading"
              className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t('home.council')}
            </h2>
            <Button
              variant="link"
              size="sm"
              data-testid="edit-council"
              render={<a href={`#/models/${profile.id}?level=${level}`} />}
            >
              {t('home.editCouncil')}
              <ArrowRightIcon className="rtl:rotate-180" />
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Select
              value={profile.id}
              onValueChange={(value) => value && choose(value)}
              items={profiles.map((item) => ({ value: item.id, label: profileName(item, t) }))}
            >
              <SelectTrigger
                className="min-w-48"
                aria-label={t('home.council')}
                data-testid="council-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {profiles.map((item) => (
                  <SelectItem key={item.id} value={item.id} data-profile-id={item.id}>
                    {profileName(item, t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="ms-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground" aria-hidden="true">
                {t('level.caption')}
              </span>
              {/* Tab lands on the level that is selected, and the arrow keys move inside the group */}
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={0}
                aria-label={t('level.label')}
                value={[level]}
                onValueChange={(value) => value[0] && chooseLevel(value[0] as ReasoningLevel)}
                data-testid="level-picker"
                onFocus={(event) => {
                  // focus that comes into the group from outside goes to the selected level
                  const group = event.currentTarget;
                  if (group.contains(event.relatedTarget as Node | null)) return;
                  const selected = group.querySelector<HTMLElement>('[aria-pressed="true"]');
                  if (selected && event.target !== selected) selected.focus();
                }}
              >
                {REASONING_LEVELS.map((item) => (
                  <ToggleGroupItem key={item} value={item} data-testid={`level-${item}`}>
                    {t(`level.${item}` as Key)}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>
          </div>

          <div className="flex flex-col gap-2 rounded-lg border bg-card/50 p-4">
            {running.length || candidate ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <UsersIcon className="size-4 shrink-0" />
                {running.length
                  ? t(flow ? 'home.flowSeats' : 'home.seats', { n: answering })
                  : noted.node(note('home_no_council'))}
              </p>
            ) : null}
            <ul
              className="flex flex-col gap-1"
              data-testid="council-seats"
              aria-label={t('home.council')}
            >
              {running.map((seat) => (
                // the assistant, then what it runs: its model and its effort, as secondary text
                <li key={seat.id} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium" translate="no" data-testid="seat-name">
                    {HARNESS_LABEL[seat.harness] ?? seat.harness}
                  </span>
                  <span className="text-xs text-muted-foreground" data-testid="seat-runs">
                    <Mono>{seat.model}</Mono>
                    {seat.effort ? (
                      // the effort is a level's word: «متوسط» in Persian, the machine value elsewhere
                      <span>
                        {' · '}
                        {effortName(seat.effort) !== seat.effort ? (
                          effortName(seat.effort)
                        ) : (
                          <Mono>{seat.effort}</Mono>
                        )}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {flow || !chair.model ? null : (
              // the chairman's model too: with one company the chairman is told apart by its model alone
              <p
                className="flex flex-wrap items-baseline gap-x-2 text-sm"
                data-testid="council-chair"
              >
                <span>
                  {t('home.chair', { name: HARNESS_LABEL[chair.harness] ?? chair.harness })}
                </span>
                <span className="text-xs text-muted-foreground">
                  <Mono>{chair.model}</Mono>
                </span>
              </p>
            )}
            {profile.base === 'quick' ? (
              <QuickNote profile={profile} speeds={meta.settings.speeds} />
            ) : null}
            {overrides.length > 0 ? (
              <p className="text-xs text-muted-foreground" data-testid="level-overrides">
                {tx(
                  'home.ovLine',
                  {
                    parts: overrides.map((part, index) => (
                      // the list is built in one pass and never reordered
                      // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of fragments
                      <span key={index}>
                        {part}
                        {index < overrides.length - 1 ? (lang === 'fa' ? '، ' : ', ') : ''}
                      </span>
                    )),
                  },
                  { level: t(`level.${level}` as Key) },
                )}
              </p>
            ) : null}
          </div>

          {unavailable.length > 0 ? (
            <Alert data-testid="missing-assistants">
              <AlertTriangleIcon />
              <AlertDescription>
                {t('home.missing', {
                  names: [
                    ...new Set(
                      unavailable.map((seat) => HARNESS_LABEL[seat.harness] ?? seat.harness),
                    ),
                  ].join(', '),
                  count: answering,
                })}{' '}
                <a
                  className="underline underline-offset-4"
                  href={`#/models/${profile.id}?level=${level}`}
                >
                  {t('home.missingFix')}
                </a>
              </AlertDescription>
            </Alert>
          ) : null}
          {(['out', 'family'] as const).map((reason) => {
            const seats = skipped.filter((seat) =>
              view.skipped.some((item) => item.id === seat.id && item.reason === reason),
            );
            if (seats.length === 0) return null;
            return (
              <Alert key={reason} data-testid="skipped-assistants">
                <AlertTriangleIcon />
                <AlertDescription>
                  {t(reason === 'out' ? 'home.skippedOut' : 'home.skippedFamily', {
                    names: [
                      ...new Set(seats.map((seat) => HARNESS_LABEL[seat.harness] ?? seat.harness)),
                    ].join(', '),
                    count: answering,
                  })}
                </AlertDescription>
              </Alert>
            );
          })}
          {view.blocked ? (
            <Alert variant="destructive" data-testid="council-blocked">
              <AlertTriangleIcon />
              <AlertTitle>{t('home.blocked')}</AlertTitle>
              <AlertDescription>
                {noted.node(
                  agyOnly && view.blocked.code === 'no_assistant'
                    ? note('agy_manual')
                    : view.blocked,
                )}
              </AlertDescription>
            </Alert>
          ) : null}
        </section>

        <AssistantsCard
          meta={meta}
          names={names}
          onChecked={(settings) => {
            const seen = noticeChange(view, notesOf(meta.settings, profile, level), settings);
            if (seen?.news) setChanged(seen.news);
            setState({ meta: { ...meta, settings } });
          }}
        />
        {meta.settings.notes
          .filter((item) => item.code === 'settings_corrupt')
          .map((item) => (
            <Alert key={noteKey(item)}>
              <AlertDescription>{noted.node(item)}</AlertDescription>
            </Alert>
          ))}
        <p className="ds-group__desc" data-testid="read-access">
          {noted.node(note(usesAgy ? 'agy_controlled_note' : 'home_access'))}
        </p>
        {changed ? (
          <Alert data-testid="council-changed">
            <AlertTriangleIcon />
            <AlertTitle>{t('home.changedTitle')}</AlertTitle>
            <AlertDescription className="flex flex-col gap-2">
              <ul className="list-disc ps-5" data-testid="council-diff">
                {changed.lines.map((line, index) => (
                  // the lines are built in one pass and never reordered
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list of changes
                  <li key={index}>{changeLine(line)}</li>
                ))}
              </ul>
              {changed.notes.length > 0 ? (
                <ul className="flex flex-col gap-1 text-muted-foreground" data-testid="council-why">
                  {changed.notes.map((note) => (
                    <li key={noteKey(note)}>{noted.node(note)}</li>
                  ))}
                </ul>
              ) : null}
              <div>
                <Button
                  size="sm"
                  data-testid="ask-updated"
                  disabled={busy}
                  onClick={() => void ask(true)}
                >
                  {t('home.askUpdated')}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
        {problem ? (
          <Alert variant="destructive" data-testid="start-error">
            <AlertTriangleIcon />
            <AlertDescription>{problem}</AlertDescription>
          </Alert>
        ) : null}

        {/* the ask bar stays in view: with four members and an override line the button would be below the fold */}
        <div
          className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-4 border-t bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
          data-testid="ask-bar"
        >
          {usesAgy ? (
            <p className="basis-full text-xs" data-testid="agy-warning">
              {noted.node(note('agy_warning'))}
            </p>
          ) : null}
          {oneProgram ? (
            <p className="basis-full text-xs text-muted-foreground" data-testid="one-program-note">
              {noted.node(
                note('one_assistant_council', {
                  harness: HARNESS_LABEL[chair.harness] ?? chair.harness,
                }),
              )}
            </p>
          ) : null}
          {!flow &&
          running.length >= 2 &&
          memberFamilies.size === 1 &&
          chairFamily !== 'unknown' ? (
            <p className="basis-full text-xs text-muted-foreground" data-testid="company-note">
              {noted.node(
                note(
                  chairFamily === [...memberFamilies][0]
                    ? 'home_one_company'
                    : 'home_two_companies',
                  { company: companyNames[chairFamily] ?? chairFamily },
                ),
              )}
            </p>
          ) : null}
          {!view.blocked && names ? (
            <p className="basis-full text-xs text-muted-foreground" data-testid="call-cost">
              {noted.node(
                execution.filter((agent) => agent.model).length === 1
                  ? note('home_call', { names })
                  : note('home_calls', {
                      names,
                      calls: execution.filter((agent) => agent.model).length,
                    }),
              )}
            </p>
          ) : null}
          {candidate ? (
            <Button
              variant={view.blocked ? 'outline' : 'link'}
              size="sm"
              data-testid="use-single"
              disabled={makingSingle}
              onClick={() => void single()}
            >
              {makingSingle ? <Spinner /> : null}
              <span>
                {noted.node(
                  note('home_single', {
                    harness: HARNESS_LABEL[candidate.harness] ?? candidate.harness,
                    model: candidate.model,
                  }),
                )}
              </span>
            </Button>
          ) : null}
          <Button
            size="lg"
            data-testid="start"
            disabled={busy || Boolean(view.blocked)}
            onClick={() => void ask()}
          >
            {busy ? <Spinner aria-label={t('home.starting')} /> : null}
            {busy ? t('home.starting') : t('home.ask')}
          </Button>
          {usual ? (
            <p className="text-sm text-muted-foreground" data-testid="usual">
              {t('home.usualTime', { time: usual })}
            </p>
          ) : null}
        </div>

        {live.length > 0 ? (
          <section
            aria-labelledby="continue-heading"
            className="flex flex-col gap-2"
            data-testid="continue"
          >
            <h2
              id="continue-heading"
              className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {t('home.continue')}
            </h2>
            <ul className="flex flex-col divide-y rounded-lg border">
              {live.map((item) => (
                <ContinueRow key={item.id} item={item} />
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function ContinueRow({ item }: { item: SessionSummary }) {
  const { t } = useI18n();
  return (
    <li>
      <a
        href={`#/s/${item.id}`}
        className="flex items-center gap-3 px-4 py-3 text-sm outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ListText text={item.title} className="flex-1" />
        <Badge variant={item.running ? 'secondary' : 'outline'}>
          {item.running ? (
            <Spinner className="size-3" aria-label={t('status.running')} />
          ) : (
            <CheckIcon />
          )}
          {item.running ? t('status.running') : t('status.ready')}
        </Badge>
      </a>
    </li>
  );
}
