---
id: TASK-011
title: Bug found: Conflicting SKILL and PromptTemplate instructions
type: feature
state: done
status: idle
created: 2026-08-15T09:11:39Z
updated: 2026-08-16T20:40:36Z
chat: kanban-pilot-TASK-011
copilot_session_id: aceec308-3cf0-4be3-a6f2-9b735465e616
scope_hash: 411061a
chat_reset_required: false
---

## Request
This is one of the LLM's thought process
```
I'm noticing a conflict between the skill documentation and the user's explicit instructions about frontmatter handling—the task prompt says not to edit anything else in this file, but I need to clarify what that means for my approach here. The extension owns the state transitions when it sees the Log line, so I shouldn't touch the frontmatter at all — just append the receipt with result:ok and let the board handle moving the card forward.
```

## Refined
The request identifies a protocol conflict between two valid Kanban Pilot
execution paths. The extension-generated stage prompt tells its Copilot agent
to edit only the stage-owned body sections and append a receipt; `RunManager`
owns frontmatter and applies the state transition. The standalone
`.claude/skills/kanban-pilot/SKILL.md`, however, tells a skill-driven worker
that no supervising extension exists and that it must perform that transition
itself. When both instructions are visible in one chat, the agent has no
explicit context/precedence rule: it can corrupt or race extension-owned
frontmatter, or leave a direct skill run in a stale column/status if it follows
the prompt's no-frontmatter rule. The contracts need to distinguish these
modes without changing the task schema or receipt semantics.

**Acceptance criteria**
- The canonical skill and extension prompt templates explicitly name the two
	execution contexts and provide an unambiguous precedence rule: an
	extension-supervised prompt leaves frontmatter to `RunManager`; a direct
	skill run performs the skill's legal transition.
- All four built-in stage prompts (`refine`, `develop`, `validate`, and
	`split`) clearly identify the extension-supervised context and restrict the
	agent to its existing stage-owned body sections plus the append-only `## Log`
	receipt; they do not instruct the agent to edit `state`, `status`, `run`,
	`updated`, or `scope_hash`.
- The standalone skill retains the required direct-run behavior: legal
	state/status validation, receipt ordering, `scope_hash` on successful refine,
	cleanup of `run`, and `updated` handling. It tells the worker to stop/report
	rather than guess if the execution context is ambiguous.
- Extension reconciliation remains the only transition path for
	extension-launched receipts, including `ok`, `blocked`, `failed`, and late
	receipt outcomes; no duplicate or competing transition is introduced.
- Receipt grammar, task-id/run-id matching, append-only log behavior, and
	stage-specific result meanings remain compatible with `src/chat/receipt.ts`
	and `RunManager`.
- Existing user-owned `.kanban-pilot/prompts/*.md` files are not overwritten.
	Existing copies that already state extension ownership remain safe, and the
	compatibility behavior for older seeded copies is documented or tested.
- Focused automated tests and documentation prove the two contracts and
	preserve prompt rendering, custom-template preservation, installer
	behavior, and existing state/reconciliation coverage.

## Scope
- [ ] Update `.claude/skills/kanban-pilot/SKILL.md` with an explicit
	execution-context section: identify an extension-supervised run from the
	generated `## On Completion` contract, make that contract authoritative for
	frontmatter ownership, and keep the current state transition rules only for
	direct skill runs; require a blocker/report rather than guessing when the
	mode is ambiguous.
- [ ] Update `src/chat/promptTemplates.ts` in all four
	`DEFAULT_*_TEMPLATE` strings to add a stable extension-supervised context
	marker and state that the agent may change only its stage-owned body
	sections and append one receipt; do not change `renderTemplate`, receipt
	fields, or stage result semantics.
- [ ] Leave `.kanban-pilot/prompts/*.md` user-owned and non-overwritten; verify
	that existing copies with the current extension-ownership wording remain
	compatible, and document the refresh/manual-update behavior for any older
	seeded copy rather than silently replacing it.
- [ ] Update `docs/PRD.md` §§6.3–6.5 and the README agent-skill installation
	guidance to describe the two execution modes, ownership precedence, and the
	fact that installed skill copies must be refreshed after the canonical skill
	changes.
- [ ] Extend `src/test/receiptAndTemplates.test.ts` to assert the context marker
	and no-frontmatter transition instruction in rendered refine, develop,
	validate, and split defaults while retaining receipt parsing, stage-specific
	results, conditional rendering, and custom-template preservation coverage.
- [ ] Extend `scripts/install-skill.test.mjs` with a canonical-skill contract
	check for both execution modes and their precedence; retain exact-byte copy
	coverage for the Claude and Copilot destinations.
- [ ] Add or extend a focused `src/test/runManager.test.ts` regression check
	showing that an extension receipt is reconciled by `RunManager` exactly once
	and applies the existing stage outcome, including the late-receipt path;
	do not add a second frontmatter writer or alter `src/chat/receipt.ts`/state-machine semantics.
- [ ] Run `npm run compile-tests`, `npm run compile`, `npm run lint`,
	`npm run test:install-skill`, and the focused/full VS Code test suite; verify
	a direct skill run still reaches the legal post-refine state while an
	extension run leaves frontmatter to the extension.

## Log
- run:r1bll4z task:TASK-011 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- run:r1bll4z task:TASK-011 stage:refine result:ok note:"2026-08-15T09:15:31Z — clarified extension-supervised and standalone skill ownership rules"
- run:rr0mh1x task:TASK-011 stage:develop result:ok note:"2026-08-15T09:38:14Z — implemented the execution-context ownership contract, prompt markers, documentation, and regression coverage"
