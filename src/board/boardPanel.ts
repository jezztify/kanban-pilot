import * as vscode from 'vscode';
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
import {
  COLUMNS,
  COLUMN_LABELS,
  Column,
  isTaskType,
  Status,
  Task,
  TaskAttachmentChanges,
  TASK_TYPE_LABELS,
  normalizeEditableTaskContent,
} from '../model/task';
import { gateForId, GATE_CATALOG } from '../model/gates';
import { TaskSet } from '../model/taskSets';
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
export interface BoardTaskSetHost {
  readonly ready: Promise<void>;
  readonly store: TaskStore;
  readonly runManager: RunManager;
  readonly activeSet: TaskSet;
  listTaskSets(): Promise<TaskSet[]>;
  switchTaskSet(id: string): Promise<void>;
  createTaskSet(name: string): Promise<void>;
  renameTaskSet(name: string): Promise<void>;
  deleteTaskSet(): Promise<void>;
  onDidChange(listener: () => void): vscode.Disposable;
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
      return { ok: true, value: rawValue };
    case 'array':
      if (!Array.isArray(rawValue) || rawValue.some((value) => typeof value !== 'string')) {
        return { ok: false, error: `${definition.label} must be a list of text values.` };
      }
      if (rawValue.some((value) => /[\r\n]/.test(value) || value.length > 200)) {
        return { ok: false, error: `${definition.label} contains an invalid tool ID.` };
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
): SettingsState {
  return {
    gates: { ...gates },
    agents: Object.fromEntries(
      COLUMNS.map((column) => [column, agentLabelFor(column, agentNames)]),
    ) as Record<Column, string>,
    availableAgents: availableAgents.map((agent) => ({ ...agent })),
    values: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, defaultSettingValue(value)])),
  };
}

export class BoardPanel {
	public static readonly viewType = 'kanbanPilot.board';
	private static current: BoardPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private selectedTaskId: string | undefined;
  private taskWatcher: vscode.Disposable | undefined;
  private webviewReady = false;
  private pendingNewTaskOpen = false;

