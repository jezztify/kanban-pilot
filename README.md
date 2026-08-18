# Kanban Pilot

A Kanban-first driver for Copilot Chat. The board is the control plane; chat is the execution
surface — you interact with cards (accept, refine, approve, develop), and the extension
composes and injects the right prompt into Copilot Chat at the right moment.

Each task is a durable, git-diffable markdown file on disk. The board is a live projection of
the active task set: editing a task file by hand moves the card, and moving the card rewrites the
file. The immutable **Default** set uses `.kanban-pilot/tasks`; additional named sets use their
own `.kanban-pilot/task-sets/<id>/tasks` folders, so tasks and their within-column ordering stay
isolated from one another.

## How It Works

Kanban Pilot is a VS Code extension for driving GitHub Copilot Chat. It does not replace
Copilot Chat or implement the work by itself. The Kanban board is the control plane: task cards,
workflow columns, and gates decide what should happen next. GitHub Copilot Chat is the execution
surface: Kanban Pilot opens a private session for the selected task, injects the stage prompt,
and records the result back in the task file.

Every task is also classified as a **Feature** or **Bug**. The board displays that type as a
readable card marker, so the distinction does not depend on color alone.

The default workflow is deliberately staged so a task can be clarified and reviewed before
Copilot Chat is asked to change code:

| Stage | What happens |
| --- | --- |
| Backlog | Create or select a task, then click **Accept**. |
| Refine | Click **Refine** to ask Copilot Chat to write the problem statement, acceptance criteria, and Scope. Click **Split** instead when the task is too big for one ticket. |
| Scoped | Review the generated Scope and use the gate before approving it. |
| Approved | Click **Approve** when the scope is ready for implementation. |
| In Progress | Click **Develop** to ask Copilot Chat to implement the approved Scope. |
| Validation | Click **Validate** to ask the QA stage to check the implementation against the criteria. |
| Done | The task is complete after a successful validation receipt. |

## Quick Start

1. Install or enable GitHub Copilot Chat in VS Code, then install Kanban Pilot. GitHub Copilot
  Chat is required because Kanban Pilot drives that chat surface.
2. Open a workspace and run **Kanban Pilot: Open Board** from the Command Palette, or select the
  Kanban Pilot activity-bar icon. The board is bound to the first workspace folder.
3. Use the **Task set** selector in the board header to choose the immutable **Default** set or
  a named set. **New** creates and selects a named set; **Rename** works on the active named set;
  **Delete** works only for an empty named set. The Default set cannot be renamed or deleted, and
  switching or creating a set is unavailable while a task run is active.
4. Click **New Task** to enter a title, optional description, and required **Feature** or **Bug**
  type, or select an existing card. The Command Palette's **Kanban Pilot: New Task** flow asks
  for the same type. Selecting a card opens its task detail dialog; the task is stored as a
  Markdown file in the active set. Use **Edit task** in the detail dialog to revise the title,
  Request, Refined, or Scope without leaving the board.
5. From **Backlog**, click **Accept**, then click **Refine**. Copilot Chat fills the task's
  **Refined** and **Scope** sections and returns a receipt. Refine is a documentation step;
  it must not write implementation code.
6. Read the **Scope** in the task detail dialog. When it is ready, click **Approve**. This is
  the review gate between planning and implementation. If the task turns out to be too large,
  click **Split** instead — the run files the smaller pieces as new backlog tasks and leaves this
  one as tracking-only.
7. In **Approved**, click **Develop**. Copilot Chat receives the approved task and implements
  the checklist. A task may show **Continue** when a run needs to resume.
8. When the task reaches **Validation**, click **Validate**. The QA stage checks the actual
  implementation against the acceptance criteria and moves successful work to **Done**.
9. Use **Open Chat** in the task detail dialog to open that task's private Copilot Chat session
  beside the board. Stage runs open the same task-specific session automatically when chat
  docking is enabled.

Manual gates are the default. The four gates can be switched to **Auto** from **Settings** for
hands-off advancement, subject to the shared run-capacity limit described below.

### Manage task sets

The active task set is selected in the board header and persisted for the workspace registry at
`.kanban-pilot/task-sets.json`. The Default set keeps the legacy `.kanban-pilot/tasks` location;
named sets are stored under `.kanban-pilot/task-sets/` and have independent task files, card
order, and task-specific chat session ids. A named set can be renamed, but it must be empty
before it can be deleted. The extension refuses to switch or create a set while any task in the
current set is running, so a run is never detached from its task-set context.

### Task types and agent proposals

