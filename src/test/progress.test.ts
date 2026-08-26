import * as assert from 'assert';

import { formatProgressLine, parseProgressEntries, ProgressEntry } from '../chat/progress';
import { findReceipt, parseReceipts } from '../chat/receipt';
import { parseAuditEvents } from '../model/taskLog';

suite('progress-line grammar', () => {
	const AT = '2026-08-26T04:31:07Z';

	test('parses a well-formed progress line into an entry', () => {
		const log = `- progress run:rhufgz6 task:TASK-003 at:${AT} note:"editing the parser"`;
		assert.deepStrictEqual(parseProgressEntries(log, 'TASK-003'), [
			{ runId: 'rhufgz6', taskId: 'TASK-003', at: AT, note: 'editing the parser' },
		]);
	});

	test('preserves file order and honours the caller task id', () => {
		const log = [
			`- progress run:r1 task:TASK-003 at:${AT} note:"first"`,
			`- progress run:r1 task:TASK-009 at:${AT} note:"other task"`,
			`- progress run:r1 task:TASK-003 at:2026-08-26T04:32:00Z note:"second"`,
		].join('\n');
		assert.deepStrictEqual(
			parseProgressEntries(log, 'TASK-003').map((entry) => entry.note),
			['first', 'second'],
		);
	});

	test('drops a malformed line', () => {
		const log = [
			'- progress run:r1 task:TASK-003 note:"missing at"',
			'- progress task:TASK-003 at:' + AT + ' note:"missing run"',
			'progress run:r1 task:TASK-003 at:' + AT + ' note:"missing leading dash"',
			`- progress run:r1 task:TASK-003 at:${AT} note:no quotes`,
		].join('\n');
		assert.deepStrictEqual(parseProgressEntries(log, 'TASK-003'), []);
	});

	test('drops a line whose task id mismatches the file', () => {
		const log = `- progress run:r1 task:TASK-999 at:${AT} note:"wrong file"`;
		assert.deepStrictEqual(parseProgressEntries(log, 'TASK-003'), []);
	});

	test('drops a line with a non-UTC or impossible at: timestamp', () => {
		const log = [
			'- progress run:r1 task:TASK-003 at:2026-08-26 note:"date only"',
			'- progress run:r1 task:TASK-003 at:2026-08-26T04:31:07.123Z note:"has millis"',
			'- progress run:r1 task:TASK-003 at:2026-13-40T99:99:99Z note:"impossible"',
			'- progress run:r1 task:TASK-003 at:2026-08-26T04:31:07+02:00 note:"offset"',
		].join('\n');
		assert.deepStrictEqual(parseProgressEntries(log, 'TASK-003'), []);
	});

	test('formatProgressLine round-trips through the parser', () => {
		const entry: ProgressEntry = { runId: 'r1', taskId: 'TASK-003', at: AT, note: 'running tests' };
		assert.deepStrictEqual(parseProgressEntries(formatProgressLine(entry), 'TASK-003'), [entry]);
	});

	test('a progress line is not a receipt and not an audit event', () => {
		const log = `- progress run:rhufgz6 task:TASK-003 at:${AT} note:"waiting for approval in VS Code"`;
		assert.strictEqual(findReceipt(log, 'rhufgz6', 'TASK-003'), undefined);
		assert.deepStrictEqual(parseReceipts(log), []);
		assert.deepStrictEqual(parseAuditEvents(log), []);
	});

	test('a receipt line is not a progress entry', () => {
		const log = '- run:rhufgz6 task:TASK-003 stage:develop result:ok note:"done"';
		assert.deepStrictEqual(parseProgressEntries(log, 'TASK-003'), []);
	});
});
