import * as vscode from 'vscode';
import { appendLogLine, COLUMNS, Column, Task, TaskOrigin, newTaskFile, taskFromRaw, updateFrontmatter } from './task';

/**
 * Reads and writes the task folder (PRD §6.3, §8.1).
 *
 * Disk is authoritative (R5). The store never caches a mutable copy: every
 * `readAll` goes to the filesystem, so hand-editing a task file and clicking a
 * card are the same operation as far as the board is concerned (G5).
 */

export interface BoardSnapshot {
	columns: { id: Column; tasks: Task[] }[];
	/** Files that parsed badly — surfaced rather than silently dropped (R4). */
	malformed: string[];
}

const TASK_FILE = /^(TASK-\d+)\.md$/;

export class TaskStore {
	constructor(private readonly tasksDir: vscode.Uri) {}

	static forWorkspace(folder: vscode.WorkspaceFolder, subPath = '.kanban-pilot/tasks'): TaskStore {
		return new TaskStore(vscode.Uri.joinPath(folder.uri, ...subPath.split('/')));
	}

	get directory(): vscode.Uri {
		return this.tasksDir;
	}

	fileFor(id: string): vscode.Uri {
		return vscode.Uri.joinPath(this.tasksDir, `${id}.md`);
	}

	async ensureDirectory(): Promise<void> {
		await vscode.workspace.fs.createDirectory(this.tasksDir);
	}

	private async listFiles(): Promise<string[]> {
		try {
			const entries = await vscode.workspace.fs.readDirectory(this.tasksDir);
			return entries
				.filter(([name, type]) => type === vscode.FileType.File && TASK_FILE.test(name))
				.map(([name]) => name)
				.sort();
		} catch {
			return [];
		}
	}

	async readAll(): Promise<{ tasks: Task[]; malformed: string[] }> {
		const tasks: Task[] = [];
		const malformed: string[] = [];

		for (const name of await this.listFiles()) {
			const uri = vscode.Uri.joinPath(this.tasksDir, name);
			let raw: string;
			try {
				raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			} catch {
				malformed.push(name);
				continue;
			}

			const task = taskFromRaw(raw, TASK_FILE.exec(name)?.[1]);
			if (task) {
				tasks.push(task);
			} else {
				malformed.push(name);
			}
		}

		return { tasks, malformed };
	}

	/** The board as the webview consumes it: every column present, even when empty. */
	async snapshot(): Promise<BoardSnapshot> {
		const { tasks, malformed } = await this.readAll();

		return {
			columns: COLUMNS.map((id) => ({
				id,
				tasks: tasks.filter((t) => t.state === id),
			})),
			malformed,
		};
	}

	/**
	 * Next free id. Scans for `max + 1` rather than keeping a counter, so two
	 * branches that each add tasks merge without fighting over a registry file
	 * (§8.1). Gaps are expected and harmless.
	 */
	async nextId(): Promise<string> {
		const numbers = (await this.listFiles())
			.map((name) => Number(TASK_FILE.exec(name)?.[1].slice(5)))
			.filter((n) => Number.isFinite(n));

		const next = numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
		return `TASK-${String(next).padStart(3, '0')}`;
	}

	/**
	 * Atomic write: temp file then rename (R5). A crash mid-write leaves the
	 * previous file intact rather than a truncated one the parser would reject.
	 */
	private async writeAtomic(uri: vscode.Uri, content: string): Promise<void> {
		const temp = uri.with({ path: `${uri.path}.tmp` });
		await vscode.workspace.fs.writeFile(temp, Buffer.from(content, 'utf8'));
		await vscode.workspace.fs.rename(temp, uri, { overwrite: true });
	}

	async create(title: string, options?: { request?: string; origin?: TaskOrigin }): Promise<Task> {
		await this.ensureDirectory();
		const id = await this.nextId();
		const content = newTaskFile(id, title, { request: options?.request, origin: options?.origin });
		await this.writeAtomic(this.fileFor(id), content);

		const task = taskFromRaw(content, id);
		if (!task) {
			throw new Error(`Generated an unparseable task file for ${id}`);
		}
		return task;
	}

	/**
	 * Applies frontmatter changes, leaving the body untouched (§6.2). Always
	 * bumps `updated`.
	 */
	async patch(id: string, updates: Record<string, string | undefined>): Promise<void> {
		const uri = this.fileFor(id);
		const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

		const next = updateFrontmatter(raw, {
			...updates,
			updated: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
		});

		await this.writeAtomic(uri, next);
	}

	/**
	 * Appends one line to `## Log` (§6.3, §6.4) — used for the extension's own
	 * reconciliation receipts (timeouts, missing-receipt window-reload notes),
	 * alongside the agent's own append-only writes to the same section.
	 */
	async appendLog(id: string, line: string): Promise<void> {
		const uri = this.fileFor(id);
		const raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		await this.writeAtomic(uri, appendLogLine(raw, line));
	}

	/** Fires on any change under the task folder. Disk is the source of truth. */
	watch(onChange: () => void): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(this.tasksDir, '*.md'),
		);

		watcher.onDidCreate(onChange);
		watcher.onDidChange(onChange);
		watcher.onDidDelete(onChange);

		return watcher;
	}
}
