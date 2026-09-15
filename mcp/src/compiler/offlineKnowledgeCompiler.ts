import path from 'node:path';
import { chunkMarkdown, parseMarkdownHeadings } from '../markdownChunks.js';
import {
	EMBEDDING_INPUT_RECIPE,
	recordSearchText,
	type EmbeddingAdapter,
} from '../hybrid/embedding.js';
import { countTokens } from '../hybrid/text.js';
import {
	COMPILED_ARTIFACT_SCHEMA_VERSION,
	type CatalogEntry,
	type CompactLexicalArtifact,
	type DerivedDocumentArtifact,
	type HierarchyArtifact,
	type SourceCatalog,
	type TemporalArtifact,
	type VectorArtifact,
} from '../persistence/artifactTypes.js';
import {
	ArtifactGenerationStore,
	type PublishedArtifactGeneration,
} from '../persistence/artifactGenerationStore.js';
import {
	BuildStateStore,
	createBuildId,
	type CompilerCheckpoint,
} from '../persistence/buildStateStore.js';
import { hashCanonicalJson } from '../persistence/canonicalJson.js';
import {
	buildCompactPostingIndex,
	compactLexicalArtifact,
	encodeOrdinalSet,
} from '../persistence/compactLexical.js';
import { classifyRetrieval, type FrontmatterFields, type FrontmatterValue } from '../retrievalPolicy.js';
import {
	createChunkId,
	createDocumentId,
	createSourceId,
	createSpanId,
	createVersionId,
	type SourceId,
} from '../stableIds.js';
import type { KnowledgeCorpus, RetrievalScope } from '../types.js';
import { validateCompiledSourceGeneration } from '../secondBrain/artifactLoader.js';
import {
	createDefaultScanPolicy,
	scanSourceDirectory,
	type ScannedSourceFile,
	type SourceScanPolicy,
} from './sourceScanner.js';

export const OFFLINE_COMPILER_VERSION = 'v1.3-five-plane-compiler-2' as const;

/** A normal concurrent source edit invalidated the captured scan; a watch loop may retry. */
export class SourceChangedDuringCompilationError extends Error {
	readonly code = 'SOURCE_CHANGED_DURING_COMPILATION' as const;

	constructor() {
		super('Source changed during offline compilation; no generation was published.');
		this.name = 'SourceChangedDuringCompilationError';
	}
}

const SCOPE_CORPUS: Record<Exclude<RetrievalScope, 'never'>, KnowledgeCorpus> = {
	default: 'core',
	project: 'project',
	reference: 'reference',
	history: 'history',
};

const POLICY_FRONTMATTER_KEYS = new Set([
	'archived',
	'corpus',
	'generated',
	'graph_exclude',
	'graph_exclude_reason',
	'record_role',
	'retrieval_scope',
	'role',
	'sensitivity',
	'status',
	'type',
]);

export interface TrustedSourceConfiguration {
	/** Opaque stable ID from a trusted adapter. Defaults to a hash of sourceRoot. */
	sourceId?: SourceId;
	/** Trusted project authorization boundary. Never read from document content. */
	projectId?: string | null;
	retrievalScope?: Exclude<RetrievalScope, 'never'>;
	corpus?: KnowledgeCorpus;
}

export interface OfflineCompilerPolicy extends SourceScanPolicy {
	chunkMaximumTokens: number;
	chunkOverlapTokens: number;
	lexicalDeltaCompactionThreshold: number;
	lexicalReplacementCompactionRatio: number;
	journalRetentionRecords: number;
}

export interface EmbeddingInput {
	recordId: string;
	documentId: string;
	text: string;
}

export interface EmbeddingProvider {
	readonly adapterId: string;
	readonly modelId: string;
	readonly kind: 'lexical_hash' | 'semantic';
	readonly dimensions: number;
	embed(records: readonly EmbeddingInput[]): Promise<readonly (readonly number[])[]>;
}

export interface OfflineKnowledgeCompilerOptions {
	sourceRoot: string;
	stateRoot: string;
	generationRoot: string;
	trustedSource?: TrustedSourceConfiguration;
	policy?: Partial<OfflineCompilerPolicy>;
	embeddingProvider?: EmbeddingProvider;
	clock?: () => Date;
	/** Test/integration seam invoked after every durable per-file checkpoint. */
	afterFileCheckpoint?: (path: string, completedFileCount: number) => Promise<void>;
}

export interface OfflineBuildOptions {
	forceCompaction?: boolean;
}

export interface OfflineBuildResult {
	generation: PublishedArtifactGeneration;
	buildId: string;
	compiledFiles: number;
	reusedFiles: number;
	resumedFiles: number;
	tombstonedFiles: number;
	duplicateFiles: number;
	compacted: boolean;
	skippedSymlinks: number;
}

interface CompiledUnitChunk {
	chunkId: string;
	spanId: string;
	heading: string | null;
	startLine: number;
	endLine: number;
	startColumn: number | null;
	endColumn: number | null;
	content: string;
	termFrequencies: Array<[string, number]>;
	tokenCount: number;
	vector: number[] | null;
}

interface CompiledFileUnit {
	path: string;
	documentId: string;
	versionId: string;
	contentSha256: string;
	normalizedContentSha256: string;
	byteLength: number;
	mtimeMs: number;
	title: string;
	aliases: string[];
	tags: string[];
	links: string[];
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
	headings: Array<{ text: string; level: number; line: number; parent: string | null }>;
	chunks: CompiledUnitChunk[];
}

interface ParsedDocument {
	frontmatter: FrontmatterFields;
	body: string;
	bodyStartLine: number;
	title: string;
	aliases: string[];
	tags: string[];
}

