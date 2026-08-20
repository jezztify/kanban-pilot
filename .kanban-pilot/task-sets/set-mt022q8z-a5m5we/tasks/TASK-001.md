---
id: TASK-001
title: Completion receipt received with result:ok but task still tagged as failed
type: bug
state: done
status: idle
position: 0
created: 2026-08-19T12:17:34Z
updated: 2026-08-19T13:09:33Z
chat: kanban-pilot-set-mt022q8z-a5m5we-TASK-001
copilot_session_id: 33a2dfbe-f160-42fd-a28d-aec3365eaacd
scope_hash: b76c2c7
chat_reset_required: false
---

## Request
LLM thoughts:
```
Completion receipt appended to ## Log: - run:rmscygy task:TASK-005 stage:refine result:ok note:"Refined TASK-005 against the codebase..."
```

## Refined

### Problem statement

The active ticket is `TASK-001` in the named task set `set-mt022q8z-a5m5we`,
with refine run `rhtws7p`. Its request contains a purported successful receipt
for `TASK-005` and run `rmscygy`, so that line is a misrouted receipt rather
than proof that this ticket completed. Receipt reconciliation must use the
exact task-file identity, run identity, and stage; a valid `result:ok` for a
different task, an older run, or another stage must never clear or advance the
active ticket.

The reported symptom also needs to cover the real same-task race: an active
run can be marked blocked or failed by a missing/timeout fallback before its
matching receipt is visible to the task-file watcher, or a matching receipt
can be observed while a manual completion gate is holding the outcome. The
extension must distinguish those cases from a mismatch, recover an eligible
late receipt for the exact run without replaying it, and make the reason for a
rejected receipt diagnosable. The extension remains the owner of frontmatter
and state transitions; agents only edit stage-owned content and append log
records.

### Acceptance criteria

- The receipt in the current request (`run:rmscygy task:TASK-005
	stage:refine`) is rejected as unrelated to `TASK-001`/`rhtws7p` and cannot
	move, clear, or otherwise complete this ticket. Reconciliation records an
	actionable mismatch or ignored-receipt reason rather than silently treating
	it as the active run's success.
- A receipt is eligible for the active run only when its `task:` matches the
	task file, its `run:` matches the current run or a provably recoverable
	fallback run, and its `stage:` matches the stage being reconciled. Wrong-task,
	wrong-run, wrong-stage, malformed, and stale receipts do not mutate state or
	`pending_outcome`, and a receipt from an earlier attempt cannot complete a
	later retry.
- A matching `result:ok` observed during the run, after a missing/timeout
	fallback, after activation, or through a later file-watcher pass applies the
	existing stage outcome exactly once. A recoverable late receipt must satisfy
	the persisted fallback marker and matching activity/audit history; otherwise
	the ticket remains in its current retryable state with an actionable reason.
- Receipt completion obeys the configured gate for the specific transition. In
	`manual` mode the run is settled to `idle` with a durable matching
	`pending_outcome`, and the task remains in its source state until the human
	promotion/decision action applies it. In `auto` mode the same eligible
	outcome advances the task immediately through the existing receipt transition
	path. Neither mode starts a second agent run.
- Repeated reconciliation from the active named task set, file watchers, and
	activation is idempotent: it does not duplicate audit entries, fallback
	markers, transitions, or late-receipt application. A receipt written to the
	legacy default task folder cannot affect the named-set copy of the task.
- Existing protections remain intact: human-only actions and retries are not
	auto-fired, stale runs cannot consume a new run's receipt, blocked/failed
	receipts retain their stage semantics, and agents cannot change workflow
	frontmatter to bypass reconciliation.
- Automated coverage reproduces the exact task/run mismatch, wrong run and
	stage cases, an active matching receipt, a matching receipt after timeout or
	failure fallback, manual and auto gates, named-task-set routing, activation
	recovery, and repeated watcher reconciliation. The relevant test suite and
	full extension validation pass without regressions.

## Scope
- [ ] `src/chat/runManager.ts` — trace and repair active receipt polling,
	missing/timeout fallback, late-receipt recovery, `applyReceipt()`/
	`applyOutcome()`, manual pending-outcome handling, and activation/file-change
	reconciliation so exact identity is enforced, eligible late receipts recover
	once, and mismatch or persistence failures leave diagnosable evidence.
- [ ] `src/chat/receipt.ts` — preserve the canonical receipt grammar and exact
	task/run/stage matching; add only the structured lookup or mismatch detail
	required by `RunManager` to distinguish an unrelated receipt from an
	eligible late receipt.
- [ ] `src/extension.ts` and the named task-set/session routing code — verify
	that the active `TaskStore`/`RunManager` pair receives changes from the
	correct `.kanban-pilot/task-sets/<set-id>/tasks` directory and that
	reconciliation failures are not silently indistinguishable from a stale
	failed card. Keep the legacy default-set behavior compatible.
