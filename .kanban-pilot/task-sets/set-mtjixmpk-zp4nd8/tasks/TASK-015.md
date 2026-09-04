---
id: TASK-015
title: Transform Board Notices into Workspace Activity messages
type: feature
state: validation
status: idle
position: 1
created: 2026-09-04T05:27:43Z
updated: 2026-09-04T11:02:46Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-015
copilot_session_id: f98447dd-62fa-47a2-83b8-29d425e638cf
scope_hash: 9285380
chat_reset_required: false
---

## Request
so instead of board notices, I want to add a Workspace Activity that will show a history of board activities. It should be a button next to Task Set which show a modal. The modal should show a simple Workspace Activity History

## Refined

### Problem statement

The board currently exposes selected host outcomes through a transient `board/notice` banner. A
notice disappears on refresh, cannot be reviewed later, and only communicates the latest message.
Replace that board-only notification surface with a persistent, read-only **Workspace Activity
History**. A button beside the Task set controls must open a modal showing the recent activity for
the active task set, so users can understand what the board reported without reopening a task or
repeating an action.

For this slice, “board activity” means the user-visible notices currently emitted by pending
completion and stale-completion recovery flows. Existing task-detail audit/progress/transcript
feeds remain task-scoped and unchanged. Activity is isolated to the active task set, survives a
board reload, and is bounded to the newest 100 entries.

### Assumptions and boundary

1. Each entry stores a UTC timestamp, `success`/`warning`/`error` level, sanitized message, and
	the related task id/title when available; the modal renders newest first.
2. Activity is persisted in a task-set-keyed store under `.kanban-pilot/workspace-activity/` and is
	not a second task model. Switching task sets switches the history source and never mixes entries.
3. The former board-notice path records one activity entry and no longer posts `board/notice` or
	renders the transient banner. Existing host error toasts may remain for diagnostics.
4. The history contains no Copilot prompts, transcript text, tool payloads, credentials, or absolute
	paths. It is read-only: opening, closing, or refreshing the modal never mutates task files.

### SPLIT RECOMMENDATION

SPLIT RECOMMENDATION: NO SPLIT — 1 feature

The single feature is a persisted active-task-set Workspace Activity History surface that replaces
the board notice banner.

### Acceptance Criteria

1. The board header places an accessible **Workspace Activity** button beside the Task set controls.
2. Activating the button opens a modal titled **Workspace Activity History** with the active
	task-set name, a newest-first list, and a clear empty state when no activity exists.
3. Each rendered row shows its timestamp, level, message, and task context when supplied; malformed
	or over-limit records do not break the board and only the newest 100 valid entries are shown.
4. Pending-completion and stale-recovery outcomes that previously used `board/notice` appear once in
	the history with their original level/message, and no board-notice banner/message is emitted.
5. Closing the modal via its close control, Escape, backdrop, or a task-set refresh behaves safely;
	opening it again reads persisted entries after reload, and switching sets shows only the selected
	set’s history.
6. The same button, modal, data, and message protocol work in the VS Code board and browser board;
	existing task actions and task-detail activity behavior remain unchanged.

## Scope

1. Add `src/model/workspaceActivity.ts` with the activity record type, validation/sanitization,
	append-only persistence, bounded newest-first reads, malformed-record tolerance, and a stable
	task-set-keyed file location under `.kanban-pilot/workspace-activity/`.
2. Update `src/extension.ts` so `WorkspaceTaskSetContext` owns the activity store for the active
	set, exposes it through the board host contract, replaces it on task-set switches, and emits a
	refresh signal when a new entry is recorded.
3. Update `src/board/boardPanel.ts` to add the `Workspace Activity` header control and accessible
	modal, render the active-set history and empty/loading states, refresh it on new activity, and
	replace `reportBoardNotice` calls in pending/recovery handling with a persisted activity write
	carrying level, message, and task context. Remove the board-notice markup, styling, renderer,
	and message handling while preserving existing host diagnostics and task-detail feeds.
