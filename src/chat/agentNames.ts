import { Stage } from './receipt';

/**
 * Per-stage agent persona (PRD §12 Q10, §13). The single source of truth for
 * both the board's cosmetic `Agent` column badge (`boardPanel.ts`) and the
 * `@name` line every injected prompt opens with — the badge is a real
 * reflection of what's used, not a decoration that happens to agree with it.
 *
 * These are **not** registered VS Code chat participants. No extension
 * defines a `Bro Refiner`/`Bro Coder`/`Bro QA` participant, so `@Bro Refiner`
 * in a prompt is plain text the model reads as persona framing, not a
 * `contributes.chatParticipants` mention VS Code resolves specially. If a
 * real per-stage participant is ever wanted, that's a separate, larger
 * feature (a request handler per participant) — this is deliberately the
 * lightweight version.
 */
export const STAGE_AGENT_NAME: Record<Stage, string> = {
	refine: 'Bro Refiner',
	develop: 'Bro Coder',
	validate: 'Bro QA',
	// §6.14: split is scoping work, same persona as refine rather than a new one.
	split: 'Bro Refiner',
};

/** The three stages a persona name is actually configurable for — split rides on refine's. */
export type NameableStage = 'refine' | 'develop' | 'validate';

export const NAMEABLE_STAGES: readonly NameableStage[] = ['refine', 'develop', 'validate'];

/** `kanbanPilot.chat.agentNames`'s value shape — a sparse per-stage override, empty by default. */
export type AgentNameOverrides = Partial<Record<NameableStage, string>>;

/**
 * Resolves the effective persona for a stage: the board's own override if
 * set (§12 Q10's per-column configurability), else the built-in default.
 * `split` reuses `refine`'s override, mirroring `STAGE_AGENT_NAME` above.
 */
export function resolveAgentName(stage: Stage, overrides: AgentNameOverrides): string {
	const key: NameableStage = stage === 'split' ? 'refine' : stage;
	return overrides[key]?.trim() || STAGE_AGENT_NAME[stage];
}
