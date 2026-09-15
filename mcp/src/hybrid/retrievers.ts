import {
	DeterministicLocalEmbedding,
	EmbeddingAdapter,
	ExactVectorIndex,
	recordSearchText,
	VectorArtifact,
} from './embedding.js';
import { countTokens, normalizeText, throwIfCancelled, tokenize, uniqueTokens } from './text.js';
import type {
	Bm25RetrieverContract,
	DenseRetrieverContract,
	HierarchyRetrieverContract,
	HybridRecord,
	MetadataRetrieverContract,
	RetrievalContext,
	RetrievalHit,
	TemporalConstraint,
	TemporalRetrieverContract,
} from './types.js';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function orderedHits(hits: RetrievalHit[], limit: number): RetrievalHit[] {
	return hits
		.filter((hit) => Number.isFinite(hit.score) && hit.score > 0)
		.sort((first, second) => second.score - first.score || first.recordId.localeCompare(second.recordId))
		.slice(0, Math.max(0, limit));
}

export class Bm25Retriever implements Bm25RetrieverContract {
	readonly id: string;
	readonly channel = 'bm25' as const;
	readonly #postings = new Map<string, Map<string, number>>();
	readonly #lengths = new Map<string, number>();

	constructor(records: readonly HybridRecord[], id = 'bm25-v1') {
		this.id = id;
		for (const record of records) {
			const frequencies = countTokens(record.content);
			let length = 0;
			for (const [term, count] of frequencies) {
				length += count;
				let posting = this.#postings.get(term);
				if (posting === undefined) {
					posting = new Map();
					this.#postings.set(term, posting);
				}
				posting.set(record.id, count);
			}
			this.#lengths.set(record.id, Math.max(1, length));
		}
	}

	async retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]> {
		throwIfCancelled(context.signal, context.deadlineAt);
		const queryTerms = [...new Set(tokenize(context.query.text))];
		if (queryTerms.length === 0 || context.records.length === 0) return [];
		const visibleCount = context.visibleRecordIds.size;
		if (visibleCount === 0) return [];
		let visibleTotalLength = 0;
		let visibleInspected = 0;
		for (const record of context.records) {
			if ((visibleInspected += 1) % 256 === 0) {
				throwIfCancelled(context.signal, context.deadlineAt);
			}
			visibleTotalLength += this.#lengths.get(record.id) ?? 1;
		}
		const visibleAverageLength = Math.max(1, visibleTotalLength / visibleCount);
		const scores = new Map<string, { score: number; reasons: string[] }>();
		for (const term of queryTerms) {
			throwIfCancelled(context.signal, context.deadlineAt);
			const posting = this.#postings.get(term);
			if (posting === undefined) continue;
			let visibleDocumentFrequency = 0;
			let inspected = 0;
			for (const recordId of posting.keys()) {
				if ((inspected += 1) % 256 === 0) throwIfCancelled(context.signal, context.deadlineAt);
				if (context.visibleRecordIds.has(recordId)) visibleDocumentFrequency += 1;
			}
			if (visibleDocumentFrequency === 0) continue;
			const inverseDocumentFrequency = Math.log(
				1 + (visibleCount - visibleDocumentFrequency + 0.5) / (visibleDocumentFrequency + 0.5),
			);
			inspected = 0;
			for (const [recordId, frequency] of posting) {
				if ((inspected += 1) % 256 === 0) throwIfCancelled(context.signal, context.deadlineAt);
				if (!context.visibleRecordIds.has(recordId)) continue;
				const documentLength = this.#lengths.get(recordId) ?? 1;
				const denominator = frequency + BM25_K1 * (
					1 - BM25_B + BM25_B * documentLength / visibleAverageLength
				);
				const contribution = inverseDocumentFrequency * frequency * (BM25_K1 + 1) / denominator;
				const accumulator = scores.get(recordId) ?? { score: 0, reasons: [] };
				accumulator.score += contribution;
				accumulator.reasons.push(`content:${term}`);
				scores.set(recordId, accumulator);
			}
		}
		const hits = [...scores].map(([recordId, value]) => ({
			recordId,
			channel: this.channel,
			score: value.score,
			reasons: value.reasons,
		}));
		return orderedHits(hits, context.limit);
	}
}

