---
id: TASK-002
title: Editing an agent should show copilot agents as a dropdown
type: feature
state: validation
status: idle
position: 0
created: 2026-08-18T05:23:03Z
updated: 2026-08-18T05:52:36Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-002
copilot_session_id: c93d1da2-fb87-4f44-b976-6e4bd81d9c33
scope_hash: fe1801d
chat_reset_required: false
---

## Request
Currently, we are typing in the Agent's name when editing the assigned agent for a column. This is prone to error, I want to improve it by scanning the global and local agents for github copilot and showing them as a dropdown menu when editing it.

## Refined

### Problem statement

The Settings → Agent assignments editor currently uses a free-form text input for every workflow column. A user must know and type the exact agent label, so a typo or an outdated name can silently change the `@agentName` prompt prefix and the board badge. Replace that error-prone entry path with a selectable list of GitHub Copilot custom agents discovered from the active workspace and the user-global Copilot agent location. The stored assignment must remain compatible with the existing `kanbanPilot.chat.agentNames` string values, including legacy values and the built-in `Bro Refiner` / `Bro Coder` / `Bro QA` defaults.

### Acceptance criteria

- The Settings → Agent assignments panel renders a native, keyboard-accessible dropdown for each of the seven columns; choosing an agent no longer requires free-form typing. The existing Save and Reset actions remain available.
- Opening or refreshing Settings scans the Copilot custom-agent locations supported by VS Code: workspace `.github/agents` directories, the user-level `~/.copilot/agents` directory (`%USERPROFILE%\\.copilot\\agents` on Windows), and any configured `chat.agentFilesLocations` locations when present. The scan does not modify agent files.
- Valid agent profiles are represented by their frontmatter `name`, falling back to the profile filename when `name` is absent. Malformed, unreadable, non-agent, or Copilot-hidden/subagent-only profiles are skipped without preventing the Settings panel from loading. Choices are deterministic, duplicate names are not repeated, and workspace-local choices take precedence over a same-named global choice.
- The dropdown includes a reset/default choice (`None` where the column has no default) and keeps the currently effective configured value selectable even when that value is a legacy, built-in, or currently undiscovered label. An existing assignment is never silently changed just because its profile is missing.
- Saving a selected option continues to use the existing `agentName/set` message and workspace-scoped `kanbanPilot.chat.agentNames` persistence. Reset removes the override, preserves legacy `refine`/`develop`/`validate` fallback behavior, and restores the documented column default. The board badge and injected prompt prefix reflect the saved value, and `split` continues to use the Refine assignment.
- The available-agent list is refreshed when Settings is opened/refreshed, including the empty-directory/no-workspace case, and newly added or removed profiles are reflected on the next refresh without an extension reload.
- Automated coverage verifies profile discovery/parsing, source merging/deduplication and failure handling, Settings-state serialization, dropdown rendering/selection, the unchanged save/reset protocol, and preservation of existing assignments and defaults.

## Scope
- Add `src/chat/copilotAgents.ts` to own Copilot custom-agent discovery: resolve workspace, user-global, and configured additional locations; enumerate the supported Markdown profile files; parse only the frontmatter needed for the picker (`name`, `description`, visibility/target metadata); normalize filename fallbacks; merge and sort results with deterministic local-over-global duplicate handling; and expose dependency-injectable filesystem inputs for unit tests.
- Update `src/board/boardPanel.ts` so `SettingsState` carries the discovered agent options, the extension-side Settings refresh path obtains a fresh list, and the webview renders each assignment as a native `<select>` with accessible labels, reset/default handling, and a compatibility option for an effective value that is not in discovery results. Keep `agentName/set`, `persistAgentNameOverride`, validation, and existing configuration-change refresh behavior compatible; add only the webview message/refresh plumbing needed to rescan on Settings open.
- Extend `src/test/copilotAgents.test.ts` with temporary local/global/configured-location fixtures covering frontmatter names, filename fallback, hidden or malformed profiles, unreadable/missing directories, duplicate precedence, stable ordering, and no discovered agents.
- Extend `src/test/boardPanel.test.ts` to assert the expanded Settings payload and webview script, exercise the dropdown/reset message behavior, and confirm legacy assignments, built-in defaults, and the existing workspace persistence protocol remain intact.
- Update the Settings and agent-assignment portions of `docs/PRD.md` (§6.17 and the related protocol/configuration text) to document the Copilot profile sources, dropdown semantics, refresh behavior, and compatibility fallback; do not introduce a second persisted setting or change prompt resolution.

## Log
- audit:state-change at:2026-08-18T05:23:05Z task:TASK-002 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T05:23:09Z task:TASK-002 from:idle to:running action:refine run:rxas800 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T05:23:09Z task:TASK-002 stage:refine action:refine run:rxas800 note:"Started refine activity."
- run:rxas800 task:TASK-002 stage:refine result:ok note:"2026-08-18T05:25:01Z — refined Copilot agent discovery, dropdown behavior, persistence compatibility, and test scope"
- audit:state-change at:2026-08-18T05:26:17Z task:TASK-002 from:refine to:scoped action:receipt run:rxas800 outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T05:26:17Z task:TASK-002 from:running to:idle action:receipt run:rxas800 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T05:26:17Z task:TASK-002 stage:refine action:receipt run:rxas800 outcome:ok note:"2026-08-18T05:25:01Z — refined Copilot agent discovery, dropdown behavior, persistence compatibility, and test scope"
- audit:state-change at:2026-08-18T05:27:25Z task:TASK-002 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T05:40:27Z task:TASK-002 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T05:40:27Z task:TASK-002 from:idle to:running action:develop run:rvultlb note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T05:40:27Z task:TASK-002 stage:develop action:develop run:rvultlb note:"Started develop activity."
- run:rvultlb task:TASK-002 stage:develop result:ok note:"2026-08-18T05:51:49Z — implemented Copilot agent discovery and Settings dropdown assignment flow"
- audit:state-change at:2026-08-18T05:52:36Z task:TASK-002 from:in-progress to:validation action:receipt run:rvultlb outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T05:52:36Z task:TASK-002 from:running to:idle action:receipt run:rvultlb outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T05:52:36Z task:TASK-002 stage:develop action:receipt run:rvultlb outcome:ok note:"2026-08-18T05:51:49Z — implemented Copilot agent discovery and Settings dropdown assignment flow"
