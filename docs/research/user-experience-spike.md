# User Experience Spike

**Task:** TASK-003
**Audit date:** 2026-09-03
**Status:** Decision record and implementation handoff

## Decision summary

Kanban Pilot already has a mature board interaction baseline. The main remaining UX cost is not a missing board primitive; it is uncertainty at boundaries: what a non-idle card needs next, whether activity is current, whether a browser session is still connected, and whether an action is being confirmed in the user's surface.

This record approves five independently actionable follow-ups, in priority order:

1. Make workflow outcomes and recovery next steps visible in the board itself.
2. Make browser-triggered confirmations and operation errors stay in the browser surface.
3. Expose browser connection and reconnect state.
4. Make activity source, freshness, and opt-in state explicit.
5. Add board-local find and filter controls for larger task sets.

The spike makes no production-code or test changes. The follow-up task files are the implementation boundary.

## Persona and contexts

### Primary persona

The assumed primary user is a solo developer using Kanban Pilot as the control surface for durable Markdown task files and Copilot stage runs. They are comfortable with VS Code and task files, but should not need to remember the internal state machine or the provenance of every status message.

### Usage contexts

- **VS Code board:** the default context. The user can open task files and Copilot Chat, sees host notifications, and can use editor-only actions.
- **Browser board:** an optional view shared from the extension host, normally from a trusted LAN or through a configured reverse proxy. It should support board work without pretending to control the user's editor window.
- **Long-lived board:** the user may leave the board open while a run, watcher refresh, transcript flush, or network reconnect happens in the background.
- **Mixed control:** the task file remains authoritative, while the board and browser are projections that can be refreshed or temporarily disconnected.

### Assumptions and open questions

- No product telemetry or user interviews were available. Frequency ratings below are inferred from the interaction model and become more important as task volume or remote use grows.
- The first release target is a single developer, not concurrent multi-user editing or shared approvals.
- Users understand that manual gates are deliberate, but may not know which gate is holding a completed result until the UI tells them.
- Browser users can reach the endpoint and have a valid token. TLS, network trust, and token handling remain deployment concerns rather than UX features.
- The acceptable wording for agent-generated activity and the preferred browser reconnection timeout need product review during implementation.

## Method and evidence standard

The audit used a focused repository walkthrough of the board, transport, workflow, activity, task model, task-set model, tests, and user documentation. Evidence is limited to observable source behavior, existing assertions, and documented contracts. No usability study or live browser session was run during this documentation spike.

A finding is included only when the behavior can be located in the repository or documentation. A recommendation is implementation-ready when it names its affected surface, success signal, acceptance boundary, source areas, test areas, documentation, and design review questions.

## Invariants to retain

Every follow-up must preserve these existing contracts:

- Task Markdown files remain authoritative; the board is a projection.
- The seven-column workflow and explicit manual or automatic gate semantics do not change.
- Illegal actions, stale receipts, wrong-run completions, and invalid parent links remain rejected.
- Each task keeps its own Copilot session binding and named task sets remain isolated.
- Task-store writes remain atomic and append-only logs remain durable.
- Browser clients receive only the existing safe board projection. Prompts, tool arguments, tool results, credentials, and other private Copilot payloads are not added to the remote feed.
- Editor-only actions, especially opening a task file or Copilot Chat, do not silently operate the host on behalf of a browser user.
- Keyboard operation, focus restoration, readable contrast, reduced motion, and accessible names remain first-class requirements.

## Current-state journey map

