import {
	KnowledgeCorpus,
	RetrievalMode,
	RetrievalScope,
} from './types.js';

export type FrontmatterValue = string | string[] | boolean | number | null;
export type FrontmatterFields = Record<string, FrontmatterValue>;

export interface RetrievalDecision {
	corpus: KnowledgeCorpus;
	retrievalScope: RetrievalScope;
	reason: string;
}

export interface PolicyInput {
	path: string;
	frontmatter: FrontmatterFields;
	body: string;
	title: string;
	tags: string[];
}

const SCOPE_TO_CORPUS: Record<Exclude<RetrievalScope, 'never'>, KnowledgeCorpus> = {
	default: 'core',
	project: 'project',
	reference: 'reference',
	history: 'history',
};

const CORPUS_TO_SCOPE: Record<KnowledgeCorpus, RetrievalScope> = {
	core: 'default',
	project: 'project',
	reference: 'reference',
	history: 'history',
	control: 'never',
	generated: 'never',
};

const HARD_CONTROL_SEGMENTS = new Set([
	'.agents',
	'.codex',
	'.git',
	'.github',
	'.obsidian',
	'.trash',
	'__pycache__',
	'build',
	'dist',
	'node_modules',
]);

const GENERATED_TYPES = new Set([
	'generated',
	'knowledge-index',
	'knowledge-point-index',
	'rag-index',
	'rag-document-map',
]);

const HISTORY_ROLES = new Set([
	'archive-artifact',
	'conversation-archive',
	'source-attachment-reading-copy',
	'historical-output',
	'audit-derived',
]);

const RESTRICTED_SENSITIVITY = new Set([
	'confidential',
	'pii',
	'personal',
	'private',
	'restricted',
	'sensitive',
	'secret',
	'credential',
	'credentials',
	'highly-sensitive',
]);

const NON_RESTRICTED_SENSITIVITY = new Set([
	'internal',
	'low',
	'none',
	'normal',
	'open',
	'public',
	'sanitized',
	'standard',
]);

const NON_RETRIEVABLE_GRAPH_REASON = /(?:generated|system|duplicate|navigation|empty|index|自动生成|生成(?:内容|索引)?|系统|重复|副本|导航|空(?:白|文件|文档)?|索引)/iu;

