---
id: TASK-005
title: Tasks lose connection to their chats when closing or reloading the Kanban Pilot UI
type: bug
state: validation
status: idle
position: 3
created: 2026-08-20T09:30:58Z
updated: 2026-08-20T10:39:58Z
chat: kanban-pilot-set-mt022q8z-a5m5we-TASK-005
copilot_session_id: 43fb3e3b-d1c6-40ad-9131-570994ede83e
scope_hash: 9a24831
chat_reset_required: true
---

## Request
Given a task has an idle or ongoing chat,when the Kanban Pilot UI reloads or is closed
When I check a task's chat
Then it should show the previous connect chat to it

## Refined

Kanban Pilot must treat a task's persisted chat binding as durable identity, not as UI state. After a task has an idle conversation or an active run, closing or reloading the Kanban Pilot board (including extension/window activation) must not make the task's Open Chat action or the next stage run derive a different session. Reopening the task must target the same VS Code/Copilot chat so its earlier transcript and any ongoing conversation remain available; this does not require mirroring the transcript inside the board.

**Acceptance criteria**
- A task with an existing idle chat opens the same chat session and shows its previous transcript after the board is closed and reopened or its webview is reloaded; it does not create a blank or second conversation.
- A task with an ongoing chat/run resolves to that same session after the board or extension is reloaded. Reopening the chat does not start a second conversation, overwrite the persisted task/run association, or bypass the existing run-reconciliation behavior.
- The explicit Open Chat command, the board detail's Open Chat action, and stage-run/Continue chat injection all resolve the same way: reuse the task's persisted `chat` id when present, including for existing tasks and after a session-prefix configuration change.
- A task without a persisted chat receives one stable task/set-specific binding on first chat creation, and tasks with the same id in different task sets cannot open one another's conversations.
- Regression tests cover idle and running tasks across a recreated/reloaded manager, persisted and first-use bindings, and the URI/session passed to both docking and injection paths.

## Scope
- [ ] `src/chat/sessionUri.ts` — add or expose one shared resolver that prefers a task's persisted chat id and otherwise derives the stable task/set session id; preserve the existing URI encoding and task-set isolation rules.
- [ ] `src/chat/runManager.ts` — make docking, stage-run setup, and session-reset/open paths load and reuse the persisted binding; persist the derived fallback when a task is opened for the first time; ensure tab closing and all manager-owned chat actions use the same resolved URI.
- [ ] `src/chat/executor.ts` — route the immediate `vscode.open` used before prompt injection through the shared binding resolver so stage runs cannot jump to a new chat after reload or configuration changes.
- [ ] `src/test/runManager.test.ts` — add lifecycle regressions that recreate the manager after board/window reload, cover idle and running tasks, verify persisted chat ids survive, and assert docking/reset/continuation target the original session without duplicate opens.
- [ ] `src/test/executor.test.ts` — verify persisted-chat and first-use fallback URIs are used by the injection executor, including named task-set isolation.
- [ ] `src/test/taskStore.test.ts` — verify the `chat` frontmatter binding survives the atomic patch and read-back path used when the first session is established; retain all unrelated task metadata.
- [ ] Run the focused chat/session tests, then the full compile, lint, and test suite; manually smoke-test close/reopen and webview reload with both an idle task chat and an active run.

