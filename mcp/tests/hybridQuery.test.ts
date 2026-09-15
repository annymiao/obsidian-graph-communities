import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
	Bm25Retriever,
	DeterministicLocalEmbedding,
	ExactVectorIndex,
	HybridQueryEngine,
	HybridDeadlineError,
	TemporalRetriever,
	extractiveCompress,
} from '../src/hybrid/index.js';
import type {
	EmbeddingRequest,
	HybridRecord,
	HybridRetriever,
	RetrievalContext,
} from '../src/hybrid/index.js';

function record(id: string, overrides: Partial<HybridRecord> = {}): HybridRecord {
	return {
		id,
		sourceId: 'source-main',
		documentId: `document-${id}`,
		versionId: `version-${id}`,
		path: `Knowledge/${id}.md`,
		title: `Document ${id}`,
		heading: 'Evidence',
		content: 'ordinary background material',
		startLine: 4,
		endLine: 8,
		corpus: 'core',
		retrievalScope: 'default',
		...overrides,
	};
}

test('unified visibility blocks project, source, path, and malicious retriever leakage', async () => {
		const records = [
		record('core', { content: 'quasar decision has safe attributable evidence' }),
		record('project-alpha', {
			path: 'Projects/Alpha/secret.md',
			content: 'quasar quasar quasar private alpha detail',
			retrievalScope: 'project',
			projectId: 'alpha',
		}),
		record('project-beta', {
			path: 'Projects/Beta/secret.md',
			content: 'quasar quasar beta secret',
			retrievalScope: 'project',
			projectId: 'beta',
		}),
		record('malformed-project', {
			content: 'quasar malformed project boundary',
			retrievalScope: 'default',
			projectId: 'beta',
		}),
		record('other-source', {
			sourceId: 'source-other',
			content: 'quasar other source secret',
		}),
		record('excluded', {
			path: 'Private/Excluded/hidden.md',
			content: 'quasar excluded secret',
		}),
		record('never', { content: 'quasar never visible', retrievalScope: 'never' }),
		record('traversal', { path: 'Private/../Knowledge/leak.md', content: 'quasar traversal leak' }),
		];
	const leaky: HybridRetriever = {
		id: 'adversarial-id-containing-hidden-diagnostic',
		channel: 'dense',
		async retrieve(): Promise<readonly {
			recordId: string;
			channel: 'dense';
			score: number;
			reasons: readonly string[];
		}[]> {
			return records.map((item, index) => ({
				recordId: item.id,
				channel: 'dense',
				score: 100 - index,
				reasons: ['hidden-retriever-diagnostic-content'],
			}));
		},
	};
	const engine = new HybridQueryEngine(records, [new Bm25Retriever(records), leaky], {
		reranker: {
			id: 'adversarial-reranker-id-containing-hidden-diagnostic',
			async rerank({ candidates }) {
				return candidates.map((candidate) => ({
					recordId: candidate.record.id,
					score: candidate.fusedScore,
					reasons: ['hidden-reranker-diagnostic-content'],
				}));
			},
		},
	});
	const defaultPack = await engine.query({
		text: 'quasar',
		scope: {
			mode: 'default',
			allowedSourceIds: ['source-main'],
			excludedPathPrefixes: ['Private/Excluded'],
		},
	});
	assert.equal(defaultPack.status, 'ok');
	assert.deepEqual(defaultPack.evidence.map((item) => item.recordId), ['core']);
	assert.doesNotMatch(
		JSON.stringify(defaultPack),
		/private alpha|beta secret|malformed project|other source|excluded secret|never visible|traversal leak|hidden-(?:retriever|reranker)-diagnostic/u,
	);

	const projectPack = await engine.query({
		text: 'quasar',
		scope: {
			mode: 'project',
			allowedProjectIds: ['alpha'],
			allowedSourceIds: ['source-main'],
			excludedPathPrefixes: ['Private'],
		},
	});
	assert.equal(projectPack.status, 'ok');
	assert.deepEqual(
		new Set(projectPack.evidence.map((item) => item.recordId)),
		new Set(['core', 'project-alpha']),
	);
	assert.doesNotMatch(JSON.stringify(projectPack), /beta secret|other source|excluded secret/u);

	const failClosedProject = await engine.query({
		text: 'private alpha detail',
		scope: { mode: 'project' },
	});
	assert.equal(failClosedProject.evidence.some((item) => item.recordId === 'project-alpha'), false);
});

