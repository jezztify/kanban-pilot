import * as vscode from 'vscode';
import { COLUMNS, Column } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { applyAction, TaskAction } from './stateMachine';

/**
 * Single entry point for turning a card action into a **pure** disk write —
 * apply the state-machine transition, patch the file, nothing else. Shared by
 * the webview's `action/invoke` handler and the command-palette commands
 * (§7 — "every card action is also a palette command"), so the two surfaces
 * cannot drift.
 *
 * Deliberately has no opinion on `needsAgent` beyond reporting it: `RunManager`
 * (src/chat/runManager.ts) is what decides whether that means launching a real
 * run (refine, from M3) or showing a stub message (develop/continue, until
 * M4). Keeping that decision out of this function is what lets both stay in
 * sync with milestone reality without editing this file each time.
 */

export type InvokeOutcome =
	| { kind: 'applied'; needsAgent: boolean }
	| { kind: 'illegal' }
	| { kind: 'not-found' };

export type MoveOutcome =
	| { kind: 'applied' }
	| { kind: 'no-op' }
	| { kind: 'invalid' }
	| { kind: 'not-found' };

function isColumn(value: unknown): value is Column {
	return typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);
}

export async function invokeTaskAction(
	store: TaskStore,
	taskId: string,
	action: TaskAction,
): Promise<InvokeOutcome> {
	const { tasks } = await store.readAll();
	const task = tasks.find((t) => t.id === taskId);
	if (!task) {
		return { kind: 'not-found' };
	}

	const result = applyAction(task, action);
	if (!result) {
		return { kind: 'illegal' };
	}

	await store.patch(taskId, { state: result.state, status: result.status });
	return { kind: 'applied', needsAgent: result.needsAgent };
}

export async function moveTask(
	store: TaskStore,
	taskId: unknown,
	destination: unknown,
): Promise<MoveOutcome> {
	if (typeof taskId !== 'string' || !/^TASK-\d+$/.test(taskId) || !isColumn(destination)) {
		return { kind: 'invalid' };
	}

	const { tasks } = await store.readAll();
	const task = tasks.find((candidate) => candidate.id === taskId);
	if (!task) {
		return { kind: 'not-found' };
	}
	if (task.state === destination) {
		return { kind: 'no-op' };
	}

	await store.patch(task.id, { state: destination, status: 'idle', run: undefined });
	return { kind: 'applied' };
}

/**
 * Palette-command helper: resolves a target task either from an explicit id
 * (a future context-menu invocation) or by asking the user to pick from the
 * tasks for which `action` is currently legal (a bare Command Palette
 * invocation has no notion of "the selected card").
 */
/**
 * Deletes a task's file, after confirmation. Card deletion is hard to reverse
 * (no in-app undo), so it goes through `showWarningMessage`'s modal — a
 * destructive action a single stray click shouldn't be able to complete.
 */
export async function deleteTask(
	store: TaskStore,
	taskId: string,
	title: string,
): Promise<boolean> {
	const confirmed = await vscode.window.showWarningMessage(
		`Delete ${taskId} — "${title}"? This removes the task file and cannot be undone.`,
		{ modal: true },
		'Delete',
	);
	if (confirmed !== 'Delete') {
		return false;
	}

	await vscode.workspace.fs.delete(store.fileFor(taskId));
	return true;
}

export async function pickTaskFor(
	store: TaskStore,
	action: TaskAction,
	explicitId?: string,
): Promise<string | undefined> {
	if (explicitId) {
		return explicitId;
	}

	const { tasks } = await store.readAll();
	const eligible = tasks.filter((t) => applyAction(t, action) !== undefined);

	if (eligible.length === 0) {
		void vscode.window.showInformationMessage(`No tasks are currently eligible for "${action}".`);
		return undefined;
	}

	const pick = await vscode.window.showQuickPick(
		eligible.map((t) => ({ label: `${t.id}`, description: t.title, id: t.id })),
		{ placeHolder: `Pick a task to ${action}` },
	);
	return pick?.id;
}
