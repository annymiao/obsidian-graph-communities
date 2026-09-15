import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	createChunkId,
	createDocumentId,
	createSourceId,
	createSpanId,
	createVersionId,
	normalizeDocumentPath,
	normalizeSourceIdentity,
} from '../src/stableIds.js';

test('normalizes macOS NFC and NFD spellings to the same identities', () => {
	const nfcSource = '/synthetic/Caf\u00e9 Vault';
	const nfdSource = '/synthetic/Cafe\u0301 Vault';
	assert.equal(normalizeSourceIdentity(nfcSource), normalizeSourceIdentity(nfdSource));
	assert.equal(createSourceId(nfcSource), createSourceId(nfdSource));

	const sourceId = createSourceId(nfcSource);
	assert.equal(
		createDocumentId(sourceId, '研究/R\u00e9sum\u00e9.md'),
		createDocumentId(sourceId, '研究/Re\u0301sume\u0301.md'),
	);
});

test('normalizes Windows source and relative document paths without host dependence', () => {
	const syntheticUncSource = [
		'\\\\',
		'Server',
		'\\',
		'Share',
		'\\',
		'Knowledge',
		'\\',
	].join('');
	assert.equal(
		normalizeSourceIdentity('C:\\Synthetic\\OWNER\\Caf\u00e9 Vault\\'),
		'win32:c:/synthetic/owner/caf\u00e9 vault',
	);
	assert.equal(
		createSourceId('C:\\Synthetic\\OWNER\\Caf\u00e9 Vault\\'),
		createSourceId('c:/synthetic/owner/cafe\u0301 vault'),
	);
	assert.equal(
		createSourceId(syntheticUncSource),
		createSourceId(syntheticUncSource.toLocaleLowerCase()),
	);
	assert.equal(
		normalizeDocumentPath('.\\Projects\\2026\\..\\Plan.md'),
		'Projects/Plan.md',
	);
});

test('derives deterministic hierarchical IDs while separating versions and spans', () => {
	const sourceId = createSourceId('obsidian:shared-test-vault');
	const documentId = createDocumentId(sourceId, 'Projects/Memory.md');
	const sameDocumentId = createDocumentId(sourceId, 'Projects\\.\\Memory.md');
	assert.equal(documentId, sameDocumentId);

	const versionId = createVersionId(documentId, {
		content: '\uFEFF# Caf\u00e9\r\nEvidence\r\n',
	});
	const portableVersionId = createVersionId(documentId, {
		content: '# Cafe\u0301\nEvidence\n',
	});
	assert.equal(versionId, portableVersionId);
	assert.notEqual(
		versionId,
		createVersionId(documentId, { content: '# Caf\u00e9\nChanged\n' }),
	);
	assert.notEqual(
		createVersionId(documentId, { version: 'connector-revision-7' }),
		createVersionId(documentId, { version: 'connector-revision-8' }),
	);

	const spanId = createSpanId(versionId, { startLine: 1, endLine: 2 });
	assert.equal(spanId, createSpanId(versionId, { startLine: 1, endLine: 2 }));
	assert.notEqual(spanId, createSpanId(versionId, { startLine: 2, endLine: 2 }));

	const chunkId = createChunkId(spanId, '# Caf\u00e9\r\nEvidence');
	assert.equal(chunkId, createChunkId(spanId, '# Cafe\u0301\nEvidence'));
	assert.notEqual(chunkId, createChunkId(spanId, '# Caf\u00e9\nOther evidence'));
	assert.deepEqual(
		[sourceId, documentId, versionId, spanId, chunkId],
		[
			'src_v1_NEa4ztRxm27WJG1M4YtnwnCjijscIyKzwNB9KAidfzI',
			'doc_v1_g1JHppnPi8rb7fUj4ynqpKvDWc16D0locdrbb0QZ97g',
			'ver_v1_hhgYiqXK8L7UY1Yf0ISklc0wBz3hgAODwJ9aqRNXhuQ',
			'spn_v1_Shd7eIM5j5LQqYZUPxvvfKLCo5PN5-MmaWGuQraepbc',
			'chk_v1_7QcQK1V6QUliVYTgjoxg-cJ3vwwVQUrwuGbTiPzvycM',
		],
		'v1 IDs are a persisted compatibility contract',
	);

	for (const id of [sourceId, documentId, versionId, spanId, chunkId]) {
		assert.match(id, /^(?:src|doc|ver|spn|chk)_v1_[A-Za-z0-9_-]{43}$/u);
	}
});

test('public IDs never embed absolute paths or document names', () => {
	const privatePath = '/synthetic/Private Vault';
	const sourceId = createSourceId(privatePath);
	const documentId = createDocumentId(sourceId, 'Secrets/Do Not Export.md');
	const versionId = createVersionId(documentId, { content: 'private evidence' });

	for (const id of [sourceId, documentId, versionId]) {
		assert.equal(id.includes('/synthetic'), false);
		assert.equal(id.includes('Private'), false);
		assert.equal(id.includes('Secrets'), false);
		assert.equal(id.includes('Do Not Export'), false);
	}
});

test('rejects absolute, escaping, ambiguous, and invalid identity inputs', () => {
	const sourceId = createSourceId('test-vault');
	const syntheticUncDocument = ['\\\\', 'server', '\\', 'share', '\\', 'note.md'].join('');
	assert.throws(() => createDocumentId(sourceId, '/private/note.md'), /relative/u);
	assert.throws(() => createDocumentId(sourceId, 'C:\\private\\note.md'), /relative/u);
	assert.throws(() => createDocumentId(sourceId, syntheticUncDocument), /relative/u);
	assert.throws(() => createDocumentId(sourceId, '../outside.md'), /escape/u);

	const documentId = createDocumentId(sourceId, 'inside.md');
	assert.throws(
		() => createVersionId(documentId, {} as never),
		/exactly one/u,
	);
	assert.throws(
		() => createVersionId(documentId, { content: 'x', version: 'v1' } as never),
		/exactly one/u,
	);
	const versionId = createVersionId(documentId, { content: 'x' });
	assert.throws(
		() => createSpanId(versionId, { startLine: 3, endLine: 2 }),
		/must not precede/u,
	);
	assert.throws(
		() => createSpanId(versionId, { startLine: 1, endLine: 1, startColumn: 2 }),
		/supplied together/u,
	);
});
