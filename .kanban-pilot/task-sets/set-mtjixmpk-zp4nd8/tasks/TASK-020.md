---
id: TASK-020
title: Update README and CHANGELOG
type: feature
state: done
status: idle
position: 17
created: 2026-09-06T02:44:35Z
updated: 2026-09-06T03:17:09Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-020
copilot_session_id: aa8f9b85-c8d1-4be9-918d-1872421d32c9
scope_hash: 112b49e
chat_reset_required: false
---

## Request
Update README and CHANGELOG.
Ensure to add screenshots about the new Central Registry at http://100.123.172.119:54099

## Refined

Document the new Central Registry experience so a new Kanban Pilot user can find the live-workspace directory, understand how selecting a workspace opens its browser board, and recognize the security boundary around the shared HTTP service. The README should use the supplied Registry deployment as the concrete demonstration target and include visual proof of both the directory and the resulting board. The CHANGELOG should record this documentation update under Unreleased. This is documentation-only work; it must not change extension behavior or runtime code.

### SPLIT RECOMMENDATION

SPLIT RECOMMENDATION: NO SPLIT — 1 feature: publish Central Registry documentation and release notes with supporting screenshots.

### Acceptance Criteria

- README explains the Central Registry workflow: open the Registry or use **Kanban Pilot: Share**, view live workspaces, select one, and follow the redirect to that workspace's browser board.
- README identifies `http://100.123.172.119:54099` as the current demonstration Registry URL and clearly labels it as deployment-specific plain HTTP access rather than a universal configuration default.
- README explains that the Registry lists discovery metadata and connection links, while board authentication, task data, and board actions remain on the board endpoint; the existing trusted-network/TLS warning remains clear.
- README embeds two readable, captioned, accessible screenshots: the Central Registry directory and the browser board reached from it. The image references resolve from the repository, and screenshots do not expose bearer tokens, credentials, or accidental private deployment data.
- CHANGELOG records the Central Registry documentation and screenshots under `## [Unreleased]` using the existing Keep a Changelog structure, without altering prior release entries.
- No source, configuration, task behavior, or existing image is changed as part of this ticket.

## Scope

- [ ] `README.md`: revise the shared-workspaces section to name the Central Registry, link or point to the supplied demonstration URL, describe the Registry-to-board flow, and retain the token/privacy and HTTP/TLS caveats already documented by the project.
- [ ] `README.md`: add a focused Central Registry subsection with captions and alt text for the two new screenshots, placed near the existing board screenshots.
- [ ] `docs/media/central-registry-directory.png`: add a screenshot captured from `http://100.123.172.119:54099` showing the live-workspace directory; crop or redact browser chrome, credentials, bearer tokens, and any deployment-specific/private values that should not be published.
- [ ] `docs/media/central-registry-board.png`: add a screenshot of the browser board reached by selecting a workspace from the Registry; keep the board view legible and exclude the token-bearing address-bar value and other sensitive data.
- [ ] `CHANGELOG.md`: replace the Unreleased placeholder with an `Added` entry covering the Central Registry documentation and screenshots; preserve the existing release history and formatting.
- [ ] Verify the Markdown renders, both image paths load, captions/alt text describe the correct views, the supplied Registry URL was the capture source, and no runtime files require changes.

