import * as vscode from 'vscode';
import { AgentNameOverrides, NameableStage, resolveAgentName } from '../chat/agentNames';
import { RunManager } from '../chat/runManager';
import { COLUMNS, COLUMN_LABELS, Column, Status, Task } from '../model/task';
import { BoardSnapshot, TaskStore } from '../model/taskStore';
import { deleteTask } from './actions';
import { TASK_ACTIONS, TaskAction } from './stateMachine';

/**
 * The board webview (PRD §6.11).
 *
 * A pure projection: it holds no authoritative state and performs no transition
 * logic itself — mutations go through `RunManager.handleAction` (§7's shared
 * entry point, also used by the palette commands) or `deleteTask`, and every
 * render is a fresh read of disk (G5, R5).
 *
 * Visual system lifted directly from the Framer prototype
 * (https://flourished-costs-247065.framer.app/) via Chrome DevTools inspection
 * on 2026-08-13: card/column radii, shadow, spacing, and type scale match the
 * live site's computed styles. Surface colors are re-derived from `--vscode-*`
 * tokens rather than the prototype's literal light-mode hexes, per §6.11's
 * requirement that the board track the user's theme — a literal color copy
 * would look broken in dark mode. Accent colors (column dots, primary button)
 * are the prototype's exact values, since those read as brand identity rather
 * than editor chrome.
 *
 * Re-inspected 2026-08-13 for exact replication (§12 Q10, §13): the prototype
 * had moved on from 6 columns to 7 (a "Validation" gate before Done) and
 * gained a static per-column `Agent` badge. Both are adopted here — see
 * `task.ts`'s `COLUMNS` comment and `COLUMN_STAGE`/`toView` below. As of the
 * M3 stage-wiring pass, the badge for refine/in-progress/validation is no
 * longer just cosmetic: it's `resolveAgentName`'s result for that column's
 * stage — the same call `RunManager` makes to open every prompt with
 * `@{{agentName}}` — so the board always shows exactly who's about to be
 * asked to do the work. §12 Q10's per-column *configurability* now exists
 * too: the edit icon opens `agentNameBackdrop`, writing straight to
 * `kanbanPilot.chat.agentNames` (still just persona framing, not a real
 * `contributes.chatParticipants` mention — see `agentNames.ts`'s doc).
 *
 * Also confirmed on re-inspection: the prototype renders exactly one button
 * per card. §5.2's "secondary" actions (Scoped's redo-scope Refine, Done's
 * Reopen) are real and still fully wired — just relocated to the task detail
 * modal (below) and the command palette, rather than crowding a second
 * button onto the card.
 *
 * The task detail modal itself (opened on card click) was re-inspected via
 * Chrome DevTools on 2026-08-13 and rebuilt to match: a centered dialog over
 * a dimming backdrop, not the docked sidebar it started as. Shape, spacing,
 * and type scale are the prototype's exact computed values; the indigo
 * accent on status text and the close glyph is kept literal for the same
 * reason the column dots are (brand identity, not editor chrome). The
 * prototype's own modal content is a generic Markdown+Mermaid renderer
 * (fallback placeholder text, not real task data); this board's modal
 * carries the same chrome but real content — Request/Refined/Scope/Log.
 */

/** Column accent dots, exact values from the prototype (not theme-derived — see module doc). */
const COLUMN_DOT: Record<Column, string> = {
	backlog: '#9a9aa0',
	refine: '#9a9aa0',
	scoped: '#c99a2e',
	approved: '#4f6fe0',
	'in-progress': '#8b5cf6',
	validation: '#c99a2e',
	done: '#34a853',
};

/**
 * Which stage — if any — runs in each column, and so which columns' Agent
 * badge is real (vs. the static `None` shown elsewhere) and editable.
 */
const COLUMN_STAGE: Partial<Record<Column, NameableStage>> = {
	refine: 'refine',
	'in-progress': 'develop',
	validation: 'validate',
};

/** Per-column agent badge, resolved against the current `chat.agentNames` overrides (§12 Q10). */
function agentLabelFor(column: Column, overrides: AgentNameOverrides): string {
	const stage = COLUMN_STAGE[column];
	return stage ? resolveAgentName(stage, overrides) : 'None';
}

/**
 * Primary card action per §5.2.
 *
 * Note the `in-progress` + `idle` case: a card can rest in a working column with
 * no run in flight — a window reload loses the `blockOnResponse` await (§6.4),
 * and reconciliation parks the card rather than inventing a result. `Stop` would
 * be meaningless there, so it resumes instead.
 */
export function primaryAction(state: Column, status: Status): TaskAction | undefined {
	if (state === 'done') {
		return undefined;
	}
	if (status === 'running') {
		return 'stop';
	}

	switch (state) {
		case 'backlog':
			return 'accept';
		case 'refine':
			return 'refine';
		case 'scoped':
			return 'approve';
		case 'approved':
			return 'develop';
		case 'in-progress':
			return 'continue';
		case 'validation':
			return 'validate';
	}
}

/**
 * §6.14: mirrors `stateMachine.ts`'s `split` rule exactly, so the icon only
 * ever shows where the click would actually be legal — this is display logic
 * only, `invokeTaskAction` is still the real gate.
 */
function canSplit(state: Column, status: Status): boolean {
	return (
		(state === 'backlog' && status === 'idle') ||
		(state === 'refine' && (status === 'idle' || status === 'blocked' || status === 'failed')) ||
		(state === 'scoped' && status === 'idle')
	);
}

/**
 * Secondary action per §5.2 — only Scoped (redo scope) and Done (reopen) carry
 * one. Not rendered on the card face (the prototype shows exactly one button
 * per card); surfaced in the detail panel instead — see module doc.
 */
function secondaryAction(state: Column): TaskAction | undefined {
	if (state === 'scoped') {
		return 'refine';
	}
	if (state === 'done') {
		return 'reopen';
	}
	return undefined;
}

const ACTION_LABELS: Record<TaskAction, string> = {
	accept: 'Accept',
	refine: 'Refine',
	split: 'Split',
	approve: 'Approve',
	develop: 'Develop',
	continue: 'Continue',
	stop: 'Stop',
	validate: 'Validate',
	reopen: 'Reopen',
};

interface InMessage {
	type?: string;
	taskId?: string;
  destination?: unknown;
	action?: string;
	title?: string;
	description?: string;
	key?: string;
	value?: string;
	stage?: string;
}