| Journey | Current path and evidence | What works today | User uncertainty or friction |
| --- | --- | --- | --- |
| Create a task | The New Task form collects title, description, type, parent, and validated image attachments. `TaskStore.create` assigns an id, position, and atomic file contents. | Create errors are returned to the form; parent choices are scoped to the active set; attachment validation is strict. | The user gets little persistent context about the active task set beyond the header picker. A browser-triggered task-set create, rename, delete, or delete-task confirmation can still be owned by the VS Code host rather than the surface where the click happened. |
| Switch and manage task sets | The header renders the active set, New, Rename, and Delete. `TaskSetRegistry` isolates directories and chat bindings and rejects default-set, duplicate-name, non-empty, and active-run violations. | Default protection, empty-set deletion, and active-set isolation are enforced. The active set name is included in the board projection. | The documented running-task lock is enforced at the host boundary rather than explained inline in the board. Errors are surfaced as host notifications for these operations. |
| Select, inspect, and edit a card | Card selection opens a detail dialog. The dialog exposes move, edit, task-file, chat, Task Tree, primary, secondary, pending, stale-recovery, Markdown, latest-log, and activity views as applicable. | Detail and edit preserve scroll/focus through refreshes; edit errors remain in the form; running tasks cannot be edited. | The amount of detail is useful, but the next action is not equally explicit for every blocked, failed, pending, or stale state. Some explanations are title text or generic host guidance. |
| Start and review workflow actions | `primaryAction` maps the current column/status to one action. Manual finishing gates store a pending outcome and expose Apply in detail; automatic gates still honor capacity. | The state machine remains the authority and pending outcomes survive reload. One primary card action keeps the card face compact. | A user scanning a card sees short labels such as `running`, `blocked`, `failed`, or `Review Required` and must open detail, infer the gate, or inspect the log to know why the card is waiting and what to do next. |
| Reorder work | Dragging uses explicit insertion slots. Arrow Up/Arrow Down writes durable positions and announces the resulting position through an `aria-live` region. | Ordering is deterministic, atomic, persisted, and focus-preserving. Reordering is separate from workflow movement. | The mechanics are clear once discovered, but there is no board-level find/filter path when the user knows a task id or title but not its column. |
| Recover blocked or failed work | Blocked cards show a host-guidance message. Failed and idle working-column cards expose the state-machine action. Valid stale completions expose a recovery button and are confirmed before application. | Stale recovery is constrained by exact task, run, stage, receipt, and retry context; no automatic retry is invented. | The recovery path is safe but fragmented across status text, latest log, detail actions, and host confirmation. A user may not know whether to continue, retry, apply a pending completion, or recover an old run. |
| Configure settings | Settings has seven keyboard-navigable categories, validation, reset behavior, agent assignment controls, and explicit reload/apply descriptions. | Gate defaults, setting scope, agent presentation-only behavior, and reload requirements are documented and tested. | Settings is broad and technically accurate. The main remaining opportunity is to connect a setting's effect to the board state that prompted the user to open Settings, rather than adding more controls. |
| Share and reconnect a browser board | `BrowserBoardSurface` carries the same board document through a nonce-protected bridge, authenticated POSTs, an SSE stream, bounded outbox, and refresh-on-reattach. | The endpoint is opt-in, token-gated, resource-root constrained, theme-aware, and resilient to a dropped stream. Editor-only file/chat controls are hidden in browser clients. | The transport retries or refreshes without a visible browser status. A failed action POST can remain queued without telling the user, and an expired session has no board-owned reload affordance. |
| Read activity | Progress lines are durable summaries; hook entries are near-real-time; transcript entries are delayed, bounded, redacted observations. The detail feed merges them by event time. | Privacy opt-ins, bounded buffers, duplicate suppression, task attribution, and scroll retention are implemented. | The rendered detail feed visually distinguishes transcript rows from all other rows, so hook and progress entries look alike. It does not tell the user whether the feed is disabled, waiting for a hook, delayed by transcript flush, or simply empty. |

## Evidence register

