import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateFileHandle,
	ensurePrivateDirectory,
	readPrivateFile,
	syncPrivateDirectory,
	type PrivateDirectoryIdentity,
} from '../privateFs.js';
import {
	CONTROLLED_WRITE_SCHEMA_VERSION,
	type AuditEntry,
	type AuditEvent,
	type AuditLedger,
} from './contracts.js';
import { assertIsoTimestamp, assertSha256, canonicalJson, sha256 } from './integrity.js';
import { withOwnedFileLock } from './fileLock.js';

const LEDGER_FILE = 'audit.jsonl';
const LOCK_FILE = '.audit.lock';
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DEFAULT_MAXIMUM_BYTES = 64 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export interface HashChainAuditLedgerOptions {
	maximumBytes?: number;
	lockTimeoutMs?: number;
	clock?: () => number;
}

/**
 * Local append-only JSONL ledger. Each entry commits to the complete previous
 * entry hash. Receipts retain the commit entry hash as an external anchor.
 */
export class HashChainAuditLedger implements AuditLedger {
	private readonly configuredRoot: string;
	private readonly maximumBytes: number;
	private readonly lockTimeoutMs: number;
	private readonly clock: () => number;
	private initialization: Promise<void> | null = null;
	private canonicalRoot = '';
	private rootIdentity: PrivateDirectoryIdentity | null = null;
	private localQueue: Promise<void> = Promise.resolve();

	constructor(rootPath: string, options: HashChainAuditLedgerOptions = {}) {
		if (!rootPath || rootPath.includes('\0')) {
			throw new TypeError('Audit ledger path must be a non-empty filesystem path.');
		}
		this.configuredRoot = path.resolve(rootPath);
		if (this.configuredRoot === path.parse(this.configuredRoot).root) {
			throw new TypeError('Audit ledger must not use a filesystem root.');
		}
		this.maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES;
		this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
		this.clock = options.clock ?? Date.now;
		for (const [value, label] of [
			[this.maximumBytes, 'maximumBytes'],
			[this.lockTimeoutMs, 'lockTimeoutMs'],
		] as const) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new TypeError(`${label} must be a positive safe integer.`);
			}
		}
	}

	async append(event: AuditEvent): Promise<AuditEntry> {
		assertAuditEvent(event);
		return this.serialized(async () => {
			await this.ensureInitialized();
			return this.withLock(async () => {
				const entries = await this.readAndVerify();
				const previous = entries.at(-1);
				const unsigned = {
					...event,
					schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
					sequence: (previous?.sequence ?? 0) + 1,
					timestamp: new Date(this.clock()).toISOString(),
					previousHash: previous?.entryHash ?? null,
				};
				const entry: AuditEntry = {
					...unsigned,
					entryHash: sha256(canonicalJson(unsigned)),
				};
				const line = `${canonicalJson(entry)}\n`;
				const ledgerPath = path.join(this.canonicalRoot, LEDGER_FILE);
				const handle = await open(
					ledgerPath,
					constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
					0o600,
				);
				try {
					const before = await assertPrivateFileHandle(handle, {
						label: 'Audit ledger',
						maximumBytes: this.maximumBytes,
					});
					const lineBytes = Buffer.byteLength(line, 'utf8');
					if (before.size + lineBytes > this.maximumBytes) {
						throw new RangeError('Audit ledger maximumBytes would be exceeded.');
					}
					await handle.writeFile(line, 'utf8');
					await handle.sync();
					const after = await assertPrivateFileHandle(handle, {
						label: 'Audit ledger',
						maximumBytes: this.maximumBytes,
					});
					if (
						after.dev !== before.dev
						|| after.ino !== before.ino
						|| after.size !== before.size + lineBytes
					) throw new Error('Audit ledger changed unexpectedly while appending.');
				} finally {
					await handle.close();
				}
				await syncDirectory(this.canonicalRoot);
				await this.assertRootIdentity();
				return entry;
			});
		});
	}

	async verify(): Promise<AuditEntry[]> {
		await this.ensureInitialized();
		return this.serialized(async () => this.withLock(async () => this.readAndVerify()));
	}

	private async readAndVerify(): Promise<AuditEntry[]> {
		await this.assertRootIdentity();
		const ledgerPath = path.join(this.canonicalRoot, LEDGER_FILE);
		let bytes: Buffer;
		try {
			bytes = await readPrivateFile(ledgerPath, {
				label: 'Audit ledger',
				maximumBytes: this.maximumBytes,
			});
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return [];
			throw error;
		}
		const content = bytes.toString('utf8');
		if (content.length === 0) return [];
		if (!content.endsWith('\n')) throw new Error('Audit ledger has a truncated final entry.');
		const entries: AuditEntry[] = [];
		let previousHash: string | null = null;
		for (const [index, line] of content.slice(0, -1).split('\n').entries()) {
			if (Buffer.byteLength(line, 'utf8') > 128 * 1024) {
				throw new Error(`Audit entry ${index + 1} is too large.`);
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				throw new Error(`Audit entry ${index + 1} is invalid JSON.`, { cause: error });
			}
			assertAuditEntry(parsed, index + 1, previousHash);
			entries.push(parsed);
			previousHash = parsed.entryHash;
		}
		return entries;
	}

	private async withLock<T>(run: () => Promise<T>): Promise<T> {
		await this.assertRootIdentity();
		const lockPath = path.join(this.canonicalRoot, LOCK_FILE);
		return withOwnedFileLock(lockPath, async () => run(), {
			timeoutMs: this.lockTimeoutMs,
		});
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialization) return this.initialization;
		this.initialization = (async () => {
			const root = await ensurePrivateDirectory(this.configuredRoot, 'Audit ledger root');
			this.canonicalRoot = root.path;
			this.rootIdentity = root.identity;
		})();
		try {
			await this.initialization;
		} catch (error) {
			this.initialization = null;
			throw error;
		}
	}

	private async assertRootIdentity(): Promise<void> {
		if (!this.rootIdentity) throw new Error('Audit ledger is not initialized.');
		await assertPrivateDirectoryIdentity(
			this.canonicalRoot,
			this.rootIdentity,
			'Audit ledger root',
		);
	}

	private async serialized<T>(run: () => Promise<T>): Promise<T> {
		const previous = this.localQueue;
		let release!: () => void;
		this.localQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await run();
		} finally {
			release();
		}
	}
}

