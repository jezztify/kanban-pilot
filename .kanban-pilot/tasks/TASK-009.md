---
id: TASK-009
title: When clicking any Task Card's button open the chat on the side
type: feature
state: done
status: idle
created: 2026-08-15T08:29:55Z
updated: 2026-08-15T08:41:07Z
chat: kanban-pilot-TASK-009
copilot_session_id: b1d4b80e-f5d7-434e-b0a4-22d38b230039
scope_hash: 9f653fb
chat_reset_required: false
---

## Request
Clicking Refine, Develop, or Validate should open chat on the side instead

## Refined

### Problem statement

When a user clicks a task card's agent-stage button — **Refine**, **Develop**, or
**Validate** — Kanban Pilot should open or reveal that task's dedicated Copilot
Chat session in an editor column beside the Kanban board before the existing
stage run proceeds. The request is about the chat's placement and targeting;
the existing state-machine transition, prompt injection, receipt handling, and
one-chat-per-task behavior must remain unchanged.

### Acceptance criteria

- Clicking **Refine** on an eligible card opens or reveals that card's
	task-specific Copilot Chat session beside the board and still starts the
	existing refine action.
- Clicking **Develop** on an eligible card does the same and still starts the
	existing develop action.
- Clicking **Validate** on an eligible card does the same and still starts the
	existing validate action, including validation retries where that label is
	shown.
- The opened session is derived from the clicked task id and reuses an
	existing session rather than opening generic Chat or creating a second
	conversation for the same task.
- The side-opening step is ordered or coordinated so the stage prompt is
	injected into the clicked task's session, not merely into whichever Chat
	view happened to be focused.
- The existing `kanbanPilot.layout.dockChat` setting remains respected: its
	default-enabled behavior provides the requested side docking, while turning
	it off does not prevent the underlying task action from running.
- Card selection and other buttons such as **Accept**, **Approve**, **Stop**,
  **Continue**, **Reopen**, and **Split** retain their current behavior unless
  a later ticket broadens this request beyond the three named buttons.

## Scope

- [ ] `src/board/boardPanel.ts` — route the board's **Refine**, **Develop**, and
	**Validate** button invocations through the existing task-chat docking path
	before handing the action to `RunManager`; keep the action emitted exactly
	once and leave card selection and other action buttons unchanged.
- [ ] `src/chat/runManager.ts` — reuse or narrowly adjust `dockTaskChat` so
	action-triggered docking continues to use the clicked task's deterministic
	session URI, `ViewColumn.Beside`, preview-tab behavior, and the existing
	`layout.dockChat` gate; coordinate its ordering with stage-run startup.
- [ ] `src/chat/executor.ts` — verify the immediate session-open/injection
	sequence cannot reopen the task in the board's column or lose the side-docked
	session; preserve the focus and mutex requirements used to target the correct
	task conversation.
- [ ] `src/test/executor.test.ts` and the relevant run/board test coverage —
	cover side-docking options, reuse of the task-specific session, correct
	action/run ordering, and preservation of normal Refine/Develop/Validate
	transitions without adding coverage requirements for the out-of-scope
	buttons.
- [ ] `docs/PRD.md` — update the layout and webview-contract wording if needed
	so action-triggered docking is documented alongside the existing explicit
	**Open Chat** and `dockChatOnSelect` behaviors.

## Log
- run:rvmzxwa task:TASK-009 stage:refine result:ok note:"2026-08-15T08:31:38Z — refined the requested side-docking behavior and documented the implementation scope"
- run:rfoaou3 task:TASK-009 stage:develop result:ok note:"2026-08-15T08:39:53Z — implemented ordered side docking for Refine, Develop, and Validate with tests and PRD updates"
