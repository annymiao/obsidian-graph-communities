import {
	EMBEDDING_INPUT_RECIPE,
	type VectorArtifact as QueryVectorArtifact,
} from '../hybrid/embedding.js';
import { HybridQueryEngine, type HybridEngineCreateOptions } from '../hybrid/engine.js';
import type {
	EvidencePack,
	Bm25Artifact,
	HybridQuery,
	HybridQueryOptions,
	HybridRecord,
	HybridRetrievalMode,
} from '../hybrid/types.js';
import { createVisibilityPredicate, isPathAllowedByPrefixes } from '../hybrid/visibility.js';
import type { VersionId } from '../stableIds.js';
import type { ReingestObservation, RollbackReceipt, SourceRef, WriteReceipt } from '../write/contracts.js';
import { loadCompiledSource, type LoadedCompiledSource } from './artifactLoader.js';
import { SecondBrainControlledWrites } from './controlledWrites.js';
import type {
	BoundSecondBrainReadApi,
	PrepareRollbackInput,
	PrepareWriteInput,
	PreparedRollbackReview,
	PreparedWriteReview,
	SecondBrainPrincipalPolicy,
	SecondBrainQueryRequest,
	SecondBrainRuntimeApi,
	SecondBrainRuntimeOptions,
	SecondBrainSourceDescriptor,
	SecondBrainSourceStatus,
	SecondBrainStatus,
	WritableDirectoryBinding,
} from './types.js';

const HARD_QUERY_DEADLINE_MS = 5_000;
const QUERY_DEADLINE_GUARD_MS = 20;
const MAXIMUM_FILTER_IDS = 1_024;
const MAXIMUM_SEED_IDS = 1_024;
const MAXIMUM_PATH_PREFIXES = 256;
const RETRIEVAL_MODES = new Set<HybridRetrievalMode>(['default', 'project', 'reference', 'history']);

/**
 * Atomic in-memory query view over immutable READY/CURRENT generations.
 * `query()` only touches this view; sourceRoot is reachable only from the
 * controlled write flow for inspect/commit/rollback and subsequent reingest.
 */
export class SecondBrainRuntime implements SecondBrainRuntimeApi {
	readonly #sources: readonly SecondBrainSourceDescriptor[];
	readonly #sourcesById: ReadonlyMap<string, SecondBrainSourceDescriptor>;
	readonly #options: SecondBrainRuntimeOptions;
	readonly #requirePrecomputedVectors: boolean;
	#loadedById = new Map<string, LoadedCompiledSource>();
	#engine!: HybridQueryEngine;
	#revision = 0;
	#precomputed = false;
	#reloadTail: Promise<void> = Promise.resolve();
	#reingestTails = new Map<string, Promise<void>>();
	#writes: SecondBrainControlledWrites | null = null;

	private constructor(options: SecondBrainRuntimeOptions) {
		this.#options = options;
		this.#requirePrecomputedVectors = options.requirePrecomputedVectors ?? true;
		const sources = options.sources.map(cloneDescriptor);
		const sourcesById = new Map<string, SecondBrainSourceDescriptor>();
		for (const source of sources) {
			if (sourcesById.has(source.sourceId)) throw new TypeError('Duplicate second-brain sourceId.');
			sourcesById.set(source.sourceId, source);
		}
		if (sources.length === 0) throw new TypeError('Second-brain runtime requires at least one source.');
		this.#sources = sources;
		this.#sourcesById = sourcesById;
	}

	static async open(options: SecondBrainRuntimeOptions): Promise<SecondBrainRuntime> {
		const runtime = new SecondBrainRuntime(options);
		await runtime.reload();
		runtime.#initializeControlledWrites();
		return runtime;
	}

