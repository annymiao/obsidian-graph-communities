import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	chunkMarkdown,
	parseMarkdownHeadings,
} from '../src/markdownChunks.js';
import { estimateTokens } from '../src/tokenBudget.js';

test('parses ATX headings outside code fences only', () => {
	const lines = [
		'# Real title',
		'```markdown',
		'# Not a heading',
		'```',
		'~~~text',
		'## Also not a heading',
		'~~~~',
		'## Real section ##',
	];

	assert.deepEqual(parseMarkdownHeadings(lines), [
		{ text: 'Real title', level: 1, line: 0 },
		{ text: 'Real section', level: 2, line: 7 },
	]);

	const chunks = chunkMarkdown(
		lines,
		0,
		[{ text: 'Untrusted false heading', level: 1, line: 2 }],
		200,
		0,
	);
	assert.equal(chunks.some((chunk) => chunk.heading?.includes('Untrusted')), false);
});

test('keeps long Chinese chunks inside the estimated token budget', () => {
	const maximumTokens = 200;
	const lines = ['# 中文测试', '记'.repeat(1_000)];
	const chunks = chunkMarkdown(lines, 0, [], maximumTokens, 30);

	assert.ok(chunks.length > 4);
	for (const chunk of chunks) {
		assert.ok(chunk.content.length > 0);
		assert.ok(
			estimateTokens(chunk.content) <= maximumTokens,
			`chunk exceeded budget: ${estimateTokens(chunk.content)}`,
		);
	}
});

test('gives chunks split from one long line distinct inclusive column ranges', () => {
	const line = `${'alpha '.repeat(160)}columnbeacon ${'omega '.repeat(160)}`;
	const chunks = chunkMarkdown([line], 0, [], 200, 20);

	assert.ok(chunks.length > 2);
	assert.equal(new Set(chunks.map((chunk) => chunk.startColumn)).size, chunks.length);
	for (const chunk of chunks) {
		assert.equal(chunk.startLine, 1);
		assert.equal(chunk.endLine, 1);
		assert.ok((chunk.startColumn ?? 0) >= 1);
		assert.ok((chunk.endColumn ?? 0) >= (chunk.startColumn ?? 1));
		assert.equal(
			line.slice((chunk.startColumn ?? 1) - 1, chunk.endColumn),
			chunk.content,
		);
	}
});

test('long-line overlap skips useless leading whitespace without duplicate spans', () => {
	const line = `${' '.repeat(1_000)}${'alpha '.repeat(1_000)}`;
	const chunks = chunkMarkdown([line], 0, [], 200, 80);
	const spans = chunks.map((chunk) => `${chunk.startColumn}:${chunk.endColumn}`);

	assert.ok(chunks.length > 2);
	assert.ok(chunks.length < 50, `unexpected chunk amplification: ${chunks.length}`);
	assert.equal(new Set(spans).size, chunks.length);
	for (const chunk of chunks) {
		assert.equal(
			line.slice((chunk.startColumn ?? 1) - 1, chunk.endColumn),
			chunk.content,
		);
	}
});

test('long-line overlap crosses internal and trailing whitespace without duplicate spans', () => {
	const variants = [
		`${'alpha '.repeat(100)}${' '.repeat(1_000)}`,
		`${'alpha '.repeat(100)}${' '.repeat(1_000)}${'beta '.repeat(100)}`,
	];
	for (const line of variants) {
		const chunks = chunkMarkdown([line], 0, [], 200, 80);
		const spans = chunks.map((chunk) => `${chunk.startColumn}:${chunk.endColumn}`);
		assert.ok(chunks.length < 20, `unexpected chunk amplification: ${chunks.length}`);
		assert.equal(new Set(spans).size, chunks.length);
		for (const chunk of chunks) {
			assert.equal(
				line.slice((chunk.startColumn ?? 1) - 1, chunk.endColumn),
				chunk.content,
			);
		}
		if (line.includes('beta')) {
			assert.ok(chunks.some((chunk) => chunk.content.includes('beta')));
		}
	}
});

test('advances past oversized whitespace instead of looping forever', () => {
	const chunks = chunkMarkdown(
		[' '.repeat(4_000), '有意义的正文'],
		0,
		[],
		200,
		40,
	);

	assert.deepEqual(chunks.map((chunk) => chunk.content), ['有意义的正文']);
});

test('token estimates reserve headroom for dense identifiers and emoji', () => {
	assert.ok(estimateTokens('A7f9Q2z8K4m6N1p3R5t7V9x2B4d6F8h0') >= 28);
	assert.ok(estimateTokens('🧠'.repeat(20)) >= 50);
	assert.ok(estimateTokens('A normal sentence keeps useful evidence density.') < 30);
});
