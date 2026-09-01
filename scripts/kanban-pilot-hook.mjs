/**
 * Copilot chat hook that feeds Kanban Pilot's activity feed in real time
 * (TASK-015, docs/research/copilot-hook-feed-design.md).
 *
 * Copilot runs this once per subscribed event, writing the event payload to
 * stdin as JSON. It appends one structural line to a workspace-local spool that
 * the extension watches. This is the only source fast enough for the browser
 * board to keep up with a run: the transcript tail is 6-53 s behind on tool
 * events, because Copilot flushes its transcript at the next prompt render.
 *
 * Three rules are load-bearing:
 *
 * - **It always exits 0.** Exit code 2 tells Copilot to *block* the tool call,
 *   and any other non-zero exit is logged as a hook error. A feed must never be
 *   able to break the session it is reporting on, so every failure path here —
 *   unreadable stdin, unwritable spool, missing workspace — still exits 0.
 * - **It never writes a task file.** `TaskStore` replaces task files whole
 *   through a temp path and a rename, so an append from outside that window is
 *   silently lost. The spool is a separate file the extension drains.
 * - **It writes structure, not content.** Event name, ids, tool name and
 *   timestamps only — never tool arguments, tool output, or prompt text beyond
 *   the task marker. The feed reaches a shared, token-gated browser surface.
 *
 * Install by pointing a hook command at it:
 *   node "<repo>/scripts/kanban-pilot-hook.mjs" --spool "<repo>/.kanban-pilot/.hook-spool.jsonl"
 */

import { appendFile, stat } from 'node:fs/promises';

/** Bumped when the spool line shape changes; the receiver drops other versions. */
export const SPOOL_SCHEMA_VERSION = 1;

/** Refuse to grow the spool without bound if nothing is draining it. */
export const MAX_SPOOL_BYTES = 1_000_000;

/** The marker every Kanban Pilot prompt opens with, e.g. `## [kanban-pilot TASK-007]`. */
const TASK_MARKER = /^##\s*\[[^\]\n]*?\b(TASK-\d{3,})\s*\]/m;

/**
 * Pulls the task id out of a `UserPromptSubmit` prompt.
 *
 * This is what makes a task's *first* run attributable: `copilot_session_id` is
 * only written to the frontmatter about two seconds after a run's last event, so
 * it cannot identify the run that produces it (TASK-011). The prompt marker is
 * present from the first turn.
 */
export function taskIdFromPrompt(prompt) {
	if (typeof prompt !== 'string') {
		return undefined;
	}
	return TASK_MARKER.exec(prompt)?.[1];
}

/**
 * Reduces a hook payload to the structural line the spool carries. Returns
 * `undefined` for an event with nothing useful in it, so the caller writes
 * nothing rather than a placeholder.
 */
export function spoolLineFor(payload) {
	if (!payload || typeof payload !== 'object') {
		return undefined;
	}
	const event = payload.hook_event_name;
	if (typeof event !== 'string') {
		return undefined;
	}

	const line = {
		v: SPOOL_SCHEMA_VERSION,
		event,
		at: typeof payload.timestamp === 'string' ? payload.timestamp : new Date().toISOString(),
	};
	if (typeof payload.session_id === 'string') {
		line.sessionId = payload.session_id;
	}

	if (event === 'UserPromptSubmit') {
		const taskId = taskIdFromPrompt(payload.prompt);
		if (taskId) {
			line.taskId = taskId;
		}
	} else if (event === 'PreToolUse' || event === 'PostToolUse') {
		// `tool_name` is an identifier, not content. `tool_input` and any result
		// are deliberately not read at all.
		if (typeof payload.tool_name === 'string') {
			line.toolName = payload.tool_name;
		}
	}
	return line;
}

/** Reads all of stdin. Resolves to an empty string rather than rejecting. */
async function readStdin() {
	try {
		const chunks = [];
		for await (const chunk of process.stdin) {
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString('utf8');
	} catch {
		return '';
	}
}

function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i += 2) {
		if (argv[i] === '--spool' && argv[i + 1]) {
			options.spool = argv[i + 1];
		}
	}
	return options;
}

/** Appends one line, unless the spool has grown past its cap. Never throws. */
export async function appendSpoolLine(spoolPath, line) {
	try {
		const { size } = await stat(spoolPath).catch(() => ({ size: 0 }));
		if (size > MAX_SPOOL_BYTES) {
			return false;
		}
		await appendFile(spoolPath, `${JSON.stringify(line)}\n`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

async function main() {
	const { spool } = parseArgs(process.argv.slice(2));
	if (!spool) {
		return;
	}
	const raw = await readStdin();
	if (!raw.trim()) {
		return;
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return;
	}
	const line = spoolLineFor(payload);
	if (line) {
		await appendSpoolLine(spool, line);
	}
}

// Every path exits 0: a reporting hook must never be able to block a tool call.
const invokedDirectly = process.argv[1]
	&& import.meta.url === (await import('node:url')).pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
	main()
		.catch(() => {})
		.finally(() => {
			process.exitCode = 0;
		});
}