export interface DenseRetrieverOptions {
	id?: string;
	minimumScore?: number;
}

export class DenseRetriever implements DenseRetrieverContract {
	readonly id: string;
	readonly channel = 'dense' as const;
	readonly #index: ExactVectorIndex;
	readonly #minimumScore: number;
	readonly #requiresTokenOverlap: boolean;
	readonly #tokensByRecordId = new Map<string, ReadonlySet<string>>();

	private constructor(
		records: readonly HybridRecord[],
		index: ExactVectorIndex,
		options: DenseRetrieverOptions,
	) {
		this.#index = index;
		this.id = options.id ?? `dense-${index.adapter.id}`;
		this.#minimumScore = options.minimumScore ?? 0.18;
		if (!Number.isFinite(this.#minimumScore) || this.#minimumScore < -1 || this.#minimumScore > 1) {
			throw new Error('Dense minimumScore must be between -1 and 1.');
		}
		this.#requiresTokenOverlap = index.adapter.kind === 'lexical_hash';
		if (this.#requiresTokenOverlap) {
			for (const record of records) {
				this.#tokensByRecordId.set(record.id, uniqueTokens(recordSearchText(record)));
			}
		}
	}

	static async create(
		records: readonly HybridRecord[],
		request: { signal: AbortSignal; deadlineAt: number },
		adapter: EmbeddingAdapter = new DeterministicLocalEmbedding(),
		options: DenseRetrieverOptions = {},
	): Promise<DenseRetriever> {
		const index = await ExactVectorIndex.build(records, adapter, request);
		return new DenseRetriever(records, index, options);
	}

	static fromArtifact(
		records: readonly HybridRecord[],
		adapter: EmbeddingAdapter,
		artifact: VectorArtifact,
		options: DenseRetrieverOptions = {},
	): DenseRetriever {
		return new DenseRetriever(
			records,
			ExactVectorIndex.fromArtifact(records, adapter, artifact),
			options,
		);
	}

	async retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]> {
		const results = await this.#index.search(
			context.query.text,
			context.limit,
			context.visibleRecordIds,
			{ signal: context.signal, deadlineAt: context.deadlineAt },
		);
		const queryTokens = this.#requiresTokenOverlap ? uniqueTokens(context.query.text) : null;
		return results
			.filter((result) => {
				if (result.score < this.#minimumScore) return false;
				if (queryTokens === null) return true;
				const recordTokens = this.#tokensByRecordId.get(result.recordId);
				if (recordTokens === undefined) return false;
				for (const token of queryTokens) if (recordTokens.has(token)) return true;
				return false;
			})
			.map((result) => ({
				recordId: result.recordId,
				channel: this.channel,
				score: result.score,
				reasons: [`cosine:${result.score.toFixed(4)}`],
			}));
	}
}

function metadataFields(record: HybridRecord): Array<[string, string, number]> {
	const fields: Array<[string, string, number]> = [
		['title', record.title, 4],
		['path', record.path, 1.5],
		['heading', record.heading ?? '', 2.5],
		['corpus', record.corpus, 1],
	];
	for (const alias of record.aliases ?? []) fields.push(['alias', alias, 3]);
	for (const tag of record.tags ?? []) fields.push(['tag', tag, 3]);
	if (record.projectId !== undefined) fields.push(['project', record.projectId, 2]);
	for (const [key, value] of Object.entries(record.metadata ?? {})) {
		fields.push([`metadata:${key}`, Array.isArray(value) ? value.join(' ') : String(value), 1]);
	}
	return fields;
}

export class MetadataRetriever implements MetadataRetrieverContract {
	readonly id: string;
	readonly channel = 'metadata' as const;
	readonly #postings = new Map<string, Array<{ recordId: string; name: string; weight: number }>>();

	constructor(records: readonly HybridRecord[], id = 'metadata-v1') {
		this.id = id;
		for (const record of records) {
			for (const [name, value, weight] of metadataFields(record)) {
				for (const token of uniqueTokens(value)) {
					let posting = this.#postings.get(token);
					if (posting === undefined) {
						posting = [];
						this.#postings.set(token, posting);
					}
					posting.push({ recordId: record.id, name, weight });
				}
			}
		}
	}

