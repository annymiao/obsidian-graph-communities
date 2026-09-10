import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	classifyRetrieval,
	FrontmatterFields,
} from '../src/retrievalPolicy.js';

function classify(
	path: string,
	frontmatter: FrontmatterFields = {},
	body = 'A meaningful body with a stable and independently verifiable conclusion.',
	title = 'Evidence note',
) {
	return classifyRetrieval({ path, frontmatter, body, title, tags: [] });
}

test('untrusted frontmatter can narrow policy but cannot promote a path to default', () => {
	assert.deepEqual(
		classify('40-Resources/imported.md', {
			corpus: 'core',
			retrieval_scope: 'default',
		}),
		{
			corpus: 'reference',
			retrievalScope: 'reference',
			reason: 'reference or source path; ignored untrusted frontmatter promotion',
		},
	);
	assert.equal(
		classify('10-Work/project.md', { retrieval_scope: 'default' }).retrievalScope,
		'project',
	);
	assert.equal(
		classify('30-Shared-Knowledge/card.md', {
			type: 'knowledge-card',
			status: 'active',
			retrieval_scope: 'history',
		}).retrievalScope,
		'history',
	);
});

test('generated declarations and attachment storage remain never', () => {
	const attemptedPromotion = { corpus: 'core', retrieval_scope: 'default' };
	assert.equal(
		classify('Imported/generated.md', { ...attemptedPromotion, generated: true }).retrievalScope,
		'never',
	);
	assert.equal(
		classify('Imported/generated.md', { corpus: 'generated', retrieval_scope: 'default' }).retrievalScope,
		'never',
	);
	assert.equal(
		classify('99-Attachments/reading.md', attemptedPromotion).retrievalScope,
		'never',
	);
});

test('Chinese structural graph exclusion reasons are never indexed', () => {
	for (const reason of ['自动生成的知识索引', '系统文件', '重复副本', '纯导航', '空文件']) {
		const result = classify('Projects/artifact.md', {
			graph_exclude: true,
			graph_exclude_reason: reason,
		});
		assert.equal(result.retrievalScope, 'never', reason);
	}
});

test('link-only navigation is never but a substantive README remains reference', () => {
	const navigation = classify(
		'30-Shared-Knowledge/知识导航.md',
		{},
		'# 知识导航\n- [[A]]\n- [[B]]\n- [[C]]',
		'知识导航',
	);
	assert.equal(navigation.retrievalScope, 'never');

	const readme = classify(
		'40-Resources/README.md',
		{},
		'# README\nThis document explains the source methodology, limitations, provenance, and verification process in substantial detail without acting as a link list.',
		'README',
	);
	assert.equal(readme.retrievalScope, 'reference');
});
