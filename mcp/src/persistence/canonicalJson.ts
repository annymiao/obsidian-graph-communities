import { createHash } from 'node:crypto';

export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJsonValue(value));
}

export function sha256Text(value: string): string {
	return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function sha256Bytes(value: Uint8Array): string {
	return createHash('sha256').update(value).digest('hex');
}

export function hashCanonicalJson(value: unknown): string {
	return sha256Text(canonicalJson(value));
}

function sortJsonValue(value: unknown): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new TypeError('Canonical JSON cannot contain non-finite numbers.');
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => sortJsonValue(item));
	if (typeof value !== 'object') {
		throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
	}

	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort((first, second) => first.localeCompare(second))) {
		const item = (value as Record<string, unknown>)[key];
		if (item === undefined) throw new TypeError('Canonical JSON cannot contain undefined values.');
		result[key] = sortJsonValue(item);
	}
	return result;
}
