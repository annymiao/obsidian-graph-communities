import { createDocumentId, createVersionId, normalizeDocumentPath } from '../stableIds.js';
import type { SourceId } from '../stableIds.js';
import {
	CONTROLLED_WRITE_SCHEMA_VERSION,
	type BaseVersion,
	type CorrectionProposal,
	type DiffHunk,
	type DiffLine,
	type DocumentSnapshot,
	type ModelActor,
	type ReingestOutcome,
	type RiskAssessment,
	type RiskLevel,
	type RollbackDegradation,
	type RollbackPlan,
	type RollbackReceipt,
	type SourceRef,
	type StructuredDiff,
	type WriteOperation,
	type WriteDegradation,
	type WritePlan,
	type WriteReceipt,
} from './contracts.js';
import {
	assertIsoTimestamp,
	assertNonEmptyText,
	assertSha256,
	canonicalJson,
	sha256,
} from './integrity.js';

const SOURCE_ID_PATTERN = /^src_v1_[A-Za-z0-9_-]{43}$/u;
const DOCUMENT_ID_PATTERN = /^doc_v1_[A-Za-z0-9_-]{43}$/u;
const VERSION_ID_PATTERN = /^ver_v1_[A-Za-z0-9_-]{43}$/u;
const MAX_PROPOSAL_BYTES = 8 * 1024 * 1024;
const MAXIMUM_LCS_CELLS = 250_000;
const DIFF_CONTEXT_LINES = 2;

export interface CorrectionProposalInput {
	source: SourceRef;
	operation: WriteOperation;
	proposer: ModelActor;
	rationale: string;
	beforeContent: string | null;
	afterContent: string | null;
	createdAt?: string;
}

export interface RollbackPlanInput {
	receipt: WriteReceipt;
	initiatedBy: ModelActor;
	reason: string;
	createdAt?: string;
}

export function createSourceRef(
	adapterId: string,
	sourceId: SourceId,
	documentPath: string,
): SourceRef {
	assertNonEmptyText(adapterId, 'adapterId', 128);
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(adapterId)) {
		throw new TypeError('adapterId contains unsupported characters.');
	}
	if (!SOURCE_ID_PATTERN.test(sourceId)) throw new TypeError('sourceId is invalid.');
	const normalizedPath = normalizeDocumentPath(documentPath);
	return {
		adapterId,
		sourceId,
		documentId: createDocumentId(sourceId, normalizedPath),
		documentPath: normalizedPath,
	};
}

export function createDocumentSnapshot(source: SourceRef, content: string): DocumentSnapshot {
	assertSourceRef(source);
	if (typeof content !== 'string') throw new TypeError('Document content must be a string.');
	const bytes = Buffer.from(content, 'utf8');
	if (bytes.byteLength > MAX_PROPOSAL_BYTES) {
		throw new RangeError(`Document content exceeds ${MAX_PROPOSAL_BYTES} UTF-8 bytes.`);
	}
	return {
		content,
		baseVersion: {
			versionId: createVersionId(source.documentId, { content }),
			contentSha256: sha256(bytes),
			byteLength: bytes.byteLength,
		},
	};
}

export function createCorrectionProposal(input: CorrectionProposalInput): CorrectionProposal {
	assertSourceRef(input.source);
	assertActor(input.proposer);
	assertNonEmptyText(input.rationale, 'proposal rationale', 16_384);
	const createdAt = input.createdAt ?? new Date().toISOString();
	assertIsoTimestamp(createdAt, 'proposal createdAt');
	assertOperationContents(input.operation, input.beforeContent, input.afterContent);

	const before = input.beforeContent === null
		? null
		: createDocumentSnapshot(input.source, input.beforeContent);
	const after = input.afterContent === null
		? null
		: createDocumentSnapshot(input.source, input.afterContent);
	if (before?.baseVersion.contentSha256 === after?.baseVersion.contentSha256) {
		throw new TypeError('A correction proposal must change the document content.');
	}

	const diff = createStructuredDiff(before?.content ?? null, after?.content ?? null);
	const risk = assessWriteRisk(input.source, input.operation, before?.content ?? null, after?.content ?? null, diff);
	const material = {
		schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
		createdAt,
		source: input.source,
		operation: input.operation,
		proposer: input.proposer,
		rationale: input.rationale,
		before,
		after,
		diff,
		risk,
	};
	const proposalHash = sha256(canonicalJson(material));
	return {
		...material,
		proposalId: `proposal_v1_${proposalHash}`,
		proposalHash,
	};
}

