# Browser-View Chat Proxy Spike

Date: 2026-08-26
Task: TASK-002 — "Browser View: Is it possible to proxy all the chatter in a task's copilot chat into the view?"

Decision: **Conditional go — no-go for full transcript mirroring; conditional go for an
agent-emitted activity feed as the smallest viable slice.**

## Question and boundaries

The realtime **browser view** — the board served over HTTP by
[`RealtimeBoardServer`](../src/http/realtimeBoardServer.ts) and rendered through
[`BrowserBoardSurface`](../src/http/browserBoardSurface.ts) — currently shows a remote viewer only
task *frontmatter* (title, id, type, column, status, run id, `pendingOutcome`). While a task runs,
a remote viewer sees the card flip to `running` and later to `done`/`blocked`, but has **zero
visibility into the conversation in between**.

"Proxy all the chatter" means surfacing the agent's turn-by-turn messages, tool calls, and
confirmations from a task's Copilot chat into the browser, so the board becomes a place you can
*watch the work happen* remotely rather than just watch column transitions.

This is an **investigation spike**. It commits to a defensible feasibility answer with evidence,
not to shipping code. No production code, executor, transport, or board behavior is changed by
this spike; every code reference below is read-only.

### What is deliberately not in scope

| Item | Treatment |
| --- | --- |
| Implementing a chat proxy, a new SSE event, or a webview activity feed | Out. This is a feasibility finding only. |
| The editor-webview mirroring decision (PRD §6.10) | Accepted as-is. Only the **browser** surface is in question here. |
| Claude Code panel driving | Covered by [claude-chat-spike.md](./claude-chat-spike.md). |

## Baseline decision: PRD §6.10

[PRD §6.10](./PRD.md) ("Why the webview does not mirror the transcript") already ruled out
reproducing the chat **inside the editor board webview**, for three reasons:

| Route | Why it fails (per §6.10) |
| --- | --- |
| Extension API | Nothing exposes another participant's session content. `ChatContext.history` gives a participant only *its own* prior turns. |
| Read the persisted session | Sessions persist via `getChatSessionStorageResource(storageRoot, sessionId)`, but under an internal root, in an undocumented format, with no flush-timing guarantee. Scraping it is fragile and laggy. |
| `workbench.action.chat.export` | Opens a `showSaveDialog` — interactive, so unusable for continuous mirroring. |

§6.10's escape hatch is **"dock the real chat"**: the task's actual VS Code chat editor opens
beside the board (`dockTaskChat()` in [runManager.ts](../src/chat/runManager.ts)). It is not a
copy of the chat — it *is* the chat, so interactive tool-approval prompts work in place.

**How the browser surface differs — the crux of this spike.** A remote browser cannot open or
embed a VS Code chat editor tab. The `vscode-chat-session://` editor lives entirely inside the
desktop VS Code workbench; the browser view is a plain HTML document served over HTTP with a
`acquireVsCodeApi` shim (see [browserBoardSurface.ts](../src/http/browserBoardSurface.ts) header).
So the one escape hatch §6.10 relies on is **structurally unavailable** to the browser. The
browser cannot fall back to "the real chat"; whatever it shows about the conversation, it must
carry over the wire itself. That is what makes this question genuinely open for the browser and
not a re-litigation of §6.10.

## Current browser data flow (confirmed read-only)

```
TaskStore mutation
  → host.onDidChange(change)                     (realtimeBoardServer.ts:263)
  → publish(change)                              (realtimeBoardServer.ts:251)
      → projection(host)                         (realtimeBoardServer.ts:203)
          = { revision, activeTaskSet, snapshot }
      → JSON.stringify({ type:'board', change, board })
      → for each live listener: write `event: board\ndata: …\n\n`   (realtimeBoardServer.ts:257–260)
  → browser EventSource on /session/events       (BrowserBoardSurface)
  → same BoardPanel document the editor renders
```

Confirmed facts:

- **The projection carries no chat content.** `projection()` returns only
  `{ revision, activeTaskSet, snapshot }`, where `snapshot` is `host.store.snapshot()` — the task
  frontmatter model. There is no transcript, message, or tool-call field anywhere in it
  ([realtimeBoardServer.ts](../src/http/realtimeBoardServer.ts) lines 203–210).
