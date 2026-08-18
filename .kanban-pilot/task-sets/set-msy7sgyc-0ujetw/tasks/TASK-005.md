---
id: TASK-005
title: RunManager processes split receipts but does not create child tasks
type: bug
state: validation
status: idle
position: 2
created: 2026-08-18T06:04:15Z
updated: 2026-08-18T06:53:15Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-005
copilot_session_id: 41ee53ef-aa93-4d4c-932f-4fef4b7363a0
scope_hash: 16e2c5e
chat_reset_required: false
---

## Request
This is one of the LLM's thoughts when splitting a task
```
RunManager has processed my receipt — TASK-001 moved to done/idle. But the child task files still don't exist, which means RunManager consumed the proposals without creating them (or they're pending somewhere). Let me look at how this extension actually handles proposal lines and where it stores board state.
```

## Refined

### Problem statement

The `split` stage is intended to turn each valid, same-run `propose-task` line in the parent task's `## Log` into a real child task before retiring the parent as a tracking-only card in `done`. The reported behavior is that RunManager accepts the split receipt and moves the parent to `done`/`idle`, but no child task files are visible. The existing happy-path coverage only proves proposals written in the default temporary TaskStore, in the expected order before the receipt, so it does not establish the production behavior across filesystem events, reload/late-receipt reconciliation, or named task sets.

The refinement must close the boundary between receipt reconciliation, proposal parsing, and task persistence. In particular, RunManager must not consume a successful split receipt while proposal lines are still unobserved, malformed, associated with another run, or written to a different task-set directory. A split must either persist traceable children through the active TaskStore and make them visible on the same board, or leave the parent in a retryable state with an actionable explanation; it must never silently retire the parent with the requested work missing.

### Acceptance criteria

- A matching `stage:split result:ok` receipt plus valid same-run proposal lines creates one real child file per accepted proposal through the active `TaskStore`, before the parent is moved to `done`/`idle`. Each child is in `backlog`, carries the explicit or inherited `feature`/`bug` type, has `origin_task` set to the parent, and appears in the active task-set board snapshot.
- Proposal processing is robust to the task-file write and watcher timing: proposals are not lost when the receipt and proposal lines are observed in separate filesystem events, during late-receipt recovery, or after window activation. Repeated reconciliation of the same split run is idempotent and does not create duplicate children.
- A successful split with no valid, parseable proposal for that run does not silently retire the parent. The parent remains in `refine` with a retryable `blocked` or `failed` status and an actionable audit/log explanation. A `blocked` or `failed` split receipt never creates children.
- Only well-formed proposals for the current parent and run are eligible; unrelated-run lines, malformed lines, invalid explicit types, and proposals beyond the five-child cap are ignored without preventing valid children from being created. `chat.allowTaskProposals: false` continues to suppress develop/validate follow-ups but never suppresses the primary `split` child creation path.
- Child creation uses the same directory and id allocation as the parent, including non-default named task sets under `.kanban-pilot/task-sets/<set-id>/tasks`; the split prompt and reconciliation path do not direct or write children to the legacy default task folder by mistake.
- Existing split behavior remains intact for legal Backlog/Refine/Scoped actions, the parent’s tracking-only `done` outcome after a successful child creation, the ordinary Refine retry after a blocked split, and the existing proposal grammar/origin metadata contract.

## Scope
- `src/chat/runManager.ts` — audit and repair the split receipt path (`applyReceipt`, `processProposals`, and `applyOutcome`) so it drains the current run's proposals at the correct reconciliation point, waits or rechecks when receipt/proposal writes are observed separately, validates the child-creation result before applying the parent `done` transition, handles missing/failed creation without silent data loss, and keeps repeated watcher/activation/late-receipt passes idempotent.
- `src/chat/proposals.ts` — preserve the canonical proposal grammar while tightening or extending parsing only where the real split prompt output requires it; expose enough structured information for RunManager to distinguish valid current-run proposals from ignored lines and to report why a successful split had no usable children.
- `src/chat/promptTemplates.ts` — make the split completion contract unambiguous about proposal-before-receipt ordering and writing to the attached active task file/task set rather than assuming `.kanban-pilot/tasks`; keep the contract consistent with the extension-supervised frontmatter ownership rules.
- `src/model/taskStore.ts` and, if required by the idempotency design, `src/model/task.ts` — verify or adjust serialized child creation, active-directory id allocation, and persisted proposal provenance so a retry or reload cannot duplicate children or leave the parent marked complete after a partial write. Do not change the general human task-creation path.
- `src/test/runManager.test.ts` — add focused regression coverage for split proposals in the active named task set, receipt/proposal ordering and separate watcher events, late receipt and activation recovery, missing/invalid proposals, blocked/failed receipts, creation failures, repeated reconciliation, cap/type inheritance, and the invariant that the parent is retired only after children are persisted.
- `src/test/proposals.test.ts`, `src/test/receiptAndTemplates.test.ts`, and `src/test/taskStore.test.ts` — extend parser/template/store coverage for the accepted split syntax, the active-task-file instruction, child origin/provenance and same-directory allocation; retain existing develop/validate proposal and legacy task-set behavior.
- `docs/PRD.md` — update §§6.12–6.14 and task-set guidance to document the split transaction boundary, missing-child failure behavior, idempotent reconciliation, and the active task-set location without changing the distinction between optional develop/validate proposals and mandatory split children.

## Log
- audit:state-change at:2026-08-18T06:04:18Z task:TASK-005 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T06:36:49Z task:TASK-005 from:idle to:running action:refine run:ri873x9 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T06:36:49Z task:TASK-005 stage:refine action:refine run:ri873x9 note:"Started refine activity."
- run:ri873x9 task:TASK-005 stage:refine result:ok note:"2026-08-18T06:38:52Z — refined split reconciliation, active task-set path, proposal ordering, failure handling, and regression-test scope"
- audit:state-change at:2026-08-18T06:39:34Z task:TASK-005 from:refine to:scoped action:receipt run:ri873x9 outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T06:39:34Z task:TASK-005 from:running to:idle action:receipt run:ri873x9 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T06:39:34Z task:TASK-005 stage:refine action:receipt run:ri873x9 outcome:ok note:"2026-08-18T06:38:52Z — refined split reconciliation, active task-set path, proposal ordering, failure handling, and regression-test scope"
- audit:state-change at:2026-08-18T06:39:57Z task:TASK-005 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T06:39:57Z task:TASK-005 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T06:39:57Z task:TASK-005 from:idle to:running action:develop run:r8sq0vz note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T06:39:57Z task:TASK-005 stage:develop action:develop run:r8sq0vz note:"Started develop activity."
- run:r8sq0vz task:TASK-005 stage:develop result:ok note:"2026-08-18T06:51:15Z — implemented transactional split reconciliation, durable child provenance, named task-set routing, retry recovery, prompt guidance, documentation, and regression coverage"
- audit:state-change at:2026-08-18T06:53:15Z task:TASK-005 from:in-progress to:validation action:receipt run:r8sq0vz outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T06:53:15Z task:TASK-005 from:running to:idle action:receipt run:r8sq0vz outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T06:53:15Z task:TASK-005 stage:develop action:receipt run:r8sq0vz outcome:ok note:"2026-08-18T06:51:15Z — implemented transactional split reconciliation, durable child provenance, named task-set routing, retry recovery, prompt guidance, documentation, and regression coverage"
