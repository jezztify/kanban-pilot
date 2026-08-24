---
id: TASK-002
title: Update README.md and CHANGELOG.md for 0.3.3
type: feature
state: validation
status: idle
position: 0
created: 2026-08-20T13:08:46Z
updated: 2026-08-24T00:22:44Z
chat: 349e7a6b-31ee-452d-b843-f0d5365c7c77
copilot_session_id: 349e7a6b-31ee-452d-b843-f0d5365c7c77
scope_hash: 255294c
chat_reset_required: false
---

## Request
Update README.md and CHANGELOG.md for 0.3.3

## Refined

### Problem statement

The repository is documented through version 0.3.2, while the current 0.3.3 delivery adds a
user-visible Task Details improvement: Request, Refined, and Scope content now supports safe
CommonMark/GFM rendering, including Mermaid fenced diagrams. README.md and CHANGELOG.md do not
yet explain that capability or identify 0.3.3 as the current documented release, so users and
release reviewers cannot discover what changed or what behavior to expect. This ticket is limited
to accurate release and user-facing documentation; it must not alter implementation, tests,
package metadata, task-file behavior, or the existing historical release notes. Assumption: the
0.3.3 notes should cover the completed task-detail Markdown and Mermaid work represented by the
current implementation, and should not claim unrelated unreleased changes.

### Acceptance criteria

- README.md identifies 0.3.3 as the current documented release and adds or updates concise
	user-facing guidance explaining that the Task Details modal renders the Request, Refined, and
	Scope sections as readable Markdown, including Mermaid charts where applicable.
- README.md accurately describes the relevant behavior without promising editable rendered output:
	authored Markdown remains available for editing, invalid Mermaid remains a non-fatal readable
	fallback, and the existing task-detail workflow and attachment behavior are retained.
- README.md's 0.3.3 release summary matches the implemented feature set and links to the full
	history in CHANGELOG.md, while existing 0.3.2 and earlier summaries remain accurate.
- CHANGELOG.md adds a correctly placed `[0.3.3]` release entry, dated with the release date
	provided by the release context, using the existing Keep a Changelog structure and concise
	Added/Changed/Fixed categorization as appropriate.
- CHANGELOG.md's 0.3.3 entry records the safe CommonMark/GFM task-detail rendering and local
	Mermaid chart support, including source/fallback behavior and the fact that remote or unsafe
	content is not enabled; it does not claim changes outside this release.
- Only README.md, CHANGELOG.md, and the permitted task refinement sections are changed; no source,
	test, package, lockfile, image, or historical changelog content is modified.

## Scope

- [ ] `README.md` — update the current documented release from 0.3.2 to 0.3.3 and add a concise
	release summary for the task-detail Markdown/Mermaid improvement near the existing release notes.
- [ ] `README.md` — extend the Task Details/user-guide documentation where it is most discoverable
	to explain that Request, Refined, and Scope render supported CommonMark/GFM content such as
	headings, lists, checklists, tables, code, links, and task-local images, with Mermaid fences
	rendered as charts; state that Edit task continues to work from the authored Markdown source.
- [ ] `README.md` — document the user-visible resilience and safety boundaries without implementation
	detail: invalid Mermaid shows a readable fallback, unsafe or unavailable images/links do not load
	arbitrary content, and the rest of the modal remains usable. Preserve the existing workflow,
	settings, attachment, and release-process guidance.
- [ ] `CHANGELOG.md` — insert a new `## [0.3.3]` entry above 0.3.2, using the release date from
	the release context and the repository's existing heading and indentation conventions.
- [ ] `CHANGELOG.md` — summarize the completed Task Details changes in the appropriate changelog
	categories: rich safe Markdown/GFM rendering for the editable specification sections, Mermaid
	chart rendering from fenced blocks using the locally packaged runtime, readable fallback/source
	preservation for invalid diagrams, and preservation of existing task, attachment, and modal
	behavior. Keep the entry user-facing and avoid listing implementation claims not supported by
	the code.
- [ ] `CHANGELOG.md` — leave the Unreleased placeholder and all 0.3.2-and-earlier entries intact,
	and ensure the new entry is consistent with the README release summary and Keep a Changelog
	wording.
- [ ] Verification — review the rendered Markdown for heading/list/link correctness, check that
	README.md links resolve, run `git diff --check`, and confirm the final diff contains no changes
	outside README.md, CHANGELOG.md, and this task's Refined/Scope/Log sections.

## Log
- audit:state-change at:2026-08-23T23:43:14Z task:TASK-002 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-23T23:43:15Z task:TASK-002 from:idle to:running action:refine run:r3mbmyn note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-23T23:43:15Z task:TASK-002 stage:refine action:refine run:r3mbmyn note:"Started refine activity."
- run:r3mbmyn task:TASK-002 stage:refine result:ok note:"2026-08-23T23:44:55Z — refined the 0.3.3 README and CHANGELOG documentation scope for task-detail Markdown and Mermaid support"
- audit:status-change at:2026-08-23T23:45:24Z task:TASK-002 from:running to:idle action:receipt run:r3mbmyn outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-23T23:45:24Z task:TASK-002 stage:refine action:receipt run:r3mbmyn outcome:ok note:"2026-08-23T23:44:55Z — refined the 0.3.3 README and CHANGELOG documentation scope for task-detail Markdown and Mermaid support"
- audit:state-change at:2026-08-23T23:52:20Z task:TASK-002 from:refine to:scoped action:apply-pending run:r3mbmyn outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-23T23:52:23Z task:TASK-002 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-23T23:52:24Z task:TASK-002 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-23T23:52:24Z task:TASK-002 from:idle to:running action:develop run:r3p3uqt note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-23T23:52:24Z task:TASK-002 stage:develop action:develop run:r3p3uqt note:"Started develop activity."
- run:r3p3uqt task:TASK-002 stage:develop result:ok note:"2026-08-23T23:53:04Z — updated README and CHANGELOG with 0.3.3 Task Details Markdown and Mermaid release documentation"
- audit:status-change at:2026-08-23T23:58:46Z task:TASK-002 from:running to:idle action:receipt run:r3p3uqt outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-23T23:58:46Z task:TASK-002 stage:develop action:receipt run:r3p3uqt outcome:ok note:"2026-08-23T23:53:04Z — updated README and CHANGELOG with 0.3.3 Task Details Markdown and Mermaid release documentation"
- audit:state-change at:2026-08-24T00:22:44Z task:TASK-002 from:in-progress to:validation action:apply-pending run:r3p3uqt outcome:ok note:"State changed from in-progress to validation via apply-pending."
