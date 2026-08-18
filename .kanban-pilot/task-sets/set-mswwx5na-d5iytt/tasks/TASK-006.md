---
id: TASK-006
title: Enable editing of tasks
type: feature
state: done
status: idle
created: 2026-08-17T09:16:13Z
updated: 2026-08-17T23:15:36Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-006
copilot_session_id: bdffedda-f4ed-4f71-b665-1c8122b27a63
scope_hash: 5a1cb83
chat_reset_required: true
---

## Request
I want to be able to edit a task through the UI

## Refined

### Problem statement

The board can create a task with a title and optional description, but selecting an existing card only shows its task detail as read-only or opens the raw Markdown file. A user who notices a typo or needs to correct the task specification must leave the board and edit the file manually. Add an accessible in-board editor for the selected task so its user-facing specification can be revised without bypassing the active task set or the board's disk-backed source of truth.

### Interpretation and boundaries

- Editing means changing the title and the three task-specification sections already shown in the detail dialog: `## Request`, `## Refined`, and `## Scope`. The fields remain Markdown text, not a rich-text format.
- The task id, workflow column, runtime status/run, chat/session metadata, checkpoint, origin metadata, and append-only `## Log` are not editable through this form. Existing move and workflow actions remain the only way to change workflow state.
- A saved `## Scope` change must leave the existing `scope_hash` untouched so the current human-edited-scope detection still works during Develop. Editing must not create a receipt or audit entry; it only updates the task content and its `updated` timestamp.
- To avoid clobbering an agent's in-flight body/frontmatter writes, saving is unavailable for a task whose status is `running`; the host must enforce this even if the webview sends a forged message.

### Acceptance criteria

- The selected task detail dialog exposes an accessible Edit action. Entering edit mode pre-fills the current title, Request, Refined, and Scope values, preserves the task id/status context, and provides Save and Cancel controls.
- The editor accepts multiline Markdown in the specification fields and requires a non-blank, trimmed title no longer than the existing New Task limit. Invalid or malformed webview payloads, missing task ids, and attempts to save a running task are rejected without a partial write, and the user receives a visible error while the editor remains usable.
- Saving writes the title and the three selected body sections to the active `TaskStore` through its atomic write path. The card title and detail view refresh from disk, and the change is isolated to the active task set without a reload.
- A successful edit preserves the task id, state, status, run/session metadata, scope hash, checkpoint, origin metadata, every existing log line, and any unrelated body content byte-for-byte; it does not move the card, start/stop a run, or append a log receipt.
- Cancel, the close button, backdrop dismissal, and Escape discard unsaved values and do not write the task file. Editing can be reopened with the latest persisted values after an external file change.
- Editing behavior is keyboard-operable and theme-safe, follows the existing modal exclusivity and focus conventions, and does not regress card selection, task creation, deletion, opening the task file/chat, drag-and-drop, or workflow actions.
- Automated tests cover section/title persistence, atomic body and metadata preservation, validation and running-task rejection, cancel/no-write behavior, webview rendering and message validation, and board refresh after a successful edit. The PRD and README document the edit surface and the protected workflow/audit fields.

## Scope
- [ ] `src/model/task.ts` — add a typed editable-content shape and a safe helper for replacing the title plus the fixed `Request`, `Refined`, and `Scope` sections while preserving `## Log`, other body content, and frontmatter structure. Keep section replacement separate from receipt/log handling and retain Markdown verbatim.
- [ ] `src/model/taskStore.ts` — add an atomic `update`/`edit` operation for an existing task that validates the title and target task, rejects `status: running`, updates only the title and editable sections, preserves all other metadata, and bumps `updated`. Return clear errors for missing or invalid tasks without leaving a partial file.
- [ ] `src/board/boardPanel.ts` — extend the detail payload and webview message protocol with an edit/save path; add the Edit form and accessible Save/Cancel controls for title, Request, Refined, and Scope; prefill from the selected task; validate payloads in the extension host; surface save failures; enforce the running-task guard; and preserve modal focus, Escape/backdrop handling, task-set isolation, and watcher-driven refreshes.
- [ ] `src/test/taskStore.test.ts` — test successful edits, blank/overlong title rejection, multiline Markdown, missing/running-task rejection, atomic preservation of frontmatter/body/log content, unchanged `scope_hash`, updated timestamp behavior, and no-op behavior when a save is not accepted.
- [ ] `src/test/boardPanel.test.ts` — extend the webview harness with assertions for the Edit affordance/form, prefilled editable fields, keyboard/modal behavior, valid and invalid update messages, running-task protection, visible error handling, and a successful detail/card refresh without changing existing settings and action protocols.
- [ ] `docs/PRD.md` — update the task field-ownership and §6.11 webview contract to define UI editing of the title and specification sections, the protected frontmatter/log fields, the unchanged scope-hash semantics, running-task safety guard, atomic persistence, and cancel/error behavior.
- [ ] `README.md` — add the edit flow to the quick start/features and explain which task content is editable in the board versus which workflow metadata and log history remain controlled or read-only.
- [ ] Manual smoke check — select tasks in multiple columns and task sets, edit and cancel with mouse and keyboard, verify Markdown re-renders and survives a board reload, verify running tasks cannot be saved, and confirm existing actions and raw-file opening still work.

## Log
- run:r2r43p6 task:TASK-006 stage:refine result:ok note:"2026-08-17T10:44:29Z — refined the in-board task editor behavior, protected metadata, persistence path, tests, and documentation scope"
- run:r3n0wwb task:TASK-006 stage:develop result:failed note:"timed out"
- run:rgnadlb task:TASK-006 stage:develop result:ok note:"2026-08-17T11:52:28Z — implemented the atomic in-board task editor, host validation and running guard, preservation tests, and README/PRD documentation"
- run:rtyfe5l task:TASK-006 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- run:rc0dhqa task:TASK-006 stage:develop result:ok note:"2026-08-17T21:07:41Z — verified the in-board editor, atomic preservation and host validation with the full test suite"
- run:rntbe3j task:TASK-006 stage:validate result:failed note:"2026-08-17T22:42:44Z — full suite passed with 192 tests, but a valid title such as Fix #123 is serialized unquoted and reparses as Fix"
- run:rirr5ca task:TASK-006 stage:develop result:ok note:"2026-08-17T22:46:47Z — fixed quoted frontmatter title round-tripping for inline comment markers and verified the full test suite"
- run:rcaxnb2 task:TASK-006 stage:validate result:blocked note:"2026-08-17T22:55:37Z — full npm test passed with 192 tests, but no recorded manual smoke evidence exists for direct editor and modal interactions across columns and task sets"