	async reload(sourceIds?: readonly string[]): Promise<SecondBrainStatus> {
		const requestedIds = sourceIds === undefined
			? this.#sources.map((source) => source.sourceId)
			: uniqueStrings(sourceIds);
		for (const sourceId of requestedIds) {
			if (!this.#sourcesById.has(sourceId)) throw new Error('Cannot reload an unknown source.');
		}
		let result!: SecondBrainStatus;
		const execute = async (): Promise<void> => {
			result = await this.#reloadNow(requestedIds);
		};
		const task = this.#reloadTail.then(execute, execute);
		this.#reloadTail = task.then(() => undefined, () => undefined);
		await task;
		return result;
	}

	async query(
		principal: SecondBrainPrincipalPolicy,
		request: SecondBrainQueryRequest,
		options: HybridQueryOptions = {},
	): Promise<EvidencePack> {
		const startedAt = Date.now();
		validatePrincipal(principal);
		validateQueryRequest(request);
		const requestedDeadlineMs = boundedDeadline(options.deadlineMs);
		if (!RETRIEVAL_MODES.has(request.mode)) throw new TypeError('Query retrieval mode is invalid.');
		const allowedModes = new Set(principal.allowedModes);
		if (!allowedModes.has(request.mode)) {
			return permissionRefusal(request.text, request.mode, requestedDeadlineMs, Date.now() - startedAt);
		}

		const principalSources = new Set(principal.allowedSourceIds);
		const requestedSources = request.sourceIds === undefined ? null : new Set(uniqueStrings(request.sourceIds));
		const principalProjects = new Set(principal.allowedProjectIds ?? []);
		const requestedProjects = request.projectIds === undefined ? null : new Set(uniqueStrings(request.projectIds));
		const allowedSourceIds: string[] = [];
		for (const source of this.#sources) {
			if (!principalSources.has(source.sourceId)) continue;
			if (requestedSources !== null && !requestedSources.has(source.sourceId)) continue;
			if (source.projectId !== undefined && !principalProjects.has(source.projectId)) continue;
			allowedSourceIds.push(source.sourceId);
		}
		const allowedProjectIds = [...principalProjects]
			.filter((projectId) => requestedProjects === null || requestedProjects.has(projectId));
		if (allowedSourceIds.length === 0) {
			return permissionRefusal(request.text, request.mode, requestedDeadlineMs, Date.now() - startedAt);
		}

		const query: HybridQuery = {
			text: request.text,
			scope: {
				mode: request.mode,
				allowedSourceIds,
				allowedProjectIds,
				...(principal.includedPathPrefixes === undefined
					? {}
					: { includedPathPrefixes: [...principal.includedPathPrefixes] }),
				...(principal.excludedPathPrefixes === undefined
					? {}
					: { excludedPathPrefixes: [...principal.excludedPathPrefixes] }),
			},
			...(request.temporal === undefined ? {} : { temporal: { ...request.temporal } }),
			...(request.seedRecordIds === undefined ? {} : { seedRecordIds: [...request.seedRecordIds] }),
		};
		const elapsedBeforeEngine = Date.now() - startedAt;
		const remainingMs = Math.min(
			requestedDeadlineMs - elapsedBeforeEngine,
			HARD_QUERY_DEADLINE_MS - elapsedBeforeEngine - QUERY_DEADLINE_GUARD_MS,
		);
		if (remainingMs < 1) return timeoutRefusal(request.text, request.mode, requestedDeadlineMs, elapsedBeforeEngine);
		const boundedOptions: HybridQueryOptions = {
			...options,
			deadlineMs: Math.floor(remainingMs),
		};
		// Snapshot the immutable engine so a concurrent reload cannot create a mixed view.
		const engine = this.#engine;
		return engine.query(query, boundedOptions);
	}

	status(principal: SecondBrainPrincipalPolicy): SecondBrainStatus {
		validatePrincipal(principal);
		const allowedSources = new Set(principal.allowedSourceIds);
		const allowedProjects = new Set(principal.allowedProjectIds ?? []);
		const allowedModes = new Set(principal.allowedModes);
		const statuses: SecondBrainSourceStatus[] = [];
		let totalRecords = 0;
		let totalDocuments = 0;
		for (const source of this.#sources) {
			if (!allowedSources.has(source.sourceId)) continue;
			if (source.projectId !== undefined && !allowedProjects.has(source.projectId)) continue;
			const loaded = this.#loadedById.get(source.sourceId);
			if (!loaded) continue;
			const visibleRecords = loaded.records.filter((record) => [...allowedModes].some((mode) => (
				createVisibilityPredicate({
					mode,
					allowedSourceIds: [source.sourceId],
					allowedProjectIds: [...allowedProjects],
					...(principal.includedPathPrefixes === undefined
						? {}
						: { includedPathPrefixes: principal.includedPathPrefixes }),
					...(principal.excludedPathPrefixes === undefined
						? {}
						: { excludedPathPrefixes: principal.excludedPathPrefixes }),
				})(record)
			)));
			const documentCount = new Set(visibleRecords.map((record) => record.documentId)).size;
			totalRecords += visibleRecords.length;
			totalDocuments += documentCount;
			statuses.push(sourceStatus(loaded, visibleRecords.length, documentCount));
		}
		return this.#statusFromParts(statuses, totalRecords, totalDocuments);
	}

	bindRead(principal: SecondBrainPrincipalPolicy): BoundSecondBrainReadApi {
		validatePrincipal(principal);
		const boundPrincipal = clonePrincipal(principal);
		return Object.freeze({
			query: (
				request: SecondBrainQueryRequest,
				options?: HybridQueryOptions,
			) => this.query(boundPrincipal, request, options),
			status: () => this.status(boundPrincipal),
		});
	}

	async prepareWrite(input: PrepareWriteInput): Promise<PreparedWriteReview> {
		return this.#requireWrites().prepareWrite(input);
	}

	async approveAndCommitWrite(preparedId: string): Promise<WriteReceipt> {
		return this.#requireWrites().approveAndCommitWrite(preparedId);
	}

	prepareRollback(input: PrepareRollbackInput): PreparedRollbackReview {
		return this.#requireWrites().prepareRollback(input);
	}

	async approveAndRollback(preparedId: string): Promise<RollbackReceipt> {
		return this.#requireWrites().approveAndRollback(preparedId);
	}

	async #reloadNow(sourceIds: readonly string[]): Promise<SecondBrainStatus> {
		const loaded = await Promise.all(sourceIds.map(async (sourceId) => {
			const descriptor = this.#sourcesById.get(sourceId);
			if (!descriptor) throw new Error('Cannot reload an unknown source.');
			return loadCompiledSource(
				descriptor,
				this.#options.embeddingAdapter,
				this.#requirePrecomputedVectors,
			);
		}));
		const candidateById = new Map(this.#loadedById);
		for (const item of loaded) candidateById.set(item.descriptor.sourceId, item);
		if (candidateById.size !== this.#sources.length) {
			throw new Error('Second-brain runtime has not loaded every configured source.');
		}
		const ordered = this.#sources.map((source) => {
			const item = candidateById.get(source.sourceId);
			if (!item) throw new Error('Second-brain runtime source snapshot is incomplete.');
			return item;
		});
		const records = ordered.flatMap((item) => [...item.records]);
		assertUniqueRecordIds(records);
		const vectorArtifact = combineVectorArtifacts(
			ordered,
			this.#options.embeddingAdapter,
			this.#requirePrecomputedVectors,
		);
		const bm25Artifact = combineBm25Artifacts(ordered);
		const engineOptions: HybridEngineCreateOptions = {
			embeddingAdapter: this.#options.embeddingAdapter,
			...(vectorArtifact === undefined ? {} : { vectorArtifact }),
			...(bm25Artifact === undefined ? {} : { bm25Artifact }),
			...(this.#options.reranker === undefined ? {} : { reranker: this.#options.reranker }),
			...(this.#options.channelWeights === undefined
				? {}
				: { channelWeights: this.#options.channelWeights }),
		};
		const engine = await HybridQueryEngine.create(records, engineOptions);
		// Publish the complete new view only after all validation/index construction succeeds.
		this.#loadedById = candidateById;
		this.#engine = engine;
		this.#precomputed = vectorArtifact !== undefined || records.length === 0;
		this.#revision += 1;
		return this.#operatorStatus();
	}

	#initializeControlledWrites(): void {
		const hasWritableSources = this.#sources.some((source) => source.writable !== undefined);
		if (!hasWritableSources) return;
		const { humanApprovalBroker, approvalSecret, writeStateRoot } = this.#options;
		if (!humanApprovalBroker || approvalSecret === undefined || writeStateRoot === undefined) {
			throw new TypeError(
				'Writable sources require a humanApprovalBroker, approvalSecret, and writeStateRoot.',
			);
		}
		this.#writes = new SecondBrainControlledWrites({
			sources: this.#sources,
			broker: humanApprovalBroker,
			approvalSecret,
			stateRoot: writeStateRoot,
			hooks: {
				assertAuthorized: (principal, source, documentPath) => (
					this.#assertWriteAuthorized(principal, source, documentPath)
				),
				requestReingest: (source) => this.#requestReingest(source),
				observe: (source) => this.#observeReingest(source),
			},
			...(this.#options.pendingReviewTtlMs === undefined
				? {}
				: { pendingReviewTtlMs: this.#options.pendingReviewTtlMs }),
			...(this.#options.maximumPendingReviews === undefined
				? {}
				: { maximumPendingReviews: this.#options.maximumPendingReviews }),
			...(this.#options.approvalTokenTtlMs === undefined
				? {}
				: { approvalTokenTtlMs: this.#options.approvalTokenTtlMs }),
			...(this.#options.allowCriticalWrites === undefined
				? {}
				: { allowCriticalWrites: this.#options.allowCriticalWrites }),
		});
	}

	#assertWriteAuthorized(
		principal: SecondBrainPrincipalPolicy,
		source: SecondBrainSourceDescriptor,
		documentPath: string,
	): void {
		validatePrincipal(principal);
		if (!principal.allowedSourceIds.includes(source.sourceId)) throw new Error('Source is not writable.');
		if (
			source.projectId !== undefined
			&& !(principal.allowedProjectIds ?? []).includes(source.projectId)
		) throw new Error('Source is not writable.');
		if (!isPathAllowedByPrefixes(
			documentPath,
			principal.includedPathPrefixes,
			principal.excludedPathPrefixes,
		)) throw new Error('Document path is not writable.');
	}

	async #requestReingest(sourceRef: SourceRef): Promise<void> {
		const source = this.#sourcesById.get(sourceRef.sourceId);
		const binding = source?.writable;
		if (
			!source
			|| !binding
			|| binding.adapter.adapterId !== sourceRef.adapterId
		) throw new Error('Reingest source is not writable.');
		const previous = this.#reingestTails.get(source.sourceId) ?? Promise.resolve();
		const execute = (): Promise<void> => this.#requestReingestNow(source, binding, sourceRef);
		const task = previous.then(execute, execute);
		const settled = task.then(() => undefined, () => undefined);
		this.#reingestTails.set(source.sourceId, settled);
		try {
			await task;
		} finally {
			if (this.#reingestTails.get(source.sourceId) === settled) {
				this.#reingestTails.delete(source.sourceId);
			}
		}
	}

	async #requestReingestNow(
		source: SecondBrainSourceDescriptor,
		binding: WritableDirectoryBinding,
		sourceRef: SourceRef,
	): Promise<void> {
		const published = this.#loadedById.get(source.sourceId)?.generation;
		if (!published) throw new Error('Writable runtime source has no published generation.');
		const expectedGenerationId = published.generationId;
		const expectedManifestSha256 = published.manifestSha256;
		const build = await binding.compiler.build();
		const exactCandidate: SecondBrainSourceDescriptor = {
			...source,
			pinnedGenerationId: build.generation.generationId,
			pinnedManifestSha256: build.generation.manifestSha256,
		};
		// Do not make a generation durable in the runtime catalog until the exact
		// immutable payload has passed the same cross-layer checks as startup.
		await loadCompiledSource(
			exactCandidate,
			this.#options.embeddingAdapter,
			this.#requirePrecomputedVectors,
		);
		await this.#options.onGenerationPublished?.(
			source.sourceId,
			build.generation.generationId,
			build.generation.manifestSha256,
			expectedGenerationId,
			expectedManifestSha256,
		);
		source.pinnedGenerationId = build.generation.generationId;
		source.pinnedManifestSha256 = build.generation.manifestSha256;
		await this.reload([source.sourceId]);
	}

	async #observeReingest(sourceRef: SourceRef): Promise<ReingestObservation | null> {
		const loaded = this.#loadedById.get(sourceRef.sourceId);
		if (!loaded) return null;
		const document = loaded.generation.bundle.layers.derived.data.documents
			.find((candidate) => candidate.path === sourceRef.documentPath);
		if (document) {
			return {
				state: 'present',
				versionId: document.versionId as VersionId,
				searchable: document.chunks.length > 0,
				generationId: loaded.generation.generationId,
			};
		}
		const catalog = loaded.generation.bundle.layers.catalog.data.entries
			.find((candidate) => candidate.path === sourceRef.documentPath);
		const absent = catalog === undefined || catalog.tombstoneAt !== null;
		if (!absent) {
			const configured = this.#sourcesById.get(sourceRef.sourceId);
			const snapshot = await configured?.writable?.adapter.inspect(sourceRef);
			if (snapshot) {
				return {
					state: 'present',
					versionId: snapshot.baseVersion.versionId,
					searchable: false,
					generationId: loaded.generation.generationId,
				};
			}
		}
		return {
			state: 'absent',
			versionId: null,
			searchable: absent,
			generationId: loaded.generation.generationId,
		};
	}

	#requireWrites(): SecondBrainControlledWrites {
		if (!this.#writes) throw new Error('Controlled writes are not configured.');
		return this.#writes;
	}

	#operatorStatus(): SecondBrainStatus {
		const statuses = this.#sources.flatMap((source) => {
			const loaded = this.#loadedById.get(source.sourceId);
			return loaded ? [sourceStatus(loaded, loaded.records.length, loaded.activeDocuments)] : [];
		});
		return this.#statusFromParts(
			statuses,
			statuses.reduce((sum, source) => sum + source.records, 0),
			statuses.reduce((sum, source) => sum + source.activeDocuments, 0),
		);
	}

	#statusFromParts(
		sources: readonly SecondBrainSourceStatus[],
		records: number,
		activeDocuments: number,
	): SecondBrainStatus {
		return {
			ready: true,
			revision: this.#revision,
			sourceCount: sources.length,
			activeDocuments,
			records,
			vector: {
				adapterId: this.#options.embeddingAdapter.id,
				modelId: this.#options.embeddingAdapter.modelId,
				embeddingKind: this.#options.embeddingAdapter.kind,
				inputRecipe: EMBEDDING_INPUT_RECIPE,
				dimension: this.#options.embeddingAdapter.dimension,
				precomputed: this.#precomputed,
			},
			sources: sources.map((source) => ({ ...source })),
		};
	}
}

