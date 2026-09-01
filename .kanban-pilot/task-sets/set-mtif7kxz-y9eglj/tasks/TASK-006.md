---
id: TASK-006
title: PRD 6.10 states two things about chat access that are no longer true
type: bug
state: done
status: idle
position: 10
created: 2026-09-01T09:47:12Z
updated: 2026-09-01T23:26:59Z
chat: kanban-pilot-set-mtif7kxz-y9eglj-TASK-006
copilot_session_id: 534e4750-23ab-4420-b4d9-1556e0ddeb8e
scope_hash: 033bd6e
chat_reset_required: true
origin_task: TASK-005
---

## Request
Found while investigating response streaming (docs/copilot-response-streaming-spike.md,
findings 2 and 3).

PRD 6.10's table gives three reasons the webview cannot mirror the transcript. Two of them are stale
for VS Code 1.127.0:

- "`workbench.action.chat.export` opens a showSaveDialog - interactive, so unusable" is wrong when
  the command is given a target URI. The dialog branch is guarded by `if (!target)`; with a URI it
  writes the full export directly.
- "sessions persist under an internal root in an undocumented format" understates what is knowable.
  The location is `workspaceStorage/<ws>/chatSessions/`, derivable from any extension's own
  `storageUri`, and the lag is measurable rather than unknown: persistence rides
  `onWillSaveState` with a 60-second default flush interval.

The section's conclusion - dock the real chat rather than mirror it - is unaffected and should be
kept. Only its stated reasons need correcting, so a future reader does not rule out a route on
evidence that has expired.

Scope is PRD 6.10 only. The same investigation also established that Copilot Chat is installed as a
built-in extension at `resources/app/extensions/copilot` (GitHub.copilot-chat 0.55.0), which
contradicts a premise recorded elsewhere; that correction is already captured in
docs/copilot-response-streaming-spike.md and is deliberately not part of this card.

_Filed automatically by TASK-005's run rb7t4m._

## Refined

### Problem statement

PRD section 6.10 correctly recommends docking the real chat instead of mirroring its transcript, but two rows in its rationale describe VS Code 1.127.0 capabilities too narrowly. A target URI lets `workbench.action.chat.export` write a complete export without opening a save dialog. Workbench session persistence is also more knowable than the current wording suggests: workspace sessions live under `workspaceStorage/<ws>/chatSessions/`, the location can be derived from an extension's `storageUri`, and persistence normally flushes through `onWillSaveState` on a 60-second cadence. Update only those reasons so the documentation distinguishes available-but-unsuitable sources from unavailable ones while preserving the existing docking conclusion.

### Acceptance criteria

- The persisted-session row identifies `workspaceStorage/<ws>/chatSessions/` as the workspace location, notes that an extension can derive it from its own `storageUri`, and describes the session data as an undocumented journal whose default persistence lag can reach about 60 seconds through `onWillSaveState`.
- The export row states that `workbench.action.chat.export` bypasses `showSaveDialog` when given a target URI and writes the export directly; it may still note that calls without a target remain interactive and that export is not a live continuous mirror.
- The section keeps its conclusion and surrounding rationale that the real chat should be docked rather than reimplemented inside the webview.
- The documentation change is limited to PRD section 6.10; no code, spike-document, or unrelated PRD content is part of this ticket.

## Scope
- [ ] Update `docs/PRD.md` section 6.10's persisted-session table row with the derivable workspace location, undocumented journal qualification, and measurable approximately 60-second default flush lag.
- [ ] Update the `workbench.action.chat.export` table row to distinguish target-URI exports from no-target save-dialog behavior and retain the limitations relevant to continuous mirroring.
- [ ] Review the paragraph and conclusion immediately following the table, preserving the recommendation to dock the real chat and changing only wording needed for consistency with the corrected rows.
- [ ] Inspect the final diff and search for the two stale claims, confirming that only PRD section 6.10 changed and no code or spike documentation was modified.

