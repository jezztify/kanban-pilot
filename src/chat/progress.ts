/**
 * Progress-line grammar (TASK-003) — an optional, interim companion to the
 * receipt grammar in [`receipt.ts`](./receipt.ts). While a run is in flight the
 * agent may append coarse one-line progress summaries to a task's `## Log`
 * *before* its terminal receipt, so a remote browser viewer of the board can
 * watch the work happen rather than only watch the card's column change:
 *
 *   - progress run:<runId> task:<taskId> at:<utc> note:"<free text>"
 *
 * A progress line is deliberately **not** a receipt: it carries no
 * `stage`/`result`, so it never terminates a run — `findReceipt()` in
 * `receipt.ts` still requires a `stage`+`result` line and ignores this one.
 * Like a receipt, a line whose `task:` disagrees with the file it is found in
 * is ignored rather than surfaced (§6.9 misroute containment): the caller
 * always parses a specific task's own `## Log` section, so this module treats a
 * task-id mismatch as "not this task's progress," not as a different result.
 *
 * The note is a human/agent-authored summary — "editing `foo.ts`", "running
 * tests", "waiting for approval in VS Code" — never a raw payload, source, or
 * secret; the feed rides a shared, token-gated HTTP surface.
 */

import { utcTimestamp } from '../model/taskLog';

export interface ProgressEntry {
	runId: string;
	taskId: string;
	at: string;
	note: string;
}

const PROGRESS_LINE =
	/^-\s*progress\s+run:(\S+)\s+task:(\S+)\s+at:(\S+)\s+note:"([^"]*)"\s*$/;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * True for a canonical second-precision UTC timestamp. Mirrors the validation
 * approach in [`taskLog.ts`](../model/taskLog.ts): canonicalise through the
 * same formatter used for generated timestamps, which also rejects impossible
 * dates the JavaScript date parser silently normalises.
 */
function isUtcTimestamp(value: string): boolean {
	if (!UTC_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
		return false;
	}
	try {
		return utcTimestamp(new Date(value)) === value;
	} catch {
		return false;
	}
}

/**
 * Parses every well-formed progress line for `taskId` in a `## Log` section, in
 * file order. Lines that don't match the grammar, whose `task:` differs from
 * `taskId`, or whose `at:` is not a canonical UTC timestamp are dropped.
 */
export function parseProgressEntries(logSection: string, taskId: string): ProgressEntry[] {
	const entries: ProgressEntry[] = [];
	for (const line of logSection.split(/\r?\n/)) {
		const match = PROGRESS_LINE.exec(line.trim());
		if (!match) {
			continue;
		}
		const [, runId, entryTaskId, at, note] = match;
		if (entryTaskId !== taskId || !isUtcTimestamp(at)) {
			continue;
		}
		entries.push({ runId, taskId: entryTaskId, at, note });
	}
	return entries;
}

/** Formats a progress entry as its canonical `## Log` line. */
export function formatProgressLine(entry: ProgressEntry): string {
	return `- progress run:${entry.runId} task:${entry.taskId} at:${entry.at} note:"${entry.note}"`;
}
