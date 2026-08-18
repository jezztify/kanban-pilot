import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { COLUMNS, Column, STATUSES, Status } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { applyAction, TASK_ACTIONS, TaskAction } from '../board/stateMachine';
import { invokeTaskAction, moveTask, pickTaskFor, reorderTask } from '../board/actions';
import { parseAuditEvents } from '../model/taskLog';

/** M2 — human transitions (PRD §5, §5.2, §6.8's Stop+reset precedent, §12 Q3). */

suite('M2 state machine', () => {
	test('every legal (state, status, action) triple from §5.2', () => {
		const legal: [Column, Status, TaskAction, Column, Status][] = [
			['backlog', 'idle', 'accept', 'refine', 'idle'],
			['refine', 'idle', 'refine', 'refine', 'idle'],
			['refine', 'blocked', 'refine', 'refine', 'idle'],
			['refine', 'failed', 'refine', 'refine', 'idle'],
			// Secondary action on Scoped: redo the scope.
			['scoped', 'idle', 'refine', 'refine', 'idle'],
			// §6.14: split is legal everywhere refine's own retry range is, plus
			// straight from Backlog — deciding "this is too big" usually happens
			// before any scoping work has started.
			['backlog', 'idle', 'split', 'refine', 'idle'],
			['refine', 'idle', 'split', 'refine', 'idle'],
			['refine', 'blocked', 'split', 'refine', 'idle'],
			['refine', 'failed', 'split', 'refine', 'idle'],
			['scoped', 'idle', 'split', 'refine', 'idle'],
			['scoped', 'idle', 'approve', 'approved', 'idle'],
			['approved', 'idle', 'develop', 'in-progress', 'idle'],
			['in-progress', 'idle', 'continue', 'in-progress', 'idle'],
			['in-progress', 'paused', 'continue', 'in-progress', 'idle'],
			['in-progress', 'blocked', 'continue', 'in-progress', 'idle'],
			['in-progress', 'failed', 'continue', 'in-progress', 'idle'],
			// Stop is in-place for refine and validation, but bounces in-progress
			// all the way back to Approved — the one asymmetry §5's diagram
			// specifies explicitly ("Stop + reset").
			['refine', 'running', 'stop', 'refine', 'idle'],
			['validation', 'running', 'stop', 'validation', 'idle'],
			['in-progress', 'running', 'stop', 'approved', 'idle'],
			// §12 Q10: Validate launches a run in place — RunManager bumps status
			// to 'running' as a second step, same two-phase pattern as refine/develop.
			['validation', 'idle', 'validate', 'validation', 'idle'],
			['done', 'idle', 'reopen', 'approved', 'idle'],
		];

		for (const [state, status, action, nextState, nextStatus] of legal) {
			const result = applyAction({ state, status }, action);
			assert.ok(result, `${action} should be legal from ${state}/${status}`);
			assert.strictEqual(result.state, nextState, `${action} from ${state}/${status}: wrong resulting state`);
			assert.strictEqual(result.status, nextStatus, `${action} from ${state}/${status}: wrong resulting status`);
		}
	});

	test('needsAgent means "launches a real run" — not merely "enters a working column"', () => {
		// refine/develop/continue/validate launch a run.
		assert.strictEqual(applyAction({ state: 'refine', status: 'idle' }, 'refine')?.needsAgent, true);
		assert.strictEqual(applyAction({ state: 'approved', status: 'idle' }, 'develop')?.needsAgent, true);
		assert.strictEqual(applyAction({ state: 'in-progress', status: 'idle' }, 'continue')?.needsAgent, true);
		assert.strictEqual(applyAction({ state: 'validation', status: 'idle' }, 'validate')?.needsAgent, true);

		// accept and approve are pure gates — they enter a working column
		// without starting anything; a separate click does that.
		assert.strictEqual(applyAction({ state: 'backlog', status: 'idle' }, 'accept')?.needsAgent, false);
		assert.strictEqual(applyAction({ state: 'scoped', status: 'idle' }, 'approve')?.needsAgent, false);

		assert.strictEqual(applyAction({ state: 'in-progress', status: 'running' }, 'stop')?.needsAgent, false);
		assert.strictEqual(applyAction({ state: 'done', status: 'idle' }, 'reopen')?.needsAgent, false);

		// §6.14: split launches a run too, same as refine/develop/continue/validate.
		assert.strictEqual(applyAction({ state: 'backlog', status: 'idle' }, 'split')?.needsAgent, true);
	});

	test('every action is illegal everywhere not explicitly listed as legal', () => {
		const legalPairs = new Set<string>();
		const legal: [Column, Status, TaskAction][] = [
			['backlog', 'idle', 'accept'],
			['refine', 'idle', 'refine'],
			['refine', 'blocked', 'refine'],
			['refine', 'failed', 'refine'],
			['scoped', 'idle', 'refine'],
			['backlog', 'idle', 'split'],
			['refine', 'idle', 'split'],
			['refine', 'blocked', 'split'],
			['refine', 'failed', 'split'],
			['scoped', 'idle', 'split'],
			['scoped', 'idle', 'approve'],
			['approved', 'idle', 'develop'],
			['in-progress', 'idle', 'continue'],
			['in-progress', 'paused', 'continue'],
			['in-progress', 'blocked', 'continue'],
			['in-progress', 'failed', 'continue'],
			['refine', 'running', 'stop'],
			['in-progress', 'running', 'stop'],
			['validation', 'running', 'stop'],
			['validation', 'idle', 'validate'],
			['validation', 'blocked', 'validate'],
			['validation', 'failed', 'validate'],
		];
		for (const [s, st, a] of legal) {
			legalPairs.add(`${s}|${st}|${a}`);
		}
		// §5.2: "Done | *any* | — | Reopen" — legal regardless of status.
		for (const status of STATUSES) {
			legalPairs.add(`done|${status}|reopen`);
		}

		for (const state of COLUMNS) {
			for (const status of STATUSES) {
				for (const action of TASK_ACTIONS) {
					const key = `${state}|${status}|${action}`;
					const result = applyAction({ state, status }, action);
					if (legalPairs.has(key)) {
						assert.ok(result, `expected ${key} to be legal`);
					} else {
						assert.strictEqual(result, undefined, `expected ${key} to be illegal`);
					}
				}
			}
		}
	});
});

