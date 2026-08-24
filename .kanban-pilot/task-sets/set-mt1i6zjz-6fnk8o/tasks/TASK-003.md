---
id: TASK-003
title: Task details should render Mermaid Charts properly
type: feature
state: done
status: idle
position: 1
created: 2026-08-23T23:02:29Z
updated: 2026-08-23T23:43:07Z
chat: ca630255-2632-4d44-87ce-b4720e692c04
copilot_session_id: ca630255-2632-4d44-87ce-b4720e692c04
scope_hash: a871d5e
chat_reset_required: false
---

## Request
When viewing task details, the mermaid charts are not getting rendered. I want this task to focus on that so that I will be able to see them properly

## Refined

### Problem statement

The task-detail modal displays Request, Refined, and Scope through the host-side Markdown renderer in src/board/boardPanel.ts. That renderer currently sends every fenced code block through the generic pre/code renderer, so a fenced block tagged mermaid is shown as Mermaid source text. The detail webview has no Mermaid runtime to turn that source into a chart. This ticket is limited to the task-detail presentation path: stored task Markdown, the edit form, and the existing Markdown and attachment flows must remain unchanged.

### Acceptance criteria

- A valid fenced Markdown block tagged mermaid in each of Request, Refined, and Scope renders as a visible chart in the task-detail modal rather than a generic code block. Coverage includes a flowchart and a sequence diagram.
- Multiple Mermaid blocks render in authored order, with surrounding headings, prose, lists, links, code fences, and task-local images preserved.
- Charts render on initial task selection and after detail refresh or re-render, including file-watcher updates, task switching, and close/reopen. Mermaid source remains unchanged in the task file and is still shown as editable fenced Markdown in Edit task; non-Mermaid fenced code remains ordinary code.
- Invalid or unsupported Mermaid syntax does not break the modal or prevent other sections from rendering; it produces a visible, accessible fallback containing the original source or a clear rendering-unavailable message.
- Rendering does not execute task-authored HTML or scripts and does not permit Mermaid links or images to load arbitrary remote content. The Mermaid runtime is bundled with the extension rather than fetched from a CDN; CSP and webview resource roots remain restrictive and work in both development and packaged installs.
- Existing Markdown escaping, link allowlisting, task-local image URI validation, legacy text-only tasks, latest-log display, and task-detail actions remain unchanged.
- Focused automated tests cover valid diagrams in all three sections, multiple diagrams, invalid syntax, fallback and source preservation, non-Mermaid fences, and webview CSP or bundle integration; compile, lint, and the existing test suite remain passing.

## Scope

Implementation checklist, in dependency order:

1. **Trace the current detail rendering pipeline — src/board/boardPanel.ts and src/test/boardPanel.test.ts.**
	- Reproduce the issue with Mermaid fences in Request, Refined, and Scope and confirm that renderTaskMarkdown emits the generic code-block markup while pushDetail and the browser-side renderDetail only insert that markup.
	- Keep the change limited to the detail projection. Do not change task parsing, task storage, attachment persistence, edit serialization, or the plain latest-log rendering unless the trace proves a shared boundary must change.

2. **Add a locally packaged Mermaid runtime — package.json, package-lock.json, and webpack.config.js.**
	- Add a compatible Mermaid dependency and configure the smallest browser-targeted bundle entry/output needed to ship it with the extension; do not load a CDN, fetch a remote script, or rely on the built-in Markdown preview extension to render the custom board webview.
	- Wire the bundle into BoardPanel by carrying the existing extension URI through BoardPanel.show and the constructor, allow the bundle and the active task-set resources through localResourceRoots, and update the CSP for the local script while retaining the existing nonce and restrictive defaults.
	- Make the runtime initialization explicit and repeatable so multiple charts have unique render identifiers, the current VS Code theme remains legible, and an individual render failure cannot stop the rest of the board script.

