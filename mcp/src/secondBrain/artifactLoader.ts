import { ArtifactGenerationStore, type PublishedArtifactGeneration } from '../persistence/artifactGenerationStore.js';
import {
	COMPILED_ARTIFACT_SCHEMA_VERSION,
	type CompactChunkLexicalArtifact,
	type DerivedDocumentArtifact,
} from '../persistence/artifactTypes.js';
import { decodeCompactPostingIndex, materializeLexicalArtifact } from '../persistence/compactLexical.js';
import {
	EMBEDDING_INPUT_RECIPE,
	type EmbeddingAdapter,
	type VectorArtifact as QueryVectorArtifact,
} from '../hybrid/embedding.js';
import { countTokens } from '../hybrid/text.js';
import type { Bm25Artifact, HybridRecord, HybridRetrievalScope } from '../hybrid/types.js';
import {
	createChunkId,
	createDocumentId,
	createSpanId,
	normalizeDocumentPath,
	type VersionId,
} from '../stableIds.js';
import { canonicalJson } from '../write/integrity.js';
import type { SecondBrainSourceDescriptor } from './types.js';

const SOURCE_ID_PATTERN = /^src_v1_[A-Za-z0-9_-]{43}$/u;
const DOCUMENT_ID_PATTERN = /^doc_v1_[A-Za-z0-9_-]{43}$/u;
const VERSION_ID_PATTERN = /^ver_v1_[A-Za-z0-9_-]{43}$/u;
const CHUNK_ID_PATTERN = /^chk_v1_[A-Za-z0-9_-]{43}$/u;
const SPAN_ID_PATTERN = /^spn_v1_[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RETRIEVAL_SCOPES = new Set<HybridRetrievalScope>([
	'default', 'project', 'reference', 'history', 'never',
]);

export interface LoadedCompiledSource {
	descriptor: SecondBrainSourceDescriptor;
	generation: PublishedArtifactGeneration;
	records: readonly HybridRecord[];
	bm25Artifact: Bm25Artifact;
	vectorArtifact: QueryVectorArtifact | null;
	activeDocuments: number;
}

export async function loadCompiledSource(
	descriptor: SecondBrainSourceDescriptor,
	embeddingAdapter: EmbeddingAdapter,
	requirePrecomputedVectors: boolean,
): Promise<LoadedCompiledSource> {
	validateDescriptor(descriptor);
	const store = new ArtifactGenerationStore(descriptor.generationRoot);
	const generation = descriptor.pinnedGenerationId === undefined
		? await store.readCurrent()
		: await store.readGeneration(descriptor.pinnedGenerationId);
	if (generation === null) throw new Error(`Compiled source ${descriptor.sourceId} has no READY/CURRENT generation.`);
	if (
		descriptor.pinnedManifestSha256 !== undefined
		&& generation.manifestSha256 !== descriptor.pinnedManifestSha256
	) throw new Error(`Compiled source ${descriptor.sourceId} does not match its pinned manifest.`);
	return validateCompiledSourceGeneration(
		descriptor,
		embeddingAdapter,
		requirePrecomputedVectors,
		generation,
	);
}

/** Deep-validates an already loaded generation before compiler reuse or online publication. */
export async function validateCompiledSourceGeneration(
	descriptor: SecondBrainSourceDescriptor,
	embeddingAdapter: EmbeddingAdapter,
	requirePrecomputedVectors: boolean,
	generation: PublishedArtifactGeneration,
): Promise<LoadedCompiledSource> {
	validateDescriptor(descriptor);
	if (
		descriptor.pinnedGenerationId !== undefined
		&& descriptor.pinnedGenerationId !== generation.generationId
	) throw new Error(`Compiled source ${descriptor.sourceId} does not match its pinned generation.`);
	if (
		descriptor.pinnedManifestSha256 !== undefined
		&& descriptor.pinnedManifestSha256 !== generation.manifestSha256
	) throw new Error(`Compiled source ${descriptor.sourceId} does not match its pinned manifest.`);
	const { bundle } = generation;
	if (bundle.schemaVersion !== COMPILED_ARTIFACT_SCHEMA_VERSION) {
		throw new Error(`Compiled source ${descriptor.sourceId} uses an unsupported artifact schema.`);
	}
	for (const layer of [
		bundle.layers.catalog.data,
		bundle.layers.lexical.data,
		bundle.layers.derived.data,
		bundle.layers.temporal.data,
		bundle.layers.hierarchy.data,
	]) {
		if (layer.schemaVersion !== COMPILED_ARTIFACT_SCHEMA_VERSION) {
			throw new Error(`Compiled source ${descriptor.sourceId} has a mismatched layer schema.`);
		}
	}
	if (bundle.layers.catalog.data.sourceId !== descriptor.sourceId) {
		throw new Error(`Compiled source ${descriptor.sourceId} does not match its trusted descriptor.`);
	}
	if (bundle.layers.catalog.data.policyHash !== bundle.policyHash) {
		throw new Error(`Compiled source ${descriptor.sourceId} has inconsistent policy hashes.`);
	}

	const expectedProjectId = descriptor.projectId ?? null;
	const catalogByPath = new Map<string, typeof bundle.layers.catalog.data.entries[number]>();
	const catalogByDocumentId = new Map<string, typeof bundle.layers.catalog.data.entries[number]>();
	const expectedActivePaths = new Set<string>();
	const ordinals = new Set<number>();
	for (const entry of bundle.layers.catalog.data.entries) {
		assertRelativePath(entry.path);
		if (entry.sourceId !== descriptor.sourceId || entry.projectId !== expectedProjectId) {
			throw new Error(`Compiled source ${descriptor.sourceId} contains an entry outside its authorization boundary.`);
		}
		if (expectedProjectId !== null && entry.retrievalScope !== 'project' && entry.retrievalScope !== 'never') {
			throw new Error(`Compiled source ${descriptor.sourceId} weakens its trusted project boundary.`);
		}
		if (
			!DOCUMENT_ID_PATTERN.test(entry.documentId)
			|| entry.documentId !== createDocumentId(descriptor.sourceId, entry.path)
			|| catalogByDocumentId.has(entry.documentId)
			|| !RETRIEVAL_SCOPES.has(entry.retrievalScope)
			|| !SHA256_PATTERN.test(entry.contentSha256)
			|| !SHA256_PATTERN.test(entry.normalizedContentSha256)
			|| !Number.isSafeInteger(entry.byteLength)
			|| entry.byteLength < 0
			|| !Number.isFinite(entry.mtimeMs)
			|| !isIsoTimestamp(entry.firstSeenAt)
			|| !isIsoTimestamp(entry.lastSeenAt)
			|| Date.parse(entry.firstSeenAt) > Date.parse(entry.lastSeenAt)
			|| (entry.tombstoneAt !== null && !isIsoTimestamp(entry.tombstoneAt))
			|| (entry.duplicateOfDocumentId !== null && !DOCUMENT_ID_PATTERN.test(entry.duplicateOfDocumentId))
		) {
			throw new Error(`Compiled source ${descriptor.sourceId} contains a malformed catalog entry.`);
		}
		if (!Number.isSafeInteger(entry.ordinal) || entry.ordinal < 0 || ordinals.has(entry.ordinal)) {
			throw new Error(`Compiled source ${descriptor.sourceId} contains duplicate or invalid ordinals.`);
		}
		if (catalogByPath.has(entry.path)) {
			throw new Error(`Compiled source ${descriptor.sourceId} contains duplicate catalog paths.`);
		}
		catalogByPath.set(entry.path, entry);
		catalogByDocumentId.set(entry.documentId, entry);
		ordinals.add(entry.ordinal);
		if (
			entry.tombstoneAt === null
			&& entry.duplicateOfDocumentId === null
			&& entry.retrievalScope !== 'never'
		) expectedActivePaths.add(entry.path);
	}
	if (
		!Number.isSafeInteger(bundle.layers.catalog.data.nextOrdinal)
		|| bundle.layers.catalog.data.nextOrdinal < 0
		|| [...ordinals].some((ordinal) => ordinal >= bundle.layers.catalog.data.nextOrdinal)
	) throw new Error(`Compiled source ${descriptor.sourceId} has an invalid next catalog ordinal.`);
	for (const entry of catalogByPath.values()) {
		if (entry.duplicateOfDocumentId === null) continue;
		const canonical = catalogByDocumentId.get(entry.duplicateOfDocumentId);
		if (
			!canonical
			|| canonical.duplicateOfDocumentId !== null
			|| canonical.tombstoneAt !== null
			|| canonical.retrievalScope === 'never'
		) throw new Error(`Compiled source ${descriptor.sourceId} has an invalid duplicate reference.`);
	}

	const hierarchyByOrdinal = uniqueOrdinalMap(
		bundle.layers.hierarchy.data.byOrdinal,
		'hierarchy',
		descriptor.sourceId,
	);
	const temporalByOrdinal = uniqueOrdinalMap(
		bundle.layers.temporal.data.byOrdinal,
		'temporal',
		descriptor.sourceId,
	);
	const records: HybridRecord[] = [];
	const expectedLexical = new Map<number, { length: number; frequencies: Map<string, number> }>();
	const expectedChunkLexical = new Map<string, {
		versionId: string;
		length: number;
		frequencies: Array<[string, number]>;
	}>();
	const derivedPaths = new Set<string>();
	const recordIds = new Set<string>();
	for (const document of bundle.layers.derived.data.documents) {
		const catalog = catalogByPath.get(document.path);
		validateDerivedDocument(document, descriptor, catalog);
		if (derivedPaths.has(document.path) || !expectedActivePaths.has(document.path)) {
			throw new Error(`Compiled source ${descriptor.sourceId} has a duplicate or unexpected derived document.`);
		}
		derivedPaths.add(document.path);
		const hierarchy = hierarchyByOrdinal.get(document.ordinal);
		const temporal = temporalByOrdinal.get(document.ordinal);
		if (!hierarchy || !temporal) {
			throw new Error(`Compiled source ${descriptor.sourceId} is missing hierarchy or temporal data.`);
		}
		if (
			hierarchy.pathSegments.join('/') !== document.path
			|| canonicalJson(hierarchy.headings) !== canonicalJson(document.headings)
			|| temporal.mtimeMs !== document.mtimeMs
			|| temporal.firstSeenAt !== catalog?.firstSeenAt
			|| temporal.lastSeenAt !== catalog?.lastSeenAt
		) {
			throw new Error(`Compiled source ${descriptor.sourceId} has misaligned derived layers.`);
		}
		const lexicalDocument = { length: 0, frequencies: new Map<string, number>() };
		for (const chunk of document.chunks) {
			const columnsAreValid = (
				(chunk.startColumn === null && chunk.endColumn === null)
				|| (
					Number.isSafeInteger(chunk.startColumn)
					&& Number.isSafeInteger(chunk.endColumn)
					&& (chunk.startColumn ?? 0) >= 1
					&& (chunk.endColumn ?? 0) >= 1
					&& (chunk.startLine !== chunk.endLine || (chunk.endColumn ?? 0) >= (chunk.startColumn ?? 0))
				)
			);
			const spanMaterial = {
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				...(chunk.startColumn === null ? {} : { startColumn: chunk.startColumn }),
				...(chunk.endColumn === null ? {} : { endColumn: chunk.endColumn }),
			};
			const expectedFrequencies = [...countTokens(chunk.content).entries()]
				.sort(([first], [second]) => first.localeCompare(second));
			const expectedTokenCount = expectedFrequencies.reduce((sum, [, count]) => sum + count, 0);
			if (
				!CHUNK_ID_PATTERN.test(chunk.chunkId)
				|| !SPAN_ID_PATTERN.test(chunk.spanId)
				|| recordIds.has(chunk.chunkId)
				|| typeof chunk.content !== 'string'
				|| chunk.content.length === 0
				|| !Number.isSafeInteger(chunk.startLine)
				|| !Number.isSafeInteger(chunk.endLine)
				|| chunk.startLine < 1
				|| chunk.endLine < chunk.startLine
				|| !columnsAreValid
				|| chunk.spanId !== createSpanId(document.versionId as VersionId, spanMaterial)
				|| chunk.chunkId !== createChunkId(chunk.spanId, chunk.content)
				|| canonicalJson(chunk.termFrequencies) !== canonicalJson(expectedFrequencies)
				|| chunk.tokenCount !== expectedTokenCount
			) {
				throw new Error(`Compiled source ${descriptor.sourceId} contains a malformed chunk.`);
			}
			lexicalDocument.length += expectedTokenCount;
			for (const [term, count] of expectedFrequencies) {
				lexicalDocument.frequencies.set(
					term,
					(lexicalDocument.frequencies.get(term) ?? 0) + count,
				);
			}
			recordIds.add(chunk.chunkId);
			expectedChunkLexical.set(chunk.chunkId, {
				versionId: document.versionId,
				length: Math.max(1, expectedTokenCount),
				frequencies: expectedFrequencies,
			});
			records.push({
				id: chunk.chunkId,
				sourceId: document.sourceId,
				documentId: document.documentId,
				versionId: document.versionId,
				path: document.path,
				title: document.title,
				heading: chunk.heading,
				content: chunk.content,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				corpus: document.corpus,
				retrievalScope: document.retrievalScope,
				...(document.projectId === null ? {} : { projectId: document.projectId }),
				modifiedAt: document.mtimeMs,
				tags: [...document.tags],
				aliases: [...document.aliases],
				hierarchy: hierarchyForChunk(document, chunk.startLine, hierarchy.pathSegments),
				metadata: { links: [...document.links] },
			});
		}
		expectedLexical.set(document.ordinal, lexicalDocument);
	}
	if (!sameStringSet(derivedPaths, expectedActivePaths)) {
		throw new Error(`Compiled source ${descriptor.sourceId} does not cover its active catalog.`);
	}
	const activeOrdinals = new Set(
		bundle.layers.derived.data.documents.map((document) => document.ordinal),
	);
	if (
		hierarchyByOrdinal.size !== activeOrdinals.size
		|| temporalByOrdinal.size !== activeOrdinals.size
		|| [...hierarchyByOrdinal.keys()].some((ordinal) => !activeOrdinals.has(ordinal))
		|| [...temporalByOrdinal.keys()].some((ordinal) => !activeOrdinals.has(ordinal))
	) {
		throw new Error(`Compiled source ${descriptor.sourceId} has hierarchy/temporal ordinal drift.`);
	}
	const lexical = materializeLexicalArtifact(bundle.layers.lexical.data);
	if (
		lexical.documentLengths.size !== activeOrdinals.size
		|| [...lexical.documentLengths.keys()].some((ordinal) => !activeOrdinals.has(ordinal))
	) {
		throw new Error(`Compiled source ${descriptor.sourceId} has a lexical/document-length drift.`);
	}
	for (const posting of lexical.postings.values()) {
		for (const ordinal of posting.keys()) {
			if (!activeOrdinals.has(ordinal)) {
				throw new Error(`Compiled source ${descriptor.sourceId} has an unauthorized lexical ordinal.`);
			}
		}
	}
	for (const [ordinal, expected] of expectedLexical) {
		if (lexical.documentLengths.get(ordinal) !== expected.length) {
			throw new Error(`Compiled source ${descriptor.sourceId} has a lexical length mismatch.`);
		}
		for (const [term, frequency] of expected.frequencies) {
			if (lexical.postings.get(term)?.get(ordinal) !== frequency) {
				throw new Error(`Compiled source ${descriptor.sourceId} has a lexical posting mismatch.`);
			}
		}
	}
	for (const [term, posting] of lexical.postings) {
		for (const [ordinal, frequency] of posting) {
			if (expectedLexical.get(ordinal)?.frequencies.get(term) !== frequency) {
				throw new Error(`Compiled source ${descriptor.sourceId} has an unexpected lexical posting.`);
			}
		}
	}
	const persistedChunkLexical = bundle.layers.lexical.data.chunkIndex;
	if (persistedChunkLexical === undefined) {
		throw new Error(`Compiled source ${descriptor.sourceId} is missing its required chunk lexical index; recompile this source.`);
	}
	const bm25Artifact = validateAndConvertBm25Artifact(
		persistedChunkLexical,
		expectedChunkLexical,
		descriptor.sourceId,
	);
	const expectedTombstones = bundle.layers.catalog.data.entries
		.filter((entry) => entry.tombstoneAt !== null).length;
	const expectedDuplicates = bundle.layers.catalog.data.entries
		.filter((entry) => entry.duplicateOfDocumentId !== null).length;
	if (
		bundle.statistics.activeDocuments !== derivedPaths.size
		|| bundle.statistics.tombstones !== expectedTombstones
		|| bundle.statistics.duplicates !== expectedDuplicates
		|| bundle.statistics.lexicalSegments !== 1 + bundle.layers.lexical.data.deltas.length
	) throw new Error(`Compiled source ${descriptor.sourceId} has inconsistent aggregate statistics.`);

	const persistedVector = bundle.layers.vector?.data ?? null;
	if (records.length > 0 && requirePrecomputedVectors && persistedVector === null) {
		throw new Error(`Compiled source ${descriptor.sourceId} is missing required precomputed vectors.`);
	}
	const vectorArtifact = persistedVector === null
		? null
		: validateAndConvertVectorArtifact(persistedVector, records, embeddingAdapter, descriptor.sourceId);
	if (descriptor.writable !== undefined) {
		const compilerGeneration = descriptor.pinnedGenerationId === undefined
			? await descriptor.writable.compiler.readCurrent()
			: await descriptor.writable.compiler.readGeneration(descriptor.pinnedGenerationId);
		if (compilerGeneration?.generationId !== generation.generationId) {
			throw new Error(`Writable source ${descriptor.sourceId} compiler is bound to a different generation store.`);
		}
	}
	return {
		descriptor,
		generation,
		records,
		bm25Artifact,
		vectorArtifact,
		activeDocuments: derivedPaths.size,
	};
}

function validateAndConvertBm25Artifact(
	artifact: CompactChunkLexicalArtifact,
	expectedByRecordId: ReadonlyMap<string, {
		versionId: string;
		length: number;
		frequencies: Array<[string, number]>;
	}>,
	sourceId: string,
): Bm25Artifact {
	if (
		artifact.schemaVersion !== COMPILED_ARTIFACT_SCHEMA_VERSION
		|| !Array.isArray(artifact.records)
	) throw new Error(`Compiled source ${sourceId} has a malformed chunk lexical artifact.`);
	let materialized: ReturnType<typeof decodeCompactPostingIndex>;
	try {
		materialized = decodeCompactPostingIndex(artifact.index);
	} catch {
		throw new Error(`Compiled source ${sourceId} has a malformed chunk lexical index.`);
	}
	if (
		artifact.index.documentCount !== artifact.records.length
		|| materialized.documentLengths.size !== artifact.records.length
		|| [...materialized.documentLengths.keys()].some((ordinal) => (
			!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= artifact.records.length
		))
	) throw new Error(`Compiled source ${sourceId} has chunk lexical length-table drift.`);

	const termsByOrdinal = new Map<number, Array<[string, number]>>();
	for (const [term, posting] of materialized.postings) {
		if (typeof term !== 'string' || term.length === 0) {
			throw new Error(`Compiled source ${sourceId} has a malformed chunk lexical term.`);
		}
		for (const [ordinal, frequency] of posting) {
			if (
				!Number.isSafeInteger(ordinal)
				|| ordinal < 0
				|| ordinal >= artifact.records.length
				|| !Number.isSafeInteger(frequency)
				|| frequency <= 0
			) throw new Error(`Compiled source ${sourceId} has a malformed chunk lexical posting.`);
			const terms = termsByOrdinal.get(ordinal) ?? [];
			terms.push([term, frequency]);
			termsByOrdinal.set(ordinal, terms);
		}
	}

	const seen = new Set<string>();
	const entries: Bm25Artifact['entries'][number][] = [];
	for (let ordinal = 0; ordinal < artifact.records.length; ordinal += 1) {
		const identity = artifact.records[ordinal];
		if (
			identity === undefined
			|| !CHUNK_ID_PATTERN.test(identity.recordId)
			|| !VERSION_ID_PATTERN.test(identity.versionId)
		) throw new Error(`Compiled source ${sourceId} has a malformed chunk lexical identity.`);
		if (seen.has(identity.recordId)) {
			throw new Error(`Compiled source ${sourceId} has a duplicate chunk lexical record.`);
		}
		seen.add(identity.recordId);
		const expected = expectedByRecordId.get(identity.recordId);
		if (expected === undefined) {
			throw new Error(`Compiled source ${sourceId} has an extra chunk lexical record.`);
		}
		if (identity.versionId !== expected.versionId) {
			throw new Error(`Compiled source ${sourceId} has a stale chunk lexical record.`);
		}
		const documentLength = materialized.documentLengths.get(ordinal);
		const termFrequencies = (termsByOrdinal.get(ordinal) ?? [])
			.sort(([first], [second]) => first.localeCompare(second));
		if (
			documentLength !== expected.length
			|| canonicalJson(termFrequencies) !== canonicalJson(expected.frequencies)
		) throw new Error(`Compiled source ${sourceId} has chunk lexical content drift.`);
		entries.push({
			recordId: identity.recordId,
			versionId: identity.versionId,
			documentLength,
			termFrequencies,
		});
	}
	if (seen.size !== expectedByRecordId.size) {
		throw new Error(`Compiled source ${sourceId} is missing a chunk lexical record.`);
	}
	return { schemaVersion: 1, entries };
}

function validateDescriptor(descriptor: SecondBrainSourceDescriptor): void {
	if (!SOURCE_ID_PATTERN.test(descriptor.sourceId)) throw new TypeError('Second-brain sourceId is invalid.');
	const label = descriptor.label.normalize('NFC').trim();
	if (
		label !== descriptor.label
		|| label.length === 0
		|| label.length > 128
		|| /[\0\r\n/\\]/u.test(label)
	) throw new TypeError('Second-brain source label must be a short logical name, not a path.');
	if (!['directory', 'obsidian-vault'].includes(descriptor.kind)) {
		throw new TypeError('Second-brain source kind is invalid.');
	}
	if (!descriptor.generationRoot || descriptor.generationRoot.includes('\0')) {
		throw new TypeError('Second-brain generationRoot is invalid.');
	}
	if ((descriptor.pinnedGenerationId === undefined) !== (descriptor.pinnedManifestSha256 === undefined)) {
		throw new TypeError('A compiled source generation pin must contain both fields.');
	}
	if (
		descriptor.pinnedGenerationId !== undefined
		&& !/^gen-[0-9]{13}-[a-f0-9]{32}$/u.test(descriptor.pinnedGenerationId)
	) throw new TypeError('Compiled source pinned generationId is invalid.');
	if (
		descriptor.pinnedManifestSha256 !== undefined
		&& !SHA256_PATTERN.test(descriptor.pinnedManifestSha256)
	) throw new TypeError('Compiled source pinned manifest checksum is invalid.');
	if (descriptor.projectId !== undefined) validateLogicalIdentifier(descriptor.projectId, 'projectId');
	if (descriptor.writable !== undefined) {
		if (descriptor.kind !== 'directory') {
			throw new TypeError('Only ordinary directory sources can enable this runtime writer.');
		}
		if (descriptor.writable.adapter.sourceId !== descriptor.sourceId) {
			throw new TypeError('Writable adapter sourceId does not match its descriptor.');
		}
		if (descriptor.writable.compiler.sourceId !== descriptor.sourceId) {
			throw new TypeError('Writable compiler sourceId does not match its descriptor.');
		}
		if ((descriptor.writable.compiler.projectId ?? null) !== (descriptor.projectId ?? null)) {
			throw new TypeError('Writable compiler projectId does not match its descriptor.');
		}
	}
}

function validateDerivedDocument(
	document: DerivedDocumentArtifact,
	descriptor: SecondBrainSourceDescriptor,
	catalog: {
		documentId: string;
		ordinal: number;
		contentSha256: string;
		normalizedContentSha256: string;
		byteLength: number;
		mtimeMs: number;
		projectId: string | null;
		corpus: string;
		retrievalScope: HybridRetrievalScope;
		tombstoneAt: string | null;
		duplicateOfDocumentId: string | null;
	} | undefined,
): void {
	assertRelativePath(document.path);
	if (
		document.sourceId !== descriptor.sourceId
		|| document.projectId !== (descriptor.projectId ?? null)
		|| !DOCUMENT_ID_PATTERN.test(document.documentId)
		|| !VERSION_ID_PATTERN.test(document.versionId)
		|| !RETRIEVAL_SCOPES.has(document.retrievalScope)
		|| document.retrievalScope === 'never'
		|| !catalog
		|| catalog.tombstoneAt !== null
		|| catalog.duplicateOfDocumentId !== null
		|| catalog.documentId !== document.documentId
		|| catalog.ordinal !== document.ordinal
		|| catalog.contentSha256 !== document.contentSha256
		|| catalog.normalizedContentSha256 !== document.normalizedContentSha256
		|| catalog.byteLength !== document.byteLength
		|| catalog.mtimeMs !== document.mtimeMs
		|| catalog.projectId !== document.projectId
		|| catalog.corpus !== document.corpus
		|| catalog.retrievalScope !== document.retrievalScope
	) {
		throw new Error(`Compiled source ${descriptor.sourceId} contains an invalid derived document.`);
	}
	if (
		!Number.isFinite(document.mtimeMs)
		|| document.modifiedAt !== new Date(document.mtimeMs).toISOString()
		|| !Number.isSafeInteger(document.byteLength)
		|| document.byteLength < 0
		|| !SHA256_PATTERN.test(document.contentSha256)
		|| !SHA256_PATTERN.test(document.normalizedContentSha256)
	) {
		throw new Error(`Compiled source ${descriptor.sourceId} contains invalid document time metadata.`);
	}
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return false;
	return new Date(Date.parse(value)).toISOString() === value;
}

function validateAndConvertVectorArtifact(
	artifact: {
		schemaVersion: 1;
		adapterId: string;
		modelId: string;
		embeddingKind: 'lexical_hash' | 'semantic';
		inputRecipe: 'hybrid-record-search-text-v1';
		dimension: number;
		entries: Array<{ recordId: string; versionId: string; values: number[] }>;
	},
	records: readonly HybridRecord[],
	adapter: EmbeddingAdapter,
	sourceId: string,
): QueryVectorArtifact {
	if (
		artifact.schemaVersion !== 1
		|| artifact.adapterId !== adapter.id
		|| artifact.modelId !== adapter.modelId
		|| artifact.embeddingKind !== adapter.kind
		|| artifact.inputRecipe !== EMBEDDING_INPUT_RECIPE
		|| artifact.dimension !== adapter.dimension
	) throw new Error(`Compiled source ${sourceId} vector artifact is incompatible with the selected adapter.`);
	const recordsById = new Map(records.map((record) => [record.id, record]));
	const seen = new Set<string>();
	for (const entry of artifact.entries) {
		const record = recordsById.get(entry.recordId);
		if (
			!record
			|| seen.has(entry.recordId)
			|| record.versionId !== entry.versionId
			|| entry.values.length !== adapter.dimension
			|| !entry.values.every(Number.isFinite)
		) throw new Error(`Compiled source ${sourceId} contains an invalid or stale vector entry.`);
		seen.add(entry.recordId);
	}
	if (seen.size !== records.length) {
		throw new Error(`Compiled source ${sourceId} vector layer does not cover every query record.`);
	}
	return {
		schemaVersion: 1,
		adapterId: artifact.adapterId,
		modelId: artifact.modelId,
		embeddingKind: artifact.embeddingKind,
		inputRecipe: artifact.inputRecipe,
		dimension: artifact.dimension,
		entries: artifact.entries.map((entry) => ({ ...entry, values: [...entry.values] })),
	};
}

function uniqueOrdinalMap<T extends { ordinal: number }>(
	values: readonly T[],
	label: string,
	sourceId: string,
): Map<number, T> {
	const map = new Map<number, T>();
	for (const value of values) {
		if (!Number.isSafeInteger(value.ordinal) || value.ordinal < 0 || map.has(value.ordinal)) {
			throw new Error(`Compiled source ${sourceId} has an invalid ${label} layer.`);
		}
		map.set(value.ordinal, value);
	}
	return map;
}

function hierarchyForChunk(
	document: DerivedDocumentArtifact,
	startLine: number,
	pathSegments: readonly string[],
): string[] {
	const stack: Array<{ text: string; level: number }> = [];
	for (const heading of document.headings) {
		if (heading.line > startLine) break;
		while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
		stack.push({ text: heading.text, level: heading.level });
	}
	return [...pathSegments, ...stack.map((heading) => heading.text)];
}

function assertRelativePath(value: string): void {
	if (normalizeDocumentPath(value) !== value) throw new Error('Compiled document path is not canonical.');
}

function validateLogicalIdentifier(value: string, label: string): void {
	const normalized = value.normalize('NFC').trim();
	if (!normalized || normalized !== value || normalized.length > 256 || normalized.includes('\0')) {
		throw new TypeError(`${label} is invalid.`);
	}
}

function sameStringSet(first: ReadonlySet<string>, second: ReadonlySet<string>): boolean {
	if (first.size !== second.size) return false;
	for (const value of first) if (!second.has(value)) return false;
	return true;
}
