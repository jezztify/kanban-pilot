---
id: TASK-001
title: Improve Automation Gates
type: feature
state: validation
status: idle
position: 5
created: 2026-08-18T05:21:36Z
updated: 2026-08-18T09:38:30Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-001
copilot_session_id: eb28f7dd-ecc3-4e61-9044-771bfd4f5101
scope_hash: 18d4f8a
chat_reset_required: false
---

## Request
some transitions are missing. Each transition should have an automation gate.

## Refined

### Problem statement

The extension currently exposes only four `manual | auto` gate policies:
Backlog → Refine, Scoped → Approved, Approved → In Progress, and Validation
auto-start. That catalog does not cover all of the workflow's automated
outcomes. `RunManager.applyOutcome()` currently advances a successful Refine
run directly to Scoped, a successful Develop run directly to Validation, and a
Validate result directly to Done or back to In Progress; a successful Split
also retires its parent in Done. Those paths bypass the gate settings, so a
user cannot choose a consistent manual-versus-automatic policy for every
pipeline transition and the Settings labels do not describe the complete
workflow.

This ticket should define one authoritative gate catalog for every normal
pipeline edge and stage-start edge, with manual behavior as the safe default
and auto behavior as an explicit opt-in. A manual completion gate must not
rerun the agent: it must record the receipt, leave a durable pending outcome,
and expose a one-time human action that applies that outcome. An automatic
gate must apply the same transition through the existing state machine and
receipt/audit paths. Retries, Stop + reset, Reopen, arbitrary manual board
moves, and other escape controls remain explicitly human-driven; they are not
automatic pipeline gates unless the product scope is expanded deliberately.

### Acceptance criteria

- A documented, testable transition matrix covers the complete supported
	pipeline: Backlog → Refine, successful Refine → Scoped, Scoped → Approved,
	Approved → In Progress, successful Develop → Validation, Validation
	auto-start/Validate, successful Validate → Done, failed-validation verdict →
	In Progress, and successful Split parent → Done. Each listed edge has one
	`manual | auto` policy with a stable setting key and a default of `manual`;
	no listed edge remains hard-coded outside the policy path.
- The existing four gate settings remain compatible with existing workspace
	configuration. Any clearer replacement key has an explicit alias or
	migration, and `validationAutoStart` is not silently mistaken for the
	separate Validation outcome gates.
- In manual mode, an agent receipt still completes the run and records the
	result, but the task does not cross the gated column boundary until the user
	invokes the corresponding promotion/decision action. The pending outcome is
	durable across reloads, visible through the card/detail/palette surfaces,
	applied at most once, and never causes a second agent run.
- In auto mode, the same transition is applied automatically after the
	triggering receipt or gate becomes eligible, including after activation,
	file-watcher reconciliation, and a gate-setting refresh. Automatic stage
	starts still use the shared run-capacity coordinator; capacity denial leaves
	eligible work queued for a later sweep.
- Automatic policies never retry `blocked` or `failed` work without a new human
	decision. Validate's `ok`, criteria-not-met `failed`, blocked/error outcomes,
	Split's child-persistence rules, late receipts, stale runs, and audit/receipt
	idempotency retain their existing stage-specific semantics.
- The board Settings surface, `package.json` contributions, runtime config
	reader, validation/persistence protocol, and command/card actions expose the
	same complete gate catalog. Switching a gate to Auto applies it immediately
	to already-eligible idle work; resetting it restores the documented manual
	default without changing unrelated settings.
- Automated coverage proves that every matrix edge has a policy, manual mode
	waits for the explicit action, auto mode advances eligible work, cascades
	are deterministic, capacity is respected, pending outcomes survive reload,
	retries and escape controls are not auto-fired, and repeated watcher or
	activation passes do not duplicate transitions or audit entries.
- `README.md` and the relevant `docs/PRD.md` workflow, gate, configuration,
	protocol, and state-machine sections describe the full matrix, setting
	compatibility, manual pending-outcome behavior, and the deliberate boundary
	between pipeline gates and human-only escape controls.

### Boundary assumption

“Each transition” is interpreted here as each normal workflow/pipeline edge
and stage-start edge, including the alternate Split and validation-verdict
paths. Stop, Reopen, retry/Continue, and arbitrary drag moves are user
commands rather than automation candidates. If the intended requirement is
instead that every raw `TaskAction` rule also be configurable, that is a
broader product decision and the matrix must be expanded before development.

## Scope
- [ ] Create one shared transition/gate catalog (or an equivalent single
	source of truth) for the listed workflow edges, including stable setting
	identifiers, labels, defaults, trigger stage/action, manual behavior, auto
	behavior, and whether the edge is a stage start or a receipt outcome. Keep
	the existing four setting keys compatible and make the catalog drive both
	runtime policy lookup and the Settings UI rather than maintaining another
	partial list.
