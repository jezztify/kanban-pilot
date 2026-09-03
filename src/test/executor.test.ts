import * as assert from 'assert';
import * as vscode from 'vscode';

import { Task } from '../model/task';
import {
	ChatCommandApi,
	ChatSessionExecutor,
	CHAT_CANCEL_COMMAND,
	CHAT_COMPACT_COMMAND,
	CHAT_NEW_COMMAND,
	capabilityDiagnostic,
	orderedTaskChatAttachments,
	resolveToolsInclude,
	taskChatOpenOptions,
} from '../chat/executor';
import { RunOptions } from '../chat/executor';
import type { OutboundMetadata, OutboundPayload } from '../chat/executor';
import { sessionUriForId, sessionUriForTaskBinding } from '../chat/sessionUri';

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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error('waitUntil timed out');
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function executorTask(id: string): Task {
	return {
		setId: 'test',
		id,
		title: id,
		type: 'feature',
		state: 'in-progress',
		status: 'running',
		chatResetRequired: false,
		sections: {},
		body: '',
	};
}

const executorRunOptions: RunOptions = {
	mode: 'agent',
	sessionPrefix: 'kanban-pilot-',
	toolsIncludeForRefine: [],
	toolsExclude: [],
};

class ControlledChatCommands implements ChatCommandApi {
	readonly calls: { command: string; args: readonly unknown[] }[] = [];
	readonly responses: Deferred<unknown>[] = [];
	availableCommands = ['vscode.open', CHAT_NEW_COMMAND, 'workbench.action.chat.openagent'];
	rejectAgentCommand = false;
	rejectNewChatCommand = false;
	rejectOpenCommand = false;
	rejectCancelCommand = false;
	openResponse?: Deferred<unknown>;

	getCommands(): Thenable<string[]> {
		return Promise.resolve(this.availableCommands);
	}

	executeCommand<T>(command: string, ...args: unknown[]): Thenable<T> {
		this.calls.push({ command, args });
		if (command === 'vscode.open') {
			if (this.rejectOpenCommand) {
				return Promise.reject(new Error('vscode.open unavailable'));
			}
			return (this.openResponse?.promise ?? Promise.resolve(undefined)) as Promise<T>;
		}
		if (command === CHAT_NEW_COMMAND) {
			return this.rejectNewChatCommand
				? Promise.reject(new Error('new chat command failed'))
				: Promise.resolve(undefined as T);
		}
		if (command === CHAT_CANCEL_COMMAND) {
			return this.rejectCancelCommand
				? Promise.reject(new Error('chat cancellation failed'))
				: Promise.resolve(undefined as T);
		}
		if (this.rejectAgentCommand) {
			return Promise.reject(new Error('chat command failed'));
		}
		const response = deferred<unknown>();
		this.responses.push(response);
		return response.promise as unknown as Thenable<T>;
	}
}

/** M3 — refine's tools allowlist is opt-in, not on by default (PRD §6.6, §6.8). */

suite('resolveToolsInclude', () => {
	test('an empty allowlist means no restriction, even for refine', () => {
		assert.strictEqual(resolveToolsInclude('refine', []), undefined);
	});

	test('a non-empty allowlist is passed through as-is for refine', () => {
		assert.deepStrictEqual(resolveToolsInclude('refine', ['codebase']), ['codebase']);
	});

	test('develop, validate, and split are never restricted, regardless of the refine allowlist', () => {
		assert.strictEqual(resolveToolsInclude('develop', ['codebase']), undefined);
		assert.strictEqual(resolveToolsInclude('validate', ['codebase']), undefined);
		assert.strictEqual(resolveToolsInclude('split', ['codebase']), undefined);
	});
});

