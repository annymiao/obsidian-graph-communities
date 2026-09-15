import {
	COMPACT_LEXICAL_SCHEMA_VERSION,
	type CompactLexicalArtifact,
	type CompactLexicalDelta,
	type CompactPostingIndex,
} from './artifactTypes.js';

export interface LexicalDocumentInput {
	ordinal: number;
	termFrequencies: ReadonlyMap<string, number> | ReadonlyArray<readonly [string, number]>;
	documentLength: number;
}

export interface MaterializedLexicalIndex {
	postings: Map<string, Map<number, number>>;
	documentLengths: Map<number, number>;
}

export function buildCompactPostingIndex(
	documents: readonly LexicalDocumentInput[],
): CompactPostingIndex {
	const sortedDocuments = [...documents].sort((first, second) => first.ordinal - second.ordinal);
	const postings = new Map<string, Array<[number, number]>>();
	let totalLength = 0;
	let lastOrdinal = -1;
	const lengths: number[] = [];

	for (const document of sortedDocuments) {
		assertNonNegativeInteger(document.ordinal, 'document ordinal');
		assertNonNegativeInteger(document.documentLength, 'document length');
		if (document.ordinal === lastOrdinal) throw new TypeError('Document ordinals must be unique.');
		lastOrdinal = document.ordinal;
		totalLength += document.documentLength;
		lengths.push(document.ordinal, document.documentLength);
		const terms = document.termFrequencies instanceof Map
			? [...document.termFrequencies.entries()]
			: [...document.termFrequencies];
		for (const [term, frequency] of terms) {
			if (!term) throw new TypeError('Lexical terms must not be empty.');
			if (!Number.isSafeInteger(frequency) || frequency <= 0) {
				throw new TypeError('Term frequencies must be positive safe integers.');
			}
			const list = postings.get(term) ?? [];
			list.push([document.ordinal, frequency]);
			postings.set(term, list);
		}
	}

	const dictionary = [...postings.keys()].sort((first, second) => first.localeCompare(second));
	const postingOffsets: number[] = [0];
	const postingBytes: number[] = [];
	for (const term of dictionary) {
		let previousOrdinal = 0;
		for (const [ordinal, frequency] of postings.get(term) ?? []) {
			encodeUnsignedVarint(ordinal - previousOrdinal, postingBytes);
			encodeUnsignedVarint(frequency, postingBytes);
			previousOrdinal = ordinal;
		}
		postingOffsets.push(postingBytes.length);
	}

	return {
		schemaVersion: COMPACT_LEXICAL_SCHEMA_VERSION,
		dictionary,
		postingOffsets,
		postingsBase64: Buffer.from(postingBytes).toString('base64'),
		documentLengthsBase64: Buffer.from(encodeIntegerSequence(lengths)).toString('base64'),
		documentCount: sortedDocuments.length,
		averageDocumentLength: sortedDocuments.length === 0 ? 0 : totalLength / sortedDocuments.length,
	};
}

export function decodeCompactPostingIndex(index: CompactPostingIndex): MaterializedLexicalIndex {
	validateCompactPostingIndex(index);
	const postingsBytes = Buffer.from(index.postingsBase64, 'base64');
	const postings = new Map<string, Map<number, number>>();
	for (let termIndex = 0; termIndex < index.dictionary.length; termIndex += 1) {
		const term = index.dictionary[termIndex];
		const start = index.postingOffsets[termIndex];
		const end = index.postingOffsets[termIndex + 1];
		if (term === undefined || start === undefined || end === undefined) {
			throw new TypeError('Compact posting index offsets are incomplete.');
		}
		const list = new Map<number, number>();
		let cursor = start;
		let ordinal = 0;
		while (cursor < end) {
			const delta = decodeUnsignedVarint(postingsBytes, cursor, end);
			cursor = delta.nextOffset;
			const frequency = decodeUnsignedVarint(postingsBytes, cursor, end);
			cursor = frequency.nextOffset;
			ordinal += delta.value;
			if (list.has(ordinal)) throw new TypeError('Duplicate ordinal in compact posting list.');
			list.set(ordinal, frequency.value);
		}
		postings.set(term, list);
	}

	const lengthValues = decodeIntegerSequence(Buffer.from(index.documentLengthsBase64, 'base64'));
	if (lengthValues.length % 2 !== 0) throw new TypeError('Document-length stream is malformed.');
	const documentLengths = new Map<number, number>();
	for (let offset = 0; offset < lengthValues.length; offset += 2) {
		const ordinal = lengthValues[offset];
		const length = lengthValues[offset + 1];
		if (ordinal === undefined || length === undefined || documentLengths.has(ordinal)) {
			throw new TypeError('Document-length stream contains an invalid ordinal.');
		}
		documentLengths.set(ordinal, length);
	}
	if (documentLengths.size !== index.documentCount) {
		throw new TypeError('Compact posting index documentCount does not match its length table.');
	}
	return { postings, documentLengths };
}

export function encodeOrdinalSet(ordinals: readonly number[]): string {
	const unique = [...new Set(ordinals)].sort((first, second) => first - second);
	let previous = 0;
	const deltas: number[] = [];
	for (const ordinal of unique) {
		assertNonNegativeInteger(ordinal, 'document ordinal');
		deltas.push(ordinal - previous);
		previous = ordinal;
	}
	return Buffer.from(encodeIntegerSequence(deltas)).toString('base64');
}

