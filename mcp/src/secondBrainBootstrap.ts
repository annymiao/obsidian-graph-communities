import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { SafeDirectoryWriterAdapter } from './adapters/directoryWriter.js';
import { OfflineKnowledgeCompiler } from './compiler/offlineKnowledgeCompiler.js';
import { loadKnowledgeServiceConfig, type KnowledgeServiceConfig } from './config.js';
import {
	DeterministicLocalEmbedding,
	LoopbackEmbeddingAdapter,
	type EmbeddingAdapter,
} from './hybrid/embedding.js';
import type { RerankerAdapter, RerankerContext, RerankerResult } from './hybrid/types.js';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateFileHandle,
	assertPrivateFilePath,
	ensurePrivateDirectory,
	readPrivateFile,
	syncPrivateDirectory,
} from './privateFs.js';
import { withPrivateDirectoryLock } from './persistence/privateDirectoryLock.js';
import { readTransmissionReviewMode, type TransmissionReviewMode } from './reviewPolicy.js';
import { createSourceId, normalizeDocumentPath, type SourceId } from './stableIds.js';
import { createOfflineEmbeddingProvider } from './secondBrain/embeddingBridge.js';
import { SecondBrainRuntime } from './secondBrain/index.js';
import type {
	HumanApprovalBroker,
	HumanApprovalDecision,
	HumanApprovalReview,
	SecondBrainPrincipalPolicy,
	SecondBrainSourceDescriptor,
} from './secondBrain/types.js';
import type { ServerConfig } from './types.js';
import { canonicalJson, sha256 } from './write/integrity.js';

const DEFAULT_EMBEDDING_DIMENSION = 384;
const DEFAULT_RERANK_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_RERANK_REQUEST_BYTES = 8 * 1024 * 1024;
const MAXIMUM_RUNTIME_CATALOG_BYTES = 2 * 1024 * 1024;
const RUNTIME_CATALOG_SCHEMA_VERSION = 3 as const;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const LOGICAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SOURCE_ID_PATTERN = /^src_v1_[A-Za-z0-9_-]{43}$/u;
const GENERATION_ID_PATTERN = /^gen-[0-9]{13}-[a-f0-9]{32}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RETRIEVAL_MODES = ['default', 'project', 'reference', 'history'] as const;

export interface ConfiguredSecondBrainSource {
	/** Private local configuration. Do not serialize this object into an API response. */
	config: ServerConfig;
	compiler: OfflineKnowledgeCompiler;
	descriptor: SecondBrainSourceDescriptor;
}

export interface SecondBrainBuildConfiguration {
	knowledgeConfig: KnowledgeServiceConfig;
	embeddingAdapter: EmbeddingAdapter;
	reranker?: RerankerAdapter;
	principal: SecondBrainPrincipalPolicy;
	sources: readonly ConfiguredSecondBrainSource[];
	writeStateRoot?: string;
	runtimeCatalogPath: string;
}

export interface SecondBrainGenerationPin {
	sourceId: string;
	generationId: string;
	manifestSha256: string;
}

export type RuntimeCatalogConflictCode =
	| 'RUNTIME_CATALOG_PINS_CHANGED'
	| 'RUNTIME_CATALOG_BINDING_CHANGED'
	| 'RUNTIME_CATALOG_SOURCE_BINDING_CHANGED'
	| 'RUNTIME_CATALOG_SOURCE_PIN_CHANGED';

/** A valid concurrent publisher won a compare-and-swap race; callers may retry from a fresh snapshot. */
export class RuntimeCatalogConflictError extends Error {
	readonly code: RuntimeCatalogConflictCode;
	readonly retryable: boolean;

	constructor(code: RuntimeCatalogConflictCode, message: string) {
		super(message);
		this.name = 'RuntimeCatalogConflictError';
		this.code = code;
		this.retryable = code === 'RUNTIME_CATALOG_PINS_CHANGED';
	}
}

export interface SecondBrainBootstrap {
	runtime: SecondBrainRuntime;
	approvalBroker: OneTimeHumanApprovalBroker;
	principal: SecondBrainPrincipalPolicy;
	embeddingAdapter: EmbeddingAdapter;
	reranker?: RerankerAdapter;
	transmissionReviewMode: TransmissionReviewMode;
	/** True only after trusted MCP App opt-in and at least one writable source are both present. */
	controlledWritesEnabled: boolean;
}

interface RuntimeCatalogWritableSource {
	sourceRoot: string;
	compilerStateRoot: string;
	writerStateRoot: string;
	maximumWriterFileBytes: number;
	compilerPolicy: OfflineKnowledgeCompiler['policy'];
}

interface RuntimeCatalogSource {
	sourceId: string;
	label: string;
	kind: 'directory' | 'obsidian-vault';
	projectId?: string;
	generationRoot: string;
	generationId: string;
	manifestSha256: string;
	writable?: RuntimeCatalogWritableSource;
}

interface RuntimeCatalogMaterial {
	schemaVersion: typeof RUNTIME_CATALOG_SCHEMA_VERSION;
	createdAt: string;
	/** Hash-only fence for the complete trusted offline deployment configuration. */
	deploymentConfigSha256: string;
	embedding: {
		adapterId: string;
		modelId: string;
		kind: EmbeddingAdapter['kind'];
		dimension: number;
	};
	sources: RuntimeCatalogSource[];
	writeStateRoot?: string;
}

interface RuntimeCatalogEnvelope {
	catalog: RuntimeCatalogMaterial;
	sha256: string;
}

interface StagedHumanDecision {
	bindingHash: string;
	approved: boolean;
	approvedBy?: string;
}

interface TrackedHumanReview {
	reviewJson: string;
	approvalDocument: string;
	expiresAt: number;
	decision?: StagedHumanDecision;
}

/**
 * Process-local bridge between a private UI result and the runtime's private
 * ApprovalTokenAuthority. It accepts exactly one decision for an exact review;
 * neither this broker nor the signed ApprovalToken is exposed as an MCP tool.
 */
export class OneTimeHumanApprovalBroker implements HumanApprovalBroker {
	readonly #tracked = new Map<string, TrackedHumanReview>();
	readonly #maximumTracked: number;

	constructor(maximumTracked = 100) {
		this.#maximumTracked = boundedInteger(
			maximumTracked,
			1,
			1_000,
			'maximum tracked human reviews',
		);
	}

	registerReview(review: Readonly<HumanApprovalReview>): string {
		this.#pruneExpired();
		const expiresAt = Date.parse(review.expiresAt);
		if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
			throw new Error('Human review is already expired.');
		}
		if (this.#tracked.has(review.preparedId)) throw new Error('Human review is already registered.');
		if (this.#tracked.size >= this.#maximumTracked) {
			throw new Error('Human review broker capacity reached.');
		}
		const approvalDocument = renderApprovalDocument(review);
		this.#tracked.set(review.preparedId, {
			reviewJson: canonicalJson(review),
			approvalDocument,
			expiresAt,
		});
		return approvalDocument;
	}

	stageExactDecision(input: {
		preparedId: string;
		bindingHash: string;
		approvedDocument: string;
		approvedBy: string;
	}): boolean {
		this.#pruneExpired();
		const tracked = this.#tracked.get(input.preparedId);
		if (!tracked || tracked.decision !== undefined) return false;
		const exact = input.approvedDocument === tracked.approvalDocument;
		tracked.decision = exact
			? {
				bindingHash: input.bindingHash,
				approved: true,
				approvedBy: normalizeReviewer(input.approvedBy),
			}
			: { bindingHash: input.bindingHash, approved: false };
		return exact;
	}

	stageDenial(preparedId: string, bindingHash: string): void {
		this.#pruneExpired();
		const tracked = this.#tracked.get(preparedId);
		if (!tracked || tracked.decision !== undefined) return;
		tracked.decision = { bindingHash, approved: false };
	}

	async requestApproval(
		review: Readonly<HumanApprovalReview>,
	): Promise<HumanApprovalDecision> {
		this.#pruneExpired();
		const tracked = this.#tracked.get(review.preparedId);
		const decision = tracked?.decision;
		const exactReview = tracked?.reviewJson === canonicalJson(review);
		const approvedBy = decision?.approved === true ? decision.approvedBy : undefined;
		this.#forget(review.preparedId);
		if (
			!tracked
			|| !exactReview
			|| decision === undefined
			|| decision.bindingHash !== review.bindingHash
			|| !decision.approved
		) {
			return {
				approved: false,
				bindingHash: review.bindingHash,
				reason: 'No exact, one-time local human approval was available.',
			};
		}
		return {
			approved: true,
			bindingHash: review.bindingHash,
			approvedBy: approvedBy ?? 'local-human:mcp-app',
		};
	}

	#pruneExpired(): void {
		const now = Date.now();
		for (const [preparedId, review] of this.#tracked) {
			if (review.expiresAt <= now) this.#forget(preparedId);
		}
	}

	#forget(preparedId: string): void {
		const tracked = this.#tracked.get(preparedId);
		if (tracked) {
			tracked.reviewJson = '';
			tracked.approvalDocument = '';
			delete tracked.decision;
		}
		this.#tracked.delete(preparedId);
	}
}

