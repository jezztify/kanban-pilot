---
id: TASK-007
title: Settings Menu - Agent assignments - the dropdowns do not scan the agent folders for copilot
type: bug
state: validation
status: idle
position: 4
created: 2026-08-20T10:43:28Z
updated: 2026-08-20T11:06:10Z
chat: d5599d94-2eba-4f09-8e0d-5f571b10a178
copilot_session_id: d5599d94-2eba-4f09-8e0d-5f571b10a178
scope_hash: 7aa9898
chat_reset_required: false
---

## Request
Settings Menu - Agent assignments - the dropdowns do not scan the agent folders for copilot

## Refined

### Problem statement

The Settings **Agent assignments** dropdowns are not reliably populated from the custom-agent folders that GitHub Copilot uses. As a result, agents that are available to Copilot are absent from the picker and users must retain or enter assignment labels manually. The picker must discover eligible Copilot custom-agent profiles from the active workspace and configured/user agent locations, then expose those discovered names consistently in every column assignment dropdown.

### Acceptance criteria

- Opening or refreshing Settings scans every supported Copilot custom-agent location for the active workspace, configured `chat.agentFilesLocations`, and the user-level agent directory; missing or unreadable locations do not prevent the picker from rendering.
- Each dropdown lists all discoverable, user-invocable Copilot agent Markdown profiles from those locations, including valid filename fallbacks, with deterministic ordering and documented precedence when names collide.
- Profiles that are malformed, unreadable, hidden, or targeted at a non-Copilot environment remain excluded; existing saved assignments remain available as the current-value compatibility option when their profile is not discovered.
- The available choices refresh when Settings is reopened and after the relevant Copilot agent-location configuration changes, without requiring an extension reload.
- Automated tests cover the affected folder-location resolution and discovery behavior, including multi-root/configured/user sources and failure-tolerant scanning.

## Scope

- Inspect and correct custom-agent location resolution and directory traversal in `src/chat/copilotAgents.ts` so discovery matches the Copilot-supported agent folders rather than relying on an incomplete hard-coded set.
- Preserve the existing profile parsing, visibility/target filtering, name de-duplication, source-priority, and stable-sort rules while extending the folders scanned.
- Update `src/board/boardPanel.ts` only as needed to pass the active workspace and Copilot configuration into the corrected discovery path and to refresh the Settings state after relevant configuration changes.
- Extend `src/test/copilotAgents.test.ts` with coverage for every supported workspace, configured, and user agent-folder source; include absent/unreadable directories, duplicate names, and eligible versus excluded profiles.
- Extend `src/test/boardPanel.test.ts` if required to verify that Settings receives and refreshes the discovered agent choices.
- Align the Agent assignments discovery documentation in `README.md` and `docs/PRD.md` with the implemented supported locations and refresh behavior.

## Log
- audit:state-change at:2026-08-20T10:43:32Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T10:43:34Z task:TASK-007 from:idle to:running action:refine run:r26gh4r note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T10:43:34Z task:TASK-007 stage:refine action:refine run:r26gh4r note:"Started refine activity."
- run:r26gh4r task:TASK-007 stage:refine result:ok note:"Scoped Copilot agent-folder discovery and Settings dropdown refresh behavior."
- audit:status-change at:2026-08-20T10:44:18Z task:TASK-007 from:running to:idle action:receipt run:r26gh4r outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T10:44:18Z task:TASK-007 stage:refine action:receipt run:r26gh4r outcome:ok note:"Scoped Copilot agent-folder discovery and Settings dropdown refresh behavior."
- audit:state-change at:2026-08-20T10:49:10Z task:TASK-007 from:refine to:scoped action:apply-pending run:r26gh4r outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-20T10:49:13Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-20T10:49:14Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-20T10:49:14Z task:TASK-007 from:idle to:running action:develop run:rfykfj8 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-20T10:49:14Z task:TASK-007 stage:develop action:develop run:rfykfj8 note:"Started develop activity."
- run:rfykfj8 task:TASK-007 stage:develop result:ok note:"Added Claude-format workspace agent discovery to Settings dropdowns with coverage and documentation."
- audit:status-change at:2026-08-20T10:51:56Z task:TASK-007 from:running to:idle action:receipt run:rfykfj8 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T10:51:56Z task:TASK-007 stage:develop action:receipt run:rfykfj8 outcome:ok note:"Added Claude-format workspace agent discovery to Settings dropdowns with coverage and documentation."
- audit:state-change at:2026-08-20T11:06:10Z task:TASK-007 from:in-progress to:validation action:apply-pending run:rfykfj8 outcome:ok note:"State changed from in-progress to validation via apply-pending."
