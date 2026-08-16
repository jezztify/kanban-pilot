import * as vscode from 'vscode';

/** The stable identity and user-facing name of one workspace-local task set. */
export interface TaskSet {
	id: string;
	name: string;
	directory: vscode.Uri;
	isDefault: boolean;
}

export const DEFAULT_TASK_SET_ID = 'default';
export const DEFAULT_TASK_SET_NAME = 'Default';

interface StoredTaskSet {
	id: string;
	name: string;
}

interface RegistryDocument {
	version: 1;
	activeSetId: string;
	sets: StoredTaskSet[];
}

/** A user-correctable task-set operation error with a board-friendly message. */
export class TaskSetError extends Error {
	constructor(
		public readonly code:
			| 'invalid-name'
			| 'duplicate-name'
			| 'not-found'
			| 'default-set'
			| 'not-empty'
			| 'active-run',
		message: string,
	) {
		super(message);
		this.name = 'TaskSetError';
	}
}

function workspaceRelativeParts(subPath: string): string[] {
	return subPath
		.replace(/\\/g, '/')
		.split('/')
		.filter((part) => part && part !== '.' && part !== '..');
}

function normalizeName(name: string): string {
	const normalized = name.trim().replace(/\s+/g, ' ');
	if (!normalized) {
		throw new TaskSetError('invalid-name', 'Task-set names cannot be blank.');
	}
	if (normalized.length > 80) {
		throw new TaskSetError('invalid-name', 'Task-set names must be 80 characters or fewer.');
	}
	return normalized;
}

function isStoredSet(value: unknown): value is StoredTaskSet {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<StoredTaskSet>;
	return typeof candidate.id === 'string' && typeof candidate.name === 'string';
}

function defaultDocument(): RegistryDocument {
	return {
		version: 1,
		activeSetId: DEFAULT_TASK_SET_ID,
		sets: [{ id: DEFAULT_TASK_SET_ID, name: DEFAULT_TASK_SET_NAME }],
	};
}

/**
 * Owns the small workspace-local registry that maps stable set ids to names.
 * The legacy configured task folder is deliberately not moved: it is always
 * resolved as the immutable Default set. New sets live below
 * `.kanban-pilot/task-sets/<id>/tasks`.
 */
