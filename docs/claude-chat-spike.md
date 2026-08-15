# Claude Chat Driving Spike

Date: 2026-08-15  
Decision: **No-go for driving the Claude Code VS Code panel as a second in-process executor.**  
Conditional alternative: **Go only for a later process-backed Claude Agent SDK/CLI executor**, which is a separate execution surface and not the Claude panel targeted by this spike.

## Question and boundaries

The target is the first-party Anthropic `anthropic.claude-code` extension's
Claude-powered agent session rendered inside VS Code. “Drive” means that
Kanban Pilot can select that backend, open or resume a task-bound session,
submit a task prompt with the task file attached, await a terminal result,
handle cancellation and errors, and prove that the result belongs to the task.

The following are deliberately not interchangeable with the target:

| Surface | Treatment in this spike |
| --- | --- |
| Claude Code for VS Code, native panel/editor sessions | Target. Tested by local installation inspection and an extension-host inventory probe. |
| Claude Code through `.claude/skills/kanban-pilot/SKILL.md` or the standalone CLI | Comparison/fallback only. This is a process-backed Claude Code path, not a way to drive the VS Code panel. |
| A Claude model selected inside GitHub Copilot Chat | Not a separate Claude backend. It remains the Copilot Chat session and executor. |
| Claude web application / Claude Code on the web | External client, not the local VS Code session surface. |

No production provider, executor, setting, board behavior, or user-facing
workflow was changed by this spike.

## Version and availability evidence

### Local installation

The commands below were run in the workspace on 2026-08-15, without reading or
printing credentials:

| Item | Observed value |
| --- | --- |
| VS Code CLI | `1.127.0`, commit `4fe60c8b1cdac1c4c174f2fb180d0d758272d713`, x64 |
| Extension-host test runner | VS Code `1.133.0` from the cached `vscode-test` installation; the host probe is non-invasive and does not require Claude to be installed in that isolated test host |
| Kanban Pilot engine requirement | `^1.125.0` in [package.json](../package.json) |
| Claude extension | `anthropic.claude-code@2.1.233` |
| Claude extension engine | `^1.94.0`, from the installed extension manifest |
| GitHub Copilot extension | Not present in `code --list-extensions --show-versions` in this installation |
| Claude CLI on PATH | Not used by the target probe; the VS Code extension bundles its own CLI according to the official documentation |

The local Claude manifest exposes commands such as
`claude-vscode.primaryEditor.open`, `claude-vscode.editor.open`,
`claude-vscode.newConversation`, and `claude-vscode.reopenClosedSession`.
It contributes settings for authentication-dependent UI, permission mode,
terminal mode, and preferred location, but it does not declare a public
extension API or provider-selection contribution.

The installed version is compatible with the workspace's declared VS Code
range. The evidence is specific to VS Code 1.127.0 and Claude Code 2.1.233;
an update to either surface requires rerunning the probe and matrix.

### Official documentation

