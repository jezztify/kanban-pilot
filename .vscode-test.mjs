import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'dist-test/test/**/*.test.js',
	// M0 probes open editors and poll for focus; the 2s mocha default is far too tight.
	mocha: { timeout: 60_000 },
});
