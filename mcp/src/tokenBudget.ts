export function estimateTokens(value: string): number {
	if (!value) return 0;
	const segments = value.match(
		/[A-Za-z0-9]+|[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+|\s+|[^]/gu,
	) ?? [];
	let estimate = 0;
	for (const segment of segments) {
		if (/^[A-Za-z0-9]+$/u.test(segment)) {
			estimate += segment.length >= 24
				? segment.length * 0.75
				: Math.ceil(segment.length / 4);
			continue;
		}
		if (/^[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+$/u.test(segment)) {
			estimate += [...segment].length * 1.4;
			continue;
		}
		if (/^\s+$/u.test(segment)) {
			estimate += segment.length / 8;
			continue;
		}
		const codePoint = segment.codePointAt(0) ?? 0;
		estimate += codePoint > 0xffff ? 2.5 : codePoint > 0x7f ? 1.25 : 1;
	}
	return Math.ceil(estimate * 1.15);
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
