---
id: TASK-005
title: Task creates new chat when it moves from 1 column to another,
type: bug
state: done
status: idle
position: 4
created: 2026-08-31T05:45:25Z
updated: 2026-09-01T07:24:30Z
chat: f12b8e7d-c210-4d83-a842-24d13cca3637
copilot_session_id: f12b8e7d-c210-4d83-a842-24d13cca3637
scope_hash: 7dd0b13
chat_reset_required: false
---

## Request
Task creates new chat when it moves from 1 column to another,

## Refined

Problem statement: Moving a task between columns is an organizational state change, not a new agent turn. The task must retain the same Copilot conversation while it moves through columns and workflow stages. The move path must not route through an agent action, invoke the executor, persist a new session binding, or issue `New Chat`. Creating a conversation is permitted only for the task's first agent run when no concrete conversation exists, or for an explicitly configured reset such as `chat.resetOnApprove`.

Acceptance criteria:
- A pure move from any column to another, through drag-and-drop or a detail-panel move control, changes only the task's workflow placement and move-related runtime/audit fields; it does not invoke the executor, open a new chat, or issue `workbench.action.chat.newChat`.
- A pure move preserves the task's existing `chat`, `copilot_session_id`, and `chat_reset_required` values exactly. If the task has no chat binding, moving it does not create or persist one.
- Stage runs never request `New Chat`. Opening the task-derived `vscode-chat-session://local` URI is the whole binding: the first open creates the task-unique session and every later open reopens that same conversation idempotently, so refine/develop/continue/validate all continue one conversation. Issuing `New Chat` on a stage run would instead spin the conversation off into a separate Copilot-managed chat divorced from the derived session, which is the defect this task fixes.
- `chat.resetOnApprove: true` remains the only path that issues `New Chat` or otherwise resets a conversation; with the setting disabled, approval and ordinary moves do not create or reset a conversation.
- Regression coverage proves that moving a task across at least two columns neither calls the executor nor changes its session identity, while first-use creation, subsequent reuse, and the explicit reset path retain their distinct behavior.

## Scope
- `src/board/boardPanel.ts`: keep drag/drop and detail-panel move controls on the `task/move` protocol, and ensure its handler calls only `RunManager.moveTask`; do not route a move through `action/invoke`, stage docking, or another agent-launch path.
- `src/board/actions.ts`: keep `moveTask()` as a state-only mutation that preserves `chat`, `copilot_session_id`, and `chat_reset_required`; retain only the existing move audit/status/run handling and do not add session or executor work.
- `src/chat/runManager.ts`: keep `moveTask()` free of stage starts, executor calls, persisted first-use chat creation, and reset calls; keep first-use `newChatBefore` calculation in `startStageRun`, reuse `sessionIdForTaskBinding()` for later stages, and leave `resetSession()` reachable only through the explicit configured reset policy.
- `src/chat/sessionUri.ts`: preserve the distinction between a missing/derived first-use binding and a persisted conversation, and ensure column or stage changes never alter the task-bound session URI.
- `src/test/runManager.test.ts`: add regression coverage for an idle task with an existing binding moved across columns and for an unbound task moved without executor or chat-command activity; extend stage-run assertions to cover first-run `New Chat`, later reuse after a move, and the configured approval reset.
- `src/test/boardPanel.test.ts`: exercise the board `task/move` message path from the move UI and assert it uses the move API rather than the action/stage invocation path; verify no executor or chat creation is triggered.

## Log
- audit:state-change at:2026-08-31T05:45:28Z task:TASK-005 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-31T05:45:31Z task:TASK-005 from:idle to:running action:refine run:rtq2hx4 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-31T05:45:31Z task:TASK-005 stage:refine action:refine run:rtq2hx4 note:"Started refine activity."
- progress run:rtq2hx4 task:TASK-005 at:2026-08-31T05:48:05Z note:"refine scoped move handling and chat-session reuse"
- run:rtq2hx4 task:TASK-005 stage:refine result:ok note:"2026-08-31T05:48:05Z — refine completed: defined chat reuse, reset boundaries, and regression coverage"
- audit:status-change at:2026-08-31T05:49:50Z task:TASK-005 from:running to:idle action:receipt run:rtq2hx4 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-31T05:49:50Z task:TASK-005 stage:refine action:receipt run:rtq2hx4 outcome:ok note:"2026-08-31T05:48:05Z — refine completed: defined chat reuse, reset boundaries, and regression coverage"
- audit:state-change at:2026-08-31T06:01:07Z task:TASK-005 from:refine to:scoped action:apply-pending run:rtq2hx4 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-31T06:01:11Z task:TASK-005 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-31T06:01:15Z task:TASK-005 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-31T06:01:15Z task:TASK-005 from:idle to:running action:develop run:rhdpd99 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-31T06:01:15Z task:TASK-005 stage:develop action:develop run:rhdpd99 note:"Started develop activity."
- progress run:rhdpd99 task:TASK-005 at:2026-08-31T06:15:43Z note:"added move-path and session-continuity regressions; focused and full VS Code tests pass"
- run:rhdpd99 task:TASK-005 stage:develop result:ok note:"2026-08-31T06:15:43Z — develop completed: added move-path and session-continuity regressions; compile, lint, focused, and full VS Code tests pass"
- audit:status-change at:2026-08-31T06:17:18Z task:TASK-005 from:running to:idle action:receipt run:rhdpd99 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-31T06:17:18Z task:TASK-005 stage:develop action:receipt run:rhdpd99 outcome:ok note:"2026-08-31T06:15:43Z — develop completed: added move-path and session-continuity regressions; compile, lint, focused, and full VS Code tests pass"
- audit:state-change at:2026-09-01T00:40:33Z task:TASK-005 from:in-progress to:validation action:apply-pending run:rhdpd99 outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:status-change at:2026-09-01T00:40:38Z task:TASK-005 from:idle to:running action:validate run:rv4k2mq note:"Status changed from idle to running via validate."
- audit:activity-start at:2026-09-01T00:40:38Z task:TASK-005 stage:validate action:validate run:rv4k2mq note:"Started validate activity."
- progress run:rv4k2mq task:TASK-005 at:2026-09-01T00:40:43Z note:"reviewing move and session-binding code against the amended acceptance criteria"
- progress run:rv4k2mq task:TASK-005 at:2026-09-01T00:43:33Z note:"full VS Code test suite green; acceptance criteria checked against the implementation"
- run:rv4k2mq task:TASK-005 stage:validate result:ok note:"2026-09-01T00:43:33Z — validation passed: all five acceptance criteria verified in code, the four move-path and session-continuity regressions are present, and the full VS Code suite passed with 360 tests and no failures"
- audit:status-change at:2026-09-01T00:43:33Z task:TASK-005 from:running to:idle action:receipt run:rv4k2mq outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T00:43:33Z task:TASK-005 stage:validate action:receipt run:rv4k2mq outcome:ok note:"2026-09-01T00:43:33Z — validation passed: all five acceptance criteria verified in code, the four move-path and session-continuity regressions are present, and the full VS Code suite passed with 360 tests and no failures"
- audit:state-change at:2026-09-01T07:24:30Z task:TASK-005 from:validation to:done action:move note:"State changed from validation to done via move."
