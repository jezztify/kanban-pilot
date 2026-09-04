import * as assert from 'assert';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

import {
	SUPPORTED_TRANSCRIPT_PRODUCER,
	SUPPORTED_TRANSCRIPT_VERSION,
	TranscriptLineReader,
	TranscriptTailService,
	carriesContent,
	describeTranscriptEntry,
	isSupportedTranscriptHeader,
	mergeFeedEntries,
	projectTranscriptEntry,
	readTranscriptHeader,
	toFeedEntries,
	transcriptFileFor,
	transcriptsDirectory,
} from '../chat/transcriptTail';

/** Content planted in every fixture so redaction can be asserted, not assumed. */
const SECRET = 'SECRET-CONTENT-DO-NOT-LEAK';

function header(): string {
	return `${JSON.stringify({
		type: 'session.start',
		data: {
			sessionId: 's1',
			version: SUPPORTED_TRANSCRIPT_VERSION,
			producer: SUPPORTED_TRANSCRIPT_PRODUCER,
			context: {},
		},
		id: 'e0',
		timestamp: '2026-09-01T10:00:00.000Z',
		parentId: null,
	})}\n`;
}

function line(type: string, timestamp: string, data: Record<string, unknown> = {}): string {
	return `${JSON.stringify({
		type,
		data: { content: SECRET, arguments: { path: '/etc/passwd' }, result: SECRET, ...data },
		id: `e-${timestamp}`,
		timestamp,
		parentId: null,
	})}\n`;
}