| ID | Observable evidence | Why it matters |
| --- | --- | --- |
| E1 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), `primaryAction`, `renderCard`, and `renderBoard` | The card has one primary action, compact status text, column counts, fixed-width columns, and independently scrolling card lists. |
| E2 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), `pendingView`, `appendDetailActions`, and `renderDetail` | Pending outcomes expose a gate label and description, but the card's persistent label is only `Review Required`; detail carries the actual Apply action. |
| E3 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), `renderDetail` | Detail already contains move, edit, file/chat, Task Tree, latest log, activity, blocked guidance, stale recovery, and scroll/focus preservation. Recommendations should clarify this surface rather than duplicate it. |
| E4 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), board layout styles and `renderBoard` | The board uses seven columns, horizontal board scrolling, per-column card scrolling, counts, and scroll restoration. There is no board-level find/filter control in the current header or board script. |
| E5 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts) and [`src/test/boardPanel.test.ts`](../../src/test/boardPanel.test.ts) | Drag slots, durable positions, keyboard reorder messages, live announcements, focus retention, and responsive constraints already have regression coverage. Ordering is not a recommended redesign target. |
| E6 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), `taskTreeFor`, `openTaskTree`, and `renderTaskTreeSidecar` | Task Tree is deterministic, descendants-only, cycle-aware, zoomable, and has an accessible list alternative. The audit treats it as a strength and does not propose replacing it. |
| E7 | [`src/model/taskSets.ts`](../../src/model/taskSets.ts), [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), and [`docs/board-guide.md`](../board-guide.md) | Task-set invariants are enforced by the registry, but BoardPanel still uses `vscode.window.showInputBox` and `showWarningMessage` for task-set operations. The endpoint documentation claims those dialogs are board-rendered, which is a documentation/product discrepancy. |
| E8 | [`src/chat/progress.ts`](../../src/chat/progress.ts), [`src/chat/transcriptTail.ts`](../../src/chat/transcriptTail.ts), and [`src/chat/hookSpool.ts`](../../src/chat/hookSpool.ts) | Activity has three meanings: durable progress, near-real-time hook observations, and delayed transcript observations. Transcript tool events can lag by seconds to a minute; hook data can be absent or opt-in. |
| E9 | [`src/http/browserBoardSurface.ts`](../../src/http/browserBoardSurface.ts), [`src/http/realtimeBoardServer.ts`](../../src/http/realtimeBoardServer.ts), and [`src/test/realtimeBoardServer.test.ts`](../../src/test/realtimeBoardServer.test.ts) | SSE reattach, outbox replay, bounded buffering, and full projection refresh are implemented and tested at the transport layer, but connection state is not rendered by the board. |
| E10 | [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts), `onMessage`, `deleteTask`, stale recovery handling, and [`src/board/actions.ts`](../../src/board/actions.ts) | Browser clicks are delivered to the shared BoardPanel. Several confirmations and errors still call VS Code host notifications, although `deleteTask` already supports a surface-owned confirmation callback. |
| E11 | [`src/test/boardPanel.test.ts`](../../src/test/boardPanel.test.ts), [`src/test/realtimeBoardServer.test.ts`](../../src/test/realtimeBoardServer.test.ts), and [`src/test/realtimeBoardServer.integration.test.ts`](../../src/test/realtimeBoardServer.integration.test.ts) | The baseline covers settings, task creation/editing, ordering, Task Tree, progress projection, HTTP auth, shared board delivery, SSE, reconnect, resources, and revision behavior. The gaps below are targeted UX assertions, not a request to replace the existing suite. |
| E12 | [`docs/configuration.md`](../configuration.md), [`docs/http-endpoint.md`](../http-endpoint.md), [`docs/board-guide.md`](../board-guide.md), and [`docs/PRD.md`](../PRD.md) | User-facing contracts document gate timing, capacity, privacy opt-ins, token security, editor-only limitations, task-set isolation, and recovery invariants. Documentation gaps are called out separately below. |

## Findings

### F1. The state machine is clear to code, but the next user action is not always clear to a person

- **Affected surface:** Board cards, task detail, and manual gate/recovery paths.
- **Evidence:** E1, E2, E3, E12. `primaryAction` is deterministic, but card status is rendered as short words. Pending cards show `Review Required`; the gate description is primarily available through detail button title/ARIA text. Blocked detail uses the generic message that approval or action is required in the VS Code host. Stale recovery is exposed as a separate detail action.
- **User impact:** High. A user can see that work is not moving without knowing whether to stop, continue, apply a pending completion, retry, or ask the host for approval. This increases unnecessary detail openings and the risk of choosing the wrong legal action.
- **Likely cause:** The compact card-face rule and the desire to keep the state machine authoritative leave explanatory context split between status labels, tooltips, latest log text, and detail actions.
- **Confidence:** High. The behavior is directly observable in the view construction and existing tests.
- **Severity:** High for manual-gate, blocked, failed, and stale states; low for ordinary idle cards.

### F2. Activity is carefully redacted and bounded, but its provenance and freshness are under-explained

