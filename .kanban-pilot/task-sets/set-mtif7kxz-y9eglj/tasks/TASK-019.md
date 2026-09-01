---
id: TASK-019
title: Task Details: Buttons are inconsistent
type: feature
state: done
status: idle
position: 11
created: 2026-09-01T23:29:56Z
updated: 2026-09-02T02:17:31Z
chat: kanban-pilot-set-mtif7kxz-y9eglj-TASK-019
copilot_session_id: 90fa606c-0387-44e6-94c7-494761d2d651
scope_hash: ac283e3
chat_reset_required: false
---

## Request
When opening up the task details, the button next to "Open Chat" is inconsistent
1. Backlog - None (Should be Accept)
2. Refine (not in progress) - None (Should be Refine)
3. Refine (after refine) - Apply... (correct)
4. Scoped - Refine (Should be Approve)
5. Develop - None (Should be Develop)

## Refined
### Problem statement

The task-detail modal does not use the same state-and-status primary-action matrix as the board cards. Its payload currently exposes only secondary actions, so ordinary actions are missing in Backlog, idle Refine, and Approved, while Scoped exposes its secondary redo-scope Refine action where the primary Approve action should be. The pending completion action shown after a completed Refine run must remain the preferred action for that pending state.

### Acceptance criteria

- The action immediately following Open Chat in the task-detail modal matches the existing primary-action matrix for the task's current state and status: Backlog/idle shows Accept, Refine/idle shows Refine, Scoped/idle shows Approve, and Approved/idle shows Develop.
- The remaining primary-action rows continue to resolve consistently, including Stop while a run is active, retry actions for blocked or failed runs, Continue in In Progress, Validate in Validation, and no primary action in Done.
- When a receipt completion is pending, Apply <pending label> remains the preferred action in that position and the normal primary action is not duplicated alongside it.
- Scoped keeps its redo-scope Refine action as a separate secondary detail action after the primary Approve action; Done keeps Reopen as its secondary action.
- The same action ordering and behavior is used when the task detail is switched into edit mode.
- Activating a displayed primary or secondary action emits the existing action/invoke intent with the correct task id and action; state transitions remain host-side.
- Focused webview tests cover the listed state/status cases, pending-action precedence, Scoped's two actions, edit-mode parity, and emitted action messages.

## Scope
- [ ] `src/board/boardPanel.ts`: include the state/status-derived primary action in the task-detail payload sent by `pushDetail`, using the existing `primaryAction` mapping and action labels.
- [ ] `src/board/boardPanel.ts`: centralize or otherwise keep the task-detail action rendering in `renderDetail` and `renderEditDetail` consistent, placing the pending Apply action first when present and otherwise placing the primary action immediately after Open Chat while preserving stale-completion controls and secondary actions.
- [ ] `src/test/boardPanel.test.ts`: extend detail payload fixtures and add focused DOM assertions for Backlog Accept, idle Refine Refine, pending Refine Apply, Scoped Approve plus secondary Refine, and Approved Develop, including click-to-`action/invoke` messages.
- [ ] `src/test/boardPanel.test.ts`: verify the remaining primary-action matrix and edit-mode parity so the detail fix does not regress Stop, Continue, Validate, Done/Reopen, or the existing pending completion flow.

## Log
- audit:state-change at:2026-09-01T23:30:08Z task:TASK-019 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-01T23:30:10Z task:TASK-019 from:idle to:running action:refine run:rz6nmi4 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-01T23:30:10Z task:TASK-019 stage:refine action:refine run:rz6nmi4 note:"Started refine activity."
- progress run:rz6nmi4 task:TASK-019 at:2026-09-01T23:31:35Z note:"documented the detail action behavior and implementation boundaries"
- run:rz6nmi4 task:TASK-019 stage:refine result:ok note:"2026-09-01T23:31:35Z — refine completed: aligned task-detail action scope with the existing primary action matrix"
- audit:status-change at:2026-09-01T23:37:23Z task:TASK-019 from:running to:idle action:receipt run:rz6nmi4 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T23:37:23Z task:TASK-019 stage:refine action:receipt run:rz6nmi4 outcome:ok note:"2026-09-01T23:31:35Z — refine completed: aligned task-detail action scope with the existing primary action matrix"
- audit:state-change at:2026-09-01T23:43:49Z task:TASK-019 from:refine to:scoped action:apply-pending run:rz6nmi4 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-01T23:43:54Z task:TASK-019 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T23:43:57Z task:TASK-019 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-01T23:43:57Z task:TASK-019 from:idle to:running action:develop run:rnyrhop note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-01T23:43:57Z task:TASK-019 stage:develop action:develop run:rnyrhop note:"Started develop activity."
- run:rnyrhop task:TASK-019 stage:develop result:ok note:"2026-09-01T23:48:49Z — implemented consistent task-detail primary action payload and read/edit modal ordering with focused board-panel coverage"
- audit:status-change at:2026-09-01T23:52:17Z task:TASK-019 from:running to:idle action:receipt run:rnyrhop outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T23:52:17Z task:TASK-019 stage:develop action:receipt run:rnyrhop outcome:ok note:"2026-09-01T23:48:49Z — implemented consistent task-detail primary action payload and read/edit modal ordering with focused board-panel coverage"
- audit:state-change at:2026-09-02T02:17:29Z task:TASK-019 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:state-change at:2026-09-02T02:17:31Z task:TASK-019 from:validation to:done action:move note:"State changed from validation to done via move."
