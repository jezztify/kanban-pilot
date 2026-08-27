import * as assert from 'assert';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { BoardTaskSetHost } from '../board/boardPanel';
import { BoardSnapshot } from '../model/taskStore';
import { startRealtimeBoardServer } from '../http/realtimeBoardServer';

interface Reply { status: number; body: string }

/** Compiled tests live in dist/test, so the extension root is two levels up. */
const extensionUri = vscode.Uri.file(path.resolve(__dirname, '..', '..'));

function request(port: number, path: string, token?: string): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const request_ = http.request({
			host: '127.0.0.1',
			port,
			path,
			headers: token ? { authorization: `Bearer ${token}` } : {},
		}, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => { body += chunk; });
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request_.on('error', reject);
		request_.end();
	});
}

function post(port: number, path: string, token: string, payload: unknown): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const request_ = http.request({
			host: '127.0.0.1', port, path, method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		}, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk) => { body += chunk; });
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request_.on('error', reject);
		request_.end(JSON.stringify(payload));
	});
}

/** Reads an event stream until `predicate` matches, then aborts the request. */
function stream(port: number, path: string, predicate: (chunk: string) => boolean, timeoutMs = 5000): Promise<string> {
	return new Promise((resolve, reject) => {
		let buffer = '';
		const request_ = http.get({ host: '127.0.0.1', port, path }, (response) => {
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => {
				buffer += chunk;
				if (predicate(buffer)) {
					request_.destroy();
					resolve(buffer);
				}
			});
		});
		request_.on('error', (error) => {
			// destroy() after a match surfaces here; the match already resolved.
			if (!predicate(buffer)) { reject(error); }
		});
		const timer = setTimeout(() => {
			request_.destroy();
			reject(new Error(`Event stream did not match within ${timeoutMs}ms. Received: ${buffer}`));
		}, timeoutMs);
		timer.unref?.();
	});
}

function fakeHost(snapshot: BoardSnapshot, sink: { actions: string[] }): BoardTaskSetHost {
	// The endpoint only needs the host contract's transport-facing surface;
	// the board's own reads are allowed to reject and are caught internally.
	return {
		ready: Promise.resolve(),
		revision: 9,
		activeSet: { id: 'default', name: 'Default', isDefault: true, directory: extensionUri },
		store: {
			directory: extensionUri,
			revision: snapshot.revision,
			watch: () => new vscode.Disposable(() => undefined),
			snapshot: async () => snapshot,
			create: async () => ({}),
			delete: async () => undefined,
			readAll: async () => ({ tasks: [], malformed: [] }),
			listAttachments: async () => [],
		},
		runManager: {
			handleAction: async (taskId: string, action: string) => { sink.actions.push(`${taskId}:${action}`); },
			applyPendingOutcome: async () => ({ kind: 'applied' }),
			moveTask: async () => ({ kind: 'applied' }),
			reorderTask: async () => ({ kind: 'applied' }),
			listStaleCompletionCandidates: async () => [],
			applyGatePolicies: async () => undefined,
			dockTaskChat: () => undefined,
		},
		listTaskSets: async () => [],
		switchTaskSet: async () => undefined,
		createTaskSet: async () => undefined,
		renameTaskSet: async () => undefined,
		deleteTaskSet: async () => undefined,
		onDidChange: () => new vscode.Disposable(() => undefined),
	} as unknown as BoardTaskSetHost;
}

function observableHost(snapshot: BoardSnapshot, sink: { actions: string[] }): {
	host: BoardTaskSetHost;
	emit(change: { revision: number; kind: string; taskId?: string; note?: string }): void;
	subscriptionDisposals(): number;
} {
	let listener: ((change?: { revision: number; kind: string; taskId?: string; note?: string }) => void) | undefined;
	let subscriptionDisposals = 0;
	const host = fakeHost(snapshot, sink);
	return {
		host: {
			...host,
			onDidChange: (next) => {
				listener = next;
				return new vscode.Disposable(() => {
					subscriptionDisposals += 1;
					listener = undefined;
				});
			},
		},
		emit: (change) => listener?.(change),
		subscriptionDisposals: () => subscriptionDisposals,
	};
}

