// Every sentence the server says to a person, as a stable code with parameters and an English template. The server never
// words anything in Persian: an API answer, a note, a blocked reason and the text of a failed round carry `code` and
// `params` (plus the English `message`, a fallback for a client that has no catalogue). The web app turns a code into
// the language the person reads, from its own catalogues (`msg.<code>` in each); `tests/messages.test.ts` fails when
// one of them lacks a code or a placeholder.
//
// A template holds `{name}` placeholders. `toggle` and `level` use the interface's words; `until` is an ISO time.

export type MessageParams = Record<string, string | number>;

export const MESSAGES = {
  hermes_platform: 'Hermes is supported on Windows only.',
  hermes_install: 'This Hermes installation is not supported by Divan’s protected launcher.',
  hermes_unsupported:
    'This Hermes installation is not supported. Divan supports source revision {revision}.',
  hermes_home_missing: 'Hermes is not set up in {path}.',
  hermes_changed:
    'Hermes changed or has an unfinished update. Divan cannot safely use this installation.',
  hermes_policy: 'Hermes has a conflicting or unreadable policy or dotenv file.',
  hermes_route: 'Hermes has no supported, authenticated API-key chat-completions route.',
  hermes_moa: 'MoA models (which run several models together) are not offered by Divan.',
  hermes_memory_unavailable:
    'Hermes memory is off: it needs one matching HTTP server with only an Authorization Bearer environment-variable header and an available key.',
  hermes_guard: 'Hermes could not start safely because its required tool guard changed or failed.',
  hermes_history: 'Hermes history is unavailable for the protected reader.',
  hermes_web_short: 'Web access is not supported by this Hermes integration yet.',
  hermes_web_note: 'Web access is not supported by this Hermes integration yet.',
  hermes_usage:
    'Hermes reports the main conversation’s usage; its extra background calls may not be included.',
  hermes_cleanup: 'Hermes stopped, but Divan could not safely remove its private run folder.',
  hermes_tools_short: 'Windows Low integrity; permitted read tools only.',
  hermes_tools_note:
    'Windows stops Hermes from changing your normal files, except folders Windows itself marks as low, such as some caches. Divan reads its past conversations through its own reader. Network access is limited to the selected provider and permitted read tools; this is not a network sandbox.',
  hermes_memory_short: 'Hermes’s own connection, restricted to six memory read tools.',
  hermes_memory_note:
    'Divan filters Hermes’s own memory tools to six read operations. Its token’s server profile is unchanged; tool filtering is the boundary.',
  setup_empty: 'Assistant setup and checks.',
  link_expired:
    'This sign-in link has expired. Run divan again and paste its fresh sign-in address into the same tab to keep your draft.',
  setup_uses: 'This model uses: {names}. Expand to set up assistants.',
  setup_ready: 'Ready to answer.',
  agy_warning: 'agy can write files and run commands on this computer, and Divan cannot stop it.',
  agy_manual:
    'agy is installed, but Divan never selects it automatically. Choose it by hand in Models.',
  agy_unenforced: 'Unenforced',
  agy_controlled_short: 'Controlled by agy, not by Divan.',
  agy_controlled_note:
    'agy’s own settings control tools, memory and web. Divan cannot turn them off or prevent writes.',
  agy_incompatible:
    'This agy version does not support stream-json input on stdin. Update agy before using it in Divan.',
  agy_models_typed:
    'agy’s JSON model list is unavailable. Type a model slug, such as gemini-3.8-flash; display names are not supported.',
  one_assistant_council:
    'All members and the chairman run through one program ({harness}), so a fault in it affects all of them.',
  one_assistant_pair_missing:
    '{harness} needs a second genuinely different member model from one known company, with a chairman from another. Use one assistant or add a model.',
  first_run_changed: 'The suggested assistant changed. Check again before selecting it.',
  setup_unsupported: 'Not supported: this assistant can write files.',
  setup_official: 'Official setup page',
  setup_check: 'Check again',
  setup_checking: 'Checking assistants…',
  setup_checked: 'Last check: {time}',
  setup_not_rechecked:
    'Could not re-check this assistant. Its previous result is still shown; try Check again.',
  setup_unknown_company:
    'Some models were left out of the default council because their company is unknown. You can still use them alone or in Models.',
  models_claude_aliases:
    'Claude Code’s model list is not available yet. Its standard names opus, sonnet and haiku are used; Check again replaces them when its catalogue is available.',
  settings_corrupt:
    'The damaged settings file was saved as {file} in the Divan home. Defaults are in use; your saved models remain in that backup.',
  setup_restart:
    'After installing an assistant, stop Divan and run divan from a new terminal so it sees the new PATH. Restarting can interrupt work.',
  setup_claude_picker:
    'Signed in; models not discovered. Run claude, open /model without sending a prompt, then check again. Automatic catalogue initialisation on a clean account is not yet verified; you can enter the model id in Models.',
  setup_pi_login:
    'Run pi and use /login, or configure an API key as its official page explains. Do not send a prompt to check setup.',
  detection_failed:
    'The assistant check failed. The last complete result is still shown; try Check again.',
  home_calls:
    'Runs on your own subscriptions or API credits: {names} · up to {calls} assistant calls (retries can add more) · no question is sent until you press Ask the model.',
  home_call:
    'Runs on your own subscriptions or API credits: {names} · up to 1 assistant call (retries can add more) · no question is sent until you press Ask the model.',
  home_no_council:
    'The available models do not form a council. Use one assistant below or add different models in Models.',
  home_access:
    'With read tools on, assistants may read beyond the chosen folder and local T3 conversations. Memory is read when on; Codex can read anything your account can. What they read goes to their model providers.',
  home_one_company:
    'All members and the chairman are from one company ({company}), so they may share blind spots and the chairman may favour answers like its own. An assistant from another company makes the council independent.',
  home_two_companies:
    'Both members are from one company; the chairman is from another and checks their answers.',
  home_single: 'Use {harness} alone ({model})',
  home_setup: 'Set up an assistant, then check again.',
  home_single_name: 'One assistant · {harness}',
  no_assistant:
    'No usable assistant model was found. Install or sign in to an assistant, then check again.',
  assistant_missing: '{harness} is not ready to answer. Install or sign in, then check again.',
  council_shortage:
    'The available models cannot form this council: it needs {required} different member models and a suitable chairman. {count} models are available. Use one assistant or connect another assistant.',
  council_shortage_one:
    'The available models cannot form this council: it needs {required} different member models and a suitable chairman. {count} model is available. Use one assistant or connect another assistant.',
  grok_not_logged_in: 'Grok is not signed in.',
  grok_login_unknown: 'Could not check whether Grok is signed in.',
  custom_form_invalid: 'The answer does not match the requested form at {field}.',
  custom_form_bounds: 'The value of {field} must be between {min} and {max}.',
  custom_form_items: 'The list {field} must have at most {max} items.',
  custom_form_words: 'Text in {field} must have at most {max} words and {maxChars} characters.',
  flow_invalid: 'This model has an invalid design ({reason}).',
  bad_library: 'The library entry is invalid ({reason}).',
  library_missing: 'The library entry does not exist.',
  library_builtin: 'Built-in entries are read-only. Duplicate one to edit it.',
  library_in_use: 'This library entry is used by models or prompts.',
  library_stale: 'The library entry has changed. Load the current entry.',
  library_id_taken: 'This library id is already in use.',
  library_invalidates_model: 'This edit makes model {model} invalid at {level} ({reason}).',
  flow_branch_skipped: 'inactive branch',
  flow_condition_matched: 'condition matched',
  flow_condition_not_matched: 'condition did not match',
  flow_condition_missing_field: 'condition field missing or null',
  flow_condition_source_failed: 'condition input did not answer',

  bad_flow: 'The flow is not valid.',
  bad_flow_template: 'The flow template is not valid.',
  flow_lenses: 'Lenses are not supported for custom flows.',
  flow_unavailable: 'Required steps or enough responses are not available for this flow.',
  flow_step_unfinished: 'The step did not finish.',
  flow_step_disabled: 'disabled in this flow',
  flow_template_council: 'Council',
  flow_template_single: 'One assistant',
  flow_template_writer_critics: 'Writer, critics and rewriter',
  flow_step_started: '{step} started.',
  flow_step_answered: '{step} answered{time}.',
  flow_step_failed: '{step} did not answer ({reason}).',
  flow_step_skipped: '{step} was skipped ({reason}).',
  flow_step_folder: '{step} answered without the project folder.',
  flow_answer_started: '{step} is reading {answers} responses.',
  flow_working: '{step} working for {time}.',
  // ----- requests the server refuses before they reach the API (the guard, the router, the body) -----
  bad_host: 'The Host header of the request is not this server’s.',
  bad_origin: 'The request comes from another origin.',
  cross_site: 'The request comes from another site.',
  bad_token:
    'Run divan again. Paste its fresh sign-in address into this same tab to keep your draft.',
  bad_content_type: 'The request must be JSON.',
  bad_url: 'The address of the request is not valid.',
  bad_path: 'The path of the request is not valid.',
  forbidden: 'This is not allowed.',
  no_cors: 'Requests from another origin are not allowed.',
  not_found: 'Not found.',
  method: 'This method is not allowed here.',
  too_big: 'The request body is too large.',
  bad_json: 'The request body is not a valid JSON object.',
  bad_cwd: 'The working folder cannot be used: {reason}.',
  bad_lens_mode: 'The lens mode must be "off", "angle" or "only".',

  // ----- requests the API refuses -----
  internal: 'Internal server error.',
  bad_op: 'This request is not valid.',
  stale: 'This changed in the meantime.',
  no_session: 'Session not found.',
  bad_node: 'Node not found.',
  bad_seat: 'This member is not in this round.',
  no_profile: 'Profile not found.',
  no_question: 'Write the question.',
  long_question: 'The question is too long.',
  long_context: 'The context is too long (at most {max} characters).',
  long_input: 'The comment is too long.',
  no_name: 'The name cannot be empty.',
  bad_level: 'The reasoning level is not valid.',
  bad_levels: 'The level settings are not valid.',
  bad_id: 'The id may hold only lowercase Latin letters, digits and hyphens (up to 32 characters).',
  bad_name: 'The profile name must be 1 to 40 characters.',
  bad_port: 'The port must be a number between 1024 and 65535.',
  bad_budgets: 'The budgets are outside the allowed range.',
  bad_seats: 'The seats are not valid.',
  bad_harness: 'The assistant is not valid.',
  bad_seat_model: 'The model of seat {seat} is not chosen or is not valid.',
  bad_seat_effort: 'The reasoning level of seat {seat} is not valid.',
  bad_chairman_model: 'The chairman’s model is not chosen or is not valid.',
  bad_chairman_effort: 'The chairman’s reasoning level is not valid.',
  few_seats: 'At least two seats must be on.',
  auto_profile: 'The id of an automatic profile does not change.',
  auto_profile_delete: 'Automatic profiles are not deleted, only reset.',
  id_taken: 'Another profile has this id.',
  too_many: 'The number of profiles has reached its limit.',
  running: 'A session with a running round cannot be deleted.',
  busy: 'A round is running; wait for it to end.',
  too_few_answers: 'Fewer than two members have answered, so there is no answer to write yet.',
  not_done: 'A round can continue only from a finished round.',
  not_running: 'This is not running.',
  not_failed: 'Only a failed, cancelled or interrupted round can be run again.',
  cancelled: 'The requester left; the round was not started.',
  save_failed: 'Saving the session to disk failed: {detail}',
  endpoint_unreachable: 'The endpoint did not answer: {detail}',
  endpoint_rejected: 'The endpoint refused the key.',

  // ----- the text of a round that did not finish -----
  round_save_failed: 'Saving the round failed: {detail}',
  chairman_failed: 'The chairman failed: {detail}',
  chairman_invalid: 'The chairman’s output was not valid: {detail}',
  few_members: 'Fewer than two members gave a valid output.',
  few_members_skipped:
    'Fewer than two members gave a valid output ({skipped} did not take part, because their model is not available).',
  no_comment: 'No comment',

  // ----- what a harness can and cannot do (a rule, or a toggle that cannot be set that way) -----
  harness_unsupported:
    '{harness} can write files, and council members must only read. Until it is guaranteed read-only it is neither a member nor the chairman.',
  toggle_forced_on: '“{toggle}” is always on for this assistant and cannot be turned off.',
  toggle_blocked: '“{toggle}” is closed for this assistant: members only read and change nothing.',

  // ----- notes about this PC and the saved settings -----
  harness_missing: 'It is not installed on this computer.',
  harness_off_path:
    'It is installed at {path}, but that folder is not on the PATH Divan started with. Add {folder} to your PATH (the line its installer printed; on macOS and Linux it goes in your shell profile), open a new terminal, stop Divan and run divan again.',
  harness_no_models: 'Its model list is empty.',
  claude_not_logged_in: 'Claude Code is not signed in.',
  claude_login_unknown: 'The sign-in state of Claude Code could not be read.',
  codex_not_logged_in: 'Codex is not signed in.',
  codex_login_unknown: 'The sign-in state of Codex could not be read.',
  models_fake: 'A test list.',
  models_pi: 'The list was taken with “pi --list-models”.',
  models_grok:
    'The list was taken with “grok models”; the reasoning levels come from Grok’s own cache.',
  models_codex: 'The list was taken with “codex debug models”, in order of priority.',
  models_claude_cache:
    'The list was read from the model catalogue cache of Claude Code itself (it has no command to list models).',
  models_claude_none: 'Claude Code’s models were not discovered; enter a model id in Models.',
  models_list_failed: 'The model list could not be taken ({detail}); type the model id yourself.',
  seat_harness_gone_dropped:
    'The assistant of seat “{seat}” is no longer available, so this seat was left out.',
  seat_harness_gone:
    'The saved assistant of seat “{seat}” is no longer available; the default replaced it.',
  seat_model_gone: 'The saved model of seat “{seat}” no longer exists; the default replaced it.',
  seat_toggle_on:
    'The option “{toggle}” of seat “{seat}” is always on in this assistant, so the saved setting was ignored.',
  seat_toggle_off:
    'The option “{toggle}” of seat “{seat}” is closed in this assistant, so the saved setting was ignored.',
  seat_effort_gone:
    'The saved reasoning level of seat “{seat}” does not exist for this model; the default replaced it.',
  seat_not_in_defaults: 'Seat “{seat}” is no longer in the defaults, so its change was ignored.',
  harness_no_credit:
    'All models of {harness} are out of credit or quota; the {harness} member was turned off in the default.',
  pi_not_member:
    '{harness} is not a council member this time, because all its models come from companies that the other members or the chairman already use.',
  pi_not_member_chairman:
    '{harness} is not a council member this time (it is only the chairman), because all its models come from companies that the other members or the chairman already use.',
  unavailable_harness:
    'All models of {harness} were left out of the defaults until {until}: their credit or quota ran out or is limited.',
  unavailable_provider:
    'The models of {provider} ({harness}) were left out of the defaults until {until}: their credit or quota ran out or is limited.',
  unavailable_model:
    'The model {model} ({harness}) was left out of the defaults until {until}: its credit or quota ran out or is limited.',
  no_quick_family:
    'No separate family was found for the chairman in quick mode; set the chairman and the members yourself.',
  quick_blocked:
    'Quick needs a chairman from a known company that no member uses. Change the chairman or the members in this model.',
  quick_two_members:
    'Quick mode has only two members this time, so that a separate family stays free for the chairman.',

  // ----- what each harness does with the tools, memory and web toggles: a short line, and the full explanation -----
  claude_memory_short: 'Memory is read-only.',
  claude_memory_note:
    'Claude Code reaches the memory server with its own connection, as in normal use, and only through its read tools (search, read a page, list, recent changes, ask, whoami): the writing tools are denied by name, and nothing is ever asked. No browser, REPL or other connector can be reached. Your own Claude Code settings, CLAUDE.md and hooks load as usual.',
  codex_tools_short: 'Codex always runs with read-only tools, so anonymity is not guaranteed.',
  codex_tools_note:
    'Codex cannot turn its shell tool off; it is always on, in a read-only sandbox. With tools on, this member can read any file on the PC, including Dio Divan’s saved sessions; anonymity and independence are not guaranteed.',
  codex_memory_short: 'Memory is read-only.',
  codex_memory_note:
    'Codex reaches the memory server with its own token (MEMORY_TOKEN_CODEX), as in normal use, but the server is added with only its read tools offered, and any other tool call is refused because Codex is never allowed to ask. Codex’s own config file is not loaded; its global instruction file (AGENTS.md) is.',
  agy_write_short: 'agy can write files.',
  agy_write_note: 'agy can write files.',
  grok_tools_short: 'Grok always runs with read-only tools.',
  grok_tools_note:
    'Grok does not turn tools fully off; they are always on (read, list and search) and read-only. Dio Divan’s paths and the assistants’ history folders are closed to it.',
  grok_memory_short: 'Memory is read-only.',
  grok_memory_note:
    'Grok reaches the memory server only with Dio Divan’s read-only token (the server itself refuses every write for it), and only its read tools, which the server marks read-only, are allowed. Without that token Grok has no memory.',
  pi_tools_short: 'With tools on, anonymity is not guaranteed.',
  pi_tools_note:
    'With tools on, this member can read files on the PC. Dio Divan’s home, the assistants’ own folders and their credential files are closed to it by a guard in Dio Divan’s extension, but anonymity and independence are not guaranteed.',
  pi_memory_short: 'Memory is read-only.',
  pi_memory_note:
    'Pi reaches the memory server only with Dio Divan’s read-only token (the server itself refuses every write for it); only its read tools are offered, and any other connector call is blocked by a guard in Dio Divan’s own extension. Without that token Pi has no memory.',
  pi_web_short: 'Pi has no web search.',
  pi_web_note: 'Pi has no web search tool.',
} as const;

