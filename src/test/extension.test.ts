import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
import {
	createTaskFromCommandInput,
	WorkspaceTaskSetChange,
	WorkspaceTaskSetContext,
} from '../extension';
import { DEFAULT_TASK_SET_ID, TaskSetError } from '../model/taskSets';
import { TaskStore } from '../model/taskStore';

async function waitForWorkspaceChange(
	changes: readonly WorkspaceTaskSetChange[],
	predicate: (change: WorkspaceTaskSetChange) => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!changes.some(predicate)) {
		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for a workspace task-set change.');
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});

	test('defaults outbound turns to safe browser progress narration', () => {
		const setting = vscode.workspace
			.getConfiguration('kanbanPilot')
			.inspect<string>('chat.outboundPreamble');

		assert.strictEqual(setting?.defaultValue, DEFAULT_OUTBOUND_PREAMBLE);
		assert.match(DEFAULT_OUTBOUND_PREAMBLE, /progress updates.*required/i);
		assert.match(DEFAULT_OUTBOUND_PREAMBLE, /never include source, secrets, tokens, or absolute file paths/i);
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

	test('workspace synchronization reconciles task edits but only refreshes for attachments and order-only changes', async () => {
		const root = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-sync-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const folder: vscode.WorkspaceFolder = { uri: root, name: 'sync-test', index: 0 };
		await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, 'legacy', 'tasks'));
		const taskSetContext = new WorkspaceTaskSetContext(folder, 'legacy/tasks');
		const changes: WorkspaceTaskSetChange[] = [];
		const changeSubscription = taskSetContext.onDidChange((change) => {
			if (change) {
				changes.push(change);
			}
		});
		try {
			await taskSetContext.ready;
			await new Promise((resolve) => setTimeout(resolve, 100));
			const reconciliationCalls: (string | undefined)[] = [];
			const manager = taskSetContext.runManager as unknown as {
				reconcileTaskChange: (taskId?: string) => Promise<void>;
				applyGatePolicies: () => Promise<void>;
			};
			const originalReconcile = manager.reconcileTaskChange;
			const originalApplyGates = manager.applyGatePolicies;
			manager.reconcileTaskChange = async (taskId?: string) => {
				reconciliationCalls.push(taskId);
			};
			manager.applyGatePolicies = async () => undefined;
			try {
				const first = await taskSetContext.store.create('First synchronized task');
				await waitForWorkspaceChange(changes, (change) => change.kind === 'task' && change.taskId === first.id);
				assert.ok(reconciliationCalls.length > 0, 'ordinary task changes must reconcile run state');

				changes.length = 0;
				reconciliationCalls.length = 0;
				const attachmentDirectory = taskSetContext.store.attachmentDirectoryFor(first.id);
				await vscode.workspace.fs.createDirectory(attachmentDirectory);
				await vscode.workspace.fs.writeFile(
					vscode.Uri.joinPath(attachmentDirectory, 'evidence.png'),
					new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				);
				await waitForWorkspaceChange(changes, (change) => change.kind === 'attachment' && change.taskId === first.id);
				assert.deepStrictEqual(reconciliationCalls, [], 'attachment changes must not invoke receipt reconciliation');

				changes.length = 0;
				reconciliationCalls.length = 0;
				const second = await taskSetContext.store.create('Second synchronized task');
				await waitForWorkspaceChange(changes, (change) => change.kind === 'task' && change.taskId === second.id);
				changes.length = 0;
				reconciliationCalls.length = 0;
				await taskSetContext.store.reorder(second.id, 'backlog', { beforeTaskId: first.id });
				await waitForWorkspaceChange(changes, (change) => change.kind === 'task' && change.taskId === second.id);
				assert.deepStrictEqual(reconciliationCalls, [], 'position-only changes must not invoke receipt reconciliation');
			} finally {
				manager.reconcileTaskChange = originalReconcile;
				manager.applyGatePolicies = originalApplyGates;
			}
		} finally {
			changeSubscription.dispose();
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
