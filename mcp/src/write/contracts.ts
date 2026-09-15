import type { DocumentId, SourceId, VersionId } from '../stableIds.js';

export const CONTROLLED_WRITE_SCHEMA_VERSION = 1 as const;
export const CONTROLLED_WRITE_PROTOCOL_VERSION = 'second-brain-write/v1' as const;

export type WriteOperation = 'create' | 'replace' | 'delete';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface SourceRef {
	adapterId: string;
	sourceId: SourceId;
	documentId: DocumentId;
	documentPath: string;
}

export interface BaseVersion {
	versionId: VersionId;
	contentSha256: string;
	byteLength: number;
}

export interface DocumentSnapshot {
	content: string;
	baseVersion: BaseVersion;
}

export type DiffLineKind = 'context' | 'insert' | 'delete';

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
	oldLine: number | null;
	newLine: number | null;
}

export interface DiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: DiffLine[];
}

export interface StructuredDiff {
	algorithm: 'line-lcs-v1' | 'bounded-replacement-v1';
	beforeSha256: string | null;
	afterSha256: string | null;
	insertedLines: number;
	deletedLines: number;
	hunks: DiffHunk[];
}

export interface RiskAssessment {
	level: RiskLevel;
	reasons: string[];
	requiresHumanApproval: true;
}

export interface ModelActor {
	clientId: string;
	modelProvider?: string;
	modelName?: string;
}

export interface CorrectionProposal {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	proposalId: string;
	proposalHash: string;
	createdAt: string;
	source: SourceRef;
	operation: WriteOperation;
	proposer: ModelActor;
	rationale: string;
	before: DocumentSnapshot | null;
	after: DocumentSnapshot | null;
	diff: StructuredDiff;
	risk: RiskAssessment;
}

export interface WritePlan {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	planId: string;
	planHash: string;
	proposalHash: string;
	plannedAt: string;
	source: SourceRef;
	operation: WriteOperation;
	expectedBase: BaseVersion | null;
	desiredVersion: BaseVersion | null;
	afterContent: string | null;
	diff: StructuredDiff;
	risk: RiskAssessment;
}

export interface ApprovalToken {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	tokenId: string;
	proposalHash: string;
	approvedAt: string;
	expiresAt: string;
	approvedBy: string;
	maximumRisk: RiskLevel;
	signature: string;
}

/** Minimal authority surface accepted by the mutation runtime. It cannot mint approvals. */
export interface ApprovalVerifier {
	verify(token: ApprovalToken, proposalHash: string, risk: RiskLevel): void;
	consume(token: ApprovalToken, proposalHash: string, risk: RiskLevel): Promise<void>;
}

export interface AdapterCommitRequest {
	transactionId: string;
	plan: WritePlan;
}

export interface AdapterCommitResult {
	transactionId: string;
	source: SourceRef;
	operation: WriteOperation;
	previousVersion: BaseVersion | null;
	committedVersion: BaseVersion | null;
	rollbackToken: string;
	committedAt: string;
}

export interface AdapterRollbackRequest {
	transactionId: string;
	originalTransactionId: string;
	source: SourceRef;
	rollbackToken: string;
	expectedCurrentVersion: BaseVersion | null;
}

export interface AdapterRollbackResult {
	transactionId: string;
	source: SourceRef;
	restoredVersion: BaseVersion | null;
	rolledBackAt: string;
}

export interface WritableSourceAdapter {
	readonly adapterId: string;
	readonly sourceId: SourceId;
	readonly supportedOperations: ReadonlySet<WriteOperation>;
	inspect(source: SourceRef): Promise<DocumentSnapshot | null>;
	commit(request: AdapterCommitRequest): Promise<AdapterCommitResult>;
	rollback(request: AdapterRollbackRequest): Promise<AdapterRollbackResult>;
}

export interface ReingestObservation {
	state: 'present' | 'absent';
	versionId: VersionId | null;
	searchable: boolean;
	generationId?: string;
}

export interface ReingestDriver {
	requestReingest(source: SourceRef): Promise<void>;
	observe(source: SourceRef): Promise<ReingestObservation | null>;
}

