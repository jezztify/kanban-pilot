import * as assert from 'assert';
import * as vscode from 'vscode';

import {
	ContextCompactionService,
	NATIVE_COMPACTION_ENABLED,
	NATIVE_COMPACTION_THRESHOLD,
	WorkspaceConfigurationInspection,
	WorkspaceConfigurationLike,
} from '../chat/contextCompaction';
import { CompactionResult } from '../chat/executor';
import { Task } from '../model/task';

class FakeConfiguration implements WorkspaceConfigurationLike {
	readonly values = new Map<string, unknown>();
	readonly explicit = new Map<string, unknown>();
	readonly registered = new Set<string>([NATIVE_COMPACTION_ENABLED, NATIVE_COMPACTION_THRESHOLD]);
	readonly updates: { key: string; value: unknown; target: vscode.ConfigurationTarget | boolean | null | undefined }[] = [];
	thresholdDefault: unknown = 0.75;

	get<T>(key: string, fallback?: T): T {
		return (this.values.has(key) ? this.values.get(key) : fallback) as T;
	}

	inspect<T>(key: string): WorkspaceConfigurationInspection<T> | undefined {
		if (!this.registered.has(key)) {
			return undefined;
		}
		const value = this.values.get(key);
		return {
			key,
			defaultValue: (key === NATIVE_COMPACTION_ENABLED ? false : this.thresholdDefault) as T,
			...(value !== undefined && this.explicit.has(key) ? { globalValue: value as T } : {}),
		};
	}

	async update(
		key: string,
		value: unknown,
		target?: vscode.ConfigurationTarget | boolean | null,
	): Promise<void> {
		this.values.set(key, value);
		this.explicit.set(key, value);
		this.updates.push({ key, value, target });
	}
}

function task(id = 'TASK-014'): Task {
	return {
		setId: 'set-test',
		id,
		title: 'Context compaction task',
		type: 'feature',
		state: 'in-progress',
		status: 'running',
		chat: 'kanban-pilot-set-test-TASK-014',
		copilotSessionId: 'copilot-uuid',
		chatResetRequired: false,
		sections: {},
		body: '',
	};
}

function enabledOptions(threshold: unknown = 0.8) {
	return { enabled: true, threshold, mode: 'agent', sessionPrefix: 'kanban-pilot-' };
}

