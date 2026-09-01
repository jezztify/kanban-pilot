---
id: TASK-005
title: Investigate copilot extension code if we can get the responses and stream it into kanban-pilot
type: feature
state: done
status: idle
position: 1
created: 2026-09-01T09:22:15Z
updated: 2026-09-01T11:24:48Z
scope_hash: 177a521
chat_reset_required: false
---

## Request
Investigate copilot extension code if we can get the responses and stream it into kanban-pilot

## Refined

### Problem statement

Kanban Pilot injects a stage turn through `workbench.action.chat.open<mode>` and then awaits a
single terminal result, from which it harvests exactly one field — `metadata.sessionId`
(`src/chat/executor.ts:411`, `src/chat/executor.ts:423-425`, and the deliberately minimal
`ChatAgentResultish` at `src/chat/executor.ts:229`). Everything the agent actually says between
injection and that result is invisible to the extension. The board detail pane shows frontmatter,
the three markdown sections, and the latest `## Log` receipt; the browser surface shows only the
task snapshot. Even the run's own outcome is learned by re-reading the task file for a receipt, not
by observing the conversation.

This ticket asks whether the Copilot Chat extension itself — its code, its activation exports, its
contributed commands, its persisted session, its logs — offers a way to obtain the response content
and stream it into Kanban Pilot's own surfaces.

Two existing documents bear directly on this and are the baseline rather than something to
re-derive. PRD §6.10 ruled out mirroring the transcript inside the board webview, and
`docs/browser-chat-proxy-spike.md` (2026-08-26) returned no-go on full transcript mirroring for the
browser view with a conditional-go on a coarse, agent-emitted activity feed. Both reasoned from the
VS Code chat *API* surface and the persisted session file. Neither examined the Copilot Chat
extension's own code, which is the specific surface this request names — so neither is invalidated
in advance, and the deliverable must say whether the new surface changes those conclusions or
confirms them.

One more fact shapes the recommendation: that conditional-go is only half-built. The progress-line
grammar shipped in `src/chat/progress.ts`, but `parseProgressEntries` has no caller outside
`src/test/progress.test.ts` — no board projection, no SSE channel, no detail-pane feed. An
already-approved, cheaper answer to "stream the work into Kanban Pilot" is therefore sitting
unfinished, and any recommendation here has to be positioned against it.

This is an investigation. The deliverable is a dated findings document with an explicit go/no-go,
following the convention of `docs/copilot-model-selection-spike.md` and
`docs/browser-chat-proxy-spike.md`. No provider, executor, transport, board, or user-facing
behaviour changes under this ticket.

### Acceptance criteria

- A new `docs/copilot-response-streaming-spike.md` exists, dated, opening with an explicit
  **Go / No-go / Conditional-go** decision line followed by a question-and-boundaries section, in
  the structure the existing spike documents use.
- The document defines what "stream it into kanban-pilot" is being evaluated against, naming the
  concrete destinations — the board detail pane webview, the browser SSE surface served by
  `src/http/realtimeBoardServer.ts`, and run-completion detection in `src/chat/runManager.ts` — and
  states which of them a positive finding would actually serve.
- The baseline is recorded with evidence, not assertion: the open-and-await path, the single field
  harvested from the result, the terminal rather than streaming shape of that result, what the
  detail pane and the browser projection show today, and the fact that the progress grammar is
  parsed nowhere in production code.
- A candidate-source matrix gives each route a verdict of viable, viable-but-fragile, or blocked,
  with the evidence it rests on, covering at least: the Copilot Chat extension's activation exports
  via `vscode.extensions.getExtension('github.copilot-chat')?.exports`; its contributed commands and
  whether any returns response content; its published source; the persisted chat session storage;
  its extension-host log and output files on disk; the chat-session and private chat API proposals;
  and `LanguageModelChat.sendRequest` as a genuinely streaming but non-panel alternative.
- Every unsupported-but-possible path is recorded with its stability and Terms-of-Service or
  marketplace-policy risk, and is not recommended without that risk stated — the same treatment
  `docs/copilot-model-selection-spike.md` gives unsupported paths.
- The document states plainly whether PRD §6.10 and the 2026-08-26 browser spike still hold in light
  of the Copilot-extension-side evidence, and names anything that has changed since.