export class OfflineKnowledgeCompiler {
	readonly sourceId: SourceId;
	readonly projectId: string | null;
	readonly policyHash: string;
	readonly policy: OfflineCompilerPolicy;

	private readonly sourceRoot: string;
	private readonly generationRoot: string;
	private readonly baseScope: Exclude<RetrievalScope, 'never'>;
	private readonly baseCorpus: KnowledgeCorpus;
	private readonly enforceTrustedScope: boolean;
	private readonly embeddingProvider: EmbeddingProvider | undefined;
	private readonly clock: () => Date;
	private readonly afterFileCheckpoint: ((path: string, completedFileCount: number) => Promise<void>) | undefined;
	private readonly state: BuildStateStore;
	private readonly generations: ArtifactGenerationStore;

	constructor(options: OfflineKnowledgeCompilerOptions) {
		this.sourceRoot = path.resolve(options.sourceRoot);
		this.generationRoot = path.resolve(options.generationRoot);
		this.sourceId = options.trustedSource?.sourceId ?? createSourceId(this.sourceRoot);
		// Validate a caller-supplied source ID with the stable-ID implementation.
		createDocumentId(this.sourceId, '__source-id-validation__.md');
		this.projectId = normalizeProjectId(options.trustedSource?.projectId ?? null);
		this.enforceTrustedScope = options.trustedSource?.retrievalScope !== undefined || this.projectId !== null;
		this.baseScope = options.trustedSource?.retrievalScope ?? (this.projectId ? 'project' : 'default');
		this.baseCorpus = options.trustedSource?.corpus ?? SCOPE_CORPUS[this.baseScope];
		if (options.trustedSource?.corpus !== undefined && !this.enforceTrustedScope) {
			throw new TypeError('A trusted corpus requires an explicit trusted retrieval scope.');
		}
		if (this.baseCorpus !== SCOPE_CORPUS[this.baseScope]) {
			throw new TypeError('Trusted corpus must correspond to the trusted retrieval scope.');
		}
		if (this.projectId && this.baseScope !== 'project') {
			throw new TypeError('A projectId requires trusted project retrieval scope.');
		}
		this.embeddingProvider = options.embeddingProvider;
		validateEmbeddingProvider(this.embeddingProvider);
		this.policy = mergePolicy(options.policy);
		this.policyHash = hashCanonicalJson({
			compilerVersion: OFFLINE_COMPILER_VERSION,
			scan: this.policy,
			sourceId: this.sourceId,
			projectId: this.projectId,
			baseScope: this.baseScope,
			baseCorpus: this.baseCorpus,
			embedding: this.embeddingProvider
				? {
					adapterId: this.embeddingProvider.adapterId,
					modelId: this.embeddingProvider.modelId,
					kind: this.embeddingProvider.kind,
					dimensions: this.embeddingProvider.dimensions,
					inputRecipe: EMBEDDING_INPUT_RECIPE,
				}
				: null,
		});
		this.clock = options.clock ?? (() => new Date());
		this.afterFileCheckpoint = options.afterFileCheckpoint;
		this.state = new BuildStateStore(options.stateRoot);
		this.generations = new ArtifactGenerationStore(options.generationRoot);
	}

	async readCurrent(): Promise<PublishedArtifactGeneration | null> {
		return this.generations.readCurrent();
	}

	async readGeneration(generationId: string): Promise<PublishedArtifactGeneration> {
		return this.generations.readGeneration(generationId);
	}

	async build(options: OfflineBuildOptions = {}): Promise<OfflineBuildResult> {
		return this.state.withBuildLock(async () => this.buildLocked(options));
	}

