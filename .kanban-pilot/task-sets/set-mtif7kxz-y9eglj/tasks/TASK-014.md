---
id: TASK-014
title: Copilot accepts hook configs for four events it never dispatches
type: bug
state: done
status: idle
position: 9
created: 2026-09-01T12:36:29Z
updated: 2026-09-01T21:54:38Z
scope_hash: 99843e0
chat_reset_required: false
origin_task: TASK-010
---

## Request
Found while designing the hook feed (docs/copilot-hook-feed-design.md, "The event gap").

Copilot Chat 0.55.0's hooks wizard offers twelve events, but the editor only ever dispatches eight.
`PermissionRequest`, `PostToolUseFailure`, `SessionEnd` and `Notification` can be configured, are
accepted, and never fire in VS Code - every `executeHook` call site in the extension bundle passes one
of PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStart, SubagentStop, PreCompact or
SessionStart.

From a user's point of view that is a silent no-op: the wizard confirms a hook that cannot run. The
four missing events do exist in the bundled Copilot CLI SDK's event list, so this reads as an editor
gap rather than a documentation error.

This is not Kanban Pilot's defect, so the action is to report it upstream and to re-check it on
Copilot upgrades - `PermissionRequest` landing in the editor would materially change the case for
building the hook feed at all.

_Filed automatically by TASK-010's run rh2b9x._

## Refined

### Problem statement

Copilot Chat 0.55.0's hooks wizard accepts configuration for twelve events, but the editor's
`ChatHookService` only ever dispatches eight. `PermissionRequest`, `PostToolUseFailure`,
`SessionEnd` and `Notification` can be configured, are confirmed by the wizard, and never fire. The
four missing events do exist in the bundled Copilot CLI SDK's event list, so this is an editor gap
rather than a documentation error.

This is not a Kanban Pilot defect and there is no product code to fix. It still needs to be worked,
for the two reasons `docs/copilot-hook-feed-design.md` already names in its recommendations 3 and 4:

- **It is a real user-facing defect for whoever owns it,** and nobody has reported it. A wizard that
  accepts a hook which cannot run is a silent no-op.
- **It gates a decision this repo has not made yet.** The design doc withdrew the strongest argument
  for building the hook feed - live approval moments - solely because `PermissionRequest` is not
  dispatched. If a later Copilot build starts dispatching it, the hooks-versus-transcript trade-off
  changes materially and TASK-015 should be reconsidered. Today that re-check exists only as a
  sentence in prose, which will not survive a Copilot upgrade six months from now.

So the deliverable is evidence plus durability: a re-verified finding, a report someone can file
upstream without redoing the analysis, and a mechanical check that fails loudly when the gap closes.

### Assumptions

- **Filing is a human action.** This ticket produces a ready-to-file report inside the repository.
  Submitting it to the upstream tracker publishes content under the maintainer's own account, so the
  develop stage does not do it; a follow-up card carries the actual filing and the resulting URL.
- **No hook is installed and no chat settings are written.** `.claude/settings.json`,
  `.claude/settings.local.json` and `~/.claude/settings.json` are untouched, exactly as in TASK-010.
- **Verification is read-only inspection of the installed Copilot bundle** - the same method the
  design doc used. No Copilot source is copied into this repository beyond event-name identifiers.
- The version observed on the machine running the check is the version recorded. If it is still
  0.55.0, that is a confirmation, not a failure.

### Acceptance criteria

- The event gap is **re-verified against the Copilot Chat build installed on the machine running the
  check**, and the observed VS Code and Copilot Chat versions are recorded alongside the result. The
  configurable list and the dispatched list are both enumerated, and the four-event delta is stated
  explicitly.
- A **ready-to-file upstream report** exists at `docs/copilot-hook-event-gap-upstream.md` containing:
  environment and versions, what the user does, expected versus actual behaviour, how the finding was
  established, the twelve configurable and eight dispatched event lists, and a short impact
  statement. It contains no workspace paths, session ids, transcript content, or other local data -
  it is written to be pasted into a public tracker as-is.
- A **repeatable check** exists at `scripts/check-copilot-hook-events.mjs`. Run against the installed
  Copilot bundle it prints the configurable and dispatched event sets and the delta, exits `0` when
  the delta matches the recorded baseline, and exits non-zero with a clear message when it does not -
  in particular when `PermissionRequest` becomes dispatched. When the bundle is missing or cannot be
  parsed it exits with a distinct, explicit message rather than reporting a false match or a false
  change.
