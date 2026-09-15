import type {
	EvidenceScoreComponent,
	HybridRecord,
	HybridRetrievalChannel,
	HybridRetriever,
	RankedCandidate,
	RetrievalHit,
} from './types.js';

export interface RetrieverRanking {
	retriever: HybridRetriever;
	hits: readonly RetrievalHit[];
}

export interface RrfOptions {
	k?: number;
	channelWeights?: Partial<Record<HybridRetrievalChannel, number>>;
	limit?: number;
}

interface MutableCandidate {
	record: HybridRecord;
	fusedScore: number;
	rawScore: number;
	components: EvidenceScoreComponent[];
}

export function reciprocalRankFusion(
	rankings: readonly RetrieverRanking[],
	recordsById: ReadonlyMap<string, HybridRecord>,
	visibleRecordIds: ReadonlySet<string>,
	options: RrfOptions = {},
): RankedCandidate[] {
	const k = options.k ?? 60;
	if (!Number.isFinite(k) || k <= 0) throw new Error('RRF k must be positive.');
	const candidates = new Map<string, MutableCandidate>();
	for (const [rankingIndex, ranking] of rankings.entries()) {
		const seenInRanking = new Set<string>();
		let acceptedRank = 0;
		for (const hit of ranking.hits) {
			if (seenInRanking.has(hit.recordId)) continue;
			seenInRanking.add(hit.recordId);
			if (hit.channel !== ranking.retriever.channel) continue;
			if (!visibleRecordIds.has(hit.recordId)) continue;
			const record = recordsById.get(hit.recordId);
			if (record === undefined || !Number.isFinite(hit.score) || hit.score <= 0) continue;
			acceptedRank += 1;
			const weight = options.channelWeights?.[hit.channel] ?? 1;
			if (!Number.isFinite(weight) || weight <= 0) continue;
			const contribution = weight / (k + acceptedRank);
			const component: EvidenceScoreComponent = {
				// Adapter diagnostics are untrusted. Keep the public trace
				// structural so arbitrary IDs/reasons cannot become a covert
				// content channel around visibility filtering.
				retrieverId: `retriever-${ranking.retriever.channel}-${rankingIndex + 1}`,
				channel: hit.channel,
				rank: acceptedRank,
				rawScore: hit.score,
				rrfContribution: contribution,
				reasons: [`${hit.channel}:ranked`],
			};
			const existing = candidates.get(hit.recordId);
			if (existing === undefined) {
				candidates.set(hit.recordId, {
					record,
					fusedScore: contribution,
					rawScore: hit.score,
					components: [component],
				});
			} else {
				existing.fusedScore += contribution;
				existing.rawScore = Math.max(existing.rawScore, hit.score);
				existing.components.push(component);
			}
		}
	}
	return [...candidates.values()]
		.sort((first, second) => (
			second.fusedScore - first.fusedScore
			|| second.rawScore - first.rawScore
			|| first.record.id.localeCompare(second.record.id)
		))
		.slice(0, options.limit ?? Number.POSITIVE_INFINITY)
		.map((candidate) => ({
			record: candidate.record,
			fusedScore: candidate.fusedScore,
			rawScore: candidate.rawScore,
			components: candidate.components,
		}));
}
