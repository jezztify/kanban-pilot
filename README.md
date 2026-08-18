# Kanban Pilot

**A Kanban board for VS Code that drives GitHub Copilot Chat for you.**

You work the board — create a card, accept it, refine it, approve it, ship it. At each step
Kanban Pilot writes the right prompt and hands it to Copilot Chat in that card's own private
conversation, then records the result back on the card.

Every task is a plain Markdown file in your repo, so your work is readable, reviewable, and
diffable in git. Edit a file by hand and the card moves. Move the card and the file updates.

> Kanban Pilot doesn't replace Copilot Chat or write the code itself. It decides *what* should
> happen next; Copilot Chat does the work.

## Why you might want it

- **Nothing gets built before you've read the plan.** There's a deliberate review stop between
  "here's the plan" and "go write the code."
- **One conversation per task.** No context bleeding between unrelated pieces of work.
- **You stay in control.** Every step waits for a click by default. Turn on auto-advance only
  where you want it.
- **Your tasks are just files.** No database, no cloud, no lock-in — everything lives in
  `.kanban-pilot/` in your repo.

## Requirements

- VS Code 1.125.0 or later
- GitHub Copilot Chat, installed and signed in

## Get started

1. **Open the board.** Click the Kanban Pilot icon in the activity bar, or run
   **Kanban Pilot: Open Board** from the Command Palette. The board follows your first
   workspace folder.
2. **Create a task.** Click **New Task**, give it a title, an optional description, and pick
   whether it's a **Feature** or a **Bug**.
3. **Accept it.** Select the card and click **Accept** to move it out of Backlog.
4. **Refine it.** Click **Refine**. Copilot Chat writes the problem statement, acceptance
   criteria, and a scope checklist onto the card. It won't touch code at this stage.
5. **Read the scope, then approve.** Open the card and read the **Scope** section. Happy? Click
   **Approve**. Too big? Click **Split** instead and it becomes several smaller tasks.
6. **Develop.** Click **Develop** and Copilot Chat implements the approved checklist. If a run
   needs to pick up where it left off, the card offers **Continue**.
7. **Validate.** When the card reaches Validation, click **Validate**. The QA stage checks the
   real implementation against the acceptance criteria, and passing work lands in **Done**.

At any point, **Open Chat** on a card opens that task's own Copilot Chat session beside the board.

## The workflow

| Column | What you do here |
| --- | --- |
| **Backlog** | New tasks land here. Click **Accept** when you're ready to work on one. |
| **Refine** | Click **Refine** to have the problem, criteria, and scope written up — or **Split** if it's too big for one ticket. |
| **Scoped** | Read what came back. This is your review stop. |
| **Approved** | You've signed off on the plan. Click **Develop** to start building. |
| **In Progress** | Copilot Chat is implementing the checklist. |
| **Validation** | Click **Validate** to check the work against the acceptance criteria. |
| **Done** | Validation passed. |

Each column can show an agent label — **Bro Refiner**, **Bro Coder**, and **Bro QA** by default —
so it's clear who's on the hook at each stage. You can rename these in Settings.

## A look at the board

![The Kanban Pilot board with seven workflow columns and a task in progress](docs/media/board-workflow.png)

The board shows your columns, the agent handling each one, the gate controls, and the next action
for the selected card. The header holds the task-set picker and the **Settings** button.

![The New Task dialog with a title and description](docs/media/task-create.png)

**New Task** creates a Markdown-backed card — title, optional description, Feature or Bug.

