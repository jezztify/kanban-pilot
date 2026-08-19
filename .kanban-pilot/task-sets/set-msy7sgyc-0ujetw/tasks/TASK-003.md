---
id: TASK-003
title: All settings must be accessible via the Settings UI
type: feature
state: validation
status: idle
position: 1
created: 2026-08-18T05:25:27Z
updated: 2026-08-18T06:13:18Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-003
copilot_session_id: 15e2f07b-e46c-4c46-b2f0-4b9bc684ab8c
scope_hash: 2029a8a
chat_reset_required: false
---

## Request
Currently, there are settings that can only be manipulated through VSCode's settings. I want every setting for Kanban Pilot to be available in Kanban Pilot's settings menu

## Refined

### Problem statement

The extension currently contributes 19 `kanbanPilot.*` configuration properties in `package.json`, but the board's Settings modal exposes only the four automation gates and the per-column `chat.agentNames` assignments. Users must leave the Kanban Pilot board and know the VS Code Settings UI to change task storage, chat injection, tool/model selection, run limits, startup, layout, and task-proposal behavior. The board Settings surface should provide one complete, typed editor for the contributed settings, using VS Code configuration as the source of truth and preserving the existing setting keys, defaults, validation, precedence, and runtime behavior.

### Acceptance criteria

- The Kanban Pilot Settings modal exposes every currently contributed property: `tasksDir`; all four `gates.*` properties; `chat.mode`, `chat.sessionPrefix`, `chat.closeTabOnDone`, `chat.resetOnApprove`, `chat.toolsExclude`, `chat.modelSelector`, `chat.agentNames`, and `chat.allowTaskProposals`; `refine.toolsInclude`; `run.timeoutMinutes` and `run.maxParallelTasks`; `board.openOnStartup`; and both `layout.*` properties. `chat.agentNames` remains represented by the seven workflow-column assignments, not by an uneditable raw object alone.
- Each control matches the contribution schema: enum controls retain the existing `agent`/`ask` and `manual`/`auto` choices, booleans are accessible toggles, numeric values enforce the existing constraints, `tasksDir` and `sessionPrefix` are validated text values, tool settings support editing string arrays, and `modelSelector` supports its optional `id`/`vendor` object shape. Labels and descriptions explain defaults and any next-run or reload requirement.
- Saving a value writes the exact `kanbanPilot.<key>` at workspace scope, and resetting a value removes the workspace override so the effective global/default value is restored. Values round-trip when the Settings modal is reopened; invalid or malformed webview payloads do not write configuration.
- Effective values from workspace settings, global settings, defaults, or a direct `settings.json` edit are reflected in the board and Settings modal without requiring the webview to be recreated. Existing gate policy application, agent-name resolution, chat options, run capacity/timeout behavior, and layout behavior continue to use the same configuration values.
- Activation-time values such as `tasksDir` and `board.openOnStartup` have an explicit, safe lifecycle: they either apply through a guarded context refresh or tell the user that a reload is required. The UI does not imply that a saved value has taken effect before the required lifecycle boundary. The contributed `chat.closeTabOnDone` setting is not left as an inert toggle; its documented behavior is wired or the stale contribution is resolved as part of implementation.
- The expanded surface remains keyboard-operable, responsive, theme-compatible, and mutually exclusive with the other board modals. Automated tests cover the complete settings inventory, rendering, validation, workspace persistence/reset, external configuration refresh, and the runtime effects or lifecycle notices for settings that need them.