	private async buildLocked(options: OfflineBuildOptions): Promise<OfflineBuildResult> {
		const now = this.clock().toISOString();
		const scan = await scanSourceDirectory(this.sourceRoot, this.policy);
		const planHash = createScanPlanHash(this.policyHash, scan.files);
		const storedCheckpoint = await this.state.readCheckpoint<CompiledFileUnit>();
		const checkpoint = checkpointMatches(storedCheckpoint, this.sourceId, this.policyHash, planHash)
			? storedCheckpoint
			: createCheckpoint(this.sourceId, this.policyHash, planHash, now);
		const wasResume = checkpoint.completedFiles.length > 0;
		if (!wasResume) {
			await this.state.appendJournal(journalInput(now, 'scan-started', checkpoint.buildId));
			await this.state.writeCheckpoint(checkpoint);
		}

		const current = await this.generations.readCurrent();
		const currentIsSemanticallyValid = current === null
			? false
			: await this.isGenerationSemanticallyValid(current);
		const previousBundle = currentIsSemanticallyValid ? current?.bundle ?? null : null;
		const canReusePrevious = previousBundle?.policyHash === this.policyHash;
		const canReturnCurrent = (
			current !== null
			&& current.bundle.compilerVersion === OFFLINE_COMPILER_VERSION
			&& canReusePrevious
			&& scanMatchesPublishedGeneration(
				scan.files,
				current.bundle,
				this.embeddingProvider !== undefined,
			)
			&& (!(options.forceCompaction ?? false) || current.bundle.layers.lexical.data.deltas.length === 0)
		);
		if (canReturnCurrent) {
			const verifiedScan = await scanSourceDirectory(this.sourceRoot, this.policy);
			if (createScanPlanHash(this.policyHash, verifiedScan.files) !== planHash) {
				throw new SourceChangedDuringCompilationError();
			}
			await this.state.appendJournal({
				...journalInput(now, 'scan-completed', checkpoint.buildId),
				generationId: current.generationId,
			});
			await this.state.clearCheckpoint();
			await this.state.compactJournal(this.policy.journalRetentionRecords);
			return {
				generation: current,
				buildId: checkpoint.buildId,
				compiledFiles: 0,
				reusedFiles: scan.files.length,
				resumedFiles: 0,
				tombstonedFiles: 0,
				duplicateFiles: current.bundle.statistics.duplicates,
				compacted: false,
				skippedSymlinks: verifiedScan.skippedSymlinks,
			};
		}
		const previousCatalog = new Map(
			(previousBundle?.layers.catalog.data.entries ?? []).map((entry) => [entry.path, entry]),
		);
		const previousDerived = new Map(
			(previousBundle?.layers.derived.data.documents ?? []).map((document) => [document.path, document]),
		);
		const previousVectors = new Map(
			(previousBundle?.layers.vector?.data.entries ?? []).map((record) => [record.recordId, record.values]),
		);
		const completed = new Map(checkpoint.completedFiles.map((item) => [item.path, item]));
		const units: CompiledFileUnit[] = [];
		let compiledFiles = 0;
		let reusedFiles = 0;
		let resumedFiles = 0;

		for (const file of scan.files) {
			const resumed = completed.get(file.path);
			let unit: CompiledFileUnit;
			let event: 'file-compiled' | 'file-reused';
			if (resumed?.contentSha256 === file.contentSha256) {
				unit = withCurrentFileMetadata(resumed.artifact, file);
				resumedFiles += 1;
				event = 'file-reused';
			} else {
				const previousEntry = previousCatalog.get(file.path);
				const previousDocument = previousDerived.get(file.path);
				if (
					canReusePrevious
					&& previousEntry?.tombstoneAt === null
					&& previousEntry.contentSha256 === file.contentSha256
					&& previousDocument
				) {
					unit = unitFromPublished(previousDocument, file, previousVectors);
					reusedFiles += 1;
					event = 'file-reused';
				} else {
					unit = await this.compileFile(file);
					compiledFiles += 1;
					event = 'file-compiled';
				}
				checkpoint.completedFiles.push({
					path: file.path,
					contentSha256: file.contentSha256,
					artifact: unit,
				});
				await this.state.writeCheckpoint(checkpoint);
				await this.state.appendJournal({
					...journalInput(now, event, checkpoint.buildId),
					path: file.path,
					contentSha256: file.contentSha256,
				});
				if (this.afterFileCheckpoint) {
					await this.afterFileCheckpoint(file.path, checkpoint.completedFiles.length);
				}
			}
			units.push(unit);
		}

		const assembled = this.assembleArtifacts(
			units,
			previousBundle?.layers.catalog.data ?? null,
			previousBundle?.layers.lexical.data ?? null,
			now,
			options.forceCompaction ?? false,
		);
		for (const entry of assembled.catalog.entries) {
			if (entry.tombstoneAt !== now) continue;
			await this.state.appendJournal({
				...journalInput(now, 'file-tombstoned', checkpoint.buildId),
				path: entry.path,
				contentSha256: entry.contentSha256,
			});
		}

		// Compilation and local embedding may take minutes on a large corpus.  A
		// second stable scan prevents publishing a generation for a source tree
		// that changed after the build plan was captured.  The remaining
		// scan-to-pointer-switch window is governed by the documented same-user,
		// non-adversarial source boundary.
		const verifiedScan = await scanSourceDirectory(this.sourceRoot, this.policy);
		if (createScanPlanHash(this.policyHash, verifiedScan.files) !== planHash) {
			throw new SourceChangedDuringCompilationError();
		}

		const generation = await this.generations.publish({
			compilerVersion: OFFLINE_COMPILER_VERSION,
			createdAt: now,
			policyHash: this.policyHash,
			layers: {
				catalog: assembled.catalog,
				lexical: assembled.lexical,
				derived: { schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION, documents: assembled.documents },
				temporal: assembled.temporal,
				hierarchy: assembled.hierarchy,
				vector: assembled.vector,
			},
			statistics: {
				activeDocuments: assembled.documents.length,
				tombstones: assembled.catalog.entries.filter((entry) => entry.tombstoneAt !== null).length,
				duplicates: assembled.catalog.entries.filter((entry) => entry.duplicateOfDocumentId !== null).length,
				lexicalSegments: 1 + assembled.lexical.deltas.length,
			},
		});
		await this.state.appendJournal({
			...journalInput(now, 'generation-published', checkpoint.buildId),
			generationId: generation.generationId,
		});
		await this.state.appendJournal({
			...journalInput(now, 'scan-completed', checkpoint.buildId),
			generationId: generation.generationId,
		});
		await this.state.clearCheckpoint();
		await this.state.compactJournal(this.policy.journalRetentionRecords);

		return {
			generation,
			buildId: checkpoint.buildId,
			compiledFiles,
			reusedFiles,
			resumedFiles,
			tombstonedFiles: assembled.tombstonedFiles,
			duplicateFiles: assembled.catalog.entries.filter((entry) => entry.duplicateOfDocumentId !== null).length,
			compacted: assembled.compacted,
			skippedSymlinks: scan.skippedSymlinks,
		};
	}

	private async isGenerationSemanticallyValid(
		generation: PublishedArtifactGeneration,
	): Promise<boolean> {
		const validationAdapter: EmbeddingAdapter = {
			id: this.embeddingProvider?.adapterId ?? 'offline-no-vector',
			modelId: this.embeddingProvider?.modelId ?? 'offline-no-vector',
			kind: this.embeddingProvider?.kind ?? 'lexical_hash',
			dimension: this.embeddingProvider?.dimensions ?? 1,
			embed: async () => {
				throw new Error('Compiler validation adapters do not execute embeddings.');
			},
		};
		try {
			await validateCompiledSourceGeneration(
				{
					sourceId: this.sourceId,
					label: 'offline-compiler-validation',
					kind: 'directory',
					generationRoot: this.generationRoot,
					pinnedGenerationId: generation.generationId,
					pinnedManifestSha256: generation.manifestSha256,
					...(this.projectId === null ? {} : { projectId: this.projectId }),
				},
				validationAdapter,
				this.embeddingProvider !== undefined,
				generation,
			);
			return true;
		} catch {
			return false;
		}
	}

