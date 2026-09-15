import { cosineSimilarity, stableHash32, throwIfCancelled, tokenize } from './text.js';
import type { HybridRecord } from './types.js';

export const EMBEDDING_INPUT_RECIPE = 'hybrid-record-search-text-v1' as const;
const MAXIMUM_SAFE_VECTOR_NORM_SQUARED = Math.sqrt(Number.MAX_VALUE);

export interface EmbeddingRequest {
	signal: AbortSignal;
	deadlineAt: number;
}

export interface EmbeddingAdapter {
	readonly id: string;
	readonly modelId: string;
	readonly kind: 'lexical_hash' | 'semantic';
	readonly dimension: number;
	embed(texts: readonly string[], request: EmbeddingRequest): Promise<readonly (readonly number[])[]>;
}

export interface VectorArtifactEntry {
	recordId: string;
	versionId: string;
	values: readonly number[];
}

export interface VectorArtifact {
	schemaVersion: 1;
	adapterId: string;
	modelId: string;
	embeddingKind: EmbeddingAdapter['kind'];
	inputRecipe: typeof EMBEDDING_INPUT_RECIPE;
	dimension: number;
	entries: readonly VectorArtifactEntry[];
}

/**
 * Dependency-free feature hashing. It is deliberately deterministic and local,
 * making it a safe baseline/fallback rather than a claim of neural semantics.
 */
export class DeterministicLocalEmbedding implements EmbeddingAdapter {
	readonly id = 'deterministic-feature-hash-v1';
	readonly modelId = 'feature-hash-v1';
	readonly kind = 'lexical_hash' as const;
	readonly dimension: number;

	constructor(dimension = 384) {
		if (!Number.isInteger(dimension) || dimension < 32) {
			throw new Error('Embedding dimension must be an integer of at least 32.');
		}
		this.dimension = dimension;
	}

	async embed(
		texts: readonly string[],
		request: EmbeddingRequest,
	): Promise<readonly (readonly number[])[]> {
		const vectors: number[][] = [];
		for (const text of texts) {
			throwIfCancelled(request.signal, request.deadlineAt);
			const vector = Array.from({ length: this.dimension }, () => 0);
			const frequencies = new Map<string, number>();
			for (const token of tokenize(text)) {
				frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
			}
			for (const [token, frequency] of frequencies) {
				const hash = stableHash32(token);
				const index = hash % this.dimension;
				const sign = (stableHash32(token, 2_246_822_519) & 1) === 0 ? 1 : -1;
				vector[index] = (vector[index] ?? 0) + sign * (1 + Math.log(frequency));
			}
			let norm = 0;
			for (const value of vector) norm += value * value;
			if (norm > 0) {
				const divisor = Math.sqrt(norm);
				for (let index = 0; index < vector.length; index += 1) {
					vector[index] = (vector[index] ?? 0) / divisor;
				}
			}
			vectors.push(vector);
		}
		return vectors;
	}
}

export interface LoopbackEmbeddingOptions {
	port: number;
	model: string;
	dimension: number;
	maximumResponseBytes?: number;
}

/**
 * Adapter for an explicitly selected local embedding server. The host and path
 * are intentionally not configurable: requests can only reach
 * http://127.0.0.1:<port>/v1/embeddings and redirects are rejected.
 */
export class LoopbackEmbeddingAdapter implements EmbeddingAdapter {
	readonly id: string;
	readonly modelId: string;
	readonly kind = 'semantic' as const;
	readonly dimension: number;
	readonly #port: number;
	readonly #model: string;
	readonly #maximumResponseBytes: number;

