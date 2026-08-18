---
id: TASK-006
title: Improve Prompt Templates, add on Non-Completion
type: feature
state: done
status: idle
created: 2026-08-15T07:59:58Z
updated: 2026-08-15T08:53:16Z
chat: kanban-pilot-TASK-006
copilot_session_id: 7698ea9c-becb-4705-b4b0-73576a679515
scope_hash: 93fe686
chat_reset_required: true
---

## Request
for the Prompts, add a Non-Completion part. ensure that Blocked state would have proper explanations.

## Refined
The built-in stage prompt templates need a clearly separated non-completion
path so an agent that cannot finish does not leave the task ambiguous or omit
the receipt that drives the card state. Every supported stage must explain
when to record `result:blocked` and require the `note` to identify the
concrete blocker, missing decision or input, or unresolved question so a
human can act on the Blocked card. Completion and non-completion must remain
mutually exclusive. Validation must retain its three-way meaning: `result:ok`
when the criteria are met, `result:failed` when validation completes and the
criteria are not met, and `result:blocked` only when a pass/fail verdict
cannot be determined.

Acceptance criteria:
- The default `refine`, `develop`, `validate`, and `split` templates each have
	visibly labelled `### Completion` and `### Non-completion` sections under
	`## On Completion`, in that order.
- Each completion path documents the stage-appropriate receipt: `ok` for
	refine, develop, and split; `ok` and `failed` for validate.
- Each non-completion path instructs the agent to append exactly one
	stage-matching `result:blocked` receipt instead of a completion receipt, and
	requires a concise, actionable explanation in `note`.
- The validate instructions explicitly distinguish an unmet acceptance
	criterion (`result:failed`) from an inability to determine pass/fail
	(`result:blocked`); the split instructions explain why a task is not being
	split when that is the non-completion outcome.
- Rendered receipt examples retain the current `runId` and task-id
	substitutions and remain compatible with the receipt parser, while the
	existing rule that agents must not edit frontmatter or immutable task
	sections remains intact.
- Automated template tests cover every supported stage, both labelled paths,
	the expected stage-specific results, and preservation of user-customized
	templates when defaults are loaded.

## Scope
- Update the built-in template strings in `src/chat/promptTemplates.ts` for
	`refine`, `develop`, `validate`, and `split`:
	- Add explicit `### Completion` and `### Non-completion` subsections.
	- Keep the successful receipt instructions stage-specific and add a
		`result:blocked` receipt for the non-completion branch with guidance to
		state the concrete blocker or required human input in the note.
	- Preserve validate's `ok`/`failed` verdict paths and clarify that
		`blocked` means no verdict can be reached; preserve split's proposal
		ordering and its explanation when no split is needed.
	- Retain the existing task/run substitutions and file-edit restrictions;
		do not change the template loader's user-edit preservation behavior.
- Extend `src/test/receiptAndTemplates.test.ts` to render each default stage
	with representative variables and assert subsection ordering, stage/task/
	run-specific receipt lines, blocked-note guidance, validate's three outcomes,
	and the existing no-overwrite behavior for customized templates.
- Update the prompt-template contract examples in `docs/PRD.md` §6.5 so the
	documented completion and non-completion behavior, including the meaning of
	`result:blocked`, matches the seeded defaults.
- Leave existing `.kanban-pilot/prompts/*.md` copies untouched: they are
	user-owned, ignored workspace files and are intentionally not overwritten
	by the default seeding path. Any migration of already-customized copies is
	outside this ticket.

## Log
- run:rf8pfyx task:TASK-006 stage:refine result:ok note:"2026-08-15T08:01:12Z — refine completed: defined stage-specific non-completion receipts, actionable blocked notes, and test coverage"
- run:r4nc4hu task:TASK-006 stage:develop result:ok note:"2026-08-15T08:10:49Z — implemented actionable non-completion guidance, stage-specific blocked receipts, aligned PRD examples, and added coverage"
- run:rpowem4 task:TASK-006 stage:validate result:ok note:"2026-08-15T08:52:42Z — validation passed: prompt-template tests, compilation, and lint passed; one unrelated run-capacity test remains failing in the full suite"
