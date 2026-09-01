---
id: TASK-008
title: Add ability to specify agent directories to use for kanban-pilot
type: feature
state: done
status: idle
position: 4
created: 2026-08-26T20:39:44Z
updated: 2026-08-27T21:07:19Z
chat: 7ab7af08-805e-483f-99c2-f92aac5f6070
copilot_session_id: 7ab7af08-805e-483f-99c2-f92aac5f6070
scope_hash: 8f928f5
chat_reset_required: false
---

## Request
it should be a list of directories, not a single one.

## Refined

### Problem statement

Kanban Pilot needs its own workspace-scoped configuration for additional custom-agent search
locations. The value must be an ordered list of directory paths rather than a single directory so a
workspace can expose agents maintained in several locations without replacing the built-in
workspace, VS Code-configured, or user-level sources. Discovery must tolerate an individual
invalid, missing, unreadable, duplicate, or empty entry and must retain the current deterministic
de-duplication and source-precedence behavior.

### Acceptance criteria

- `kanbanPilot.chat.agentDirectories` is contributed as an array-of-strings setting with an empty
	default and is editable/resettable from the existing Settings surface at workspace scope; it does
	not replace or mutate VS Code's `chat.agentFilesLocations` setting.
- Each non-empty configured directory is resolved using the same absolute, home-relative, and
	workspace-relative path rules already used for additional agent locations. All valid entries are
	scanned; a missing, unreadable, malformed, or duplicate entry contributes no agents and does not
	prevent other configured directories or Settings from loading.
- Agent profiles discovered from the configured directory list participate in the existing parsing,
	visibility filtering, deterministic ordering, and case-insensitive name de-duplication rules.
	Existing workspace, VS Code-configured, and user-level source precedence remains intact, with
	duplicate directory URIs scanned only once.
- Changing `kanbanPilot.chat.agentDirectories` refreshes the available-agent dropdown without an
	extension reload. Existing saved agent-name assignments remain selectable when their profiles are
	no longer discoverable.
- Focused automated coverage proves multiple configured directories, mixed path forms, per-entry
	failures, duplicate locations/profiles, precedence, and the Settings refresh path. Documentation
	explains that the setting is an ordered list and how its entries are resolved.

## Scope

- [ ] `package.json` — add the workspace-scoped `kanbanPilot.chat.agentDirectories` configuration
	contribution as an empty string-array, with a description that states it accepts multiple
	additional agent directories and complements `chat.agentFilesLocations`.
- [ ] `src/chat/copilotAgents.ts` — extend discovery options and location resolution to accept the
	Kanban Pilot directory array, normalize each entry with the established path-expansion rules,
	merge it into the existing scan order without duplicate URI reads, and preserve parser,
	filtering, precedence, and stable-name de-duplication behavior.
- [ ] `src/board/boardPanel.ts` — read the new setting when building Settings state, pass it to
	agent discovery, include it in the typed Settings catalog/control validation and persistence, and
	rescan/push Settings when the array changes while retaining the existing
	`chat.agentFilesLocations` refresh behavior.
- [ ] `src/extension.ts` — ensure workspace configuration changes to the new setting notify active
	board contexts in the same way as existing Kanban Pilot configuration changes; avoid changing
	task/run or prompt-resolution behavior.
- [ ] `src/test/copilotAgents.test.ts` — add fixtures for several configured directories and cover
	their ordering, relative/home/absolute resolution, unreadable or missing entries, repeated URIs,
	and duplicate agent names alongside current workspace, VS Code-configured, and user sources.
- [ ] `src/test/boardPanel.test.ts` and any directly affected extension-context tests — verify the
	array setting's Settings payload, workspace save/reset validation, and live dropdown refresh,
	including compatibility with an assignment no longer found by discovery.
- [ ] `README.md` and `docs/PRD.md` — document `kanbanPilot.chat.agentDirectories`, its list
	syntax, resolution/order and failure tolerance, coexistence with VS Code's agent-location
	setting, and the refresh behavior.
- [ ] Verification — run the focused custom-agent and board Settings tests, then compile, lint, and
	the relevant full test suite; confirm only declared directories are read and no agent files are
	modified.

## Log
- audit:state-change at:2026-08-26T20:39:46Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T20:39:48Z task:TASK-008 from:idle to:running action:refine run:r72tg79 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T20:39:48Z task:TASK-008 stage:refine action:refine run:r72tg79 note:"Started refine activity."
- run:r72tg79 task:TASK-008 stage:refine result:ok note:"2026-08-26T20:40:41Z — refined the multi-directory agent discovery setting, behavior, tests, and documentation scope"
- audit:status-change at:2026-08-26T20:40:56Z task:TASK-008 from:running to:idle action:receipt run:r72tg79 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T20:40:56Z task:TASK-008 stage:refine action:receipt run:r72tg79 outcome:ok note:"2026-08-26T20:40:41Z — refined the multi-directory agent discovery setting, behavior, tests, and documentation scope"
- audit:state-change at:2026-08-26T20:46:49Z task:TASK-008 from:refine to:scoped action:apply-pending run:r72tg79 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T20:46:50Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T20:46:52Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T20:46:52Z task:TASK-008 from:idle to:running action:develop run:r4zn627 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T20:46:52Z task:TASK-008 stage:develop action:develop run:r4zn627 note:"Started develop activity."
- run:r4zn627 task:TASK-008 stage:develop result:ok note:"2026-08-26T20:52:06Z — added the multi-directory agent setting, discovery integration, Settings controls, tests, and documentation"
- audit:status-change at:2026-08-26T20:52:14Z task:TASK-008 from:running to:idle action:receipt run:r4zn627 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T20:52:14Z task:TASK-008 stage:develop action:receipt run:r4zn627 outcome:ok note:"2026-08-26T20:52:06Z — added the multi-directory agent setting, discovery integration, Settings controls, tests, and documentation"
- audit:state-change at:2026-08-27T21:07:19Z task:TASK-008 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
