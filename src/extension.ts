import * as vscode from 'vscode';
import { deleteTask, pickTaskFor } from './board/actions';
import { BoardPanel } from './board/boardPanel';
import { TaskAction } from './board/stateMachine';
import { ChatSessionExecutor } from './chat/executor';
import { RunManager } from './chat/runManager';
import { TaskStore } from './model/taskStore';

const executor = new ChatSessionExecutor();

function activeWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	// v1 binds the board to the first workspace folder (R7).
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder) {
		void vscode.window.showWarningMessage('Kanban Pilot needs an open folder.');
	}
	return folder;
}

function storeFor(folder: vscode.WorkspaceFolder): TaskStore {
	const subPath = vscode.workspace
		.getConfiguration('kanbanPilot')
		.get<string>('tasksDir', '.kanban-pilot/tasks');
	return TaskStore.forWorkspace(folder, subPath);
}

/** Bundles the store + RunManager for the active workspace, or undefined if there isn't one. */
function context(): { store: TaskStore; runManager: RunManager } | undefined {
	const folder = activeWorkspaceFolder();
	if (!folder) {
		return undefined;
	}
	const store = storeFor(folder);
	return { store, runManager: new RunManager(store, executor, folder) };
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
			BoardPanel.show(ctx.store, ctx.runManager);
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
		const store = storeFor(startupFolder);
		const gateRunManager = new RunManager(store, executor, startupFolder);
		void gateRunManager.reconcileOnActivation().then(() => gateRunManager.applyGatePolicies());
		// §6.15: re-sweep on every change, not just at startup — disk is
		// authoritative (G5), so a gate firing (or a human hand-editing a task
		// file directly) both need to be picked up the same way.
		context_.subscriptions.push(store.watch(() => void gateRunManager.applyGatePolicies()));
	}

	context_.subscriptions.push(
		vscode.window.registerWebviewViewProvider('kanban-pilot.boardView', new BoardViewProvider()),
	);

	context_.subscriptions.push(
		vscode.commands.registerCommand('kanban-pilot.openBoard', () => {
			const ctx = context();
			if (ctx) {
				BoardPanel.show(ctx.store, ctx.runManager);
			}
		}),

		vscode.commands.registerCommand('kanban-pilot.newTask', async () => {
			const ctx = context();
			if (!ctx) {
				return;
			}
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
			await ctx.store.create(title.trim(), { request: description?.trim() });
		}),

		vscode.commands.registerCommand('kanban-pilot.openTaskFile', async (taskId?: string) => {
			const ctx = context();
			if (!ctx) {
				return;
			}
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

			const samples: [string, string][] = [
				['Set up billing webhook', 'backlog'],
				['Draft onboarding email flow', 'refine'],
				['Audit mobile empty state', 'scoped'],
				['Document retry behavior', 'approved'],
				['Refine task', 'in-progress'],
				['Ship changelog entry', 'validation'],
				['Write API docs', 'done'],
			];

			for (const [title, state] of samples) {
				const task = await ctx.store.create(title);
				await ctx.store.patch(task.id, { state });
			}

			void vscode.window.showInformationMessage(`Seeded ${samples.length} tasks.`);
			BoardPanel.show(ctx.store, ctx.runManager);
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
			BoardPanel.show(ctx.store, ctx.runManager);
		}
	}
}

export function deactivate() {}