export function validateCorrectionProposal(proposal: CorrectionProposal): void {
	if (proposal.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new TypeError('Unsupported correction proposal schema version.');
	}
	assertSourceRef(proposal.source);
	assertActor(proposal.proposer);
	assertNonEmptyText(proposal.rationale, 'proposal rationale', 16_384);
	assertIsoTimestamp(proposal.createdAt, 'proposal createdAt');
	assertSha256(proposal.proposalHash, 'proposalHash');
	assertOperationContents(
		proposal.operation,
		proposal.before?.content ?? null,
		proposal.after?.content ?? null,
	);
	if (proposal.before) assertSnapshot(proposal.source, proposal.before, 'before');
	if (proposal.after) assertSnapshot(proposal.source, proposal.after, 'after');

	const expectedDiff = createStructuredDiff(
		proposal.before?.content ?? null,
		proposal.after?.content ?? null,
	);
	if (canonicalJson(expectedDiff) !== canonicalJson(proposal.diff)) {
		throw new TypeError('Proposal structured diff does not match before/after content.');
	}
	const expectedRisk = assessWriteRisk(
		proposal.source,
		proposal.operation,
		proposal.before?.content ?? null,
		proposal.after?.content ?? null,
		expectedDiff,
	);
	if (canonicalJson(expectedRisk) !== canonicalJson(proposal.risk)) {
		throw new TypeError('Proposal risk assessment does not match its content.');
	}
	const expectedHash = hashProposal(proposal);
	if (proposal.proposalHash !== expectedHash || proposal.proposalId !== `proposal_v1_${expectedHash}`) {
		throw new TypeError('Proposal integrity check failed.');
	}
}

export function createWritePlan(
	proposal: CorrectionProposal,
	plannedAt = new Date().toISOString(),
): WritePlan {
	validateCorrectionProposal(proposal);
	assertIsoTimestamp(plannedAt, 'plan plannedAt');
	const material = {
		schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
		proposalHash: proposal.proposalHash,
		plannedAt,
		source: proposal.source,
		operation: proposal.operation,
		expectedBase: proposal.before?.baseVersion ?? null,
		desiredVersion: proposal.after?.baseVersion ?? null,
		afterContent: proposal.after?.content ?? null,
		diff: proposal.diff,
		risk: proposal.risk,
	};
	const planHash = sha256(canonicalJson(material));
	return {
		...material,
		planId: `plan_v1_${planHash}`,
		planHash,
	};
}

export function validateWritePlan(plan: WritePlan): void {
	if (plan.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new TypeError('Unsupported write plan schema version.');
	}
	assertSourceRef(plan.source);
	assertIsoTimestamp(plan.plannedAt, 'plan plannedAt');
	assertSha256(plan.proposalHash, 'plan proposalHash');
	assertSha256(plan.planHash, 'planHash');
	if (plan.expectedBase) assertBaseVersion(plan.expectedBase, 'expectedBase');
	if (plan.desiredVersion) assertBaseVersion(plan.desiredVersion, 'desiredVersion');
	assertOperationContents(
		plan.operation,
		plan.expectedBase === null ? null : '',
		plan.afterContent,
	);
	if (plan.afterContent !== null) {
		const expected = createDocumentSnapshot(plan.source, plan.afterContent).baseVersion;
		if (canonicalJson(expected) !== canonicalJson(plan.desiredVersion)) {
			throw new TypeError('Write plan desiredVersion does not match afterContent.');
		}
	} else if (plan.desiredVersion !== null) {
		throw new TypeError('Write plan without afterContent must not have desiredVersion.');
	}
	const expectedHash = hashWritePlan(plan);
	if (plan.planHash !== expectedHash || plan.planId !== `plan_v1_${expectedHash}`) {
		throw new TypeError('Write plan integrity check failed.');
	}
}

