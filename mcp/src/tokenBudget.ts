export function estimateTokens(value: string): number {
	// One UTF-8 byte is one conservative budget unit. Modern byte-fallback text
	// tokenizers cannot emit more content tokens than the bytes available to
	// encode that content, while character heuristics can badly undercount emoji
	// sequences, combining marks, and unfamiliar scripts. This intentionally
	// trades context density for a deterministic cross-tokenizer hard ceiling.
	return Buffer.byteLength(value, 'utf8');
}

export function truncateToTokenBudget(value: string, maximumTokens: number): string {
	if (maximumTokens <= 0) return '';
	if (estimateTokens(value) <= maximumTokens) return value;
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (estimateTokens(value.slice(0, middle)) <= maximumTokens) low = middle;
		else high = middle - 1;
	}
	let end = low;
	if (end > 0) {
		const code = value.charCodeAt(end - 1);
		if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	}
	return value.slice(0, end).trimEnd();
}
