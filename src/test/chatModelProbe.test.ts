import * as assert from 'assert';

import {
	BOARD_SELECTOR_FIELDS,
	COMMAND_SELECTOR_FIELDS,
	boardSelectorGap,
	collectChatModelProbe,
	selectorAmbiguity,
	type ProbedChatModel,
} from '../spike/chatModelProbe';

const models: ProbedChatModel[] = [
	{ id: 'copilot/gpt-4o', vendor: 'copilot', family: 'gpt-4o', version: '2024-11', name: 'GPT-4o', maxInputTokens: 128000 },
	{ id: 'copilot/gpt-4o-mini', vendor: 'copilot', family: 'gpt-4o-mini', version: '2024-11', name: 'GPT-4o mini', maxInputTokens: 128000 },
	{ id: 'other/local-1', vendor: 'other', family: 'local', version: '1', name: 'Local', maxInputTokens: 8000 },
];

suite('Copilot model selection spike probe', () => {
	test('an id selector resolves to exactly one model', () => {
		const result = selectorAmbiguity(models, { id: 'copilot/gpt-4o' });
		assert.strictEqual(result.matches, 1);
		assert.strictEqual(result.ambiguous, false);
		assert.strictEqual(result.wouldThrow, false);
	});

	test('a vendor-only selector is ambiguous and resolves arbitrarily by sort order', () => {
		const result = selectorAmbiguity(models, { vendor: 'copilot' });
		assert.strictEqual(result.matches, 2);
		assert.strictEqual(result.ambiguous, true);
	});

	test('an unmatched selector is reported as throwing, matching the action behaviour', () => {
		// The chat open action throws `No language models found matching selector`,
		// which fails the whole open-and-inject call rather than falling back.
		const result = selectorAmbiguity(models, { id: 'copilot/retired-model' });
		assert.strictEqual(result.matches, 0);
		assert.strictEqual(result.wouldThrow, true);
	});

	test('the board setting accepts fewer selector fields than the command does', () => {
		const gap = boardSelectorGap();
		assert.ok(gap.includes('family'), 'family is the portable field the board cannot express');
		assert.ok(BOARD_SELECTOR_FIELDS.every((field) => COMMAND_SELECTOR_FIELDS.includes(field)));
	});

	test('enumeration is safe on a host with no chat provider installed', async () => {
		const probe = await collectChatModelProbe();
		assert.strictEqual(probe.invokedChat, false);
		assert.ok(Array.isArray(probe.models));
		assert.ok(typeof probe.vscodeVersion === 'string' && probe.vscodeVersion.length > 0);
	});
});
