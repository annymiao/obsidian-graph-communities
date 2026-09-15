import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { SafeDirectoryWriterAdapter } from '../adapters/directoryWriter.js';
import { ApprovalTokenAuthority, FileApprovalUseStore } from '../write/approval.js';
import { HashChainAuditLedger } from '../write/auditLedger.js';
import type {
	CorrectionProposal,
	ReingestDriver,
	ReingestObservation,
	RollbackPlan,
	RollbackReceipt,
	SourceRef,
	WritePlan,
	WriteReceipt,
} from '../write/contracts.js';
import { ControlledWriter } from '../write/controlledWriter.js';
import { canonicalJson, sha256 } from '../write/integrity.js';
import {
	createCorrectionProposal,
	createRollbackPlan,
	createSourceRef,
	createWritePlan,
} from '../write/proposal.js';
import { ReingestCoordinator } from '../write/reingestCoordinator.js';
import type {
	HumanApprovalBroker,
	HumanApprovalDecision,
	HumanApprovalReview,
	PrepareRollbackInput,
	PrepareWriteInput,
	PreparedRollbackReview,
	PreparedWriteReview,
	SecondBrainPrincipalPolicy,
	SecondBrainSourceDescriptor,
} from './types.js';

const DEFAULT_PENDING_TTL_MS = 10 * 60_000;
const MAXIMUM_PENDING_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAXIMUM_PENDING = 100;
const MAXIMUM_PENDING = 1_000;
const DEFAULT_APPROVAL_TOKEN_TTL_MS = 60_000;
const PREPARED_ID_PATTERN = /^prepared_(?:write|rollback)_v1_[a-f0-9]{32}$/u;

interface WriteHooks {
	assertAuthorized(
		principal: SecondBrainPrincipalPolicy,
		source: SecondBrainSourceDescriptor,
		documentPath: string,
	): void;
	requestReingest(source: SourceRef): Promise<void>;
	observe(source: SourceRef): Promise<ReingestObservation | null>;
}

interface ControlledWritesOptions {
	sources: readonly SecondBrainSourceDescriptor[];
	broker: HumanApprovalBroker;
	approvalSecret: string | Uint8Array;
	stateRoot: string;
	hooks: WriteHooks;
	pendingReviewTtlMs?: number;
	maximumPendingReviews?: number;
	approvalTokenTtlMs?: number;
	allowCriticalWrites?: boolean;
}

interface PendingWrite {
	kind: 'write';
	review: PreparedWriteReview;
	proposal: CorrectionProposal;
	plan: WritePlan;
}

interface PendingRollback {
	kind: 'rollback';
	review: PreparedRollbackReview;
	plan: RollbackPlan;
}

type PendingReview = PendingWrite | PendingRollback;

/** Internal-only bridge. It intentionally never exposes ApprovalTokenAuthority. */
export class SecondBrainControlledWrites {
	readonly #sources = new Map<string, SecondBrainSourceDescriptor>();
	readonly #broker: HumanApprovalBroker;
	readonly #authority: ApprovalTokenAuthority;
	readonly #writer: ControlledWriter;
	readonly #hooks: WriteHooks;
	readonly #pending = new Map<string, PendingReview>();
	readonly #pendingTtlMs: number;
	readonly #maximumPending: number;
	readonly #approvalTokenTtlMs: number;
	readonly #allowCritical: boolean;

