import * as fs from 'node:fs';
import * as path from 'node:path';

export const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
export const CLAUDE_OPEN_URI = 'vscode://anthropic.claude-code/open';

export const CLAUDE_COMMANDS = [
	'claude-vscode.editor.open',
	'claude-vscode.editor.openLast',
	'claude-vscode.primaryEditor.open',
	'claude-vscode.sidebar.open',
	'claude-vscode.newConversation',
	'claude-vscode.reopenClosedSession',
	'claude-vscode.focus',
	'claude-vscode.blur',
	'claude-vscode.insertAtMention',
	'claude-vscode.openWalkthrough',
] as const;

export type ClaudeOperation =
	| 'selectBackend'
	| 'openOrResumeSession'
	| 'injectPromptWithAttachment'
	| 'waitForCompletion'
	| 'handleErrorsOrCancellation'
	| 'identifyOrContainMisroute';

export type OperationStatus = 'partial' | 'not-supported';

export interface OperationFinding {
	status: OperationStatus;
	evidence: string;
}

export interface SourceMarkers {
	uriHandler: boolean;
	openRoute: boolean;
	sessionParameter: boolean;
	promptParameter: boolean;
}

export interface ClaudeExtensionSnapshot {
	version?: string;
	vscodeEngine?: string;
	declaredCommands: readonly string[];
	hasPackageExports: boolean;
	sourceMarkers: SourceMarkers;
}

export interface IsolationCase {
	taskId: string;
	marker: string;
	expected: string;
}

export interface IsolationPlan {
	cases: readonly [IsolationCase, IsolationCase];
	assertions: readonly string[];
}

export interface ClaudeChatProbeReport {
	target: typeof CLAUDE_EXTENSION_ID;
	extensionVersion?: string;
	vscodeEngine?: string;
	declaredCommands: readonly string[];
	hasPackageExports: boolean;
	sourceMarkers: SourceMarkers;
	operations: Record<ClaudeOperation, OperationFinding>;
	isolation: IsolationPlan;
	criticalPath: {
		firstRun: string;
		continuation: string;
		coexistence: string;
	};
}

interface ClaudeManifest {
	version?: string;
	engines?: { vscode?: string };
	contributes?: {
		commands?: Array<{ command?: string }>;
	};
}

/** Builds the documented deep link without invoking VS Code or Claude. */
export function buildClaudeOpenUri(sessionId?: string, prompt?: string): string {
	const query = new URLSearchParams();
	if (sessionId) {
		query.set('session', sessionId);
	}
	if (prompt) {
		query.set('prompt', prompt);
	}
	const suffix = query.toString();
	return suffix ? `${CLAUDE_OPEN_URI}?${suffix}` : CLAUDE_OPEN_URI;
}

/**
 * Produces the two sanitized contexts used by the disposable isolation probe.
 * The values are markers, not real Claude session ids or credentials.
 */
export function createIsolationPlan(taskIds: readonly string[] = ['SPIKE-TASK-A', 'SPIKE-TASK-B']): IsolationPlan {
	if (taskIds.length < 2 || taskIds[0] === taskIds[1]) {
		throw new Error('The isolation probe requires two distinct task ids.');
	}

	const first: IsolationCase = {
		taskId: taskIds[0],
		marker: 'CLAUDE_SPIKE_TASK_A',
		expected: 'must not appear in the other task conversation',
	};
	const second: IsolationCase = {
		taskId: taskIds[1],
		marker: 'CLAUDE_SPIKE_TASK_B',
		expected: 'must not appear in the other task conversation',
	};

	return {
		cases: [first, second],
		assertions: [
			'Each marker is sent with only its matching sanitized task fixture.',
			'The observed Claude session ids must be captured before claiming isolation.',
			'A new conversation created after an invalid session id is a failure, not a pass.',
		],
	};
}

function hasCommand(snapshot: ClaudeExtensionSnapshot, command: string): boolean {
	return snapshot.declaredCommands.includes(command);
}

