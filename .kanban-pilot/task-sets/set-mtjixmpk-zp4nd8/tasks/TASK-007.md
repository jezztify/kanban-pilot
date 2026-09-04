---
id: TASK-007
title: Make activity provenance and freshness explicit
type: feature
state: done
status: idle
parent_task: TASK-003
position: 2
created: 2026-09-03T02:44:07Z
updated: 2026-09-04T02:25:14Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-007
copilot_session_id: efc12a25-ab19-42f6-9f5d-9cad3434606d
scope_hash: fd9e61d
origin_task: TASK-003
origin_run: rroucoq
---

## Request
Make activity provenance and freshness explicit. Users should be able to distinguish durable progress summaries, near-real-time hook observations, and delayed transcript observations, and understand when activity is disabled, unavailable, delayed, or empty without exposing prompts, tool payloads, credentials, or other private Copilot data.

_Filed automatically by TASK-003's run rroucoq._

## Refined

### Problem statement

The Activity section currently merges durable progress summaries, near-real-time hook observations, and delayed transcript observations into one bounded list. It does not visibly explain which source produced a row, whether the source is durable or ephemeral, how fresh an observation is, or whether an empty result means disabled, unavailable, enabled-but-empty, or delayed. Hook and progress rows also share the same visual provenance, while transcript projection must be kept from exposing private Copilot content. This feature makes the shared editor/browser activity projection explicit, honest about freshness, and privacy-safe without turning it into a transcript mirror.

### SPLIT RECOMMENDATION: NO SPLIT — 1 feature

The single feature is explicit, privacy-safe activity provenance and freshness in task detail and the shared browser board. Source modeling, rendering, refresh wiring, focused tests, and documentation are implementation parts of that one user-visible outcome.

### Acceptance Criteria

- A selected task detail projection and its editor/browser render visibly distinguish durable progress summaries, near-real-time hook observations, and delayed transcript observations with accessible source labels or equivalent text; color or position alone is not the distinction.
- The projection and UI distinguish, for each relevant source, disabled by setting, unavailable or not configured, available but empty, and available with entries. Transcript-enabled states explicitly say that observations can be delayed; remote hook/transcript activity remains withheld unless the existing remote opt-in allows it. None of these states is presented as proof that a run is idle or complete.
- Activity timestamps have honest semantics: event time is separate from observation/freshness time when the source can provide it, and transcript rows are labeled as delayed observations rather than live state. Refreshes and reconnects do not reset or fabricate freshness.
- Feed rows and `task/detail` or browser session payloads contain only bounded structural summaries. They never include raw prompts, assistant or reasoning text, tool arguments or results, credentials, tokens, absolute paths, or sensitive command/query/file-target content, including values derived from those fields.
- Existing feed bounds, event ordering, hook/transcript duplicate suppression, task attribution, blocked-task guidance, safe text rendering, read-only behavior, and authenticated browser transport remain intact. Activity metadata never changes task state, workflow receipts, or the durable task log.
- Focused editor and browser tests cover one row and the relevant state for each source, missing/unreadable source, settings and remote gates, freshness wording, reconnect projection, and adversarial privacy inputs. Existing progress, hook, transcript, and endpoint regressions continue to pass.

## Scope

