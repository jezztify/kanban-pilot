---
id: TASK-007
title: Task Details view always scrolls to the top when task is actively being worked on
type: bug
state: validation
status: idle
position: 1
created: 2026-08-26T06:43:53Z
updated: 2026-08-26T08:04:00Z
chat: 723cc62a-7dde-4505-ac7f-48d02c54b368
copilot_session_id: 723cc62a-7dde-4505-ac7f-48d02c54b368
scope_hash: 9f4888d
chat_reset_required: false
---

## Request
The Task Details view always scrolls to the top when task is actively being worked on by an LLM. This makes it hard to read

## Refined

While the Task Details modal is open, task-file changes generated during an active LLM run (for example progress and log updates) cause the host to send a fresh `task/detail` payload. The webview handles every payload by rebuilding the modal from scratch, replacing its scrollable body and resetting that body's scroll position to the top. As a result, a user reading lower content is repeatedly interrupted whenever the running task updates.

**Acceptance criteria**
- When the open Task Details view receives a refresh for the same task, its vertical reading position is preserved instead of jumping to the top, including repeated progress/log updates while the task is running.
- Refreshed task content, status, activity, actions, and rendered Markdown/Mermaid still update normally; preserving scroll must not leave the visible detail stale.
- The restored position is bounded to the refreshed content's valid scroll range so shorter content does not produce an invalid or blank position.
- Opening a different task, closing and reopening Task Details, or initially opening a task starts at the top rather than inheriting another view's position.
- Existing edit-mode, close/deselect, keyboard, and modal behavior remains unchanged.
- Automated coverage reproduces a same-task detail refresh after scrolling, verifies position preservation, and verifies the reset cases.

## Scope

- [ ] `src/board/boardPanel.ts` — update the shared Task Details webview rendering flow to capture the current `.modal-body` scroll position before replacing same-task content and restore it after the refreshed body is attached, clamped to the new scrollable range.
- [ ] `src/board/boardPanel.ts` — track enough detail-view identity/lifecycle state to distinguish a live refresh of the currently open task from first open, task switch, close/reopen, and edit-mode transitions; reset retained position when continuity ends.
- [ ] `src/board/boardPanel.ts` — keep refreshed content and asynchronous Mermaid rendering intact, and avoid introducing focus changes or extra host messages during scroll restoration.
- [ ] `src/test/boardPanel.test.ts` — add deterministic webview tests that open a detail view, simulate a nonzero body scroll, dispatch a refreshed payload for the same task, and assert the position is retained and clamped when content shrinks.
- [ ] `src/test/boardPanel.test.ts` — cover initial open, switching tasks, and close/reopen to ensure those flows start at the top and do not reuse stale scroll state.
- [ ] Run compile, lint, and the board/webview test suite to confirm the fix does not regress Task Details rendering or interactions.

## Log
- audit:state-change at:2026-08-26T06:43:57Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T06:43:58Z task:TASK-007 from:idle to:running action:refine run:r45fxsu note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T06:43:58Z task:TASK-007 stage:refine action:refine run:r45fxsu note:"Started refine activity."
- run:r45fxsu task:TASK-007 stage:refine result:ok note:"Scoped same-task detail refresh scroll preservation, reset behavior, and deterministic webview coverage"
- audit:status-change at:2026-08-26T06:45:20Z task:TASK-007 from:running to:idle action:receipt run:r45fxsu outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T06:45:20Z task:TASK-007 stage:refine action:receipt run:r45fxsu outcome:ok note:"Scoped same-task detail refresh scroll preservation, reset behavior, and deterministic webview coverage"
- audit:state-change at:2026-08-26T06:45:58Z task:TASK-007 from:refine to:scoped action:apply-pending run:r45fxsu outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T06:46:00Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T06:46:04Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T06:46:04Z task:TASK-007 from:idle to:running action:develop run:re9p4jy note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T06:46:04Z task:TASK-007 stage:develop action:develop run:re9p4jy note:"Started develop activity."
- run:re9p4jy task:TASK-007 stage:develop result:ok note:"Preserved and clamped same-task detail scroll while resetting lifecycle transitions with deterministic webview coverage"
- audit:status-change at:2026-08-26T06:51:37Z task:TASK-007 from:running to:idle action:receipt run:re9p4jy outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T06:51:37Z task:TASK-007 stage:develop action:receipt run:re9p4jy outcome:ok note:"Preserved and clamped same-task detail scroll while resetting lifecycle transitions with deterministic webview coverage"
- audit:state-change at:2026-08-26T08:04:00Z task:TASK-007 from:in-progress to:validation action:apply-pending run:re9p4jy outcome:ok note:"State changed from in-progress to validation via apply-pending."
