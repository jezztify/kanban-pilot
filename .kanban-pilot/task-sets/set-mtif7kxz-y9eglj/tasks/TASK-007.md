---
id: TASK-007
title: Wire the existing progress-line grammar into the board and browser feed
type: feature
state: done
status: idle
position: 7
created: 2026-09-01T09:47:12Z
updated: 2026-09-01T21:54:35Z
chat: kanban-pilot-set-mtif7kxz-y9eglj-TASK-007
copilot_session_id: c09a264e-8fc3-4dbf-b67b-6b36b3c14491
scope_hash: bfd303f
chat_reset_required: false
origin_task: TASK-005
---

## Request
Found while investigating response streaming (docs/copilot-response-streaming-spike.md,
recommendation 1).

TASK-003 shipped the progress-line grammar in src/chat/progress.ts, but `parseProgressEntries` has
no caller outside src/test/progress.test.ts. Nothing projects those lines into the board detail pane
or the browser SSE surface, so the agent writes progress that no one can see - the conditional-go
slice from docs/browser-chat-proxy-spike.md is half delivered.

This is the cheapest path to "watch the work happen": the grammar exists, the agent already emits
the lines, the task file is already watched, and it needs no undocumented format at all. It is also
privacy-safe by construction, because the lines are agent-authored summaries rather than raw
payloads.

Doing this first also builds the bounded, re-synced-on-connect feed channel that every richer source
in the spike would need anyway.

_Filed automatically by TASK-005's run rb7t4m._

## Refined

### Problem statement

The `progress` line grammar and `parseProgressEntries` in `src/chat/progress.ts` already exist,
but production `BoardPanel` code never calls the parser. A local user therefore sees only the
latest literal log line in Task Details, while a browser viewer sees card state changes but no
coarse activity between `running` and its terminal outcome. This ticket completes the source-D
conditional-go slice from the two spikes: expose agent-authored summaries, not a mirror of the
private Copilot transcript.

### Prototype goal and assumptions

- Add a bounded `feed` array to the existing selected-task detail projection. It contains at most
	the latest `K = 20` valid entries, oldest first, and keeps the existing `runId`, `taskId`, `at`,
	and `note` fields.
- Reuse the existing TypeScript/DOM board implementation, `TaskStore` file watching, and
	`BrowserBoardSurface` session stream. The canonical flow is task Markdown `## Log` →
	`BoardPanel.pushDetail()` → `task/detail` → editor webview or browser `/session/events`.
- A reconnect re-reads the task file through the existing `attach()`/visibility refresh path.
	Do not add an `event: chat` frame to `/api/events`, a second projection/store, or a durable
	replay buffer; the feed is bounded current state, not a token stream.
- The grammar, receipt/audit separation, and agent emission contract are already shipped. This
	ticket consumes `parseProgressEntries` and does not change that contract, add a setting, or add
	a dependency.

### Acceptance criteria

1. The selected task's `task/detail` payload contains only that task's valid progress entries,
	 capped at 20 and ordered oldest to newest; older entries remain in the Markdown log.
2. Malformed lines, invalid `at:` timestamps, and lines whose `task:` does not match are absent,
	 and progress lines still cannot satisfy receipt or audit parsing.
3. Appending a valid line to a selected task refreshes the local detail and an already-connected
	 browser through the existing watcher/change path without a manual reload.
4. A browser connecting or reconnecting after the lines were written receives the same current
	 feed over its normal board session stream.
5. The detail view renders timestamp and note as escaped, read-only text with no action controls.
	 A blocked task includes clear copy that approval/action is required at the VS Code host.
6. No transcript content, tool payload, source, secret, or new remote action is introduced.

### Deferred work and risk

Full transcript/session-file tailing, token streaming, redaction, an explicit feed opt-in, remote
approval actions, and a dedicated API-consumer SSE channel remain follow-ups. The shared bearer
token means notes must remain summary-shaped; the implementation must escape them and must not
pretend that a browser can resolve a blocked Copilot confirmation. No blocker is known for this
bounded file-backed slice.

## Scope

- [ ] `src/board/boardPanel.ts` — import and invoke `parseProgressEntries` while building the
	selected task detail, slice the result to the last 20 entries, and add it as `feed` without
	changing the existing `lastLog` or task-file contents.
