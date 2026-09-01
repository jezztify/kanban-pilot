---
id: TASK-007
title: [SUPERSEDED BY TASK-008] Column agent assignment does not select the Copilot custom agent
type: feature
state: done
status: idle
position: 6
created: 2026-09-01T03:35:47Z
updated: 2026-09-01T07:24:50Z
scope_hash: 89c5aac
chat_reset_required: false
---

## Request
Assigning a Copilot custom agent to a column in Settings does not actually run that
agent. The assignment only changes text: it renders the board Agent badge and the
literal `@{{agentName}}` first line of the injected prompt. The Copilot session itself
still runs in plain built-in agent mode.

Observed with every column mapped to `Bro LocalRapidPrototyping Orchestrator` in
`kanbanPilot.chat.agentNames`. A chat trace across one task shows every stage start
issuing the same `workbench.action.chat.openagent`, and a manually selected custom
agent snapping back to the built-in agent each time a stage begins.

Why the assignment cannot take effect today:
- `chat.mode` is one global setting (default `agent`), and the open command is built
  as `workbench.action.chat.open` + mode, so it is the same command for refine,
  develop, and validate. Nothing stage- or column-specific reaches it.
- `resolveAgentName()` feeds only the `{{agentName}}` template placeholder.
  `agentNames.ts` states these names are deliberately not registered chat
  participants, so the `@name` line is persona framing the model reads as text.
- `discoverCopilotAgents()` is imported only by `boardPanel.ts`, to populate the
  Settings dropdown. The discovered agent never reaches the executor.
- `OutboundPayload` carries exactly seven keys (query, mode, blockOnResponse,
  attachFiles, toolsInclude, toolsExclude, modelSelector). None of them selects an
  agent.

Wanted: make a column agent assignment actually select that discovered custom agent for
the stage run, so the badge, the prompt, and the running session agree. If Copilot
offers no supported way to select a custom agent at injection time, say so explicitly
and make the Settings UI stop implying the assignment changes execution.

Related: the per-task chat session continuity fixed in TASK-005 is working correctly and
is not in question here. This is about which agent runs inside that session.

## Refined
Problem statement: A per-column agent assignment in `kanbanPilot.chat.agentNames` changes
only presentation. It renders the board Agent badge and the literal `@{{agentName}}` first
line of the prompt, while the stage run itself always invokes
`workbench.action.chat.open` + the single global `chat.mode` (default `agent`). The badge,
the prompt text, and the agent actually executing the turn can therefore disagree, and a
custom agent the user selected by hand is displaced at every stage start because the same
built-in open command is re-issued each run.

Upstream capability finding (settles the open question in the Request): VS Code did not
originally register per-mode open commands for custom modes, but microsoft/vscode PR #273805
merged on 2025-11-21 and dynamically registers actions for custom agents/modes as they are
discovered. A custom-agent-scoped open command is therefore expected to exist at runtime.
This is decisive for the ticket because `ChatExecutor.findAgentOpenCommand()` already builds
exactly that shape — `workbench.action.chat.open` + mode — and resolves it case-insensitively
against `getCommands(true)`. What is not yet known is the exact command-id normalization
applied to a multi-word agent name, so the implementation must discover the id rather than
assume one, and must degrade cleanly when no such command is present.

Acceptance criteria:
- The command-id normalization is established empirically against a real VS Code command
  registry with a multi-word custom agent installed, and the rule is recorded in the
  implementation rather than guessed.
- When a column has an agent assignment that resolves to a discovered custom agent whose
  scoped open command exists, the stage run for that column invokes that command, so the
  badge, the prompt persona line, and the executing agent all name the same agent.
- When no scoped command exists for the assigned agent, the run still proceeds through the
  existing `chat.mode` command, emits a diagnostic naming the agent that could not be
  selected, and never fails or silently drops the turn.
- Where an assignment cannot change execution, the Settings UI and the board badge no longer
  imply that it does; the affected assignment is visibly marked as presentation-only.
- Selecting an agent is orthogonal to session identity: the run continues to open the task
  derived `vscode-chat-session://local` URI, does not issue `New Chat`, and does not alter
  `chat`, `copilot_session_id`, or `chat_reset_required`. The TASK-005 move and
  session-continuity regressions continue to pass unchanged.
- Regression coverage proves selection when the scoped command exists, fallback plus
  diagnostic when it does not, and that neither path creates or resets a conversation.

## Scope
- Probe first, decide after: enumerate `getCommands(true)` in a real VS Code host filtered to
  `workbench.action.chat.open*`, with a multi-word custom agent installed under
  `.github/agents`, and record the exact id emitted for it. This determines the normalization
  rule and confirms whether the selection branch is available at all. Every item below is
  written to work whether or not the probe finds a command.
