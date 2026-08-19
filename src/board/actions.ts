import * as vscode from 'vscode';
import { COLUMNS, Column } from '../model/task';
import type { AuditEventInput, AuditOutcome, AuditStage } from '../model/taskLog';
import { parseAuditEvents } from '../model/taskLog';
import { ReorderTarget, TaskMutationConflictError, TaskStore } from '../model/taskStore';
import { applyAction, applyPendingTransition, TaskAction } from './stateMachine';
import type { GateId } from '../model/gates';
import { parseReceipts } from '../chat/receipt';

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

export type PendingOutcomeResult =
	| { kind: 'applied'; gate: GateId }
	| { kind: 'no-pending' }
	| { kind: 'not-found' }
	| { kind: 'stale' };

export type MoveOutcome =
	| { kind: 'applied' }
	| { kind: 'no-op' }
	| { kind: 'invalid' }
	| { kind: 'not-found' };

export type ReorderOutcome =
	| { kind: 'applied' }
	| { kind: 'no-op' }
	| { kind: 'invalid' }
	| { kind: 'not-found' }
	| { kind: 'stale' };

export interface ActionAuditOptions {
	activityFinish?: {
		runId: string;
		stage: AuditStage;
		outcome: AuditOutcome;
		note?: string;
	};
}

function isColumn(value: unknown): value is Column {
	return typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);
}

function isTaskId(value: unknown): value is string {
	return typeof value === 'string' && /^TASK-\d+$/.test(value);
}

function normalizeReorderTarget(value: unknown): ReorderTarget | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	const hasIndex = Object.prototype.hasOwnProperty.call(candidate, 'targetIndex');
	const hasAnchor = Object.prototype.hasOwnProperty.call(candidate, 'beforeTaskId');
	if (Object.keys(candidate).length !== 1 || hasIndex === hasAnchor) {
		return undefined;
	}
	if (hasIndex) {
		return typeof candidate.targetIndex === 'number' && Number.isInteger(candidate.targetIndex) && candidate.targetIndex >= 0
			? { targetIndex: candidate.targetIndex }
			: undefined;
	}
	return candidate.beforeTaskId === null || isTaskId(candidate.beforeTaskId)
		? { beforeTaskId: candidate.beforeTaskId }
		: undefined;
}

/**
 * Validated within-column ordering intent. Unlike a workflow action this path
 * never calls the state machine, changes runtime metadata, or releases a run.
 */
export async function reorderTask(
	store: TaskStore,
	taskId: unknown,
	column: unknown,
	target: unknown,
): Promise<ReorderOutcome> {
	if (!isTaskId(taskId) || !isColumn(column)) {
		return { kind: 'invalid' };
	}
	const normalized = normalizeReorderTarget(target);
	if (!normalized) {
		return { kind: 'invalid' };
	}

	const { tasks } = await store.readAll();
	const matching = tasks.filter((task) => task.id === taskId);
	if (matching.length === 0) {
		return { kind: 'not-found' };
	}
	if (matching.length !== 1 || matching[0].state !== column) {
		return { kind: 'stale' };
	}

	const columnTasks = tasks.filter((task) => task.state === column);
	if (normalized.targetIndex !== undefined && normalized.targetIndex > Math.max(0, columnTasks.length - 1)) {
		return { kind: 'invalid' };
	}
	if (
		normalized.beforeTaskId !== undefined &&
		normalized.beforeTaskId !== null &&
		normalized.beforeTaskId !== taskId &&
		!columnTasks.some((task) => task.id === normalized.beforeTaskId)
	) {
		return { kind: 'stale' };
	}

	return store.reorder(taskId, column, normalized);
}

export async function invokeTaskAction(
	store: TaskStore,
	taskId: string,
	action: TaskAction,
	auditOptions: ActionAuditOptions = {},
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

	const updates: Record<string, string | undefined> = {
		state: result.state,
		status: result.status,
		pending_outcome: undefined,
	};
	if (action === 'stop') {
		updates.run = undefined;
	}
	const events: AuditEventInput[] = auditOptions.activityFinish
		? [{ kind: 'activity-finish', ...auditOptions.activityFinish, action }]
		: [];
	await store.auditedPatch(taskId, updates, {
		action,
		runId: auditOptions.activityFinish?.runId,
		outcome: auditOptions.activityFinish?.outcome,
		events,
	});
	return { kind: 'applied', needsAgent: result.needsAgent };
}

/**
 * Commits one durable receipt outcome. Both automatic policies and the
 * explicit human pending action call this function, so stale and duplicate
 * promotion behavior cannot diverge between the two paths.
 */
export async function applyPendingOutcome(
	store: TaskStore,
	taskId: unknown,
): Promise<PendingOutcomeResult> {
	if (typeof taskId !== 'string' || !/^TASK-\d+$/.test(taskId)) {
		return { kind: 'stale' };
	}

	const { tasks } = await store.readAll();
	const task = tasks.find((candidate) => candidate.id === taskId);
	if (!task) {
		return { kind: 'not-found' };
	}
	const pending = task.pendingOutcome;
	if (!pending) {
		return { kind: 'no-pending' };
	}

	const transition = applyPendingTransition(task, pending);
	if (!transition) {
		return { kind: 'stale' };
	}

	// A pending payload is only actionable while its receipt remains durable in
	// the append-only log. This rejects hand-edited, stale, or superseded data.
	const receipt = [...parseReceipts(task.sections['Log'] ?? '')].reverse().find((candidate) =>
		candidate.runId === pending.runId &&
		candidate.taskId === task.id &&
		candidate.stage === pending.stage &&
		candidate.result === pending.result,
	);
	if (!receipt) {
		return { kind: 'stale' };
	}

	const updates: Record<string, string | undefined> = {
		state: transition.state,
		status: transition.status,
		pending_outcome: undefined,
	};
	if (pending.gate === 'refineToScoped') {
		updates.scope_hash = pending.scopeHash;
	}

	try {
		await store.auditedPatch(task.id, updates, {
			action: 'apply-pending',
			runId: pending.runId,
			outcome: pending.result,
			expected: {
				state: task.state,
				status: task.status,
				pendingOutcome: pending,
			},
		});
	} catch (error) {
		if (error instanceof TaskMutationConflictError) {
			return { kind: 'stale' };
		}
		throw error;
	}
	return { kind: 'applied', gate: transition.gate };
}

function stageForRunningTask(task: { state: Column; sections: Record<string, string> }, runId: string): AuditStage {
	const start = parseAuditEvents(task.sections['Log'] ?? '')
		.reverse()
		.find((event) => event.kind === 'activity-start' && event.runId === runId);
	if (start?.stage) {
		return start.stage;
	}
	return task.state === 'in-progress' ? 'develop' : task.state === 'validation' ? 'validate' : 'refine';
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

	const events: AuditEventInput[] = task.status === 'running' && task.run
		? [{
			kind: 'activity-finish',
			runId: task.run,
			stage: stageForRunningTask(task, task.run),
			outcome: 'superseded',
			action: 'move',
			note: `Activity superseded by a manual move to ${destination}.`,
		}]
		: [];
	await store.auditedPatch(task.id, {
		state: destination,
		status: 'idle',
		run: undefined,
	}, {
		action: 'move',
		runId: task.run,
		outcome: task.status === 'running' ? 'superseded' : undefined,
		events,
	});
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

	await store.delete(taskId);
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
