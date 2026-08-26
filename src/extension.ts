import * as vscode from 'vscode';
import { deleteTask, pickTaskFor } from './board/actions';
import { BoardPanel, BoardTaskSetChange } from './board/boardPanel';
import { TaskAction } from './board/stateMachine';
import { ChatSessionExecutor, OutboundPayloadSeam } from './chat/executor';
import { normalizeMaxParallelTasks, RunManager, StaleCompletionCandidate } from './chat/runManager';
import { isTaskType, TaskType } from './model/task';
import { DEFAULT_TASK_SET_ID, TaskSet, TaskSetError, TaskSetRegistry } from './model/taskSets';
import { TaskStore, TaskStoreChange } from './model/taskStore';
import { endpointConnectionUrl, httpEndpointConfig, isNonLoopbackBindAddress, RealtimeBoardServer, startRealtimeBoardServer } from './http/realtimeBoardServer';
import { showEndpointSharePanel } from './http/endpointSharePanel';

/**
 * Observe/adjust the executor's own outbound turn — row 1 of the hijack spike
 * (docs/copilot-chat-hijack-spike.md, TASK-006). Both hooks read configuration
 * live so a settings change takes effect on the next run without reloading.
 * Progress narration is opt-in; observation remains off by default.
 */
export const DEFAULT_OUTBOUND_PREAMBLE =
	'Treat the prompt\'s "Optional progress updates" section as required. Append a concise progress line after each meaningful phase of work, including investigation, editing, testing, and waiting for user action. Never include source, secrets, tokens, or absolute file paths.';

const outboundLog = vscode.window.createOutputChannel('Kanban Pilot');

const outboundSeam: OutboundPayloadSeam = {
	observe(metadata) {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		if (!cfg.get<boolean>('chat.observeOutbound', false)) {
			return;
		}
		outboundLog.appendLine(`[outbound] ${new Date().toISOString()} ${JSON.stringify(metadata)}`);
	},
	transform(payload) {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		const preamble = cfg.get<string>('chat.outboundPreamble', DEFAULT_OUTBOUND_PREAMBLE).trim();
		if (!preamble) {
			return payload;
		}
		return { ...payload, query: `${preamble}\n\n${payload.query}` };
	},
};

const executor = new ChatSessionExecutor(vscode.commands, {}, outboundSeam);

export type WorkspaceChangeKind = 'task' | 'attachment' | 'configuration' | 'task-set' | 'run' | 'reconnect';

export interface WorkspaceTaskSetChange extends BoardTaskSetChange {
	kind: WorkspaceChangeKind;
}

/**
 * The board and all commands share one active-set context per workspace. A
 * context swaps the store and RunManager together, so a task id is never
 * resolved against a different set halfway through an operation.
 */
export class WorkspaceTaskSetContext {
	readonly registry: TaskSetRegistry;
	private currentSet: TaskSet;
	private currentStore: TaskStore;
	private currentRunManager: RunManager;
	private watcher: vscode.Disposable | undefined;
	private runChange: vscode.Disposable | undefined;
	private readonly configurationWatcher: vscode.Disposable;
	private watcherQueue: Promise<void> = Promise.resolve();
	private taskSetOperationTail: Promise<void> = Promise.resolve();
	private readonly pendingStoreChanges = new Map<string, { manager: RunManager; generation: number; change: TaskStoreChange }>();
	private storeChangeTimer: ReturnType<typeof setTimeout> | undefined;
	private setGeneration = 0;
	private revisionValue = 0;
	private disposed = false;
	private readonly changed = new vscode.EventEmitter<WorkspaceTaskSetChange>();
	readonly ready: Promise<void>;

