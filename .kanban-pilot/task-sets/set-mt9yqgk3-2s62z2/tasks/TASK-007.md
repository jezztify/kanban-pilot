---
id: TASK-007
title: Fix failing test
type: bug
state: done
status: idle
position: 3
created: 2026-08-26T20:38:07Z
updated: 2026-08-27T21:07:18Z
chat: 96caefce-fcaa-4622-80dc-963b7f480e3a
copilot_session_id: 96caefce-fcaa-4622-80dc-963b7f480e3a
scope_hash: ca392aa
chat_reset_required: false
---

## Request
```
  349 passing (1m)
  1 failing
  1) M3 RunManager
       refine stage
         a late timeout receipt with proposals files each child once:
     Error: waitUntil timed out
  	at waitUntil (dist/test/runManager.test.js:69:19)
  	at async Context.<anonymous> (dist/test/runManager.test.js:989:17)

1 test failed.
```

## Refined

The `M3 RunManager` test for a develop run that times out and later writes a same-run follow-up proposal plus an `ok` receipt is timing out while waiting for the parent task to reach `validation`/`idle`. Refine the late-receipt recovery and ordinary proposal reconciliation flow so a valid late completion is applied after the timeout marker, its proposal is persisted as exactly one child task, and the asynchronous recovery completes reliably within the test's polling window. Preserve protections that prevent stale or duplicate receipts/proposals from altering newer runs or creating duplicate children.

### Acceptance criteria

- The failing `a late timeout receipt with proposals files each child once` case passes consistently.
- After a develop run times out, a later valid same-run `ok` receipt advances the parent task from `in-progress`/failed to `validation`/idle and clears the run as the normal receipt outcome path requires.
- A valid same-run late `propose-task` line creates exactly one matching child task, including when reconciliation is triggered more than once.
- The completion path does not leave an in-flight receipt/proposal recovery key, lock, or retry loop that prevents reconciliation from finishing.
- Existing timeout recovery behavior remains intact: late blocked receipts keep a task retryable, late receipts from superseded runs do not reclaim a newer state, and ordinary proposal handling remains limited to allowed stages.

## Scope

- Inspect the timeout, late-receipt, and post-receipt proposal recovery paths in `src/chat/runManager.ts`, including their locking, current-run checks, receipt de-duplication, and scheduled reconciliation lifecycle.
- Trace the failing scenario in `src/test/runManager.test.ts` to identify why the late receipt and proposal sequence does not settle the parent task before `waitUntil` expires.
- Make the smallest `RunManager` lifecycle/reconciliation change that reliably applies a valid late develop receipt and processes its proposals without duplicate child creation or stale-run promotion.
- Update or add focused `RunManager` tests for the repaired ordering/race, including repeat reconciliation or watcher notifications where needed to prove idempotency.
- Run the focused `RunManager` test suite, then the relevant full test suite, and confirm the previously failing test and adjacent late-timeout regression cases pass.

## Log
- audit:state-change at:2026-08-26T20:38:08Z task:TASK-007 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-26T20:38:10Z task:TASK-007 from:idle to:running action:refine run:rx68xxe note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-26T20:38:10Z task:TASK-007 stage:refine action:refine run:rx68xxe note:"Started refine activity."
- run:rx68xxe task:TASK-007 stage:refine result:ok note:"Scoped late timeout receipt and proposal reconciliation race, including idempotent child creation and regression coverage."
- audit:status-change at:2026-08-26T20:38:42Z task:TASK-007 from:running to:idle action:receipt run:rx68xxe outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T20:38:42Z task:TASK-007 stage:refine action:receipt run:rx68xxe outcome:ok note:"Scoped late timeout receipt and proposal reconciliation race, including idempotent child creation and regression coverage."
- audit:state-change at:2026-08-26T20:38:48Z task:TASK-007 from:refine to:scoped action:apply-pending run:rx68xxe outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-08-26T20:38:49Z task:TASK-007 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-26T20:38:51Z task:TASK-007 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-26T20:38:51Z task:TASK-007 from:idle to:running action:develop run:r29u2cc note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-26T20:38:51Z task:TASK-007 stage:develop action:develop run:r29u2cc note:"Started develop activity."
- run:r29u2cc task:TASK-007 stage:develop result:ok note:"Reduced late-receipt backstop delay and verified idempotent proposal recovery with focused and full tests."
- audit:status-change at:2026-08-26T20:45:06Z task:TASK-007 from:running to:idle action:receipt run:r29u2cc outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-26T20:45:06Z task:TASK-007 stage:develop action:receipt run:r29u2cc outcome:ok note:"Reduced late-receipt backstop delay and verified idempotent proposal recovery with focused and full tests."
- audit:state-change at:2026-08-27T21:07:18Z task:TASK-007 from:in-progress to:done action:move note:"State changed from in-progress to done via move."
