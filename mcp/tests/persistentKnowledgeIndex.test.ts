import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadServerConfig } from '../src/config.js';
import { KnowledgeIndex } from '../src/knowledgeIndex.js';
import { ServerConfig } from '../src/types.js';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

function persistentConfig(vaultPath: string, artifactPath: string): ServerConfig {
	return {
		vaultPath,
		vaultName: path.basename(vaultPath),
		sourceIdentity: 'fixture:portable-knowledge-source',
		artifactPath,
		excludedFolders: new Set(['.obsidian', '.git', '.trash', 'node_modules']),
		indexTtlMs: 60_000,
		maxFileCharacters: 500_000,
		maxFiles: 1_000,
		chunkTokens: 700,
		chunkOverlapTokens: 80,
		defaultContextTokens: 4_000,
		maxSourceTokens: 900,
		transmissionReviewMode: 'required',
	};
}

test('publishes, verifies, and reuses a local retrieval generation', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifacts-test-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
	});
	const config = persistentConfig(vaultPath, artifactPath);

	const firstIndex = new KnowledgeIndex(config);
	const firstMatches = await firstIndex.search('Codex personal MCP');
	assert.ok(firstMatches.length > 0);
	const firstMatch = firstMatches[0];
	assert.ok(firstMatch);
	assert.match(firstMatch.sourceId, /^src_v1_/u);
	assert.match(firstMatch.documentId, /^doc_v1_/u);
	assert.match(firstMatch.versionId, /^ver_v1_/u);
	assert.match(firstMatch.spanId, /^spn_v1_/u);
	assert.match(firstMatch.chunkId, /^chk_v1_/u);
	assert.equal(firstMatch.chunkId.includes(firstMatch.path), false);

	const firstStats = await firstIndex.getStats();
	assert.equal(firstStats.indexOrigin, 'rebuilt');
	assert.equal(firstStats.persistenceStatus, 'published');
	assert.ok(firstStats.indexGenerationId);
	const payloadPath = path.join(
		artifactPath,
		'retrieval',
		'default',
		'generations',
		firstStats.indexGenerationId,
		'payload.bin',
	);
	const payload = await readFile(payloadPath, 'utf8');
	assert.equal(payload.includes(vaultPath), false, 'artifact must not embed the absolute Vault path');

	const reopenedIndex = new KnowledgeIndex(config);
	const reopenedMatches = await reopenedIndex.search('Codex personal MCP');
	assert.equal(reopenedMatches[0]?.documentId, firstMatch.documentId);
	assert.equal(reopenedMatches[0]?.versionId, firstMatch.versionId);
	const reopenedStats = await reopenedIndex.getStats();
	assert.equal(reopenedStats.indexOrigin, 'persistent');
	assert.equal(reopenedStats.persistenceStatus, 'loaded');
	assert.equal(reopenedStats.indexGenerationId, firstStats.indexGenerationId);

	await writeFile(
		path.join(vaultPath, '30-Shared-Knowledge', 'Persistent invalidation.md'),
		[
			'---',
			'type: knowledge-card',
			'status: active',
			'retrieval_scope: default',
			'---',
			'',
			'# Persistent invalidation',
			'',
			'newgenerationbeacon proves a changed source set rebuilds the generation.',
		].join('\n'),
		'utf8',
	);
	const changedIndex = new KnowledgeIndex(config);
	const changedMatches = await changedIndex.search('newgenerationbeacon');
	assert.equal(changedMatches[0]?.path, '30-Shared-Knowledge/Persistent invalidation.md');
	const changedStats = await changedIndex.getStats();
	assert.equal(changedStats.persistenceStatus, 'published');
	assert.notEqual(changedStats.indexGenerationId, firstStats.indexGenerationId);
});