3. **Teach the Markdown and detail-view paths to render Mermaid fences — src/board/boardPanel.ts.**
	- Extend the custom fence handling in renderTaskMarkdown so only the mermaid language produces a safe, identifiable diagram container or source fallback; all other language fences retain the existing code-block output and escaping.
	- Invoke the browser renderer after each renderDetail content replacement, including refreshes and re-renders, and preserve the original source in the DOM or an accessible fallback when parsing fails.
	- Sanitize or strictly configure generated SVG/HTML, disable executable or unrestricted diagram features, and retain the existing link, raw-HTML, image, CSP, and local-resource security boundaries.
	- Add responsive detail-modal styling for diagrams, overflow handling, readable light and dark theme presentation, and an accessible name or source fallback without changing the modal's existing actions or section order.

4. **Add regression coverage — src/test/boardPanel.test.ts; update other tests only if the verified implementation changes a shared API.**
	- Assert that valid flowchart and second-kind diagrams in Request, Refined, and Scope are identified and rendered in order, while ordinary fenced code remains a code block and the task source stays unchanged.
	- Exercise multiple diagrams, malformed or unsupported syntax, safe handling of authored HTML or remote references, initial detail selection, a refresh or re-render, and a task with no diagrams. Verify that one bad diagram does not remove other Markdown sections or the latest log.
	- Verify the generated webview includes the packaged local bundle, expected CSP/resource-root allowance, and no remote script dependency; update BoardPanel test fixtures for the extension URI or bundle path as needed.

5. **Verify the complete delivery.**
	- Run the focused board tests, the full automated test suite, compile-tests, webpack compilation, and lint.
	- Manually open a task containing diagrams in all three editable sections, check light and dark VS Code themes, switch tasks, refresh the task file, close and reopen the detail modal, and confirm that invalid Mermaid remains a non-fatal accessible fallback.

## Log
- audit:state-change at:2026-08-23T23:02:33Z task:TASK-003 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-23T23:02:34Z task:TASK-003 from:idle to:running action:refine run:rvq2s8f note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-23T23:02:34Z task:TASK-003 stage:refine action:refine run:rvq2s8f note:"Started refine activity."
- run:rvq2s8f task:TASK-003 stage:refine result:ok note:"2026-08-23T23:04:11Z — clarified Mermaid detail rendering behavior, safety boundaries, regression coverage, and implementation files"
- audit:status-change at:2026-08-23T23:05:44Z task:TASK-003 from:running to:idle action:receipt run:rvq2s8f outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-23T23:05:44Z task:TASK-003 stage:refine action:receipt run:rvq2s8f outcome:ok note:"2026-08-23T23:04:11Z — clarified Mermaid detail rendering behavior, safety boundaries, regression coverage, and implementation files"
- audit:state-change at:2026-08-23T23:06:43Z task:TASK-003 from:refine to:scoped action:apply-pending run:rvq2s8f outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-23T23:06:48Z task:TASK-003 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-23T23:06:49Z task:TASK-003 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-23T23:06:49Z task:TASK-003 from:idle to:running action:develop run:rrfvqat note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-23T23:06:49Z task:TASK-003 stage:develop action:develop run:rrfvqat note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-003 expected-run:rrfvqat expected-stage:develop actual-run:rvq2s8f actual-task:TASK-003 actual-stage:refine note:"Ignored receipt because run id rvq2s8f is stale; expected rrfvqat."
- run:rrfvqat task:TASK-003 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-08-23T23:26:49Z task:TASK-003 from:running to:failed action:timeout run:rrfvqat outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-23T23:26:49Z task:TASK-003 stage:develop run:rrfvqat outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- run:rrfvqat task:TASK-003 stage:develop result:ok note:"2026-08-23T23:27:38Z — implemented local Mermaid runtime, secure detail rendering, fallbacks, and passing focused and full verification"
- audit:status-change at:2026-08-23T23:27:46Z task:TASK-003 from:failed to:idle action:late-receipt run:rrfvqat outcome:ok note:"Status changed from failed to idle via late-receipt."
- audit:activity-finish at:2026-08-23T23:27:46Z task:TASK-003 stage:develop action:late-receipt run:rrfvqat outcome:ok correction:true note:"2026-08-23T23:27:38Z — implemented local Mermaid runtime, secure detail rendering, fallbacks, and passing focused and full verification"
- audit:state-change at:2026-08-23T23:43:02Z task:TASK-003 from:in-progress to:validation action:apply-pending run:rrfvqat outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-08-23T23:43:07Z task:TASK-003 from:validation to:done action:move note:"State changed from validation to done via move."