	async retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]> {
		const queryTokens = uniqueTokens(context.query.text);
		if (queryTokens.size === 0) return [];
		const scores = new Map<string, { score: number; reasons: Map<string, number> }>();
		for (const token of queryTokens) {
			throwIfCancelled(context.signal, context.deadlineAt);
			let inspected = 0;
			for (const posting of this.#postings.get(token) ?? []) {
				if ((inspected += 1) % 256 === 0) throwIfCancelled(context.signal, context.deadlineAt);
				if (!context.visibleRecordIds.has(posting.recordId)) continue;
				const accumulator = scores.get(posting.recordId) ?? { score: 0, reasons: new Map() };
				accumulator.score += posting.weight / queryTokens.size;
				accumulator.reasons.set(posting.name, (accumulator.reasons.get(posting.name) ?? 0) + 1);
				scores.set(posting.recordId, accumulator);
			}
		}
		const hits: RetrievalHit[] = [...scores].map(([recordId, value]) => ({
			recordId,
			channel: this.channel,
			score: value.score,
			reasons: [...value.reasons].map(([name, matches]) => `${name}:${matches}`),
		}));
		return orderedHits(hits, context.limit);
	}
}

function inferredTemporalConstraint(queryText: string): TemporalConstraint | undefined {
	const normalized = normalizeText(queryText);
	if (/(?:\blatest\b|\brecent\b|\bnewest\b|最新|最近|近期)/u.test(normalized)) {
		return { preferRecent: true };
	}
	return undefined;
}

export class TemporalRetriever implements TemporalRetrieverContract {
	readonly id: string;
	readonly channel = 'temporal' as const;
	readonly #orderedRecords: readonly HybridRecord[];

	constructor(records: readonly HybridRecord[], id = 'temporal-v1') {
		this.id = id;
		this.#orderedRecords = records
			.filter((record) => record.modifiedAt !== undefined)
			.sort((first, second) => (second.modifiedAt ?? 0) - (first.modifiedAt ?? 0));
	}

	async retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]> {
		const constraint = context.query.temporal ?? inferredTemporalConstraint(context.query.text);
		if (constraint === undefined) return [];
		if (constraint.after !== undefined && constraint.before !== undefined && constraint.after > constraint.before) {
			return [];
		}
		const now = context.query.now ?? Date.now();
		const hits: RetrievalHit[] = [];
		for (const record of this.#orderedRecords) {
			throwIfCancelled(context.signal, context.deadlineAt);
			if (!context.visibleRecordIds.has(record.id) || record.modifiedAt === undefined) continue;
			if (constraint.after !== undefined && record.modifiedAt < constraint.after) break;
			if (constraint.before !== undefined && record.modifiedAt > constraint.before) continue;
			const ageDays = Math.max(0, now - record.modifiedAt) / 86_400_000;
			const recency = 1 / (1 + ageDays / 30);
			const score = constraint.preferRecent === true ? recency : 1;
			hits.push({
				recordId: record.id,
				channel: this.channel,
				score,
				reasons: [`modified:${new Date(record.modifiedAt).toISOString()}`],
			});
			if (constraint.preferRecent === true && hits.length >= context.limit) break;
		}
		return orderedHits(hits, context.limit);
	}
}

export class HierarchyRetriever implements HierarchyRetrieverContract {
	readonly id: string;
	readonly channel = 'hierarchy' as const;
	readonly #tokenPostings = new Map<string, Set<string>>();
	readonly #prefixPostings = new Map<string, Set<string>>();
	readonly #hierarchies = new Map<string, readonly string[]>();

