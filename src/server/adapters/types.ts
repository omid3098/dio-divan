import type { FormField } from '../../shared/library.ts';
import type { Note } from '../../shared/messages.ts';
import type {
  HarnessId,
  HarnessInfo,
  HarnessModels,
  JsonSchema,
  ToolEvent,
  Usage,
} from '../../shared/types.ts';
import type { ProcResult } from '../proc.ts';

/** One read-only headless call: the same shape for a member seat and for the chairman. */
export interface RunSpec {
  harness: HarnessId;
  model: string;
  effort: string;
  tools: boolean;
  memory: boolean;
  web: boolean;
  /** The whole input, rules first. It goes to the harness on stdin or from a file, never as a long argument. */
  prompt: string;
  /** The output schema in the strict form a harness can enforce natively. */
  schema: JsonSchema;
  /** Local form limits, used by deterministic fakes; providers receive only schema. */
  formFields?: FormField[];
  /** The only limit: the call is stopped when it has been silent this long (see `ProcSpec.idleMs`). */
  idleMs: number;
  /** Called at every sign of work the harness sends (any event on its output), with the thinking tokens it has reported so far. */
  onSignal?: (sign: Sign) => void;
  /**
   * A project folder to run in, for a member that reads a codebase. Absent: an empty temporary folder. An adapter never
   * lets the harness load that folder's own settings, hooks, MCP servers, skills or instruction files.
   */
  cwd?: string;
  /** Aborting it stops this run (its process tree is killed). */
  signal?: AbortSignal;
  /** A fake call's first or second connection attempt (no real harness flag). */
  attempt?: number;
}

/** A sign of work from a running harness. `thinkingTokens`: its reasoning tokens so far, when it reports (or streams) them. */
export interface Sign {
  thinkingTokens?: number | null;
  tools?: ToolEvent[];
}

/** Reads a harness's output as it arrives (a chunk at a time) and says what it shows: nothing, or the thinking so far. */
export interface StreamWatcher {
  push(chunk: string): Sign | undefined;
  /**
   * What the whole stream added up to as it arrived, for an output too long to be kept whole (`ProcResult.truncated`): the
   * last answer and the usage of every message, which are not read from a buffer that has a middle left out.
   */
  streamed?(): { text: string; usage: Usage | null; error: string | null };
}

export interface CommandBuild {
  command: string;
  args: string[];
  /**
   * Where the process runs, when that is not the project folder of the run: an adapter whose harness would load the folder's
   * own settings, hooks or extensions runs in the empty working folder it was given and tells the member the project's path.
   */
  cwd?: string;
  env?: Record<string, string | undefined>;
  envMode?: 'replace';
  cleanup?: () => void | Promise<void>;
  stdin?: string;
}

export interface ParsedRun {
  /** The model's final message text. */
  text: string;
  usage: Usage | null;
  error: string | null;
}

export interface Adapter {
  info: HarnessInfo;
  listModels(): Promise<HarnessModels>;
  /** A cheap, costless check that the harness is logged in: the reason when it is not, null when it is. */
  check?(): Promise<Note | null>;
  /**
   * Whether the harness can be run in this project folder without loading the folder's own settings, hooks, MCP servers,
   * skills or instructions: null when it can, else the reason it cannot (the member then runs in an empty folder).
   */
  cwdProblem?(cwd: string, spec: RunSpec): Promise<string | null>;
  /**
   * `ioDir` is a folder of its own (not the working directory) for the schema and prompt files; `workDir` is the empty
   * temporary working folder a run without a project folder gets (the adapter may put a settings file of its own in it).
   */
  build(
    spec: RunSpec,
    ioDir: string,
    workDir: string,
  ): CommandBuild | { error: string } | Promise<CommandBuild | { error: string }>;
  /** A reader of the output as it streams (the harness's own events), for the thinking tokens so far. */
  watch?(spec: RunSpec): StreamWatcher;
  parse(result: ProcResult, spec: RunSpec): ParsedRun;
}
