# Working the board

## Keep separate piles of work with task sets

Use the **Task set** picker in the header to switch between the built-in **Default** set and any
named sets you create. Each set keeps its own tasks, its own card order, and its own chat
sessions, so an experiment doesn't get tangled up with your main work. A task's persisted chat
binding is reused by **Open Chat** and later stage runs after the board or window is reloaded; the
set-specific binding keeps chats from different sets isolated.

- **New** creates a set and switches to it.
- **Rename** works on named sets; **Delete** works on empty named sets.
- Default can't be renamed or deleted.
- You can't switch or create sets while a task is running — a run always stays with its set.

## Find cards without scanning every column

Use the board-local controls above the columns to narrow the current task-set projection:

- **Find** matches a task ID, part of a title, or a known parent task ID, without regard to case.
- **Type** filters by Feature or Bug.
- **Status** filters by Idle, Running, Paused, Blocked, or Failed.
- **Relationship** filters by Parent, Child, or Standalone. A Parent has child tasks, a Child has
	a parent task, and a task in the middle of a chain can be both. Standalone has neither role.

Find and filter criteria combine, so a card must satisfy every active control. **Clear** resets
the Find field and all selectors. The board keeps all seven columns and their card order visible;
counts show matching cards, and a **No matching tasks** message distinguishes a filtered column
from one that is genuinely empty. The result summary reports how many cards match.

These controls are local to the board. They do not edit task files, frontmatter, positions, task
sets, workflow state, or card actions, and they do not require a task detail modal. A refresh from
the same task set keeps the active criteria. Switching task sets clears them for the new
projection. The labeled controls, clear action, keyboard focus, and live result summary are
available at the board's narrow layout as well.

## Edit a card without leaving the board

Select a card and choose **Edit task**. You can change the title and the Markdown in the
**Request**, **Refined**, and **Scope** sections, checklists and code blocks included. **Save
changes** keeps it; **Cancel**, Escape, or clicking outside throws it away. If a save fails, the
message stays on screen so you can fix it without retyping everything.

Editing never changes the card's column, its run state, or its history — those only move through
workflow actions and run results. A task that's currently running can't be saved until it stops.

## Read outcome guidance at the point of work

Cards and task detail show a visible outcome callout for conditions that need attention. The
callout is text-based, so the meaning does not depend on the column colour or a hover state.

- **Running** identifies the active stage and run. The detail view explains that the run is in
	progress and keeps the legal **Stop** action visible.
- **Blocked** identifies the stage and the recorded reason when one exists. Detail explains that
	host approval or another host action is holding the task and shows only the legal retry action.
- **Failed** shows the stage, run, and failure reason when available. Detail points to the legal
	retry action instead of treating the failure as a successful completion.
- **Review Required** means a durable receipt completed but a manual finishing gate still holds
	the transition. The detail view shows the receipt result, stage, run, and gate, and **Apply**
	commits that existing outcome without starting another run.
- **Recovery Available** means a validated successful receipt from an older run arrived after the
	newer task history had already settled. Detail shows the old run, current or latest run, and
	receipt summary. **Recover** always asks for explicit host confirmation and revalidates the
	candidate, so an active-run or stale race is reported as not applied rather than shown as a
	successful recovery.

After **Apply** or **Recover**, the board reports the host result in a visible status notice. A
stale task, missing receipt, active run, or other conflict therefore leaves an explanation on the
board while the task and its open detail refresh from disk.

## Reorder cards

Drag a card up or down within its column to set an order that sticks across reloads and restarts.
Prefer the keyboard? Focus a card and use Arrow Up / Arrow Down; the board announces where it
landed. Reordering never starts a run. Dragging a card to a *different* column is still a normal
workflow move.

## Split something that's too big

If a task is clearly more than one ticket, click **Split**. Kanban Pilot files the smaller pieces
as new backlog tasks and leaves the original as a tracking card. Refine also leaves an advisory
note about whether a split looks worthwhile — a suggestion for you, not an automatic action.

## Run recovery and Split safety

Split is transactional: the parent is retired only after valid, same-run child proposals have
been persisted in the active task set. Missing or invalid proposals, or a child-write failure,
leave the parent retryable instead of silently marking it Done; repeated reconciliation does not
create duplicate children. Receipt reconciliation requires the exact task, run, and stage identity;
wrong-task, wrong-run, wrong-stage, or malformed receipt-like lines are ignored and leave an
actionable diagnostic in the task log. A timed-out run is marked failed and remains retryable when
no receipt arrives, but a matching late receipt from that run can still be reconciled once its
fallback history is verified. A receipt from a run that was stopped, manually moved, or replaced
by a newer retry cannot overwrite the newer task state.

If an earlier implementation finished but its receipt arrived after the extension had already
timed out that run and a later retry failed, use **Kanban Pilot: Recover Stale Completion** or
the recovery action in the task detail. Automatic reconciliation never treats old and new run
ids as interchangeable. The command lists only candidates with an exact successful receipt,
extension-owned start and timeout/missing-receipt history, and a retryable task with no active
run or pending outcome. It shows the old and latest run context and asks for modal confirmation
before applying the ordinary stage gate. Recovery is append-only and idempotent, records a
manual-recovery correction audit, processes eligible proposals once, and never starts another
agent run. The normal retry remains available when no validated candidate exists.

## Let agents file follow-up work

While developing or validating, an agent can propose follow-up tasks. Those show up as new backlog
cards in the **active task set**, inheriting the parent's Feature/Bug type unless the proposal says
otherwise. The proposal line belongs in the attached parent task file, so named sets never leak
children into the legacy Default folder.

The built-in prompts ask the agent to write proposals before the receipt, but the extension also
handles older prompt files and out-of-order filesystem writes. If a receipt lands first, a bounded
post-receipt recovery window plus the task-file watcher and next activation pass re-check the
settled Develop/Validate run and create any valid same-run proposals. Repeated passes are safe: the
parent outcome is not replayed and each proposal's provenance prevents duplicate children. Invalid,
foreign, Refine, over-cap, or setting-disabled proposals remain inert. This optional follow-up
path is separate from **Split**, where child proposals are mandatory and successful persistence is
required before the parent becomes a tracking card.

