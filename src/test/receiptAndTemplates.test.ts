import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { findLatestReceipt, findReceipt, findReceiptDetails, formatReceipt, parseReceipts } from '../chat/receipt';
import { loadPromptTemplate, renderTemplate, TemplateVars } from '../chat/promptTemplates';
import { hashScope } from '../chat/scopeHash';
import { STAGE_AGENT_NAME } from '../chat/agentNames';

/** M3 — receipt grammar, prompt templates, scope hashing (PRD §6.3, §6.5, §6.8). */

function baseVars(overrides: Partial<TemplateVars> = {}): TemplateVars {
	return {
		id: 'TASK-142',
		title: 'Set up billing webhook',
		agentName: 'Bro Refiner',
		projectName: 'test', // matches tempFolder()'s WorkspaceFolder.name below
		runId: 'r7',
		request: '',
		refined: '',
		scope: '',
		taskFilePath: '/workspace/.kanban-pilot/task-sets/set-mobile/tasks/TASK-142.md',
		scopeEdited: false,
		...overrides,
	};
}

async function tempFolder(): Promise<{ folder: vscode.WorkspaceFolder; dispose: () => Promise<void> }> {
	const dir = vscode.Uri.file(
		path.join(os.tmpdir(), `kanban-pilot-tmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`),
	);
	return {
		folder: { uri: dir, name: 'test', index: 0 },
		dispose: async () => {
			await vscode.workspace.fs.delete(dir, { recursive: true });
		},
	};
}

suite('M3 receipt grammar', () => {
	test('parses a well-formed receipt line', () => {
		const log = '- run:r7 task:TASK-142 stage:refine result:ok note:"scope written, 3 files"';
		const [receipt] = parseReceipts(log);

		assert.strictEqual(receipt.runId, 'r7');
		assert.strictEqual(receipt.taskId, 'TASK-142');
		assert.strictEqual(receipt.stage, 'refine');
		assert.strictEqual(receipt.result, 'ok');
		assert.strictEqual(receipt.note, 'scope written, 3 files');
	});

	test('parses a validate-stage receipt', () => {
		const log = '- run:r9 task:TASK-142 stage:validate result:failed note:"missing idempotency test"';
		const [receipt] = parseReceipts(log);

		assert.strictEqual(receipt.stage, 'validate');
		assert.strictEqual(receipt.result, 'failed');
	});

	test('parses a split-stage receipt (§6.14)', () => {
		const log = '- run:r11 task:TASK-142 stage:split result:ok note:"split into 3 tasks"';
		const [receipt] = parseReceipts(log);

		assert.strictEqual(receipt.stage, 'split');
		assert.strictEqual(receipt.result, 'ok');
	});

	test('ignores free-form prose around a receipt line', () => {
		const log = [
			'Some free-form notes the agent left.',
			'- run:r7 task:TASK-142 stage:refine result:ok note:"done"',
			'More prose after.',
		].join('\n');

		assert.strictEqual(parseReceipts(log).length, 1);
	});

	test('findReceipt requires both run and task to match — a task mismatch is treated as absent (§6.9)', () => {
		const log = '- run:r7 task:TASK-999 stage:refine result:ok note:"wrong file"';

		assert.strictEqual(findReceipt(log, 'r7', 'TASK-999')?.result, 'ok');
		assert.strictEqual(findReceipt(log, 'r7', 'TASK-142'), undefined, 'run matches but task does not — must not be accepted');
	});

	test('findReceipt returns undefined when the run id is not present at all', () => {
		const log = '- run:r1 task:TASK-142 stage:refine result:ok note:"unrelated"';
		assert.strictEqual(findReceipt(log, 'r7', 'TASK-142'), undefined);
	});

	test('findReceipt returns the latest matching receipt when a run has multiple outcomes', () => {
		const log = [
			'- run:r7 task:TASK-142 stage:refine result:blocked note:"no receipt found; awaiting late receipt"',
			'- run:r7 task:TASK-142 stage:refine result:ok note:"late completion"',
		].join('\n');

		assert.strictEqual(findLatestReceipt(log, 'r7', 'TASK-142')?.result, 'ok');
		assert.strictEqual(findReceipt(log, 'r7', 'TASK-142')?.note, 'late completion');
	});

	test('findReceiptDetails selects the exact stage and classifies ignored receipts', () => {
		const log = [
			'- run:old task:TASK-142 stage:refine result:ok note:"stale"',
			'- run:r7 task:TASK-999 stage:refine result:ok note:"wrong task"',
			'- run:r7 task:TASK-142 stage:validate result:ok note:"wrong stage"',
			'- run:r7 task:TASK-142 stage:refine result:ok note:"active"',
			'- run:r7 task:TASK-142 stage:refine result:okay note:"malformed result"',
		].join('\n');

		const lookup = findReceiptDetails(log, { runId: 'r7', taskId: 'TASK-142', stage: 'refine' });
		assert.strictEqual(lookup.receipt?.note, 'active');
		assert.deepStrictEqual(
			lookup.issues.map((issue) => issue.kind),
			['run-mismatch', 'task-mismatch', 'stage-mismatch', 'malformed'],
		);
	});

	test('formatReceipt round-trips through parseReceipts', () => {
		const line = formatReceipt({ runId: 'r8', taskId: 'TASK-142', stage: 'develop', result: 'blocked', note: 'needs a decision' });
		const [parsed] = parseReceipts(line);

		assert.deepStrictEqual(parsed, { runId: 'r8', taskId: 'TASK-142', stage: 'develop', result: 'blocked', note: 'needs a decision' });
	});

	test('audit lines can surround receipts without changing the receipt grammar', () => {
		const log = [
			'- audit:activity-start at:2026-08-17T10:00:00Z task:TASK-142 stage:refine action:refine run:r8 note:"Started refine activity."',
			'- run:r8 task:TASK-142 stage:refine result:ok note:"done"',
			'- audit:activity-finish at:2026-08-17T10:00:01Z task:TASK-142 stage:refine action:receipt run:r8 outcome:ok note:"done"',
		].join('\n');

		assert.deepStrictEqual(parseReceipts(log).map((receipt) => receipt.result), ['ok']);
	});
});