- **Affected surface:** Task detail activity feed and the `chat.*Feed` settings.
- **Evidence:** E8 and E3. Progress, hook, and transcript entries are merged into one feed. `renderDetail` gives transcript rows a distinct class but maps hook rows to the same visual category as progress rows. Transcript entries are delayed observations, while hook entries can be absent and both feeds require opt-in.
- **User impact:** Medium-high. A user may treat an old transcript row as live state, or read an empty feed as evidence that a run is idle when the feed is disabled or hooks are not installed.
- **Likely cause:** The data model preserves source and safety boundaries, but the presentation intentionally reduces several safe sources to a compact row shape without exposing the reason for absence or delay.
- **Confidence:** High. Source types, delay notes, and the rendering branch are explicit.
- **Severity:** Medium-high, especially during a long run or remote observation.

### F3. Browser reconnect behavior is resilient but invisible

- **Affected surface:** Browser board transport and browser action feedback.
- **Evidence:** E9. The bridge opens an EventSource, retries queued POSTs after a fixed delay, and the server refreshes a projection when a stream reattaches. There is no browser-owned `open`, `error`, `reconnecting`, queue, or session-expired state rendered in the board document.
- **User impact:** High for remote users. A disconnected browser can look current while actions wait in an outbox or while the session has expired. The user cannot distinguish a slow run from a disconnected view.
- **Likely cause:** Transport reliability was implemented first, while the bridge has no presentation channel for connection state and the shared board protocol has no status model.
- **Confidence:** High. The retry and reattach behavior is directly visible; the absence of UI state is visible in the bridge and board script.
- **Severity:** High for any remote workflow that depends on timely feedback; low for editor-only use.

### F4. Several browser actions still ask the VS Code host to own the confirmation

- **Affected surface:** Browser task-set management, delete-task flow, stale-completion recovery, and operation errors.
- **Evidence:** E7 and E10. BoardPanel handles task-set create/rename/delete through `vscode.window.showInputBox` or `showWarningMessage`; delete-task and stale-recovery paths also use host notifications. `BrowserBoardSurface.hostEditor` hides file/chat actions, but does not change these confirmation paths. `docs/http-endpoint.md` says these dialogs are rendered by the board itself, which does not match the current handler code.
- **User impact:** High. A browser user can click a control and wait for a dialog they cannot see or interact with in the browser. Errors likewise appear in the editor host, breaking the expectation that the shared board is an operable surface.
- **Likely cause:** BoardPanel's shared action handler still uses the editor's default confirmation functions instead of selecting a `BoardSurface`-owned dialog/error path. The existing injectable confirmation parameter in `deleteTask` shows the intended boundary but is not used here.
- **Confidence:** High. This is a concrete cross-surface control-flow mismatch, not an inferred usability preference.
- **Severity:** High for browser parity and medium for editor users.

### F5. Board scanning works for a small set, but locating known work scales poorly

- **Affected surface:** Board header and seven-column board.
- **Evidence:** E1, E4, and E5. The board exposes column counts, card ids, titles, type/provenance badges, durable ordering, and scroll restoration. It has horizontal board scrolling and independent vertical column scrolling, but no text find, status filter, type filter, or board-level focus-to-task path.
- **User impact:** Medium-high as a task set grows. A user who knows `TASK-123` or part of a title must scan columns and scrollports manually before opening detail.
- **Likely cause:** The board was optimized around direct card manipulation and compact columns; discovery was left to the task-set picker or file search.
- **Confidence:** Medium-high. The absence of the control is directly observable, while frequency depends on task volume.
- **Severity:** Medium for a small board, high for a long-lived task set.

### F6. Task-set constraints are correct but not always discoverable at the point of action

- **Affected surface:** Task-set picker and New/Rename/Delete controls.
- **Evidence:** E7 and E12. Default and non-empty protections are enforced, and the documentation explains that switching or creating while a task is running is disallowed. The board disables Rename/Delete for the Default set, but does not expose an equivalent inline reason for the active-run lock; failed operations fall back to host error notifications.
- **User impact:** Medium. A user can interpret a disabled or rejected operation as a board failure rather than a deliberate isolation rule.
- **Likely cause:** Business constraints live in `TaskSetRegistry` and host error handling rather than in the control state or an inline status region.
- **Confidence:** High for the current control behavior; medium for frequency.
- **Severity:** Medium. This is a candidate detail for R1/R2 rather than a separate first implementation slice.

## Existing strengths and non-findings

The audit deliberately does not treat the following as missing features:

