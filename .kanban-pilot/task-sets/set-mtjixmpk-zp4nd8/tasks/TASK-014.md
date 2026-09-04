---
id: TASK-014
title: trigger auto compact when a certain context window threshold% has been reached
type: feature
state: validation
status: idle
position: 0
created: 2026-09-04T04:34:03Z
updated: 2026-09-04T11:02:45Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-014
copilot_session_id: bada60be-166a-4271-a75c-ade12698fcde
scope_hash: 31c4fbc
chat_reset_required: false
---

## Request
I want to be able to monitor the context window and how much has been consumed. When a certain threhold% has been reach, trigger the /compact automatically.
Check the copilot extension code and look for the context window from the session info code.

## Refined

### Problem statement
Kanban Pilot needs an opt-in, compatibility-aware way to prevent a Copilot agent conversation bound to a task from exhausting its context window. A user must be able to configure a threshold as a context-window ratio, such as `0.8` for 80%, and have conversation history compacted while preserving the task conversation. The installed Copilot metadata exposes native background compaction through `github.copilot.chat.summarizeAgentConversationHistory.enabled` and `github.copilot.chat.summarizeAgentConversationHistoryThreshold`; this native capability is the preferred source of truth because completed-turn `promptTokens`/`outputTokens`, delayed transcript JSONL, and structural hook events do not provide reliable live context usage.

### SPLIT RECOMMENDATION
SPLIT RECOMMENDATION: SPLIT REQUIRED — 2 features

1. **TASK-014 — Configurable automatic compaction:** Keep this card focused on enabling and safely delegating threshold-based compaction for the Copilot conversation bound to a Kanban task. The scope includes compatibility detection, configuration, session safety, and failure reporting, but not a usage dashboard.
2. **Follow-up — Context usage visibility:** Add a separate user-visible status for current or last-known context usage, limit, and percentage. It must show `unknown` when no supported live source exists rather than reconstructing usage from transcripts or per-turn totals. This follow-up depends on confirming a supported usage source and is not created by this refinement.

Recommended order: complete TASK-014's native-compaction compatibility gate first, then pursue usage visibility independently.

### Acceptance Criteria
- [ ] Automatic compaction is opt-in and accepts a ratio greater than `0` and at most `1`; `0.8` is documented and handled as 80% of the model context window.
- [ ] On a supported Copilot build, the native background compaction settings are honored for the task's bound agent conversation. The `github.copilot.chat.compact` command is used only if a supported, session-targeted invocation is proven; `workbench.action.chat.newChat` is never used as a substitute.
- [ ] Compaction preserves the existing Kanban task session identity, cannot target an unrelated focused chat, and does not issue duplicate compactions while one is in flight.
- [ ] Disabled, invalid, unavailable, experimental-incompatible, or failed compaction paths produce a clear bounded status and leave normal task execution usable; no undocumented transcript parser is used as a live-token fallback.
- [ ] Telemetry and logs contain only task/session identifiers, configured threshold, capability, and outcome; raw prompts, responses, transcript content, tool arguments, paths, and secrets are not exposed.
- [ ] Automated tests cover threshold validation, capability absence, safe session targeting, duplicate suppression, command failure, and successful resumption after compaction; documentation includes the Copilot version/experimental-setting caveat.