suite('Chat capability diagnostics', () => {
	const complete = {
		mode: 'agent',
		remoteName: 'ssh-remote',
		hasVscodeOpen: true,
		chatCommand: 'workbench.action.chat.openagent',
		newChatCommand: CHAT_NEW_COMMAND,
		supportsChatSessionUri: true,
	};

	test('reports the missing capability with remote context', () => {
		assert.strictEqual(
			capabilityDiagnostic({ ...complete, hasVscodeOpen: false })?.code,
			'missing-vscode-open',
		);
		assert.strictEqual(
			capabilityDiagnostic({ ...complete, chatCommand: undefined })?.code,
			'missing-chat-command',
		);
		assert.strictEqual(
			capabilityDiagnostic({ ...complete, supportsChatSessionUri: false })?.code,
			'unsupported-chat-session-uri',
		);
		assert.strictEqual(
			capabilityDiagnostic({ ...complete, newChatCommand: undefined }, false, true)?.code,
			'missing-new-chat-command',
		);
		const diagnostic = capabilityDiagnostic({ ...complete, chatCommand: undefined });
		assert.strictEqual(diagnostic?.remoteName, 'ssh-remote');
		assert.match(diagnostic?.message ?? '', /ssh-remote/);
		assert.match(diagnostic?.remediation ?? '', /Copilot Chat/);
	});

	test('treats an omitted vscode.open inventory entry as advisory', () => {
		assert.strictEqual(
			capabilityDiagnostic({ ...complete, hasVscodeOpen: false }, false),
			undefined,
		);
		assert.strictEqual(capabilityDiagnostic(complete), undefined);
	});

	test('returns the missing-open diagnostic when the actual open command fails', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands = ['workbench.action.chat.openagent'];
		commands.rejectOpenCommand = true;
		const result = await new ChatSessionExecutor(commands).run(
			executorTask('TASK-005'),
			vscode.Uri.file('C:/tasks/TASK-005.md'),
			'prompt',
			'develop',
			executorRunOptions,
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.diagnostic?.code, 'missing-vscode-open');
	});

	test('returns the unsupported-session diagnostic through clipboard fallback', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands, { supportsChatSessionUri: () => false });
		const result = await executor.run(
			executorTask('TASK-006'),
			vscode.Uri.file('C:/tasks/TASK-006.md'),
			'prompt',
			'develop',
			executorRunOptions,
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.diagnostic?.code, 'unsupported-chat-session-uri');
		assert.strictEqual(commands.calls[0]?.command, 'vscode.open');
	});
});

suite('first-use task chat', () => {
	test('opens the task session, creates New Chat, then injects the prompt', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-007'),
			vscode.Uri.file('C:/tasks/TASK-007.md'),
			'first-use prompt',
			'develop',
			{ ...executorRunOptions, newChatBefore: true },
		);

		await waitUntil(() => commands.responses.length === 1);
		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			CHAT_NEW_COMMAND,
			'workbench.action.chat.openagent',
		]);
		const payload = commands.calls[2].args[0] as OutboundPayload;
		assert.strictEqual(payload.query, 'first-use prompt');
		assert.ok(!('modelSelector' in payload), 'an omitted selector must inherit the New Chat model');

		commands.responses[0].resolve({ metadata: { sessionId: 'session-7' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-7' });
	});

	test('preserves an explicit model selector after New Chat', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-008'),
			vscode.Uri.file('C:/tasks/TASK-008.md'),
			'override prompt',
			'develop',
			{
				...executorRunOptions,
				newChatBefore: true,
				modelSelector: { id: 'gpt-5.6-luna', vendor: 'copilot' },
			},
		);

		await waitUntil(() => commands.responses.length === 1);
		assert.deepStrictEqual((commands.calls[2].args[0] as OutboundPayload).modelSelector, {
			id: 'gpt-5.6-luna',
			vendor: 'copilot',
		});
		commands.responses[0].resolve({ metadata: { sessionId: 'session-8' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-8' });
	});

	test('uses the clipboard fallback with an explicit diagnostic when New Chat is unavailable', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands = ['vscode.open', 'workbench.action.chat.openagent'];
		const executor = new ChatSessionExecutor(commands);

		const result = await executor.run(
			executorTask('TASK-009'),
			vscode.Uri.file('C:/tasks/TASK-009.md'),
			'fallback prompt',
			'develop',
			{ ...executorRunOptions, newChatBefore: true },
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.diagnostic?.code, 'missing-new-chat-command');
		assert.ok(!commands.calls.some(({ command }) => command === 'workbench.action.chat.openagent'));
		assert.ok(!commands.calls.some(({ command }) => command === CHAT_NEW_COMMAND));
	});

	test('does not inject when New Chat fails and reports an actionable diagnostic', async () => {
		const commands = new ControlledChatCommands();
		commands.rejectNewChatCommand = true;
		const executor = new ChatSessionExecutor(commands);

		const result = await executor.run(
			executorTask('TASK-010'),
			vscode.Uri.file('C:/tasks/TASK-010.md'),
			'failed new-chat prompt',
			'develop',
			{ ...executorRunOptions, newChatBefore: true },
		);

		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.diagnostic?.code, 'new-chat-command-failed');
		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			CHAT_NEW_COMMAND,
		]);
		assert.match(result.diagnostic?.remediation ?? '', /retry/i);
		assert.ok(!commands.calls.some(({ command }) => command === 'workbench.action.chat.openagent'));
	});
});

