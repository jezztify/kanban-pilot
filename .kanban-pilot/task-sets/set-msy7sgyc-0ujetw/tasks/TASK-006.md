---
id: TASK-006
title: Fix issues when task times out
type: bug
state: validation
status: idle
position: 3
created: 2026-08-18T06:36:45Z
updated: 2026-08-18T08:15:42Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-006
copilot_session_id: 41193303-0512-44f7-9b09-391b93477e66
scope_hash: 61e309c
chat_reset_required: false
---

## Request
LLM thoughts:
```
TASK-004 is failed because its extension-supervised refine run rglbnip timed out. The log records:

The run started at 05:55:54.
At 06:15:55, the activity timed out and changed status from running to failed.
A later result:ok receipt was appended, but the frontmatter still says status: failed. In an extension-supervised run, the extension owns frontmatter transitions, and that late receipt did not retroactively undo the timeout transition.
The refinement content is present in TASK-004.md, but the card needs to be retried from its failed state for the board to reconcile it as successful.
```

## Refined

### Problem statement

`RunManager.runStage()` races the Copilot executor against `kanbanPilot.run.timeoutMinutes`. When the timer wins, `RunManager` appends a `result:failed` timeout receipt, records the timeout audit event, clears `run`, and leaves the card in its working column with `status: failed`. The underlying Copilot turn can nevertheless continue after that boundary and append a matching `result:ok` receipt. TASK-004 demonstrated the resulting inconsistency: its refinement output and late success receipt were present, but the extension-owned frontmatter remained failed because the existing late-receipt path only recognizes the marker used by the missing-receipt fallback.

Timeout handling needs one deterministic recovery contract. A timed-out run must remain visibly failed and retryable when no later receipt is available, while a valid receipt from that same run may recover the card only if the task has not been superseded. Once the user stops, manually moves, or retries the task with a newer run, an old timed-out completion must never reclaim or overwrite the newer state. The extension must continue to own frontmatter transitions; late agent output may contribute only through the existing receipt reconciliation protocol.

### Acceptance criteria

1. A timeout records a parseable, stage-specific timeout fallback in `## Log`, records the timeout audit outcome, clears the active `run`, and leaves the task in its current working column with `status: failed` when no valid late receipt is available. The card remains eligible for its existing retry action (`Refine`, `Continue`, or `Validate`).
2. A matching late receipt for the timed-out `run`/`task`/`stage`, whether observed by the file watcher, activation reconciliation, or the bounded in-process backstop, is applied exactly once when the task is still in the expected column, has no newer `run`, and has not been manually superseded. Its normal result semantics are preserved: for example, refine `result:ok` reaches Scoped and records `scope_hash`, develop `result:ok` reaches Validation, and validate retains its existing three-way outcome handling.
3. The timeout fallback receipt is distinguishable from an agent-authored failure receipt and cannot be mistaken for the late receipt it is waiting for. A late `result:blocked` or `result:failed` is handled according to the stage contract rather than being silently treated as success.
4. If a user stops the run, moves the task, or starts a retry/new run before the old timed-out turn settles, any later receipt or executor result from the old `run` is ignored. It must not change the newer state, append duplicate lifecycle events, create duplicate proposed tasks, or move the task out of its current column.
5. Repeated watcher events, activation, and timeout backstop polling are idempotent: they do not duplicate receipts, proposed child tasks, timeout/correction audit events, or state transitions. A timeout whose Copilot turn never produces a receipt still settles as failed rather than remaining running indefinitely.
6. The executor promise that loses the timeout race is safely observed when it eventually resolves or rejects, so a late executor settlement cannot produce an unhandled rejection or independently mutate task frontmatter.
7. Existing ordinary receipt reconciliation, missing-receipt late recovery, manual completion, stop/move staleness protection, and timeout normalization continue to pass unchanged.

