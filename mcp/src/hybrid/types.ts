export const HYBRID_RETRIEVAL_CHANNELS = [
	'bm25',
	'dense',
	'metadata',
	'temporal',
	'hierarchy',
] as const;

export type HybridRetrievalChannel = typeof HYBRID_RETRIEVAL_CHANNELS[number];

export type HybridRetrievalMode = 'default' | 'project' | 'reference' | 'history';
export type HybridRetrievalScope = HybridRetrievalMode | 'never';

export interface HybridRecord {
	id: string;
	sourceId: string;
	documentId: string;
	versionId: string;
	path: string;
	title: string;
	heading: string | null;
	content: string;
	startLine: number;
	endLine: number;
	corpus: string;
	retrievalScope: HybridRetrievalScope;
	projectId?: string;
	modifiedAt?: number;
	tags?: readonly string[];
	aliases?: readonly string[];
	hierarchy?: readonly string[];
	metadata?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
}

/**
 * The same visibility object is supplied to every retriever and applied again
 * after retrieval. Project-scoped material fails closed unless its project is
 * explicitly allow-listed.
 */
export interface HybridVisibilityScope {
	mode: HybridRetrievalMode;
	allowedSourceIds?: readonly string[];
	allowedProjectIds?: readonly string[];
	includedPathPrefixes?: readonly string[];
	excludedPathPrefixes?: readonly string[];
}

export interface TemporalConstraint {
	after?: number;
	before?: number;
	preferRecent?: boolean;
}

export interface HybridQuery {
	text: string;
	scope: HybridVisibilityScope;
	temporal?: TemporalConstraint;
	seedRecordIds?: readonly string[];
	/** Injectable clock used by deterministic tests and reproducible builds. */
	now?: number;
}

export interface RetrievalContext {
	query: HybridQuery;
	records: readonly HybridRecord[];
	visibleRecordIds: ReadonlySet<string>;
	limit: number;
	deadlineAt: number;
	signal: AbortSignal;
}

export interface RetrievalHit {
	recordId: string;
	channel: HybridRetrievalChannel;
	score: number;
	reasons: readonly string[];
}

export interface HybridRetriever {
	readonly id: string;
	readonly channel: HybridRetrievalChannel;
	retrieve(context: RetrievalContext): Promise<readonly RetrievalHit[]>;
}

export interface Bm25RetrieverContract extends HybridRetriever {
	readonly channel: 'bm25';
}

export interface DenseRetrieverContract extends HybridRetriever {
	readonly channel: 'dense';
}

export interface MetadataRetrieverContract extends HybridRetriever {
	readonly channel: 'metadata';
}

export interface TemporalRetrieverContract extends HybridRetriever {
	readonly channel: 'temporal';
}

export interface HierarchyRetrieverContract extends HybridRetriever {
	readonly channel: 'hierarchy';
}

export interface RankedCandidate {
	record: HybridRecord;
	fusedScore: number;
	rawScore: number;
	components: readonly EvidenceScoreComponent[];
}

export interface RerankerContext {
	query: HybridQuery;
	candidates: readonly RankedCandidate[];
	deadlineAt: number;
	signal: AbortSignal;
}

export interface RerankerResult {
	recordId: string;
	score: number;
	reasons?: readonly string[];
}

export interface RerankerAdapter {
	readonly id: string;
	rerank(context: RerankerContext): Promise<readonly RerankerResult[]>;
}

export interface EvidenceScoreComponent {
	retrieverId: string;
	channel: HybridRetrievalChannel;
	rank: number;
	rawScore: number;
	rrfContribution: number;
	reasons: readonly string[];
}

export interface EvidenceItem {
	recordId: string;
	sourceId: string;
	documentId: string;
	versionId: string;
	path: string;
	title: string;
	heading: string | null;
	startLine: number;
	endLine: number;
	excerpt: string;
	originalCharacterCount: number;
	compressed: boolean;
	fusedScore: number;
	rerankScore: number;
	rerankerReasons: readonly string[];
	components: readonly EvidenceScoreComponent[];
}

export type EvidencePackStatus = 'ok' | 'no_evidence' | 'timeout' | 'source_failure';
export type RetrievalFailureCode = 'timeout' | 'source_failure';

export interface RetrievalFailure {
	retrieverId: string;
	channel: HybridRetrievalChannel | 'reranker';
	code: RetrievalFailureCode;
	message: string;
}

export interface SafeRefusal {
	code: Exclude<EvidencePackStatus, 'ok'>;
	message: string;
}

export interface EvidencePack {
	status: EvidencePackStatus;
	query: string;
	mode: HybridRetrievalMode;
	evidence: readonly EvidenceItem[];
	failures: readonly RetrievalFailure[];
	partial: boolean;
	elapsedMs: number;
	deadlineMs: number;
	refusal?: SafeRefusal;
}

export interface HybridQueryOptions {
	limit?: number;
	candidateLimit?: number;
	deadlineMs?: number;
	evidenceMaxCharacters?: number;
	perEvidenceMaxCharacters?: number;
	rrfK?: number;
	mmrLambda?: number;
	nearDuplicateThreshold?: number;
	signal?: AbortSignal;
}

export interface HybridEngineOptions {
	reranker?: RerankerAdapter;
	channelWeights?: Partial<Record<HybridRetrievalChannel, number>>;
}
