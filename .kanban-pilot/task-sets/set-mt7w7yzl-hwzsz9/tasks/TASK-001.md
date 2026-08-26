---
id: TASK-001
title: Remote access to the board and the LLM chat.
type: feature
state: done
status: idle
position: 0
created: 2026-08-24T23:56:21Z
updated: 2026-08-26T00:00:46Z
chat: 05605897-c12b-42f6-874f-6cfb4e7472de
copilot_session_id: 05605897-c12b-42f6-874f-6cfb4e7472de
scope_hash: 654f6e6
chat_reset_required: false
---

## Request
I want to be able to remotely access the kanban board and the LLM chat that implements the kanban tasks.

## Refined

### Sharpened problem statement

Kanban Pilot currently depends on the local VS Code window: the board is a VS Code webview,
the task conversation is the real task-scoped Copilot Chat editor, and `RunManager` executes
against the workspace hosting the extension. A developer who is away from that window cannot
monitor the pipeline, operate board actions, or answer a Copilot question when a run becomes
blocked. The feature must provide a supported remote entry point to that same workspace without
creating a second task store, weakening one-chat-per-task isolation, or replacing the real chat
with a stale transcript mirror. It must also behave as one live system: filesystem changes, agent
run lifecycle changes, settings changes, and actions from any supported view must propagate to the
other views and converge on the same active-task-set state without requiring a manual reload.

### Proposed interpretation and boundaries

- For this ticket, remote access means one authenticated operator connecting to the host VS Code
	workspace through VS Code Remote Tunnels (using a supported VS Code desktop or browser client).
	The host remains responsible for the extension host, task files, Copilot sign-in, and agent
	execution.
- The remote operator must use the existing board projection and the actual Copilot Chat editor,
	including follow-up questions, tool approvals, and model controls where the remote client
	supports them. The task's existing session binding and filesystem receipt protocol remain the
	source of truth.
- A standalone public web/mobile application, a new unauthenticated HTTP listener, multi-user
	collaboration, transcript scraping, and headless or remote execution on a separate worker
	are out of scope. The existing PRD non-goal for remote/headless execution remains distinct
	from remote access to the host VS Code session.
- If the intended client is a standalone browser or mobile app rather than a VS Code Remote
	Tunnel client, this ticket must be re-refined or split: the current supported APIs do not
	expose another task's Copilot transcript or provide a supported session-targeted chat command.

### Real-time consistency requirement

- The host filesystem and extension-managed configuration remain authoritative. Real-time means
	event-driven refresh after the host observes a change, normally visible within one second under
	healthy local and tunnel conditions; it does not require a second mutable client-side store.
- The board card face, task detail modal, settings surface, task-set picker, run/progress display,
	and the real task chat must refer to the same active task set and task identity. The board shows
	durable task and run state; it must not attempt to mirror or cache the Copilot transcript.
- Changes made by the agent, a local editor, a remote editor, a board action, a receipt or timeout,
	an attachment mutation, or a settings change must refresh every supported open board surface.
	Reconnect or webview restoration must request a complete current snapshot rather than resume from
	stale client state.
- Concurrent or repeated view requests must be serialized or rejected by the host's existing
	validation and mutation paths. Out-of-order refresh messages must never let an older snapshot
	overwrite a newer one; deleted or moved tasks must also clear or update any open detail view.
- A network disconnect or unavailable event stream must be visible as stale/disconnected state,
	must not fabricate success, and must be followed by a full resynchronization before actions are
	presented as current again.

### Acceptance criteria

1. The supported remote topology, client versions, authentication prerequisites, host-side
	 execution model, and limitations are documented; setup does not require exposing a new public
	 port or storing credentials in the extension.
2. From the supported remote client, Kanban Pilot activates in the host workspace and opens the
	 same active task set. The board renders its current columns, cards, statuses, details, and
	 settings, and reflects filesystem changes after reconnecting without creating a second board
	 state or task set.
3. The remote operator can perform the existing valid board interactions (create/edit/select,
	 task-set operations, reorder/move, settings, and state-machine actions including Refine,
	 Split, Develop, Continue, Stop, Validate, pending-outcome handling, recovery, Reopen, and
	 task deletion). Requests are validated by the extension host and use the same mutation,
	 gate, receipt, and audit paths as local interactions.
4. Opening a task chat remotely shows that task's real private Copilot conversation, and a
	 remote operator can send a follow-up, answer a blocked run, or approve a tool when the
	 supported client permits it. Refine, Develop, Continue, and Validate still inject into the
	 correct task session; no task's chat or receipt can be addressed through another task's id.
5. Agent execution, Markdown writes, attachments, receipts, run capacity, and reconciliation
	 remain on the host workspace. A disconnect or client reload does not duplicate a run or lose
	 durable task state; an in-flight run follows the existing activation-reconciliation behavior.
6. Unsupported client capabilities, unavailable Copilot commands, or a missing remote workspace
	 are reported with a clear actionable message and never silently mutate task state. Remote
	 access does not bypass existing gates, permissions, session-isolation checks, or file safety
	 rules.