- [ ] `src/board/boardPanel.ts` — extend the normal detail-modal renderer with a compact Activity
	section showing each entry's timestamp and note in file order, an empty state when there are no
	entries, and a read-only host-action message for `status: blocked`; create text nodes or use the
	existing escaping-safe helper rather than injecting authored notes as HTML.
- [ ] `src/http/realtimeBoardServer.ts` and `src/http/browserBoardSurface.ts` — verify the existing
	`/session/events` default `data:` message path carries the new `task/detail.feed` on initial
	selection, live task-file refresh, and reconnect. Keep `/api/events` board-snapshot-only, retain
	the existing outbox bound, and do not introduce a named chat event or server replay buffer.
- [ ] `src/test/boardPanel.test.ts` — cover the detail projection's per-task isolation, 20-entry
	cap, ordering, live refresh, safe read-only rendering, and blocked-host copy.
- [ ] `src/test/realtimeBoardServer.integration.test.ts` — cover a browser session receiving the
	feed on its normal SSE stream after initial sync and after a task-log change/reconnect, while
	preserving the existing authentication and board-event behavior.
- [ ] `src/test/progress.test.ts` — retain the existing grammar and receipt/audit non-collision
	coverage; do not redesign or duplicate the already-shipped parser.
- [ ] Keep this slice free of transcript scraping, new settings, dependencies, prompt changes,
	frontmatter/Request edits, and unrelated board or transport refactors.

Planned verification: `npm run compile-tests`, `npm run compile`, `npm run lint`, and `npm test`;
smoke-test a valid log append, the 21-entry cap, a malformed/misrouted line, and a browser
reconnect while the task is selected.

## Log
- audit:state-change at:2026-09-01T11:49:25Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-01T11:49:28Z task:TASK-007 from:idle to:running action:refine run:re0ex91 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-01T11:49:28Z task:TASK-007 stage:refine action:refine run:re0ex91 note:"Started refine activity."
- progress run:re0ex91 task:TASK-007 at:2026-09-01T11:50:32Z note:"reviewing the feed projection boundaries"
- run:re0ex91 task:TASK-007 stage:refine result:ok note:"2026-09-01T11:55:26Z — documented the bounded board and browser progress-feed scope"
- audit:status-change at:2026-09-01T11:56:48Z task:TASK-007 from:running to:idle action:receipt run:re0ex91 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T11:56:48Z task:TASK-007 stage:refine action:receipt run:re0ex91 outcome:ok note:"2026-09-01T11:55:26Z — documented the bounded board and browser progress-feed scope"
- audit:state-change at:2026-09-01T11:57:05Z task:TASK-007 from:refine to:scoped action:apply-pending run:re0ex91 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-01T11:57:15Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T11:57:38Z task:TASK-007 from:approved to:in-progress action:develop run:rpe7dwi note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-01T11:57:38Z task:TASK-007 from:idle to:running action:develop run:rpe7dwi note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-01T11:57:38Z task:TASK-007 stage:develop action:develop run:rpe7dwi note:"Started develop activity."
- progress run:rpe7dwi task:TASK-007 at:2026-09-01T11:58:30Z note:"preparing the bounded progress-feed implementation"
- progress run:rpe7dwi task:TASK-007 at:2026-09-01T12:15:36Z note:"running focused feed and browser surface checks"
- receipt-diagnostic kind:run-mismatch task:TASK-007 expected-run:rpe7dwi expected-stage:develop actual-run:re0ex91 actual-task:TASK-007 actual-stage:refine note:"Ignored receipt because run id re0ex91 is stale; expected rpe7dwi."
- run:rpe7dwi task:TASK-007 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-01T12:17:39Z task:TASK-007 from:running to:failed action:timeout run:rpe7dwi outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-01T12:17:39Z task:TASK-007 stage:develop run:rpe7dwi outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- run:rpe7dwi task:TASK-007 stage:develop result:ok note:"2026-09-01T12:19:05Z — implemented the bounded progress feed in board detail and browser session delivery"
- audit:status-change at:2026-09-01T12:19:10Z task:TASK-007 from:failed to:idle action:late-receipt run:rpe7dwi outcome:ok note:"Status changed from failed to idle via late-receipt."
- audit:activity-finish at:2026-09-01T12:19:10Z task:TASK-007 stage:develop action:late-receipt run:rpe7dwi outcome:ok correction:true note:"2026-09-01T12:19:05Z — implemented the bounded progress feed in board detail and browser session delivery"
- audit:state-change at:2026-09-01T21:54:35Z task:TASK-007 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
