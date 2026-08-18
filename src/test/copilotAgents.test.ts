import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
	discoverCopilotAgents,
	parseCopilotAgent,
	resolveCopilotAgentLocations,
} from '../chat/copilotAgents';

async function writeFile(uri: vscode.Uri, content: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
}

async function makeDirectory(name: string): Promise<vscode.Uri> {
	const directory = vscode.Uri.file(path.join(os.tmpdir(), `kanban-pilot-agents-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`));
	await vscode.workspace.fs.createDirectory(directory);
	return directory;
}

suite('Copilot custom-agent discovery', () => {
	test('parses names, descriptions, filename fallbacks, and visibility metadata', () => {
		assert.deepStrictEqual(
			parseCopilotAgent(
				'---\nname: Workspace Reviewer\ndescription: Reviews workspace changes\ntarget: vscode\n---\n',
				'reviewer.agent.md',
				'workspace',
			),
			{ name: 'Workspace Reviewer', description: 'Reviews workspace changes', source: 'workspace' },
		);
		assert.deepStrictEqual(
			parseCopilotAgent('---\ndescription: Uses the filename\n---\n', 'fallback.agent.md'),
			{ name: 'fallback', description: 'Uses the filename', source: 'workspace' },
		);
		assert.deepStrictEqual(
			parseCopilotAgent(
				'---\nname: Handoff Agent\nhandoffs:\n  - label: Review\n    agent: reviewer\n    send: false\n---\n',
				'handoff.agent.md',
			),
			{ name: 'Handoff Agent', source: 'workspace' },
		);
		assert.strictEqual(
			parseCopilotAgent('---\nuser-invocable: false\n---\n', 'hidden.agent.md'),
			undefined,
		);
		assert.strictEqual(
			parseCopilotAgent('---\ninfer: FALSE\n---\n', 'subagent.agent.md'),
			undefined,
		);
		assert.strictEqual(
			parseCopilotAgent('---\ntarget: claude\n---\n', 'other.agent.md'),
			undefined,
		);
		assert.strictEqual(parseCopilotAgent('---\nname: broken\n', 'broken.agent.md'), undefined);
	});

	test('merges local, configured, and user profiles with local precedence and stable order', async () => {
		const root = await makeDirectory('workspace');
		const local = vscode.Uri.joinPath(root, '.github', 'agents');
		const configured = await makeDirectory('configured');
		const user = await makeDirectory('user');
		try {
			await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, '.github'));
			await vscode.workspace.fs.createDirectory(local);
			await writeFile(
				vscode.Uri.joinPath(local, 'review.agent.md'),
				'---\nname: Review\ndescription: Workspace copy\n---\n',
			);
			await writeFile(vscode.Uri.joinPath(local, 'fallback.agent.md'), '---\n---\n');
			await writeFile(vscode.Uri.joinPath(local, 'hidden.agent.md'), '---\nuser-invocable: false\n---\n');
			await writeFile(vscode.Uri.joinPath(local, 'notes.txt'), 'not an agent');

			await writeFile(
				vscode.Uri.joinPath(configured, 'review.agent.md'),
				'---\nname: Review\ndescription: Configured copy\n---\n',
			);
			await writeFile(vscode.Uri.joinPath(configured, 'configured.agent.md'), '---\nname: Configured\n---\n');
			await writeFile(vscode.Uri.joinPath(user, 'review.agent.md'), '---\nname: Review\ndescription: User copy\n---\n');
			await writeFile(vscode.Uri.joinPath(user, 'user.agent.md'), '---\nname: User\n---\n');

			const agents = await discoverCopilotAgents({
				workspaceFolders: [root],
				additionalLocations: { [configured.fsPath]: true },
				userAgentsDirectory: user,
			});
			assert.deepStrictEqual(agents.map((agent) => agent.name), ['Configured', 'fallback', 'Review', 'User']);
			assert.strictEqual(agents.find((agent) => agent.name === 'Review')?.description, 'Workspace copy');
			assert.strictEqual(agents.find((agent) => agent.name === 'Review')?.source, 'workspace');
		} finally {
			await vscode.workspace.fs.delete(root, { recursive: true });
			await vscode.workspace.fs.delete(configured, { recursive: true });
			await vscode.workspace.fs.delete(user, { recursive: true });
		}
	});

	test('ignores missing directories and resolves configured paths for each workspace', async () => {
		const first = vscode.Uri.file(path.join(os.tmpdir(), 'kanban-pilot-no-agents-first'));
		const second = vscode.Uri.file(path.join(os.tmpdir(), 'kanban-pilot-no-agents-second'));
		const locations = resolveCopilotAgentLocations({
			workspaceFolders: [first, second],
			additionalLocations: { '~/.shared-agents': true, 'relative-agents': true },
			userHome: 'C:\\Users\\tester',
			userAgentsDirectory: vscode.Uri.file(path.join(os.tmpdir(), 'kanban-pilot-no-agents-user')),
		});
		assert.strictEqual(locations.filter((location) => location.source === 'workspace').length, 2);
		assert.strictEqual(locations.filter((location) => location.source === 'configured').length, 3);
		assert.deepStrictEqual(await discoverCopilotAgents({
			workspaceFolders: [first],
			additionalLocations: { [path.join(os.tmpdir(), 'kanban-pilot-no-agents-configured')]: true },
			userAgentsDirectory: vscode.Uri.file(path.join(os.tmpdir(), 'kanban-pilot-no-agents-user')),
		}), []);
		assert.deepStrictEqual(await discoverCopilotAgents({
			workspaceFolders: [],
			userAgentsDirectory: vscode.Uri.file(path.join(os.tmpdir(), 'kanban-pilot-no-agents-user')),
		}), []);
	});
});