async function withTranscripts(
	callback: (dir: string, storageUri: vscode.Uri) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'kanban-pilot-tail-'));
	// Mirrors the real layout: <ws>/<publisher>.<name>/ is the extension's own
	// storageUri, and the transcripts live in a sibling directory.
	const storageUri = vscode.Uri.file(join(root, 'jezztify.kanban-pilot'));
	const dir = transcriptsDirectory(storageUri).fsPath;
	await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }));
	try {
		await callback(dir, storageUri);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

suite('Transcript tail', () => {
	test('paths are derived from the extension storage uri by path arithmetic', () => {
		const storageUri = vscode.Uri.file('/ws-storage/abc/jezztify.kanban-pilot');
		assert.ok(transcriptsDirectory(storageUri).path.endsWith(
			'/ws-storage/abc/GitHub.copilot-chat/transcripts',
		));
		assert.ok(transcriptFileFor(storageUri, 'sess-1').path.endsWith('/transcripts/sess-1.jsonl'));
	});

	test('the header gate accepts only the verified shape', () => {
		const good = JSON.parse(header().trim());
		assert.strictEqual(isSupportedTranscriptHeader(good), true);
		assert.strictEqual(isSupportedTranscriptHeader({ ...good, data: { ...good.data, version: 2 } }), false);
		assert.strictEqual(isSupportedTranscriptHeader({ ...good, data: { ...good.data, producer: 'other' } }), false);
		assert.strictEqual(isSupportedTranscriptHeader({ type: 'user.message' }), false);
		assert.strictEqual(isSupportedTranscriptHeader(undefined), false);
	});

	test('projection keeps structure and drops every content field', () => {
		const parsed = JSON.parse(line('tool.execution_start', '2026-09-01T10:00:01.000Z', { toolName: 'readFile' }).trim());
		const entry = projectTranscriptEntry(parsed);

		assert.ok(entry);
		assert.strictEqual(entry.type, 'tool.execution_start');
		assert.strictEqual(entry.at, '2026-09-01T10:00:01.000Z');
		assert.strictEqual(entry.toolName, 'readFile');
		// A tool invocation contributes only bounded structure: `arguments` and
		// `result` are the unbounded fields that carry file contents and credentials.
		assert.strictEqual('text' in entry, false);
		assert.strictEqual('target' in entry, false);
		assert.strictEqual(JSON.stringify(entry).includes(SECRET), false);
		assert.strictEqual(JSON.stringify(entry).includes('/etc/passwd'), false);
	});

	test('message, reasoning, and tool payloads become safe structural labels', () => {
		const entries = [
			projectTranscriptEntry(JSON.parse(line('user.message', '2026-09-01T10:00:04.000Z', {
				content: 'private prompt ' + SECRET,
			}).trim())),
			projectTranscriptEntry(JSON.parse(line('assistant.message', '2026-09-01T10:00:05.000Z', {
				content: 'private reply ' + SECRET,
				reasoningText: 'private reasoning ' + SECRET,
			}).trim())),
			projectTranscriptEntry(JSON.parse(line('tool.execution_start', '2026-09-01T10:00:06.000Z', {
				toolName: 'read_file',
				arguments: { filePath: 'C:\\private\\credentials.txt', command: SECRET },
			}).trim())),
		].filter((entry): entry is NonNullable<typeof entry> => !!entry);

		assert.deepStrictEqual(entries.map((entry) => describeTranscriptEntry(entry)), [
			'prompt submitted',
			'assistant message observed',
			'started read_file',
		]);
		const serialised = JSON.stringify(entries);
		assert.strictEqual(serialised.includes(SECRET), false);
		assert.strictEqual(serialised.includes('credentials.txt'), false);
		assert.strictEqual(serialised.includes('private prompt'), false);
	});

	test('a completion inherits the tool name from its matching start', () => {
		// `tool.execution_complete` carries only a toolCallId and success, so without
		// correlation every finish row reads "finished a tool".
		const reader = new TranscriptLineReader();
		const entries = reader.consume(
			line('tool.execution_start', '2026-09-01T10:00:10.000Z', {
				toolCallId: 'call_1',
				toolName: 'read_file',
				arguments: { filePath: 'src/chat/transcriptTail.ts' },
			})
			+ line('tool.execution_complete', '2026-09-01T10:00:11.000Z', { toolCallId: 'call_1', success: true }),
		);

		assert.strictEqual(entries.length, 2);
		assert.strictEqual(describeTranscriptEntry(entries[0]), 'started read_file');
		assert.strictEqual(describeTranscriptEntry(entries[1]), 'finished read_file');
	});

	test('a failed tool says so, and an uncorrelated completion still reads sensibly', () => {
		const reader = new TranscriptLineReader();
		const failed = reader.consume(
			line('tool.execution_start', '2026-09-01T10:00:12.000Z', { toolCallId: 'call_2', toolName: 'run_tests' })
			+ line('tool.execution_complete', '2026-09-01T10:00:13.000Z', { toolCallId: 'call_2', success: false }),
		);
		assert.strictEqual(describeTranscriptEntry(failed[1]), 'run_tests failed');

		// A completion whose start landed before the tail attached has no name to
		// inherit; it must still render rather than throw.
		const orphan = new TranscriptLineReader().consume(
			line('tool.execution_complete', '2026-09-01T10:00:14.000Z', { toolCallId: 'unknown', success: true }),
		);
		assert.strictEqual(describeTranscriptEntry(orphan[0]), 'finished a tool');
	});

	test('untrusted structural labels are rejected without exposing payload content', () => {
		const unsafe = projectTranscriptEntry(JSON.parse(line('tool.execution_start', '2026-09-01T10:00:20.000Z', {
			toolName: 'C:\\private\\credentials.txt',
			arguments: { filePath: 'C:\\private\\credentials.txt', command: SECRET },
		}).trim()));
		assert.ok(unsafe);
		assert.strictEqual(unsafe.toolName, undefined);
		assert.strictEqual(describeTranscriptEntry(unsafe!), 'started a tool');
		assert.strictEqual(JSON.stringify(unsafe).includes(SECRET), false);
		assert.strictEqual(JSON.stringify(unsafe).includes('credentials.txt'), false);
		assert.strictEqual(
			projectTranscriptEntry({
				type: 'future event with private ' + SECRET,
				timestamp: '2026-09-01T10:00:21.000Z',
			}),
			undefined,
		);
	});

	test('every structurally valid message produces a safe row', () => {
		const rows = toFeedEntries(
			[
				{ type: 'assistant.message', at: '2026-09-01T10:00:25.000Z' },
				{ type: 'user.message', at: '2026-09-01T10:00:26.000Z' },
				{ type: 'assistant.turn_end', at: '2026-09-01T10:00:27.000Z' },
			],
			20,
		);
		assert.deepStrictEqual(rows.map((row) => row.note), [
			'assistant message observed',
			'prompt submitted',
			'turn finished',
		]);
	});

	test('an assistant message with no text still describes itself', () => {
		assert.strictEqual(
			describeTranscriptEntry({ type: 'assistant.message', at: '2026-09-01T10:00:00.000Z' }),
			'assistant message observed',
		);
	});

	test('a line without a usable type or timestamp is dropped', () => {
		assert.strictEqual(projectTranscriptEntry({ type: 'user.message' }), undefined);
		assert.strictEqual(projectTranscriptEntry({ timestamp: '2026-09-01T10:00:00.000Z' }), undefined);
		assert.strictEqual(projectTranscriptEntry('not an object'), undefined);
	});

	test('the content-bearing event types are the ones a feed must not forward', () => {
		for (const type of ['user.message', 'assistant.message', 'tool.execution_start', 'tool.execution_complete']) {
			assert.strictEqual(carriesContent(type), true, type);
		}
		assert.strictEqual(carriesContent('assistant.turn_start'), false);
	});

	test('notes describe the event without quoting it', () => {
		assert.strictEqual(
			describeTranscriptEntry({ type: 'tool.execution_start', at: 'x', toolName: 'runTests' }),
			'started runTests',
		);
		assert.strictEqual(describeTranscriptEntry({ type: 'assistant.message', at: 'x' }), 'assistant message observed');
		// An unknown future event degrades to its own name rather than throwing.
		assert.strictEqual(describeTranscriptEntry({ type: 'future.event', at: 'x' }), 'future.event');
	});

	test('a partial trailing line is held until it completes', () => {
		const reader = new TranscriptLineReader();
		const whole = line('assistant.turn_start', '2026-09-01T10:00:02.000Z');
		const split = line('assistant.message', '2026-09-01T10:00:03.000Z');
		const cut = Math.floor(split.length / 2);

		const first = reader.consume(whole + split.slice(0, cut));
		assert.strictEqual(first.length, 1);

		const second = reader.consume(split.slice(cut));
		assert.strictEqual(second.length, 1);
		assert.strictEqual(second[0].type, 'assistant.message');
	});

	test('merging orders by instant, not by string, and keeps the bound', () => {
		// The tailed entry carries milliseconds and the progress line does not; a
		// lexicographic sort would put `…:00.500Z` before `…:00Z`.
		const merged = mergeFeedEntries(
			[{ at: '2026-09-01T10:00:01Z', note: 'wrote the module', source: 'progress' }],
			[{ at: '2026-09-01T10:00:00.500Z', note: 'started readFile', source: 'transcript' }],
			10,
		);
		assert.deepStrictEqual(merged.map((entry) => entry.source), ['transcript', 'progress']);

		const bounded = mergeFeedEntries(
			Array.from({ length: 30 }, (_, i) => ({
				at: `2026-09-01T10:00:${String(i).padStart(2, '0')}Z`,
				note: `n${i}`,
				source: 'progress' as const,
			})),
			[],
			20,
		);
		assert.strictEqual(bounded.length, 20);
		assert.strictEqual(bounded[bounded.length - 1].note, 'n29', 'the newest entries are kept');
	});

	test('feed rows are bounded and carry their source', () => {
		const rows = toFeedEntries(
			[
				{ type: 'assistant.turn_start', at: '2026-09-01T10:00:00.000Z' },
				{ type: 'assistant.turn_end', at: '2026-09-01T10:00:01.000Z' },
			],
			1,
		);
		assert.strictEqual(rows.length, 1);
		assert.strictEqual(rows[0].source, 'transcript');
		assert.strictEqual(rows[0].note, 'turn finished');
	});

	test('a known session is tailed from its end, and content never reaches the feed', async () => {
		await withTranscripts(async (dir, storageUri) => {
			const file = join(dir, 'sess-1.jsonl');
			await writeFile(file, header() + line('user.message', '2026-09-01T10:00:00.100Z'), 'utf8');

			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-001', { sessionId: 'sess-1', intervalMs: 60_000 });
			// Only what this run appends is wanted; the pre-existing lines are history.
			assert.deepStrictEqual(service.entriesFor('TASK-001'), []);

			await appendFile(file, line('tool.execution_start', '2026-09-01T10:00:02.000Z', { toolName: 'readFile' }), 'utf8');
			await service.start('TASK-001', { sessionId: 'sess-1', intervalMs: 60_000 }); // no-op, already tailing
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-001', 20);

			const entries = service.entriesFor('TASK-001');
			assert.strictEqual(entries.length, 1);
			assert.strictEqual(entries[0].note, 'started readFile');
			assert.match(entries[0].observedAt ?? '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
			const snapshot = service.snapshotFor('TASK-001');
			assert.strictEqual(snapshot.availability, 'configured');
			assert.strictEqual(snapshot.latestEventAt, '2026-09-01T10:00:02.000Z');
			assert.strictEqual(snapshot.latestObservedAt, entries[0].observedAt);
			// The tailed entry here is a tool invocation, so no payload rides along.
			assert.strictEqual(JSON.stringify(entries).includes(SECRET), false);
			assert.strictEqual(JSON.stringify(entries).includes('passwd'), false);
			service.dispose();
		});
	});

	test('a first run correlates by directory watch, reading the new file whole', async () => {
		await withTranscripts(async (dir, storageUri) => {
			await writeFile(join(dir, 'old.jsonl'), header(), 'utf8');

			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-002', { intervalMs: 60_000 });

			// The session's file appears after the run starts, exactly as a first run's does.
			await writeFile(
				join(dir, 'new.jsonl'),
				header() + line('assistant.turn_start', '2026-09-01T10:00:05.000Z'),
				'utf8',
			);
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-002', 20);

			const notes = service.entriesFor('TASK-002').map((entry) => entry.note);
			assert.ok(notes.includes('chat session started'), 'line 0 is not lost to the discovering poll');
			assert.ok(notes.includes('turn started'));
			service.dispose();
		});
	});

	test('an unsupported header yields no entries rather than a misparse', async () => {
		await withTranscripts(async (dir, storageUri) => {
			const bad = `${JSON.stringify({
				type: 'session.start',
				data: { version: 99, producer: 'something-else' },
				timestamp: '2026-09-01T10:00:00.000Z',
			})}\n`;
			await writeFile(join(dir, 'sess-2.jsonl'), bad + line('assistant.message', '2026-09-01T10:00:01.000Z'), 'utf8');

			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-003', { sessionId: 'sess-2', intervalMs: 60_000 });
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-003', 20);

			assert.deepStrictEqual(service.entriesFor('TASK-003'), []);
			assert.strictEqual(service.snapshotFor('TASK-003').availability, 'unreadable');
			service.dispose();
		});
	});

	test('a missing transcript, an evicted file, and no storage all degrade quietly', async () => {
		await withTranscripts(async (_dir, storageUri) => {
			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-004', { sessionId: 'no-such-session', intervalMs: 60_000 });
			assert.deepStrictEqual(service.entriesFor('TASK-004'), []);
			assert.strictEqual(service.snapshotFor('TASK-004').availability, 'missing');
			assert.strictEqual(await readTranscriptHeader(join(_dir, 'absent.jsonl')), false);
			service.dispose();
		});

		const unwired = new TranscriptTailService(undefined);
		await unwired.start('TASK-005', { sessionId: 'x' });
		assert.deepStrictEqual(unwired.entriesFor('TASK-005'), []);
		assert.strictEqual(unwired.snapshotFor('TASK-005').availability, 'not-configured');
		unwired.dispose();
	});

	test('forget drops a task entirely and stop leaves entries readable', async () => {
		await withTranscripts(async (dir, storageUri) => {
			const file = join(dir, 'sess-3.jsonl');
			await writeFile(file, header(), 'utf8');

			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-006', { sessionId: 'sess-3', intervalMs: 60_000 });
			await appendFile(file, line('assistant.turn_end', '2026-09-01T10:00:09.000Z'), 'utf8');
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-006', 20);

			service.stop('TASK-006');
			assert.strictEqual(service.entriesFor('TASK-006').length, 1, 'stopping keeps what was read');

			service.forget('TASK-006');
			assert.deepStrictEqual(service.entriesFor('TASK-006'), []);
			service.dispose();
		});
	});

	test('a truncated transcript restarts at its verified header instead of splitting or replaying old data', async () => {
		await withTranscripts(async (dir, storageUri) => {
			const file = join(dir, 'sess-4.jsonl');
			await writeFile(
				file,
				header() + line('assistant.turn_start', '2026-09-01T10:00:30.000Z') + line('assistant.turn_end', '2026-09-01T10:00:31.000Z'),
				'utf8',
			);

			const service = new TranscriptTailService(storageUri);
			await service.start('TASK-007', { sessionId: 'sess-4', intervalMs: 60_000 });
			await appendFile(file, line('assistant.turn_end', '2026-09-01T10:00:32.000Z'), 'utf8');
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-007', 20);
			assert.strictEqual(service.entriesFor('TASK-007').length, 1);

			await writeFile(file, header() + line('assistant.turn_start', '2026-09-01T10:00:40.000Z'), 'utf8');
			await (service as unknown as { poll(id: string, limit: number): Promise<void> }).poll('TASK-007', 20);
			const notes = service.entriesFor('TASK-007').map((entry) => entry.note);
			assert.deepStrictEqual(notes, ['chat session started', 'turn started']);
			service.dispose();
		});
	});
});
