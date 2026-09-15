import { randomBytes } from 'node:crypto';
import {
	CONTROLLED_WRITE_SCHEMA_VERSION,
	type AdapterCommitResult,
	type ApprovalVerifier,
	type ApprovalToken,
	type AuditEvent,
	type AuditLedger,
	type BaseVersion,
	type CorrectionProposal,
	type ReingestOutcome,
	type RollbackDegradation,
	type RollbackPlan,
	type RollbackReceipt,
	type WritableSourceAdapter,
	type WritePlan,
	type WriteDegradation,
	type WriteReceipt,
} from './contracts.js';
import { canonicalJson, sha256 } from './integrity.js';
import {
	hashWriteReceipt,
	createWritePlan,
	validateCorrectionProposal,
	validateRollbackPlan,
	validateRollbackReceipt,
	validateWritePlan,
	validateWriteReceipt,
} from './proposal.js';
import type { ReingestCoordinator } from './reingestCoordinator.js';

export interface ControlledWriterOptions {
	adapters: Iterable<WritableSourceAdapter>;
	approvalVerifier: ApprovalVerifier;
	auditLedger: AuditLedger;
	reingestCoordinator: ReingestCoordinator;
	allowCritical?: boolean;
}

export interface ExecuteWriteInput {
	proposal: CorrectionProposal;
	plan: WritePlan;
	approvalToken: ApprovalToken;
}

export interface ExecuteRollbackInput {
	plan: RollbackPlan;
	approvalToken: ApprovalToken;
}

export class ControlledWriteError extends Error {
	constructor(
		message: string,
		readonly stage: 'validation' | 'approval' | 'audit' | 'commit' | 'rollback',
		readonly transactionId: string | null,
		readonly committedResult: AdapterCommitResult | null,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = 'ControlledWriteError';
	}
}

/**
 * The sole orchestration boundary allowed to invoke writable adapters. It does
 * not expose adapter-specific paths or direct write methods to model clients.
 */
export class ControlledWriter {
	private readonly adapters = new Map<string, WritableSourceAdapter>();
	private readonly approvalVerifier: ApprovalVerifier;
	private readonly auditLedger: AuditLedger;
	private readonly reingestCoordinator: ReingestCoordinator;
	private readonly allowCritical: boolean;

	constructor(options: ControlledWriterOptions) {
		for (const adapter of options.adapters) {
			if (this.adapters.has(adapter.adapterId)) {
				throw new TypeError(`Duplicate writable adapterId: ${adapter.adapterId}`);
			}
			this.adapters.set(adapter.adapterId, adapter);
		}
		if (this.adapters.size === 0) throw new TypeError('ControlledWriter requires an adapter.');
		this.approvalVerifier = options.approvalVerifier;
		this.auditLedger = options.auditLedger;
		this.reingestCoordinator = options.reingestCoordinator;
		this.allowCritical = options.allowCritical ?? false;
	}

