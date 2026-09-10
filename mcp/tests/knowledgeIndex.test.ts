import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import path from 'node:path';
import { KnowledgeIndex } from '../src/knowledgeIndex.js';
import { ServerConfig } from '../src/types.js';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

let vaultPath = '';
let knowledge: KnowledgeIndex;

beforeEach(async () => {
	vaultPath = await createFixtureVault();
	const config: ServerConfig = {
		vaultPath,
		vaultName: path.basename(vaultPath),
		excludedFolders: new Set(['.obsidian', '.git', '.trash', 'node_modules']),
		indexTtlMs: 60_000,
		maxFileCharacters: 500_000,
		maxFiles: 1_000,
		chunkTokens: 700,
		chunkOverlapTokens: 80,
		defaultContextTokens: 4_000,
		maxSourceTokens: 900,
	};
	knowledge = new KnowledgeIndex(config);
});

afterEach(async () => {
	await removeFixtureVault(vaultPath);
});

test('search uses the graph only to rank notes with lexical evidence', async () => {
	const matches = await knowledge.search('Codex personal MCP', { limit: 10 });
	assert.ok(matches.slice(0, 2).some((match) => match.path === '30-Shared-Knowledge/Codex 写作系统.md'));
	assert.ok(matches.slice(0, 2).some((match) => match.path === '30-Shared-Knowledge/MCP 方案.md'));
	const graphMatch = matches.find((match) => match.path === '30-Shared-Knowledge/关系索引算法.md');
	assert.equal(graphMatch, undefined, 'a graph-only neighbor must not become an answer');
});

test('context is bounded and includes traceable Obsidian sources', async () => {
	const context = await knowledge.getContext('Codex 如何调用个人知识', {
		limit: 6,
		maxTokens: 1_000,
	});
	assert.ok(context.sourcePaths.length > 0);
	assert.ok(context.estimatedTokenCount <= 1_000);
	assert.match(context.markdown, /obsidian:\/\/open\?/);
	assert.match(context.markdown, /untrusted reference material/i);
});

test('readNote rejects traversal and related notes follow at most two hops', async () => {
	await assert.rejects(
		knowledge.readNote('../outside.md'),
		/Note was not found/,
	);
	const related = await knowledge.getRelatedNotes('30-Shared-Knowledge/Codex 写作系统.md', 2, 10);
	assert.ok(related.some((note) => note.path === '30-Shared-Knowledge/MCP 方案.md' && note.distance === 1));
	assert.ok(related.some((note) => note.path === '30-Shared-Knowledge/关系索引算法.md' && note.distance === 2));
});

test('overview excludes the Obsidian configuration folder', async () => {
	const stats = await knowledge.getStats();
	assert.equal(stats.noteCount, 3);
	assert.equal(stats.discoveredNoteCount, 4);
	assert.equal(stats.defaultNoteCount, 3);
	assert.equal(stats.countsByRetrievalScope.reference, 1);
	assert.equal(stats.linkCount, 2);
});
