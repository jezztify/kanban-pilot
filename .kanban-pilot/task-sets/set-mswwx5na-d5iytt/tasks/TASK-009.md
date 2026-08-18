---
id: TASK-009
title: Improve Settings Menu
type: feature
state: done
status: idle
created: 2026-08-17T09:53:24Z
updated: 2026-08-18T00:13:12Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-009
copilot_session_id: 38f87424-18f8-4141-95bd-7e8dd1d3ec64
scope_hash: 877311e
chat_reset_required: true
---

## Request
Divide the modal into:
1. A sidebar that contains the Category of the settings
2. A main space where all the settings can be manipulated for the Category

## Refined

### Problem statement

The current Settings dialog presents Automation gates and Agent assignments as one long,
vertically stacked form. Users have to scan past unrelated controls to find the setting they
want, and the layout will become harder to navigate as more categories are added. Rework the
dialog's presentation into a two-pane settings workspace: a sidebar lists the available
categories and a main pane shows the controls for the selected category. The existing two
categories — Automation gates and Agent assignments — remain the complete scope for this
ticket; their values, persistence, and runtime behavior must not change.

### Acceptance criteria

- Opening Settings shows an accessible modal with a distinct category sidebar and a main
	settings pane containing the current categories **Automation gates** and **Agent assignments**.
- Exactly one category is visibly active at a time. Selecting a category updates the main pane
	without closing the modal and does not write a setting merely because navigation changed.
- The Automation gates category still exposes all four gate switches with their current values,
	descriptions, and existing immediate `gates/set` behavior.
- The Agent assignments category still exposes all seven column assignments with their current
	effective values and working Save, Reset, and Enter-to-save behavior.
- Opening Settings from the header selects a predictable default category. Opening it from a
	column's agent pencil selects Agent assignments and focuses/selects that column's input as it
	does today.
- Sidebar navigation is keyboard-operable and has visible focus and active-state semantics;
	inactive category controls are not included in the modal's contained Tab sequence. Existing
	close-button, backdrop-click, Escape, and mutually-exclusive modal behavior remains intact.
- The two-pane layout remains usable at narrow webview widths by adapting the sidebar/main
	arrangement without clipping category labels or settings controls.
- Existing settings protocol, workspace persistence, board badges, and agent prompt resolution
	continue to behave unchanged, and automated tests cover the new structure and preserved
	interactions.

## Scope
- [ ] `src/board/boardPanel.ts` — restructure the Settings modal markup into a category
	navigation sidebar and a main content region, with accessible labels/relationships and
	separate panels for Automation gates and Agent assignments.
- [ ] `src/board/boardPanel.ts` — add the desktop two-pane styling, active/hover/focus states,
	hidden inactive-panel behavior, and a narrow-webview responsive layout that keeps both
	navigation and controls usable.
- [ ] `src/board/boardPanel.ts` — update the webview settings renderer and modal lifecycle to
	track the selected category, render only its controls, switch categories without posting
	settings changes, use a documented default category, and route `openSettingsModal(focusColumn)`
	to Agent assignments while preserving the requested input focus/selection.
- [ ] `src/board/boardPanel.ts` — update the modal focus-trap/query logic so sidebar buttons and
	only the active panel's controls participate in keyboard navigation; preserve close,
	backdrop, Escape, and modal-exclusion behavior.
- [ ] `src/test/boardPanel.test.ts` — extend generated-webview assertions and script checks for
	the category sidebar, active-panel structure, default/focused-column behavior, valid keyboard
	navigation, and preservation of the existing gate/agent message contracts.
- [ ] `docs/PRD.md` — update §6.17's Settings-surface description to document the category
	sidebar, selected main pane, default/focused-category behavior, and responsive/accessibility
	expectations.

## Log
- run:rf9uknf task:TASK-009 stage:refine result:ok note:"2026-08-17T10:11:07Z — refined the Settings modal into a two-category sidebar and main-pane implementation scope"
- run:rjgvmz4 task:TASK-009 stage:develop result:ok note:"2026-08-17T21:47:31Z — implemented the accessible responsive Settings category workspace with preserved gate and agent assignment interactions"
- run:rbsfdkm task:TASK-009 stage:validate result:ok note:"2026-08-18T00:12:34Z — validated the settings workspace structure, preserved gate and agent assignment behavior, modal keyboard and responsive behavior, PRD coverage, and 195 passing automated tests"
