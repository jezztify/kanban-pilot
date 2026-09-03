import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { FileHandle, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_NAME_LENGTH = 80;
const MAX_DIRECTORY_PATH_LENGTH = 4096;
const WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function resolveRegistryShareHost(bindAddress: string): string {
	const address = bindAddress.trim().toLowerCase();
	if (address !== '0.0.0.0' && address !== '::') {
		return bindAddress;
	}
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal) {
				return entry.address;
			}
		}
	}
	return 'localhost';
}

export interface LocalWorkspaceRegistryOptions {
	credential: string;
	port?: number;
	bindAddress?: string;
	ttlMs?: number;
	idleTtlMs?: number;
	onIdle?: () => void;
}

export interface LocalWorkspaceRegistry {
	readonly port: number;
	dispose(): void;
}

export interface SharedLocalWorkspaceRegistryOptions {
	/** A user-level directory shared by every VS Code window using the extension. */
	directory: string;
	/** The packaged standalone registry entry point. */
	registryScript: string;
	bindAddress?: string;
	ttlMs?: number;
	idleTtlMs?: number;
}

export interface SharedLocalWorkspaceRegistry extends LocalWorkspaceRegistry {
	readonly baseUrl: string;
	readonly credential: string;
	readonly clientId: string;
}

interface WorkspaceRegistration {
	id: string;
	name: string;
	boardUrl: string;
	directoryPath?: string;
	activeWorkspace?: string;
	/** Kept only in the in-memory record; public listings omit it. */
	connectionUrl?: string;
}

interface StoredWorkspace extends WorkspaceRegistration {
	lastSeenAt: number;
}

function json(response: ServerResponse, status: number, value?: unknown): void {
	response.statusCode = status;
	response.setHeader('cache-control', 'no-store');
	if (value === undefined) {
		response.end();
		return;
	}
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(value));
}

function authorized(request: IncomingMessage, credential: string): boolean {
	const value = request.headers.authorization?.startsWith('Bearer ')
		? request.headers.authorization.slice('Bearer '.length)
		: '';
	const actual = Buffer.from(value);
	const expected = Buffer.from(credential);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += bytes.byteLength;
		if (size > MAX_BODY_BYTES) {
			throw new Error('Request body is too large.');
		}
		chunks.push(bytes);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new Error('Request body must be valid JSON.');
	}
}

function normalizeRegistration(value: unknown): WorkspaceRegistration {
	if (!value || typeof value !== 'object') {
		throw new Error('Registration must be an object.');
	}
	const input = value as Partial<WorkspaceRegistration>;
	const id = typeof input.id === 'string' ? input.id.trim() : '';
	if (!WORKSPACE_ID.test(id)) {
		throw new Error('Workspace id is invalid.');
	}
	const name = typeof input.name === 'string' ? input.name.replace(/\s+/g, ' ').trim() : '';
	if (!name || name.length > MAX_NAME_LENGTH) {
		throw new Error('Workspace name must contain 1–80 characters.');
	}
	if (typeof input.boardUrl !== 'string') {
		throw new Error('Board URL is required.');
	}
	let directoryPath: string | undefined;
	if (input.directoryPath !== undefined) {
		if (typeof input.directoryPath !== 'string') {
			throw new Error('Directory path must be a string.');
		}
		directoryPath = input.directoryPath.trim();
		if (!directoryPath || directoryPath.length > MAX_DIRECTORY_PATH_LENGTH) {
			throw new Error('Directory path must contain 1–4096 characters.');
		}
	}
	let activeWorkspace: string | undefined;
	if (input.activeWorkspace !== undefined) {
		if (typeof input.activeWorkspace !== 'string') {
			throw new Error('Active workspace name must be a string.');
		}
		activeWorkspace = input.activeWorkspace.replace(/\s+/g, ' ').trim();
		if (!activeWorkspace || activeWorkspace.length > MAX_NAME_LENGTH) {
			throw new Error('Active workspace name must contain 1–80 characters.');
		}
	}
	let url: URL;
	try {
		url = new URL(input.boardUrl);
	} catch {
		throw new Error('Board URL must be absolute.');
	}
	if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
		throw new Error('Board URL must be a credential-free absolute HTTP(S) URL.');
	}
	let connectionUrl = url.toString();
	if (input.connectionUrl !== undefined) {
		if (typeof input.connectionUrl !== 'string') {
			throw new Error('Connection URL must be a string.');
		}
		try {
			const candidate = new URL(input.connectionUrl);
			if (!['http:', 'https:'].includes(candidate.protocol) || !candidate.hostname || candidate.username || candidate.password) {
				throw new Error('invalid protocol or credentials');
			}
			connectionUrl = candidate.toString();
		} catch {
			throw new Error('Connection URL must be an absolute credential-free HTTP(S) URL.');
		}
	}
	url.search = '';
	url.hash = '';
	return {
		id,
		name,
		boardUrl: url.toString().replace(/\/$/, ''),
		...(directoryPath === undefined ? {} : { directoryPath }),
		...(activeWorkspace === undefined ? {} : { activeWorkspace }),
		connectionUrl,
	};
}

