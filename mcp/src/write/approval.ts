import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateFileHandle,
	assertPrivateFilePath,
	ensurePrivateDirectory,
	syncPrivateDirectory,
	type PrivateDirectoryIdentity,
} from '../privateFs.js';
import {
	CONTROLLED_WRITE_SCHEMA_VERSION,
	type ApprovalToken,
	type ApprovalVerifier,
	type RiskLevel,
} from './contracts.js';
import { assertIsoTimestamp, assertNonEmptyText, assertSha256, canonicalJson } from './integrity.js';
import { compareRisk } from './proposal.js';

const TOKEN_ID_PATTERN = /^approval_v1_[a-f0-9]{32}$/u;
const DEFAULT_MAXIMUM_TTL_MS = 24 * 60 * 60 * 1_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAXIMUM_APPROVAL_MARKER_BYTES = 1_024;

export interface ApprovalUseStore {
	/** Atomically claims a token. False means it was already consumed. */
	claim(tokenId: string, bindingSha256: string): Promise<boolean>;
}

/** Test-only replay store. Production runtimes must use a persistent ApprovalUseStore. */
export class InMemoryApprovalUseStore implements ApprovalUseStore {
	private readonly claimed = new Set<string>();

	async claim(tokenId: string, _bindingSha256: string): Promise<boolean> {
		if (this.claimed.has(tokenId)) return false;
		this.claimed.add(tokenId);
		return true;
	}
}

/** A durable, process-safe replay registry using one O_EXCL marker per approval. */
export class FileApprovalUseStore implements ApprovalUseStore {
	private readonly configuredRoot: string;
	private initialization: Promise<void> | null = null;
	private canonicalRoot = '';
	private identity: PrivateDirectoryIdentity | null = null;

	constructor(rootPath: string) {
		if (!rootPath || rootPath.includes('\0')) {
			throw new TypeError('Approval use store path must be a non-empty filesystem path.');
		}
		this.configuredRoot = path.resolve(rootPath);
		if (this.configuredRoot === path.parse(this.configuredRoot).root) {
			throw new TypeError('Approval use store must not be a filesystem root.');
		}
	}

	async claim(tokenId: string, bindingSha256: string): Promise<boolean> {
		if (!TOKEN_ID_PATTERN.test(tokenId)) throw new TypeError('Approval tokenId is invalid.');
		assertSha256(bindingSha256, 'approval binding');
		await this.ensureInitialized();
		await this.assertIdentity();
		const markerPath = path.join(this.canonicalRoot, `${tokenId}.used`);
		let handle;
		try {
			handle = await open(
				markerPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
				0o600,
			);
			await assertPrivateFileHandle(handle, {
				label: 'Approval use marker',
				maximumBytes: MAXIMUM_APPROVAL_MARKER_BYTES,
			});
			const marker = `${canonicalJson({ tokenId, bindingSha256 })}\n`;
			if (Buffer.byteLength(marker, 'utf8') > MAXIMUM_APPROVAL_MARKER_BYTES) {
				throw new Error('Approval use marker exceeds its size limit.');
			}
			await handle.writeFile(marker, 'utf8');
			await handle.sync();
			await assertPrivateFileHandle(handle, {
				label: 'Approval use marker',
				minimumBytes: 1,
				maximumBytes: MAXIMUM_APPROVAL_MARKER_BYTES,
			});
			await syncDirectory(this.canonicalRoot);
			await this.assertIdentity();
			return true;
		} catch (error) {
			if (isNodeError(error, 'EEXIST')) {
				await assertPrivateFilePath(markerPath, {
					label: 'Existing approval use marker',
					minimumBytes: 1,
					maximumBytes: MAXIMUM_APPROVAL_MARKER_BYTES,
				});
				return false;
			}
			throw error;
		} finally {
			await handle?.close();
		}
	}

	private async ensureInitialized(): Promise<void> {
		if (this.initialization) return this.initialization;
		this.initialization = (async () => {
			const root = await ensurePrivateDirectory(this.configuredRoot, 'Approval use store');
			this.canonicalRoot = root.path;
			this.identity = root.identity;
		})();
		try {
			await this.initialization;
		} catch (error) {
			this.initialization = null;
			throw error;
		}
	}

	private async assertIdentity(): Promise<void> {
		if (!this.identity) throw new Error('Approval use store is not initialized.');
		await assertPrivateDirectoryIdentity(
			this.canonicalRoot,
			this.identity,
			'Approval use store',
		);
	}
}

export interface ApprovalTokenAuthorityOptions {
	/** Required deliberately: production must make one-time consumption durable. */
	store: ApprovalUseStore;
	clock?: () => number;
	maximumTtlMs?: number;
}

