---
id: TASK-024
title: Tests fail when running in Github Actions
type: feature
state: in-progress
status: blocked
position: 1
created: 2026-09-06T03:41:13Z
updated: 2026-09-06T03:58:03Z
chat: kanban-pilot-set-mtjixmpk-zp4nd8-TASK-024
copilot_session_id: e529f2aa-da6d-402b-ba56-f4a477e98487
scope_hash: 31c530c
chat_reset_required: false
---

## Request
478 passing (1m)
  6 failing
  1) Workspace activity store
       persists sanitized records and reloads newest first:
     NoPermissions (FileSystemError): Error: EACCES: permission denied, mkdir '/kanban-pilot-workspace-activity-persistence-1788665142423-9tpr2e80joi'
  	at dr._handleError (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:21596)
  	at Object.createDirectory (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:19582)
  	at async WorkspaceActivityStore.ensureDirectory (dist-test/model/workspaceActivity.js:183:9)
  	at async WorkspaceActivityStore.writeAppended (dist-test/model/workspaceActivity.js:208:9)
  	at async /home/runner/work/kanban-pilot/kanban-pilot/dist-test/model/workspaceActivity.js:231:13

  2) Workspace activity store
       redacts paths, controls, invalid context, and invalid levels at the persistence boundary:
     NoPermissions (FileSystemError): Error: EACCES: permission denied, mkdir '/kanban-pilot-workspace-activity-sanitize-1788665142428-4i72o59hbzj'
  	at dr._handleError (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:21596)
  	at Object.createDirectory (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:19582)
  	at async WorkspaceActivityStore.ensureDirectory (dist-test/model/workspaceActivity.js:183:9)
  	at async WorkspaceActivityStore.writeAppended (dist-test/model/workspaceActivity.js:208:9)
  	at async /home/runner/work/kanban-pilot/kanban-pilot/dist-test/model/workspaceActivity.js:231:13

  3) Workspace activity store
       skips malformed and over-limit lines while retaining the newest valid records only:
     NoPermissions (FileSystemError): Error: EACCES: permission denied, mkdir '/kanban-pilot-workspace-activity-malformed-1788665142432-74uqzia7273'
  	at dr._handleError (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:21596)
  	at Object.createDirectory (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:19582)
  	at async WorkspaceActivityStore.ensureDirectory (dist-test/model/workspaceActivity.js:183:9)
  	at async Context.<anonymous> (dist-test/test/workspaceActivity.test.js:115:13)

  4) Workspace activity store
       serializes concurrent appends and isolates task-set files:
     NoPermissions (FileSystemError): Error: EACCES: permission denied, mkdir '/kanban-pilot-workspace-activity-concurrent-1788665142435-l72zqanzilp'
  	at dr._handleError (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:21596)
  	at Object.createDirectory (file:///home/runner/work/kanban-pilot/kanban-pilot/.vscode-test/vscode-linux-x64-1.136.1/resources/app/out/vs/workbench/api/node/extensionHostProcess.js:542:19582)
  	at async WorkspaceActivityStore.ensureDirectory (dist-test/model/workspaceActivity.js:183:9)
  	at async WorkspaceActivityStore.writeAppended (dist-test/model/workspaceActivity.js:208:9)
  	at async /home/runner/work/kanban-pilot/kanban-pilot/dist-test/model/workspaceActivity.js:231:13

  5) M3 RunManager
       refine stage
         a receipt appended after executor completion is picked up during the reconciliation grace period:
     Error: waitUntil timed out
  	at waitUntil (dist-test/test/runManager.test.js:71:19)
  	at async waitUntilSettled (dist-test/test/runManager.test.js:78:5)
  	at async Context.<anonymous> (dist-test/test/runManager.test.js:765:27)

  6) M3 RunManager
       configurable run capacity
         capacity is shared across independently-created managers and mixed stages:
     Error: waitUntil timed out
  	at waitUntil (dist-test/test/runManager.test.js:71:19)
  	at async /home/runner/work/kanban-pilot/kanban-pilot/dist-test/test/runManager.test.js:2700:17
  	at async withMaxParallelTasks (dist-test/test/runManager.test.js:2533:17)
  	at async Context.<anonymous> (dist-test/test/runManager.test.js:2683:13)

