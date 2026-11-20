# Overtype

Overtype is a desktop VS Code extension for reviewing AI-generated code changes. Select a function and ask for an edit, or give the agent a goal that spans a repository. TrueForge runs the model and records the session. Overtype shows the proposed changes alongside the original files. You decide which hunks enter your editor buffer and when to save them.

Built from scratch for the TrueFoundry Forge-a-thon by **Team 007 · Shaman Shetty · NMIMS · GitHub @shamanshetty**. The extension is MIT licensed. OpenAI Codex assisted with implementation, debugging, documentation and verification. Dependency credits are in [third-party notices](THIRD_PARTY_NOTICES.md).

## What works today

| Capability | Evidence on the development workstation |
|---|---|
| Inline edit, Task A | A live Gemini turn on Flask 3.1.3 staged an edit to `get_debug_flag`. The verifier accepted it, checked the requested values and docstring, and passed all 58 CLI tests. |
| Multi-file agent, Task B | The model used real repository tools. A complete implementation, test and documentation change passing the verifier is **still outstanding**. One live run staged all three files, but its generated command failed on Flask?s default duration value. Subsequent runs hit provider rate limits. |
| Recovery, Task C | The verifier exercised an unreachable harness and a failed primary provider. A working Gemini secondary staged a proposal while the checkout stayed clean. A separate live run accepted the fallback patch in the disposable checkout and passed all 58 CLI tests. |
| Review and editor tools | Isolated VS Code checks exercised a diff, hunk acceptance and rejection, native undo, staged reads, protected paths and rejection of an edit after cancellation. |
| Harness integration | A deterministic provider invoked an authenticated editor tool through TrueForge and returned its fresh nonce. This checks the transport independently of model quality. |

The live results above were obtained before the display-name change from Astra to Overtype. SDK configuration, VS Code command IDs and the local TrueForge data-directory suffix retain their original identifiers so existing installations can reuse their models and settings.

## Run from a clean clone

**Prerequisites.** Install desktop VS Code 1.100 or newer, Node.js 22.14 or newer, npm and Git. Use a local Git checkout as the workspace. The documented development and live-test environment is Windows. Python is required for the Flask checks. Hosted models need their provider credentials and network access.

1. Open a terminal in the cloned Overtype repository. Install the locked dependencies and build the extension.

   ~~~sh
   npm ci
   npm run build
   npm run harness
   ~~~

