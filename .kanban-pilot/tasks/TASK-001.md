---
id: TASK-001
title: Improve the Prompt Templates
type: feature
state: done
status: idle
created: 2026-08-14T12:32:32Z
updated: 2026-08-15T07:15:57Z
chat: kanban-pilot-TASK-001
copilot_session_id: beb4d2a4-c738-4230-98e8-ea2aa3cecc61
scope_hash: 6f6b382
chat_reset_required: false
---

## Request
Ensure that There is Completion and Non-Completion parts

## Refined
The stage prompt templates need an explicit, consistent contract for both
outcomes of a run: what the agent must record when the requested stage is
successfully completed, and what it must record when it cannot complete the
stage. The current footer places these instructions together without clearly
separating the paths, and the stage-specific meaning of `result:failed` during
validation can be confused with an inability to finish. Clarify the existing
receipt instructions without inventing new receipt values or changing the
extension's state machine.

**Acceptance criteria**
- The built-in refine, develop, validate, and split templates each contain
	clearly labeled completion and non-completion guidance in their
	`## On Completion` section.
- Refine and develop tell the agent to append a parseable `result:ok` receipt
	after successful work and a `result:blocked` receipt with the reason when it
	cannot proceed.
- Validate distinguishes all of its existing outcomes: `result:ok` when the
	acceptance criteria pass, `result:failed` when validation completes but the
	criteria are not met, and `result:blocked` when a pass/fail verdict cannot be
	determined.
- Split preserves its existing semantics: `result:ok` after child tasks are
	filed, and `result:blocked` when the ticket does not need splitting.
- Every documented receipt keeps the current run id, task id, stage, and
	parseable receipt grammar, and the instructions continue to prohibit edits
	outside the agent-owned task sections.
- Existing template rendering, user-customized-template preservation, and
	receipt parsing behavior remain intact; no new state or receipt result is
	introduced.

## Scope
- Update the four built-in stage templates in `src/chat/promptTemplates.ts`
	(`DEFAULT_REFINE_TEMPLATE`, `DEFAULT_DEVELOP_TEMPLATE`,
	`DEFAULT_VALIDATE_TEMPLATE`, and `DEFAULT_SPLIT_TEMPLATE`) to separate
	successful completion instructions from non-completion instructions while
	retaining stage-specific proposal and frontmatter rules.
- Keep the receipt lines aligned with `src/chat/receipt.ts` and the existing
	`RunManager` semantics: use `blocked` for an agent that cannot proceed,
	reserve validate's `failed` for a completed negative acceptance verdict, and
	do not add a new result or status value.
- Extend `src/test/receiptAndTemplates.test.ts` to render each default template
	and verify both labeled paths, the correct stage-specific result values, and
	the existing run/task identifiers; retain coverage for conditional rendering,
	user overrides, and validate pass/fail behavior.
- Do not overwrite the user-editable files under `.kanban-pilot/prompts/` as
	part of default seeding; `ensureTemplate` must continue to preserve an
	existing customized template.

## Log
- run:rbpidnt task:TASK-001 stage:refine result:ok note:"clarified completion and non-completion receipt paths for all stage templates"
- run:rpgu5af task:TASK-001 stage:refine result:ok note:"confirmed completion and non-completion receipt paths for all stage templates"
- run:rgt72nh task:TASK-001 stage:develop result:ok note:"updated labeled receipt paths and verified focused tests"
