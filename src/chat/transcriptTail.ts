import { open, readdir, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { utcTimestamp } from '../model/taskLog';

/**
 * Read-only tail of Copilot Chat's own session transcript, projected into the
 * activity feed (TASK-008, docs/research/copilot-response-streaming-spike.md).
 *
 * Copilot appends one JSONL event log per session under its own workspace
 * storage. Because `ExtensionContext.storageUri` is
 * `…/workspaceStorage/<workspaceId>/<publisher>.<name>/`, the sibling directory
 * is reachable by path arithmetic alone — no proposed API, nothing to be
 * granted.
 *
 * Four measured facts shape this module, and none of them are negotiable:
 *
 * - **It is a record, not a live view.** Tool events land a median of ~6 s and
 *   up to 53 s after they occur, because a tool call's duration falls inside
 *   Copilot's flush window (TASK-009). Nothing here may be presented as current.
 * - **The header appears once, at line 0.** A second run on the same task
 *   appends no new `session.start`, so the version/producer gate never arrives
 *   in the stream and must be read explicitly (TASK-011).
 * - **Runs are not delimited.** Consecutive runs append straight on, so "this
 *   run" is a byte-offset slice, not a parse.
 * - **The feed is structural only.** Message bodies, reasoning, tool
 *   arguments, tool results, paths, commands, and queries are all discarded at
 *   {@link projectTranscriptEntry}. A row can say that a prompt, response, or
 *   tool event was observed, but it never mirrors the Copilot conversation.
 *   Reaching the shared, token-gated browser surface additionally requires the
 *   separate `chat.transcriptFeedRemote` opt-in.
 *
 * This module never writes a task file. `TaskStore` replaces task files whole
 * through a temp path and a rename, so an external append during a run would be
 * silently lost; tailed entries live in memory and are unioned into the
 * projection instead.
 */

/** The bundled Copilot Chat extension whose storage holds the transcripts. */
export const COPILOT_CHAT_EXTENSION_ID = 'GitHub.copilot-chat';

/** Directory Copilot writes session transcripts into, inside its own storage. */
export const TRANSCRIPT_DIRECTORY = 'transcripts';

/** The only `session.start` header shape this reader has been verified against. */
export const SUPPORTED_TRANSCRIPT_VERSION = 1;
export const SUPPORTED_TRANSCRIPT_PRODUCER = 'copilot-agent';

/** The two events whose payload contains message text; neither is forwarded. */
export const CONTENT_EVENT_TYPES: readonly string[] = ['assistant.message', 'user.message'];

/** Event types whose payload carries prompts, replies, arguments, or results. */
export const CONTENT_BEARING_EVENT_TYPES = [
	'user.message',
	'assistant.message',
	'tool.execution_start',
	'tool.execution_complete',
] as const;

/** Structural labels are identifiers, not user-authored content. */
const MAX_STRUCTURAL_LABEL_LENGTH = 64;
const STRUCTURAL_LABEL = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/;
const EVENT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/**
 * Entries retained per task, and the row cap the card renders. The activity feed
 * is a scroll box, so it wants more history than a screenful; this is the single
 * source of that bound, because a service that retains fewer than the card shows
 * would silently cap the feed at the smaller of the two.
 */
export const DEFAULT_FEED_LIMIT = 200;

/** How often the transcript is polled while a run is in flight. */
export const DEFAULT_TAIL_INTERVAL_MS = 1_000;

/** One transcript event, reduced to structure. No content survives this shape. */
export interface TranscriptEntry {
	type: string;
	/** The entry's own timestamp — when the event occurred, not when it was flushed. */
	at: string;
	/** Present only for `tool.execution_*`; a bounded structural tool name. */
	toolName?: string;
	/** Correlates `tool.execution_complete` back to the start that named the tool. */
	toolCallId?: string;
	/** Present on `tool.execution_complete`; false when the tool reported failure. */
	success?: boolean;
	/** When the extension first observed the event in the delayed transcript. */
	observedAt?: string;
}

/** A tailed entry in the shape the activity feed renders. */
export interface TranscriptFeedEntry {
	at: string;
	note: string;
	source: 'transcript';
	/** Set when the transcript reader observed the event, not when it occurred. */
	observedAt?: string;
}

/** Availability of an optional local feed before UI settings are applied. */
export type FeedSourceAvailability = 'configured' | 'missing' | 'unreadable' | 'not-configured';

/** The safe, in-memory view of one optional feed source. */
export interface FeedSourceSnapshot {
	availability: FeedSourceAvailability;
	entries: FeedEntry[];
	latestEventAt?: string;
	latestObservedAt?: string;
}

/** True for an event type whose payload carries raw conversation content. */
export function carriesContent(eventType: string): boolean {
	return (CONTENT_BEARING_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** Copilot's transcripts directory, derived from this extension's own storage. */
export function transcriptsDirectory(storageUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(storageUri, '..', COPILOT_CHAT_EXTENSION_ID, TRANSCRIPT_DIRECTORY);
}

/** The transcript file for one Copilot session id. */
export function transcriptFileFor(storageUri: vscode.Uri, sessionId: string): vscode.Uri {
	return vscode.Uri.joinPath(transcriptsDirectory(storageUri), `${sessionId}.jsonl`);
}

/**
 * True when a parsed `session.start` line is a shape this reader has been
 * verified against. An unrecognised header degrades the feed to "no tailed
 * entries" rather than risking a misparse of an undocumented format.
 */
export function isSupportedTranscriptHeader(parsed: unknown): boolean {
	if (!parsed || typeof parsed !== 'object') {
		return false;
	}
	const line = parsed as { type?: unknown; data?: { version?: unknown; producer?: unknown } };
	return line.type === 'session.start'
		&& line.data?.version === SUPPORTED_TRANSCRIPT_VERSION
		&& line.data?.producer === SUPPORTED_TRANSCRIPT_PRODUCER;
}

/**
 * Reduces one parsed transcript line to the structural entry this module keeps.
 * This is the redaction boundary: `data` is read only for `toolName`, and every
 * other field of it is discarded here rather than downstream.
 */
export function projectTranscriptEntry(parsed: unknown): TranscriptEntry | undefined {
	if (!parsed || typeof parsed !== 'object') {
		return undefined;
	}
	const line = parsed as {
		type?: unknown;
		timestamp?: unknown;
		data?: {
			toolName?: unknown;
			toolCallId?: unknown;
			success?: unknown;
		};
	};
	if (
		typeof line.type !== 'string'
		|| !STRUCTURAL_LABEL.test(line.type)
		|| line.type.length > MAX_STRUCTURAL_LABEL_LENGTH
		|| typeof line.timestamp !== 'string'
		|| !EVENT_TIMESTAMP.test(line.timestamp)
		|| !Number.isFinite(Date.parse(line.timestamp))
	) {
		return undefined;
	}
	const entry: TranscriptEntry = { type: line.type, at: line.timestamp };
	const data = line.data && typeof line.data === 'object' ? line.data : undefined;
	if (typeof data?.toolName === 'string' && STRUCTURAL_LABEL.test(data.toolName)) {
		entry.toolName = data.toolName;
	}
	if (typeof data?.toolCallId === 'string' && STRUCTURAL_LABEL.test(data.toolCallId)) {
		entry.toolCallId = data.toolCallId;
	}
	if (typeof data?.success === 'boolean') {
		entry.success = data.success;
	}
	return entry;
}

/** Human-readable one-liner for a tailed entry. Never includes content. */
export function describeTranscriptEntry(entry: TranscriptEntry): string {
	switch (entry.type) {
		case 'session.start':
			return 'chat session started';
		case 'user.message':
			return 'prompt submitted';
		case 'assistant.turn_start':
			return 'turn started';
		case 'assistant.message':
			return 'assistant message observed';
		case 'assistant.turn_end':
			return 'turn finished';
		case 'tool.execution_start': {
			const tool = entry.toolName ?? 'a tool';
			return `started ${tool}`;
		}
		case 'tool.execution_complete': {
			// The complete event carries only a toolCallId, so the name comes from the
			// matching start; without it the row would read "finished a tool".
			const label = entry.toolName ?? 'a tool';
			return entry.success === false ? `${label} failed` : `finished ${label}`;
		}
		default:
			return STRUCTURAL_LABEL.test(entry.type) ? entry.type : 'event observed';
	}
}

/** Projects tailed entries into feed rows, newest last, bounded to `limit`. */
export function toFeedEntries(entries: readonly TranscriptEntry[], limit: number): TranscriptFeedEntry[] {
	return entries
		.slice(-limit)
		.map((entry) => ({
		at: entry.at,
		note: describeTranscriptEntry(entry),
		source: 'transcript' as const,
		...(entry.observedAt ? { observedAt: entry.observedAt } : {}),
	}));
}

/** A row in the activity feed, from either source. */
export interface FeedEntry {
	at: string;
	note: string;
	source: 'progress' | 'transcript' | 'hook';
	/** Observation time for ephemeral sources; durable progress has none. */
	observedAt?: string;
}

/**
 * Merges the two feed sources into one time-ordered, bounded list.
 *
 * Ordering is by parsed instant rather than by string: progress lines carry
 * second precision and transcript entries carry milliseconds, so a lexicographic
 * compare would sort `…:00.065Z` before `…:00Z`. Ties keep progress lines first,
 * because the agent wrote them at the moment it acted while a tailed entry is an
 * observation of the same moment arriving later.
 */
export function mergeFeedEntries(
	progress: readonly FeedEntry[],
	tailed: readonly FeedEntry[],
	limit: number,
): FeedEntry[] {
	const ranked = [...progress, ...tailed].map((entry, index) => {
		const parsed = Date.parse(entry.at);
		return {
			entry,
			at: Number.isFinite(parsed) ? parsed : 0,
			tieBreak: entry.source === 'progress' ? 0 : 1,
			index,
		};
	});
	ranked.sort((a, b) => a.at - b.at || a.tieBreak - b.tieBreak || a.index - b.index);
	return ranked.slice(-limit).map((row) => row.entry);
}

/**
 * Splits an append stream into complete entries, holding back a partial trailing
 * line until it completes. Measurement never observed a fragment, but a reader
 * that assumes whole lines would misparse the first one it met.
 */
export class TranscriptLineReader {
	private pending = '';
	/** toolCallId → toolName, learned from `tool.execution_start`. */
	private readonly toolNames = new Map<string, string>();

	consume(chunk: string, observedAt?: string): TranscriptEntry[] {
		const parts = (this.pending + chunk).split('\n');
		this.pending = parts.pop() ?? '';

		const entries: TranscriptEntry[] = [];
		for (const line of parts) {
			if (!line.trim()) {
				continue;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			const entry = projectTranscriptEntry(parsed);
			if (entry) {
				const correlated = this.correlateToolName(entry);
				entries.push(observedAt ? { ...correlated, observedAt } : correlated);
			}
		}
		return entries;
	}

	/**
	 * Carries a tool's name from its start event to its completion. Copilot names
	 * the tool only on `tool.execution_start`; the completion carries just the
	 * `toolCallId`, so without this every finish would read "finished a tool".
	 */
	private correlateToolName(entry: TranscriptEntry): TranscriptEntry {
		if (entry.type === 'tool.execution_start' && entry.toolCallId && entry.toolName) {
			this.toolNames.set(entry.toolCallId, entry.toolName);
			return entry;
		}
		if (entry.type === 'tool.execution_complete' && entry.toolCallId && !entry.toolName) {
			const name = this.toolNames.get(entry.toolCallId);
			if (name) {
				this.toolNames.delete(entry.toolCallId);
				return { ...entry, toolName: name };
			}
		}
		return entry;
	}
}

/** Reads and gates line 0. Returns false when the file is absent or unsupported. */
export async function readTranscriptHeader(fsPath: string): Promise<boolean> {
	let handle;
	try {
		handle = await open(fsPath, 'r');
	} catch {
		return false;
	}
	try {
		const buffer = Buffer.alloc(8192);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const firstLine = buffer.toString('utf8', 0, bytesRead).split('\n', 1)[0];
		if (!firstLine.trim()) {
			return false;
		}
		return isSupportedTranscriptHeader(JSON.parse(firstLine));
	} catch {
		return false;
	} finally {
		await handle.close();
	}
}

interface TailState {
	taskId: string;
	fsPath?: string;
	offset: number;
	reader: TranscriptLineReader;
	entries: TranscriptEntry[];
	gated: boolean;
	availability: FeedSourceAvailability;
	latestEventAt?: string;
	latestObservedAt?: string;
	timer?: ReturnType<typeof setInterval>;
	polling: boolean;
	known: Set<string>;
	sessionId?: string;
}

export interface TranscriptTailOptions {
	/** Known Copilot session id. Absent on a task's first run — see the class doc. */
	sessionId?: string;
	intervalMs?: number;
	/** Most entries retained per task. */
	limit?: number;
}

/**
 * Owns one tail per running task.
 *
 * Correlation is split, and it has to be: `copilot_session_id` is written about
 * two seconds after a run's *last* event, so it can never identify the run that
 * produces it (TASK-011). A task's first run is therefore found by watching the
 * directory for a file that was not there when the run started; every later run
 * opens the known id directly and seeks to its end.
 */
export class TranscriptTailService {
	private readonly tails = new Map<string, TailState>();
	private readonly changed = new vscode.EventEmitter<string>();

	constructor(
		private readonly storageUri: vscode.Uri | undefined,
		private readonly defaultLimit = DEFAULT_FEED_LIMIT,
	) {}

	/** Fires when a tail receives a new observation or changes availability. */
	readonly onDidChange = this.changed.event;

	/** Begins tailing for a task. A second call for the same task is ignored. */
	async start(taskId: string, options: TranscriptTailOptions = {}): Promise<void> {
		if (!this.storageUri || this.tails.has(taskId)) {
			return;
		}
		const directory = transcriptsDirectory(this.storageUri).fsPath;
		const state: TailState = {
			taskId,
			offset: 0,
			reader: new TranscriptLineReader(),
			entries: [],
			gated: false,
			availability: 'missing',
			polling: false,
			known: new Set<string>(),
			sessionId: options.sessionId,
		};

		if (options.sessionId) {
			// A later run: the file is known, and only what this run appends is wanted.
			await this.attachKnownSession(state);
		} else {
			// A first run: remember what exists now, so a file appearing later is ours.
			try {
				for (const name of await readdir(directory)) {
					if (name.endsWith('.jsonl')) {
						state.known.add(name);
					}
				}
				state.availability = 'configured';
			} catch (error) {
				// No directory yet is a valid state to wait in.
				state.availability = availabilityForError(error);
			}
		}

		this.tails.set(taskId, state);
		const interval = options.intervalMs ?? DEFAULT_TAIL_INTERVAL_MS;
		state.timer = setInterval(() => void this.poll(taskId, options.limit ?? this.defaultLimit), interval);
		state.timer.unref?.();
		await this.poll(taskId, options.limit ?? this.defaultLimit);
	}

	/** Stops tailing. Retained entries stay available until {@link forget}. */
	stop(taskId: string): void {
		const state = this.tails.get(taskId);
		if (state?.timer) {
			clearInterval(state.timer);
			state.timer = undefined;
		}
	}

	/** Drops a task's tail and its retained entries. */
	forget(taskId: string): void {
		this.stop(taskId);
		this.tails.delete(taskId);
	}

	/** Bounded, time-ordered feed rows for a task; empty when nothing is tailed. */
	entriesFor(taskId: string, limit = this.defaultLimit): TranscriptFeedEntry[] {
		return this.snapshotFor(taskId, limit).entries as TranscriptFeedEntry[];
	}

	/** Safe source state for the board; no transcript path or payload is exposed. */
	snapshotFor(taskId: string, limit = this.defaultLimit): FeedSourceSnapshot {
		if (!this.storageUri) {
			return { availability: 'not-configured', entries: [] };
		}
		const state = this.tails.get(taskId);
		if (!state) {
			return { availability: 'configured', entries: [] };
		}
		return {
			availability: state.availability,
			entries: toFeedEntries(state.entries, limit),
			...(state.latestEventAt ? { latestEventAt: state.latestEventAt } : {}),
			...(state.latestObservedAt ? { latestObservedAt: state.latestObservedAt } : {}),
		};
	}

	dispose(): void {
		for (const taskId of [...this.tails.keys()]) {
			this.forget(taskId);
		}
		this.changed.dispose();
	}

	private async poll(taskId: string, limit: number): Promise<void> {
		const state = this.tails.get(taskId);
		if (!state || state.polling || !this.storageUri) {
			return;
		}
		state.polling = true;
		try {
			if (!state.fsPath && state.sessionId) {
				await this.attachKnownSession(state);
			} else if (!state.fsPath) {
				await this.discover(state);
			}
			if (!state.fsPath || !state.gated) {
				return;
			}
			await this.readAppended(state, limit);
		} catch (error) {
			// A transcript that is missing, evicted, or unreadable is "no activity",
			// never an error surfaced to the user.
			this.setAvailability(state, availabilityForError(error));
		} finally {
			state.polling = false;
		}
	}

	/** First-run correlation: attach to a `.jsonl` that was not present at start. */
	private async discover(state: TailState): Promise<void> {
		const directory = transcriptsDirectory(this.storageUri!).fsPath;
		let names: string[];
		try {
			names = await readdir(directory);
		} catch (error) {
			this.setAvailability(state, availabilityForError(error));
			return;
		}
		this.setAvailability(state, 'configured');
		for (const name of names) {
			if (!name.endsWith('.jsonl') || state.known.has(name)) {
				continue;
			}
			const fsPath = vscode.Uri.joinPath(vscode.Uri.file(directory), name).fsPath;
			if (await readTranscriptHeader(fsPath)) {
				state.fsPath = fsPath;
				state.gated = true;
				state.offset = 0;
				return;
			}
		}
	}

	/** Attaches to a known session only; a missing later-run file must not make
	 * the first-run directory discovery attach an unrelated transcript. */
	private async attachKnownSession(state: TailState): Promise<void> {
		if (!state.sessionId || state.fsPath) {
			return;
		}
		const fsPath = transcriptFileFor(this.storageUri!, state.sessionId).fsPath;
		let size: number;
		try {
			({ size } = await stat(fsPath));
		} catch (error) {
			this.setAvailability(state, availabilityForError(error));
			return;
		}
		if (!await readTranscriptHeader(fsPath)) {
			this.setAvailability(state, 'unreadable');
			return;
		}
		state.fsPath = fsPath;
		state.gated = true;
		state.offset = size;
		this.setAvailability(state, 'configured');
	}

	private async readAppended(state: TailState, limit: number): Promise<void> {
		const { size } = await stat(state.fsPath!);
		if (size < state.offset) {
			// The file was replaced or truncated. Start from its verified header so
			// stale offsets cannot split a line or replay old retained entries.
			state.offset = 0;
			state.reader = new TranscriptLineReader();
			state.entries = [];
			state.latestEventAt = undefined;
			state.latestObservedAt = undefined;
			state.gated = await readTranscriptHeader(state.fsPath!);
			if (!state.gated) {
				state.fsPath = undefined;
				this.setAvailability(state, 'unreadable');
				return;
			}
		}
		if (size <= state.offset) {
			return;
		}
		const handle = await open(state.fsPath!, 'r');
		try {
			const length = size - state.offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, state.offset);
			state.offset = size;
			const observedAt = utcTimestamp();
			state.latestObservedAt = observedAt;
			state.entries.push(...state.reader.consume(buffer.toString('utf8'), observedAt));
			for (const entry of state.entries) {
				if (!state.latestEventAt || Date.parse(entry.at) > Date.parse(state.latestEventAt)) {
					state.latestEventAt = entry.at;
				}
			}
			if (state.entries.length > limit) {
				state.entries.splice(0, state.entries.length - limit);
			}
		} finally {
			await handle.close();
		}
		this.setAvailability(state, 'configured');
		this.changed.fire(state.taskId);
	}

	private setAvailability(state: TailState, availability: FeedSourceAvailability): void {
		if (state.availability === availability) {
			return;
		}
		state.availability = availability;
		this.changed.fire(state.taskId);
	}
}

function availabilityForError(error: unknown): FeedSourceAvailability {
	return error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
		? 'missing'
		: 'unreadable';
}