	private async compileFile(file: ScannedSourceFile): Promise<CompiledFileUnit> {
		const parsed = parseDocument(file.path, file.content);
		const policyDecision = classifyRetrieval({
			path: file.path,
			frontmatter: parsed.frontmatter,
			body: parsed.body,
			title: parsed.title,
			tags: parsed.tags,
		});
		// Untrusted document metadata can only remove itself from retrieval. It
		// cannot select another corpus, project, or broader scope.
		const trustedDecision = resolveTrustedDecision(
			policyDecision,
			this.enforceTrustedScope,
			this.baseScope,
			this.baseCorpus,
		);
		const retrievalScope = trustedDecision.retrievalScope;
		const corpus = trustedDecision.corpus;
		const documentId = createDocumentId(this.sourceId, file.path);
		const versionId = createVersionId(documentId, { content: file.content });
		const rawHeadings = parseMarkdownHeadings(file.content.split(/\r?\n/u), parsed.bodyStartLine);
		const headings = attachHeadingParents(rawHeadings);
		const links = uniqueMatches(parsed.body, /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu);
		let chunks: CompiledUnitChunk[] = [];
		if (retrievalScope !== 'never') {
			const drafts = chunkMarkdown(
				file.content.split(/\r?\n/u),
				parsed.bodyStartLine,
				rawHeadings,
				this.policy.chunkMaximumTokens,
				this.policy.chunkOverlapTokens,
			);
			chunks = drafts.map((draft) => {
				const span = {
					startLine: draft.startLine,
					endLine: draft.endLine,
					...(draft.startColumn === undefined ? {} : { startColumn: draft.startColumn }),
					...(draft.endColumn === undefined ? {} : { endColumn: draft.endColumn }),
				};
				const spanId = createSpanId(versionId, span);
				const frequencies = countTokens(draft.content);
				return {
					chunkId: createChunkId(spanId, draft.content),
					spanId,
					heading: draft.heading,
					startLine: draft.startLine,
					endLine: draft.endLine,
					startColumn: draft.startColumn ?? null,
					endColumn: draft.endColumn ?? null,
					content: draft.content,
					termFrequencies: [...frequencies.entries()].sort(([first], [second]) => first.localeCompare(second)),
					tokenCount: [...frequencies.values()].reduce((total, count) => total + count, 0),
					vector: null,
				};
			});
			if (this.embeddingProvider && chunks.length > 0) {
				const vectors = await this.embeddingProvider.embed(chunks.map((chunk) => ({
					recordId: chunk.chunkId,
					documentId,
					text: recordSearchText({
						id: chunk.chunkId,
						sourceId: this.sourceId,
						documentId,
						versionId,
						path: file.path,
						title: parsed.title,
						heading: chunk.heading,
						content: chunk.content,
						startLine: chunk.startLine,
						endLine: chunk.endLine,
						corpus,
						retrievalScope,
						aliases: parsed.aliases,
						tags: parsed.tags,
						hierarchy: embeddingHierarchy(file.path, headings, chunk.startLine),
					}),
				})));
				if (vectors.length !== chunks.length) throw new Error('Embedding provider returned the wrong vector count.');
				chunks = chunks.map((chunk, index) => ({
					...chunk,
					vector: validateVector(vectors[index], this.embeddingProvider?.dimensions ?? 0),
				}));
			}
		}

		return {
			path: file.path,
			documentId,
			versionId,
			contentSha256: file.contentSha256,
			normalizedContentSha256: file.normalizedContentSha256,
			byteLength: file.byteLength,
			mtimeMs: file.mtimeMs,
			title: parsed.title,
			aliases: parsed.aliases,
			tags: parsed.tags,
			links,
			corpus,
			retrievalScope,
			headings,
			chunks,
		};
	}

