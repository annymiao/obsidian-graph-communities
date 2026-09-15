import type {
	HybridRecord,
	HybridRetrievalScope,
	HybridVisibilityScope,
	TemporalConstraint,
} from './types.js';

const MODE_SCOPES: Readonly<Record<HybridVisibilityScope['mode'], ReadonlySet<HybridRetrievalScope>>> = {
	default: new Set(['default']),
	project: new Set(['default', 'project']),
	reference: new Set(['default', 'reference']),
	history: new Set(['default', 'history']),
};

function normalizePath(value: string): string | null {
	if (
		value.includes('\u0000')
		|| value.startsWith('/')
		|| value.startsWith('\\')
		|| /^[a-z]:[\\/]/iu.test(value)
	) return null;
	const segments: string[] = [];
	for (const segment of value.replaceAll('\\', '/').split('/')) {
		if (segment.length === 0 || segment === '.') continue;
		if (segment === '..') return null;
		// Path ACLs must follow the same case-sensitive, NFC-preserving identity
		// used by normalizeDocumentPath. Folding case or compatibility characters
		// can grant access to a distinct path on a case-sensitive filesystem.
		segments.push(segment.normalize('NFC'));
	}
	return segments.join('/');
}

function pathMatchesPrefix(normalizedPath: string, normalizedPrefix: string): boolean {
	if (normalizedPrefix.length === 0) return true;
	return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function normalizePrefixes(prefixes: readonly string[] | undefined): readonly string[] | null | undefined {
	if (prefixes === undefined) return undefined;
	const normalized: string[] = [];
	for (const prefix of prefixes) {
		const value = normalizePath(prefix);
		if (value === null) return null;
		normalized.push(value);
	}
	return normalized;
}

/**
 * Applies the exact path-filter semantics shared by read and controlled-write
 * authorization. Invalid or escaping paths/prefixes fail closed.
 */
export function isPathAllowedByPrefixes(
	pathValue: string,
	includedPathPrefixes?: readonly string[],
	excludedPathPrefixes?: readonly string[],
): boolean {
	const normalizedPath = normalizePath(pathValue);
	const includedPrefixes = normalizePrefixes(includedPathPrefixes);
	const excludedPrefixes = normalizePrefixes(excludedPathPrefixes);
	if (normalizedPath === null || includedPrefixes === null || excludedPrefixes === null) return false;
	if (
		includedPrefixes !== undefined
		&& !includedPrefixes.some((prefix) => pathMatchesPrefix(normalizedPath, prefix))
	) return false;
	return excludedPrefixes?.some((prefix) => pathMatchesPrefix(normalizedPath, prefix)) !== true;
}

export type VisibilityPredicate = (record: HybridRecord) => boolean;

/** Explicit after/before bounds are authorization-like hard filters. */
export function isRecordWithinTemporalBounds(
	record: HybridRecord,
	constraint: TemporalConstraint | undefined,
): boolean {
	if (constraint === undefined) return true;
	const { after, before } = constraint;
	if (after === undefined && before === undefined) return true;
	if (
		(after !== undefined && !Number.isFinite(after))
		|| (before !== undefined && !Number.isFinite(before))
		|| (after !== undefined && before !== undefined && after > before)
		|| !Number.isFinite(record.modifiedAt)
	) return false;
	const modifiedAt = record.modifiedAt as number;
	if (after !== undefined && modifiedAt < after) return false;
	if (before !== undefined && modifiedAt > before) return false;
	return true;
}

export function createVisibilityPredicate(scope: HybridVisibilityScope): VisibilityPredicate {
	const allowedSources = scope.allowedSourceIds === undefined ? null : new Set(scope.allowedSourceIds);
	const allowedProjects = scope.allowedProjectIds === undefined ? null : new Set(scope.allowedProjectIds);
	const allowedScopes = MODE_SCOPES[scope.mode];
	return (record: HybridRecord): boolean => {
		if (!isPathAllowedByPrefixes(
			record.path,
			scope.includedPathPrefixes,
			scope.excludedPathPrefixes,
		)) return false;
		if (record.retrievalScope === 'never' || !allowedScopes.has(record.retrievalScope)) return false;
		if (allowedSources !== null && !allowedSources.has(record.sourceId)) return false;
		// Project identity is an authorization boundary in its own right.  Do not
		// rely on retrievalScope being internally consistent: a malformed or
		// tampered artifact carrying projectId + default must still fail closed.
		if (record.projectId !== undefined) {
			if (allowedProjects === null || !allowedProjects.has(record.projectId)) return false;
		} else if (record.retrievalScope === 'project') {
			return false;
		}
		return true;
	};
}

export function isRecordVisible(record: HybridRecord, scope: HybridVisibilityScope): boolean {
	return createVisibilityPredicate(scope)(record);
}

export function visibleRecords(
	records: readonly HybridRecord[],
	scope: HybridVisibilityScope,
): HybridRecord[] {
	return records.filter(createVisibilityPredicate(scope));
}
