import * as assert from 'assert';
import { registryConfig, WorkspaceRegistryClient } from '../http/workspaceRegistry';

suite('Workspace registry client', () => {
	test('validates explicit registry enrollment settings', () => {
		assert.strictEqual(registryConfig({}), undefined);
		assert.throws(() => registryConfig({ baseUrl: 'https://registry.test' }), /credential/);
		assert.throws(() => registryConfig({ baseUrl: 'ftp://registry.test', credential: 'secret' }), /HTTP/);
		assert.deepStrictEqual(registryConfig({ baseUrl: 'https://registry.test/', credential: 'secret', workspaceName: ' Pilot ' }), {
			baseUrl: 'https://registry.test', credential: 'secret', workspaceName: 'Pilot',
		});
	});

	test('registers sanitized board metadata and makes transient failures non-fatal', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const client = new WorkspaceRegistryClient('workspace-1', async (url, init) => {
			calls.push({ url: String(url), init });
			return new Response(null, { status: 204 });
		});
		const config = { ...registryConfig({ baseUrl: 'https://registry.test/', credential: 'secret', workspaceName: 'Pilot' })!, includeConnectionUrl: true };
		assert.strictEqual(await client.sync(config, 'https://board.test/?token=board-secret#x', 'Kanban Pilot workspace', {
			directoryPath: 'C:\\Repositories\\kanban-pilot',
			activeWorkspace: 'Default',
		}), undefined);
		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0].url, 'https://registry.test/api/workspaces');
		assert.deepStrictEqual(JSON.parse(String(calls[0].init?.body)), {
			id: 'workspace-1',
			name: 'Pilot',
			boardUrl: 'https://board.test',
			connectionUrl: 'https://board.test/?token=board-secret#x',
			directoryPath: 'C:\\Repositories\\kanban-pilot',
			activeWorkspace: 'Default',
		});
		assert.strictEqual((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer secret');

		calls.length = 0;
		const hostedConfig = registryConfig({ baseUrl: 'https://registry.test/', credential: 'secret', workspaceName: 'Pilot' })!;
		assert.strictEqual(await client.sync(hostedConfig, 'https://board.test/', 'Kanban Pilot workspace', {
			directoryPath: 'C:\\Repositories\\kanban-pilot',
			activeWorkspace: 'Default',
		}), undefined);
		assert.deepStrictEqual(JSON.parse(String(calls[0].init?.body)), {
			id: 'workspace-1', name: 'Pilot', boardUrl: 'https://board.test',
		});

		const unavailable = new WorkspaceRegistryClient('workspace-1', async () => { throw new Error('offline'); });
		assert.match(String(await unavailable.sync(config, 'https://board.test/')), /offline/);
	});

	test('best-effort deregistration requests the stable workspace id', async () => {
		const calls: string[] = [];
		const client = new WorkspaceRegistryClient('workspace-a', async (url) => { calls.push(String(url)); return new Response(null, { status: 204 }); });
		const config = registryConfig({ baseUrl: 'https://registry.test', credential: 'secret' })!;
		assert.strictEqual(await client.remove(config), undefined);
		assert.deepStrictEqual(calls, ['https://registry.test/api/workspaces/workspace-a']);
	});
});