/**
 * §6.15's four gate settings, surfaced as switches in the board header rather
 * than left settings.json-only. `key` is the short id used over the wire and
 * in the UI; `setting` is the actual `kanbanPilot.*` id `RunManager.readConfig`
 * reads. Labels/descriptions are trimmed restatements of the package.json
 * descriptions — kept in sync by hand since there's no shared source.
 */
const GATES: { key: string; setting: string; label: string; description: string }[] = [
	{
		key: 'backlogToRefine',
		setting: 'gates.backlogToRefine',
		label: 'Backlog → Refine',
		description: 'Accept a new task and launch its refine run automatically.',
	},
	{
		key: 'scopedToApproved',
		setting: 'gates.scopedToApproved',
		label: 'Scoped → Approved',
		description: 'Approve a freshly-scoped task into the ready queue automatically.',
	},
	{
		key: 'approvedToInProgress',
		setting: 'gates.approvedToInProgress',
		label: 'Approved → In Progress',
		description: 'Start development on the next Approved task once nothing else is running.',
	},
	{
		key: 'validationAutoStart',
		setting: 'gates.validationAutoStart',
		label: 'Validation auto-start',
		description: 'Launch Validate the moment a task lands in Validation.',
	},
];

function isGateKey(value: unknown): value is string {
	return typeof value === 'string' && GATES.some((g) => g.key === value);
}

function isNameableStage(value: unknown): value is NameableStage {
	return value === 'refine' || value === 'develop' || value === 'validate';
}

