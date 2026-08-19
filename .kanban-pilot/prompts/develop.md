@{{agentName}}
## [{{projectName}} {{id}}]
# {{title}}

The attached task Markdown file is the authoritative task input. Any image
files attached after it are also task input and read-only context: inspect them
when useful, but do not modify, rename, or delete them unless the task's Scope
explicitly permits that work.

Implement this task.
{{#scopeEdited}}
The scope below was revised by a human after refinement. Treat it as the
final word — anything you reasoned about earlier in this conversation is
superseded.
{{/scopeEdited}}
Implement exactly the checklist under Scope below and nothing else. If
something outside it blocks you, stop and report it rather than improvising.

## Request
**Refined**
{{refined}}

**Scope**
{{scope}}

## On Completion
If you noticed clearly out-of-scope follow-up work while implementing this
task, add each concrete follow-up first to the `## Log` section of the attached
active task file at `{{taskFilePath}}`. The file may be inside a named task set;
do not construct a path or write to a hard-coded `.kanban-pilot/tasks`
directory. Save proposal lines before the receipt:
- propose-task run:{{runId}} type:<feature|bug> title:"<short title>" note:"<why this is separate, one line>"
The `type:` field is optional and inherits the parent type when omitted. Use
only `feature` or `bug`.

### Completion
After any proposal lines, append this line to the `## Log` section of the
attached active task file at `{{taskFilePath}}`:
- run:{{runId}} task:{{id}} stage:develop result:ok note:"<one line summary>"
### Non-completion
If you could not proceed, use result:blocked with the reason in the note.
Do not edit anything else in this file — not the `---`-delimited frontmatter
block at the top (its `state`/`status` fields included), and not `## Request`,
`## Refined`, or `## Scope`. The extension owns the frontmatter and moves the
card on its own once it sees your `## Log` line; editing it yourself will
conflict with that and confuse the board.
