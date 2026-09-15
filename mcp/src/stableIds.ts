import { createHash } from 'node:crypto';

export const STABLE_ID_SCHEME_VERSION = 'v1' as const;

export type SourceId = `src_${typeof STABLE_ID_SCHEME_VERSION}_${string}`;
export type DocumentId = `doc_${typeof STABLE_ID_SCHEME_VERSION}_${string}`;
export type VersionId = `ver_${typeof STABLE_ID_SCHEME_VERSION}_${string}`;
export type SpanId = `spn_${typeof STABLE_ID_SCHEME_VERSION}_${string}`;
export type ChunkId = `chk_${typeof STABLE_ID_SCHEME_VERSION}_${string}`;

export type VersionMaterial =
	| { content: string; version?: never }
	| { version: string; content?: never };

export interface SourceSpan {
	/** One-based, inclusive line number. */
	startLine: number;
	/** One-based, inclusive line number. */
	endLine: number;
	/** Optional one-based, inclusive UTF-16 column; both columns must be supplied together. */
	startColumn?: number;
	/** Optional one-based, inclusive UTF-16 column; both columns must be supplied together. */
	endColumn?: number;
}

type IdKind = 'source' | 'document' | 'version' | 'span' | 'chunk';
type IdPrefix = 'src' | 'doc' | 'ver' | 'spn' | 'chk';

const ID_NAMESPACE = 'obsidian-knowledge-gateway/stable-id';
const DIGEST_PATTERN = '[A-Za-z0-9_-]{43}';
const PREFIX_BY_KIND: Record<IdKind, IdPrefix> = {
	source: 'src',
	document: 'doc',
	version: 'ver',
	span: 'spn',
	chunk: 'chk',
};

/**
 * Produces canonical hash material for a logical source.
 *
 * This value can still contain a private locator, including an absolute path. It
 * is intentionally separate from SourceId and must not be exposed outside the
 * local indexing boundary.
 */
export function normalizeSourceIdentity(identity: string): string {
	const normalized = normalizeRequiredText(identity, 'source identity');
	const portable = stripWindowsDevicePrefix(normalized.replace(/\\/gu, '/'));

	if (/^[A-Za-z]:\//u.test(portable)) {
		const drive = portable.slice(0, 2).toLowerCase();
		const segments = collapseSegments(portable.slice(2), true)
			.join('/')
			.toLowerCase()
			.normalize('NFC');
		return `win32:${drive}/${segments}`.replace(/\/$/u, segments ? '' : '/');
	}

	if (portable.startsWith('//')) {
		const segments = collapseSegments(portable.slice(2), true)
			.join('/')
			.toLowerCase()
			.normalize('NFC');
		if (!segments) throw new TypeError('source identity must include a UNC host');
		return `win32-unc://${segments}`;
	}

	if (portable.startsWith('/')) {
		const segments = collapseSegments(portable, true).join('/');
		return `posix:/${segments}`.replace(/\/$/u, segments ? '' : '/');
	}

	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(normalized)) {
		let url: URL;
		try {
			url = new URL(normalized);
		} catch {
			throw new TypeError('source identity contains an invalid URL');
		}
		return `uri:${url.href}`;
	}

	const logical = collapseSegments(portable, false).join('/');
	if (!logical || logical === '.') {
		throw new TypeError('source identity must not be empty');
	}
	return `logical:${logical}`;
}

/** Canonicalizes a Vault-relative document path without consulting the host OS. */
export function normalizeDocumentPath(documentPath: string): string {
	const normalized = normalizeRequiredText(documentPath, 'document path');
	const portable = normalized.replace(/\\/gu, '/');
	if (
		portable.startsWith('/')
		|| portable.startsWith('//')
		|| /^[A-Za-z]:/u.test(portable)
	) {
		throw new TypeError('document path must be relative to its source');
	}

	const segments = collapseSegments(portable, false);
	if (segments.includes('..')) {
		throw new TypeError('document path must not escape its source');
	}
	const result = segments.join('/');
	if (!result || result === '.') {
		throw new TypeError('document path must identify a document');
	}
	return result;
}

/** Returns an opaque public ID; the source locator is never embedded in it. */
export function createSourceId(sourceIdentity: string): SourceId {
	return makeId('source', [normalizeSourceIdentity(sourceIdentity)]) as SourceId;
}

/** A document remains stable while its source and normalized relative path do. */
export function createDocumentId(
	sourceId: SourceId,
	documentPath: string,
): DocumentId {
	assertStableId(sourceId, 'src', 'source ID');
	return makeId('document', [sourceId, normalizeDocumentPath(documentPath)]) as DocumentId;
}

/**
 * Identifies a document revision by canonical Markdown content or by an opaque
 * connector-provided version. Exactly one form must be supplied.
 */
