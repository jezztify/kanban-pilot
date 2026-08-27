---
id: TASK-009
title: Update README and CHANGELOGS for 0.4.1
type: feature
state: in-progress
status: idle
position: 7
created: 2026-08-26T21:16:22Z
updated: 2026-08-27T02:01:16Z
pending_outcome: {"gate":"developToValidation","stage":"develop","result":"ok","runId":"rbksm71"}
chat: 318f67a2-a6da-420b-ae0f-7f678dce7044
copilot_session_id: 318f67a2-a6da-420b-ae0f-7f678dce7044
scope_hash: 4312d7c
chat_reset_required: false
---

## Request
Update README and CHANGELOGS for 0.4.1

## Refined

### Problem statement

The extension manifest and lockfile have been prepared for version 0.4.1, but
the published documentation still identifies 0.4.0 as the current release and
the changelog has no 0.4.1 entry. Document the user-visible changes already
implemented for 0.4.1 so release notes, README guidance, and the package
version describe the same release without altering product code or release
automation.

### Acceptance criteria

- `README.md` identifies **0.4.1** as the current documented release.
- `README.md` adds a concise 0.4.1 release-note summary covering the
	additional custom-agent directories setting and the user-visible board,
	detail-refresh, Mermaid safety/theme, and real-time endpoint reliability
	improvements included in this release.
- `CHANGELOG.md` contains a new dated `0.4.1` section immediately below
	`Unreleased`, following the existing Keep a Changelog headings and clearly
	separating added, changed, and fixed items as appropriate.
- The changelog entry accurately reflects the implemented 0.4.1 work: configured
	custom-agent directory discovery, resilient live board/detail refreshes that
	preserve active dialogs and scroll position, safer theme-aware Mermaid
	rendering, and realtime endpoint event-stream/revision handling.
- The `Unreleased` placeholder and historical release notes remain intact, and
	no application source, tests, package metadata, or release workflow files are
	changed by this documentation-only ticket.

## Scope

- [ ] `README.md` — update the **Release notes** section to name 0.4.1 as the
	current documented release and insert a concise 0.4.1 summary ahead of 0.4.0;
	retain the existing release history and release-process instructions.
- [ ] `README.md` — ensure the configuration reference and agent-assignment
	guidance consistently describe `chat.agentDirectories`, including accepted
	path forms and its relationship to VS Code's agent-file locations.
- [ ] `CHANGELOG.md` — add a dated `## [0.4.1]` entry directly after
	`## [Unreleased]`, using the established Added/Changed/Fixed structure to
	record the release's custom-agent-directory, live-refresh/modal-and-scroll,
	Mermaid rendering, and realtime endpoint changes.
- [ ] `README.md` and `CHANGELOG.md` — review the final wording against the
	current 0.4.1 manifest and implemented behavior; do not modify source, tests,
	`package.json`, `package-lock.json`, or CI/release configuration.

## Log
- audit:state-change at:2026-08-26T21:16:24Z task:TASK-009 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T23:46:37Z task:TASK-009 from:idle to:running action:refine run:rtl3ro6 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T23:46:37Z task:TASK-009 stage:refine action:refine run:rtl3ro6 note:"Started refine activity."
- run:rtl3ro6 task:TASK-009 stage:refine result:ok note:"Scoped the README and changelog updates required to document the 0.4.1 release."
- audit:status-change at:2026-08-26T23:47:33Z task:TASK-009 from:running to:idle action:receipt run:rtl3ro6 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T23:47:33Z task:TASK-009 stage:refine action:receipt run:rtl3ro6 outcome:ok note:"Scoped the README and changelog updates required to document the 0.4.1 release."
- audit:state-change at:2026-08-27T01:58:25Z task:TASK-009 from:refine to:scoped action:apply-pending run:rtl3ro6 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-27T01:58:26Z task:TASK-009 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-27T01:58:28Z task:TASK-009 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-27T01:58:28Z task:TASK-009 from:idle to:running action:develop run:rbksm71 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-27T01:58:28Z task:TASK-009 stage:develop action:develop run:rbksm71 note:"Started develop activity."
- run:rbksm71 task:TASK-009 stage:develop result:ok note:"2026-08-27T02:00:57Z — documented the 0.4.1 release in the README and changelog."
- audit:status-change at:2026-08-27T02:01:16Z task:TASK-009 from:running to:idle action:receipt run:rbksm71 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-27T02:01:16Z task:TASK-009 stage:develop action:receipt run:rbksm71 outcome:ok note:"2026-08-27T02:00:57Z — documented the 0.4.1 release in the README and changelog."