## Refined

GitHub Actions runs the VS Code integration suite on Linux. The reported run has 478 passing tests and 6 failures, but the failures represent three independently demonstrable reliability problems rather than one implementation change:

- Four `WorkspaceActivityStore` tests build their synthetic workspace from `TEMP`/`TMP` with `.` as the fallback. In the Linux extension host that fallback resolves to `/`, so directory creation fails with `EACCES` before persistence behavior is exercised.
- One `RunManager` test expects a receipt written 25 ms after executor completion to be consumed during bounded reconciliation, but the CI run times out. The implementation must make this asynchronous hand-off deterministic without replacing the assertion with a longer blind test delay.
- One `RunManager` test expects the configured capacity to be shared by independently-created managers across `develop`, `validate`, and `refine`. The CI timeout indicates that admission or configuration observation is not deterministic under the test environment.

The goal is to make the existing test suite reliable on GitHub Actions while preserving Windows compatibility and the existing activity persistence, receipt application, and shared-capacity semantics. This refinement does not authorize production-code changes yet; it defines the implementation boundary for the next stage.

### SPLIT RECOMMENDATION

**SPLIT REQUIRED — 3 features.** Keep TASK-024 as the supplied parent card and implement these as separate, independently verifiable tasks; do not create child cards during refinement:

1. **Use a writable OS temp root for Workspace Activity tests.** Make the four affected tests exercise persistence on both Linux and Windows. No dependency on the RunManager fixes.
2. **Make RunManager receipt reconciliation CI-stable.** Ensure a receipt appended shortly after executor return is found and applied exactly once within a bounded reconciliation path. No dependency on the capacity fix.
3. **Make shared RunManager capacity deterministic.** Ensure independently-created managers and mixed stages observe the same configured limit and retain the expected denial behavior. No dependency on the receipt fix.

Recommended order is task 1 first to remove the unrelated filesystem noise, followed by tasks 2 and 3 in either order.

### Acceptance Criteria

- The Linux GitHub Actions test command used by the release workflow completes with no failures; the six reported `EACCES` and `waitUntil timed out` failures are absent.
- The four Workspace Activity tests create their roots below the platform's writable temporary directory, clean them up, and continue to verify sanitization, newest-first reads, malformed-line handling, concurrency, and task-set isolation.
- The delayed-receipt test settles the task in its expected completed state (`scoped`, `idle`, with no active run or pending outcome) when the receipt is appended shortly after executor return; the result is not dependent on an unbounded wait or a watcher event.
- The mixed-stage capacity test starts exactly two runs under `maxParallelTasks: 2` across separate managers, leaves the third task idle in its ready column, and never invokes its executor; existing single-capacity and persisted-running-task behavior remains intact.
- `npm run compile-tests`, `npm run compile`, and `npm run lint` remain successful, and the focused tests plus the complete integration suite pass on the supported local and Linux CI environments.

## Scope

Implementation checklist for the three recommended feature tasks:

1. **Workspace Activity test environment — `src/test/workspaceActivity.test.ts`**
	- Import the Node OS temporary-directory helper and replace the `TEMP`/`TMP`/`.` root selection with a platform-independent writable temp root.
	- Preserve unique test-directory names and recursive cleanup; ensure all four existing cases still exercise the real `WorkspaceActivityStore` persistence boundary.
	- Confirm `src/model/workspaceActivity.ts` needs no behavior change; only alter it if a focused regression proves the failure is in production path handling rather than the test fixture root.

2. **Receipt reconciliation — `src/chat/runManager.ts` and `src/test/runManager.test.ts`**
	- Trace the executor-completion path through `waitForReceipt`, the bounded grace/poll loop, the missing-receipt marker, and late-receipt recovery under the Linux extension host.
	- Adjust the scheduling or bounded grace logic so a shortly-delayed receipt is observed reliably and applied once, while still terminating when no receipt arrives and preserving stale/superseded-run safeguards.
	- Strengthen the focused test to distinguish normal grace-period pickup from fallback recovery and to assert the final durable task state and absence of duplicate application.

