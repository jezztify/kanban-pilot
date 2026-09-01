import * as vscode from 'vscode';
import {
	applyPendingOutcome as applyPendingTaskOutcome,
	invokeTaskAction,
	moveTask as moveTaskToColumn,
	reorderTask as reorderTaskInColumn,
} from '../board/actions';
import type { MoveOutcome, PendingOutcomeResult, ReorderOutcome } from '../board/actions';
import { TaskAction } from '../board/stateMachine';
import { Column, encodePendingOutcome, isTaskType, Status, Task } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { parseAuditEvents } from '../model/taskLog';
import type { AuditEventInput, AuditOutcome, AuditStage } from '../model/taskLog';
import { AgentNameOverrides, resolveAgentName } from './agentNames';
import { TranscriptTailService } from './transcriptTail';
import type { HookSpoolReceiver } from './hookSpool';
import { Executor, ExecutorResult } from './executor';
import { TASK_ATTACHMENT_CONTEXT, loadPromptTemplate, renderTemplate } from './promptTemplates';
import { proposalFingerprint, proposalsForRun } from './proposals';
import type { Proposal } from './proposals';
import {
	findReceiptDetails,
	formatReceipt,
	parseReceipts,
	Receipt,
	ReceiptExpectation,
	ReceiptIssue,
	ReceiptResult,
	Stage,
} from './receipt';
import { hashScope } from './scopeHash';
import { sessionIdForTaskBinding, sessionUriForTaskBinding } from './sessionUri';
import {
	GATE_CATALOG,
	receiptGateFor,
	STAGE_START_GATES,
	GateId,
	GatePolicy,
	StageStartGateDefinition,
} from '../model/gates';

/** §6.12: a run can propose at most this many follow-up tasks — a cap, not a target. */
const MAX_PROPOSALS_PER_RUN = 5;
const RECEIPT_GRACE_MS = 250;
const RECEIPT_POLL_MS = 10;
// The fallback must remain responsive when watcher events are coalesced with
// the timeout write; defer only long enough to let the usual watcher win.
const LATE_RECEIPT_INITIAL_DELAY_MS = 50;
const LATE_RECEIPT_GRACE_MS = 5_000;
const POST_RECEIPT_PROPOSAL_INITIAL_DELAY_MS = 50;
const POST_RECEIPT_PROPOSAL_POLL_MS = 50;
const POST_RECEIPT_PROPOSAL_GRACE_MS = 5_000;
const LATE_RECEIPT_MARKER = 'awaiting late receipt';
const appliedReceiptKeys = new Set<string>();
const inFlightReceiptKeys = new Set<string>();

class AdmissionMutex {
	private tail: Promise<void> = Promise.resolve();

	async run<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise((resolve) => (release = resolve));
		await previous;
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

/** Invalid settings must not disable the safety limit. */
export function normalizeMaxParallelTasks(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 1 ? value : 1;
}

/** Invalid timeout settings must not turn a run into an immediate timeout. */
export function normalizeTimeoutMinutes(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 20;
}

/**
 * Coordinates run admission across every RunManager instance for one workspace.
 * Persisted `running` tasks cover activation/reload; the in-memory
 * sets close the small admission window before a new task is marked running.
 */
class RunConcurrencyCoordinator {
	private readonly admission = new AdmissionMutex();
	private readonly pending = new Set<string>();
	private readonly active = new Set<string>();

	constructor(private readonly store: TaskStore) {}

	private key(taskId: string, runId: string): string {
		return `${this.store.setId}:${taskId}:${runId}`;
	}

	private hasReservationForTask(taskId: string): boolean {
		const prefix = `${this.store.setId}:${taskId}:`;
		return [...this.pending, ...this.active].some((key) => key.startsWith(prefix));
	}

	private syncActive(tasks: Task[]): void {
		for (const key of this.active) {
			const [, taskId, runId] = key.split(':');
			if (!tasks.some((task) => task.setId === this.store.setId && task.id === taskId && task.status === 'running' && task.run === runId)) {
				this.active.delete(key);
			}
		}
	}

	async reconcile(): Promise<void> {
		await this.admission.run(async () => {
			const { tasks } = await this.store.readAll();
			this.syncActive(tasks);
		});
	}

	async tryStart(
		taskId: string,
		runId: string,
		maxParallelTasks: number,
		starter: () => Promise<boolean>,
	): Promise<boolean> {
		return this.admission.run(async () => {
			const { tasks } = await this.store.readAll();
			this.syncActive(tasks);
			const occupiedReservations = new Set([
				...this.pending,
				...this.active,
				...tasks
					.filter((task) => task.status === 'running')
					.map((task) => this.key(task.id, task.run ?? 'persisted')),
			]);
			const reservationKey = this.key(taskId, runId);
			if (
				this.hasReservationForTask(taskId) ||
				occupiedReservations.size >= maxParallelTasks
			) {
				return false;
			}

			this.pending.add(reservationKey);
			try {
				const started = await starter();
				if (started) {
					this.active.add(reservationKey);
				}
				return started;
			} finally {
				this.pending.delete(reservationKey);
			}
		});
	}

	async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
		return this.admission.run(fn);
	}

	release(taskId: string, runId: string): void {
		const key = this.key(taskId, runId);
		this.active.delete(key);
		this.pending.delete(key);
	}
}

const coordinators = new Map<string, RunConcurrencyCoordinator>();

function coordinatorFor(workspaceFolder: vscode.WorkspaceFolder, store: TaskStore): RunConcurrencyCoordinator {
	const key = `${workspaceFolder.uri.toString()}::${store.setId}`;
	let coordinator = coordinators.get(key);
	if (!coordinator) {
		coordinator = new RunConcurrencyCoordinator(store);
		coordinators.set(key, coordinator);
	}
	return coordinator;
}

/**
 * §6.12: only these stages do real implementation/verification work that
 * could surface follow-ups worth filing *as a side effect*. Gated by
 * `allowTaskProposals` — off by default is never on the table (defaults
 * true), but it's an optional extra either way. `split` (§6.14) uses the
 * same underlying mechanism for a different, non-optional purpose — see its
 * own unconditional check at the call site below, not this set.
 */
const STAGES_THAT_MAY_PROPOSE: ReadonlySet<Stage> = new Set<Stage>(['develop', 'validate']);

/**
 * Orchestrates the run lifecycle (§6.4): two-phase invocation (an immediate
 * state-machine transition, then a background run), timeout, receipt
 * reconciliation, session-identity misroute detection (§6.9), and the
 * §6.8 stage-boundary layers. This is the `RunManager` box in §6.1's diagram.
 *
 * All agent stages are wired: `refine` (Backlog → Scoped), `split` (Refine →
 * Done with child proposals), `develop` (Approved → Validation), and
 * `validate` (Validation → Done or back to In Progress on a failed check).
 * `accept` and `approve` stay pure gates — see `stateMachine.ts`'s module doc
 * for why that split exists.
 *
 * §6.12: develop and validate runs may also each file a handful of follow-up
 * tasks (`propose-task` lines in `## Log`), turned into real backlog cards via
 * the ordinary `store.create` path — no state-machine changes, since a
 * proposed task is indistinguishable from a human-typed one once it lands,
 * beyond the `origin_task` marker that puts a badge on its card.
 *
 * §6.14: a fourth stage, `split`, reuses that same proposal mechanism as its
 * *primary* output rather than an optional extra (so it isn't gated by
 * `allowTaskProposals`) — it fans a task's request out into smaller ones and
 * retires the original as tracking-only (`state: done`) rather than
 * advancing it a column, the one stage whose `result:ok` doesn't mean what
 * every other stage's does.
 *
 * §6.15: `applyGatePolicies` is the M5 gate-policy engine — nine independent
 * `manual|auto` settings, each firing the same action path a click would,
 * so G3 ("gated by default") stays true of the *default*, not of the code
 * path once someone opts a gate into `auto`.
 */

interface RunManagerConfig {
	mode: string;
	transcriptFeed: boolean;
	sessionPrefix: string;
	toolsIncludeForRefine: string[];
	toolsExclude: string[];
	modelSelector?: { id?: string; vendor?: string };
	agentNames: AgentNameOverrides;
	timeoutMinutes: number;
	maxParallelTasks: number;
	resetOnApprove: boolean;
	closeTabOnDone: boolean;
	dockChat: boolean;
	dockChatOnSelect: boolean;
	allowTaskProposals: boolean;
	gatePolicies: Record<GateId, GatePolicy>;
}

function readConfig(): RunManagerConfig {
	const cfg = vscode.workspace.getConfiguration('kanbanPilot');
	return {
		mode: cfg.get<string>('chat.mode', 'agent'),
		transcriptFeed: cfg.get<boolean>('chat.transcriptFeed', false),
		sessionPrefix: cfg.get<string>('chat.sessionPrefix', 'kanban-pilot-'),
		toolsIncludeForRefine: cfg.get<string[]>('refine.toolsInclude', []),
		toolsExclude: cfg.get<string[]>('chat.toolsExclude', ['memory', 'resolveMemoryFileUri']),
		modelSelector: cfg.get<{ id?: string; vendor?: string }>('chat.modelSelector', {}),
		agentNames: cfg.get<AgentNameOverrides>('chat.agentNames', {}),
		timeoutMinutes: normalizeTimeoutMinutes(cfg.get<number>('run.timeoutMinutes', 20)),
		maxParallelTasks: normalizeMaxParallelTasks(cfg.get<number>('run.maxParallelTasks', 1)),
		resetOnApprove: cfg.get<boolean>('chat.resetOnApprove', false),
		closeTabOnDone: cfg.get<boolean>('chat.closeTabOnDone', true),
		dockChat: cfg.get<boolean>('layout.dockChat', true),
		dockChatOnSelect: cfg.get<boolean>('layout.dockChatOnSelect', false),
		allowTaskProposals: cfg.get<boolean>('chat.allowTaskProposals', true),
		gatePolicies: Object.fromEntries(
			GATE_CATALOG.map((gate) => [
				gate.id,
				cfg.get<GatePolicy>(gate.settingKey, gate.defaultPolicy),
			]),
		) as Record<GateId, GatePolicy>,
	};
}

function generateRunId(): string {
	return 'r' + Math.random().toString(36).slice(2, 8);
}

