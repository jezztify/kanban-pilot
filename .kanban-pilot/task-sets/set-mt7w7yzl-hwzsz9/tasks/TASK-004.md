---
id: TASK-004
title: Extend http browser feature: bind to all interfaces
type: feature
state: done
status: idle
position: 2
created: 2026-08-26T05:00:02Z
updated: 2026-08-26T05:39:40Z
chat: 300c8f41-2589-4d00-8706-f8c7f58d1d40
copilot_session_id: 300c8f41-2589-4d00-8706-f8c7f58d1d40
scope_hash: 327e6b2
chat_reset_required: false
---

## Request
Extend http browser feature: bind to all interfaces

## Refined

### Problem
The real-time HTTP endpoint can already bind to a configured address — `kanbanPilot.http.host` is read in `httpEndpointConfig()` and passed to `server.listen(port, bindAddress)` in [src/http/realtimeBoardServer.ts](src/http/realtimeBoardServer.ts) — so setting it to `0.0.0.0`/`::` already binds to all interfaces. The gap is that the *share* path is unusable for that bind: `endpointUrl()` collapses `0.0.0.0`/`::` to `localhost`, so the status-bar QR code, copyable URL, and "listening on…" toast all point at `localhost`, which no other device on the LAN can reach. That defeats the only reason to bind to all interfaces (letting a phone/second machine open the board). There is also no security cue when the endpoint stops being loopback-only.

"Extend http browser feature: bind to all interfaces" is therefore read as: make an all-interfaces bind actually shareable — derive the host machine's reachable LAN address for the connection URL/QR — and surface a security warning when the bind is non-loopback.

### Acceptance criteria
- When `kanbanPilot.http.host` is `0.0.0.0` or `::`, the status-bar share URL, QR code, and the "listening on…" info message use a reachable non-internal LAN IPv4 of the host machine (with the correct actual port and the `token` query parameter) instead of `localhost`/`127.0.0.1`.
- If no non-internal address is available, it falls back to `localhost` (current behavior) rather than erroring.
- Address selection is deterministic (e.g., first non-internal IPv4) so repeated shares are stable.
- An explicit non-wildcard host (a specific LAN IP or hostname) is still rendered verbatim, and IPv6 literals keep their bracketed form.
- A configured `kanbanPilot.http.publicUrl` still takes precedence over any derived address (unchanged).
- Starting the endpoint on a non-loopback bind surfaces a security warning (token travels in the URL; no TLS) but still starts the endpoint (warn-but-allow).
- Unit tests cover host resolution for: wildcard → derived LAN IP, wildcard with no candidate → `localhost`, specific host verbatim, IPv6 bracketing, and `publicUrl` override. The interface lookup is injectable/mockable so tests are deterministic.
- `npm run compile` and `npm test` pass.

### Assumptions
- IPv4 LAN address is sufficient for the share URL (no IPv6 LAN discovery required).
- "Warn but allow" is the desired posture (no hard confirmation prompt) — chosen because the feature is opt-in and already gated behind an explicit setting + token.
- No new setting is required; the existing `kanbanPilot.http.host` remains the switch.

## Scope

- [src/http/realtimeBoardServer.ts](src/http/realtimeBoardServer.ts)
  - Add a host-resolution helper (e.g. `resolveShareHost(bindAddress, lookup?)`) that, for `0.0.0.0`/`::`, uses `node:os` `networkInterfaces()` to pick the first non-internal IPv4; make the interface lookup an injectable parameter (default to the real `os.networkInterfaces`) for testability.
  - Update `endpointUrl()` so wildcard binds resolve via that helper instead of the hardcoded `localhost`; preserve `publicUrl` precedence, explicit-host passthrough, and existing IPv6 bracket handling.
  - Keep `endpointConnectionUrl()` (token query param) working on top of the new host.
  - Export whatever the tests need (helper and/or a predicate for "is this a non-loopback bind").
