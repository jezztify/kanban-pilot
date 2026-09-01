---
id: TASK-010
title: Design a Copilot hook that pushes run events at Kanban Pilot
type: feature
state: done
status: idle
position: 5
created: 2026-09-01T09:47:12Z
updated: 2026-09-01T21:54:30Z
scope_hash: 04b6aa0
chat_reset_required: false
origin_task: TASK-005
---

## Request
Found while investigating response streaming (docs/copilot-response-streaming-spike.md,
finding 4 and recommendation 3).

Copilot 0.55.0 runs user-configured hooks from `.github/hooks`, invoking a shell command with a JSON
payload that includes `hook_event_name`, `session_id`, and `transcript_path` - and it flushes the
session transcript before firing. Its event vocabulary includes `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `Stop`, `SessionEnd`, `PermissionRequest`, and `PermissionDenied`.

This is the only push-based source found, and the only one that surfaces approval moments as they
happen - the case PRD 6.10 and docs/browser-chat-proxy-spike.md both identify as the one that
matters most for a remote viewer, who cannot click Allow.

It needs its own design conversation rather than being folded into the transcript work, because it
means writing a file into the user's repository: what the hook command does, whether it posts to the
extension's existing local HTTP server or drops a file the extension watches, how a user opts in and
out, and what happens on a machine where the hook is absent.

_Filed automatically by TASK-005's run rb7t4m._

## Refined

### Problem statement

Copilot 0.55.0 runs user-configured shell commands on chat events, discovered from `.github/hooks`,
and hands each one a payload of `{timestamp, hook_event_name, session_id, transcript_path}` after
flushing the session transcript first (spike finding 4). Its event vocabulary includes
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `SessionEnd`, `PermissionRequest` and
`PermissionDenied`.

Two things changed since this card was filed, and both sharpen it.

**The destination now exists.** TASK-007 shipped the activity feed: `parseProgressEntries(log, id)`
bounded to the last 20 entries, projected onto the task and rendered in the board detail pane, with
the browser channel covered by integration tests. So a hook does not need a new UI or a new
transport invented for it — it needs a way to put a line where the feed already looks.

**Hooks are now the only route to liveness.** TASK-009 measured the transcript tail at a median
~6 s and up to 53 s behind on tool events. Hooks fire *at* the event. That is the entire reason to
consider them, and it is also why `PermissionRequest`/`PermissionDenied` matter more than the rest:
they are the approval moments PRD §6.10 and the browser spike both identify as the case a remote
viewer most needs and can least act on.

This stays a design card rather than a build card for three specific reasons, not general caution:

- **It writes a file into the user's repository.** `.github/hooks` is version-controlled and shared
  with everyone who clones it. Installing one is a change to the team's environment, not to Kanban
  Pilot's.
- **A hook can block a tool call.** The service honours a `{decision: "block"}` result, and treats
  some failures as blocking. A badly-behaved hook can break the user's Copilot session — a much worse
  failure mode than a feed that lags.
- **The per-event cost is a process spawn.** TASK-007's own develop run made **340 tool calls in
  30 minutes**. Subscribing to `PreToolUse` and `PostToolUse` would be roughly **680 process spawns**
  for one stage. That is a real budget question, not a rounding error.

Three things must be verified before any of that can be designed honestly: the hook definition
file's exact schema, whether a user-level (non-repository) hook location exists, and which of the
event names actually reach the VS Code `ChatHookService` — the full list was read from the bundled
Copilot CLI SDK, which may dispatch more events than the editor does.

### Acceptance criteria

- A new `docs/copilot-hook-feed-design.md` exists, dated, opening with a **Go / No-go /
  Conditional-go** line, in the shape the other spike documents use.
- The hook mechanism is recorded from the shipped Copilot 0.55.0 bundle with evidence, not from
  memory: the hook definition file's schema and fields, the discovery paths and their precedence,
  the payload fields, the result and `decision` semantics, any timeout, and the output channel it
  logs to. Anything that could not be established is said so rather than assumed.
- The event list is stated as *what the editor dispatches*, distinguished from the CLI SDK's list,
  or the difference is explicitly recorded as unverified.
- A transport is chosen from the candidates and justified: appending a `progress` line to the task's
  `## Log`, posting to the existing local HTTP server, or dropping a spool file the extension
  watches. The chosen option's failure modes are stated, and for the task-file option the write race
  against `RunManager` — which is writing the same file during a run — is analysed rather than
  waved at.
- The design states how a hook maps `session_id` to a task, and handles the case TASK-011 exposed:
  during a task's **first** run `copilot_session_id` is not yet in the frontmatter, so the mapping
  does not exist while the events are firing.
- A minimal event subscription is specified, with an invocation-count estimate per stage run worked
  through against TASK-007's observed 340 tool calls.
- The **fail-open contract** is explicit: a hook that errors, times out, is missing, or finds no
  extension running must never block a tool call, fail a stage, or slow a turn measurably. This is
  stated as a requirement on any future implementation, with the block semantics it must avoid.