- **Broadcast is fan-out to a live `Set<ServerResponse>`** with a 20-second heartbeat; there is
  no server-side replay buffer for board events. If a listener is not currently connected it
  simply misses the write (`if (!response.writableEnded)`), and the next `publish()` sends a
  *full* projection, so a reconnecting browser re-syncs from a complete snapshot rather than a
  delta log ([realtimeBoardServer.ts](../src/http/realtimeBoardServer.ts) lines 248–260).
- **`OUTBOX_LIMIT = 256` is client→server, not chat.** It lives in
  [browserBoardSurface.ts](../src/http/browserBoardSurface.ts) (line 7) and bounds the *inbound*
  message outbox — board UI messages the browser posts back to `POST /session/messages` while it
  is between event streams — not any outbound chat stream. A chat feed would not reuse this
  buffer; it would ride the outbound SSE channel, which today has no per-message replay at all.
- **Auth is a shared bearer token.** `tokenMatches()` accepts an `Authorization: Bearer`, a
  `?token=` query parameter, or (for GET resources) a cookie, compared with `timingSafeEqual`
  ([realtimeBoardServer.ts](../src/http/realtimeBoardServer.ts) lines 149–164, 344). The endpoint
  can bind beyond loopback and be fronted by a `publicUrl`, so anyone with the link/token sees
  everything the stream carries.

## Candidate-source matrix

Statuses mean **Viable**, **Viable but fragile**, or **Blocked**.

