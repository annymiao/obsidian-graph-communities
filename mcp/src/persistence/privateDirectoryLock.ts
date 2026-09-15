import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
	lstat,
	mkdir,
	open,
	readdir,
	rename,
	rmdir,
	unlink,
} from 'node:fs/promises';
import path from 'node:path';
import {
	assertPrivateDirectoryIdentity,
	assertPrivateDirectoryStats,
	assertPrivateFileHandle,
	assertPrivateFilePath,
	assertPrivateRegularFileStats,
	ensurePrivateDirectory,
	readPrivateFile,
	syncPrivateDirectory,
	type PrivateDirectoryIdentity,
	PrivateFileChangedError,
} from '../privateFs.js';
import { canonicalJson } from './canonicalJson.js';

const PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION = 1 as const;
const OWNER_FILE = 'owner.json';
const RELEASE_FILE = 'released.json';
const MAXIMUM_LOCK_STATE_BYTES = 4_096;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const RELEASE_TRANSITION_TIMEOUT_MS = 60_000;
const RELEASE_POLL_INTERVAL_MS = 5;
const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const MAXIMUM_TIMEOUT_MS = 2_147_483_647;
const MAXIMUM_POLL_INTERVAL_MS = 1_000;
const MAXIMUM_ORPHAN_GRACE_MS = 5 * 60_000;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const TOKEN_PATTERN = /^[a-f0-9]{32}$/u;

interface PrivateDirectoryLockOwner {
	schemaVersion: typeof PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION;
	pid: number;
	token: string;
	createdAt: string;
}

interface PrivateDirectoryLockRelease {
	schemaVersion: typeof PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION;
	token: string;
	releasedAt: string;
}

interface AcquiredPrivateDirectoryLock {
	parentPath: string;
	parentIdentity: PrivateDirectoryIdentity;
	lockPath: string;
	lockIdentity: PrivateDirectoryIdentity;
	transitionGatePath: string;
	owner: PrivateDirectoryLockOwner;
	releaseTimeoutMs: number;
}

interface TransitionGate {
	path: string;
	identity: PrivateDirectoryIdentity;
}

interface LockEntries {
	hasOwner: boolean;
	hasRelease: boolean;
}

export interface PrivateDirectoryLockOptions {
	/** Maximum acquisition wait. The protected operation itself is not timed out. */
	timeoutMs?: number;
	/** Maximum delay between acquisition attempts. */
	pollIntervalMs?: number;
	/** Minimum age before an ownerless or malformed lock can be recovered. */
	orphanGraceMs?: number;
	/**
	 * Maximum wait while handing a completed operation's lock to the transition
	 * gate. A timeout is reported as a non-retryable release error: the protected
	 * operation has already settled and must not be run again automatically.
	 */
	releaseTimeoutMs?: number;
}

export type PrivateDirectoryLockBusyReason = 'owner-busy' | 'transition-gate-busy';

export class PrivateDirectoryLockBusyError extends Error {
	readonly reason: PrivateDirectoryLockBusyReason;

	constructor(
		message = 'Private directory lock is busy.',
		reason: PrivateDirectoryLockBusyReason = 'owner-busy',
	) {
		super(message);
		this.name = 'PrivateDirectoryLockBusyError';
		this.reason = reason;
	}
}

export class PrivateDirectoryLockReleaseError extends Error {
	readonly code = 'PRIVATE_DIRECTORY_LOCK_RELEASE_INCOMPLETE' as const;
	readonly retryable = false as const;
	readonly protectedOperationStatus: 'completed' | 'failed';

	constructor(
		message: string,
		protectedOperationStatus: 'completed' | 'failed',
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'PrivateDirectoryLockReleaseError';
		this.protectedOperationStatus = protectedOperationStatus;
	}
}

/**
 * Runs an operation while owning an inter-process directory lock. The lock and
 * owner file are private local state. Acquisition is bounded; a live owner is
 * never evicted while operating. After the callback settles, a durable
 * token-bound release marker permits gated recovery even before that PID exits.
 */