4. Add `src/test/workspaceActivity.test.ts` covering persistence, validation, ordering, the 100-row
	limit, malformed data, and isolation between task-set ids.
5. Extend `src/test/boardPanel.test.ts` to cover button/modal accessibility and lifecycle, empty and
	populated histories, replacement of success/warning/error notices, task-set switching, and
	reload-safe rendering. Extend `src/test/realtimeBoardServer.integration.test.ts` to confirm the
	shared browser surface receives the same activity state without leaking another task set.
6. Update `docs/board-guide.md` and `docs/http-endpoint.md` to document Workspace Activity History,
	active-task-set isolation, persistence/retention, and removal of the transient board notice
	surface. Do not hand-edit generated `dist-test` output.
## Log
- audit:state-change at:2026-09-04T05:29:05Z task:TASK-015 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-04T05:29:08Z task:TASK-015 from:idle to:running action:refine run:rpshtvu note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-04T05:29:08Z task:TASK-015 stage:refine action:refine run:rpshtvu note:"Started refine activity."
- progress run:rpshtvu task:TASK-015 at:2026-09-04T05:31:36Z note:"refinement completed with an active-task-set activity-history scope"
- run:rpshtvu task:TASK-015 stage:refine result:ok note:"2026-09-04T05:31:36Z — refined the Workspace Activity History feature and documented its implementation scope"
- audit:status-change at:2026-09-04T05:33:47Z task:TASK-015 from:running to:idle action:receipt run:rpshtvu outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-04T05:33:47Z task:TASK-015 stage:refine action:receipt run:rpshtvu outcome:ok note:"2026-09-04T05:31:36Z — refined the Workspace Activity History feature and documented its implementation scope"
- audit:state-change at:2026-09-04T05:37:24Z task:TASK-015 from:refine to:scoped action:apply-pending run:rpshtvu outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-04T05:37:25Z task:TASK-015 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-04T05:37:26Z task:TASK-015 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T05:37:26Z task:TASK-015 from:idle to:running action:develop run:rzk0nv0 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T05:37:26Z task:TASK-015 stage:develop action:develop run:rzk0nv0 note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-015 expected-run:rzk0nv0 expected-stage:develop actual-run:rpshtvu actual-task:TASK-015 actual-stage:refine note:"Ignored receipt because run id rpshtvu is stale; expected rzk0nv0."
- run:rzk0nv0 task:TASK-015 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-04T05:57:27Z task:TASK-015 from:running to:failed action:timeout run:rzk0nv0 outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-04T05:57:27Z task:TASK-015 stage:develop run:rzk0nv0 outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- progress run:rzk0nv0 task:TASK-015 at:2026-09-04T06:01:16Z note:"final validation completed for Workspace Activity implementation"
- run:rzk0nv0 task:TASK-015 stage:develop result:ok note:"2026-09-04T06:01:16Z — implemented Workspace Activity History and passed compilation, lint, full tests, and packaging validation"
- implementation-evidence run:rzk0nv0 files:"src/model/workspaceActivity.ts,src/extension.ts,src/board/boardPanel.ts,src/test/workspaceActivity.test.ts,src/test/boardPanel.test.ts,src/test/extension.test.ts,src/test/realtimeBoardServer.integration.test.ts,docs/board-guide.md,docs/http-endpoint.md" verify:"npm test and npm run package"
- audit:status-change at:2026-09-04T06:01:30Z task:TASK-015 from:failed to:blocked action:late-receipt run:rzk0nv0 outcome:blocked note:"Status changed from failed to blocked via late-receipt."
- audit:activity-finish at:2026-09-04T06:01:30Z task:TASK-015 stage:develop action:late-receipt run:rzk0nv0 outcome:blocked correction:true note:"Develop completion requires implementation evidence with changed files and verification."
- audit:state-change at:2026-09-04T11:02:46Z task:TASK-015 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-04T11:02:46Z task:TASK-015 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
