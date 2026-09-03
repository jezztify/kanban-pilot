---
id: TASK-019
title: Modernize Kanban Registry UI
type: feature
state: done
status: idle
position: 16
created: 2026-09-05T23:45:57Z
updated: 2026-09-06T03:16:59Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-019
copilot_session_id: 3dbb9fa5-2161-4201-a087-2a29e8052502
scope_hash: 738d723
chat_reset_required: false
---

## Request
Modernize Kanban Registry UI

## Refined

### Problem statement

The standalone Kanban Pilot Registry landing page currently provides only a minimal inline HTML list for choosing a live workspace. It is visually dated, gives weak hierarchy around the Registry purpose and workspace availability, and does not provide a polished responsive or accessible experience across loading, empty, populated, and request-failure states. Modernize this visitor-facing page so a user can quickly understand the Registry, identify an available workspace, and open its existing board without changing the registry protocol or exposing board credentials.

Assumption used for this refinement: “modernize” means one focused presentation/accessibility refresh of the hosted Registry landing page, not a new discovery product. Existing workspace listing and redirect behavior remain the source of truth; search, live polling, authentication changes, and board-webview redesign are out of scope.

### SPLIT RECOMMENDATION

NO SPLIT — 1 feature: modernize the standalone Kanban Pilot Registry landing page.

### Acceptance Criteria

- `GET /` renders a cohesive Kanban Pilot Registry page with clear branding, purpose, workspace availability status, and a responsive layout that remains usable on narrow and wide viewports.
- The page preserves the existing `GET /api/workspaces` contract and opens each selected workspace at the returned `boardUrl`; no new registry API, persistence model, polling loop, or board data source is introduced.
- Loading, available-workspaces, no-workspaces, and request-failure states are all represented by intentional, human-readable UI. The available state includes the current workspace count and clearly labelled navigation targets.
- The page uses semantic landmarks and accessible names, visible keyboard focus, sufficient contrast, and motion that respects `prefers-reduced-motion`; workspace navigation works without a pointer.
- Workspace names and links are rendered safely, and the page never displays or logs registration credentials, board tokens, task data, or board snapshots.
- The hosted Registry tests cover the rendered page contract and existing safe-data guarantees, and the hosted build/test command passes.

## Scope

- [ ] `hosted/src/server.ts`: replace the compressed `page()` template with structured Registry landing-page markup and maintain the existing `/api/workspaces` fetch and board redirect flow. Add the visual hierarchy, responsive styling, accessible status/list/link structure, and intentional loading, populated, empty, and failure states described above.
- [ ] `hosted/src/server.ts`: keep client rendering restricted to the sanitized public workspace fields already returned by the Registry; use navigation links or equivalent keyboard-operable controls rather than introducing host/editor behavior or a second data model.
- [ ] `hosted/src/test/registry.test.ts`: extend the landing-page coverage for the Registry heading/purpose, status and workspace-list hooks, existing API usage, navigation behavior contract, and the absence of task or credential-bearing content while retaining the current endpoint/auth/TTL assertions.
- [ ] `hosted/README.md`: document the refreshed Registry landing page and its unchanged public listing, redirect, credential, and no-board-data boundaries.
- [ ] Verification: run the hosted build and test scripts, then smoke-check the landing page at wide and narrow viewport sizes plus loading, populated, empty, and failed-fetch states; do not modify generated build output or unrelated board UI.

## Log
- audit:state-change at:2026-09-05T23:45:58Z task:TASK-019 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-05T23:45:59Z task:TASK-019 from:idle to:running action:refine run:rf74q0c note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-05T23:45:59Z task:TASK-019 stage:refine action:refine run:rf74q0c note:"Started refine activity."
- progress run:rf74q0c task:TASK-019 at:2026-09-05T23:47:06Z note:"clarifying the Registry landing-page boundary and acceptance criteria"
- run:rf74q0c task:TASK-019 stage:refine result:ok note:"2026-09-05T23:47:06Z — refine completed: scoped a responsive accessible Registry landing-page refresh without changing registry APIs or security boundaries"
- audit:status-change at:2026-09-05T23:48:28Z task:TASK-019 from:running to:idle action:receipt run:rf74q0c outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-05T23:48:28Z task:TASK-019 stage:refine action:receipt run:rf74q0c outcome:ok note:"2026-09-05T23:47:06Z — refine completed: scoped a responsive accessible Registry landing-page refresh without changing registry APIs or security boundaries"
- audit:state-change at:2026-09-05T23:50:48Z task:TASK-019 from:refine to:scoped action:apply-pending run:rf74q0c outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-05T23:50:49Z task:TASK-019 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-05T23:50:50Z task:TASK-019 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-05T23:50:50Z task:TASK-019 from:idle to:running action:develop run:rxtl29k note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-05T23:50:50Z task:TASK-019 stage:develop action:develop run:rxtl29k note:"Started develop activity."
- progress run:rxtl29k task:TASK-019 at:2026-09-05T23:51:18Z note:"preparing the Registry landing-page contract and implementation"
- run:rxtl29k task:TASK-019 stage:develop result:ok note:"2026-09-05T23:53:49Z — implemented the responsive accessible Registry page, safe workspace links, explicit states, tests, and documentation; build and browser smoke checks passed"
- audit:status-change at:2026-09-05T23:54:08Z task:TASK-019 from:running to:blocked action:receipt run:rxtl29k outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-05T23:54:08Z task:TASK-019 stage:develop action:receipt run:rxtl29k outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
- audit:state-change at:2026-09-06T03:16:59Z task:TASK-019 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
- audit:status-change at:2026-09-06T03:16:59Z task:TASK-019 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
