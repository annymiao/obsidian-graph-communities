import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

test('trusted-local smoke reports only redacted overview diagnostics', async (t) => {
	const vaultPath = await createFixtureVault();
	t.after(() => removeFixtureVault(vaultPath));
	const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
	const smokePath = path.join(process.cwd(), 'scripts', 'smoke-client.mjs');
	const child = spawn(process.execPath, [
		smokePath,
		process.execPath,
		serverPath,
		'OBSIDIAN_VAULT_PATH',
		vaultPath,
		'trusted-local',
	], {
		env: {
			...process.env,
			OBSIDIAN_PERSIST_INDEX: 'false',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stdout = '';
	let stderr = '';
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdout += chunk;
	});
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});

	assert.equal(exitCode, 0, stderr);
	const output = JSON.parse(stdout) as {
		tools: string[];
		overview: Record<string, unknown>;
	};
	assert.ok(output.tools.includes('get_vault_overview'));
	assert.equal(typeof output.overview.indexed_note_count, 'number');
	assert.equal(stdout.includes(vaultPath), false);
	assert.equal(stdout.includes(path.basename(vaultPath)), false);
	assert.equal(stdout.includes('Model Context Protocol connects Codex'), false);
	assert.equal(stdout.includes('Codex 写作系统'), false);
});