function combineVectorArtifacts(
	loaded: readonly LoadedCompiledSource[],
	adapter: SecondBrainRuntimeOptions['embeddingAdapter'],
	requirePrecomputed: boolean,
): QueryVectorArtifact | undefined {
	const withRecords = loaded.filter((source) => source.records.length > 0);
	if (withRecords.length === 0) return undefined;
	if (withRecords.some((source) => source.vectorArtifact === null)) {
		if (requirePrecomputed) throw new Error('A compiled source is missing required precomputed vectors.');
		// Explicit compatibility mode: rebuild all vectors from compiled chunks,
		// never a partial dense index and never the source filesystem.
		return undefined;
	}
	return {
		schemaVersion: 1,
		adapterId: adapter.id,
		modelId: adapter.modelId,
		embeddingKind: adapter.kind,
		inputRecipe: EMBEDDING_INPUT_RECIPE,
		dimension: adapter.dimension,
		entries: withRecords.flatMap((source) => [...(source.vectorArtifact?.entries ?? [])]),
	};
}

function combineBm25Artifacts(
	loaded: readonly LoadedCompiledSource[],
): Bm25Artifact | undefined {
	const withRecords = loaded.filter((source) => source.records.length > 0);
	if (withRecords.length === 0) return undefined;
	return {
		schemaVersion: 1,
		entries: withRecords.flatMap((source) => [...source.bm25Artifact.entries]),
	};
}