- Extend the activity view contract in `src/board/boardPanel.ts` with source-level status and freshness metadata, source-specific row provenance, and explicit disabled/unavailable/delayed/empty copy. Render the same safe projection in the editor and browser, preserving blocked messaging, bounded scrolling, accessible timestamps, and text-node rendering.
- Keep `src/chat/progress.ts` as the durable, coarse-summary source; make its recorded/durable semantics explicit without treating progress as a live transcript or terminal receipt.
- Update `src/chat/hookSpool.ts` to expose enough availability and observation metadata to distinguish configured/working, enabled-empty, missing, unreadable, or stale hook input while retaining structural parsing, task attribution, bounds, deduplication, and fail-open behavior.
- Tighten the redaction boundary in `src/chat/transcriptTail.ts` so projected entries contain only safe structural summaries, removing raw or derived prompt, assistant/reasoning, argument, result, path, command, and query content. Add event-versus-observed timing and delayed-source metadata without broadening transcript parsing or persistence.
- Review `src/chat/runManager.ts` and `src/extension.ts` so source changes, transcript polling, run start/stop, missing storage, and missing workspace wiring republish timely detail state instead of collapsing to an indistinguishable empty feed. Do not alter workflow transitions or add a second activity store.
- Preserve the existing browser transport in `src/http/browserBoardSurface.ts` and `src/http/realtimeBoardServer.ts`; verify that the shared `task/detail` projection, reconnect refresh, and `chat.transcriptFeedRemote` gate carry only the approved metadata and no private payloads. Do not add a chat-stream endpoint.
- Update focused coverage in `src/test/boardPanel.test.ts`, `src/test/transcriptTail.test.ts`, `src/test/hookSpool.test.ts`, and relevant run/browser integration tests. Replace expectations that require prompt text, assistant text, or sensitive tool targets with structural redaction assertions, and cover source labels, statuses, freshness, bounds, deduplication, and remote gating.
- Clarify source provenance, delay, availability, empty-state meanings, and privacy boundaries in `docs/board-guide.md`, `docs/configuration.md`, and `docs/copilot-hook-feed.md`; keep `docs/PRD.md` and endpoint privacy wording aligned if the projection contract changes.
- Out of scope: chat or transcript mirroring, durable activity persistence, new settings or endpoints, workflow/state-machine changes, unbounded history, or exposing editor-only controls to browser users.

## Log
- audit:state-change at:2026-09-03T09:38:00Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-03T09:38:02Z task:TASK-007 from:idle to:running action:refine run:rk7f6sn note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-03T09:38:02Z task:TASK-007 stage:refine action:refine run:rk7f6sn note:"Started refine activity."
- progress run:rk7f6sn task:TASK-007 at:2026-09-03T09:40:37Z note:"refinement documented the activity source-state and privacy contract"
- run:rk7f6sn task:TASK-007 stage:refine result:ok note:"2026-09-03T09:40:37Z — refine completed: documented explicit source, freshness, availability, and privacy boundaries"
- audit:status-change at:2026-09-03T09:41:17Z task:TASK-007 from:running to:idle action:receipt run:rk7f6sn outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-03T09:41:17Z task:TASK-007 stage:refine action:receipt run:rk7f6sn outcome:ok note:"2026-09-03T09:40:37Z — refine completed: documented explicit source, freshness, availability, and privacy boundaries"
- audit:state-change at:2026-09-04T00:36:46Z task:TASK-007 from:refine to:scoped action:apply-pending run:rk7f6sn outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-04T00:36:47Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-04T00:36:48Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T00:36:48Z task:TASK-007 from:idle to:running action:develop run:rvbopub note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T00:36:48Z task:TASK-007 stage:develop action:develop run:rvbopub note:"Started develop activity."
- progress run:rvbopub task:TASK-007 at:2026-09-04T00:37:00Z note:"reviewing the activity projection and source boundaries"
- receipt-diagnostic kind:run-mismatch task:TASK-007 expected-run:rvbopub expected-stage:develop actual-run:rk7f6sn actual-task:TASK-007 actual-stage:refine note:"Ignored receipt because run id rk7f6sn is stale; expected rvbopub."
- run:rvbopub task:TASK-007 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-04T00:56:48Z task:TASK-007 from:running to:failed action:timeout run:rvbopub outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-04T00:56:48Z task:TASK-007 stage:develop run:rvbopub outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- audit:state-change at:2026-09-04T02:25:12Z task:TASK-007 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-04T02:25:12Z task:TASK-007 from:failed to:idle action:move note:"Status changed from failed to idle via move."
- audit:state-change at:2026-09-04T02:25:14Z task:TASK-007 from:validation to:done action:move note:"State changed from validation to done via move."