- [src/extension.ts](src/extension.ts)
  - In `restartEndpoint()`, when the resolved `bindAddress` is non-loopback (not `127.0.0.1`/`::1`/`localhost`), show a security warning (token-in-URL, no TLS) at start; keep starting the endpoint (warn-but-allow). Avoid spamming: warn on start, not on every config read.
- [package.json](package.json)
  - Update the `kanbanPilot.http.host` `description` to document that `0.0.0.0`/`::` binds to all interfaces for LAN sharing and to note the security implication.
- [README.md](README.md)
  - Update the `kanbanPilot.http.host` table row to describe all-interfaces binding and that the share URL/QR then use the machine's LAN IP.
- [src/test/realtimeBoardServer.test.ts](src/test/realtimeBoardServer.test.ts)
  - Add unit tests for `endpointUrl`/host resolution covering the acceptance-criteria cases (wildcard → LAN IP via mocked interfaces, wildcard → `localhost` fallback, specific host verbatim, IPv6 bracketing, `publicUrl` override).
- Verification: run `npm run compile` and `npm test`; manually confirm the status-bar QR/URL shows a LAN IP when `host` is `0.0.0.0`.

## Log
- audit:state-change at:2026-08-26T05:00:05Z task:TASK-004 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T05:00:06Z task:TASK-004 from:idle to:running action:refine run:rt3mlmu note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T05:00:06Z task:TASK-004 stage:refine action:refine run:rt3mlmu note:"Started refine activity."
- run:rt3mlmu task:TASK-004 stage:refine result:ok note:"Bind-to-all-interfaces already works via kanbanPilot.http.host; real gap is share URL/QR collapsing 0.0.0.0 to localhost. Scoped LAN-IP resolution for share URL plus non-loopback security warning across realtimeBoardServer.ts, extension.ts, package.json, README, tests."
- audit:status-change at:2026-08-26T05:02:05Z task:TASK-004 from:running to:idle action:receipt run:rt3mlmu outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T05:02:05Z task:TASK-004 stage:refine action:receipt run:rt3mlmu outcome:ok note:"Bind-to-all-interfaces already works via kanbanPilot.http.host; real gap is share URL/QR collapsing 0.0.0.0 to localhost. Scoped LAN-IP resolution for share URL plus non-loopback security warning across realtimeBoardServer.ts, extension.ts, package.json, README, tests."
- audit:state-change at:2026-08-26T05:24:41Z task:TASK-004 from:refine to:scoped action:apply-pending run:rt3mlmu outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T05:24:45Z task:TASK-004 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T05:24:46Z task:TASK-004 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T05:24:46Z task:TASK-004 from:idle to:running action:develop run:rv0a8z3 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T05:24:46Z task:TASK-004 stage:develop action:develop run:rv0a8z3 note:"Started develop activity."
- run:rv0a8z3 task:TASK-004 stage:develop result:ok note:"Added resolveShareHost/isNonLoopbackBindAddress helpers so wildcard binds derive a LAN IPv4 for the share URL/QR; non-loopback binds now show a security warning; updated setting/README docs and added deterministic unit tests. compile + 341 tests pass."
- audit:status-change at:2026-08-26T05:28:36Z task:TASK-004 from:running to:idle action:receipt run:rv0a8z3 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T05:28:36Z task:TASK-004 stage:develop action:receipt run:rv0a8z3 outcome:ok note:"Added resolveShareHost/isNonLoopbackBindAddress helpers so wildcard binds derive a LAN IPv4 for the share URL/QR; non-loopback binds now show a security warning; updated setting/README docs and added deterministic unit tests. compile + 341 tests pass."
- audit:state-change at:2026-08-26T05:29:57Z task:TASK-004 from:in-progress to:validation action:apply-pending run:rv0a8z3 outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-08-26T05:39:40Z task:TASK-004 from:validation to:done action:move note:"State changed from validation to done via move."