export async function withPrivateDirectoryLock<T>(
	configuredLockPath: string,
	operation: () => Promise<T>,
	options: PrivateDirectoryLockOptions = {},
): Promise<T> {
	const timeoutMs = boundedInteger(
		options.timeoutMs,
		DEFAULT_TIMEOUT_MS,
		1,
		MAXIMUM_TIMEOUT_MS,
		'timeoutMs',
	);
	const pollIntervalMs = boundedInteger(
		options.pollIntervalMs,
		DEFAULT_POLL_INTERVAL_MS,
		1,
		MAXIMUM_POLL_INTERVAL_MS,
		'pollIntervalMs',
	);
	const orphanGraceMs = boundedInteger(
		options.orphanGraceMs,
		DEFAULT_ORPHAN_GRACE_MS,
		1,
		MAXIMUM_ORPHAN_GRACE_MS,
		'orphanGraceMs',
	);
	const releaseTimeoutMs = boundedInteger(
		options.releaseTimeoutMs,
		RELEASE_TRANSITION_TIMEOUT_MS,
		1,
		MAXIMUM_TIMEOUT_MS,
		'releaseTimeoutMs',
	);
	const resolvedLockPath = safeLockPath(configuredLockPath);
	const privateParent = await ensurePrivateDirectory(
		path.dirname(resolvedLockPath),
		'Private directory lock parent',
	);
	const lockPath = path.join(privateParent.path, path.basename(resolvedLockPath));
	const transitionGatePath = `${lockPath}.recovery`;
	const deadline = Date.now() + timeoutMs;
	const owner: PrivateDirectoryLockOwner = {
		schemaVersion: PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION,
		pid: process.pid,
		token: randomBytes(16).toString('hex'),
		createdAt: new Date().toISOString(),
	};

	let acquired!: AcquiredPrivateDirectoryLock;
	for (;;) {
		await assertPrivateDirectoryIdentity(
			privateParent.path,
			privateParent.identity,
			'Private directory lock parent',
		);
		const gate = await tryAcquireTransitionGate(
			privateParent.path,
			privateParent.identity,
			transitionGatePath,
		);
		if (gate === null) {
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				throw new PrivateDirectoryLockBusyError(
					'Private directory lock transition gate is busy; retry and inspect it if this persists.',
					'transition-gate-busy',
				);
			}
			await delay(Math.min(pollIntervalMs, remainingMs));
			continue;
		}
		try {
			try {
				acquired = await createMainLockUnderGate(
					privateParent.path,
					privateParent.identity,
					lockPath,
						transitionGatePath,
						owner,
						releaseTimeoutMs,
					);
			} catch (error) {
				if (!isNodeError(error, 'EEXIST')) throw error;
				const recovered = await recoverAbandonedLockUnderGate(
					privateParent.path,
					privateParent.identity,
					lockPath,
					orphanGraceMs,
				);
				if (recovered) {
					try {
						acquired = await createMainLockUnderGate(
							privateParent.path,
							privateParent.identity,
							lockPath,
								transitionGatePath,
								owner,
								releaseTimeoutMs,
							);
					} catch (createError) {
						if (isNodeError(createError, 'EEXIST')) {
							throw new Error(
								'Private directory lock changed outside its transition gate; stop mixed-version processes.',
								{ cause: createError },
							);
						}
						throw createError;
					}
				}
			}
		} finally {
			await releaseTransitionGate(privateParent.path, privateParent.identity, gate);
		}
		if (acquired !== undefined) break;
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) throw new PrivateDirectoryLockBusyError();
		await delay(Math.min(pollIntervalMs, remainingMs));
	}

	let result: T;
	try {
		result = await operation();
	} catch (operationError) {
		try {
			await releaseLock(acquired);
		} catch (releaseError) {
			throw new PrivateDirectoryLockReleaseError(
				'Protected operation failed and its directory lock release did not complete; do not retry automatically.',
				'failed',
				{ cause: new AggregateError([operationError, releaseError]) },
			);
		}
		throw operationError;
	}
	try {
		await releaseLock(acquired);
	} catch (error) {
		throw new PrivateDirectoryLockReleaseError(
			'Protected operation completed but its directory lock release did not complete; do not retry automatically.',
			'completed',
			{ cause: error },
		);
	}
	return result;
}