/** `p` racing a timer — never rejects on timeout, resolves the sentinel instead. */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
	let timer: ReturnType<typeof setTimeout>;
	const settled = p.then<
		{ kind: 'value'; value: T } | { kind: 'error'; error: unknown },
		{ kind: 'value'; value: T } | { kind: 'error'; error: unknown }
	>(
		(value) => {
			clearTimeout(timer);
			return { kind: 'value', value };
		},
		(error) => {
			clearTimeout(timer);
			return { kind: 'error', error };
		},
	);
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), ms);
	});
	return Promise.race([settled, timeout]).then((winner) => {
		if (winner === 'timeout') {
			return winner;
		}
		if (winner.kind === 'error') {
			throw winner.error;
		}
		return winner.value;
	});
}

/** Which stage a card's current column implies — used to resume Continue and to label manual/reconciled receipts. */
function stageForColumn(state: Column): Stage {
	if (state === 'validation') {
		return 'validate';
	}
	if (state === 'in-progress') {
		return 'develop';
	}
	return 'refine';
}

function stageForRun(task: Task, runId: string, fallback: Stage): Stage {
	const start = parseAuditEvents(task.sections['Log'] ?? '')
		.reverse()
		.find((event) => event.kind === 'activity-start' && event.runId === runId);
	return (start?.stage as AuditStage | undefined) ?? fallback;
}

function columnForStage(stage: Stage): Column {
	if (stage === 'validate') {
		return 'validation';
	}
	if (stage === 'develop') {
		return 'in-progress';
	}
	return 'refine';
}

function shouldDockActionChat(action: TaskAction): boolean {
	return action === 'refine' || action === 'develop' || action === 'validate';
}

function isLateReceiptMarker(receipt: Receipt): boolean {
	return (
		(receipt.result === 'blocked' && receipt.note.endsWith(LATE_RECEIPT_MARKER)) ||
		(receipt.result === 'failed' && receipt.note === `timed out; ${LATE_RECEIPT_MARKER}`)
	);
}

function isTimeoutReceiptMarker(receipt: Receipt): boolean {
	return receipt.result === 'failed' && receipt.note === `timed out; ${LATE_RECEIPT_MARKER}`;
}

function canAwaitLateReceipt(task: Task, marker: Receipt): boolean {
	return (
		(marker.result === 'blocked' && task.status === 'blocked') ||
		(isTimeoutReceiptMarker(marker) && task.status === 'failed')
	);
}

function latestLateReceiptMarker(task: Task): Receipt | undefined {
	return [...parseReceipts(task.sections['Log'] ?? '')]
		.reverse()
		.find((receipt) => receipt.taskId === task.id && isLateReceiptMarker(receipt));
}

function sameReceipt(a: Receipt, b: Receipt): boolean {
	return (
		a.runId === b.runId &&
		a.taskId === b.taskId &&
		a.stage === b.stage &&
		a.result === b.result &&
		a.note === b.note
	);
}

interface LateReceiptPair {
	marker: Receipt;
	receipt: Receipt;
}

export interface StaleCompletionCandidate {
	taskId: string;
	runId: string;
	stage: Stage;
	result: 'ok';
	note: string;
	summary: string;
	currentRunId?: string;
	latestRunId?: string;
	supersededByRunId?: string;
}

export type StaleCompletionRecoveryResult =
	| { kind: 'recovered'; runId: string; stage: Stage; gate?: GateId }
	| { kind: 'not-found' }
	| { kind: 'invalid' }
	| { kind: 'no-candidate' }
	| { kind: 'active-run' }
	| { kind: 'pending-outcome' }
	| { kind: 'stale' };

interface IndexedReceipt {
	receipt: Receipt;
	lineIndex: number;
}

interface IndexedAuditEvent {
	event: ReturnType<typeof parseAuditEvents>[number];
	lineIndex: number;
}

interface ValidatedStaleCompletion {
	candidate: StaleCompletionCandidate;
	receipt: Receipt;
	receiptLineIndex: number;
}

interface ProposalProcessingResult {
	accepted: number;
	persisted: number;
	created: number;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TabGroupsLike {
	readonly all: readonly vscode.TabGroup[];
	close(tab: vscode.Tab | readonly vscode.Tab[], preserveFocus?: boolean): Thenable<boolean>;
}

export type CommandExecutor = <T>(command: string, ...args: unknown[]) => Thenable<T>;

export type RunChangeKind =
	| 'start'
	| 'progress'
	| 'stop'
	| 'blocked'
	| 'failed'
	| 'receipt'
	| 'pending-outcome'
	| 'promotion'
	| 'timeout'
	| 'completion';

export interface RunManagerChange {
	kind: RunChangeKind;
	taskId?: string;
	runId?: string;
	stage?: Stage;
	/** Display-only elapsed time; durable state is always read from the store. */
	elapsedMs?: number;
	note?: string;
}

export async function closeTaskChatTabs(sessionUri: vscode.Uri, tabGroups: TabGroupsLike): Promise<void> {
	const tabs = tabGroups.all.flatMap((group) => group.tabs).filter((tab) => {
		const input = tab.input;
		if (!input || typeof input !== 'object' || !('uri' in input)) {
			return false;
		}
		const uri = (input as { uri?: vscode.Uri }).uri;
		return !!uri && uri.toString() === sessionUri.toString();
	});
	if (!tabs.length) {
		return;
	}
	try {
		await tabGroups.close(tabs, true);
	} catch {
		// Closing a convenience tab must never change the completed task outcome.
	}
}

export class RunManager {
	private readonly concurrency: RunConcurrencyCoordinator;
	private readonly postReceiptProposalRuns = new Set<string>();
	private readonly ownedReservations = new Map<string, { taskId: string; runId: string }>();
	private readonly activeExecutorRuns = new Map<string, Task>();
	private readonly changed = new vscode.EventEmitter<RunManagerChange>();
	private readonly progressTimers = new Set<ReturnType<typeof setInterval>>();
	private disposed = false;
	private readonly hookFeedSubscription: vscode.Disposable | undefined;

	constructor(
		private readonly store: TaskStore,
		private readonly executor: Executor,
		private readonly workspaceFolder: vscode.WorkspaceFolder,
		private readonly tabGroups: TabGroupsLike = vscode.window.tabGroups,
		private readonly executeCommand: CommandExecutor = vscode.commands.executeCommand.bind(vscode.commands),
		private readonly trace: (message: string) => void = () => {},
		/** Optional read-only transcript tail (TASK-008); absent in tests and when unwired. */
		readonly transcriptTail?: TranscriptTailService,
		/** Optional real-time hook feed receiver (TASK-015). */
		readonly hookSpool?: HookSpoolReceiver,
	) {
		this.concurrency = coordinatorFor(workspaceFolder, store);
		// A hook spool write touches no task file, so nothing would republish the
		// projection on its own. Re-firing it as a run change routes it through the
		// same path the board and the browser already listen on.
		this.hookFeedSubscription = hookSpool?.onDidChange((taskId) => {
			this.notify({ kind: 'progress', taskId });
		});
	}

	onDidChange(listener: (change: RunManagerChange) => void): vscode.Disposable {
		return this.changed.event(listener);
	}

	private notify(change: RunManagerChange): void {
		if (!this.disposed) {
			this.changed.fire(change);
		}
	}

	private reservationKey(taskId: string, runId: string): string {
		return `${taskId}\u0000${runId}`;
	}

	private releaseReservation(taskId: string, runId: string): void {
		this.concurrency.release(taskId, runId);
		this.ownedReservations.delete(this.reservationKey(taskId, runId));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.hookFeedSubscription?.dispose();
		for (const { taskId, runId } of this.ownedReservations.values()) {
			this.releaseReservation(taskId, runId);
		}
		this.ownedReservations.clear();
		this.activeExecutorRuns.clear();
		for (const timer of this.progressTimers) {
			clearInterval(timer);
		}
		this.progressTimers.clear();
		this.changed.dispose();
	}

	/**
	 * The single entry point for both the webview and the palette commands
	 * (mirrors §7's "every card action is also a palette command").
	 */
	async handleAction(taskId: string, action: TaskAction): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.trace(`handleAction task=${taskId} action=${action}`);
		switch (action) {
			case 'refine':
				await this.startStageRun(taskId, action, 'refine');
				return;

			case 'split':
				await this.startStageRun(taskId, action, 'split');
				return;

			case 'develop':
				await this.startStageRun(taskId, action, 'develop');
				return;

			case 'continue':
				// Always resumes a develop run — In Progress is the only column
				// whose primary action becomes "Continue" (§5.2); Validation always
				// shows "Validate" for its own retries instead.
				await this.startStageRun(taskId, action, 'develop');
				return;

			case 'validate':
				await this.startStageRun(taskId, action, 'validate');
				return;

			case 'approve': {
				const outcome = await invokeTaskAction(this.store, taskId, action);
				if (!this.disposed && outcome.kind === 'applied' && readConfig().resetOnApprove) {
					await this.resetSession(taskId);
				}
				return;
			}

			case 'stop': {
				await this.concurrency.runExclusive(async () => {
					if (this.disposed) {
						return;
					}
					const { tasks } = await this.store.readAll();
					if (this.disposed) {
						return;
					}
					const task = tasks.find((candidate) => candidate.id === taskId);
					const runId = task?.run;
					if (task && runId) {
						const activeTask = this.activeExecutorRuns.get(this.reservationKey(taskId, runId));
						if (activeTask) {
							const cfg = readConfig();
							const cancellation = this.executor.cancel
								? await this.executor.cancel(activeTask, {
										mode: cfg.mode,
										sessionPrefix: cfg.sessionPrefix,
									})
								: { kind: 'failed' as const, error: 'The configured chat executor does not support cancellation.' };
							if (this.disposed) {
								return;
							}
							if (cancellation.kind === 'failed') {
								const note = `Could not stop the Copilot turn for ${taskId}: ${cancellation.error}`;
								this.notify({ kind: 'failed', taskId, runId, stage: stageForRun(task, runId, stageForColumn(task.state)), note });
								void vscode.window.showErrorMessage(note);
								return;
							}
						}
					}
					const outcome = await invokeTaskAction(
						this.store,
						taskId,
						action,
						runId
							? {
									activityFinish: {
										runId,
										stage: stageForRun(task, runId, stageForColumn(task.state)),
										outcome: 'stopped',
										note: 'Activity stopped by the user.',
									},
								}
							: undefined,
					);
						if (this.disposed) {
							return;
						}
					if (outcome.kind === 'applied') {
						if (runId) {
							this.releaseReservation(taskId, runId);
						}
						this.notify({
							kind: 'stop',
							taskId,
							runId,
							stage: task && runId ? stageForRun(task, runId, stageForColumn(task.state)) : undefined,
						});
					}
				});
				return;
			}

			// accept, reopen: pure gates, no run.
			default:
				await invokeTaskAction(this.store, taskId, action);
				return;
		}
	}