- A privacy section addresses blast radius: response content projected to the browser rides a
  shared, token-gated, possibly non-loopback endpoint, so the document says what would have to be
  true — opt-in, bounding, redaction — before raw content is allowed onto that channel.
- Provenance and limits of the evidence are explicit: which VS Code build, whether Copilot Chat was
  installed on the investigating host, which Copilot Chat version was examined and how it was
  obtained, and which claims are read from code versus observed in a live turn. Anything that could
  not be established is said so plainly rather than inferred.
- The document ends with a smallest-safe-follow-up plan and a recommendation that explicitly
  compares itself against finishing the already-approved progress-feed slice; any implementation
  work is filed as separate tasks via the proposal flow rather than started here.
- Any probe written to gather evidence is read-only: it inventories or enumerates, opens no chat,
  submits no turn, and consumes no model quota. It is not referenced from `src/extension.ts`, and no
  production source file is modified.

### Assumptions

- Copilot Chat is not installed on this host — 27 extensions present, none matching `copilot`, the
  same condition TASK-001 recorded. Reading "the copilot extension code" therefore means installing
  it or reading its published source; whichever route is taken is recorded along with the exact
  version examined.
- "Responses" means the assistant's message text, its tool-call activity, and turn boundaries.
  Token-level streaming fidelity is the upper bound being tested, not the requirement — a finding
  that only coarse turn-level content is reachable is a legitimate result.
- A finding that holds only for the locally installed VS Code build is recorded as such rather than
  generalised across the `^1.125.0` `engines` range.

## Scope

- Record the current baseline as the document's opening section:
  - Trace and cite the response path: the awaited `executeCommand` at `src/chat/executor.ts:411`,
    the result handling at `src/chat/executor.ts:423-425`, and the `ChatAgentResultish` shape at
    `src/chat/executor.ts:229` — noting that the extension models the result as one optional
    `metadata.sessionId` and nothing else.
  - Record what the two Kanban Pilot surfaces show today: the detail-pane contents described in PRD
    §6.10 ("What the card detail shows"), and the chat-free projection in
    `src/http/realtimeBoardServer.ts`.
  - Record that run outcomes come from receipt reconciliation in `src/chat/runManager.ts`, not from
    the conversation, so nothing downstream currently depends on response content.
  - Record that `parseProgressEntries` in `src/chat/progress.ts` has no production caller, leaving
    the browser spike's conditional-go slice unfinished.
- Investigate the Copilot Chat extension surface, which is the new ground this ticket adds:
  - Confirm whether `github.copilot-chat` is installed on the host; if not, record how its code was
    obtained (marketplace VSIX or published repository) and the exact version examined.
  - Inspect its manifest contributions — commands, chat participants, activation events, and
    declared API proposals — and identify anything that returns, exposes, or streams response
    content.
  - Check whether its activation returns a public API object via
    `vscode.extensions.getExtension('github.copilot-chat')?.exports`, and record the shape found or
    its absence.
  - Record which API proposals it relies on that a marketplace-published extension cannot enable,
    since that boundary decides most of the matrix.
- Re-check the previously assessed routes against the current build rather than citing the old
  verdicts unchanged:
  - Persisted chat session storage — format, location, and flush timing.
  - `workbench.action.chat.export` and its interactive save dialog.
  - Extension-host log and output files written by Copilot Chat, and whether any API can read
    another extension's output channel.
  - Any chat-session provider or private chat participant API that would expose another session's
    turns.
  - For each, state whether the earlier verdict still stands or has changed.
- Evaluate `LanguageModelChat.sendRequest` as the one supported streaming path and state its real
  cost: it is a separate model request, not the panel's turn — no tool approvals, no docked chat, a
  different execution architecture. Say whether it could complement the panel (for example a
  summariser fed by the extension itself) or whether it is a different product, and cross-reference
  the equivalent rows in `docs/claude-chat-spike.md` and `docs/browser-chat-proxy-spike.md`.
