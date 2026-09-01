# Configuration

Every option lives under `kanbanPilot.*` and can be edited from the board's **Settings** pane.

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
log — the card just holds the outcome for review instead of moving and shows **Review Required**.
Apply it from the card's detail dialog or the **Apply Pending Completion** command whenever you're
ready; the transition context remains available, applying it only moves the card, and it never
starts another agent run. Review-required outcomes survive reloads and window restarts. Auto stage
starts still respect the shared run-capacity limit. Blocked or failed work is never retried on its
own.

## Tune it in Settings

The **Settings** button in the header opens a keyboard-friendly, two-pane editor covering every
option, grouped into automation gates, agent names per column, task storage and startup, chat,
tools and model, run behavior, and board layout. Values are saved at workspace scope and can be
reset to the effective default; invalid values are rejected rather than half-saved. Agent
assignments are the one batched category: one **Save** commits all seven column selections, while
each column keeps its own **Reset** control before the shared save.

Agent assignments use keyboard-accessible dropdowns populated when Settings opens or refreshes.
Choices come from workspace `.github/agents` and `.claude/agents` folders, configured agent-file
locations, `chat.agentDirectories`, and user-level `~/.copilot/agents` and `.claude/agents`
folders. **Additional agent directories** is an ordered newline-separated list in Settings; entries
may be absolute, `~/`-relative, or workspace-relative. Empty, duplicate, missing, or unreadable
entries are ignored. Workspace choices win when names collide, followed by configured and then user-level choices. Existing or legacy
labels remain selectable as a compatibility fallback even when their profile is no longer
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
finished run holding a pending outcome doesn't occupy a slot. `RunManager` owns this complete-run
capacity; the chat executor only serializes the short task-session open-and-inject handoff and
releases that mutex before waiting for Copilot's terminal response. No backend server is needed
for this coordination, and adding one would not provide workspace or chat-session isolation.

## All settings

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
| `chat.hookFeed` | `false` | Show structural Copilot hook activity as it happens. Requires the manually configured receiver described in [Optional Copilot hook feed](copilot-hook-feed.md). |
| `chat.transcriptFeed` | `false` | Show Copilot session activity from its delayed transcript flushes. |
| `chat.transcriptFeedRemote` | `false` | Also send observed hook or transcript activity to the browser board. Requires the existing authenticated HTTP endpoint and this separate remote opt-in; its token-bearing share URL is covered by the security warning in [Real-time HTTP endpoint](http-endpoint.md). |
| `chat.agentDirectories` | `[]` | Ordered additional custom-agent directories. Enter one absolute, `~/`-relative, or workspace-relative path per line; this complements VS Code's `chat.agentFilesLocations`. |
| `chat.toolsExclude` | `["memory", "resolveMemoryFileUri"]` | Tools blocked on every stage. |
| `refine.toolsInclude` | `[]` | Optional allowlist of tools available during Refine. |
| `chat.modelSelector` | `{}` | Pin a model per run with `{id, vendor}`. |
| `chat.agentNames` | `{}` | Dropdown-selected labels for each column's agent; the Agent assignments category saves all seven together and preserves legacy values. |
| `chat.allowTaskProposals` | `true` | Let develop and validate runs file follow-up backlog tasks. |
| `run.timeoutMinutes` | `20` | How long a run may go before it's marked failed. |
| `run.maxParallelTasks` | `1` | How many complete Refine, Split, Develop/Continue, and Validate runs may be active at once; values above one allow same-workspace edits without worktree isolation. |
| `board.openOnStartup` | `false` | Open the board automatically when the workspace loads. |
| `layout.dockChat` | `true` | Open the selected task's chat beside the board. |
| `layout.dockChatOnSelect` | `false` | Dock the chat as soon as you select a card. |
| `http.enabled` | `false` | Enable the authenticated real-time HTTP endpoint. |
| `http.host` | `0.0.0.0` | Bind address. Wildcard binds share on all interfaces and derive a LAN address for the URL/QR; use a trusted network or TLS reverse proxy. |
| `http.port` | `4173` | TCP port for the HTTP endpoint. |
| `http.token` | `kanban-pilot` | Bearer token required by the endpoint; replace the default with a high-entropy secret. |
| `http.publicUrl` | empty | Optional public `http` or `https` URL used by the share URL/QR when a reverse proxy fronts the endpoint. |

