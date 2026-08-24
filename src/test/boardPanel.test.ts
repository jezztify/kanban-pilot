import * as assert from 'assert';
import * as fs from 'node:fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { JSDOM } from 'jsdom';

import {
	ALL_KANBAN_SETTING_KEYS,
	BoardPanel,
	BoardTaskSetHost,
	GATES,
	isAgentColumn,
	isAgentNameValue,
	isEditableSettingKey,
	isGateKey,
	persistAgentNameOverride,
	persistAgentNameOverrides,
	persistGateSetting,
	persistSetting,
	resetSetting,
	SETTINGS_COLUMNS,
	SETTING_DEFINITIONS,
	settingsStateFor,
	settingsValuesFor,
	renderTaskMarkdown,
	primaryAction,
	updateAgentNameOverrides,
	validateSettingValue,
} from '../board/boardPanel';
import { Executor } from '../chat/executor';
import { RunManager } from '../chat/runManager';
import { formatReceipt } from '../chat/receipt';
import { DEFAULT_TASK_SET_ID, DEFAULT_TASK_SET_NAME, TaskSet } from '../model/taskSets';
import {
	encodePendingOutcome,
	parseTaskDetailSections,
	taskAttachmentReference,
	taskFromRaw,
	newTaskFile,
} from '../model/task';
import { TaskStore } from '../model/taskStore';

const noopExecutor: Executor = {
	async isAvailable() {
		return false;
	},
	async run() {
		return { ok: false, error: 'unused in Settings tests' };
	},
};

const extensionRootForTests = path.resolve(__dirname, '..', '..');
const extensionUriForTests = vscode.Uri.file(extensionRootForTests);

type MermaidBridgeForTests = {
	render(root: unknown, styleNonce?: string): Promise<void>;
};

function loadMermaidBundles(dom: JSDOM): MermaidBridgeForTests {
	type SvgMeasureNode = { textContent: string | null };
	type SvgPrototype = {
		getBBox(this: SvgMeasureNode): { x: number; y: number; width: number; height: number };
		getComputedTextLength(this: SvgMeasureNode): number;
	};
	const svgPrototype = dom.window.SVGElement.prototype as unknown as SvgPrototype;
	const textWidth = (node: SvgMeasureNode): number => Math.max(8, (node.textContent || '').length * 8);
	svgPrototype.getBBox = function (this: SvgMeasureNode) {
		return { x: 0, y: 0, width: textWidth(this), height: 20 };
	};
	svgPrototype.getComputedTextLength = function (this: SvgMeasureNode) {
		return textWidth(this);
	};

	for (const filename of ['mermaid-runtime.js', 'mermaid-webview.js']) {
		vm.runInContext(
			fs.readFileSync(path.join(extensionRootForTests, 'dist', filename), 'utf8'),
			dom.getInternalVMContext(),
		);
	}
	const bridge = (dom.window as unknown as { kanbanPilotMermaid?: MermaidBridgeForTests }).kanbanPilotMermaid;
	assert.ok(bridge, 'the local Mermaid bridge must initialize');
	return bridge;
}

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
	attachments?: readonly {
		name: string;
		relativePath: string;
		mimeType: string;
		size: number;
		src: string;
	}[];
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
		requestHtml: renderTaskMarkdown(task.sections.Request ?? '', task.attachments ?? []),
		refinedHtml: renderTaskMarkdown(task.sections.Refined ?? '', task.attachments ?? []),
		scopeHtml: renderTaskMarkdown(task.sections.Scope ?? '', task.attachments ?? []),
		lastLog: task.sections.Log ?? '',
		attachments: task.attachments ?? [],
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

async function seedStaleBoardCandidate(store: TaskStore, taskId: string, runId: string): Promise<void> {
	await store.patch(taskId, { state: 'in-progress', status: 'failed' });
	await store.auditedPatch(taskId, { state: 'in-progress', status: 'failed' }, {
		action: 'develop',
		runId,
		events: [{ kind: 'activity-start', stage: 'develop', action: 'develop', runId }],
	});
	await store.appendLog(taskId, formatReceipt({
		runId,
		taskId,
		stage: 'develop',
		result: 'failed',
		note: 'timed out; awaiting late receipt',
	}));
	await store.auditedPatch(taskId, { status: 'failed', run: undefined }, {
		action: 'timeout',
		runId,
		outcome: 'timeout',
		events: [{
			kind: 'activity-finish',
			runId,
			stage: 'develop',
			outcome: 'timeout',
			provisional: true,
			note: 'Activity timed out; awaiting late receipt.',
		}],
	});
	await store.appendLog(taskId, formatReceipt({
		runId,
		taskId,
		stage: 'develop',
		result: 'ok',
		note: 'implementation finished in the earlier run',
	}));
}

