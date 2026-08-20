---
id: TASK-003
title: Task attachments not rendered properly when image attachments are added
type: bug
state: validation
status: idle
position: 1
created: 2026-08-19T21:48:02Z
updated: 2026-08-19T23:09:08Z
chat: kanban-pilot-set-mt022q8z-a5m5we-TASK-003
copilot_session_id: 4f0ca19f-e3e6-4921-942a-148e0df1ec1e
scope_hash: d6eea14
chat_reset_required: false
---

## Request
C:\Repositories\kanban-pilot\.kanban-pilot\task-sets\set-mt022q8z-a5m5we\tasks\TASK-002.md

When checking task details, I see "Image Unavailable"

## Refined

### Problem statement

Opening task details for a task with durable task-local image attachments can render an `Image unavailable` placeholder instead of the saved image. The supplied reproduction is `TASK-002`: its Request contains valid Markdown references to `TASK-002.attachments/image.png` and `TASK-002.attachments/image-2.png`, and the corresponding PNG files are present in the active named task set, but the detail view does not display them. The failure is in the detail-view path that resolves task-local references, projects attachment metadata into the webview, or accepts the generated webview resource URI; it is not a request to remove the existing attachment validation or security boundaries.

The fix must make valid images owned by the current task and active task set render reliably in the Request, Refined, and Scope sections while retaining a non-fatal unavailable placeholder for missing, corrupt, unreferenced, cross-task, remote, SVG, or raw-HTML image attempts. Attachment storage, Markdown links, chat context injection, and named task-set isolation must not regress as part of this focused detail-rendering repair.

### Acceptance criteria

- Opening `TASK-002` in the supplied active named task set renders both `image.png` and `image-2.png` as actual images in the task detail content; neither valid reference is replaced by `Image unavailable`, and Markdown order and alt text are preserved.
- The same behavior works for valid PNG, JPEG, GIF, and WebP references in each of the Request, Refined, and Scope sections, for both the immutable Default task set and a named task set. A task never resolves an attachment from another task or another task set.
- The host-to-webview payload maps each validated current-task reference to a resource URI that is allowed by the active webview's `localResourceRoots` and CSP. The rendered `img` source is never a direct filesystem path, `file:` URI, remote URL, or user-controlled path.
- Missing or corrupt files, unreferenced files, cross-task references, remote or unsafe URLs, SVG images, and raw HTML image attempts remain non-fatal and render the existing accessible unavailable placeholder rather than bypassing validation or breaking the detail modal. Text, links, legacy text-only tasks, and the New Task/Edit attachment previews continue to work.
- Regression coverage exercises the supplied two-image reproduction, multiple image ordering, Default and named task-set routing, safe URI generation, and the rejected/placeholder cases. `npm test`, `npm run build` (or the repository's compile/build equivalent), and `npm run lint` remain green.

## Scope

Implementation checklist, in dependency order:

1. **Reproduce and trace the detail attachment pipeline — `src/board/boardPanel.ts`, `src/model/taskStore.ts`, and `src/model/task.ts`.**
	- Use the supplied `TASK-002.md` and its read-only `TASK-002.attachments` directory to verify that the two Markdown references, stored files, `TaskStore.listAttachments`, detail payload, generated webview URI, `localResourceRoots`, CSP, and webview renderer agree on the same active task-set path.
	- Identify whether the mismatch is in reference parsing/order, attachment projection, URI generation/allowlisting, or the inline Markdown renderer. Keep the repair limited to the valid task-local image path; do not redesign task storage or the Markdown parser.

2. **Repair secure detail rendering — primarily `src/board/boardPanel.ts`; update `src/model/taskStore.ts` or `src/model/task.ts` only if the trace proves the shared reference boundary is the cause.**
	- Ensure every validated reference belonging to the current task is paired with the corresponding `asWebviewUri` resource from the active store directory and rendered as an image in all three Markdown sections.
	- Keep escaping, task-id/path validation, MIME validation, `localResourceRoots`, CSP, and the existing unavailable-placeholder behavior intact for invalid or unsafe inputs. Do not expose arbitrary filesystem or remote image sources.
	- Preserve attachment ordering, active named-set routing, legacy text-only task behavior, and the existing New Task/Edit preview and chat-attachment behavior.

3. **Add focused regression coverage — `src/test/boardPanel.test.ts`; extend `src/test/taskStore.test.ts` only if the shared attachment-resolution code changes.**
	- Create a task with the supplied-style two-image Request and assert the detail webview contains two `img` elements with the expected safe resource sources, names, alt text, and Markdown order.
	- Cover images in Request, Refined, and Scope, named-set versus Default routing, multiple supported image MIME types, and a refresh/reopen of the detail view.
	- Assert missing, corrupt, unreferenced, cross-task, remote, SVG, raw-HTML, malformed-source, and unsafe-URI inputs still produce the accessible unavailable placeholder and never an unsafe `img` source.

4. **Verify without modifying the supplied inputs.**
	- Run the focused board/task-store tests, then the full test suite, compile/build, and lint. Confirm manually that the supplied `TASK-002` detail view shows both screenshots and that no attachment binary or task Markdown reference needs to be renamed or rewritten.

## Log
- audit:state-change at:2026-08-19T21:48:04Z task:TASK-003 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-19T21:48:08Z task:TASK-003 from:idle to:running action:refine run:rl7vk3m note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-19T21:48:08Z task:TASK-003 stage:refine action:refine run:rl7vk3m note:"Started refine activity."
- run:rl7vk3m task:TASK-003 stage:refine result:ok note:"2026-08-19T21:54:11Z — clarified valid task-local image detail rendering and scoped secure regression coverage"
- audit:status-change at:2026-08-19T21:55:39Z task:TASK-003 from:running to:idle action:receipt run:rl7vk3m outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T21:55:39Z task:TASK-003 stage:refine action:receipt run:rl7vk3m outcome:ok note:"2026-08-19T21:54:11Z — clarified valid task-local image detail rendering and scoped secure regression coverage"
- audit:state-change at:2026-08-19T22:02:08Z task:TASK-003 from:refine to:scoped action:apply-pending run:rl7vk3m outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-19T22:02:11Z task:TASK-003 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-19T22:44:31Z task:TASK-003 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-19T22:44:31Z task:TASK-003 from:idle to:running action:develop run:r8xdzyo note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-19T22:44:31Z task:TASK-003 stage:develop action:develop run:r8xdzyo note:"Started develop activity."
- run:r8xdzyo task:TASK-003 stage:develop result:ok note:"2026-08-19T22:58:25Z — fixed modern VS Code webview attachment URI validation and added detail rendering regression coverage"
- audit:status-change at:2026-08-19T22:58:57Z task:TASK-003 from:running to:idle action:receipt run:r8xdzyo outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-19T22:58:57Z task:TASK-003 stage:develop action:receipt run:r8xdzyo outcome:ok note:"2026-08-19T22:58:25Z — fixed modern VS Code webview attachment URI validation and added detail rendering regression coverage"
- audit:state-change at:2026-08-19T23:09:08Z task:TASK-003 from:in-progress to:validation action:apply-pending run:r8xdzyo outcome:ok note:"State changed from in-progress to validation via apply-pending."
