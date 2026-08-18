---
id: TASK-009
title: Allow handling of images in tasks
type: feature
state: in-progress
status: failed
position: 0
created: 2026-08-18T09:53:00Z
updated: 2026-08-18T11:26:46Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-009
copilot_session_id: a900bb9f-8245-4344-88e7-3db49a8bb8e4
scope_hash: f1593ac
chat_reset_required: false
---

## Request
I want to be able to attach or copy-paste images when creating or editing a task

## Refined

### Problem statement

The board's **New Task** modal currently accepts only a title, description, and type, while the task-detail editor accepts only text for the title and the `Request`, `Refined`, and `Scope` Markdown sections. A user cannot attach a screenshot from disk or paste an image from the clipboard, so visual requirements and bug evidence are lost before they reach the durable task file. The task schema, detail renderer, and Copilot run currently also have no task-scoped image-attachment convention.

Treat an image as a durable attachment owned by the task, not as an ephemeral chat upload: store it beside the Markdown file in the active task set, insert a relative Markdown image reference into the focused editable section (`Description` maps to `## Request` during creation), render that reference safely in the board, and provide the same image files to the task's stage chat. This ticket covers the board's create/edit workflow and the command-palette entry must use that same attachment-capable surface; it does not add remote-image fetching, SVG support, or arbitrary HTML rendering.

### Acceptance criteria

- The board's **New Task** modal has an accessible image attachment control that accepts one or more PNG, JPEG, GIF, or WebP files, and its `Description` field accepts pasted clipboard images. Pasting ordinary text continues to behave as normal; each accepted image is shown with a useful name/preview, can be removed before submission, and is inserted at the focused field's caret without losing surrounding Markdown.
- The task-detail **Edit task** form provides the same picker and clipboard-paste behavior for the `Request`, `Refined`, and `Scope` fields. Existing task images are discoverable in the editor, can be explicitly removed, and unchanged images survive an edit; Cancel, Escape, backdrop dismissal, and a failed save do not write or delete attachment files.
- Creating a task writes every accepted image into a task-specific attachment directory beside that task's Markdown file in the active task-set directory, using generated safe names and relative Markdown image links such as `TASK-009.attachments/<file>`. The links appear in the appropriate body section, preserve the selected order, remain valid after reload/task-set switching, and do not put binary data in frontmatter or the task log.
- Editing a task adds and removes attachment files and their references through the same serialized/atomic persistence boundary as the Markdown edit. Invalid MIME types, SVGs, path traversal names, and images larger than 10 MiB are rejected with an inline error and no partial task or attachment write. Existing text, frontmatter, `scope_hash`, unrelated body content, and append-only log lines retain their current behavior.
- The task detail modal renders valid task-local image references from `Request`, `Refined`, and `Scope` with escaped alt text and bounded preview styling. It uses webview-safe local resource URIs and an updated CSP/resource-root policy; missing or invalid assets show a non-fatal placeholder, and user-authored raw HTML, remote image URLs, and arbitrary filesystem paths are never turned into image sources.
- A task deletion removes its task-specific attachment directory, while legacy tasks and tasks with no attachments continue to load, edit, render, and delete exactly as before. Attachments from one task or task set cannot be selected or sent for another task.
- Refine, Develop, Continue, and Validate runs attach the current task Markdown file plus the task's referenced image files to that task's Copilot session. The generated prompt identifies the attachments as task input and preserves the existing frontmatter/section ownership rules; ordinary text-only runs and the clipboard fallback remain unchanged.
- The header's **New Task** action and `kanban-pilot.newTask` command reach the same image-capable creation flow, and the completed workflow remains keyboard-operable with visible, assistive-technology-readable validation and persistence errors.

