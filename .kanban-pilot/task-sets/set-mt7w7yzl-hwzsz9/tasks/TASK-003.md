---
id: TASK-003
title: Browser activity feed: agent-emitted progress lines over SSE
type: feature
state: done
status: idle
position: 3
created: 2026-08-26T00:10:02Z
updated: 2026-08-26T05:41:12Z
chat: 2fd04e6f-6848-4c97-b3d7-055a1c49280d
copilot_session_id: 2fd04e6f-6848-4c97-b3d7-055a1c49280d
scope_hash: 71a9f89
chat_reset_required: false
origin_task: TASK-002
origin_run: revfa49
origin_proposal: 95188f39633fd4d0c7f0015e
---

## Request
Build the recommended smallest slice from the spike: progress log grammar + event:chat channel + read-only feed

_Filed automatically by TASK-002's run revfa49._

## Refined

### Problem
A remote viewer of the browser board ([`RealtimeBoardServer`](../../../../src/http/realtimeBoardServer.ts) →
[`BrowserBoardSurface`](../../../../src/http/browserBoardSurface.ts)) sees a task card flip
`running` → `done`/`blocked` but has **zero visibility into the work in between**. The
spike ([browser-chat-proxy-spike.md](../../../../docs/browser-chat-proxy-spike.md)) ruled
out mirroring the full Copilot transcript (sources A/C blocked, B fragile + a privacy
regression on a shared token-gated HTTP surface) and recommended **source D — a coarse,
agent-emitted activity feed** as the smallest viable slice. This ticket builds exactly that
slice and nothing more.

### What we are building
1. **A `progress` line in the `## Log` grammar** the agent may optionally append *during* a
   run, before its terminal receipt — a human/agent-authored one-line summary
   (e.g. "editing `foo.ts`", "running tests", "waiting for approval in VS Code"), never a
   raw payload.
2. **A bounded, read-only feed** projected to the browser board from those lines, re-synced
   whenever a viewer connects (so a late/reconnecting browser sees the current feed, not a
   delta log — same "re-read current state on connect" property `publish()` already relies
   on).
3. **Rendering** of that feed in the card detail view, read-only, honest about `blocked`
   (surfaces "action required at the host — cannot be actioned from the browser").

### Deliberately out of scope
- Full/token-level transcript mirroring, streaming, markdown/tool-card rendering (spike no-go).
- Any new private-API or on-disk-session-file reading (sources A/B/C).
- Making the feed *actionable* remotely (approval buttons) — the feed is read-only by design.
- A durable server-side replay buffer / new `OUTBOX_LIMIT`-style bound — the feed is bounded
  to the last K entries and re-derived from the task file on connect.

### Design decisions (smallest-slice choices; flagged where a reviewer may differ)
- **Grammar.** Add one new `## Log` line kind, sibling to the receipt grammar
  ([receipt.ts](../../../../src/chat/receipt.ts)) and the audit grammar
  ([taskLog.ts](../../../../src/model/taskLog.ts)):
  `- progress run:<runId> task:<taskId> at:<utc> note:"<free text>"`.
  It reuses the existing token rules (`run:`/`task:` as in receipts, `at:` UTC-second
  precision + double-quoted single-line `note:"…"` as in audit lines). It is **not** a
  receipt (no `stage`/`result`), so it never terminates a run, and it is rejected/ignored if
  its `task:` disagrees with the file it is found in (same misroute containment as receipts).
- **Transport.** Deliver the feed to the board webview as a bounded array folded into the
  existing `task/detail` projection ([boardPanel.ts](../../../../src/board/boardPanel.ts)
  `detailFor()` already reads the `Log` section), rather than inventing a raw `event: chat`
  frame on the per-session board stream — the browser bridge forwards only default `data:`
  frames to `postMessage`, so a named SSE event would not reach the board document without
  extra bridge wiring. This reuses the refresh-on-connect path
  (`onDidBecomeVisible` → full projection) for free re-sync and works identically in the
  editor and the browser. *(The spike floated a dedicated `event: chat` channel on the
  REST `/api/events` stream; that remains a valid future addition for API consumers but is
  not needed for this browser slice.)*
- **Bound.** Feed carries at most the last **K = 20** `progress` lines for the selected task,
  newest last; older lines are dropped from the projection (the file keeps them).

