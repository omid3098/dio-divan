// The session page: the answer (a reading column) beside the map of rounds. The selected round, and the details open over the
// map, are part of the address. From 980 px of room they sit side by side; below that they are two tabs (the answer first).
// Live updates arrive over the event stream; layout writes go through `layout-sync`.

import { GitForkIcon, MousePointerClickIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Ghost, Graph } from '@/canvas/Graph';
import { computeLayout } from '@/canvas/layout';
import { lastNodeOf, rememberNode } from '@/components/app-sidebar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  type AnswerDrafts,
  answersAfterSend,
  answersOf,
  commentAfterSend,
  withAnswer,
} from '@/drafts';
import { useI18n } from '@/i18n/index.tsx';
import {
  arrangeNodes,
  moveNode,
  resumeLayoutSync,
  retryLayoutSync,
  useLayoutSync,
} from '@/layout-sync';
import { ChairPanel } from '@/panel/ChairPanel';
import { type Anchor, DetailsDrawer } from '@/panel/details';
import { UserPanel } from '@/panel/UserPanel';
import { type Detail, type Route, replaceRoute } from '@/router';
import { chairSpend } from '@/spend';
import { getState, markSeen, useAppState } from '@/store';
import type { ChairNode, LayoutDirection, Session } from '../../../src/shared/types.ts';
import { routeSelection } from './session-route.ts';

/** The answer column is 42% of the page, between 560 and 624 px (the class below); the map gets the rest. */
const ANSWER_MIN = 560;
/** The map is worth showing beside the answer only with this much room. */
const MAP_MIN = 480;
/** Below this width of the page (the answer at its narrowest and the map at its narrowest) the two are tabs, not columns. */
const SPLIT_FROM = ANSWER_MIN + MAP_MIN;

