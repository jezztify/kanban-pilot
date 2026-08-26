---
id: TASK-010
title: Update README and CHANGELOGS for 0.4.0
type: feature
state: validation
status: idle
position: 3
created: 2026-08-26T08:05:34Z
updated: 2026-08-26T09:51:30Z
chat: 69ac62d5-5745-48fe-8a61-cfe66f40041a
copilot_session_id: 69ac62d5-5745-48fe-8a61-cfe66f40041a
scope_hash: 739a5ee
chat_reset_required: false
---

## Request
Update README and CHANGELOGS for 0.4.0

## Refined

### Problem statement

The repository documentation still identifies 0.3.3 as the current release and the changelog
contains no record of the 0.4.0 work now present in the release branch. Update the user-facing
release documentation so 0.4.0 accurately summarizes the authenticated real-time HTTP/browser
board, browser activity feed, LAN sharing support, and the associated reliability fixes, without
rewriting earlier release history or claiming that the browser mirrors or controls the private
Copilot Chat transcript.

For this ticket, “CHANGELOGS” means the repository's single `CHANGELOG.md`; no additional
changelog file exists. Version metadata and release packaging are outside this documentation-only
scope.

### Acceptance criteria

- `README.md` identifies 0.4.0 as the current documented release and adds a concise 0.4.0 summary
	above the retained 0.3.3-and-earlier release notes.
- The README's feature and release wording accurately describes the optional token-authenticated
	HTTP endpoint as another surface over the existing board, including the browser board, live
	updates, task actions, read-only agent progress, QR/share URL, and LAN/public URL behavior.
- Documentation preserves the security and capability boundaries: non-loopback HTTP exposure is
	warned as non-TLS/token-in-URL, the browser does not mirror the private Copilot transcript, and
	editor-only chat/file actions are not presented as browser capabilities.
- `CHANGELOG.md` retains `## [Unreleased]`, adds a dated `## [0.4.0] - 2026-08-26` section before
	0.3.3, and groups the release notes under appropriate Added, Changed, and Fixed headings.
- The 0.4.0 changelog records the canonical browser-board endpoint and authenticated API/SSE
	transport, progress activity feed, wildcard-bind LAN sharing, card-level Copilot cancellation,
	browser board compile/runtime contract repair, and Task Details scroll preservation.
- Existing 0.3.3-and-earlier entries remain intact, links and Markdown remain valid, and README
	and changelog terminology agree with the implemented settings and endpoint behavior.

## Scope

- [ ] `README.md` — change the current documented release from 0.3.3 to 0.4.0 and insert a compact
	0.4.0 release summary before the existing historical summaries.
- [ ] `README.md` — review the HTTP endpoint, sharing, activity-log, Stop/recovery, and settings
	sections for consistency with 0.4.0; make only targeted corrections needed to cover the
	token-authenticated canonical browser board, live snapshots/actions, progress feed, wildcard
	LAN URL selection, non-loopback security warning, and editor-only chat boundary.
- [ ] `CHANGELOG.md` — preserve the Unreleased placeholder and all prior release sections, then add
	`## [0.4.0] - 2026-08-26` immediately above 0.3.3.
- [ ] `CHANGELOG.md` — add categorized Added/Changed/Fixed bullets covering the completed 0.4.0
	work: real-time browser board and authenticated HTTP/API/SSE surface, per-browser board sessions
	and progress feed, LAN-friendly wildcard sharing, targeted Stop cancellation, shared board
	surface/compile repair, and same-task Task Details scroll preservation.
- [ ] Cross-check both documents against the implemented configuration names and behavior in
	`package.json`, `src/http/`, `src/board/`, and `src/chat/`; avoid release claims for unsupported
	transcript mirroring, remote chat control, TLS, or unrelated unreleased work.
- [ ] Review the final Markdown for consistent version/date wording, valid internal links, intact
	historical entries, and no accidental package-version or product-code changes.

## Log
- audit:state-change at:2026-08-26T08:05:38Z task:TASK-010 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T08:05:39Z task:TASK-010 from:idle to:running action:refine run:rdta63r note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T08:05:39Z task:TASK-010 stage:refine action:refine run:rdta63r note:"Started refine activity."
- run:rdta63r task:TASK-010 stage:refine result:ok note:"2026-08-26T08:06:37Z — scoped accurate README and changelog coverage for the 0.4.0 browser-board release and reliability fixes"
- audit:status-change at:2026-08-26T08:07:08Z task:TASK-010 from:running to:idle action:receipt run:rdta63r outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T08:07:08Z task:TASK-010 stage:refine action:receipt run:rdta63r outcome:ok note:"2026-08-26T08:06:37Z — scoped accurate README and changelog coverage for the 0.4.0 browser-board release and reliability fixes"
- audit:state-change at:2026-08-26T08:09:40Z task:TASK-010 from:refine to:scoped action:apply-pending run:rdta63r outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T08:31:19Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T08:31:20Z task:TASK-010 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T08:31:20Z task:TASK-010 from:idle to:running action:develop run:runk0oy note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T08:31:20Z task:TASK-010 stage:develop action:develop run:runk0oy note:"Started develop activity."
- progress run:runk0oy task:TASK-010 at:2026-08-26T08:37:53Z note:"Updated and cross-checked the 0.4.0 release documentation and changelog."
- run:runk0oy task:TASK-010 stage:develop result:ok note:"2026-08-26T08:37:53Z — documented the 0.4.0 browser board, sharing, progress, cancellation, and reliability changes in README and CHANGELOG"
- audit:status-change at:2026-08-26T08:38:19Z task:TASK-010 from:running to:idle action:receipt run:runk0oy outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T08:38:19Z task:TASK-010 stage:develop action:receipt run:runk0oy outcome:ok note:"2026-08-26T08:37:53Z — documented the 0.4.0 browser board, sharing, progress, cancellation, and reliability changes in README and CHANGELOG"
- audit:state-change at:2026-08-26T09:51:30Z task:TASK-010 from:in-progress to:validation action:apply-pending run:runk0oy outcome:ok note:"State changed from in-progress to validation via apply-pending."
