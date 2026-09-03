---
id: TASK-002
title: Creating child tasks always ends up with duplicated tasks
type: bug
state: done
status: idle
position: 1
created: 2026-09-03T01:35:04Z
updated: 2026-09-03T02:13:42Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-002
copilot_session_id: 9f3c328b-5600-45d3-bbfd-ccc2d33f3303
scope_hash: f923ece
chat_reset_required: false
---

## Request
Creating child tasks always ends up with duplicated tasks

## Refined
Child tasks created from `propose-task` entries must be idempotent: watcher events, receipt recovery, activation reconciliation, and retries must reuse each accepted proposal's existing child rather than persisting a duplicate. In addition, a Develop run must not be considered complete solely because it filed child tasks or appended a success receipt. The extension needs a guardrail that requires verifiable implementation evidence for code-scoped work and keeps proposal-only or no-op runs from advancing to Validation.

Acceptance criteria:
- One valid `propose-task` entry for a run produces exactly one child task, even when reconciliation runs repeatedly.
- A partial child-creation retry resumes missing proposals without duplicating children already persisted for that run.
- Existing provenance compatibility and parent attachment behavior remain intact when an older child task lacks the current proposal fingerprint.
- A Develop `result:ok` receipt advances a code-scoped task only when the run records implementation evidence beyond task-file mutations and `propose-task` entries.
- A proposal-only or no-op Develop run is left in a retryable non-complete state with an actionable reason; child proposals remain available as follow-up work but do not count as implementation.
- The Develop prompt requires agents to report concrete changed files and verification evidence, and directs agents to use a non-completion receipt when no implementation change was made.
- Focused prompt-template and `RunManager` tests cover duplicate prevention, partial retry, proposal-only completion, and valid evidence-bearing completion.

## Scope
- Inspect `src/chat/runManager.ts` proposal processing and `proposalMatches` to identify why an existing child is not recognized during repeated reconciliation.
- Adjust the child-proposal idempotency check in `src/chat/runManager.ts` so matching is stable across watcher, receipt-recovery, activation, and retry paths without collapsing distinct proposals.
- Update `src/chat/proposals.ts` only if the proposal fingerprint or parsed identity lacks data required for stable deduplication.
- Add focused regression coverage in `src/test/runManager.test.ts` for repeated reconciliation of the same child proposal, including a partial-creation retry where applicable.
- Define a structured, parseable Develop implementation-evidence record and update `src/chat/receipt.ts` only as needed to validate it without weakening existing receipt compatibility.
- Update `src/chat/promptTemplates.ts` so Develop agents append implementation evidence identifying changed non-task files and verification performed before a success receipt; proposal lines cannot satisfy this requirement.
- Update `src/chat/runManager.ts` to capture or validate a run-scoped non-task workspace-change baseline and block successful Develop completion when the required evidence or implementation change is absent. Exclude Kanban task files and generated build/test output from the guardrail.
- Add focused `src/test/runManager.test.ts` and `src/test/receiptAndTemplates.test.ts` coverage for proposal-only/no-op success receipts being blocked, valid source-change evidence being accepted, and existing non-code task flows retaining an explicit opt-out path where approved by scope.
- Run focused receipt, prompt-template, and `RunManager` test coverage, plus compile and lint, confirming one persisted child per accepted proposal and no advancement from task-only activity.

## Log
- audit:state-change at:2026-09-03T01:35:06Z task:TASK-002 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T01:35:07Z task:TASK-002 from:idle to:running action:refine run:rqlwt87 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T01:35:07Z task:TASK-002 stage:refine action:refine run:rqlwt87 note:"Started refine activity."
- run:rqlwt87 task:TASK-002 stage:refine result:ok note:"Scoped idempotent child-task creation and regression coverage."
- audit:status-change at:2026-09-03T01:35:52Z task:TASK-002 from:running to:idle action:receipt run:rqlwt87 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T01:35:52Z task:TASK-002 stage:refine action:receipt run:rqlwt87 outcome:ok note:"Scoped idempotent child-task creation and regression coverage."
- audit:state-change at:2026-09-03T01:36:58Z task:TASK-002 from:refine to:scoped action:apply-pending run:rqlwt87 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T01:37:10Z task:TASK-002 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T01:37:12Z task:TASK-002 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T01:37:12Z task:TASK-002 from:idle to:running action:develop run:rn1x011 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T01:37:12Z task:TASK-002 stage:develop action:develop run:rn1x011 note:"Started develop activity."
- run:rn1x011 task:TASK-002 stage:develop result:ok note:"2026-09-03T01:40:39Z — implemented parent-aware idempotent proposal filing with regression coverage."
- audit:status-change at:2026-09-03T01:40:52Z task:TASK-002 from:running to:idle action:receipt run:rn1x011 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T01:40:52Z task:TASK-002 stage:develop action:receipt run:rn1x011 outcome:ok note:"2026-09-03T01:40:39Z — implemented parent-aware idempotent proposal filing with regression coverage."
- audit:state-change at:2026-09-03T01:48:39Z task:TASK-002 from:in-progress to:approved action:move note:"State changed from in-progress to approved via move."
- audit:state-change at:2026-09-03T01:50:58Z task:TASK-002 from:approved to:scoped action:move note:"State changed from approved to scoped via move."
- audit:state-change at:2026-09-03T01:50:59Z task:TASK-002 from:scoped to:refine action:move note:"State changed from scoped to refine via move."
- audit:status-change at:2026-09-03T01:51:00Z task:TASK-002 from:idle to:running action:refine run:rdu30gi note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T01:51:00Z task:TASK-002 stage:refine action:refine run:rdu30gi note:"Started refine activity."
- run:rdu30gi task:TASK-002 stage:refine result:ok note:"Scoped duplicate prevention and guardrails against proposal-only Develop completion."
- audit:status-change at:2026-09-03T01:51:33Z task:TASK-002 from:running to:idle action:receipt run:rdu30gi outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T01:51:33Z task:TASK-002 stage:refine action:receipt run:rdu30gi outcome:ok note:"Scoped duplicate prevention and guardrails against proposal-only Develop completion."
- audit:state-change at:2026-09-03T01:59:03Z task:TASK-002 from:refine to:scoped action:apply-pending run:rdu30gi outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T01:59:08Z task:TASK-002 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T01:59:09Z task:TASK-002 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T01:59:09Z task:TASK-002 from:idle to:running action:develop run:rn0ey10 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T01:59:09Z task:TASK-002 stage:develop action:develop run:rn0ey10 note:"Started develop activity."
- run:rn0ey10 task:TASK-002 stage:develop result:ok note:"2026-09-03T02:05:41Z — added verified Develop implementation-evidence guardrails and regression coverage."
- audit:status-change at:2026-09-03T02:05:55Z task:TASK-002 from:running to:idle action:receipt run:rn0ey10 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T02:05:55Z task:TASK-002 stage:develop action:receipt run:rn0ey10 outcome:ok note:"2026-09-03T02:05:41Z — added verified Develop implementation-evidence guardrails and regression coverage."
- audit:state-change at:2026-09-03T02:13:38Z task:TASK-002 from:in-progress to:validation action:apply-pending run:rn0ey10 outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-09-03T02:13:42Z task:TASK-002 from:validation to:done action:move note:"State changed from validation to done via move."
