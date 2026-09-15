import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, type FileHandle } from 'node:fs/promises';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DIRECTORY_FLAG = constants.O_DIRECTORY ?? 0;
const POSIX_PERMISSION_MASK = 0o7777;
const PRIVATE_FILE_ALLOWED_MODE = 0o600;

export interface PrivateDirectoryIdentity {
	dev: number;
	ino: number;
}

export interface PrivateDirectory {
	path: string;
	identity: PrivateDirectoryIdentity;
}

export interface PrivateFileOptions {
	label: string;
	maximumBytes?: number;
	minimumBytes?: number;
}

/** A bounded private file changed between two identity/length observations. */
export class PrivateFileChangedError extends Error {
	readonly code = 'PRIVATE_FILE_CHANGED' as const;

	constructor(message: string) {
		super(message);
		this.name = 'PrivateFileChangedError';
	}
}

/**
 * POSIX boundary: private directories are owned by the effective user and have
 * no group/other permission bits; private files additionally have no execute or
 * special bits. Windows has no equivalent owner/mode ACL guarantee in Node's
 * portable fs API, so only real-entry, single-link, bounded, stable-identity
 * checks are enforced there. Windows deployment must protect the state root
 * with an OS ACL outside this module.
 */
export function assertPrivateDirectoryStats(info: Stats, label: string): void {
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error(`${label} must be a real directory.`);
	}
	if (process.platform === 'win32') return;
	const currentUid = currentPosixUid();
	if (info.uid !== currentUid) throw new Error(`${label} must be owned by the current user.`);
	if ((info.mode & 0o077) !== 0) {
		throw new Error(`${label} must not be accessible to group or other users.`);
	}
}

export function assertPrivateRegularFileStats(
	info: Stats,
	options: PrivateFileOptions,
): void {
	if (!info.isFile() || info.isSymbolicLink()) {
		throw new Error(`${options.label} must be a real regular file.`);
	}
	if (info.nlink !== 1) throw new Error(`${options.label} must have exactly one hard link.`);
	if (
		options.maximumBytes !== undefined
		&& (!Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 0)
	) throw new TypeError('maximumBytes must be a non-negative safe integer.');
	if (
		options.minimumBytes !== undefined
		&& (!Number.isSafeInteger(options.minimumBytes) || options.minimumBytes < 0)
	) throw new TypeError('minimumBytes must be a non-negative safe integer.');
	if (options.maximumBytes !== undefined && info.size > options.maximumBytes) {
		throw new Error(`${options.label} exceeds its private file size limit.`);
	}
	if (options.minimumBytes !== undefined && info.size < options.minimumBytes) {
		throw new Error(`${options.label} is smaller than its required private file size.`);
	}
	if (process.platform === 'win32') return;
	const currentUid = currentPosixUid();
	if (info.uid !== currentUid) throw new Error(`${options.label} must be owned by the current user.`);
	const permissions = info.mode & POSIX_PERMISSION_MASK;
	if ((permissions & ~PRIVATE_FILE_ALLOWED_MODE) !== 0) {
		throw new Error(`${options.label} permissions must be 0600 or stricter.`);
	}
}

export async function ensurePrivateDirectory(
	directoryPath: string,
	label: string,
): Promise<PrivateDirectory> {
	await mkdir(directoryPath, { recursive: true, mode: 0o700 });
	const configuredInfo = await lstat(directoryPath);
	assertPrivateDirectoryStats(configuredInfo, label);
	const canonicalPath = await realpath(directoryPath);
	const canonicalInfo = await lstat(canonicalPath);
	assertPrivateDirectoryStats(canonicalInfo, label);
	return {
		path: canonicalPath,
		identity: { dev: canonicalInfo.dev, ino: canonicalInfo.ino },
	};
}

export async function assertPrivateDirectoryIdentity(
	directoryPath: string,
	expected: PrivateDirectoryIdentity,
	label: string,
): Promise<void> {
	const info = await lstat(directoryPath);
	assertPrivateDirectoryStats(info, label);
	if (info.dev !== expected.dev || info.ino !== expected.ino) {
		throw new Error(`${label} identity changed.`);
	}
}

export async function assertPrivateFileHandle(
	handle: FileHandle,
	options: PrivateFileOptions,
): Promise<Stats> {
	const info = await handle.stat();
	assertPrivateRegularFileStats(info, options);
	return info;
}

export async function assertPrivateFilePath(
	filePath: string,
	options: PrivateFileOptions,
): Promise<Stats> {
	const pathInfo = await lstat(filePath);
	assertPrivateRegularFileStats(pathInfo, options);
	const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
	try {
		const handleInfo = await assertPrivateFileHandle(handle, options);
		assertStableFileIdentity(pathInfo, handleInfo, options.label);
		const finalPathInfo = await lstat(filePath);
		assertPrivateRegularFileStats(finalPathInfo, options);
		assertStableFileIdentity(handleInfo, finalPathInfo, options.label);
		return handleInfo;
	} finally {
		await handle.close();
	}
}

export async function readPrivateFile(
	filePath: string,
	options: PrivateFileOptions,
): Promise<Buffer> {
	const pathBefore = await lstat(filePath);
	assertPrivateRegularFileStats(pathBefore, options);
	const handle = await open(filePath, constants.O_RDONLY | NO_FOLLOW);
	try {
		const before = await assertPrivateFileHandle(handle, options);
		assertStableFileIdentity(pathBefore, before, options.label);
		const bytes = await handle.readFile();
		const after = await assertPrivateFileHandle(handle, options);
		assertStableFileIdentity(before, after, options.label);
		if (bytes.byteLength !== after.size) {
			throw new PrivateFileChangedError(`${options.label} changed length while being read.`);
		}
		const pathAfter = await lstat(filePath);
		assertPrivateRegularFileStats(pathAfter, options);
		assertStableFileIdentity(after, pathAfter, options.label);
		return bytes;
	} finally {
		await handle.close();
	}
}

export function assertStableFileIdentity(first: Stats, second: Stats, label: string): void {
	if (
		first.dev !== second.dev
		|| first.ino !== second.ino
		|| first.size !== second.size
		|| first.mtimeMs !== second.mtimeMs
		|| first.ctimeMs !== second.ctimeMs
	) throw new PrivateFileChangedError(`${label} changed while being accessed.`);
}

export async function syncPrivateDirectory(
	directoryPath: string,
	label: string,
): Promise<void> {
	const pathInfo = await lstat(directoryPath);
	assertPrivateDirectoryStats(pathInfo, label);
	let handle;
	try {
		handle = await open(
			directoryPath,
			constants.O_RDONLY | DIRECTORY_FLAG | NO_FOLLOW,
		);
		const handleInfo = await handle.stat();
		assertPrivateDirectoryStats(handleInfo, label);
		if (handleInfo.dev !== pathInfo.dev || handleInfo.ino !== pathInfo.ino) {
			throw new Error(`${label} changed while being opened.`);
		}
		try {
			await handle.sync();
		} catch (error) {
			if (!isUnsupportedWindowsDirectorySync(error)) throw error;
		}
	} finally {
		await handle?.close();
	}
}

function currentPosixUid(): number {
	if (typeof process.getuid !== 'function') {
		throw new Error('Current-user ownership cannot be verified on this POSIX runtime.');
	}
	return process.getuid();
}

function isUnsupportedWindowsDirectorySync(error: unknown): boolean {
	return process.platform === 'win32'
		&& ['EINVAL', 'EBADF', 'ENOTSUP', 'EPERM'].includes(
			(error as NodeJS.ErrnoException).code ?? '',
		);
}
