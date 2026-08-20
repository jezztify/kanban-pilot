---
id: TASK-006
title: Update README.md and CHANGELOGS for 0.3.2
type: feature
state: validation
status: idle
position: 6
created: 2026-08-20T09:45:20Z
updated: 2026-08-20T11:45:53Z
chat: 165e8830-9293-4c3d-9a38-a73a09a35cdd
copilot_session_id: 165e8830-9293-4c3d-9a38-a73a09a35cdd
scope_hash: 76c2d3f
chat_reset_required: false
---

## Request
Update README.md and CHANGELOGS for 0.3.2

## Refined

### Problem statement

The repository is being prepared for the 0.3.2 release, but its user-facing release
documentation still identifies 0.3.0 as current and `CHANGELOG.md` has no entries for the
tagged 0.3.1 release or the 0.3.2 work. The request says `CHANGELOGS`, but the repository's
canonical file is the singular `CHANGELOG.md`; no second changelog should be created.

The documentation must describe the completed 0.3.2 work represented by the active release
task set without exposing implementation-only details or claiming behavior that is not present:
strict task/run/stage receipt reconciliation and diagnostics; same-run late completion handling
and explicit human-confirmed stale-completion recovery; durable task-to-chat bindings across
reloads; concurrent task execution without a backend server; secure rendering of valid task-local
images; discovery of Copilot and Claude agent profiles in supported folders; and clearer
`Review Required` wording for pending outcomes. It must also retain an accurate, non-duplicated
release history for the already-tagged 0.3.1 and existing 0.3.0 releases.

### Acceptance criteria

- `README.md` identifies 0.3.2 as the current documented release, uses `v0.3.2` in the release
	procedure example, retains the prior release notes as historical context, and contains no
	contradictory statement that 0.3.0 is current.
- The README's release notes and relevant workflow sections accurately explain the 0.3.2 user
	impact: exact receipt identity checks and actionable mismatch diagnostics; idempotent same-run
	late-receipt handling; human-confirmed stale-completion recovery that does not automatically
	adopt output from a stopped, moved, or newer run; durable chat reuse after board/window reload;
	parallel runs governed by `run.maxParallelTasks` without adding a backend server; valid
	task-owned image rendering with safe unavailable behavior for invalid images; expanded agent
	profile discovery; and `Review Required` pending-outcome wording while preserving the existing
	apply decision flow.
- Agent-discovery documentation names the supported workspace `.github/agents` and
	`.claude/agents` folders, configured agent-file locations, and user-level `~/.copilot/agents`
	and `~/.claude/agents` folders as applicable to the implementation; it explains
	collision/legacy-label compatibility at a user level and does not promise unsupported profile
	sources.
- `CHANGELOG.md` retains `## [Unreleased]`, adds a dated `[0.3.2]` section above older releases
	with concise `Added`, `Changed`, and/or `Fixed` entries covering the completed 0.3.2 work, and
	adds a separate dated `[0.3.1]` historical section for the tagged 0.3.1 changes rather than
	misattributing them to 0.3.2. Existing 0.3.0, 0.2.0, and 0.1.0 history remains intact.
- Only `README.md` and the existing `CHANGELOG.md` are intended for the later implementation;
	no `CHANGELOGS.md`, source code, package metadata, PRD, tests, task frontmatter, attachments,
	or other task records are changed.
- Markdown headings, internal links, release ordering, wording, and whitespace are reviewed;
	`git diff --check` and any available documentation/link checks pass, and the final diff is
	limited to the two documentation files.

## Scope
- [ ] `README.md` — update the release procedure example to `v0.3.2`, change the current
	documented-release statement to 0.3.2, add a concise 0.3.2 release note, and preserve the
	0.3.0/0.2.0/0.1.0 historical notes without duplicating release claims.
- [ ] `README.md` — audit and revise the user-facing workflow, recovery, concurrency, chat,
	attachments, Settings, and pending-outcome guidance to cover strict receipt identity and
	diagnostics; eligible late receipts; explicit stale-completion recovery and its confirmation,
	supersession, gate, and idempotence safeguards; persisted chat bindings across reloads and task
	set isolation; response-independent parallel runs with no backend server and the shared-working-
	tree warning; safe task-local image rendering; supported Copilot/Claude agent discovery and
	legacy-label fallback; and the `Review Required` label without changing product behavior.
