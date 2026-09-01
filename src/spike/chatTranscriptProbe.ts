import * as vscode from 'vscode';

/**
 * Read-only evidence gathering for TASK-005
 * (docs/research/copilot-response-streaming-spike.md).
 *
 * Both candidate response records are plain files under the workspace storage
 * directory that VS Code already hands every extension as
 * `ExtensionContext.storageUri` — `…/workspaceStorage/<workspaceId>/<publisher>.<name>/`.
 * The sibling directories are therefore reachable by path arithmetic alone, with
 * no proposed API and nothing to be granted.
 *
 * This module only ever *stats*. It never reads a transcript's bytes, never
 * activates the Copilot extension, never opens a chat, and never submits a turn,
 * so it cannot surface message content or consume quota. It is deliberately not
 * referenced from `extension.ts`.
 */

/** The bundled Copilot Chat extension in VS Code 1.127.0. */
export const COPILOT_CHAT_EXTENSION_ID = 'GitHub.copilot-chat';

/** Workbench-written session journal: `…/workspaceStorage/<ws>/chatSessions/<id>.jsonl`. */
export const WORKBENCH_SESSION_DIRECTORY = 'chatSessions';

/** Copilot-written session transcript: `…/GitHub.copilot-chat/transcripts/<id>.jsonl`. */
export const COPILOT_TRANSCRIPT_DIRECTORY = 'transcripts';

/**
 * Event types the Copilot transcript writer emits, in the order a turn produces
 * them. Recorded here because the vocabulary — not the message content — is what
 * an activity feed would project.
 */
export const TRANSCRIPT_EVENT_TYPES = [
	'session.start',
	'user.message',
	'assistant.turn_start',
	'assistant.message',
	'tool.execution_start',
	'tool.execution_complete',
	'assistant.turn_end',
] as const;

/** Event types that carry raw conversation content and must not be forwarded verbatim. */
export const CONTENT_BEARING_EVENT_TYPES = [
	'user.message',
	'assistant.message',
	'tool.execution_start',
	'tool.execution_complete',
] as const;

/** The `session.start` fields a consumer would gate compatibility on. */
export interface TranscriptHeader {
	version?: number;
	producer?: string;
}

/** Both candidate record locations for one session id. */
export interface SessionRecordPaths {
	/** The workbench's own patch journal for the session. */
	workbenchJournal: vscode.Uri;
	/** Copilot Chat's structured event transcript for the same session. */
	copilotTranscript: vscode.Uri;
}

/** One record's presence, described without reading a byte of its content. */
export interface RecordPresence {
	uri: string;
	exists: boolean;
	/** Size in bytes, or `undefined` when the file is absent. */
	size?: number;
	/** Last modification time in ms, or `undefined` when the file is absent. */
	mtime?: number;
}

/** What the Copilot extension exposes to other extensions, without activating it. */
export interface CopilotSurface {
	installed: boolean;
	version?: string;
	/** Count of `enabledApiProposals` in its manifest — the access we cannot have. */
	declaredApiProposals: number;
	/** Keys of its `exports` object, read only when it is already active. */
	exportedKeys: readonly string[];
	/** True only if an export name suggests a conversation reader. None did in 0.55.0. */
	exposesConversation: boolean;
}

export interface TranscriptProbeResult {
	vscodeVersion: string;
	copilot: CopilotSurface;
	/** Absent when the probe was given no storage location. */
	records?: {
		sessionId: string;
		workbenchJournal: RecordPresence;
		copilotTranscript: RecordPresence;
	};
	readMessageContent: false;
	invokedChat: false;
}

/**
 * Resolves both record paths for a session id from an extension's own
 * `storageUri`. `..` walks from `<publisher>.<name>/` up to the workspace's
 * storage root, which is the parent both records live under.
 */
export function sessionRecordPaths(storageUri: vscode.Uri, sessionId: string): SessionRecordPaths {
	const workspaceStorage = vscode.Uri.joinPath(storageUri, '..');
	return {
		workbenchJournal: vscode.Uri.joinPath(
			workspaceStorage,
			WORKBENCH_SESSION_DIRECTORY,
			`${sessionId}.jsonl`,
		),
		copilotTranscript: vscode.Uri.joinPath(
			workspaceStorage,
			COPILOT_CHAT_EXTENSION_ID,
			COPILOT_TRANSCRIPT_DIRECTORY,
			`${sessionId}.jsonl`,
		),
	};
}

/**
 * True when a transcript's `session.start` header is one this codebase has
 * actually been read against. A consumer gates on this so an unrecognised future
 * format degrades to "no feed" rather than to a misparse.
 */
export function isSupportedTranscript(header: TranscriptHeader): boolean {
	return header.version === 1 && header.producer === 'copilot-agent';
}

/** True for an event type whose payload carries raw conversation content. */
export function carriesContent(eventType: string): boolean {
	return (CONTENT_BEARING_EVENT_TYPES as readonly string[]).includes(eventType);
}

/** Stats one record. Never throws and never reads the file's bytes. */
async function presence(uri: vscode.Uri): Promise<RecordPresence> {
	try {
		const stat = await vscode.workspace.fs.stat(uri);
		return { uri: uri.toString(), exists: true, size: stat.size, mtime: stat.mtime };
	} catch {
		return { uri: uri.toString(), exists: false };
	}
}

/**
 * Inspects the Copilot extension's manifest and, when it is *already* active,
 * the keys of its exports. It never calls `activate()`: activating another
 * extension is a side effect this probe has no business causing.
 */
export function inspectCopilotSurface(): CopilotSurface {
	const extension = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID);
	if (!extension) {
		return { installed: false, declaredApiProposals: 0, exportedKeys: [], exposesConversation: false };
	}

	const manifest = extension.packageJSON as { version?: string; enabledApiProposals?: unknown[] };
	let exportedKeys: string[] = [];
	if (extension.isActive && extension.exports && typeof extension.exports === 'object') {
		exportedKeys = Object.keys(extension.exports as object).sort();
	}

	return {
		installed: true,
		version: manifest.version,
		declaredApiProposals: Array.isArray(manifest.enabledApiProposals)
			? manifest.enabledApiProposals.length
			: 0,
		exportedKeys,
		exposesConversation: exportedKeys.some((key) => /chat|session|transcript|conversation/i.test(key)),
	};
}

/**
 * Collects the probe. `storageUri` is an extension's own
 * `ExtensionContext.storageUri`; omit it (as a test host without a workspace
 * must) and the record section is simply left out.
 */
export async function collectTranscriptProbe(
	storageUri?: vscode.Uri,
	sessionId?: string,
): Promise<TranscriptProbeResult> {
	const copilot = inspectCopilotSurface();
	if (!storageUri || !sessionId) {
		return {
			vscodeVersion: vscode.version,
			copilot,
			readMessageContent: false,
			invokedChat: false,
		};
	}

	const paths = sessionRecordPaths(storageUri, sessionId);
	return {
		vscodeVersion: vscode.version,
		copilot,
		records: {
			sessionId,
			workbenchJournal: await presence(paths.workbenchJournal),
			copilotTranscript: await presence(paths.copilotTranscript),
		},
		readMessageContent: false,
		invokedChat: false,
	};
}
