---
id: TASK-001
title: Investigate Copilot Extension Code: Session Info
type: feature
state: in-progress
status: blocked
position: 0
created: 2026-09-06T06:15:29Z
updated: 2026-09-06T06:37:22Z
chat: kanban-pilot-set-mtpf0pme-k245bd-TASK-001
copilot_session_id: 46261dea-106c-4571-9eac-589c3c48a255
scope_hash: b60db73
chat_reset_required: false
---

## Request
Investigate Copilot Extension Code: Session Info to find out how we can extract the current occupied context window.
Check as well with OpenAI-compatible endpoint if it is possible to get it from there?
http://localhost:8001/v1

## Refined

### Problem statement

Determine whether Kanban Pilot can obtain the exact live context occupancy for the Copilot chat session bound to a task: current context tokens, the active model's context limit, the occupied percentage, and the freshness of that value. Trace the supported VS Code/Copilot extension-host surfaces and the existing session, response-metadata, and native-compaction code. Separately determine whether the OpenAI-compatible service at `http://localhost:8001/v1` exposes an equivalent live signal; do not assume that an OpenAI-compatible API can see Copilot's private session state. Per-turn `promptTokens`/`outputTokens`, model `maxInputTokens`, compaction thresholds, and transcript file size must be classified separately from live occupancy.

The primary acceptance target is an exact live value. If no supported source exists, the investigation must make that no-go explicit and document the best available non-equivalent fallback. The endpoint check is an evidence source for the same decision, not a separate product feature.

### SPLIT RECOMMENDATION: NO SPLIT — 1 feature

Feature: a decision-ready investigation of live context-occupancy observability across Copilot and the local OpenAI-compatible endpoint.

### Acceptance Criteria

- A code-evidence table identifies each relevant source, including its value, scope (model, turn, session, or estimate), freshness, and whether it can provide exact live occupancy.
- The existing Copilot session binding and response path are traced to specific files, and supported, experimental, private, and unavailable APIs are clearly distinguished.
- `http://localhost:8001/v1` is checked read-only for model metadata and usage/context fields. Reachability, response shape, and limitations are recorded; an unavailable endpoint is a documented result rather than an assumed capability.
- A written conclusion answers, independently for Copilot and the endpoint, whether current tokens, maximum tokens, and percentage can be extracted, and gives an implementation recommendation without claiming estimates are live values.
- No prompt, transcript, credential, or sensitive repository content is sent to the endpoint, and no product code, tests, settings, or task frontmatter is changed.

## Scope
- [ ] Inspect `src/chat/executor.ts` and `src/chat/sessionUri.ts` to document task-session derivation, command injection, `blockOnResponse`, returned session identity, and the exact result metadata available to the extension.
- [ ] Inspect `src/spike/chatModelProbe.ts`, `src/spike/chatTranscriptProbe.ts`, and `src/chat/contextCompaction.ts` to classify model capacity, transcript/file evidence, native compaction settings, and any live-usage gap.
- [ ] Cross-check the findings against `package.json`, `src/test/executor.test.ts`, `src/test/chatModelProbe.test.ts`, `src/test/contextCompaction.test.ts`, `docs/research/m0-findings.md`, and `docs/research/copilot-context-compaction.md`, recording the tested VS Code/Copilot versions and API status.
- [ ] Perform a read-only capability probe of `http://localhost:8001/v1` (at minimum the compatible model-discovery route); do not submit a chat completion or transmit task/chat data.
- [ ] Create or update `docs/research/copilot-session-info.md` with the evidence table, endpoint observations, explicit Copilot/endpoint verdicts, fallback options, and security/ToS constraints.
- [ ] Keep the work investigation-only: do not modify `src/`, tests, configuration, endpoint behavior, transcripts, or the task file beyond this refinement receipt.

## Log
- audit:state-change at:2026-09-06T06:15:30Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-06T06:15:31Z task:TASK-001 from:idle to:running action:refine run:rtnek63 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-06T06:15:31Z task:TASK-001 stage:refine action:refine run:rtnek63 note:"Started refine activity."
- progress run:rtnek63 task:TASK-001 at:2026-09-06T06:16:10Z note:"reviewed the existing Copilot session, model, transcript, and compaction investigation surfaces"
- run:rtnek63 task:TASK-001 stage:refine result:ok note:"2026-09-06T06:16:39Z — refined the exact-live-occupancy investigation, endpoint check, evidence deliverable, and implementation boundary"
- audit:status-change at:2026-09-06T06:17:07Z task:TASK-001 from:running to:idle action:receipt run:rtnek63 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-06T06:17:07Z task:TASK-001 stage:refine action:receipt run:rtnek63 outcome:ok note:"2026-09-06T06:16:39Z — refined the exact-live-occupancy investigation, endpoint check, evidence deliverable, and implementation boundary"
- audit:state-change at:2026-09-06T06:34:26Z task:TASK-001 from:refine to:scoped action:apply-pending run:rtnek63 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-06T06:34:28Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-06T06:34:29Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-06T06:34:29Z task:TASK-001 from:idle to:running action:develop run:r4ioj2f note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-06T06:34:29Z task:TASK-001 stage:develop action:develop run:r4ioj2f note:"Started develop activity."
- progress run:r4ioj2f task:TASK-001 at:2026-09-06T06:34:53Z note:"auditing the existing Copilot session and context-usage evidence"
- run:r4ioj2f task:TASK-001 stage:develop result:ok note:"2026-09-06T06:36:58Z — completed the Copilot and endpoint context-occupancy investigation, recorded evidence, and passed lint validation"
- audit:status-change at:2026-09-06T06:37:22Z task:TASK-001 from:running to:blocked action:receipt run:r4ioj2f outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-06T06:37:22Z task:TASK-001 stage:develop action:receipt run:r4ioj2f outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
