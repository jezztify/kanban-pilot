import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { newTaskFile, Task } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { CancellationResult, ChatCommandApi, ChatSessionExecutor, CHAT_NEW_COMMAND, Executor, ExecutorResult, RunOptions } from '../chat/executor';
import type { ContextCompactionAdapter } from '../chat/contextCompaction';
import { closeTaskChatTabs, CommandExecutor, normalizeMaxParallelTasks, normalizeTimeoutMinutes, RunManager } from '../chat/runManager';
import { formatReceipt, parseReceipts } from '../chat/receipt';
import { invokeTaskAction } from '../board/actions';
import { parseAuditEvents } from '../model/taskLog';
import { WorkspaceActivityStore } from '../model/workspaceActivity';
import { sessionIdForTask, sessionUriForId, sessionUriForTask, sessionUriForTaskBinding } from '../chat/sessionUri';
import { RECEIPT_COMPLETION_GATES } from '../model/gates';
import { hashScope } from '../chat/scopeHash';

/**
 * M3 — RunManager orchestration (PRD §6.4, §6.9). Uses a stub `Executor` so
 * these never touch real VS Code chat commands; the injection mechanism
 * itself (vscode.open, chat.open<Mode>, blockOnResponse) is already validated
 * empirically in M0 (docs/research/m0-findings.md) and re-proving it here would be
 * slow and redundant, not more rigorous.
 *
 * A stage run's phase 2 is fire-and-forget by design (§6.4 — the board
 * reflects state via the file watcher, not a held promise), so tests poll for
 * the background chain to settle rather than trusting a fixed delay: it
 * chains several real fs operations (template seed, executor call, re-read,
 * patch), any one of which can legitimately take more than a single tick.
 */

async function waitUntil(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await predicate()) {
			return;
		}
		if (Date.now() - start > timeoutMs) {
			throw new Error('waitUntil timed out');
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function waitUntilSettled(store: TaskStore, taskId: string): Promise<Task> {
	let task: Task | undefined;
	await waitUntil(async () => {
		task = (await store.readAll()).tasks.find((t) => t.id === taskId);
		return !!task && task.status !== 'running' && !task.pendingOutcome;
	});
	return task!;
}

type Next = (task: Task, prompt: string) => Promise<ExecutorResult> | 'hang';

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

class StubExecutor implements Executor {
	calls: { task: Task; prompt: string; options: RunOptions }[] = [];
	cancelCalls: { task: Task; options: { mode: string; sessionPrefix: string } }[] = [];
	constructor(
		private next: Next,
		private readonly cancelResult: CancellationResult = { kind: 'cancelled' },
	) {}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async run(
		task: Task,
		_taskFileUri: vscode.Uri,
		prompt: string,
		_stage: 'refine' | 'develop' | 'validate' | 'split',
		options: RunOptions,
	): Promise<ExecutorResult> {
		this.calls.push({ task, prompt, options });
		const outcome = this.next(task, prompt);
		if (outcome === 'hang') {
			return new Promise<ExecutorResult>(() => {
				/* never resolves — drives the timeout path */
			});
		}
		return outcome;
	}

	async cancel(task: Task, options: { mode: string; sessionPrefix: string }): Promise<CancellationResult> {
		this.cancelCalls.push({ task, options });
		return this.cancelResult;
	}
}

class PendingChatCommands implements ChatCommandApi {
	readonly responses: { runId: string; deferred: Deferred<unknown> }[] = [];

	getCommands(): Thenable<string[]> {
		return Promise.resolve([CHAT_NEW_COMMAND, 'workbench.action.chat.openagent']);
	}

	executeCommand<T>(command: string, ...args: unknown[]): Thenable<T> {
		if (command === 'vscode.open') {
			return Promise.resolve(undefined as T);
		}
		if (command === CHAT_NEW_COMMAND) {
			return Promise.resolve(undefined as T);
		}

		const query = (args[0] as { query?: unknown } | undefined)?.query;
		if (typeof query !== 'string') {
			return Promise.reject(new Error('chat command did not receive a prompt'));
		}

		const response = deferred<unknown>();
		this.responses.push({ runId: runIdFromPrompt(query), deferred: response });
		return response.promise as unknown as Thenable<T>;
	}
}

function recordingCommandExecutor(calls: { command: string; args: readonly unknown[] }[]): CommandExecutor {
	return <T>(command: string, ...args: unknown[]) => {
		calls.push({ command, args });
		return Promise.resolve(undefined as T);
	};
}

/** Every default template embeds `run:<id>` in the receipt instruction (verified separately). */
function runIdFromPrompt(prompt: string): string {
	const match = /run:(\S+)/.exec(prompt);
	if (!match) {
		throw new Error('prompt did not embed a run id — template regressed');
	}
	return match[1];
}

async function recordDevelopEvidence(store: TaskStore, task: Task, runId: string): Promise<void> {
	const file = `implementation-${runId}.ts`;
	await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(store.directory, file), Buffer.from('export {};', 'utf8'));
	await store.appendLog(task.id, `- implementation-evidence run:${runId} files:"${file}" verify:"focused test"`);
}

/** Stage-generic receipt writer for a stub executor: reads the runId straight out of the prompt it received. */
function okReceipt(store: TaskStore, stage: 'refine' | 'develop' | 'validate' | 'split') {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		if (stage === 'develop') {
			await recordDevelopEvidence(store, t, runId);
		}
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result: 'ok', note: 'done' }));
		return { ok: true, sessionId: 's1' };
	};
}

function receiptWithResult(
	store: TaskStore,
	stage: 'refine' | 'develop' | 'validate' | 'split',
	result: 'ok' | 'blocked' | 'failed',
) {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		if (stage === 'develop' && result === 'ok') {
			await recordDevelopEvidence(store, t, runId);
		}
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result, note: 'done' }));
		return { ok: true, sessionId: 's1' };
	};
}

/** Appends the stage's own receipt plus one propose-task line per title given. */
function okReceiptWithProposals(
	store: TaskStore,
	stage: 'refine' | 'develop' | 'validate' | 'split',
	titles: string[],
	types: (string | undefined)[] = [],
	parents: (string | undefined)[] = [],
) {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		if (stage === 'develop') {
			await recordDevelopEvidence(store, t, runId);
		}
		for (const [index, title] of titles.entries()) {
			const type = types[index];
			const parent = parents[index];
			await store.appendLog(t.id, `- propose-task run:${runId}${type ? ` type:${type}` : ''}${parent ? ` parent:${parent}` : ''} title:"${title}" note:"found while working"`);
		}
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result: 'ok', note: 'done' }));
		return { ok: true, sessionId: 's1' };
	};
}

/** Writes the receipt first, then appends proposals in a later task-file write. */
function okReceiptThenProposals(
	store: TaskStore,
	stage: 'develop' | 'validate' | 'split',
	titles: string[],
	delayMs = 300,
) {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		if (stage === 'develop') {
			await recordDevelopEvidence(store, t, runId);
		}
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result: 'ok', note: 'receipt first' }));
		setTimeout(() => {
			void (async () => {
				for (const title of titles) {
					await store.appendLog(t.id, `- propose-task run:${runId} title:"${title}" note:"written after receipt"`);
				}
			})();
		}, delayMs);
		return { ok: true, sessionId: 's1' };
	};
}

async function seedStaleCompletionHistory(
	store: TaskStore,
	task: Task,
	stage: 'refine' | 'develop' | 'validate',
	oldRunId: string,
	newerRunId?: string,
	withProposal = false,
	fallback: 'timeout' | 'missing-receipt' = 'timeout',
	includeSuccess = true,
): Promise<void> {
	const state = stage === 'refine' ? 'refine' : stage === 'develop' ? 'in-progress' : 'validation';
	const fallbackStatus = fallback === 'timeout' ? 'failed' : 'blocked';
	if (stage === 'develop') {
		// These fixtures exercise stale-history identity and gate behavior, not
		// implementation evidence. Opt them into the documented non-code path.
		await store.edit(task.id, {
			title: task.title,
			request: task.sections['Request'] ?? '',
			refined: task.sections['Refined'] ?? '',
			scope: 'completion-evidence: task-only',
		});
	}
	await store.patch(task.id, { state, status: fallbackStatus });
	await store.auditedPatch(task.id, { state, status: fallbackStatus }, {
		action: stage,
		runId: oldRunId,
		events: [{ kind: 'activity-start', stage, action: stage, runId: oldRunId }],
	});
	await store.appendLog(task.id, formatReceipt({
		runId: oldRunId,
		taskId: task.id,
		stage,
		result: fallback === 'timeout' ? 'failed' : 'blocked',
		note: fallback === 'timeout' ? 'timed out; awaiting late receipt' : 'no receipt found; awaiting late receipt',
	}));
	await store.auditedPatch(task.id, { status: fallbackStatus, run: undefined }, {
		action: fallback === 'timeout' ? 'timeout' : 'missing-receipt',
		runId: oldRunId,
		outcome: fallback === 'timeout' ? 'timeout' : 'missing-receipt',
		events: [{
			kind: 'activity-finish',
			runId: oldRunId,
			stage,
			outcome: fallback === 'timeout' ? 'timeout' : 'missing-receipt',
			provisional: true,
			note: fallback === 'timeout' ? 'Activity timed out; awaiting late receipt.' : 'No receipt found; awaiting late receipt.',
		}],
	});

	if (newerRunId) {
		await store.auditedPatch(task.id, { status: 'idle' }, { action: stage });
		await store.auditedPatch(task.id, { status: 'running', run: newerRunId }, {
			action: stage,
			runId: newerRunId,
			events: [{ kind: 'activity-start', stage, action: stage, runId: newerRunId }],
		});
		await store.appendLog(task.id, formatReceipt({
			runId: newerRunId,
			taskId: task.id,
			stage,
			result: 'failed',
			note: 'retry failed',
		}));
		await store.auditedPatch(task.id, { status: 'failed', run: undefined }, {
			action: 'executor-error',
			runId: newerRunId,
			outcome: 'error',
			events: [{ kind: 'activity-finish', runId: newerRunId, stage, outcome: 'error', note: 'Retry failed.' }],
		});
	}

	if (withProposal) {
		await store.appendLog(task.id, `- propose-task run:${oldRunId} title:"Recovered follow-up" note:"created by the stale run"`);
	}
	if (!includeSuccess) {
		return;
	}
	await store.appendLog(task.id, formatReceipt({
		runId: oldRunId,
		taskId: task.id,
		stage,
		result: 'ok',
		note: 'implementation finished in the earlier run',
	}));
}