suite('Realtime board HTTP endpoint integration', () => {
	const snapshot: BoardSnapshot = { revision: 4, malformed: [], columns: [] };

	test('routes REST actions through the existing manager and rejects anonymous callers', async () => {
		const sink = { actions: [] as string[] };
		const server = await startRealtimeBoardServer({
			port: 0,
			token: 'test-token',
			extensionUri,
			host: fakeHost(snapshot, sink),
		});
		try {
			assert.strictEqual((await request(server.port, '/api/board')).status, 401);
			assert.strictEqual((await request(server.port, '/api/board?token=test-token')).status, 200);

			const board = await request(server.port, '/api/board', 'test-token');
			assert.strictEqual(board.status, 200);
			assert.strictEqual(JSON.parse(board.body).revision, 9);

			const action = await post(server.port, '/api/tasks/TASK-001/actions', 'test-token', { action: 'develop' });
			assert.strictEqual(action.status, 202);
			assert.deepStrictEqual(sink.actions, ['TASK-001:develop']);
		} finally {
			server.dispose();
		}
	});

	test('serves the extension board webview rather than a second board', async () => {
		const server = await startRealtimeBoardServer({
			port: 0,
			token: 'test-token',
			extensionUri,
			host: fakeHost(snapshot, { actions: [] }),
		});
		try {
			const page = await request(server.port, '/?token=test-token');
			assert.strictEqual(page.status, 200, page.body);
			// Markers that only the real board document carries.
			assert.match(page.body, /data-kanban-pilot-board/);
			assert.match(page.body, /id="settingsModal"/);
			assert.match(page.body, /id="detailBackdrop"/);
			// The browser bridge stands in for the VS Code API, and the theme
			// tokens stand in for the ones the editor injects.
			assert.match(page.body, /data-kanban-pilot-bridge/);
			assert.match(page.body, /data-kanban-pilot-theme/);
			assert.ok(
				page.body.indexOf('data-kanban-pilot-theme') < page.body.indexOf('data-kanban-pilot-board'),
				'theme tokens are defined before the board styles that read them',
			);
			assert.match(page.body, /--vscode-editorWidget-background: #/);
			assert.match(page.body, /window\.acquireVsCodeApi = function/);
			assert.match(page.body, /connect-src 'self'/);
			// Bundled assets are rewritten to endpoint-served paths.
			assert.match(page.body, /src="\/resource\/0\/dist\/mermaid-runtime\.js"/);
			assert.strictEqual(server.sessionCount, 1);
		} finally {
			server.dispose();
		}
	});

	test('delivers host messages to the session that asked for them', async () => {
		const server = await startRealtimeBoardServer({
			port: 0,
			token: 'test-token',
			extensionUri,
			host: fakeHost(snapshot, { actions: [] }),
		});
		try {
			const page = await request(server.port, '/?token=test-token');
			const session = /var session = "([^"]+)"/.exec(page.body)?.[1];
			assert.ok(session, 'the served board carries its session id');

			const events = await stream(
				server.port,
				`/session/events?session=${session}&token=test-token`,
				(buffer) => buffer.includes('board/connection') || buffer.includes('board/state'),
			);
			// The board's own protocol, not a bespoke remote one.
			assert.match(events, /^data: \{/m);

			const accepted = await post(
				server.port,
				`/session/messages?session=${session}`,
				'test-token',
				{ type: 'task/select', taskId: 'TASK-001' },
			);
			assert.strictEqual(accepted.status, 202);

			const expired = await post(server.port, '/session/messages?session=nope', 'test-token', { type: 'board/ready' });
			assert.strictEqual(expired.status, 404);
		} finally {
			server.dispose();
		}
	});

	test('refuses resource requests that escape their root or arrive unauthenticated', async () => {
		const server = await startRealtimeBoardServer({
			port: 0,
			token: 'test-token',
			extensionUri,
			host: fakeHost(snapshot, { actions: [] }),
		});
		try {
			assert.strictEqual((await request(server.port, '/resource/0/package.json')).status, 401);
			const escape = await request(server.port, '/resource/0/..%2F..%2Fetc%2Fpasswd', 'test-token');
			assert.strictEqual(escape.status, 403);
			const missingRoot = await request(server.port, '/resource/7/package.json', 'test-token');
			assert.strictEqual(missingRoot.status, 404);
			assert.strictEqual((await request(server.port, '/resource/0/package.json', 'test-token')).status, 200);
		} finally {
			server.dispose();
		}
	});

	test('subscribes API clients with an initial board then typed revisioned host changes', async () => {
		const observable = observableHost(snapshot, { actions: [] });
		const server = await startRealtimeBoardServer({
			port: 0,
			token: 'test-token',
			extensionUri,
			host: observable.host,
		});
		try {
			const eventsPromise = stream(
				server.port,
				'/api/events?token=test-token',
				(value) => value.includes('"kind":"task"'),
			);
			setTimeout(() => {
				observable.emit({ revision: 10, kind: 'task', taskId: 'TASK-001', note: 'updated' });
			}, 50);
			const events = await eventsPromise;
			assert.match(events, /event: board\ndata: \{"type":"board","board":\{"revision":9/);
			assert.match(events, /"change":\{"revision":10,"kind":"task","taskId":"TASK-001","note":"updated"\}/);
			assert.match(events, /"board":\{"revision":10/);
		} finally {
			server.dispose();
			assert.strictEqual(observable.subscriptionDisposals(), 1);
		}
	});
});
