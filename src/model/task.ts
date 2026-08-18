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

/** The only durable classifications a task may have. */
export const TASK_TYPES = ['feature', 'bug'] as const;
export type TaskType = (typeof TASK_TYPES)[number];

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
	feature: 'Feature',
	bug: 'Bug',
};

export function isTaskType(value: unknown): value is TaskType {
	return typeof value === 'string' && (TASK_TYPES as readonly string[]).includes(value);
}

/** Missing and invalid legacy values are intentionally normalised to Feature. */
export function normalizeTaskType(value: unknown): TaskType {
	return isTaskType(value) ? value : 'feature';
}

export interface Task {
	/** Stable workspace-local task-set identity; legacy files resolve to Default. */
	setId: string;
	id: string;
	title: string;
	type: TaskType;
	state: Column;
	status: Status;
	created?: string;
	updated?: string;
	/** Active run id, or undefined when idle. */
	run?: string;
	/** Optional within-column ordering position owned by the extension. */
	position?: number;
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

/** User-editable task content exposed by the board detail editor. */
export interface EditableTaskContent {
	title: string;
	request: string;
	refined: string;
	scope: string;
}

/** The same title limit used by the New Task webview input. */
export const TASK_TITLE_MAX_LENGTH = 200;

export interface ParsedFile {
	frontmatter: Record<string, string>;
	body: string;
	/** True when no frontmatter block was found — the file is not a task. */
	malformed: boolean;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseFrontmatterValue(rawValue: string): string {
	const trimmed = rawValue.trim();
	const doubleQuoted = /^"((?:\\.|[^"\\])*)"(?:\s+#.*)?$/.exec(trimmed);
	if (doubleQuoted) {
		try {
			return JSON.parse(`"${doubleQuoted[1]}"`);
		} catch {
			return doubleQuoted[1];
		}
	}

	const singleQuoted = /^'((?:''|[^'])*)'(?:\s+#.*)?$/.exec(trimmed);
	if (singleQuoted) {
		return singleQuoted[1].replace(/''/g, "'");
	}

	return trimmed.replace(/\s+#.*$/, '').trim();
}

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
		// Support quoted values before stripping trailing ` # comments`, so a
		// title such as `Fix #123` survives a serialize/parse round trip.
		const value = parseFrontmatterValue(trimmed.slice(colon + 1));
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

