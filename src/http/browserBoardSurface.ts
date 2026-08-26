import * as path from 'node:path';
import { ServerResponse } from 'node:http';
import * as vscode from 'vscode';
import { BoardSurface } from '../board/boardSurface';

/** Outbound messages held while a client is between event streams. */
const OUTBOX_LIMIT = 256;

/**
 * The board webview delivered to a browser over the HTTP endpoint.
 *
 * This is the same document the editor renders: the only substitutions are a
 * shim standing in for `acquireVsCodeApi` and resource URLs the endpoint can
 * serve. Nothing about the board's markup, styling, or message protocol is
 * re-implemented here, which is the point — a second implementation is what
 * drifts.
 */
export class BrowserBoardSurface implements BoardSurface {
	readonly hostEditor = false;

	private document = '';
	private stream: ServerResponse | undefined;
	private roots: vscode.Uri[] = [];
	private readonly outbox: Record<string, unknown>[] = [];
	private readonly messageListeners = new Set<(message: unknown) => void>();
	private readonly disposeListeners = new Set<() => void>();
	private readonly visibleListeners = new Set<() => void>();
	private disposed = false;

	constructor(private readonly sessionId: string) {}

	get html(): string {
		return this.document;
	}

	contentSecurityPolicy(nonce: string): string {
		return [
			"default-src 'none'",
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}' 'self'`,
			"img-src 'self' data:",
			// The shim's message channel: a POST per inbound message and one
			// EventSource carrying the outbound stream.
			"connect-src 'self'",
		].join('; ');
	}

	/**
	 * Everything the board document assumes the host already provided: the
	 * editor's theme tokens, then the VS Code API bridge.
	 */
	bootstrapMarkup(nonce: string): string {
		return [this.themeTokens(nonce), this.bridgeScript(nonce)].join('\n');
	}

	/**
	 * The theme layer VS Code injects into every webview, which a browser has
	 * nothing equivalent to. The board reads seventeen `--vscode-*` tokens,
	 * mostly without literal fallbacks, and an undefined `var()` invalidates the
	 * whole declaration rather than just that one value — an unstyled `.modal`
	 * loses its `background` outright and renders transparent. These track VS
	 * Code's Modern Light and Dark defaults and follow the viewer's own colour
	 * preference, so the browser board reads like the editor's rather than
	 * inventing a third palette.
	 */
	private themeTokens(nonce: string): string {
		const light = [
			'--vscode-foreground: #3b3b3b',
			'--vscode-descriptionForeground: #5f5f5f',
			'--vscode-editor-background: #ffffff',
			'--vscode-sideBar-background: #f8f8f8',
			'--vscode-editorWidget-background: #ffffff',
			'--vscode-panel-border: #e5e5e5',
			'--vscode-input-background: #ffffff',
			'--vscode-input-border: #cecece',
			'--vscode-focusBorder: #005fb8',
			'--vscode-errorForeground: #e51400',
			'--vscode-textLink-foreground: #005fb8',
			'--vscode-textCodeBlock-background: #f3f3f3',
			'--vscode-toolbar-hoverBackground: rgba(184, 184, 184, 0.31)',
			'--vscode-testing-iconPassed: #007100',
		];
		const dark = [
			'--vscode-foreground: #cccccc',
			'--vscode-descriptionForeground: #9d9d9d',
			'--vscode-editor-background: #1f1f1f',
			'--vscode-sideBar-background: #181818',
			'--vscode-editorWidget-background: #202020',
			'--vscode-panel-border: #2b2b2b',
			'--vscode-input-background: #313131',
			'--vscode-input-border: #3c3c3c',
			'--vscode-focusBorder: #0078d4',
			'--vscode-errorForeground: #f85149',
			'--vscode-textLink-foreground: #4daafc',
			'--vscode-textCodeBlock-background: #2b2b2b',
			'--vscode-toolbar-hoverBackground: rgba(90, 93, 94, 0.32)',
			'--vscode-testing-iconPassed: #73c991',
		];
		const shared = [
			'color-scheme: light dark',
			'--vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Ubuntu", "Droid Sans", system-ui, sans-serif',
			'--vscode-font-size: 13px',
			'--vscode-editor-font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
		];
		const block = (declarations: readonly string[], indent: string): string =>
			declarations.map((line) => `${indent}${line};`).join('\n');
		return [
			`<style nonce="${nonce}" data-kanban-pilot-theme>`,
			':root {',
			block([...shared, ...light], '  '),
			'}',
			'@media (prefers-color-scheme: dark) {',
			'  :root {',
			block(dark, '    '),
			'  }',
			'}',
			'</style>',
		].join('\n');
	}

	/**
	 * Bridges the board's one VS Code dependency. The board script calls
	 * `acquireVsCodeApi()` once and otherwise speaks plain `postMessage`, so
	 * defining that global ahead of it is enough to run the document unmodified.
	 */
	private bridgeScript(nonce: string): string {
		const session = JSON.stringify(this.sessionId);
		const lines = [
			`<script nonce="${nonce}" data-kanban-pilot-bridge>`,
			'(function () {',
			"  var token = new URLSearchParams(location.search).get('token') || '';",
			`  var session = ${session};`,
			'  var outbox = [];',
			'  var sending = false;',
			'  var state;',
			'',
			'  function endpoint(path) {',
			'    var url = new URL(path, location.origin);',
			"    url.searchParams.set('session', session);",
			"    if (token) { url.searchParams.set('token', token); }",
			'    return url.toString();',
			'  }',
			'',
			'  // Messages are posted one at a time and only dropped from the queue',
			'  // once accepted, so the host sees them in the order the board produced',
			'  // them and a dropped connection replays the tail instead of losing it.',
			'  function flush() {',
			'    if (sending || !outbox.length) { return; }',
			'    sending = true;',
			"    fetch(endpoint('/session/messages'), {",
			"      method: 'POST',",
			"      headers: { 'content-type': 'application/json' },",
			'      body: JSON.stringify(outbox[0]),',
			'    }).then(function (response) {',
			"      if (!response.ok) { throw new Error('Message was rejected.'); }",
			'      outbox.shift();',
			'      sending = false;',
			'      flush();',
			'    }).catch(function () {',
			'      sending = false;',
			'      setTimeout(flush, 1500);',
			'    });',
			'  }',
			'',
			'  window.acquireVsCodeApi = function () {',
			'    return {',
			'      postMessage: function (message) { outbox.push(message); flush(); },',
			'      getState: function () { return state; },',
			'      setState: function (value) { state = value; return value; },',
			'    };',
			'  };',
			'',
			"  var events = new EventSource(endpoint('/session/events'));",
			'  events.onmessage = function (event) {',
			'    var message;',
			'    try { message = JSON.parse(event.data); } catch (error) { return; }',
			'    window.postMessage(message, location.origin);',
			'  };',
			'})();',
			'</script>',
		];
		return lines.join('\n');
	}

	resourceUri(uri: vscode.Uri): string {
		const root = this.roots.findIndex((candidate) => containsPath(candidate.fsPath, uri.fsPath));
		if (root < 0) {
			// Outside every declared root, which the editor surface would refuse too.
			return '';
		}
		const relative = path.relative(this.roots[root].fsPath, uri.fsPath).split(path.sep).join('/');
		const segments = relative.split('/').map((segment) => encodeURIComponent(segment));
		return `/resource/${root}/${segments.join('/')}`;
	}

	setHtml(html: string): void {
		this.document = html;
	}

	setLocalResourceRoots(roots: readonly vscode.Uri[]): void {
		this.roots = [...roots];
	}

	postMessage(message: Record<string, unknown>): Thenable<boolean> {
		if (this.disposed) {
			return Promise.resolve(false);
		}
		if (!this.connected) {
			// Held for the client's next stream rather than dropped: the board's
			// first push races the EventSource handshake on every page load.
			this.outbox.push(message);
			while (this.outbox.length > OUTBOX_LIMIT) {
				this.outbox.shift();
			}
			return Promise.resolve(true);
		}
		return Promise.resolve(this.write(message));
	}

	private write(message: Record<string, unknown>): boolean {
		if (!this.connected) {
			return false;
		}
		this.stream?.write(`data: ${JSON.stringify(message)}\n\n`);
		return true;
	}

	/** Attaches the client's event stream and replays anything buffered for it. */
	attach(stream: ServerResponse): void {
		this.stream = stream;
		for (const message of this.outbox.splice(0, this.outbox.length)) {
			this.write(message);
		}
		// A reconnect may have missed a change while the stream was down, so the
		// board is treated as newly visible and asks for a full projection.
		for (const listener of [...this.visibleListeners]) {
			listener();
		}
	}

	detach(stream: ServerResponse): void {
		if (this.stream === stream) {
			this.stream = undefined;
		}
	}

	get connected(): boolean {
		return !!this.stream && !this.stream.writableEnded;
	}

	receive(message: unknown): void {
		for (const listener of [...this.messageListeners]) {
			listener(message);
		}
	}

	onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable {
		this.messageListeners.add(listener);
		return new vscode.Disposable(() => this.messageListeners.delete(listener));
	}

	onDidBecomeVisible(listener: () => void): vscode.Disposable {
		this.visibleListeners.add(listener);
		return new vscode.Disposable(() => this.visibleListeners.delete(listener));
	}

	onDidDispose(listener: () => void): vscode.Disposable {
		this.disposeListeners.add(listener);
		return new vscode.Disposable(() => this.disposeListeners.delete(listener));
	}

	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.outbox.length = 0;
		if (this.stream && !this.stream.writableEnded) {
			this.stream.end();
		}
		this.stream = undefined;
		for (const listener of [...this.disposeListeners]) {
			listener();
		}
		this.disposeListeners.clear();
		this.messageListeners.clear();
		this.visibleListeners.clear();
	}
}

/** True when `candidate` is `root` itself or sits beneath it. */
export function containsPath(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
