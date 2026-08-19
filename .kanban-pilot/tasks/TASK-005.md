---
id: TASK-005
title: add npm run install:skill:claude and npm run install:skill:copilot
type: feature
state: done
status: idle
created: 2026-08-15T07:52:14Z
updated: 2026-08-15T08:22:39Z
chat: kanban-pilot-TASK-005
copilot_session_id: 5d45f851-0fd8-4a69-88b4-f9d8320ea5a4
scope_hash: 5de095f
chat_reset_required: false
---

## Request
I want a way to install the kanban-pilot skill to either claude skill or copilot skill. if it exists, overwrite it

## Refined

### Problem statement
The repository contains the canonical Kanban Pilot agent skill at `.claude/skills/kanban-pilot/SKILL.md`, but it has no repeatable npm command for making that skill available to a developer's personal Claude Code or GitHub Copilot skill discovery path. Add two explicit commands — `npm run install:skill:claude` and `npm run install:skill:copilot` — that copy the same skill into the corresponding personal directory. Both commands must create missing directories and replace an existing installed copy so the skill can be refreshed from the repository.

### Acceptance criteria
- `npm run install:skill:claude` installs to `<user-home>/.claude/skills/kanban-pilot/SKILL.md`; `npm run install:skill:copilot` installs to `<user-home>/.copilot/skills/kanban-pilot/SKILL.md`.
- Both commands use the repository's canonical `.claude/skills/kanban-pilot/SKILL.md` as the source and copy it byte-for-byte without modifying the source file.
- Missing `skills/kanban-pilot` parent directories are created automatically, and an existing destination file is overwritten without an interactive prompt or backup.
- The commands work on Windows and other npm-supported platforms without relying on shell-specific `cp`, `mkdir`, or path syntax, and resolve the home directory using the platform's Node APIs.
- A missing or unreadable source, or an unwritable destination, exits non-zero with a clear error; no unrelated files are silently changed.
- Automated tests cover both destination selections, directory creation, overwrite/idempotency, exact content, and failure handling using isolated temporary paths rather than the real user skill directories.
- The README documents both commands, their personal destination paths, overwrite behavior, and any prerequisites or refresh expectations.

## Scope
- [ ] `package.json` — add the exact `install:skill:claude` and `install:skill:copilot` scripts, delegating both to one shared Node-based installer; add a dedicated script for the installer tests.
- [ ] `scripts/install-skill.mjs` — implement the shared installer with explicit `claude` and `copilot` target selection, a repository-relative canonical source path, platform-aware home-directory resolution, recursive destination-directory creation, byte-preserving copy/overwrite behavior, and clear non-zero failures for invalid targets or filesystem errors.
- [ ] `scripts/install-skill.test.mjs` — add isolated Node tests for both target paths, missing-directory creation, overwrite and repeatability, exact copied content, invalid target handling, and source/destination failure reporting without touching the real home directory.
- [ ] `README.md` — document how to run each install command, where each personal skill is written, that existing copies are overwritten, and how to refresh an installed skill after repository changes.

## Log
- run:r054do8 task:TASK-005 stage:refine result:ok note:"2026-08-15T07:54:09Z — documented the personal Claude and Copilot destinations, overwrite semantics, cross-platform installer, tests, and README scope"
- run:r3h33nn task:TASK-005 stage:develop result:ok note:"2026-08-15T07:56:55Z — implemented cross-platform Claude and Copilot skill installers, isolated tests, npm scripts, and README documentation"
