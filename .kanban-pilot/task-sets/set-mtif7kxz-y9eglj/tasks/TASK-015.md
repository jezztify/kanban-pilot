---
id: TASK-015
title: Build the hook spool receiver behind the activity feed
type: feature
state: done
status: idle
position: 8
created: 2026-09-01T12:36:29Z
updated: 2026-09-01T21:54:36Z
scope_hash: b229616
chat_reset_required: false
origin_task: TASK-010
---

## Request
Found while designing the hook feed (docs/copilot-hook-feed-design.md, recommendation 2).

If the hook feed is built, the receiver is the part that carries the risk and should be built first:
a watcher over a workspace-local spool file that merges entries into the feed projection and
truncates the spool.

The design's key constraint is why this exists at all: appending to the task file from an external
process loses data, because `TaskStore` does a full read-modify-write and `writeAtomic` replaces the
file through a temp path and a rename, so an append landing between the read and the rename is
discarded. Keeping every task-file write inside the extension is the property the spool preserves.

Depends on TASK-008 shipping first - per the design's recommendation 1, latency is an optimisation of
a feature that does not exist yet. Also needs `boardPanel.ts` to union spool entries with the
log-derived ones rather than reading only `parseProgressEntries`.

_Filed automatically by TASK-010's run rh2b9x._

## Refined

### Problem statement

The goal this card serves is **the browser board keeping up with a run in real time**. That reframes
it from the optimisation TASK-010 filed it as, and it changes the priority: hooks are not a nicer
version of the transcript tail, they are the only source that can meet the requirement at all.

Where the two shipped sources actually stand against "real time":

| Source | Latency | Coverage |
| --- | --- | --- |
| Agent progress lines (TASK-007) | immediate — written when the agent acts, and already delivered on initial, live and reconnect session streams | only what the agent chooses to narrate |
| Transcript tail (TASK-008) | **~6 s median, 53 s worst** on tool events | every tool call and turn, but late |
| **Hooks (this card)** | fires *at* the event | every tool call and turn, as it happens |

The transcript cannot be made faster by polling harder: at the moment a tool runs, the entry is still
in Copilot's buffer and is not on disk until the next prompt render (TASK-009). TASK-008 is therefore
a backfill layer, and this card is the real-time one.

TASK-010 verified the mechanism and settled the hard design questions, so this card is a build rather
than an investigation. What it inherits:

- Hooks are Claude Code hooks, configured in `.claude/settings.json`,
  `.claude/settings.local.json`, or `~/.claude/settings.json`. `settings.local.json` is
  workspace-scoped and conventionally untracked, so installing one need not be shared with the team.
- Eight events are dispatched by the editor. The chosen set is **`UserPromptSubmit`** (turn start and
  the session-to-task mapping), **`PostToolUse`** (activity), **`Stop`** (turn end).
- The payload arrives on **stdin** as JSON: `hook_event_name`, `session_id`, `transcript_path`,
  `timestamp`, plus event extras.
- **A hook must never write the task file.** `TaskStore` does a full read-modify-write and replaces
  the file through a rename, so an external append during a run is silently lost. That is why this is
  a spool.
- `UserPromptSubmit` carries the prompt, and every Kanban Pilot prompt opens with
  `## [{{projectName}} {{id}}]`, so the hook can pair a task id with a session id at turn start —
  including on a first run, where `copilot_session_id` does not exist yet.

Two problems are new to this card and are the substance of the work.

**The browser will not update on its own.** The feed reaches the browser because a task-file change
fires `host.onDidChange`, and `realtimeBoardServer` republishes the projection on that event. A spool
write changes no task file, so nothing publishes. The receiver has to raise a change itself, or the
data will sit in memory and the remote viewer will see nothing — which is the entire point of the
card.

**Hooks and the transcript tail will report the same events twice**, seconds apart: the hook at the
moment of the tool call, the tail 6–53 s later. Without a rule, a viewer sees every tool call
duplicated at a random interval. The feed needs one source of truth per event.

### Acceptance criteria

- A hook installed per the design writes one JSON line per event to a workspace-local spool, and the
  extension surfaces those entries in the activity feed **on the browser** without a task-file write
  and without any user interaction.
- **Latency is measured, not assumed.** The end-to-end delay from a tool call to the entry appearing
  in a browser session stream is recorded, using the same method as TASK-009 — an observed arrival
  time against the event's own timestamp. "Real time" means this number is reported, and it is
  seconds or better rather than the transcript's tens of seconds.
- The receiver raises a change that causes `realtimeBoardServer` to republish, so a connected browser
  updates without polling and a reconnecting one re-syncs, matching how progress lines already behave.
- **No event is shown twice.** When hook entries are available for a session, the tailed transcript
  entries covering the same events are suppressed, so each tool call appears once. The rule is
  explicit and tested, including the boundary where hooks stop mid-run.
- The hook is **fail-open by construction**: it always exits 0, never emits `continue: false` or a
  `stopReason`, sets an explicit short `timeout` rather than the 30 s default, sets `cwd` explicitly
  rather than inheriting the home directory, and does nothing harmful when the extension is not
  running or the spool is unwritable.
- Only structural data is written: event name, session id, task id, tool **name**, timestamps. Never
  tool arguments, tool output, or prompt text beyond the task marker. A test plants content in a hook
  payload and asserts it cannot be found in the spool or the projection.
- The spool is bounded and self-healing: the receiver truncates what it has consumed, a spool left
  behind by a run that ended is cleaned up, and an unbounded or corrupt spool cannot grow without
  limit or wedge the feed.
