/**
 * Task-proposal grammar (PRD §6.12) — the optional line an agent may add
 * during develop or validate to file follow-up work as its own task, rather
 * than folding it into the current one:
 *
 *   - propose-task run:<runId> title:"<short title>" note:"<why this is separate>"
 *
 * Deliberately mirrors receipt.ts's shape: a `- `-prefixed, regex-matched
 * line in `## Log`, tolerant of surrounding prose, scoped to a specific run
 * id so a stale or foreign line can never be replayed. `RunManager` only
 * looks these up for the run it just finished, the same way it looks up
 * that run's own receipt.
 */

export interface Proposal {
	runId: string;
	title: string;
	note: string;
}

const PROPOSAL_LINE = /^-\s*propose-task\s+run:(\S+)\s+title:"([^"]*)"\s+note:"([^"]*)"\s*$/;

/** Parses every well-formed proposal line in a `## Log` section, in file order. */
export function parseProposals(logSection: string): Proposal[] {
	const proposals: Proposal[] = [];
	for (const line of logSection.split(/\r?\n/)) {
		const match = PROPOSAL_LINE.exec(line.trim());
		if (match) {
			const [, runId, title, note] = match;
			proposals.push({ runId, title, note });
		}
	}
	return proposals;
}

/** Proposals filed by a specific run, in the order they were written. */
export function proposalsForRun(logSection: string, runId: string): Proposal[] {
	return parseProposals(logSection).filter((p) => p.runId === runId);
}