## Log
- audit:state-change at:2026-08-20T09:31:00Z task:TASK-005 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T09:31:01Z task:TASK-005 from:idle to:running action:refine run:ryjjrj3 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T09:31:01Z task:TASK-005 stage:refine action:refine run:ryjjrj3 note:"Started refine activity."
- run:ryjjrj3 task:TASK-005 stage:refine result:ok note:"2026-08-20T09:32:58Z — refinement completed: documented durable chat-binding behavior and the session-layer regression scope"
- audit:status-change at:2026-08-20T09:34:19Z task:TASK-005 from:running to:idle action:receipt run:ryjjrj3 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T09:34:19Z task:TASK-005 stage:refine action:receipt run:ryjjrj3 outcome:ok note:"2026-08-20T09:32:58Z — refinement completed: documented durable chat-binding behavior and the session-layer regression scope"
- audit:state-change at:2026-08-20T09:39:42Z task:TASK-005 from:refine to:scoped action:apply-pending run:ryjjrj3 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-20T09:39:44Z task:TASK-005 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-20T09:39:46Z task:TASK-005 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-20T09:39:46Z task:TASK-005 from:idle to:running action:develop run:rmaqbdn note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-20T09:39:46Z task:TASK-005 stage:develop action:develop run:rmaqbdn note:"Started develop activity."
- run:rmaqbdn task:TASK-005 stage:develop result:ok note:"2026-08-20T09:55:51Z — implemented durable persisted task-chat resolution across docking, stage injection, reset, tab close, and reload regression coverage"
- audit:status-change at:2026-08-20T09:57:18Z task:TASK-005 from:running to:idle action:receipt run:rmaqbdn outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T09:57:18Z task:TASK-005 stage:develop action:receipt run:rmaqbdn outcome:ok note:"2026-08-20T09:55:51Z — implemented durable persisted task-chat resolution across docking, stage injection, reset, tab close, and reload regression coverage"
- audit:state-change at:2026-08-20T10:01:25Z task:TASK-005 from:in-progress to:validation action:apply-pending run:rmaqbdn outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:status-change at:2026-08-20T10:04:33Z task:TASK-005 from:idle to:running action:validate run:rlupk06 note:"Status changed from idle to running via validate."
- audit:activity-start at:2026-08-20T10:04:33Z task:TASK-005 stage:validate action:validate run:rlupk06 note:"Started validate activity."
- run:rlupk06 task:TASK-005 stage:validate result:failed note:"2026-08-20T10:09:55Z — validation failed: focused chat/session suites passed with 195 tests and the full compile, webpack, lint, and integration suite passed with 285 tests, but explicit Open Chat returns when layout.dockChat is false, so the command and detail action cannot open or persist the task chat in that configuration"
- audit:status-change at:2026-08-20T10:14:13Z task:TASK-005 from:running to:idle action:receipt run:rlupk06 outcome:failed note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T10:14:13Z task:TASK-005 stage:validate action:receipt run:rlupk06 outcome:failed note:"2026-08-20T10:09:55Z — validation failed: focused chat/session suites passed with 195 tests and the full compile, webpack, lint, and integration suite passed with 285 tests, but explicit Open Chat returns when layout.dockChat is false, so the command and detail action cannot open or persist the task chat in that configuration"
- audit:state-change at:2026-08-20T10:15:02Z task:TASK-005 from:validation to:in-progress action:apply-pending run:rlupk06 outcome:failed note:"State changed from validation to in-progress via apply-pending."
- audit:status-change at:2026-08-20T10:20:08Z task:TASK-005 from:idle to:running action:continue run:rb977yi note:"Status changed from idle to running via continue."
- audit:activity-start at:2026-08-20T10:20:08Z task:TASK-005 stage:develop action:continue run:rb977yi note:"Started develop activity."
- run:rb977yi task:TASK-005 stage:develop result:ok note:"2026-08-20T10:20:30Z — develop completed: explicit Open Chat now bypasses automatic docking gates, persists its durable binding, and opens the resolved session when docking is disabled; focused tests and the full 286-test suite pass"
- audit:status-change at:2026-08-20T10:20:38Z task:TASK-005 from:running to:idle action:receipt run:rb977yi outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T10:20:38Z task:TASK-005 stage:develop action:receipt run:rb977yi outcome:ok note:"2026-08-20T10:20:30Z — develop completed: explicit Open Chat now bypasses automatic docking gates, persists its durable binding, and opens the resolved session when docking is disabled; focused tests and the full 286-test suite pass"
- audit:state-change at:2026-08-20T10:39:58Z task:TASK-005 from:in-progress to:validation action:apply-pending run:rb977yi outcome:ok note:"State changed from in-progress to validation via apply-pending."
