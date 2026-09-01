import * as vscode from 'vscode';
import { Task } from '../model/task';
import { Stage } from './receipt';
import {
	CHAT_SESSION_SCHEME,
	parseSessionUri,
	sessionUriForTaskBinding,
} from './sessionUri';

/**
 * Confirmed present via the Configure Tools picker (built-in `vscode`
 * toolset), applied globally to the default agent unless overridden per call.
 * M0 verified on disk that excluding these by name blocks both the write and
 * the read — see docs/m0-findings.md finding 12 (R12).
 */
export const MEMORY_TOOLS = ['memory', 'resolveMemoryFileUri'];

export interface RunOptions {
	mode: string;
	sessionPrefix: string;
	toolsIncludeForRefine: string[];
	toolsExclude: string[];
	/** Create a Copilot Chat conversation through its built-in New Chat action before injection. */
	newChatBefore?: boolean;
	/** Validated task-local image files, appended after the Markdown task file. */
	attachmentUris?: readonly vscode.Uri[];
	/** Open the task session beside the board before injecting this action's prompt. */
	openBeside?: boolean;
	modelSelector?: { id?: string; vendor?: string };
	/**
	 * The column agent resolved by `resolveAgentName()`. Sent as the payload's
	 * `mode`, which the chat open action resolves through `findModeByName` —
	 * matching a custom agent by name or id. Absent, the configured mode is sent.
	 */
	agentName?: string;
}

export interface ExecutorResult {
	ok: boolean;
	error?: string;
	/** `metadata.sessionId` from the result — Copilot's own conversation id (§6.9). */
	sessionId?: string;
	diagnostic?: ChatCapabilityDiagnostic;
}

export type CancellationResult =
	| { kind: 'cancelled' }
	| { kind: 'no-active-turn' }
	| { kind: 'failed'; error: string };

export interface CancellationOptions {
	mode: string;
	sessionPrefix: string;
}

/** Built-in VS Code command used by Copilot Chat's own Stop button. */
export const CHAT_CANCEL_COMMAND = 'workbench.action.chat.cancel';
/** Built-in VS Code command that creates a chat inheriting the active UI configuration. */
export const CHAT_NEW_COMMAND = 'workbench.action.chat.newChat';

/**
 * The fully-assembled outbound turn Kanban Pilot authors for a stage run — the
 * seven keys handed to `workbench.action.chat.open<mode>`. This is "row 1" of
 * the hijack matrix (docs/copilot-chat-hijack-spike.md): the one message the
 * extension legitimately owns and may therefore observe or transform before
 * injection. `modelSelector` is present only when one is pinned, matching the
 * shape the command has always received.
 */
export interface OutboundPayload {
	query: string;
	mode: string;
	blockOnResponse: boolean;
	attachFiles: vscode.Uri[];
	toolsInclude: string[] | undefined;
	toolsExclude: string[];
	modelSelector?: { id?: string; vendor?: string };
}

/** Read-only context describing the run the outbound payload belongs to. */
export interface OutboundContext {
	taskId: string;
	stage: Stage;
	mode: string;
	sessionUri: vscode.Uri;
	attachmentCount: number;
}

/**
 * Redacted, structural-only summary of an outbound turn. This is all the
 * observe hook is ever handed: it deliberately excludes the raw `query`, the
 * attachment file contents, and any credential/token, per the spike's
 * security/ToS section. Tool lists are ids only, already den-/allow-listed.
 */
export interface OutboundMetadata {
	taskId: string;
	stage: Stage;
	mode: string;
	toolsInclude?: string[];
	toolsExclude: string[];
	attachmentCount: number;
	queryLength: number;
}

/**
 * The observe-and-transform seam around the executor's outbound payload
 * (TASK-006). Both hooks are optional; the default is an identity no-op that
 * leaves the injected payload byte-for-byte unchanged.
 *
 * - `observe` receives only the redacted {@link OutboundMetadata} — it cannot
 *   see the raw prompt or file contents, so a logging hook cannot leak them.
 * - `transform` receives the full {@link OutboundPayload} and returns the
 *   payload to inject; it must be synchronous and pure (§6.9 narrow window).
 */
export interface OutboundPayloadSeam {
	observe?(metadata: OutboundMetadata): void;
	transform?(payload: OutboundPayload, context: OutboundContext): OutboundPayload;
}

