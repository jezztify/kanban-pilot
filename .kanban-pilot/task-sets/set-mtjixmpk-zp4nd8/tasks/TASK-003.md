---
id: TASK-003
title: Spike: What improvements can we do to improve User Experience?
type: feature
state: in-progress
status: idle
position: 0
created: 2026-09-03T02:30:11Z
updated: 2026-09-03T02:46:15Z
pending_outcome: {"gate":"developToValidation","stage":"develop","result":"ok","runId":"rroucoq"}
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-003
copilot_session_id: a12a191d-2ccd-48b1-8908-e71b48f08a11
scope_hash: a3283f6
chat_reset_required: false
---

## Request
Spike: What improvements can we do to improve User Experience?

## Refined

### Problem statement

Kanban Pilot is intended to be the primary control surface for a solo developer managing durable task files and Copilot runs, but this request does not identify which user journeys create friction, whether the friction belongs to the shared board, the VS Code host, or the browser endpoint, or how an improvement would be judged. This spike will produce an evidence-backed UX audit and a prioritized set of implementation-ready recommendations for reducing user effort and uncertainty across the core workflow. The audit must preserve the board as the source of truth, explicit workflow gates, per-task chat isolation, and the security boundary around the optional HTTP endpoint.

### Acceptance criteria

- The research identifies the assumed primary persona and usage contexts, including the VS Code board and the optional browser board, and records any unresolved assumptions.
- The core journeys are reviewed end to end: task creation and task sets, card selection and detail/editing, workflow actions and gate outcomes, ordering, blocked or failed run recovery, settings, and browser sharing/reconnection.
- Every UX finding includes observable evidence from the repository, documentation, tests, or a manual walkthrough; the affected surface, user impact, likely cause, confidence, and severity are recorded.
- The output prioritizes three to five improvements with rationale, expected user outcome, a measurable success signal, dependencies or risks, and a concrete follow-up boundary.
- The recommendations are split into independently actionable follow-up tasks with named source, test, and documentation areas where applicable; this spike makes no production-code changes.
- The recommendations explicitly retain existing workflow, data-integrity, accessibility, and endpoint-security invariants unless a deliberate change is separately approved.

## Scope
- [ ] Create `docs/research/user-experience-spike.md` as the evidence log and decision record, with persona, journey maps, findings, prioritization, success measures, and follow-up task proposals.
- [ ] Establish the current-state baseline from `src/board/boardPanel.ts`, focusing on board scanning, card actions, drag and keyboard ordering, task detail/editing, activity feedback, settings, attachments, task-tree presentation, modal focus, and empty/error states.
- [ ] Trace host and browser differences through `src/board/boardSurface.ts`, `src/http/browserBoardSurface.ts`, and `src/http/endpointSharePanel.ts`; record limitations around editor-only actions, connection loss, theme/responsive behavior, QR/copy sharing, and remote activity visibility.
- [ ] Trace workflow feedback and state semantics through `src/chat/runManager.ts`, `src/chat/progress.ts`, `src/chat/transcriptTail.ts`, `src/chat/hookSpool.ts`, `src/model/task.ts`, `src/model/taskStore.ts`, `src/model/taskSets.ts`, and `src/model/gates.ts` so recommendations do not confuse UI friction with state-machine behavior.
- [ ] Use `src/test/boardPanel.test.ts` and the realtime-board tests as the existing behavioral baseline; identify missing UX regression coverage for each shortlisted improvement without changing the tests in this spike.
- [ ] Cross-check user-facing behavior and invariants against `docs/board-guide.md`, `docs/configuration.md`, `docs/http-endpoint.md`, and `docs/PRD.md`, noting documentation gaps separately from product UX problems.
- [ ] Rank findings by user impact, frequency, confidence, implementation effort, and risk; select three to five improvements and define a measurable success signal and acceptance boundary for each.
- [ ] For every selected improvement, name the likely implementation files, UI states or message contracts affected, focused tests to add, documentation to update, and any design or accessibility review needed.
- [ ] Update `docs/research/README.md` with the completed spike link and file separate follow-up tasks for approved implementation work; do not modify production code as part of TASK-003.

## Log
- audit:state-change at:2026-09-03T02:30:13Z task:TASK-003 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T02:30:14Z task:TASK-003 from:idle to:running action:refine run:ryav0l4 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T02:30:14Z task:TASK-003 stage:refine action:refine run:ryav0l4 note:"Started refine activity."
- progress run:ryav0l4 task:TASK-003 at:2026-09-03T02:31:02Z note:"scoping the UX audit across board, workflow, settings, and browser surfaces"
- run:ryav0l4 task:TASK-003 stage:refine result:ok note:"2026-09-03T02:31:02Z — refined the UX spike into an evidence-backed audit and prioritized follow-up scope"
- audit:status-change at:2026-09-03T02:31:41Z task:TASK-003 from:running to:idle action:receipt run:ryav0l4 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T02:31:41Z task:TASK-003 stage:refine action:receipt run:ryav0l4 outcome:ok note:"2026-09-03T02:31:02Z — refined the UX spike into an evidence-backed audit and prioritized follow-up scope"
- audit:state-change at:2026-09-03T02:35:14Z task:TASK-003 from:refine to:scoped action:apply-pending run:ryav0l4 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-03T02:35:15Z task:TASK-003 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-03T02:35:16Z task:TASK-003 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-03T02:35:16Z task:TASK-003 from:idle to:running action:develop run:rroucoq note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-03T02:35:16Z task:TASK-003 stage:develop action:develop run:rroucoq note:"Started develop activity."
- propose-task run:rroucoq type:feature title:"Make workflow outcomes and recovery next steps visible" note:"Make workflow outcomes and recovery next steps visible in the board."
- propose-task run:rroucoq type:feature title:"Keep browser confirmations and operation errors in the browser surface" note:"Keep browser confirmations and operation errors in the browser surface."
- propose-task run:rroucoq type:feature title:"Expose browser connection and reconnect status" note:"Expose browser connection and reconnect status."
- propose-task run:rroucoq type:feature title:"Make activity provenance and freshness explicit" note:"Make activity provenance and freshness explicit."
- propose-task run:rroucoq type:feature title:"Add board-local find and filter controls" note:"Add board-local find and filter controls."
- run:rroucoq task:TASK-003 stage:develop result:ok note:"2026-09-03T02:45:09Z — develop completed: documented the UX audit, indexed the decision record, and filed five approved follow-up tasks"
- audit:status-change at:2026-09-03T02:46:15Z task:TASK-003 from:running to:idle action:receipt run:rroucoq outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T02:46:15Z task:TASK-003 stage:develop action:receipt run:rroucoq outcome:ok note:"2026-09-03T02:45:09Z — develop completed: documented the UX audit, indexed the decision record, and filed five approved follow-up tasks"
