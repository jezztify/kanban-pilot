---
id: TASK-007
title: Fix timing race issue
type: feature
state: done
status: idle
created: 2026-08-15T08:05:42Z
updated: 2026-08-15T08:22:40Z
chat: kanban-pilot-TASK-007
copilot_session_id: cb69d6b3-913d-4715-8174-5c1b8138fcc8
scope_hash: c0d6166
chat_reset_required: false
---

## Request
this is an investigation of a previous run
```
1. The running Copilot session used run ID r3h33nn.
2. RunManager finished its reconciliation before it could find the matching receipt, so it applied the “no receipt found” rule and set the task to status: blocked while clearing run.
3.The successful receipt was appended afterward. The log now contains result:ok, but the extension does not retroactively reconcile receipts once run has been cleared.
```

I want to fix this timing race issue

## Refined
The run-completion protocol currently treats `Executor.run()` resolving and the agent appending its `## Log` receipt as if they were one atomic event. `RunManager.reconcile()` performs one immediate receipt lookup after executor success; if the matching `run:`/`task:` receipt is still being written, it applies the no-receipt fallback, marks the task `blocked`, and clears `run`. The later valid receipt is visible on disk but is never reconsidered: the task watcher currently only applies gate policies, and activation reconciliation only examines tasks that are still `running`. This loses a successful stage result because of filesystem timing rather than an actual agent outcome.

**Acceptance criteria**
- A matching receipt appended immediately after executor completion is eventually reconciled for the same run, whether it appears before the first lookup, during a bounded reconciliation grace period, or after the no-receipt fallback has started; a valid `result:ok` must not remain stranded on a `blocked` card solely because of this race.
- Reconciliation preserves the existing stage semantics: refine `ok` advances to Scoped and records `scope_hash`; develop `ok` advances to Validation; validate maps `ok` to Done, `failed` to In Progress, and `blocked` to blocked Validation; split `ok` retires the parent as Done while non-`ok` outcomes remain in Refine with their result status.
- A genuinely missing receipt still reaches a bounded `blocked` outcome and clears the active run; the fix must not leave tasks running indefinitely while waiting for a cooperative agent.
- A late receipt is accepted only when its `run:` and `task:` identify the still-relevant run, and it cannot overwrite Stop, manual completion, a newer run, or another user transition. Repeated file events must not duplicate state transitions, proposal tasks, or other side effects.
- Receipt-driven reconciliation is triggered by task-file changes and on activation, while preserving append-only log behavior, task-id misroute rejection, timeout/error handling, and the existing `markRunComplete` escape hatch.
- Automated coverage deterministically reproduces the delayed-append race, the post-fallback late receipt, the genuine no-receipt path, and stale/superseded runs; the existing test suite remains passing.

## Scope
- [ ] `src/chat/runManager.ts` — separate receipt detection/application from the executor-result path and add a bounded retry/grace mechanism plus a late-receipt reconciliation path for receipts that arrive after the initial no-receipt decision. Preserve the `run` staleness guard, `task:` validation, timeout and executor-failure behavior, activation recovery, stage-specific `applyOutcome` rules, and proposal processing.
- [ ] `src/chat/runManager.ts` — retain enough run/task/stage correlation to reconcile a late receipt after the active `run` is cleared, and make receipt application idempotent so repeated watcher/activation events cannot reapply a receipt or create duplicate proposals. Superseded runs must remain ignored.
- [ ] `src/chat/receipt.ts` — extend the receipt lookup/matching helpers as needed to identify the applicable latest matching receipt for a run without weakening the existing run-id and task-id checks; keep the current parser and receipt grammar compatible.
- [ ] `src/model/taskStore.ts` — expose the task-file change context needed by the receipt watcher, or otherwise preserve the atomic write/watch contract while allowing `RunManager` to react specifically to log changes without introducing a second source of task state.
- [ ] `src/extension.ts` — route task-file change notifications through the new receipt-reconciliation path before or alongside gate-policy sweeps, with serialization/debouncing so a log append and the resulting frontmatter write cannot cause duplicate reconciliation.
- [ ] `src/test/runManager.test.ts` — add deterministic tests where the executor resolves before the receipt append, where the receipt arrives after the no-receipt fallback has cleared `run`, where no receipt remains missing, and where Stop/manual completion/newer runs reject stale late receipts; assert each stage's existing outcome and idempotency behavior.
- [ ] `src/test/receiptAndTemplates.test.ts` — add focused coverage for any changed receipt lookup behavior, including multiple matching receipts, task-id mismatches, and preservation of the parser-compatible receipt format.
- [ ] Verify the implementation with the extension's compile, lint, and test commands, and perform a file-watcher/activation smoke check to confirm a delayed successful receipt moves the card correctly without changing `## Request` or frontmatter ownership rules.

## Log
- run:r4fzk9f task:TASK-007 stage:refine result:ok note:"2026-08-15T08:06:40Z — documented the delayed-receipt race, guarded late reconciliation behavior, and focused implementation checklist"
- run:r0ejhju task:TASK-007 stage:develop result:ok note:"2026-08-15T08:21:11Z — implemented bounded receipt grace, late fallback reconciliation, serialized watcher recovery, and regression tests"
