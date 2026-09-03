---
id: TASK-017
title: Centralized Kanban workspace registry
type: feature
state: done
status: idle
position: 14
created: 2026-09-05T02:57:26Z
updated: 2026-09-06T03:16:57Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-017
copilot_session_id: ecd19ee7-be55-4196-a953-b4efe8063714
scope_hash: c4d2005
chat_reset_required: false
origin_task: TASK-016
---

## Request
Provide a central Kanban service where workspace instances register themselves so visitors can choose a workspace before opening its board.

_Filed automatically by TASK-016's run rntra2d._

## Refined

### Problem statement

Provide one separately deployed, durable workspace-registry service that lets an opted-in Kanban Pilot workspace advertise its already-running HTTP board endpoint. A visitor starts at the registry, sees only currently reachable workspaces, selects one, and is then sent to that workspace's existing board endpoint. The registry is a discovery directory only: it must not copy task data, proxy board traffic, or persist an endpoint's board access token.

**Assumptions:** the registry is deployed as a dedicated hosted service; workspaces authenticate registration with a configured registry credential; visitors authenticate to a selected board with that board's existing token locally. The service stores a sanitized board base URL, display name, stable workspace id, and heartbeat metadata only.

### SPLIT RECOMMENDATION

NO SPLIT — 1 feature: central discovery, registration, and visitor selection for existing Kanban Pilot workspace boards.

### Acceptance Criteria

- An opted-in workspace with an active HTTP board endpoint can register and refresh a single discoverable record containing its stable id, validated display name, sanitized board base URL, and liveness timestamp; duplicate refreshes update that record rather than creating another.
- Registry registration and removal require the configured registry credential; malformed identifiers, names, or non-HTTP(S) endpoint URLs are rejected without changing stored records.
- The registry removes or hides records whose heartbeat expires, and an extension shutdown or endpoint disable attempts to remove its registration.
- A visitor can load the registry landing page, see only non-expired workspace names and availability, choose one, and navigate to that workspace's board URL; the registry never renders task data or exposes a board token in its listing or API response.
- If the registry is unavailable, registration failures do not stop the local board endpoint; the extension reports a non-secret diagnostic and retries on the next lifecycle refresh.
- Automated tests cover authenticated registration, upsert/expiry/removal, invalid input, redaction of token-bearing URLs, visitor selection, and the extension lifecycle client.

## Scope

- Add a standalone hosted registry package under `hosted/` with its own package manifest, TypeScript configuration, runtime entry point, and durable registry-store abstraction; expose authenticated register, heartbeat/upsert, deregister, health, and visitor-list endpoints.
- Implement the hosted visitor landing surface and its minimal client script so it fetches the public-safe workspace list, shows workspace name and availability, and opens the selected sanitized board base URL without duplicating the board UI.
- Add registry record validation and normalization in the hosted service: stable workspace ids, bounded display names, HTTP(S)-only URLs, removal of query strings/fragments and credentials, expiry based on a documented heartbeat TTL, and no task payload or board token storage.
- Add `kanbanPilot.registry` configuration contributions in `package.json` for enablement, registry base URL, workspace display name, and registration credential; ensure settings descriptions state that registry enrollment is separate from each board's access token.
- Add a workspace-registry client in `src/http/` and integrate it into the endpoint lifecycle in `src/extension.ts`: register only after a board endpoint starts, refresh while it remains available, update on task-set endpoint changes, and best-effort deregister when the endpoint stops or the extension disposes.
- Keep `src/http/realtimeBoardServer.ts` authoritative for each selected board: no task mirroring, cross-workspace state aggregation, or board proxying is added to the registry flow.
- Add hosted-service tests for authentication, validation/redaction, idempotent upsert, expiry, deregistration, health, listing, and landing-page selection; add extension/client tests for registration lifecycle, retry behavior, and non-fatal registry failures.
- Update `docs/http-endpoint.md`, `docs/configuration.md`, and `README.md` with deployment, enrollment, heartbeat/expiry, visitor board-token entry, privacy boundaries, and smoke-test instructions.

## Log
- audit:state-change at:2026-09-05T02:57:39Z task:TASK-017 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-05T02:57:40Z task:TASK-017 from:idle to:running action:refine run:rydd2t3 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-05T02:57:40Z task:TASK-017 stage:refine action:refine run:rydd2t3 note:"Started refine activity."
- run:rydd2t3 task:TASK-017 stage:refine result:ok note:"Scoped a dedicated hosted workspace registry with privacy-safe board discovery and lifecycle integration."
- audit:status-change at:2026-09-05T02:58:44Z task:TASK-017 from:running to:idle action:receipt run:rydd2t3 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-05T02:58:44Z task:TASK-017 stage:refine action:receipt run:rydd2t3 outcome:ok note:"Scoped a dedicated hosted workspace registry with privacy-safe board discovery and lifecycle integration."
- audit:state-change at:2026-09-05T03:03:48Z task:TASK-017 from:refine to:scoped action:apply-pending run:rydd2t3 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-05T03:03:49Z task:TASK-017 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-05T03:03:53Z task:TASK-017 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-05T03:03:53Z task:TASK-017 from:idle to:running action:develop run:rrt3cb4 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-05T03:03:53Z task:TASK-017 stage:develop action:develop run:rrt3cb4 note:"Started develop activity."
- progress run:rrt3cb4 task:TASK-017 at:2026-09-05T03:04:17Z note:"Implementing the hosted registry and extension lifecycle client."
- run:rrt3cb4 task:TASK-017 stage:develop result:ok note:"Implemented the hosted workspace registry, opt-in endpoint lifecycle enrollment, documentation, and passing coverage."
- audit:status-change at:2026-09-05T03:09:15Z task:TASK-017 from:running to:blocked action:receipt run:rrt3cb4 outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-05T03:09:15Z task:TASK-017 stage:develop action:receipt run:rrt3cb4 outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
- audit:state-change at:2026-09-06T03:16:54Z task:TASK-017 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-06T03:16:54Z task:TASK-017 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-06T03:16:57Z task:TASK-017 from:validation to:done action:move note:"State changed from validation to done via move."
