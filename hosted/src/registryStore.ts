import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const MAX_NAME_LENGTH = 80;

export interface WorkspaceRegistration {
	id: string;
	name: string;
	boardUrl: string;
}

interface StoredWorkspace extends WorkspaceRegistration {
	lastSeenAt: string;
}

interface RegistryDocument {
	version: 1;
	workspaces: StoredWorkspace[];
}

export interface PublicWorkspace extends WorkspaceRegistration {
	available: true;
}

export function normalizeRegistration(value: unknown): WorkspaceRegistration {
	if (!value || typeof value !== 'object') {
		throw new Error('Registration must be an object.');
	}
	const input = value as Partial<WorkspaceRegistration>;
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!WORKSPACE_ID.test(id)) {
		throw new Error('Workspace id must use 1–80 letters, numbers, hyphens, or underscores.');
	}
	const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
	if (!name || name.length > MAX_NAME_LENGTH) {
		throw new Error('Workspace name must contain 1–80 characters.');
	}
	if (typeof input.boardUrl !== 'string') {
		throw new Error('Board URL is required.');
	}
	let url: URL;
	try { url = new URL(input.boardUrl); } catch { throw new Error('Board URL must be absolute.'); }
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error('Board URL must be a credential-free absolute HTTP(S) URL.');
	}
	url.search = '';
	url.hash = '';
	return { id, name, boardUrl: url.toString().replace(/\/$/, '') };
}

/** Durable JSON-backed registry storing only sanitized workspace discovery metadata. */
export class RegistryStore {
	private document: RegistryDocument = { version: 1, workspaces: [] };
	private loaded = false;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(private readonly dataFile: string, private readonly now: () => Date = () => new Date()) {}

	private async load(): Promise<void> {
		if (this.loaded) { return; }
		this.loaded = true;
		try {
			const parsed: unknown = JSON.parse(await readFile(this.dataFile, 'utf8'));
			if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Partial<RegistryDocument>).workspaces)) { return; }
			this.document.workspaces = (parsed as RegistryDocument).workspaces.flatMap((record) => {
				try {
					const normalized = normalizeRegistration(record);
					return typeof record.lastSeenAt === 'string' && !Number.isNaN(Date.parse(record.lastSeenAt))
						? [{ ...normalized, lastSeenAt: record.lastSeenAt }] : [];
				} catch { return []; }
			});
		} catch { /* First start or corrupt data starts with an empty, safe registry. */ }
	}

	private async persist(): Promise<void> {
		await mkdir(dirname(this.dataFile), { recursive: true });
		const temporary = `${this.dataFile}.tmp`;
		await writeFile(temporary, `${JSON.stringify(this.document, null, 2)}\n`, 'utf8');
		await rename(temporary, this.dataFile);
	}

	private async mutate(operation: () => Promise<void>): Promise<void> {
		const previous = this.mutationTail;
		let release!: () => void;
		this.mutationTail = new Promise((resolve) => { release = resolve; });
		await previous;
		try { await this.load(); await operation(); await this.persist(); } finally { release(); }
	}

	async upsert(value: unknown): Promise<void> {
		const registration = normalizeRegistration(value);
		await this.mutate(async () => {
			const record: StoredWorkspace = { ...registration, lastSeenAt: this.now().toISOString() };
			const index = this.document.workspaces.findIndex((candidate) => candidate.id === record.id);
			if (index >= 0) { this.document.workspaces[index] = record; } else { this.document.workspaces.push(record); }
		});
	}

	async remove(id: string): Promise<boolean> {
		if (!WORKSPACE_ID.test(id)) { throw new Error('Workspace id is invalid.'); }
		let removed = false;
		await this.mutate(async () => {
			const before = this.document.workspaces.length;
			this.document.workspaces = this.document.workspaces.filter((candidate) => candidate.id !== id);
			removed = before !== this.document.workspaces.length;
		});
		return removed;
	}

	async list(ttlMs: number): Promise<PublicWorkspace[]> {
		await this.load();
		const threshold = this.now().getTime() - ttlMs;
		return this.document.workspaces
			.filter((record) => Date.parse(record.lastSeenAt) >= threshold)
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(({ id, name, boardUrl }) => ({ id, name, boardUrl, available: true }));
	}
}
