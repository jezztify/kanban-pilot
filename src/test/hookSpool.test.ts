import * as assert from 'assert';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	HookSpoolReceiver,
	SPOOL_SCHEMA_VERSION,
	describeSpoolLine,
	isHookCoveredTranscriptType,
	parseSpoolLine,
	suppressDuplicatedTailEntries,
} from '../chat/hookSpool';
import type { FeedEntry } from '../chat/transcriptTail';

/** Content a hook must never copy into the spool. */
const SECRET = 'SECRET-TOOL-INPUT';

function spoolLine(fields: Record<string, unknown>): string {
	return `${JSON.stringify({ v: SPOOL_SCHEMA_VERSION, ...fields })}\n`;
}

async function withSpool(callback: (path: string) => Promise<void>): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), 'kanban-pilot-spool-'));
	try {
		await callback(join(dir, '.hook-spool.jsonl'));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

suite('Hook spool receiver', () => {
	test('a line from a different schema version is dropped rather than guessed at', () => {
		assert.ok(parseSpoolLine(spoolLine({ event: 'Stop', at: '2026-09-01T10:00:00Z' }).trim()));
		assert.strictEqual(
			parseSpoolLine(JSON.stringify({ v: 99, event: 'Stop', at: '2026-09-01T10:00:00Z' })),
			undefined,
		);
		assert.strictEqual(parseSpoolLine('{not json}'), undefined);
		assert.strictEqual(parseSpoolLine(JSON.stringify({ v: 1, event: 'Stop' })), undefined);
	});

	test('notes describe the event without quoting content', () => {
		assert.strictEqual(
			describeSpoolLine({ v: 1, event: 'PostToolUse', at: 'x', toolName: 'runTests' }),
			'finished runTests',
		);
		assert.strictEqual(describeSpoolLine({ v: 1, event: 'UserPromptSubmit', at: 'x' }), 'prompt submitted');
		assert.strictEqual(describeSpoolLine({ v: 1, event: 'Future.Event', at: 'x' }), 'Future.Event');
	});

	test('a first run is attributable through the prompt marker, before copilot_session_id exists', () => {
		const receiver = new HookSpoolReceiver('unused');
		receiver.ingest(
			spoolLine({ event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-042' })
			+ spoolLine({ event: 'PostToolUse', at: '2026-09-01T10:00:01Z', sessionId: 's1', toolName: 'readFile' }),
		);

		const entries = receiver.entriesFor('TASK-042');
		assert.deepStrictEqual(entries.map((entry) => entry.note), ['prompt submitted', 'finished readFile']);
		assert.strictEqual(entries[0].source, 'hook');
		receiver.dispose();
	});

	test('events from a session with no prompt marker are not ours and are ignored', () => {
		const receiver = new HookSpoolReceiver('unused');
		receiver.ingest(spoolLine({ event: 'PostToolUse', at: '2026-09-01T10:00:00Z', sessionId: 'other', toolName: 'x' }));
		assert.deepStrictEqual(receiver.entriesFor('TASK-042'), []);
		receiver.dispose();
	});

	test('a partial trailing line is held until it completes', () => {
		const receiver = new HookSpoolReceiver('unused');
		const first = spoolLine({ event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-001' });
		const second = spoolLine({ event: 'Stop', at: '2026-09-01T10:00:05Z', sessionId: 's1' });
		const cut = Math.floor(second.length / 2);

		receiver.ingest(first + second.slice(0, cut));
		assert.strictEqual(receiver.entriesFor('TASK-001').length, 1);

		receiver.ingest(second.slice(cut));
		assert.deepStrictEqual(
			receiver.entriesFor('TASK-001').map((entry) => entry.note),
			['prompt submitted', 'turn finished'],
		);
		receiver.dispose();
	});

	test('arriving entries raise a change so the board and browser republish', () => {
		const receiver = new HookSpoolReceiver('unused');
		const seen: string[] = [];
		receiver.onDidChange((taskId) => seen.push(taskId));

		receiver.ingest(spoolLine({ event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-007' }));
		assert.deepStrictEqual(seen, ['TASK-007'], 'a spool write touches no task file, so this is the only signal');
		receiver.dispose();
	});

	test('the buffer stays bounded', () => {
		const receiver = new HookSpoolReceiver('unused', 5);
		receiver.ingest(spoolLine({ event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-002' }));
		for (let i = 0; i < 20; i += 1) {
			receiver.ingest(spoolLine({
				event: 'PostToolUse',
				at: `2026-09-01T10:01:${String(i).padStart(2, '0')}Z`,
				sessionId: 's1',
				toolName: `tool${i}`,
			}));
		}
		const entries = receiver.entriesFor('TASK-002');
		assert.strictEqual(entries.length, 5);
		assert.strictEqual(entries[entries.length - 1].note, 'finished tool19');
		receiver.dispose();
	});

	test('the tail is suppressed only while the hook feed is actually reporting', () => {
		const tailed: FeedEntry[] = [
			{ at: '2026-09-01T10:00:01Z', note: 'started readFile', source: 'transcript' },
			{ at: '2026-09-01T10:00:02Z', note: 'assistant replied', source: 'transcript' },
		];
		const hooks: FeedEntry[] = [{ at: '2026-09-01T10:00:01Z', note: 'finished readFile', source: 'hook' }];

		// With hooks live, the tool step is not shown twice — once now and again
		// up to 53 s later from the transcript.
		const deduped = suppressDuplicatedTailEntries(tailed, hooks);
		assert.deepStrictEqual(deduped.map((entry) => entry.note), ['assistant replied']);

		// With no hook entries the tail is the only source and must keep flowing.
		assert.strictEqual(suppressDuplicatedTailEntries(tailed, []).length, 2);
	});

	test('the covered transcript types are the ones the hook feed also reports', () => {
		assert.strictEqual(isHookCoveredTranscriptType('tool.execution_start'), true);
		assert.strictEqual(isHookCoveredTranscriptType('tool.execution_complete'), true);
		assert.strictEqual(isHookCoveredTranscriptType('assistant.message'), false);
	});

	test('draining reads only what was appended, and survives truncation', async () => {
		await withSpool(async (path) => {
			await writeFile(path, spoolLine({
				event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-003',
			}), 'utf8');

			const receiver = new HookSpoolReceiver(path);
			await receiver.drain();
			assert.strictEqual(receiver.entriesFor('TASK-003').length, 1);

			await appendFile(path, spoolLine({
				event: 'PostToolUse', at: '2026-09-01T10:00:01Z', sessionId: 's1', toolName: 'build',
			}), 'utf8');
			await receiver.drain();
			assert.strictEqual(receiver.entriesFor('TASK-003').length, 2);

			// A drained spool is truncated by the receiver's cleanup; reading must not
			// resume from a stale offset into the middle of a line.
			await writeFile(path, spoolLine({
				event: 'Stop', at: '2026-09-01T10:00:09Z', sessionId: 's1',
			}), 'utf8');
			await receiver.drain();
			assert.strictEqual(
				receiver.entriesFor('TASK-003').at(-1)?.note,
				'turn finished',
				'a shrunken spool restarts from the beginning',
			);
			receiver.dispose();
		});
	});

	test('a missing spool is quiet, and cleanup removes it', async () => {
		await withSpool(async (path) => {
			const receiver = new HookSpoolReceiver(path);
			await receiver.drain();
			assert.deepStrictEqual(receiver.entriesFor('TASK-004'), []);

			await writeFile(path, spoolLine({ event: 'Stop', at: '2026-09-01T10:00:00Z' }), 'utf8');
			await receiver.cleanup();
			await receiver.drain();
			assert.deepStrictEqual(receiver.entriesFor('TASK-004'), []);
			receiver.dispose();
		});
	});

	test('no tool input reaches the feed even when a malformed line carries it', () => {
		const receiver = new HookSpoolReceiver('unused');
		receiver.ingest(
			spoolLine({ event: 'UserPromptSubmit', at: '2026-09-01T10:00:00Z', sessionId: 's1', taskId: 'TASK-005' })
			+ spoolLine({
				event: 'PostToolUse',
				at: '2026-09-01T10:00:01Z',
				sessionId: 's1',
				toolName: 'runTests',
				tool_input: SECRET,
			}),
		);
		const serialised = JSON.stringify(receiver.entriesFor('TASK-005'));
		assert.strictEqual(serialised.includes(SECRET), false);
		receiver.dispose();
	});
});
