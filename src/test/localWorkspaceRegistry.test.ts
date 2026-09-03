import * as assert from 'assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { connectSharedLocalWorkspaceRegistry, startLocalWorkspaceRegistry, LocalWorkspaceRegistry } from '../http/localWorkspaceRegistry';

suite('Automatic local workspace registry', () => {
	let service: LocalWorkspaceRegistry | undefined;

	teardown(() => {
		service?.dispose();
		service = undefined;
	});

	test('starts on a random loopback port and keeps board tokens out of listings', async () => {
		service = await startLocalWorkspaceRegistry({ credential: 'local-secret', port: 0, bindAddress: '127.0.0.1' });
		const baseUrl = `http://127.0.0.1:${service.port}`;
		const unauthorized = await fetch(`${baseUrl}/api/workspaces`, { headers: { authorization: 'Bearer wrong' } });
		assert.strictEqual(unauthorized.status, 200, 'workspace listings are public');

		const registration = await fetch(`${baseUrl}/api/workspaces`, {
			method: 'PUT',
			headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
			body: JSON.stringify({
				id: 'workspace-1',
				name: 'Pilot',
				boardUrl: 'http://127.0.0.1:4567/?token=board-secret#private',
				directoryPath: 'C:\\Repositories\\kanban-pilot',
				activeWorkspace: 'Default',
			}),
		});
		assert.strictEqual(registration.status, 204);
		const listing = await (await fetch(`${baseUrl}/api/workspaces`)).json() as { workspaces: Array<{ boardUrl: string }> };
		assert.deepStrictEqual(listing.workspaces, [{
			id: 'workspace-1', name: 'Pilot', boardUrl: 'http://127.0.0.1:4567',
			directoryPath: 'C:\\Repositories\\kanban-pilot', activeWorkspace: 'Default', available: true,
		}]);
		assert.doesNotMatch(JSON.stringify(listing), /board-secret/);
		const connection = await fetch(`${baseUrl}/api/workspaces/workspace-1/connection`, { redirect: 'manual' });
		assert.strictEqual(connection.status, 302);
		assert.strictEqual(connection.headers.get('location'), 'http://127.0.0.1:4567/?token=board-secret#private');
	});

	test('requires the generated registry credential for writes and removes records', async () => {
		service = await startLocalWorkspaceRegistry({ credential: 'local-secret', port: 0 });
		const baseUrl = `http://127.0.0.1:${service.port}`;
		const rejected = await fetch(`${baseUrl}/api/workspaces`, {
			method: 'PUT',
			headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'workspace-1', name: 'Pilot', boardUrl: 'http://board.test' }),
		});
		assert.strictEqual(rejected.status, 401);

		const registration = await fetch(`${baseUrl}/api/workspaces`, {
			method: 'PUT',
			headers: { authorization: 'Bearer local-secret', 'content-type': 'application/json' },
			body: JSON.stringify({ id: 'workspace-1', name: 'Pilot', boardUrl: 'http://board.test' }),
		});
		assert.strictEqual(registration.status, 204);
		const removal = await fetch(`${baseUrl}/api/workspaces/workspace-1`, {
			method: 'DELETE',
			headers: { authorization: 'Bearer local-secret' },
		});
		assert.strictEqual(removal.status, 204);
		assert.deepStrictEqual((await (await fetch(`${baseUrl}/api/workspaces`)).json() as { workspaces: unknown[] }).workspaces, []);
	});

	test('serves the redesigned utility-first workspace launcher', async () => {
		service = await startLocalWorkspaceRegistry({ credential: 'local-secret', port: 0 });
		const page = await fetch(`http://127.0.0.1:${service.port}/`);
		const markup = await page.text();

		assert.strictEqual(page.status, 200);
		assert.match(markup, /Kanban Pilot Registry/);
		assert.match(markup, /<main id="main-content"/);
		assert.match(markup, /Directory online/);
		assert.match(markup, /Your live workspaces/);
		assert.match(markup, /id="workspace-status"[^>]*role="status"/);
		assert.match(markup, /id="workspace-status"[^>]*tabindex="-1"/);
		assert.match(markup, /id="workspace-count"/);
		assert.match(markup, /id="workspace-list"/);
		assert.match(markup, /class="refresh-button"/);
		assert.match(markup, /class="workspace-skeleton"/);
		assert.match(markup, /className = "live-badge"/);
		assert.match(markup, /live\.textContent = "Live"/);
		assert.match(markup, /Open board/);
		assert.match(markup, /Directory path/);
		assert.match(markup, /Active workspace/);
		assert.match(markup, /workspace\.directoryPath/);
		assert.match(markup, /workspace\.activeWorkspace/);
		assert.match(markup, /lastWorkspaces/);
		assert.match(markup, /status\.focus\(\)/);
		assert.match(markup, /prefers-reduced-motion/);
		assert.match(markup, /@media \(max-width: 640px\)/);
		assert.match(markup, /encodeURIComponent\(workspace\.id\)/);
		assert.doesNotMatch(markup, /Choose a workspace/);
		assert.doesNotMatch(markup, /innerHTML/);
		assert.doesNotMatch(markup, /connectionUrl/);
		assert.doesNotMatch(markup, /board-secret/);
		assert.doesNotMatch(markup, /task data|board snapshot/i);
	});

	test('shares one registry process across concurrent VS Code extension hosts', async () => {
		const directory = await fsMkdtemp(path.join(os.tmpdir(), 'kanban-pilot-shared-registry-'));
		const registryScript = path.resolve(__dirname, '../../dist/registry.js');
		const options = { directory, registryScript, idleTtlMs: 100 };
		const [first, second] = await Promise.all([
			connectSharedLocalWorkspaceRegistry(options),
			connectSharedLocalWorkspaceRegistry(options),
		]);
		try {
			assert.strictEqual(first.baseUrl, second.baseUrl);
			assert.strictEqual(first.credential, second.credential);
			assert.notStrictEqual(first.clientId, second.clientId);

			for (const [id, handle] of [['workspace-a', first], ['workspace-b', second]] as const) {
				const response = await fetch(`${handle.baseUrl}/api/workspaces`, {
					method: 'PUT',
					headers: { authorization: `Bearer ${handle.credential}`, 'content-type': 'application/json' },
					body: JSON.stringify({ id, name: id, boardUrl: `http://127.0.0.1:4000/?token=${id}-secret` }),
				});
				assert.strictEqual(response.status, 204);
			}

			const listing = await (await fetch(`${first.baseUrl}/api/workspaces`)).json() as { workspaces: Array<{ id: string }> };
			assert.deepStrictEqual(listing.workspaces.map((workspace) => workspace.id), ['workspace-a', 'workspace-b']);
		} finally {
			first.dispose();
			second.dispose();
			await new Promise((resolve) => setTimeout(resolve, 250));
			await fsRm(directory);
		}
	});
});

async function fsMkdtemp(prefix: string): Promise<string> {
	const { mkdtemp } = await import('node:fs/promises');
	return mkdtemp(prefix);
}

async function fsRm(directory: string): Promise<void> {
	const { rm } = await import('node:fs/promises');
	await rm(directory, { recursive: true, force: true });
}
