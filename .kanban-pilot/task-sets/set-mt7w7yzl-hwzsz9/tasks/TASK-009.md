---
id: TASK-009
title: Click Stop from the card does not stop the Copilot chat
type: feature
state: validation
status: idle
position: 0
created: 2026-08-26T07:23:00Z
updated: 2026-08-26T08:03:57Z
chat: 2d479704-109d-4a14-8666-6fbc45e30c33
copilot_session_id: 2d479704-109d-4a14-8666-6fbc45e30c33
chat_reset_required: false
---

## Request
Click Stop from the card does not stop the Copilot chat

## Refined

### Problem statement

The **Stop** action on a running card currently stops only Kanban Pilot's
bookkeeping: it clears the task's run, records a stopped activity, and returns
the card to its idle/reset state. The Copilot Chat turn launched for that run
continues generating or executing tools in the task's bound chat session.
Stopping a card must also cancel the matching in-flight Copilot Chat turn,
without cancelling another task's conversation or allowing the cancelled
turn's eventual completion to change the stopped card.

### Acceptance criteria

- Clicking **Stop** on a card with an active Refine, Split, Develop/Continue,
	or Validate run requests cancellation of the Copilot turn started for that
	same task and run.
- The matching Copilot response and any further tool execution stop; the user
	does not also have to press Stop in the Copilot Chat UI.
- Cancellation targets the clicked card's task-bound chat session and does not
	stop a concurrently running turn belonging to another card.
- After cancellation, existing card semantics remain intact: the run id is
	cleared, a single stopped activity is recorded, capacity is released, and
	the card returns to the state currently defined by the state machine.
- A late resolve, rejection, receipt, or other completion signal from the
	cancelled run cannot overwrite the stopped card or produce a second
	terminal activity.
- Stop is safe and idempotent when the Copilot turn has already finished or
	no cancellable turn exists, and a cancellation failure is surfaced rather
	than silently claiming that the Copilot turn stopped.
- Automated tests cover targeted Copilot cancellation, concurrent task
	isolation, cancellation failure/already-finished behavior, and preservation
	of the existing Stop transition and audit behavior.

## Scope

- [ ] `src/chat/executor.ts` — extend the executor contract with a targeted
	cancellation operation for the task-bound Copilot session; use the supported
	chat cancellation command/capability, return an explicit success/no-active-
	turn/failure result, and keep session selection isolated by task and task set.
- [ ] `src/chat/runManager.ts` — associate each admitted run with its active
	executor turn and make the card's `stop` path cancel that turn before
	finalizing the existing stopped transition; retain stale-run guards,
	reservation release, notification, and single-terminal-audit behavior.
- [ ] `src/chat/runManager.ts` — define failure and race handling so an already
	completed turn is harmless, a late executor result cannot reconcile a
	cancelled run, and an actual cancellation failure is reported to the user
	without falsely presenting the Copilot turn as stopped.
- [ ] `src/test/executor.test.ts` — test cancellation capability detection,
	task-session targeting and command ordering, no-active-turn idempotency, and
	command failure reporting.
- [ ] `src/test/runManager.test.ts` — update Stop coverage to assert that the
	matching executor turn is cancelled, concurrent runs are isolated, card and
	audit transitions still occur exactly once, capacity is released, and late
	completion cannot clobber the stopped state.
- [ ] `docs/PRD.md` — document that card-level Stop cancels both the managed
	Kanban run and its bound Copilot turn, including the supported-capability and
	failure behavior.

## Log
- audit:state-change at:2026-08-26T07:23:02Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T07:23:03Z task:TASK-009 from:idle to:running action:refine run:r3u2v8g note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T07:23:03Z task:TASK-009 stage:refine action:refine run:r3u2v8g note:"Started refine activity."
- run:r3u2v8g task:TASK-009 stage:refine result:ok note:"Scoped targeted cancellation of the matching Copilot turn while preserving Stop state, audit, race, and concurrency behavior."
- audit:status-change at:2026-08-26T07:24:13Z task:TASK-009 from:running to:idle action:receipt run:r3u2v8g outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T07:24:13Z task:TASK-009 stage:refine action:receipt run:r3u2v8g outcome:ok note:"Scoped targeted cancellation of the matching Copilot turn while preserving Stop state, audit, race, and concurrency behavior."
- audit:status-change at:2026-08-26T07:44:55Z task:TASK-009 from:idle to:running action:refine run:r8b4lxe note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T07:44:55Z task:TASK-009 stage:refine action:refine run:r8b4lxe note:"Started refine activity."
- audit:state-change at:2026-08-26T07:44:58Z task:TASK-009 from:refine to:scoped action:move run:r8b4lxe outcome:superseded note:"State changed from refine to scoped via move."
- audit:status-change at:2026-08-26T07:44:58Z task:TASK-009 from:running to:idle action:move run:r8b4lxe outcome:superseded note:"Status changed from running to idle via move."
- audit:activity-finish at:2026-08-26T07:44:58Z task:TASK-009 stage:refine action:move run:r8b4lxe outcome:superseded note:"Activity superseded by a manual move to scoped."
- audit:state-change at:2026-08-26T07:45:00Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T07:45:02Z task:TASK-009 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T07:45:02Z task:TASK-009 from:idle to:running action:develop run:r3pm11e note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T07:45:02Z task:TASK-009 stage:develop action:develop run:r3pm11e note:"Started develop activity."
- progress run:r3pm11e task:TASK-009 at:2026-08-26T07:52:20Z note:"Implemented targeted Copilot cancellation and verified Stop races, failure handling, and concurrent task isolation."
- run:r3pm11e task:TASK-009 stage:develop result:ok note:"2026-08-26T07:52:20Z — implemented task-bound Copilot cancellation with safe Stop orchestration, race guards, tests, and documentation"
- audit:status-change at:2026-08-26T07:52:41Z task:TASK-009 from:running to:idle action:receipt run:r3pm11e outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T07:52:41Z task:TASK-009 stage:develop action:receipt run:r3pm11e outcome:ok note:"2026-08-26T07:52:20Z — implemented task-bound Copilot cancellation with safe Stop orchestration, race guards, tests, and documentation"
- audit:state-change at:2026-08-26T08:03:57Z task:TASK-009 from:in-progress to:validation action:apply-pending run:r3pm11e outcome:ok note:"State changed from in-progress to validation via apply-pending."
