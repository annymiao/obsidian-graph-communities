import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rename,
	rm,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateDirectoryStats,
	assertPrivateFileHandle,
	assertPrivateFilePath,
	ensurePrivateDirectory,
	readPrivateFile,
	syncPrivateDirectory,
	type PrivateDirectoryIdentity,
} from '../privateFs.js';
import { canonicalJson, hashCanonicalJson } from './canonicalJson.js';

const BUILD_STATE_SCHEMA_VERSION = 1 as const;
const CHECKPOINT_FILE = 'checkpoint.json';
const CHECKPOINT_FILES_DIRECTORY = 'checkpoint-files';
const JOURNAL_FILE = 'changes.ndjson';
const LOCK_DIRECTORY = '.build.lock';
const MAX_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export type JournalEvent =
	| 'scan-started'
	| 'file-compiled'
	| 'file-reused'
	| 'file-tombstoned'
	| 'generation-published'
	| 'scan-completed';

export interface ChangeJournalInput {
	timestamp: string;
	event: JournalEvent;
	buildId: string;
	path: string | null;
	contentSha256: string | null;
	generationId: string | null;
}

export interface ChangeJournalRecord extends ChangeJournalInput {
	schemaVersion: typeof BUILD_STATE_SCHEMA_VERSION;
	sequence: number;
	previousHash: string | null;
	entryHash: string;
}

export interface CompilerCheckpoint<TArtifact> {
	schemaVersion: typeof BUILD_STATE_SCHEMA_VERSION;
	buildId: string;
	sourceId: string;
	policyHash: string;
	planHash: string;
	startedAt: string;
	completedFiles: Array<{
		path: string;
		contentSha256: string;
		artifact: TArtifact;
	}>;
}

type CheckpointHeader = Omit<CompilerCheckpoint<never>, 'completedFiles'>;

interface CheckpointEnvelope {
	schemaVersion: typeof BUILD_STATE_SCHEMA_VERSION;
	checksum: string;
	payload: CheckpointHeader;
}

interface CheckpointFileRecord<TArtifact> {
	schemaVersion: typeof BUILD_STATE_SCHEMA_VERSION;
	buildId: string;
	sequence: number;
	previousHash: string | null;
	path: string;
	contentSha256: string;
	artifact: TArtifact;
	entryHash: string;
}

interface CheckpointWriteState {
	header: CheckpointHeader;
	completedCount: number;
	previousHash: string | null;
	lastEntrySignature: string | null;
}

interface LockOwner {
	schemaVersion: typeof BUILD_STATE_SCHEMA_VERSION;
	pid: number;
	token: string;
	createdAt: string;
}

export class BuildStateBusyError extends Error {
	constructor(message = 'Another offline compiler owns the build-state lock.') {
		super(message);
		this.name = 'BuildStateBusyError';
	}
}

/** Durable resumable compiler state. No source content is stored in the journal. */
export class BuildStateStore {
	readonly configuredRootPath: string;
	private initialized: Promise<void> | null = null;
	private canonicalRootPath = '';
	private rootIdentity: PrivateDirectoryIdentity | null = null;
	private checkpointDirectoryIdentity: PrivateDirectoryIdentity | null = null;
	private journalCache: ChangeJournalRecord[] | null = null;
	private checkpointWriteState: CheckpointWriteState | null | undefined;

	constructor(rootPath: string) {
		if (!rootPath || rootPath.includes('\0')) throw new TypeError('Build state root must be a path.');
		this.configuredRootPath = path.resolve(rootPath);
		if (this.configuredRootPath === path.parse(this.configuredRootPath).root) {
			throw new TypeError('Build state root must not be a filesystem root.');
		}
	}

	async withBuildLock<T>(operation: () => Promise<T>): Promise<T> {
		await this.ensureInitialized();
		const lockPath = this.resolveRootChild(LOCK_DIRECTORY);
		const token = randomBytes(16).toString('hex');
		await this.acquireLock(lockPath, token);
		try {
			return await operation();
		} finally {
			await this.releaseLock(lockPath, token);
		}
	}

