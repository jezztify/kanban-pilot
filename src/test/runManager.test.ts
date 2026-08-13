import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { Task } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { Executor, ExecutorResult } from '../chat/executor';
import { RunManager } from '../chat/runManager';
import { formatReceipt } from '../chat/receipt';
import { invokeTaskAction } from '../board/actions';

/**
 * M3 — RunManager orchestration (PRD §6.4, §6.9). Uses a stub `Executor` so
 * these never touch real VS Code chat commands; the injection mechanism
 * itself (vscode.open, chat.open<Mode>, blockOnResponse) is already validated
 * empirically in M0 (docs/m0-findings.md) and re-proving it here would be
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
		return !!task && task.status !== 'running';
	});
	return task!;
}

type Next = (task: Task, prompt: string) => Promise<ExecutorResult> | 'hang';

class StubExecutor implements Executor {
	calls: { task: Task; prompt: string }[] = [];
	constructor(private next: Next) {}

	async isAvailable(): Promise<boolean> {
		return true;
	}

	async run(task: Task, _taskFileUri: vscode.Uri, prompt: string): Promise<ExecutorResult> {
		this.calls.push({ task, prompt });
		const outcome = this.next(task, prompt);
		if (outcome === 'hang') {
			return new Promise<ExecutorResult>(() => {
				/* never resolves — drives the timeout path */
			});
		}
		return outcome;
	}
}

/** Every default template embeds `run:<id>` in the receipt instruction (verified separately). */
function runIdFromPrompt(prompt: string): string {
	const match = /run:(\S+)/.exec(prompt);
	if (!match) {
		throw new Error('prompt did not embed a run id — template regressed');
	}
	return match[1];
}

/** Stage-generic receipt writer for a stub executor: reads the runId straight out of the prompt it received. */
function okReceipt(store: TaskStore, stage: 'refine' | 'develop' | 'validate' | 'split') {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result: 'ok', note: 'done' }));
		return { ok: true, sessionId: 's1' };
	};
}

/** Appends the stage's own receipt plus one propose-task line per title given. */
function okReceiptWithProposals(store: TaskStore, stage: 'refine' | 'develop' | 'validate' | 'split', titles: string[]) {
	return async (t: Task, prompt: string): Promise<ExecutorResult> => {
		const runId = runIdFromPrompt(prompt);
		for (const title of titles) {
			await store.appendLog(t.id, `- propose-task run:${runId} title:"${title}" note:"found while working"`);
		}
		await store.appendLog(t.id, formatReceipt({ runId, taskId: t.id, stage, result: 'ok', note: 'done' }));
		return { ok: true, sessionId: 's1' };
	};
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
	});

	teardown(async () => {
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
			assert.strictEqual(after.copilotSessionId, 's1');
			assert.ok(after.scopeHash, 'refine success must record scope_hash for §6.8 layer 2');
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
			} finally {
				await cfg.update('run.timeoutMinutes', undefined, vscode.ConfigurationTarget.Global);
			}
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
	});

	suite('develop stage', () => {
		test('a successful develop run advances In Progress → Validation', async () => {
			const task = await store.create('Set up billing webhook');
			// 'develop' is only legal from Approved — it's the single click that
			// both moves the card into In Progress and launches the run.
			await store.patch(task.id, { state: 'approved', status: 'idle' });
			const runManager = new RunManager(store, new StubExecutor(okReceipt(store, 'develop')), folder);

			await runManager.handleAction(task.id, 'develop');
			const after = await waitUntilSettled(store, task.id);

			assert.strictEqual(after.state, 'validation');
			assert.strictEqual(after.status, 'idle');
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
			assert.strictEqual(stopped.state, 'refine');
			assert.strictEqual(stopped.status, 'idle');
			assert.strictEqual(stopped.run, undefined, 'Stop must clear run — otherwise a late resolution reconciles against a stale id');

			resolveRun!({ ok: true, sessionId: 's1' });
			await new Promise((r) => setTimeout(r, 200));

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.status, 'idle', 'the late resolution must find no matching run and do nothing');
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
			await store.patch(task.id, { state: 'in-progress', status: 'running', run: 'r-lost' });
			await store.appendLog(task.id, formatReceipt({ runId: 'r-lost', taskId: task.id, stage: 'develop', result: 'ok', note: 'done before reload' }));

			const runManager = new RunManager(store, new StubExecutor(() => 'hang'), folder);
			await runManager.reconcileOnActivation();

			const after = (await store.readAll()).tasks[0];
			assert.strictEqual(after.state, 'validation');
		});
	});

	suite('gate policies (§6.15)', () => {
		async function withGates(gates: Partial<Record<
			'gates.backlogToRefine' | 'gates.scopedToApproved' | 'gates.approvedToInProgress' | 'gates.validationAutoStart',
			'manual' | 'auto'
		>>, fn: () => Promise<void>): Promise<void> {
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
	});
});
