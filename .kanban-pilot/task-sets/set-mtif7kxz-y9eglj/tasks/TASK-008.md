---
id: TASK-008
title: Tail Copilot's session transcript into the activity feed behind an opt-in setting
type: feature
state: done
status: idle
position: 4
created: 2026-09-01T09:47:12Z
updated: 2026-09-01T21:54:29Z
chat: kanban-pilot-set-mtif7kxz-y9eglj-TASK-008
scope_hash: 615ac00
chat_reset_required: false
origin_task: TASK-005
---

## Request
Found while investigating response streaming (docs/copilot-response-streaming-spike.md,
finding 1 and recommendation 2).

Copilot Chat writes a structured, append-only event log per session at
`workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl`, with `session.start`,
`user.message`, `assistant.turn_start`/`turn_end`, `assistant.message`, and
`tool.execution_start`/`_complete` entries. It is reachable by path arithmetic from the extension's
own `storageUri` - no proposed API - and every `copilot_session_id` the board records (67 of 67
measured) names a session file.

Scope would be: an opt-in setting, a read-only tail keyed by the task's `copilot_session_id`, a
compatibility gate on the `session.start` header (`version: 1`, `producer: copilot-agent`) that
degrades to no feed rather than misparsing, and a structural projection into the feed built by the
progress-feed work - tool names and turn boundaries, never `assistant.message.content` or
`tool.execution_complete.result`.

Depends on the feed channel existing first. The browser channel must be a separate, separately
consented step from the local detail pane, because that endpoint is shared and token-gated.

_Filed automatically by TASK-005's run rb7t4m._

## Refined

### Problem statement

Copilot writes a structured, append-only event log per session, and Kanban Pilot can read it as an
ordinary file with no proposed API. Four cards have now established what a consumer would actually be
dealing with, and the design has to be built around those facts rather than around the optimistic
reading the original spike had:

- **The lag is bimodal, and the useful half is the slow half.** Assistant events land in under 100 ms;
  `tool.execution_*` events land at a median of ~6 s and up to 53 s, because a tool call's duration
  falls inside the flush window (TASK-009). So this feed is a **record of what happened**, never a
  live indicator, and it must not be presented as one.
- **Session reuse is confirmed** (TASK-011): a repeat run appends to the same file and
  `copilot_session_id` does not change. But that field is written ~2 s after a run's *last* event, so
  it can never key the run that produces it. First run: find the file by watching the directory.
  Later runs: open it directly by id.
- **The header exists only once, at line 0.** A second run appends no new `session.start`, so the
  `version`/`producer` compatibility gate never arrives in the stream — a tail that seeks to the end
  must read line 0 explicitly or it will never see it.
- **There are no run boundaries in the file.** Entries from consecutive runs continue straight on, so
  "this run's activity" is a byte-offset or timestamp slice, not a parse.
- **Transcripts are evicted.** Copilot keeps the newest 20 and deletes older ones on session start, so
  a task's transcript can simply be gone.
