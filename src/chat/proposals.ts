/**
 * Task-proposal grammar (PRD §6.12) — the optional line an agent may add
 * during develop or validate to file follow-up work as its own task, rather
 * than folding it into the current one:
 *
 *   - propose-task run:<runId> type:<feature|bug> title:"<short title>" note:"<why this is separate>"
 *
 * `type:` is optional for compatibility with older agents; an omitted type is
 * resolved from the originating task by `RunManager`. A type other than
 * `feature` or `bug` makes the whole proposal line invalid and it is ignored.
 *
 * Deliberately mirrors receipt.ts's shape: a `- `-prefixed, regex-matched
 * line in `## Log`, tolerant of surrounding prose, scoped to a specific run
 * id so a stale or foreign line can never be replayed. `RunManager` only
 * looks these up for the run it just finished, the same way it looks up
 * that run's own receipt.
 */

import { createHash } from 'crypto';
import { isTaskType, TaskType } from '../model/task';

export interface Proposal {
	runId: string;
	title: string;
	note: string;
	type?: TaskType;
	parentTaskId?: string;
}

/** Stable identity for one accepted proposal, used to make retries reload-safe. */
export function proposalFingerprint(proposal: Proposal, type: TaskType): string {
	const identity = proposal.parentTaskId === undefined
		? [proposal.runId, type, proposal.title, proposal.note]
		: [proposal.runId, type, proposal.title, proposal.note, proposal.parentTaskId];
	return createHash('sha256')
		.update(JSON.stringify(identity))
		.digest('hex')
		.slice(0, 24);
}

const PROPOSAL_LINE = /^-\s*propose-task\s+run:(\S+)((?:\s+(?:type|parent):\S+)*)\s+title:"([^"]*)"\s+note:"([^"]*)"\s*$/;

/** Parses every well-formed proposal line in a `## Log` section, in file order. */
export function parseProposals(logSection: string): Proposal[] {
	const proposals: Proposal[] = [];
	for (const line of logSection.split(/\r?\n/)) {
		const match = PROPOSAL_LINE.exec(line.trim());
		if (match) {
			const [, runId, rawMetadata, title, note] = match;
			let rawType: string | undefined;
			let rawParent: string | undefined;
			let validMetadata = true;
			for (const token of rawMetadata.trim().split(/\s+/).filter(Boolean)) {
				const separator = token.indexOf(':');
				const key = token.slice(0, separator);
				const value = token.slice(separator + 1);
				if (key === 'type' && rawType === undefined) {
					rawType = value;
				} else if (key === 'parent' && rawParent === undefined) {
					rawParent = value;
				} else {
					validMetadata = false;
				}
			}
			if (!validMetadata) {
				continue;
			}
			if (rawType !== undefined && !isTaskType(rawType)) {
				continue;
			}
			if (rawParent !== undefined && !/^TASK-\d+$/.test(rawParent)) {
				continue;
			}
			proposals.push({
				runId,
				title,
				note,
				...(rawType ? { type: rawType } : {}),
				...(rawParent ? { parentTaskId: rawParent } : {}),
			});
		}
	}
	return proposals;
}

/** Proposals filed by a specific run, in the order they were written. */
export function proposalsForRun(logSection: string, runId: string): Proposal[] {
	return parseProposals(logSection).filter((p) => p.runId === runId);
}