export class TaskSetRegistry {
	private readonly metadataUri: vscode.Uri;
	private readonly registryDirectory: vscode.Uri;
	private readonly additionalSetsUri: vscode.Uri;
	private readonly defaultDirectory: vscode.Uri;
	private document: RegistryDocument | undefined;
	private initialization: Promise<void> | undefined;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly workspaceFolder: vscode.WorkspaceFolder,
		legacyTasksDir = '.kanban-pilot/tasks',
	) {
		this.registryDirectory = vscode.Uri.joinPath(workspaceFolder.uri, '.kanban-pilot');
		this.metadataUri = vscode.Uri.joinPath(this.registryDirectory, 'task-sets.json');
		this.additionalSetsUri = vscode.Uri.joinPath(this.registryDirectory, 'task-sets');
		this.defaultDirectory = vscode.Uri.joinPath(workspaceFolder.uri, ...workspaceRelativeParts(legacyTasksDir));
	}

	get registryFile(): vscode.Uri {
		return this.metadataUri;
	}

	get defaultSet(): TaskSet {
		return {
			id: DEFAULT_TASK_SET_ID,
			name: DEFAULT_TASK_SET_NAME,
			directory: this.defaultDirectory,
			isDefault: true,
		};
	}

	private async ensureInitialized(): Promise<void> {
		if (this.document) {
			return;
		}
		if (!this.initialization) {
			this.initialization = this.load();
		}
		await this.initialization;
	}

	private async load(): Promise<void> {
		let raw: string | undefined;
		try {
			raw = Buffer.from(await vscode.workspace.fs.readFile(this.metadataUri)).toString('utf8');
		} catch {
			// First use, or an older workspace without task-set metadata.
		}

		let parsed: unknown;
		if (raw) {
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
		}

		const candidate = parsed && typeof parsed === 'object' ? (parsed as Partial<RegistryDocument>) : undefined;
		const seen = new Set<string>();
		const sets: StoredTaskSet[] = [{ id: DEFAULT_TASK_SET_ID, name: DEFAULT_TASK_SET_NAME }];
		seen.add(DEFAULT_TASK_SET_ID);
		if (Array.isArray(candidate?.sets)) {
			for (const value of candidate.sets) {
				if (!isStoredSet(value) || !/^set-[a-z0-9-]+$/.test(value.id) || seen.has(value.id)) {
					continue;
				}
				let name: string;
				try {
					name = normalizeName(value.name);
				} catch {
					continue;
				}
				if (sets.some((set) => set.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
					continue;
				}
				sets.push({ id: value.id, name });
				seen.add(value.id);
			}
		}

		const activeSetId = typeof candidate?.activeSetId === 'string' && seen.has(candidate.activeSetId)
			? candidate.activeSetId
			: DEFAULT_TASK_SET_ID;
		const document: RegistryDocument = { version: 1, activeSetId, sets };

		// Persisting on first access both creates the registry and repairs a
		// malformed/obsolete document without touching any task file.
		if (!raw || JSON.stringify(parsed) !== JSON.stringify(document)) {
			await this.write(document);
		}
		this.document = document;
	}

	private taskSetFromStored(stored: StoredTaskSet): TaskSet {
		const isDefault = stored.id === DEFAULT_TASK_SET_ID;
		return {
			id: stored.id,
			name: stored.name,
			directory: isDefault
				? this.defaultDirectory
				: vscode.Uri.joinPath(this.additionalSetsUri, stored.id, 'tasks'),
			isDefault,
		};
	}

	private requireSet(id: string): StoredTaskSet {
		const stored = this.document!.sets.find((set) => set.id === id);
		if (!stored) {
			throw new TaskSetError('not-found', `Task set '${id}' was not found.`);
		}
		return stored;
	}

	private async write(document: RegistryDocument): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.registryDirectory);
		const temp = this.metadataUri.with({ path: `${this.metadataUri.path}.tmp` });
		await vscode.workspace.fs.writeFile(temp, Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8'));
		await vscode.workspace.fs.rename(temp, this.metadataUri, { overwrite: true });
	}

	private newSetId(document: RegistryDocument): string {
		let id: string;
		do {
			id = `set-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
		} while (document.sets.some((set) => set.id === id));
		return id;
	}

	private async mutate<T>(operation: (document: RegistryDocument) => Promise<T>): Promise<T> {
		const previous = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise<void>((resolve) => (release = resolve));
		await previous;
		try {
			await this.ensureInitialized();
			const document = this.document!;
			const before: RegistryDocument = {
				version: document.version,
				activeSetId: document.activeSetId,
				sets: document.sets.map((set) => ({ ...set })),
			};
			try {
				return await operation(document);
			} catch (error) {
				document.version = before.version;
				document.activeSetId = before.activeSetId;
				document.sets = before.sets;
				throw error;
			}
		} finally {
			release();
		}
	}

	async list(): Promise<TaskSet[]> {
		await this.ensureInitialized();
		return this.document!.sets.map((set) => this.taskSetFromStored(set));
	}

	async active(): Promise<TaskSet> {
		await this.ensureInitialized();
		return this.taskSetFromStored(this.requireSet(this.document!.activeSetId));
	}

	async get(id: string): Promise<TaskSet> {
		await this.ensureInitialized();
		return this.taskSetFromStored(this.requireSet(id));
	}

	/** Creates an empty set and selects it as active. */
	async create(name: string): Promise<TaskSet> {
		return this.mutate(async (document) => {
			const normalized = normalizeName(name);
			if (document.sets.some((set) => set.name.toLocaleLowerCase() === normalized.toLocaleLowerCase())) {
				throw new TaskSetError('duplicate-name', `A task set named '${normalized}' already exists.`);
			}

			const id = this.newSetId(document);
			const stored = { id, name: normalized };
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.additionalSetsUri, id, 'tasks'));
			document.sets.push(stored);
			document.activeSetId = id;
			await this.write(document);
			return this.taskSetFromStored(stored);
		});
	}

	async rename(id: string, name: string): Promise<TaskSet> {
		return this.mutate(async (document) => {
			const stored = this.requireSet(id);
			if (stored.id === DEFAULT_TASK_SET_ID) {
				throw new TaskSetError('default-set', 'The Default task set cannot be renamed.');
			}
			const normalized = normalizeName(name);
			if (
				document.sets.some(
					(set) => set.id !== id && set.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
				)
			) {
				throw new TaskSetError('duplicate-name', `A task set named '${normalized}' already exists.`);
			}
			stored.name = normalized;
			await this.write(document);
			return this.taskSetFromStored(stored);
		});
	}

	async select(id: string): Promise<TaskSet> {
		return this.mutate(async (document) => {
			this.requireSet(id);
			document.activeSetId = id;
			await this.write(document);
			return this.taskSetFromStored(this.requireSet(id));
		});
	}

	/**
	 * Deletes only an empty non-default set. The emptiness check happens before
	 * any registry or directory write, so a rejected operation cannot remove a
	 * task file.
	 */
	async delete(id: string): Promise<void> {
		await this.mutate(async (document) => {
			const stored = this.requireSet(id);
			if (stored.id === DEFAULT_TASK_SET_ID) {
				throw new TaskSetError('default-set', 'The Default task set cannot be deleted.');
			}

			const set = this.taskSetFromStored(stored);
			let entries: [string, vscode.FileType][] = [];
			try {
				entries = await vscode.workspace.fs.readDirectory(set.directory);
			} catch {
				// A missing additional-set directory is equivalent to an empty set.
			}
			if (entries.length > 0) {
				throw new TaskSetError('not-empty', `Task set '${stored.name}' must be empty before it can be deleted.`);
			}

			document.sets = document.sets.filter((candidate) => candidate.id !== id);
			if (document.activeSetId === id) {
				document.activeSetId = DEFAULT_TASK_SET_ID;
			}
			try {
				await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.additionalSetsUri, stored.id), { recursive: true });
			} catch (error) {
				if (!(error instanceof vscode.FileSystemError) || error.code !== 'FileNotFound') {
					throw error;
				}
			}
			await this.write(document);
		});
	}
}