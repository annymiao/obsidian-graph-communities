export const COMPILED_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const COMPACT_LEXICAL_SCHEMA_VERSION = 1 as const;

export interface CatalogEntry {
	sourceId: string;
	projectId: string | null;
	path: string;
	documentId: string;
	ordinal: number;
	contentSha256: string;
	normalizedContentSha256: string;
	byteLength: number;
	mtimeMs: number;
	firstSeenAt: string;
	lastSeenAt: string;
	tombstoneAt: string | null;
	duplicateOfDocumentId: string | null;
	corpus: 'core' | 'project' | 'reference' | 'history' | 'control' | 'generated';
	retrievalScope: 'default' | 'project' | 'reference' | 'history' | 'never';
}

export interface SourceCatalog {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	sourceId: string;
	policyHash: string;
	nextOrdinal: number;
	entries: CatalogEntry[];
}

export interface CompiledChunkArtifact {
	chunkId: string;
	spanId: string;
	heading: string | null;
	startLine: number;
	endLine: number;
	startColumn: number | null;
	endColumn: number | null;
	content: string;
	termFrequencies: Array<[term: string, frequency: number]>;
	tokenCount: number;
}

export interface DerivedDocumentArtifact {
	sourceId: string;
	projectId: string | null;
	path: string;
	documentId: string;
	versionId: string;
	ordinal: number;
	contentSha256: string;
	normalizedContentSha256: string;
	byteLength: number;
	title: string;
	aliases: string[];
	tags: string[];
	links: string[];
	corpus: CatalogEntry['corpus'];
	retrievalScope: CatalogEntry['retrievalScope'];
	mtimeMs: number;
	modifiedAt: string;
	headings: Array<{ text: string; level: number; line: number; parent: string | null }>;
	chunks: CompiledChunkArtifact[];
}

export interface DerivedArtifacts {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	documents: DerivedDocumentArtifact[];
}

/**
 * A compact immutable posting table. Integer streams use unsigned LEB128 and
 * are base64 encoded so the whole artifact remains portable JSON.
 */
export interface CompactPostingIndex {
	schemaVersion: typeof COMPACT_LEXICAL_SCHEMA_VERSION;
	dictionary: string[];
	postingOffsets: number[];
	postingsBase64: string;
	documentLengthsBase64: string;
	documentCount: number;
	averageDocumentLength: number;
}

export interface CompactLexicalDelta {
	createdAt: string;
	replaceOrdinalsBase64: string;
	index: CompactPostingIndex;
}

/**
 * Chunk identities are kept beside their compact ordinal index so an online
 * retriever can prove that every posting belongs to the exact compiled chunk
 * version it is about to serve.
 */
export interface CompactChunkLexicalArtifact {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	records: Array<{
		recordId: string;
		versionId: string;
	}>;
	index: CompactPostingIndex;
}

export interface CompactLexicalArtifact {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	base: CompactPostingIndex;
	deltas: CompactLexicalDelta[];
	/** Required by the compiled second-brain runtime; legacy generations must be recompiled. */
	chunkIndex: CompactChunkLexicalArtifact;
}

export interface TemporalArtifact {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	byOrdinal: Array<{
		ordinal: number;
		mtimeMs: number;
		firstSeenAt: string;
		lastSeenAt: string;
	}>;
}

export interface HierarchyArtifact {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	byOrdinal: Array<{
		ordinal: number;
		pathSegments: string[];
		headings: Array<{ text: string; level: number; line: number; parent: string | null }>;
	}>;
}

export interface VectorArtifact {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	adapterId: string;
	modelId: string;
	embeddingKind: 'lexical_hash' | 'semantic';
	inputRecipe: 'hybrid-record-search-text-v1';
	dimension: number;
	entries: Array<{
		recordId: string;
		versionId: string;
		values: number[];
	}>;
}

export interface ArtifactLayer<T> {
	sha256: string;
	byteLength: number;
	data: T;
}

export interface CompiledArtifactBundle {
	schemaVersion: typeof COMPILED_ARTIFACT_SCHEMA_VERSION;
	compilerVersion: string;
	createdAt: string;
	policyHash: string;
	layers: {
		catalog: ArtifactLayer<SourceCatalog>;
		lexical: ArtifactLayer<CompactLexicalArtifact>;
		derived: ArtifactLayer<DerivedArtifacts>;
		temporal: ArtifactLayer<TemporalArtifact>;
		hierarchy: ArtifactLayer<HierarchyArtifact>;
		vector: ArtifactLayer<VectorArtifact> | null;
	};
	statistics: {
		activeDocuments: number;
		tombstones: number;
		duplicates: number;
		lexicalSegments: number;
	};
}
