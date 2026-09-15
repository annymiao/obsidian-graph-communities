import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	Bm25Retriever,
	DenseRetriever,
	DeterministicLocalEmbedding,
	ExactVectorIndex,
	HierarchyRetriever,
	HybridQueryEngine,
	LoopbackEmbeddingAdapter,
	MetadataRetriever,
	stableHash32,
	TemporalRetriever,
} from '../src/hybrid/index.js';
import type {
	EmbeddingAdapter,
	HybridRecord,
	HybridRetriever,
	RetrievalContext,
} from '../src/hybrid/index.js';

const NOW = Date.UTC(2026, 8, 15);

function record(id: string, overrides: Partial<HybridRecord> = {}): HybridRecord {
	return {
		id,
		sourceId: 'source-main',
		documentId: `document-${id}`,
		versionId: `version-${id}`,
		path: `Knowledge/${id}.md`,
		title: `Document ${id}`,
		heading: null,
		content: 'ordinary background material',
		startLine: 1,
		endLine: 3,
		corpus: 'core',
		retrievalScope: 'default',
		...overrides,
	};
}

function context(
	records: readonly HybridRecord[],
	text: string,
	extra: Partial<RetrievalContext> = {},
): RetrievalContext {
	const controller = new AbortController();
	return {
		query: { text, scope: { mode: 'default' }, now: NOW },
		records,
		visibleRecordIds: new Set(records.map((item) => item.id)),
		limit: 10,
		deadlineAt: Date.now() + 5_000,
		signal: controller.signal,
		...extra,
	};
}

async function firstId(retriever: HybridRetriever, request: RetrievalContext): Promise<string | undefined> {
	return (await retriever.retrieve(request))[0]?.recordId;
}

