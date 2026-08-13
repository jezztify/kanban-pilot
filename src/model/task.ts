/**
 * Task file schema (PRD §6.3).
 *
 * A task is one markdown file: YAML-ish frontmatter owned by the extension,
 * body sections owned by the human and the agent.
 *
 * The split matters. §6.2 makes the extension the *only* writer of frontmatter,
 * so `updateFrontmatter` rewrites that block and leaves the body byte-for-byte
 * untouched — a malformed section can never cost us a card, and an agent append
 * to `## Log` can never corrupt state.
 *
 * Frontmatter is deliberately flat scalars only. We are its sole author, so a
 * full YAML parser would buy nothing and add a dependency.
 */

/**
 * Seven columns, not six. §12 Q10: the live Framer prototype added a
 * "Validation" stage between In Progress and Done, gated by a human "Validate"
 * click (the same shape as Scoped's "Approve") — resolved in favor of adopting
 * it, since it strengthens the design's core bet (a human reviews before the
 * agent's work is trusted) rather than working against it.
 */
export const COLUMNS = [
	'backlog',
	'refine',
	'scoped',
	'approved',
	'in-progress',
	'validation',
	'done',
] as const;
export type Column = (typeof COLUMNS)[number];

export const COLUMN_LABELS: Record<Column, string> = {
	backlog: 'Backlog',
	refine: 'Refine',
	scoped: 'Scoped',
	approved: 'Approved',
	'in-progress': 'In Progress',
	validation: 'Validation',
	done: 'Done',
};

/** Columns where a run happens, as opposed to where a card rests (§5). */
export const WORKING_COLUMNS: ReadonlySet<Column> = new Set<Column>(['refine', 'in-progress']);

export const STATUSES = ['idle', 'running', 'paused', 'blocked', 'failed'] as const;
export type Status = (typeof STATUSES)[number];

export interface Task {
	id: string;
	title: string;
	state: Column;
	status: Status;
	created?: string;
	updated?: string;
	/** Active run id, or undefined when idle. */
	run?: string;
	/** Derived chat session id (§6.7). */
	chat?: string;
	/**
	 * Copilot's own conversation id, as returned in `metadata.sessionId` on the
	 * task's most recent run. Confirmed stable-within/distinct-between sessions
	 * in M0 — compared on every later run to auto-detect a misroute (§6.9).
	 */
	copilotSessionId?: string;
	/** Hash of `## Scope` as refine wrote it (§6.8). */
	scopeHash?: string;
	/** Set when a misroute may have polluted this session (§6.9). */
	chatResetRequired: boolean;
	/** Git sha of the pre-develop checkpoint (§8.4). */
	checkpoint?: string;
	/** Set when an agent run filed this task itself, rather than a human typing it (§6.12). */
	originTask?: string;
	/** Body sections, keyed by heading text: 'Request', 'Refined', 'Scope', 'Log'. */
	sections: Record<string, string>;
	/** Everything after the frontmatter block, verbatim. */
	body: string;
}

export interface ParsedFile {
	frontmatter: Record<string, string>;
	body: string;
	/** True when no frontmatter block was found — the file is not a task. */
	malformed: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseFile(raw: string): ParsedFile {
	const match = FRONTMATTER.exec(raw);
	if (!match) {
		return { frontmatter: {}, body: raw, malformed: true };
	}

	const frontmatter: Record<string, string> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) {
			continue;
		}
		const colon = trimmed.indexOf(':');
		if (colon === -1) {
			continue;
		}
		const key = trimmed.slice(0, colon).trim();
		// Strip trailing ` # comment`, then surrounding quotes.
		let value = trimmed.slice(colon + 1).replace(/\s+#.*$/, '').trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		frontmatter[key] = value;
	}

	return { frontmatter, body: raw.slice(match[0].length), malformed: false };
}