suite('task chat open options', () => {
	test('docking opens the task session beside the board as a preview', () => {
		assert.deepStrictEqual(taskChatOpenOptions(true), {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: false,
			preview: true,
		});
	});

	test('disabling docking preserves the existing focused-session open behavior', () => {
		assert.deepStrictEqual(taskChatOpenOptions(false), { preserveFocus: false });
	});

	test('injection reuses a persisted chat binding after the session prefix changes', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-001');
		task.chat = 'persisted-chat-session';
		const options = { ...executorRunOptions, sessionPrefix: 'new-prefix-' };

		const run = executor.run(task, vscode.Uri.file('C:/tasks/TASK-001.md'), 'prompt', 'develop', options);
		await waitUntil(() => commands.responses.length === 1);

		assert.strictEqual(
			(commands.calls[0].args[0] as vscode.Uri).toString(),
			sessionUriForTaskBinding(task, options.sessionPrefix, task.setId).toString(),
		);

		commands.responses[0].resolve({ metadata: { sessionId: 'session-1' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-1' });
	});

	test('injection reopens the derived local binding, not Copilot’s conversation UUID', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-001');
		task.chat = 'legacy-derived-binding';
		task.copilotSessionId = 'copilot-conversation-id';

		const run = executor.run(task, vscode.Uri.file('C:/tasks/TASK-001.md'), 'prompt', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);

		// M0 finding 9: copilot_session_id is Copilot's own conversation UUID, not
		// a vscode-chat-session://local id. Opening a URI built from it spawns a
		// new empty chat — the reopen must stay on the derived local binding.
		assert.strictEqual(
			(commands.calls[0].args[0] as vscode.Uri).toString(),
			sessionUriForId('legacy-derived-binding').toString(),
		);
		assert.notStrictEqual(
			(commands.calls[0].args[0] as vscode.Uri).toString(),
			sessionUriForId('copilot-conversation-id').toString(),
		);

		commands.responses[0].resolve({ metadata: { sessionId: 'copilot-conversation-id' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'copilot-conversation-id' });
	});

	test('clipboard fallback opens the persisted chat binding before copying the prompt', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands = [];
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-002');
		task.chat = 'persisted-fallback-session';

		const result = await executor.run(task, vscode.Uri.file('C:/tasks/TASK-002.md'), 'fallback prompt', 'develop', {
			...executorRunOptions,
			sessionPrefix: 'changed-prefix-',
		});

		assert.strictEqual(result.ok, false);
		assert.strictEqual(commands.calls[0].command, 'vscode.open');
		assert.strictEqual(
			(commands.calls[0].args[0] as vscode.Uri).toString(),
			sessionUriForTaskBinding(task, 'changed-prefix-', task.setId).toString(),
		);
	});

	test('first-use bindings remain isolated between named task sets', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const first = executorTask('TASK-001');
		const second = { ...executorTask('TASK-001'), setId: 'set-two' };

		const firstRun = executor.run(first, vscode.Uri.file('C:/tasks/TASK-001.md'), 'first', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);
		const firstUri = (commands.calls[0].args[0] as vscode.Uri).toString();
		commands.responses[0].resolve({ metadata: { sessionId: 'session-1' } });
		await firstRun;

		const secondRun = executor.run(second, vscode.Uri.file('C:/tasks/TASK-001.md'), 'second', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 2);
		const secondUri = (commands.calls[2].args[0] as vscode.Uri).toString();
		commands.responses[1].resolve({ metadata: { sessionId: 'session-2' } });
		await secondRun;

		assert.notStrictEqual(firstUri, secondUri);
		assert.strictEqual(firstUri, sessionUriForTaskBinding(first, executorRunOptions.sessionPrefix, first.setId).toString());
		assert.strictEqual(secondUri, sessionUriForTaskBinding(second, executorRunOptions.sessionPrefix, second.setId).toString());
	});
});

