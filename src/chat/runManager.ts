import * as vscode from 'vscode';
import { invokeTaskAction, moveTask as moveTaskToColumn } from '../board/actions';
import type { MoveOutcome } from '../board/actions';
import { TaskAction } from '../board/stateMachine';
import { Column, Status } from '../model/task';
import { TaskStore } from '../model/taskStore';
import { AgentNameOverrides, resolveAgentName } from './agentNames';
import { Executor, ExecutorResult } from './executor';
import { loadPromptTemplate, renderTemplate } from './promptTemplates';
import { proposalsForRun } from './proposals';
import { findReceipt, formatReceipt, ReceiptResult, Stage } from './receipt';
import { hashScope } from './scopeHash';
import { sessionUriForTask } from './sessionUri';

/** §6.12: a run can propose at most this many follow-up tasks — a cap, not a target. */
const MAX_PROPOSALS_PER_RUN = 5;

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
 * All three agent stages are wired: `refine` (Backlog → Scoped), `develop`
 * (Approved → Validation), and `validate` (Validation → Done or back to In
 * Progress on a failed check). `accept` and `approve` stay pure gates — see
 * `stateMachine.ts`'s module doc for why that split exists.
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

export class RunManager {
	constructor(
		private readonly store: TaskStore,
		private readonly executor: Executor,
		private readonly workspaceFolder: vscode.WorkspaceFolder,
	) {}

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
				const outcome = await invokeTaskAction(this.store, taskId, action);
				if (outcome.kind === 'applied') {
					// Closes a real gap: without this, a run that resolves *after*
					// Stop would still see its own runId on the task and clobber the
					// stop (§6.9's staleness guard keys off `run`, not `status`).
					await this.store.patch(taskId, { run: undefined });
				}
				return;
			}

			// accept, reopen: pure gates, no run.
			default:
				await invokeTaskAction(this.store, taskId, action);
				return;
		}
	}

	async moveTask(taskId: unknown, destination: unknown): Promise<MoveOutcome> {
		return moveTaskToColumn(this.store, taskId, destination);
	}

	/** §6.10: open the task's session beside the board. */
	async dockTaskChat(taskId: string, opts: { onSelect: boolean }): Promise<void> {
		const cfg = readConfig();
		if (!cfg.dockChat || (opts.onSelect && !cfg.dockChatOnSelect)) {
			return;
		}
		try {
			await vscode.commands.executeCommand('vscode.open', sessionUriForTask(taskId, cfg.sessionPrefix), {
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
		const { tasks } = await this.store.readAll();
		const task = tasks.find((t) => t.id === taskId);
		if (!task?.run) {
			return;
		}
		const stage = stageForColumn(task.state);

		await this.store.appendLog(taskId, formatReceipt({ runId: task.run, taskId, stage, result, note }));
		await this.applyOutcome(taskId, stage, result);
	}

	/**
	 * On activation, any task left `running` had its in-memory run state lost
	 * to the reload (§6.4). Reconciles against whatever the file shows now.
	 */
	async reconcileOnActivation(): Promise<void> {
		const { tasks } = await this.store.readAll();
		for (const task of tasks) {
			if (task.status !== 'running' || !task.run) {
				continue;
			}
			const stage = stageForColumn(task.state);
			const receipt = findReceipt(task.sections['Log'] ?? '', task.run, task.id);

			if (receipt) {
				await this.applyOutcome(task.id, stage, receipt.result);
			} else {
				await this.store.appendLog(
					task.id,
					formatReceipt({
						runId: task.run,
						taskId: task.id,
						stage,
						result: 'blocked',
						note: 'interrupted by window reload; no receipt found',
					}),
				);
				await this.store.patch(task.id, { status: 'blocked', run: undefined });
			}
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
	 * `approvedToInProgress` tracks the single develop slot itself
	 * (`slotTaken`, updated as this same sweep fires) rather than trusting
	 * `stateMachine.ts`'s legality check alone — that check has no concept of
	 * "only one," so without this a sweep that found three Approved/idle
	 * tasks would auto-start all three. Real enforcement is still M4's job;
	 * this is the minimum needed for the gate's own description to hold.
	 */
	async applyGatePolicies(): Promise<void> {
		const cfg = readConfig();
		const { tasks } = await this.store.readAll();
		let slotTaken = tasks.some((t) => t.state === 'in-progress' && t.status === 'running');

		for (const task of tasks) {
			if (task.status !== 'idle') {
				continue;
			}

			if (task.state === 'backlog' && cfg.gateBacklogToRefine === 'auto') {
				await this.handleAction(task.id, 'accept');
				await this.handleAction(task.id, 'refine');
			} else if (task.state === 'scoped' && cfg.gateScopedToApproved === 'auto') {
				await this.handleAction(task.id, 'approve');
			} else if (task.state === 'approved' && cfg.gateApprovedToInProgress === 'auto' && !slotTaken) {
				await this.handleAction(task.id, 'develop');
				slotTaken = true;
			} else if (task.state === 'validation' && cfg.gateValidationAutoStart === 'auto') {
				await this.handleAction(task.id, 'validate');
			}
		}
	}

	// ---- launching a stage run -------------------------------------------

	private async startStageRun(taskId: string, action: TaskAction, stage: Stage): Promise<void> {
		const applied = await invokeTaskAction(this.store, taskId, action);
		if (applied.kind !== 'applied') {
			return;
		}

		const cfg = readConfig();
		const runId = generateRunId();
		const { tasks } = await this.store.readAll();
		const task = tasks.find((t) => t.id === taskId)!;

		await this.store.patch(taskId, {
			status: 'running',
			run: runId,
			chat: task.chat ?? `${cfg.sessionPrefix}${taskId}`,
		});

		// Fire-and-forget: the board reflects state via the file watcher, not a
		// held promise. Errors are caught inside — this never rejects.
		void this.runStage(taskId, runId, stage, cfg);
	}

	private async runStage(taskId: string, runId: string, stage: Stage, cfg: RunManagerConfig): Promise<void> {
		try {
			const { tasks } = await this.store.readAll();
			const task = tasks.find((t) => t.id === taskId);
			if (!task) {
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
		}
	}

	// ---- reconciliation (§6.2, §6.4, §6.9) ------------------------------

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

		// Re-read: the agent's own edits (including the receipt) landed on disk
		// during the run.
		const fresh = (await this.store.readAll()).tasks.find((t) => t.id === taskId);
		const receipt = fresh && findReceipt(fresh.sections['Log'] ?? '', runId, taskId);

		if (!receipt) {
			// §6.4: awaited but no receipt — usually a clarifying question.
			await this.store.patch(taskId, { status: 'blocked', run: undefined });
			return;
		}

		// split's proposals are the actual point of clicking it, not an optional
		// side effect — unlike develop/validate, never gated by allowTaskProposals.
		const shouldProcessProposals =
			stage === 'split' || (STAGES_THAT_MAY_PROPOSE.has(stage) && readConfig().allowTaskProposals);
		if (shouldProcessProposals) {
			await this.processProposals(taskId, runId, fresh?.sections['Log'] ?? '');
		}

		await this.applyOutcome(taskId, stage, receipt.result, fresh?.sections['Scope']);
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
			await vscode.commands.executeCommand('vscode.open', sessionUriForTask(taskId, cfg.sessionPrefix), {
				preserveFocus: false,
			});
			await vscode.commands.executeCommand('workbench.action.chat.newChat');
		} catch {
			// §6.8: newChat is confirmed unreliable (R10) for reasons beyond R12's
			// fix. Layers 2–3 (scope_hash mismatch, inlining) are the real backstop.
		}
	}
}