	async execute(input: ExecuteWriteInput): Promise<WriteReceipt> {
		try {
			validateCorrectionProposal(input.proposal);
			validateWritePlan(input.plan);
			const derivedPlan = createWritePlan(input.proposal, input.plan.plannedAt);
			if (canonicalJson(derivedPlan) !== canonicalJson(input.plan)) {
				throw new Error('Write plan was not derived from the supplied correction proposal.');
			}
		} catch (error) {
			throw new ControlledWriteError('Write plan validation failed.', 'validation', null, null, { cause: error });
		}
		if (input.plan.risk.level === 'critical' && !this.allowCritical) {
			throw new ControlledWriteError(
				'Critical writes are disabled by the controlled writer policy.',
				'validation',
				null,
				null,
			);
		}
		const adapter = this.resolveAdapter(input.plan.source.adapterId, input.plan.source.sourceId);
		if (!adapter.supportedOperations.has(input.plan.operation)) {
			throw new ControlledWriteError('Adapter does not support the requested operation.', 'validation', null, null);
		}
		try {
			await this.approvalVerifier.consume(
				input.approvalToken,
				input.plan.proposalHash,
				input.plan.risk.level,
			);
		} catch (error) {
			throw new ControlledWriteError('Write approval failed.', 'approval', null, null, { cause: error });
		}

		const transactionId = createTransactionId();
		const baseEvent = eventBase(
			transactionId,
			input.plan.proposalHash,
			input.plan.planHash,
			input.approvalToken.tokenId,
			input.plan.source,
			input.plan.operation,
			input.plan.expectedBase,
		);
		try {
			await this.auditLedger.append({ ...baseEvent, type: 'write_started', resultVersionId: null });
		} catch (error) {
			throw new ControlledWriteError('Could not record write start.', 'audit', transactionId, null, { cause: error });
		}

		const degradations: WriteDegradation[] = [];
		let committed: AdapterCommitResult | null = null;
		try {
			committed = await adapter.commit({ transactionId, plan: input.plan });
			try {
				assertAdapterCommitResult(committed, transactionId, input.plan);
			} catch {
				pushUnique(degradations, 'adapter_result_unverified');
			}
		} catch (error) {
			const recoveryToken = readRecoveryToken(error, transactionId);
			if (recoveryToken === null) {
				await this.appendFailure({
					...baseEvent,
					type: 'write_failed',
					resultVersionId: null,
					detail: safeErrorMessage(error),
				});
				throw new ControlledWriteError('Adapter commit failed.', 'commit', transactionId, null, { cause: error });
			}
			committed = {
				transactionId,
				source: input.plan.source,
				operation: input.plan.operation,
				previousVersion: input.plan.expectedBase,
				committedVersion: input.plan.desiredVersion,
				rollbackToken: recoveryToken,
				committedAt: new Date().toISOString(),
			};
			pushUnique(degradations, 'adapter_commit_uncertain');
		}
		if (committed === null) throw new Error('Unreachable adapter commit state.');

		let commitAuditHash: string | null = null;
		try {
			const commitEntry = await this.auditLedger.append({
				...baseEvent,
				type: degradations.length === 0 ? 'write_committed' : 'write_degraded',
				resultVersionId: committed.committedVersion?.versionId ?? null,
				...(degradations.length === 0 ? {} : { detail: degradations.join(',') }),
			});
			commitAuditHash = commitEntry.entryHash;
		} catch {
			pushUnique(degradations, 'commit_audit_failed');
		}

		const reingest = await safeReingest(
			this.reingestCoordinator,
			input.plan.source,
			committed.committedVersion?.versionId ?? null,
		);
		if (!isSuccessfulReingest(reingest)) pushUnique(degradations, 'reingest_failed');
		let reingestAuditHash: string | null = null;
		try {
			const reingestEntry = await this.auditLedger.append({
				...baseEvent,
				type: isSuccessfulReingest(reingest) ? 'reingest_completed' : 'reingest_failed',
				resultVersionId: reingest.versionId,
				...(isSuccessfulReingest(reingest)
					? {}
					: { detail: reingest.error ?? (reingest.timedOut ? 'timeout' : 'not_searchable') }),
			});
			reingestAuditHash = reingestEntry.entryHash;
		} catch {
			pushUnique(degradations, 'reingest_audit_failed');
		}

		const material: Omit<WriteReceipt, 'receiptId' | 'receiptHash'> = {
			schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
			outcome: degradations.length === 0 ? 'committed' : 'committed_but_degraded',
			degradations,
			transactionId,
			proposalHash: input.plan.proposalHash,
			planHash: input.plan.planHash,
			tokenId: input.approvalToken.tokenId,
			source: input.plan.source,
			operation: input.plan.operation,
			previousVersion: committed.previousVersion,
			committedVersion: committed.committedVersion,
			rollbackToken: committed.rollbackToken,
			committedAt: committed.committedAt,
			reingest,
			commitAuditHash,
			reingestAuditHash,
		};
		const receiptHash = hashWriteReceipt(material);
		const receipt = { ...material, receiptId: `receipt_v1_${receiptHash}`, receiptHash };
		validateWriteReceipt(receipt);
		return receipt;
	}