suite('task chat cancellation', () => {
	test('suppresses injection when Stop arrives while the task session is opening', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_CANCEL_COMMAND);
		commands.openResponse = deferred<unknown>();
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-019');
		const run = executor.run(task, vscode.Uri.file('C:/tasks/TASK-019.md'), 'prompt', 'develop', executorRunOptions);
		await waitUntil(() => commands.calls.some((call) => call.command === 'vscode.open'));

		assert.deepStrictEqual(await executor.cancel(task, executorRunOptions), { kind: 'cancelled' });
		commands.openResponse.resolve(undefined);
		const result = await run;

		assert.strictEqual(result.ok, false);
		assert.match(result.error ?? '', /cancelled before injection/);
		assert.strictEqual(commands.responses.length, 0, 'the Copilot prompt command must not be invoked');
	});

	test('opens the active task session and invokes the Chat Stop command in order', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_CANCEL_COMMAND);
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-020');
		const run = executor.run(task, vscode.Uri.file('C:/tasks/TASK-020.md'), 'prompt', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);

		assert.deepStrictEqual(await executor.cancel(task, executorRunOptions), { kind: 'cancelled' });
		assert.strictEqual(commands.calls.at(-2)?.command, 'vscode.open');
		assert.strictEqual(
			(commands.calls.at(-2)?.args[0] as vscode.Uri).toString(),
			sessionUriForTaskBinding(task, executorRunOptions.sessionPrefix, task.setId).toString(),
		);
		assert.strictEqual(commands.calls.at(-1)?.command, CHAT_CANCEL_COMMAND);

		commands.responses[0].resolve(undefined);
		await run;
	});

	test('does not target another task and is idempotent when no turn is active', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_CANCEL_COMMAND);
		const executor = new ChatSessionExecutor(commands);
		const active = executorTask('TASK-021');
		const other = executorTask('TASK-022');
		const run = executor.run(active, vscode.Uri.file('C:/tasks/TASK-021.md'), 'prompt', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);
		const callsBefore = commands.calls.length;

		assert.deepStrictEqual(await executor.cancel(other, executorRunOptions), { kind: 'no-active-turn' });
		assert.strictEqual(commands.calls.length, callsBefore);

		commands.responses[0].resolve(undefined);
		await run;
		assert.deepStrictEqual(await executor.cancel(active, executorRunOptions), { kind: 'no-active-turn' });
	});

	test('reports missing and failing cancellation commands without claiming success', async () => {
		for (const failure of ['missing', 'reject'] as const) {
			const commands = new ControlledChatCommands();
			if (failure === 'reject') {
				commands.availableCommands.push(CHAT_CANCEL_COMMAND);
				commands.rejectCancelCommand = true;
			}
			const executor = new ChatSessionExecutor(commands);
			const task = executorTask(`TASK-${failure}`);
			const run = executor.run(task, vscode.Uri.file(`C:/tasks/TASK-${failure}.md`), 'prompt', 'develop', executorRunOptions);
			await waitUntil(() => commands.responses.length === 1);

			const result = await executor.cancel(task, executorRunOptions);
			assert.strictEqual(result.kind, 'failed');
			assert.match(result.kind === 'failed' ? result.error : '', failure === 'missing' ? /unavailable/ : /failed/);

			commands.responses[0].resolve(undefined);
			await run;
		}
	});
});