function assertUniqueRecordIds(records: readonly HybridRecord[]): void {
	const seen = new Set<string>();
	for (const record of records) {
		if (seen.has(record.id)) throw new Error('Configured sources contain a duplicate chunk record ID.');
		seen.add(record.id);
	}
}

function sourceStatus(
	loaded: LoadedCompiledSource,
	records: number,
	activeDocuments: number,
): SecondBrainSourceStatus {
	return {
		sourceId: loaded.descriptor.sourceId,
		label: loaded.descriptor.label,
		kind: loaded.descriptor.kind,
		generationId: loaded.generation.generationId,
		compiledAt: loaded.generation.bundle.createdAt,
		activeDocuments,
		records,
		projectScoped: loaded.descriptor.projectId !== undefined,
		writable: loaded.descriptor.writable !== undefined,
	};
}

function validatePrincipal(principal: SecondBrainPrincipalPolicy): void {
	validateLogicalIdentifier(principal.principalId, 'principalId');
	assertBoundedArray(principal.allowedSourceIds, MAXIMUM_FILTER_IDS, 'allowedSourceIds');
	assertBoundedArray(principal.allowedProjectIds ?? [], MAXIMUM_FILTER_IDS, 'allowedProjectIds');
	assertBoundedArray(principal.allowedModes, RETRIEVAL_MODES.size, 'allowedModes');
	assertBoundedArray(principal.includedPathPrefixes ?? [], MAXIMUM_PATH_PREFIXES, 'includedPathPrefixes');
	assertBoundedArray(principal.excludedPathPrefixes ?? [], MAXIMUM_PATH_PREFIXES, 'excludedPathPrefixes');
	for (const sourceId of principal.allowedSourceIds) validateLogicalIdentifier(sourceId, 'allowed sourceId');
	for (const projectId of principal.allowedProjectIds ?? []) validateLogicalIdentifier(projectId, 'allowed projectId');
	for (const prefix of principal.includedPathPrefixes ?? []) validatePathFilter(prefix, 'included path prefix');
	for (const prefix of principal.excludedPathPrefixes ?? []) validatePathFilter(prefix, 'excluded path prefix');
	for (const mode of principal.allowedModes) {
		if (!RETRIEVAL_MODES.has(mode)) throw new TypeError('Principal contains an invalid retrieval mode.');
	}
}

