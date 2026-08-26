---
id: TASK-002
title: Browser View: Is it possible to proxy all the chatter in a task's copilot chat into the view?
type: feature
state: done
status: idle
position: 1
created: 2026-08-26T00:02:25Z
updated: 2026-08-26T00:18:33Z
chat: 0157e1eb-9516-43f4-b8fa-7ce612f3a18e
copilot_session_id: 0157e1eb-9516-43f4-b8fa-7ce612f3a18e
scope_hash: 5f822a4
chat_reset_required: false
---

## Request
This is an investigation spike task

## Refined

### Problem statement
The realtime **browser view** (`RealtimeBoardServer` in `src/http/realtimeBoardServer.ts`,
projected through `BrowserBoardSurface` in `src/http/browserBoardSurface.ts`) currently mirrors
only task *frontmatter* over SSE: title, id, type, state/column, status, run id, and
`pendingOutcome`. It shows **nothing** about what the Copilot agent is actually saying while a
task runs. A remote viewer watching the shared endpoint sees a card flip to `running` and later
to `done`/`blocked`, but has zero visibility into the conversation in between.

The user is asking whether the browser view can go further and **proxy the live "chatter"** — the
agent's turn-by-turn messages, tool calls, and confirmations — from a task's Copilot chat into
the browser, so the board becomes a place you can *watch the work happen* remotely rather than
just watch column transitions.

This is deliberately an **investigation spike**. It does not commit to building the feature; it
commits to producing a defensible feasibility answer with evidence. The output is a written
finding (go / no-go / conditional), not shipping code.

### What is already decided (and why this is not a duplicate)
PRD §6.10 ("Why the webview does not mirror the transcript") already ruled out mirroring the
transcript **inside the editor webview**, for three reasons:
- No extension API exposes another participant's session content (`ChatContext.history` is
  self-only).
- The persisted session (`getChatSessionStorageResource(storageRoot, sessionId)`) is an
  internal, undocumented format with no flush-timing guarantee — fragile and laggy to scrape.
- `workbench.action.chat.export` is interactive (save dialog), unusable for continuous mirroring.

Its escape hatch was **"dock the real chat"** — open the actual VS Code chat editor beside the
board (`dockTaskChat()` in `runManager.ts`). That escape hatch **does not exist for the browser
view**: a remote browser cannot open or embed a VS Code chat editor tab. So the question this
spike answers is genuinely open and *specific to the browser surface*: with docking off the
table, is there any viable way to get chat content into a remote browser at all?

### Acceptance criteria
1. A written feasibility finding is delivered (a spike doc under `docs/`, e.g.
   `docs/browser-chat-proxy-spike.md`, following the style of `docs/claude-chat-spike.md`) that
   answers: **can live Copilot chat content be proxied into the browser view — yes, no, or
   conditionally — and under what constraints?**
2. The finding enumerates each candidate data source for chat content, and for each records a
   clear verdict with evidence (API name, file, or doc reference): (a) VS Code chat extension
   API, (b) reading the persisted on-disk chat session storage, (c) `chat.export`, (d)
   instrumenting the agent to append progress lines to the task file, (e) any process-backed /
   alternative-executor route.
3. The finding explicitly addresses the **"breaks when it matters"** concern from PRD §6.10:
   interactive tool-approval / confirmation prompts land the run in `blocked` and are inherently
   local to VS Code — the spike must state whether a browser proxy helps or actively misleads a
   remote viewer at exactly those moments.
4. The finding covers the **transport delta** that would be required if a proxy were viable: how
   chat events would be added to the existing SSE `board` projection / a new event channel, and
   the impact on the outbox/replay model (`OUTBOX_LIMIT`, reconnection) in `realtimeBoardServer.ts`.
5. The finding calls out **security/privacy** implications of pushing raw chat content to a shared
   HTTP endpoint (the endpoint is already a read-only share; chat may contain source, secrets,
   file paths) — see `endpointSharePanel.ts`.
