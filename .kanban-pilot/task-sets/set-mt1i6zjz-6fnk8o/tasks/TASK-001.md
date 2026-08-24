---
id: TASK-001
title: Improve rendering of Markdown when viewing Task Details
type: feature
state: done
status: idle
position: 0
created: 2026-08-20T12:36:36Z
updated: 2026-08-23T23:01:37Z
chat: fcf8182e-45c7-444c-9461-af2e62078c1e
copilot_session_id: fcf8182e-45c7-444c-9461-af2e62078c1e
scope_hash: 6169455
chat_reset_required: false
---

## Request
Given I have a task created
And I am using markdown syntax
When I view the task details
Then I should see a fully-viewable markdown rendering within the task details modal

## Refined

### Problem statement

The `Request`, `Refined`, and `Scope` sections in a task file are authored as Markdown, but
the Task Details modal currently uses a deliberately narrow hand-written renderer. Markdown
that falls outside that small subset can appear as literal syntax, lose its intended structure,
or make long and wide content difficult to read. This makes requirements and implementation
scope harder to review in the board, even though the same content is valid and readable in the
task file.

The modal needs a read-only, fully viewable rendering of the task's specification sections while
preserving the original Markdown for the existing Edit task form. Rendering must remain safe for
agent- and user-authored content: raw HTML and unsafe URLs must not become executable webview
content, and validated task-local images must retain their current safe attachment behavior. The
Latest log is a machine-readable receipt area and should remain literal/preformatted rather than
being treated as prose Markdown.

### Acceptance criteria

- Selecting a task opens its detail modal with the `Request`, `Refined`, and `Scope` sections
	rendered as structured Markdown instead of exposing their formatting markers as ordinary text.
- The renderer supports the task-authoring CommonMark/GFM constructs needed for a complete review:
	headings, paragraphs, soft and hard line breaks, emphasis, strong text, strikethrough, inline
	and fenced code, blockquotes, thematic breaks, ordered and unordered lists (including nesting),
	task checklists, links, tables, and Markdown images.
- Rendered content preserves the authored text and ordering. Empty sections remain usable and show
	the existing empty-state treatment; malformed or unsupported syntax degrades to readable text
	rather than disappearing or breaking the rest of the modal.
- Raw HTML is escaped and never creates arbitrary elements or event handlers. Only approved HTTP(S)
	links are actionable, and unsafe schemes such as `javascript:` are rendered harmlessly. Image
	sources are limited to validated attachments belonging to the displayed task; missing, invalid,
	cross-task, remote, or unmapped image references show a non-fatal unavailable state with safe alt
	text instead of loading an arbitrary resource.
- Long Markdown remains usable inside the modal's existing bounded, vertically scrollable body;
	code blocks and wide tables/images do not force the modal or board to overflow. Headings retain
	semantic elements, images retain meaningful alt text, and checklist controls remain non-editable
	and accessible to keyboard and assistive-technology users.
- The Latest log continues to display its raw receipt text in preformatted form, and existing
	detail actions (move, edit, open file, open chat, pending completion, recovery, and secondary
	actions) continue to work without changing task files or log entries merely by viewing them.
- Plain-text and empty legacy tasks, task-local image rendering, named task-set routing, editing,
	modal dismissal, and the existing CSP/resource-root security boundary continue to pass regression
	coverage.

## Scope

- [ ] `package.json` and `package-lock.json` — add the chosen browser-safe CommonMark/GFM Markdown
	parser as a direct production dependency (rather than relying on the current transitive package
	tree), and keep the existing webpack bundle able to ship it with the extension.
- [ ] `src/board/boardPanel.ts` — replace the narrow inline `renderInline`/`renderMarkdown`
	implementation with a configured, security-constrained renderer for `Request`, `Refined`, and
	`Scope`. Disable raw HTML, enforce the safe HTTP(S) link policy, preserve source Markdown for
	editing, and add custom handling for task-local attachment references, unavailable-image
	placeholders, escaped alt text, and accessible task checklists. Keep `Latest log` on its current
	literal/preformatted path.
- [ ] `src/board/boardPanel.ts` — update the task-detail payload/rendering boundary so the modal
	receives the safely rendered section output without exposing arbitrary HTML, while retaining the
	existing attachment URI mapping, `localResourceRoots`, and restrictive image CSP. Remove or
	consolidate the obsolete browser-side parser so there is one tested rendering policy.
- [ ] `src/board/boardPanel.ts` — extend the detail-modal styles for the renderer's semantic output:
	nested lists and checklists, tables with readable headers and borders, fenced/inline code,
	blockquotes and rules, safe image sizing, link states, and horizontal overflow handling for wide
	content without changing the modal's established scrolling and responsive behavior.
