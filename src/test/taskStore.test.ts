import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
	COLUMNS,
	Column,
	encodePendingOutcome,
	isPendingOutcome,
	isValidTaskPosition,
	normalizeTaskAttachmentInput,
	normalizeTaskType,
	removeTaskAttachmentReferences,
	replaceTaskAttachmentMarkers,
	STATUSES,
	Status,
	TASK_ATTACHMENT_MAX_BYTES,
	taskAttachmentReference,
	taskAttachmentReferences,
	newTaskFile,
	parseSections,
	taskFromRaw,
	updateEditableTaskContent,
	updateFrontmatter,
} from '../model/task';
import { sessionIdForTask, sessionIdForTaskBinding } from '../chat/sessionUri';
import { DEFAULT_TASK_SET_ID, TaskSetError, TaskSetRegistry } from '../model/taskSets';
import { TaskMutationConflictError, TaskStore } from '../model/taskStore';
import { invokeBoardAction, primaryAction, shouldDockTaskChat } from '../board/boardPanel';
import { TaskAction } from '../board/stateMachine';
import { parseAuditEvents } from '../model/taskLog';
import { formatReceipt, parseReceipts } from '../chat/receipt';

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

const PNG = new Uint8Array([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x00,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const WEBP = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
	0x57, 0x45, 0x42, 0x50,
]);