3. **Shared run capacity — `src/chat/runManager.ts` and `src/test/runManager.test.ts`**
	- Review `RunConcurrencyCoordinator`, `coordinatorFor`, admission serialization, persisted-running-task reconciliation, and `run.maxParallelTasks` configuration reads for races between independently-created managers.
	- Ensure managers for the same workspace and task set share reservations, mixed stages consume the same capacity, and a denied start leaves the task untouched without invoking its executor.
	- Make the test helper wait for the updated configuration to be observable before starting the scenario, if configuration propagation is confirmed as the CI race; retain coverage for default capacity, capacity release, task-set isolation, and reload recovery.

4. **Validation — `.github/workflows/release.yml` and repository test commands**
	- Reproduce with the existing `xvfb-run --auto-servernum -- npm test` command; do not change the workflow merely to hide failures.
	- Run the focused Workspace Activity and RunManager tests, then the full test, compile, and lint checks on Linux and Windows before the implementation task is considered complete.

## Log
- audit:state-change at:2026-09-06T03:41:14Z task:TASK-024 from:backlog to:refine action:accept note:"State changed from backlog to refine via accept."
- audit:status-change at:2026-09-06T03:41:15Z task:TASK-024 from:idle to:running action:refine run:rx900hw note:"Status changed from idle to running via refine."
- audit:activity-start at:2026-09-06T03:41:15Z task:TASK-024 stage:refine action:refine run:rx900hw note:"Started refine activity."
- progress run:rx900hw task:TASK-024 at:2026-09-06T03:42:59Z note:"refinement complete; documented three independent CI failure scopes and validation checks"
- run:rx900hw task:TASK-024 stage:refine result:ok note:"2026-09-06T03:42:59Z — refine completed: separated writable test roots, receipt reconciliation, and shared capacity into three CI-fix scopes"
- audit:status-change at:2026-09-06T03:43:50Z task:TASK-024 from:running to:idle action:receipt run:rx900hw outcome:ok note:"Status changed from running to idle via receipt."
- audit:activity-finish at:2026-09-06T03:43:50Z task:TASK-024 stage:refine action:receipt run:rx900hw outcome:ok note:"2026-09-06T03:42:59Z — refine completed: separated writable test roots, receipt reconciliation, and shared capacity into three CI-fix scopes"
- audit:state-change at:2026-09-06T03:46:18Z task:TASK-024 from:refine to:scoped action:apply-pending run:rx900hw outcome:ok note:"State changed from refine to scoped via apply-pending."
- audit:state-change at:2026-09-06T03:46:19Z task:TASK-024 from:scoped to:approved action:approve note:"State changed from scoped to approved via approve."
- audit:state-change at:2026-09-06T03:46:22Z task:TASK-024 from:approved to:in-progress action:develop note:"State changed from approved to in-progress via develop."
- audit:status-change at:2026-09-06T03:46:22Z task:TASK-024 from:idle to:running action:develop run:rukya1q note:"Status changed from idle to running via develop."
- audit:activity-start at:2026-09-06T03:46:22Z task:TASK-024 stage:develop action:develop run:rukya1q note:"Started develop activity."
- progress run:rukya1q task:TASK-024 at:2026-09-06T03:46:38Z note:"investigating the three reported CI failure paths before making focused changes"
- run:rukya1q task:TASK-024 stage:develop result:ok note:"2026-09-06T03:56:50Z — develop completed: fixed writable test roots, stabilized bounded receipt reconciliation, synchronized capacity configuration visibility, and passed full validation"
- audit:status-change at:2026-09-06T03:58:03Z task:TASK-024 from:running to:blocked action:receipt run:rukya1q outcome:blocked note:"Status changed from running to blocked via receipt."
- audit:activity-finish at:2026-09-06T03:58:03Z task:TASK-024 stage:develop action:receipt run:rukya1q outcome:blocked note:"Develop completion requires implementation evidence with changed files and verification."
