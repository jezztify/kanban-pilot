import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import { WorkspaceTaskSetContext } from '../extension';
import { DEFAULT_TASK_SET_ID, TaskSetError } from '../model/taskSets';

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
});
