import assert from 'node:assert/strict';
import { chmod, link, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	COMPILED_ARTIFACT_SCHEMA_VERSION,
	type CompactLexicalArtifact,
} from '../src/persistence/artifactTypes.js';
import {
	ArtifactGenerationStore,
	type ArtifactBundleInput,
} from '../src/persistence/artifactGenerationStore.js';
import {
	BuildStateStore,
	type CompilerCheckpoint,
} from '../src/persistence/buildStateStore.js';
import {
	buildCompactPostingIndex,
	compactLexicalArtifact,
	decodeCompactPostingIndex,
	encodeOrdinalSet,
	materializeLexicalArtifact,
} from '../src/persistence/compactLexical.js';
import { createSourceId } from '../src/stableIds.js';

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'five-plane-persistence-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('compact postings round-trip and delta deletion propagates before compaction', () => {
	const base = buildCompactPostingIndex([
		{ ordinal: 0, documentLength: 3, termFrequencies: new Map([['alpha', 2], ['shared', 1]]) },
		{ ordinal: 300, documentLength: 2, termFrequencies: new Map([['beta', 1], ['shared', 1]]) },
	]);
	const decoded = decodeCompactPostingIndex(base);
	assert.deepEqual([...decoded.postings.get('shared')?.entries() ?? []], [[0, 1], [300, 1]]);
	assert.equal(decoded.documentLengths.get(300), 2);

	const artifact: CompactLexicalArtifact = {
		schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
		base,
		deltas: [{
			createdAt: '2026-09-15T00:00:00.000Z',
			replaceOrdinalsBase64: encodeOrdinalSet([0, 300]),
			index: buildCompactPostingIndex([
				{ ordinal: 0, documentLength: 1, termFrequencies: new Map([['gamma', 1]]) },
			]),
		}],
	};
	const materialized = materializeLexicalArtifact(artifact);
	assert.equal(materialized.postings.has('alpha'), false);
	assert.equal(materialized.postings.has('beta'), false);
	assert.deepEqual([...materialized.postings.get('gamma')?.entries() ?? []], [[0, 1]]);
	assert.equal(materialized.documentLengths.has(300), false);

	const compacted = compactLexicalArtifact(artifact);
	assert.equal(compacted.deltas.length, 0);
	assert.deepEqual(
		[...materializeLexicalArtifact(compacted).postings.get('gamma')?.entries() ?? []],
		[[0, 1]],
	);
});

test('artifact generations expose verified logical layers through READY and CURRENT', async () => {
	await withTemporaryRoot(async (root) => {
		const store = new ArtifactGenerationStore(path.join(root, 'generations'));
		const first = await store.publish(emptyBundleInput('first'));
		const second = await store.publish(emptyBundleInput('second'));
		assert.equal(second.manifest.parentGenerationId, first.generationId);
		assert.equal((await store.readCurrent())?.generationId, second.generationId);
		assert.equal(
			(await store.readCurrent())?.bundle.layers.catalog.data.policyHash,
			'a'.repeat(64),
		);
		assert.equal(
			await readFile(path.join(root, 'generations', 'generations', second.generationId, 'READY'), 'utf8')
				.then((value) => value.length > 0),
			true,
		);
		assert.equal((await store.rollback()).generationId, first.generationId);
	});
});

test('artifact publication remains valid under concurrent writers without a bundle-parent race', async () => {
	await withTemporaryRoot(async (root) => {
		const generationRoot = path.join(root, 'generations');
		const stores = Array.from({ length: 5 }, () => new ArtifactGenerationStore(generationRoot));
		const published = await Promise.all(
			stores.map((store, index) => store.publish(emptyBundleInput(`writer-${index}`))),
		);
		assert.equal(new Set(published.map((item) => item.generationId)).size, 5);
		const current = await stores[0]?.readCurrent();
		assert.ok(current);
		assert.ok(published.some((item) => item.generationId === current.generationId));
	});
});