## Scope
- [ ] `src/chat/runManager.ts` — unify timeout and missing-receipt fallback handling around a parseable late-receipt marker; distinguish timeout fallback receipts from ordinary agent failures; recheck for a receipt written before/around the timeout; and start the existing bounded watcher/backstop recovery for timed-out runs.
- [ ] `src/chat/runManager.ts` — extend late-receipt discovery and candidate guards to support timed-out cards in `status: failed` while requiring the original run id, stage, expected column, no active newer run, and no manual supersession. Route recovered receipts through the existing `applyReceipt`/`applyOutcome` path so stage-specific transitions, `scope_hash`, proposal processing, and correction audit events remain consistent and idempotent.
- [ ] `src/chat/runManager.ts` — make the timeout race consume the eventual executor settlement (including rejection) without allowing it to apply stale state; release capacity and preserve the existing retry behavior after timeout.
- [ ] `src/chat/receipt.ts` and `src/model/taskLog.ts` — keep the public receipt grammar and audit vocabulary compatible, adding only the smallest shared marker/helper or provisional/correction representation needed to parse and audit timeout recovery without introducing a new result value.
- [ ] `src/board/stateMachine.ts` and `src/board/boardPanel.ts` — verify the existing failed-status action matrix and card rendering remain the retry affordance for timed-out Refine, In Progress, and Validation tasks; do not introduce a second timeout status or bypass the state machine. Add source changes only if the regression exposes a missing retry path.
- [ ] `src/test/runManager.test.ts` — add regression coverage for a timeout with no receipt, a late success receipt arriving after timeout, a receipt written before the timeout fallback is finalized, watcher/activation/backstop recovery, stage-specific outcomes, exactly-once correction/audit behavior, late executor rejection, and stale completions after stop, manual move, or retry/new run. Include proposal-bearing runs to prove late reconciliation cannot duplicate child tasks.
- [ ] `src/test/stateMachine.test.ts` and `src/test/boardPanel.test.ts` — assert that failed timeout cards continue to expose the normal Refine/Continue/Validate retry actions and that retry admission remains legal without inventing timeout-specific states.
- [ ] `src/test/receiptAndTemplates.test.ts` and relevant audit assertions — cover the parser-compatible timeout marker and provisional/correction audit shape if those representations change; retain the existing receipt grammar and extension-supervised frontmatter ownership checks.
- [ ] `docs/PRD.md` (and `README.md` if the user-facing timeout description is duplicated there) — document the timeout boundary, retry behavior, eligible late-receipt recovery, supersession guard, and idempotent correction so the implementation and operational expectations match the incident behavior.
- [ ] Run the focused RunManager/state-machine/board tests, then the repository compile, lint, and full test commands; verify manually that a timed-out task can be retried and that a late receipt from the old run cannot move a card after the retry.

## Log
- audit:state-change at:2026-08-18T06:36:53Z task:TASK-006 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T06:40:08Z task:TASK-006 from:idle to:running action:refine run:rsftzal note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T06:40:08Z task:TASK-006 stage:refine action:refine run:rsftzal note:"Started refine activity."
- run:rsftzal task:TASK-006 stage:refine result:ok note:"2026-08-18T06:55:18Z — refined timeout recovery, late-receipt reconciliation, retry safety, and regression-test scope"
- audit:state-change at:2026-08-18T06:56:01Z task:TASK-006 from:refine to:scoped action:receipt run:rsftzal outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T06:56:01Z task:TASK-006 from:running to:idle action:receipt run:rsftzal outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T06:56:01Z task:TASK-006 stage:refine action:receipt run:rsftzal outcome:ok note:"2026-08-18T06:55:18Z — refined timeout recovery, late-receipt reconciliation, retry safety, and regression-test scope"
- audit:state-change at:2026-08-18T07:51:34Z task:TASK-006 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T07:51:36Z task:TASK-006 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T07:51:36Z task:TASK-006 from:idle to:running action:develop run:rejgwyq note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T07:51:36Z task:TASK-006 stage:develop action:develop run:rejgwyq note:"Started develop activity."
- run:rejgwyq task:TASK-006 stage:develop result:ok note:"2026-08-18T08:05:29Z — implemented timeout fallback recovery, late receipt reconciliation, supersession guards, rejection safety, regression tests, and documentation"
- run:rejgwyq task:TASK-006 stage:develop result:failed note:"timed out"
- audit:status-change at:2026-08-18T08:11:36Z task:TASK-006 from:running to:failed action:timeout run:rejgwyq outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-18T08:11:36Z task:TASK-006 stage:develop run:rejgwyq outcome:timeout note:"Activity timed out."
- audit:state-change at:2026-08-18T08:15:42Z task:TASK-006 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-08-18T08:15:42Z task:TASK-006 from:failed to:idle action:move note:"Status changed from failed to idle via move."
