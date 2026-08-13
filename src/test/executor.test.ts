import * as assert from 'assert';

import { resolveToolsInclude } from '../chat/executor';

/** M3 — refine's tools allowlist is opt-in, not on by default (PRD §6.6, §6.8). */

suite('resolveToolsInclude', () => {
	test('an empty allowlist means no restriction, even for refine', () => {
		assert.strictEqual(resolveToolsInclude('refine', []), undefined);
	});

	test('a non-empty allowlist is passed through as-is for refine', () => {
		assert.deepStrictEqual(resolveToolsInclude('refine', ['codebase']), ['codebase']);
	});

	test('develop, validate, and split are never restricted, regardless of the refine allowlist', () => {
		assert.strictEqual(resolveToolsInclude('develop', ['codebase']), undefined);
		assert.strictEqual(resolveToolsInclude('validate', ['codebase']), undefined);
		assert.strictEqual(resolveToolsInclude('split', ['codebase']), undefined);
	});
});
