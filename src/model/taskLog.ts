import type { Column, Status } from './task';

/** Extension-owned entries in a task's append-only ## Log audit trail. */
export const AUDIT_EVENT_KINDS = [
	'state-change',
	'status-change',
	'activity-start',
	'activity-finish',
] as const;
export type AuditEventKind = (typeof AUDIT_EVENT_KINDS)[number];

export type AuditStage = 'refine' | 'develop' | 'validate' | 'split';
export type AuditOutcome =
	| 'ok'
	| 'blocked'
	| 'failed'
	| 'timeout'
	| 'error'
	| 'missing-receipt'
	| 'stopped'
	| 'superseded';

export interface AuditEvent {
	kind: AuditEventKind;
	at: string;
	taskId: string;
	from?: string;
	to?: string;
	action?: string;
	stage?: AuditStage;
	runId?: string;
	outcome?: AuditOutcome;
	provisional?: boolean;
	correction?: boolean;
	note: string;
}

/** Input accepted by the task-store mutation API. */
export interface AuditEventInput {
	kind: AuditEventKind;
	taskId?: string;
	at?: string | Date;
	from?: string;
	to?: string;
	action?: string;
	stage?: AuditStage;
	runId?: string;
	outcome?: AuditOutcome;
	provisional?: boolean;
	correction?: boolean;
	note?: string;
}

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const TOKEN = /^[A-Za-z0-9._:/-]+$/;
const AUDIT_LINE =
	/^-\s*audit:(state-change|status-change|activity-start|activity-finish)\s+at:(\S+)\s+task:(\S+)(?:\s+from:(\S+)\s+to:(\S+))?(?:\s+stage:(\S+))?(?:\s+action:(\S+))?(?:\s+run:(\S+))?(?:\s+outcome:(\S+))?(?:\s+provisional:(true|false))?(?:\s+correction:(true|false))?\s+note:"([^"]*)"\s*$/;

function isUtcTimestamp(value: string): boolean {
	if (!UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
		return false;
	}
	try {
		// `toISOString()` includes milliseconds, while the audit grammar intentionally
		// stores second precision. Canonicalise through the same formatter used for
		// generated timestamps before comparing, which also rejects impossible dates
		// that the JavaScript date parser normalises.
		return utcTimestamp(new Date(value)) === value;
	} catch {
		return false;
	}
}

