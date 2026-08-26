import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { BoardPanel, BoardTaskSetChange, BoardTaskSetHost } from '../board/boardPanel';
import { TASK_ACTIONS, TaskAction } from '../board/stateMachine';
import { TaskType } from '../model/task';
import { BrowserBoardSurface, containsPath } from './browserBoardSurface';

const MAX_BODY_BYTES = 64 * 1024;
/** Boards a browser may hold open at once before the oldest idle one is reclaimed. */
const MAX_SESSIONS = 24;
/** How long a session survives without an event stream before it is disposed. */
const SESSION_GRACE_MS = 60_000;
const SESSION_SWEEP_MS = 15_000;

/**
 * The workspace controller the endpoint serves. It is the same contract the
 * editor's board panel is built on, because the endpoint serves that board.
 */
export type RealtimeBoardHost = BoardTaskSetHost;

export interface RealtimeBoardServerOptions {
	host: RealtimeBoardHost;
	extensionUri: vscode.Uri;
	port: number;
	token: string;
	bindAddress?: string;
}

export interface RealtimeBoardServer extends Disposable {
	readonly port: number;
	/** Live browser boards, for diagnostics and tests. */
	readonly sessionCount: number;
}

interface Disposable {
	dispose(): void;
}

export interface HttpEndpointConfig {
	port: number;
	token: string;
	bindAddress: string;
	publicUrl?: string;
}

export interface HttpEndpointSettings {
	enabled?: unknown;
	token?: unknown;
	port?: unknown;
	host?: unknown;
	publicUrl?: unknown;
}

/** Validates the existing Settings-surface values; no environment state is read. */
export function httpEndpointConfig(settings: HttpEndpointSettings): HttpEndpointConfig | undefined {
	if (settings.enabled !== true) {
		return undefined;
	}
	const token = typeof settings.token === 'string' ? settings.token.trim() : '';
	if (!token) {
		throw new Error('Kanban Pilot HTTP access token cannot be blank while the endpoint is enabled.');
	}
	const port = settings.port;
	if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error('Kanban Pilot HTTP port must be an integer from 1 to 65535.');
	}
	const bindAddress = typeof settings.host === 'string' && settings.host.trim() ? settings.host.trim() : '127.0.0.1';
	const publicUrl = typeof settings.publicUrl === 'string' ? settings.publicUrl.trim() : '';
	if (publicUrl) {
		try {
			const url = new URL(publicUrl);
			if (!['http:', 'https:'].includes(url.protocol)) {
				throw new Error('unsupported protocol');
			}
		} catch {
			throw new Error('Kanban Pilot public URL must be an absolute http or https URL.');
		}
	}
	return {
		token,
		port,
		bindAddress,
		...(publicUrl ? { publicUrl } : {}),
	};
}

/** The two wildcard binds that mean "all interfaces" rather than a reachable host. */
export function isWildcardBindAddress(bindAddress: string): boolean {
	return bindAddress === '0.0.0.0' || bindAddress === '::';
}

/** True when a bind address is not loopback, i.e. reachable from other machines. */
export function isNonLoopbackBindAddress(bindAddress: string): boolean {
	const address = bindAddress.trim().toLowerCase();
	return address !== '127.0.0.1' && address !== '::1' && address !== 'localhost';
}

/** The interface lookup `resolveShareHost` depends on; injectable so tests stay deterministic. */
export type NetworkInterfaceLookup = typeof os.networkInterfaces;

/**
 * Resolves the host a shared link should point at. A wildcard bind means "all
 * interfaces", which is unreachable as a literal, so it is replaced by the first
 * non-internal LAN IPv4; when none exists it falls back to `localhost`.
 * Explicit hosts pass through verbatim.
 */
export function resolveShareHost(bindAddress: string, lookup: NetworkInterfaceLookup = os.networkInterfaces): string {
	if (!isWildcardBindAddress(bindAddress)) {
		return bindAddress;
	}
	for (const entries of Object.values(lookup())) {
		for (const entry of entries ?? []) {
			if (entry.family === 'IPv4' && !entry.internal) {
				return entry.address;
			}
		}
	}
	return 'localhost';
}

export function endpointUrl(config: Pick<HttpEndpointConfig, 'port' | 'bindAddress' | 'publicUrl'>, actualPort = config.port, lookup: NetworkInterfaceLookup = os.networkInterfaces): string {
	if (config.publicUrl) {
		return config.publicUrl.replace(/\/$/, '');
	}
	const host = resolveShareHost(config.bindAddress, lookup);
	return `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${actualPort}`;
}