export interface IssueApprovalInput {
	proposalHash: string;
	approvedBy: string;
	maximumRisk: RiskLevel;
	ttlMs: number;
}

export class ApprovalTokenAuthority implements ApprovalVerifier {
	private readonly secret: Buffer;
	private readonly store: ApprovalUseStore;
	private readonly clock: () => number;
	private readonly maximumTtlMs: number;

	constructor(secret: string | Uint8Array, options: ApprovalTokenAuthorityOptions) {
		this.secret = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
		if (this.secret.byteLength < 32) {
			throw new TypeError('Approval signing secret must contain at least 32 bytes.');
		}
		if (!options?.store || typeof options.store.claim !== 'function') {
			throw new TypeError('ApprovalTokenAuthority requires a persistent or explicit test use store.');
		}
		this.store = options.store;
		this.clock = options.clock ?? Date.now;
		this.maximumTtlMs = options.maximumTtlMs ?? DEFAULT_MAXIMUM_TTL_MS;
		if (!Number.isSafeInteger(this.maximumTtlMs) || this.maximumTtlMs <= 0) {
			throw new TypeError('maximumTtlMs must be a positive safe integer.');
		}
	}

	issue(input: IssueApprovalInput): ApprovalToken {
		assertSha256(input.proposalHash, 'approval proposalHash');
		assertNonEmptyText(input.approvedBy, 'approvedBy', 512);
		assertRiskLevel(input.maximumRisk);
		if (
			!Number.isSafeInteger(input.ttlMs)
			|| input.ttlMs <= 0
			|| input.ttlMs > this.maximumTtlMs
		) {
			throw new RangeError(`Approval ttlMs must be between 1 and ${this.maximumTtlMs}.`);
		}
		const approvedAtMs = this.clock();
		const unsigned = {
			schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
			tokenId: `approval_v1_${randomBytes(16).toString('hex')}`,
			proposalHash: input.proposalHash,
			approvedAt: new Date(approvedAtMs).toISOString(),
			expiresAt: new Date(approvedAtMs + input.ttlMs).toISOString(),
			approvedBy: input.approvedBy,
			maximumRisk: input.maximumRisk,
		};
		return { ...unsigned, signature: this.sign(unsigned) };
	}

	async consume(token: ApprovalToken, proposalHash: string, risk: RiskLevel): Promise<void> {
		this.verify(token, proposalHash, risk);
		const claimed = await this.store.claim(
			token.tokenId,
			this.sign({ tokenId: token.tokenId, proposalHash }),
		);
		if (!claimed) throw new Error('Approval token has already been consumed.');
	}

	verify(token: ApprovalToken, proposalHash: string, risk: RiskLevel): void {
		if (token.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
			throw new TypeError('Unsupported approval token schema version.');
		}
		if (!TOKEN_ID_PATTERN.test(token.tokenId)) throw new TypeError('Approval tokenId is invalid.');
		assertSha256(token.proposalHash, 'token proposalHash');
		assertSha256(proposalHash, 'expected proposalHash');
		assertNonEmptyText(token.approvedBy, 'approvedBy', 512);
		assertIsoTimestamp(token.approvedAt, 'approval approvedAt');
		assertIsoTimestamp(token.expiresAt, 'approval expiresAt');
		assertRiskLevel(token.maximumRisk);
		assertRiskLevel(risk);
		if (token.proposalHash !== proposalHash) {
			throw new Error('Approval token is bound to a different proposal hash.');
		}
		if (compareRisk(risk, token.maximumRisk) > 0) {
			throw new Error('Approval token does not authorize this risk level.');
		}
		const approvedAt = Date.parse(token.approvedAt);
		const expiresAt = Date.parse(token.expiresAt);
		if (expiresAt <= approvedAt || expiresAt - approvedAt > this.maximumTtlMs) {
			throw new Error('Approval token validity interval is invalid.');
		}
		const now = this.clock();
		if (now < approvedAt) throw new Error('Approval token is not valid yet.');
		if (now >= expiresAt) throw new Error('Approval token has expired.');
		const { signature, ...unsigned } = token;
		const expected = Buffer.from(this.sign(unsigned), 'hex');
		const actual = /^[a-f0-9]{64}$/u.test(signature) ? Buffer.from(signature, 'hex') : Buffer.alloc(0);
		if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) {
			throw new Error('Approval token signature is invalid.');
		}
	}

	private sign(value: unknown): string {
		return createHmac('sha256', this.secret).update(canonicalJson(value)).digest('hex');
	}
}

function assertRiskLevel(value: RiskLevel): void {
	if (!['low', 'medium', 'high', 'critical'].includes(value)) {
		throw new TypeError('Invalid risk level.');
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

async function syncDirectory(directoryPath: string): Promise<void> {
	await syncPrivateDirectory(directoryPath, 'Approval use store');
}
