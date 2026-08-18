import * as assert from 'assert';

import { parseProposals, proposalsForRun } from '../chat/proposals';

/** M3.5 — task-proposal grammar (PRD §6.12). */

suite('M3.5 proposal grammar', () => {
	test('parses a well-formed propose-task line', () => {
		const log = '- propose-task run:r19 title:"Add retry backoff" note:"discovered during implementation"';
		const [proposal] = parseProposals(log);

		assert.strictEqual(proposal.runId, 'r19');
		assert.strictEqual(proposal.title, 'Add retry backoff');
		assert.strictEqual(proposal.note, 'discovered during implementation');
		assert.strictEqual(proposal.type, undefined, 'old syntax remains an omitted-type proposal');
	});

	test('parses an explicit canonical type and rejects an invalid one', () => {
		const log = [
			'- propose-task run:r19 type:bug title:"Fix retry backoff" note:"defect found during implementation"',
			'- propose-task run:r19 type:feature title:"Add metrics" note:"follow-up capability"',
			'- propose-task run:r19 type:regression title:"Never create this" note:"invalid type"',
		].join('\n');

		const proposals = parseProposals(log);
		assert.deepStrictEqual(proposals.map((proposal) => proposal.type), ['bug', 'feature']);
		assert.deepStrictEqual(proposals.map((proposal) => proposal.title), ['Fix retry backoff', 'Add metrics']);
	});

	test('ignores free-form prose and unrelated receipt lines around it', () => {
		const log = [
			'- run:r19 task:TASK-142 stage:develop result:ok note:"done"',
			'- propose-task run:r19 title:"Add retry backoff" note:"discovered during implementation"',
			'Some trailing note the agent left.',
		].join('\n');

		assert.strictEqual(parseProposals(log).length, 1);
	});

	test('proposalsForRun filters to a single run, in file order', () => {
		const log = [
			'- propose-task run:r19 title:"First" note:"a"',
			'- propose-task run:r20 title:"From a different run" note:"b"',
			'- propose-task run:r19 title:"Second" note:"c"',
		].join('\n');

		const forR19 = proposalsForRun(log, 'r19');
		assert.deepStrictEqual(
			forR19.map((p) => p.title),
			['First', 'Second'],
		);
	});

	test('a line missing a required field is not parsed', () => {
		const log = '- propose-task run:r19 title:"Missing note"';
		assert.strictEqual(parseProposals(log).length, 0);
	});
});
