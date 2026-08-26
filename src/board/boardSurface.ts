import * as vscode from 'vscode';

/**
 * The presentation channel the board renders through.
 *
 * The board webview is one document with one message protocol. A surface is
 * everything about delivering that document which differs between a VS Code
 * webview panel and a browser served over the HTTP endpoint: how a bundled
 * file becomes a loadable URL, what the Content-Security-Policy must allow,
 * and how messages cross the boundary. Keeping that seam narrow is what lets
 * both clients run the same board rather than two that drift apart.
 */
export interface BoardSurface {
	/**
	 * Whether this client shares the host's editor. Actions that act on the
	 * editor rather than the board — opening a task file, docking a task's
	 * chat — are meaningful only then; elsewhere they would silently operate
	 * on a screen the person clicking cannot see.
	 */
	readonly hostEditor: boolean;
	/** Full CSP header value for the board document, including the script nonce. */
	contentSecurityPolicy(nonce: string): string;
	/** Resolves an on-disk resource to a URL this surface's client can load. */
	resourceUri(uri: vscode.Uri): string;
	/**
	 * Markup injected into the document head, ahead of the board's own styles
	 * and script. A surface uses it to supply whatever the board expects to
	 * already exist — for a browser, the editor's theme tokens and the
	 * `acquireVsCodeApi` bridge.
	 */
	bootstrapMarkup?(nonce: string): string;
	setHtml(html: string): void;
	/** Roots the surface is permitted to serve resources from. */
	setLocalResourceRoots(roots: readonly vscode.Uri[]): void;
	postMessage(message: Record<string, unknown>): Thenable<boolean>;
	onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable;
	/** Fires when the client becomes visible again and may hold stale content. */
	onDidBecomeVisible(listener: () => void): vscode.Disposable;
	onDidDispose(listener: () => void): vscode.Disposable;
	/** Brings an already-open surface forward; browsers have nothing to reveal. */
	reveal?(column?: vscode.ViewColumn): void;
	dispose(): void;
}

/** The board webview inside a VS Code editor panel. */
export class WebviewPanelSurface implements BoardSurface {
	readonly hostEditor = true;

	constructor(readonly panel: vscode.WebviewPanel) {}

	contentSecurityPolicy(nonce: string): string {
		const source = this.panel.webview.cspSource;
		return [
			"default-src 'none'",
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}' ${source}`,
			`img-src ${source} data:`,
		].join('; ');
	}

	resourceUri(uri: vscode.Uri): string {
		return this.panel.webview.asWebviewUri(uri).toString();
	}

	setHtml(html: string): void {
		this.panel.webview.html = html;
	}

	setLocalResourceRoots(roots: readonly vscode.Uri[]): void {
		this.panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [...roots],
		};
	}

	postMessage(message: Record<string, unknown>): Thenable<boolean> {
		return this.panel.webview.postMessage(message);
	}

	onDidReceiveMessage(listener: (message: unknown) => void): vscode.Disposable {
		return this.panel.webview.onDidReceiveMessage(listener);
	}

	onDidBecomeVisible(listener: () => void): vscode.Disposable {
		return this.panel.onDidChangeViewState((event) => {
			if (event.webviewPanel.visible || event.webviewPanel.active) {
				listener();
			}
		});
	}

	onDidDispose(listener: () => void): vscode.Disposable {
		return this.panel.onDidDispose(listener);
	}

	reveal(column?: vscode.ViewColumn): void {
		this.panel.reveal(column);
	}

	dispose(): void {
		this.panel.dispose();
	}
}
