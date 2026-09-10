import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { KnowledgeIndex } from '../src/knowledgeIndex.js';
import { estimateTokens } from '../src/markdownChunks.js';
import { RetrievalMode, ServerConfig } from '../src/types.js';

const SEARCH_MARKER = 'scopebeacon';

function configFor(vaultPath: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		vaultPath,
		vaultName: path.basename(vaultPath),
		excludedFolders: new Set(['.obsidian', '.git', '.trash', 'node_modules']),
		indexTtlMs: 60_000,
		maxFileCharacters: 500_000,
		maxFiles: 1_000,
		chunkTokens: 200,
		chunkOverlapTokens: 20,
		defaultContextTokens: 800,
		maxSourceTokens: 220,
		...overrides,
	};
}

async function syntheticVault(t: { after: (callback: () => Promise<void>) => void }): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-retrieval-regression-'));
	t.after(async () => rm(root, { recursive: true, force: true }));
	return root;
}

async function writeSynthetic(
	root: string,
	relativePath: string,
	content: string | Uint8Array,
): Promise<void> {
	const absolutePath = path.join(root, relativePath);
	await mkdir(path.dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, 'utf8');
}

function frontmatter(fields: Record<string, string | boolean>, body: string): string {
	return [
		'---',
		...Object.entries(fields).map(([key, value]) => `${key}: ${String(value)}`),
		'---',
		'',
		body,
	].join('\n');
}

test('default, project, reference, and history modes remain strictly isolated', async (t) => {
	const root = await syntheticVault(t);
	const notes: Array<[string, string]> = [
		['30-Shared-Knowledge/core.md', frontmatter(
			{ type: 'knowledge-card', status: 'active' },
			`# Core evidence\n${SEARCH_MARKER} stable canonical conclusion. [[../80-Knowledge-Index/generated]]`,
		)],
		['10-Work/project.md', `# Project evidence\n${SEARCH_MARKER} active project detail.`],
		['40-Resources/reference.md', `# Reference evidence\n${SEARCH_MARKER} external reference detail.`],
		['40_Archive/history.md', `# Historical evidence\n${SEARCH_MARKER} superseded historical detail.`],
		['50-AI/Prompts/Legacy/legacy.md', frontmatter(
			{ corpus: 'core', retrieval_scope: 'default' },
			`# Legacy instruction\n${SEARCH_MARKER} historical instruction text.`,
		)],
		['20-Competition/superseded.md', frontmatter(
			{ graph_exclude: true, graph_exclude_reason: 'superseded decision' },
			`# Superseded evidence\n${SEARCH_MARKER} retired decision.`,
		)],
		['80-Knowledge-Index/generated.md', frontmatter(
			{ corpus: 'core', retrieval_scope: 'default' },
			`# Generated index\n${SEARCH_MARKER} generated derivative.`,
		)],
		['.agents/AGENTS.md', frontmatter(
			{ corpus: 'core', retrieval_scope: 'default' },
			`# Agent instructions\n${SEARCH_MARKER} control text.`,
		)],
		['30-Shared-Knowledge/restricted.md', frontmatter(
			{
				type: 'knowledge-card',
				status: 'active',
				sensitivity: 'restricted-summary',
				retrieval_scope: 'default',
			},
			`# Restricted evidence\n${SEARCH_MARKER} private summary.`,
		)],
		['30-Shared-Knowledge/invalid-policy.md', frontmatter(
			{ type: 'knowledge-card', status: 'active', retrieval_scope: 'default-override' },
			`# Invalid policy\n${SEARCH_MARKER} malformed policy value.`,
		)],
	];
	await Promise.all(notes.map(([notePath, content]) => writeSynthetic(root, notePath, content)));

	const knowledge = new KnowledgeIndex(configFor(root));
	const expected: Record<RetrievalMode, string[]> = {
		default: ['30-Shared-Knowledge/core.md'],
		project: ['10-Work/project.md', '30-Shared-Knowledge/core.md'],
		reference: ['30-Shared-Knowledge/core.md', '40-Resources/reference.md'],
		history: [
			'20-Competition/superseded.md',
			'30-Shared-Knowledge/core.md',
			'40_Archive/history.md',
			'50-AI/Prompts/Legacy/legacy.md',
		],
	};

	for (const mode of Object.keys(expected) as RetrievalMode[]) {
		const matches = await knowledge.search(SEARCH_MARKER, { mode, limit: 20 });
		assert.deepEqual(
			matches.map((match) => match.path).sort(),
			expected[mode],
			`${mode} mode returned content outside its allowlist`,
		);
	}

	const seeded = await knowledge.search(SEARCH_MARKER, {
		mode: 'default',
		limit: 20,
		seedPaths: [
			'80-Knowledge-Index/generated.md',
			'30-Shared-Knowledge/restricted.md',
		],
	});
	assert.deepEqual(seeded.map((match) => match.path), ['30-Shared-Knowledge/core.md']);
	await assert.rejects(
		knowledge.readNote('80-Knowledge-Index/generated.md', undefined, 2_000, 'history'),
	);
	const related = await knowledge.getRelatedNotes(
		'30-Shared-Knowledge/core.md',
		2,
		20,
		'default',
	);
	assert.equal(related.some((note) => note.path === '80-Knowledge-Index/generated.md'), false);
});