	private assembleArtifacts(
		units: CompiledFileUnit[],
		previousCatalog: SourceCatalog | null,
		previousLexical: CompactLexicalArtifact | null,
		now: string,
		forceCompaction: boolean,
	): {
		catalog: SourceCatalog;
		documents: DerivedDocumentArtifact[];
		lexical: CompactLexicalArtifact;
		temporal: TemporalArtifact;
		hierarchy: HierarchyArtifact;
		vector: VectorArtifact | null;
		tombstonedFiles: number;
		compacted: boolean;
	} {
		const previousByPath = new Map((previousCatalog?.entries ?? []).map((entry) => [entry.path, entry]));
		let nextOrdinal = previousCatalog?.nextOrdinal ?? 0;
		const unitByPath = new Map(units.map((unit) => [unit.path, unit]));
		const canonicalByHash = new Map<string, CompiledFileUnit>();
		for (const unit of [...units].sort((first, second) => first.path.localeCompare(second.path))) {
			if (unit.retrievalScope === 'never') continue;
			const key = deduplicationDomainKey(unit);
			if (!canonicalByHash.has(key)) {
				canonicalByHash.set(key, unit);
			}
		}

		const entries: CatalogEntry[] = [];
		for (const unit of [...units].sort((first, second) => first.path.localeCompare(second.path))) {
			const previous = previousByPath.get(unit.path);
			const ordinal = previous?.ordinal ?? nextOrdinal++;
			const canonical = unit.retrievalScope === 'never'
				? null
				: canonicalByHash.get(deduplicationDomainKey(unit)) ?? null;
			entries.push({
				sourceId: this.sourceId,
				projectId: this.projectId,
				path: unit.path,
				documentId: unit.documentId,
				ordinal,
				contentSha256: unit.contentSha256,
				normalizedContentSha256: unit.normalizedContentSha256,
				byteLength: unit.byteLength,
				mtimeMs: unit.mtimeMs,
				firstSeenAt: previous?.firstSeenAt ?? now,
				lastSeenAt: now,
				tombstoneAt: null,
				duplicateOfDocumentId: canonical && canonical.path !== unit.path ? canonical.documentId : null,
				corpus: unit.corpus,
				retrievalScope: unit.retrievalScope,
			});
		}

		let tombstonedFiles = 0;
		for (const previous of previousCatalog?.entries ?? []) {
			if (unitByPath.has(previous.path)) continue;
			if (previous.tombstoneAt === null) tombstonedFiles += 1;
			entries.push({
				...previous,
				lastSeenAt: previous.lastSeenAt,
				tombstoneAt: previous.tombstoneAt ?? now,
				duplicateOfDocumentId: null,
			});
		}
		entries.sort((first, second) => first.ordinal - second.ordinal);
		const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
		const documents: DerivedDocumentArtifact[] = [];
		for (const unit of units) {
			const entry = entryByPath.get(unit.path);
			if (!entry || entry.retrievalScope === 'never' || entry.duplicateOfDocumentId !== null) continue;
			documents.push({
				sourceId: this.sourceId,
				projectId: this.projectId,
				path: unit.path,
				documentId: unit.documentId,
				versionId: unit.versionId,
				ordinal: entry.ordinal,
				contentSha256: unit.contentSha256,
				normalizedContentSha256: unit.normalizedContentSha256,
				byteLength: unit.byteLength,
				title: unit.title,
				aliases: unit.aliases,
				tags: unit.tags,
				links: unit.links,
				corpus: unit.corpus,
				retrievalScope: unit.retrievalScope,
				mtimeMs: unit.mtimeMs,
				modifiedAt: new Date(unit.mtimeMs).toISOString(),
				headings: unit.headings,
				chunks: unit.chunks.map(({ vector: _vector, ...chunk }) => chunk),
			});
		}
		documents.sort((first, second) => first.ordinal - second.ordinal);

		const previousActive = new Map<number, string>();
		for (const entry of previousCatalog?.entries ?? []) {
			if (entry.tombstoneAt === null && entry.duplicateOfDocumentId === null && entry.retrievalScope !== 'never') {
				previousActive.set(entry.ordinal, entry.contentSha256);
			}
		}
		const currentActive = new Map(documents.map((document) => [document.ordinal, document.contentSha256]));
		const replacedOrdinals = new Set<number>();
		for (const [ordinal, hash] of previousActive) {
			if (currentActive.get(ordinal) !== hash) replacedOrdinals.add(ordinal);
		}
		for (const [ordinal, hash] of currentActive) {
			if (previousActive.get(ordinal) !== hash) replacedOrdinals.add(ordinal);
		}
		const allInputs = documents.map(toLexicalInput);
		let documentLexical: Omit<CompactLexicalArtifact, 'chunkIndex'>;
		let compacted = false;
		if (!previousLexical || previousCatalog?.policyHash !== this.policyHash) {
			documentLexical = {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				base: buildCompactPostingIndex(allInputs),
				deltas: [],
			};
			compacted = true;
		} else if (replacedOrdinals.size === 0) {
			documentLexical = forceCompaction && previousLexical.deltas.length > 0
				? compactLexicalArtifact(previousLexical)
				: previousLexical;
			compacted = forceCompaction && previousLexical.deltas.length > 0;
		} else {
			documentLexical = {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				base: previousLexical.base,
				deltas: [
					...previousLexical.deltas,
					{
						createdAt: now,
						replaceOrdinalsBase64: encodeOrdinalSet([...replacedOrdinals]),
						index: buildCompactPostingIndex(
							allInputs.filter((document) => replacedOrdinals.has(document.ordinal)),
						),
					},
				],
			};
			const replacementRatio = replacedOrdinals.size / Math.max(1, currentActive.size);
			if (
				forceCompaction
				|| documentLexical.deltas.length >= this.policy.lexicalDeltaCompactionThreshold
				|| replacementRatio >= this.policy.lexicalReplacementCompactionRatio
			) {
				documentLexical = compactLexicalArtifact({
					...documentLexical,
					chunkIndex: previousLexical.chunkIndex,
				});
				compacted = true;
			}
		}
		let chunkOrdinal = 0;
		const chunkRecords: Array<{ recordId: string; versionId: string }> = [];
		const chunkInputs = documents.flatMap((document) => document.chunks.map((chunk) => {
			const ordinal = chunkOrdinal;
			chunkOrdinal += 1;
			chunkRecords.push({ recordId: chunk.chunkId, versionId: document.versionId });
			return {
				ordinal,
				documentLength: Math.max(1, chunk.tokenCount),
				termFrequencies: chunk.termFrequencies,
			};
		}));
		const lexical: CompactLexicalArtifact = {
			...documentLexical,
			chunkIndex: {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				records: chunkRecords,
				index: buildCompactPostingIndex(chunkInputs),
			},
		};

		const temporal: TemporalArtifact = {
			schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
			byOrdinal: documents.map((document) => {
				const entry = entryByPath.get(document.path);
				if (!entry) throw new Error('Derived document has no catalog entry.');
				return {
					ordinal: document.ordinal,
					mtimeMs: entry.mtimeMs,
					firstSeenAt: entry.firstSeenAt,
					lastSeenAt: entry.lastSeenAt,
				};
			}),
		};
		const hierarchy: HierarchyArtifact = {
			schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
			byOrdinal: documents.map((document) => ({
				ordinal: document.ordinal,
				pathSegments: document.path.split('/'),
				headings: document.headings,
			})),
		};
		const unitByDocumentId = new Map(units.map((unit) => [unit.documentId, unit]));
		const vector: VectorArtifact | null = this.embeddingProvider
			? {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				adapterId: this.embeddingProvider.adapterId,
				modelId: this.embeddingProvider.modelId,
				embeddingKind: this.embeddingProvider.kind,
				inputRecipe: EMBEDDING_INPUT_RECIPE,
				dimension: this.embeddingProvider.dimensions,
				entries: documents.flatMap((document) => {
					const unit = unitByDocumentId.get(document.documentId);
					return (unit?.chunks ?? []).map((chunk) => {
						if (!chunk.vector) throw new Error('A retrievable chunk is missing its persisted vector.');
						return {
							recordId: chunk.chunkId,
							versionId: document.versionId,
							values: chunk.vector,
						};
					});
				}),
			}
			: null;

		return {
			catalog: {
				schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
				sourceId: this.sourceId,
				policyHash: this.policyHash,
				nextOrdinal,
				entries,
			},
			documents,
			lexical,
			temporal,
			hierarchy,
			vector,
			tombstonedFiles,
			compacted,
		};
	}
}