New tasks require one of two types: **Feature** or **Bug**. Each card shows a text type marker
with an accessible name and tooltip; color is only a supporting visual cue. Tasks from older
workspaces that have no valid type are loaded as Feature and backfilled with `type: feature`.
Agent-filed follow-up tasks use the originating task's type unless a proposal supplies the other
valid type explicitly; malformed proposal types never create an untyped card.

### Edit an existing task

Select a card and choose **Edit task**. The editor accepts the title and the Markdown in the
`## Request`, `## Refined`, and `## Scope` sections, including multiline checklists and code
blocks. Choose **Save changes** to persist the edit, or **Cancel**, close the dialog, click the
backdrop, or press **Escape** to discard it. Save errors remain visible in the editor so the
form can be corrected without losing the other fields.

The board editor does not change the task id, workflow column, runtime status or run, chat and
session metadata, checkpoint, origin metadata, or the existing `scope_hash`. The append-only
`## Log` is also read-only in this form; workflow actions and run receipts remain the only ways
those controlled fields change. A task with `status: running` cannot be saved until its run
stops.

### Organize cards

Drag a card between its column peers to set a persisted within-column order. The order survives
board reloads and extension restarts and is isolated to the active task set. Focus a card and use
Arrow Up or Arrow Down for the keyboard equivalent; the board announces the resulting position.
This ordering-only action does not change the task's state, status, run, or chat session and never
starts an agent. Dragging a card to a different column remains a separate workflow move with the
existing state-machine semantics. Legacy cards without a stored position receive deterministic
fallback ordering and are normalized when a new order is saved.

### Configure Settings

Use the board header's **Settings** button to open a keyboard-operable, two-pane surface. The
sidebar has **Automation gates** and **Agent assignments** categories; switching categories only
changes the visible main pane and does not write settings. The four gate switches correspond to
the existing `kanbanPilot.gates.*` settings: **Backlog → Refine**, **Scoped → Approved**,
**Approved → In Progress**, and **Validation auto-start**. They are manual by default; switching
a gate to **Auto** persists it at workspace scope and immediately applies it to eligible idle
tasks.

The Agent assignments pane lists all seven columns — **Backlog**, **Refine**, **Scoped**,
**Approved**, **In Progress**, **Validation**, and **Done**. Edit a label and choose **Save**, or
choose **Reset** to remove the override and restore **Bro Refiner** for Refine, **Bro Coder** for
In Progress, **Bro QA** for Validation, and **None** for the resting columns. The column-header
pencil opens this pane with that column focused. Refine's assignment is also used by **Split**;
assignments on resting columns are stored/displayed labels only and never start a chat run.
Legacy `refine`/`develop`/`validate` assignment keys remain supported. Changes made directly in
workspace settings are reflected in the board and Settings surface automatically.

## Install the Agent Skill

The repository includes the canonical Kanban Pilot skill at
`.claude/skills/kanban-pilot/SKILL.md`. From the repository root, install it into the personal
skill directory for the tool you use:

```sh
npm run install:skill:claude
npm run install:skill:copilot
```

The Claude command writes to `<user-home>/.claude/skills/kanban-pilot/SKILL.md`, and the Copilot
command writes to `<user-home>/.copilot/skills/kanban-pilot/SKILL.md`. The commands create missing
parent directories and overwrite an existing copy. The canonical skill distinguishes direct
skill runs from extension-supervised prompts: the generated completion contract owns the
frontmatter boundary for an extension run, while a direct skill run performs its own legal state
transition. Installed skill copies are snapshots, so re-run the relevant command after every
repository skill update to refresh the installed version.

Stage prompt files under `.kanban-pilot/prompts` are user-owned and are never silently migrated.
If an existing copy predates the `kanban-pilot: extension-supervised` marker, update it manually
or remove it to let the extension seed the current built-in default; keep its footer's explicit
extension-frontmatter ownership rule if retaining the older copy.

## Visual Walkthrough

The board is the control plane for the task-specific Copilot Chat runs:

![Kanban Pilot board showing the seven workflow columns and a task in In Progress](docs/media/board-workflow.png)

The board shows the staged columns, per-column agent labels, gate controls, and the card action
for the current task. The header also shows the active task set and its management controls;
cards show their Feature/Bug marker and can be reordered with a mouse or keyboard. Open
**Settings** to edit gates and assignments in one place.

![Kanban Pilot New Task dialog with a title and description](docs/media/task-create.png)

Use **New Task** to create a markdown-backed card with a title and an optional description.

