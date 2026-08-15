import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { COLUMNS, Column, STATUSES, Status, newTaskFile, parseSections, taskFromRaw, updateFrontmatter } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { invokeBoardAction, primaryAction, shouldDockTaskChat } from '../board/boardPanel';
import { TaskAction } from '../board/stateMachine';

/** M1 — task schema and store (PRD §6.3, §8.1). */

const SAMPLE = `---
id: TASK-142
title: Set up billing webhook
state: scoped
status: idle
created: 2026-08-13T10:04:12Z
updated: 2026-08-13T11:22:40Z
run: null
chat: kanban-pilot-TASK-142
scope_hash: 4e91a0c
chat_reset_required: false
checkpoint: a3f9c21
---

## Request
Stripe webhooks aren't handled at all.

## Refined
Add a signed webhook endpoint.

## Scope
- [ ] \`src/routes/webhooks/stripe.ts\` — route + signature verification
- [ ] \`src/billing/events.ts\` — event → state reducer

## Log
- run:r7 task:TASK-142 stage:refine result:ok note:"scope written, 3 files"
`;

suite('M1 task schema', () => {
	test('parses frontmatter and body sections', () => {
		const task = taskFromRaw(SAMPLE);
		assert.ok(task);

		assert.strictEqual(task.id, 'TASK-142');
		assert.strictEqual(task.title, 'Set up billing webhook');
		assert.strictEqual(task.state, 'scoped');
		assert.strictEqual(task.status, 'idle');
		assert.strictEqual(task.chat, 'kanban-pilot-TASK-142');
		assert.strictEqual(task.scopeHash, '4e91a0c');
		assert.strictEqual(task.chatResetRequired, false);
		assert.strictEqual(task.checkpoint, 'a3f9c21');

		// `run: null` means idle, not the literal string.
		assert.strictEqual(task.run, undefined);

		assert.ok(task.sections['Scope'].includes('signature verification'));
		assert.ok(task.sections['Log'].startsWith('- run:r7'));
	});

	test('strips trailing comments from frontmatter values', () => {
		const withComment = SAMPLE.replace(
			'scope_hash: 4e91a0c',
			'scope_hash: 4e91a0c    # hash of ## Scope as refine wrote it',
		);
		assert.strictEqual(taskFromRaw(withComment)?.scopeHash, '4e91a0c');
	});

	test('updateFrontmatter leaves the body byte-for-byte intact', () => {
		const next = updateFrontmatter(SAMPLE, { state: 'approved', status: 'running', run: 'r8' });

		const bodyOf = (s: string) => s.slice(s.indexOf('\n## Request'));
		assert.strictEqual(bodyOf(next), bodyOf(SAMPLE), 'body must not be rewritten');

		const task = taskFromRaw(next);
		assert.strictEqual(task?.state, 'approved');
		assert.strictEqual(task?.status, 'running');
		assert.strictEqual(task?.run, 'r8');
	});

	test('updateFrontmatter removes keys given undefined', () => {
		const next = updateFrontmatter(SAMPLE, { checkpoint: undefined });
		assert.strictEqual(taskFromRaw(next)?.checkpoint, undefined);
		assert.ok(!next.includes('checkpoint:'));
	});

	test('unknown state or status degrades instead of dropping the card (R4)', () => {
		const broken = SAMPLE.replace('state: scoped', 'state: banana').replace(
			'status: idle',
			'status: wat',
		);
		const task = taskFromRaw(broken);

		assert.ok(task, 'a bad enum must not lose the task');
		assert.strictEqual(task.state, 'backlog');
		assert.strictEqual(task.status, 'idle');
	});

	test('a file without frontmatter is not a task', () => {
		assert.strictEqual(taskFromRaw('# just a note\n'), undefined);
	});

	test('newTaskFile round-trips', () => {
		const raw = newTaskFile('TASK-001', 'Set up billing webhook');
		const task = taskFromRaw(raw);

		assert.strictEqual(task?.id, 'TASK-001');
		assert.strictEqual(task?.state, 'backlog');
		assert.strictEqual(task?.status, 'idle');
		assert.deepStrictEqual(Object.keys(task!.sections), ['Request', 'Refined', 'Scope', 'Log']);
	});

	test('parseSections tolerates an empty body', () => {
		assert.deepStrictEqual(parseSections(''), {});
	});

	test('newTaskFile records an origin when a run filed the task itself (§6.12)', () => {
		const raw = newTaskFile('TASK-002', 'Add retry backoff', {
			origin: { taskId: 'TASK-142', runId: 'r19', note: 'Delivery can still fail silently under load.' },
		});
		const task = taskFromRaw(raw);

		assert.strictEqual(task?.originTask, 'TASK-142');
		assert.ok(task!.sections['Request'].includes('Delivery can still fail silently under load.'));
		assert.ok(task!.sections['Request'].includes("Filed automatically by TASK-142's run r19"));
	});

	test('newTaskFile uses the description as Request, falling back to the title when blank (§6.16)', () => {
		const withDescription = newTaskFile('TASK-004', 'Set up billing webhook', {
			request: 'Stripe webhooks are not handled at all.',
		});
		assert.strictEqual(taskFromRaw(withDescription)?.sections['Request'], 'Stripe webhooks are not handled at all.');

		const blankDescription = newTaskFile('TASK-005', 'Set up billing webhook', { request: '   ' });
		assert.strictEqual(taskFromRaw(blankDescription)?.sections['Request'], 'Set up billing webhook');
	});

	test('newTaskFile omits origin_task entirely for a human-typed task', () => {
		const raw = newTaskFile('TASK-003', 'Human-typed title');
		assert.ok(!raw.includes('origin_task'));
		assert.strictEqual(taskFromRaw(raw)?.originTask, undefined);
	});
});