	async rollback(input: ExecuteRollbackInput): Promise<RollbackReceipt> {
		try {
			validateRollbackPlan(input.plan);
		} catch (error) {
			throw new ControlledWriteError('Rollback plan validation failed.', 'validation', null, null, { cause: error });
		}
		const adapter = this.resolveAdapter(
			input.plan.receipt.source.adapterId,
			input.plan.receipt.source.sourceId,
		);
		try {
			await this.approvalVerifier.consume(
				input.approvalToken,
				input.plan.rollbackHash,
				input.plan.risk.level,
			);
		} catch (error) {
			throw new ControlledWriteError('Rollback approval failed.', 'approval', null, null, { cause: error });
		}

		const transactionId = createTransactionId();
		const baseEvent = eventBase(
			transactionId,
			input.plan.rollbackHash,
			input.plan.rollbackHash,
			input.approvalToken.tokenId,
			input.plan.receipt.source,
			'rollback',
			input.plan.receipt.committedVersion,
		);
		try {
			await this.auditLedger.append({ ...baseEvent, type: 'rollback_started', resultVersionId: null });
		} catch (error) {
			throw new ControlledWriteError(
				'Could not record rollback start.',
				'audit',
				transactionId,
				null,
				{ cause: error },
			);
		}
		const degradations: RollbackDegradation[] = [];
		let result;
		try {
			result = await adapter.rollback({
				transactionId,
				originalTransactionId: input.plan.receipt.transactionId,
				source: input.plan.receipt.source,
				rollbackToken: input.plan.receipt.rollbackToken,
				expectedCurrentVersion: input.plan.receipt.committedVersion,
			});
			if (
				result.transactionId !== transactionId
				|| canonicalJson(result.source) !== canonicalJson(input.plan.receipt.source)
				|| !sameVersion(result.restoredVersion, input.plan.receipt.previousVersion)
			) pushUnique(degradations, 'adapter_result_unverified');
		} catch (error) {
			await this.appendFailure({
				...baseEvent,
				type: 'rollback_failed',
				resultVersionId: null,
				detail: safeErrorMessage(error),
			});
			throw new ControlledWriteError('Adapter rollback failed.', 'rollback', transactionId, null, { cause: error });
		}
		let auditHash: string | null = null;
		try {
			const audit = await this.auditLedger.append({
				...baseEvent,
				type: 'rollback_completed',
				resultVersionId: result.restoredVersion?.versionId ?? null,
				...(degradations.length === 0 ? {} : { detail: degradations.join(',') }),
			});
			auditHash = audit.entryHash;
		} catch {
			pushUnique(degradations, 'rollback_audit_failed');
		}
		const reingest = await safeReingest(
			this.reingestCoordinator,
			input.plan.receipt.source,
			result.restoredVersion?.versionId ?? null,
		);
		if (!isSuccessfulReingest(reingest)) pushUnique(degradations, 'reingest_failed');
		let reingestAuditHash: string | null = null;
		try {
			const reingestAudit = await this.auditLedger.append({
				...baseEvent,
				type: isSuccessfulReingest(reingest) ? 'reingest_completed' : 'reingest_failed',
				resultVersionId: reingest.versionId,
				...(isSuccessfulReingest(reingest)
					? {}
					: { detail: reingest.error ?? (reingest.timedOut ? 'timeout' : 'not_searchable') }),
			});
			reingestAuditHash = reingestAudit.entryHash;
		} catch {
			pushUnique(degradations, 'reingest_audit_failed');
		}

		const material: Omit<RollbackReceipt, 'receiptId' | 'receiptHash'> = {
			schemaVersion: CONTROLLED_WRITE_SCHEMA_VERSION,
			outcome: degradations.length === 0 ? 'rolled_back' : 'rolled_back_but_degraded',
			degradations,
			transactionId,
			rollbackHash: input.plan.rollbackHash,
			tokenId: input.approvalToken.tokenId,
			source: input.plan.receipt.source,
			restoredVersion: result.restoredVersion,
			rolledBackAt: result.rolledBackAt,
			reingest,
			auditHash,
			reingestAuditHash,
		};
		const receiptHash = sha256(canonicalJson(material));
		const receipt = {
			...material,
			receiptId: `rollback_receipt_v1_${receiptHash}`,
			receiptHash,
		};
		validateRollbackReceipt(receipt);
		return receipt;
	}