function validateQueryRequest(request: SecondBrainQueryRequest): void {
	if (typeof request.text !== 'string' || request.text.length > 32_000) {
		throw new TypeError('Query text must be a string no longer than 32000 characters.');
	}
	assertBoundedArray(request.sourceIds ?? [], MAXIMUM_FILTER_IDS, 'query sourceIds');
	assertBoundedArray(request.projectIds ?? [], MAXIMUM_FILTER_IDS, 'query projectIds');
	assertBoundedArray(request.seedRecordIds ?? [], MAXIMUM_SEED_IDS, 'query seedRecordIds');
	for (const sourceId of request.sourceIds ?? []) validateLogicalIdentifier(sourceId, 'query sourceId');
	for (const projectId of request.projectIds ?? []) validateLogicalIdentifier(projectId, 'query projectId');
	for (const recordId of request.seedRecordIds ?? []) validateLogicalIdentifier(recordId, 'query seedRecordId');
	if (request.temporal !== undefined) {
		const { after, before, preferRecent } = request.temporal;
		if (
			(after !== undefined && !Number.isFinite(after))
			|| (before !== undefined && !Number.isFinite(before))
			|| (preferRecent !== undefined && typeof preferRecent !== 'boolean')
			|| (after !== undefined && before !== undefined && after > before)
		) throw new TypeError('Query temporal constraint is invalid.');
	}
}