export interface ReingestOutcome {
	expectedState: 'present' | 'absent';
	observedState: 'present' | 'absent' | 'unknown';
	expectedVersionId: VersionId | null;
	versionId: VersionId | null;
	searchable: boolean;
	timedOut: boolean;
	attempts: number;
	elapsedMs: number;
	generationId?: string;
	error?: string;
}

export interface AuditEvent {
	type:
		| 'write_started'
		| 'write_committed'
		| 'write_degraded'
		| 'write_failed'
		| 'reingest_completed'
		| 'reingest_failed'
		| 'rollback_started'
		| 'rollback_completed'
		| 'rollback_failed';
	transactionId: string;
	proposalHash: string;
	planHash: string;
	tokenId: string;
	source: SourceRef;
	operation: WriteOperation | 'rollback';
	baseVersionId: VersionId | null;
	resultVersionId: VersionId | null;
	detail?: string;
}

export interface AuditEntry extends AuditEvent {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	sequence: number;
	timestamp: string;
	previousHash: string | null;
	entryHash: string;
}

export interface AuditLedger {
	append(event: AuditEvent): Promise<AuditEntry>;
	verify(): Promise<AuditEntry[]>;
}

export interface WriteReceipt {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	receiptId: string;
	receiptHash: string;
	outcome: 'committed' | 'committed_but_degraded';
	degradations: WriteDegradation[];
	transactionId: string;
	proposalHash: string;
	planHash: string;
	tokenId: string;
	source: SourceRef;
	operation: WriteOperation;
	previousVersion: BaseVersion | null;
	committedVersion: BaseVersion | null;
	rollbackToken: string;
	committedAt: string;
	reingest: ReingestOutcome;
	commitAuditHash: string | null;
	reingestAuditHash: string | null;
}

export type WriteDegradation =
	| 'adapter_commit_uncertain'
	| 'adapter_result_unverified'
	| 'commit_audit_failed'
	| 'reingest_failed'
	| 'reingest_audit_failed';

export interface RollbackPlan {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	rollbackId: string;
	rollbackHash: string;
	createdAt: string;
	initiatedBy: ModelActor;
	reason: string;
	receipt: WriteReceipt;
	risk: RiskAssessment;
}

export interface RollbackReceipt {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	receiptId: string;
	receiptHash: string;
	outcome: 'rolled_back' | 'rolled_back_but_degraded';
	degradations: RollbackDegradation[];
	transactionId: string;
	rollbackHash: string;
	tokenId: string;
	source: SourceRef;
	restoredVersion: BaseVersion | null;
	rolledBackAt: string;
	reingest: ReingestOutcome;
	auditHash: string | null;
	reingestAuditHash: string | null;
}

export type RollbackDegradation =
	| 'adapter_result_unverified'
	| 'rollback_audit_failed'
	| 'reingest_failed'
	| 'reingest_audit_failed';

export type WriteCapability =
	| 'proposal.correction'
	| 'proposal.create'
	| 'proposal.delete'
	| 'diff.structured'
	| 'approval.bound-token'
	| 'write.cas'
	| 'write.atomic'
	| 'write.rollback'
	| 'audit.hash-chain'
	| 'reingest.await-searchable';

export interface ModelWriteCapabilities {
	protocolVersion: typeof CONTROLLED_WRITE_PROTOCOL_VERSION;
	client: ModelActor;
	supported: WriteCapability[];
	required: WriteCapability[];
}

export interface WriteCapabilityManifest {
	protocolVersion: typeof CONTROLLED_WRITE_PROTOCOL_VERSION;
	serverId: string;
	supported: WriteCapability[];
	maxProposalBytes: number;
	approvalRequired: true;
}

export interface CapabilityNegotiation {
	accepted: boolean;
	protocolVersion: typeof CONTROLLED_WRITE_PROTOCOL_VERSION;
	common: WriteCapability[];
	missingRequired: WriteCapability[];
	server: WriteCapabilityManifest;
}
