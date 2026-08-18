---
id: TASK-011
title: Update README.md and CHANGELOG.md for v0.2.0
type: feature
state: validation
status: idle
created: 2026-08-18T00:48:40Z
updated: 2026-08-18T01:07:41Z
chat: kanban-pilot-set-mswwx5na-d5iytt-TASK-011
copilot_session_id: 7b8996b6-f919-4490-bb90-4b4898c37138
scope_hash: e49ecd7
chat_reset_required: false
---

## Request
Update README.md and CHANGELOG.md for all of the features that we put together for v0.2.0

## Refined

### Problem statement

Kanban Pilot's implementation and package manifest now contain a set of user-facing improvements beyond the v0.1.0 baseline, but the release documentation does not present a complete v0.2.0 story. `README.md` describes parts of the workflow, settings, editing, logging, and run-capacity behavior, but does not give users a single explanation of named task sets, persisted within-column ordering, typed Feature/Bug cards, the two-pane Settings workspace, the advisory split recommendation, or the theme-aware board presentation. `CHANGELOG.md` has no v0.2.0 section, so users cannot distinguish the completed work represented by TASK-001 through TASK-010 and the shipped named-task-set capability from the original release.

Update only `README.md` and `CHANGELOG.md` so they accurately describe the shipped v0.2.0 behavior, retain the v0.1.0 history, and avoid promising functionality that is not implemented. The documentation must explain the user-visible behavior and important safety/compatibility constraints, not merely list internal ticket names.

### Acceptance criteria

- `README.md` contains a coherent v0.2.0-level product description covering the seven-column workflow, task-specific Copilot Chat sessions, gates, and the active task-set model, while preserving the board-as-control-plane explanation.
- The README documents named task sets in addition to the immutable Default set, including switching, creating, renaming, deleting only eligible sets, and the fact that tasks and ordering are isolated per set.
- The README explains the required Feature/Bug classification, visible accessible card markers, typed agent-proposed follow-up tasks, legacy-task normalization, in-board editing of the title/Request/Refined/Scope sections, and the protected workflow metadata and append-only Log.
- The README explains persisted within-column drag-and-drop ordering and its keyboard alternative, distinguishes ordering from cross-column workflow moves, and states that ordering does not start or alter an agent run.
- The README explains the two-pane **Settings** workspace with Automation gates and Agent assignments, all four gate controls, all seven column labels, defaults/reset behavior, legacy assignment compatibility, Refine/Split assignment sharing, resting-column display-only semantics, and direct workspace-setting refresh behavior.
- The README explains extension-owned audit entries in `## Log`, their UTC timestamped lifecycle/state/status coverage, coexistence with receipts and proposals, late-receipt/idempotency behavior, and the limitation that direct frontmatter edits cannot be reliably attributed.
- The README documents the built-in refine prompt's advisory split recommendation, theme-aware board presentation, accessibility/keyboard expectations where relevant, and `kanbanPilot.run.maxParallelTasks` including its default, covered stages, persisted-run behavior, and no-worktree-isolation warning for values above one.
- `CHANGELOG.md` adds a properly formatted `[0.2.0]` release section above `[0.1.0]` with user-facing `Added`, `Changed`/`Improved`, and `Fixed` entries that account for the completed v0.2.0 feature set: task sets, theme/UI polish, Settings categories and assignments, task editing, ordering, task types, audit logging, configurable parallel runs, split-aware refinement, and relevant receipt/recovery or compatibility fixes.
- Existing `[Unreleased]` and `[0.1.0]` content remains accurate and readable; baseline v0.1.0 features are not duplicated as new v0.2.0 work, and existing release history is not rewritten or discarded.
- Claims, setting names/defaults, commands, links, images, and version references are checked against the current implementation and `package.json` (`0.2.0`). Markdown remains valid, and the documentation change does not introduce code or configuration changes outside the two requested release documents.

## Scope

- [ ] `README.md` — revise the introduction, **How It Works**, and **Quick Start** sections to explain the active task-set selector and lifecycle, typed task creation, the seven-stage workflow, the human/automatic gates, and the task-specific chat handoff without losing the existing v0.1.0 onboarding path.
- [ ] `README.md` — add or revise user-facing guidance for named task sets (Default versus additional sets, create/rename/delete restrictions, switching constraints, and per-set task/order isolation), in-board task editing (editable Markdown sections and protected metadata/Log), and within-column ordering (mouse and keyboard interaction, persistence, and separation from workflow moves).
- [ ] `README.md` — update **Features** and the visual walkthrough text to cover theme-aware UI/accessibility polish, Feature/Bug card markers and typed proposal inheritance/override, the two-pane Settings categories, the advisory refine split recommendation, the extension audit trail, and the configurable parallel-run behavior.
- [ ] `README.md` — keep the activity-log example and expand it as needed to explain extension audit lines versus agent receipts/proposals, lifecycle outcomes, UTC timestamps, late-receipt correction, and the direct-frontmatter-edit attribution limitation.
- [ ] `README.md` — reconcile the **Extension Settings**, requirements, and release sections with `package.json`, including `kanbanPilot.chat.agentNames` column/default/legacy semantics, `kanbanPilot.run.maxParallelTasks` capacity and isolation warning, task-set storage behavior, and the v0.2.0 release note; do not document settings or commands that are not contributed by the extension.
- [ ] `CHANGELOG.md` — insert a `[0.2.0]` section in Keep a Changelog style and organize concise, user-facing entries into the appropriate Added/Changed/Fixed categories. Include every completed v0.2.0 feature from TASK-001 through TASK-010 plus the shipped named-task-set capability, while avoiding implementation-only detail.
- [ ] `CHANGELOG.md` — preserve the `[Unreleased]` heading and existing `[0.1.0]` history, placing the late-completion-receipt recovery and other fixes in the correct release bucket without duplicating or silently dropping an existing entry.
- [ ] Documentation verification — cross-check every release claim against the current source, completed task records, `package.json` version/settings/commands, and existing image paths; validate Markdown links/headings and run a whitespace/diff check limited to `README.md` and `CHANGELOG.md`.

## Log
- run:r4xvizf task:TASK-011 stage:refine result:ok note:"2026-08-18T00:51:00Z — refine completed: defined complete README and CHANGELOG coverage for the v0.2.0 feature set and release verification"
- run:r7okzew task:TASK-011 stage:develop result:ok note:"2026-08-18T01:06:30Z — updated README and CHANGELOG for v0.2.0 task sets, typed cards, ordering, Settings, audit logging, parallel runs, split guidance, and release history; validated links and whitespace"