test('RRF output is near-deduplicated, diversified, and extractively compressed', async () => {
	const repeated = [
		'Orion launch decision is approved for the reusable memory system.',
		'All evidence comes from the signed local artifact.',
		'Unrelated padding follows for bounded compression.',
		'x'.repeat(400),
	].join(' ');
	const records = [
		record('duplicate-a', { content: repeated }),
		record('duplicate-b', { content: repeated }),
		record('diverse', { content: 'Orion has independent deployment evidence from the rollback audit.' }),
	];
	const engine = new HybridQueryEngine(records, [new Bm25Retriever(records)]);
	const pack = await engine.query(
		{ text: 'Orion evidence', scope: { mode: 'default' } },
		{
			limit: 3,
			perEvidenceMaxCharacters: 120,
			evidenceMaxCharacters: 240,
			nearDuplicateThreshold: 0.8,
		},
	);
	assert.equal(pack.status, 'ok');
	assert.equal(pack.evidence.filter((item) => item.recordId.startsWith('duplicate-')).length, 1);
	assert.ok(pack.evidence.some((item) => item.recordId === 'diverse'));
	assert.ok(pack.evidence.every((item) => item.excerpt.length <= 120));
	assert.ok(pack.evidence.some((item) => item.compressed));

	const excerpt = extractiveCompress(repeated, 'signed local artifact', 100);
	assert.match(excerpt.text, /signed local artifact/u);
	assert.doesNotMatch(excerpt.text, /invented/u);
});

test('explicit temporal bounds are global hard filters while preferRecent remains soft', async () => {
	const records = [
		record('old', { content: 'chronicle chronicle old evidence', modifiedAt: 1_000 }),
		record('fresh', { content: 'chronicle fresh evidence', modifiedAt: 3_000 }),
		record('undated', { content: 'chronicle undated evidence' }),
	];
	const leaky: HybridRetriever = {
		id: 'temporal-boundary-adversary',
		channel: 'dense',
		async retrieve() {
			return records.map((item, index) => ({
				recordId: item.id,
				channel: 'dense' as const,
				score: 100 - index,
				reasons: ['adversarial'],
			}));
		},
	};
	const engine = new HybridQueryEngine(records, [new Bm25Retriever(records), leaky]);
	const after = await engine.query({
		text: 'chronicle',
		scope: { mode: 'default' },
		temporal: { after: 2_000 },
	});
	assert.deepEqual(after.evidence.map((item) => item.recordId), ['fresh']);
	const before = await engine.query({
		text: 'chronicle',
		scope: { mode: 'default' },
		temporal: { before: 2_000 },
	});
	assert.deepEqual(before.evidence.map((item) => item.recordId), ['old']);
	const empty = await engine.query({
		text: 'chronicle',
		scope: { mode: 'default' },
		temporal: { after: 4_000 },
	});
	assert.equal(empty.status, 'no_evidence');
	assert.deepEqual(empty.evidence, []);
	const boundedRecords = [
		record('matching-old', { content: 'target-only-in-the-past', modifiedAt: 1_000 }),
		record('irrelevant-fresh', { content: 'unrelated current material', modifiedAt: 3_000 }),
	];
	const irrelevantInRange = await new HybridQueryEngine(
		boundedRecords,
		[new Bm25Retriever(boundedRecords), new TemporalRetriever(boundedRecords)],
	).query({
		text: 'target-only-in-the-past',
		scope: { mode: 'default' },
		temporal: { after: 2_000 },
	});
	assert.equal(irrelevantInRange.status, 'no_evidence');
	assert.deepEqual(irrelevantInRange.evidence, []);

	const recencyOnly = await new HybridQueryEngine(
		records,
		[new TemporalRetriever(records)],
	).query({
		text: 'chronicle',
		scope: { mode: 'default' },
		temporal: { preferRecent: true },
		now: 4_000,
	});
	assert.equal(recencyOnly.evidence[0]?.recordId, 'fresh');
	assert.ok(recencyOnly.evidence.some((item) => item.recordId === 'old'));
});

