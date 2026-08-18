import * as assert from 'assert';

import {
	auditLifecycleKey,
	formatAuditEvent,
	normaliseAuditEvent,
	parseAuditEvents,
	utcTimestamp,
} from '../model/taskLog';

suite('task audit log', () => {
	test('formats and parses each extension-owned event kind', () => {
		const events = [
			normaliseAuditEvent(
				{ kind: 'state-change', from: 'backlog', to: 'refine', action: 'accept' },
				'TASK-001',
				new Date('2026-08-17T10:00:01.999Z'),
			),
			normaliseAuditEvent(
				{ kind: 'status-change', from: 'idle', to: 'running', action: 'refine' },
				'TASK-001',
				new Date('2026-08-17T10:00:02Z'),
			),
			normaliseAuditEvent(
				{ kind: 'activity-start', stage: 'refine', action: 'refine', runId: 'r1' },
				'TASK-001',
				new Date('2026-08-17T10:00:03Z'),
			),
			normaliseAuditEvent(
				{
					kind: 'activity-finish',
					stage: 'refine',
					runId: 'r1',
					outcome: 'ok',
					note: 'receipt complete',
				},
				'TASK-001',
				new Date('2026-08-17T10:00:04Z'),
			),
		];

		const log = events.map(formatAuditEvent).join('\n');
		assert.deepStrictEqual(parseAuditEvents(log), events);
		assert.ok(log.includes('at:2026-08-17T10:00:01Z'));
		assert.ok(log.includes('audit:activity-finish'));
	});

	test('uses UTC second precision and sanitizes structural note characters', () => {
		assert.strictEqual(utcTimestamp(new Date('2026-08-17T10:00:01.999Z')), '2026-08-17T10:00:01Z');
		const event = normaliseAuditEvent(
			{
				kind: 'activity-finish',
				stage: 'develop',
				runId: 'r2',
				outcome: 'error',
				note: 'line one\nline "two"',
			},
			'TASK-002',
			new Date('2026-08-17T10:00:05Z'),
		);
		const line = formatAuditEvent(event);

		assert.strictEqual(line.split('\n').length, 1);
		assert.ok(!line.includes('"two"'));
		assert.deepStrictEqual(parseAuditEvents(line)[0], {
			...event,
			note: "line one line 'two'",
		});
	});

	test('accepts valid second-precision timestamp strings and rejects impossible dates', () => {
		const event = normaliseAuditEvent(
			{
				kind: 'state-change',
				at: '2026-08-17T10:00:01Z',
				from: 'backlog',
				to: 'refine',
				action: 'accept',
			},
			'TASK-004',
		);
		assert.strictEqual(event.at, '2026-08-17T10:00:01Z');

		assert.throws(
			() => normaliseAuditEvent(
				{
					kind: 'state-change',
					at: '2026-02-30T10:00:01Z',
					from: 'backlog',
					to: 'refine',
					action: 'accept',
				},
				'TASK-004',
			),
			/Audit timestamp/,
		);
	});

	test('ignores receipts and malformed audit lines', () => {
		const log = [
			'- run:r1 task:TASK-001 stage:refine result:ok note:"done"',
			'- audit:status-change at:bad task:TASK-001 from:idle to:running action:refine note:"bad"',
			'- audit:state-change at:2026-08-17T10:00:01Z task:TASK-001 from:backlog to:refine action:accept note:"good"',
		].join('\n');
		assert.strictEqual(parseAuditEvents(log).length, 1);
	});

	test('lifecycle keys are stable across timestamp changes', () => {
		const first = normaliseAuditEvent(
			{ kind: 'activity-start', stage: 'validate', action: 'validate', runId: 'r3' },
			'TASK-003',
			new Date('2026-08-17T10:00:01Z'),
		);
		const second = normaliseAuditEvent(
			{ kind: 'activity-start', stage: 'validate', action: 'validate', runId: 'r3' },
			'TASK-003',
			new Date('2026-08-17T10:00:02Z'),
		);
		assert.strictEqual(auditLifecycleKey(first), auditLifecycleKey(second));
	});
});