export function createRollbackPlan(input: RollbackPlanInput): RollbackPlan {
	validateWriteReceipt(input.receipt);
	assertActor(input.initiatedBy);
	assertNonEmptyText(input.reason, 'rollback reason', 16_384);
	const createdAt = input.createdAt ?? new Date().toISOString();
	assertIsoTimestamp(createdAt, 'rollback createdAt');
	const risk: RiskAssessment = {
		level: 'high',
		reasons: ['rollback_changes_published_state', 'rollback_requires_fresh_approval'],
		requiresHumanApproval: true,
	};
	const material = {
		schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
		createdAt,
		initiatedBy: input.initiatedBy,
		reason: input.reason,
		receipt: input.receipt,
		risk,
	};
	const rollbackHash = sha256(canonicalJson(material));
	return {
		...material,
		rollbackId: `rollback_v1_${rollbackHash}`,
		rollbackHash,
	};
}

export function validateRollbackPlan(plan: RollbackPlan): void {
	if (plan.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new TypeError('Unsupported rollback schema version.');
	}
	validateWriteReceipt(plan.receipt);
	assertActor(plan.initiatedBy);
	assertNonEmptyText(plan.reason, 'rollback reason', 16_384);
	assertIsoTimestamp(plan.createdAt, 'rollback createdAt');
	if (
		plan.risk.level !== 'high'
		|| plan.risk.requiresHumanApproval !== true
		|| canonicalJson(plan.risk.reasons) !== canonicalJson([
			'rollback_changes_published_state',
			'rollback_requires_fresh_approval',
		])
	) {
		throw new TypeError('Rollback risk assessment is invalid.');
	}
	const { rollbackId: _rollbackId, rollbackHash: _rollbackHash, ...material } = plan;
	const expectedHash = sha256(canonicalJson(material));
	if (plan.rollbackHash !== expectedHash || plan.rollbackId !== `rollback_v1_${expectedHash}`) {
		throw new TypeError('Rollback plan integrity check failed.');
	}
}

export function hashWriteReceipt(receipt: Omit<WriteReceipt, 'receiptHash' | 'receiptId'>): string {
	return sha256(canonicalJson(receipt));
}

export function validateWriteReceipt(receipt: WriteReceipt): void {
	if (receipt.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new TypeError('Unsupported write receipt schema version.');
	}
	assertSourceRef(receipt.source);
	assertSha256(receipt.proposalHash, 'receipt proposalHash');
	assertSha256(receipt.planHash, 'receipt planHash');
	assertSha256(receipt.receiptHash, 'receiptHash');
	if (receipt.commitAuditHash !== null) assertSha256(receipt.commitAuditHash, 'commitAuditHash');
	if (receipt.reingestAuditHash !== null) assertSha256(receipt.reingestAuditHash, 'reingestAuditHash');
	if (receipt.previousVersion) assertBaseVersion(receipt.previousVersion, 'previousVersion');
	if (receipt.committedVersion) assertBaseVersion(receipt.committedVersion, 'committedVersion');
	assertIsoTimestamp(receipt.committedAt, 'receipt committedAt');
	assertWriteDegradations(receipt.degradations);
	if (receipt.outcome === 'committed') {
		if (receipt.degradations.length !== 0 || receipt.commitAuditHash === null || receipt.reingestAuditHash === null) {
			throw new TypeError('A committed receipt must have complete audit evidence and no degradation.');
		}
	} else if (receipt.outcome === 'committed_but_degraded') {
		if (receipt.degradations.length === 0) {
			throw new TypeError('A degraded receipt must name at least one degradation.');
		}
	} else {
		throw new TypeError('Write receipt outcome is invalid.');
	}
	validateReingestOutcome(receipt.reingest);
	assertNonEmptyText(receipt.rollbackToken, 'receipt rollbackToken', 2_048);
	const { receiptHash: _receiptHash, receiptId: _receiptId, ...material } = receipt;
	const expectedHash = hashWriteReceipt(material);
	if (receipt.receiptHash !== expectedHash || receipt.receiptId !== `receipt_v1_${expectedHash}`) {
		throw new TypeError('Write receipt integrity check failed.');
	}
}

