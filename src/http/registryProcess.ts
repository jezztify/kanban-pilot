import { startLocalWorkspaceRegistry } from './localWorkspaceRegistry';

const credential = process.env.KANBAN_PILOT_REGISTRY_CREDENTIAL ?? '';
const port = Number(process.env.KANBAN_PILOT_REGISTRY_PORT ?? 0);
const bindAddress = process.env.KANBAN_PILOT_REGISTRY_HOST ?? '127.0.0.1';
const ttlMs = Number(process.env.KANBAN_PILOT_REGISTRY_TTL_MS ?? 90_000);
const idleTtlMs = Number(process.env.KANBAN_PILOT_REGISTRY_IDLE_TTL_MS ?? 90_000);

let stopping = false;

async function main(): Promise<void> {
	const service = await startLocalWorkspaceRegistry({
		credential,
		port: Number.isFinite(port) && port >= 0 ? port : 0,
		bindAddress,
		ttlMs: Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 90_000,
		idleTtlMs: Number.isFinite(idleTtlMs) && idleTtlMs > 0 ? idleTtlMs : 90_000,
		onIdle: () => {
			if (stopping) {
				return;
			}
			stopping = true;
			service.dispose();
			process.exitCode = 0;
		},
	});
	process.stdout.write(`KANBAN_PILOT_REGISTRY_READY ${service.port}\n`);
	const stop = (): void => {
		if (stopping) {
			return;
		}
		stopping = true;
		service.dispose();
		process.exitCode = 0;
	};
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