- [ ] `CHANGELOG.md` — preserve the existing Keep a Changelog structure and `Unreleased` section;
	insert `## [0.3.2] - 2026-08-20` above the older releases and organize user-facing entries for
	receipt/recovery safety, durable chat sessions, parallel execution, attachment rendering,
	agent-folder discovery, and pending-outcome wording.
- [ ] `CHANGELOG.md` — insert a separate `## [0.3.1] - 2026-08-19` entry for the tagged release's
	known smaller-view, image-paste, and parallel-task follow-up changes, keeping those notes
	distinct from the 0.3.2 changes and leaving all earlier release entries unchanged.
- [ ] Documentation verification — cross-check every statement against the current `package.json`,
	README sections, implementation and completed 0.3.2 task records; validate Markdown links and
	headings, run `git diff --check` (and any available Markdown/link check), and confirm that no
	file outside `README.md` and `CHANGELOG.md` is part of the documentation change.

## Log
- audit:state-change at:2026-08-20T10:40:10Z task:TASK-006 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T10:40:12Z task:TASK-006 from:idle to:running action:refine run:r4bs0hi note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T10:40:12Z task:TASK-006 stage:refine action:refine run:r4bs0hi note:"Started refine activity."
- audit:status-change at:2026-08-20T10:40:18Z task:TASK-006 from:running to:idle action:stop run:r4bs0hi outcome:stopped note:"Status changed from running to idle via stop."
- audit:activity-finish at:2026-08-20T10:40:18Z task:TASK-006 stage:refine action:stop run:r4bs0hi outcome:stopped note:"Activity stopped by the user."
- audit:state-change at:2026-08-20T10:40:22Z task:TASK-006 from:refine to:backlog action:move note:"State changed from refine to backlog via move."
- audit:state-change at:2026-08-20T11:19:34Z task:TASK-006 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-20T11:19:35Z task:TASK-006 from:idle to:running action:refine run:rxq095s note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-20T11:19:35Z task:TASK-006 stage:refine action:refine run:rxq095s note:"Started refine activity."
- run:rxq095s task:TASK-006 stage:refine result:ok note:"2026-08-20T11:21:18Z — refined the README and CHANGELOG-only 0.3.2 release documentation scope across the completed receipt, recovery, chat, concurrency, attachment, agent-discovery, and pending-outcome work"
- audit:status-change at:2026-08-20T11:28:44Z task:TASK-006 from:running to:idle action:receipt run:rxq095s outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T11:28:44Z task:TASK-006 stage:refine action:receipt run:rxq095s outcome:ok note:"2026-08-20T11:21:18Z — refined the README and CHANGELOG-only 0.3.2 release documentation scope across the completed receipt, recovery, chat, concurrency, attachment, agent-discovery, and pending-outcome work"
- audit:state-change at:2026-08-20T11:29:31Z task:TASK-006 from:refine to:scoped action:apply-pending run:rxq095s outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-20T11:29:34Z task:TASK-006 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-20T11:29:35Z task:TASK-006 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-20T11:29:35Z task:TASK-006 from:idle to:running action:develop run:rpd3xjg note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-20T11:29:35Z task:TASK-006 stage:develop action:develop run:rpd3xjg note:"Started develop activity."
- run:rpd3xjg task:TASK-006 stage:develop result:ok note:"2026-08-20T11:31:42Z — updated README and CHANGELOG for the 0.3.2 release, documented 0.3.1 history, and verified links, headings, and whitespace"
- audit:status-change at:2026-08-20T11:32:34Z task:TASK-006 from:running to:idle action:receipt run:rpd3xjg outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-20T11:32:34Z task:TASK-006 stage:develop action:receipt run:rpd3xjg outcome:ok note:"2026-08-20T11:31:42Z — updated README and CHANGELOG for the 0.3.2 release, documented 0.3.1 history, and verified links, headings, and whitespace"
- audit:state-change at:2026-08-20T11:45:53Z task:TASK-006 from:in-progress to:validation action:apply-pending run:rpd3xjg outcome:ok note:"State changed from in-progress to validation via apply-pending."
