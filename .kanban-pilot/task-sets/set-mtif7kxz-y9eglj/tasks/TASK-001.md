---
id: TASK-001
title: Investigate controlling which Copilot model Kanban Pilot uses
type: feature
state: done
status: idle
position: 0
created: 2026-09-01T08:45:17Z
updated: 2026-09-01T09:18:59Z
scope_hash: 9c8ae25
chat_reset_required: false
---

## Request
Investigate the Copilot extension code / integration surface to determine whether Kanban Pilot can
control which language model Copilot uses when it runs a stage (refine, develop, validate).

Things to find out:
- What the extension currently does when it hands a prompt to Copilot chat, and whether the model is
  simply whatever the user last selected in the chat picker.
- Whether a supported VS Code API exists to select or request a model (e.g. `vscode.lm`
  / `selectChatModels`, chat participant / language model APIs, or a `github.copilot.chat.*` setting),
  and what it can and cannot guarantee.
- Whether any unsupported-but-possible path exists (command arguments, chat variables, settings the
  Copilot extension reads) and what the stability/risk of relying on it would be.
- What a per-stage model preference would look like in Kanban Pilot's configuration if it turns out
  to be feasible (e.g. a cheaper model for validate, a stronger one for develop).

Deliverable is a findings write-up plus a recommendation on whether to pursue implementation, not an
implementation.

## Refined

### Problem statement

Kanban Pilot already injects every stage turn through the chat open action in
`src/chat/executor.ts`, and that payload already carries an optional `modelSelector` sourced from a
single global `kanbanPilot.chat.modelSelector` setting (`src/chat/runManager.ts:243`,
`package.json:291-295`). So the question is not "can the extension say anything about the model at
all" — one global pin is already wired end to end. What is unknown, and what this ticket must
establish, is: whether that pin actually takes effect in the running Copilot Chat session or is
silently ignored; what a valid `{id, vendor}` value looks like and where a user is meant to get one;
and whether the selection can be made per stage so Validation can run a cheaper model than
In Progress.

This is an investigation. The deliverable is a dated findings document with an explicit go/no-go
recommendation, following the existing spike convention in `docs/claude-chat-spike.md` and
`docs/m0-findings.md`. No provider, executor, setting, board behaviour, or user-facing workflow
changes under this ticket.

### Acceptance criteria

- A new `docs/copilot-model-selection-spike.md` exists, dated, opening with an explicit
  **Go / No-go / Conditional-go** decision line and a question-and-boundaries section, matching the
  structure the existing spike documents use.
- The document records what the extension does today: that `modelSelector` is read once globally,
  threaded through `RunOptions` and `OutboundPayload`, and attached to the chat open payload only
  when non-empty — with the current behaviour when the setting is left at its `{}` default stated
  explicitly (i.e. whether the model is then whatever the chat picker last had selected).
- The document answers, with evidence rather than assertion, whether the `modelSelector` option is
  honoured by the chat open action for the VS Code version range in the extension's `engines`
  constraint, and states clearly when the answer could not be established.
- The document evaluates `vscode.lm` / `selectChatModels` as a supported way to enumerate available
  models and obtain valid identifiers, and states what it can and cannot guarantee — in particular
  whether an id it returns is accepted by the chat open action's `modelSelector`, since these are two
  different APIs and the extension currently uses neither.
- Any unsupported-but-possible path found (command arguments, chat variables, settings the Copilot
  extension reads) is recorded with its stability and Terms-of-Service risk, and is not recommended
  without that risk being stated.
- The document specifies what per-stage model selection would look like if pursued, expressed against
  the existing per-column precedent in `src/chat/agentNames.ts` — a sparse column-keyed object
  setting, a `resolve*` function with documented fallback to a global value, and a board Settings
  editor kind — with a note on which stage defaults would be sensible.
- The document ends with a smallest-safe-follow-up plan and a recommendation on whether to file
  implementation work; if the recommendation is to proceed, the follow-up work is filed as separate
  tasks rather than being done here.
- Any probe written to gather evidence is read-only: it enumerates or inspects and does not open a
  chat, submit a turn, or consume model quota. No production source file is modified.

### Assumptions

- Evidence is gathered from the locally installed VS Code and GitHub Copilot Chat builds plus
  official documentation. A finding that only holds for the locally installed versions is recorded as
  such rather than generalised.
- "Cheaper model for validate, stronger for develop" is treated as the motivating example for
  per-stage selection, not as a decision that it will be built.

## Scope

- Establish the current behaviour, and write it up as the document's baseline section:
  - Trace and record the existing path: `kanbanPilot.chat.modelSelector` in `package.json:291-295`
    → `RunConfig` in `src/chat/runManager.ts:224` and `src/chat/runManager.ts:243`
    → `RunOptions` in `src/chat/runManager.ts:1235`
    → the conditional spread onto `OutboundPayload` in `src/chat/executor.ts:360-362`.
  - Record the board-side editor that already exists for it: the `modelSelector` setting kind and its
    `{id, vendor}` validation in `src/board/boardPanel.ts:705-720`, and the definition at
    `src/board/boardPanel.ts:521-528`.
  - State what happens at the `{}` default — the option is omitted from the payload entirely — and
    what that means for which model actually runs the turn.