## Log
- audit:state-change at:2026-09-06T02:44:36Z task:TASK-020 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-06T02:44:37Z task:TASK-020 from:idle to:running action:refine run:rhevmga note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-06T02:44:37Z task:TASK-020 stage:refine action:refine run:rhevmga note:"Started refine activity."
- progress run:rhevmga task:TASK-020 at:2026-09-06T02:46:25Z note:"grounded the documentation and screenshot scope in the current Registry and board experience"
- run:rhevmga task:TASK-020 stage:refine result:ok note:"2026-09-06T02:46:25Z — refined the README and changelog scope around the Central Registry and two sanitized screenshots"
- run:rhevmga task:TASK-020 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-06T02:45:16Z task:TASK-020 from:running to:blocked action:missing-receipt run:rhevmga outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-09-06T02:45:16Z task:TASK-020 stage:refine run:rhevmga outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-06T02:46:53Z task:TASK-020 from:blocked to:idle action:late-receipt run:rhevmga outcome:ok note:"Status changed from blocked to idle via late-receipt."
- audit:activity-finish at:2026-09-06T02:46:53Z task:TASK-020 stage:refine action:late-receipt run:rhevmga outcome:ok correction:true note:"2026-09-06T02:46:25Z — refined the README and changelog scope around the Central Registry and two sanitized screenshots"
- audit:state-change at:2026-09-06T02:47:33Z task:TASK-020 from:refine to:scoped action:apply-pending run:rhevmga outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-06T02:47:43Z task:TASK-020 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-06T02:47:45Z task:TASK-020 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-06T02:47:45Z task:TASK-020 from:idle to:running action:develop run:rmatkai note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-06T02:47:45Z task:TASK-020 stage:develop action:develop run:rmatkai note:"Started develop activity."
- progress run:rmatkai task:TASK-020 at:2026-09-06T02:51:19Z note:"captured sanitized Registry directory and browser board screenshots"
- run:rmatkai task:TASK-020 stage:develop result:ok note:"2026-09-06T02:53:22Z — implemented the Central Registry README and changelog updates and added two sanitized screenshots; Markdown and image checks passed"
- implementation-evidence run:rmatkai files:"README.md, CHANGELOG.md, docs/media/central-registry-directory.png, docs/media/central-registry-board.png" verify:"git diff --check; Markdown and image-reference checks; PNG file validation"
- receipt-diagnostic kind:run-mismatch task:TASK-020 expected-run:rmatkai expected-stage:develop actual-run:rhevmga actual-task:TASK-020 actual-stage:refine note:"Ignored receipt because run id rhevmga is stale; expected rmatkai."
- run:rmatkai task:TASK-020 stage:develop result:blocked note:"interrupted by window reload; no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-06T02:50:16Z task:TASK-020 from:running to:blocked action:missing-receipt run:rmatkai outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-09-06T02:50:16Z task:TASK-020 stage:develop run:rmatkai outcome:missing-receipt provisional:true note:"interrupted by window reload; no receipt found; awaiting late receipt"
- audit:activity-finish at:2026-09-06T02:53:30Z task:TASK-020 stage:develop action:late-receipt run:rmatkai outcome:blocked correction:true note:"Develop completion requires implementation evidence with changed files and verification."
- audit:status-change at:2026-09-06T03:00:04Z task:TASK-020 from:blocked to:idle action:continue note:"Status changed from blocked to idle via continue."
- audit:status-change at:2026-09-06T03:00:04Z task:TASK-020 from:idle to:running action:continue run:r5kly36 note:"Status changed from idle to running via continue."
- audit:activity-start at:2026-09-06T03:00:04Z task:TASK-020 stage:develop action:continue run:r5kly36 note:"Started develop activity."
- progress run:r5kly36 task:TASK-020 at:2026-09-06T03:02:13Z note:"rechecking the documentation and recording retry evidence"
- implementation-evidence run:r5kly36 files:"README.md, CHANGELOG.md, docs/media/central-registry-directory.png, docs/media/central-registry-board.png" verify:"git diff --check; README and screenshot-reference checks; post-baseline hash check"
- run:r5kly36 task:TASK-020 stage:develop result:ok note:"2026-09-06T03:02:40Z — completed the Central Registry README and changelog documentation with two sanitized screenshots; retry validation passed"
- receipt-diagnostic kind:run-mismatch task:TASK-020 expected-run:r5kly36 expected-stage:develop actual-run:rhevmga actual-task:TASK-020 actual-stage:refine note:"Ignored receipt because run id rhevmga is stale; expected r5kly36."
- receipt-diagnostic kind:run-mismatch task:TASK-020 expected-run:r5kly36 expected-stage:develop actual-run:rmatkai actual-task:TASK-020 actual-stage:develop note:"Ignored receipt because run id rmatkai is stale; expected r5kly36."
- run:r5kly36 task:TASK-020 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-06T03:02:39Z task:TASK-020 from:running to:blocked action:missing-receipt run:r5kly36 outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-09-06T03:02:39Z task:TASK-020 stage:develop run:r5kly36 outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-06T03:02:50Z task:TASK-020 from:blocked to:idle action:late-receipt run:r5kly36 outcome:ok note:"Status changed from blocked to idle via late-receipt."
- audit:activity-finish at:2026-09-06T03:02:50Z task:TASK-020 stage:develop action:late-receipt run:r5kly36 outcome:ok correction:true note:"2026-09-06T03:02:40Z — completed the Central Registry README and changelog documentation with two sanitized screenshots; retry validation passed"
- audit:state-change at:2026-09-06T03:16:39Z task:TASK-020 from:in-progress to:scoped action:move note:"State changed from in-progress to scoped via move."
- audit:state-change at:2026-09-06T03:16:44Z task:TASK-020 from:scoped to:in-progress action:move note:"State changed from scoped to in-progress via move."
- audit:state-change at:2026-09-06T03:17:09Z task:TASK-020 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