The [Claude Code VS Code documentation](https://code.claude.com/docs/en/vs-code)
states that:

- VS Code 1.94.0 or higher and an Anthropic account or Claude Console account
  are prerequisites.
- the extension authenticates through its own sign-in flow;
- multiple conversations can be opened in tabs/windows and their histories are
  separate;
- files can be supplied with `@`-mentions or by Shift-dragging them into the
  prompt box;
- the documented `vscode://anthropic.claude-code/open` handler accepts
  optional `prompt` and `session` query parameters;
- `prompt` is pre-filled but **not submitted automatically**;
- `session` resumes only a session belonging to the current workspace, and an
  unknown session starts a fresh conversation.

The official [VS Code API reference](https://code.visualstudio.com/api/references/vscode-api)
documents `commands.getCommands` and `commands.executeCommand`, the chat
participant API, and the language-model API. Those APIs let an extension
inventory/invoke commands, implement its own chat participant, or send a raw
language-model request. They do not expose another extension's private
conversation transcript, panel turn, attachment picker, completion event, or
provider-specific agent session handle.

The workspace's installed `@types/vscode` version is `1.125.0`. Its public
declarations include `vscode.chat.createChatParticipant`,
`vscode.lm.selectChatModels`, `LanguageModelChat.sendRequest`, and cancellation
tokens, but no public `ChatSession`/Claude-agent controller or session-resource
API that can drive a contributed agent panel. A language-model request would
also be a new raw model integration rather than a request into the Claude Code
extension's native agent loop.

The official [Claude Code headless documentation](https://code.claude.com/docs/en/headless)
and [Agent SDK TypeScript reference](https://docs.anthropic.com/en/docs/claude-code/sdk/sdk-typescript)
do provide a distinct process/API path: `claude -p`, JSON/stream-JSON
results, `--resume` session ids, tool controls, and SDK query interruption.
That path is useful for a future executor, but it is outside the target.

## Disposable probe

The isolated probe is deliberately not imported by the extension entry point:

- [src/spike/claudeChatProbe.ts](../src/spike/claudeChatProbe.ts) reads only a
  supplied Claude extension directory, reports manifest/source markers, and
  emits operation findings. It never calls VS Code or Claude.
- [src/spike/claudeChatHostProbe.ts](../src/spike/claudeChatHostProbe.ts)
  inventories `vscode.version`, the installed extension, and registered
  Claude command ids from an extension host. It executes no command and has no
  authentication path.
- [src/spike/sanitized-task.md](../src/spike/sanitized-task.md) contains only
  synthetic task markers.
- [src/test/claudeChatSpike.test.ts](../src/test/claudeChatSpike.test.ts)
  checks deep-link encoding, distinct isolation markers, the blocked critical
  path, and the non-invoking host probe.

For a reproducible local manifest probe after compiling tests, pass the
installed extension directory to `dist/spike/claudeChatProbe.js`. The JSON
report intentionally contains version, command, and capability evidence only;
it does not include prompts, transcript data, account data, or secrets.

The probe found these source markers in the installed 2.1.233 bundle:

| Marker | Observation |
| --- | --- |
| `registerUriHandler` | Present |
| `/open` URI route | Present |
| `session` query read | Present |
| `prompt` query read | Present |
| package-level public exports | Absent |

The command registry inventory is intentionally separate from the static
manifest inspection. A contributed command being visible to
`vscode.commands.getCommands(true)` does not make its argument shape,
completion behavior, or conversation model a supported cross-extension API.

## API and command findings

| Required operation | Supported API in the target extension? | Evidence and consequence |
| --- | --- | --- |
| Select the Claude backend/provider | **No** | The Claude extension has no public provider-selection API. Its model switcher and permission mode are panel UI state. VS Code's `lm.selectChatModels` selects language-model providers for a raw language-model request; it does not select Claude Code's agent loop. |
| Open a new task-specific session | **Partial** | The documented deep link opens Claude, and `session` can be passed when a real opaque Claude session id is already known. There is no documented mapping from a Kanban task id to a Claude session id. |
| Resume a task-specific session | **Partial** | A valid session id for the current workspace can be resumed/focused. An invalid or missing id can create/focus a new conversation, so blindly treating the open operation as a binding would weaken misroute containment. |
| Submit a prompt | **No** | The documented `prompt` query parameter pre-fills the input and deliberately does not submit it. The contributed open command's argument shape is an implementation detail, not a documented submit contract. |
| Attach the task file | **No** | Official docs describe @-mentions and Shift-drag UI attachments. There is no public `attachFiles` argument or attachment API for Claude Code. |
| Wait for completion / obtain a result | **No** | No public command result, event, transcript stream, or run handle is exposed for a panel turn. The open command resolves after opening UI, not after Claude completes. |
| Handle errors and cancellation | **No** | There is no public cancellation token for a submitted panel turn or structured error/result contract. Sign-in and permission prompts remain human UI interactions. |
| Identify or contain a misrouted session | **No** | No public current-session identity or transcript event API is available to compare against a task. The fallback-to-fresh-session behavior for an unknown id is unsafe for a receipt-authoritative workflow. |

The VS Code command API is technically capable of invoking a contributed
command, and the installed bundle contains
`claude-vscode.primaryEditor.open(sessionId, initialPrompt)` internally. That
does not elevate the argument shape into a supported API: it remains an
undocumented workbench/extension implementation seam and still does not submit,
attach, await, cancel, or identify a run.

## Evidence matrix

Statuses mean **Pass**, **Blocked**, or **Not exercised**. Blocked here is a
precisely evidenced inability to complete the target critical path, not a
claim that the Claude UI itself cannot run.

| Scenario | Result | Evidence / expected check |
| --- | --- | --- |
| Copilot baseline | Blocked in this machine | The installed VS Code list had no GitHub Copilot extension, so a live baseline/coexistence run could not be performed. The existing baseline seams were read from [executor.ts](../src/chat/executor.ts), [runManager.ts](../src/chat/runManager.ts), [sessionUri.ts](../src/chat/sessionUri.ts), [promptTemplates.ts](../src/chat/promptTemplates.ts), [receipt.ts](../src/chat/receipt.ts), [extension.ts](../src/extension.ts), and [package.json](../package.json). |
| Claude first run | Blocked | The official deep link can open the panel and pre-fill text, but does not submit it. No supported attachment or terminal-result API exists. Authentication would also require a user sign-in and was not automated. |
| Claude continuation on same task | Partial / blocked for automation | A known valid Claude UUID can be supplied through `session`; the probe cannot obtain or verify that UUID from the panel, and cannot send the continuation or await its completion. |
| Two task sessions with distinct identities | Blocked for target automation | The sanitized plan uses `SPIKE-TASK-A`/`CLAUDE_SPIKE_TASK_A` and `SPIKE-TASK-B`/`CLAUDE_SPIKE_TASK_B`. Claude's UI promises separate histories for separate conversations, but no supported API exposes the identity needed to prove the task-to-session binding or detect cross-context leakage. |
| Claude/Copilot coexistence | Not exercised | Copilot is unavailable in the inspected local installation. The documented VS Code UI can host multiple Claude conversations, but this is not evidence that an external board can coordinate both provider lifecycles. |
| Window reload / resumed work | Partial | Claude documents session history and deep-link resume within the current workspace. Kanban Pilot cannot persist or revalidate the opaque Claude session id through a supported extension API. |
| Provider unavailable / authentication required | Blocked | The target requires sign-in and exposes this through UI. There is no supported preflight or structured error result that `Executor.isAvailable()` can use without opening the panel. |
| Terminal/error completion | Blocked | The panel has visible progress/errors, but no cross-extension completion stream, cancellation handle, or terminal state result. |

The focused automated checks are intentionally non-invasive. They validate the
probe and the exact blocker without launching Claude, opening a panel, asking
for auth, writing a task file, or capturing a transcript.

## Compatibility with Kanban Pilot guarantees

The current integration has guarantees that a panel-only bridge cannot preserve:

1. `Executor.run()` is awaited by `RunManager` and must return a terminal
   `ExecutorResult`. A timeout races that promise, and failures are reconciled
   into a receipt/status transition.
2. The agent writes a task-specific receipt described by [receipt.ts](../src/chat/receipt.ts).
   `RunManager` re-reads the task file and accepts only the matching
   `run:<id> task:<id>` receipt after the executor returns.
3. [promptTemplates.ts](../src/chat/promptTemplates.ts) inlines the current
   task, Refined, and Scope content and asks the agent to write the receipt.
4. [sessionUri.ts](../src/chat/sessionUri.ts) derives a stable
   `vscode-chat-session` URI from the task id. The current Copilot executor
   also passes task-file attachment and tool include/exclude values and reads
   Copilot's returned `metadata.sessionId` for misroute detection.
5. [runManager.ts](../src/chat/runManager.ts) enforces timeout, staleness after
   Stop/new runs, reload reconciliation, and per-task receipt handling.
6. [extension.ts](../src/extension.ts) constructs one Copilot-specific
   `ChatSessionExecutor`; [package.json](../package.json) has no provider
   setting or executor factory.

The Claude panel cannot currently satisfy items 1, 2, and 4: no submitted-turn
promise/result, no attachment/tool restriction bridge, and no observable Claude
session id. Adding UI automation would also make item 5 unreliable: focus can
move, a permission prompt can pause indefinitely, and a reload can lose the
automation's knowledge of what was submitted. A timeout would stop waiting but
would not cancel the Claude turn, so a later human completion could write a
receipt after Kanban Pilot has already marked the run failed.

The VS Code Language Model API is not a drop-in fix. It would let a future
extension select a model and manually implement request/tool loops, but it does
not invoke Claude Code's native agent session, permission UX, transcript, or
session history. Reimplementing those concerns would be a new provider, not
driving Claude Chat.

## Isolation and coexistence conclusion

Claude's documented UI behavior supports multiple independent conversations,
but the integration boundary needed by the board is stronger: Kanban Pilot
must know which opaque session received the prompt, know when that exact turn
ended, and reject a receipt from another session/task. The target exposes none
of those facts through a supported API. An invalid session id intentionally
falls back to a fresh conversation, which is a concrete misroute risk rather
than proof of isolation.

Therefore the matrix cannot honestly mark first run, continuation, or
Claude/Copilot coexistence as a pass. The blocker is reproducible from the
installed manifest/source markers and the official URI documentation; it is
not a transient auth or network failure.

## Security, authentication, and maintenance risks

- **Authentication:** The panel requires Anthropic/Claude Console sign-in. A
  board extension should not scrape, reuse, or store Claude credentials. The
  probe uses no credentials and never opens the auth UI.
- **Tool policy:** Copilot's `toolsExclude`/`toolsInclude` values do not map to
  Claude Code's permission modes. Passing a prompt through the panel could
  silently allow tools that the board intended to deny, or pause for a human
  permission decision beyond the run timeout.
- **Workspace scope:** The deep-link session must belong to the current
  workspace. Workspaces, folders, and reloads can make a previously stored
  opaque session id invalid; the documented fallback to a new conversation is
  unsafe without an identity check.
- **UI automation:** Focus, clipboard, simulated typing, undocumented command
  arguments, and internal webview messaging are brittle and can leak prompts
  into the wrong window. They also cannot provide a trustworthy completion
  receipt.
- **Extension updates:** The command names and URI handler are available in
  Claude Code 2.1.233, but internal argument shapes and compiled source are
  not a compatibility contract. The exact VS Code/extension pair must be
  rechecked after updates.
- **Cost and side effects:** A timed-out panel turn may continue running, and
  Claude Code can read/write files or run terminal commands under its own
  permission settings. Kanban Pilot cannot currently enforce its per-stage
  restrictions at that boundary.

## Fallback comparison

| Option | Fit | Notes |
| --- | --- | --- |
| Existing Claude Code skill/CLI handoff | Supported manual fallback | Keeps credentials and permissions in Claude Code's supported surface. It is not board-driven and does not provide the native VS Code panel integration. |
| Claude Code CLI `-p` / Agent SDK | Conditional future automation | Officially provides JSON/stream-JSON results, `--resume`/SDK session ids, interruption, and tool controls. It can be a separate process-backed executor with explicit security review, but it is a different target and should not be described as driving Claude Chat. |
| Clipboard/manual prompt handoff to Claude panel | Last-resort manual fallback | Opens or focuses the panel and asks the user to paste/attach. It cannot be an automated run or authoritative receipt path. |
| Claude model inside Copilot | Not a fallback for this question | It remains Copilot Chat and uses the existing Copilot backend/session. |

## Smallest safe follow-up plan

Do not start this follow-up until a supported Anthropic integration contract is
available, or the product owner explicitly changes the target to the official
Agent SDK/CLI.

### If the target remains the Claude VS Code panel

1. Obtain a documented Anthropic API for submit-with-attachments, session
   identity/resume, completion/error/cancellation, permission/tool policy, and
   provider availability. Do not rely on `primaryEditor.open` argument shapes,
   internal webview messages, or focus automation.
2. Add a provider-neutral `Executor` factory and an explicit provider setting
   in [src/chat/executor.ts](../src/chat/executor.ts), [src/extension.ts](../src/extension.ts),
   and [package.json](../package.json). Keep Copilot as the default and reject
   unknown providers.
3. Define a Claude-specific session binding in
   [src/chat/sessionUri.ts](../src/chat/sessionUri.ts) only after the provider
   supplies a stable, verifiable id. Store provider plus session identity so a
   Claude id cannot be mistaken for `copilot_session_id`.
4. Extend [src/chat/runManager.ts](../src/chat/runManager.ts) only with a
   provider-neutral terminal/cancellation contract. Preserve timeout,
   staleness, receipt matching, reload reconciliation, and failure semantics;
   a timeout must cancel the provider turn or record that cancellation was not
   confirmed.
5. Keep prompt and receipt contracts in
   [src/chat/promptTemplates.ts](../src/chat/promptTemplates.ts) and
   [src/chat/receipt.ts](../src/chat/receipt.ts) provider-neutral. Add focused
   executor, run-manager, session-binding, and provider-misroute tests under
   `src/test/` before enabling the setting.
6. Re-run the full matrix with two task ids, Claude/Copilot coexistence, reload,
   missing auth/provider, cancellation, and a deliberately invalid session id.

### If the target changes to Agent SDK/CLI

Keep the same file-level seams and tests, but implement a separate process
backend with explicit working directory, sanitized task-file reference,
allowed-tool policy, session id capture, structured result parsing, process
termination, and authentication documentation. Do not reuse Claude panel
commands or claim that the panel is being driven.
