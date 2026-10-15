import type { Library } from './library.ts';
// Types shared by the server, the web editor and the tests. A session is one JSON file; everything the UI shows comes
// from it, so a node stores the exact prompts, raw outputs, parsed outputs, usage and timings of its round.

import type { Flow, FlowStep, StoredFlow } from './flow.ts';
import type { Note } from './messages.ts';

export type HarnessId = 'claude' | 'codex' | 'agy' | 'grok' | 'pi' | 'hermes';

/**
 * How hard the council thinks: every Divan model (a profile) answers at one of four levels. A level is a council (see
 * `LevelView`): the profile's base council with the efforts the level calls for, and whatever the profile overrides at it.
 */
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'max';
export type LayoutDirection = 'TB' | 'LR';

export type SeatState =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  /** Stopped because 10 minutes passed after its last sign of work with no new one (the only limit a member has). */
  | 'timeout'
  | 'invalid'
  | 'blocked'
  /**
   * Not asked, or not waited for: its model was known to be out of credit or rate limited, or it is of the chairman's family
   * (`quick`), or the asker chose to stop waiting for it («منتظرش نمی‌مانم»).
   */
  | 'skipped';
export type ChairmanState = 'pending' | 'running' | 'done' | 'failed' | 'blocked';
export type RoundStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
export type ClaimStatus = 'accepted' | 'rejected' | 'open';
export type VoteValue = 'agree' | 'disagree' | 'unsure';

export interface SeatConfig {
  id: string;
  enabled: boolean;
  harness: HarnessId;
  model: string;
  /** Reasoning effort; `''` where the harness takes it from the model id (agy) or has none. */
  effort: string;
  tools: boolean;
  memory: boolean;
  web: boolean;
}

/** Any harness whose headless JSON mode works, with read-only tools and web off. */
export interface ChairmanConfig {
  harness: HarnessId;
  model: string;
  effort: string;
  /** Read-only tools. Absent means on where the harness supports them; false keeps them off. */
  tools?: boolean;
  /**
   * The chairman's own read-only memory. New settings default it on where a connection is available; false keeps it off.
   */
  memory?: boolean;
}

/**
 * The limits of a session. There is no wall-clock limit on a member: it is stopped only when it has sent no sign of work for
 * `IDLE_STOP_MS` (see `src/shared/defaults.ts`).
 */
export interface Budgets {
  maxClaims: number;
  maxWords: number;
}

/** Locked once the session starts. The rules, schemas and instruction are filled from the template at that moment. */
export interface SessionSettings {
  flow?: Flow;
  question: string;
  seats: SeatConfig[];
  chairman: ChairmanConfig;
  template: 'important-decision';
  budgets: Budgets;
  /** The member rules, byte-identical in every round (provider prompt caches stay warm). */
  rules: string;
  chairmanRules: string;
  /** What members receive when Omid sends no comment. */
  critiqueInstruction: string;
  memberSchema: JsonSchema;
  chairmanSchema: JsonSchema;
  /** The level the council was resolved at (a session from before levels has none). Locked with the rest. */
  level?: ReasoningLevel;
  /** `quick`: the chairman's family is kept apart, in every round: a member of that family is left out of a round that would run it. */
  separateChairman?: boolean;
  /**
   * The session's working folder (an absolute path, as its real name): every member, in every round of the session and of
   * its branches, runs with it, as with the `x-divan-cwd` of the endpoint. Absent: no project folder.
   */
  cwd?: string;
  /**
   * The lens mode of the session (see `LensMode`): absent is `off`. Locked with the rest, for every round. An experiment: a
   * short investigative question made for the asker's question is given to the members.
   */
  lensMode?: LensMode;
}

/**
 * How the council uses lenses. `off`: every member answers the question. `angle`: every member answers the whole question and
 * also investigates its own lens; one member, the anchor, has no lens. `only`: every member answers ONLY its lens (an
 * investigative question made for the asker's question), and the chairman alone answers the asker's question.
 */
