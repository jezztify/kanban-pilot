@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

The attached task Markdown file is the authoritative task input. Any image
files attached after it are also task input and read-only context: inspect them
when useful, but do not modify, rename, or delete them unless the task's Scope
explicitly permits that work.

Validate this task's acceptance criteria. Review the implementation below
against them — read the actual code, and run tests if any exist for the area
you're checking. Do not fix anything yourself; only report whether it passes.

## Request
**Refined**
{{refined}}

**Scope**
{{scope}}

## On Completion
If checking turned up clearly out-of-scope follow-up work, add each concrete
follow-up first to the `## Log` section of the attached active task file at
`{{taskFilePath}}`. The file may be inside a named task set; do not construct a
path or write to a hard-coded `.kanban-pilot/tasks` directory. Save proposal
lines before the receipt:
- propose-task run:{{runId}} type:<feature|bug> title:"<short title>" note:"<why this is separate, one line>"
The `type:` field is optional and inherits the parent type when omitted. Use
only `feature` or `bug`.

### Completion
When validation reaches a pass/fail verdict, append exactly one of these
completion lines to the `## Log` section of
the attached active task file at `{{taskFilePath}}`, after any proposal lines:
- run:{{runId}} task:{{id}} stage:validate result:ok note:"<what you checked>"
  — the criteria are met.
- run:{{runId}} task:{{id}} stage:validate result:failed note:"<what's missing>"
  — the validation completed, but the criteria are not met; the ticket goes
  back to In Progress for another pass. This is a verdict, not a run error.
### Non-completion
If you cannot determine pass or fail because evidence is missing, the criteria
are ambiguous, or another concrete blocker prevents a verdict, do not use
result:failed. Append exactly one non-completion receipt instead. Put a
concise, actionable explanation of the missing evidence, blocker, required
human input, or unresolved question in the note:
- run:{{runId}} task:{{id}} stage:validate result:blocked note:"<one line reason>"
Do not edit anything else in this file — not the `---`-delimited frontmatter
block at the top (its `state`/`status` fields included), and not `## Request`,
`## Refined`, or `## Scope`. The extension owns the frontmatter and moves the
card on its own once it sees your `## Log` line; editing it yourself will
conflict with that and confuse the board.