export function classifyRetrieval(input: PolicyInput): RetrievalDecision {
	const normalizedPath = normalizePath(input.path);
	const lowerPath = normalizedPath.normalize('NFKC').toLocaleLowerCase();
	const segments = lowerPath.split('/');
	const basename = segments.at(-1) ?? '';
	const type = scalar(input.frontmatter.type);
	const status = scalar(input.frontmatter.status);
	const role = scalar(input.frontmatter.record_role) || scalar(input.frontmatter.role);
	const sensitivity = scalar(input.frontmatter.sensitivity);
	const scopeField = parsePolicyField(input.frontmatter, 'retrieval_scope', normalizeScope);
	const corpusField = parsePolicyField(input.frontmatter, 'corpus', normalizeCorpus);
	const explicitScope = scopeField.value;
	const explicitCorpus = corpusField.value;

	if (basename.startsWith('._')) {
		return decision('control', 'never', 'AppleDouble metadata');
	}
	if (segments.some((segment) => HARD_CONTROL_SEGMENTS.has(segment))) {
		return decision('control', 'never', 'control or system path');
	}
	if (basename === 'agents.md' || basename === 'agent.md') {
		return decision('control', 'never', 'agent instruction document');
	}
	if (booleanValue(input.frontmatter.__policy_parse_error)) {
		return decision('control', 'never', 'invalid frontmatter policy syntax');
	}
	if (
		RESTRICTED_SENSITIVITY.has(sensitivity)
		|| /^restricted(?:[-_/]|$)/u.test(sensitivity)
		|| /(?:^|[-_/])(confidential|credential|personal|pii|private|secret|sensitive)(?:[-_/]|$)/u
			.test(sensitivity)
	) {
		return decision('control', 'never', `restricted sensitivity: ${sensitivity}`);
	}
	if (sensitivity && !NON_RESTRICTED_SENSITIVITY.has(sensitivity)) {
		return decision('control', 'never', 'unrecognized sensitivity policy');
	}
	if (segments[0] === '80-knowledge-index' || segments.includes('_generated')) {
		return decision('generated', 'never', 'generated knowledge index');
	}
	if (segments[0] === '99-attachments') {
		return decision('generated', 'never', 'attachment storage path');
	}
	if (scopeField.invalid || corpusField.invalid) {
		const invalidFields = [
			scopeField.invalid ? 'retrieval_scope' : '',
			corpusField.invalid ? 'corpus' : '',
		].filter(Boolean).join(', ');
		return decision('control', 'never', `invalid policy field: ${invalidFields}`);
	}
	if (GENERATED_TYPES.has(type) || booleanValue(input.frontmatter.generated)) {
		return decision('generated', 'never', `generated type: ${type}`);
	}
	// A note is untrusted input. It may always make itself less visible, but a
	// control/generated declaration can never be paired with a broader scope.
	if (explicitCorpus === 'control' || explicitCorpus === 'generated') {
		return decision(explicitCorpus, 'never', `frontmatter corpus: ${explicitCorpus}`);
	}
	if (explicitScope === 'never') {
		return decision('control', 'never', 'frontmatter retrieval_scope');
	}
	if (!meaningfulBody(input.body)) {
		return decision('generated', 'never', 'empty body');
	}

	const graphExcluded = booleanValue(input.frontmatter.graph_exclude);
	const graphExclusionReason = scalar(input.frontmatter.graph_exclude_reason);
	if (graphExcluded && NON_RETRIEVABLE_GRAPH_REASON.test(graphExclusionReason)) {
		return decision(
			'generated',
			'never',
			`graph exclusion: ${graphExclusionReason || 'generated'}`,
		);
	}
	if (isNavigation(input, basename, type)) {
		return decision('generated', 'never', 'navigation or index document');
	}

	// Legacy prompts remain available only through an explicit history search.
	// Frontmatter cannot accidentally elevate instruction corpora into default retrieval.
	let base: RetrievalDecision;
	if (lowerPath.startsWith('50-ai/prompts/legacy/')) {
		base = decision('history', 'history', 'legacy instruction reference');
	} else if (
		booleanValue(input.frontmatter.archived)
		|| /^(?:archived|historical|superseded)/u.test(status)
	) {
		base = decision('history', 'history', 'historical status');
	} else if (HISTORY_ROLES.has(role)) {
		base = decision('history', 'history', `historical role: ${role}`);
	} else if (input.tags.some((tag) => /^(?:archive|status\/imported-archive)(?:\/|$)/iu.test(tag))) {
		base = decision('history', 'history', 'archive tag');
	} else if (graphExcluded) {
		base = decision('history', 'history', 'frontmatter graph_exclude');
	} else if (lowerPath.includes('/ai历史记录/') || lowerPath.includes('/ai-history/')) {
		base = decision('history', 'history', 'AI conversation history path');
	} else if (
		lowerPath.startsWith('40_archive/')
		|| lowerPath.startsWith('40-archive/')
		|| lowerPath.startsWith('90-reports/')
		|| lowerPath.startsWith('01-daily/')
		|| lowerPath.startsWith('05-daily/')
		|| lowerPath.startsWith('50-ai/outputs/')
	) {
		base = decision('history', 'history', 'historical path');
	} else if (lowerPath.startsWith('30-shared-knowledge/')) {
		if (type === 'knowledge-card' && !/(?:filed|draft|pending|superseded)/u.test(status)) {
			base = decision('core', 'default', 'active shared knowledge card');
		} else {
			base = decision('reference', 'reference', 'shared guide or source note');
		}
	} else if (lowerPath.startsWith('50-ai/codex-context/')) {
		base = decision('core', 'default', 'explicit model context');
	} else if (
		lowerPath.startsWith('10-work/')
		|| lowerPath.startsWith('20-competition/')
		|| lowerPath.startsWith('00-inbox/')
		|| lowerPath.startsWith('projects/')
	) {
		base = decision('project', 'project', 'active project path');
	} else if (
		lowerPath.startsWith('40-resources/')
		|| lowerPath.startsWith('60-file-index/')
		|| lowerPath.startsWith('research/')
		|| lowerPath.startsWith('sources/')
	) {
		base = decision('reference', 'reference', 'reference or source path');
	} else {
		base = decision('reference', 'reference', 'unclassified path defaults to reference');
	}

	return applyFrontmatterRestriction(base, explicitScope, explicitCorpus);
}

export function modeAllows(scope: RetrievalScope, mode: RetrievalMode): boolean {
	if (scope === 'never') return false;
	if (scope === 'default') return true;
	return scope === mode;
}

export function retrievalPriority(scope: RetrievalScope): number {
	return {
		default: 0,
		project: 1,
		reference: 2,
		history: 3,
		never: 4,
	}[scope];
}

function decision(
	corpus: KnowledgeCorpus,
	retrievalScope: RetrievalScope,
	reason: string,
): RetrievalDecision {
	return { corpus, retrievalScope, reason };
}

function applyFrontmatterRestriction(
	base: RetrievalDecision,
	explicitScope: RetrievalScope | null,
	explicitCorpus: KnowledgeCorpus | null,
): RetrievalDecision {
	const candidates: Array<{ scope: Exclude<RetrievalScope, 'never'>; corpus: KnowledgeCorpus }> = [];
	if (explicitScope && explicitScope !== 'never') {
		candidates.push({ scope: explicitScope, corpus: SCOPE_TO_CORPUS[explicitScope] });
	}
	if (explicitCorpus && explicitCorpus !== 'control' && explicitCorpus !== 'generated') {
		const corpusScope = CORPUS_TO_SCOPE[explicitCorpus];
		if (corpusScope !== 'never') {
			candidates.push({ scope: corpusScope, corpus: explicitCorpus });
		}
	}
	if (candidates.length === 0) return base;

	const requested = candidates.sort((first, second) => {
		return retrievalPriority(second.scope) - retrievalPriority(first.scope);
	})[0];
	if (!requested) return base;
	if (retrievalPriority(requested.scope) < retrievalPriority(base.retrievalScope)) {
		return decision(
			base.corpus,
			base.retrievalScope,
			`${base.reason}; ignored untrusted frontmatter promotion`,
		);
	}

	const matchingCorpus = explicitCorpus && CORPUS_TO_SCOPE[explicitCorpus] === requested.scope
		? explicitCorpus
		: requested.corpus;
	return decision(matchingCorpus, requested.scope, 'restrictive frontmatter policy');
}