suite('task chat compaction', () => {
	test('reports an unavailable native compact command without opening a session', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands = ['vscode.open', 'workbench.action.chat.openagent'];
		const executor = new ChatSessionExecutor(commands);

		const result = await executor.compact(executorTask('TASK-040'), executorRunOptions);

		assert.deepStrictEqual(result.kind, 'unsupported');
		assert.strictEqual(result.kind === 'unsupported' ? result.diagnostic.code : '', 'missing-compact-command');
		assert.deepStrictEqual(commands.calls, []);
	});

	test('does not invoke a focus-only compact command without a supported task-session target', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_COMPACT_COMMAND);
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-041');
		task.chat = 'stable-task-chat';
		task.copilotSessionId = 'copilot-uuid-must-not-be-used';

		const result = await executor.compact(task, executorRunOptions);

		assert.strictEqual(result.kind, 'unsupported');
		assert.strictEqual(result.kind === 'unsupported' ? result.diagnostic.code : '', 'unsupported-compact-session-target');
		assert.deepStrictEqual(commands.calls, []);
		assert.ok(!commands.calls.some(({ command }) => command === CHAT_NEW_COMMAND));
	});

	test('uses a proven task-session target and never falls back to focused commands or New Chat', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_COMPACT_COMMAND);
		const targetUris: string[] = [];
		const executor = new ChatSessionExecutor(commands, {}, {}, {
			compact: async (uri) => {
				targetUris.push(uri.toString());
			},
		});
		const task = executorTask('TASK-042');
		task.chat = 'stable-task-chat';

		const result = await executor.compact(task, executorRunOptions);

		assert.deepStrictEqual(result, { kind: 'success', targeting: 'session' });
		assert.deepStrictEqual(targetUris, [sessionUriForId('stable-task-chat').toString()]);
		assert.deepStrictEqual(commands.calls, []);
		assert.ok(!commands.calls.some(({ command }) => command === CHAT_NEW_COMMAND));
	});

	test('reports a proven task-session compaction failure without falling back to New Chat', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_COMPACT_COMMAND);
		const executor = new ChatSessionExecutor(commands, {}, {}, {
			compact: async () => {
				throw new Error('verified target compaction failed');
			},
		});

		const result = await executor.compact(executorTask('TASK-043'), executorRunOptions);

		assert.strictEqual(result.kind, 'failed');
		assert.match(result.kind === 'failed' ? result.error : '', /verified target compaction failed/);
		assert.strictEqual(result.kind === 'failed' ? result.diagnostic?.code : '', 'compact-command-failed');
		assert.deepStrictEqual(commands.calls, []);
		assert.ok(!commands.calls.some(({ command }) => command === CHAT_NEW_COMMAND));
	});

	test('serializes concurrent proven task-session compactions through the injection mutex', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands.push(CHAT_COMPACT_COMMAND);
		const gate = deferred<void>();
		const targetUris: string[] = [];
		const executor = new ChatSessionExecutor(commands, {}, {}, {
			compact: async (uri) => {
				targetUris.push(uri.toString());
				await gate.promise;
			},
		});

		const first = executor.compact(executorTask('TASK-044'), executorRunOptions);
		await waitUntil(() => targetUris.length === 1);
		const second = executor.compact(executorTask('TASK-045'), executorRunOptions);
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.strictEqual(targetUris.length, 1);
		gate.resolve();

		assert.deepStrictEqual(await Promise.all([first, second]), [
			{ kind: 'success', targeting: 'session' },
			{ kind: 'success', targeting: 'session' },
		]);
		assert.strictEqual(targetUris.length, 2);
	});
});

suite('task chat attachment ordering', () => {
	test('keeps the Markdown task file first and appends images in reference order', () => {
		const task = vscode.Uri.file('C:/tasks/TASK-9.md');
		const first = vscode.Uri.file('C:/tasks/TASK-9.attachments/first.png');
		const second = vscode.Uri.file('C:/tasks/TASK-9.attachments/second.webp');

		assert.deepStrictEqual(orderedTaskChatAttachments(task, [first, second]), [task, first, second]);
	});

	test('text-only runs retain a single Markdown attachment', () => {
		const task = vscode.Uri.file('C:/tasks/TASK-9.md');
		assert.deepStrictEqual(orderedTaskChatAttachments(task), [task]);
	});
});

