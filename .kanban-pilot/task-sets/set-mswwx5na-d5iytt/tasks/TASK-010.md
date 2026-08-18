---
id: TASK-010
title: Cards must have Task Types
type: feature
state: done
status: idle
created: 2026-08-17T10:26:15Z
updated: 2026-08-18T00:41:04Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-010
copilot_session_id: 1a7b95af-5634-435c-8d49-d9763ec11b24
scope_hash: 54418c1
chat_reset_required: true
---

## Request
Task must have a type: either Feature or a Bug. I want to be able to see a mark on the card to distinguish which one is which.

## Refined
Every Kanban Pilot task needs a durable classification of exactly one of two types: Feature or Bug. The type is part of the task schema, is assigned on every task-creation path, and is also present on tasks filed automatically from an agent run. The board must show a compact, readable marker on every card so the distinction is visible without opening the task. The marker must remain understandable in VS Code themes and expose the full type to assistive technology; color alone is not sufficient. This does not change workflow columns, card actions, or add type filtering.

**Interpretation and assumptions**
- Store the canonical frontmatter value as `type: feature` or `type: bug`, while displaying the user-facing labels Feature and Bug.
- A legacy task without a valid type remains visible and is deterministically normalized to Feature, with the normalized value backfilled so every persisted task becomes typed.
- An agent-filed child inherits its parent task's type unless its proposal explicitly supplies the other valid type; old proposal lines without a type remain compatible through inheritance.

**Acceptance criteria**
- The task model accepts only `feature` or `bug` as a `TaskType`; new task files persist exactly one valid value and frontmatter rewrites preserve it.
- The board New Task dialog and the `New Task` command both require an explicit Feature/Bug choice and cannot create an untyped task.
- Develop/validate/split proposal handling produces typed child tasks, using an explicitly valid proposal type or the originating task's type; malformed types never create an untyped card.
- Existing task files that omit or contain an invalid type continue to load, are normalized to Feature by the compatibility path, and are eventually persisted with a valid type rather than disappearing from the board.
- Every card in every column renders a visually distinct Feature or Bug marker with a readable label or tooltip/accessible name, and the distinction does not depend on color alone.
- The type is included in the board projection/detail data and updates when a task file is changed, without changing the existing state/status action matrix.
- Automated tests cover schema round-tripping and normalization, all creation paths, proposal inheritance/override, and the card marker's rendered and accessible output.

## Scope
- [ ] `src/model/task.ts` — define the `TaskType` union and Feature/Bug labels; add the type to `Task`, parsing, frontmatter key ordering, and `newTaskFile`; implement the missing/invalid legacy normalization and backfill contract without weakening the existing malformed-file behavior.
- [ ] `src/model/taskStore.ts` — make task creation carry a required or resolved type, preserve it through frontmatter patches, and add the read/migration path that backfills legacy files; update every production caller so no generated task bypasses type assignment.
- [ ] `src/board/boardPanel.ts` — add a required Feature/Bug control to the New Task modal and its `task/create` payload; pass type through the board/detail projections; render a compact type badge/icon on each card with full text in its title/ARIA labeling and theme-safe styling.
- [ ] `src/extension.ts` — add the Feature/Bug choice to the command-palette New Task flow, pass it to `TaskStore.create`, and assign explicit types to seeded sample tasks.
- [ ] `src/chat/proposals.ts` and `src/chat/promptTemplates.ts` — extend the proposal contract/documentation with an optional validated type field while retaining old proposal syntax for parent-type inheritance.
- [ ] `src/chat/runManager.ts` — resolve each proposal's explicit type or the originating task's type before calling `TaskStore.create`; reject or safely ignore invalid proposal types so no untyped child is materialized.
- [ ] `src/test/taskStore.test.ts`, `src/test/boardPanel.test.ts`, `src/test/proposals.test.ts`, `src/test/runManager.test.ts`, `src/test/extension.test.ts`, and other affected `src/test/**/*.test.ts` callers — update fixtures/create calls and add coverage for persistence, legacy normalization/backfill, both human creation flows, proposal inheritance/override, and marker/ARIA rendering.
- [ ] `docs/PRD.md` — update the task-file schema, New Task/webview contract, proposal grammar, compatibility behavior, and card visual/accessibility requirements so the new type is documented as part of the product contract.

## Log
- run:rugvnbv task:TASK-010 stage:refine result:ok note:"2026-08-17T10:28:03Z — documented the task-type schema, creation paths, proposal handling, legacy compatibility, card marker, and test scope"
- run:rxxgplr task:TASK-010 stage:develop result:ok note:"2026-08-17T22:06:23Z — implemented durable Feature/Bug task types across storage, creation flows, proposals, and accessible board markers; added legacy backfill and verified the full test suite"
- run:reg66ah task:TASK-010 stage:validate result:failed note:"2026-08-18T00:32:57Z — npm test passed with 195 tests, but required automated coverage is missing for the command-palette creation path and actual rendered and accessible Feature/Bug card markers"
- run:rpjlmka task:TASK-010 stage:develop result:ok note:"2026-08-18T00:36:35Z — added command-input type validation coverage and rendered Feature/Bug badge accessibility coverage; npm test passed with 196 tests"
- run:rzr6rph task:TASK-010 stage:validate result:ok note:"2026-08-18T00:40:24Z — verified schema persistence and legacy backfill, board and command type guards, typed proposal inheritance and overrides, rendered accessible markers, projections, unchanged action behavior, and npm test passed with 196 tests"
