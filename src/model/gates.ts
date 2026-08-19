import type { Stage, ReceiptResult } from '../chat/receipt';
import type { TaskAction } from '../board/stateMachine';
import type { Column } from './task';

/** The two supported policy values for an automation gate. */
export type GatePolicy = 'manual' | 'auto';

export type GateId =
	| 'backlogToRefine'
	| 'refineToScoped'
	| 'scopedToApproved'
	| 'approvedToInProgress'
	| 'developToValidation'
	| 'validationAutoStart'
	| 'validateToDone'
	| 'validateFailedToInProgress'
	| 'splitToDone';

/** A gate that starts a human-visible workflow action. */
export interface StageStartGateDefinition {
	id: GateId;
	settingKey: string;
	label: string;
	description: string;
	defaultPolicy: GatePolicy;
	kind: 'stage-start';
	source: Column;
	target: Column;
	targetStatus: 'idle';
	stage: Stage;
	action: TaskAction;
	triggerStage: Stage;
	triggerAction: TaskAction;
	beforeAction?: TaskAction;
	capacity: boolean;
}

/** A gate that controls when a receipt outcome is committed to the card. */
export interface ReceiptGateDefinition {
	id: GateId;
	settingKey: string;
	label: string;
	description: string;
	defaultPolicy: GatePolicy;
	kind: 'receipt-completion';
	source: Column;
	target: Column;
	targetStatus: 'idle';
	stage: Stage;
	result: ReceiptResult;
	triggerStage: Stage;
	triggerResult: ReceiptResult;
	capacity: false;
}

export type GateDefinition = StageStartGateDefinition | ReceiptGateDefinition;

/**
	The authoritative automation matrix. Keep identifiers stable: they are used
	in settings, task frontmatter pending payloads, tests, and documentation.

	Stage-start gates and receipt-completion gates intentionally remain separate.
	In particular, `validationAutoStart` only controls launching Validate; it does
	not decide whether a Validate receipt is committed.
 */
const GATE_DEFINITIONS = [
	{
		id: 'backlogToRefine',
		settingKey: 'gates.backlogToRefine',
		label: 'Backlog → Refine',
		description: 'Accept a new task and launch its refine run automatically.',
		defaultPolicy: 'manual',
		kind: 'stage-start',
		source: 'backlog',
		target: 'refine',
		targetStatus: 'idle',
		stage: 'refine',
		action: 'refine',
		triggerStage: 'refine',
		triggerAction: 'refine',
		beforeAction: 'accept',
		capacity: true,
	},
	{
		id: 'refineToScoped',
		settingKey: 'gates.refineToScoped',
		label: 'Refine → Scoped',
		description: 'Commit a successful Refine receipt into the Scoped column automatically.',
		defaultPolicy: 'manual',
		kind: 'receipt-completion',
		source: 'refine',
		target: 'scoped',
		targetStatus: 'idle',
		stage: 'refine',
		result: 'ok',
		triggerStage: 'refine',
		triggerResult: 'ok',
		capacity: false,
	},
	{
		id: 'scopedToApproved',
		settingKey: 'gates.scopedToApproved',
		label: 'Scoped → Approved',
		description: 'Approve a freshly-scoped task into the ready queue automatically.',
		defaultPolicy: 'manual',
		kind: 'stage-start',
		source: 'scoped',
		target: 'approved',
		targetStatus: 'idle',
		stage: 'refine',
		action: 'approve',
		triggerStage: 'refine',
		triggerAction: 'approve',
		capacity: false,
	},
	{
		id: 'approvedToInProgress',
		settingKey: 'gates.approvedToInProgress',
		label: 'Approved → In Progress',
		description: 'Start development on an Approved task while the shared run-capacity limit has room.',
		defaultPolicy: 'manual',
		kind: 'stage-start',
		source: 'approved',
		target: 'in-progress',
		targetStatus: 'idle',
		stage: 'develop',
		action: 'develop',
		triggerStage: 'develop',
		triggerAction: 'develop',
		capacity: true,
	},
	{
		id: 'developToValidation',
		settingKey: 'gates.developToValidation',
		label: 'Develop → Validation',
		description: 'Commit a successful Develop receipt into Validation automatically.',
		defaultPolicy: 'manual',
		kind: 'receipt-completion',
		source: 'in-progress',
		target: 'validation',
		targetStatus: 'idle',
		stage: 'develop',
		result: 'ok',
		triggerStage: 'develop',
		triggerResult: 'ok',
		capacity: false,
	},
	{
		id: 'validationAutoStart',
		settingKey: 'gates.validationAutoStart',
		label: 'Validation auto-start',
		description: 'Launch Validate the moment a task is sitting in Validation.',
		defaultPolicy: 'manual',
		kind: 'stage-start',
		source: 'validation',
		target: 'validation',
		targetStatus: 'idle',
		stage: 'validate',
		action: 'validate',
		triggerStage: 'validate',
		triggerAction: 'validate',
		capacity: true,
	},
	{
		id: 'validateToDone',
		settingKey: 'gates.validateToDone',
		label: 'Validate → Done',
		description: 'Commit a successful Validate receipt into Done automatically.',
		defaultPolicy: 'manual',
		kind: 'receipt-completion',
		source: 'validation',
		target: 'done',
		targetStatus: 'idle',
		stage: 'validate',
		result: 'ok',
		triggerStage: 'validate',
		triggerResult: 'ok',
		capacity: false,
	},
	{
		id: 'validateFailedToInProgress',
		settingKey: 'gates.validateFailedToInProgress',
		label: 'Failed Validate → In Progress',
		description: 'Send a failed validation verdict back for another development pass automatically.',
		defaultPolicy: 'manual',
		kind: 'receipt-completion',
		source: 'validation',
		target: 'in-progress',
		targetStatus: 'idle',
		stage: 'validate',
		result: 'failed',
		triggerStage: 'validate',
		triggerResult: 'failed',
		capacity: false,
	},
	{
		id: 'splitToDone',
		settingKey: 'gates.splitToDone',
		label: 'Successful Split → Done',
		description: 'Retire a split parent after its child tasks have been persisted.',
		defaultPolicy: 'manual',
		kind: 'receipt-completion',
		source: 'refine',
		target: 'done',
		targetStatus: 'idle',
		stage: 'split',
		result: 'ok',
		triggerStage: 'split',
		triggerResult: 'ok',
		capacity: false,
	},
] as const;

export const GATE_CATALOG: readonly GateDefinition[] = GATE_DEFINITIONS;

export const STAGE_START_GATES: readonly StageStartGateDefinition[] = GATE_CATALOG.filter(
	(gate): gate is StageStartGateDefinition => gate.kind === 'stage-start',
);

export const RECEIPT_COMPLETION_GATES: readonly ReceiptGateDefinition[] = GATE_CATALOG.filter(
	(gate): gate is ReceiptGateDefinition => gate.kind === 'receipt-completion',
);

export function gateForId(value: unknown): GateDefinition | undefined {
	return typeof value === 'string' ? GATE_CATALOG.find((gate) => gate.id === value) : undefined;
}

export function gateForSettingKey(value: unknown): GateDefinition | undefined {
	return typeof value === 'string' ? GATE_CATALOG.find((gate) => gate.settingKey === value) : undefined;
}

export function receiptGateFor(stage: Stage, result: ReceiptResult): ReceiptGateDefinition | undefined {
	return RECEIPT_COMPLETION_GATES.find((gate) => gate.stage === stage && gate.result === result);
}