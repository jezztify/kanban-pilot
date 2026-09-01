---
id: TASK-020
title: Update README and CHANGELOGS for 0.4.3
type: feature
state: in-progress
status: idle
position: 0
created: 2026-09-02T02:17:48Z
updated: 2026-09-02T02:31:05Z
pending_outcome: {"gate":"developToValidation","stage":"develop","result":"ok","runId":"rwxnn26"}
chat: kanban-pilot-set-mtif7kxz-y9eglj-TASK-020
copilot_session_id: 9c942839-c5ae-4458-9194-25cb97a050db
scope_hash: 07b0ca5
chat_reset_required: false
---

## Request
Update README and CHANGELOGS for 0.4.3

## Refined

### Problem statement

The package is versioned as 0.4.3, but the release documentation still identifies 0.4.2 as current and does not explain the newly shipped opt-in Copilot hook activity feed. Users need a clear, accurate path for configuring the existing hook receiver, understanding the difference between hook, transcript, and progress activity, and deciding whether activity should be forwarded to the shared browser board. This is a documentation-only release update based on the behavior already implemented in the repository; it must not add installation automation or change product behavior.

### Acceptance criteria

- `CHANGELOG.md` adds a new `0.4.3` release section dated `2026-09-02` above `0.4.2`, summarizing the opt-in real-time hook feed, its related feed settings, and the local-versus-remote privacy boundary without rewriting earlier entries.
- `README.md` identifies `0.4.3` as the current documented release and includes a discoverable setup path for `scripts/kanban-pilot-hook.mjs`, using workspace-local `.claude/settings.local.json`, the `.kanban-pilot/.hook-spool.jsonl` spool, the supported event subscriptions, and `kanbanPilot.chat.hookFeed`.
- README guidance distinguishes live hook activity from delayed transcript activity and coarse progress summaries, states that hook entries contain bounded structural metadata rather than a Copilot transcript, and documents that failures are fail-open and do not block Copilot turns.
- README guidance states that tool arguments, tool output, prompt content beyond task attribution, and transcript contents are not exposed, and does not imply that unsupported editor events such as `PermissionRequest` are available.
- The README settings table documents `chat.hookFeed`, `chat.transcriptFeed`, and `chat.transcriptFeedRemote` with their false defaults and explains that browser delivery also requires the existing HTTP endpoint and the separate remote opt-in.
- The implementation changes only `README.md` and `CHANGELOG.md`; no source, manifest, lockfile, test, attachment, or task frontmatter changes are required.

## Scope
- [ ] `README.md`: add a concise optional hook-feed/activity section near the existing activity-log guidance, covering the feature's purpose, hook-versus-transcript timing, manual configuration in `.claude/settings.local.json`, the `UserPromptSubmit`, `PostToolUse`, and `Stop` subscriptions, the absolute receiver command and spool path, opt-in behavior, cleanup/absence behavior, redaction, fail-open behavior, and the separate browser-sharing consent.
- [ ] `README.md`: add the `chat.hookFeed`, `chat.transcriptFeed`, and `chat.transcriptFeedRemote` rows to the All settings table with accurate defaults, interactions, and the existing HTTP token/security warning context.
- [ ] `README.md`: change the current documented release to 0.4.3 and add a 0.4.3 release-note summary that matches the shipped hook-feed behavior without claiming automatic hook installation or unavailable approval notifications.
- [ ] `CHANGELOG.md`: add a `[0.4.3] - 2026-09-02` section above 0.4.2 in the existing Keep a Changelog format, describing the real-time hook feed, related settings, and local/remote privacy boundary in user-facing terms.
- [ ] Verify the two Markdown files for consistent version, setting names, script path, spool path, event names, and remote opt-in wording; run `git diff --check -- README.md CHANGELOG.md` and inspect headings, tables, and the setup example for valid Markdown.

## Log
- audit:state-change at:2026-09-02T02:18:00Z task:TASK-020 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-02T02:18:01Z task:TASK-020 from:idle to:running action:refine run:rzes4od note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-02T02:18:01Z task:TASK-020 stage:refine action:refine run:rzes4od note:"Started refine activity."
- progress run:rzes4od task:TASK-020 at:2026-09-02T02:21:00Z note:"documented the 0.4.3 release-documentation scope"
- run:rzes4od task:TASK-020 stage:refine result:ok note:"2026-09-02T02:21:00Z — refine completed: scoped README and CHANGELOG updates for the opt-in hook feed"
- audit:status-change at:2026-09-02T02:21:41Z task:TASK-020 from:running to:idle action:receipt run:rzes4od outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-02T02:21:41Z task:TASK-020 stage:refine action:receipt run:rzes4od outcome:ok note:"2026-09-02T02:21:00Z — refine completed: scoped README and CHANGELOG updates for the opt-in hook feed"
- audit:state-change at:2026-09-02T02:24:30Z task:TASK-020 from:refine to:scoped action:apply-pending run:rzes4od outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-02T02:24:34Z task:TASK-020 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-02T02:24:35Z task:TASK-020 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-02T02:24:35Z task:TASK-020 from:idle to:running action:develop run:rwxnn26 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-02T02:24:35Z task:TASK-020 stage:develop action:develop run:rwxnn26 note:"Started develop activity."
- run:rwxnn26 task:TASK-020 stage:develop result:ok note:"2026-09-02T02:26:51Z - develop completed: updated README.md and CHANGELOG.md for 0.4.3; documentation checks passed"
- audit:status-change at:2026-09-02T02:31:05Z task:TASK-020 from:running to:idle action:receipt run:rwxnn26 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-02T02:31:05Z task:TASK-020 stage:develop action:receipt run:rwxnn26 outcome:ok note:"2026-09-02T02:26:51Z - develop completed: updated README.md and CHANGELOG.md for 0.4.3; documentation checks passed"