export type LensMode = 'off' | 'angle' | 'only';

/** A short investigative question made for the question of a session by the planner, and why it matters. */
export interface Lens {
  question: string;
  why: string;
}

/** What a member was assigned: a lens, `anchor` (it has none, by design), or null (it has none: it answers the question normally). */
export type SeatLens = Lens | 'anchor' | null;

/** What the lens planner returned for a round and how its lenses were handed out. */
export interface LensPlan {
  mode: Exclude<LensMode, 'off'>;
  /** How many lenses were asked for: the members minus the anchor in `angle`, the members in `only`. */
  requested: number;
  /** The lenses the planner returned, after the code cut them (at most `requested`, each at most 30 words, none twice). */
  lenses: Lens[];
  /** `angle`: the seat that has no lens, the first enabled seat of the council that took part. */
  anchorSeatId?: string;
  /** By seat id: its lens, `anchor`, or null. */
  assignment: Record<string, SeatLens>;
  /** Members that were meant to have a lens and have none, because the planner gave fewer (they answer the question as asked). */
  unassigned: number;
  /** The planner's call. */
  planner: {
    state: 'done' | 'failed' | 'invalid' | 'skipped';
    harness: string;
    model: string;
    error: string | null;
    usage: Usage | null;
    /** What the code cut of its output. */
    trimmed: string[];
    startedAt: string | null;
    endedAt: string | null;
  };
}

// biome-ignore lint/suspicious/noExplicitAny: a JSON Schema document is open-ended
export type JsonSchema = Record<string, any>;

export interface Usage {
  /** Input that was not served from the cache. */
  input: number;
  output: number;
  /** Input served from the provider's cache, when the harness reports it. */
  cached: number;
  /** `input + cached + output`: everything the harness reports for the call. */
  total: number;
  /** `harness`: the harness reported it. `estimate`: counted from text by `estimateTokens`. */
  source: 'harness' | 'estimate';
}

export interface MemberOption {
  name: string;
  for: string;
  against: string;
}
export interface MemberVote {
  claim: string;
  vote: VoteValue;
  why: string;
}
/** A fact about the asker that a member found in its memory, with where it found it. */
export interface MemoryFact {
  /** At most 25 words. */
  fact: string;
  source: string;
}
export interface MemberOutput {
  /** The member's full answer, in Markdown (at most 8000 words). Absent in a session from before the field. The other fields summarise it. */
  report?: string;
  /**
   * Set when the member returned its report as plain text (no JSON object, or one without the summary fields): `report` holds
   * the text and every other field is empty or null. It is a valid answer for the chairman.
   */
  reportOnly?: true;
  stance: string;
  /** Null when the question asks for no decision (and for a member that answers a lens alone, `only` mode, with nothing to recommend). */
  recommendation: { choice: string; why: string; confidence: number } | null;
  options: MemberOption[];
  claims: { text: string; confidence: number }[];
  risks: string[];
  unknowns: string[];
  would_change_my_mind: string;
  votes?: MemberVote[];
  /** Used only when this member's memory is on; always an empty list otherwise. The chairman gets these as facts. */
  memory_facts?: MemoryFact[];
}

export type ToolKind = 'file' | 'memory' | 'web' | 'thread' | 'other';
export interface ToolEvent {
  kind: ToolKind;
  name: string;
  target: string;
}
export type Activity = Record<ToolKind, number>;
export interface ToolLogEntry extends ToolEvent {
  at: string;
}