	constructor(records: readonly HybridRecord[], id = 'hierarchy-v1') {
		this.id = id;
		for (const record of records) {
			const hierarchyText = [
				...(record.hierarchy ?? []),
				record.heading ?? '',
				record.path,
			].join(' ');
			for (const token of uniqueTokens(hierarchyText)) {
				let posting = this.#tokenPostings.get(token);
				if (posting === undefined) {
					posting = new Set();
					this.#tokenPostings.set(token, posting);
				}
				posting.add(record.id);
			}
			const hierarchy = record.hierarchy ?? [];
			this.#hierarchies.set(record.id, hierarchy);
			for (let depth = 1; depth <= hierarchy.length; depth += 1) {
				const prefix = hierarchy.slice(0, depth).map(normalizeText).join('\u0001');
				let posting = this.#prefixPostings.get(prefix);
				if (posting === undefined) {
					posting = new Set();
					this.#prefixPostings.set(prefix, posting);
				}
				posting.add(record.id);
			}
		}
	}

	async retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]> {
		const queryTokens = uniqueTokens(context.query.text);
		const seedIds = new Set(context.query.seedRecordIds ?? []);
		const seedHierarchies = context.records
			.filter((record) => seedIds.has(record.id) && context.visibleRecordIds.has(record.id))
			.map((record) => record.hierarchy ?? []);
		if (queryTokens.size === 0 && seedHierarchies.length === 0) return [];
		const candidateIds = new Set<string>();
		for (const token of queryTokens) {
			let inspected = 0;
			for (const recordId of this.#tokenPostings.get(token) ?? []) {
				if ((inspected += 1) % 256 === 0) throwIfCancelled(context.signal, context.deadlineAt);
				candidateIds.add(recordId);
			}
		}
		for (const hierarchy of seedHierarchies) {
			for (let depth = 1; depth <= hierarchy.length; depth += 1) {
				const prefix = hierarchy.slice(0, depth).map(normalizeText).join('\u0001');
				let inspected = 0;
				for (const recordId of this.#prefixPostings.get(prefix) ?? []) {
					if ((inspected += 1) % 256 === 0) throwIfCancelled(context.signal, context.deadlineAt);
					candidateIds.add(recordId);
				}
			}
		}
		const hits: RetrievalHit[] = [];
		for (const recordId of candidateIds) {
			throwIfCancelled(context.signal, context.deadlineAt);
			if (!context.visibleRecordIds.has(recordId)) continue;
			const tokens = new Set<string>();
			for (const token of queryTokens) {
				if (this.#tokenPostings.get(token)?.has(recordId) === true) tokens.add(token);
			}
			let tokenMatches = 0;
			for (const token of queryTokens) if (tokens.has(token)) tokenMatches += 1;
			let sharedDepth = 0;
			for (const seedHierarchy of seedHierarchies) {
				let depth = 0;
				const hierarchy = this.#hierarchies.get(recordId) ?? [];
				while (depth < seedHierarchy.length && depth < hierarchy.length) {
					if (normalizeText(seedHierarchy[depth] ?? '') !== normalizeText(hierarchy[depth] ?? '')) break;
					depth += 1;
				}
				sharedDepth = Math.max(sharedDepth, depth);
			}
			const termScore = queryTokens.size === 0 ? 0 : tokenMatches / queryTokens.size;
			const score = termScore + sharedDepth * 0.15;
			if (score <= 0) continue;
			const reasons: string[] = [];
			if (tokenMatches > 0) reasons.push(`hierarchy_terms:${tokenMatches}`);
			if (sharedDepth > 0) reasons.push(`shared_ancestor_depth:${sharedDepth}`);
			hits.push({ recordId, channel: this.channel, score, reasons });
		}
		return orderedHits(hits, context.limit);
	}
}

export async function createDefaultRetrievers(
	records: readonly HybridRecord[],
	request: { signal: AbortSignal; deadlineAt: number },
	embeddingAdapter: EmbeddingAdapter = new DeterministicLocalEmbedding(),
	vectorArtifact?: VectorArtifact,
): Promise<readonly [
	Bm25Retriever,
	DenseRetriever,
	MetadataRetriever,
	TemporalRetriever,
	HierarchyRetriever,
]> {
	const dense = vectorArtifact === undefined
		? await DenseRetriever.create(records, request, embeddingAdapter)
		: DenseRetriever.fromArtifact(records, embeddingAdapter, vectorArtifact);
	return [
		new Bm25Retriever(records),
		dense,
		new MetadataRetriever(records),
		new TemporalRetriever(records),
		new HierarchyRetriever(records),
	];
}

export { recordSearchText };