## Scope
- [ ] Treat `package.json`'s `contributes.configuration.properties` as the authoritative inventory, keep the 19 current keys and their defaults/types/descriptions aligned with the in-board catalog, and explicitly exclude obsolete settings that are only present in stale documentation unless they are reintroduced deliberately.
- [ ] Extend `src/board/boardPanel.ts`'s settings state, configuration read/write helpers, webview message protocol, and Settings modal beyond gates and agent assignments. Add grouped controls for task storage, automation, chat, tools/model, run behavior, board/layout, and task proposals; preserve the existing seven-column assignment editor, legacy agent-key compatibility, workspace-scope writes, reset behavior, accessibility, and responsive layout.
- [ ] Add typed validation and serialization for every non-scalar setting in `src/board/boardPanel.ts` (newline/list editing for `refine.toolsInclude` and `chat.toolsExclude`, optional `id`/`vendor` fields for `chat.modelSelector`, and numeric bounds/normalization for run settings), with clear inline errors and no partial writes.
- [ ] Update the board's `onDidChangeConfiguration` handling in `src/board/boardPanel.ts` so changes to any `kanbanPilot.*` group refresh the settings and any affected board state, while preserving the immediate `applyGatePolicies()` behavior for gate changes.
- [ ] Update `src/extension.ts` for settings whose behavior is owned at activation/context level: define the guarded response to `tasksDir` changes, keep task-set/run-manager context consistent, and surface the reload requirement for `board.openOnStartup` if it cannot be applied live. Keep the existing `maxParallelTasks` reconciliation behavior intact.
- [ ] Audit `src/chat/runManager.ts` and `src/chat/executor.ts` against the expanded catalog so every exposed value reaches the existing run/chat path with its current semantics; in particular, resolve the currently contributed but unread `chat.closeTabOnDone` behavior rather than exposing a misleading control.
- [ ] Extend `src/test/boardPanel.test.ts` with the full key inventory, control/schema checks, valid and invalid payload coverage, workspace persistence/reset assertions, effective-value refresh, and keyboard/accessibility checks. Add or extend `src/test/extension.test.ts`, `src/test/runManager.test.ts`, and `src/test/executor.test.ts` for activation-boundary handling and the affected runtime settings, including close-on-done.
- [ ] Update `README.md` and the relevant Settings/configuration sections of `docs/PRD.md` to describe the complete in-board Settings surface, persistence scope, reset semantics, and reload/next-run behavior; keep the documentation, contribution manifest, and UI inventory consistent.
- [ ] Verify with the repository's compile, lint, and test commands, including a focused settings test pass and a manual board smoke check for editing, resetting, reopening, external configuration changes, and narrow-width/keyboard operation.

## Log
- audit:state-change at:2026-08-18T05:25:29Z task:TASK-003 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T05:26:45Z task:TASK-003 from:idle to:running action:refine run:ru6cnbc note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T05:26:45Z task:TASK-003 stage:refine action:refine run:ru6cnbc note:"Started refine activity."
- run:ru6cnbc task:TASK-003 stage:refine result:ok note:"2026-08-18T05:28:04Z — documented the complete 19-setting inventory, typed UI scope, lifecycle behavior, and verification plan"
- audit:state-change at:2026-08-18T05:29:12Z task:TASK-003 from:refine to:scoped action:receipt run:ru6cnbc outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T05:29:12Z task:TASK-003 from:running to:idle action:receipt run:ru6cnbc outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T05:29:12Z task:TASK-003 stage:refine action:receipt run:ru6cnbc outcome:ok note:"2026-08-18T05:28:04Z — documented the complete 19-setting inventory, typed UI scope, lifecycle behavior, and verification plan"
- audit:state-change at:2026-08-18T05:55:32Z task:TASK-003 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T05:55:34Z task:TASK-003 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T05:55:34Z task:TASK-003 from:idle to:running action:develop run:rhl5sjn note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T05:55:34Z task:TASK-003 stage:develop action:develop run:rhl5sjn note:"Started develop activity."
- run:rhl5sjn task:TASK-003 stage:develop result:ok note:"2026-08-18T06:12:40Z — implemented the complete 19-setting Settings surface, lifecycle notices, close-on-Done behavior, documentation, and verification coverage"
- audit:state-change at:2026-08-18T06:13:18Z task:TASK-003 from:in-progress to:validation action:receipt run:rhl5sjn outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T06:13:18Z task:TASK-003 from:running to:idle action:receipt run:rhl5sjn outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T06:13:18Z task:TASK-003 stage:develop action:receipt run:rhl5sjn outcome:ok note:"2026-08-18T06:12:40Z — implemented the complete 19-setting Settings surface, lifecycle notices, close-on-Done behavior, documentation, and verification coverage"