	constructor(
		private readonly folder: vscode.WorkspaceFolder,
		tasksDir: string,
	) {
		this.registry = new TaskSetRegistry(folder, tasksDir);
		this.currentSet = this.registry.defaultSet;
		this.currentStore = new TaskStore(this.currentSet.directory, this.currentSet.id);
		this.currentRunManager = new RunManager(this.currentStore, executor, folder);
		this.configurationWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('kanbanPilot') || event.affectsConfiguration('chat.agentFilesLocations')) {
				this.emitChange('configuration');
			}
		});
		this.ready = this.initialize();
	}

	get revision(): number {
		return Math.max(this.revisionValue, this.currentStore.revision);
	}

	get activeSet(): TaskSet {
		return this.currentSet;
	}

	get store(): TaskStore {
		return this.currentStore;
	}

	get runManager(): RunManager {
		return this.currentRunManager;
	}

	onDidChange(listener: (change?: WorkspaceTaskSetChange) => void): vscode.Disposable {
		return this.changed.event(listener);
	}

	private emitChange(
		kind: WorkspaceChangeKind,
		taskId?: string,
		note?: string,
	): void {
		if (this.disposed) {
			return;
		}
		this.revisionValue = Math.max(this.revisionValue, this.currentStore.revision) + 1;
		this.changed.fire({ revision: this.revisionValue, kind, taskId, note });
	}

	private isCurrent(generation: number, manager: RunManager): boolean {
		return !this.disposed && generation === this.setGeneration && manager === this.currentRunManager;
	}

	private runTaskSetOperation<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.taskSetOperationTail.then(operation);
		this.taskSetOperationTail = run.then(() => undefined, () => undefined);
		return run;
	}

	private async initialize(): Promise<void> {
		const active = await this.registry.active();
		if (this.disposed) {
			return;
		}
		const activation = this.activateSet(active);
		await activation.manager.reconcileOnActivation();
		if (!this.isCurrent(activation.generation, activation.manager)) {
			return;
		}
		await activation.manager.applyGatePolicies();
	}

	private activateSet(set: TaskSet): { generation: number; manager: RunManager } {
		if (this.disposed) {
			return { generation: this.setGeneration, manager: this.currentRunManager };
		}
		const generation = ++this.setGeneration;
		this.watcher?.dispose();
		this.runChange?.dispose();
		if (this.storeChangeTimer !== undefined) {
			clearTimeout(this.storeChangeTimer);
			this.storeChangeTimer = undefined;
		}
		this.pendingStoreChanges.clear();
		const previousManager = this.currentRunManager;
		this.currentSet = set;
		this.currentStore = new TaskStore(set.directory, set.id);
		this.currentRunManager = new RunManager(this.currentStore, executor, this.folder);
		if (previousManager !== this.currentRunManager) {
			previousManager.dispose();
		}
		const manager = this.currentRunManager;
		this.runChange = manager.onDidChange((change) => {
			if (generation !== this.setGeneration || manager !== this.currentRunManager) {
				return;
			}
			this.emitChange('run', change.taskId, change.note);
		});
		this.watcher = this.currentStore.watchChanges((change) => {
			if (generation !== this.setGeneration || manager !== this.currentRunManager) {
				return;
			}
			this.queueStoreChange(manager, change, generation);
		});
		return { generation, manager };
	}

	private queueStoreChange(manager: RunManager, change: TaskStoreChange, generation: number): void {
		if (this.disposed || generation !== this.setGeneration || manager !== this.currentRunManager) {
			return;
		}
		const key = `${change.setId}:${change.taskId ?? change.uri.toString()}`;
		const previous = this.pendingStoreChanges.get(key);
		const priority: Record<TaskStoreChange['kind'], number> = {
			'position-only': 0,
			attachment: 1,
			other: 2,
		};
		const kind = previous && priority[previous.change.kind] > priority[change.kind]
			? previous.change.kind
			: change.kind;
		this.pendingStoreChanges.set(key, {
			manager,
			generation,
			change: { ...change, kind },
		});
		if (this.storeChangeTimer === undefined) {
			this.storeChangeTimer = setTimeout(() => {
				this.storeChangeTimer = undefined;
				this.drainStoreChanges();
			}, 25);
		}
	}

	private drainStoreChanges(): void {
		const changes = [...this.pendingStoreChanges.values()];
		this.pendingStoreChanges.clear();
		if (changes.length === 0) {
			return;
		}

		this.watcherQueue = this.watcherQueue.then(async () => {
			const valid = changes.filter(({ manager, generation }) => (
				!this.disposed && generation === this.setGeneration && manager === this.currentRunManager
			));
			if (valid.length === 0) {
				return;
			}

			const requiresReconciliation = valid.some(({ change }) => change.kind !== 'position-only' && change.kind !== 'attachment');
			if (requiresReconciliation) {
				const taskIds = [...new Set(valid.map(({ change }) => change.taskId))];
				for (const taskId of taskIds) {
					if (this.disposed || this.setGeneration !== valid[0].generation || this.currentRunManager !== valid[0].manager) {
						return;
					}
					try {
						await valid[0].manager.reconcileTaskChange(taskId);
					} catch (error) {
						await valid[0].manager.recordReconciliationFailure(taskId, error);
						this.emitChange('task', taskId, 'reconciliation failed');
					}
				}
				if (this.disposed || this.setGeneration !== valid[0].generation || this.currentRunManager !== valid[0].manager) {
					return;
				}
				try {
					await valid[0].manager.applyGatePolicies();
				} catch (error) {
					await valid[0].manager.recordReconciliationFailure(undefined, error);
					this.emitChange('task', undefined, 'gate reconciliation failed');
				}
			}
			if (this.disposed || this.setGeneration !== valid[0].generation || this.currentRunManager !== valid[0].manager) {
				return;
			}
			for (const { change } of valid) {
				this.emitChange(change.kind === 'attachment' ? 'attachment' : 'task', change.taskId);
			}
		}).catch(() => undefined);
	}

	private async ensureReady(): Promise<void> {
		await this.ready;
	}

	async listTaskSets(): Promise<TaskSet[]> {
		await this.ensureReady();
		if (this.disposed) {
			return [];
		}
		return this.registry.list();
	}

	async switchTaskSet(id: string): Promise<void> {
		await this.runTaskSetOperation(async () => {
			await this.ensureReady();
			if (this.disposed || id === this.currentSet.id) {
				return;
			}

			await this.ensureNoActiveRun();
			if (this.disposed) {
				return;
			}

			const next = await this.registry.select(id);
			if (this.disposed) {
				return;
			}
			const activation = this.activateSet(next);
			await activation.manager.reconcileOnActivation();
			if (!this.isCurrent(activation.generation, activation.manager)) {
				return;
			}
			await activation.manager.applyGatePolicies();
			if (this.isCurrent(activation.generation, activation.manager)) {
				this.emitChange('task-set', undefined, 'active task set changed');
			}
		});
	}

	async createTaskSet(name: string): Promise<void> {
		await this.runTaskSetOperation(async () => {
			await this.ensureReady();
			if (this.disposed) {
				return;
			}
			await this.ensureNoActiveRun();
			if (this.disposed) {
				return;
			}
			const next = await this.registry.create(name);
			if (this.disposed) {
				return;
			}
			const activation = this.activateSet(next);
			await activation.manager.reconcileOnActivation();
			if (!this.isCurrent(activation.generation, activation.manager)) {
				return;
			}
			await activation.manager.applyGatePolicies();
			if (this.isCurrent(activation.generation, activation.manager)) {
				this.emitChange('task-set', undefined, 'task set created');
			}
		});
	}

	async renameTaskSet(name: string): Promise<void> {
		await this.runTaskSetOperation(async () => {
			await this.ensureReady();
			if (this.disposed) {
				return;
			}
			const generation = this.setGeneration;
			const renamed = await this.registry.rename(this.currentSet.id, name);
			if (this.disposed || generation !== this.setGeneration) {
				return;
			}
			this.currentSet = renamed;
			this.emitChange('task-set', undefined, 'task set renamed');
		});
	}

	async deleteTaskSet(): Promise<void> {
		await this.runTaskSetOperation(async () => {
			await this.ensureReady();
			if (this.disposed) {
				return;
			}
			const deletedId = this.currentSet.id;
			await this.registry.delete(deletedId);
			if (this.disposed) {
				return;
			}
			if (deletedId !== DEFAULT_TASK_SET_ID) {
				const activation = this.activateSet(await this.registry.active());
				await activation.manager.reconcileOnActivation();
				if (!this.isCurrent(activation.generation, activation.manager)) {
					return;
				}
				await activation.manager.applyGatePolicies();
				if (!this.isCurrent(activation.generation, activation.manager)) {
					return;
				}
			}
			if (!this.disposed) {
				this.emitChange('task-set', undefined, 'task set deleted');
			}
		});
	}

	/** Reconciles configuration changes against one stable active manager. */
	async reconcileConfiguration(): Promise<void> {
		await this.runTaskSetOperation(async () => {
			await this.ensureReady();
			if (this.disposed) {
				return;
			}
			const generation = this.setGeneration;
			const manager = this.currentRunManager;
			await manager.reconcileTaskChange();
			if (!this.isCurrent(generation, manager)) {
				return;
			}
			await manager.applyGatePolicies();
		});
	}

	private async ensureNoActiveRun(): Promise<void> {
		const { tasks } = await this.currentStore.readAll();
		if (tasks.some((task) => task.status === 'running')) {
			throw new TaskSetError('active-run', 'Task-set changes are unavailable while a task run is active.');
		}
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.setGeneration += 1;
		this.watcher?.dispose();
		this.watcher = undefined;
		if (this.storeChangeTimer !== undefined) {
			clearTimeout(this.storeChangeTimer);
			this.storeChangeTimer = undefined;
		}
		this.pendingStoreChanges.clear();
		this.runChange?.dispose();
		this.runChange = undefined;
		this.configurationWatcher.dispose();
		this.currentRunManager.dispose();
		this.changed.dispose();
	}
}

