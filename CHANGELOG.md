# Change Log

All notable changes to the "kanban-pilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

_No unreleased changes._

## [0.3.3] - 2026-08-24

### Added

- Safe CommonMark/GFM rendering in Task Details for the Request, Refined, and Scope sections,
	including headings, lists, checklists, tables, code, links, and task-local images.
- Mermaid fenced blocks now render as charts through the extension's locally packaged runtime.

### Fixed

- Invalid Mermaid diagrams now show a readable source fallback without preventing the rest of the
	task details from rendering. Authored Markdown remains available for editing, while unsafe links
	and unavailable or remote images are not loaded; existing task-local attachment handling and
	modal actions remain intact.

## [0.3.2] - 2026-08-20

### Added

- Human-confirmed **Recover Stale Completion** support for adopting an exact successful receipt
	from an extension-started timed-out or missing-receipt run, with candidate validation, modal
	confirmation, normal gate handling, append-only audit history, and no new agent run.
- Durable task-to-chat session bindings that are reused by Open Chat and stage runs after board or
	window reloads, while keeping named task-set conversations isolated.

### Changed

- Receipt reconciliation now requires exact task, run, and stage identity, records actionable
	diagnostics for rejected or malformed receipt-like lines, and applies eligible same-run late
	receipts idempotently. Stopped, manually moved, newer, or otherwise superseded run output cannot
	overwrite the current task; stale completion recovery remains an explicit human decision.
- Parallel task execution now allows admitted runs to await their own Copilot responses while
	serializing only the short session open-and-inject handoff. `run.maxParallelTasks` remains the
	capacity authority, and no backend server is required.
- Agent assignment discovery now includes workspace `.github/agents` and `.claude/agents`,
	configured agent-file locations, and user-level `~/.copilot/agents` and `~/.claude/agents`
	folders, with workspace-first collision precedence and compatibility for legacy assignments.
- Pending completion cards now say **Review Required** while preserving the transition context and
	existing Apply Pending Completion behavior.

### Fixed

- Valid PNG, JPEG, GIF, and WebP attachments referenced by the current task now render in task
	details through safe webview resources; missing, corrupt, cross-task, remote, SVG, raw-HTML, and
	other unsafe references remain an unavailable placeholder.

## [0.3.1] - 2026-08-19

### Changed

- Improved the board webview for smaller views and fixed parallel task handling.

### Fixed

- Fixed pasting images into task fields.

## [0.3.0] - 2026-08-18

### Added

- Complete manual/auto gate coverage for the normal workflow pipeline, including durable pending
	completion outcomes and the explicit Apply Pending Completion action.
- A full in-board Settings editor for the contributed Kanban Pilot options, with typed validation,
	workspace-scoped save/reset behavior, and clear next-run or reload boundaries.
- Copilot custom-agent discovery from workspace, configured, and user-level locations, with
	keyboard-accessible assignment dropdowns and compatibility for existing labels.

### Changed

- Agent assignments now use one category-level Save for all seven columns while retaining a
	per-column Reset control; the saved assignments continue to drive board labels and prompts.
- Split reconciliation now persists valid child tasks in the active task set before retiring the
	parent, and leaves a retryable outcome when usable children cannot be created.

### Fixed

- Timed-out runs now remain retryable and can recover from a matching late receipt without
	duplicating outcomes, while Stop, manual moves, and newer retries prevent stale run output from
	overwriting current task state.

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