---
id: TASK-001
title: Introduce Parent and Child Tasks
type: feature
state: done
status: idle
position: 0
created: 2026-09-02T03:21:43Z
updated: 2026-09-02T23:45:29Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-001
copilot_session_id: 48166fd0-73be-43ea-b84e-191866b83952
scope_hash: ab2181d
chat_reset_required: false
---

## Request
I want to introduce Parent and Child Tasks. When creating a new task or when a new task is proposed, it should have the option to attach it to a parent task. I want a strong connection between parent and child tasks.

1. When opening a Parent task, I want a button called "Show Task Tree" which will open a docked modal called "Task Tree" to the Task Details and show a diagram of Parent-Child task relationship
2. The new "Task Tree" modal should only Show "Task ID", "Task Name" and "Task Status" for all rendered objects and should show a connected graph to their relationships

## Refined
The board currently treats every task as an independent item. Human-created tasks and agent-filed proposals have no durable parent reference, so related work cannot be selected, validated, or inspected as a hierarchy. Introduce a strong one-to-many relationship within the active task set: each task may have at most one parent, a parent may have many children, and proposal provenance (`origin_task`) remains distinct from the relationship itself. Task Details should expose a read-only Task Tree sidecar for a task that has children, showing the selected task and its connected descendants.

**Acceptance criteria**
- The New Task modal offers a Parent task selector containing `None` plus tasks from the active task set, defaults to `None`, and persists a valid selection as an optional `parent_task` reference. The selection survives reload and cannot reference a task in another task set.
- Agent-filed proposals accept an optional `parent:TASK-<n>` field. When omitted, the proposed task is attached to the run's originating task; an explicit parent is accepted only when it exists in the active task set. Invalid, missing, self-referential, or cyclic parents are rejected without creating an unattached task, and retries remain idempotent.
- Parent links are validated at the task-store write boundary, preserved through reload, edit, and workflow moves, and cannot leave dangling children. Deleting a task with children is rejected until the relationship is resolved; malformed legacy parent references are treated as detached.
- Opening a task with at least one valid descendant shows a button labeled `Show Task Tree` in Task Details. A leaf task does not show that action.
- Activating `Show Task Tree` opens a docked modal/sidecar titled `Task Tree` beside Task Details, keeps the task details available, and supports close, backdrop dismissal, Escape, and narrow-view stacking behavior.
- The Task Tree renders the selected task and all reachable descendants as one connected parent-to-child graph. Each node shows only Task ID, Task Name, and Task Status; status is derived from the existing workflow and runtime state, and nodes expose no type, provenance, description, log, or unrelated controls.
- The graph is deterministic, reflects all valid relationships in the active task set, refreshes after task-file changes, and does not regress existing board, task-creation, proposal, named-task-set, or Mermaid fallback behavior.

## Scope
- [ ] `src/model/task.ts` — add an optional `parentTaskId` task field and `NewTaskOptions` field; parse and serialize `parent_task` in the existing flat frontmatter schema while preserving it through unrelated rewrites.
- [ ] `src/model/taskStore.ts` — validate parent IDs against the active task set during serialized task creation, reject self-links and cycles, persist the link atomically, treat malformed legacy links as detached for reads, and prevent deletion of tasks that still have children.
- [ ] `src/board/actions.ts` and `src/board/boardPanel.ts` — route parent-delete failures through the existing error path and extend the host/webview task contracts for parent selection, validation, and task-detail tree data.
- [ ] `src/chat/proposals.ts` — extend the `propose-task` grammar and proposal model with an optional `parent:TASK-<n>` field; reject malformed parent values and keep proposal fingerprints/idempotency compatible with existing syntax.
- [ ] `src/chat/runManager.ts` — resolve omitted proposal parents to the originating task, pass explicit parents through the single `TaskStore.create()` path, compare parent identity during reconciliation, and record retryable errors for invalid relationships.
- [ ] `src/board/boardPanel.ts` — populate and reset the New Task parent selector from the active task-set snapshot; add `Show Task Tree`; derive a deterministic root-plus-descendant projection with deduplicated edges; and render the docked `Task Tree` using the existing local Mermaid bridge with responsive close and refresh behavior. Keep graph nodes limited to ID, title, and status.
- [ ] `src/test/taskStore.test.ts` — cover frontmatter round-trip, same-set parent creation, missing/self/cycle rejection, edit/reload preservation, and parent-delete protection.
- [ ] `src/test/proposals.test.ts` and `src/test/runManager.test.ts` — cover optional parent parsing, fingerprint compatibility, default and explicit proposal parents, named task sets, invalid-parent retry behavior, and idempotent reconciliation.
- [ ] `src/test/boardPanel.test.ts` — cover selector payloads, button visibility, exact tree node fields, descendant edges, leaf behavior, refresh after child creation, docked-modal controls, and safe Mermaid rendering/fallback.
- [ ] `docs/PRD.md` — document the `parent_task` field, proposal syntax and integrity rules, task-detail message projection, and the Task Tree node/edge contract.