- **Accessibility baseline:** Cards have semantic names and keyboard selection; reorder outcomes use a live region; settings use tabs and roving tab index; dialogs label controls and restore focus. These are covered by `src/test/boardPanel.test.ts` assertions.
- **Ordering:** Explicit drop slots, durable positions, stale-target handling, and atomic normalization already address both pointer and keyboard workflows.
- **Task Tree:** The sidecar has zoom/pan controls, an accessible list alternative, deterministic descendant projection, and focus restoration. It should receive regression coverage when adjacent detail work changes it, not a redesign from this spike.
- **Settings coverage:** Settings categories, validation, reset behavior, agent fallback semantics, and reload notices are already present. The recommendation is to make consequences easier to understand, not to add a second settings system.
- **Data integrity:** `TaskStore` serializes mutations, writes atomically, preserves unknown body sections, validates attachments, normalizes invalid relationships, and keeps task sets isolated.
- **Security and privacy:** The endpoint is opt-in and token-gated; resource roots are constrained; browser CSP and theme bootstrap are tested; remote transcript visibility has a separate opt-in; transcript and hook projections omit private payloads.

## Prioritization

Scores use a five-point heuristic: higher is more user impact, frequency, or confidence; higher effort and risk are costs. Frequency is a proxy because this repository has no product telemetry. The ranking is a decision aid, not a product KPI.

| Rank | Improvement | Impact | Frequency | Confidence | Effort | Risk | Decision |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1 | Contextual next-action and recovery guidance | 5 | 4 | 5 | 2 | 2 | Approve |
| 2 | Browser-owned confirmations and operation errors | 5 | 3 | 5 | 3 | 4 | Approve |
| 3 | Browser connection and reconnect status | 5 | 3 | 5 | 3 | 4 | Approve |
| 4 | Activity provenance and freshness cues | 4 | 3 | 5 | 3 | 3 | Approve |
| 5 | Board-local find and filter | 4 | 3 | 4 | 4 | 3 | Approve |

The two browser recommendations are separate because a surface-owned dialog can be correct even when the stream is healthy, while connection state can be correct even before every action has browser-native confirmation. Activity provenance is separate because it affects both editor and browser feeds. Find/filter is intentionally last: it is valuable for scale, but it should not destabilize the existing card, ordering, or workflow model.

## Approved recommendations

### R1. Make workflow outcomes and recovery next steps visible

**Expected user outcome:** From the card or detail view, the user can answer three questions without inspecting raw task Markdown: What happened? Is a gate or host action holding it? What is the next legal action?

**Implementation boundary:** Extend the board projection and presentation with concise, persistent next-step context for `running`, `blocked`, `failed`, `pending`, and stale-completion states. Keep the existing primary action and state-machine legality. Prefer visible text or an expandable explanation over tooltip-only detail. Use the existing `pending/apply` and `stale/recover` messages; add an error/status message only if the current handler cannot explain a rejected action.

**Affected source areas:**

- [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts): `primaryAction`, `pendingView`, `renderCard`, `appendDetailActions`, `renderDetail`, and the task view projection.
- [`src/board/stateMachine.ts`](../../src/board/stateMachine.ts): read-only contract check; no semantic changes expected.
- [`src/chat/runManager.ts`](../../src/chat/runManager.ts): only if an existing outcome or recovery reason is not available in the view projection.

**UI states and messages:** `running`, `blocked`, `failed`, manual-gate pending completion, stale completion candidate, active-run conflict, and a no-op or stale action response. The wording should distinguish `review`, `retry/continue`, `stop`, `recover`, and `host approval`.

**Success signal:** A fixture containing every listed state has a visible explanation and next action in the card or detail without requiring a hover. Focused tests assert the text and accessible name for each state, and no new action is offered when the state machine would reject it.

**Acceptance boundary:** Do not change column transitions, automatic-gate defaults, retry policy, receipt reconciliation, task-file ownership, or chat routing. A presentation-only view-field change must remain backward compatible with an older browser document where practical.

**Dependencies and risks:** Wording must reflect exact state-machine legality; stale and pending context must not imply that an old run can overwrite a newer run. Avoid making the card face too dense or duplicating the full latest log.

**Focused tests:** Add targeted `src/test/boardPanel.test.ts` assertions for card/detail output and action labels; reuse `src/test/runManager.test.ts` or `src/test/stateMachine.test.ts` only for any view-contract edge cases discovered during implementation. Do not rewrite valid state-machine tests.