### Acceptance criteria
1. A `progress` line matching the grammar above, appended by hand to a task's `## Log`, is
   parsed into a feed entry `{ runId, taskId, at, note }`; a malformed line, or one whose
   `task:` mismatches the file, produces **no** entry and does **not** affect receipt/audit
   parsing.
2. A `progress` line never satisfies receipt detection: `findReceipt()` still requires a
   `stage`+`result` receipt line, so emitting progress lines cannot complete a run.
3. When a task is selected on the board, its detail projection includes a bounded (≤ K) list
   of that task's progress entries, oldest→newest, and no other task's entries.
4. Appending a `progress` line to the running task's file updates the feed on an
   already-connected browser (via the existing file-watch → `onDidChange` → refresh path)
   without a manual reload.
5. A browser that connects *after* progress lines were written receives the current feed on
   connect (re-derived from the file), i.e. no dependency on having been connected when the
   line was written.
6. The feed is rendered read-only in the card detail (no inputs/buttons that imply the remote
   viewer can act); a `blocked` status is shown with copy that directs the human to the host.
7. The agent prompt/skill contract instructs agents that progress lines are **optional
   summaries** (no source, secrets, paths, tokens) and are not a substitute for the terminal
   receipt.
8. Existing tests stay green; new unit tests cover the grammar parser (valid, malformed,
   task-mismatch, receipt-non-collision) and the detail-projection feed cap/ordering.

### Open questions (assumptions taken; confirm if wrong)
- Feed cap **K = 20** and grammar token set (`at:` included) assumed; adjust if the reviewer
  wants a different bound or a leaner line.
