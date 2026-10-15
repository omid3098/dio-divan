# Dio Divan

Divan asks coding assistants the same question independently. A chairman reads their reports and writes one answer. You can follow up or branch a conversation in the local web editor, and design other flows in Models.

Licensed under [MIT](LICENSE). For help or bugs, use [GitHub Issues](https://github.com/omid3098/dio-divan/issues). Tested with real assistants on Windows. macOS and Linux pass the automated install tests but have not yet been tested with real assistants.

## Install and open

Install with `npm install -g dio-divan`; the command it installs is `divan`. You need Node **24.21 or newer** and at least one installed, signed-in assistant with a usable model: Claude Code, Codex, Grok, Pi or Hermes (Windows only). The Home setup card links their official instructions and shows copyable commands. It never installs or signs in for you.

`npx divan` is a different, unrelated npm package. On Windows PowerShell, if execution policy blocks `divan.ps1`, use `divan.cmd` (or, if appropriate for your account, `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`).

Run `divan` to start the server in the background and open its sign-in address. Run it again to reopen the existing server. `divan stop` stops it; `divan serve` runs it in the foreground so you can see a startup error. Set `DIVAN_NO_OPEN=1` to print the sign-in address without opening a browser. A browser opener that is missing or fails is reported in one plain line, and the printed address is the one to open yourself.

**macOS and Linux.** The Node in a distribution's packages (Ubuntu's `apt install nodejs npm`, for one) is often older than 24.21: install Node from [nodejs.org](https://nodejs.org/en/download) instead (on Linux its instructions use nvm). That Node needs no `sudo` for `npm install -g`. If `npm install -g` still fails with `EACCES`, give npm a folder of your own: run `npm config set prefix ~/.npm-global`, add `export PATH="$HOME/.npm-global/bin:$PATH"` to your shell profile (`~/.bashrc` or `~/.zshrc`), and open a new terminal.

**WSL.** Install Node and the assistants inside Linux. By default Windows' own `npm` and programs are on WSL's PATH too; `command -v node npm` should print Linux paths, not `/mnt/c/…`.

If Windows says `divan` is not recognized after installation, run `npm prefix -g` and add the folder it prints to your user PATH (often `%APPDATA%\npm`). Open a new terminal, then stop and restart Divan from it so it inherits that PATH. Restarting can interrupt work; Divan never changes PATH automatically.

In the observed Windows OpenSSH setup, ending the SSH session also ended its detached server. Use `divan serve` inside a kept SSH session there.

The default port is **47321**. `divan --port N` changes it for this run only. For a lasting change, use Connect's Port field, or set `"port": N` in `settings.json` in the Divan home (`~/.dio-divan`, or `DIVAN_HOME`).

These addresses are sign-in links, not bookmarks. After restarting, run `divan` again and paste the fresh address into **the same tab** to keep its question draft. The fragment is cleared after sign-in. Completed answers also have one-use links that expire after 30 minutes. The persistent client API key is never part of a sign-in address.

## Your first question

With one usable model, use the Home action naming that assistant to create a single-assistant model. It keeps your question; sending it requires a separate press of **Ask**.

With one company and at least two different discovered models, Default uses two models as members and a third different model as chairman when available. They may share blind spots and the chairman may favour answers like its own. An assistant from another company makes the council independent. Quick keeps its chairman separate and is blocked in this configuration.

With two companies, Default can use two different models from one and a chairman from the other. One usable program such as Pi can supply those models; Home names that program and warns that its faults affect every participant. With three native assistants, Claude Code chairs while Codex and Grok answer. Larger already-separated rosters remain possible. Unknown router names do not prove different companies. When there is no feasible roster, Home offers one assistant. That action reuses an untouched matching single model; Models’ new-single action still creates another. Saved models, explicit level choices and existing sessions retain their settings.

Each call uses **your own subscriptions or API credits**. Home shows the actual maximum calls for the chosen model; retries can add calls. Actual usage appears after a round. The time for a first real round is unknown until measured; later Home can show the measured range. No question is sent until you press Ask. Setup checks only inspect assistants.

Optional example: “For a small project I maintain alone, when would splitting it into services be worth the extra work? Give reasons for both choices.”

## What assistants can read

The access controls select tools, memory and web. With tools on, assistants may read beyond the chosen working folder and relevant local T3 conversations when available. Memory is read only when enabled. Codex's shell can read anything your account can. What an assistant reads can go to its model provider. The local panel is not local model inference or a file-access sandbox. Tools and web start on, and memory too where a read-only connection exists; change them for each assistant in Models.

agy is a manual exception, excluded from Default, Quick and the first-run Single suggestion. Its own settings control tools, memory and web: **agy can write files and run commands on this computer, and Divan cannot stop it.** Divan shows that warning when selected, on its card, before Ask and in the session’s frozen settings. It starts in an empty scratch folder and receives the project path in its prompt. agy must support stream-json input on stdin. Version 1.3.4 accepts that input and a JSON schema, but rejects JSON model listing: enter a model slug manually, such as `gemini-3.8-flash`. Display names are not supported.

When Claude Code is signed in but its catalogue is missing, Divan uses Claude Code's documented standard names `opus`, `sonnet` and `haiku`. Check again replaces those aliases when a catalogue is available.

After installing a CLI, stop Divan and start it from a new terminal so it receives the updated executable search path (PATH). Restarting can interrupt work. Home checks again only when asked; it does not poll or check on focus. If Divan still says an assistant is not installed, its folder is not on PATH: Claude Code's installer puts `claude` in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) and prints the line to add to your shell profile. Add it, open a new terminal, stop Divan and run `divan` again. Divan notices Claude Code in that folder and tells you so; it never runs a program from there.

On Windows, Divan supports Hermes source revision `59004a62356f` (pinned in `src/server/adapters/hermes/supported.json`); other installations are shown as unsupported.

## Connect another app

Connect shows the installed paths and client key. Its connection test checks that the server answers and lists models; it does not run an assistant.

- **T3 Code:** add an ACP provider with Local command, using the executable and arguments shown in Connect. ACP is the protocol through which T3 talks to Divan. Initialization does not start the server; the first prompt starts it lazily.
- **Pi:** run the `pi install` command shown in Connect to register the packaged extension. It lists Divan models without starting the server and starts it on first use.
- **OpenAI-compatible clients:** use Connect's local `/v1` base address and key. Model names are `divan/<id>`; `reasoning_effort` can be `low`, `medium`, `high` or `max`.

## Update or remove

Disconnect clients and stop Divan before an update or uninstall. After updating with `npm install -g dio-divan`, start Divan again; the running process does not update itself. Remove the package with `npm uninstall -g dio-divan`, and remove its Pi/T3 registrations. Deleting the Divan home is a **separate optional action** that removes saved sessions and keys: normally `~/.dio-divan`, or the folder named by `DIVAN_HOME`.

For Pi, run `pi remove "<the extension path Connect showed>"` (`pi list` shows registered sources). In T3 Code's provider settings, remove the Divan ACP provider. If you uninstalled while Divan was running, read `pid` in `<Divan home>/server.json` and stop that process: Windows `taskkill /PID N /T /F`; macOS/Linux `kill -TERM N`. Check that the PID still belongs to Divan before stopping it.

## Develop from source

Use Node 24.21+ and pnpm. Run `pnpm i`, `pnpm build`, then `pnpm start`. `pnpm check` runs typecheck, lint and tests; the tests need no assistant installed (they use inert stand-ins and fake assistants) and run on Windows, macOS and Linux. `DIVAN_FAKE=1` uses deterministic fake assistants. `pnpm e2e` and `pnpm e2e:flows` use their own homes and headless browser profiles, and need Chrome, Chromium or Edge: they look in the usual places and for `google-chrome` or `chromium` on PATH; set `DIVAN_CHROME` to the browser program otherwise. The release build emits JavaScript and prebuilt web assets; installing its tarball needs only production dependencies and runs no build on the user's machine.
