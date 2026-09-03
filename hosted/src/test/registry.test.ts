import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceRegistry, WorkspaceRegistry } from '../server';

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function registry(): Promise<WorkspaceRegistry> {
	const directory = await mkdtemp(join(tmpdir(), 'kanban-pilot-registry-'));
	temporaryDirectories.push(directory);
	return startWorkspaceRegistry({ port: 0, credential: 'registry-secret', dataFile: join(directory, 'workspaces.json'), ttlMs: 100 });
}

async function request(port: number, pathname: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${pathname}`, init);
}

function authenticated(method: string, body?: unknown): RequestInit {
	return {
		method,
		headers: { authorization: 'Bearer registry-secret', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('upserts sanitized registrations and exposes only safe live records', async () => {
	const service = await registry();
	try {
		const first = await request(service.port, '/api/workspaces', authenticated('PUT', {
			id: 'workspace-a', name: 'Workspace A', boardUrl: 'https://pilot.example.test/board?token=secret#fragment',
		}));
		assert.equal(first.status, 204);
		const second = await request(service.port, '/api/workspaces', authenticated('PUT', {
			id: 'workspace-a', name: 'Renamed workspace', boardUrl: 'https://pilot.example.test/board?token=replaced',
		}));
		assert.equal(second.status, 204);

		const listing = await (await request(service.port, '/api/workspaces')).json() as { workspaces: Array<{ id: string; name: string; boardUrl: string; available: boolean }> };
		assert.deepEqual(listing.workspaces, [{ id: 'workspace-a', name: 'Renamed workspace', boardUrl: 'https://pilot.example.test/board', available: true }]);
		assert.doesNotMatch(JSON.stringify(listing), /secret|replaced|token/i);
	} finally { service.dispose(); }
});

test('requires credentials and rejects invalid registrations without changing stored records', async () => {
	const service = await registry();
	try {
		assert.equal((await request(service.port, '/api/workspaces', { method: 'PUT' })).status, 401);
		const invalid = await request(service.port, '/api/workspaces', authenticated('PUT', {
			id: 'bad id', name: 'Invalid', boardUrl: 'ftp://pilot.example.test/',
		}));
		assert.equal(invalid.status, 400);
		const listing = await (await request(service.port, '/api/workspaces')).json() as { workspaces: unknown[] };
		assert.deepEqual(listing.workspaces, []);
	} finally { service.dispose(); }
});

test('removes records explicitly and hides expired records', async () => {
	const service = await registry();
	try {
		await request(service.port, '/api/workspaces', authenticated('PUT', { id: 'one', name: 'One', boardUrl: 'https://one.test/' }));
		assert.equal((await request(service.port, '/api/workspaces/one', authenticated('DELETE'))).status, 204);
		assert.deepEqual((await (await request(service.port, '/api/workspaces')).json() as { workspaces: unknown[] }).workspaces, []);
		await request(service.port, '/api/workspaces', authenticated('PUT', { id: 'two', name: 'Two', boardUrl: 'https://two.test/' }));
		await new Promise((resolve) => setTimeout(resolve, 125));
		assert.deepEqual((await (await request(service.port, '/api/workspaces')).json() as { workspaces: unknown[] }).workspaces, []);
	} finally { service.dispose(); }
});

test('serves a visitor landing page and health endpoint without board content', async () => {
	const service = await registry();
	try {
		const health = await request(service.port, '/health');
		assert.deepEqual(await health.json(), { ok: true, service: 'kanban-pilot-workspace-registry' });
		const page = await request(service.port, '/');
		const markup = await page.text();
		assert.equal(page.status, 200);
		assert.match(markup, /Kanban Pilot Registry/);
		assert.match(markup, /<main id="main-content"/);
		assert.match(markup, /Directory online/);
		assert.match(markup, /Your live workspaces/);
		assert.match(markup, /id="page-title"/);
		assert.match(markup, /Open a board/);
		assert.match(markup, /id="workspace-status"[^>]*role="status"/);
		assert.match(markup, /id="workspace-status"[^>]*tabindex="-1"/);
		assert.match(markup, /id="workspace-count"/);
		assert.match(markup, /id="workspace-list"/);
		assert.match(markup, /class="refresh-button"/);
		assert.match(markup, /class="workspace-skeleton"/);
		assert.match(markup, /className = "live-badge"/);
		assert.match(markup, /live\.textContent = "Live"/);
		assert.match(markup, /Open board/);
		assert.match(markup, /fetch\('\/api\/workspaces'\)/);
		assert.match(markup, /No live workspaces/);
		assert.match(markup, /Couldn’t load the Registry/);
		assert.match(markup, /lastWorkspaces/);
		assert.match(markup, /status\.focus\(\)/);
		assert.match(markup, /Directory online/);
		assert.match(markup, /Refresh/);
		assert.match(markup, /prefers-reduced-motion/);
		assert.match(markup, /@media \(max-width: 640px\)/);
		assert.match(markup, /link\.href = workspace\.boardUrl/);
		assert.match(markup, /textContent = workspace\.name/);
		assert.doesNotMatch(markup, /innerHTML/);
		assert.doesNotMatch(markup, /task data|board snapshot/i);
	} finally { service.dispose(); }
});