export class BoardPanel {
	public static readonly viewType = 'kanbanPilot.board';
	private static current: BoardPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private selectedTaskId: string | undefined;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
		private readonly store: TaskStore,
		private readonly runManager: RunManager,
	) {
		this.panel.webview.options = { enableScripts: true };
		this.panel.webview.html = this.html();

		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((message: InMessage) => this.onMessage(message)),
			// Disk is authoritative — any change re-reads and re-pushes (G5, R5).
			this.store.watch(() => void this.pushAll()),
			// Picks up a hand-edited settings.json too, not just the board's own toggle.
			vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration('kanbanPilot.gates')) {
					void this.pushGates();
				}
				if (e.affectsConfiguration('kanbanPilot.chat.agentNames')) {
					void this.pushBoard();
				}
			}),
			this.panel.onDidDispose(() => this.dispose()),
		);
	}

	static show(store: TaskStore, runManager: RunManager, column = vscode.ViewColumn.One): BoardPanel {
		if (BoardPanel.current) {
			BoardPanel.current.panel.reveal(column);
			void BoardPanel.current.pushAll();
			return BoardPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(BoardPanel.viewType, 'Kanban Pilot', column, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});

		BoardPanel.current = new BoardPanel(panel, store, runManager);
		return BoardPanel.current;
	}

	private async onMessage(message: InMessage): Promise<void> {
		switch (message.type) {
			case 'board/ready':
				await this.pushAll();
				await this.pushGates();
				return;

			case 'task/open':
				if (message.taskId) {
					await vscode.window.showTextDocument(this.store.fileFor(message.taskId), {
						viewColumn: vscode.ViewColumn.Beside,
						preview: true,
					});
				}
				return;

      case 'task/move':
        if (message.taskId) {
          await this.runManager.moveTask(message.taskId, message.destination);
        }
        return;

			case 'task/select':
				this.selectedTaskId = message.taskId;
				await this.pushDetail();
				if (message.taskId) {
					// §6.10: off by default — selecting a card only opens the detail
					// pane. Docking the chat is an explicit act (the pane's "Open
					// Chat" button, or a stage run's own open+inject), not a side
					// effect of browsing cards.
					void this.runManager.dockTaskChat(message.taskId, { onSelect: true });
				}
				return;

			case 'task/openChat':
				if (message.taskId) {
					void this.runManager.dockTaskChat(message.taskId, { onSelect: false });
				}
				return;

			case 'task/deselect':
				this.selectedTaskId = undefined;
				await this.pushDetail();
				return;

			case 'task/create': {
				const title = message.title?.trim();
				if (!title) {
					return;
				}
				const task = await this.store.create(title, { request: message.description?.trim() });
				this.selectedTaskId = task.id;
				// The watcher fires from this same write, but selection changed
				// independently of disk state, so push explicitly rather than wait.
				await this.pushAll();
				return;
			}

			case 'task/delete': {
				if (!message.taskId) {
					return;
				}
				const { tasks } = await this.store.readAll();
				const task = tasks.find((t) => t.id === message.taskId);
				if (!task) {
					return;
				}
				const deleted = await deleteTask(this.store, task.id, task.title);
				if (deleted && this.selectedTaskId === task.id) {
					this.selectedTaskId = undefined;
				}
				// deleteTask's own fs.delete triggers the watcher; nothing further to do.
				return;
			}

			case 'action/invoke': {
				if (!message.taskId || !isTaskAction(message.action)) {
					return;
				}
				await this.runManager.handleAction(message.taskId, message.action);
				return;
			}

			case 'gates/set': {
				if (!isGateKey(message.key) || (message.value !== 'manual' && message.value !== 'auto')) {
					return;
				}
				const gate = GATES.find((g) => g.key === message.key)!;
				await vscode.workspace
					.getConfiguration('kanbanPilot')
					.update(gate.setting, message.value, vscode.ConfigurationTarget.Workspace);
				// onDidChangeConfiguration already re-pushes gate state; applying
				// immediately (rather than waiting for the next store change) means
				// flipping a gate to auto acts on whatever's already sitting idle.
				await this.runManager.applyGatePolicies();
				return;
			}

			case 'agentName/set': {
				if (!isNameableStage(message.stage) || typeof message.value !== 'string') {
					return;
				}
				const cfg = vscode.workspace.getConfiguration('kanbanPilot');
				const overrides = { ...cfg.get<AgentNameOverrides>('chat.agentNames', {}) };
				const value = message.value.trim();
				if (value) {
					overrides[message.stage] = value;
				} else {
					delete overrides[message.stage];
				}
				await cfg.update('chat.agentNames', overrides, vscode.ConfigurationTarget.Workspace);
				// onDidChangeConfiguration re-pushes the board with the new label.
				return;
			}
		}
	}

	private async pushAll(): Promise<void> {
		await this.pushBoard();
		await this.pushDetail();
	}

	private async pushBoard(): Promise<void> {
		const snapshot = await this.store.snapshot();
		const agentNames = vscode.workspace
			.getConfiguration('kanbanPilot')
			.get<AgentNameOverrides>('chat.agentNames', {});
		await this.panel.webview.postMessage({
			type: 'board/state',
			snapshot: this.toView(snapshot, agentNames),
			selectedTaskId: this.selectedTaskId,
		});
	}

	private async pushDetail(): Promise<void> {
		if (!this.selectedTaskId) {
			await this.panel.webview.postMessage({ type: 'task/detail', task: null });
			return;
		}

		const { tasks } = await this.store.readAll();
		const task = tasks.find((t) => t.id === this.selectedTaskId);
		if (!task) {
			this.selectedTaskId = undefined;
			await this.panel.webview.postMessage({ type: 'task/detail', task: null });
			return;
		}

		const logLines = (task.sections['Log'] ?? '').trim().split(/\r?\n/).filter(Boolean);

		await this.panel.webview.postMessage({
			type: 'task/detail',
			task: {
				id: task.id,
				title: task.title,
				state: task.state,
				stateLabel: COLUMN_LABELS[task.state],
				status: task.status,
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: task.sections['Scope'] ?? '',
				lastLog: logLines.at(-1) ?? '',
				originTask: task.originTask,
        moveTargets: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id] })),
				// The card face shows one button (primary); this is where the
				// prototype's un-rendered secondary action (§5.2) lives instead.
				secondary: secondaryAction(task.state),
			},
		});
	}

	private async pushGates(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		const gates = Object.fromEntries(GATES.map((g) => [g.key, cfg.get<string>(g.setting, 'manual')]));
		await this.panel.webview.postMessage({ type: 'gates/state', gates });
	}

	private toView(snapshot: BoardSnapshot, agentNames: AgentNameOverrides) {
		return {
			malformed: snapshot.malformed,
			columns: snapshot.columns.map((column) => ({
				id: column.id,
				label: COLUMN_LABELS[column.id],
				dot: COLUMN_DOT[column.id],
				agent: agentLabelFor(column.id, agentNames),
				stage: COLUMN_STAGE[column.id] ?? null,
				count: column.tasks.length,
				cards: column.tasks.map((task: Task) => ({
					id: task.id,
					title: task.title,
					status: task.status,
					primary: primaryAction(task.state, task.status),
					originTask: task.originTask,
					canSplit: canSplit(task.state, task.status),
				})),
			})),
		};
	}

	dispose(): void {
		BoardPanel.current = undefined;
		this.panel.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}

	private html(): string {
		const nonce = Array.from({ length: 32 }, () =>
			'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.charAt(
				Math.floor(Math.random() * 62),
			),
		).join('');

		const csp = [
			"default-src 'none'",
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

    const actionLabelsJson = JSON.stringify(ACTION_LABELS);
		const gatesJson = JSON.stringify(GATES);

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Kanban Pilot</title>
<style nonce="${nonce}">
  /*
   * Tokens below carry the prototype's shape language (radius, shadow depth,
   * spacing scale, type scale) verbatim; surface colors route through
   * --vscode-* so the board matches the editor's theme rather than the
   * prototype's fixed light palette. See module doc for the split.
   */
  :root {
    --kp-radius-column: 14px;
    --kp-radius-card: 12px;
    --kp-radius-button: 7px;
    --kp-radius-primary-button: 10px;
    --kp-shadow-card: 0 2px 8px rgba(0, 0, 0, 0.16);
    --kp-radius-modal: 16px;
    --kp-radius-chip: 6px;
    --kp-radius-modal-close: 8px;
    --kp-shadow-modal: 0 20px 48px rgba(0, 0, 0, 0.16);
    --kp-modal-accent: #4f46e5;
    --kp-gap-board: 10px;
    --kp-pad-page: 16px;
    --kp-pad-header: 16px 24px;
    --kp-pad-column: 12px;
    --kp-pad-card: 10px;
    --kp-gap-card: 8px;
    --kp-column-width: 220px;
  }

  * { box-sizing: border-box; }
  /*
   * Fits the whole app to the panel's viewport, no page-level scroll: body
   * is a flex column the exact height of the viewport; header/warn take
   * their natural height, .layout takes what's left (flex + min-height: 0,
   * the standard escape from flexbox's "min-height: auto" trap, without
   * which a shrinking flex child just overflows its parent instead). Each
   * column then scrolls its own card list internally (.cards) rather than
   * the page growing to fit whichever column has the most cards.
   */
  html, body { height: 100%; }
  body {
    margin: 0;
    display: flex; flex-direction: column;
    overflow: hidden;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }

  header {
    flex: none;
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--kp-pad-header);
    background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  h1 { font-size: 15px; font-weight: 700; margin: 0; letter-spacing: -0.01em; }
  .header-actions { display: flex; align-items: center; gap: 8px; }

  .new-task-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: var(--kp-radius-primary-button);
    padding: 8px 14px; font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .new-task-btn:hover { background: var(--vscode-button-hoverBackground); }

  .gates-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--vscode-editorWidget-background);
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border); border-radius: var(--kp-radius-primary-button);
    padding: 8px 14px; font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer;
  }
  .gates-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }

  /* §6.15's four gate settings, toggled here instead of settings.json-only. */
  .gates-list { display: flex; flex-direction: column; }
  .gate-row {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
    padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .gate-row:last-child { border-bottom: none; }
  .gate-text { min-width: 0; }
  .gate-label { font-size: 13px; font-weight: 600; }
  .gate-desc { font-size: 12px; color: var(--vscode-descriptionForeground); margin-top: 3px; line-height: 1.4; }
  .switch { position: relative; display: inline-flex; width: 34px; height: 20px; flex: none; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
  .switch-track {
    position: absolute; inset: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 999px; transition: background .15s, border-color .15s;
  }
  .switch-thumb {
    position: absolute; top: 2px; left: 2px; width: 14px; height: 14px;
    background: var(--vscode-foreground); border-radius: 50%; transition: transform .15s;
  }
  .switch input:checked + .switch-track { background: var(--kp-modal-accent); border-color: var(--kp-modal-accent); }
  .switch input:checked + .switch-track .switch-thumb { transform: translateX(14px); background: #fff; }
  .switch input:focus-visible + .switch-track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  /*
   * New Task modal (§6.16) — Chrome DevTools inspection of the prototype's
   * own "Create a new task" dialog, 2026-08-14: a distinct, smaller component
   * from the task detail modal (§6.11), not a reuse of it. Shares the same
   * .modal-backdrop/.modal base (shape language, surface-color routing) and
   * .modal-title/.modal-close (kept identical across both modals on purpose
   * — the prototype's own close button used a slightly different chip
   * treatment here, not worth two visual languages for one glyph in this
   * codebase). Everything else — the compact 420px width, the form fields,
   * the chip/accent button pair — is this modal's own.
   */
  .new-task-modal { width: min(420px, 100vw - 32px); max-height: none; padding: 24px; gap: 20px; }
  .new-task-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .new-task-head-text { min-width: 0; }
  .new-task-subtitle { font-size: 13px; color: var(--vscode-descriptionForeground); line-height: 1.35; margin-top: 4px; }
  .new-task-form { display: flex; flex-direction: column; gap: 14px; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field-label { font-size: 12px; font-weight: 600; }
  .field-input, .field-textarea {
    font-family: inherit; font-size: 14px; color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 10px; padding: 10px 12px;
  }
  .field-textarea { resize: vertical; min-height: 90px; }
  .field-input::placeholder, .field-textarea::placeholder { color: var(--vscode-descriptionForeground); }
  .new-task-actions { display: flex; justify-content: flex-end; gap: 12px; }
  .btn-chip {
    font-family: inherit; font-size: 12px; border-radius: 10px; padding: 10px 14px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
    cursor: pointer;
  }
  .btn-chip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
  .btn-modal-primary {
    font-family: inherit; font-size: 12px; font-weight: 600; border-radius: 10px; padding: 10px 16px;
    border: none; background: var(--kp-modal-accent); color: #fff; cursor: pointer;
  }
  .btn-modal-primary:hover { filter: brightness(1.08); }

  #warn {
    flex: none;
    margin: var(--kp-pad-page) var(--kp-pad-page) 0;
  }
  .warn-banner {
    padding: 8px 10px; border-radius: 4px;
    background: var(--vscode-inputValidation-warningBackground);
    border: 1px solid var(--vscode-inputValidation-warningBorder);
    font-size: 0.8rem;
  }

  .layout {
    display: flex; gap: 16px; padding: var(--kp-pad-page);
    flex: 1 1 auto; min-height: 0;
  }

  .board {
    display: flex; gap: var(--kp-gap-board);
    overflow-x: auto; overflow-y: hidden; padding-bottom: 8px;
    flex: 1 1 auto; min-width: 0;
  }

  .column {
    flex: 0 0 var(--kp-column-width);
    min-height: 120px; max-height: 100%;
    display: flex; flex-direction: column; gap: 10px;
    background: var(--vscode-sideBar-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--kp-radius-column);
    padding: var(--kp-pad-column);
    overflow: hidden;
  }
  .column.drag-over {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-list-hoverBackground, var(--vscode-sideBar-background));
  }
  .column-head { flex: none; display: flex; flex-direction: column; gap: 3px; }
  .column-title-row { display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 100px; flex: none; }
  .column-title { font-size: 13px; font-weight: 600; flex: 1; }
  .count { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); }

  /* Exact structure from the prototype's "Agent Metadata" row: Agent Label +
     Agent Name (monospace) + a non-interactive edit-pencil (§13). */
  .agent-meta { display: flex; align-items: center; gap: 4px; }
  .agent-label {
    font-size: 11px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .agent-name {
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: 10px; font-weight: 500; color: var(--vscode-foreground);
  }
  .agent-edit-icon { color: var(--vscode-descriptionForeground); flex: none; line-height: 0; }
  .agent-edit-icon-active { cursor: pointer; border-radius: 4px; }
  .agent-edit-icon-active:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .agent-edit-icon-active:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .cards {
    display: flex; flex-direction: column; gap: 8px;
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    margin: 0 -4px; padding: 0 4px; /* room for the scrollbar without clipping card focus rings */
  }

  .card {
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-card);
    box-shadow: var(--kp-shadow-card);
    padding: var(--kp-pad-card);
    display: flex; flex-direction: column; gap: var(--kp-gap-card);
    cursor: pointer;
  }
  .card[draggable="true"] { cursor: grab; }
  .card.dragging { opacity: .55; cursor: grabbing; }
  .card:hover { border-color: var(--vscode-focusBorder); }
  .card.selected { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .card:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
  .card-id-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .card-id { font-size: 10px; font-weight: 500; color: var(--vscode-descriptionForeground); letter-spacing: 0.02em; }
  /* §6.12: marks a card an agent filed itself, distinct from a human's "New Task". */
  .badge-proposed {
    font-size: 9px; font-weight: 600; letter-spacing: 0.03em; text-transform: uppercase;
    color: var(--kp-modal-accent); background: rgba(79, 70, 229, 0.14);
    border-radius: 4px; padding: 1px 5px; flex: none;
  }
  .icon-btn {
    background: none; border: none; padding: 2px; cursor: pointer;
    color: var(--vscode-descriptionForeground); border-radius: 4px;
    display: inline-flex; line-height: 0;
  }
  .icon-btn:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }

  .card-title { font-size: 13px; font-weight: 600; line-height: 1.35; }

  .card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .card-foot-actions { display: flex; gap: 6px; }
  .status-text { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .status-text.running { color: var(--vscode-charts-blue, #4daafc); }
  .status-text.blocked, .status-text.failed { color: var(--vscode-errorForeground); }
  .status-text.paused { color: var(--vscode-charts-yellow, #cca700); }

  button.action {
    font-family: inherit; font-size: 12px;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none; border-radius: var(--kp-radius-button); padding: 5px 10px;
    cursor: pointer;
  }
  button.action:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }

  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; font-style: italic; padding: 4px 0; }

  /*
   * Task detail modal — replicated from the prototype's modal (Chrome
   * DevTools inspection, 2026-08-13): a centered dialog over a dimming
   * backdrop, not the docked sidebar this used to be. Shape/spacing/type
   * scale are the prototype's exact computed values; surface colors route
   * through --vscode-* per the module doc's split, except the indigo accent
   * (status text, close glyph), which reads as brand identity there the same
   * way the column dots do, so it stays the prototype's literal hex.
   */
  .modal-backdrop {
    display: none;
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0, 0, 0, 0.5);
    align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal-backdrop.open { display: flex; }
  .modal {
    position: relative;
    width: min(720px, 100vw - 32px);
    max-height: min(86vh, 960px);
    background: var(--vscode-editorWidget-background);
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-modal);
    box-shadow: var(--kp-shadow-modal);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 16px 18px 14px;
    border-bottom: 1px solid var(--vscode-panel-border);
    gap: 10px;
  }
  .modal-head-left { min-width: 0; }
  .modal-title {
    font-size: 20px; font-weight: 700; line-height: 1.2;
    overflow-wrap: break-word;
  }
  .modal-badges {
    margin-top: 7px; display: inline-flex; align-items: center; gap: 8px;
    font-size: 13px; color: var(--vscode-descriptionForeground);
  }
  .modal-id {
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: var(--kp-radius-chip); padding: 2px 7px;
  }
  .modal-status { color: var(--kp-modal-accent); font-weight: 600; }
  .modal-close {
    flex: none;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background);
    color: var(--kp-modal-accent);
    width: 32px; height: 32px; border-radius: var(--kp-radius-modal-close);
    cursor: pointer; font-size: 18px; line-height: 18px;
  }
  .modal-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
  .modal-body {
    overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 22px;
  }
  .modal-section-label {
    font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground); margin-bottom: 8px;
  }
  .modal-section-body {
    font-size: 15px; line-height: 1.65; color: var(--vscode-foreground);
  }
  /* Latest log is a receipt line (§6.3's grammar), not prose — kept as literal
     preformatted text rather than run through the markdown renderer below. */
  .modal-section-body.plain { white-space: pre-wrap; }
  .modal-section-body:empty::before { content: '—'; color: var(--vscode-descriptionForeground); }
  .modal-section-body :is(h1, h2, h3, h4) {
    margin: 10px 0 6px; font-weight: 700; line-height: 1.3; color: var(--vscode-foreground);
  }
  .modal-section-body :is(h1, h2, h3, h4):first-child { margin-top: 0; }
  .modal-section-body h1 { font-size: 18px; }
  .modal-section-body h2 { font-size: 16px; }
  .modal-section-body h3 { font-size: 14.5px; }
  .modal-section-body h4 { font-size: 14px; }
  .modal-section-body p { margin: 8px 0; }
  .modal-section-body p:first-child { margin-top: 0; }
  .modal-section-body ul, .modal-section-body ol { margin: 8px 0; padding-left: 20px; }
  .modal-section-body li { margin: 3px 0; }
  .modal-section-body ul.modal-md-checklist { list-style: none; padding-left: 0; }
  .modal-section-body ul.modal-md-checklist label { display: inline-flex; align-items: center; gap: 8px; }
  .modal-section-body blockquote {
    margin: 10px 0; border-left: 3px solid var(--kp-modal-accent);
    padding: 4px 0 4px 12px; color: var(--vscode-descriptionForeground);
  }
  .modal-section-body code {
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px; padding: 1px 5px;
  }
  .modal-section-body pre.modal-code-block {
    margin: 10px 0; padding: 10px 12px; overflow-x: auto;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  }
  .modal-section-body pre.modal-code-block code { border: none; background: none; padding: 0; }
  .modal-section-body a { color: var(--vscode-textLink-foreground); }
  .modal-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .modal-link {
    font-size: 13px; color: var(--vscode-textLink-foreground); cursor: pointer;
    background: none; border: none; padding: 0; font-family: inherit;
  }
  .modal-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>Kanban Pilot</h1>
  <div class="header-actions">
    <button class="gates-btn" id="gatesToggle">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Gates
    </button>
    <button class="new-task-btn" id="newTaskToggle">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      New Task
    </button>
  </div>
</header>
<div class="modal-backdrop" id="gatesBackdrop">
  <div class="modal new-task-modal" id="gatesModal" role="dialog" aria-modal="true" aria-label="Automation gates">
    <div class="new-task-head">
      <div class="new-task-head-text">
        <div class="modal-title">Automation gates</div>
        <div class="new-task-subtitle">Each gate defaults to manual. Switch one to Auto to skip its click.</div>
      </div>
      <button class="modal-close" id="gatesClose" aria-label="Close automation gates dialog">×</button>
    </div>
    <div class="gates-list" id="gatesList"></div>
  </div>
</div>
<div class="modal-backdrop" id="agentNameBackdrop">
  <div class="modal new-task-modal" id="agentNameModal" role="dialog" aria-modal="true" aria-label="Edit agent name">
    <div class="new-task-head">
      <div class="new-task-head-text">
        <div class="modal-title">Edit agent name</div>
        <div class="new-task-subtitle" id="agentNameSubtitle"></div>
      </div>
      <button class="modal-close" id="agentNameClose" aria-label="Close edit agent name dialog">×</button>
    </div>
    <form class="new-task-form" id="agentNameForm">
      <label class="field">
        <span class="field-label">Agent name</span>
        <input class="field-input" id="agentNameInput" type="text" maxlength="60" required />
      </label>
      <div class="new-task-actions">
        <button type="button" class="btn-chip" id="agentNameReset" style="margin-right:auto">Reset to default</button>
        <button type="button" class="btn-chip" id="agentNameCancel">Cancel</button>
        <button type="submit" class="btn-modal-primary" id="agentNameSubmit">Save</button>
      </div>
    </form>
  </div>
</div>
<div class="modal-backdrop" id="newTaskBackdrop">
  <div class="modal new-task-modal" id="newTaskModal" role="dialog" aria-modal="true" aria-label="Create a new task">
    <div class="new-task-head">
      <div class="new-task-head-text">
        <div class="modal-title">Create a new task</div>
        <div class="new-task-subtitle">Add the details for your next board item.</div>
      </div>
      <button class="modal-close" id="newTaskClose" aria-label="Close create task dialog">×</button>
    </div>
    <form class="new-task-form" id="newTaskForm">
      <label class="field">
        <span class="field-label">Title</span>
        <input class="field-input" id="newTaskInput" type="text" placeholder="e.g. Prepare launch notes" maxlength="200" required />
      </label>
      <label class="field">
        <span class="field-label">Description</span>
        <textarea class="field-textarea" id="newTaskDescription" placeholder="What needs to happen?" rows="4"></textarea>
      </label>
      <div class="new-task-actions">
        <button type="button" class="btn-chip" id="newTaskCancel">Cancel</button>
        <button type="submit" class="btn-modal-primary" id="newTaskSubmit">Create task</button>
      </div>
    </form>
  </div>
</div>
<div id="warn"></div>
<div class="layout">
  <div class="board" id="board"></div>
</div>
<div class="modal-backdrop" id="detailBackdrop">
  <div class="modal" id="detail" role="dialog" aria-modal="true"></div>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const ACTION_LABELS = ${actionLabelsJson};
  const GATES = ${gatesJson};
  let draggedTaskId = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  /*
   * Hand-rolled markdown → HTML, deliberately not a dependency: the same call
   * made for renderTemplate's mustache-lite (chat/promptTemplates.ts) — the
   * vocabulary needed is small and fixed (this only ever renders what our own
   * refine/develop/validate prompts ask an agent to write: headings,
   * checklists, bold/italic, inline code, fenced code, links, blockquotes),
   * so a full CommonMark parser is dependency weight without a matching need.
   * Always escapes literal text; never passes raw HTML through — the agent
   * content this renders is not fully trusted input.
   */
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isSafeUrl(href) {
    return /^https?:\\/\\//i.test(href);
  }

  function renderInline(raw) {
    const codeTokens = [];
    let masked = raw.replace(/\`([^\`]+)\`/g, (_m, code) => {
      codeTokens.push(code);
      return '' + (codeTokens.length - 1) + '';
    });
    const linkTokens = [];
    masked = masked.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_m, label, href) => {
      linkTokens.push({ label, href });
      return 'L' + (linkTokens.length - 1) + '';
    });

    let out = escapeHtml(masked);
    out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    out = out.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    out = out.replace(/L(\\d+)/g, (_m, i) => {
      const link = linkTokens[Number(i)];
      return isSafeUrl(link.href)
        ? '<a href="' + escapeHtml(link.href) + '">' + escapeHtml(link.label) + '</a>'
        : escapeHtml(link.label);
    });
    out = out.replace(/(\\d+)/g, (_m, i) => '<code>' + escapeHtml(codeTokens[Number(i)]) + '</code>');
    return out;
  }

  function renderMarkdown(src) {
    if (!src) { return ''; }
    const lines = src.replace(/\\r\\n/g, '\\n').split('\\n');
    const out = [];
    let listType = null;
    function closeList() {
      if (listType) { out.push('</' + (listType === 'ol' ? 'ol' : 'ul') + '>'); listType = null; }
    }

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      if (/^\`\`\`/.test(line)) {
        closeList();
        const codeLines = [];
        i++;
        while (i < lines.length && !/^\`\`\`/.test(lines[i])) { codeLines.push(lines[i]); i++; }
        i++;
        out.push('<pre class="modal-code-block"><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
        continue;
      }

      const heading = line.match(/^(#{1,4})\\s+(.*)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        out.push('<h' + level + '>' + renderInline(heading[2].trim()) + '</h' + level + '>');
        i++;
        continue;
      }

      if (/^>\\s?/.test(line)) {
        closeList();
        const quoteLines = [];
        while (i < lines.length && /^>\\s?/.test(lines[i])) {
          quoteLines.push(lines[i].replace(/^>\\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + renderInline(quoteLines.join(' ')) + '</blockquote>');
        continue;
      }

      const checklist = line.match(/^[-*]\\s+\\[([ xX])\\]\\s+(.*)$/);
      if (checklist) {
        if (listType !== 'checklist') { closeList(); out.push('<ul class="modal-md-checklist">'); listType = 'checklist'; }
        const checked = checklist[1].toLowerCase() === 'x';
        out.push(
          '<li><label><input type="checkbox" disabled' + (checked ? ' checked' : '') + '><span>' +
            renderInline(checklist[2]) + '</span></label></li>',
        );
        i++;
        continue;
      }

      const bullet = line.match(/^[-*]\\s+(.*)$/);
      if (bullet) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + renderInline(bullet[1]) + '</li>');
        i++;
        continue;
      }

      const numbered = line.match(/^\\d+\\.\\s+(.*)$/);
      if (numbered) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + renderInline(numbered[1]) + '</li>');
        i++;
        continue;
      }

      if (line.trim() === '') {
        closeList();
        i++;
        continue;
      }

      closeList();
      const paraLines = [line];
      i++;
      while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,4}\\s|\`\`\`|>|[-*]\\s|\\d+\\.\\s)/.test(lines[i])) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push('<p>' + renderInline(paraLines.join(' ')) + '</p>');
    }
    closeList();
    return out.join('');
  }

  const chatIconSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  const trashIconSvg =
    '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6"/></svg>';

  const editIconSvg =
    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';

  // §6.14: one node forking into two — "split this into smaller tasks".
  const splitIconSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M12 3v7"/><path d="M12 10 5 17"/><path d="M12 10l7 7"/>' +
    '<circle cx="12" cy="3" r="1.6"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="19" r="1.6"/></svg>';

  function actionButton(taskId, action) {
    const b = el('button', 'action', ACTION_LABELS[action]);
    b.draggable = false;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'action/invoke', taskId, action });
    });
    return b;
  }

  function renderCard(card, selectedId) {
    const node = el('div', 'card' + (card.id === selectedId ? ' selected' : ''));
    node.draggable = true;
    node.tabIndex = 0;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', card.id + ': ' + card.title);
    let suppressClick = false;

    node.addEventListener('dragstart', (e) => {
      if (e.target instanceof Element && e.target.closest('button, select, input, textarea')) {
        e.preventDefault();
        return;
      }
      draggedTaskId = card.id;
      suppressClick = false;
      node.classList.add('dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', card.id);
      }
    });
    node.addEventListener('dragend', () => {
      node.classList.remove('dragging');
      clearDropTargets();
      draggedTaskId = null;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    });

    const top = el('div', 'card-top');
    const idGroup = el('div', 'card-id-group');
    idGroup.appendChild(el('div', 'card-id', card.id));
    if (card.originTask) {
      const badge = el('span', 'badge-proposed', 'Proposed');
      badge.title = 'Filed automatically by ' + card.originTask;
      idGroup.appendChild(badge);
    }
    top.appendChild(idGroup);
    const del = el('button', 'icon-btn');
    del.innerHTML = trashIconSvg;
    del.draggable = false;
    del.title = 'Delete task';
    del.setAttribute('aria-label', 'Delete task');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'task/delete', taskId: card.id });
    });
    top.appendChild(del);
    node.appendChild(top);

    node.appendChild(el('div', 'card-title', card.title));

    const foot = el('div', 'card-foot');
    const open = el('button', 'icon-btn');
    open.innerHTML = chatIconSvg;
    open.draggable = false;
    open.title = 'Open task file';
    open.setAttribute('aria-label', 'Open task file');
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'task/open', taskId: card.id });
    });
    foot.appendChild(open);

    if (card.canSplit) {
      const split = el('button', 'icon-btn');
      split.innerHTML = splitIconSvg;
      split.draggable = false;
      split.title = 'Split into smaller tasks';
      split.setAttribute('aria-label', 'Split into smaller tasks');
      split.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'action/invoke', taskId: card.id, action: 'split' });
      });
      foot.appendChild(split);
    }

    const actions = el('div', 'card-foot-actions');
    if (card.status !== 'idle') {
      foot.insertBefore(el('span', 'status-text ' + card.status, card.status), foot.firstChild);
    }
    // Exactly one button per card, matching the prototype — see module doc.
    if (card.primary) { actions.appendChild(actionButton(card.id, card.primary)); }
    foot.appendChild(actions);
    node.appendChild(foot);

    const select = () => vscode.postMessage({ type: 'task/select', taskId: card.id });
    node.addEventListener('click', (e) => {
      if (suppressClick) {
        e.stopPropagation();
        return;
      }
      select();
    });
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
    });
    return node;
  }

  function clearDropTargets() {
    document.querySelectorAll('.column.drag-over').forEach((column) => column.classList.remove('drag-over'));
  }

  function renderBoard(snapshot, selectedId) {
    const warn = document.getElementById('warn');
    warn.textContent = '';
    if (snapshot.malformed.length) {
      warn.appendChild(el('div', 'warn-banner', 'Could not parse: ' + snapshot.malformed.join(', ')));
    }

    const board = document.getElementById('board');
    board.textContent = '';

    for (const column of snapshot.columns) {
      const node = el('div', 'column');

      node.addEventListener('dragover', (e) => {
        if (!draggedTaskId) { return; }
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'move'; }
        clearDropTargets();
        node.classList.add('drag-over');
      });
      node.addEventListener('dragleave', (e) => {
        if (!e.relatedTarget || !node.contains(e.relatedTarget)) {
          node.classList.remove('drag-over');
        }
      });
      node.addEventListener('drop', (e) => {
        e.preventDefault();
        const taskId = draggedTaskId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        clearDropTargets();
        if (taskId) {
          vscode.postMessage({ type: 'task/move', taskId, destination: column.id });
        }
      });

      const head = el('div', 'column-head');
      const titleRow = el('div', 'column-title-row');
      const dot = el('span', 'dot');
      dot.style.background = column.dot;
      titleRow.appendChild(dot);
      titleRow.appendChild(el('span', 'column-title', column.label));
      titleRow.appendChild(el('span', 'count', String(column.count)));
      head.appendChild(titleRow);

      const agentMeta = el('div', 'agent-meta');
      agentMeta.appendChild(el('span', 'agent-label', 'Agent'));
      agentMeta.appendChild(el('span', 'agent-name', column.agent));
      const editIcon = el('span', 'agent-edit-icon');
      editIcon.innerHTML = editIconSvg;
      if (column.stage) {
        editIcon.classList.add('agent-edit-icon-active');
        editIcon.tabIndex = 0;
        editIcon.setAttribute('role', 'button');
        editIcon.title = 'Edit agent name';
        editIcon.setAttribute('aria-label', 'Edit agent name for ' + column.label);
        const openEditor = (e) => {
          e.stopPropagation();
          openAgentNameModal(column.stage, column.label, column.agent);
        };
        editIcon.addEventListener('click', openEditor);
        editIcon.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(e); }
        });
      } else {
        editIcon.title = 'Per-column agent assignment is not configurable yet';
      }
      agentMeta.appendChild(editIcon);
      head.appendChild(agentMeta);

      node.appendChild(head);

      const cards = el('div', 'cards');
      if (column.cards.length === 0) {
        cards.appendChild(el('div', 'empty', 'empty'));
      } else {
        for (const card of column.cards) { cards.appendChild(renderCard(card, selectedId)); }
      }
      node.appendChild(cards);
      board.appendChild(node);
    }
  }

  function renderGates(state) {
    const list = document.getElementById('gatesList');
    list.textContent = '';
    for (const gate of GATES) {
      const row = el('div', 'gate-row');

      const text = el('div', 'gate-text');
      text.appendChild(el('div', 'gate-label', gate.label));
      text.appendChild(el('div', 'gate-desc', gate.description));
      row.appendChild(text);

      const switchLabel = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = state[gate.key] === 'auto';
      input.setAttribute('aria-label', gate.label + ' — auto');
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'gates/set', key: gate.key, value: input.checked ? 'auto' : 'manual' });
      });
      switchLabel.appendChild(input);
      const track = el('span', 'switch-track');
      track.appendChild(el('span', 'switch-thumb'));
      switchLabel.appendChild(track);
      row.appendChild(switchLabel);

      list.appendChild(row);
    }
  }

  function closeDetail() {
    document.getElementById('detailBackdrop').classList.remove('open');
    vscode.postMessage({ type: 'task/deselect' });
  }

  function renderDetail(task) {
    const backdrop = document.getElementById('detailBackdrop');
    const modal = document.getElementById('detail');
    modal.textContent = '';

    if (!task) {
      backdrop.classList.remove('open');
      return;
    }
    backdrop.classList.add('open');
    document.getElementById('newTaskBackdrop').classList.remove('open'); // mutually exclusive with New Task
    document.getElementById('gatesBackdrop').classList.remove('open'); // and with Gates
    document.getElementById('agentNameBackdrop').classList.remove('open'); // and with Edit agent name
    modal.setAttribute('aria-label', 'Task detail for ' + task.title);

    const head = el('div', 'modal-head');
    const left = el('div', 'modal-head-left');
    left.appendChild(el('div', 'modal-title', task.title));
    const badges = el('div', 'modal-badges');
    badges.appendChild(el('span', 'modal-id', task.id));
    badges.appendChild(el('span', 'modal-status', task.stateLabel + ' · ' + task.status));
    if (task.originTask) {
      const badge = el('span', 'badge-proposed', 'Proposed');
      badge.title = 'Filed automatically by ' + task.originTask;
      badges.appendChild(badge);
    }
    left.appendChild(badges);
    head.appendChild(left);

    const close = el('button', 'modal-close', '×');
    close.setAttribute('aria-label', 'Close task detail');
    close.addEventListener('click', closeDetail);
    head.appendChild(close);
    modal.appendChild(head);

    const body = el('div', 'modal-body');

    const moveControl = el('label', 'field');
    moveControl.appendChild(el('span', 'field-label', 'Move to column'));
    const moveSelect = document.createElement('select');
    moveSelect.className = 'field-input';
    moveSelect.setAttribute('aria-label', 'Move task to column');
    for (const target of task.moveTargets) {
      const option = document.createElement('option');
      option.value = target.id;
      option.textContent = target.label;
      moveSelect.appendChild(option);
    }
    moveSelect.value = task.state;
    moveSelect.addEventListener('change', () => {
      if (moveSelect.value !== task.state) {
        vscode.postMessage({ type: 'task/move', taskId: task.id, destination: moveSelect.value });
      }
    });
    moveControl.appendChild(moveSelect);
    body.appendChild(moveControl);

    const links = el('div', 'modal-actions');
    const openLink = el('button', 'modal-link', 'Open task file →');
    openLink.addEventListener('click', () => vscode.postMessage({ type: 'task/open', taskId: task.id }));
    links.appendChild(openLink);
    const openChatLink = el('button', 'modal-link', 'Open Chat →');
    openChatLink.addEventListener('click', () => vscode.postMessage({ type: 'task/openChat', taskId: task.id }));
    links.appendChild(openChatLink);
    if (task.secondary) { links.appendChild(actionButton(task.id, task.secondary)); }
    body.appendChild(links);

    for (const [label, text] of [['Request', task.request], ['Refined', task.refined], ['Scope', task.scope]]) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', label));
      const sectionBody = el('div', 'modal-section-body');
      sectionBody.innerHTML = renderMarkdown(text);
      section.appendChild(sectionBody);
      body.appendChild(section);
    }

    if (task.lastLog) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', 'Latest log'));
      section.appendChild(el('div', 'modal-section-body plain', task.lastLog));
      body.appendChild(section);
    }

    modal.appendChild(body);
  }

  document.getElementById('detailBackdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeDetail(); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('detailBackdrop').classList.contains('open')) {
      closeDetail();
    }
  });

  let lastSelectedId;
  let lastGates;
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) { return; }
    if (msg.type === 'board/state') {
      lastSelectedId = msg.selectedTaskId;
      renderBoard(msg.snapshot, lastSelectedId);
    } else if (msg.type === 'task/detail') {
      renderDetail(msg.task);
    } else if (msg.type === 'gates/state') {
      lastGates = msg.gates;
      renderGates(lastGates);
    }
  });

  const newTaskBackdrop = document.getElementById('newTaskBackdrop');
  const newTaskInput = document.getElementById('newTaskInput');
  const newTaskDescription = document.getElementById('newTaskDescription');

  function openNewTaskModal() {
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    gatesBackdrop.classList.remove('open'); // and with Gates
    document.getElementById('agentNameBackdrop').classList.remove('open'); // and with Edit agent name
    newTaskBackdrop.classList.add('open');
    newTaskInput.value = '';
    newTaskDescription.value = '';
    newTaskInput.focus();
  }
  function closeNewTaskModal() {
    newTaskBackdrop.classList.remove('open');
  }

  document.getElementById('newTaskToggle').addEventListener('click', openNewTaskModal);
  document.getElementById('newTaskClose').addEventListener('click', closeNewTaskModal);
  document.getElementById('newTaskCancel').addEventListener('click', closeNewTaskModal);
  newTaskBackdrop.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeNewTaskModal(); }
  });
  document.getElementById('newTaskForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = newTaskInput.value.trim();
    if (!title) { return; }
    vscode.postMessage({ type: 'task/create', title, description: newTaskDescription.value.trim() });
    closeNewTaskModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && newTaskBackdrop.classList.contains('open')) { closeNewTaskModal(); }
  });

  const gatesBackdrop = document.getElementById('gatesBackdrop');
  function openGatesModal() {
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    newTaskBackdrop.classList.remove('open'); // and with New Task
    document.getElementById('agentNameBackdrop').classList.remove('open'); // and with Edit agent name
    gatesBackdrop.classList.add('open');
    if (lastGates) { renderGates(lastGates); }
  }
  function closeGatesModal() {
    gatesBackdrop.classList.remove('open');
  }
  document.getElementById('gatesToggle').addEventListener('click', openGatesModal);
  document.getElementById('gatesClose').addEventListener('click', closeGatesModal);
  gatesBackdrop.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeGatesModal(); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && gatesBackdrop.classList.contains('open')) { closeGatesModal(); }
  });

  const agentNameBackdrop = document.getElementById('agentNameBackdrop');
  const agentNameInput = document.getElementById('agentNameInput');
  const agentNameSubtitle = document.getElementById('agentNameSubtitle');
  let editingAgentStage;

  function openAgentNameModal(stage, columnLabel, currentValue) {
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    newTaskBackdrop.classList.remove('open'); // and with New Task
    gatesBackdrop.classList.remove('open'); // and with Gates
    editingAgentStage = stage;
    agentNameSubtitle.textContent = 'Persona ' + columnLabel + ' prompts open with (the @name at the top).';
    agentNameInput.value = currentValue;
    agentNameBackdrop.classList.add('open');
    agentNameInput.focus();
    agentNameInput.select();
  }
  function closeAgentNameModal() {
    agentNameBackdrop.classList.remove('open');
    editingAgentStage = undefined;
  }
  document.getElementById('agentNameClose').addEventListener('click', closeAgentNameModal);
  document.getElementById('agentNameCancel').addEventListener('click', closeAgentNameModal);
  agentNameBackdrop.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeAgentNameModal(); }
  });
  document.getElementById('agentNameReset').addEventListener('click', () => {
    if (!editingAgentStage) { return; }
    vscode.postMessage({ type: 'agentName/set', stage: editingAgentStage, value: '' });
    closeAgentNameModal();
  });
  document.getElementById('agentNameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editingAgentStage) { return; }
    const value = agentNameInput.value.trim();
    if (!value) { return; }
    vscode.postMessage({ type: 'agentName/set', stage: editingAgentStage, value });
    closeAgentNameModal();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && agentNameBackdrop.classList.contains('open')) { closeAgentNameModal(); }
  });

  vscode.postMessage({ type: 'board/ready' });
</script>
</body>
</html>`;
	}
}

function isTaskAction(value: unknown): value is TaskAction {
	return typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);
}