- If in-host evidence is required, add a read-only probe following the existing convention:
  - A module under `src/spike/` in the style of `src/spike/chatModelProbe.ts` and
    `src/spike/claudeChatHostProbe.ts` — inventory and enumeration only, activating nothing and
    submitting no turn.
  - A matching test under `src/test/` in the style of `src/test/chatModelProbe.test.ts`, so it runs
    in the existing extension-test job rather than as a manual step.
  - Keep it out of the activation path: it must not be referenced from `src/extension.ts` or any
    run.
- Sketch, on paper only, the delivery shape a positive finding would need, reusing the transport
  reasoning already in `docs/browser-chat-proxy-spike.md` rather than re-deriving it: a separate
  event channel instead of widening the board projection, a bounded feed re-synced on connect, an
  explicit opt-in setting, and the redaction requirement for a shared endpoint.
- Write `docs/copilot-response-streaming-spike.md` following the section shape of
  `docs/copilot-model-selection-spike.md`: dated decision line, question and boundaries, version and
  availability evidence, baseline, findings, source matrix with verdicts, risks, privacy, and the
  smallest-safe-follow-up plan — saying plainly where a question could not be settled.
- Close out without scope creep:
  - Do not implement any streaming, feed, or projection, and do not change `src/chat/executor.ts`,
    `src/chat/runManager.ts`, `src/chat/progress.ts`, `src/board/boardPanel.ts`,
    `src/http/realtimeBoardServer.ts`, or the `package.json` settings under this ticket.
  - File any recommended implementation work — including finishing the progress-feed slice, if that
    is the recommendation — as separate tasks via the proposal flow.
  - Confirm by reviewing the diff that only the new document, an optional read-only probe and its
    test, and this task file were touched.

## Log
- audit:state-change at:2026-09-01T09:23:06Z task:TASK-005 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:r5q8wz task:TASK-005 at:2026-09-01T09:25:28Z note:"reading the existing chat integration and the prior transcript-mirroring spike to scope this investigation"
- run:r5q8wz task:TASK-005 stage:refine result:ok note:"2026-09-01T09:28:25Z — refine completed: scoped a read-only investigation into reading Copilot response content out of the Copilot extension surface and streaming it into the board and browser views, positioned against the earlier transcript-mirroring spike"
- audit:state-change at:2026-09-01T09:30:23Z task:TASK-005 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T09:31:04Z task:TASK-005 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rb7t4m task:TASK-005 at:2026-09-01T09:31:04Z note:"gathering evidence on what the Copilot extension surface exposes about response content"
- progress run:rb7t4m task:TASK-005 at:2026-09-01T09:38:15Z note:"found two on-disk session records and verified every recorded session id resolves to one; writing the findings document"
- propose-task run:rb7t4m type:bug title:"PRD 6.10 states two things about chat access that are no longer true" note:"two of the section's three stated reasons expired with 1.127.0; the conclusion did not"
- propose-task run:rb7t4m type:feature title:"Wire the existing progress-line grammar into the board and browser feed" note:"the approved cheaper slice from the earlier spike is shipped as grammar but wired to nothing"
- propose-task run:rb7t4m type:feature title:"Tail Copilot's session transcript into the activity feed behind an opt-in setting" note:"the richer source, and it depends on the feed channel existing first"
- propose-task run:rb7t4m type:feature title:"Confirm transcript timing by observing one instrumented live Copilot run" note:"closes the one medium-confidence row; timing was read from code, never measured"
- propose-task run:rb7t4m type:feature title:"Design a Copilot hook that pushes run events at Kanban Pilot" note:"the only push-based source, but it writes into the user's repository so it needs its own design"
- run:rb7t4m task:TASK-005 stage:develop result:ok note:"2026-09-01T09:47:12Z — develop completed: wrote docs/copilot-response-streaming-spike.md with a conditional-go recommendation, added a read-only transcript probe and its test, and filed five follow-ups"
- progress run:rq2v8x task:TASK-005 at:2026-09-01T09:54:41Z note:"checking the findings document and probe against each acceptance criterion"
- run:rq2v8x task:TASK-005 stage:validate result:failed note:"2026-09-01T09:55:02Z — validation failed: the source matrix has no row for the Copilot extension contributed commands, and the file-based and hook routes carry stability notes but no Terms-of-Service or marketplace-policy risk statement; every other criterion is met"
- audit:state-change at:2026-09-01T11:24:48Z task:TASK-005 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
