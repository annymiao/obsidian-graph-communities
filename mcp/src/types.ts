export interface ServerConfig {
	vaultPath: string;
	vaultName: string;
	excludedFolders: Set<string>;
	indexTtlMs: number;
	maxFileCharacters: number;
	maxFiles: number;
	chunkTokens: number;
	chunkOverlapTokens: number;
	defaultContextTokens: number;
	maxSourceTokens: number;
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

export interface KnowledgeMatch {
	path: string;
	title: string;
	heading: string | null;
	confidence: number;
	reasons: string[];
	relationPath: string[];
	snippet: string;
	excerpt: string;
	uri: string;
	chunkId: string;
	startLine: number;
	endLine: number;
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
	lexicalScore: number;
	graphScore: number;
}

export interface KnowledgeContext {
	query: string;
	markdown: string;
	sourcePaths: string[];
	characterCount: number;
	estimatedTokenCount: number;
	truncated: boolean;
}

export interface RelatedNote {
	path: string;
	title: string;
	distance: number;
	reasons: string[];
	uri: string;
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
}

export interface VaultStats {
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
