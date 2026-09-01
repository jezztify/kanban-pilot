# Where your tasks live

```
.kanban-pilot/
├─ tasks/                    # the Default task set
├─ task-sets/<id>/tasks/     # each named set
├─ task-sets.json            # which sets exist, and which one is active
└─ prompts/                  # your stage prompts (yours to edit; never overwritten)
```

Each task is one Markdown file: a bit of frontmatter (id, type, column, status) plus **Request**,
**Refined**, **Scope**, and an append-only **Log**.

## Attach images to a task

The **New Task** and **Edit task** dialogs accept one or more PNG, JPEG, GIF, or WebP images up to
10 MiB each. Use **Attach image** to choose files, or paste an image into the focused Description,
Request, Refined, or Scope field. Each image is previewed immediately, inserted at the caret, and
can be removed before saving. Ordinary text paste is unchanged.

Images are durable task-owned files, not data embedded in frontmatter or the log. For example:

```
.kanban-pilot/tasks/
├─ TASK-009.md
└─ TASK-009.attachments/
   └─ browser-screenshot.png
```

The Markdown section contains a relative link such as
`![browser-screenshot](TASK-009.attachments/browser-screenshot.png)`. Named task sets use the
same layout under `.kanban-pilot/task-sets/<id>/tasks`, so attachments never cross task sets.
The extension validates MIME type, magic bytes, size, and generated safe names before an atomic
save; SVG, remote images, raw HTML, arbitrary filesystem paths, and invalid or missing assets are
not rendered as local images. Cancel, Escape, backdrop dismissal, and failed saves leave staged
files untouched. Deleting a task removes only its own attachment directory, while legacy and
text-only tasks remain compatible.

Refine, Develop, Continue, and Validate attach the task Markdown first and its referenced images
in Markdown order. Agents are told to treat those images as read-only task context unless the
task Scope explicitly permits modifying them. If automatic chat injection is unavailable, the
existing clipboard fallback remains text-only. Valid supported images referenced by the current
task render in its detail view through safe webview resources; missing, corrupt, cross-task,
remote, SVG, raw-HTML, and other unsafe references remain an unavailable placeholder rather than
being loaded from an arbitrary path.

## The activity log

The `## Log` section is a running history that both Kanban Pilot and the agent write to. Agent
results appear as `- run:...` lines; Kanban Pilot's own audit entries use `- audit:...` with UTC
timestamps:

```text
- audit:state-change at:2026-08-17T10:00:00Z task:TASK-142 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:activity-start at:2026-08-17T10:00:01Z task:TASK-142 stage:refine action:refine run:r7 note:"Started refine activity."
- audit:activity-finish at:2026-08-17T10:00:12Z task:TASK-142 stage:refine action:receipt run:r7 outcome:ok note:"scope written, 3 files"
```

Every run records one start and one finish — success, failure, timeout, stop, or manual
completion. If a result arrives late, Kanban Pilot reconciles it, provided a newer retry or a
manual move hasn't already taken over. Receipt lines must match the expected task, run, and stage;
rejected or malformed lines produce a diagnostic instead of silently completing the card. Hand
edits you make directly to a task file are fully supported, but they won't produce audit lines: a
file watcher can't tell what the old value was or who changed it.

Agents can also append coarse `- progress ...` summaries while a run is active. Task Details
shows this activity read-only, and connected browser boards receive updates through the same live
board projection. Progress is deliberately not a Copilot transcript: summaries must not contain
source, secrets, paths, or tokens, and they cannot complete a run or approve an action. If a task
is blocked, return to the host VS Code window for any Copilot Chat interaction or tool approval.