/** Structural, non-sensitive projection of a payload for the observe hook. */
export function outboundPayloadMetadata(payload: OutboundPayload, context: OutboundContext): OutboundMetadata {
	return {
		taskId: context.taskId,
		stage: context.stage,
		mode: payload.mode,
		toolsInclude: payload.toolsInclude,
		toolsExclude: payload.toolsExclude,
		attachmentCount: payload.attachFiles.length,
		queryLength: payload.query.length,
	};
}

function isValidOutboundPayload(value: unknown): value is OutboundPayload {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const p = value as Partial<OutboundPayload>;
	return typeof p.query === 'string'
		&& typeof p.mode === 'string'
		&& typeof p.blockOnResponse === 'boolean'
		&& Array.isArray(p.attachFiles)
		&& Array.isArray(p.toolsExclude)
		&& (p.toolsInclude === undefined || Array.isArray(p.toolsInclude));
}

/**
 * Apply the observe-and-transform seam to an outbound payload. Fail-safe: a
 * throwing observe hook is swallowed, and a throwing or invalid transform falls
 * back to the untransformed payload with a non-fatal warning — a broken seam
 * can never crash a run (§6.9 / AC7).
 */
export function applyOutboundSeam(
	seam: OutboundPayloadSeam,
	payload: OutboundPayload,
	context: OutboundContext,
): OutboundPayload {
	if (seam.observe) {
		try {
			seam.observe(outboundPayloadMetadata(payload, context));
		} catch (e) {
			console.warn(`Kanban Pilot outbound observe hook threw; ignoring: ${describeError(e)}`);
		}
	}
	if (!seam.transform) {
		return payload;
	}
	try {
		const next = seam.transform(payload, context);
		if (!isValidOutboundPayload(next)) {
			console.warn('Kanban Pilot outbound transform returned an invalid payload; injecting the original.');
			return payload;
		}
		return next;
	} catch (e) {
		console.warn(`Kanban Pilot outbound transform threw; injecting the original: ${describeError(e)}`);
		return payload;
	}
}

