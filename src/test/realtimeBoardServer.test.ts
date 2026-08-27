import * as assert from 'assert';
import * as path from 'node:path';
import { ServerResponse } from 'node:http';
import * as vscode from 'vscode';
import { BrowserBoardSurface, containsPath } from '../http/browserBoardSurface';
import { endpointConnectionUrl, endpointUrl, httpEndpointConfig, isNonLoopbackBindAddress, resolveShareHost } from '../http/realtimeBoardServer';

/** Minimal stand-in for the SSE response a session writes into. */
function fakeStream(): ServerResponse & { chunks: string[] } {
	const chunks: string[] = [];
	return {
		chunks,
		writableEnded: false,
		write: (chunk: string) => { chunks.push(chunk); return true; },
		end: () => undefined,
	} as unknown as ServerResponse & { chunks: string[] };
}

function messages(stream: { chunks: string[] }): unknown[] {
	return stream.chunks
		.filter((chunk) => chunk.startsWith('data: '))
		.map((chunk) => JSON.parse(chunk.slice('data: '.length).trim()));
}

suite('Realtime board HTTP endpoint', () => {
	test('requires an enabled endpoint, access token, and valid port', () => {
		assert.strictEqual(httpEndpointConfig({}), undefined);
		assert.strictEqual(httpEndpointConfig({ enabled: false, token: 'token', port: 4173 }), undefined);
		assert.throws(() => httpEndpointConfig({ enabled: true, port: 4173 }), /access token/);
		assert.throws(
			() => httpEndpointConfig({ enabled: true, token: 'token', port: 0 }),
			/HTTP port/,
		);
	});

	test('uses loopback by default and permits an explicit reverse-proxy bind address', () => {
		assert.deepStrictEqual(
			httpEndpointConfig({ enabled: true, token: 'token', port: 4173 }),
			{ token: 'token', port: 4173, bindAddress: '127.0.0.1' },
		);
		assert.deepStrictEqual(
			httpEndpointConfig({
				enabled: true,
				token: 'token',
				port: 4173,
				host: '0.0.0.0',
			}),
			{ token: 'token', port: 4173, bindAddress: '0.0.0.0' },
		);
	});

	test('prefers an explicitly configured public URL for QR sharing', () => {
		const local = httpEndpointConfig({ enabled: true, token: 'token', port: 4173 });
		assert.ok(local);
		assert.strictEqual(endpointUrl(local), 'http://127.0.0.1:4173');

		const publicEndpoint = httpEndpointConfig({
			enabled: true,
			token: 'token',
			port: 4173,
			publicUrl: 'https://pilot.example.test/',
		});
		assert.ok(publicEndpoint);
		assert.strictEqual(endpointUrl(publicEndpoint), 'https://pilot.example.test');
		assert.strictEqual(endpointConnectionUrl(publicEndpoint), 'https://pilot.example.test/?token=token');
	});

	test('derives a LAN IPv4 for a wildcard bind so peers can reach the share URL', () => {
		const lookup = (() => ({
			lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
			eth0: [
				{ family: 'IPv6', address: 'fe80::1', internal: false },
				{ family: 'IPv4', address: '192.168.1.42', internal: false },
			],
		})) as unknown as typeof import('node:os').networkInterfaces;
		assert.strictEqual(resolveShareHost('0.0.0.0', lookup), '192.168.1.42');
		assert.strictEqual(resolveShareHost('::', lookup), '192.168.1.42');
		const config = { port: 4173, bindAddress: '0.0.0.0', token: 'token' } as const;
		assert.strictEqual(endpointUrl(config, 4173, lookup), 'http://192.168.1.42:4173');
		assert.strictEqual(endpointConnectionUrl(config, 4173, lookup), 'http://192.168.1.42:4173/?token=token');
	});

	test('falls back to localhost when a wildcard bind has no reachable IPv4', () => {
		const lookup = (() => ({
			lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
		})) as unknown as typeof import('node:os').networkInterfaces;
		assert.strictEqual(resolveShareHost('0.0.0.0', lookup), 'localhost');
		assert.strictEqual(endpointUrl({ port: 4173, bindAddress: '0.0.0.0' }, 4173, lookup), 'http://localhost:4173');
	});

	test('renders an explicit host verbatim and brackets IPv6 literals', () => {
		const lookup = (() => ({})) as unknown as typeof import('node:os').networkInterfaces;
		assert.strictEqual(resolveShareHost('10.0.0.5', lookup), '10.0.0.5');
		assert.strictEqual(endpointUrl({ port: 4173, bindAddress: '10.0.0.5' }, 4173, lookup), 'http://10.0.0.5:4173');
		assert.strictEqual(endpointUrl({ port: 4173, bindAddress: 'fe80::abcd' }, 4173, lookup), 'http://[fe80::abcd]:4173');
	});

	test('lets a configured public URL override a wildcard bind', () => {
		const lookup = (() => ({
			eth0: [{ family: 'IPv4', address: '192.168.1.42', internal: false }],
		})) as unknown as typeof import('node:os').networkInterfaces;
		const config = { port: 4173, bindAddress: '0.0.0.0', publicUrl: 'https://pilot.example.test' };
		assert.strictEqual(endpointUrl(config, 4173, lookup), 'https://pilot.example.test');
	});

	test('flags non-loopback bind addresses for the security warning', () => {
		assert.strictEqual(isNonLoopbackBindAddress('127.0.0.1'), false);
		assert.strictEqual(isNonLoopbackBindAddress('::1'), false);
		assert.strictEqual(isNonLoopbackBindAddress('localhost'), false);
		assert.strictEqual(isNonLoopbackBindAddress('0.0.0.0'), true);
		assert.strictEqual(isNonLoopbackBindAddress('192.168.1.42'), true);
	});
});