suite('M2 action invocation (src/board/actions.ts)', () => {
	let store: TaskStore;
	let dir: vscode.Uri;

	setup(async () => {
		dir = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-m2-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		store = new TaskStore(dir);
		await store.ensureDirectory();
	});

	teardown(async () => {
		try {
			await vscode.workspace.fs.delete(dir, { recursive: true });
		} catch {
			/* already gone */
		}
	});

	test('invokeTaskAction writes the transition to disk', async () => {
		const task = await store.create('Set up billing webhook');

		const outcome = await invokeTaskAction(store, task.id, 'accept');
		assert.deepStrictEqual(outcome, { kind: 'applied', needsAgent: false });

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'refine');
		assert.strictEqual(after.status, 'idle');
		assert.deepStrictEqual(parseAuditEvents(after.sections['Log']).map((event) => event.kind), ['state-change']);
		assert.strictEqual(parseAuditEvents(after.sections['Log'])[0].action, 'accept');
	});

	test('state-machine transitions append cards at the destination end', async () => {
		const existing = await store.create('Already in refine');
		await invokeTaskAction(store, existing.id, 'accept');

		const moving = await store.create('Accept into refine');
		await store.patch(moving.id, { position: '99' });
		assert.deepStrictEqual(await invokeTaskAction(store, moving.id, 'accept'), {
			kind: 'applied',
			needsAgent: false,
		});

		const refine = (await store.snapshot()).columns.find((column) => column.id === 'refine')!;
		assert.deepStrictEqual(refine.tasks.map((task) => task.id), [existing.id, moving.id]);
		assert.deepStrictEqual(refine.tasks.map((task) => task.position), [0, 1]);
	});

	test('invokeTaskAction refuses an illegal transition without touching disk', async () => {
		const task = await store.create('Set up billing webhook');
		const before = (await vscode.workspace.fs.stat(store.fileFor(task.id))).mtime;

		const outcome = await invokeTaskAction(store, task.id, 'approve');
		assert.deepStrictEqual(outcome, { kind: 'illegal' });

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'backlog', 'illegal action must not move the card');
		assert.strictEqual((await vscode.workspace.fs.stat(store.fileFor(task.id))).mtime, before);
	});

	test('invokeTaskAction on a nonexistent task reports not-found', async () => {
		const outcome = await invokeTaskAction(store, 'TASK-999', 'accept');
		assert.deepStrictEqual(outcome, { kind: 'not-found' });
	});

	test('moveTask moves a card through every column and clears runtime state', async () => {
		const task = await store.create('Move this task');
		await store.patch(task.id, { status: 'running', run: 'r1' });

		for (const destination of COLUMNS) {
			if (destination === 'backlog') {
				continue;
			}
			assert.deepStrictEqual(await moveTask(store, task.id, destination), { kind: 'applied' });
		}

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'done');
		assert.strictEqual(after.status, 'idle');
		assert.strictEqual(after.run, undefined);
	});

	test('moveTask treats same-column and invalid moves as no-ops', async () => {
		const task = await store.create('Keep this task');
		const uri = store.fileFor(task.id);
		const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

		assert.deepStrictEqual(await moveTask(store, task.id, 'backlog'), { kind: 'no-op' });
		assert.deepStrictEqual(await moveTask(store, 'TASK-999', 'done'), { kind: 'not-found' });
		assert.deepStrictEqual(await moveTask(store, 'not-a-task', 'done'), { kind: 'invalid' });
		assert.deepStrictEqual(await moveTask(store, task.id, 'not-a-column'), { kind: 'invalid' });

		const after = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		assert.strictEqual(after, before, 'no-op and invalid moves must not rewrite the task file');
	});

	test('moveTask preserves the task body and unrelated metadata', async () => {
		const task = await store.create('Preserve this task');
		const uri = store.fileFor(task.id);
		const withBody = Buffer.from(await vscode.workspace.fs.readFile(uri))
			.toString('utf8')
			.replace('## Request\n', '## Request\nKeep this request.\n');
		await vscode.workspace.fs.writeFile(uri, Buffer.from(withBody, 'utf8'));
		await store.patch(task.id, {
			state: 'scoped',
			status: 'failed',
			run: 'r2',
			chat: 'kanban-pilot-TASK-001',
			copilot_session_id: 'session-1',
			scope_hash: 'abc1234',
			checkpoint: 'deadbeef',
			origin_task: 'TASK-001',
		});

		assert.deepStrictEqual(await moveTask(store, task.id, 'done'), { kind: 'applied' });

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'done');
		assert.strictEqual(after.status, 'idle');
		assert.strictEqual(after.run, undefined);
		assert.strictEqual(after.chat, 'kanban-pilot-TASK-001');
		assert.strictEqual(after.copilotSessionId, 'session-1');
		assert.strictEqual(after.scopeHash, 'abc1234');
		assert.strictEqual(after.checkpoint, 'deadbeef');
		assert.strictEqual(after.originTask, 'TASK-001');
		assert.ok(after.sections['Request'].includes('Keep this request.'));
		assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'state-change' && event.to === 'done'));
	});

	test('reorderTask changes only within-column order and never creates workflow audit events', async () => {
		const first = await store.create('First');
		const second = await store.create('Second');
		const third = await store.create('Third');
		const thirdUri = store.fileFor(third.id);
		const beforeRaw = Buffer.from(await vscode.workspace.fs.readFile(thirdUri)).toString('utf8');
		const enriched = beforeRaw
			.replace('## Request\n', '## Notes\nKeep this body.\n\n## Request\n')
			.replace('chat_reset_required: false', 'chat: kanban-pilot-TASK-003\ncopilot_session_id: session-3\nchat_reset_required: false');
		await vscode.workspace.fs.writeFile(thirdUri, Buffer.from(enriched, 'utf8'));
		await store.patch(third.id, { status: 'running', run: 'r-active' });
		await store.appendLog(third.id, '- existing log entry');
		const before = (await store.readAll()).tasks.find((task) => task.id === third.id)!;
		const auditBefore = parseAuditEvents(before.sections['Log']);

		assert.deepStrictEqual(await reorderTask(store, third.id, 'backlog', { beforeTaskId: first.id }), { kind: 'applied' });
		assert.deepStrictEqual(await reorderTask(store, third.id, 'backlog', { beforeTaskId: second.id }), { kind: 'applied' });
		assert.deepStrictEqual(await reorderTask(store, third.id, 'backlog', { beforeTaskId: null }), { kind: 'applied' });
		assert.deepStrictEqual(await reorderTask(store, third.id, 'backlog', { beforeTaskId: null }), { kind: 'no-op' });

		const snapshot = await store.snapshot();
		assert.deepStrictEqual(snapshot.columns[0].tasks.map((task) => task.id), [first.id, second.id, third.id]);
		const after = (await store.readAll()).tasks.find((task) => task.id === third.id)!;
		assert.strictEqual(after.state, before.state);
		assert.strictEqual(after.status, 'running');
		assert.strictEqual(after.run, 'r-active');
		assert.strictEqual(after.chat, 'kanban-pilot-TASK-003');
		assert.strictEqual(after.copilotSessionId, 'session-3');
		assert.strictEqual(after.sections['Notes'], 'Keep this body.');
		assert.deepStrictEqual(parseAuditEvents(after.sections['Log']), auditBefore);
		assert.strictEqual(after.sections['Log'], before.sections['Log']);
	});

	test('reorderTask rejects invalid, unknown, and stale targets without a state-machine path', async () => {
		const task = await store.create('Target validation');
		const other = await store.create('Other target');
		const uri = store.fileFor(task.id);
		const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

		assert.deepStrictEqual(await reorderTask(store, task.id, 'not-a-column', { beforeTaskId: null }), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { targetIndex: -1 }), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { targetIndex: 99 }), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { targetIndex: 0, beforeTaskId: null }), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', null), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { beforeTaskId: null, ignored: true }), { kind: 'invalid' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { beforeTaskId: 'TASK-999' }), { kind: 'stale' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'done', { beforeTaskId: null }), { kind: 'stale' });
		assert.deepStrictEqual(await reorderTask(store, 'TASK-999', 'backlog', { beforeTaskId: null }), { kind: 'not-found' });
		assert.deepStrictEqual(await reorderTask(store, task.id, 'backlog', { beforeTaskId: null }), { kind: 'applied' });
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), before.replace('position: 0', 'position: 1'));
	});

	test('cross-column manual moves append at the destination end', async () => {
		const existing = await store.create('Already done');
		const moving = await store.create('Move to done');
		await store.patch(existing.id, { state: 'done' });

		assert.deepStrictEqual(await moveTask(store, moving.id, 'done'), { kind: 'applied' });
		const done = (await store.snapshot()).columns.find((column) => column.id === 'done')!;
		assert.deepStrictEqual(done.tasks.map((task) => task.id), [existing.id, moving.id]);
		assert.deepStrictEqual(done.tasks.map((task) => task.position), [0, 1]);
	});

	test('pickTaskFor returns an explicit id without reading the store', async () => {
		// No task created — an explicit id must short-circuit before any lookup.
		assert.strictEqual(await pickTaskFor(store, 'accept', 'TASK-007'), 'TASK-007');
	});

	test('body edits survive an action/invoke round trip (G5)', async () => {
		const task = await store.create('Audit mobile empty state');
		const uri = store.fileFor(task.id);

		const edited = Buffer.from(await vscode.workspace.fs.readFile(uri))
			.toString('utf8')
			.replace('## Request\n', '## Request\na human added detail here\n');
		await vscode.workspace.fs.writeFile(uri, Buffer.from(edited, 'utf8'));

		await invokeTaskAction(store, task.id, 'accept');

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'refine');
		assert.ok(after.sections['Request'].includes('a human added detail here'));
	});
});