- [ ] Update `src/board/stateMachine.ts` and `src/board/actions.ts` with the
	legal explicit promotion/decision actions needed when a completion gate is
	manual. Apply each pending outcome exactly once, keep existing retry,
	Stop + reset, Reopen, and manual-move behavior intact, and emit the normal
	extension audit events for both the deferred and committed steps.
- [ ] Extend `src/model/task.ts` and `src/model/taskStore.ts` with the
	extension-owned durable representation for a pending gated outcome (or an
	equivalent receipt-derived, reload-safe marker). Preserve old task files,
	unrelated frontmatter, task-set directories, scope hashes, run/session
	metadata, and atomic/audited writes; clear pending metadata when the outcome
	is committed, superseded, stopped, moved, or retried.
- [ ] Update `src/chat/runManager.ts` so `readConfig()` and
	`applyGatePolicies()` understand the complete catalog, while
	`applyOutcome()` defers or commits each receipt-driven edge according to its
	policy. Reconcile pending outcomes on activation, configuration changes, and
	file-watcher passes; reuse the concurrency coordinator for stage starts;
	prevent automatic retries; and retain late-receipt, stale-run, Split child
	persistence, close-on-Done, and exactly-once audit/receipt behavior.
- [ ] Update `package.json` with the missing `kanbanPilot.gates.*` settings,
	`manual` defaults, compatibility descriptions, and any alias/migration
	metadata required for the existing four keys. Keep the contributed inventory
	and the in-board inventory synchronized.
- [ ] Update `src/board/boardPanel.ts` to render and persist every catalog row,
	surface pending completion decisions with the appropriate card/detail
	actions, and keep keyboard, accessibility, theme, task-set, and immediate
	gate-refresh behavior intact. Update `src/extension.ts` for any new palette
	commands and activation/configuration hooks; do not create a second policy
	path that can diverge from `RunManager`.
- [ ] Extend `src/test/stateMachine.test.ts` and `src/test/boardPanel.test.ts`
	for the complete action matrix, pending/manual promotion UI, settings
	inventory, compatibility aliases, invalid payloads, and human-only escape
	controls. Extend `src/test/runManager.test.ts` for every success/failure edge,
	auto/manual behavior, cascades, capacity, activation/watcher reconciliation,
	reload persistence, stale/retry protection, Split, validation verdicts, and
	idempotent audit entries; add `src/test/extension.test.ts` coverage for any
	new command registration.
- [ ] Update receipt/template/audit tests only if the pending-outcome contract
	changes their public grammar; keep agent receipts parser-compatible and keep
	frontmatter ownership with the extension. Run focused tests followed by the
	repository compile, lint, and full test commands.
- [ ] Update the workflow diagrams, gate matrix, settings/protocol tables, and
	user-facing configuration guidance in `docs/PRD.md` and `README.md`, including
	the exact defaults, legacy-key behavior, manual pending-outcome lifecycle,
	automatic cascade/capacity rules, and the explicit exclusion of human-only
	controls from automation.

## Log
- audit:state-change at:2026-08-18T05:21:42Z task:TASK-001 from:backlog to:refine action:move note:"State changed from backlog to refine via move."
- audit:status-change at:2026-08-18T08:27:26Z task:TASK-001 from:idle to:running action:refine run:rgxwxg1 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T08:27:26Z task:TASK-001 stage:refine action:refine run:rgxwxg1 note:"Started refine activity."
- run:rgxwxg1 task:TASK-001 stage:refine result:ok note:"2026-08-18T08:30:06Z — refined the complete transition-gate matrix, pending manual outcomes, compatibility, and implementation scope"
- audit:state-change at:2026-08-18T08:31:08Z task:TASK-001 from:refine to:scoped action:receipt run:rgxwxg1 outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T08:31:08Z task:TASK-001 from:running to:idle action:receipt run:rgxwxg1 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T08:31:08Z task:TASK-001 stage:refine action:receipt run:rgxwxg1 outcome:ok note:"2026-08-18T08:30:06Z — refined the complete transition-gate matrix, pending manual outcomes, compatibility, and implementation scope"
- audit:state-change at:2026-08-18T08:40:45Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T08:40:51Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T08:40:51Z task:TASK-001 from:idle to:running action:develop run:ro38rft note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T08:40:51Z task:TASK-001 stage:develop action:develop run:ro38rft note:"Started develop activity."
- run:ro38rft task:TASK-001 stage:develop result:failed note:"timed out"
- audit:status-change at:2026-08-18T09:00:51Z task:TASK-001 from:running to:failed action:timeout run:ro38rft outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-08-18T09:00:51Z task:TASK-001 stage:develop run:ro38rft outcome:timeout note:"Activity timed out."
- run:ro38rft task:TASK-001 stage:develop result:ok note:"2026-08-18T09:34:01Z — implemented and validated the nine independent automation gates"
- audit:state-change at:2026-08-18T09:38:30Z task:TASK-001 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-08-18T09:38:30Z task:TASK-001 from:failed to:idle action:move note:"Status changed from failed to idle via move."
