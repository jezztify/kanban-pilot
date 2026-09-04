import * as vscode from 'vscode';

/** The only levels that can cross the Workspace Activity persistence boundary. */
export type WorkspaceActivityLevel = 'success' | 'warning' | 'error';

/** Maximum number of valid records exposed by one active task set. */
export const WORKSPACE_ACTIVITY_LIMIT = 100;
/** Bounds the user-visible message stored in the workspace history. */
export const WORKSPACE_ACTIVITY_MAX_MESSAGE_LENGTH = 1000;
/** Bounds the optional task title copied into the workspace history. */
export const WORKSPACE_ACTIVITY_MAX_TASK_TITLE_LENGTH = 200;
export const WORKSPACE_ACTIVITY_DIRECTORY = '.kanban-pilot/workspace-activity';

export interface WorkspaceActivityRecord {
	timestamp: string;
	level: WorkspaceActivityLevel;
	message: string;
	taskId?: string;
	taskTitle?: string;
}

/** Input accepted by the extension-owned activity writer. */
export interface WorkspaceActivityInput {
	level: WorkspaceActivityLevel | string;
	message: string;
	timestamp?: string | Date;
	/** Compatibility alias for the task-detail feed's timestamp vocabulary. */
	at?: string | Date;
	taskId?: string;
	taskTitle?: string;
}

const TASK_ID = /^TASK-\d+$/;
const TASK_SET_ID = /^(?:default|set-[a-z0-9-]+)$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

function isActivityLevel(value: unknown): value is WorkspaceActivityLevel {
	return value === 'success' || value === 'warning' || value === 'error';
}

/** Validates the stable id before it is ever used to construct a filesystem path. */
export function isValidWorkspaceActivityTaskSetId(value: unknown): value is string {
	return typeof value === 'string' && TASK_SET_ID.test(value);
}

/**
 * Replaces filesystem-looking values before control characters and whitespace are
 * normalized. The replacement is deliberately plain text: an activity row must
 * never turn an error detail into a clickable or reconstructable local path.
 */