suite('M1 task store', () => {
	let store: TaskStore;
	let dir: vscode.Uri;

	setup(async () => {
		dir = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-test-${Date.now()}-${Math.random().toString(36).slice(2)}`),
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

	test('an empty folder yields every column, all empty', async () => {
		const snapshot = await store.snapshot();

		assert.strictEqual(snapshot.columns.length, 7);
		assert.deepStrictEqual(
			snapshot.columns.map((c) => c.id),
			['backlog', 'refine', 'scoped', 'approved', 'in-progress', 'validation', 'done'],
		);
		assert.ok(snapshot.columns.every((c) => c.tasks.length === 0));
	});

	test('ids allocate as max + 1 and tolerate gaps', async () => {
		assert.strictEqual(await store.nextId(), 'TASK-001');

		await store.create('first');
		assert.strictEqual(await store.nextId(), 'TASK-002');

		// Simulate a merge that landed a much higher id.
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-142.md'),
			Buffer.from(newTaskFile('TASK-142', 'from another branch'), 'utf8'),
		);
		assert.strictEqual(await store.nextId(), 'TASK-143');
	});

	test('create then patch moves the card between columns', async () => {
		const task = await store.create('Set up billing webhook');
		assert.strictEqual(task.state, 'backlog');

		await store.patch(task.id, { state: 'refine', status: 'running', run: 'r1' });

		const snapshot = await store.snapshot();
		const refine = snapshot.columns.find((c) => c.id === 'refine');

		assert.strictEqual(refine?.tasks.length, 1);
		assert.strictEqual(refine.tasks[0].id, task.id);
		assert.strictEqual(refine.tasks[0].status, 'running');
	});

	test('patch preserves body edits made outside the extension (G5)', async () => {
		const task = await store.create('Audit mobile empty state');
		const uri = store.fileFor(task.id);

		const edited = Buffer.from(await vscode.workspace.fs.readFile(uri))
			.toString('utf8')
			.replace('## Scope\n', '## Scope\n- [ ] a checklist item a human typed\n');
		await vscode.workspace.fs.writeFile(uri, Buffer.from(edited, 'utf8'));

		await store.patch(task.id, { state: 'scoped' });

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'scoped');
		assert.ok(after.sections['Scope'].includes('a human typed'));
	});

	test('unparseable files are reported, not silently dropped (R4)', async () => {
		await store.create('a good one');
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-999.md'),
			Buffer.from('no frontmatter here\n', 'utf8'),
		);

		const snapshot = await store.snapshot();
		assert.deepStrictEqual(snapshot.malformed, ['TASK-999.md']);
		assert.strictEqual(snapshot.columns.find((c) => c.id === 'backlog')?.tasks.length, 1);
	});

	test('create() with an origin lands the task in Backlog carrying originTask (§6.12)', async () => {
		const filer = await store.create('Set up billing webhook');
		const filed = await store.create('Add retry backoff', {
			origin: { taskId: filer.id, runId: 'r19', note: 'Discovered while implementing.' },
		});

		assert.strictEqual(filed.state, 'backlog');
		assert.strictEqual(filed.originTask, filer.id);
	});

	test('non-task files in the folder are ignored', async () => {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'README.md'),
			Buffer.from('# notes\n', 'utf8'),
		);

		const snapshot = await store.snapshot();
		assert.deepStrictEqual(snapshot.malformed, []);
		assert.ok(snapshot.columns.every((c) => c.tasks.length === 0));
	});
});

suite('M1 card action matrix (§5.2)', () => {
	test('reproduces the design exactly', () => {
		const cases: [Column, Status, TaskAction | undefined][] = [
			['backlog', 'idle', 'accept'],
			['refine', 'idle', 'refine'],
			['refine', 'running', 'stop'],
			['refine', 'blocked', 'refine'],
			['refine', 'failed', 'refine'],
			['scoped', 'idle', 'approve'],
			['approved', 'idle', 'develop'],
			['in-progress', 'running', 'stop'],
			['in-progress', 'paused', 'continue'],
			// Not in the original §5.2 table: reachable when a reload loses the
			// await and reconciliation parks the card (§6.4). Stop would be a lie.
			['in-progress', 'idle', 'continue'],
			['in-progress', 'blocked', 'continue'],
			['in-progress', 'failed', 'continue'],
			// §12 Q10: the Validation gate adopted from the live prototype.
			['validation', 'idle', 'validate'],
			['done', 'idle', undefined],
		];

		for (const [state, status, expected] of cases) {
			assert.strictEqual(
				primaryAction(state, status),
				expected,
				`${state} + ${status} should offer ${expected ?? 'no action'}`,
			);
		}
	});

	test('a running card always offers Stop, whichever column it sits in', () => {
		for (const state of COLUMNS) {
			if (state === 'done') { continue; }
			assert.strictEqual(primaryAction(state, 'running'), 'stop');
		}
	});

	test('Done never offers a primary action, whatever the status', () => {
		for (const status of STATUSES) {
			assert.strictEqual(primaryAction('done', status), undefined);
		}
	});

	test('every column/status pair resolves without falling through', () => {
		for (const state of COLUMNS) {
			for (const status of STATUSES) {
				const action = primaryAction(state, status);
				assert.ok(
					action !== undefined || state === 'done',
					`${state} + ${status} produced no action`,
				);
			}
		}
	});
});

suite('card action chat docking', () => {
	test('docks the task chat before invoking a requested stage action', async () => {
		const events: string[] = [];
		const runManager = {
			dockTaskChat: async () => {
				events.push('dock');
			},
			handleAction: async () => {
				events.push('action');
			},
		};

		await invokeBoardAction(runManager, 'TASK-001', 'develop');

		assert.deepStrictEqual(events, ['dock', 'action']);
	});

	test('does not dock when invoking an out-of-scope card action', async () => {
		const events: string[] = [];
		const runManager = {
			dockTaskChat: async () => {
				events.push('dock');
			},
			handleAction: async () => {
				events.push('action');
			},
		};

		await invokeBoardAction(runManager, 'TASK-001', 'continue');

		assert.deepStrictEqual(events, ['action']);
	});

	test('only Refine, Develop, and Validate request action-triggered docking', () => {
		assert.strictEqual(shouldDockTaskChat('refine'), true);
		assert.strictEqual(shouldDockTaskChat('develop'), true);
		assert.strictEqual(shouldDockTaskChat('validate'), true);

		for (const action of ['accept', 'split', 'approve', 'continue', 'stop', 'reopen'] as TaskAction[]) {
			assert.strictEqual(shouldDockTaskChat(action), false, `${action} must not dock the task chat`);
		}
	});
});
