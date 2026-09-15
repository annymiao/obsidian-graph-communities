import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
	link,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateFileHandle,
	assertPrivateFilePath,
	assertPrivateRegularFileStats,
	ensurePrivateDirectory,
	readPrivateFile,
	syncPrivateDirectory,
} from '../privateFs.js';
import type { SourceId } from '../stableIds.js';
import {
	CONTROLLED_WRITE_SCHEMA_VERSION,
	type AdapterCommitRequest,
	type AdapterCommitResult,
	type AdapterRollbackRequest,
	type AdapterRollbackResult,
	type BaseVersion,
	type DocumentSnapshot,
	type SourceRef,
	type WritableSourceAdapter,
	type WriteOperation,
} from '../write/contracts.js';
import { canonicalJson } from '../write/integrity.js';
import { withOwnedFileLock } from '../write/fileLock.js';
import {
	createDocumentSnapshot,
	createSourceRef,
	validateWritePlan,
} from '../write/proposal.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;
const READ_ONLY = constants.O_RDONLY | NO_FOLLOW;
const READ_DIRECTORY = constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const KEY_FILE = 'adapter.key';
const ROLLBACK_DIRECTORY = 'rollback';
const WRITER_LOCK_FILE = '.writer.lock';
const WRITER_LOCK_TIMEOUT_MS = 5_000;
const TRANSACTION_PATTERN = /^txn_v1_[a-f0-9]{32}$/u;
const ROLLBACK_TOKEN_PATTERN = /^rollback_v1_(txn_v1_[a-f0-9]{32})_([a-f0-9]{64})$/u;
const DEFAULT_MAXIMUM_FILE_BYTES = 8 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

interface DirectoryIdentity {
	dev: number;
	ino: number;
}

interface RollbackCapsuleMaterial {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	transactionId: string;
	createdAt: string;
	source: SourceRef;
	operation: WriteOperation;
	beforeContent: string | null;
	beforeVersion: BaseVersion | null;
	committedVersion: BaseVersion | null;
}

interface RollbackCapsule extends RollbackCapsuleMaterial {
	signature: string;
}

interface RollbackInProgressMaterial extends RollbackCapsuleMaterial {
	state: 'in-progress';
	rollbackStartedAt: string;
	capsuleSignature: string;
}

interface RollbackInProgress extends RollbackInProgressMaterial {
	signature: string;
}

interface RollbackConsumedMarkerMaterial {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	state: 'consumed';
	transactionId: string;
	consumedAt: string;
	source: SourceRef;
	operation: WriteOperation;
	beforeVersion: BaseVersion | null;
	committedVersion: BaseVersion | null;
	capsuleSignature: string;
}

interface RollbackConsumedMarker extends RollbackConsumedMarkerMaterial {
	signature: string;
}

type RollbackState =
	| { state: 'active'; record: RollbackCapsule }
	| { state: 'in-progress'; record: RollbackInProgress }
	| { state: 'consumed'; record: RollbackConsumedMarker };

export type DirectoryWriterFaultPoint = 'after-rollback-source-restored';

export interface SafeDirectoryWriterAdapterOptions {
	adapterId: string;
	sourceId: SourceId;
	rootPath: string;
	/** Must be outside rootPath so rollback content cannot be indexed as knowledge. */
	statePath: string;
	maxFileBytes?: number;
	lockTimeoutMs?: number;
	/** Test-only crash injection. Production callers must leave this unset. */
	testOnlyFaultInjector?: (point: DirectoryWriterFaultPoint) => void | Promise<void>;
}

export class DirectoryWriteError extends Error {
	constructor(
		message: string,
		readonly transactionId: string,
		readonly recoveryToken: string | null,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'DirectoryWriteError';
	}
}

/**
 * A local Markdown writer with static symlink rejection, optimistic CAS, and
 * same-directory atomic publication. Node 20 has no portable openat/dirfd API;
 * callers must not grant an untrusted same-user process mutation access to the
 * source root while a write is executing.
 */
export class SafeDirectoryWriterAdapter implements WritableSourceAdapter {
	readonly adapterId: string;
	readonly sourceId: SourceId;
	readonly supportedOperations: ReadonlySet<WriteOperation> = new Set([
		'create', 'replace', 'delete',
	]);