test('a conclusion after 120k characters is searchable as a bounded chunk', async (t) => {
	const root = await syntheticVault(t);
	const padding = Array.from({ length: 1_500 }, (_, index) => {
		return `Synthetic neutral padding ${String(index).padStart(4, '0')} ${'ordinary '.repeat(11)}`;
	});
	const content = frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		[
			'# Long synthetic note',
			...padding,
			'## Tail conclusion',
			'tailbeacon84721 is the verified synthetic conclusion at the end.',
		].join('\n'),
	);
	assert.ok(content.length > 120_000, 'fixture must exercise content beyond the old read ceiling');
	await writeSynthetic(root, '30-Shared-Knowledge/long.md', content);

	const knowledge = new KnowledgeIndex(configFor(root));
	const matches = await knowledge.search('tailbeacon84721', { limit: 5 });

	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.path, '30-Shared-Knowledge/long.md');
	assert.match(matches[0]?.excerpt ?? '', /tailbeacon84721/);
	assert.ok((matches[0]?.startLine ?? 0) > 1_000);
	const stats = await knowledge.getStats();
	assert.ok(stats.chunkCount > 1);
	assert.equal(stats.truncatedNoteCount, 0);
});

test('normalized duplicate bodies select core over a history copy', async (t) => {
	const root = await syntheticVault(t);
	const body = '# Shared synthetic evidence\n\ndedupbeacon84721 has one reusable conclusion.\n';
	await writeSynthetic(root, '00-Copies/history.md', [
		'---',
		'retrieval_scope: history',
		'title: Historical copy',
		'---',
		'',
		body,
	].join('\r\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/core.md', frontmatter(
		{ type: 'knowledge-card', status: 'active', title: 'Canonical copy' },
		body,
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	const matches = await knowledge.search('dedupbeacon84721', { mode: 'history', limit: 10 });

	assert.equal(matches.length, 1);
	assert.equal(matches[0]?.path, '30-Shared-Knowledge/core.md');
	assert.equal(matches[0]?.retrievalScope, 'default');
});

test('a restricted duplicate quarantines the whole duplicate group', async (t) => {
	const root = await syntheticVault(t);
	const body = '# Tainted duplicate\n\ntaintedbeacon84721 must never be retrievable.\n';
	await writeSynthetic(root, '30-Shared-Knowledge/apparent-core.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		body,
	));
	await writeSynthetic(root, 'Private/restricted-copy.md', frontmatter(
		{ sensitivity: 'restricted-summary' },
		body,
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	for (const mode of ['default', 'project', 'reference', 'history'] as const) {
		assert.deepEqual(await knowledge.search('taintedbeacon84721', { mode }), []);
	}
});

test('a truncated restricted generated copy still quarantines its apparent core copy', async (t) => {
	const root = await syntheticVault(t);
	const body = [
		'# Shared long body',
		'truncatedtaintbeacon84721 must never be retrievable.',
		'neutral duplicate material '.repeat(900),
	].join('\n');
	await writeSynthetic(root, '30-Shared-Knowledge/apparent-core.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		body,
	));
	await writeSynthetic(root, '80-Knowledge-Index/restricted-copy.md', frontmatter(
		{ generated: true, sensitivity: 'restricted-tenant-synthetic' },
		body,
	));

	const knowledge = new KnowledgeIndex(configFor(root, { maxFileCharacters: 10_000 }));
	for (const mode of ['default', 'project', 'reference', 'history'] as const) {
		assert.deepEqual(await knowledge.search('truncatedtaintbeacon84721', { mode }), []);
	}
	const statsText = JSON.stringify(await knowledge.getStats());
	assert.doesNotMatch(statsText, /tenant-synthetic/u);
	assert.match(statsText, /restricted sensitivity/u);
});

test('matching long prefixes do not quarantine complete documents with different tails', async (t) => {
	const root = await syntheticVault(t);
	const commonPrefix = `# Shared template\n\n${'common template material '.repeat(260)}`;
	await writeSynthetic(root, '30-Shared-Knowledge/safe.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		`${commonPrefix}\nallowedtailbeacon84721 is a safe conclusion.`,
	));
	await writeSynthetic(root, 'Private/restricted.md', frontmatter(
		{ sensitivity: 'restricted-summary' },
		`${commonPrefix}\na different restricted conclusion appears here.`,
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	const matches = await knowledge.search('allowedtailbeacon84721');
	assert.deepEqual(matches.map((match) => match.path), ['30-Shared-Knowledge/safe.md']);
});

test('an explicit never copy also quarantines the same body', async (t) => {
	const root = await syntheticVault(t);
	const body = '# User-excluded duplicate\n\nnevercopybeacon84721 must stay outside retrieval.\n';
	await writeSynthetic(root, '30-Shared-Knowledge/apparent-core.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		body,
	));
	await writeSynthetic(root, '40-Resources/excluded-copy.md', frontmatter(
		{ retrieval_scope: 'never', corpus: 'reference' },
		body,
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	for (const mode of ['default', 'project', 'reference', 'history'] as const) {
		assert.deepEqual(await knowledge.search('nevercopybeacon84721', { mode }), []);
	}
});

test('search abstains on unsupported queries and graph-only neighbors', async (t) => {
	const root = await syntheticVault(t);
	await writeSynthetic(root, '30-Shared-Knowledge/anchor.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# Anchor\ngraphseedbeacon84721 is supported here. [[neighbor]]',
	));
	await writeSynthetic(root, '30-Shared-Knowledge/neighbor.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# Neighbor\nThis linked note contains unrelated synthetic material only.',
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	const supported = await knowledge.search('graphseedbeacon84721', { limit: 10 });
	assert.deepEqual(supported.map((match) => match.path), ['30-Shared-Knowledge/anchor.md']);
	assert.deepEqual(await knowledge.search('unsupportedquery84721'), []);

	const context = await knowledge.getContext('unsupportedquery84721', { maxTokens: 500 });
	assert.deepEqual(context.sourcePaths, []);
	assert.doesNotMatch(context.markdown, /^## Source /mu);
});

test('short Latin queries require token boundaries instead of matching word fragments', async (t) => {
	const root = await syntheticVault(t);
	await writeSynthetic(root, '30-Shared-Knowledge/ai.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# Independent terms\nAI, RAG, and PM support a bounded synthetic workflow.',
	));
	await writeSynthetic(root, '30-Shared-Knowledge/fragments.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# Distractor\nA daily email said storage and npm remain unrelated.',
	));

	const knowledge = new KnowledgeIndex(configFor(root));
	for (const query of ['AI', 'RAG', 'PM']) {
		assert.deepEqual(
			(await knowledge.search(query)).map((match) => match.path),
			['30-Shared-Knowledge/ai.md'],
			query,
		);
	}
});

test('unsupported policy YAML and unclosed frontmatter fail closed', async (t) => {
	const root = await syntheticVault(t);
	await writeSynthetic(root, '30-Shared-Knowledge/folded.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'sensitivity: >-',
		'  private',
		'---',
		'# Folded policy',
		'foldedpolicybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/unclosed.md', [
		'---',
		'type: knowledge-card',
		'sensitivity: restricted-summary',
		'unclosedpolicybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/complex-key.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'? sensitivity',
		': private',
		'---',
		'complexkeybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/escaped-key.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'"\\u0073ensitivity": private',
		'---',
		'escapedkeybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/merge-key.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'<<: {sensitivity: private}',
		'---',
		'mergekeybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/indented-delimiter.md', [
		'---',
		'type: knowledge-card',
		'status: active',
		'description: |',
		'  ---',
		'sensitivity: private',
		'---',
		'indenteddelimiterbeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/bom-frontmatter.md', [
		'\uFEFF---',
		'type: knowledge-card',
		'status: active',
		'sensitivity: private',
		'---',
		'bompolicybeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '30-Shared-Knowledge/escaped-status.md', [
		'---',
		'type: knowledge-card',
		'status: "\\u0061rchived"',
		'---',
		'escapedstatusbeacon84721 must remain excluded.',
	].join('\n'));
	await writeSynthetic(root, '50-AI/Codex-Context/escaped-type.md', [
		'---',
		'type: "\\u0067enerated"',
		'status: active',
		'---',
		'escapedtypebeacon84721 must remain excluded.',
	].join('\n'));

	const knowledge = new KnowledgeIndex(configFor(root));
	assert.deepEqual(await knowledge.search('foldedpolicybeacon84721'), []);
	assert.deepEqual(await knowledge.search('unclosedpolicybeacon84721'), []);
	assert.deepEqual(await knowledge.search('complexkeybeacon84721'), []);
	assert.deepEqual(await knowledge.search('escapedkeybeacon84721'), []);
	assert.deepEqual(await knowledge.search('mergekeybeacon84721'), []);
	assert.deepEqual(await knowledge.search('indenteddelimiterbeacon84721'), []);
	assert.deepEqual(await knowledge.search('bompolicybeacon84721'), []);
	assert.deepEqual(await knowledge.search('escapedstatusbeacon84721'), []);
	assert.deepEqual(await knowledge.search('escapedtypebeacon84721'), []);
});

test('raw character and file-count ceilings fail closed', async (t) => {
	const nulRoot = await syntheticVault(t);
	const nulPadded = Buffer.concat([
		Buffer.alloc(20_000),
		Buffer.from('nulboundarybeacon84721', 'utf8'),
	]);
	await writeSynthetic(nulRoot, '30-Shared-Knowledge/nul-padded.md', nulPadded);
	const bounded = new KnowledgeIndex(configFor(nulRoot, { maxFileCharacters: 10_000 }));
	assert.deepEqual(await bounded.search('nulboundarybeacon84721', { mode: 'reference' }), []);
	assert.equal((await bounded.getStats()).truncatedNoteCount, 1);

	const crowdedRoot = await syntheticVault(t);
	await writeSynthetic(crowdedRoot, '30-Shared-Knowledge/a.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# A\nfileceilingbeacon84721 first note.',
	));
	await writeSynthetic(crowdedRoot, '30-Shared-Knowledge/b.md', frontmatter(
		{ type: 'knowledge-card', status: 'active' },
		'# B\nfileceilingbeacon84721 second note.',
	));
	const incomplete = new KnowledgeIndex(configFor(crowdedRoot, { maxFiles: 1 }));
	await assert.rejects(
		incomplete.search('fileceilingbeacon84721'),
		/refusing to serve an incomplete retrieval index/u,
	);

	const missingRoot = path.join(crowdedRoot, 'missing-vault-root');
	const unscannable = new KnowledgeIndex(configFor(missingRoot));
	await assert.rejects(
		unscannable.search('anything'),
		/refusing to serve a partial retrieval index/u,
	);
});

test('context assembly enforces its token budget including headers and mixed text', async (t) => {
	const root = await syntheticVault(t);
	await Promise.all(Array.from({ length: 8 }, async (_, index) => {
		const mixed = `${'中文证据与边界。'.repeat(70)} ${'English evidence boundary. '.repeat(55)} 🧠`;
		await writeSynthetic(root, `30-Shared-Knowledge/budget-${index}.md`, frontmatter(
			{ type: 'knowledge-card', status: 'active' },
			`# Budget source ${index}\nbudgetbeacon84721 source ${index}. ${mixed}`,
		));
	}));

	const knowledge = new KnowledgeIndex(configFor(root));
	const context = await knowledge.getContext('budgetbeacon84721', {
		limit: 8,
		maxTokens: 500,
	});

	assert.ok(context.sourcePaths.length > 0);
	assert.ok(context.sourcePaths.length < 8);
	assert.equal(new Set(context.sourcePaths).size, context.sourcePaths.length);
	assert.ok(context.estimatedTokenCount <= 500);
	assert.equal(context.estimatedTokenCount, estimateTokens(context.markdown));
	assert.equal(context.truncated, true);

	const oversizedQueryContext = await knowledge.getContext(
		`${'超长查询'.repeat(600)} budgetbeacon84721`,
		{ limit: 8, maxTokens: 500 },
	);
	assert.ok(oversizedQueryContext.estimatedTokenCount <= 500);
	assert.equal(oversizedQueryContext.truncated, true);
});