- Determine whether the chat open action honours `modelSelector`:
  - Check the option against the installed VS Code build and the `engines` range in `package.json`,
    and against official documentation for the chat open action.
  - Note how this interacts with `mode`, which `src/chat/executor.ts:346-350` already documents as
    being resolved via `findModeByName` — specifically whether a resolved custom agent can carry its
    own model that would override or conflict with a pinned selector.
  - Record the observed outcome, or record explicitly that it could not be determined without
    submitting a real turn.
- Evaluate the supported language-model API as the source of valid identifiers:
  - Assess `vscode.lm` / `selectChatModels` for enumerating models, the shape of the identifiers it
    returns, its consent/authorization behaviour, and its `engines` requirement. Neither `vscode.lm`
    nor `selectChatModels` appears anywhere in `src/` today, so this is new ground.
  - State explicitly whether an id from that API is known to be valid input for the chat open
    action's `modelSelector`, or whether that link is unverified.
- If evidence requires an in-host probe, add one following the existing spike convention:
  - A read-only module under `src/spike/` mirroring the non-invasive style of
    `src/spike/claudeChatHostProbe.ts` — inventory and enumeration only, activating nothing and
    submitting no turn.
  - A matching test under `src/test/` in the style of `src/test/claudeChatSpike.test.ts`, so the
    probe runs in the existing extension-test job rather than as a manual step.
  - Keep the probe out of the activation path: it must not be wired into `src/extension.ts` or any
    run.
- Design, on paper only, what per-stage selection would look like:
  - Model it on `src/chat/agentNames.ts`: a sparse column-keyed overrides type, a `COLUMN_FOR_STAGE`-
    style mapping including `split`, a `resolveModelSelector(stage, overrides)` equivalent to
    `resolveAgentName`, and documented precedence from per-column override → global
    `chat.modelSelector` → unset.
  - Note the board Settings surface work it would need, by analogy with the existing `agentNames`
    setting kind and its column editor.
  - Note the backward-compatibility requirement: an existing global `chat.modelSelector` value must
    keep working unchanged.
- Write `docs/copilot-model-selection-spike.md`:
  - Follow the section shape of `docs/claude-chat-spike.md`: dated decision line, question and
    boundaries, version and availability evidence, findings, evidence matrix, risks, and a
    smallest-safe-follow-up plan.
  - Include the go / no-go / conditional-go recommendation and, where a question could not be
    settled, say so plainly instead of inferring an answer.
- Close out without scope creep:
  - Do not implement per-stage selection, and do not change `src/chat/executor.ts`,
    `src/chat/runManager.ts`, `src/board/boardPanel.ts`, `src/chat/agentNames.ts`, or the
    `package.json` settings under this ticket.
  - File any recommended implementation work as separate tasks via the proposal flow.
  - Confirm by reviewing the diff that only the new document, an optional read-only spike probe and
    its test, and this task file were touched.

## Log
- audit:state-change at:2026-09-01T08:46:46Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- progress run:r7k2m9 task:TASK-001 at:2026-09-01T08:47:28Z note:"reading the extension chat integration to scope the model-selection investigation"
- progress run:r7k2m9 task:TASK-001 at:2026-09-01T08:48:13Z note:"found existing global model-selector plumbing and the per-column agent-assignment precedent; writing the scope"
- run:r7k2m9 task:TASK-001 stage:refine result:ok note:"2026-09-01T08:49:53Z — refine completed: scoped a read-only investigation into per-stage Copilot model selection, building on the existing global chat.modelSelector plumbing"
- audit:state-change at:2026-09-01T08:53:01Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- progress run:r3v8p1 task:TASK-001 at:2026-09-01T08:53:30Z note:"gathering evidence on the chat open model option and the language model API"
- progress run:r3v8p1 task:TASK-001 at:2026-09-01T08:55:05Z note:"confirmed from the installed workbench bundle that the chat open action resolves the model selector through the same service the language model API uses; writing the findings document and a read-only probe"
- propose-task run:r3v8p1 type:bug title:"A missed chat.modelSelector fails the whole stage run instead of degrading" note:"pre-existing robustness defect in the global setting, independent of per-stage selection"
- propose-task run:r3v8p1 type:feature title:"Widen chat.modelSelector validation to accept family" note:"board validation is narrower than the command accepts; separate from the investigation"
- propose-task run:r3v8p1 type:feature title:"Confirm a pinned model selector changes the answering model in a live Copilot turn" note:"needs a machine with Copilot Chat installed, which the investigation host did not have"
- run:r3v8p1 task:TASK-001 stage:develop result:ok note:"2026-09-01T09:01:46Z — develop completed: wrote docs/copilot-model-selection-spike.md with a conditional-go recommendation, added a read-only model probe and its test, and filed three follow-ups"
- audit:state-change at:2026-09-01T09:18:59Z task:TASK-001 from:validation to:done action:move note:"State changed from validation to done via move."