/** Fixed-loopback reranker; host, scheme and path cannot be redirected by configuration. */
export class LoopbackRerankerAdapter implements RerankerAdapter {
	readonly id: string;
	readonly #port: number;
	readonly #model: string;
	readonly #maximumResponseBytes: number;

	constructor(options: { port: number; model: string; maximumResponseBytes?: number }) {
		this.#port = boundedInteger(options.port, 1_024, 65_535, 'reranker port');
		if (!/^[\w./:-]{1,160}$/u.test(options.model)) {
			throw new Error('Loopback reranker model identifier is invalid.');
		}
		this.#model = options.model;
		this.#maximumResponseBytes = boundedInteger(
			options.maximumResponseBytes ?? DEFAULT_RERANK_RESPONSE_BYTES,
			1_024,
			32 * 1024 * 1024,
			'reranker maximum response bytes',
		);
		this.id = `loopback-reranker:${options.model}`;
	}

	async rerank(context: RerankerContext): Promise<readonly RerankerResult[]> {
		if (context.signal.aborted || Date.now() >= context.deadlineAt) {
			throw new Error('Reranker request was cancelled.');
		}
		const payload = JSON.stringify({
			model: this.#model,
			query: context.query.text,
			documents: context.candidates.map((candidate) => ({
				title: candidate.record.title,
				heading: candidate.record.heading,
				text: candidate.record.content,
			})),
		});
		if (Buffer.byteLength(payload, 'utf8') > MAXIMUM_RERANK_REQUEST_BYTES) {
			throw new Error('Reranker request exceeded the local byte limit.');
		}
		const response = await fetch(`http://127.0.0.1:${this.#port}/v1/rerank`, {
			method: 'POST',
			redirect: 'error',
			headers: { 'content-type': 'application/json' },
			body: payload,
			signal: context.signal,
		});
		if (!response.ok) throw new Error(`Loopback reranker returned HTTP ${response.status}.`);
		const bytes = await readBoundedResponse(response, this.#maximumResponseBytes);
		const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
		return parseRerankerResponse(parsed, context);
	}
}

export function loadSecondBrainEmbeddingAdapter(
	environment: NodeJS.ProcessEnv = process.env,
): EmbeddingAdapter {
	const provider = optionalEnvironmentValue(environment.OBSIDIAN_EMBEDDING_PROVIDER) ?? 'deterministic';
	const dimension = optionalStrictInteger(
		environment.OBSIDIAN_EMBEDDING_DIMENSION,
		DEFAULT_EMBEDDING_DIMENSION,
		32,
		4_096,
		'OBSIDIAN_EMBEDDING_DIMENSION',
	);
	if (provider === 'deterministic') {
		forbidEnvironmentValues(environment, [
			'OBSIDIAN_EMBEDDING_PORT',
			'OBSIDIAN_EMBEDDING_MODEL',
			'OBSIDIAN_EMBEDDING_URL',
		], 'deterministic embedding');
		return new DeterministicLocalEmbedding(dimension);
	}
	if (provider !== 'loopback') {
		throw new Error('OBSIDIAN_EMBEDDING_PROVIDER must be deterministic or loopback.');
	}
	if (optionalEnvironmentValue(environment.OBSIDIAN_EMBEDDING_URL) !== undefined) {
		throw new Error('OBSIDIAN_EMBEDDING_URL is not supported; loopback host and path are fixed.');
	}
	const model = requiredEnvironmentValue(
		environment.OBSIDIAN_EMBEDDING_MODEL,
		'OBSIDIAN_EMBEDDING_MODEL',
	);
	const port = optionalStrictInteger(
		environment.OBSIDIAN_EMBEDDING_PORT,
		undefined,
		1_024,
		65_535,
		'OBSIDIAN_EMBEDDING_PORT',
	);
	return new LoopbackEmbeddingAdapter({ port, model, dimension });
}

export function loadSecondBrainReranker(
	environment: NodeJS.ProcessEnv = process.env,
): RerankerAdapter | undefined {
	const provider = optionalEnvironmentValue(environment.OBSIDIAN_RERANKER_PROVIDER) ?? 'none';
	if (provider === 'none') {
		forbidEnvironmentValues(environment, [
			'OBSIDIAN_RERANKER_PORT',
			'OBSIDIAN_RERANKER_MODEL',
			'OBSIDIAN_RERANKER_URL',
		], 'disabled reranker');
		return undefined;
	}
	if (provider !== 'loopback') {
		throw new Error('OBSIDIAN_RERANKER_PROVIDER must be none or loopback.');
	}
	if (optionalEnvironmentValue(environment.OBSIDIAN_RERANKER_URL) !== undefined) {
		throw new Error('OBSIDIAN_RERANKER_URL is not supported; loopback host and path are fixed.');
	}
	return new LoopbackRerankerAdapter({
		model: requiredEnvironmentValue(environment.OBSIDIAN_RERANKER_MODEL, 'OBSIDIAN_RERANKER_MODEL'),
		port: optionalStrictInteger(
			environment.OBSIDIAN_RERANKER_PORT,
			undefined,
			1_024,
			65_535,
			'OBSIDIAN_RERANKER_PORT',
		),
	});
}