	private readonly configuredRoot: string;
	private readonly configuredState: string;
	private readonly maxFileBytes: number;
	private readonly lockTimeoutMs: number;
	private readonly testOnlyFaultInjector?: SafeDirectoryWriterAdapterOptions['testOnlyFaultInjector'];
	private canonicalRoot = '';
	private canonicalState = '';
	private canonicalRollback = '';
	private rootIdentity: DirectoryIdentity | null = null;
	private stateIdentity: DirectoryIdentity | null = null;
	private rollbackIdentity: DirectoryIdentity | null = null;
	private signingKey: Buffer | null = null;
	private initialization: Promise<void> | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: SafeDirectoryWriterAdapterOptions) {
		this.adapterId = options.adapterId;
		this.sourceId = options.sourceId;
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(this.adapterId)) {
			throw new TypeError('Directory adapterId is invalid.');
		}
		if (!/^src_v1_[A-Za-z0-9_-]{43}$/u.test(this.sourceId)) {
			throw new TypeError('Directory sourceId is invalid.');
		}
		this.configuredRoot = assertConfiguredPath(options.rootPath, 'source root');
		this.configuredState = assertConfiguredPath(options.statePath, 'writer state');
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAXIMUM_FILE_BYTES;
		this.lockTimeoutMs = options.lockTimeoutMs ?? WRITER_LOCK_TIMEOUT_MS;
		this.testOnlyFaultInjector = options.testOnlyFaultInjector;
		if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes <= 0) {
			throw new TypeError('maxFileBytes must be a positive safe integer.');
		}
		if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs <= 0 || this.lockTimeoutMs > 60_000) {
			throw new TypeError('lockTimeoutMs must be an integer from 1 to 60000.');
		}
	}

	async initialize(): Promise<void> {
		await this.ensureInitialized();
	}

	async inspect(source: SourceRef): Promise<DocumentSnapshot | null> {
		await this.ensureInitialized();
		this.assertSource(source);
		await this.assertRoots();
		return this.readSnapshot(source);
	}

	async commit(request: AdapterCommitRequest): Promise<AdapterCommitResult> {
		return this.serialized(async () => {
			await this.ensureInitialized();
			validateWritePlan(request.plan);
			this.assertTransactionId(request.transactionId);
			this.assertSource(request.plan.source);
			if (!this.supportedOperations.has(request.plan.operation)) {
				throw new DirectoryWriteError(
					`Unsupported directory write operation: ${request.plan.operation}`,
					request.transactionId,
					null,
				);
			}
			await this.assertRoots();
			const current = await this.readSnapshot(request.plan.source);
			assertSameVersion(
				current?.baseVersion ?? null,
				request.plan.expectedBase,
				'Directory write CAS precondition',
			);

			const material: RollbackCapsuleMaterial = {
				schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
				transactionId: request.transactionId,
				createdAt: new Date().toISOString(),
				source: request.plan.source,
				operation: request.plan.operation,
				beforeContent: current?.content ?? null,
				beforeVersion: current?.baseVersion ?? null,
				committedVersion: request.plan.desiredVersion,
			};
			const rollbackToken = this.createRollbackToken(material);
			await this.writeRollbackCapsule(material);
			try {
				await this.applyOperation(
					request.plan.source,
					request.plan.operation,
					request.plan.expectedBase,
					request.plan.afterContent,
					request.transactionId,
				);
				const committed = await this.readSnapshot(request.plan.source);
				assertSameVersion(
					committed?.baseVersion ?? null,
					request.plan.desiredVersion,
					'Directory write postcondition',
				);
				return {
					transactionId: request.transactionId,
					source: request.plan.source,
					operation: request.plan.operation,
					previousVersion: current?.baseVersion ?? null,
					committedVersion: committed?.baseVersion ?? null,
					rollbackToken,
					committedAt: new Date().toISOString(),
				};
			} catch (error) {
				throw new DirectoryWriteError(
					'Directory write failed after rollback material was secured.',
					request.transactionId,
					rollbackToken,
					{ cause: error },
				);
			}
		});
	}

	async rollback(request: AdapterRollbackRequest): Promise<AdapterRollbackResult> {
		return this.serialized(async () => {
			await this.ensureInitialized();
			this.assertTransactionId(request.transactionId);
			this.assertTransactionId(request.originalTransactionId);
			this.assertSource(request.source);
			await this.assertRoots();
			const rollbackState = await this.readRollbackState(request.rollbackToken);
			if (rollbackState.state === 'consumed') {
				throw new Error('Rollback token is missing or already consumed.');
			}
			const pending = rollbackState.record;
			if (
				pending.transactionId !== request.originalTransactionId
				|| canonicalJson(pending.source) !== canonicalJson(request.source)
			) {
				throw new DirectoryWriteError(
					'Rollback token is bound to a different transaction or source.',
					request.transactionId,
					null,
				);
			}
			assertSameVersion(
				request.expectedCurrentVersion,
				pending.committedVersion,
				'Rollback receipt binding',
			);
			const inProgress = rollbackState.state === 'active'
				? await this.beginRollback(rollbackState.record)
				: rollbackState.record;
			const current = await this.readSnapshot(request.source);
			const currentVersion = current?.baseVersion ?? null;
			if (sameVersion(currentVersion, inProgress.committedVersion)) {
				const inverseOperation: WriteOperation = inProgress.beforeContent === null
					? 'delete'
					: current === null ? 'create' : 'replace';
				await this.applyOperation(
					request.source,
					inverseOperation,
					inProgress.committedVersion,
					inProgress.beforeContent,
					request.transactionId,
				);
			} else if (!sameVersion(currentVersion, inProgress.beforeVersion)) {
				throw new Error(
					'Directory rollback CAS precondition failed because the document is neither committed nor restored.',
				);
			}
			const restored = await this.readSnapshot(request.source);
			assertSameVersion(
				restored?.baseVersion ?? null,
				inProgress.beforeVersion,
				'Directory rollback postcondition',
			);
			await this.testOnlyFaultInjector?.('after-rollback-source-restored');
			const consumedAt = await this.completeRollback(inProgress);
			return {
				transactionId: request.transactionId,
				source: request.source,
				restoredVersion: restored?.baseVersion ?? null,
				rolledBackAt: consumedAt,
			};
		});
	}

	private async applyOperation(
		source: SourceRef,
		operation: WriteOperation,
		expected: BaseVersion | null,
		content: string | null,
		transactionId: string,
	): Promise<void> {
		const parent = await this.resolveParent(source.documentPath, operation === 'create');
		if (!parent) throw new Error('Document parent directory does not exist.');
		const targetPath = path.join(parent.path, parent.fileName);
		const current = await this.readSnapshot(source);
		assertSameVersion(current?.baseVersion ?? null, expected, 'Directory write final CAS');
		await this.assertDirectoryIdentity(parent.path, parent.identity, 'document parent');

		if (operation === 'delete') {
			if (content !== null || current === null) throw new Error('Delete operation state is invalid.');
			await unlink(targetPath);
			await syncDirectory(parent.path);
			await this.assertRoots();
			return;
		}
		if (content === null) throw new Error(`${operation} operation requires content.`);
		assertRoundTripUtf8(content);
		const bytes = Buffer.from(content, 'utf8');
		if (bytes.byteLength > this.maxFileBytes) {
			throw new RangeError(`Document exceeds maxFileBytes (${this.maxFileBytes}).`);
		}
		const temporaryPath = path.join(
			parent.path,
			`.${parent.fileName}.${transactionId}.${randomBytes(8).toString('hex')}.tmp`,
		);
		let temporaryExists = false;
		try {
			const handle = await open(temporaryPath, CREATE_NEW, 0o600);
			temporaryExists = true;
			try {
				await handle.writeFile(bytes);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await this.assertDirectoryIdentity(parent.path, parent.identity, 'document parent');
			const latest = await this.readSnapshot(source);
			assertSameVersion(latest?.baseVersion ?? null, expected, 'Directory write publish CAS');
			if (operation === 'create') {
				await link(temporaryPath, targetPath);
				await unlink(temporaryPath);
				temporaryExists = false;
			} else {
				await rename(temporaryPath, targetPath);
				temporaryExists = false;
			}
			await syncDirectory(parent.path);
			await this.assertDirectoryIdentity(parent.path, parent.identity, 'document parent');
			await this.assertRoots();
		} finally {
			if (temporaryExists) {
				await unlink(temporaryPath).catch((error: unknown) => {
					if (!isNodeError(error, 'ENOENT')) throw error;
				});
			}
		}
	}

	private async readSnapshot(source: SourceRef): Promise<DocumentSnapshot | null> {
		const parent = await this.resolveParent(source.documentPath, false);
		if (!parent) return null;
		const targetPath = path.join(parent.path, parent.fileName);
		let pathInfo;
		try {
			pathInfo = await lstat(targetPath);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return null;
			throw error;
		}
		if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
			throw new Error('Document must be a real regular file.');
		}
		let handle;
		try {
			handle = await open(targetPath, READ_ONLY);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return null;
			throw error;
		}
		try {
			const before = await handle.stat();
			if (!before.isFile() || !sameObject(pathInfo, before) || before.size > this.maxFileBytes) {
				throw new Error('Document must be a bounded regular file.');
			}
			const bytes = await handle.readFile();
			const after = await handle.stat();
			if (!sameIdentity(before, after) || bytes.byteLength !== before.size) {
				throw new Error('Document changed while it was being read.');
			}
			await this.assertDirectoryIdentity(parent.path, parent.identity, 'document parent');
			return createDocumentSnapshot(source, UTF8_DECODER.decode(bytes));
		} finally {
			await handle.close();
		}
	}

	private async resolveParent(
		documentPath: string,
		createMissing: boolean,
	): Promise<{ path: string; fileName: string; identity: DirectoryIdentity } | null> {
		assertWritableDocumentPath(documentPath);
		const segments = documentPath.split('/');
		const fileName = segments.pop();
		if (!fileName) throw new TypeError('Document path has no file name.');
		let current = this.canonicalRoot;
		for (const segment of segments) {
			const child = path.join(current, segment);
			let info;
			try {
				info = await lstat(child);
			} catch (error) {
				if (!isNodeError(error, 'ENOENT') || !createMissing) {
					if (isNodeError(error, 'ENOENT')) return null;
					throw error;
				}
				await mkdir(child, { mode: 0o700 });
				await syncDirectory(current);
				info = await lstat(child);
			}
			if (!info.isDirectory() || info.isSymbolicLink()) {
				throw new Error(`Document parent segment is not a real directory: ${segment}`);
			}
			current = child;
		}
		const resolved = await realpath(current);
		if (resolved !== current || !isAtOrWithin(this.canonicalRoot, resolved)) {
			throw new Error('Document parent escapes the source root.');
		}
		const info = await lstat(current);
		return { path: current, fileName, identity: { dev: info.dev, ino: info.ino } };
	}

	private async writeRollbackCapsule(material: RollbackCapsuleMaterial): Promise<void> {
		const capsule: RollbackCapsule = { ...material, signature: this.sign(material) };
		const bytes = Buffer.from(`${canonicalJson(capsule)}\n`, 'utf8');
		if (bytes.byteLength > this.maxFileBytes * 3 + 64 * 1024) {
			throw new RangeError('Rollback capsule exceeds its safe bound.');
		}
		const capsulePath = this.capsulePath(material.transactionId, false);
		const handle = await open(capsulePath, CREATE_NEW, 0o600);
		try {
			await assertPrivateFileHandle(handle, {
				label: 'Rollback capsule',
				maximumBytes: this.maxFileBytes * 3 + 64 * 1024,
			});
			await handle.writeFile(bytes);
			await handle.sync();
			await assertPrivateFileHandle(handle, {
				label: 'Rollback capsule',
				minimumBytes: 1,
				maximumBytes: this.maxFileBytes * 3 + 64 * 1024,
			});
		} finally {
			await handle.close();
		}
		await assertPrivateFilePath(capsulePath, {
			label: 'Rollback capsule',
			minimumBytes: 1,
			maximumBytes: this.maxFileBytes * 3 + 64 * 1024,
		});
		await syncPrivateDirectory(path.dirname(capsulePath), 'Rollback state');
	}

	private async readRollbackState(token: string): Promise<RollbackState> {
		const match = ROLLBACK_TOKEN_PATTERN.exec(token);
		if (!match) throw new TypeError('Rollback token is invalid.');
		const transactionId = match[1];
		const tokenSignature = match[2];
		if (!transactionId || !tokenSignature) throw new TypeError('Rollback token is invalid.');
		const activePath = this.capsulePath(transactionId, false);
		const consumedPath = this.capsulePath(transactionId, true);
		const [activeExists, consumedExists] = await Promise.all([
			pathExists(activePath),
			pathExists(consumedPath),
		]);
		if (activeExists && consumedExists) {
			throw new Error('Rollback state contains conflicting active and consumed records.');
		}
		const statePath = activeExists ? activePath : consumedExists ? consumedPath : null;
		if (statePath === null) throw new Error('Rollback token is missing or already consumed.');
		let raw: string;
		try {
			raw = (await readPrivateFile(statePath, {
				label: 'Rollback state',
				minimumBytes: 1,
				maximumBytes: this.maxFileBytes * 3 + 64 * 1024,
			})).toString('utf8');
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) throw new Error('Rollback token is missing or already consumed.');
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error('Rollback capsule is invalid JSON.', { cause: error });
		}
		const state = this.verifyRollbackState(parsed, transactionId);
		if (consumedExists && state.state !== 'consumed') {
			throw new Error('Consumed rollback path does not contain a consumed marker.');
		}
		const capsuleSignature = state.state === 'active'
			? state.record.signature
			: state.record.capsuleSignature;
		if (!secureEqual(tokenSignature, this.sign({ transactionId, signature: capsuleSignature }))) {
			throw new Error('Rollback token signature is invalid.');
		}
		return state;
	}

	private verifyRollbackState(value: unknown, transactionId: string): RollbackState {
		if (isRecord(value) && value.state === 'in-progress') {
			assertRollbackInProgress(value, transactionId);
			const { signature, ...material } = value;
			if (!secureEqual(signature, this.sign(material))) {
				throw new Error('In-progress rollback state signature is invalid.');
			}
			return { state: 'in-progress', record: value };
		}
		if (isRecord(value) && value.state === 'consumed') {
			assertRollbackConsumedMarker(value, transactionId);
			const { signature, ...material } = value;
			if (!secureEqual(signature, this.sign(material))) {
				throw new Error('Consumed rollback marker signature is invalid.');
			}
			return { state: 'consumed', record: value };
		}
		assertRollbackCapsule(value, transactionId);
		const { signature, ...material } = value;
		if (!secureEqual(signature, this.sign(material))) {
			throw new Error('Rollback capsule signature is invalid.');
		}
		return { state: 'active', record: value };
	}

	private async beginRollback(capsule: RollbackCapsule): Promise<RollbackInProgress> {
		const { signature: capsuleSignature, ...capsuleMaterial } = capsule;
		const material: RollbackInProgressMaterial = {
			...capsuleMaterial,
			state: 'in-progress',
			rollbackStartedAt: new Date().toISOString(),
			capsuleSignature,
		};
		const inProgress: RollbackInProgress = {
			...material,
			signature: this.sign(material),
		};
		await this.replaceActiveRollbackRecord(capsule, inProgress);
		return inProgress;
	}

	private async completeRollback(inProgress: RollbackInProgress): Promise<string> {
		const activePath = this.capsulePath(inProgress.transactionId, false);
		const consumedPath = this.capsulePath(inProgress.transactionId, true);
		const markerMaterial = {
			schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
			state: 'consumed' as const,
			transactionId: inProgress.transactionId,
			consumedAt: new Date().toISOString(),
			source: inProgress.source,
			operation: inProgress.operation,
			beforeVersion: inProgress.beforeVersion,
			committedVersion: inProgress.committedVersion,
			capsuleSignature: inProgress.capsuleSignature,
		};
		const marker: RollbackConsumedMarker = {
			...markerMaterial,
			signature: this.sign(markerMaterial),
		};
		await this.replaceActiveRollbackRecord(inProgress, marker);
		// The active path already contains a durable, content-free consumed
		// marker. Moving it to .used is organizational only; if that last rename
		// fails, the token still remains durably consumed and non-replayable.
		try {
			await rename(activePath, consumedPath);
			await syncPrivateDirectory(this.canonicalRollback, 'Rollback state');
			await this.assertRollbackRecordEquals(consumedPath, marker);
		} catch (error) {
			try {
				await this.assertRollbackRecordEquals(activePath, marker);
			} catch {
				try {
					await this.assertRollbackRecordEquals(consumedPath, marker);
				} catch {
					throw error;
				}
			}
		}
		return marker.consumedAt;
	}

	private async replaceActiveRollbackRecord(
		expected: RollbackCapsule | RollbackInProgress,
		replacement: RollbackInProgress | RollbackConsumedMarker,
	): Promise<void> {
		const activePath = this.capsulePath(expected.transactionId, false);
		const temporaryPath = path.join(
			this.canonicalRollback,
			`.${expected.transactionId}.${randomBytes(8).toString('hex')}.state.tmp`,
		);
		let temporaryExists = false;
		const encoded = `${canonicalJson(replacement)}\n`;
		const maximumBytes = this.maxFileBytes * 3 + 64 * 1024;
		if (Buffer.byteLength(encoded, 'utf8') > maximumBytes) {
			throw new RangeError('Rollback state exceeds its safe bound.');
		}
		try {
			const handle = await open(temporaryPath, CREATE_NEW, 0o600);
			temporaryExists = true;
			try {
				await assertPrivateFileHandle(handle, {
					label: 'Rollback state temporary file',
					maximumBytes,
				});
				await handle.writeFile(encoded, 'utf8');
				await handle.sync();
				await assertPrivateFileHandle(handle, {
					label: 'Rollback state temporary file',
					minimumBytes: 1,
					maximumBytes,
				});
			} finally {
				await handle.close();
			}
			await this.assertRollbackRecordEquals(activePath, expected);
			await rename(temporaryPath, activePath);
			temporaryExists = false;
			await syncPrivateDirectory(this.canonicalRollback, 'Rollback state');
			await this.assertRollbackRecordEquals(activePath, replacement);
		} finally {
			if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
		}
	}

	private async assertRollbackRecordEquals(
		filePath: string,
		expected: RollbackCapsule | RollbackInProgress | RollbackConsumedMarker,
	): Promise<void> {
		const bytes = await readPrivateFile(filePath, {
			label: 'Rollback state',
			minimumBytes: 1,
			maximumBytes: this.maxFileBytes * 3 + 64 * 1024,
		});
		if (bytes.toString('utf8') !== `${canonicalJson(expected)}\n`) {
			throw new Error('Rollback state changed before atomic publication.');
		}
	}

	private createRollbackToken(material: RollbackCapsuleMaterial): string {
		const capsuleSignature = this.sign(material);
		return `rollback_v1_${material.transactionId}_${this.sign({
			transactionId: material.transactionId,
			signature: capsuleSignature,
		})}`;
	}

	private capsulePath(transactionId: string, consumed: boolean): string {
		this.assertTransactionId(transactionId);
		return path.join(
			this.canonicalRollback,
			`${transactionId}.${consumed ? 'used' : 'json'}`,
		);
	}

	private sign(value: unknown): string {
		if (!this.signingKey) throw new Error('Directory writer signing key is unavailable.');
		return createHmac('sha256', this.signingKey).update(canonicalJson(value)).digest('hex');
	}

	private assertTransactionId(transactionId: string): void {
		if (!TRANSACTION_PATTERN.test(transactionId)) throw new TypeError('Transaction ID is invalid.');
	}

	private assertSource(source: SourceRef): void {
		if (source.adapterId !== this.adapterId || source.sourceId !== this.sourceId) {
			throw new DirectoryWriteError('SourceRef is not owned by this directory adapter.', 'unknown', null);
		}
		const expected = createSourceRef(this.adapterId, this.sourceId, source.documentPath);
		if (canonicalJson(source) !== canonicalJson(expected)) {
			throw new DirectoryWriteError('SourceRef identity is inconsistent.', 'unknown', null);
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialization) return this.initialization;
		this.initialization = (async () => {
			const rootInfo = await lstat(this.configuredRoot);
			if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
				throw new TypeError('Directory writer root must be an existing real directory.');
			}
			this.canonicalRoot = await realpath(this.configuredRoot);
			const canonicalRootInfo = await lstat(this.canonicalRoot);
			this.rootIdentity = { dev: canonicalRootInfo.dev, ino: canonicalRootInfo.ino };

			const privateState = await ensurePrivateDirectory(
				this.configuredState,
				'Directory writer state',
			);
			this.canonicalState = privateState.path;
			if (isAtOrWithin(this.canonicalRoot, this.canonicalState)) {
				throw new TypeError('Directory writer statePath must be outside rootPath.');
			}
			this.stateIdentity = privateState.identity;
			const rollbackPath = path.join(this.canonicalState, ROLLBACK_DIRECTORY);
			const privateRollback = await ensurePrivateDirectory(rollbackPath, 'Rollback state');
			this.canonicalRollback = privateRollback.path;
			if (this.canonicalRollback !== rollbackPath) {
				throw new TypeError('Rollback state must not traverse a symbolic link.');
			}
			this.rollbackIdentity = privateRollback.identity;
			this.signingKey = await loadOrCreateKey(path.join(this.canonicalState, KEY_FILE));
			await syncPrivateDirectory(this.canonicalState, 'Directory writer state');
			await this.assertRoots();
		})();
		try {
			await this.initialization;
		} catch (error) {
			this.initialization = null;
			throw error;
		}
	}

	private async assertRoots(): Promise<void> {
		if (!this.rootIdentity || !this.stateIdentity || !this.rollbackIdentity) {
			throw new Error('Directory writer is not initialized.');
		}
		await this.assertDirectoryIdentity(this.canonicalRoot, this.rootIdentity, 'source root');
		await assertPrivateDirectoryIdentity(
			this.canonicalState,
			this.stateIdentity,
			'Directory writer state',
		);
		await assertPrivateDirectoryIdentity(
			this.canonicalRollback,
			this.rollbackIdentity,
			'Rollback state',
		);
	}

	private async assertDirectoryIdentity(
		directoryPath: string,
		expected: DirectoryIdentity,
		label: string,
	): Promise<void> {
		const info = await lstat(directoryPath);
		if (
			!info.isDirectory()
			|| info.isSymbolicLink()
			|| info.dev !== expected.dev
			|| info.ino !== expected.ino
		) {
			throw new Error(`${label} identity changed.`);
		}
	}

	private async serialized<T>(run: () => Promise<T>): Promise<T> {
		const previous = this.queue;
		let release!: () => void;
		this.queue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			await this.ensureInitialized();
			return await this.withWriterLock(run);
		} finally {
			release();
		}
	}

	private async withWriterLock<T>(run: () => Promise<T>): Promise<T> {
		const lockPath = path.join(this.canonicalState, WRITER_LOCK_FILE);
		return withOwnedFileLock(lockPath, async () => {
			await this.assertRoots();
			return run();
		}, { timeoutMs: this.lockTimeoutMs });
	}
}