const workspaceContexts = new Map<string, WorkspaceTaskSetContext>();

function activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	// v1 binds the board to the first workspace folder (R7).
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Kanban Pilot needs an open folder.');
	}
	return folder;
}

/** Bundles the store + RunManager for the active workspace, or undefined if there isn't one. */
function context(): WorkspaceTaskSetContext | undefined {
	const folder = activeWorkspaceFolder();
	if (!folder) {
		return undefined;
	}
	const key = folder.uri.toString();
	let workspaceContext = workspaceContexts.get(key);
	if (!workspaceContext) {
		const tasksDir = vscode.workspace
			.getConfiguration('kanbanPilot')
			.get<string>('tasksDir', '.kanban-pilot/tasks');
		workspaceContext = new WorkspaceTaskSetContext(folder, tasksDir);
		workspaceContexts.set(key, workspaceContext);
	}
	return workspaceContext;
}

export interface NewTaskCommandInput {
	title?: unknown;
	description?: unknown;
	taskType?: unknown;
}

/** Applies the New Task command's final type guard before writing to the store. */
export async function createTaskFromCommandInput(
	store: Pick<TaskStore, 'create'>,
	input: NewTaskCommandInput,
): Promise<boolean> {
	const title = typeof input.title === 'string' ? input.title.trim() : '';
	if (!title || !isTaskType(input.taskType)) {
		return false;
	}

	await store.create(title, {
		type: input.taskType,
		request: typeof input.description === 'string' ? input.description.trim() : undefined,
	});
	return true;
}

