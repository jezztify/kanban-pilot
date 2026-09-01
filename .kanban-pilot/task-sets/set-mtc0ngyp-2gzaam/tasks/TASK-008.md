---
id: TASK-008
title: Select the column agent through the supported chat mode option
type: bug
state: done
status: idle
position: 5
created: 2026-09-01T07:07:36Z
updated: 2026-09-01T07:24:32Z
scope_hash: fbb45d3
chat_reset_required: false
---

## Request
TASK-007 wired column agent selection to a per-agent open command
(`workbench.action.chat.open<Agent Name>`). Reading the shipped VS Code 1.135 workbench
bundle shows that approach does not actually select the agent, and that a simpler
supported mechanism exists. Both need fixing.

Defect 1 — the selection does not take effect. The base chat open action resolves its
mode as:

    let S = t?.mode ? widget.input.currentChatModesObs.get().findModeByName(t.mode) : this.mode;

The payload's `mode` takes precedence over the command's own preset mode. The executor
always sends `mode: cfg.mode` (`agent`), so invoking the per-agent command with that
payload resolves back to the built-in agent and discards the custom one. The command runs
and the chat trace looks correct, but the wrong agent answers.

Defect 2 — the tests cannot catch defect 1. The executor tests assert only which command
id was invoked. `ControlledChatCommands` is a stub that does not model VS Code mode
resolution, so it confirms a call that would not have worked. Coverage must assert the
outcome (which agent the payload selects), not the mechanism.

Supported mechanism to adopt instead:

    findModeByName(e) {
      return this.getBuiltinModes().find(t => t.name.get() === e)
          ?? this.getCustomModes().find(t => t.name.get() === e || t.id === e);
    }

`mode` resolves against custom modes by name or id, so setting the payload's `mode` to the
assigned agent name selects that agent through one stable command. This removes the need
for per-agent command discovery and the name-normalization candidate list added by
TASK-007. It also explains the observed command ids exactly: they are built as
`workbench.action.chat.open` + the mode name verbatim, with no normalization.

Session-safety already checked: `handleSwitchToMode` clears the session only via `qut`,
which returns `needToClearSession: false` immediately when the mode kind is unchanged, and
otherwise only for transitions to or from `edit` kind with existing requests, behind a
confirmation. Custom agents are `agent` kind, so agent to custom-agent does not clear.
The TASK-005 session-continuity guarantees must be preserved and re-proven regardless.

Wanted: replace the per-agent command approach with the `mode` payload option, delete the
now-unnecessary normalization helper, and add coverage that fails if the payload does not
carry the assigned agent.

## Refined

Problem statement: TASK-007 made a column agent assignment invoke a per-agent open command,
but the payload it sends alongside that command overrides the command's own mode, so the
built-in agent still answers. The assignment therefore remains presentation-only in
practice while now also appearing to work. The supported mechanism is the `mode` option
already present on the payload: it is resolved with `findModeByName`, which matches custom
modes by name or id. Moving selection onto that option makes one stable command carry the
choice, and removes the per-agent command discovery and name normalization that TASK-007
introduced to work around an undocumented id format.

Acceptance criteria:
- A stage run for a column assigned a custom agent sends that agent's exact name as the
  payload's `mode`, so `findModeByName` resolves it; the payload no longer sends the global
  `chat.mode` value in place of an assigned agent.
- Selection no longer depends on a per-agent command existing. The per-agent command lookup
  and the name-normalization candidate helper added by TASK-007 are removed, along with
  their tests, so there is one code path rather than two.
- A column with no assignment, or an assignment equal to a built-in mode, continues to send
  the configured `chat.mode` exactly as before, and its behavior is unchanged.
- Coverage asserts the selected agent, not the transport: a test fails if the payload's
  `mode` does not carry the assigned agent name. The previous assertion style, which checked
  only the invoked command id, is not sufficient on its own and must not be the only guard.
- The run still opens the task-derived `vscode-chat-session://local` URI, never issues
  `New Chat`, and leaves `chat`, `copilot_session_id`, and `chat_reset_required` untouched.
  The TASK-005 move and session-continuity regressions continue to pass unchanged.
- The presentation-only marking in Settings continues to distinguish an assignment this
  client can honor from one it cannot, using whatever signal remains valid once per-agent
  command lookup is gone.