**Documentation:** Update [`docs/board-guide.md`](../board-guide.md) and the manual-gate sections of [`docs/configuration.md`](../configuration.md) with the visible distinction between pending review, retryable failure, blocked host action, and stale recovery.

**Design and accessibility review:** Confirm reading order, text wrapping at narrow widths, focus order after applying or recovering, status semantics for live updates, and a non-color explanation for every state.

**Follow-up task:** Follow-up A, to be filed in the active task set.

### R2. Keep browser confirmations and operation errors in the browser surface

**Expected user outcome:** A browser user can complete or cancel any board-owned confirmation from the browser tab that initiated it and sees validation or operation failure in that same surface.

**Implementation boundary:** Route board-owned dialogs and errors through the shared `BoardSurface` boundary. Cover task-set create/rename/delete, delete-task confirmation, stale-completion recovery confirmation, and their failures. Keep editor-only file/chat actions hidden and preserve the existing VS Code command-palette behavior. The browser must not receive private host notifications or a second task model.

**Affected source areas:**

- [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts): message handlers and board-owned modal/error protocol.
- [`src/board/actions.ts`](../../src/board/actions.ts): use the existing injectable confirmation boundary for delete where appropriate.
- [`src/board/boardSurface.ts`](../../src/board/boardSurface.ts): shared surface capabilities or message delivery, if required.
- [`src/http/browserBoardSurface.ts`](../../src/http/browserBoardSurface.ts): browser bridge delivery only; do not duplicate board rendering.

**UI states and messages:** open/submit/cancel/error for task-set name entry; destructive confirmation; stale-recovery confirmation; task deletion; expired or rejected browser action. The originating editor and browser clients must each receive their own dialog state.

**Success signal:** A browser integration test can create, rename, reject, and delete a task set, delete a task, and confirm/cancel stale recovery without a VS Code input or warning prompt. Every rejected operation produces a visible browser message and leaves the authoritative task files unchanged.

**Acceptance boundary:** Do not weaken Default/non-empty/active-run protections, confirmation requirements, authentication, resource-root security, or task-store atomicity. Do not mirror Copilot payloads or expose the host editor through a browser action.

**Dependencies and risks:** The shared protocol needs correlation for a dialog response so two browser sessions cannot answer each other's prompt. Browser and editor sessions must remain isolated. The existing endpoint documentation must be corrected only after behavior and tests agree.

**Focused tests:** Extend `src/test/boardPanel.test.ts` for surface-specific dialog routing and `src/test/realtimeBoardServer.integration.test.ts` for browser confirmation/error flows. Add focused `src/test/actions.test.ts` only if the current test layout introduces a new action helper; otherwise keep coverage at the board and integration boundaries.

**Documentation:** Reconcile [`docs/http-endpoint.md`](../http-endpoint.md) with the actual dialog ownership and describe which actions are board-owned versus editor-only. Add the browser limitations to [`docs/board-guide.md`](../board-guide.md).

**Design and accessibility review:** Dialog focus trap, Escape/cancel behavior, destructive-action wording, screen-reader announcement of errors, mobile viewport fit, and per-session isolation.

**Follow-up task:** Follow-up B, to be filed in the active task set.

### R3. Expose browser connection and reconnect status

**Expected user outcome:** A browser user can tell whether the board is connected, reconnecting, waiting to resend an action, or needs a full reload because the session expired.

**Implementation boundary:** Add a small browser-visible connection status channel to the existing bridge and board document. Reflect EventSource open/error/reattach, queued POST retry, and expired-session states. Keep the current outbox, bounded buffering, revision ordering, and refresh-on-reattach behavior as the transport contract. Editor surfaces may omit the indicator or render it unobtrusively.

**Affected source areas:**

- [`src/http/browserBoardSurface.ts`](../../src/http/browserBoardSurface.ts): connection and outbound queue signals.
- [`src/http/realtimeBoardServer.ts`](../../src/http/realtimeBoardServer.ts): session-expired and stream lifecycle responses, if a new status needs a server signal.
- [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts): status region and reload affordance in the shared document.
- [`src/board/boardSurface.ts`](../../src/board/boardSurface.ts): optional capability boundary for browser-only status.