suite('M1 task schema', () => {
	test('parses frontmatter and body sections', () => {
		const task = taskFromRaw(SAMPLE);
		assert.ok(task);

		assert.strictEqual(task.id, 'TASK-142');
		assert.strictEqual(task.title, 'Set up billing webhook');
		assert.strictEqual(task.type, 'feature', 'legacy files default to Feature in memory');
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

	test('parses valid positions and falls back for malformed positions', () => {
		assert.strictEqual(taskFromRaw(SAMPLE.replace('state: scoped', 'state: scoped\nposition: 4.5'))?.position, 4.5);
		assert.strictEqual(taskFromRaw(SAMPLE.replace('state: scoped', 'state: scoped\nposition: -1'))?.position, undefined);
		assert.strictEqual(taskFromRaw(SAMPLE.replace('state: scoped', 'state: scoped\nposition: Infinity'))?.position, undefined);
		assert.strictEqual(taskFromRaw(SAMPLE.replace('state: scoped', 'state: scoped\nposition: malformed'))?.position, undefined);
		assert.strictEqual(isValidTaskPosition(0), true);
		assert.strictEqual(isValidTaskPosition(Number.POSITIVE_INFINITY), false);
		assert.strictEqual(isValidTaskPosition(-1), false);
	});

	test('serializes position in the extension-owned frontmatter order', () => {
		const next = updateFrontmatter(SAMPLE, { position: '2' });
		assert.ok(next.indexOf('state: scoped') < next.indexOf('status: idle'));
		assert.ok(next.indexOf('status: idle') < next.indexOf('position: 2'));
		assert.ok(next.indexOf('position: 2') < next.indexOf('created:'));
		assert.strictEqual(taskFromRaw(newTaskFile('TASK-006', 'Positioned', { position: 3 }))?.position, 3);
		assert.ok(newTaskFile('TASK-007', 'Invalid position', { position: -1 }).indexOf('position:') === -1);
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

	test('updateEditableTaskContent replaces editable sections and preserves other body content', () => {
		const raw = `${SAMPLE.replace('title: Set up billing webhook', 'title: Original title').replace(
			'## Log\n',
			'## Notes\nKeep this unrelated section byte-for-byte.\n\n## Log\n',
		)}- existing receipt\n`;
		const next = updateEditableTaskContent(raw, {
			title: '  Corrected title  ',
			request: 'First line\n\n- **multiline** request',
			refined: 'A refined paragraph\nwith a second line.',
			scope: '- [ ] Keep the scope hash unchanged\n- [ ] Preserve Markdown',
		});
		const task = taskFromRaw(next);

		assert.ok(task);
		assert.strictEqual(task.title, 'Corrected title');
		assert.strictEqual(task.sections['Request'], 'First line\n\n- **multiline** request');
		assert.strictEqual(task.sections['Refined'], 'A refined paragraph\nwith a second line.');
		assert.strictEqual(task.sections['Scope'], '- [ ] Keep the scope hash unchanged\n- [ ] Preserve Markdown');
		assert.ok(next.includes('scope_hash: 4e91a0c'));
		assert.ok(next.includes('## Notes\nKeep this unrelated section byte-for-byte.'));
		assert.ok(next.includes('- existing receipt\n'));
	});

	test('updateEditableTaskContent rejects invalid titles before changing content', () => {
		assert.throws(
			() => updateEditableTaskContent(SAMPLE, { title: '   ', request: '', refined: '', scope: '' }),
			/Task title cannot be blank/,
		);
		assert.throws(
			() => updateEditableTaskContent(SAMPLE, {
				title: 'x'.repeat(201),
				request: '',
				refined: '',
				scope: '',
			}),
			/200 characters or fewer/,
		);
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
		assert.strictEqual(task?.type, 'feature');
		assert.deepStrictEqual(Object.keys(task!.sections), ['Request', 'Refined', 'Scope', 'Log']);
	});

	test('supports the canonical Bug type and normalizes invalid values', () => {
		const raw = newTaskFile('TASK-008', 'Fix webhook retry', { type: 'bug' });
		assert.strictEqual(taskFromRaw(raw)?.type, 'bug');
		assert.strictEqual(normalizeTaskType('feature'), 'feature');
		assert.strictEqual(normalizeTaskType('invalid'), 'feature');
		assert.strictEqual(normalizeTaskType(undefined), 'feature');
	});

	test('parseSections tolerates an empty body', () => {
		assert.deepStrictEqual(parseSections(''), {});
	});

	test('newTaskFile records an origin when a run filed the task itself (§6.12)', () => {
		const raw = newTaskFile('TASK-002', 'Add retry backoff', {
			origin: {
				taskId: 'TASK-142',
				runId: 'r19',
				note: 'Delivery can still fail silently under load.',
				proposalKey: 'proposal-key-1',
			},
		});
		const task = taskFromRaw(raw);

		assert.strictEqual(task?.originTask, 'TASK-142');
		assert.strictEqual(task?.originRunId, 'r19');
		assert.strictEqual(task?.originProposalKey, 'proposal-key-1');
		assert.match(raw, /origin_run: r19/);
		assert.match(raw, /origin_proposal: proposal-key-1/);
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

	test('validates task image types, signatures, size, and generated references', () => {
		assert.strictEqual(normalizeTaskAttachmentInput({
			id: 'paste-1', name: 'screen shot.png', mimeType: 'image/png', data: PNG,
		}).mimeType, 'image/png');
		assert.strictEqual(normalizeTaskAttachmentInput({
			name: 'photo.jpg', mimeType: 'image/jpeg', data: JPEG,
		}).mimeType, 'image/jpeg');
		assert.throws(
			() => normalizeTaskAttachmentInput({ name: 'vector.svg', mimeType: 'image/svg+xml', data: '<svg />' }),
			/SVG is not supported/,
		);
		assert.throws(
			() => normalizeTaskAttachmentInput({ name: '../escape.png', mimeType: 'image/png', data: PNG }),
			/path traversal/,
		);
		assert.throws(
			() => normalizeTaskAttachmentInput({ name: 'not-an-image.png', mimeType: 'image/png', data: JPEG }),
			/does not match/,
		);
		const oversized = new Uint8Array(TASK_ATTACHMENT_MAX_BYTES + 1);
		oversized.set(PNG);
		assert.throws(
			() => normalizeTaskAttachmentInput({ name: 'large.png', mimeType: 'image/png', data: oversized }),
			/10 MiB or smaller/,
		);

		const reference = taskAttachmentReference('TASK-009', 'screen-shot.png');
		assert.deepStrictEqual(taskAttachmentReferences('TASK-009', `![screen](${reference})`), [reference]);
		assert.throws(
			() => taskAttachmentReferences('TASK-009', '![other](TASK-010.attachments/other.png)'),
			/safe task-local/,
		);
		const replacements = new Map([['paste-1', reference]]);
		assert.strictEqual(replaceTaskAttachmentMarkers('before ![screen](attachment://paste-1)', replacements), `before ![screen](${reference})`);
		assert.strictEqual(removeTaskAttachmentReferences(`a ![screen](${reference}) b`, new Set([reference])), 'a  b');
	});

	test('round-trips valid pending completion metadata and ignores invalid payloads', () => {
		const pending = {
			gate: 'refineToScoped' as const,
			stage: 'refine' as const,
			result: 'ok' as const,
			runId: 'r-pending',
			scopeHash: 'abc1234',
		};
		assert.strictEqual(isPendingOutcome(pending), true);
		const raw = updateFrontmatter(SAMPLE, { pending_outcome: encodePendingOutcome(pending) });
		const body = raw.slice(raw.indexOf('\n## Request'));
		assert.strictEqual(body, SAMPLE.slice(SAMPLE.indexOf('\n## Request')));
		assert.deepStrictEqual(taskFromRaw(raw)?.pendingOutcome, pending);
		assert.strictEqual(
			taskFromRaw(updateFrontmatter(raw, {
				pending_outcome: JSON.stringify({ ...pending, gate: 'validateToDone' }),
			}))?.pendingOutcome,
			undefined,
		);
		assert.strictEqual(
			taskFromRaw(updateFrontmatter(raw, { pending_outcome: '{not-json' }))?.id,
			'TASK-142',
		);
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

	test('creates and persists an explicitly typed task', async () => {
		const created = await store.create('Fix retry handling', { type: 'bug' });
		assert.strictEqual(created.type, 'bug');
		const raw = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(created.id))).toString('utf8');
		assert.match(raw, /type: bug/);
		assert.strictEqual((await store.readAll()).tasks[0].type, 'bug');
	});

	test('creates, lists, edits, and removes task-local image attachments atomically', async () => {
		const created = await store.create('Image evidence', {
			request: 'Before\n\n![first](attachment://first)\n\n![second](attachment://second)\n\nAfter',
			attachments: {
				add: [
					{ id: 'first', name: 'screen shot.png', mimeType: 'image/png', data: PNG },
					{ id: 'second', name: 'photo.jpg', mimeType: 'image/jpeg', data: JPEG },
				],
			},
		});
		const firstReference = taskAttachmentReference(created.id, 'screen-shot.png');
		const secondReference = taskAttachmentReference(created.id, 'photo.jpg');
		const raw = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(created.id))).toString('utf8');
		assert.ok(raw.includes(`![first](${firstReference})`));
		assert.ok(raw.includes(`![second](${secondReference})`));
		assert.strictEqual(raw.includes('attachment://'), false);
		assert.deepStrictEqual((await store.listAttachments(created.id)).map((attachment) => attachment.relativePath), [firstReference, secondReference]);
		assert.strictEqual((await vscode.workspace.fs.readFile(store.attachmentFileFor(created.id, firstReference))).byteLength, PNG.byteLength);

		await store.edit(created.id, {
			title: created.title,
			request: `Keep ![first](${firstReference})`,
			refined: '![new evidence](attachment://new-evidence)',
			scope: '',
		}, {
			add: [{ id: 'new-evidence', name: 'new evidence.webp', mimeType: 'image/webp', data: WEBP }],
			remove: [secondReference],
		});
		const after = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(created.id))).toString('utf8');
		const newReference = taskAttachmentReference(created.id, 'new-evidence.webp');
		assert.ok(after.includes(`![new evidence](${newReference})`));
		assert.ok(after.includes(firstReference));
		assert.ok(!after.includes(secondReference));
		assert.deepStrictEqual((await store.listAttachments(created.id)).map((attachment) => attachment.relativePath), [firstReference, newReference]);
		await assert.rejects(
			async () => { await vscode.workspace.fs.stat(store.attachmentFileFor(created.id, secondReference)); },
		);
	});

	test('failed attachment persistence rolls back Markdown and binary files', async () => {
		let renameCount = 0;
		const renameWithFailure: vscode.FileSystem['rename'] = async (source, target, options) => {
			if (++renameCount === 2) {
				throw new Error('injected attachment rename failure');
			}
			return vscode.workspace.fs.rename(source, target, options);
		};
		const failingStore = new TaskStore(dir, 'default', renameWithFailure);

		await assert.rejects(
			() => failingStore.create('Should roll back', {
			attachments: { add: [{ name: 'failure.png', mimeType: 'image/png', data: PNG }] },
			}),
			/injected attachment rename failure/,
		);
		assert.deepStrictEqual((await failingStore.readAll()).tasks, []);
		assert.deepStrictEqual(
			(await vscode.workspace.fs.readDirectory(dir)).filter(([name]) => /\.attachments$|\.reorder\./.test(name)),
			[],
		);
	});

	test('deletes only the task-owned attachment directory', async () => {
		const first = await store.create('First with image', {
			attachments: { add: [{ name: 'first.png', mimeType: 'image/png', data: PNG }] },
		});
		const second = await store.create('Second with image', {
			attachments: { add: [{ name: 'second.png', mimeType: 'image/png', data: PNG }] },
		});
		await store.delete(first.id);
		await assert.rejects(async () => { await vscode.workspace.fs.stat(store.fileFor(first.id)); });
		await assert.rejects(async () => { await vscode.workspace.fs.stat(store.attachmentDirectoryFor(first.id)); });
		assert.strictEqual((await store.readAll()).tasks[0].id, second.id);
		assert.strictEqual((await store.listAttachments(second.id)).length, 1);
	});

	test('persists pending outcomes, preserves the body, and clears them on ordinary mutations', async () => {
		const task = await store.create('Pending task');
		const pending = encodePendingOutcome({
			gate: 'refineToScoped',
			stage: 'refine',
			result: 'ok',
			runId: 'r-store',
			scopeHash: 'abc1234',
		});
		const uri = store.fileFor(task.id);
		const beforeBody = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8').split('---\n').slice(2).join('---\n');

		await store.patch(task.id, { pending_outcome: pending });
		assert.deepStrictEqual((await store.readAll()).tasks[0].pendingOutcome, {
			gate: 'refineToScoped', stage: 'refine', result: 'ok', runId: 'r-store', scopeHash: 'abc1234',
		});
		const afterPending = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		assert.strictEqual(afterPending.split('---\n').slice(2).join('---\n'), beforeBody);

		await store.patch(task.id, { state: 'scoped' });
		assert.strictEqual((await store.readAll()).tasks[0].pendingOutcome, undefined);
		await store.patch(task.id, { pending_outcome: pending });
		await store.edit(task.id, { title: 'Edited pending task', request: 'request', refined: 'refined', scope: 'scope' });
		assert.strictEqual((await store.readAll()).tasks[0].pendingOutcome, undefined);
	});

	test('rejects invalid generic pending writes and stale compare-and-set mutations', async () => {
		const task = await store.create('Guard pending writes');
		await assert.rejects(
			store.patch(task.id, { pending_outcome: JSON.stringify({ gate: 'not-a-gate' }) }),
			/Invalid pending outcome/,
		);
		const pending = {
			gate: 'refineToScoped' as const,
			stage: 'refine' as const,
			result: 'ok' as const,
			runId: 'r-cas',
			scopeHash: 'abc1234',
		};
		await store.patch(task.id, { state: 'refine', pending_outcome: encodePendingOutcome(pending) });
		await assert.rejects(
			store.auditedPatch(task.id, { state: 'scoped', pending_outcome: undefined }, {
				expected: { state: 'refine', status: 'running', pendingOutcome: pending },
			}),
			(error: unknown) => error instanceof TaskMutationConflictError,
		);
	});

	test('backfills missing and invalid legacy types without dropping the cards', async () => {
		const missing = newTaskFile('TASK-101', 'Legacy missing type').replace('type: feature\n', '');
		const invalid = missing.replace('title: Legacy missing type', 'title: Legacy invalid type').replace('id: TASK-101', 'id: TASK-102')
			.replace('state: backlog', 'type: regression\nstate: backlog');
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'TASK-101.md'), Buffer.from(missing, 'utf8'));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'TASK-102.md'), Buffer.from(invalid, 'utf8'));

		const result = await store.readAll();
		assert.deepStrictEqual(result.malformed, []);
		assert.deepStrictEqual(result.tasks.map((task) => task.type), ['feature', 'feature']);
		const migratedMissing = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'TASK-101.md'))).toString('utf8');
		const migratedInvalid = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'TASK-102.md'))).toString('utf8');
		assert.match(migratedMissing, /type: feature/);
		assert.match(migratedInvalid, /type: feature/);
		assert.doesNotMatch(migratedInvalid, /type: regression/);
	});

	test('creates backlog tasks with append positions and orders legacy files deterministically', async () => {
		const first = await store.create('First');
		const second = await store.create('Second');
		assert.strictEqual(first.position, 0);
		assert.strictEqual(second.position, 1);

		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-010.md'),
			Buffer.from(newTaskFile('TASK-010', 'Legacy ten'), 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-020.md'),
			Buffer.from(newTaskFile('TASK-020', 'Legacy twenty'), 'utf8'),
		);
		const snapshot = await store.snapshot();
		assert.deepStrictEqual(
			snapshot.columns.find((column) => column.id === 'backlog')?.tasks.map((task) => task.id),
			['TASK-001', 'TASK-002', 'TASK-010', 'TASK-020'],
		);
	});

	test('uses task id as a deterministic tie-breaker for duplicate positions', async () => {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-010.md'),
			Buffer.from(newTaskFile('TASK-010', 'Ten', { position: 2 }), 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-002.md'),
			Buffer.from(newTaskFile('TASK-002', 'Two', { position: 2 }), 'utf8'),
		);
		const tasks = (await store.snapshot()).columns.find((column) => column.id === 'backlog')?.tasks ?? [];
		assert.deepStrictEqual(tasks.map((task) => task.id), ['TASK-002', 'TASK-010']);
	});

	test('appends a new task after a column containing only legacy files', async () => {
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-010.md'),
			Buffer.from(newTaskFile('TASK-010', 'Legacy ten'), 'utf8'),
		);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, 'TASK-020.md'),
			Buffer.from(newTaskFile('TASK-020', 'Legacy twenty'), 'utf8'),
		);
		const created = await store.create('New last task');
		const backlog = (await store.snapshot()).columns[0].tasks;
		assert.deepStrictEqual(backlog.map((task) => task.id), ['TASK-010', 'TASK-020', created.id]);
		assert.deepStrictEqual(backlog.map((task) => task.position), [0, 1, 2]);
	});

	test('reorders top, middle, and end, persists positions, and survives a fresh store', async () => {
		await store.create('One');
		await store.create('Two');
		await store.create('Three');
		await store.create('Four');

		assert.deepStrictEqual(await store.reorder('TASK-004', 'backlog', { beforeTaskId: 'TASK-001' }), { kind: 'applied' });
		assert.deepStrictEqual(await store.reorder('TASK-004', 'backlog', { beforeTaskId: 'TASK-003' }), { kind: 'applied' });
		assert.deepStrictEqual(await store.reorder('TASK-004', 'backlog', { beforeTaskId: null }), { kind: 'applied' });

		const expected = ['TASK-001', 'TASK-002', 'TASK-003', 'TASK-004'];
		const snapshot = await store.snapshot();
		assert.deepStrictEqual(snapshot.columns[0].tasks.map((task) => task.id), expected);
		assert.deepStrictEqual(
			snapshot.columns[0].tasks.map((task) => task.position),
			[0, 1, 2, 3],
		);
		const reloaded = new TaskStore(dir).snapshot();
		assert.deepStrictEqual((await reloaded).columns[0].tasks.map((task) => task.id), expected);
	});

	test('targetIndex inserts into the remaining sequence and rejects invalid or stale targets', async () => {
		await store.create('One');
		await store.create('Two');
		await store.create('Three');
		assert.deepStrictEqual(await store.reorder('TASK-003', 'backlog', { targetIndex: 0 }), { kind: 'applied' });
		assert.deepStrictEqual(
			(await store.snapshot()).columns[0].tasks.map((task) => task.id),
			['TASK-003', 'TASK-001', 'TASK-002'],
		);
		assert.deepStrictEqual(await store.reorder('TASK-003', 'backlog', { targetIndex: 3 }), { kind: 'invalid' });
		assert.deepStrictEqual(await store.reorder('TASK-003', 'backlog', { beforeTaskId: 'TASK-999' }), { kind: 'stale' });
		assert.deepStrictEqual(await store.reorder('TASK-003', 'done', { beforeTaskId: null }), { kind: 'stale' });
		assert.deepStrictEqual(await store.reorder('TASK-999', 'backlog', { beforeTaskId: null }), { kind: 'not-found' });
	});

	test('same-position reorder is a byte-for-byte no-op and preserves body and metadata on apply', async () => {
		const first = await store.create('First');
		const second = await store.create('Second');
		const firstUri = store.fileFor(first.id);
		const secondUri = store.fileFor(second.id);
		const firstRaw = Buffer.from(await vscode.workspace.fs.readFile(firstUri)).toString('utf8');
		const secondRaw = Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString('utf8');
		const enriched = updateFrontmatter(firstRaw, {
			status: 'running',
			run: 'r-active',
			chat: 'kanban-pilot-TASK-001',
			copilot_session_id: 'session-1',
			scope_hash: 'hash-1',
			checkpoint: 'deadbee',
			origin_task: 'TASK-009',
		}).replace('## Request\n', '## Notes\nUnrelated body.\n\n## Request\n');
		await vscode.workspace.fs.writeFile(firstUri, Buffer.from(enriched, 'utf8'));
		const noOpBefore = Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString('utf8');
		assert.deepStrictEqual(await store.reorder(second.id, 'backlog', { beforeTaskId: first.id }), { kind: 'applied' });
		const unchangedBefore = Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString('utf8');
		assert.deepStrictEqual(await store.reorder(second.id, 'backlog', { beforeTaskId: first.id }), { kind: 'no-op' });
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(secondUri)).toString('utf8'), unchangedBefore);
		assert.notStrictEqual(noOpBefore, unchangedBefore, 'the first reorder should normalise positions');

		assert.deepStrictEqual(await store.reorder(first.id, 'backlog', { beforeTaskId: second.id }), { kind: 'applied' });
		const after = (await store.readAll()).tasks.find((task) => task.id === first.id)!;
		assert.strictEqual(after.status, 'running');
		assert.strictEqual(after.run, 'r-active');
		assert.strictEqual(after.chat, 'kanban-pilot-TASK-001');
		assert.strictEqual(after.copilotSessionId, 'session-1');
		assert.strictEqual(after.scopeHash, 'hash-1');
		assert.strictEqual(after.checkpoint, 'deadbee');
		assert.strictEqual(after.originTask, 'TASK-009');
		assert.strictEqual(after.sections['Notes'], 'Unrelated body.');
	});

	test('a failed batch replacement restores every task file', async () => {
		await store.create('First');
		await store.create('Second');
		await store.create('Third');
		const before = new Map<string, string>();
		for (const id of ['TASK-001', 'TASK-002', 'TASK-003']) {
			before.set(id, Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(id))).toString('utf8'));
		}

		let renameCount = 0;
		const renameWithFailure: vscode.FileSystem['rename'] = async (source, target, options) => {
			if (++renameCount === 2) {
				throw new Error('injected rename failure');
			}
			return vscode.workspace.fs.rename(source, target, options);
		};
		const failingStore = new TaskStore(dir, 'default', renameWithFailure);

		await assert.rejects(
			() => failingStore.reorder('TASK-003', 'backlog', { beforeTaskId: 'TASK-001' }),
			/injected rename failure/,
		);

		for (const [id, raw] of before) {
			assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(id))).toString('utf8'), raw);
		}
		assert.deepStrictEqual(
			(await vscode.workspace.fs.readDirectory(dir)).filter(([name]) => /\.reorder\./.test(name)),
			[],
		);
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

	test('persists a first-use chat binding atomically and preserves it after a fresh store reload', async () => {
		const task = await store.create('Keep this conversation');
		const before = task.body;
		const chat = sessionIdForTaskBinding(task, 'kanban-pilot-', store.setId);

		await store.patch(task.id, {
			state: 'in-progress',
			status: 'running',
			run: 'r-active',
			chat,
		});

		const reloaded = new TaskStore(dir, store.setId);
		const after = (await reloaded.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
		assert.strictEqual(after.chat, chat);
		assert.strictEqual(after.state, 'in-progress');
		assert.strictEqual(after.status, 'running');
		assert.strictEqual(after.run, 'r-active');
		assert.strictEqual(after.body, before);
		assert.strictEqual(sessionIdForTask(task.id, 'different-prefix-', store.setId), 'different-prefix-TASK-001');
		assert.strictEqual(sessionIdForTaskBinding(after, 'different-prefix-', store.setId), chat);
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

	test('edit updates title and editable sections while preserving protected metadata, log, and body content', async () => {
		const task = await store.create('Original title');
		const uri = store.fileFor(task.id);
		const original = updateFrontmatter(
			Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'),
			{
				state: 'scoped',
				status: 'idle',
				run: 'r-preserve',
				chat: 'kanban-pilot-TASK-001',
				copilot_session_id: 'copilot-session',
				scope_hash: 'abc1234',
				checkpoint: 'deadbee',
				origin_task: 'TASK-009',
				updated: '2026-01-01T00:00:00Z',
			},
		).replace('## Log\n', '## Notes\nUnrelated body content.\n\n## Log\n- old log line\n');
		await vscode.workspace.fs.writeFile(uri, Buffer.from(original, 'utf8'));

		const edited = await store.edit(task.id, {
			title: '  Edited title #123 ',
			request: 'Request line 1\nRequest line 2\n\n- item',
			refined: 'Refined **Markdown**',
			scope: '- [ ] Edited scope',
		});
		const afterRaw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const after = taskFromRaw(afterRaw);

		assert.strictEqual(edited.title, 'Edited title #123');
		assert.strictEqual(after?.title, 'Edited title #123');
		assert.match(afterRaw, /^title: "Edited title #123"$/m);
		assert.strictEqual(after?.state, 'scoped');
		assert.strictEqual(after?.status, 'idle');
		assert.strictEqual(after?.run, 'r-preserve');
		assert.strictEqual(after?.chat, 'kanban-pilot-TASK-001');
		assert.strictEqual(after?.copilotSessionId, 'copilot-session');
		assert.strictEqual(after?.scopeHash, 'abc1234');
		assert.strictEqual(after?.checkpoint, 'deadbee');
		assert.strictEqual(after?.originTask, 'TASK-009');
		assert.strictEqual(after?.sections['Log'], '- old log line');
		assert.strictEqual(after?.sections['Notes'], 'Unrelated body content.');
		assert.strictEqual(after?.sections['Request'], 'Request line 1\nRequest line 2\n\n- item');
		assert.strictEqual(after?.sections['Refined'], 'Refined **Markdown**');
		assert.strictEqual(after?.sections['Scope'], '- [ ] Edited scope');
		assert.notStrictEqual(after?.updated, '2026-01-01T00:00:00Z');
		assert.ok(afterRaw.includes('- old log line\n'));
		assert.ok(!afterRaw.includes('audit:'));
	});

	test('edit validates before writing and rejects missing or running tasks', async () => {
		const task = await store.create('Do not change');
		const uri = store.fileFor(task.id);
		const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

		await assert.rejects(
			() => store.edit(task.id, { title: '   ', request: '', refined: '', scope: '' }),
			/Task title cannot be blank/,
		);
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), before);

		await assert.rejects(
			() => store.edit(task.id, {
				title: 'x'.repeat(201),
				request: '',
				refined: '',
				scope: '',
			}),
			/200 characters or fewer/,
		);
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), before);

		await store.patch(task.id, { status: 'running', run: 'r-running' });
		const running = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		await assert.rejects(
			() => store.edit(task.id, { title: 'Rejected', request: '', refined: '', scope: '' }),
			/running and cannot be edited/,
		);
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), running);

		await assert.rejects(
			() => store.edit('TASK-999', { title: 'Missing', request: '', refined: '', scope: '' }),
			/was not found/,
		);
	});

	test('edit rejects a file whose frontmatter id does not match its filename', async () => {
		const task = await store.create('Mismatched task');
		const uri = store.fileFor(task.id);
		const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const mismatched = before.replace(`id: ${task.id}`, 'id: TASK-999');
		await vscode.workspace.fs.writeFile(uri, Buffer.from(mismatched, 'utf8'));

		await assert.rejects(
			() => store.edit(task.id, { title: 'Rejected', request: '', refined: '', scope: '' }),
			/invalid task file/,
		);
		assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), mismatched);
	});

	test('auditedPatch records actual state/status changes in stable order', async () => {
		const task = await store.create('Audit this transition');
		await store.auditedPatch(
			task.id,
			{ state: 'refine', status: 'running', run: 'r-audit' },
			{
				action: 'refine',
				now: new Date('2026-08-17T10:00:00Z'),
				events: [{ kind: 'activity-start', stage: 'refine', action: 'refine', runId: 'r-audit' }],
			},
		);

		const after = (await store.readAll()).tasks[0];
		assert.deepStrictEqual(
			parseAuditEvents(after.sections['Log']).map((event) => event.kind),
			['state-change', 'status-change', 'activity-start'],
		);
		assert.strictEqual(parseAuditEvents(after.sections['Log'])[0].from, 'backlog');
		assert.strictEqual(parseAuditEvents(after.sections['Log'])[1].to, 'running');
	});

	test('auditedPatch filters no-op transitions and de-duplicates lifecycle events', async () => {
		const task = await store.create('Audit idempotency');
		const now = new Date('2026-08-17T10:00:00Z');
		const start = { kind: 'activity-start' as const, stage: 'refine' as const, action: 'refine', runId: 'r1' };
		await store.auditedPatch(task.id, { state: 'backlog', status: 'idle' }, { action: 'noop', now });
		await store.auditedPatch(task.id, { state: 'refine', status: 'running', run: 'r1' }, { action: 'refine', now, events: [start] });
		await store.auditedPatch(
			task.id,
			{ status: 'blocked', run: undefined },
			{
				action: 'missing-receipt',
				now,
				events: [{
					kind: 'activity-finish',
					stage: 'refine',
					runId: 'r1',
					outcome: 'missing-receipt',
					provisional: true,
				}],
			},
		);
		await store.auditedPatch(
			task.id,
			{ status: 'blocked' },
			{
				action: 'missing-receipt',
				now: new Date('2026-08-17T10:00:01Z'),
				events: [{
					kind: 'activity-finish',
					stage: 'refine',
					runId: 'r1',
					outcome: 'missing-receipt',
					provisional: true,
				}],
			},
		);

		const events = parseAuditEvents((await store.readAll()).tasks[0].sections['Log']);
		assert.deepStrictEqual(events.map((event) => event.kind), ['state-change', 'status-change', 'activity-start', 'status-change', 'activity-finish']);
		assert.strictEqual(events.filter((event) => event.kind === 'activity-start').length, 1);
		assert.strictEqual(events.filter((event) => event.kind === 'activity-finish').length, 1);
	});

	test('audit lines interleave with receipts and proposals without changing receipt parsing', async () => {
		const task = await store.create('Preserve receipt grammar');
		await store.appendLog(task.id, formatReceipt({ runId: 'r1', taskId: task.id, stage: 'refine', result: 'ok', note: 'done' }));
		await store.auditedPatch(task.id, { state: 'refine' }, { action: 'accept' });
		await store.appendLog(task.id, `- propose-task run:r1 title:"Follow-up" note:"found"`);
		await store.appendLog(task.id, formatReceipt({ runId: 'r2', taskId: task.id, stage: 'develop', result: 'blocked', note: 'needs review' }));

		const log = (await store.readAll()).tasks[0].sections['Log'];
		assert.strictEqual(parseReceipts(log).length, 2);
		assert.strictEqual(parseAuditEvents(log).length, 1);
		assert.ok(log.includes('propose-task'));
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
			origin: { taskId: filer.id, runId: 'r19', note: 'Discovered while implementing.', proposalKey: 'key-r19' },
		});

		assert.strictEqual(filed.state, 'backlog');
		assert.strictEqual(filed.originTask, filer.id);
		assert.strictEqual(filed.originRunId, 'r19');
		assert.strictEqual(filed.originProposalKey, 'key-r19');
		assert.strictEqual(filed.setId, store.setId);
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