test('five retrieval channels have independent deterministic contracts', async () => {
	const records = [
		record('content', {
			content: 'heliosphere beacon is verified in this paragraph',
			modifiedAt: NOW - 40 * 86_400_000,
		}),
		record('metadata', {
			title: 'Neptune Operations',
			tags: ['ocean-blue'],
			modifiedAt: NOW - 5 * 86_400_000,
		}),
		record('hierarchy', {
			path: 'Architecture/Retrieval/hierarchy.md',
			hierarchy: ['Architecture', 'Retrieval', 'Evidence'],
			modifiedAt: NOW - 1 * 86_400_000,
		}),
	];
	const request = { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
	const dense = await DenseRetriever.create(records, request, new DeterministicLocalEmbedding(128));

	assert.equal(await firstId(new Bm25Retriever(records), context(records, 'heliosphere beacon')), 'content');
	assert.equal(await firstId(dense, context(records, 'heliosphere beacon')), 'content');
	assert.equal(await firstId(new MetadataRetriever(records), context(records, 'Neptune Operations')), 'metadata');
	assert.equal(await firstId(
		new TemporalRetriever(records),
		{
			...context(records, 'latest'),
			query: { text: 'latest', scope: { mode: 'default' }, now: NOW, temporal: { preferRecent: true } },
		},
	), 'hierarchy');
	assert.equal(await firstId(new HierarchyRetriever(records), context(records, 'Architecture Evidence')), 'hierarchy');
});

test('hierarchy seeds recall visible siblings but cannot use a hidden project seed', async () => {
	const records = [
		record('seed', { hierarchy: ['Workspace', 'Safe Project'] }),
		record('sibling', { hierarchy: ['Workspace', 'Safe Project'] }),
		record('hidden-seed', {
			hierarchy: ['Workspace', 'Hidden Project'],
			retrievalScope: 'project',
			projectId: 'hidden',
		}),
		record('hidden-sibling', {
			hierarchy: ['Workspace', 'Hidden Project'],
			retrievalScope: 'project',
			projectId: 'hidden',
		}),
	];
	const retriever = new HierarchyRetriever(records);
	const visible = records.slice(0, 2);
	const base = context(visible, 'unmatched-term');
	const visibleSeedHits = await retriever.retrieve({
		...base,
		query: { ...base.query, seedRecordIds: ['seed'] },
	});
	assert.ok(visibleSeedHits.some((hit) => hit.recordId === 'sibling'));
	const hiddenSeedHits = await retriever.retrieve({
		...base,
		query: { ...base.query, seedRecordIds: ['hidden-seed'] },
	});
	assert.deepEqual(hiddenSeedHits, []);
});

test('deterministic embeddings and vector artifacts are reproducible and version-bound', async () => {
	const records = [
		record('first', { content: 'alpha reusable memory' }),
		record('second', { content: 'beta unrelated note' }),
	];
	const adapter = new DeterministicLocalEmbedding(64);
	const request = { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
	const [firstRun, secondRun] = await Promise.all([
		adapter.embed(['alpha reusable memory'], request),
		adapter.embed(['alpha reusable memory'], request),
	]);
	assert.deepEqual(firstRun, secondRun);

	const built = await ExactVectorIndex.build(records, adapter, request);
	const artifact = built.toArtifact();
	assert.equal(artifact.adapterId, adapter.id);
	assert.equal(artifact.modelId, adapter.modelId);
	assert.equal(artifact.embeddingKind, 'lexical_hash');
	assert.equal(artifact.inputRecipe, 'hybrid-record-search-text-v1');
	assert.equal(artifact.dimension, 64);
	const loaded = ExactVectorIndex.fromArtifact(records, adapter, artifact);
	const results = await loaded.search('alpha reusable memory', 2, new Set(['first', 'second']), request);
	assert.equal(results[0]?.recordId, 'first');

	const stale = {
		...artifact,
		entries: artifact.entries.map((entry) => (
			entry.recordId === 'first' ? { ...entry, versionId: 'stale-version' } : entry
		)),
	};
	assert.throws(() => ExactVectorIndex.fromArtifact(records, adapter, stale), /Stale vector artifact/u);

	const extreme: EmbeddingAdapter = {
		id: 'synthetic-extreme-vectors',
		modelId: 'synthetic-extreme-vectors',
		kind: 'semantic',
		dimension: 32,
		async embed(texts) {
			return texts.map(() => [1e200, ...Array.from({ length: 31 }, () => 0)]);
		},
	};
	await assert.rejects(
		ExactVectorIndex.build(records, extreme, request),
		/malformed|dimension/u,
		'finite components whose squared norm overflows must fail closed',
	);
	const unsafeArtifact = {
		...artifact,
		entries: artifact.entries.map((entry) => ({
			...entry,
			values: [1e200, ...entry.values.slice(1)],
		})),
	};
	assert.throws(
		() => ExactVectorIndex.fromArtifact(records, adapter, unsafeArtifact),
		/Malformed vector artifact/u,
	);
});

test('feature-hash dense fallback rejects a deliberate OOV hash collision', async () => {
	const dimension = 32;
	const knownToken = 'knowncollisiontoken';
	const signature = (value: string): string => (
		`${stableHash32(value) % dimension}:${stableHash32(value, 2_246_822_519) & 1}`
	);
	let collidingToken = '';
	for (let index = 0; index < 20_000; index += 1) {
		const candidate = `oovcollision${index}`;
		if (candidate !== knownToken && signature(candidate) === signature(knownToken)) {
			collidingToken = candidate;
			break;
		}
	}
	assert.notEqual(collidingToken, '', 'test must construct an actual signed-bucket collision');
	const records = [record('collision', { title: '', content: knownToken })];
	const adapter = new DeterministicLocalEmbedding(dimension);
	const request = { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
	const index = await ExactVectorIndex.build(records, adapter, request);
	const raw = await index.search(collidingToken, 1, new Set(['collision']), request);
	assert.ok((raw[0]?.score ?? 0) > 0.99, 'fixture must collide in raw vector space');
	const dense = await DenseRetriever.create(records, request, adapter);
	assert.deepEqual(await dense.retrieve(context(records, collidingToken)), []);
	const pack = await new HybridQueryEngine(records, [dense]).query({
		text: collidingToken,
		scope: { mode: 'default' },
	});
	assert.equal(pack.status, 'no_evidence');
	assert.deepEqual(pack.evidence, []);
});

test('loopback adapter exposes no configurable host or path', () => {
	const adapter = new LoopbackEmbeddingAdapter({
		port: 11_434,
		model: 'nomic-embed-text',
		dimension: 768,
	});
	assert.equal(adapter.id, 'loopback-openai-compatible:nomic-embed-text');
	assert.equal(adapter.modelId, 'nomic-embed-text');
	assert.throws(() => new LoopbackEmbeddingAdapter({
		port: 80,
		model: 'unsafe',
		dimension: 4,
	}), /port/u);
});