**UI states and messages:** `connecting`, `connected`, `reconnecting`, `action queued`, `action failed`, and `session expired; reload`. The status must not imply that a Copilot run has stopped merely because the browser stream is down.

**Success signal:** Deterministic transport tests cause each connection state and assert a visible, accessible status. A reconnect replays or refreshes without duplicate action submission; an expired session offers reload instead of leaving a silent stale board. No private token is copied into visible status text or logs.

**Acceptance boundary:** Keep token authentication, CSP, bounded outbox size, SSE heartbeat, session grace period, monotonic revisions, and full authoritative refresh on reattach. Do not turn the browser into a second source of truth or add a polling backend.

**Dependencies and risks:** The status channel must not create noisy board renders or reveal endpoint credentials. Reconnect wording and retry timing need a short product/design decision. Browser tests may need a small fake EventSource or Playwright smoke harness.

**Focused tests:** Extend `src/test/realtimeBoardServer.test.ts` for surface status signaling and `src/test/realtimeBoardServer.integration.test.ts` for stream close, reconnect, queued action, and expired-session behavior. Add a board DOM assertion in `src/test/boardPanel.test.ts` for accessible status placement.

**Documentation:** Update [`docs/http-endpoint.md`](../http-endpoint.md) with reconnect behavior and the meaning of the status indicator; cross-link the browser limitations from [`docs/board-guide.md`](../board-guide.md).

**Design and accessibility review:** Status placement without stealing focus, `role="status"` or alert severity, reduced motion for reconnect indicators, mobile header wrapping, and language that separates transport health from workflow state.

**Follow-up task:** Follow-up C, to be filed in the active task set.

### R4. Make activity provenance and freshness explicit

**Expected user outcome:** A user can tell whether a row is an agent-authored progress summary, a live hook observation, or a delayed transcript observation, and can tell why activity is absent or behind.

**Implementation boundary:** Preserve the current safe merged feed and add source/freshness metadata to its presentation. Distinguish progress, hook, and transcript rows; show an unobtrusive feed state for disabled, not configured, delayed, and empty conditions. Keep transcript and remote opt-ins separate and retain the current redaction boundary.

**Affected source areas:**

- [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts): feed view data, source labels, empty-state copy, and detail rendering.
- [`src/chat/transcriptTail.ts`](../../src/chat/transcriptTail.ts): verified delay/source metadata only; no broader transcript parsing.
- [`src/chat/hookSpool.ts`](../../src/chat/hookSpool.ts): hook availability/change metadata only if needed.
- [`src/chat/progress.ts`](../../src/chat/progress.ts): progress remains durable and non-terminal.

**UI states and messages:** feed disabled by setting; transcript enabled but delayed; hook feed not configured; no entries yet; live hook row; durable progress row; delayed transcript row; remote activity withheld by opt-in.

**Success signal:** A fixture with one row from each source renders three distinguishable, accessible source labels and correct timestamps. Empty states explain the relevant configuration or delay without exposing raw payloads. Existing scroll retention and duplicate suppression continue to pass.

**Acceptance boundary:** Do not expose tool arguments, tool results, credentials, prompts, or unbounded transcript content. Do not treat activity as a terminal receipt or use it to change task state. Do not make remote transcript visibility implicit.

**Dependencies and risks:** The wording must avoid promising real-time transcript data. Source labels should remain readable in a narrow modal and should not turn every row into a dense diagnostic panel.

**Focused tests:** Extend `src/test/boardPanel.test.ts` for source-specific rendering and empty states; extend `src/test/transcriptTail.test.ts` and `src/test/hookSpool.test.ts` only for metadata needed by the view; retain `src/test/realtimeBoardServer.integration.test.ts` coverage for remote opt-in and progress delivery.

**Documentation:** Clarify delay and source semantics in [`docs/configuration.md`](../configuration.md), [`docs/board-guide.md`](../board-guide.md), and [`docs/copilot-hook-feed.md`](../copilot-hook-feed.md). Keep the privacy statements in [`docs/http-endpoint.md`](../http-endpoint.md) aligned.

**Design and accessibility review:** Source labels must not rely on color alone; timestamps need readable date/time context; live status must be polite and non-interruptive; long notes and narrow layouts must continue to wrap safely.

