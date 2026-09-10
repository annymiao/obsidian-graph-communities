import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	classifyRetrieval,
	FrontmatterFields,
	modeAllows,
} from '../src/retrievalPolicy.js';
import { RetrievalMode, RetrievalScope } from '../src/types.js';

function classify(path: string, frontmatter: FrontmatterFields = {}) {
	return classifyRetrieval({
		path,
		frontmatter,
		body: 'Synthetic regression evidence with a unique and meaningful conclusion.',
		title: 'Synthetic regression note',
		tags: [],
	});
}

test('retrieval modes expand only their declared corpus and never include never', () => {
	const expected: Record<RetrievalMode, RetrievalScope[]> = {
		default: ['default'],
		project: ['default', 'project'],
		reference: ['default', 'reference'],
		history: ['default', 'history'],
	};
	const scopes: RetrievalScope[] = ['default', 'project', 'reference', 'history', 'never'];

	for (const [mode, allowed] of Object.entries(expected) as Array<[
		RetrievalMode,
		RetrievalScope[],
	]>) {
		for (const scope of scopes) {
			assert.equal(
				modeAllows(scope, mode),
				allowed.includes(scope),
				`${mode} should ${allowed.includes(scope) ? '' : 'not '}allow ${scope}`,
			);
		}
	}
});

test('hard control, generated, and sensitive notes cannot promote themselves to default', () => {
	const attemptedPromotion: FrontmatterFields = {
		corpus: 'core',
		retrieval_scope: 'default',
	};
	const cases: Array<[string, FrontmatterFields]> = [
		['.agents/AGENTS.md', attemptedPromotion],
		['80-Knowledge-Index/generated.md', attemptedPromotion],
		['Generated/note.md', { ...attemptedPromotion, type: 'knowledge-index' }],
		['Private/credential.md', { ...attemptedPromotion, sensitivity: 'secret' }],
		['Private/summary.md', { ...attemptedPromotion, sensitivity: 'restricted-summary' }],
		['Private/summary-slash.md', { ...attemptedPromotion, sensitivity: 'restricted/summary' }],
		['Private/summary-underscore.md', { ...attemptedPromotion, sensitivity: 'restricted_summary' }],
	];

	for (const [path, frontmatter] of cases) {
		const decision = classify(path, frontmatter);
		assert.equal(decision.retrievalScope, 'never', `${path} must remain isolated`);
	}
});

test('legacy prompts cannot use frontmatter to enter default retrieval', () => {
	const decision = classify('50-AI/Prompts/Legacy/instruction.md', {
		corpus: 'core',
		retrieval_scope: 'default',
	});

	assert.equal(decision.corpus, 'history');
	assert.equal(decision.retrievalScope, 'history');
});

test('invalid or multi-valued policy fields are quarantined instead of ignored', () => {
	const cases: FrontmatterFields[] = [
		{ retrieval_scope: 'default-with-override' },
		{ corpus: 'core-with-override' },
		{ retrieval_scope: ['default', 'never'] },
		{ corpus: ['core', 'history'] },
	];

	for (const frontmatter of cases) {
		const decision = classify('30-Shared-Knowledge/candidate.md', {
			...frontmatter,
			type: 'knowledge-card',
			status: 'active',
		});
		assert.equal(decision.retrievalScope, 'never');
	}
});

test('sanitized sensitivity is eligible while unknown sensitivity fails closed', () => {
	assert.equal(classify('30-Shared-Knowledge/safe.md', {
		type: 'knowledge-card',
		status: 'active',
		sensitivity: 'sanitized',
	}).retrievalScope, 'default');
	assert.equal(classify('30-Shared-Knowledge/unknown.md', {
		type: 'knowledge-card',
		status: 'active',
		sensitivity: 'custom-unknown-level',
	}).retrievalScope, 'never');
});

test('legacy graph exclusions remain available only through explicit history mode', () => {
	const decision = classify('Projects/retired-decision.md', {
		graph_exclude: true,
		graph_exclude_reason: 'superseded decision',
	});

	assert.equal(decision.corpus, 'history');
	assert.equal(decision.retrievalScope, 'history');
	assert.equal(modeAllows(decision.retrievalScope, 'default'), false);
	assert.equal(modeAllows(decision.retrievalScope, 'history'), true);
});
