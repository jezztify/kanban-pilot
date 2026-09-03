---
id: TASK-009
title: Task Tree Modal: Visual clarity is an issue
type: bug
state: in-progress
status: blocked
position: 3
created: 2026-09-03T03:08:35Z
updated: 2026-09-03T03:28:00Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-009
copilot_session_id: a998a8d7-82b2-49e8-88c5-c347f872ef73
scope_hash: 60ab595
chat_reset_required: false
---

## Request
- Appears too small
- Zooming in is limited

## Refined

The Task Tree shown beside the task detail modal is difficult to inspect because the diagram is presented in a narrow, short viewport and the current zoom range stops at 2x. Multi-level trees and nodes with long task IDs or names therefore appear too small, while users cannot enlarge the diagram enough to read labels or follow relationships. The change should improve the default amount of space given to the tree and provide a materially larger, still navigable zoom range without weakening the existing responsive or accessibility behavior.

Acceptance criteria:

- On desktop, opening the Task Tree uses more of the available detail-dialog space than the current 360px sidecar and 360px viewport caps; a representative multi-level tree is readable at its initial view without requiring immediate zoom.
- Zoom in can enlarge the tree beyond the current 2x ceiling to a documented maximum of at least 4x, and the visible Zoom in control is disabled only at that new maximum.
- The expanded range is available through every existing zoom path: Zoom in, mouse-wheel zoom, `+`/`=` keyboard zoom, and touch pinch; the displayed scale remains accurate and the zoom anchor remains usable.
- A zoomed tree can still be panned far enough in both axes to inspect its outer nodes and labels, and Reset view restores the documented default scale and origin.
- At the responsive stacked-modal breakpoint, the larger tree presentation remains contained within the modal, the controls remain reachable, and no horizontal page-level overflow is introduced.
- Existing Task Tree focus management and accessible names/status for the viewport and controls remain intact.

## Scope

- Update the Task Tree layout and Mermaid container styles in `src/board/boardPanel.ts` so the desktop sidecar and viewport allocate more usable width and height, while preserving the responsive stacked layout.
- Review the rendered SVG sizing and overflow rules in the same file so increasing the viewport and applying a larger transform scale makes node labels and connectors inspectable rather than clipping or shrinking them back to the container.
- Expand the Task Tree scale configuration and related clamping, control-state, keyboard, wheel, pinch, anchor, and pan-bound logic in `src/board/boardPanel.ts`; keep one consistent documented maximum of at least 4x and preserve Reset view behavior.
- Update the interactive Task Tree coverage in `src/test/boardPanel.test.ts` to verify the larger layout contract, the expanded maximum and disabled state, each supported zoom path, panning at enlarged scale, reset behavior, responsive containment, and existing focus/accessibility behavior.
- Leave task-tree projection/model logic, task data persistence, and Mermaid source generation unchanged; this ticket is limited to the Task Tree modal presentation and interaction.

## Log
- audit:state-change at:2026-09-03T03:08:36Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T03:08:47Z task:TASK-009 from:idle to:running action:refine run:rkeyt1n note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T03:08:47Z task:TASK-009 stage:refine action:refine run:rkeyt1n note:"Started refine activity."
- progress run:rkeyt1n task:TASK-009 at:2026-09-03T03:09:21Z note:"refined the visual clarity and zoom requirements"
- run:rkeyt1n task:TASK-009 stage:refine result:ok note:"2026-09-03T03:09:21Z — refine completed: documented readable sizing, expanded zoom, and focused board-panel scope"
- audit:status-change at:2026-09-03T03:11:36Z task:TASK-009 from:running to:idle action:receipt run:rkeyt1n outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T03:11:36Z task:TASK-009 stage:refine action:receipt run:rkeyt1n outcome:ok note:"2026-09-03T03:09:21Z — refine completed: documented readable sizing, expanded zoom, and focused board-panel scope"
- audit:state-change at:2026-09-03T03:12:12Z task:TASK-009 from:refine to:scoped action:apply-pending run:rkeyt1n outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T03:12:20Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T03:12:22Z task:TASK-009 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T03:12:22Z task:TASK-009 from:idle to:running action:develop run:rana9tg note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T03:12:22Z task:TASK-009 stage:develop action:develop run:rana9tg note:"Started develop activity."
- progress run:rana9tg task:TASK-009 at:2026-09-03T03:27:26Z note:"completed focused Task Tree checks and full verification"
- run:rana9tg task:TASK-009 stage:develop result:ok note:"2026-09-03T03:27:26Z — develop completed: expanded Task Tree layout, Mermaid sizing, 4x zoom, zoom and pan paths, responsive containment, accessibility coverage, and focused verification; full suite retains unrelated BoardPanel and RunManager failures"
- audit:status-change at:2026-09-03T03:28:00Z task:TASK-009 from:running to:blocked action:receipt run:rana9tg outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-03T03:28:00Z task:TASK-009 stage:develop action:receipt run:rana9tg outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
