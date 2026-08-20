import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { createTaskFromCommandInput, WorkspaceTaskSetContext } from '../extension';
import { DEFAULT_TASK_SET_ID, TaskSetError } from '../model/taskSets';
import { TaskStore } from '../model/taskStore';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('active task-set switching isolates cards and refuses a running-set switch', async () => {
		const root = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-context-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const folder: vscode.WorkspaceFolder = { uri: root, name: 'context-test', index: 0 };
		const taskSetContext = new WorkspaceTaskSetContext(folder, 'legacy/tasks');
		try {
			await taskSetContext.ready;
			const defaultTask = await taskSetContext.store.create('Default-only task');
			await taskSetContext.createTaskSet('Mobile release');
			const mobileTask = await taskSetContext.store.create('Mobile-only task');
			assert.strictEqual(taskSetContext.activeSet.name, 'Mobile release');
			assert.deepStrictEqual((await taskSetContext.store.readAll()).tasks.map((task) => task.id), [mobileTask.id]);

			await taskSetContext.store.patch(mobileTask.id, { status: 'running', run: 'r-active' });
			await assert.rejects(() => taskSetContext.switchTaskSet(DEFAULT_TASK_SET_ID), (error: unknown) =>
				(error instanceof TaskSetError && error.code === 'active-run') ||
				(typeof error === 'object' && error !== null && (error as { code?: string }).code === 'active-run'),
			);

			await taskSetContext.store.patch(mobileTask.id, { status: 'idle', run: undefined });
			await taskSetContext.switchTaskSet(DEFAULT_TASK_SET_ID);
			assert.strictEqual(taskSetContext.activeSet.id, DEFAULT_TASK_SET_ID);
			assert.deepStrictEqual((await taskSetContext.store.readAll()).tasks.map((task) => task.id), [defaultTask.id]);
		} finally {
			taskSetContext.dispose();
			try {
				await vscode.workspace.fs.delete(root, { recursive: true });
			} catch {
				/* already gone */
			}
		}
	});

	test('New Task command input persists the selected type and rejects missing or invalid types', async () => {
		const root = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-command-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(root);
		await store.ensureDirectory();
		try {
			assert.strictEqual(
				await createTaskFromCommandInput(store, {
					title: '  Add search  ',
					description: '  Add task search  ',
					taskType: 'feature',
				}),
				true,
			);
			assert.strictEqual(
				await createTaskFromCommandInput(store, {
					title: '  Fix search  ',
					description: '  Search crashes  ',
					taskType: 'bug',
				}),
				true,
			);
			assert.strictEqual(
				await createTaskFromCommandInput(store, { title: 'Missing type', taskType: undefined }),
				false,
			);
			assert.strictEqual(
				await createTaskFromCommandInput(store, { title: 'Invalid type', taskType: 'regression' }),
				false,
			);

			const tasks = (await store.readAll()).tasks;
			assert.deepStrictEqual(tasks.map((task) => [task.title, task.type]), [
				['Add search', 'feature'],
				['Fix search', 'bug'],
			]);
			assert.strictEqual(tasks.some((task) => task.title === 'Missing type' || task.title === 'Invalid type'), false);
		} finally {
			try {
				await vscode.workspace.fs.delete(root, { recursive: true });
			} catch {
				/* already gone */
			}
		}
	});

	test('Apply Pending Completion is registered and safely ignores an unknown task', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('kanban-pilot.applyPendingOutcome'));
		await vscode.commands.executeCommand('kanban-pilot.applyPendingOutcome', 'TASK-NOT-FOUND-FOR-PENDING-TEST');
	});

	test('Recover Stale Completion is registered and safely reports no candidates', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('kanban-pilot.recoverStaleCompletion'));
		await vscode.commands.executeCommand('kanban-pilot.recoverStaleCompletion', 'TASK-NOT-FOUND-FOR-RECOVERY-TEST');
	});
});