function redactAbsolutePaths(value: string): string {
	return value
		.replace(/file:(?:\/\/\/|\\\\)[^\s"'<>]+/gi, '[path omitted]')
		.replace(/(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>]+/g, '$1[path omitted]')
		.replace(/(?:^|[\s("'=])\/(?:[^\/\s"'<>]+\/)+[^\/\s"'<>]*/g, '$1[path omitted]');
}

function sanitizeText(value: unknown, maxLength: number): string {
	let text = typeof value === 'string' ? value : String(value ?? '');
	text = redactAbsolutePaths(text)
		.replace(CONTROL_CHARACTERS, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length > maxLength) {
		text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
	}
	return text;
}

function canonicalTimestamp(value: unknown, fallback?: Date): string | undefined {
	const date = value instanceof Date
		? new Date(value.getTime())
		: typeof value === 'string' && value.trim()
			? new Date(value)
			: fallback;
	if (!date || !Number.isFinite(date.getTime())) {
		return undefined;
	}
	return date.toISOString();
}

/** Normalizes caller input into a safe, always-renderable activity record. */
export function normalizeWorkspaceActivityInput(
	input: WorkspaceActivityInput,
	now = new Date(),
): WorkspaceActivityRecord {
	const timestamp = canonicalTimestamp(input.timestamp ?? input.at, now) ?? now.toISOString();
	const message = sanitizeText(input.message, WORKSPACE_ACTIVITY_MAX_MESSAGE_LENGTH)
		|| 'Workspace activity recorded.';
	const taskId = typeof input.taskId === 'string' && TASK_ID.test(input.taskId)
		? input.taskId
		: undefined;
	const taskTitle = sanitizeText(input.taskTitle, WORKSPACE_ACTIVITY_MAX_TASK_TITLE_LENGTH);
	return {
		timestamp,
		level: isActivityLevel(input.level) ? input.level : 'warning',
		message,
		...(taskId ? { taskId } : {}),
		...(taskTitle ? { taskTitle } : {}),
	};
}

/**
 * Parses one JSON-lines value. Invalid enum/timestamp/message records are
 * ignored, while safe redaction of otherwise readable text still applies.
 */
function recordFromStored(value: unknown): WorkspaceActivityRecord | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}
	const candidate = value as Partial<WorkspaceActivityRecord>;
	if (!isActivityLevel(candidate.level) || typeof candidate.timestamp !== 'string') {
		return undefined;
	}
	if (!candidate.timestamp.trim() || !Number.isFinite(Date.parse(candidate.timestamp))) {
		return undefined;
	}
	if (typeof candidate.message !== 'string' || !candidate.message.trim() ||
		candidate.message.length > WORKSPACE_ACTIVITY_MAX_MESSAGE_LENGTH) {
		return undefined;
	}
	if (candidate.taskTitle !== undefined && (
		typeof candidate.taskTitle !== 'string' ||
		candidate.taskTitle.length > WORKSPACE_ACTIVITY_MAX_TASK_TITLE_LENGTH
	)) {
		return undefined;
	}
	const taskId = typeof candidate.taskId === 'string' && TASK_ID.test(candidate.taskId)
		? candidate.taskId
		: undefined;
	const taskTitle = sanitizeText(candidate.taskTitle, WORKSPACE_ACTIVITY_MAX_TASK_TITLE_LENGTH);
	const message = sanitizeText(candidate.message, WORKSPACE_ACTIVITY_MAX_MESSAGE_LENGTH);
	if (!message) {
		return undefined;
	}
	return {
		timestamp: new Date(candidate.timestamp).toISOString(),
		level: candidate.level,
		message,
		...(taskId ? { taskId } : {}),
		...(taskTitle ? { taskTitle } : {}),
	};
}

interface ParsedRecord {
	record: WorkspaceActivityRecord;
	position: number;
}

/**
 * Stores read-only board outcomes separately from task Markdown. A JSON-lines
 * file keeps one malformed hand-edited line from hiding its valid neighbors.
 */
export class WorkspaceActivityStore {
	private static readonly mutationTails = new Map<string, Promise<void>>();
	private readonly directoryUri: vscode.Uri;
	private readonly fileUri: vscode.Uri;
	private readonly changed = new vscode.EventEmitter<WorkspaceActivityRecord>();
	private revisionValue = 0;

	constructor(
		private readonly workspaceRoot: vscode.Uri,
		readonly taskSetId: string,
	) {
		if (!isValidWorkspaceActivityTaskSetId(taskSetId)) {
			throw new Error('Invalid task-set id for workspace activity.');
		}
		this.directoryUri = vscode.Uri.joinPath(workspaceRoot, '.kanban-pilot', 'workspace-activity');
		this.fileUri = vscode.Uri.joinPath(this.directoryUri, `${taskSetId}.jsonl`);
	}

	get directory(): vscode.Uri {
		return this.directoryUri;
	}

	get file(): vscode.Uri {
		return this.fileUri;
	}

	get activityFile(): vscode.Uri {
		return this.fileUri;
	}

	get revision(): number {
		return this.revisionValue;
	}

	onDidChange(listener: (record: WorkspaceActivityRecord) => void): vscode.Disposable {
		return this.changed.event(listener);
	}

	async ensureDirectory(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.directoryUri);
	}

	private mutationKey(): string {
		return this.fileUri.toString();
	}

	private currentMutationTail(): Promise<void> {
		return WorkspaceActivityStore.mutationTails.get(this.mutationKey()) ?? Promise.resolve();
	}

	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const key = this.mutationKey();
		const previous = this.currentMutationTail();
		const run = previous.then(operation);
		const settled = run.then(() => undefined, () => undefined);
		WorkspaceActivityStore.mutationTails.set(key, settled);
		return run;
	}

	private async readRaw(): Promise<string> {
		try {
			return Buffer.from(await vscode.workspace.fs.readFile(this.fileUri)).toString('utf8');
		} catch {
			return '';
		}
	}

	private async writeAppended(raw: string, record: WorkspaceActivityRecord): Promise<void> {
		await this.ensureDirectory();
		const prefix = raw && !raw.endsWith('\n') ? `${raw}\n` : raw;
		const content = `${prefix}${JSON.stringify(record)}\n`;
		const temporary = this.fileUri.with({
			path: `${this.fileUri.path}.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.tmp`,
		});
		try {
			await vscode.workspace.fs.writeFile(temporary, Buffer.from(content, 'utf8'));
			await vscode.workspace.fs.rename(temporary, this.fileUri, { overwrite: true });
		} finally {
			try {
				await vscode.workspace.fs.delete(temporary);
			} catch {
				/* The rename already removed the temporary file. */
			}
		}
	}

	async append(input: WorkspaceActivityInput): Promise<WorkspaceActivityRecord> {
		return this.serialize(async () => {
			const record = normalizeWorkspaceActivityInput(input);
			const raw = await this.readRaw();
			await this.writeAppended(raw, record);
			this.revisionValue += 1;
			this.changed.fire(record);
			return record;
		});
	}

	/** Returns valid records newest first, without rewriting or pruning the log. */
	async readAll(): Promise<WorkspaceActivityRecord[]> {
		await this.currentMutationTail();
		const raw = await this.readRaw();
		const records: ParsedRecord[] = [];
		for (const [position, line] of raw.split(/\r?\n/).entries()) {
			if (!line.trim()) {
				continue;
			}
			try {
				const record = recordFromStored(JSON.parse(line));
				if (record) {
					records.push({ record, position });
				}
			} catch {
				// One malformed JSON line must not hide neighboring valid records.
			}
		}
		return records
			.sort((left, right) => {
				const timestampOrder = Date.parse(right.record.timestamp) - Date.parse(left.record.timestamp);
				return timestampOrder || right.position - left.position;
			})
			.slice(0, WORKSPACE_ACTIVITY_LIMIT)
			.map(({ record }) => record);
	}

	dispose(): void {
		this.changed.dispose();
	}
}