suite('ContextCompactionService', () => {
	test('does not inspect or change Copilot settings when disabled', async () => {
		let configurationCalls = 0;
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => {
				configurationCalls += 1;
				throw new Error('disabled compaction must not inspect configuration');
			},
		);

		const result = await service.prepare({ ...enabledOptions(), enabled: false });

		assert.deepStrictEqual(result, { kind: 'disabled' });
		assert.strictEqual(configurationCalls, 0);
	});

	test('rejects a threshold outside the exclusive lower and inclusive upper bounds', async () => {
		let configurationCalls = 0;
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => {
				configurationCalls += 1;
				throw new Error('invalid compaction must not inspect configuration');
			},
		);

		for (const threshold of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY, 1.01]) {
			const result = await service.prepare(enabledOptions(threshold));
			assert.deepStrictEqual(result, { kind: 'invalid', reason: 'invalid-threshold' });
		}
		assert.strictEqual(configurationCalls, 0);
	});

	test('reports an experimental incompatibility without changing settings', async () => {
		const configuration = new FakeConfiguration();
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => configuration,
			{ nativeSettingsSupported: false, copilotVersion: '0.55.0' },
		);

		const result = await service.prepare(enabledOptions());

		assert.deepStrictEqual(result, {
			kind: 'unsupported',
			reason: 'experimental-incompatible',
			experimental: true,
			copilotVersion: '0.55.0',
		});
		assert.deepStrictEqual(configuration.updates, []);
	});

	test('configures native settings when enabled and no explicit values conflict', async () => {
		const configuration = new FakeConfiguration();
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => configuration,
			{ copilotVersion: '0.55.0' },
		);

		const result = await service.prepare(enabledOptions(0.8));

		assert.strictEqual(result.kind, 'ready');
		assert.deepStrictEqual(configuration.updates.map(({ key, value }) => [key, value]), [
			[NATIVE_COMPACTION_ENABLED, true],
			[NATIVE_COMPACTION_THRESHOLD, 0.8],
		]);
	});

	test('treats Copilot’s unset threshold as compatible and supplies the configured ratio', async () => {
		const configuration = new FakeConfiguration();
		configuration.thresholdDefault = undefined;
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => configuration,
		);

		const result = await service.prepare(enabledOptions(0.8));

		assert.strictEqual(result.kind, 'ready');
		assert.deepStrictEqual(configuration.updates.map(({ key, value }) => [key, value]), [
			[NATIVE_COMPACTION_ENABLED, true],
			[NATIVE_COMPACTION_THRESHOLD, 0.8],
		]);
	});

	test('does not overwrite conflicting explicit native settings', async () => {
		const configuration = new FakeConfiguration();
		configuration.values.set(NATIVE_COMPACTION_ENABLED, false);
		configuration.explicit.set(NATIVE_COMPACTION_ENABLED, false);
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => configuration,
		);

		const result = await service.prepare(enabledOptions(0.8));

		assert.strictEqual(result.kind, 'conflict');
		assert.strictEqual(result.kind === 'conflict' ? result.setting : '', 'enabled');
		assert.deepStrictEqual(configuration.updates, []);
	});

	test('does not replace an explicit absolute-token Copilot threshold', async () => {
		const configuration = new FakeConfiguration();
		configuration.values.set(NATIVE_COMPACTION_THRESHOLD, 60000);
		configuration.explicit.set(NATIVE_COMPACTION_THRESHOLD, 60000);
		const service = new ContextCompactionService(
			{ compact: async () => ({ kind: 'success', targeting: 'session' }) },
			() => configuration,
		);

		const result = await service.prepare(enabledOptions(0.8));

		assert.strictEqual(result.kind, 'conflict');
		assert.strictEqual(result.kind === 'conflict' ? result.setting : '', 'threshold');
		assert.deepStrictEqual(configuration.updates, []);
	});

	test('reports unavailable native settings without invoking the executor', async () => {
		const configuration = new FakeConfiguration();
		configuration.registered.delete(NATIVE_COMPACTION_THRESHOLD);
		let calls = 0;
		const service = new ContextCompactionService(
			{ compact: async () => { calls += 1; return { kind: 'success', targeting: 'session' }; } },
			() => configuration,
		);

		const result = await service.request(task(), enabledOptions());

		assert.strictEqual(result.kind, 'unsupported');
		assert.strictEqual(result.kind === 'unsupported' ? result.reason : '', 'native-settings-unavailable');
		assert.strictEqual(calls, 0);
	});

	test('classifies a focus-only executor boundary as unsupported task-session targeting', async () => {
		const configuration = new FakeConfiguration();
		const service = new ContextCompactionService(
			{
				compact: async () => ({
					kind: 'unsupported',
					diagnostic: {
						code: 'unsupported-compact-session-target',
						capability: 'compact-command',
						mode: 'agent',
						message: 'focus-only',
						remediation: 'native settings',
					},
				}),
			},
			() => configuration,
		);

		const result = await service.request(task(), enabledOptions());

		assert.deepStrictEqual(result, {
			kind: 'unsupported',
			reason: 'session-target-unavailable',
			experimental: true,
		});
	});

	test('uses the stable task binding and suppresses a duplicate in-flight request', async () => {
		const configuration = new FakeConfiguration();
		const gate = deferred<void>();
		const calls: { taskId: string; session: string }[] = [];
		const service = new ContextCompactionService(
			{
				compact: async (currentTask) => {
					calls.push({ taskId: currentTask.id, session: currentTask.chat ?? '' });
					await gate.promise;
					return { kind: 'success', targeting: 'session' };
				},
			},
			() => configuration,
		);
		const currentTask = task();

		const first = service.request(currentTask, enabledOptions());
		await waitUntil(() => calls.length === 1);
		const second = await service.request(currentTask, enabledOptions());
		assert.strictEqual(second.kind, 'duplicate');
		assert.strictEqual(second.kind === 'duplicate' ? second.taskId : '', currentTask.id);
		assert.strictEqual(calls[0].session, currentTask.chat);

		gate.resolve();
		const result = await first;
		assert.strictEqual(result.kind, 'success');
		assert.strictEqual(calls.length, 1);
	});

	test('maps executor failure and keeps the outcome bounded', async () => {
		const configuration = new FakeConfiguration();
		const executorResult: CompactionResult = {
			kind: 'failed',
			error: 'raw error should not escape the adapter',
		};
		const service = new ContextCompactionService(
			{ compact: async () => executorResult },
			() => configuration,
		);

		const result = await service.request(task(), enabledOptions());

		assert.strictEqual(result.kind, 'failed');
		assert.strictEqual(result.kind === 'failed' ? result.reason : '', 'compact-command-failed');
		assert.strictEqual(result.kind === 'failed' ? result.message : '', 'Copilot native compaction failed; task execution remains usable.');
	});
});

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
	return { promise, resolve };
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