- The check has a **`node --test` companion** at `scripts/check-copilot-hook-events.test.mjs` that
  covers the parse-and-compare logic against small inline fixtures, needs no real Copilot install, and
  is reachable through a `package.json` script - matching the `watch-transcript` and `install-skill`
  convention already in the repo.
- `docs/copilot-hook-feed-design.md` recommendations 3 and 4 **point at those two artefacts** instead
  of only describing them in prose, and state the concrete trigger: a dispatched `PermissionRequest`
  reopens the hooks-versus-transcript decision and TASK-015's priority.
- **No behaviour change ships.** Nothing under `src/` is modified, no hook is installed, no
  `.claude/settings*.json` is written, and `npm run lint` plus the new `node --test` run pass.
- The check's fragility is **documented, not hidden**: it inspects a large minified bundle by pattern,
  so its header comment and its own output say that a parse failure means re-check by hand using the
  report's method, and it never silently reports no change when it could not parse.

### Out of scope

- Building the hook receiver or the spool - that is TASK-015, and the design doc's recommendation 1
  says not to build it before TASK-008.
- Installing, generating, or committing any Copilot hook configuration.
- Working around the gap, for example by reaching approval state through another route.
- Any edit to another task's card; downstream linkage is recorded in the design doc.

## Scope

- **Re-verify the finding.** Locate the installed Copilot Chat extension bundle
  (`resources/app/extensions/copilot`, `main: ./dist/extension`) and its `package.json` version, plus
  the running VS Code version. Enumerate the events offered by the hooks configuration surface and the
  events passed to `executeHook` call sites. Record both lists and the delta. Read-only; copy no
  bundle source into the repository.
- **Add `scripts/check-copilot-hook-events.mjs`.**
	- Accept an optional bundle path argument; fall back to the platform default install location.
	- Extract the configurable and dispatched event sets, then print both plus the delta.
	- Compare against a baseline constant in the file (the twelve/eight split and the four-event
	  delta) and exit non-zero when the delta differs, naming which events changed and calling out
	  `PermissionRequest` specifically.
	- Exit non-zero with a distinct bundle-not-found or could-not-parse message rather than reporting
	  a spurious match or a spurious change.
	- Header comment states the method, the version it was written against, and its fragility.
- **Add `scripts/check-copilot-hook-events.test.mjs`.** `node --test` style, matching
  `scripts/watch-transcript.test.mjs`. Cover: baseline match, `PermissionRequest` newly dispatched, an
  event added to the configurable list, and unparseable input. Use inline fixture strings; no real
  Copilot install required.
- **Register the script in `package.json`.** Add a `test:copilot-hook-events` entry next to
  `test:watch-transcript`, and a `check:copilot-hook-events` entry for the live check if it reads
  naturally alongside the existing entries. Do not change `pretest` or `test`.
- **Write `docs/copilot-hook-event-gap-upstream.md`.** Report-shaped and ready to paste into a public
  tracker: title, environment table, steps to reproduce (configure a `PermissionRequest` hook through
  `copilot.claude.hooks`, confirm it is accepted, run a turn that triggers an approval, observe that
  the hook never runs and that nothing appears in the GitHub Copilot Chat Hooks output channel),
  expected versus actual, evidence, the twelve and eight event lists, impact, and a note that the four
  events are present in the bundled Copilot CLI SDK's event list. No local paths, session ids, or
  transcript content.
- **Amend `docs/copilot-hook-feed-design.md`.** In the Recommendation section, link recommendation 3
  to the script and recommendation 4 to the report, and state the reopen trigger for TASK-015. Leave
  the rest of the document as written - it is a dated finding.
- **File one follow-up** covering the outward-facing step: submitting the report upstream and
  recording the issue URL, which the maintainer does from their own account.
- **Verify.** Run `npm run lint` and the new `node --test` suite; run the live check once against the
  installed bundle and confirm its output matches the re-verified finding; confirm `git status` shows
  no change under `src/`, no `.claude/settings*.json`, and no packaged bundle artefacts.

## Log
- audit:state-change at:2026-09-01T12:37:46Z task:TASK-014 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:rq4m7t2 task:TASK-014 at:2026-09-01T12:43:38Z note:"reading the hook feed design finding and scoping the upstream report"
- run:rq4m7t2 task:TASK-014 stage:refine result:ok note:"2026-09-01T12:45:40Z — refine completed: scoped the upstream report, a repeatable Copilot hook-event check with tests, and the design-doc linkage; no product code"
- audit:state-change at:2026-09-01T12:46:16Z task:TASK-014 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T21:54:26Z task:TASK-014 from:approved to:in-progress action:move note:"State changed from approved to in-progress via move."
- audit:state-change at:2026-09-01T21:54:38Z task:TASK-014 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
