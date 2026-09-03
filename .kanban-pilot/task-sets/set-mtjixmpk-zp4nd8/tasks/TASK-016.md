---
id: TASK-016
title: each board should be able to use its own port for browserview
type: feature
state: done
status: idle
position: 13
created: 2026-09-04T12:11:19Z
updated: 2026-09-06T03:16:57Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-016
copilot_session_id: c484382b-848d-4e22-91ea-383e4245d571
chat_reset_required: false
---

## Request
each board should be able to use its own port for browserview

## Refined

### Problem statement

Replace the single workspace-wide browser-board HTTP endpoint with independently configured endpoints for task sets. Each task-set board must have its own TCP port and share URL, and a browser connected to that endpoint must stay bound to that task set instead of following a later active-set selection in VS Code.

### SPLIT RECOMMENDATION

NO SPLIT — 1 feature: per-task-set browser-board endpoint ports.

### Acceptance Criteria

- A task set can persist its own browser-board port, validated as an integer from 1 through 65535.
- When the HTTP endpoint is enabled, each configured task set starts and serves on its assigned port; its share URL/QR code uses that port.
- Loading a task set’s browser-board URL shows and mutates only that task set, including after another task set becomes active in VS Code.
- A duplicate, invalid, or unavailable port produces a clear error for the affected task set without stopping endpoints already serving other task sets.
- Existing workspaces with only `kanbanPilot.http.port` continue to work through a documented, deterministic fallback or migration for task sets without an explicit port.
- Automated tests cover port validation, isolated task-set binding, lifecycle/error behavior, and the established single-port fallback; user documentation describes configuration and sharing behavior.

## Scope

- Extend `src/model/taskSets.ts` and the persisted `.kanban-pilot/task-sets.json` schema to retain an optional HTTP port per task-set identity, including backward-compatible loading and validation.
- Update task-set create, rename, delete, and selection flows in `src/board/boardPanel.ts` and the extension’s configuration surface so users can view and change the active board’s port without changing unrelated task sets.
- Replace the single `endpointServer`/`sharedEndpointUrl` lifecycle in `src/extension.ts` with a per-task-set endpoint registry that starts, restarts, reports, and disposes each server independently when endpoint settings or task sets change.
- Refactor `src/http/realtimeBoardServer.ts` so a server receives a fixed task-set host/store projection rather than the mutable workspace active set; retain authentication, SSE, resource-root, and action behavior for that bound set.
- Update `src/http/endpointSharePanel.ts` and the endpoint connection command/status behavior to select and display the active task set’s share URL and clearly identify the board being shared.
- Add or update focused tests under `src/test/` for task-set registry persistence/migration, per-set server startup and cleanup, port conflicts, endpoint isolation across active-set changes, and share-link selection.
- Update `package.json`, `docs/configuration.md`, `docs/http-endpoint.md`, and relevant `docs/PRD.md` sections with the per-task-set port setting, fallback semantics, conflict behavior, and sharing guidance.

## Log
- audit:state-change at:2026-09-04T12:11:21Z task:TASK-016 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-04T12:11:23Z task:TASK-016 from:idle to:running action:refine run:rdst04j note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-04T12:11:23Z task:TASK-016 stage:refine action:refine run:rdst04j note:"Started refine activity."
- audit:status-change at:2026-09-04T12:11:29Z task:TASK-016 from:running to:idle action:stop run:rdst04j outcome:stopped note:"Status changed from running to idle via stop."
- audit:activity-finish at:2026-09-04T12:11:29Z task:TASK-016 stage:refine action:stop run:rdst04j outcome:stopped note:"Activity stopped by the user."
- run:rdst04j task:TASK-016 stage:refine result:ok note:"Scoped per-task-set browser-board ports with endpoint isolation, migration, tests, and documentation."
- audit:state-change at:2026-09-04T12:13:38Z task:TASK-016 from:refine to:scoped action:move note:"State changed from refine to scoped via move."
- audit:state-change at:2026-09-04T12:13:39Z task:TASK-016 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-04T12:13:41Z task:TASK-016 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T12:13:41Z task:TASK-016 from:idle to:running action:develop run:rntra2d note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T12:13:41Z task:TASK-016 stage:develop action:develop run:rntra2d note:"Started develop activity."
- progress run:rntra2d task:TASK-016 at:2026-09-04T12:14:00Z note:"Inspecting endpoint, task-set, and sharing implementation."
- run:rntra2d task:TASK-016 stage:develop result:ok note:"2026-09-04T12:19:28Z — implemented independently bound task-set HTTP ports with share selection, validation, tests, and documentation."
- audit:status-change at:2026-09-04T12:19:41Z task:TASK-016 from:running to:blocked action:receipt run:rntra2d outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-04T12:19:41Z task:TASK-016 stage:develop action:receipt run:rntra2d outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
- propose-task run:rntra2d type:feature title:"Centralized Kanban workspace registry" note:"Provide a central service where Kanban workspaces register and visitors choose a workspace before opening its board."
- audit:state-change at:2026-09-06T03:16:54Z task:TASK-016 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-06T03:16:54Z task:TASK-016 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-06T03:16:57Z task:TASK-016 from:validation to:done action:move note:"State changed from validation to done via move."
