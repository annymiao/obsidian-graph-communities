import type {
	ChunkId,
	DocumentId,
	SourceId,
	SpanId,
	VersionId,
} from './stableIds.js';
import type { TransmissionReviewMode } from './reviewPolicy.js';

export interface ServerConfig {
	vaultPath: string;
	vaultName: string;
	/** Human-readable logical source name. Never an absolute path. */
	sourceName?: string;
	/** Stable logical connector identity. Defaults to the canonical Vault path. */
	sourceIdentity?: string;
	/** Trusted project identity from local configuration, never from note frontmatter. */
	projectId?: string;
	/** Declared adapter kind. Ordinary Markdown directories remain the default. */
	sourceKind?: 'directory' | 'obsidian-vault';
	/** Explicit local authorization for controlled writes. Defaults to false. */
	writable?: boolean;
	/** Local derived-artifact root. Null/undefined keeps the index memory-only. */
	artifactPath?: string | null;
	excludedFolders: Set<string>;
	/** @deprecated v0.7 validates source metadata before every snapshot reuse. */
	indexTtlMs?: number;
	maxFileCharacters: number;
	maxFiles: number;
	chunkTokens: number;
	chunkOverlapTokens: number;
	defaultContextTokens: number;
	maxSourceTokens: number;
	/** Controls whether MCP content is reviewed before it becomes model-visible. */
	transmissionReviewMode: TransmissionReviewMode;
}

export const RETRIEVAL_MODES = ['default', 'project', 'reference', 'history'] as const;
export type RetrievalMode = typeof RETRIEVAL_MODES[number];

export type KnowledgeCorpus =
	| 'core'
	| 'project'
	| 'reference'
	| 'history'
	| 'control'
	| 'generated';

export type RetrievalScope = 'default' | 'project' | 'reference' | 'history' | 'never';

export interface SearchOptions {
	limit?: number;
	seedPaths?: string[];
	refresh?: boolean;
	mode?: RetrievalMode;
}

export interface ContextOptions extends SearchOptions {
	maxCharacters?: number;
	maxTokens?: number;
}

export interface KnowledgeMatch {
	sourceId: SourceId;
	sourceName: string;
	documentId: DocumentId;
	versionId: VersionId;
	spanId: SpanId;
	path: string;
	title: string;
	heading: string | null;
	confidence: number;
	reasons: string[];
	relationPath: string[];
	snippet: string;
	excerpt: string;
	uri: string;
	chunkId: ChunkId;
	startLine: number;
	endLine: number;
	startColumn?: number;
	endColumn?: number;
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
	lexicalScore: number;
	graphScore: number;
}

export interface KnowledgeContext {
	query: string;
	markdown: string;
	sourcePaths: string[];
	sourceReferences: KnowledgeSourceReference[];
	sourceFailures: KnowledgeSourceFailure[];
	characterCount: number;
	estimatedTokenCount: number;
	truncated: boolean;
}

export interface RelatedNote {
	sourceId: SourceId;
	sourceName: string;
	documentId: DocumentId;
	versionId: VersionId;
	path: string;
	title: string;
	distance: number;
	reasons: string[];
	uri: string;
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
}

export interface KnowledgeNote {
	sourceId: SourceId;
	sourceName: string;
	documentId: DocumentId;
	versionId: VersionId;
	path: string;
	title: string;
	content: string;
	uri: string;
}

export type KnowledgeSourceOperation =
	| 'search'
	| 'context'
	| 'overview'
	| 'read_note'
	| 'related_notes';

export interface KnowledgeSourceFailure {
	sourceId: SourceId;
	sourceName: string;
	operation: KnowledgeSourceOperation;
	code: 'source_unavailable';
	message: string;
}

export interface KnowledgeSourceReference {
	sourceId: SourceId;
	sourceName: string;
	path: string;
}

export interface KnowledgeSourceFailureSummary {
	sourceName: string;
	code: 'source_unavailable';
	message: string;
}

export interface KnowledgeSearchResult {
	matches: KnowledgeMatch[];
	sourceFailures: KnowledgeSourceFailure[];
}

export interface VaultStats {
	sourceId: SourceId;
	indexGenerationId: string | null;
	indexOrigin: 'rebuilt' | 'persistent';
	persistenceStatus: 'disabled' | 'loaded' | 'published' | 'repaired' | 'degraded';
	vaultName: string;
	noteCount: number;
	linkCount: number;
	lastIndexedAt: string;
	discoveredNoteCount: number;
	indexedNoteCount: number;
	defaultNoteCount: number;
	chunkCount: number;
	excludedNoteCount: number;
	duplicateNoteCount: number;
	truncatedNoteCount: number;
	unreadableNoteCount: number;
	maxFilesReached: boolean;
	countsByCorpus: Record<KnowledgeCorpus, number>;
	countsByRetrievalScope: Record<RetrievalScope, number>;
	excludedByReason: Record<string, number>;
}

export interface FederatedVaultStats {
	kind: 'federated';
	sourceNames: string[];
	sourceCount: number;
	availableSourceCount: number;
	failedSourceCount: number;
	indexOrigin: 'federated';
	persistenceStatus: VaultStats['persistenceStatus'];
	vaultName: 'Federated knowledge';
	noteCount: number;
	linkCount: number;
	lastIndexedAt: string;
	discoveredNoteCount: number;
	indexedNoteCount: number;
	defaultNoteCount: number;
	chunkCount: number;
	excludedNoteCount: number;
	duplicateNoteCount: number;
	truncatedNoteCount: number;
	unreadableNoteCount: number;
	maxFilesReached: boolean;
	countsByCorpus: Record<KnowledgeCorpus, number>;
	countsByRetrievalScope: Record<RetrievalScope, number>;
	excludedByReason: Record<string, number>;
	sourceFailures: KnowledgeSourceFailureSummary[];
}

export type KnowledgeOverview = VaultStats | FederatedVaultStats;

export interface KnowledgeAccess {
	search(query: string, options?: SearchOptions): Promise<KnowledgeMatch[]>;
	searchWithDiagnostics(
		query: string,
		options?: SearchOptions,
	): Promise<KnowledgeSearchResult>;
	getContext(query: string, options?: ContextOptions): Promise<KnowledgeContext>;
	readNote(
		notePath: string,
		heading?: string,
		maxCharacters?: number,
		mode?: RetrievalMode,
		sourceId?: string,
	): Promise<KnowledgeNote>;
	getRelatedNotes(
		notePath: string,
		depth?: number,
		limit?: number,
		mode?: RetrievalMode,
		sourceId?: string,
	): Promise<RelatedNote[]>;
	getStats(refresh?: boolean, mode?: RetrievalMode): Promise<KnowledgeOverview>;
}