suite('M3 RunManager', () => {
	let store: TaskStore;
	let dir: vscode.Uri;
	let folder: vscode.WorkspaceFolder;

	setup(async () => {
		dir = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-rm-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		store = new TaskStore(dir);
		await store.ensureDirectory();
		folder = { uri: dir, name: 'test', index: 0 };
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		for (const gate of RECEIPT_COMPLETION_GATES) {
			await cfg.update(gate.settingKey, 'auto', vscode.ConfigurationTarget.Global);
		}
		await waitUntil(() => RECEIPT_COMPLETION_GATES.every((gate) =>
			vscode.workspace.getConfiguration('kanbanPilot').get(gate.settingKey) === 'auto',
		));
	});

	teardown(async () => {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		for (const gate of RECEIPT_COMPLETION_GATES) {
			await cfg.update(gate.settingKey, undefined, vscode.ConfigurationTarget.Global);
		}
		try {
			await vscode.workspace.fs.delete(dir, { recursive: true });
		} catch {
			/* already gone */
		}
	});

	suite('trigger model — accept/approve are pure, refine/develop/continue/validate launch runs', () => {
		test('accept moves Backlog → Refine but does not launch a run', async () => {
			const task = await store.create('Set up billing webhook');
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'accept');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'idle', 'accept alone must not start a run');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(executor.calls.length, 0, 'the executor must not have been called by accept');
		});

		test('manual move changes the column without launching a run', async () => {
			const task = await store.create('Move without running');
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			assert.deepStrictEqual(await runManager.moveTask(task.id, 'done'), { kind: 'applied' });

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'done');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(executor.calls.length, 0, 'a manual move must not invoke the executor');
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'state-change' && event.to === 'done'));
		});

		test('manual moves preserve an existing chat binding and never create chat activity', async () => {
			const task = await store.create('Preserve the task conversation');
			await store.patch(task.id, {
				state: 'refine',
				status: 'idle',
				chat: 'persisted-task-chat',
				copilot_session_id: 'copilot-task-chat',
				chat_reset_required: 'true',
			});
			const executor = new StubExecutor(() => 'hang');
			const commandCalls: { command: string; args: readonly unknown[] }[] = [];
			const runManager = new RunManager(
				store,
				executor,
				folder,
				undefined,
				recordingCommandExecutor(commandCalls),
			);

			for (const destination of ['in-progress', 'validation'] as const) {
				assert.deepStrictEqual(await runManager.moveTask(task.id, destination), { kind: 'applied' });
				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.strictEqual(after.state, destination);
				assert.strictEqual(after.chat, 'persisted-task-chat');
				assert.strictEqual(after.copilotSessionId, 'copilot-task-chat');
				assert.strictEqual(after.chatResetRequired, true);
				assert.strictEqual(after.status, 'idle');
				assert.strictEqual(after.run, undefined);
			}

			assert.strictEqual(executor.calls.length, 0, 'a pure move must not invoke the executor');
			assert.deepStrictEqual(commandCalls, [], 'a pure move must not open or reset chat');
		});

		test('manual moves of an unbound task do not persist a chat or invoke chat activity', async () => {
			const task = await store.create('Move without a conversation');
			const executor = new StubExecutor(() => 'hang');
			const commandCalls: { command: string; args: readonly unknown[] }[] = [];
			const runManager = new RunManager(
				store,
				executor,
				folder,
				undefined,
				recordingCommandExecutor(commandCalls),
			);

			assert.deepStrictEqual(await runManager.moveTask(task.id, 'refine'), { kind: 'applied' });
			assert.deepStrictEqual(await runManager.moveTask(task.id, 'in-progress'), { kind: 'applied' });

			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.chat, undefined);
			assert.strictEqual(after.copilotSessionId, undefined);
			assert.strictEqual(after.chatResetRequired, false);
			assert.strictEqual(executor.calls.length, 0, 'a pure move must not invoke the executor');
			assert.deepStrictEqual(commandCalls, [], 'a pure move must not open or create chat');
		});

		test('manual move into Done closes only the matching task chat tab', async () => {
			const task = await store.create('Close chat on manual completion');
			await store.patch(task.id, { chat: 'persisted-close-session' });
			const target = sessionUriForTaskBinding({ id: task.id, chat: 'persisted-close-session' });
			const other = sessionUriForTask('TASK-004');
			const matchingTab = { input: { uri: target } } as unknown as vscode.Tab;
			const otherTab = { input: { uri: other } } as unknown as vscode.Tab;
			let closed: readonly vscode.Tab[] | undefined;
			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder, {
				all: [{ tabs: [matchingTab, otherTab] } as unknown as vscode.TabGroup],
				async close(tabs, preserveFocus) {
					assert.strictEqual(preserveFocus, true);
					closed = Array.isArray(tabs) ? tabs : [tabs];
					return true;
				},
			});

			assert.deepStrictEqual(await runManager.moveTask(task.id, 'done'), { kind: 'applied' });
			assert.deepStrictEqual(closed, [matchingTab]);
		});

		test('reorderTask changes only order and keeps an active run reservation', async () => {
			const first = await store.create('First in progress');
			const second = await store.create('Active second in progress');
			await store.patch(first.id, { state: 'in-progress' });
			await store.patch(second.id, { state: 'in-progress' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(second.id, 'continue');
			await waitUntil(() => executor.calls.length === 1);
			const before = (await store.readAll()).tasks.find((task) => task.id === second.id)!;
			assert.strictEqual(before.status, 'running');
			assert.ok(before.run);

			assert.deepStrictEqual(
				await runManager.reorderTask(second.id, 'in-progress', { beforeTaskId: first.id }),
				{ kind: 'applied' },
			);
			const after = (await store.readAll()).tasks.find((task) => task.id === second.id)!;
			assert.strictEqual(after.state, 'in-progress');
			assert.strictEqual(after.status, 'running');
			assert.strictEqual(after.run, before.run);
			assert.strictEqual(after.chat, before.chat);
			assert.strictEqual(executor.calls.length, 1, 'reordering must not invoke the executor');
			assert.deepStrictEqual(
				(await store.snapshot()).columns.find((column) => column.id === 'in-progress')?.tasks.map((task) => task.id),
				[second.id, first.id],
			);

			// With the default one-run capacity, a preserved active reservation keeps
			// another Continue request from launching while the reordered run hangs.
			await runManager.handleAction(first.id, 'continue');
			assert.strictEqual(executor.calls.length, 1, 'reorder must not release the active reservation');
			assert.strictEqual((await store.readAll()).tasks.find((task) => task.id === first.id)?.status, 'idle');
			await runManager.handleAction(second.id, 'stop');
		});

		test('clicking Refine after Accept is what actually launches the run', async () => {
			const task = await store.create('Set up billing webhook');
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'accept');
			await runManager.handleAction(task.id, 'refine');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'running');
			assert.ok(after.run, 'a run id must be assigned before the agent has even responded');
			assert.ok(after.chat, 'the session should be bound on first run (§6.7)');

			await waitUntil(() => executor.calls.length > 0); // phase 2 is fire-and-forget
			assert.strictEqual(executor.calls.length, 1);
			assert.strictEqual(executor.calls[0].options.openBeside, true);
		});

		test('keeps every stage run on the same derived session without ever opening a new chat', async () => {
		const task = await store.create('Create a task conversation');
		await store.patch(task.id, { state: 'refine', status: 'idle', chat: sessionIdForTask(task.id, 'kanban-pilot-', store.setId) });
		const executor = new StubExecutor(async (current, prompt) => {
			const runId = runIdFromPrompt(prompt);
			await store.appendLog(current.id, formatReceipt({
				runId,
				taskId: current.id,
				stage: 'refine',
				result: 'ok',
				note: 'created conversation',
			}));
			return { ok: true, sessionId: 'copilot-session-1' };
		});
		const runManager = new RunManager(store, executor, folder);

		const derivedBinding = sessionIdForTask(task.id, 'kanban-pilot-', store.setId);
		// Opening the derived session is the whole binding; New Chat would spin the
		// conversation off into a separate Copilot chat, so it is never requested.
		await runManager.handleAction(task.id, 'refine');
		await waitUntilSettled(store, task.id);
		assert.strictEqual(executor.calls[0].options.newChatBefore, undefined);
		assert.strictEqual(executor.calls[0].task.chat, derivedBinding);

		// Copilot's returned UUID is a misroute detector only (M0 finding 9): it
		// must never overwrite the stable derived `chat` binding used to reopen
		// the conversation, or the next open would spawn a brand-new empty chat.
		assert.deepStrictEqual(await runManager.moveTask(task.id, 'in-progress'), { kind: 'applied' });
		assert.deepStrictEqual(await runManager.moveTask(task.id, 'refine'), { kind: 'applied' });
		const afterMove = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
		assert.strictEqual(afterMove.chat, derivedBinding);
		assert.strictEqual(afterMove.copilotSessionId, 'copilot-session-1');
		assert.strictEqual(
			sessionUriForTaskBinding(afterMove, 'kanban-pilot-', store.setId).toString(),
			sessionUriForTask(task.id, 'kanban-pilot-', store.setId).toString(),
			'the reopen URI stays on the derived local session, never Copilot’s UUID',
		);

		await runManager.handleAction(task.id, 'refine');
		await waitUntilSettled(store, task.id);
		assert.strictEqual(executor.calls[1].options.newChatBefore, undefined);
		assert.strictEqual(executor.calls[1].task.copilotSessionId, 'copilot-session-1');
		assert.strictEqual(executor.calls[1].task.chat, derivedBinding);
		assert.strictEqual((await store.readAll()).tasks[0].chat, derivedBinding);
	});

	test('treats a legacy chat binding as an existing conversation', async () => {
		const task = await store.create('Keep a legacy conversation');
		await store.patch(task.id, { state: 'refine', status: 'idle', chat: 'legacy-conversation-id' });
		const executor = new StubExecutor(okReceipt(store, 'refine'));
		const runManager = new RunManager(store, executor, folder);

		await runManager.handleAction(task.id, 'refine');
		await waitUntilSettled(store, task.id);

		assert.strictEqual(executor.calls[0].options.newChatBefore, undefined);
		assert.strictEqual(executor.calls[0].task.chat, 'legacy-conversation-id');
	});

		test('docking persists first-use identity and reuses it after manager recreation', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('layout.dockChat', true, vscode.ConfigurationTarget.Global);
			try {
				const existing = await store.create('Existing conversation');
				await store.patch(existing.id, { chat: 'persisted-before-reload' });
				const firstCalls: { command: string; args: readonly unknown[] }[] = [];
				const firstManager = new RunManager(
					store,
					new StubExecutor(() => 'hang'),
					folder,
					undefined,
					recordingCommandExecutor(firstCalls),
				);

				await firstManager.dockTaskChat(existing.id, { onSelect: false });
				const existingUri = firstCalls[0].args[0] as vscode.Uri;
				assert.strictEqual(existingUri.toString(), sessionUriForTaskBinding({ id: existing.id, chat: 'persisted-before-reload' }, 'new-prefix-', store.setId).toString());

				const reloadedCalls: { command: string; args: readonly unknown[] }[] = [];
				const reloadedManager = new RunManager(
					store,
					new StubExecutor(() => 'hang'),
					folder,
					undefined,
					recordingCommandExecutor(reloadedCalls),
				);
				await reloadedManager.dockTaskChat(existing.id, { onSelect: false });
				assert.strictEqual((reloadedCalls[0].args[0] as vscode.Uri).toString(), existingUri.toString());

				const firstUse = await store.create('First chat');
				const firstUseCalls: { command: string; args: readonly unknown[] }[] = [];
				const firstUseManager = new RunManager(
					store,
					new StubExecutor(() => 'hang'),
					folder,
					undefined,
					recordingCommandExecutor(firstUseCalls),
				);
				await firstUseManager.dockTaskChat(firstUse.id, { onSelect: false });

				const afterFirstUse = (await store.readAll()).tasks.find((candidate) => candidate.id === firstUse.id)!;
				assert.ok(afterFirstUse.chat);
				assert.strictEqual(
					(firstUseCalls[0].args[0] as vscode.Uri).toString(),
					sessionUriForTaskBinding(afterFirstUse, 'kanban-pilot-', store.setId).toString(),
				);
			} finally {
				await cfg.update('layout.dockChat', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('an explicit Open Chat persists and opens its binding when automatic docking is disabled', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('layout.dockChat', false, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Open this conversation explicitly');
				const calls: { command: string; args: readonly unknown[] }[] = [];
				const manager = new RunManager(
					store,
					new StubExecutor(() => 'hang'),
					folder,
					undefined,
					recordingCommandExecutor(calls),
				);

				await manager.dockTaskChat(task.id, { onSelect: false, explicit: true });

				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.ok(after.chat, 'an explicit first-use open must persist the durable binding');
				assert.deepStrictEqual(calls.map(({ command }) => command), ['vscode.open']);
				assert.strictEqual(
					(calls[0].args[0] as vscode.Uri).toString(),
					sessionUriForTaskBinding(after, 'kanban-pilot-', store.setId).toString(),
				);
				assert.deepStrictEqual(calls[0].args[1], { preserveFocus: true, preview: true });
			} finally {
				await cfg.update('layout.dockChat', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a recreated manager preserves the binding for an ongoing run', async () => {
			const task = await store.create('Ongoing conversation');
			await store.patch(task.id, {
				state: 'in-progress',
				status: 'running',
				run: 'r-active',
				chat: 'ongoing-chat-session',
			});
			const calls: { command: string; args: readonly unknown[] }[] = [];
			const reloadedManager = new RunManager(
				store,
				new StubExecutor(() => 'hang'),
				folder,
				undefined,
				recordingCommandExecutor(calls),
			);

			await reloadedManager.dockTaskChat(task.id, { onSelect: false });
			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.status, 'running');
			assert.strictEqual(after.run, 'r-active');
			assert.strictEqual(after.chat, 'ongoing-chat-session');
			assert.strictEqual(
				(calls[0].args[0] as vscode.Uri).toString(),
				sessionUriForTaskBinding(after, 'different-prefix-', store.setId).toString(),
			);
		});

		test('a reloaded manager reopens the persisted local binding, not Copilot’s conversation UUID', async () => {
			const task = await store.create('Reopen the completed conversation');
			await store.patch(task.id, {
				chat: 'legacy-derived-binding',
				copilot_session_id: 'copilot-conversation-id',
			});
			const calls: { command: string; args: readonly unknown[] }[] = [];
			const manager = new RunManager(
				store,
				new StubExecutor(() => 'hang'),
				folder,
				undefined,
				recordingCommandExecutor(calls),
			);

			await manager.dockTaskChat(task.id, { onSelect: false, explicit: true });

			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(
				(calls[0].args[0] as vscode.Uri).toString(),
				sessionUriForTaskBinding(after, 'different-prefix-', store.setId).toString(),
			);
			// M0 finding 9: the Copilot UUID is not a local-session id — dock must
			// never open a URI built from it, or VS Code spawns a new empty chat.
			assert.strictEqual(
				(calls[0].args[0] as vscode.Uri).toString(),
				sessionUriForId('legacy-derived-binding').toString(),
			);
			assert.notStrictEqual(
				(calls[0].args[0] as vscode.Uri).toString(),
				sessionUriForId('copilot-conversation-id').toString(),
			);
			assert.strictEqual(after.chat, 'legacy-derived-binding');
			assert.strictEqual(after.copilotSessionId, 'copilot-conversation-id');
		});

		test('session reset reuses the persisted binding and opens it exactly once', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.resetOnApprove', true, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Reset this conversation');
				await store.patch(task.id, {
					state: 'scoped',
					status: 'idle',
					chat: 'persisted-reset-session',
				});
				const calls: { command: string; args: readonly unknown[] }[] = [];
				const manager = new RunManager(
					store,
					new StubExecutor(() => 'hang'),
					folder,
					undefined,
					recordingCommandExecutor(calls),
				);

				await manager.handleAction(task.id, 'approve');

				assert.deepStrictEqual(calls.map(({ command }) => command), [
					'vscode.open',
					'workbench.action.chat.newChat',
				]);
				assert.strictEqual(
					(calls[0].args[0] as vscode.Uri).toString(),
					sessionUriForTaskBinding({ id: task.id, chat: 'persisted-reset-session' }, 'different-prefix-', store.setId).toString(),
				);
				assert.strictEqual((await store.readAll()).tasks.find((candidate) => candidate.id === task.id)?.chat, 'persisted-reset-session');
			} finally {
				await cfg.update('chat.resetOnApprove', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('stage runs keep a persisted binding when resumed by a recreated manager', async () => {
			const task = await store.create('Resume this conversation');
			await store.patch(task.id, {
				state: 'in-progress',
				status: 'idle',
				chat: 'persisted-resume-chat',
			});
			const executor = new StubExecutor(() => 'hang');
			const reloadedManager = new RunManager(store, executor, folder);

			await reloadedManager.handleAction(task.id, 'continue');
			await waitUntil(() => executor.calls.length === 1);
			assert.strictEqual(executor.calls[0].task.chat, 'persisted-resume-chat');
			assert.strictEqual((await store.readAll()).tasks.find((candidate) => candidate.id === task.id)?.chat, 'persisted-resume-chat');

			await reloadedManager.handleAction(task.id, 'stop');
		});

		test('approve moves Scoped → Approved and does not reset the session by default', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'scoped', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

			await runManager.handleAction(task.id, 'approve');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'approved');
			// resetOnApprove defaults to false — Develop deliberately continues
			// the same conversation Refine started (see package.json's default).
		});


		test('passes the resolved column agent to the executor for each stage', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.agentNames', {
				refine: 'Bro Rapid Architect',
				'in-progress': 'Bro Rapid Coder',
				validation: 'Bro Rapid QA',
			}, vscode.ConfigurationTarget.Global);
			try {
				for (const [state, action, expected] of [
					['refine', 'refine', 'Bro Rapid Architect'],
					['approved', 'develop', 'Bro Rapid Coder'],
					['validation', 'validate', 'Bro Rapid QA'],
				] as const) {
					const task = await store.create('Agent reaches the executor');
					await store.patch(task.id, { state, status: 'idle' });
					const executor = new StubExecutor(() => 'hang');
					const runManager = new RunManager(store, executor, folder);

					await runManager.handleAction(task.id, action);
					await waitUntil(() => executor.calls.length === 1);
					assert.strictEqual(
						executor.calls[0].options.agentName,
						expected,
						`${action} must run under its column agent`,
					);
					await runManager.handleAction(task.id, 'stop');
				}
			} finally {
				await cfg.update('chat.agentNames', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a column agent assignment does not disturb the task session binding', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.agentNames', { refine: 'Bro Rapid Architect' }, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Agent selection leaves the session alone');
				const binding = sessionIdForTask(task.id, 'kanban-pilot-', store.setId);
				await store.patch(task.id, { state: 'refine', status: 'idle', chat: binding });
				const executor = new StubExecutor(() => 'hang');
				const commandCalls: { command: string; args: readonly unknown[] }[] = [];
				const runManager = new RunManager(
					store,
					executor,
					folder,
					undefined,
					recordingCommandExecutor(commandCalls),
				);

				await runManager.handleAction(task.id, 'refine');
				await waitUntil(() => executor.calls.length === 1);

				assert.strictEqual(executor.calls[0].options.agentName, 'Bro Rapid Architect');
				assert.strictEqual(executor.calls[0].options.newChatBefore, undefined, 'no New Chat for agent selection');
				assert.strictEqual(executor.calls[0].task.chat, binding);
				assert.ok(
					!commandCalls.some(({ command }) => command === 'workbench.action.chat.newChat'),
					'selecting an agent must not reset the conversation',
				);
				await runManager.handleAction(task.id, 'stop');
			} finally {
				await cfg.update('chat.agentNames', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('develop is a single click that both moves the card and launches a run', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'in-progress');
			assert.strictEqual(after.status, 'running');
			assert.ok(after.run);

			await waitUntil(() => executor.calls.length > 0);
			assert.strictEqual(executor.calls.length, 1);
			assert.strictEqual(executor.calls[0].prompt.includes('@Bro Coder'), true);
			assert.strictEqual(executor.calls[0].options.openBeside, true);
		});

		test('validate is a single click that launches a run in place', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'validate');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'running');

			await waitUntil(() => executor.calls.length > 0);
			assert.strictEqual(executor.calls[0].prompt.includes('@Bro QA'), true);
			assert.strictEqual(executor.calls[0].options.openBeside, true);
		});

		test('Continue keeps its existing non-docking behavior', async () => {
			const task = await store.create('Resume implementation');
			await store.patch(task.id, { state: 'in-progress', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'continue');

			await waitUntil(() => executor.calls.length > 0);
			assert.strictEqual(executor.calls[0].options.openBeside, false);
		});

		test('disabling layout docking does not block a requested stage run', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('layout.dockChat', false, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Develop without docking');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'develop');

				await waitUntil(() => executor.calls.length > 0);
				assert.strictEqual(executor.calls[0].options.openBeside, false);
			} finally {
				await cfg.update('layout.dockChat', undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});

	suite('refine stage', () => {
		test('a successful run with a matching receipt advances Refine → Scoped and records scope_hash', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'refine')), folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(
				after.chat,
				sessionIdForTask(task.id, 'kanban-pilot-', store.setId),
				'the derived local binding is the reopen id and must survive the run, not be replaced by Copilot’s UUID',
			);
			assert.strictEqual(after.copilotSessionId, 's1');
			assert.ok(after.scopeHash, 'refine success must record scope_hash for §6.8 layer 2');
			const audit = parseAuditEvents(after.sections['Log']);
			assert.strictEqual(audit.filter((event) => event.kind === 'activity-start' && event.runId).length, 1);
			assert.strictEqual(audit.filter((event) => event.kind === 'activity-finish' && event.outcome === 'ok').length, 1);
			assert.ok(audit.some((event) => event.kind === 'state-change' && event.to === 'scoped'));
			assert.ok(audit.some((event) => event.kind === 'status-change' && event.from === 'running' && event.to === 'idle'));
		});

		test('awaited but no receipt written → blocked, not stuck running forever (§6.4)', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async () => ({ ok: true, sessionId: 's1' })); // no appendLog
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'blocked');
			assert.ok(after.sections['Log'].includes('awaiting late receipt'));
			const finish = parseAuditEvents(after.sections['Log']).find((event) => event.kind === 'activity-finish');
			assert.strictEqual(finish?.outcome, 'missing-receipt');
			assert.strictEqual(finish?.provisional, true);
		});

		test('a receipt appended after executor completion is picked up during the reconciliation grace period', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				setTimeout(() => {
					void store.appendLog(
						t.id,
						formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'written after executor return' }),
					);
				}, 25);
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
		});

		test('a receipt written after the reconciliation grace period is recovered without a file watcher', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				setTimeout(() => {
					void store.appendLog(
						t.id,
						formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'written after fallback' }),
					);
				}, 300);
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(async () => {
				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
				return after?.state === 'scoped' && after.status === 'idle';
			});

			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(parseReceipts(after.sections['Log']).filter((receipt) => receipt.runId === runIdFromPrompt(executor.calls[0].prompt)).length, 2);
		});

		test('RunManager reconciles a late extension receipt once and applies the stage outcome', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let runId = '';
			const runManager = new RunManager(
				store,
				new StubExecutor(async (_t, prompt) => {
					runId = runIdFromPrompt(prompt);
					return { ok: true, sessionId: 's1' };
				}),
				folder,
			);

			await runManager.handleAction(task.id, 'refine');
			const blocked = await waitUntilSettled(store, task.id);
			assert.strictEqual(blocked.status, 'blocked');
			assert.strictEqual(blocked.run, undefined);

			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'refine', result: 'ok', note: 'late completion' }),
			);
			const watcherManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await watcherManager.reconcileTaskChange(task.id);
			await watcherManager.reconcileTaskChange(task.id);

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(
				parseReceipts(after.sections['Log']).filter((receipt) => receipt.runId === runId).length,
				2,
				'a repeated file-change pass must not append or apply the late receipt again',
			);
			const audit = parseAuditEvents(after.sections['Log']);
			assert.strictEqual(audit.filter((event) => event.kind === 'activity-start').length, 1);
			assert.strictEqual(audit.filter((event) => event.kind === 'activity-finish').length, 2);
			assert.ok(audit.some((event) => event.kind === 'activity-finish' && event.provisional));
			assert.ok(audit.some((event) => event.kind === 'activity-finish' && event.correction && event.outcome === 'ok'));
		});

		test('a receipt written just before the missing-receipt marker still wins the race', async () => {
			const task = await store.create('Recover a receipt-marker race');
			const runId = 'r-marker-race';
			await store.edit(task.id, {
				title: task.title,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: 'completion-evidence: task-only',
			});
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('gates.developToValidation', 'auto', vscode.ConfigurationTarget.Global);
			await waitUntil(() => vscode.workspace.getConfiguration('kanbanPilot').get('gates.developToValidation') === 'auto');
			await store.patch(task.id, { state: 'in-progress', status: 'blocked' });
			await store.auditedPatch(task.id, { state: 'in-progress', status: 'blocked' }, {
				action: 'develop',
				runId,
				events: [{ kind: 'activity-start', stage: 'develop', action: 'develop', runId }],
			});
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'ok', note: 'late completion' }),
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'blocked', note: 'no receipt found; awaiting late receipt' }),
			);

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileTaskChange(task.id);

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
		});

		test('late receipt reconciliation does not duplicate proposed tasks when file changes repeat', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			let runId = '';
			const runManager = new RunManager(
				store,
				new StubExecutor(async (_t, prompt) => {
					runId = runIdFromPrompt(prompt);
					return { ok: true, sessionId: 's1' };
				}),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			const blocked = await waitUntilSettled(store, task.id);
			assert.strictEqual(blocked.status, 'blocked');

			await store.appendLog(task.id, `- propose-task run:${runId} title:"Add retry backoff" note:"found late"`);
			const sourceDirectory = vscode.Uri.joinPath(dir, 'src');
			await vscode.workspace.fs.createDirectory(sourceDirectory);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(sourceDirectory, 'late-reconciliation.ts'),
				Buffer.from('export {};', 'utf8'),
			);
			await store.appendLog(
				task.id,
				`- implementation-evidence run:${runId} files:"src/late-reconciliation.ts" verify:"npm test"`,
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'ok', note: 'late completion' }),
			);
			const watcherManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await watcherManager.reconcileTaskChange(task.id);
			await watcherManager.reconcileTaskChange(task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.filter((candidate) => candidate.title === 'Add retry backoff').length, 1);
			assert.strictEqual(tasks.find((candidate) => candidate.id === task.id)?.state, 'validation');
		});

		test('a late Develop receipt with evidence is recovered when the extension activates', async () => {
			const task = await store.create('Recover implementation after activation');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const executor = new StubExecutor(async () => ({ ok: true, sessionId: 's1' }));
			const firstManager = new RunManager(store, executor, folder);

			await firstManager.handleAction(task.id, 'develop');
			const blocked = await waitUntilSettled(store, task.id);
			assert.strictEqual(blocked.status, 'blocked');

			const runId = runIdFromPrompt(executor.calls[0].prompt);
			const sourceDirectory = vscode.Uri.joinPath(dir, 'src');
			await vscode.workspace.fs.createDirectory(sourceDirectory);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(sourceDirectory, 'activation-reconciliation.ts'),
				Buffer.from('export {};', 'utf8'),
			);
			await store.appendLog(
				task.id,
				`- implementation-evidence run:${runId} files:"src/activation-reconciliation.ts" verify:"npm test"`,
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'ok', note: 'written before activation' }),
			);

			const activatedManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await activatedManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
		});

		test('a late receipt cannot reclaim a card that was manually moved after fallback', async () => {
			const task = await store.create('Move after a missing receipt');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let runId = '';
			const runManager = new RunManager(
				store,
				new StubExecutor(async (_t, prompt) => {
					runId = runIdFromPrompt(prompt);
					return { ok: true };
				}),
				folder,
			);

			await runManager.handleAction(task.id, 'refine');
			await waitUntilSettled(store, task.id);
			assert.deepStrictEqual(await runManager.moveTask(task.id, 'done'), { kind: 'applied' });

			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'refine', result: 'ok', note: 'superseded late completion' }),
			);
			const watcherManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await watcherManager.reconcileTaskChange(task.id);

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'done');
			assert.strictEqual(after.status, 'idle');
		});

		test('a receipt with result:blocked surfaces as a blocked card', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'blocked', note: 'need a decision' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine', 'blocked stays in the working column, not moved');
			assert.strictEqual(after.status, 'blocked');
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.outcome === 'blocked'));
		});

		test('the executor throwing or reporting failure marks the run failed', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async () => ({ ok: false, error: 'boom' }));
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.status, 'failed');
			assert.ok(after.sections['Log'].includes('boom'));
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.outcome === 'error'));
		});

		test('a receipt whose task id does not match this task is rejected, not accepted (§6.9)', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				// Simulates a misrouted receipt landing in the right file with the wrong task id.
				await store.appendLog(t.id, formatReceipt({ runId, taskId: 'TASK-999', stage: 'refine', result: 'ok', note: 'wrong' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.status, 'blocked', 'a task-id-mismatched receipt must be treated as no receipt at all');
			assert.ok(after.sections['Log'].includes('receipt-diagnostic kind:task-mismatch'));
			assert.ok(after.sections['Log'].includes('actual-task:TASK-999'));

			const beforeRepeat = after.sections['Log'];
			const watcherManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await watcherManager.reconcileTaskChange(task.id);
			await watcherManager.reconcileTaskChange(task.id);
			const afterRepeat = (await store.readAll()).tasks[0];
			assert.strictEqual(
				afterRepeat.sections['Log'].split('\n').filter((line) => line.includes('receipt-diagnostic kind:task-mismatch')).length,
				1,
				'a repeated reconciliation must not duplicate the mismatch diagnostic',
			);
			assert.ok(afterRepeat.sections['Log'].length >= beforeRepeat.length);
		});

		test('a receipt whose run id does not match the active run is rejected with a diagnostic', async () => {
			const task = await store.create('Reject a stale run receipt');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t) => {
				await store.appendLog(t.id, formatReceipt({ runId: 'r-foreign', taskId: t.id, stage: 'refine', result: 'ok', note: 'stale run' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.status, 'blocked');
			assert.ok(after.sections['Log'].includes('receipt-diagnostic kind:run-mismatch'));
			assert.ok(after.sections['Log'].includes('actual-run:r-foreign'));
		});

		test('a wrong-stage receipt cannot hide a later exact-stage receipt', async () => {
			const task = await store.create('Prefer the exact receipt stage');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'exact stage' }));
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'develop', result: 'ok', note: 'wrong stage' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
		});

		test('a wrong-stage receipt without an exact match is rejected with a diagnostic', async () => {
			const task = await store.create('Reject a wrong-stage receipt');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'develop', result: 'ok', note: 'wrong stage' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'blocked');
			assert.ok(after.sections['Log'].includes('receipt-diagnostic kind:stage-mismatch'));
			assert.ok(after.sections['Log'].includes('actual-stage:develop'));
		});

		test('session id changing between runs sets chat_reset_required automatically (§6.9)', async () => {
			let call = 0;
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				call++;
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'ok' }));
				return { ok: true, sessionId: call === 1 ? 'session-A' : 'session-B' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			let after = await waitUntilSettled(store, task.id);
			assert.strictEqual(after.copilotSessionId, 'session-A');
			assert.strictEqual(after.state, 'scoped');

			// Move back to Refine and run again — same task, different reported session.
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			await runManager.handleAction(task.id, 'refine');
			after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.copilotSessionId, 'session-B');
			assert.strictEqual(after.chatResetRequired, true);
		});

		test('a run superseded before the executor resolves does not clobber the newer state', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let resolveRun: ((r: ExecutorResult) => void) | undefined;
			const executor = new StubExecutor(() => new Promise((resolve) => (resolveRun = resolve)));
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0); // let phase 2 actually reach the executor

			const runningTask = (await store.readAll()).tasks[0];
			assert.strictEqual(runningTask.status, 'running');

			// Simulate Stop / a manual intervention that supersedes this run.
			await store.patch(task.id, { status: 'idle', run: undefined });

			resolveRun!({ ok: true, sessionId: 's1' });
			// Give the stale resolution a real chance to (wrongly) apply, then confirm it didn't.
			await new Promise((r) => setTimeout(r, 200));

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'idle', 'the stale resolution must not overwrite the superseding state');
			assert.strictEqual(after.run, undefined);
		});

		test('a late result after a manual move cannot reclaim the card', async () => {
			const task = await store.create('Move during a run');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let resolveRun: ((r: ExecutorResult) => void) | undefined;
			const executor = new StubExecutor(() => new Promise((resolve) => (resolveRun = resolve)));
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0);
			assert.deepStrictEqual(await runManager.moveTask(task.id, 'done'), { kind: 'applied' });

			resolveRun!({ ok: true, sessionId: 's1' });
			await new Promise((r) => setTimeout(r, 200));

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'done');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.outcome === 'superseded'));
		});

		test('timeout marks the run failed and records it in the log', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'refine', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

				await runManager.handleAction(task.id, 'refine');
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.status, 'failed');
				assert.ok(after.sections['Log'].includes('timed out'));
				assert.ok(after.sections['Log'].includes('awaiting late receipt'));
				assert.strictEqual(parseReceipts(after.sections['Log']).find((receipt) => receipt.stage === 'refine')?.result, 'failed');
				assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.outcome === 'timeout'));
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('timeout rechecks a receipt written before the fallback is finalized', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Receipt before timeout fallback');
				await store.patch(task.id, { state: 'refine', status: 'idle' });
				const executor = new StubExecutor(async (t, prompt) => {
					const runId = runIdFromPrompt(prompt);
					await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'written before timeout' }));
					return new Promise<ExecutorResult>(() => {
						/* the receipt is durable even though the chat turn remains open */
					});
				});
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'refine');
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'scoped');
				assert.strictEqual(after.status, 'idle');
				assert.strictEqual(parseReceipts(after.sections['Log']).filter((receipt) => receipt.stage === 'refine').length, 1);
				assert.ok(!after.sections['Log'].includes('awaiting late receipt'));
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a matching receipt after timeout is recovered by the bounded backstop', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Recover a late timeout completion');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				let runId = '';
				const executor = new StubExecutor(async (t, prompt) => {
					runId = runIdFromPrompt(prompt);
					setTimeout(() => {
						void (async () => {
							await recordDevelopEvidence(store, t, runId);
							await store.appendLog(
								t.id,
								formatReceipt({ runId, taskId: t.id, stage: 'develop', result: 'ok', note: 'written after timeout' }),
							);
						})();
					}, 900);
					return new Promise<ExecutorResult>(() => {
						/* the chat turn outlives the extension timeout */
					});
				});
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'develop');
				const failed = await waitUntilSettled(store, task.id);
				assert.strictEqual(failed.state, 'in-progress');
				assert.strictEqual(failed.status, 'failed');
				assert.ok(failed.sections['Log'].includes('timed out; awaiting late receipt'));

				await waitUntil(async () => {
					const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
					return after?.state === 'validation' && after.status === 'idle';
				});

				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.strictEqual(after.run, undefined);
				assert.strictEqual(parseReceipts(after.sections['Log']).filter((receipt) => receipt.runId === runId).length, 2);
				const audit = parseAuditEvents(after.sections['Log']);
				assert.strictEqual(audit.filter((event) => event.kind === 'activity-finish').length, 2);
				assert.ok(audit.some((event) => event.kind === 'activity-finish' && event.outcome === 'timeout'));
				assert.ok(audit.some((event) => event.kind === 'activity-finish' && event.correction && event.outcome === 'ok'));
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a late blocked receipt after timeout keeps the stage retryable', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Recover a blocked timeout completion');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				let runId = '';
				const executor = new StubExecutor(async (t, prompt) => {
					runId = runIdFromPrompt(prompt);
					setTimeout(() => {
						void store.appendLog(
							t.id,
							formatReceipt({ runId, taskId: t.id, stage: 'develop', result: 'blocked', note: 'needs a decision after timeout' }),
						);
					}, 900);
					return new Promise<ExecutorResult>(() => {
						/* the chat turn outlives the extension timeout */
					});
				});
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'develop');
				await waitUntilSettled(store, task.id);
				await waitUntil(async () => {
					const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
					return after?.state === 'in-progress' && after.status === 'blocked';
				});

				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.strictEqual(parseReceipts(after.sections['Log']).filter((receipt) => receipt.runId === runId).length, 2);
				assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.correction && event.outcome === 'blocked'));
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a late timeout receipt with proposals files each child once', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Recover late develop proposals');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				let runId = '';
				const lateWrite = deferred<void>();
				const executor = new StubExecutor(async (t, prompt) => {
					runId = runIdFromPrompt(prompt);
					setTimeout(() => {
						void (async () => {
							await recordDevelopEvidence(store, t, runId);
							await store.appendLog(t.id, `- propose-task run:${runId} title:"Late follow-up" note:"written after timeout"`);
							await store.appendLog(
								t.id,
								formatReceipt({ runId, taskId: t.id, stage: 'develop', result: 'ok', note: 'late completion with proposal' }),
							);
							lateWrite.resolve();
						})().catch((error) => lateWrite.reject(error));
					}, 900);
					return new Promise<ExecutorResult>(() => {
						/* the chat turn outlives the extension timeout */
					});
				});
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'develop');
				const failed = await waitUntilSettled(store, task.id);
				assert.strictEqual(failed.status, 'failed');
				runManager.dispose();
				await lateWrite.promise;
				const reconciliationManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
				await reconciliationManager.reconcileTaskChange(task.id);
				await reconciliationManager.reconcileTaskChange(task.id);

				const { tasks } = await store.readAll();
				assert.strictEqual(tasks.filter((candidate) => candidate.title === 'Late follow-up').length, 1);
				assert.strictEqual(tasks.find((candidate) => candidate.id === task.id)?.state, 'validation');
				assert.strictEqual(parseReceipts(tasks.find((candidate) => candidate.id === task.id)!.sections['Log']).filter((receipt) => receipt.runId === runId).length, 2);
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a late executor rejection after timeout is consumed without changing the failed outcome', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Consume a late executor rejection');
				await store.patch(task.id, { state: 'refine', status: 'idle' });
				const executor = new StubExecutor(() => new Promise<ExecutorResult>((_resolve, reject) => {
					setTimeout(() => reject(new Error('late executor failure')), 100);
				}));
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'refine');
				const after = await waitUntilSettled(store, task.id);
				assert.strictEqual(after.status, 'failed');
				await waitUntil(() => executor.calls.length === 1 && Date.now() > 0, 500);
				await new Promise((resolve) => setTimeout(resolve, 150));

				const settled = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.strictEqual(settled.status, 'failed');
				assert.strictEqual(parseReceipts(settled.sections['Log']).filter((receipt) => receipt.stage === 'refine').length, 1);
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a timed-out receipt cannot reclaim a task after a newer retry succeeds', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.timeoutMinutes', 0.0005, vscode.ConfigurationTarget.Global); // ~30ms
			try {
				const task = await store.create('Ignore a stale timeout receipt');
				await store.patch(task.id, { state: 'refine', status: 'idle' });
				let firstRunId = '';
				let calls = 0;
				const executor = new StubExecutor(async (t, prompt) => {
					calls++;
					const runId = runIdFromPrompt(prompt);
					if (calls === 1) {
						firstRunId = runId;
						return new Promise<ExecutorResult>(() => {
							/* first chat turn remains open past timeout and retry */
						});
					}
					await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'refine', result: 'ok', note: 'newer retry completed' }));
					return { ok: true };
				});
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'refine');
				await waitUntilSettled(store, task.id);
				await runManager.handleAction(task.id, 'refine');
				await waitUntil(async () => {
					const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
					return after?.state === 'scoped' && after.status === 'idle';
				});

				await store.appendLog(
					task.id,
					formatReceipt({ runId: firstRunId, taskId: task.id, stage: 'refine', result: 'ok', note: 'stale completion' }),
				);
				await runManager.reconcileTaskChange(task.id);

				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.strictEqual(after.state, 'scoped');
				assert.strictEqual(after.status, 'idle');
				assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.kind === 'activity-finish').length, 2);
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a late timeout receipt cannot reclaim the same column after a newer retry starts', async () => {
			const task = await store.create('Ignore a superseded timeout receipt');
			const oldRunId = 'r-old-timeout';
			const newRunId = 'r-new-retry';
			await store.auditedPatch(
				task.id,
				{ state: 'refine', status: 'running', run: oldRunId },
				{
					action: 'refine',
					runId: oldRunId,
					events: [{ kind: 'activity-start', stage: 'refine', action: 'refine', runId: oldRunId }],
				},
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId: oldRunId, taskId: task.id, stage: 'refine', result: 'failed', note: 'timed out; awaiting late receipt' }),
			);
			await store.auditedPatch(
				task.id,
				{ status: 'failed', run: undefined },
				{
					action: 'timeout',
					runId: oldRunId,
					outcome: 'timeout',
					events: [{ kind: 'activity-finish', stage: 'refine', runId: oldRunId, outcome: 'timeout', provisional: true }],
				},
			);
			await store.auditedPatch(
				task.id,
				{ status: 'running', run: newRunId },
				{
					action: 'refine',
					runId: newRunId,
					events: [{ kind: 'activity-start', stage: 'refine', action: 'refine', runId: newRunId }],
				},
			);
			await store.auditedPatch(
				task.id,
				{ status: 'failed', run: undefined },
				{
					action: 'executor-error',
					runId: newRunId,
					outcome: 'error',
					events: [{ kind: 'activity-finish', stage: 'refine', runId: newRunId, outcome: 'error' }],
				},
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId: oldRunId, taskId: task.id, stage: 'refine', result: 'ok', note: 'stale completion' }),
			);

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileTaskChange(task.id);

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'failed');
			assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.kind === 'activity-finish').length, 2);
		});

		test('the rendered refine prompt carries the misroute-visibility banner and this stage\'s agent name', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0);

			assert.strictEqual(executor.calls.length, 1);
			assert.ok(executor.calls[0].prompt.includes(`## [${folder.name} ${task.id}]`), 'missing the [project task] banner (§6.9)');
			assert.ok(executor.calls[0].prompt.startsWith('@Bro Refiner\n'), '@agentName must open the message');
		});

		test('passes only the active task images after the Markdown file and adds image guidance', async () => {
			const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
			const task = await store.create('Inspect the supplied screenshot', {
				request: 'Review the screenshot.',
				attachments: {
					add: [{ id: 'screenshot', name: 'screenshot.png', mimeType: 'image/png', data: png }],
				},
			});
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0);

			assert.strictEqual(executor.calls[0].options.attachmentUris?.length, 1);
			assert.ok(executor.calls[0].options.attachmentUris?.[0].path.endsWith('/TASK-001.attachments/screenshot.png'));
			assert.ok(executor.calls[0].prompt.includes('attached after it are also task input and read-only context'));
		});

		test('appends image guidance to a user-owned custom prompt template', async () => {
			const promptDirectory = vscode.Uri.joinPath(folder.uri, '.kanban-pilot', 'prompts');
			await vscode.workspace.fs.createDirectory(promptDirectory);
			await vscode.workspace.fs.writeFile(
				vscode.Uri.joinPath(promptDirectory, 'refine.md'),
				Buffer.from('@{{agentName}}\ncustom prompt for {{id}}', 'utf8'),
			);
			const task = await store.create('Custom prompt image context');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0);

			assert.ok(executor.calls[0].prompt.includes('read-only context'));
		});
	});

	test('normalizes invalid timeout values while preserving positive fractional minutes', () => {
		assert.strictEqual(normalizeTimeoutMinutes(undefined), 20);
		assert.strictEqual(normalizeTimeoutMinutes(0), 20);
		assert.strictEqual(normalizeTimeoutMinutes(-1), 20);
		assert.strictEqual(normalizeTimeoutMinutes(Number.NaN), 20);
		assert.strictEqual(normalizeTimeoutMinutes(0.0005), 0.0005);
	});

	test('closes only the matching task chat tab when Done finalization requests cleanup', async () => {
		const target = sessionUriForTask('TASK-003');
		const other = sessionUriForTask('TASK-004');
		const matchingTab = { input: { uri: target } } as unknown as vscode.Tab;
		const otherTab = { input: { uri: other } } as unknown as vscode.Tab;
		let closed: readonly vscode.Tab[] | undefined;
		await closeTaskChatTabs(target, {
			all: [{ tabs: [matchingTab, otherTab] } as unknown as vscode.TabGroup],
			async close(tabs, preserveFocus) {
				assert.strictEqual(preserveFocus, true);
				closed = Array.isArray(tabs) ? tabs : [tabs];
				return true;
			},
		});
		assert.deepStrictEqual(closed, [matchingTab]);
	});

	suite('agent name overrides (§6.17)', () => {
		test('kanbanPilot.chat.agentNames overrides the @name a prompt opens with', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.agentNames', { develop: 'Ship It Steve' }, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'develop');
				await waitUntil(() => executor.calls.length > 0);

				assert.ok(executor.calls[0].prompt.startsWith('@Ship It Steve\n'), 'the override must reach the actual injected prompt, not just the board badge');
			} finally {
				await cfg.update('chat.agentNames', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('split rides on refine\'s override (§6.14)', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.agentNames', { refine: 'Scope Wizard' }, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Rebuild the whole onboarding flow');
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(task.id, 'split');
				await waitUntil(() => executor.calls.length > 0);

				assert.ok(executor.calls[0].prompt.startsWith('@Scope Wizard\n'), 'split has no override of its own — it must inherit refine\'s');
			} finally {
				await cfg.update('chat.agentNames', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('column assignments reach the actual prompts for every runnable stage', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update(
				'chat.agentNames',
				{ refine: 'Scope Wizard', 'in-progress': 'Ship It Steve', validation: 'Quality Pilot' },
				vscode.ConfigurationTarget.Global,
			);
			try {
				const refineTask = await store.create('Column assignment refine');
				await store.patch(refineTask.id, { state: 'refine', status: 'idle' });
				const refineExecutor = new StubExecutor(okReceipt(store, 'refine'));
				const refineManager = new RunManager(store, refineExecutor, folder);
				await refineManager.handleAction(refineTask.id, 'refine');
				await waitUntilSettled(store, refineTask.id);
				assert.ok(refineExecutor.calls[0].prompt.startsWith('@Scope Wizard\n'));

				const splitTask = await store.create('Column assignment split');
				const splitExecutor = new StubExecutor(okReceipt(store, 'split'));
				const splitManager = new RunManager(store, splitExecutor, folder);
				await splitManager.handleAction(splitTask.id, 'split');
				await waitUntilSettled(store, splitTask.id);
				assert.ok(splitExecutor.calls[0].prompt.startsWith('@Scope Wizard\n'));

				const developTask = await store.create('Column assignment develop');
				await store.patch(developTask.id, { state: 'approved', status: 'idle' });
				const developExecutor = new StubExecutor(okReceipt(store, 'develop'));
				const developManager = new RunManager(store, developExecutor, folder);
				await developManager.handleAction(developTask.id, 'develop');
				await waitUntilSettled(store, developTask.id);
				assert.ok(developExecutor.calls[0].prompt.startsWith('@Ship It Steve\n'));

				const validateTask = await store.create('Column assignment validate');
				await store.patch(validateTask.id, { state: 'validation', status: 'idle' });
				const validateExecutor = new StubExecutor(okReceipt(store, 'validate'));
				const validateManager = new RunManager(store, validateExecutor, folder);
				await validateManager.handleAction(validateTask.id, 'validate');
				await waitUntilSettled(store, validateTask.id);
				assert.ok(validateExecutor.calls[0].prompt.startsWith('@Quality Pilot\n'));
			} finally {
				await cfg.update('chat.agentNames', undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});

	suite('context compaction lifecycle', () => {
		test('prepares native threshold compaction without forcing a post-turn request', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			const previousEnabled = cfg.inspect<unknown>('chat.autoCompact')?.globalValue;
			const previousThreshold = cfg.inspect<unknown>('chat.autoCompactThreshold')?.globalValue;
			await cfg.update('chat.autoCompact', true, vscode.ConfigurationTarget.Global);
			await cfg.update('chat.autoCompactThreshold', 0.8, vscode.ConfigurationTarget.Global);
			const preparations: { enabled: unknown; threshold: unknown; mode: string; sessionPrefix: string }[] = [];
			let requests = 0;
			const compactionService: ContextCompactionAdapter = {
				prepare: async (request) => {
					preparations.push(request);
					return { kind: 'ready', threshold: 0.8, experimental: true };
				},
				request: async () => {
					requests += 1;
					return { kind: 'success', threshold: 0.8, targeting: 'session', experimental: true };
				},
			};
			const task = await store.create('Use native context compaction');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceipt(store, 'develop')),
				folder,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				compactionService,
			);

			try {
				await runManager.handleAction(task.id, 'develop');
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'validation');
				assert.deepStrictEqual(preparations, [{
					enabled: true,
					threshold: 0.8,
					mode: 'agent',
					sessionPrefix: 'kanban-pilot-',
				}]);
				assert.strictEqual(requests, 0, 'Copilot native threshold handling must own automatic timing');
			} finally {
				runManager.dispose();
				await cfg.update('chat.autoCompact', previousEnabled, vscode.ConfigurationTarget.Global);
				await cfg.update('chat.autoCompactThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			}
		});

		test('explicit compaction preserves task state and records only bounded activity', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			const previousEnabled = cfg.inspect<unknown>('chat.autoCompact')?.globalValue;
			const previousThreshold = cfg.inspect<unknown>('chat.autoCompactThreshold')?.globalValue;
			await cfg.update('chat.autoCompact', true, vscode.ConfigurationTarget.Global);
			await cfg.update('chat.autoCompactThreshold', 0.8, vscode.ConfigurationTarget.Global);
			const task = await store.create('Explicitly compact this task');
			const session = sessionIdForTask(task.id, 'kanban-pilot-', store.setId);
			await store.patch(task.id, {
				state: 'in-progress',
				status: 'failed',
				run: 'r-compaction',
				chat: session,
				copilotSessionId: 'copilot-existing',
			});
			await store.appendLog(task.id, 'existing receipt history');
			const before = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			const requests: { taskId: string; session: string; threshold: unknown }[] = [];
			const activity = new WorkspaceActivityStore(folder.uri, store.setId);
			const compactionService: ContextCompactionAdapter = {
				prepare: async () => ({ kind: 'ready', threshold: 0.8, experimental: true }),
				request: async (currentTask, request) => {
					requests.push({ taskId: currentTask.id, session: currentTask.chat ?? '', threshold: request.threshold });
					return { kind: 'success', threshold: 0.8, targeting: 'session', experimental: true };
				},
			};
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(
				store,
				executor,
				folder,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				compactionService,
				activity,
			);

			try {
				const result = await runManager.compactTask(task.id);
				assert.strictEqual(result?.kind, 'success');
				assert.deepStrictEqual(requests, [{ taskId: task.id, session, threshold: 0.8 }]);
				assert.strictEqual(executor.calls.length, 0);

				const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
				assert.deepStrictEqual(
					{ state: after.state, status: after.status, run: after.run, chat: after.chat, sections: after.sections },
					{ state: before.state, status: before.status, run: before.run, chat: before.chat, sections: before.sections },
				);
				const records = await activity.readAll();
				assert.strictEqual(records.length, 1);
				assert.strictEqual(records[0].taskId, task.id);
				assert.strictEqual(records[0].message, 'Automatic chat compaction requested at threshold 0.8 for the task-bound session.');
				assert.strictEqual(records[0].message.includes('existing receipt history'), false);
			} finally {
				runManager.dispose();
				activity.dispose();
				await cfg.update('chat.autoCompact', previousEnabled, vscode.ConfigurationTarget.Global);
				await cfg.update('chat.autoCompactThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			}
		});

		test('resumes a failed develop task after compaction without changing its session binding', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			const previousEnabled = cfg.inspect<unknown>('chat.autoCompact')?.globalValue;
			const previousThreshold = cfg.inspect<unknown>('chat.autoCompactThreshold')?.globalValue;
			await cfg.update('chat.autoCompact', true, vscode.ConfigurationTarget.Global);
			await cfg.update('chat.autoCompactThreshold', 0.8, vscode.ConfigurationTarget.Global);
			const task = await store.create('Resume after context compaction');
			const session = sessionIdForTask(task.id, 'kanban-pilot-', store.setId);
			await store.patch(task.id, { state: 'in-progress', status: 'failed', chat: session, copilotSessionId: 'copilot-existing' });
			let compacted = false;
			const compactionService: ContextCompactionAdapter = {
				prepare: async () => ({ kind: 'ready', threshold: 0.8, experimental: true }),
				request: async () => {
					compacted = true;
					return { kind: 'success', threshold: 0.8, targeting: 'session', experimental: true };
				},
			};
			const executor = new StubExecutor(okReceipt(store, 'develop'));
			const runManager = new RunManager(
				store,
				executor,
				folder,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				compactionService,
			);

			try {
				await runManager.compactTask(task.id);
				assert.strictEqual(compacted, true);
				await runManager.handleAction(task.id, 'continue');
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'validation');
				assert.strictEqual(after.status, 'idle');
				assert.strictEqual(after.chat, session);
				assert.strictEqual(executor.calls[0].options.newChatBefore, undefined);
			} finally {
				runManager.dispose();
				await cfg.update('chat.autoCompact', previousEnabled, vscode.ConfigurationTarget.Global);
				await cfg.update('chat.autoCompactThreshold', previousThreshold, vscode.ConfigurationTarget.Global);
			}
		});
	});

	suite('develop stage', () => {
		test('a successful develop run advances In Progress → Validation', async () => {
			const existing = await store.create('Already in validation');
			await store.patch(existing.id, { state: 'validation' });
			const task = await store.create('Set up billing webhook');
			// 'develop' is only legal from Approved — it's the single click that
			// both moves the card into In Progress and launches the run.
			await store.patch(task.id, { state: 'approved', status: 'idle', position: '99' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'develop')), folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
			const validation = (await store.snapshot()).columns.find((column) => column.id === 'validation')!;
			assert.deepStrictEqual(validation.tasks.map((candidate) => candidate.id), [existing.id, task.id]);
			assert.deepStrictEqual(validation.tasks.map((candidate) => candidate.position), [0, 1]);
		});

		test('Continue retries a develop run from blocked/failed', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'in-progress', status: 'failed' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'develop')), folder);

			await runManager.handleAction(task.id, 'continue');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation', 'Continue must launch the same develop run refine/develop already use');
		});

		test('a scope edited after refine is flagged to the develop prompt (§6.8)', async () => {
			const task = await store.create('Set up billing webhook');
			// 'develop' is only legal from Approved (see the test above).
			await store.patch(task.id, {
				state: 'approved',
				status: 'idle',
				scope_hash: 'stale-hash-that-will-not-match',
			});
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');
			await waitUntil(() => executor.calls.length > 0);

			assert.ok(
				executor.calls[0].prompt.toLowerCase().includes('superseded'),
				'a scope_hash mismatch must surface the human-edit warning in the rendered prompt',
			);
		});
	});

	suite('task proposals (§6.12)', () => {
		test('a Develop success receipt without implementation evidence remains blocked', async () => {
			const task = await store.create('Do not complete without implementation');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const executor = new StubExecutor(async (currentTask, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(currentTask.id, formatReceipt({
					runId,
					taskId: currentTask.id,
					stage: 'develop',
					result: 'ok',
					note: 'no implementation performed',
				}));
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'in-progress');
			assert.strictEqual(after.status, 'blocked');
			assert.match(after.sections['Log'], /implementation evidence/i);
		});

		test('a Develop success receipt with invalid implementation evidence remains blocked', async () => {
			const task = await store.create('Reject task and generated evidence');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const executor = new StubExecutor(async (currentTask, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(currentTask.id, `- implementation-evidence run:${runId} files:".kanban-pilot/generated.js" verify:"npm test"`);
				await store.appendLog(currentTask.id, formatReceipt({
					runId,
					taskId: currentTask.id,
					stage: 'develop',
					result: 'ok',
					note: 'implementation reported as passed',
				}));
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'in-progress');
			assert.strictEqual(after.status, 'blocked');
			const finish = [...parseAuditEvents(after.sections['Log'])]
				.reverse()
				.find((event) => event.kind === 'activity-finish');
			assert.strictEqual(finish?.outcome, 'blocked');
			assert.strictEqual(finish?.note, 'Develop implementation evidence must name non-task, non-generated workspace files.');
		});

		test('a Develop success receipt with changed-file evidence advances', async () => {
			const task = await store.create('Complete with implementation evidence');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const executor = new StubExecutor(async (currentTask, prompt) => {
				const runId = runIdFromPrompt(prompt);
				const sourceDirectory = vscode.Uri.joinPath(dir, 'src');
				await vscode.workspace.fs.createDirectory(sourceDirectory);
				await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(sourceDirectory, 'evidence.ts'), Buffer.from('export {};', 'utf8'));
				await store.appendLog(currentTask.id, `- implementation-evidence run:${runId} files:"src/evidence.ts" verify:"npm test"`);
				await store.appendLog(currentTask.id, formatReceipt({
					runId,
					taskId: currentTask.id,
					stage: 'develop',
					result: 'ok',
					note: 'implemented evidence guard',
				}));
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
		});

		test('an explicitly task-only Scope allows a non-code Develop completion', async () => {
			const task = await store.create('Document the release process');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			await store.edit(task.id, {
				title: task.title,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: 'completion-evidence: task-only',
			});
			const executor = new StubExecutor(async (currentTask, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(currentTask.id, formatReceipt({
					runId,
					taskId: currentTask.id,
					stage: 'develop',
					result: 'ok',
					note: 'documentation completed',
				}));
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
		});

		test('a develop run\'s propose-task lines become real backlog tasks, marked with their origin', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'develop', ['Add retry backoff'])),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			const filed = tasks.find((t) => t.title === 'Add retry backoff');
			assert.ok(filed, 'the proposed task must have been created');
			assert.strictEqual(filed!.state, 'backlog');
			assert.strictEqual(filed!.originTask, task.id);
			assert.ok(filed!.sections['Request'].includes('found while working'));
		});

		test('a validate run can also propose follow-up tasks', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'validate', ['Document retry behavior'])),
				folder,
			);

			await runManager.handleAction(task.id, 'validate');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			assert.ok(tasks.some((t) => t.title === 'Document retry behavior'));
		});

		test('typed proposals override the parent, omitted types inherit it, and invalid types are ignored', async () => {
			const task = await store.create('Retry delivery failures', { type: 'bug' });
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(
					store,
					'develop',
					['Add retry metrics', 'Fix timeout handling', 'Invalid child'],
					['feature', undefined, 'regression'],
				)),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.find((candidate) => candidate.title === 'Add retry metrics')?.type, 'feature');
			assert.strictEqual(tasks.find((candidate) => candidate.title === 'Fix timeout handling')?.type, 'bug');
			assert.strictEqual(tasks.some((candidate) => candidate.title === 'Invalid child'), false);
		});

		test('omitted proposals attach to the run task while explicit parents stay separate from origin provenance', async () => {
			const task = await store.create('Proposal origin');
			const explicitParent = await store.create('Explicit parent');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(
					store,
					'develop',
					['Inherited child', 'Explicit child'],
					[],
					[undefined, explicitParent.id],
				)),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			const inherited = tasks.find((candidate) => candidate.title === 'Inherited child');
			const explicit = tasks.find((candidate) => candidate.title === 'Explicit child');
		assert.strictEqual(inherited?.parentTaskId, task.id);
		assert.strictEqual(explicit?.parentTaskId, explicitParent.id);
		assert.strictEqual(explicit?.originTask, task.id);
		assert.notStrictEqual(explicit?.originTask, explicit?.parentTaskId);
		});

		test('invalid proposal parents are retryable and do not create unattached tasks', async () => {
			const task = await store.create('Retry invalid proposal parent');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'develop', ['Waiting child'], [], ['TASK-999'])),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);
			assert.strictEqual((await store.readAll()).tasks.some((candidate) => candidate.title === 'Waiting child'), false);
			assert.match((await store.readAll()).tasks.find((candidate) => candidate.id === task.id)?.sections['Log'] ?? '', /proposal-error/);

			await vscode.workspace.fs.writeFile(
				store.fileFor('TASK-999'),
				Buffer.from(newTaskFile('TASK-999', 'Now available'), 'utf8'),
			);
			await runManager.reconcileTaskChange(task.id);
			await runManager.reconcileTaskChange(task.id);
			const children = (await store.readAll()).tasks.filter((candidate) => candidate.title === 'Waiting child');
			assert.strictEqual(children.length, 1);
			assert.strictEqual(children[0].parentTaskId, 'TASK-999');
		});

		test('refine ignores propose-task lines even if an agent writes one — scoping only, not filing', async () => {
			const task = await store.create('Set up billing webhook');
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'refine', ['Should not be created'])),
				folder,
			);

			await runManager.handleAction(task.id, 'accept');
			await runManager.handleAction(task.id, 'refine');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.length, 1, 'only the original task should exist — refine must not file proposals');
		});

		test('a run is capped at 5 proposals — a 6th is silently dropped', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const titles = Array.from({ length: 6 }, (_, i) => `Follow-up ${i + 1}`);
			const runManager = new RunManager(store, new StubExecutor(okReceiptWithProposals(store, 'develop', titles)), folder);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			const filed = tasks.filter((t) => t.title.startsWith('Follow-up'));
			assert.strictEqual(filed.length, 5, 'the cap must hold even when the agent asked for more');
		});

		test('kanbanPilot.chat.allowTaskProposals: false disables filing entirely', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.allowTaskProposals', false, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				const runManager = new RunManager(
					store,
					new StubExecutor(okReceiptWithProposals(store, 'develop', ['Should not be created'])),
					folder,
				);

				await runManager.handleAction(task.id, 'develop');
				await waitUntilSettled(store, task.id);

				const { tasks } = await store.readAll();
				assert.strictEqual(tasks.length, 1, 'the setting must suppress filing, not just hide it');
			} finally {
				await cfg.update('chat.allowTaskProposals', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a develop proposal written after its receipt is recovered by the bounded backstop', async () => {
			const task = await store.create('Recover a late develop proposal');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptThenProposals(store, 'develop', ['Written after develop receipt'])),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(store, task.id);
			await waitUntil(async () => (await store.readAll()).tasks.some((candidate) => candidate.title === 'Written after develop receipt'));

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.filter((candidate) => candidate.title === 'Written after develop receipt').length, 1);
			assert.strictEqual(tasks.find((candidate) => candidate.title === 'Written after develop receipt')?.originTask, task.id);
		});

		test('a validate proposal written after its receipt is recovered during task-change reconciliation', async () => {
			const task = await store.create('Recover a late validate proposal');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			let runId = '';
			const executor = new StubExecutor(async (t, prompt) => {
				runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'validate', result: 'ok', note: 'receipt first' }));
				return { ok: true, sessionId: 's1' };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'validate');
			await waitUntilSettled(store, task.id);
			await store.appendLog(task.id, `- propose-task run:${runId} title:"Written after validate receipt" note:"separate watcher event"`);
			await runManager.reconcileTaskChange(task.id);
			await runManager.reconcileTaskChange(task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.filter((candidate) => candidate.title === 'Written after validate receipt').length, 1);
			assert.strictEqual(tasks.find((candidate) => candidate.title === task.title)?.state, 'done');
		});

		test('activation reconciliation drains an already-settled proposal in the active task set', async () => {
			const namedDir = vscode.Uri.joinPath(dir, 'task-sets', 'set-proposals', 'tasks');
			const namedStore = new TaskStore(namedDir, 'set-proposals');
			await namedStore.ensureDirectory();
			const task = await namedStore.create('Recover proposal after reload');
			const runId = 'r-activation-proposal';
			await namedStore.auditedPatch(
				task.id,
				{ state: 'in-progress', status: 'running', run: runId },
				{
					action: 'develop',
					runId,
					events: [{ kind: 'activity-start', stage: 'develop', action: 'develop', runId }],
				},
			);
			await namedStore.appendLog(task.id, formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'ok', note: 'reload recovery' }));
			await namedStore.auditedPatch(
				task.id,
				{ state: 'validation', status: 'idle', run: undefined },
				{
					action: 'receipt',
					runId,
					outcome: 'ok',
					events: [{ kind: 'activity-finish', stage: 'develop', runId, outcome: 'ok' }],
				},
			);
			await namedStore.appendLog(task.id, `- propose-task run:${runId} title:"Recovered named child" note:"written after reload"`);

			const reloadedManager = new RunManager(namedStore, new StubExecutor(() => 'hang'), folder);
			await reloadedManager.reconcileOnActivation();
			await reloadedManager.reconcileTaskChange(task.id);

			const namedTasks = (await namedStore.readAll()).tasks;
			assert.strictEqual(namedTasks.filter((candidate) => candidate.title === 'Recovered named child').length, 1);
			assert.strictEqual((await store.readAll()).tasks.length, 0, 'the legacy Default task folder must remain untouched');
		});

		test('concurrent reconciliation managers file an accepted proposal only once', async () => {
			const task = await store.create('Prevent duplicate child tasks');
			const runId = 'r-concurrent-proposal';
			await store.auditedPatch(
				task.id,
				{ state: 'validation', status: 'idle', run: undefined },
				{
					action: 'receipt',
					runId,
					outcome: 'ok',
					events: [
						{ kind: 'activity-start', stage: 'develop', action: 'develop', runId },
						{ kind: 'activity-finish', stage: 'develop', action: 'receipt', runId, outcome: 'ok' },
					],
				},
			);
			await store.appendLog(task.id, formatReceipt({
				runId,
				taskId: task.id,
				stage: 'develop',
				result: 'ok',
				note: 'completed before concurrent reconciliation',
			}));
			await store.appendLog(task.id, `- propose-task run:${runId} title:"Create once" note:"reconciled concurrently"`);

			const secondStore = new TaskStore(dir, 'default');
			const firstManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			const secondManager = new RunManager(secondStore, new StubExecutor(() => 'hang'), folder);
			await Promise.all([
				firstManager.reconcileTaskChange(task.id),
				secondManager.reconcileTaskChange(task.id),
			]);

			const children = (await store.readAll()).tasks.filter((candidate) => candidate.originTask === task.id);
			assert.strictEqual(children.length, 1);
			assert.strictEqual(children[0].title, 'Create once');
		});

		test('a post-receipt child-write failure is recorded instead of being swallowed', async () => {
			const task = await store.create('Surface late proposal failure');
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const failingRename: vscode.FileSystem['rename'] = async (source, target, options) => {
				if (target.path.endsWith('/TASK-002.md')) {
					throw new Error('injected late child write failure');
				}
				return vscode.workspace.fs.rename(source, target, options);
			};
			const failingStore = new TaskStore(dir, 'default', failingRename);
			const runManager = new RunManager(
				failingStore,
				new StubExecutor(okReceiptThenProposals(failingStore, 'develop', ['Cannot persist this child'])),
				folder,
			);

			await runManager.handleAction(task.id, 'develop');
			await waitUntilSettled(failingStore, task.id);
			await waitUntil(async () => {
				const current = (await failingStore.readAll()).tasks.find((candidate) => candidate.id === task.id);
				return current?.sections['Log'].includes('proposal-error') === true;
			});

			const current = (await failingStore.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.ok(current.sections['Log'].includes('injected late child write failure'));
			assert.strictEqual((await failingStore.readAll()).tasks.some((candidate) => candidate.title === 'Cannot persist this child'), false);
		});
	});

	suite('split stage (§6.14)', () => {
		test('split is legal straight from Backlog and launches a run there', async () => {
			const task = await store.create('Rebuild the whole onboarding flow');
			const executor = new StubExecutor(() => 'hang');
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'split');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'refine', 'split reuses the Refine column as its in-flight state');
			assert.strictEqual(after.status, 'running');
			assert.ok(after.run, 'a run id must be assigned before the agent has even responded');

			await waitUntil(() => executor.calls.length > 0);
			assert.strictEqual(executor.calls.length, 1);
		});

		test('a successful split files children and retires the parent as tracking-only', async () => {
			const task = await store.create('Rebuild the whole onboarding flow');
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'split', ['Redesign the welcome screen', 'Add progress indicator'])),
				folder,
			);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'done', 'the parent has nothing left to do once split');
			assert.strictEqual(after.status, 'idle');

			const { tasks } = await store.readAll();
			const children = tasks.filter((t) => t.originTask === task.id);
			assert.strictEqual(children.length, 2);
			assert.ok(children.every((c) => c.state === 'backlog'));
			assert.deepStrictEqual(
				children.map((c) => c.title).sort(),
				['Add progress indicator', 'Redesign the welcome screen'],
			);
		});

		test('split children use the active named task-set directory and snapshot', async () => {
			const namedDir = vscode.Uri.joinPath(dir, 'task-sets', 'set-mobile', 'tasks');
			const namedStore = new TaskStore(namedDir, 'set-mobile');
			await namedStore.ensureDirectory();
			const task = await namedStore.create('Rebuild the mobile onboarding flow');
			const runManager = new RunManager(
				namedStore,
				new StubExecutor(okReceiptWithProposals(namedStore, 'split', ['Mobile welcome', 'Mobile progress'])),
				folder,
			);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(namedStore, task.id);
			const { tasks } = await namedStore.readAll();
			const children = tasks.filter((candidate) => candidate.originTask === task.id);

			assert.strictEqual(after.state, 'done');
			assert.strictEqual(children.length, 2);
			assert.ok(children.every((child) => child.setId === 'set-mobile'));
			assert.ok(children.every((child) => child.originRunId));
			assert.ok(children.every((child) => child.originProposalKey));
			assert.strictEqual((await store.readAll()).tasks.length, 0, 'the default task folder must remain untouched');
			assert.deepStrictEqual(
				(await namedStore.snapshot()).columns.find((column) => column.id === 'backlog')?.tasks.map((candidate) => candidate.title),
				['Mobile welcome', 'Mobile progress'],
			);
		});

		test('receipt observed before proposals waits for the separate proposal write', async () => {
			const task = await store.create('Reconcile split write ordering');
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptThenProposals(store, 'split', ['Written after receipt'], 300)),
				folder,
			);

			await runManager.handleAction(task.id, 'split');
			await waitUntil(async () => {
				const current = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
				return current?.state === 'done' && current.status === 'idle' && !current.run && !current.pendingOutcome;
			});

			const { tasks } = await store.readAll();
			const after = tasks.find((candidate) => candidate.id === task.id)!;
			const children = tasks.filter((candidate) => candidate.originTask === task.id);

			assert.strictEqual(after.state, 'done');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(after.pendingOutcome, undefined);
			assert.strictEqual(children.length, 1);
			assert.strictEqual(children[0].title, 'Written after receipt');

			await runManager.reconcileTaskChange(task.id);
			await runManager.reconcileTaskChange(task.id);
			const afterRepeatedReconciliation = (await store.readAll()).tasks;
			assert.strictEqual(afterRepeatedReconciliation.filter((candidate) => candidate.originTask === task.id).length, 1);
		});

		test('a successful split with no usable proposals remains retryably blocked', async () => {
			const task = await store.create('Do not retire without children');
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'split', result: 'ok', note: 'missing proposals' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'blocked');
			assert.ok(after.sections['Log'].includes('no usable proposals'));
			assert.ok(after.sections['Log'].includes('awaiting late receipt'));
			assert.strictEqual((await store.readAll()).tasks.length, 1);
		});

		test('blocked and failed split receipts never create children', async () => {
			const task = await store.create('Keep blocked split intact');
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, `- propose-task run:${runId} title:"Must not be filed" note:"blocked split"`);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'split', result: 'failed', note: 'split failed' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'failed');
			assert.strictEqual((await store.readAll()).tasks.length, 1);
		});

		test('split creation failure leaves a retryable parent and a retry creates no duplicates', async () => {
			const task = await store.create('Recover a partial split');
			const failingRename: vscode.FileSystem['rename'] = async (source, target, options) => {
				if (target.path.endsWith('/TASK-003.md')) {
					throw new Error('injected child write failure');
				}
				return vscode.workspace.fs.rename(source, target, options);
			};
			const failingStore = new TaskStore(dir, 'default', failingRename);
			const firstRun = new RunManager(
				failingStore,
				new StubExecutor(okReceiptWithProposals(failingStore, 'split', ['First child', 'Second child'])),
				folder,
			);

			await firstRun.handleAction(task.id, 'split');
			const blocked = await waitUntilSettled(store, task.id);
			assert.strictEqual(blocked.state, 'refine');
			assert.strictEqual(blocked.status, 'blocked');
			assert.strictEqual((await store.readAll()).tasks.filter((candidate) => candidate.originTask === task.id).length, 1);

			const retry = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await retry.reconcileTaskChange(task.id);
			await retry.reconcileTaskChange(task.id);
			const after = (await store.readAll()).tasks;

			assert.strictEqual(after.find((candidate) => candidate.id === task.id)?.state, 'done');
			assert.strictEqual(after.filter((candidate) => candidate.originTask === task.id).length, 2);
		});

		test('activation reconciliation completes a persisted split run', async () => {
			const task = await store.create('Recover split after reload');
			const runId = 'r-activation-split';
			await store.auditedPatch(
				task.id,
				{ state: 'refine', status: 'running', run: runId },
				{
					action: 'split',
					runId,
					events: [{ kind: 'activity-start', stage: 'split', action: 'split', runId }],
				},
			);
			await store.appendLog(task.id, `- propose-task run:${runId} title:"Recovered child" note:"written before reload"`);
			await store.appendLog(task.id, formatReceipt({ runId, taskId: task.id, stage: 'split', result: 'ok', note: 'reload recovery' }));

			const reloadedManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await reloadedManager.reconcileOnActivation();
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'done');
			assert.strictEqual((await store.readAll()).tasks.filter((candidate) => candidate.originTask === task.id).length, 1);
		});

		test('a late split receipt after the blocked marker recovers once proposals arrive', async () => {
			const task = await store.create('Recover a late split completion');
			const runManager = new RunManager(store, new StubExecutor(async () => ({ ok: true })), folder);

			await runManager.handleAction(task.id, 'split');
			const blocked = await waitUntilSettled(store, task.id);
			const marker = parseReceipts(blocked.sections['Log']).find(
				(receipt) => receipt.stage === 'split' && receipt.result === 'blocked',
			);
			assert.ok(marker, 'the missing-receipt fallback must leave a split marker');

			await store.appendLog(task.id, `- propose-task run:${marker!.runId} title:"Late child" note:"arrived after fallback"`);
			await store.appendLog(
				task.id,
				formatReceipt({ runId: marker!.runId, taskId: task.id, stage: 'split', result: 'ok', note: 'late split completion' }),
			);
			await runManager.reconcileTaskChange(task.id);
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'done');
			assert.strictEqual((await store.readAll()).tasks.filter((candidate) => candidate.originTask === task.id).length, 1);
		});

		test('split proposals are filed even when kanbanPilot.chat.allowTaskProposals is off', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('chat.allowTaskProposals', false, vscode.ConfigurationTarget.Global);
			try {
				const task = await store.create('Rebuild the whole onboarding flow');
				const runManager = new RunManager(
					store,
					new StubExecutor(okReceiptWithProposals(store, 'split', ['Redesign the welcome screen'])),
					folder,
				);

				await runManager.handleAction(task.id, 'split');
				await waitUntilSettled(store, task.id);

				const { tasks } = await store.readAll();
				assert.ok(
					tasks.some((t) => t.title === 'Redesign the welcome screen'),
					'split is the point of clicking the icon, not an optional side effect — the setting must not suppress it',
				);
			} finally {
				await cfg.update('chat.allowTaskProposals', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('a task deemed too small to split parks back in Refine/blocked, ready for an ordinary Refine retry', async () => {
			const task = await store.create('Fix a typo in the footer');
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(
					t.id,
					formatReceipt({ runId, taskId: t.id, stage: 'split', result: 'blocked', note: 'already small enough for one ticket' }),
				);
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'blocked');

			// The ordinary Refine action must now be able to pick it straight up.
			const retry = await invokeTaskAction(store, task.id, 'refine');
			assert.strictEqual(retry.kind, 'applied');
		});

		test('split is still capped at 5 proposals', async () => {
			const task = await store.create('Rebuild the whole onboarding flow');
			const titles = Array.from({ length: 7 }, (_, i) => `Piece ${i + 1}`);
			const runManager = new RunManager(store, new StubExecutor(okReceiptWithProposals(store, 'split', titles)), folder);

			await runManager.handleAction(task.id, 'split');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.filter((t) => t.title.startsWith('Piece')).length, 5);
		});

		test('split preserves explicit types and inherits the parent type', async () => {
			const task = await store.create('Split a delivery bug', { type: 'bug' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(
					store,
					'split',
					['Typed feature', 'Inherited bug', 'Invalid type'],
					['feature', undefined, 'regression'],
				)),
				folder,
			);

			await runManager.handleAction(task.id, 'split');
			await waitUntilSettled(store, task.id);

			const { tasks } = await store.readAll();
			assert.strictEqual(tasks.find((candidate) => candidate.title === 'Typed feature')?.type, 'feature');
			assert.strictEqual(tasks.find((candidate) => candidate.title === 'Inherited bug')?.type, 'bug');
			assert.strictEqual(tasks.some((candidate) => candidate.title === 'Invalid type'), false);
		});

		test('equivalent explicit and inherited split proposals are filed once', async () => {
			const task = await store.create('Avoid duplicate split work', { type: 'bug' });
			const runManager = new RunManager(
				store,
				new StubExecutor(okReceiptWithProposals(store, 'split', ['One child', 'One child'], [undefined, 'bug'])),
				folder,
			);

			await runManager.handleAction(task.id, 'split');
			const after = await waitUntilSettled(store, task.id);
			const { tasks } = await store.readAll();

			assert.strictEqual(after.state, 'done');
			assert.strictEqual(tasks.filter((candidate) => candidate.originTask === task.id).length, 1);
		});
	});

	suite('validate stage — the three-way branch', () => {
		test('result:ok moves Validation → Done', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'validate')), folder);

			await runManager.handleAction(task.id, 'validate');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'done');
			assert.strictEqual(after.status, 'idle');
		});

		test('result:failed sends the card back to In Progress for another pass — this is a verdict, not an error (§6.3)', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'validate', result: 'failed', note: 'missing idempotency test' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'validate');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'in-progress', 'a failed validation must bounce back, not just sit blocked');
			assert.strictEqual(after.status, 'idle');
		});

		test('result:blocked stays in Validation rather than bouncing or advancing', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const executor = new StubExecutor(async (t, prompt) => {
				const runId = runIdFromPrompt(prompt);
				await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage: 'validate', result: 'blocked', note: 'ambiguous criteria' }));
				return { ok: true };
			});
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'validate');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'blocked');
		});

		test('an errored validate run (no receipt at all) fails in place rather than being misread as result:failed', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'validation', status: 'idle' });
			const executor = new StubExecutor(async () => ({ ok: false, error: 'model unavailable' }));
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'validate');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation', 'an executor error must not be conflated with a real "criteria not met" verdict');
			assert.strictEqual(after.status, 'failed');
		});
	});

	suite('lifecycle events and disposal', () => {
		test('emits ordered start, pending, promotion, receipt, and completion events', async () => {
			const task = await store.create('Observe a successful lifecycle');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(okReceipt(store, 'refine'));
			const runManager = new RunManager(store, executor, folder);
			const events: { kind: string; taskId?: string; runId?: string; stage?: string }[] = [];
			const subscription = runManager.onDidChange((change) => events.push(change));
			try {
				await runManager.handleAction(task.id, 'refine');
				await waitUntil(() => events.some((event) => event.kind === 'completion'));
				assert.deepStrictEqual(events.map((event) => event.kind), [
					'start',
					'pending-outcome',
					'promotion',
					'receipt',
					'completion',
				]);
				assert.ok(events.every((event) => event.taskId === task.id));
				assert.ok(events.filter((event) => event.kind !== 'promotion').every((event) => event.runId));
				assert.ok(events.filter((event) => event.kind !== 'promotion').every((event) => event.stage === 'refine'));
				assert.strictEqual((runManager as unknown as { progressTimers: Set<unknown> }).progressTimers.size, 0);
			} finally {
				subscription.dispose();
				runManager.dispose();
			}
		});

		test('emits failed before completion when the executor reports an error', async () => {
			const task = await store.create('Observe a failed lifecycle');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(async () => ({ ok: false, error: 'chat unavailable' })), folder);
			const events: string[] = [];
			const subscription = runManager.onDidChange((change) => events.push(change.kind));
			try {
				await runManager.handleAction(task.id, 'refine');
				await waitUntil(() => events.includes('completion'));
				assert.deepStrictEqual(events, ['start', 'failed', 'completion']);
			} finally {
				subscription.dispose();
				runManager.dispose();
			}
		});

		test('disposal clears timers, releases an active reservation, and suppresses late events', async () => {
			const task = await store.create('Dispose an unresolved lifecycle');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const pending = deferred<ExecutorResult>();
			const executor = new StubExecutor(() => pending.promise);
			const runManager = new RunManager(store, executor, folder);
			const events: string[] = [];
			const subscription = runManager.onDidChange((change) => events.push(change.kind));
			try {
				await runManager.handleAction(task.id, 'refine');
				await waitUntil(() => events.includes('start'));
				await waitUntil(() => (runManager as unknown as { progressTimers: Set<unknown> }).progressTimers.size === 1);
				await waitUntil(() => executor.calls.length === 1);
				const coordinator = (runManager as unknown as {
					concurrency: { active: Set<string> };
				}).concurrency;
				assert.strictEqual(coordinator.active.size, 1);
				const eventsBeforeDispose = [...events];

				runManager.dispose();
				assert.strictEqual((runManager as unknown as { progressTimers: Set<unknown> }).progressTimers.size, 0);
				await waitUntil(() => coordinator.active.size === 0);

				pending.resolve({ ok: true, sessionId: 'late-session' });
				await new Promise((resolve) => setTimeout(resolve, 50));
				assert.deepStrictEqual(events, eventsBeforeDispose);
			} finally {
				subscription.dispose();
				runManager.dispose();
			}
		});
	});

	suite('stop', () => {
		test('stop clears the run id, so a resolution that arrives afterward cannot clobber the stop', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let resolveRun: ((r: ExecutorResult) => void) | undefined;
			const executor = new StubExecutor(() => new Promise((resolve) => (resolveRun = resolve)));
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length > 0);
			assert.ok((await store.readAll()).tasks[0].run, 'sanity: a run id is set while running');

			await runManager.handleAction(task.id, 'stop');
			const stopped = (await store.readAll()).tasks[0];
			assert.deepStrictEqual(executor.cancelCalls.map((call) => call.task.id), [task.id]);
			assert.strictEqual(stopped.state, 'refine');
			assert.strictEqual(stopped.status, 'idle');
			assert.strictEqual(stopped.run, undefined, 'Stop must clear run — otherwise a late resolution reconciles against a stale id');

			resolveRun!({ ok: true, sessionId: 's1' });
			await new Promise((r) => setTimeout(r, 200));

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'idle', 'the late resolution must find no matching run and do nothing');
			assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.kind === 'activity-finish').length, 1);
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.outcome === 'stopped'));
		});

		test('a cancellation failure leaves the run active and does not record a false stop', async () => {
			const task = await store.create('Keep running when cancellation fails');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(
				() => 'hang',
				{ kind: 'failed', error: 'cancel command unavailable' },
			);
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length === 1);
			const runId = (await store.readAll()).tasks[0].run;
			await runManager.handleAction(task.id, 'stop');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'running');
			assert.strictEqual(after.run, runId);
			assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.kind === 'activity-finish').length, 0);
			runManager.dispose();
		});

		test('no active executor turn is an idempotent Stop success', async () => {
			const task = await store.create('Turn already completed');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const executor = new StubExecutor(() => 'hang', { kind: 'no-active-turn' });
			const runManager = new RunManager(store, executor, folder);

			await runManager.handleAction(task.id, 'refine');
			await waitUntil(() => executor.calls.length === 1);
			await runManager.handleAction(task.id, 'stop');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.run, undefined);
			assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.kind === 'activity-finish' && event.outcome === 'stopped').length, 1);
		});

		test('stopping one concurrent task cancels only its executor turn', async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('run.maxParallelTasks', 2, vscode.ConfigurationTarget.Global);
			try {
				const first = await store.create('First concurrent run');
				const second = await store.create('Second concurrent run');
				await store.patch(first.id, { state: 'refine', status: 'idle' });
				await store.patch(second.id, { state: 'refine', status: 'idle' });
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.handleAction(first.id, 'refine');
				await runManager.handleAction(second.id, 'refine');
				await waitUntil(() => executor.calls.length === 2);
				await runManager.handleAction(first.id, 'stop');

				assert.deepStrictEqual(executor.cancelCalls.map((call) => call.task.id), [first.id]);
				const tasks = (await store.readAll()).tasks;
				assert.strictEqual(tasks.find((candidate) => candidate.id === first.id)?.status, 'idle');
				assert.strictEqual(tasks.find((candidate) => candidate.id === second.id)?.status, 'running');
				runManager.dispose();
			} finally {
				await cfg.update('run.maxParallelTasks', undefined, vscode.ConfigurationTarget.Global);
			}
		});

		test('stop on In Progress bounces to Approved (Stop + reset)', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'in-progress', status: 'running', run: 'r1' });
			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

			await runManager.handleAction(task.id, 'stop');

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'approved');
			assert.strictEqual(after.run, undefined);
		});
	});

	test('markRunComplete resolves a stuck running task and appends a receipt', async () => {
		const task = await store.create('Set up billing webhook');
		await store.patch(task.id, { state: 'refine', status: 'running', run: 'r-manual' });

		const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
		await runManager.markRunComplete(task.id, 'ok', 'finished by hand');

		const after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'scoped');
		assert.strictEqual(after.status, 'idle');
		assert.ok(after.sections['Log'].includes('finished by hand'));
		assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.action === 'manual-complete'));
	});

	test('lists a stale successful receipt without allowing automatic reconciliation to adopt it', async () => {
		const task = await store.create('Recover the completed implementation');
		await seedStaleCompletionHistory(store, task, 'develop', 'rignbml', 'rzpjmzh');
		const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

		await manager.reconcileTaskChange(task.id);
		let after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'in-progress');
		assert.strictEqual(after.status, 'failed');
		assert.strictEqual(after.pendingOutcome, undefined);

		const candidates = await manager.listStaleCompletionCandidates(task.id);
		assert.deepStrictEqual(candidates, [{
			taskId: task.id,
			runId: 'rignbml',
			stage: 'develop',
			result: 'ok',
			note: 'implementation finished in the earlier run',
			summary: 'implementation finished in the earlier run',
			currentRunId: undefined,
			latestRunId: 'rzpjmzh',
			supersededByRunId: 'rzpjmzh',
		}]);
		assert.strictEqual(new StubExecutor(() => 'hang').calls.length, 0);

		after = (await store.readAll()).tasks[0];
		assert.strictEqual(after.state, 'in-progress', 'stale success must not be auto-applied');
		assert.strictEqual(after.status, 'failed');
	});

	test('explicit stale recovery applies the normal Develop gate, proposals, and correction audit exactly once', async () => {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		await cfg.update('gates.developToValidation', 'auto', vscode.ConfigurationTarget.Global);
		try {
			const task = await store.create('Recover Develop without rerunning it');
			await seedStaleCompletionHistory(store, task, 'develop', 'r-old', 'r-new', true);
			const executor = new StubExecutor(() => 'hang');
			const manager = new RunManager(store, executor, folder);

			const result = await manager.recoverStaleCompletion(task.id, 'r-old', 'develop');
			assert.deepStrictEqual(result, { kind: 'recovered', runId: 'r-old', stage: 'develop', gate: 'developToValidation' });
			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.pendingOutcome, undefined, 'the configured automatic gate should promote the recovered outcome');
			assert.strictEqual(executor.calls.length, 0, 'recovery must not launch another executor run');
			assert.strictEqual(parseReceipts(after.sections['Log']).filter((receipt) => receipt.runId === 'r-old' && receipt.result === 'ok').length, 1);
			assert.strictEqual(parseAuditEvents(after.sections['Log']).filter((event) => event.action === 'manual-recovery').length, 1);
			assert.strictEqual((await store.readAll()).tasks.filter((candidate) => candidate.title === 'Recovered follow-up').length, 1);

			const reloadedManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await reloadedManager.reconcileOnActivation();
			await reloadedManager.reconcileTaskChange(task.id);
			const repeated = await reloadedManager.recoverStaleCompletion(task.id, 'r-old', 'develop');
			assert.notStrictEqual(repeated.kind, 'recovered');
			const repeatedTask = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(parseAuditEvents(repeatedTask.sections['Log']).filter((event) => event.action === 'manual-recovery').length, 1);
		} finally {
			await cfg.update('gates.developToValidation', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('manual stale recovery preserves the Refine scope hash in a pending completion', async () => {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		await cfg.update('gates.refineToScoped', 'manual', vscode.ConfigurationTarget.Global);
		try {
			const task = await store.create('Recover Refine scope');
			await store.edit(task.id, {
				title: task.title,
				request: task.sections.Request ?? '',
				refined: task.sections.Refined ?? '',
				scope: 'Recovered scope\n\n- Keep the original receipt.',
			});
			await seedStaleCompletionHistory(store, task, 'refine', 'r-refine', 'r-refine-retry');
			const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

			const result = await manager.recoverStaleCompletion(task.id, 'r-refine', 'refine');
			assert.deepStrictEqual(result, { kind: 'recovered', runId: 'r-refine', stage: 'refine', gate: 'refineToScoped' });
			const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.state, 'refine');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.pendingOutcome?.scopeHash, hashScope(after.sections.Scope));
			assert.strictEqual(after.pendingOutcome?.scopeHash, hashScope('Recovered scope\n\n- Keep the original receipt.'));
		} finally {
			await cfg.update('gates.refineToScoped', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('manual stale Develop recovery keeps the normal pending gate until it is applied', async () => {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		await cfg.update('gates.developToValidation', 'manual', vscode.ConfigurationTarget.Global);
		try {
			const task = await store.create('Recover Develop with a manual gate');
			await seedStaleCompletionHistory(store, task, 'develop', 'r-manual-old', 'r-manual-retry');
			const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

			assert.deepStrictEqual(
				await manager.recoverStaleCompletion(task.id, 'r-manual-old', 'develop'),
				{ kind: 'recovered', runId: 'r-manual-old', stage: 'develop', gate: 'developToValidation' },
			);
			let after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.state, 'in-progress');
			assert.strictEqual(after.status, 'idle');
			assert.strictEqual(after.pendingOutcome?.gate, 'developToValidation');

			assert.deepStrictEqual(await manager.applyPendingOutcome(task.id), { kind: 'applied', gate: 'developToValidation' });
			after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.pendingOutcome, undefined);
		} finally {
			await cfg.update('gates.developToValidation', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('stale Validate recovery uses the normal Validate-to-Done semantics', async () => {
		const task = await store.create('Recover Validate without rerunning QA');
		await seedStaleCompletionHistory(store, task, 'validate', 'r-validate-old', 'r-validate-retry');
		const executor = new StubExecutor(() => 'hang');
		const manager = new RunManager(store, executor, folder);

		const result = await manager.recoverStaleCompletion(task.id, 'r-validate-old', 'validate');
		assert.deepStrictEqual(result, { kind: 'recovered', runId: 'r-validate-old', stage: 'validate', gate: 'validateToDone' });
		const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
		assert.strictEqual(after.state, 'done');
		assert.strictEqual(after.status, 'idle');
		assert.strictEqual(after.pendingOutcome, undefined);
		assert.strictEqual(executor.calls.length, 0);
		assert.ok(parseAuditEvents(after.sections['Log']).some((event) =>
			event.kind === 'activity-finish' && event.action === 'manual-recovery' && event.correction && event.outcome === 'ok',
		));
	});

	test('stale recovery accepts a canonical success after a missing-receipt fallback', async () => {
		const task = await store.create('Recover a blocked completion');
		await seedStaleCompletionHistory(store, task, 'develop', 'r-missing-receipt', undefined, false, 'missing-receipt');
		const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

		const candidates = await manager.listStaleCompletionCandidates(task.id);
		assert.strictEqual(candidates.length, 1);
		assert.strictEqual(candidates[0].runId, 'r-missing-receipt');
		assert.deepStrictEqual(
			await manager.recoverStaleCompletion(task.id, 'r-missing-receipt', 'develop'),
			{ kind: 'recovered', runId: 'r-missing-receipt', stage: 'develop', gate: 'developToValidation' },
		);
		assert.strictEqual((await store.readAll()).tasks[0].state, 'validation');
	});

	test('stale recovery does not deadlock when applying the correction fails', async () => {
		const task = await store.create('Recover with a persistence failure');
		await seedStaleCompletionHistory(store, task, 'develop', 'r-persistence-failure');
		const failingStore = new TaskStore(store.directory, store.setId, async () => {
			throw new Error('simulated recovery write failure');
		});
		const manager = new RunManager(failingStore, new StubExecutor(() => 'hang'), folder);
		const completion = manager.recoverStaleCompletion(task.id, 'r-persistence-failure', 'develop');
		const result = await Promise.race([
			completion.then(() => 'resolved', () => 'rejected'),
			new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 500)),
		]);
		assert.strictEqual(result, 'rejected', 'recovery errors must release the coordinator instead of waiting on a nested lock');
	});

	test('stale recovery requires extension history, a fallback marker, and the exact stage', async () => {
		const noHistory = await store.create('Success with no extension history');
		await store.patch(noHistory.id, { state: 'in-progress', status: 'failed' });
		await store.appendLog(noHistory.id, formatReceipt({
			runId: 'r-no-history',
			taskId: noHistory.id,
			stage: 'develop',
			result: 'ok',
			note: 'hand written success',
		}));

		const fallbackOnly = await store.create('Fallback with no success');
		await seedStaleCompletionHistory(store, fallbackOnly, 'develop', 'r-fallback-only', undefined, false, 'timeout', false);

		const wrongStage = await store.create('Success for the wrong stage');
		await seedStaleCompletionHistory(store, wrongStage, 'refine', 'r-wrong-stage');
		await store.patch(wrongStage.id, { state: 'in-progress', status: 'failed' });

		const wrongTask = await store.create('Receipt names another task');
		await store.patch(wrongTask.id, { state: 'in-progress', status: 'failed' });
		await store.appendLog(wrongTask.id, formatReceipt({
			runId: 'r-wrong-task',
			taskId: 'TASK-999',
			stage: 'develop',
			result: 'ok',
			note: 'misrouted success',
		}));

		const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
		for (const task of [noHistory, fallbackOnly, wrongStage, wrongTask]) {
			assert.deepStrictEqual(await manager.listStaleCompletionCandidates(task.id), [], task.title);
		}
	});

	test('stale recovery filters arbitrary receipts, active runs, and manually moved tasks', async () => {
		const arbitrary = await store.create('Reject an arbitrary success');
		await store.patch(arbitrary.id, { state: 'in-progress', status: 'failed' });
		await store.appendLog(arbitrary.id, formatReceipt({ runId: 'hand-written', taskId: arbitrary.id, stage: 'develop', result: 'ok', note: 'not extension-owned' }));
		const manager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
		assert.deepStrictEqual(await manager.listStaleCompletionCandidates(arbitrary.id), []);
		assert.notStrictEqual((await manager.recoverStaleCompletion(arbitrary.id, 'hand-written', 'develop')).kind, 'recovered');

		const active = await store.create('Reject while newer run is active');
		await seedStaleCompletionHistory(store, active, 'develop', 'r-active-old');
		await store.patch(active.id, { status: 'running', run: 'r-active-new' });
		assert.deepStrictEqual(await manager.listStaleCompletionCandidates(active.id), []);
		assert.strictEqual((await manager.recoverStaleCompletion(active.id, 'r-active-old', 'develop')).kind, 'active-run');

		const moved = await store.create('Reject after manual move');
		await seedStaleCompletionHistory(store, moved, 'develop', 'r-moved-old');
		assert.deepStrictEqual(await manager.moveTask(moved.id, 'done'), { kind: 'applied' });
		await manager.moveTask(moved.id, 'in-progress');
		await store.patch(moved.id, { status: 'failed' });
		assert.deepStrictEqual(await manager.listStaleCompletionCandidates(moved.id), []);
	});

	suite('configurable run capacity', () => {
		async function withMaxParallelTasks(value: unknown, fn: () => Promise<void>): Promise<void> {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			try {
				await cfg.update('run.maxParallelTasks', value, vscode.ConfigurationTarget.Global);
				await fn();
			} finally {
				await cfg.update('run.maxParallelTasks', undefined, vscode.ConfigurationTarget.Global);
			}
		}

		test('invalid values normalize to the safe single-run default', () => {
		for (const value of [undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.strictEqual(normalizeMaxParallelTasks(value), 1);
		}
		assert.strictEqual(normalizeMaxParallelTasks(2), 2);
	});

		test('the default capacity is one and a full-capacity manual start is untouched', async () => {
		const first = await store.create('First run');
		const second = await store.create('Second run');
		await store.patch(first.id, { state: 'approved', status: 'idle' });
		await store.patch(second.id, { state: 'approved', status: 'idle' });
		const firstExecutor = new StubExecutor(() => 'hang');
		const secondExecutor = new StubExecutor(() => 'hang');
		const firstManager = new RunManager(store, firstExecutor, folder);
		const secondManager = new RunManager(store, secondExecutor, folder);

		await firstManager.handleAction(first.id, 'develop');
		await waitUntil(() => firstExecutor.calls.length === 1);
		await secondManager.handleAction(second.id, 'develop');

		const after = (await store.readAll()).tasks.find((task) => task.id === second.id)!;
		assert.strictEqual(after.state, 'approved');
		assert.strictEqual(after.status, 'idle');
		assert.strictEqual(after.run, undefined);
		assert.strictEqual(secondExecutor.calls.length, 0, 'capacity denial must not invoke the executor');
	});

	test('a second Develop run uses the remaining slot, while a third waits until capacity is released', async () => {
		await withMaxParallelTasks(2, async () => {
			const first = await store.create('First Develop run');
			const second = await store.create('Second Develop run');
			const third = await store.create('Queued Develop run');
			for (const task of [first, second, third]) {
				await store.patch(task.id, { state: 'approved', status: 'idle' });
			}
			const firstExecutor = new StubExecutor(() => 'hang');
			const secondExecutor = new StubExecutor(() => 'hang');
			const thirdExecutor = new StubExecutor(() => 'hang');
			const firstManager = new RunManager(store, firstExecutor, folder);
			const secondManager = new RunManager(store, secondExecutor, folder);
			const thirdManager = new RunManager(store, thirdExecutor, folder);

			await firstManager.handleAction(first.id, 'develop');
			await waitUntil(() => firstExecutor.calls.length === 1);
			await secondManager.handleAction(second.id, 'develop');
			await waitUntil(() => secondExecutor.calls.length === 1);

			let after = await store.readAll();
			const firstAfter = after.tasks.find((task) => task.id === first.id)!;
			const secondAfter = after.tasks.find((task) => task.id === second.id)!;
			assert.strictEqual(firstAfter.status, 'running');
			assert.strictEqual(secondAfter.status, 'running');
			assert.ok(firstAfter.run);
			assert.ok(secondAfter.run);
			assert.notStrictEqual(firstAfter.run, secondAfter.run);

			await thirdManager.handleAction(third.id, 'develop');
			after = await store.readAll();
			const thirdAfter = after.tasks.find((task) => task.id === third.id)!;
			assert.strictEqual(thirdAfter.state, 'approved');
			assert.strictEqual(thirdAfter.status, 'idle');
			assert.strictEqual(thirdAfter.run, undefined);
			assert.strictEqual(thirdExecutor.calls.length, 0);

			await firstManager.handleAction(first.id, 'stop');
			await thirdManager.handleAction(third.id, 'develop');
			await waitUntil(() => thirdExecutor.calls.length === 1);
		});
	});

	test('configured capacity reaches two real chat injections before either response settles', async () => {
		await withMaxParallelTasks(2, async () => {
			const first = await store.create('First real chat run');
			const second = await store.create('Second real chat run');
			const third = await store.create('Run after a real completion');
			for (const task of [first, second, third]) {
				await store.patch(task.id, { state: 'approved', status: 'idle' });
			}

			const commands = new PendingChatCommands();
			const manager = new RunManager(store, new ChatSessionExecutor(commands), folder);
			await Promise.all([
				manager.handleAction(first.id, 'develop'),
				manager.handleAction(second.id, 'develop'),
			]);

			await waitUntil(() => commands.responses.length === 2);
			let after = await store.readAll();
			assert.strictEqual(after.tasks.filter((task) => task.status === 'running').length, 2);

			const responseCountBeforeDuplicateStart = commands.responses.length;
			await manager.handleAction(first.id, 'continue');
			assert.strictEqual(
				commands.responses.length,
				responseCountBeforeDuplicateStart,
				'a second start for an active task must be rejected by the coordinator',
			);

			const settle = async (pending: { runId: string; deferred: Deferred<unknown> }): Promise<Task> => {
				const current = (await store.readAll()).tasks.find((task) => task.run === pending.runId);
				if (!current) {
					throw new Error(`No running task found for ${pending.runId}`);
				}
				pending.deferred.resolve({ metadata: { sessionId: `session-${current.id}` } });
				await store.appendLog(current.id, formatReceipt({
					runId: pending.runId,
					taskId: current.id,
					stage: 'develop',
					result: 'ok',
					note: 'real chat completion',
				}));
				const settled = await waitUntilSettled(store, current.id);
				assert.strictEqual(settled.copilotSessionId, `session-${current.id}`);
				return settled;
			};

			const firstRunId = (await store.readAll()).tasks.find((task) => task.id === first.id)?.run;
			const firstResponse = commands.responses.find((response) => response.runId === firstRunId);
			if (!firstResponse) {
				throw new Error('First real chat response was not registered');
			}
			await settle(firstResponse);

			await waitUntil(async () => {
				await manager.handleAction(third.id, 'develop');
				return commands.responses.length === 3;
			});
			after = await store.readAll();
			assert.strictEqual(after.tasks.find((task) => task.id === third.id)?.status, 'running');

			for (const pending of commands.responses.filter((response) => response.deferred !== firstResponse.deferred)) {
				await settle(pending);
			}
		});
	});

	test('identical task ids in different sets use independent reservations and chats', async () => {
		await withMaxParallelTasks(1, async () => {
			const firstStore = new TaskStore(vscode.Uri.joinPath(dir, 'first'), 'set-first');
			const secondStore = new TaskStore(vscode.Uri.joinPath(dir, 'second'), 'set-second');
			await firstStore.ensureDirectory();
			await secondStore.ensureDirectory();
			const first = await firstStore.create('First set task');
			const second = await secondStore.create('Second set task');
			await firstStore.patch(first.id, { state: 'refine', status: 'idle' });
			await secondStore.patch(second.id, { state: 'refine', status: 'idle' });
			const firstExecutor = new StubExecutor(() => 'hang');
			const secondExecutor = new StubExecutor(() => 'hang');
			const firstManager = new RunManager(firstStore, firstExecutor, folder);
			const secondManager = new RunManager(secondStore, secondExecutor, folder);

			await firstManager.handleAction(first.id, 'refine');
			await waitUntil(() => firstExecutor.calls.length === 1);
			await secondManager.handleAction(second.id, 'refine');
			await waitUntil(() => secondExecutor.calls.length === 1);

			const firstAfter = (await firstStore.readAll()).tasks[0];
			const secondAfter = (await secondStore.readAll()).tasks[0];
			assert.strictEqual(firstAfter.id, secondAfter.id);
			assert.strictEqual(firstAfter.status, 'running');
			assert.strictEqual(secondAfter.status, 'running');
			assert.strictEqual(secondAfter.chat, 'kanban-pilot-set-second-TASK-001');
			assert.notStrictEqual(firstAfter.chat, secondAfter.chat);
		});
	});

	test('capacity is shared across independently-created managers and mixed stages', async () => {
		await withMaxParallelTasks(2, async () => {
			const develop = await store.create('Develop one');
			const validate = await store.create('Validate one');
			const refine = await store.create('Refine one');
			await store.patch(develop.id, { state: 'approved', status: 'idle' });
			await store.patch(validate.id, { state: 'validation', status: 'idle' });
			await store.patch(refine.id, { state: 'refine', status: 'idle' });
			const developExecutor = new StubExecutor(() => 'hang');
			const validateExecutor = new StubExecutor(() => 'hang');
			const refineExecutor = new StubExecutor(() => 'hang');
			const developManager = new RunManager(store, developExecutor, folder);
			const validateManager = new RunManager(store, validateExecutor, folder);
			const refineManager = new RunManager(store, refineExecutor, folder);

			await Promise.all([
				developManager.handleAction(develop.id, 'develop'),
				validateManager.handleAction(validate.id, 'validate'),
			]);
			await waitUntil(() => developExecutor.calls.length === 1 && validateExecutor.calls.length === 1);
			await refineManager.handleAction(refine.id, 'refine');

			const after = await store.readAll();
			assert.strictEqual(after.tasks.filter((task) => task.status === 'running').length, 2);
			const waiting = after.tasks.find((task) => task.id === refine.id)!;
			assert.strictEqual(waiting.state, 'refine');
			assert.strictEqual(waiting.status, 'idle');
			assert.strictEqual(refineExecutor.calls.length, 0);
			assert.strictEqual(developExecutor.calls.length, 1);
			assert.strictEqual(validateExecutor.calls.length, 1);
		});
	});

	test('persisted running tasks consume capacity after a reload', async () => {
		await withMaxParallelTasks(2, async () => {
			const persisted = await store.create('Persisted run');
			const allowed = await store.create('Allowed run');
			const waiting = await store.create('Waiting run');
			await store.patch(persisted.id, { state: 'in-progress', status: 'running', run: 'r-persisted' });
			await store.patch(allowed.id, { state: 'approved', status: 'idle' });
			await store.patch(waiting.id, { state: 'approved', status: 'idle' });
			const allowedExecutor = new StubExecutor(() => 'hang');
			const waitingExecutor = new StubExecutor(() => 'hang');
			const reloadedManager = new RunManager(store, allowedExecutor, folder);
			const independentManager = new RunManager(store, waitingExecutor, folder);

			await reloadedManager.handleAction(allowed.id, 'develop');
			await independentManager.handleAction(waiting.id, 'develop');

			const after = await store.readAll();
			assert.strictEqual(after.tasks.find((task) => task.id === allowed.id)?.status, 'running');
			assert.strictEqual(after.tasks.find((task) => task.id === waiting.id)?.state, 'approved');
			assert.strictEqual(after.tasks.find((task) => task.id === waiting.id)?.status, 'idle');
			assert.strictEqual(waitingExecutor.calls.length, 0);
		});
	});

	test('increasing capacity admits a later run and decreasing it does not interrupt active runs', async () => {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		try {
			await cfg.update('run.maxParallelTasks', 1, vscode.ConfigurationTarget.Global);
			const first = await store.create('Existing run');
			const second = await store.create('Use increased capacity');
			const third = await store.create('Wait after decrease');
			await store.patch(first.id, { state: 'approved', status: 'idle' });
			await store.patch(second.id, { state: 'approved', status: 'idle' });
			await store.patch(third.id, { state: 'approved', status: 'idle' });
			const firstExecutor = new StubExecutor(() => 'hang');
			const secondExecutor = new StubExecutor(() => 'hang');
			const thirdExecutor = new StubExecutor(() => 'hang');
			const firstManager = new RunManager(store, firstExecutor, folder);
			const secondManager = new RunManager(store, secondExecutor, folder);
			const thirdManager = new RunManager(store, thirdExecutor, folder);

			await firstManager.handleAction(first.id, 'develop');
			await waitUntil(() => firstExecutor.calls.length === 1);
			await secondManager.handleAction(second.id, 'develop');
			assert.strictEqual((await store.readAll()).tasks.find((task) => task.id === second.id)?.state, 'approved');

			await cfg.update('run.maxParallelTasks', 2, vscode.ConfigurationTarget.Global);
			await secondManager.handleAction(second.id, 'develop');
			await waitUntil(() => secondExecutor.calls.length === 1);

			await cfg.update('run.maxParallelTasks', 1, vscode.ConfigurationTarget.Global);
			await thirdManager.handleAction(third.id, 'develop');
			const after = await store.readAll();
			assert.strictEqual(after.tasks.find((task) => task.id === first.id)?.status, 'running');
			assert.strictEqual(after.tasks.find((task) => task.id === second.id)?.status, 'running');
			assert.strictEqual(after.tasks.find((task) => task.id === third.id)?.state, 'approved');
			assert.strictEqual(thirdExecutor.calls.length, 0);
		} finally {
			await cfg.update('run.maxParallelTasks', undefined, vscode.ConfigurationTarget.Global);
		}
	});

	test('stopping a run releases capacity for the next task', async () => {
		await withMaxParallelTasks(1, async () => {
			const first = await store.create('Stop this run');
			const second = await store.create('Run after stop');
			await store.patch(first.id, { state: 'approved', status: 'idle' });
			await store.patch(second.id, { state: 'approved', status: 'idle' });
			const firstExecutor = new StubExecutor(() => 'hang');
			const secondExecutor = new StubExecutor(() => 'hang');
			const firstManager = new RunManager(store, firstExecutor, folder);
			const secondManager = new RunManager(store, secondExecutor, folder);

			await firstManager.handleAction(first.id, 'develop');
			await waitUntil(() => firstExecutor.calls.length === 1);
			await secondManager.handleAction(second.id, 'develop');
			assert.strictEqual((await store.readAll()).tasks.find((task) => task.id === second.id)?.state, 'approved');

			await firstManager.handleAction(first.id, 'stop');
			await secondManager.handleAction(second.id, 'develop');
			await waitUntil(() => secondExecutor.calls.length === 1);
			assert.strictEqual((await store.readAll()).tasks.find((task) => task.id === second.id)?.status, 'running');
		});
	});

	test('automatic backlog gating leaves a task untouched when capacity is full', async () => {
		await withMaxParallelTasks(1, async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('gates.backlogToRefine', 'auto', vscode.ConfigurationTarget.Global);
			try {
				const running = await store.create('Already running');
				const backlog = await store.create('Wait for capacity');
				await store.patch(running.id, { state: 'refine', status: 'running', run: 'r-existing' });
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.applyGatePolicies();

				const after = (await store.readAll()).tasks.find((task) => task.id === backlog.id)!;
				assert.strictEqual(after.state, 'backlog');
				assert.strictEqual(after.status, 'idle');
				assert.strictEqual(after.run, undefined);
				assert.strictEqual(executor.calls.length, 0);
			} finally {
				await cfg.update('gates.backlogToRefine', undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});

	test('automatic gates fill the configured capacity and leave excess Approved work queued', async () => {
		await withMaxParallelTasks(2, async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('gates.approvedToInProgress', 'auto', vscode.ConfigurationTarget.Global);
			try {
				const first = await store.create('Automatic run one');
				const second = await store.create('Automatic run two');
				const third = await store.create('Automatic run three');
				for (const task of [first, second, third]) {
					await store.patch(task.id, { state: 'approved', status: 'idle' });
				}
				const executor = new StubExecutor(() => 'hang');
				const runManager = new RunManager(store, executor, folder);

				await runManager.applyGatePolicies();
				await waitUntil(() => executor.calls.length === 2);

				const after = await store.readAll();
				assert.strictEqual(after.tasks.filter((task) => task.status === 'running').length, 2);
				assert.strictEqual(after.tasks.find((task) => task.id === third.id)?.state, 'approved');
				assert.strictEqual(after.tasks.find((task) => task.id === third.id)?.status, 'idle');
			} finally {
				await cfg.update('gates.approvedToInProgress', undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});

	test('the Approved auto gate uses a remaining capacity slot while another Develop run is active', async () => {
		await withMaxParallelTasks(2, async () => {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			await cfg.update('gates.approvedToInProgress', 'auto', vscode.ConfigurationTarget.Global);
			try {
				const running = await store.create('Already running Develop');
				const queued = await store.create('Automatically start Develop');
				await store.patch(running.id, { state: 'approved', status: 'idle' });
				await store.patch(queued.id, { state: 'approved', status: 'idle' });
				const runningExecutor = new StubExecutor(() => 'hang');
				const queuedExecutor = new StubExecutor(() => 'hang');
				const runningManager = new RunManager(store, runningExecutor, folder);
				const queuedManager = new RunManager(store, queuedExecutor, folder);

				await runningManager.handleAction(running.id, 'develop');
				await waitUntil(() => runningExecutor.calls.length === 1);
				await queuedManager.applyGatePolicies();
				await waitUntil(() => queuedExecutor.calls.length === 1);

				const after = await store.readAll();
				assert.strictEqual(after.tasks.find((task) => task.id === queued.id)?.status, 'running');
			} finally {
				await cfg.update('gates.approvedToInProgress', undefined, vscode.ConfigurationTarget.Global);
			}
		});
	});

	test('a terminal receipt releases capacity for a later run', async () => {
		await withMaxParallelTasks(1, async () => {
			const first = await store.create('Finish this run');
			const second = await store.create('Run next');
			await store.patch(first.id, { state: 'refine', status: 'idle' });
			await store.patch(second.id, { state: 'refine', status: 'idle' });
			const firstManager = new RunManager(store, new StubExecutor(okReceipt(store, 'refine')), folder);
			const secondExecutor = new StubExecutor(() => 'hang');
			const secondManager = new RunManager(store, secondExecutor, folder);

			await firstManager.handleAction(first.id, 'refine');
			await waitUntilSettled(store, first.id);
			await secondManager.handleAction(second.id, 'refine');
			await waitUntil(() => secondExecutor.calls.length === 1);
			assert.strictEqual((await store.readAll()).tasks.find((task) => task.id === second.id)?.status, 'running');
		});
	});

	});

	suite('reconcileOnActivation', () => {
		test('advances a task whose receipt landed before a reload', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'running', run: 'r-lost' });
			await store.appendLog(task.id, formatReceipt({ runId: 'r-lost', taskId: task.id, stage: 'refine', result: 'ok', note: 'done before reload' }));

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
		});

		test('blocks a running task with no receipt, rather than leaving it stuck', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'running', run: 'r-lost' });

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'blocked');
			assert.ok(after.sections['Log'].includes('interrupted by window reload'));
		});

		test('correctly infers stage from column when reconciling a lost In Progress run', async () => {
			const task = await store.create('Set up billing webhook');
			await store.edit(task.id, {
				title: task.title,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: 'completion-evidence: task-only',
			});
			await store.patch(task.id, { state: 'in-progress', status: 'running', run: 'r-lost' });
			await store.appendLog(task.id, formatReceipt({ runId: 'r-lost', taskId: task.id, stage: 'develop', result: 'ok', note: 'done before reload' }));

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'validation');
		});

		test('uses the persisted activity stage when reconciling a lost split run', async () => {
			const task = await store.create('Recover split after reload');
			await store.auditedPatch(
				task.id,
				{ state: 'refine', status: 'running', run: 'r-split' },
				{
					action: 'split',
					runId: 'r-split',
					events: [{ kind: 'activity-start', stage: 'split', action: 'split', runId: 'r-split' }],
				},
			);

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'blocked');
			assert.ok(parseReceipts(after.sections['Log']).some((receipt) => receipt.stage === 'split'));
			assert.ok(parseAuditEvents(after.sections['Log']).some((event) => event.kind === 'activity-finish' && event.stage === 'split'));
		});

		test('reconciles a late receipt after a fallback when the extension activates', async () => {
			const task = await store.create('Set up billing webhook');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			let runId = '';
			const firstManager = new RunManager(
				store,
				new StubExecutor(async (_t, prompt) => {
					runId = runIdFromPrompt(prompt);
					return { ok: true };
				}),
				folder,
			);

			await firstManager.handleAction(task.id, 'refine');
			const blocked = await waitUntilSettled(store, task.id);
			assert.strictEqual(blocked.status, 'blocked');

			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'refine', result: 'ok', note: 'written before activation' }),
			);
			const activatedManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await activatedManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'scoped');
			assert.strictEqual(after.status, 'idle');
		});

		test('reconciles a late timeout receipt when the extension activates', async () => {
			const task = await store.create('Recover timeout after reload');
			const runId = 'r-timeout-reload';
			await store.edit(task.id, {
				title: task.title,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: 'completion-evidence: task-only',
			});
			await store.auditedPatch(
				task.id,
				{ state: 'in-progress', status: 'running', run: runId },
				{
					action: 'develop',
					runId,
					events: [{ kind: 'activity-start', stage: 'develop', action: 'develop', runId }],
				},
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'failed', note: 'timed out; awaiting late receipt' }),
			);
			await store.auditedPatch(
				task.id,
				{ status: 'failed', run: undefined },
				{
					action: 'timeout',
					runId,
					outcome: 'timeout',
					events: [{ kind: 'activity-finish', stage: 'develop', runId, outcome: 'timeout', provisional: true }],
				},
			);
			await store.appendLog(
				task.id,
				formatReceipt({ runId, taskId: task.id, stage: 'develop', result: 'ok', note: 'written before activation' }),
			);

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
		});
	});

	suite('gate policies (§6.15)', () => {
		type GateSettingKey =
			'gates.backlogToRefine' | 'gates.refineToScoped' | 'gates.scopedToApproved' |
			'gates.approvedToInProgress' | 'gates.developToValidation' | 'gates.validationAutoStart' |
			'gates.validateToDone' | 'gates.validateFailedToInProgress' | 'gates.splitToDone';

		async function withGates(gates: Partial<Record<GateSettingKey, 'manual' | 'auto'>>, fn: () => Promise<void>): Promise<void> {
			const cfg = vscode.workspace.getConfiguration('kanbanPilot');
			const keys = Object.keys(gates) as (keyof typeof gates)[];
			try {
				for (const key of keys) {
					await cfg.update(key, gates[key], vscode.ConfigurationTarget.Global);
				}
				await fn();
			} finally {
				for (const key of keys) {
					await cfg.update(key, undefined, vscode.ConfigurationTarget.Global);
				}
			}
		}

		const receiptCompletionCases = [
			{
				gate: 'refineToScoped',
				startState: 'refine',
				pendingState: 'refine',
				action: 'refine',
				stage: 'refine',
				result: 'ok',
				target: 'scoped',
			},
			{
				gate: 'developToValidation',
				startState: 'approved',
				pendingState: 'in-progress',
				action: 'develop',
				stage: 'develop',
				result: 'ok',
				target: 'validation',
			},
			{
				gate: 'validateToDone',
				startState: 'validation',
				pendingState: 'validation',
				action: 'validate',
				stage: 'validate',
				result: 'ok',
				target: 'done',
			},
			{
				gate: 'validateFailedToInProgress',
				startState: 'validation',
				pendingState: 'validation',
				action: 'validate',
				stage: 'validate',
				result: 'failed',
				target: 'in-progress',
			},
			{
				gate: 'splitToDone',
				startState: 'refine',
				pendingState: 'refine',
				action: 'split',
				stage: 'split',
				result: 'ok',
				target: 'done',
			},
		] as const;

		test('defaults are all manual — a sweep over eligible tasks does nothing', async () => {
			const task = await store.create('Set up billing webhook');
			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

			await runManager.applyGatePolicies();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'backlog', 'G3: gated by default means nothing moves unasked');
			assert.strictEqual(task.id, after.id);
		});

		test('backlogToRefine: auto accepts and launches refine in one sweep', async () => {
			await withGates({ 'gates.backlogToRefine': 'auto' }, async () => {
				const task = await store.create('Set up billing webhook');
				const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'refine')), folder);

				await runManager.applyGatePolicies();
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'scoped', 'accept then refine must both have fired');
			});
		});

		test('scopedToApproved: auto approves but does not also auto-develop in the same sweep', async () => {
			await withGates({ 'gates.scopedToApproved': 'auto', 'gates.approvedToInProgress': 'auto' }, async () => {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'scoped', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

				await runManager.applyGatePolicies();

				const after = (await store.readAll()).tasks[0];
				assert.strictEqual(after.state, 'approved', 'one gate fires per task per sweep — cascading needs a second sweep');
				assert.strictEqual(after.status, 'idle', 'develop must not also have launched in the same pass');
			});
		});

		test('a second sweep picks up where the first left off — cascading resolves over successive sweeps', async () => {
			await withGates({ 'gates.scopedToApproved': 'auto', 'gates.approvedToInProgress': 'auto' }, async () => {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'scoped', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'develop')), folder);

				await runManager.applyGatePolicies(); // scoped -> approved
				await runManager.applyGatePolicies(); // approved -> in-progress (launches)
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'validation');
			});
		});

		test('approvedToInProgress: auto starts the next Approved task once the slot is free', async () => {
			await withGates({ 'gates.approvedToInProgress': 'auto' }, async () => {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'approved', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'develop')), folder);

				await runManager.applyGatePolicies();
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'validation');
			});
		});

		test('approvedToInProgress respects the single develop slot within one sweep — only one of two starts', async () => {
			await withGates({ 'gates.approvedToInProgress': 'auto' }, async () => {
				const a = await store.create('Task A');
				const b = await store.create('Task B');
				await store.patch(a.id, { state: 'approved', status: 'idle' });
				await store.patch(b.id, { state: 'approved', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

				await runManager.applyGatePolicies();

				const after = (await store.readAll()).tasks;
				const running = after.filter((t) => t.status === 'running');
				const stillApproved = after.filter((t) => t.state === 'approved' && t.status === 'idle');
				assert.strictEqual(running.length, 1, 'only one develop run may be in flight at a time');
				assert.strictEqual(stillApproved.length, 1, 'the other stays queued, untouched, for the next sweep');
			});
		});

		test('approvedToInProgress does not start a second run when one is already in flight', async () => {
			await withGates({ 'gates.approvedToInProgress': 'auto' }, async () => {
				const running = await store.create('Already running');
				await store.patch(running.id, { state: 'in-progress', status: 'running', run: 'r1' });
				const approved = await store.create('Waiting its turn');
				await store.patch(approved.id, { state: 'approved', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

				await runManager.applyGatePolicies();

				const after = (await store.readAll()).tasks.find((t) => t.id === approved.id);
				assert.strictEqual(after?.state, 'approved', 'the existing running task holds the only slot');
				assert.strictEqual(after?.status, 'idle');
			});
		});

		test('validationAutoStart: auto launches Validate the moment a task is sitting in Validation', async () => {
			await withGates({ 'gates.validationAutoStart': 'auto' }, async () => {
				const task = await store.create('Set up billing webhook');
				await store.patch(task.id, { state: 'validation', status: 'idle' });
				const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'validate')), folder);

				await runManager.applyGatePolicies();
				const after = await waitUntilSettled(store, task.id);

				assert.strictEqual(after.state, 'done');
			});
		});

		test('a blocked/failed task is never auto-retried, regardless of policy', async () => {
			await withGates(
				{
					'gates.backlogToRefine': 'auto',
					'gates.scopedToApproved': 'auto',
					'gates.approvedToInProgress': 'auto',
					'gates.validationAutoStart': 'auto',
				},
				async () => {
					const task = await store.create('Set up billing webhook');
					await store.patch(task.id, { state: 'validation', status: 'blocked' });
					const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);

					await runManager.applyGatePolicies();

					const after = (await store.readAll()).tasks[0];
					assert.strictEqual(after.state, 'validation');
					assert.strictEqual(after.status, 'blocked', 'a retry state must wait for a human, auto or not');
				},
			);
		});

		test('receipt completion gates default to pending and auto policies promote them', async () => {
			const task = await store.create('Pending completion');
			await store.patch(task.id, { state: 'refine', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'refine')), folder);
			let pending!: Task;
			await withGates({ 'gates.refineToScoped': 'manual' }, async () => {
				await runManager.handleAction(task.id, 'refine');
				await waitUntil(async () => {
					const current = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
					if (!current) {
						return false;
					}
					pending = current;
					return current.status === 'idle' && !!current.pendingOutcome;
				});
			});
			assert.strictEqual(pending.state, 'refine');
			assert.strictEqual(pending.pendingOutcome?.gate, 'refineToScoped');

			await withGates({ 'gates.refineToScoped': 'auto' }, async () => {
				await runManager.applyGatePolicies();
			});
			const promoted = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
			assert.strictEqual(promoted.state, 'scoped');
			assert.strictEqual(promoted.pendingOutcome, undefined);
		});

		for (const scenario of receiptCompletionCases) {
			test(`${scenario.gate}: manual promotion applies the durable pending outcome`, async () => {
				const setting = `gates.${scenario.gate}` as GateSettingKey;
				await withGates({ [setting]: 'manual' }, async () => {
					const task = await store.create(`Manual ${scenario.gate}`);
					await store.patch(task.id, { state: scenario.startState, status: 'idle' });
					const executor = scenario.gate === 'splitToDone'
						? new StubExecutor(okReceiptWithProposals(store, 'split', ['Split child']))
						: new StubExecutor(receiptWithResult(store, scenario.stage, scenario.result));
					const runManager = new RunManager(store, executor, folder);

					await runManager.handleAction(task.id, scenario.action);
					let pending!: Task;
					await waitUntil(async () => {
						const current = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
						if (!current) {
							return false;
						}
						pending = current;
						return current.status === 'idle' && current.pendingOutcome?.gate === scenario.gate;
					});

					assert.strictEqual(pending.state, scenario.pendingState);
					assert.strictEqual(pending.pendingOutcome?.stage, scenario.stage);
					assert.strictEqual(pending.pendingOutcome?.result, scenario.result);
					const reloadedManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
					await reloadedManager.reconcileOnActivation();
					const afterReload = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
					assert.strictEqual(afterReload.state, scenario.pendingState);
					assert.strictEqual(afterReload.pendingOutcome?.gate, scenario.gate);
					assert.strictEqual((await reloadedManager.applyPendingOutcome(task.id)).kind, 'applied');

					const after = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id)!;
					assert.strictEqual(after.state, scenario.target);
					assert.strictEqual(after.status, 'idle');
					assert.strictEqual(after.pendingOutcome, undefined);
					if (scenario.gate === 'splitToDone') {
						assert.strictEqual((await store.readAll()).tasks.filter((candidate) => candidate.originTask === task.id).length, 1);
					}
				});
			});
		}

		test('every receipt-completion gate auto-promotes through the same path', async () => {
			for (const scenario of receiptCompletionCases) {
				const setting = `gates.${scenario.gate}` as GateSettingKey;
				await withGates({ [setting]: 'auto' }, async () => {
					const task = await store.create(`Automatic ${scenario.gate}`);
					await store.patch(task.id, { state: scenario.startState, status: 'idle' });
					const executor = scenario.gate === 'splitToDone'
						? new StubExecutor(okReceiptWithProposals(store, 'split', ['Automatic split child']))
						: new StubExecutor(receiptWithResult(store, scenario.stage, scenario.result));
					const runManager = new RunManager(store, executor, folder);

					await runManager.handleAction(task.id, scenario.action);
					const after = await waitUntilSettled(store, task.id);
					assert.strictEqual(after.state, scenario.target, scenario.gate);
					assert.strictEqual(after.status, 'idle');
					assert.strictEqual(after.pendingOutcome, undefined);
				});
			}
		});
	});
});