/** Formats a Date as the canonical second-precision UTC timestamp. */
export function utcTimestamp(now = new Date()): string {
	if (!Number.isFinite(now.getTime())) {
		throw new Error('Cannot format an invalid audit timestamp');
	}
	return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isToken(value: string): boolean {
	return TOKEN.test(value);
}

function requireToken(name: string, value: string | undefined): string {
	if (!value || !isToken(value)) {
		throw new Error(`Audit ${name} must be a non-empty single-line token`);
	}
	return value;
}

function cleanNote(note: string | undefined, fallback: string): string {
	const cleaned = (note ?? fallback)
		.replace(/[\r\n]+/g, ' ')
		.replace(/"/g, "'")
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned || fallback;
}

function timestampFrom(value: string | Date | undefined, fallback: string): string {
	if (value === undefined) {
		return fallback;
	}
	const timestamp = value instanceof Date ? utcTimestamp(value) : value;
	if (!isUtcTimestamp(timestamp)) {
		throw new Error(`Audit timestamp must be UTC ISO 8601 with second precision: ${timestamp}`);
	}
	return timestamp;
}

function defaultNote(input: AuditEventInput): string {
	switch (input.kind) {
		case 'state-change':
			return `State changed from ${input.from} to ${input.to} via ${input.action}.`;
		case 'status-change':
			return `Status changed from ${input.from} to ${input.to} via ${input.action}.`;
		case 'activity-start':
			return `Started ${input.stage} activity via ${input.action} (run ${input.runId}).`;
		case 'activity-finish':
			return `Finished ${input.stage} activity with outcome ${input.outcome} (run ${input.runId}).`;
	}
}

function validateEvent(event: AuditEvent): void {
	if (!isUtcTimestamp(event.at)) {
		throw new Error(`Audit timestamp must be UTC ISO 8601 with second precision: ${event.at}`);
	}
	requireToken('task id', event.taskId);

	switch (event.kind) {
		case 'state-change':
		case 'status-change':
			requireToken('from value', event.from);
			requireToken('to value', event.to);
			requireToken('action', event.action);
			break;
		case 'activity-start':
			requireToken('stage', event.stage);
			requireToken('action', event.action);
			requireToken('run id', event.runId);
			break;
		case 'activity-finish':
			requireToken('stage', event.stage);
			requireToken('run id', event.runId);
			requireToken('outcome', event.outcome);
			if (event.action !== undefined) {
				requireToken('action', event.action);
			}
			break;
	}
}

/** Applies defaults and validates an event before it is written. */
export function normaliseAuditEvent(input: AuditEventInput, taskId: string, now = new Date()): AuditEvent {
	const timestamp = timestampFrom(input.at, utcTimestamp(now));
	const event: AuditEvent = {
		kind: input.kind,
		at: timestamp,
		taskId: input.taskId ?? taskId,
		from: input.from,
		to: input.to,
		action: input.action,
		stage: input.stage,
		runId: input.runId,
		outcome: input.outcome,
		provisional: input.provisional,
		correction: input.correction,
		note: cleanNote(input.note, defaultNote(input)),
	};
	validateEvent(event);
	return event;
}

/** Renders one parser-compatible, human-readable audit line. */
export function formatAuditEvent(event: AuditEvent): string {
	validateEvent(event);
	const fields = [`- audit:${event.kind}`, `at:${event.at}`, `task:${event.taskId}`];

	if (event.kind === 'state-change' || event.kind === 'status-change') {
		fields.push(`from:${event.from}`, `to:${event.to}`, `action:${event.action}`);
		if (event.runId) {
			fields.push(`run:${event.runId}`);
		}
		if (event.outcome) {
			fields.push(`outcome:${event.outcome}`);
		}
	} else {
		fields.push(`stage:${event.stage}`);
		if (event.action) {
			fields.push(`action:${event.action}`);
		}
		fields.push(`run:${event.runId}`);
		if (event.kind === 'activity-finish') {
			fields.push(`outcome:${event.outcome}`);
			if (event.provisional) {
				fields.push('provisional:true');
			}
			if (event.correction) {
				fields.push('correction:true');
			}
		}
	}

	return `${fields.join(' ')} note:"${cleanNote(event.note, defaultNote(event))}"`;
}

/** Parses valid audit lines while ignoring receipts, proposals, and prose. */
export function parseAuditEvents(logSection: string): AuditEvent[] {
	const events: AuditEvent[] = [];
	for (const line of logSection.split(/\r?\n/)) {
		const match = AUDIT_LINE.exec(line.trim());
		if (!match) {
			continue;
		}

		const [, kind, at, taskId, from, to, stage, action, runId, outcome, provisional, correction, note] = match;
		const event: AuditEvent = {
			kind: kind as AuditEventKind,
			at,
			taskId,
			from,
			to,
			action,
			stage: stage as AuditStage | undefined,
			runId,
			outcome: outcome as AuditOutcome | undefined,
			provisional: provisional === 'true' ? true : undefined,
			correction: correction === 'true' ? true : undefined,
			note,
		};
		try {
			validateEvent(event);
			events.push(event);
		} catch {
			// Ignore malformed audit lines just as receipt parsing ignores prose.
		}
	}
	return events;
}

/** Semantic identity used to prevent repeated lifecycle events on reconciliation. */
export function auditLifecycleKey(event: AuditEvent): string {
	return [
		event.kind,
		event.taskId,
		event.stage ?? '',
		event.runId ?? '',
		event.outcome ?? '',
		event.provisional ? 'provisional' : '',
		event.correction ? 'correction' : '',
		event.from ?? '',
		event.to ?? '',
		event.action ?? '',
	].join('|');
}

/** Alias expressing that semantic identity is also suitable for all audit events. */
export const auditEventKey = auditLifecycleKey;

/** Compile-time guard for callers that build transition events from task values. */
export type AuditedColumn = Column;
export type AuditedStatus = Status;
