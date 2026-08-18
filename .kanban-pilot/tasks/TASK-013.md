---
id: TASK-013
title: Multiple Task Sets
type: feature
state: done
status: idle
created: 2026-08-16T20:15:17Z
updated: 2026-08-17T07:26:34Z
chat: kanban-pilot-TASK-013
scope_hash: b046532
chat_reset_required: false
---

## Request
I want to be able to manage multiple task sets so that I can separate tasks into sets

## Refined
Kanban Pilot currently projects one workspace-relative task directory as a single board, so unrelated work cannot be isolated without manually changing a setting. Add durable, named task sets within one workspace. A user must be able to create, select, rename, and safely remove task sets from the board; each set owns an independent task collection while retaining the same board workflow and task-file format. The existing configured task directory is the initial Default set so current tasks remain visible and usable without manual migration. For this first release, changing sets is blocked while a task run is active, avoiding an orphaned run or ambiguous reconciliation.

Acceptance criteria:
- On opening the board, the user can see the active task-set name and switch to any existing task set; the board immediately shows only that set’s cards and counts.
- The user can create a uniquely named task set. It starts empty, becomes active, and a new task created there is not shown in any other set.
- The user can rename a task set; duplicate or blank names are rejected with clear feedback.
- The user can delete only an empty, non-default task set after confirmation. The Default set cannot be deleted, and a failed deletion leaves all task files unchanged.
- Existing tasks in the configured `kanbanPilot.tasksDir` are exposed as the Default set without moving or rewriting their files; additional set metadata and task directories are workspace-local and durable across reloads.
- All task actions, file opens, task chat operations, receipts, follow-up proposals, file watchers, and automatic gate processing address the active set only. Switching is refused while that set has a running task.
- Equal task IDs in different sets cannot share a Copilot chat session, run reservation, receipt reconciliation record, or other runtime identity.
- Automated coverage verifies task-set persistence and validation, isolation when switching, legacy Default-set compatibility, deletion safeguards, and set-qualified runtime/chat identity.

## Scope
- [ ] `src/model/taskSets.ts` — add the workspace-local task-set registry and APIs for loading, creating, renaming, selecting, and deleting sets; reserve the legacy configured task directory as the immutable Default set, validate names/unique IDs, and persist the active selection atomically.
- [ ] `src/model/taskStore.ts` and `src/model/task.ts` — construct each `TaskStore` from a resolved set directory and carry the stable set identity needed by consumers, while preserving the existing task markdown schema and per-set `TASK-###` allocation.
- [ ] `src/extension.ts` — replace the singleton `tasksDir` context resolution with active-set resolution; register watchers/reconciliation and command-palette task selection against the active set, and prevent a set switch while a run is active.
- [ ] `src/board/boardPanel.ts` — add an accessible task-set selector and management UI (create, rename, delete with confirmation), include active set metadata in webview state, and refresh the board/detail view after a successful switch.
- [ ] `src/chat/runManager.ts`, `src/chat/executor.ts`, and `src/chat/sessionUri.ts` — qualify run-concurrency keys, receipt/reconciliation de-duplication, persisted `chat` values, and derived chat-session IDs with the task-set identity so overlapping task IDs remain isolated.
- [ ] `package.json` and `docs/PRD.md` — document the workspace-local task-set storage/Default-set compatibility contract and any user-visible commands or configuration introduced by the selector.
- [ ] `src/test/taskStore.test.ts`, `src/test/runManager.test.ts`, and focused board/extension tests — cover registry validation and persistence, Default-set backward compatibility, create/switch/rename/delete safeguards, active-set command routing, and collision-free session/run identity.

## Log
- run:reyjzo1 task:TASK-013 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- run:reyjzo1 task:TASK-013 stage:refine result:ok note:"refine completed: defined isolated named task sets, lifecycle, and migration scope"
- run:r6sd59b task:TASK-013 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- run:r6sd59b task:TASK-013 stage:develop result:ok note:"2026-08-16T20:39:23Z — implemented durable task sets with Default compatibility, active-set board controls, isolated runtime identities, lifecycle safeguards, documentation, and automated coverage; compile, bundle, lint, and 146 tests pass"