suite('BoardPanel Settings', () => {
	test('renders task detail Markdown as safe CommonMark/GFM HTML', () => {
		const source = [
			'# Heading',
			'',
			'## Subheading',
			'',
			'Paragraph with **strong**, *emphasis*, ~~deleted~~, and `inline`.',
			'Preserved as a visible soft line break.',
			'',
			'- parent',
			'  - nested child',
			'- [ ] open item',
			'- [x] completed item',
			'',
			'> quoted requirement',
			'',
			'---',
			'',
			'| Name | Value |',
			'| :--- | ---: |',
			'| alpha | 42 |',
			'',
			'```ts',
			'const value = "<literal>";',
			'```',
			'',
			'[safe link](https://example.com/docs) [unsafe link](javascript:alert(1))',
			'',
			'<script>alert(1)</script>',
			'',
			'![valid](TASK-001.attachments/valid.png)',
			'![missing](TASK-001.attachments/missing.png)',
			'![cross-task](TASK-999.attachments/other.png)',
			'![remote](https://example.com/remote.png)',
		].join('\n');
		const html = renderTaskMarkdown(source, [{
			relativePath: 'TASK-001.attachments/valid.png',
			src: 'vscode-webview-resource://valid.png',
		}]);
		const dom = new JSDOM('<div id="markdown">' + html + '</div>');
		const root = dom.window.document.getElementById('markdown');
		assert.ok(root);
		assert.strictEqual(root.querySelector('h1')?.textContent, 'Heading');
		assert.strictEqual(root.querySelector('h2')?.textContent, 'Subheading');
		assert.strictEqual(root.querySelector('strong')?.textContent, 'strong');
		assert.strictEqual(root.querySelector('em')?.textContent, 'emphasis');
		assert.strictEqual(root.querySelector('s')?.textContent, 'deleted');
		assert.strictEqual(root.querySelector('code')?.textContent, 'inline');
		assert.strictEqual(root.querySelectorAll('ul').length >= 2, true, 'nested unordered lists render');
		assert.strictEqual(root.querySelectorAll('.task-list-item').length, 2);
		assert.strictEqual(root.querySelectorAll('.task-list-item-checkbox').length, 2);
		assert.strictEqual(
			Array.from(root.querySelectorAll('.task-list-item-checkbox')).every((input) => (
				(input as HTMLInputElement).disabled
			)),
			true,
		);
		assert.strictEqual(root.querySelector('blockquote')?.textContent?.trim(), 'quoted requirement');
		assert.ok(root.querySelector('hr'));
		assert.strictEqual(root.querySelectorAll('table tbody tr').length, 1);
		assert.strictEqual(root.querySelector('table th')?.textContent, 'Name');
		assert.strictEqual(root.querySelector('.modal-code-block code')?.textContent, 'const value = "<literal>";\n');
		assert.ok(root.querySelector('.modal-code-block code.language-ts'));
		assert.strictEqual(root.querySelector('a')?.getAttribute('href'), 'https://example.com/docs');
		assert.strictEqual(root.querySelectorAll('a').length, 1, 'unsafe links are not actionable');
		assert.strictEqual(root.querySelector('script'), null, 'raw HTML cannot create executable elements');
		assert.match(root.textContent ?? '', /<script>alert\(1\)<\/script>/);
		assert.strictEqual(root.querySelectorAll('.task-image').length, 1);
		assert.strictEqual(root.querySelectorAll('.task-image-placeholder').length, 3);
		assert.strictEqual(root.querySelector('.task-image')?.getAttribute('alt'), 'valid');
		assert.strictEqual(source.includes('**strong**'), true, 'source Markdown remains unchanged for editing');
		dom.window.close();
	});

	test('classifies Mermaid fences in all editable sections without changing ordinary Markdown', () => {
		const sections = {
			Request: [
				'# Request',
				'',
				'Before the request chart.',
				'',
				'```mermaid',
				'flowchart TD',
				'  Request --> Review',
				'```',
				'',
				'```ts',
				'const value = 1;',
				'```',
				'',
				'After the request chart.',
			].join('\n'),
			Refined: [
				'## Refined',
				'',
				'```MERMAID',
				'sequenceDiagram',
				'  participant User',
				'  participant Board',
				'  User->>Board: Select task',
				'```',
			].join('\n'),
			Scope: [
				'## Scope',
				'',
				'- preserve the task source',
				'',
				'```mermaid',
				'flowchart LR',
				'  Edit --> Save',
				'```',
			].join('\n'),
		};
		const html = Object.entries(sections)
			.map(([label, source]) => '<section id="' + label.toLowerCase() + '">' + renderTaskMarkdown(source) + '</section>')
			.join('');
		const dom = new JSDOM(html);
		const root = dom.window.document.body;
		const diagrams = Array.from(root.querySelectorAll('[data-mermaid-diagram]'));
		assert.strictEqual(diagrams.length, 3);
		assert.strictEqual(root.querySelectorAll('.modal-code-block code.language-ts').length, 1);
		assert.strictEqual(root.querySelector('#request h1')?.textContent, 'Request');
		assert.strictEqual(root.querySelector('#refined h2')?.textContent, 'Refined');
		assert.strictEqual(root.querySelector('#scope h2')?.textContent, 'Scope');
		assert.match(root.textContent ?? '', /Before the request chart/);
		assert.match(root.textContent ?? '', /After the request chart/);
		assert.match(diagrams[0]?.querySelector('.modal-mermaid-source')?.textContent ?? '', /flowchart TD/);
		assert.match(diagrams[1]?.querySelector('.modal-mermaid-source')?.textContent ?? '', /sequenceDiagram/);
		assert.match(diagrams[2]?.querySelector('.modal-mermaid-source')?.textContent ?? '', /flowchart LR/);
		assert.strictEqual(root.querySelectorAll('.modal-mermaid-source').length, 3);
		assert.strictEqual(Object.values(sections).every((source) => source.includes('```mermaid') || source.includes('```MERMAID')), true);
		dom.window.close();
	});

	test('renders flowchart and sequence diagrams through the packaged local Mermaid bridge', async () => {
		const sections = [
			['Request', ['flowchart TD', '  Request --> Review']],
			['Refined', ['sequenceDiagram', '  participant User', '  participant Board', '  User->>Board: Select task']],
			['Scope', ['flowchart LR', '  Edit --> Save']],
		] as const;
		const html = sections.map(([label, source]) => (
			'<section data-section="' + label + '">' + renderTaskMarkdown('```mermaid\n' + source.join('\n') + '\n```') + '</section>'
		)).join('');
		const dom = new JSDOM('<main id="detail">' + html + '</main>', {
			runScripts: 'outside-only',
			pretendToBeVisual: true,
		});
		try {
			const bridge = loadMermaidBundles(dom);
			const root = dom.window.document.getElementById('detail');
			assert.ok(root);
			await bridge.render(root, 'test-nonce');

			const diagrams = Array.from(root.querySelectorAll('[data-mermaid-diagram]'));
			assert.deepStrictEqual(diagrams.map((diagram) => diagram.getAttribute('data-mermaid-state')), [
				'rendered',
				'rendered',
				'rendered',
			]);
			assert.strictEqual(root.querySelectorAll('.modal-mermaid-rendered svg').length, 3);
			assert.strictEqual(root.querySelectorAll('.modal-mermaid-source').length, 0);
			assert.ok(root.querySelector('.modal-mermaid-rendered svg.flowchart'));
			assert.ok(root.querySelector('.modal-mermaid-rendered svg[aria-roledescription="sequence"]'));
		} finally {
			dom.window.close();
		}
	});

	test('isolates invalid Mermaid, removes unsafe generated references, and re-renders replacement content', async () => {
		const valid = ['flowchart TD', '  A --> B'];
		const invalid = ['flowchart TD', '  A -->'];
		const remoteLink = ['flowchart TD', '  A --> B', '  click A "https://example.com"'];
		const source = [
			'Before all charts.',
			'',
			'```mermaid',
			...valid,
			'```',
			'',
			'```mermaid',
			...invalid,
			'```',
			'',
			'```mermaid',
			...remoteLink,
			'```',
			'',
			'After all charts.',
		].join('\n');
		const dom = new JSDOM('<main id="detail">' + renderTaskMarkdown(source) + '</main>', {
			runScripts: 'outside-only',
			pretendToBeVisual: true,
		});
		try {
			const bridge = loadMermaidBundles(dom);
			const root = dom.window.document.getElementById('detail');
			assert.ok(root);
			await bridge.render(root, 'test-nonce');

			const diagrams = Array.from(root.querySelectorAll('[data-mermaid-diagram]'));
			assert.deepStrictEqual(diagrams.map((diagram) => diagram.getAttribute('data-mermaid-state')), [
				'rendered',
				'error',
				'rendered',
			]);
			assert.match(diagrams[1]?.querySelector('.modal-mermaid-source')?.textContent ?? '', /flowchart TD/);
			assert.match(diagrams[1]?.querySelector('.modal-mermaid-message')?.textContent ?? '', /could not be rendered/);
			assert.match(root.textContent ?? '', /Before all charts/);
			assert.match(root.textContent ?? '', /After all charts/);
			const renderedMarkup = diagrams[2]?.querySelector('.modal-mermaid-rendered')?.innerHTML ?? '';
			assert.doesNotMatch(renderedMarkup, /(?:href|xlink:href)=["']https?:/i);
			assert.doesNotMatch(renderedMarkup, /<(?:script|foreignobject|iframe|object|embed|image|link)\b/i);

			root.innerHTML = renderTaskMarkdown([
				'Replacement content.',
				'',
				'```mermaid',
				'sequenceDiagram',
				'  A->>B: Re-rendered',
				'```',
			].join('\n'));
			await bridge.render(root, 'test-nonce');
			assert.strictEqual(root.querySelectorAll('[data-mermaid-diagram]').length, 1);
			assert.strictEqual(root.querySelector('[data-mermaid-diagram]')?.getAttribute('data-mermaid-state'), 'rendered');
			assert.strictEqual(root.querySelectorAll('.modal-mermaid-message').length, 0);
			assert.strictEqual(root.querySelectorAll('.modal-mermaid-rendered svg').length, 1);
			assert.match(root.textContent ?? '', /Replacement content/);
		} finally {
			dom.window.close();
		}
	});

	test('task detail extraction keeps authored h1 and h2 Markdown inside Request', () => {
		const raw = newTaskFile('TASK-001', 'Heading task', {
			request: '# H1\n\n## H2\nH2 content',
		});
		const task = taskFromRaw(raw);
		assert.ok(task);

		const sections = parseTaskDetailSections(task.body);
		assert.strictEqual(sections.Request, '# H1\n\n## H2\nH2 content');
		const dom = new JSDOM('<div id="markdown">' + renderTaskMarkdown(sections.Request) + '</div>');
		const root = dom.window.document.getElementById('markdown');
		assert.strictEqual(root?.querySelector('h1')?.textContent, 'H1');
		assert.strictEqual(root?.querySelector('h2')?.textContent, 'H2');
		assert.strictEqual(root?.textContent?.includes('H2 content'), true);
		dom.window.close();
	});

	test('failed timeout cards keep their normal retry action', () => {
		assert.strictEqual(primaryAction('refine', 'failed'), 'refine');
		assert.strictEqual(primaryAction('in-progress', 'failed'), 'continue');
		assert.strictEqual(primaryAction('validation', 'failed'), 'validate');
	});

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
			[{ name: 'Queue Keeper', description: 'Handles the queue', source: 'workspace' }],
		);
		assert.deepStrictEqual(state.gates, { backlogToRefine: 'auto', scopedToApproved: 'manual' });
		assert.deepStrictEqual(state.availableAgents, [
			{ name: 'Queue Keeper', description: 'Handles the queue', source: 'workspace' },
		]);
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

	test('keeps the in-board catalog aligned with all 24 contributed keys', () => {
		assert.strictEqual(ALL_KANBAN_SETTING_KEYS.length, 24);
		assert.deepStrictEqual([...SETTING_DEFINITIONS].map((definition) => definition.key), [...ALL_KANBAN_SETTING_KEYS]);
		assert.strictEqual(isEditableSettingKey('chat.agentNames'), true);
		assert.strictEqual(isEditableSettingKey('kanbanPilot.chat.mode'), false);
		assert.strictEqual(validateSettingValue('chat.mode', 'ask').ok, true);
		assert.strictEqual(validateSettingValue('chat.mode', 'invalid').ok, false);
		assert.strictEqual(validateSettingValue('tasksDir', '.kanban-pilot/tasks').ok, true);
		assert.strictEqual(validateSettingValue('tasksDir', '../outside').ok, false);
		assert.strictEqual(validateSettingValue('tasksDir', 'C:\\outside').ok, false);
		assert.strictEqual(validateSettingValue('run.timeoutMinutes', 0).ok, false);
		assert.strictEqual(validateSettingValue('run.timeoutMinutes', 2.5).ok, true);
		assert.strictEqual(validateSettingValue('run.maxParallelTasks', 0).ok, false);
		assert.strictEqual(validateSettingValue('run.maxParallelTasks', 1.5).ok, false);
		assert.strictEqual(validateSettingValue('refine.toolsInclude', ['search', 'edit']).ok, true);
		assert.strictEqual(validateSettingValue('refine.toolsInclude', ['search\nedit']).ok, false);
		assert.strictEqual(validateSettingValue('chat.modelSelector', { id: 'gpt', vendor: 'copilot' }).ok, true);
		assert.strictEqual(validateSettingValue('chat.modelSelector', { unknown: 'value' }).ok, false);
		assert.strictEqual(validateSettingValue('chat.agentNames', { refine: 'Custom Refiner' }).ok, true);
		assert.strictEqual(validateSettingValue('chat.agentNames', { unknown: 'Agent' }).ok, false);

		const values = settingsValuesFor({
			get<T>(key: string, fallback?: T): T | undefined {
				if (key === 'chat.mode') { return 'ask' as T; }
				if (key === 'run.maxParallelTasks') { return 3 as T; }
				if (key === 'chat.toolsExclude') { return ['memory'] as T; }
				return fallback;
			},
		} as Pick<vscode.WorkspaceConfiguration, 'get'>);
		assert.strictEqual(values['chat.mode'], 'ask');
		assert.strictEqual(values['run.maxParallelTasks'], 3);
		assert.deepStrictEqual(values['chat.toolsExclude'], ['memory']);
		assert.strictEqual(values['chat.closeTabOnDone'], true);
	});

	test('persists validated settings at workspace scope and resets without writing invalid payloads', async () => {
		const writes: { key: string; value: unknown; target: vscode.ConfigurationTarget }[] = [];
		const configuration = {
			async update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				writes.push({ key, value, target });
			},
		};

		const valid = await persistSetting(configuration, 'chat.toolsExclude', ['memory', 'resolveMemoryFileUri']);
		assert.strictEqual(valid.ok, true);
		assert.deepStrictEqual(writes[0], {
			key: 'chat.toolsExclude',
			value: ['memory', 'resolveMemoryFileUri'],
			target: vscode.ConfigurationTarget.Workspace,
		});
		const invalid = await persistSetting(configuration, 'run.maxParallelTasks', 0);
		assert.strictEqual(invalid.ok, false);
		assert.strictEqual(writes.length, 1);
		assert.strictEqual(await resetSetting(configuration, 'chat.toolsExclude'), true);
		assert.deepStrictEqual(writes[1], {
			key: 'chat.toolsExclude',
			value: undefined,
			target: vscode.ConfigurationTarget.Workspace,
		});
		assert.strictEqual(await resetSetting(configuration, 'not-a-setting'), false);
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

	test('persists all agent assignments in one atomic workspace write', async () => {
		const writes: { key: string; value: unknown; target: vscode.ConfigurationTarget }[] = [];
		const configuration = {
			async update(key: string, value: unknown, target: vscode.ConfigurationTarget) {
				writes.push({ key, value, target });
			},
		};

		await persistAgentNameOverrides(configuration, { develop: 'Legacy Coder', validate: 'Legacy QA' }, {
			backlog: 'Queue Keeper',
			refine: 'Local Refiner',
			scoped: '',
			approved: '',
			'in-progress': 'Ship It Steve',
			validation: 'Quality Pilot',
			done: '',
		});

		assert.deepStrictEqual(writes, [{
			key: 'chat.agentNames',
			value: {
				backlog: 'Queue Keeper',
				refine: 'Local Refiner',
				'in-progress': 'Ship It Steve',
				validation: 'Quality Pilot',
			},
			target: vscode.ConfigurationTarget.Workspace,
		}]);
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
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
		const onMessage = (board as unknown as { onMessage(message: unknown): Promise<void> }).onMessage.bind(board);
		try {
			const headerMarkup = /<header>([\s\S]*?)<\/header>/.exec(panel.webview.html)?.[0];
			assert.ok(headerMarkup, 'header markup is present');
			let previousControlOffset = -1;
			for (const id of [
				'taskSetSelect',
				'taskSetCreate',
				'taskSetRename',
				'taskSetDelete',
				'settingsToggle',
				'newTaskToggle',
			]) {
				const controlOffset = headerMarkup.indexOf(`id="${id}"`);
				assert.ok(controlOffset > previousControlOffset, `${id} remains in header source order`);
				previousControlOffset = controlOffset;
			}
			const stylesheet = /<style[^>]*>([\s\S]*?)<\/style>/.exec(panel.webview.html)?.[1];
			assert.ok(stylesheet, 'inline board stylesheet is present');
			assert.match(stylesheet, /header\s*\{[\s\S]*?min-width:\s*0;/);
			assert.match(stylesheet, /\.header-actions\s*\{[\s\S]*?min-width:\s*0;/);
			assert.match(stylesheet, /\.task-set-controls\s*\{[\s\S]*?min-width:\s*0;/);
			assert.match(stylesheet, /@media\s*\(max-width:\s*620px\)[\s\S]*?header\s*\{[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
			assert.match(stylesheet, /@media\s*\(max-width:\s*620px\)[\s\S]*?\.header-actions\s*\{[\s\S]*?flex:\s*1 1 100%;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
			assert.match(stylesheet, /@media\s*\(max-width:\s*620px\)[\s\S]*?\.task-set-controls\s*\{[\s\S]*?flex:\s*1 1 100%;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\}/);
			assert.match(stylesheet, /@media\s*\(max-width:\s*620px\)[\s\S]*?\.task-set-select\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;[\s\S]*?\}/);
			assert.ok(panel.webview.html.includes('id="settingsToggle"'));
			assert.ok(panel.webview.html.includes('id="settingsBackdrop"'));
			assert.ok(panel.webview.html.includes('settings/state'));
			assert.match(panel.webview.html, /id="settingsCategoryNav"/);
			assert.match(panel.webview.html, /role="tablist"/);
			assert.match(panel.webview.html, /id="settingsCategoryGates"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="settingsPanelGates"/);
			assert.match(panel.webview.html, /id="settingsCategoryAgents"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="settingsPanelAgents"[^>]*tabindex="-1"/);
			assert.match(panel.webview.html, /id="settingsPanelGates"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsCategoryGates"/);
			assert.match(panel.webview.html, /id="settingsPanelAgents"[^>]*role="tabpanel"[^>]*aria-labelledby="settingsCategoryAgents"[^>]*hidden[^>]*aria-hidden="true"/);
			for (const key of ALL_KANBAN_SETTING_KEYS) {
				assert.ok(panel.webview.html.includes(`"key":"${key}"`), `catalog includes ${key}`);
			}
			for (const category of ['Workspace', 'Chat', 'Tools', 'Run', 'Layout']) {
				assert.ok(panel.webview.html.includes(`id="settingsPanel${category}"`));
				assert.ok(panel.webview.html.includes(`id="settingsFields${category}"`));
			}
			assert.match(panel.webview.html, /id="settingsMain"[^>]*role="region"/);
			assert.ok(!panel.webview.html.includes('id="gatesToggle"'));
			assert.ok(!panel.webview.html.includes('id="agentNameModal"'));
			assert.ok(panel.webview.html.includes('taskEditForm'));
			assert.ok(panel.webview.html.includes('task/editError'));
			assert.ok(fs.existsSync(path.join(extensionRootForTests, 'dist', 'mermaid-runtime.js')));
			assert.ok(fs.existsSync(path.join(extensionRootForTests, 'dist', 'mermaid-webview.js')));
			assert.match(panel.webview.html, /<meta http-equiv="Content-Security-Policy" content="[^"]*default-src 'none'/);
			assert.match(panel.webview.html, /<script nonce="[^"]+" data-kanban-pilot-mermaid-runtime src="[^"]*mermaid-runtime\.js"><\/script>/);
			assert.match(panel.webview.html, /<script nonce="[^"]+" data-kanban-pilot-mermaid src="[^"]*mermaid-webview\.js"><\/script>/);
			assert.doesNotMatch(panel.webview.html, /data-kanban-pilot-mermaid(?:-runtime)?[^>]+src="[^"]*(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|raw\.githubusercontent\.com)/i);
			const script = /<script[^>]*data-kanban-pilot-board[^>]*>([\s\S]*)<\/script>/.exec(panel.webview.html)?.[1];
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
			assert.match(script, /document\.createElement\('select'\)/);
			assert.match(script, /availableAgents/);
			assert.match(script, /settings\/refresh/);
			assert.match(script, /SETTING_DEFINITIONS/);
			assert.match(script, /type: 'settings\/set'/);
			assert.match(script, /type: 'settings\/reset'/);
			assert.match(script, /settingControlValue/);
			assert.match(script, /setting-error/);
			assert.match(script, /Reload required after saving or resetting/);
			assert.doesNotMatch(script, /agent-setting-input/);
			assert.match(script, /type: 'gates\/set'/);
			assert.match(script, /type: 'agents\/save'/);
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
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
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
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
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
			dispatchWebviewMessage(dom, {
			type: 'settings/state',
			gates: {},
			agents: {
				backlog: 'None',
				refine: 'Bro Refiner',
				scoped: 'None',
				approved: 'None',
				'in-progress': 'Legacy Coder',
				validation: 'Quality Pilot',
				done: 'None',
			},
			availableAgents: [
				{ name: 'Local Agent', description: 'Workspace agent', source: 'workspace' },
				{ name: 'Quality Pilot', description: 'Checks quality', source: 'user' },
			],
			values: {
				tasksDir: '.kanban-pilot/tasks',
				'chat.mode': 'agent',
				'chat.sessionPrefix': 'kanban-pilot-',
				'chat.closeTabOnDone': true,
				'chat.resetOnApprove': false,
				'refine.toolsInclude': [],
				'chat.toolsExclude': ['memory'],
				'chat.modelSelector': { id: 'gpt', vendor: 'copilot' },
				'run.timeoutMinutes': 20,
				'run.maxParallelTasks': 1,
				'board.openOnStartup': false,
				'layout.dockChat': true,
				'layout.dockChatOnSelect': false,
				'chat.allowTaskProposals': true,
			},
		});
		clickElement(dom.window.document.getElementById('settingsToggle'));
		const settingsDocument = dom.window.document;
		assert.ok(posted.some((message) => (
			message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'settings/refresh'
		)));
		assert.strictEqual(settingsDocument.querySelectorAll('.agent-setting-select').length, 7);
		assert.strictEqual(
			Array.from(settingsDocument.querySelectorAll('#settingsPanelAgents button'))
				.filter((button) => button.textContent === 'Save').length,
			1,
		);
		assert.strictEqual(settingsDocument.querySelectorAll('.agent-setting-actions button').length, 7);
		assert.strictEqual(settingsDocument.querySelectorAll('.setting-row').length, 14);
		assert.strictEqual((settingsDocument.getElementById('setting-chat-toolsExclude') as HTMLTextAreaElement).value, 'memory');
		assert.strictEqual((settingsDocument.getElementById('setting-chat-modelSelector-id') as HTMLInputElement).value, 'gpt');
		const taskDirInput = settingsDocument.getElementById('setting-tasksDir') as HTMLInputElement;
		taskDirInput.value = 'custom/tasks';
		clickElement(settingsDocument.querySelector('#setting-tasksDir-row .setting-actions button'));
		assert.deepStrictEqual(
			JSON.parse(JSON.stringify(posted.filter((message) => (
				message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'settings/set'
			)).at(-1))),
			{ type: 'settings/set', key: 'tasksDir', value: 'custom/tasks' },
		);
		const toolsExclude = settingsDocument.getElementById('setting-chat-toolsExclude') as HTMLTextAreaElement;
		toolsExclude.value = 'memory\nsearch';
		clickElement(settingsDocument.querySelector('#setting-chat-toolsExclude-row .setting-actions button'));
		assert.deepStrictEqual(
			JSON.parse(JSON.stringify(posted.filter((message) => (
				message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'settings/set'
			)).at(-1))),
			{ type: 'settings/set', key: 'chat.toolsExclude', value: ['memory', 'search'] },
		);
		clickElement(settingsDocument.querySelector('#setting-chat-toolsExclude-row .setting-actions button:nth-child(2)'));
		assert.deepStrictEqual(
			JSON.parse(JSON.stringify(posted.filter((message) => (
				message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'settings/reset'
			)).at(-1))),
			{ type: 'settings/reset', key: 'chat.toolsExclude' },
		);
		dispatchWebviewMessage(dom, { type: 'settings/error', key: 'run.maxParallelTasks', error: 'Must be at least 1.' });
		const settingError = settingsDocument.getElementById('setting-run-maxParallelTasks-error');
		assert.strictEqual(settingError?.hidden, false);
		assert.strictEqual(settingError?.textContent, 'Must be at least 1.');
		const refineSelect = settingsDocument.getElementById('agent-select-refine') as HTMLSelectElement;
		assert.strictEqual(refineSelect.value, '');
		assert.strictEqual(refineSelect.options[0]?.textContent, 'Bro Refiner');
		assert.ok(!Array.from(refineSelect.options).some((option) => option.textContent === 'Bro Refiner (current)'));
		const legacySelect = settingsDocument.getElementById('agent-select-in-progress') as HTMLSelectElement;
		assert.strictEqual(legacySelect.value, 'Legacy Coder');
		assert.ok(Array.from(legacySelect.options).some((option) => option.textContent === 'Legacy Coder (current)'));
		refineSelect.value = 'Local Agent';
		clickElement(settingsDocument.querySelector('#agent-setting-refine .agent-setting-actions button'));
		assert.strictEqual(refineSelect.value, '', 'Reset should clear only its column until the shared Save is clicked');

		const expectedAssignments = {
			backlog: 'Local Agent',
			refine: '',
			scoped: 'Quality Pilot',
			approved: '',
			'in-progress': 'Quality Pilot',
			validation: '',
			done: 'Local Agent',
		};
		for (const [column, value] of Object.entries(expectedAssignments)) {
			(settingsDocument.getElementById('agent-select-' + column) as HTMLSelectElement).value = value;
		}
		const beforeAgentSaveMessages = posted.length;
		clickElement(settingsDocument.getElementById('agentSettingsSave'));
		const agentSaveMessage = posted.slice(beforeAgentSaveMessages).find((message) => (
			message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'agents/save'
		));
		assert.deepStrictEqual(
			JSON.parse(JSON.stringify(agentSaveMessage)),
			{ type: 'agents/save', values: expectedAssignments },
		);
		assert.strictEqual(
			posted.slice(beforeAgentSaveMessages).filter((message) => (
				message !== null && typeof message === 'object' && (message as { type?: unknown }).type === 'agentName/set'
			)).length,
			0,
		);

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
		assert.strictEqual(document.querySelector('#detail .modal-section-body')?.textContent?.trim(), 'Saved request\nwith Markdown');

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

	test('renders saved task-local images in detail sections through safe webview URIs', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-images-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-images-test', index: 0 };
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
			'kanbanPilot.boardImagesTest',
			'Kanban Pilot Images Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
		let dom: JSDOM | undefined;
		try {
			const task = await store.create('Saved image detail', {
				request: [
					'![first screenshot](attachment://first)',
					'![second screenshot](attachment://second)',
					'![JPEG evidence](attachment://jpeg)',
					'![GIF evidence](attachment://gif)',
					'![WebP evidence](attachment://webp)',
				].join('\n\n'),
				attachments: {
					add: [
						{
							id: 'first',
							name: 'image.png',
							mimeType: 'image/png',
							data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
						},
						{
							id: 'second',
							name: 'image-2.png',
							mimeType: 'image/png',
							data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
						},
						{
							id: 'jpeg',
							name: 'evidence.jpg',
							mimeType: 'image/jpeg',
							data: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
						},
						{
							id: 'gif',
							name: 'evidence.gif',
							mimeType: 'image/gif',
							data: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
						},
						{
							id: 'webp',
							name: 'evidence.webp',
							mimeType: 'image/webp',
							data: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
						},
					],
				},
			});
			const firstReference = taskAttachmentReference(task.id, 'image.png');
			const secondReference = taskAttachmentReference(task.id, 'image-2.png');
			const jpegReference = taskAttachmentReference(task.id, 'evidence.jpg');
			const gifReference = taskAttachmentReference(task.id, 'evidence.gif');
			const webpReference = taskAttachmentReference(task.id, 'evidence.webp');
			await store.edit(task.id, {
				title: task.title,
				request: `![first screenshot](${firstReference})\n\n![second screenshot](${secondReference})`,
				refined: `![JPEG evidence](${jpegReference})`,
				scope: `![GIF evidence](${gifReference})\n\n![WebP evidence](${webpReference})`,
			});
			const edited = (await store.readAll()).tasks.find((candidate) => candidate.id === task.id);
			assert.ok(edited);
			const saved = await store.listAttachments(task.id);
			assert.deepStrictEqual(saved.map((attachment) => attachment.relativePath), [
				firstReference,
				secondReference,
				jpegReference,
				gifReference,
				webpReference,
			]);
			const attachments = saved.map((attachment) => ({
				name: attachment.name,
				relativePath: attachment.relativePath,
				mimeType: attachment.mimeType,
				size: attachment.size,
				src: panel.webview.asWebviewUri(attachment.uri).toString(),
			}));
			assert.ok(
				attachments.every((attachment) => (
					/^vscode-webview-resource:/i.test(attachment.src) ||
					/^https:\/\/file(?:%2b|\+)\.vscode-resource\.vscode-cdn\.net\//i.test(attachment.src)
				)),
				JSON.stringify(attachments.map((attachment) => attachment.src)),
			);

			dom = new JSDOM(panel.webview.html, {
				runScripts: 'dangerously',
				pretendToBeVisual: true,
				beforeParse(window) {
					Object.defineProperty(window, 'acquireVsCodeApi', {
						value: () => ({ postMessage() {} }),
					});
				},
			});
			dispatchWebviewMessage(dom, { type: 'task/detail', task: detailViewFor({ ...edited, attachments }) });

			const images = Array.from(dom.window.document.querySelectorAll('#detail .task-image'));
			assert.strictEqual(images.length, 5);
			assert.deepStrictEqual(images.map((image) => image.getAttribute('alt')), [
				'first screenshot',
				'second screenshot',
				'JPEG evidence',
				'GIF evidence',
				'WebP evidence',
			]);
			assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image-placeholder').length, 0);
			assert.strictEqual(dom.window.document.querySelectorAll('#detail img[src^="file:"]').length, 0);

			const corruptReference = taskAttachmentReference(task.id, 'corrupt.png');
			const orphanReference = taskAttachmentReference(task.id, 'orphan.png');
			await vscode.workspace.fs.writeFile(
				store.attachmentFileFor(task.id, corruptReference),
				new Uint8Array([0x00, 0x01, 0x02]),
			);
			await vscode.workspace.fs.writeFile(
				store.attachmentFileFor(task.id, orphanReference),
				new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			);
			assert.deepStrictEqual(
				(await store.listAttachments(task.id)).map((attachment) => attachment.relativePath),
				[ firstReference, secondReference, jpegReference, gifReference, webpReference ],
			);

			const unsafeReference = taskAttachmentReference(task.id, 'unsafe.png');
			const unsafeAttachments = [...attachments, {
				name: 'unsafe.png',
				relativePath: unsafeReference,
				mimeType: 'image/png',
				size: 1,
				src: 'https://example.com/unsafe.png',
			}];
			dispatchWebviewMessage(dom, {
				type: 'task/detail',
				task: detailViewFor({
					...edited,
					sections: {
						...edited.sections,
						Request: [
							`![valid](${firstReference})`,
							`![missing](${task.id}.attachments/missing.png)`,
							'![cross-task](TASK-999.attachments/other.png)',
							'![remote](https://example.com/remote.png)',
							`![svg](${task.id}.attachments/vector.svg)`,
							'![malformed](not-an-attachment)',
							`![corrupt](${corruptReference})`,
							`![unmapped](${orphanReference})`,
							`![unsafe URI](${unsafeReference})`,
						].join('\n\n'),
						Refined: '<img src="https://example.com/raw.png">',
						Scope: `![valid WebP](${webpReference})`,
					},
					attachments: unsafeAttachments,
				}),
			});
			assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image').length, 2);
			assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image-placeholder').length, 8);
			assert.strictEqual(dom.window.document.querySelectorAll('#detail img:not(.task-image)').length, 0);

			// Re-rendering the detail view must not retain the previous invalid state.
			dispatchWebviewMessage(dom, { type: 'task/detail', task: detailViewFor({ ...edited, attachments }) });
			assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image').length, 5);
			assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image-placeholder').length, 0);
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

	test('routes detail attachments through the active Default and named task sets', async () => {
		const root = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-task-sets-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const variants: readonly { id: string; name: string; isDefault: boolean; directory: vscode.Uri; fileName: string }[] = [
			{
				id: DEFAULT_TASK_SET_ID,
				name: DEFAULT_TASK_SET_NAME,
				isDefault: true,
				directory: vscode.Uri.joinPath(root, 'default'),
				fileName: 'default.png',
			},
			{
				id: 'set-images',
				name: 'Images',
				isDefault: false,
				directory: vscode.Uri.joinPath(root, 'named'),
				fileName: 'named.png',
			},
		];

		try {
			for (const variant of variants) {
				const store = new TaskStore(variant.directory, variant.id);
				await store.ensureDirectory();
				const task = await store.create(`Active ${variant.name} image`, {
					request: '![active image](attachment://active-image)',
					attachments: {
						add: [{
							id: 'active-image',
							name: variant.fileName,
							mimeType: 'image/png',
							data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
						}],
					},
				});
				const saved = await store.listAttachments(task.id);
				assert.deepStrictEqual(saved.map((attachment) => attachment.name), [variant.fileName]);

				const activeSet: TaskSet = {
					id: variant.id,
					name: variant.name,
					directory: variant.directory,
					isDefault: variant.isDefault,
				};
				const folder: vscode.WorkspaceFolder = { uri: variant.directory, name: variant.name, index: 0 };
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
					'kanbanPilot.boardTaskSetImagesTest',
					`Kanban Pilot ${variant.name} Images Test`,
					vscode.ViewColumn.One,
					{ enableScripts: true },
				);
				const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
				const board = new constructor(panel, host, extensionUriForTests);
				let dom: JSDOM | undefined;
				try {
					assert.deepStrictEqual(
						panel.webview.options.localResourceRoots?.map((uri) => uri.toString()),
						[extensionUriForTests.toString(), variant.directory.toString()],
					);
					const attachments = saved.map((attachment) => ({
						name: attachment.name,
						relativePath: attachment.relativePath,
						mimeType: attachment.mimeType,
						size: attachment.size,
						src: panel.webview.asWebviewUri(attachment.uri).toString(),
					}));
					dom = new JSDOM(panel.webview.html, {
						runScripts: 'dangerously',
						pretendToBeVisual: true,
						beforeParse(window) {
							Object.defineProperty(window, 'acquireVsCodeApi', {
								value: () => ({ postMessage() {} }),
							});
						},
					});
					dispatchWebviewMessage(dom, { type: 'task/detail', task: detailViewFor({
						...task,
						sections: { Request: `![active image](${saved[0]!.relativePath})` },
						attachments,
					}) });
					assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image').length, 1);
					assert.strictEqual(dom.window.document.querySelectorAll('#detail .task-image-placeholder').length, 0);
					assert.strictEqual(dom.window.document.querySelector('#detail .task-image')?.getAttribute('alt'), 'active image');
					assert.strictEqual(dom.window.document.querySelectorAll('#detail img[src^="file:"]').length, 0);
				} finally {
					dom?.window.close();
					board.dispose();
				}
			}
		} finally {
			try {
				await vscode.workspace.fs.delete(root, { recursive: true });
			} catch {
				/* already gone */
			}
		}
	});

	test('captures pasted images in the New Task description without intercepting text', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-paste-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-paste-test', index: 0 };
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
			'kanbanPilot.boardPasteTest',
			'Kanban Pilot Paste Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
		let dom: JSDOM | undefined;
		try {
			dom = new JSDOM(panel.webview.html, {
				runScripts: 'dangerously',
				pretendToBeVisual: true,
				beforeParse(window) {
					Object.defineProperty(window, 'acquireVsCodeApi', {
						value: () => ({
							postMessage() {},
						}),
					});
				},
			});
			dispatchWebviewMessage(dom, { type: 'newTask/open' });
			const description = dom.window.document.getElementById('newTaskDescription') as HTMLTextAreaElement;
			const shelf = dom.window.document.getElementById('newTaskAttachments');
			assert.ok(shelf);
			description.focus();

			const dispatchPaste = (item: { kind: string; type: string; getAsFile(): unknown }) => {
				const event = new dom!.window.Event('paste', { bubbles: true, cancelable: true });
				Object.defineProperty(event, 'clipboardData', { value: { items: [item] } });
				description.dispatchEvent(event);
				return event;
			};
			const flushFileReader = async (expectedAttachments: number) => {
				const deadline = Date.now() + 1000;
				while (shelf.querySelectorAll('.attachment-card').length < expectedAttachments) {
					if (Date.now() > deadline) {
						throw new Error('Timed out waiting for pasted image attachment');
					}
					await new Promise<void>((resolve) => dom!.window.setTimeout(resolve, 0));
				}
			};

			const firstFile = new dom.window.File(['first image'], 'first.png', { type: 'image/png' });
			const firstPaste = dispatchPaste({
				kind: 'file',
				type: firstFile.type,
				getAsFile: () => firstFile,
			});
			assert.strictEqual(firstPaste.defaultPrevented, true);
			await flushFileReader(1);
			assert.strictEqual(shelf.querySelectorAll('.attachment-card').length, 1);
			assert.match(description.value, /!\[first\.png\]\(attachment:\/\/image-[^)]+\)/);
			assert.strictEqual(shelf.querySelector('img')?.getAttribute('src')?.startsWith('data:image/png;base64,'), true);

			const clipboardTypedFile = new dom.window.File(['clipboard image'], 'clipboard.png', { type: '' });
			const clipboardTypedPaste = dispatchPaste({
				kind: 'file',
				type: 'image/png',
				getAsFile: () => clipboardTypedFile,
			});
			assert.strictEqual(clipboardTypedPaste.defaultPrevented, true);
			await flushFileReader(2);
			assert.strictEqual(shelf.querySelectorAll('.attachment-card').length, 2);
			assert.match(description.value, /!\[clipboard\.png\]\(attachment:\/\/image-[^)]+\)/);
			assert.strictEqual(shelf.querySelectorAll('img')[1]?.getAttribute('src')?.startsWith('data:image/png;base64,'), true);

			const clipboardPng = new dom.window.File(['converted clipboard image'], 'clipboard.png', { type: 'image/png' });
			Object.defineProperty(dom.window.navigator, 'clipboard', {
				configurable: true,
				value: {
					read: async () => [{
						types: ['image/tiff', 'image/png'],
						getType: async (type: string) => {
							assert.strictEqual(type, 'image/png');
							return clipboardPng;
						},
					}],
				},
			});
			const tiffPaste = dispatchPaste({
				kind: 'file',
				type: 'image/png',
				getAsFile: () => null,
			});
			assert.strictEqual(tiffPaste.defaultPrevented, true);
			await flushFileReader(3);
			assert.strictEqual(shelf.querySelectorAll('.attachment-card').length, 3);
			assert.match(description.value, /!\[clipboard\.png\]\(attachment:\/\/image-[^)]+\)/);
			assert.strictEqual(shelf.querySelectorAll('img')[2]?.getAttribute('src')?.startsWith('data:image/png;base64,'), true);

			const secondFile = new dom.window.File(['second image'], 'second.png', { type: 'image/png' });
			dispatchPaste({
				kind: 'file',
				type: secondFile.type,
				getAsFile: () => secondFile,
			});
			await flushFileReader(4);
			assert.strictEqual(shelf.querySelectorAll('.attachment-card').length, 4);
			assert.match(description.value, /!\[second\.png\]\(attachment:\/\/image-[^)]+\)/);

			description.value = 'Keep this text';
			description.addEventListener('paste', (event) => {
				if (!event.defaultPrevented) {
					description.value += ' pasted text';
				}
			});
			const textPaste = dispatchPaste({
				kind: 'string',
				type: 'text/plain',
				getAsFile: () => null,
			});
			assert.strictEqual(textPaste.defaultPrevented, false);
			assert.strictEqual(shelf.querySelectorAll('.attachment-card').length, 4);
			assert.strictEqual(description.value, 'Keep this text pasted text');
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

	test('defines the same nine gate rows used by the Settings protocol', () => {
		assert.deepStrictEqual(
			GATES.map((gate) => gate.key),
			[
				'backlogToRefine',
				'refineToScoped',
				'scopedToApproved',
				'approvedToInProgress',
				'developToValidation',
				'validationAutoStart',
				'validateToDone',
				'validateFailedToInProgress',
				'splitToDone',
			],
		);
	});

	test('projects and renders pending completion with an accessible apply action', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-pending-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-pending-test', index: 0 };
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
			'kanbanPilot.boardPendingTest',
			'Kanban Pilot Pending Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
		let dom: JSDOM | undefined;
		try {
			const task = await store.create('Pending Develop completion');
			await store.patch(task.id, {
				state: 'in-progress',
				status: 'idle',
				pending_outcome: encodePendingOutcome({
					gate: 'developToValidation',
					stage: 'develop',
					result: 'ok',
					runId: 'r-pending',
				}),
			});

			const toView = (board as unknown as {
				toView(snapshot: unknown, agentNames: unknown, taskSets: unknown[]): unknown;
			}).toView.bind(board);
			const projected = toView(await store.snapshot(), {}, [activeSet]) as {
				columns: { id: string; cards: { id: string; pending?: { gate: string; label: string; stage: string; result: string; runId: string } }[] }[];
			};
			const projectedCard = projected.columns.find((column) => column.id === 'in-progress')?.cards
				.find((card) => card.id === task.id);
			assert.deepStrictEqual(projectedCard?.pending, {
				gate: 'developToValidation',
				label: 'Develop → Validation',
				description: 'Commit a successful Develop receipt into Validation automatically.',
				stage: 'develop',
				result: 'ok',
				runId: 'r-pending',
			});

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
			const pendingView = projectedCard?.pending;
			assert.ok(pendingView);
			dispatchWebviewMessage(dom, {
				type: 'board/state',
				selectedTaskId: task.id,
				snapshot: {
					malformed: [],
					taskSets: [{ id: activeSet.id, name: activeSet.name, isDefault: true }],
					activeTaskSetId: activeSet.id,
					activeTaskSetName: activeSet.name,
					columns: [{
						id: 'in-progress',
						label: 'In Progress',
						agent: 'Bro Coder',
						stage: 'develop',
						count: 1,
						cards: [{
							id: task.id,
							title: task.title,
							type: 'feature',
							typeLabel: 'Feature',
							status: 'idle',
							primary: 'continue',
							pending: pendingView,
							canSplit: false,
						}],
					}],
				},
			});
			const card = dom.window.document.querySelector('.card');
			assert.strictEqual(card?.querySelector('.status-text.pending')?.textContent, 'Review Required');
			assert.strictEqual(card?.querySelector('.status-text.pending')?.getAttribute('aria-label'), 'Review required: Develop → Validation');
			assert.match(card?.getAttribute('aria-label') ?? '', /Review required: Develop → Validation/);

			dispatchWebviewMessage(dom, {
				type: 'task/detail',
				task: {
					id: task.id,
					title: task.title,
					type: 'feature',
					typeLabel: 'Feature',
					state: 'in-progress',
					stateLabel: 'In Progress',
					status: 'idle',
					canEdit: true,
					request: '',
					refined: '',
					scope: '',
					lastLog: '',
					pending: pendingView,
					moveTargets: [{ id: 'in-progress', label: 'In Progress' }],
					secondary: null,
				},
			});
			const applyButton = Array.from(dom.window.document.querySelectorAll('button'))
				.find((button) => button.textContent === 'Apply Develop → Validation');
			assert.ok(applyButton);
			assert.strictEqual(applyButton?.getAttribute('aria-label'), 'Apply pending completion: Develop → Validation');
			clickElement(applyButton);
			assert.deepStrictEqual(
				JSON.parse(JSON.stringify(posted.at(-1))),
				{ type: 'pending/apply', taskId: task.id },
			);
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

	test('projects stale completions with accessible recovery and rejects forged host messages', async () => {
		const directory = vscode.Uri.file(
			path.join(os.tmpdir(), `kanban-pilot-board-stale-${Date.now()}-${Math.random().toString(36).slice(2)}`),
		);
		const store = new TaskStore(directory);
		await store.ensureDirectory();
		const folder: vscode.WorkspaceFolder = { uri: directory, name: 'board-stale-test', index: 0 };
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
			'kanbanPilot.boardStaleTest',
			'Kanban Pilot Stale Test',
			vscode.ViewColumn.One,
			{ enableScripts: true },
		);
		const constructor = BoardPanel as unknown as new (panel: vscode.WebviewPanel, host: BoardTaskSetHost, extensionUri: vscode.Uri) => BoardPanel;
		const board = new constructor(panel, host, extensionUriForTests);
		const onMessage = (board as unknown as { onMessage(message: unknown): Promise<void> }).onMessage.bind(board);
		let dom: JSDOM | undefined;
		try {
			const task = await store.create('Recover from the board');
			await seedStaleBoardCandidate(store, task.id, 'r-board-old');
			const candidate = (await runManager.listStaleCompletionCandidates(task.id))[0];
			assert.ok(candidate);

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
			dispatchWebviewMessage(dom, {
				type: 'task/detail',
				task: {
					id: task.id,
					title: task.title,
					type: 'bug',
					typeLabel: 'Bug',
					state: 'in-progress',
					stateLabel: 'In Progress',
					status: 'failed',
					canEdit: true,
					request: '',
					refined: '',
					scope: '',
					lastLog: candidate.summary,
					staleCompletions: [candidate],
					moveTargets: [{ id: 'in-progress', label: 'In Progress' }],
					secondary: null,
				},
			});

			const recoveryButton = dom.window.document.querySelector(
				'button[aria-label="Recover stale develop completion from run r-board-old"]',
			);
			assert.ok(recoveryButton);
			assert.strictEqual(recoveryButton?.textContent, 'Recover develop completion');
			assert.match(recoveryButton?.getAttribute('title') ?? '', /Old run r-board-old/);
			clickElement(recoveryButton);
			assert.deepStrictEqual(JSON.parse(JSON.stringify(posted.at(-1))), {
				type: 'stale/recover',
				taskId: task.id,
				runId: 'r-board-old',
				stage: 'develop',
			});

			const before = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(task.id))).toString('utf8');
			await onMessage({ type: 'stale/recover', taskId: task.id, runId: 'r-board-old!', stage: 'develop' });
			await onMessage({ type: 'stale/recover', taskId: task.id, runId: 'r-board-old', stage: 'deploy' });
			const after = Buffer.from(await vscode.workspace.fs.readFile(store.fileFor(task.id))).toString('utf8');
			assert.strictEqual(after, before, 'forged task-boundary messages must not mutate the task');
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
});