test('build state persists checksummed per-file checkpoints and a verifiable compactable journal', async () => {
	await withTemporaryRoot(async (root) => {
		const store = new BuildStateStore(root);
		const checkpoint: CompilerCheckpoint<{ answer: number }> = {
			schemaVersion: 1,
			buildId: 'build-test',
			sourceId: createSourceId('logical:test'),
			policyHash: 'a'.repeat(64),
			planHash: 'b'.repeat(64),
			startedAt: '2026-09-15T00:00:00.000Z',
			completedFiles: [{ path: 'one.md', contentSha256: 'c'.repeat(64), artifact: { answer: 42 } }],
		};
		await store.writeCheckpoint(checkpoint);
		assert.deepEqual(await store.readCheckpoint(), checkpoint);
		for (let index = 0; index < 4; index += 1) {
			await store.appendJournal({
				timestamp: `2026-09-15T00:00:0${index}.000Z`,
				event: index === 0 ? 'scan-started' : 'file-compiled',
				buildId: 'build-test',
				path: index === 0 ? null : `${index}.md`,
				contentSha256: index === 0 ? null : 'd'.repeat(64),
				generationId: null,
			});
		}
		assert.equal((await store.readJournal()).length, 4);
		assert.equal(await store.compactJournal(2), 2);
		const compacted = await store.readJournal();
		assert.deepEqual(compacted.map((record) => record.sequence), [1, 2]);
		assert.equal(compacted[0]?.previousHash, null);

		const checkpointPath = path.join(root, 'checkpoint.json');
		const damaged = (await readFile(checkpointPath, 'utf8')).replace(/"checksum":"[a-f0-9]/u, '"checksum":"z');
		await writeFile(checkpointPath, damaged, 'utf8');
		await assert.rejects(store.readCheckpoint(), /checksum mismatch/u);
	});
});

test('build state rejects non-private modes and hard-linked sensitive files on POSIX', async (context) => {
	if (process.platform === 'win32') {
		context.skip('POSIX ownership and mode enforcement is outside the Windows portable-fs boundary.');
		return;
	}
	await withTemporaryRoot(async (root) => {
		const store = new BuildStateStore(root);
		const checkpoint: CompilerCheckpoint<{ marker: string }> = {
			schemaVersion: 1,
			buildId: 'build-private-state',
			sourceId: createSourceId('logical:private-state'),
			policyHash: '1'.repeat(64),
			planHash: '2'.repeat(64),
			startedAt: '2026-09-15T00:00:00.000Z',
			completedFiles: [{
				path: 'private.md',
				contentSha256: '3'.repeat(64),
				artifact: { marker: 'synthetic' },
			}],
		};
		await store.writeCheckpoint(checkpoint);
		const checkpointPath = path.join(root, 'checkpoint.json');
		await chmod(checkpointPath, 0o640);
		await assert.rejects(store.readCheckpoint(), /permissions must be 0600 or stricter/u);
		await chmod(checkpointPath, 0o600);

		await store.appendJournal({
			timestamp: '2026-09-15T00:00:00.000Z',
			event: 'scan-started',
			buildId: 'build-private-state',
			path: null,
			contentSha256: null,
			generationId: null,
		});
		const journalPath = path.join(root, 'changes.ndjson');
		const linkedPath = path.join(root, 'linked-journal');
		await link(journalPath, linkedPath);
		try {
			const reopened = new BuildStateStore(root);
			await assert.rejects(reopened.readJournal(), /exactly one hard link/u);
		} finally {
			await unlink(linkedPath);
		}

		await chmod(path.join(root, 'checkpoint-files'), 0o750);
		await assert.rejects(store.readCheckpoint(), /group or other users/u);
	});
});

function emptyBundleInput(label: string): ArtifactBundleInput {
	const sourceId = createSourceId(`logical:${label}`);
	const base = buildCompactPostingIndex([]);
	return {
		compilerVersion: 'test-compiler',
		createdAt: '2026-09-15T00:00:00.000Z',
		policyHash: 'a'.repeat(64),
		layers: {
			catalog: {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				sourceId,
				policyHash: 'a'.repeat(64),
				nextOrdinal: 0,
				entries: [],
			},
			lexical: { schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION, base, deltas: [] },
			derived: { schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION, documents: [] },
			temporal: { schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION, byOrdinal: [] },
			hierarchy: { schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION, byOrdinal: [] },
			vector: null,
		},
		statistics: { activeDocuments: 0, tombstones: 0, duplicates: 0, lexicalSegments: 1 },
	};
}
