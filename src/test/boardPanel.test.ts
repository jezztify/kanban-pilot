import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import {
	BoardPanel,
	BoardTaskSetHost,
	GATES,
	isAgentColumn,
	isAgentNameValue,
	isGateKey,
	persistAgentNameOverride,
	persistGateSetting,
	SETTINGS_COLUMNS,
	settingsStateFor,
	updateAgentNameOverrides,
} from '../board/boardPanel';
import { Executor } from '../chat/executor';
import { RunManager } from '../chat/runManager';
import { DEFAULT_TASK_SET_ID, DEFAULT_TASK_SET_NAME, TaskSet } from '../model/taskSets';
import { TaskStore } from '../model/taskStore';

const noopExecutor: Executor = {
	async isAvailable() {
		return false;
	},
	async run() {
		return { ok: false, error: 'unused in Settings tests' };
	},
};

function makeTaskSet(directory: vscode.Uri): TaskSet {
	return {
		id: DEFAULT_TASK_SET_ID,
		name: DEFAULT_TASK_SET_NAME,
		directory,
		isDefault: true,
	};
}

function detailViewFor(task: {
	id: string;
	title: string;
	sections: Record<string, string>;
}, canEdit = true) {
	return {
		id: task.id,
		title: task.title,
		type: 'feature',
		typeLabel: 'Feature',
		state: 'backlog',
		stateLabel: 'Backlog',
		status: canEdit ? 'idle' : 'running',
		canEdit,
		request: task.sections.Request ?? '',
		refined: task.sections.Refined ?? '',
		scope: task.sections.Scope ?? '',
		lastLog: task.sections.Log ?? '',
		moveTargets: [{ id: 'backlog', label: 'Backlog' }],
		secondary: null,
	};
}

function dispatchWebviewMessage(dom: JSDOM, data: unknown): void {
	dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
}

function clickElement(element: unknown): void {
	assert.ok(element, 'expected an interactive webview element');
	(element as { click(): void }).click();
}

