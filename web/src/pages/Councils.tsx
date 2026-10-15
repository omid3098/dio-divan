// Councils: the saved councils (profiles) and the editor of one. Every council is edited on a canvas (`design/DesignPage.tsx`): the
// input, each member, the chairman and the answer, drawn like a design. A council stays a council while the edits are ones a
// council can say, and becomes a design when one is not (after a question). Editing a council changes the saved council for
// everything that uses it (Pi, T3 Code, Dio Divan), so it is an explicit save: a dirty bar, a save that names what it does, a 409
// screen when the council changed somewhere else, and a question when the page is left with unsaved changes. The base council
// (members, chairman, answer limits) has its own tab; each reasoning level (Low, Medium, High, Max) inherits from it and can
// override any member's model or effort, a member on or off, and the chairman, for that level only.

import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UsersIcon,
  WorkflowIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { detect } from '@/actions';
import { ApiError, api } from '@/api';
import { Mono } from '@/components/bidi';
import { CopyButton } from '@/components/copy-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { HARNESS_LABEL } from '@/fa';
import { hasKey, type I18n, type Key, useI18n } from '@/i18n/index.tsx';
import { type Coded, noteKey, noteText, useNotes } from '@/i18n/notes.tsx';
import { type LeaveTarget, navigate, setLeaveGuard } from '@/leave-guard';
import { profileName } from '@/lib/profile';
import { cn } from '@/lib/utils';
import { type CouncilTab, type Route, replaceRoute } from '@/router';
import { getState, setState } from '@/store';
import { chairmanFamilyClash, QUICK_BLOCKED } from '../../../src/shared/defaults.ts';
import { agentsOf, maxCalls } from '../../../src/shared/flow.ts';
import { hasLevelOverrides, REASONING_LEVELS } from '../../../src/shared/levels.ts';
import { modelFamily } from '../../../src/shared/text.ts';
import type { Meta, ProfileView, SettingsFull, SettingsView } from '../../../src/shared/types.ts';
import { councilFlow } from './councils/design/council.ts';
import { DesignPage } from './councils/design/DesignPage.tsx';
import { blockerOf } from './councils/design/describe.ts';
import { CouncilSettings } from './councils/design/Settings.tsx';
import {
  ConfirmDialog,
  IdDialog,
  LeaveDialog,
  NameDialog,
  type TemplateChoice,
} from './councils/dialogs.tsx';
import { LevelTabs } from './councils/LevelTabs.tsx';
import { useCouncilForm } from './councils/use-council-form.ts';
import { QuickNote } from './QuickNote.tsx';

const PROFILE_KEY = 'divan-profile';

/** The most assistant calls one round of this model makes (a council: its members that take part and its chairman). */
const callsOf = (settings: SettingsFull): number =>
  maxCalls(settings.flow ?? councilFlow(settings));

/** One line about a council: its assistants and the chair («Claude Code, Codex · chair Pi»). */
function summary(settings: SettingsFull, t: I18n['t']): string {
  if (settings.flow)
    return [
      ...new Set(
        agentsOf(settings.flow)
          .filter((agent) => agent.enabled !== false)
          .map((agent) => HARNESS_LABEL[agent.harness]),
      ),
    ].join(', ');
  const names = settings.seats
    .filter((seat) => seat.enabled)
    .map((seat) => HARNESS_LABEL[seat.harness] ?? seat.harness);
  return t('councils.summary', {
    members: [...new Set(names)].join(', '),
    chair: HARNESS_LABEL[settings.chairman.harness] ?? settings.chairman.harness,
  });
}

