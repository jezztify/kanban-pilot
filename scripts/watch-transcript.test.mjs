import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	FileTail,
	createWatcher,
	median,
	projectEntry,
	summarise,
} from './watch-transcript.mjs';

/** A transcript line shaped like the ones Copilot writes, content included. */
function line(type, timestamp, data = { content: 'SECRET-PAYLOAD', arguments: { path: '/etc/passwd' } }) {
	return `${JSON.stringify({ type, data, id: 'e1', timestamp, parentId: null })}\n`;
}

async function withDirectory(callback) {
	const directory = await mkdtemp(join(tmpdir(), 'kanban-pilot-transcript-'));
	try {
		return await callback(directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('an entry is reduced to structure, and the lag is measured against its own timestamp', () => {
	const observedAt = Date.parse('2026-09-01T10:00:04.500Z');
	const observation = projectEntry(
		'session.jsonl',
		JSON.parse(line('assistant.message', '2026-09-01T10:00:00.000Z').trim()),
		observedAt,
	);

	assert.equal(observation.type, 'assistant.message');
	assert.equal(observation.timestamp, '2026-09-01T10:00:00.000Z');
	assert.equal(observation.lagMs, 4500);
	assert.equal(Object.hasOwn(observation, 'data'), false);
});

test('an entry with no usable timestamp reports no lag rather than a bogus one', () => {
	const observation = projectEntry('session.jsonl', { type: 'user.message' }, Date.now());
	assert.equal(observation.lagMs, undefined);
	assert.equal(observation.timestamp, undefined);
});

test('a trailing fragment is held back and counted, then completed on the next read', () => {
	const tail = new FileTail('session.jsonl');
	const complete = line('assistant.turn_start', '2026-09-01T10:00:00.000Z');
	const split = line('assistant.message', '2026-09-01T10:00:01.000Z');
	const cut = Math.floor(split.length / 2);

	const first = tail.consume(complete + split.slice(0, cut), Date.now());
	assert.equal(first.length, 1, 'only the complete line is emitted');
	assert.equal(tail.fragmentsObserved, 1);
	assert.equal(tail.fragmentsCompleted, 0);

	const second = tail.consume(split.slice(cut), Date.now());
	assert.equal(second.length, 1, 'the fragment is emitted once it completes');
	assert.equal(second[0].type, 'assistant.message');
	assert.equal(tail.fragmentsCompleted, 1);
});

test('an unparseable complete line is counted rather than thrown', () => {
	const tail = new FileTail('session.jsonl');
	const entries = tail.consume(`{not json}\n${line('session.start', '2026-09-01T10:00:00.000Z')}`, Date.now());

	assert.equal(entries.length, 1);
	assert.equal(tail.malformed, 1);
});

test('median handles odd, even, and empty samples', () => {
	assert.equal(median([5, 1, 3]), 3);
	assert.equal(median([4, 1, 3, 2]), 2.5);
	assert.equal(median([]), undefined);
});

test('the summary reports per-type counts and a lag distribution', () => {
	const observations = [
		{ file: 'a.jsonl', type: 'assistant.message', timestamp: '2026-09-01T10:00:00.000Z', lagMs: 100 },
		{ file: 'a.jsonl', type: 'assistant.message', timestamp: '2026-09-01T10:00:01.000Z', lagMs: 300 },
		{ file: 'a.jsonl', type: 'tool.execution_start', timestamp: '2026-09-01T10:00:02.000Z', lagMs: 200 },
	];
	const summary = summarise(observations, [new FileTail('a.jsonl')]);

	assert.equal(summary.entries, 3);
	assert.deepEqual(summary.countsByType, { 'assistant.message': 2, 'tool.execution_start': 1 });
	assert.deepEqual(summary.lagMs, { samples: 3, min: 100, median: 200, max: 300 });
	assert.equal(summary.firstEntryAt, '2026-09-01T10:00:00.000Z');
	assert.equal(summary.lastEntryAt, '2026-09-01T10:00:02.000Z');
	assert.deepEqual(summary.filesGrown, ['a.jsonl']);
});

test('no message content reaches the summary that gets pasted into the findings document', async () => {
	await withDirectory(async (directory) => {
		const file = join(directory, 'session-1.jsonl');
		await writeFile(file, '', 'utf8');

		const watcher = createWatcher(directory, { intervalMs: 5_000 });
		await watcher.start();
		await appendFile(file, line('user.message', '2026-09-01T10:00:00.000Z'), 'utf8');
		await appendFile(file, line('tool.execution_complete', '2026-09-01T10:00:01.000Z'), 'utf8');
		const summary = await watcher.stop();

		const serialised = JSON.stringify({ summary, observations: watcher.observations });
		assert.equal(serialised.includes('SECRET-PAYLOAD'), false);
		assert.equal(serialised.includes('/etc/passwd'), false);
		assert.equal(serialised.includes('"data"'), false);
		assert.equal(summary.entries, 2);
	});
});

test('a file that already existed is joined at its end, so only new appends are measured', async () => {
	await withDirectory(async (directory) => {
		const file = join(directory, 'existing.jsonl');
		await writeFile(file, line('session.start', '2026-09-01T09:00:00.000Z'), 'utf8');

		const watcher = createWatcher(directory, { intervalMs: 5_000 });
		await watcher.start();
		await appendFile(file, line('assistant.turn_start', '2026-09-01T10:00:00.000Z'), 'utf8');
		const summary = await watcher.stop();

		assert.equal(summary.entries, 1, 'the pre-existing line is not counted');
		assert.deepEqual(summary.countsByType, { 'assistant.turn_start': 1 });
	});
});

test('a session starting under observation is read from its first byte', async () => {
	await withDirectory(async (directory) => {
		const watcher = createWatcher(directory, { intervalMs: 5_000 });
		await watcher.start();

		// The whole file appears between polls, exactly as a new session's does.
		await writeFile(
			join(directory, 'new-session.jsonl'),
			line('session.start', '2026-09-01T10:00:00.000Z') + line('user.message', '2026-09-01T10:00:01.000Z'),
			'utf8',
		);
		const summary = await watcher.stop();

		assert.equal(summary.entries, 2, 'session.start is not lost to the poll that discovers the file');
		assert.deepEqual(summary.filesGrown, ['new-session.jsonl']);
	});
});

test('watching filters to one session when asked', async () => {
	await withDirectory(async (directory) => {
		const watcher = createWatcher(directory, { sessionId: 'wanted', intervalMs: 5_000 });
		await watcher.start();

		await writeFile(join(directory, 'wanted.jsonl'), line('session.start', '2026-09-01T10:00:00.000Z'), 'utf8');
		await writeFile(join(directory, 'other.jsonl'), line('session.start', '2026-09-01T10:00:00.000Z'), 'utf8');
		const summary = await watcher.stop();

		assert.deepEqual(summary.filesGrown, ['wanted.jsonl']);
	});
});

test('a missing directory is a state to wait in, not a crash', async () => {
	const watcher = createWatcher(join(tmpdir(), 'kanban-pilot-no-such-transcripts-dir'), { intervalMs: 5_000 });
	await watcher.start();
	const summary = await watcher.stop();

	assert.equal(summary.entries, 0);
	assert.deepEqual(summary.filesGrown, []);
});
