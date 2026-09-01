import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
	MAX_SPOOL_BYTES,
	SPOOL_SCHEMA_VERSION,
	appendSpoolLine,
	spoolLineFor,
	taskIdFromPrompt,
} from './kanban-pilot-hook.mjs';

const SECRET = 'SECRET-TOOL-INPUT';

async function withDirectory(callback) {
	const dir = await mkdtemp(join(tmpdir(), 'kanban-pilot-hook-'));
	try {
		return await callback(dir);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test('the task id is parsed from the prompt marker every stage prompt opens with', () => {
	assert.equal(taskIdFromPrompt('## [kanban-pilot TASK-042]\n\nDo the thing'), 'TASK-042');
	assert.equal(taskIdFromPrompt('preamble\n## [my project TASK-007]\nbody'), 'TASK-007');
	assert.equal(taskIdFromPrompt('no marker here'), undefined);
	assert.equal(taskIdFromPrompt(undefined), undefined);
});

test('a prompt submission carries the task id, which is what makes a first run attributable', () => {
	const line = spoolLineFor({
		hook_event_name: 'UserPromptSubmit',
		session_id: 's1',
		timestamp: '2026-09-01T10:00:00Z',
		prompt: '## [kanban-pilot TASK-009]\nrefine it',
	});
	assert.equal(line.event, 'UserPromptSubmit');
	assert.equal(line.taskId, 'TASK-009');
	assert.equal(line.sessionId, 's1');
	assert.equal(line.v, SPOOL_SCHEMA_VERSION);
});

test('a tool event keeps the tool name and nothing else from the payload', () => {
	const line = spoolLineFor({
		hook_event_name: 'PostToolUse',
		session_id: 's1',
		timestamp: '2026-09-01T10:00:01Z',
		tool_name: 'readFile',
		tool_input: { path: '/etc/passwd', contents: SECRET },
		tool_response: SECRET,
	});
	assert.equal(line.toolName, 'readFile');
	const serialised = JSON.stringify(line);
	assert.equal(serialised.includes(SECRET), false);
	assert.equal(serialised.includes('/etc/passwd'), false);
});

test('the prompt itself is never copied, only the marker it contains', () => {
	const line = spoolLineFor({
		hook_event_name: 'UserPromptSubmit',
		session_id: 's1',
		timestamp: '2026-09-01T10:00:00Z',
		prompt: `## [kanban-pilot TASK-001]\n${SECRET}`,
	});
	assert.equal(JSON.stringify(line).includes(SECRET), false);
});

test('an unusable payload produces no line rather than a placeholder', () => {
	assert.equal(spoolLineFor(undefined), undefined);
	assert.equal(spoolLineFor({}), undefined);
	assert.equal(spoolLineFor('nope'), undefined);
});

test('a missing timestamp falls back to now rather than dropping the event', () => {
	const line = spoolLineFor({ hook_event_name: 'Stop', session_id: 's1' });
	assert.equal(line.event, 'Stop');
	assert.ok(Number.isFinite(Date.parse(line.at)));
});

test('appending never throws, and refuses to grow the spool without bound', async () => {
	await withDirectory(async (dir) => {
		const path = join(dir, 'spool.jsonl');
		assert.equal(await appendSpoolLine(path, { v: 1, event: 'Stop', at: 'now' }), true);
		const written = await readFile(path, 'utf8');
		assert.equal(written.trim().split('\n').length, 1);

		await writeFile(path, 'x'.repeat(MAX_SPOOL_BYTES + 1), 'utf8');
		assert.equal(
			await appendSpoolLine(path, { v: 1, event: 'Stop', at: 'now' }),
			false,
			'an undrained spool stops growing rather than filling the disk',
		);

		// An unwritable destination is reported, never thrown: a reporting hook
		// must not be able to fail the tool call it is reporting on.
		assert.equal(await appendSpoolLine(join(dir, 'no-such-dir', 'spool.jsonl'), { v: 1 }), false);
	});
});