export function createVersionId(
	documentId: DocumentId,
	material: VersionMaterial,
): VersionId {
	assertStableId(documentId, 'doc', 'document ID');
	const hasContent = Object.prototype.hasOwnProperty.call(material, 'content');
	const hasVersion = Object.prototype.hasOwnProperty.call(material, 'version');
	if (hasContent === hasVersion) {
		throw new TypeError('version identity requires exactly one of content or version');
	}

	if (hasContent) {
		if (typeof material.content !== 'string') {
			throw new TypeError('version content must be a string');
		}
		return makeId('version', [
			documentId,
			'content',
			normalizeMarkdownContent(material.content),
		]) as VersionId;
	}

	if (typeof material.version !== 'string') {
		throw new TypeError('external version must be a string');
	}
	const version = normalizeRequiredText(material.version, 'external version');
	return makeId('version', [documentId, 'external-version', version]) as VersionId;
}

/** A span is stable only within the immutable document version it references. */
export function createSpanId(versionId: VersionId, span: SourceSpan): SpanId {
	assertStableId(versionId, 'ver', 'version ID');
	validateSpan(span);
	return makeId('span', [
		versionId,
		String(span.startLine),
		String(span.endLine),
		span.startColumn === undefined ? '-' : String(span.startColumn),
		span.endColumn === undefined ? '-' : String(span.endColumn),
	]) as SpanId;
}

/**
 * Includes both its source span and canonical content so repeated text at
 * different locations cannot collide.
 */
export function createChunkId(spanId: SpanId, content: string): ChunkId {
	assertStableId(spanId, 'spn', 'span ID');
	if (typeof content !== 'string' || content.length === 0) {
		throw new TypeError('chunk content must be a non-empty string');
	}
	return makeId('chunk', [spanId, normalizeMarkdownContent(content)]) as ChunkId;
}

function normalizeRequiredText(value: string, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
	if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL`);
	return value.normalize('NFC');
}

function normalizeMarkdownContent(content: string): string {
	const withoutByteOrderMark = content.startsWith('\uFEFF') ? content.slice(1) : content;
	return withoutByteOrderMark.replace(/\r\n?/gu, '\n').normalize('NFC');
}

function stripWindowsDevicePrefix(value: string): string {
	if (/^\/\/\?\/UNC\//iu.test(value)) return `//${value.slice(8)}`;
	if (/^\/\/[?.]\//u.test(value)) return value.slice(4);
	return value;
}

function collapseSegments(value: string, absolute: boolean): string[] {
	const result: string[] = [];
	for (const segment of value.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') {
			if (result.length > 0 && result.at(-1) !== '..') {
				result.pop();
			} else if (!absolute) {
				result.push(segment);
			}
			continue;
		}
		result.push(segment);
	}
	return result;
}

function validateSpan(span: SourceSpan): void {
	assertPositiveInteger(span.startLine, 'span startLine');
	assertPositiveInteger(span.endLine, 'span endLine');
	if (span.endLine < span.startLine) {
		throw new RangeError('span endLine must not precede startLine');
	}

	const { startColumn, endColumn } = span;
	const hasStartColumn = startColumn !== undefined;
	const hasEndColumn = endColumn !== undefined;
	if (hasStartColumn !== hasEndColumn) {
		throw new TypeError('span columns must be supplied together');
	}
	if (!hasStartColumn || !hasEndColumn) return;
	assertPositiveInteger(startColumn, 'span startColumn');
	assertPositiveInteger(endColumn, 'span endColumn');
	if (span.startLine === span.endLine && endColumn < startColumn) {
		throw new RangeError('span endColumn must not precede startColumn on one line');
	}
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${label} must be a positive safe integer`);
	}
}

function assertStableId(value: string, prefix: IdPrefix, label: string): void {
	const pattern = new RegExp(`^${prefix}_${STABLE_ID_SCHEME_VERSION}_${DIGEST_PATTERN}$`, 'u');
	if (typeof value !== 'string' || !pattern.test(value)) {
		throw new TypeError(`${label} is not a ${prefix} ${STABLE_ID_SCHEME_VERSION} ID`);
	}
}

function makeId(kind: IdKind, parts: readonly string[]): string {
	const hash = createHash('sha256');
	hash.update(ID_NAMESPACE, 'utf8');
	hash.update('\0', 'utf8');
	hash.update(STABLE_ID_SCHEME_VERSION, 'utf8');
	hash.update('\0', 'utf8');
	hash.update(kind, 'utf8');

	for (const part of parts) {
		const bytes = Buffer.from(part, 'utf8');
		const length = Buffer.allocUnsafe(4);
		length.writeUInt32BE(bytes.length);
		hash.update(length);
		hash.update(bytes);
	}

	return `${PREFIX_BY_KIND[kind]}_${STABLE_ID_SCHEME_VERSION}_${hash.digest('base64url')}`;
}