export type MessageCode = keyof typeof MESSAGES;

/** A sentence from the server: the code and parameters are what a client words in its own language; `message` is English. */
export interface Note {
  code: MessageCode;
  params?: MessageParams;
  message: string;
}

const TOGGLE_WORD: Record<string, string> = { tools: 'Tools', memory: 'Memory', web: 'Web' };
const LEVEL_WORD: Record<string, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

function show(name: string, value: string | number): string {
  if (name === 'toggle') return TOGGLE_WORD[String(value)] ?? String(value);
  if (name === 'level') return LEVEL_WORD[String(value)] ?? String(value);
  if (name === 'until') {
    const at = new Date(String(value));
    return Number.isNaN(at.getTime())
      ? String(value)
      : `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
  return typeof value === 'number' ? value.toLocaleString('en-US') : value;
}

/** A template with its `{name}` placeholders filled (an unknown name stays as it is). */
export function fill(template: string, params: MessageParams = {}): string {
  return template.replace(/\{(\w+)\}/gu, (whole, name: string) =>
    Object.hasOwn(params, name) ? show(name, params[name] as string | number) : whole,
  );
}

/** The English text of a code. */
export const messageText = (code: MessageCode, params?: MessageParams): string =>
  fill(MESSAGES[code], params);

/** A note: `params` is left out when there are none. */
export function note(code: MessageCode, params?: MessageParams): Note {
  return {
    code,
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    message: messageText(code, params),
  };
}

/** Whether a value read from the wire is a note (a stored or received one may be anything). */
export function isNote(value: unknown): value is Note {
  const item = value as Note | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.code === 'string' &&
    typeof item.message === 'string'
  );
}
