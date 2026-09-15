import type { OfflineKnowledgeCompiler } from '../compiler/offlineKnowledgeCompiler.js';
import type { EmbeddingAdapter } from '../hybrid/embedding.js';
import type {
	EvidencePack,
	HybridEngineOptions,
	HybridQueryOptions,
	HybridRetrievalMode,
	TemporalConstraint,
} from '../hybrid/types.js';
import type { SourceId } from '../stableIds.js';
import type { SafeDirectoryWriterAdapter } from '../adapters/directoryWriter.js';
import type {
	DiffHunk,
	RiskAssessment,
	RollbackReceipt,
	WriteOperation,
	WriteReceipt,
} from '../write/contracts.js';

export type SecondBrainSourceKind = 'directory' | 'obsidian-vault';

export interface WritableDirectoryBinding {
	/** Compiler bound to the same logical source and generation store. */
	compiler: OfflineKnowledgeCompiler;
	/** The only production writer accepted by this reusable local runtime. */
	adapter: SafeDirectoryWriterAdapter;
}

export interface SecondBrainSourceDescriptor {
	sourceId: SourceId;
	/** Logical user-facing label. It must not contain a filesystem locator. */
	label: string;
	kind: SecondBrainSourceKind;
	/** Trusted authorization boundary; never populated from note frontmatter. */
	projectId?: string;
	/** Private local locator. It is never returned by status or review APIs. */
	generationRoot: string;
	/** Optional immutable generation-set pin. Production runtime catalogs always provide both fields. */
	pinnedGenerationId?: string;
	pinnedManifestSha256?: string;
	/** Only ordinary directory sources may opt into controlled writes. */
	writable?: WritableDirectoryBinding;
}

/** Server-created authorization context. Caller query fields can only narrow it. */
export interface SecondBrainPrincipalPolicy {
	principalId: string;
	allowedSourceIds: readonly string[];
	allowedProjectIds?: readonly string[];
	allowedModes: readonly HybridRetrievalMode[];
	includedPathPrefixes?: readonly string[];
	excludedPathPrefixes?: readonly string[];
}

export interface SecondBrainQueryRequest {
	text: string;
	mode: HybridRetrievalMode;
	/** Optional narrowing filters. Unknown or unauthorized IDs never broaden access. */
	sourceIds?: readonly string[];
	projectIds?: readonly string[];
	temporal?: TemporalConstraint;
	seedRecordIds?: readonly string[];
}

export interface HumanApprovalReview {
	schemaVersion: 1;
	preparedId: string;
	action: 'write' | 'rollback';
	/** Hash of every field the human is being asked to approve, including reviewText. */
	bindingHash: string;
	expiresAt: string;
	source: {
		sourceId: string;
		label: string;
		/** Source-relative logical path, never an absolute host path. */
		documentPath: string;
	};
	operation: WriteOperation | 'rollback';
	risk: RiskAssessment;
	/** Deterministic text suitable for an exact local UI review. */
	reviewText: string;
	/** Structured rendering aid; it contains note diff lines but no host paths. */
	diffHunks: readonly DiffHunk[];
}

export type HumanApprovalDecision =
	| {
		approved: true;
		bindingHash: string;
		approvedBy: string;
	}
	| {
		approved: false;
		bindingHash: string;
		reason?: string;
	};

/**
 * Trust boundary implemented by a local, out-of-band human review UI. A model
 * adapter must never implement this interface on its own behalf.
 */
export interface HumanApprovalBroker {
	requestApproval(review: Readonly<HumanApprovalReview>): Promise<HumanApprovalDecision>;
}

export interface SecondBrainRuntimeOptions extends HybridEngineOptions {
	sources: readonly SecondBrainSourceDescriptor[];
	embeddingAdapter: EmbeddingAdapter;
	/** Defaults true; prevents an online startup from embedding the complete corpus. */
	requirePrecomputedVectors?: boolean;
	humanApprovalBroker?: HumanApprovalBroker;
	/** At least 32 bytes. Kept private; callers never receive an ApprovalTokenAuthority. */
	approvalSecret?: string | Uint8Array;
	/** Private persistence for approval replay markers and the audit hash chain. */
	writeStateRoot?: string;
	pendingReviewTtlMs?: number;
	maximumPendingReviews?: number;
	approvalTokenTtlMs?: number;
	allowCriticalWrites?: boolean;
	/** Persists a newly compiled writable-source pin before the in-memory view switches. */
	onGenerationPublished?: (
		sourceId: string,
		generationId: string,
		manifestSha256: string,
		expectedGenerationId: string,
		expectedManifestSha256: string,
	) => Promise<void>;
}

export interface PrepareWriteInput {
	principal: SecondBrainPrincipalPolicy;
	sourceId: string;
	documentPath: string;
	operation: WriteOperation;
	rationale: string;
	afterContent: string | null;
	modelProvider?: string;
	modelName?: string;
}

export interface PrepareRollbackInput {
	principal: SecondBrainPrincipalPolicy;
	receipt: WriteReceipt;
	reason: string;
	modelProvider?: string;
	modelName?: string;
}

export type PreparedWriteReview = HumanApprovalReview & { action: 'write' };
export type PreparedRollbackReview = HumanApprovalReview & { action: 'rollback' };

export interface SecondBrainSourceStatus {
	sourceId: string;
	label: string;
	kind: SecondBrainSourceKind;
	generationId: string;
	compiledAt: string;
	activeDocuments: number;
	records: number;
	projectScoped: boolean;
	writable: boolean;
}

export interface SecondBrainStatus {
	ready: true;
	revision: number;
	sourceCount: number;
	activeDocuments: number;
	records: number;
	vector: {
		adapterId: string;
		modelId: string;
		embeddingKind: EmbeddingAdapter['kind'];
		inputRecipe: 'hybrid-record-search-text-v1';
		dimension: number;
		precomputed: boolean;
	};
	sources: readonly SecondBrainSourceStatus[];
}

/**
 * Safe reusable read surface. The server-created Principal is captured once,
 * so a model/client request has no parameter with which to widen authority.
 */
export interface BoundSecondBrainReadApi {
	query(
		request: SecondBrainQueryRequest,
		options?: HybridQueryOptions,
	): Promise<EvidencePack>;
	status(): SecondBrainStatus;
}

export interface SecondBrainRuntimeApi {
	/** Operator-only: validates and atomically replaces compiled source views. */
	reload(sourceIds?: readonly string[]): Promise<SecondBrainStatus>;
	/** Prefer bindRead() at client boundaries; this raw method trusts its Principal argument. */
	query(
		principal: SecondBrainPrincipalPolicy,
		request: SecondBrainQueryRequest,
		options?: HybridQueryOptions,
	): Promise<EvidencePack>;
	status(principal: SecondBrainPrincipalPolicy): SecondBrainStatus;
	bindRead(principal: SecondBrainPrincipalPolicy): BoundSecondBrainReadApi;
	prepareWrite(input: PrepareWriteInput): Promise<PreparedWriteReview>;
	approveAndCommitWrite(preparedId: string): Promise<WriteReceipt>;
	prepareRollback(input: PrepareRollbackInput): PreparedRollbackReview;
	approveAndRollback(preparedId: string): Promise<RollbackReceipt>;
}