export interface SeatRun<T = MemberOutput> {
  seatId: string;
  /** A to E, shuffled fresh each round. */
  label: string;
  harness: HarnessId;
  model: string;
  effort: string;
  tools: boolean;
  memory: boolean;
  web: boolean;
  state: SeatState;
  /**
   * The last sign of work the harness sent while this seat ran (any event on its output stream), and the thinking tokens it
   * has reported so far (null: it reports none, or none yet). A seat is stopped only when 10 minutes pass without a sign.
   */
  lastSignalAt?: string | null;
  thinkingTokens?: number | null;
  activity?: Activity;
  toolLog?: ToolLogEntry[];
  /** Set when the seat answered without the project folder it was meant to read in (its harness could not keep the folder's own files out). */
  folderNote?: string | null;
  /** Lens modes: this member's lens, `anchor`, or null (none; it answered the question as asked). Absent when lenses are off. */
  lens?: SeatLens;
  /** The exact text sent to the harness. */
  prompt: string;
  /** Retained while the exact input is withheld, for crash accounting. */
  promptTokens?: number;
  rawOutput: string;
  parsed: T | null;
  /** `parsed` with self-identifying names removed: exactly what the chairman saw, and all that hidden mode shows. */
  sanitized: T | null;
  /** What the code cut to fit the budgets, one line each. */
  trimmed: string[];
  error: string | null;
  usage: Usage | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ChairClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  from: string[];
}

export interface ChairmanOutput {
  /** Round 1 only: the form the chairman addresses the asker in; kept by the session for every later round. */
  register?: AddressForm;
  input_title: string;
  title: string;
  direction: string;
  answer: string;
  recommendation: { choice: string; confidence: number } | null;
  questions_for_user: string[];
  claims: ChairClaim[];
  seat_scores: { label: string; score: number }[];
  /** At most 40 words: where members disagreed and what happened to that view. Null when the council did not split. */
  dissent?: string | null;
  /** How many of the `of` members that answered have a recommendation consistent with the final one. */
  agreement?: Agreement | null;
}

export interface Agreement {
  agree: number;
  of: number;
}

export interface ChairmanRun {
  state: ChairmanState;
  harness: HarnessId;
  model: string;
  effort: string;
  /** Whether the chairman ran with its own (read-only) memory. */
  memory?: boolean;
  tools?: boolean;
  activity?: Activity;
  toolLog?: ToolLogEntry[];
  folderNote?: string;
  /** The exact text sent to the chairman (rules, context and the anonymised member outputs). */
  input: string;
  promptTokens?: number;
  rawOutput: string;
  trimmed: string[];
  error: string | null;
  usage: Usage | null;
  startedAt: string | null;
  endedAt: string | null;
}

export type ContextKind =
  | 'rules'
  | 'background'
  | 'question'
  | 'context'
  | 'input'
  | 'summary'
  | 'latest'
  | 'new'
  | 'instruction';

export interface ContextRow {
  kind: ContextKind;
  /** Which round or input the row comes from (a number as text), or ''. */
  ref: string;
  text: string;
  tokens: number;
}

export interface Position {
  x: number;
  y: number;
}

interface NodeBase {
  id: string;
  parentId: string | null;
  position: Position | null;
  /** True once Omid dragged the node; Arrange clears it. */
  pinned: boolean;
  /**
   * How many times the server has changed where this node is (its position or its pin). A layout write names the
   * revision its writer saw and is refused when the node has moved on: the server decides, the writer adopts its answer.
   */
  layoutRev: number;
  /**
   * The revision of what the node says (its status, answer, members), raised each time the server announces a change of it:
   * a number of milliseconds that only ever goes up, also across a restart. A page keeps the newest content it has seen, so
   * a read that was answered before a round finished can never land on top of the event that said it finished. Absent in a
   * node from before: the oldest.
   */
  rev?: number;
  createdAt: string;
}