	private resolveAdapter(adapterId: string, sourceId: string): WritableSourceAdapter {
		const adapter = this.adapters.get(adapterId);
		if (!adapter || adapter.sourceId !== sourceId) {
			throw new ControlledWriteError('No writable adapter owns this source.', 'validation', null, null);
		}
		return adapter;
	}

	private async appendFailure(event: AuditEvent): Promise<void> {
		try {
			await this.auditLedger.append(event);
		} catch {
			// Preserve the original adapter error; ledger verification will expose the missing terminal event.
		}
	}
}

function createTransactionId(): string {
	return `txn_v1_${randomBytes(16).toString('hex')}`;
}

function eventBase(
	transactionId: string,
	proposalHash: string,
	planHash: string,
	tokenId: string,
	source: WritePlan['source'],
	operation: AuditEvent['operation'],
	baseVersion: BaseVersion | null,
): Omit<AuditEvent, 'type' | 'resultVersionId'> {
	return {
		transactionId,
		proposalHash,
		planHash,
		tokenId,
		source,
		operation,
		baseVersionId: baseVersion?.versionId ?? null,
	};
}

function assertAdapterCommitResult(
	result: AdapterCommitResult,
	transactionId: string,
	plan: WritePlan,
): void {
	if (
		result.transactionId !== transactionId
		|| canonicalJson(result.source) !== canonicalJson(plan.source)
		|| result.operation !== plan.operation
		|| !sameVersion(result.previousVersion, plan.expectedBase)
		|| !sameVersion(result.committedVersion, plan.desiredVersion)
		|| typeof result.rollbackToken !== 'string'
		|| result.rollbackToken.length === 0
		|| !Number.isFinite(Date.parse(result.committedAt))
	) throw new Error('Adapter commit result does not match the approved plan.');
}

function sameVersion(actual: BaseVersion | null, expected: BaseVersion | null): boolean {
	return canonicalJson(actual) === canonicalJson(expected);
}

function readRecoveryToken(error: unknown, transactionId: string): string | null {
	if (!error || typeof error !== 'object') return null;
	const candidate = error as { transactionId?: unknown; recoveryToken?: unknown };
	return candidate.transactionId === transactionId
		&& typeof candidate.recoveryToken === 'string'
		&& candidate.recoveryToken.length > 0
		? candidate.recoveryToken
		: null;
}

async function safeReingest(
	coordinator: ReingestCoordinator,
	source: WritePlan['source'],
	expectedVersionId: BaseVersion['versionId'] | null,
): Promise<ReingestOutcome> {
	try {
		return await coordinator.commitAndAwait(source, expectedVersionId);
	} catch (error) {
		return {
			expectedState: expectedVersionId === null ? 'absent' : 'present',
			observedState: 'unknown',
			expectedVersionId,
			versionId: null,
			searchable: false,
			timedOut: false,
			attempts: 0,
			elapsedMs: 0,
			error: safeErrorMessage(error),
		};
	}
}

function isSuccessfulReingest(outcome: ReingestOutcome): boolean {
	return outcome.searchable
		&& !outcome.timedOut
		&& outcome.error === undefined
		&& outcome.expectedState === outcome.observedState
		&& outcome.expectedVersionId === outcome.versionId;
}

function pushUnique<T>(values: T[], value: T): void {
	if (!values.includes(value)) values.push(value);
}

function safeErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return 'unknown error';
	const code = (error as NodeJS.ErrnoException).code;
	return code ? `${error.name}:${code}` : error.name || 'error';
}
