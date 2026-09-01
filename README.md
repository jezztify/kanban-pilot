![Kanban Pilot](docs/media/kanban-pilot-logo.jpeg)

# Kanban Pilot

**A Kanban board for VS Code with an optional real-time HTTP endpoint.**

You work the board — create a card, accept it, refine it, approve it, ship it. The VS Code
extension drives GitHub Copilot Chat in the workspace. Its optional HTTP endpoint exposes that
same board state and those same validated actions in real time.

Every task is a plain Markdown file in your repo. The endpoint reads that existing task store and
routes mutations through the existing run manager; it does not mirror or scrape a VS Code Copilot
transcript.

## Why you might want it

- **Nothing gets built before you've read the plan.** There's a deliberate review stop between
  "here's the plan" and "go write the code."
- **One conversation per task.** No context bleeding between unrelated pieces of work.
- **You stay in control.** Every step waits for a click by default. Turn on auto-advance only
  where you want it.
- **Your tasks are durable.** Task Markdown remains in `.kanban-pilot/`; the endpoint does not add
   another state store.

## VS Code extension

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

Task Details renders the Request, Refined, and Scope sections as safe CommonMark/GFM, including
headings, lists, checklists, tables, code, links, and task-local images. Fenced blocks tagged
`mermaid` render as charts. If a chart cannot be rendered, its source remains visible in a
readable fallback and the rest of the modal stays usable. Unsafe links and unavailable or remote
images are not loaded. Rendering is read-only; choose **Edit task** to edit the authored Markdown.

## Documentation

| Guide | What's in it |
| --- | --- |
| [Working the board](docs/board-guide.md) | Task sets, editing cards, reordering, Split, run recovery, and agent-filed follow-up work. |
| [Configuration](docs/configuration.md) | Every gate, the Settings pane, run capacity, and the full `kanbanPilot.*` settings table. |
| [Where your tasks live](docs/task-files.md) | The on-disk layout, image attachments, and the activity log. |
| [Real-time HTTP endpoint](docs/http-endpoint.md) | Serving the board in a browser — endpoints, authentication, and the security warnings that come with it. |
| [Optional Copilot hook feed](docs/copilot-hook-feed.md) | Lower-latency activity through a manually configured Copilot hook. |
| [Releasing a version](docs/releasing.md) | The tag-driven release pipeline. |

For background: [docs/research/](docs/research/README.md) holds the dated spikes and findings behind
the design decisions, and [docs/PRD.md](docs/PRD.md) is the living product specification.

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

## Known issues

None tracked yet.

## Release notes

The current documented release is **0.4.3**. See [CHANGELOG.md](CHANGELOG.md) for the full history.
