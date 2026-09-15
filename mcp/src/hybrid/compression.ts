import {
	HybridDeadlineError,
	normalizeText,
	tokenize,
	uniqueTokens,
} from './text.js';
import type { RankedCandidate } from './types.js';

export interface ScoredCandidate extends RankedCandidate {
	rerankScore: number;
	rerankerReasons: readonly string[];
}

export interface MmrOptions {
	limit: number;
	lambda?: number;
	nearDuplicateThreshold?: number;
	deadline?: CompressionDeadline;
}

export interface CompressionDeadline {
	signal: AbortSignal;
	deadlineAt: number;
}

interface PreparedCandidate {
	candidate: ScoredCandidate;
	shingles: ReadonlySet<string>;
	relevance: number;
}

export function selectDiverseCandidates(
	candidates: readonly ScoredCandidate[],
	options: MmrOptions,
): ScoredCandidate[] {
	checkDeadline(options.deadline);
	const lambda = options.lambda ?? 0.72;
	const duplicateThreshold = options.nearDuplicateThreshold ?? 0.92;
	if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
		throw new Error('MMR lambda must be between 0 and 1.');
	}
	if (!Number.isFinite(duplicateThreshold) || duplicateThreshold < 0 || duplicateThreshold > 1) {
		throw new Error('Near-duplicate threshold must be between 0 and 1.');
	}
	if (options.limit <= 0 || candidates.length === 0) return [];
	const ordered = [...candidates].sort((first, second) => (
		second.rerankScore - first.rerankScore
		|| second.fusedScore - first.fusedScore
		|| first.record.id.localeCompare(second.record.id)
	));
	const maximum = Math.max(...ordered.map((candidate) => candidate.rerankScore), 0);
	const minimum = Math.min(...ordered.map((candidate) => candidate.rerankScore), 0);
	const span = maximum - minimum;
	const deduplicated: PreparedCandidate[] = [];
	for (const candidate of ordered) {
		checkDeadline(options.deadline);
		const shingles = contentShinglesBeforeDeadline(candidate.record.content, options.deadline);
		checkDeadline(options.deadline);
		let duplicate = false;
		for (const existing of deduplicated) {
			checkDeadline(options.deadline);
			if (jaccardSimilarityBeforeDeadline(shingles, existing.shingles, options.deadline) >= duplicateThreshold) {
				duplicate = true;
				break;
			}
		}
		if (duplicate) continue;
		const relevance = span === 0 ? 1 : (candidate.rerankScore - minimum) / span;
		deduplicated.push({ candidate, shingles, relevance });
	}
	const selected: PreparedCandidate[] = [];
	const remaining = [...deduplicated];
	while (remaining.length > 0 && selected.length < options.limit) {
		checkDeadline(options.deadline);
		let bestIndex = 0;
		let bestScore = Number.NEGATIVE_INFINITY;
		for (let index = 0; index < remaining.length; index += 1) {
			checkDeadline(options.deadline);
			const contender = remaining[index];
			if (contender === undefined) continue;
			let maximumSimilarity = 0;
			for (const existing of selected) {
				checkDeadline(options.deadline);
				maximumSimilarity = Math.max(
					maximumSimilarity,
					jaccardSimilarityBeforeDeadline(
						contender.shingles,
						existing.shingles,
						options.deadline,
					),
				);
			}
			const score = lambda * contender.relevance - (1 - lambda) * maximumSimilarity;
			if (score > bestScore) {
				bestScore = score;
				bestIndex = index;
			}
		}
		const [chosen] = remaining.splice(bestIndex, 1);
		if (chosen !== undefined) selected.push(chosen);
	}
	return selected.map((item) => item.candidate);
}

interface SentenceCandidate {
	text: string;
	index: number;
	score: number;
}

function sentenceCandidates(content: string, query: string): SentenceCandidate[] {
	return sentenceCandidatesBeforeDeadline(content, query);
}

