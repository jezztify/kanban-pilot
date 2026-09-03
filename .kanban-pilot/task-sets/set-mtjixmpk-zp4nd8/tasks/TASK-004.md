---
id: TASK-004
title: Make workflow outcomes and recovery next steps visible
type: feature
state: in-progress
status: blocked
parent_task: TASK-003
position: 1
created: 2026-09-03T02:44:07Z
updated: 2026-09-03T04:43:07Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-004
copilot_session_id: b82fc7ca-24c9-421a-ab15-569bf650ead5
scope_hash: faa398d
origin_task: TASK-003
origin_run: rroucoq
---

## Request
Make workflow outcomes and recovery next steps visible in the board. From a card or task detail, a user should be able to understand what happened, whether a gate or host action is holding the task, and what the next legal action is for running, blocked, failed, pending, and stale-completion states.

_Filed automatically by TASK-003's run rroucoq._

## Refined

### Problem statement

The board currently exposes the task column and short runtime status, while the useful explanation is split across the latest raw log line, a generic blocked message, pending-completion metadata, and a separate stale-recovery control. A user can therefore see that work is not moving but still have to open the detail view or infer from implementation terminology whether the task is actively running, waiting for host approval, retryable, waiting for a manual gate, or holding a valid late result from an older run. The board needs a concise, visible outcome and next-step explanation on the card and in task detail, while the state machine and host-side validation remain the authority for what actions are legal.

### Acceptance criteria

- For `running`, `blocked`, `failed`, manual-gate pending, and eligible stale-completion states, the card and/or task detail visibly identifies the condition without requiring a hover, raw task-file inspection, or color interpretation.
- The detail view answers, with the available evidence, what happened, what is holding the task, and what the user can do next. It uses the existing receipt, audit, pending-outcome, latest-log, and stale-candidate data rather than inventing a second workflow state.
- A running task identifies its active stage/run context and makes the existing legal `Stop` action clear; a blocked task explains that host approval or action is required and exposes only the state-machine retry action (`Refine`, `Continue`, or `Validate`) where that action is legal; a failed task shows the failure reason when available and its legal retry action.
- A pending completion identifies the receipt result, stage, run, and gate transition such as `Develop -> Validation`, clearly says that review/application is holding the task, and exposes `Apply` through the existing `pending/apply` intent instead of presenting a misleading normal retry as the primary next step.
- An eligible stale completion identifies the old run, latest/current run context, and receipt summary, exposes the existing `stale/recover` intent, and makes clear that recovery requires explicit host confirmation and will not automatically adopt an old result or start another run.
- The displayed next-step text and buttons stay consistent with `primaryAction`, pending-gate legality, and stale-candidate validation. The webview must not offer an action that `stateMachine.ts` would reject, and a stale or active-run conflict must not be presented as a successful recovery.
- Updates from task-file, run, pending-gate, and stale-candidate refreshes keep the card and an open detail view synchronized. The added status explanation has accessible text/semantics, remains readable when text wraps on narrow layouts, and preserves existing modal focus and action behavior.
- Existing workflow transitions, automatic-gate defaults, receipt reconciliation, task-file ownership, chat routing, and the one-primary-action card rule remain unchanged. Existing pending and stale-recovery flows continue to use host-side validation and confirmation.

