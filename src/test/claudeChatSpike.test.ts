import * as assert from 'assert';

import {
	analyzeClaudeSurface,
	buildClaudeOpenUri,
	createIsolationPlan,
	type ClaudeExtensionSnapshot,
} from '../spike/claudeChatProbe';
import { collectClaudeChatHostProbe } from '../spike/claudeChatHostProbe';

const snapshot: ClaudeExtensionSnapshot = {
	version: '2.1.233',
	vscodeEngine: '^1.94.0',
	declaredCommands: ['claude-vscode.primaryEditor.open'],
	hasPackageExports: false,
	sourceMarkers: {
		uriHandler: true,
		openRoute: true,
		sessionParameter: true,
		promptParameter: true,
	},
};

suite('Claude chat spike probe', () => {
	test('builds a non-submitting deep link with encoded session and prompt', () => {
		const uri = buildClaudeOpenUri('session/one', 'marker CLAUDE_SPIKE_TASK_A');
		assert.strictEqual(
			uri,
			'vscode://anthropic.claude-code/open?session=session%2Fone&prompt=marker+CLAUDE_SPIKE_TASK_A',
		);
	});

	test('keeps the two sanitized isolation cases distinct', () => {
		const plan = createIsolationPlan();
		assert.notStrictEqual(plan.cases[0].taskId, plan.cases[1].taskId);
		assert.notStrictEqual(plan.cases[0].marker, plan.cases[1].marker);
		assert.ok(plan.assertions.some((assertion) => assertion.includes('session ids')));
	});

	test('records open/resume as partial and the critical path as blocked', () => {
		const report = analyzeClaudeSurface(snapshot);
		assert.strictEqual(report.operations.openOrResumeSession.status, 'partial');
		assert.strictEqual(report.operations.injectPromptWithAttachment.status, 'not-supported');
		assert.strictEqual(report.operations.waitForCompletion.status, 'not-supported');
		assert.ok(report.criticalPath.firstRun.startsWith('blocked:'));
	});

	test('host inventory does not invoke Claude', async () => {
		const report = await collectClaudeChatHostProbe();
		assert.strictEqual(report.invokedClaude, false);
	});
});