## Scope
- [ ] **Compatibility gate:** Verify the native settings and command against the extension's supported VS Code range and the installed Copilot version. Record whether native automatic compaction is available and whether explicit compaction can target the bound `vscode-chat-session://local` session. If either cannot be established through a supported interface, do not implement an unsafe custom monitor; report the limitation instead.
- [ ] **Configuration (`package.json`):** Add an opt-in Kanban setting for automatic compaction and a ratio threshold with a documented default. Treat Copilot's native compaction configuration as the source of truth, avoid silently overwriting user settings, and make unsupported/conflicting configuration visible.
- [ ] **Capability adapter (`src/chat/contextCompaction.ts` or equivalent):** Isolate ratio validation, Copilot capability/configuration detection, in-flight deduplication, outcome classification, and the no-op/unsupported path. Do not calculate live usage from `metadata.promptTokens`/`outputTokens`, transcript files, or hook event counts.
- [ ] **Executor integration (`src/chat/executor.ts`):** Extend the executor only with the smallest supported compaction operation needed by the adapter. Keep `metadata.sessionId` as identity evidence, and do not invoke a focused command without a proven target-session contract.
- [ ] **Run coordination (`src/chat/runManager.ts`):** Wire the adapter to the existing task-bound session lifecycle, keep compaction separate from `newChat`, prevent concurrent requests, and record bounded success/unsupported/failure activity without changing task state incorrectly.
- [ ] **Activation and cleanup (`src/extension.ts`):** Construct the capability/configuration service, react to configuration changes, and dispose listeners/timers with the extension lifecycle.
- [ ] **Tests:** Add focused unit tests and update executor/run-manager coverage with mocked Copilot capability and command results; include supported, unsupported, invalid-threshold, unrelated-session, duplicate, and failure cases.
- [ ] **Documentation:** Update `docs/configuration.md` and the relevant Copilot research/PRD notes with ratio semantics, native-setting ownership, minimum-version risk, unsupported behavior, and the explicit deferral of a live usage display.
- [ ] **Explicitly out of scope for this card:** a context-usage dashboard, raw transcript/token reconstruction, global chat resets, or changes to workflow helper scripts and hooks.

