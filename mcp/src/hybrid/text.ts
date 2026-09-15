const CJK_SEQUENCE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const WORD_SEQUENCE = /[\p{L}\p{N}]+/gu;

export function normalizeText(value: string): string {
	return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
}

export function tokenize(value: string): string[] {
	const normalized = normalizeText(value);
	const tokens: string[] = [];
	for (const match of normalized.matchAll(WORD_SEQUENCE)) {
		const word = match[0];
		if (CJK_SEQUENCE.test(word)) {
			CJK_SEQUENCE.lastIndex = 0;
			tokens.push(word);
			const characters = Array.from(word);
			for (const character of characters) tokens.push(character);
			for (let index = 0; index + 1 < characters.length; index += 1) {
				tokens.push(`${characters[index] ?? ''}${characters[index + 1] ?? ''}`);
			}
		} else {
			tokens.push(word);
		}
		CJK_SEQUENCE.lastIndex = 0;
	}
	return tokens;
}

export function uniqueTokens(value: string): Set<string> {
	return new Set(tokenize(value));
}

export function countTokens(value: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokenize(value)) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

export function stableHash32(value: string, seed = 2_166_136_261): number {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

export function cosineSimilarity(first: readonly number[], second: readonly number[]): number {
	if (first.length !== second.length || first.length === 0) return 0;
	let dot = 0;
	let firstNorm = 0;
	let secondNorm = 0;
	for (let index = 0; index < first.length; index += 1) {
		const firstValue = first[index] ?? 0;
		const secondValue = second[index] ?? 0;
		dot += firstValue * secondValue;
		firstNorm += firstValue * firstValue;
		secondNorm += secondValue * secondValue;
	}
	if (firstNorm === 0 || secondNorm === 0) return 0;
	return dot / Math.sqrt(firstNorm * secondNorm);
}

export function contentShingles(value: string, width = 3): Set<string> {
	const tokens = tokenize(value);
	if (tokens.length <= width) return new Set(tokens.length === 0 ? [] : [tokens.join('\u0001')]);
	const shingles = new Set<string>();
	for (let index = 0; index + width <= tokens.length; index += 1) {
		shingles.add(tokens.slice(index, index + width).join('\u0001'));
	}
	return shingles;
}

export function jaccardSimilarity(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
	if (first.size === 0 && second.size === 0) return 1;
	let intersection = 0;
	const smaller = first.size <= second.size ? first : second;
	const larger = first.size <= second.size ? second : first;
	for (const value of smaller) if (larger.has(value)) intersection += 1;
	return intersection / (first.size + second.size - intersection);
}

export function throwIfCancelled(signal: AbortSignal, deadlineAt: number): void {
	if (signal.aborted || Date.now() >= deadlineAt) throw new HybridDeadlineError();
}

export class HybridDeadlineError extends Error {
	constructor(message = 'Hybrid retrieval deadline exceeded.') {
		super(message);
		this.name = 'HybridDeadlineError';
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