	constructor(options: LoopbackEmbeddingOptions) {
		if (!Number.isInteger(options.port) || options.port < 1_024 || options.port > 65_535) {
			throw new Error('Loopback embedding port must be an integer between 1024 and 65535.');
		}
		if (!Number.isInteger(options.dimension) || options.dimension < 1) {
			throw new Error('Loopback embedding dimension must be a positive integer.');
		}
		if (!/^[\w./:-]{1,160}$/u.test(options.model)) {
			throw new Error('Loopback embedding model identifier is invalid.');
		}
		this.#port = options.port;
		this.#model = options.model;
		this.modelId = options.model;
		this.dimension = options.dimension;
		this.#maximumResponseBytes = options.maximumResponseBytes ?? 32 * 1_024 * 1_024;
		if (!Number.isInteger(this.#maximumResponseBytes) || this.#maximumResponseBytes < 1_024) {
			throw new Error('maximumResponseBytes must be an integer of at least 1024.');
		}
		this.id = `loopback-openai-compatible:${options.model}`;
	}

	async embed(
		texts: readonly string[],
		request: EmbeddingRequest,
	): Promise<readonly (readonly number[])[]> {
		throwIfCancelled(request.signal, request.deadlineAt);
		const response = await fetch(`http://127.0.0.1:${this.#port}/v1/embeddings`, {
			method: 'POST',
			redirect: 'error',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ model: this.#model, input: texts }),
			signal: request.signal,
		});
		if (!response.ok) throw new Error(`Loopback embedding server returned HTTP ${response.status}.`);
		const declaredLengthHeader = response.headers.get('content-length');
		const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
		if (declaredLength !== null && (!Number.isFinite(declaredLength) || declaredLength < 0)) {
			throw new Error('Loopback embedding response had an invalid content length.');
		}
		if (declaredLength !== null && declaredLength > this.#maximumResponseBytes) {
			throw new Error('Loopback embedding response exceeded the configured byte limit.');
		}
		const payloadBytes = await readBoundedBody(response, this.#maximumResponseBytes);
		throwIfCancelled(request.signal, request.deadlineAt);
		const payload: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
		const vectors = parseLoopbackResponse(payload, texts.length, this.dimension);
		return vectors;
	}
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Uint8Array> {
	if (response.body === null) throw new Error('Loopback embedding response had no body.');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value === undefined) continue;
		total += value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error('Loopback embedding response exceeded the configured byte limit.');
		}
		chunks.push(value);
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
}

function parseLoopbackResponse(
	payload: unknown,
	expectedCount: number,
	expectedDimension: number,
): readonly (readonly number[])[] {
	if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
		throw new Error('Loopback embedding response did not contain a data array.');
	}
	const data = (payload as { data?: unknown }).data;
	if (!Array.isArray(data) || data.length !== expectedCount) {
		throw new Error('Loopback embedding response count did not match the request.');
	}
	const indexed = new Map<number, readonly number[]>();
	for (const item of data) {
		if (typeof item !== 'object' || item === null) throw new Error('Invalid embedding response item.');
		const { index, embedding } = item as { index?: unknown; embedding?: unknown };
		if (!Number.isInteger(index) || typeof index !== 'number' || !Array.isArray(embedding)) {
			throw new Error('Invalid embedding response item.');
		}
		if (index < 0 || index >= expectedCount || indexed.has(index)) {
			throw new Error('Invalid or duplicate embedding response index.');
		}
		if (!isSafeVector(embedding, expectedDimension)) {
			throw new Error('Embedding response vector was malformed.');
		}
		indexed.set(index, embedding as number[]);
	}
	return Array.from({ length: expectedCount }, (_, index) => {
		const vector = indexed.get(index);
		if (vector === undefined) throw new Error('Embedding response omitted an input index.');
		return vector;
	});
}

interface VectorEntry {
	recordId: string;
	versionId: string;
	vector: readonly number[];
}

export interface VectorSearchResult {
	recordId: string;
	score: number;
}

/** Exact cosine scan: predictable for small local corpora and a safe fallback. */
export class ExactVectorIndex {
	readonly adapter: EmbeddingAdapter;
	readonly size: number;
	readonly #entries: readonly VectorEntry[];

	private constructor(adapter: EmbeddingAdapter, entries: readonly VectorEntry[]) {
		this.adapter = adapter;
		this.#entries = entries;
		this.size = entries.length;
	}

	static async build(
		records: readonly HybridRecord[],
		adapter: EmbeddingAdapter,
		request: EmbeddingRequest,
	): Promise<ExactVectorIndex> {
		const texts = records.map((record) => recordSearchText(record));
		const vectors = await adapter.embed(texts, request);
		if (vectors.length !== records.length) {
			throw new Error(`Embedding adapter returned ${vectors.length} vectors for ${records.length} records.`);
		}
		const entries: VectorEntry[] = [];
		for (let index = 0; index < records.length; index += 1) {
			const record = records[index];
			const vector = vectors[index];
			if (record === undefined || vector === undefined) continue;
			if (!isSafeVector(vector, adapter.dimension)) {
				throw new Error(`Embedding adapter returned dimension ${vector.length}; expected ${adapter.dimension}.`);
			}
			entries.push({ recordId: record.id, versionId: record.versionId, vector: [...vector] });
		}
		return new ExactVectorIndex(adapter, entries);
	}

