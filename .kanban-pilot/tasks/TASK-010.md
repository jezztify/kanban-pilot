---
id: TASK-010
title: Enable parallel task configuration
type: feature
state: done
status: idle
created: 2026-08-15T08:34:07Z
updated: 2026-08-15T08:57:02Z
chat: kanban-pilot-TASK-010
copilot_session_id: a2549667-269d-408c-8092-334633e87b9f
scope_hash: d1e2946
chat_reset_required: false
---

## Request
I want to be able to configure how many parallel tasks can go at a time.

## Refined
The extension currently has no general limit on concurrent agent runs. The
process-wide mutex in `src/chat/executor.ts` only serializes the brief
open-and-inject handoff; multiple `blockOnResponse` calls can remain active at
the same time. `RunManager.applyGatePolicies()` also has a hard-coded single
develop slot, but manual starts and the Refine, Split, and Validate stages are
not covered.

Add a positive-integer `kanbanPilot.run.maxParallelTasks` setting, defaulting
to `1`, that limits active agent runs across Refine, Split, Develop/Continue,
and Validate. The limit applies consistently to board actions, command-palette
actions, and automatic gate starts, including all `RunManager` instances in
the extension host. A run occupies a slot from the accepted stage start until
its receipt, timeout, executor failure, Stop, or other reconciliation outcome
releases it.

This refinement assumes that the existing Approved column remains the durable
ready queue: when the limit is full, a requested run is not started and the
task remains in its current eligible state for a later manual retry or gate
sweep. No new `queued` status or task-file field is needed. Reducing the limit
does not cancel runs already in progress; it only prevents new starts until
capacity is available. Values below one or otherwise invalid are treated as
the safe default of one.

Allowing a value greater than one is an explicit opt-in to concurrent agent
work in the same workspace. This ticket adds a run-concurrency throttle, not
git worktrees or isolation for simultaneous code edits; the default remains
one to preserve the current working-tree safety posture.

**Acceptance criteria**
- VS Code Settings exposes `kanbanPilot.run.maxParallelTasks` as a positive
	integer with default `1`, and the README explains its scope, default, and
	the same-workspace risk of opting into values greater than one.
- The configured cap is enforced across Refine, Split, Develop/Continue, and
	Validate runs, regardless of whether they were started from the board,
	command palette, or an automatic gate. Concurrent start attempts cannot
	exceed the configured number of active runs, even when they race or use
	different `RunManager` instances.
- When all slots are occupied, an eligible action leaves the task's state,
	status, `run`, and task-session binding unchanged and does not invoke the
	executor. Automatic gates leave excess work in its existing ready state
	instead of creating a new queued status or silently overcommitting a slot.
- A completed, stopped, timed-out, failed, blocked, or otherwise reconciled
	run releases its slot exactly once. A window reload counts persisted
	`running` tasks while rebuilding capacity, and a late or stale receipt
	cannot release or consume a slot for the wrong run.
- Increasing the setting allows subsequent manual starts or automatic gate
	sweeps to use the additional capacity; decreasing it does not interrupt
	existing runs and prevents new starts until the active count is below the
	new limit. Invalid configured values fall back safely to one.
- The existing injection mutex, per-task chat-session binding, receipt
	reconciliation, timeout behavior, Stop behavior, and stage-specific outcome
	transitions remain intact. Tests cover default single-slot behavior, values
	greater than one, mixed stages, simultaneous races, automatic gates,
	capacity release, configuration changes, and reload/stale-run handling.

## Scope
- [ ] `package.json` — contribute `kanbanPilot.run.maxParallelTasks` as a
	numeric setting with default/minimum metadata and a description that makes
	the shared-workspace opt-in risk clear; keep `run.timeoutMinutes` unchanged.
- [ ] `src/chat/runManager.ts` — extend the run configuration and add a
	workspace/process-scoped concurrency coordinator that reserves a slot before
	applying a stage transition, counts persisted `running` tasks, and prevents
	oversubscription across board, palette, automatic-gate, and separately
	constructed `RunManager` paths. Apply it uniformly to `refine`, `split`,
	`develop`, `continue`, and `validate`; leave an ineligible/full-capacity
	task untouched rather than adding a new task status.
- [ ] `src/chat/runManager.ts` — release reservations on every terminal path
	(including receipt success/blocked/failed outcomes, timeout, executor error,
	Stop, and stale/superseded runs), reconcile capacity from task files after
	activation, and replace the `approvedToInProgress` hard-coded single-slot
	check with the configured shared capacity. Automatic sweeps must start no
	more than the available number of runs and must not move backlog tasks into
	Refine when no slot is available.
- [ ] `src/extension.ts` — react to changes in
	`kanbanPilot.run.maxParallelTasks` by re-running automatic gate policy
	processing so increasing capacity can advance eligible queued-column tasks;
	preserve the existing serialized watcher/reconciliation flow.
- [ ] `src/test/runManager.test.ts` — add deterministic coverage for the
	default cap of one, multi-slot starts, mixed-stage accounting, simultaneous
	start races, full-capacity no-op behavior, capacity release after each
	terminal outcome, automatic-gate filling up to the configured limit,
	configuration increases/decreases and invalid values, activation with
	persisted running tasks, and stale/late-run protection. Ensure shared
	coordinator state is isolated between tests.
- [ ] `README.md` — document the new setting, how to configure it, that it
	limits all active agent stages rather than the number of cards in a column,
	that Approved remains the ready queue, and that values above one permit
	concurrent edits in the same workspace without worktree isolation.
- [ ] `docs/PRD.md` — update the configuration table, gate-policy wording, and
	§8.4's single-slot/deferred-worktree language to describe the default-one
	behavior and explicit opt-in configurable run concurrency accurately; retain
	worktree isolation as a separate future concern.
- [ ] Verify that `src/chat/executor.ts`'s narrow injection mutex is still only
	protecting focus-sensitive injection, while the new coordinator limits the
	full awaited run; run compile, lint, and the existing test suite.

## Log
- run:rxrbnru task:TASK-010 stage:refine result:ok note:"2026-08-15T08:42:43Z — refined configurable run concurrency, capacity behavior, safety assumptions, affected files, and verification coverage"
- run:rewacr8 task:TASK-010 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- run:rewacr8 task:TASK-010 stage:develop result:ok note:"2026-08-15T08:55:29Z — implemented configurable run concurrency and verified the scoped tests/build"
