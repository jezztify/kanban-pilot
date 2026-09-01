---
id: TASK-009
title: Confirm transcript timing by observing one instrumented live Copilot run
type: feature
state: done
status: idle
position: 2
created: 2026-09-01T09:47:12Z
updated: 2026-09-01T11:24:51Z
scope_hash: f39dcbf
chat_reset_required: false
origin_task: TASK-005
---

## Request
Found while investigating response streaming (docs/copilot-response-streaming-spike.md,
evidence matrix).

Every timing claim in that spike is read from the writer's code, not measured. The transcript's
`flush()` is called at prompt render and before hook execution, which implies entries appear at
roughly model round-trip granularity - but no live turn was watched, so the practical question "how
far behind the chat panel would a tail actually be" is unanswered, and so is whether a partially
written line is ever observable mid-append.

Run one stage from the board with a watcher on the session's transcript file, and record: latency
from a visible panel event to the corresponding transcript entry, whether entries ever arrive
truncated, and whether the file appears at all for a non-agent-mode run.

This is the one medium-confidence row in the spike's evidence matrix, and it gates how much the
transcript tail can honestly promise.

_Filed automatically by TASK-005's run rb7t4m._

## Refined

### Problem statement

`docs/copilot-response-streaming-spike.md` recommends tailing Copilot's session transcript, and its
evidence matrix carries exactly one medium-confidence row: *"A tail of the transcript is enough for a
useful feed — inference from the event vocabulary — not demonstrated end to end."* Every timing claim
in that document was read from the writer's code. `flush()` is called at prompt render and before
hook execution, which *implies* entries land at roughly model round-trip granularity, but no run was
ever watched. Until that is measured, TASK-008 cannot honestly say how far behind the chat panel its
feed would run.

Two things make this cheap rather than fiddly:

- **No stopwatch is needed.** Every transcript line carries its own `timestamp`, stamped in
  `_bufferEntry` when the event occurs — not when it is flushed. So the flush lag is
  `observed append time − entry timestamp`, computed from the file alone. The measurement is
  objective and needs no human reference clock or panel instrumentation.
- **No extension host is needed.** The transcript is a plain file. A standalone Node watcher can
  measure it while a stage runs from the board, which is why this does not belong in `src/spike/`.

There is also a second question that turns out to gate TASK-008 harder than timing does, and it
should be settled by the same run: **do Kanban Pilot's own stage runs produce a transcript at all?**
The writer stamps `producer: "copilot-agent"`, and `kanbanPilot.chat.mode` defaults to `agent`
(`package.json`), so they should. "Should" is precisely what this card exists to remove — and if the
answer is no for some mode, TASK-008's opt-in has to say so.

A third, practical finding to confirm: `copilot_session_id` is harvested from the turn's terminal
result (`src/chat/executor.ts:424`), so it does not exist until a task's **first** run has finished.
A watcher cannot address the file by name before then, which means the harness must watch the
*directory* and correlate afterwards. TASK-008's design inherits this.

This card is a measurement, not a build. It changes no product behaviour. Unlike the read-only spikes
that preceded it, it **does consume a real Copilot turn** — that is inherent to the question and is
stated up front rather than discovered.

### Acceptance criteria

- A dated **Measurement** section is appended to `docs/copilot-response-streaming-spike.md` — the
  same document the claim lives in, not a new one — recording VS Code and Copilot Chat versions, the
  task and stage exercised, the configured `kanbanPilot.chat.mode`, and how many runs were observed.
- The evidence-matrix row *"A tail of the transcript is enough for a useful feed"* is updated from
  Medium to the measured result, or is explicitly recorded as still unsettled with the reason.
- Flush lag is reported as a distribution — minimum, median, maximum, and sample count — computed as
  observed append time minus each entry's own `timestamp`, not as a single anecdotal number.
- The report states whether a partially written line was ever observed: a trailing fragment with no
  newline, or a line that failed to parse on one read and parsed on a later one. A count of zero is a
  result and must be stated as one.
- The report states whether a transcript file was created for a Kanban Pilot stage run at the default
  `agent` mode, and what was observed for a non-agent mode if that can be tested without a second
  paid run.
- The delay between the turn visibly finishing in the panel and the final transcript entry landing is
  reported separately from the in-turn lag, since a feed's last update matters as much as its first.
- The harness records only structural fields — event `type`, entry `timestamp`, observation time, byte
  offsets, sizes, counts. It never records `data`, message content, or tool arguments, so its raw
  output is safe to paste into the document.
- The harness has automated tests that run without Copilot and without launching VS Code, covering
  lag computation, partial-line detection, per-type counting, and the guarantee that no content field
  reaches the output.
- No production source file is modified. The only `package.json` change permitted is adding the
  harness's test script; no contributed setting, command, or behaviour changes. The existing test
  suite still passes.
- If the measurement contradicts the spike's recommendation, the recommendation section is corrected
  rather than left standing, and any resulting work is filed as separate tasks rather than done here.

### Assumptions

- The measurement runs on this machine: VS Code 1.127.0 with the built-in GitHub Copilot Chat 0.55.0,
  signed in. A result is recorded as holding for those builds, not generalised.