| # | Source | Verdict | Evidence |
| --- | --- | --- | --- |
| A | VS Code chat extension API | **Blocked** | No API exposes another participant's/session's turns. `ChatContext.history` is self-only (PRD §6.10). `vscode.chat.createChatParticipant`, `vscode.lm.selectChatModels`, and `LanguageModelChat.sendRequest` are *write* paths (register a participant, issue a fresh model request); none reads the Copilot panel's live transcript. The Copilot executor's `blockOnResponse` returns a terminal result, not a message stream ([executor.ts](../src/chat/executor.ts)). |
| B | Persisted on-disk chat session | **Viable but fragile** | The session id is derived by [sessionUri.ts](../src/chat/sessionUri.ts) (`kanban-pilot-[set-]TASK-nnn`, or Copilot's concrete `copilotSessionId` once a prompt has run) and persisted under `getChatSessionStorageResource(storageRoot, sessionId)`. It is reachable from the extension host as a file, but §6.10 already records the format is internal/undocumented with no flush-timing guarantee. A file-watch could tail it and forward deltas over SSE, but the shape is unversioned and can change under us; parsing partially-flushed JSON is racy; and lag is unbounded because flush timing is not ours to control. Structurally possible, operationally brittle. |
| C | `workbench.action.chat.export` | **Blocked** | Opens an interactive `showSaveDialog` (PRD §6.10). It cannot run headless per-tick, so it is unusable for continuous mirroring. |
| D | Agent-emitted progress lines | **Viable** | The agent already writes a structured receipt to the task's `## Log` section — see the grammar in [receipt.ts](../src/chat/receipt.ts) and the audit events in [taskLog.ts](../src/model/taskLog.ts). The same append-only channel could carry optional interim `progress` lines (e.g. `progress run:<id> task:<id> note:"…"`). Because the file is the single source of truth and `RunManager.runStage()` already re-reads it ([runManager.ts](../src/chat/runManager.ts)), a file-watch on the task markdown could surface interim lines *before* the terminal receipt, project them into the SSE stream, and render them as a lightweight activity feed. This is fully within the extension's own contract — no private API, no undocumented format. **This is the smallest viable slice.** |
| E | Process-backed / alternative executor | **Out of scope (future)** | A non-panel executor (the conditional Claude Agent SDK/CLI route noted in [claude-chat-spike.md](./claude-chat-spike.md)) would own its child process and therefore its stdout/stream, which *could* feed the browser directly. But that is a different execution surface from the current Copilot panel and is explicitly out of scope for this design. Noted for completeness only. |

## Transport delta (if a feed were built)

Only source **D** is worth costing, and it is deliberately cheap:

- **Event channel.** A chat/activity feed should be a **new** SSE event
  (`event: chat` / `{ type:'chat', taskId, entries }`) rather than bloating the `board`
  projection. The board projection is re-sent in full on every change; folding a growing
  transcript into it would re-transmit the whole feed on every unrelated card move.
- **Replay on reconnect.** The board channel today has no per-message replay because a full
  snapshot re-syncs a late joiner. A chat feed has the same property *if it is modeled as
  "current feed state for the running task"* — the server can re-read the task file's log tail and
  send the current N entries on `/session/events` connect, exactly like `publish()` sends a full
  board on connect ([realtimeBoardServer.ts](../src/http/realtimeBoardServer.ts) line 424). No new
  buffer, no `OUTBOX_LIMIT`-style bound is needed on the outbound side, provided the feed is
  bounded (e.g. last K progress lines) rather than an unbounded token stream.
- **Why not full transcript.** A token-level transcript *would* need a durable, replayable buffer
  and would re-implement streaming, markdown, code blocks, and tool cards that can only ever lag
  Copilot's own rendering — the exact cost §6.10 rejected. It also has no bounded size, so it
  would pressure any replay buffer. The activity feed sidesteps all of this by being coarse and
  bounded.

## Security and privacy

The endpoint is a **shared, token-gated, potentially non-loopback** surface: `bindAddress` may be
`0.0.0.0`/`::`, a `publicUrl` may front it, and access is a single bearer token shared with anyone
who holds the link ([realtimeBoardServer.ts](../src/http/realtimeBoardServer.ts) lines 88–100,
149–164). The share panel simply renders that URL/QR for distribution
([endpointSharePanel.ts](../src/http/endpointSharePanel.ts)).

Raw chat content is therefore the wrong thing to push here:

- A full transcript can carry **source code, secrets, absolute file paths, tokens, and internal
  URLs** verbatim — everything the agent reads or writes — to every holder of the share link.
- The current projection leaks none of this precisely because it is frozen frontmatter. Any chat
  proxy widens the blast radius of the share token from "board state" to "everything the agent
  said."
- **Mitigation the activity-feed slice gets for free:** the agent authors the progress lines, so
  it can be instructed (via the skill/prompt contract) to write *summaries* ("editing
  `foo.ts`", "running tests", "waiting for approval") rather than raw payloads. A real feature
  would still want an explicit opt-in setting and, ideally, redaction — but source D starts from a
  human-authored, summary-shaped line rather than a raw dump, which is the safer default.

## The "breaks when it matters" case

§6.10's sharpest objection: interactive tool-approval and confirmation prompts are precisely the
moments a run goes `blocked` and needs a human — and they are inherently **local VS Code UI**.

For the browser this is worse than for the editor, because the browser has no dock-the-real-chat
fallback. A proxy that *implies* the remote viewer can act on an approval prompt would be actively
misleading: the remote viewer cannot click "Allow" — that button exists only in the desktop
workbench. So:

- A **full-transcript mirror** is most dangerous here: it would render a live-looking approval
  card that is non-functional remotely, inviting the viewer to wait for or attempt an action they
  cannot perform.
- The **activity feed** is honest by construction: it should surface the `blocked` transition as a
  status line ("⏸ waiting for approval in VS Code — action required at the host") that tells the
  remote viewer the truth — the run needs a human *at the machine*, not in the browser. This maps
  directly onto the existing `status: blocked` / `pendingOutcome` the projection already carries,
  so it reinforces rather than contradicts the current model.

## Recommendation

1. **No-go on mirroring the full Copilot transcript into the browser.** Sources A and C are
   blocked; B is possible but fragile (undocumented format, no flush guarantee, unbounded lag) and
   re-creates the exact fragile streaming/rendering cost §6.10 rejected — and it does so on a
   shared HTTP surface where leaking raw chat content is a real privacy regression. It also breaks
   most at approval time, the moment it would most need to help.

2. **Conditional go on a coarse, agent-emitted activity feed (source D)** as the smallest viable
   slice: extend the append-only `## Log` grammar with an optional `progress` line, watch the task
   file, project a bounded feed as a new `event: chat` SSE channel re-synced on connect, and render
   it as a lightweight read-only feed under the card detail in the browser. It uses only the
   extension's own file contract (no private API, no undocumented storage), is bounded (so no new
   replay buffer or `OUTBOX_LIMIT` pressure), is honest about `blocked`/approval moments, and is
   privacy-safer because the lines are human/agent-authored summaries rather than raw payloads.

A follow-up build card can be filed from item 2. A concrete `propose-task` line is recorded in the
task log for that slice.
