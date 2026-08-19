---
id: TASK-007
title: Drag-and-drop ordering of tasks
type: feature
state: done
status: idle
created: 2026-08-17T09:17:11Z
updated: 2026-08-17T23:58:00Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-007
copilot_session_id: 70cb5364-3e40-4687-bd8d-5a5c73d60d3f
scope_hash: f863122
chat_reset_required: true
---

## Request
I want to be modify the tasks' order by dragging and dropping them

## Refined

### Problem statement

The board already lets a user drag a card to a different workflow column, but cards within a column are currently rendered in task-file/ID order and cannot be prioritised. Interpret this request as adding user-controlled relative ordering within each column: a user should be able to drag a card above or below its peers, have that order survive board reloads and extension restarts, and keep the ordering independent for each task set. This must not turn prioritisation into a workflow transition or start, stop, or resume an agent run.

The persisted representation will be an extension-owned numeric `position` value in task frontmatter, interpreted relative to the task's current column. Legacy tasks without that value must continue to display deterministically and new tasks must be placed at the end of their column. Existing cross-column drag behaviour remains a manual state move; this ticket adds ordering to the cards in a column rather than redefining the workflow.

### Acceptance criteria

- With at least two cards in one column, dragging a card above or below another card changes the visible relative order. The UI provides a clear insertion/drop target and supports moving a card to the first or last position.
- A completed reorder is persisted for the active task set and is restored after the board is re-rendered, the panel is reloaded, or the extension is restarted. Orders from different task sets never affect one another.
- Reordering a card within its current column changes only ordering metadata. Its state, status, active run, chat/session metadata, title, and body sections remain unchanged; no stage action, gate policy, receipt, or agent run is triggered.
- A drop that leaves the card in the same position is a no-op and does not rewrite task files. Unknown task IDs, invalid destinations/indices, and stale drop targets are rejected without losing or duplicating cards.
- Tasks created after ordering has been established appear at the end of their column. Existing task files without ordering metadata remain visible in a deterministic order; duplicate or invalid positions have a deterministic tie-breaker and can be normalised by the next successful reorder.
- Dropping onto a different column continues to use the existing manual move semantics (including its status/run reset and no automatic stage launch); it must not regress while same-column ordering is added.
- The same reorder operation has a non-mouse keyboard equivalent for a focused card, with accessible labels/focus treatment and an announcement or other visible confirmation of the new position.
- Automated tests cover persistence, legacy/default ordering, task-set isolation, no-op/invalid requests, preservation of task content and runtime metadata, and the webview protocol/rendering path.

## Scope

1. **Task schema and persistence**
	- Update `src/model/task.ts` to model an optional numeric `position` frontmatter field, parse only valid values, include it in the extension-owned key order, and preserve compatibility with existing task files.
	- Update `src/model/taskStore.ts` to define the deterministic fallback ordering for legacy/malformed positions, sort each snapshot column by position, append new tasks at the end, and provide a serialized/batched reorder operation that rewrites ordering metadata atomically while preserving each task body and unrelated frontmatter.
	- Ensure ordering is scoped to the `TaskStore`/active task-set directory and that moving a task into another column assigns it an appropriate end position rather than inheriting an invalid relative position.

2. **Validated extension-host operation**
	- Add a dedicated reorder outcome/operation in `src/board/actions.ts` that validates task identity, current column, target index or insertion anchor, same-position no-ops, and stale/unknown targets without invoking the state machine.
	- Expose the operation through `src/chat/runManager.ts` (or the shared host boundary used by the board) under the existing concurrency/admission mutex. A same-column reorder must not release or invalidate an active run; preserve the existing `moveTask` path for cross-column moves.

3. **Board protocol and interaction**
	- Extend `src/board/boardPanel.ts`'s message contract with a same-column reorder intent carrying an insertion index or stable neighbouring-task anchor, and route it through the validated host operation. Keep cross-column `task/move` handling and task-set switching unchanged.
	- Refactor the webview drag/drop rendering to target positions between cards (including the beginning and end of a column), show a visual insertion marker, avoid starting a drag from card controls, and refresh from the filesystem projection after a drop rather than maintaining client-side order.
	- Add the keyboard equivalent for moving the focused card up/down, appropriate `aria` labels/focus styles, and a status/`aria-live` confirmation. Cover empty and single-card columns without creating unusable drop zones.

4. **Verification**
	- Extend `src/test/taskStore.test.ts` for position parsing, deterministic legacy fallback, append-on-create, persisted reload ordering, atomic body preservation, and task-set isolation.
	- Extend `src/test/stateMachine.test.ts` and, if the host method is added there, `src/test/runManager.test.ts` for successful reorders, top/middle/end insertion, same-position no-ops, invalid/stale requests, runtime-metadata preservation, and concurrency behaviour.
	- Extend `src/test/boardPanel.test.ts` to validate the new message/projection contract and that the generated webview script still parses; add focused webview interaction coverage if the existing test harness permits it.

5. **Product documentation and manual check**
	- Update the relevant task-file schema, board protocol, and interaction sections of `docs/PRD.md` to document persisted within-column ordering, the new reorder message, keyboard fallback, legacy ordering, and the fact that cross-column moves remain separate. Remove the current statement that within-column reordering is unsupported.
	- Smoke-check each column with zero, one, and several cards; reorder upward/downward and to both boundaries; reload the board; switch task sets; and confirm a running card's status/run and chat are untouched by an in-column reorder.

## Log
- run:rprduvn task:TASK-007 stage:refine result:ok note:"2026-08-17T10:46:40Z — refined within-column ordering with persisted task-set scope, host/UI changes, accessibility, and verification criteria"
- run:rrnv8jd task:TASK-007 stage:develop result:ok note:"2026-08-17T21:23:07Z — implemented persisted within-column ordering with validated host/UI interactions, accessibility, tests, and PRD documentation"
- run:rrnv8jd task:TASK-007 stage:develop result:failed note:"timed out"
- run:ra8g0wg task:TASK-007 stage:validate result:failed note:"2026-08-17T23:22:18Z — validation failed: 193 automated tests passed, but state-machine and agent outcome transitions do not assign destination end positions, so workflow moves can inherit source-column position metadata; batched replacement is not all-or-nothing and no real mouse-drag smoke evidence was available"
- run:rukiymq task:TASK-007 stage:develop result:ok note:"2026-08-17T23:33:04Z — implemented destination-column position normalization for audited workflow transitions, rollback-safe ordering batches, regression tests, and verification"
- run:rv9y0uy task:TASK-007 stage:validate result:blocked note:"2026-08-17T23:41:47Z — automated verification passed with 195 tests, but no real mouse-drag/manual smoke evidence is available for the required webview interaction check"