export async function loadSecondBrainBuildConfiguration(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<SecondBrainBuildConfiguration> {
	const knowledgeConfig = await loadKnowledgeServiceConfig(environment);
	const runtimeCatalogPath = await resolveSecondBrainRuntimeCatalogPath(environment);
	await assertOutsideGitWorktree(runtimeCatalogPath, 'Runtime catalog');
	for (const source of knowledgeConfig.sources) {
		if (pathsOverlap(runtimeCatalogPath, source.vaultPath)) {
			throw new Error('Runtime catalog must be outside every configured source.');
		}
		if (!source.artifactPath) {
			throw new Error('Second-brain compilation requires persistent artifact storage.');
		}
		await assertOutsideGitWorktree(
			path.join(source.artifactPath, 'second-brain-v1'),
			'Compiled artifact state',
		);
	}
	const embeddingAdapter = loadSecondBrainEmbeddingAdapter(environment);
	const reranker = loadSecondBrainReranker(environment);
	const sources = knowledgeConfig.sources.map((config, index) => {
		return configureSource(config, index, embeddingAdapter);
	});
	const principal = loadPrincipalPolicy(environment, sources.map((source) => source.descriptor));
	const writeStateRoot = sources.some((source) => source.descriptor.writable !== undefined)
		? await resolveWriteStateRoot(environment, sources)
		: undefined;
	if (writeStateRoot !== undefined) {
		await assertOutsideGitWorktree(
			path.join(writeStateRoot, '.private-state-sentinel'),
			'Controlled write state',
		);
	}
	return {
		knowledgeConfig,
		embeddingAdapter,
		...(reranker === undefined ? {} : { reranker }),
		principal,
		sources,
		...(writeStateRoot === undefined ? {} : { writeStateRoot }),
		runtimeCatalogPath,
	};
}

async function assertOutsideGitWorktree(candidatePath: string, label: string): Promise<void> {
	let directory = path.dirname(path.resolve(candidatePath));
	for (;;) {
		try {
			await lstat(path.join(directory, '.git'));
			throw new Error(`${label} must be outside every Git worktree.`);
		} catch (error) {
			if (!isNodeError(error, 'ENOENT')) throw error;
		}
		const parent = path.dirname(directory);
		if (parent === directory) return;
		directory = parent;
	}
}

export async function createSecondBrainBootstrap(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<SecondBrainBootstrap> {
	const runtimeCatalogPath = await resolveSecondBrainRuntimeCatalogPath(environment);
	const catalog = await readSecondBrainRuntimeCatalog(runtimeCatalogPath);
	await assertRuntimeCatalogStorageBoundaries(runtimeCatalogPath, catalog);
	const embeddingAdapter = loadSecondBrainEmbeddingAdapter(environment);
	assertEmbeddingMatchesCatalog(embeddingAdapter, catalog);
	const reranker = loadSecondBrainReranker(environment);
	const trustedWriteApprovalEnabled = readMcpWriteApprovalMode(environment) === 'trusted-mcp-app';
	const sources = catalog.sources.map((source) => sourceFromRuntimeCatalog(
		source,
		embeddingAdapter,
		trustedWriteApprovalEnabled,
	));
	const sourceBindingChecksums = new Map(catalog.sources.map((source) => [
		source.sourceId,
		runtimeCatalogSourceBindingChecksum(catalog, source.sourceId),
	]));
	const principal = loadPrincipalPolicy(environment, sources);
	const approvalBroker = new OneTimeHumanApprovalBroker();
	const hasWritable = sources.some((source) => source.writable !== undefined);
	const controlledWritesEnabled = trustedWriteApprovalEnabled && hasWritable;
	let catalogUpdateTail: Promise<void> = Promise.resolve();
	const persistGenerationPin = async (
		sourceId: string,
		generationId: string,
		manifestSha256: string,
		expectedGenerationId: string,
		expectedManifestSha256: string,
	): Promise<void> => {
		const update = async (): Promise<void> => updateRuntimeCatalogGenerationPin(
			runtimeCatalogPath,
			sourceId,
			generationId,
			manifestSha256,
			expectedGenerationId,
			expectedManifestSha256,
			requireSourceBindingChecksum(sourceBindingChecksums, sourceId),
		);
		const task = catalogUpdateTail.then(update, update);
		catalogUpdateTail = task.then(() => undefined, () => undefined);
		await task;
	};
	const writableRuntimeOptions = hasWritable
		? {
			humanApprovalBroker: approvalBroker,
			approvalSecret: loadApprovalSecret(environment),
			writeStateRoot: requireWriteStateRoot(catalog.writeStateRoot),
			allowCriticalWrites: strictBoolean(
				environment.OBSIDIAN_ALLOW_CRITICAL_WRITES,
				false,
				'OBSIDIAN_ALLOW_CRITICAL_WRITES',
			),
			onGenerationPublished: persistGenerationPin,
		}
		: {};
	const runtime = await SecondBrainRuntime.open({
		sources,
		embeddingAdapter,
		...(reranker === undefined ? {} : { reranker }),
		requirePrecomputedVectors: true,
		...writableRuntimeOptions,
	});
	return {
		runtime,
		approvalBroker,
		principal,
		embeddingAdapter,
		...(reranker === undefined ? {} : { reranker }),
		transmissionReviewMode: readTransmissionReviewMode(environment.OBSIDIAN_TRANSMISSION_REVIEW),
		controlledWritesEnabled,
	};
}

async function assertRuntimeCatalogStorageBoundaries(
	runtimeCatalogPath: string,
	catalog: RuntimeCatalogMaterial,
): Promise<void> {
	const canonicalCatalogPath = await canonicalizePotentialPath(runtimeCatalogPath);
	await assertOutsideGitWorktree(canonicalCatalogPath, 'Runtime catalog');
	const writableSourceRoots = await Promise.all(catalog.sources.flatMap((source) => (
		source.writable === undefined
			? []
			: [canonicalizePotentialPath(source.writable.sourceRoot)]
	)));
	const storagePaths: Array<{ path: string; label: string }> = [];
	for (const source of catalog.sources) {
		storagePaths.push({
			path: await canonicalizePotentialPath(source.generationRoot),
			label: 'Compiled generation state',
		});
		if (source.writable !== undefined) {
			storagePaths.push(
				{
					path: await canonicalizePotentialPath(source.writable.compilerStateRoot),
					label: 'Compiler state',
				},
				{
					path: await canonicalizePotentialPath(source.writable.writerStateRoot),
					label: 'Writer state',
				},
			);
		}
	}
	if (catalog.writeStateRoot !== undefined) {
		storagePaths.push({
			path: await canonicalizePotentialPath(catalog.writeStateRoot),
			label: 'Controlled write state',
		});
	}
	for (const storage of storagePaths) {
		await assertOutsideGitWorktree(
			path.join(storage.path, '.private-state-sentinel'),
			storage.label,
		);
		for (const sourceRoot of writableSourceRoots) {
			if (pathsOverlap(storage.path, sourceRoot)) {
				throw new Error(`${storage.label} must be outside every writable source.`);
			}
		}
	}
	for (const sourceRoot of writableSourceRoots) {
		if (pathsOverlap(canonicalCatalogPath, sourceRoot)) {
			throw new Error('Runtime catalog must be outside every writable source.');
		}
	}
}

export function readMcpWriteApprovalMode(
	environment: NodeJS.ProcessEnv = process.env,
): 'disabled' | 'trusted-mcp-app' {
	const raw = optionalEnvironmentValue(environment.OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL);
	if (raw === undefined || raw === 'disabled') return 'disabled';
	if (raw === 'trusted-mcp-app') return raw;
	throw new Error(
		'OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL must be disabled or trusted-mcp-app.',
	);
}

/**
 * Atomically publishes the only online source catalog after every source has a
 * validated READY/CURRENT generation. Absolute paths stay in this 0600 local
 * file and are never part of a status, query or compiler summary response.
 */
export async function publishSecondBrainRuntimeCatalog(
	configuration: SecondBrainBuildConfiguration,
	pins: readonly SecondBrainGenerationPin[],
	expectedCatalogSha256: string | null,
): Promise<void> {
	const deploymentConfigSha256 = runtimeCatalogDeploymentConfigSha256(configuration);
	const pinsBySourceId = resolveExactGenerationPins(configuration, pins);
	const sources: RuntimeCatalogSource[] = [];
	for (const source of configuration.sources) {
		const descriptor = source.descriptor;
		const pin = pinsBySourceId.get(descriptor.sourceId);
		if (!pin) throw new Error('Every runtime catalog source requires an exact generation pin.');
		const base: RuntimeCatalogSource = {
			sourceId: descriptor.sourceId,
			label: descriptor.label,
			kind: descriptor.kind,
			generationRoot: descriptor.generationRoot,
			generationId: pin.generationId,
			manifestSha256: pin.manifestSha256,
			...(descriptor.projectId === undefined ? {} : { projectId: descriptor.projectId }),
		};
		if (descriptor.writable === undefined) {
			sources.push(base);
			continue;
		}
		const artifactPath = source.config.artifactPath;
		if (!artifactPath) throw new Error('Writable catalog source is missing artifact storage.');
		const privateRoot = path.join(artifactPath, 'second-brain-v1');
		sources.push({
			...base,
			writable: {
				sourceRoot: source.config.vaultPath,
				compilerStateRoot: path.join(privateRoot, 'compiler-state'),
				writerStateRoot: path.join(privateRoot, 'writer-state'),
				maximumWriterFileBytes: source.config.maxFileCharacters,
				compilerPolicy: structuredClone(source.compiler.policy),
			},
		});
	}
	const catalog: RuntimeCatalogMaterial = {
		schemaVersion: RUNTIME_CATALOG_SCHEMA_VERSION,
		createdAt: new Date().toISOString(),
		deploymentConfigSha256,
		embedding: {
			adapterId: configuration.embeddingAdapter.id,
			modelId: configuration.embeddingAdapter.modelId,
			kind: configuration.embeddingAdapter.kind,
			dimension: configuration.embeddingAdapter.dimension,
		},
		sources,
		...(configuration.writeStateRoot === undefined
			? {}
			: { writeStateRoot: configuration.writeStateRoot }),
	};
	validateRuntimeCatalog(catalog);
	await withPrivateDirectoryLock(runtimeCatalogLockPath(configuration.runtimeCatalogPath), async () => {
		const current = await readSecondBrainRuntimeCatalogEnvelope(
			configuration.runtimeCatalogPath,
			true,
		);
		if (current !== null && sameRuntimeCatalogSnapshot(current.catalog, catalog)) return;
		// The first successful publication owns this catalog path's deployment
		// binding. A later compiler may advance only generation pins for that exact
		// source/embedding/writer configuration. Otherwise two long-lived watchers
		// with different configurations could each accept the other's checksum as a
		// fresh baseline on the next round and oscillate the online authorization
		// boundary forever. Reconfiguration therefore requires stopping publishers
		// and selecting a new catalog path (or removing the old private derived
		// catalog as an explicit offline migration).
		if (current !== null && !sameRuntimeCatalogBinding(current.catalog, catalog)) {
			throw new RuntimeCatalogConflictError(
				'RUNTIME_CATALOG_BINDING_CHANGED',
				'Runtime catalog binding is owned by another deployment configuration.',
			);
		}
		if ((current?.sha256 ?? null) !== expectedCatalogSha256) {
			throw new RuntimeCatalogConflictError(
				current !== null
					? 'RUNTIME_CATALOG_PINS_CHANGED'
					: 'RUNTIME_CATALOG_BINDING_CHANGED',
				current !== null
					? 'Runtime catalog pins changed during offline compilation; retry from the new snapshot.'
					: 'Runtime catalog presence changed during offline compilation; refusing a stale publication.',
			);
		}
		await atomicWritePrivateJson(configuration.runtimeCatalogPath, {
			catalog,
			sha256: sha256(canonicalJson(catalog)),
		});
	});
}

function sameRuntimeCatalogSnapshot(
	first: RuntimeCatalogMaterial,
	second: RuntimeCatalogMaterial,
): boolean {
	const { createdAt: _firstCreatedAt, ...firstSnapshot } = first;
	const { createdAt: _secondCreatedAt, ...secondSnapshot } = second;
	return canonicalJson(firstSnapshot) === canonicalJson(secondSnapshot);
}

function sameRuntimeCatalogBinding(
	first: RuntimeCatalogMaterial,
	second: RuntimeCatalogMaterial,
): boolean {
	return canonicalJson(runtimeCatalogBindingSnapshot(first))
		=== canonicalJson(runtimeCatalogBindingSnapshot(second));
}

function runtimeCatalogBindingSnapshot(catalog: RuntimeCatalogMaterial): object {
	return {
		schemaVersion: catalog.schemaVersion,
		deploymentConfigSha256: catalog.deploymentConfigSha256,
		embedding: catalog.embedding,
		sources: catalog.sources.map(({ generationId: _generationId, manifestSha256: _manifest, ...source }) => (
			source
		)),
		...(catalog.writeStateRoot === undefined ? {} : { writeStateRoot: catalog.writeStateRoot }),
	};
}

function runtimeCatalogDeploymentConfigSha256(
	configuration: SecondBrainBuildConfiguration,
): string {
	const sources = configuration.sources.map((source) => {
		const artifactPath = source.config.artifactPath;
		if (!artifactPath) throw new Error('Compiled deployment source is missing artifact storage.');
		const descriptor = source.descriptor;
		const privateRoot = path.join(path.resolve(artifactPath), 'second-brain-v1');
		return {
			sourceId: descriptor.sourceId,
			label: descriptor.label,
			kind: descriptor.kind,
			projectId: descriptor.projectId ?? null,
			// Source roots are intentionally reduced to the final digest below. The
			// catalog never gains a locator for a read-only source.
			sourceRoot: path.resolve(source.config.vaultPath),
			generationRoot: path.resolve(descriptor.generationRoot),
			compilerPolicySha256: source.compiler.policyHash,
			writable: descriptor.writable === undefined
				? null
				: {
					adapterId: descriptor.writable.adapter.adapterId,
					compilerStateRoot: path.join(privateRoot, 'compiler-state'),
					writerStateRoot: path.join(privateRoot, 'writer-state'),
					maximumWriterFileBytes: source.config.maxFileCharacters,
				},
		};
	}).sort((first, second) => (
		first.sourceId < second.sourceId ? -1 : first.sourceId > second.sourceId ? 1 : 0
	));
	return sha256(canonicalJson({
		schemaVersion: RUNTIME_CATALOG_SCHEMA_VERSION,
		embedding: {
			adapterId: configuration.embeddingAdapter.id,
			modelId: configuration.embeddingAdapter.modelId,
			kind: configuration.embeddingAdapter.kind,
			dimension: configuration.embeddingAdapter.dimension,
		},
		sources,
		writeStateRoot: configuration.writeStateRoot === undefined
			? null
			: path.resolve(configuration.writeStateRoot),
	}));
}

/** Builds a complete query view before the catalog pointer becomes visible. */
export async function validateSecondBrainBuildArtifacts(
	configuration: SecondBrainBuildConfiguration,
	pins: readonly SecondBrainGenerationPin[],
): Promise<void> {
	const pinsBySourceId = resolveExactGenerationPins(configuration, pins);
	await SecondBrainRuntime.open({
		sources: configuration.sources.map((source) => {
			const descriptor = source.descriptor;
			const pin = pinsBySourceId.get(descriptor.sourceId);
			if (!pin) throw new Error('Every compiled source requires an exact generation pin.');
			return {
				sourceId: descriptor.sourceId,
				label: descriptor.label,
				kind: descriptor.kind,
				generationRoot: descriptor.generationRoot,
				pinnedGenerationId: pin.generationId,
				pinnedManifestSha256: pin.manifestSha256,
				...(descriptor.projectId === undefined ? {} : { projectId: descriptor.projectId }),
			};
		}),
		embeddingAdapter: configuration.embeddingAdapter,
		requirePrecomputedVectors: true,
	});
}

export async function readSecondBrainRuntimeCatalogChecksum(
	catalogPath: string,
): Promise<string | null> {
	return (await readSecondBrainRuntimeCatalogEnvelope(catalogPath, true))?.sha256 ?? null;
}

/**
 * Reads a publication baseline only when the existing catalog belongs to this
 * complete trusted build configuration. This runs before source compilation so
 * a differently configured watcher cannot advance shared physical generations
 * and only discover the conflict at final catalog publication.
 */
export async function readSecondBrainRuntimeCatalogChecksumForConfiguration(
	configuration: SecondBrainBuildConfiguration,
): Promise<string | null> {
	const envelope = await readSecondBrainRuntimeCatalogEnvelope(
		configuration.runtimeCatalogPath,
		true,
	);
	if (
		envelope !== null
		&& envelope.catalog.deploymentConfigSha256
			!== runtimeCatalogDeploymentConfigSha256(configuration)
	) {
		throw new RuntimeCatalogConflictError(
			'RUNTIME_CATALOG_BINDING_CHANGED',
			'Runtime catalog binding is owned by another deployment configuration.',
		);
	}
	return envelope?.sha256 ?? null;
}

/** @internal Test/coordination seam for source-binding compare-and-swap. */
export async function readSecondBrainRuntimeCatalogSourceBindingChecksum(
	catalogPath: string,
	sourceId: string,
): Promise<string> {
	if (!SOURCE_ID_PATTERN.test(sourceId)) throw new Error('Runtime catalog source binding is invalid.');
	const catalog = await readSecondBrainRuntimeCatalog(catalogPath);
	return runtimeCatalogSourceBindingChecksum(catalog, sourceId);
}

function runtimeCatalogSourceBindingChecksum(
	catalog: RuntimeCatalogMaterial,
	sourceId: string,
): string {
	const source = catalog.sources.find((candidate) => candidate.sourceId === sourceId);
	if (!source) throw new Error('Runtime catalog source binding is missing.');
	const {
		generationId: _generationId,
		manifestSha256: _manifestSha256,
		...sourceBinding
	} = source;
	return sha256(canonicalJson({
		schemaVersion: catalog.schemaVersion,
		deploymentConfigSha256: catalog.deploymentConfigSha256,
		embedding: catalog.embedding,
		writeStateRoot: catalog.writeStateRoot ?? null,
		source: sourceBinding,
	}));
}

function requireSourceBindingChecksum(
	checksums: ReadonlyMap<string, string>,
	sourceId: string,
): string {
	const checksum = checksums.get(sourceId);
	if (!checksum) throw new Error('Runtime catalog source binding is missing.');
	return checksum;
}

function resolveExactGenerationPins(
	configuration: SecondBrainBuildConfiguration,
	pins: readonly SecondBrainGenerationPin[],
): ReadonlyMap<string, SecondBrainGenerationPin> {
	if (!Array.isArray(pins) || pins.length !== configuration.sources.length) {
		throw new Error('Runtime catalog generation pins must exactly cover every configured source.');
	}
	const configuredSourceIds = new Set<string>(
		configuration.sources.map((source) => source.descriptor.sourceId),
	);
	const resolved = new Map<string, SecondBrainGenerationPin>();
	for (const pin of pins) {
		if (
			!isRecord(pin)
			|| typeof pin.sourceId !== 'string'
			|| !configuredSourceIds.has(pin.sourceId)
			|| resolved.has(pin.sourceId)
			|| typeof pin.generationId !== 'string'
			|| !GENERATION_ID_PATTERN.test(pin.generationId)
			|| typeof pin.manifestSha256 !== 'string'
			|| !SHA256_PATTERN.test(pin.manifestSha256)
		) throw new Error('Runtime catalog generation pins are invalid, duplicated, or out of scope.');
		resolved.set(pin.sourceId, {
			sourceId: pin.sourceId,
			generationId: pin.generationId,
			manifestSha256: pin.manifestSha256,
		});
	}
	return resolved;
}

function runtimeCatalogLockPath(catalogPath: string): string {
	const resolved = safeNonRootPath(catalogPath, 'Runtime catalog');
	return path.join(path.dirname(resolved), `.${path.basename(resolved)}.lock`);
}

export async function resolveSecondBrainRuntimeCatalogPath(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
	const explicit = optionalEnvironmentValue(environment.OBSIDIAN_SECOND_BRAIN_CATALOG_PATH);
	if (explicit !== undefined) {
		if (!path.isAbsolute(explicit)) {
			throw new Error('OBSIDIAN_SECOND_BRAIN_CATALOG_PATH must be absolute.');
		}
		return safeNonRootPath(
			await canonicalizePotentialPath(explicit),
			'Runtime catalog',
		);
	}
	const artifactRoot = optionalEnvironmentValue(environment.OBSIDIAN_ARTIFACT_PATH);
	if (artifactRoot === undefined || !path.isAbsolute(artifactRoot)) {
		throw new Error(
			'Set an absolute OBSIDIAN_SECOND_BRAIN_CATALOG_PATH or OBSIDIAN_ARTIFACT_PATH before offline compilation.',
		);
	}
	return safeNonRootPath(
		await canonicalizePotentialPath(
			path.join(artifactRoot, 'second-brain-v1', 'runtime-catalog.json'),
		),
		'Runtime catalog',
	);
}

function configureSource(
	config: ServerConfig,
	index: number,
	embeddingAdapter: EmbeddingAdapter,
): ConfiguredSecondBrainSource {
	if (!config.artifactPath) {
		throw new Error('Second-brain compilation requires persistent artifact storage.');
	}
	const sourceId = createSourceId(config.sourceIdentity ?? config.vaultPath);
	const label = safeLogicalLabel(config.sourceName ?? config.vaultName, index);
	const kind = config.sourceKind ?? 'directory';
	if (config.writable === true && kind !== 'directory') {
		throw new Error('A local compiled process can only enable writes for a directory source.');
	}
	const privateRoot = path.join(config.artifactPath, 'second-brain-v1');
	const compiler = new OfflineKnowledgeCompiler({
		sourceRoot: config.vaultPath,
		stateRoot: path.join(privateRoot, 'compiler-state'),
		generationRoot: path.join(privateRoot, 'generations'),
		trustedSource: {
			sourceId,
			...(config.projectId === undefined ? {} : { projectId: config.projectId }),
		},
		policy: {
			// Every configured exclusion is mapped as a source-relative prefix;
			// compiler defaults separately retain protected control directories.
			ignoredPathPrefixes: [...config.excludedFolders].sort((first, second) => (
				first.localeCompare(second)
			)),
			maximumFiles: config.maxFiles,
			maximumFileBytes: config.maxFileCharacters,
			chunkMaximumTokens: config.chunkTokens,
			chunkOverlapTokens: config.chunkOverlapTokens,
		},
		embeddingProvider: createOfflineEmbeddingProvider(embeddingAdapter),
	});
	const descriptorBase: SecondBrainSourceDescriptor = {
		sourceId,
		label,
		kind,
		generationRoot: path.join(privateRoot, 'generations'),
		...(config.projectId === undefined ? {} : { projectId: config.projectId }),
	};
	if (config.writable !== true) {
		return { config, compiler, descriptor: descriptorBase };
	}
	const adapter = new SafeDirectoryWriterAdapter({
		adapterId: `directory-${sourceId}`,
		sourceId,
		rootPath: config.vaultPath,
		statePath: path.join(privateRoot, 'writer-state'),
		maxFileBytes: config.maxFileCharacters,
	});
	return {
		config,
		compiler,
		descriptor: {
			...descriptorBase,
			writable: { compiler, adapter },
		},
	};
}

function sourceFromRuntimeCatalog(
	source: RuntimeCatalogSource,
	embeddingAdapter: EmbeddingAdapter,
	enableWrites: boolean,
): SecondBrainSourceDescriptor {
	const base: SecondBrainSourceDescriptor = {
		sourceId: source.sourceId as SourceId,
		label: source.label,
		kind: source.kind,
		generationRoot: source.generationRoot,
		pinnedGenerationId: source.generationId,
		pinnedManifestSha256: source.manifestSha256,
		...(source.projectId === undefined ? {} : { projectId: source.projectId }),
	};
	if (source.writable === undefined || !enableWrites) return base;
	const compiler = new OfflineKnowledgeCompiler({
		sourceRoot: source.writable.sourceRoot,
		stateRoot: source.writable.compilerStateRoot,
		generationRoot: source.generationRoot,
		trustedSource: {
			sourceId: source.sourceId as SourceId,
			...(source.projectId === undefined ? {} : { projectId: source.projectId }),
		},
		policy: structuredClone(source.writable.compilerPolicy),
		embeddingProvider: createOfflineEmbeddingProvider(embeddingAdapter),
	});
	const adapter = new SafeDirectoryWriterAdapter({
		adapterId: `directory-${source.sourceId}`,
		sourceId: source.sourceId as SourceId,
		rootPath: source.writable.sourceRoot,
		statePath: source.writable.writerStateRoot,
		maxFileBytes: source.writable.maximumWriterFileBytes,
	});
	return { ...base, writable: { compiler, adapter } };
}

async function readSecondBrainRuntimeCatalog(catalogPath: string): Promise<RuntimeCatalogMaterial> {
	const envelope = await readSecondBrainRuntimeCatalogEnvelope(catalogPath, false);
	if (envelope === null) throw new Error('Compiled runtime catalog is missing; run the offline compiler first.');
	return envelope.catalog;
}

async function readSecondBrainRuntimeCatalogEnvelope(
	catalogPath: string,
	allowMissing: boolean,
): Promise<RuntimeCatalogEnvelope | null> {
	let bytes: Buffer;
	try {
		bytes = await readPrivateFile(catalogPath, {
			label: 'Compiled runtime catalog',
			minimumBytes: 1,
			maximumBytes: MAXIMUM_RUNTIME_CATALOG_BYTES,
		});
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) {
			if (allowMissing) return null;
			throw new Error('Compiled runtime catalog is missing; run the offline compiler first.');
		}
		throw new Error('Compiled runtime catalog could not be opened or validated safely.', {
			cause: error,
		});
	}
	let decoded: unknown;
	try {
		decoded = JSON.parse(bytes.toString('utf8'));
	} catch {
		throw new Error('Compiled runtime catalog is not valid JSON.');
	}
	if (!isRecord(decoded) || !hasExactKeys(decoded, ['catalog', 'sha256'])) {
		throw new Error('Compiled runtime catalog envelope is invalid.');
	}
	if (typeof decoded.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(decoded.sha256)) {
		throw new Error('Compiled runtime catalog checksum is invalid.');
	}
	if (sha256(canonicalJson(decoded.catalog)) !== decoded.sha256) {
		throw new Error('Compiled runtime catalog checksum mismatch.');
	}
	validateRuntimeCatalog(decoded.catalog);
	return {
		catalog: structuredClone(decoded.catalog),
		sha256: decoded.sha256,
	};
}

function validateRuntimeCatalog(value: unknown): asserts value is RuntimeCatalogMaterial {
	if (!isRecord(value) || !hasOnlyKeys(value, [
		'schemaVersion', 'createdAt', 'deploymentConfigSha256', 'embedding', 'sources', 'writeStateRoot',
	])) throw new Error('Compiled runtime catalog fields are invalid.');
	if (
		value.schemaVersion !== RUNTIME_CATALOG_SCHEMA_VERSION
		|| typeof value.createdAt !== 'string'
		|| Number.isNaN(Date.parse(value.createdAt))
		|| typeof value.deploymentConfigSha256 !== 'string'
		|| !SHA256_PATTERN.test(value.deploymentConfigSha256)
		|| !isRecord(value.embedding)
		|| !hasExactKeys(value.embedding, ['adapterId', 'modelId', 'kind', 'dimension'])
		|| typeof value.embedding.adapterId !== 'string'
		|| value.embedding.adapterId.length === 0
		|| typeof value.embedding.modelId !== 'string'
		|| value.embedding.modelId.length === 0
		|| (value.embedding.kind !== 'lexical_hash' && value.embedding.kind !== 'semantic')
		|| !Number.isSafeInteger(value.embedding.dimension)
		|| typeof value.embedding.dimension !== 'number'
		|| value.embedding.dimension < 1
		|| !Array.isArray(value.sources)
		|| value.sources.length === 0
		|| value.sources.length > 16
	) throw new Error('Compiled runtime catalog header is invalid.');
	if (value.writeStateRoot !== undefined) validatePrivateAbsolutePath(value.writeStateRoot, 'writeStateRoot');
	const seen = new Set<string>();
	let writableCount = 0;
	for (const item of value.sources) {
		if (!isRecord(item) || !hasOnlyKeys(item, [
			'sourceId', 'label', 'kind', 'projectId', 'generationRoot', 'generationId',
			'manifestSha256', 'writable',
		])) throw new Error('Compiled runtime catalog source is invalid.');
		if (
			typeof item.sourceId !== 'string'
			|| !SOURCE_ID_PATTERN.test(item.sourceId)
			|| seen.has(item.sourceId)
			|| typeof item.label !== 'string'
			|| safeLogicalLabel(item.label, seen.size) !== item.label
			|| (item.kind !== 'directory' && item.kind !== 'obsidian-vault')
		) throw new Error('Compiled runtime catalog source identity is invalid.');
		seen.add(item.sourceId);
		if (item.projectId !== undefined && (
			typeof item.projectId !== 'string' || !LOGICAL_ID_PATTERN.test(item.projectId)
		)) throw new Error('Compiled runtime catalog project identity is invalid.');
		validatePrivateAbsolutePath(item.generationRoot, 'generationRoot');
		if (
			typeof item.generationId !== 'string'
			|| !/^gen-[0-9]{13}-[a-f0-9]{32}$/u.test(item.generationId)
			|| typeof item.manifestSha256 !== 'string'
			|| !/^[a-f0-9]{64}$/u.test(item.manifestSha256)
		) throw new Error('Compiled runtime catalog generation pin is invalid.');
		if (item.writable === undefined) continue;
		writableCount += 1;
		if (item.kind !== 'directory' || !isRecord(item.writable) || !hasExactKeys(item.writable, [
			'sourceRoot',
			'compilerStateRoot',
			'writerStateRoot',
			'maximumWriterFileBytes',
			'compilerPolicy',
		])) throw new Error('Compiled runtime writable source is invalid.');
		validatePrivateAbsolutePath(item.writable.sourceRoot, 'sourceRoot');
		validatePrivateAbsolutePath(item.writable.compilerStateRoot, 'compilerStateRoot');
		validatePrivateAbsolutePath(item.writable.writerStateRoot, 'writerStateRoot');
		if (
			pathsOverlap(item.writable.sourceRoot, item.generationRoot)
			|| pathsOverlap(item.writable.sourceRoot, item.writable.compilerStateRoot)
			|| pathsOverlap(item.writable.sourceRoot, item.writable.writerStateRoot)
			|| typeof value.writeStateRoot === 'string'
				&& pathsOverlap(item.writable.sourceRoot, value.writeStateRoot)
		) throw new Error('Compiled runtime writable state overlaps its source.');
		if (
			typeof item.writable.maximumWriterFileBytes !== 'number'
			|| !Number.isSafeInteger(item.writable.maximumWriterFileBytes)
			|| item.writable.maximumWriterFileBytes <= 0
			|| !isCompilerPolicy(item.writable.compilerPolicy)
		) throw new Error('Compiled runtime writable policy is invalid.');
	}
	if ((writableCount > 0) !== (typeof value.writeStateRoot === 'string')) {
		throw new Error('Compiled runtime write state does not match writable sources.');
	}
}

export async function updateRuntimeCatalogGenerationPin(
	catalogPath: string,
	sourceId: string,
	generationId: string,
	manifestSha256: string,
	expectedGenerationId: string,
	expectedManifestSha256: string,
	expectedSourceBindingSha256: string,
): Promise<void> {
	if (!SOURCE_ID_PATTERN.test(sourceId)) throw new Error('Runtime catalog source pin is invalid.');
	if (!GENERATION_ID_PATTERN.test(generationId)) {
		throw new Error('Runtime catalog generation pin is invalid.');
	}
	if (!SHA256_PATTERN.test(manifestSha256)) {
		throw new Error('Runtime catalog manifest pin is invalid.');
	}
	if (!GENERATION_ID_PATTERN.test(expectedGenerationId)) {
		throw new Error('Expected runtime catalog generation pin is invalid.');
	}
	if (!SHA256_PATTERN.test(expectedManifestSha256)) {
		throw new Error('Expected runtime catalog manifest pin is invalid.');
	}
	if (!SHA256_PATTERN.test(expectedSourceBindingSha256)) {
		throw new Error('Expected runtime catalog source binding is invalid.');
	}
	await withPrivateDirectoryLock(runtimeCatalogLockPath(catalogPath), async () => {
		const catalog = await readSecondBrainRuntimeCatalog(catalogPath);
		const source = catalog.sources.find((candidate) => candidate.sourceId === sourceId);
		if (!source?.writable) throw new Error('Runtime catalog source is not writable.');
		if (runtimeCatalogSourceBindingChecksum(catalog, sourceId) !== expectedSourceBindingSha256) {
			throw new RuntimeCatalogConflictError(
				'RUNTIME_CATALOG_SOURCE_BINDING_CHANGED',
				'Runtime catalog source binding changed before publication.',
			);
		}
		if (source.generationId === generationId && source.manifestSha256 === manifestSha256) return;
		if (
			source.generationId !== expectedGenerationId
			|| source.manifestSha256 !== expectedManifestSha256
		) {
			throw new RuntimeCatalogConflictError(
				'RUNTIME_CATALOG_SOURCE_PIN_CHANGED',
				'Runtime catalog source pin changed before publication.',
			);
		}
		source.generationId = generationId;
		source.manifestSha256 = manifestSha256;
		catalog.createdAt = new Date().toISOString();
		validateRuntimeCatalog(catalog);
		await atomicWritePrivateJson(catalogPath, {
			catalog,
			sha256: sha256(canonicalJson(catalog)),
		});
	});
}

function isCompilerPolicy(value: unknown): value is OfflineKnowledgeCompiler['policy'] {
	if (!isRecord(value) || !hasExactKeys(value, [
		'extensions',
		'ignoredDirectoryNames',
		'ignoredPathPrefixes',
		'maximumFileBytes',
		'maximumFiles',
		'chunkMaximumTokens',
		'chunkOverlapTokens',
		'lexicalDeltaCompactionThreshold',
		'lexicalReplacementCompactionRatio',
		'journalRetentionRecords',
	])) return false;
	return Array.isArray(value.extensions)
		&& value.extensions.every((item) => typeof item === 'string')
		&& Array.isArray(value.ignoredDirectoryNames)
		&& value.ignoredDirectoryNames.every((item) => typeof item === 'string')
		&& Array.isArray(value.ignoredPathPrefixes)
		&& value.ignoredPathPrefixes.every((item) => typeof item === 'string')
		&& [
			value.maximumFileBytes,
			value.maximumFiles,
			value.chunkMaximumTokens,
			value.chunkOverlapTokens,
			value.lexicalDeltaCompactionThreshold,
			value.journalRetentionRecords,
		].every((item) => typeof item === 'number' && Number.isSafeInteger(item))
		&& typeof value.lexicalReplacementCompactionRatio === 'number'
		&& Number.isFinite(value.lexicalReplacementCompactionRatio);
}

function assertEmbeddingMatchesCatalog(
	adapter: EmbeddingAdapter,
	catalog: RuntimeCatalogMaterial,
): void {
	if (
		catalog.embedding.adapterId !== adapter.id
		|| catalog.embedding.modelId !== adapter.modelId
		|| catalog.embedding.kind !== adapter.kind
		|| catalog.embedding.dimension !== adapter.dimension
	) throw new Error('Configured embedding adapter does not match the compiled runtime catalog.');
}

async function atomicWritePrivateJson(
	filePath: string,
	value: RuntimeCatalogEnvelope,
): Promise<void> {
	const resolved = safeNonRootPath(filePath, 'Runtime catalog');
	const configuredParent = path.dirname(resolved);
	const privateParent = await ensurePrivateDirectory(
		configuredParent,
		'Runtime catalog parent directory',
	);
	const parent = privateParent.path;
	const target = path.join(parent, path.basename(resolved));
	try {
		await assertPrivateFilePath(target, {
			label: 'Existing runtime catalog',
			maximumBytes: MAXIMUM_RUNTIME_CATALOG_BYTES,
		});
	} catch (error) {
		if (!isNodeError(error, 'ENOENT')) throw error;
	}
	const temporary = path.join(parent, `.runtime-catalog-${randomBytes(16).toString('hex')}.tmp`);
	let handle;
	try {
		handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
			0o600,
		);
		await assertPrivateFileHandle(handle, {
			label: 'Runtime catalog temporary file',
			maximumBytes: MAXIMUM_RUNTIME_CATALOG_BYTES,
		});
		const encoded = `${canonicalJson(value)}\n`;
		if (Buffer.byteLength(encoded, 'utf8') > MAXIMUM_RUNTIME_CATALOG_BYTES) {
			throw new Error('Runtime catalog exceeds its local byte limit.');
		}
		await handle.writeFile(encoded, 'utf8');
		await handle.sync();
		await assertPrivateFileHandle(handle, {
			label: 'Runtime catalog temporary file',
			minimumBytes: 1,
			maximumBytes: MAXIMUM_RUNTIME_CATALOG_BYTES,
		});
		await handle.close();
		handle = undefined;
		await assertPrivateDirectoryIdentity(
			parent,
			privateParent.identity,
			'Runtime catalog parent directory',
		);
		await rename(temporary, target);
		await assertPrivateFilePath(target, {
			label: 'Runtime catalog',
			minimumBytes: 1,
			maximumBytes: MAXIMUM_RUNTIME_CATALOG_BYTES,
		});
		await syncDirectory(parent);
		await assertPrivateDirectoryIdentity(
			parent,
			privateParent.identity,
			'Runtime catalog parent directory',
		);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

async function syncDirectory(directory: string): Promise<void> {
	await syncPrivateDirectory(directory, 'Runtime catalog parent directory');
}

function loadPrincipalPolicy(
	environment: NodeJS.ProcessEnv,
	sources: readonly SecondBrainSourceDescriptor[],
): SecondBrainPrincipalPolicy {
	const configuredSourceIds = sources.map((source) => source.sourceId);
	const configuredProjectIds = [...new Set(sources.flatMap((source) => (
		source.projectId === undefined ? [] : [source.projectId]
	)))];
	const allowedSourceIds = aclSubset(
		environment.OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS,
		configuredSourceIds,
		SOURCE_ID_PATTERN,
		'OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS',
	);
	const allowedProjectIds = aclSubset(
		environment.OBSIDIAN_PRINCIPAL_ALLOWED_PROJECT_IDS,
		configuredProjectIds,
		LOGICAL_ID_PATTERN,
		'OBSIDIAN_PRINCIPAL_ALLOWED_PROJECT_IDS',
	);
	const rawModes = commaSeparated(environment.OBSIDIAN_PRINCIPAL_ALLOWED_MODES)
		?? [...RETRIEVAL_MODES];
	if (rawModes.length === 0 || rawModes.some((mode) => !isRetrievalMode(mode))) {
		throw new Error('OBSIDIAN_PRINCIPAL_ALLOWED_MODES contains an invalid retrieval mode.');
	}
	const principalId = optionalEnvironmentValue(environment.OBSIDIAN_PRINCIPAL_ID) ?? 'local-user';
	if (!LOGICAL_ID_PATTERN.test(principalId)) throw new Error('OBSIDIAN_PRINCIPAL_ID is invalid.');
	const includedPathPrefixes = pathPrefixAcl(environment.OBSIDIAN_PRINCIPAL_INCLUDED_PATH_PREFIXES);
	const excludedPathPrefixes = pathPrefixAcl(environment.OBSIDIAN_PRINCIPAL_EXCLUDED_PATH_PREFIXES);
	return {
		principalId,
		allowedSourceIds,
		...(allowedProjectIds.length === 0 ? {} : { allowedProjectIds }),
		allowedModes: [...new Set(rawModes)] as SecondBrainPrincipalPolicy['allowedModes'],
		...(includedPathPrefixes === undefined ? {} : { includedPathPrefixes }),
		...(excludedPathPrefixes === undefined ? {} : { excludedPathPrefixes }),
	};
}

async function resolveWriteStateRoot(
	environment: NodeJS.ProcessEnv,
	sources: readonly ConfiguredSecondBrainSource[],
): Promise<string> {
	const configured = optionalEnvironmentValue(environment.OBSIDIAN_SECOND_BRAIN_WRITE_STATE_PATH);
	if (configured !== undefined && !path.isAbsolute(configured)) {
		throw new Error('OBSIDIAN_SECOND_BRAIN_WRITE_STATE_PATH must be absolute.');
	}
	const firstArtifact = sources[0]?.config.artifactPath;
	if (!firstArtifact) throw new Error('Writable sources require persistent artifact storage.');
	const candidate = await canonicalizePotentialPath(
		configured ?? path.join(firstArtifact, 'second-brain-v1', 'runtime-write-state'),
	);
	if (candidate === path.parse(candidate).root) throw new Error('Write state cannot be a filesystem root.');
	for (const source of sources) {
		if (pathsOverlap(candidate, source.config.vaultPath)) {
			throw new Error('Write state must be outside every configured source.');
		}
	}
	return candidate;
}

async function canonicalizePotentialPath(candidate: string): Promise<string> {
	let existing = path.resolve(candidate);
	const missingSegments: string[] = [];
	for (;;) {
		try {
			const canonical = await realpath(existing);
			return path.join(canonical, ...missingSegments.reverse());
		} catch (error) {
			if (!isNodeError(error, 'ENOENT')) throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			missingSegments.push(path.basename(existing));
			existing = parent;
		}
	}
}

function loadApprovalSecret(environment: NodeJS.ProcessEnv): Uint8Array {
	const configured = optionalEnvironmentValue(environment.OBSIDIAN_SECOND_BRAIN_APPROVAL_SECRET);
	if (configured === undefined) return randomBytes(32);
	const bytes = Buffer.from(configured, 'utf8');
	if (bytes.byteLength < 32) {
		throw new Error('OBSIDIAN_SECOND_BRAIN_APPROVAL_SECRET must contain at least 32 UTF-8 bytes.');
	}
	return bytes;
}

function requireWriteStateRoot(value: string | undefined): string {
	if (value === undefined) throw new Error('Writable sources require private runtime write state.');
	return value;
}

function renderApprovalDocument(review: Readonly<HumanApprovalReview>): string {
	return [
		'SECOND BRAIN PRIVATE HUMAN APPROVAL — DO NOT EDIT',
		`Binding-SHA256: ${review.bindingHash}`,
		'--- BEGIN EXACT RUNTIME REVIEW ---',
		review.reviewText,
		'--- END EXACT RUNTIME REVIEW ---',
		'Click approve only if every source, path, risk and diff line above is correct.',
	].join('\n');
}

function parseRerankerResponse(
	value: unknown,
	context: RerankerContext,
): readonly RerankerResult[] {
	if (!isRecord(value) || !Array.isArray(value.results)) {
		throw new Error('Loopback reranker response must contain a results array.');
	}
	if (value.results.length > context.candidates.length) {
		throw new Error('Loopback reranker returned too many results.');
	}
	const seen = new Set<number>();
	return value.results.map((item) => {
		if (!isRecord(item)) throw new Error('Loopback reranker result is invalid.');
		const { index, relevance_score: score } = item;
		if (
			typeof index !== 'number'
			|| !Number.isSafeInteger(index)
			|| index < 0
			|| index >= context.candidates.length
			|| seen.has(index)
			|| typeof score !== 'number'
			|| !Number.isFinite(score)
		) throw new Error('Loopback reranker result is malformed.');
		seen.add(index);
		const candidate = context.candidates[index];
		if (!candidate) throw new Error('Loopback reranker result index is unavailable.');
		return {
			recordId: candidate.record.id,
			score,
			reasons: [`${String(item.reason ?? 'loopback-rerank')}`.slice(0, 256)],
		};
	});
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Uint8Array> {
	const declared = response.headers.get('content-length');
	if (declared !== null) {
		const parsed = Number(declared);
		if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximumBytes) {
			throw new Error('Loopback response exceeded the configured byte limit.');
		}
	}
	if (!response.body) throw new Error('Loopback response had no body.');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maximumBytes) {
			await reader.cancel().catch(() => undefined);
			throw new Error('Loopback response exceeded the configured byte limit.');
		}
		chunks.push(value);
	}
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined;
}

