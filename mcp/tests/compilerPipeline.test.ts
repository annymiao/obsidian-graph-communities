import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	OfflineKnowledgeCompiler,
	type EmbeddingProvider,
} from '../src/compiler/offlineKnowledgeCompiler.js';
import { BuildStateStore } from '../src/persistence/buildStateStore.js';
import { materializeLexicalArtifact } from '../src/persistence/compactLexical.js';

interface CompilerFixture {
	root: string;
	source: string;
	state: string;
	generations: string;
}

async function withCompilerFixture(run: (fixture: CompilerFixture) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'five-plane-compiler-'));
	const fixture = {
		root,
		source: path.join(root, 'source'),
		state: path.join(root, 'state'),
		generations: path.join(root, 'artifacts'),
	};
	await mkdir(fixture.source, { recursive: true });
	try {
		await run(fixture);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function writeNote(source: string, relativePath: string, content: string): Promise<void> {
	const absolutePath = path.join(source, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, 'utf8');
}

test('compiler preserves path policy, rejects frontmatter promotions, and fails closed on malformed policy', async () => {
	await withCompilerFixture(async (fixture) => {
		await writeNote(fixture.source, '30-Shared-Knowledge/core.md', [
			'---',
			'type: knowledge-card',
			'status: active',
			'aliases: [Durable core]',
			'---',
			'# Core memory',
			'Durable verified knowledge.',
		].join('\n'));
		await writeNote(fixture.source, 'Projects/project.md', [
			'---',
			'retrieval_scope: default',
			'---',
			'# Project',
			'This project note cannot promote itself into default.',
		].join('\n'));
		await writeNote(fixture.source, '40-Resources/reference.md', '# Reference\nExternal source material.');
		await writeNote(fixture.source, '40-Archive/history.md', '# History\nOld durable decision.');
		await writeNote(fixture.source, 'malformed.md', '---\nsensitivity: public\n# Missing close\nsecret');
		await writeNote(fixture.source, 'duplicate-policy.md', [
			'---', 'sensitivity: public', 'sensitivity: public', '---', '# Duplicate', 'must fail closed',
		].join('\n'));
		await writeNote(fixture.source, 'complex-policy.md', [
			'---', 'sensitivity: [public]', '---', '# Complex', 'must fail closed',
		].join('\n'));
		await writeNote(fixture.source, 'unknown-sensitive.md', [
			'---', 'sensitivity: partner-only', '---', '# Unknown', 'must fail closed',
		].join('\n'));
		await writeNote(fixture.source, '.Git/hidden.md', '# Hidden\nshould never be scanned');
		await writeNote(fixture.source, 'BACKUPS/hidden.md', '# Backup\nshould never be scanned');
		await writeNote(fixture.source, 'Private/Subtree/hidden.md', '# Hidden prefix\nshould never be scanned');
		await writeNote(fixture.source, 'Private/Visible/note.md', '# Visible sibling\nkept');
		await writeNote(fixture.source, 'Other/Subtree/note.md', '# Other subtree\nkept');
		await writeNote(fixture.source, 'outside.md', '# Outside\nsymlink target');
		await symlink(path.join(fixture.source, 'outside.md'), path.join(fixture.source, 'linked.md'));

		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			policy: { ignoredPathPrefixes: ['pRIVATE\\sUBTREE'] },
		});
		const result = await compiler.build();
		assert.equal(result.skippedSymlinks, 1);
		const catalog = result.generation.bundle.layers.catalog.data.entries;
		assert.equal(catalog.some((entry) => entry.path.includes('hidden.md')), false);
		assert.equal(catalog.some((entry) => entry.path === 'linked.md'), false);
		assert.equal(catalog.some((entry) => entry.path === 'Private/Subtree/hidden.md'), false);
		assert.equal(catalog.some((entry) => entry.path === 'Private/Visible/note.md'), true);
		assert.equal(catalog.some((entry) => entry.path === 'Other/Subtree/note.md'), true);
		assert.equal(catalog.find((entry) => entry.path === '30-Shared-Knowledge/core.md')?.retrievalScope, 'default');
		assert.equal(catalog.find((entry) => entry.path === 'Projects/project.md')?.retrievalScope, 'project');
		assert.equal(catalog.find((entry) => entry.path === '40-Resources/reference.md')?.retrievalScope, 'reference');
		assert.equal(catalog.find((entry) => entry.path === '40-Archive/history.md')?.retrievalScope, 'history');
		for (const relativePath of ['malformed.md', 'duplicate-policy.md', 'complex-policy.md', 'unknown-sensitive.md']) {
			assert.equal(catalog.find((entry) => entry.path === relativePath)?.retrievalScope, 'never');
		}
		const derivedPaths = result.generation.bundle.layers.derived.data.documents.map((document) => document.path);
		assert.equal(derivedPaths.includes('malformed.md'), false);
		assert.equal(derivedPaths.includes('unknown-sensitive.md'), false);
	});
});

