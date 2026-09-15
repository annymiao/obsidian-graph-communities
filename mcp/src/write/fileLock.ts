import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CONTROLLED_WRITE_SCHEMA_VERSION } from './contracts.js';
import { assertIsoTimestamp, canonicalJson } from './integrity.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;
const CREATE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW;
const READ_ONLY = constants.O_RDONLY | NO_FOLLOW;
const LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

export interface FileLockOwner {
	schemaVersion: typeof CONTROLLED_WRITE_SCHEMA_VERSION;
	pid: number;
	token: string;
	createdAt: string;
}

export interface OwnedFileLockOptions {
	timeoutMs?: number;
	retryMs?: number;
	clock?: () => number;
	pid?: number;
	isPidAlive?: (pid: number) => boolean;
}

/**
 * Executes under an O_EXCL lock whose owner is explicit and verified on release.
 * A dead owner's lock is first atomically renamed under a recovery marker, never
 * unlinked in place. A live PID is never displaced, regardless of lock age.
 */
export async function withOwnedFileLock<T>(
	lockPath: string,
	run: (owner: FileLockOwner) => Promise<T>,
	options: OwnedFileLockOptions = {},
): Promise<T> {
	const resolvedLockPath = validateLockPath(lockPath);
	const timeoutMs = boundedInteger(options.timeoutMs, 5_000, 'lock timeoutMs');
	const retryMs = boundedInteger(options.retryMs, 10, 'lock retryMs');
	if (retryMs > timeoutMs) throw new TypeError('lock retryMs must not exceed timeoutMs.');
	const clock = options.clock ?? Date.now;
	const pid = options.pid ?? process.pid;
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError('lock pid must be positive.');
	const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
	const owner = createOwner(pid, clock());
	const deadline = clock() + timeoutMs;

	while (true) {
		const recoveryPath = `${resolvedLockPath}.recovery`;
		if (await pathExists(recoveryPath)) {
			await recoverAbandonedRecoveryMarker(recoveryPath, isPidAlive);
			if (clock() >= deadline) throw new Error('Timed out waiting for lock recovery.');
			await delay(retryMs);
			continue;
		}
		try {
			await createOwnerFile(resolvedLockPath, owner);
			break;
		} catch (error) {
			if (!isNodeError(error, 'EEXIST')) throw error;
			const observed = await readOwnerFile(resolvedLockPath);
			if (!isPidAlive(observed.pid)) {
				await isolateStaleOwner(resolvedLockPath, observed, owner, isPidAlive);
				continue;
			}
			if (clock() >= deadline) throw new Error(`Timed out acquiring lock held by live PID ${observed.pid}.`);
			await delay(retryMs);
		}
	}

	try {
		return await run(owner);
	} finally {
		await releaseOwnedFile(resolvedLockPath, owner);
	}
}

async function isolateStaleOwner(
	lockPath: string,
	observed: FileLockOwner,
	recoverer: FileLockOwner,
	isPidAlive: (pid: number) => boolean,
): Promise<void> {
	const recoveryPath = `${lockPath}.recovery`;
	try {
		await createOwnerFile(recoveryPath, recoverer);
	} catch (error) {
		if (!isNodeError(error, 'EEXIST')) throw error;
		return;
	}
	try {
		let current: FileLockOwner;
		try {
			current = await readOwnerFile(lockPath);
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) return;
			throw error;
		}
		if (canonicalJson(current) !== canonicalJson(observed) || isPidAlive(current.pid)) return;
		const quarantinePath = `${lockPath}.stale-${current.token}-${recoverer.token}`;
		await rename(lockPath, quarantinePath);
		await syncDirectory(path.dirname(lockPath));
		const isolated = await readOwnerFile(quarantinePath);
		if (canonicalJson(isolated) !== canonicalJson(current)) {
			throw new Error('Stale lock identity changed during isolation.');
		}
		await unlink(quarantinePath);
		await syncDirectory(path.dirname(lockPath));
	} finally {
		await releaseOwnedFile(recoveryPath, recoverer);
	}
}