function assertConfiguredPath(value: string, label: string): string {
	if (!value || value.includes('\0')) throw new TypeError(`${label} path is invalid.`);
	const resolved = path.resolve(value);
	if (resolved === path.parse(resolved).root) throw new TypeError(`${label} must not be a filesystem root.`);
	return resolved;
}

function assertWritableDocumentPath(documentPath: string): void {
	if (Buffer.byteLength(documentPath, 'utf8') > 4_096) throw new RangeError('Document path is too long.');
	const segments = documentPath.split('/');
	if (
		segments.length === 0
		|| segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.'))
	) {
		throw new TypeError('Writable document paths must not contain hidden or ambiguous segments.');
	}
	if (!documentPath.toLocaleLowerCase('en-US').endsWith('.md')) {
		throw new TypeError('Directory writer accepts Markdown files only.');
	}
}

async function loadOrCreateKey(keyPath: string): Promise<Buffer> {
	let createHandle;
	try {
		createHandle = await open(keyPath, CREATE_NEW, 0o600);
		await assertPrivateFileHandle(createHandle, {
			label: 'Directory writer key',
			maximumBytes: 32,
		});
		const key = randomBytes(32);
		await createHandle.writeFile(key);
		await createHandle.sync();
		await assertPrivateFileHandle(createHandle, {
			label: 'Directory writer key',
			minimumBytes: 32,
			maximumBytes: 32,
		});
	} catch (error) {
		if (!isNodeError(error, 'EEXIST')) throw error;
	} finally {
		await createHandle?.close();
	}
	const deadline = Date.now() + 1_000;
	while (true) {
		const pathInfo = await lstat(keyPath);
		assertPrivateRegularFileStats(pathInfo, {
			label: 'Directory writer key',
			maximumBytes: 32,
		});
		if (pathInfo.size === 32) {
			return readPrivateFile(keyPath, {
				label: 'Directory writer key',
				minimumBytes: 32,
				maximumBytes: 32,
			});
		}
		if (Date.now() >= deadline) throw new Error('Directory writer key is invalid.');
		await delay(10);
	}
}