test('trusted project identity is inherited from configuration and conflicting document scope fails closed', async () => {
	await withCompilerFixture(async (fixture) => {
		await writeNote(fixture.source, 'Projects/allowed.md', [
			'---', 'projectId: attacker-selected', 'retrieval_scope: default', '---', '# Allowed', 'project evidence',
		].join('\n'));
		await writeNote(fixture.source, '40-Resources/conflict.md', '# Conflict\nreference-domain evidence');
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			trustedSource: { projectId: 'trusted-project', retrievalScope: 'project' },
		});
		const result = await compiler.build();
		const catalog = result.generation.bundle.layers.catalog.data.entries;
		const allowed = catalog.find((entry) => entry.path === 'Projects/allowed.md');
		assert.equal(allowed?.projectId, 'trusted-project');
		assert.equal(allowed?.retrievalScope, 'project');
		const conflict = catalog.find((entry) => entry.path === '40-Resources/conflict.md');
		assert.equal(conflict?.projectId, 'trusted-project');
		assert.equal(conflict?.retrievalScope, 'never');
	});
});

test('exact deduplication never crosses scope authorization domains', async () => {
	await withCompilerFixture(async (fixture) => {
		const same = '# Same bytes\ncontent shared across disclosure domains';
		await writeNote(fixture.source, 'Projects/same.md', same);
		await writeNote(fixture.source, '40-Resources/same.md', same);
		await writeNote(fixture.source, '40-Archive/same.md', same);
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
		});
		const result = await compiler.build();
		const entries = result.generation.bundle.layers.catalog.data.entries;
		assert.equal(entries.every((entry) => entry.duplicateOfDocumentId === null), true);
		assert.deepEqual(
			result.generation.bundle.layers.derived.data.documents.map((document) => document.retrievalScope).sort(),
			['history', 'project', 'reference'],
		);
	});
});

test('chunk vectors are persisted by recordId/versionId and unchanged files do not re-embed', async () => {
	await withCompilerFixture(async (fixture) => {
		await writeNote(fixture.source, '30-Shared-Knowledge/vector.md', [
			'---', 'type: knowledge-card', 'status: active', '---', '# Vector', 'semantic memory evidence',
		].join('\n'));
		let calls = 0;
		const provider: EmbeddingProvider = {
			adapterId: 'test-adapter-v1',
			modelId: 'synthetic-two-dimensional',
			kind: 'semantic',
			dimensions: 2,
			async embed(records) {
				calls += 1;
				return records.map((record) => [record.text.length, record.recordId.length]);
			},
		};
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			embeddingProvider: provider,
		});
		const first = await compiler.build();
		const vector = first.generation.bundle.layers.vector?.data;
		assert.equal(vector?.adapterId, provider.adapterId);
		assert.equal(vector?.modelId, provider.modelId);
		assert.equal(vector?.embeddingKind, 'semantic');
		assert.equal(vector?.inputRecipe, 'hybrid-record-search-text-v1');
		assert.equal(vector?.dimension, 2);
		assert.ok((vector?.entries.length ?? 0) > 0);
		const document = first.generation.bundle.layers.derived.data.documents[0];
		assert.ok(document);
		assert.deepEqual(
			vector?.entries.map((entry) => [entry.recordId, entry.versionId]),
			document.chunks.map((chunk) => [chunk.chunkId, document.versionId]),
		);
		assert.equal(document.sourceId, compiler.sourceId);
		assert.equal(document.aliases.length, 0);
		assert.equal(typeof document.modifiedAt, 'string');
		assert.equal(calls, 1);

		const second = await compiler.build();
		assert.equal(second.reusedFiles, 1);
		assert.equal(calls, 1, 'persisted vectors must be reused instead of recomputed at startup/build');
	});
});

test('source changes during a long compile are revalidated before atomic publication', async () => {
	await withCompilerFixture(async (fixture) => {
		const relativePath = '30-Shared-Knowledge/changing.md';
		await writeNote(fixture.source, relativePath, '# Before\npublic evidence before change');
		let changed = false;
		const provider: EmbeddingProvider = {
			adapterId: 'mutating-test-adapter',
			modelId: 'synthetic-mutation',
			kind: 'semantic',
			dimensions: 2,
			async embed(records) {
				if (!changed) {
					changed = true;
					await writeNote(fixture.source, relativePath, [
						'---', 'sensitivity: private', '---', '# After', 'source changed during compilation',
					].join('\n'));
				}
				return records.map(() => [1, 0]);
			},
		};
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			embeddingProvider: provider,
		});
		await assert.rejects(
			compiler.build(),
			/Source changed during offline compilation/u,
		);
		assert.equal(await compiler.readCurrent(), null);
	});
});