suite('ChatSessionExecutor concurrency', () => {
	test('releases the injection mutex before the terminal chat response resolves', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const first = executor.run(
			executorTask('TASK-001'),
			vscode.Uri.file('C:/tasks/TASK-001.md'),
			'first prompt',
			'develop',
			executorRunOptions,
		);

		await waitUntil(() => commands.responses.length === 1);
		const second = executor.run(
			executorTask('TASK-002'),
			vscode.Uri.file('C:/tasks/TASK-002.md'),
			'second prompt',
			'develop',
			executorRunOptions,
		);

		await waitUntil(() => commands.responses.length === 2);
		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			'workbench.action.chat.openagent',
			'vscode.open',
			'workbench.action.chat.openagent',
		]);

		commands.responses[0].resolve({ metadata: { sessionId: 'session-1' } });
		commands.responses[1].resolve({ metadata: { sessionId: 'session-2' } });

		assert.deepStrictEqual(await Promise.all([first, second]), [
			{ ok: true, sessionId: 'session-1' },
			{ ok: true, sessionId: 'session-2' },
		]);
	});

	test('reports a rejected chat command without holding the injection mutex', async () => {
		const commands = new ControlledChatCommands();
		commands.rejectAgentCommand = true;
		const executor = new ChatSessionExecutor(commands);

		const result = await executor.run(
			executorTask('TASK-003'),
			vscode.Uri.file('C:/tasks/TASK-003.md'),
			'prompt',
			'develop',
			executorRunOptions,
		);

		assert.deepStrictEqual(result, { ok: false, error: 'chat command failed' });
	});

	test('does not reject a client whose command inventory omits vscode.open when the command executes', async () => {
		const commands = new ControlledChatCommands();
		commands.availableCommands = ['workbench.action.chat.openagent'];
		const executor = new ChatSessionExecutor(commands);

		const run = executor.run(
			executorTask('TASK-004'),
			vscode.Uri.file('C:/tasks/TASK-004.md'),
			'prompt',
			'develop',
			executorRunOptions,
		);
		await waitUntil(() => commands.responses.length === 1);
		commands.responses[0].resolve({ metadata: { sessionId: 'session-4' } });

		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-4' });
		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			'workbench.action.chat.openagent',
		]);
	});
});

/**
 * TASK-006 — the observe-and-transform seam around the executor's outbound
 * payload (row 1 of the hijack matrix, docs/copilot-chat-hijack-spike.md).
 */
suite('outbound payload seam', () => {
	const taskFile = vscode.Uri.file('C:/tasks/TASK-006.md');

	async function injectedPayload(
		executor: ChatSessionExecutor,
		commands: ControlledChatCommands,
		prompt: string,
		options: RunOptions = executorRunOptions,
	): Promise<OutboundPayload> {
		const run = executor.run(executorTask('TASK-006'), taskFile, prompt, 'develop', options);
		await waitUntil(() => commands.responses.length === 1);
		const payload = commands.calls[1].args[0] as OutboundPayload;
		commands.responses[0].resolve({ metadata: { sessionId: 'session-6' } });
		await run;
		return payload;
	}

	test('the default no-op seam injects today’s exact payload', async () => {
		const commands = new ControlledChatCommands();
		const payload = await injectedPayload(new ChatSessionExecutor(commands), commands, 'prompt');

		assert.deepStrictEqual(payload, {
			query: 'prompt',
			mode: 'agent',
			blockOnResponse: true,
			attachFiles: orderedTaskChatAttachments(taskFile),
			toolsInclude: undefined,
			toolsExclude: [],
		});
	});

	test('the observe hook receives redacted structural metadata, never the raw prompt', async () => {
		const commands = new ControlledChatCommands();
		let seen: OutboundMetadata | undefined;
		const executor = new ChatSessionExecutor(commands, {}, { observe: (m) => (seen = m) });

		await injectedPayload(executor, commands, 'top secret prompt body', {
			...executorRunOptions,
			toolsExclude: ['memory'],
		});

		assert.ok(seen, 'observe hook was invoked');
		assert.deepStrictEqual(seen, {
			taskId: 'TASK-006',
			stage: 'develop',
			mode: 'agent',
			toolsInclude: undefined,
			toolsExclude: ['memory'],
			attachmentCount: 1,
			queryLength: 'top secret prompt body'.length,
		});
		assert.ok(!('query' in (seen as object)), 'metadata must not carry the raw prompt');
		assert.ok(!JSON.stringify(seen).includes('top secret prompt body'));
	});

	test('the transform hook rewrites the injected preamble and toolsExclude policy', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands, {}, {
			transform: (payload) => ({
				...payload,
				query: `PREAMBLE\n${payload.query}`,
				toolsExclude: [...payload.toolsExclude, 'memory', 'resolveMemoryFileUri'],
			}),
		});

		const payload = await injectedPayload(executor, commands, 'do the work');

		assert.strictEqual(payload.query, 'PREAMBLE\ndo the work');
		assert.deepStrictEqual(payload.toolsExclude, ['memory', 'resolveMemoryFileUri']);
	});

	test('a throwing transform fails safe to the untransformed payload', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands, {}, {
			transform: () => {
				throw new Error('boom');
			},
		});

		const payload = await injectedPayload(executor, commands, 'unchanged prompt');

		assert.strictEqual(payload.query, 'unchanged prompt');
		assert.deepStrictEqual(payload.toolsExclude, []);
	});

	test('an invalid transform return falls back to the untransformed payload', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands, {}, {
			transform: () => null as unknown as OutboundPayload,
		});

		const payload = await injectedPayload(executor, commands, 'still here');

		assert.strictEqual(payload.query, 'still here');
	});

	test('the seam preserves the open→inject ordering and mutex serialization', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands, {}, {
			transform: (payload) => ({ ...payload, query: `X:${payload.query}` }),
		});

		const first = executor.run(executorTask('TASK-001'), taskFile, 'a', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);
		const second = executor.run(executorTask('TASK-002'), taskFile, 'b', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 2);

		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			'workbench.action.chat.openagent',
			'vscode.open',
			'workbench.action.chat.openagent',
		]);
		assert.strictEqual((commands.calls[1].args[0] as OutboundPayload).query, 'X:a');
		assert.strictEqual((commands.calls[3].args[0] as OutboundPayload).query, 'X:b');

		commands.responses[0].resolve({ metadata: { sessionId: 'session-1' } });
		commands.responses[1].resolve({ metadata: { sessionId: 'session-2' } });
		await Promise.all([first, second]);
	});
});