## Log
- audit:state-change at:2026-09-04T04:34:04Z task:TASK-014 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-04T04:34:05Z task:TASK-014 from:idle to:running action:refine run:rozgnhx note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-04T04:34:05Z task:TASK-014 stage:refine action:refine run:rozgnhx note:"Started refine activity."
- progress run:rozgnhx task:TASK-014 at:2026-09-04T04:37:05Z note:"research complete; writing the compatibility-first compaction scope"
- run:rozgnhx task:TASK-014 stage:refine result:ok note:"2026-09-04T04:37:05Z — refine completed: documented native Copilot compaction, session safety, and the separate usage-visibility follow-up"
- audit:status-change at:2026-09-04T04:37:59Z task:TASK-014 from:running to:idle action:receipt run:rozgnhx outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-04T04:37:59Z task:TASK-014 stage:refine action:receipt run:rozgnhx outcome:ok note:"2026-09-04T04:37:05Z — refine completed: documented native Copilot compaction, session safety, and the separate usage-visibility follow-up"
- audit:state-change at:2026-09-04T04:38:45Z task:TASK-014 from:refine to:scoped action:apply-pending run:rozgnhx outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-04T04:38:46Z task:TASK-014 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-04T04:38:47Z task:TASK-014 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T04:38:47Z task:TASK-014 from:idle to:running action:develop run:r0hlqb6 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T04:38:47Z task:TASK-014 stage:develop action:develop run:r0hlqb6 note:"Started develop activity."
- progress run:r0hlqb6 task:TASK-014 at:2026-09-04T04:52:11Z note:"compatibility gate confirmed native threshold support is experimental and compact invocation is focus-only"
- run:r0hlqb6 task:TASK-014 stage:develop result:blocked note:"2026-09-04T04:52:11Z — develop blocked: the native compact command has no supported task-session target and delegates to the focused chat, so safe task-bound compaction cannot be implemented without risking an unrelated conversation"
- audit:status-change at:2026-09-04T04:52:34Z task:TASK-014 from:running to:blocked action:receipt run:r0hlqb6 outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-04T04:52:34Z task:TASK-014 stage:develop action:receipt run:r0hlqb6 outcome:blocked note:"2026-09-04T04:52:11Z — develop blocked: the native compact command has no supported task-session target and delegates to the focused chat, so safe task-bound compaction cannot be implemented without risking an unrelated conversation"
- audit:state-change at:2026-09-04T05:22:05Z task:TASK-014 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-04T05:22:05Z task:TASK-014 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-04T05:34:33Z task:TASK-014 from:validation to:approved action:move note:"State changed from validation to approved via move."
- audit:state-change at:2026-09-04T05:37:03Z task:TASK-014 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T05:37:03Z task:TASK-014 from:idle to:running action:develop run:rue8cr6 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T05:37:03Z task:TASK-014 stage:develop action:develop run:rue8cr6 note:"Started develop activity."
- progress run:rue8cr6 task:TASK-014 at:2026-09-04T05:38:00Z note:"verifying the native compaction configuration and task-session safety boundary"
- run:rue8cr6 task:TASK-014 stage:develop result:blocked note:"2026-09-04T05:42:24Z — develop blocked: Copilot native compaction remains experimental and its compact command is focus-only with no supported bound-session target, so implementing automatic monitoring or invoking it could compact an unrelated chat"
- audit:status-change at:2026-09-04T05:43:04Z task:TASK-014 from:running to:blocked action:receipt run:rue8cr6 outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-04T05:43:04Z task:TASK-014 stage:develop action:receipt run:rue8cr6 outcome:blocked note:"2026-09-04T05:42:24Z — develop blocked: Copilot native compaction remains experimental and its compact command is focus-only with no supported bound-session target, so implementing automatic monitoring or invoking it could compact an unrelated chat"
- audit:state-change at:2026-09-04T07:44:09Z task:TASK-014 from:in-progress to:approved action:move note:"State changed from in-progress to approved via move."
- audit:status-change at:2026-09-04T07:44:09Z task:TASK-014 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-04T07:50:59Z task:TASK-014 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-04T07:50:59Z task:TASK-014 from:idle to:running action:develop run:rjp1clv note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-04T07:50:59Z task:TASK-014 stage:develop action:develop run:rjp1clv note:"Started develop activity."
- progress run:rjp1clv task:TASK-014 at:2026-09-04T08:54:14Z note:"auditing the existing native compaction implementation and supported session-targeting boundary"
- progress run:rjp1clv task:TASK-014 at:2026-09-04T09:37:17Z note:"safe session-targeting boundary and unset native threshold handling are covered by focused tests"
- progress run:rjp1clv task:TASK-014 at:2026-09-04T09:40:50Z note:"documented native setting ownership, experimental version caveats, unsupported focus targeting, and live usage deferral"
- run:rjp1clv task:TASK-014 stage:develop result:ok note:"implemented opt-in native threshold compaction with ratio validation, safe task-session targeting, bounded unsupported/failure outcomes, lifecycle configuration handling, focused tests, and compatibility documentation"
- progress run:rjp1clv task:TASK-014 at:2026-09-04T07:57:01Z note:"implementing native compaction configuration and task-bound command sequencing"
- receipt-diagnostic kind:run-mismatch task:TASK-014 expected-run:rjp1clv expected-stage:develop actual-run:rozgnhx actual-task:TASK-014 actual-stage:refine note:"Ignored receipt because run id rozgnhx is stale; expected rjp1clv."
- receipt-diagnostic kind:run-mismatch task:TASK-014 expected-run:rjp1clv expected-stage:develop actual-run:r0hlqb6 actual-task:TASK-014 actual-stage:develop note:"Ignored receipt because run id r0hlqb6 is stale; expected rjp1clv."
- receipt-diagnostic kind:run-mismatch task:TASK-014 expected-run:rjp1clv expected-stage:develop actual-run:rue8cr6 actual-task:TASK-014 actual-stage:develop note:"Ignored receipt because run id rue8cr6 is stale; expected rjp1clv."
- run:rjp1clv task:TASK-014 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-04T08:11:00Z task:TASK-014 from:running to:failed action:timeout run:rjp1clv outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-04T08:11:00Z task:TASK-014 stage:develop run:rjp1clv outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- audit:status-change at:2026-09-04T09:51:58Z task:TASK-014 from:failed to:blocked action:late-receipt run:rjp1clv outcome:blocked note:"Status changed from failed to blocked via late-receipt."
- audit:activity-finish at:2026-09-04T09:51:58Z task:TASK-014 stage:develop action:late-receipt run:rjp1clv outcome:blocked correction:true note:"Develop completion requires implementation evidence with changed files and verification."
- implementation-evidence run:rjp1clv files:"src/chat/contextCompaction.ts,src/chat/executor.ts,src/chat/runManager.ts,src/extension.ts,package.json,docs/configuration.md,docs/PRD.md" verify:"npm test passed with 470 tests; compile-tests and lint passed"
- run:rjp1clv task:TASK-014 stage:develop result:ok note:"2026-09-04T10:04:32Z — implemented opt-in native threshold compaction with ratio validation, safe task-session targeting, bounded unsupported and failure outcomes, lifecycle configuration handling, focused tests, and compatibility documentation"
- audit:state-change at:2026-09-04T11:02:45Z task:TASK-014 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-04T11:02:45Z task:TASK-014 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