	private constructor(
		private readonly panel: vscode.WebviewPanel,
    private readonly host: BoardTaskSetHost,
	) {
    this.configureWebview();
		this.panel.webview.html = this.html();
    this.bindTaskWatcher();

		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((message: InMessage) => this.onMessage(message)),
      this.host.onDidChange(() => {
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
			this.panel.onDidDispose(() => this.dispose()),
		);
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
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.store.directory],
    };
  }

  /** Opens the canonical attachment-capable New Task modal from a command. */
  openNewTask(): void {
    this.pendingNewTaskOpen = true;
    if (this.webviewReady) {
      this.pendingNewTaskOpen = false;
      void this.panel.webview.postMessage({ type: 'newTask/open' });
    }
  }

  private bindTaskWatcher(): void {
    this.taskWatcher?.dispose();
    this.taskWatcher = this.store.watch(() => void this.pushAll());
  }

	static show(
    host: BoardTaskSetHost,
		extensionUri: vscode.Uri,
		column = vscode.ViewColumn.One,
	): BoardPanel {
		if (BoardPanel.current) {
			BoardPanel.current.panel.reveal(column);
			void BoardPanel.current.pushAll();
			return BoardPanel.current;
		}

		const panel = vscode.window.createWebviewPanel(BoardPanel.viewType, 'Kanban Pilot', column, {
			enableScripts: true,
			retainContextWhenHidden: true,
		});
		panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'activity-icon.svg');

    BoardPanel.current = new BoardPanel(panel, host);
		return BoardPanel.current;
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
          await this.panel.webview.postMessage({ type: 'newTask/open' });
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

      case 'task/reorder': {
        const target = Object.prototype.hasOwnProperty.call(message, 'beforeTaskId')
          ? { beforeTaskId: message.beforeTaskId }
          : { targetIndex: message.targetIndex };
        const outcome = await this.runManager.reorderTask(message.taskId, message.column, target);
        const snapshot = await this.store.snapshot();
        await this.pushAll();
        const column = snapshot.columns.find((candidate) => candidate.id === message.column);
        const index = column?.tasks.findIndex((task) => task.id === message.taskId) ?? -1;
        await this.panel.webview.postMessage({
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
        if (!title || !isTaskType(message.taskType)) {
					return;
				}
        try {
          const task = await this.store.create(title, {
            type: message.taskType,
            request: message.description?.trim(),
            attachments: message.attachments as TaskAttachmentChanges | undefined,
          });
          this.selectedTaskId = task.id;
          // The watcher fires from this same write, but selection changed
          // independently of disk state, so push explicitly rather than wait.
          await this.pushAll();
          await this.panel.webview.postMessage({ type: 'task/createSuccess', taskId: task.id });
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
        await invokeBoardAction(this.runManager, message.taskId, message.action);
				return;
			}

      case 'pending/apply':
        if (typeof message.taskId === 'string') {
          await this.runManager.applyPendingOutcome(message.taskId);
        }
        return;

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
		await this.panel.webview.postMessage({
			type: 'board/state',
      snapshot: this.toView(snapshot, agentNames, taskSets),
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
    const attachments = await this.store.listAttachments(task.id);

		await this.panel.webview.postMessage({
			type: 'task/detail',
			task: {
				id: task.id,
				title: task.title,
        type: task.type,
        typeLabel: TASK_TYPE_LABELS[task.type],
				state: task.state,
				stateLabel: COLUMN_LABELS[task.state],
				status: task.status,
        canEdit: task.status !== 'running',
				request: task.sections['Request'] ?? '',
				refined: task.sections['Refined'] ?? '',
				scope: task.sections['Scope'] ?? '',
				lastLog: logLines.at(-1) ?? '',
				originTask: task.originTask,
        attachments: attachments.map((attachment) => ({
          name: attachment.name,
          relativePath: attachment.relativePath,
          mimeType: attachment.mimeType,
          size: attachment.size,
          src: this.panel.webview.asWebviewUri(attachment.uri).toString(),
        })),
        pending: pendingView(task),
        moveTargets: COLUMNS.map((id) => ({ id, label: COLUMN_LABELS[id] })),
				// The card face shows one button (primary); this is where the
				// prototype's un-rendered secondary action (§5.2) lives instead.
				secondary: secondaryAction(task.state),
			},
		});
	}

  private async reportEditError(taskId: string | undefined, error: string): Promise<void> {
    void vscode.window.showErrorMessage(error);
    await this.panel.webview.postMessage({ type: 'task/editError', taskId, error });
  }

  private async reportCreateError(error: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'task/createError', error });
  }

  private async reportSettingsError(key: string | undefined, error: string): Promise<void> {
    await this.panel.webview.postMessage({ type: 'settings/error', key, error });
  }

  private async pushSettings(): Promise<void> {
		const cfg = vscode.workspace.getConfiguration('kanbanPilot');
		const gates = Object.fromEntries(GATES.map((g) => [g.key, cfg.get<string>(g.setting, 'manual')]));
    const values = settingsValuesFor(cfg);
    const agentNames = this.configuredAgentNames();
    const availableAgents = await discoverCopilotAgents({
      workspaceFolders: vscode.workspace.workspaceFolders?.map((folder) => folder.uri),
      additionalLocations: vscode.workspace.getConfiguration('chat').get<unknown>('agentFilesLocations', {}),
    });
    await this.panel.webview.postMessage({
      type: 'settings/state',
      ...settingsStateFor(gates, agentNames, availableAgents, values),
    });
	}

  private toView(snapshot: BoardSnapshot, agentNames: AgentNameOverrides, taskSets: TaskSet[]) {
		return {
			malformed: snapshot.malformed,
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
          pending: pendingView(task),
					canSplit: canSplit(task.state, task.status),
				})),
			})),
		};
	}

	dispose(): void {
		BoardPanel.current = undefined;
    this.webviewReady = false;
    this.pendingNewTaskOpen = false;
    this.taskWatcher?.dispose();
    this.taskWatcher = undefined;
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
      `img-src ${this.panel.webview.cspSource} data:`,
		].join('; ');

    const actionLabelsJson = JSON.stringify(ACTION_LABELS);
		const gatesJson = JSON.stringify(GATES);
    const columnsJson = JSON.stringify(SETTINGS_COLUMNS);
		const columnAgentDefaultsJson = JSON.stringify(COLUMN_AGENT_DEFAULT);
    const settingDefinitionsJson = JSON.stringify(SETTING_DEFINITIONS);
		// The detail modal is rendered from a task payload, not a column, so it
		// needs its own state → hue lookup to stay color-consistent with the board.
		const accentsJson = JSON.stringify(COLUMN_ACCENT);

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
    margin: 0 -4px; padding: 0 4px; /* room for the scrollbar without clipping card focus rings */
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

  .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; }
  .card-id-group { display: flex; align-items: center; gap: 6px; min-width: 0; }
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

  .card-title { font-size: 13px; font-weight: 600; line-height: 1.35; }

  .card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .card-foot-actions { display: flex; gap: 6px; }

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
    overflow-y: auto; padding: 18px;
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
    <div class="task-set-controls" aria-label="Task-set management">
      <label class="task-set-label" for="taskSetSelect">Task set</label>
      <select class="task-set-select" id="taskSetSelect" aria-label="Active task set"></select>
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
      <div class="new-task-actions">
        <button type="button" class="btn-chip" id="newTaskCancel">Cancel</button>
        <button type="submit" class="btn-modal-primary" id="newTaskSubmit">Create task</button>
      </div>
    </form>
  </div>