export function validateRollbackReceipt(receipt: RollbackReceipt): void {
	if (receipt.schemaVersion !== CONTROLLED_WRITE_SCHEMA_VERSION) {
		throw new TypeError('Unsupported rollback receipt schema version.');
	}
	assertSourceRef(receipt.source);
	assertSha256(receipt.rollbackHash, 'rollback receipt hash binding');
	assertSha256(receipt.receiptHash, 'rollback receiptHash');
	if (receipt.auditHash !== null) assertSha256(receipt.auditHash, 'rollback auditHash');
	if (receipt.reingestAuditHash !== null) {
		assertSha256(receipt.reingestAuditHash, 'rollback reingestAuditHash');
	}
	if (receipt.restoredVersion) assertBaseVersion(receipt.restoredVersion, 'restoredVersion');
	assertIsoTimestamp(receipt.rolledBackAt, 'rollback rolledBackAt');
	assertRollbackDegradations(receipt.degradations);
	if (receipt.outcome === 'rolled_back') {
		if (receipt.degradations.length !== 0 || receipt.auditHash === null || receipt.reingestAuditHash === null) {
			throw new TypeError('A rolled-back receipt must have complete audit evidence and no degradation.');
		}
	} else if (receipt.outcome === 'rolled_back_but_degraded') {
		if (receipt.degradations.length === 0) {
			throw new TypeError('A degraded rollback receipt must name at least one degradation.');
		}
	} else {
		throw new TypeError('Rollback receipt outcome is invalid.');
	}
	validateReingestOutcome(receipt.reingest);
	const { receiptHash: _receiptHash, receiptId: _receiptId, ...material } = receipt;
	const expectedHash = sha256(canonicalJson(material));
	if (
		receipt.receiptHash !== expectedHash
		|| receipt.receiptId !== `rollback_receipt_v1_${expectedHash}`
	) throw new TypeError('Rollback receipt integrity check failed.');
}

export function createStructuredDiff(before: string | null, after: string | null): StructuredDiff {
	const beforeLines = before === null ? [] : splitLines(before);
	const afterLines = after === null ? [] : splitLines(after);
	const useLcs = beforeLines.length * afterLines.length <= MAXIMUM_LCS_CELLS;
	const raw = useLcs
		? lcsDiff(beforeLines, afterLines)
		: boundedReplacementDiff(beforeLines, afterLines);
	const hunks = buildHunks(raw);
	return {
		algorithm: useLcs ? 'line-lcs-v1' : 'bounded-replacement-v1',
		beforeSha256: before === null ? null : sha256(Buffer.from(before, 'utf8')),
		afterSha256: after === null ? null : sha256(Buffer.from(after, 'utf8')),
		insertedLines: raw.filter((line) => line.kind === 'insert').length,
		deletedLines: raw.filter((line) => line.kind === 'delete').length,
		hunks,
	};
}

export function compareRisk(first: RiskLevel, second: RiskLevel): number {
	const ranks: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
	return ranks[first] - ranks[second];
}