2. Leave the harness terminal running. Open the [local TrueForge dashboard](http://127.0.0.1:8790). Open its model-provider settings, choose your provider, enter its credentials there, and enable a tool-calling model. For a local provider, start its model server first and use its reachable endpoint. For the Google setup, configure Gemini and select an available tool-calling model. Provider access, quotas and billed usage belong to that account.
3. In a second terminal in the repository, run `npm run doctor`. It checks Node, Git, the bundled agent definition, the model list and a diagnostic tool round trip. Copy the exact provider/model identifier it prints. The SDK expects the server origin and appends its API path.
4. Open the Overtype project folder in VS Code. Press **F5** and choose **Run Overtype** if prompted. In the new Extension Development Host window, open the project you want to edit and grant workspace trust if appropriate. Keep the harness running.
5. Open **Preferences: Open User Settings (JSON)** and select a model. This example uses the identifier observed on the development workstation. Replace it with the exact name from your own doctor output.

   ~~~json
   {
     "forgeReview.url": "http://127.0.0.1:8790",
     "forgeReview.models": ["google-gemini/gemini-3-5-flash-lite"],
     "forgeReview.contextBudget": 4000
   }
   ~~~

**Install in your regular VS Code window.** After the build, run `npx @vscode/vsce package --allow-missing-repository --no-rewrite-relative-links --out Overtype.vsix`. Then run **Extensions: Install from VSIX** and select that file. The extension still needs the running harness. The package contains the bundled extension, agent definition, licence, notices, example configuration and this guide.

## Make and review a change

**Edit a selection.** Highlight the complete function or block in a workspace file. Press **Ctrl+I** (**Cmd+I** on macOS), or run **Overtype: Edit Selection** from the Command Palette. Describe the behavior you want, including edge cases. Watch the **Overtype** Output channel. When the turn stages an edit, the original and proposed text open in a diff.

**Work across files.** Run **Overtype: Start Agent Task**. Enter a repository-level goal in the Overtype panel and click **Run task**. For example, ask for a behavior change, its test and its documentation. An explicit `@relative/path` increases a file's initial ranking if you already know where it belongs. For the official Task B evaluation, supply the goal without file hints. The panel streams model text, tool activity and the context ledger. **Overtype: Open TrueForge Session** opens the agent's session in the harness dashboard. Follow-up goals can reuse the conversation for the same workspace, endpoint and model.

**Decide and save.** In the proposed side of the diff, use **Accept** or **Reject** above an individual hunk. **Overtype: Review Changes** opens the pending-file picker. **Overtype: Accept All** applies the remaining proposals together. **Overtype: Reject All** discards them. Acceptance updates editor buffers through VS Code's edit API, so normal **Undo** works. Use **Save** or **Save All** to write accepted changes. A proposal conflict means the original text changed after staging. Discard the stale proposal and rerun against the current buffer.

**Stop a run.** Use the panel's **Stop** button or **Overtype: Stop**. Overtype aborts the local stream, requests session cancellation and clears pending proposals. Review actions wait until generation has ended. Finish or discard pending proposals before starting another task. The separate **Overtype: Check TrueForge Connection** diagnostic runs the editor probe against the selected model.

## How a request reaches the editor

~~~mermaid
flowchart LR
  Input[Selection or agent panel] --> Extension[VS Code extension host]
  Extension --> Context[Git paths and context ledger]
  Context --> Harness[TrueForge SDK session and streamed turn]
  Harness --> Model[Configured model provider]
  Harness --> Tools[Authenticated loopback MCP tools]
  Model -->|Inline response via TrueForge| Stage[In-memory proposals]
  Tools -->|propose_edit| Stage
  Stage --> Review[VS Code diff and hunk controls]
  Review -->|Accept| Buffer[WorkspaceEdit]
  Buffer -->|Save| Disk[Workspace files]
~~~

1. **Entry and state.** The extension selects the local workspace, checks trust and tracks one active run. The task panel and Output channel share an event log.
2. **Context.** Git enumerates tracked and nonignored untracked paths. Overtype filters hidden path components, dependency folders and names matching its credential/key patterns. Ranking combines prompt/path term matches, term frequency and path length. A visible editor adds 4 points and an explicit path mention adds 20. Up to 24 matching paths fit in the configured budget. For agent tasks, Overtype also examines up to eight ranked paths and takes a 16-line excerpt around a matching line when space permits. It estimates cost at four UTF-8 bytes per token. The ledger records scores, inclusion decisions, reasons and estimated costs. The initial context budget does not cap subsequent tool reads or provider usage.
3. **Agent and transport.** The extension loads [the agent definition](agent/forge-review.json) automatically. It adds the selected model and, for workspace tasks, a temporary MCP connector. The connector listens on loopback, requires a per-run bearer token, and is removed when the turn finishes. TrueForge runs inference and tool calls. The extension consumes streamed messages, approvals, tool responses and terminal events. The definition requests compaction and configures an iteration limit of 48.
4. **Two edit paths.** Inline mode sends numbered selection text and asks for exact original substrings and replacements. The client validates anchors and rejects ambiguous or overlapping edits. The Google integration requests JSON as text and parses it locally. Workspace mode exposes the tools below. Each proposed replacement must match exactly once in the current proposed file.
5. **Review and conflict handling.** Overtype retains the original document text and calculates diff hunks in memory. A virtual document supplies the proposed side of the diff. Revision checks protect stale controls. Before acceptance, Overtype checks that the underlying buffer still matches its expected state. Accept All validates the batch before applying a single workspace edit. Generation and staging do not create Git commits.
6. **Failure and fallback.** Configure model names in priority order. On a failed attempt, Overtype clears its proposals and tries the next model. An agent returning zero proposals can trigger the next configured model. Inspect the final staged-file count and run tests to assess a model's result. Switching models cannot repair an unreachable harness endpoint.

## Workspace tools and permissions

| Tool | What the model can do |
|---|---|
| `get_repo_map` | List up to 250 indexed paths with an optional substring filter. |
| `search_workspace` | Find literal, case-insensitive matches across supported source and documentation files. Returns up to 40 path-and-line matches. |
| `find_symbols` | Search declaration lines for matching names. It uses text patterns rather than a language-server index. |
| `read_file` | Read an excerpt starting at a one-based line number. Defaults to 80 lines, with a maximum of 160 lines and 16,000 characters per response. Reads prefer the staged version, then an open buffer, then disk. |
| `note_context` | Record why an indexed path matters in the run log. |
| `propose_edit` | Stage an exact `before` → `after` replacement in an existing file with a reason. |
| `run_command` | Request one of two presets, Git status or the Flask CLI test suite. |
| `run_tests` | Request the Flask CLI suite against a temporary copy that includes pending proposals. |

Command execution requires approval in TrueForge and a local VS Code confirmation showing the command. Test previews execute with the developer account's permissions and a 60-second command timeout. The temporary checkout separates ordinary test writes from workspace files. Open projects you trust. File tools check index membership, resolved path and a 512,000-byte size limit. Selection text, included excerpts and requested tool output can reach the configured provider. Store provider credentials in TrueForge.

## Model setup and diagnostics

| Setting | Resolution |
|---|---|
| Harness origin | `forgeReview.url`, then `TRUEFORGE_URL`, then `http://127.0.0.1:8790`. |
| Model order | A nonempty `forgeReview.models` array, then comma-separated `TRUEFORGE_MODELS`, then `TRUEFORGE_MODEL`, then the harness model list. |
| Initial context | `forgeReview.contextBudget`, default 4000 estimated tokens. |
| Verifier executables | `FORGE_PYTHON` selects the Flask interpreter. `FORGE_VSCODE_EXE` overrides the VS Code executable. |

Set environment variables in the shell launching the process that needs them. [.env.example](.env.example) documents variable names. The harness launcher binds IPv4 loopback and uses an isolated application-data suffix. Run a single instance for that data directory. The launcher allows the loopback host for local provider and editor callbacks.

Development used Google-hosted Gemini models and local DeepSeek/Qwen models served through LM Studio and llama.cpp. The Gemini Flash Lite configuration produced the verified A and C edits. Other hosted attempts encountered high-demand errors, timeouts and quota limits. Local inference had no metered API fee. Google charges were not measured. The deterministic provider exists for integration testing.

| Symptom | What to check |
|---|---|
| Cannot connect or no models appear | Start the harness, visit the local dashboard, configure a provider, then run the doctor from the built repository. |
| F5 or an extension command is unavailable | Open the extension project as a folder, run the build, and use the Extension Development Host for the target checkout. |
| Selection or workspace refused | Select text in a local workspace file and verify the folder is a trusted Git checkout. |
| Paused after a command request | Inspect the VS Code approval notification and TrueForge session. Approve or decline the specific command. |
| Provider timeout, quota error or no proposals | Inspect the final session event and model identifier. Add a working secondary in user settings. Check the staged-file count before claiming completion. |
| Flask verifier uses the wrong Python or pytest | Set the absolute interpreter path in the shell launching the verifier. Use the pinned pytest version below. |

## Reproduce the checks

Keep the harness running. In another terminal run `npm test`. It rebuilds TypeScript and the esbuild bundles, checks review and context behavior, then exercises the fixture through TrueForge. Run `npm run verify:review` for editor-side hunk review and undo, and `npm run verify:tools` for MCP access and staging checks.

For the live Flask tasks, prepare an interpreter once. This PowerShell example keeps the virtual environment outside the product checkout.

~~~powershell
$venv = Join-Path $env:TEMP 'overtype-flask'
python -m venv $venv
$env:FORGE_PYTHON = Join-Path $venv 'Scripts/python.exe'
& $env:FORGE_PYTHON -m pip install Flask==3.1.3 pytest==8.4.2 asgiref python-dotenv
$env:TRUEFORGE_MODEL = 'google-gemini/gemini-3-5-flash-lite'
npm run verify:a
npm run verify:b
npm run verify:c
~~~

Replace the model ID with one listed by your harness. Run the commands individually so each result is visible. The verifier clones the Flask **3.1.3** tag into a fresh temporary directory, launches an isolated VS Code host and sets `PYTHONPATH` to that checkout's source. It reads the host's explicit verdict before cleaning up. Git access to GitHub is required. The C verifier exercises the local harness at its default address and temporarily registers a deliberately unreachable primary provider. Use the harness locally for this check.

| Task | Manual demonstration | Verification target |
|---|---|---|
| A | In `src/flask/helpers.py`, select `get_debug_flag`. Ask it to treat “off” and “n” as false case-insensitively and document every false value. Open the diff and accept. | Only the helper file changes. Check lower- and uppercase inputs, a true control, the docstring and the CLI suite. |
| B | Ask for a built-in `flask config` command that prints loaded app configuration as JSON, masks values of keys containing SECRET, PASSWORD, TOKEN or KEY with `***`, appears in help, and is tested and documented. Show the ledger and **Open TrueForge Session**. | Review `src/flask/cli.py`, `tests/test_cli.py` and `docs/cli.rst`. Verify CLI help, JSON output, all four masks and passing tests. This remains the open acceptance check. |
| C | Start clean. Try an unreachable harness and observe the error. Restore the harness, configure an unreachable primary and a working secondary, and repeat A. | Confirm the editor remains responsive, the checkout stays clean before acceptance and the secondary produces a working edit. |

For a competition recording, use the actual A, B and C outcomes in that order, show the TrueForge session during B and capture the instruction-to-diff sequence. Use measured video timestamps in the scorecard. The organizer brief supplies the submission rules and PDF headings. [Competition brief](https://techfest.org/media/compiProbStatement/TrueFoundry_Forge-a-thon_compressed_UvvRJ9C.pdf)

## Source map

| File or directory | Responsibility |
|---|---|
| [package.json](package.json), [lockfile](package-lock.json) | Extension metadata, command titles, shortcuts, settings, scripts and dependency versions. |
| [src/extension.ts](src/extension.ts), [src/panel.ts](src/panel.ts) | Activation, trusted workspace checks, run state, command dispatch and the task panel. |
| [src/turn.ts](src/turn.ts), [agent definition](agent/forge-review.json) | Context assembly, session creation and reuse, provider fallback, token streaming, connector lifecycle and inline response validation. |
| [src/context.ts](src/context.ts), [src/workspace-tools.ts](src/workspace-tools.ts) | Ranked path ledger, allowed repository paths, reads, searches, proposal tools and approved command presets. |
| [src/review.ts](src/review.ts), [src/review-ui.ts](src/review-ui.ts) | Hunk calculation, virtual documents, CodeLens actions, conflict checks and editor transactions. |
| [src/spike.ts](src/spike.ts), [scripts/fixture.ts](scripts/fixture.ts) | Minimal editor tool probe and deterministic provider fixture for tracing one call through the complete stack. |
| [scripts](scripts) | Harness launcher, doctor, probe entry points, review assertions and isolated VS Code verification hosts. |
| [.vscode/launch.json](.vscode/launch.json), [.vscodeignore](.vscodeignore) | Development-host launch configuration and extension package allowlist. |

The application uses TypeScript, the TrueForge SDK, the Model Context Protocol SDK, Zod for tool inputs, jsdiff for change calculation and esbuild for bundling. The lockfile pins the tested dependency tree.

## Limitations and next work

The most important remaining engineering task is **repeatable Task B completion**. Current evidence shows retrieval and tool calls, but no verified three-file result. Use the same Flask tag, model identifier and goal to reproduce it. Inspect the session for repeated searches, paused approvals and rejected edit anchors, then rerun the full B verifier after any change.

Review covers existing text files. Pending proposals live in memory and disappear when the extension host reloads. Retrieval uses lexical matches and bounded excerpts, so symbol relationships across files can be missed. Cancellation latency, compaction quality and model-to-model success rates have not been benchmarked. Further work would add file creation and deletion to the review transaction, persist recoverable proposals, and measure multi-file accuracy across providers.