export function decodeOrdinalSet(encoded: string): number[] {
	const deltas = decodeIntegerSequence(Buffer.from(encoded, 'base64'));
	const ordinals: number[] = [];
	let ordinal = 0;
	for (const delta of deltas) {
		ordinal += delta;
		ordinals.push(ordinal);
	}
	return ordinals;
}

export function materializeLexicalArtifact(
	artifact: CompactLexicalArtifact,
): MaterializedLexicalIndex {
	const materialized = decodeCompactPostingIndex(artifact.base);
	for (const delta of artifact.deltas) applyLexicalDelta(materialized, delta);
	return materialized;
}

export function compactLexicalArtifact(
	artifact: CompactLexicalArtifact,
): CompactLexicalArtifact {
	const materialized = materializeLexicalArtifact(artifact);
	return {
		schemaVersion: artifact.schemaVersion,
		base: buildCompactPostingIndex(materializedToInputs(materialized)),
		deltas: [],
	};
}

function applyLexicalDelta(
	materialized: MaterializedLexicalIndex,
	delta: CompactLexicalDelta,
): void {
	const replacements = new Set(decodeOrdinalSet(delta.replaceOrdinalsBase64));
	for (const ordinal of replacements) materialized.documentLengths.delete(ordinal);
	for (const posting of materialized.postings.values()) {
		for (const ordinal of replacements) posting.delete(ordinal);
	}
	const additions = decodeCompactPostingIndex(delta.index);
	for (const [ordinal, length] of additions.documentLengths) {
		if (!replacements.has(ordinal)) {
			throw new TypeError('A lexical delta may add only an ordinal named in replaceOrdinals.');
		}
		materialized.documentLengths.set(ordinal, length);
	}
	for (const [term, incoming] of additions.postings) {
		const target = materialized.postings.get(term) ?? new Map<number, number>();
		for (const [ordinal, frequency] of incoming) target.set(ordinal, frequency);
		materialized.postings.set(term, target);
	}
	for (const [term, posting] of materialized.postings) {
		if (posting.size === 0) materialized.postings.delete(term);
	}
}

function materializedToInputs(index: MaterializedLexicalIndex): LexicalDocumentInput[] {
	const byOrdinal = new Map<number, Map<string, number>>();
	for (const [term, postings] of index.postings) {
		for (const [ordinal, frequency] of postings) {
			const terms = byOrdinal.get(ordinal) ?? new Map<string, number>();
			terms.set(term, frequency);
			byOrdinal.set(ordinal, terms);
		}
	}
	return [...index.documentLengths.entries()].map(([ordinal, documentLength]) => ({
		ordinal,
		documentLength,
		termFrequencies: byOrdinal.get(ordinal) ?? new Map<string, number>(),
	}));
}

function validateCompactPostingIndex(index: CompactPostingIndex): void {
	if (index.schemaVersion !== COMPACT_LEXICAL_SCHEMA_VERSION) {
		throw new TypeError('Unsupported compact posting index schema.');
	}
	if (index.postingOffsets.length !== index.dictionary.length + 1) {
		throw new TypeError('Compact posting offsets must bracket every dictionary term.');
	}
	const bytes = Buffer.from(index.postingsBase64, 'base64');
	let previous = -1;
	for (const offset of index.postingOffsets) {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset < previous || offset > bytes.length) {
			throw new TypeError('Compact posting offset is out of bounds.');
		}
		previous = offset;
	}
	if (previous !== bytes.length) throw new TypeError('Compact posting data has trailing bytes.');
}

function encodeIntegerSequence(values: readonly number[]): number[] {
	const output: number[] = [];
	for (const value of values) encodeUnsignedVarint(value, output);
	return output;
}

function decodeIntegerSequence(bytes: Uint8Array): number[] {
	const output: number[] = [];
	let cursor = 0;
	while (cursor < bytes.length) {
		const decoded = decodeUnsignedVarint(bytes, cursor, bytes.length);
		output.push(decoded.value);
		cursor = decoded.nextOffset;
	}
	return output;
}

function encodeUnsignedVarint(value: number, output: number[]): void {
	assertNonNegativeInteger(value, 'varint value');
	let remaining = value;
	do {
		let byte = remaining % 128;
		remaining = Math.floor(remaining / 128);
		if (remaining > 0) byte |= 0x80;
		output.push(byte);
	} while (remaining > 0);
}

function decodeUnsignedVarint(
	bytes: Uint8Array,
	startOffset: number,
	endOffset: number,
): { value: number; nextOffset: number } {
	let value = 0;
	let multiplier = 1;
	let offset = startOffset;
	while (offset < endOffset) {
		const byte = bytes[offset];
		if (byte === undefined) break;
		value += (byte & 0x7f) * multiplier;
		if (!Number.isSafeInteger(value)) throw new TypeError('Varint exceeds the safe integer range.');
		offset += 1;
		if ((byte & 0x80) === 0) return { value, nextOffset: offset };
		multiplier *= 128;
		if (!Number.isSafeInteger(multiplier)) throw new TypeError('Varint is too long.');
	}
	throw new TypeError('Truncated varint stream.');
}

function assertNonNegativeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
}