async function createMainLockUnderGate(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	lockPath: string,
	transitionGatePath: string,
	owner: PrivateDirectoryLockOwner,
	releaseTimeoutMs: number,
): Promise<AcquiredPrivateDirectoryLock> {
	await mkdir(lockPath, { mode: 0o700 });
	const info = await lstat(lockPath);
	assertPrivateDirectoryStats(info, 'Private directory lock');
	const lockIdentity = { dev: info.dev, ino: info.ino };
	try {
		await writeOwner(lockPath, owner, lockIdentity);
		await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
		await syncPrivateDirectory(parentPath, 'Private directory lock parent');
	} catch (error) {
		await discardNewLock(parentPath, parentIdentity, lockPath, lockIdentity).catch(() => undefined);
		throw error;
	}
	return {
		parentPath,
		parentIdentity,
		lockPath,
		lockIdentity,
		transitionGatePath,
		owner,
		releaseTimeoutMs,
	};
}

async function writeOwner(
	lockPath: string,
	owner: PrivateDirectoryLockOwner,
	lockIdentity: PrivateDirectoryIdentity,
): Promise<void> {
	await assertPrivateDirectoryIdentity(lockPath, lockIdentity, 'Private directory lock');
	const handle = await open(
		path.join(lockPath, OWNER_FILE),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
		0o600,
	);
	try {
		await assertPrivateFileHandle(handle, {
			label: 'Private directory lock owner',
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
		await handle.writeFile(`${canonicalJson(owner)}\n`, 'utf8');
		await handle.sync();
		await assertPrivateFileHandle(handle, {
			label: 'Private directory lock owner',
			minimumBytes: 1,
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
	} finally {
		await handle.close();
	}
	await assertPrivateDirectoryIdentity(lockPath, lockIdentity, 'Private directory lock');
	await syncPrivateDirectory(lockPath, 'Private directory lock');
}

async function recoverAbandonedLockUnderGate(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	lockPath: string,
	orphanGraceMs: number,
): Promise<boolean> {
	let lockInfo;
	try {
		lockInfo = await lstat(lockPath);
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return true;
		throw error;
	}
	assertPrivateDirectoryStats(lockInfo, 'Private directory lock');
	const lockIdentity = { dev: lockInfo.dev, ino: lockInfo.ino };
	let entries: LockEntries;
	try {
		entries = await readExpectedLockEntries(lockPath, {
			allowOwnerless: true,
			allowRelease: true,
		});
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return true;
		throw error;
	}
	let owner: PrivateDirectoryLockOwner | null = null;
	let release: PrivateDirectoryLockRelease | null = null;
	let releaseMalformed = false;
	let newestStateMtimeMs = lockInfo.mtimeMs;
	if (entries.hasOwner) {
		const ownerPath = path.join(lockPath, OWNER_FILE);
		try {
			const ownerInfo = await assertPrivateFilePath(ownerPath, {
				label: 'Private directory lock owner',
				maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
			});
			newestStateMtimeMs = Math.max(newestStateMtimeMs, ownerInfo.mtimeMs);
			const bytes = await readPrivateFile(ownerPath, {
				label: 'Private directory lock owner',
				maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
			});
			try {
				owner = parseOwner(JSON.parse(bytes.toString('utf8')) as unknown);
			} catch {
				owner = null;
			}
			} catch (error) {
				if (isNodeError(error, 'ENOENT')) return true;
				throw error;
			}
	}
	if (entries.hasRelease) {
		const releasePath = path.join(lockPath, RELEASE_FILE);
		try {
			const releaseInfo = await assertPrivateFilePath(releasePath, {
				label: 'Private directory lock release marker',
				maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
			});
			newestStateMtimeMs = Math.max(newestStateMtimeMs, releaseInfo.mtimeMs);
			const bytes = await readPrivateFile(releasePath, {
				label: 'Private directory lock release marker',
				maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
			});
			try {
				release = parseRelease(JSON.parse(bytes.toString('utf8')) as unknown);
			} catch {
				releaseMalformed = true;
			}
			} catch (error) {
				if (
					owner !== null
					&& isProcessAlive(owner.pid)
					&& isTransientReleaseMarkerReadError(error)
					&& await isFreshPrivateReleaseMarker(releasePath, orphanGraceMs)
				) return false;
				throw error;
			}
	}
	if (owner !== null && release !== null && release.token !== owner.token) {
		throw new Error('Private directory lock release marker does not match its owner.');
	}
	const releasedByOwner = owner !== null && release !== null;
	const ownerAlive = owner !== null && isProcessAlive(owner.pid);
	if (!releasedByOwner && ownerAlive) {
		if (releaseMalformed && Date.now() - newestStateMtimeMs >= orphanGraceMs) {
			throw new Error(
				'Private directory lock has a malformed release marker for a live owner; stop the owner and inspect the lock.',
			);
		}
		return false;
	}
	if (
		(owner === null || releaseMalformed)
		&& Date.now() - newestStateMtimeMs < orphanGraceMs
	) return false;

	try {
		await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
		await assertPrivateDirectoryIdentity(lockPath, lockIdentity, 'Private directory lock');
		const currentEntries = await readExpectedLockEntries(lockPath, {
			allowOwnerless: true,
			allowRelease: true,
		});
		if (
			currentEntries.hasOwner !== entries.hasOwner
			|| currentEntries.hasRelease !== entries.hasRelease
		) throw new Error('Private directory lock contents changed during recovery.');
		if (owner !== null) {
			const currentOwner = await readOwner(lockPath);
			if (!sameOwner(currentOwner, owner)) {
				throw new Error('Private directory lock ownership changed during recovery.');
			}
		}
		if (release !== null) {
			const currentRelease = await readRelease(lockPath);
			if (!sameRelease(currentRelease, release)) {
				throw new Error('Private directory lock release marker changed during recovery.');
			}
		}
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return true;
		throw error;
	}
	const movedPath = path.join(
		parentPath,
		`.abandoned-${path.basename(lockPath)}-${randomBytes(12).toString('hex')}`,
	);
	try {
		await rename(lockPath, movedPath);
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return true;
		throw error;
	}
	await syncPrivateDirectory(parentPath, 'Private directory lock parent');
	await assertPrivateDirectoryIdentity(movedPath, lockIdentity, 'Abandoned private directory lock');
	if (owner !== null) {
		const movedOwner = await readOwner(movedPath);
		if (!sameOwner(movedOwner, owner)) {
			throw new Error('Private directory lock ownership changed while being recovered.');
		}
	}
	if (release !== null) {
		const movedRelease = await readRelease(movedPath);
		if (!sameRelease(movedRelease, release)) {
			throw new Error('Private directory lock release marker changed while being recovered.');
		}
	}
	await removeKnownLockDirectory(movedPath, lockIdentity, entries);
	await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
	await syncPrivateDirectory(parentPath, 'Private directory lock parent');
	return true;
}

function isTransientReleaseMarkerReadError(error: unknown): boolean {
	return error instanceof PrivateFileChangedError;
}

async function isFreshPrivateReleaseMarker(
	releasePath: string,
	orphanGraceMs: number,
): Promise<boolean> {
	const info = await lstat(releasePath);
	assertPrivateRegularFileStats(info, {
		label: 'Private directory lock release marker',
		maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
	});
	return Date.now() - info.mtimeMs < orphanGraceMs;
}

async function tryAcquireTransitionGate(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	claimPath: string,
): Promise<TransitionGate | null> {
	await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
	try {
		await mkdir(claimPath, { mode: 0o700 });
	} catch (error) {
		if (!isNodeError(error, 'EEXIST')) throw error;
		try {
			const info = await lstat(claimPath);
			assertPrivateDirectoryStats(info, 'Private directory lock transition gate');
		} catch (inspectionError) {
			if (isNodeError(inspectionError, 'ENOENT')) return null;
			throw inspectionError;
		}
		return null;
	}
	const info = await lstat(claimPath);
	assertPrivateDirectoryStats(info, 'Private directory lock transition gate');
	await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
	return { path: claimPath, identity: { dev: info.dev, ino: info.ino } };
}

async function releaseTransitionGate(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	gate: TransitionGate,
): Promise<void> {
	await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
	await assertPrivateDirectoryIdentity(
		gate.path,
		gate.identity,
		'Private directory lock transition gate',
	);
	if ((await readdir(gate.path)).length !== 0) {
		throw new Error('Private directory lock transition gate contains unexpected entries.');
	}
	await rmdir(gate.path);
	// The transition gate is process-synchronization state, not durable data.
	// Its mkdir/rmdir visibility is atomic for live contenders; fsyncing the
	// removal could report failure after the gate is already gone and strand a
	// freshly created main lock before its protected operation starts.
}

async function writeReleaseMarker(
	lock: AcquiredPrivateDirectoryLock,
): Promise<PrivateDirectoryLockRelease> {
	await assertPrivateDirectoryIdentity(
		lock.parentPath,
		lock.parentIdentity,
		'Private directory lock parent',
	);
	await assertPrivateDirectoryIdentity(lock.lockPath, lock.lockIdentity, 'Private directory lock');
	const entries = await readExpectedLockEntries(lock.lockPath, {
		allowOwnerless: false,
		allowRelease: true,
	});
	const owner = await readOwner(lock.lockPath);
	if (!sameOwner(owner, lock.owner)) {
		throw new Error('Private directory lock ownership changed before release marker creation.');
	}
	if (entries.hasRelease) {
		const existing = await readRelease(lock.lockPath);
		if (existing.token !== owner.token) {
			throw new Error('Private directory lock release marker does not match its owner.');
		}
		return existing;
	}

	const release: PrivateDirectoryLockRelease = {
		schemaVersion: PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION,
		token: owner.token,
		releasedAt: new Date().toISOString(),
	};
	const handle = await open(
		path.join(lock.lockPath, RELEASE_FILE),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
		0o600,
	);
	try {
		await assertPrivateFileHandle(handle, {
			label: 'Private directory lock release marker',
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
		await handle.writeFile(`${canonicalJson(release)}\n`, 'utf8');
		await handle.sync();
		await assertPrivateFileHandle(handle, {
			label: 'Private directory lock release marker',
			minimumBytes: 1,
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
	} finally {
		await handle.close();
	}
	try {
		await assertPrivateDirectoryIdentity(lock.lockPath, lock.lockIdentity, 'Private directory lock');
		await syncPrivateDirectory(lock.lockPath, 'Private directory lock');
		await assertPrivateDirectoryIdentity(
			lock.parentPath,
			lock.parentIdentity,
			'Private directory lock parent',
		);
		const currentOwner = await readOwner(lock.lockPath);
		if (!sameOwner(currentOwner, owner)) {
			throw new Error('Private directory lock ownership changed after release marker creation.');
		}
		const currentRelease = await readRelease(lock.lockPath);
		if (!sameRelease(currentRelease, release)) {
			throw new Error('Private directory lock release marker changed after creation.');
		}
	} catch (error) {
		// A contender may observe the fully written marker, take the gate, and
		// consume this lock before our post-write directory sync/revalidation.
		// Missing or a different real lock inode is successful handoff, not damage.
		if (await originalLockWasDetached(lock)) return release;
		throw error;
	}
	return release;
}

async function originalLockWasDetached(lock: AcquiredPrivateDirectoryLock): Promise<boolean> {
	const gate = await acquireTransitionGate(
		lock.parentPath,
		lock.parentIdentity,
		lock.transitionGatePath,
		lock.releaseTimeoutMs,
	);
	try {
		return (await observeCurrentLockUnderGate(lock)).kind !== 'original';
	} finally {
		await releaseTransitionGate(lock.parentPath, lock.parentIdentity, gate);
	}
}

async function releaseLock(lock: AcquiredPrivateDirectoryLock): Promise<void> {
	const release = await writeReleaseMarker(lock);
	const gate = await acquireTransitionGate(
		lock.parentPath,
		lock.parentIdentity,
		lock.transitionGatePath,
		lock.releaseTimeoutMs,
	);
	try {
		const observation = await observeCurrentLockUnderGate(lock);
		if (observation.kind !== 'original') return;
		await assertPrivateDirectoryIdentity(lock.lockPath, lock.lockIdentity, 'Private directory lock');
		const { entries, owner } = observation;
		if (!entries.hasRelease) {
			throw new Error('Private directory lock release marker disappeared before release.');
		}
		const currentRelease = await readRelease(lock.lockPath);
		if (!sameRelease(currentRelease, release)) {
			throw new Error('Private directory lock release marker changed before release.');
		}
		const movedPath = path.join(
			lock.parentPath,
			`.released-${path.basename(lock.lockPath)}-${lock.owner.token}-${randomBytes(6).toString('hex')}`,
		);
		await rename(lock.lockPath, movedPath);
		await syncPrivateDirectory(lock.parentPath, 'Private directory lock parent');
		await assertPrivateDirectoryIdentity(movedPath, lock.lockIdentity, 'Released private directory lock');
		const movedOwner = await readOwner(movedPath);
		if (!sameOwner(movedOwner, lock.owner)) {
			throw new Error('Private directory lock ownership changed while being released.');
		}
		const movedRelease = await readRelease(movedPath);
		if (!sameRelease(movedRelease, release)) {
			throw new Error('Private directory lock release marker changed while being released.');
		}
		await removeKnownLockDirectory(movedPath, lock.lockIdentity, {
			hasOwner: true,
			hasRelease: true,
		});
		await assertPrivateDirectoryIdentity(
			lock.parentPath,
			lock.parentIdentity,
			'Private directory lock parent',
		);
		await syncPrivateDirectory(lock.parentPath, 'Private directory lock parent');
	} finally {
		await releaseTransitionGate(lock.parentPath, lock.parentIdentity, gate);
	}
}

type CurrentLockObservation =
	| { kind: 'missing' | 'successor' }
	| {
		kind: 'original';
		entries: LockEntries;
		owner: PrivateDirectoryLockOwner;
	};

/** @internal */
export type PrivateDirectoryLockInstanceClassification = 'original' | 'successor';

/**
 * Classifies an observed lock owner and directory identity. This is exported
 * only from this internal module so the inode-reuse rule can be covered deterministically:
 * the random owner token is the primary instance identity, while dev/ino is a
 * secondary path-replacement check. Release-marker validation deliberately
 * happens only after this function identifies the original owner.
 * @internal
 */
export function classifyPrivateDirectoryLockInstance(
	expectedIdentity: PrivateDirectoryIdentity,
	expectedOwner: PrivateDirectoryLockOwner,
	observedIdentity: PrivateDirectoryIdentity,
	observedOwner: PrivateDirectoryLockOwner,
): PrivateDirectoryLockInstanceClassification {
	const sameObservedOwner = sameOwner(observedOwner, expectedOwner);
	const sameDirectoryIdentity = observedIdentity.dev === expectedIdentity.dev
		&& observedIdentity.ino === expectedIdentity.ino;
	if (!sameObservedOwner) {
		// A successor writes its release marker without holding the transition
		// gate. The prior owner must not inspect that marker: it may be between
		// exclusive create and fsync, and its contents belong to the successor.
		return 'successor';
	}
	if (!sameDirectoryIdentity) {
		throw new Error('Private directory lock owner was copied to a different directory instance.');
	}
	return 'original';
}

/**
 * Observes the main lock while the caller owns the transition gate. Linux may
 * immediately reuse a removed directory inode, so dev/ino equality alone does
 * not prove that the current path is still our lock. A different valid owner
 * token is a legitimate successor that consumed our durable release marker.
 * The prior owner never reads a successor's release marker because that marker
 * may be between exclusive creation and fsync. Malformed or missing owner state
 * and path replacement retaining our token still fail closed.
 */
async function observeCurrentLockUnderGate(
	lock: AcquiredPrivateDirectoryLock,
): Promise<CurrentLockObservation> {
	await assertPrivateDirectoryIdentity(
		lock.parentPath,
		lock.parentIdentity,
		'Private directory lock parent',
	);
	let lockInfo;
	try {
		lockInfo = await lstat(lock.lockPath);
	} catch (error) {
		if (isNodeError(error, 'ENOENT')) return { kind: 'missing' };
		throw error;
	}
	assertPrivateDirectoryStats(lockInfo, 'Private directory lock');
	const observedIdentity = { dev: lockInfo.dev, ino: lockInfo.ino };
	const entries = await readExpectedLockEntries(lock.lockPath, {
		allowOwnerless: false,
		allowRelease: true,
	});
	const owner = await readOwner(lock.lockPath);
	const classification = classifyPrivateDirectoryLockInstance(
		lock.lockIdentity,
		lock.owner,
		observedIdentity,
		owner,
	);
	if (classification === 'successor') return { kind: 'successor' };
	if (entries.hasRelease) {
		const release = await readRelease(lock.lockPath);
		if (release.token !== owner.token) {
			throw new Error('Private directory lock release marker does not match its owner.');
		}
	}
	return { kind: 'original', entries, owner };
}

async function acquireTransitionGate(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	gatePath: string,
	timeoutMs: number,
): Promise<TransitionGate> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const gate = await tryAcquireTransitionGate(parentPath, parentIdentity, gatePath);
		if (gate !== null) return gate;
		try {
			const info = await lstat(gatePath);
			assertPrivateDirectoryStats(info, 'Private directory lock transition gate');
		} catch (error) {
			if (isNodeError(error, 'ENOENT')) continue;
			throw error;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			throw new PrivateDirectoryLockBusyError(
				'Private directory lock transition gate is busy; retry and inspect it if this persists.',
				'transition-gate-busy',
			);
		}
		await delay(Math.min(RELEASE_POLL_INTERVAL_MS, remainingMs));
	}
}

async function discardNewLock(
	parentPath: string,
	parentIdentity: PrivateDirectoryIdentity,
	lockPath: string,
	lockIdentity: PrivateDirectoryIdentity,
): Promise<void> {
	await assertPrivateDirectoryIdentity(parentPath, parentIdentity, 'Private directory lock parent');
	await assertPrivateDirectoryIdentity(lockPath, lockIdentity, 'Private directory lock');
	const entries = await readExpectedLockEntries(lockPath, {
		allowOwnerless: true,
		allowRelease: false,
	});
	const movedPath = path.join(
		parentPath,
		`.failed-${path.basename(lockPath)}-${randomBytes(12).toString('hex')}`,
	);
	await rename(lockPath, movedPath);
	await syncPrivateDirectory(parentPath, 'Private directory lock parent');
	await assertPrivateDirectoryIdentity(movedPath, lockIdentity, 'Failed private directory lock');
	await removeKnownLockDirectory(movedPath, lockIdentity, entries);
	await syncPrivateDirectory(parentPath, 'Private directory lock parent');
}

async function removeKnownLockDirectory(
	directoryPath: string,
	identity: PrivateDirectoryIdentity,
	expected: LockEntries,
): Promise<void> {
	await assertPrivateDirectoryIdentity(directoryPath, identity, 'Private directory lock cleanup');
	const entries = await readExpectedLockEntries(directoryPath, {
		allowOwnerless: !expected.hasOwner,
		allowRelease: expected.hasRelease,
	});
	if (
		entries.hasOwner !== expected.hasOwner
		|| entries.hasRelease !== expected.hasRelease
	) {
		throw new Error('Private directory lock contents changed during cleanup.');
	}
	if (expected.hasOwner) {
		const ownerPath = path.join(directoryPath, OWNER_FILE);
		await assertPrivateFilePath(ownerPath, {
			label: 'Private directory lock owner',
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
		await unlink(ownerPath);
	}
	if (expected.hasRelease) {
		const releasePath = path.join(directoryPath, RELEASE_FILE);
		await assertPrivateFilePath(releasePath, {
			label: 'Private directory lock release marker',
			maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
		});
		await unlink(releasePath);
	}
	await assertPrivateDirectoryIdentity(directoryPath, identity, 'Private directory lock cleanup');
	await rmdir(directoryPath);
}

async function readExpectedLockEntries(
	directoryPath: string,
	options: { allowOwnerless: boolean; allowRelease: boolean },
): Promise<LockEntries> {
	const entries = await readdir(directoryPath, { withFileTypes: true });
	let hasOwner = false;
	let hasRelease = false;
	for (const entry of entries) {
		if (entry.isSymbolicLink() || !entry.isFile()) {
			throw new Error('Private directory lock contains unexpected entries.');
		}
		if (entry.name === OWNER_FILE && !hasOwner) {
			hasOwner = true;
			continue;
		}
		if (entry.name === RELEASE_FILE && options.allowRelease && !hasRelease) {
			hasRelease = true;
			continue;
		}
		throw new Error('Private directory lock contains unexpected entries.');
	}
	if (!hasOwner && !options.allowOwnerless) {
		throw new Error('Private directory lock owner is missing.');
	}
	return { hasOwner, hasRelease };
}

async function readOwner(lockPath: string): Promise<PrivateDirectoryLockOwner> {
	const bytes = await readPrivateFile(path.join(lockPath, OWNER_FILE), {
		label: 'Private directory lock owner',
		minimumBytes: 1,
		maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
	});
	let decoded: unknown;
	try {
		decoded = JSON.parse(bytes.toString('utf8')) as unknown;
	} catch (error) {
		throw new Error('Private directory lock owner is not valid JSON.', { cause: error });
	}
	return parseOwner(decoded);
}

async function readRelease(lockPath: string): Promise<PrivateDirectoryLockRelease> {
	const bytes = await readPrivateFile(path.join(lockPath, RELEASE_FILE), {
		label: 'Private directory lock release marker',
		minimumBytes: 1,
		maximumBytes: MAXIMUM_LOCK_STATE_BYTES,
	});
	let decoded: unknown;
	try {
		decoded = JSON.parse(bytes.toString('utf8')) as unknown;
	} catch (error) {
		throw new Error('Private directory lock release marker is not valid JSON.', { cause: error });
	}
	return parseRelease(decoded);
}

function parseOwner(value: unknown): PrivateDirectoryLockOwner {
	if (!isRecord(value)) throw new Error('Private directory lock owner is invalid.');
	const keys = Object.keys(value).sort();
	if (keys.join('\0') !== ['createdAt', 'pid', 'schemaVersion', 'token'].join('\0')) {
		throw new Error('Private directory lock owner fields are invalid.');
	}
	if (
		value.schemaVersion !== PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION
		|| !Number.isSafeInteger(value.pid)
		|| (value.pid as number) <= 0
		|| typeof value.token !== 'string'
		|| !TOKEN_PATTERN.test(value.token)
		|| typeof value.createdAt !== 'string'
		|| !Number.isFinite(Date.parse(value.createdAt))
	) throw new Error('Private directory lock owner values are invalid.');
	return value as unknown as PrivateDirectoryLockOwner;
}

function parseRelease(value: unknown): PrivateDirectoryLockRelease {
	if (!isRecord(value)) throw new Error('Private directory lock release marker is invalid.');
	const keys = Object.keys(value).sort();
	if (keys.join('\0') !== ['releasedAt', 'schemaVersion', 'token'].join('\0')) {
		throw new Error('Private directory lock release marker fields are invalid.');
	}
	if (
		value.schemaVersion !== PRIVATE_DIRECTORY_LOCK_SCHEMA_VERSION
		|| typeof value.token !== 'string'
		|| !TOKEN_PATTERN.test(value.token)
		|| typeof value.releasedAt !== 'string'
		|| !Number.isFinite(Date.parse(value.releasedAt))
	) throw new Error('Private directory lock release marker values are invalid.');
	return value as unknown as PrivateDirectoryLockRelease;
}

function sameOwner(first: PrivateDirectoryLockOwner, second: PrivateDirectoryLockOwner): boolean {
	return first.schemaVersion === second.schemaVersion
		&& first.pid === second.pid
		&& first.token === second.token
		&& first.createdAt === second.createdAt;
}

function sameRelease(
	first: PrivateDirectoryLockRelease,
	second: PrivateDirectoryLockRelease,
): boolean {
	return first.schemaVersion === second.schemaVersion
		&& first.token === second.token
		&& first.releasedAt === second.releasedAt;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (isNodeError(error, 'ESRCH')) return false;
		if (isNodeError(error, 'EPERM')) return true;
		throw error;
	}
}

function safeLockPath(value: string): string {
	if (!value || value.includes('\0')) throw new TypeError('Private directory lock path is invalid.');
	const resolved = path.resolve(value);
	if (resolved === path.parse(resolved).root) {
		throw new TypeError('Private directory lock path must not be a filesystem root.');
	}
	return resolved;
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return candidate;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return (error as NodeJS.ErrnoException).code === code;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