function safeLogicalLabel(value: string, index: number): string {
	const label = value.normalize('NFC').trim();
	if (!label || label.length > 128 || /[\0\r\n/\\]/u.test(label) || path.isAbsolute(label)) {
		throw new Error(`Knowledge source ${index + 1} needs a short logical name without path separators.`);
	}
	return label;
}

function aclSubset(
	raw: string | undefined,
	configured: readonly string[],
	pattern: RegExp,
	label: string,
): string[] {
	const requested = commaSeparated(raw);
	if (requested === undefined) return [...configured];
	if (requested.length === 0 || requested.some((value) => !pattern.test(value))) {
		throw new Error(`${label} is invalid.`);
	}
	const configuredSet = new Set(configured);
	if (requested.some((value) => !configuredSet.has(value))) {
		throw new Error(`${label} may only narrow configured sources or projects.`);
	}
	return [...new Set(requested)];
}

function pathPrefixAcl(raw: string | undefined): string[] | undefined {
	const values = commaSeparated(raw);
	if (values === undefined) return undefined;
	if (values.length === 0) throw new Error('Path-prefix ACL cannot be empty when configured.');
	return [...new Set(values.map((value) => normalizeDocumentPath(value)))];
}

function commaSeparated(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw.split(',').map((value) => value.trim()).filter(Boolean);
}