## Scope
- `src/chat/executor.ts`: send the assigned agent as the payload's `mode` when
  `options.agentName` names an agent, otherwise keep sending `options.mode`. Remove
  `customAgentCapability()`, the `agentCommand` field on `ChatCapabilities`, and the
  `agentName` parameter threaded through `detectCapabilities()` if it is no longer read.
  Keep `openCommand` on the existing `findAgentOpenCommand(all, mode)` result. Retain the
  advisory diagnostic only if it can still be determined without per-agent command lookup;
  otherwise remove it and its diagnostic code and capability union members.
- `src/chat/agentNames.ts`: delete `agentCommandSuffixes()`, and correct the doc comment
  added by TASK-007 so it describes selection through the mode option rather than through a
  registered per-agent action.
- `src/chat/runManager.ts`: keep passing the resolved column agent to the executor. Keep or
  drop the `run-advisory` trace to match whatever the executor still reports. Do not change
  `newChatBefore`, the session binding, or `resetSession()` reachability.
- `src/board/boardPanel.ts`: replace the per-agent command probe used to compute
  `selectableAgents` with a signal that remains valid under the mode-option approach, so the
  presentation-only marking still distinguishes honorable from unhonorable assignments.
- `src/test/executor.test.ts`: replace the TASK-007 selection tests. Assert the payload's
  `mode` equals the assigned agent name; assert an unassigned column still sends the
  configured mode; assert no `New Chat` on either path. Remove the normalization-spelling
  test, which no longer describes how selection works.
- `src/test/runManager.test.ts`: keep the per-stage agent-reaches-the-executor coverage and
  the session-continuity assertion; update them if the option shape changes.
- `src/test/boardPanel.test.ts`: update the presentation-only assertions to match the new
  `selectableAgents` signal.
- Out of scope: changing which agents VS Code discovers, the `chat.mode` setting itself, and
  per-task session derivation.

## Log
- audit:state-change at:2026-09-01T07:08:10Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-01T07:08:10Z task:TASK-008 from:idle to:running action:refine run:rf2v8qc note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-01T07:08:10Z task:TASK-008 stage:refine action:refine run:rf2v8qc note:"Started refine activity."
- progress run:rf2v8qc task:TASK-008 at:2026-09-01T07:08:10Z note:"confirmed the mode option resolves custom agents by name and scoped the replacement of per-agent command discovery"
- run:rf2v8qc task:TASK-008 stage:refine result:ok note:"2026-09-01T07:08:10Z — refine completed: scoped the move to the supported mode option, removal of per-agent command discovery, and outcome-based test coverage"
- audit:status-change at:2026-09-01T07:08:10Z task:TASK-008 from:running to:idle action:receipt run:rf2v8qc outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T07:08:10Z task:TASK-008 stage:refine action:receipt run:rf2v8qc outcome:ok note:"2026-09-01T07:08:10Z — refine completed: scoped the move to the supported mode option, removal of per-agent command discovery, and outcome-based test coverage"
- audit:state-change at:2026-09-01T07:08:10Z task:TASK-008 from:refine to:scoped action:apply-pending run:rf2v8qc outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-01T07:08:18Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T07:08:18Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-01T07:08:18Z task:TASK-008 from:idle to:running action:develop run:rc5t7wn note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-01T07:08:18Z task:TASK-008 stage:develop action:develop run:rc5t7wn note:"Started develop activity."
- progress run:rc5t7wn task:TASK-008 at:2026-09-01T07:21:11Z note:"reverted the per-agent command path, wired the mode option, and confirmed the new test fails when the fix is reverted"
- run:rc5t7wn task:TASK-008 stage:develop result:ok note:"2026-09-01T07:21:11Z — develop completed: selection moved onto the payload mode option, per-agent command discovery and normalization removed, and the new guard verified by mutation testing"
- audit:status-change at:2026-09-01T07:21:11Z task:TASK-008 from:running to:idle action:receipt run:rc5t7wn outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T07:21:11Z task:TASK-008 stage:develop action:receipt run:rc5t7wn outcome:ok note:"2026-09-01T07:21:11Z — develop completed: selection moved onto the payload mode option, per-agent command discovery and normalization removed, and the new guard verified by mutation testing"
- audit:state-change at:2026-09-01T07:24:32Z task:TASK-008 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