7. Automated compatibility tests and a documented end-to-end remote smoke check cover board load,
	 live refresh/reconnect, a representative gated action, a blocked-chat response, and correct
	 task-session routing. The normal local build and test suite continue to pass.
8. Under healthy local and tunnel conditions, changes observed on the host are reflected in every
	supported open board view, card/detail surface, settings/task-set surface, and run-status
	display without a manual reload, normally within one second. Board and detail data for the
	same task agree after each refresh, and a chat/run outcome is reflected in the board without
	duplicating or mirroring the transcript.
9. Refresh delivery is ordered and recoverable: stale or out-of-order snapshots cannot overwrite
	newer state, concurrent requests cannot create duplicate tasks or runs, and reconnecting or
	restoring a view performs a full active-task-set resync. If the host or transport is unavailable,
	the UI shows an actionable stale/disconnected indication and does not present stale data as
	confirmed current state.

## Scope

- **Clarify and record the product contract in `docs/PRD.md`:** distinguish remote access to the
	host VS Code session from remote/headless execution; document the chosen Remote Tunnel
	topology, supported clients, authentication/trust boundary, chat limitations, reconnect
	behavior, and the security and failure model. Add the feature to the appropriate goal,
	architecture, risk, and milestone sections without weakening the existing no-transcript-mirror
	and per-task-session guarantees.
- **Document operator setup in `README.md`:** prerequisites for the host and remote client,
	tunnel connection steps, how to open the board and a task's real chat remotely, what remains
	host-side, supported/unsupported clients, and troubleshooting for missing Copilot commands or
	a disconnected workspace.
- **Audit and adapt activation/lifecycle in `src/extension.ts`:** detect the remote workspace/UI
	capability, keep one `WorkspaceTaskSetContext` per remote workspace, dispose it cleanly on
	disconnect/deactivation, and surface actionable diagnostics instead of starting a partially
	working remote experience. Update `package.json` only where manifest metadata or the supported
	VS Code engine range is required by the verified remote host/client matrix.
- **Preserve the board contract in `src/board/boardPanel.ts` and
	`src/board/mermaidWebview.ts`:** verify that panel creation/restoration, webview resource
	roots, CSP, local bundled assets, attachment rendering, task-set switching, and the existing
	message protocol work through the remote client. Keep the webview as a projection; route all
	remote intents through the host validators and existing `RunManager`/store paths rather than
	adding client-side authoritative state.
- **Build one real-time synchronization path across `src/extension.ts`,
	`src/model/taskStore.ts`, and `src/board/boardPanel.ts`:** normalize file, attachment,
	configuration, task-set, run-lifecycle, receipt, timeout, and reconnect changes into an
	event-driven refresh stream for the active set; coalesce filesystem bursts; read the
	authoritative state after atomic writes settle; and attach a monotonic revision or equivalent
	freshness guard to snapshots sent to each supported view.
- **Make all board surfaces refresh as one consistent snapshot in `src/board/boardPanel.ts`:**
	serialize/coalesce `pushAll` work so board cards, selected-task details, settings, task-set
	controls, and run/progress indicators cannot be populated from different filesystem revisions.
	Preserve a valid selection across refreshes, clear it when its task is deleted or its set is
	changed, ignore stale/out-of-order responses in the webview, and force a complete refresh on
	`board/ready`, panel restoration, visibility changes, and remote reconnect.
- **Expose run-state changes from `src/chat/runManager.ts` to the board without making the
	webview authoritative:** publish start, stop, blocked/failed, receipt, pending-outcome,
	promotion, timeout, and completion changes through the same refresh coordinator. Update elapsed
	progress on a bounded cadence for display only; derive state, status, run id, and receipts from
	the latest host snapshot. Ensure late results and duplicate/replayed events remain protected by
	the existing run and task-set guards.
- **Harden asynchronous rendering in `src/board/mermaidWebview.ts` and the board detail path:**
	ensure a diagram or detail render started for an older task/snapshot cannot mutate a newer
	selection, and retain safe local-resource/CSP behavior after repeated refreshes and reconnects.
- **Make task-chat routing explicitly remote-compatible in `src/chat/executor.ts` and
	`src/chat/sessionUri.ts`:** feature-detect the required VS Code chat commands and session URI
	support in the remote client, retain deterministic set/task session binding, preserve the
	narrow open-and-inject protocol, and give a clear fallback/error when the real chat cannot be
	opened. Do not scrape, cache, or re-render Copilot transcripts and do not introduce a second
	chat backend.
- **Verify run and persistence behavior in `src/chat/runManager.ts` and
	`src/model/taskStore.ts`:** keep run admission, gate application, receipt reconciliation,
	watcher updates, atomic writes, attachment access, reconnect recovery, and task-set scoping on
	the host. Ensure remote retries, stops, and duplicate/replayed requests remain idempotent and
	cannot supersede a newer run or cross task sets.
