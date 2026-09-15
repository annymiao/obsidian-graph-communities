import { constants, type Stats } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { sha256Bytes } from '../persistence/canonicalJson.js';
import { normalizeDocumentPath } from '../stableIds.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const DEFAULT_IGNORED_DIRECTORIES = [
	'.agents',
	'.codex',
	'.git',
	'.github',
	'.obsidian',
	'.trash',
	'Backups',
	'backups',
	'build',
	'dist',
	'node_modules',
];

export interface SourceScanPolicy {
	extensions: string[];
	ignoredDirectoryNames: string[];
	ignoredPathPrefixes: string[];
	maximumFileBytes: number;
	maximumFiles: number;
}

export interface ScannedSourceFile {
	path: string;
	absolutePath: string;
	content: string;
	contentSha256: string;
	normalizedContentSha256: string;
	byteLength: number;
	mtimeMs: number;
}

export interface SourceScanResult {
	files: ScannedSourceFile[];
	skippedSymlinks: number;
}

export function createDefaultScanPolicy(): SourceScanPolicy {
	return {
		extensions: ['.md'],
		ignoredDirectoryNames: [...DEFAULT_IGNORED_DIRECTORIES],
		ignoredPathPrefixes: [],
		maximumFileBytes: 8 * 1024 * 1024,
		maximumFiles: 100_000,
	};
}

export async function scanSourceDirectory(
	configuredRoot: string,
	policy: SourceScanPolicy,
): Promise<SourceScanResult> {
	validateScanPolicy(policy);
	const resolvedRoot = path.resolve(configuredRoot);
	if (resolvedRoot === path.parse(resolvedRoot).root) throw new Error('Source root must not be a filesystem root.');
	const rootBefore = await lstat(resolvedRoot);
	if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) {
		throw new Error('Source root must be a real directory, not a symlink.');
	}
	const canonicalRoot = await realpath(resolvedRoot);
	const canonicalRootStat = await lstat(canonicalRoot);
	if (canonicalRootStat.isSymbolicLink() || !canonicalRootStat.isDirectory()) {
		throw new Error('Canonical source root is unsafe.');
	}
	const ignored = new Set(policy.ignoredDirectoryNames.map(normalizeDirectoryKey));
	const ignoredPathPrefixes = policy.ignoredPathPrefixes.map(normalizeIgnoredPathPrefix);
	const extensions = new Set(policy.extensions.map((extension) => extension.toLowerCase()));
	const listed: Array<{ absolutePath: string; relativePath: string }> = [];
	let skippedSymlinks = 0;

	async function walk(directoryPath: string, relativeDirectory: string): Promise<void> {
		const before = await lstat(directoryPath);
		if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('Source directory changed during scan.');
		const entries = await readdir(directoryPath, { withFileTypes: true });
		for (const entry of entries.sort((first, second) => first.name.localeCompare(second.name))) {
			if (entry.name.startsWith('._')) continue;
			const absolutePath = path.join(directoryPath, entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			if (isIgnoredRelativePath(relativePath, ignoredPathPrefixes)) continue;
			if (entry.isSymbolicLink()) {
				skippedSymlinks += 1;
				continue;
			}
			if (entry.isDirectory()) {
				if (!ignored.has(normalizeDirectoryKey(entry.name))) await walk(absolutePath, relativePath);
				continue;
			}
			if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
			if (listed.length >= policy.maximumFiles) throw new Error('Source scan exceeds maximumFiles.');
			listed.push({ absolutePath, relativePath: normalizeDocumentPath(relativePath) });
		}
		const after = await lstat(directoryPath);
		assertSameIdentity(before, after, 'Source directory changed during scan.');
	}

	await walk(canonicalRoot, '');
	const files: ScannedSourceFile[] = [];
	const seenPaths = new Set<string>();
	for (const listedFile of listed.sort((first, second) => first.relativePath.localeCompare(second.relativePath))) {
		if (seenPaths.has(listedFile.relativePath)) throw new Error(`Duplicate normalized source path: ${listedFile.relativePath}`);
		seenPaths.add(listedFile.relativePath);
		files.push(await readStableSourceFile(listedFile.absolutePath, listedFile.relativePath, policy.maximumFileBytes));
	}
	const rootAfter = await lstat(canonicalRoot);
	assertSameIdentity(rootBefore, rootAfter, 'Source root changed during scan.');
	return { files, skippedSymlinks };
}

