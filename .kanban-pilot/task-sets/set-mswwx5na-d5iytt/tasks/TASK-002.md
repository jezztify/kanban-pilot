---
id: TASK-002
title: Convert Gates menu to Settings menu.
type: feature
state: done
status: idle
created: 2026-08-17T09:07:30Z
updated: 2026-08-17T10:07:01Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-002
copilot_session_id: acb25ace-422e-4470-848b-ceabeb92981e
scope_hash: 77069d1
chat_reset_required: true
---

## Request
I want to be able to configure Gates and the assigned Agent for each column.

## Refined

### Problem statement

The board currently exposes only the automation-gate switches from the header's `Gates` button. Agent persona overrides are edited through a separate column-header pencil and only the three stage-backed columns (`Refine`, `In Progress`, and `Validation`) are configurable; the other columns show a non-editable `None`. This leaves no single settings surface and does not meet the request to configure gates and the assigned agent for every column.

Replace the Gates-only entry point with a board `Settings` surface that centralizes the existing gate policies and a complete per-column agent-assignment editor. Workspace configuration remains authoritative and the existing workflow semantics remain intact: gate changes still control automatic transitions, stage-backed assignments still control the `@name` used in prompts, and `split` continues to use the Refine persona. Assignments on resting columns are configurable/displayed but must not cause a chat run because those columns have no runnable stage.

### Acceptance criteria

- The board header exposes `Settings`, not `Gates`, and opening it presents one accessible, keyboard-operable modal/menu containing both automation gates and agent assignments; the standalone Gates and agent-name modals are removed, while any retained column-header pencil opens/focuses this same Settings editor.
- The Settings surface lists the four existing gates (`Backlog → Refine`, `Scoped → Approved`, `Approved → In Progress`, and Validation auto-start), shows their current `manual`/`auto` values, persists changes to the existing workspace-scoped `kanbanPilot.gates.*` settings, and immediately reapplies gate policies when a gate is switched to `auto`.
- The Settings surface lists all seven workflow columns and their effective agent assignment. The defaults remain `Bro Refiner` for Refine, `Bro Coder` for In Progress, `Bro QA` for Validation, and `None` for resting columns; each value can be edited or reset, including the resting columns.
- A saved assignment is reflected in the column header without a reload. Assignments for Refine, In Progress, and Validation are also used by `RunManager` for the corresponding prompt `@name`; `split` inherits Refine's assignment. Editing a resting-column assignment only changes its stored/displayed label and never launches an agent by itself.
- Resetting an assignment removes the override and restores the documented default/`None`. Existing `kanbanPilot.chat.agentNames` overrides continue to resolve safely, including legacy stage-key values, and direct edits to the workspace settings are reflected in both the board and Settings surface.
- Existing task-set, task, drag/drop, gate-transition, and agent-prompt behavior is not regressed; automated coverage verifies the assignment resolution, legacy compatibility, prompt propagation, gate persistence/reapplication, and the Settings message/validation paths, and the user-facing README/PRD documentation describes the new surface and its resting-column semantics.

## Scope

- `src/chat/agentNames.ts`: extend the agent-assignment model from only stage keys to column-keyed overrides for all seven `Column` values while preserving backward compatibility with existing `refine`/`develop`/`validate` settings. Define the stage-to-column resolution (`refine` and `split` → `refine`, `develop` → `in-progress`, `validate` → `validation`), precedence, trimming/reset behavior, and defaults used by both board labels and prompt rendering.
- `src/board/boardPanel.ts`: replace the header Gates control and standalone gate modal with a Settings control/modal that renders the four gate rows and seven editable agent rows from shared column/gate metadata. Update the webview state and message protocol, payload validation, workspace configuration writes, immediate `applyGatePolicies()` behavior, configuration-change refreshes, and modal exclusivity/focus handling. Make every column's agent display and edit affordance use the centralized Settings state, while keeping non-stage assignments display-only at run time and routing any remaining pencil shortcut to the same editor.
- `package.json`: update the `kanbanPilot.chat.agentNames` contribution description to document column assignments, defaults, the `split`/Refine relationship, and compatibility with legacy stage-key overrides; keep the existing `kanbanPilot.gates.*` setting IDs and defaults unchanged.
- `src/test/agentNames.test.ts`: add coverage for each column's override, default/`None` labels, stage-to-column resolution, `split` inheritance, reset/whitespace handling, and legacy stage-key fallback.
- `src/test/runManager.test.ts`: extend the prompt-injection tests to prove a column assignment reaches the actual `@name` for Refine, Develop, and Validate (including `split`), and retain coverage that the existing gate policy settings still drive automatic transitions and capacity behavior.
- Add focused board/webview coverage in the existing VS Code test harness (or a new `src/test/boardPanel.test.ts` if no suitable fixture exists) for the Settings label/modal state, all-column agent rows, gate and agent message validation, workspace writes, and external configuration refreshes; include a manual smoke check for keyboard navigation, Escape/backdrop closing, and mutually exclusive modals.
- `docs/PRD.md`: revise the board protocol and the §6.17 settings-surface description from Gates-only/stage-only editing to the combined Settings surface, documenting all seven columns, persistence, compatibility, and the fact that resting-column labels do not dispatch runs.
- `README.md`: update the UI and extension-settings documentation so users can find Settings, understand the gate controls, and configure/reset per-column agent assignments without relying on direct `settings.json` edits.

## Log
- run:r7m8tee task:TASK-002 stage:refine result:ok note:"2026-08-17T09:08:53Z — refined the Settings-surface requirements and documented the files, compatibility, UI, and test scope"
- run:r0rjyhe task:TASK-002 stage:develop result:ok note:"2026-08-17T09:29:39Z — implemented the combined Settings surface with workspace-persisted gates, all-column assignments, legacy-compatible prompt resolution, tests, and documentation"
- run:rk8tsl7 task:TASK-002 stage:validate result:failed note:"2026-08-17T09:53:31Z — validation failed: npm test passed with 158 tests, but the Settings renderer reads state[gate.key] while the extension sends gates under state.gates, so current gate values are not displayed and Auto appears manual"
- run:raj1z7q task:TASK-002 stage:develop result:ok note:"2026-08-17T10:03:53Z — fixed Settings gate rendering to read the nested gates state and added a webview protocol regression assertion; npm test passed with 158 tests"
- run:rcou37l task:TASK-002 stage:validate result:ok note:"2026-08-17T10:06:24Z — reviewed the combined Settings implementation, gate-state fix, assignment resolution, persistence, modal behavior, documentation, and regression coverage; npm test passed with 158 tests"
