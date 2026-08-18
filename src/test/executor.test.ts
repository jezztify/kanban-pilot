import * as assert from 'assert';
import * as vscode from 'vscode';

import { orderedTaskChatAttachments, resolveToolsInclude, taskChatOpenOptions } from '../chat/executor';

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

suite('task chat open options', () => {
	test('docking opens the task session beside the board as a preview', () => {
		assert.deepStrictEqual(taskChatOpenOptions(true), {
			viewColumn: vscode.ViewColumn.Beside,
			preserveFocus: false,
			preview: true,
		});
	});

	test('disabling docking preserves the existing focused-session open behavior', () => {
		assert.deepStrictEqual(taskChatOpenOptions(false), { preserveFocus: false });
	});
});

suite('task chat attachment ordering', () => {
	test('keeps the Markdown task file first and appends images in reference order', () => {
		const task = vscode.Uri.file('C:/tasks/TASK-9.md');
		const first = vscode.Uri.file('C:/tasks/TASK-9.attachments/first.png');
		const second = vscode.Uri.file('C:/tasks/TASK-9.attachments/second.webp');

		assert.deepStrictEqual(orderedTaskChatAttachments(task, [first, second]), [task, first, second]);
	});

	test('text-only runs retain a single Markdown attachment', () => {
		const task = vscode.Uri.file('C:/tasks/TASK-9.md');
		assert.deepStrictEqual(orderedTaskChatAttachments(task), [task]);
	});
});
