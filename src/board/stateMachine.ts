import { Column, isPendingOutcome, PendingOutcome, Status } from '../model/task';
import { gateForId, GateId } from '../model/gates';

/**
 * The human-side transition rules for §5.2's action matrix and the §5 state
 * diagram, as a pure function.
 *
 * `needsAgent` means exactly one thing: **this action launches a real chat
 * run.** `accept` and `approve` are pure gates — they move a card into a
 * working column but do not, by themselves, start anything; the human still
 * has to click that column's own action (`refine`, `develop`, `validate`) to
 * actually kick off the agent. That's a deliberate two-step for Backlog
 * specifically (`accept` then `refine`) and a one-step move-and-launch for
 * Approved (`develop`) and Validation (`validate`) — `RunManager` is what
 * turns `needsAgent: true` into an actual run; this module only decides
 * whether a transition is legal and what it produces.
 */

export const TASK_ACTIONS = [
	'accept',
	'refine',
	'split',
	'approve',
	'develop',
	'continue',
	'stop',
	'validate',
	'reopen',
] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export interface TransitionResult {
	state: Column;
	status: Status;
	/** True when `RunManager` should launch a real run for this action. */
	needsAgent: boolean;
}

export interface PendingTransitionResult {
	state: Column;
	status: 'idle';
	gate: GateId;
}

type Predicate = (state: Column, status: Status) => boolean;

/** Columns whose own working stage runs in place; Stop returns them to idle rather than bouncing elsewhere. */
const STOP_IN_PLACE: ReadonlySet<Column> = new Set<Column>(['refine', 'validation']);

const RULES: Record<TaskAction, { from: Predicate; to: TransitionResult }> = {
	// Pure gate — moves the card into Refine and stops there. The human still
	// clicks "Refine" separately to actually start the agent.
	accept: {
		from: (s, st) => s === 'backlog' && st === 'idle',
		to: { state: 'refine', status: 'idle', needsAgent: false },
	},
	// §5.2's Refine rows are idle (start) and blocked/failed (retry) only — status
	// 'paused' is never produced for this column, so it must stay illegal here
	// even though "not running" would otherwise have admitted it.
	// Also legal from Scoped/idle — the secondary "Refine" action, redoing scope.
	refine: {
		from: (s, st) =>
			(s === 'refine' && (st === 'idle' || st === 'blocked' || st === 'failed')) ||
			(s === 'scoped' && st === 'idle'),
		to: { state: 'refine', status: 'idle', needsAgent: true },
	},
	// §6.14: scoping-time alternative to refine — fans a task out into smaller
	// ones instead of writing this task's own Scope. Reuses the Refine column
	// as its "in flight" state (same as refine's own launch), which is why
	// Stop already works on a running split with no rule of its own below.
	// Legal one column earlier than refine's own retry range: straight from
	// Backlog, since deciding "this is too big" is usually the first thing
	// noticed about a raw request, before any scoping work has started.
	split: {
		from: (s, st) =>
			(s === 'backlog' && st === 'idle') ||
			(s === 'refine' && (st === 'idle' || st === 'blocked' || st === 'failed')) ||
			(s === 'scoped' && st === 'idle'),
		to: { state: 'refine', status: 'idle', needsAgent: true },
	},
	// Pure gate, like Accept — no session reset on entry (§6.8: Develop injects
	// into the *same* conversation refine used; layers 2–3, not a reset, are
	// what keep a human's scope edit authoritative).
	approve: {
		from: (s, st) => s === 'scoped' && st === 'idle',
		to: { state: 'approved', status: 'idle', needsAgent: false },
	},
	// Unlike Accept, Develop both moves the card *and* launches the run in one
	// click — there's no separate "start" action once inside In Progress.
	develop: {
		from: (s, st) => s === 'approved' && st === 'idle',
		to: { state: 'in-progress', status: 'idle', needsAgent: true },
	},
	// Retries a develop run after it lands in blocked/failed. Never reachable
	// with status 'paused' or 'running' — Stop resets in-progress all the way
	// back to Approved (below), it doesn't leave a resumable pause behind.
	continue: {
		from: (s, st) => s === 'in-progress' && st !== 'running',
		to: { state: 'in-progress', status: 'idle', needsAgent: true },
	},
	// In-place vs. bounce-to-Approved is decided in applyAction, per column —
	// see STOP_IN_PLACE.
	stop: {
		from: (s, st) => (s === 'refine' || s === 'in-progress' || s === 'validation') && st === 'running',
		to: { state: 'refine', status: 'idle', needsAgent: false }, // placeholder — overridden below
	},
	// Launches a real validation run (§12 Q10). Its own outcome branches
	// further than any other stage: pass moves to Done, fail sends the card
	// back to In Progress for another development pass, blocked stays put —
	// that branching lives in RunManager, not here, since it depends on the
	// run's *result*, not just on this action being clicked.
	// Retryable from blocked/failed too, same pattern as refine's retry — a
	// validation the agent couldn't judge or that errored shouldn't need a
	// human to do anything but click the same button again.
	validate: {
		from: (s, st) => s === 'validation' && (st === 'idle' || st === 'blocked' || st === 'failed'),
		to: { state: 'validation', status: 'idle', needsAgent: true }, // RunManager bumps to 'running'
	},
	// Open question 3 (PRD §12), resolved here: reuse the existing Stop+reset
	// precedent rather than losing scope back to Backlog — reopening a task
	// almost always means "the build was wrong," not "the scope was wrong."
	reopen: {
		from: (s) => s === 'done',
		to: { state: 'approved', status: 'idle', needsAgent: false },
	},
};

/**
 * Applies `action` to a task's current (state, status). Returns the resulting
 * (state, status) if the action is legal there, `undefined` if it is not —
 * callers use `undefined` to no-op rather than trust client-side button state.
 */
export function applyAction(
	current: { state: Column; status: Status },
	action: TaskAction,
): TransitionResult | undefined {
	const rule = RULES[action];
	if (!rule.from(current.state, current.status)) {
		return undefined;
	}

	if (action === 'stop') {
		if (STOP_IN_PLACE.has(current.state)) {
			return { state: current.state, status: 'idle', needsAgent: false };
		}
		return { state: 'approved', status: 'idle', needsAgent: false }; // in-progress: "Stop + reset"
	}
	return rule.to;
}

/**
 * Applies one validated receipt completion to its expected source state.
 * Pending outcomes are deliberately separate from `TASK_ACTIONS`: they are
 * durable decisions, not ordinary human escape controls or retry actions.
 */
export function applyPendingTransition(
	current: { state: Column; status: Status },
	pending: PendingOutcome,
): PendingTransitionResult | undefined {
	if (!isPendingOutcome(pending) || current.status !== 'idle') {
		return undefined;
	}

	const gate = gateForId(pending.gate);
	if (!gate || gate.kind !== 'receipt-completion' || current.state !== gate.source) {
		return undefined;
	}

	return {
		state: gate.target,
		status: gate.targetStatus,
		gate: gate.id,
	};
}