function sentenceCandidatesBeforeDeadline(
	content: string,
	query: string,
	deadline?: CompressionDeadline,
): SentenceCandidate[] {
	checkDeadline(deadline);
	const queryTokens = uniqueTokens(query);
	const pieces = content.match(/[^.!?。！？\n]+[.!?。！？]?/gu) ?? [content];
	checkDeadline(deadline);
	const candidates: SentenceCandidate[] = [];
	for (let index = 0; index < pieces.length; index += 1) {
		checkDeadline(deadline);
		const piece = pieces[index] ?? '';
		const text = piece.trim();
		if (text.length === 0) continue;
		const tokens = uniqueTokens(text);
		let matches = 0;
		for (const token of queryTokens) {
			checkDeadline(deadline);
			if (tokens.has(token)) matches += 1;
		}
		candidates.push({
			text,
			index,
			score: queryTokens.size === 0 ? 0 : matches / queryTokens.size,
		});
	}
	return candidates;
}

export interface ExtractiveExcerpt {
	text: string;
	compressed: boolean;
	originalCharacterCount: number;
}

/** Copies source sentences only; it never generates or paraphrases evidence. */
export function extractiveCompress(
	content: string,
	query: string,
	maximumCharacters: number,
	deadline?: CompressionDeadline,
): ExtractiveExcerpt {
	checkDeadline(deadline);
	const limit = Math.max(1, Math.floor(maximumCharacters));
	if (content.length <= limit) {
		return { text: content, compressed: false, originalCharacterCount: content.length };
	}
	const sentences = deadline === undefined
		? sentenceCandidates(content, query)
		: sentenceCandidatesBeforeDeadline(content, query, deadline);
	checkDeadline(deadline);
	const ranked = [...sentences].sort((first, second) => (
		second.score - first.score || first.index - second.index
	));
	const selected: SentenceCandidate[] = [];
	let used = 0;
	for (const sentence of ranked) {
		checkDeadline(deadline);
		const separator = selected.length === 0 ? 0 : 3;
		if (used + separator + sentence.text.length > limit) continue;
		selected.push(sentence);
		used += separator + sentence.text.length;
	}
	if (selected.length === 0) {
		return {
			text: content.slice(0, limit),
			compressed: true,
			originalCharacterCount: content.length,
		};
	}
	selected.sort((first, second) => first.index - second.index);
	checkDeadline(deadline);
	let text = selected.map((sentence) => sentence.text).join(' … ');
	if (text.length > limit) text = text.slice(0, limit);
	return {
		text,
		compressed: normalizeText(text) !== normalizeText(content),
		originalCharacterCount: content.length,
	};
}

function checkDeadline(deadline: CompressionDeadline | undefined): void {
	if (
		deadline !== undefined
		&& (deadline.signal.aborted || Date.now() >= deadline.deadlineAt)
	) throw new HybridDeadlineError();
}

function contentShinglesBeforeDeadline(
	value: string,
	deadline: CompressionDeadline | undefined,
	width = 3,
): Set<string> {
	checkDeadline(deadline);
	const tokens = tokenize(value);
	checkDeadline(deadline);
	if (tokens.length <= width) {
		return new Set(tokens.length === 0 ? [] : [tokens.join('\u0001')]);
	}
	const shingles = new Set<string>();
	for (let index = 0; index + width <= tokens.length; index += 1) {
		if (index % 64 === 0) checkDeadline(deadline);
		shingles.add(tokens.slice(index, index + width).join('\u0001'));
	}
	return shingles;
}

function jaccardSimilarityBeforeDeadline(
	first: ReadonlySet<string>,
	second: ReadonlySet<string>,
	deadline: CompressionDeadline | undefined,
): number {
	if (first.size === 0 && second.size === 0) return 1;
	let intersection = 0;
	let inspected = 0;
	const smaller = first.size <= second.size ? first : second;
	const larger = first.size <= second.size ? second : first;
	for (const value of smaller) {
		if ((inspected += 1) % 64 === 0) checkDeadline(deadline);
		if (larger.has(value)) intersection += 1;
	}
	return intersection / (first.size + second.size - intersection);
}
