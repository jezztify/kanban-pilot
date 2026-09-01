# Copilot Response Streaming Spike

Date: 2026-09-01
Task: TASK-005 — "Investigate copilot extension code if we can get the responses and stream it into
kanban-pilot"

Decision: **Conditional go.** Copilot Chat's response content *is* reachable from the extension
host, as ordinary files, without any private or proposed API — which is a different answer from the
one PRD §6.10 and [browser-chat-proxy-spike.md](./browser-chat-proxy-spike.md) reached. The
conditions are that it is a **lagging tail, not a live stream** — measured at 5-50 s behind on tool
events, see the Measurement section — that the format is undocumented and unversioned, and that
nothing raw may reach the shared browser endpoint without an explicit opt-in and redaction.

## Question and boundaries

Can Kanban Pilot obtain what Copilot actually *says* during a stage run — assistant messages, tool
activity, turn boundaries — and surface it in its own UI, rather than only learning `ok`/`sessionId`
when the turn ends?

"Stream it into kanban-pilot" is evaluated against three concrete destinations:

| Destination | What it would gain |
| --- | --- |
| Board detail pane ([boardPanel.ts](../../src/board/boardPanel.ts)) | An activity feed beside the card, for the local user who can already dock the real chat |
| Browser surface ([realtimeBoardServer.ts](../../src/http/realtimeBoardServer.ts)) | The remote viewer's *only* possible window into a run — they cannot dock a chat editor |
| Run supervision ([runManager.ts](../../src/chat/runManager.ts)) | Outcome/blocked detection from observed activity rather than only from a written receipt |

| Surface | Treatment |
| --- | --- |
| The bundled `GitHub.copilot-chat` extension's code, manifest, and exported API | Target. This is the surface the request names. |
| On-disk session records written by the workbench and by Copilot | Target. |
| `workbench.action.chat.export` | Target — re-examined, because §6.10's verdict turns out to be stale. |
| Copilot's `.github/hooks` mechanism | Target. |
| Stable `vscode.chat` / `ChatContext.history` | Re-confirmed only; it stays blocked. |
| `LanguageModelChat.sendRequest` | Assessed as an alternative architecture, not adopted. |
| Actually building a feed, a transport, or a projection | Out. This is a feasibility finding. |

No provider, executor, transport, board, or setting behaviour was changed. The only files added are
this document and a read-only probe with its test.

## Version and availability evidence

| Item | Observed value |
| --- | --- |
| VS Code | `1.127.0`, install root `…/Programs/Microsoft VS Code/4fe60c8b1c/` |
| Kanban Pilot engine requirement | `^1.125.0` ([package.json](../../package.json)) |
| `@types/vscode` | `1.125.0` |
| GitHub Copilot Chat | **Installed — as a built-in extension.** `GitHub.copilot-chat` **v0.55.0**, at `resources/app/extensions/copilot`, `main: ./dist/extension` (20.3 MB bundle) |

**This corrects a premise in [copilot-model-selection-spike.md](./copilot-model-selection-spike.md).**
That spike recorded Copilot Chat as "not installed in this profile", having looked at the
marketplace extension directory (`~/.vscode/extensions`, 27 entries, none matching `copilot`). It is
not there — because in 1.127.0 it ships *with* VS Code. Its code, its manifest, and its persisted
output were all available for this investigation, and TASK-004's premise ("needs a machine with
Copilot Chat installed") should be re-read in that light.

Findings below are read from the shipped 1.127.0 workbench bundle and the shipped Copilot Chat
0.55.0 extension bundle, plus the on-disk artefacts those two produced in this workspace. They are
verified for those builds. No live turn was started for the original investigation, so every timing
claim in the findings was read from the writer's code; **the Measurement section added on 2026-09-01
replaces that inference with one observed session, and revises it downward.**

## What Kanban Pilot sees today

The executor issues the chat open command and awaits one value:

```ts
const response = this.commands.executeCommand<ChatAgentResultish | undefined>(openCommand, finalPayload);
…
const result = await pending.response;
const sessionId = result?.metadata?.sessionId;
return { ok: true, sessionId };
```

