import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export type CopilotAgentSource = 'workspace' | 'configured' | 'user';

export interface CopilotAgentOption {
	name: string;
	description?: string;
	source: CopilotAgentSource;
}

export interface CopilotAgentFileSystem {
	readDirectory(uri: vscode.Uri): Thenable<readonly [string, vscode.FileType][]>;
	readFile(uri: vscode.Uri): Thenable<Uint8Array>;
}

export interface CopilotAgentDiscoveryOptions {
	/** Workspace roots whose default Copilot custom-agent directories should be scanned. */
	workspaceFolders?: readonly vscode.Uri[];
	/** The configured `kanbanPilot.chat.agentDirectories` value. */
	agentDirectories?: unknown;
	/** The configured `chat.agentFilesLocations` value. */
	additionalLocations?: unknown;
	/** Override the default user-level `~/.copilot/agents` directory. */
	userAgentsDirectory?: vscode.Uri;
	/** Override the default user-level `~/.claude/agents` directory. */
	userClaudeAgentsDirectory?: vscode.Uri;
	/** Override the home directory used to expand `~` in configured paths. */
	userHome?: string;
	/** Filesystem seam used by tests and non-file extension hosts. */
	fileSystem?: CopilotAgentFileSystem;
}

interface AgentLocation {
	uri: vscode.Uri;
	source: CopilotAgentSource;
}

interface AgentHeader {
	name?: string;
	description?: string;
	target?: string;
	userInvocable?: boolean;
	infer?: boolean;
}

const WORKSPACE_AGENT_DIRECTORY_PARTS: readonly (readonly string[])[] = [
	['.github', 'agents'],
	['.claude', 'agents'],
];

const DEFAULT_FILE_SYSTEM: CopilotAgentFileSystem = {
	readDirectory: (uri) => vscode.workspace.fs.readDirectory(uri),
	readFile: (uri) => vscode.workspace.fs.readFile(uri),
};

/**
 * Resolves the locations used by VS Code's custom-agent discovery, in priority
 * order. Workspace agents win over configured locations, which win over the
 * user-level Copilot directory when names collide.
 */
