import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
	'dist',
	'tests',
);
const tests = (await readdir(testsDirectory, { withFileTypes: true }))
	.filter((entry) => entry.isFile())
	.filter((entry) => entry.name.endsWith('.test.js'))
	.filter((entry) => !entry.name.startsWith('._'))
	.map((entry) => path.join(testsDirectory, entry.name))
	.sort((first, second) => first.localeCompare(second));

if (tests.length === 0) {
	throw new Error('No compiled MCP tests found. Run the build first.');
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
	cwd: path.resolve(testsDirectory, '..', '..'),
	stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