## Scope
- [ ] `src/model/task.ts` — define the task-attachment metadata and transient create/edit payloads; validate the supported MIME types, 10 MiB limit, generated relative paths, and Markdown image-reference shape without adding attachment data to frontmatter or changing the existing editable-section contract for text-only tasks.
- [ ] `src/model/taskStore.ts` — add active-task-set attachment-directory/path helpers, safe unique filename allocation, attachment listing, and binary writes. Extend create/edit persistence to commit Markdown references and image files together with rollback/temporary-file cleanup on failure, preserve existing atomic text behavior, and expose only the current task's valid attachment URIs to callers.
- [ ] `src/board/actions.ts` — route task deletion through attachment-aware store cleanup so a confirmed delete removes the Markdown file and its task-specific assets without affecting neighboring tasks or shared task-set files.
- [ ] `src/board/boardPanel.ts` — extend the `task/create` and `task/edit` message validation/payloads; add accessible picker, paste, preview, caret insertion, and explicit-remove controls to the New Task and detail-edit modals; keep form state isolated until Save/Create succeeds. Update task-detail projection and the hand-rolled Markdown renderer for validated local images, configure `localResourceRoots`/`img-src`, handle active task-set changes, and preserve the strict CSP/HTML-escaping boundary.
- [ ] `src/extension.ts` — make the Command Palette **New Task** command open or delegate to the board's canonical attachment-capable modal instead of maintaining a second text-only creation flow; retain the existing title/type validation helper for compatible programmatic callers and update its tests as needed.
- [ ] `src/chat/runManager.ts`, `src/chat/executor.ts`, `src/chat/promptTemplates.ts`, and the checked-in `.kanban-pilot/prompts/{refine,develop,validate}.md` defaults — resolve the active task's image files, include them after the task Markdown in `attachFiles`, and add concise prompt guidance to treat them as read-only task context unless the scope explicitly says otherwise. Preserve named-task-set paths, session isolation, receipt grammar, and user-customized prompt files.
- [ ] `src/test/taskStore.test.ts` and `src/test/boardPanel.test.ts` — cover create/edit round trips, multiple files, clipboard/file payload validation, caret insertion/removal, cancel and failed-save behavior, safe-path and size/type rejection, image rendering/CSP, missing assets, named task sets, and deletion cleanup.
- [ ] `src/test/executor.test.ts`, `src/test/runManager.test.ts`, `src/test/extension.test.ts`, and `src/test/receiptAndTemplates.test.ts` — verify task-file-plus-image `attachFiles` ordering and isolation, prompt attachment guidance, command-palette/modal parity, and unchanged text-only execution and receipt behavior.
- [ ] `docs/PRD.md` and `README.md` — document the task-local attachment directory and relative Markdown-link convention, supported formats/limit, board and command-palette workflow, rendering/security behavior, agent visibility, and cleanup/legacy compatibility. Finish with focused tests, compile/lint, the full test suite, and a diff review limited to this feature's implementation and documentation.

## Log
- audit:state-change at:2026-08-18T09:56:03Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T11:02:05Z task:TASK-009 from:idle to:running action:refine run:ri2sy2b note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T11:02:05Z task:TASK-009 stage:refine action:refine run:ri2sy2b note:"Started refine activity."
- run:ri2sy2b task:TASK-009 stage:refine result:ok note:"2026-08-18T11:05:48Z — refined image attachment and clipboard-paste behavior across task storage, board editing, Copilot inputs, tests, and documentation"
- audit:state-change at:2026-08-18T11:06:41Z task:TASK-009 from:refine to:scoped action:receipt run:ri2sy2b outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T11:06:41Z task:TASK-009 from:running to:idle action:receipt run:ri2sy2b outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T11:06:41Z task:TASK-009 stage:refine action:receipt run:ri2sy2b outcome:ok note:"2026-08-18T11:05:48Z — refined image attachment and clipboard-paste behavior across task storage, board editing, Copilot inputs, tests, and documentation"
- audit:state-change at:2026-08-18T11:06:45Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T11:06:46Z task:TASK-009 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T11:06:46Z task:TASK-009 from:idle to:running action:develop run:rgmdetl note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T11:06:46Z task:TASK-009 stage:develop action:develop run:rgmdetl note:"Started develop activity."
- run:rgmdetl task:TASK-009 stage:develop result:failed note:"timed out"
- audit:status-change at:2026-08-18T11:26:46Z task:TASK-009 from:running to:failed action:timeout run:rgmdetl outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-18T11:26:46Z task:TASK-009 stage:develop run:rgmdetl outcome:timeout note:"Activity timed out."