function assessWriteRisk(
	source: SourceRef,
	operation: WriteOperation,
	before: string | null,
	after: string | null,
	diff: StructuredDiff,
): RiskAssessment {
	const reasons: string[] = [];
	let level: RiskLevel = 'medium';
	const segments = source.documentPath.split('/');
	if (segments.some((segment) => segment.startsWith('.'))) {
		level = 'critical';
		reasons.push('hidden_or_control_path');
	}
	if (operation === 'delete') {
		if (level !== 'critical') level = 'high';
		reasons.push('document_deletion');
	} else if (operation === 'create') {
		reasons.push('new_document');
	} else {
		const changedLines = diff.insertedLines + diff.deletedLines;
		const beforeLength = Math.max(Buffer.byteLength(before ?? '', 'utf8'), 1);
		const afterLength = Buffer.byteLength(after ?? '', 'utf8');
		const removedFraction = Math.max(0, beforeLength - afterLength) / beforeLength;
		if (frontmatter(before) !== frontmatter(after)) {
			level = 'high';
			reasons.push('frontmatter_changed');
		}
		if (removedFraction >= 0.8) {
			level = 'critical';
			reasons.push('most_content_removed');
		} else if (removedFraction >= 0.5 || changedLines > 100) {
			if (compareRisk(level, 'high') < 0) level = 'high';
			reasons.push(removedFraction >= 0.5 ? 'large_content_removal' : 'large_edit');
		} else if (changedLines <= 4 && removedFraction <= 0.1 && reasons.length === 0) {
			level = 'low';
			reasons.push('small_local_edit');
		} else if (reasons.length === 0) {
			reasons.push('document_content_changed');
		}
	}
	return { level, reasons: [...new Set(reasons)].sort(), requiresHumanApproval: true };
}

function hashProposal(proposal: CorrectionProposal): string {
	const { proposalId: _proposalId, proposalHash: _proposalHash, ...material } = proposal;
	return sha256(canonicalJson(material));
}

function hashWritePlan(plan: WritePlan): string {
	const { planId: _planId, planHash: _planHash, ...material } = plan;
	return sha256(canonicalJson(material));
}

function assertSourceRef(source: SourceRef): void {
	assertNonEmptyText(source.adapterId, 'source adapterId', 128);
	if (!SOURCE_ID_PATTERN.test(source.sourceId)) throw new TypeError('SourceRef sourceId is invalid.');
	if (!DOCUMENT_ID_PATTERN.test(source.documentId)) throw new TypeError('SourceRef documentId is invalid.');
	const normalized = normalizeDocumentPath(source.documentPath);
	if (normalized !== source.documentPath) throw new TypeError('SourceRef documentPath is not normalized.');
	if (createDocumentId(source.sourceId, normalized) !== source.documentId) {
		throw new TypeError('SourceRef documentId is not bound to sourceId and documentPath.');
	}
}

function assertActor(actor: ModelActor): void {
	assertNonEmptyText(actor.clientId, 'actor clientId', 256);
	if (actor.modelProvider !== undefined) {
		assertNonEmptyText(actor.modelProvider, 'actor modelProvider', 256);
	}
	if (actor.modelName !== undefined) assertNonEmptyText(actor.modelName, 'actor modelName', 256);
}

function assertSnapshot(source: SourceRef, snapshot: DocumentSnapshot, label: string): void {
	const expected = createDocumentSnapshot(source, snapshot.content);
	if (canonicalJson(expected.baseVersion) !== canonicalJson(snapshot.baseVersion)) {
		throw new TypeError(`${label} snapshot version does not match its content.`);
	}
}

function assertBaseVersion(version: BaseVersion, label: string): void {
	if (!VERSION_ID_PATTERN.test(version.versionId)) throw new TypeError(`${label} versionId is invalid.`);
	assertSha256(version.contentSha256, `${label} contentSha256`);
	if (!Number.isSafeInteger(version.byteLength) || version.byteLength < 0) {
		throw new TypeError(`${label} byteLength must be a non-negative safe integer.`);
	}
}