function assertRollbackCapsule(value: unknown, transactionId: string): asserts value is RollbackCapsule {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('Rollback capsule must be an object.');
	}
	const capsule = value as RollbackCapsule;
	if (
		capsule.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION
		|| capsule.transactionId !== transactionId
		|| !['create', 'replace', 'delete'].includes(capsule.operation)
		|| typeof capsule.signature !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(capsule.signature)
		|| (capsule.beforeContent !== null && typeof capsule.beforeContent !== 'string')
	) {
		throw new Error('Rollback capsule schema is invalid.');
	}
}

function assertRollbackInProgress(
	value: unknown,
	transactionId: string,
): asserts value is RollbackInProgress {
	assertRollbackCapsule(value, transactionId);
	const pending = value as unknown as RollbackInProgress;
	if (
		pending.state !== 'in-progress'
		|| typeof pending.rollbackStartedAt !== 'string'
		|| Number.isNaN(Date.parse(pending.rollbackStartedAt))
		|| typeof pending.capsuleSignature !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(pending.capsuleSignature)
	) throw new Error('In-progress rollback state schema is invalid.');
}

function assertRollbackConsumedMarker(
	value: unknown,
	transactionId: string,
): asserts value is RollbackConsumedMarker {
	if (!isRecord(value)) throw new Error('Consumed rollback marker must be an object.');
	if (
		value.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION
		|| value.state !== 'consumed'
		|| value.transactionId !== transactionId
		|| typeof value.consumedAt !== 'string'
		|| Number.isNaN(Date.parse(value.consumedAt))
		|| !isRecord(value.source)
		|| !['create', 'replace', 'delete'].includes(String(value.operation))
		|| typeof value.capsuleSignature !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(value.capsuleSignature)
		|| typeof value.signature !== 'string'
		|| !/^[a-f0-9]{64}$/u.test(value.signature)
	) throw new Error('Consumed rollback marker schema is invalid.');
}

