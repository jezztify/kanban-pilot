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
 * Finds the receipt for a specific run, requiring the task id to match too.
 * A `run:` match with a different `task:` is treated as absent (§6.9) —
 * exactly the shape a misrouted prompt would produce, so it must not be
 * accepted as this run's completion.
 */
export function findReceipt(logSection: string, runId: string, taskId: string): Receipt | undefined {
	return parseReceipts(logSection).find((r) => r.runId === runId && r.taskId === taskId);
}

/** Renders the extension's own receipt line, for reconciliation notes (§6.4). */
export function formatReceipt(receipt: Receipt): string {
	return `- run:${receipt.runId} task:${receipt.taskId} stage:${receipt.stage} result:${receipt.result} note:"${receipt.note}"`;
}