test('empty, failed, and timed-out retrieval return explicit safe refusals', async () => {
	const item = record('only', { content: 'known content' });
	const empty: HybridRetriever = {
		id: 'empty',
		channel: 'bm25',
		async retrieve() { return []; },
	};
	const failed: HybridRetriever = {
		id: 'failed-source',
		channel: 'metadata',
		async retrieve() { throw new Error('sensitive internal source detail'); },
	};
	const slow: HybridRetriever = {
		id: 'slow-source',
		channel: 'dense',
		async retrieve(_context: RetrievalContext) {
			await delay(250);
			return [{ recordId: item.id, channel: 'dense' as const, score: 1, reasons: ['late'] }];
		},
	};

	const noEvidence = await new HybridQueryEngine([item], [empty]).query({
		text: 'missing', scope: { mode: 'default' },
	});
	assert.equal(noEvidence.status, 'no_evidence');
	assert.equal(noEvidence.evidence.length, 0);

	const sourceFailure = await new HybridQueryEngine([item], [failed]).query({
		text: 'known', scope: { mode: 'default' },
	});
	assert.equal(sourceFailure.status, 'source_failure');
	assert.equal(sourceFailure.evidence.length, 0);
	assert.doesNotMatch(JSON.stringify(sourceFailure), /sensitive internal source detail/u);

	const startedAt = performance.now();
	const timeout = await new HybridQueryEngine([item], [slow]).query(
		{ text: 'known', scope: { mode: 'default' } },
		{ deadlineMs: 20 },
	);
	assert.equal(timeout.status, 'timeout');
	assert.equal(timeout.evidence.length, 0);
	assert.ok(performance.now() - startedAt < 500, 'abortable deadline must not await an uncooperative source');
	assert.equal(timeout.failures[0]?.code, 'timeout');

	const cpuBlocking: HybridRetriever = {
		id: 'cpu-blocking-source',
		channel: 'hierarchy',
		async retrieve() {
			const until = Date.now() + 30;
			let iterations = 0;
			while (Date.now() < until) iterations += 1;
			assert.ok(iterations > 0);
			return [];
		},
	};
	const blocked = await new HybridQueryEngine([item], [cpuBlocking]).query(
		{ text: 'known', scope: { mode: 'default' } },
		{ deadlineMs: 5 },
	);
	assert.equal(blocked.status, 'timeout', 'wall-clock recheck must fail closed after CPU blocking');
	assert.equal(blocked.evidence.length, 0);

	const compressionAbort = new AbortController();
	compressionAbort.abort();
	assert.throws(
		() => extractiveCompress(
			'x'.repeat(10_000),
			'known',
			100,
			{ signal: compressionAbort.signal, deadlineAt: Date.now() + 5_000 },
		),
		HybridDeadlineError,
		'extractive compression must cooperatively observe cancellation',
	);

	const blockingReranker = {
		id: 'cpu-blocking-reranker',
		async rerank({ candidates }: { candidates: readonly { record: HybridRecord; fusedScore: number }[] }) {
			const until = Date.now() + 30;
			while (Date.now() < until) {
				// Intentionally block the event loop to verify the wall-clock recheck.
			}
			return candidates.map((candidate) => ({
				recordId: candidate.record.id,
				score: candidate.fusedScore,
			}));
		},
	};
	const afterRerankDeadline = await new HybridQueryEngine(
		[item],
		[new Bm25Retriever([item])],
		{ reranker: blockingReranker },
	).query(
		{ text: 'known', scope: { mode: 'default' } },
		{ deadlineMs: 5 },
	);
	assert.equal(afterRerankDeadline.status, 'timeout');
	assert.equal(afterRerankDeadline.evidence.length, 0);
});

test('a precomputed vector artifact avoids document re-embedding at runtime', async () => {
	const records = [record('memory', { content: 'durable reusable memory' })];
	const base = new DeterministicLocalEmbedding(64);
	const request = { signal: new AbortController().signal, deadlineAt: Date.now() + 5_000 };
	const artifact = (await ExactVectorIndex.build(records, base, request)).toArtifact();
	class CountingEmbedding extends DeterministicLocalEmbedding {
		calls = 0;

		override async embed(texts: readonly string[], embeddingRequest: EmbeddingRequest) {
			this.calls += 1;
			return super.embed(texts, embeddingRequest);
		}
	}
	const counting = new CountingEmbedding(64);
	const engine = await HybridQueryEngine.create(records, {
		embeddingAdapter: counting,
		vectorArtifact: artifact,
	});
	assert.equal(counting.calls, 0, 'loading an artifact must not re-embed documents');
	const pack = await engine.query({ text: 'durable memory', scope: { mode: 'default' } });
	assert.equal(pack.status, 'ok');
	assert.equal(counting.calls, 1, 'runtime should embed only the query');
});

test('warm hybrid query over a large synthetic corpus stays below the five-second contract', async () => {
	const size = 5_000;
	const records = Array.from({ length: size }, (_, index) => record(`scale-${index}`, {
		path: `Synthetic/Batch-${Math.floor(index / 100)}/note-${index}.md`,
		title: index === size - 1 ? 'Warm Needle Target' : `Synthetic Note ${index}`,
		content: index === size - 1
			? 'warmneedle4999 is the attributable terminal evidence'
			: `neutral synthetic material sequence ${index}`,
		hierarchy: ['Synthetic', `Batch-${Math.floor(index / 100)}`],
	}));
	const engine = await HybridQueryEngine.create(records, {
		embeddingAdapter: new DeterministicLocalEmbedding(96),
	});
	await engine.query({ text: 'warmup absent marker', scope: { mode: 'default' } });
	const startedAt = performance.now();
	const pack = await engine.query(
		{ text: 'warmneedle4999', scope: { mode: 'default' } },
		{ deadlineMs: 5_000, limit: 5 },
	);
	const elapsed = performance.now() - startedAt;
	assert.equal(pack.status, 'ok');
	assert.equal(pack.evidence[0]?.recordId, `scale-${size - 1}`);
	assert.ok(elapsed < 5_000, `warm synthetic query took ${elapsed.toFixed(1)} ms`);
	assert.ok(pack.elapsedMs < 5_000);
});
