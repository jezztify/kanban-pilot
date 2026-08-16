# Change Log

All notable changes to the "kanban-pilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Fixed

- Late completion receipts now recover runs when an agent write races with the extension's missing-receipt fallback, preventing successful work from remaining blocked.

## [0.1.0]

- Initial release

### Added

- Markdown-backed task cards stored under `.kanban-pilot/tasks`.
- A staged workflow from Backlog through Refine, Scoped, Approved, In Progress, Validation, and Done.
- Explicit workflow gates with optional automatic advancement for hands-off operation.
- Private Copilot Chat sessions per task, including optional docked chat beside the board.
- Task splitting for oversized work and follow-up task proposals from development and validation runs.
- Configurable run capacity for controlling concurrent task work.