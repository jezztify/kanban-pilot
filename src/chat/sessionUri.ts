import * as vscode from 'vscode';

/**
 * Derivation of VS Code chat session URIs (PRD §6.7).
 *
 * Mirrors `LocalChatSessionUri.forSession` in
 * `vs/workbench/contrib/chat/common/model/chatUri.ts`:
 *
 *   scheme    = Schemas.vscodeLocalChatSession  ('vscode-chat-session')
 *   authority = SessionType.Local               ('local')
 *   path      = '/' + base64url(sessionId), unpadded
 *
 * Session ids are arbitrary text, so deriving one from a task id makes
 * "one chat per task" structural rather than bookkeeping (§6.7, §8.5): the
 * URI is a pure function of the task id, so two tasks cannot collide and the
 * binding survives window reloads with no bookkeeping beyond the `chat:`
 * frontmatter field.
 *
 * M0 confirmed (against VS Code 1.133) that this binding works — two derived
 * URIs open two distinct tabs, and reopening one refocuses it rather than
 * forking a second conversation — see docs/m0-findings.md findings 4–5.
 */

export const CHAT_SESSION_SCHEME = 'vscode-chat-session';
export const LOCAL_SESSION_TYPE = 'local';
export const DEFAULT_SESSION_PREFIX = 'kanban-pilot-';
export const DEFAULT_TASK_SET_ID = 'default';

export function encodeSessionId(sessionId: string): string {
	return Buffer.from(sessionId, 'utf8').toString('base64url');
}

export function decodeSessionId(encoded: string): string {
	return Buffer.from(encoded, 'base64url').toString('utf8');
}

export function sessionIdForTask(
	taskId: string,
	prefix = DEFAULT_SESSION_PREFIX,
	setId = DEFAULT_TASK_SET_ID,
): string {
	return `${prefix}${setId === DEFAULT_TASK_SET_ID ? taskId : `${setId}-${taskId}`}`;
}

/**
 * Returns true when the task has no known Copilot conversation identity yet.
 * A missing chat field and the deterministic binding written before a first
 * run are both placeholders; a non-derived legacy chat value is treated as a
 * real persisted conversation for backwards compatibility.
 */
export function isFirstUseTaskChat(
	task: { id: string; chat?: string; copilotSessionId?: string },
	prefix = DEFAULT_SESSION_PREFIX,
	setId = DEFAULT_TASK_SET_ID,
): boolean {
	return !task.copilotSessionId
		&& (!task.chat || task.chat === sessionIdForTask(task.id, prefix, setId));
}

/**
 * Resolves the durable `vscode-chat-session://local` id used to open, reopen,
 * dock, continue, and close a task's conversation.
 *
 * Copilot's returned `metadata.sessionId` (persisted as `copilot_session_id`)
 * is Copilot's own conversation UUID, NOT a valid `LocalChatSessionUri` id
 * (M0 finding 9). Building the reopen URI from it opens a brand-new empty chat
 * instead of the task's existing conversation, which is the "a new chat is
 * created when the task moves/reopens" defect. That id is therefore kept only
 * for post-run misroute detection and never used here.
 *
 * The binding is the derived local-session id, honouring an explicit `chat`
 * value (e.g. a legacy binding, or one pinned across a session-prefix change).
 * A `chat` field that was previously polluted with the Copilot UUID — the only
 * way it can equal `copilot_session_id` — is ignored so the binding self-heals
 * back to the stable derived local-session id.
 */
export function sessionIdForTaskBinding(
	task: { id: string; chat?: string; copilotSessionId?: string },
	prefix = DEFAULT_SESSION_PREFIX,
	setId = DEFAULT_TASK_SET_ID,
): string {
	if (task.chat && task.chat !== task.copilotSessionId) {
		return task.chat;
	}
	return sessionIdForTask(task.id, prefix, setId);
}

export function sessionUriForId(sessionId: string): vscode.Uri {
	return vscode.Uri.from({
		scheme: CHAT_SESSION_SCHEME,
		authority: LOCAL_SESSION_TYPE,
		path: '/' + encodeSessionId(sessionId),
	});
}

export function sessionUriForTask(
	taskId: string,
	prefix = DEFAULT_SESSION_PREFIX,
	setId = DEFAULT_TASK_SET_ID,
): vscode.Uri {
	return sessionUriForTaskBinding({ id: taskId }, prefix, setId);
}

/** Returns the URI for a task using its persisted binding when available. */
export function sessionUriForTaskBinding(
	task: { id: string; chat?: string; copilotSessionId?: string },
	prefix = DEFAULT_SESSION_PREFIX,
	setId = DEFAULT_TASK_SET_ID,
): vscode.Uri {
	return sessionUriForId(sessionIdForTaskBinding(task, prefix, setId));
}

/** Inverse of {@link sessionUriForId}; undefined when the uri is not a local chat session. */
export function parseSessionUri(uri: vscode.Uri): string | undefined {
	if (uri.scheme !== CHAT_SESSION_SCHEME) {
		return undefined;
	}
	const parts = uri.path.split('/');
	if (parts.length !== 2 || !parts[1]) {
		return undefined;
	}
	try {
		return decodeSessionId(parts[1]);
	} catch {
		return undefined;
	}
}
