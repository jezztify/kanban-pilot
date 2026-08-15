import * as vscode from 'vscode';
import { CLAUDE_COMMANDS, CLAUDE_EXTENSION_ID } from './claudeChatProbe';

export interface ClaudeChatHostProbeResult {
	vscodeVersion: string;
	extensionInstalled: boolean;
	extensionVersion?: string;
	registeredClaudeCommands: readonly string[];
	expectedCommandsPresent: readonly string[];
	invokedClaude: false;
}

/**
 * Extension-host-only inventory probe. It deliberately activates nothing and
 * executes no Claude command, so it cannot consume credentials or start a run.
 */
export async function collectClaudeChatHostProbe(): Promise<ClaudeChatHostProbeResult> {
	const extension = vscode.extensions.getExtension(CLAUDE_EXTENSION_ID);
	const commands = await vscode.commands.getCommands(true);
	const registeredClaudeCommands = commands.filter(
		(command) => command.startsWith('claude-vscode.') || command.startsWith('claude-code.'),
	);

	return {
		vscodeVersion: vscode.version,
		extensionInstalled: !!extension,
		extensionVersion: extension?.packageJSON?.version as string | undefined,
		registeredClaudeCommands,
		expectedCommandsPresent: CLAUDE_COMMANDS.filter((command) => commands.includes(command)),
		invokedClaude: false,
	};
}