import * as assert from 'assert';
import * as vscode from 'vscode';

import {
	COPILOT_CHAT_EXTENSION_ID,
	CONTENT_BEARING_EVENT_TYPES,
	TRANSCRIPT_EVENT_TYPES,
	carriesContent,
	collectTranscriptProbe,
	inspectCopilotSurface,
	isSupportedTranscript,
	sessionRecordPaths,
} from '../spike/chatTranscriptProbe';

suite('Copilot response streaming spike probe', () => {
	test('both record paths resolve from an extension storage uri by path arithmetic alone', () => {
		const storageUri = vscode.Uri.file('/ws-storage/abc123/jezztify.kanban-pilot');
		const paths = sessionRecordPaths(storageUri, '13ef01a9-0308-4232-8627-35192b98eb13');

		assert.ok(paths.workbenchJournal.path.endsWith(
			'/ws-storage/abc123/chatSessions/13ef01a9-0308-4232-8627-35192b98eb13.jsonl',
		));
		assert.ok(paths.copilotTranscript.path.endsWith(
			`/ws-storage/abc123/${COPILOT_CHAT_EXTENSION_ID}/transcripts/13ef01a9-0308-4232-8627-35192b98eb13.jsonl`,
		));
	});

	test('an unrecognised transcript header is not treated as supported', () => {
		// The gate exists so a future format change degrades to "no feed" rather
		// than to a misparse of an undocumented file.
		assert.strictEqual(isSupportedTranscript({ version: 1, producer: 'copilot-agent' }), true);
		assert.strictEqual(isSupportedTranscript({ version: 2, producer: 'copilot-agent' }), false);
		assert.strictEqual(isSupportedTranscript({ version: 1, producer: 'something-else' }), false);
		assert.strictEqual(isSupportedTranscript({}), false);
	});

	test('the content-bearing event types are the ones a feed must not forward verbatim', () => {
		for (const type of CONTENT_BEARING_EVENT_TYPES) {
			assert.strictEqual(carriesContent(type), true, `${type} carries content`);
			assert.ok(TRANSCRIPT_EVENT_TYPES.includes(type), `${type} is part of the vocabulary`);
		}
		// Turn boundaries are the structural signal an activity feed can use safely.
		assert.strictEqual(carriesContent('assistant.turn_start'), false);
		assert.strictEqual(carriesContent('assistant.turn_end'), false);
		assert.strictEqual(carriesContent('session.start'), false);
	});

	test('the Copilot surface is inspected without activating the extension', () => {
		const before = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID)?.isActive;
		const surface = inspectCopilotSurface();
		const after = vscode.extensions.getExtension(COPILOT_CHAT_EXTENSION_ID)?.isActive;

		assert.strictEqual(before, after, 'the probe must not change activation state');
		assert.strictEqual(surface.exposesConversation, false);
		if (!surface.installed) {
			assert.deepStrictEqual(surface.exportedKeys, []);
		}
	});

	test('probing is safe with no storage location and reads no message content', async () => {
		const probe = await collectTranscriptProbe();

		assert.strictEqual(probe.readMessageContent, false);
		assert.strictEqual(probe.invokedChat, false);
		assert.strictEqual(probe.records, undefined);
		assert.ok(typeof probe.vscodeVersion === 'string' && probe.vscodeVersion.length > 0);
	});

	test('a missing record is reported as absent rather than throwing', async () => {
		const storageUri = vscode.Uri.file('/nonexistent-storage/ws/jezztify.kanban-pilot');
		const probe = await collectTranscriptProbe(storageUri, 'no-such-session');

		assert.ok(probe.records);
		assert.strictEqual(probe.records.workbenchJournal.exists, false);
		assert.strictEqual(probe.records.copilotTranscript.exists, false);
		assert.strictEqual(probe.records.workbenchJournal.size, undefined);
	});
});
