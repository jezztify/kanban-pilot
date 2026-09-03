export interface WorkspaceRegistrySettings {
	baseUrl?: unknown;
	credential?: unknown;
	workspaceName?: unknown;
}

export interface WorkspaceRegistryConfig {
	baseUrl: string;
	credential: string;
	workspaceName?: string;
	/** The automatic local registry may retain the board token for its redirect. */
	includeConnectionUrl?: boolean;
}

export interface WorkspaceRegistryDetails {
	/** The local VS Code workspace folder path shown by the local Registry. */
	directoryPath?: string;
	/** The currently selected Kanban Pilot task set shown by the local Registry. */
	activeWorkspace?: string;
}

export type RegistryFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

const REGISTRY_REQUEST_TIMEOUT_MS = 5_000;

/** Validates optional shared-registry settings without contacting the registry. */
export function registryConfig(settings: WorkspaceRegistrySettings): WorkspaceRegistryConfig | undefined {
	const credential = typeof settings.credential === 'string' ? settings.credential.trim() : '';
	const rawUrl = typeof settings.baseUrl === 'string' ? settings.baseUrl.trim() : '';
	if (!credential && !rawUrl) { return undefined; }
	if (!credential) { throw new Error('Kanban Pilot workspace registry credential cannot be blank.'); }
	let url: URL;
	try { url = new URL(rawUrl); } catch { throw new Error('Kanban Pilot workspace registry URL must be an absolute HTTP(S) URL.'); }
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
		throw new Error('Kanban Pilot workspace registry URL must be a credential-free absolute HTTP(S) base URL.');
	}
	const workspaceName = typeof settings.workspaceName === 'string' ? settings.workspaceName.replace(/\s+/g, ' ').trim() : '';
	if (workspaceName.length > 80) { throw new Error('Kanban Pilot workspace registry display name must contain 80 characters or fewer.'); }
	return { baseUrl: url.toString().replace(/\/$/, ''), credential, ...(workspaceName ? { workspaceName } : {}) };
}

function sanitizedBoardUrl(value: string): string {
	const url = new URL(value);
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error('Board URL must be a credential-free absolute HTTP(S) URL.');
	}
	url.search = '';
	url.hash = '';
	return url.toString().replace(/\/$/, '');
}

function sanitizedRegistryDetails(details: WorkspaceRegistryDetails): WorkspaceRegistryDetails {
	const directoryPath = details.directoryPath === undefined ? undefined : details.directoryPath.trim();
	if (directoryPath !== undefined && (!directoryPath || directoryPath.length > 4096)) {
		throw new Error('Workspace directory path must contain 1–4096 characters.');
	}
	const activeWorkspace = details.activeWorkspace === undefined
		? undefined
		: details.activeWorkspace.replace(/\s+/g, ' ').trim();
	if (activeWorkspace !== undefined && (!activeWorkspace || activeWorkspace.length > 80)) {
		throw new Error('Active workspace name must contain 1–80 characters.');
	}
	return {
		...(directoryPath === undefined ? {} : { directoryPath }),
		...(activeWorkspace === undefined ? {} : { activeWorkspace }),
	};
}

/** Performs best-effort discovery registration; callers keep serving local boards on failure. */
export class WorkspaceRegistryClient {
	constructor(readonly workspaceId: string, private readonly fetcher: RegistryFetch = fetch) {}

	private async request(input: string | URL, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REGISTRY_REQUEST_TIMEOUT_MS);
		timeout.unref?.();
		try {
			return await this.fetcher(input, { ...init, signal: controller.signal });
		} finally {
			clearTimeout(timeout);
		}
	}

	async sync(
		config: WorkspaceRegistryConfig,
		boardUrl: string,
		fallbackName = 'Kanban Pilot workspace',
		details: WorkspaceRegistryDetails = {},
	): Promise<string | undefined> {
		try {
			const localDetails = config.includeConnectionUrl ? sanitizedRegistryDetails(details) : {};
			const response = await this.request(`${config.baseUrl}/api/workspaces`, {
				method: 'PUT',
				headers: { authorization: `Bearer ${config.credential}`, 'content-type': 'application/json' },
				body: JSON.stringify({
					id: this.workspaceId,
					name: config.workspaceName ?? fallbackName,
					boardUrl: sanitizedBoardUrl(boardUrl),
					...(config.includeConnectionUrl ? { connectionUrl: boardUrl } : {}),
					...localDetails,
				}),
			});
			if (!response.ok) { return `Registry registration was rejected (${response.status}).`; }
			return undefined;
		} catch (error) { return error instanceof Error ? error.message : String(error); }
	}

	async remove(config: WorkspaceRegistryConfig): Promise<string | undefined> {
		try {
			const response = await this.request(`${config.baseUrl}/api/workspaces/${encodeURIComponent(this.workspaceId)}`, {
				method: 'DELETE', headers: { authorization: `Bearer ${config.credential}` },
			});
			if (!response.ok) { return `Registry removal was rejected (${response.status}).`; }
			return undefined;
		} catch (error) { return error instanceof Error ? error.message : String(error); }
	}
}