suite('column agent selection', () => {
	const AGENT = 'Bro LocalRapidPrototyping Orchestrator';

	// These assert the OUTCOME — which agent the payload selects — not the
	// transport. An earlier version checked only the invoked command id, which
	// passed against a payload that silently resolved back to the built-in agent.
	test('sends the assigned agent as the payload mode so findModeByName selects it', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-030'),
			vscode.Uri.file('C:/tasks/TASK-030.md'),
			'agent prompt',
			'develop',
			{ ...executorRunOptions, agentName: AGENT },
		);

		await waitUntil(() => commands.responses.length === 1);
		const injected = commands.calls.find(({ command }) => command === 'workbench.action.chat.openagent');
		assert.ok(injected, 'the turn still goes through the configured mode command');
		assert.strictEqual(
			(injected.args[0] as OutboundPayload).mode,
			AGENT,
			'the payload mode must name the agent, not the configured chat mode',
		);
		assert.ok(
			!commands.calls.some(({ command }) => command === CHAT_NEW_COMMAND),
			'selecting an agent must not create a conversation',
		);

		commands.responses[0].resolve({ metadata: { sessionId: 'session-30' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-30' });
	});

	test('an unassigned column still sends the configured chat mode unchanged', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-031'),
			vscode.Uri.file('C:/tasks/TASK-031.md'),
			'plain prompt',
			'develop',
			{ ...executorRunOptions },
		);

		await waitUntil(() => commands.responses.length === 1);
		const injected = commands.calls.find(({ command }) => command === 'workbench.action.chat.openagent');
		assert.strictEqual((injected!.args[0] as OutboundPayload).mode, 'agent');
		commands.responses[0].resolve({ metadata: { sessionId: 'session-31' } });
		assert.deepStrictEqual(await run, { ok: true, sessionId: 'session-31' });
	});

	test('a blank assignment falls back to the configured mode rather than an empty one', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-032'),
			vscode.Uri.file('C:/tasks/TASK-032.md'),
			'blank prompt',
			'develop',
			{ ...executorRunOptions, agentName: '   ' },
		);

		await waitUntil(() => commands.responses.length === 1);
		const injected = commands.calls.find(({ command }) => command === 'workbench.action.chat.openagent');
		assert.strictEqual((injected!.args[0] as OutboundPayload).mode, 'agent');
		commands.responses[0].resolve({ metadata: { sessionId: 'session-32' } });
		await run;
	});

	test('selecting an agent opens the task session and never resets it', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const run = executor.run(
			executorTask('TASK-033'),
			vscode.Uri.file('C:/tasks/TASK-033.md'),
			'agent prompt',
			'develop',
			{ ...executorRunOptions, agentName: AGENT },
		);

		await waitUntil(() => commands.responses.length === 1);
		assert.deepStrictEqual(commands.calls.map(({ command }) => command), [
			'vscode.open',
			'workbench.action.chat.openagent',
		], 'open the derived session, then inject — no New Chat, no extra command');
		commands.responses[0].resolve({ metadata: { sessionId: 'session-33' } });
		await run;
	});
});
