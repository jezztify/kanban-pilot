import * as assert from 'assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	WORKSPACE_ACTIVITY_LIMIT,
	WorkspaceActivityStore,
} from '../model/workspaceActivity';

function workspaceRoot(label: string): vscode.Uri {
	return vscode.Uri.file(path.join(
	process.env.TEMP || process.env.TMP || '.',
	`kanban-pilot-workspace-activity-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	));
}

async function remove(uri: vscode.Uri): Promise<void> {
	try {
		await vscode.workspace.fs.delete(uri, { recursive: true });
	} catch {
		/* already gone */
	}
}

suite('Workspace activity store', () => {
	test('persists sanitized records and reloads newest first', async () => {
		const root = workspaceRoot('persistence');
		const store = new WorkspaceActivityStore(root, 'default');
		const changes: string[] = [];
		const subscription = store.onDidChange((record) => changes.push(record.message));
		try {
			const older = await store.append({
				timestamp: '2026-09-04T05:00:00Z',
				level: 'warning',
				message: 'Older activity',
				taskId: 'TASK-007',
				taskTitle: 'Prepare release notes',
			});
			const newer = await store.append({
				timestamp: '2026-09-04T05:01:00Z',
				level: 'success',
				message: 'Newer activity',
			});

			assert.strictEqual(older.timestamp, '2026-09-04T05:00:00.000Z');
			assert.strictEqual(newer.timestamp, '2026-09-04T05:01:00.000Z');
			assert.deepStrictEqual(changes, ['Older activity', 'Newer activity']);
			assert.deepStrictEqual((await store.readAll()).map((record) => record.message), [
				'Newer activity',
				'Older activity',
			]);
			assert.strictEqual(store.file.path.endsWith('/.kanban-pilot/workspace-activity/default.jsonl'), true);

			const reloaded = new WorkspaceActivityStore(root, 'default');
			assert.deepStrictEqual(await reloaded.readAll(), await store.readAll());
			assert.strictEqual((await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(root, '.kanban-pilot', 'workspace-activity'))).length, 1);
		} finally {
			subscription.dispose();
			await remove(root);
		}
	});

	test('redacts paths, controls, invalid context, and invalid levels at the persistence boundary', async () => {
		const root = workspaceRoot('sanitize');
		const store = new WorkspaceActivityStore(root, 'set-sanitize');
		try {
			const record = await store.append({
				timestamp: '2026-09-04T05:02:00Z',
				level: 'unexpected' as never,
				message: 'Failure\r\nC:\\Users\\jess\\secret.txt and /home/jess/secret.md',
				taskId: '../TASK-7',
				taskTitle: 'Title\nwith C:\\Users\\jess\\secret.txt',
			});
			assert.strictEqual(record.level, 'warning');
			assert.strictEqual(record.message.includes('\n'), false);
			assert.strictEqual(record.message.includes('C:\\Users'), false);
			assert.strictEqual(record.message.includes('/home/jess'), false);
			assert.strictEqual(record.taskId, undefined);
			assert.strictEqual(record.taskTitle?.includes('\n'), false);
			assert.strictEqual(record.taskTitle?.includes('C:\\Users'), false);
			assert.deepStrictEqual(await store.readAll(), [record]);
		} finally {
			await remove(root);
		}
	});

	test('skips malformed and over-limit lines while retaining the newest valid records only', async () => {
		const root = workspaceRoot('malformed');
		const store = new WorkspaceActivityStore(root, 'set-malformed');
		try {
			await store.ensureDirectory();
			const valid = {
				timestamp: '2026-09-04T05:03:00.000Z',
				level: 'success',
				message: 'valid',
			};
			const invalidLevel = { ...valid, level: 'info' };
			const missingMessage = { timestamp: valid.timestamp, level: 'warning' };
			const overLimit = { ...valid, message: 'x'.repeat(1001) };
			await vscode.workspace.fs.writeFile(store.file, Buffer.from([
				JSON.stringify(valid),
				'{not json}',
				JSON.stringify(invalidLevel),
				JSON.stringify(missingMessage),
				JSON.stringify(overLimit),
			].join('\n') + '\n'));
			assert.deepStrictEqual((await store.readAll()).map((record) => record.message), ['valid']);

			for (let index = 0; index < WORKSPACE_ACTIVITY_LIMIT + 7; index += 1) {
				await store.append({
					timestamp: `2026-09-04T05:${String(10 + Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z`,
					level: 'success',
					message: `entry-${index}`,
				});
			}
			const records = await store.readAll();
			assert.strictEqual(records.length, WORKSPACE_ACTIVITY_LIMIT);
			assert.strictEqual(records[0].message, `entry-${WORKSPACE_ACTIVITY_LIMIT + 6}`);
			assert.strictEqual(records.at(-1)?.message, 'entry-7');
		} finally {
			await remove(root);
		}
	});

	test('serializes concurrent appends and isolates task-set files', async () => {
		const root = workspaceRoot('concurrent');
		const defaultStore = new WorkspaceActivityStore(root, 'default');
		const namedStore = new WorkspaceActivityStore(root, 'set-other');
		try {
			await Promise.all(Array.from({ length: 12 }, (_, index) => defaultStore.append({
				timestamp: `2026-09-04T06:00:${String(index).padStart(2, '0')}Z`,
				level: 'success',
				message: `default-${index}`,
			})));
			await namedStore.append({
				timestamp: '2026-09-04T06:00:30Z',
				level: 'error',
				message: 'named-only',
			});

			assert.strictEqual((await defaultStore.readAll()).length, 12);
			assert.deepStrictEqual((await namedStore.readAll()).map((record) => record.message), ['named-only']);
			assert.notStrictEqual(defaultStore.file.path, namedStore.file.path);
			await assert.rejects(
				async () => new WorkspaceActivityStore(root, '../escape'),
				/Invalid task-set id/,
			);
		} finally {
			await remove(root);
		}
	});
});