6. A concrete recommendation is given: no-go, or a smallest viable slice (e.g. "structured
   progress lines the agent already could emit, rendered as a lightweight activity feed" vs. "full
   transcript mirror"), scoped tightly enough that a follow-up build card could be filed from it.
7. No production code, executor, transport, or board behavior is changed by this spike (the doc
   may reference code, but the investigation is read-only).

### Out of scope
- Actually implementing a chat proxy, new SSE event type, or webview activity feed.
- Re-litigating the editor-webview decision in PRD §6.10 (accepted as-is; only the browser
  surface is in question).
- Any Claude Code panel driving work (covered by `docs/claude-chat-spike.md`).

### Open questions for the requester (assumptions taken if unanswered)
- "All the chatter" — does the user want the **full transcript** (every token, tool card, code
  block) or a **coarse activity feed** ("agent is editing X", "waiting for approval", "wrote
  receipt")? Assumption: investigate both, recommend the feed as the smallest viable slice since
  full-transcript mirroring is already ruled fragile.
- Is a few-seconds **lag** acceptable, or must it feel live? Assumption: near-real-time is
  desired but not hard real-time; polling-with-lag is acceptable if it is the only viable route.

## Scope
Investigation-only checklist (spike — no production code changes). Work top to bottom; capture
evidence for each into the deliverable doc.

- [ ] Create the deliverable `docs/browser-chat-proxy-spike.md` with sections mirroring the
  acceptance criteria (question/boundaries, candidate-source matrix, transport delta,
  security/privacy, recommendation). Model structure on `docs/claude-chat-spike.md`.
- [ ] Re-read and cite PRD §6.10 (`docs/PRD.md`, "Why the webview does not mirror the
  transcript" and "Instead: dock the real chat") as the baseline decision; state precisely how
  the browser surface differs (no dockable chat editor).
- [ ] Map the current browser data flow end to end: `TaskStore.onDidChange` →
  `RealtimeBoardServer.publish()` → `projection(host)` → SSE `event: board` → `BrowserBoardSurface`.
  Record exactly which task fields are in the projection today (`src/http/realtimeBoardServer.ts`,
  `src/http/browserBoardSurface.ts`, `src/board/boardSurface.ts`) and confirm no chat content is
  present.
- [ ] Candidate source A — **VS Code chat extension API**: verify whether any API can read another
  participant's/session's turns (confirm `ChatContext.history` is self-only; check `vscode.chat`,
  `vscode.lm`, `LanguageModelChat`). Record verdict + evidence.
- [ ] Candidate source B — **persisted on-disk chat session**: locate the storage resource
  (`getChatSessionStorageResource(storageRoot, sessionId)` per PRD; the derived sessionId is
  produced by `src/chat/sessionUri.ts`). Determine: where it lives on disk, its format, whether
  `copilotSessionId`/`chat:` frontmatter maps to a readable file, and flush-timing/lag. State
  whether tailing it from the extension host and forwarding over SSE is technically possible and
  how fragile it is.
- [ ] Candidate source C — **`workbench.action.chat.export`**: confirm it is interactive
  (save dialog) and therefore unusable for continuous mirroring; record.
- [ ] Candidate source D — **agent-emitted progress**: assess extending the receipt/log grammar
  (`src/chat/receipt.ts`, `src/model/taskLog.ts`) so the agent optionally appends structured
  progress lines the board could stream as an activity feed. Note how `RunManager.runStage()`
  re-reads the task file and how a file-watch could surface interim lines before the terminal
  receipt. This is the most likely "smallest viable slice" — evaluate it seriously.
- [ ] Candidate source E — **process-backed / alternative executor**: briefly note whether a
  future non-panel executor (per `docs/claude-chat-spike.md`'s conditional SDK/CLI route) would
  have a readable output stream that could feed the browser, and mark it out of scope for the
  current Copilot-panel design.
- [ ] For any viable source, define the **transport delta**: whether chat events extend the
  existing `board` projection or need a new SSE event (`event: chat`), plus impact on the outbox
  replay model and `OUTBOX_LIMIT` in `src/http/realtimeBoardServer.ts` (a chatty stream could
  blow the 256-message buffer on reconnect).
- [ ] Assess **security/privacy**: the share endpoint is a read-only, potentially unauthenticated
  surface (`src/http/endpointSharePanel.ts`). Document the risk of leaking source, secrets, and
  paths through raw chat content, and any redaction/gating that a real feature would require.
- [ ] Address the **"breaks when it matters"** case: interactive tool-approval/confirmation
  prompts are local VS Code UI and drive the run to `blocked`; state whether a browser proxy
  would help a remote viewer or falsely imply they can act.
- [ ] Write the **recommendation**: no-go, or a tightly-scoped smallest slice (favouring the
  agent-emitted activity feed over full-transcript mirroring), phrased so a follow-up build card
  can be filed directly from it (use a `propose-task` line if a concrete follow-up is warranted).

## Log
- audit:state-change at:2026-08-26T00:02:29Z task:TASK-002 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T00:02:30Z task:TASK-002 from:idle to:running action:refine run:ru5plcr note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T00:02:30Z task:TASK-002 stage:refine action:refine run:ru5plcr note:"Started refine activity."
- run:ru5plcr task:TASK-002 stage:refine result:ok note:"Scoped browser chat-proxy spike; editor-webview mirroring already ruled out in PRD 6.10 but browser can't dock real chat, so candidate-source investigation + activity-feed slice defined as deliverables"
- audit:status-change at:2026-08-26T00:06:31Z task:TASK-002 from:running to:idle action:receipt run:ru5plcr outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T00:06:31Z task:TASK-002 stage:refine action:receipt run:ru5plcr outcome:ok note:"Scoped browser chat-proxy spike; editor-webview mirroring already ruled out in PRD 6.10 but browser can't dock real chat, so candidate-source investigation + activity-feed slice defined as deliverables"
- audit:state-change at:2026-08-26T00:07:25Z task:TASK-002 from:refine to:scoped action:apply-pending run:ru5plcr outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T00:07:30Z task:TASK-002 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T00:07:33Z task:TASK-002 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T00:07:33Z task:TASK-002 from:idle to:running action:develop run:revfa49 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T00:07:33Z task:TASK-002 stage:develop action:develop run:revfa49 note:"Started develop activity."
- propose-task run:revfa49 type:feature title:"Browser activity feed: agent-emitted progress lines over SSE" note:"Build the recommended smallest slice from the spike: progress log grammar + event:chat channel + read-only feed"
- run:revfa49 task:TASK-002 stage:develop result:ok note:"Delivered docs/browser-chat-proxy-spike.md: no-go on full transcript mirror (API blocked, on-disk fragile, export interactive, privacy/approval risks), conditional go on agent-emitted activity feed as smallest slice"
- audit:status-change at:2026-08-26T00:10:02Z task:TASK-002 from:running to:idle action:receipt run:revfa49 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T00:10:02Z task:TASK-002 stage:develop action:receipt run:revfa49 outcome:ok note:"Delivered docs/browser-chat-proxy-spike.md: no-go on full transcript mirror (API blocked, on-disk fragile, export interactive, privacy/approval risks), conditional go on agent-emitted activity feed as smallest slice"
- audit:state-change at:2026-08-26T00:18:31Z task:TASK-002 from:in-progress to:validation action:apply-pending run:revfa49 outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-08-26T00:18:33Z task:TASK-002 from:validation to:done action:move note:"State changed from validation to done via move."
