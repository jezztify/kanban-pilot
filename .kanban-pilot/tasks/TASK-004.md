---
id: TASK-004
title: Add icon for Kanban Pilot window
type: feature
state: done
status: idle
created: 2026-08-15T07:42:39Z
updated: 2026-08-15T08:22:38Z
chat: kanban-pilot-TASK-004
copilot_session_id: f493782a-14d4-4320-915d-71ef489f0589
scope_hash: ef4b713
chat_reset_required: false
---

## Request
I want to add the same icon from activity-icon.svg as editor window icon for this extension

## Refined

### Problem statement
The Kanban Pilot board is opened as a `vscode.WebviewPanel` in the editor area, but its editor tab/title does not currently identify it with an icon. Reuse the existing `media/activity-icon.svg` for that webview editor panel so the board has the same Kanban Pilot identity as its activity-bar container and view. This ticket interprets “editor window icon” as the icon on the Kanban Pilot board’s editor tab/title, not the host VS Code application window.

### Acceptance criteria
- Opening or revealing the Kanban Pilot board in the editor area displays the artwork from `media/activity-icon.svg` as the webview editor panel’s icon.
- The icon is resolved from the installed extension’s URI, so it works in both the Extension Development Host and a packaged/installed extension; no workspace-relative path is used.
- The activity-bar container and contributed board view continue to use the same existing SVG without visual or behavioral regression.
- The board’s existing singleton, reveal, lifecycle, and webview behavior is unchanged apart from the added editor-panel icon.
- The extension builds and the existing automated tests remain passing.

## Scope
- Update `src/board/boardPanel.ts` to accept the extension resource URI when creating the board panel and assign the existing `media/activity-icon.svg` URI to the `WebviewPanel.iconPath`.
- Update `src/extension.ts` to pass `ExtensionContext.extensionUri` through the board-opening paths, including the hidden activity-bar view provider, the `openBoard` command, sample-task seeding, and startup auto-open.
- Keep `media/activity-icon.svg` as the single source asset; do not create or modify another icon and do not change the existing `package.json` activity-bar/view icon contributions unless implementation validation shows they are required.
- Add or adjust focused test coverage only if the current VS Code test harness can inspect the created panel’s `iconPath`; otherwise validate the URI wiring with the extension build and an Extension Development Host smoke check, and run the existing test suite.

## Log
- run:r6bmee9 task:TASK-004 stage:refine result:ok note:"Defined the editor-tab icon behavior, URI wiring, affected files, and validation scope while reusing the existing SVG."
- run:rzidw5p task:TASK-004 stage:develop result:ok note:"Implemented extension URI wiring for the board editor tab icon and verified build, lint, and tests."
