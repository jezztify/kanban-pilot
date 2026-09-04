---
id: TASK-010
title: opening the task details using narrow widths cut off the top part
type: bug
state: done
status: idle
position: 8
created: 2026-09-03T03:15:48Z
updated: 2026-09-04T04:31:29Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-010
copilot_session_id: 1d3ea189-d8bb-4bb3-b2fe-c048723f670a
scope_hash: 8538990
chat_reset_required: true
---

## Request
![image.png](TASK-010.attachments/image.png)

## Refined

### Problem statement

At narrow board or webview widths, opening a task with enough detail to exceed the available viewport can leave the vertically stacked detail layout centered while its content overflows. The top of the task-details dialog, including the title/header and the beginning of the task content, is then clipped above the visible surface as shown in the attachment. This makes the dialog's identity and controls difficult or impossible to reach when it first opens. The dialog should keep its top portion accessible while still allowing long task details to scroll.

### Acceptance criteria

- At the narrow responsive width represented by the report, opening a task-detail dialog keeps the dialog's top edge, title, badges, close control, and beginning of the detail content within the visible viewport.
- When the task details are taller than the available viewport, all sections and actions remain reachable through vertical scrolling, including Request, Refined, Scope, logs or activity, and the optional Task Tree; no horizontal overflow is introduced.
- At wide desktop widths, the existing centered detail dialog and optional two-pane Task Tree layout retain their current sizing and placement.
- Existing close behavior (close button, backdrop dismissal, and Escape), focus behavior, and detail refresh/scroll preservation continue to work after the responsive layout change.

## Scope

- [ ] Update the responsive detail-modal styles in `src/board/boardPanel.ts`, covering `.modal-backdrop`, `.detail-dialog-layout`, and the detail modal/Task Tree sizing rules so narrow layouts are top-safe, constrained to the viewport, and vertically scrollable without clipping the header.
- [ ] Preserve the existing wide-screen centered dialog and two-pane Task Tree presentation while preventing narrow layouts from creating horizontal overflow or inaccessible content.
- [ ] Extend the focused detail/webview coverage in `src/test/boardPanel.test.ts` with a representative tall task at a narrow viewport or equivalent responsive-layout assertion that proves the header is visible on open and the remaining content can be reached by scrolling.
- [ ] Run the focused board-panel regression test and, where layout geometry requires it, a browser smoke check at narrow and wide viewport sizes, covering detail opening, scrolling, and dismissal.

## Log
- audit:state-change at:2026-09-03T03:15:50Z task:TASK-010 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T03:16:05Z task:TASK-010 from:idle to:running action:refine run:rg9qivq note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T03:16:05Z task:TASK-010 stage:refine action:refine run:rg9qivq note:"Started refine activity."
- progress run:rg9qivq task:TASK-010 at:2026-09-03T03:17:14Z note:"refinement captured the narrow viewport failure and focused implementation scope"
- run:rg9qivq task:TASK-010 stage:refine result:ok note:"2026-09-03T03:17:14Z — refine completed: documented the responsive detail-modal fix and regression checklist"
- audit:status-change at:2026-09-03T03:17:56Z task:TASK-010 from:running to:idle action:receipt run:rg9qivq outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T03:17:56Z task:TASK-010 stage:refine action:receipt run:rg9qivq outcome:ok note:"2026-09-03T03:17:14Z — refine completed: documented the responsive detail-modal fix and regression checklist"
- audit:state-change at:2026-09-03T06:41:33Z task:TASK-010 from:refine to:scoped action:apply-pending run:rg9qivq outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T06:42:57Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T06:43:05Z task:TASK-010 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T06:43:05Z task:TASK-010 from:idle to:running action:develop run:rc66d3n note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T06:43:05Z task:TASK-010 stage:develop action:develop run:rc66d3n note:"Started develop activity."
- progress run:rc66d3n task:TASK-010 at:2026-09-03T06:46:00Z note:"focused tall-detail regression coverage compiles"
- progress run:rc66d3n task:TASK-010 at:2026-09-03T06:48:25Z note:"responsive modal styles are implemented and the focused webview regression passes"
- progress run:rc66d3n task:TASK-010 at:2026-09-03T06:48:57Z note:"the complete BoardPanel regression suite passes"
- progress run:rc66d3n task:TASK-010 at:2026-09-03T06:54:36Z note:"browser smoke passed for narrow and wide detail opening, scrolling, and dismissal"
- run:rc66d3n task:TASK-010 stage:develop result:ok note:"2026-09-03T06:55:31Z — fixed narrow detail-modal top clipping with top-safe responsive scrolling, added tall-detail coverage, and passed focused, BoardPanel, lint, build, and browser smoke checks"
- audit:status-change at:2026-09-03T06:56:08Z task:TASK-010 from:running to:blocked action:receipt run:rc66d3n outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-03T06:56:08Z task:TASK-010 stage:develop action:receipt run:rc66d3n outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
- audit:state-change at:2026-09-04T04:31:23Z task:TASK-010 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-04T04:31:23Z task:TASK-010 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-04T04:31:29Z task:TASK-010 from:validation to:done action:move note:"State changed from validation to done via move."