suite('M3 scope hash', () => {
	test('is stable for identical content and changes when content changes', () => {
		const a = hashScope('- [ ] one\n- [ ] two');
		const b = hashScope('- [ ] one\n- [ ] two');
		const c = hashScope('- [ ] one\n- [ ] two\n- [ ] three');

		assert.strictEqual(a, b);
		assert.notStrictEqual(a, c);
	});

	test('ignores surrounding whitespace', () => {
		assert.strictEqual(hashScope('  same  \n'), hashScope('same'));
	});
});

suite('M3 prompt templates', () => {
	test('renderTemplate substitutes variables', () => {
		const out = renderTemplate(
			'@{{agentName}}\n## [{{projectName}} {{id}}]\n# {{title}}',
			baseVars({ id: 'TASK-142', title: 'Set up billing webhook', agentName: 'Bro Refiner', projectName: 'kanban-pilot' }),
		);

		assert.strictEqual(out, '@Bro Refiner\n## [kanban-pilot TASK-142]\n# Set up billing webhook');
	});

	test('renderTemplate includes a conditional block only when the flag is true', () => {
		const template = 'before{{#scopeEdited}} EDITED {{/scopeEdited}}after';

		assert.strictEqual(renderTemplate(template, baseVars({ scopeEdited: true })), 'before EDITED after');
		assert.strictEqual(renderTemplate(template, baseVars({ scopeEdited: false })), 'beforeafter');
	});

	test('each default template embeds its stage\'s agent name, the [project task] banner, and a parseable receipt instruction', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			for (const stage of ['refine', 'develop', 'validate', 'split'] as const) {
				const template = await loadPromptTemplate(folder, stage);
				const rendered = renderTemplate(
					template,
					baseVars({ agentName: STAGE_AGENT_NAME[stage], projectName: folder.name, runId: 'r7' }),
				);

				assert.ok(
					rendered.includes(`## [${folder.name} TASK-142]`),
					`${stage}: missing the misroute-visibility banner (§6.9)`,
				);
				assert.ok(rendered.startsWith(`@${STAGE_AGENT_NAME[stage]}\n`), `${stage}: @agentName must open the message`);
				assert.ok(rendered.includes('# Set up billing webhook'), `${stage}: missing the title heading`);
				assert.ok(rendered.includes('## Request'), `${stage}: missing the Request section`);
				assert.ok(rendered.includes('## On Completion'), `${stage}: missing the On Completion section`);
				assert.ok(
					rendered.includes('kanban-pilot: extension-supervised'),
					`${stage}: missing the extension-supervised context marker`,
				);
				assert.ok(
					rendered.includes('RunManager applies the state transition'),
					`${stage}: must assign extension state transitions to RunManager`,
				);
				assert.ok(
					rendered.includes('Do not edit YAML frontmatter (state, status, run, updated, or'),
					`${stage}: must prohibit agent frontmatter edits`,
				);
				assert.ok(rendered.includes('run:r7'), `${stage}: receipt instruction must carry this run's id`);
				assert.ok(rendered.includes('task:TASK-142'), `${stage}: receipt instruction must carry this task's id`);
				assert.ok(rendered.includes(`stage:${stage}`), `${stage}: receipt instruction must carry its own stage`);
			}
		} finally {
			await dispose();
		}
	});

	test('each default template labels completion and non-completion with stage-specific receipt results', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const expectedResults = {
				refine: { completion: ['ok'], nonCompletion: ['blocked'] },
				develop: { completion: ['ok'], nonCompletion: ['blocked'] },
				validate: { completion: ['ok', 'failed'], nonCompletion: ['blocked'] },
				split: { completion: ['ok'], nonCompletion: ['blocked'] },
			} as const;

			for (const stage of ['refine', 'develop', 'validate', 'split'] as const) {
				const template = await loadPromptTemplate(folder, stage);
				const rendered = renderTemplate(
					template,
					baseVars({ agentName: STAGE_AGENT_NAME[stage], projectName: folder.name, runId: 'r7' }),
				);
				const onCompletionStart = rendered.indexOf('## On Completion');
				const completionStart = rendered.indexOf('### Completion');
				const nonCompletionStart = rendered.indexOf('### Non-completion');

				assert.ok(onCompletionStart >= 0 && onCompletionStart < completionStart, `${stage}: labels must be under On Completion`);
				assert.ok(completionStart >= 0, `${stage}: missing the Completion label`);
				assert.ok(nonCompletionStart > completionStart, `${stage}: missing the Non-completion label`);

				const completion = rendered.slice(completionStart, nonCompletionStart);
				const nonCompletion = rendered.slice(nonCompletionStart);
				assert.ok(!completion.includes(`stage:${stage} result:blocked`), `${stage}: completion must not use result:blocked`);
				assert.ok(nonCompletion.toLowerCase().includes('append exactly one'), `${stage}: non-completion must require one receipt`);
				assert.ok(
					nonCompletion.includes('concise, actionable explanation'),
					`${stage}: non-completion must require an actionable explanation`,
				);
				assert.ok(nonCompletion.includes('note'), `${stage}: non-completion must explain the blocker in note`);

				const completionReceipts = parseReceipts(completion);
				const nonCompletionReceipts = parseReceipts(nonCompletion);
				assert.deepStrictEqual(
					completionReceipts.map((receipt) => `${receipt.runId}:${receipt.taskId}:${receipt.stage}:${receipt.result}`),
					expectedResults[stage].completion.map((result) => `r7:TASK-142:${stage}:${result}`),
					`${stage}: completion receipt examples must be stage-specific`,
				);
				assert.deepStrictEqual(
					nonCompletionReceipts.map((receipt) => `${receipt.runId}:${receipt.taskId}:${receipt.stage}:${receipt.result}`),
					[`r7:TASK-142:${stage}:blocked`],
					`${stage}: non-completion must contain one blocked receipt`,
				);

				for (const result of expectedResults[stage].completion) {
					assert.ok(
						completion.includes(`run:r7 task:TASK-142 stage:${stage} result:${result}`),
						`${stage}: completion path must document result:${result}`,
					);
				}
				for (const result of expectedResults[stage].nonCompletion) {
					assert.ok(
						nonCompletion.includes(`run:r7 task:TASK-142 stage:${stage} result:${result}`),
						`${stage}: non-completion path must document result:${result}`,
					);
				}
			}
		} finally {
			await dispose();
		}
	});

	test('the built-in refine template records an advisory split recommendation without starting split or implementation work', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const template = await loadPromptTemplate(folder, 'refine');

			assert.ok(template.includes('Under `## Refined`, record an unambiguous split recommendation'));
			assert.ok(template.includes('Split recommendation: YES'));
			assert.ok(template.includes('Split recommendation: NO'));
			assert.ok(/whether this task should be split into smaller\s+independent tasks/.test(template));
			assert.ok(/proposed\s+independent task boundaries/.test(template));
			assert.ok(/why one task is\s+sufficient/.test(template));
			assert.ok(template.includes('This recommendation is advisory only'));
			assert.ok(/do not create child task\s+files/.test(template));
			assert.ok(template.includes('add `propose-task` lines'));
			assert.ok(template.includes('invoke the separate `split` action'));
			assert.ok(template.includes('Do not write or edit any code. This stage is scoping only.'));
		} finally {
			await dispose();
		}
	});

	test('the develop template inlines Refined and Scope rather than referencing them (§6.8)', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const template = await loadPromptTemplate(folder, 'develop');
			const rendered = renderTemplate(
				template,
				baseVars({
					agentName: STAGE_AGENT_NAME.develop,
					refined: 'A signed webhook endpoint for Stripe billing events.',
					scope: '- [ ] src/routes/webhooks/stripe.ts',
				}),
			);

			assert.ok(rendered.includes('A signed webhook endpoint for Stripe billing events.'));
			assert.ok(rendered.includes('- [ ] src/routes/webhooks/stripe.ts'));
		} finally {
			await dispose();
		}
	});

	test('the validate template explains pass, fail, and blocked receipt lines', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const template = await loadPromptTemplate(folder, 'validate');
			assert.ok(template.includes('stage:validate result:ok'));
			assert.ok(template.includes('stage:validate result:failed'));
			assert.ok(template.includes('stage:validate result:blocked'));
			assert.ok(template.includes('cannot determine pass or fail'));
			assert.ok(template.includes('This is a verdict, not a run error'));
		} finally {
			await dispose();
		}
	});

	test('develop and validate templates use the active task file and order proposals before receipts', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			for (const stage of ['develop', 'validate'] as const) {
				const template = await loadPromptTemplate(folder, stage);
				const proposalIndex = template.indexOf('propose-task run:{{runId}}');
				const receiptIndex = template.indexOf(`stage:${stage} result:`);

				assert.ok(proposalIndex >= 0 && proposalIndex < receiptIndex, `${stage}: proposals must be written before the receipt`);
				assert.ok(template.includes('{{taskFilePath}}'), `${stage}: must target the active task file`);
				assert.ok(!template.includes('.kanban-pilot/tasks/{{id}}.md'), `${stage}: must not hard-code the Default task folder`);
			}
		} finally {
			await dispose();
		}
	});

	test('the split template orders proposals before the receipt and names the active task file', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const template = await loadPromptTemplate(folder, 'split');
			const proposalIndex = template.indexOf('propose-task run:{{runId}}');
			const receiptIndex = template.indexOf('stage:split result:ok');

			assert.ok(proposalIndex >= 0 && proposalIndex < receiptIndex, 'split proposals must be written before the receipt');
			assert.ok(template.includes('attached active task file'));
			assert.ok(template.includes('named task set'));
			assert.ok(template.includes('hard-coded `.kanban-pilot/tasks`'));
			assert.ok(!template.includes('.kanban-pilot/tasks/{{id}}.md'));
		} finally {
			await dispose();
		}
	});

	test('a template is seeded once and never overwritten on later loads', async () => {
		const { folder, dispose } = await tempFolder();
		const file = vscode.Uri.joinPath(folder.uri, '.kanban-pilot', 'prompts', 'refine.md');

		try {
			await loadPromptTemplate(folder, 'refine'); // seeds the default

			const edited = 'a user-customized template\n';
			await vscode.workspace.fs.writeFile(file, Buffer.from(edited, 'utf8'));

			const second = await loadPromptTemplate(folder, 'refine');
			assert.strictEqual(second, edited, 'loading again must not clobber a user edit');
		} finally {
			await dispose();
		}
	});

	test('preserves an older user-owned template without silently migrating it', async () => {
		const { folder, dispose } = await tempFolder();
		const file = vscode.Uri.joinPath(folder.uri, '.kanban-pilot', 'prompts', 'refine.md');
		const legacy = [
			'# User-owned legacy refine prompt',
			'',
			'## On Completion',
			'The extension owns that block and moves the card on its own once it sees your `## Log` line.',
			'',
		].join('\n');

		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.kanban-pilot', 'prompts'));
			await vscode.workspace.fs.writeFile(file, Buffer.from(legacy, 'utf8'));

			const loaded = await loadPromptTemplate(folder, 'refine');
			assert.strictEqual(loaded, legacy, 'existing user-owned templates must remain byte-for-byte unchanged');
			assert.ok(!loaded.includes('kanban-pilot: extension-supervised'), 'legacy copies must not be silently rewritten');
		} finally {
			await dispose();
		}
	});
});
