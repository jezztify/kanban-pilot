---
id: TASK-003
title: Improve logging
type: feature
state: done
status: idle
created: 2026-08-17T09:13:16Z
updated: 2026-08-17T22:19:55Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-003
copilot_session_id: 5f23908f-1db5-4d06-9eeb-084e1a14bc63
scope_hash: 8ba65f3
chat_reset_required: true
---

## Request
I want every activity to be recorded into the task. 
1. When a task is moved from 1 status to another
2. When a task is changed from 1 state to another
3. When a task started and finished an activity

## Refined

### Problem statement

The task file currently preserves the latest `state` (workflow column) and `status` (runtime condition) in frontmatter, while `## Log` primarily contains agent receipts and task-proposal lines. Extension-owned transitions in `src/board/actions.ts` and `src/chat/runManager.ts` update that frontmatter without recording the previous value, the cause, or the time of the change. A person reviewing a task therefore cannot reconstruct when it moved between columns, when its runtime status changed, or when an agent activity began and ended.

Add an append-only, timestamped audit trail to each task's `## Log`. The trail must cover extension-controlled state and status transitions from board actions, command-palette actions, automatic gate policies, and run reconciliation. For this ticket, an activity means an admitted stage run (`refine`, `split`, `develop`, `continue`, or `validate`) identified by its `run` id: record its start after admission and its terminal finish, including success, blocked, failure, timeout, manual completion, or user stop. Existing agent receipts and proposal lines remain valid and continue to be used for run reconciliation.

The scope assumes that "every activity" means activity initiated or completed by the extension. A user or agent directly rewriting frontmatter outside an extension transition cannot currently be attributed reliably from a file watcher alone; that limitation should be documented rather than silently treated as an audited transition.

### Acceptance criteria

- Every actual extension-controlled `state` change records a one-line audit event containing a UTC timestamp, the old column, the new column, and the initiating action or outcome. This includes manual moves, pure gates, automatic gates, stop/reset behavior, and stage outcomes; illegal, invalid, same-column, or capacity-denied operations do not create events.
- Every actual extension-controlled `status` change records a one-line audit event containing a UTC timestamp, the old status, the new status, and the relevant action, run, or outcome. When one operation changes both `state` and `status`, both changes are recorded in deterministic order.
- Each admitted stage run records exactly one activity-start event with its run id and stage/action, and a terminal activity-finish event with its run id and outcome. The finish event is written for success, blocked, failed, timeout, executor error, missing-receipt fallback, manual `Mark Run Complete`, user stop, and a manual move that supersedes a running task; stale results from a superseded run do not create another finish event or overwrite newer task state. If a provisional missing-receipt outcome is later replaced by a valid late receipt, the correction is explicit and idempotent rather than creating another start event or repeating the same finish.
- Audit events are appended to `## Log` using a documented, human-readable, single-line format with UTC ISO 8601 timestamps at second precision and a trailing `Z`. Event values cannot break the log by introducing newlines or unescaped structural quotes.
- The new event format is distinct from, and does not invalidate, the existing `- run:... task:... stage:... result:... note:"..."` receipt grammar or `propose-task` lines. Existing receipts, late-receipt recovery, proposal processing, and task-file parsing continue to work when audit events are interleaved with them.
- The frontmatter change and its corresponding audit entries are performed through the task-store's serialized/atomic mutation path so a successful extension transition cannot silently omit its audit record. Repeated watcher or late-receipt reconciliation is idempotent and does not duplicate lifecycle events for the same run.
- Existing task body sections, agent-authored receipts, and unrelated frontmatter metadata remain intact. The board's current detail projection continues to show the newest log line, and no new UI or prompt requirement is introduced merely to produce extension-owned audit events.
- Automated tests cover state and status changes through actions and manual moves, stage start/finish and all terminal run outcomes, stop/stale-result protection, late-receipt idempotency, timestamp/event formatting, and compatibility with existing receipt parsing. The PRD and README explain the audit entries and the limitation around direct frontmatter edits.