function describeError(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

export type ChatCapability =
	| 'vscode.open'
	| 'mode-specific-chat-command'
	| 'vscode-chat-session-uri'
	| 'new-chat-command';

export interface ChatCapabilityDiagnostic {
	code:
		| 'missing-vscode-open'
		| 'missing-chat-command'
		| 'unsupported-chat-session-uri'
		| 'missing-new-chat-command'
		| 'new-chat-command-failed';
	capability: ChatCapability;
	mode: string;
	remoteName?: string;
	message: string;
	remediation: string;
}

export interface ChatCapabilities {
	mode: string;
	remoteName?: string;
	hasVscodeOpen: boolean;
	chatCommand?: string;
	newChatCommand?: string;
	supportsChatSessionUri: boolean;
	agentName?: string;
}

export interface Executor {
	isAvailable(): Promise<boolean>;
	/** Opens the task's session and injects `prompt`, resolving at terminal state. */
	run(task: Task, taskFileUri: vscode.Uri, prompt: string, stage: Stage, options: RunOptions): Promise<ExecutorResult>;
	/** Cancels the active turn in this task's bound session, when one exists. */
	cancel?(task: Task, options: CancellationOptions): Promise<CancellationResult>;
}

/** Copilot receives the Markdown task first, followed by images in reference order. */
export function orderedTaskChatAttachments(
	taskFileUri: vscode.Uri,
	attachmentUris: readonly vscode.Uri[] = [],
): vscode.Uri[] {
	return [taskFileUri, ...attachmentUris];
}

interface ChatAgentResultish {
	metadata?: { sessionId?: string };
}

/** Minimal command surface used by the executor and its concurrency tests. */
export interface ChatCommandApi {
	getCommands(includeInternal?: boolean): Thenable<string[]>;
	executeCommand<T>(command: string, ...args: unknown[]): Thenable<T>;
}

export interface ChatCapabilityProbe {
	supportsChatSessionUri?(uri: vscode.Uri): boolean | Promise<boolean>;
}

/** Serializes injections process-wide (§6.9) — two card actions can never race for focus. */
class Mutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise((resolve) => (release = resolve));
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

const injectionMutex = new Mutex();

/**
 * Refine's `toolsInclude` is opt-in, not on by default: an empty allowlist
 * means no restriction, the same trust posture develop and validate already
 * run under (their prompt alone is what stops them from doing the wrong
 * thing). A non-empty list is a real allowlist and is passed through as-is —
 * but whoever sets it is responsible for verifying those tool ids against the
 * live Configure Tools picker first (§6.6), the same discipline this project
 * used for `memory`/`resolveMemoryFileUri`. A prior default of
 * `['codebase', 'search', 'usages']` was never verified that way; it silently
 * blocked refine from writing `## Refined`/`## Scope`/the receipt to its own
 * task file, which the stage's own prompt requires it to do.
 */
export function resolveToolsInclude(stage: Stage, toolsIncludeForRefine: string[]): string[] | undefined {
	if (stage !== 'refine' || toolsIncludeForRefine.length === 0) {
		return undefined;
	}
	return toolsIncludeForRefine;
}

/** Options for the immediate session open that precedes prompt injection. */
export function taskChatOpenOptions(openBeside: boolean): vscode.TextDocumentShowOptions {
	return {
		...(openBeside ? { viewColumn: vscode.ViewColumn.Beside, preview: true } : {}),
		preserveFocus: false,
	};
}

/**
 * The v1 `Executor` (PRD §6.6) — the mechanism proven in
 * `copilot-poc/src/extension.ts`, extended with the session binding of §6.7
 * and the narrow-window protocol of §6.9: opening, the optional built-in New
 * Chat action, and injection are serialized as one focused command sequence.
 */
export class ChatSessionExecutor implements Executor {
	private readonly activeTurns = new Set<string>();
	private readonly pendingTurns = new Set<string>();
	private readonly cancellationRequested = new Set<string>();

	constructor(
		private readonly commands: ChatCommandApi = vscode.commands,
		private readonly capabilityProbe: ChatCapabilityProbe = {},
		private readonly seam: OutboundPayloadSeam = {},
	) {}

	async isAvailable(mode = 'agent'): Promise<boolean> {
		const capabilities = await this.detectCapabilities(mode);
		// Some VS Code clients do not advertise vscode.open through
		// getCommands(true), even though the command is executable. Treat the
		// inventory bit as advisory and probe it at the actual open boundary.
		return !!capabilities.chatCommand && capabilities.supportsChatSessionUri;
	}

	async run(
		task: Task,
		taskFileUri: vscode.Uri,
		prompt: string,
		stage: Stage,
		options: RunOptions,
	): Promise<ExecutorResult> {
		const sessionUri = sessionUriForTaskBinding(task, options.sessionPrefix, task.setId);
		const activeTurnKey = sessionUri.toString();
		this.pendingTurns.add(activeTurnKey);
		const capabilities = await this.detectCapabilities(options.mode, task, options.sessionPrefix);
		if (this.cancellationRequested.has(activeTurnKey)) {
			this.pendingTurns.delete(activeTurnKey);
			this.cancellationRequested.delete(activeTurnKey);
			return { ok: false, error: 'Copilot Chat turn cancelled before injection.' };
		}
		// A few supported clients omit vscode.open from their command inventory
		// even though the command remains executable. Probe it at the narrow
		// open-and-inject boundary instead of taking the inventory as a hard
		// preflight failure.
		const diagnostic = capabilityDiagnostic(capabilities, false, options.newChatBefore === true);
		if (diagnostic) {
			try {
				return await this.clipboardFallback(task, prompt, options, diagnostic);
			} finally {
				this.pendingTurns.delete(activeTurnKey);
			}
		}
		const openCommand = capabilities.chatCommand!;

		// The chat open action resolves its mode as
		//   opts.mode ? modes.findModeByName(opts.mode) : <the command's own mode>
		// and findModeByName matches custom agents by name or id. So naming the
		// assigned agent here is what actually selects it, and it takes precedence
		// over the command's own mode. Sending the configured chat.mode instead
		// would resolve back to the built-in agent and silently discard the
		// assignment. An unassigned column keeps the configured mode unchanged.
		const selectedMode = options.agentName?.trim() || options.mode;

		const payload: OutboundPayload = {
			query: prompt,
			mode: selectedMode,
			blockOnResponse: true,
			attachFiles: orderedTaskChatAttachments(taskFileUri, options.attachmentUris),
			toolsInclude: resolveToolsInclude(stage, options.toolsIncludeForRefine),
			toolsExclude: options.toolsExclude,
			...(options.modelSelector && Object.keys(options.modelSelector).length
				? { modelSelector: options.modelSelector }
				: {}),
		};
		const context: OutboundContext = {
			taskId: task.id,
			stage,
			mode: selectedMode,
			sessionUri,
			attachmentCount: payload.attachFiles.length,
		};

		try {
			// Open immediately before the optional New Chat action and injection
			// (§6.9). The whole focused command sequence stays inside the mutex;
			// the command's terminal response is returned as a value so the mutex
			// releases before blockOnResponse settles.
			const pending = await injectionMutex.run(async () => {
				if (this.cancellationRequested.has(activeTurnKey)) {
					return { kind: 'cancelled' as const };
				}
				await this.commands.executeCommand(
					'vscode.open',
					sessionUri,
					taskChatOpenOptions(options.openBeside === true),
				);
				if (this.cancellationRequested.has(activeTurnKey)) {
					return { kind: 'cancelled' as const };
				}

				if (options.newChatBefore === true) {
					try {
						await this.commands.executeCommand(capabilities.newChatCommand!);
					} catch (e) {
						return {
							kind: 'new-chat-failed' as const,
							diagnostic: newChatCommandFailureDiagnostic(capabilities, e),
						};
					}
					if (this.cancellationRequested.has(activeTurnKey)) {
						return { kind: 'cancelled' as const };
					}
				}

				// Observe-and-transform seam (row 1, TASK-006): the extension
				// authors this payload, so it may log or adjust it here. Runs
				// synchronously with no await before injection to keep the
				// §6.9 narrow window intact; a throwing/invalid seam falls
				// back to the untransformed payload.
				const finalPayload = applyOutboundSeam(this.seam, payload, context);

				const response = this.commands.executeCommand<ChatAgentResultish | undefined>(openCommand, finalPayload);
				this.activeTurns.add(activeTurnKey);
				return { kind: 'injected' as const, response };
			});
			if (pending.kind === 'cancelled') {
				return { ok: false, error: 'Copilot Chat turn cancelled before injection.' };
			}
			if (pending.kind === 'new-chat-failed') {
				return await this.clipboardFallback(task, prompt, options, pending.diagnostic, true);
			}

			try {
				const result = await pending.response;
				const sessionId = result?.metadata?.sessionId;
				return { ok: true, sessionId };
			} finally {
				this.activeTurns.delete(activeTurnKey);
			}
		} catch (e) {
			return {
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				...(!capabilities.hasVscodeOpen
					? { diagnostic: capabilityDiagnostic(capabilities, true) }
					: {}),
			};
		} finally {
			this.pendingTurns.delete(activeTurnKey);
			this.cancellationRequested.delete(activeTurnKey);
		}
	}

	async cancel(task: Task, options: CancellationOptions): Promise<CancellationResult> {
		const sessionUri = sessionUriForTaskBinding(task, options.sessionPrefix, task.setId);
		const activeTurnKey = sessionUri.toString();
		const isPending = this.pendingTurns.has(activeTurnKey);
		if (!isPending && !this.activeTurns.has(activeTurnKey)) {
			return { kind: 'no-active-turn' };
		}

		const commands = await this.commands.getCommands(true);
		if (!commands.includes(CHAT_CANCEL_COMMAND)) {
			return {
				kind: 'failed',
				error: `Copilot Chat cancellation command ${CHAT_CANCEL_COMMAND} is unavailable.`,
			};
		}
		if (isPending && !this.activeTurns.has(activeTurnKey)) {
			this.cancellationRequested.add(activeTurnKey);
			return { kind: 'cancelled' };
		}

		try {
			await injectionMutex.run(async () => {
				// The cancellation command operates on the focused chat widget. Open
				// the deterministic task session under the same mutex used for prompt
				// injection so another task cannot steal focus between these commands.
				await this.commands.executeCommand(
					'vscode.open',
					sessionUri,
					taskChatOpenOptions(false),
				);
				await this.commands.executeCommand(CHAT_CANCEL_COMMAND);
			});
			return { kind: 'cancelled' };
		} catch (e) {
			return {
				kind: 'failed',
				error: e instanceof Error ? e.message : String(e),
			};
		}
	}

	async detectCapabilities(
		mode: string,
		task?: Task,
		sessionPrefix?: string,
		agentName?: string,
	): Promise<ChatCapabilities> {
		const all = await this.commands.getCommands(true);
		const sessionUri = task
			? sessionUriForTaskBinding(task, sessionPrefix ?? 'kanban-pilot-', task.setId)
			: undefined;
		const probedSupport = sessionUri && this.capabilityProbe.supportsChatSessionUri
			? await this.capabilityProbe.supportsChatSessionUri(sessionUri)
			: undefined;
		return {
			mode,
			remoteName: vscode.env.remoteName || undefined,
			hasVscodeOpen: all.includes('vscode.open'),
			chatCommand: this.findAgentOpenCommand(all, mode),
			newChatCommand: this.findCommand(all, CHAT_NEW_COMMAND),
			supportsChatSessionUri: probedSupport ?? (sessionUri
				? sessionUri.scheme === CHAT_SESSION_SCHEME && !!parseSessionUri(sessionUri)
				: true),
		};
	}

	private findAgentOpenCommand(all: readonly string[], mode: string): string | undefined {
		return this.findCommand(all, `workbench.action.chat.open${mode}`);
	}

	private findCommand(all: readonly string[], expected: string): string | undefined {
		const lowerExpected = expected.toLowerCase();
		return all.find((id) => id.toLowerCase() === lowerExpected);
	}

	/** §6.6: on failure, session binding still holds and the board still tracks state via the receipt. */
	private async clipboardFallback(
		task: Task,
		prompt: string,
		options: RunOptions,
		diagnostic?: ChatCapabilityDiagnostic,
		sessionAlreadyOpen = false,
	): Promise<ExecutorResult> {
		try {
			if (!sessionAlreadyOpen) {
				await this.commands.executeCommand(
					'vscode.open',
					sessionUriForTaskBinding(task, options.sessionPrefix, task.setId),
					taskChatOpenOptions(options.openBeside === true),
				);
			}
			await vscode.env.clipboard.writeText(prompt);
			void vscode.window.showWarningMessage(
				`Kanban Pilot couldn't inject automatically — the prompt for ${task.id} is on your clipboard. Paste it into the opened chat.`,
			);
			return {
				ok: false,
				error: diagnostic?.capability === 'new-chat-command'
					? 'Copilot Chat New Chat was unavailable; used clipboard fallback'
					: 'chat.open<Mode> unavailable; used clipboard fallback',
				diagnostic,
			};
		} catch (e) {
			return {
				ok: false,
				error: e instanceof Error ? e.message : String(e),
				diagnostic,
			};
		}
	}
}

export function capabilityDiagnostic(
	capabilities: ChatCapabilities,
	includeOpenCapability = true,
	requireNewChat = false,
): ChatCapabilityDiagnostic | undefined {
	const remote = capabilities.remoteName;
	const client = remote ? `the ${remote} remote client` : 'this VS Code client';
	if (includeOpenCapability && !capabilities.hasVscodeOpen) {
		return {
			code: 'missing-vscode-open',
			capability: 'vscode.open',
			mode: capabilities.mode,
			...(remote ? { remoteName: remote } : {}),
			message: `Kanban Pilot cannot open the task chat because vscode.open is unavailable on ${client}.`,
			remediation: 'Reconnect with a supported VS Code desktop or browser client and keep the Kanban Pilot host workspace open.',
		};
	}
	if (!capabilities.chatCommand) {
		return {
			code: 'missing-chat-command',
			capability: 'mode-specific-chat-command',
			mode: capabilities.mode,
			...(remote ? { remoteName: remote } : {}),
			message: `The Copilot ${capabilities.mode} chat command is unavailable on ${client}.`,
			remediation: 'Install or enable GitHub Copilot Chat in the connected client, then retry the task action.',
		};
	}
	if (!capabilities.supportsChatSessionUri) {
		return {
			code: 'unsupported-chat-session-uri',
			capability: 'vscode-chat-session-uri',
			mode: capabilities.mode,
			...(remote ? { remoteName: remote } : {}),
			message: `The connected client cannot open deterministic vscode-chat-session URIs for ${client}.`,
			remediation: 'Use a supported VS Code desktop or browser client with Copilot Chat enabled; clipboard fallback preserves the prompt.',
		};
	}
	if (requireNewChat && !capabilities.newChatCommand) {
		return {
			code: 'missing-new-chat-command',
			capability: 'new-chat-command',
			mode: capabilities.mode,
			...(remote ? { remoteName: remote } : {}),
			message: `Copilot Chat's New Chat command is unavailable on ${client}; Kanban Pilot cannot safely inherit the active Agent and model for this first task turn.`,
			remediation: 'Enable or update Copilot Chat, then retry the task action; the prompt remains available through the clipboard fallback.',
		};
	}
	return undefined;
}

function newChatCommandFailureDiagnostic(
	capabilities: ChatCapabilities,
	error: unknown,
): ChatCapabilityDiagnostic {
	const remote = capabilities.remoteName;
	const client = remote ? `the ${remote} remote client` : 'this VS Code client';
	return {
		code: 'new-chat-command-failed',
		capability: 'new-chat-command',
		mode: capabilities.mode,
		...(remote ? { remoteName: remote } : {}),
		message: `Copilot Chat's New Chat command failed on ${client}: ${describeError(error)}.`,
		remediation: 'Retry the task action after confirming Copilot Chat is available and focused; the prompt was copied to the clipboard and was not injected into an unverified conversation.',
	};
}
