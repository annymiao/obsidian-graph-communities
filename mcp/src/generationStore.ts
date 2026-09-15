import { constants as bufferConstants } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';

export const GENERATION_STORE_SCHEMA_VERSION = 1 as const;

const GENERATIONS_DIRECTORY = 'generations';
const STAGING_DIRECTORY = '.staging';
const CURRENT_FILE = 'CURRENT';
const PREVIOUS_FILE = 'PREVIOUS';
const WRITER_LOCK_DIRECTORY = '.writer.lock';
const MANIFEST_FILE = 'manifest.json';
const READY_FILE = 'READY';
const BUFFER_PAYLOAD_FILE = 'payload.bin';
const JSON_PAYLOAD_FILE = 'payload.json';
const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const MAX_CONTROL_FILE_BYTES = 64 * 1024;
const GENERATION_ID_PATTERN = /^gen-[0-9]{13}-[a-f0-9]{32}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;
const READ_ONLY_FLAGS = constants.O_RDONLY | NO_FOLLOW;
const READ_DIRECTORY_FLAGS = constants.O_RDONLY | NO_FOLLOW | DIRECTORY_FLAG;
const CREATE_NEW_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type GenerationPayload = Buffer | JsonValue;

export interface GenerationStoreOptions {
	maxPayloadBytes?: number;
	lockTimeoutMs?: number;
}

export interface PublishOptions {
	/** Keep the replaced generation available through PREVIOUS. Defaults to true. */
	retainPrevious?: boolean;
}

export interface GenerationPayloadManifest {
	kind: 'buffer' | 'json';
	fileName: typeof BUFFER_PAYLOAD_FILE | typeof JSON_PAYLOAD_FILE;
	byteLength: number;
	sha256: string;
}

export interface GenerationManifest {
	schemaVersion: typeof GENERATION_STORE_SCHEMA_VERSION;
	generationId: string;
	createdAt: string;
	parentGenerationId: string | null;
	payload: GenerationPayloadManifest;
}

export interface StoredGeneration {
	manifest: GenerationManifest;
	payload: GenerationPayload;
}

interface ReadyMarker {
	schemaVersion: typeof GENERATION_STORE_SCHEMA_VERSION;
	generationId: string;
	manifestSha256: string;
}

interface GenerationPointer {
	schemaVersion: typeof GENERATION_STORE_SCHEMA_VERSION;
	generationId: string;
	manifestSha256: string;
	previousGenerationId: string | null;
	previousManifestSha256: string | null;
	updatedAt: string;
}

interface WriterLockOwner {
	schemaVersion: typeof GENERATION_STORE_SCHEMA_VERSION;
	pid: number;
	token: string;
	createdAt: string;
}

interface DirectoryIdentity {
	dev: number;
	ino: number;
}

interface EncodedPayload {
	kind: GenerationPayloadManifest['kind'];
	fileName: GenerationPayloadManifest['fileName'];
	bytes: Buffer;
}

export class GenerationStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'GenerationStoreError';
	}
}

export class GenerationStoreCorruptionError extends GenerationStoreError {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'GenerationStoreCorruptionError';
	}
}

export class GenerationStoreBusyError extends GenerationStoreError {
	constructor(message: string) {
		super(message);
		this.name = 'GenerationStoreBusyError';
	}
}

/**
 * A small, local, content-verified generation store.
 *
 * Publishing is ordered so that a generation can become visible only after its
 * payload, manifest, and READY marker have been durably written and the complete
 * directory has been moved out of staging. CURRENT is then replaced by an atomic
 * same-directory rename. Unreferenced staging/final directories are never read.
 *
 * The canonical store root and its managed descendants reject static symlinks
 * and stable identity changes. Node.js 20 has no portable openat/dirfd API,
 * however, so this class does not claim to defeat a malicious same-user process
 * that swaps an ancestor between validation and use. Pointer visibility changes
 * use same-directory rename. Power-loss durability is claimed only when every
 * requested directory fsync succeeds; unsupported directory fsync errors are
 * tolerated on Windows, where no power-loss durability claim is made.
 */
export class GenerationStore {
	readonly configuredRootPath: string;

	private readonly maxPayloadBytes: number;
	private readonly lockTimeoutMs: number;
	private initialization: Promise<void> | null = null;
	private canonicalRootPath = '';
	private rootIdentity: DirectoryIdentity | null = null;
	private readonly managedDirectoryIdentities = new Map<string, DirectoryIdentity>();

	constructor(rootPath: string, options: GenerationStoreOptions = {}) {
		if (!rootPath || rootPath.includes('\0')) {
			throw new GenerationStoreError('Generation store path must be a non-empty filesystem path.');
		}
		this.configuredRootPath = path.resolve(rootPath);
		if (this.configuredRootPath === path.parse(this.configuredRootPath).root) {
			throw new GenerationStoreError('Generation store path must not be a filesystem root.');
		}
		this.maxPayloadBytes = readPositiveSafeInteger(
			options.maxPayloadBytes,
			DEFAULT_MAX_PAYLOAD_BYTES,
			'maxPayloadBytes',
		);
		if (this.maxPayloadBytes > bufferConstants.MAX_LENGTH) {
			throw new GenerationStoreError(
				`maxPayloadBytes must not exceed the Node.js Buffer limit (${bufferConstants.MAX_LENGTH}).`,
			);
		}
		this.lockTimeoutMs = readPositiveSafeInteger(
			options.lockTimeoutMs,
			DEFAULT_LOCK_TIMEOUT_MS,
			'lockTimeoutMs',
		);
	}

	async initialize(): Promise<void> {
		await this.ensureInitialized();
	}

	/** Test seam for simulating a process stop immediately before recovery visibility changes. */
	protected async beforeRecoveryCurrentSwitch(): Promise<void> {
		// Production implementation intentionally does nothing.
	}