test('configuration keeps derived storage outside the Vault and can disable it', async (t) => {
	const vaultPath = await createFixtureVault();
	const outside = await mkdtemp(path.join(tmpdir(), 'obsidian-config-artifacts-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(outside, { recursive: true, force: true });
	});

	const disabled = await loadServerConfig({
		OBSIDIAN_VAULT_PATH: vaultPath,
		OBSIDIAN_PERSIST_INDEX: 'false',
		OBSIDIAN_SOURCE_IDENTITY: 'connector:stable-test-source',
	});
	assert.equal(disabled.artifactPath, null);
	assert.equal(disabled.sourceIdentity, 'connector:stable-test-source');
	assert.equal(disabled.transmissionReviewMode, 'required');

	const enabled = await loadServerConfig({
		OBSIDIAN_VAULT_PATH: vaultPath,
		OBSIDIAN_ARTIFACT_PATH: outside,
	});
	assert.equal(enabled.artifactPath, await realpath(outside));

	await assert.rejects(
		loadServerConfig({
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_ARTIFACT_PATH: path.join(vaultPath, '.derived-index'),
		}),
		/must not contain one another/u,
	);
	await assert.rejects(
		loadServerConfig({
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_ARTIFACT_PATH: path.dirname(vaultPath),
		}),
		/must not contain one another/u,
	);
	await assert.rejects(
		loadServerConfig({
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_PERSIST_INDEX: 'flase',
		}),
		/must be true or false/u,
	);
	await assert.rejects(
		loadServerConfig({
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_PERSIST_INDEX: 'false',
			OBSIDIAN_TRANSMISSION_REVIEW: 'off',
		}),
		/OBSIDIAN_TRANSMISSION_REVIEW must be one of/u,
	);
});

test('rejects an artifact subdirectory symlinked back into the Vault', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-link-test-'));
	const target = path.join(vaultPath, '.derived-target');
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
	});
	await mkdir(target);
	try {
		await symlink(target, path.join(artifactPath, 'retrieval'), 'dir');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') {
			t.skip('Creating symlinks is not permitted on this platform.');
			return;
		}
		throw error;
	}

	const knowledge = new KnowledgeIndex(persistentConfig(vaultPath, artifactPath));
	await assert.rejects(knowledge.search('Codex'), /must not contain one another/u);
	assert.deepEqual(await readdir(target), []);
});

test('rejects an artifact subdirectory symlinked outside its configured root', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-escape-test-'));
	const outsideTarget = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-external-test-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
		await rm(outsideTarget, { recursive: true, force: true });
	});
	try {
		await symlink(outsideTarget, path.join(artifactPath, 'retrieval'), 'dir');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') {
			t.skip('Creating symlinks is not permitted on this platform.');
			return;
		}
		throw error;
	}

	const knowledge = new KnowledgeIndex(persistentConfig(vaultPath, artifactPath));
	await assert.rejects(knowledge.search('Codex'), /remain inside/u);
	assert.deepEqual(await readdir(outsideTarget), []);
});

test('runtime isolation rejects an artifact root that contains the Vault', async (t) => {
	const vaultPath = await createFixtureVault();
	t.after(async () => removeFixtureVault(vaultPath));
	const knowledge = new KnowledgeIndex(persistentConfig(vaultPath, path.dirname(vaultPath)));
	await assert.rejects(knowledge.search('Codex'), /must not contain one another/u);
});

test('rebuild repairs corrupt pointers and keeps retrieval generations current-only', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-repair-test-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
	});
	const config = persistentConfig(vaultPath, artifactPath);
	const firstIndex = new KnowledgeIndex(config);
	await firstIndex.search('Codex personal MCP');
	const firstStats = await firstIndex.getStats();
	assert.ok(firstStats.indexGenerationId);
	await writeFile(
		path.join(
			artifactPath,
			'retrieval',
			'default',
			'generations',
			firstStats.indexGenerationId,
			'payload.bin',
		),
		'corrupt',
		'utf8',
	);

	const repairedIndex = new KnowledgeIndex(config);
	assert.ok((await repairedIndex.search('Codex personal MCP')).length > 0);
	const repairedStats = await repairedIndex.getStats();
	assert.equal(repairedStats.persistenceStatus, 'repaired');
	assert.notEqual(repairedStats.indexGenerationId, firstStats.indexGenerationId);
	assert.deepEqual(
		await readdir(path.join(artifactPath, 'retrieval', 'default', 'generations')),
		[repairedStats.indexGenerationId],
	);
});

test('persistent round-trip preserves long-line span columns and IDs', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-column-test-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
	});
	const notePath = path.join(vaultPath, '30-Shared-Knowledge', 'column-span.md');
	await writeFile(notePath, [
		'---',
		'type: knowledge-card',
		'status: active',
		'---',
		'# Precise span',
		`${'padding '.repeat(500)}persistedcolumnbeacon84721`,
	].join('\n'));
	const config = persistentConfig(vaultPath, artifactPath);
	config.chunkTokens = 200;

	const first = (await new KnowledgeIndex(config).search('persistedcolumnbeacon84721'))[0];
	const reopened = (await new KnowledgeIndex(config).search('persistedcolumnbeacon84721'))[0];
	assert.ok(first);
	assert.ok(reopened);
	assert.ok((first.startColumn ?? 0) > 1);
	assert.equal(reopened.startColumn, first.startColumn);
	assert.equal(reopened.endColumn, first.endColumn);
	assert.equal(reopened.spanId, first.spanId);
	assert.equal(reopened.chunkId, first.chunkId);
});