function assertOperationContents(
	operation: WriteOperation,
	before: string | null,
	after: string | null,
): void {
	if (!['create', 'replace', 'delete'].includes(operation)) {
		throw new TypeError('Unsupported write operation.');
	}
	if (operation === 'create' && (before !== null || after === null)) {
		throw new TypeError('Create requires a missing base and present after content.');
	}
	if (operation === 'replace' && (before === null || after === null)) {
		throw new TypeError('Replace requires before and after content.');
	}
	if (operation === 'delete' && (before === null || after !== null)) {
		throw new TypeError('Delete requires before content and a missing result.');
	}
}

function validateReingestOutcome(outcome: ReingestOutcome): void {
	if (!['present', 'absent'].includes(outcome.expectedState)) {
		throw new TypeError('Reingest expectedState is invalid.');
	}
	if (!['present', 'absent', 'unknown'].includes(outcome.observedState)) {
		throw new TypeError('Reingest observedState is invalid.');
	}
	if ((outcome.expectedState === 'absent') !== (outcome.expectedVersionId === null)) {
		throw new TypeError('Reingest expected state and version are inconsistent.');
	}
	if (
		(outcome.observedState === 'present' && outcome.versionId === null)
		|| (outcome.observedState === 'absent' && outcome.versionId !== null)
	) throw new TypeError('Reingest observed state and version are inconsistent.');
	if (
		outcome.searchable
		&& (
			outcome.timedOut
			|| outcome.error !== undefined
			|| outcome.expectedState !== outcome.observedState
			|| outcome.expectedVersionId !== outcome.versionId
		)
	) throw new TypeError('Searchable reingest outcome does not match the expected state.');
	if (!Number.isSafeInteger(outcome.attempts) || outcome.attempts < 0) {
		throw new TypeError('Reingest attempts must be a non-negative safe integer.');
	}
	if (!Number.isFinite(outcome.elapsedMs) || outcome.elapsedMs < 0) {
		throw new TypeError('Reingest elapsedMs must be non-negative.');
	}
}

function assertWriteDegradations(values: WriteDegradation[]): void {
	const allowed = new Set<WriteDegradation>([
		'adapter_commit_uncertain',
		'adapter_result_unverified',
		'commit_audit_failed',
		'reingest_failed',
		'reingest_audit_failed',
	]);
	assertUniqueEnum(values, allowed, 'write degradation');
}

function assertRollbackDegradations(values: RollbackDegradation[]): void {
	const allowed = new Set<RollbackDegradation>([
		'adapter_result_unverified',
		'rollback_audit_failed',
		'reingest_failed',
		'reingest_audit_failed',
	]);
	assertUniqueEnum(values, allowed, 'rollback degradation');
}

function assertUniqueEnum<T extends string>(values: T[], allowed: ReadonlySet<T>, label: string): void {
	if (!Array.isArray(values) || values.some((value) => !allowed.has(value))) {
		throw new TypeError(`${label} list is invalid.`);
	}
	if (new Set(values).size !== values.length) throw new TypeError(`${label} list contains duplicates.`);
}

function frontmatter(content: string | null): string | null {
	if (!content) return null;
	const normalized = content.replace(/\r\n?/gu, '\n');
	if (!normalized.startsWith('---\n')) return null;
	const end = normalized.indexOf('\n---\n', 4);
	return end < 0 ? null : normalized.slice(0, end + 5);
}

function splitLines(content: string): string[] {
	return content.replace(/\r\n?/gu, '\n').split('\n');
}

interface RawDiffLine {
	kind: DiffLine['kind'];
	text: string;
}