- [ ] `src/test/boardPanel.test.ts` — add a representative task-detail Markdown fixture and assert
	the rendered DOM for headings, paragraphs/breaks, emphasis, strikethrough, nested lists,
	checklists, blockquotes, rules, tables, inline/fenced code, safe links, and section ordering;
	verify that Markdown markers are not shown as raw syntax while authored text is preserved.
- [ ] `src/test/boardPanel.test.ts` — add security and regression assertions for escaped raw HTML,
	unsafe links, remote/unmapped/cross-task images, missing attachments, accessible alt text and
	disabled checkboxes, the literal Latest log, empty/plain-text tasks, existing attachment URIs,
	named task sets, and unchanged modal actions. Keep the existing image/CSP tests passing.
- [ ] Verification — run the focused board-panel tests plus `npm run compile-tests`, `npm run compile`,
	`npm run lint`, and the full test suite; review `git diff --check` and confirm that viewing a task
	does not write the task Markdown, frontmatter, attachments, or append-only log.

## Log
- audit:state-change at:2026-08-20T12:36:39Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T12:36:41Z task:TASK-001 from:idle to:running action:refine run:r5tga2v note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T12:36:41Z task:TASK-001 stage:refine action:refine run:r5tga2v note:"Started refine activity."
- run:r5tga2v task:TASK-001 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-08-20T12:36:47Z task:TASK-001 from:running to:blocked action:missing-receipt run:r5tga2v outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-08-20T12:36:47Z task:TASK-001 stage:refine run:r5tga2v outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-08-20T12:36:55Z task:TASK-001 from:blocked to:idle action:refine note:"Status changed from blocked to idle via refine."
- audit:status-change at:2026-08-20T12:36:55Z task:TASK-001 from:idle to:running action:refine run:rsk92wv note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T12:36:55Z task:TASK-001 stage:refine action:refine run:rsk92wv note:"Started refine activity."
- run:rsk92wv task:TASK-001 stage:refine result:ok note:"2026-08-20T12:38:14Z — refined the modal Markdown contract, safe rendering scope, regression tests, and validation checklist"
- audit:status-change at:2026-08-20T12:39:35Z task:TASK-001 from:running to:idle action:receipt run:rsk92wv outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T12:39:35Z task:TASK-001 stage:refine action:receipt run:rsk92wv outcome:ok note:"2026-08-20T12:38:14Z — refined the modal Markdown contract, safe rendering scope, regression tests, and validation checklist"
- audit:state-change at:2026-08-20T12:47:37Z task:TASK-001 from:refine to:scoped action:apply-pending run:rsk92wv outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-20T12:47:40Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-20T12:47:40Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-20T12:47:40Z task:TASK-001 from:idle to:running action:develop run:r91sdnq note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-20T12:47:40Z task:TASK-001 stage:develop action:develop run:r91sdnq note:"Started develop activity."
- run:r91sdnq task:TASK-001 stage:develop result:ok note:"2026-08-20T13:02:29Z — implemented host-side CommonMark/GFM rendering with safe links, task-local images, detail styling, and regression coverage; all verification checks pass"
- audit:status-change at:2026-08-20T13:07:11Z task:TASK-001 from:running to:idle action:receipt run:r91sdnq outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T13:07:11Z task:TASK-001 stage:develop action:receipt run:r91sdnq outcome:ok note:"2026-08-20T13:02:29Z — implemented host-side CommonMark/GFM rendering with safe links, task-local images, detail styling, and regression coverage; all verification checks pass"
- audit:state-change at:2026-08-20T13:08:19Z task:TASK-001 from:in-progress to:validation action:apply-pending run:r91sdnq outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:status-change at:2026-08-20T13:08:22Z task:TASK-001 from:idle to:running action:validate run:rbb5e4a note:"Status changed from idle to running via validate."
- audit:activity-start at:2026-08-20T13:08:22Z task:TASK-001 stage:validate action:validate run:rbb5e4a note:"Started validate activity."
- run:rbb5e4a task:TASK-001 stage:validate result:ok note:"2026-08-20T13:12:07Z — validated Markdown rendering, security boundaries, attachments, modal regressions, and required checks; focused and full suites pass"
- audit:status-change at:2026-08-20T13:12:25Z task:TASK-001 from:running to:idle action:receipt run:rbb5e4a outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T13:12:25Z task:TASK-001 stage:validate action:receipt run:rbb5e4a outcome:ok note:"2026-08-20T13:12:07Z — validated Markdown rendering, security boundaries, attachments, modal regressions, and required checks; focused and full suites pass"
- audit:state-change at:2026-08-23T23:01:37Z task:TASK-001 from:validation to:done action:apply-pending run:rbb5e4a outcome:ok note:"State changed from validation to done via apply-pending."