## Scope
- [ ] Update `src/board/boardPanel.ts` to add a pure view-level outcome/next-step projection that reuses the task state, primary-action mapping, latest receipt/audit or log evidence, `pendingView`, and `StaleCompletionCandidate` data. Expose only the structured context needed by cards and detail; do not create a second persisted workflow state.
- [ ] Update the board card rendering in `src/board/boardPanel.ts` with a concise, visible, non-color-only cue for running, blocked, failed, pending completion, and stale-completion conditions. Keep the card face to one primary action and avoid putting the full log on the card.
- [ ] Update the task detail rendering in `src/board/boardPanel.ts` with a clearly ordered outcome/recovery summary answering what happened, what is holding the task, and the next legal action. Use visible text or an expandable explanation rather than tooltip-only guidance, and include stage/run, gate transition, failure/block reason, or stale-run context when available.
- [ ] Preserve and reuse the existing `action/invoke`, `pending/apply`, and `stale/recover` messages, including explicit host confirmation and revalidation. If an apply, recovery, active-run conflict, or stale action is currently silent, add a board-visible status/error response without weakening the host-side gate.
- [ ] Check `src/board/stateMachine.ts` as the read-only legality contract while implementing the projection. Do not change transition rules, automatic-gate defaults, receipt reconciliation, chat routing, or task-file ownership; `runManager.ts` should change only if an authoritative reason or recovery field cannot otherwise be obtained from existing data.
- [ ] Keep refresh behavior correct when task files, runs, pending outcomes, or stale candidates change, including an already-open detail view. Preserve modal focus, action ordering, readable wrapping, reduced-motion behavior, and browser/editor presentation boundaries.
- [ ] Extend `src/test/boardPanel.test.ts` with focused card and detail fixtures for running, blocked, failed, pending completion, and stale completion. Assert visible explanations, accessible names/roles, stage/run and gate context, legal action labels, and the exact existing messages emitted by each recovery/apply control.
- [ ] Add or adjust only the narrowest supporting assertions in `src/test/runManager.test.ts` or `src/test/stateMachine.test.ts` if the view contract exposes a missing authoritative outcome/recovery edge; reuse existing transition and stale-candidate tests rather than changing workflow semantics.
- [ ] Update `docs/board-guide.md` with the point-of-use meaning of the visible outcome cues and next actions, including retry versus host approval, pending review, and stale recovery.
- [ ] Update the manual-gate and recovery guidance in `docs/configuration.md` so it distinguishes a completed receipt waiting for a gate from a blocked/failed run and from an eligible late completion.
- [ ] Run the focused board tests plus the repository build, lint, and existing test suite, and verify that no illegal action is rendered and that narrow card/detail layouts remain readable.

## Log
- audit:state-change at:2026-09-03T02:52:57Z task:TASK-004 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T02:53:03Z task:TASK-004 from:idle to:running action:refine run:rnqklq6 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T02:53:03Z task:TASK-004 stage:refine action:refine run:rnqklq6 note:"Started refine activity."
- progress run:rnqklq6 task:TASK-004 at:2026-09-03T02:55:16Z note:"scoping the board outcome and recovery view contract"
- run:rnqklq6 task:TASK-004 stage:refine result:ok note:"2026-09-03T02:55:16Z — refined the outcome guidance states, implementation files, legal-action boundaries, and focused verification"
- audit:status-change at:2026-09-03T02:55:37Z task:TASK-004 from:running to:idle action:receipt run:rnqklq6 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T02:55:37Z task:TASK-004 stage:refine action:receipt run:rnqklq6 outcome:ok note:"2026-09-03T02:55:16Z — refined the outcome guidance states, implementation files, legal-action boundaries, and focused verification"
- audit:state-change at:2026-09-03T03:06:51Z task:TASK-004 from:refine to:scoped action:apply-pending run:rnqklq6 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T03:06:53Z task:TASK-004 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T03:06:54Z task:TASK-004 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T03:06:54Z task:TASK-004 from:idle to:running action:develop run:rhlswn2 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T03:06:54Z task:TASK-004 stage:develop action:develop run:rhlswn2 note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-004 expected-run:rhlswn2 expected-stage:develop actual-run:rnqklq6 actual-task:TASK-004 actual-stage:refine note:"Ignored receipt because run id rnqklq6 is stale; expected rhlswn2."
- run:rhlswn2 task:TASK-004 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-03T03:21:56Z task:TASK-004 from:running to:blocked action:missing-receipt run:rhlswn2 outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-09-03T03:21:56Z task:TASK-004 stage:develop run:rhlswn2 outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- run:rhlswn2 task:TASK-004 stage:develop result:ok note:"2026-09-03T04:43:00Z — implemented visible outcome and recovery guidance across board cards and task detail with accessible host-result notices; focused board tests, build, and lint pass; the full suite retains 13 unrelated RunManager failures"
- implementation-evidence run:rhlswn2 files:"src/board/boardPanel.ts,src/test/boardPanel.test.ts,docs/board-guide.md,docs/configuration.md" verify:"npm run compile-tests, npm run compile, npm run lint, BoardPanel Settings suite 36 passing"
- audit:activity-finish at:2026-09-03T04:43:07Z task:TASK-004 stage:develop action:late-receipt run:rhlswn2 outcome:blocked correction:true note:"Develop completion requires implementation evidence with changed files and verification."