function assertSameVersion(actual: BaseVersion | null, expected: BaseVersion | null, label: string): void {
	if (!sameVersion(actual, expected)) {
		throw new Error(`${label} failed because the document version changed.`);
	}
}

function sameVersion(first: BaseVersion | null, second: BaseVersion | null): boolean {
	return canonicalJson(first) === canonicalJson(second);
}

function sameIdentity(first: Stats, second: Stats): boolean {
	return sameObject(first, second)
		&& first.size === second.size
		&& first.mtimeMs === second.mtimeMs
		&& first.ctimeMs === second.ctimeMs;
}

function sameObject(first: Stats, second: Stats): boolean {
	return first.dev === second.dev && first.ino === second.ino;
}

function isAtOrWithin(root: string, candidate: string): boolean {
	return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function pathExists(filePath: string): Promise<boolean> {
	return lstat(filePath).then(() => true, (error: unknown) => {
		if (isNodeError(error, 'ENOENT')) return false;
		throw error;
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRoundTripUtf8(content: string): void {
	if (UTF8_DECODER.decode(Buffer.from(content, 'utf8')) !== content) {
		throw new TypeError('Document content contains invalid Unicode scalar data.');
	}
}

function secureEqual(first: string, second: string): boolean {
	const firstBytes = /^[a-f0-9]{64}$/u.test(first) ? Buffer.from(first, 'hex') : Buffer.alloc(0);
	const secondBytes = /^[a-f0-9]{64}$/u.test(second) ? Buffer.from(second, 'hex') : Buffer.alloc(0);
	return firstBytes.byteLength === secondBytes.byteLength
		&& firstBytes.byteLength > 0
		&& timingSafeEqual(firstBytes, secondBytes);
}

async function syncDirectory(directoryPath: string): Promise<void> {
	// Source document directories are user data and are not required to carry
	// private-state permissions; still fsync their directory entry.
	const handle = await open(directoryPath, READ_DIRECTORY);
	try {
		try {
			await handle.sync();
		} catch (error) {
			if (!isUnsupportedWindowsDirectorySync(error)) throw error;
		}
	} finally {
		await handle.close();
	}
}

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
	return process.platform === 'win32'
		&& ['EINVAL', 'EBADF', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '');
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