test('persistent round-trip preserves every retrieval-mode allowlist', async (t) => {
	const vaultPath = await mkdtemp(path.join(tmpdir(), 'obsidian-persistent-scopes-test-'));
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-scopes-test-'));
	t.after(async () => {
		await rm(vaultPath, { recursive: true, force: true });
		await rm(artifactPath, { recursive: true, force: true });
	});
	const notes: Array<[string, string]> = [
		['30-Shared-Knowledge/core.md', [
			'---', 'type: knowledge-card', 'status: active', '---',
			'# Core', 'persistentscopebeacon coresignal',
		].join('\n')],
		['10-Work/project.md', '# Project\npersistentscopebeacon projectsignal'],
		['40-Resources/reference.md', '# Reference\npersistentscopebeacon referencesignal'],
		['40_Archive/history.md', '# History\npersistentscopebeacon historysignal'],
	];
	await Promise.all(notes.map(async ([relativePath, content]) => {
		const target = path.join(vaultPath, relativePath);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}));
	const config = persistentConfig(vaultPath, artifactPath);
	const expected = {
		default: ['30-Shared-Knowledge/core.md'],
		project: ['10-Work/project.md', '30-Shared-Knowledge/core.md'],
		reference: ['30-Shared-Knowledge/core.md', '40-Resources/reference.md'],
		history: ['30-Shared-Knowledge/core.md', '40_Archive/history.md'],
	} as const;
	const publisher = new KnowledgeIndex(config);
	for (const mode of Object.keys(expected) as Array<keyof typeof expected>) {
		await publisher.search('persistentscopebeacon', { mode, limit: 20 });
		assert.ok(await readFile(path.join(artifactPath, 'retrieval', mode, 'CURRENT')));
	}

	for (const mode of Object.keys(expected) as Array<keyof typeof expected>) {
		const reopened = new KnowledgeIndex(config);
		const matches = await reopened.search('persistentscopebeacon', { mode, limit: 20 });
		assert.deepEqual(matches.map((match) => match.path).sort(), [...expected[mode]].sort());
		assert.equal((await reopened.getStats(false, mode)).indexOrigin, 'persistent');
	}
});

test('withdrawing a note removes its body from the only retained retrieval generation', async (t) => {
	const vaultPath = await createFixtureVault();
	const artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-withdraw-test-'));
	t.after(async () => {
		await removeFixtureVault(vaultPath);
		await rm(artifactPath, { recursive: true, force: true });
	});
	const notePath = path.join(vaultPath, '30-Shared-Knowledge', 'withdrawn.md');
	const config = persistentConfig(vaultPath, artifactPath);
	await writeFile(notePath, [
		'---',
		'type: knowledge-card',
		'status: active',
		'---',
		'# Temporary evidence',
		'withdrawnbodybeacon84721 must be purged from derived retrieval data.',
	].join('\n'));
	const firstIndex = new KnowledgeIndex(config);
	assert.ok((await firstIndex.search('withdrawnbodybeacon84721')).length > 0);
	const firstGeneration = (await firstIndex.getStats()).indexGenerationId;

	await writeFile(notePath, [
		'---',
		'retrieval_scope: never',
		'---',
		'# Withdrawn',
		'withdrawnbodybeacon84721 remains only in the authoritative Vault file.',
	].join('\n'));
	const withdrawnIndex = new KnowledgeIndex(config);
	assert.deepEqual(await withdrawnIndex.search('withdrawnbodybeacon84721'), []);
	const withdrawnStats = await withdrawnIndex.getStats();
	const generationsRoot = path.join(artifactPath, 'retrieval', 'default', 'generations');
	assert.deepEqual(await readdir(generationsRoot), [withdrawnStats.indexGenerationId]);
	assert.notEqual(withdrawnStats.indexGenerationId, firstGeneration);
	const payload = await readFile(
		path.join(generationsRoot, withdrawnStats.indexGenerationId ?? '', 'payload.bin'),
		'utf8',
	);
	assert.equal(payload.includes('withdrawnbodybeacon84721'), false);
});