function publicWorkspaces(workspaces: Iterable<StoredWorkspace>, ttlMs: number): Array<WorkspaceRegistration & { available: true }> {
	const threshold = Date.now() - ttlMs;
	return [...workspaces]
		.filter((workspace) => workspace.lastSeenAt >= threshold)
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(({ id, name, boardUrl, directoryPath, activeWorkspace }) => ({
			id,
			name,
			boardUrl,
			...(directoryPath === undefined ? {} : { directoryPath }),
			...(activeWorkspace === undefined ? {} : { activeWorkspace }),
			available: true as const,
		}));
}

function landingPage(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width, initial-scale=1">
		<meta name="theme-color" content="#f5f7fb">
		<title>Kanban Pilot Registry</title>
		<style>
			:root {
				color-scheme: light;
				--ink: #172033;
				--muted: #526079;
				--soft: #71809a;
				--line: #dfe5ef;
				--surface: rgba(255, 255, 255, .88);
				--accent: #087f68;
				--accent-dark: #056653;
				--warm: #f2a51a;
				--error: #a63d45;
			}

			* { box-sizing: border-box; }
			html { min-width: 320px; scroll-behavior: smooth; }
			body {
				min-height: 100vh;
				margin: 0;
				background:
					radial-gradient(circle at 84% 8%, rgba(75, 190, 160, .2), transparent 26rem),
					linear-gradient(135deg, #f8fafc 0%, #edf4f5 52%, #f9f7f1 100%);
				color: var(--ink);
				font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
				line-height: 1.5;
			}
			a { color: inherit; }
			button { font: inherit; }
			button:focus-visible, a:focus-visible {
				outline: 3px solid var(--warm);
				outline-offset: 4px;
			}
			[hidden] { display: none !important; }

			.page-shell { width: min(100% - 2rem, 1120px); margin: 0 auto; padding: 1.25rem 0 2rem; }
			.site-header { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
			.brand {
				display: inline-flex;
				align-items: center;
				gap: .7rem;
				font-size: .95rem;
				font-weight: 700;
				letter-spacing: -.01em;
				text-decoration: none;
			}
			.brand strong { color: var(--accent); }
			.brand-mark {
				position: relative;
				display: grid;
				width: 2.25rem;
				height: 2.25rem;
				place-items: center;
				border-radius: .75rem;
				background: var(--ink);
				box-shadow: 0 .5rem 1.3rem rgba(23, 32, 51, .2);
			}
			.brand-mark::before, .brand-mark::after { content: ""; position: absolute; border-radius: 999px; background: #f7c75d; }
			.brand-mark::before { width: .42rem; height: 1.05rem; transform: translateX(-.38rem); }
			.brand-mark::after { width: .42rem; height: 1.45rem; transform: translateX(.38rem); background: #6ed4b3; }
			.header-pill {
				display: inline-flex;
				align-items: center;
				gap: .45rem;
				padding: .42rem .7rem;
				border: 1px solid rgba(8, 127, 104, .2);
				border-radius: 999px;
				background: rgba(255, 255, 255, .52);
				color: var(--muted);
				font-size: .76rem;
				font-weight: 700;
				letter-spacing: .04em;
				text-transform: uppercase;
			}
			.status-dot { width: .48rem; height: .48rem; border-radius: 50%; background: #27ae83; box-shadow: 0 0 0 .25rem rgba(39, 174, 131, .14); }

			main { padding: 4.25rem 0 2.5rem; }
			.intro { max-width: 56rem; margin-bottom: 2.75rem; }
			.eyebrow { margin: 0 0 .7rem; color: var(--accent); font-size: .72rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
			h1 { max-width: 15ch; margin: 0; font-size: clamp(2.7rem, 7vw, 5.4rem); font-weight: 800; letter-spacing: -.075em; line-height: .95; }
			h1 span { color: var(--accent); }
			.lede { max-width: 38rem; margin: 1.25rem 0 0; color: var(--muted); font-size: clamp(1rem, 1.5vw, 1.14rem); }

			.workspace-panel { padding: clamp(1.15rem, 3vw, 1.8rem); border: 1px solid rgba(255, 255, 255, .9); border-radius: 1.35rem; background: var(--surface); box-shadow: 0 1rem 3rem rgba(31, 48, 80, .08); backdrop-filter: blur(18px); }
			.panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 1.25rem; padding-bottom: 1.15rem; border-bottom: 1px solid var(--line); }
			.panel-heading .eyebrow { margin-bottom: .35rem; }
			h2 { margin: 0; font-size: clamp(1.45rem, 3vw, 2rem); letter-spacing: -.045em; line-height: 1; }
			.panel-actions { display: flex; align-items: center; gap: .7rem; }
			.panel-count { padding: .42rem .68rem; border: 1px solid var(--line); border-radius: .65rem; color: var(--muted); font-size: .76rem; font-weight: 800; white-space: nowrap; }
			.refresh-button { min-height: 2.75rem; padding: .55rem .85rem; border: 1px solid var(--accent); border-radius: .65rem; background: var(--accent); color: #fff; cursor: pointer; font-size: .8rem; font-weight: 800; }
			.refresh-button:hover:not(:disabled) { background: var(--accent-dark); border-color: var(--accent-dark); }
			.refresh-button:disabled { cursor: wait; opacity: .65; }
			.workspace-status { display: flex; align-items: center; gap: .65rem; min-height: 3.4rem; color: var(--muted); font-size: .9rem; }
			.workspace-status[data-state="ready"] { color: var(--accent-dark); }
			.workspace-status[data-state="error"] { color: var(--error); font-weight: 700; }
			.status-spinner { width: .8rem; height: .8rem; flex: 0 0 auto; border: 2px solid rgba(8, 127, 104, .22); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; }
			.workspace-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .85rem; min-height: 7.5rem; margin: 0; padding: 0; list-style: none; }
			.workspace-card { min-width: 0; border: 1px solid var(--line); border-radius: .95rem; background: rgba(255, 255, 255, .72); transition: border-color .2s ease, transform .2s ease, box-shadow .2s ease; }
			.workspace-card:hover { border-color: rgba(8, 127, 104, .46); transform: translateY(-2px); box-shadow: 0 .7rem 1.8rem rgba(31, 48, 80, .08); }
			.workspace-link { display: flex; flex-direction: column; justify-content: space-between; gap: 1.25rem; min-height: 9.5rem; padding: 1.05rem; color: var(--ink); text-decoration: none; }
			.workspace-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
			.workspace-name { min-width: 0; overflow: hidden; font-size: 1.02rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
			.live-badge { display: inline-flex; align-items: center; gap: .4rem; flex: 0 0 auto; color: var(--accent-dark); font-size: .72rem; font-weight: 800; }
			.live-badge::before { content: ""; width: .45rem; height: .45rem; border-radius: 50%; background: #27ae83; box-shadow: 0 0 0 .2rem rgba(39, 174, 131, .14); }
			.workspace-details { display: grid; gap: .5rem; min-width: 0; }
			.workspace-detail { min-width: 0; }
			.workspace-detail-label { display: block; color: var(--soft); font-size: .64rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
			.workspace-detail-value { display: block; overflow: hidden; color: var(--muted); font-size: .78rem; text-overflow: ellipsis; white-space: nowrap; }
			.workspace-open { display: flex; align-items: center; justify-content: space-between; gap: .5rem; color: var(--accent); font-size: .8rem; font-weight: 800; }
			.workspace-open-arrow { font-size: 1rem; transition: transform .2s ease; }
			.workspace-link:hover .workspace-open-arrow { transform: translateX(.2rem); }
			.workspace-skeleton { min-height: 9.5rem; padding: 1.05rem; border: 1px solid var(--line); border-radius: .95rem; background: linear-gradient(100deg, rgba(234, 239, 245, .75) 25%, rgba(255, 255, 255, .92) 38%, rgba(234, 239, 245, .75) 63%); background-size: 300% 100%; animation: shimmer 1.5s ease-in-out infinite; }
			.skeleton-line { display: block; height: .8rem; margin-bottom: .7rem; border-radius: 999px; background: rgba(150, 166, 187, .22); }
			.skeleton-line.short { width: 30%; }
			.skeleton-line.long { width: 65%; margin-top: 3.5rem; }
			.empty-state { padding: 2rem 1rem; border: 1px dashed #b8c6d7; border-radius: .95rem; background: rgba(243, 248, 249, .72); color: var(--muted); text-align: center; }
			.empty-state strong { display: block; margin-bottom: .3rem; color: var(--ink); font-size: 1rem; }
			.panel-footer { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-top: 1.35rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--soft); font-size: .78rem; }
			.panel-footer p { margin: 0; }
			.site-footer { margin-top: 2rem; color: var(--soft); font-size: .75rem; text-align: center; }

			@keyframes spin { to { transform: rotate(360deg); } }
			@keyframes shimmer { 0% { background-position: 100% 0; } 100% { background-position: 0 0; } }
			@media (max-width: 900px) { .workspace-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
			@media (max-width: 640px) {
				.page-shell { width: min(100% - 1.25rem, 1120px); padding-top: .9rem; }
				.site-header { align-items: flex-start; }
				.header-pill { padding: .35rem .5rem; font-size: .67rem; }
				main { padding-top: 3.5rem; }
				h1 { font-size: clamp(2.7rem, 15vw, 4.1rem); }
				.workspace-panel { border-radius: 1.25rem; }
				.panel-heading, .panel-footer { align-items: flex-start; flex-direction: column; }
				.panel-actions { width: 100%; justify-content: space-between; }
				.panel-count { align-self: flex-start; }
				.workspace-list { grid-template-columns: 1fr; }
			}
			@media (prefers-reduced-motion: reduce) {
				*, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: .01ms !important; }
			}
		</style>
	</head>
	<body>
		<div class="page-shell">
			<header class="site-header">
				<a class="brand" href="/" aria-label="Kanban Pilot Registry home">
					<span class="brand-mark" aria-hidden="true"></span>
					<span>Kanban Pilot <strong>Registry</strong></span>
				</a>
				<span class="header-pill"><span class="status-dot" aria-hidden="true"></span>Directory online</span>
			</header>

			<main id="main-content">
				<section class="intro" aria-labelledby="page-title">
					<p class="eyebrow">Directory online</p>
					<h1 id="page-title">Open a board and get <span>to work.</span></h1>
					<p class="lede">Find a live Kanban Pilot workspace, then continue in the board that is already ready for you.</p>
				</section>

				<section class="workspace-panel" aria-labelledby="workspace-heading">
					<div class="panel-heading">
						<div>
							<p class="eyebrow">Available now</p>
							<h2 id="workspace-heading">Your live workspaces</h2>
						</div>
						<div class="panel-actions">
							<span id="workspace-count" class="panel-count">Scanning…</span>
							<button id="refresh" class="refresh-button" type="button">Refresh</button>
						</div>
					</div>
					<div id="workspace-status" class="workspace-status" role="status" aria-live="polite" aria-atomic="true" aria-busy="true" tabindex="-1">
						<span class="status-spinner" aria-hidden="true"></span>
						<span>Finding live workspaces…</span>
					</div>
					<ul id="workspace-list" class="workspace-list" aria-label="Available workspaces">
						<li class="workspace-skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line long"></span></li>
						<li class="workspace-skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line long"></span></li>
						<li class="workspace-skeleton" aria-hidden="true"><span class="skeleton-line short"></span><span class="skeleton-line long"></span></li>
					</ul>
					<div id="empty-state" class="empty-state" hidden>
						<strong>No live workspaces</strong>
						<span>Open a board in VS Code and share it to make it available here.</span>
					</div>
					<div class="panel-footer">
						<p>This local directory shows workspace paths and active workspace labels alongside safe connection links.</p>
					</div>
				</section>
			</main>

			<footer class="site-footer">A focused front door for live Kanban Pilot boards.</footer>
		</div>

		<script>
			const status = document.getElementById("workspace-status");
			const count = document.getElementById("workspace-count");
			const list = document.getElementById("workspace-list");
			const empty = document.getElementById("empty-state");
			const refresh = document.getElementById("refresh");
			let lastWorkspaces = null;

			function setStatus(message, state, busy) {
				status.dataset.state = state;
				status.setAttribute("aria-busy", busy ? "true" : "false");
				status.replaceChildren();
				if (busy) {
					const spinner = document.createElement("span");
					spinner.className = "status-spinner";
					spinner.setAttribute("aria-hidden", "true");
					status.append(spinner);
				}
				const copy = document.createElement("span");
				copy.textContent = message;
				status.append(copy);
			}

			function isWorkspace(value) {
				return Boolean(value && typeof value.id === "string" && typeof value.name === "string" && value.id && value.name
					&& (value.directoryPath === undefined || typeof value.directoryPath === "string")
					&& (value.activeWorkspace === undefined || typeof value.activeWorkspace === "string"));
			}

			function appendWorkspaceDetail(container, label, value) {
				const detail = document.createElement("span");
				detail.className = "workspace-detail";
				const detailLabel = document.createElement("span");
				detailLabel.className = "workspace-detail-label";
				detailLabel.textContent = label;
				const detailValue = document.createElement("span");
				detailValue.className = "workspace-detail-value";
				detailValue.textContent = value;
				detailValue.title = value;
				detail.append(detailLabel, detailValue);
				container.append(detail);
			}

			function renderWorkspaces(workspaces) {
				list.replaceChildren();
				list.hidden = workspaces.length === 0;
				empty.hidden = workspaces.length !== 0;
				if (workspaces.length === 0) {
					count.textContent = "None available";
					setStatus("No live workspaces.", "empty", false);
					return;
				}

				const label = workspaces.length === 1 ? "workspace" : "workspaces";
				count.textContent = workspaces.length + " " + label;
				setStatus(workspaces.length + " live " + label + " ready to open.", "ready", false);
				workspaces.forEach((workspace) => {
					const item = document.createElement("li");
					item.className = "workspace-card";
					const link = document.createElement("a");
					link.className = "workspace-link";
					link.href = "/api/workspaces/" + encodeURIComponent(workspace.id) + "/connection";
					link.setAttribute("aria-label", "Open " + workspace.name + " workspace board");
					const head = document.createElement("span");
					head.className = "workspace-card-head";
					const name = document.createElement("span");
					name.className = "workspace-name";
					name.textContent = workspace.name;
					const live = document.createElement("span");
					live.className = "live-badge";
					live.textContent = "Live";
					head.append(name, live);
					const details = document.createElement("span");
					details.className = "workspace-details";
					if (workspace.directoryPath) appendWorkspaceDetail(details, "Directory path", workspace.directoryPath);
					if (workspace.activeWorkspace) appendWorkspaceDetail(details, "Active workspace", workspace.activeWorkspace);
					const action = document.createElement("span");
					action.className = "workspace-open";
					const actionLabel = document.createElement("span");
					actionLabel.textContent = "Open board";
					const arrow = document.createElement("span");
					arrow.className = "workspace-open-arrow";
					arrow.setAttribute("aria-hidden", "true");
					arrow.textContent = "→";
					action.append(actionLabel, arrow);
					link.append(head);
					if (details.childElementCount > 0) link.append(details);
					link.append(action);
					item.append(link);
					list.append(item);
				});
			}

			function loadingSkeletons() {
				list.hidden = false;
				list.replaceChildren();
				for (let index = 0; index < 3; index += 1) {
					const skeleton = document.createElement("li");
					skeleton.className = "workspace-skeleton";
					skeleton.setAttribute("aria-hidden", "true");
					const shortLine = document.createElement("span");
					shortLine.className = "skeleton-line short";
					const longLine = document.createElement("span");
					longLine.className = "skeleton-line long";
					skeleton.append(shortLine, longLine);
					list.append(skeleton);
				}
			}

			function loadWorkspaces() {
				refresh.disabled = true;
				loadingSkeletons();
				empty.hidden = true;
				count.textContent = "Scanning…";
				setStatus("Finding live workspaces…", "loading", true);
				fetch('/api/workspaces')
					.then((response) => {
						if (!response.ok) throw new Error("Workspace request failed.");
						return response.json();
					})
					.then((payload) => {
						const workspaces = Array.isArray(payload.workspaces) ? payload.workspaces.filter(isWorkspace) : [];
						lastWorkspaces = workspaces;
						renderWorkspaces(workspaces);
					})
					.catch(() => {
						if (lastWorkspaces) {
							renderWorkspaces(lastWorkspaces);
						} else {
							list.replaceChildren();
							list.hidden = true;
							empty.hidden = true;
							count.textContent = "Unavailable";
						}
						setStatus("Couldn’t load the Registry. Select Refresh to try again.", "error", false);
					})
					.finally(() => { refresh.disabled = false; });
			}

			refresh.addEventListener("click", () => {
				loadWorkspaces();
				status.focus();
			});
			loadWorkspaces();
		</script>
	</body>
</html>`;
}

/**
 * Starts the extension-local discovery registry. It is intentionally
 * in-memory: workspaces re-register after every extension start, while the
 * separately deployed hosted registry remains the durable multi-workspace
 * option. The registry never receives task data or board access tokens.
 */
export async function startLocalWorkspaceRegistry(options: LocalWorkspaceRegistryOptions): Promise<LocalWorkspaceRegistry> {
	if (!options.credential.trim()) {
		throw new Error('Local registry credential cannot be blank.');
	}
	const ttlMs = options.ttlMs ?? 90_000;
	const idleTtlMs = options.idleTtlMs ?? 90_000;
	const workspaces = new Map<string, StoredWorkspace>();
	const clients = new Map<string, number>();
	const startedAt = Date.now();
	let readyForIdle = false;
	let disposed = false;
	const idleSweep = options.onIdle
		? setInterval(() => {
			const threshold = Date.now() - idleTtlMs;
			for (const [clientId, lastSeenAt] of clients) {
				if (lastSeenAt < threshold) {
					clients.delete(clientId);
				}
			}
			if (readyForIdle && !disposed && clients.size === 0 && Date.now() - startedAt >= idleTtlMs) {
				options.onIdle?.();
			}
		}, Math.max(100, Math.min(idleTtlMs, 5_000)))
		: undefined;
	idleSweep?.unref?.();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://kanban-pilot-registry.local');
		try {
			if (request.method === 'GET' && url.pathname === '/') {
				response.statusCode = 200;
				response.setHeader('content-type', 'text/html; charset=utf-8');
				response.setHeader('cache-control', 'no-store');
				response.end(landingPage());
				return;
			}
			if (request.method === 'GET' && url.pathname === '/health') {
				json(response, 200, { ok: true, service: 'kanban-pilot-local-workspace-registry' });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/workspaces') {
				json(response, 200, { workspaces: publicWorkspaces(workspaces.values(), ttlMs) });
				return;
			}
			const connection = /^\/api\/workspaces\/([^/]+)\/connection$/.exec(url.pathname);
			if (request.method === 'GET' && connection) {
				const workspace = workspaces.get(decodeURIComponent(connection[1]));
				if (!workspace || workspace.lastSeenAt < Date.now() - ttlMs || !workspace.connectionUrl) {
					json(response, 404, { error: 'Workspace is no longer available.' });
					return;
				}
				response.statusCode = 302;
				response.setHeader('cache-control', 'no-store');
				response.setHeader('location', workspace.connectionUrl);
				response.end();
				return;
			}
			if (request.method === 'PUT' && url.pathname === '/api/workspaces') {
				if (!authorized(request, options.credential)) {
					json(response, 401, { error: 'Authentication required.' });
					return;
				}
				const registration = normalizeRegistration(await readBody(request));
				workspaces.set(registration.id, { ...registration, lastSeenAt: Date.now() });
				json(response, 204);
				return;
			}
			const client = /^\/api\/clients\/([^/]+)$/.exec(url.pathname);
			if ((request.method === 'PUT' || request.method === 'DELETE') && client) {
				if (!authorized(request, options.credential)) {
					json(response, 401, { error: 'Authentication required.' });
					return;
				}
				const clientId = decodeURIComponent(client[1]);
				if (!WORKSPACE_ID.test(clientId)) {
					json(response, 400, { error: 'Client id is invalid.' });
					return;
				}
				if (request.method === 'PUT') {
					clients.set(clientId, Date.now());
				} else {
					clients.delete(clientId);
				}
				json(response, 204);
				return;
			}
			const removal = /^\/api\/workspaces\/([^/]+)$/.exec(url.pathname);
			if (request.method === 'DELETE' && removal) {
				if (!authorized(request, options.credential)) {
					json(response, 401, { error: 'Authentication required.' });
					return;
				}
				workspaces.delete(decodeURIComponent(removal[1]));
				json(response, 204);
				return;
			}
			json(response, 404, { error: 'Not found.' });
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, options.bindAddress ?? '127.0.0.1', resolve);
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		idleSweep?.unref?.();
		if (idleSweep) {
			clearInterval(idleSweep);
		}
		server.close();
		throw new Error('Local registry did not expose a TCP port.');
	}
	readyForIdle = true;
	return {
		port: address.port,
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			if (idleSweep) {
				clearInterval(idleSweep);
			}
			server.close();
		},
	};
}

interface SharedRegistryMetadata {
	version: 1;
	baseUrl: string;
	credential: string;
}

interface StartupLockMetadata {
	pid: number;
}

const SHARED_REGISTRY_METADATA_FILE = 'local-registry.json';
const SHARED_REGISTRY_LOCK_FILE = 'local-registry.lock';
const SHARED_REGISTRY_HEALTH_TIMEOUT_MS = 1_000;
const SHARED_REGISTRY_START_TIMEOUT_MS = 10_000;

function sharedRegistryMetadataPath(directory: string): string {
	return path.join(directory, SHARED_REGISTRY_METADATA_FILE);
}

function sharedRegistryLockPath(directory: string): string {
	return path.join(directory, SHARED_REGISTRY_LOCK_FILE);
}

function validSharedRegistryMetadata(value: unknown): SharedRegistryMetadata | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}
	const candidate = value as Partial<SharedRegistryMetadata>;
	if (candidate.version !== 1 || typeof candidate.baseUrl !== 'string' || typeof candidate.credential !== 'string' || !candidate.credential) {
		return undefined;
	}
	try {
		const url = new URL(candidate.baseUrl);
		if (url.protocol !== 'http:' || !url.hostname || url.search || url.hash || url.username || url.password) {
			return undefined;
		}
	} catch {
		return undefined;
	}
	return { version: 1, baseUrl: candidate.baseUrl.replace(/\/$/, ''), credential: candidate.credential };
}

async function readSharedRegistryMetadata(directory: string): Promise<SharedRegistryMetadata | undefined> {
	try {
		return validSharedRegistryMetadata(JSON.parse(await readFile(sharedRegistryMetadataPath(directory), 'utf8')));
	} catch {
		return undefined;
	}
}

async function writeSharedRegistryMetadata(directory: string, metadata: SharedRegistryMetadata): Promise<void> {
	const target = sharedRegistryMetadataPath(directory);
	const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, target);
}

async function readStartupLock(directory: string): Promise<StartupLockMetadata | undefined> {
	try {
		const parsed: unknown = JSON.parse(await readFile(sharedRegistryLockPath(directory), 'utf8'));
		if (!parsed || typeof parsed !== 'object' || typeof (parsed as Partial<StartupLockMetadata>).pid !== 'number') {
			return undefined;
		}
		return { pid: (parsed as StartupLockMetadata).pid };
	} catch {
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function acquireStartupLock(directory: string): Promise<FileHandle | undefined> {
	try {
		const handle = await open(sharedRegistryLockPath(directory), 'wx');
		await handle.writeFile(JSON.stringify({ pid: process.pid }));
		return handle;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return undefined;
		}
		throw error;
	}
}

async function releaseStartupLock(directory: string, handle: FileHandle): Promise<void> {
	try {
		await handle.close();
	} finally {
		await unlink(sharedRegistryLockPath(directory)).catch(() => undefined);
	}
}

function waitForSharedRegistry(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function registryRequest(input: string, init: RequestInit = {}, timeoutMs = SHARED_REGISTRY_HEALTH_TIMEOUT_MS): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	timeout.unref?.();
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
	}
}

async function sharedRegistryIsHealthy(metadata: SharedRegistryMetadata): Promise<boolean> {
	try {
		const response = await registryRequest(`${metadata.baseUrl}/health`);
		if (!response.ok) {
			return false;
		}
		const body = await response.json() as { service?: unknown };
		return body.service === 'kanban-pilot-local-workspace-registry';
	} catch {
		return false;
	}
}

async function updateSharedRegistryClient(
	metadata: SharedRegistryMetadata,
	clientId: string,
	method: 'PUT' | 'DELETE',
): Promise<void> {
	const response = await registryRequest(
		`${metadata.baseUrl}/api/clients/${encodeURIComponent(clientId)}`,
		{ method, headers: { authorization: `Bearer ${metadata.credential}` } },
		SHARED_REGISTRY_HEALTH_TIMEOUT_MS,
	);
	if (!response.ok) {
		throw new Error(`Shared local registry client lease was rejected (${response.status}).`);
	}
}

async function spawnSharedRegistry(
	options: SharedLocalWorkspaceRegistryOptions,
	credential: string,
): Promise<{ port: number; child: ChildProcess }> {
	const child = spawn(process.execPath, [path.resolve(options.registryScript)], {
		cwd: path.dirname(path.resolve(options.registryScript)),
		detached: true,
		windowsHide: true,
		stdio: ['ignore', 'pipe', 'ignore'],
		env: {
			...process.env,
			KANBAN_PILOT_REGISTRY_CREDENTIAL: credential,
			KANBAN_PILOT_REGISTRY_PORT: '0',
			KANBAN_PILOT_REGISTRY_HOST: options.bindAddress ?? '127.0.0.1',
			KANBAN_PILOT_REGISTRY_TTL_MS: String(options.ttlMs ?? 90_000),
			KANBAN_PILOT_REGISTRY_IDLE_TTL_MS: String(options.idleTtlMs ?? 90_000),
		},
	});

	return new Promise((resolve, reject) => {
		let output = '';
		let settled = false;
		let timeout: NodeJS.Timeout;
		const finish = (error: Error | undefined, port?: number): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			child.stdout?.removeListener('data', onData);
			if (error) {
				child.kill();
				reject(error);
				return;
			}
			child.stdout?.destroy();
			child.unref();
			resolve({ port: port!, child });
		};
		timeout = setTimeout(() => finish(new Error('Shared local registry did not become ready in time.')), SHARED_REGISTRY_START_TIMEOUT_MS);
		timeout.unref?.();
		const onData = (chunk: Buffer | string): void => {
			output += String(chunk);
			const match = /KANBAN_PILOT_REGISTRY_READY\s+(\d+)/.exec(output);
			if (match) {
				finish(undefined, Number(match[1]));
			}
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', onData);
		child.once('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
		child.once('exit', (code) => {
			if (!settled) {
				finish(new Error(`Shared local registry exited before startup (code ${code ?? 'unknown'}).`));
			}
		});
	});
}

async function attachSharedRegistry(
	metadata: SharedRegistryMetadata,
): Promise<SharedLocalWorkspaceRegistry> {
	const clientId = randomUUID();
	await updateSharedRegistryClient(metadata, clientId, 'PUT');
	let disposed = false;
	const heartbeat = setInterval(() => {
		if (!disposed) {
			void updateSharedRegistryClient(metadata, clientId, 'PUT').catch(() => undefined);
		}
	}, 30_000);
	heartbeat.unref?.();
	const port = Number(new URL(metadata.baseUrl).port);
	return {
		port,
		baseUrl: metadata.baseUrl,
		credential: metadata.credential,
		clientId,
		dispose: () => {
			if (disposed) {
				return;
			}
			disposed = true;
			clearInterval(heartbeat);
			void updateSharedRegistryClient(metadata, clientId, 'DELETE').catch(() => undefined);
		},
	};
}

/** Connects every extension host for the current user profile to one registry process. */
export async function connectSharedLocalWorkspaceRegistry(
	options: SharedLocalWorkspaceRegistryOptions,
): Promise<SharedLocalWorkspaceRegistry> {
	await mkdir(options.directory, { recursive: true });
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const existing = await readSharedRegistryMetadata(options.directory);
		if (existing && await sharedRegistryIsHealthy(existing)) {
			return attachSharedRegistry(existing);
		}

		const lock = await acquireStartupLock(options.directory);
		if (!lock) {
			const lockMetadata = await readStartupLock(options.directory);
			if (lockMetadata && !processIsAlive(lockMetadata.pid)) {
				await unlink(sharedRegistryLockPath(options.directory)).catch(() => undefined);
			} else if (!lockMetadata) {
				let ageMs = 0;
				try {
					ageMs = Date.now() - (await stat(sharedRegistryLockPath(options.directory))).mtimeMs;
				} catch {
					/* The competing starter released the lock between attempts. */
				}
				if (ageMs > SHARED_REGISTRY_START_TIMEOUT_MS) {
					await unlink(sharedRegistryLockPath(options.directory)).catch(() => undefined);
				} else {
					await waitForSharedRegistry(100);
				}
			} else {
				await waitForSharedRegistry(100);
			}
			continue;
		}

		try {
			const afterLock = await readSharedRegistryMetadata(options.directory);
			if (afterLock && await sharedRegistryIsHealthy(afterLock)) {
				return await attachSharedRegistry(afterLock);
			}

			const credential = afterLock?.credential ?? randomUUID();
			const child = await spawnSharedRegistry(options, credential);
			const shareHost = resolveRegistryShareHost(options.bindAddress ?? '127.0.0.1');
			const metadata: SharedRegistryMetadata = {
				version: 1,
				baseUrl: `http://${shareHost.includes(':') && !shareHost.startsWith('[') ? `[${shareHost}]` : shareHost}:${child.port}`,
				credential,
			};
			try {
				await writeSharedRegistryMetadata(options.directory, metadata);
				return await attachSharedRegistry(metadata);
			} catch (error) {
				child.child.kill();
				await unlink(sharedRegistryMetadataPath(options.directory)).catch(() => undefined);
				throw error;
			}
		} finally {
			await releaseStartupLock(options.directory, lock);
		}
	}
	throw new Error('Timed out waiting for the shared local workspace registry.');
}
