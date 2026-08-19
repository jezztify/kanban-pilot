---
id: TASK-008
title: Improve Refining Prompt
type: feature
state: done
status: idle
created: 2026-08-17T09:18:55Z
updated: 2026-08-17T23:59:38Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-008
copilot_session_id: bd76b7eb-666a-4ce2-b594-5cf4730b2730
scope_hash: a800d3a
chat_reset_required: true
---

## Request
Improve the refining prompt by also asking whether it recommended to split the task into smaller tasks or not.

## Refined
### Problem statement
The built-in refine-stage prompt asks the agent to clarify the request and produce acceptance criteria and an implementation checklist, but it does not explicitly assess whether the work is appropriately sized for one task. Refinement should also give the human a clear recommendation about splitting the request into smaller, independently workable tasks, without turning the normal refine run into the separate task-splitting workflow.

### Acceptance criteria
- The default refine prompt explicitly asks whether the task should be split into smaller independent tasks.
- The refinement output records an unambiguous yes-or-no split recommendation under `## Refined`.
- A recommendation to split includes a concise rationale and proposed independent boundaries; a recommendation not to split includes a concise reason why one task is sufficient.
- The recommendation is advisory only: refine does not create child task files, add `propose-task` lines, or invoke the separate `split` action.
- The existing refine responsibilities remain intact: sharpen the problem statement, document acceptance criteria, produce the `## Scope` checklist, and avoid editing product code.

## Scope
- Update `src/chat/promptTemplates.ts` in `DEFAULT_REFINE_TEMPLATE` to add a third refinement instruction that requests an explicit split recommendation, rationale, and candidate boundaries when applicable, while preserving the existing scoping-only and completion-contract instructions.
- Extend `src/test/receiptAndTemplates.test.ts` with coverage that the built-in refine template contains the split-assessment instruction and directs both split and no-split outcomes to be recorded without creating tasks or implementation work.
- Preserve the existing prompt seeding behavior: do not migrate, overwrite, or add a committed `.kanban-pilot/prompts/refine.md` user-owned template; the new wording applies to the built-in template used when no user template exists.

## Log
- run:r3quk6c task:TASK-008 stage:refine result:ok note:"2026-08-17T10:48:34Z — refine completed: documented the default prompt change and split-recommendation test scope"
- run:rq92b5e task:TASK-008 stage:develop result:ok note:"2026-08-17T21:39:48Z — updated the built-in refine prompt with an advisory split recommendation and added coverage"
- run:renc4uy task:TASK-008 stage:validate result:ok note:"2026-08-17T23:59:19Z — validation passed: inspected the built-in refine template, seeding guard, and template coverage; npm test completed with 195 passing tests"
