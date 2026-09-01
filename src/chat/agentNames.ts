import type { Column } from '../model/task';
import { Stage } from './receipt';

/**
 * Per-column agent persona (PRD §12 Q10, §13). The single source of truth for
 * both the board's `Agent` column badge (`boardPanel.ts`) and the `@name` line
 * every injected prompt opens with — the badge is a real reflection of what's
 * used, not a decoration that happens to agree with it.
 *
 * These are **not** registered VS Code chat participants. No extension
 * defines a `Bro Refiner`/`Bro Coder`/`Bro QA` participant, so `@Bro Refiner`
 * in a prompt is plain text the model reads as persona framing, not a
 * `contributes.chatParticipants` mention VS Code resolves specially.
 *
 * A name may nonetheless match a **Copilot custom agent** the user has installed.
 * VS Code's chat open action resolves its `mode` option with `findModeByName`,
 * which matches a custom agent by name or id. `ChatExecutor` therefore sends the
 * resolved column agent as that option, so the badge, the prompt persona line, and
 * the agent actually running the turn agree. When the name matches no installed
 * agent, VS Code resolves nothing and the name stays exactly what it always was:
 * persona framing only.
 */
export const STAGE_AGENT_NAME: Record<Stage, string> = {
	refine: 'Bro Refiner',
	develop: 'Bro Coder',
	validate: 'Bro QA',
	// §6.14: split is scoping work, same persona as refine rather than a new one.
	split: 'Bro Refiner',
};

/** The three legacy stage keys a persona name was configurable for. */
export type NameableStage = 'refine' | 'develop' | 'validate';

export const NAMEABLE_STAGES: readonly NameableStage[] = ['refine', 'develop', 'validate'];

/** The seven board columns whose assignments can be stored. */
export const AGENT_NAME_COLUMNS: readonly Column[] = [
	'backlog',
	'refine',
	'scoped',
	'approved',
	'in-progress',
	'validation',
	'done',
];

/** `kanbanPilot.chat.agentNames`'s sparse column-keyed value shape.
 *
 * The legacy `refine`/`develop`/`validate` keys are included deliberately:
 * existing settings remain readable while new board edits use their column
 * keys (`refine`, `in-progress`, and `validation`).
 */
export type AgentNameOverrides = Partial<Record<Column | NameableStage, string>>;

/** Stage-to-column mapping. Split is scoping work and inherits Refine. */
export const COLUMN_FOR_STAGE: Record<Stage, Column> = {
	refine: 'refine',
	develop: 'in-progress',
	validate: 'validation',
	split: 'refine',
};

/** The stage that can run for a column, if the column has a runnable stage. */
export function stageForColumn(column: Column): NameableStage | undefined {
	switch (column) {
		case 'refine':
			return 'refine';
		case 'in-progress':
			return 'develop';
		case 'validation':
			return 'validate';
		default:
			return undefined;
	}
}

/** Documented default assignment for every board column; `undefined` renders as None. */
export const COLUMN_AGENT_DEFAULT: Record<Column, string | undefined> = {
	backlog: undefined,
	refine: 'Bro Refiner',
	scoped: undefined,
	approved: undefined,
	'in-progress': 'Bro Coder',
	validation: 'Bro QA',
	done: undefined,
};

function trimmedOverride(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * Resolves the effective persona for a stage: the board's own override if
 * set (§12 Q10's per-column configurability), else the built-in default.
 * `split` reuses `refine`'s override, mirroring `STAGE_AGENT_NAME` above.
 */
export function resolveAgentName(stage: Stage, overrides: AgentNameOverrides): string {
	const columnOverride = trimmedOverride(overrides?.[COLUMN_FOR_STAGE[stage]]);
	if (columnOverride) {
		return columnOverride;
	}

	// Before assignments became column-keyed, develop and validate were stored
	// under their stage names. Keep that fallback (and split's refine fallback)
	// after the new column key so a board edit has clear precedence.
	const legacyKey: NameableStage = stage === 'split' ? 'refine' : stage;
	return trimmedOverride(overrides?.[legacyKey]) || STAGE_AGENT_NAME[stage];
}

/** Resolves the effective label shown for one column, including resting columns. */
export function resolveAgentNameForColumn(column: Column, overrides: AgentNameOverrides): string | undefined {
	const columnOverride = trimmedOverride(overrides?.[column]);
	if (columnOverride) {
		return columnOverride;
	}

	const stage = stageForColumn(column);
	return stage ? resolveAgentName(stage, overrides) : COLUMN_AGENT_DEFAULT[column];
}