/** The box of an element in the page's own coordinates, kept up to date. */
function useAnchor(ref: React.RefObject<HTMLElement | null>, key: unknown): Anchor | null {
  const [box, setBox] = useState<Anchor | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` re-measures when the layout mode changes
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setBox((was) =>
        was &&
        was.left === rect.left &&
        was.top === rect.top &&
        was.width === rect.width &&
        was.height === rect.height
          ? was
          : { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref, key]);
  return box;
}

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export function SessionPage({
  session,
  route,
  reload,
}: {
  session: Session;
  route: Extract<Route, { name: 'session' }>;
  reload: () => void;
}) {
  const { t, dir } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    () => routeSelection(session, route, lastNodeOf(session.id)).selectedId,
  );
  const [detail, setDetail] = useState<Detail | null>(route.detail ?? null);
  const [member, setMember] = useState<{ label: string; ping: number } | null>(null);
  // the round whose identities are shown: switching to another round shows none (the switch is per round)
  const [revealFor, setRevealFor] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // the answers typed to the chairman's questions, by round: kept here, so another node and back loses none
  const [answerDrafts, setAnswerDrafts] = useState<AnswerDrafts>({});
  const [focusSignal, setFocusSignal] = useState(0);
  const [tab, setTab] = useState<'answer' | 'map'>('answer');
  const [arranged, setArranged] = useState(0);
  const connected = useAppState((state) => state.connected);
  const updatedAt = useAppState(
    (state) => state.sessions.find((item) => item.id === session.id)?.updatedAt,
  );
  const sync = useLayoutSync();
  const waiting = sync.waiting[session.id] ?? 0;
  const root = useRef<HTMLDivElement>(null);
  const mapBox = useRef<HTMLElement>(null);
  const width = useWidth(root);
  const narrow = width < SPLIT_FROM;

  const running = useMemo(
    () =>
      Object.values(session.nodes).some(
        (node) => node.kind === 'chair' && node.status === 'running',
      ),
    [session.nodes],
  );
  const selected = selectedId ? session.nodes[selectedId] : undefined;

  // An address the user arrives at (typed, Back, Forward) selects its round and its details. `route` is a new object for every
  // such arrival and stays the same while the page rewrites the address itself, so this never fights the effect below. The
  // drafts are kept by round, so none is lost by moving between rounds.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only an arrival at an address follows it, not every change of the session
  useEffect(() => {
    const next = routeSelection(session, route, lastNodeOf(session.id));
    setSelectedId(next.selectedId);
    setDetail(next.detail);
    if (route.node) setTab('answer');
  }, [route]);

  // the address and the sidebar's memory follow the selection and the details
  useEffect(() => {
    replaceRoute({
      name: 'session',
      id: session.id,
      ...(selectedId ? { node: selectedId } : {}),
      ...(detail ? { detail } : {}),
    });
    if (selectedId) rememberNode(session.id, selectedId);
  }, [session.id, selectedId, detail]);

  // the session is being looked at: whatever it finishes meanwhile is not news
  // biome-ignore lint/correctness/useExhaustiveDependencies: `updatedAt` re-marks it as seen when it changes
  useEffect(() => markSeen(session.id), [session.id, updatedAt]);

  // N puts the cursor where the next input is written
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.closest('input, textarea, select, [contenteditable=true]') ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      setTab('answer');
      setFocusSignal((count) => count + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const arrange = useCallback(
    (direction: LayoutDirection) => {
      const current = getState().session;
      if (!current) return;
      arrangeNodes(
        current.id,
        computeLayout(current.nodes, direction, false, dir === 'rtl'),
        direction,
      );
      setArranged((count) => count + 1);
    },
    [dir],
  );
  const onDragStop = useCallback((id: string, x: number, y: number) => {
    const current = getState().session;
    if (current) moveNode(current.id, id, x, y);
  }, []);
  const onStarted = useCallback((chairId: string) => {
    setSelectedId(chairId);
    setTab('answer');
  }, []);

  // The round the details are about: the selected round, or the one an input started.
  const detailChair: ChairNode | null = useMemo(() => {
    if (!selected) return null;
    if (selected.kind === 'chair') return selected;
    return (
      Object.values(session.nodes).find(
        (node): node is ChairNode => node.kind === 'chair' && node.parentId === selected.id,
      ) ?? null
    );
  }, [selected, session.nodes]);
  const open = detail !== null && detailChair !== null;

  const used = useMemo(
    () =>
      Object.values(session.nodes).reduce(
        (sum, node) => sum + (node.kind === 'chair' ? chairSpend(node).total : 0),
        0,
      ),
    [session.nodes],
  );

  // the ghost: the input that comes next, under a finished round (beside its child when it has one), or beside an input being edited
  const ghost: Ghost | null = useMemo(() => {
    if (!selected || running) return null;
    if (selected.kind === 'chair') {
      if (selected.status !== 'done') return null;
      const hasChild = Object.values(session.nodes).some((node) => node.parentId === selected.id);
      return {
        parentId: selected.id,
        kind: hasChild ? 'branch' : 'continue',
        round: selected.round,
      };
    }
    if (selected.id !== session.rootId && selected.parentId)
      return { parentId: selected.parentId, kind: 'edit', round: null };
    return null;
  }, [selected, running, session.nodes, session.rootId]);

  const fitKey = `${session.id}:${Object.keys(session.nodes).length}:${arranged}:${narrow ? tab : 'both'}`;
  const anchor = useAnchor(narrow ? root : mapBox, narrow ? 'narrow' : 'wide');
  const comment = selected ? (drafts[selected.id] ?? '') : '';

  const toggleDetail = (next: Detail) => setDetail((current) => (current === next ? null : next));
  const seeMember = (label: string) => {
    setDetail('council');
    setMember((current) => ({ label, ping: (current?.ping ?? 0) + 1 }));
  };

  const panel = !selected ? (
    <Empty className="m-4 border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MousePointerClickIcon />
        </EmptyMedia>
        <EmptyTitle>{t('panel.pick')}</EmptyTitle>
        <EmptyDescription>{t('panel.pickText')}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  ) : selected.kind === 'chair' ? (
    <ChairPanel
      key={selected.id}
      session={session}
      chair={selected}
      running={running}
      openDetail={open ? detail : null}
      onToggleDetail={toggleDetail}
      onSeeMember={seeMember}
      onStarted={onStarted}
      onUnclear={reload}
      onSelectNode={(id) => setSelectedId(id)}
      onFocusComposer={() => {
        setTab('answer');
        setFocusSignal((count) => count + 1);
      }}
      comment={comment}
      onComment={(value) => setDrafts((current) => ({ ...current, [selected.id]: value }))}
      answers={answersOf(answerDrafts, selected.id)}
      onAnswer={(index, value) =>
        setAnswerDrafts((current) => withAnswer(current, selected.id, index, value))
      }
      onSent={(chairId, submitted, questions) => {
        // only what still is exactly what was sent is cleared: text typed while the request was in flight is newer
        setDrafts((current) => commentAfterSend(current, chairId, submitted.comment));
        setAnswerDrafts((current) =>
          answersAfterSend(current, chairId, questions, submitted.answers),
        );
      }}
      focusSignal={focusSignal}
    />
  ) : (
    <UserPanel
      key={selected.id}
      session={session}
      node={selected}
      running={running}
      openDetail={open ? detail : null}
      onToggleDetail={toggleDetail}
      onStarted={onStarted}
      onUnclear={reload}
      focusSignal={focusSignal}
    />
  );

  const notices = (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex flex-col gap-2">
      {connected === false ? (
        <Alert role="status" className="pointer-events-auto" data-testid="offline">
          <AlertDescription>{t('map.offline')}</AlertDescription>
        </Alert>
      ) : null}
      {sync.authNeeded && waiting > 0 ? (
        <Alert className="pointer-events-auto" data-testid="layout-auth">
          <AlertTitle>{t('map.authTitle')}</AlertTitle>
          <AlertDescription>
            {t('map.authText', { n: waiting })}
            <Button
              variant="outline"
              size="xs"
              className="ms-2"
              data-testid="layout-retry"
              onClick={resumeLayoutSync}
            >
              {t('common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : sync.failed && waiting > 0 ? (
        <Alert className="pointer-events-auto" data-testid="layout-failed">
          <AlertTitle>{t('map.failedTitle')}</AlertTitle>
          <AlertDescription>
            {t('map.failedText', { n: waiting })}
            <Button
              variant="outline"
              size="xs"
              className="ms-2"
              data-testid="layout-retry"
              onClick={retryLayoutSync}
            >
              {t('common.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {sync.notice ? (
        <Alert role="status" className="pointer-events-auto" data-testid="layout-notice">
          <AlertDescription>{sync.notice}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );

  const map = (
    <>
      <Graph
        session={session}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          // a node picked on the map is read in the panel
          if (id) setTab('answer');
        }}
        onDragStop={onDragStop}
        onArrange={() => arrange(session.layout.direction)}
        onDirection={(direction) => arrange(direction)}
        ghost={ghost}
        onFocusComposer={() => {
          setTab('answer');
          setFocusSignal((count) => count + 1);
        }}
        fitKey={fitKey}
        disabled={false}
      />
      {notices}
    </>
  );

  return (
    <div
      ref={root}
      className="relative flex h-full min-h-0 flex-col"
      data-testid="editor"
      data-running={running || undefined}
      data-tab={narrow ? tab : undefined}
    >
      {narrow ? (
        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as 'answer' | 'map')}
          className="border-b p-2"
          data-testid="tabs"
        >
          <TabsList className="w-full">
            <TabsTrigger value="answer" data-testid="tab-panel">
              {t('session.tabAnswer')}
            </TabsTrigger>
            <TabsTrigger value="map" data-testid="tab-tree">
              <GitForkIcon />
              {t('session.tabMap')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside
          className={
            narrow
              ? `${tab === 'answer' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 flex-col bg-background`
              : 'flex min-h-0 w-[clamp(560px,42%,624px)] shrink-0 flex-col border-e bg-background'
          }
          aria-label={t('panel.label')}
          data-testid="answer-panel"
        >
          {panel}
        </aside>
        <section
          ref={mapBox}
          className={
            narrow
              ? `${tab === 'map' ? 'block' : 'hidden'} relative min-h-0 min-w-0 flex-1`
              : 'relative min-h-0 min-w-0 flex-1'
          }
          aria-label={t('map.label')}
          data-testid="map"
        >
          {map}
        </section>
      </div>
      {detailChair && detail ? (
        <DetailsDrawer
          open={open}
          onOpenChange={(next) => !next && setDetail(null)}
          anchor={anchor}
          session={session}
          chair={detailChair}
          state={{ tab: detail, member }}
          onTab={(next) => setDetail(next)}
          reveal={revealFor === detailChair.id}
          onReveal={(next) => setRevealFor(next ? detailChair.id : null)}
          draft={drafts[detailChair.id] ?? ''}
          sessionUsed={used}
        />
      ) : null}
    </div>
  );
}