![Kanban Pilot task detail dialog with the Open Chat action](docs/media/task-copilot-chat.png)

Select a card to review its Request, Refined, and Scope sections. **Open Chat** is the explicit
handoff to that task's private GitHub Copilot Chat session, which opens beside the board.

## Features

- **Staged workflow** — Backlog → Refine → Scoped → Approved → In Progress → Validation → Done,
  with a hard review point before any code is written.
- **Gated by default** — every stage transition requires an explicit click unless you opt into
  auto-advance per gate (`kanbanPilot.gates.*`).
- **Named task sets** — keep independent task files, card ordering, and task-specific sessions
  in the immutable Default set or additional workspace-local sets.
- **One private chat session per task** — no context bleed between unrelated tasks.
- **Docked chat** — the active task's Copilot Chat session opens beside the board, and Refine,
  Develop, and Validate dock it before the prompt is injected.
- **Theme-aware, accessible board** — the UI follows VS Code light and dark theme tokens, keeps
  text contrast readable, and provides keyboard-operable actions and announcements.
- **Feature/Bug task types** — every new task is classified and every card shows a readable,
  accessible type marker; agent-proposed children inherit or explicitly override the parent type.
- **Split** — fan an oversized ticket out into smaller ones instead of scoping it in place.
- **Split recommendation** — the built-in Refine prompt records an advisory `YES`/`NO`
  recommendation, rationale, and proposed boundaries when a task may be better split; it does
  not create child tasks by itself.
- **Task proposals** — running agents can file follow-up work as new backlog tasks.
- **In-board task editing** — select a card to edit its title and Markdown Request, Refined, and
  Scope sections while protected workflow metadata and the append-only Log remain unchanged.
- **Persisted card ordering** — drag cards within a column or use Arrow Up/Arrow Down to reorder
  them without starting a run; cross-column drags remain workflow moves.
- **Settings workspace** — manage Automation gates and all seven column Agent assignments from a
  responsive two-pane editor, including reset behavior and resting-column display labels.
- **Run capacity** — one run at a time by default, raised via `kanbanPilot.run.maxParallelTasks`.
- **Receipt recovery** — late completion receipts are reconciled even when a missing-receipt fallback races with the agent's task-file write, so successful runs do not remain blocked.
- **Audit trail** — extension-controlled state/status transitions and stage activity start/finish events are appended to each task's `## Log` with UTC timestamps, alongside receipts and task proposals.

### Task activity log

The `## Log` section is an append-only channel shared by the extension and the agent. Agent
receipts keep their existing `- run:...` grammar, while extension-owned audit entries use a
distinct `- audit:...` prefix so receipt and proposal parsing remains compatible. Audit lines
record `state-change`, `status-change`, `activity-start`, and `activity-finish` events. They use
UTC ISO 8601 timestamps at second precision, for example:

```text
- audit:state-change at:2026-08-17T10:00:00Z task:TASK-142 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-17T10:00:01Z task:TASK-142 from:idle to:running action:refine note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-17T10:00:01Z task:TASK-142 stage:refine action:refine run:r7 note:"Started refine activity."
- audit:activity-finish at:2026-08-17T10:00:12Z task:TASK-142 stage:refine action:receipt run:r7 outcome:ok note:"scope written, 3 files"
```

State is the workflow column; status is the runtime condition. State and status audit entries
cover extension-controlled moves, gates, automatic policies, retries, and stop/reset behavior.
A run records one start after admission and one terminal finish for Refine, Split,
Develop/Continue, or Validate, including success, blocked/failed receipts, timeout, executor
errors, missing receipts, manual completion, stop, or a superseding move. A provisional
missing-receipt finish can receive one explicit, idempotent late-receipt correction. Audit
events are written with the frontmatter mutation through the serialized task store, so repeated
watcher/reload reconciliation does not duplicate lifecycle entries. Agent receipts and
`propose-task` lines keep their existing grammar and can be interleaved with `audit:` lines.

Only extension-controlled transitions are attributed. Direct edits to frontmatter by a person
or an agent remain supported, but a file watcher cannot reliably determine the old value or the
initiating action, so those edits are not guaranteed to receive audit entries. The board editor
also leaves the append-only Log untouched.

## Requirements

- VS Code 1.125.0 or later.
- GitHub Copilot Chat, since Kanban Pilot drives it rather than replacing it.

## Extension Settings

This extension contributes the following settings (all under `kanbanPilot.*`):

