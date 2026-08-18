import * as assert from 'assert';

import {
	COLUMN_AGENT_DEFAULT,
	resolveAgentName,
	resolveAgentNameForColumn,
	stageForColumn,
	STAGE_AGENT_NAME,
} from '../chat/agentNames';

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

	test('column overrides resolve for every board column', () => {
		const overrides = {
			backlog: 'Backlog Bot',
			refine: 'Scope Wizard',
			scoped: 'Scope Reviewer',
			approved: 'Release Captain',
			'in-progress': 'Ship It Steve',
			validation: 'Quality Pilot',
			done: 'Archive Keeper',
		};

		assert.strictEqual(resolveAgentNameForColumn('backlog', overrides), 'Backlog Bot');
		assert.strictEqual(resolveAgentNameForColumn('refine', overrides), 'Scope Wizard');
		assert.strictEqual(resolveAgentNameForColumn('scoped', overrides), 'Scope Reviewer');
		assert.strictEqual(resolveAgentNameForColumn('approved', overrides), 'Release Captain');
		assert.strictEqual(resolveAgentNameForColumn('in-progress', overrides), 'Ship It Steve');
		assert.strictEqual(resolveAgentNameForColumn('validation', overrides), 'Quality Pilot');
		assert.strictEqual(resolveAgentNameForColumn('done', overrides), 'Archive Keeper');
	});

	test('columns without overrides use the documented defaults and None labels', () => {
		assert.strictEqual(resolveAgentNameForColumn('backlog', {}), undefined);
		assert.strictEqual(resolveAgentNameForColumn('refine', {}), COLUMN_AGENT_DEFAULT.refine);
		assert.strictEqual(resolveAgentNameForColumn('scoped', {}), undefined);
		assert.strictEqual(resolveAgentNameForColumn('approved', {}), undefined);
		assert.strictEqual(resolveAgentNameForColumn('in-progress', {}), COLUMN_AGENT_DEFAULT['in-progress']);
		assert.strictEqual(resolveAgentNameForColumn('validation', {}), COLUMN_AGENT_DEFAULT.validation);
		assert.strictEqual(resolveAgentNameForColumn('done', {}), undefined);
	});

	test('stage resolution maps refine and split to Refine, develop to In Progress, and validate to Validation', () => {
		assert.strictEqual(stageForColumn('refine'), 'refine');
		assert.strictEqual(stageForColumn('in-progress'), 'develop');
		assert.strictEqual(stageForColumn('validation'), 'validate');
		assert.strictEqual(stageForColumn('backlog'), undefined);
		assert.strictEqual(resolveAgentName('refine', { refine: 'Scope Wizard' }), 'Scope Wizard');
		assert.strictEqual(resolveAgentName('split', { refine: 'Scope Wizard' }), 'Scope Wizard');
		assert.strictEqual(resolveAgentName('develop', { 'in-progress': 'Ship It Steve' }), 'Ship It Steve');
		assert.strictEqual(resolveAgentName('validate', { validation: 'Quality Pilot' }), 'Quality Pilot');
	});

	test('column overrides take precedence over legacy stage keys', () => {
		assert.strictEqual(
			resolveAgentName('develop', { develop: 'Legacy Coder', 'in-progress': 'Column Coder' }),
			'Column Coder',
		);
		assert.strictEqual(
			resolveAgentName('validate', { validate: 'Legacy QA', validation: 'Column QA' }),
			'Column QA',
		);
	});

	test('legacy stage keys remain a safe fallback', () => {
		assert.strictEqual(resolveAgentName('develop', { develop: 'Legacy Coder' }), 'Legacy Coder');
		assert.strictEqual(resolveAgentName('validate', { validate: 'Legacy QA' }), 'Legacy QA');
		assert.strictEqual(resolveAgentNameForColumn('in-progress', { develop: 'Legacy Coder' }), 'Legacy Coder');
		assert.strictEqual(resolveAgentNameForColumn('validation', { validate: 'Legacy QA' }), 'Legacy QA');
	});

	test('a blank or whitespace-only override is treated as unset', () => {
		assert.strictEqual(resolveAgentName('refine', { refine: '   ' }), 'Bro Refiner');
		assert.strictEqual(resolveAgentNameForColumn('backlog', { backlog: '   ' }), undefined);
		assert.strictEqual(resolveAgentNameForColumn('in-progress', { 'in-progress': '  ' }), 'Bro Coder');
	});

	test('split rides on refine\'s override, not a setting of its own (§6.14)', () => {
		assert.strictEqual(resolveAgentName('split', { refine: 'Scope Wizard' }), 'Scope Wizard');
		assert.strictEqual(resolveAgentName('split', {}), STAGE_AGENT_NAME.refine);
	});

	test('an override for a different stage does not leak across stages', () => {
		assert.strictEqual(resolveAgentName('validate', { refine: 'Scope Wizard', develop: 'Ship It Steve' }), 'Bro QA');
	});
});
