---
id: TASK-013
title: Close the three remaining transcript-behaviour gaps in one board sitting
type: feature
state: done
status: idle
position: 6
created: 2026-09-01T11:39:00Z
updated: 2026-09-01T21:54:32Z
scope_hash: 1500c06
chat_reset_required: false
origin_task: TASK-011
---

## Request
Found while confirming board-run transcript behaviour (docs/copilot-response-streaming-spike.md,
Confirmation subsection, "Still open after this run").

Three questions are left, and all three are answerable in a single sitting with
`scripts/watch-transcript.mjs` running. None of them can be answered from here - each needs a stage
started from the board, and the third also needs a settings change.

1. **A develop-length run.** Only a refine turn has been observed - 45 s, 6 tool calls, 3 flush
   batches. A develop run is longer and more tool-heavy. Confirm the batch structure and the
   5-50 s tool-event lag hold there rather than assuming they generalise from a short turn.

2. **Session reuse on a repeat run.** Run a second stage on a task that already has a
   `copilot_session_id` and check whether it appends to the same transcript file or starts a new one.
   This decides whether TASK-008 needs the directory-watch path always, or only for a task's first
   run - the id is written 2 s after a run's last event, so it can never key the run that produces
   it, but it is available for every run after that.

3. **Non-agent chat mode.** `kanbanPilot.chat.mode` defaults to `agent`, and the transcript writer is
   on the agent path. Set it to a non-agent mode, run one stage, and check whether a transcript
   appears at all. Revert the setting afterwards. If no transcript is written, TASK-008's opt-in has
   to say so rather than silently showing an empty feed.

Each answer goes into the Confirmation subsection of the spike, replacing the corresponding bullet
under "Still open after this run".

Note the cost: items 1 and 3 each consume a real Copilot turn, and item 3 temporarily changes a user
setting that must be restored.

_Filed automatically by TASK-011's run rv8k3d._

## Refined

### Problem statement

Three questions survived TASK-011, and they share one expensive ingredient: each needs a stage run
started from the board. Answering them one at a time means three separate sittings and three Copilot
turns spent on coordination rather than on the questions. This card exists to answer all three in one
sitting, and to make the observation precise enough beforehand that no run is wasted on a
badly-instrumented attempt.

The urgency is specific rather than general. TASK-008 is the largest build in this line of work, and
two of its premises are still unverified — while a third, keying the tail by `copilot_session_id`, was
already found wrong by TASK-011. That is a demonstrated failure rate on assumptions about this
surface, not a hypothetical one, and it is the argument for measuring before designing.

Two things make this cheaper than it looks:

- **The subject already exists.** TASK-012 is a throwaway card carrying
  `copilot_session_id: 1a647f8c-6992-4d9b-bc5a-0f1240e05bb1`, sitting at `refine`/`idle` — so a repeat
  run on it is legal and directly answers the session-reuse question with no work invented to
  generate it.
- **The harness is built and proven.** `scripts/watch-transcript.mjs` has already captured two
  sessions. Nothing needs writing; this is a measurement, not a build.

One scoping fact worth stating precisely: `kanbanPilot.chat.mode` is an enum of exactly
`["agent", "ask"]`, so "non-agent mode" means **ask mode**, and the third question is whether an ask
turn writes a transcript at all.

### Acceptance criteria

- Each of the three bullets under "Still open after this run" in the spike's Confirmation subsection
  is either replaced with an answer or explicitly restated as open, with the reason it could not be
  settled.
- **Session reuse** is reported as: whether `copilot_session_id` changed across the repeat run, and
  whether the existing transcript file grew or a new file appeared. The consequence for TASK-008's
  keying is stated outright — key by id after the first run, or watch the directory always.
- **The develop-length run** is reported with the same table shape as the two sessions already in the
  document — batch count, batch sizes, oldest-entry wait per batch, and lag by event type — so all
  three sessions can be compared rather than described in three different formats.
- **Ask mode** is reported as whether a transcript file was created at all, and its `producer` value
  if one was. `kanbanPilot.chat.mode` is restored to `agent` afterwards, and the restoration is
  verified rather than assumed.
- Every observed run is recorded with task, stage, mode, start and end wall clock, session id, and
  whether the watcher covered the whole run or joined it late — the two existing sessions were both
  joined late, and that limit must not silently repeat.
- The number of Copilot turns consumed is recorded, since that is this card's real cost.
- No production source file is modified. The temporary `kanbanPilot.chat.mode` change is a user
  setting, restored, not a code change. The existing test suites still pass.

