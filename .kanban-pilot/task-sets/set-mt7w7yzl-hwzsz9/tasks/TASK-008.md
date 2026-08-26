---
id: TASK-008
title: Browser view error and compile error
type: bug
state: validation
status: idle
position: 2
created: 2026-08-26T07:02:41Z
updated: 2026-08-26T08:04:02Z
chat: d1f61d84-14d9-48ba-a839-37dbe796a315
copilot_session_id: d1f61d84-14d9-48ba-a839-37dbe796a315
scope_hash: 0dbefbb
chat_reset_required: false
---

## Request
```
{"error":"boardPanel_1.BoardPanel.attach is not a function"}
```

compile errors
```
./src/board/mermaidWebview.ts 7.02 KiB [built] [code generated]

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
235:20-28
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(235,21)
      TS2339: Property 'revision' does not exist on type 'BoardTaskSetHost'.

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
235:66-74
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(235,67)
      TS2339: Property 'revision' does not exist on type 'BoardTaskSetHost'.

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
235:83-91
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(235,84)
      TS2339: Property 'revision' does not exist on type 'BoardTaskSetHost'.

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
298:39-76
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(298,40)
      TS2345: Argument of type '(change: any) => void' is not assignable to parameter of type '() => void'.
  Target signature provides too few arguments. Expected 1 or more, but got 0.

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
298:40-46
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(298,41)
      TS7006: Parameter 'change' implicitly has an 'any' type.

ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts
338:27-33
[tsl] ERROR in C:\Repositories\kanban-pilot\src\http\realtimeBoardServer.ts(338,28)
      TS2339: Property 'attach' does not exist on type 'typeof BoardPanel'.

6 errors have detailed information that is not shown.
Use 'stats.errorDetails: true' resp. '--stats-error-details' to show it.
```

## Refined

### Problem statement
The realtime browser-board server was written against a newer board-host and presentation-surface contract than `BoardPanel` currently exposes. `realtimeBoardServer.ts` expects the shared host to provide a numeric revision and typed change payloads, and expects `BoardPanel` to attach to a `BrowserBoardSurface`; the current `BoardTaskSetHost` type omits those members and `BoardPanel` remains coupled directly to `vscode.WebviewPanel`. This contract drift prevents TypeScript compilation and, when stale or partially compiled output is run, causes `GET /` for the browser board to return `{"error":"boardPanel_1.BoardPanel.attach is not a function"}` instead of the board document.

Align the shared board contracts and complete the existing surface abstraction so the same `BoardPanel` implementation can render through both a VS Code webview panel and an isolated browser surface, without weakening revision/change propagation or regressing the editor board.

### Acceptance criteria
- `npm run compile` completes with no TypeScript errors, including no missing `BoardTaskSetHost.revision`, incompatible `onDidChange` callback, or missing `BoardPanel.attach` diagnostics.
- An authenticated browser request to the realtime board root returns the rendered Kanban Pilot board HTML with a successful response; it does not return the `BoardPanel.attach is not a function` JSON error.
- `BoardPanel.show(...)` continues to create/reveal the singleton VS Code board with its icon, resource access, messages, visibility refresh, disposal, and editor-only actions intact.
- `BoardPanel.attach(...)` creates an independently disposable panel bound to the supplied browser surface without replacing or revealing the VS Code singleton.
- Host revision and typed change metadata remain available to the realtime server, and host changes continue to publish updated board projections to connected browser clients.
- Targeted board-panel, browser-surface, and realtime-server tests cover both attachment paths and pass alongside the existing test suite.

## Scope

- Update `src/board/boardPanel.ts` to make `BoardTaskSetHost` accurately describe the revision and change-event contract implemented by `WorkspaceTaskSetContext`, using a shared/exported change shape where appropriate rather than `any`.
- Complete the `BoardSurface` integration in `src/board/boardPanel.ts`: route HTML, resource URI/CSP setup, local roots, messaging, visibility, reveal, and disposal through the surface contract; retain `BoardPanel.show(...)` for the editor-backed singleton and add the browser-facing `BoardPanel.attach(...)` factory expected by the realtime server.
- Use `WebviewPanelSurface` from `src/board/boardSurface.ts` for the existing VS Code panel path, adjusting the surface contract only if a capability required by the shared board implementation is missing; preserve browser/editor capability boundaries such as editor-only actions.
- Update `src/http/realtimeBoardServer.ts` to consume the aligned host change type and panel attachment API without unsafe casts or implicit `any`, while preserving monotonic projection revisions, per-browser sessions, SSE publication, and session disposal.
- Update `src/extension.ts` only as needed to share the host change contract cleanly and keep `WorkspaceTaskSetContext` structurally compatible with both board clients; do not duplicate board state or rendering logic.
- Extend `src/test/boardPanel.test.ts` to verify editor singleton behavior and generic/browser attachment lifecycle through the surface seam.
- Extend `src/test/realtimeBoardServer.test.ts` and/or `src/test/realtimeBoardServer.integration.test.ts` to reproduce the root-page failure, assert real board HTML is served, and verify typed host changes/revisions reach browser clients.
- Run `npm run compile`, the targeted board/realtime tests, and the full test suite; confirm no regression in the VS Code board or authenticated browser-board load.

## Log
- audit:state-change at:2026-08-26T07:02:47Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T07:06:56Z task:TASK-008 from:idle to:running action:refine run:rwz910x note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T07:06:56Z task:TASK-008 stage:refine action:refine run:rwz910x note:"Started refine activity."
- progress run:rwz910x task:TASK-008 at:2026-08-26T07:07:41Z note:"Mapped the browser server expectations to the current board host and surface contracts."
- run:rwz910x task:TASK-008 stage:refine result:ok note:"2026-08-26T07:07:41Z — defined the shared surface, host-event, browser-load, and regression-test scope"
- audit:status-change at:2026-08-26T07:08:16Z task:TASK-008 from:running to:idle action:receipt run:rwz910x outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T07:08:16Z task:TASK-008 stage:refine action:receipt run:rwz910x outcome:ok note:"2026-08-26T07:07:41Z — defined the shared surface, host-event, browser-load, and regression-test scope"
- audit:state-change at:2026-08-26T07:10:12Z task:TASK-008 from:refine to:scoped action:apply-pending run:rwz910x outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T07:10:14Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T07:10:15Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T07:10:15Z task:TASK-008 from:idle to:running action:develop run:r1fuikp note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T07:10:15Z task:TASK-008 stage:develop action:develop run:r1fuikp note:"Started develop activity."
- progress run:r1fuikp task:TASK-008 at:2026-08-26T07:19:36Z note:"Implemented shared board surfaces and passed compilation plus 22 targeted browser and board tests."
- run:r1fuikp task:TASK-008 stage:develop result:blocked note:"2026-08-26T07:19:36Z — implementation is complete, but full validation is blocked by an out-of-scope manifest default mismatch in the outbound-preamble test"
- audit:status-change at:2026-08-26T07:19:54Z task:TASK-008 from:running to:blocked action:receipt run:r1fuikp outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-08-26T07:19:54Z task:TASK-008 stage:develop action:receipt run:r1fuikp outcome:blocked note:"2026-08-26T07:19:36Z — implementation is complete, but full validation is blocked by an out-of-scope manifest default mismatch in the outbound-preamble test"
- audit:state-change at:2026-08-26T08:04:02Z task:TASK-008 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-08-26T08:04:02Z task:TASK-008 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
