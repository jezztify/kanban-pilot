---
id: TASK-008
title: "Change \"Pending: ...\" into \"Review Required\""
type: feature
state: validation
status: idle
position: 5
created: 2026-08-20T10:49:02Z
updated: 2026-08-20T11:19:26Z
chat: 05f47917-6d1d-479a-8a04-ece12f33e6ce
copilot_session_id: 05f47917-6d1d-479a-8a04-ece12f33e6ce
scope_hash: feeb12f
chat_reset_required: false
---

## Request
Change "Pending: ..." into "Review Required"

## Refined
The board currently marks a task with a durable completion outcome using the card-status text `Pending: <transition label>`. This label should instead communicate that a human decision is needed before the outcome is applied.

Acceptance criteria:
- A card with a pending completion outcome displays `Review Required` in its pending-status badge instead of `Pending: <transition label>`.
- The pending outcome remains available and unchanged: its explanatory tooltip, transition context, and Apply action continue to work.
- Accessible card and pending-status text describe the review-required state while retaining the transition label as context.
- The board-panel regression test verifies the new visible and accessible wording and still verifies that applying the outcome posts the existing `pending/apply` message.

## Scope
- Update the pending-status rendering in `src/board/boardPanel.ts` so a pending completion badge uses the `Review Required` copy rather than the `Pending: <gate label>` format.
- Update the pending-related `aria-label` and card summary text in `src/board/boardPanel.ts` to describe the review-required state and preserve the gate label for context; leave pending-outcome data, tooltip, and apply-message behavior unchanged.
- Update the pending-completion board rendering assertions in `src/test/boardPanel.test.ts` for the new visible and accessible copy, retaining the existing assertion that the Apply control posts `pending/apply`.

## Log
- audit:state-change at:2026-08-20T10:49:07Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T10:49:12Z task:TASK-008 from:idle to:running action:refine run:rk5ofgj note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T10:49:12Z task:TASK-008 stage:refine action:refine run:rk5ofgj note:"Started refine activity."
- run:rk5ofgj task:TASK-008 stage:refine result:ok note:"2026-08-20T10:49:46Z — refined the review-required badge wording and board-panel test scope."
- audit:status-change at:2026-08-20T10:49:58Z task:TASK-008 from:running to:idle action:receipt run:rk5ofgj outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T10:49:58Z task:TASK-008 stage:refine action:receipt run:rk5ofgj outcome:ok note:"2026-08-20T10:49:46Z — refined the review-required badge wording and board-panel test scope."
- audit:state-change at:2026-08-20T10:50:41Z task:TASK-008 from:refine to:scoped action:apply-pending run:rk5ofgj outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-20T10:51:16Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-20T11:06:07Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-20T11:06:07Z task:TASK-008 from:idle to:running action:develop run:rwuyuq8 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-20T11:06:07Z task:TASK-008 stage:develop action:develop run:rwuyuq8 note:"Started develop activity."
- run:rwuyuq8 task:TASK-008 stage:develop result:ok note:"2026-08-20T11:07:16Z — changed pending completion card copy to Review Required and updated accessible regression coverage."
- audit:status-change at:2026-08-20T11:07:54Z task:TASK-008 from:running to:idle action:receipt run:rwuyuq8 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T11:07:54Z task:TASK-008 stage:develop action:receipt run:rwuyuq8 outcome:ok note:"2026-08-20T11:07:16Z — changed pending completion card copy to Review Required and updated accessible regression coverage."
- audit:state-change at:2026-08-20T11:19:26Z task:TASK-008 from:in-progress to:validation action:apply-pending run:rwuyuq8 outcome:ok note:"State changed from in-progress to validation via apply-pending."
