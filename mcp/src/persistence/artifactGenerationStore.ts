import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
	GenerationStore,
	type GenerationManifest,
	type JsonValue,
} from '../generationStore.js';
import {
	COMPILED_ARTIFACT_SCHEMA_VERSION,
	type ArtifactLayer,
	type CompiledArtifactBundle,
	type CompactLexicalArtifact,
	type DerivedArtifacts,
	type HierarchyArtifact,
	type SourceCatalog,
	type TemporalArtifact,
	type VectorArtifact,
} from './artifactTypes.js';
import { canonicalJson, hashCanonicalJson } from './canonicalJson.js';

export interface ArtifactBundleInput {
	compilerVersion: string;
	createdAt: string;
	policyHash: string;
	layers: {
		catalog: SourceCatalog;
		lexical: CompactLexicalArtifact;
		derived: DerivedArtifacts;
		temporal: TemporalArtifact;
		hierarchy: HierarchyArtifact;
		vector: VectorArtifact | null;
	};
	statistics: CompiledArtifactBundle['statistics'];
}

export interface PublishedArtifactGeneration {
	generationId: string;
	manifestSha256: string;
	manifest: GenerationManifest;
	bundle: CompiledArtifactBundle;
}

/**
 * Typed orchestration over GenerationStore. GenerationStore supplies the
 * checksummed READY marker and atomic CURRENT switch; this class verifies each
 * logical artifact layer independently before exposing it to a reader.
 */
export class ArtifactGenerationStore {
	private readonly store: GenerationStore;

	constructor(rootPath: string) {
		this.store = new GenerationStore(rootPath);
	}

	async publish(input: ArtifactBundleInput): Promise<PublishedArtifactGeneration> {
		const bundle: CompiledArtifactBundle = {
			schemaVersion: COMPILED_ARTIFACT_SCHEMA_VERSION,
			compilerVersion: input.compilerVersion,
			createdAt: input.createdAt,
			policyHash: input.policyHash,
			layers: {
				catalog: createArtifactLayer(input.layers.catalog),
				lexical: createArtifactLayer(input.layers.lexical),
				derived: createArtifactLayer(input.layers.derived),
				temporal: createArtifactLayer(input.layers.temporal),
				hierarchy: createArtifactLayer(input.layers.hierarchy),
				vector: input.layers.vector === null ? null : createArtifactLayer(input.layers.vector),
			},
			statistics: input.statistics,
		};
		const payload = JSON.parse(canonicalJson(bundle)) as JsonValue;
		const manifest = await this.store.publish(payload);
		return {
			generationId: manifest.generationId,
			manifestSha256: checksumManifest(manifest),
			manifest,
			bundle,
		};
	}

	async readCurrent(): Promise<PublishedArtifactGeneration | null> {
		const stored = await this.store.readCurrent();
		if (!stored) return null;
		return decodePublished(stored.manifest, stored.payload);
	}

	async readGeneration(generationId: string): Promise<PublishedArtifactGeneration> {
		const stored = await this.store.readGeneration(generationId);
		return decodePublished(stored.manifest, stored.payload);
	}

	async rollback(): Promise<PublishedArtifactGeneration> {
		const stored = await this.store.rollback();
		return decodePublished(stored.manifest, stored.payload);
	}

	async pruneUnreferenced(): Promise<string[]> {
		return this.store.pruneUnreferenced();
	}
}

export function createArtifactLayer<T>(data: T): ArtifactLayer<T> {
	const encoded = canonicalJson(data);
	return {
		sha256: hashCanonicalJson(data),
		byteLength: Buffer.byteLength(encoded, 'utf8'),
		data,
	};
}

function decodePublished(
	manifest: GenerationManifest,
	payload: JsonValue | Buffer,
): PublishedArtifactGeneration {
	if (Buffer.isBuffer(payload) || !isRecord(payload)) {
		throw new TypeError('Compiled artifact generation payload must be a JSON object.');
	}
	if (payload.schemaVersion !== COMPILED_ARTIFACT_SCHEMA_VERSION) {
		throw new TypeError('Unsupported compiled artifact generation schema.');
	}
	const layers = payload.layers;
	if (!isRecord(layers)) throw new TypeError('Compiled artifact generation has no layers.');
	for (const name of ['catalog', 'lexical', 'derived', 'temporal', 'hierarchy'] as const) {
		verifyLayer(layers[name], name);
	}
	if (layers.vector !== null) verifyLayer(layers.vector, 'vector');
	const bundle = payload as unknown as CompiledArtifactBundle;
	if (typeof bundle.policyHash !== 'string' || !/^[a-f0-9]{64}$/u.test(bundle.policyHash)) {
		throw new TypeError('Compiled artifact policy hash is invalid.');
	}
	return {
		generationId: manifest.generationId,
		manifestSha256: checksumManifest(manifest),
		manifest,
		bundle,
	};
}

function checksumManifest(manifest: GenerationManifest): string {
	return createHash('sha256')
		.update(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
		.digest('hex');
}

function verifyLayer(value: unknown, label: string): void {
	if (!isRecord(value)) throw new TypeError(`Compiled artifact ${label} layer is invalid.`);
	if (typeof value.sha256 !== 'string' || typeof value.byteLength !== 'number' || !('data' in value)) {
		throw new TypeError(`Compiled artifact ${label} layer envelope is invalid.`);
	}
	const encoded = canonicalJson(value.data);
	if (Buffer.byteLength(encoded, 'utf8') !== value.byteLength) {
		throw new TypeError(`Compiled artifact ${label} layer length mismatch.`);
	}
	if (hashCanonicalJson(value.data) !== value.sha256) {
		throw new TypeError(`Compiled artifact ${label} layer checksum mismatch.`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