	async publish(
		payload: GenerationPayload,
		options: PublishOptions = {},
	): Promise<GenerationManifest> {
		const encoded = encodePayload(payload);
		if (encoded.bytes.byteLength > this.maxPayloadBytes) {
			throw new GenerationStoreError(
				`Generation payload exceeds maxPayloadBytes (${this.maxPayloadBytes}).`,
			);
		}

		await this.ensureInitialized();
		return this.withWriterLock(async () => {
			await this.assertStoreTopology();
			const retainPrevious = options.retainPrevious ?? true;
			const currentPointer = await this.readPointerOptional(CURRENT_FILE);
			if (currentPointer) {
				await this.loadGeneration(currentPointer.generationId, currentPointer.manifestSha256);
			} else if (await this.pathExists(this.resolveRootChild(PREVIOUS_FILE))) {
				throw new GenerationStoreCorruptionError(
					'PREVIOUS exists without CURRENT; refusing to publish over ambiguous store state.',
				);
			}

			const generationId = createGenerationId();
			const stagingPath = this.resolveManagedPath(STAGING_DIRECTORY, generationId);
			const finalPath = this.resolveManagedPath(GENERATIONS_DIRECTORY, generationId);
			await this.requireMissing(finalPath, 'generation destination');
			await mkdir(stagingPath, { mode: 0o700 });
			const stagingIdentity = await this.assertSafeDirectory(
				stagingPath,
				'staging generation',
			);
			await this.assertStoreTopology();

			const payloadSha256 = sha256(encoded.bytes);
			const manifest: GenerationManifest = {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				generationId,
				createdAt: new Date().toISOString(),
				parentGenerationId: currentPointer?.generationId ?? null,
				payload: {
					kind: encoded.kind,
					fileName: encoded.fileName,
					byteLength: encoded.bytes.byteLength,
					sha256: payloadSha256,
				},
			};
			const manifestBytes = encodeControlJson(manifest);
			const manifestSha256 = sha256(manifestBytes);
			const ready: ReadyMarker = {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				generationId,
				manifestSha256,
			};

			await writeNewFile(this.resolveContainedFile(stagingPath, encoded.fileName), encoded.bytes);
			await this.assertDirectoryIdentity(stagingPath, 'staging generation', stagingIdentity);
			await this.assertStoreTopology();
			await writeNewFile(this.resolveContainedFile(stagingPath, MANIFEST_FILE), manifestBytes);
			await this.assertDirectoryIdentity(stagingPath, 'staging generation', stagingIdentity);
			await this.assertStoreTopology();
			// READY is deliberately the last file written in staging.
			await writeNewFile(
				this.resolveContainedFile(stagingPath, READY_FILE),
				encodeControlJson(ready),
			);
			await syncDirectory(stagingPath);
			await this.assertDirectoryIdentity(stagingPath, 'staging generation', stagingIdentity);
			await this.assertStoreTopology();
			await this.loadGenerationFromDirectory(stagingPath, generationId, manifestSha256);

			await this.assertDirectoryIdentity(stagingPath, 'staging generation', stagingIdentity);
			await this.assertStoreTopology();
			await rename(stagingPath, finalPath);
			await syncDirectory(this.resolveRootChild(GENERATIONS_DIRECTORY));
			await this.assertStoreTopology();
			await this.assertDirectoryIdentity(finalPath, `generation ${generationId}`, stagingIdentity);
			await this.loadGeneration(generationId, manifestSha256);

			const nextPointer: GenerationPointer = {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				generationId,
				manifestSha256,
				previousGenerationId: retainPrevious ? currentPointer?.generationId ?? null : null,
				previousManifestSha256: retainPrevious ? currentPointer?.manifestSha256 ?? null : null,
				updatedAt: new Date().toISOString(),
			};
			if (currentPointer && retainPrevious) {
				await this.writePointerAtomic(PREVIOUS_FILE, currentPointer);
			} else if (!retainPrevious) {
				// Remove the stale recovery anchor before CURRENT stops referring to it.
				await this.removeRootFileIfPresent(PREVIOUS_FILE);
			}
			// CURRENT is the only visibility switch and is always written last.
			await this.writePointerAtomic(CURRENT_FILE, nextPointer);
			return manifest;
		});
	}

	/**
	 * Quarantines pointer files only when CURRENT cannot be verified. Immutable
	 * generations are left untouched until a fresh authoritative publication can
	 * make one generation current and prune the rest.
	 */
	async quarantineCorruptState(): Promise<boolean> {
		await this.ensureInitialized();
		return this.withWriterLock(async () => {
			await this.assertStoreTopology();
			try {
				const current = await this.readPointerOptional(CURRENT_FILE);
				if (current) {
					await this.loadGeneration(current.generationId, current.manifestSha256);
					return false;
				}
				if (!await this.pathExists(this.resolveRootChild(PREVIOUS_FILE))) return false;
			} catch (error) {
				if (
					!(error instanceof GenerationStoreCorruptionError)
					&& !isNodeError(error, 'ENOENT')
				) {
					throw error;
				}
			}

			const token = randomBytes(16).toString('hex');
			for (const pointerName of [CURRENT_FILE, PREVIOUS_FILE]) {
				const pointerPath = this.resolveRootChild(pointerName);
				if (!await this.pathExists(pointerPath)) continue;
				await this.requireRegularFileOrMissing(pointerPath, pointerName);
				const quarantinedPath = this.resolveManagedPath(
					STAGING_DIRECTORY,
					`quarantined-${pointerName}-${token}`,
				);
				await this.requireMissing(quarantinedPath, 'quarantined pointer destination');
				await this.assertStoreTopology();
				await rename(pointerPath, quarantinedPath);
				await this.assertStoreTopology();
			}
			await syncDirectory(this.canonicalRootPath);
			await syncDirectory(this.resolveRootChild(STAGING_DIRECTORY));
			return true;
		});
	}

	async readCurrent(): Promise<StoredGeneration | null> {
		await this.ensureInitialized();
		const pointer = await this.readPointerOptional(CURRENT_FILE);
		if (!pointer) return null;
		return this.loadGeneration(pointer.generationId, pointer.manifestSha256);
	}

	async readGeneration(generationId: string): Promise<StoredGeneration> {
		await this.ensureInitialized();
		assertGenerationId(generationId);
		return this.loadGeneration(generationId);
	}