/**
 * VS Code has no "activity bar icon that just runs a command" contribution
 * point — an activitybar entry must own a view. This view is never meant to
 * be seen: the moment it's shown (icon clicked, or re-clicked after the
 * board panel was closed), it opens/focuses the board in the editor area and
 * immediately closes the sidebar again, so the icon reads as a launcher
 * rather than a panel toggle.
 */
class BoardViewProvider implements vscode.WebviewViewProvider {
	constructor(private readonly extensionUri: vscode.Uri) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		webviewView.webview.options = { enableScripts: false };
		webviewView.webview.html = '';
		this.openBoardAndCloseSidebar();
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				this.openBoardAndCloseSidebar();
			}
		});
	}

	private openBoardAndCloseSidebar(): void {
		this.openBoard();
		void vscode.commands.executeCommand('workbench.action.closeSidebar');
	}

	private openBoard(): void {
		const ctx = context();
		if (ctx) {
			BoardPanel.show(ctx, this.extensionUri);
		}
	}
}

/**
 * Registers a palette command for a card action (§7 — "every card action is
 * also a palette command"). Bare invocation from Ctrl+Shift+P has no notion
 * of "the selected card," so it falls back to a QuickPick over eligible tasks;
 * a `taskId` arg (a future context-menu invocation) skips that. Routes
 * through `RunManager` so palette and card-click behave identically —
 * including launching a real refine run, not just applying the transition.
 */
