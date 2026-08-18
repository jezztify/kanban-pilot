import * as vscode from 'vscode';
import { deleteTask, pickTaskFor } from './board/actions';
import { BoardPanel } from './board/boardPanel';
import { TaskAction } from './board/stateMachine';
import { ChatSessionExecutor } from './chat/executor';
import { normalizeMaxParallelTasks, RunManager } from './chat/runManager';
import { isTaskType, TaskType } from './model/task';
import { DEFAULT_TASK_SET_ID, TaskSet, TaskSetError, TaskSetRegistry } from './model/taskSets';
import { TaskStore } from './model/taskStore';

const executor = new ChatSessionExecutor();

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
	private watcherQueue: Promise<void> = Promise.resolve();
	private readonly changed = new vscode.EventEmitter<void>();
	readonly ready: Promise<void>;

	constructor(
		private readonly folder: vscode.WorkspaceFolder,
		tasksDir: string,
	) {
		this.registry = new TaskSetRegistry(folder, tasksDir);
		this.currentSet = this.registry.defaultSet;
		this.currentStore = new TaskStore(this.currentSet.directory, this.currentSet.id);
		this.currentRunManager = new RunManager(this.currentStore, executor, folder);
		this.ready = this.initialize();
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

	onDidChange(listener: () => void): vscode.Disposable {
		return this.changed.event(listener);
	}

	private async initialize(): Promise<void> {
		const active = await this.registry.active();
		this.activateSet(active);
		await this.currentRunManager.reconcileOnActivation();
		await this.currentRunManager.applyGatePolicies();
	}

	private activateSet(set: TaskSet): void {
		this.watcher?.dispose();
		this.currentSet = set;
		this.currentStore = new TaskStore(set.directory, set.id);
		this.currentRunManager = new RunManager(this.currentStore, executor, this.folder);
		const manager = this.currentRunManager;
		this.watcher = this.currentStore.watch((taskId, changeKind) => {
			this.watcherQueue = this.watcherQueue
				.then(() => changeKind === 'position-only' ? undefined : manager.reconcileTaskChange(taskId))
				.then(() => changeKind === 'position-only' ? undefined : manager.applyGatePolicies())
				.catch(() => undefined);
		});
	}

	private async ensureReady(): Promise<void> {
		await this.ready;
	}

	async listTaskSets(): Promise<TaskSet[]> {
		await this.ensureReady();
		return this.registry.list();
	}

	async switchTaskSet(id: string): Promise<void> {
		await this.ensureReady();
		if (id === this.currentSet.id) {
			return;
		}

		await this.ensureNoActiveRun();

		const next = await this.registry.select(id);
		this.activateSet(next);
		await this.currentRunManager.reconcileOnActivation();
		await this.currentRunManager.applyGatePolicies();
		this.changed.fire();
	}

	async createTaskSet(name: string): Promise<void> {
		await this.ensureReady();
		await this.ensureNoActiveRun();
		const next = await this.registry.create(name);
		this.activateSet(next);
		await this.currentRunManager.reconcileOnActivation();
		await this.currentRunManager.applyGatePolicies();
		this.changed.fire();
	}

	async renameTaskSet(name: string): Promise<void> {
		await this.ensureReady();
		const renamed = await this.registry.rename(this.currentSet.id, name);
		this.currentSet = renamed;
		this.changed.fire();
	}

	async deleteTaskSet(): Promise<void> {
		await this.ensureReady();
		const deletedId = this.currentSet.id;
		await this.registry.delete(deletedId);
		if (deletedId !== DEFAULT_TASK_SET_ID) {
			this.activateSet(await this.registry.active());
			await this.currentRunManager.reconcileOnActivation();
			await this.currentRunManager.applyGatePolicies();
		}
		this.changed.fire();
	}

	private async ensureNoActiveRun(): Promise<void> {
		const { tasks } = await this.currentStore.readAll();
		if (tasks.some((task) => task.status === 'running')) {
			throw new TaskSetError('active-run', 'Task-set changes are unavailable while a task run is active.');
		}
	}

	dispose(): void {
		this.watcher?.dispose();
		this.watcher = undefined;
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
	// §6.4: a window reload loses every in-flight run's promise. Reconcile
	// against whatever the file shows before the user touches anything.
	const startupFolder = vscode.workspace.workspaceFolders?.[0];
	if (startupFolder) {
		const workspaceContext = context();
		const runConfig = vscode.workspace.getConfiguration('kanbanPilot.run');
		void workspaceContext?.ready;
		let previousMaxParallelTasks = normalizeMaxParallelTasks(runConfig.get<number>('maxParallelTasks', 1));
		context_.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (!event.affectsConfiguration('kanbanPilot.run.maxParallelTasks')) {
					return;
				}
				const currentMaxParallelTasks = normalizeMaxParallelTasks(
					vscode.workspace.getConfiguration('kanbanPilot.run').get<number>('maxParallelTasks', 1),
				);
				const increased = currentMaxParallelTasks > previousMaxParallelTasks;
				previousMaxParallelTasks = currentMaxParallelTasks;
				if (increased) {
					void workspaceContext?.runManager.reconcileTaskChange().then(() => workspaceContext.runManager.applyGatePolicies());
				}
			}),
		);
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
			const title = await vscode.window.showInputBox({
				prompt: 'Task title',
				placeHolder: 'e.g. Prepare launch notes',
			});
			if (!title?.trim()) {
				return;
			}
			// §6.16: matches the board's own New Task modal — title required,
			// description optional (falls back to the title as Request if left blank).
			const description = await vscode.window.showInputBox({
				prompt: 'Description (optional)',
				placeHolder: 'What needs to happen?',
			});
			const taskType = await vscode.window.showQuickPick<{ label: string; description: string; value: TaskType }>(
				[
					{ label: 'Feature', description: 'A new capability or improvement.', value: 'feature' },
					{ label: 'Bug', description: 'A defect or regression to fix.', value: 'bug' },
				],
				{ placeHolder: 'Task type (required)' },
			);
			if (!taskType) {
				return;
			}
			await createTaskFromCommandInput(ctx.store, {
				title,
				description,
				taskType: taskType.value,
			});
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
				await ctx.runManager.dockTaskChat(id, { onSelect: false });
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