- Installation is explicit: a command shows the exact JSON and the exact file it will modify, and
  writes nothing without confirmation. Uninstalling is documented and leaves no residue beyond a
  spool the receiver removes.
- The feed source is opt-in and off by default; the existing browser opt-in governs whether hook
  entries leave the machine, and its description is updated to cover both sources rather than
  transcripts alone.
- Existing tests still pass, and the new work is covered by tests that run without Copilot installed.

### Assumptions

- Verified against Copilot Chat 0.55.0 on VS Code 1.127.0. The hook payload and dispatch set are as
  TASK-010 recorded them.
- The per-event process spawn is accepted: TASK-007's own run made 340 tool calls in 30 minutes, so
  `PostToolUse` alone is roughly 340 spawns, about 4% overhead on Windows. A `matcher` narrower than
  `*` is the mitigation if that proves too costly.
- Approval moments stay out of reach: `PermissionRequest` is configurable but never dispatched by the
  editor (TASK-014). Nothing here can surface "waiting for approval" live.
- At roughly one event every few seconds the existing full-projection republish is adequate. A
  separate bounded SSE channel is only needed if granularity later increases.

## Scope

- Add the hook script Kanban Pilot ships, as a dependency-free Node script:
  - Read the JSON payload from stdin, extract only `hook_event_name`, `session_id`, `timestamp`, the
    tool name for `PostToolUse`, and the task id parsed from the prompt for `UserPromptSubmit`.
  - Append one JSON line to the spool, create it if absent, and cap its size.
  - Wrap everything so that **every** path exits 0, including unwritable spool, malformed stdin, and
    an absent workspace.
  - Keep it invocable as `node "<path>"`, which behaves the same under the PowerShell wrapper Copilot
    uses on Windows.
- Define the spool contract:
  - Location `.kanban-pilot/.hook-spool.jsonl`, and add it to `.gitignore` — note that the repository
    currently has `.kanban-pilot/` **commented out**, so task files are tracked and the spool would be
    too unless excluded.
  - One JSON object per line, structural fields only, with a schema version so a stale hook and a new
    receiver can disagree safely.
- Add the receiver, alongside `src/chat/transcriptTail.ts` and following its shape:
  - Watch the spool, parse appended lines, hold partial lines, and ignore anything that fails the
    schema-version check.
  - Maintain the session-to-task map from `UserPromptSubmit` entries, and attribute later events by
    `session_id`.
  - Keep a bounded per-task buffer, truncate the consumed prefix of the spool, and remove a spool with
    no live run.
- Make the browser update:
  - Raise a change through the same path `realtimeBoardServer` already subscribes to, so a hook entry
    republishes the projection to connected sessions and a reconnect re-syncs.
  - Confirm with an integration test in the style of the progress-feed test that already covers
    initial, live and reconnect streams.
- Resolve the overlap with the transcript tail:
  - Suppress tailed entries for events already reported by a hook for the same session, so each tool
    call appears once, and handle the boundary where hook coverage starts or stops mid-run.
  - Decide and document which source wins when both are enabled, and make the feed row's source
    visible so a reader can tell a real-time entry from a backfilled one.
- Add the settings and the install command:
  - An opt-in setting for the hook source, default off.
  - Update the existing browser opt-in's description to cover both sources.
  - A command that renders the exact hook JSON and the target settings file, and writes only on
    confirmation.
- Measure and record the latency, and add the number to
  `docs/copilot-hook-feed-design.md` beside the transcript figures so the two are comparable.
- Tests: spool parsing and partial lines, schema-version rejection, session-to-task mapping from a
  prompt marker, redaction against planted content, deduplication against the tail, spool truncation
  and cleanup, and the browser republish path.
- Close out without scope creep:
  - Do not change the transcript tail's own reading logic, the receipt or progress grammars, or
    `src/chat/executor.ts`.
  - Do not install a hook into any settings file as a side effect of building this.
  - Confirm by reviewing the diff that only the hook script, the receiver, the projection and settings
    changes, the docs update, their tests, and this task file were touched.

## Log
- audit:state-change at:2026-09-01T13:11:29Z task:TASK-015 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:state-change at:2026-09-01T13:12:24Z task:TASK-015 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rz3p6w task:TASK-015 at:2026-09-01T13:12:24Z note:"scoping the real-time path from hook event to browser, including the overlap with the lagging transcript source"
- run:rz3p6w task:TASK-015 stage:refine result:ok note:"2026-09-01T13:13:26Z — refine completed: scoped the real-time hook path end to end, including the republish the browser needs and the deduplication against the lagging transcript source"
- audit:state-change at:2026-09-01T13:13:54Z task:TASK-015 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T13:14:34Z task:TASK-015 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rd6v2n task:TASK-015 at:2026-09-01T13:14:34Z note:"building the hook script and the spool receiver"
- progress run:rd6v2n task:TASK-015 at:2026-09-01T13:26:02Z note:"hook script, receiver, projection, dedup and republish are in and green; the latency figure needs a run with a hook installed"
- propose-task run:rd6v2n type:bug title:"Late receipt reconciliation test fails intermittently" note:"observed failing in two of four full runs and passing in the others, before and after this card changed anything"
- run:rd6v2n task:TASK-015 stage:develop result:blocked note:"2026-09-01T13:26:02Z — develop blocked: the hook script, spool receiver, deduplication and browser republish are implemented with nineteen passing tests, but the required end-to-end latency measurement needs a board run with a hook installed, and the guided install command is not built yet"
- audit:state-change at:2026-09-01T21:54:36Z task:TASK-015 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
- audit:status-change at:2026-09-01T21:54:36Z task:TASK-015 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
