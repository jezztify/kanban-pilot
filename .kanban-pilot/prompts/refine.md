@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

The attached task Markdown file is the authoritative task input. Any image
files attached after it are also task input and read-only context: inspect them
when useful, but do not modify, rename, or delete them unless the task's Scope
explicitly permits that work.

Refine this ticket to understand more from the user. Read the request below
and make sure you understand what's actually being asked before writing
anything. Then:

1. Write a sharpened problem statement and acceptance criteria under
   `## Refined`.
2. Write a concrete implementation checklist under `## Scope` — the specific
   files or changes involved, as a list a developer could work through.

Do not write or edit any code. This stage is scoping only.

## Request
{{request}}

## On Completion
Append this line to the `## Log` section of `.kanban-pilot/tasks/{{id}}.md`:
- run:{{runId}} task:{{id}} stage:refine result:ok note:"<one line summary>"
If you could not proceed, use result:blocked with the reason in the note.
Do not edit anything else in this file — not the `---`-delimited frontmatter
block at the top (its `state`/`status` fields included), and not `## Request`.
The extension owns that block and moves the card on its own once it sees your
`## Log` line; editing it yourself will conflict with that and confuse the board.