![A task's detail dialog showing the Open Chat action](docs/media/task-copilot-chat.png)

Select a card to read its Request, Refined, and Scope sections. **Open Chat** is the explicit
handoff to that task's private Copilot Chat session.

## Gates: who decides when a card moves

Every normal pipeline transition has its own **gate**, and all nine gates start out **manual** —
the card waits for you. Flip any gate to **Auto** in Settings when you'd rather not be asked.

**Starting gates** decide when a stage kicks off:

- `gates.backlogToRefine` — accept a Backlog task and launch Refine automatically.
- `gates.scopedToApproved` — approve a Scoped task into the Approved ready queue.
- `gates.approvedToInProgress` — start the next eligible Approved task when capacity is available.
- `gates.validationAutoStart` — launch Validate when a task reaches Validation.

**Finishing gates** decide when a completed run is allowed to move the card:

- `gates.refineToScoped` — commit a successful Refine receipt into Scoped.
- `gates.developToValidation` — commit a successful Develop receipt into Validation.
- `gates.validateToDone` — commit a passing Validate receipt into Done.
- `gates.validateFailedToInProgress` — send a failed validation verdict back to In Progress.
- `gates.splitToDone` — retire a Split parent after its children are persisted.

When a finishing gate is manual, the run still completes and its result is written to the card's
log — the card just holds the outcome as **pending** instead of moving. Apply it from the card's
detail dialog or the **Apply Pending Completion** command whenever you're ready; applying it only
moves the card and never starts another agent run. Pending outcomes survive reloads and window
restarts. Auto stage starts still respect the shared run-capacity limit. Blocked or failed work is
never retried on its own.

## Things you'll do along the way

### Keep separate piles of work with task sets

Use the **Task set** picker in the header to switch between the built-in **Default** set and any
named sets you create. Each set keeps its own tasks, its own card order, and its own chat
sessions, so an experiment doesn't get tangled up with your main work.

- **New** creates a set and switches to it.
- **Rename** works on named sets; **Delete** works on empty named sets.
- Default can't be renamed or deleted.
- You can't switch or create sets while a task is running — a run always stays with its set.

### Edit a card without leaving the board

Select a card and choose **Edit task**. You can change the title and the Markdown in the
**Request**, **Refined**, and **Scope** sections, checklists and code blocks included. **Save
changes** keeps it; **Cancel**, Escape, or clicking outside throws it away. If a save fails, the
message stays on screen so you can fix it without retyping everything.

Editing never changes the card's column, its run state, or its history — those only move through
workflow actions and run results. A task that's currently running can't be saved until it stops.

### Reorder cards

Drag a card up or down within its column to set an order that sticks across reloads and restarts.
Prefer the keyboard? Focus a card and use Arrow Up / Arrow Down; the board announces where it
landed. Reordering never starts a run. Dragging a card to a *different* column is still a normal
workflow move.

### Split something that's too big

If a task is clearly more than one ticket, click **Split**. Kanban Pilot files the smaller pieces
as new backlog tasks and leaves the original as a tracking card. Refine also leaves an advisory
note about whether a split looks worthwhile — a suggestion for you, not an automatic action.

### Run recovery and Split safety

Split is transactional: the parent is retired only after valid, same-run child proposals have
been persisted in the active task set. Missing or invalid proposals, or a child-write failure,
leave the parent retryable instead of silently marking it Done; repeated reconciliation does not
create duplicate children. A timed-out run is marked failed and remains retryable when no receipt
arrives, but a matching late receipt from that run can still be reconciled. A receipt from a run
that was stopped, manually moved, or replaced by a newer retry cannot overwrite the newer task
state.

### Let agents file follow-up work

While developing or validating, an agent can propose follow-up tasks. Those show up as new backlog
cards, inheriting the parent's Feature/Bug type unless the proposal says otherwise.

### Tune it in Settings

The **Settings** button in the header opens a keyboard-friendly, two-pane editor covering every
option, grouped into automation gates, agent names per column, task storage and startup, chat,
tools and model, run behavior, and board layout. Values are saved at workspace scope and can be
reset to the effective default; invalid values are rejected rather than half-saved. Agent
assignments are the one batched category: one **Save** commits all seven column selections, while
each column keeps its own **Reset** control before the shared save.

Agent assignments use keyboard-accessible dropdowns populated when Settings opens or refreshes.
Choices come from workspace `.github/agents` folders, configured agent-file locations, and the
user-level `~/.copilot/agents` folder; workspace choices win when names collide. Existing or
legacy labels remain selectable as a compatibility fallback even when their profile is no longer
discoverable. The pencil on a column header jumps straight to that column's field. Refine's name
is also used for **Split**, and names on the resting columns are just labels — they never start a
chat run.

Gate changes take effect immediately. Chat, tools, model, and run settings apply to the *next*
run, so changing them never disturbs something already running. Changing the tasks folder or the
open-on-startup option shows a reload notice, because those are read when the extension starts.

## How many tasks run at once

By default, **one run at a time**. That's the safest setting: parallel agents editing the same
working tree can step on each other.

Raise `kanbanPilot.run.maxParallelTasks` if you want more, but treat that as opting into concurrent
edits in the same workspace — set up git worktrees or another isolation strategy yourself if
parallel runs will be writing code. When capacity is full, extra work simply waits in **Approved**.
Raising the limit lets waiting work start; lowering it never interrupts runs already going. A
finished run holding a pending outcome doesn't occupy a slot.

## Where your tasks live

```
.kanban-pilot/
├─ tasks/                    # the Default task set
├─ task-sets/<id>/tasks/     # each named set
├─ task-sets.json            # which sets exist, and which one is active
└─ prompts/                  # your stage prompts (yours to edit; never overwritten)
```

Each task is one Markdown file: a bit of frontmatter (id, type, column, status) plus **Request**,
**Refined**, **Scope**, and an append-only **Log**.

### The activity log

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
manual move hasn't already taken over. Hand edits you make directly to a task file are fully
supported, but they won't produce audit lines: a file watcher can't tell what the old value was or
who changed it.

## Install the agent skill

The repository ships the canonical Kanban Pilot skill at `.claude/skills/kanban-pilot/SKILL.md`.
From the repository root:

```sh
npm run install:skill:claude    # installs to <home>/.claude/skills/kanban-pilot/SKILL.md
npm run install:skill:copilot   # installs to <home>/.copilot/skills/kanban-pilot/SKILL.md
```

Both commands create missing folders and overwrite an existing copy. Installed copies are
snapshots, so re-run the command whenever the repository's skill changes.

Stage prompts in `.kanban-pilot/prompts` belong to you and are never migrated automatically. If an
older copy predates the `kanban-pilot: extension-supervised` marker, either update it by hand or
delete it and let the extension write a fresh default.

## All settings

Every option lives under `kanbanPilot.*` and can be edited from the board's **Settings** pane.

| Setting | Default | What it does |
| --- | --- | --- |
| `tasksDir` | `.kanban-pilot/tasks` | Where the Default task set is stored. Named sets live under `.kanban-pilot/task-sets/<id>/tasks`. |
| `gates.backlogToRefine` | `manual` | `auto` accepts a new task and starts Refine. |
| `gates.refineToScoped` | `manual` | `auto` moves a finished Refine to Scoped. |
| `gates.scopedToApproved` | `manual` | `auto` approves freshly scoped work. |
| `gates.approvedToInProgress` | `manual` | `auto` starts development when there's capacity. |
| `gates.developToValidation` | `manual` | `auto` moves finished development to Validation. |
| `gates.validationAutoStart` | `manual` | `auto` runs Validate as soon as a task reaches Validation. |
| `gates.validateToDone` | `manual` | `auto` moves a passing validation to Done. |
| `gates.validateFailedToInProgress` | `manual` | `auto` sends a failed validation back to In Progress. |
| `gates.splitToDone` | `manual` | `auto` retires a split parent once its children exist. |
| `chat.mode` | `agent` | Copilot Chat mode used when a prompt is sent (`agent` or `ask`). |
| `chat.sessionPrefix` | `kanban-pilot-` | Prefix for each task's private session id. |
| `chat.closeTabOnDone` | `true` | Close a task's chat tab when it's finished (the session is kept). |
| `chat.resetOnApprove` | `false` | Clear the task's conversation at the Approve gate. |
| `chat.toolsExclude` | `["memory", "resolveMemoryFileUri"]` | Tools blocked on every stage. |
| `refine.toolsInclude` | `[]` | Optional allowlist of tools available during Refine. |
| `chat.modelSelector` | `{}` | Pin a model per run with `{id, vendor}`. |
| `chat.agentNames` | `{}` | Dropdown-selected labels for each column's agent; the Agent assignments category saves all seven together and preserves legacy values. |
| `chat.allowTaskProposals` | `true` | Let develop and validate runs file follow-up backlog tasks. |
| `run.timeoutMinutes` | `20` | How long a run may go before it's marked failed. |
| `run.maxParallelTasks` | `1` | How many runs may be active at once. |
| `board.openOnStartup` | `false` | Open the board automatically when the workspace loads. |
| `layout.dockChat` | `true` | Open the selected task's chat beside the board. |
| `layout.dockChatOnSelect` | `false` | Dock the chat as soon as you select a card. |

## Known issues

None tracked yet.

## Releasing a version

A release runs when a `v<major>.<minor>.<patch>` tag is pushed:

1. Update `version` in `package.json` (and the matching versions in `package-lock.json`), commit.
2. Push a tag that exactly matches, e.g. `v0.3.0`.
3. GitHub Actions installs with `npm ci`, runs tests, build, and lint, packages the VSIX, and
   checks its metadata.
4. Once everything passes, it creates the GitHub Release and attaches
   `kanban-pilot-<version>.vsix`.

## Release notes

The current documented release is **0.3.0**.

**0.3.0** — Complete manual/auto gates for the normal pipeline with durable pending outcomes;
the full in-board Settings editor; Copilot custom-agent discovery and assignment dropdowns; one
shared Agent assignments Save with per-column Reset; transactional Split child-task persistence;
and timeout recovery with matching late-receipt reconciliation and stale-run protection.

**0.2.0** — Named task sets, Feature/Bug card types, in-board task editing, persisted card
ordering, a theme-aware and accessible board, the categorized Settings pane, a gate for every
pipeline edge with durable pending completions, activity logging, configurable run capacity, and
split recommendations during Refine. Plus better recovery from late run results and improved
compatibility with older tasks and settings.

**0.1.0** — Initial build.

See [CHANGELOG.md](CHANGELOG.md) for the full history.
