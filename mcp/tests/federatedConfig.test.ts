import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadKnowledgeServiceConfig } from '../src/config.js';

test('legacy OBSIDIAN_VAULT_PATH remains a single-source configuration', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-single-config-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const loaded = await loadKnowledgeServiceConfig({
		OBSIDIAN_VAULT_PATH: root,
		OBSIDIAN_PERSIST_INDEX: 'false',
		OBSIDIAN_TRANSMISSION_REVIEW: 'trusted-local',
	});
	assert.equal(loaded.sources.length, 1);
	assert.equal(loaded.sources[0]?.vaultPath, await realpath(root));
	assert.equal(loaded.sources[0]?.sourceName, path.basename(root));
	assert.equal(loaded.catalogConfigured, false);
	assert.equal(loaded.transmissionReviewMode, 'trusted-local');
});

test('strict source JSON produces independent logical identities and artifact roots', async (t) => {
	const parent = await mkdtemp(path.join(tmpdir(), 'obsidian-federated-config-'));
	const first = path.join(parent, 'first');
	const second = path.join(parent, 'second');
	const artifacts = path.join(parent, 'artifacts');
	await Promise.all([mkdir(first), mkdir(second), mkdir(artifacts)]);
	t.after(() => rm(parent, { recursive: true, force: true }));
	const loaded = await loadKnowledgeServiceConfig({
		OBSIDIAN_SOURCES_JSON: JSON.stringify([
			{
				id: 'archive-a',
				name: 'Archive A',
				path: first,
				kind: 'obsidian-vault',
				project_id: 'project-a',
				writable: true,
			},
			{ id: 'archive-b', name: 'Archive B', path: second },
		]),
		OBSIDIAN_ARTIFACT_PATH: artifacts,
	});

	assert.deepEqual(loaded.sources.map((source) => source.sourceIdentity), [
		'archive-a',
		'archive-b',
	]);
	assert.equal(loaded.catalogConfigured, true);
	assert.deepEqual(loaded.sources.map((source) => source.sourceName), [
		'Archive A',
		'Archive B',
	]);
	assert.deepEqual(loaded.sources.map((source) => source.sourceKind), [
		'obsidian-vault',
		'directory',
	]);
	assert.equal(loaded.sources[0]?.projectId, 'project-a');
	assert.equal(loaded.sources[0]?.writable, true);
	assert.equal(loaded.sources[1]?.writable, false);
	const artifactPaths = loaded.sources.map((source) => source.artifactPath);
	assert.equal(new Set(artifactPaths).size, 2);
	for (const artifactPath of artifactPaths) {
		assert.equal(typeof artifactPath, 'string');
		assert.equal(path.dirname(artifactPath as string), await realpath(artifacts));
	}
});

test('source JSON rejects ambiguity and unsupported shapes before indexing', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-federated-invalid-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	await assert.rejects(
		loadKnowledgeServiceConfig({ OBSIDIAN_SOURCES_JSON: '{}' }),
		/must contain 1 to 16 sources/u,
	);
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify(Array.from({ length: 17 }, (_, index) => ({
				id: `source-${index}`,
				name: `Source ${index}`,
				path: root,
			}))),
		}),
		/must contain 1 to 16 sources/u,
	);
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{ id: 'I', name: 'One', path: root },
				{ id: 'i', name: 'Two', path: root },
			]),
		}),
		/duplicate source id/u,
	);
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{ id: 'one', name: 'One', path: root, enabled: true },
			]),
		}),
		/unsupported field/u,
	);
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{ id: 'one', name: 'One', path: root, writable: 'yes' },
			]),
		}),
		/writable must be boolean/u,
	);
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([{ id: 'one', name: 'One', path: root }]),
			OBSIDIAN_VAULT_PATH: root,
		}),
		/cannot be used together/u,
	);
});

test('source roots cannot overlap or use a symbolic-link root', async (t) => {
	const parent = await mkdtemp(path.join(tmpdir(), 'obsidian-federated-roots-'));
	const child = path.join(parent, 'nested');
	const target = path.join(parent, 'target');
	const link = path.join(parent, 'source-link');
	await Promise.all([mkdir(child), mkdir(target)]);
	t.after(() => rm(parent, { recursive: true, force: true }));

	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{ id: 'parent', name: 'Parent', path: parent },
				{ id: 'child', name: 'Child', path: child },
			]),
			OBSIDIAN_PERSIST_INDEX: 'false',
		}),
		/roots cannot overlap/u,
	);

	try {
		await symlink(target, link, 'dir');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EPERM') {
			t.skip('Creating symlinks is not permitted on this platform.');
			return;
		}
		throw error;
	}
	await assert.rejects(
		loadKnowledgeServiceConfig({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{ id: 'linked', name: 'Linked', path: link },
			]),
			OBSIDIAN_PERSIST_INDEX: 'false',
		}),
		/symbolic-link root/u,
	);
});