async function recoverAbandonedRecoveryMarker(
	recoveryPath: string,
	isPidAlive: (pid: number) => boolean,
): Promise<void> {
	const owner = await readOwnerFile(recoveryPath);
	if (isPidAlive(owner.pid)) return;
	const quarantinePath = `${recoveryPath}.stale-${owner.token}-${randomBytes(8).toString('hex')}`;
	try {
		await rename(recoveryPath, quarantinePath);
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return;
		throw error;
	}
	const isolated = await readOwnerFile(quarantinePath);
	if (canonicalJson(isolated) !== canonicalJson(owner)) {
		throw new Error('Recovery lock identity changed during isolation.');
	}
	await unlink(quarantinePath);
	await syncDirectory(path.dirname(recoveryPath));
}

async function createOwnerFile(lockPath: string, owner: FileLockOwner): Promise<void> {
	const handle = await open(lockPath, CREATE_NEW, 0o600);
	let complete = false;
	try {
		await handle.writeFile(`${canonicalJson(owner)}\n`, 'utf8');
		await handle.sync();
		complete = true;
	} finally {
		await handle.close();
		if (!complete) await unlink(lockPath).catch(() => undefined);
	}
	await syncDirectory(path.dirname(lockPath));
}

async function releaseOwnedFile(lockPath: string, owner: FileLockOwner): Promise<void> {
	let current: FileLockOwner;
	try {
		current = await readOwnerFile(lockPath);
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) throw new Error('Lock disappeared before owner release.');
		throw error;
	}
	if (
		current.pid !== owner.pid
		|| current.token !== owner.token
		|| current.createdAt !== owner.createdAt
	) {
		throw new Error('Refusing to release a lock owned by another process or token.');
	}
	await unlink(lockPath);
	await syncDirectory(path.dirname(lockPath));
}

async function readOwnerFile(lockPath: string): Promise<FileLockOwner> {
	const pathInfo = await lstat(lockPath);
	if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.size > 4_096) {
		throw new Error('Lock must be a bounded real regular file.');
	}
	const handle = await open(lockPath, READ_ONLY);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino || info.size > 4_096) {
			throw new Error('Lock identity changed while reading.');
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(await handle.readFile('utf8'));
		} catch (error) {
			throw new Error('Lock owner JSON is invalid.', { cause: error });
		}
		assertOwner(parsed);
		return parsed;
	} finally {
		await handle.close();
	}
}

function createOwner(pid: number, timestamp: number): FileLockOwner {
	return {
		schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
		pid,
		token: randomBytes(16).toString('hex'),
		createdAt: new Date(timestamp).toISOString(),
	};
}

function assertOwner(value: unknown): asserts value is FileLockOwner {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError('Lock owner must be an object.');
	}
	const owner = value as FileLockOwner;
	if (
		owner.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION
		|| !Number.isSafeInteger(owner.pid)
		|| owner.pid <= 0
		|| !LOCK_TOKEN_PATTERN.test(owner.token)
	) throw new TypeError('Lock owner schema is invalid.');
	assertIsoTimestamp(owner.createdAt, 'lock createdAt');
}

function defaultIsPidAlive(pid: number): boolean {
	if (pid === process.pid) return true;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isNodeError(error, 'ESRCH');
	}
}

function validateLockPath(lockPath: string): string {
	if (!lockPath || lockPath.includes('\0')) throw new TypeError('Lock path is invalid.');
	const resolved = path.resolve(lockPath);
	if (resolved === path.parse(resolved).root) throw new TypeError('Lock path must not be a root.');
	return resolved;
}

function boundedInteger(value: number | undefined, fallback: number, label: string): number {
	const result = value ?? fallback;
	if (!Number.isSafeInteger(result) || result <= 0 || result > 60_000) {
		throw new TypeError(`${label} must be an integer from 1 to 60000.`);
	}
	return result;
}

function pathExists(filePath: string): Promise<boolean> {
	return lstat(filePath).then(() => true, (error: unknown) => {
		if (isNodeError(error, 'ENOENT')) return false;
		throw error;
	});
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function syncDirectory(directoryPath: string): Promise<void> {
	let handle;
	try {
		handle = await open(directoryPath, constants.O_RDONLY | NO_FOLLOW | DIRECTORY_FLAG);
		await handle.sync();
	} catch (error) {
		if (
			process.platform === 'win32'
			&& ['EINVAL', 'ENOTSUP', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
		) return;
		throw error;
	} finally {
		await handle?.close();
	}
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}