[executor.ts:411](../../src/chat/executor.ts#L411), [executor.ts:423-425](../../src/chat/executor.ts#L423-L425).

`ChatAgentResultish` is declared as `{ metadata?: { sessionId?: string } }`
([executor.ts:229](../../src/chat/executor.ts#L229)), and that is not an under-modelling of the API —
the stable `ChatResult` really is only `{ errorDetails?, metadata? }`
(`@types/vscode` 1.125.0). The terminal result carries no response content, and it is terminal:
there is no progress callback on this path.

Consequently:

- The detail pane renders frontmatter, `## Request`/`## Refined`/`## Scope`, and the latest `## Log`
  receipt (PRD §6.10, "What the card detail shows").
- The browser projection is `{ revision, activeTaskSet, snapshot }` — frontmatter only, no chat
  content ([browser-chat-proxy-spike.md](./browser-chat-proxy-spike.md)).
- Run outcomes come from receipt reconciliation over the task file
  ([runManager.ts](../../src/chat/runManager.ts)), not from the conversation.
- The progress-line grammar exists but is **not wired up**: `parseProgressEntries`
  ([progress.ts](../../src/chat/progress.ts)) has no caller outside `src/test/progress.test.ts`. The
  conditional-go slice from the 2026-08-26 browser spike is half-built — the grammar shipped, the
  feed did not.

## Candidate-source matrix

Verdicts are **Viable**, **Viable but fragile**, or **Blocked**.

| # | Source | Verdict | Basis |
| --- | --- | --- | --- |
| A | Copilot's own session transcript, `…/workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl` | **Viable but fragile** | Structured, append-only, semantically labelled event log written by the extension itself. Finding 1. |
| B | Workbench session journal, `…/workspaceStorage/<ws>/chatSessions/<sessionId>.jsonl` | **Viable but fragile, and laggy** | Append-structured patch journal containing full response parts; flush is tied to a 60-second storage cadence. Finding 2. |
| C | `workbench.action.chat.export` **with a URI argument** | **Viable but fragile** | Skips the save dialog entirely when given a target. §6.10's "interactive, therefore unusable" is stale. Finding 3. |
| D | Copilot hooks in `.github/hooks` | **Viable** | A supported, user-configured extensibility surface that pushes an event containing `session_id` and `transcript_path`, after flushing the transcript. Finding 4. |
| E | The Copilot Chat extension's exported API | **Blocked** | It exports exactly `selectScope` and `getContextProviderAPI`. Finding 5. |
| F | Stable `vscode.chat` API | **Blocked** | The whole namespace is `createChatParticipant`; `ChatContext.history` is documented self-only. Finding 6. |
| G | Copilot's proposed-API surface (`chatParticipantPrivate`, `chatSessionsProvider`, `chatHooks`, `chatDebug`, …) | **Blocked for us** | Copilot declares 60+ API proposals; a marketplace-published extension cannot enable them. Finding 7. |
| H | `github.copilot.chat.agentDebugLog.fileLogging` | **Viable but fragile** | An off-by-default, `experimental`-tagged file log with a configurable 4000 ms flush. Finding 8. |
| I | `LanguageModelChat.sendRequest` | **Out of architecture** | Genuinely streams, but it is a separate request, not the panel's turn. Finding 9. |

### Finding 1 — Copilot writes its own structured transcript, and it is the best source

`dist/extension.js` contains a `SessionTranscript` service that writes one JSONL file per session
into the extension's **own workspace storage**:

```js
_getTranscriptsDir() {
  const storage = this._extensionContext.storageUri;
  if (storage) return this._transcriptsDirUri = Uri.joinPath(storage, "transcripts");
}
…
_bufferEntry(sessionId, entry, ts) {
  const id = uuid();
  const line = { ...entry, id, timestamp: ts ?? new Date().toISOString(), parentId: session.lastEntryId };
  session.lastEntryId = id;
  session.buffer.push(JSON.stringify(line) + "\n");
}
async _writeToFile(session, text) { await fs.promises.appendFile(session.uri.fsPath, text, "utf-8"); }
```

The event vocabulary is explicit, and each line is `{ type, data, id, parentId, timestamp }`:

| `type` | `data` |
| --- | --- |
| `session.start` | `{ sessionId, version: 1, producer: "copilot-agent", copilotVersion, vscodeVersion, startTime, context }` |
| `user.message` | `{ content, attachments }` |
| `assistant.turn_start` / `assistant.turn_end` | `{ turnId }` |
| `assistant.message` | `{ messageId, content, toolRequests[], reasoningText? }` |
| `tool.execution_start` | `{ toolCallId, toolName, arguments }` |
| `tool.execution_complete` | `{ toolCallId, success, result? }` |

A real transcript from this workspace parses to exactly that shape — 367 lines across
`session.start` ×1, `user.message` ×4, `assistant.turn_start` ×48, `assistant.message` ×44,
`assistant.turn_end` ×48, `tool.execution_start` ×111, `tool.execution_complete` ×111.

Four properties make this the strongest candidate:

1. **It is keyed by the session id Kanban Pilot already stores.** Every task file's
   `copilot_session_id` (harvested at [executor.ts:424](../../src/chat/executor.ts#L424), PRD §6.9)
   is the transcript's filename stem — see the evidence matrix for the 67/67 measurement.
2. **The path needs no API.** `ExtensionContext.storageUri` for *any* extension is
   `…/workspaceStorage/<workspaceId>/<publisher>.<name>/`, so Kanban Pilot can address Copilot's
   directory as `Uri.joinPath(context.storageUri, '..', 'GitHub.copilot-chat', 'transcripts')` —
   plain path arithmetic on a path VS Code hands us, plus `workspace.fs`. No proposed API, no
   private service, nothing to be granted.
3. **It is append-only**, so a tail is a file-watch plus a byte offset, not a re-parse.
4. **It is already semantic.** `tool.execution_start`/`_complete` and `assistant.turn_*` are exactly
   the granularity an activity feed wants; no markdown or tool-card rendering has to be
   reimplemented to use it.

The fragilities are real and must be stated:

- **Undocumented and unversioned by contract.** It self-describes (`version: 1`,
  `producer: "copilot-agent"`), which is better than nothing and gives a cheap compatibility gate,
  but nothing commits GitHub to keeping it.
- **Agent sessions only.** The producer is `copilot-agent`; transcripts were present for 14 of the
  67 sessions Kanban Pilot has recorded.
- **Retention is 20 files.** `cleanupOldTranscripts(20)` deletes the oldest transcripts, skipping
  active sessions, on every session start. It is a live window, not an archive — which explains most
  of the 14/67.
- **Flush is per model round-trip, not per token.** `flush()` is called when a prompt is rendered
  (i.e. before each request in a turn) and before each hook execution — not on every appended entry.
  Tailing therefore yields batches at roughly tool-call granularity. For an activity feed that is
  the right granularity; for a typewriter mirror it is not. **Measured 2026-09-01: the granularity is
  right but the latency is worse than "per round-trip" suggests — tool events wait a median of ~6 s
  and up to 53 s, because a tool call's duration falls inside the batch window. See the Measurement
  section.**

### Finding 2 — the workbench's own session journal is complete but ~60 seconds behind

VS Code 1.127.0 persists chat sessions itself, to a sibling directory:

```js
this.storageRoot = isEmptyWindow
  ? joinPath(globalStorageHome, "emptyWindowChatSessions")
  : joinPath(environmentService.workspaceStorageHome, workspace.id, "chatSessions");
…
await this.fileService.writeFile(loc.log, data, { append: op === "append" });
```

The file is a journal: line 0 is a full snapshot (`kind: 0`), later lines are patches — `kind: 1`
sets `v` at key path `k`, `kind: 2` splices `v` into the array at `k` at index `i`. Patch paths
observed on a real session include `requests/#/response`, `requests/#/result`,
`requests/#/completionTokens`, `requests/#/followups`, `requests/#/elapsedMs`. Response parts carry
`kind: "thinking"`, `"toolInvocationSerialized"` (with `invocationMessage`, `pastTenseMessage`,
`toolId`, `isComplete`, `isConfirmed`), `"progressTaskSerialized"`, `"codeblockUri"`,
`"textEditGroup"`, `"undoStop"`, `"inlineReference"`, and untagged markdown objects carrying the
assistant's prose in `value`.

So the content is all there. The problem is *when*:

- `writeSession` is only reached through `storeSessions`, and the service registers
  `storageService.onWillSaveState(() => this.saveState())`.
- The storage service's `DEFAULT_FLUSH_INTERVAL` is `60 * 1e3`.

**Up to ~60 seconds of lag**, plus explicit flushes on shutdown, session dispose, and title change.
This quantifies what §6.10 called "no flush-timing guarantee". It is fine as a catch-up or
reconciliation source; it is not a live feed. `trimEntries` also caps the index at 50 sessions.

### Finding 3 — the export command is not interactive when it is given a target

PRD §6.10 and the browser spike both list `workbench.action.chat.export` as blocked because it opens
a save dialog. In 1.127.0 it does that **only when called with no argument**:

```js
async run(accessor, target) {
  const widget = chatWidgetService.lastFocusedWidget;
  if (!widget || !widget.viewModel) return;
  if (!target) {                                   // ← only here
    const picked = await fileDialogService.showSaveDialog({ defaultUri, filters });
    if (!picked) return;
    target = picked;
  }
  const session = chatService.getSession(widget.viewModel.sessionResource);
  if (!session) return;
  await fileService.writeFile(target, VSBuffer.fromString(JSON.stringify(session.toExport(), undefined, 2)));
}
```

and `toExport()` includes the full response content per request
(`response: request.response.entireResponse.value.map(…)`), plus `modelId`, `timestamp`, `agent`,
`confirmation`, and `editedFileEvents`.

So a non-interactive, complete, on-demand snapshot is one `executeCommand(cmd, uri)` away. Two
caveats keep it out of first place: it acts on `lastFocusedWidget`, so it is focus-scoped and
inherits exactly the misroute risk class §6.9 exists to manage; and it is a snapshot per call, so
"streaming" would mean polling plus diffing, writing a file each time.

**This row is a correction to PRD §6.10, and §6.10 should be updated whether or not anything is
built on it.**

### Finding 4 — Copilot has a hook system, and it hands the hook the transcript path

Copilot 0.55.0 ships a `ChatHookService` that runs user-configured shell commands on chat events.
Its payload construction is the interesting part:

```js
if (sessionId) {
  await raceTimeout(this._sessionTranscriptService.flush(sessionId), 500);
  transcriptPath = this._sessionTranscriptService.getTranscriptPath(sessionId);
}
const payload = {
  timestamp: new Date().toISOString(),
  hook_event_name: event,
  ...(sessionId ? { session_id: sessionId } : undefined),
  ...(transcriptPath ? { transcript_path: transcriptPath.fsPath } : undefined),
};
```

The event vocabulary is `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`,
`UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`,
`SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`,
`TeammateIdle`, `TaskCreated`, `TaskCompleted`, and more. Hooks are discovered as workspace
customization files under `.github/hooks` (recursive), alongside `.github/instructions`,
`.copilot/agents`, and `.claude/skills`.

This is the one route that is a **push** rather than a poll, that is a **supported user-facing
configuration surface** rather than a scraped artefact, and that **flushes the transcript before
firing** — which pairs it exactly with finding 1: the hook says *when*, the transcript says *what*.
`PermissionRequest`/`PermissionDenied` also map directly onto the "waiting for approval in VS Code"
moment §6.10 and the browser spike both identify as the case that matters most.

Not free of conditions: it requires a file in the user's repository (or user profile), so it is
opt-in by construction — which is the correct default here, but it is not something the extension
can simply switch on. The payload schema is Copilot's, and is as unversioned as the transcript.

### Finding 5 — the extension's public API does not expose chat

The bundle exports only `activate`, and `activate` returns:

```js
const api = { getAPI(version) {
  if (version > ExtensionApi.version) throw new Error("Invalid Copilot Chat extension API version. Please upgrade Copilot Chat.");
  return instantiationService.createInstance(ExtensionApi);
} };
```

and the class behind it, at `version = 1`, has exactly two members:

```js
class { static version = 1;
  async selectScope(editor, options) { … }        // enclosing-scope selection
  getContextProviderAPI(version) { … }            // inline-completions context providers
}
```

Neither returns, streams, or references conversation content. `vscode.extensions
.getExtension('GitHub.copilot-chat')?.exports.getAPI(1)` is therefore a dead end for this question,
and that is a definitive answer rather than an unverified one.

### Finding 6 — the stable chat API is still closed, exactly as §6.10 said

In `@types/vscode` 1.125.0 the entire `vscode.chat` namespace is one function,
`createChatParticipant`. `ChatContext.history` carries the documented caveat "Currently, only chat
messages for the current participant are included." Nothing here reads another participant's
session. §6.10's first row stands unchanged.

### Finding 7 — Copilot's own access comes from proposed APIs we cannot have

`resources/app/extensions/copilot/package.json` declares 60+ `enabledApiProposals`, including
`chatParticipantPrivate`, `chatProvider`, `chatSessionsProvider`, `chatSessionCustomizationProvider`,
`chatHooks`, `chatDebug`, `chatParticipantAdditions`, `defaultChatParticipant`,
`agentSessionsWorkspace`, and `languageModelSystem`.

This is the structural reason every "just use the API Copilot uses" idea fails: those proposals are
not available to a marketplace-published extension. It also explains why the file-based routes are
the *only* viable ones — Copilot's privileged position is API-shaped, but its output is file-shaped,
and files do not check who reads them.

### Finding 8 — there is an official file log, but it is off, experimental, and debug-shaped

`github.copilot.chat.agentDebugLog.fileLogging.enabled` (default `false`, tagged `advanced`,
`experimental`, `onExp`) writes per-session logs under
`…/GitHub.copilot-chat/debug-logs/<sessionId>/`, with
`…flushIntervalMs` (default **4000**), `…maxRetainedSessionLogs` (50), and `…maxSessionLogSizeMB`
(100). The 4-second flush is much better than finding 2's 60 seconds, and the settings are at least
*declared*. Against it: it is off by default, `experimental` and `onExp` mean it can move or be
remotely toggled, and a debug log's contents are shaped for debugging, not for display. Worth
knowing about; not worth building the primary path on.

### Finding 9 — `sendRequest` streams, but it is a different product

`LanguageModelChat.sendRequest` returns an async token stream, so "streaming" is trivially solved —
for a request Kanban Pilot issues itself. That request is not the panel's turn: no tool approvals, no
docked chat, no Copilot agent mode, separate quota. This is the same conclusion row E of the browser
spike and [claude-chat-spike.md](./claude-chat-spike.md) reached from the other direction. It could
serve a narrow complementary job — e.g. summarising a tailed transcript into one feed line — but it
cannot be the source of the panel run's responses.

## Evidence matrix

| Claim | How established | Confidence |
| --- | --- | --- |
| Copilot Chat 0.55.0 ships built into VS Code 1.127.0 | Read `resources/app/extensions/copilot/package.json` | High — direct |
| The extension's public API is `selectScope` + `getContextProviderAPI` | Deminified `activate` return and the API class | High — direct |
| Copilot writes `transcripts/<sessionId>.jsonl` with the event vocabulary in finding 1 | Read the writer; parsed a real 367-line transcript | High — direct |
| Every session id Kanban Pilot records resolves to a workbench session file | 67 distinct `copilot_session_id` values across all task sets → **67/67** `chatSessions/<id>.jsonl` present | High — measured |
| A Copilot transcript exists for a subset of those | **14/67**, consistent with 20-file retention and agent-only production | High — measured |
| Workbench session persistence lags up to ~60 s | `onWillSaveState` + `DEFAULT_FLUSH_INTERVAL = 60 * 1e3` | Medium-high — read from code, not timed |
| Transcript flush happens per prompt render and per hook execution | Read the two `flush()` call sites | Medium-high — read from code, not timed |
| `chat.export` with a URI argument skips the dialog | Deminified the command body | High — direct, though not executed |
| Proposed APIs are unavailable to a published extension | Copilot's `enabledApiProposals` + VS Code's proposal policy | High |
| A tail of the transcript is enough for a useful feed | 70 entries observed live on 2026-09-01; usable for a feed, at 5-50 s behind on tool events | High — measured (one session, one host) |

That last row was the honest gap when this spike was written: no live turn had been observed, so the
transcript's behaviour *during* a run was reasoned from the writer's code rather than watched. TASK-009
closed it with one instrumented session — see the Measurement section, which answers the timing and
partial-line questions and revises what the tail can promise.

## Security and privacy

This is the part that constrains the design more than feasibility does.

Everything above is raw conversation: prompts, file contents pulled in as context, tool arguments,
command output, absolute paths, and whatever the agent read. The browser surface is a shared,
token-gated, potentially non-loopback endpoint fronted by a single bearer token
([browser-chat-proxy-spike.md](./browser-chat-proxy-spike.md)). Piping any of these sources onto it
verbatim widens the share link's meaning from "board state" to "everything the agent saw and said",
including secrets it happened to read.

Therefore, whatever is built:

- **Opt-in, off by default**, and separately opt-in for the browser channel versus the local detail
  pane. The local pane is a much smaller step than the remote one.
- **Project, do not proxy.** Map transcript events to a bounded, structural feed — "read
  `foo.ts`", "ran tests", "waiting for approval" — rather than forwarding `content` and tool
  `arguments`. The event vocabulary in finding 1 supports this directly: `toolName` and turn
  boundaries carry the signal without the payload.
- **Bound it.** Last K entries, re-synced on connect, exactly as the browser spike's transport
  section already argues.
- **Never forward `tool.execution_complete.result` or `assistant.message.content` to the browser**
  without a deliberate, separately-consented decision.

There is also a "read someone else's files" question worth stating plainly: these are the user's own
transcripts in their own workspace storage, read by an extension running on their machine at their
request. That is legitimate. Forwarding them off the machine is the part that needs consent, not the
reading.

## What changed since 2026-08-26

| Prior conclusion | Status now |
| --- | --- |
| §6.10: "Read the persisted session — internal root, undocumented format, no flush guarantee" | **Refined.** Still undocumented, but the location is derivable from our own `storageUri`, the format is append-structured, and the lag is quantified: ~60 s for the workbench journal, per-round-trip for Copilot's transcript. |
| §6.10 / browser spike row C: "`chat.export` is interactive, therefore unusable" | **Stale.** It is non-interactive when passed a target URI. |
| Browser spike row A: "no API exposes another participant's session content" | **Confirmed**, and strengthened: Copilot's own exported API does not either. |
| Browser spike row D: "agent-emitted progress lines are the smallest viable slice" | **Still true, and still unfinished** — the grammar shipped, the feed did not. |
| Browser spike: "no-go on full transcript mirroring" | **Still the right call**, but now for cost and privacy reasons rather than for lack of a source. |

The genuinely new fact is finding 1 + finding 4: Copilot itself writes a structured, semantic event
log and will tell an external command when it has been flushed. That was not part of the picture the
earlier documents were reasoning about.

## Recommendation

**Conditional go, in this order.**

1. **Finish the progress feed first.** The grammar is already shipped and unconsumed
   ([progress.ts](../../src/chat/progress.ts)), the agent already emits the lines, and it needs no
   undocumented format at all. It is the cheapest path to "watch the work happen", it is
   privacy-safe by construction, and every source in this document is a strict addition on top of it
   rather than a replacement for it. Doing this first also means the transport — a bounded feed
   channel, re-synced on connect — exists and is proven before anything riskier is attached to it.

2. **Then add a read-only transcript tail behind an opt-in setting**, projected into that same feed:
   source A for content, correlated by watching the transcripts directory on a task's first run and
   keyed by `copilot_session_id` only on later runs — the field is written 2 s after a run's last
   event, so it cannot key the run that produces it (TASK-011) — with the
   `version`/`producer` fields from `session.start` used as a compatibility gate that degrades to
   "no feed" rather than erroring. Local detail pane first; the browser channel as a separate,
   separately-consented step with structural projection only. **The measurement re-prices this step:
   the tail is 5-50 s behind on tool events, so it must be presented as a record of what happened, not
   as a live indicator, and it cannot carry approval prompts or run-completion detection.**

3. **Treat finding 4 (hooks) as the follow-on for liveness, not the starting point.** It is the only
   push-based source and the only one that surfaces approval moments as they happen, but it requires
   writing into the user's repository, so it deserves its own design conversation.

4. **Do not build on findings 2, 3, or 8** as a primary source. Finding 2 is a minute behind;
   finding 3 is focus-scoped and snapshot-shaped; finding 8 is off by default and explicitly
   experimental. Keep finding 3 in mind as a one-shot "export this run's conversation" affordance,
   which is a genuinely different and much easier feature than streaming.

5. **Update PRD §6.10.** Two of its three "why it fails" rows are now inaccurate for 1.127.0. The
   section's *conclusion* — dock the real chat rather than mirror it — survives, and should be kept;
   its stated reasons should not.

Follow-up work is filed as separate tasks rather than started here.

## Measurement — 2026-09-01 (TASK-009)

The timing claims above were read from the writer's code. This section replaces the inference with one
live observation, and it does not confirm what the inference predicted.

### Method

Each transcript line carries its own `timestamp`, stamped in `_bufferEntry` when the event occurs
rather than when the buffer is flushed. So the lag a tailing consumer experiences is
`observed append time - entry timestamp`, computable from the file alone with no panel
instrumentation and no human stopwatch. [`scripts/watch-transcript.mjs`](../../scripts/watch-transcript.mjs)
polls the transcripts directory, reads only newly appended byte ranges, and records that difference
per entry. It retains `type`, `timestamp`, observation time, and byte offsets — never `data` — so its
raw output is safe to quote here.

| Host fact | Value |
| --- | --- |
| VS Code / Copilot Chat | `1.127.0` / `0.55.0` — read from the observed session's own `session.start` entry |
| Transcript header | `version: 1`, `producer: "copilot-agent"` |
| Session observed | one agent session, joined ~72 s after it opened |
| Window | 300 s, polled every 50 ms |
| Captured | 70 entries, 13 flush batches, 37,002 bytes |

### Result 1 — the lag distribution is bimodal, and the median is the wrong number to quote

| Percentile | Lag |
| --- | --- |
| min | 34 ms |
| p50 | 111 ms |
| p75 | 5,802 ms |
| p90 | 16,483 ms |
| p95 | 51,993 ms |
| max | 53,480 ms |

Bucketed, the shape is not a tail — it is two populations with a gap between them:

| Bucket | Entries |
| --- | --- |
| under 250 ms | 38 |
| 250 ms – 1 s | **0** |
| 1 s – 5 s | 12 |
| over 5 s | 20 |

### Result 2 — which events are late is the finding, not how late

| Event type | n | Median lag | Max lag |
| --- | --- | --- | --- |
| `assistant.turn_start` | 13 | 66 ms | **111 ms** |
| `assistant.message` | 13 | 66 ms | 51,993 ms |
| `user.message` | 1 | 92 ms | 92 ms |
| `tool.execution_start` | 15 | **5,961 ms** | 53,480 ms |
| `tool.execution_complete` | 15 | **5,790 ms** | 53,478 ms |

`assistant.turn_start` is never late because it *is* the flush trigger: it is buffered at prompt
render, and the flush that writes it happens immediately after. Its lag is an artefact of the
mechanism and carries no information about anything else in the file.

Everything buffered since the previous render waits for the next one, and **12 of the 13 batches had
their oldest entry waiting more than a second** (batch size min 3, median 5, max 9). Tool executions
are precisely the entries that wait, because a tool call's duration lands *inside* the batch window.
Those are also exactly the entries an activity feed would show — "reading `foo.ts`", "running tests".

**So a transcript tail runs roughly 5–50 s behind on the events worth displaying.** Finding 1's
"per model round-trip, not per token" is correct about the mechanism and wrong about what it costs:
the granularity is right, the latency is not what "per round-trip" suggests, because a round-trip is
bounded by tool latency rather than by model latency.

### Result 3 — no partial lines were ever observed

Zero fragments, zero fragments-completed, zero malformed lines, across 37 KB and 70 entries at 50 ms
polling. A tailing consumer never saw a half-written line. The harness counts these explicitly, so
the zero is a measurement rather than an absence of checking.

### A retroactive check that looks like a result and is not

Before the live run, the 21 transcripts then on disk were checked for `file mtime - last entry
timestamp`. Twenty of them returned ~0 ms, which reads as excellent and means nothing: 20 of 21 files
end on `assistant.turn_start`, the flush trigger. The single file ending on `tool.execution_complete`
returned **52.3 s**, which is consistent with the live measurement's upper range. Recorded here so the
same trap is not re-entered — a retroactive scan of transcript files cannot measure this, because
nothing on disk records when an append happened relative to the entries inside it.

### What this does not establish

- **Not shown to be a board-driven stage run.** No task file referenced the observed session id three
  minutes after its last append, so this is one agent session, not demonstrably a Kanban Pilot stage.
  The timing evidence stands regardless — the writer does not vary by caller — but the specific
  question "does a stage run started from the board produce a transcript" remains open.
  **Closed on the same day by TASK-011 — see the Confirmation subsection below, which answers it yes
  and adds a constraint on how the tail can be keyed.**
- **The first ~90 lines are unmeasured**, since the watcher joined an already-running session. Only
  appends inside the observation window are in the numbers.
- **One session, one host, one Copilot version.** No claim is made about variance across runs, and a
  run with faster tools would show a shorter batch window.

### Confirmation — a board-started run, observed (TASK-011)

The measurement above was taken from an agent session that no task file ever claimed, so it left the
narrower question open: does a stage started from the Kanban Pilot board produce a transcript, and can
it be found? A refine stage run on TASK-012 was observed end to end on the same day and answers it.

| Time | Event |
| --- | --- |
| `11:29:04Z` | TASK-012 frontmatter goes `status: running` |
| `11:29:11Z` | transcript `session.start` — 7 s later |
| `11:30:00Z` | last transcript entry |
| `11:30:02Z` | `copilot_session_id` written to the task file |

The task file's `copilot_session_id` came out as `1a647f8c-6992-4d9b-bc5a-0f1240e05bb1`, which is
exactly the transcript's filename stem. The header was `version: 1`, `producer: "copilot-agent"`,
Copilot `0.55.0`, VS Code `1.127.0` — so a board-driven run takes the agent path and passes the
compatibility gate. **Source A is confirmed reachable for the runs Kanban Pilot actually starts.**

Three consequences, one of which changes TASK-008's design.

**The id is written too late to key a live tail on.** `copilot_session_id` is harvested from the
turn's terminal result ([executor.ts:424](../../src/chat/executor.ts#L424)), so it landed 2 s after the
run's *last* event and 51 s after its *first*. A tail keyed on that field would have idled through the
whole run and begun reading as it ended. For this 51-second refine that is the entire run; for a long
develop it is the opening minutes. So a first run must be correlated by watching the directory, and
only a *subsequent* run on the same task can key by id — the field is populated by then. Whether a
repeat run reuses the same session id and appends to the same transcript file is **not yet observed**
and is the single cheapest thing that would simplify TASK-008.

**Nothing in the transcript marks it as a Kanban Pilot run.** `session.start`'s `context` was empty,
so correlation is by session id or by timing. There is no board marker to filter on.

**The lag shape reproduced on a second, independent session.** Fifteen entries in three batches of
five, with oldest-entry waits of 10.3 s, 3.0 s and 3.7 s:

| Event type | n | Median lag | Max lag |
| --- | --- | --- | --- |
| `assistant.message` / `turn_start` / `turn_end` | 9 | 61–97 ms | 97 ms |
| `tool.execution_start` | 3 | 3,667 ms | 10,302 ms |
| `tool.execution_complete` | 3 | 3,642 ms | 8,628 ms |

Same bimodal split as the 70-entry session — assistant events immediate, tool events seconds behind.
Two independent sessions agreeing matters more here than the raw sample count.

**Bonus: the two flush cadences were caught diverging.** At `11:29:38Z` the Copilot transcript was 28
entries deep while `chatSessions/1a647f8c….jsonl` did not exist at all; the workbench journal for the
same session appeared later. Findings 1 and 2 were previously separate readings of two writers' code.
This is the difference between them observed on one live session.

#### Still open after this run

- **Only a refine turn was observed** — 45 s, 6 tool calls. A develop run is longer and more
  tool-heavy; the batch structure should be confirmed there rather than assumed to generalise.
- **Session reuse on a repeat run is unobserved**, and it decides whether TASK-008 needs the
  directory-watch path always or only for a task's first run.
- **Non-agent `kanbanPilot.chat.mode` is untested.** The writer is on the agent path and the setting
  defaults to `agent`, so a non-agent mode may produce no transcript at all. If so, TASK-008's opt-in
  has to say so rather than silently showing an empty feed.

### Consequence

This does not overturn the conditional go, but it re-prices step 2 of the recommendation. A tail is
still the best content source available, and it is still honest for an activity feed — a feed that is
seconds behind is a feed. It is **not** suitable for anything that implies liveness: not a progress
indicator that claims to be current, not a "waiting for approval" prompt (a viewer could be told to
act tens of seconds late, or after the moment has passed), and not run-completion detection, which
must keep coming from the receipt.

It also strengthens the case for the ordering already recommended. TASK-007's agent-emitted progress
lines are written by the agent at the moment it acts, so they do not inherit this lag at all — they
are both the cheaper source and the *fresher* one. The transcript tail is the richer source and the
slower one, which is the opposite of how the two were ranked before this measurement.

## Appendix — the read-only probe

[`src/spike/chatTranscriptProbe.ts`](../../src/spike/chatTranscriptProbe.ts) resolves the two candidate
record paths from an extension's own `storageUri`, reports presence, size, and mtime for a given
session id, and reports the Copilot extension's version, declared-proposal count, and exported-API
surface — without activating it. It only ever stats: it reads no transcript bytes, opens no chat, and
submits no turn, and it is not referenced from
[`extension.ts`](../../src/extension.ts). Its test
([`src/test/chatTranscriptProbe.test.ts`](../../src/test/chatTranscriptProbe.test.ts)) runs in the
existing extension-test job.
