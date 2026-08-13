import * as assert from 'assert';

import { resolveAgentName, STAGE_AGENT_NAME } from '../chat/agentNames';

/** M5.5 — per-column agent name overrides (PRD §12 Q10, §6.17). */

suite('resolveAgentName', () => {
	test('falls back to the built-in default when no override is set', () => {
		assert.strictEqual(resolveAgentName('refine', {}), 'Bro Refiner');
		assert.strictEqual(resolveAgentName('develop', {}), 'Bro Coder');
		assert.strictEqual(resolveAgentName('validate', {}), 'Bro QA');
	});

	test('an override wins over the default', () => {
		assert.strictEqual(resolveAgentName('develop', { develop: 'Ship It Steve' }), 'Ship It Steve');
	});

	test('a blank or whitespace-only override is treated as unset', () => {
		assert.strictEqual(resolveAgentName('refine', { refine: '   ' }), 'Bro Refiner');
	});

	test('split rides on refine\'s override, not a setting of its own (§6.14)', () => {
		assert.strictEqual(resolveAgentName('split', { refine: 'Scope Wizard' }), 'Scope Wizard');
		assert.strictEqual(resolveAgentName('split', {}), STAGE_AGENT_NAME.refine);
	});

	test('an override for a different stage does not leak across stages', () => {
		assert.strictEqual(resolveAgentName('validate', { refine: 'Scope Wizard', develop: 'Ship It Steve' }), 'Bro QA');
	});
});
