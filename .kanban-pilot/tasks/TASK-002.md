---
id: TASK-002
title: Spike: Research the possibility of driving Claude Chat
type: feature
state: done
status: idle
created: 2026-08-14T12:54:17Z
updated: 2026-08-15T07:15:55Z
chat: kanban-pilot-TASK-002
copilot_session_id: ac71c790-37f8-4b1a-ac39-0d32c1904be6
scope_hash: ce2c764
chat_reset_required: false
---

## Request
I want to be able to drive Claude Chat apart from Copilot Chat. This task is for investigating this possiblity

## Refined
Kanban Pilot currently drives GitHub Copilot Chat through a Copilot-specific executor,
session URI, and private chat command. Determine whether the same board can drive the
Claude agent/chat experience exposed in VS Code as a separate execution backend, without
mixing Claude and Copilot conversations or weakening the existing task/run guarantees.

For this spike, “Claude Chat” means a Claude-powered agent session surfaced in VS Code. The
existing Claude Code skill/CLI path, a Claude model selected inside Copilot, and the Claude web
application are comparison options, not interchangeable answers. The investigation must end
with a documented go, conditional-go, or no-go recommendation and the smallest safe follow-up
plan; it must not implement provider support.

**Acceptance criteria**
- The target Claude surface and the non-target alternatives are explicitly identified,
	including the VS Code and Claude/Copilot versions or availability assumptions used by the
	spike.
- The investigation records whether a supported extension API exists for each required
	operation: selecting the Claude backend, opening or resuming a task-specific session,
	injecting a prompt with the task file attached, waiting for completion, handling errors or
	cancellation, and identifying or containing a misrouted session.
- A minimal, reproducible proof or a precisely evidenced blocker covers the critical path for
	first run and continuation. It checks that a Claude run can coexist with a Copilot run and
	that two task sessions do not share conversation or task-file context.
- The result explains compatibility with the existing `Executor`/`RunManager` lifecycle,
	receipt-based completion, tool restrictions, timeouts, and per-task session binding, and
	identifies any behavior that would require changing those guarantees.
- A findings document gives a clear go/conditional-go/no-go decision, evidence and version
	constraints, security/authentication and maintenance risks, fallback options, and a
	file-level implementation plan for a later follow-up.
- No production executor, board behavior, settings, or user-facing workflow is changed by
	the spike itself.

## Scope
- [ ] Clarify the target and non-goals in the spike notes: VS Code’s Claude agent/chat host;
	Claude Code through `.claude/skills/kanban-pilot/SKILL.md`; Claude models inside Copilot;
	and external Claude clients are separate alternatives.
- [ ] Read the current integration seams and record the assumptions to preserve: `src/chat/executor.ts`
	(`Executor`, `RunOptions`, and `ExecutorResult`), `src/chat/runManager.ts` (run lifecycle,
	timeout, receipts, and staleness), `src/chat/sessionUri.ts` (derived task sessions),
	`src/chat/promptTemplates.ts`/`src/chat/receipt.ts` (prompt and completion contracts),
	`src/extension.ts`, and `package.json` (commands and settings).
- [ ] Check the current VS Code/Claude installation and official extension APIs first,
	including language-model APIs, agent/session APIs, registered commands, session-resource
	addressing, file attachments, completion results, cancellation, and provider/model
	selection. Treat undocumented workbench commands or UI-focus automation as a separate,
	high-risk fallback and record exact version evidence for either conclusion.
- [ ] Build an isolated disposable probe or test harness under `src/spike/` (with focused
	coverage under `src/test/` only if needed) rather than wiring Claude into the production
	executor. Use a sanitized task and no credentials in source or captured evidence.
- [ ] Exercise and record a small matrix: Copilot baseline, Claude first run, Claude
	continuation on the same task, two tasks with distinct sessions, Claude/Copilot coexistence,
	window reload or resumed work, unavailable provider/authentication, and terminal/error
	completion. Verify prompt delivery, attached task context, session identity/isolation, and
	whether the existing receipt can still be used as the authoritative outcome.
- [ ] Add `docs/claude-chat-spike.md` with the evidence matrix, API/command findings,
	limitations, security and maintenance risks, fallback comparison, final recommendation, and
	the smallest follow-up checklist. If viable, name the future provider-selection setting and
	backend/executor factory changes; identify likely updates to `src/chat/executor.ts`,
	`src/chat/runManager.ts`, `src/chat/sessionUri.ts`, `src/extension.ts`, `package.json`, and
	focused executor/run-manager/session tests. If not viable, document why and whether the
	existing Claude Code skill or clipboard/manual handoff is the supported fallback.

## Log
- run:rrgqyqi task:TASK-002 stage:refine result:blocked note:"interrupted by window reload; no receipt found"
- run:rrgqyqi task:TASK-002 stage:refine result:ok note:"defined the Claude-in-VS-Code target, integration evidence, isolation checks, and follow-up seams"
- run:rzkohb6 task:TASK-002 stage:refine result:ok note:"sharpened the Claude-in-VS-Code spike scope, API and isolation evidence matrix, and safe follow-up plan"
- run:rxurc5l task:TASK-002 stage:develop result:ok note:"implemented the isolated Claude probe, evidence matrix, and no-go findings without production changes"
