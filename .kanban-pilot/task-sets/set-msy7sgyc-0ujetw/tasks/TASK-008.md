---
id: TASK-008
title: Running tests in CI for release workflow fails
type: bug
state: validation
status: idle
position: 8
created: 2026-08-18T09:51:29Z
updated: 2026-08-18T10:55:01Z
chat: kanban-pilot-set-msy7sgyc-0ujetw-TASK-008
copilot_session_id: 05f13867-196d-41e5-9f97-1d606779f817
scope_hash: ef149b3
chat_reset_required: false
---

## Request
```
  238 passing (48s)
  2 failing
  1) M3 RunManager
       split stage (§6.14)
         receipt observed before proposals waits for the separate proposal write:
     Error: waitUntil timed out
  	at waitUntil (dist/test/runManager.test.js:67:19)
  	at async waitUntilSettled (dist/test/runManager.test.js:74:5)
  	at async Context.<anonymous> (dist/test/runManager.test.js:1077:27)

  2) Copilot custom-agent discovery
       ignores missing directories and resolves configured paths for each workspace:

      AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:

4 !== 3

      + expected - actual

      -4
      +3
      
  	at Context.<anonymous> (dist/test/copilotAgents.test.js:100:16)
  	at process.processImmediate (node:internal/timers:504:21)
```

## Refined

### Problem statement

The tag-driven release workflow runs the full `npm test` suite on `ubuntu-latest`, but the
current release commit is not CI-stable: 238 tests pass and two fail. The first failure is a
§6.14 split-reconciliation race. `RunManager` can observe the successful split receipt before a
separate `propose-task` append; under CI filesystem and event-loop timing, the parent can remain
unsettled long enough for `waitUntilSettled` to time out instead of processing the later proposal
and completing the split transaction. The implementation must continue to retire the parent only
after valid child tasks are persisted, while preserving retry and late-receipt recovery.

The second failure is a cross-platform discovery-test assumption, not a missing-directory
handling failure. The test supplies `C:\\Users\\tester` as `userHome` while running on Linux.
Because the resolver uses the host platform's `path` rules, that Windows-form path is treated as
relative on CI, so the tilde location is expanded once per workspace and produces four configured
locations instead of the expected three (one home-relative location plus two workspace-relative
locations). The test fixture must express the same intended path semantics on every release
runner without weakening agent precedence, deduplication, or missing-directory behavior.

### Acceptance criteria

- The release-equivalent headless command (`npm ci` followed by `xvfb-run --auto-servernum -- npm test`)
  completes successfully on Ubuntu with zero test failures; the result is repeatable rather than
  dependent on a particular filesystem timing or test order.
- A split run whose `stage:split result:ok` receipt is persisted before its same-run `propose-task`
  line is persisted is reconciled within the supported bounded recovery window. It does not remain
  `running` or indefinitely pending, creates each accepted child exactly once, and moves the
  parent to Done only after every accepted child is present in the active task set.
- Split behavior remains safe for the existing edge cases: no usable proposals or an incomplete
  child write leaves the parent retryable and recoverable, a later retry does not duplicate
  children, and blocked or failed split receipts never create children.
- The custom-agent location coverage is host-independent: `~` expands from the supplied home
  directory as one location, a relative configured path resolves once per workspace, and absent
  directories are ignored. The test continues to expect three configured locations for the two
  workspace fixture and preserves workspace/configured/user precedence and name deduplication.
- The release workflow continues to install from the lockfile and execute the complete test gate;
  the fix must not remove, skip, or relax the failing tests or bypass the headless extension-host
  test command.

## Scope
- Update `src/chat/runManager.ts` to make successful split receipt/proposal reconciliation robust
  when the two task-file writes arrive in separate filesystem events or under slower CI timing.
  Review the receipt grace, late-receipt, in-flight deduplication, and child-persistence paths
  together so a later proposal cannot be lost while a successful split is being settled. Preserve
  the §6.14 transaction, five-proposal cap, same-run validation, retryable blocked marker, and
  idempotent child identity; do not change the receipt grammar or frontmatter ownership model.
- Strengthen `src/test/runManager.test.ts` around the split-stage regression with deterministic
  separate receipt/proposal writes and assertions for the final parent state, absence of a stuck
  `pendingOutcome`/run, exact child count, and no duplicates after late reconciliation or retry.
  Keep coverage for the no-proposal and child-write-failure recovery paths.
- Make the fixture in `src/test/copilotAgents.test.ts` platform-neutral by using a valid native
  absolute home path (or an equivalent path-module-aware test helper) instead of a hard-coded
  Windows path. Assert the intended one-home-plus-two-workspaces resolution and retain the missing
  directory checks; do not fix the failure by changing the expected count to four.
- Review `src/chat/copilotAgents.ts` against the portable test contract. Change its path expansion
  only if the resolver itself fails with native Windows and Linux inputs; otherwise leave the
  production discovery semantics unchanged and treat the reported `4 !== 3` as a test-fixture
  portability defect.
- Validate from a clean checkout using the release workflow's Node/runtime and headless test
  command, then run the targeted split and custom-agent tests repeatedly enough to demonstrate
  that both failures are gone without modifying unrelated workflow or packaging behavior.

## Log
- audit:state-change at:2026-08-18T09:51:33Z task:TASK-008 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-08-18T09:51:33Z task:TASK-008 from:idle to:running action:refine run:r3q048y note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-08-18T09:51:33Z task:TASK-008 stage:refine action:refine run:r3q048y note:"Started refine activity."
- run:r3q048y task:TASK-008 stage:refine result:ok note:"2026-08-18T09:55:39Z — refinement identified the split write-order race and Linux path-fixture mismatch, with targeted source, regression-test, and CI validation scope"
- audit:state-change at:2026-08-18T09:56:33Z task:TASK-008 from:refine to:scoped action:receipt run:r3q048y outcome:ok note:"State changed from refine to scoped via receipt."
- audit:status-change at:2026-08-18T09:56:33Z task:TASK-008 from:running to:idle action:receipt run:r3q048y outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T09:56:33Z task:TASK-008 stage:refine action:receipt run:r3q048y outcome:ok note:"2026-08-18T09:55:39Z — refinement identified the split write-order race and Linux path-fixture mismatch, with targeted source, regression-test, and CI validation scope"
- audit:state-change at:2026-08-18T10:40:15Z task:TASK-008 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-08-18T10:40:16Z task:TASK-008 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-08-18T10:40:16Z task:TASK-008 from:idle to:running action:develop run:rabawz4 note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-08-18T10:40:16Z task:TASK-008 stage:develop action:develop run:rabawz4 note:"Started develop activity."
- run:rabawz4 task:TASK-008 stage:develop result:ok note:"2026-08-18T10:54:13Z — completed split receipt-proposal recovery coverage, made the custom-agent path fixture portable, and passed the full test and packaging checks"
- audit:state-change at:2026-08-18T10:55:01Z task:TASK-008 from:in-progress to:validation action:receipt run:rabawz4 outcome:ok note:"State changed from in-progress to validation via receipt."
- audit:status-change at:2026-08-18T10:55:01Z task:TASK-008 from:running to:idle action:receipt run:rabawz4 outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-08-18T10:55:01Z task:TASK-008 stage:develop action:receipt run:rabawz4 outcome:ok note:"2026-08-18T10:54:13Z — completed split receipt-proposal recovery coverage, made the custom-agent path fixture portable, and passed the full test and packaging checks"
