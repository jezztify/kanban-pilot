import * as vscode from 'vscode';
import MarkdownIt = require('markdown-it');
import {
  CopilotAgentOption,
  discoverCopilotAgents,
} from '../chat/copilotAgents';
import {
  AgentNameOverrides,
  COLUMN_AGENT_DEFAULT,
  resolveAgentNameForColumn,
  stageForColumn,
} from '../chat/agentNames';
import { RunManager } from '../chat/runManager';
import { DEFAULT_FEED_LIMIT, mergeFeedEntries } from '../chat/transcriptTail';
import type { FeedEntry, FeedSourceSnapshot } from '../chat/transcriptTail';
import { suppressDuplicatedTailEntries } from '../chat/hookSpool';
import type { StaleCompletionCandidate } from '../chat/runManager';
import type { Stage } from '../chat/receipt';
import { parseReceipts } from '../chat/receipt';
import { parseProgressEntries } from '../chat/progress';
import {
  COLUMNS,
  COLUMN_LABELS,
  Column,
  isTaskType,
  Status,
  Task,
  TaskAttachmentChanges,
  TASK_TYPE_LABELS,
  STATUSES,
  TASK_TYPES,
  normalizeEditableTaskContent,
  parseTaskDetailSections,
} from '../model/task';
import { gateForId, GATE_CATALOG } from '../model/gates';
import { parseAuditEvents } from '../model/taskLog';
import { TaskSet } from '../model/taskSets';
import { BoardSnapshot, TaskStore } from '../model/taskStore';
import type {
  WorkspaceActivityInput,
  WorkspaceActivityRecord,
  WorkspaceActivityStore,
} from '../model/workspaceActivity';
import { deleteTask } from './actions';
import { BoardSurface, WebviewPanelSurface } from './boardSurface';
import { TASK_ACTIONS, TaskAction } from './stateMachine';

const markdownItTaskLists = require('markdown-it-task-lists') as (
  markdown: MarkdownIt,
  options?: { enabled?: boolean; label?: boolean },
) => void;

export interface TaskMarkdownAttachment {
  relativePath: string;
  src: string;
}

const TASK_ATTACHMENT_REFERENCE = /^TASK-\d+\.attachments\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WEBVIEW_IMAGE_SOURCE = [
  /^vscode-webview-resource:/i,
  /^https:\/\/file(?:%2b|\+)\.vscode-resource\.vscode-cdn\.net\//i,
];

function escapeMarkdownHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname;
  } catch {
    return false;
  }
}

function isSafeWebviewImageSource(value: string): boolean {
  return WEBVIEW_IMAGE_SOURCE.some((pattern) => pattern.test(value));
}

function imageAltText(value: string | null): string {
  const clean = String(value || '').replace(/[\[\]\r\n]/g, ' ').trim();
  return clean || 'Task image';
}

/** Renders task specification Markdown before it crosses the webview boundary. */
export function renderTaskMarkdown(
  source: string,
  attachments: readonly TaskMarkdownAttachment[] = [],
): string {
  const attachmentMap = new Map(attachments.map((attachment) => [attachment.relativePath, attachment]));
  const markdown = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: false,
    typographer: false,
  });
  // Keep link tokens available for the output policy below. This also lets
  // unsupported image references reach the unavailable-image placeholder
  // instead of silently losing their authored text.
  markdown.validateLink = () => true;
  markdown.use(markdownItTaskLists, { enabled: false, label: true });
  markdown.core.ruler.push('suppress-unsafe-task-links', (state) => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) { continue; }
      let suppressLink = false;
      for (const child of token.children) {
        if (child.type === 'link_open') {
          suppressLink = !isSafeHttpUrl(child.attrGet('href') || '');
          if (suppressLink) { child.meta = { unsafeTaskLink: true }; }
        } else if (child.type === 'link_close') {
          if (suppressLink) { child.meta = { unsafeTaskLink: true }; }
          suppressLink = false;
        }
      }
    }
  });
  markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => (
    tokens[index].meta?.unsafeTaskLink ? '' : renderer.renderToken(tokens, index, options)
  );
  markdown.renderer.rules.link_close = (tokens, index, options, env, renderer) => (
    tokens[index].meta?.unsafeTaskLink ? '' : renderer.renderToken(tokens, index, options)
  );

  markdown.renderer.rules.image = (tokens, index) => {
    const token = tokens[index];
    const href = token.attrGet('src') || '';
    const attachment = TASK_ATTACHMENT_REFERENCE.test(href) ? attachmentMap.get(href) : undefined;
    const alt = imageAltText(token.children?.map((child) => child.content).join('') || token.attrGet('alt'));
    if (!attachment || !isSafeWebviewImageSource(attachment.src)) {
      const escapedAlt = escapeMarkdownHtml(alt);
      return '<span class="task-image-placeholder" role="img" aria-label="Image unavailable: ' +
        escapedAlt + '">Image unavailable: ' + escapedAlt + '</span>';
    }
    return '<img class="task-image" loading="lazy" src="' + escapeMarkdownHtml(attachment.src) +
      '" alt="' + escapeMarkdownHtml(alt) + '">';
  };

  markdown.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = token.info.trim().split(/\s+/)[0] || '';
    if (language.toLowerCase() === 'mermaid') {
      return '<div class="modal-mermaid" data-mermaid-diagram role="group" aria-label="Mermaid diagram">' +
        '<pre class="modal-mermaid-source" aria-label="Mermaid source">' +
        escapeMarkdownHtml(token.content) + '</pre></div>\n';
    }
    const className = /^[A-Za-z0-9_-]+$/.test(language)
      ? ' class="language-' + escapeMarkdownHtml(language) + '"'
      : '';
    return '<pre class="modal-code-block"><code' + className + '>' +
      escapeMarkdownHtml(token.content) + '</code></pre>\n';
  };
  markdown.renderer.rules.code_block = (tokens, index) => (
    '<pre class="modal-code-block"><code>' +
    escapeMarkdownHtml(tokens[index].content) +
    '</code></pre>\n'
  );
  markdown.renderer.rules.table_open = () => '<div class="modal-table-wrap"><table>\n';
  markdown.renderer.rules.table_close = () => '</table></div>\n';

  return source ? markdown.render(source) : '';
}

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
 * would look broken in dark mode.
 *
 * The color layer on top of that shape language is this board's own, and is
 * deliberately loud: the prototype's near-grey accents carried almost no
 * information, so the seven columns now own seven saturated hues walked around
 * the wheel in pipeline order (`COLUMN_ACCENT`), and a card keeps its stage's
 * hue on its left rail wherever it goes. Only the hue itself is a literal hex.
 * Everything derived from it — fills, borders, glows, and especially text —
 * is `color-mix`ed against a `--vscode-*` token at render time, so one palette
 * serves every theme instead of needing a light and a dark copy. See the
 * `--col-*` role block in the stylesheet for the four derivations, and the
 * `body.vscode-dark` override below it for the one role (text) that genuinely
 * cannot be expressed once for both. Every text role was measured against its
 * real composited background in both themes and clears WCAG AA 4.5:1; the
 * comments at each exception record what the measurement was, so keep them
 * honest if the palette moves.
 *
 * Re-inspected 2026-08-13 for exact replication (§12 Q10, §13): the prototype
 * had moved on from 6 columns to 7 (a "Validation" gate before Done) and
 * gained a static per-column `Agent` badge. Both are adopted here — see
 * task.ts`'s `COLUMNS` comment and the shared stage/column resolution below.
 * As of the M3 stage-wiring pass, the badge for refine/in-progress/validation
 * is no longer just cosmetic: it is the same column-aware resolution that
 * `RunManager` uses to open every prompt with `@{{agentName}}`. The Settings
 * surface now allows assignments for all seven columns; resting-column labels
 * remain display-only because those columns have no runnable stage.
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
 * and type scale are the prototype's exact computed values; its color comes
 * from the state the task is currently in — `renderDetail` paints the opened
 * task's stage hue onto the backdrop and the modal inherits it — so opening a
 * card carries the board's color coding through instead of dropping it. The
 * prototype's own modal content is a generic Markdown+Mermaid renderer
 * (fallback placeholder text, not real task data); this board's modal
 * carries the same chrome but real content — Request/Refined/Scope/Log.
 */

/**
 * Per-column accent hues, and the second stop each one gradients into.
 *
 * A deliberate walk around the color wheel in pipeline order (sky → indigo →
 * purple → pink → orange → yellow → green) so a column is identifiable by hue
 * alone at a glance, and so a card carries its stage's color with it as it
 * crosses the board. Saturation is held high on purpose — these are the one
 * place the board departs from editor chrome (see module doc); everything
 * derived from them (tints, borders, glows, text) is mixed against a
 * `--vscode-*` token at render time, so the same hex reads correctly in both
 * light and dark themes rather than needing two palettes.
 */
const COLUMN_ACCENT: Record<Column, { from: string; to: string }> = {
	backlog: { from: '#38bdf8', to: '#0284c7' },
	refine: { from: '#6366f1', to: '#4f46e5' },
	scoped: { from: '#a855f7', to: '#9333ea' },
	approved: { from: '#ec4899', to: '#db2777' },
	'in-progress': { from: '#fb923c', to: '#ea580c' },
	validation: { from: '#facc15', to: '#d97706' },
	done: { from: '#4ade80', to: '#16a34a' },
};

/**
 * Which stage — if any — runs in each column. The shared agent-name module owns
 * the same mapping for resolution; this local alias keeps the board payload's
 * stage field explicit for the webview.
 */
const COLUMN_STAGE = stageForColumn;

function isRecoveryStage(value: unknown): value is StaleCompletionCandidate['stage'] {
  return value === 'refine' || value === 'develop' || value === 'validate' || value === 'split';
}

export interface ParentTaskOption {
  id: string;
  name: string;
}

export interface TaskTreeNode {
  id: string;
  name: string;
  status: string;
}

export interface TaskTreeEdge {
  parentId: string;
  childId: string;
}

export interface TaskTreeProjection {
  rootTaskId: string;
  nodes: TaskTreeNode[];
  edges: TaskTreeEdge[];
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^TASK-\d+$/.test(value);
}

function compareTaskIds(left: string, right: string): number {
  const leftNumber = Number(left.slice(5));
  const rightNumber = Number(right.slice(5));
  if (leftNumber !== rightNumber) {
    return leftNumber - rightNumber;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Projects only valid descendants from one fresh active task-set snapshot. */
export function taskTreeFor(tasks: readonly Task[], rootId: string): TaskTreeProjection | undefined {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (!byId.has(task.id)) {
      byId.set(task.id, task);
    }
  }
  const root = byId.get(rootId);
  if (!root) {
    return undefined;
  }

  const parentIds = new Map<string, string | undefined>();
  const malformed = new Set<string>();
  for (const task of tasks) {
    if (task.parentTaskId === undefined) {
      parentIds.set(task.id, undefined);
    } else if (isTaskId(task.parentTaskId)) {
      parentIds.set(task.id, task.parentTaskId);
    } else {
      parentIds.set(task.id, undefined);
      malformed.add(task.id);
    }
  }

  const validity = new Map<string, boolean>();
  const visiting = new Set<string>();
  const parentLinkIsValid = (taskId: string): boolean => {
    if (validity.has(taskId)) {
      return validity.get(taskId)!;
    }
    if (malformed.has(taskId)) {
      validity.set(taskId, false);
      return false;
    }
    const parentId = parentIds.get(taskId);
    if (parentId === undefined) {
      validity.set(taskId, true);
      return true;
    }
    if (parentId === taskId || !byId.has(parentId) || visiting.has(taskId)) {
      validity.set(taskId, false);
      return false;
    }

    visiting.add(taskId);
    const valid = parentLinkIsValid(parentId);
    visiting.delete(taskId);
    validity.set(taskId, valid);
    return valid;
  };

  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    const parentId = parentIds.get(task.id);
    if (!parentLinkIsValid(task.id) || parentId === undefined) {
      continue;
    }
    const children = childrenByParent.get(parentId) ?? [];
    if (!children.includes(task.id)) {
      children.push(task.id);
      children.sort(compareTaskIds);
      childrenByParent.set(parentId, children);
    }
  }

  const reachable = new Set<string>([root.id]);
  const pending = [root.id];
  while (pending.length > 0) {
    const parentId = pending.shift()!;
    for (const childId of childrenByParent.get(parentId) ?? []) {
      if (reachable.has(childId)) {
        continue;
      }
      reachable.add(childId);
      pending.push(childId);
    }
  }
  if (reachable.size === 1) {
    return undefined;
  }

  const ids = [...reachable].sort(compareTaskIds);
  const edges = [...reachable]
    .flatMap((parentId) => (childrenByParent.get(parentId) ?? [])
      .filter((childId) => reachable.has(childId))
      .map((childId): TaskTreeEdge => ({ parentId, childId })))
    .sort((left, right) => compareTaskIds(left.parentId, right.parentId) || compareTaskIds(left.childId, right.childId));
  return {
    rootTaskId: root.id,
    nodes: ids.map((id) => {
      const task = byId.get(id)!;
      return {
        id: task.id,
        name: task.title,
        status: `${COLUMN_LABELS[task.state]} · ${task.status}`,
      };
    }),
    edges,
  };
}

/** Per-column agent badge, resolved against current `chat.agentNames` overrides (§12 Q10). */
function agentLabelFor(column: Column, overrides: AgentNameOverrides): string {
  return resolveAgentNameForColumn(column, overrides) ?? 'None';
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

export type OutcomeGuidanceKind = 'running' | 'blocked' | 'failed' | 'pending' | 'stale';

export interface OutcomeGuidance {
  kind: OutcomeGuidanceKind;
  label: string;
  summary: string;
  whatHappened: string;
  holding: string;
  nextStep: string;
  stage?: Stage;
  runId?: string;
  action?: TaskAction;
  gate?: string;
  gateLabel?: string;
  latestRunId?: string;
  currentRunId?: string;
  receiptSummary?: string;
  reason?: string;
}

type OutcomeGuidanceTask = Pick<Task, 'id' | 'state' | 'status' | 'run' | 'pendingOutcome' | 'sections'>;

function stageLabel(stage: Stage | undefined): string {
  return stage ? stage.charAt(0).toUpperCase() + stage.slice(1) : 'Task';
}

function activeStageFor(task: OutcomeGuidanceTask): Stage | undefined {
  const runId = task.run;
  if (runId) {
    const activeStart = [...parseAuditEvents(task.sections['Log'] ?? '')]
      .reverse()
      .find((event) => event.kind === 'activity-start' && event.taskId === task.id && event.runId === runId);
    if (activeStart?.stage) {
      return activeStart.stage;
    }
  }
  return COLUMN_STAGE(task.state) ?? undefined;
}

function terminalEvidenceFor(task: OutcomeGuidanceTask): {
  stage?: Stage;
  runId?: string;
  reason?: string;
} {
  const audits = parseAuditEvents(task.sections['Log'] ?? '')
    .filter((event) => event.taskId === task.id);
  const terminal = [...audits]
    .reverse()
    .find((event) => event.kind === 'activity-finish');
  const receipts = parseReceipts(task.sections['Log'] ?? '')
    .filter((receipt) => receipt.taskId === task.id);
  const receipt = [...receipts]
    .reverse()
    .find((candidate) => (
      (!terminal?.stage || candidate.stage === terminal.stage) &&
      (!terminal?.runId || candidate.runId === terminal.runId)
    ));
  const correctionReason = terminal && (
    terminal.correction === true ||
    terminal.provisional === true ||
    terminal.outcome !== 'ok' && terminal.outcome !== receipt?.result
  )
    ? terminal.note
    : undefined;
  return {
    stage: terminal?.stage ?? receipt?.stage,
    runId: terminal?.runId ?? receipt?.runId,
    reason: correctionReason ?? receipt?.note ?? terminal?.note,
  };
}

export function outcomeGuidanceFor(
  task: OutcomeGuidanceTask,
  staleCompletions: readonly StaleCompletionCandidate[] = [],
): OutcomeGuidance | undefined {
  const pending = pendingView(task);
  if (pending) {
    const stage = pending.stage as Stage;
    const stageName = stageLabel(stage);
    return {
      kind: 'pending',
      label: 'Review Required',
      summary: `${pending.label} completion is ready for review.`,
      whatHappened: `${stageName} finished with a ${pending.result} receipt in run ${pending.runId}.`,
      holding: `The ${pending.label} gate is waiting for manual application.`,
      nextStep: `Apply ${pending.label}.`,
      stage,
      runId: pending.runId,
      gate: pending.gate,
      gateLabel: pending.label,
    };
  }

  const stale = staleCompletions.find((candidate) => candidate.taskId === task.id);
  if (stale) {
    const stageName = stageLabel(stale.stage);
    return {
      kind: 'stale',
      label: 'Recovery Available',
      summary: `A stale ${stageName} completion from old run ${stale.runId} is available for review.`,
      whatHappened: `Run ${stale.runId} recorded a successful ${stageName} completion.`,
      holding: stale.currentRunId
        ? `A newer run ${stale.currentRunId} is active; recovery requires host revalidation.`
        : 'The old result is not applied automatically; explicit host confirmation is required.',
      nextStep: `Review and recover the old ${stageName} completion after host confirmation.`,
      stage: stale.stage,
      runId: stale.runId,
      ...(stale.latestRunId ? { latestRunId: stale.latestRunId } : {}),
      ...(stale.currentRunId ? { currentRunId: stale.currentRunId } : {}),
      receiptSummary: stale.summary,
    };
  }

  const stage = activeStageFor(task);
  const stageName = stageLabel(stage);
  const runId = task.run;
  const action = primaryAction(task.state, task.status);
  if (task.status === 'running') {
    return {
      kind: 'running',
      label: 'Running',
      summary: `${stageName} is running${runId ? ` in run ${runId}` : ''}.`,
      whatHappened: `${stageName} activity is in progress.`,
      holding: runId ? `Run ${runId} is active.` : 'The active run is still in progress.',
      nextStep: action === 'stop' ? `Stop the active ${stageName} run if it needs attention.` : 'Wait for the active run to finish.',
      ...(stage ? { stage } : {}),
      ...(runId ? { runId } : {}),
      ...(action ? { action } : {}),
    };
  }

  if (task.status !== 'blocked' && task.status !== 'failed') {
    return undefined;
  }

  const evidence = terminalEvidenceFor(task);
  const evidenceStage = evidence.stage ?? activeStageFor(task);
  const evidenceStageName = stageLabel(evidenceStage);
  const evidenceRunId = evidence.runId ?? task.run;
  const retryAction = primaryAction(task.state, task.status);
  const blocked = task.status === 'blocked';
  const reason = evidence.reason?.trim() || undefined;
  return {
    kind: blocked ? 'blocked' : 'failed',
    label: blocked ? 'Blocked' : 'Failed',
    summary: `${evidenceStageName} ${blocked ? 'is blocked' : 'failed'}${reason ? `: ${reason}` : '.'}`,
    whatHappened: `${evidenceStageName} ${blocked ? 'reported a blocked outcome.' : 'run failed.'}`,
    holding: blocked
      ? 'Host approval or action is required before this task can continue.'
      : 'Review the failure before retrying this task.',
    nextStep: retryAction
      ? `Choose ${ACTION_LABELS[retryAction]} to retry the ${evidenceStageName} step.`
      : 'Review the task and choose the available legal action.',
    ...(evidenceStage ? { stage: evidenceStage } : {}),
    ...(evidenceRunId ? { runId: evidenceRunId } : {}),
    ...(retryAction ? { action: retryAction } : {}),
    ...(reason ? { reason } : {}),
  };
}

function pendingView(task: Pick<Task, 'pendingOutcome'>): {
  gate: string;
  label: string;
  description: string;
  stage: string;
  result: string;
  runId: string;
} | undefined {
  const pending = task.pendingOutcome;
  const gate = pending ? gateForId(pending.gate) : undefined;
  if (!pending || !gate || gate.kind !== 'receipt-completion') {
    return undefined;
  }
  return {
    gate: gate.id,
    label: gate.label,
    description: gate.description,
    stage: pending.stage,
    result: pending.result,
    runId: pending.runId,
  };
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

/** Actions whose board buttons explicitly open the task chat beside the board. */
export function shouldDockTaskChat(action: TaskAction): boolean {
  return action === 'refine' || action === 'develop' || action === 'validate';
}

/** Runs a board action after its requested task-chat docking has completed. */
export async function invokeBoardAction(
  runManager: Pick<RunManager, 'dockTaskChat' | 'handleAction'>,
  taskId: string,
  action: TaskAction,
): Promise<void> {
  if (shouldDockTaskChat(action)) {
    await runManager.dockTaskChat(taskId, { onSelect: false });
  }
  await runManager.handleAction(taskId, action);
}

interface InMessage {
	type?: string;
	taskId?: string;
  parentTaskId?: unknown;
  runId?: unknown;
  stage?: unknown;
  taskSetId?: string;
  destination?: unknown;
  beforeTaskId?: unknown;
  targetIndex?: unknown;
	action?: string;
	title?: string;
	description?: string;
  taskType?: unknown;
	key?: string;
  value?: unknown;
  values?: unknown;
  column?: unknown;
  content?: unknown;
  attachments?: unknown;
}

/** Operations the webview needs from the workspace's active-set controller. */
export interface BoardTaskSetChange {
  revision: number;
  kind: string;
  taskId?: string;
  note?: string;
}

/** Most activity rows shown for a task, across all feed sources. */
const ACTIVITY_FEED_LIMIT = DEFAULT_FEED_LIMIT;
const HOOK_STALE_AFTER_MS = 30_000;

export type ActivitySource = 'progress' | 'hook' | 'transcript';
export type ActivitySourceStatus = 'disabled' | 'unavailable' | 'empty' | 'available';
export type ActivityFreshness = 'durable' | 'current' | 'stale' | 'delayed' | 'unknown';
export type ActivitySourceAvailability = FeedSourceSnapshot['availability'] | 'not-shared';

/** Safe provenance and freshness state rendered for one activity source. */
export interface ActivitySourceView {
  source: ActivitySource;
  label: string;
  status: ActivitySourceStatus;
  statusLabel: string;
  availability: ActivitySourceAvailability;
  freshness: ActivityFreshness;
  freshnessLabel: string;
  delayed: boolean;
  entryCount: number;
  description: string;
  latestEventAt?: string;
  latestObservedAt?: string;
}

/** Shared activity metadata for editor and browser task-detail projections. */
export interface ActivityView {
  sources: ActivitySourceView[];
}

export interface ActivityViewOptions {
  hookEnabled: boolean;
  transcriptEnabled: boolean;
  remoteAllowed: boolean;
  now?: number;
}

const ACTIVITY_SOURCE_LABELS: Record<ActivitySource, string> = {
  progress: 'Durable progress',
  hook: 'Near-real-time hook',
  transcript: 'Delayed transcript',
};

const ACTIVITY_STATUS_LABELS: Record<ActivitySourceStatus, string> = {
  disabled: 'Disabled',
  unavailable: 'Unavailable',
  empty: 'Enabled · empty',
  available: 'Available',
};

const ACTIVITY_FRESHNESS_LABELS: Record<ActivityFreshness, string> = {
  durable: 'Recorded in task log',
  current: 'Observed recently',
  stale: 'Last observation is stale',
  delayed: 'Delayed observation',
  unknown: 'Freshness unavailable',
};

/** Returns the stable user-facing label for one safe activity source id. */
export function activitySourceLabel(source: ActivitySource): string {
  return ACTIVITY_SOURCE_LABELS[source];
}

function activityFreshnessForHook(snapshot: FeedSourceSnapshot, now: number): ActivityFreshness {
  if (snapshot.entries.length === 0 || !snapshot.latestObservedAt) {
    return 'unknown';
  }
  const observedAt = Date.parse(snapshot.latestObservedAt);
  if (!Number.isFinite(observedAt)) {
    return 'unknown';
  }
  return now - observedAt <= HOOK_STALE_AFTER_MS ? 'current' : 'stale';
}

function latestEventAtOf(entries: readonly FeedEntry[]): string | undefined {
  return entries.reduce<string | undefined>((latest, entry) => (
    !latest || Date.parse(entry.at) > Date.parse(latest) ? entry.at : latest
  ), undefined);
}

function sourceView(
  source: ActivitySource,
  snapshot: FeedSourceSnapshot,
  enabled: boolean,
  remoteAllowed: boolean,
  now: number,
): ActivitySourceView {
  const label = activitySourceLabel(source);
  const delayed = source === 'transcript';
  if (!enabled) {
    return {
      source,
      label,
      status: 'disabled',
      statusLabel: ACTIVITY_STATUS_LABELS.disabled,
      availability: 'not-configured',
      freshness: 'unknown',
      freshnessLabel: ACTIVITY_FRESHNESS_LABELS.unknown,
      delayed,
      entryCount: 0,
      description: `${label} observations are disabled in settings.`,
    };
  }
  if (!remoteAllowed) {
    return {
      source,
      label,
      status: 'disabled',
      statusLabel: ACTIVITY_STATUS_LABELS.disabled,
      availability: 'not-shared',
      freshness: 'unknown',
      freshnessLabel: ACTIVITY_FRESHNESS_LABELS.unknown,
      delayed,
      entryCount: 0,
      description: `${label} observations are enabled locally but are not shared with this browser.`,
    };
  }

  if (snapshot.availability !== 'configured') {
    const reason = snapshot.availability === 'missing'
      ? 'The source is not present.'
      : snapshot.availability === 'unreadable'
        ? 'The source could not be read.'
        : 'The source is not configured.';
    return {
      source,
      label,
      status: 'unavailable',
      statusLabel: ACTIVITY_STATUS_LABELS.unavailable,
      availability: snapshot.availability,
      freshness: 'unknown',
      freshnessLabel: ACTIVITY_FRESHNESS_LABELS.unknown,
      delayed,
      entryCount: 0,
      description: `${label} observations are unavailable. ${reason}`,
    };
  }

  const entryCount = snapshot.entries.length;
  const status: ActivitySourceStatus = entryCount ? 'available' : 'empty';
  const freshness = source === 'progress'
    ? 'durable'
    : source === 'hook'
      ? activityFreshnessForHook(snapshot, now)
      : 'delayed';
  let description: string;
  if (source === 'progress') {
    description = entryCount
      ? 'Durable progress summaries are recorded in the task log.'
      : 'No durable progress summaries have been recorded for this task.';
  } else if (source === 'hook') {
    description = entryCount
      ? freshness === 'stale'
        ? 'Near-real-time hook observations are available, but the last one is stale.'
        : 'Near-real-time hook observations are available.'
      : 'Hook observations are enabled and available, but none have been recorded for this task.';
  } else {
    description = entryCount
      ? 'Delayed transcript observations are available; they can arrive after the event occurred.'
      : 'Transcript observations are enabled and available, but none have arrived for this task. They can be delayed.';
  }
  return {
    source,
    label,
    status,
    statusLabel: ACTIVITY_STATUS_LABELS[status],
    availability: snapshot.availability,
    freshness,
    freshnessLabel: ACTIVITY_FRESHNESS_LABELS[freshness],
    delayed,
    entryCount,
    description,
    ...(snapshot.latestEventAt ? { latestEventAt: snapshot.latestEventAt } : {}),
    ...(snapshot.latestObservedAt ? { latestObservedAt: snapshot.latestObservedAt } : {}),
  };
}

/** Builds the shared, safe activity status projection used by both surfaces. */
export function activityViewFor(
  progress: readonly FeedEntry[],
  hook: FeedSourceSnapshot,
  transcript: FeedSourceSnapshot,
  options: ActivityViewOptions,
): ActivityView {
  const now = options.now ?? Date.now();
  const boundedProgress = progress.slice(-ACTIVITY_FEED_LIMIT);
  const latestProgressEventAt = latestEventAtOf(boundedProgress);
  const progressSnapshot: FeedSourceSnapshot = {
    availability: 'configured',
    entries: [...boundedProgress],
    ...(latestProgressEventAt ? { latestEventAt: latestProgressEventAt } : {}),
  };
  return {
    sources: [
      sourceView('progress', progressSnapshot, true, true, now),
      sourceView('hook', hook, options.hookEnabled, options.remoteAllowed, now),
      sourceView('transcript', transcript, options.transcriptEnabled, options.remoteAllowed, now),
    ],
  };
}

export interface BoardTaskSetHost {
  readonly ready: Promise<void>;
  readonly revision?: number;
  readonly store: TaskStore;
  readonly workspaceActivity?: WorkspaceActivityStore;
  readonly runManager: RunManager;
  readonly activeSet: TaskSet;
  listTaskSets(): Promise<TaskSet[]>;
  switchTaskSet(id: string): Promise<void>;
  createTaskSet(name: string): Promise<void>;
  renameTaskSet(name: string): Promise<void>;
  deleteTaskSet(): Promise<void>;
  onDidChange(listener: (change?: BoardTaskSetChange) => void): vscode.Disposable;
}

/**
 * §6.15's nine gate settings, surfaced with all seven column assignments in
 * the board's Settings editor. `key` is the short id used over the wire and
 * in the UI; `setting` is the actual `kanbanPilot.*` id `RunManager.readConfig`
 * reads. Labels/descriptions are trimmed restatements of the package.json
 * descriptions — kept in sync by hand since there's no shared source.
 */
export const GATES = GATE_CATALOG.map((gate) => ({
  key: gate.id,
  setting: gate.settingKey,
  label: gate.label,
  description: gate.description,
}));

export type SettingKind = 'string' | 'enum' | 'boolean' | 'number' | 'array' | 'modelSelector' | 'agentNames';
export type SettingCategory = 'workspace' | 'gates' | 'chat' | 'tools' | 'run' | 'layout' | 'agents';

export interface SettingDefinition {
  key: string;
  category: SettingCategory;
  kind: SettingKind;
  label: string;
  description: string;
  defaultValue: unknown;
  options?: readonly string[];
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  maxLength?: number;
  requiresReload?: boolean;
}

/**
 * The board-side catalog mirrors package.json's contributed settings. The
 * agent assignment object is intentionally represented by the seven-column
 * editor below rather than by a raw object control.
 */
export const SETTING_DEFINITIONS: readonly SettingDefinition[] = [
  {
    key: 'tasksDir',
    category: 'workspace',
    kind: 'string',
    label: 'Task folder',
    description: 'Workspace-relative folder used by the immutable Default task set. Requires a window reload to apply.',
    defaultValue: '.kanban-pilot/tasks',
    maxLength: 240,
    requiresReload: true,
  },
  ...GATES.map((gate): SettingDefinition => ({
    key: gate.setting,
    category: 'gates',
    kind: 'enum',
    label: gate.label,
    description: gate.description,
    defaultValue: 'manual',
    options: ['manual', 'auto'],
  })),
  {
    key: 'chat.mode',
    category: 'chat',
    kind: 'enum',
    label: 'Chat mode',
    description: 'Chat mode requested when a task prompt is injected.',
    defaultValue: 'agent',
    options: ['agent', 'ask'],
  },
  {
    key: 'chat.sessionPrefix',
    category: 'chat',
    kind: 'string',
    label: 'Session ID prefix',
    description: 'Prefix used when deriving each task chat session ID. Applies to new sessions.',
    defaultValue: 'kanban-pilot-',
    maxLength: 120,
  },
  {
    key: 'chat.closeTabOnDone',
    category: 'chat',
    kind: 'boolean',
    label: 'Close chat tab on Done',
    description: "Close the task's chat tab when it reaches Done; the session remains available.",
    defaultValue: true,
  },
  {
    key: 'chat.resetOnApprove',
    category: 'chat',
    kind: 'boolean',
    label: 'Reset chat on Approve',
    description: "Clear the task's conversation at the Approve gate before development continues.",
    defaultValue: false,
  },
  {
    key: 'chat.autoCompact',
    category: 'chat',
    kind: 'boolean',
    label: 'Enable automatic chat compaction',
    description: "Delegate context-window compaction to Copilot's native experimental setting; no transcript or token counter is used. Focus-only compact commands are not used without a supported task-session target.",
    defaultValue: false,
  },
  {
    key: 'chat.autoCompactThreshold',
    category: 'chat',
    kind: 'number',
    label: 'Automatic compaction threshold',
    description: 'Context-window ratio for Copilot native compaction. Use 0.8 for 80%; must be greater than 0 and at most 1. Copilot absolute-token thresholds are not used.',
    defaultValue: 0.8,
    minimum: 0,
    maximum: 1,
  },
  {
    key: 'chat.agentDirectories',
    category: 'chat',
    kind: 'array',
    label: 'Additional agent directories',
    description: 'Newline-separated custom-agent directories to scan. Complements VS Code chat.agentFilesLocations.',
    defaultValue: [],
  },
  {
    key: 'refine.toolsInclude',
    category: 'tools',
    kind: 'array',
    label: 'Refine tools allowlist',
    description: 'Optional newline-separated tool IDs allowed during Refine. Empty means unrestricted.',
    defaultValue: [],
  },
  {
    key: 'chat.toolsExclude',
    category: 'tools',
    kind: 'array',
    label: 'Tools excluded from chat',
    description: 'Newline-separated tool IDs denied on every prompt injection.',
    defaultValue: ['memory', 'resolveMemoryFileUri'],
  },
  {
    key: 'chat.modelSelector',
    category: 'tools',
    kind: 'modelSelector',
    label: 'Chat model selector',
    description: 'Optional model id and vendor used to pin a model for each run.',
    defaultValue: {},
  },
  {
    key: 'chat.agentNames',
    category: 'agents',
    kind: 'agentNames',
    label: 'Agent assignments',
    description: 'Per-column agent labels. Use the workflow-column editor below; legacy refine/develop/validate keys remain supported.',
    defaultValue: {},
  },
  {
    key: 'run.timeoutMinutes',
    category: 'run',
    kind: 'number',
    label: 'Run timeout (minutes)',
    description: 'Mark a run failed after this many minutes.',
    defaultValue: 20,
    minimum: 0,
  },
  {
    key: 'run.maxParallelTasks',
    category: 'run',
    kind: 'number',
    label: 'Maximum parallel runs',
    description: 'Maximum Refine, Split, Develop, Continue, and Validate runs active at once.',
    defaultValue: 1,
    minimum: 1,
    integer: true,
  },
  {
    key: 'board.openOnStartup',
    category: 'workspace',
    kind: 'boolean',
    label: 'Open board on startup',
    description: 'Open the board when the workspace loads. Requires a window reload to apply.',
    defaultValue: false,
    requiresReload: true,
  },
  {
    key: 'layout.dockChat',
    category: 'layout',
    kind: 'boolean',
    label: 'Dock task chat',
    description: "Open the selected task's chat beside the board when docking is requested.",
    defaultValue: true,
  },
  {
    key: 'layout.dockChatOnSelect',
    category: 'layout',
    kind: 'boolean',
    label: 'Dock chat when selecting a card',
    description: 'Automatically dock a task chat as soon as its card is selected.',
    defaultValue: false,
  },
  {
    key: 'chat.allowTaskProposals',
    category: 'chat',
    kind: 'boolean',
    label: 'Allow task proposals',
    description: 'Let Develop and Validate runs file follow-up work as new backlog tasks.',
    defaultValue: true,
  },
];

/** Complete current package.json inventory, including the structured agent setting. */
export const ALL_KANBAN_SETTING_KEYS: readonly string[] = [
  'tasksDir',
  ...GATES.map((gate) => gate.setting),
  'chat.mode',
  'chat.sessionPrefix',
  'chat.closeTabOnDone',
  'chat.resetOnApprove',
  'chat.autoCompact',
  'chat.autoCompactThreshold',
  'chat.agentDirectories',
  'refine.toolsInclude',
  'chat.toolsExclude',
  'chat.modelSelector',
  'chat.agentNames',
  'run.timeoutMinutes',
  'run.maxParallelTasks',
  'board.openOnStartup',
  'layout.dockChat',
  'layout.dockChatOnSelect',
  'chat.allowTaskProposals',
];

export interface SettingValidationSuccess {
  ok: true;
  value: unknown;
}

export interface SettingValidationFailure {
  ok: false;
  error: string;
}

export type SettingValidationResult = SettingValidationSuccess | SettingValidationFailure;

function settingDefinitionFor(key: unknown): SettingDefinition | undefined {
  return typeof key === 'string' ? SETTING_DEFINITIONS.find((definition) => definition.key === key) : undefined;
}

export function isEditableSettingKey(value: unknown): value is string {
  return !!settingDefinitionFor(value);
}

export function isGateSettingKey(value: unknown): boolean {
  return settingDefinitionFor(value)?.category === 'gates';
}

export function settingRequiresReload(value: unknown): boolean {
  return settingDefinitionFor(value)?.requiresReload === true;
}

function validText(value: unknown, label: string, maxLength: number): SettingValidationResult {
  if (typeof value !== 'string') {
    return { ok: false, error: `${label} must be text.` };
  }
  if (/[\r\n]/.test(value)) {
    return { ok: false, error: `${label} cannot contain line breaks.` };
  }
  if (value.length > maxLength) {
    return { ok: false, error: `${label} must be ${maxLength} characters or fewer.` };
  }
  return { ok: true, value: value.trim() };
}

export function validateSettingValue(key: unknown, rawValue: unknown): SettingValidationResult {
  const definition = settingDefinitionFor(key);
  if (!definition) {
    return { ok: false, error: 'Unknown Kanban Pilot setting.' };
  }

  switch (definition.kind) {
    case 'string': {
      const value = validText(rawValue, definition.label, definition.maxLength ?? 240);
      if (!value.ok) {
        return value;
      }
      if (definition.key === 'tasksDir') {
        if (typeof value.value !== 'string' || !value.value) {
          return { ok: false, error: 'Task folder cannot be blank.' };
        }
        if (/^(?:[A-Za-z]:[\\/]|[\\/]{1,2})/.test(value.value) || value.value.split(/[\\/]/).includes('..')) {
          return { ok: false, error: 'Task folder must be a workspace-relative path.' };
        }
      }
      if (definition.key === 'chat.sessionPrefix' && !value.value) {
        return { ok: false, error: 'Session ID prefix cannot be blank.' };
      }
      return value;
    }
    case 'enum':
      return typeof rawValue === 'string' && definition.options?.includes(rawValue)
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${definition.label} has an invalid choice.` };
    case 'boolean':
      return typeof rawValue === 'boolean'
        ? { ok: true, value: rawValue }
        : { ok: false, error: `${definition.label} must be enabled or disabled.` };
    case 'number':
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) {
        return { ok: false, error: `${definition.label} must be a finite number.` };
      }
      if (definition.integer && !Number.isInteger(rawValue)) {
        return { ok: false, error: `${definition.label} must be a whole number.` };
      }
      if (definition.minimum !== undefined && rawValue <= definition.minimum) {
        return { ok: false, error: `${definition.label} must be greater than ${definition.minimum}.` };
      }
      if (definition.maximum !== undefined && rawValue > definition.maximum) {
        return { ok: false, error: `${definition.label} must be at most ${definition.maximum}.` };
      }
      return { ok: true, value: rawValue };
    case 'array':
      if (!Array.isArray(rawValue) || rawValue.some((value) => typeof value !== 'string')) {
        return { ok: false, error: `${definition.label} must be a list of text values.` };
      }
      if (rawValue.some((value) => /[\r\n]/.test(value) || value.length > 200)) {
        return { ok: false, error: `${definition.label} contains an invalid value.` };
      }
      return { ok: true, value: rawValue.map((value) => value.trim()).filter(Boolean) };
    case 'modelSelector': {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return { ok: false, error: `${definition.label} must contain optional id and vendor text fields.` };
      }
      const candidate = rawValue as Record<string, unknown>;
      const unknownKeys = Object.keys(candidate).filter((candidateKey) => candidateKey !== 'id' && candidateKey !== 'vendor');
      if (unknownKeys.length || ['id', 'vendor'].some((field) => candidate[field] !== undefined && typeof candidate[field] !== 'string')) {
        return { ok: false, error: `${definition.label} only accepts optional id and vendor text fields.` };
      }
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const vendor = typeof candidate.vendor === 'string' ? candidate.vendor.trim() : '';
      if (/[\r\n]/.test(id) || /[\r\n]/.test(vendor) || id.length > 200 || vendor.length > 200) {
        return { ok: false, error: `${definition.label} fields must be 200 characters or fewer without line breaks.` };
      }
      return { ok: true, value: { ...(id ? { id } : {}), ...(vendor ? { vendor } : {}) } };
    }
    case 'agentNames': {
      if (!rawValue || typeof rawValue !== 'object' || Array.isArray(rawValue)) {
        return { ok: false, error: `${definition.label} must be an object.` };
      }
      const candidate = rawValue as Record<string, unknown>;
      for (const [agentKey, agentValue] of Object.entries(candidate)) {
        if (!['backlog', 'refine', 'scoped', 'approved', 'in-progress', 'validation', 'done', 'develop', 'validate'].includes(agentKey)) {
          return { ok: false, error: `${definition.label} contains an unknown column.` };
        }
        if (!isAgentNameValue(agentValue)) {
          return { ok: false, error: `${definition.label} contains an invalid agent name.` };
        }
      }
      return { ok: true, value: Object.fromEntries(
        Object.entries(candidate)
          .map(([agentKey, agentValue]) => [agentKey, (agentValue as string).trim()])
          .filter(([, agentValue]) => agentValue),
      ) };
    }
  }
}

