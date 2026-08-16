import * as vscode from 'vscode';
import { invokeTaskAction, moveTask as moveTaskToColumn } from '../board/actions';
import type { MoveOutcome } from '../board/actions';
import { TaskAction } from '../board/stateMachine';
import { Column, Status, Task } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { AgentNameOverrides, resolveAgentName } from './agentNames';
import { Executor, ExecutorResult } from './executor';
import { loadPromptTemplate, renderTemplate } from './promptTemplates';
import { proposalsForRun } from './proposals';
import { findReceipt, formatReceipt, parseReceipts, Receipt, ReceiptResult, Stage } from './receipt';
import { hashScope } from './scopeHash';
import { DEFAULT_TASK_SET_ID, sessionIdForTask, sessionUriForTask } from './sessionUri';

/** §6.12: a run can propose at most this many follow-up tasks — a cap, not a target. */
const MAX_PROPOSALS_PER_RUN = 5;
const RECEIPT_GRACE_MS = 250;
const RECEIPT_POLL_MS = 10;
const LATE_RECEIPT_INITIAL_DELAY_MS = 500;
const LATE_RECEIPT_GRACE_MS = 5_000;
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
			const persistedRunning = tasks.filter(
				(task) => task.status === 'running' && (!task.run || !this.active.has(this.key(task.id, task.run))),
			).length;
			const reservationKey = this.key(taskId, runId);
			if (
				this.hasReservationForTask(taskId) ||
				persistedRunning + this.active.size + this.pending.size >= maxParallelTasks
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
 * §6.15: `applyGatePolicies` is the M5 gate-policy engine — four independent
 * `manual|auto` settings, each firing the same `handleAction` a click would,
 * so G3 ("gated by default") stays true of the *default*, not of the code
 * path once someone opts a gate into `auto`.
 */

type GatePolicy = 'manual' | 'auto';

interface RunManagerConfig {
	mode: string;
	sessionPrefix: string;
	toolsIncludeForRefine: string[];
	toolsExclude: string[];
	modelSelector?: { id?: string; vendor?: string };
	agentNames: AgentNameOverrides;
	timeoutMinutes: number;
	maxParallelTasks: number;
	resetOnApprove: boolean;
	dockChat: boolean;
	dockChatOnSelect: boolean;
	allowTaskProposals: boolean;
	gateBacklogToRefine: GatePolicy;
	gateScopedToApproved: GatePolicy;
	gateApprovedToInProgress: GatePolicy;
	gateValidationAutoStart: GatePolicy;
}

function readConfig(): RunManagerConfig {
	const cfg = vscode.workspace.getConfiguration('kanbanPilot');
	return {
		mode: cfg.get<string>('chat.mode', 'agent'),
		sessionPrefix: cfg.get<string>('chat.sessionPrefix', 'kanban-pilot-'),
		toolsIncludeForRefine: cfg.get<string[]>('refine.toolsInclude', []),
		toolsExclude: cfg.get<string[]>('chat.toolsExclude', ['memory', 'resolveMemoryFileUri']),
		modelSelector: cfg.get<{ id?: string; vendor?: string }>('chat.modelSelector', {}),
		agentNames: cfg.get<AgentNameOverrides>('chat.agentNames', {}),
		timeoutMinutes: cfg.get<number>('run.timeoutMinutes', 20),
		maxParallelTasks: normalizeMaxParallelTasks(cfg.get<number>('run.maxParallelTasks', 1)),
		resetOnApprove: cfg.get<boolean>('chat.resetOnApprove', false),
		dockChat: cfg.get<boolean>('layout.dockChat', true),
		dockChatOnSelect: cfg.get<boolean>('layout.dockChatOnSelect', false),
		allowTaskProposals: cfg.get<boolean>('chat.allowTaskProposals', true),
		gateBacklogToRefine: cfg.get<GatePolicy>('gates.backlogToRefine', 'manual'),
		gateScopedToApproved: cfg.get<GatePolicy>('gates.scopedToApproved', 'manual'),
		gateApprovedToInProgress: cfg.get<GatePolicy>('gates.approvedToInProgress', 'manual'),
		gateValidationAutoStart: cfg.get<GatePolicy>('gates.validationAutoStart', 'manual'),
	};
}

function generateRunId(): string {
	return 'r' + Math.random().toString(36).slice(2, 8);
}

/** `p` racing a timer — never rejects on timeout, resolves the sentinel instead. */
function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<'timeout'>((resolve) => {
		timer = setTimeout(() => resolve('timeout'), ms);
	});
	return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
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
	return receipt.result === 'blocked' && receipt.note.endsWith(LATE_RECEIPT_MARKER);
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

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RunManager {
	private readonly concurrency: RunConcurrencyCoordinator;

	constructor(
		private readonly store: TaskStore,
		private readonly executor: Executor,
		private readonly workspaceFolder: vscode.WorkspaceFolder,
	) {
		this.concurrency = coordinatorFor(workspaceFolder, store);
	}

	/**
	 * The single entry point for both the webview and the palette commands
	 * (mirrors §7's "every card action is also a palette command").
	 */
	async handleAction(taskId: string, action: TaskAction): Promise<void> {
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
				if (outcome.kind === 'applied' && readConfig().resetOnApprove) {
					await this.resetSession(taskId);
				}
				return;
			}

			case 'stop': {
				await this.concurrency.runExclusive(async () => {
					const { tasks } = await this.store.readAll();
					const runId = tasks.find((task) => task.id === taskId)?.run;
					const outcome = await invokeTaskAction(this.store, taskId, action);
					if (outcome.kind === 'applied') {
						// Closes a real gap: without this, a run that resolves *after*
						// Stop would still see its own runId on the task and clobber the
						// stop (§6.9's staleness guard keys off `run`, not `status`).
						await this.store.patch(taskId, { run: undefined });
						if (runId) {
							this.concurrency.release(taskId, runId);
						}
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
		return this.concurrency.runExclusive(async () => {
			const { tasks } = await this.store.readAll();
			const runId = typeof taskId === 'string' ? tasks.find((task) => task.id === taskId)?.run : undefined;
			const outcome = await moveTaskToColumn(this.store, taskId, destination);
			if (outcome.kind === 'applied' && runId) {
				this.concurrency.release(taskId as string, runId);
			}
			return outcome;
		});
	}

	/** §6.10: open the task's session beside the board. */
	async dockTaskChat(taskId: string, opts: { onSelect: boolean }): Promise<void> {
		const cfg = readConfig();
		if (!cfg.dockChat || (opts.onSelect && !cfg.dockChatOnSelect)) {
			return;
		}
		try {
			await vscode.commands.executeCommand('vscode.open', sessionUriForTask(taskId, cfg.sessionPrefix, this.store.setId), {
				viewColumn: vscode.ViewColumn.Beside,
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
		await this.concurrency.runExclusive(async () => {
			const { tasks } = await this.store.readAll();
			const task = tasks.find((t) => t.id === taskId);
			if (!task?.run) {
				return;
			}
			const runId = task.run;
			const stage = stageForColumn(task.state);

			try {
				await this.store.appendLog(taskId, formatReceipt({ runId, taskId, stage, result, note }));
				await this.applyOutcome(taskId, stage, result);
			} finally {
				this.concurrency.release(taskId, runId);
			}
		});
	}

	/**
	 * On activation, any task left `running` had its in-memory run state lost
	 * to the reload (§6.4). Reconciles against whatever the file shows now.
	 */
	async reconcileOnActivation(): Promise<void> {
		await this.concurrency.reconcile();
		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if (task.status !== 'running' || !task.run) {
				continue;
			}
			const runId = task.run;
			const stage = stageForColumn(task.state);
			try {
				const receipt = findReceipt(task.sections['Log'] ?? '', runId, task.id);

				if (receipt) {
					await this.applyReceipt(task.id, runId, stage, receipt, (candidate) => candidate.run === runId);
				} else {
					await this.markMissingReceipt(task.id, runId, stage, 'interrupted by window reload; no receipt found');
				}
			} finally {
				this.concurrency.release(task.id, runId);
			}
		}

		await this.reconcileLateReceipts();
	}

	/** Reconciles a receipt that arrived after the extension's no-receipt fallback. */
	async reconcileTaskChange(taskId?: string): Promise<void> {
		await this.concurrency.reconcile();
		await this.reconcileLateReceipts(taskId);
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
		const cfg = readConfig();
		await this.concurrency.reconcile();
		const { tasks } = await this.store.readAll();

		for (const task of tasks) {
			if (task.status !== 'idle') {
				continue;
			}

			if (task.state === 'backlog' && cfg.gateBacklogToRefine === 'auto') {
				await this.startStageRun(task.id, 'refine', 'refine', 'accept');
			} else if (task.state === 'scoped' && cfg.gateScopedToApproved === 'auto') {
				await this.handleAction(task.id, 'approve');
			} else if (task.state === 'approved' && cfg.gateApprovedToInProgress === 'auto') {
				await this.handleAction(task.id, 'develop');
			} else if (task.state === 'validation' && cfg.gateValidationAutoStart === 'auto') {
				await this.handleAction(task.id, 'validate');
			}
		}
	}

	// ---- launching a stage run -------------------------------------------

	private async startStageRun(taskId: string, action: TaskAction, stage: Stage, beforeAction?: TaskAction): Promise<void> {
		const cfg = readConfig();
		const runId = generateRunId();
		const started = await this.concurrency.tryStart(taskId, runId, cfg.maxParallelTasks, async () => {
			if (beforeAction) {
				const prepared = await invokeTaskAction(this.store, taskId, beforeAction);
				if (prepared.kind !== 'applied') {
					return false;
				}
			}

			const applied = await invokeTaskAction(this.store, taskId, action);
			if (applied.kind !== 'applied') {
				return false;
			}

			const { tasks } = await this.store.readAll();
			const task = tasks.find((candidate) => candidate.id === taskId);
			if (!task) {
				return false;
			}

			const sessionId = this.store.setId === DEFAULT_TASK_SET_ID
				? task.chat ?? sessionIdForTask(taskId, cfg.sessionPrefix, this.store.setId)
				: sessionIdForTask(taskId, cfg.sessionPrefix, this.store.setId);
			await this.store.patch(taskId, {
				status: 'running',
				run: runId,
				chat: sessionId,
			});
			return true;
		});
		if (!started) {
			return;
		}

		// Fire-and-forget: the board reflects state via the file watcher, not a
		// held promise. Errors are caught inside — this never rejects.
		void this.runStage(taskId, runId, stage, cfg, cfg.dockChat && shouldDockActionChat(action));
	}

	private async runStage(
		taskId: string,
		runId: string,
		stage: Stage,
		cfg: RunManagerConfig,
		openBeside: boolean,
	): Promise<void> {
		try {
			const { tasks } = await this.store.readAll();
			const task = tasks.find((t) => t.id === taskId);
			if (!task || task.status !== 'running' || task.run !== runId) {
				return;
			}

			const currentScope = task.sections['Scope'] ?? '';
			const scopeEdited =
				stage === 'develop' && !!task.scopeHash && task.scopeHash !== hashScope(currentScope);

			const template = await loadPromptTemplate(this.workspaceFolder, stage);
			const prompt = renderTemplate(template, {
				id: task.id,
				title: task.title,
				agentName: resolveAgentName(stage, cfg.agentNames),
				projectName: this.workspaceFolder.name,
				runId,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: currentScope,
				scopeEdited,
			});

			const timeoutMs = cfg.timeoutMinutes * 60_000;
			const outcome = await raceWithTimeout(
				this.executor.run(task, this.store.fileFor(task.id), prompt, stage, {
					mode: cfg.mode,
					sessionPrefix: cfg.sessionPrefix,
					toolsIncludeForRefine: cfg.toolsIncludeForRefine,
					toolsExclude: cfg.toolsExclude,
					openBeside,
					modelSelector: cfg.modelSelector,
				}),
				timeoutMs,
			);

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
			this.concurrency.release(taskId, runId);
		}
	}

	// ---- reconciliation (§6.2, §6.4, §6.9) ------------------------------

	private async reconcileLateReceipts(taskId?: string): Promise<void> {
		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if (taskId && task.id !== taskId) {
				continue;
			}

			const late = this.findLateReceipt(task);
			if (!late || task.status !== 'blocked' || task.run) {
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
		if (task.status !== 'blocked' || task.run || task.state !== columnForStage(marker.stage)) {
			return false;
		}

		const latest = this.findLateReceipt(task);
		return !!latest && sameReceipt(latest.marker, marker) && sameReceipt(latest.receipt, receipt);
	}

	private receiptKey(taskId: string, runId: string, stage: Stage, receipt: Receipt): string {
		return [this.store.setId, this.store.directory.toString(), taskId, runId, stage, receipt.result, receipt.note].join('|');
	}

	private async applyReceipt(
		taskId: string,
		runId: string,
		stage: Stage,
		receipt: Receipt,
		isCurrent: (task: Task) => boolean,
	): Promise<void> {
		const initial = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (!initial || !isCurrent(initial)) {
			return;
		}

		const key = this.receiptKey(taskId, runId, stage, receipt);
		if (appliedReceiptKeys.has(key) || inFlightReceiptKeys.has(key)) {
			return;
		}
		inFlightReceiptKeys.add(key);

		try {
			const shouldProcessProposals =
				stage === 'split' || (STAGES_THAT_MAY_PROPOSE.has(stage) && readConfig().allowTaskProposals);
			if (shouldProcessProposals) {
				await this.processProposals(taskId, runId, initial.sections['Log'] ?? '');
			}

			const fresh = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (!fresh || !isCurrent(fresh)) {
				return;
			}

			await this.applyOutcome(taskId, stage, receipt.result, fresh.sections['Scope']);
			appliedReceiptKeys.add(key);
		} finally {
			inFlightReceiptKeys.delete(key);
		}
	}

	private async waitForReceipt(taskId: string, runId: string): Promise<Receipt | undefined> {
		const deadline = Date.now() + RECEIPT_GRACE_MS;
		for (;;) {
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (!task || task.run !== runId) {
				return undefined;
			}

			const receipt = findReceipt(task.sections['Log'] ?? '', runId, taskId);
			if (receipt) {
				return receipt;
			}
			if (Date.now() >= deadline) {
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
		const deadline = Date.now() + LATE_RECEIPT_GRACE_MS;
		for (;;) {
			const task = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
			if (!task || task.status !== 'blocked' || task.run || task.state !== columnForStage(stage)) {
				return;
			}

			const late = this.findLateReceipt(task);
			if (late && late.marker.runId === runId && late.marker.stage === stage && late.receipt.stage === stage) {
				await this.applyReceipt(
					taskId,
					runId,
					stage,
					late.receipt,
					(candidate) => this.isLateReceiptCandidate(candidate, late.marker, late.receipt),
				);
				return;
			}

			if (Date.now() >= deadline) {
				return;
			}
			await wait(Math.min(RECEIPT_POLL_MS, deadline - Date.now()));
		}
	}

	private async markMissingReceipt(taskId: string, runId: string, stage: Stage, note: string): Promise<void> {
		let current = (await this.store.readAll()).tasks.find((candidate) => candidate.id === taskId);
		if (!current || current.run !== runId) {
			return;
		}

		const existing = findReceipt(current.sections['Log'] ?? '', runId, taskId);
		if (existing) {
			await this.applyReceipt(taskId, runId, stage, existing, (candidate) => candidate.run === runId);
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
		if (!current || current.run !== runId) {
			return;
		}

		const late = this.findLateReceipt(current);
		if (late) {
			await this.applyReceipt(taskId, runId, stage, late.receipt, (candidate) => candidate.run === runId);
			return;
		}

		await this.store.patch(taskId, { status: 'blocked', run: undefined });
		void this.reconcileLateReceiptUntilDeadline(taskId, runId, stage);
	}

	private async reconcile(
		taskId: string,
		runId: string,
		stage: Stage,
		outcome: { kind: 'timeout' } | { kind: 'executor'; result: ExecutorResult },
	): Promise<void> {
		const { tasks } = await this.store.readAll();
		const task = tasks.find((t) => t.id === taskId);
		// Superseded by Stop, markRunComplete, or a newer run — never clobber.
		if (!task || task.run !== runId) {
			return;
		}

		if (outcome.kind === 'timeout') {
			await this.store.appendLog(taskId, formatReceipt({ runId, taskId, stage, result: 'failed', note: 'timed out' }));
			await this.store.patch(taskId, { status: 'failed', run: undefined });
			return;
		}

		const { result } = outcome;

		// §6.9: automatic misroute detection via Copilot's own conversation id.
		if (result.sessionId) {
			const sessionPatch: Record<string, string | undefined> = { copilot_session_id: result.sessionId };
			if (task.copilotSessionId && task.copilotSessionId !== result.sessionId) {
				sessionPatch.chat_reset_required = 'true';
			}
			await this.store.patch(taskId, sessionPatch);
		}

		if (!result.ok) {
			await this.store.appendLog(
				taskId,
				formatReceipt({ runId, taskId, stage, result: 'failed', note: result.error ?? 'executor error' }),
			);
			await this.store.patch(taskId, { status: 'failed', run: undefined });
			return;
		}

		// Re-read for a bounded grace period: the agent can finish the chat turn
		// just before its task-file append becomes visible on disk.
		const receipt = await this.waitForReceipt(taskId, runId);

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
	private async processProposals(taskId: string, runId: string, logSection: string): Promise<void> {
		const proposals = proposalsForRun(logSection, runId).slice(0, MAX_PROPOSALS_PER_RUN);
		for (const proposal of proposals) {
			await this.store.create(proposal.title, { origin: { taskId, runId, note: proposal.note } });
		}
	}

	/**
	 * Turns a receipt's result into the next (state, status). Refine and
	 * develop share a shape (ok advances one column, anything else parks the
	 * card where it is); validate is genuinely different — its `failed` is a
	 * real verdict, not an error, so it moves the card *backward* to In
	 * Progress rather than leaving it stuck (see receipt.ts's doc on why).
	 */
	private async applyOutcome(taskId: string, stage: Stage, result: ReceiptResult, scope?: string): Promise<void> {
		if (stage === 'validate') {
			const next: { state: Column; status: Status } =
				result === 'ok'
					? { state: 'done', status: 'idle' }
					: result === 'failed'
						? { state: 'in-progress', status: 'idle' } // criteria not met — another development pass
						: { state: 'validation', status: 'blocked' }; // ambiguous — stays for a follow-up
			await this.store.patch(taskId, { ...next, run: undefined });
			return;
		}

		// §6.14: split's `blocked`/`failed` falls through to the generic branch
		// below unchanged — parked back in Refine/blocked|failed, exactly where
		// the ordinary Refine action can pick it up. Only its `ok` differs from
		// every other stage: it doesn't advance a column, it retires this task
		// as tracking-only — the real advancement already happened when its
		// children were filed as proposals, upstream of this call.
		if (stage === 'split' && result === 'ok') {
			await this.store.patch(taskId, { state: 'done', status: 'idle', run: undefined });
			return;
		}

		if (result !== 'ok') {
			await this.store.patch(taskId, { status: result, run: undefined });
			return;
		}

		const nextState = stage === 'refine' ? 'scoped' : 'validation';
		const patch: Record<string, string | undefined> = { state: nextState, status: 'idle', run: undefined };
		if (stage === 'refine') {
			patch.scope_hash = hashScope(scope ?? '');
		}
		await this.store.patch(taskId, patch);
	}

	private async resetSession(taskId: string): Promise<void> {
		const cfg = readConfig();
		try {
			await vscode.commands.executeCommand('vscode.open', sessionUriForTask(taskId, cfg.sessionPrefix, this.store.setId), {
				preserveFocus: false,
			});
			await vscode.commands.executeCommand('workbench.action.chat.newChat');
		} catch {
			// §6.8: newChat is confirmed unreliable (R10) for reasons beyond R12's
			// fix. Layers 2–3 (scope_hash mismatch, inlining) are the real backstop.
		}
	}
}