export function Councils({
  meta,
  route,
}: {
  meta: Meta;
  route: Extract<Route, { name: 'councils' }>;
}) {
  const { t } = useI18n();
  const view = meta.settings;
  const wanted = route.id ?? localStorage.getItem(PROFILE_KEY) ?? 'default';
  const profile =
    view.profiles.find((item) => item.id === wanted) ?? (view.profiles[0] as ProfileView);
  const [naming, setNaming] = useState<'new' | null>(null);
  /** The two starting points of a new council (from the server), asked for when the dialog opens. */
  const [templates, setTemplates] = useState<TemplateChoice[]>([]);
  const strip = useRef<HTMLUListElement>(null);

  useEffect(() => {
    localStorage.setItem(PROFILE_KEY, profile.id);
    strip.current
      ?.querySelector('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [profile.id]);

  useEffect(() => {
    if (naming !== 'new') return;
    let live = true;
    api<{ id: string; name: Coded }[]>('/flow-templates')
      .then((found) => {
        if (live)
          setTemplates(
            found.map((item) => ({
              id: item.id,
              label: noteText(item.name),
              hint: hasKey(`flow.template.${item.id}.hint`)
                ? t(`flow.template.${item.id}.hint` as Key)
                : '',
            })),
          );
      })
      .catch(() => live && setTemplates([]));
    return () => {
      live = false;
    };
  }, [naming, t]);

  async function create(name: string, id?: string, template?: string): Promise<string | null> {
    try {
      const made = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
        name,
        ...(id ? { id } : {}),
        ...(template ? { template } : {}),
      });
      setState({ meta: { ...meta, settings: made.view } });
      setNaming(null);
      navigate(`#/models/${made.id}`);
      return null;
    } catch (error) {
      return error instanceof ApiError ? error.message : t('common.serverError');
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="councils">
      {/* the councils as a strip: each one is a model other tools call by its id; a design has its own mark */}
      <nav
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        aria-label={t('nav.councils')}
      >
        <ul
          ref={strip}
          className="hidden min-w-0 items-center gap-1 overflow-x-auto md:flex"
          data-testid="council-list"
        >
          {view.profiles.map((item) => (
            <li key={item.id} className="shrink-0">
              <a
                href={`#/models/${item.id}`}
                data-profile-id={item.id}
                aria-current={item.id === profile.id ? 'page' : undefined}
                title={`${summary(item.effective, t)} · ${t('flow.calls', { count: callsOf(item.effective) })}`}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-transparent px-3 py-1.5 text-sm outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
                  item.id === profile.id && 'border-border bg-muted',
                )}
              >
                {item.effective.flow ? (
                  <WorkflowIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                ) : (
                  <UsersIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                )}
                <span className="max-w-40 truncate font-medium" dir="auto">
                  {profileName(item, t)}
                </span>
                {item.id === 'default' && profileName(item, t) !== t('councils.defaultPill') ? (
                  <Badge variant="secondary">{t('councils.defaultPill')}</Badge>
                ) : null}
                {item.blocked ? <Badge variant="destructive">{t('connect.blocked')}</Badge> : null}
                <Mono className="text-xs text-muted-foreground">divan/{item.id}</Mono>
              </a>
            </li>
          ))}
        </ul>
        <Select
          value={profile.id}
          items={view.profiles.map((item) => ({ value: item.id, label: profileName(item, t) }))}
          onValueChange={(next) => next && navigate(`#/models/${next}`)}
        >
          <SelectTrigger
            className="min-w-48 flex-1 md:hidden"
            aria-label={t('home.council')}
            data-testid="council-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {view.profiles.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {profileName(item, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="profile-new"
          aria-label={t('councils.new')}
          onClick={() => setNaming('new')}
        >
          <PlusIcon />
          <span className="hidden lg:inline">{t('councils.new')}</span>
        </Button>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <CouncilEditor key={profile.id} meta={meta} profile={profile} tab={route.tab ?? 'base'} />
      </div>

      {naming ? (
        <NameDialog
          title={t('councils.newTitle')}
          initial=""
          askId
          taken={view.profiles.map((item) => item.id)}
          templates={templates}
          onSubmit={create}
          onClose={() => setNaming(null)}
        />
      ) : null}
    </div>
  );
}

// ---------- the editor of one council ----------

