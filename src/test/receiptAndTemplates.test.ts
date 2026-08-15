import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { findReceipt, formatReceipt, parseReceipts } from '../chat/receipt';
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

	test('formatReceipt round-trips through parseReceipts', () => {
		const line = formatReceipt({ runId: 'r8', taskId: 'TASK-142', stage: 'develop', result: 'blocked', note: 'needs a decision' });
		const [parsed] = parseReceipts(line);

		assert.deepStrictEqual(parsed, { runId: 'r8', taskId: 'TASK-142', stage: 'develop', result: 'blocked', note: 'needs a decision' });
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
				const completionStart = rendered.indexOf('### Completion');
				const nonCompletionStart = rendered.indexOf('### Non-completion');

				assert.ok(completionStart >= 0, `${stage}: missing the Completion label`);
				assert.ok(nonCompletionStart > completionStart, `${stage}: missing the Non-completion label`);

				const completion = rendered.slice(completionStart, nonCompletionStart);
				const nonCompletion = rendered.slice(nonCompletionStart);
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

	test('the validate template explains both pass and fail receipt lines', async () => {
		const { folder, dispose } = await tempFolder();
		try {
			const template = await loadPromptTemplate(folder, 'validate');
			assert.ok(template.includes('stage:validate result:ok'));
			assert.ok(template.includes('stage:validate result:failed'));
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
});
