---
id: TASK-010
title: RunManager does not pick up propose-task log lines from TASK md files
type: bug
state: validation
status: idle
position: 7
created: 2026-08-18T10:17:48Z
updated: 2026-08-18T10:35:25Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-010
copilot_session_id: bee84b53-44d7-457e-8925-68538ba35889
scope_hash: 1466eb4
chat_reset_required: false
---

## Request
- C:\Repositories\x\.kanban-pilot\tasks\TASK-004.md
a propose-task was added to it but RunManager did not create a new task for it.

## Refined

### Problem statement

`propose-task` is an append-only companion line in a parent task's `## Log`. For
Develop and Validate it is optional follow-up work, and it must be tied to the
run that discovered it. `RunManager` currently drains those lines only inside
the one `applyReceipt()` pass that handles the matching stage receipt. If the
receipt is written first and the proposal is appended in a later task-file
write or watcher event, that pass sees no proposal; later
`reconcileTaskChange()` calls only look for the special late-receipt markers,
so the valid proposal remains inert and no child task is created. The current
Develop and Validate completion prompts also present the receipt before the
optional proposal instructions, making this ordering likely.

The task-file location is part of the incident boundary. The reported
`C:\\Repositories\\x\\.kanban-pilot\\tasks\\TASK-004.md` path is not this
checkout's active named-set path; named sets use
`.kanban-pilot/task-sets/<set-id>/tasks/<id>.md`. Prompts must refer to the
attached active task file, and reconciliation and child creation must use the
same active `TaskStore`, rather than assuming the legacy Default directory.
This is not a request to create tasks from arbitrary prose: only valid,
same-run proposals from eligible Develop or Validate runs should be processed;
Refine proposals and disabled task-proposal settings remain intentional
no-ops, and Split keeps its separate primary-child contract.

### Acceptance criteria

- With `kanbanPilot.chat.allowTaskProposals` enabled, a valid same-run
	`propose-task` line in the active parent file creates a real child for both
	Develop and Validate whether the line is written before the receipt, after
	the receipt, or in a separate filesystem/watcher event. The run settles
	without requiring a second agent run or a manual re-save of the task file.
- Each accepted child is created through the active `TaskStore` in Backlog,
	uses the explicit proposal type or inherits the parent's type, preserves the
	proposal note in `## Request`, and records the parent/run/proposal provenance.
	A named task set never writes the child into the legacy Default task folder.
- Repeated watcher passes, activation/reload reconciliation, and any bounded
	post-receipt recovery are idempotent: a proposal creates at most one child,
	the five-proposal cap and existing duplicate rules remain in force, and the
	parent stage outcome is not applied twice.
- Lines with malformed syntax, an unrelated run id, an invalid explicit type,
	or a proposal beyond the cap are ignored as before. Refine never files
	proposals, and `chat.allowTaskProposals: false` keeps Develop/Validate
	proposals inert. Existing Split behavior remains independent of that setting.
- The built-in Develop and Validate completion contract directs the agent to
	append proposals to the attached active task file and to write proposal lines
	before the receipt, while runtime reconciliation still handles older or
	user-customized templates that produce the opposite order.
- A child-creation or reconciliation error is observable through the existing
	task/run log and does not silently claim that the proposal was handled. The
	existing receipt, state-transition, late-receipt, stale-run, and task-set
	behavior continues to pass its regression coverage.

## Scope
- [ ] `src/chat/runManager.ts` — separate proposal draining from the single
	immediate receipt pass enough to handle valid Develop/Validate proposals
	that arrive after the receipt or in a later watcher/activation pass. Keep
	the matching task/run/stage and staleness guards, `allowTaskProposals`
	setting, five-item cap, type inheritance, origin metadata, and idempotent
	child matching; do not turn arbitrary task-log lines into new tasks or
	change Split's distinct transaction rules.
- [ ] `src/chat/runManager.ts` and `src/chat/promptTemplates.ts` — make the
	post-receipt recovery bounded and retry-safe, surface child persistence
	failures through the existing reconciliation/audit path, and pass the active
	task-file reference/path into generated prompts instead of assuming the
	legacy `.kanban-pilot/tasks` directory.
- [ ] `.kanban-pilot/prompts/develop.md` and
	`.kanban-pilot/prompts/validate.md` — align the checked-in default prompt
	contracts with the active-file and proposal-before-receipt rules. Preserve
	the existing policy that user-customized prompt files are not silently
	overwritten; runtime handling must remain compatible with older copies.
- [ ] `src/test/runManager.test.ts` — add regression cases for Develop and
	Validate proposal-after-receipt ordering, separate proposal/receipt watcher
	events, activation/reload recovery, named task-set directory routing,
	repeated reconciliation without duplicates, and child-write failure. Retain
	coverage for the setting-off, invalid/foreign proposal, cap, inheritance,
	Refine, Split, late-receipt, and stale-run behaviors.
- [ ] `src/test/receiptAndTemplates.test.ts` and, only if parser behavior
	changes, `src/test/proposals.test.ts` — assert the active-file instruction,
	proposal-before-receipt ordering, compatibility with legacy custom templates,
	and the existing canonical proposal grammar.
- [ ] `docs/PRD.md` and `README.md` — document that Develop/Validate proposal
	lines are reconciled from the active task file even when filesystem writes
	arrive out of order, that children stay in the active task set, and that
	Split's mandatory child path and the optional follow-up setting are distinct.
- [ ] Run focused proposal/template/RunManager tests followed by compile,
	lint, and the full test suite; verify the reproduction with a named task set
	and with the legacy Default directory without modifying task frontmatter or
	treating the reported `C:\\Repositories\\x` path as a literal configuration.

## Log
- audit:state-change at:2026-08-18T10:17:51Z task:TASK-010 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T10:17:52Z task:TASK-010 from:idle to:running action:refine run:rtndy90 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T10:17:52Z task:TASK-010 stage:refine action:refine run:rtndy90 note:"Started refine activity."
- run:rtndy90 task:TASK-010 stage:refine result:ok note:"2026-08-18T10:19:42Z — identified post-receipt proposal reconciliation and active task-set path gaps with runtime, prompt, test, and documentation scope"
- audit:state-change at:2026-08-18T10:21:33Z task:TASK-010 from:refine to:scoped action:receipt run:rtndy90 outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T10:21:33Z task:TASK-010 from:running to:idle action:receipt run:rtndy90 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T10:21:33Z task:TASK-010 stage:refine action:receipt run:rtndy90 outcome:ok note:"2026-08-18T10:19:42Z — identified post-receipt proposal reconciliation and active task-set path gaps with runtime, prompt, test, and documentation scope"
- audit:state-change at:2026-08-18T10:21:49Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T10:21:51Z task:TASK-010 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T10:21:51Z task:TASK-010 from:idle to:running action:develop run:rril2ch note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T10:21:51Z task:TASK-010 stage:develop action:develop run:rril2ch note:"Started develop activity."
- run:rril2ch task:TASK-010 stage:develop result:ok note:"2026-08-18T10:34:31Z — added bounded post-receipt Develop/Validate proposal reconciliation, active task-file prompt routing, regression coverage, and recovery documentation"
- audit:state-change at:2026-08-18T10:35:25Z task:TASK-010 from:in-progress to:validation action:receipt run:rril2ch outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T10:35:25Z task:TASK-010 from:running to:idle action:receipt run:rril2ch outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T10:35:25Z task:TASK-010 stage:develop action:receipt run:rril2ch outcome:ok note:"2026-08-18T10:34:31Z — added bounded post-receipt Develop/Validate proposal reconciliation, active task-file prompt routing, regression coverage, and recovery documentation"