### Assumptions

- Runs are started from the board by a person. This card cannot be executed from a terminal session,
  and the write-up is the only part that can.
- The develop-length run should ride on work that was going to happen anyway — TASK-007's develop is
  the natural candidate — rather than manufacturing a long turn purely to measure it.
- Transcript retention is 20 files; three further sessions will not evict anything this card needs.
- A result holds for the observed builds, VS Code 1.127.0 and Copilot Chat 0.55.0, and is recorded
  that way.

## Scope

Run order is deliberate: cheapest and most decision-changing first, and the settings change last so
the configuration is perturbed once, at the end, when nothing else depends on it.

- **Step 0 — prepare, before any run:**
  - Record host facts: VS Code version, Copilot Chat version, current `kanbanPilot.chat.mode`.
  - Resolve the transcripts directory, noting that the workspace-hash segment is machine-specific:
    `…/workspaceStorage/<ws>/GitHub.copilot-chat/transcripts`.
  - Record TASK-012's current `copilot_session_id`, and its transcript's current line count and byte
    size, so growth is measurable rather than inferred from an mtime.
- **Step 1 — session reuse, using TASK-012:**
  - Start `scripts/watch-transcript.mjs` on the transcripts directory *before* starting the run.
  - Re-run refine on TASK-012 from the board; it is at `refine`/`idle`, so refine is legal.
  - Afterwards compare `copilot_session_id` before and after, and check whether
    `1a647f8c-….jsonl` grew or a new `<newId>.jsonl` appeared.
  - Write down the consequence explicitly: reuse means TASK-008 can key by id on every run after a
    task's first; no reuse means the directory watch is always required.
- **Step 2 — a develop-length run:**
  - Attach to a real develop run if one is due; otherwise use TASK-012.
  - Keep the watcher running for the **whole** run this time, so the opening batches are measured —
    both prior sessions were joined mid-run and their first entries are unmeasured.
  - Report batch count, batch sizes, oldest-entry wait per batch, and lag by event type.
- **Step 3 — ask mode, last:**
  - Record the current value, then set `kanbanPilot.chat.mode` to `ask` at workspace scope.
  - Start the watcher, run one stage on TASK-012, stop the watcher.
  - Record whether a transcript file appeared, and its `session.start` `producer` if it did.
  - Restore `kanbanPilot.chat.mode` to `agent` and verify the restored value.
- **Step 4 — write it up in `docs/copilot-response-streaming-spike.md`:**
  - Replace the three "Still open after this run" bullets with what was found.
  - Add a comparison table of the three observed sessions, so the lag claim rests on a visible sample
    rather than on prose.
  - If session reuse changes the keying conclusion, correct recommendation step 2, which currently
    says to watch the directory on a first run and key by id after it.
- **Step 5 — close out:**
  - Do not implement any tail, feed, or projection; that remains TASK-008.
  - Do not modify `src/chat/executor.ts`, `src/chat/runManager.ts`, `src/chat/progress.ts`,
    `src/board/boardPanel.ts`, `src/http/realtimeBoardServer.ts`, or any contributed setting.
  - File anything the runs reveal as separate tasks via the proposal flow.
  - Confirm by reviewing the diff that only the spike document and task files were touched.

## Log
- audit:state-change at:2026-09-01T11:40:16Z task:TASK-013 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rp5m7q task:TASK-013 at:2026-09-01T11:42:00Z note:"turning the three open questions into an ordered protocol that answers all of them in one sitting"
- run:rp5m7q task:TASK-013 stage:refine result:ok note:"2026-09-01T11:43:04Z — refine completed: turned the three open questions into an ordered three-run protocol reusing TASK-012 as the subject, with ask mode last so the setting is perturbed once"
- audit:state-change at:2026-09-01T11:43:25Z task:TASK-013 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T11:44:07Z task:TASK-013 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rj7d2v task:TASK-013 at:2026-09-01T11:44:07Z note:"recorded the step zero baseline; the three runs themselves need the board"
- run:rj7d2v task:TASK-013 stage:develop result:blocked note:"2026-09-01T11:44:07Z — develop blocked: step zero baseline recorded (mode agent by default, TASK-012 transcript at 33 lines and 20022 bytes), but steps one to three each need a stage run started from the board in VS Code, which cannot be initiated from a terminal session"
- audit:state-change at:2026-09-01T21:54:32Z task:TASK-013 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
- audit:status-change at:2026-09-01T21:54:32Z task:TASK-013 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