	/**
	 * Atomically switches CURRENT to the preceding valid generation. If the
	 * current generation itself is damaged, PREVIOUS may still be used for
	 * recovery; no damaged generation is ever returned as successful.
	 */
	async rollback(): Promise<StoredGeneration> {
		await this.ensureInitialized();
		return this.withWriterLock(async () => {
			let currentPointer: GenerationPointer | null = null;
			let currentGeneration: StoredGeneration | null = null;
			let currentReadError: unknown = null;
			try {
				currentPointer = await this.readPointerOptional(CURRENT_FILE);
				if (currentPointer) {
					currentGeneration = await this.loadGeneration(
						currentPointer.generationId,
						currentPointer.manifestSha256,
					);
				}
			} catch (error) {
				currentReadError = error;
			}

			let targetId = currentPointer?.previousGenerationId ?? null;
			let targetChecksum = currentPointer?.previousManifestSha256 ?? null;
			// PREVIOUS is a recovery anchor only when CURRENT cannot be parsed or is
			// absent. A valid CURRENT with no embedded predecessor is authoritative;
			// consulting a stale PREVIOUS there could make rollback report a no-op.
			if (!currentPointer) {
				const previousPointer = await this.readPointerOptional(PREVIOUS_FILE);
				targetId = previousPointer?.generationId ?? null;
				targetChecksum = previousPointer?.manifestSha256 ?? null;
			}
			if (!targetId || !targetChecksum) {
				throw new GenerationStoreError(
					'No previous generation is available for rollback.',
					currentReadError instanceof Error ? { cause: currentReadError } : undefined,
				);
			}

			const target = await this.loadGeneration(targetId, targetChecksum);
			let newPrevious: GenerationPointer | null = null;
			if (
				currentPointer
				&& currentGeneration
				&& currentPointer.generationId !== target.manifest.generationId
			) {
				newPrevious = currentPointer;
			} else if (target.manifest.parentGenerationId) {
				newPrevious = await this.pointerForGeneration(target.manifest.parentGenerationId);
			}

			const nextPointer: GenerationPointer = {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				generationId: target.manifest.generationId,
				manifestSha256: targetChecksum,
				previousGenerationId: newPrevious?.generationId ?? null,
				previousManifestSha256: newPrevious?.manifestSha256 ?? null,
				updatedAt: new Date().toISOString(),
			};
			// CURRENT contains both the selected generation and its next rollback
			// target, so rollback uses one atomic state transition. PREVIOUS remains
			// the publication-time recovery anchor; mutating it before CURRENT would
			// lose that anchor if recovery stopped between the two writes.
			if (!currentPointer || !currentGeneration) {
				await this.beforeRecoveryCurrentSwitch();
			}
			await this.writePointerAtomic(CURRENT_FILE, nextPointer);
			return target;
		});
	}

