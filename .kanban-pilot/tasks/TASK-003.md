---
id: TASK-003
title: Improve Kanban-Pilot SKILL
type: feature
state: done
status: idle
created: 2026-08-15T07:27:50Z
updated: 2026-08-15T08:22:38Z
chat: kanban-pilot-TASK-003
copilot_session_id: fc2de253-5d3d-4efc-b2ff-6e1d382d321f
scope_hash: 57c5b6f
chat_reset_required: false
---

## Request
currently it is not properly handling the logging part. I want to improve it such that the logging part will be human-readable and understandable. I want to make sure it will be appending it with proper timestamps as well.

## Refined
The Kanban Pilot skill currently treats `## Log` as a terse machine-readable receipt channel. It requires `run`, `task`, `stage`, `result`, and `note` fields, but it does not require a timestamp or a consistently descriptive explanation of what happened. This makes a task's history difficult for a person to audit and leaves timestamp formatting inconsistent. Improve the skill's logging contract so every stage attempt appends a UTC-timestamped receipt with a concise, plain-language summary, while preserving the receipt structure the extension uses for reconciliation.

**Acceptance criteria**
- The skill defines one canonical receipt format that keeps the existing `- run:... task:... stage:... result:... note:"..."` structure parseable by the extension and includes the timestamp at the start of the note, for example: `note:"2026-08-15T07:28:08Z — refine completed: scope written for three files"`.
- The timestamp is generated when the entry is appended, uses UTC ISO 8601 with second precision and a trailing `Z`, and is required for `ok`, `blocked`, and applicable `failed` outcomes across refine, develop, validate, and split.
- Each note is one line, human-readable, and states what was completed, checked, or blocking progress; placeholder text and opaque summaries are not presented as completed logging.
- The instructions preserve append-only behavior: add exactly one receipt per stage attempt, do not rewrite or reorder existing entries, and do not change `## Request`, frontmatter, or other body sections.
- The revised examples and rules in the skill are internally consistent and remain compatible with `src/chat/receipt.ts` and `RunManager` receipt matching without requiring a new log parser format.

## Scope
- [ ] `.claude/skills/kanban-pilot/SKILL.md` — revise the task-file logging and receipt-grammar sections to define the timestamped note format, UTC timestamp generation, one-line human-readable summaries, and append-only behavior.
- [ ] `.claude/skills/kanban-pilot/SKILL.md` — update the refine, develop, and validate stage instructions and receipt examples (including split, which the skill supports) so `ok`, `blocked`, and applicable `failed` outcomes all show the same timestamped format and preserve the existing machine-readable field order.
- [ ] `.claude/skills/kanban-pilot/SKILL.md` — document the compatibility constraint explicitly: keep the structural receipt prefix unchanged and place the timestamp/readable explanation inside `note`, so the existing extension parser and reconciliation logic continue to work.
- [ ] Verify the final skill text against `src/chat/receipt.ts` and the stage receipt behavior in `src/chat/runManager.ts`; do not change product code or existing task history unless compatibility testing in a later development pass proves it necessary.

## Log
- run:ruy4oaa task:TASK-003 stage:refine result:ok note:"clarified timestamped human-readable receipts while preserving parser compatibility"
- run:r1minoy task:TASK-003 stage:develop result:ok note:"2026-08-15T07:45:46Z — updated SKILL.md with timestamped human-readable receipts and parser-compatible logging rules"
