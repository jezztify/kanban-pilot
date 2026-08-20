---
id: TASK-004
title: RunManager improvement: Parallel Task
type: feature
state: validation
status: idle
position: 2
created: 2026-08-19T22:04:41Z
updated: 2026-08-19T23:33:31Z
chat: kanban-pilot-set-mt022q8z-a5m5we-TASK-004
copilot_session_id: 03ce9298-9fc5-4f5b-b1e4-9923668ea5ad
scope_hash: 47766db
chat_reset_required: false
---

## Request
I want to improve the parallel task handling of RunManager. Currently, even if I set the parallel task settings to 2 and I start 2 tasks, only 1 task runs at a time. Shall we add a backend server to handle this? please let me know what would be a good approach

## Refined

### Problem statement

When `kanbanPilot.run.maxParallelTasks` is set to `2`, two eligible task runs should be admitted and injected into separate Copilot task sessions before either agent turn finishes. The existing `RunManager` already has an in-process, task-set-scoped admission coordinator that reserves capacity before marking a task `running`; the observed serialization is instead in `src/chat/executor.ts`. Its process-wide `injectionMutex` currently awaits `chat.open<Mode>` with `blockOnResponse: true` while holding the lock, so the lock spans the entire Copilot response rather than only the focus-sensitive open-and-inject handoff. A second run can therefore hold a capacity reservation while waiting for the first chat turn to finish.

A separate backend server is not the appropriate fix. It would not remove the VS Code command, editor-focus, or chat-session constraints, and would add process lifecycle, IPC, persistence, and failure-recovery complexity. The preferred approach is to keep admission and lifecycle ownership inside the extension, narrow the executor mutex to the synchronous open-and-inject critical section, and allow each run to await its own terminal response independently. Worktree or dependency isolation for concurrent code-writing agents is a separate future concern and is not part of this ticket.

### Acceptance criteria

- With `kanbanPilot.run.maxParallelTasks` set to `2`, two eligible tasks can both reach the Copilot injection call while the first task's terminal response is still pending; the second task is not delayed until the first response completes.
- The executor mutex still protects the paired task-session open and chat injection, with no focus-sensitive gap between them, but it is released before waiting for `blockOnResponse` to reach a terminal result.
- Each run receives and reconciles its own terminal result, session id, timeout, receipt, blocked/failed outcome, and stop/supersession behavior without cross-task receipts, premature missing-receipt fallbacks, or leaked reservations.
- The existing coordinator remains the single capacity authority: no more than the configured number of runs are active, one task cannot be started twice, persisted `running` tasks still consume capacity, and terminal paths release capacity for later work.
- The default value of `1` remains sequential, and a full limit continues to leave a manual or automatic waiting task untouched in its current ready state.
- No backend process, server, IPC protocol, new runtime dependency, or worktree implementation is introduced for this fix.
- The focused regression tests, compilation, lint, and the existing test suite pass.

## Scope
- [ ] `src/chat/executor.ts` — refactor `ChatSessionExecutor.run` so the mutex covers `vscode.open` and starting `chat.open<Mode>` as one uninterrupted handoff, captures the command's pending terminal promise, releases the mutex immediately after the command is started, and awaits that promise outside the lock. Preserve `blockOnResponse: true`, attachments, tools, model selection, session-id extraction, clipboard fallback, and error handling; ensure `Mutex.run` does not accidentally await the long-lived response through the lock.
- [ ] `src/chat/runManager.ts` — verify the existing `RunConcurrencyCoordinator` remains responsible for task-set/workspace admission and keeps reservations until each `runStage` terminal path completes. Change only comments or a minimal test seam if needed; do not replace the coordinator with a server or move capacity tracking into the executor.
- [ ] `src/test/executor.test.ts` — add a controlled command/adapter test that keeps the first `blockOnResponse` promise pending, starts a second run, and proves the second open-and-inject handoff occurs before the first terminal response resolves. Also assert that the handoff remains serialized, both terminal results are returned independently, and command rejection remains reported.
- [ ] `src/test/runManager.test.ts` — add or adjust an end-to-end regression around two `maxParallelTasks: 2` runs so it exercises the real executor handoff rather than only a stub that returns immediately; assert both tasks become `running` concurrently, completion of one frees a slot, duplicate starts remain rejected, and `maxParallelTasks: 1` remains sequential.
- [ ] `README.md` and `docs/PRD.md` — clarify that `run.maxParallelTasks` limits complete extension-managed runs, while the executor mutex only protects the short focus-sensitive injection handoff; document that no backend server is needed for this concurrency fix and retain the warning that values above one do not isolate same-workspace edits.
- [ ] Validation — run the focused executor and RunManager tests, then `npm run compile-tests`, `npm run compile`, `npm run lint`, and the full `npm test`; confirm no server files or package dependencies were added.

## Log
- audit:state-change at:2026-08-19T22:04:44Z task:TASK-004 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-19T23:09:13Z task:TASK-004 from:idle to:running action:refine run:rs7enyc note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-19T23:09:13Z task:TASK-004 stage:refine action:refine run:rs7enyc note:"Started refine activity."
- run:rs7enyc task:TASK-004 stage:refine result:ok note:"2026-08-19T23:10:35Z — refined the concurrency root cause to the response-held executor mutex and scoped an in-process fix with focused tests"
- audit:status-change at:2026-08-19T23:11:12Z task:TASK-004 from:running to:idle action:receipt run:rs7enyc outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T23:11:12Z task:TASK-004 stage:refine action:receipt run:rs7enyc outcome:ok note:"2026-08-19T23:10:35Z — refined the concurrency root cause to the response-held executor mutex and scoped an in-process fix with focused tests"
- audit:state-change at:2026-08-19T23:20:13Z task:TASK-004 from:refine to:scoped action:apply-pending run:rs7enyc outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-19T23:20:15Z task:TASK-004 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-19T23:20:17Z task:TASK-004 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-19T23:20:17Z task:TASK-004 from:idle to:running action:develop run:rtq9woe note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-19T23:20:17Z task:TASK-004 stage:develop action:develop run:rtq9woe note:"Started develop activity."
- run:rtq9woe task:TASK-004 stage:develop result:ok note:"2026-08-19T23:26:25Z — implemented the response-independent executor handoff and validated parallel run capacity"
- audit:status-change at:2026-08-19T23:26:49Z task:TASK-004 from:running to:idle action:receipt run:rtq9woe outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T23:26:49Z task:TASK-004 stage:develop action:receipt run:rtq9woe outcome:ok note:"2026-08-19T23:26:25Z — implemented the response-independent executor handoff and validated parallel run capacity"
- audit:state-change at:2026-08-19T23:33:31Z task:TASK-004 from:in-progress to:validation action:apply-pending run:rtq9woe outcome:ok note:"State changed from in-progress to validation via apply-pending."
