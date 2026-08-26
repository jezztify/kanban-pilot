import * as vscode from 'vscode';
import * as QRCode from 'qrcode';

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, (character) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
	}[character] ?? character));
}

/** Displays the configured existing-host endpoint connection without creating another board UI. */
export async function showEndpointSharePanel(extensionUri: vscode.Uri, endpointUrl: string): Promise<void> {
	const panel = vscode.window.createWebviewPanel(
		'kanbanPilot.endpointShare',
		'Kanban Pilot Connection',
		vscode.ViewColumn.Active,
		{ enableScripts: true, localResourceRoots: [extensionUri] },
	);
	const qrCode = await QRCode.toDataURL(endpointUrl, {
		errorCorrectionLevel: 'M',
		margin: 2,
		width: 320,
		color: { dark: '#15111f', light: '#ffffff' },
	});
	const nonce = String(Date.now());
	panel.webview.html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { color: var(--vscode-foreground); background: var(--vscode-editor-background); font: var(--vscode-font-family); padding: 24px; text-align: center; }
h1 { font-size: 1.35em; margin: 0 0 8px; } p { color: var(--vscode-descriptionForeground); line-height: 1.45; }
img { width: min(320px, 80vw); height: auto; padding: 12px; border-radius: 12px; background: white; }
.url { display: flex; gap: 8px; margin: 20px auto 0; max-width: 560px; text-align: left; }
input { min-width: 0; flex: 1; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
button { padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 4px; cursor: pointer; }
small { display: block; margin-top: 18px; color: var(--vscode-descriptionForeground); }
</style></head><body>
<h1>Connect to Kanban Pilot</h1><p>Scan this QR code or copy the current Kanban board snapshot URL.</p>
<img src="${qrCode}" alt="QR code for Kanban Pilot endpoint connection">
<div class="url"><input id="url" readonly value="${escapeHtml(endpointUrl)}" aria-label="Kanban Pilot board snapshot URL"><button id="copy">Copy</button></div>
<small>This connection URL contains the access token. Treat it as a secret. The private Copilot chat remains in VS Code.</small>
<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));</script>
</body></html>`;
	panel.webview.onDidReceiveMessage(async (message: unknown) => {
		if (message && typeof message === 'object' && (message as { type?: unknown }).type === 'copy') {
			await vscode.env.clipboard.writeText(endpointUrl);
			void vscode.window.showInformationMessage('Kanban Pilot board snapshot URL copied.');
		}
	});
}