suite('Browser board surface', () => {
	const root = vscode.Uri.file(path.resolve('/tmp/extension-root'));
	const tasks = vscode.Uri.file(path.resolve('/tmp/workspace/.kanban-pilot'));

	function surface(): BrowserBoardSurface {
		const created = new BrowserBoardSurface('session-1');
		created.setLocalResourceRoots([root, tasks]);
		return created;
	}

	test('declares its own transport in the policy the board document carries', () => {
		const policy = surface().contentSecurityPolicy('abc123');
		// The bridge needs fetch and EventSource; the editor's policy allows neither.
		assert.match(policy, /connect-src 'self'/);
		assert.match(policy, /script-src 'nonce-abc123' 'self'/);
		assert.match(policy, /default-src 'none'/);
	});

	test('installs the VS Code API bridge the board expects to already exist', () => {
		const markup = surface().bootstrapMarkup('abc123');
		assert.match(markup, /<script nonce="abc123" data-kanban-pilot-bridge>/);
		assert.match(markup, /window\.acquireVsCodeApi = function/);
		assert.match(markup, /var session = "session-1"/);
		assert.match(markup, /new EventSource\(endpoint\('\/session\/events'\)\)/);
		assert.doesNotMatch(markup, /\/api\/board/);
	});

	test('supplies the theme tokens VS Code injects, in both colour schemes', () => {
		const markup = surface().bootstrapMarkup('abc123');
		assert.match(markup, /<style nonce="abc123" data-kanban-pilot-theme>/);
		// The board reads these without literal fallbacks; an undefined one
		// invalidates the whole declaration and renders the modal transparent.
		for (const token of [
			'--vscode-foreground',
			'--vscode-descriptionForeground',
			'--vscode-editor-background',
			'--vscode-sideBar-background',
			'--vscode-editorWidget-background',
			'--vscode-panel-border',
			'--vscode-input-background',
			'--vscode-focusBorder',
			'--vscode-errorForeground',
			'--vscode-textLink-foreground',
			'--vscode-font-family',
			'--vscode-font-size',
			'--vscode-editor-font-family',
		]) {
			assert.ok(markup.includes(`${token}:`), `${token} is defined for browser clients`);
		}
		assert.match(markup, /@media \(prefers-color-scheme: dark\)/);
		// The theme layer must precede the board's own styles and script.
		assert.ok(markup.indexOf('data-kanban-pilot-theme') < markup.indexOf('data-kanban-pilot-bridge'));
	});

	test('maps bundled resources onto root-relative endpoint paths', () => {
		const board = surface();
		assert.strictEqual(
			board.resourceUri(vscode.Uri.joinPath(root, 'dist', 'mermaid-runtime.js')),
			'/resource/0/dist/mermaid-runtime.js',
		);
		assert.strictEqual(
			board.resourceUri(vscode.Uri.joinPath(tasks, 'TASK-001.attachments', 'shot.png')),
			'/resource/1/TASK-001.attachments/shot.png',
		);
		// Nothing outside a declared root is addressable, as in the editor.
		assert.strictEqual(board.resourceUri(vscode.Uri.file(path.resolve('/tmp/elsewhere/secret.env'))), '');
	});

	test('holds the first board push until the client stream arrives', () => {
		const board = surface();
		void board.postMessage({ type: 'board/connection', state: 'syncing' });
		void board.postMessage({ type: 'board/state', revision: 2 });

		const stream = fakeStream();
		board.attach(stream);
		assert.deepStrictEqual(messages(stream), [
			{ type: 'board/connection', state: 'syncing' },
			{ type: 'board/state', revision: 2 },
		]);

		// Once attached, messages go straight out and are not replayed again.
		void board.postMessage({ type: 'task/detail' });
		assert.strictEqual(messages(stream).length, 3);
	});

	test('asks for a full projection whenever a stream reattaches', () => {
		const board = surface();
		let refreshes = 0;
		board.onDidBecomeVisible(() => { refreshes += 1; });
		board.attach(fakeStream());
		board.attach(fakeStream());
		assert.strictEqual(refreshes, 2);
	});

	test('stops delivering and notifies its owner once disposed', () => {
		const board = surface();
		let disposed = 0;
		board.onDidDispose(() => { disposed += 1; });
		board.attach(fakeStream());
		board.dispose();
		board.dispose();
		assert.strictEqual(disposed, 1);
		assert.strictEqual(board.connected, false);
	});

	test('keeps resource resolution inside its root', () => {
		assert.strictEqual(containsPath(root.fsPath, path.resolve(root.fsPath, 'dist/x.js')), true);
		assert.strictEqual(containsPath(root.fsPath, root.fsPath), true);
		assert.strictEqual(containsPath(root.fsPath, path.resolve(root.fsPath, '../../etc/passwd')), false);
	});
});
