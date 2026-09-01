/**
 * Measurement harness for TASK-009 (docs/research/copilot-response-streaming-spike.md).
 *
 * Copilot Chat appends a structured event log per session to
 * `<workspaceStorage>/<ws>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl`.
 * Every line carries its own `timestamp`, stamped when the event *occurred*
 * rather than when the buffer was flushed, so the flush lag a tailing consumer
 * would experience is `observed append time - entry timestamp` — measurable from
 * the file alone, with no panel instrumentation and no human stopwatch.
 *
 * This is deliberately a standalone Node script rather than an `src/spike` probe:
 * the transcript is a plain file, so the watcher runs *beside* a live VS Code
 * while a stage runs from the board, and its logic stays testable without
 * launching an extension host.
 *
 * It records structure only — event `type`, the entry's `timestamp`, observation
 * time, byte offsets, and counts. The `data` payload carrying prompts, replies,
 * and tool arguments is read to find the line boundary and then discarded, so the
 * output is safe to paste into a findings document.
 *
 * Usage:
 *   node scripts/watch-transcript.mjs <transcriptsDir> [--session <id>]
 *                                     [--interval <ms>] [--json <outFile>]
 */

import { readdir, open, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fields kept from a transcript line. Everything else, `data` included, is dropped. */
const RETAINED_ENTRY_FIELDS = Object.freeze(['type', 'timestamp']);

/** How often the directory is polled, in milliseconds, when not overridden. */
export const DEFAULT_POLL_INTERVAL_MS = 100;

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Tracks one file's append stream. Feed it the bytes that appeared since the last
 * read; it returns the complete entries in them and remembers any trailing
 * fragment for the next read.
 *
 * A fragment is the interesting failure mode for a tailing consumer: it means a
 * reader can observe a partially written line and must not try to parse it.
 */
export class FileTail {
	constructor(name, offset = 0) {
		this.name = name;
		this.offset = offset;
		this.pending = '';
		this.fragmentsObserved = 0;
		this.fragmentsCompleted = 0;
		this.malformed = 0;
	}

	/**
	 * @param {string} chunk bytes appended since the previous read, as utf-8
	 * @param {number} observedAt wall-clock ms when the chunk was read
	 * @returns {Array<{file: string, observedAt: number, offset: number, type: string|undefined, timestamp: string|undefined, lagMs: number|undefined}>}
	 */
	consume(chunk, observedAt) {
		const hadFragment = this.pending.length > 0;
		const combined = this.pending + chunk;
		const parts = combined.split('\n');
		this.pending = parts.pop() ?? '';
		if (hadFragment && parts.length > 0) {
			this.fragmentsCompleted += 1;
		}
		if (this.pending.length > 0) {
			this.fragmentsObserved += 1;
		}
		this.offset += Buffer.byteLength(chunk, 'utf8');

		const entries = [];
		for (const line of parts) {
			if (line.trim().length === 0) {
				continue;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch {
				this.malformed += 1;
				continue;
			}
			entries.push(projectEntry(this.name, parsed, observedAt));
		}
		return entries;
	}
}

/**
 * Reduces one parsed transcript line to the structural observation this harness
 * keeps. Content never leaves this function.
 */
export function projectEntry(file, parsed, observedAt) {
	const entry = {};
	for (const field of RETAINED_ENTRY_FIELDS) {
		entry[field] = typeof parsed?.[field] === 'string' ? parsed[field] : undefined;
	}
	const stamped = entry.timestamp ? Date.parse(entry.timestamp) : Number.NaN;
	return {
		file,
		observedAt,
		type: entry.type,
		timestamp: entry.timestamp,
		lagMs: Number.isFinite(stamped) ? observedAt - stamped : undefined,
	};
}

/** Median of a numeric array, without mutating the caller's copy. */
export function median(values) {
	if (values.length === 0) {
		return undefined;
	}
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * Builds the report pasted into the findings document. Every field is a count, a
 * duration, a timestamp, or an event type name.
 */
export function summarise(observations, tails) {
	const lags = observations.map((o) => o.lagMs).filter((lag) => Number.isFinite(lag));
	const countsByType = {};
	for (const observation of observations) {
		const key = observation.type ?? '(untyped)';
		countsByType[key] = (countsByType[key] ?? 0) + 1;
	}
	const stamps = observations.map((o) => o.timestamp).filter(Boolean).sort();

	return {
		entries: observations.length,
		filesGrown: [...new Set(observations.map((o) => o.file))].sort(),
		countsByType,
		lagMs: {
			samples: lags.length,
			min: lags.length ? Math.min(...lags) : undefined,
			median: median(lags),
			max: lags.length ? Math.max(...lags) : undefined,
		},
		firstEntryAt: stamps[0],
		lastEntryAt: stamps[stamps.length - 1],
		fragmentsObserved: tails.reduce((total, tail) => total + tail.fragmentsObserved, 0),
		fragmentsCompleted: tails.reduce((total, tail) => total + tail.fragmentsCompleted, 0),
		malformedLines: tails.reduce((total, tail) => total + tail.malformed, 0),
		bytesAppended: tails.reduce((total, tail) => total + tail.offset - (tail.baseline ?? 0), 0),
	};
}

/**
 * Watches a transcripts directory until `stop()` is called.
 *
 * The directory rather than a single file is watched on purpose: a task's first
 * run has no `copilot_session_id` yet — it is harvested from the turn's terminal
 * result — so the file name is not knowable in advance and must be correlated
 * afterwards.
 */
export function createWatcher(directory, { sessionId, intervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
	/** @type {Map<string, FileTail>} */
	const tails = new Map();
	/** @type {Array<object>} */
	const observations = [];
	let timer;
	let polling = false;
	let baselined = false;

	async function readAppended(name) {
		const path = join(directory, name);
		let size;
		try {
			({ size } = await stat(path));
		} catch {
			return;
		}

		let tail = tails.get(name);
		if (!tail) {
			// A file that already existed when watching started is joined at its end:
			// only what is appended during the observation window is measurable. A file
			// that appears *later* is a session starting under observation, so it is
			// read from byte zero — otherwise its `session.start` line would be lost to
			// whichever poll happened to notice the file first.
			const from = baselined ? 0 : size;
			tail = new FileTail(name, from);
			tail.baseline = from;
			tails.set(name, tail);
			if (!baselined) {
				return;
			}
		}
		if (size <= tail.offset) {
			return;
		}

		const handle = await open(path, 'r');
		try {
			const length = size - tail.offset;
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, tail.offset);
			const observedAt = Date.now();
			observations.push(...tail.consume(buffer.toString('utf8'), observedAt));
		} finally {
			await handle.close();
		}
	}

	async function poll() {
		if (polling) {
			return;
		}
		polling = true;
		try {
			const names = (await readdir(directory)).filter(
				(name) => name.endsWith('.jsonl') && (!sessionId || name === `${sessionId}.jsonl`),
			);
			for (const name of names) {
				await readAppended(name);
			}
			baselined = true;
		} catch {
			// A directory that does not exist yet is a valid state to wait in.
		} finally {
			polling = false;
		}
	}

	return {
		async start() {
			await poll();
			timer = setInterval(() => void poll(), intervalMs);
			timer.unref?.();
		},
		async stop() {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
			await poll();
			return summarise(observations, [...tails.values()]);
		},
		get observations() {
			return observations;
		},
	};
}

function parseArgs(argv) {
	const [directory, ...rest] = argv;
	if (!directory || directory.startsWith('-')) {
		throw new Error(
			'Usage: node scripts/watch-transcript.mjs <transcriptsDir> [--session <id>] [--interval <ms>] [--json <outFile>]',
		);
	}
	const options = { directory };
	for (let i = 0; i < rest.length; i += 2) {
		const flag = rest[i];
		const value = rest[i + 1];
		if (value === undefined) {
			throw new Error(`Missing value for ${flag}.`);
		}
		if (flag === '--session') {
			options.sessionId = value;
		} else if (flag === '--interval') {
			options.intervalMs = Number.parseInt(value, 10);
			if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
				throw new Error(`Invalid --interval "${value}".`);
			}
		} else if (flag === '--json') {
			options.jsonPath = value;
		} else {
			throw new Error(`Unknown option "${flag}".`);
		}
	}
	return options;
}

async function main(argv) {
	const { directory, sessionId, intervalMs, jsonPath } = parseArgs(argv);
	const watcher = createWatcher(directory, { sessionId, intervalMs });

	let finished = false;
	const finish = async () => {
		if (finished) {
			return;
		}
		finished = true;
		const summary = await watcher.stop();
		const report = { directory, sessionId, stoppedAt: new Date().toISOString(), summary };
		if (jsonPath) {
			await writeFile(jsonPath, `${JSON.stringify(report, undefined, 2)}\n`, 'utf8');
		}
		process.stdout.write(`${JSON.stringify(report, undefined, 2)}\n`);
	};

	process.on('SIGINT', () => void finish().then(() => process.exit(0)));
	process.on('SIGTERM', () => void finish().then(() => process.exit(0)));

	await watcher.start();
	process.stderr.write(
		`Watching ${directory}${sessionId ? ` for session ${sessionId}` : ''}. Run the stage now; press Ctrl+C when the turn finishes.\n`,
	);
}

const invokedDirectly = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (invokedDirectly) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`${formatError(error)}\n`);
		process.exitCode = 1;
	});
}