suite('task sets', () => {
	let root: vscode.Uri;
	let folder: vscode.WorkspaceFolder;

	setup(() => {
		root = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-sets-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		folder = { uri: root, name: 'task-set-test', index: 0 };
	});

	teardown(async () => {
		try {
			await vscode.workspace.fs.delete(root, { recursive: true });
		} catch {
			/* already gone */
		}
	});

	test('legacy tasksDir is the durable immutable Default set', async () => {
		const legacy = new TaskStore(vscode.Uri.joinPath(root, 'legacy', 'tasks'));
		await legacy.ensureDirectory();
		const task = await legacy.create('Existing task');

		const registry = new TaskSetRegistry(folder, 'legacy/tasks');
		const active = await registry.active();

		assert.strictEqual(registry.registryFile.fsPath, path.join(root.fsPath, '.kanban-pilot', 'task-sets.json'));
		assert.strictEqual(active.id, DEFAULT_TASK_SET_ID);
		assert.strictEqual(active.name, 'Default');
		assert.strictEqual(active.directory.toString(), legacy.directory.toString());
		assert.strictEqual((await legacy.readAll()).tasks[0].id, task.id);
		await assert.rejects(() => registry.rename(DEFAULT_TASK_SET_ID, 'Renamed'), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'default-set',
		);
	});

	test('create, select, rename, and reload preserve independent sets', async () => {
		const registry = new TaskSetRegistry(folder, 'legacy/tasks');
		const created = await registry.create('Mobile release');
		assert.strictEqual((await registry.active()).id, created.id);

		const setStore = new TaskStore(created.directory, created.id);
		await setStore.ensureDirectory();
		const task = await setStore.create('Only in mobile release');
		assert.strictEqual(task.id, 'TASK-001');
		assert.strictEqual(task.setId, created.id);

		await assert.rejects(() => registry.create(' mobile   release '), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'duplicate-name',
		);
		await assert.rejects(() => registry.create('   '), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'invalid-name',
		);

		await registry.rename(created.id, 'Mobile v2');
		await registry.select(DEFAULT_TASK_SET_ID);
		const reloaded = new TaskSetRegistry(folder, 'legacy/tasks');
		assert.strictEqual((await reloaded.active()).id, DEFAULT_TASK_SET_ID);
		assert.strictEqual((await reloaded.get(created.id)).name, 'Mobile v2');
		assert.strictEqual((await new TaskStore(created.directory, created.id).readAll()).tasks[0].id, task.id);
	});

	test('deletion refuses non-empty and Default sets, then removes an empty set safely', async () => {
		const registry = new TaskSetRegistry(folder, 'legacy/tasks');
		const created = await registry.create('Temporary');
		const setStore = new TaskStore(created.directory, created.id);
		await setStore.ensureDirectory();
		const task = await setStore.create('Keep me');

		await assert.rejects(() => registry.delete(created.id), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'not-empty',
		);
		assert.strictEqual((await setStore.readAll()).tasks[0].id, task.id);
		await assert.rejects(() => registry.delete(DEFAULT_TASK_SET_ID), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'default-set',
		);

		await vscode.workspace.fs.delete(setStore.fileFor(task.id));
		await registry.delete(created.id);
		await assert.rejects(() => registry.get(created.id), (error: unknown) =>
			error instanceof TaskSetError && error.code === 'not-found',
		);
		assert.strictEqual((await registry.active()).id, DEFAULT_TASK_SET_ID);
	});

	test('same task ids remain isolated by store identity and chat session identity', async () => {
		const first = new TaskStore(vscode.Uri.joinPath(root, 'one'), 'set-one');
		const second = new TaskStore(vscode.Uri.joinPath(root, 'two'), 'set-two');
		await first.ensureDirectory();
		await second.ensureDirectory();
		const firstTask = await first.create('First');
		await first.create('First second');
		const secondTask = await second.create('Second');
		await second.create('Second second');

		assert.strictEqual(firstTask.id, secondTask.id);
		assert.strictEqual(firstTask.setId, 'set-one');
		assert.strictEqual(secondTask.setId, 'set-two');
		assert.notStrictEqual(sessionIdForTask(firstTask.id, 'kanban-pilot-', first.setId), sessionIdForTask(secondTask.id, 'kanban-pilot-', second.setId));
		assert.strictEqual(sessionIdForTask('TASK-001'), 'kanban-pilot-TASK-001', 'Default sessions stay backward compatible');
		assert.deepStrictEqual(await first.reorder('TASK-002', 'backlog', { beforeTaskId: 'TASK-001' }), { kind: 'applied' });
		assert.deepStrictEqual((await first.snapshot()).columns[0].tasks.map((task) => task.id), ['TASK-002', 'TASK-001']);
		assert.deepStrictEqual((await second.snapshot()).columns[0].tasks.map((task) => task.id), ['TASK-001', 'TASK-002']);
	});

	test('same task ids keep attachment directories isolated across named sets', async () => {
		const first = new TaskStore(vscode.Uri.joinPath(root, 'one'), 'set-one');
		const second = new TaskStore(vscode.Uri.joinPath(root, 'two'), 'set-two');
		await first.ensureDirectory();
		await second.ensureDirectory();
		const firstTask = await first.create('First evidence', {
			attachments: { add: [{ name: 'first.png', mimeType: 'image/png', data: PNG }] },
		});
		const secondTask = await second.create('Second evidence', {
			attachments: { add: [{ name: 'second.png', mimeType: 'image/png', data: PNG }] },
		});

		assert.strictEqual(firstTask.id, secondTask.id);
		assert.deepStrictEqual((await first.listAttachments(firstTask.id)).map((attachment) => attachment.relativePath), [
			taskAttachmentReference(firstTask.id, 'first.png'),
		]);
		assert.deepStrictEqual((await second.listAttachments(secondTask.id)).map((attachment) => attachment.relativePath), [
			taskAttachmentReference(secondTask.id, 'second.png'),
		]);
		await assert.rejects(async () => { await vscode.workspace.fs.stat(first.attachmentFileFor(firstTask.id, taskAttachmentReference(firstTask.id, 'second.png'))); });
		await assert.rejects(async () => { await vscode.workspace.fs.stat(second.attachmentFileFor(secondTask.id, taskAttachmentReference(secondTask.id, 'first.png'))); });
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
