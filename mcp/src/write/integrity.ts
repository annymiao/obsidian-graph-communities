import { createHash } from 'node:crypto';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function sha256(value: string | Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export function assertSha256(value: string, label: string): void {
	if (!SHA256_PATTERN.test(value)) {
		throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
	}
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON rejects non-finite numbers.');
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort((first, second) => first.localeCompare(second))) {
			const item = record[key];
			if (item !== undefined) result[key] = canonicalize(item);
		}
		return result;
	}
	throw new TypeError(`Canonical JSON rejects ${typeof value}.`);
}

export function assertNonEmptyText(value: string, label: string, maximum = 4_096): void {
	if (typeof value !== 'string' || value.trim().length === 0) {
		throw new TypeError(`${label} must be a non-empty string.`);
	}
	if (value.includes('\0')) throw new TypeError(`${label} must not contain NUL.`);
	if (Buffer.byteLength(value, 'utf8') > maximum) {
		throw new RangeError(`${label} exceeds ${maximum} UTF-8 bytes.`);
	}
}

export function assertIsoTimestamp(value: string, label: string): void {
	if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
		throw new TypeError(`${label} must be an ISO timestamp.`);
	}
}