	constructor(options: ControlledWritesOptions) {
		this.#broker = options.broker;
		this.#hooks = options.hooks;
		this.#pendingTtlMs = boundedInteger(
			options.pendingReviewTtlMs,
			DEFAULT_PENDING_TTL_MS,
			1_000,
			MAXIMUM_PENDING_TTL_MS,
			'pendingReviewTtlMs',
		);
		this.#maximumPending = boundedInteger(
			options.maximumPendingReviews,
			DEFAULT_MAXIMUM_PENDING,
			1,
			MAXIMUM_PENDING,
			'maximumPendingReviews',
		);
		this.#approvalTokenTtlMs = boundedInteger(
			options.approvalTokenTtlMs,
			DEFAULT_APPROVAL_TOKEN_TTL_MS,
			1_000,
			Math.min(this.#pendingTtlMs, 10 * 60_000),
			'approvalTokenTtlMs',
		);
		this.#allowCritical = options.allowCriticalWrites ?? false;

		const adapters: SafeDirectoryWriterAdapter[] = [];
		for (const source of options.sources) {
			if (source.writable === undefined) continue;
			if (source.kind !== 'directory' || !(source.writable.adapter instanceof SafeDirectoryWriterAdapter)) {
				throw new TypeError('Controlled writes only accept SafeDirectoryWriterAdapter on directory sources.');
			}
			if (this.#sources.has(source.sourceId)) throw new TypeError('Duplicate writable sourceId.');
			this.#sources.set(source.sourceId, source);
			adapters.push(source.writable.adapter);
		}
		if (adapters.length === 0) throw new TypeError('Controlled write service requires a writable directory source.');
		if (!options.stateRoot || options.stateRoot.includes('\0')) {
			throw new TypeError('Controlled write stateRoot is invalid.');
		}
		const authority = new ApprovalTokenAuthority(options.approvalSecret, {
			store: new FileApprovalUseStore(path.join(options.stateRoot, 'approval-uses')),
			maximumTtlMs: Math.min(this.#pendingTtlMs, 10 * 60_000),
		});
		this.#authority = authority;
		const driver: ReingestDriver = {
			requestReingest: (source) => this.#hooks.requestReingest(source),
			observe: (source) => this.#hooks.observe(source),
		};
		this.#writer = new ControlledWriter({
			adapters,
			approvalVerifier: authority,
			auditLedger: new HashChainAuditLedger(path.join(options.stateRoot, 'audit')),
			reingestCoordinator: new ReingestCoordinator(driver, { timeoutMs: 5_000 }),
			allowCritical: this.#allowCritical,
		});
	}

	async prepareWrite(input: PrepareWriteInput): Promise<PreparedWriteReview> {
		const source = this.#resolveSource(input.sourceId);
		const binding = source.writable;
		if (binding === undefined) throw new Error('Source is not writable.');
		const sourceRef = createSourceRef(binding.adapter.adapterId, source.sourceId, input.documentPath);
		this.#hooks.assertAuthorized(input.principal, source, sourceRef.documentPath);
		const before = await binding.adapter.inspect(sourceRef);
		const proposal = createCorrectionProposal({
			source: sourceRef,
			operation: input.operation,
			proposer: actorFromInput(input.principal, input.modelProvider, input.modelName),
			rationale: input.rationale,
			beforeContent: before?.content ?? null,
			afterContent: input.afterContent,
		});
		if (proposal.risk.level === 'critical' && !this.#allowCritical) {
			throw new Error('Critical writes are disabled; no approval request was created.');
		}
		const plan = createWritePlan(proposal);
		const review = this.#createWriteReview(source, proposal, plan);
		this.#storePending({ kind: 'write', review, proposal, plan });
		return cloneReview(review);
	}

	async approveAndCommitWrite(preparedId: string): Promise<WriteReceipt> {
		const pending = this.#takePending(preparedId, 'write');
		const decision = await this.#requestBoundApproval(pending.review);
		const remainingMs = Date.parse(pending.review.expiresAt) - Date.now();
		if (remainingMs <= 0) throw new Error('Prepared write expired during human review.');
		const token = this.#authority.issue({
			proposalHash: pending.plan.proposalHash,
			approvedBy: decision.approvedBy,
			maximumRisk: pending.plan.risk.level,
			ttlMs: Math.min(this.#approvalTokenTtlMs, remainingMs),
		});
		return this.#writer.execute({ proposal: pending.proposal, plan: pending.plan, approvalToken: token });
	}

	prepareRollback(input: PrepareRollbackInput): PreparedRollbackReview {
		const source = this.#resolveSource(input.receipt.source.sourceId);
		if (
			source.writable === undefined
			|| source.writable.adapter.adapterId !== input.receipt.source.adapterId
		) throw new Error('Receipt does not belong to a writable source.');
		const plan = createRollbackPlan({
			receipt: input.receipt,
			initiatedBy: actorFromInput(input.principal, input.modelProvider, input.modelName),
			reason: input.reason,
		});
		this.#hooks.assertAuthorized(
			input.principal,
			source,
			plan.receipt.source.documentPath,
		);
		const review = this.#createRollbackReview(source, plan);
		this.#storePending({ kind: 'rollback', review, plan });
		return cloneReview(review);
	}

	async approveAndRollback(preparedId: string): Promise<RollbackReceipt> {
		const pending = this.#takePending(preparedId, 'rollback');
		const decision = await this.#requestBoundApproval(pending.review);
		const remainingMs = Date.parse(pending.review.expiresAt) - Date.now();
		if (remainingMs <= 0) throw new Error('Prepared rollback expired during human review.');
		const token = this.#authority.issue({
			proposalHash: pending.plan.rollbackHash,
			approvedBy: decision.approvedBy,
			maximumRisk: pending.plan.risk.level,
			ttlMs: Math.min(this.#approvalTokenTtlMs, remainingMs),
		});
		return this.#writer.rollback({ plan: pending.plan, approvalToken: token });
	}

	#createWriteReview(
		source: SecondBrainSourceDescriptor,
		proposal: CorrectionProposal,
		plan: WritePlan,
	): PreparedWriteReview {
		const preparedId = `prepared_write_v1_${randomBytes(16).toString('hex')}`;
		const expiresAt = new Date(Date.now() + this.#pendingTtlMs).toISOString();
		const reviewText = renderWriteReview(preparedId, source, proposal, plan, expiresAt);
		return withBindingHash({
			schemaVersion: 1,
			preparedId,
			action: 'write',
			expiresAt,
			source: {
				sourceId: source.sourceId,
				label: source.label,
				documentPath: proposal.source.documentPath,
			},
			operation: proposal.operation,
			risk: structuredClone(proposal.risk),
			reviewText,
			diffHunks: structuredClone(proposal.diff.hunks),
		});
	}

	#createRollbackReview(
		source: SecondBrainSourceDescriptor,
		plan: RollbackPlan,
	): PreparedRollbackReview {
		const preparedId = `prepared_rollback_v1_${randomBytes(16).toString('hex')}`;
		const expiresAt = new Date(Date.now() + this.#pendingTtlMs).toISOString();
		const reviewText = renderRollbackReview(preparedId, source, plan, expiresAt);
		return withBindingHash({
			schemaVersion: 1,
			preparedId,
			action: 'rollback',
			expiresAt,
			source: {
				sourceId: source.sourceId,
				label: source.label,
				documentPath: plan.receipt.source.documentPath,
			},
			operation: 'rollback',
			risk: structuredClone(plan.risk),
			reviewText,
			diffHunks: [],
		});
	}

	#storePending(pending: PendingReview): void {
		this.#pruneExpired();
		if (this.#pending.size >= this.#maximumPending) {
			throw new Error('Pending human review limit reached.');
		}
		this.#pending.set(pending.review.preparedId, pending);
	}

	#takePending<TKind extends PendingReview['kind']>(
		preparedId: string,
		kind: TKind,
	): Extract<PendingReview, { kind: TKind }> {
		if (!PREPARED_ID_PATTERN.test(preparedId)) throw new TypeError('Prepared review ID is invalid.');
		this.#pruneExpired();
		const pending = this.#pending.get(preparedId);
		if (!pending || pending.kind !== kind) throw new Error('Prepared review is missing, expired, or already used.');
		// Consume before any await: concurrent calls cannot present one review twice.
		this.#pending.delete(preparedId);
		return pending as Extract<PendingReview, { kind: TKind }>;
	}

	#pruneExpired(): void {
		const now = Date.now();
		for (const [preparedId, pending] of this.#pending) {
			if (Date.parse(pending.review.expiresAt) <= now) this.#pending.delete(preparedId);
		}
	}

	async #requestBoundApproval(review: HumanApprovalReview): Promise<Extract<HumanApprovalDecision, { approved: true }>> {
		if (review.bindingHash !== calculateReviewBinding(review)) {
			throw new Error('Prepared human review integrity check failed.');
		}
		const decision = await this.#broker.requestApproval(cloneReview(review));
		if (decision.bindingHash !== review.bindingHash) {
			throw new Error('Human approval decision is bound to a different review.');
		}
		if (!decision.approved) throw new Error('Human reviewer denied the operation.');
		if (typeof decision.approvedBy !== 'string' || decision.approvedBy.trim().length === 0) {
			throw new Error('Human approval decision did not identify its reviewer.');
		}
		return decision;
	}

	#resolveSource(sourceId: string): SecondBrainSourceDescriptor {
		const source = this.#sources.get(sourceId);
		if (!source) throw new Error('Source is not writable.');
		return source;
	}
}