async function readStableSourceFile(
	absolutePath: string,
	relativePath: string,
	maximumBytes: number,
): Promise<ScannedSourceFile> {
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		try {
			const before = await lstat(absolutePath);
			if (before.isSymbolicLink() || !before.isFile()) throw new Error(`Unsafe source file: ${relativePath}`);
			if (before.size > maximumBytes) throw new Error(`Source file exceeds maximumFileBytes: ${relativePath}`);
			const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW);
			try {
				const opened = await handle.stat();
				assertSameIdentity(before, opened, `Source file changed while opening: ${relativePath}`);
				const bytes = await handle.readFile();
				const after = await handle.stat();
				assertSameIdentity(opened, after, `Source file changed while reading: ${relativePath}`);
				if (bytes.byteLength !== after.size || bytes.byteLength > maximumBytes) {
					throw new Error(`Source file size changed while reading: ${relativePath}`);
				}
				const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
				const normalized = normalizeMarkdown(content);
				return {
					path: relativePath,
					absolutePath,
					content,
					contentSha256: sha256Bytes(bytes),
					normalizedContentSha256: sha256Bytes(Buffer.from(normalized, 'utf8')),
					byteLength: bytes.byteLength,
					mtimeMs: after.mtimeMs,
				};
			} finally {
				await handle.close();
			}
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error(`Unable to obtain a stable source snapshot for ${relativePath}.`, {
		cause: lastError,
	});
}

function validateScanPolicy(policy: SourceScanPolicy): void {
	if (!Array.isArray(policy.extensions) || policy.extensions.length === 0) {
		throw new TypeError('At least one source extension is required.');
	}
	for (const extension of policy.extensions) {
		if (!/^\.[A-Za-z0-9]+$/u.test(extension)) throw new TypeError(`Invalid source extension: ${extension}`);
	}
	for (const name of policy.ignoredDirectoryNames) {
		if (!name || name.includes('/') || name.includes('\\') || name.includes('\0')) {
			throw new TypeError('Ignored directory names must be single safe path segments.');
		}
	}
	for (const prefix of policy.ignoredPathPrefixes) normalizeIgnoredPathPrefix(prefix);
	if (!Number.isSafeInteger(policy.maximumFileBytes) || policy.maximumFileBytes <= 0) {
		throw new TypeError('maximumFileBytes must be a positive safe integer.');
	}
	if (!Number.isSafeInteger(policy.maximumFiles) || policy.maximumFiles <= 0) {
		throw new TypeError('maximumFiles must be a positive safe integer.');
	}
}

function assertSameIdentity(first: Stats, second: Stats, message: string): void {
	if (
		first.dev !== second.dev
		|| first.ino !== second.ino
		|| first.size !== second.size
		|| first.mtimeMs !== second.mtimeMs
		|| first.ctimeMs !== second.ctimeMs
	) {
		throw new Error(message);
	}
}

function normalizeMarkdown(content: string): string {
	const withoutBom = content.startsWith('\uFEFF') ? content.slice(1) : content;
	return withoutBom.replace(/\r\n?/gu, '\n').normalize('NFC');
}

function normalizeDirectoryKey(value: string): string {
	// Directory policy matching is deliberately locale-invariant. NFKC also
	// closes compatibility-character aliases such as full-width control names.
	return value.normalize('NFKC').toLowerCase();
}

function normalizeIgnoredPathPrefix(value: string): string {
	if (!value || value.includes('\0')) throw new TypeError('Ignored path prefixes must be non-empty relative paths.');
	const portable = value.normalize('NFKC').replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
	if (portable.startsWith('/') || /^[A-Za-z]:/u.test(portable)) {
		throw new TypeError('Ignored path prefixes must be relative.');
	}
	const segments = portable.split('/').filter(Boolean);
	if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) {
		throw new TypeError('Ignored path prefixes must not traverse or contain empty control paths.');
	}
	return segments.join('/').toLowerCase();
}

function isIgnoredRelativePath(relativePath: string, prefixes: readonly string[]): boolean {
	const normalized = relativePath.normalize('NFKC').replace(/\\/gu, '/').replace(/\/{2,}/gu, '/').toLowerCase();
	return prefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}
