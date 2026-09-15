import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compileConfiguredSources } from '../src/offlineCompile.js';

test('package defaults use v1.3 compiled services and retain explicit legacy entries', async () => {
	const manifest = JSON.parse(
		await readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
	) as {
		bin: Record<string, string>;
		scripts: Record<string, string>;
	};
	assert.equal(manifest.bin['obsidian-knowledge-mcp'], 'dist/src/secondBrainMcp.js');
	assert.equal(manifest.bin['obsidian-knowledge-gateway'], 'dist/src/secondBrainHttp.js');
	assert.equal(manifest.scripts.start, 'node dist/src/secondBrainMcp.js');
	assert.equal(manifest.scripts['start:http'], 'node dist/src/secondBrainHttp.js');
	assert.equal(manifest.bin['obsidian-knowledge-mcp-legacy'], 'dist/src/index.js');
	assert.equal(manifest.bin['obsidian-knowledge-gateway-legacy'], 'dist/src/http.js');
	assert.equal(manifest.scripts['start:legacy'], 'node dist/src/index.js');
	assert.equal(manifest.scripts['start:legacy:http'], 'node dist/src/http.js');
});

test('compiled smoke calls redacted status and emits no source path or note body', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-smoke-synthetic-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourcePath = path.join(root, 'synthetic-source');
	const artifactPath = path.join(root, 'private-artifacts');
	const marker = 'synthetic-body-must-never-enter-smoke-output';
	await mkdir(sourcePath, { recursive: true });
	await writeFile(path.join(sourcePath, 'safe.md'), [
		'---',
		'type: knowledge-card',
		'status: active',
		'retrieval_scope: default',
		'---',
		'# Synthetic note',
		marker,
	].join('\n'), 'utf8');
	const summary = await compileConfiguredSources({
		OBSIDIAN_VAULT_PATH: sourcePath,
		OBSIDIAN_ARTIFACT_PATH: artifactPath,
		OBSIDIAN_PERSIST_INDEX: 'true',
		OBSIDIAN_EMBEDDING_PROVIDER: 'deterministic',
		OBSIDIAN_EMBEDDING_DIMENSION: '64',
		OBSIDIAN_RERANKER_PROVIDER: 'none',
		OBSIDIAN_TRANSMISSION_REVIEW: 'required',
	});
	const sourceId = summary.sources[0]?.sourceId;
	assert.ok(sourceId);
	const runtimeEnvironmentPath = path.join(root, 'runtime-environment.json');
	await writeFile(runtimeEnvironmentPath, JSON.stringify({
		OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: path.join(
			artifactPath,
			'second-brain-v1',
			'runtime-catalog.json',
		),
		OBSIDIAN_EMBEDDING_PROVIDER: 'deterministic',
		OBSIDIAN_EMBEDDING_DIMENSION: '64',
		OBSIDIAN_RERANKER_PROVIDER: 'none',
		OBSIDIAN_PRINCIPAL_ID: 'synthetic-smoke',
		OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS: sourceId,
		OBSIDIAN_PRINCIPAL_ALLOWED_MODES: 'default',
		OBSIDIAN_TRANSMISSION_REVIEW: 'required',
	}), { mode: 0o600 });
	await chmod(runtimeEnvironmentPath, 0o600);

	const serverPath = fileURLToPath(new URL('../src/secondBrainMcp.js', import.meta.url));
	const smokePath = path.join(process.cwd(), 'scripts', 'smoke-client.mjs');
	const child = spawn(process.execPath, [
		smokePath,
		process.execPath,
		serverPath,
		runtimeEnvironmentPath,
	], {
		env: process.env,
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
		ready: boolean;
		source_count: number;
		active_documents: number;
		records: number;
		vector: Record<string, unknown>;
	};
	assert.equal(output.ready, true);
	assert.equal(output.source_count, 1);
	assert.equal(Number.isSafeInteger(output.active_documents), true);
	assert.equal(Number.isSafeInteger(output.records), true);
	assert.deepEqual(Object.keys(output).sort(), [
		'active_documents',
		'ready',
		'records',
		'revision',
		'source_count',
		'vector',
	]);
	assert.equal(stdout.includes(root), false);
	assert.equal(stdout.includes(path.basename(sourcePath)), false);
	assert.equal(stdout.includes(marker), false);
	assert.equal(stdout.includes('safe.md'), false);
});

test('smoke rejects an unknown MCP write opt-in before starting a server', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-smoke-policy-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const catalogPath = path.join(root, 'runtime-catalog.json');
	const environmentPath = path.join(root, 'runtime-environment.json');
	await writeFile(catalogPath, '{}\n', { mode: 0o600 });
	await writeFile(environmentPath, JSON.stringify({
		OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: catalogPath,
		OBSIDIAN_EMBEDDING_PROVIDER: 'deterministic',
		OBSIDIAN_EMBEDDING_DIMENSION: '64',
		OBSIDIAN_RERANKER_PROVIDER: 'none',
		OBSIDIAN_PRINCIPAL_ID: 'synthetic-smoke',
		OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS: 'src_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		OBSIDIAN_PRINCIPAL_ALLOWED_MODES: 'default',
		OBSIDIAN_TRANSMISSION_REVIEW: 'required',
		OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL: 'model-approved',
	}), { mode: 0o600 });
	await Promise.all([chmod(catalogPath, 0o600), chmod(environmentPath, 0o600)]);

	const smokePath = path.join(process.cwd(), 'scripts', 'smoke-client.mjs');
	const serverPath = fileURLToPath(new URL('../src/secondBrainMcp.js', import.meta.url));
	const child = spawn(process.execPath, [
		smokePath,
		process.execPath,
		serverPath,
		environmentPath,
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	assert.notEqual(exitCode, 0);
	assert.match(stderr, /only accepts trusted-mcp-app/u);
});