</div>
<div id="warn"></div>
<div id="reorderAnnouncement" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
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
  const COLUMN_SETTINGS = ${columnsJson};
  const COLUMN_AGENT_DEFAULTS = ${columnAgentDefaultsJson};
  const SETTING_DEFINITIONS = ${settingDefinitionsJson};
  const COLUMN_ACCENT = ${accentsJson};
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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) { node.className = className; }
    if (text !== undefined) { node.textContent = text; }
    return node;
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
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function isSafeUrl(href) {
    return /^https?:\\/\\//i.test(href);
  }

  function isTaskAttachmentReference(value) {
    return /^TASK-\\d+\\.attachments\\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
  }

  function isSafeImageSource(src) {
    return typeof src === 'string' && /^vscode-webview-resource:/i.test(src);
  }

  function taskImageAlt(value) {
    const clean = String(value || '').replace(/[\\[\\]\\r\\n]/g, ' ').trim();
    return clean || 'Task image';
  }

  function renderInline(raw, attachments) {
    const codeTokens = [];
    let masked = raw.replace(/\`([^\`]+)\`/g, (_m, code) => {
      codeTokens.push(code);
      return '' + (codeTokens.length - 1) + '';
    });
    const attachmentMap = new Map((attachments || []).map((attachment) => [attachment.relativePath, attachment]));
    const imageTokens = [];
    masked = masked.replace(/!\\[([^\\]\\r\\n]*)\\]\\(([^)\\s]+)\\)/g, (_m, alt, href) => {
      imageTokens.push({ alt: taskImageAlt(alt), href });
      return 'I' + (imageTokens.length - 1) + '';
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
    out = out.replace(/I(\\d+)/g, (_m, i) => {
      const image = imageTokens[Number(i)];
      const attachment = isTaskAttachmentReference(image.href) ? attachmentMap.get(image.href) : undefined;
      if (!attachment || !isSafeImageSource(attachment.src)) {
        return '<span class="task-image-placeholder" role="img" aria-label="Image unavailable: ' + escapeHtml(image.alt) + '">Image unavailable: ' + escapeHtml(image.alt) + '</span>';
      }
      return '<img class="task-image" loading="lazy" src="' + escapeHtml(attachment.src) + '" alt="' + escapeHtml(image.alt) + '">';
    });
    out = out.replace(/(\\d+)/g, (_m, i) => '<code>' + escapeHtml(codeTokens[Number(i)]) + '</code>');
    return out;
  }

  function renderMarkdown(src, attachments) {
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
        out.push('<h' + level + '>' + renderInline(heading[2].trim(), attachments) + '</h' + level + '>');
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
        out.push('<blockquote>' + renderInline(quoteLines.join(' '), attachments) + '</blockquote>');
        continue;
      }

      const checklist = line.match(/^[-*]\\s+\\[([ xX])\\]\\s+(.*)$/);
      if (checklist) {
        if (listType !== 'checklist') { closeList(); out.push('<ul class="modal-md-checklist">'); listType = 'checklist'; }
        const checked = checklist[1].toLowerCase() === 'x';
        out.push(
          '<li><label><input type="checkbox" disabled' + (checked ? ' checked' : '') + '><span>' +
            renderInline(checklist[2], attachments) + '</span></label></li>',
        );
        i++;
        continue;
      }

      const bullet = line.match(/^[-*]\\s+(.*)$/);
      if (bullet) {
        if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
        out.push('<li>' + renderInline(bullet[1], attachments) + '</li>');
        i++;
        continue;
      }

      const numbered = line.match(/^\\d+\\.\\s+(.*)$/);
      if (numbered) {
        if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
        out.push('<li>' + renderInline(numbered[1], attachments) + '</li>');
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
      out.push('<p>' + renderInline(paraLines.join(' '), attachments) + '</p>');
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

  function renderCard(card, selectedId, column) {
    const node = el('div', 'card' + (card.id === selectedId ? ' selected' : ''));
    node.draggable = true;
    node.tabIndex = 0;
    node.dataset.taskId = card.id;
    node.setAttribute('role', 'button');
    node.setAttribute('aria-label', card.id + ': ' + card.title + '. Type: ' + card.typeLabel +
      '.' + (card.pending ? ' Pending completion: ' + card.pending.label + '.' : '') +
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
    if (card.originTask) {
      const badge = el('span', 'badge-proposed', 'Proposed');
      badge.title = 'Filed automatically by ' + card.originTask;
      idGroup.appendChild(badge);
    }
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
    if (card.pending) {
      const pending = el('span', 'status-text pending', 'Pending: ' + card.pending.label);
      pending.title = card.pending.description;
      pending.setAttribute('aria-label', 'Pending completion: ' + card.pending.label);
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
      titleRow.appendChild(el('span', 'count', String(column.count)));
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
      } else {
        for (const card of column.cards) {
          addDropSlot(card.id, 'Insert before ' + card.title);
          cards.appendChild(renderCard(card, selectedId, column));
        }
        addDropSlot(null, 'Insert at the end of ' + column.label);
      }
      node.appendChild(cards);
      board.appendChild(node);
    }
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

  function closeDetail() {
    document.getElementById('detailBackdrop').classList.remove('open');
    document.getElementById('detail').textContent = '';
    editingTaskId = null;
    vscode.postMessage({ type: 'task/deselect' });
  }

  function renderDetail(task) {
    const backdrop = document.getElementById('detailBackdrop');
    const modal = document.getElementById('detail');
    modal.textContent = '';

    if (!task) {
      backdrop.classList.remove('open');
      editingTaskId = null;
      return;
    }
    editingTaskId = null;
    backdrop.classList.add('open');
    // Set on the backdrop, not the modal: the backdrop's radial wash reads the
    // same hue, and .modal inherits it from here.
    applyAccent(backdrop, task.state);
    document.getElementById('newTaskBackdrop').classList.remove('open'); // mutually exclusive with New Task
    document.getElementById('settingsBackdrop').classList.remove('open'); // and with Settings
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
    if (task.pending) {
      const pendingAction = el('button', 'btn-modal-primary', 'Apply ' + task.pending.label);
      pendingAction.type = 'button';
      pendingAction.setAttribute('aria-label', 'Apply pending completion: ' + task.pending.label);
      pendingAction.title = task.pending.description;
      pendingAction.addEventListener('click', () => vscode.postMessage({ type: 'pending/apply', taskId: task.id }));
      links.appendChild(pendingAction);
    }
    if (task.secondary) { links.appendChild(actionButton(task.id, task.secondary)); }
    body.appendChild(links);

    for (const [label, text] of [['Request', task.request], ['Refined', task.refined], ['Scope', task.scope]]) {
      const section = el('div');
      section.appendChild(el('div', 'modal-section-label', label));
      const sectionBody = el('div', 'modal-section-body');
      sectionBody.innerHTML = renderMarkdown(text, task.attachments || []);
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
    let name = original.replace(/[\\/]/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\\.\\.+/g, '.');
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
    if (task.pending) {
      const pendingAction = el('button', 'btn-modal-primary', 'Apply ' + task.pending.label);
      pendingAction.type = 'button';
      pendingAction.setAttribute('aria-label', 'Apply pending completion: ' + task.pending.label);
      pendingAction.title = task.pending.description;
      pendingAction.addEventListener('click', () => vscode.postMessage({ type: 'pending/apply', taskId: task.id }));
      links.appendChild(pendingAction);
    }
    if (task.secondary) { links.appendChild(actionButton(task.id, task.secondary)); }
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
    if (e.target === e.currentTarget) { closeDetail(); }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('detailBackdrop').classList.contains('open')) {
      closeDetail();
    }
  });

  let lastSelectedId;
  let lastSettings;
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg) { return; }
    if (msg.type === 'board/state') {
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
      renderDetail(msg.task);
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
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    settingsBackdrop.classList.remove('open'); // and with Settings
    newTaskBackdrop.classList.add('open');
    newTaskInput.value = '';
    newTaskDescription.value = '';
    newTaskType.value = 'feature';
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
    const additions = newTaskAttachmentUi.state.add.filter((attachment) => imageMarkerPresent(description, attachment.id));
    vscode.postMessage({
      type: 'task/create',
      title,
      description,
      taskType,
      ...(additions.length ? { attachments: { add: additions } } : {}),
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && newTaskBackdrop.classList.contains('open')) { closeNewTaskModal(); }
  });

  document.getElementById('taskSetSelect').addEventListener('change', (e) => {
    vscode.postMessage({ type: 'taskSet/select', taskSetId: e.target.value });
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
    document.getElementById('detailBackdrop').classList.remove('open'); // mutually exclusive with task detail
    newTaskBackdrop.classList.remove('open'); // and with New Task
    selectSettingsCategory(focusColumn ? 'agents' : DEFAULT_SETTINGS_CATEGORY, false);
    settingsBackdrop.classList.add('open');
    renderSettings(lastSettings || { gates: {}, agents: {}, availableAgents: [], values: {} });
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

  vscode.postMessage({ type: 'board/ready' });
</script>
</body>
</html>`;
	}
}

function isTaskAction(value: unknown): value is TaskAction {
	return typeof value === 'string' && (TASK_ACTIONS as readonly string[]).includes(value);
}