export function analyzeClaudeSurface(snapshot: ClaudeExtensionSnapshot): ClaudeChatProbeReport {
	const hasOfficialDeepLink =
		snapshot.sourceMarkers.uriHandler &&
		snapshot.sourceMarkers.openRoute &&
		snapshot.sourceMarkers.sessionParameter &&
		snapshot.sourceMarkers.promptParameter;
	const hasOpenCommand = hasCommand(snapshot, 'claude-vscode.primaryEditor.open');

	return {
		target: CLAUDE_EXTENSION_ID,
		extensionVersion: snapshot.version,
		vscodeEngine: snapshot.vscodeEngine,
		declaredCommands: snapshot.declaredCommands,
		hasPackageExports: snapshot.hasPackageExports,
		sourceMarkers: snapshot.sourceMarkers,
		operations: {
			selectBackend: {
				status: 'not-supported',
				evidence:
					'No public provider-selection API is declared by the Claude extension. Model and permission selection are UI features.',
			},
			openOrResumeSession: {
				status: hasOfficialDeepLink && hasOpenCommand ? 'partial' : 'not-supported',
				evidence:
					hasOfficialDeepLink && hasOpenCommand
						? 'The documented vscode:// deep link accepts a real Claude session id and can focus or resume it in the current workspace; it cannot derive a task-bound id.'
						: 'No documented session-opening surface was found.',
			},
			injectPromptWithAttachment: {
				status: 'not-supported',
				evidence:
					'The documented prompt query parameter only pre-fills the input; it does not submit it, and file attachments are a UI @-mention or drag-and-drop operation.',
			},
			waitForCompletion: {
				status: 'not-supported',
				evidence:
					'No public command result, completion event, or session-run handle is exposed for an external extension to await.',
			},
			handleErrorsOrCancellation: {
				status: 'not-supported',
				evidence:
					'No public cancellation token or error/result contract exists for a submitted Claude Code panel turn.',
			},
			identifyOrContainMisroute: {
				status: 'not-supported',
				evidence:
					'No public current-session identity or transcript event API is available; an unknown session id can fall back to a fresh conversation.',
			},
		},
		isolation: createIsolationPlan(),
		criticalPath: {
			firstRun: 'blocked: no supported submit, attachment, completion, or receipt-observation path',
			continuation: 'partial open/resume only when a valid opaque session id is already known',
			coexistence: 'not exercised: the local VS Code installation has Claude Code but no GitHub Copilot extension',
		},
	};
}

function readManifest(extensionRoot: string): ClaudeManifest {
	const manifestPath = path.join(extensionRoot, 'package.json');
	return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ClaudeManifest;
}

function readExtensionSource(extensionRoot: string): string {
	try {
		return fs.readFileSync(path.join(extensionRoot, 'extension.js'), 'utf8');
	} catch {
		return '';
	}
}

export function inspectClaudeExtension(extensionRoot: string): ClaudeExtensionSnapshot {
	const manifest = readManifest(extensionRoot);
	const source = readExtensionSource(extensionRoot);
	const declaredCommands = (manifest.contributes?.commands ?? [])
		.map((entry) => entry.command)
		.filter((command): command is string => typeof command === 'string');

	return {
		version: manifest.version,
		vscodeEngine: manifest.engines?.vscode,
		declaredCommands,
		hasPackageExports: Object.prototype.hasOwnProperty.call(manifest, 'exports'),
		sourceMarkers: {
			uriHandler: source.includes('registerUriHandler'),
			openRoute: /case\s*["']\/open["']/.test(source),
			sessionParameter: /get\(["']session["']\)/.test(source),
			promptParameter: /get\(["']prompt["']\)/.test(source),
		},
	};
}

export function findInstalledClaudeExtension(): string | undefined {
	const home = process.env.USERPROFILE ?? process.env.HOME;
	if (!home) {
		return undefined;
	}
	const extensionsDir = path.join(home, '.vscode', 'extensions');
	let candidates: string[];
	try {
		candidates = fs
			.readdirSync(extensionsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(`${CLAUDE_EXTENSION_ID}-`))
			.map((entry) => path.join(extensionsDir, entry.name));
	} catch {
		return undefined;
	}

	return candidates.sort((a, b) => b.localeCompare(a))[0];
}

export function buildProbeReport(extensionRoot: string): ClaudeChatProbeReport {
	return analyzeClaudeSurface(inspectClaudeExtension(extensionRoot));
}

function main(): void {
	const extensionRoot = process.argv[2] ?? findInstalledClaudeExtension();
	if (!extensionRoot) {
		console.error('Claude Code extension not found; pass its installation directory explicitly.');
		process.exitCode = 2;
		return;
	}

	console.log(JSON.stringify(buildProbeReport(extensionRoot), null, 2));
}

if (require.main === module) {
	main();
}