export function resolveCopilotAgentLocations(
	options: Pick<CopilotAgentDiscoveryOptions, 'workspaceFolders' | 'agentDirectories' | 'additionalLocations' | 'userAgentsDirectory' | 'userClaudeAgentsDirectory' | 'userHome'> = {},
): readonly AgentLocation[] {
	const workspaceFolders = options.workspaceFolders ?? vscode.workspace.workspaceFolders?.map((folder) => folder.uri) ?? [];
	const userHome = options.userHome ?? os.homedir();
	const locations: AgentLocation[] = [];

	for (const workspaceFolder of workspaceFolders) {
		for (const parts of WORKSPACE_AGENT_DIRECTORY_PARTS) {
			locations.push({
				uri: vscode.Uri.joinPath(workspaceFolder, ...parts),
				source: 'workspace',
			});
		}
	}

	for (const configuredLocation of configuredLocationUris(options.agentDirectories, workspaceFolders, userHome)) {
		locations.push({ uri: configuredLocation, source: 'configured' });
	}

	for (const configuredLocation of configuredLocationUris(options.additionalLocations, workspaceFolders, userHome)) {
		locations.push({ uri: configuredLocation, source: 'configured' });
	}

	locations.push({
		uri: options.userAgentsDirectory ?? vscode.Uri.file(path.join(userHome, '.copilot', 'agents')),
		source: 'user',
	});
	locations.push({
		uri: options.userClaudeAgentsDirectory ?? vscode.Uri.file(path.join(userHome, '.claude', 'agents')),
		source: 'user',
	});

	const seen = new Set<string>();
	return locations.filter((location) => {
		const key = location.uri.toString();
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/**
 * Finds user-invocable Copilot custom agents from workspace, configured, and
 * user-level locations. Each directory is optional: an absent or unreadable
 * location contributes no entries rather than making Settings unavailable.
 */
export async function discoverCopilotAgents(
	options: CopilotAgentDiscoveryOptions = {},
): Promise<CopilotAgentOption[]> {
	const fileSystem = options.fileSystem ?? DEFAULT_FILE_SYSTEM;
	const candidates: CopilotAgentOption[] = [];

	for (const location of resolveCopilotAgentLocations(options)) {
		candidates.push(...await readAgentDirectory(fileSystem, location));
	}

	const byName = new Map<string, CopilotAgentOption>();
	for (const candidate of candidates) {
		const key = candidate.name.toLowerCase();
		if (!byName.has(key)) {
			byName.set(key, candidate);
		}
	}

	return [...byName.values()].sort((left, right) => (
		compareNames(left.name, right.name)
	));
}

/** Parses one custom-agent Markdown file for the fields needed by the picker. */
export function parseCopilotAgent(
	content: string,
	fileName: string,
	source: CopilotAgentSource = 'workspace',
): CopilotAgentOption | undefined {
	const header = parseAgentHeader(content);
	if (!header) {
		return undefined;
	}

	if (header.userInvocable === false || header.infer === false) {
		return undefined;
	}

	if (header.target && !['vscode', 'github-copilot'].includes(header.target.toLowerCase())) {
		return undefined;
	}

	const name = normalizedName(header.name) ?? fallbackName(fileName);
	if (!name) {
		return undefined;
	}

	const description = normalizedDescription(header.description);
	return description
		? { name, description, source }
		: { name, source };
}

function configuredLocationUris(
	configured: unknown,
	workspaceFolders: readonly vscode.Uri[],
	userHome: string,
): vscode.Uri[] {
	const values: string[] = [];
	if (Array.isArray(configured)) {
		for (const value of configured) {
			if (typeof value === 'string') {
				values.push(value);
			}
		}
	} else if (configured && typeof configured === 'object') {
		for (const [value, enabled] of Object.entries(configured)) {
			if (enabled === true) {
				values.push(value);
			}
		}
	}

	const locations: vscode.Uri[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) {
			continue;
		}

		if (/^file:\/\//i.test(trimmed)) {
			locations.push(vscode.Uri.parse(trimmed));
			continue;
		}

		const expanded = trimmed === '~'
			? userHome
			: trimmed.startsWith('~/') || trimmed.startsWith('~\\')
				? path.join(userHome, trimmed.slice(2))
				: trimmed;
		if (path.isAbsolute(expanded)) {
			locations.push(vscode.Uri.file(expanded));
			continue;
		}

		for (const workspaceFolder of workspaceFolders) {
			locations.push(vscode.Uri.joinPath(workspaceFolder, expanded));
		}
	}
	return locations;
}

async function readAgentDirectory(
	fileSystem: CopilotAgentFileSystem,
	location: AgentLocation,
): Promise<CopilotAgentOption[]> {
	let entries: readonly [string, vscode.FileType][];
	try {
		entries = await fileSystem.readDirectory(location.uri);
	} catch {
		return [];
	}

	const agents: CopilotAgentOption[] = [];
	for (const [fileName, fileType] of [...entries].sort(([left], [right]) => compareNames(left, right))) {
		if (fileType === vscode.FileType.Directory || !/\.md$/i.test(fileName)) {
			continue;
		}

		try {
			const bytes = await fileSystem.readFile(vscode.Uri.joinPath(location.uri, fileName));
			const agent = parseCopilotAgent(Buffer.from(bytes).toString('utf8'), fileName, location.source);
			if (agent) {
				agents.push(agent);
			}
		} catch {
			// One bad profile must not hide the remaining choices.
		}
	}
	return agents;
}

function parseAgentHeader(content: string): AgentHeader | undefined {
	const normalized = content.replace(/^\uFEFF/, '');
	const lines = normalized.split(/\r?\n/);
	if (lines[0]?.trim() !== '---') {
		return {};
	}

	const end = lines.findIndex((line, index) => index > 0 && ['---', '...'].includes(line.trim()));
	if (end < 0) {
		return undefined;
	}

	const header: AgentHeader = {};
	for (const line of lines.slice(1, end)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		// The picker only needs top-level scalar fields. Nested lists/maps such
		// as `handoffs` and `tools` are valid agent metadata and can be ignored.
		if (/^\s/.test(line)) {
			continue;
		}
		if (trimmed.startsWith('-')) {
			return undefined;
		}
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (!match) {
			return undefined;
		}

		const key = match[1];
		const value = parseFrontmatterValue(match[2]);
		switch (key) {
			case 'name':
				header.name = typeof value === 'string' ? value : undefined;
				break;
			case 'description':
				header.description = typeof value === 'string' ? value : undefined;
				break;
			case 'target':
				header.target = typeof value === 'string' ? value : undefined;
				break;
			case 'user-invocable':
				header.userInvocable = typeof value === 'boolean' ? value : undefined;
				break;
			case 'infer':
				header.infer = typeof value === 'boolean' ? value : undefined;
				break;
		}
	}
	return header;
}

function parseFrontmatterValue(raw: string): string | boolean | undefined {
	let value = raw.trim();
	if (!value || value === '~' || value.toLowerCase() === 'null') {
		return undefined;
	}
	const lower = value.toLowerCase();
	if (lower === 'true' || lower === 'false') {
		return lower === 'true';
	}
	if (value.startsWith('#')) {
		return undefined;
	}

	if (value.startsWith('"')) {
		if (!value.endsWith('"')) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(value);
			return typeof parsed === 'string' ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'")) {
			return undefined;
		}
		return value.slice(1, -1).replace(/''/g, "'");
	}

	const comment = value.search(/\s+#/);
	if (comment >= 0) {
		value = value.slice(0, comment).trim();
	}
	return value || undefined;
}

function normalizedName(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const name = value.trim();
	return name && name.length <= 60 && !/[\r\n]/.test(name) ? name : undefined;
}

function normalizedDescription(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const description = value.trim();
	return description && !/[\r\n]/.test(description) ? description : undefined;
}

function fallbackName(fileName: string): string | undefined {
	const name = fileName.replace(/\.agent\.md$/i, '').replace(/\.md$/i, '');
	return normalizedName(name);
}

function compareNames(left: string, right: string): number {
	const leftLower = left.toLowerCase();
	const rightLower = right.toLowerCase();
	return leftLower < rightLower ? -1 : leftLower > rightLower ? 1 : left < right ? -1 : left > right ? 1 : 0;
}
