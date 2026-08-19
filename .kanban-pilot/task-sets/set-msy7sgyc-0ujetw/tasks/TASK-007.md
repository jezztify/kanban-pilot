---
id: TASK-007
title: Update README.md and CHANGELOGS.md for 0.3.0
type: feature
state: validation
status: idle
position: 6
created: 2026-08-18T09:41:04Z
updated: 2026-08-18T09:45:11Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-007
copilot_session_id: 12a3a30d-fdef-478c-8d58-17abaa804963
scope_hash: 3969c90
chat_reset_required: false
---

## Request
Update README.md and CHANGELOGS.md for the features we createdfor 0.3.0

## Refined

### Problem statement

The repository is prepared for the 0.3.0 release, but the user-facing release documentation is
not yet aligned with the features delivered by TASK-001 through TASK-006. `README.md` still uses
0.2.0 as its current release in the release guidance/notes and contains at least one stale
description of the Agent assignments save workflow. The existing changelog is `CHANGELOG.md`
(singular) and has no 0.3.0 entry, even though the request calls it `CHANGELOGS.md`.

Update only the two existing documentation files so users and maintainers can understand the
0.3.0 behavior without changing product code, package metadata, task records, or the PRD. The
release documentation must cover the six completed work areas: the complete nine-gate
manual/auto pipeline and durable pending outcomes; Copilot custom-agent discovery and
assignment dropdowns; the full in-board settings editor; the single shared Agent assignments
Save workflow; transactional Split child-task persistence; and timeout/late-receipt recovery
with stale-run protection.

### Acceptance criteria

- `README.md` identifies 0.3.0 as the current documented release, keeps 0.2.0 as historical
	context, updates the example release tag to `v0.3.0`, and contains no contradictory stale
	current-release wording.
- The README's Gates and Settings guidance accurately describes all nine normal pipeline gates,
	their `manual` default and opt-in `auto` behavior, durable pending completion decisions, the
	explicit apply action that does not rerun an agent, and the rule that blocked/failed work is
	not automatically retried.
- The README explains that the board Settings surface covers the contributed options, that
	Copilot agents are selected from discovered workspace/global/configured profiles with legacy
	values preserved, and that Agent assignments use one category-level Save with per-column
	reset behavior rather than one Save button per row.
- The README gives concise, user-relevant recovery guidance: a successful Split persists child
	cards in the active task set before retiring the parent, while missing/invalid children leave
	the work retryable; a timed-out run may recover from a matching late receipt, but a stopped,
	moved, or newer run cannot be overwritten by stale output.
- `CHANGELOG.md` retains the existing `## [Unreleased]` section, adds a dated `## [0.3.0]`
	section above 0.2.0 using the repository's Keep a Changelog structure, and records all six
	0.3.0 work areas under clear Added, Changed, or Fixed headings without claiming unrelated
	changes.
- No `CHANGELOGS.md` file is created; the request is satisfied by the repository's existing
	`CHANGELOG.md`. No source code, `package.json`, `docs/PRD.md`, frontmatter, or other task
	metadata is changed by the implementation.
- The resulting Markdown preserves existing links and structure, passes whitespace/diff checks,
	and contains no stale or contradictory 0.2.0-versus-0.3.0 release statements.

## Scope
- [ ] `README.md` — update the release-maintainer example and Release notes section to make
	0.3.0 current, use the matching `v0.3.0` tag example, summarize the six delivered feature
	areas, and retain the 0.2.0 and 0.1.0 historical notes.
- [ ] `README.md` — audit the Gates section and the All settings table against the implemented
	nine-gate catalog and current setting keys. Document manual pending outcomes, the explicit
	apply action, no automatic retries, full in-board settings coverage, and the next-run/reload
	boundaries without inventing new configuration options.
- [ ] `README.md` — revise Agent assignments guidance to describe the discovered Copilot-agent
	dropdown (workspace `.github/agents`, configured locations, and user-level `.copilot/agents`),
	compatibility fallback for existing/missing labels, one shared Save for all seven columns,
	and the preserved per-column Reset behavior. Correct any stale per-row Save wording.
- [ ] `README.md` — add or update a concise reliability note near the workflow/run guidance for
	Split child persistence in the active task set, retryable missing-child outcomes, timeout
	fallback and matching late-receipt recovery, and protection against stale results after
	Stop, manual moves, or retries.
- [ ] `CHANGELOG.md` — insert `## [0.3.0] - 2026-08-18` immediately before the 0.2.0 release
	and group release notes into Added/Changed/Fixed entries covering the complete gate matrix and
	pending outcomes, full Settings and Copilot-agent assignment experience, shared agent Save,
	transactional Split reconciliation, and timeout/late-receipt recovery. Keep the existing
	0.2.0 and 0.1.0 history intact.
- [ ] Review the two-file diff for factual consistency with TASK-001 through TASK-006 and the
	current implementation, verify that only `README.md` and `CHANGELOG.md` are intended to
	change, and run `git diff --check` plus the repository's Markdown/link checks if available;
	do not run a code implementation pass or alter tests.

## Log
- audit:state-change at:2026-08-18T09:41:08Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T09:41:09Z task:TASK-007 from:idle to:running action:refine run:rajf57r note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T09:41:09Z task:TASK-007 stage:refine action:refine run:rajf57r note:"Started refine activity."
- run:rajf57r task:TASK-007 stage:refine result:ok note:"2026-08-18T09:42:36Z — refined the 0.3.0 README and CHANGELOG documentation scope across the six completed feature areas"
- audit:state-change at:2026-08-18T09:43:13Z task:TASK-007 from:refine to:scoped action:receipt run:rajf57r outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T09:43:13Z task:TASK-007 from:running to:idle action:receipt run:rajf57r outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T09:43:13Z task:TASK-007 stage:refine action:receipt run:rajf57r outcome:ok note:"2026-08-18T09:42:36Z — refined the 0.3.0 README and CHANGELOG documentation scope across the six completed feature areas"
- audit:state-change at:2026-08-18T09:43:15Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T09:43:17Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T09:43:17Z task:TASK-007 from:idle to:running action:develop run:rsm0bct note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T09:43:17Z task:TASK-007 stage:develop action:develop run:rsm0bct note:"Started develop activity."
- run:rsm0bct task:TASK-007 stage:develop result:ok note:"2026-08-18T09:44:48Z — updated README and CHANGELOG for the 0.3.0 feature set and verified the documentation diff"
- audit:state-change at:2026-08-18T09:45:11Z task:TASK-007 from:in-progress to:validation action:receipt run:rsm0bct outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T09:45:11Z task:TASK-007 from:running to:idle action:receipt run:rsm0bct outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T09:45:11Z task:TASK-007 stage:develop action:receipt run:rsm0bct outcome:ok note:"2026-08-18T09:44:48Z — updated README and CHANGELOG for the 0.3.0 feature set and verified the documentation diff"