function withBindingHash<T extends Omit<HumanApprovalReview, 'bindingHash'>>(
	material: T,
): T & { bindingHash: string } {
	return { ...material, bindingHash: sha256(canonicalJson(material)) };
}

function calculateReviewBinding(review: HumanApprovalReview): string {
	const { bindingHash: _bindingHash, ...material } = review;
	return sha256(canonicalJson(material));
}

function renderWriteReview(
	preparedId: string,
	source: SecondBrainSourceDescriptor,
	proposal: CorrectionProposal,
	plan: WritePlan,
	expiresAt: string,
): string {
	const lines = [
		'SECOND BRAIN HUMAN WRITE REVIEW v1',
		`Prepared: ${preparedId}`,
		`Expires: ${expiresAt}`,
		`Source: ${JSON.stringify(source.label)} (${source.sourceId})`,
		`Document: ${JSON.stringify(proposal.source.documentPath)}`,
		`Operation: ${proposal.operation}`,
		`Risk: ${proposal.risk.level} [${proposal.risk.reasons.join(', ')}]`,
		`Rationale: ${JSON.stringify(proposal.rationale)}`,
		`Proposal-SHA256: ${proposal.proposalHash}`,
		`Plan-SHA256: ${plan.planHash}`,
		`Before-SHA256: ${proposal.diff.beforeSha256 ?? 'MISSING'}`,
		`After-SHA256: ${proposal.diff.afterSha256 ?? 'MISSING'}`,
		`Line changes: +${proposal.diff.insertedLines} -${proposal.diff.deletedLines}`,
		'Diff:',
	];
	for (const [hunkIndex, hunk] of proposal.diff.hunks.entries()) {
		lines.push(`@@ hunk ${hunkIndex + 1} -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		for (const line of hunk.lines) {
			const marker = line.kind === 'insert' ? '+' : line.kind === 'delete' ? '-' : ' ';
			lines.push(`${marker} ${line.oldLine ?? '-'}:${line.newLine ?? '-'} ${JSON.stringify(line.text)}`);
		}
	}
	if (proposal.diff.hunks.length === 0) lines.push('(no rendered hunks)');
	return `${lines.join('\n')}\n`;
}

function renderRollbackReview(
	preparedId: string,
	source: SecondBrainSourceDescriptor,
	plan: RollbackPlan,
	expiresAt: string,
): string {
	return [
		'SECOND BRAIN HUMAN ROLLBACK REVIEW v1',
		`Prepared: ${preparedId}`,
		`Expires: ${expiresAt}`,
		`Source: ${JSON.stringify(source.label)} (${source.sourceId})`,
		`Document: ${JSON.stringify(plan.receipt.source.documentPath)}`,
		`Risk: ${plan.risk.level} [${plan.risk.reasons.join(', ')}]`,
		`Reason: ${JSON.stringify(plan.reason)}`,
		`Rollback-SHA256: ${plan.rollbackHash}`,
		`Original receipt: ${plan.receipt.receiptId}`,
		`Current version: ${plan.receipt.committedVersion?.versionId ?? 'MISSING'}`,
		`Restore version: ${plan.receipt.previousVersion?.versionId ?? 'MISSING'}`,
		'',
	].join('\n');
}

function actorFromInput(
	principal: SecondBrainPrincipalPolicy,
	modelProvider: string | undefined,
	modelName: string | undefined,
) {
	return {
		clientId: principal.principalId,
		...(modelProvider === undefined ? {} : { modelProvider }),
		...(modelName === undefined ? {} : { modelName }),
	};
}

function cloneReview<T extends HumanApprovalReview>(review: T): T {
	return structuredClone(review);
}

function boundedInteger(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	const candidate = value ?? fallback;
	if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
		throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return candidate;
}