/** Splits a body into `## Heading` sections. Text before the first heading is dropped. */
export function parseSections(body: string): Record<string, string> {
	const sections: Record<string, string> = {};
	const parts = body.split(/^##\s+(.+)$/m);

	for (let i = 1; i < parts.length; i += 2) {
		sections[parts[i].trim()] = (parts[i + 1] ?? '').trim();
	}
	return sections;
}

function isColumn(value: string): value is Column {
	return (COLUMNS as readonly string[]).includes(value);
}

function isStatus(value: string): value is Status {
	return (STATUSES as readonly string[]).includes(value);
}

/**
 * Builds a Task from raw file content. Returns undefined only when the file has
 * no frontmatter or no id — anything else degrades to a sensible default rather
 * than dropping the card (R4: a bad file should show a repair affordance, never
 * vanish).
 */
export function taskFromRaw(raw: string, fallbackId?: string): Task | undefined {
	const { frontmatter, body, malformed } = parseFile(raw);
	if (malformed) {
		return undefined;
	}

	const id = frontmatter.id || fallbackId;
	if (!id) {
		return undefined;
	}

	const state = frontmatter.state;
	const status = frontmatter.status;

	return {
		id,
		title: frontmatter.title || id,
		state: state && isColumn(state) ? state : 'backlog',
		status: status && isStatus(status) ? status : 'idle',
		created: frontmatter.created || undefined,
		updated: frontmatter.updated || undefined,
		run: frontmatter.run && frontmatter.run !== 'null' ? frontmatter.run : undefined,
		chat: frontmatter.chat || undefined,
		copilotSessionId: frontmatter.copilot_session_id || undefined,
		scopeHash: frontmatter.scope_hash || undefined,
		chatResetRequired: frontmatter.chat_reset_required === 'true',
		checkpoint: frontmatter.checkpoint || undefined,
		originTask: frontmatter.origin_task || undefined,
		sections: parseSections(body),
		body,
	};
}

/** Frontmatter key order, so rewrites produce clean diffs. */
const KEY_ORDER = [
	'id',
	'title',
	'state',
	'status',
	'created',
	'updated',
	'run',
	'chat',
	'copilot_session_id',
	'scope_hash',
	'chat_reset_required',
	'checkpoint',
	'origin_task',
];

function serializeFrontmatter(frontmatter: Record<string, string>): string {
	const keys = [
		...KEY_ORDER.filter((k) => k in frontmatter),
		...Object.keys(frontmatter).filter((k) => !KEY_ORDER.includes(k)),
	];
	const lines = keys.map((k) => `${k}: ${frontmatter[k]}`);
	return `---\n${lines.join('\n')}\n---\n`;
}

/**
 * Rewrites only the frontmatter block, preserving the body exactly. Passing
 * `undefined` or `''` for a key removes it.
 */
export function updateFrontmatter(raw: string, updates: Record<string, string | undefined>): string {
	const { frontmatter, body } = parseFile(raw);

	for (const [key, value] of Object.entries(updates)) {
		if (value === undefined || value === '') {
			delete frontmatter[key];
		} else {
			frontmatter[key] = value;
		}
	}

	return serializeFrontmatter(frontmatter) + body;
}

/**
 * Appends one line to `## Log`, preserving everything else — including any
 * section that comes after it, if a future template ever adds one. `## Log`
 * is the one body section the extension is allowed to write (§6.3's field
 * ownership table), used for the run receipts §6.4 asks it to record
 * (timeouts, missing-receipt reconciliation) alongside the agent's own.
 */
export function appendLogLine(raw: string, line: string): string {
	const heading = /^##\s+Log\s*$/m.exec(raw);
	if (!heading) {
		const sep = raw.endsWith('\n') ? '' : '\n';
		return `${raw}${sep}\n## Log\n${line}\n`;
	}

	const afterHeading = heading.index + heading[0].length;
	const rest = raw.slice(afterHeading);
	const nextHeading = /^##\s+/m.exec(rest);
	const insertAt = nextHeading ? afterHeading + nextHeading.index : raw.length;

	let before = raw.slice(0, insertAt);
	if (!before.endsWith('\n')) {
		before += '\n';
	}
	return before + line + '\n' + raw.slice(insertAt);
}

/** Where an agent-filed task came from (§6.12) — never set for a human-typed one. */
export interface TaskOrigin {
	taskId: string;
	runId: string;
	note: string;
}

export interface NewTaskOptions {
	/** The human-typed description (§6.16's New Task modal); falls back to the title if blank. Ignored when `origin` is set. */
	request?: string;
	origin?: TaskOrigin;
	now?: Date;
}

/** Renders a brand-new task file (§6.3, §6.12, §6.16). */
export function newTaskFile(id: string, title: string, options: NewTaskOptions = {}): string {
	const { request, origin, now = new Date() } = options;
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
	const frontmatter = serializeFrontmatter({
		id,
		title,
		state: 'backlog',
		status: 'idle',
		created: stamp,
		updated: stamp,
		chat_reset_required: 'false',
		...(origin ? { origin_task: origin.taskId } : {}),
	});

	const requestBody = origin
		? `${origin.note}\n\n_Filed automatically by ${origin.taskId}'s run ${origin.runId}._`
		: request?.trim() || title;

	return (
		frontmatter +
		`\n## Request\n${requestBody}\n\n## Refined\n\n## Scope\n\n## Log\n`
	);
}
