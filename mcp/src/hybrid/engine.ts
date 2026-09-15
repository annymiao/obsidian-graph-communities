import type { EmbeddingAdapter, VectorArtifact } from './embedding.js';
import { DeterministicLocalEmbedding } from './embedding.js';
import {
	extractiveCompress,
	ScoredCandidate,
	selectDiverseCandidates,
} from './compression.js';
import { reciprocalRankFusion, RetrieverRanking } from './fusion.js';
import { createDefaultRetrievers } from './retrievers.js';
import { HybridDeadlineError } from './text.js';
import type {
	EvidenceItem,
	EvidencePack,
	HybridEngineOptions,
	HybridQuery,
	HybridQueryOptions,
	HybridRecord,
	HybridRetriever,
	RankedCandidate,
	RerankerAdapter,
	RetrievalFailure,
} from './types.js';
import { createVisibilityPredicate } from './visibility.js';

const MAXIMUM_QUERY_DEADLINE_MS = 5_000;
const DEFAULT_CANDIDATE_LIMIT = 40;
const DEFAULT_EVIDENCE_LIMIT = 8;
const DEFAULT_PACK_CHARACTERS = 8_000;
const DEFAULT_EVIDENCE_CHARACTERS = 1_500;
const MAXIMUM_CANDIDATES = 200;
const MAXIMUM_EVIDENCE_ITEMS = 50;
const MAXIMUM_PACK_CHARACTERS = 100_000;
const MAXIMUM_EVIDENCE_CHARACTERS = 20_000;
const MAXIMUM_QUERY_CHARACTERS = 32_000;

export interface HybridEngineCreateOptions extends HybridEngineOptions {
	embeddingAdapter?: EmbeddingAdapter;
	vectorArtifact?: VectorArtifact;
}

export class IdentityReranker implements RerankerAdapter {
	readonly id = 'identity-rrf-v1';

	async rerank(context: {
		candidates: readonly RankedCandidate[];
	}): Promise<readonly { recordId: string; score: number; reasons: readonly string[] }[]> {
		return context.candidates.map((candidate) => ({
			recordId: candidate.record.id,
			score: candidate.fusedScore,
			reasons: ['rrf-order'],
		}));
	}
}

interface QueryDeadline {
	controller: AbortController;
	deadlineAt: number;
	deadlineMs: number;
	wasDeadlineReached: () => boolean;
	dispose: () => void;
}

function createDeadline(requestedMs: number | undefined, parentSignal: AbortSignal | undefined): QueryDeadline {
	const raw = requestedMs ?? MAXIMUM_QUERY_DEADLINE_MS;
	if (!Number.isFinite(raw) || raw <= 0) throw new Error('deadlineMs must be positive.');
	const deadlineMs = Math.min(MAXIMUM_QUERY_DEADLINE_MS, Math.max(1, Math.floor(raw)));
	const controller = new AbortController();
	let deadlineReached = false;
	const deadlineAt = Date.now() + deadlineMs;
	const timer = setTimeout(() => {
		deadlineReached = true;
		controller.abort(new HybridDeadlineError());
	}, deadlineMs);
	const abortFromParent = (): void => controller.abort(new HybridDeadlineError('Query was cancelled.'));
	if (parentSignal?.aborted === true) abortFromParent();
	else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
	return {
		controller,
		deadlineAt,
		deadlineMs,
		wasDeadlineReached: () => (
			deadlineReached || parentSignal?.aborted === true || Date.now() >= deadlineAt
		),
		dispose: () => {
			clearTimeout(timer);
			parentSignal?.removeEventListener('abort', abortFromParent);
		},
	};
}

function boundedPositiveInteger(
	value: number | undefined,
	fallback: number,
	maximum: number,
	name: string,
): number {
	const candidate = value ?? fallback;
	if (!Number.isFinite(candidate) || candidate <= 0) throw new Error(`${name} must be positive.`);
	return Math.min(maximum, Math.max(1, Math.floor(candidate)));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new HybridDeadlineError());
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			cleanup();
			reject(new HybridDeadlineError());
		};
		const cleanup = (): void => signal.removeEventListener('abort', abort);
		signal.addEventListener('abort', abort, { once: true });
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function timeoutFailure(retriever: HybridRetriever, index: number): RetrievalFailure {
	return {
		retrieverId: `retriever-${retriever.channel}-${index + 1}`,
		channel: retriever.channel,
		code: 'timeout',
		message: 'Retriever did not finish before the query deadline.',
	};
}

function sourceFailure(retriever: HybridRetriever, index: number): RetrievalFailure {
	return {
		retrieverId: `retriever-${retriever.channel}-${index + 1}`,
		channel: retriever.channel,
		code: 'source_failure',
		message: 'Retriever failed; no source content was exposed in the error.',
	};
}

