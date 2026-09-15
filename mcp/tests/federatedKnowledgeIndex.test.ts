import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	createKnowledgeAccess,
	FederatedKnowledgeIndex,
} from '../src/federatedKnowledgeIndex.js';
import type { ServerConfig } from '../src/types.js';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

function sourceConfig(root: string, id: string, name: string): ServerConfig {
	return {
		vaultPath: root,
		vaultName: path.basename(root),
		sourceName: name,
		sourceIdentity: id,
		artifactPath: null,
		excludedFolders: new Set(['.git', '.obsidian', '.trash', 'node_modules']),
		indexTtlMs: 60_000,
		maxFileCharacters: 5_000_000,
		maxFiles: 25_000,
		chunkTokens: 700,
		chunkOverlapTokens: 80,
		defaultContextTokens: 4_000,
		maxSourceTokens: 900,
		transmissionReviewMode: 'required',
	};
}

test('federated search, context, read, related, and overview form one bounded loop', async (t) => {
	const firstRoot = await createFixtureVault();
	const secondRoot = await createFixtureVault();
	t.after(async () => {
		await Promise.all([removeFixtureVault(firstRoot), removeFixtureVault(secondRoot)]);
	});
	const knowledge = new FederatedKnowledgeIndex([
		sourceConfig(firstRoot, 'source:first', 'First library'),
		sourceConfig(secondRoot, 'source:second', 'Second library'),
	]);

	const firstSearch = await knowledge.searchWithDiagnostics('Codex writing system', { limit: 4 });
	const secondSearch = await knowledge.searchWithDiagnostics('Codex writing system', { limit: 4 });
	assert.deepEqual(firstSearch, secondSearch);
	assert.equal(firstSearch.sourceFailures.length, 0);
	assert.ok(firstSearch.matches.length >= 2);
	assert.deepEqual(
		new Set(firstSearch.matches.map((match) => match.sourceName)),
		new Set(['First library', 'Second library']),
	);
	assert.ok(firstSearch.matches.every((match) => match.sourceId.startsWith('src_v1_')));
	assert.equal(JSON.stringify(firstSearch).includes(firstRoot), false);
	assert.equal(JSON.stringify(firstSearch).includes(secondRoot), false);

	const selected = firstSearch.matches[0];
	assert.ok(selected);
	await assert.rejects(
		knowledge.readNote(selected.path),
		/source_id is required/u,
	);
	const note = await knowledge.readNote(
		selected.path,
		undefined,
		20_000,
		'default',
		selected.sourceId,
	);
	assert.equal(note.sourceId, selected.sourceId);
	assert.equal(note.sourceName, selected.sourceName);

	const related = await knowledge.getRelatedNotes(
		selected.path,
		2,
		12,
		'default',
		selected.sourceId,
	);
	assert.ok(related.every((item) => item.sourceId === selected.sourceId));
	assert.ok(related.every((item) => item.sourceName === selected.sourceName));

	const context = await knowledge.getContext('Codex writing system', {
		limit: 4,
		maxTokens: 1_600,
	});
	assert.ok(context.estimatedTokenCount <= 1_600);
	assert.ok(context.sourceReferences.length > 0);
	assert.match(context.markdown, /Knowledge source: (First|Second) library/u);
	assert.equal(context.sourceFailures.length, 0);

	const overview = await knowledge.getStats();
	assert.equal(overview.kind, 'federated');
	assert.equal(overview.sourceCount, 2);
	assert.equal(overview.availableSourceCount, 2);
	assert.equal(overview.failedSourceCount, 0);
	assert.deepEqual(overview.sourceNames, ['First library', 'Second library']);
	assert.equal(overview.noteCount, 6);
	assert.equal(JSON.stringify(overview).includes(firstRoot), false);
	assert.equal(JSON.stringify(overview).includes(secondRoot), false);
});

test('one unavailable source is explicit while available sources still answer', async (t) => {
	const availableRoot = await createFixtureVault();
	const missingParent = await mkdtemp(path.join(tmpdir(), 'obsidian-federated-missing-'));
	const missingRoot = path.join(missingParent, 'not-present');
	t.after(async () => {
		await removeFixtureVault(availableRoot);
		await rm(missingParent, { recursive: true, force: true });
	});
	const knowledge = new FederatedKnowledgeIndex([
		sourceConfig(availableRoot, 'source:available', 'Available library'),
		sourceConfig(missingRoot, 'source:missing', 'Unavailable library'),
	]);

	const search = await knowledge.searchWithDiagnostics('Codex writing system', { limit: 4 });
	assert.ok(search.matches.length > 0);
	assert.equal(search.sourceFailures.length, 1);
	assert.equal(search.sourceFailures[0]?.sourceName, 'Unavailable library');
	assert.equal(JSON.stringify(search.sourceFailures).includes(missingRoot), false);

	const context = await knowledge.getContext('Codex writing system', { maxTokens: 1_600 });
	assert.equal(context.sourceFailures.length, 1);
	assert.match(context.markdown, /Partial source failures \(1\): Unavailable library/u);

	const overview = await knowledge.getStats();
	assert.equal(overview.availableSourceCount, 1);
	assert.equal(overview.failedSourceCount, 1);
});

test('all unavailable sources fail explicitly instead of returning an empty match set', async (t) => {
	const parent = await mkdtemp(path.join(tmpdir(), 'obsidian-federated-all-missing-'));
	t.after(() => rm(parent, { recursive: true, force: true }));
	const knowledge = new FederatedKnowledgeIndex([
		sourceConfig(path.join(parent, 'first'), 'missing:first', 'Missing first'),
		sourceConfig(path.join(parent, 'second'), 'missing:second', 'Missing second'),
	]);
	await assert.rejects(
		knowledge.searchWithDiagnostics('anything'),
		/All configured knowledge sources failed during search/u,
	);
});

test('a one-item logical catalog keeps aggregate overview semantics without read ambiguity', async (t) => {
	const root = await createFixtureVault();
	t.after(() => removeFixtureVault(root));
	const config = sourceConfig(root, 'source:only', 'Only logical library');
	const knowledge = createKnowledgeAccess([config], true);

	const search = await knowledge.searchWithDiagnostics('Codex writing system', { limit: 1 });
	const selected = search.matches[0];
	assert.ok(selected);
	const note = await knowledge.readNote(selected.path);
	assert.equal(note.sourceName, 'Only logical library');

	const overview = await knowledge.getStats();
	assert.equal('kind' in overview ? overview.kind : undefined, 'federated');
	if (!('kind' in overview) || overview.kind !== 'federated') {
		assert.fail('Expected a federated logical-catalog overview.');
	}
	assert.deepEqual(overview.sourceNames, ['Only logical library']);
	assert.equal(JSON.stringify(overview).includes(root), false);
});
