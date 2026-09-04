---
id: TASK-008
title: Add board-local find and filter controls
type: feature
state: done
status: idle
parent_task: TASK-003
position: 4
created: 2026-09-03T02:44:07Z
updated: 2026-09-04T02:25:27Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-008
copilot_session_id: 7972d762-6fd6-44e4-95de-f2e046872680
scope_hash: 80b18d7
origin_task: TASK-003
origin_run: rroucoq
---

## Request
Add board-local find and filter controls. A user who knows a task id, title fragment, type, status, or relationship should be able to locate matching cards across the current task-set projection without scanning every column or mutating task files, ordering, task-set selection, or workflow state.

_Filed automatically by TASK-003's run rroucoq._

## Refined

### Problem statement

The board currently renders the complete seven-column projection of the active task set, but locating a known task requires scanning cards manually. Add board-local find and filter controls that operate on the already loaded projection so a user can narrow cards by task ID, title fragment, task type, runtime status, or parent/child relationship. The controls are presentation state only: they must not persist query settings, read other task sets, or change task files, card ordering, task-set selection, or workflow state.

For this ticket, a relationship means the card's role in the valid active-set graph: `Parent` when it has one or more children, `Child` when it has a parent, and `Standalone` when it has neither. A card may match both `Parent` and `Child` when it is an intermediate node. A find query also checks the card's own task ID, title, and known parent task ID so a user who knows a related task can locate its child cards.

### Acceptance criteria

- The board exposes an accessible find field and independent Type, Status, and Relationship filters without requiring a task detail modal or a host-side search.
- With no query or filters, the board renders the same seven columns, card order, card actions, and counts as it does today.
- The find field matches task IDs, title fragments, and parent task IDs case-insensitively; whitespace-only input behaves like an empty query.
- Type filtering supports `All`, `Feature`, and `Bug`; status filtering supports `All` plus every existing runtime status (`idle`, `running`, `paused`, `blocked`, and `failed`); relationship filtering supports `All`, `Parent`, `Child`, and `Standalone`.
- Active criteria combine with AND semantics, and matching cards are located across every column of the current active task-set projection while each column and its original order remain present.
- Per-column visible counts and a board-level result summary reflect the filtered projection, and a clear no-results state is distinguishable from a genuinely empty column.
- Changing the query or any filter emits no webview-to-host mutation message and does not write or alter task content, frontmatter, positions, task-set selection, or workflow state. Existing actions on visible cards retain their current behavior.
- A same-task-set board refresh reapplies the current local query and filters to the fresh snapshot. Switching to another task set clears only the local find/filter state and leaves the existing task-set selection flow intact.
- Controls, result feedback, clear/reset behavior, and any filtered empty state are keyboard accessible, have usable labels/live status text, and remain usable at the board's existing narrow responsive breakpoint.
- The shared editor and browser board surfaces continue to render the same behavior; no server-side search API or new persisted protocol state is introduced.

## Scope
- [ ] Update `src/board/boardPanel.ts`'s generated board markup and stylesheet with an accessible board-local find control, clear/reset control, Type/Status/Relationship selectors, result summary, and responsive layout that fits the existing header/board surface.
- [ ] Keep query and filter values in webview-local state; normalize the query, define the canonical filter options from the existing task type/status data, and derive one AND-combined matcher over card ID, title, parent ID, type, status, and parent/child metadata.
- [ ] Extend the client-side board render path in `src/board/boardPanel.ts` to preserve the canonical seven columns and unfiltered card ordering while rendering only matching cards, updating visible counts and no-match/empty-column states, and safely retaining existing selection, card actions, drag/drop, and keyboard behavior.
- [ ] Reapply local controls when a fresh snapshot belongs to the same active task set, clear them when `activeTaskSetId` changes, and ensure control events never call `vscode.postMessage` or enter the host mutation handler.
- [ ] Add focused webview/JSDOM coverage in `src/test/boardPanel.test.ts` using cards distributed across columns and all supported type/status/relationship cases: default rendering, case-insensitive ID/title/parent-ID find, each filter, AND combinations, parent-plus-child nodes, standalone cards, counts, clear/reset, no results, same-set refresh, and task-set switch reset.
- [ ] In the same tests, capture webview messages and task-file metadata around control changes to prove filtering is projection-only and does not invoke task selection, movement, reorder, action, task-set, or edit operations; retain regression coverage for visible-card interactions.
- [ ] Update the board-local webview documentation in `docs/PRD.md` §6.11 and the user-facing board guidance in `docs/board-guide.md` to define the local controls, matching fields, relationship semantics, refresh behavior, accessibility expectations, and no-new-message/no-persistence boundary.
- [ ] Verify the existing `BrowserBoardSurface` path continues to serve the same generated document and that no changes are needed in `src/board/boardSurface.ts` or `src/http/browserBoardSurface.ts`.

## Log
- audit:state-change at:2026-09-03T03:07:21Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T03:07:29Z task:TASK-008 from:idle to:running action:refine run:rkm6brx note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T03:07:29Z task:TASK-008 stage:refine action:refine run:rkm6brx note:"Started refine activity."
- progress run:rkm6brx task:TASK-008 at:2026-09-03T03:08:56Z note:"documented board-local find and filter behavior and verification boundaries"
- run:rkm6brx task:TASK-008 stage:refine result:ok note:"2026-09-03T03:08:56Z — refined board-local query and type, status, and relationship filtering with a focused implementation checklist"
- audit:status-change at:2026-09-03T03:11:14Z task:TASK-008 from:running to:idle action:receipt run:rkm6brx outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T03:11:14Z task:TASK-008 stage:refine action:receipt run:rkm6brx outcome:ok note:"2026-09-03T03:08:56Z — refined board-local query and type, status, and relationship filtering with a focused implementation checklist"
- audit:state-change at:2026-09-03T03:12:05Z task:TASK-008 from:refine to:scoped action:apply-pending run:rkm6brx outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T03:12:06Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T03:12:07Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T03:12:07Z task:TASK-008 from:idle to:running action:develop run:riekn58 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T03:12:07Z task:TASK-008 stage:develop action:develop run:riekn58 note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-008 expected-run:riekn58 expected-stage:develop actual-run:rkm6brx actual-task:TASK-008 actual-stage:refine note:"Ignored receipt because run id rkm6brx is stale; expected riekn58."
- run:riekn58 task:TASK-008 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-03T03:32:08Z task:TASK-008 from:running to:failed action:timeout run:riekn58 outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-03T03:32:08Z task:TASK-008 stage:develop run:riekn58 outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- audit:state-change at:2026-09-04T02:25:27Z task:TASK-008 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
- audit:status-change at:2026-09-04T02:25:27Z task:TASK-008 from:failed to:idle action:move note:"Status changed from failed to idle via move."