**Follow-up task:** Follow-up D, to be filed in the active task set.

### R5. Add board-local find and filter controls

**Expected user outcome:** A user who knows a task id, title fragment, type, status, or relationship can locate matching cards without scanning every column or changing the active task set.

**Implementation boundary:** Add a board-local, client-side find/filter control over the current snapshot. Match task id and title at minimum; type/status and parent/child filters may be included if they remain compact. Show the active result count and a clear action. Preserve card order, column counts or clearly label filtered counts, selection, detail state, and canonical snapshot data.

**Affected source areas:**

- [`src/board/boardPanel.ts`](../../src/board/boardPanel.ts): header control, client-side filter state, card rendering, empty/no-match states, keyboard focus, and responsive layout.
- [`src/test/boardPanel.test.ts`](../../src/test/boardPanel.test.ts): filtering, clearing, keyboard operation, and responsive markup assertions.

**UI states and messages:** no filter; matching filter; no matches; selected card hidden by filter; filter cleared after task-set switch; filtered board while a live update arrives.

**Success signal:** A query matching one known id or title reduces the visible cards across columns, exposes the result count, and can be cleared with keyboard and pointer input. An empty result is explained, and clearing restores the exact authoritative ordering and card set.

**Acceptance boundary:** Keep filtering local to the board projection. Do not delete, reorder, move, or mutate task files; do not change task-set selection; do not hide a running or blocked state without an explicit filtered-result cue. Avoid a server-side search index in this slice.

**Dependencies and risks:** The board header is already dense and responsive. Filtered column counts must not be mistaken for authoritative task totals; task-set refreshes and selected-detail preservation need explicit behavior.

**Focused tests:** Extend `src/test/boardPanel.test.ts` with DOM/script assertions for matching, no-match, clear, task-set switch, live refresh, keyboard focus, and narrow viewport layout. A browser integration smoke test should confirm the control is available in the shared document.

**Documentation:** Add the find/filter behavior and count semantics to [`docs/board-guide.md`](../board-guide.md). No configuration setting is needed for the first slice.

**Design and accessibility review:** Labelled search input, clear button, keyboard shortcut discoverability without instructional clutter, live result count announcements, focus behavior when a selected card becomes hidden, and header wrapping below 620px.

**Follow-up task:** Follow-up E, to be filed in the active task set.

## Documentation gaps and corrections

These are separate from product findings and should be handled with the relevant follow-up:

1. [`docs/http-endpoint.md`](../http-endpoint.md) states that new/rename/delete task-set, delete-task, and stale-recovery dialogs are rendered by the board, while the current BoardPanel handlers still call VS Code host dialogs for those paths. R2 must first establish the intended behavior, then update the statement.
2. [`docs/configuration.md`](../configuration.md) calls transcript activity delayed but does not give the observed seconds-to-minute lag or explain how hook activity differs. R4 should make this operationally useful without exposing implementation payloads.
3. [`docs/board-guide.md`](../board-guide.md) accurately documents task-set isolation, gate review, ordering, and recovery, but it does not give users a compact explanation of what `Review Required`, `blocked`, and `failed` mean at the point of use. R1 should add that explanation after the UI wording is settled.
4. Browser limitations are documented for opening files and Chat, but confirmation ownership and connection state are not described as user-visible browser behavior. R2 and R3 should close that gap.

## Follow-up task filing plan

Five independent follow-up tasks will be created in the active named task set directory:

- **Follow-up A:** Make workflow outcomes and recovery next steps visible.
- **Follow-up B:** Keep browser confirmations and operation errors in the browser surface.
- **Follow-up C:** Expose browser connection and reconnect status.
- **Follow-up D:** Make activity provenance and freshness explicit.
- **Follow-up E:** Add board-local find and filter controls.

Each task will inherit the Feature type, start in `backlog`/`idle`, identify TASK-003 and run `rroucoq` as its origin, and include the corresponding recommendation as its Request. The task files will name the source, test, documentation, and design areas above; implementation must preserve the invariants in this record.

## Scope closure

- This record is the evidence log and decision artifact for TASK-003.
- The approved implementation work is limited to the five follow-up boundaries above.
- No production source or test file is changed by this spike.
- The current task's Develop receipt is appended only after the research index and follow-up task files are complete and the Markdown/task artifacts pass validation.