- [ ] `src/model/taskStore.ts` (only where the reproduction proves it is
	involved) — preserve atomic log/frontmatter ordering and serialized writes
	needed for receipt, fallback-marker, and pending-outcome reconciliation; do
	not alter general task creation or human action semantics.
- [ ] `src/test/runManager.test.ts` — add focused regression tests for exact
	task/run/stage identity, active and late matching `result:ok` receipts,
	fallback-marker/audit eligibility, stale retries, manual pending outcomes,
	auto promotion, named-set paths, activation recovery, idempotent repeated
	reconciliation, and visible mismatch/failure diagnostics.
- [ ] `src/test/receiptAndTemplates.test.ts` and, if storage ordering changes,
	`src/test/taskStore.test.ts` — retain receipt grammar and extension-supervised
	frontmatter ownership coverage while testing the active task-file contract
	and any new structured mismatch or persistence behavior.
- [ ] `docs/PRD.md` — document exact receipt identity, misrouted-receipt
	handling, late-receipt recovery prerequisites, manual versus automatic
	completion gates, named task-set routing, and idempotent watcher/activation
	reconciliation. Avoid broad UI or provider changes unrelated to this bug.

## Log
- audit:state-change at:2026-08-19T12:17:41Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-19T12:17:57Z task:TASK-001 from:idle to:running action:refine run:rhtws7p note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-19T12:17:57Z task:TASK-001 stage:refine action:refine run:rhtws7p note:"Started refine activity."
- run:rhtws7p task:TASK-001 stage:refine result:ok note:"2026-08-19T12:21:45Z — refined exact receipt identity, late recovery, gate behavior, named-set routing, and reconciliation test scope"
- audit:status-change at:2026-08-19T12:22:30Z task:TASK-001 from:running to:idle action:receipt run:rhtws7p outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T12:22:30Z task:TASK-001 stage:refine action:receipt run:rhtws7p outcome:ok note:"2026-08-19T12:21:45Z — refined exact receipt identity, late recovery, gate behavior, named-set routing, and reconciliation test scope"
- audit:state-change at:2026-08-19T12:27:28Z task:TASK-001 from:refine to:scoped action:apply-pending run:rhtws7p outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-19T12:27:29Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-19T12:27:30Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-19T12:27:30Z task:TASK-001 from:idle to:running action:develop run:r5lixrv note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-19T12:27:30Z task:TASK-001 stage:develop action:develop run:r5lixrv note:"Started develop activity."
- run:r5lixrv task:TASK-001 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-08-19T12:36:53Z task:TASK-001 from:running to:blocked action:missing-receipt run:r5lixrv outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-08-19T12:36:53Z task:TASK-001 stage:develop run:r5lixrv outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- run:r5lixrv task:TASK-001 stage:develop result:ok note:"2026-08-19T12:49:24Z — enforced exact task/run/stage receipt reconciliation with idempotent diagnostics and late recovery"
- audit:status-change at:2026-08-19T12:49:28Z task:TASK-001 from:blocked to:idle action:late-receipt run:r5lixrv outcome:ok note:"Status changed from blocked to idle via late-receipt."
- audit:activity-finish at:2026-08-19T12:49:28Z task:TASK-001 stage:develop action:late-receipt run:r5lixrv outcome:ok correction:true note:"2026-08-19T12:49:24Z — enforced exact task/run/stage receipt reconciliation with idempotent diagnostics and late recovery"
- audit:state-change at:2026-08-19T12:57:04Z task:TASK-001 from:in-progress to:validation action:apply-pending run:r5lixrv outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:status-change at:2026-08-19T12:57:15Z task:TASK-001 from:idle to:running action:validate run:rhp7sge note:"Status changed from idle to running via validate."
- audit:activity-start at:2026-08-19T12:57:15Z task:TASK-001 stage:validate action:validate run:rhp7sge note:"Started validate activity."
- run:rhp7sge task:TASK-001 stage:validate result:ok note:"2026-08-19T13:03:45Z — validated exact task/run/stage identity, active and late recovery, completion gates, named-set isolation, activation and watcher idempotency; focused M3 validation passed 132 tests; full suite had 260 passing with one pre-existing BoardPanel image-paste baseline failure"
- audit:status-change at:2026-08-19T13:04:17Z task:TASK-001 from:running to:idle action:receipt run:rhp7sge outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T13:04:17Z task:TASK-001 stage:validate action:receipt run:rhp7sge outcome:ok note:"2026-08-19T13:03:45Z — validated exact task/run/stage identity, active and late recovery, completion gates, named-set isolation, activation and watcher idempotency; focused M3 validation passed 132 tests; full suite had 260 passing with one pre-existing BoardPanel image-paste baseline failure"
- audit:state-change at:2026-08-19T13:09:33Z task:TASK-001 from:validation to:done action:apply-pending run:rhp7sge outcome:ok note:"State changed from validation to done via apply-pending."
