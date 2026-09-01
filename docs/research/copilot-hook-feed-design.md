# Copilot Hook Feed Design

Date: 2026-09-01
Task: TASK-010 — "Design a Copilot hook that pushes run events at Kanban Pilot"

Decision: **Conditional go, at reduced value.** Hooks work, they are well-specified, and they deliver
turn and tool events at effectively zero lag against the transcript tail's measured 5–50 s. But the
headline argument for them — surfacing approval moments live — **does not survive contact with the
implementation**: the editor never dispatches `PermissionRequest`. What remains is a real but smaller
win, and it should be built on a spool file rather than the task file.

## Question and boundaries

Can a Copilot hook push run events into the activity feed TASK-007 shipped, fast enough to be worth
the cost of installing one?

| Surface | Treatment |
| --- | --- |
| Copilot 0.55.0's hook configuration, dispatch, and execution | Target. Verified from the shipped bundle. |
| The feed built by TASK-007 | The destination. Not redesigned here. |
| Transcript tailing (TASK-008) | Compared against, not replaced. The two are complementary. |
| Actually installing a hook, or implementing a receiver | Out. This is a design finding. |

No hook was installed, and no product code changed.

## Verified mechanism (Copilot Chat 0.55.0, VS Code 1.127.0)

Hooks are **Claude Code hooks**, implemented by Copilot's Claude compatibility provider — the slash
command is literally `copilot.claude.hooks`, "Configure Claude Code hooks for tool execution and
events".

| Property | Value |
| --- | --- |
| Configuration files | `<workspace>/.claude/settings.json`, `<workspace>/.claude/settings.local.json`, `~/.claude/settings.json` |
| Hook fields | `command`, optional `cwd`, `env`, `timeout` (seconds) — plus a `matcher` per event for tool-scoped events |
| Payload delivery | JSON written to the command's **stdin**, then stdin closed |
| Payload fields | `timestamp`, `hook_event_name`, `session_id`, `transcript_path`, event-specific extras, `cwd` when the hook sets one |
| Transcript flush | The session transcript is flushed before dispatch, raced against a 500 ms timeout |
| Working directory | **`homedir()` by default** — not the workspace — unless the hook sets `cwd` |
| Windows execution | When `ComSpec` is `cmd.exe`, the command runs via `powershell.exe -ExecutionPolicy Bypass -NoProfile -NoLogo -Command <command>`; otherwise `shell: true` |
| Timeout | **30 s default**, then `SIGTERM`, then `SIGKILL` 5 s later |
| Exit codes | **0 = success** (stdout parsed as JSON when parseable), **2 = block**, anything else = non-blocking error |
| Result contract | `continue`, `stopReason`, `systemMessage`, `hookSpecificOutput`, `hookEventName`; a result whose `hookEventName` disagrees with the dispatched event is ignored, and a mismatched `hookSpecificOutput` is stripped |
| Logging | Output channel "GitHub Copilot Chat Hooks" |

### The event gap — the finding that changes the recommendation

Twelve events are **configurable** through the wizard:

`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`,
`SubagentStart`, `SubagentStop`, `PreCompact`, `SessionStart`, `SessionEnd`, `Notification`
— of which the first four take a `matcher`.

Only **eight** are actually dispatched by the editor. Every `executeHook` call site in the extension
bundle passes one of:

`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`,
`PreCompact`, `SessionStart`.

So **`PermissionRequest`, `PostToolUseFailure`, `SessionEnd` and `Notification` are configurable but
never fire in VS Code.** They appear in the wizard and in the bundled Copilot CLI's event list; the
editor's `ChatHookService` does not dispatch them. A user can configure a `PermissionRequest` hook,
see it accepted, and never have it run.

This matters because the response-streaming spike nominated hooks as "the only push-based source and
the only one that surfaces approval moments as they happen". The first half stands. **The second half
is false for the editor**, and it was the stronger half — approval is the moment a remote viewer most
needs and least can act on. That argument is now withdrawn.

## Transport — spool file, not the task file

Three candidates were considered. The task-file option is the one that looks best and fails.

