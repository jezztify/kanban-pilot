import * as assert from 'assert';
import * as vscode from 'vscode';

import { Task } from '../model/task';
import {
	ChatCommandApi,
	ChatSessionExecutor,
	orderedTaskChatAttachments,
	resolveToolsInclude,
	taskChatOpenOptions,
} from '../chat/executor';
import { RunOptions } from '../chat/executor';
import { sessionUriForTaskBinding } from '../chat/sessionUri';

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
	availableCommands = ['workbench.action.chat.openagent'];
	rejectAgentCommand = false;

	getCommands(): Thenable<string[]> {
		return Promise.resolve(this.availableCommands);
	}

	executeCommand<T>(command: string, ...args: unknown[]): Thenable<T> {
		this.calls.push({ command, args });
		if (command === 'vscode.open') {
			return Promise.resolve(undefined as T);
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

	test('injection opens Copilot’s concrete session id after a window reload', async () => {
		const commands = new ControlledChatCommands();
		const executor = new ChatSessionExecutor(commands);
		const task = executorTask('TASK-001');
		task.chat = 'legacy-derived-binding';
		task.copilotSessionId = 'copilot-conversation-id';

		const run = executor.run(task, vscode.Uri.file('C:/tasks/TASK-001.md'), 'prompt', 'develop', executorRunOptions);
		await waitUntil(() => commands.responses.length === 1);

		assert.strictEqual(
			(commands.calls[0].args[0] as vscode.Uri).toString(),
			sessionUriForTaskBinding(task, executorRunOptions.sessionPrefix, task.setId).toString(),
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
});