suite('BoardPanel Settings', () => {
	test('validates gate and column payload values and projects all seven effective labels', () => {
		assert.strictEqual(isGateKey('backlogToRefine'), true);
		assert.strictEqual(isGateKey('unknown'), false);
		assert.strictEqual(isAgentColumn('backlog'), true);
		assert.strictEqual(isAgentColumn('not-a-column'), false);
		assert.strictEqual(isAgentNameValue('Quality Pilot'), true);
		assert.strictEqual(isAgentNameValue('   '), true, 'blank is a valid reset payload');
		assert.strictEqual(isAgentNameValue('line\nbreak'), false);
		assert.strictEqual(isAgentNameValue('x'.repeat(61)), false);

		const state = settingsStateFor(
			{ backlogToRefine: 'auto', scopedToApproved: 'manual' },
			{ backlog: 'Queue Keeper', 'in-progress': 'Ship It Steve' },
		);
		assert.deepStrictEqual(state.gates, { backlogToRefine: 'auto', scopedToApproved: 'manual' });
		assert.strictEqual(Object.keys(state.agents).length, 7);
		assert.strictEqual(state.agents.backlog, 'Queue Keeper');
		assert.strictEqual(state.agents.refine, 'Bro Refiner');
		assert.strictEqual(state.agents['in-progress'], 'Ship It Steve');
		assert.strictEqual(state.agents.validation, 'Bro QA');
		assert.strictEqual(state.agents.done, 'None');
		assert.deepStrictEqual(
			SETTINGS_COLUMNS.map((column) => column.id),
			['backlog', 'refine', 'scoped', 'approved', 'in-progress', 'validation', 'done'],
		);
	});

	test('updates and resets column assignments while preserving legacy compatibility', () => {
		const updated = updateAgentNameOverrides(
			{ develop: 'Legacy Coder', validate: 'Legacy QA', unrelated: 'keep' },
			'in-progress',
			'  Ship It Steve  ',
		);
		assert.deepStrictEqual(updated, {
			'in-progress': 'Ship It Steve',
			validate: 'Legacy QA',
			unrelated: 'keep',
		});

		const reset = updateAgentNameOverrides(updated, 'in-progress', '   ');
		assert.deepStrictEqual(reset, { validate: 'Legacy QA', unrelated: 'keep' });

		const resting = updateAgentNameOverrides(reset, 'backlog', 'Queue Keeper');
		assert.strictEqual(resting.backlog, 'Queue Keeper');
		const restingReset = updateAgentNameOverrides(resting, 'backlog', '');
		assert.strictEqual(restingReset.backlog, undefined);
	});

	test('persists Settings mutations at workspace scope', async () => {
		const writes: { key: string; value: unknown; target: vscode.ConfigurationTarget }[] = [];
		const configuration = {
			async update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				writes.push({ key, value, target });
			},
		};

		await persistAgentNameOverride(configuration, { develop: 'Legacy Coder' }, 'in-progress', 'Ship It Steve');
		assert.deepStrictEqual(writes[0], {
			key: 'chat.agentNames',
			value: { 'in-progress': 'Ship It Steve' },
			target: vscode.ConfigurationTarget.Workspace,
		});
		assert.strictEqual(await persistGateSetting(configuration, 'validationAutoStart', 'auto'), true);
		assert.deepStrictEqual(writes[1], {
			key: 'gates.validationAutoStart',
			value: 'auto',
			target: vscode.ConfigurationTarget.Workspace,
		});
		assert.strictEqual(await persistGateSetting(configuration, 'not-a-gate', 'auto'), false);
		assert.strictEqual(writes.length, 2);
	});

	test('renders one Settings entry point and rejects invalid webview messages', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-settings-test', index: 0 };
		const activeSet = makeTaskSet(directory);
		const runManager = new RunManager(store, noopExecutor, folder);
		const host: BoardTaskSetHost = {
			ready: Promise.resolve(),
			store,
			runManager,
			activeSet,
			async listTaskSets() {
				return [activeSet];
			},
			async switchTaskSet() {},
			async createTaskSet() {},
			async renameTaskSet() {},
			async deleteTaskSet() {},
			onDidChange() {
				return new vscode.Disposable(() => undefined);
			},
		};
		const panel = vscode.window.createWebviewPanel(
			'kanbanPilot.settingsTest',
			'Kanban Pilot Settings Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost) => BoardPanel;
		const board = new constructor(panel, host);
		const onMessage = (board as unknown as { onMessage(message: unknown): Promise<void> }).onMessage.bind(board);
		try {
			assert.ok(panel.webview.html.includes('id="settingsToggle"'));
			assert.ok(panel.webview.html.includes('id="settingsBackdrop"'));
			assert.ok(panel.webview.html.includes('settings/state'));
			assert.match(panel.webview.html, /id="settingsCategoryNav"/);
			assert.match(panel.webview.html, /role="tablist"/);
			assert.match(panel.webview.html, /id="settingsCategoryGates"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="settingsPanelGates"/);
			assert.match(panel.webview.html, /id="settingsCategoryAgents"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="settingsPanelAgents"[^>]*tabindex="-1"/);
			assert.match(panel.webview.html, /id="settingsPanelGates"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsCategoryGates"/);
			assert.match(panel.webview.html, /id="settingsPanelAgents"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsCategoryAgents"[^>]*hidden[^>]*aria-hidden="true"/);
			assert.match(panel.webview.html, /id="settingsMain"[^>]*role="region"/);
			assert.ok(!panel.webview.html.includes('id="gatesToggle"'));
			assert.ok(!panel.webview.html.includes('id="agentNameModal"'));
			assert.ok(panel.webview.html.includes('taskEditForm'));
			assert.ok(panel.webview.html.includes('task/editError'));
			const script = /<script[^>]*>([\s\S]*)<\/script>/.exec(panel.webview.html)?.[1];
			assert.ok(script, 'generated webview script is present');
			assert.doesNotThrow(() => new vm.Script(script), 'generated webview script must parse in the browser');
			assert.match(script, /input\.checked = gates\[gate\.key\] === 'auto';/);
			assert.doesNotMatch(script, /input\.checked = state\[gate\.key\] === 'auto';/);
			assert.match(script, /const DEFAULT_SETTINGS_CATEGORY = 'gates';/);
			assert.match(script, /let selectedSettingsCategory = DEFAULT_SETTINGS_CATEGORY;/);
			assert.match(script, /selectSettingsCategory\(focusColumn \? 'agents' : DEFAULT_SETTINGS_CATEGORY, false\)/);
			assert.match(script, /SETTINGS_CATEGORIES\.indexOf\(button\.dataset\.category\)/);
			assert.match(script, /event\.key === 'ArrowDown'/);
			assert.match(script, /event\.key === 'ArrowUp'/);
			assert.match(script, /event\.key === 'Home'/);
			assert.match(script, /event\.key === 'End'/);
			assert.match(script, /settings-panel:not\(\[hidden\]\)/);
			assert.match(script, /type: 'gates\/set'/);
			assert.match(script, /type: 'agentName\/set'/);
			assert.match(script, /type: 'task\/edit'/);
			assert.match(panel.webview.html, /id="newTaskType"[^>]*required/);
			assert.match(panel.webview.html, /<option value="feature">Feature<\/option>/);
			assert.match(panel.webview.html, /<option value="bug">Bug<\/option>/);
			assert.match(script, /taskType/);
			assert.match(script, /Task type: /);
			assert.match(script, /Use Arrow Up or Arrow Down to change position/);
			assert.match(script, /titleInput\.value = task\.title/);
			assert.match(script, /taskEditRequest/);
			assert.match(script, /taskEditRefined/);
			assert.match(script, /taskEditScope/);
			assert.match(script, /renderDetail\(task\)/, 'Cancel must discard the edit form');
			assert.match(script, /role', 'alert'/, 'save errors must be visible to assistive technology');
			assert.match(script, /type: 'task\/reorder'/, 'keyboard and slot reorder intents must use the reorder protocol');
			assert.match(script, /drop-slot/, 'the board must render explicit insertion targets');
			assert.match(script, /ArrowUp/);
			assert.match(script, /ArrowDown/);
			assert.match(panel.webview.html, /aria-live="polite"/, 'reorder feedback must be announced accessibly');
			assert.match(script, /Moved|moved to position/, 'successful reorder feedback must include a position');

			await onMessage({ type: 'agentName/set', column: 'not-a-column', value: 'Ignored' });
			await onMessage({ type: 'gates/set', key: 'not-a-gate', value: 'auto' });
			await onMessage({ type: 'task/create', title: 'Bug from board', description: 'Broken flow', taskType: 'bug' });
			await onMessage({ type: 'task/create', title: 'Invalid from board', taskType: 'regression' });
			const boardTasks = (await store.readAll()).tasks;
			assert.strictEqual(boardTasks.find((task) => task.title === 'Bug from board')?.type, 'bug');
			assert.strictEqual(boardTasks.some((task) => task.title === 'Invalid from board'), false);
			const first = await store.create('First card');
			const second = await store.create('Second card');
			await onMessage({ type: 'task/reorder', taskId: second.id, column: 'backlog', beforeTaskId: first.id });
			assert.deepStrictEqual(
				(await store.snapshot()).columns.find((column) => column.id === 'backlog')?.tasks
					.filter((task) => task.id !== boardTasks.find((candidate) => candidate.title === 'Bug from board')?.id)
					.map((task) => task.id),
				[second.id, first.id],
			);
		} finally {
			board.dispose();
			try {
				await vscode.workspace.fs.delete(directory, { recursive: true });
			} catch {
				/* already gone */
			}
		}
	});

	test('persists valid edits and rejects malformed or running-task messages without a write', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-edit-test', index: 0 };
		const activeSet = makeTaskSet(directory);
		const runManager = new RunManager(store, noopExecutor, folder);
		const host: BoardTaskSetHost = {
			ready: Promise.resolve(),
			store,
			runManager,
			activeSet,
			async listTaskSets() {
				return [activeSet];
			},
			async switchTaskSet() {},
			async createTaskSet() {},
			async renameTaskSet() {},
			async deleteTaskSet() {},
			onDidChange() {
				return new vscode.Disposable(() => undefined);
			},
		};
		const panel = vscode.window.createWebviewPanel(
			'kanbanPilot.boardEditTest',
			'Kanban Pilot Edit Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost) => BoardPanel;
		const board = new constructor(panel, host);
		const onMessage = (board as unknown as { onMessage(message: unknown): Promise<void> }).onMessage.bind(board);
		try {
			const task = await store.create('Before edit', { request: 'Original request' });
			const uri = store.fileFor(task.id);
			const before = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

			await onMessage({
				type: 'task/edit',
				taskId: task.id,
				content: {
					title: 'After edit',
					request: 'Line one\nLine two',
					refined: '**Refined**',
					scope: '- [ ] Scope item',
				},
			});
			const edited = (await store.readAll()).tasks[0];
			assert.strictEqual(edited.title, 'After edit');
			assert.strictEqual(edited.sections['Request'], 'Line one\nLine two');
			assert.strictEqual(edited.sections['Refined'], '**Refined**');
			assert.strictEqual(edited.sections['Scope'], '- [ ] Scope item');

			const afterValidEdit = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			await onMessage({
				type: 'task/edit',
				taskId: task.id,
				content: { title: 'Invalid', request: 42, refined: '', scope: '' },
			});
			assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), afterValidEdit);

			await onMessage({ type: 'task/edit', content: { title: 'Missing id', request: '', refined: '', scope: '' } });
			assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), afterValidEdit);

			await store.patch(task.id, { status: 'running', run: 'r-running' });
			const beforeRunningEdit = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			await onMessage({
				type: 'task/edit',
				taskId: task.id,
				content: { title: 'Must be rejected', request: '', refined: '', scope: '' },
			});
			assert.strictEqual(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8'), beforeRunningEdit);
			assert.notStrictEqual(before, afterValidEdit, 'a valid edit must refresh the persisted task');
		} finally {
			board.dispose();
			try {
				await vscode.workspace.fs.delete(directory, { recursive: true });
			} catch {
				/* already gone */
			}
		}
	});

	test('exercises task editor interactions and refreshes the rendered board', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-webview-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-webview-test', index: 0 };
		const activeSet = makeTaskSet(directory);
		const runManager = new RunManager(store, noopExecutor, folder);
		const host: BoardTaskSetHost = {
			ready: Promise.resolve(),
			store,
			runManager,
			activeSet,
			async listTaskSets() {
				return [activeSet];
			},
			async switchTaskSet() {},
			async createTaskSet() {},
			async renameTaskSet() {},
			async deleteTaskSet() {},
			onDidChange() {
				return new vscode.Disposable(() => undefined);
			},
		};
		const panel = vscode.window.createWebviewPanel(
			'kanbanPilot.boardWebviewTest',
			'Kanban Pilot Webview Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost) => BoardPanel;
		const board = new constructor(panel, host);
		const onMessage = (board as unknown as { onMessage(message: unknown): Promise<void> }).onMessage.bind(board);
		let dom: JSDOM | undefined;
		try {
			const task = await store.create('Before editor', { request: 'Original request' });
			const posted: unknown[] = [];
			dom = new JSDOM(panel.webview.html, {
				runScripts: 'dangerously',
				pretendToBeVisual: true,
				beforeParse(window) {
					Object.defineProperty(window, 'acquireVsCodeApi', {
						value: () => ({
							postMessage(message: unknown) {
								posted.push(message);
							},
						}),
					});
				},
			});

			const taskEditMessages = () => posted.filter((message) => (
				message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'task/edit'
			));
			const openEditor = () => {
				dispatchWebviewMessage(dom!, { type: 'task/detail', task: detailViewFor(task) });
				const edit = Array.from(dom!.window.document.querySelectorAll('button'))
					.find((button) => button.textContent === 'Edit task');
				clickElement(edit);
			};

			openEditor();
			const document = dom.window.document;
			assert.strictEqual((document.getElementById('taskEditTitle') as unknown as { value: string }).value, 'Before editor');
			assert.strictEqual((document.getElementById('taskEditRequest') as unknown as { value: string }).value, 'Original request');
			assert.strictEqual((document.getElementById('taskEditRefined') as unknown as { value: string }).value, '');
		assert.strictEqual((document.getElementById('taskEditScope') as unknown as { value: string }).value, '');

		const beforeCancel = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(task.id))).toString('utf8');
		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = 'Unsaved title';
		clickElement(document.querySelector('#taskEditForm button[type="button"]'));
		assert.strictEqual(document.getElementById('taskEditForm'), null, 'Cancel must leave edit mode');
		assert.strictEqual(
			Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(task.id))).toString('utf8'),
			beforeCancel,
			'Cancel must not write the task file',
		);
		assert.strictEqual(taskEditMessages().length, 0);

		openEditor();
		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = 'Escape title';
		dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
		assert.strictEqual(document.getElementById('taskEditForm'), null, 'Escape must close the editor');

		openEditor();
		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = 'Backdrop title';
		document.getElementById('detailBackdrop')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
		assert.strictEqual(document.getElementById('taskEditForm'), null, 'backdrop dismissal must close the editor');

		openEditor();
		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = 'Close title';
		clickElement(document.querySelector('[aria-label="Close task editor"]'));
		assert.strictEqual(document.getElementById('taskEditForm'), null, 'close button must close the editor');

		openEditor();
		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = '   ';
		document.getElementById('taskEditForm')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
		const validationError = document.getElementById('taskEditError');
		assert.ok(validationError);
		assert.strictEqual(validationError.hidden, false);
		assert.match(validationError.textContent ?? '', /cannot be blank/);
		assert.ok(document.getElementById('taskEditForm'), 'validation errors must keep the editor usable');

		dispatchWebviewMessage(dom, { type: 'task/editError', taskId: task.id, error: 'A server-side edit error' });
		assert.strictEqual(validationError.textContent, 'A server-side edit error');

		(document.getElementById('taskEditTitle') as unknown as { value: string }).value = 'Saved title #123';
		(document.getElementById('taskEditRequest') as unknown as { value: string }).value = 'Saved request\nwith Markdown';
		(document.getElementById('taskEditRefined') as unknown as { value: string }).value = '**Saved refined**';
		(document.getElementById('taskEditScope') as unknown as { value: string }).value = '- [ ] Saved scope';
		const beforeSaveMessages = posted.length;
		document.getElementById('taskEditForm')?.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
		const saveMessage = posted.slice(beforeSaveMessages).find((message) => (
			message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'task/edit'
		)) as { type: 'task/edit'; taskId: string; content: { title: string; request: string; refined: string; scope: string } } | undefined;
		const normalizedSaveMessage = saveMessage === undefined
			? undefined
			: JSON.parse(JSON.stringify(saveMessage)) as typeof saveMessage;
		assert.deepStrictEqual(normalizedSaveMessage, {
			type: 'task/edit',
			taskId: task.id,
			content: {
				title: 'Saved title #123',
				request: 'Saved request\nwith Markdown',
				refined: '**Saved refined**',
				scope: '- [ ] Saved scope',
			},
		});
		assert.ok(normalizedSaveMessage);
		await onMessage(normalizedSaveMessage);

		const edited = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
		assert.ok(edited);
		dispatchWebviewMessage(dom, { type: 'task/detail', task: detailViewFor(edited) });
		dispatchWebviewMessage(dom, {
			type: 'board/state',
			selectedTaskId: edited.id,
			snapshot: {
				malformed: [],
				taskSets: [{ id: activeSet.id, name: activeSet.name, isDefault: true }],
				activeTaskSetId: activeSet.id,
				activeTaskSetName: activeSet.name,
				columns: [{
					id: 'backlog',
					label: 'Backlog',
					agent: 'None',
					stage: null,
					count: 2,
					cards: [
						{
							id: edited.id,
							title: edited.title,
							type: edited.type,
							typeLabel: 'Feature',
							status: edited.status,
							primary: 'accept',
							canSplit: true,
						},
						{
							id: 'TASK-999',
							title: 'Bug card',
							type: 'bug',
							typeLabel: 'Bug',
							status: 'idle',
							primary: 'accept',
							canSplit: true,
						},
					],
				}],
			},
		});
		assert.strictEqual(document.querySelector('.card-title')?.textContent, 'Saved title #123');
		const typeBadges = Array.from(document.querySelectorAll('.card .badge-task-type'));
		assert.deepStrictEqual(typeBadges.map((badge) => badge.textContent), ['Feature', 'Bug']);
		assert.ok(typeBadges[0].classList.contains('feature'));
		assert.ok(typeBadges[1].classList.contains('bug'));
		assert.strictEqual(typeBadges[0].getAttribute('title'), 'Task type: Feature');
		assert.strictEqual(typeBadges[1].getAttribute('title'), 'Task type: Bug');
		assert.strictEqual(typeBadges[0].getAttribute('aria-label'), 'Task type: Feature');
		assert.strictEqual(typeBadges[1].getAttribute('aria-label'), 'Task type: Bug');
		const cardLabels = Array.from(document.querySelectorAll('.card')).map((card) => card.getAttribute('aria-label'));
		assert.ok(cardLabels[0]?.includes('Type: Feature.'));
		assert.ok(cardLabels[1]?.includes('Type: Bug.'));
		assert.match(panel.webview.html, /\.badge-task-type\.bug \{ border-style: dashed; \}/);
		assert.strictEqual(document.querySelector('#detail .modal-title')?.textContent, 'Saved title #123');
		assert.strictEqual(document.querySelector('#detail .modal-section-body')?.textContent, 'Saved request with Markdown');

		dispatchWebviewMessage(dom, { type: 'task/detail', task: detailViewFor(edited, false) });
		const unavailable = Array.from(document.querySelectorAll('button'))
			.find((button) => button.textContent === 'Editing unavailable while running');
		assert.ok(unavailable);
		assert.strictEqual((unavailable as unknown as { disabled: boolean }).disabled, true);
		assert.strictEqual(document.getElementById('taskEditForm'), null);
	} finally {
		dom?.window.close();
		board.dispose();
		try {
			await vscode.workspace.fs.delete(directory, { recursive: true });
		} catch {
			/* already gone */
		}
	}
	});

	test('defines the same four gate rows used by the Settings protocol', () => {
		assert.deepStrictEqual(
			GATES.map((gate) => gate.key),
			['backlogToRefine', 'scopedToApproved', 'approvedToInProgress', 'validationAutoStart'],
		);
	});
});
