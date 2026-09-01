import { open, readdir, stat } from 'node:fs/promises';
import * as vscode from 'vscode';

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
 * - **Message text reaches the card; payloads do not.** The assistant's replies
 *   and the submitted prompt are what makes this worth showing, so they survive
 *   {@link projectTranscriptEntry} — truncated to a card-sized excerpt. Tool
 *   *arguments* and tool *results* are still dropped there: they are the fields
 *   that carry file contents and credentials, and they are unbounded in size.
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

/** The two events whose `content` is message text, shown on the card. */
export const CONTENT_EVENT_TYPES: readonly string[] = ['assistant.message', 'user.message'];

/** Event types whose payload carries prompts, replies, arguments, or results. */
export const CONTENT_BEARING_EVENT_TYPES = [
	'user.message',
	'assistant.message',
	'tool.execution_start',
	'tool.execution_complete',
] as const;

/**
 * Hard cap on retained message text. This is a safety valve against a
 * pathological payload, not an editorial trim: the feed is a scroll box and the
 * point of it is to read what the agent actually said, so a reasoning block of a
 * few thousand characters is kept whole.
 */
export const MAX_EXCERPT_LENGTH = 20_000;

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
	/** Present only for `tool.execution_*`; the tool's name, never its arguments. */
	toolName?: string;
	/**
	 * Message text for `assistant.message` and `user.message`, collapsed to one
	 * line and truncated to {@link MAX_EXCERPT_LENGTH}. Never tool arguments or
	 * tool results.
	 */
	text?: string;
	/** Correlates `tool.execution_complete` back to the start that named the tool. */
	toolCallId?: string;
	/** Present on `tool.execution_complete`; false when the tool reported failure. */
	success?: boolean;
	/**
	 * What a tool acted on — the file it read, the command it ran. Without it a
	 * row says only "started read_file", which is the part Copilot's own UI shows
	 * and this feed was dropping.
	 */
	target?: string;
}

/** A tailed entry in the shape the activity feed renders. */
export interface TranscriptFeedEntry {
	at: string;
	note: string;
	source: 'transcript';
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
			content?: unknown;
			reasoningText?: unknown;
			arguments?: Record<string, unknown>;
		};
	};
	if (typeof line.type !== 'string' || typeof line.timestamp !== 'string') {
		return undefined;
	}
	const entry: TranscriptEntry = { type: line.type, at: line.timestamp };
	if (typeof line.data?.toolName === 'string') {
		entry.toolName = line.data.toolName;
	}
	if (typeof line.data?.toolCallId === 'string') {
		entry.toolCallId = line.data.toolCallId;
	}
	const target = toolTargetOf(line.data?.arguments);
	if (target) {
		entry.target = target;
	}
	if (typeof line.data?.success === 'boolean') {
		entry.success = line.data.success;
	}
	// Only the message events carry text worth showing. `tool.execution_start`'s
	// payload lives in `arguments` and `tool.execution_complete`'s in `result`;
	// neither is read here.
	//
	// `content` is empty on any turn that ends in a tool call — the model's actual
	// words are in `reasoningText` there — so both are consulted, in that order.
	if (CONTENT_EVENT_TYPES.includes(line.type)) {
		const spoken = typeof line.data?.content === 'string' && line.data.content.trim()
			? line.data.content
			: typeof line.data?.reasoningText === 'string' ? line.data.reasoningText : '';
		const excerpt = excerptOf(spoken);
		if (excerpt) {
			entry.text = excerpt;
		}
	}
	return entry;
}

/**
 * Normalises message text for display without flattening it.
 *
 * Reasoning arrives as several `**Title**` sections separated by blank lines,
 * which is how Copilot's own UI renders them as distinct blocks. Collapsing all
 * whitespace to single spaces destroyed exactly that structure, so only line
 * endings and runs of blank lines are normalised here.
 */