	async moveTask(taskId: unknown, destination: unknown): Promise<MoveOutcome> {
		if (this.disposed) {
			return { kind: 'not-found' };
		}
		this.trace(`moveTask task=${String(taskId)} destination=${String(destination)}`);
		return this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				return { kind: 'not-found' };
			}
			const { tasks } = await this.store.readAll();
			if (this.disposed) {
				return { kind: 'not-found' };
			}
			const runId = typeof taskId === 'string' ? tasks.find((task) => task.id === taskId)?.run : undefined;
			const outcome = await moveTaskToColumn(this.store, taskId, destination);
			if (this.disposed) {
				return outcome;
			}
			if (outcome.kind === 'applied' && runId) {
				this.releaseReservation(taskId as string, runId);
			}
			if (outcome.kind === 'applied' && destination === 'done' && typeof taskId === 'string') {
				const cfg = readConfig();
				if (cfg.closeTabOnDone) {
					await this.closeTaskChatTab(taskId, cfg);
				}
			}
			return outcome;
		});
	}

	/**
	 * Reorders a card without touching its state or run. Admission serialization
	 * prevents a stale board intent from racing a stage transition, while the
	 * reorder path itself never releases an active run.
	 */
	async reorderTask(taskId: unknown, column: unknown, target: unknown): Promise<ReorderOutcome> {
		if (this.disposed) {
			return { kind: 'stale' };
		}
		return this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				return { kind: 'stale' };
			}
			return reorderTaskInColumn(this.store, taskId, column, target);
		});
	}

	/** Applies one durable receipt outcome through the same path used by auto gates. */
	async applyPendingOutcome(taskId: string): Promise<PendingOutcomeResult> {
		if (this.disposed) {
			return { kind: 'stale' };
		}
		this.trace(`applyPendingOutcome task=${taskId}`);
		let outcome!: PendingOutcomeResult;
		await this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				outcome = { kind: 'stale' };
				return;
			}
			outcome = await this.applyPendingOutcomeWithinLock(taskId);
		});
		return outcome;
	}

	private async applyPendingOutcomeWithinLock(taskId: string): Promise<PendingOutcomeResult> {
		if (this.disposed) {
			return { kind: 'stale' };
		}
		const outcome = await applyPendingTaskOutcome(this.store, taskId);
		if (this.disposed) {
			return outcome;
		}
		if (
			outcome.kind === 'applied' &&
			(outcome.gate === 'validateToDone' || outcome.gate === 'splitToDone')
		) {
			const cfg = readConfig();
			if (cfg.closeTabOnDone) {
				await this.closeTaskChatTab(taskId, cfg);
			}
		}
		if (outcome.kind === 'applied') {
			this.notify({ kind: 'promotion', taskId, note: `Applied ${outcome.gate}.` });
		}
		return outcome;
	}

	/** §6.10: open the task's session, beside the board when automatic docking is enabled. */
	async dockTaskChat(taskId: string, opts: { onSelect: boolean; explicit?: boolean }): Promise<void> {
		if (this.disposed) {
			return;
		}
		this.trace(`dockTaskChat task=${taskId} onSelect=${opts.onSelect} explicit=${opts.explicit === true}`);
		const cfg = readConfig();
		if (!opts.explicit && (!cfg.dockChat || (opts.onSelect && !cfg.dockChatOnSelect))) {
			return;
		}
		const chat = await this.resolveTaskChat(taskId, cfg, true);
		if (this.disposed || !chat) {
			return;
		}
		try {
			if (this.disposed) {
				return;
			}
			await this.executeCommand('vscode.open', chat.uri, {
				...(cfg.dockChat ? { viewColumn: vscode.ViewColumn.Beside } : {}),
				preserveFocus: true,
				preview: true,
			});
		} catch {
			// Docking is a convenience; a task with no session yet (never run) has
			// nothing to open, and that's fine — the first run will mint it.
		}
	}

	/** `Kanban Pilot: Mark Run Complete` (§6.4) — the escape hatch for a missing receipt. */
	async markRunComplete(taskId: string, result: ReceiptResult, note: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				return;
			}
			const { tasks } = await this.store.readAll();
			if (this.disposed) {
				return;
			}
			const task = tasks.find((t) => t.id === taskId);
			if (!task?.run) {
				return;
			}
			const runId = task.run;
			const stage = stageForRun(task, runId, stageForColumn(task.state));

			try {
				if (this.disposed) {
					return;
				}
				await this.store.appendLog(taskId, formatReceipt({ runId, taskId, stage, result, note }));
				if (this.disposed) {
					return;
				}
				await this.applyOutcome(taskId, runId, stage, result, task.sections['Scope'], { note, action: 'manual-complete' });
				if (this.disposed) {
					return;
				}
				this.notify({ kind: 'completion', taskId, runId, stage, note });
			} finally {
				this.releaseReservation(taskId, runId);
			}
		});
	}

	/**
	 * Lists successful receipts that are eligible for explicit human-confirmed
	 * stale completion recovery. This is deliberately separate from ordinary
	 * reconciliation: a receipt from an older run is never adopted merely
	 * because it exists in the task log.
	 */
	async listStaleCompletionCandidates(taskId?: string): Promise<StaleCompletionCandidate[]> {
		if (this.disposed) {
			return [];
		}
		const { tasks } = await this.store.readAll();
		return tasks
			.filter((task) => !taskId || task.id === taskId)
			.flatMap((task) => this.validatedStaleCompletions(task).map(({ candidate }) => candidate));
	}

	/**
	 * Explicitly adopts one validated successful receipt from an earlier run.
	 * The task, receipt, and extension-owned history are all re-read while the
	 * workspace coordinator is held. No executor is invoked on this path.
	 */
	async recoverStaleCompletion(
		taskId: string,
		runId: string,
		stage: Stage,
	): Promise<StaleCompletionRecoveryResult> {
		if (this.disposed) {
			return { kind: 'stale' };
		}
		if (!/^TASK-\d+$/.test(taskId) || !/^[A-Za-z0-9._:/-]+$/.test(runId) || !this.isStage(stage)) {
			return { kind: 'invalid' };
		}

		let outcome: StaleCompletionRecoveryResult = { kind: 'stale' };
		await this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				return;
			}
			const current = (await this.store.readAll()).tasks.find((task) => task.id === taskId);
			if (this.disposed) {
				return;
			}
			if (!current) {
				outcome = { kind: 'not-found' };
				return;
			}
			if (current.run) {
				outcome = { kind: 'active-run' };
				return;
			}
			if (current.pendingOutcome) {
				outcome = { kind: 'pending-outcome' };
				return;
			}

			const validated = this.validatedStaleCompletions(current).find(({ candidate }) =>
				candidate.runId === runId && candidate.stage === stage,
			);
			if (!validated) {
				outcome = { kind: 'no-candidate' };
				return;
			}

			await this.applyReceipt(
				taskId,
				runId,
				stage,
				validated.receipt,
				(candidate) => this.validatedStaleCompletions(candidate).some(({ candidate: item }) =>
					item.runId === runId && item.stage === stage,
				),
				{ action: 'manual-recovery', correction: true, withinLock: true, transitionAction: 'late-receipt' },
			);
			if (this.disposed) {
				return;
			}

			const after = (await this.store.readAll()).tasks.find((task) => task.id === taskId);
			const recovered = after && parseAuditEvents(after.sections['Log'] ?? '').some((event) =>
				event.kind === 'activity-finish' &&
				event.taskId === taskId &&
				event.runId === runId &&
				event.stage === stage &&
				event.action === 'manual-recovery' &&
				event.correction === true &&
				event.outcome === 'ok',
			);
			if (recovered) {
				outcome = {
					kind: 'recovered',
					runId,
					stage,
					gate: receiptGateFor(stage, 'ok')?.id,
				};
			}
		});
		return outcome;
	}

	/**
	 * On activation, any task left `running` had its in-memory run state lost
	 * to the reload (§6.4). Reconciles against whatever the file shows now.
	 */
	async reconcileOnActivation(): Promise<void> {
		if (this.disposed) {
			return;
		}
		await this.concurrency.reconcile();
		if (this.disposed) {
			return;
		}
		const { tasks } = await this.store.readAll();
		if (this.disposed) {
			return;
		}
		for (const task of tasks) {
			if (this.disposed) {
				return;
			}
			if (task.status !== 'running' || !task.run) {
				continue;
			}
			const runId = task.run;
			const stage = stageForRun(task, runId, stageForColumn(task.state));
			try {
				const details = findReceiptDetails(task.sections['Log'] ?? '', { runId, taskId: task.id, stage });

				if (details.receipt) {
					await this.applyReceipt(task.id, runId, stage, details.receipt, (candidate) => candidate.run === runId);
				} else {
					await this.recordReceiptIssues(task.id, { runId, taskId: task.id, stage }, details.issues);
					await this.markMissingReceipt(task.id, runId, stage, 'interrupted by window reload; no receipt found');
				}
			} catch (error) {
				if (this.disposed) {
					return;
				}
				await this.recordReconciliationFailure(task.id, error);
			} finally {
				this.concurrency.release(task.id, runId);
			}
		}

		for (const reconcile of [
			() => this.reconcileLateReceipts(),
			() => this.reconcileOrdinaryProposals(),
			() => this.reconcilePendingOutcomes(),
		]) {
			if (this.disposed) {
				return;
			}
			try {
				await reconcile();
				if (this.disposed) {
					return;
				}
			} catch (error) {
				if (this.disposed) {
					return;
				}
				await this.recordReconciliationFailure(undefined, error);
			}
		}
	}

	/** Reconciles a receipt that arrived after the extension's no-receipt fallback. */
	async reconcileTaskChange(taskId?: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		try {
			await this.concurrency.reconcile();
			if (this.disposed) {
				return;
			}
			await this.reconcileLateReceipts(taskId);
			if (this.disposed) {
				return;
			}
			await this.reconcileOrdinaryProposals(taskId);
			if (this.disposed) {
				return;
			}
			await this.reconcilePendingOutcomes(taskId);
		} catch (error) {
			if (this.disposed) {
				return;
			}
			await this.recordReconciliationFailure(taskId, error);
		}
	}

	/**
	 * §6.15: sweeps every task once, firing whichever gate actions are both
	 * legal and configured to `auto`, through the same `handleAction` a click
	 * would use — so an auto-fired transition is indistinguishable from a
	 * human one once it lands. A single pass, not a loop to convergence: each
	 * fired action is a real disk write, which re-triggers whatever calls this
	 * (the store watcher, §6.15), so a multi-gate cascade — e.g. a task
	 * sailing from Scoped through to a running develop — resolves over a
	 * couple of reactive ticks rather than needing this method to chase it in
	 * one call.
	 *
	 * Retries are never auto-fired, whatever the policy: a task sitting
	 * `blocked`/`failed` means something needs a human's judgment, not a
	 * repeat click, so every check below is scoped to `status === 'idle'`.
	 *
	 * Every agent stage uses the same coordinator, so an automatic gate cannot
	 * start a run merely because its own column appears free: Refine, Split,
	 * Develop/Continue, and Validate all consume the configured capacity.
	 * Capacity denial is deliberately a no-op, leaving the task in its ready
	 * column for a later sweep.
	 */
	async applyGatePolicies(): Promise<void> {
		if (this.disposed) {
			return;
		}
		const cfg = readConfig();
		await this.concurrency.reconcile();
		if (this.disposed) {
			return;
		}
		const promoted = await this.reconcilePendingOutcomes(undefined, cfg);
		if (this.disposed) {
			return;
		}
		const { tasks } = await this.store.readAll();

		for (const task of tasks) {
			if (this.disposed) {
				return;
			}
			if (promoted.has(task.id) || task.status !== 'idle' || task.pendingOutcome) {
				continue;
			}

			const gate = STAGE_START_GATES.find((candidate) =>
				candidate.source === task.state && cfg.gatePolicies[candidate.id] === 'auto',
			);
			if (!gate) {
				continue;
			}

			if (gate.beforeAction) {
				await this.startStageRun(task.id, gate.action, gate.stage, gate.beforeAction);
			} else if (gate.action === 'approve') {
				await this.handleAction(task.id, gate.action);
			} else {
				await this.startStageRun(task.id, gate.action, gate.stage);
			}
			if (this.disposed) {
				return;
			}
		}
	}

	private async reconcilePendingOutcomes(
		taskId?: string,
		providedConfig?: RunManagerConfig,
	): Promise<Set<string>> {
		const cfg = providedConfig ?? readConfig();
		const promoted = new Set<string>();
		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if (this.disposed) {
				return promoted;
			}
			if (taskId && task.id !== taskId || !task.pendingOutcome) {
				continue;
			}
			if (cfg.gatePolicies[task.pendingOutcome.gate] !== 'auto') {
				continue;
			}
			const outcome = await this.applyPendingOutcome(task.id);
			if (this.disposed) {
				return promoted;
			}
			if (outcome.kind === 'applied') {
				promoted.add(task.id);
			}
		}
		return promoted;
	}

	// ---- launching a stage run -------------------------------------------

	private async startStageRun(taskId: string, action: TaskAction, stage: Stage, beforeAction?: TaskAction): Promise<void> {
		if (this.disposed) {
			return;
		}
		const cfg = readConfig();
		const runId = generateRunId();
		// Stage runs never issue `workbench.action.chat.newChat`. Opening the
		// task's derived `vscode-chat-session://local` URI is the whole binding
		// (M0 findings 4–5): the first open creates that task-unique session and
		// every later open reopens the same one idempotently, so injecting into it
		// continues the one conversation. Issuing New Chat here instead spins the
		// conversation off into a separate Copilot-managed chat divorced from the
		// derived session, which is why a fresh empty chat appeared on the next
		// stage/move. New Chat stays reserved for the explicit approval reset path.
		const newChatBefore = false;
		const started = await this.concurrency.tryStart(taskId, runId, cfg.maxParallelTasks, async () => {
			if (this.disposed) {
				return false;
			}
			if (beforeAction) {
				const prepared = await invokeTaskAction(this.store, taskId, beforeAction);
				if (this.disposed) {
					return false;
				}
				if (prepared.kind !== 'applied') {
					return false;
				}
			}

			const applied = await invokeTaskAction(this.store, taskId, action);
			if (this.disposed) {
				return false;
			}
			if (applied.kind !== 'applied') {
				return false;
			}

			const { tasks } = await this.store.readAll();
			if (this.disposed) {
				return false;
			}
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) {
				return false;
			}

			const sessionId = sessionIdForTaskBinding(task, cfg.sessionPrefix, this.store.setId);
			await this.store.auditedPatch(
				taskId,
				{
					status: 'running',
					run: runId,
					chat: sessionId,
				},
				{
					action,
					runId,
					events: [{
						kind: 'activity-start',
						stage,
						runId,
						action,
						note: `Started ${stage} activity.`,
					}],
				},
			);
			if (this.disposed) {
				return false;
			}
			return true;
		});
		if (!started) {
			return;
		}
		this.ownedReservations.set(this.reservationKey(taskId, runId), { taskId, runId });
		if (this.disposed) {
			this.releaseReservation(taskId, runId);
			return;
		}
		this.notify({ kind: 'start', taskId, runId, stage });

		// Fire-and-forget: the board reflects state via the file watcher, not a
		// held promise. Errors are caught inside — this never rejects.
		void this.runStage(taskId, runId, stage, cfg, cfg.dockChat && shouldDockActionChat(action), newChatBefore);
	}

	private async runStage(
		taskId: string,
		runId: string,
		stage: Stage,
		cfg: RunManagerConfig,
		openBeside: boolean,
		newChatBefore: boolean,
	): Promise<void> {
		if (this.disposed) {
			this.releaseReservation(taskId, runId);
			return;
		}
		const startedAt = Date.now();
		const progressTimer = setInterval(() => {
			this.notify({
				kind: 'progress',
				taskId,
				runId,
				stage,
				elapsedMs: Math.min(Date.now() - startedAt, 24 * 60 * 60 * 1000),
			});
		}, 1000);
		this.progressTimers.add(progressTimer);
		try {
			const { tasks } = await this.store.readAll();
			if (this.disposed) {
				return;
			}
			const task = tasks.find((t) => t.id === taskId);
			if (!task || task.status !== 'running' || task.run !== runId) {
				return;
			}

			const currentScope = task.sections['Scope'] ?? '';
			const scopeEdited =
				stage === 'develop' && !!task.scopeHash && task.scopeHash !== hashScope(currentScope);

			const template = await loadPromptTemplate(this.workspaceFolder, stage);
			if (this.disposed) {
				return;
			}
			const attachmentUris = await this.store.attachmentUrisForTask(task.id);
			if (this.disposed) {
				return;
			}
			const renderedPrompt = renderTemplate(template, {
				id: task.id,
				title: task.title,
				agentName: resolveAgentName(stage, cfg.agentNames),
				projectName: this.workspaceFolder.name,
				runId,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: currentScope,
				taskFilePath: this.store.fileFor(task.id).fsPath,
				scopeEdited,
			});
			const prompt = renderedPrompt.includes('Any image files attached after it are also task input')
				? renderedPrompt
				: `${renderedPrompt.trimEnd()}\n${TASK_ATTACHMENT_CONTEXT}`;

			const timeoutMs = cfg.timeoutMinutes * 60_000;
			const latest = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !latest || latest.status !== 'running' || latest.run !== runId) {
				return;
			}
			const executorRunKey = this.reservationKey(taskId, runId);
			this.activeExecutorRuns.set(executorRunKey, latest);
			if (cfg.transcriptFeed) {
				// A first run has no copilot_session_id yet — it is harvested from the
				// turn's terminal result — so the tail falls back to watching the
				// directory for a file that was not there when this run started.
				await this.transcriptTail?.start(taskId, {
					...(latest.copilotSessionId ? { sessionId: latest.copilotSessionId } : {}),
				});
			}
			const outcome = await raceWithTimeout(
				this.executor.run(latest, this.store.fileFor(latest.id), prompt, stage, {
					mode: cfg.mode,
					sessionPrefix: cfg.sessionPrefix,
					toolsIncludeForRefine: cfg.toolsIncludeForRefine,
					toolsExclude: cfg.toolsExclude,
					...(newChatBefore ? { newChatBefore: true } : {}),
					attachmentUris,
					openBeside,
					modelSelector: cfg.modelSelector,
					// Same value the prompt's persona line renders. The executor sends it
					// as the payload's mode, which is what actually selects the agent.
					agentName: resolveAgentName(stage, cfg.agentNames),
				}),
				timeoutMs,
			);
			if (this.disposed) {
				return;
			}

			if (outcome === 'timeout') {
				await this.reconcile(taskId, runId, stage, { kind: 'timeout' });
			} else {
				await this.reconcile(taskId, runId, stage, { kind: 'executor', result: outcome });
			}
		} catch (e) {
			await this.reconcile(taskId, runId, stage, {
				kind: 'executor',
				result: { ok: false, error: e instanceof Error ? e.message : String(e) },
			});
		} finally {
			this.transcriptTail?.stop(taskId);
			this.activeExecutorRuns.delete(this.reservationKey(taskId, runId));
			clearInterval(progressTimer);
			this.progressTimers.delete(progressTimer);
			this.notify({ kind: 'completion', taskId, runId, stage });
			this.releaseReservation(taskId, runId);
		}
	}

	// ---- reconciliation (§6.2, §6.4, §6.9) ------------------------------

	private isStage(value: unknown): value is Stage {
		return value === 'refine' || value === 'develop' || value === 'validate' || value === 'split';
	}

	private indexedTaskLog(task: Task): { receipts: IndexedReceipt[]; audits: IndexedAuditEvent[] } {
		const receipts: IndexedReceipt[] = [];
		const audits: IndexedAuditEvent[] = [];
		for (const [lineIndex, line] of (task.sections['Log'] ?? '').split(/\r?\n/).entries()) {
			const lineReceipts = parseReceipts(line);
			if (lineReceipts[0]) {
				receipts.push({ receipt: lineReceipts[0], lineIndex });
			}
			const lineAudits = parseAuditEvents(line);
			if (lineAudits[0]) {
				audits.push({ event: lineAudits[0], lineIndex });
			}
		}
		return { receipts, audits };
	}

	/**
	 * Correlates a canonical success with the extension's own start and
	 * provisional terminal history. Every rejection here is intentional:
	 * recovery must never turn an arbitrary log line, a manually moved card, or
	 * an unresolved newer run into a completion.
	 */
	private validatedStaleCompletions(task: Task): ValidatedStaleCompletion[] {
		if (
			task.run ||
			task.pendingOutcome ||
			(task.status !== 'failed' && task.status !== 'blocked')
		) {
			return [];
		}

		const { receipts, audits } = this.indexedTaskLog(task);
		const candidates: ValidatedStaleCompletion[] = [];
		const seen = new Set<string>();
		for (const indexedReceipt of [...receipts].reverse()) {
			const receipt = indexedReceipt.receipt;
			const key = `${receipt.runId}:${receipt.stage}`;
			if (
				seen.has(key) ||
				receipt.taskId !== task.id ||
				receipt.result !== 'ok' ||
				task.state !== columnForStage(receipt.stage)
			) {
				continue;
			}

			const start = [...audits].reverse().find(({ event, lineIndex }) =>
				event.kind === 'activity-start' &&
				event.taskId === task.id &&
				event.stage === receipt.stage &&
				event.runId === receipt.runId &&
				lineIndex < indexedReceipt.lineIndex,
			);
			if (!start) {
				continue;
			}

			const marker = [...receipts].reverse().find(({ receipt: candidate, lineIndex }) =>
				candidate.taskId === task.id &&
				candidate.runId === receipt.runId &&
				candidate.stage === receipt.stage &&
				isLateReceiptMarker(candidate) &&
				lineIndex > start.lineIndex &&
				lineIndex < indexedReceipt.lineIndex,
			);
			const terminal = [...audits].reverse().find(({ event, lineIndex }) =>
				event.kind === 'activity-finish' &&
				event.taskId === task.id &&
				event.stage === receipt.stage &&
				event.runId === receipt.runId &&
				event.provisional === true &&
				(event.outcome === 'timeout' || event.outcome === 'missing-receipt' || event.outcome === 'blocked') &&
				lineIndex > start.lineIndex &&
				lineIndex < indexedReceipt.lineIndex,
			);
			if (!marker || !terminal || indexedReceipt.lineIndex <= Math.max(marker.lineIndex, terminal.lineIndex)) {
				continue;
			}

			const historyAfterStart = audits.filter(({ event, lineIndex }) =>
				event.taskId === task.id && lineIndex > start.lineIndex,
			);
			if (historyAfterStart.some(({ event }) =>
				event.kind === 'state-change' ||
				event.correction === true ||
				event.action === 'manual-recovery' ||
				(event.kind === 'activity-finish' &&
					event.runId === receipt.runId &&
					(event.outcome === 'ok' || event.outcome === 'stopped' || event.outcome === 'superseded')) ||
				(event.kind === 'activity-finish' &&
					event.runId === receipt.runId &&
					event.outcome === 'error' &&
					event.action === 'manual-complete')
			)) {
				continue;
			}

			const laterStarts = audits.filter(({ event, lineIndex }) =>
				event.kind === 'activity-start' &&
				event.taskId === task.id &&
				event.stage === receipt.stage &&
				lineIndex > start.lineIndex,
			);
			let invalidated = false;
			for (const laterStart of laterStarts) {
				const laterFinishes = audits.filter(({ event, lineIndex }) =>
					event.kind === 'activity-finish' &&
					event.taskId === task.id &&
					event.stage === receipt.stage &&
					event.runId === laterStart.event.runId &&
					lineIndex > laterStart.lineIndex,
				);
				if (
					laterFinishes.length === 0 ||
					laterFinishes.some(({ event }) =>
						event.outcome === 'ok' || event.outcome === 'stopped' || event.outcome === 'superseded',
					)
				) {
					invalidated = true;
					break;
				}
			}
			if (invalidated) {
				continue;
			}

			const latestStart = [...audits].reverse().find(({ event }) =>
				event.kind === 'activity-start' &&
				event.taskId === task.id &&
				event.stage === receipt.stage,
			);
			const latestRunId = latestStart?.event.runId ?? receipt.runId;
			seen.add(key);
			candidates.push({
				candidate: {
					taskId: task.id,
					runId: receipt.runId,
					stage: receipt.stage,
					result: 'ok',
					note: receipt.note,
					summary: receipt.note,
					currentRunId: task.run,
					latestRunId,
					supersededByRunId: latestRunId === receipt.runId ? undefined : latestRunId,
				},
				receipt,
				receiptLineIndex: indexedReceipt.lineIndex,
			});
		}
		return candidates.reverse();
	}

	private async reconcileLateReceipts(taskId?: string): Promise<void> {
		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if (taskId && task.id !== taskId) {
				continue;
			}

			const marker = latestLateReceiptMarker(task);
			const late = this.findLateReceipt(task);
			if (!late) {
				if (marker && !task.run && canAwaitLateReceipt(task, marker) && task.state === columnForStage(marker.stage)) {
					const expected: ReceiptExpectation = { runId: marker.runId, taskId: task.id, stage: marker.stage };
					const details = findReceiptDetails(task.sections['Log'] ?? '', expected);
					await this.recordReceiptIssues(task.id, expected, details.issues);
				}
				continue;
			}
			if (!canAwaitLateReceipt(task, late.marker) || task.run) {
				continue;
			}

			const stage = late.marker.stage;
			if (task.state !== columnForStage(stage) || late.receipt.stage !== stage) {
				continue;
			}

			await this.applyReceipt(
				task.id,
				late.marker.runId,
				stage,
				late.receipt,
				(candidate) => this.isLateReceiptCandidate(candidate, late.marker, late.receipt),
			);
		}
	}

	/**
	 * Finds settled Develop/Validate receipts whose optional proposals were not
	 * visible during the first receipt pass. The activity audit pair is the
	 * durable run identity: it prevents a receipt from an older run, or a
	 * hand-written unrelated receipt, from being replayed after a later retry.
	 */
	private async reconcileOrdinaryProposals(taskId?: string): Promise<void> {
		if (!readConfig().allowTaskProposals) {
			return;
		}

		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if ((taskId && task.id !== taskId) || task.run) {
				continue;
			}

			const seenRuns = new Set<string>();
			for (const receipt of [...parseReceipts(task.sections['Log'] ?? '')].reverse()) {
				if (
					receipt.taskId !== task.id ||
					!STAGES_THAT_MAY_PROPOSE.has(receipt.stage) ||
					seenRuns.has(`${receipt.runId}:${receipt.stage}`)
				) {
					continue;
				}
				seenRuns.add(`${receipt.runId}:${receipt.stage}`);
				if (!this.isSettledOrdinaryReceiptCurrent(task, receipt)) {
					continue;
				}

				await this.processOrdinaryProposals(
					task.id,
					receipt.runId,
					receipt.stage,
					(candidate) => this.isSettledOrdinaryReceiptCurrent(candidate, receipt),
				);
			}
		}
	}

	private isSettledOrdinaryReceiptCurrent(task: Task, receipt: Receipt): boolean {
		if (
			task.run ||
			receipt.taskId !== task.id ||
			!STAGES_THAT_MAY_PROPOSE.has(receipt.stage)
		) {
			return false;
		}

		const events = parseAuditEvents(task.sections['Log'] ?? '');
		const latestStart = [...events].reverse().find(
			(event) =>
				event.kind === 'activity-start' &&
				event.taskId === task.id &&
				event.stage === receipt.stage,
		);
		if (!latestStart || latestStart.runId !== receipt.runId) {
			return false;
		}

		return events.some(
			(event) =>
				event.kind === 'activity-finish' &&
				event.taskId === task.id &&
				event.stage === receipt.stage &&
				event.runId === receipt.runId &&
				event.outcome === receipt.result,
		);
	}

	/** Processes one settled ordinary run without reapplying its parent outcome. */
	private async processOrdinaryProposals(
		taskId: string,
		runId: string,
		stage: Stage,
		isCurrent: (task: Task) => boolean,
		withinLock = false,
	): Promise<void> {
		const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (!task || !isCurrent(task)) {
			return;
		}

		const logSection = task.sections['Log'] ?? '';
		if (proposalsForRun(logSection, runId).length === 0) {
			return;
		}

		try {
			const result = withinLock
				? await this.processProposalsWithinLock(task, runId, logSection)
				: await this.processProposals(task, runId, logSection);
			if (result.persisted !== result.accepted) {
				throw new Error(
					`only ${result.persisted} of ${result.accepted} proposals are persisted in the active task set`,
				);
			}
		} catch (error) {
			await this.recordProposalError(taskId, runId, stage, error, withinLock);
		}
	}

	/** Records a retryable proposal failure once per exact error in the parent log. */
	private async recordProposalError(
		taskId: string,
		runId: string,
		stage: Stage,
		error: unknown,
		withinLock = false,
	): Promise<void> {
		const note = (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n"]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim() || 'unknown proposal reconciliation error';
		const line = `- proposal-error run:${runId} task:${taskId} stage:${stage} note:"${note}"`;

		const persist = async (): Promise<void> => {
			const current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (!current || (current.sections['Log'] ?? '').includes(line)) {
				return;
			}
			await this.store.appendLog(taskId, line);
		};
		if (withinLock) {
			await persist();
		} else {
			await this.concurrency.runExclusive(persist);
		}
	}

	/** Starts a bounded recovery window after an ordinary receipt is applied. */
	private schedulePostReceiptProposalRecovery(taskId: string, runId: string, stage: Stage): void {
		const key = `${this.store.setId}:${taskId}:${runId}:${stage}`;
		if (this.postReceiptProposalRuns.has(key)) {
			return;
		}

		this.postReceiptProposalRuns.add(key);
		void this.reconcilePostReceiptProposalsUntilDeadline(taskId, runId, stage).finally(() => {
			this.postReceiptProposalRuns.delete(key);
		});
	}

	private async reconcilePostReceiptProposalsUntilDeadline(taskId: string, runId: string, stage: Stage): Promise<void> {
		await wait(POST_RECEIPT_PROPOSAL_INITIAL_DELAY_MS);
		const deadline = Date.now() + POST_RECEIPT_PROPOSAL_GRACE_MS;

		for (;;) {
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (!task || task.run || !readConfig().allowTaskProposals) {
				return;
			}

			const receipt = [...parseReceipts(task.sections['Log'] ?? '')]
				.reverse()
				.find((candidate) => candidate.runId === runId && candidate.taskId === taskId && candidate.stage === stage);
			if (!receipt || !this.isSettledOrdinaryReceiptCurrent(task, receipt)) {
				return;
			}

			await this.processOrdinaryProposals(
				taskId,
				runId,
				stage,
				(candidate) => this.isSettledOrdinaryReceiptCurrent(candidate, receipt),
			);

			if (Date.now() >= deadline) {
				return;
			}
			await wait(Math.min(POST_RECEIPT_PROPOSAL_POLL_MS, deadline - Date.now()));
		}
	}

	private findLateReceipt(task: Task): LateReceiptPair | undefined {
		const matching = parseReceipts(task.sections['Log'] ?? '').filter((receipt) => receipt.taskId === task.id);
		const marker = [...matching].reverse().find(isLateReceiptMarker);
		if (!marker) {
			return undefined;
		}

		// The agent and fallback writes can cross, so the marker may be newer than
		// the valid receipt it is meant to supersede.
		for (let i = matching.length - 1; i >= 0; i--) {
			const receipt = matching[i];
			if (
				!isLateReceiptMarker(receipt) &&
				receipt.runId === marker.runId &&
				receipt.stage === marker.stage
			) {
				return { marker, receipt };
			}
		}

		return undefined;
	}

	private isLateReceiptCandidate(task: Task, marker: Receipt, receipt: Receipt): boolean {
		if (
			!canAwaitLateReceipt(task, marker) ||
			task.run ||
			task.state !== columnForStage(marker.stage) ||
			!this.isLateReceiptStillCurrent(task, marker)
		) {
			return false;
		}

		const latest = this.findLateReceipt(task);
		return !!latest && sameReceipt(latest.marker, marker) && sameReceipt(latest.receipt, receipt);
	}

	/**
	 * A fallback belongs to the run that created it only until a later retry or
	 * manual state transition starts. Audit order is the durable supersession
	 * signal that survives reloads and is available to watcher reconciliation.
	 */
	private isLateReceiptStillCurrent(task: Task, marker: Receipt): boolean {
		const events = parseAuditEvents(task.sections['Log'] ?? '');
		const latestStart = [...events].reverse().find(
			(event) => event.kind === 'activity-start' && event.stage === marker.stage,
		);
		if (latestStart && latestStart.runId !== marker.runId) {
			return false;
		}

		const finishIndex = events.reduce((index, event, candidateIndex) => {
			return (
				event.kind === 'activity-finish' &&
				event.runId === marker.runId &&
				event.stage === marker.stage &&
				((isTimeoutReceiptMarker(marker) && event.outcome === 'timeout') ||
					(!isTimeoutReceiptMarker(marker) && (event.outcome === 'missing-receipt' || event.outcome === 'blocked')))
			)
				? candidateIndex
				: index;
		}, -1);
		if (finishIndex < 0) {
			// Older fallback markers may predate lifecycle audit entries. Keep
			// their established late-receipt behavior, while still rejecting a
			// marker when a later retry's activity-start is durable.
			return true;
		}

		return !events.slice(finishIndex + 1).some(
			(event) => event.kind === 'state-change' || event.kind === 'activity-start',
		);
	}

	private receiptKey(taskId: string, runId: string, stage: Stage, receipt: Receipt): string {
		return [this.store.setId, this.store.directory.toString(), taskId, runId, stage, receipt.result, receipt.note].join('|');
	}

	private async recordReceiptIssues(
		taskId: string,
		expected: ReceiptExpectation,
		issues: readonly ReceiptIssue[],
	): Promise<void> {
		if (this.disposed || issues.length === 0) {
			return;
		}

		const lines = new Map<string, string>();
		for (const issue of issues) {
			const receipt = issue.receipt;
			const identity = receipt
				? `${issue.kind}|${receipt.runId}|${receipt.taskId}|${receipt.stage}|${receipt.result}|${receipt.note}`
				: `${issue.kind}|${issue.line ?? ''}`;
			let line = `- receipt-diagnostic kind:${issue.kind} task:${taskId} expected-run:${expected.runId} expected-stage:${expected.stage}`;
			if (receipt) {
				line += ` actual-run:${receipt.runId} actual-task:${receipt.taskId} actual-stage:${receipt.stage}`;
			}
			const note = issue.kind === 'task-mismatch'
				? `Ignored receipt because task id ${receipt?.taskId} does not match expected task ${expected.taskId}.`
				: issue.kind === 'run-mismatch'
					? `Ignored receipt because run id ${receipt?.runId} is stale; expected ${expected.runId}.`
					: issue.kind === 'stage-mismatch'
						? `Ignored receipt because stage ${receipt?.stage} does not match expected ${expected.stage}.`
						: 'Ignored a malformed receipt-like log line; append the canonical run, task, stage, result, and note fields.';
			lines.set(identity, `${line} note:"${note}"`);
		}

		await this.concurrency.runExclusive(async () => {
			if (this.disposed) {
				return;
			}
			const current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !current) {
				return;
			}
			let log = current.sections['Log'] ?? '';
			for (const line of lines.values()) {
				if (log.includes(line)) {
					continue;
				}
				if (this.disposed) {
					return;
				}
				await this.store.appendLog(taskId, line);
				log = `${log}${log ? '\n' : ''}${line}`;
			}
		});
	}

	/** Records a watcher/activation persistence failure instead of dropping it. */
	async recordReconciliationFailure(taskId: string | undefined, error: unknown, withinLock = false): Promise<void> {
		if (this.disposed) {
			return;
		}
		const note = (error instanceof Error ? error.message : String(error))
			.replace(/[\r\n"]+/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 240) || 'unknown reconciliation failure';
		const line = `- reconciliation-error set:${this.store.setId} task:${taskId ?? 'task-set'} note:"${note}"`;

		try {
			if (taskId) {
				const persist = async (): Promise<void> => {
					const current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
					if (this.disposed || !current || (current.sections['Log'] ?? '').includes(line)) {
						return;
					}
					if (this.disposed) {
						return;
					}
					await this.store.appendLog(taskId, line);
				};
				if (withinLock) {
					await persist();
				} else {
					await this.concurrency.runExclusive(persist);
				}
			}
		} catch (loggingError) {
			if (this.disposed) {
				return;
			}
			console.error(`Kanban Pilot could not persist reconciliation failure: ${loggingError instanceof Error ? loggingError.message : String(loggingError)}`);
		}

		if (this.disposed) {
			return;
		}
		console.error(`Kanban Pilot reconciliation failed for ${taskId ?? this.store.setId}: ${note}`);
		void vscode.window.showErrorMessage(`Kanban Pilot reconciliation failed for ${taskId ?? this.store.setId}: ${note}`);
	}

	private async applyReceipt(
		taskId: string,
		runId: string,
		stage: Stage,
		receipt: Receipt,
		isCurrent: (task: Task) => boolean,
		options: { action?: string; correction?: boolean; transitionAction?: string; withinLock?: boolean } = {},
	): Promise<void> {
		if (this.disposed) {
			return;
		}
		const initial = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (this.disposed || !initial || !isCurrent(initial)) {
			return;
		}

		const key = this.receiptKey(taskId, runId, stage, receipt);
		if (appliedReceiptKeys.has(key) || inFlightReceiptKeys.has(key)) {
			return;
		}
		inFlightReceiptKeys.add(key);

		try {
			if (stage === 'split' && receipt.result === 'ok') {
				// The receipt and proposal lines can arrive in separate watcher events.
				// Give the active task file a short grace period before treating the
				// successful split as incomplete; the late-receipt path below remains
				// available for writes that arrive after this window.
				const proposalTask = await this.waitForSplitProposals(taskId, runId, isCurrent);
				if (this.disposed || !proposalTask || !isCurrent(proposalTask)) {
					return;
				}

				let splitResult: ProposalProcessingResult;
				try {
					splitResult = options.withinLock
						? await this.processProposalsWithinLock(
							proposalTask,
							runId,
							proposalTask.sections['Log'] ?? '',
						)
						: await this.processProposals(
							proposalTask,
							runId,
							proposalTask.sections['Log'] ?? '',
						);
				} catch (error) {
					if (this.disposed) {
						return;
					}
					await this.markSplitIncomplete(
						taskId,
						runId,
						`split child creation failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					return;
				}

				if (splitResult.accepted === 0) {
					if (this.disposed) {
						return;
					}
					await this.markSplitIncomplete(
						taskId,
						runId,
						`no usable proposals were found for split run ${runId}; add valid same-run propose-task lines before retrying`,
					);
					return;
				}
				if (splitResult.persisted !== splitResult.accepted) {
					if (this.disposed) {
						return;
					}
					await this.markSplitIncomplete(
						taskId,
						runId,
						`only ${splitResult.persisted} of ${splitResult.accepted} split children are persisted in the active task set`,
					);
					return;
				}
			} else if (STAGES_THAT_MAY_PROPOSE.has(stage) && readConfig().allowTaskProposals) {
				const latest = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
				if (this.disposed || !latest || !isCurrent(latest)) {
					return;
				}
				await this.processOrdinaryProposals(taskId, runId, stage, isCurrent, options.withinLock);
			}

			const fresh = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !fresh || !isCurrent(fresh)) {
				return;
			}

			await this.applyOutcome(
				taskId,
				runId,
				stage,
				receipt.result,
				fresh.sections['Scope'],
				{
					correction: options.correction ?? !initial.run,
					note: receipt.note,
					action: options.action ?? (initial.run ? 'receipt' : 'late-receipt'),
					transitionAction: options.transitionAction,
				},
			);
			if (this.disposed) {
				return;
			}
			this.notify({
				kind: 'receipt',
				taskId,
				runId,
				stage,
				note: receipt.note,
			});
			appliedReceiptKeys.add(key);
			if (STAGES_THAT_MAY_PROPOSE.has(stage) && readConfig().allowTaskProposals) {
				this.schedulePostReceiptProposalRecovery(taskId, runId, stage);
			}
		} catch (error) {
			if (this.disposed) {
				return;
			}
			await this.recordReconciliationFailure(taskId, error, options.withinLock);
			throw error;
		} finally {
			inFlightReceiptKeys.delete(key);
		}
	}

	/** Waits briefly for split proposals that may be written just after the receipt. */
	private async waitForSplitProposals(
		taskId: string,
		runId: string,
		isCurrent: (task: Task) => boolean,
	): Promise<Task | undefined> {
		const deadline = Date.now() + RECEIPT_GRACE_MS;
		for (;;) {
			if (this.disposed) {
				return undefined;
			}
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !task || !isCurrent(task)) {
				return undefined;
			}

			if (proposalsForRun(task.sections['Log'] ?? '', runId).length > 0 || Date.now() >= deadline) {
				return task;
			}
			await wait(Math.min(RECEIPT_POLL_MS, deadline - Date.now()));
		}
	}

	private async waitForReceipt(taskId: string, runId: string, stage: Stage): Promise<Receipt | undefined> {
		const deadline = Date.now() + RECEIPT_GRACE_MS;
		const expected: ReceiptExpectation = { runId, taskId, stage };
		let lastIssues: readonly ReceiptIssue[] = [];
		for (;;) {
			if (this.disposed) {
				return undefined;
			}
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !task || task.run !== runId) {
				return undefined;
			}

			const details = findReceiptDetails(task.sections['Log'] ?? '', expected);
			lastIssues = details.issues;
			if (details.receipt) {
				return details.receipt;
			}
			if (Date.now() >= deadline) {
				if (this.disposed) {
					return undefined;
				}
				await this.recordReceiptIssues(taskId, expected, lastIssues);
				return undefined;
			}
			await wait(Math.min(RECEIPT_POLL_MS, deadline - Date.now()));
		}
	}

	/**
	 * The task watcher normally observes a receipt written after the initial
	 * response grace period. Keep a bounded local backstop too: filesystem
	 * events can be coalesced with the fallback write, so relying on the
	 * watcher alone leaves a valid agent completion stuck as blocked.
	 */
	private async reconcileLateReceiptUntilDeadline(taskId: string, runId: string, stage: Stage): Promise<void> {
		// Let the ordinary file-change reconciliation handle the common case
		// first. This backstop is specifically for a missed or coalesced event.
		await wait(LATE_RECEIPT_INITIAL_DELAY_MS);
		if (this.disposed) {
			return;
		}
		const deadline = Date.now() + LATE_RECEIPT_GRACE_MS;
		let recordedDiagnostics = false;
		for (;;) {
			if (this.disposed) {
				return;
			}
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !task || task.run || task.state !== columnForStage(stage) || (task.status !== 'blocked' && task.status !== 'failed')) {
				return;
			}

			const late = this.findLateReceipt(task);
			if (late && late.marker.runId === runId && late.marker.stage === stage && late.receipt.stage === stage) {
				if (!canAwaitLateReceipt(task, late.marker)) {
					return;
				}
				await this.applyReceipt(
					taskId,
					runId,
					stage,
					late.receipt,
					(candidate) => this.isLateReceiptCandidate(candidate, late.marker, late.receipt),
				);
				if (this.disposed) {
					return;
				}
				const after = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
				if (this.disposed || !after || (after.status !== 'blocked' && after.status !== 'failed') || after.run || after.state !== columnForStage(stage)) {
					return;
				}
			} else if (!recordedDiagnostics) {
				const marker = latestLateReceiptMarker(task);
				if (marker && marker.runId === runId && marker.stage === stage) {
					const expected: ReceiptExpectation = { runId, taskId, stage };
					const details = findReceiptDetails(task.sections['Log'] ?? '', expected);
					await this.recordReceiptIssues(taskId, expected, details.issues);
					if (this.disposed) {
						return;
					}
				}
				recordedDiagnostics = true;
			}

			if (Date.now() >= deadline) {
				return;
			}
			await wait(Math.min(RECEIPT_POLL_MS, deadline - Date.now()));
		}
	}

	private async markMissingReceipt(taskId: string, runId: string, stage: Stage, note: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		let current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (this.disposed || !current || current.run !== runId) {
			return;
		}

		const expected: ReceiptExpectation = { runId, taskId, stage };
		const details = findReceiptDetails(current.sections['Log'] ?? '', expected);
		if (details.receipt) {
			await this.applyReceipt(taskId, runId, stage, details.receipt, (candidate) => candidate.run === runId);
			return;
		}
		await this.recordReceiptIssues(taskId, expected, details.issues);
		if (this.disposed) {
			return;
		}

		await this.store.appendLog(
			taskId,
			formatReceipt({
				runId,
				taskId,
				stage,
				result: 'blocked',
				note: `${note}; ${LATE_RECEIPT_MARKER}`,
			}),
		);

		current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (this.disposed || !current || current.run !== runId) {
			return;
		}

		const late = this.findLateReceipt(current);
		if (late) {
			if (this.disposed) {
				return;
			}
			await this.applyReceipt(taskId, runId, stage, late.receipt, (candidate) => candidate.run === runId);
			return;
		}

		await this.store.auditedPatch(
			taskId,
			{ status: 'blocked', run: undefined },
			{
				action: 'missing-receipt',
				runId,
				outcome: 'missing-receipt',
				events: [{
					kind: 'activity-finish',
					runId,
					stage,
					outcome: 'missing-receipt',
					provisional: true,
					note: `${note}; ${LATE_RECEIPT_MARKER}`,
				}],
			},
		);
		if (this.disposed) {
			return;
		}
		this.notify({ kind: 'blocked', taskId, runId, stage, note });
		void this.reconcileLateReceiptUntilDeadline(taskId, runId, stage);
	}

	/** Parks a successful split until its child proposals are visible and retryable. */
	private async markSplitIncomplete(taskId: string, runId: string, reason: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		let current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (this.disposed || !current) {
			return;
		}

		const markerExists = parseReceipts(current.sections['Log'] ?? '').some(
			(receipt) =>
				receipt.runId === runId &&
				receipt.taskId === taskId &&
				receipt.stage === 'split' &&
				isLateReceiptMarker(receipt),
		);
		const cleanReason = reason.replace(/[\r\n"]+/g, ' ').replace(/\s+/g, ' ').trim();
		const note = `${cleanReason || 'split child persistence is incomplete'}; ${LATE_RECEIPT_MARKER}`;
		if (!markerExists) {
			if (this.disposed) {
				return;
			}
			await this.store.appendLog(
				taskId,
				formatReceipt({ runId, taskId, stage: 'split', result: 'blocked', note }),
			);
		}

		current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (this.disposed || !current || current.run !== runId) {
			// A late-reconciliation pass is already parked and must not recursively
			// start another backstop. The initial running pass owns the bounded poll.
			return;
		}

		await this.store.auditedPatch(
			taskId,
			{ status: 'blocked', run: undefined },
			{
				action: 'split-incomplete',
				runId,
				outcome: 'blocked',
				events: [{
					kind: 'activity-finish',
					runId,
					stage: 'split',
					outcome: 'blocked',
					provisional: true,
					note,
				}],
			},
		);
		if (this.disposed) {
			return;
		}
		this.notify({ kind: 'blocked', taskId, runId, stage: 'split', note });
		void this.reconcileLateReceiptUntilDeadline(taskId, runId, 'split');
	}

	private async reconcile(
		taskId: string,
		runId: string,
		stage: Stage,
		outcome: { kind: 'timeout' } | { kind: 'executor'; result: ExecutorResult },
	): Promise<void> {
		const { tasks } = await this.store.readAll();
		if (this.disposed) {
			return;
		}
		const task = tasks.find((t) => t.id === taskId);
		// Superseded by Stop, markRunComplete, or a newer run — never clobber.
		if (!task || task.run !== runId) {
			return;
		}

		if (outcome.kind === 'timeout') {
			// The executor can outlive the timeout. Recheck the durable task file
			// before committing the provisional timeout so a receipt written during
			// the race wins without leaving a fallback marker behind.
			const receipt = await this.waitForReceipt(taskId, runId, stage);
			if (this.disposed) {
				return;
			}
			if (receipt) {
				await this.applyReceipt(taskId, runId, stage, receipt, (candidate) => candidate.run === runId);
				return;
			}

			let current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !current || current.run !== runId) {
				return;
			}

			const expected: ReceiptExpectation = { runId, taskId, stage };
			const raceDetails = findReceiptDetails(current.sections['Log'] ?? '', expected);
			if (raceDetails.receipt) {
				await this.applyReceipt(taskId, runId, stage, raceDetails.receipt, (candidate) => candidate.run === runId);
				return;
			}
			await this.recordReceiptIssues(taskId, expected, raceDetails.issues);
			if (this.disposed) {
				return;
			}

			await this.store.appendLog(
				taskId,
				formatReceipt({
					runId,
					taskId,
					stage,
					result: 'failed',
					note: `timed out; ${LATE_RECEIPT_MARKER}`,
				}),
			);

			current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (this.disposed || !current || current.run !== runId) {
				return;
			}

			const late = this.findLateReceipt(current);
			if (late && late.marker.runId === runId && late.marker.stage === stage) {
				if (this.disposed) {
					return;
				}
				await this.applyReceipt(taskId, runId, stage, late.receipt, (candidate) => candidate.run === runId);
				return;
			}

			await this.store.auditedPatch(
				taskId,
				{ status: 'failed', run: undefined },
				{
					action: 'timeout',
					runId,
					outcome: 'timeout',
					events: [{
						kind: 'activity-finish',
						runId,
						stage,
						outcome: 'timeout',
						provisional: true,
						note: `Activity timed out; ${LATE_RECEIPT_MARKER}.`,
					}],
				},
			);
			if (this.disposed) {
				return;
			}
			this.notify({ kind: 'timeout', taskId, runId, stage, note: 'Run timed out; awaiting a late receipt.' });
			void this.reconcileLateReceiptUntilDeadline(taskId, runId, stage);
			return;
		}

		const { result } = outcome;

		// §6.9: automatic misroute detection via Copilot's own conversation id.
		if (result.sessionId) {
			this.trace(`run-result task=${taskId} run=${runId} stage=${stage} returnedSession=${result.sessionId} priorSession=${task.copilotSessionId ?? 'none'}`);
			// Copilot's metadata.sessionId is its own conversation UUID, not a
			// vscode-chat-session://local id (M0 finding 9). Record it ONLY as a
			// misroute detector — never overwrite the stable derived `chat` binding
			// with it, because reopening a URI built from that UUID spawns a fresh
			// empty chat instead of the task's existing conversation. Leaving `chat`
			// intact keeps reopen/continue/dock hitting the same session.
			const sessionPatch: Record<string, string | undefined> = {
				copilot_session_id: result.sessionId,
			};
			if (task.copilotSessionId && task.copilotSessionId !== result.sessionId) {
				sessionPatch.chat_reset_required = 'true';
			}
			await this.store.patch(taskId, sessionPatch);
			if (this.disposed) {
				return;
			}
		}

		if (!result.ok) {
			const executorError = result.diagnostic
				? `${result.diagnostic.message} ${result.diagnostic.remediation}`
				: result.error ?? 'executor error';
			if (this.disposed) {
				return;
			}
			await this.store.appendLog(
				taskId,
				formatReceipt({ runId, taskId, stage, result: 'failed', note: executorError }),
			);
			if (this.disposed) {
				return;
			}
			await this.store.auditedPatch(
				taskId,
				{ status: 'failed', run: undefined },
				{
					action: 'executor-error',
					runId,
					outcome: 'error',
					events: [{
						kind: 'activity-finish',
						runId,
						stage,
						outcome: 'error',
						note: executorError,
					}],
				},
			);
			if (this.disposed) {
				return;
			}
			this.notify({ kind: 'failed', taskId, runId, stage, note: executorError });
			return;
		}

		// Re-read for a bounded grace period: the agent can finish the chat turn
		// just before its task-file append becomes visible on disk.
		const receipt = await this.waitForReceipt(taskId, runId, stage);
		if (this.disposed) {
			return;
		}

		if (!receipt) {
			// §6.4: awaited but no receipt — usually a clarifying question. Keep a
			// parseable marker so a receipt that arrives after this fallback can be
			// reconciled by the file watcher or the next activation.
			await this.markMissingReceipt(taskId, runId, stage, 'no receipt found');
			return;
		}

		await this.applyReceipt(taskId, runId, stage, receipt, (candidate) => candidate.run === runId);
	}

	/**
	 * §6.12: turns this run's `propose-task` lines (if any) into real backlog
	 * tasks, the same way a human's "New Task" would — through `store.create`,
	 * so id allocation and atomic writes stay the extension's alone. Runs
	 * sequentially (not `Promise.all`) so each `create`'s `nextId()` scan sees
	 * the previous one already on disk.
	 */
	private proposalMatches(
		child: Task,
		parent: Task,
		runId: string,
		proposal: Proposal,
		type: Task['type'],
		fingerprint: string,
	): boolean {
		if (child.originTask !== parent.id || child.type !== type) {
			return false;
		}
		if (child.originRunId !== undefined && child.originRunId !== runId) {
			return false;
		}
		if (child.originRunId === runId && child.originProposalKey === fingerprint) {
			return true;
		}

		// Accept children created by an older build that persisted only the
		// original origin_task marker and human-readable request provenance.
		const request = child.sections['Request'] ?? '';
		return (
			child.originProposalKey === undefined &&
			child.title === proposal.title &&
			request.includes(proposal.note) &&
			request.includes(`run ${runId}`)
		);
	}

	private async processProposals(task: Task, runId: string, logSection: string): Promise<ProposalProcessingResult> {
		return this.concurrency.runExclusive(() => this.processProposalsWithinLock(task, runId, logSection));
	}

	private async processProposalsWithinLock(task: Task, runId: string, logSection: string): Promise<ProposalProcessingResult> {
		const proposals = proposalsForRun(logSection, runId)
			.map((proposal) => {
				const type = proposal.type ?? task.type;
				return isTaskType(type) ? { proposal, type } : undefined;
			})
			.filter((candidate): candidate is { proposal: Proposal; type: Task['type'] } => candidate !== undefined)
			.filter((candidate, index, all) =>
				all.findIndex((other) =>
					other.type === candidate.type &&
					other.proposal.title === candidate.proposal.title &&
					other.proposal.note === candidate.proposal.note,
				) === index,
			)
			.slice(0, MAX_PROPOSALS_PER_RUN);
		const accepted: { proposal: Proposal; type: Task['type']; fingerprint: string }[] = [];
		const known = (await this.store.readAll()).tasks;
		let created = 0;

		for (const { proposal, type } of proposals) {
			const fingerprint = proposalFingerprint(proposal, type);
			accepted.push({ proposal, type, fingerprint });
			if (known.some((child) => this.proposalMatches(child, task, runId, proposal, type, fingerprint))) {
				continue;
			}

			const child = await this.store.create(proposal.title, {
				type,
				origin: { taskId: task.id, runId, note: proposal.note, proposalKey: fingerprint },
			});
			known.push(child);
			created++;
		}

		const persistedTasks = (await this.store.readAll()).tasks;
		const persisted = accepted.filter(({ proposal, type, fingerprint }) =>
			persistedTasks.some((child) => this.proposalMatches(child, task, runId, proposal, type, fingerprint)),
		).length;
		return { accepted: accepted.length, persisted, created };
	}

	/**
	 * Turns a receipt's result into the next (state, status). Refine and
	 * develop share a shape (ok advances one column, anything else parks the
	 * card where it is); validate is genuinely different — its `failed` is a
	 * real verdict, not an error, so it moves the card *backward* to In
	 * Progress rather than leaving it stuck (see receipt.ts's doc on why).
	 */
	private async applyOutcome(
		taskId: string,
		runId: string,
		stage: Stage,
		result: ReceiptResult,
		scope?: string,
		activity: { correction?: boolean; note?: string; action?: string; transitionAction?: string } = {},
	): Promise<void> {
		if (this.disposed) {
			return;
		}
		const transitionAction = activity.transitionAction ?? activity.action ?? 'receipt';
		const finishEvent: AuditEventInput = {
			kind: 'activity-finish',
			runId,
			stage,
			outcome: result as AuditOutcome,
			correction: activity.correction,
			action: activity.action ?? 'receipt',
			note: activity.note ?? `Activity finished with receipt result ${result}.`,
		};
		const patchOutcome = async (updates: Record<string, string | undefined>, action: string): Promise<void> => {
			if (this.disposed) {
				return;
			}
			await this.store.auditedPatch(taskId, updates, {
				action,
				runId,
				outcome: result as AuditOutcome,
				events: [finishEvent],
			});
			if (this.disposed) {
				return;
			}
			if (updates.state === 'done' && readConfig().closeTabOnDone) {
				await this.closeTaskChatTab(taskId, readConfig());
			}
		};

		const completionGate = receiptGateFor(stage, result);
		if (completionGate) {
			if (this.disposed) {
				return;
			}
			const pending = {
				gate: completionGate.id as GateId,
				stage,
				result,
				runId,
				...(stage === 'refine' ? { scopeHash: hashScope(scope ?? '') } : {}),
			};
			await this.store.auditedPatch(
				taskId,
				{
					status: 'idle',
					run: undefined,
					pending_outcome: encodePendingOutcome(pending),
				},
				{
					action: transitionAction,
					runId,
					outcome: result as AuditOutcome,
					events: [finishEvent],
				},
			);
			if (this.disposed) {
				return;
			}
			this.notify({
				kind: 'pending-outcome',
				taskId,
				runId,
				stage,
				note: `Awaiting ${completionGate.label}.`,
			});
			if (readConfig().gatePolicies[completionGate.id as GateId] === 'auto') {
				await this.applyPendingOutcomeWithinLock(taskId);
			}
			return;
		}

		if (result !== 'ok') {
			if (this.disposed) {
				return;
			}
			await patchOutcome({ status: result, run: undefined }, transitionAction);
			if (this.disposed) {
				return;
			}
			this.notify({ kind: result === 'blocked' ? 'blocked' : 'failed', taskId, runId, stage, note: activity.note });
			return;
		}

		const nextState = stage === 'refine' ? 'scoped' : 'validation';
		const patch: Record<string, string | undefined> = { state: nextState, status: 'idle', run: undefined };
		if (stage === 'refine') {
			patch.scope_hash = hashScope(scope ?? '');
		}
		await patchOutcome(patch, transitionAction);
	}

	private async resetSession(taskId: string): Promise<void> {
		if (this.disposed) {
			return;
		}
		const cfg = readConfig();
		const chat = await this.resolveTaskChat(taskId, cfg, true);
		if (this.disposed || !chat) {
			return;
		}
		try {
			if (this.disposed) {
				return;
			}
			await this.executeCommand('vscode.open', chat.uri, {
				preserveFocus: false,
			});
			await this.executeCommand('workbench.action.chat.newChat');
		} catch {
			// §6.8: newChat is confirmed unreliable (R10) for reasons beyond R12's
			// fix. Layers 2–3 (scope_hash mismatch, inlining) are the real backstop.
		}
	}

	private async closeTaskChatTab(taskId: string, cfg: RunManagerConfig): Promise<void> {
		const chat = await this.resolveTaskChat(taskId, cfg, false);
		if (chat) {
			await closeTaskChatTabs(chat.uri, this.tabGroups);
		}
	}

	private async resolveTaskChat(
		taskId: string,
		cfg: RunManagerConfig,
		persistFallback: boolean,
	): Promise<{ uri: vscode.Uri; sessionId: string } | undefined> {
		const { tasks } = await this.store.readAll();
		const task = tasks.find((candidate) => candidate.id === taskId);
		if (!task) {
			return undefined;
		}

		const sessionId = sessionIdForTaskBinding(task, cfg.sessionPrefix, this.store.setId);
		if (persistFallback && !task.chat) {
			await this.store.patch(task.id, { chat: sessionId });
		}
		return { sessionId, uri: sessionUriForTaskBinding({ ...task, chat: sessionId }, cfg.sessionPrefix, this.store.setId) };
	}
}