- **Only agent-path sessions produce one**, and `kanbanPilot.chat.mode` does not tell you whether the
  agent path was used: `selectedMode = options.agentName?.trim() || options.mode`
  ([executor.ts:351](../src/chat/executor.ts#L351)), so a configured `agentNames` entry silently wins.
  Any gate on `chat.mode` would be reading dead configuration.

The destination already exists. TASK-007 shipped the feed: `parseProgressEntries(log, task.id)`
bounded to the last 20, projected as `task.feed` ([boardPanel.ts:1466](../src/board/boardPanel.ts#L1466)),
rendered as `.activity-feed`, and covered on the browser channel. This card adds a **second source**
to that feed; it does not add a second UI.

One hard constraint inherited from TASK-010: the tail must **never write the task file**. `TaskStore`
does a full read-modify-write and replaces the file through a temp path and a rename, so anything
appended from outside that window is silently lost. The tail therefore feeds the projection in
memory, and the task file stays the extension's alone.

### Acceptance criteria

- A new setting, default **off**, enables the tail. A separate opt-in governs whether tailed entries
  reach the **browser** channel; enabling the local detail pane must not enable the remote surface.
- With the setting off, behaviour is byte-for-byte what it is today: no file watching, no reads, and
  an unchanged feed projection.
- The tail reads line 0 of the transcript and proceeds only when the header is `version: 1` and
  `producer: "copilot-agent"`. An unrecognised header, an absent file, or an unreadable directory
  degrades to **no tailed entries** and a feed that still shows progress lines — never an error
  surfaced to the user and never a failed run.
- A task's **first** run is correlated by watching the transcripts directory; **later** runs open the
  file named by `copilot_session_id` directly. Both paths are covered by tests.
- Only structural fields are retained: event `type`, `timestamp`, and the tool **name** from
  `tool.execution_*`. `assistant.message.content`, `user.message.content`,
  `tool.execution_start.arguments` and `tool.execution_complete.result` are never retained, never
  projected, and never sent to the browser. A test asserts that content planted in a fixture cannot be
  found anywhere in the projection.
- Tailed entries and progress lines appear in one feed ordered by time, bounded consistently with the
  existing 20-entry cap, with tailed entries visibly distinguishable from agent-authored progress
  lines so a reader can tell what is a summary and what is an observation.
- A partially written trailing line is never parsed as an entry; it is held until it completes. None
  were observed in measurement, but the reader handles them.
- Feed entries are labelled in a way that does not imply liveness, given the measured 5–50 s lag on
  tool events.
- Eviction, a missing transcript, and a non-agent run all present as "no tailed activity" rather than
  as a failure.
- The tail is read-only and never writes any task file.
- Existing tests still pass, and the new work is covered by tests that run without Copilot installed.

### Assumptions

- The format is undocumented and unversioned by contract. The `version`/`producer` gate is the whole
  compatibility story, and a future format change is expected to degrade to no feed rather than to a
  misparse.
- Verified against Copilot Chat 0.55.0 on VS Code 1.127.0. Nothing is asserted for other builds.
- The feed's existing 20-entry bound is the right order of magnitude and is not revisited here.
- Hook-based push (TASK-015) is a later optimisation of this feature, not an alternative to it.

## Scope

- Promote the already-tested spike helpers into product code rather than reimplementing them:
  - `sessionRecordPaths`, `isSupportedTranscript`, `carriesContent`, and the event-type constants in
    [`src/spike/chatTranscriptProbe.ts`](../src/spike/chatTranscriptProbe.ts) already encode the path
    arithmetic, the compatibility gate, and the content-bearing event list, with tests.
  - The append-reading and fragment-holding logic in
    [`scripts/watch-transcript.mjs`](../scripts/watch-transcript.mjs) is proven against three live
    sessions; port its behaviour rather than writing a second reader.
- Add `src/chat/transcriptTail.ts`:
  - Read line 0 for the header and gate on it; read only newly appended byte ranges after that.
  - Hold an incomplete trailing line until it completes.
  - Project each entry to `{ type, timestamp, toolName? }` and drop everything else at the parse
    boundary, so content cannot leak by omission downstream.
  - Expose a bounded, time-ordered view for one task.
- Add the correlation logic:
  - First run — watch the transcripts directory and attach to the file that appears.
  - Later runs — open `copilot_session_id` directly, seeking to the end.
  - Slice by byte offset or timestamp for "this run", since the file carries no run boundary.
- Wire the lifecycle to runs in `src/chat/runManager.ts`: start on run start, stop on run end,
  dispose cleanly on window reload and on task deletion, and never leave a watcher running for a task
  that is not executing.
- Extend the feed projection in `src/board/boardPanel.ts`:
  - Union tailed entries with `parseProgressEntries` output instead of reading only the log.
  - Order by time, apply the existing bound, and mark the source of each entry.
  - Gate the browser-bound projection on the separate remote opt-in.
- Declare the settings in `package.json`, and add them to the board Settings editor if that is where
  comparable settings live.
- Tests:
  - Header gate accepts version 1 / `copilot-agent` and rejects anything else.
  - First-run directory correlation and later-run keyed open.
  - Fragment handling across two reads.
  - Content redaction, asserted against planted fixture content.
  - Missing file, evicted transcript, non-agent run, and setting-off all degrade quietly.
  - Feed ordering and bounding across both sources.
- Close out without scope creep:
  - Do not implement hook-based push; that is TASK-015.
  - Do not write to any task file from the tail, and do not change the receipt or progress grammars.
  - Do not change `src/chat/executor.ts` or the mode-resolution behaviour.
  - Confirm by reviewing the diff that only the tail module, the projection, the settings, the
    promoted helpers, their tests, and this task file were touched.

## Log
- audit:state-change at:2026-09-01T11:25:11Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rn4y8s task:TASK-008 at:2026-09-01T12:38:04Z note:"scoping the tail against everything the three measurement cards established"
- run:rn4y8s task:TASK-008 stage:refine result:ok note:"2026-09-01T12:38:57Z — refine completed: scoped the tail as a second read-only source for the existing feed, keyed by directory watch on a first run and by session id after it, with content dropped at the parse boundary"
- audit:state-change at:2026-09-01T12:39:54Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rn4y8s task:TASK-008 at:2026-09-01T12:46:40Z note:"implementation compiles and lints clean; the extension test host is unavailable while another VS Code instance is running"
- run:rn4y8s task:TASK-008 stage:develop result:ok note:"2026-09-01T12:46:40Z — develop completed: added the read-only transcript tail with split first-run and keyed correlation, unioned it into the activity feed behind two opt-ins, and covered it with tests that were written but not executed because the test host requires no other VS Code instance running"
- progress run:rn4y8s task:TASK-008 at:2026-09-01T12:49:16Z note:"tail module, lifecycle wiring, projection, settings and tests are in; verification is stuck on the test host"
- run:rn4y8s task:TASK-008 stage:develop result:blocked note:"2026-09-01T12:49:16Z — develop blocked: the tail, its wiring and thirteen tests are implemented and typecheck and lint clean, but the suite shows one pre-existing-looking failure in late receipt reconciliation and the test host refuses to start while another VS Code instance is open, so the acceptance criterion that existing tests still pass cannot be verified from here"
- progress run:rk8m3f task:TASK-008 at:2026-09-01T12:58:38Z note:"ran the suite against an isolated user data directory so the open editor no longer blocks the test host"
- run:rk8m3f task:TASK-008 stage:develop result:ok note:"2026-09-01T12:58:38Z — develop completed: verification unblocked by giving the test host its own user data directory; the full suite is 393 passing with no failures and the transcript tail suite is 14 passing, so the reported late receipt failure does not reproduce"
- progress run:rn4y8s task:TASK-008 at:2026-09-01T13:39:48Z note:"suite is green at 407 passing; the earlier failure did not reproduce"
- run:rn4y8s task:TASK-008 stage:develop result:ok note:"2026-09-01T13:39:48Z — develop completed: transcript tail wired into the task card with message text shown on the local pane at the user request, tool arguments and results still dropped, remote channel still gated, 407 tests passing"
- audit:state-change at:2026-09-01T21:54:29Z task:TASK-008 from:validation to:done action:move note:"State changed from validation to done via move."
