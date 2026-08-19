---
id: TASK-012
title: Bug: Extension's supervisor reconciles before copilot's run finishes.
type: feature
state: done
status: idle
created: 2026-08-15T11:00:04Z
updated: 2026-08-16T20:40:40Z
chat: kanban-pilot-TASK-012
copilot_session_id: 90ecb370-db33-4015-8742-afd97fd6635b
scope_hash: c0303c8
chat_reset_required: false
---

## Request
This is an excerpt from the LLM's thought process

```
What I know:

This run is extension-driven (run: rr2qen9 and chat: are set in frontmatter) — a real RunManager supervisor owns this card's transitions. My user prompt explicitly said "Do not edit anything else... The extension owns that block." So I must not rewrite the frontmatter myself; my only job was to append the receipt, which I did correctly with result:ok.
The body work is complete and correct — ## Refined (sharpened problem statement + acceptance criteria) and ## Scope (concrete implementation checklist) are both written well.
My result:ok refine receipt was appended in the exact canonical grammar with a fresh UTC timestamp, no internal double-quotes, one physical line — fully compliant.
What happened: The extension's supervisor reconciled before my run finished and logged its own - ... result:blocked note:"no receipt found; awaiting late receipt" line, flipping status to blocked. That is the supervisor telling me it hasn't yet accepted a matching receipt for this stage attempt — i.e., it's waiting on my "late" completion. This is an extension-internal reconciliation state, not something I should paper over by hand-editing frontmatter (which would directly conflict with the RunManager and violate my explicit instruction).
```

## Refined
The extension can treat a Copilot stage as complete before the agent's task-file receipt is durably visible. After its short receipt polling window expires, `RunManager` writes a blocked fallback and clears the run. A valid receipt that the agent writes immediately afterward must be accepted automatically, without asking the agent to alter extension-owned frontmatter or requiring a manual recovery action. The reconciliation path must preserve safeguards that prevent stale or misrouted receipts from changing a task that has been stopped, restarted, or manually moved.

Acceptance criteria:
- When a same-run, same-task, same-stage receipt arrives after the initial receipt wait expires, the extension reconciles it and applies its recorded outcome automatically.
- A normal delayed Copilot completion does not leave a task permanently blocked solely because the receipt was not visible during the initial reconciliation window.
- The fallback marker remains available for a genuinely missing receipt, and no duplicate fallback, outcome application, or proposed follow-up task is produced during repeated file-change events.
- A late receipt cannot override a task whose run, status, or column has changed after the fallback, and receipts for another task or stage remain rejected.
- Coverage exercises the timing boundary where the executor reports completion before the receipt write is observable, plus late-receipt recovery through both file watching and activation reconciliation.

## Scope
- Review and adjust the receipt-lifecycle ordering in `src/chat/runManager.ts`, including `waitForReceipt()`, `markMissingReceipt()`, `reconcileLateReceipts()`, and the executor-completion reconciliation path, so a delayed valid receipt is reliably discovered and applied.
- Keep the `run`/state staleness checks and receipt identity validation intact; only the originating run's matching stage receipt may resolve the fallback.
- Verify the task-folder change queue in `src/extension.ts` continues to invoke late-receipt reconciliation after atomic task-file updates and does not race it with other watcher work.
- Update `src/test/runManager.test.ts` with deterministic delayed-write cases that exceed the initial receipt grace window, assert automatic recovery, idempotence under repeated change notifications, and protection after a stop, move, or replacement run.
- Update receipt-focused tests in `src/test/receiptAndTemplates.test.ts` only if the reconciliation marker or receipt-selection behavior changes; preserve the existing parser-compatible receipt grammar.

## Log
- run:rgz2ecv task:TASK-012 stage:refine result:blocked note:"no receipt found; awaiting late receipt"
- run:rgz2ecv task:TASK-012 stage:refine result:ok note:"2026-08-15T11:01:15Z — refine completed: scoped reliable late-receipt reconciliation and regression coverage"
- run:rm7x97h task:TASK-012 stage:develop result:ok note:"2026-08-15T11:04:32Z — implemented bounded late-receipt recovery with regression coverage"