function scanMatchesPublishedGeneration(
	files: readonly ScannedSourceFile[],
	bundle: PublishedArtifactGeneration['bundle'],
	requireVector: boolean,
): boolean {
	const entries = bundle.layers.catalog.data.entries.filter((entry) => entry.tombstoneAt === null);
	if (
		entries.length !== files.length
		|| (bundle.layers.vector !== null) !== requireVector
		|| bundle.layers.lexical.data.chunkIndex === undefined
	) return false;
	const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
	if (entriesByPath.size !== entries.length) return false;
	for (const file of files) {
		const entry = entriesByPath.get(file.path);
		if (
			entry === undefined
			|| entry.contentSha256 !== file.contentSha256
			|| entry.normalizedContentSha256 !== file.normalizedContentSha256
			|| entry.byteLength !== file.byteLength
			|| entry.mtimeMs !== file.mtimeMs
		) return false;
	}
	return true;
}

function mergePolicy(overrides: Partial<OfflineCompilerPolicy> | undefined): OfflineCompilerPolicy {
	const base = createDefaultScanPolicy();
	const policy: OfflineCompilerPolicy = {
		...base,
		chunkMaximumTokens: 800,
		chunkOverlapTokens: 80,
		lexicalDeltaCompactionThreshold: 8,
		lexicalReplacementCompactionRatio: 0.35,
		journalRetentionRecords: 10_000,
		...overrides,
		extensions: [...(overrides?.extensions ?? base.extensions)],
		ignoredDirectoryNames: uniqueStrings([
			...base.ignoredDirectoryNames,
			...(overrides?.ignoredDirectoryNames ?? []),
		]),
		ignoredPathPrefixes: [...(overrides?.ignoredPathPrefixes ?? base.ignoredPathPrefixes)],
	};
	if (!Number.isSafeInteger(policy.chunkMaximumTokens) || policy.chunkMaximumTokens < 200) {
		throw new TypeError('chunkMaximumTokens must be an integer of at least 200.');
	}
	if (!Number.isSafeInteger(policy.chunkOverlapTokens) || policy.chunkOverlapTokens < 0 || policy.chunkOverlapTokens > Math.floor(policy.chunkMaximumTokens / 3)) {
		throw new TypeError('chunkOverlapTokens must be between zero and one third of chunkMaximumTokens.');
	}
	if (!Number.isSafeInteger(policy.lexicalDeltaCompactionThreshold) || policy.lexicalDeltaCompactionThreshold < 1) {
		throw new TypeError('lexicalDeltaCompactionThreshold must be a positive integer.');
	}
	if (!(policy.lexicalReplacementCompactionRatio > 0 && policy.lexicalReplacementCompactionRatio <= 1)) {
		throw new TypeError('lexicalReplacementCompactionRatio must be in (0, 1].');
	}
	if (!Number.isSafeInteger(policy.journalRetentionRecords) || policy.journalRetentionRecords < 10) {
		throw new TypeError('journalRetentionRecords must be an integer of at least 10.');
	}
	return policy;
}

function resolveTrustedDecision(
	classified: { corpus: KnowledgeCorpus; retrievalScope: RetrievalScope },
	enforceTrustedScope: boolean,
	trustedScope: Exclude<RetrievalScope, 'never'>,
	trustedCorpus: KnowledgeCorpus,
): { corpus: KnowledgeCorpus; retrievalScope: RetrievalScope } {
	if (classified.retrievalScope === 'never') return classified;
	if (!enforceTrustedScope) return classified;
	if (classified.retrievalScope === trustedScope || classified.retrievalScope === 'default') {
		return { corpus: trustedCorpus, retrievalScope: trustedScope };
	}
	// Retrieval scopes are separate disclosure domains, not a simple ordered
	// hierarchy. A conflict between source authorization and note classification
	// therefore fails closed instead of guessing which domain should win.
	return { corpus: 'control', retrievalScope: 'never' };
}