function lcsDiff(before: string[], after: string[]): RawDiffLine[] {
	const columns = after.length + 1;
	const matrix = new Uint32Array((before.length + 1) * columns);
	for (let oldIndex = before.length - 1; oldIndex >= 0; oldIndex -= 1) {
		for (let newIndex = after.length - 1; newIndex >= 0; newIndex -= 1) {
			const offset = oldIndex * columns + newIndex;
			matrix[offset] = before[oldIndex] === after[newIndex]
				? (matrix[(oldIndex + 1) * columns + newIndex + 1] ?? 0) + 1
				: Math.max(
					matrix[(oldIndex + 1) * columns + newIndex] ?? 0,
					matrix[oldIndex * columns + newIndex + 1] ?? 0,
				);
		}
	}
	const result: RawDiffLine[] = [];
	let oldIndex = 0;
	let newIndex = 0;
	while (oldIndex < before.length || newIndex < after.length) {
		const oldLine = before[oldIndex];
		const newLine = after[newIndex];
		if (oldIndex < before.length && newIndex < after.length && oldLine === newLine) {
			result.push({ kind: 'context', text: oldLine ?? '' });
			oldIndex += 1;
			newIndex += 1;
		} else if (
			oldIndex < before.length
			&& (
				newIndex >= after.length
				|| (matrix[(oldIndex + 1) * columns + newIndex] ?? 0)
					>= (matrix[oldIndex * columns + newIndex + 1] ?? 0)
			)
		) {
			result.push({ kind: 'delete', text: oldLine ?? '' });
			oldIndex += 1;
		} else {
			result.push({ kind: 'insert', text: newLine ?? '' });
			newIndex += 1;
		}
	}
	return result;
}

function boundedReplacementDiff(before: string[], after: string[]): RawDiffLine[] {
	let prefix = 0;
	while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
		prefix += 1;
	}
	let suffix = 0;
	while (
		suffix < before.length - prefix
		&& suffix < after.length - prefix
		&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
	) {
		suffix += 1;
	}
	return [
		...before.slice(0, prefix).map((text) => ({ kind: 'context' as const, text })),
		...before.slice(prefix, before.length - suffix).map((text) => ({ kind: 'delete' as const, text })),
		...after.slice(prefix, after.length - suffix).map((text) => ({ kind: 'insert' as const, text })),
		...before.slice(before.length - suffix).map((text) => ({ kind: 'context' as const, text })),
	];
}

function buildHunks(raw: RawDiffLine[]): DiffHunk[] {
	const changeIndexes = raw
		.map((line, index) => line.kind === 'context' ? -1 : index)
		.filter((index) => index >= 0);
	if (changeIndexes.length === 0) return [];

	const numbered: DiffLine[] = [];
	const oldPositions: number[] = [];
	const newPositions: number[] = [];
	let oldLine = 1;
	let newLine = 1;
	for (const line of raw) {
		oldPositions.push(oldLine);
		newPositions.push(newLine);
		numbered.push({
			...line,
			oldLine: line.kind === 'insert' ? null : oldLine,
			newLine: line.kind === 'delete' ? null : newLine,
		});
		if (line.kind !== 'insert') oldLine += 1;
		if (line.kind !== 'delete') newLine += 1;
	}

	const ranges: Array<[number, number]> = [];
	let start = Math.max(0, (changeIndexes[0] ?? 0) - DIFF_CONTEXT_LINES);
	let end = Math.min(raw.length, (changeIndexes[0] ?? 0) + DIFF_CONTEXT_LINES + 1);
	for (const index of changeIndexes.slice(1)) {
		const nextStart = Math.max(0, index - DIFF_CONTEXT_LINES);
		const nextEnd = Math.min(raw.length, index + DIFF_CONTEXT_LINES + 1);
		if (nextStart <= end) {
			end = Math.max(end, nextEnd);
		} else {
			ranges.push([start, end]);
			start = nextStart;
			end = nextEnd;
		}
	}
	ranges.push([start, end]);

	return ranges.map(([rangeStart, rangeEnd]) => {
		const lines = numbered.slice(rangeStart, rangeEnd);
		return {
			oldStart: oldPositions[rangeStart] ?? oldLine,
			oldLines: lines.filter((line) => line.kind !== 'insert').length,
			newStart: newPositions[rangeStart] ?? newLine,
			newLines: lines.filter((line) => line.kind !== 'delete').length,
			lines,
		};
	});
}