## Scope
- [ ] `src/model/taskLog.ts` (new) — define the extension-owned audit-event types, UTC timestamp generation, single-line formatter/parser, allowed event kinds (`state-change`, `status-change`, `activity-start`, and `activity-finish`), action/run/outcome fields, and validation/escaping rules. Keep receipt and proposal grammar out of this module so their existing structural prefixes remain unchanged.
- [ ] `src/model/taskStore.ts` — add a serialized, audit-aware transition/mutation operation that reads the prior task values, records only real `state`/`status` changes, appends the corresponding event lines in stable order, and writes the frontmatter/body through the existing atomic-write strategy. Preserve `patch` behavior for non-transition metadata and `appendLog` compatibility for agent receipts/proposals, while preventing extension transition call sites from bypassing the audit path.
- [ ] `src/board/actions.ts` — route `invokeTaskAction` and `moveTask` through the audit-aware store operation, passing the action/manual-move context and preserving all current legality, no-op, status-reset, run-clearing, and body-preservation behavior. Ensure pure gates and stop/reset transitions are logged even though they do not launch an activity.
- [ ] `src/chat/runManager.ts` — record activity start only after a run is admitted and the task is marked `running`, then record one terminal activity finish across receipt success, blocked/failed receipts, timeout, executor failure, missing-receipt fallback, late-receipt recovery, `markRunComplete`, and stop. Reuse existing run-id staleness and receipt de-duplication guards so retries, reload reconciliation, and late file-watcher passes cannot duplicate or reorder lifecycle events; let the shared transition path record resulting state/status changes.
- [ ] `src/extension.ts` — route the remaining extension-owned `store.patch` state write used by sample-task seeding through the same transition API, so there is no production call site that silently changes a task column or runtime status.
- [ ] `src/test/taskLog.test.ts` (new) and `src/test/taskStore.test.ts` — test event formatting/parsing, UTC timestamp shape, safe one-line values, no-op filtering, deterministic ordering, atomic body preservation, and interleaving audit events with existing receipts/proposals.
- [ ] `src/test/stateMachine.test.ts` — extend action and manual-move coverage to assert state/status audit entries for legal transitions, pure gates, stop/reset, same-column moves, invalid moves, and illegal actions.
- [ ] `src/test/runManager.test.ts` — assert activity-start/finish pairs and state/status events for refine, split, develop/continue, and validate success, blocked, failed, timeout, executor-error, missing-receipt, manual-completion, stop, stale-result, reload, and late-receipt paths without weakening existing receipt assertions.
- [ ] `src/test/receiptAndTemplates.test.ts` — add a regression proving audit-event lines can appear around receipts without changing receipt parsing or prompt receipt contracts; do not require agents to emit extension-owned events.
- [ ] `docs/PRD.md` and `README.md` — document `## Log` as the combined append-only audit/receipt channel, define the event examples and timestamp contract, distinguish `state` from `status`, describe activity lifecycle outcomes and idempotency, and state the limitation for direct frontmatter edits.

## Log
- run:rmpni72 task:TASK-003 stage:refine result:ok note:"2026-08-17T10:21:43Z — refined the audit-log requirements, lifecycle coverage, implementation files, compatibility constraints, and direct-edit limitation"
- run:rcasfxs task:TASK-003 stage:develop result:ok note:"2026-08-17T11:11:06Z — implemented the serialized extension-owned audit trail for state, status, and activity lifecycle events; updated tests and documentation; all 166 tests pass"
- run:rzk2atu task:TASK-003 stage:validate result:failed note:"2026-08-17T11:13:24Z — validation failed: npm test reported 77 failures because valid second-precision audit timestamps are rejected by isUtcTimestamp; compile-tests, webpack, and ESLint passed"
- run:r19ux2x task:TASK-003 stage:develop result:ok note:"2026-08-17T11:43:30Z — fixed second-precision audit timestamp validation, added regression coverage for valid and impossible dates, and verified the full suite with 173 passing tests"
- run:r4utv9u task:TASK-003 stage:develop result:ok note:"2026-08-17T11:54:03Z — verified the completed audit-trail implementation and full compile, bundle, lint, and VS Code test suite with 174 passing tests"
- run:r4orf2l task:TASK-003 stage:develop result:ok note:"2026-08-17T11:56:27Z — verified the completed extension-owned audit trail implementation with compile, bundle, lint, and 174 passing VS Code tests"
- run:rgzpn16 task:TASK-003 stage:validate result:ok note:"2026-08-17T22:19:33Z — reviewed the audit implementation, lifecycle and transition coverage, documentation, and compatibility paths; compile-tests, webpack, ESLint, and the full VS Code suite passed with 192 tests"