- One real Copilot turn will be consumed. It should be spent on an existing stage run that was going
  to happen anyway, or on a throwaway task in a scratch task set — not on inventing work to measure.
- "Useful feed" is judged against the activity-feed granularity TASK-007 builds, not against
  token-level mirroring, which the spike already rules out.

## Scope

- Add `scripts/watch-transcript.mjs`, a standalone Node watcher — no `vscode` import, so it runs
  beside a live VS Code rather than inside it:
  - Take the transcripts directory as an explicit argument
    (`workspaceStorage/<ws>/GitHub.copilot-chat/transcripts`), so nothing has to guess the workspace
    hash, plus an optional session id to filter to one file.
  - Watch the directory rather than a single file, because a task's first run has no
    `copilot_session_id` yet; report which file(s) grew during the observation window.
  - On each growth, read only the newly appended byte range, split complete lines, and for each line
    record: observation wall-clock time, byte offset, event `type`, the entry's own `timestamp`, and
    the computed lag. Discard everything else — never retain `data`.
  - Detect and count partial lines: a trailing fragment with no newline, and a fragment that later
    completes.
  - Print a summary on exit: per-type counts, lag min/median/max with sample count, partial-line
    count, first and last entry times, and total bytes appended.
- Add `scripts/watch-transcript.test.mjs`, run with `node --test` following the
  `scripts/install-skill.test.mjs` precedent:
  - Drive the parsing and summarising logic over a synthetic `.jsonl` written into a temporary
    directory, with no Copilot and no VS Code involved.
  - Cover lag computation against known timestamps, partial-line detection across two reads,
    per-type counting, and an assertion that no `data`/content field appears anywhere in the output.
- Add a `test:watch-transcript` npm script alongside the existing `test:install-skill`, and leave
  every other `package.json` entry untouched.
- Run the measurement itself:
  - Record the host facts first: VS Code version, Copilot Chat version, `kanbanPilot.chat.mode`.
  - Start the watcher on the transcripts directory, run one stage from the board, and stop the
    watcher after the turn visibly completes in the panel.
  - Note the wall-clock moment the panel showed the turn finishing, so the tail-end delay can be
    reported separately from the in-turn lag.
  - Confirm whether a transcript file appeared for the run, and capture the `session.start` header's
    `version` and `producer` for that file.
- Write up the result:
  - Append a dated Measurement section to `docs/copilot-response-streaming-spike.md` with the
    numbers, the method, and the sample size.
  - Update the evidence-matrix row for the transcript-tail claim to the measured confidence.
  - Say plainly which of the three questions — in-turn lag, tail-end delay, partial lines — the run
    actually answered, and which it did not.
- Close out without scope creep:
  - Do not implement any tail, feed, projection, or setting; that is TASK-008.
  - Do not modify `src/chat/executor.ts`, `src/chat/runManager.ts`, `src/chat/progress.ts`,
    `src/board/boardPanel.ts`, `src/http/realtimeBoardServer.ts`, or any contributed setting.
  - File anything the measurement reveals as separate tasks via the proposal flow.
  - Confirm by reviewing the diff that only the harness, its test, the npm script line, the spike
    document, and this task file were touched.

## Log
- audit:state-change at:2026-09-01T10:08:24Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:state-change at:2026-09-01T10:09:40Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rm6h2p task:TASK-009 at:2026-09-01T10:09:40Z note:"working out how the timing can be measured objectively before scoping the harness"
- run:rm6h2p task:TASK-009 stage:refine result:ok note:"2026-09-01T10:10:36Z — refine completed: scoped a one-run measurement of transcript flush lag using each entry own timestamp as the reference clock, plus a standalone watcher and its tests"
- audit:state-change at:2026-09-01T10:12:09Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T10:12:55Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rt9w5k task:TASK-009 at:2026-09-01T10:12:55Z note:"building the standalone transcript watcher and its tests"
- progress run:rt9w5k task:TASK-009 at:2026-09-01T10:15:18Z note:"watcher and its eleven tests are green and it runs clean against the real transcripts directory"
- run:rt9w5k task:TASK-009 stage:develop result:blocked note:"2026-09-01T10:15:18Z — develop blocked: the watcher, its eleven tests, and the npm script are done, but the measurement needs a stage run started from the board in VS Code, which consumes a real Copilot turn and cannot be initiated from here"
- progress run:rc4n8j task:TASK-009 at:2026-09-01T11:14:51Z note:"captured seventy entries from a live agent session; writing the measurement up and correcting the claims it contradicts"
- propose-task run:rc4n8j type:feature title:"Confirm a board-started stage run writes a Copilot transcript" note:"the observed session was never claimed by a task file so the board-driven case is still unproven"
- run:rc4n8j task:TASK-009 stage:develop result:ok note:"2026-09-01T11:16:07Z — develop completed: measured 70 entries from a live agent session, wrote the Measurement section, and corrected the finding, matrix row, decision line and recommendation the numbers contradicted"
- audit:state-change at:2026-09-01T11:24:51Z task:TASK-009 from:validation to:done action:move note:"State changed from validation to done via move."
