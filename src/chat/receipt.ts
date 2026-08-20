/**
 * Receipt grammar (PRD §6.3, §6.9) — the one structural thing the agent is
 * asked to write:
 *
 *   - run:<runId> task:<taskId> stage:<refine|develop|validate> result:<ok|blocked|failed> note:"<free text>"
 *
 * A receipt whose `task:` disagrees with the file it's found in is rejected
 * rather than accepted as completion (§6.9's misroute containment) — the
 * caller always parses a specific task's own `## Log` section, so this
 * module treats a task-id mismatch as "no receipt," not as a different kind
 * of result.
 *
 * `result` means something stage-dependent for `validate`: elsewhere,
 * `failed` means the *run* went wrong (agent errored, couldn't proceed).
 * For validate it doubles as "the run succeeded and the agent determined the
 * acceptance criteria were **not** met" — a real outcome, not an error, which
 * is why `RunManager` routes it back to In Progress rather than leaving the
 * card stuck. An actually-errored validate run never reaches this far: it's
 * caught earlier, before a receipt is even looked for (§6.4).
 *
 * `split` (§6.14) is the fourth stage: a scoping-time alternative to refine
 * that fans a task out into smaller ones instead of writing this task's own
 * Scope. Its `result:ok` doesn't mean "scoped" the way refine's does — it
 * means "split into children, this task is now tracking-only" (§6.14).
 */

export type ReceiptResult = 'ok' | 'blocked' | 'failed';
export type Stage = 'refine' | 'develop' | 'validate' | 'split';

export interface Receipt {
	runId: string;
	taskId: string;
	stage: Stage;
	result: ReceiptResult;
	note: string;
}

export interface ReceiptExpectation {
	runId: string;
	taskId: string;
	stage: Stage;
}

export type ReceiptIssueKind = 'task-mismatch' | 'run-mismatch' | 'stage-mismatch' | 'malformed';

export interface ReceiptIssue {
	kind: ReceiptIssueKind;
	receipt?: Receipt;
	line?: string;
}

export interface ReceiptDetails {
	receipt?: Receipt;
	issues: ReceiptIssue[];
}

const RECEIPT_LINE =
	/^-\s*run:(\S+)\s+task:(\S+)\s+stage:(refine|develop|validate|split)\s+result:(ok|blocked|failed)\s+note:"([^"]*)"\s*$/;

/** Parses every well-formed receipt line in a `## Log` section, in file order. */
export function parseReceipts(logSection: string): Receipt[] {
	const receipts: Receipt[] = [];
	for (const line of logSection.split(/\r?\n/)) {
		const match = RECEIPT_LINE.exec(line.trim());
		if (match) {
			const [, runId, taskId, stage, result, note] = match;
			receipts.push({ runId, taskId, stage: stage as Stage, result: result as ReceiptResult, note });
		}
	}
	return receipts;
}

/**
 * Finds the latest receipt for a specific run, requiring the task id to match too.
 * A `run:` match with a different `task:` is treated as absent (§6.9) —
 * exactly the shape a misrouted prompt would produce, so it must not be
 * accepted as this run's completion.
 */
export function findReceipt(logSection: string, runId: string, taskId: string): Receipt | undefined {
	return findLatestReceipt(logSection, runId, taskId);
}

/**
 * Finds the latest receipt with the exact run, task, and stage identity while
 * retaining enough detail for reconciliation to explain ignored entries.
 * `findReceipt` intentionally keeps its older run/task-only contract; stage
 * reconciliation uses this stricter lookup so a later wrong-stage line cannot
 * hide an otherwise valid receipt for the active stage.
 */
export function findReceiptDetails(logSection: string, expected: ReceiptExpectation): ReceiptDetails {
	let receipt: Receipt | undefined;
	const issues: ReceiptIssue[] = [];

	for (const line of logSection.split(/\r?\n/)) {
		const trimmed = line.trim();
		const match = RECEIPT_LINE.exec(trimmed);
		if (!match) {
			if (/^-\s*run:/.test(trimmed)) {
				issues.push({ kind: 'malformed', line: trimmed });
			}
			continue;
		}

		const [, runId, taskId, stage, result, note] = match;
		const candidate: Receipt = {
			runId,
			taskId,
			stage: stage as Stage,
			result: result as ReceiptResult,
			note,
		};

		if (candidate.taskId !== expected.taskId) {
			issues.push({ kind: 'task-mismatch', receipt: candidate });
			continue;
		}
		if (candidate.runId !== expected.runId) {
			issues.push({ kind: 'run-mismatch', receipt: candidate });
			continue;
		}
		if (candidate.stage !== expected.stage) {
			issues.push({ kind: 'stage-mismatch', receipt: candidate });
			continue;
		}

		receipt = candidate;
	}

	return { receipt, issues };
}

/** Finds the last receipt for a run/task pair, so a late outcome can supersede an extension fallback receipt. */
export function findLatestReceipt(logSection: string, runId: string, taskId: string): Receipt | undefined {
	const receipts = parseReceipts(logSection);
	for (let i = receipts.length - 1; i >= 0; i--) {
		const receipt = receipts[i];
		if (receipt.runId === runId && receipt.taskId === taskId) {
			return receipt;
		}
	}
	return undefined;
}

/** Renders the extension's own receipt line, for reconciliation notes (§6.4). */
export function formatReceipt(receipt: Receipt): string {
	return `- run:${receipt.runId} task:${receipt.taskId} stage:${receipt.stage} result:${receipt.result} note:"${receipt.note}"`;
}