function refusalPack(
	query: HybridQuery,
	status: 'no_evidence' | 'timeout' | 'source_failure',
	failures: readonly RetrievalFailure[],
	deadlineMs: number,
	startedAt: number,
): EvidencePack {
	const messages = {
		no_evidence: 'No visible, attributable evidence matched the query.',
		timeout: 'Retrieval exceeded its deadline; no evidence was released.',
		source_failure: 'Retrieval sources failed; no evidence was released.',
	} as const;
	return {
		status,
		query: query.text,
		mode: query.scope.mode,
		evidence: [],
		failures,
		partial: false,
		elapsedMs: Date.now() - startedAt,
		deadlineMs,
		refusal: { code: status, message: messages[status] },
	};
}

function validateRecords(records: readonly HybridRecord[]): Map<string, HybridRecord> {
	const map = new Map<string, HybridRecord>();
	for (const record of records) {
		if (record.id.length === 0) throw new Error('Hybrid record IDs cannot be empty.');
		if (map.has(record.id)) throw new Error(`Duplicate hybrid record ID: ${record.id}.`);
		map.set(record.id, record);
	}
	return map;
}

export class HybridQueryEngine {
	readonly #records: readonly HybridRecord[];
	readonly #recordsById: ReadonlyMap<string, HybridRecord>;
	readonly #retrievers: readonly HybridRetriever[];
	readonly #reranker: RerankerAdapter;
	readonly #channelWeights: HybridEngineOptions['channelWeights'];

	constructor(
		records: readonly HybridRecord[],
		retrievers: readonly HybridRetriever[],
		options: HybridEngineOptions = {},
	) {
		this.#records = [...records];
		this.#recordsById = validateRecords(this.#records);
		this.#retrievers = [...retrievers];
		this.#reranker = options.reranker ?? new IdentityReranker();
		this.#channelWeights = options.channelWeights;
	}

	static async create(
		records: readonly HybridRecord[],
		options: HybridEngineCreateOptions = {},
	): Promise<HybridQueryEngine> {
		const controller = new AbortController();
		const adapter = options.embeddingAdapter ?? new DeterministicLocalEmbedding();
		const retrievers = await createDefaultRetrievers(
			records,
			{ signal: controller.signal, deadlineAt: Number.MAX_SAFE_INTEGER },
			adapter,
			options.vectorArtifact,
		);
		const engineOptions: HybridEngineOptions = {};
		if (options.reranker !== undefined) engineOptions.reranker = options.reranker;
		if (options.channelWeights !== undefined) engineOptions.channelWeights = options.channelWeights;
		return new HybridQueryEngine(records, retrievers, engineOptions);
	}

