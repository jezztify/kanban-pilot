import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SKILL_SOURCE_PATH = join(
	repositoryRoot,
	'.claude',
	'skills',
	'kanban-pilot',
	'SKILL.md',
);

const TARGET_PATHS = Object.freeze({
	claude: ['.claude', 'skills', 'kanban-pilot', 'SKILL.md'],
	copilot: ['.copilot', 'skills', 'kanban-pilot', 'SKILL.md'],
});

function formatError(error) {
	return error instanceof Error ? error.message : String(error);
}

export function getDestinationPath(target, homeDirectory = homedir()) {
	if (!Object.prototype.hasOwnProperty.call(TARGET_PATHS, target)) {
		throw new Error(`Unknown skill target "${target}". Expected "claude" or "copilot".`);
	}

	return join(homeDirectory, ...TARGET_PATHS[target]);
}

export async function installSkill(
	target,
	{ homeDirectory = homedir(), sourcePath = SKILL_SOURCE_PATH } = {},
) {
	const destinationPath = getDestinationPath(target, homeDirectory);
	let sourceContents;

	try {
		sourceContents = await readFile(sourcePath);
	} catch (error) {
		throw new Error(
			`Unable to read the Kanban Pilot skill source at ${sourcePath}: ${formatError(error)}`,
			{ cause: error },
		);
	}

	try {
		await mkdir(dirname(destinationPath), { recursive: true });
		await writeFile(destinationPath, sourceContents);
	} catch (error) {
		throw new Error(
			`Unable to install the Kanban Pilot skill at ${destinationPath}: ${formatError(error)}`,
			{ cause: error },
		);
	}

	return { sourcePath, destinationPath };
}

const currentModulePath = fileURLToPath(import.meta.url);
const invokedModulePath = process.argv[1] ? resolve(process.argv[1]) : undefined;

if (invokedModulePath === currentModulePath) {
	try {
		if (process.argv.length !== 3) {
			throw new Error('Usage: node scripts/install-skill.mjs <claude|copilot>');
		}

		const { destinationPath } = await installSkill(process.argv[2]);
		console.log(`Installed the Kanban Pilot skill at ${destinationPath}`);
	} catch (error) {
		console.error(`Kanban Pilot skill installation failed: ${formatError(error)}`);
		process.exitCode = 1;
	}
}
