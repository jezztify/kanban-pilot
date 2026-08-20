import * as vscode from 'vscode';
import { Task } from '../model/task';
import { Stage } from './receipt';
import { sessionUriForTaskBinding } from './sessionUri';

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
	/** Validated task-local image files, appended after the Markdown task file. */
	attachmentUris?: readonly vscode.Uri[];
	/** Open the task session beside the board before injecting this action's prompt. */
	openBeside?: boolean;
	modelSelector?: { id?: string; vendor?: string };
}

export interface ExecutorResult {
	ok: boolean;
	error?: string;
	/** `metadata.sessionId` from the result — Copilot's own conversation id (§6.9). */
	sessionId?: string;
}

export interface Executor {
	isAvailable(): Promise<boolean>;
	/** Opens the task's session and injects `prompt`, resolving at terminal state. */
	run(task: Task, taskFileUri: vscode.Uri, prompt: string, stage: Stage, options: RunOptions): Promise<ExecutorResult>;
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
 * and the narrow-window protocol of §6.9: nothing is awaited between opening
 * the session and injecting, and a process-wide mutex serializes the pair.
 */
export class ChatSessionExecutor implements Executor {
	constructor(private readonly commands: ChatCommandApi = vscode.commands) {}

	async isAvailable(mode = 'agent'): Promise<boolean> {
		const openCommand = await this.resolveAgentOpenCommand(mode);
		const all = await this.commands.getCommands(true);
		return !!openCommand && all.includes('vscode.open');
	}

	async run(
		task: Task,
		taskFileUri: vscode.Uri,
		prompt: string,
		stage: Stage,
		options: RunOptions,
	): Promise<ExecutorResult> {
		const openCommand = await this.resolveAgentOpenCommand(options.mode);
		if (!openCommand) {
			return this.clipboardFallback(task, prompt, options);
		}

		try {
			// Open immediately before injecting, with nothing awaited in
			// between (§6.9) — every added await is another window for
			// focus to move. The command's terminal response is returned as a
			// value so the mutex releases before blockOnResponse settles.
			const pending = await injectionMutex.run(async () => {
				await this.commands.executeCommand(
					'vscode.open',
					sessionUriForTaskBinding(task, options.sessionPrefix, task.setId),
					taskChatOpenOptions(options.openBeside === true),
				);

				return {
					response: this.commands.executeCommand<ChatAgentResultish | undefined>(openCommand, {
						query: prompt,
						mode: options.mode,
						blockOnResponse: true,
						attachFiles: orderedTaskChatAttachments(taskFileUri, options.attachmentUris),
						toolsInclude: resolveToolsInclude(stage, options.toolsIncludeForRefine),
						toolsExclude: options.toolsExclude,
						...(options.modelSelector && Object.keys(options.modelSelector).length
							? { modelSelector: options.modelSelector }
							: {}),
					}),
				};
			});

			const result = await pending.response;
			const sessionId = result?.metadata?.sessionId;
			return { ok: true, sessionId };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}

	private async resolveAgentOpenCommand(mode: string): Promise<string | undefined> {
		const all = await this.commands.getCommands(true);
		const expected = `workbench.action.chat.open${mode}`.toLowerCase();
		return all.find((id) => id.toLowerCase() === expected);
	}

	/** §6.6: on failure, session binding still holds and the board still tracks state via the receipt. */
	private async clipboardFallback(task: Task, prompt: string, options: RunOptions): Promise<ExecutorResult> {
		try {
			await this.commands.executeCommand(
				'vscode.open',
				sessionUriForTaskBinding(task, options.sessionPrefix, task.setId),
				taskChatOpenOptions(options.openBeside === true),
			);
			await vscode.env.clipboard.writeText(prompt);
			void vscode.window.showWarningMessage(
				`Kanban Pilot couldn't inject automatically — the prompt for ${task.id} is on your clipboard. Paste it into the opened chat.`,
			);
			return { ok: false, error: 'chat.open<Mode> unavailable; used clipboard fallback' };
		} catch (e) {
			return { ok: false, error: e instanceof Error ? e.message : String(e) };
		}
	}
}