	async query(query: HybridQuery, options: HybridQueryOptions = {}): Promise<EvidencePack> {
		const startedAt = Date.now();
		if (query.text.length > MAXIMUM_QUERY_CHARACTERS) {
			throw new Error(`Query text exceeds ${MAXIMUM_QUERY_CHARACTERS} characters.`);
		}
		const deadline = createDeadline(options.deadlineMs, options.signal);
		const failures: RetrievalFailure[] = [];
		try {
			if (deadline.controller.signal.aborted) {
				return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
			}
			if (query.text.trim().length === 0) {
				return refusalPack(query, 'no_evidence', failures, deadline.deadlineMs, startedAt);
			}
			const isVisible = createVisibilityPredicate(query.scope);
			const visible: HybridRecord[] = [];
			for (let index = 0; index < this.#records.length; index += 1) {
				if (index % 256 === 0 && (
					deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt
				)) {
					return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
				}
				const record = this.#records[index];
				if (record !== undefined && isVisible(record)) visible.push(record);
			}
			const visibleIds = new Set(visible.map((record) => record.id));
			const candidateLimit = boundedPositiveInteger(
				options.candidateLimit,
				DEFAULT_CANDIDATE_LIMIT,
				MAXIMUM_CANDIDATES,
				'candidateLimit',
			);
			const retrievalTasks = this.#retrievers.map(async (retriever, retrieverIndex): Promise<RetrieverRanking | null> => {
				try {
					const hits = await abortable(retriever.retrieve({
						query,
						records: visible,
						visibleRecordIds: visibleIds,
						limit: candidateLimit,
						deadlineAt: deadline.deadlineAt,
						signal: deadline.controller.signal,
					}), deadline.controller.signal);
					return { retriever, hits };
				} catch (error) {
					if (error instanceof HybridDeadlineError || deadline.controller.signal.aborted) {
						failures.push(timeoutFailure(retriever, retrieverIndex));
					} else {
						failures.push(sourceFailure(retriever, retrieverIndex));
					}
					return null;
				}
			});
			const completed = await Promise.all(retrievalTasks);
			if (deadline.wasDeadlineReached()) {
				return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
			}
			const rankings = completed.filter((ranking): ranking is RetrieverRanking => ranking !== null);
			const rrfOptions: Parameters<typeof reciprocalRankFusion>[3] = {
				k: options.rrfK ?? 60,
				limit: candidateLimit,
			};
			if (this.#channelWeights !== undefined) rrfOptions.channelWeights = this.#channelWeights;
			const fused = reciprocalRankFusion(
				rankings,
				this.#recordsById,
				visibleIds,
				rrfOptions,
			);
			if (fused.length === 0) {
				const status = failures.some((failure) => failure.code === 'source_failure')
					? 'source_failure'
					: 'no_evidence';
				return refusalPack(query, status, failures, deadline.deadlineMs, startedAt);
			}

			let rerankerResults: readonly { recordId: string; score: number; reasons?: readonly string[] }[] = [];
			try {
				rerankerResults = await abortable(this.#reranker.rerank({
					query,
					candidates: fused,
					deadlineAt: deadline.deadlineAt,
					signal: deadline.controller.signal,
				}), deadline.controller.signal);
			} catch (error) {
				if (error instanceof HybridDeadlineError || deadline.controller.signal.aborted) {
					failures.push({
						retrieverId: 'reranker',
						channel: 'reranker',
						code: 'timeout',
						message: 'Reranker did not finish before the query deadline.',
					});
					return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
				}
				failures.push({
					retrieverId: 'reranker',
					channel: 'reranker',
					code: 'source_failure',
					message: 'Reranker failed; RRF ordering was used as a safe fallback.',
				});
			}
			const rerankedById = new Map<string, { score: number; reasons: readonly string[] }>();
			for (const result of rerankerResults) {
				if (!visibleIds.has(result.recordId) || !Number.isFinite(result.score)) continue;
				if (rerankedById.has(result.recordId)) continue;
				rerankedById.set(result.recordId, {
					score: result.score,
					reasons: ['reranker:scored'],
				});
			}
			const scored: ScoredCandidate[] = fused.map((candidate) => {
				const result = rerankedById.get(candidate.record.id);
				return {
					...candidate,
					rerankScore: result?.score ?? candidate.fusedScore,
					rerankerReasons: result?.reasons ?? [],
				};
			});
			const evidenceLimit = boundedPositiveInteger(
				options.limit,
				DEFAULT_EVIDENCE_LIMIT,
				MAXIMUM_EVIDENCE_ITEMS,
				'limit',
			);
			const selected = selectDiverseCandidates(scored, {
				limit: evidenceLimit,
				lambda: options.mmrLambda ?? 0.72,
				nearDuplicateThreshold: options.nearDuplicateThreshold ?? 0.92,
				deadline: {
					signal: deadline.controller.signal,
					deadlineAt: deadline.deadlineAt,
				},
			});
			const packLimit = boundedPositiveInteger(
				options.evidenceMaxCharacters,
				DEFAULT_PACK_CHARACTERS,
				MAXIMUM_PACK_CHARACTERS,
				'evidenceMaxCharacters',
			);
			const itemLimit = boundedPositiveInteger(
				options.perEvidenceMaxCharacters,
				DEFAULT_EVIDENCE_CHARACTERS,
				MAXIMUM_EVIDENCE_CHARACTERS,
				'perEvidenceMaxCharacters',
			);
			let remainingCharacters = packLimit;
			const evidence: EvidenceItem[] = [];
			for (const candidate of selected) {
				if (deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt) {
					return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
				}
				if (!isVisible(candidate.record)) continue;
				if (remainingCharacters <= 0) break;
				const excerpt = extractiveCompress(
					candidate.record.content,
					query.text,
					Math.min(itemLimit, remainingCharacters),
					{
						signal: deadline.controller.signal,
						deadlineAt: deadline.deadlineAt,
					},
				);
				if (excerpt.text.length === 0) continue;
				remainingCharacters -= excerpt.text.length;
				evidence.push({
					recordId: candidate.record.id,
					sourceId: candidate.record.sourceId,
					documentId: candidate.record.documentId,
					versionId: candidate.record.versionId,
					path: candidate.record.path,
					title: candidate.record.title,
					heading: candidate.record.heading,
					startLine: candidate.record.startLine,
					endLine: candidate.record.endLine,
					excerpt: excerpt.text,
					originalCharacterCount: excerpt.originalCharacterCount,
					compressed: excerpt.compressed,
					fusedScore: candidate.fusedScore,
					rerankScore: candidate.rerankScore,
					rerankerReasons: candidate.rerankerReasons,
					components: candidate.components,
				});
			}
			if (evidence.length === 0) {
				return refusalPack(query, 'no_evidence', failures, deadline.deadlineMs, startedAt);
			}
			// Never release an apparently successful pack after CPU-bound MMR or
			// compression crossed the hard wall-clock deadline.
			if (deadline.wasDeadlineReached()) {
				return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
			}
			return {
				status: 'ok',
				query: query.text,
				mode: query.scope.mode,
				evidence,
				failures,
				partial: failures.length > 0,
				elapsedMs: Date.now() - startedAt,
				deadlineMs: deadline.deadlineMs,
			};
		} catch (error) {
			if (error instanceof HybridDeadlineError || deadline.wasDeadlineReached()) {
				return refusalPack(query, 'timeout', failures, deadline.deadlineMs, startedAt);
			}
			throw error;
		} finally {
			deadline.dispose();
		}
	}
}
