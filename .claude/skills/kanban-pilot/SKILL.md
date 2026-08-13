---
name: kanban-pilot
description: Work a Kanban Pilot task end to end — refine, develop, or validate — by reading and writing .kanban-pilot/tasks/*.md directly. Use this whenever asked to pick up, refine, implement, or validate a Kanban Pilot ticket, or to file follow-up work as a new one. Interoperates with the VS Code extension by following the exact same file schema, receipt grammar, and state-machine rules it uses.
---

# Kanban Pilot

Kanban Pilot (the VS Code extension this repo builds) drives a Copilot chat
agent from a kanban board. Its board and its state machine both read one
source of truth: `.kanban-pilot/tasks/TASK-*.md` files. This skill lets you —
Claude Code, working from a terminal instead of that board — do the same
work on the same files, using the same rules, so anything you do shows up
correctly on the board and anything the board does is visible to you.

**The one thing to internalize before anything else:** when the VS Code
extension runs a Copilot agent, a supervising process (`RunManager`) does the
state transition *for* the agent — the agent is told, explicitly, never to
touch frontmatter. You have no such supervisor. When you use this skill,
**you are both the agent and the supervisor** — you must perform the state
transition yourself, correctly, using the exact rules below. This is the one
deliberate asymmetry between this skill and the extension's own prompts;
don't resolve it by skipping the transition, and don't resolve it by copying
the extension's "never touch frontmatter" instruction — here, touching it
correctly *is* your job.

## Locating things

- Tasks: `.kanban-pilot/tasks/TASK-<n>.md` (three-digit-padded, e.g. `TASK-007`).
- Templates (optional, for tone/wording reference only — not load-bearing
  for you): `.kanban-pilot/prompts/{refine,develop,validate}.md`.
- If `docs/PRD.md` exists in the workspace, its §6.3 (task file format),
  §6.3's receipt grammar, and §6.12 (task proposals) are the authoritative
  design doc this skill is derived from — worth a skim if something here is
  ambiguous, though this file should be self-sufficient day to day.

## Task file schema

```
---
id: TASK-007
title: Add retry backoff for webhook delivery
state: approved
status: idle
created: 2026-08-13T10:04:12Z
updated: 2026-08-13T11:22:40Z
run: r4f9k2
chat_reset_required: false
origin_task: TASK-003
---

## Request
<the original ask — human-written, or an agent's note if origin_task is set>

## Refined
<written by refine: sharpened problem statement + acceptance criteria>

## Scope
<written by refine, may be edited by a human: implementation checklist>

## Log
<append-only receipt lines>
```

**Frontmatter fields** (`key: value`, one per line, no YAML nesting):

| Key | Values | Notes |
| --- | --- | --- |
| `id` | `TASK-<n>` | Must match the filename |
| `title` | free text | |
| `state` | `backlog \| refine \| scoped \| approved \| in-progress \| validation \| done` | The column |
| `status` | `idle \| running \| paused \| blocked \| failed` | Never invent a value outside this set — an unrecognized `state` or `status` silently resets the card to `backlog`/`idle` on the board |
| `created`, `updated` | ISO 8601, e.g. `2026-08-13T10:04:12Z` | Bump `updated` on every frontmatter write you make, always |
| `run` | a short id, or absent | Present only while a run is in flight; clear it (omit the line) when you finish |
| `chat`, `copilot_session_id` | — | VS Code/Copilot-specific session bookkeeping. Leave absent — don't invent values for these, they mean nothing coming from you |
| `scope_hash` | 7 hex chars | Set only by refine, on success — see below |
| `chat_reset_required` | `true \| false` | VS Code-specific misroute flag. Leave as-is; don't set it |
| `checkpoint` | git sha | Pre-develop safety net — not built yet anywhere (planned M4). Ignore |
| `origin_task` | `TASK-<n>`, or absent | Set only on a task *you file* via a proposal (below) — never on the task you're currently working |

To write frontmatter, rewrite the whole `---`-delimited block, keys in the
order shown above (skip absent ones), then leave everything from the first
`## Request` onward byte-for-byte untouched. Never touch `## Request` either
— it's the original ask, immutable once written.

**Body sections**, in this fixed order: `## Request`, `## Refined`,
`## Scope`, `## Log`. Only touch the ones your current stage owns (below);
`## Log` is append-only — add lines, never edit or remove existing ones.

## The state machine

A transition is **legal** only from the listed `(state, status)` pairs.
Don't force an illegal one — if the task isn't where a stage expects it, say
so and stop rather than working it anyway.

| Action | Legal from | Result | You do the work? |
| --- | --- | --- | --- |
| accept | `backlog`/`idle` | → `refine`/`idle` | No — pure gate, no stage work happens here |
| **refine** | `refine`/`idle,blocked,failed` or `scoped`/`idle` | → `refine`/`running` while working | **Yes** |
| approve | `scoped`/`idle` | → `approved`/`idle` | No — pure gate |
| **develop** | `approved`/`idle` | → `in-progress`/`running` while working | **Yes** |
| **validate** | `validation`/`idle,blocked,failed` | → `validation`/`running` while working | **Yes** |
| reopen | `done` | → `approved`/`idle` | No — pure gate |

The three stages you actually perform each end by writing a receipt (below)
and moving to one of:

- **refine**, `result:ok` → `state: scoped`, `status: idle`, set `scope_hash`
- **refine**, `result:blocked` or `failed` → `state` unchanged, `status` set
  to that result
- **develop**, `result:ok` → `state: validation`, `status: idle`
- **develop**, `result:blocked` or `failed` → `state` unchanged, `status` set
  to that result
- **validate**, `result:ok` → `state: done`, `status: idle`
- **validate**, `result:failed` → `state: in-progress`, `status: idle` — this
  is a real verdict ("criteria not met"), not an error; the ticket goes back
  for another development pass, it doesn't get stuck
- **validate**, `result:blocked` → `state` unchanged (stays `validation`),
  `status: blocked`

Whatever the outcome, always clear `run` (omit the line) and bump `updated`.

## Working a stage — the general shape

1. **Check legality** against the table above. If the task isn't in a legal
   `(state, status)` for the stage you were asked to do, stop and say so.
2. **Mark it running.** Patch frontmatter: keep `state` as-is, set
   `status: running`, set `run:` to a short id you make up (e.g. `r` followed
   by 6 random lowercase alphanumeric characters — `rk3j9q`), bump `updated`.
   This is optional if you're going to finish in one uninterrupted pass, but
   doing it means the board shows accurate state if you're interrupted or if
   someone looks mid-run.
3. **Do the stage's actual work** (specifics below).
4. **Append your receipt** to `## Log` (grammar below).
5. **Optionally file follow-ups** (develop/validate only — grammar below).
6. **Apply the outcome**: patch frontmatter to the `state`/`status` the
   receipt's result implies (table above), clear `run`, bump `updated`.

Steps 4 and 6 are both required, in that order — a receipt with no matching
frontmatter update leaves the board showing a stale column, and a frontmatter
update with no receipt leaves no audit trail for why.

### Stage: refine

Read `## Request`. Make sure you understand what's actually being asked.
Then write:

1. A sharpened problem statement and acceptance criteria under `## Refined`.
2. A concrete implementation checklist under `## Scope` — specific files or
   changes, as a list a developer could work through.

**Do not write or edit any code.** This stage is scoping only.

On success, compute `scope_hash`: take the `## Scope` section's text
(exactly what's between the `## Scope` and `## Log` headings), trim leading
and trailing whitespace, SHA-256 it, keep the first 7 hex characters —
`printf '%s' "$SCOPE" | sha256sum | cut -c1-7` after trimming `$SCOPE`
yourself first. This only feeds a soft "did a human edit this after
refinement" warning shown to a *later* develop run (§6.8 layer 2 in the PRD,
if present) — getting it slightly wrong isn't destructive, just imprecise.

### Stage: develop

Read `## Refined` and `## Scope`. Implement **exactly** the checklist under
Scope and nothing else. If something outside it blocks you, stop and record
that as `result:blocked` rather than improvising beyond scope.

### Stage: validate

Read `## Refined` and `## Scope`. Review the implementation against the
acceptance criteria — read the actual code, run tests if any exist for the
area you're checking. **Do not fix anything yourself** — only report whether
it passes. A `failed` result is a legitimate outcome, not something to avoid;
see the state table above for what happens to the card either way.

## Receipt grammar

Append exactly one line per stage attempt to `## Log`:

```
- run:<runId> task:<taskId> stage:<refine|develop|validate> result:<ok|blocked|failed> note:"<one line>"
```

`taskId` must match the file you're writing it into — this is how the board
rejects a receipt that landed in the wrong file. `result:blocked` means you
couldn't proceed (missing information, an unresolved question); `result:failed`
means something went wrong (for validate, it doubles as "checked and it
doesn't pass" — see the state table).

## Filing follow-up tasks (develop and validate only)

If you notice clearly out-of-scope follow-up work — not something to do now,
but worth not losing — file it as its own task rather than expanding the one
you're on. Two things happen together:

1. Add a line to the current task's `## Log`, alongside your receipt:
   ```
   - propose-task run:<runId> title:"<short title>" note:"<why this is separate, one line>"
   ```
2. Actually create the new task file yourself, the same way the extension's
   own "New Task" does:
   - Next id: scan `.kanban-pilot/tasks/TASK-*.md` for the highest number in
     use, add 1, zero-pad to 3 digits (`TASK-042`). If none exist, start at
     `TASK-001`.
   - Write `.kanban-pilot/tasks/TASK-<n>.md`:
     ```
     ---
     id: TASK-042
     title: <the title from your propose-task line>
     state: backlog
     status: idle
     created: <now, ISO 8601>
     updated: <same timestamp>
     chat_reset_required: false
     origin_task: <the task you were working when you noticed this>
     ---

     ## Request
     <your note — why this is worth tracking>

     _Filed automatically by <origin task id>'s run <runId>._

     ## Refined

     ## Scope

     ## Log
     ```

Cap yourself at a handful (5) per run — this is for genuine, concrete
follow-ups you actually noticed, not a brainstorm.

## Things to never do

- Never invent a `state` or `status` value outside the enums above — an
  unrecognized one silently resets the card to Backlog on the board, which
  looks like the work vanished even though the file is intact.
- Never touch `## Request` on an existing task, or another task's file,
  except by creating a *new* file via the proposal flow above.
- Never skip the frontmatter transition after finishing — a receipt alone
  doesn't move the card; the receipt-parsing supervisor that would normally
  do that for you is you, here.
- Never leave `run` set once you're done, successfully or not.
- Never set `chat`, `copilot_session_id`, or `chat_reset_required` — they're
  VS Code/Copilot session bookkeeping that doesn't apply to you.
