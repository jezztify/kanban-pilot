import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { RegistryStore } from './registryStore';

export interface WorkspaceRegistryOptions {
	credential: string;
	dataFile: string;
	port?: number;
	bindAddress?: string;
	ttlMs?: number;
}

export interface WorkspaceRegistry {
	readonly port: number;
	dispose(): void;
}

function send(response: ServerResponse, status: number, value?: unknown): void {
	response.statusCode = status;
	response.setHeader('cache-control', 'no-store');
	if (value === undefined) { response.end(); return; }
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.end(JSON.stringify(value));
}

function authorized(request: IncomingMessage, credential: string): boolean {
	const value = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : '';
	const actual = Buffer.from(value);
	const expected = Buffer.from(credential);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function body(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		length += bytes.byteLength;
		if (length > 16 * 1024) { throw new Error('Request body is too large.'); }
		chunks.push(bytes);
	}
	try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Request body must be valid JSON.'); }
}

function page(): string {
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
				--accent-wash: #e6f5f0;
				--warm: #f2a51a;
				--error: #a63d45;
				--shadow: 0 24px 70px rgba(31, 48, 80, .13);
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
			.workspace-link { display: flex; flex-direction: column; justify-content: space-between; gap: 1.8rem; min-height: 9.5rem; padding: 1.05rem; color: var(--ink); text-decoration: none; }
			.workspace-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: .75rem; }
			.workspace-name { min-width: 0; overflow: hidden; font-size: 1.02rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
			.live-badge { display: inline-flex; align-items: center; gap: .4rem; flex: 0 0 auto; color: var(--accent-dark); font-size: .72rem; font-weight: 800; }
			.live-badge::before { content: ""; width: .45rem; height: .45rem; border-radius: 50%; background: #27ae83; box-shadow: 0 0 0 .2rem rgba(39, 174, 131, .14); }
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
				<span class="header-pill"><span class="status-dot" aria-hidden="true"></span>Live directory</span>
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
						<p>Only workspace names and safe connection links appear in this directory.</p>
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
				if (!value || typeof value.name !== "string" || typeof value.boardUrl !== "string") return false;
				try {
					const url = new URL(value.boardUrl, window.location.href);
					return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
				} catch { return false; }
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
					link.href = workspace.boardUrl;
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
					const action = document.createElement("span");
					action.className = "workspace-open";
					const actionLabel = document.createElement("span");
					actionLabel.textContent = "Open board";
					const arrow = document.createElement("span");
					arrow.className = "workspace-open-arrow";
					arrow.setAttribute("aria-hidden", "true");
					arrow.textContent = "→";
					action.append(actionLabel, arrow);
					link.append(head, action);
					item.append(link);
					list.append(item);
				});
			}

			function loadWorkspaces() {
				refresh.disabled = true;
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

/** Starts the standalone discovery service; it never proxies or reads any board state. */
export async function startWorkspaceRegistry(options: WorkspaceRegistryOptions): Promise<WorkspaceRegistry> {
	if (!options.credential.trim()) { throw new Error('Registry credential cannot be blank.'); }
	const store = new RegistryStore(options.dataFile);
	const ttlMs = options.ttlMs ?? 90_000;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://registry.local');
		try {
			if (request.method === 'GET' && url.pathname === '/') {
				response.statusCode = 200; response.setHeader('content-type', 'text/html; charset=utf-8'); response.setHeader('cache-control', 'no-store'); response.end(page()); return;
			}
			if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, { ok: true, service: 'kanban-pilot-workspace-registry' }); return; }
			if (request.method === 'GET' && url.pathname === '/api/workspaces') { send(response, 200, { workspaces: await store.list(ttlMs) }); return; }
			if (request.method === 'PUT' && url.pathname === '/api/workspaces') {
				if (!authorized(request, options.credential)) { send(response, 401, { error: 'Authentication required.' }); return; }
				await store.upsert(await body(request)); send(response, 204); return;
			}
			const removal = /^\/api\/workspaces\/([^/]+)$/.exec(url.pathname);
			if (request.method === 'DELETE' && removal) {
				if (!authorized(request, options.credential)) { send(response, 401, { error: 'Authentication required.' }); return; }
				await store.remove(decodeURIComponent(removal[1])); send(response, 204); return;
			}
			send(response, 404, { error: 'Not found.' });
		} catch (error) { send(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8080, options.bindAddress ?? '127.0.0.1', resolve); });
	const address = server.address();
	if (!address || typeof address === 'string') { server.close(); throw new Error('Registry did not expose a TCP port.'); }
	return { port: address.port, dispose: () => server.close() };
}

if (require.main === module) {
	const credential = process.env.KANBAN_PILOT_REGISTRY_CREDENTIAL ?? '';
	const dataFile = process.env.KANBAN_PILOT_REGISTRY_DATA ?? 'workspaces.json';
	void startWorkspaceRegistry({ credential, dataFile, port: Number(process.env.PORT ?? 9090), bindAddress: process.env.HOST ?? '0.0.0.0' }).then((service) => console.log(`Kanban Pilot workspace registry listening on ${service.port}`));
}