function parseDocument(documentPath: string, content: string): ParsedDocument {
	const lines = content.replace(/\r\n?/gu, '\n').split('\n');
	const frontmatter: FrontmatterFields = {};
	let bodyStartLine = 0;
	const firstLine = (lines[0] ?? '').replace(/^\uFEFF/u, '');
	if (firstLine.trim() === '---') {
		const closing = lines.findIndex((line, index) => index > 0 && /^---\s*$/u.test(line));
		if (closing < 0) {
			frontmatter.__policy_parse_error = true;
		} else {
			bodyStartLine = closing + 1;
			const seenPolicyKeys = new Set<string>();
			let listTarget: string | null = null;
			let policyParseError = false;
			for (let index = 1; index < closing; index += 1) {
				const line = lines[index] ?? '';
				if (/^\s*(?:#.*)?$/u.test(line)) continue;
				const listItem = /^\s*-\s+(.+?)\s*$/u.exec(line);
				if (listItem?.[1] && listTarget) {
					if (POLICY_FRONTMATTER_KEYS.has(listTarget)) policyParseError = true;
					const existing = frontmatter[listTarget];
					const values = Array.isArray(existing) ? existing : [];
					values.push(unquote(listItem[1]));
					frontmatter[listTarget] = values;
					continue;
				}
				const property = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/u.exec(line);
				if (!property?.[1]) {
					// A strict subset avoids YAML tags, anchors, merges and complex keys
					// hiding a policy field from this local parser.
					policyParseError = true;
					listTarget = null;
					continue;
				}
				const key = property[1].toLowerCase();
				const value = property[2] ?? '';
				if (POLICY_FRONTMATTER_KEYS.has(key)) {
					if (seenPolicyKeys.has(key) || hasUnsupportedPolicySyntax(value)) policyParseError = true;
					seenPolicyKeys.add(key);
				}
				if (!value) {
					frontmatter[key] = [];
					listTarget = key;
				} else {
					frontmatter[key] = parseFrontmatterValue(value);
					listTarget = null;
				}
			}
			for (const key of POLICY_FRONTMATTER_KEYS) {
				if (Array.isArray(frontmatter[key])) policyParseError = true;
			}
			for (const key of ['archived', 'generated', 'graph_exclude']) {
				if (Object.prototype.hasOwnProperty.call(frontmatter, key) && !isSupportedBooleanPolicyValue(frontmatter[key])) {
					policyParseError = true;
				}
			}
			if (policyParseError) frontmatter.__policy_parse_error = true;
		}
	}
	const body = lines.slice(bodyStartLine).join('\n');
	const headings = parseMarkdownHeadings(lines, bodyStartLine);
	const frontmatterTitle = scalar(frontmatter.title);
	const title = frontmatterTitle || headings[0]?.text || path.basename(documentPath, path.extname(documentPath));
	return {
		frontmatter,
		body,
		bodyStartLine,
		title,
		aliases: list(frontmatter.aliases ?? frontmatter.alias),
		tags: uniqueStrings([
			...list(frontmatter.tags ?? frontmatter.tag),
			...uniqueMatches(body, /(?:^|\s)#([\p{L}\p{N}_/-]+)/gmu),
		]),
	};
}

function parseFrontmatterValue(raw: string): FrontmatterValue {
	const value = stripYamlComment(raw).trim();
	if (!value) return null;
	if (/^(?:true|false)$/iu.test(value)) return value.toLowerCase() === 'true';
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) return Number(value);
	if (value.startsWith('[') && value.endsWith(']')) {
		return value.slice(1, -1).split(',').map(unquote).filter(Boolean);
	}
	return unquote(value);
}

function hasUnsupportedPolicySyntax(raw: string): boolean {
	const value = stripYamlComment(raw).trim();
	if (!value) return false;
	const startsDoubleQuote = value.startsWith('"');
	const endsDoubleQuote = value.endsWith('"');
	if (startsDoubleQuote || endsDoubleQuote) {
		return !startsDoubleQuote || !endsDoubleQuote || value.includes('\\');
	}
	const startsSingleQuote = value.startsWith("'");
	const endsSingleQuote = value.endsWith("'");
	if (startsSingleQuote || endsSingleQuote) return !startsSingleQuote || !endsSingleQuote;
	return /^[>|][+-]?\d*(?:\s|$)/u.test(value)
		|| /^[{[]/u.test(value)
		|| /(?:^|\s)[!&*](?:\S|$)/u.test(value);
}

function isSupportedBooleanPolicyValue(value: FrontmatterValue | undefined): boolean {
	if (typeof value === 'boolean' || value === 0 || value === 1) return true;
	return typeof value === 'string' && /^(?:true|false|yes|no|on|off|0|1)$/iu.test(value.trim());
}

function stripYamlComment(value: string): string {
	let quote: '"' | "'" | null = null;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if ((character === '"' || character === "'") && value[index - 1] !== '\\') {
			quote = quote === character ? null : quote === null ? character : quote;
			continue;
		}
		if (character === '#' && quote === null && (index === 0 || /\s/u.test(value[index - 1] ?? ''))) {
			return value.slice(0, index);
		}
	}
	return value;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function scalar(value: FrontmatterValue | undefined): string {
	if (typeof value === 'string') return value.trim();
	return '';
}

function list(value: FrontmatterValue | undefined): string[] {
	if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
	if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
	return [];
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values.map((value) => value.normalize('NFC').trim()).filter(Boolean))]
		.sort((first, second) => first.localeCompare(second));
}

function uniqueMatches(content: string, expression: RegExp): string[] {
	const values: string[] = [];
	for (const match of content.matchAll(expression)) {
		const value = match[1]?.trim();
		if (value) values.push(value);
	}
	return uniqueStrings(values);
}

function attachHeadingParents(
	headings: Array<{ text: string; level: number; line: number }>,
): Array<{ text: string; level: number; line: number; parent: string | null }> {
	const stack: Array<{ text: string; level: number }> = [];
	return headings.map((heading) => {
		while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
		const parent = stack.at(-1)?.text ?? null;
		stack.push({ text: heading.text, level: heading.level });
		return { ...heading, parent };
	});
}

function toLexicalInput(document: DerivedDocumentArtifact): {
	ordinal: number;
	documentLength: number;
	termFrequencies: Map<string, number>;
} {
	const frequencies = new Map<string, number>();
	let documentLength = 0;
	for (const chunk of document.chunks) {
		documentLength += chunk.tokenCount;
		for (const [term, count] of chunk.termFrequencies) {
			frequencies.set(term, (frequencies.get(term) ?? 0) + count);
		}
	}
	return { ordinal: document.ordinal, documentLength, termFrequencies: frequencies };
}

function deduplicationDomainKey(unit: CompiledFileUnit): string {
	return [unit.retrievalScope, unit.corpus, unit.normalizedContentSha256].join('\0');
}

function validateEmbeddingProvider(provider: EmbeddingProvider | undefined): void {
	if (!provider) return;
	if (!provider.adapterId.trim() || provider.adapterId.includes('\0')) throw new TypeError('Embedding adapterId is invalid.');
	if (!provider.modelId.trim() || provider.modelId.includes('\0')) throw new TypeError('Embedding modelId is invalid.');
	if (provider.kind !== 'lexical_hash' && provider.kind !== 'semantic') throw new TypeError('Embedding kind is invalid.');
	if (!Number.isSafeInteger(provider.dimensions) || provider.dimensions <= 0 || provider.dimensions > 65_536) {
		throw new TypeError('Embedding dimensions must be a positive safe integer no greater than 65536.');
	}
}

function validateVector(value: readonly number[] | undefined, dimensions: number): number[] {
	if (!value || value.length !== dimensions) throw new Error('Embedding provider returned a vector with the wrong dimensions.');
	const vector = value.map((component) => {
		if (!Number.isFinite(component)) throw new Error('Embedding vector contains a non-finite component.');
		return Math.fround(component);
	});
	return vector;
}

function normalizeProjectId(value: string | null): string | null {
	if (value === null) return null;
	const normalized = value.normalize('NFC').trim();
	if (!normalized || normalized.includes('\0') || normalized.length > 256) throw new TypeError('projectId is invalid.');
	return normalized;
}

function checkpointMatches(
	checkpoint: CompilerCheckpoint<CompiledFileUnit> | null,
	sourceId: SourceId,
	policyHash: string,
	planHash: string,
): checkpoint is CompilerCheckpoint<CompiledFileUnit> {
	return checkpoint?.sourceId === sourceId
		&& checkpoint.policyHash === policyHash
		&& checkpoint.planHash === planHash;
}

function createCheckpoint(
	sourceId: SourceId,
	policyHash: string,
	planHash: string,
	startedAt: string,
): CompilerCheckpoint<CompiledFileUnit> {
	return {
		schemaVersion: 1,
		buildId: createBuildId(),
		sourceId,
		policyHash,
		planHash,
		startedAt,
		completedFiles: [],
	};
}

function journalInput(
	timestamp: string,
	event: 'scan-started' | 'file-compiled' | 'file-reused' | 'file-tombstoned' | 'generation-published' | 'scan-completed',
	buildId: string,
) {
	return {
		timestamp,
		event,
		buildId,
		path: null,
		contentSha256: null,
		generationId: null,
	};
}

function createScanPlanHash(
	policyHash: string,
	files: readonly ScannedSourceFile[],
): string {
	return hashCanonicalJson({
		policyHash,
		files: files.map((file) => ({
			path: file.path,
			contentSha256: file.contentSha256,
			byteLength: file.byteLength,
			mtimeMs: file.mtimeMs,
		})),
	});
}

function embeddingHierarchy(
	documentPath: string,
	headings: readonly { text: string; level: number; line: number }[],
	startLine: number,
): string[] {
	const stack: Array<{ text: string; level: number }> = [];
	for (const heading of headings) {
		if (heading.line > startLine) break;
		while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
		stack.push({ text: heading.text, level: heading.level });
	}
	return [...documentPath.split('/'), ...stack.map((heading) => heading.text)];
}

function unitFromPublished(
	document: DerivedDocumentArtifact,
	file: ScannedSourceFile,
	vectorByRecordId: ReadonlyMap<string, number[]>,
): CompiledFileUnit {
	return {
		path: document.path,
		documentId: document.documentId,
		versionId: document.versionId,
		contentSha256: file.contentSha256,
		normalizedContentSha256: file.normalizedContentSha256,
		byteLength: file.byteLength,
		mtimeMs: file.mtimeMs,
		title: document.title,
		aliases: document.aliases,
		tags: document.tags,
		links: document.links,
		corpus: document.corpus,
		retrievalScope: document.retrievalScope,
		headings: document.headings,
		chunks: document.chunks.map((chunk) => ({
			...chunk,
			vector: vectorByRecordId.get(chunk.chunkId) ?? null,
		})),
	};
}

function withCurrentFileMetadata(unit: CompiledFileUnit, file: ScannedSourceFile): CompiledFileUnit {
	return {
		...unit,
		contentSha256: file.contentSha256,
		normalizedContentSha256: file.normalizedContentSha256,
		byteLength: file.byteLength,
		mtimeMs: file.mtimeMs,
	};
}

/** Stable random material for adapters that need a trusted logical source identity. */
export function createTrustedLogicalSourceId(label: string): SourceId {
	const normalized = label.normalize('NFC').trim();
	if (!normalized) throw new TypeError('Trusted source label must not be empty.');
	return createSourceId(`logical:${normalized}`);
}