test('per-file checkpoint resumes after interruption and is removed only after atomic publication', async () => {
	await withCompilerFixture(async (fixture) => {
		for (const name of ['a', 'b', 'c']) {
			await writeNote(fixture.source, `Research/${name}.md`, `# ${name}\nEvidence ${name}.`);
		}
		let stopped = false;
		const interrupted = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			afterFileCheckpoint: async (_path, completed) => {
				if (completed === 1 && !stopped) {
					stopped = true;
					throw new Error('simulated compiler stop');
				}
			},
		});
		await assert.rejects(interrupted.build(), /simulated compiler stop/u);
		assert.equal((await interrupted.readCurrent()), null);
		const state = new BuildStateStore(fixture.state);
		assert.equal((await state.readCheckpoint())?.completedFiles.length, 1);

		const resumed = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
		});
		const result = await resumed.build();
		assert.equal(result.resumedFiles, 1);
		assert.equal(result.compiledFiles, 2);
		assert.equal((await state.readCheckpoint()), null);
		assert.equal(result.generation.bundle.layers.derived.data.documents.length, 3);
	});
});

test('incremental deletion promotes an exact duplicate, propagates posting deletes, then compacts', async () => {
	await withCompilerFixture(async (fixture) => {
		const duplicate = '# Shared\nexact duplicate searchabletoken';
		await writeNote(fixture.source, 'Research/a.md', duplicate);
		await writeNote(fixture.source, 'Research/b.md', duplicate);
		for (const name of ['c', 'd', 'e', 'f']) {
			await writeNote(fixture.source, `Research/${name}.md`, `# ${name}\nunique-${name} searchabletoken`);
		}
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			policy: {
				lexicalDeltaCompactionThreshold: 10,
				lexicalReplacementCompactionRatio: 1,
			},
		});
		const first = await compiler.build();
		assert.equal(first.duplicateFiles, 1);
		const firstCatalog = first.generation.bundle.layers.catalog.data.entries;
		const a = firstCatalog.find((entry) => entry.path === 'Research/a.md');
		const b = firstCatalog.find((entry) => entry.path === 'Research/b.md');
		assert.ok(a && b);
		assert.equal(b.duplicateOfDocumentId, a.documentId);

		await rm(path.join(fixture.source, 'Research/a.md'));
		const second = await compiler.build();
		assert.equal(second.tombstonedFiles, 1);
		assert.equal(second.compacted, false);
		assert.equal(second.generation.bundle.layers.lexical.data.deltas.length, 1);
		const secondCatalog = second.generation.bundle.layers.catalog.data.entries;
		assert.notEqual(secondCatalog.find((entry) => entry.path === 'Research/a.md')?.tombstoneAt, null);
		assert.equal(secondCatalog.find((entry) => entry.path === 'Research/b.md')?.duplicateOfDocumentId, null);
		const materialized = materializeLexicalArtifact(second.generation.bundle.layers.lexical.data);
		assert.equal(materialized.documentLengths.has(a.ordinal), false);
		assert.equal(materialized.documentLengths.has(b.ordinal), true);

		const third = await compiler.build({ forceCompaction: true });
		assert.equal(third.compacted, true);
		assert.equal(third.generation.bundle.layers.lexical.data.deltas.length, 0);
		assert.equal(materializeLexicalArtifact(third.generation.bundle.layers.lexical.data).documentLengths.has(b.ordinal), true);
		const serialized = JSON.stringify(third.generation.bundle);
		assert.equal(serialized.includes(fixture.source), false, 'absolute source locator must not enter published artifacts');
	});
});

test('published catalog carries content hash, policy hash, last-seen and stable tombstones', async () => {
	await withCompilerFixture(async (fixture) => {
		await writeNote(fixture.source, 'Research/note.md', '# Note\ncontent hash evidence');
		let tick = 0;
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot: fixture.source,
			stateRoot: fixture.state,
			generationRoot: fixture.generations,
			clock: () => new Date(Date.UTC(2026, 8, 15, 0, 0, tick++)),
		});
		const first = await compiler.build();
		const initial = first.generation.bundle.layers.catalog.data.entries[0];
		assert.ok(initial);
		assert.match(initial.contentSha256, /^[a-f0-9]{64}$/u);
		assert.equal(first.generation.bundle.layers.catalog.data.policyHash, compiler.policyHash);
		await rm(path.join(fixture.source, 'Research/note.md'));
		const second = await compiler.build();
		const deleted = second.generation.bundle.layers.catalog.data.entries[0];
		assert.ok(deleted?.tombstoneAt);
		assert.equal(deleted?.firstSeenAt, initial.firstSeenAt);
		assert.equal(deleted?.lastSeenAt, initial.lastSeenAt);
		assert.equal(await readFile(path.join(fixture.generations, 'CURRENT'), 'utf8').then(Boolean), true);
	});
});
