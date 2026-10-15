# Dio Divan

**Build AI workflows from the coding assistants you already use, then use each workflow as one model.**

Divan connects Claude Code, Codex, Grok, Pi and, on Windows, Hermes in a visual editor. A workflow can ask assistants independently, have critics review a draft, branch on a structured answer, or use just one assistant. Save it as a **Divan model** and ask it in Divan's local web app, T3 Code, Pi or an OpenAI-compatible client.

Divan is for research, advice, planning and review. Divan models return text; client integrations do not execute the client's tools or apply code changes. Calls use **your own assistant subscriptions or API credits**.

**Watch Divan in 58 seconds:**

https://github.com/user-attachments/assets/daa3eb32-e78d-479b-a6fd-eed4e1a4080b

## Get started

You need [Node.js 24.21 or newer](https://nodejs.org/en/download) and at least one installed, signed-in assistant with a usable model. Then:

```sh
npm install -g dio-divan
divan
```

`divan` starts a local server, opens a fresh sign-in link and shows setup help for the assistants it finds. Choose a suggested model or make one in **Models**, type a question, and press **Ask**. Setup checks do not send your question. Run `divan` again to reopen the server; use `divan stop` to stop it. `divan serve` runs in the foreground when you need to see a startup error.

`npx divan` belongs to an unrelated package. Install `dio-divan` as shown above.

## Design a model

Start with a council, a writer reviewed by critics, or a single assistant. In the visual editor, connect assistants to decide which outputs they can read. Reuse prompts and response forms from the **Library**. Each saved design is a model you can run again.

![A writer sends a draft to critics, whose responses feed a rewriter](https://raw.githubusercontent.com/omid3098/dio-divan/main/docs/media/writer-critics.png)

*A writer, critics and rewriter in the model editor. Screenshots use example data in test mode.*

Add conditions to choose a branch from a structured result, and pick which fields travel along an edge.

![A condition routes a review to one of two branches](https://raw.githubusercontent.com/omid3098/dio-divan/main/docs/media/conditional-flow.png)

*A condition chooses which path runs.*

A council is one built-in flow: members answer independently without seeing one another's reports, then a chairman weighs their reports and writes one answer. Different models or providers can bring different perspectives, but agreement is no guarantee of correctness.

Divan shows each round's progress and answer in a branching conversation tree. Comment on an answer, continue from it, or branch from an earlier round. A saved session keeps the flow and settings it started with, so later model edits do not silently change that conversation.

![One question continues into two conversation branches, with an answer beside the tree](https://raw.githubusercontent.com/omid3098/dio-divan/main/docs/media/branching-council.png)

*An answer and two branches of the same conversation.*

## Use it from your editor or client

Open **Connect** in Divan for the commands, local address and client key for your installation. Its connection test checks the server and model list; it does not call an assistant.

| Client | Connection |
| --- | --- |
| **T3 Code** | Add Divan as a local ACP provider with the executable and arguments shown in Connect. ACP is the protocol T3 Code uses to talk to Divan. The first prompt starts Divan if needed. |
| **Pi** | Run the `pi install` command shown in Connect. Divan models appear in Pi's model list; first use starts Divan if needed. |
| **OpenAI-compatible clients** | Use Connect's local `/v1` base address and key. Models are named `divan/<id>`; `reasoning_effort` accepts `low`, `medium`, `high` or `max`. |

These integrations return Divan's text answer. In T3 Code, Divan does not call the tools T3 Code makes available to agents.

## Access, cost and limits

Each assistant call uses your subscription or API credits. Divan shows the selected model's maximum calls per round before Ask; retries can add calls, and actual usage appears after the round. One assistant is enough to start. Councils with multiple models may share the same provider or underlying blind spots, and availability can change which members run.

Tool, memory and web switches control what each assistant may read. With tools on, an assistant can read beyond the working folder; Codex's shell can read anything your account can. Read material may go to that assistant's model provider. Divan is a local organizer of existing assistants, not local model inference or a file-access sandbox. Tools and web start on, and memory starts on where a read-only connection exists; change access per assistant in Models.

**agy is a manual exception.** It is excluded from automatic suggestions. Its own settings control access, and it can write files and run commands; Divan cannot stop it. Divan warns you when you select it. It starts in an empty scratch folder and receives your project path in its prompt.

Real assistants have been tested on Windows. macOS and Linux pass automated install tests but have not yet been tested with real assistants. Hermes is Windows-only, and Divan supports its pinned source revision `59004a62356f`.

<details>
<summary>Installation and first-run help</summary>

On Windows PowerShell, if the execution policy blocks `divan.ps1`, run `divan.cmd` instead. If Windows cannot find `divan` after installation, check `npm prefix -g`, add that folder (often `%APPDATA%\npm`) to your user PATH, and open a new terminal. Stop and restart Divan from the new terminal so it can find installed assistants; restarting can interrupt work.

On macOS and Linux, a distribution's Node package may be older than 24.21. Install a current version from [nodejs.org](https://nodejs.org/en/download). If a global npm install fails with `EACCES`, give npm a user-owned prefix: run `npm config set prefix ~/.npm-global`, add `export PATH="$HOME/.npm-global/bin:$PATH"` to `~/.bashrc` or `~/.zshrc`, then open a new terminal.

In WSL, install Node and assistants inside Linux. `command -v node npm` should show Linux paths rather than `/mnt/c/…` paths.

The Home setup card reports assistants that are missing, signed out or missing a model catalogue. It links official setup instructions and offers **Check again**; it never installs or signs in for you. Claude Code without a catalogue uses its documented `opus`, `sonnet` and `haiku` aliases until a later check discovers the actual models. If Claude Code is installed in `~/.local/bin` (`%USERPROFILE%\.local\bin` on Windows) but that folder is off PATH, Divan reports it without running it. Add the folder to PATH, open a new terminal, then restart Divan. Home only checks again when asked.

With one usable assistant, Home can create a single-assistant model while keeping your draft. With more discovered models, it suggests a council when a viable roster exists; its notes explain shared providers and other limits. You can edit the model before asking. Nothing is sent until you press **Ask**.

agy needs stream-JSON input on stdin. Version 1.3.4 accepts that input and a JSON schema but does not list models as JSON. Enter a model slug manually, such as `gemini-3.8-flash`; display names are not supported.

</details>

<details>
<summary>Server, sign-in and network settings</summary>

The default port is **47321**. `divan --port N` changes it for one run; for a lasting change, use Connect's Port field or set `"port": N` in `settings.json` in the Divan home (`~/.dio-divan` or `DIVAN_HOME`). Set `DIVAN_NO_OPEN=1` to print a sign-in link without opening a browser. If the browser opener is missing or fails, Divan prints the link for you to open.

Sign-in addresses are temporary links, not bookmarks. After a restart, run `divan` for a fresh one and paste it into the same tab to keep an unsent draft. Completed answers have one-use links that expire after 30 minutes. The persistent client API key is never part of a sign-in address.

In one observed Windows OpenSSH setup, ending the SSH session also ended the detached server. Use `divan serve` inside a kept SSH session there.

</details>

<details>
<summary>Update or remove Divan</summary>

Disconnect clients and run `divan stop` before updating or uninstalling. Update with `npm install -g dio-divan`, then start Divan again; a running process does not update itself. Uninstall with `npm uninstall -g dio-divan` and remove its Pi and T3 Code registrations. Deleting the Divan home is a separate, optional action that removes saved sessions and keys (`~/.dio-divan` by default, or `DIVAN_HOME`).

For Pi, use `pi remove "<the extension path Connect showed>"`; `pi list` shows registered sources. In T3 Code's provider settings, remove the Divan ACP provider. If the package was uninstalled while Divan was running, read `pid` from `<Divan home>/server.json` and stop that process only after checking it still belongs to Divan: `taskkill /PID N /T /F` on Windows or `kill -TERM N` on macOS/Linux.

</details>

## Develop from source

Use Node 24.21+ and pnpm. Run `pnpm i`, `pnpm build`, then `pnpm start`. Set `DIVAN_HOME` to a separate folder for manual development runs if you also use an installed Divan. `pnpm check` runs typecheck, lint and tests with fake assistants; no installed assistant is needed. `DIVAN_FAKE=1` runs the app with deterministic fake assistants. `pnpm e2e` and `pnpm e2e:flows` need Chrome, Chromium or Edge; set `DIVAN_CHROME` if the browser is not in a usual location or on PATH. Release builds include the server JavaScript and web assets, so installing the package runs no build on the user's computer.

Licensed under [MIT](LICENSE). For help or bugs, use [GitHub Issues](https://github.com/omid3098/dio-divan/issues).
