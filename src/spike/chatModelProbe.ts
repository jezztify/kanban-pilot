import * as vscode from 'vscode';

/**
 * Read-only evidence gathering for TASK-001 (docs/research/copilot-model-selection-spike.md).
 *
 * `vscode.lm.selectChatModels` only enumerates. The consent dialog documented on
 * `LanguageModelChat.sendRequest` is triggered by *sending* a request, not by
 * selecting one, so this probe cannot prompt the user, consume quota, or start a
 * turn. Nothing here opens a chat or executes a chat command, and the module is
 * deliberately not referenced from `extension.ts`.
 */

/** The selector fields `workbench.action.chat.open` validates on `modelSelector`. */
export const COMMAND_SELECTOR_FIELDS = ['name', 'id', 'vendor', 'version', 'family', 'tokens', 'extension'] as const;

/** The subset `kanbanPilot.chat.modelSelector` currently accepts (boardPanel.ts). */
export const BOARD_SELECTOR_FIELDS = ['id', 'vendor'] as const;

/** One enumerated model, reduced to the identifying metadata a selector can match. */
export interface ProbedChatModel {
	id: string;
	vendor: string;
	family: string;
	version: string;
	name: string;
	maxInputTokens: number;
}

export interface ChatModelProbeResult {
	vscodeVersion: string;
	/** Empty when no chat provider is installed or signed in — a valid outcome, not a failure. */
	models: readonly ProbedChatModel[];
	vendors: readonly string[];
	/** True when enumeration threw; the probe still resolves so a test host without Copilot passes. */
	enumerationFailed: boolean;
	invokedChat: false;
}

/**
 * Enumerates the chat models visible to this extension. Never throws: an
 * extension host with no chat provider installed is an expected environment.
 */
export async function collectChatModelProbe(): Promise<ChatModelProbeResult> {
	let models: ProbedChatModel[] = [];
	let enumerationFailed = false;

	try {
		const selected = await vscode.lm.selectChatModels();
		models = selected.map((model) => ({
			id: model.id,
			vendor: model.vendor,
			family: model.family,
			version: model.version,
			name: model.name,
			maxInputTokens: model.maxInputTokens,
		}));
	} catch {
		enumerationFailed = true;
	}

	return {
		vscodeVersion: vscode.version,
		models,
		vendors: [...new Set(models.map((model) => model.vendor))].sort(),
		enumerationFailed,
		invokedChat: false,
	};
}

/**
 * The selector the chat open action would resolve to a *single* model, given the
 * models on hand. The action calls `selectLanguageModels(selector)`, sorts, and
 * takes the first result, so a selector matching more than one model resolves
 * arbitrarily; this reports that ambiguity rather than hiding it.
 */
export function selectorAmbiguity(
	models: readonly ProbedChatModel[],
	selector: { id?: string; vendor?: string; family?: string },
): { matches: number; ambiguous: boolean; wouldThrow: boolean } {
	const matches = models.filter(
		(model) =>
			(selector.id === undefined || model.id === selector.id) &&
			(selector.vendor === undefined || model.vendor === selector.vendor) &&
			(selector.family === undefined || model.family === selector.family),
	).length;

	// `No language models found matching selector` is thrown by the action itself
	// when nothing matches, which fails the whole open-and-inject call.
	return { matches, ambiguous: matches > 1, wouldThrow: matches === 0 };
}

/** Selector fields the command accepts that the board's setting currently rejects. */
export function boardSelectorGap(): readonly string[] {
	const board = new Set<string>(BOARD_SELECTOR_FIELDS);
	return COMMAND_SELECTOR_FIELDS.filter((field) => !board.has(field));
}