export function excerptOf(text: string): string {
	const normalised = text
		.replace(/\r\n?/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	return normalised.length > MAX_EXCERPT_LENGTH
		? `${normalised.slice(0, MAX_EXCERPT_LENGTH - 1)}…`
		: normalised;
}

/**
 * The one argument worth naming in a feed row, in the order a reader cares about.
 * A file path is reduced to its last segment: the row is a summary, and an
 * absolute Windows path would dominate it.
 *
 * This reads `arguments`, which the earlier design excluded wholesale. Only these
 * identifying fields are taken — never the whole payload — and reaching the
 * shared browser surface still requires `chat.transcriptFeedRemote`.
 */
export function toolTargetOf(args: Record<string, unknown> | undefined): string | undefined {
	if (!args) {
		return undefined;
	}
	for (const key of ['filePath', 'path', 'file']) {
		const value = args[key];
		if (typeof value === 'string' && value.trim()) {
			return value.split(/[\\/]/).filter(Boolean).pop();
		}
	}
	for (const key of ['command', 'query', 'pattern', 'name']) {
		const value = args[key];
		if (typeof value === 'string' && value.trim()) {
			return value.replace(/\s+/g, ' ').trim();
		}
	}
	return undefined;
}

/** Human-readable one-liner for a tailed entry. Never includes content. */
export function describeTranscriptEntry(entry: TranscriptEntry): string {
	switch (entry.type) {
		case 'session.start':
			return 'chat session started';
		case 'user.message':
			return entry.text ?? 'prompt submitted';
		case 'assistant.turn_start':
			return 'turn started';
		case 'assistant.message':
			return entry.text ?? 'assistant replied';
		case 'assistant.turn_end':
			return 'turn finished';
		case 'tool.execution_start': {
			const tool = entry.toolName ?? 'a tool';
			return entry.target ? `${tool} — ${entry.target}` : `started ${tool}`;
		}
		case 'tool.execution_complete': {
			// The complete event carries only a toolCallId, so the name comes from the
			// matching start; without it the row would read "finished a tool".
			const label = entry.toolName ?? 'a tool';
			return entry.success === false ? `${label} failed` : `finished ${label}`;
		}
		default:
			return entry.type;
	}
}

/** Projects tailed entries into feed rows, newest last, bounded to `limit`. */
export function toFeedEntries(entries: readonly TranscriptEntry[], limit: number): TranscriptFeedEntry[] {
	// An `assistant.message` with no reply and no reasoning is the bookkeeping
	// record of a tool request; Copilot's own UI shows nothing for it, and a row
	// reading "assistant replied" would be actively misleading.
	return entries
		.filter((entry) => entry.type !== 'assistant.message' || entry.text)
		.slice(-limit)
		.map((entry) => ({
		at: entry.at,
		note: describeTranscriptEntry(entry),
		source: 'transcript' as const,
	}));
}

/** A row in the activity feed, from either source. */
export interface FeedEntry {
	at: string;
	note: string;
	source: 'progress' | 'transcript' | 'hook';
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

	consume(chunk: string): TranscriptEntry[] {
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
				entries.push(this.correlateToolName(entry));
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
	fsPath?: string;
	offset: number;
	reader: TranscriptLineReader;
	entries: TranscriptEntry[];
	gated: boolean;
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

	constructor(
		private readonly storageUri: vscode.Uri | undefined,
		private readonly defaultLimit = DEFAULT_FEED_LIMIT,
	) {}

	/** Begins tailing for a task. A second call for the same task is ignored. */
	async start(taskId: string, options: TranscriptTailOptions = {}): Promise<void> {
		if (!this.storageUri || this.tails.has(taskId)) {
			return;
		}
		const directory = transcriptsDirectory(this.storageUri).fsPath;
		const state: TailState = {
			offset: 0,
			reader: new TranscriptLineReader(),
			entries: [],
			gated: false,
			polling: false,
			known: new Set<string>(),
			sessionId: options.sessionId,
		};

		if (options.sessionId) {
			// A later run: the file is known, and only what this run appends is wanted.
			const fsPath = transcriptFileFor(this.storageUri, options.sessionId).fsPath;
			state.gated = await readTranscriptHeader(fsPath);
			if (state.gated) {
				state.fsPath = fsPath;
				try {
					state.offset = (await stat(fsPath)).size;
				} catch {
					state.offset = 0;
				}
			}
		} else {
			// A first run: remember what exists now, so a file appearing later is ours.
			try {
				for (const name of await readdir(directory)) {
					if (name.endsWith('.jsonl')) {
						state.known.add(name);
					}
				}
			} catch {
				// No directory yet is a valid state to wait in.
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
		const state = this.tails.get(taskId);
		if (!state) {
			return [];
		}
		return toFeedEntries(state.entries, limit);
	}

	dispose(): void {
		for (const taskId of [...this.tails.keys()]) {
			this.forget(taskId);
		}
	}

	private async poll(taskId: string, limit: number): Promise<void> {
		const state = this.tails.get(taskId);
		if (!state || state.polling || !this.storageUri) {
			return;
		}
		state.polling = true;
		try {
			if (!state.fsPath) {
				await this.discover(state);
			}
			if (!state.fsPath || !state.gated) {
				return;
			}
			await this.readAppended(state, limit);
		} catch {
			// A transcript that is missing, evicted, or unreadable is "no activity",
			// never an error surfaced to the user.
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
		} catch {
			return;
		}
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

	private async readAppended(state: TailState, limit: number): Promise<void> {
		const { size } = await stat(state.fsPath!);
		if (size <= state.offset) {
			return;
		}
		const handle = await open(state.fsPath!, 'r');
		try {
			const length = size - state.offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, state.offset);
			state.offset = size;
			state.entries.push(...state.reader.consume(buffer.toString('utf8')));
			if (state.entries.length > limit) {
				state.entries.splice(0, state.entries.length - limit);
			}
		} finally {
			await handle.close();
		}
	}
}