- Feed lives **inside the card-detail view** (matches the spike's "under the card detail"),
  not as an always-visible per-column strip.
- No new user-facing opt-in setting in this slice (the endpoint is already gated behind
  `httpEndpoint.enabled` + token); a dedicated redaction/opt-in setting is deferred to a
  follow-up.

## Scope

A developer can work through these in order. Everything is additive; no existing grammar or
projection field is removed.

1. **Progress-line grammar + parser.** Add a small module (e.g. `src/chat/progress.ts`)
   beside [receipt.ts](../../../../src/chat/receipt.ts):
   - `export interface ProgressEntry { runId: string; taskId: string; at: string; note: string }`.
   - A `PROGRESS_LINE` regex mirroring `RECEIPT_LINE`/`AUDIT_LINE` style:
     `^-\s*progress\s+run:(\S+)\s+task:(\S+)\s+at:(\S+)\s+note:"([^"]*)"\s*$`.
   - `parseProgressEntries(logSection: string, taskId: string): ProgressEntry[]` — parses in
     file order, drops lines whose `task:` ≠ `taskId` and lines with a non-UTC `at:` (reuse
     the timestamp validation approach from [taskLog.ts](../../../../src/model/taskLog.ts)).
   - Optional `formatProgressLine(entry)` helper for symmetry/tests.
2. **Do not disturb receipts/audits.** Confirm (with a test) that a `progress` line does not
   match `RECEIPT_LINE` in [receipt.ts](../../../../src/chat/receipt.ts) nor `AUDIT_LINE` in
   [taskLog.ts](../../../../src/model/taskLog.ts), so `findReceipt()`/`parseAuditEvents()`
   are unaffected.
3. **Detail projection feed.** In [boardPanel.ts](../../../../src/board/boardPanel.ts)
   `detailFor()`, after it reads the `Log` section, compute
   `feed = parseProgressEntries(log, task.id).slice(-K)` (K = 20) and add it to the returned
   `task/detail` payload (e.g. `feed: [{ at, note }]`). Keep it bounded and per-task.
4. **Detail rendering (read-only).** In the webview script's `renderDetail(task)`
   ([boardPanel.ts](../../../../src/board/boardPanel.ts) ~line 3716), render `task.feed` as a
   compact read-only list (timestamp + note), newest last, with an empty state when absent.
   When `task.status === 'blocked'`, show an honest "action required at the host" note. No
   inputs/buttons. Escape note text (no raw HTML).
5. **Live update + re-sync verification.** No new transport is required: the task file-watch
   in [taskStore.ts](../../../../src/model/taskStore.ts) `watch()` already fires
   `onDidChange`, driving the board refresh that re-posts `task/detail`; the
   `onDidBecomeVisible` → full-projection path in
   [browserBoardSurface.ts](../../../../src/http/browserBoardSurface.ts) `attach()` already
   re-syncs a reconnecting browser. Verify both cover the feed; only wire additions if a gap
   is found.
6. **Agent contract.** Update the prompt/skill guidance so agents know the optional
   `progress` line exists and its rules (summaries only; never source/secrets/paths; not a
   receipt): [promptTemplates.ts](../../../../src/chat/promptTemplates.ts) and the installed
   skill copy driven by [install-skill.mjs](../../../../scripts/install-skill.mjs) /
   the skill markdown it installs.
7. **Tests.**
   - New `src/test/progress.test.ts`: valid line → entry; malformed line → none;
     `task:` mismatch → none; bad `at:` → none; a `progress` line does not produce a receipt
     (`findReceipt` still undefined) or an audit event.
   - Extend [boardPanel.test.ts](../../../../src/test/boardPanel.test.ts): detail projection
     includes `feed`, capped at K, ordered oldest→newest, isolated per task.
   - Optionally extend [realtimeBoardServer.test.ts](../../../../src/test/realtimeBoardServer.test.ts)
     to assert a browser session's detail projection carries the feed after a file change.
8. **Docs.** Note the new `progress` `## Log` line kind and the read-only feed in
   [PRD.md](../../../../docs/PRD.md) (grammar section) so the grammar stays documented; link
   back to the spike's source-D recommendation.

## Log
- audit:state-change at:2026-08-26T04:25:26Z task:TASK-003 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T04:25:27Z task:TASK-003 from:idle to:running action:refine run:r7zzam0 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T04:25:27Z task:TASK-003 stage:refine action:refine run:r7zzam0 note:"Started refine activity."
- run:r7zzam0 task:TASK-003 stage:refine result:ok note:"Scoped source-D activity feed: new 'progress' Log line + parser, bounded per-task feed folded into task/detail projection (re-synced on connect), read-only render, agent contract + tests."
- audit:status-change at:2026-08-26T04:28:33Z task:TASK-003 from:running to:idle action:receipt run:r7zzam0 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T04:28:33Z task:TASK-003 stage:refine action:receipt run:r7zzam0 outcome:ok note:"Scoped source-D activity feed: new 'progress' Log line + parser, bounded per-task feed folded into task/detail projection (re-synced on connect), read-only render, agent contract + tests."
- audit:state-change at:2026-08-26T04:30:10Z task:TASK-003 from:refine to:scoped action:apply-pending run:r7zzam0 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T04:30:12Z task:TASK-003 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T04:30:15Z task:TASK-003 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T04:30:15Z task:TASK-003 from:idle to:running action:develop run:rhufgz6 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T04:30:15Z task:TASK-003 stage:develop action:develop run:rhufgz6 note:"Started develop activity."
- run:rhufgz6 task:TASK-003 stage:develop result:ok note:"2026-08-26T04:39:40Z — develop completed: added src/chat/progress.ts grammar+parser, folded bounded K=20 per-task feed into task/detail with read-only blocked-honest render, documented progress line in prompts/SKILL/PRD; new progress.test.ts + boardPanel feed tests, full suite 336 passing."
- audit:status-change at:2026-08-26T04:40:09Z task:TASK-003 from:running to:idle action:receipt run:rhufgz6 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T04:40:09Z task:TASK-003 stage:develop action:receipt run:rhufgz6 outcome:ok note:"2026-08-26T04:39:40Z — develop completed: added src/chat/progress.ts grammar+parser, folded bounded K=20 per-task feed into task/detail with read-only blocked-honest render, documented progress line in prompts/SKILL/PRD; new progress.test.ts + boardPanel feed tests, full suite 336 passing."
- audit:state-change at:2026-08-26T04:44:00Z task:TASK-003 from:in-progress to:validation action:apply-pending run:rhufgz6 outcome:ok note:"State changed from in-progress to validation via apply-pending."
- audit:state-change at:2026-08-26T05:41:12Z task:TASK-003 from:validation to:done action:move note:"State changed from validation to done via move."