function defaultSettingValue(value: unknown): unknown {
  return Array.isArray(value) ? [...value] : value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : value;
}

export function settingsValuesFor(
  configuration: Pick<vscode.WorkspaceConfiguration, 'get'>,
): Record<string, unknown> {
  return Object.fromEntries(SETTING_DEFINITIONS.map((definition) => {
    const configured = configuration.get<unknown>(definition.key, defaultSettingValue(definition.defaultValue));
    const validated = validateSettingValue(definition.key, configured);
    return [definition.key, validated.ok ? validated.value : defaultSettingValue(definition.defaultValue)];
  }));
}

export async function persistSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'update'>,
  key: string,
  rawValue: unknown,
): Promise<SettingValidationResult> {
  const validated = validateSettingValue(key, rawValue);
  if (!validated.ok) {
    return validated;
  }
  await configuration.update(key, validated.value, vscode.ConfigurationTarget.Workspace);
  return validated;
}

export async function resetSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'update'>,
  key: string,
): Promise<boolean> {
  if (!isEditableSettingKey(key)) {
    return false;
  }
  await configuration.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  return true;
}

export const SETTINGS_COLUMNS: readonly { id: Column; label: string }[] = COLUMNS.map((id) => ({
  id,
  label: COLUMN_LABELS[id],
}));

export interface SettingsState {
  gates: Record<string, string>;
  agents: Record<Column, string>;
  availableAgents: CopilotAgentOption[];
  /**
   * Names VS Code has a registered open action for. An assignment outside this
   * set still renders the badge and the prompt persona line, but cannot change
   * which agent executes the turn, so the UI must not imply that it does.
   */
  selectableAgents: string[];
  values: Record<string, unknown>;
}

export function isGateKey(value: unknown): value is string {
	return typeof value === 'string' && GATES.some((g) => g.key === value);
}

export function isAgentColumn(value: unknown): value is Column {
  return typeof value === 'string' && (COLUMNS as readonly string[]).includes(value);
}

export function isAgentNameValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 60 && !/[\r\n]/.test(value);
}

export function updateAgentNameOverrides(
  configured: unknown,
  column: Column,
  rawValue: string,
): AgentNameOverrides {
  const overrides: AgentNameOverrides = configured && typeof configured === 'object' && !Array.isArray(configured)
    ? { ...(configured as AgentNameOverrides) }
    : {};
  const value = rawValue.trim();
  const legacyStage = stageForColumn(column);
  if (value) {
    overrides[column] = value;
    if (legacyStage && legacyStage !== column) {
      delete overrides[legacyStage];
    }
  } else {
    delete overrides[column];
    if (legacyStage) {
      delete overrides[legacyStage];
    }
  }
  return overrides;
}

export async function persistAgentNameOverride(
  configuration: Pick<vscode.WorkspaceConfiguration, 'update'>,
  configured: unknown,
  column: Column,
  rawValue: string,
): Promise<void> {
  await configuration.update(
    'chat.agentNames',
    updateAgentNameOverrides(configured, column, rawValue),
    vscode.ConfigurationTarget.Workspace,
  );
}

export function updateAgentNameOverridesBatch(
  configured: unknown,
  assignments: Partial<Record<Column, string>>,
): AgentNameOverrides {
  let overrides = configured;
  for (const column of COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(assignments, column)) {
      overrides = updateAgentNameOverrides(overrides, column, assignments[column] ?? '');
    }
  }
  return overrides as AgentNameOverrides;
}

export async function persistAgentNameOverrides(
  configuration: Pick<vscode.WorkspaceConfiguration, 'update'>,
  configured: unknown,
  assignments: Partial<Record<Column, string>>,
): Promise<void> {
  await configuration.update(
    'chat.agentNames',
    updateAgentNameOverridesBatch(configured, assignments),
    vscode.ConfigurationTarget.Workspace,
  );
}

export async function persistGateSetting(
  configuration: Pick<vscode.WorkspaceConfiguration, 'update'>,
  key: string,
  value: 'manual' | 'auto',
): Promise<boolean> {
  const gate = GATES.find((candidate) => candidate.key === key);
  if (!gate) {
    return false;
  }
  await configuration.update(gate.setting, value, vscode.ConfigurationTarget.Workspace);
  return true;
}

export function settingsStateFor(
  gates: Record<string, string>,
  agentNames: AgentNameOverrides,
  availableAgents: readonly CopilotAgentOption[] = [],
  values: Record<string, unknown> = {},
  selectableAgents: readonly string[] = [],
): SettingsState {
  return {
    gates: { ...gates },
    agents: Object.fromEntries(
      COLUMNS.map((column) => [column, agentLabelFor(column, agentNames)]),
    ) as Record<Column, string>,
    availableAgents: availableAgents.map((agent) => ({ ...agent })),
    selectableAgents: [...selectableAgents],
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, defaultSettingValue(value)])),
  };
}

export class BoardPanel {
	public static readonly viewType = 'kanbanPilot.board';
	private static current: BoardPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
  private readonly surface: BoardSurface;
  private disposed = false;
	private selectedTaskId: string | undefined;
  private taskWatcher: vscode.Disposable | undefined;
  private webviewReady = false;
  private pendingNewTaskOpen = false;
  private taskRefreshInProgress = false;
  private taskRefreshPending = false;

	private constructor(
    surface: BoardSurface | vscode.WebviewPanel,
    private readonly host: BoardTaskSetHost,
    private readonly extensionUri: vscode.Uri,
	) {
    this.surface = 'contentSecurityPolicy' in surface ? surface : new WebviewPanelSurface(surface);
    this.configureWebview();

		this.disposables.push(
      this.surface.onDidReceiveMessage((message) => this.onMessage(message as InMessage)),
      this.host.onDidChange((change) => {
        if (change?.kind === 'activity') {
          void this.pushWorkspaceActivity();
          return;
        }
        if (change?.kind === 'task') {
          void this.pushBoard();
          if (change.taskId === this.selectedTaskId) {
            void this.pushDetail(true);
          }
          return;
        }
        if (change?.kind === 'attachment' || change?.kind === 'run') {
          if (!change.taskId || change.taskId === this.selectedTaskId) {
            void this.pushDetail(true);
          }
          return;
        }
        this.selectedTaskId = undefined;
        this.configureWebview();
        this.bindTaskWatcher();
        void this.pushAll();
      }),
			// Picks up a hand-edited settings.json too, not just the board's own toggle.
			vscode.workspace.onDidChangeConfiguration((e) => {
        const settingsChanged = e.affectsConfiguration('kanbanPilot');
        const gatesChanged = e.affectsConfiguration('kanbanPilot.gates');
        const agentsChanged = e.affectsConfiguration('kanbanPilot.chat.agentNames');
        const agentLocationsChanged = e.affectsConfiguration('chat.agentFilesLocations');
        if (settingsChanged || agentsChanged || agentLocationsChanged) {
          void this.pushAll();
          if (gatesChanged) {
            void this.runManager.applyGatePolicies();
          }
        }
			}),
      this.surface.onDidDispose(() => this.dispose()),
      this.surface.onDidBecomeVisible(() => void this.pushAll()),
		);
    this.surface.setHtml(this.html());
    this.bindTaskWatcher();
    void this.host.ready
      .then(() => {
        this.bindTaskWatcher();
        return this.pushAll();
      })
      .catch(() => undefined);
	}

  private get store(): TaskStore {
    return this.host.store;
  }

  private get runManager(): RunManager {
    return this.host.runManager;
  }

  private configureWebview(): void {
    this.surface.setLocalResourceRoots([this.extensionUri, this.store.directory]);
  }

  /** Opens the canonical attachment-capable New Task modal from a command. */
  openNewTask(): void {
    this.pendingNewTaskOpen = true;
    if (this.webviewReady) {
      this.pendingNewTaskOpen = false;
      void this.surface.postMessage({ type: 'newTask/open' });
    }
  }

  private bindTaskWatcher(): void {
    this.taskWatcher?.dispose();
    this.taskWatcher = this.store.watch(() => this.queueTaskRefresh());
  }

  /** Coalesces disk watcher bursts without resetting unrelated client state. */
  private queueTaskRefresh(): void {
    this.taskRefreshPending = true;
    if (this.taskRefreshInProgress) {
      return;
    }

    this.taskRefreshInProgress = true;
    void (async () => {
      try {
        while (this.taskRefreshPending && !this.disposed) {
          this.taskRefreshPending = false;
          await this.pushBoard();
          await this.pushDetail(true);
        }
      } finally {
        this.taskRefreshInProgress = false;
      }
    })();
  }

