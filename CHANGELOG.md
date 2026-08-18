# Change Log

All notable changes to the "kanban-pilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

_No unreleased changes._

## [0.2.0] - 2026-08-18

### Added

- Named workspace-local task sets with an immutable Default set, independent task files and
	ordering, and header controls for creating, selecting, renaming, and deleting eligible sets.
- Required Feature/Bug task types with readable accessible card markers, legacy-task
	normalization, and typed follow-up task proposals with inheritance and explicit overrides.
- In-board task editing for the title and Markdown Request, Refined, and Scope sections while
	protecting workflow metadata, active-run state, session metadata, and the append-only Log.
- Persisted within-column card ordering with mouse drag-and-drop, keyboard Arrow Up/Arrow Down
	controls, accessible position announcements, deterministic legacy ordering, and task-set
	isolation.
- A categorized, responsive Settings workspace with Automation gates and Agent assignments for
	all seven workflow columns, including save/reset behavior and resting-column labels.
- Extension-owned audit events for state changes, status changes, and activity start/finish
	lifecycle entries, timestamped in UTC and kept compatible with agent receipts and proposals.
- Configurable shared run capacity across Refine, Split, Develop/Continue, and Validate through
	`kanbanPilot.run.maxParallelTasks`, defaulting to one.

### Changed

- Updated the board presentation to follow VS Code themes with accessible keyboard and focus
	behavior while retaining the workflow's visual stage cues.
- Refine now records an advisory split recommendation with rationale and proposed boundaries when
	appropriate; the recommendation does not create child tasks or perform implementation work.
- Agent assignment settings now support all workflow columns, preserve legacy
	`refine`/`develop`/`validate` keys, and use the Refine assignment for Split while keeping
	resting-column assignments display-only.
- Run-capacity reconciliation counts persisted running tasks after reload, starts eligible work
	when capacity increases, and leaves active runs uninterrupted when capacity decreases.

### Fixed

- Late completion receipts now recover runs when an agent write races with the extension's
	missing-receipt fallback, preventing successful work from remaining blocked; late corrections
	are idempotent.
- Extension audit and task-store reconciliation now preserve existing receipts, proposals,
	task content, and metadata across retries, reloads, and superseded runs.
- Legacy task files are normalized to typed tasks, while legacy stage-key agent settings remain
	supported by the current column-assignment resolver.

## [0.1.0]

- Initial release

### Added

- Markdown-backed task cards stored under `.kanban-pilot/tasks`.
- A staged workflow from Backlog through Refine, Scoped, Approved, In Progress, Validation, and Done.
- Explicit workflow gates with optional automatic advancement for hands-off operation.
- Private Copilot Chat sessions per task, including optional docked chat beside the board.
- Task splitting for oversized work and follow-up task proposals from development and validation runs.
- Configurable run capacity for controlling concurrent task work.