	/**
	 * Removes only immutable generations that are not named by CURRENT or
	 * PREVIOUS. The visibility pointers are verified under the writer lock before
	 * any managed directory is moved to staging and deleted.
	 */
	async pruneUnreferenced(): Promise<string[]> {
		await this.ensureInitialized();
		return this.withWriterLock(async () => {
			const current = await this.readPointerOptional(CURRENT_FILE);
			if (!current) return [];
			await this.loadGeneration(current.generationId, current.manifestSha256);
			const previous = await this.readPointerOptional(PREVIOUS_FILE);
			if (previous) {
				await this.loadGeneration(previous.generationId, previous.manifestSha256);
			}
			const retained = new Set([
				current.generationId,
				current.previousGenerationId,
				previous?.generationId ?? null,
			].filter((generationId): generationId is string => generationId !== null));
			const generationsPath = this.resolveRootChild(GENERATIONS_DIRECTORY);
			await this.assertStoreTopology();
			const entries = await readdir(generationsPath, { withFileTypes: true });
			await this.assertStoreTopology();
			const removed: string[] = [];
			for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
				if (!GENERATION_ID_PATTERN.test(entry.name)) {
					throw new GenerationStoreCorruptionError(
						`Unexpected entry in generations directory: ${entry.name}`,
					);
				}
				if (retained.has(entry.name)) continue;
				if (entry.isSymbolicLink() || !entry.isDirectory()) {
					throw new GenerationStoreCorruptionError(
						`Unreferenced generation is not a safe directory: ${entry.name}`,
					);
				}
				const generationPath = this.resolveManagedPath(GENERATIONS_DIRECTORY, entry.name);
				const generationIdentity = await this.assertSafeDirectory(
					generationPath,
					`generation ${entry.name}`,
				);
				const stagedName = `pruned-${entry.name}-${randomBytes(8).toString('hex')}`;
				const stagedPath = this.resolveManagedPath(STAGING_DIRECTORY, stagedName);
				await this.requireMissing(stagedPath, 'pruned generation staging destination');
				await this.assertDirectoryIdentity(
					generationPath,
					`generation ${entry.name}`,
					generationIdentity,
				);
				await this.assertStoreTopology();
				await rename(generationPath, stagedPath);
				await syncDirectory(generationsPath);
				await this.assertStoreTopology();
				await this.assertDirectoryIdentity(
					stagedPath,
					`staged generation ${entry.name}`,
					generationIdentity,
				);
				await rm(stagedPath, { recursive: true, force: true });
				await this.assertStoreTopology();
				await syncDirectory(this.resolveRootChild(STAGING_DIRECTORY));
				removed.push(entry.name);
			}
			return removed;
		});
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialization) {
			this.initialization = this.initializeStore();
		}
		await this.initialization;
		await this.assertRootIdentity();
		await this.assertManagedDirectories();
	}

	private async initializeStore(): Promise<void> {
		await mkdir(this.configuredRootPath, { recursive: true, mode: 0o700 });
		const configuredStat = await lstat(this.configuredRootPath);
		if (configuredStat.isSymbolicLink() || !configuredStat.isDirectory()) {
			throw new GenerationStoreCorruptionError(
				'Generation store root must be a real directory, not a symlink or file.',
			);
		}
		assertPrivateDirectory(configuredStat, 'Generation store root');
		this.canonicalRootPath = await realpath(this.configuredRootPath);
		const canonicalStat = await stat(this.canonicalRootPath);
		if (!canonicalStat.isDirectory()) {
			throw new GenerationStoreCorruptionError('Generation store root is not a directory.');
		}
		assertPrivateDirectory(canonicalStat, 'Generation store root');
		this.rootIdentity = { dev: canonicalStat.dev, ino: canonicalStat.ino };

		for (const directoryName of [GENERATIONS_DIRECTORY, STAGING_DIRECTORY]) {
			const directoryPath = this.resolveRootChild(directoryName);
			await mkdir(directoryPath, { recursive: true, mode: 0o700 });
			const identity = await this.assertSafeDirectory(directoryPath, directoryName);
			this.managedDirectoryIdentities.set(directoryName, identity);
		}
		await syncDirectory(this.canonicalRootPath);
		// Persist the root directory entry itself when its parent supports directory
		// fsync. Windows retains atomic visibility but may not provide this durability.
		await syncDirectory(path.dirname(this.canonicalRootPath));
	}

	private async assertRootIdentity(): Promise<void> {
		if (!this.canonicalRootPath || !this.rootIdentity) {
			throw new GenerationStoreCorruptionError('Generation store was not initialized.');
		}
		const rootStat = await lstat(this.canonicalRootPath);
		const resolvedRoot = await realpath(this.canonicalRootPath);
		const verifiedRootStat = await lstat(this.canonicalRootPath);
		assertPrivateDirectory(rootStat, 'Generation store root');
		assertPrivateDirectory(verifiedRootStat, 'Generation store root');
		if (
			rootStat.isSymbolicLink()
			|| !rootStat.isDirectory()
			|| resolvedRoot !== this.canonicalRootPath
			|| rootStat.dev !== this.rootIdentity.dev
			|| rootStat.ino !== this.rootIdentity.ino
			|| verifiedRootStat.isSymbolicLink()
			|| !verifiedRootStat.isDirectory()
			|| verifiedRootStat.dev !== rootStat.dev
			|| verifiedRootStat.ino !== rootStat.ino
		) {
			throw new GenerationStoreCorruptionError(
				'Generation store root changed after initialization.',
			);
		}
	}

	private async assertManagedDirectories(): Promise<void> {
		for (const directoryName of [GENERATIONS_DIRECTORY, STAGING_DIRECTORY]) {
			const actual = await this.assertSafeDirectory(
				this.resolveRootChild(directoryName),
				directoryName,
			);
			const expected = this.managedDirectoryIdentities.get(directoryName);
			if (!expected || !sameDirectoryIdentity(actual, expected)) {
				throw new GenerationStoreCorruptionError(
					`${directoryName} changed after initialization.`,
				);
			}
		}
	}

	private async assertSafeDirectory(
		directoryPath: string,
		label: string,
	): Promise<DirectoryIdentity> {
		this.assertContained(directoryPath);
		const directoryStat = await lstat(directoryPath);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new GenerationStoreCorruptionError(`${label} must be a real directory.`);
		}
		assertPrivateDirectory(directoryStat, label);
		const resolved = await realpath(directoryPath);
		this.assertContained(resolved);
		if (resolved !== directoryPath) {
			throw new GenerationStoreCorruptionError(`${label} resolves through an unexpected symlink.`);
		}
		const verifiedStat = await lstat(directoryPath);
		assertPrivateDirectory(verifiedStat, label);
		if (
			verifiedStat.isSymbolicLink()
			|| !verifiedStat.isDirectory()
			|| verifiedStat.dev !== directoryStat.dev
			|| verifiedStat.ino !== directoryStat.ino
		) {
			throw new GenerationStoreCorruptionError(`${label} changed while it was validated.`);
		}
		return { dev: directoryStat.dev, ino: directoryStat.ino };
	}

	private async assertDirectoryIdentity(
		directoryPath: string,
		label: string,
		expected: DirectoryIdentity,
	): Promise<void> {
		const actual = await this.assertSafeDirectory(directoryPath, label);
		if (!sameDirectoryIdentity(actual, expected)) {
			throw new GenerationStoreCorruptionError(`${label} changed during filesystem access.`);
		}
	}

	private async assertStoreTopology(): Promise<void> {
		await this.assertRootIdentity();
		await this.assertManagedDirectories();
	}

	private async loadGeneration(
		generationId: string,
		expectedManifestSha256?: string,
	): Promise<StoredGeneration> {
		assertGenerationId(generationId);
		if (expectedManifestSha256 !== undefined) assertSha256(expectedManifestSha256);
		const generationPath = this.resolveManagedPath(GENERATIONS_DIRECTORY, generationId);
		return this.loadGenerationFromDirectory(
			generationPath,
			generationId,
			expectedManifestSha256,
		);
	}

	private async loadGenerationFromDirectory(
		directoryPath: string,
		expectedGenerationId: string,
		expectedManifestSha256?: string,
	): Promise<StoredGeneration> {
		await this.assertStoreTopology();
		const directoryIdentity = await this.assertSafeDirectory(
			directoryPath,
			`generation ${expectedGenerationId}`,
		);
		const readyBytes = await readSecureFile(
			this.resolveContainedFile(directoryPath, READY_FILE),
			MAX_CONTROL_FILE_BYTES,
		);
		const ready = parseReadyMarker(readyBytes);
		if (ready.generationId !== expectedGenerationId) {
			throw new GenerationStoreCorruptionError('READY generationId does not match its directory.');
		}
		if (expectedManifestSha256 && ready.manifestSha256 !== expectedManifestSha256) {
			throw new GenerationStoreCorruptionError('CURRENT manifest checksum does not match READY.');
		}

		const manifestBytes = await readSecureFile(
			this.resolveContainedFile(directoryPath, MANIFEST_FILE),
			MAX_CONTROL_FILE_BYTES,
		);
		if (sha256(manifestBytes) !== ready.manifestSha256) {
			throw new GenerationStoreCorruptionError('Generation manifest checksum mismatch.');
		}
		const manifest = parseManifest(manifestBytes, this.maxPayloadBytes);
		if (manifest.generationId !== expectedGenerationId) {
			throw new GenerationStoreCorruptionError('Manifest generationId does not match its directory.');
		}

		const payloadPath = this.resolveContainedFile(directoryPath, manifest.payload.fileName);
		const payloadBytes = await readSecureFile(payloadPath, this.maxPayloadBytes);
		if (payloadBytes.byteLength !== manifest.payload.byteLength) {
			throw new GenerationStoreCorruptionError('Generation payload length mismatch.');
		}
		if (sha256(payloadBytes) !== manifest.payload.sha256) {
			throw new GenerationStoreCorruptionError('Generation payload checksum mismatch.');
		}

		let payload: GenerationPayload = payloadBytes;
		if (manifest.payload.kind === 'json') {
			try {
				payload = JSON.parse(payloadBytes.toString('utf8')) as JsonValue;
				assertJsonValue(payload);
			} catch (error) {
				throw new GenerationStoreCorruptionError('Generation JSON payload is invalid.', {
					cause: error,
				});
			}
		}
		await this.assertDirectoryIdentity(
			directoryPath,
			`generation ${expectedGenerationId}`,
			directoryIdentity,
		);
		await this.assertStoreTopology();
		return { manifest, payload };
	}

	private async pointerForGeneration(generationId: string): Promise<GenerationPointer | null> {
		try {
			await this.loadGeneration(generationId);
			const readyBytes = await readSecureFile(
				this.resolveManagedPath(GENERATIONS_DIRECTORY, generationId, READY_FILE),
				MAX_CONTROL_FILE_BYTES,
			);
			const ready = parseReadyMarker(readyBytes);
			return {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				generationId,
				manifestSha256: ready.manifestSha256,
				previousGenerationId: null,
				previousManifestSha256: null,
				updatedAt: new Date().toISOString(),
			};
		} catch {
			return null;
		}
	}

	private async readPointerOptional(fileName: string): Promise<GenerationPointer | null> {
		await this.assertStoreTopology();
		const pointerPath = this.resolveRootChild(fileName);
		let pointerBytes: Buffer;
		try {
			pointerBytes = await readSecureFile(pointerPath, MAX_CONTROL_FILE_BYTES);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) {
				await this.assertStoreTopology();
				return null;
			}
			throw error;
		}
		const pointer = parseGenerationPointer(pointerBytes);
		await this.assertStoreTopology();
		return pointer;
	}

	private async writePointerAtomic(fileName: string, pointer: GenerationPointer): Promise<void> {
		await this.writeRootFileAtomic(fileName, encodeControlJson(pointer));
	}

	private async writeRootFileAtomic(fileName: string, bytes: Buffer): Promise<void> {
		await this.assertStoreTopology();
		const targetPath = this.resolveRootChild(fileName);
		await this.requireRegularFileOrMissing(targetPath, fileName);
		const temporaryName = `.${fileName}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
		const temporaryPath = this.resolveRootChild(temporaryName);
		await writeNewFile(temporaryPath, bytes);
		try {
			await rename(temporaryPath, targetPath);
			await syncDirectory(this.canonicalRootPath);
			await this.assertStoreTopology();
		} catch (error) {
			await unlink(temporaryPath).catch(() => undefined);
			throw error;
		}
	}

	private async removeRootFileIfPresent(fileName: string): Promise<void> {
		await this.assertStoreTopology();
		const filePath = this.resolveRootChild(fileName);
		try {
			await this.requireRegularFileOrMissing(filePath, fileName);
			await unlink(filePath);
			await syncDirectory(this.canonicalRootPath);
			await this.assertStoreTopology();
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return;
			throw error;
		}
	}

	private async withWriterLock<T>(operation: () => Promise<T>): Promise<T> {
		const token = randomBytes(16).toString('hex');
		await this.acquireWriterLock(token);
		try {
			await this.assertStoreTopology();
			return await operation();
		} finally {
			await this.releaseWriterLock(token);
		}
	}

	private async acquireWriterLock(token: string): Promise<void> {
		const deadline = Date.now() + this.lockTimeoutMs;
		const lockPath = this.resolveRootChild(WRITER_LOCK_DIRECTORY);
		for (;;) {
			await this.assertStoreTopology();
			const temporaryLockPath = this.resolveManagedPath(
				STAGING_DIRECTORY,
				`lock-${process.pid}-${randomBytes(16).toString('hex')}`,
			);
			await mkdir(temporaryLockPath, { mode: 0o700 });
			const temporaryLockIdentity = await this.assertSafeDirectory(
				temporaryLockPath,
				'temporary writer lock',
			);
			const owner: WriterLockOwner = {
				schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
				pid: process.pid,
				token,
				createdAt: new Date().toISOString(),
			};
			await writeNewFile(
				this.resolveContainedFile(temporaryLockPath, 'owner.json'),
				encodeControlJson(owner),
			);
			await syncDirectory(temporaryLockPath);
			await this.assertDirectoryIdentity(
				temporaryLockPath,
				'temporary writer lock',
				temporaryLockIdentity,
			);
			await this.assertStoreTopology();

			let lockWasRenamed = false;
			try {
				await rename(temporaryLockPath, lockPath);
				lockWasRenamed = true;
				await syncDirectory(this.canonicalRootPath);
				await this.assertStoreTopology();
				await this.assertDirectoryIdentity(
					lockPath,
					'writer lock',
					temporaryLockIdentity,
				);
				return;
			} catch (error) {
				if (lockWasRenamed) throw error;
				await this.assertDirectoryIdentity(
					temporaryLockPath,
					'temporary writer lock',
					temporaryLockIdentity,
				).catch((identityError) => {
					throw identityError;
				});
				await rm(temporaryLockPath, { recursive: true, force: true });
				await this.assertStoreTopology();
				if (!isAlreadyExistsError(error)) throw error;
			}

			const recovered = await this.recoverAbandonedLock(lockPath);
			if (recovered) continue;
			if (Date.now() >= deadline) {
				throw new GenerationStoreBusyError('Generation store writer lock is busy.');
			}
			await delay(Math.min(25, Math.max(1, deadline - Date.now())));
		}
	}

	private async recoverAbandonedLock(lockPath: string): Promise<boolean> {
		let owner: WriterLockOwner;
		let lockIdentity: DirectoryIdentity;
		try {
			lockIdentity = await this.assertSafeDirectory(lockPath, 'writer lock');
			owner = parseWriterLockOwner(await readSecureFile(
				this.resolveContainedFile(lockPath, 'owner.json'),
				MAX_CONTROL_FILE_BYTES,
			));
			await this.assertDirectoryIdentity(lockPath, 'writer lock', lockIdentity);
			await this.assertStoreTopology();
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return true;
			throw error;
		}
		if (isProcessAlive(owner.pid)) return false;

		const abandonedPath = this.resolveManagedPath(
			STAGING_DIRECTORY,
			`abandoned-lock-${owner.token}-${randomBytes(8).toString('hex')}`,
		);
		try {
			await this.assertDirectoryIdentity(lockPath, 'writer lock', lockIdentity);
			await this.assertStoreTopology();
			await rename(lockPath, abandonedPath);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return true;
			throw error;
		}
		await this.assertStoreTopology();
		await this.assertDirectoryIdentity(
			abandonedPath,
			'abandoned writer lock',
			lockIdentity,
		);
		const movedOwner = parseWriterLockOwner(await readSecureFile(
			this.resolveContainedFile(abandonedPath, 'owner.json'),
			MAX_CONTROL_FILE_BYTES,
		));
		if (movedOwner.token !== owner.token) {
			throw new GenerationStoreCorruptionError('Writer lock changed during recovery.');
		}
		await this.assertDirectoryIdentity(
			abandonedPath,
			'abandoned writer lock',
			lockIdentity,
		);
		await rm(abandonedPath, { recursive: true, force: true });
		await this.assertStoreTopology();
		await syncDirectory(this.canonicalRootPath);
		return true;
	}

	private async releaseWriterLock(token: string): Promise<void> {
		const lockPath = this.resolveRootChild(WRITER_LOCK_DIRECTORY);
		const lockIdentity = await this.assertSafeDirectory(lockPath, 'writer lock');
		const owner = parseWriterLockOwner(await readSecureFile(
			this.resolveContainedFile(lockPath, 'owner.json'),
			MAX_CONTROL_FILE_BYTES,
		));
		if (owner.pid !== process.pid || owner.token !== token) {
			throw new GenerationStoreCorruptionError('Writer lock ownership changed before release.');
		}
		await this.assertDirectoryIdentity(lockPath, 'writer lock', lockIdentity);
		await this.assertStoreTopology();
		const releasedPath = this.resolveManagedPath(
			STAGING_DIRECTORY,
			`released-lock-${token}-${randomBytes(8).toString('hex')}`,
		);
		await rename(lockPath, releasedPath);
		await this.assertStoreTopology();
		await this.assertDirectoryIdentity(
			releasedPath,
			'released writer lock',
			lockIdentity,
		);
		const movedOwner = parseWriterLockOwner(await readSecureFile(
			this.resolveContainedFile(releasedPath, 'owner.json'),
			MAX_CONTROL_FILE_BYTES,
		));
		if (movedOwner.pid !== process.pid || movedOwner.token !== token) {
			throw new GenerationStoreCorruptionError('Writer lock changed during release.');
		}
		await this.assertDirectoryIdentity(
			releasedPath,
			'released writer lock',
			lockIdentity,
		);
		await rm(releasedPath, { recursive: true, force: true });
		await this.assertStoreTopology();
		await syncDirectory(this.canonicalRootPath);
	}

	private resolveRootChild(name: string): string {
		if (!isSimpleName(name)) {
			throw new GenerationStoreError(`Unsafe generation store path component: ${name}`);
		}
		const resolved = path.join(this.canonicalRootPath, name);
		this.assertContained(resolved);
		return resolved;
	}

	private resolveManagedPath(directoryName: string, ...components: string[]): string {
		if (!isSimpleName(directoryName) || components.some((component) => !isSimpleName(component))) {
			throw new GenerationStoreError('Unsafe generation store path component.');
		}
		const resolved = path.join(this.canonicalRootPath, directoryName, ...components);
		this.assertContained(resolved);
		return resolved;
	}

	private resolveContainedFile(directoryPath: string, fileName: string): string {
		if (!isSimpleName(fileName)) {
			throw new GenerationStoreError(`Unsafe generation filename: ${fileName}`);
		}
		const resolved = path.join(directoryPath, fileName);
		this.assertContained(resolved);
		return resolved;
	}

	private assertContained(candidatePath: string): void {
		const relative = path.relative(this.canonicalRootPath, candidatePath);
		if (!relative || relative === '.') return;
		if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new GenerationStoreError('Generation store path escapes its root.');
		}
	}

	private async requireMissing(candidatePath: string, label: string): Promise<void> {
		try {
			await lstat(candidatePath);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return;
			throw error;
		}
		throw new GenerationStoreCorruptionError(`${label} already exists.`);
	}

	private async requireRegularFileOrMissing(candidatePath: string, label: string): Promise<void> {
		try {
			const candidateStat = await lstat(candidatePath);
			if (candidateStat.isSymbolicLink() || !candidateStat.isFile()) {
				throw new GenerationStoreCorruptionError(`${label} is not a safe regular file.`);
			}
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return;
			throw error;
		}
	}

	private async pathExists(candidatePath: string): Promise<boolean> {
		try {
			await lstat(candidatePath);
			return true;
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return false;
			throw error;
		}
	}
}

function encodePayload(payload: GenerationPayload): EncodedPayload {
	if (Buffer.isBuffer(payload)) {
		return { kind: 'buffer', fileName: BUFFER_PAYLOAD_FILE, bytes: Buffer.from(payload) };
	}
	assertJsonValue(payload);
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(payload);
	} catch (error) {
		throw new GenerationStoreError('JSON payload cannot be serialized.', { cause: error });
	}
	if (serialized === undefined) {
		throw new GenerationStoreError('JSON payload cannot be serialized.');
	}
	return {
		kind: 'json',
		fileName: JSON_PAYLOAD_FILE,
		bytes: Buffer.from(serialized, 'utf8'),
	};
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
	const pending: unknown[] = [value];
	const seen = new WeakSet<object>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
		if (typeof current === 'number' && Number.isFinite(current)) continue;
		if (typeof current !== 'object') {
			throw new GenerationStoreError('Payload must contain only JSON values.');
		}
		if (seen.has(current)) continue;
		seen.add(current);
		if (Array.isArray(current)) {
			for (const item of current) pending.push(item);
			continue;
		}
		const prototype = Object.getPrototypeOf(current) as object | null;
		if (prototype !== Object.prototype && prototype !== null) {
			throw new GenerationStoreError('JSON payload objects must be plain objects.');
		}
		if (Object.getOwnPropertySymbols(current).length > 0) {
			throw new GenerationStoreError('JSON payload must not contain symbol properties.');
		}
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
			if (!('value' in descriptor)) {
				throw new GenerationStoreError('JSON payload must not contain accessor properties.');
			}
			pending.push(descriptor.value);
		}
	}
}

function parseManifest(bytes: Buffer, maxPayloadBytes: number): GenerationManifest {
	const value = parseControlJson(bytes, 'manifest');
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		'schemaVersion',
		'generationId',
		'createdAt',
		'parentGenerationId',
		'payload',
	])) {
		throw new GenerationStoreCorruptionError('Generation manifest schema is invalid.');
	}
	if (value.schemaVersion !== GENERATION_STORE_SCHEMA_VERSION) {
		throw new GenerationStoreCorruptionError('Unsupported generation manifest schema version.');
	}
	assertGenerationIdForCorruption(value.generationId, 'manifest generationId');
	assertIsoDate(value.createdAt, 'manifest createdAt');
	if (value.parentGenerationId !== null) {
		assertGenerationIdForCorruption(value.parentGenerationId, 'manifest parentGenerationId');
	}
	if (!isPlainRecord(value.payload) || !hasExactKeys(value.payload, [
		'kind',
		'fileName',
		'byteLength',
		'sha256',
	])) {
		throw new GenerationStoreCorruptionError('Generation payload manifest schema is invalid.');
	}
	const kind = value.payload.kind;
	const fileName = value.payload.fileName;
	if (
		(kind !== 'buffer' && kind !== 'json')
		|| (kind === 'buffer' && fileName !== BUFFER_PAYLOAD_FILE)
		|| (kind === 'json' && fileName !== JSON_PAYLOAD_FILE)
	) {
		throw new GenerationStoreCorruptionError('Generation payload kind or filename is invalid.');
	}
	if (
		typeof value.payload.byteLength !== 'number'
		|| !Number.isSafeInteger(value.payload.byteLength)
		|| value.payload.byteLength < 0
		|| value.payload.byteLength > maxPayloadBytes
	) {
		throw new GenerationStoreCorruptionError('Generation payload length is invalid.');
	}
	assertSha256ForCorruption(value.payload.sha256, 'payload checksum');

	const manifest: GenerationManifest = {
		schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
		generationId: value.generationId,
		createdAt: value.createdAt,
		parentGenerationId: value.parentGenerationId,
		payload: {
			kind,
			fileName: kind === 'buffer' ? BUFFER_PAYLOAD_FILE : JSON_PAYLOAD_FILE,
			byteLength: value.payload.byteLength,
			sha256: value.payload.sha256,
		},
	};
	assertCanonicalControlJson(bytes, manifest, 'manifest');
	return manifest;
}

function parseReadyMarker(bytes: Buffer): ReadyMarker {
	const value = parseControlJson(bytes, 'READY marker');
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		'schemaVersion',
		'generationId',
		'manifestSha256',
	])) {
		throw new GenerationStoreCorruptionError('READY marker schema is invalid.');
	}
	if (value.schemaVersion !== GENERATION_STORE_SCHEMA_VERSION) {
		throw new GenerationStoreCorruptionError('Unsupported READY marker schema version.');
	}
	assertGenerationIdForCorruption(value.generationId, 'READY generationId');
	assertSha256ForCorruption(value.manifestSha256, 'READY manifest checksum');
	const ready: ReadyMarker = {
		schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
		generationId: value.generationId,
		manifestSha256: value.manifestSha256,
	};
	assertCanonicalControlJson(bytes, ready, 'READY marker');
	return ready;
}

function parseGenerationPointer(bytes: Buffer): GenerationPointer {
	const value = parseControlJson(bytes, 'generation pointer');
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		'schemaVersion',
		'generationId',
		'manifestSha256',
		'previousGenerationId',
		'previousManifestSha256',
		'updatedAt',
	])) {
		throw new GenerationStoreCorruptionError('Generation pointer schema is invalid.');
	}
	if (value.schemaVersion !== GENERATION_STORE_SCHEMA_VERSION) {
		throw new GenerationStoreCorruptionError('Unsupported generation pointer schema version.');
	}
	assertGenerationIdForCorruption(value.generationId, 'pointer generationId');
	assertSha256ForCorruption(value.manifestSha256, 'pointer manifest checksum');
	assertIsoDate(value.updatedAt, 'pointer updatedAt');
	const hasPreviousId = value.previousGenerationId !== null;
	const hasPreviousChecksum = value.previousManifestSha256 !== null;
	if (hasPreviousId !== hasPreviousChecksum) {
		throw new GenerationStoreCorruptionError('Generation pointer previous fields are inconsistent.');
	}
	let previousGenerationId: string | null = null;
	let previousManifestSha256: string | null = null;
	if (hasPreviousId) {
		assertGenerationIdForCorruption(value.previousGenerationId, 'pointer previousGenerationId');
		assertSha256ForCorruption(
			value.previousManifestSha256,
			'pointer previous manifest checksum',
		);
		if (value.previousGenerationId === value.generationId) {
			throw new GenerationStoreCorruptionError('Generation pointer cannot refer to itself as previous.');
		}
		previousGenerationId = value.previousGenerationId;
		previousManifestSha256 = value.previousManifestSha256;
	}
	const pointer: GenerationPointer = {
		schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
		generationId: value.generationId,
		manifestSha256: value.manifestSha256,
		previousGenerationId,
		previousManifestSha256,
		updatedAt: value.updatedAt,
	};
	assertCanonicalControlJson(bytes, pointer, 'generation pointer');
	return pointer;
}

function parseWriterLockOwner(bytes: Buffer): WriterLockOwner {
	const value = parseControlJson(bytes, 'writer lock owner');
	if (!isPlainRecord(value) || !hasExactKeys(value, [
		'schemaVersion',
		'pid',
		'token',
		'createdAt',
	])) {
		throw new GenerationStoreCorruptionError('Writer lock owner schema is invalid.');
	}
	if (
		value.schemaVersion !== GENERATION_STORE_SCHEMA_VERSION
		|| typeof value.pid !== 'number'
		|| !Number.isSafeInteger(value.pid)
		|| value.pid <= 0
		|| typeof value.token !== 'string'
		|| !LOCK_TOKEN_PATTERN.test(value.token)
	) {
		throw new GenerationStoreCorruptionError('Writer lock owner is invalid.');
	}
	assertIsoDate(value.createdAt, 'writer lock createdAt');
	const owner: WriterLockOwner = {
		schemaVersion: GENERATION_STORE_SCHEMA_VERSION,
		pid: value.pid,
		token: value.token,
		createdAt: value.createdAt,
	};
	assertCanonicalControlJson(bytes, owner, 'writer lock owner');
	return owner;
}

function parseControlJson(bytes: Buffer, label: string): unknown {
	try {
		return JSON.parse(bytes.toString('utf8')) as unknown;
	} catch (error) {
		throw new GenerationStoreCorruptionError(`${label} is not valid JSON.`, { cause: error });
	}
}

function assertCanonicalControlJson(bytes: Buffer, value: object, label: string): void {
	if (!bytes.equals(encodeControlJson(value))) {
		throw new GenerationStoreCorruptionError(`${label} is not in canonical form.`);
	}
}

function encodeControlJson(value: object): Buffer {
	return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeNewFile(filePath: string, bytes: Buffer): Promise<void> {
	const handle = await open(filePath, CREATE_NEW_FLAGS, 0o600);
	try {
		const openedStat = await handle.stat();
		if (!openedStat.isFile() || openedStat.nlink !== 1) {
			throw new GenerationStoreCorruptionError('New generation file is not a safe regular file.');
		}
		await handle.writeFile(bytes);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readSecureFile(filePath: string, maximumBytes: number): Promise<Buffer> {
	const beforeLstat = await lstat(filePath);
	if (
		beforeLstat.isSymbolicLink()
		|| !beforeLstat.isFile()
		|| beforeLstat.nlink !== 1
		|| beforeLstat.size > maximumBytes
	) {
		throw new GenerationStoreCorruptionError('Unsafe or oversized generation file.');
	}
	const handle = await open(filePath, READ_ONLY_FLAGS);
	try {
		const beforeRead = await handle.stat();
		if (
			!beforeRead.isFile()
			|| beforeRead.nlink !== 1
			|| beforeRead.dev !== beforeLstat.dev
			|| beforeRead.ino !== beforeLstat.ino
			|| beforeRead.size !== beforeLstat.size
			|| beforeRead.size > maximumBytes
		) {
			throw new GenerationStoreCorruptionError('Generation file changed while opening.');
		}
		const bytes = Buffer.alloc(beforeRead.size);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		const overflowProbe = Buffer.allocUnsafe(1);
		const overflow = await handle.read(overflowProbe, 0, 1, beforeRead.size);
		const afterRead = await handle.stat();
		if (
			afterRead.dev !== beforeRead.dev
			|| afterRead.ino !== beforeRead.ino
			|| afterRead.size !== beforeRead.size
			|| afterRead.mtimeMs !== beforeRead.mtimeMs
			|| afterRead.ctimeMs !== beforeRead.ctimeMs
			|| offset !== beforeRead.size
			|| overflow.bytesRead !== 0
		) {
			throw new GenerationStoreCorruptionError('Generation file changed while reading.');
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function syncDirectory(directoryPath: string): Promise<void> {
	let handle;
	try {
		handle = await open(directoryPath, READ_DIRECTORY_FLAGS);
		await handle.sync();
	} catch (error) {
		if (
			process.platform === 'win32'
			&& (isNodeError(error, 'EINVAL') || isNodeError(error, 'ENOTSUP') || isNodeError(error, 'EPERM'))
		) {
			return;
		}
		throw error;
	} finally {
		if (handle) await handle.close();
	}
}

function createGenerationId(): string {
	return `gen-${Date.now().toString().padStart(13, '0')}-${randomBytes(16).toString('hex')}`;
}

function sha256(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

function assertGenerationId(generationId: string): void {
	if (!GENERATION_ID_PATTERN.test(generationId)) {
		throw new GenerationStoreError('Invalid generation id.');
	}
}

function assertGenerationIdForCorruption(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !GENERATION_ID_PATTERN.test(value)) {
		throw new GenerationStoreCorruptionError(`${label} is invalid.`);
	}
}

function assertSha256(value: string): void {
	if (!SHA256_PATTERN.test(value)) {
		throw new GenerationStoreError('Invalid SHA-256 checksum.');
	}
}

function assertSha256ForCorruption(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
		throw new GenerationStoreCorruptionError(`${label} is invalid.`);
	}
}

function assertIsoDate(value: unknown, label: string): asserts value is string {
	if (typeof value !== 'string') {
		throw new GenerationStoreCorruptionError(`${label} is invalid.`);
	}
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
		throw new GenerationStoreCorruptionError(`${label} is invalid.`);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(record).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length
		&& keys.every((key, index) => key === sortedExpected[index]);
}

function assertPrivateDirectory(directoryStat: Stats, label: string): void {
	if (process.platform === 'win32') return;
	if ((directoryStat.mode & 0o077) !== 0) {
		throw new GenerationStoreCorruptionError(
			`${label} must not grant group or other filesystem permissions.`,
		);
	}
	const getUserId = process.getuid;
	if (typeof getUserId === 'function' && directoryStat.uid !== getUserId()) {
		throw new GenerationStoreCorruptionError(
			`${label} must be owned by the current service user.`,
		);
	}
}

function sameDirectoryIdentity(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

function isSimpleName(value: string): boolean {
	return Boolean(value)
		&& value !== '.'
		&& value !== '..'
		&& !value.includes('/')
		&& !value.includes('\\')
		&& !value.includes('\0');
}

function readPositiveSafeInteger(
	value: number | undefined,
	fallback: number,
	label: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new GenerationStoreError(`${label} must be a positive safe integer.`);
	}
	return value;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && 'code' in error && error.code === code;
}

function isAlreadyExistsError(error: unknown): boolean {
	return isNodeError(error, 'EEXIST') || isNodeError(error, 'ENOTEMPTY');
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, 'ESRCH');
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