function registerActionCommand(
	extContext: vscode.ExtensionContext,
	command: string,
	action: TaskAction,
): void {
	extContext.subscriptions.push(
		vscode.commands.registerCommand(command, async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const id = await pickTaskFor(ctx.store, action, taskId);
			if (id) {
				await ctx.runManager.handleAction(id, action);
			}
		}),
	);
}

export function activate(context_: vscode.ExtensionContext) {
	let sharedEndpointUrl: string | undefined;
	const endpointStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	endpointStatusItem.name = 'Kanban Pilot Connection';
	endpointStatusItem.command = 'kanban-pilot.showEndpointConnection';
	endpointStatusItem.text = '$(broadcast) Kanban Pilot';
	endpointStatusItem.tooltip = 'Show the Kanban Pilot endpoint QR code and URL';
	endpointStatusItem.show();
	context_.subscriptions.push(
		endpointStatusItem,
		outboundLog,
		vscode.commands.registerCommand('kanban-pilot.showEndpointConnection', async () => {
			if (!sharedEndpointUrl) {
				void vscode.window.showWarningMessage(
					'Kanban Pilot HTTP endpoint is not enabled. Configure it in Kanban Pilot Settings under HTTP endpoint.',
				);
				return;
			}
			await showEndpointSharePanel(context_.extensionUri, sharedEndpointUrl);
		}),
	);
	// §6.4: a window reload loses every in-flight run's promise. Reconcile
	// against whatever the file shows before the user touches anything.
	const startupFolder = vscode.workspace.workspaceFolders?.[0];
	if (startupFolder) {
		const workspaceContext = context();
		const runConfig = vscode.workspace.getConfiguration('kanbanPilot.run');
		void workspaceContext?.ready;
		let previousMaxParallelTasks = normalizeMaxParallelTasks(runConfig.get<number>('maxParallelTasks', 1));
		let endpointServer: RealtimeBoardServer | undefined;
		let endpointGeneration = 0;
		const restartEndpoint = async (): Promise<void> => {
			const generation = ++endpointGeneration;
			endpointServer?.dispose();
			endpointServer = undefined;
			sharedEndpointUrl = undefined;
			endpointStatusItem.text = '$(broadcast) Kanban Pilot';
			endpointStatusItem.tooltip = 'Configure the Kanban Pilot HTTP endpoint in Settings';
			try {
				const endpointSettings = vscode.workspace.getConfiguration('kanbanPilot.http');
				const endpoint = httpEndpointConfig({
					enabled: endpointSettings.get<unknown>('enabled', false),
					host: endpointSettings.get<unknown>('host', '127.0.0.1'),
					port: endpointSettings.get<unknown>('port', 4173),
					token: endpointSettings.get<unknown>('token', ''),
					publicUrl: endpointSettings.get<unknown>('publicUrl', ''),
				});
				if (!endpoint || !workspaceContext) { return; }
				const server = await startRealtimeBoardServer({
					host: workspaceContext,
					extensionUri: context_.extensionUri,
					port: endpoint.port,
					token: endpoint.token,
					bindAddress: endpoint.bindAddress,
				});
				if (generation !== endpointGeneration) {
					server.dispose();
					return;
				}
				endpointServer = server;
				sharedEndpointUrl = endpointConnectionUrl(endpoint, server.port);
				endpointStatusItem.text = '$(broadcast) Kanban Pilot: Share';
				endpointStatusItem.tooltip = `Show QR code and copy ${sharedEndpointUrl}`;
				void vscode.window.showInformationMessage(`Kanban Pilot real-time HTTP endpoint listening on ${sharedEndpointUrl}.`);
				if (isNonLoopbackBindAddress(endpoint.bindAddress)) {
					void vscode.window.showWarningMessage(
						`Kanban Pilot HTTP endpoint is bound to ${endpoint.bindAddress} and reachable from other machines. The share URL carries the access token in plain text over HTTP with no TLS — only expose it on networks you trust, or front it with a TLS reverse proxy.`,
					);
				}
			} catch (error) {
				if (generation === endpointGeneration) {
					void vscode.window.showErrorMessage(`Kanban Pilot HTTP endpoint could not start: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		};
		context_.subscriptions.push({ dispose: () => endpointServer?.dispose() });
		context_.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('kanbanPilot.tasksDir')) {
					void vscode.window.showInformationMessage(
						'Kanban Pilot task folder changed. Reload the VS Code window to switch the active task-set context safely.',
					);
				}
				if (event.affectsConfiguration('kanbanPilot.board.openOnStartup')) {
					void vscode.window.showInformationMessage(
						'Kanban Pilot startup setting changed. Reload the VS Code window for it to take effect.',
					);
				}
				const capacityChanged = event.affectsConfiguration('kanbanPilot.run.maxParallelTasks');
				const gatesChanged = event.affectsConfiguration('kanbanPilot.gates');
				if (event.affectsConfiguration('kanbanPilot.http')) {
					void restartEndpoint();
				}
				if (!capacityChanged && !gatesChanged) {
					return;
				}
				const currentMaxParallelTasks = normalizeMaxParallelTasks(
					vscode.workspace.getConfiguration('kanbanPilot.run').get<number>('maxParallelTasks', 1),
				);
				const increased = currentMaxParallelTasks > previousMaxParallelTasks;
				previousMaxParallelTasks = currentMaxParallelTasks;
				if (gatesChanged || increased) {
					void workspaceContext?.reconcileConfiguration();
				}
			}),
		);
		void restartEndpoint();
	}

	context_.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kanban-pilot.boardView', new BoardViewProvider(context_.extensionUri)),
	);

	context_.subscriptions.push(
		vscode.commands.registerCommand('kanban-pilot.openBoard', () => {
			const ctx = context();
			if (ctx) {
				BoardPanel.show(ctx, context_.extensionUri);
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.newTask', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			BoardPanel.show(ctx, context_.extensionUri).openNewTask();
		}),

		vscode.commands.registerCommand('kanban-pilot.createTaskSet', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const name = await vscode.window.showInputBox({
				prompt: 'Task-set name',
				placeHolder: 'e.g. Mobile app release',
				validateInput: (value) => (value.trim() ? undefined : 'Task-set name cannot be blank.'),
			});
			if (!name) {
				return;
			}
			try {
				await ctx.createTaskSet(name);
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.renameTaskSet', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const name = await vscode.window.showInputBox({
				prompt: 'Rename task set',
				value: ctx.activeSet.name,
				validateInput: (value) => (value.trim() ? undefined : 'Task-set name cannot be blank.'),
			});
			if (!name) {
				return;
			}
			try {
				await ctx.renameTaskSet(name);
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.deleteTaskSet', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const confirmed = await vscode.window.showWarningMessage(
				`Delete task set '${ctx.activeSet.name}'? Only an empty set can be deleted.`,
				{ modal: true },
				'Delete',
			);
			if (confirmed !== 'Delete') {
				return;
			}
			try {
				await ctx.deleteTaskSet();
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.openTaskFile', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			let id = taskId;
			if (!id) {
				const { tasks } = await ctx.store.readAll();
				const pick = await vscode.window.showQuickPick(
					tasks.map((t) => ({ label: t.id, description: t.title, id: t.id })),
					{ placeHolder: 'Open which task?' },
				);
				id = pick?.id;
			}
			if (id) {
				await vscode.window.showTextDocument(ctx.store.fileFor(id));
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.openTaskChat', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			let id = taskId;
			if (!id) {
				const { tasks } = await ctx.store.readAll();
				const pick = await vscode.window.showQuickPick(
					tasks.map((t) => ({ label: t.id, description: t.title, id: t.id })),
					{ placeHolder: 'Open which task’s chat?' },
				);
				id = pick?.id;
			}
			if (id) {
				// Deliberately bypasses the dockChat/dockChatOnSelect gates — an
				// explicit "open the chat" ask, not automatic docking (§6.10).
				await ctx.runManager.dockTaskChat(id, { onSelect: false, explicit: true });
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.markRunComplete', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const { tasks } = await ctx.store.readAll();
			const running = tasks.filter((t) => t.status === 'running');
			let id = taskId;
			if (!id) {
				if (running.length === 0) {
					void vscode.window.showInformationMessage('No tasks are currently running.');
					return;
				}
				const pick = await vscode.window.showQuickPick(
					running.map((t) => ({ label: t.id, description: t.title, id: t.id })),
					{ placeHolder: 'Mark which run complete?' },
				);
				id = pick?.id;
			}
			if (!id) {
				return;
			}

			const result = await vscode.window.showQuickPick(
				[
					{ label: 'ok', description: 'The agent finished successfully' },
					{ label: 'blocked', description: 'The agent needs a decision' },
					{ label: 'failed', description: 'The run did not complete' },
				],
				{ placeHolder: 'Outcome?' },
			);
			if (!result) {
				return;
			}
			const note = await vscode.window.showInputBox({ prompt: 'One-line summary' });
			await ctx.runManager.markRunComplete(id, result.label as 'ok' | 'blocked' | 'failed', note ?? '');
		}),

		vscode.commands.registerCommand('kanban-pilot.applyPendingOutcome', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			const { tasks } = await ctx.store.readAll();
			const pending = tasks.filter((task) => task.pendingOutcome);
			let id = taskId;
			if (!id) {
				if (pending.length === 0) {
					void vscode.window.showInformationMessage('No pending completion outcomes are available.');
					return;
				}
				const pick = await vscode.window.showQuickPick(
					pending.map((task) => ({
						label: task.id,
						description: `${task.title} — ${task.pendingOutcome!.gate}`,
						id: task.id,
					})),
					{ placeHolder: 'Apply which pending completion?' },
				);
				id = pick?.id;
			}
			if (id) {
				await ctx.runManager.applyPendingOutcome(id);
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.recoverStaleCompletion', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;

			const allCandidates = await ctx.runManager.listStaleCompletionCandidates(taskId);
			if (allCandidates.length === 0) {
				void vscode.window.showInformationMessage('No validated stale completions are available for recovery.');
				return;
			}

			let selectedTaskId = taskId;
			if (!selectedTaskId) {
				const taskPicks = [...new Set(allCandidates.map((candidate) => candidate.taskId))].map((id) => ({
					label: id,
					description: `${allCandidates.filter((candidate) => candidate.taskId === id).length} validated stale completion(s)`,
					id,
				}));
				const taskPick = await vscode.window.showQuickPick(taskPicks, {
					placeHolder: 'Pick a retryable task with a stale completion',
				});
				selectedTaskId = taskPick?.id;
			}
			if (!selectedTaskId) {
				return;
			}

			const taskCandidates = allCandidates.filter((candidate) => candidate.taskId === selectedTaskId);
			if (taskCandidates.length === 0) {
				void vscode.window.showInformationMessage(`No validated stale completions remain for ${selectedTaskId}.`);
				return;
			}
			const candidatePick = await vscode.window.showQuickPick(
				taskCandidates.map((candidate) => ({
					label: `${candidate.stage} · ${candidate.runId}`,
					description: `Latest run: ${candidate.latestRunId ?? 'none'} · Receipt: ${candidate.summary}`,
					detail: candidate.supersededByRunId
						? `This completion predates retry ${candidate.supersededByRunId}.`
						: 'This completion belongs to the timed-out or missing-receipt run.',
					candidate,
				})),
				{ placeHolder: 'Pick the stale completion to recover' },
			);
			const selected = candidatePick?.candidate as StaleCompletionCandidate | undefined;
			if (!selected) {
				return;
			}

			const currentRun = selected.currentRunId ?? 'none';
			const latestRun = selected.latestRunId ?? 'none';
			const confirmed = await vscode.window.showWarningMessage(
				`Recover ${selected.stage} completion for ${selected.taskId} from old run ${selected.runId}? Current run: ${currentRun}. Latest run: ${latestRun}. Receipt: ${selected.summary}`,
				{ modal: true },
				'Recover',
			);
			if (confirmed !== 'Recover') {
				return;
			}

			try {
				const result = await ctx.runManager.recoverStaleCompletion(selected.taskId, selected.runId, selected.stage);
				if (result.kind === 'recovered') {
					void vscode.window.showInformationMessage(
						`Recovered ${selected.stage} completion for ${selected.taskId} without starting a new run.`,
					);
					return;
				}
				if (result.kind === 'active-run') {
					void vscode.window.showWarningMessage('Recovery was not applied because a newer run is active.');
					return;
				}
				void vscode.window.showWarningMessage('Recovery was not applied because the selected completion is stale. Refresh and choose a current validated candidate.');
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.deleteTask', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;
			let id = taskId;
			if (!id) {
				const { tasks } = await ctx.store.readAll();
				const pick = await vscode.window.showQuickPick(
					tasks.map((t) => ({ label: t.id, description: t.title, id: t.id })),
					{ placeHolder: 'Delete which task?' },
				);
				id = pick?.id;
			}
			if (!id) {
				return;
			}
			const { tasks } = await ctx.store.readAll();
			const task = tasks.find((t) => t.id === id);
			if (task) {
				await deleteTask(ctx.store, task.id, task.title);
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.seedSampleTasks', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
			await ctx.ready;

			const samples: [string, string, TaskType][] = [
				['Set up billing webhook', 'backlog', 'feature'],
				['Draft onboarding email flow', 'refine', 'feature'],
				['Audit mobile empty state', 'scoped', 'bug'],
				['Document retry behavior', 'approved', 'feature'],
				['Refine task', 'in-progress', 'feature'],
				['Ship changelog entry', 'validation', 'feature'],
				['Write API docs', 'done', 'feature'],
			];

			for (const [title, state, type] of samples) {
				const task = await ctx.store.create(title, { type });
				await ctx.store.auditedPatch(task.id, { state }, { action: 'seed-sample-tasks' });
			}

			void vscode.window.showInformationMessage(`Seeded ${samples.length} tasks.`);
			BoardPanel.show(ctx, context_.extensionUri);
		}),
	);

	registerActionCommand(context_, 'kanban-pilot.acceptTask', 'accept');
	registerActionCommand(context_, 'kanban-pilot.refineTask', 'refine');
	registerActionCommand(context_, 'kanban-pilot.splitTask', 'split');
	registerActionCommand(context_, 'kanban-pilot.approveTask', 'approve');
	registerActionCommand(context_, 'kanban-pilot.developTask', 'develop');
	registerActionCommand(context_, 'kanban-pilot.continueRun', 'continue');
	registerActionCommand(context_, 'kanban-pilot.stopRun', 'stop');
	registerActionCommand(context_, 'kanban-pilot.validateTask', 'validate');
	registerActionCommand(context_, 'kanban-pilot.reopenTask', 'reopen');

	if (startupFolder && vscode.workspace.getConfiguration('kanbanPilot').get<boolean>('board.openOnStartup', false)) {
		const ctx = context();
		if (ctx) {
			BoardPanel.show(ctx, context_.extensionUri);
		}
	}
}

export function deactivate() {
	for (const workspaceContext of workspaceContexts.values()) {
		workspaceContext.dispose();
	}
	workspaceContexts.clear();
}
