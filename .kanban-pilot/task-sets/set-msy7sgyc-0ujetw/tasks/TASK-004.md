---
id: TASK-004
title: Settings menu: Agent assignments should only have 1 save button.
type: feature
state: validation
status: idle
position: 4
created: 2026-08-18T05:41:24Z
updated: 2026-08-18T08:20:34Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-004
copilot_session_id: 06c68366-710a-4d87-bd73-3aa8f32b59fb
chat_reset_required: false
---

## Request
For the entirety of the Agent assigments category, there should only have 1 save button.

## Refined

**Problem.** In the Settings menu, the "Agent assignments" category renders one row per workflow column (Backlog → Done). Each row currently carries its own pair of action buttons — a **Save** and a **Reset** chip (`src/board/boardPanel.ts`, `renderSettings` agent loop, ~lines 2946–2958) that post an immediate `agentName/set` message for just that column. With seven columns the category therefore shows up to seven Save buttons (and seven Reset buttons), one per row. The user wants a single save control for the whole category: change any number of dropdowns, then commit them all with **one** shared "Save" button at the bottom of the Agent assignments panel — matching how the other typed-settings categories already behave conceptually and removing the noisy per-row Save/Reset pair.

**Acceptance criteria.**
1. The Agent assignments category renders exactly **one** "Save" button, placed once for the whole `#settingsPanelAgents` section (not one per column row). No per-column "Save" chip remains in any agent-assignment row.
2. Clicking that single Save commits every currently-selected value across all seven columns at once — i.e., it posts a batched save covering each column's current dropdown selection, not just the last-touched one.
3. The existing per-row **Reset** behavior is preserved in some form (either kept as a per-column Reset chip that clears only that column to its default on next Save, or replaced by an equivalent mechanism) so users can still revert individual columns; this must be decided and documented during develop — do not silently drop the ability to reset.
4. The extension host persists all seven assignments atomically (or as a validated batch), reusing/validating through `persistAgentNameOverride` / `isAgentColumn` / `isAgentNameValue`, so an invalid value in any column does not partially commit others without surfacing an error.
5. After saving, the board and Settings refresh with the new labels (existing `onDidChangeConfiguration` re-push path still works).
6. Existing tests that assert per-row Save/Reset messages (`src/test/boardPanel.test.ts`, ~lines 560–580) are updated to reflect the single shared save control; a test is added asserting exactly one Save button exists in the agents panel and that it posts all column values together.

## Scope
- `src/board/boardPanel.ts` — webview agent loop (~2946–2958): remove the per-row "Save" chip (and decide Reset handling); add a single shared "Save" control rendered once for `#settingsPanelAgents`, wired to collect every column's current select value and post one batched save message.
- `src/board/boardPanel.ts` — host-side message handler: extend/replace the `agentName/set` path (~1066–1074) with a batched agent-save case (e.g., `agents/save`) that validates each column via `isAgentColumn` / `isAgentNameValue`, persists all through `persistAgentNameOverride`, and reports an error if any value is invalid.
- `src/board/boardPanel.ts` — CSS (~1520–1574): adjust `.agent-setting-actions` styling for the single shared save layout (and per-row Reset, if retained).
- `src/test/boardPanel.test.ts` — update existing agent Save/Reset assertions (~lines 324, 560–580) to match the new control; add a test asserting exactly one Save button in the agents panel and that it posts all seven column values together.

## Log
- audit:state-change at:2026-08-18T05:41:27Z task:TASK-004 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T05:55:54Z task:TASK-004 from:idle to:running action:refine run:rglbnip note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T05:55:54Z task:TASK-004 stage:refine action:refine run:rglbnip note:"Started refine activity."
- run:rglbnip task:TASK-004 stage:refine result:failed note:"timed out"
- audit:status-change at:2026-08-18T06:15:55Z task:TASK-004 from:running to:failed action:timeout run:rglbnip outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-18T06:15:55Z task:TASK-004 stage:refine run:rglbnip outcome:timeout note:"Activity timed out."
- run:rglbnip task:TASK-004 stage:refine result:ok note:"2026-08-18T06:35:00Z — refine completed: scoped a single shared Save button for the whole Agent assignments category, replacing per-row Save/Reset chips with one batched save across all seven columns"
- audit:state-change at:2026-08-18T06:40:02Z task:TASK-004 from:refine to:scoped action:move note:"State changed from refine to scoped via move."
- audit:status-change at:2026-08-18T06:40:02Z task:TASK-004 from:failed to:idle action:move note:"Status changed from failed to idle via move."
- audit:state-change at:2026-08-18T07:51:37Z task:TASK-004 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T08:15:45Z task:TASK-004 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T08:15:45Z task:TASK-004 from:idle to:running action:develop run:roje3fu note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T08:15:45Z task:TASK-004 stage:develop action:develop run:roje3fu note:"Started develop activity."
- run:roje3fu task:TASK-004 stage:develop result:ok note:"2026-08-18T08:19:57Z — implemented one shared Agent assignments Save button with local per-column Reset, validated batch persistence, and updated coverage"
- audit:state-change at:2026-08-18T08:20:34Z task:TASK-004 from:in-progress to:validation action:receipt run:roje3fu outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T08:20:34Z task:TASK-004 from:running to:idle action:receipt run:roje3fu outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T08:20:34Z task:TASK-004 stage:develop action:receipt run:roje3fu outcome:ok note:"2026-08-18T08:19:57Z — implemented one shared Agent assignments Save button with local per-column Reset, validated batch persistence, and updated coverage"