function parsePolicyField<T extends string>(
	frontmatter: FrontmatterFields,
	key: 'retrieval_scope' | 'corpus',
	normalize: (value: string) => T | null,
): { value: T | null; invalid: boolean } {
	if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) {
		return { value: null, invalid: false };
	}
	const raw = frontmatter[key];
	if (Array.isArray(raw)) {
		if (raw.length !== 1) return { value: null, invalid: true };
		const only = raw[0];
		if (typeof only !== 'string') return { value: null, invalid: true };
		const value = normalize(only.trim().toLocaleLowerCase());
		return { value, invalid: value === null };
	}
	if (typeof raw !== 'string' || !raw.trim()) {
		return { value: null, invalid: true };
	}
	const value = normalize(raw.trim().toLocaleLowerCase());
	return { value, invalid: value === null };
}

function normalizeScope(value: string): RetrievalScope | null {
	const normalized = value.replace(/_/gu, '-');
	if (['default', 'core', 'canonical'].includes(normalized)) return 'default';
	if (['project', 'active'].includes(normalized)) return 'project';
	if (['reference', 'source'].includes(normalized)) return 'reference';
	if (['history', 'historical', 'archive'].includes(normalized)) return 'history';
	if (['never', 'none', 'excluded'].includes(normalized)) return 'never';
	return null;
}

function normalizeCorpus(value: string): KnowledgeCorpus | null {
	if (['core', 'canonical'].includes(value)) return 'core';
	if (['project', 'active'].includes(value)) return 'project';
	if (['reference', 'source'].includes(value)) return 'reference';
	if (['history', 'historical', 'archive'].includes(value)) return 'history';
	if (['control', 'system', 'instruction'].includes(value)) return 'control';
	if (['generated', 'derived-index'].includes(value)) return 'generated';
	return null;
}

function scalar(value: FrontmatterValue | undefined): string {
	if (Array.isArray(value)) return String(value[0] ?? '').trim().toLocaleLowerCase();
	if (value === null || value === undefined) return '';
	return String(value).trim().toLocaleLowerCase();
}

function booleanValue(value: FrontmatterValue | undefined): boolean {
	if (value === true || value === 1) return true;
	if (typeof value !== 'string') return false;
	return ['true', 'yes', 'on', '1'].includes(value.trim().toLocaleLowerCase());
}

function meaningfulBody(value: string): boolean {
	return value
		.replace(/<!--[^]*?-->/gu, ' ')
		.replace(/[^0-9A-Za-z\u3400-\u9fff]+/gu, '')
		.length > 0;
}

function isNavigation(input: PolicyInput, basename: string, type: string): boolean {
	if (['index', 'dashboard', 'navigation', 'knowledge-navigation', 'context-index'].includes(type)) {
		return true;
	}
	const names = [basename.replace(/\.md$/iu, ''), input.title, ...input.tags]
		.join(' ')
		.normalize('NFKC')
		.toLocaleLowerCase();
	if (!/(?:readme|index|dashboard|homepage|overview|contents|目录|索引|导航|首页|总览|概览)/iu.test(names)) {
		return false;
	}

	const linkCount =
		(input.body.match(/\[\[[^\]]+\]\]/gu) ?? []).length
		+ (input.body.match(/!?\[[^\]]*\]\([^)]+\)/gu) ?? []).length
		+ (input.body.match(/https?:\/\/\S+/giu) ?? []).length;
	const originalLength = input.body.replace(/[^0-9A-Za-z\u3400-\u9fff]+/gu, '').length;
	const proseLength = input.body
		.replace(/<!--[\s\S]*?-->/gu, ' ')
		.replace(/```[\s\S]*?```/gu, ' ')
		.replace(/^#{1,6}\s+.*$/gmu, ' ')
		.replace(/!?\[\[[^\]]+\]\]/gu, ' ')
		.replace(/!?\[[^\]]*\]\([^)]+\)/gu, ' ')
		.replace(/https?:\/\/\S+/giu, ' ')
		.replace(/^\s*\|.*\|\s*$/gmu, ' ')
		.replace(/^\s*[-*+]\s*/gmu, ' ')
		.replace(/[^0-9A-Za-z\u3400-\u9fff]+/gu, '')
		.length;
	if (linkCount === 0) return false;
	return proseLength < 16
		|| (linkCount >= 3 && (proseLength < 180 || proseLength / Math.max(1, originalLength) < 0.16));
}

function normalizePath(value: string): string {
	return value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
}