- **Add focused automated coverage in the existing test area** — extend
	`src/test/extension.test.ts`, `src/test/boardPanel.test.ts`, `src/test/executor.test.ts`,
	`src/test/runManager.test.ts`, and `src/test/taskStore.test.ts`, or add a narrowly scoped
	`src/test/remoteAccess.test.ts` when a separate seam is cleaner — for remote environment
	capability detection, remote webview/asset behavior, session URI and command availability,
	reconnect/reconciliation, host-side state mutation, error handling, and cross-task isolation.
	Include deterministic tests for watcher bursts, revisions/order guards, simultaneous board and
	detail/settings refreshes, task deletion or movement while selected, run-progress/completion
	updates, dropped-event recovery, and no duplicate action/run after reconnect.
- **Run verification without changing product code in this refinement:** build/package the
	extension, run the complete automated suite, then perform the documented Remote Tunnel smoke
	test from a second client: load the board, observe a file/configuration/receipt update in every
	open surface, execute one gated action, open the matching real chat, answer or stop a run,
	reconnect during and after a run, and confirm ordered snapshots, the expected receipt/state,
	session identity, and visible stale-state handling. Record any client-specific limitation as a
	follow-up rather than silently broadening the supported matrix.

## Log
- audit:state-change at:2026-08-24T23:56:27Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-24T23:56:28Z task:TASK-001 from:idle to:running action:refine run:r7lkjmz note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-24T23:56:28Z task:TASK-001 stage:refine action:refine run:r7lkjmz note:"Started refine activity."
- run:r7lkjmz task:TASK-001 stage:refine result:ok note:"2026-08-24T23:58:06Z — refine completed: defined Remote Tunnel access to the host board and real task chat with compatibility, isolation, and reconnect scope"
- audit:status-change at:2026-08-24T23:59:14Z task:TASK-001 from:running to:idle action:receipt run:r7lkjmz outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-24T23:59:14Z task:TASK-001 stage:refine action:receipt run:r7lkjmz outcome:ok note:"2026-08-24T23:58:06Z — refine completed: defined Remote Tunnel access to the host board and real task chat with compatibility, isolation, and reconnect scope"
- audit:state-change at:2026-08-25T00:39:19Z task:TASK-001 from:refine to:scoped action:apply-pending run:r7lkjmz outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-25T00:39:21Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-25T00:39:34Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-25T00:39:35Z task:TASK-001 from:idle to:running action:develop run:rnbclzd note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-25T00:39:35Z task:TASK-001 stage:develop action:develop run:rnbclzd note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-001 expected-run:rnbclzd expected-stage:develop actual-run:r7lkjmz actual-task:TASK-001 actual-stage:refine note:"Ignored receipt because run id r7lkjmz is stale; expected rnbclzd."
- run:rnbclzd task:TASK-001 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-08-25T00:59:35Z task:TASK-001 from:running to:failed action:timeout run:rnbclzd outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-25T00:59:35Z task:TASK-001 stage:develop run:rnbclzd outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- run:rnbclzd task:TASK-001 stage:develop result:ok note:"2026-08-25T03:31:57Z — develop completed: implemented Remote Tunnel host-authoritative board and task-scoped Copilot Chat access; local tests and packaging pass, remote second-client smoke evidence remains unavailable"
- audit:status-change at:2026-08-25T03:32:03Z task:TASK-001 from:failed to:idle action:late-receipt run:rnbclzd outcome:ok note:"Status changed from failed to idle via late-receipt."
- audit:activity-finish at:2026-08-25T03:32:03Z task:TASK-001 stage:develop action:late-receipt run:rnbclzd outcome:ok correction:true note:"2026-08-25T03:31:57Z — develop completed: implemented Remote Tunnel host-authoritative board and task-scoped Copilot Chat access; local tests and packaging pass, remote second-client smoke evidence remains unavailable"
- audit:state-change at:2026-08-25T03:36:18Z task:TASK-001 from:in-progress to:validation action:apply-pending run:rnbclzd outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:status-change at:2026-08-25T03:41:22Z task:TASK-001 from:idle to:running action:validate run:r619lh2 note:"Status changed from idle to running via validate."
- audit:activity-start at:2026-08-25T03:41:22Z task:TASK-001 stage:validate action:validate run:r619lh2 note:"Started validate activity."
- run:r619lh2 task:TASK-001 stage:validate result:blocked note:"validation blocked: local automated checks pass, but authenticated second-client Remote Tunnel smoke evidence is unavailable"
- audit:status-change at:2026-08-25T03:41:22Z task:TASK-001 from:running to:blocked action:manual-complete run:r619lh2 outcome:blocked note:"Status changed from running to blocked via manual-complete."
- audit:activity-finish at:2026-08-25T03:41:22Z task:TASK-001 stage:validate action:manual-complete run:r619lh2 outcome:blocked note:"validation blocked: local automated checks pass, but authenticated second-client Remote Tunnel smoke evidence is unavailable"
- audit:state-change at:2026-08-26T00:00:46Z task:TASK-001 from:validation to:done action:move note:"State changed from validation to done via move."
- audit:status-change at:2026-08-26T00:00:46Z task:TASK-001 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
