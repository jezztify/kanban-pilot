import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
	getDestinationPath,
	installSkill,
	SKILL_SOURCE_PATH,
} from './install-skill.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function pathExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function withFixture(callback) {
	const root = await mkdtemp(join(tmpdir(), 'kanban-pilot-install-skill-'));
	const sourcePath = join(root, 'repository', '.claude', 'skills', 'kanban-pilot', 'SKILL.md');
	const homeDirectory = join(root, 'home');

	try {
		await mkdir(dirname(sourcePath), { recursive: true });
		await callback({ homeDirectory, root, sourcePath });
	} finally {
		await rm(root, { force: true, recursive: true });
	}
}

test('package scripts expose both installers and one focused test command', async () => {
	const packageJson = JSON.parse(
		await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
	);

	assert.equal(packageJson.scripts['install:skill:claude'], 'node scripts/install-skill.mjs claude');
	assert.equal(packageJson.scripts['install:skill:copilot'], 'node scripts/install-skill.mjs copilot');
	assert.equal(
		packageJson.scripts['test:install-skill'],
		'node --test scripts/install-skill.test.mjs',
	);
});

test('installs exact source bytes to both target layouts and creates directories', async () => {
	await withFixture(async ({ homeDirectory, sourcePath }) => {
		const sourceContents = Buffer.from([0, 1, 2, 10, 13, 255]);
		await writeFile(sourcePath, sourceContents);

		for (const target of ['claude', 'copilot']) {
			const result = await installSkill(target, { homeDirectory, sourcePath });
			const expectedPath = getDestinationPath(target, homeDirectory);

			assert.equal(result.destinationPath, expectedPath);
			assert.deepEqual(await readFile(expectedPath), sourceContents);
		}
	});
});

test('uses the repository canonical skill source by default', async () => {
	await withFixture(async ({ homeDirectory }) => {
		const result = await installSkill('claude', { homeDirectory });

		assert.equal(result.sourcePath, SKILL_SOURCE_PATH);
		assert.deepEqual(
			await readFile(result.destinationPath),
			await readFile(SKILL_SOURCE_PATH),
		);
	});
});

test('overwrites an existing destination and is repeatable', async () => {
	await withFixture(async ({ homeDirectory, sourcePath }) => {
		const originalContents = Buffer.from('original\n');
		const updatedContents = Buffer.from('updated\n');
		const destinationPath = getDestinationPath('copilot', homeDirectory);
		await writeFile(sourcePath, originalContents);

		await installSkill('copilot', { homeDirectory, sourcePath });
		await writeFile(destinationPath, 'stale destination\n');
		await installSkill('copilot', { homeDirectory, sourcePath });
		assert.deepEqual(await readFile(destinationPath), originalContents);

		await writeFile(sourcePath, updatedContents);
		await installSkill('copilot', { homeDirectory, sourcePath });
		assert.deepEqual(await readFile(destinationPath), updatedContents);
	});
});

test('rejects invalid targets without creating a destination', async () => {
	await withFixture(async ({ homeDirectory }) => {
		await assert.rejects(
			installSkill('other', { homeDirectory }),
			/Unknown skill target "other"/,
		);
		assert.equal(await pathExists(homeDirectory), false);
	});
});

test('reports a missing source and does not create destination directories', async () => {
	await withFixture(async ({ homeDirectory, root }) => {
		const missingSourcePath = join(root, 'missing', 'SKILL.md');

		await assert.rejects(
			installSkill('claude', { homeDirectory, sourcePath: missingSourcePath }),
			/Unable to read the Kanban Pilot skill source/,
		);
		assert.equal(await pathExists(homeDirectory), false);
	});
});

test('reports destination filesystem failures clearly', async () => {
	await withFixture(async ({ root, sourcePath }) => {
		const blockedHomeDirectory = join(root, 'blocked-home');
		await writeFile(sourcePath, 'skill contents\n');
		await writeFile(blockedHomeDirectory, 'this path is a file\n');

		await assert.rejects(
			installSkill('claude', {
				homeDirectory: blockedHomeDirectory,
				sourcePath,
			}),
			/Unable to install the Kanban Pilot skill at/,
		);
	});
});