function validateLogicalIdentifier(value: string, label: string): void {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| value.length > 512
		|| value.includes('\0')
	) throw new TypeError(`${label} is invalid.`);
}

function validatePathFilter(value: string, label: string): void {
	if (typeof value !== 'string' || value.length > 4_096 || value.includes('\0')) {
		throw new TypeError(`${label} is invalid.`);
	}
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function permissionRefusal(
	query: string,
	mode: HybridRetrievalMode,
	deadlineMs: number,
	elapsedMs: number,
): EvidencePack {
	return {
		status: 'no_evidence',
		query,
		mode,
		evidence: [],
		failures: [],
		partial: false,
		elapsedMs,
		deadlineMs,
		refusal: {
			code: 'no_evidence',
			message: 'No visible, attributable evidence matched the query.',
		},
	};
}

function timeoutRefusal(
	query: string,
	mode: HybridRetrievalMode,
	deadlineMs: number,
	elapsedMs: number,
): EvidencePack {
	return {
		status: 'timeout',
		query,
		mode,
		evidence: [],
		failures: [],
		partial: false,
		elapsedMs,
		deadlineMs,
		refusal: {
			code: 'timeout',
			message: 'Retrieval exceeded its deadline; no evidence was released.',
		},
	};
}

function boundedDeadline(value: number | undefined): number {
	const candidate = value ?? HARD_QUERY_DEADLINE_MS;
	if (!Number.isFinite(candidate) || candidate <= 0) throw new TypeError('deadlineMs must be positive.');
	return Math.min(HARD_QUERY_DEADLINE_MS, Math.max(1, Math.floor(candidate)));
}

function assertBoundedArray(values: readonly unknown[], maximum: number, label: string): void {
	if (!Array.isArray(values) || values.length > maximum) {
		throw new TypeError(`${label} must contain at most ${maximum} values.`);
	}
}

function cloneDescriptor(source: SecondBrainSourceDescriptor): SecondBrainSourceDescriptor {
	return {
		sourceId: source.sourceId,
		label: source.label,
		kind: source.kind,
		generationRoot: source.generationRoot,
		...(source.pinnedGenerationId === undefined
			? {}
			: { pinnedGenerationId: source.pinnedGenerationId }),
		...(source.pinnedManifestSha256 === undefined
			? {}
			: { pinnedManifestSha256: source.pinnedManifestSha256 }),
		...(source.projectId === undefined ? {} : { projectId: source.projectId }),
		...(source.writable === undefined
			? {}
			: { writable: { compiler: source.writable.compiler, adapter: source.writable.adapter } }),
	};
}

function clonePrincipal(principal: SecondBrainPrincipalPolicy): SecondBrainPrincipalPolicy {
	return Object.freeze({
		principalId: principal.principalId,
		allowedSourceIds: Object.freeze([...principal.allowedSourceIds]),
		...(principal.allowedProjectIds === undefined
			? {}
			: { allowedProjectIds: Object.freeze([...principal.allowedProjectIds]) }),
		allowedModes: Object.freeze([...principal.allowedModes]),
		...(principal.includedPathPrefixes === undefined
			? {}
			: { includedPathPrefixes: Object.freeze([...principal.includedPathPrefixes]) }),
		...(principal.excludedPathPrefixes === undefined
			? {}
			: { excludedPathPrefixes: Object.freeze([...principal.excludedPathPrefixes]) }),
	});
}
