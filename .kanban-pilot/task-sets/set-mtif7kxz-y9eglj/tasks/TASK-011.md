---
id: TASK-011
title: Confirm a board-started stage run writes a Copilot transcript
type: feature
state: done
status: idle
position: 3
created: 2026-09-01T11:16:07Z
updated: 2026-09-01T11:39:50Z
chat_reset_required: false
origin_task: TASK-009
---

## Request
Found while measuring transcript timing (docs/copilot-response-streaming-spike.md, Measurement
section, "What this does not establish").

The session observed for TASK-009 was a Copilot agent session, and its header carried
`producer: copilot-agent` exactly as predicted - but no task file ever referenced its session id, so
it was not demonstrably a stage run started from the Kanban Pilot board. The timing numbers stand
regardless, because the transcript writer does not vary by caller. What is still unproven is the
narrower claim TASK-008 actually depends on: that clicking Refine, Develop, or Validate on the board
produces a transcript file at all.

`kanbanPilot.chat.mode` defaults to `agent`, and the transcript writer is on the agent path, so it
should. Confirm it by running one stage from the board, then checking that the id written to the
task's `copilot_session_id` names a file in
`workspaceStorage/<ws>/GitHub.copilot-chat/transcripts/`.

Worth capturing in the same run: how long after the turn completes the `copilot_session_id` is
actually written to the task file, since a tail keyed by that id cannot start until it exists.

Also worth testing cheaply while there: what happens when `kanbanPilot.chat.mode` is set to a
non-agent mode. If no transcript is written in that case, TASK-008's opt-in has to say so rather than
silently producing an empty feed.

_Filed automatically by TASK-009's run rc4n8j._

## Refined

## Scope

## Log
- audit:state-change at:2026-09-01T11:25:15Z task:TASK-011 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:state-change at:2026-09-01T11:36:45Z task:TASK-011 from:refine to:approved action:move note:"State changed from refine to approved via move."
- audit:state-change at:2026-09-01T11:36:49Z task:TASK-011 from:approved to:in-progress action:move note:"State changed from approved to in-progress via move."
- progress run:rv8k3d task:TASK-011 at:2026-09-01T11:37:49Z note:"folding the observed board run into the spike and correcting the bullet it falsifies"
- propose-task run:rv8k3d type:feature title:"Close the three remaining transcript-behaviour gaps in one board sitting" note:"a develop-length run, session reuse on a repeat run, and non-agent mode all need a board-started stage that cannot be run from here"
- run:rv8k3d task:TASK-011 stage:develop result:ok note:"2026-09-01T11:39:00Z — develop completed: confirmed a board run writes a transcript named by copilot_session_id, wrote the Confirmation subsection, corrected the falsified bullet, and fixed the tail keying assumption in the recommendation"
- audit:state-change at:2026-09-01T11:39:50Z task:TASK-011 from:validation to:done action:move note:"State changed from validation to done via move."