	static show(
    host: BoardTaskSetHost,
		extensionUri: vscode.Uri,
		column = vscode.ViewColumn.One,
	): BoardPanel {
		if (BoardPanel.current) {
      BoardPanel.current.surface.reveal?.(column);
			void BoardPanel.current.pushAll();
			return BoardPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(BoardPanel.viewType, 'Kanban Pilot', column, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'activity-icon.svg');

    BoardPanel.current = new BoardPanel(new WebviewPanelSurface(panel), host, extensionUri);
		return BoardPanel.current;
	}

  /** Attaches the shared board document to a non-editor presentation surface. */
  static attach(surface: BoardSurface, host: BoardTaskSetHost, extensionUri: vscode.Uri): BoardPanel {
    return new BoardPanel(surface, host, extensionUri);
  }

	private async onMessage(message: InMessage): Promise<void> {
    if (!message || typeof message !== 'object') {
      return;
    }
		switch (message.type) {
			case 'board/ready':
        await this.host.ready;
				await this.pushAll();
        this.webviewReady = true;
        if (this.pendingNewTaskOpen) {
          this.pendingNewTaskOpen = false;
          await this.surface.postMessage({ type: 'newTask/open' });
        }
				return;

      case 'taskSet/select':
        if (message.taskSetId) {
          try {
            await this.host.switchTaskSet(message.taskSetId);
          } catch (error) {
            void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
            await this.pushAll();
          }
        }
        return;

      case 'taskSet/create': {
        const name = await vscode.window.showInputBox({
          prompt: 'Task-set name',
          placeHolder: 'e.g. Mobile app release',
          validateInput: (value) => (value.trim() ? undefined : 'Task-set name cannot be blank.'),
        });
        if (!name) {
          return;
        }
        try {
          await this.host.createTaskSet(name);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        return;
    }

      case 'taskSet/rename': {
        const name = await vscode.window.showInputBox({
          prompt: 'Rename task set',
          value: this.host.activeSet.name,
          validateInput: (value) => (value.trim() ? undefined : 'Task-set name cannot be blank.'),
        });
        if (!name) {
          return;
        }
        try {
          await this.host.renameTaskSet(name);
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        return;
      }

      case 'taskSet/delete': {
        const confirmed = await vscode.window.showWarningMessage(
          `Delete task set '${this.host.activeSet.name}'? Only an empty set can be deleted.`,
          { modal: true },
          'Delete',
        );
        if (confirmed !== 'Delete') {
          return;
        }
        try {
          await this.host.deleteTaskSet();
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        return;
      }

			case 'task/open':
        if (message.taskId && this.surface.hostEditor) {
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

      case 'task/reorder': {
        const target = Object.prototype.hasOwnProperty.call(message, 'beforeTaskId')
          ? { beforeTaskId: message.beforeTaskId }
          : { targetIndex: message.targetIndex };
        const outcome = await this.runManager.reorderTask(message.taskId, message.column, target);
        const snapshot = await this.store.snapshot();
        await this.pushAll();
        const column = snapshot.columns.find((candidate) => candidate.id === message.column);
        const index = column?.tasks.findIndex((task) => task.id === message.taskId) ?? -1;
        await this.surface.postMessage({
          type: 'task/reorderResult',
          taskId: message.taskId,
          result: outcome.kind,
          index,
          count: column?.tasks.length ?? 0,
        });
        return;
      }

			case 'task/select':
				this.selectedTaskId = message.taskId;
				await this.pushDetail();
        if (message.taskId && this.surface.hostEditor) {
					// §6.10: off by default — selecting a card only opens the detail
					// pane. Docking the chat is an explicit act (the pane's "Open
					// Chat" button, or a stage run's own open+inject), not a side
					// effect of browsing cards.
					void this.runManager.dockTaskChat(message.taskId, { onSelect: true });
				}
				return;

      case 'task/openChat':
        if (message.taskId && this.surface.hostEditor) {
          void this.runManager.dockTaskChat(message.taskId, { onSelect: false, explicit: true });
				}
				return;

			case 'task/deselect':
				this.selectedTaskId = undefined;
				await this.pushDetail();
				return;

			case 'task/create': {
				const title = message.title?.trim();
        if (!title || !isTaskType(message.taskType)) {
					return;
				}
        try {
          const task = await this.store.create(title, {
            type: message.taskType,
            request: message.description?.trim(),
            parentTaskId: message.parentTaskId as string | undefined,
            attachments: message.attachments as TaskAttachmentChanges | undefined,
          });
          this.selectedTaskId = task.id;
          // The watcher fires from this same write, but selection changed
          // independently of disk state, so push explicitly rather than wait.
          await this.pushAll();
          await this.surface.postMessage({ type: 'task/createSuccess', taskId: task.id });
        } catch (error) {
          await this.reportCreateError(error instanceof Error ? error.message : String(error));
        }
				return;
			}

      case 'task/edit': {
        if (typeof message.taskId !== 'string' || !message.taskId.trim()) {
          await this.reportEditError(undefined, 'A task id is required to save an edit.');
          return;
        }
        try {
          const content = normalizeEditableTaskContent(message.content);
          await this.store.edit(
            message.taskId,
            content,
            message.attachments as TaskAttachmentChanges | undefined,
          );
          // The edit mutation is authoritative on disk. Push immediately so
          // the card and detail are fresh even before the watcher callback.
          await this.pushAll();
        } catch (error) {
          await this.reportEditError(
            message.taskId,
            error instanceof Error ? error.message : String(error),
          );
        }
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
        try {
          const deleted = await deleteTask(this.store, task.id, task.title);
          if (deleted && this.selectedTaskId === task.id) {
            this.selectedTaskId = undefined;
          }
        } catch (error) {
          void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
				// deleteTask's own fs.delete triggers the watcher; nothing further to do.
				return;
			}

			case 'action/invoke': {
				if (!message.taskId || !isTaskAction(message.action)) {
					return;
				}
        await invokeBoardAction(this.runManager, message.taskId, message.action);
				return;
			}

      case 'pending/apply':
        if (typeof message.taskId === 'string') {
          let activityLevel: 'warning' | 'error' | undefined;
          let activityMessage: string | undefined;
          try {
            const result = await this.runManager.applyPendingOutcome(message.taskId);
            if (result.kind === 'no-pending') {
              activityLevel = 'warning';
              activityMessage = 'Pending completion was not applied because no pending outcome is available.';
            } else if (result.kind === 'not-found') {
              activityLevel = 'warning';
              activityMessage = `Pending completion was not applied because ${message.taskId} was not found.`;
            } else if (result.kind === 'stale') {
              activityLevel = 'warning';
              activityMessage = 'Pending completion was not applied because the task or receipt changed.';
            }
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            activityLevel = 'error';
            activityMessage = `Pending completion could not be applied: ${detail}`;
            void vscode.window.showErrorMessage(activityMessage);
          } finally {
            await this.pushAll();
          }
          if (activityLevel && activityMessage) {
            await this.recordWorkspaceActivity({
              level: activityLevel,
              message: activityMessage,
              taskId: message.taskId,
            });
          }
        }
        return;

      case 'stale/recover': {
        if (
          typeof message.taskId !== 'string' ||
          !/^TASK-\d+$/.test(message.taskId) ||
          typeof message.runId !== 'string' ||
          !/^[A-Za-z0-9._:/-]+$/.test(message.runId) ||
          !isRecoveryStage(message.stage)
        ) {
          return;
        }

        const candidates = await this.runManager.listStaleCompletionCandidates(message.taskId);
        const candidate = candidates.find((item) =>
          item.taskId === message.taskId && item.runId === message.runId && item.stage === message.stage,
        );
        if (!candidate) {
          await this.pushAll();
          await this.recordWorkspaceActivity({
            level: 'warning',
            message: 'Recovery was not applied because the selected stale completion is no longer eligible.',
            taskId: message.taskId,
          });
          return;
        }

        const confirmed = await vscode.window.showWarningMessage(
          `Recover ${candidate.stage} completion for ${candidate.taskId} from old run ${candidate.runId}? Current run: ${candidate.currentRunId ?? 'none'}. Latest run: ${candidate.latestRunId ?? 'none'}. Receipt: ${candidate.summary}`,
          { modal: true },
          'Recover',
        );
        if (confirmed !== 'Recover') {
          return;
        }

        let activityLevel: 'success' | 'warning' | 'error' | undefined;
        let activityMessage: string | undefined;
        try {
          const result = await this.runManager.recoverStaleCompletion(
            candidate.taskId,
            candidate.runId,
            candidate.stage,
          );
          if (result.kind === 'recovered') {
            activityLevel = 'success';
            activityMessage = `Recovered ${candidate.stage} completion from old run ${candidate.runId}${result.gate ? ` and applied ${result.gate}` : ''}.`;
          } else if (result.kind === 'active-run') {
            activityLevel = 'warning';
            activityMessage = 'Recovery was not applied because a newer run is active.';
            void vscode.window.showWarningMessage('Recovery was not applied because a newer run is active.');
          } else if (result.kind === 'pending-outcome') {
            activityLevel = 'warning';
            activityMessage = 'Recovery was not applied because a completion is already waiting for review.';
            void vscode.window.showWarningMessage('Recovery was not applied because a completion is already waiting for review.');
          } else if (result.kind === 'not-found') {
            activityLevel = 'warning';
            activityMessage = 'Recovery was not applied because the task was not found.';
            void vscode.window.showWarningMessage('Recovery was not applied because the task was not found.');
          } else {
            activityLevel = 'warning';
            activityMessage = 'Recovery was not applied because the selected completion is stale or no longer eligible.';
            void vscode.window.showWarningMessage('Recovery was not applied because the selected completion is stale.');
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          activityLevel = 'error';
          activityMessage = `Recovery could not be applied: ${detail}`;
          void vscode.window.showErrorMessage(activityMessage);
        } finally {
          await this.pushAll();
        }
        if (activityLevel && activityMessage) {
          await this.recordWorkspaceActivity({
            level: activityLevel,
            message: activityMessage,
            taskId: candidate.taskId,
          });
        }
        return;
      }

			case 'gates/set': {
				if (!isGateKey(message.key) || (message.value !== 'manual' && message.value !== 'auto')) {
					return;
				}
        await persistGateSetting(
          vscode.workspace.getConfiguration('kanbanPilot'),
          message.key,
          message.value,
        );
        // onDidChangeConfiguration already refreshes Settings; applying
				// immediately (rather than waiting for the next store change) means
				// flipping a gate to auto acts on whatever's already sitting idle.
				await this.runManager.applyGatePolicies();
				return;
			}

      case 'settings/refresh':
        await this.pushSettings();
        return;

      case 'workspaceActivity/refresh':
        if (!message.taskSetId || message.taskSetId === this.host.activeSet.id) {
          await this.pushWorkspaceActivity();
        }
        return;

      case 'settings/set': {
        if (typeof message.key !== 'string') {
          return;
        }
        const result = await persistSetting(
          vscode.workspace.getConfiguration('kanbanPilot'),
          message.key,
          message.value,
        );
        if (!result.ok) {
          await this.reportSettingsError(message.key, result.error);
          return;
        }
        if (isGateSettingKey(message.key)) {
          await this.runManager.applyGatePolicies();
        }
        return;
      }

      case 'settings/save': {
        if (!message.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
          await this.reportSettingsError(undefined, 'Settings payload must be an object.');
          return;
        }
        const values = message.values as Record<string, unknown>;
        const validated = Object.entries(values).map(([key, value]) => ({
          key,
          result: validateSettingValue(key, value),
        }));
        const invalid = validated.find((entry) => !entry.result.ok);
        if (invalid && !invalid.result.ok) {
          await this.reportSettingsError(invalid.key, invalid.result.error);
          return;
        }
        const cfg = vscode.workspace.getConfiguration('kanbanPilot');
        for (const entry of validated) {
          if (entry.result.ok) {
            await cfg.update(entry.key, entry.result.value, vscode.ConfigurationTarget.Workspace);
          }
        }
        if (validated.some((entry) => isGateSettingKey(entry.key))) {
          await this.runManager.applyGatePolicies();
        }
        return;
      }

      case 'settings/reset': {
        if (typeof message.key !== 'string' || !(await resetSetting(vscode.workspace.getConfiguration('kanbanPilot'), message.key))) {
          return;
        }
        if (isGateSettingKey(message.key)) {
          await this.runManager.applyGatePolicies();
        }
        return;
      }

      case 'agents/save': {
        if (!message.values || typeof message.values !== 'object' || Array.isArray(message.values)) {
          await this.reportSettingsError('chat.agentNames', 'Agent assignments payload must be an object.');
          return;
        }
        const values = message.values as Record<string, unknown>;
        const missing = COLUMNS.find((column) => !Object.prototype.hasOwnProperty.call(values, column));
        if (missing) {
          await this.reportSettingsError('chat.agentNames', `Agent assignments payload is missing ${missing}.`);
          return;
        }
        const invalid = Object.entries(values).find(([column, value]) => (
          !isAgentColumn(column) || !isAgentNameValue(value)
        ));
        if (invalid) {
          await this.reportSettingsError(
            'chat.agentNames',
            `Invalid agent assignment for ${invalid[0]}.`,
          );
          return;
        }
        const cfg = vscode.workspace.getConfiguration('kanbanPilot');
        await persistAgentNameOverrides(
          cfg,
          cfg.get<unknown>('chat.agentNames', {}),
          values as Partial<Record<Column, string>>,
        );
        // One configuration update lets onDidChangeConfiguration refresh the
        // board and Settings together without exposing partial assignments.
        return;
      }

			case 'agentName/set': {
        if (!isAgentColumn(message.column) || !isAgentNameValue(message.value)) {
					return;
				}
				const cfg = vscode.workspace.getConfiguration('kanbanPilot');
        const configured = cfg.get<unknown>('chat.agentNames', {});
        await persistAgentNameOverride(cfg, configured, message.column, message.value);
        // onDidChangeConfiguration re-pushes the board and Settings with the new label.
				return;
			}
		}
	}

	private async pushAll(): Promise<void> {
		await this.pushBoard();
		await this.pushDetail();
    await this.pushSettings();
    await this.pushWorkspaceActivity();
	}

  private configuredAgentNames(): AgentNameOverrides {
    const configured = vscode.workspace
      .getConfiguration('kanbanPilot')
      .get<unknown>('chat.agentNames', {});
    return configured && typeof configured === 'object' && !Array.isArray(configured)
      ? configured as AgentNameOverrides
      : {};
  }

	private async pushBoard(): Promise<void> {
		const snapshot = await this.store.snapshot();
    const taskSets = await this.host.listTaskSets();
    const agentNames = this.configuredAgentNames();
    const staleCompletions = await this.runManager.listStaleCompletionCandidates();
    await this.surface.postMessage({
			type: 'board/state',
      snapshot: this.toView(snapshot, agentNames, taskSets, staleCompletions),
			selectedTaskId: this.selectedTaskId,
		});
	}

  /**
   * Tailed Copilot activity, when the user has opted in. A remote viewer needs a
   * second opt-in: the browser endpoint is shared with everyone holding its
   * link, so enabling the local pane must not widen what that link exposes.
   *
   * The entries are a record, not a live view — Copilot flushes its transcript
   * in batches, so tool activity can lag by seconds to a minute (TASK-009).
   */
  private transcriptFeedSnapshot(taskId: string): FeedSourceSnapshot {
    const cfg = vscode.workspace.getConfiguration('kanbanPilot');
    if (!cfg.get<boolean>('chat.transcriptFeed', false)) {
      return { availability: 'not-configured', entries: [] };
    }
    if (!this.surface.hostEditor && !cfg.get<boolean>('chat.transcriptFeedRemote', false)) {
      return { availability: 'not-configured', entries: [] };
    }
    return this.host.runManager.transcriptTail?.snapshotFor(taskId, ACTIVITY_FEED_LIMIT)
      ?? { availability: 'not-configured', entries: [] };
  }

  /**
   * Real-time activity reported by the Copilot chat hook, if one is installed
   * and the feed is enabled. Unlike the transcript tail this arrives at the
   * moment of the event, which is what lets the browser board keep up.
   */
  private hookFeedSnapshot(taskId: string): FeedSourceSnapshot {
    const cfg = vscode.workspace.getConfiguration('kanbanPilot');
    if (!cfg.get<boolean>('chat.hookFeed', false)) {
      return { availability: 'not-configured', entries: [] };
    }
    if (!this.surface.hostEditor && !cfg.get<boolean>('chat.transcriptFeedRemote', false)) {
      return { availability: 'not-configured', entries: [] };
    }
    return this.host.runManager.hookSpool?.snapshotFor(taskId, ACTIVITY_FEED_LIMIT)
      ?? { availability: 'not-configured', entries: [] };
  }

  private async pushDetail(preserveOpenModal = false): Promise<void> {
		if (!this.selectedTaskId) {
      await this.surface.postMessage({ type: 'task/detail', task: null });
			return;
		}

		const { tasks } = await this.store.readAll();
		const task = tasks.find((t) => t.id === this.selectedTaskId);
		if (!task) {
			this.selectedTaskId = undefined;
      await this.surface.postMessage({ type: 'task/detail', task: null });
			return;
		}

    const detailSections = parseTaskDetailSections(task.body);
    const request = detailSections['Request'] ?? task.sections['Request'] ?? '';
    const refined = detailSections['Refined'] ?? task.sections['Refined'] ?? '';
    const scope = detailSections['Scope'] ?? task.sections['Scope'] ?? '';
    const log = detailSections['Log'] ?? task.sections['Log'] ?? '';
		const logLines = log.trim().split(/\r?\n/).filter(Boolean);
    const progressFeed = parseProgressEntries(log, task.id)
      .map((entry) => ({ ...entry, source: 'progress' as const }));
    // Hook entries are the real-time source; the transcript tail is 6-53 s behind
    // and reports the same tool calls, so its duplicates are dropped whenever the
    // hook feed has anything to say for this task.
    const hookSnapshot = this.hookFeedSnapshot(task.id);
    const transcriptSnapshot = this.transcriptFeedSnapshot(task.id);
    const hookFeed = hookSnapshot.entries;
    const transcriptFeed = transcriptSnapshot.entries;
    const feed = mergeFeedEntries(
      [...progressFeed, ...hookFeed],
      suppressDuplicatedTailEntries(transcriptFeed, hookFeed),
      ACTIVITY_FEED_LIMIT,
    );
    const cfg = vscode.workspace.getConfiguration('kanbanPilot');
    const remoteActivityAllowed = this.surface.hostEditor
      || cfg.get<boolean>('chat.transcriptFeedRemote', false);
    const activity = activityViewFor(
      progressFeed,
      hookSnapshot,
      transcriptSnapshot,
      {
        hookEnabled: cfg.get<boolean>('chat.hookFeed', false),
        transcriptEnabled: cfg.get<boolean>('chat.transcriptFeed', false),
        remoteAllowed: remoteActivityAllowed,
      },
    );
    const attachments = await this.store.listAttachments(task.id);
    const attachmentViews = attachments.map((attachment) => ({
      name: attachment.name,
      relativePath: attachment.relativePath,
      mimeType: attachment.mimeType,
      size: attachment.size,
      src: this.surface.resourceUri(attachment.uri),
    }));
    const staleCompletions: StaleCompletionCandidate[] = await this.runManager.listStaleCompletionCandidates(task.id);
    const taskTree = taskTreeFor(tasks, task.id);

    await this.surface.postMessage({
			type: 'task/detail',
      preserveOpenModal,
			task: {
				id: task.id,
				title: task.title,
        type: task.type,
        typeLabel: TASK_TYPE_LABELS[task.type],
				state: task.state,
				stateLabel: COLUMN_LABELS[task.state],
				status: task.status,
        canEdit: task.status !== 'running',
        request,
        refined,
        scope,
        requestHtml: renderTaskMarkdown(request, attachmentViews),
        refinedHtml: renderTaskMarkdown(refined, attachmentViews),
        scopeHtml: renderTaskMarkdown(scope, attachmentViews),
				lastLog: logLines.at(-1) ?? '',
        feed,
        activity,
				originTask: task.originTask,
        attachments: attachmentViews,
        pending: pendingView(task),
        staleCompletions,
        outcome: outcomeGuidanceFor(task, staleCompletions),
        moveTargets: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id] })),
				primary: primaryAction(task.state, task.status),
				...(taskTree ? { taskTree } : {}),
				// The card face shows one button (primary); this is where the
				// prototype's un-rendered secondary action (§5.2) lives instead.
				secondary: secondaryAction(task.state),
			},
		});
	}

  private async pushWorkspaceActivity(): Promise<void> {
    const activeSet = this.host.activeSet;
    const activityStore = this.host.workspaceActivity;
    const records = activityStore ? await activityStore.readAll() : [];
    if (this.host.activeSet !== activeSet || this.host.workspaceActivity !== activityStore) {
      return;
    }
    await this.surface.postMessage({
      type: 'workspaceActivity/state',
      activeTaskSetId: activeSet.id,
      activeTaskSetName: activeSet.name,
      records,
    });
  }

  private async reportEditError(taskId: string | undefined, error: string): Promise<void> {
    void vscode.window.showErrorMessage(error);
    await this.surface.postMessage({ type: 'task/editError', taskId, error });
  }

  private async recordWorkspaceActivity(
    input: WorkspaceActivityInput,
  ): Promise<void> {
    try {
      await this.host.workspaceActivity?.append(input);
    } catch {
      // Activity is an audit aid and must not hide the task/run result.
    }
  }

  private async reportCreateError(error: string): Promise<void> {
    await this.surface.postMessage({ type: 'task/createError', error });
  }

  private async reportSettingsError(key: string | undefined, error: string): Promise<void> {
    await this.surface.postMessage({ type: 'settings/error', key, error });
  }

  private async pushSettings(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		const gates = Object.fromEntries(GATES.map((g) => [g.key, cfg.get<string>(g.setting, 'manual')]));
    const values = settingsValuesFor(cfg);
    const agentNames = this.configuredAgentNames();
    const availableAgents = await discoverCopilotAgents({
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri),
      agentDirectories: cfg.get<unknown>('chat.agentDirectories', []),
      additionalLocations: vscode.workspace.getConfiguration('chat').get<unknown>('agentFilesLocations', {}),
    });
    // An assignment is honorable when it names an agent discovery actually found:
    // that is the same set VS Code resolves `mode` against. A stale or hand-typed
    // name outside it cannot select anything, and the UI must say so.
    const selectable = availableAgents.map((agent) => agent.name);
    await this.surface.postMessage({
      type: 'settings/state',
      ...settingsStateFor(gates, agentNames, availableAgents, values, selectable),
    });
	}

  private toView(
    snapshot: BoardSnapshot,
    agentNames: AgentNameOverrides,
    taskSets: TaskSet[],
    staleCompletions: readonly StaleCompletionCandidate[] = [],
  ) {
    const tasks = snapshot.columns.flatMap((column) => column.tasks);
    const parentTaskIds = new Set(
      tasks.flatMap((task) => task.parentTaskId === undefined ? [] : [task.parentTaskId]),
    );
    const parentOptions = tasks
      .map((task): ParentTaskOption => ({ id: task.id, name: task.title }))
      .sort((left, right) => compareTaskIds(left.id, right.id));
		return {
			malformed: snapshot.malformed,
      parentOptions,
      taskSets: taskSets.map((set) => ({ id: set.id, name: set.name, isDefault: set.isDefault })),
      activeTaskSetId: this.host.activeSet.id,
      activeTaskSetName: this.host.activeSet.name,
			columns: snapshot.columns.map((column) => ({
				id: column.id,
				label: COLUMN_LABELS[column.id],
				agent: agentLabelFor(column.id, agentNames),
        stage: COLUMN_STAGE(column.id) ?? null,
				count: column.tasks.length,
				cards: column.tasks.map((task: Task) => ({
					id: task.id,
					title: task.title,
          type: task.type,
          typeLabel: TASK_TYPE_LABELS[task.type],
					status: task.status,
					primary: primaryAction(task.state, task.status),
						originTask: task.originTask,
          hasChildren: parentTaskIds.has(task.id),
          ...(task.parentTaskId !== undefined ? { parentTaskId: task.parentTaskId } : {}),
          pending: pendingView(task),
          outcome: outcomeGuidanceFor(task, staleCompletions),
					canSplit: canSplit(task.state, task.status),
				})),
			})),
		};
	}

	dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (BoardPanel.current === this) {
      BoardPanel.current = undefined;
    }
    this.webviewReady = false;
    this.pendingNewTaskOpen = false;
    this.taskWatcher?.dispose();
    this.taskWatcher = undefined;
    this.surface.dispose();
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

    const mermaidRuntimeUri = this.surface.resourceUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'mermaid-runtime.js'),
    );
    const mermaidBridgeUri = this.surface.resourceUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'mermaid-webview.js'),
    );
    const csp = this.surface.contentSecurityPolicy(nonce);
    const bootstrapMarkup = this.surface.bootstrapMarkup?.(nonce) ?? '';

    const actionLabelsJson = JSON.stringify(ACTION_LABELS);
		const gatesJson = JSON.stringify(GATES);
    const columnsJson = JSON.stringify(SETTINGS_COLUMNS);
		const columnAgentDefaultsJson = JSON.stringify(COLUMN_AGENT_DEFAULT);
    const settingDefinitionsJson = JSON.stringify(SETTING_DEFINITIONS);
		// The detail modal is rendered from a task payload, not a column, so it
		// needs its own state → hue lookup to stay color-consistent with the board.
		const accentsJson = JSON.stringify(COLUMN_ACCENT);
    const boardFilterOptionsJson = JSON.stringify({
      types: [
        { value: 'all', label: 'All' },
        ...TASK_TYPES.map((type) => ({ value: type, label: TASK_TYPE_LABELS[type] })),
      ],
      statuses: [
        { value: 'all', label: 'All' },
        ...STATUSES.map((status) => ({ value: status, label: status.charAt(0).toUpperCase() + status.slice(1) })),
      ],
      relationships: [
        { value: 'all', label: 'All' },
        { value: 'parent', label: 'Parent' },
        { value: 'child', label: 'Child' },
        { value: 'standalone', label: 'Standalone' },
      ],
    });

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Kanban Pilot</title>
${bootstrapMarkup}
<style nonce="${nonce}">
  /*
   * Tokens below carry the prototype's shape language (radius, shadow depth,
   * spacing scale, type scale) verbatim; surface colors route through
   * --vscode-* so the board matches the editor's theme rather than the
   * prototype's fixed light palette. See module doc for the split.
   *
   * The color layer on top of that is built from one per-column hue (--col,
   * set inline from COLUMN_ACCENT) plus the four derived roles below. Every
   * role mixes --col against a theme token rather than a literal hex, which
   * is what lets a single saturated palette stay legible in both light and
   * dark themes:
   *   --col-tint    a wash of the hue over the current surface (fills)
   *   --col-line    the same hue held back to a border weight
   *   --col-text    the hue pulled toward --vscode-foreground until it has
   *                 text contrast — darkens on light themes, lightens on dark
   *   --col-glow    the hue at shadow strength, for hover lift
   * Components read the roles, never --col directly (except pure-chroma marks
   * like the dot and rail), so re-theming is a one-line change here.
   */
  :root {
    --kp-radius-column: 14px;
    --kp-radius-card: 12px;
    --kp-radius-button: 7px;
    --kp-radius-primary-button: 10px;
    --kp-shadow-card: 0 1px 3px rgba(0, 0, 0, 0.14);
    --kp-radius-modal: 16px;
    --kp-radius-chip: 6px;
    --kp-radius-modal-close: 8px;
    --kp-shadow-modal: 0 24px 64px rgba(0, 0, 0, 0.34);
    /* The brand pair. Deep on purpose: these are the only fills that carry
       white text (Proposed badge, modal primary, gate switch), and the
       brighter indigo/fuchsia they started as put white at ~3.5:1. */
    --kp-modal-accent: #4f46e5;
    --kp-modal-accent-2: #a21caf;
    --kp-gap-board: 10px;
    --kp-pad-page: 16px;
    --kp-pad-header: 14px 24px;
    --kp-pad-column: 12px;
    --kp-pad-card: 10px;
    --kp-gap-card: 8px;
    --kp-column-width: 234px;

    /* Fallback hue for anything rendered outside a column (modals, header). */
    --col: var(--kp-modal-accent);
    --col-to: var(--kp-modal-accent-2);
  }

  /*
   * Scoped to [style*="--col"] so it re-resolves per column: each of the four
   * roles is recomputed against whatever hue that column set inline.
   */
  .column, .modal, .card {
    --col-tint: color-mix(in srgb, var(--col) 12%, transparent);
    --col-line: color-mix(in srgb, var(--col) 42%, transparent);
    --col-glow: color-mix(in srgb, var(--col) 34%, transparent);
    /*
     * Text is the one role that can't take a stop straight: on a white editor
     * background the light end of this palette (sky, yellow) falls under 3:1,
     * so the label text is mixed from the *dark* stop toward the foreground.
     * See the dark-theme override below for why one expression can't serve
     * both.
     */
    --col-text: color-mix(in srgb, var(--col-to, var(--col)) 56%, var(--vscode-foreground));
  }

  /*
   * VS Code stamps vscode-light / vscode-dark / vscode-high-contrast on the
   * webview's body, which is what lets the text roles be tuned per theme
   * rather than compromised across both. It matters most for the darker hues:
   * even at full chroma, indigo #6366f1 only reaches 3.6:1 on a dark editor
   * background, so on dark the readable direction is the *bright* stop pulled
   * toward the foreground — the opposite of the light-theme rule above.
   *
   * The block above is the light-tuned default on purpose: if the class ever
   * goes away, the board degrades to slightly-low contrast on dark themes
   * rather than to something unreadable.
   */
  body.vscode-dark :is(.column, .modal, .card),
  body.vscode-high-contrast :is(.column, .modal, .card) {
    --col-text: color-mix(in srgb, var(--col) 56%, var(--vscode-foreground));
  }
  /* On dark surfaces a tinted chip *raises* the background luminance toward
     its own label, so the fills that sit under accent text are held back.
     :not(:hover) keeps this from out-specifying the solid hover fill below,
     which has white text and wants the full-chroma gradient. */
  body.vscode-dark :is(.count, button.action:not(:hover)),
  body.vscode-high-contrast :is(.count, button.action:not(:hover)) {
    background: color-mix(in srgb, var(--col) 10%, transparent);
  }
  /* Held back for the same reason, and it still reads as a step up from the
     10% resting fill above — on light themes it has to climb from 16%, so the
     base rule uses 30% there. */
  body.vscode-dark button.action:hover,
  body.vscode-high-contrast button.action:hover {
    background: color-mix(in srgb, var(--col) 18%, transparent);
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

  /*
   * The spectrum rail across the top is the board's legend: the seven column
   * hues in pipeline order, so the color coding is stated once at full
   * chroma before it appears diluted as tints further down.
   */
  header {
    position: relative;
    flex: none;
    display: flex; align-items: center; justify-content: space-between;
    min-width: 0;
    padding: var(--kp-pad-header);
    background:
      linear-gradient(120deg,
        color-mix(in srgb, #6366f1 10%, transparent),
        color-mix(in srgb, #d946ef 8%, transparent) 46%,
        color-mix(in srgb, #22c55e 9%, transparent)),
      var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  header::after {
    content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 3px;
    background: linear-gradient(90deg,
      #38bdf8, #6366f1 16%, #a855f7 33%, #ec4899 50%, #fb923c 66%, #facc15 83%, #22c55e);
  }
  h1 {
    font-size: 15px; font-weight: 800; margin: 0; letter-spacing: -0.01em;
    display: inline-flex; align-items: center; gap: 8px; min-width: 0;
  }
  /* Small gradient chip standing in for a logo, so the brand color is present
     even where the h1 text has to stay theme-colored for contrast. */
  h1::before {
    content: ''; width: 14px; height: 14px; border-radius: 5px; flex: none;
    background: linear-gradient(135deg, #38bdf8, #a855f7 50%, #ec4899);
    box-shadow: 0 0 10px color-mix(in srgb, #a855f7 55%, transparent);
  }
  .header-actions { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .task-set-controls { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
  .task-set-label { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .task-set-select {
    min-width: 150px; max-width: 220px; font-family: inherit; font-size: 12px;
    color: var(--vscode-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-button); padding: 7px 8px;
  }
  .task-set-btn {
    font-family: inherit; font-size: 11px; color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
    border-radius: var(--kp-radius-button); padding: 7px 8px; cursor: pointer;
  }
  .task-set-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
  .task-set-btn:disabled, .task-set-select:disabled { opacity: .55; cursor: not-allowed; }
  .board-filters {
    display: grid; grid-template-columns: minmax(220px, 1.5fr) repeat(3, minmax(120px, 1fr));
    align-items: end; gap: 10px; padding: 10px var(--kp-pad-page) 0;
    flex: none; min-width: 0;
  }
  .board-filter-query, .board-filter-control { display: flex; min-width: 0; flex-direction: column; gap: 5px; }
  .board-filter-query-row { display: flex; min-width: 0; gap: 6px; }
  .board-filter-label, .board-filter-control > span {
    color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase;
  }
  .board-filter-input, .board-filter-select {
    min-width: 0; width: 100%; padding: 7px 8px; font: inherit; font-size: 12px;
    color: var(--vscode-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-button);
  }
  .board-filter-input { flex: 1 1 auto; }
  .board-filter-input:focus-visible, .board-filter-select:focus-visible,
  .board-filter-clear:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .board-filter-clear {
    flex: none; padding: 7px 9px; font: inherit; font-size: 11px; color: var(--vscode-foreground);
    background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-panel-border);
    border-radius: var(--kp-radius-button); cursor: pointer;
  }
  .board-filter-clear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
  .board-filter-summary {
    grid-column: 1 / -1; min-height: 17px; color: var(--vscode-descriptionForeground);
    font-size: 11px; line-height: 1.35;
  }

  /* The one solid-gradient control on the board — it is the primary action,
     and nothing else competes with it at this chroma. */
  .new-task-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: linear-gradient(135deg, #4f46e5, #9333ea 55%, #db2777);
    color: #fff;
    border: none; border-radius: var(--kp-radius-primary-button);
    padding: 8px 14px; font-size: 13px; font-weight: 700; font-family: inherit;
    cursor: pointer;
    box-shadow: 0 2px 12px color-mix(in srgb, #9333ea 42%, transparent);
    transition: box-shadow .15s, transform .15s, filter .15s;
  }
  .new-task-btn:hover {
    filter: saturate(1.15) brightness(1.06);
    box-shadow: 0 4px 18px color-mix(in srgb, #9333ea 58%, transparent);
    transform: translateY(-1px);
  }
  .new-task-btn:active { transform: translateY(0); }

  .settings-btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: color-mix(in srgb, #6366f1 12%, var(--vscode-editorWidget-background));
    color: color-mix(in srgb, #6366f1 70%, var(--vscode-foreground));
    border: 1px solid color-mix(in srgb, #6366f1 38%, transparent);
    border-radius: var(--kp-radius-primary-button);
    padding: 8px 14px; font-size: 13px; font-weight: 600; font-family: inherit;
    cursor: pointer; transition: background .15s, border-color .15s;
  }
  .settings-btn:hover {
    background: color-mix(in srgb, #6366f1 22%, var(--vscode-editorWidget-background));
    border-color: color-mix(in srgb, #6366f1 60%, transparent);
  }

  /* §6.15's nine gate settings, toggled here instead of settings.json-only. */
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
  .switch input:checked + .switch-track {
    background: linear-gradient(135deg, var(--kp-modal-accent), var(--kp-modal-accent-2));
    border-color: transparent;
    box-shadow: 0 0 10px color-mix(in srgb, var(--kp-modal-accent-2) 50%, transparent);
  }
  .switch input:checked + .switch-track .switch-thumb { transform: translateX(14px); background: #fff; }
  .switch input:focus-visible + .switch-track { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .settings-modal { width: min(760px, 100vw - 32px); }
  .settings-head { align-items: flex-start; }
  .workspace-activity-modal { width: min(720px, 100vw - 32px); }
  .workspace-activity-body { min-height: 0; overflow-y: auto; padding: 18px; }
  .workspace-activity-toolbar {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border);
  }
  .workspace-activity-set { min-width: 0; }
  .workspace-activity-set-label {
    color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 700;
    letter-spacing: .04em; text-transform: uppercase;
  }
  .workspace-activity-set-name { margin-top: 3px; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
  .workspace-activity-refresh { flex: none; }
  .workspace-activity-state {
    color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.45;
    padding: 12px; border: 1px dashed var(--vscode-panel-border); border-radius: 8px;
  }
  .workspace-activity-state[hidden] { display: none; }
  .workspace-activity-list { display: flex; flex-direction: column; gap: 8px; }
  .workspace-activity-list[hidden] { display: none; }
  .workspace-activity-row {
    display: grid; grid-template-columns: minmax(155px, max-content) minmax(0, 1fr);
    gap: 12px; padding: 10px 0; border-top: 1px solid var(--vscode-panel-border);
  }
  .workspace-activity-row:first-child { padding-top: 0; border-top: none; }
  .workspace-activity-meta { min-width: 0; display: flex; flex-direction: column; gap: 5px; }
  .workspace-activity-time {
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
    font-size: 11px; line-height: 1.35; white-space: nowrap;
  }
  .workspace-activity-level {
    align-self: flex-start; padding: 2px 7px; border: 1px solid var(--vscode-panel-border);
    border-radius: 100px; color: var(--vscode-descriptionForeground); font-size: 10px;
    font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
  }
  .workspace-activity-row.success .workspace-activity-level { color: #4ade80; border-color: color-mix(in srgb, #4ade80 50%, transparent); }
  .workspace-activity-row.warning .workspace-activity-level { color: #fbbf24; border-color: color-mix(in srgb, #fbbf24 50%, transparent); }
  .workspace-activity-row.error .workspace-activity-level { color: var(--vscode-errorForeground); border-color: color-mix(in srgb, var(--vscode-errorForeground) 50%, transparent); }
  .workspace-activity-content { min-width: 0; }
  .workspace-activity-message { overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
  .workspace-activity-context {
    margin-top: 5px; color: var(--vscode-descriptionForeground); font-size: 11px;
    line-height: 1.35; overflow-wrap: anywhere;
  }
  .settings-body {
    display: grid; grid-template-columns: minmax(160px, .32fr) minmax(0, 1fr);
    min-height: 0; overflow: hidden; padding: 0;
  }
  .settings-sidebar {
    min-width: 0; padding: 18px 12px;
    background: color-mix(in srgb, var(--vscode-sideBar-background) 70%, transparent);
    border-right: 1px solid var(--vscode-panel-border);
  }
  .settings-sidebar-title {
    padding: 0 8px 8px; color: var(--vscode-descriptionForeground);
    font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  }
  .settings-category-list { display: flex; flex-direction: column; gap: 4px; }
  .settings-category {
    width: 100%; padding: 9px 10px; border: 1px solid transparent;
    border-radius: var(--kp-radius-button); background: transparent;
    color: var(--vscode-foreground); font: inherit; font-size: 12px;
    text-align: left; cursor: pointer; overflow-wrap: anywhere;
    transition: background .13s, border-color .13s, color .13s;
  }
  .settings-category:hover {
    background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15));
  }
  .settings-category:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px;
  }
  .settings-category[aria-selected="true"] {
    background: color-mix(in srgb, var(--kp-modal-accent) 16%, transparent);
    border-color: color-mix(in srgb, var(--kp-modal-accent) 48%, transparent);
    color: color-mix(in srgb, var(--kp-modal-accent) 70%, var(--vscode-foreground));
    font-weight: 700;
    box-shadow: inset 3px 0 var(--kp-modal-accent);
  }
  .settings-main { min-width: 0; min-height: 0; overflow-y: auto; }
  .settings-panel[hidden] { display: none; }
  .settings-panel { padding: 18px; }
  .settings-section { display: flex; flex-direction: column; gap: 8px; }
  .settings-section-title { font-size: 13px; font-weight: 700; }
  .settings-section-desc { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4; }
  .agent-settings-list { display: flex; flex-direction: column; }
  .agent-setting-row {
    display: grid; grid-template-columns: minmax(130px, 1fr) minmax(150px, 1.4fr) auto;
    align-items: center; gap: 10px; padding: 10px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .agent-setting-row:last-child { border-bottom: none; }
  .agent-setting-label { font-size: 13px; font-weight: 600; }
  .agent-setting-note {
    grid-column: 1 / -1;
    font-size: 12px;
    opacity: 0.8;
    color: var(--vscode-descriptionForeground);
  }
  .agent-setting-select {
    min-width: 0; font-family: inherit; font-size: 13px; color: var(--vscode-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-button); padding: 7px 8px;
  }
  .agent-setting-actions { display: inline-flex; gap: 6px; }
  .agent-setting-actions .btn-chip { padding: 7px 9px; }
  .agent-settings-actions { display: flex; justify-content: flex-end; gap: 7px; padding-top: 10px; }
  .agent-settings-error { margin-top: 8px; }
  .agent-setting-select:focus-visible, .agent-setting-actions button:focus-visible, .agent-settings-actions button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
  }
  .settings-fields { display: flex; flex-direction: column; gap: 12px; }
  .setting-row {
    display: flex; flex-direction: column; gap: 7px; padding: 12px 0;
    border-bottom: 1px solid var(--vscode-panel-border);
  }
  .setting-row:last-child { border-bottom: none; }
  .setting-label { font-size: 13px; font-weight: 600; }
  .setting-description {
    color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.4;
  }
  .setting-control { min-width: 0; }
  .setting-input, .setting-select, .setting-textarea {
    width: 100%; min-width: 0; font-family: inherit; font-size: 13px;
    color: var(--vscode-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--kp-radius-button); padding: 8px;
  }
  .setting-number { max-width: 180px; }
  .setting-textarea { min-height: 78px; resize: vertical; line-height: 1.4; }
  .setting-model-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .setting-model-field { display: flex; flex-direction: column; gap: 4px; }
  .setting-model-label { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .setting-input:focus-visible, .setting-select:focus-visible, .setting-textarea:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
  }
  .setting-actions { display: flex; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }
  .setting-error {
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
    border-radius: 7px; padding: 7px 8px; font-size: 12px; line-height: 1.35;
  }
  .setting-error[hidden] { display: none; }
  .setting-note {
    color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.35;
    margin-top: 3px;
  }
  .gate-actions { display: inline-flex; align-items: center; gap: 8px; flex: none; }
  @media (max-width: 620px) {
    header {
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 10px 12px;
    }
    .header-actions {
      flex: 1 1 100%;
      justify-content: flex-start;
      flex-wrap: wrap;
      row-gap: 8px;
    }
    .task-set-controls {
      flex: 1 1 100%;
      flex-wrap: wrap;
    }
    .task-set-label { flex: 0 0 auto; }
    .task-set-select {
      flex: 1 1 150px;
      width: min(220px, 100%);
      min-width: 0;
      max-width: 100%;
    }
    .board-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-top: 8px; }
    .board-filter-query, .board-filter-summary { grid-column: 1 / -1; }
    .settings-body { grid-template-columns: 1fr; }
    .settings-sidebar {
      padding: 12px; border-right: none; border-bottom: 1px solid var(--vscode-panel-border);
    }
    .settings-category-list { flex-direction: row; flex-wrap: wrap; }
    .settings-category { flex: 1 1 180px; }
    .settings-panel { padding: 14px; }
    .agent-setting-row { grid-template-columns: 1fr; gap: 6px; }
    .agent-setting-actions { justify-content: flex-end; }
    .setting-model-fields { grid-template-columns: 1fr; }
    .activity-row { grid-template-columns: 1fr; gap: 2px; }
    .activity-time { white-space: normal; }
    .workspace-activity-row { grid-template-columns: 1fr; gap: 4px; }
    .workspace-activity-time { white-space: normal; }
  }

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
  .attachment-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .attachment-picker { display: none; }
  .attachment-hint { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.35; }
  .attachment-shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; }
  .attachment-card {
    display: grid; grid-template-columns: 42px 1fr auto; align-items: center; gap: 8px;
    min-width: 0; padding: 7px; border: 1px solid var(--vscode-panel-border);
    border-radius: 8px; background: var(--vscode-editorWidget-background);
  }
  .attachment-card img { width: 42px; height: 42px; object-fit: cover; border-radius: 5px; background: var(--vscode-editor-background); }
  .attachment-card-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .attachment-card-meta { color: var(--vscode-descriptionForeground); font-size: 10px; margin-top: 2px; }
  .attachment-remove { border: none; background: none; color: var(--vscode-descriptionForeground); cursor: pointer; padding: 4px; border-radius: 4px; }
  .attachment-remove:hover { color: var(--vscode-errorForeground); background: var(--vscode-toolbar-hoverBackground); }
  .attachment-error { color: var(--vscode-errorForeground); font-size: 11px; line-height: 1.35; }
  .new-task-actions { display: flex; justify-content: flex-end; gap: 12px; }
  .task-edit-form { display: flex; flex-direction: column; gap: 14px; }
  .task-edit-form .field-textarea { min-height: 120px; }
  .task-edit-actions { display: flex; justify-content: flex-end; gap: 12px; flex-wrap: wrap; }
  .edit-error {
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
    border-radius: 8px; padding: 9px 10px; font-size: 12px; line-height: 1.4;
  }
  .field-input:focus-visible, .field-textarea:focus-visible,
  .btn-chip:focus-visible, .btn-modal-primary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
  }
  .btn-chip {
    font-family: inherit; font-size: 12px; border-radius: 10px; padding: 10px 14px;
    border: 1px solid var(--vscode-panel-border);
    background: var(--vscode-editorWidget-background); color: var(--vscode-foreground);
    cursor: pointer;
  }
  .btn-chip:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, .15)); }
  .btn-modal-primary {
    font-family: inherit; font-size: 12px; font-weight: 700; border-radius: 10px; padding: 10px 16px;
    border: none; color: #fff; cursor: pointer;
    background: linear-gradient(135deg, var(--kp-modal-accent), var(--kp-modal-accent-2));
    box-shadow: 0 2px 12px color-mix(in srgb, var(--kp-modal-accent-2) 40%, transparent);
  }
  .btn-modal-primary:hover { filter: saturate(1.15) brightness(1.07); }

  #warn {
    flex: none;
    margin: var(--kp-pad-page) var(--kp-pad-page) 0;
  }
  #warn[hidden] { display: none; }
  .warn-banner {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px; border-radius: 10px;
    background: color-mix(in srgb, #fbbf24 15%, var(--vscode-editor-background));
    border: 1px solid color-mix(in srgb, #fbbf24 55%, transparent);
    color: color-mix(in srgb, #f59e0b 72%, var(--vscode-foreground));
    font-size: 0.8rem; font-weight: 600;
  }
  .warn-banner::before {
    content: ''; width: 8px; height: 8px; border-radius: 100px; flex: none;
    background: #fbbf24; box-shadow: 0 0 10px #fbbf24;
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

  /*
   * Each column is tinted with its own hue rather than sharing one surface
   * color: a 3px full-chroma rail across the top, a vertical wash that fades
   * out by the time it reaches the cards (so card contrast is unaffected),
   * and a border in the same hue.
   */
  .column {
    position: relative;
    flex: 0 0 var(--kp-column-width);
    min-height: 120px; max-height: 100%;
    display: flex; flex-direction: column; gap: 10px;
    background:
      linear-gradient(180deg, var(--col-tint), transparent 190px),
      var(--vscode-sideBar-background);
    border: 1px solid var(--col-line);
    border-radius: var(--kp-radius-column);
    padding: calc(var(--kp-pad-column) + 3px) var(--kp-pad-column) var(--kp-pad-column);
    overflow: hidden;
    transition: border-color .15s, box-shadow .15s;
  }
  .column::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--col), var(--col-to, var(--col)));
  }
  .column.drag-over {
    border-color: var(--col);
    box-shadow: 0 0 0 1px var(--col), 0 8px 28px var(--col-glow);
  }
  .column-head { flex: none; display: flex; flex-direction: column; gap: 4px; }
  .column-title-row { display: flex; align-items: center; gap: 7px; }
  .dot {
    width: 9px; height: 9px; border-radius: 100px; flex: none;
    background: linear-gradient(135deg, var(--col), var(--col-to, var(--col)));
    box-shadow: 0 0 8px var(--col-glow);
  }
  .column-title {
    font-size: 13px; font-weight: 700; flex: 1;
    letter-spacing: 0.01em; color: var(--col-text);
  }
  /* Count reads as a chip in the column hue — the per-column density is
     part of the color legend, not incidental metadata. */
  .count {
    font-size: 11px; font-weight: 700; line-height: 1;
    color: var(--col-text);
    background: color-mix(in srgb, var(--col) 18%, transparent);
    border: 1px solid var(--col-line);
    border-radius: 100px; padding: 3px 7px; min-width: 20px; text-align: center;
  }

  /* Exact structure from the prototype's "Agent Metadata" row: Agent Label +
     Agent Name (monospace) + a non-interactive edit-pencil (§13). */
  .agent-meta { display: flex; align-items: center; gap: 4px; }
  /* Deliberately left neutral: the column's identity is already carried by the
     rail, dot, title and count chip, and tinting this one pushed it under 3:1
     on light themes for no gain. */
  .agent-label {
    font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    color: var(--vscode-descriptionForeground);
  }
  .agent-name {
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: 10px; font-weight: 600; color: var(--vscode-foreground);
  }
  .agent-edit-icon { color: var(--vscode-descriptionForeground); flex: none; line-height: 0; }
  .agent-edit-icon-active { cursor: pointer; border-radius: 4px; }
  .agent-edit-icon-active:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .agent-edit-icon-active:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

  .cards {
    display: flex; flex-direction: column; gap: 8px;
    flex: 1 1 auto; min-height: 0; overflow-y: auto;
    box-sizing: border-box;
    scrollbar-gutter: stable;
    margin: 0; padding: 0 4px; /* keep focus rings clear without extending beneath the scrollbar */
  }
  .drop-slot {
    position: relative;
    flex: none;
    height: 8px;
    margin: -2px 0;
    border-radius: 999px;
    transition: height .12s, background .12s, box-shadow .12s;
  }
  .drop-slot.active {
    height: 18px;
    background: color-mix(in srgb, var(--col) 12%, transparent);
  }
  .drop-slot.active::before {
    content: '';
    position: absolute;
    left: 2px; right: 2px; top: 50%; height: 3px;
    transform: translateY(-50%);
    border-radius: 999px;
    background: linear-gradient(90deg, var(--col), var(--col-to, var(--col)));
    box-shadow: 0 0 10px var(--col-glow);
  }
  .drop-slot.empty-slot {
    min-height: 52px;
    margin: 0;
    border: 1px dashed var(--col-line);
    background: color-mix(in srgb, var(--col) 5%, transparent);
  }
  .drop-slot.empty-slot::after {
    content: 'Drop task here';
    position: absolute; inset: 0;
    display: grid; place-items: center;
    color: color-mix(in srgb, var(--col) 60%, var(--vscode-descriptionForeground));
    font-size: 10px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase;
    opacity: .7;
  }
  .drop-slot.empty-slot.active {
    background: color-mix(in srgb, var(--col) 15%, transparent);
    box-shadow: inset 0 0 0 1px var(--col-line);
  }
  .drop-slot.empty-slot.active::before { display: none; }
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }

  /*
   * The 3px left rail is what carries the column hue onto the card itself, so
   * a card stays identifiable with its stage after it is dragged out of the
   * column or seen in isolation. Painted as a background layer rather than a
   * border so it can be a gradient and so it doesn't shift the text box.
   */
  .card {
    position: relative;
    background:
      linear-gradient(90deg, var(--col) 0 3px, transparent 3px),
      linear-gradient(115deg, var(--col-tint), transparent 62%),
      var(--vscode-editorWidget-background);
    border: 1px solid var(--col-line);
    border-radius: var(--kp-radius-card);
    box-shadow: var(--kp-shadow-card);
    padding: var(--kp-pad-card) var(--kp-pad-card) var(--kp-pad-card) calc(var(--kp-pad-card) + 5px);
    display: flex; flex-direction: column; gap: var(--kp-gap-card);
    min-width: 0; max-width: 100%; box-sizing: border-box;
    cursor: pointer;
    transition: transform .13s, box-shadow .13s, border-color .13s;
  }
  .card[draggable="true"] { cursor: grab; }
  .card.dragging { opacity: .5; cursor: grabbing; transform: rotate(1.5deg) scale(.98); }
  .card:hover {
    border-color: var(--col);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px var(--col-glow);
  }
  .card.selected {
    border-color: var(--col);
    box-shadow: 0 0 0 1px var(--col), 0 6px 20px var(--col-glow);
  }
  .card:focus-visible { outline: 2px solid var(--col); outline-offset: 2px; }

  .card-top { display: flex; min-width: 0; align-items: flex-start; justify-content: space-between; gap: 6px; }
  .card-id-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .card-provenance { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: 5px; }
  .card-id {
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: 10px; font-weight: 600; color: var(--col-text); letter-spacing: 0.02em;
    opacity: .9;
  }
  /* §6.12: marks a card an agent filed itself, distinct from a human's "New Task".
     Gradient-filled rather than tinted — it must not be mistaken for the
     column-hue chrome around it. */
  .badge-proposed {
    font-size: 9px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
    color: #fff;
    background: linear-gradient(135deg, var(--kp-modal-accent), var(--kp-modal-accent-2));
    border-radius: 100px; padding: 2px 7px; flex: none;
    box-shadow: 0 1px 6px color-mix(in srgb, var(--kp-modal-accent-2) 45%, transparent);
  }
  /* Task type is always written as text; the border treatment is a secondary
     cue so Feature/Bug remains readable without relying on color. */
  .badge-task-type {
    font-size: 9px; font-weight: 700; letter-spacing: 0.04em;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px; padding: 2px 6px; flex: none;
    color: var(--vscode-foreground);
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
  }
  .badge-task-type.bug { border-style: dashed; }
  .badge-task-type.feature { border-style: solid; }
  .badge-task-parent, .badge-task-child {
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 9px; font-weight: 700; letter-spacing: 0.02em;
    color: var(--vscode-foreground);
    background: color-mix(in srgb, var(--col) 8%, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 5px; padding: 2px 6px; flex: none;
  }
  .icon-btn {
    background: none; border: none; padding: 3px; cursor: pointer;
    color: var(--vscode-descriptionForeground); border-radius: 6px;
    display: inline-flex; line-height: 0; transition: color .12s, background .12s;
  }
  .icon-btn:hover { color: var(--col-text); background: color-mix(in srgb, var(--col) 18%, transparent); }
  /* Delete is the one destructive control on a card — it leaves the column
     hue on hover and goes red, so it can't be hit by muscle memory. */
  .card-top .icon-btn:hover { color: #f43f5e; background: color-mix(in srgb, #f43f5e 16%, transparent); }
  .icon-btn:focus-visible { outline: 2px solid var(--col); outline-offset: 1px; }

  .card-title { min-width: 0; overflow-wrap: anywhere; font-size: 13px; font-weight: 600; line-height: 1.35; }

  .card-outcome {
    --outcome: var(--vscode-descriptionForeground);
    display: flex; flex-direction: column; gap: 3px; min-width: 0;
    padding: 7px 8px; border-left: 3px solid var(--outcome);
    background: color-mix(in srgb, var(--outcome) 8%, transparent);
    overflow-wrap: anywhere;
  }
  .card-outcome.running { --outcome: #0891b2; }
  .card-outcome.blocked, .card-outcome.failed { --outcome: #e11d48; }
  .card-outcome.pending { --outcome: #b45309; }
  .card-outcome.stale { --outcome: #7c3aed; }
  .card-outcome-label {
    color: color-mix(in srgb, var(--outcome) 45%, var(--vscode-foreground));
    font-size: 10px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .card-outcome-summary {
    color: var(--vscode-foreground); font-size: 11px; line-height: 1.4;
  }

  .card-foot { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .card-foot-actions { display: flex; min-width: 0; gap: 6px; margin-left: auto; }

  /*
   * Status is the one thing on a card that must out-shout the column hue —
   * a blocked card in the yellow Validation column still has to read as
   * blocked. So these carry their own semantic color at pill strength, and
   * running is additionally animated: motion, not just hue, marks live work.
   */
  /*
   * Two colors per status, not one: --st is the vivid mark carried by the dot,
   * the border and the fill, where contrast is irrelevant; --st-ink is a
   * mid-tone of the same hue that the label text is mixed from. Mixing a
   * *light* hue toward --vscode-foreground can't clear 4.5:1 in both themes at
   * once (it lands too pale on white), so the ink base is a mid-tone and the
   * mix is weighted toward the foreground — the pill still reads unmistakably
   * cyan/rose/amber from its fill while the word itself stays readable.
   */
  .status-text {
    --st: var(--vscode-descriptionForeground);
    --st-ink: var(--vscode-descriptionForeground);
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
    color: color-mix(in srgb, var(--st-ink) 45%, var(--vscode-foreground));
    background: color-mix(in srgb, var(--st) 16%, transparent);
    border: 1px solid color-mix(in srgb, var(--st) 45%, transparent);
    border-radius: 100px; padding: 2px 8px;
  }
  .status-text::before {
    content: ''; width: 6px; height: 6px; border-radius: 100px; flex: none;
    background: var(--st);
  }
  .status-text.running { --st: #22d3ee; --st-ink: #0891b2; }
  .status-text.running::before { animation: kp-pulse 1.4s ease-in-out infinite; }
  .status-text.blocked, .status-text.failed { --st: #fb7185; --st-ink: #e11d48; }
  .status-text.paused { --st: #fbbf24; --st-ink: #d97706; }
  .status-text.pending { --st: #f59e0b; --st-ink: #b45309; }
  /* Same light/dark split as --col-text, and a lighter fill so the darker
     surface doesn't close the gap between pill and label. */
  body.vscode-dark .status-text, body.vscode-high-contrast .status-text {
    color: color-mix(in srgb, var(--st) 58%, var(--vscode-foreground));
    background: color-mix(in srgb, var(--st) 10%, transparent);
  }
  @keyframes kp-pulse {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 color-mix(in srgb, var(--st) 70%, transparent); }
    50% { opacity: .55; box-shadow: 0 0 0 4px transparent; }
  }
  @media (prefers-reduced-motion: reduce) {
    .status-text.running::before { animation: none; }
    .card, .new-task-btn { transition: none; }
    .card:hover, .new-task-btn:hover { transform: none; }
  }

  /* Ghost-filled in the column hue at rest, solid on hover: the per-card
     action inherits the stage color it will advance the task out of. */
  button.action {
    font-family: inherit; font-size: 12px; font-weight: 600;
    background: color-mix(in srgb, var(--col) 16%, transparent);
    color: var(--col-text);
    border: 1px solid var(--col-line);
    border-radius: var(--kp-radius-button); padding: 5px 10px;
    max-width: 100%;
    cursor: pointer; transition: background .13s, color .13s, box-shadow .13s;
  }
  /*
   * Hover deepens the tint rather than filling solid with white text: half
   * this palette (yellow, sky, green) is too light to carry white — the
   * Validation accent measures 1.5:1 against it — and the hues that could are
   * exactly the ones that then clash with the rest.
   *
   * The label also steps *toward* --vscode-foreground on hover instead of
   * further into the hue. A heavier wash raises the fill's luminance, and on
   * dark themes --col-text is itself a lightened accent, so leaning on chroma
   * alone closed the gap to ~3.5:1. Landing near the theme's own foreground
   * is contrasty by construction in both directions, and the fill plus the
   * full-chroma border still carry the color.
   */
  button.action:hover {
    background: color-mix(in srgb, var(--col) 30%, transparent);
    border-color: var(--col);
    color: color-mix(in srgb, var(--col) 15%, var(--vscode-foreground));
    box-shadow: 0 2px 10px var(--col-glow);
  }
  button.action:focus-visible { outline: 2px solid var(--col); outline-offset: 2px; }

  .empty {
    color: color-mix(in srgb, var(--col) 55%, var(--vscode-descriptionForeground));
    font-size: 11px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase;
    text-align: center; padding: 14px 0;
    border: 1px dashed var(--col-line); border-radius: var(--kp-radius-card);
    background: color-mix(in srgb, var(--col) 5%, transparent);
  }

  /*
   * Task detail modal — replicated from the prototype's modal (Chrome
   * DevTools inspection, 2026-08-13): a centered dialog over a dimming
   * backdrop, not the docked sidebar this used to be. Shape/spacing/type
   * scale are the prototype's exact computed values; surface colors route
   * through --vscode-* per the module doc's split. The accent is not fixed
   * here — renderDetail sets --col on the backdrop from the task's own state,
   * so the rail, section markers, status chip and backdrop wash all come up in
   * the hue of the column the card was opened from. The modals that aren't
    * about one task (New Task, Settings) inherit :root's brand
   * pair instead.
   */
  .modal-backdrop {
    display: none;
    position: fixed; inset: 0; z-index: 1000;
    background:
      radial-gradient(80% 60% at 50% 0%, color-mix(in srgb, var(--col) 15%, transparent), transparent 70%),
      rgba(0, 0, 0, 0.62);
    backdrop-filter: blur(2px);
    align-items: center; justify-content: center;
    padding: 16px;
  }
  .modal-backdrop.open { display: flex; }
  .detail-dialog-layout {
    display: flex; align-items: stretch; justify-content: center; gap: 12px;
    width: min(1280px, calc(100vw - 32px)); max-height: min(86vh, 960px);
    min-width: 0;
  }
  .detail-dialog-layout > .modal { flex: 1 1 720px; min-width: 0; }
  .task-tree-sidecar {
    display: flex; flex: 0 1 480px; flex-direction: column; min-width: 280px;
    width: min(480px, 38vw); max-width: 480px; max-height: 100%; min-height: 0;
    background-color: var(--vscode-editor-background);
    background-image: linear-gradient(180deg, var(--col-tint), transparent 180px);
    border: 1px solid var(--col-line); border-radius: var(--kp-radius-modal);
    box-shadow: var(--kp-shadow-modal), 0 0 0 1px var(--col-glow);
    overflow: hidden;
  }
  .task-tree-sidecar[hidden] { display: none; }
  .task-tree-sidecar::before {
    content: ''; flex: none; height: 3px;
    background: linear-gradient(90deg, var(--col), var(--col-to, var(--col)));
  }
  .task-tree-head {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 10px;
    padding: 15px 15px 12px; border-bottom: 1px solid var(--col-line);
  }
  .task-tree-head .modal-title { font-size: 17px; }
  .task-tree-body { min-width: 0; overflow-y: auto; padding: 14px; }
  .task-tree-controls {
    display: flex; align-items: center; justify-content: flex-end; gap: 4px;
    margin-bottom: 8px;
  }
  .task-tree-control {
    width: 32px; height: 32px; padding: 0; align-items: center; justify-content: center;
  }
  .task-tree-control:disabled { opacity: .45; cursor: default; }
  .task-tree-viewport {
    position: relative; min-width: 0; min-height: 280px; height: min(56vh, 520px);
    overflow: hidden; touch-action: none; overscroll-behavior: contain;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    cursor: grab; outline: none;
  }
  .task-tree-viewport:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .task-tree-viewport.is-panning { cursor: grabbing; }
  .task-tree-canvas {
    position: relative; display: block; width: max-content; min-width: 100%; min-height: 100%;
    transform-origin: 0 0; will-change: transform;
  }
  .task-tree-sidecar .modal-mermaid {
    max-width: 100%; overflow: hidden; margin: 0;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  }
  .task-tree-canvas .modal-mermaid { width: max-content; min-width: 100%; max-width: none; }
  .task-tree-sidecar .modal-mermaid-rendered {
    width: max-content; min-width: 100%; max-width: none; overflow: visible; padding: 10px 12px;
  }
  .task-tree-sidecar .modal-mermaid-rendered svg {
    display: block; width: max-content; min-width: 100%; max-width: none !important; height: auto; margin: 0;
  }
  .task-tree-sidecar .modal-mermaid-source {
    margin: 0; padding: 10px 12px; max-width: 100%; overflow-x: auto;
    white-space: pre-wrap; overflow-wrap: anywhere;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: .8em; line-height: 1.45;
  }
  .task-tree-sidecar .modal-mermaid-message {
    padding: 10px 12px 0; color: var(--vscode-descriptionForeground); font-size: 12px;
  }
  .task-tree-sidecar .task-tree-alternative { margin: 0; }
  @media (max-width: 900px) {
    .modal-backdrop {
      align-items: flex-start;
      overflow-y: auto;
    }
    .detail-dialog-layout {
      flex-direction: column; align-items: stretch; width: min(720px, 100%); max-width: 100%;
      max-height: none; overflow: visible; margin: 0 auto;
    }
    .detail-dialog-layout > .modal {
      flex: none; width: 100%; max-height: min(calc(100vh - 32px), 960px);
    }
    .task-tree-sidecar { flex: none; width: 100%; max-width: 100%; min-width: 0; max-height: none; }
  }
  .modal {
    position: relative;
    width: min(720px, 100vw - 32px);
    max-height: min(86vh, 960px);
    background:
      linear-gradient(180deg, var(--col-tint), transparent 220px),
      var(--vscode-editorWidget-background);
    border: 1px solid var(--col-line);
    border-radius: var(--kp-radius-modal);
    box-shadow: var(--kp-shadow-modal), 0 0 0 1px var(--col-glow);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  /* Same rail as the column head, so the modal reads as an extension of the
     column it was opened from. */
  .modal::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: linear-gradient(90deg, var(--col), var(--col-to, var(--col)));
  }
  .modal-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 18px 18px 14px;
    border-bottom: 1px solid var(--col-line);
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
  /* Detail modal takes the hue of the stage the task is currently in (set
     inline from the task's state), so opening a card doesn't drop the color
     context the board just established. */
  .modal-status {
    color: var(--col-text); font-weight: 700;
    background: color-mix(in srgb, var(--col) 16%, transparent);
    border: 1px solid var(--col-line);
    border-radius: 100px; padding: 2px 9px; font-size: 12px;
  }
  .modal-close {
    flex: none;
    border: 1px solid var(--col-line);
    background: color-mix(in srgb, var(--col) 10%, var(--vscode-editorWidget-background));
    color: var(--col-text);
    width: 32px; height: 32px; border-radius: var(--kp-radius-modal-close);
    cursor: pointer; font-size: 18px; line-height: 18px;
    transition: background .13s, color .13s;
  }
  .modal-close:hover {
    background: color-mix(in srgb, var(--col) 26%, transparent);
    border-color: var(--col);
    color: color-mix(in srgb, var(--col) 22%, var(--vscode-foreground));
  }
  .modal-body {
    min-height: 0; overflow-y: auto; padding: 18px;
    display: flex; flex-direction: column; gap: 22px;
  }
  .modal-section-label {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
    color: var(--col-text); margin-bottom: 8px;
  }
  .modal-section-label::before {
    content: ''; width: 3px; height: 12px; border-radius: 100px; flex: none;
    background: linear-gradient(180deg, var(--col), var(--col-to, var(--col)));
  }
  .modal-section-body {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: 15px; line-height: 1.65; color: var(--vscode-foreground);
  }
  .outcome-guidance {
    --outcome: var(--vscode-descriptionForeground);
    display: flex; flex-direction: column; gap: 10px; min-width: 0;
    padding: 12px 14px;
    border: 1px solid color-mix(in srgb, var(--outcome) 45%, var(--vscode-panel-border));
    border-left: 4px solid var(--outcome);
    background: color-mix(in srgb, var(--outcome) 8%, transparent);
  }
  .outcome-guidance.running { --outcome: #0891b2; }
  .outcome-guidance.blocked, .outcome-guidance.failed { --outcome: #e11d48; }
  .outcome-guidance.pending { --outcome: #b45309; }
  .outcome-guidance.stale { --outcome: #7c3aed; }
  .outcome-guidance-label {
    color: color-mix(in srgb, var(--outcome) 45%, var(--vscode-foreground));
    font-size: 12px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
  }
  .outcome-guidance-context {
    min-width: 0; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground);
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: 11px; line-height: 1.45;
  }
  .outcome-guidance-summary, .outcome-guidance-holding, .outcome-guidance-next {
    min-width: 0; overflow-wrap: anywhere; color: var(--vscode-foreground);
    font-size: 13px; line-height: 1.5;
  }
  .outcome-guidance-row { min-width: 0; }
  .outcome-guidance-key {
    display: block; margin-bottom: 2px; color: var(--vscode-descriptionForeground);
    font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase;
  }
  .activity-feed {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 280px;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 10px;
    border: 1px solid var(--vscode-panel-border, #454545);
    border-radius: 4px;
    background: var(--vscode-editorWidget-background, transparent);
  }
  .activity-overview {
    display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px;
    margin-bottom: 8px;
  }
  .activity-source-summary {
    min-width: 0; padding: 9px 10px; border: 1px solid var(--vscode-panel-border);
    border-radius: 6px; background: var(--vscode-editorWidget-background, transparent);
  }
  .activity-source-heading { display: flex; flex-wrap: wrap; gap: 5px 8px; align-items: baseline; }
  .activity-source-label { font-size: 12px; font-weight: 700; }
  .activity-source-status, .activity-source-freshness {
    color: var(--vscode-descriptionForeground); font-size: 11px;
  }
  .activity-source-description {
    margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .activity-source-times {
    display: flex; flex-direction: column; gap: 2px; margin-top: 5px;
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
    font-size: 10px; line-height: 1.35;
  }
  .activity-row.activity-transcript { border-left: 2px solid var(--vscode-panel-border, #454545); padding-left: 6px; opacity: 0.85; }
  .activity-row {
    display: grid; grid-template-columns: minmax(170px, max-content) minmax(0, 1fr);
    gap: 12px; padding: 8px 0; border-top: 1px solid var(--vscode-panel-border);
  }
  .activity-row:first-child { padding-top: 0; border-top: none; }
  .activity-meta { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .activity-time {
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
    font-size: 11px; line-height: 1.45; white-space: nowrap;
  }
  .activity-observed {
    color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
    font-size: 10px; line-height: 1.35; white-space: nowrap;
  }
  .activity-note { min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; white-space: pre-wrap; }
  .activity-empty {
    color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.45;
    padding: 8px 10px; border: 1px dashed var(--vscode-panel-border); border-radius: 6px;
  }
  .activity-blocked {
    color: var(--vscode-errorForeground); font-size: 13px; line-height: 1.45;
    margin-bottom: 8px; padding: 8px 10px;
    background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
    border-radius: 6px;
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
  .modal-section-body ul.contains-task-list { list-style: none; padding-left: 0; }
  .modal-section-body ul.contains-task-list ul { list-style: none; padding-left: 22px; }
  .modal-section-body li.task-list-item { list-style: none; }
  .modal-section-body li.task-list-item > label {
    display: inline;
  }
  .modal-section-body .task-list-item-checkbox {
    margin: 0 8px 0 0; vertical-align: text-top;
  }
  .modal-section-body blockquote {
    margin: 10px 0; border-left: 3px solid var(--col);
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
  .modal-section-body .modal-mermaid {
    max-width: 100%; margin: 10px 0; overflow: hidden;
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  }
  .modal-section-body .modal-mermaid-rendered {
    max-width: 100%; overflow-x: auto; padding: 10px 12px;
  }
  .modal-section-body .modal-mermaid-rendered svg {
    display: block; width: auto; max-width: 100%; height: auto; margin: 0 auto;
  }
  .modal-section-body .modal-mermaid-source {
    margin: 0; padding: 10px 12px; max-width: 100%; overflow-x: auto;
    white-space: pre-wrap; overflow-wrap: anywhere;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
    font-family: "IBM Plex Mono", var(--vscode-editor-font-family, ui-monospace), monospace;
    font-size: .86em; line-height: 1.5;
  }
  .modal-section-body .modal-mermaid-message {
    padding: 10px 12px 0; color: var(--vscode-descriptionForeground); font-size: 13px;
  }
  .modal-section-body .modal-table-wrap { max-width: 100%; overflow-x: auto; margin: 10px 0; }
  .modal-section-body table { border-collapse: collapse; min-width: 100%; }
  .modal-section-body th, .modal-section-body td {
    border: 1px solid var(--vscode-panel-border); padding: 6px 9px; text-align: left;
    vertical-align: top;
  }
  .modal-section-body th { background: color-mix(in srgb, var(--col) 10%, transparent); font-weight: 700; }
  .modal-section-body .task-image {
    display: block; max-width: 100%; height: auto; margin: 10px 0;
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
  }
  .modal-section-body .task-image-placeholder {
    display: inline-block; max-width: 100%; color: var(--vscode-descriptionForeground);
    border: 1px dashed var(--vscode-panel-border); border-radius: 5px; padding: 2px 7px;
  }
  .modal-section-body a { color: var(--vscode-textLink-foreground); overflow-wrap: anywhere; }
  .modal-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .modal-link {
    font-size: 13px; color: var(--vscode-textLink-foreground); cursor: pointer;
    background: none; border: none; padding: 0; font-family: inherit;
  }
  .modal-link:hover { text-decoration: underline; }
</style>
<script nonce="${nonce}" data-kanban-pilot-mermaid-runtime src="${escapeMarkdownHtml(mermaidRuntimeUri)}"></script>
<script nonce="${nonce}" data-kanban-pilot-mermaid src="${escapeMarkdownHtml(mermaidBridgeUri)}"></script>
</head>
<body>
<header>
  <h1>Kanban Pilot</h1>
  <div class="header-actions">
    <div class="task-set-controls" aria-label="Task-set management">
      <label class="task-set-label" for="taskSetSelect">Task set</label>
      <select class="task-set-select" id="taskSetSelect" aria-label="Active task set"></select>
      <button class="task-set-btn" id="workspaceActivityToggle" type="button" aria-haspopup="dialog" aria-controls="workspaceActivityBackdrop">Workspace Activity</button>
      <button class="task-set-btn" id="taskSetCreate" aria-label="Create task set">New</button>
      <button class="task-set-btn" id="taskSetRename" aria-label="Rename active task set">Rename</button>
      <button class="task-set-btn" id="taskSetDelete" aria-label="Delete active task set">Delete</button>
    </div>
    <button class="settings-btn" id="settingsToggle" aria-haspopup="dialog" aria-controls="settingsBackdrop">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </button>
    <button class="new-task-btn" id="newTaskToggle">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
      New Task
    </button>
  </div>
</header>
<div class="board-filters" id="boardFilters" role="search" aria-label="Find tasks">
  <div class="board-filter-query">
    <label class="board-filter-label" for="boardFind">Find tasks</label>
    <div class="board-filter-query-row">
      <input class="board-filter-input" id="boardFind" type="search" placeholder="ID, title, or parent ID" autocomplete="off" />
      <button class="board-filter-clear" id="boardFilterClear" type="button" aria-label="Clear task find">Clear</button>
    </div>
  </div>
  <label class="board-filter-control" for="boardTypeFilter">
    <span>Type</span>
    <select class="board-filter-select" id="boardTypeFilter" aria-label="Filter by task type"></select>
  </label>
  <label class="board-filter-control" for="boardStatusFilter">
    <span>Status</span>
    <select class="board-filter-select" id="boardStatusFilter" aria-label="Filter by runtime status"></select>
  </label>
  <label class="board-filter-control" for="boardRelationshipFilter">
    <span>Relationship</span>
    <select class="board-filter-select" id="boardRelationshipFilter" aria-label="Filter by task relationship"></select>
  </label>
  <div class="board-filter-summary" id="boardFilterSummary" role="status" aria-live="polite" aria-atomic="true"></div>
</div>
<div class="modal-backdrop" id="settingsBackdrop">
  <div class="modal settings-modal" id="settingsModal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle" aria-describedby="settingsSubtitle" tabindex="-1">
    <div class="new-task-head settings-head">
      <div class="new-task-head-text">
        <div class="modal-title" id="settingsTitle">Settings</div>
        <div class="new-task-subtitle" id="settingsSubtitle">Configure every Kanban Pilot setting without leaving the board.</div>
      </div>
      <button class="modal-close" id="settingsClose" aria-label="Close Settings dialog">×</button>
    </div>
    <div class="settings-body">
      <nav class="settings-sidebar" id="settingsCategoryNav" aria-label="Settings categories">
        <div class="settings-sidebar-title">Categories</div>
        <div class="settings-category-list" role="tablist" aria-label="Settings categories">
          <button class="settings-category" id="settingsCategoryGates" type="button" role="tab" data-category="gates" aria-selected="true" aria-controls="settingsPanelGates" tabindex="0">Automation gates</button>
          <button class="settings-category" id="settingsCategoryAgents" type="button" role="tab" data-category="agents" aria-selected="false" aria-controls="settingsPanelAgents" tabindex="-1">Agent assignments</button>
          <button class="settings-category" id="settingsCategoryWorkspace" type="button" role="tab" data-category="workspace" aria-selected="false" aria-controls="settingsPanelWorkspace" tabindex="-1">Task storage & startup</button>
          <button class="settings-category" id="settingsCategoryChat" type="button" role="tab" data-category="chat" aria-selected="false" aria-controls="settingsPanelChat" tabindex="-1">Chat</button>
          <button class="settings-category" id="settingsCategoryTools" type="button" role="tab" data-category="tools" aria-selected="false" aria-controls="settingsPanelTools" tabindex="-1">Tools & model</button>
          <button class="settings-category" id="settingsCategoryRun" type="button" role="tab" data-category="run" aria-selected="false" aria-controls="settingsPanelRun" tabindex="-1">Run behavior</button>
          <button class="settings-category" id="settingsCategoryLayout" type="button" role="tab" data-category="layout" aria-selected="false" aria-controls="settingsPanelLayout" tabindex="-1">Board & layout</button>
        </div>
      </nav>
      <div class="settings-main" id="settingsMain" role="region" aria-label="Settings controls">
        <section class="settings-panel settings-section" id="settingsPanelGates" role="tabpanel" aria-labelledby="settingsCategoryGates" aria-describedby="settingsGatesDescription" aria-hidden="false">
          <div class="settings-section-title" id="settingsGatesTitle">Automation gates</div>
          <div class="settings-section-desc" id="settingsGatesDescription">Each gate defaults to manual. Switch one to Auto to skip its click.</div>
          <div class="gates-list" id="gatesList"></div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelAgents" data-setting-key="chat.agentNames" role="tabpanel" aria-labelledby="settingsCategoryAgents" aria-describedby="settingsAgentsDescription" hidden aria-hidden="true">
          <div class="settings-section-title" id="settingsAgentsTitle">Agent assignments</div>
          <div class="settings-section-desc" id="settingsAgentsDescription">Assignments on resting columns are labels only; they never launch a chat run.</div>
          <div class="agent-settings-list" id="agentSettingsList"></div>
          <div class="setting-error agent-settings-error" id="agentSettingsError" role="alert" aria-live="assertive" hidden></div>
          <div class="agent-settings-actions">
            <button class="btn-chip" id="agentSettingsSave" type="button">Save</button>
          </div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelWorkspace" role="tabpanel" aria-labelledby="settingsCategoryWorkspace" aria-describedby="settingsWorkspaceDescription" hidden aria-hidden="true">
          <div class="settings-section-title">Task storage & startup</div>
          <div class="settings-section-desc" id="settingsWorkspaceDescription">These values are read at activation. Saving or resetting them requires a VS Code window reload.</div>
          <div class="settings-fields" id="settingsFieldsWorkspace"></div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelChat" role="tabpanel" aria-labelledby="settingsCategoryChat" aria-describedby="settingsChatDescription" hidden aria-hidden="true">
          <div class="settings-section-title">Chat</div>
          <div class="settings-section-desc" id="settingsChatDescription">Chat mode and session options apply to the next relevant action unless stated otherwise.</div>
          <div class="settings-fields" id="settingsFieldsChat"></div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelTools" role="tabpanel" aria-labelledby="settingsCategoryTools" aria-describedby="settingsToolsDescription" hidden aria-hidden="true">
          <div class="settings-section-title">Tools & model</div>
          <div class="settings-section-desc" id="settingsToolsDescription">Enter one tool ID per line. Model id and vendor are optional and can be supplied independently.</div>
          <div class="settings-fields" id="settingsFieldsTools"></div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelRun" role="tabpanel" aria-labelledby="settingsCategoryRun" aria-describedby="settingsRunDescription" hidden aria-hidden="true">
          <div class="settings-section-title">Run behavior</div>
          <div class="settings-section-desc" id="settingsRunDescription">Run capacity changes affect future admission; currently running tasks are not interrupted.</div>
          <div class="settings-fields" id="settingsFieldsRun"></div>
        </section>
        <section class="settings-panel settings-section" id="settingsPanelLayout" role="tabpanel" aria-labelledby="settingsCategoryLayout" aria-describedby="settingsLayoutDescription" hidden aria-hidden="true">
          <div class="settings-section-title">Board & layout</div>
          <div class="settings-section-desc" id="settingsLayoutDescription">Choose how task chats are opened from the board.</div>
          <div class="settings-fields" id="settingsFieldsLayout"></div>
        </section>
      </div>
    </div>
  </div>
</div>
<div class="modal-backdrop" id="workspaceActivityBackdrop">
  <div class="modal workspace-activity-modal" id="workspaceActivityModal" role="dialog" aria-modal="true" aria-labelledby="workspaceActivityTitle" aria-describedby="workspaceActivitySubtitle" tabindex="-1">
    <div class="new-task-head settings-head">
      <div class="new-task-head-text">
        <div class="modal-title" id="workspaceActivityTitle">Workspace Activity History</div>
        <div class="new-task-subtitle" id="workspaceActivitySubtitle">Read-only history of board activities for the active task set.</div>
      </div>
      <button class="modal-close" id="workspaceActivityClose" type="button" aria-label="Close Workspace Activity History dialog">×</button>
    </div>
    <div class="workspace-activity-body">
      <div class="workspace-activity-toolbar">
        <div class="workspace-activity-set">
          <div class="workspace-activity-set-label">Active task set</div>
          <div class="workspace-activity-set-name" id="workspaceActivitySetName">Loading…</div>
        </div>
        <button class="btn-chip workspace-activity-refresh" id="workspaceActivityRefresh" type="button">Refresh</button>
      </div>
      <div class="workspace-activity-state" id="workspaceActivityState" role="status" aria-live="polite">Loading activity…</div>
      <div class="workspace-activity-list" id="workspaceActivityList" aria-label="Workspace activity records" hidden></div>
    </div>
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
        <div class="attachment-controls">
          <button type="button" class="btn-chip" id="newTaskAttach">Attach image</button>
          <span class="attachment-hint">PNG, JPEG, GIF, or WebP · up to 10 MiB · paste an image here</span>
        </div>
        <input class="attachment-picker" id="newTaskPicker" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple />
        <div class="attachment-error" id="newTaskAttachmentError" role="alert" aria-live="assertive" hidden></div>
        <div class="attachment-shelf" id="newTaskAttachments" aria-label="Attached images"></div>
      </label>
      <label class="field">
        <span class="field-label">Task type</span>
        <select class="field-input" id="newTaskType" required aria-label="Task type">
          <option value="feature">Feature</option>
          <option value="bug">Bug</option>
        </select>
      </label>
      <label class="field">
        <span class="field-label">Parent task</span>
        <select class="field-input" id="newTaskParent" aria-label="Parent task">
          <option value="" disabled selected>Loading tasks...</option>
        </select>
      </label>
      <div class="new-task-actions">
        <button type="button" class="btn-chip" id="newTaskCancel">Cancel</button>
        <button type="submit" class="btn-modal-primary" id="newTaskSubmit">Create task</button>
      </div>
    </form>
  </div>
</div>
<div id="warn" hidden></div>
<div id="reorderAnnouncement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
<div class="layout">
  <div class="board" id="board"></div>
</div>
<div class="modal-backdrop" id="detailBackdrop">
  <div class="detail-dialog-layout" id="detailDialogLayout">
    <div class="modal" id="detail" role="dialog" aria-modal="true"></div>
    <aside class="task-tree-sidecar" id="taskTreeSidecar" role="region" aria-labelledby="taskTreeTitle" hidden></aside>
  </div>
</div>

<script nonce="${nonce}" data-kanban-pilot-board>
  const vscode = acquireVsCodeApi();
  const ACTION_LABELS = ${actionLabelsJson};
  const GATES = ${gatesJson};
  const COLUMN_SETTINGS = ${columnsJson};
  const COLUMN_AGENT_DEFAULTS = ${columnAgentDefaultsJson};
  const SETTING_DEFINITIONS = ${settingDefinitionsJson};
  const COLUMN_ACCENT = ${accentsJson};
  const BOARD_FILTER_OPTIONS = ${boardFilterOptionsJson};
  // Header-opened Settings defaults to Automation gates; a column pencil opens Agent assignments.
  const DEFAULT_SETTINGS_CATEGORY = 'gates';
  const SETTINGS_CATEGORIES = ['gates', 'agents', 'workspace', 'chat', 'tools', 'run', 'layout'];

  /** Paints a hue onto any element; children inherit and re-derive from it. */
  function applyAccent(node, column) {
    const accent = COLUMN_ACCENT[column];
    if (!accent) { return; }
    node.style.setProperty('--col', accent.from);
    node.style.setProperty('--col-to', accent.to);
  }
  let draggedTaskId = null;
  let draggedTaskColumn = null;
  let pendingFocusTaskId = null;
  let selectedSettingsCategory = DEFAULT_SETTINGS_CATEGORY;
  let boardRenderGeneration = 0;
  let renderedBoardTaskSetId = null;
  let boardScrollLeft = 0;
  const boardFilterState = { query: '', type: 'all', status: 'all', relationship: 'all' };
  const columnScrollTops = new Map();
  let lastWorkspaceActivity = { activeTaskSetId: '', activeTaskSetName: '', records: [] };
  let workspaceActivityReturnFocus = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
  }

  function workspaceActivityRecordList(value) {
    if (!Array.isArray(value)) { return []; }
    return value.map((record, position) => {
      if (!record || typeof record !== 'object') { return null; }
      const timestamp = safeActivityTimestamp(record.timestamp);
      const level = record.level === 'success' || record.level === 'warning' || record.level === 'error'
        ? record.level : null;
      if (!timestamp || !level || typeof record.message !== 'string' || !record.message.trim() || record.message.length > 1000) {
        return null;
      }
      const taskId = typeof record.taskId === 'string' && /^TASK-\\d+$/.test(record.taskId)
        ? record.taskId : undefined;
      const taskTitle = typeof record.taskTitle === 'string' && record.taskTitle.trim()
        ? record.taskTitle : undefined;
      return { timestamp, level, message: record.message, taskId, taskTitle, position };
    }).filter(Boolean).sort((left, right) => {
      const order = Date.parse(right.timestamp) - Date.parse(left.timestamp);
      return order || right.position - left.position;
    }).slice(0, 100);
  }

  function renderWorkspaceActivityLoading() {
    const state = document.getElementById('workspaceActivityState');
    const list = document.getElementById('workspaceActivityList');
    if (state) {
      state.textContent = 'Loading activity…';
      state.hidden = false;
    }
    if (list) {
      list.textContent = '';
      list.hidden = true;
    }
  }

  function renderWorkspaceActivityState(message) {
    if (!message || typeof message !== 'object' || typeof message.activeTaskSetId !== 'string') { return; }
    if (renderedBoardTaskSetId && message.activeTaskSetId !== renderedBoardTaskSetId) { return; }
    const records = workspaceActivityRecordList(message.records);
    const activeTaskSetName = typeof message.activeTaskSetName === 'string' && message.activeTaskSetName.trim()
      ? message.activeTaskSetName : 'Active task set';
    lastWorkspaceActivity = {
      activeTaskSetId: message.activeTaskSetId,
      activeTaskSetName,
      records,
    };
    const setName = document.getElementById('workspaceActivitySetName');
    if (setName) { setName.textContent = activeTaskSetName; }
    const state = document.getElementById('workspaceActivityState');
    const list = document.getElementById('workspaceActivityList');
    if (!state || !list) { return; }
    list.textContent = '';
    if (!records.length) {
      state.textContent = 'No workspace activity recorded yet.';
      state.hidden = false;
      list.hidden = true;
      return;
    }
    state.textContent = '';
    state.hidden = true;
    for (const record of records) {
      const row = el('article', 'workspace-activity-row ' + record.level);
      row.dataset.level = record.level;
      const meta = el('div', 'workspace-activity-meta');
      const time = document.createElement('time');
      time.className = 'workspace-activity-time';
      time.dateTime = record.timestamp;
      time.textContent = record.timestamp;
      time.setAttribute('aria-label', record.timestamp + ' UTC');
      meta.appendChild(time);
      meta.appendChild(el('span', 'workspace-activity-level', record.level));
      row.appendChild(meta);
      const content = el('div', 'workspace-activity-content');
      content.appendChild(el('div', 'workspace-activity-message', record.message));
      if (record.taskId || record.taskTitle) {
        const context = el('div', 'workspace-activity-context');
        context.textContent = 'Task: ' + (record.taskId || '—') + (record.taskTitle ? ' · ' + record.taskTitle : '');
        content.appendChild(context);
      }
      row.appendChild(content);
      list.appendChild(row);
    }
    list.hidden = false;
  }

  const ACTIVITY_SOURCE_LABELS = {
    progress: 'Durable progress',
    hook: 'Near-real-time hook',
    transcript: 'Delayed transcript',
  };
  const ACTIVITY_STATUS_LABELS = {
    disabled: 'Disabled',
    unavailable: 'Unavailable',
    empty: 'Enabled · empty',
    available: 'Available',
  };

  function activitySourceLabel(source) {
    return ACTIVITY_SOURCE_LABELS[source] || 'Activity source';
  }

  function safeActivityTimestamp(value) {
    if (typeof value !== 'string' ||
      !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value))) {
      return '';
    }
    return value;
  }

  function appendActivityOverview(parent, activity) {
    if (!activity || typeof activity !== 'object' || !Array.isArray(activity.sources)) {
      return false;
    }
    const overview = el('div', 'activity-overview');
    overview.setAttribute('role', 'group');
    overview.setAttribute('aria-label', 'Activity source status');
    for (const source of activity.sources) {
      if (!source || typeof source !== 'object' ||
        !['progress', 'hook', 'transcript'].includes(source.source)) {
        continue;
      }
      const sourceId = source.source;
      const status = ['disabled', 'unavailable', 'empty', 'available'].includes(source.status)
        ? source.status : 'unavailable';
      const item = el('div', 'activity-source-summary activity-source-' + sourceId);
      item.dataset.source = sourceId;
      item.dataset.status = status;
      item.setAttribute('aria-label', activitySourceLabel(sourceId) + ': ' + (ACTIVITY_STATUS_LABELS[status] || 'Unavailable'));
      const heading = el('div', 'activity-source-heading');
      heading.appendChild(el('span', 'activity-source-label', activitySourceLabel(sourceId)));
      heading.appendChild(el('span', 'activity-source-status', ACTIVITY_STATUS_LABELS[status] || 'Unavailable'));
      if (typeof source.freshnessLabel === 'string' && source.freshnessLabel) {
        heading.appendChild(el('span', 'activity-source-freshness', source.freshnessLabel));
      }
      item.appendChild(heading);
      if (typeof source.description === 'string' && source.description) {
        item.appendChild(el('div', 'activity-source-description', source.description));
      }
      const latestEventAt = safeActivityTimestamp(source.latestEventAt);
      const latestObservedAt = safeActivityTimestamp(source.latestObservedAt);
      if (latestEventAt || latestObservedAt) {
        const latest = el('div', 'activity-source-times');
        if (latestEventAt) { latest.appendChild(el('span', 'activity-source-event-time', 'Latest event: ' + latestEventAt)); }
        if (latestObservedAt) { latest.appendChild(el('span', 'activity-source-observed-time', 'Latest observed: ' + latestObservedAt)); }
        item.appendChild(latest);
      }
      overview.appendChild(item);
    }
    if (!overview.childElementCount) {
      return false;
    }
    parent.appendChild(overview);
    return true;
  }

  function compareTaskIds(left, right) {
    const leftNumber = Number(left.slice(5));
    const rightNumber = Number(right.slice(5));
    if (leftNumber !== rightNumber) { return leftNumber - rightNumber; }
    return left < right ? -1 : left > right ? 1 : 0;
  }

  function announceReorder(message) {
    const live = document.getElementById('reorderAnnouncement');
    if (live) { live.textContent = message; }
  }

  function focusPendingCard() {
    if (!pendingFocusTaskId) { return; }
    const card = document.querySelector('.card[data-task-id="' + pendingFocusTaskId + '"]');
    if (card) {
      card.focus();
      pendingFocusTaskId = null;
    }
  }

  function normalizeBoardFilterQuery(value) {
    return String(value || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  }

  function boardFiltersActive() {
    return !!boardFilterState.query || boardFilterState.type !== 'all' ||
      boardFilterState.status !== 'all' || boardFilterState.relationship !== 'all';
  }

  function boardCardMatchesFilters(card) {
    if (boardFilterState.query && ![card.id, card.title, card.parentTaskId]
      .filter((value) => typeof value === 'string')
      .some((value) => normalizeBoardFilterQuery(value).includes(boardFilterState.query))) {
      return false;
    }
    if (boardFilterState.type !== 'all' && card.type !== boardFilterState.type) { return false; }
    if (boardFilterState.status !== 'all' && card.status !== boardFilterState.status) { return false; }

    const isParent = card.hasChildren === true;
    const isChild = typeof card.parentTaskId === 'string' && !!card.parentTaskId.trim();
    if (boardFilterState.relationship === 'parent' && !isParent) { return false; }
    if (boardFilterState.relationship === 'child' && !isChild) { return false; }
    if (boardFilterState.relationship === 'standalone' && (isParent || isChild)) { return false; }
    return true;
  }

  function resetBoardFilters() {
    boardFilterState.query = '';
    boardFilterState.type = 'all';
    boardFilterState.status = 'all';
    boardFilterState.relationship = 'all';
  }

  function renderBoardFilterOptions() {
    [
      ['boardTypeFilter', BOARD_FILTER_OPTIONS.types],
      ['boardStatusFilter', BOARD_FILTER_OPTIONS.statuses],
      ['boardRelationshipFilter', BOARD_FILTER_OPTIONS.relationships],
    ].forEach(([id, options]) => {
      const select = document.getElementById(id);
      if (!select) { return; }
      select.textContent = '';
      options.forEach((option) => {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        select.appendChild(node);
      });
    });
  }

  function renderBoardFilterControls() {
    const find = document.getElementById('boardFind');
    if (find) { find.value = boardFilterState.query; }
    const values = [
      ['boardTypeFilter', boardFilterState.type],
      ['boardStatusFilter', boardFilterState.status],
      ['boardRelationshipFilter', boardFilterState.relationship],
    ];
    values.forEach(([id, value]) => {
      const select = document.getElementById(id);
      if (select) { select.value = value; }
    });
    const clear = document.getElementById('boardFilterClear');
    if (clear) { clear.disabled = !boardFiltersActive(); }
  }

  function filterValueFor(id, fallback) {
    const select = document.getElementById(id);
    if (!select || !Array.from(select.options).some((option) => option.value === select.value)) {
      return fallback;
    }
    return select.value;
  }

  function refreshBoardFromFilters() {
    const find = document.getElementById('boardFind');
    boardFilterState.query = normalizeBoardFilterQuery(find ? find.value : '');
    boardFilterState.type = filterValueFor('boardTypeFilter', 'all');
    boardFilterState.status = filterValueFor('boardStatusFilter', 'all');
    boardFilterState.relationship = filterValueFor('boardRelationshipFilter', 'all');
    if (lastBoardSnapshot) { renderBoard(lastBoardSnapshot, lastSelectedId); }
  }

  function renderBoardFilterSummary(visibleCount, totalCount, columnCount) {
    const summary = document.getElementById('boardFilterSummary');
    if (!summary) { return; }
    const noMatches = boardFiltersActive() && visibleCount === 0;
    summary.textContent = (noMatches ? 'No matching tasks. ' : '') +
      'Showing ' + visibleCount + ' of ' + totalCount + ' tasks across ' + columnCount + ' columns.';
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
  const zoomInIconSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/><path d="M11 8v6M8 11h6"/></svg>';
  const zoomOutIconSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/><path d="M8 11h6"/></svg>';
  const resetViewIconSvg =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M4 12a8 8 0 1 0 2.3-5.6"/><path d="M4 4v6h6"/></svg>';

  function actionButton(taskId, action) {
    const b = el('button', 'action', ACTION_LABELS[action]);
    b.draggable = false;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      vscode.postMessage({ type: 'action/invoke', taskId, action });
    });
    return b;
  }

  function renderCard(card, selectedId, column) {
    const node = el('div', 'card' + (card.id === selectedId ? ' selected' : ''));
    node.draggable = true;
    node.tabIndex = 0;
    node.dataset.taskId = card.id;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', card.id + ': ' + card.title + '. Type: ' + card.typeLabel +
      '.' + (card.parentTaskId !== undefined ? ' Child of ' + card.parentTaskId + '.' : '') +
      (card.pending ? ' Review required: ' + card.pending.label + '.' : '') +
      (card.outcome ? ' ' + card.outcome.label + ': ' + card.outcome.summary : '') +
      ' Use Arrow Up or Arrow Down to change position.');
    let suppressClick = false;

    node.addEventListener('dragstart', (e) => {
      if (e.target instanceof Element && e.target.closest('button, select, input, textarea')) {
        e.preventDefault();
        return;
      }
      draggedTaskId = card.id;
      draggedTaskColumn = column.id;
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
      draggedTaskColumn = null;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 0);
    });

    const top = el('div', 'card-top');
    const idGroup = el('div', 'card-id-group');
    idGroup.appendChild(el('div', 'card-id', card.id));
    const typeBadge = el('span', 'badge-task-type ' + card.type, card.typeLabel);
    typeBadge.title = 'Task type: ' + card.typeLabel;
    typeBadge.setAttribute('aria-label', 'Task type: ' + card.typeLabel);
    idGroup.appendChild(typeBadge);
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

    const provenance = el('div', 'card-provenance');
    if (card.hasChildren) {
      const parentBadge = el('span', 'badge-task-parent', 'Parent');
      parentBadge.title = 'This task has child tasks';
      parentBadge.setAttribute('aria-label', 'Parent task');
      provenance.appendChild(parentBadge);
    }
    if (card.parentTaskId !== undefined) {
      const childBadge = el('span', 'badge-task-child', 'Child of ' + card.parentTaskId);
      childBadge.title = 'Parent task: ' + card.parentTaskId;
      childBadge.setAttribute('aria-label', 'Child of ' + card.parentTaskId);
      provenance.appendChild(childBadge);
    }
    if (provenance.childElementCount > 0) { node.appendChild(provenance); }

    node.appendChild(el('div', 'card-title', card.title));

    if (card.outcome && typeof card.outcome.label === 'string' && typeof card.outcome.summary === 'string') {
      const knownKinds = ['running', 'blocked', 'failed', 'pending', 'stale'];
      const outcomeKind = knownKinds.includes(card.outcome.kind) ? card.outcome.kind : 'unknown';
      const outcome = el('div', 'card-outcome ' + outcomeKind);
      outcome.setAttribute('role', 'status');
      outcome.appendChild(el('span', 'card-outcome-label', card.outcome.label));
      outcome.appendChild(el('span', 'card-outcome-summary', card.outcome.summary));
      node.appendChild(outcome);
    }

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
    if (card.pending) {
      const pending = el('span', 'status-text pending', 'Review Required');
      pending.title = card.pending.description;
      pending.setAttribute('aria-label', 'Review required: ' + card.pending.label);
      foot.insertBefore(pending, foot.firstChild);
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
      if (e.target !== node) { return; }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); }
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') { return; }

      e.preventDefault();
      const index = column.cards.findIndex((candidate) => candidate.id === card.id);
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      const targetIndex = index + direction;
      if (index < 0 || targetIndex < 0 || targetIndex >= column.cards.length) {
        announceReorder(card.title + ' is already at the ' + (direction < 0 ? 'first' : 'last') + ' position in ' + column.label + '.');
        return;
      }

      const beforeTaskId = direction < 0
        ? column.cards[index - 1].id
        : (column.cards[index + 2] ? column.cards[index + 2].id : null);
      pendingFocusTaskId = card.id;
      vscode.postMessage({ type: 'task/reorder', taskId: card.id, column: column.id, beforeTaskId });
    });
    return node;
  }

  function clearDropTargets() {
    document.querySelectorAll('.column.drag-over').forEach((column) => column.classList.remove('drag-over'));
    document.querySelectorAll('.drop-slot.active').forEach((slot) => slot.classList.remove('active'));
  }

  function submitDrop(taskId, column, beforeTaskId) {
    if (!taskId) { return; }
    if (draggedTaskColumn === column.id) {
      vscode.postMessage({ type: 'task/reorder', taskId, column: column.id, beforeTaskId });
    } else {
      vscode.postMessage({ type: 'task/move', taskId, destination: column.id });
    }
    clearDropTargets();
  }

  function activateDropSlot(slot, columnNode, column, beforeTaskId, event) {
    event.preventDefault();
    event.stopPropagation();
    if (!draggedTaskId) { return; }
    if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
    clearDropTargets();
    slot.classList.add('active');
    columnNode.classList.add('drag-over');
  }

  function restoreColumnScroll(cards, columnId, persist = false) {
    const requested = columnScrollTops.get(columnId) || 0;
    const maxScrollTop = Math.max(0, cards.scrollHeight - cards.clientHeight);
    const restored = Math.min(Math.max(0, requested), maxScrollTop);
    cards.scrollTop = restored;
    if (persist) { columnScrollTops.set(columnId, restored); }
  }

  function restoreBoardScroll(board, persist = false) {
    const maxScrollLeft = Math.max(0, board.scrollWidth - board.clientWidth);
    const restored = Math.min(Math.max(0, boardScrollLeft), maxScrollLeft);
    board.scrollLeft = restored;
    if (persist) { boardScrollLeft = restored; }
  }

  function renderBoard(snapshot, selectedId) {
    const generation = ++boardRenderGeneration;
    const warn = document.getElementById('warn');
    warn.textContent = '';
    warn.hidden = true;
    if (snapshot.malformed.length) {
      const parseWarning = el('div', 'warn-banner', 'Could not parse: ' + snapshot.malformed.join(', '));
      parseWarning.setAttribute('role', 'alert');
      warn.appendChild(parseWarning);
      warn.hidden = false;
    }

    const board = document.getElementById('board');
    const receivedColumns = Array.isArray(snapshot.columns) ? snapshot.columns : [];
    const columnsById = new Map(receivedColumns
      .filter((column) => column && typeof column.id === 'string')
      .map((column) => [column.id, column]));
    const columns = COLUMN_SETTINGS.map((definition) => {
      const column = columnsById.get(definition.id);
      if (column && Array.isArray(column.cards)) {
        const cards = column.cards.filter((card) => (
          card && typeof card.id === 'string' && typeof card.title === 'string' &&
          typeof card.type === 'string' && typeof card.typeLabel === 'string' &&
          typeof card.status === 'string'
        ));
        return {
          ...column,
          label: typeof column.label === 'string' ? column.label : definition.label,
          agent: typeof column.agent === 'string' ? column.agent : (COLUMN_AGENT_DEFAULTS[definition.id] || 'None'),
          count: cards.length,
          cards,
        };
      }
      return {
          id: definition.id,
          label: definition.label,
          agent: COLUMN_AGENT_DEFAULTS[definition.id] || 'None',
          count: 0,
          cards: [],
        };
    });
    const taskSetId = typeof snapshot.activeTaskSetId === 'string' ? snapshot.activeTaskSetId : '';
    const sameTaskSet = renderedBoardTaskSetId === taskSetId;
    if (!sameTaskSet) { resetBoardFilters(); }
    renderBoardFilterControls();
    renderParentTasks(snapshot, sameTaskSet);
    if (sameTaskSet) {
      boardScrollLeft = board.scrollLeft;
      for (const existingColumn of board.querySelectorAll('.column[data-column-id]')) {
        const existingCards = existingColumn.querySelector('.cards');
        if (existingCards) {
          columnScrollTops.set(existingColumn.dataset.columnId, existingCards.scrollTop);
        }
      }
    } else {
      columnScrollTops.clear();
      boardScrollLeft = 0;
    }
    renderedBoardTaskSetId = taskSetId;
    const visibleColumns = columns.map((column) => ({
      column,
      cards: column.cards.filter(boardCardMatchesFilters),
    }));
    const totalCount = columns.reduce((total, column) => total + column.cards.length, 0);
    const visibleCount = visibleColumns.reduce((total, rendered) => total + rendered.cards.length, 0);
    renderBoardFilterSummary(visibleCount, totalCount, columns.length);
    board.textContent = '';
    const renderedColumns = [];

    for (const renderedColumn of visibleColumns) {
      const { column, cards: visibleCards } = renderedColumn;
      const node = el('div', 'column');
      node.dataset.columnId = column.id;
      // Everything colored inside the column — rail, tint, dot, count chip,
      // cards, action buttons — derives from this one call.
      applyAccent(node, column.id);

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
      titleRow.appendChild(el('span', 'dot'));
      titleRow.appendChild(el('span', 'column-title', column.label));
      titleRow.appendChild(el('span', 'count', String(visibleCards.length)));
      head.appendChild(titleRow);

      const agentMeta = el('div', 'agent-meta');
      agentMeta.appendChild(el('span', 'agent-label', 'Agent'));
      agentMeta.appendChild(el('span', 'agent-name', column.agent));
      const editIcon = el('span', 'agent-edit-icon');
      editIcon.innerHTML = editIconSvg;
      editIcon.classList.add('agent-edit-icon-active');
      editIcon.tabIndex = 0;
      editIcon.setAttribute('role', 'button');
      editIcon.title = 'Edit agent assignment';
      editIcon.setAttribute('aria-label', 'Edit agent assignment for ' + column.label);
      const openEditor = (e) => {
        e.stopPropagation();
        openSettingsModal(column.id);
      };
      editIcon.addEventListener('click', openEditor);
      editIcon.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openEditor(e); }
      });
      agentMeta.appendChild(editIcon);
      head.appendChild(agentMeta);

      node.appendChild(head);

      const cards = el('div', 'cards');
      cards.addEventListener('scroll', () => {
        columnScrollTops.set(column.id, cards.scrollTop);
      }, { passive: true });
      const addDropSlot = (beforeTaskId, label, empty = false) => {
        const slot = el('div', 'drop-slot' + (empty ? ' empty-slot' : ''));
        slot.setAttribute('role', 'separator');
        slot.setAttribute('aria-label', label);
        slot.addEventListener('dragover', (e) => activateDropSlot(slot, node, column, beforeTaskId, e));
        slot.addEventListener('dragleave', (e) => {
          e.stopPropagation();
          if (!e.relatedTarget || !slot.contains(e.relatedTarget)) {
            slot.classList.remove('active');
          }
        });
        slot.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const taskId = draggedTaskId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
          submitDrop(taskId, column, beforeTaskId);
        });
        cards.appendChild(slot);
      };

      if (column.cards.length === 0) {
        addDropSlot(null, 'Drop a task into ' + column.label, true);
      } else if (visibleCards.length === 0) {
        cards.appendChild(el('div', 'empty filtered-empty', 'No matching tasks'));
        addDropSlot(null, 'Drop a task into ' + column.label, true);
      } else {
        for (const card of visibleCards) {
          addDropSlot(card.id, 'Insert before ' + card.title);
          cards.appendChild(renderCard(card, selectedId, column));
        }
        addDropSlot(null, 'Insert at the end of ' + column.label);
      }
      node.appendChild(cards);
      board.appendChild(node);
      renderedColumns.push({ id: column.id, cards });
      restoreColumnScroll(cards, column.id);
    }
    restoreBoardScroll(board);
    requestAnimationFrame(() => {
      if (generation !== boardRenderGeneration) { return; }
      if (board.isConnected !== false) {
        restoreBoardScroll(board, true);
      }
      for (const rendered of renderedColumns) {
        if (rendered.cards.isConnected !== false) {
          restoreColumnScroll(rendered.cards, rendered.id, true);
        }
      }
    });
    focusPendingCard();
  }

  function updateSettingsCategory() {
    if (!SETTINGS_CATEGORIES.includes(selectedSettingsCategory)) {
      selectedSettingsCategory = DEFAULT_SETTINGS_CATEGORY;
    }
    document.querySelectorAll('.settings-category').forEach((button) => {
      const active = button.dataset.category === selectedSettingsCategory;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      const panel = document.getElementById(button.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !active;
        panel.setAttribute('aria-hidden', String(!active));
      }
    });
  }

  function selectSettingsCategory(category, focus = true) {
    if (!SETTINGS_CATEGORIES.includes(category)) { return; }
    selectedSettingsCategory = category;
    updateSettingsCategory();
    if (focus) {
      const active = document.querySelector('.settings-category[aria-selected="true"]');
      if (active) { active.focus(); }
    }
  }

  function settingId(key, suffix = '') {
    return 'setting-' + key.replace(/[^a-zA-Z0-9]+/g, '-') + suffix;
  }

  function settingDefaultText(definition) {
    if (Array.isArray(definition.defaultValue)) {
      return definition.defaultValue.length ? definition.defaultValue.join(', ') : 'empty list';
    }
    if (definition.defaultValue && typeof definition.defaultValue === 'object') {
      return '{}';
    }
    return String(definition.defaultValue);
  }

  function settingErrorFor(row, message) {
    const error = row.querySelector('.setting-error');
    if (!error) { return; }
    error.textContent = message || '';
    error.hidden = !message;
  }

  function settingControlValue(definition, row) {
    if (definition.kind === 'boolean') {
      return row.querySelector('input[data-setting-value]').checked;
    }
    if (definition.kind === 'number') {
      return Number(row.querySelector('input[data-setting-value]').value);
    }
    if (definition.kind === 'array') {
      return row.querySelector('textarea[data-setting-value]').value
        .split(/\\r?\\n/)
        .map((value) => value.trim())
        .filter(Boolean);
    }
    if (definition.kind === 'modelSelector') {
      const id = row.querySelector('[data-setting-field="id"]').value.trim();
      const vendor = row.querySelector('[data-setting-field="vendor"]').value.trim();
      return Object.assign({}, id ? { id } : {}, vendor ? { vendor } : {});
    }
    return row.querySelector('[data-setting-value]').value;
  }

  function settingControlFor(definition, value, row) {
    if (definition.kind === 'boolean') {
      const label = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value === true;
      input.dataset.settingValue = 'true';
      input.setAttribute('aria-label', definition.label);
      label.appendChild(input);
      const track = el('span', 'switch-track');
      track.appendChild(el('span', 'switch-thumb'));
      label.appendChild(track);
      return label;
    }
    if (definition.kind === 'enum') {
      const select = document.createElement('select');
      select.className = 'setting-select';
      select.dataset.settingValue = 'true';
      select.id = settingId(definition.key);
      select.setAttribute('aria-label', definition.label);
      for (const optionValue of definition.options || []) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        select.appendChild(option);
      }
      select.value = typeof value === 'string' ? value : '';
      return select;
    }
    if (definition.kind === 'array') {
      const textarea = document.createElement('textarea');
      textarea.className = 'setting-textarea';
      textarea.dataset.settingValue = 'true';
      textarea.id = settingId(definition.key);
      textarea.rows = 4;
      textarea.value = Array.isArray(value) ? value.join('\\n') : '';
      textarea.setAttribute('aria-label', definition.label + ' — one value per line');
      return textarea;
    }
    if (definition.kind === 'modelSelector') {
      const fields = el('div', 'setting-model-fields');
      for (const field of ['id', 'vendor']) {
        const fieldLabel = el('label', 'setting-model-field');
        fieldLabel.appendChild(el('span', 'setting-model-label', field));
        const input = document.createElement('input');
        input.className = 'setting-input';
        input.type = 'text';
        input.id = settingId(definition.key, '-' + field);
        input.dataset.settingField = field;
        input.value = value && typeof value === 'object' && typeof value[field] === 'string' ? value[field] : '';
        input.placeholder = 'Optional';
        input.setAttribute('aria-label', definition.label + ' ' + field);
        fieldLabel.appendChild(input);
        fields.appendChild(fieldLabel);
      }
      return fields;
    }
    const input = document.createElement('input');
    input.className = 'setting-input' + (definition.kind === 'number' ? ' setting-number' : '');
    input.dataset.settingValue = 'true';
    input.id = settingId(definition.key);
    input.type = definition.kind === 'number' ? 'number' : 'text';
    if (definition.kind === 'number') {
      input.step = definition.integer ? '1' : 'any';
      if (definition.key === 'run.timeoutMinutes') { input.min = '0.01'; }
      else if (typeof definition.minimum === 'number') { input.min = String(definition.minimum); }
      if (typeof definition.maximum === 'number') { input.max = String(definition.maximum); }
    }
    input.value = value === undefined || value === null ? '' : String(value);
    input.setAttribute('aria-label', definition.label);
    return input;
  }

  function renderTypedSettings(state) {
    const values = state.values || {};
    for (const category of SETTINGS_CATEGORIES) {
      if (category === 'gates' || category === 'agents') { continue; }
      const list = document.getElementById('settingsFields' + category.charAt(0).toUpperCase() + category.slice(1));
      if (!list) { continue; }
      list.textContent = '';
      for (const definition of SETTING_DEFINITIONS.filter((candidate) => candidate.category === category)) {
        if (definition.kind === 'agentNames') { continue; }
        const row = el('div', 'setting-row');
        row.id = settingId(definition.key, '-row');
        row.dataset.settingKey = definition.key;

        const label = el('div', 'setting-label', definition.label);
        label.id = settingId(definition.key, '-label');
        row.appendChild(label);
        const description = el('div', 'setting-description', definition.description);
        description.id = settingId(definition.key, '-description');
        row.appendChild(description);

        const note = el('div', 'setting-note', 'Default: ' + settingDefaultText(definition));
        if (definition.requiresReload) { note.textContent += ' Reload required after saving or resetting.'; }
        row.appendChild(note);

        const control = el('div', 'setting-control');
        control.appendChild(settingControlFor(definition, values[definition.key], row));
        row.appendChild(control);

        const error = el('div', 'setting-error');
        error.hidden = true;
        error.id = settingId(definition.key, '-error');
        error.setAttribute('role', 'alert');
        error.setAttribute('aria-live', 'assertive');
        row.appendChild(error);

        const actions = el('div', 'setting-actions');
        const save = el('button', 'btn-chip', 'Save');
        save.type = 'button';
        save.addEventListener('click', () => {
          settingErrorFor(row, '');
          vscode.postMessage({ type: 'settings/set', key: definition.key, value: settingControlValue(definition, row) });
        });
        actions.appendChild(save);
        const reset = el('button', 'btn-chip', 'Reset');
        reset.type = 'button';
        reset.addEventListener('click', () => {
          settingErrorFor(row, '');
          vscode.postMessage({ type: 'settings/reset', key: definition.key });
        });
        actions.appendChild(reset);
        row.appendChild(actions);
        list.appendChild(row);
      }
    }
  }

  function renderSettings(state) {
    const list = document.getElementById('gatesList');
    list.textContent = '';
    const gates = state.gates || {};
    for (const gate of GATES) {
      const row = el('div', 'gate-row');
      row.dataset.settingKey = gate.setting;

      const text = el('div', 'gate-text');
      text.appendChild(el('div', 'gate-label', gate.label));
      text.appendChild(el('div', 'gate-desc', gate.description));
      row.appendChild(text);

      const switchLabel = el('label', 'switch');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = gates[gate.key] === 'auto';
      input.setAttribute('aria-label', gate.label + ' — auto');
      input.addEventListener('change', () => {
        vscode.postMessage({ type: 'gates/set', key: gate.key, value: input.checked ? 'auto' : 'manual' });
      });
      switchLabel.appendChild(input);
      const track = el('span', 'switch-track');
      track.appendChild(el('span', 'switch-thumb'));
      switchLabel.appendChild(track);
      const actions = el('div', 'gate-actions');
      actions.appendChild(switchLabel);
      const reset = el('button', 'btn-chip', 'Reset');
      reset.type = 'button';
      reset.addEventListener('click', () => {
        vscode.postMessage({ type: 'settings/reset', key: gate.setting });
      });
      actions.appendChild(reset);
      row.appendChild(actions);

      list.appendChild(row);
    }

    const agents = document.getElementById('agentSettingsList');
    agents.textContent = '';
    settingErrorFor(document.getElementById('settingsPanelAgents'), '');
    const assignments = state.agents || {};
    const availableAgents = Array.isArray(state.availableAgents) ? state.availableAgents : [];
    const selectableAgents = Array.isArray(state.selectableAgents) ? state.selectableAgents : [];
    for (const column of COLUMN_SETTINGS) {
      const row = el('div', 'agent-setting-row');
      row.id = 'agent-setting-' + column.id;

      const label = el('label', 'agent-setting-label', column.label);
      label.htmlFor = 'agent-select-' + column.id;
      row.appendChild(label);

      const select = document.createElement('select');
      select.className = 'agent-setting-select';
      select.id = 'agent-select-' + column.id;
      select.setAttribute('aria-label', 'Agent assignment for ' + column.label);
      const reset = document.createElement('option');
      reset.value = '';
      const defaultValue = COLUMN_AGENT_DEFAULTS[column.id] || '';
      reset.textContent = defaultValue || 'None';
      select.appendChild(reset);
      for (const agent of availableAgents) {
        if (!agent || typeof agent.name !== 'string' || !agent.name) { continue; }
        const option = document.createElement('option');
        option.value = agent.name;
        option.textContent = agent.name;
        if (typeof agent.description === 'string' && agent.description) {
          option.title = agent.description;
        }
        select.appendChild(option);
      }
      const effectiveValue = assignments[column.id] || defaultValue || 'None';
      const selectedValue = effectiveValue === defaultValue || effectiveValue === 'None' ? '' : effectiveValue;
      if (selectedValue && !Array.from(select.options).some((option) => option.value === selectedValue)) {
        const current = document.createElement('option');
        current.value = selectedValue;
        current.textContent = selectedValue + ' (current)';
        select.appendChild(current);
      }
      select.value = selectedValue;
      row.appendChild(select);

      // Honest UI: a name this client has no registered agent action for still
      // renders the badge and the prompt persona line, but does not change which
      // agent runs the turn. Say so rather than implying otherwise.
      if (selectedValue && !selectableAgents.includes(selectedValue)) {
        const note = el('div', 'agent-setting-note', 'Presentation only — no matching agent is registered in this client, so runs use the default agent.');
        note.id = 'agent-setting-note-' + column.id;
        row.appendChild(note);
      }

      const actions = el('div', 'agent-setting-actions');
      const resetButton = el('button', 'btn-chip', 'Reset');
      resetButton.type = 'button';
      resetButton.addEventListener('click', () => {
        select.value = '';
        select.focus();
      });
      actions.appendChild(resetButton);
      row.appendChild(actions);
      agents.appendChild(row);
    }
    renderTypedSettings(state);
    updateSettingsCategory();
  }

  function renderTaskSets(snapshot) {
    const select = document.getElementById('taskSetSelect');
    select.textContent = '';
    for (const taskSet of snapshot.taskSets || []) {
      const option = document.createElement('option');
      option.value = taskSet.id;
      option.textContent = taskSet.name + (taskSet.isDefault ? ' (Default)' : '');
      select.appendChild(option);
    }
    select.value = snapshot.activeTaskSetId;
    const active = (snapshot.taskSets || []).find((taskSet) => taskSet.id === snapshot.activeTaskSetId);
    document.getElementById('taskSetRename').disabled = !active || active.isDefault;
    document.getElementById('taskSetDelete').disabled = !active || active.isDefault;
    select.title = 'Active task set: ' + (snapshot.activeTaskSetName || 'Default');
  }

  function renderParentTasks(snapshot, preserveSelection) {
    const select = document.getElementById('newTaskParent');
    if (!select) { return; }
    const previous = preserveSelection ? select.value : '';
    select.textContent = '';
    if (!snapshot || !Array.isArray(snapshot.parentOptions)) {
      const loading = document.createElement('option');
      loading.value = '';
      loading.textContent = 'Loading tasks...';
      loading.disabled = true;
      loading.selected = true;
      select.appendChild(loading);
      return;
    }

    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'None';
    select.appendChild(none);
    const options = snapshot.parentOptions
      .filter((task) => task && typeof task.id === 'string' && typeof task.name === 'string')
      .sort((left, right) => compareTaskIds(left.id, right.id));
    for (const task of options) {
      const option = document.createElement('option');
      option.value = task.id;
      option.textContent = task.id + ' - ' + task.name;
      select.appendChild(option);
    }
    select.value = options.some((task) => task.id === previous) ? previous : '';
  }

  function closeDetail() {
    closeTaskTree(false);
    document.getElementById('detailBackdrop').classList.remove('open');
    const modal = document.getElementById('detail');
    modal.textContent = '';
    delete modal.dataset.taskId;
    editingTaskId = null;
    vscode.postMessage({ type: 'task/deselect' });
  }

  function markMermaidUnavailable(root) {
    const diagrams = root.querySelectorAll('[data-mermaid-diagram]');
    for (const diagram of diagrams) {
      if (diagram.dataset.mermaidState) { continue; }
      diagram.dataset.mermaidState = 'unavailable';
      diagram.setAttribute('role', 'group');
      diagram.setAttribute('aria-label', 'Mermaid renderer unavailable');
      const message = el('div', 'modal-mermaid-message', 'Mermaid renderer unavailable; source is shown below.');
      message.setAttribute('role', 'status');
      diagram.insertBefore(message, diagram.firstChild);
    }
  }

  function renderMermaidInDetail(root) {
    const renderer = window.kanbanPilotMermaid;
    if (!renderer || typeof renderer.render !== 'function') {
      markMermaidUnavailable(root);
      return;
    }
    const runtimeScript = document.querySelector('script[data-kanban-pilot-mermaid]');
    const styleNonce = runtimeScript ? runtimeScript.getAttribute('nonce') || '' : '';
    let renderResult;
    try {
      renderResult = renderer.render(root, styleNonce);
    } catch {
      markMermaidUnavailable(root);
      return;
    }
    Promise.resolve(renderResult).catch(() => markMermaidUnavailable(root));
  }

  function escapeMermaidLabel(value) {
    return String(value || '')
      .replace(/\\\\/g, '\\\\\\\\')
      .replace(/"/g, '\\\\"')
      .replace(/[\\r\\n]+/g, ' ');
  }

  function taskTreeSource(tree) {
    const nodes = Array.isArray(tree && tree.nodes) ? tree.nodes : [];
    const keys = new Map();
    const lines = ['flowchart TD'];
    nodes.forEach((node, index) => {
      if (!node || typeof node.id !== 'string') { return; }
      const key = 'taskTreeNode' + index;
      keys.set(node.id, key);
      lines.push('  ' + key + '["Task ID: ' + escapeMermaidLabel(node.id) +
        '<br/>Task Name: ' + escapeMermaidLabel(node.name) +
        '<br/>Task Status: ' + escapeMermaidLabel(node.status) + '"]');
    });
    for (const edge of Array.isArray(tree && tree.edges) ? tree.edges : []) {
      const parent = keys.get(edge && edge.parentId);
      const child = keys.get(edge && edge.childId);
      if (parent && child && parent !== child) {
        lines.push('  ' + parent + ' --> ' + child);
      }
    }
    return lines.join('\\n');
  }

  const TASK_TREE_MIN_SCALE = 0.5;
  const TASK_TREE_MAX_SCALE = 4;
  const TASK_TREE_SCALE_STEP = 0.1;
  const TASK_TREE_MIN_VISIBLE = 48;
  let taskTreeOpen = false;
  let taskTreeOpenTaskId = null;
  let taskTreeTrigger = null;
  let taskTreeView = { scale: 1, x: 0, y: 0 };

  function clampTaskTreeScale(value) {
    return Math.min(TASK_TREE_MAX_SCALE, Math.max(TASK_TREE_MIN_SCALE, Math.round(value * 10) / 10));
  }

  function taskTreeViewportMetrics(viewport, canvas) {
    const viewportRect = viewport.getBoundingClientRect();
    const viewportWidth = Math.max(1, viewport.clientWidth || viewportRect.width || 320);
    const viewportHeight = Math.max(1, viewport.clientHeight || viewportRect.height || 220);
    const canvasRect = canvas.getBoundingClientRect();
    const measuredWidth = Math.max(canvas.scrollWidth || 0, canvas.offsetWidth || 0, canvasRect.width || 0);
    const measuredHeight = Math.max(canvas.scrollHeight || 0, canvas.offsetHeight || 0, canvasRect.height || 0);
    return {
      left: viewportRect.left || 0,
      top: viewportRect.top || 0,
      viewportWidth,
      viewportHeight,
      canvasWidth: measuredWidth || viewportWidth * 2,
      canvasHeight: measuredHeight || viewportHeight * 2,
    };
  }

  function clampTaskTreeTranslation(viewport, canvas, x, y) {
    const metrics = taskTreeViewportMetrics(viewport, canvas);
    const scaledWidth = metrics.canvasWidth * taskTreeView.scale;
    const scaledHeight = metrics.canvasHeight * taskTreeView.scale;
    const visibleWidth = Math.min(TASK_TREE_MIN_VISIBLE, metrics.viewportWidth, scaledWidth);
    const visibleHeight = Math.min(TASK_TREE_MIN_VISIBLE, metrics.viewportHeight, scaledHeight);
    return {
      x: Math.min(metrics.viewportWidth - visibleWidth, Math.max(visibleWidth - scaledWidth, x)),
      y: Math.min(metrics.viewportHeight - visibleHeight, Math.max(visibleHeight - scaledHeight, y)),
    };
  }

  function taskTreeNumber(value) {
    const rounded = Math.round(value * 100) / 100;
    return String(Math.abs(rounded) < 0.005 ? 0 : rounded);
  }

  function updateTaskTreeControls(sidecar) {
    const zoomIn = sidecar.querySelector('button[aria-label="Zoom in"]');
    const zoomOut = sidecar.querySelector('button[aria-label="Zoom out"]');
    if (zoomIn) { zoomIn.disabled = taskTreeView.scale >= TASK_TREE_MAX_SCALE; }
    if (zoomOut) { zoomOut.disabled = taskTreeView.scale <= TASK_TREE_MIN_SCALE; }
    const viewport = sidecar.querySelector('.task-tree-viewport');
    if (viewport) { viewport.setAttribute('aria-valuetext', taskTreeNumber(taskTreeView.scale) + 'x'); }
  }

  function applyTaskTreeView(viewport, canvas, sidecar) {
    const translation = clampTaskTreeTranslation(viewport, canvas, taskTreeView.x, taskTreeView.y);
    taskTreeView.x = translation.x;
    taskTreeView.y = translation.y;
    canvas.style.transform = 'translate(' + taskTreeNumber(taskTreeView.x) + 'px, ' +
      taskTreeNumber(taskTreeView.y) + 'px) scale(' + taskTreeNumber(taskTreeView.scale) + ')';
    canvas.dataset.scale = taskTreeNumber(taskTreeView.scale);
    updateTaskTreeControls(sidecar);
  }

  function zoomTaskTree(viewport, canvas, sidecar, requestedScale, clientX, clientY) {
    const previousScale = taskTreeView.scale;
    const nextScale = clampTaskTreeScale(requestedScale);
    if (nextScale === previousScale) {
      updateTaskTreeControls(sidecar);
      return;
    }
    const metrics = taskTreeViewportMetrics(viewport, canvas);
    const anchorX = typeof clientX === 'number' ? clientX - metrics.left : metrics.viewportWidth / 2;
    const anchorY = typeof clientY === 'number' ? clientY - metrics.top : metrics.viewportHeight / 2;
    const contentX = (anchorX - taskTreeView.x) / previousScale;
    const contentY = (anchorY - taskTreeView.y) / previousScale;
    taskTreeView.scale = nextScale;
    taskTreeView.x = anchorX - contentX * nextScale;
    taskTreeView.y = anchorY - contentY * nextScale;
    applyTaskTreeView(viewport, canvas, sidecar);
  }

  function resetTaskTreeView(viewport, canvas, sidecar) {
    taskTreeView = { scale: 1, x: 0, y: 0 };
    applyTaskTreeView(viewport, canvas, sidecar);
  }

  function panTaskTree(viewport, canvas, sidecar, deltaX, deltaY) {
    taskTreeView.x += deltaX;
    taskTreeView.y += deltaY;
    applyTaskTreeView(viewport, canvas, sidecar);
  }

  function taskTreeControl(label, icon, onClick) {
    const button = el('button', 'icon-btn task-tree-control');
    button.type = 'button';
    button.innerHTML = icon;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', onClick);
    return button;
  }

  function installTaskTreeViewport(viewport, canvas, sidecar) {
    const pointers = new Map();
    let drag = null;
    let pinch = null;

    const distanceBetween = (first, second) => Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
    const centerBetween = (first, second) => ({
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    });
    const startPinch = () => {
      const points = [...pointers.values()];
      if (points.length < 2) { return; }
      const center = centerBetween(points[0], points[1]);
      pinch = {
        distance: distanceBetween(points[0], points[1]),
        center,
        scale: taskTreeView.scale,
        x: taskTreeView.x,
        y: taskTreeView.y,
      };
    };
    const releasePointer = (pointerId) => {
      if (typeof viewport.releasePointerCapture === 'function') {
        try { viewport.releasePointerCapture(pointerId); } catch { /* already released */ }
      }
    };

    viewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'touch' && event.isPrimary === false) { return; }
      if (event.pointerType !== 'touch' && event.button !== undefined && event.button !== 0) { return; }
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('button')) { return; }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        viewport.classList.add('is-panning');
      } else if (pointers.size === 2) {
        drag = null;
        startPinch();
      }
      if (typeof viewport.setPointerCapture === 'function') {
        viewport.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    });

    viewport.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId)) { return; }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        if (!pinch) { startPinch(); }
        const points = [...pointers.values()];
        const center = centerBetween(points[0], points[1]);
        const distance = distanceBetween(points[0], points[1]);
        const nextScale = clampTaskTreeScale(pinch.scale * distance / pinch.distance);
        const metrics = taskTreeViewportMetrics(viewport, canvas);
        const initialCenterX = pinch.center.x - metrics.left;
        const initialCenterY = pinch.center.y - metrics.top;
        const contentX = (initialCenterX - pinch.x) / pinch.scale;
        const contentY = (initialCenterY - pinch.y) / pinch.scale;
        taskTreeView.scale = nextScale;
        taskTreeView.x = center.x - metrics.left - contentX * nextScale;
        taskTreeView.y = center.y - metrics.top - contentY * nextScale;
        applyTaskTreeView(viewport, canvas, sidecar);
      } else if (drag && drag.pointerId === event.pointerId) {
        panTaskTree(viewport, canvas, sidecar, event.clientX - drag.x, event.clientY - drag.y);
        drag.x = event.clientX;
        drag.y = event.clientY;
      }
      event.preventDefault();
    });

    const finishPointer = (event) => {
      if (!pointers.has(event.pointerId)) { return; }
      pointers.delete(event.pointerId);
      releasePointer(event.pointerId);
      if (pointers.size === 0) {
        drag = null;
        pinch = null;
        viewport.classList.remove('is-panning');
      } else if (pointers.size === 1) {
        const remaining = [...pointers.entries()][0];
        drag = { pointerId: remaining[0], x: remaining[1].x, y: remaining[1].y };
        pinch = null;
      }
      event.preventDefault();
    };
    viewport.addEventListener('pointerup', finishPointer);
    viewport.addEventListener('pointercancel', finishPointer);

    viewport.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.deltaY === 0) { return; }
      zoomTaskTree(
        viewport,
        canvas,
        sidecar,
        taskTreeView.scale + (event.deltaY < 0 ? TASK_TREE_SCALE_STEP : -TASK_TREE_SCALE_STEP),
        event.clientX,
        event.clientY,
      );
    }, { passive: false });

    viewport.addEventListener('keydown', (event) => {
      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomTaskTree(viewport, canvas, sidecar, taskTreeView.scale + TASK_TREE_SCALE_STEP);
        return;
      }
      if (event.key === '-') {
        event.preventDefault();
        zoomTaskTree(viewport, canvas, sidecar, taskTreeView.scale - TASK_TREE_SCALE_STEP);
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        resetTaskTreeView(viewport, canvas, sidecar);
        return;
      }
      const distance = event.shiftKey ? 96 : 24;
      if (event.key === 'ArrowLeft') { event.preventDefault(); panTaskTree(viewport, canvas, sidecar, -distance, 0); }
      if (event.key === 'ArrowRight') { event.preventDefault(); panTaskTree(viewport, canvas, sidecar, distance, 0); }
      if (event.key === 'ArrowUp') { event.preventDefault(); panTaskTree(viewport, canvas, sidecar, 0, -distance); }
      if (event.key === 'ArrowDown') { event.preventDefault(); panTaskTree(viewport, canvas, sidecar, 0, distance); }
    });
  }

  function renderTaskTreeSidecar(tree, focusClose = false) {
    const sidecar = document.getElementById('taskTreeSidecar');
    if (!sidecar || !tree) { return; }
    let body = sidecar.querySelector('.task-tree-body');
    let viewport;
    let canvas;
    let alternative;
    if (!body) {
      sidecar.textContent = '';
      const head = el('div', 'task-tree-head');
      const title = el('div', 'modal-title', 'Task Tree');
      title.id = 'taskTreeTitle';
      head.appendChild(title);
      const close = el('button', 'modal-close', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Close Task Tree');
      close.title = 'Close Task Tree';
      close.addEventListener('click', () => closeTaskTree(true));
      head.appendChild(close);
      sidecar.appendChild(head);
      body = el('div', 'task-tree-body');
      sidecar.appendChild(body);

      viewport = el('div', 'task-tree-viewport');
      viewport.setAttribute('tabindex', '0');
      viewport.setAttribute('aria-label', 'Task Tree viewport');
      viewport.setAttribute('role', 'group');
      canvas = el('div', 'task-tree-canvas');
      viewport.appendChild(canvas);
      const controls = el('div', 'task-tree-controls');
      controls.setAttribute('role', 'group');
      controls.setAttribute('aria-label', 'Task Tree view controls');
      controls.appendChild(taskTreeControl('Zoom in', zoomInIconSvg, () => (
        zoomTaskTree(viewport, canvas, sidecar, taskTreeView.scale + TASK_TREE_SCALE_STEP)
      )));
      controls.appendChild(taskTreeControl('Zoom out', zoomOutIconSvg, () => (
        zoomTaskTree(viewport, canvas, sidecar, taskTreeView.scale - TASK_TREE_SCALE_STEP)
      )));
      controls.appendChild(taskTreeControl('Reset view', resetViewIconSvg, () => (
        resetTaskTreeView(viewport, canvas, sidecar)
      )));
      body.appendChild(controls);
      body.appendChild(viewport);
      alternative = el('div', 'task-tree-alternative sr-only');
      alternative.setAttribute('role', 'list');
      alternative.setAttribute('aria-label', 'Task Tree text alternative');
      body.appendChild(alternative);
      installTaskTreeViewport(viewport, canvas, sidecar);
    } else {
      viewport = body.querySelector('.task-tree-viewport');
      canvas = body.querySelector('.task-tree-canvas');
      alternative = body.querySelector('.task-tree-alternative');
    }
    if (!viewport || !canvas || !alternative) { return; }

    const graph = el('div', 'modal-mermaid');
    graph.dataset.mermaidDiagram = 'true';
    graph.setAttribute('role', 'group');
    graph.setAttribute('aria-label', 'Task Tree diagram');
    const source = document.createElement('pre');
    source.className = 'modal-mermaid-source';
    source.setAttribute('aria-label', 'Task Tree Mermaid source');
    source.textContent = taskTreeSource(tree);
    graph.appendChild(source);
    canvas.textContent = '';
    canvas.appendChild(graph);

    alternative.textContent = '';
    for (const node of Array.isArray(tree.nodes) ? tree.nodes : []) {
      if (!node || typeof node.id !== 'string') { continue; }
      const item = el('div', null,
        'Task ID: ' + node.id + '; Task Name: ' + String(node.name || '') +
        '; Task Status: ' + String(node.status || ''));
      item.setAttribute('role', 'listitem');
      alternative.appendChild(item);
    }
    for (const edge of Array.isArray(tree.edges) ? tree.edges : []) {
      if (!edge || typeof edge.parentId !== 'string' || typeof edge.childId !== 'string') { continue; }
      const item = el('div', null, 'Parent Task ID: ' + edge.parentId + '; Child Task ID: ' + edge.childId);
      item.setAttribute('role', 'listitem');
      alternative.appendChild(item);
    }
    sidecar.hidden = false;
    applyTaskTreeView(viewport, canvas, sidecar);
    renderMermaidInDetail(sidecar);
    if (focusClose) {
      sidecar.querySelector('.modal-close').focus();
    }
  }

  function openTaskTree(tree, trigger) {
    if (!tree || !trigger) { return; }
    taskTreeView = { scale: 1, x: 0, y: 0 };
    taskTreeOpen = true;
    taskTreeOpenTaskId = tree.rootTaskId;
    taskTreeTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    renderTaskTreeSidecar(tree, true);
  }

  function closeTaskTree(restoreFocus = true) {
    const sidecar = document.getElementById('taskTreeSidecar');
    const trigger = taskTreeTrigger;
    if (sidecar) {
      sidecar.hidden = true;
      sidecar.textContent = '';
    }
    taskTreeOpen = false;
    taskTreeOpenTaskId = null;
    taskTreeTrigger = null;
    if (trigger) {
      trigger.setAttribute('aria-expanded', 'false');
      if (restoreFocus && trigger.isConnected) {
        trigger.focus();
      }
    }
  }

  function appendDetailActions(links, task) {
    if (task.pending) {
      const pendingAction = el('button', 'btn-modal-primary', 'Apply ' + task.pending.label);
      pendingAction.type = 'button';
      pendingAction.setAttribute('aria-label', 'Apply pending completion: ' + task.pending.label);
      pendingAction.title = task.pending.description;
      pendingAction.addEventListener('click', () => vscode.postMessage({ type: 'pending/apply', taskId: task.id }));
      links.appendChild(pendingAction);
    } else if (task.primary) {
      links.appendChild(actionButton(task.id, task.primary));
    }
    for (const candidate of task.staleCompletions || []) {
      const recovery = el('button', 'btn-modal-primary', 'Recover ' + candidate.stage + ' completion');
      recovery.type = 'button';
      recovery.setAttribute('aria-label', 'Recover stale ' + candidate.stage + ' completion from run ' + candidate.runId);
      recovery.title = 'Old run ' + candidate.runId + '. Latest run: ' + (candidate.latestRunId || 'none') + '. ' + candidate.summary;
      recovery.addEventListener('click', () => vscode.postMessage({
        type: 'stale/recover',
        taskId: task.id,
        runId: candidate.runId,
        stage: candidate.stage,
      }));
      links.appendChild(recovery);
    }
    if (task.secondary) { links.appendChild(actionButton(task.id, task.secondary)); }
  }

  function appendOutcomeGuidance(parent, outcome) {
    if (!outcome || typeof outcome !== 'object' ||
      typeof outcome.kind !== 'string' || typeof outcome.label !== 'string' ||
      typeof outcome.summary !== 'string' || typeof outcome.whatHappened !== 'string' ||
      typeof outcome.holding !== 'string' || typeof outcome.nextStep !== 'string') {
      return;
    }
    const knownKinds = ['running', 'blocked', 'failed', 'pending', 'stale'];
    const outcomeKind = knownKinds.includes(outcome.kind) ? outcome.kind : 'unknown';
    const section = el('section', 'outcome-guidance ' + outcomeKind);
    section.setAttribute('role', 'status');
    section.setAttribute('aria-label', outcome.label + ': ' + outcome.summary);
    section.appendChild(el('div', 'outcome-guidance-label', outcome.label));

    const context = [];
    if (typeof outcome.stage === 'string') {
      context.push('Stage: ' + outcome.stage.charAt(0).toUpperCase() + outcome.stage.slice(1));
    }
    if (typeof outcome.runId === 'string') { context.push('Run: ' + outcome.runId); }
    if (typeof outcome.gateLabel === 'string') { context.push('Gate: ' + outcome.gateLabel); }
    if (typeof outcome.currentRunId === 'string') { context.push('Current run: ' + outcome.currentRunId); }
    if (typeof outcome.latestRunId === 'string') { context.push('Latest run: ' + outcome.latestRunId); }
    if (typeof outcome.reason === 'string') { context.push('Reason: ' + outcome.reason); }
    if (typeof outcome.receiptSummary === 'string') { context.push('Receipt: ' + outcome.receiptSummary); }
    if (context.length) {
      section.appendChild(el('div', 'outcome-guidance-context', context.join(' · ')));
    }

    const rows = [
      ['What happened', 'outcome-guidance-summary', outcome.whatHappened],
      ['What is holding this task', 'outcome-guidance-holding', outcome.holding],
      ['Next legal action', 'outcome-guidance-next', outcome.nextStep],
    ];
    for (const [label, className, value] of rows) {
      const row = el('div', 'outcome-guidance-row');
      row.appendChild(el('span', 'outcome-guidance-key', label));
      row.appendChild(el('div', className, value));
      section.appendChild(row);
    }
    parent.appendChild(section);
  }

  function renderDetail(task, preserveOpenModal = false) {
    const backdrop = document.getElementById('detailBackdrop');
    const modal = document.getElementById('detail');

    if (!task) {
      closeTaskTree(false);
      backdrop.classList.remove('open');
      modal.textContent = '';
      delete modal.dataset.taskId;
      editingTaskId = null;
      return;
    }
    const detailWasOpen = backdrop.classList.contains('open');
    const settingsOpen = document.getElementById('settingsBackdrop').classList.contains('open');
    const newTaskOpen = document.getElementById('newTaskBackdrop').classList.contains('open');
    // A background refresh must not replace a dialog the user is actively
    // using. The selected task remains host-side and will refresh when its
    // detail dialog is next opened.
    if (preserveOpenModal && !detailWasOpen && (settingsOpen || newTaskOpen)) {
      return;
    }
    const sameTask = modal.dataset.taskId === task.id;
    const sidecarWasOpen = taskTreeOpen && taskTreeOpenTaskId === task.id;
    const focusDetailCloseAfterTreeClose = sidecarWasOpen && !task.taskTree;
    if (taskTreeOpen && (!sameTask || !task.taskTree)) {
      closeTaskTree(false);
    }
    const retainedScrollTop = modal.dataset.taskId === task.id
      ? modal.querySelector('.modal-body')?.scrollTop || 0
      : 0;
    // The activity feed scrolls independently, and it grows while a run is in
    // flight. Stick to the newest entry only when the reader was already there;
    // yanking someone who scrolled up to read an earlier row is worse than
    // making them scroll down again.
    const previousFeed = modal.dataset.taskId === task.id
      ? modal.querySelector('.activity-feed')
      : null;
    const retainedFeedScrollTop = previousFeed ? previousFeed.scrollTop : 0;
    const feedWasAtBottom = !previousFeed
      || previousFeed.scrollHeight - previousFeed.scrollTop - previousFeed.clientHeight <= 8;
    modal.textContent = '';
    modal.dataset.taskId = task.id;
    editingTaskId = null;
    backdrop.classList.add('open');
    // Set on the backdrop, not the modal: the backdrop's radial wash reads the
    // same hue, and .modal inherits it from here.
    applyAccent(backdrop, task.state);
    modal.setAttribute('aria-label', 'Task detail for ' + task.title + ' — ' + task.typeLabel);

    const head = el('div', 'modal-head');
    const left = el('div', 'modal-head-left');
    left.appendChild(el('div', 'modal-title', task.title));
    const badges = el('div', 'modal-badges');
    badges.appendChild(el('span', 'modal-id', task.id));
    const typeBadge = el('span', 'badge-task-type ' + task.type, task.typeLabel);
    typeBadge.title = 'Task type: ' + task.typeLabel;
    typeBadge.setAttribute('aria-label', 'Task type: ' + task.typeLabel);
    badges.appendChild(typeBadge);
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
    appendOutcomeGuidance(body, task.outcome);

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
    const edit = el('button', 'btn-chip', task.canEdit === false ? 'Editing unavailable while running' : 'Edit task');
    edit.type = 'button';
    edit.disabled = task.canEdit === false;
    edit.setAttribute('aria-label', task.canEdit === false ? 'Editing unavailable while task is running' : 'Edit task');
    edit.title = task.canEdit === false ? 'Stop the running task before editing it' : 'Edit task details';
    edit.addEventListener('click', () => renderEditDetail(task));
    links.appendChild(edit);
    const openLink = el('button', 'modal-link', 'Open task file →');
    openLink.addEventListener('click', () => vscode.postMessage({ type: 'task/open', taskId: task.id }));
    links.appendChild(openLink);
    const openChatLink = el('button', 'modal-link', 'Open Chat →');
    openChatLink.addEventListener('click', () => vscode.postMessage({ type: 'task/openChat', taskId: task.id }));
    links.appendChild(openChatLink);
    if (task.taskTree) {
      const treeButton = el('button', 'btn-chip', 'Show Task Tree');
      treeButton.type = 'button';
      treeButton.setAttribute('aria-controls', 'taskTreeSidecar');
      treeButton.setAttribute('aria-expanded', String(sidecarWasOpen));
      treeButton.addEventListener('click', () => openTaskTree(task.taskTree, treeButton));
      links.appendChild(treeButton);
      if (sidecarWasOpen) {
        taskTreeTrigger = treeButton;
      }
    }
    appendDetailActions(links, task);
    body.appendChild(links);

    for (const [label, rendered] of [
      ['Request', task.requestHtml],
      ['Refined', task.refinedHtml],
      ['Scope', task.scopeHtml],
    ]) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', label));
      const sectionBody = el('div', 'modal-section-body');
      sectionBody.innerHTML = typeof rendered === 'string' ? rendered : '';
      section.appendChild(sectionBody);
      body.appendChild(section);
    }

    if (task.lastLog) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', 'Latest log'));
      section.appendChild(el('div', 'modal-section-body plain', task.lastLog));
      body.appendChild(section);
    }

    const activitySection = el('div');
    activitySection.appendChild(el('div', 'modal-section-label', 'Activity'));
    const hasActivityOverview = appendActivityOverview(activitySection, task.activity);
    if (task.status === 'blocked') {
      const blocked = el('div', 'activity-blocked', 'This task is blocked; approval or action is required in the VS Code host.');
      blocked.setAttribute('role', 'status');
      activitySection.appendChild(blocked);
    }
    const activityFeed = el('div', 'activity-feed');
    const feed = Array.isArray(task.feed)
      ? task.feed.filter((entry) => (
        entry && typeof entry === 'object' &&
        typeof entry.at === 'string' && typeof entry.note === 'string'
      ))
      : [];
    if (!feed.length) {
      activityFeed.appendChild(el(
        'div',
        'activity-empty',
        hasActivityOverview ? 'No activity entries are available from the enabled sources.' : 'No activity recorded yet.',
      ));
    } else {
      for (const entry of feed) {
        // Source labels are text, not just colors or row styling. Tailed rows
        // also carry a separate observation time because they can lag the event.
        const source = entry.source === 'hook' || entry.source === 'transcript' ? entry.source : 'progress';
        const eventAt = safeActivityTimestamp(entry.at);
        if (!eventAt) { continue; }
        const observedAt = safeActivityTimestamp(entry.observedAt);
        const row = el('div', 'activity-row activity-' + source);
        row.setAttribute('aria-label', activitySourceLabel(source) + '. Event time: ' + eventAt +
          (observedAt ? '. Observed: ' + observedAt : ''));
        const meta = el('div', 'activity-meta');
        meta.appendChild(el('div', 'activity-source-label', activitySourceLabel(source)));
        const time = document.createElement('time');
        time.className = 'activity-time';
        time.dateTime = eventAt;
        time.setAttribute('aria-label', 'Event time: ' + eventAt);
        time.textContent = eventAt;
        meta.appendChild(time);
        if (observedAt && source !== 'progress') {
          const observed = document.createElement('time');
          observed.className = 'activity-observed';
          observed.dateTime = observedAt;
          observed.setAttribute('aria-label', 'Observed time: ' + observedAt);
          observed.textContent = 'Observed: ' + observedAt;
          meta.appendChild(observed);
        }
        row.appendChild(meta);
        row.appendChild(el('div', 'activity-note', entry.note));
        activityFeed.appendChild(row);
      }
    }
    activitySection.appendChild(activityFeed);
    body.appendChild(activitySection);

    modal.appendChild(body);
    if (sidecarWasOpen && task.taskTree) {
      renderTaskTreeSidecar(task.taskTree);
    } else if (focusDetailCloseAfterTreeClose) {
      close.focus();
    }
    const settleFeedScroll = () => {
      if (!activityFeed.isConnected) { return; }
      const maxTop = Math.max(0, activityFeed.scrollHeight - activityFeed.clientHeight);
      activityFeed.scrollTop = feedWasAtBottom ? maxTop : Math.min(retainedFeedScrollTop, maxTop);
    };
    settleFeedScroll();
    requestAnimationFrame(settleFeedScroll);
    if (retainedScrollTop) {
      const restore = () => {
        if (!body.isConnected) { return; }
        body.scrollTop = Math.min(retainedScrollTop, Math.max(0, body.scrollHeight - body.clientHeight));
      };
      restore();
      requestAnimationFrame(restore);
    }
    renderMermaidInDetail(modal);
  }

  let editingTaskId = null;

  const TASK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
  const TASK_ATTACHMENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  let attachmentIdSequence = 0;

  function createAttachmentState(existing) {
    return { add: [], remove: [], existing: Array.isArray(existing) ? existing : [] };
  }

  function attachmentId() {
    attachmentIdSequence += 1;
    return 'image-' + Date.now().toString(36) + '-' + attachmentIdSequence.toString(36);
  }

  function displayFileName(file, fallback) {
    const original = typeof file.name === 'string' && file.name ? file.name : fallback;
    const extension = file.type === 'image/jpeg' ? '.jpg' : ('.' + file.type.split('/')[1]);
    let name = original.replace(/[\\\\/]/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\\.\\.+/g, '.');
    name = name.replace(/^-+|-+$/g, '').slice(0, 100);
    if (!name) { name = 'image' + extension; }
    return name;
  }

  function fileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(new Error('The image could not be read.'));
      reader.readAsDataURL(file);
    });
  }

  function canonicalAttachmentMimeType(value) {
    const mimeType = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (mimeType === 'image/jpg' || mimeType === 'image/pjpeg') { return 'image/jpeg'; }
    if (mimeType === 'image/x-png') { return 'image/png'; }
    return mimeType;
  }

  function attachmentMimeTypeFor(file, sourceMimeType) {
    for (const candidate of [sourceMimeType, file && file.type]) {
      const mimeType = canonicalAttachmentMimeType(candidate);
      if (TASK_ATTACHMENT_TYPES.has(mimeType)) { return mimeType; }
    }
    return canonicalAttachmentMimeType(sourceMimeType || (file && file.type));
  }

  function supportedClipboardImageFile() {
    if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
      return Promise.reject(new Error('The clipboard did not provide a PNG, JPEG, GIF, or WebP image.'));
    }
    return navigator.clipboard.read().then((clipboardItems) => {
      for (const clipboardItem of clipboardItems) {
        const sourceType = Array.from(clipboardItem.types || []).find((type) => TASK_ATTACHMENT_TYPES.has(canonicalAttachmentMimeType(type)));
        if (!sourceType) { continue; }
        const mimeType = canonicalAttachmentMimeType(sourceType);
        return clipboardItem.getType(sourceType).then((blob) => new File(
          [blob],
          'pasted-image.' + mimeType.split('/')[1],
          { type: mimeType },
        ));
      }
      throw new Error('The clipboard did not provide a PNG, JPEG, GIF, or WebP image.');
    });
  }

  function formatAttachmentSize(size) {
    if (size >= 1024 * 1024) { return (size / (1024 * 1024)).toFixed(1) + ' MiB'; }
    return Math.max(1, Math.round(size / 1024)) + ' KiB';
  }

  function setAttachmentError(node, message) {
    node.textContent = message || '';
    node.hidden = !message;
  }

  function removeAttachmentMarkdown(text, reference) {
    const escaped = reference.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    return text.replace(new RegExp('!\\\\[[^\\\\]\\\\r\\\\n]*\\\\]\\\\(' + escaped + '\\\\)', 'g'), '');
  }

  function imageMarkerPresent(text, id) {
    return text.indexOf('attachment://' + id) !== -1;
  }

  function attachmentTextareas(container) {
    return Array.from(container.querySelectorAll('textarea[data-attachment-target="true"]'));
  }

  function renderAttachmentShelf(state, shelf, textareas, errorNode) {
    shelf.textContent = '';
    const visible = state.existing.filter((attachment) => !state.remove.includes(attachment.relativePath));
    const items = state.add.map((attachment) => ({ ...attachment, staged: true, src: attachment.data }))
      .concat(visible.map((attachment) => ({ ...attachment, staged: false })));
    for (const attachment of items) {
      const card = el('div', 'attachment-card');
      const image = document.createElement('img');
      image.src = attachment.src;
      image.alt = attachment.name;
      card.appendChild(image);
      const text = el('div');
      text.appendChild(el('div', 'attachment-card-name', attachment.name));
      text.appendChild(el('div', 'attachment-card-meta', (attachment.staged ? 'Staged · ' : 'Saved · ') + formatAttachmentSize(attachment.size || 0)));
      card.appendChild(text);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attachment-remove';
      remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove image ' + attachment.name);
      remove.addEventListener('click', () => {
        if (attachment.staged) {
          state.add = state.add.filter((candidate) => candidate.id !== attachment.id);
          for (const textarea of textareas) {
            textarea.value = removeAttachmentMarkdown(textarea.value, 'attachment://' + attachment.id);
          }
        } else {
          if (!state.remove.includes(attachment.relativePath)) {
            state.remove.push(attachment.relativePath);
          }
          for (const textarea of textareas) {
            textarea.value = removeAttachmentMarkdown(textarea.value, attachment.relativePath);
          }
        }
        setAttachmentError(errorNode, '');
        renderAttachmentShelf(state, shelf, textareas, errorNode);
      });
      card.appendChild(remove);
      shelf.appendChild(card);
    }
  }

  function insertAttachment(textarea, attachment, cursor) {
    const marker = '![' + attachment.name + '](attachment://' + attachment.id + ')';
    const start = cursor && typeof cursor.start === 'number'
      ? cursor.start
      : (typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length);
    const end = cursor && typeof cursor.end === 'number'
      ? cursor.end
      : (typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : start);
    textarea.value = textarea.value.slice(0, start) + marker + textarea.value.slice(end);
    const caret = start + marker.length;
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
    if (cursor) {
      cursor.start = caret;
      cursor.end = caret;
    }
  }

  function attachImageFile(file, textarea, state, shelf, textareas, errorNode, cursor, sourceMimeType) {
    const mimeType = attachmentMimeTypeFor(file, sourceMimeType);
    if (!file || !TASK_ATTACHMENT_TYPES.has(mimeType)) {
      setAttachmentError(errorNode, 'Only PNG, JPEG, GIF, and WebP images are supported.');
      return Promise.resolve();
    }
    const imageFile = file.type === mimeType
      ? file
      : new File([file], file.name || 'pasted-image.' + mimeType.split('/')[1], { type: mimeType });
    if (imageFile.size > TASK_ATTACHMENT_MAX_BYTES) {
      setAttachmentError(errorNode, 'Each image must be 10 MiB or smaller.');
      return Promise.resolve();
    }
    return fileAsDataUrl(imageFile).then((data) => {
      const attachment = {
        id: attachmentId(),
        name: displayFileName(imageFile, 'pasted-image.' + mimeType.split('/')[1]),
        mimeType,
        data,
        size: imageFile.size,
      };
      state.add.push(attachment);
      insertAttachment(textarea, attachment, cursor);
      setAttachmentError(errorNode, '');
      renderAttachmentShelf(state, shelf, textareas, errorNode);
    }).catch((error) => {
      setAttachmentError(errorNode, error && error.message ? error.message : 'The image could not be read.');
    });
  }

  function wireAttachmentForm(container, state, picker, shelf, errorNode, buttons) {
    const textareas = attachmentTextareas(container);
    let target = textareas[0];
    for (const textarea of textareas) {
      textarea.addEventListener('focus', () => { target = textarea; });
      textarea.addEventListener('click', () => { target = textarea; });
      textarea.addEventListener('paste', (event) => {
        const imageItems = Array.from(event.clipboardData && event.clipboardData.items || [])
          .filter((item) => item.kind === 'file' && item.type.indexOf('image/') === 0);
        if (!imageItems.length) { return; }
        event.preventDefault();
        const cursor = {
          start: typeof textarea.selectionStart === 'number' ? textarea.selectionStart : textarea.value.length,
          end: typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : textarea.value.length,
        };
        const imageFiles = imageItems.map((item) => ({ item, file: item.getAsFile() }));
        const supportedItems = imageFiles.filter(({ item, file }) => file && TASK_ATTACHMENT_TYPES.has(attachmentMimeTypeFor(file, item.type)));
        if (supportedItems.length) {
          void supportedItems.reduce(
            (promise, { item, file }) => promise.then(() => attachImageFile(
              file, textarea, state, shelf, textareas, errorNode, cursor,
              item.type,
            )),
            Promise.resolve(),
          );
          return;
        }
        void supportedClipboardImageFile().then((file) => attachImageFile(
          file, textarea, state, shelf, textareas, errorNode, cursor,
        )).catch((error) => {
          setAttachmentError(errorNode, error && error.message ? error.message : 'The clipboard image could not be read.');
        });
      });
    }
    for (const button of buttons) {
      button.addEventListener('click', () => {
        target = button.closest('.field').querySelector('textarea') || target;
        picker.click();
      });
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          button.click();
        }
      });
    }
    picker.addEventListener('change', () => {
      const files = Array.from(picker.files || []);
      picker.value = '';
      void files.reduce((promise, file) => promise.then(() => attachImageFile(file, target, state, shelf, textareas, errorNode)), Promise.resolve());
    });
    renderAttachmentShelf(state, shelf, textareas, errorNode);
    return { textareas, state };
  }

  function renderEditDetail(task) {
    if (!task || task.canEdit === false) {
      renderDetail(task);
      return;
    }

    const backdrop = document.getElementById('detailBackdrop');
    const modal = document.getElementById('detail');
    modal.textContent = '';
    editingTaskId = task.id;
    backdrop.classList.add('open');
    applyAccent(backdrop, task.state);
    document.getElementById('newTaskBackdrop').classList.remove('open');
    document.getElementById('settingsBackdrop').classList.remove('open');
    modal.setAttribute('aria-label', 'Edit task ' + task.title);

    const head = el('div', 'modal-head');
    const left = el('div', 'modal-head-left');
    left.appendChild(el('div', 'modal-title', 'Edit task'));
    const badges = el('div', 'modal-badges');
    badges.appendChild(el('span', 'modal-id', task.id));
    const typeBadge = el('span', 'badge-task-type ' + task.type, task.typeLabel);
    typeBadge.title = 'Task type: ' + task.typeLabel;
    typeBadge.setAttribute('aria-label', 'Task type: ' + task.typeLabel);
    badges.appendChild(typeBadge);
    badges.appendChild(el('span', 'modal-status', task.stateLabel + ' · ' + task.status));
    left.appendChild(badges);
    head.appendChild(left);

    const close = el('button', 'modal-close', '×');
    close.setAttribute('aria-label', 'Close task editor');
    close.addEventListener('click', closeDetail);
    head.appendChild(close);
    modal.appendChild(head);

    const body = el('div', 'modal-body');
    appendOutcomeGuidance(body, task.outcome);
    const form = el('form', 'task-edit-form');
    form.id = 'taskEditForm';

    const error = el('div', 'edit-error');
    error.id = 'taskEditError';
    error.hidden = true;
    error.setAttribute('role', 'alert');
    error.setAttribute('aria-live', 'assertive');
    form.appendChild(error);

    const titleField = el('label', 'field');
    titleField.appendChild(el('span', 'field-label', 'Title'));
    const titleInput = document.createElement('input');
    titleInput.className = 'field-input';
    titleInput.id = 'taskEditTitle';
    titleInput.type = 'text';
    titleInput.maxLength = 200;
    titleInput.required = true;
    titleInput.value = task.title;
    titleInput.setAttribute('aria-label', 'Task title');
    titleField.appendChild(titleInput);
    form.appendChild(titleField);

    const attachmentButtons = [];
    for (const [label, id, value, description] of [
      ['Request', 'taskEditRequest', task.request, 'Original task request in Markdown'],
      ['Refined', 'taskEditRefined', task.refined, 'Refined problem statement and acceptance criteria in Markdown'],
      ['Scope', 'taskEditScope', task.scope, 'Implementation scope in Markdown'],
    ]) {
      const field = el('label', 'field');
      field.appendChild(el('span', 'field-label', label));
      const textarea = document.createElement('textarea');
      textarea.className = 'field-textarea';
      textarea.id = id;
      textarea.rows = 6;
      textarea.value = value;
      textarea.dataset.attachmentTarget = 'true';
      textarea.setAttribute('aria-label', label + ' — ' + description);
      field.appendChild(textarea);
      const controls = el('div', 'attachment-controls');
      const attach = el('span', 'btn-chip', 'Attach image');
      attach.setAttribute('role', 'button');
      attach.tabIndex = 0;
      attach.setAttribute('aria-label', 'Attach an image to ' + label);
      controls.appendChild(attach);
      controls.appendChild(el('span', 'attachment-hint', 'Paste an image here or choose a file.'));
      field.appendChild(controls);
      attachmentButtons.push(attach);
      form.appendChild(field);
    }

    const attachmentField = el('div', 'field');
    attachmentField.appendChild(el('span', 'field-label', 'Attached images'));
    const attachmentPicker = document.createElement('input');
    attachmentPicker.className = 'attachment-picker';
    attachmentPicker.type = 'file';
    attachmentPicker.accept = 'image/png,image/jpeg,image/gif,image/webp';
    attachmentPicker.multiple = true;
    const attachmentError = el('div', 'attachment-error');
    attachmentError.id = 'taskEditAttachmentError';
    attachmentError.hidden = true;
    attachmentError.setAttribute('role', 'alert');
    attachmentError.setAttribute('aria-live', 'assertive');
    const attachmentShelf = el('div', 'attachment-shelf');
    attachmentShelf.id = 'taskEditAttachments';
    attachmentShelf.setAttribute('aria-label', 'Attached images');
    attachmentField.appendChild(attachmentPicker);
    attachmentField.appendChild(attachmentError);
    attachmentField.appendChild(attachmentShelf);
    form.appendChild(attachmentField);
    const attachmentUi = wireAttachmentForm(
      form,
      createAttachmentState(task.attachments),
      attachmentPicker,
      attachmentShelf,
      attachmentError,
      attachmentButtons,
    );

    const actions = el('div', 'task-edit-actions');
    const cancel = el('button', 'btn-chip', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => renderDetail(task));
    actions.appendChild(cancel);
    const save = el('button', 'btn-modal-primary', 'Save changes');
    save.type = 'submit';
    save.setAttribute('aria-label', 'Save task changes');
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const title = titleInput.value.trim();
      if (!title) {
        error.textContent = 'Task title cannot be blank.';
        error.hidden = false;
        titleInput.focus();
        return;
      }
      if (title.length > 200) {
        error.textContent = 'Task title must be 200 characters or fewer.';
        error.hidden = false;
        titleInput.focus();
        return;
      }
      error.textContent = '';
      error.hidden = true;
      const content = {
        title,
        request: document.getElementById('taskEditRequest').value,
        refined: document.getElementById('taskEditRefined').value,
        scope: document.getElementById('taskEditScope').value,
      };
      const allText = content.request + '\\n' + content.refined + '\\n' + content.scope;
      const attachmentChanges = {
        add: attachmentUi.state.add.filter((attachment) => imageMarkerPresent(allText, attachment.id)),
        remove: attachmentUi.state.remove,
      };
      vscode.postMessage({
        type: 'task/edit',
        taskId: task.id,
        content,
        ...(attachmentChanges.add.length || attachmentChanges.remove.length ? { attachments: attachmentChanges } : {}),
      });
    });
    body.appendChild(form);

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
    appendDetailActions(links, task);
    body.appendChild(links);

    if (task.lastLog) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', 'Latest log'));
      section.appendChild(el('div', 'modal-section-body plain', task.lastLog));
      body.appendChild(section);
    }

    modal.appendChild(body);
    titleInput.focus();
    titleInput.select();
  }

  document.getElementById('detailBackdrop').addEventListener('click', (e) => {
    if (e.target !== e.currentTarget) { return; }
    if (taskTreeOpen) { closeTaskTree(true); }
    else { closeDetail(); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('detailBackdrop').classList.contains('open')) {
      if (taskTreeOpen) { closeTaskTree(true); }
      else { closeDetail(); }
    }
  });

  let lastSelectedId;
  let lastBoardSnapshot;
  let lastSettings;
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) { return; }
    if (msg.type === 'board/state') {
      const nextTaskSetId = msg.snapshot && typeof msg.snapshot.activeTaskSetId === 'string'
        ? msg.snapshot.activeTaskSetId : '';
      if (renderedBoardTaskSetId && nextTaskSetId !== renderedBoardTaskSetId) {
        lastWorkspaceActivity = { activeTaskSetId: nextTaskSetId, activeTaskSetName: '', records: [] };
        const nextTaskSetName = msg.snapshot && typeof msg.snapshot.activeTaskSetName === 'string'
          ? msg.snapshot.activeTaskSetName : 'Active task set';
        const activitySetName = document.getElementById('workspaceActivitySetName');
        if (activitySetName) { activitySetName.textContent = nextTaskSetName; }
        if (document.getElementById('workspaceActivityBackdrop').classList.contains('open')) {
          renderWorkspaceActivityLoading();
        }
      }
      lastBoardSnapshot = msg.snapshot;
      lastSelectedId = msg.selectedTaskId;
      renderTaskSets(msg.snapshot);
      renderBoard(msg.snapshot, lastSelectedId);
    } else if (msg.type === 'task/reorderResult') {
      pendingFocusTaskId = msg.taskId;
      if (msg.result === 'applied' || msg.result === 'no-op') {
        const position = typeof msg.index === 'number' && msg.index >= 0 ? msg.index + 1 : undefined;
        const count = typeof msg.count === 'number' ? msg.count : undefined;
        announceReorder(
          msg.result === 'no-op'
            ? (position && count ? msg.taskId + ' is already at position ' + position + ' of ' + count + '.' : 'Task order is unchanged.')
            : (position && count ? msg.taskId + ' moved to position ' + position + ' of ' + count + '.' : 'Task order updated.'),
        );
        focusPendingCard();
      } else {
        announceReorder('Task order was not changed because the drop target is no longer valid.');
        pendingFocusTaskId = null;
      }
    } else if (msg.type === 'task/detail') {
      renderDetail(msg.task, msg.preserveOpenModal === true);
    } else if (msg.type === 'workspaceActivity/state') {
      renderWorkspaceActivityState(msg);
    } else if (msg.type === 'task/editError') {
      const error = document.getElementById('taskEditError');
      if (error && (!msg.taskId || msg.taskId === editingTaskId)) {
        error.textContent = msg.error || 'Could not save task changes.';
        error.hidden = false;
        error.focus();
      }
    } else if (msg.type === 'task/createSuccess') {
      newTaskPending = false;
      newTaskSubmit.disabled = false;
      closeNewTaskModal();
    } else if (msg.type === 'task/createError') {
      newTaskPending = false;
      newTaskSubmit.disabled = false;
      newTaskError.textContent = msg.error || 'Could not create the task.';
      newTaskError.hidden = false;
      newTaskError.focus();
    } else if (msg.type === 'settings/state') {
      lastSettings = msg;
      renderSettings(lastSettings);
    } else if (msg.type === 'settings/error') {
      if (typeof msg.key === 'string') {
        const row = document.querySelector('[data-setting-key="' + msg.key + '"]');
        if (row) {
          settingErrorFor(row, msg.error || 'The setting could not be saved.');
        }
      }
    } else if (msg.type === 'newTask/open') {
      openNewTaskModal();
    }
  });

  const newTaskBackdrop = document.getElementById('newTaskBackdrop');
  const newTaskInput = document.getElementById('newTaskInput');
  const newTaskDescription = document.getElementById('newTaskDescription');
  const newTaskType = document.getElementById('newTaskType');
  const newTaskParent = document.getElementById('newTaskParent');
  const newTaskAttach = document.getElementById('newTaskAttach');
  const newTaskPicker = document.getElementById('newTaskPicker');
  const newTaskError = document.getElementById('newTaskAttachmentError');
  const newTaskShelf = document.getElementById('newTaskAttachments');
  const newTaskSubmit = document.getElementById('newTaskSubmit');
  let newTaskPending = false;
  newTaskDescription.dataset.attachmentTarget = 'true';
  const newTaskAttachmentUi = wireAttachmentForm(
    document.getElementById('newTaskForm'),
    createAttachmentState([]),
    newTaskPicker,
    newTaskShelf,
    newTaskError,
    [newTaskAttach],
  );

  function openNewTaskModal() {
    closeTaskTree(false);
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    settingsBackdrop.classList.remove('open'); // and with Settings
    newTaskBackdrop.classList.add('open');
    renderParentTasks(lastBoardSnapshot, false);
    newTaskInput.value = '';
    newTaskDescription.value = '';
    newTaskType.value = 'feature';
    newTaskParent.value = '';
    newTaskPending = false;
    newTaskSubmit.disabled = false;
    setAttachmentError(newTaskError, '');
    newTaskAttachmentUi.state.add = [];
    newTaskAttachmentUi.state.remove = [];
    renderAttachmentShelf(newTaskAttachmentUi.state, newTaskShelf, newTaskAttachmentUi.textareas, newTaskError);
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
    if (!title) {
      newTaskInput.focus();
      return;
    }
    if (newTaskPending) { return; }
    const taskType = newTaskType.value;
    if (taskType !== 'feature' && taskType !== 'bug') { return; }
    newTaskPending = true;
    newTaskSubmit.disabled = true;
    const description = newTaskDescription.value.trim();
    const parentTaskId = newTaskParent.value;
    const additions = newTaskAttachmentUi.state.add.filter((attachment) => imageMarkerPresent(description, attachment.id));
    vscode.postMessage({
      type: 'task/create',
      title,
      description,
      taskType,
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(additions.length ? { attachments: { add: additions } } : {}),
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && newTaskBackdrop.classList.contains('open')) { closeNewTaskModal(); }
  });

  renderBoardFilterOptions();
  document.getElementById('taskSetSelect').addEventListener('change', (e) => {
    if (e.target.value !== renderedBoardTaskSetId) {
      resetBoardFilters();
      if (lastBoardSnapshot) { renderBoard(lastBoardSnapshot, lastSelectedId); }
    }
    vscode.postMessage({ type: 'taskSet/select', taskSetId: e.target.value });
  });
  document.getElementById('boardFind').addEventListener('input', (e) => {
    refreshBoardFromFilters();
  });
  document.getElementById('boardTypeFilter').addEventListener('change', refreshBoardFromFilters);
  document.getElementById('boardStatusFilter').addEventListener('change', refreshBoardFromFilters);
  document.getElementById('boardRelationshipFilter').addEventListener('change', refreshBoardFromFilters);
  document.getElementById('boardFilterClear').addEventListener('click', () => {
    resetBoardFilters();
    if (lastBoardSnapshot) { renderBoard(lastBoardSnapshot, lastSelectedId); }
    document.getElementById('boardFind').focus();
  });
  document.getElementById('taskSetCreate').addEventListener('click', () => {
    vscode.postMessage({ type: 'taskSet/create' });
  });
  document.getElementById('taskSetRename').addEventListener('click', () => {
    vscode.postMessage({ type: 'taskSet/rename' });
  });
  document.getElementById('taskSetDelete').addEventListener('click', () => {
    vscode.postMessage({ type: 'taskSet/delete' });
  });

  const settingsBackdrop = document.getElementById('settingsBackdrop');
  const settingsModal = document.getElementById('settingsModal');
  const agentSettingsSave = document.getElementById('agentSettingsSave');
  agentSettingsSave.addEventListener('click', () => {
    const values = Object.fromEntries(COLUMN_SETTINGS.map((column) => {
      const select = document.getElementById('agent-select-' + column.id);
      return [column.id, select ? select.value : ''];
    }));
    settingErrorFor(document.getElementById('settingsPanelAgents'), '');
    vscode.postMessage({ type: 'agents/save', values });
  });
  document.querySelectorAll('.settings-category').forEach((button) => {
    button.addEventListener('click', () => selectSettingsCategory(button.dataset.category));
    button.addEventListener('keydown', (event) => {
      const current = SETTINGS_CATEGORIES.indexOf(button.dataset.category);
      if (current < 0) { return; }
      let next = current;
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { next = (current + 1) % SETTINGS_CATEGORIES.length; }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { next = (current - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length; }
      if (event.key === 'Home') { next = 0; }
      if (event.key === 'End') { next = SETTINGS_CATEGORIES.length - 1; }
      if (next === current) { return; }
      event.preventDefault();
      selectSettingsCategory(SETTINGS_CATEGORIES[next]);
    });
  });
  function closeSettingsModal() {
    settingsBackdrop.classList.remove('open');
  }
  function openSettingsModal(focusColumn) {
    closeTaskTree(false);
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    newTaskBackdrop.classList.remove('open'); // and with New Task
    selectSettingsCategory(focusColumn ? 'agents' : DEFAULT_SETTINGS_CATEGORY, false);
    settingsBackdrop.classList.add('open');
    renderSettings(lastSettings || { gates: {}, agents: {}, availableAgents: [], selectableAgents: [], values: {} });
    vscode.postMessage({ type: 'settings/refresh' });
    if (focusColumn) {
      const select = document.getElementById('agent-select-' + focusColumn);
      if (select) {
        select.focus();
        return;
      }
    }
    settingsModal.focus();
  }
  document.getElementById('settingsToggle').addEventListener('click', () => openSettingsModal());
  document.getElementById('settingsClose').addEventListener('click', closeSettingsModal);
  settingsBackdrop.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeSettingsModal(); }
  });
  window.addEventListener('keydown', (e) => {
    if (!settingsBackdrop.classList.contains('open')) { return; }
    if (e.key === 'Escape') {
      closeSettingsModal();
      return;
    }
    if (e.key !== 'Tab') { return; }
    const activePanel = settingsModal.querySelector('.settings-panel:not([hidden])');
    const focusable = Array.from(settingsModal.querySelectorAll('button, input, select')).filter((node) => {
      if (node.disabled || node.tabIndex < 0) { return false; }
      const panel = node.closest('.settings-panel');
      return !panel || panel === activePanel;
    });
    if (!focusable.length) { return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!focusable.includes(document.activeElement) || (e.shiftKey && document.activeElement === first)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  const workspaceActivityBackdrop = document.getElementById('workspaceActivityBackdrop');
  const workspaceActivityModal = document.getElementById('workspaceActivityModal');
  const workspaceActivityToggle = document.getElementById('workspaceActivityToggle');
  const workspaceActivitySetName = document.getElementById('workspaceActivitySetName');
  function closeWorkspaceActivityModal() {
    workspaceActivityBackdrop.classList.remove('open');
    const returnFocus = workspaceActivityReturnFocus || workspaceActivityToggle;
    workspaceActivityReturnFocus = null;
    if (returnFocus && typeof returnFocus.focus === 'function') { returnFocus.focus(); }
  }
  function openWorkspaceActivityModal() {
    closeTaskTree(false);
    document.getElementById('detailBackdrop').classList.remove('open');
    newTaskBackdrop.classList.remove('open');
    settingsBackdrop.classList.remove('open');
    workspaceActivityReturnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement : workspaceActivityToggle;
    workspaceActivityBackdrop.classList.add('open');
    workspaceActivitySetName.textContent = lastBoardSnapshot && typeof lastBoardSnapshot.activeTaskSetName === 'string'
      ? lastBoardSnapshot.activeTaskSetName : 'Loading…';
    renderWorkspaceActivityLoading();
    workspaceActivityModal.focus();
    const taskSetId = lastBoardSnapshot && typeof lastBoardSnapshot.activeTaskSetId === 'string'
      ? lastBoardSnapshot.activeTaskSetId : renderedBoardTaskSetId;
    vscode.postMessage({ type: 'workspaceActivity/refresh', ...(taskSetId ? { taskSetId } : {}) });
  }
  workspaceActivityToggle.addEventListener('click', openWorkspaceActivityModal);
  document.getElementById('workspaceActivityClose').addEventListener('click', closeWorkspaceActivityModal);
  document.getElementById('workspaceActivityRefresh').addEventListener('click', () => {
    renderWorkspaceActivityLoading();
    const taskSetId = lastBoardSnapshot && typeof lastBoardSnapshot.activeTaskSetId === 'string'
      ? lastBoardSnapshot.activeTaskSetId : renderedBoardTaskSetId;
    vscode.postMessage({ type: 'workspaceActivity/refresh', ...(taskSetId ? { taskSetId } : {}) });
  });
  workspaceActivityBackdrop.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) { closeWorkspaceActivityModal(); }
  });
  window.addEventListener('keydown', (e) => {
    if (!workspaceActivityBackdrop.classList.contains('open')) { return; }
    if (e.key === 'Escape') {
      closeWorkspaceActivityModal();
      return;
    }
    if (e.key !== 'Tab') { return; }
    const focusable = Array.from(workspaceActivityModal.querySelectorAll('button'))
      .filter((node) => !node.disabled && node.tabIndex >= 0);
    if (!focusable.length) { return; }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
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