/** Positions are non-negative finite numbers; missing/invalid values use the legacy fallback order. */
export function isValidTaskPosition(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseTaskPosition(value: string | undefined): number | undefined {
	if (!value?.trim()) {
		return undefined;
	}

	const parsed = Number(value);
	return isValidTaskPosition(parsed) ? parsed : undefined;
}

/**
 * Builds a Task from raw file content. Returns undefined only when the file has
 * no frontmatter or no id — anything else degrades to a sensible default rather
 * than dropping the card (R4: a bad file should show a repair affordance, never
 * vanish).
 */
export function taskFromRaw(raw: string, fallbackId?: string, setId = 'default'): Task | undefined {
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
		setId,
		id,
		title: frontmatter.title || id,
		type: normalizeTaskType(frontmatter.type),
		state: state && isColumn(state) ? state : 'backlog',
		status: status && isStatus(status) ? status : 'idle',
		created: frontmatter.created || undefined,
		updated: frontmatter.updated || undefined,
		run: frontmatter.run && frontmatter.run !== 'null' ? frontmatter.run : undefined,
		position: parseTaskPosition(frontmatter.position),
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
	'type',
	'state',
	'status',
	'position',
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
	const lines = keys.map((k) => `${k}: ${serializeFrontmatterValue(frontmatter[k])}`);
	return `---\n${lines.join('\n')}\n---\n`;
}

function serializeFrontmatterValue(value: string): string {
	const needsQuoting =
		value !== value.trim() ||
		/\s+#/.test(value) ||
		/^['"]|['"]$/.test(value);
	return needsQuoting ? JSON.stringify(value) : value;
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

const EDITABLE_SECTION_NAMES = ['Request', 'Refined', 'Scope'] as const;
type EditableSectionName = (typeof EDITABLE_SECTION_NAMES)[number];

/** Validates and normalizes the content accepted by the task editor. */
export function normalizeEditableTaskContent(value: unknown): EditableTaskContent {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Task edit payload must contain title, Request, Refined, and Scope text.');
	}

	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.title !== 'string' ||
		typeof candidate.request !== 'string' ||
		typeof candidate.refined !== 'string' ||
		typeof candidate.scope !== 'string'
	) {
		throw new Error('Task edit payload must contain title, Request, Refined, and Scope text.');
	}

	const title = candidate.title.trim();
	if (!title) {
		throw new Error('Task title cannot be blank.');
	}
	if (title.length > TASK_TITLE_MAX_LENGTH) {
		throw new Error(`Task title must be ${TASK_TITLE_MAX_LENGTH} characters or fewer.`);
	}
	if (/[\r\n]/.test(title)) {
		throw new Error('Task title cannot contain line breaks.');
	}

	return {
		title,
		request: candidate.request,
		refined: candidate.refined,
		scope: candidate.scope,
	};
}

function replaceEditableSection(
	segment: string,
	value: string,
	newline: string,
	hasNextHeading: boolean,
): string {
	const leading = /^(?:\r\n|\n)/.exec(segment)?.[0] ?? newline;
	const trailing = /(?:(?:\r\n)|\n)+$/.exec(segment)?.[0] ?? (hasNextHeading ? newline : '');
	return leading + value + trailing;
}

/**
 * Rewrites the title and the three editable body sections while leaving every
 * other body section, including the append-only Log, untouched.
 */
export function updateEditableTaskContent(raw: string, value: unknown): string {
	const content = normalizeEditableTaskContent(value);
	const parsed = parseFile(raw);
	if (parsed.malformed) {
		throw new Error('Cannot edit a task file without valid frontmatter.');
	}

	const newline = parsed.body.includes('\r\n') ? '\r\n' : '\n';
	const headingPattern = /^##[ \t]+([^\r\n]+?)[ \t]*\r?$/gm;
	const headings = [...parsed.body.matchAll(headingPattern)];
	const replacements: Record<EditableSectionName, string> = {
		Request: content.request,
		Refined: content.refined,
		Scope: content.scope,
	};
	const found = new Set<EditableSectionName>();
	let body = '';
	let cursor = 0;

	for (let index = 0; index < headings.length; index++) {
		const heading = headings[index];
		const start = heading.index ?? cursor;
		const headingEnd = start + heading[0].length;
		const end = headings[index + 1]?.index ?? parsed.body.length;
		const name = heading[1].trim() as EditableSectionName;
		body += parsed.body.slice(cursor, headingEnd);
		if (Object.prototype.hasOwnProperty.call(replacements, name)) {
			body += replaceEditableSection(parsed.body.slice(headingEnd, end), replacements[name], newline, end < parsed.body.length);
			found.add(name);
		} else {
			body += parsed.body.slice(headingEnd, end);
		}
		cursor = end;
	}
	body += parsed.body.slice(cursor);

	const missing = EDITABLE_SECTION_NAMES.filter((name) => !found.has(name));
	if (missing.length) {
		const sections = missing
			.map((name) => `## ${name}${newline}${replacements[name]}`)
			.join(`${newline}${newline}`);
		const logHeading = /^##[ \t]+Log[ \t]*\r?$/m.exec(body);
		if (logHeading?.index !== undefined) {
			const before = body.slice(0, logHeading.index);
			const after = body.slice(logHeading.index);
			const separator = before.endsWith(newline) ? newline : `${newline}${newline}`;
			body = `${before}${separator}${sections}${newline}${newline}${after}`;
		} else {
			const separator = body.endsWith(newline) ? newline : `${newline}${newline}`;
			body = `${body}${separator}${sections}${newline}`;
		}
	}

	return serializeFrontmatter({ ...parsed.frontmatter, title: content.title }) + body;
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
	/** Canonical task classification; legacy callers resolve to Feature. */
	type?: TaskType;
	/** The human-typed description (§6.16's New Task modal); falls back to the title if blank. Ignored when `origin` is set. */
	request?: string;
	origin?: TaskOrigin;
	/** Extension-owned initial within-column position, normally supplied by TaskStore. */
	position?: number;
	now?: Date;
}

/** Renders a brand-new task file (§6.3, §6.12, §6.16). */
export function newTaskFile(id: string, title: string, options?: NewTaskOptions): string;
export function newTaskFile(id: string, title: string, type: TaskType, options?: NewTaskOptions): string;
export function newTaskFile(
	id: string,
	title: string,
	typeOrOptions: TaskType | NewTaskOptions = {},
	suppliedOptions: NewTaskOptions = {},
): string {
	const options = typeof typeOrOptions === 'string'
		? { ...suppliedOptions, type: typeOrOptions }
		: typeOrOptions;
	const { request, origin, position, now = new Date() } = options;
	const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
	const frontmatter = serializeFrontmatter({
		id,
		title,
		type: normalizeTaskType(options.type),
		state: 'backlog',
		status: 'idle',
		...(isValidTaskPosition(position) ? { position: String(position) } : {}),
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