	async readCheckpoint<TArtifact>(): Promise<CompilerCheckpoint<TArtifact> | null> {
		await this.ensureInitialized();
		let bytes: Buffer;
		try {
			bytes = await readBoundedFile(this.resolveRootChild(CHECKPOINT_FILE), MAX_CHECKPOINT_BYTES);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) {
				this.checkpointWriteState = null;
				return null;
			}
			throw error;
		}
		let decoded: unknown;
		try {
			decoded = JSON.parse(bytes.toString('utf8'));
		} catch (error) {
			throw new Error('Compiler checkpoint is not valid JSON.', { cause: error });
		}
		if (!isRecord(decoded) || decoded.schemaVersion !== BUILD_STATE_SCHEMA_VERSION) {
			throw new Error('Compiler checkpoint schema is invalid.');
		}
		if (typeof decoded.checksum !== 'string' || !isRecord(decoded.payload)) {
			throw new Error('Compiler checkpoint envelope is invalid.');
		}
		if (hashCanonicalJson(decoded.payload) !== decoded.checksum) {
			throw new Error('Compiler checkpoint checksum mismatch.');
		}
		const header = decoded.payload as unknown as CheckpointHeader;
		validateCheckpoint({ ...header, completedFiles: [] });
		const completedFiles: CompilerCheckpoint<TArtifact>['completedFiles'] = [];
		let previous: CheckpointFileRecord<TArtifact> | null = null;
		const checkpointDirectory = this.resolveRootChild(CHECKPOINT_FILES_DIRECTORY);
		const entries = await readdir(checkpointDirectory, { withFileTypes: true });
		for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
			if (entry.isSymbolicLink() || !entry.isFile() || !/^\d{10}-[a-f0-9]{16}\.json$/u.test(entry.name)) {
				throw new Error(`Unexpected compiler checkpoint entry: ${entry.name}`);
			}
			const recordBytes = await readBoundedFile(path.join(checkpointDirectory, entry.name), MAX_CHECKPOINT_BYTES);
			let recordValue: unknown;
			try {
				recordValue = JSON.parse(recordBytes.toString('utf8'));
			} catch (error) {
				throw new Error('Compiler file checkpoint is not valid JSON.', { cause: error });
			}
			const record: CheckpointFileRecord<TArtifact> = validateCheckpointFileRecord<TArtifact>(
				recordValue,
				header,
				previous,
			);
			if (recordBytes.toString('utf8') !== `${canonicalJson(record)}\n`) {
				throw new Error('Compiler file checkpoint is not canonical.');
			}
			completedFiles.push({
				path: record.path,
				contentSha256: record.contentSha256,
				artifact: record.artifact,
			});
			previous = record;
		}
		this.checkpointWriteState = {
			header,
			completedCount: completedFiles.length,
			previousHash: previous?.entryHash ?? null,
			lastEntrySignature: completedFiles.length === 0
				? null
				: checkpointEntrySignature(completedFiles.at(-1)),
		};
		return { ...header, completedFiles };
	}

	async writeCheckpoint<TArtifact>(checkpoint: CompilerCheckpoint<TArtifact>): Promise<void> {
		await this.ensureInitialized();
		validateCheckpoint(checkpoint);
		if (this.checkpointWriteState === undefined) await this.readCheckpoint<TArtifact>();
		let writeState = this.checkpointWriteState;
		const prefixEntry = writeState && writeState.completedCount > 0
			? checkpoint.completedFiles[writeState.completedCount - 1]
			: undefined;
		if (
			!writeState
			|| !sameCheckpointPlan(writeState.header, checkpoint)
			|| checkpoint.completedFiles.length < writeState.completedCount
			|| (writeState.lastEntrySignature !== null
				&& checkpointEntrySignature(prefixEntry) !== writeState.lastEntrySignature)
		) {
			await this.removeCheckpointHeader();
			await this.resetCheckpointFiles();
			const header: CheckpointHeader = {
				schemaVersion: checkpoint.schemaVersion,
				buildId: checkpoint.buildId,
				sourceId: checkpoint.sourceId,
				policyHash: checkpoint.policyHash,
				planHash: checkpoint.planHash,
				startedAt: checkpoint.startedAt,
			};
			const envelope: CheckpointEnvelope = {
				schemaVersion: BUILD_STATE_SCHEMA_VERSION,
				checksum: hashCanonicalJson(header),
				payload: header,
			};
			await this.atomicWrite(CHECKPOINT_FILE, Buffer.from(`${canonicalJson(envelope)}\n`, 'utf8'));
			writeState = {
				header,
				completedCount: 0,
				previousHash: null,
				lastEntrySignature: null,
			};
			this.checkpointWriteState = writeState;
		}

		let previousHash = writeState.previousHash;
		for (let index = writeState.completedCount; index < checkpoint.completedFiles.length; index += 1) {
			const completed = checkpoint.completedFiles[index];
			if (!completed) throw new Error('Compiler checkpoint contains a missing file entry.');
			const body = {
				schemaVersion: BUILD_STATE_SCHEMA_VERSION,
				buildId: checkpoint.buildId,
				sequence: index + 1,
				previousHash,
				path: completed.path,
				contentSha256: completed.contentSha256,
				artifact: completed.artifact,
			};
			const record: CheckpointFileRecord<TArtifact> = {
				...body,
				entryHash: hashCanonicalJson(body),
			};
			const nameHash = createHash('sha256').update(completed.path, 'utf8').digest('hex').slice(0, 16);
			const fileName = `${String(index + 1).padStart(10, '0')}-${nameHash}.json`;
			await this.atomicWriteInDirectory(
				this.resolveRootChild(CHECKPOINT_FILES_DIRECTORY),
				fileName,
				Buffer.from(`${canonicalJson(record)}\n`, 'utf8'),
			);
			previousHash = record.entryHash;
			writeState = {
				header: writeState.header,
				completedCount: index + 1,
				previousHash,
				lastEntrySignature: checkpointEntrySignature(completed),
			};
			this.checkpointWriteState = writeState;
		}
	}

	async clearCheckpoint(): Promise<void> {
		await this.ensureInitialized();
		await this.removeCheckpointHeader();
		await this.resetCheckpointFiles();
		this.checkpointWriteState = null;
	}

	async readJournal(): Promise<ChangeJournalRecord[]> {
		await this.ensureInitialized();
		if (this.journalCache) return [...this.journalCache];
		let bytes: Buffer;
		try {
			bytes = await readBoundedFile(this.resolveRootChild(JOURNAL_FILE), MAX_JOURNAL_BYTES);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) {
				this.journalCache = [];
				return [];
			}
			throw error;
		}
		const text = bytes.toString('utf8');
		if (text.length > 0 && !text.endsWith('\n')) throw new Error('Change journal has a partial trailing record.');
		const records: ChangeJournalRecord[] = [];
		for (const line of text.split('\n')) {
			if (!line) continue;
			let decoded: unknown;
			try {
				decoded = JSON.parse(line);
			} catch (error) {
				throw new Error('Change journal contains invalid JSON.', { cause: error });
			}
			const record = validateJournalRecord(decoded, records.at(-1) ?? null);
			if (line !== canonicalJson(record)) throw new Error('Change journal record is not canonical.');
			records.push(record);
		}
		this.journalCache = records;
		return [...records];
	}

	async appendJournal(input: ChangeJournalInput): Promise<ChangeJournalRecord> {
		await this.ensureInitialized();
		const records = await this.readJournal();
		const previous = records.at(-1) ?? null;
		const body = {
			schemaVersion: BUILD_STATE_SCHEMA_VERSION,
			sequence: (previous?.sequence ?? 0) + 1,
			previousHash: previous?.entryHash ?? null,
			...input,
		};
		const record: ChangeJournalRecord = { ...body, entryHash: hashCanonicalJson(body) };
		const handle = await open(
			this.resolveRootChild(JOURNAL_FILE),
			constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
			0o600,
		);
		try {
			const before = await assertPrivateFileHandle(handle, {
				label: 'Change journal',
				maximumBytes: MAX_JOURNAL_BYTES,
			});
			const line = `${canonicalJson(record)}\n`;
			if (before.size + Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_BYTES) {
				throw new Error('Change journal exceeds its size limit.');
			}
			await handle.writeFile(line, 'utf8');
			await handle.sync();
			const after = await assertPrivateFileHandle(handle, {
				label: 'Change journal',
				maximumBytes: MAX_JOURNAL_BYTES,
			});
			if (after.dev !== before.dev || after.ino !== before.ino) {
				throw new Error('Change journal identity changed while appending.');
			}
		} finally {
			await handle.close();
		}
		await syncDirectory(this.canonicalRootPath);
		this.journalCache = [...records, record];
		return record;
	}

	async compactJournal(retainRecords = 1_000): Promise<number> {
		if (!Number.isSafeInteger(retainRecords) || retainRecords < 0) {
			throw new TypeError('retainRecords must be a non-negative safe integer.');
		}
		const records = await this.readJournal();
		if (records.length <= retainRecords) return 0;
		const retainedInputs = records.slice(-retainRecords).map(stripJournalIntegrity);
		let previous: ChangeJournalRecord | null = null;
		const rebuilt: ChangeJournalRecord[] = [];
		for (const input of retainedInputs) {
			const body = {
				schemaVersion: BUILD_STATE_SCHEMA_VERSION,
				sequence: (previous?.sequence ?? 0) + 1,
				previousHash: previous?.entryHash ?? null,
				...input,
			};
			const record: ChangeJournalRecord = { ...body, entryHash: hashCanonicalJson(body) };
			rebuilt.push(record);
			previous = record;
		}
		const bytes = Buffer.from(rebuilt.map((record) => canonicalJson(record)).join('\n') + (rebuilt.length ? '\n' : ''), 'utf8');
		await this.atomicWrite(JOURNAL_FILE, bytes);
		this.journalCache = rebuilt;
		return records.length - rebuilt.length;
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) this.initialized = this.initialize();
		await this.initialized;
		if (!this.rootIdentity || !this.checkpointDirectoryIdentity) {
			throw new Error('Build state is not initialized.');
		}
		const current = await realpath(this.configuredRootPath);
		if (current !== this.canonicalRootPath) throw new Error('Build state root changed after initialization.');
		await assertPrivateDirectoryIdentity(
			this.canonicalRootPath,
			this.rootIdentity,
			'Build state root',
		);
		await assertPrivateDirectoryIdentity(
			this.resolveRootChild(CHECKPOINT_FILES_DIRECTORY),
			this.checkpointDirectoryIdentity,
			'Compiler checkpoint directory',
		);
	}

	private async initialize(): Promise<void> {
		const root = await ensurePrivateDirectory(this.configuredRootPath, 'Build state root');
		this.canonicalRootPath = root.path;
		this.rootIdentity = root.identity;
		const checkpointFilesPath = this.resolveRootChild(CHECKPOINT_FILES_DIRECTORY);
		const checkpointDirectory = await ensurePrivateDirectory(
			checkpointFilesPath,
			'Compiler checkpoint directory',
		);
		this.checkpointDirectoryIdentity = checkpointDirectory.identity;
	}

	private resolveRootChild(name: string): string {
		if (!/^[A-Za-z0-9._-]+$/u.test(name)) throw new TypeError('Unsafe build-state file name.');
		return path.join(this.canonicalRootPath || this.configuredRootPath, name);
	}

	private async atomicWrite(fileName: string, bytes: Buffer): Promise<void> {
		if (bytes.byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Build-state write exceeds the size limit.');
		const target = this.resolveRootChild(fileName);
		await assertExistingPrivateTarget(target, 'Build-state target', MAX_CHECKPOINT_BYTES);
		const temporary = this.resolveRootChild(`.${fileName}.${randomBytes(16).toString('hex')}.tmp`);
		const handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
			0o600,
		);
		try {
			await assertPrivateFileHandle(handle, {
				label: 'Build-state temporary file',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await handle.writeFile(bytes);
			await handle.sync();
			await assertPrivateFileHandle(handle, {
				label: 'Build-state temporary file',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, target);
			await assertPrivateFilePath(target, {
				label: 'Build-state target',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await syncDirectory(this.canonicalRootPath);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	private async atomicWriteInDirectory(
		directoryPath: string,
		fileName: string,
		bytes: Buffer,
	): Promise<void> {
		if (bytes.byteLength > MAX_CHECKPOINT_BYTES) throw new Error('Per-file checkpoint exceeds the size limit.');
		if (!/^\d{10}-[a-f0-9]{16}\.json$/u.test(fileName)) throw new TypeError('Unsafe checkpoint file name.');
		const directoryStat = await lstat(directoryPath);
		assertPrivateDirectoryStats(directoryStat, 'Compiler checkpoint directory');
		const target = path.join(directoryPath, fileName);
		try {
			await lstat(target);
			throw new Error('Per-file checkpoint already exists.');
		} catch (error) {
			if (!isNodeError(error, 'ENOENT')) throw error;
		}
		const temporary = path.join(directoryPath, `.${fileName}.${randomBytes(12).toString('hex')}.tmp`);
		const handle = await open(
			temporary,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
			0o600,
		);
		try {
			await assertPrivateFileHandle(handle, {
				label: 'Per-file checkpoint temporary file',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await handle.writeFile(bytes);
			await handle.sync();
			await assertPrivateFileHandle(handle, {
				label: 'Per-file checkpoint temporary file',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
		} finally {
			await handle.close();
		}
		try {
			await rename(temporary, target);
			await assertPrivateFilePath(target, {
				label: 'Per-file checkpoint',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await syncDirectory(directoryPath);
		} catch (error) {
			await unlink(temporary).catch(() => undefined);
			throw error;
		}
	}

	private async removeCheckpointHeader(): Promise<void> {
		try {
			const checkpointPath = this.resolveRootChild(CHECKPOINT_FILE);
			await assertPrivateFilePath(checkpointPath, {
				label: 'Compiler checkpoint',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await unlink(checkpointPath);
			await syncDirectory(this.canonicalRootPath);
		} catch (error) {
			if (!isNodeError(error, 'ENOENT')) throw error;
		}
	}

	private async resetCheckpointFiles(): Promise<void> {
		const directoryPath = this.resolveRootChild(CHECKPOINT_FILES_DIRECTORY);
		const directoryStat = await lstat(directoryPath);
		assertPrivateDirectoryStats(directoryStat, 'Compiler checkpoint directory');
		for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
			if (
				entry.isSymbolicLink()
				|| !entry.isFile()
				|| !/^\d{10}-[a-f0-9]{16}\.json$/u.test(entry.name)
			) throw new Error(`Unexpected compiler checkpoint entry: ${entry.name}`);
			const checkpointEntryPath = path.join(directoryPath, entry.name);
			await assertPrivateFilePath(checkpointEntryPath, {
				label: 'Per-file checkpoint',
				maximumBytes: MAX_CHECKPOINT_BYTES,
			});
			await unlink(checkpointEntryPath);
		}
		await syncDirectory(directoryPath);
		await syncDirectory(this.canonicalRootPath);
	}

	private async acquireLock(lockPath: string, token: string): Promise<void> {
		try {
			await mkdir(lockPath, { mode: 0o700 });
		} catch (error) {
			if (!isNodeError(error, 'EEXIST')) throw error;
			if (!await this.recoverStaleLock(lockPath)) throw new BuildStateBusyError();
			await mkdir(lockPath, { mode: 0o700 });
		}
		const lockInfo = await lstat(lockPath);
		assertPrivateDirectoryStats(lockInfo, 'Build-state lock directory');
		const owner: LockOwner = {
			schemaVersion: BUILD_STATE_SCHEMA_VERSION,
			pid: process.pid,
			token,
			createdAt: new Date().toISOString(),
		};
		try {
			const handle = await open(
				path.join(lockPath, 'owner.json'),
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
				0o600,
			);
			try {
				await assertPrivateFileHandle(handle, {
					label: 'Build-state lock owner',
					maximumBytes: 4_096,
				});
				await handle.writeFile(`${canonicalJson(owner)}\n`, 'utf8');
				await handle.sync();
				await assertPrivateFileHandle(handle, {
					label: 'Build-state lock owner',
					maximumBytes: 4_096,
				});
			} finally {
				await handle.close();
			}
			await syncDirectory(lockPath);
			await syncDirectory(this.canonicalRootPath);
		} catch (error) {
			await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
			throw error;
		}
	}

	private async recoverStaleLock(lockPath: string): Promise<boolean> {
		let owner: LockOwner;
		try {
			const lockInfo = await lstat(lockPath);
			assertPrivateDirectoryStats(lockInfo, 'Build-state lock directory');
			const decoded = JSON.parse((await readPrivateFile(path.join(lockPath, 'owner.json'), {
				label: 'Build-state lock owner',
				maximumBytes: 4_096,
			})).toString('utf8')) as unknown;
			if (!isRecord(decoded) || typeof decoded.pid !== 'number' || typeof decoded.token !== 'string') return false;
			owner = decoded as unknown as LockOwner;
		} catch {
			const lockStat = await lstat(lockPath);
			assertPrivateDirectoryStats(lockStat, 'Build-state lock directory');
			if (Date.now() - lockStat.mtimeMs < 30_000) return false;
			owner = { schemaVersion: 1, pid: -1, token: 'orphan', createdAt: new Date(0).toISOString() };
		}
		if (owner.pid > 0 && isProcessAlive(owner.pid)) return false;
		const stale = this.resolveRootChild(`.stale-lock-${randomBytes(12).toString('hex')}`);
		try {
			await rename(lockPath, stale);
			await rm(stale, { recursive: true, force: true });
			return true;
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return true;
			throw error;
		}
	}

	private async releaseLock(lockPath: string, token: string): Promise<void> {
		try {
			const decoded = JSON.parse((await readPrivateFile(path.join(lockPath, 'owner.json'), {
				label: 'Build-state lock owner',
				maximumBytes: 4_096,
			})).toString('utf8')) as unknown;
			if (!isRecord(decoded) || decoded.pid !== process.pid || decoded.token !== token) {
				throw new Error('Build-state lock ownership changed before release.');
			}
			await rm(lockPath, { recursive: true });
			await syncDirectory(this.canonicalRootPath);
		} catch (error) {
			if (!isNodeError(error, 'ENOENT')) throw error;
		}
	}
}

function validateCheckpoint<TArtifact>(checkpoint: CompilerCheckpoint<TArtifact>): void {
	if (
		checkpoint.schemaVersion !== BUILD_STATE_SCHEMA_VERSION
		|| !checkpoint.buildId
		|| !checkpoint.sourceId
		|| !/^[a-f0-9]{64}$/u.test(checkpoint.policyHash)
		|| !/^[a-f0-9]{64}$/u.test(checkpoint.planHash)
		|| !Array.isArray(checkpoint.completedFiles)
	) {
		throw new TypeError('Compiler checkpoint payload is invalid.');
	}
	const paths = new Set<string>();
	for (const completed of checkpoint.completedFiles) {
		if (
			!completed.path
			|| completed.path.includes('\0')
			|| !/^[a-f0-9]{64}$/u.test(completed.contentSha256)
			|| paths.has(completed.path)
		) {
			throw new TypeError('Compiler checkpoint file entry is invalid.');
		}
		paths.add(completed.path);
	}
}

function validateCheckpointFileRecord<TArtifact>(
	value: unknown,
	header: CheckpointHeader,
	previous: CheckpointFileRecord<TArtifact> | null,
): CheckpointFileRecord<TArtifact> {
	if (!isRecord(value)) throw new Error('Compiler file checkpoint must be an object.');
	const expectedKeys = [
		'artifact', 'buildId', 'contentSha256', 'entryHash', 'path', 'previousHash', 'schemaVersion', 'sequence',
	];
	if (Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')) {
		throw new Error('Compiler file checkpoint has unexpected fields.');
	}
	const record = value as unknown as CheckpointFileRecord<TArtifact>;
	if (
		record.schemaVersion !== BUILD_STATE_SCHEMA_VERSION
		|| record.buildId !== header.buildId
		|| record.sequence !== (previous?.sequence ?? 0) + 1
		|| record.previousHash !== (previous?.entryHash ?? null)
		|| !record.path
		|| !/^[a-f0-9]{64}$/u.test(record.contentSha256)
		|| typeof record.entryHash !== 'string'
	) {
		throw new Error('Compiler file checkpoint sequence or fields are invalid.');
	}
	const body = {
		schemaVersion: record.schemaVersion,
		buildId: record.buildId,
		sequence: record.sequence,
		previousHash: record.previousHash,
		path: record.path,
		contentSha256: record.contentSha256,
		artifact: record.artifact,
	};
	if (hashCanonicalJson(body) !== record.entryHash) throw new Error('Compiler file checkpoint checksum mismatch.');
	return record;
}

function sameCheckpointPlan(
	first: CheckpointHeader,
	second: CompilerCheckpoint<unknown>,
): boolean {
	return first.schemaVersion === second.schemaVersion
		&& first.buildId === second.buildId
		&& first.sourceId === second.sourceId
		&& first.policyHash === second.policyHash
		&& first.planHash === second.planHash
		&& first.startedAt === second.startedAt;
}

function checkpointEntrySignature(
	entry: { path: string; contentSha256: string; artifact: unknown } | undefined,
): string | null {
	return entry ? hashCanonicalJson(entry) : null;
}

function validateJournalRecord(value: unknown, previous: ChangeJournalRecord | null): ChangeJournalRecord {
	if (!isRecord(value)) throw new Error('Change journal record must be an object.');
	const record = value as unknown as ChangeJournalRecord;
	if (
		record.schemaVersion !== BUILD_STATE_SCHEMA_VERSION
		|| record.sequence !== (previous?.sequence ?? 0) + 1
		|| record.previousHash !== (previous?.entryHash ?? null)
		|| typeof record.entryHash !== 'string'
	) {
		throw new Error('Change journal sequence or hash chain is invalid.');
	}
	const body = {
		schemaVersion: record.schemaVersion,
		sequence: record.sequence,
		previousHash: record.previousHash,
		timestamp: record.timestamp,
		event: record.event,
		buildId: record.buildId,
		path: record.path,
		contentSha256: record.contentSha256,
		generationId: record.generationId,
	};
	if (hashCanonicalJson(body) !== record.entryHash) throw new Error('Change journal checksum mismatch.');
	return record;
}

function stripJournalIntegrity(record: ChangeJournalRecord): ChangeJournalInput {
	return {
		timestamp: record.timestamp,
		event: record.event,
		buildId: record.buildId,
		path: record.path,
		contentSha256: record.contentSha256,
		generationId: record.generationId,
	};
}

async function readBoundedFile(filePath: string, maximumBytes: number): Promise<Buffer> {
	return readPrivateFile(filePath, {
		label: 'Build-state file',
		maximumBytes,
	});
}

async function syncDirectory(directoryPath: string): Promise<void> {
	await syncPrivateDirectory(directoryPath, 'Build-state directory');
}

async function assertExistingPrivateTarget(
	filePath: string,
	label: string,
	maximumBytes: number,
): Promise<void> {
	try {
		await assertPrivateFilePath(filePath, { label, maximumBytes });
	} catch (error) {
		if (!isNodeError(error, 'ENOENT')) throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isNodeError(error, 'EPERM');
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

export function createBuildId(): string {
	return `build-${Date.now()}-${createHash('sha256').update(randomBytes(32)).digest('hex').slice(0, 24)}`;
}