/** Builds a shareable link to the live browser board. The receiver may use its `token` query parameter as authentication. */
export function endpointConnectionUrl(config: HttpEndpointConfig, actualPort = config.port, lookup: NetworkInterfaceLookup = os.networkInterfaces): string {
	const url = new URL(endpointUrl(config, actualPort, lookup));
	url.searchParams.set('token', config.token);
	return url.toString();
}

const RESOURCE_CONTENT_TYPES: Record<string, string> = {
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
};

function json(response: ServerResponse, status: number, value: unknown): void {
	response.statusCode = status;
	response.setHeader('content-type', 'application/json; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.end(JSON.stringify(value));
}

function html(response: ServerResponse, value: string): void {
	response.statusCode = 200;
	response.setHeader('content-type', 'text/html; charset=utf-8');
	response.setHeader('cache-control', 'no-store');
	response.end(value);
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
	for (const part of (request.headers.cookie ?? '').split(';')) {
		const separator = part.indexOf('=');
		if (separator > 0 && part.slice(0, separator).trim() === name) {
			return decodeURIComponent(part.slice(separator + 1).trim());
		}
	}
	return undefined;
}

function constantTimeEquals(value: string, expected: string): boolean {
	const actual = Buffer.from(value);
	const expectedBuffer = Buffer.from(expected);
	return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

const SESSION_COOKIE = 'kanbanPilotToken';

/**
 * Bearer header or `token` query parameter everywhere. The cookie is accepted
 * only for `GET /resource/...`, because a `<script src>` or `<img src>` cannot
 * carry a header — and it is never accepted for a mutation, so a cookie the
 * browser attaches on its own can't be used to act on the board.
 */
function tokenMatches(request: IncomingMessage, url: URL, expected: string, allowCookie = false): boolean {
	const authorization = request.headers.authorization;
	const value = authorization?.startsWith('Bearer ')
		? authorization.slice('Bearer '.length)
		: url.searchParams.get('token') ?? (allowCookie ? cookieValue(request, SESSION_COOKIE) : undefined);
	if (value === null || value === undefined) {
		return false;
	}
	return constantTimeEquals(value, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.byteLength;
		if (size > MAX_BODY_BYTES) {
			throw new Error('Request body is too large.');
		}
		chunks.push(buffer);
	}
	if (!size) {
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new Error('Request body must be a JSON object.');
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (error instanceof Error && error.message === 'Request body must be a JSON object.') {
			throw error;
		}
		throw new Error('Request body must be valid JSON.');
	}
}

function hostRevision(host: RealtimeBoardHost): number {
	return typeof host.revision === 'number' && Number.isFinite(host.revision) ? host.revision : 0;
}

async function projection(host: RealtimeBoardHost): Promise<Record<string, unknown>> {
	await host.ready;
	const snapshot = await host.store.snapshot();
	return {
		revision: Math.max(hostRevision(host), snapshot.revision),
		activeTaskSet: host.activeSet,
		snapshot,
	};
}

function taskId(pathname: string, suffix: string): string | undefined {
	const match = new RegExp(`^/api/tasks/(TASK-\\d+)/${suffix}$`).exec(pathname);
	return match?.[1];
}

function isTaskAction(value: unknown): value is TaskAction {
	return typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);
}

function isTaskType(value: unknown): value is TaskType {
	return value === 'feature' || value === 'bug';
}

/** One browser tab's board: its own surface, panel, and selection. */
interface BoardSession {
	readonly id: string;
	readonly surface: BrowserBoardSurface;
	readonly panel: BoardPanel;
	idleSince: number | undefined;
}

/**
 * Serves the extension's own board webview to browsers, plus a small REST/SSE
 * API over the same host.
 *
 * The endpoint never persists a second board model and never renders a second
 * board: every snapshot comes from TaskStore, every mutation goes through the
 * existing RunManager and state machine, and the page a browser loads is the
 * document `BoardPanel` renders in the editor. Each connected browser gets its
 * own `BoardPanel` bound to a `BrowserBoardSurface`, so per-client state such
 * as the selected card stays per-client while the workspace stays shared.
 */
export async function startRealtimeBoardServer(options: RealtimeBoardServerOptions): Promise<RealtimeBoardServer> {
	const { host, extensionUri, port, token, bindAddress = '127.0.0.1' } = options;
	await host.ready;
	const listeners = new Set<ServerResponse>();
	const sessions = new Map<string, BoardSession>();

	const publish = async (change?: BoardTaskSetChange): Promise<void> => {
		if (!listeners.size) {
			return;
		}
		const board = await projection(host);
		const payload = JSON.stringify({ type: 'board', change, board });
		for (const response of listeners) {
			if (!response.writableEnded) {
				response.write(`event: board\ndata: ${payload}\n\n`);
			}
		}
	};
	const subscription = host.onDidChange((change) => { void publish(change); });

	const dropSession = (session: BoardSession): void => {
		sessions.delete(session.id);
		session.panel.dispose();
	};

	/**
	 * Reclaims boards whose browser has gone. A stream that drops is given a
	 * grace period first, because EventSource reconnects on its own and the
	 * board behind it should survive a flaky link or a laptop lid.
	 */
	const sweep = (): void => {
		const now = Date.now();
		for (const session of [...sessions.values()]) {
			if (session.surface.connected) {
				session.idleSince = undefined;
				continue;
			}
			session.idleSince ??= now;
			if (now - session.idleSince >= SESSION_GRACE_MS) {
				dropSession(session);
			}
		}
	};
	const sweeper = setInterval(sweep, SESSION_SWEEP_MS);
	sweeper.unref?.();

	const createSession = (): BoardSession => {
		if (sessions.size >= MAX_SESSIONS) {
			sweep();
		}
		if (sessions.size >= MAX_SESSIONS) {
			const oldest = [...sessions.values()].find((candidate) => !candidate.surface.connected)
				?? sessions.values().next().value as BoardSession;
			dropSession(oldest);
		}
		const id = randomUUID();
		const surface = new BrowserBoardSurface(id);
		// Constructing the panel renders the board document into the surface.
		const panel = BoardPanel.attach(surface, host, extensionUri);
		const session: BoardSession = { id, surface, panel, idleSince: Date.now() };
		sessions.set(id, session);
		return session;
	};

	// Mirrors BoardPanel.configureWebview: index 0 is the extension, index 1 is
	// the active task-set directory that attachments are read from. The active
	// set can change under a live client, so the roots are read per request.
	const resourceRoots = (): vscode.Uri[] => [extensionUri, host.store.directory];

	const serveResource = async (response: ServerResponse, rootIndex: number, relativePath: string): Promise<void> => {
		const root = resourceRoots()[rootIndex];
		if (!root || relativePath.includes('\0')) {
			json(response, 404, { error: 'Not found.' });
			return;
		}
		const resolved = path.resolve(root.fsPath, relativePath);
		if (!containsPath(root.fsPath, resolved)) {
			json(response, 403, { error: 'Resource is outside its permitted root.' });
			return;
		}
		let bytes: Uint8Array;
		try {
			bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(resolved));
		} catch {
			json(response, 404, { error: 'Not found.' });
			return;
		}
		response.statusCode = 200;
		response.setHeader('content-type', RESOURCE_CONTENT_TYPES[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream');
		// Task attachments change in place under a stable name, so nothing here
		// may be cached across a reload.
		response.setHeader('cache-control', 'no-store');
		response.end(Buffer.from(bytes));
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? '/', 'http://kanban-pilot.local');
		const resource = /^\/resource\/(\d+)\/(.+)$/.exec(url.pathname);
		try {
			if (!tokenMatches(request, url, token, request.method === 'GET' && !!resource)) {
				json(response, 401, { error: 'Authentication required.' });
				return;
			}

			if (request.method === 'GET' && resource) {
				await serveResource(response, Number(resource[1]), decodeURIComponent(resource[2]));
				return;
			}

			// ---- the board itself -------------------------------------------
			if (request.method === 'GET' && url.pathname === '/') {
				const session = createSession();
				// Resource and stream requests that follow this document cannot
				// carry the token themselves, so it is handed back as a cookie.
				const secure = request.headers['x-forwarded-proto'] === 'https';
				response.setHeader(
					'set-cookie',
					`${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
				);
				html(response, session.surface.html);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/session/events') {
				const session = sessions.get(url.searchParams.get('session') ?? '');
				if (!session) {
					json(response, 404, { error: 'This board session has expired. Reload the page.' });
					return;
				}
				response.statusCode = 200;
				response.setHeader('content-type', 'text/event-stream; charset=utf-8');
				response.setHeader('cache-control', 'no-cache, no-transform');
				response.setHeader('connection', 'keep-alive');
				response.flushHeaders?.();
				session.idleSince = undefined;
				session.surface.attach(response);
				const heartbeat = setInterval(() => {
					if (!response.writableEnded) { response.write(': heartbeat\n\n'); }
				}, 20_000);
				heartbeat.unref?.();
				request.on('close', () => {
					clearInterval(heartbeat);
					session.surface.detach(response);
					session.idleSince = Date.now();
				});
				return;
			}

			if (request.method === 'POST' && url.pathname === '/session/messages') {
				const session = sessions.get(url.searchParams.get('session') ?? '');
				if (!session) {
					json(response, 404, { error: 'This board session has expired. Reload the page.' });
					return;
				}
				session.surface.receive(await readJsonBody(request));
				json(response, 202, { ok: true });
				return;
			}

			// ---- REST/SSE API over the same host ----------------------------
			if (request.method === 'GET' && url.pathname === '/health') {
				json(response, 200, {
					ok: true,
					mode: 'extension-host',
					revision: hostRevision(host),
					sessions: sessions.size,
				});
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/board') {
				json(response, 200, await projection(host));
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/events') {
				response.statusCode = 200;
				response.setHeader('content-type', 'text/event-stream; charset=utf-8');
				response.setHeader('cache-control', 'no-cache, no-transform');
				response.setHeader('connection', 'keep-alive');
				listeners.add(response);
				await publish();
				const heartbeat = setInterval(() => {
					if (!response.writableEnded) { response.write(': heartbeat\n\n'); }
				}, 20_000);
				heartbeat.unref?.();
				request.on('close', () => {
					listeners.delete(response);
					clearInterval(heartbeat);
				});
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/tasks') {
				const body = await readJsonBody(request);
				if (typeof body.title !== 'string' || !body.title.trim() || !isTaskType(body.taskType)) {
					json(response, 400, { error: 'A title and valid task type are required.' });
					return;
				}
				const task = await host.store.create(body.title.trim(), {
					type: body.taskType,
					request: typeof body.description === 'string' ? body.description.trim() : undefined,
				});
				json(response, 201, { task, board: await projection(host) });
				return;
			}
			const actionTaskId = taskId(url.pathname, 'actions');
			if (request.method === 'POST' && actionTaskId) {
				const body = await readJsonBody(request);
				if (!isTaskAction(body.action)) {
					json(response, 400, { error: 'A valid task action is required.' });
					return;
				}
				await host.runManager.handleAction(actionTaskId, body.action);
				json(response, 202, await projection(host));
				return;
			}
			const moveTaskId = taskId(url.pathname, 'move');
			if (request.method === 'POST' && moveTaskId) {
				const body = await readJsonBody(request);
				const outcome = await host.runManager.moveTask(moveTaskId, body.destination);
				json(response, 200, { outcome, board: await projection(host) });
				return;
			}
			const reorderTaskId = taskId(url.pathname, 'reorder');
			if (request.method === 'POST' && reorderTaskId) {
				const body = await readJsonBody(request);
				const outcome = await host.runManager.reorderTask(reorderTaskId, body.column, body.target);
				json(response, 200, { outcome, board: await projection(host) });
				return;
			}
			const pendingTaskId = taskId(url.pathname, 'pending');
			if (request.method === 'POST' && pendingTaskId) {
				const outcome = await host.runManager.applyPendingOutcome(pendingTaskId);
				json(response, 200, { outcome, board: await projection(host) });
				return;
			}
			const deleteTaskId = /^\/api\/tasks\/(TASK-\d+)$/.exec(url.pathname)?.[1];
			if (request.method === 'DELETE' && deleteTaskId) {
				await host.store.delete(deleteTaskId);
				json(response, 200, { board: await projection(host) });
				return;
			}
			json(response, 404, { error: 'Not found.' });
		} catch (error) {
			json(response, 400, { error: error instanceof Error ? error.message : String(error) });
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, bindAddress, () => resolve());
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		subscription.dispose();
		clearInterval(sweeper);
		server.close();
		throw new Error('Kanban Pilot HTTP endpoint did not expose a TCP port.');
	}
	return {
		port: address.port,
		get sessionCount() {
			return sessions.size;
		},
		dispose: () => {
			subscription.dispose();
			clearInterval(sweeper);
			for (const session of [...sessions.values()]) {
				dropSession(session);
			}
			for (const response of listeners) {
				response.end();
			}
			listeners.clear();
			server.close();
		},
	};
}
