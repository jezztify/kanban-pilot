import * as assert from 'assert';
import * as vscode from 'vscode';

import { Task } from '../model/task';
import {
	ChatCommandApi,
	ChatSessionExecutor,
	CHAT_CANCEL_COMMAND,
	capabilityDiagnostic,
	orderedTaskChatAttachments,
	resolveToolsInclude,
	taskChatOpenOptions,
} from '../chat/executor';
import { RunOptions } from '../chat/executor';
import type { OutboundMetadata, OutboundPayload } from '../chat/executor';
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
	availableCommands = ['vscode.open', 'workbench.action.chat.openagent'];
	rejectAgentCommand = false;
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