**Rejected: append a `progress` line to the task's `## Log`.** This is the tempting option because it
reuses `progress.ts` and the feed end to end with no new surface. It loses data. `TaskStore` writes
task files by full read-modify-write, then `writeAtomic` replaces the file through a temp path and a
rename with `overwrite: true` ([taskStore.ts:494-500](../../src/model/taskStore.ts#L494-L500)). Any
append made by an external process between the extension's read and its rename is silently
discarded — a classic lost update, and the window is open precisely during a run, which is exactly
when hook events fire. There is no advisory locking to opt into.

**Rejected: POST to the local HTTP server.** `RealtimeBoardServer` exists and is token-gated, but the
hook would need the bearer token, and the only places to put it are the hook command line or an env
var in a settings file — i.e. a shared secret written into a config file, possibly a committed one.
It also only works while the server is enabled, which is optional.

**Recommended: a spool file the extension watches.** The hook appends one JSON line to a
workspace-local spool (for example `.kanban-pilot/.hook-spool.jsonl`); the extension watches it,
merges entries into the feed projection, and truncates it. This keeps **all task-file writes inside
the extension**, which is the property the other two options give up. It costs a new file and a
cleanup obligation, and it needs the feed projection in `boardPanel.ts` to union spool entries with
the log-derived ones instead of reading only `parseProgressEntries`.

## Session-to-task mapping — solved by `UserPromptSubmit`

TASK-011 established that `copilot_session_id` is written 2 s after a run's *last* event, so during a
task's first run there is no session→task mapping while events are firing.

`UserPromptSubmit` closes this. It is dispatched with the prompt as an extra field, and every Kanban
Pilot prompt opens with `## [{{projectName}} {{id}}]` — the misroute marker from PRD §6.5, which is
load-bearing and present in every stage template ([promptTemplates.ts:91](../../src/chat/promptTemplates.ts#L91)).
So the hook can parse `TASK-nnn` out of the prompt at turn start, pair it with `session_id` from the
same payload, and write that mapping into the spool before any tool event fires. No dependency on
frontmatter, and it works on a first run.

It also gives the receiver a way to ignore non-Kanban-Pilot sessions cleanly: a session whose
`UserPromptSubmit` prompt carries no task marker is simply not ours.

## Event subscription and cost

Recommended set: **`UserPromptSubmit`** (turn start plus the mapping), **`PostToolUse`** (activity),
**`Stop`** (turn end).

`PreToolUse` is deliberately excluded: it doubles the spawn count and carries no information
`PostToolUse` lacks for a feed that reports what happened.

The cost is a process spawn per event, and the turn waits for it. Worked against a real run —
TASK-007's own develop session made **340 tool calls in 30 minutes**:

| Subscription | Spawns per run |
| --- | --- |
| `PreToolUse` + `PostToolUse` | ~680 |
| `PostToolUse` only | ~340 |
| `PostToolUse` with a narrow `matcher` | fewer, in proportion |

On Windows each spawn is a PowerShell process. At a conservative 200 ms that is roughly 68 s added
across a 30-minute run — about 4% — and it is not free. Two mitigations belong in any build: set a
short explicit `timeout` (the 30 s default is far too long to let a wedged hook stall a turn), and
scope `PostToolUse` with a `matcher` rather than `*` if the feed only needs certain tools.

## The fail-open contract

A hook can break the user's session, which makes this the most important requirement in the document.

- **Always exit 0.** Exit code 2 blocks the tool call. Any internal failure — spool unwritable,
  malformed payload, extension not running — must still exit 0 and produce no output.
- **Never emit `{"continue": false}`** or a `stopReason`.
- **Set an explicit short `timeout`.** The default is 30 s; a hook that hangs holds the turn for 30 s
  before `SIGTERM` and another 5 s before `SIGKILL`.
- **Set `cwd` explicitly.** The default working directory is the user's home, not the workspace, so
  any relative path in the command resolves somewhere surprising.
- **Assume the extension is absent.** The spool is written whether or not anything is watching, and
  an unbounded spool is a leak — the receiver truncates, and the hook should cap the file.

## Installation, consent, and removal

The sharing objection raised when this card was filed turns out to be avoidable. Of the three
configuration locations, `<workspace>/.claude/settings.local.json` is workspace-scoped and
conventionally untracked, and `~/.claude/settings.json` is per-user. A hook does **not** have to be
committed to be installed.

- Default to `settings.local.json`; document `~/.claude/settings.json` for someone who wants it across
  every workspace.
- Kanban Pilot must never write a hook into any of these files without an explicit user action. If a
  command is offered to generate one, it names the file it will modify and shows the JSON first.
- Removal is deleting the entry; the design should not leave state that survives it beyond the spool
  file, which the receiver deletes when hook input stops.

## Redaction

The hook may carry: `hook_event_name`, `session_id`, the parsed task id, the tool **name**, and
timestamps. It must not carry tool arguments, prompt text beyond the task marker, tool output, or
`transcript_path` contents. This matches the rule the feed already follows, and matters because the
feed reaches the token-gated browser surface.

## Installing the hook (TASK-015)

`scripts/kanban-pilot-hook.mjs` is the receiver's counterpart. Add this to
`<workspace>/.claude/settings.local.json` — the workspace-scoped, conventionally untracked location,
so the hook is not shared with everyone who clones the repository:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
        "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
        "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
    ],
    "Stop": [
      { "matcher": "*", "hooks": [{ "type": "command", "timeout": 5,
        "command": "node \"<repo>/scripts/kanban-pilot-hook.mjs\" --spool \"<repo>/.kanban-pilot/.hook-spool.jsonl\"" }] }
    ]
  }
}
```

Then set `kanbanPilot.chat.hookFeed` to `true`, and `kanbanPilot.chat.transcriptFeedRemote` as well if
the browser board should receive it.

Two details are deliberate. `timeout` is set to 5 rather than left at Copilot's 30 s default, so a
wedged hook cannot hold a turn for half a minute. Absolute paths are used because a hook's working
directory defaults to the user's home, not the workspace.

The exact hook-definition shape above still needs confirming against a live run — TASK-010 verified the
executor, the payload, and the discovery locations from the bundle, but not the JSON schema of a hook
entry itself.

## Recommendation

1. **Do not build this before TASK-008.** With `PermissionRequest` unavailable, hooks buy latency on
   turn and tool events — not a class of event the transcript cannot reach. The transcript tail
   delivers the same content 5–50 s later with no config file, no spawn cost, and no ability to break
   a session. Latency is worth paying for, but it is an optimisation of a feature that does not exist
   yet.
2. **If built, build it as the spool receiver first**, with a hand-written hook, and only then
   consider a generator command. The receiver is the part that carries risk of data loss; the hook
   itself is a few lines.
3. **Re-check the event gap on Copilot upgrades.** `PermissionRequest` is configurable and wired
   through the CLI SDK, so it is plausibly a matter of time before the editor dispatches it. If it
   lands, the case for hooks changes materially and this recommendation should be revisited.
4. **Report the configurable-but-never-dispatched events upstream.** A wizard that accepts a
   `PermissionRequest` hook which cannot fire is a defect from the user's point of view, whoever owns
   it.
