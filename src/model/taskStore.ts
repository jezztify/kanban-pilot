import * as vscode from 'vscode';
import {
	appendLogLine,
	COLUMNS,
	Column,
	EditableTaskContent,
	PendingOutcome,
	Status,
	isTaskType,
	isValidTaskPosition,
	NewTaskOptions,
	Task,
	TaskType,
	normalizeEditableTaskContent,
	newTaskFile,
	parseFile,
	parsePendingOutcome,
	taskFromRaw,
	updateEditableTaskContent,
	updateFrontmatter,
} from './task';
import {
	auditLifecycleKey,
	AuditEvent,
	AuditEventInput,
	formatAuditEvent,
	normaliseAuditEvent,
	parseAuditEvents,
} from './taskLog';

/**
 * Reads and writes the task folder (PRD §6.3, §8.1).
 *
 * Disk is authoritative (R5). The store never caches a mutable copy: every
 * `readAll` goes to the filesystem, so hand-editing a task file and clicking a
 * card are the same operation as far as the board is concerned (G5).
 */

export interface BoardSnapshot {
	columns: { id: Column; tasks: Task[] }[];
	/** Files that parsed badly — surfaced rather than silently dropped (R4). */
	malformed: string[];
	}

/** A stable target for a within-column reorder. Exactly one member is used. */
export interface ReorderTarget {
	targetIndex?: number;
	beforeTaskId?: string | null;
}

export type StoreReorderOutcome =
	| { kind: 'applied' }
	| { kind: 'no-op' }
	| { kind: 'invalid' }
	| { kind: 'not-found' }
	| { kind: 'stale' };

export type TaskChangeKind = 'position-only' | 'other';

interface AtomicWrite {
	uri: vscode.Uri;
	content: string;
	positionOnly?: boolean;
}

interface AtomicBatchEntry extends AtomicWrite {
	temp: vscode.Uri;
	backup: vscode.Uri;
	original?: Uint8Array;
	existed: boolean;
	commitAttempted: boolean;
}

export interface AuditedPatchOptions {
	/** Human-readable action that caused automatic state/status audit entries. */
	action?: string;
	/** Run context for automatic state/status entries. */
	runId?: string;
	/** Outcome context for automatic state/status entries. */
	outcome?: AuditEventInput['outcome'];
	/** Additional extension-owned lifecycle events to append in the same write. */
	events?: AuditEventInput[];
	/** Shared timestamp for automatically generated transition events. */
	now?: Date;
	/** Optional compare-and-set values used by one-time pending promotion. */
	expected?: {
		state?: Column;
		status?: Status;
		pendingOutcome?: PendingOutcome;
	};
}

export class TaskMutationConflictError extends Error {
	constructor(message = 'The task changed before the requested mutation could be applied.') {
		super(message);
		this.name = 'TaskMutationConflictError';
	}
}

const TASK_FILE = /^(TASK-\d+)\.md$/;

function compareTaskIds(a: Task, b: Task): number {
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Positions are intentionally sparse and may have been hand-edited. Valid
 * values sort first; absent/invalid values retain a deterministic legacy
 * order after them. A successful reorder writes a contiguous sequence and
 * therefore normalises both kinds of legacy data.
 */
function orderTasks(tasks: Task[]): Task[] {
	const positioned = tasks.filter((task) => isValidTaskPosition(task.position));
	const legacy = tasks.filter((task) => !isValidTaskPosition(task.position)).sort(compareTaskIds);
	const base = positioned.length > 0
		? Math.max(...positioned.map((task) => task.position!)) + 1
		: 0;
	const legacyRank = new Map(legacy.map((task, index) => [task.id, index]));

	return [...tasks].sort((a, b) => {
		const aKey = isValidTaskPosition(a.position) ? a.position : base + legacyRank.get(a.id)!;
		const bKey = isValidTaskPosition(b.position) ? b.position : base + legacyRank.get(b.id)!;
		if (aKey !== bKey) {
			return aKey - bKey;
		}
		return compareTaskIds(a, b);
	});
}

function taskIdFromUri(uri: vscode.Uri): string | undefined {
	const name = uri.path.split('/').pop() ?? '';
	return TASK_FILE.exec(name)?.[1];
}

function isColumn(value: unknown): value is Column {
	return typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);
}

