# Kanban Pilot

A Kanban-first driver for Copilot Chat. The board is the control plane; chat is the execution
surface — you interact with cards (accept, refine, approve, develop), and the extension
composes and injects the right prompt into Copilot Chat at the right moment.

Each task is a durable, git-diffable markdown file on disk. The board is a live projection of
that folder: editing a task file by hand moves the card, and moving the card rewrites the file.

## Features

- **Staged workflow** — Backlog → Refine → Scoped → Approved → In Progress → Validation → Done,
  with a hard review point before any code is written.
- **Gated by default** — every stage transition requires an explicit click unless you opt into
  auto-advance per gate (`kanbanPilot.gates.*`).
- **One private chat session per task** — no context bleed between unrelated tasks.
- **Docked chat** — the active task's Copilot Chat session opens beside the board.
- **Task proposals** — running agents can file follow-up work as new backlog tasks.

## Requirements

- VS Code 1.125.0 or later.
- GitHub Copilot Chat, since Kanban Pilot drives it rather than replacing it.

## Extension Settings

This extension contributes the following settings (all under `kanbanPilot.*`):

| Setting | Default | Description |
| --- | --- | --- |
| `kanbanPilot.tasksDir` | `.kanban-pilot/tasks` | Workspace-relative folder holding task markdown files. |
| `kanbanPilot.gates.backlogToRefine` | `manual` | `auto` accepts a new task and launches Refine automatically. |
| `kanbanPilot.gates.scopedToApproved` | `manual` | `auto` approves a freshly-scoped task into the ready queue. |
| `kanbanPilot.gates.approvedToInProgress` | `manual` | `auto` starts development on the next Approved task. |
| `kanbanPilot.gates.validationAutoStart` | `manual` | `auto` launches Validate as soon as a task lands in Validation. |
| `kanbanPilot.chat.mode` | `agent` | Chat mode requested at injection (`agent` or `ask`). |
| `kanbanPilot.chat.sessionPrefix` | `kanban-pilot-` | Prefix used to build each task's private session id. |
| `kanbanPilot.chat.closeTabOnDone` | `true` | Close a task's chat tab once it reaches Done. |
| `kanbanPilot.chat.resetOnApprove` | `false` | Clear the task's conversation at the Approve gate. |
| `kanbanPilot.refine.toolsInclude` | `[]` | Optional allowlist restricting tools available during Refine. |
| `kanbanPilot.chat.toolsExclude` | `["memory", "resolveMemoryFileUri"]` | Tools denied on every injection, every stage. |
| `kanbanPilot.chat.modelSelector` | `{}` | Optional `{id, vendor}` to pin a model per run. |
| `kanbanPilot.chat.agentNames` | `{}` | Per-stage persona overrides (`refine`/`develop`/`validate`; `split` reuses `refine`). Editable from the board via each column's Agent edit icon. |
| `kanbanPilot.run.timeoutMinutes` | `20` | Minutes before a run is marked failed. |
| `kanbanPilot.board.openOnStartup` | `false` | Open the board automatically on workspace load. |
| `kanbanPilot.layout.dockChat` | `true` | Open the selected task's chat beside the board. |
| `kanbanPilot.layout.dockChatOnSelect` | `false` | Dock the chat as soon as a card is selected. |
| `kanbanPilot.chat.allowTaskProposals` | `true` | Let develop/validate runs file follow-up work as new backlog tasks. |

## Known Issues

None tracked yet — this is a pre-release build.

## Release Notes

### 0.0.1

Initial build.