/** `user`: Omid's input (the root is the question). `next`: a round sent without a comment. */
export interface UserNode extends NodeBase {
  kind: 'user' | 'next';
  /** Set when the input was made by editing another input: the node it is a new version of. */
  editedFrom?: string;
  /** The comment (or the plain-text input of an older node). With `answers`, what the asker added to them. */
  text: string;
  /** The root only: what the asker added about the situation (not the question itself); every member and the chairman read it right after the question. */
  context?: string;
  /** The asker's answers to the chairman's questions of the round before, one by one: «Q: … / A: …» in the context. */
  answers?: QuestionAnswer[];
  /** The chairman's `input_title` once its round is done; a short cut of the text until then. */
  title: string;
}

export interface Attempt {
  /** `planner`: the lens planner's call (lens modes), before the members. */
  kind: 'seat' | 'chairman' | 'planner';
  /** The seat's config id; null for the chairman and the planner. */
  seatId: string | null;
  label: string | null;
  harness: HarnessId;
  model: string;
  state: string;
  error: string | null;
  usage: Usage | null;
  /** Estimated tokens of the text sent. */
  promptTokens: number;
  /** Prompt tokens plus output tokens: the council-text figure. */
  councilTokens: number;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ChairNode extends NodeBase {
  kind: 'chair';
  round: number;
  status: RoundStatus;
  title: string;
  direction: string;
  answer: string;
  recommendation: { choice: string; confidence: number } | null;
  questionsForUser: string[];
  claims: ChairClaim[];
  seatScores: { label: string; score: number }[];
  /** Where the members split and what became of that view; null when they did not (nodes from before: absent). */
  dissent?: string | null;
  /** How many of the answering members agree with the final recommendation (nodes from before: absent). */
  agreement?: Agreement | null;
  /** label to seat id, for this round. */
  labelMap: Record<string, string>;
  /** Version 1 only. New rounds store the canonical steps instead. */
  seats?: SeatRun[];
  chairman?: ChairmanRun;
  steps?: FlowStep[];
  /** The context rows the members received (rules first), their sum and the text sent. */
  context: ContextRow[];
  contextTokens: number;
  /**
   * What the harnesses reported for every call of this round, retries included (`total`, which the meter shows); `council` is the text the council exchanged (our prompts plus the outputs), a secondary figure.
   */
  usage: {
    members: number;
    chairman: number;
    /** The lens planner's call, counted in `total` (lens modes; absent when there was none). */
    planner?: number;
    total: number;
    council: number;
    cached: number;
    estimated: boolean;
  };
  /** The lens mode this round ran in (absent: `off`) and what the planner made of it; see `LensPlan`. */
  lensMode?: LensMode;
  lensPlan?: LensPlan;
  /** Every call this round made, failed and cancelled ones included, so a retry never erases spend. */
  attempts: Attempt[];
  /** A project folder the members and chairman read in. */
  cwd?: string | null;
  /** English text of why the round did not finish; `errorNote` carries it as a code and parameters for the client to word. */
  error: string | null;
  errorNote?: Note | null;
  startedAt: string;
  endedAt: string | null;
}

export type SessionNode = UserNode | ChairNode;

/** One of the chairman's questions and what the asker answered. */
export interface QuestionAnswer {
  question: string;
  answer: string;
}

/**
 * What a round starts from. A plain string is a comment (older clients and the endpoint send these); the structured form
 * carries answers to the chairman's questions and, optionally, a comment after them.
 */
export type RoundInput = string | { answers?: QuestionAnswer[]; comment?: string };

/** Where a session came from: the web app, or a client of the endpoint (Pi, T3 Code, any OpenAI-compatible one). */
export interface SessionOrigin {
  kind: 'web' | 'api';
  client?: string;
  profileId?: string;
  profileRevision?: number;
  profileGeneration?: number;
  profileLevel?: ReasoningLevel;
}

/** How the chairman addresses the asker: Persian «شما» is formal, «تو» is informal. Chosen once, by the first round. */
export type AddressForm = 'formal' | 'informal';

export interface Session {
  schemaVersion: 1 | 2;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  /** Set by the first finished round (a session from before this field has none, and is addressed formally). */
  register?: AddressForm;
  origin?: SessionOrigin;
  /** The earlier conversation of an endpoint client (cut to about 3k tokens), given to the members as context. */
  background?: string;
  settings: SessionSettings;
  rootId: string;
  nodes: Record<string, SessionNode>;
  layout: { direction: LayoutDirection };
}

export interface SessionSummary {
  id: string;
  name: string;
  /** What lists and the tab call the session: its name if Omid named it, else the chairman's title of the question. */
  title: string;
  question: string;
  createdAt: string;
  updatedAt: string;
  rounds: number;
  /** The direction the newest finished round recommends. */
  direction?: string;
  /** The newest finished round's recommendation: what the list says about a session besides its question. */
  recommendation?: { choice: string; confidence: number };
  tokens: number;
  running: boolean;
  origin: 'web' | 'api';
  client?: string;
}

/**
 * What a harness can do with one toggle. `free`: on or off. `forced-on`: the harness cannot switch it off (it is always
 * on, read-only). `blocked`: it stays off, because the harness cannot keep it read-only (council members only read).
 * `note` is shown in setup (as a warning while the toggle is on, or always for forced-on and blocked).
 */
export type ToggleMode = 'free' | 'forced-on' | 'blocked' | 'uncontrolled';
export interface ToggleSupport {
  mode: ToggleMode;
  /** The stem of the two messages below (`<code>_short`, `<code>_note`); '' when there is nothing to say. */
  code: string;
  /** One plain line for the seat, in English (empty when there is nothing to say). */
  short: string;
  /** The full explanation, in English, shown on demand. */
  note: string;
}

export interface HarnessInfo {
  id: HarnessId;
  label: string;
  supported: boolean;
  /** Offered only by deliberate choice; its own settings control access. */
  manualOnly?: boolean;
  unenforced?: boolean;
  /** The reason shown in setup when `supported` is false. */
  unsupportedNote: Note | null;
  tools: ToggleSupport;
  memory: ToggleSupport;
  web: ToggleSupport;
}

export interface ModelInfo {
  id: string;
  label: string;
  /** Reasoning efforts this model accepts; empty when none can be set (or the id carries it). */
  efforts: string[];
  defaultEffort: string;
}

/** A model a seat could not use (no credit, no quota), skipped by the detected defaults until `until`. */
export interface UnavailableModel {
  id: string;
  /** Set when the whole provider is out of credit: every model id that starts with it is unavailable too. */
  prefix?: string;
  until: string;
  reason: string;
}

/** What one harness's own CLI says it can run. `listed: false`: the CLI cannot list models, so setup takes a typed id. */
export interface HarnessModels {
  /** Documented CLI aliases, replaced when its real catalogue is available. */
  aliases?: boolean;
  harness: HarnessId;
  models: ModelInfo[];
  listed: boolean;
  /** The harness's own default model on this PC (its config or a marker in its list), or ''. */
  defaultModel: string;
  /** Models that recently failed for lack of credit or quota (24 hours), with the reason. */
  unavailable?: UnavailableModel[];
  /** Note shown beside the dropdown (how the list was found, or why it could not be). */
  note: Note | null;
  /** Reasoning efforts that apply to every model of the harness, for a typed model id. */
  fallbackEfforts: string[];
  /**
   * Whether the harness has the memory server in its own config, so a member of it can be given memory (absent: no). The
   * defaults turn memory on for a seat only where this is true.
   */
  memoryReady?: boolean;
  fetchedAt: string;
}

/** Whether a harness CLI is installed and can run headless on this PC. */
export interface HarnessStatus {
  /** This assistant's latest check failed; its previous result is retained. */
  notRechecked?: boolean;
  id: HarnessId;
  installed: boolean;
  usable: boolean;
  /** Why it is not usable. */
  note: Note | null;
}

/** A complete configuration: what a session can start from. */
export interface SettingsFull {
  flow?: Flow;
  seats: SeatConfig[];
  chairman: ChairmanConfig;
  budgets: Budgets;
}

/** Only the fields Omid changed in the web app; stored apart from the detected defaults. */
export interface SettingsOverrides {
  /** By seat id; the default seats are named after their harness. */
  seats?: Record<string, Partial<Omit<SeatConfig, 'id'>>>;
  /** Seats Omid added. */
  extraSeats?: SeatConfig[];
  chairman?: Partial<ChairmanConfig>;
  budgets?: Partial<Budgets>;
}

/**
 * What a profile overrides at one level, over the council the level derives: any seat's model or effort (and the harness it
 * runs on), a seat on or off, and the chairman (harness, model, effort, tools, memory). Nothing else differs between levels.
 */
export interface LevelOverrides {
  nodes?: Record<string, Partial<Pick<SeatConfig, 'enabled' | 'harness' | 'model' | 'effort'>>>;
  /** By seat id of the base council. */
  seats?: Record<string, Partial<Pick<SeatConfig, 'enabled' | 'harness' | 'model' | 'effort'>>>;
  chairman?: Partial<ChairmanConfig>;
}

export type ProfileBase = 'default' | 'quick';

/** A named set of settings; `divan/<id>` is its model name on the endpoint. */
export interface ProfileRecord {
  flow?: StoredFlow;
  /** Custom profiles only; the two automatic ones have fixed names. */
  name?: string;
  /** What the overrides lie over: the detected defaults, or the defaults reduced to the quickest seats. */
  base: ProfileBase;
  /** Goes up by one on every change; part of a cached answer's key. */
  revision: number;
  /** Given when the profile is made and never given again, so deleting and remaking a profile cannot revive its cached answers. */
  generation?: number;
  /** The base council's overrides over the base (the efforts it holds are superseded by the level). */
  overrides: SettingsOverrides;
  /** Per-level overrides, only for the levels that have any. */
  levels?: Partial<Record<ReasoningLevel, LevelOverrides>>;
  /** The level a request that names none runs at (`medium` unless set; an automatic `quick` is `low`). */
  defaultLevel?: ReasoningLevel;
}

/** settings.json: the profiles and the port of the endpoint. */
export interface SettingsFile {
  version: 2;
  library?: Library;
  /** The endpoint's fixed port; absent means the built-in default. */
  port?: number;
  /** The next profile generation to hand out. */
  nextGeneration?: number;
  /** By id (a slug). `default` and `quick` always exist: absent means no overrides yet. */
  profiles: Record<string, ProfileRecord>;
  /** The working folders the last sessions were started with, newest first (for the Home field). */
  recentFolders?: string[];
}

/** One level of a profile: the council that runs at it, how it was reached, and whether it can run. */
export interface LevelView {
  /** The council a session at this level runs: `derived` with `overrides` laid over it. The ONE resolver's answer. */
  effective: SettingsFull;
  /**
   * The base council with the efforts the level calls for (low: every effort low, the slowest member dropped when more than
   * three remain, the chairman low; medium, high: every effort that; max: every effort max, else the harness's highest). The
   * edit of a level is a diff against this (`diffLevel`).
   */
  derived: SettingsFull;
  /** What this level overrides over `derived` (cleaned: only what differs). */
  overrides: LevelOverrides;
  /**
   * A digest of this level's own council (and the level): the start of a session at this level is checked against it, so a
   * change to another level (the slowest member of `low` is worked out from timings that move as rounds finish) is not a
   * "changed council" for a level that did not change.
   */
  fingerprint: string;
  /**
   * The members that are on and will NOT be asked now, with why: their model is out of credit or rate limited (`out`), or, in
   * `quick`, they are of the chairman's family (`family`). Part of the fingerprint, so a start is refused when it changed.
   */
  skipped: { id: string; reason: 'out' | 'family' | 'missing' }[];
  /** Why this level cannot start a round now (`quick` with a chairman of a member's family); absent when it can. */
  blocked?: Note;
  /** Notes: an override of this level that no longer fits this PC and fell back. */
  notes: Note[];
}

/** One profile as the web app and the endpoint see it: its base, its overrides and the two laid together. */
export interface ProfileView {
  id: string;
  name: string;
  /** `default` and `quick`: they cannot be deleted, only edited and reset. */
  auto: boolean;
  base: ProfileBase;
  revision: number;
  generation: number;
  /**
   * A digest of `defaults`, `effective` and the resolved council of every level: a save and a start send it back, so one
   * made against outdated settings (a model that went out of credit changes what runs) is refused (409).
   */
  fingerprint: string;
  /** Why this profile cannot start a round at its default level right now; absent when it can (see `levels[...].blocked`). */
  blocked?: Note;
  defaults: SettingsFull;
  /** The base council: the defaults with `overrides` laid over them. Every level derives from this. */
  effective: SettingsFull;
  overrides: SettingsOverrides;
  /** The level a request that names none runs at. */
  defaultLevel: ReasoningLevel;
  /** The resolved council of every level. */
  levels: Record<ReasoningLevel, LevelView>;
  /** Notes: an override that no longer fits this PC and fell back to the base. */
  notes: Note[];
}

export interface SettingsView {
  profiles: ProfileView[];
  /** Notes about the whole PC (a model that ran out of credit, a harness left out). */
  notes: Note[];
  status: HarnessStatus[];
  models: HarnessModels[];
  detectedAt: string;
  /**
   * The mean seconds a call of each assistant's own default model took on this PC (what Quick picks its members by); an
   * assistant that has not been timed on that model is absent.
   */
  speeds: Partial<Record<HarnessId, number>>;
}

/** The endpoint's address: clients use `baseUrl` with the key. */
export interface EndpointInfo {
  port: number;
  configuredPort: number;
  defaultPort: number;
  baseUrl: string;
  /** Where the Pi extension is on this PC (the folder `pi install` is given): the server knows its own install path. */
  piExtension: string;
  /**
   * How T3 Code starts Divan as its own provider (ACP, a "Local command"): the executable and its arguments, each an absolute path
   * on this PC. The server knows its own install path.
   */
  acp: { command: string; args: string[] };
}

export interface Meta {
  platform?: string;
  version: string;
  fake: boolean;
  /** How long a round usually takes on this PC (the mean of the latest finished ones), in seconds; null before the first. */
  typicalRoundSeconds: number | null;
  /** The shortest and the longest of the same rounds, in seconds, and how many were measured: a round takes anything between them. */
  typicalRoundRange: { min: number; max: number; count: number } | null;
  /** The same, per level: from the rounds of sessions that ran at that level (null: none measured yet). */
  typicalRoundRangeByLevel: Record<
    ReasoningLevel,
    { min: number; max: number; count: number } | null
  >;
  harnesses: HarnessInfo[];
  settings: SettingsView;
  endpoint: EndpointInfo;
  /** The working folders the last sessions were started with, newest first, those that still exist (at most 8). */
  recentFolders: string[];
}

export type ServerEvent =
  | { type: 'hello' }
  | { type: 'node'; sessionId: string; node: SessionNode }
  /**
   * A member that is working showed a sign of work (at most once a second per seat): when, and how many thinking tokens the
   * harness has reported so far (null: none reported). `state` is the seat's current state.
   */
  | {
      type: 'seat';
      /** The revision of the round (`NodeBase.rev`) this sign made: a page drops one at or below the round it already has. */
      rev: number;
      sessionId: string;
      chairId: string;
      seatId: string;
      label: string;
      state: SeatState;
      lastSignalAt: string | null;
      thinkingTokens: number | null;
    }
  | { type: 'session'; session: SessionSummary; layout: { direction: LayoutDirection } }
  | { type: 'deleted'; sessionId: string };