function pendingOutcomesEqual(left: PendingOutcome | undefined, right: PendingOutcome | undefined): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validatePendingUpdate(updates: Record<string, string | undefined>): void {
	if (!Object.prototype.hasOwnProperty.call(updates, 'pending_outcome') || updates.pending_outcome === undefined) {
		return;
	}
	if (!parsePendingOutcome(updates.pending_outcome)) {
		throw new Error('Invalid pending outcome metadata.');
	}
}

export class TaskStore {
	private mutationTail: Promise<void> = Promise.resolve();
	private typeMigrationTail: Promise<void> = Promise.resolve();
	private readonly pendingPositionOnlyChanges = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private readonly tasksDir: vscode.Uri,
		public readonly setId = 'default',
		private readonly renameFile: vscode.FileSystem['rename'] = vscode.workspace.fs.rename.bind(vscode.workspace.fs),
	) {}

	static forWorkspace(
		folder: vscode.WorkspaceFolder,
		subPath = '.kanban-pilot/tasks',
		setId = 'default',
	): TaskStore {
		return new TaskStore(vscode.Uri.joinPath(folder.uri, ...subPath.replace(/\\/g, '/').split('/')), setId);
	}

	get directory(): vscode.Uri {
		return this.tasksDir;
	}

	fileFor(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.tasksDir, `${id}.md`);
	}

	async ensureDirectory(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.tasksDir);
	}

	private async listFiles(): Promise<string[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.tasksDir);
			return entries
				.filter(([name, type]) => type === vscode.FileType.File && TASK_FILE.test(name))
				.map(([name]) => name)
				.sort();
		} catch {
			return [];
		}
	}

	/** Backfills only the missing/invalid legacy type, leaving the body intact. */
	private async backfillLegacyType(uri: vscode.Uri, initialRaw: string): Promise<string> {
		const previous = this.typeMigrationTail;
		let release!: () => void;
		this.typeMigrationTail = new Promise<void>((resolve) => (release = resolve));
		await previous;
		// A public read can race an extension-owned mutation. Wait for the current
		// mutation before re-reading so migration never restores stale metadata.
		await this.mutationTail;
		try {
			let raw = initialRaw;
			try {
				raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				return initialRaw;
			}

			const parsed = parseFile(raw);
			if (parsed.malformed || isTaskType(parsed.frontmatter.type)) {
				return raw;
			}

			const migrated = updateFrontmatter(raw, { type: 'feature' });
			await this.writeAtomic(uri, migrated);
			return migrated;
		} finally {
			release();
		}
	}

	private async readAllInternal(backfillLegacyTypes: boolean): Promise<{ tasks: Task[]; malformed: string[] }> {
		const tasks: Task[] = [];
		const malformed: string[] = [];

		for (const name of await this.listFiles()) {
			const uri = vscode.Uri.joinPath(this.tasksDir, name);
			let raw: string;
			try {
				raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				malformed.push(name);
				continue;
			}

			const parsed = parseFile(raw);
			let task = taskFromRaw(raw, TASK_FILE.exec(name)?.[1], this.setId);
			if (task) {
				if (backfillLegacyTypes && !isTaskType(parsed.frontmatter.type)) {
					try {
						raw = await this.backfillLegacyType(uri, raw);
						task = taskFromRaw(raw, TASK_FILE.exec(name)?.[1], this.setId) ?? task;
					} catch {
						// A read-only legacy file still remains visible with its
						// deterministic in-memory Feature classification.
					}
				}
				tasks.push(task);
			} else {
				malformed.push(name);
			}
		}

		return { tasks, malformed };
	}

	async readAll(): Promise<{ tasks: Task[]; malformed: string[] }> {
		return this.readAllInternal(true);
	}

	/** The board as the webview consumes it: every column present, even when empty. */
	async snapshot(): Promise<BoardSnapshot> {
		const { tasks, malformed } = await this.readAll();

		return {
			columns: COLUMNS.map((id) => ({
				id,
				tasks: orderTasks(tasks.filter((t) => t.state === id)),
			})),
			malformed,
		};
	}

	/**
	 * Next free id. Scans for `max + 1` rather than keeping a counter, so two
	 * branches that each add tasks merge without fighting over a registry file
	 * (§8.1). Gaps are expected and harmless.
	 */
	async nextId(): Promise<string> {
		const numbers = (await this.listFiles())
			.map((name) => Number(TASK_FILE.exec(name)?.[1].slice(5)))
			.filter((n) => Number.isFinite(n));

		const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
		return `TASK-${String(next).padStart(3, '0')}`;
	}

	/**
	 * Atomic write: temp file then rename (R5). A crash mid-write leaves the
	 * previous file intact rather than a truncated one the parser would reject.
	 */
	private async writeAtomic(uri: vscode.Uri, content: string): Promise<void> {
		this.clearPositionOnlyChange(taskIdFromUri(uri));
		const temp = uri.with({ path: `${uri.path}.tmp` });
		await vscode.workspace.fs.writeFile(temp, Buffer.from(content, 'utf8'));
		await this.renameFile(temp, uri, { overwrite: true });
	}

	/**
	 * Writes all prepared files through temporary paths before replacing any
	 * target. If a replacement fails, the targets already touched by the batch
	 * are restored from their captured originals before the temporary artifacts
	 * are removed. This keeps a failed reorder or create from leaving a partial
	 * column normalization behind.
	 */
	private async writeAtomicBatch(writes: AtomicWrite[]): Promise<void> {
		if (writes.length === 0) {
			return;
		}

		const batchId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		const temporary: AtomicBatchEntry[] = writes.map((write, index) => ({
			...write,
			temp: write.uri.with({ path: `${write.uri.path}.reorder.${batchId}.${index}.tmp` }),
			backup: write.uri.with({ path: `${write.uri.path}.reorder.${batchId}.${index}.bak` }),
			existed: false,
			commitAttempted: false,
		}));
		const positionOnlyIds = writes
			.filter((write) => write.positionOnly)
			.map((write) => taskIdFromUri(write.uri))
			.filter((id): id is string => id !== undefined);
		for (const write of writes) {
			const id = taskIdFromUri(write.uri);
			if (!id) {
				continue;
			}
			if (write.positionOnly) {
				this.markPositionOnlyChange(id);
			} else {
				this.clearPositionOnlyChange(id);
			}
		}
		let committed = false;
		try {
			for (const write of temporary) {
				try {
					write.original = await vscode.workspace.fs.readFile(write.uri);
					write.existed = true;
				} catch (error) {
					const code = typeof error === 'object' && error !== null && 'code' in error
						? (error as { code?: unknown }).code
						: undefined;
					if (code !== 'FileNotFound') {
						throw error;
					}
				}

				await vscode.workspace.fs.writeFile(write.temp, Buffer.from(write.content, 'utf8'));
				if (write.existed) {
					await vscode.workspace.fs.writeFile(write.backup, write.original!);
				}
			}
			for (const write of temporary) {
				write.commitAttempted = true;
				await this.renameFile(write.temp, write.uri, { overwrite: true });
			}
			committed = true;
		} catch (error) {
			// A provider can fail after one or more renames have succeeded. Restore
			// every target whose replacement was attempted, including the target
			// whose rename reported the failure in case the provider applied it first.
			for (const write of temporary) {
				if (!write.commitAttempted) {
					continue;
				}
				try {
					if (write.existed) {
						await vscode.workspace.fs.writeFile(write.uri, write.original!);
					} else {
						await vscode.workspace.fs.delete(write.uri);
					}
				} catch {
					// Preserve the original provider error. The rollback is best effort
					// because a failing provider may reject the restoration too.
				}
			}
			throw error;
		} finally {
			for (const write of temporary) {
				try {
					await vscode.workspace.fs.delete(write.temp);
				} catch {
					/* The rename already removed it, or the failed write left nothing. */
				}
				try {
					await vscode.workspace.fs.delete(write.backup);
				} catch {
					/* The target did not exist, or cleanup already removed it. */
				}
			}
			if (!committed && positionOnlyIds.length > 0) {
				// A failed batch must not leave a later unrelated watcher event marked
				// as an ordering-only mutation.
				for (const id of positionOnlyIds) {
					this.clearPositionOnlyChange(id);
				}
			}
		}
	}

	private markPositionOnlyChange(taskId: string): void {
		this.clearPositionOnlyChange(taskId);
		this.pendingPositionOnlyChanges.set(taskId, setTimeout(() => {
			this.pendingPositionOnlyChanges.delete(taskId);
		}, 1000));
	}

	private clearPositionOnlyChange(taskId: string | undefined): void {
		if (!taskId) {
			return;
		}
		const timer = this.pendingPositionOnlyChanges.get(taskId);
		if (timer !== undefined) {
			clearTimeout(timer);
			this.pendingPositionOnlyChanges.delete(taskId);
		}
	}

	private async positionWrites(tasks: Task[]): Promise<AtomicWrite[]> {
		const writes: AtomicWrite[] = [];
		for (const [index, task] of tasks.entries()) {
			if (task.position === index) {
				continue;
			}
			const uri = this.fileFor(task.id);
			let raw: string;
			try {
				raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				throw new Error(`Task ${task.id} could not be read while normalising order.`);
			}
			writes.push({ uri, content: updateFrontmatter(raw, { position: String(index) }), positionOnly: true });
		}
		return writes;
	}

	/** Serializes extension-owned writes so frontmatter and audit lines cannot split across mutations. */
	private async serialize<T>(mutation: () => Promise<T>): Promise<T> {
		// Migration writes use the same ordering boundary as ordinary mutations,
		// but mutation internals call readAllInternal(false) to avoid re-entrant
		// locking while they are already holding this queue.
		await this.typeMigrationTail;
		const previous = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => (release = resolve));
		await previous;
		try {
			return await mutation();
		} finally {
			release();
		}
	}

	async create(title: string, options?: NewTaskOptions): Promise<Task>;
	async create(title: string, type: TaskType, options?: Omit<NewTaskOptions, 'type'>): Promise<Task>;
	async create(
		title: string,
		typeOrOptions: TaskType | NewTaskOptions = {},
		suppliedOptions: Omit<NewTaskOptions, 'type'> = {},
	): Promise<Task> {
		return this.serialize(async () => {
			const options: NewTaskOptions = typeof typeOrOptions === 'string'
				? { ...suppliedOptions, type: typeOrOptions }
				: typeOrOptions;
			await this.ensureDirectory();
			const id = await this.nextId();
			const { tasks } = await this.readAllInternal(false);
			const backlog = orderTasks(tasks.filter((task) => task.state === 'backlog'));
			const position = backlog.length;
			const content = newTaskFile(id, title, {
				type: options.type,
				request: options?.request,
				origin: options?.origin,
				position,
				now: options?.now,
			});
			const writes = await this.positionWrites(backlog);
			writes.push({ uri: this.fileFor(id), content });
			await this.writeAtomicBatch(writes);

			const task = taskFromRaw(content, id, this.setId);
			if (!task) {
				throw new Error(`Generated an unparseable task file for ${id}`);
			}
			return task;
		});
	}

	/** Returns the position that appends a task to the requested column. */
	async endPosition(column: Column): Promise<number> {
		return this.serialize(async () => {
			const { tasks } = await this.readAllInternal(false);
			const ordered = orderTasks(tasks.filter((task) => task.state === column));
			const writes = await this.positionWrites(ordered);
			if (writes.length > 0) {
				await this.writeAtomicBatch(writes);
			}
			return ordered.length;
		});
	}

	/**
	 * Reorders one task within its current column. The complete target column
	 * is normalised in one serialized batch, while each file body and unrelated
	 * frontmatter value is preserved by updateFrontmatter.
	 */
	async reorder(taskId: string, column: Column, target: ReorderTarget): Promise<StoreReorderOutcome> {
		return this.serialize(async () => {
			const { tasks } = await this.readAllInternal(false);
			const matching = tasks.filter((task) => task.id === taskId);
			if (matching.length === 0) {
				return { kind: 'not-found' };
			}
			if (matching.length !== 1) {
				return { kind: 'stale' };
			}

			const task = matching[0];
			if (task.state !== column) {
				return { kind: 'stale' };
			}

			const current = orderTasks(tasks.filter((candidate) => candidate.state === column));
			const currentIndex = current.findIndex((candidate) => candidate.id === taskId);
			if (currentIndex === -1) {
				return { kind: 'stale' };
			}

			const remaining = current.filter((candidate) => candidate.id !== taskId);
			let insertionIndex: number;
			if (target.beforeTaskId !== undefined) {
				if (target.beforeTaskId === null) {
					insertionIndex = remaining.length;
				} else {
					const anchorIndexes = remaining
						.map((candidate, index) => candidate.id === target.beforeTaskId ? index : -1)
						.filter((index) => index !== -1);
					if (anchorIndexes.length !== 1) {
						if (target.beforeTaskId === taskId) {
							return { kind: 'no-op' };
						}
						return { kind: 'stale' };
					}
					insertionIndex = anchorIndexes[0];
				}
			} else if (target.targetIndex !== undefined) {
				insertionIndex = target.targetIndex;
			} else {
				return { kind: 'invalid' };
			}

			if (!Number.isInteger(insertionIndex) || insertionIndex < 0 || insertionIndex > remaining.length) {
				return { kind: 'invalid' };
			}

			const next = [...remaining];
			next.splice(insertionIndex, 0, task);
			if (next.every((candidate, index) => candidate.id === current[index].id)) {
				return { kind: 'no-op' };
			}

			const writes: AtomicWrite[] = [];
			for (const [index, candidate] of next.entries()) {
				if (candidate.position === index) {
					continue;
				}
				const uri = this.fileFor(candidate.id);
				let raw: string;
				try {
					raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
				} catch {
					return { kind: 'stale' };
				}
				writes.push({ uri, content: updateFrontmatter(raw, { position: String(index) }), positionOnly: true });
			}

			await this.writeAtomicBatch(writes);
			return { kind: 'applied' };
		});
	}

	/**
	 * Updates the user-editable task content through the same atomic path as
	 * other extension-owned writes. Runtime state and the append-only Log are
	 * intentionally not part of this operation.
	 */
	async edit(id: string, value: unknown): Promise<Task> {
		return this.serialize(async () => {
			if (typeof id !== 'string' || !TASK_FILE.test(`${id}.md`)) {
				throw new Error(`Invalid task id: ${String(id)}`);
			}

			const uri = this.fileFor(id);
			let raw: string;
			try {
				raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				throw new Error(`Task ${id} was not found.`);
			}

			const parsed = parseFile(raw);
			const current = taskFromRaw(raw, undefined, this.setId);
			if (!current || parsed.malformed || parsed.frontmatter.id !== id || current.id !== id) {
				throw new Error(`Task ${id} has an invalid task file.`);
			}
			if (current.status === 'running') {
				throw new Error(`Task ${id} is running and cannot be edited until the run stops.`);
			}

			const content: EditableTaskContent = normalizeEditableTaskContent(value);
			const edited = updateEditableTaskContent(raw, content);
			const now = new Date();
			const previousUpdated = current.updated ? Date.parse(current.updated) : Number.NaN;
			if (Number.isFinite(previousUpdated) && now.getTime() <= previousUpdated) {
				now.setTime(previousUpdated + 1000);
			}
			const updated = updateFrontmatter(edited, {
				updated: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
				pending_outcome: undefined,
			});
			await this.writeAtomic(uri, updated);

			const task = taskFromRaw(updated, id, this.setId);
			if (!task) {
				throw new Error(`Edited task ${id} could not be parsed after writing.`);
			}
			return task;
		});
	}

	/**
	 * Applies frontmatter changes, leaving the body untouched (§6.2). Always
	 * bumps `updated`.
	 */
	async patch(id: string, updates: Record<string, string | undefined>): Promise<void> {
		await this.serialize(async () => {
			validatePendingUpdate(updates);
			const uri = this.fileFor(id);
			const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			const invalidatesPending = ['state', 'status', 'run'].some((key) =>
				Object.prototype.hasOwnProperty.call(updates, key),
			);

			const next = updateFrontmatter(raw, {
				...updates,
				...(invalidatesPending && !Object.prototype.hasOwnProperty.call(updates, 'pending_outcome')
					? { pending_outcome: undefined }
					: {}),
				updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
			});

			await this.writeAtomic(uri, next);
		});
	}

	/**
	 * Applies frontmatter changes and extension-owned audit events as one
	 * serialized atomic mutation. State/status entries are emitted only when
	 * their value actually changes; lifecycle entries are de-duplicated by
	 * task/run/event identity so reload and late-receipt reconciliation are safe.
	 */
	async auditedPatch(
		id: string,
		updates: Record<string, string | undefined>,
		options: AuditedPatchOptions = {},
	): Promise<AuditEvent[]> {
		return this.serialize(async () => {
			validatePendingUpdate(updates);
			const uri = this.fileFor(id);
			const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			const before = taskFromRaw(raw, id, this.setId);
			if (!before) {
				throw new Error(`Cannot audit an unparseable task: ${id}`);
			}
			if (
				options.expected?.state !== undefined && before.state !== options.expected.state ||
				options.expected?.status !== undefined && before.status !== options.expected.status ||
				options.expected?.pendingOutcome !== undefined &&
				!pendingOutcomesEqual(before.pendingOutcome, options.expected.pendingOutcome)
			) {
				throw new TaskMutationConflictError();
			}

			const nextUpdates = { ...updates };
			const invalidatesPending = ['state', 'status', 'run'].some((key) =>
				Object.prototype.hasOwnProperty.call(updates, key),
			);
			if (invalidatesPending && !Object.prototype.hasOwnProperty.call(updates, 'pending_outcome')) {
				nextUpdates.pending_outcome = undefined;
			}
			let orderingWrites: AtomicWrite[] = [];
			if (isColumn(updates.state) && updates.state !== before.state) {
				const { tasks } = await this.readAllInternal(false);
				const destination = orderTasks(tasks.filter((task) => task.state === updates.state));
				orderingWrites = await this.positionWrites(destination);
				nextUpdates.position = String(destination.length);
			}

			const now = options.now ?? new Date();
			const transitionEvents: AuditEventInput[] = [];
			if (updates.state !== undefined && updates.state !== before.state) {
				transitionEvents.push({
					kind: 'state-change',
					from: before.state,
					to: updates.state,
					action: options.action ?? 'extension',
					runId: options.runId,
					outcome: options.outcome,
				});
			}
			if (updates.status !== undefined && updates.status !== before.status) {
				transitionEvents.push({
					kind: 'status-change',
					from: before.status,
					to: updates.status,
					action: options.action ?? 'extension',
					runId: options.runId,
					outcome: options.outcome,
				});
			}

			const existingLifecycleKeys = new Set(
				parseAuditEvents(before.sections['Log'] ?? '')
					.filter((event) => event.kind.startsWith('activity-'))
					.map(auditLifecycleKey),
			);
			const events: AuditEvent[] = [];
			const seenLifecycleKeys = new Set<string>();
			for (const input of [...transitionEvents, ...(options.events ?? [])]) {
				if (input.taskId !== undefined && input.taskId !== id) {
					throw new Error(`Audit event task id does not match ${id}`);
				}
				const event = normaliseAuditEvent(input, id, now);
				if (event.kind.startsWith('activity-')) {
					const key = auditLifecycleKey(event);
					if (existingLifecycleKeys.has(key) || seenLifecycleKeys.has(key)) {
						continue;
					}
					seenLifecycleKeys.add(key);
				}
				events.push(event);
			}

			let next = updateFrontmatter(raw, {
				...nextUpdates,
				updated: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
			});
			for (const event of events) {
				next = appendLogLine(next, formatAuditEvent(event));
			}
			await this.writeAtomicBatch([
				...orderingWrites,
				{ uri, content: next },
			]);
			return events;
		});
	}

	/**
	 * Appends one line to `## Log` (§6.3, §6.4) — used for the extension's own
	 * reconciliation receipts (timeouts, missing-receipt window-reload notes),
	 * alongside the agent's own append-only writes to the same section.
	 */
	async appendLog(id: string, line: string): Promise<void> {
		await this.serialize(async () => {
			const uri = this.fileFor(id);
			const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			await this.writeAtomic(uri, appendLogLine(raw, line));
		});
	}

	/** Fires on any change under the task folder. Disk is the source of truth. */
	watch(onChange: (taskId?: string, changeKind?: TaskChangeKind) => void): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.tasksDir, '*.md'),
		);
		const notify = (uri: vscode.Uri): void => {
			const taskId = taskIdFromUri(uri);
			const positionOnly = taskId !== undefined && this.pendingPositionOnlyChanges.has(taskId);
			onChange(taskId, positionOnly ? 'position-only' : 'other');
		};

		watcher.onDidCreate(notify);
		watcher.onDidChange(notify);
		watcher.onDidDelete(notify);

		return watcher;
	}
}
