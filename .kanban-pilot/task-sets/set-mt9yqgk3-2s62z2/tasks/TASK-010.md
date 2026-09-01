---
id: TASK-010
title: when tasks are in-progress, the webview tends to refresh all the time
type: bug
state: done
status: idle
position: 5
created: 2026-08-26T21:18:49Z
updated: 2026-08-27T21:07:20Z
chat: eeeff8c6-0bd4-447b-9ba3-596226140008
copilot_session_id: eeeff8c6-0bd4-447b-9ba3-596226140008
scope_hash: 0c65bc1
chat_reset_required: false
---

## Request
all modals get closed automatically. all screens auto scroll to the left. all screens auto scroll to the top.

## Refined

When a task is running, task-file watcher events repeatedly call the board's
full refresh path. The client rebuilds the board and task-detail DOM for each
update, which resets the board's horizontal scroll position and closes or
recreates open task-detail, settings, and new-task modals. Refreshes must
continue to reflect live task status and log updates, but must preserve the
user's transient view state unless the user explicitly closes a modal, changes
task set, or the selected task is no longer available.

**Acceptance criteria**
- While any task is in progress and watcher-driven updates arrive, the board
	shows the latest task state, status, and card content without reloading the
	webview document or resetting its scroll position.
- A board refresh preserves both the board's horizontal `scrollLeft` and each
	column card list's vertical `scrollTop`, clamping a restored value only when
	the refreshed content no longer supports that offset.
- An open task-detail modal remains open for its selected task across
	background updates, and its displayed task data refreshes without losing the
	intended modal state.
- An open Settings or New Task modal remains open across unrelated task
	updates; an in-progress New Task form keeps its entered title, description,
	type, and staged attachments.
- Explicit close, successful creation, task-set switching, and removal of the
	selected task retain their existing behavior. Rendering updates remain safe
	when several watcher events arrive in quick succession.

## Scope

- [ ] `src/board/boardPanel.ts` — inspect and narrow the watcher-driven
	`pushAll()` refresh path so task changes publish only the view data that must
	change, without treating every update as a complete client reset.
- [ ] `src/board/boardPanel.ts` — preserve and restore the board container's
	horizontal scroll offset alongside the existing per-column vertical scroll
	preservation during `board/state` rendering, including post-layout clamping.
- [ ] `src/board/boardPanel.ts` — make task-detail rendering idempotent for an
	already open selected task, preserving the modal rather than closing
	unrelated Settings or New Task dialogs on background state messages.
- [ ] `src/board/boardPanel.ts` — retain New Task draft/form and attachment
	state across task updates, while keeping existing explicit modal close and
	successful-create cleanup behavior.
- [ ] `src/test/boardPanel.test.ts` — add DOM-level coverage for repeated
	`board/state`, `task/detail`, and `settings/state` messages while a task is
	running: horizontal and vertical scroll retention, modal persistence, draft
	retention, explicit close/create behavior, and rapid consecutive updates.
- [ ] Run the relevant board-panel tests and the existing compile, lint, and
	test checks to verify that live status updates still render correctly.

## Log
- audit:state-change at:2026-08-26T21:18:51Z task:TASK-010 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T21:18:53Z task:TASK-010 from:idle to:running action:refine run:roadayw note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T21:18:53Z task:TASK-010 stage:refine action:refine run:roadayw note:"Started refine activity."
- run:roadayw task:TASK-010 stage:refine result:ok note:"Scoped watcher-driven refresh preservation for scroll positions and open modal state."
- audit:status-change at:2026-08-26T21:19:46Z task:TASK-010 from:running to:idle action:receipt run:roadayw outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T21:19:46Z task:TASK-010 stage:refine action:receipt run:roadayw outcome:ok note:"Scoped watcher-driven refresh preservation for scroll positions and open modal state."
- audit:state-change at:2026-08-26T21:24:07Z task:TASK-010 from:refine to:scoped action:apply-pending run:roadayw outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T21:24:10Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T21:24:11Z task:TASK-010 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T21:24:11Z task:TASK-010 from:idle to:running action:develop run:r0vjjnc note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T21:24:11Z task:TASK-010 stage:develop action:develop run:r0vjjnc note:"Started develop activity."
- run:r0vjjnc task:TASK-010 stage:develop result:ok note:"Preserved watcher-refresh scroll positions and open modal or draft state, with regression coverage."
- audit:status-change at:2026-08-26T21:30:37Z task:TASK-010 from:running to:idle action:receipt run:r0vjjnc outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T21:30:37Z task:TASK-010 stage:develop action:receipt run:r0vjjnc outcome:ok note:"Preserved watcher-refresh scroll positions and open modal or draft state, with regression coverage."
- audit:state-change at:2026-08-26T23:13:37Z task:TASK-010 from:in-progress to:validation action:apply-pending run:r0vjjnc outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-08-26T23:14:19Z task:TASK-010 from:validation to:in-progress action:move note:"State changed from validation to in-progress via move."
- audit:state-change at:2026-08-27T21:07:20Z task:TASK-010 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