- `src/chat/agentNames.ts`: add a single exported normalization helper mapping a resolved
  display name to its command-id suffix, matching the rule the probe established. Keep
  `resolveAgentName()` and `STAGE_AGENT_NAME` behavior unchanged; update the file comment that
  currently states these names are never resolved specially, since that stops being true for
  agents whose scoped command exists.
- `src/chat/executor.ts`: extend `ChatCapabilities` and `detectCapabilities()` with an
  agent-scoped open command looked up from the normalized assigned agent name, keeping the
  existing case-insensitive `findCommand()` behavior. Prefer that command when present and
  fall back to the current `findAgentOpenCommand(all, mode)` result otherwise. Add a
  diagnostic for the unavailable case through the existing `capabilityDiagnostic()` path.
  Do not add an agent field to `OutboundPayload`: selection travels as the command id, so the
  seven-key payload contract and the observe/transform seam are unchanged.
- `src/chat/runManager.ts`: pass the already-resolved `resolveAgentName(stage, cfg.agentNames)`
  value into the executor run options alongside `mode`. Do not change `newChatBefore`, the
  session binding, or `resetSession()` reachability.
- `src/board/boardPanel.ts`: where Settings renders agent assignments from
  `discoverCopilotAgents()`, mark an assignment whose scoped command is unavailable as
  presentation-only, so the UI stops implying it changes execution.
- `src/test/executor.test.ts`: cover selection when the scoped command is present, fallback to
  the mode command with a diagnostic when it is absent, name normalization, and that neither
  path issues `workbench.action.chat.newChat`.
- `src/test/runManager.test.ts`: assert the resolved column agent reaches the executor for each
  stage, and re-assert that the TASK-005 move and session-continuity expectations are unchanged.
- `src/test/boardPanel.test.ts`: assert the presentation-only marking appears when the scoped
  command is unavailable and is absent when it is available.
- Out of scope: registering real `contributes.chatParticipants`, changing the global
  `chat.mode` setting, and any change to per-task session derivation.

## Log
- audit:state-change at:2026-09-01T03:36:13Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-01T03:37:12Z task:TASK-007 from:idle to:running action:refine run:rq7w3nx note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-01T03:37:12Z task:TASK-007 stage:refine action:refine run:rq7w3nx note:"Started refine activity."
- progress run:rq7w3nx task:TASK-007 at:2026-09-01T03:39:07Z note:"researched VS Code custom-agent command registration; upstream support landed, so scoping selection plus fallback"
- run:rq7w3nx task:TASK-007 stage:refine result:ok note:"2026-09-01T03:39:50Z — refine completed: confirmed upstream custom-agent command registration landed in VS Code, scoped probe-first selection with fallback and honest-UI branch"
- audit:status-change at:2026-09-01T03:39:50Z task:TASK-007 from:running to:idle action:receipt run:rq7w3nx outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T03:39:50Z task:TASK-007 stage:refine action:receipt run:rq7w3nx outcome:ok note:"2026-09-01T03:39:50Z — refine completed: confirmed upstream custom-agent command registration landed in VS Code, scoped probe-first selection with fallback and honest-UI branch"
- audit:state-change at:2026-09-01T03:39:50Z task:TASK-007 from:refine to:scoped action:apply-pending run:rq7w3nx outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-01T03:44:16Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-01T03:45:31Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-01T03:45:31Z task:TASK-007 from:idle to:running action:develop run:rd8m4kt note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-01T03:45:31Z task:TASK-007 stage:develop action:develop run:rd8m4kt note:"Started develop activity."
- progress run:rd8m4kt task:TASK-007 at:2026-09-01T03:50:30Z note:"probe complete; agent-scoped command resolution and non-fatal fallback wired through executor and run manager"
- progress run:rd8m4kt task:TASK-007 at:2026-09-01T03:57:24Z note:"tests added for selection, normalization fallback, session continuity, and the settings marking; full suite green"
- run:rd8m4kt task:TASK-007 stage:develop result:ok note:"2026-09-01T03:57:24Z — develop completed: column agent now selects its registered open action with non-fatal fallback and presentation-only marking; compile, lint, and 366 VS Code tests pass"
- audit:status-change at:2026-09-01T03:57:24Z task:TASK-007 from:running to:idle action:receipt run:rd8m4kt outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-01T03:57:24Z task:TASK-007 stage:develop action:receipt run:rd8m4kt outcome:ok note:"2026-09-01T03:57:24Z — develop completed: column agent now selects its registered open action with non-fatal fallback and presentation-only marking; compile, lint, and 366 VS Code tests pass"
- audit:state-change at:2026-09-01T07:24:50Z task:TASK-007 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