- Installation scope and consent are addressed: that `.github/hooks` is committed and therefore
  shared, whether a user-level location exists, and the rule that Kanban Pilot never writes a hook
  into a user's repository without an explicit action.
- The redaction rule matches the feed's: a hook may carry event name, session id, and tool *name*;
  never tool arguments, prompts, or message content.
- The document ends with a recommendation and files any build work as separate cards. No hook file is
  installed into this repository, and no product code changes, under this ticket.

### Assumptions

- Evidence is taken from the Copilot Chat 0.55.0 bundle shipped with VS Code 1.127.0, as installed
  here, and recorded as holding for that build.
- The feed TASK-007 built is the destination. A hook is an additional *source* for it, not a second
  UI, and nothing about the feed's rendering is redesigned here.
- Hooks are installed by a person. The extension may offer to generate one, but the design assumes it
  never appears without the user asking for it.
- Estimating invocation cost from TASK-007's run is a worked example, not a benchmark; a real
  measurement would be its own card.

## Scope

- Verify the mechanism against the shipped bundle before designing anything on top of it:
  - The hook definition file's schema — fields per hook, how commands and their `cwd` are expressed,
    and how a hook selects which events it wants.
  - Discovery paths and precedence: workspace `.github/hooks` is confirmed recursive; establish
    whether a user-level location exists alongside the `.copilot`/`.agents` customization roots.
  - The event names the editor's `ChatHookService` dispatches, versus the list read from the bundled
    CLI SDK.
  - Payload fields, the 500 ms transcript-flush race before dispatch, result kinds, the
    `{decision, reason, additionalContext}` contract, and which events honour `block`.
- Decide the transport, and write down why the others were rejected:
  - **Task-file `progress` line** — reuses `progress.ts` and the feed TASK-007 built end to end, with
    no new surface. Analyse the write race: `RunManager` writes the same file during a run, so
    establish whether an external append can be lost or can corrupt a concurrent write, and what
    ordering guarantee exists.
  - **Local HTTP server** — `RealtimeBoardServer` already exists and is token-gated; assess whether
    the token can reach a hook command without being committed to the repository.
  - **Spool file plus watcher** — most isolated, but adds a surface and a cleanup obligation.
- Resolve session-to-task mapping, including the first-run gap where `copilot_session_id` does not
  yet exist, and say what the hook does with events it cannot attribute.
- Choose the event subscription and cost it:
  - Prefer the smallest set that delivers liveness — turn start, turn end, approval moments — over
    subscribing to every tool call.
  - Work the invocation count against TASK-007's 340 tool calls in 30 minutes, and state the budget
    the design accepts.
- Specify the fail-open contract and the degraded paths: extension not running, board closed, task
  file missing, hook command absent, command slow.
- Specify installation scope, consent, and removal: what a user installs, where, what it means for
  teammates who clone the repository, and how it is uninstalled cleanly.
- Write `docs/copilot-hook-feed-design.md` following the existing spike shape — dated decision line,
  question and boundaries, verified mechanism, transport comparison, risks, and a smallest-safe
  follow-up plan.
- Close out without scope creep:
  - Do not install a hook file into `.github/hooks`, and do not modify `src/chat/executor.ts`,
    `src/chat/runManager.ts`, `src/chat/progress.ts`, `src/board/boardPanel.ts`,
    `src/http/realtimeBoardServer.ts`, or any contributed setting.
  - File recommended build work as separate tasks via the proposal flow.
  - Confirm by reviewing the diff that only the new document and this task file were touched.

## Log
- audit:state-change at:2026-09-01T10:20:50Z task:TASK-010 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rw6q4t task:TASK-010 at:2026-09-01T12:31:36Z note:"scoping the hook design against the feed that shipped and the lag the measurement found"
- run:rw6q4t task:TASK-010 stage:refine result:ok note:"2026-09-01T12:31:36Z — refine completed: scoped a design-only card covering hook schema verification, the transport choice against the feed TASK-007 shipped, event cost, and the fail-open contract"
- audit:state-change at:2026-09-01T12:32:26Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T12:32:55Z task:TASK-010 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:rh2b9x task:TASK-010 at:2026-09-01T12:32:55Z note:"verifying the hook configuration schema and dispatch surface in the shipped bundle"
- propose-task run:rh2b9x type:bug title:"Copilot accepts hook configs for four events it never dispatches" note:"the wizard confirms a PermissionRequest hook that can never fire in the editor"
- propose-task run:rh2b9x type:feature title:"Build the hook spool receiver behind the activity feed" note:"the receiver carries the data-loss risk and depends on TASK-008 shipping first"
- run:rh2b9x task:TASK-010 stage:develop result:ok note:"2026-09-01T12:36:29Z — develop completed: verified the hook mechanism from the bundle, found four configurable events the editor never dispatches, chose a spool file over the task file because task writes are read-modify-write, and recommended deferring the build behind TASK-008"
- audit:state-change at:2026-09-01T21:54:30Z task:TASK-010 from:validation to:done action:move note:"State changed from validation to done via move."