function isRetrievalMode(value: string): value is typeof RETRIEVAL_MODES[number] {
	return (RETRIEVAL_MODES as readonly string[]).includes(value);
}

function optionalEnvironmentValue(value: string | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

function requiredEnvironmentValue(value: string | undefined, label: string): string {
	const normalized = optionalEnvironmentValue(value);
	if (normalized === undefined) throw new Error(`${label} is required.`);
	return normalized;
}

function optionalStrictInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
): number;
function optionalStrictInteger(
	value: string | undefined,
	fallback: undefined,
	minimum: number,
	maximum: number,
	label: string,
): number;
function optionalStrictInteger(
	value: string | undefined,
	fallback: number | undefined,
	minimum: number,
	maximum: number,
	label: string,
): number {
	if (value === undefined || value.trim() === '') {
		if (fallback === undefined) throw new Error(`${label} is required.`);
		return fallback;
	}
	if (!/^[0-9]+$/u.test(value.trim())) throw new Error(`${label} must be an integer.`);
	return boundedInteger(Number(value.trim()), minimum, maximum, label);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function strictBoolean(value: string | undefined, fallback: boolean, label: string): boolean {
	if (value === undefined || value.trim() === '') return fallback;
	if (value === 'true') return true;
	if (value === 'false') return false;
	throw new Error(`${label} must be exactly true or false.`);
}

function forbidEnvironmentValues(
	environment: NodeJS.ProcessEnv,
	keys: readonly string[],
	mode: string,
): void {
	if (keys.some((key) => optionalEnvironmentValue(environment[key]) !== undefined)) {
		throw new Error(`Loopback-only configuration cannot be used with ${mode}.`);
	}
}

function normalizeReviewer(value: string): string {
	const normalized = value.normalize('NFC').trim();
	if (!LOGICAL_ID_PATTERN.test(normalized)) throw new Error('Human reviewer identity is invalid.');
	return normalized;
}

function pathsOverlap(first: string, second: string): boolean {
	return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function validatePrivateAbsolutePath(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) {
		throw new Error(`Compiled runtime catalog ${label} is invalid.`);
	}
	safeNonRootPath(value, `Compiled runtime catalog ${label}`);
}

function safeNonRootPath(value: string, label: string): string {
	const resolved = path.resolve(value);
	if (resolved === path.parse(resolved).root) throw new Error(`${label} cannot be a filesystem root.`);
	return resolved;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const set = new Set(allowed);
	return Object.keys(value).every((key) => set.has(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	return Object.keys(value).length === expected.length
		&& expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && 'code' in error && error.code === code;
}

function isSameOrDescendant(root: string, candidate: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(candidate));
	return relative === '' || (
		!relative.startsWith(`..${path.sep}`)
		&& relative !== '..'
		&& !path.isAbsolute(relative)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