## Log
- audit:state-change at:2026-09-01T12:30:10Z task:TASK-006 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-01T21:56:44Z task:TASK-006 from:idle to:running action:refine run:r4z6w18 note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-01T21:56:44Z task:TASK-006 stage:refine action:refine run:r4z6w18 note:"Started refine activity."
- progress run:r4z6w18 task:TASK-006 at:2026-09-01T21:57:21Z note:"investigation complete; drafting the refined problem statement and checklist"
- progress run:r4z6w18 task:TASK-006 at:2026-09-01T21:57:59Z note:"refined problem statement and implementation checklist written"
- progress run:r4z6w18 task:TASK-006 at:2026-09-01T21:58:06Z note:"documentation diff check and scope review passed"
- progress run:r4z6w18 task:TASK-006 at:2026-09-01T21:58:12Z note:"refinement complete; waiting for approval before implementation"
- run:r4z6w18 task:TASK-006 stage:refine result:ok note:"2026-09-01T21:58:18Z — refine completed: clarified the two stale chat-access claims and limited implementation scope to PRD section 6.10"
- audit:status-change at:2026-09-01T21:58:51Z task:TASK-006 from:running to:idle action:receipt run:r4z6w18 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T21:58:51Z task:TASK-006 stage:refine action:receipt run:r4z6w18 outcome:ok note:"2026-09-01T21:58:18Z — refine completed: clarified the two stale chat-access claims and limited implementation scope to PRD section 6.10"
- audit:state-change at:2026-09-01T22:11:58Z task:TASK-006 from:refine to:scoped action:apply-pending run:r4z6w18 outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-01T22:12:00Z task:TASK-006 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T22:12:02Z task:TASK-006 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-01T22:12:02Z task:TASK-006 from:idle to:running action:develop run:rvtd8am note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-01T22:12:02Z task:TASK-006 stage:develop action:develop run:rvtd8am note:"Started develop activity."
- receipt-diagnostic kind:run-mismatch task:TASK-006 expected-run:rvtd8am expected-stage:develop actual-run:r4z6w18 actual-task:TASK-006 actual-stage:refine note:"Ignored receipt because run id r4z6w18 is stale; expected rvtd8am."
- run:rvtd8am task:TASK-006 stage:develop result:blocked note:"no receipt found; awaiting late receipt"
- audit:status-change at:2026-09-01T22:15:31Z task:TASK-006 from:running to:blocked action:missing-receipt run:rvtd8am outcome:missing-receipt note:"Status changed from running to blocked via missing-receipt."
- audit:activity-finish at:2026-09-01T22:15:31Z task:TASK-006 stage:develop run:rvtd8am outcome:missing-receipt provisional:true note:"no receipt found; awaiting late receipt"
- progress run:rvtd8am task:TASK-006 at:2026-09-01T23:07:28Z note:"investigation complete; confirmed the two stale access claims and the preserved docking recommendation"
- progress run:rvtd8am task:TASK-006 at:2026-09-01T23:07:38Z note:"editing complete; corrected the persisted-session and export rationale"
- progress run:rvtd8am task:TASK-006 at:2026-09-01T23:08:07Z note:"testing complete; section assertions and whitespace checks passed"
- run:rvtd8am task:TASK-006 stage:develop result:ok note:"2026-09-01T23:08:13Z — develop completed: corrected PRD 6.10 chat-access rationale and verified the docking conclusion"
- audit:status-change at:2026-09-01T23:08:17Z task:TASK-006 from:blocked to:idle action:late-receipt run:rvtd8am outcome:ok note:"Status changed from blocked to idle via late-receipt."
- audit:activity-finish at:2026-09-01T23:08:17Z task:TASK-006 stage:develop action:late-receipt run:rvtd8am outcome:ok correction:true note:"2026-09-01T23:08:13Z — develop completed: corrected PRD 6.10 chat-access rationale and verified the docking conclusion"
- progress run:rvtd8am task:TASK-006 at:2026-09-01T23:10:39Z note:"validation complete; acceptance and scope checks passed"
- audit:state-change at:2026-09-01T23:26:56Z task:TASK-006 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:state-change at:2026-09-01T23:26:59Z task:TASK-006 from:validation to:done action:move note:"State changed from validation to done via move."