function assertAuditEntry(value: unknown, expectedSequence: number, previousHash: string | null): asserts value is AuditEntry {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`Audit entry ${expectedSequence} must be an object.`);
	}
	const entry = value as AuditEntry;
	if (entry.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new Error(`Audit entry ${expectedSequence} has an unsupported schema.`);
	}
	if (entry.sequence !== expectedSequence || entry.previousHash !== previousHash) {
		throw new Error(`Audit entry ${expectedSequence} breaks the hash chain.`);
	}
	assertIsoTimestamp(entry.timestamp, `audit entry ${expectedSequence} timestamp`);
	assertSha256(entry.entryHash, `audit entry ${expectedSequence} hash`);
	assertAuditEvent(entry);
	const { entryHash, ...unsigned } = entry;
	if (sha256(canonicalJson(unsigned)) !== entryHash) {
		throw new Error(`Audit entry ${expectedSequence} checksum mismatch.`);
	}
}

function assertAuditEvent(event: AuditEvent): void {
	const types: AuditEvent['type'][] = [
		'write_started', 'write_committed', 'write_degraded', 'write_failed', 'reingest_completed',
		'reingest_failed', 'rollback_started', 'rollback_completed', 'rollback_failed',
	];
	if (!types.includes(event.type)) throw new TypeError('Unsupported audit event type.');
	for (const [value, label, maximum] of [
		[event.transactionId, 'audit transactionId', 256],
		[event.tokenId, 'audit tokenId', 256],
		[event.source.adapterId, 'audit adapterId', 128],
		[event.source.documentPath, 'audit documentPath', 4_096],
	] as const) {
		if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.length > maximum) {
			throw new TypeError(`${label} is invalid.`);
		}
	}
	assertSha256(event.proposalHash, 'audit proposalHash');
	assertSha256(event.planHash, 'audit planHash');
	if (event.detail !== undefined && Buffer.byteLength(event.detail, 'utf8') > 4_096) {
		throw new RangeError('Audit event detail exceeds 4096 bytes.');
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
	await syncPrivateDirectory(directoryPath, 'Audit ledger root');
}