function CouncilEditor({
  meta,
  profile,
  tab: initialTab,
}: {
  meta: Meta;
  profile: ProfileView;
  tab: CouncilTab;
}) {
  const { t } = useI18n();
  const noted = useNotes();
  const view = meta.settings;
  const council = useCouncilForm(meta, profile);
  const {
    form,
    setForm,
    dirty,
    baseDirty,
    anyLevelDirty,
    levelDirty,
    phase,
    problem,
    moved,
    baseline,
    save,
    cancel,
    rebase,
    publish,
  } = council;
  const [tab, setTabState] = useState<CouncilTab>(initialTab);
  const [busy, setBusy] = useState<'refresh' | 'profile' | 'leave' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState<'duplicate' | 'rename' | null>(null);
  const [editingId, setEditingId] = useState(false);
  const [confirming, setConfirming] = useState<'reset' | 'delete' | 'reload' | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** What waits for the user to say what happens to the unsaved edits (save, throw away, or stay), and where it goes. */
  const [leaving, setLeaving] = useState<{ go: () => void; goal: string } | null>(null);
  const frozen = phase === 'saving' || busy === 'leave';
  const path = `/profiles/${encodeURIComponent(profile.id)}`;
  const name = profileName(profile, t);

  // a link that names a level (from Home's «Edit this council») opens it
  useEffect(() => setTabState(initialTab), [initialTab]);
  const setTab = (next: CouncilTab) => {
    setTabState(next);
    replaceRoute({ name: 'councils', id: profile.id, tab: next });
  };

  /** Runs `proceed` when the form has nothing unsaved; otherwise asks first: save (and go on only if the save worked), throw the changes away, or stay. */
  const guard = (proceed: () => void, goal: string) => {
    if (dirty || phase === 'saving' || phase === 'conflict') setLeaving({ go: proceed, goal });
    else proceed();
  };
  // the same question for the router: a sidebar link, Back and Forward ask here too (`web/src/leave-guard.ts`)
  const asking = useRef(guard);
  asking.current = guard;
  const unsaved = useRef(false);
  unsaved.current = dirty || phase === 'saving' || phase === 'conflict';
  const targetGoal = useRef((_target: LeaveTarget, _hash?: string): string => '');
  targetGoal.current = (target, hash) => {
    // the button says where it goes: «open Quick», «open “Which database?”», not just «go to Councils»
    if (target === 'councils') {
      const id = /^#\/(?:models|councils)\/([A-Za-z0-9_-]+)/u.exec(hash ?? '')?.[1];
      const item = view.profiles.find((one) => one.id === id);
      if (item) return t('councils.goal.openCouncil', { name: profileName(item, t) });
    }
    if (target === 'session') {
      const id = /^#\/s\/([A-Za-z0-9_-]+)/u.exec(hash ?? '')?.[1];
      const title = getState().sessions.find((one) => one.id === id)?.title;
      if (title) return t('councils.goal.openSession', { name: title });
    }
    return t(`councils.goal.${target}` as Key);
  };
  useEffect(() => {
    setLeaveGuard({
      dirty: () => unsaved.current,
      ask: (proceed, target, goal, hash) =>
        asking.current(proceed, goal ?? targetGoal.current(target, hash)),
    });
    return () => setLeaveGuard(null);
  }, []);

  /** Saves, then goes on: the form is read-only meanwhile, and nothing goes on unless the latest form was acknowledged. */
  async function saveThen(go: () => void) {
    setBusy('leave');
    try {
      if ((await save()) !== null) go();
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    setBusy('refresh');
    try {
      // what this PC has now; a form with edits keeps them, and its save is then checked against the new settings
      publish(await detect());
    } finally {
      setBusy(null);
    }
  }

  async function resetAll() {
    setConfirming(null);
    setBusy('profile');
    try {
      await save({ reset: true });
    } finally {
      setBusy(null);
    }
  }

  async function removeProfile() {
    setConfirming(null);
    setBusy('profile');
    try {
      publish(await api<SettingsView>(path, 'DELETE'));
      navigate('#/models/default');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('councils.deleteFailed'));
    } finally {
      setBusy(null);
    }
  }

  /** Rename, copy: resolves with a problem to show in the dialog (it stays open for another try), or null when it is done. */
  async function submitName(next: string, id?: string): Promise<string | null> {
    const mode = naming;
    if (dirty) return t('councils.unsavedFirst');
    setBusy('profile');
    setError(null);
    try {
      if (mode === 'rename') {
        rebase(await api<SettingsView>(path, 'PUT', { name: next, ifRevision: baseline.revision }));
      } else {
        const made = await api<{ id: string; view: SettingsView }>('/profiles', 'POST', {
          name: next,
          ...(id ? { id } : {}),
          from: profile.id,
        });
        publish(made.view);
        navigate(`#/models/${made.id}`);
      }
      setNaming(null);
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : t('common.serverError');
    } finally {
      setBusy(null);
    }
  }

  /** The council under another id (the id alone is sent); the page then follows it to its new id. */
  async function submitId(id: string): Promise<string | null> {
    if (dirty) return t('councils.unsavedFirst');
    setBusy('profile');
    try {
      publish(await api<SettingsView>(path, 'PUT', { id, ifRevision: baseline.revision }));
      setEditingId(false);
      navigate(`#/models/${id}`);
      return null;
    } catch (e) {
      return e instanceof ApiError ? e.message : t('common.serverError');
    } finally {
      setBusy(null);
    }
  }

  const isCouncil = form.base.flow === undefined;
  const enabledBase = form.base.seats.filter((seat) => seat.enabled);
  const seatFamilies = new Set(enabledBase.map((seat) => modelFamily(seat.model, seat.harness)));
  const sharedFamily =
    form.base.chairman.model !== '' &&
    seatFamilies.has(modelFamily(form.base.chairman.model, form.base.chairman.harness));
  const quickBlocked =
    profile.base === 'quick' && chairmanFamilyClash(enabledBase, form.base.chairman);
  /** There is something saved to take away: a change, a level change, or a design. */
  const overridden =
    profile.effective.flow !== undefined ||
    Object.keys(profile.overrides).length > 0 ||
    REASONING_LEVELS.some((level) => hasLevelOverrides(profile.levels[level].overrides));
  const notes = [...view.notes, ...profile.notes];
  const needsBase = tab !== 'base' && baseDirty;
  const baseLocked = tab === 'base' && anyLevelDirty;
  const readOnly = frozen || needsBase || baseLocked;
  /** A design is a flow of its own; a council is drawn from its members (and becomes a design when an edit asks for it). */
  const design = !isCouncil;
  /** Why a design cannot be saved (the first problem, in words), or null. */
  const blocker = design ? blockerOf(form, levelDirty, t, noteText) : null;
  const levelStatus = tab === 'base' ? null : profile.levels[tab];
  const manageMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('councils.manage')}
            data-testid="profile-menu"
          />
        }
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          data-testid="profile-duplicate"
          disabled={busy !== null}
          onClick={() => guard(() => setNaming('duplicate'), t('councils.goal.duplicate'))}
        >
          <CopyIcon />
          {t('councils.duplicate')}
        </DropdownMenuItem>
        {profile.auto ? null : (
          <>
            <DropdownMenuItem
              data-testid="profile-rename"
              disabled={busy !== null}
              onClick={() => guard(() => setNaming('rename'), t('councils.goal.rename'))}
            >
              <PencilIcon />
              {t('common.rename')}
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="profile-id-edit"
              disabled={busy !== null}
              onClick={() => guard(() => setEditingId(true), t('councils.goal.id'))}
            >
              <PencilIcon />
              {t('councils.editId')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-testid="profile-delete"
              disabled={busy !== null}
              onClick={() => setConfirming('delete')}
            >
              <Trash2Icon />
              {t('common.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const header = (calls: number) => (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2"
      data-testid="design-header"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h2
          className="max-w-64 truncate text-base font-semibold"
          dir="auto"
          data-testid="council-name"
        >
          {name}
        </h2>
        <Badge variant="secondary" data-testid="mode-badge">
          {design ? t('flow.designBadge') : t('flow.councilBadge')}
        </Badge>
        {profile.id === 'default' && name !== t('councils.defaultPill') ? (
          <Badge variant="secondary">{t('councils.defaultPill')}</Badge>
        ) : null}
        <span
          className="flex items-center gap-1 text-sm text-muted-foreground"
          data-testid="profile-id-line"
        >
          <span className="hidden xl:inline">{t('councils.modelName')}</span>
          <Mono>divan/{profile.id}</Mono>
          <CopyButton text={`divan/${profile.id}`} size="xs" data-testid="copy-model-name" />
        </span>
        <span
          className="text-sm text-muted-foreground"
          data-testid="max-calls"
          title={t('flow.calls.hint')}
        >
          {t('flow.calls', { count: calls })}
        </span>
      </div>
      <div className="ms-auto flex items-center gap-2">
        <LevelTabs
          tab={tab}
          onTab={setTab}
          baseDirty={baseDirty}
          anyLevelDirty={anyLevelDirty}
          levelDirty={levelDirty}
        />
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t('flow.settings.open')}
          title={t('flow.settings.open')}
          data-testid="council-settings"
          onClick={() => setSettingsOpen(true)}
        >
          <SlidersHorizontalIcon />
        </Button>
        {manageMenu}
      </div>
    </div>
  );
  const pageNotices = (
    <>
      {needsBase ? (
        <Alert className="mx-4 mt-3 w-auto" data-testid="base-first">
          <AlertTriangleIcon />
          <AlertDescription>{t('councils.baseFirst')}</AlertDescription>
        </Alert>
      ) : null}
      {baseLocked ? (
        <Alert className="mx-4 mt-3 w-auto" data-testid="levels-first">
          <AlertTriangleIcon />
          <AlertDescription>{t('councils.levelsFirst')}</AlertDescription>
        </Alert>
      ) : null}
      {profile.base === 'quick' ? (
        <div className="mx-4 mt-3">
          <QuickNote profile={profile} speeds={view.speeds} />
        </div>
      ) : null}
      {levelStatus?.blocked ? (
        <Alert variant="destructive" className="mx-4 mt-3 w-auto" data-testid="level-blocked">
          <AlertTriangleIcon />
          <AlertDescription>{noted.node(levelStatus.blocked)}</AlertDescription>
        </Alert>
      ) : null}
      {levelStatus && levelStatus.notes.length > 0 ? (
        <Alert className="mx-4 mt-3 w-auto" data-testid="level-notes">
          <AlertTriangleIcon />
          <AlertDescription className="flex flex-col gap-1">
            {levelStatus.notes.map((note) => (
              <span key={noteKey(note)}>{noted.node(note)}</span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      {isCouncil && tab === 'base' && quickBlocked ? (
        <Alert variant="destructive" className="mx-4 mt-3 w-auto" data-testid="quick-blocked">
          <AlertTriangleIcon />
          <AlertDescription>{noted.node(QUICK_BLOCKED)}</AlertDescription>
        </Alert>
      ) : isCouncil && tab === 'base' && sharedFamily ? (
        <p
          className="mx-4 mt-3 flex items-center gap-1.5 text-xs text-muted-foreground"
          data-testid="family-warning"
        >
          <AlertTriangleIcon className="size-3.5" />
          {t('councils.family')}
        </p>
      ) : null}
      {view.notes
        .filter((item) => item.code === 'settings_corrupt')
        .map((item) => (
          <Alert className="mx-4 mt-3 w-auto" key={noteKey(item)}>
            <AlertDescription>{noteText(item)}</AlertDescription>
          </Alert>
        ))}
      {notes.length > 0 ? (
        <Alert className="mx-4 mt-3 w-auto" data-testid="setup-notes">
          <AlertTriangleIcon />
          <AlertTitle className="flex items-center gap-2">
            {t('councils.autoChanges', { n: notes.length })}
            <Button
              variant="link"
              size="xs"
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen((value) => !value)}
            >
              {notesOpen ? t('common.hide') : t('common.details')}
            </Button>
          </AlertTitle>
          {notesOpen ? (
            <AlertDescription className="flex flex-col gap-1">
              {notes.map((note) => (
                <span key={noteKey(note)}>{noted.node(note)}</span>
              ))}
            </AlertDescription>
          ) : null}
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert" className="mx-4 mt-3 w-auto">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="council-editor"
      data-design={design || undefined}
    >
      <DesignPage
        meta={meta}
        profile={profile}
        form={form}
        setForm={setForm}
        baseline={baseline}
        tab={tab}
        readOnly={readOnly}
        header={header}
        notices={pageNotices}
      />

      <CouncilSettings
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        profile={profile}
        view={view}
        form={form}
        setForm={setForm}
        design={design}
        readOnly={readOnly}
        frozen={frozen}
        overridden={overridden}
        checking={busy === 'refresh'}
        onCheck={() => void refresh()}
        onReset={() => {
          setSettingsOpen(false);
          setConfirming('reset');
        }}
      />

      {/* the save bar */}
      {dirty || phase !== 'idle' ? (
        <div
          className="flex flex-wrap items-center gap-3 border-t bg-background px-4 py-3 sm:px-6"
          data-testid="savebar"
          data-phase={phase}
        >
          {dirty ? (
            <span
              className="flex items-center gap-2 text-sm font-medium"
              data-testid="dirty-marker"
            >
              <span className="size-2 rounded-full bg-foreground" aria-hidden="true" />
              {t('councils.unsaved')}
            </span>
          ) : null}
          {phase === 'saving' ? (
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              role="status"
              data-cue="saving"
              data-testid="save-cue"
            >
              <Spinner className="size-3.5" aria-label={t('councils.saving')} />
              {t('councils.saving')}
            </span>
          ) : null}
          {phase === 'saved' && !dirty ? (
            <span
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
              role="status"
              data-cue="saved"
              data-testid="save-cue"
            >
              <CheckIcon className="size-3.5" />
              {t('councils.saved')}
            </span>
          ) : null}
          {phase === 'error' ? (
            <span
              className="flex flex-wrap items-center gap-2 text-sm text-destructive"
              role="alert"
              data-testid="save-error"
            >
              {t('councils.saveFailed', { problem: problem ?? '' })}
              <Button
                variant="outline"
                size="sm"
                data-testid="save-retry"
                onClick={() => void save()}
              >
                <RefreshCwIcon />
                {t('common.retry')}
              </Button>
            </span>
          ) : null}
          {phase === 'conflict' ? (
            <span
              className="flex flex-wrap items-center gap-2 text-sm"
              role="alert"
              data-testid="save-conflict"
            >
              {t('councils.conflict')}
              <Button
                variant="outline"
                size="sm"
                data-testid="reload-profile"
                disabled={busy !== null}
                onClick={() => setConfirming('reload')}
              >
                <RefreshCwIcon />
                {t('councils.reload')}
              </Button>
            </span>
          ) : null}
          {blocker && dirty ? (
            <span
              className="flex items-center gap-1.5 text-sm"
              data-testid="save-blocker"
              title={blocker}
            >
              <AlertTriangleIcon className="size-4 text-amber-600 dark:text-amber-400" />
              {t('flow.fixToSave')}
            </span>
          ) : null}
          {dirty && !moved ? (
            <span className="ms-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                data-testid="cancel-changes"
                disabled={frozen}
                onClick={cancel}
              >
                {t('councils.discard')}
              </Button>
              <Button
                size="sm"
                data-testid="save-profile"
                disabled={frozen || blocker !== null}
                onClick={() => void save()}
              >
                {t('councils.save', { name })}
              </Button>
            </span>
          ) : null}
        </div>
      ) : null}

      {naming ? (
        <NameDialog
          title={naming === 'rename' ? t('councils.renameTitle') : t('councils.duplicateTitle')}
          initial={naming === 'rename' ? name : t('councils.copyOf', { name })}
          askId={naming !== 'rename'}
          taken={view.profiles.map((item) => item.id)}
          onSubmit={submitName}
          onClose={() => setNaming(null)}
        />
      ) : null}
      {editingId ? (
        <IdDialog current={profile.id} onSubmit={submitId} onClose={() => setEditingId(false)} />
      ) : null}

      {confirming === 'reset' ? (
        <ConfirmDialog
          title={t('councils.resetTitle')}
          text={`${t(design ? 'flow.settings.resetTextDesign' : 'councils.resetText', { name })}${dirty ? ` ${t('councils.resetUnsaved')}` : ''}`}
          confirm={t('councils.resetConfirm')}
          testid="confirm-reset"
          onConfirm={() => void resetAll()}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {confirming === 'delete' ? (
        <ConfirmDialog
          title={t('councils.deleteTitle')}
          text={`${t('councils.deleteText', { name, id: profile.id })}${dirty ? ` ${t('councils.resetUnsaved')}` : ''}`}
          confirm={t('common.delete')}
          testid="confirm-delete-profile"
          onConfirm={() => void removeProfile()}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {confirming === 'reload' ? (
        <ConfirmDialog
          title={t('councils.reloadTitle')}
          text={t('councils.reloadText', { name })}
          confirm={t('councils.discard')}
          testid="confirm-reload"
          onConfirm={() => {
            setConfirming(null);
            cancel();
          }}
          onClose={() => setConfirming(null)}
        />
      ) : null}
      {leaving ? (
        <LeaveDialog
          council={name}
          goal={leaving.goal}
          blocked={blocker}
          onStay={() => setLeaving(null)}
          onDiscard={() => {
            const { go } = leaving;
            setLeaving(null);
            cancel();
            go();
          }}
          onSave={() => {
            const { go } = leaving;
            setLeaving(null);
            void saveThen(go);
          }}
        />
      ) : null}
    </div>
  );
}
