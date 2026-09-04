import { open, rm, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { utcTimestamp } from '../model/taskLog';

import type { FeedEntry, FeedSourceAvailability, FeedSourceSnapshot } from './transcriptTail';

/**
 * Receiver for the real-time hook feed (TASK-015,
 * docs/research/copilot-hook-feed-design.md).
 *
 * `scripts/kanban-pilot-hook.mjs` appends one structural line per Copilot chat
 * event to a workspace-local spool. This drains it into a bounded per-task
 * buffer that the board projection unions into the activity feed.
 *
 * Why a spool rather than the task file: `TaskStore` replaces task files whole
 * through a temp path and a rename, so an append from an external process during
 * a run is silently lost.
 *
 * Why this exists at all, given the transcript tail: the tail is 6-53 s behind on
 * tool events, because Copilot flushes its transcript at the next prompt render
 * (TASK-009). Hooks fire *at* the event, which is the only thing fast enough for
 * the browser board to keep up with a run.
 *
 * The receiver raises {@link onDidChange} when entries arrive. That matters more
 * than it looks: the browser republishes on a task change, and a spool write
 * touches no task file, so without this the entries would sit in memory and the
 * remote viewer — the whole point of the feature — would see nothing.
 */

/** Spool line shape this receiver understands. Other versions are dropped. */
export const SPOOL_SCHEMA_VERSION = 1;

/** Workspace-relative spool path, written by the hook and drained here. */
export const SPOOL_RELATIVE_PATH = '.kanban-pilot/.hook-spool.jsonl';

/** How often the spool is drained. */
export const DEFAULT_DRAIN_INTERVAL_MS = 500;

const STRUCTURAL_LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const TASK_ID = /^TASK-\d{3,}$/;
const EVENT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isEventTimestamp(value: string): boolean {
	return EVENT_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

/** One structural event as the hook wrote it. */
export interface SpoolLine {
	v: number;
	event: string;
	at: string;
	sessionId?: string;
	taskId?: string;
	toolName?: string;
}

/** Parses one spool line, rejecting anything that is not this schema version. */
export function parseSpoolLine(raw: string): SpoolLine | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const line = parsed as Partial<SpoolLine>;
	if (line.v !== SPOOL_SCHEMA_VERSION) {
		return undefined;
	}
	if (
		typeof line.event !== 'string'
		|| !STRUCTURAL_LABEL.test(line.event)
		|| typeof line.at !== 'string'
		|| !isEventTimestamp(line.at)
	) {
		return undefined;
	}
	return {
		v: line.v,
		event: line.event,
		at: line.at,
		...(typeof line.sessionId === 'string' && STRUCTURAL_LABEL.test(line.sessionId) ? { sessionId: line.sessionId } : {}),
		...(typeof line.taskId === 'string' && TASK_ID.test(line.taskId) ? { taskId: line.taskId } : {}),
		...(typeof line.toolName === 'string' && STRUCTURAL_LABEL.test(line.toolName) ? { toolName: line.toolName } : {}),
	};
}

/** Human-readable note for a hook event. Never includes content. */
export function describeSpoolLine(line: SpoolLine): string {
	switch (line.event) {
		case 'UserPromptSubmit':
			return 'prompt submitted';
		case 'Stop':
			return 'turn finished';
		case 'SessionStart':
			return 'chat session started';
		case 'PreToolUse':
			return line.toolName ? `running ${structuralLabel(line.toolName, 'a tool')}` : 'running a tool';
		case 'PostToolUse':
			return line.toolName ? `finished ${structuralLabel(line.toolName, 'a tool')}` : 'finished a tool';
		default:
			return structuralLabel(line.event, 'event observed');
	}
}

function structuralLabel(value: string, fallback: string): string {
	return value.length <= 64 && STRUCTURAL_LABEL.test(value) ? value : fallback;
}

/**
 * Transcript event types a hook already reports, so the same tool call is not
 * shown twice — once live from the hook and again 6-53 s later from the tail.
 */
const HOOK_COVERED_TRANSCRIPT_TYPES = new Set([
	'tool.execution_start',
	'tool.execution_complete',
	'user.message',
	'assistant.turn_end',
]);

/**
 * Drops tailed entries whose events a hook already reported for this task.
 *
 * Coverage is decided per task rather than globally, and only while hook entries
 * are actually present: if hooks stop mid-run the tail becomes the only source
 * again and its entries must keep flowing, late but present.
 */
export function suppressDuplicatedTailEntries(
	tailed: readonly FeedEntry[],
	hookEntries: readonly FeedEntry[],
	isCovered: (note: string) => boolean = defaultCoverage,
): FeedEntry[] {
	if (hookEntries.length === 0) {
		return [...tailed];
	}
	return tailed.filter((entry) => !isCovered(entry.note));
}

/** A tailed note that describes a tool step the hook feed also reports. */
function defaultCoverage(note: string): boolean {
	return note.startsWith('started ')
		|| note.startsWith('finished ')
		|| note === 'prompt submitted'
		|| note === 'turn finished';
}

/** True for a transcript event type the hook feed also covers. */
export function isHookCoveredTranscriptType(type: string): boolean {
	return HOOK_COVERED_TRANSCRIPT_TYPES.has(type);
}

interface TaskBuffer {
	entries: FeedEntry[];
	latestEventAt?: string;
	latestObservedAt?: string;
}

/**
 * Drains the spool and keeps a bounded buffer per task.
 *
 * Attribution: a `UserPromptSubmit` line carries the task id parsed from the
 * prompt marker, which pairs it with the session id. Later lines in the same
 * session are attributed through that map, so a task's first run is attributable
 * even though `copilot_session_id` does not exist until the run ends.
 */
export class HookSpoolReceiver {
	private readonly buffers = new Map<string, TaskBuffer>();
	private readonly sessionToTask = new Map<string, string>();
	private readonly changed = new vscode.EventEmitter<string>();
	private offset = 0;
	private pending = '';
	private timer: ReturnType<typeof setInterval> | undefined;
	private draining = false;
	private availability: FeedSourceAvailability = 'missing';

	/** Fires with a task id when entries arrive, or an empty id when availability changes. */
	readonly onDidChange = this.changed.event;

	constructor(
		private readonly spoolPath: string,
		private readonly limit = 20,
	) {}

	start(intervalMs = DEFAULT_DRAIN_INTERVAL_MS): void {
		if (this.timer) {
			return;
		}
		this.timer = setInterval(() => void this.drain(), intervalMs);
		this.timer.unref?.();
		void this.drain();
	}

	/** Bounded feed rows for a task; empty when the hook feed has reported nothing. */
	entriesFor(taskId: string, limit = this.limit): FeedEntry[] {
		return this.snapshotFor(taskId, limit).entries;
	}

	/** Safe source state for the board; no spool path or hook payload is exposed. */
	snapshotFor(taskId: string, limit = this.limit): FeedSourceSnapshot {
		const buffer = this.buffers.get(taskId);
		return {
			availability: this.availability,
			entries: (buffer?.entries ?? []).slice(-limit),
			...(buffer?.latestEventAt ? { latestEventAt: buffer.latestEventAt } : {}),
			...(buffer?.latestObservedAt ? { latestObservedAt: buffer.latestObservedAt } : {}),
		};
	}

	/** Reads whatever the hook appended since the last pass. Never throws. */
	async drain(): Promise<void> {
		if (this.draining) {
			return;
		}
		this.draining = true;
		try {
			let size: number;
			try {
				const spool = await stat(this.spoolPath);
				if (!spool.isFile()) {
					this.setAvailability('unreadable');
					return;
				}
				size = spool.size;
			} catch (error) {
				this.setAvailability(availabilityForError(error));
				return;
			}
			this.setAvailability('configured');
			if (size < this.offset) {
				// The spool was truncated or replaced; start over rather than reading
				// from a stale offset into the middle of a line.
				this.offset = 0;
				this.pending = '';
			}
			if (size === this.offset) {
				return;
			}
			const handle = await open(this.spoolPath, 'r');
			let chunk: string;
			try {
				const length = size - this.offset;
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, this.offset);
				this.offset = size;
				chunk = buffer.toString('utf8');
			} finally {
				await handle.close();
			}
			this.ingest(chunk);
		} catch (error) {
			// A missing, truncated, or unreadable spool is "no activity", never an
			// error surfaced to the user or a failed run.
			this.setAvailability(availabilityForError(error));
		} finally {
			this.draining = false;
		}
	}

	/** Feeds raw appended text through the parser. Exposed for tests. */
	ingest(chunk: string): void {
		// Direct ingestion is also used by tests and by an already-open spool. It is
		// evidence that the configured source is working. A task event below also
		// carries that state change; otherwise publish one source-wide notification.
		const availabilityChanged = this.availability !== 'configured';
		this.availability = 'configured';
		const observedAt = utcTimestamp();
		const parts = (this.pending + chunk).split('\n');
		this.pending = parts.pop() ?? '';
		const touched = new Set<string>();

		for (const raw of parts) {
			if (!raw.trim()) {
				continue;
			}
			const line = parseSpoolLine(raw);
			if (!line) {
				continue;
			}
			if (line.taskId && line.sessionId) {
				this.sessionToTask.set(line.sessionId, line.taskId);
			}
			const taskId = line.taskId
				?? (line.sessionId ? this.sessionToTask.get(line.sessionId) : undefined);
			if (!taskId) {
				// An event from a session we have not seen a prompt marker for is not
				// ours — a plain Copilot chat, not a stage run.
				continue;
			}
			const buffer = this.buffers.get(taskId) ?? { entries: [] };
			buffer.entries.push({
				at: line.at,
				note: describeSpoolLine(line),
				source: 'hook',
				observedAt,
			});
			buffer.latestObservedAt = observedAt;
			if (!buffer.latestEventAt || Date.parse(line.at) > Date.parse(buffer.latestEventAt)) {
				buffer.latestEventAt = line.at;
			}
			if (buffer.entries.length > this.limit) {
				buffer.entries.splice(0, buffer.entries.length - this.limit);
			}
			this.buffers.set(taskId, buffer);
			touched.add(taskId);
		}

		for (const taskId of touched) {
			this.changed.fire(taskId);
		}
		if (availabilityChanged && touched.size === 0) {
			this.changed.fire('');
		}
	}

	/** Removes the spool file; used when no run is live. */
	async cleanup(): Promise<void> {
		this.offset = 0;
		this.pending = '';
		this.setAvailability('missing');
		try {
			await rm(this.spoolPath, { force: true });
		} catch {
			// Nothing to clean up is the normal case.
		}
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.changed.dispose();
	}

	private setAvailability(availability: FeedSourceAvailability): void {
		if (this.availability === availability) {
			return;
		}
		this.availability = availability;
		this.changed.fire('');
	}
}

function availabilityForError(error: unknown): FeedSourceAvailability {
	return error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
		? 'missing'
		: 'unreadable';
}
