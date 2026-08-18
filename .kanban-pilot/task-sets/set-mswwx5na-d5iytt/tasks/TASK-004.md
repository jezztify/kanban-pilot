---
id: TASK-004
title: Enable configurable parallel tasks at a time
type: feature
state: done
status: idle
created: 2026-08-17T09:14:04Z
updated: 2026-08-17T22:13:58Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-004
copilot_session_id: 51ed27de-c0ef-4cdd-a679-bb6c5ba3e8ea
scope_hash: a74470e
chat_reset_required: true
---

## Request
I want to be able to configure how many parallel tasks can be done at a time

## Refined

Kanban Pilot needs a user-controlled limit for how many Copilot-backed task runs may be active at the same time. This is a run-admission limit across the runnable stages (Refine, Split, Develop/Continue, and Validate), not a limit on cards in a column and not a change to the short chat open/inject mutex. The setting should default to one for the safest current-working-tree behavior; choosing a higher value explicitly accepts that concurrent runs can edit the same workspace without worktree isolation. A task that cannot obtain capacity must remain untouched and available for a later manual or automatic start.

**Acceptance criteria**

- A workspace setting named `kanbanPilot.run.maxParallelTasks` is available, defaults to `1`, and accepts positive integers.
- At most the configured number of runs are active within the current task-set context; Refine, Split, Develop/Continue, and Validate all consume the same capacity.
- Capacity is reserved atomically before a task is moved to `status: running`, so concurrent actions and independently-created `RunManager` instances cannot exceed the limit or start the same task twice.
- A full limit makes both manual and automatic starts no-ops: the waiting task keeps its current state, status, and run metadata, and its executor is not invoked.
- Persisted `status: running` tasks count after activation or reload; completed, failed, timed-out, stopped, moved, or superseded runs release capacity for later work.
- Increasing the setting allows eligible queued work to start on the next reconciliation/gate sweep, while decreasing it does not interrupt runs already in progress.
- Invalid, non-positive, non-integer, or non-finite configuration values fall back safely to `1`.
- The user-facing setting and documentation clearly warn that values above one permit concurrent same-workspace edits and do not provide worktree isolation; the chat injection mutex remains responsible only for focus-safe injection.

## Scope
- [ ] `package.json` — contribute `kanbanPilot.run.maxParallelTasks` as a positive-integer numeric setting with default `1`, and document the shared-stage behavior and same-workspace isolation trade-off.
- [ ] `src/chat/runManager.ts` — read and normalize the setting; add a shared, task-set-scoped run-admission coordinator that atomically reserves capacity across Refine, Split, Develop/Continue, and Validate before applying state changes; count persisted running tasks and reject starts cleanly when full.
- [ ] `src/chat/runManager.ts` — release reservations on every terminal and cancellation path (success, blocked/failed result, timeout, Stop, manual move, stale/superseded run, and activation reconciliation), while keeping the existing executor injection mutex narrow.
- [ ] `src/extension.ts` — observe changes to `kanbanPilot.run.maxParallelTasks` and trigger reconciliation/gate processing when capacity increases without interrupting active runs when it decreases.
- [ ] `src/test/runManager.test.ts` — cover default and invalid-value normalization, the single-run default, configured parallel capacity, mixed stages, concurrent manager admission, persisted runs after reload, same-task protection, capacity release, dynamic increase/decrease, and automatic-gate behavior when capacity is full or becomes available.
- [ ] `README.md` and `docs/PRD.md` — document the setting, the stages it limits, full-capacity no-op/ready-queue behavior, reload and lifecycle semantics, and the explicit no-worktree-isolation risk for values above one.

## Log
- run:rsr8hqw task:TASK-004 stage:refine result:ok note:"2026-08-17T10:36:41Z — refine completed: defined the run-capacity setting, admission behavior, lifecycle rules, tests, and documentation scope"
- run:rsr8hqw task:TASK-004 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- run:rwxq7m3 task:TASK-004 stage:develop result:ok note:"2026-08-17T10:53:13Z — implemented configurable shared run capacity with lifecycle admission, tests, and documentation"
- run:r0cughj task:TASK-004 stage:validate result:blocked note:"2026-08-17T11:17:40Z — validation blocked: task-log UTC timestamp validation rejects valid second-precision timestamps, causing 77 full-suite failures and 8 of 10 focused capacity tests to fail before run-capacity behavior can be verified"
- run:rq30827 task:TASK-004 stage:validate result:ok note:"2026-08-17T22:13:39Z — validated the shared run-capacity setting, normalization, atomic admission, persisted-run and lifecycle release paths, dynamic gate reconciliation, documentation warnings, and full npm test suite with 192 passing"