Out of scope: multiple parents, cross-task-set links, a whole-workspace graph, node-click navigation, card-face parent badges, reparenting UI, and cascade deletion.

## Log
- audit:state-change at:2026-09-02T03:21:47Z task:TASK-001 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-02T03:21:51Z task:TASK-001 from:idle to:running action:refine run:rfm3irf note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-02T03:21:51Z task:TASK-001 stage:refine action:refine run:rfm3irf note:"Started refine activity."
- progress run:rfm3irf task:TASK-001 at:2026-09-02T03:26:02Z note:"documenting parent-link integrity and Task Tree scope"
- run:rfm3irf task:TASK-001 stage:refine result:ok note:"2026-09-02T03:26:02Z — refine completed: documented durable parent links, proposal attachment, and Task Tree behavior"
- audit:status-change at:2026-09-02T03:27:29Z task:TASK-001 from:running to:idle action:receipt run:rfm3irf outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-02T03:27:29Z task:TASK-001 stage:refine action:receipt run:rfm3irf outcome:ok note:"2026-09-02T03:26:02Z — refine completed: documented durable parent links, proposal attachment, and Task Tree behavior"
- audit:state-change at:2026-09-02T04:55:59Z task:TASK-001 from:refine to:scoped action:apply-pending run:rfm3irf outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-02T04:56:02Z task:TASK-001 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-02T04:56:04Z task:TASK-001 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-02T04:56:04Z task:TASK-001 from:idle to:running action:develop run:rgdzexo note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-02T04:56:04Z task:TASK-001 stage:develop action:develop run:rgdzexo note:"Started develop activity."
- progress run:rgdzexo task:TASK-001 at:2026-09-02T04:56:29Z note:"reconciling implementation plan and design decisions"
- run:rgdzexo task:TASK-001 stage:develop result:blocked note:"2026-09-02T05:20:13Z — develop blocked: the coding specialist returned no valid implementation report after the required retry"
- receipt-diagnostic kind:run-mismatch task:TASK-001 expected-run:rgdzexo expected-stage:develop actual-run:rfm3irf actual-task:TASK-001 actual-stage:refine note:"Ignored receipt because run id rfm3irf is stale; expected rgdzexo."
- run:rgdzexo task:TASK-001 stage:develop result:failed note:"timed out; awaiting late receipt"
- audit:status-change at:2026-09-02T05:16:04Z task:TASK-001 from:running to:failed action:timeout run:rgdzexo outcome:timeout note:"Status changed from running to failed via timeout."
- audit:activity-finish at:2026-09-02T05:16:04Z task:TASK-001 stage:develop run:rgdzexo outcome:timeout provisional:true note:"Activity timed out; awaiting late receipt."
- audit:status-change at:2026-09-02T05:20:17Z task:TASK-001 from:failed to:blocked action:late-receipt run:rgdzexo outcome:blocked note:"Status changed from failed to blocked via late-receipt."
- audit:activity-finish at:2026-09-02T05:20:17Z task:TASK-001 stage:develop action:late-receipt run:rgdzexo outcome:blocked correction:true note:"2026-09-02T05:20:13Z — develop blocked: the coding specialist returned no valid implementation report after the required retry"
- progress run:rgdzexo task:TASK-001 at:2026-09-02T19:39:31Z note:"retrying the scoped parent-child implementation"
- run:rgdzexo task:TASK-001 stage:develop result:blocked note:"2026-09-02T19:45:50Z — develop blocked: the coding specialist again returned no valid implementation report"
- audit:state-change at:2026-09-02T23:45:26Z task:TASK-001 from:in-progress to:validation action:move note:"State changed from in-progress to validation via move."
- audit:status-change at:2026-09-02T23:45:26Z task:TASK-001 from:blocked to:idle action:move note:"Status changed from blocked to idle via move."
- audit:state-change at:2026-09-02T23:45:29Z task:TASK-001 from:validation to:done action:move note:"State changed from validation to done via move."