| Setting | Default | Description |
| --- | --- | --- |
| `kanbanPilot.tasksDir` | `.kanban-pilot/tasks` | Workspace-relative folder for the immutable Default task set; additional named sets use `.kanban-pilot/task-sets/<id>/tasks`. |
| `kanbanPilot.gates.backlogToRefine` | `manual` | `auto` accepts a new task and launches Refine automatically. |
| `kanbanPilot.gates.scopedToApproved` | `manual` | `auto` approves a freshly-scoped task into the ready queue. |
| `kanbanPilot.gates.approvedToInProgress` | `manual` | `auto` starts development on the next Approved task when run capacity has room. |
| `kanbanPilot.gates.validationAutoStart` | `manual` | `auto` launches Validate as soon as a task lands in Validation. |
| `kanbanPilot.chat.mode` | `agent` | Chat mode requested at injection (`agent` or `ask`). |
| `kanbanPilot.chat.sessionPrefix` | `kanban-pilot-` | Prefix used to build each task's private session id; named sets include their stable set id. |
| `kanbanPilot.chat.closeTabOnDone` | `true` | Close a task's chat tab once it reaches Done. |
| `kanbanPilot.chat.resetOnApprove` | `false` | Clear the task's conversation at the Approve gate. |
| `kanbanPilot.refine.toolsInclude` | `[]` | Optional allowlist restricting tools available during Refine. |
| `kanbanPilot.chat.toolsExclude` | `["memory", "resolveMemoryFileUri"]` | Tools denied on every injection, every stage. |
| `kanbanPilot.chat.modelSelector` | `{}` | Optional `{id, vendor}` to pin a model per run. |
| `kanbanPilot.chat.agentNames` | `{}` | Per-column labels for `backlog`, `refine`, `scoped`, `approved`, `in-progress`, `validation`, and `done`. Defaults are `None` for resting columns, `Bro Refiner`, `Bro Coder`, and `Bro QA` for the runnable columns; `split` reuses Refine. Legacy `refine`/`develop`/`validate` keys remain supported. Editable from **Settings**. |
| `kanbanPilot.run.timeoutMinutes` | `20` | Minutes before a run is marked failed. |
| `kanbanPilot.run.maxParallelTasks` | `1` | Maximum active Refine, Split, Develop/Continue, and Validate runs. Invalid, non-positive, or non-integer values normalize to `1`; values above one opt into concurrent agent edits in the same workspace without worktree isolation. |
| `kanbanPilot.board.openOnStartup` | `false` | Open the board automatically on workspace load. |
| `kanbanPilot.layout.dockChat` | `true` | Open the selected task's chat beside the board. |
| `kanbanPilot.layout.dockChatOnSelect` | `false` | Dock the chat as soon as a card is selected. |
| `kanbanPilot.chat.allowTaskProposals` | `true` | Let develop/validate runs file typed follow-up work as new backlog tasks; an omitted proposal type inherits the originating task's type. |

Run capacity is global across all active agent stages and counts persisted `status: running`
tasks after a reload. The default of one preserves the safest working-tree behavior. When the
capacity is full, new manual and automatic starts are left untouched rather than assigned a new
queue status; Approved remains the visible ready queue. Increasing the limit explicitly opts into
same-workspace concurrent edits, so use a worktree or another isolation strategy separately if
parallel code-writing runs need filesystem safety. Increasing the limit allows eligible work to
start on the next reconciliation; decreasing it does not interrupt runs already in progress.

## Known Issues

None tracked yet.

## Release a Versioned Package

The release workflow runs when a `v<major>.<minor>.<patch>` tag is pushed. To release a version:

1. Update the `version` in `package.json` and the matching root versions in `package-lock.json`,
  then commit the change.
2. Push a tag that exactly matches the manifest version, such as `v0.2.0`.
3. GitHub Actions installs dependencies with `npm ci`, runs the existing tests, build, and lint
  checks, packages the extension with `npm run vsix`, and verifies the VSIX metadata.
4. After all checks pass, the workflow creates a GitHub Release for the tag and attaches the
  generated `kanban-pilot-<version>.vsix` asset.

## Release Notes

### 0.2.0

The v0.2.0 release adds named task sets, typed Feature/Bug cards, in-board task editing,
persisted within-column ordering, theme-aware accessible board polish, a categorized Settings
workspace, extension-owned audit logging, configurable parallel run capacity, and an advisory
split recommendation during Refine. It also improves receipt recovery and legacy-task/settings
compatibility. See [CHANGELOG.md](CHANGELOG.md) for the complete release history.

### 0.1.0

Initial build.