	static fromArtifact(
		records: readonly HybridRecord[],
		adapter: EmbeddingAdapter,
		artifact: VectorArtifact,
	): ExactVectorIndex {
		if (artifact.schemaVersion !== 1) throw new Error('Unsupported vector artifact schema.');
		if (
			artifact.adapterId !== adapter.id
			|| artifact.modelId !== adapter.modelId
			|| artifact.embeddingKind !== adapter.kind
			|| artifact.inputRecipe !== EMBEDDING_INPUT_RECIPE
			|| artifact.dimension !== adapter.dimension
		) {
			throw new Error('Vector artifact is incompatible with the selected embedding adapter.');
		}
		const recordsById = new Map(records.map((record) => [record.id, record]));
		const seen = new Set<string>();
		const entries: VectorEntry[] = [];
		for (const entry of artifact.entries) {
			const record = recordsById.get(entry.recordId);
			if (record === undefined) continue;
			if (seen.has(entry.recordId)) throw new Error(`Duplicate vector artifact record: ${entry.recordId}.`);
			if (entry.versionId !== record.versionId) {
				throw new Error(`Stale vector artifact entry: ${entry.recordId}.`);
			}
			if (!isSafeVector(entry.values, adapter.dimension)) {
				throw new Error(`Malformed vector artifact entry: ${entry.recordId}.`);
			}
			seen.add(entry.recordId);
			entries.push({ recordId: entry.recordId, versionId: entry.versionId, vector: [...entry.values] });
		}
		return new ExactVectorIndex(adapter, entries);
	}

	toArtifact(): VectorArtifact {
		return {
			schemaVersion: 1,
			adapterId: this.adapter.id,
			modelId: this.adapter.modelId,
			embeddingKind: this.adapter.kind,
			inputRecipe: EMBEDDING_INPUT_RECIPE,
			dimension: this.adapter.dimension,
			entries: this.#entries.map((entry) => ({
				recordId: entry.recordId,
				versionId: entry.versionId,
				values: [...entry.vector],
			})),
		};
	}

	async search(
		query: string,
		limit: number,
		visibleRecordIds: ReadonlySet<string>,
		request: EmbeddingRequest,
	): Promise<VectorSearchResult[]> {
		const [queryVector] = await this.adapter.embed([query], request);
		if (queryVector === undefined) return [];
		if (!isSafeVector(queryVector, this.adapter.dimension)) {
			throw new Error('Embedding adapter returned a malformed query vector.');
		}
		const results: VectorSearchResult[] = [];
		for (const entry of this.#entries) {
			throwIfCancelled(request.signal, request.deadlineAt);
			if (!visibleRecordIds.has(entry.recordId)) continue;
			const score = cosineSimilarity(queryVector, entry.vector);
			if (!Number.isFinite(score) || Math.abs(score) > 1 + 1e-12) {
				throw new Error('Dense vector score was numerically unsafe.');
			}
			results.push({ recordId: entry.recordId, score: Math.max(-1, Math.min(1, score)) });
		}
		return results
			.filter((result) => Number.isFinite(result.score))
			.sort((first, second) => second.score - first.score || first.recordId.localeCompare(second.recordId))
			.slice(0, Math.max(0, limit));
	}
}

function isSafeVector(value: readonly unknown[], expectedDimension: number): boolean {
	if (value.length !== expectedDimension) return false;
	let normSquared = 0;
	for (const component of value) {
		if (typeof component !== 'number' || !Number.isFinite(component)) return false;
		normSquared += component * component;
		if (!Number.isFinite(normSquared) || normSquared > MAXIMUM_SAFE_VECTOR_NORM_SQUARED) return false;
	}
	return true;
}

export function recordSearchText(record: HybridRecord): string {
	return [
		record.title,
		record.heading ?? '',
		...(record.aliases ?? []),
		...(record.tags ?? []),
		...(record.hierarchy ?? []),
		record.content,
	].join('\n');
}
