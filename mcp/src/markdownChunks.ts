import { estimateTokens, truncateToTokenBudget } from './tokenBudget.js';

export { estimateTokens } from './tokenBudget.js';

export interface MarkdownHeading {
	text: string;
	level: number;
	line: number;
}

export interface MarkdownChunkDraft {
	heading: string | null;
	startLine: number;
	endLine: number;
	content: string;
}

interface Section {
	start: number;
	end: number;
	heading: string | null;
}

export function chunkMarkdown(
	lines: string[],
	bodyStartLine: number,
	_headings: MarkdownHeading[],
	requestedMaximumTokens: number,
	requestedOverlapTokens: number,
): MarkdownChunkDraft[] {
	const maximum = Math.max(200, requestedMaximumTokens);
	const overlap = Math.max(0, Math.min(requestedOverlapTokens, Math.floor(maximum / 3)));
	const safeBodyStartLine = Math.max(0, Math.min(lines.length, Math.floor(bodyStartLine)));
	// Re-parse from source lines instead of trusting headings supplied by a caller.
	// Otherwise a Markdown-looking line inside a code fence can create a false section.
	const headings = parseMarkdownHeadings(lines, safeBodyStartLine);
	const sections = buildSections(lines.length, safeBodyStartLine, headings);
	const chunks: MarkdownChunkDraft[] = [];

	for (const section of sections) {
		chunks.push(...splitSection(lines, section, maximum, overlap));
	}

	return chunks.filter((chunk) => chunk.content.trim().length > 0);
}

export function parseMarkdownHeadings(
	lines: string[],
	bodyStartLine = 0,
): MarkdownHeading[] {
	const start = Math.max(0, Math.min(lines.length, Math.floor(bodyStartLine)));
	const headings: MarkdownHeading[] = [];
	let fence: { marker: '`' | '~'; length: number } | null = null;

	for (let lineNumber = start; lineNumber < lines.length; lineNumber += 1) {
		const line = lines[lineNumber] ?? '';
		const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
		if (fence) {
			if (fenceMatch?.[1]) {
				const run = fenceMatch[1];
				const remainder = fenceMatch[2] ?? '';
				if (
					run[0] === fence.marker
					&& run.length >= fence.length
					&& remainder.trim().length === 0
				) {
					fence = null;
				}
			}
			continue;
		}
		if (fenceMatch?.[1]) {
			const run = fenceMatch[1];
			const marker = run[0];
			if (marker === '`' || marker === '~') {
				fence = { marker, length: run.length };
			}
			continue;
		}

		const headingMatch = /^ {0,3}(#{1,6})(?:[\t ]+(.*)|[\t ]*)$/u.exec(line);
		if (!headingMatch?.[1]) continue;
		const text = (headingMatch[2] ?? '')
			.replace(/[\t ]+#+[\t ]*$/u, '')
			.trim();
		if (!text) continue;
		headings.push({
			text,
			level: headingMatch[1].length,
			line: lineNumber,
		});
	}

	return headings;
}

function buildSections(
	lineCount: number,
	bodyStartLine: number,
	headings: MarkdownHeading[],
): Section[] {
	const relevant = headings
		.filter((heading) => heading.line >= bodyStartLine)
		.sort((first, second) => first.line - second.line);
	const sections: Section[] = [];
	if (relevant.length === 0) {
		return [{ start: bodyStartLine, end: lineCount, heading: null }];
	}
	if ((relevant[0]?.line ?? bodyStartLine) > bodyStartLine) {
		sections.push({ start: bodyStartLine, end: relevant[0]?.line ?? lineCount, heading: null });
	}

	const stack: MarkdownHeading[] = [];
	relevant.forEach((heading, index) => {
		while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
		stack.push(heading);
		sections.push({
			start: heading.line,
			end: relevant[index + 1]?.line ?? lineCount,
			heading: stack.map((item) => item.text).join(' › '),
		});
	});
	return sections;
}

function splitSection(
	lines: string[],
	section: Section,
	maximumTokens: number,
	overlapTokens: number,
): MarkdownChunkDraft[] {
	const chunks: MarkdownChunkDraft[] = [];
	let cursor = section.start;

	while (cursor < section.end) {
		const firstLine = lines[cursor] ?? '';
		if (estimateTokens(firstLine) > maximumTokens) {
			chunks.push(...splitLongLine(firstLine, cursor, section.heading, maximumTokens, overlapTokens));
			cursor += 1;
			continue;
		}

		let end = cursor;
		let tokens = 0;
		let preferredBreak = -1;
		while (end < section.end) {
			const line = lines[end] ?? '';
			const addition = estimateTokens(line) + (end > cursor ? 1 : 0);
			if (end > cursor && tokens + addition > maximumTokens) break;
			tokens += addition;
			end += 1;
			if (line.trim().length === 0 && tokens >= Math.floor(maximumTokens * 0.45)) {
				preferredBreak = end;
			}
			if (tokens >= maximumTokens) break;
		}

		if (preferredBreak > cursor && end < section.end) end = preferredBreak;
		if (end <= cursor) end = cursor + 1;
		const content = lines.slice(cursor, end).join('\n').trim();
		if (content) {
			chunks.push({
				heading: section.heading,
				startLine: cursor + 1,
				endLine: end,
				content,
			});
		}

		if (end >= section.end || overlapTokens === 0) {
			cursor = end;
			continue;
		}
		let next = end;
		let overlapTokenCount = 0;
		while (next > cursor + 1) {
			const previous = lines[next - 1] ?? '';
			const previousTokens = estimateTokens(previous) + 1;
			if (overlapTokenCount + previousTokens > overlapTokens) break;
			overlapTokenCount += previousTokens;
			next -= 1;
		}
		cursor = next < end ? next : end;
	}

	return chunks;
}

function splitLongLine(
	line: string,
	lineIndex: number,
	heading: string | null,
	maximumTokens: number,
	overlapTokens: number,
): MarkdownChunkDraft[] {
	const chunks: MarkdownChunkDraft[] = [];
	let offset = 0;
	while (offset < line.length) {
		const tail = line.slice(offset);
		const window = truncateToTokenBudget(tail, maximumTokens);
		if (!window) {
			// truncateToTokenBudget intentionally trims trailing whitespace. A very
			// long whitespace run can therefore yield an empty window; advance over a
			// bounded portion instead of spinning forever.
			offset += safeCharacterAdvance(
				tail,
				Math.max(1, Math.min(tail.length, maximumTokens * 3)),
			);
			continue;
		}

		const content = window.trim();
		if (content) {
			chunks.push({
				heading,
				startLine: lineIndex + 1,
				endLine: lineIndex + 1,
				content,
			});
		}
		if (window.length >= tail.length) break;

		let advance = window.length;
		if (overlapTokens > 0) {
			const nonOverlapBudget = Math.max(1, estimateTokens(window) - overlapTokens);
			advance = truncateToTokenBudget(window, nonOverlapBudget).length;
		}
		offset += safeCharacterAdvance(tail, Math.max(1, advance));
	}
	return chunks;
}

function safeCharacterAdvance(value: string, requested: number): number {
	let advance = Math.max(1, Math.min(value.length, Math.floor(requested)));
	if (advance < value.length) {
		const previous = value.charCodeAt(advance - 1);
		const next = value.charCodeAt(advance);
		if (
			previous >= 0xd800
			&& previous <= 0xdbff
			&& next >= 0xdc00
			&& next <= 0xdfff
		) {
			advance += 1;
		}
	}
	return advance;
}
