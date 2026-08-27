---
id: TASK-004
title: make the synchronization a subscription  instead of pulling data every few sconds
type: feature
state: in-progress
status: idle
position: 0
created: 2026-08-26T19:26:46Z
updated: 2026-08-26T19:47:15Z
pending_outcome: {"gate":"developToValidation","stage":"develop","result":"ok","runId":"r8nrj0v"}
chat: 40c37fa6-7aaf-4ed8-9ab3-a4833573a7b6
copilot_session_id: 40c37fa6-7aaf-4ed8-9ab3-a4833573a7b6
scope_hash: a4d84ce
chat_reset_required: false
---

## Request
make the synchronization a subscription  instead of pulling data every few sconds

## Refined
Replace periodic board-state retrieval with an event-driven subscription so connected browser and API consumers receive authoritative task, attachment, configuration, task-set, and run changes as they occur. Preserve the existing per-browser board message stream and distinguish it from outbound-message retry behavior, heartbeats, and local debounce timers, which are not board-state polling.

### Acceptance criteria
- A consumer can establish one authenticated Server-Sent Events subscription and receive an immediate authoritative board snapshot followed by updates when the workspace board changes.
- The consumer no longer performs a recurring `GET /api/board` request solely to discover board changes.
- Each event includes the monotonic board revision and change metadata required to ignore stale snapshots.
- Browser-board sessions continue to receive their existing board-protocol messages, reconnect safely, and refresh their projection after reconnecting.
- Connection close, server disposal, and reconnect clean up subscription listeners and heartbeat timers without leaking sessions or duplicate updates.
- Automated coverage proves initial delivery, change-driven delivery, reconnect behavior, authentication, and subscription cleanup; no code change is required for bounded retries of failed outbound commands.

## Scope
- [ ] Trace every browser and API board-state synchronization path, distinguishing periodic snapshot pulls from the existing session message stream, heartbeat, retry, and debounce timers.
- [ ] In `src/http/realtimeBoardServer.ts`, make the authenticated board-events endpoint the authoritative subscription path: publish an initial projection and subsequent host changes, carrying revision and typed change details, and dispose listeners and heartbeat resources on disconnect or server shutdown.
- [ ] In `src/http/browserBoardSurface.ts`, retain the per-session `EventSource` bridge and reconnect projection refresh; remove or replace any periodic board-state retrieval found during the audit without changing outbound command retry semantics.
- [ ] In `src/extension.ts`, preserve the workspace change event source and its debounced file-watcher reconciliation so board updates are emitted once per meaningful store, run, configuration, attachment, or task-set change.
- [ ] Update `src/test/realtimeBoardServer.integration.test.ts` and `src/test/realtimeBoardServer.test.ts` to cover initial subscription snapshots, push updates, authentication, reconnects, and cleanup; add focused coverage for any polling path removed by the implementation.
- [ ] Update the endpoint synchronization documentation in `README.md` and `docs/PRD.md` to describe the subscription contract, monotonic revisions, reconnect behavior, and the absence of periodic polling for board state.

## Log
- audit:state-change at:2026-08-26T19:26:48Z task:TASK-004 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T19:27:03Z task:TASK-004 from:idle to:running action:refine run:rfektqt note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T19:27:03Z task:TASK-004 stage:refine action:refine run:rfektqt note:"Started refine activity."
- progress run:rfektqt task:TASK-004 at:2026-08-26T19:27:28Z note:"Investigation completed: identified the existing event-driven board synchronization."
- progress run:rfektqt task:TASK-004 at:2026-08-26T19:27:43Z note:"Scoping edit completed: documented subscription behavior and implementation checks."
- run:rfektqt task:TASK-004 stage:refine result:ok note:"2026-08-26T19:27:43Z — refine completed: scoped subscription-based board synchronization and verification."
- audit:status-change at:2026-08-26T19:28:05Z task:TASK-004 from:running to:idle action:receipt run:rfektqt outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T19:28:05Z task:TASK-004 stage:refine action:receipt run:rfektqt outcome:ok note:"2026-08-26T19:27:43Z — refine completed: scoped subscription-based board synchronization and verification."
- audit:state-change at:2026-08-26T19:32:03Z task:TASK-004 from:refine to:scoped action:apply-pending run:rfektqt outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T19:32:05Z task:TASK-004 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T19:32:06Z task:TASK-004 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T19:32:06Z task:TASK-004 from:idle to:running action:develop run:r8nrj0v note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T19:32:06Z task:TASK-004 stage:develop action:develop run:r8nrj0v note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-004 expected-run:r8nrj0v expected-stage:develop actual-run:rfektqt actual-task:TASK-004 actual-stage:refine note:"Ignored receipt because run id rfektqt is stale; expected r8nrj0v."
- run:r8nrj0v task:TASK-004 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-08-26T19:32:13Z task:TASK-004 from:running to:blocked action:missing-receipt run:r8nrj0v outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-08-26T19:32:13Z task:TASK-004 stage:develop run:r8nrj0v outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- progress run:r8nrj0v task:TASK-004 at:2026-08-26T19:47:08Z note:"Implementation completed: strengthened the board event subscription lifecycle."
- progress run:r8nrj0v task:TASK-004 at:2026-08-26T19:47:08Z note:"Testing completed: build, lint, and the full automated suite passed."
- run:r8nrj0v task:TASK-004 stage:develop result:ok note:"2026-08-26T19:47:08Z — develop completed: hardened SSE subscriptions with focused coverage and passing smoke checks."
- audit:status-change at:2026-08-26T19:47:15Z task:TASK-004 from:blocked to:idle action:late-receipt run:r8nrj0v outcome:ok note:"Status changed from blocked to idle via late-receipt."
- audit:activity-finish at:2026-08-26T19:47:15Z task:TASK-004 stage:develop action:late-receipt run:r8nrj0v outcome:ok correction:true note:"2026-08-26T19:47:08Z — develop completed: hardened SSE subscriptions with focused coverage and passing smoke checks."
