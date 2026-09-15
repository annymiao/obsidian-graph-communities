import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSourceId } from '../src/stableIds.js';
import {
	ApprovalTokenAuthority,
	FileApprovalUseStore,
	HashChainAuditLedger,
	InMemoryApprovalUseStore,
	withOwnedFileLock,
} from '../src/write/index.js';
import {
	createCorrectionProposal,
	createRollbackPlan,
	createSourceRef,
	createStructuredDiff,
	createWritePlan,
	validateCorrectionProposal,
	validateRollbackReceipt,
	validateWriteReceipt,
} from '../src/write/proposal.js';
import { ReingestCoordinator } from '../src/write/reingestCoordinator.js';
import { ControlledWriter } from '../src/write/controlledWriter.js';
import { SafeDirectoryWriterAdapter } from '../src/adapters/directoryWriter.js';
import {
	createWriteCapabilityManifest,
	negotiateWriteCapabilities,
} from '../src/adapters/capabilities.js';
import {
	CONTROLLED_WRITE_PROTOCOL_VERSION,
	type ApprovalVerifier,
	type AuditEntry,
	type AuditEvent,
	type AuditLedger,
} from '../src/write/contracts.js';

async function withSyntheticRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'controlled-write-synthetic-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const proposer = {
	clientId: 'synthetic-client',
	modelProvider: 'test-provider',
	modelName: 'test-model',
};

class SelectiveFailureLedger implements AuditLedger {
	readonly failures = new Set<AuditEvent['type']>();

	constructor(private readonly delegate: AuditLedger) {}

	async append(event: AuditEvent): Promise<AuditEntry> {
		if (this.failures.has(event.type)) throw new Error(`synthetic ${event.type} failure`);
		return this.delegate.append(event);
	}

	verify(): Promise<AuditEntry[]> {
		return this.delegate.verify();
	}
}

test('creates a hash-bound proposal, structured diff, deterministic risk, and immutable plan check', () => {
	const sourceId = createSourceId('synthetic:proposal-source');
	const source = createSourceRef('synthetic-directory', sourceId, 'Notes/Example.md');
	const before = '# Example\n\none\nmiddle\nend\n';
	const after = '# Example\n\none fixed\nmiddle\nend\nnew\n';
	const proposal = createCorrectionProposal({
		source,
		operation: 'replace',
		proposer,
		rationale: 'Correct a synthetic statement.',
		beforeContent: before,
		afterContent: after,
		createdAt: '2026-09-15T00:00:00.000Z',
	});

	assert.match(proposal.proposalId, /^proposal_v1_[a-f0-9]{64}$/u);
	assert.equal(proposal.diff.beforeSha256, proposal.before?.baseVersion.contentSha256);
	assert.equal(proposal.diff.afterSha256, proposal.after?.baseVersion.contentSha256);
	assert.ok(proposal.diff.hunks.length >= 1);
	assert.ok(proposal.diff.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'delete')));
	assert.ok(proposal.diff.hunks.some((hunk) => hunk.lines.some((line) => line.kind === 'insert')));
	assert.equal(proposal.risk.requiresHumanApproval, true);
	validateCorrectionProposal(proposal);

	const tampered = structuredClone(proposal);
	assert.ok(tampered.after);
	tampered.after.content = 'silently changed';
	assert.throws(() => validateCorrectionProposal(tampered), /snapshot version|integrity/u);

	const plan = createWritePlan(proposal, '2026-09-15T00:01:00.000Z');
	assert.equal(plan.proposalHash, proposal.proposalHash);
	assert.equal(plan.expectedBase?.versionId, proposal.before?.baseVersion.versionId);
	assert.equal(plan.desiredVersion?.versionId, proposal.after?.baseVersion.versionId);
});

test('uses a bounded diff for large inputs and elevates risky changes', () => {
	const before = Array.from({ length: 700 }, (_, index) => `before-${index}`).join('\n');
	const after = Array.from({ length: 700 }, (_, index) => `after-${index}`).join('\n');
	const diff = createStructuredDiff(before, after);
	assert.equal(diff.algorithm, 'bounded-replacement-v1');
	assert.equal(diff.deletedLines, 700);
	assert.equal(diff.insertedLines, 700);

	const sourceId = createSourceId('synthetic:risk-source');
	const source = createSourceRef('synthetic-directory', sourceId, 'Notes/Risk.md');
	const proposal = createCorrectionProposal({
		source,
		operation: 'replace',
		proposer,
		rationale: 'Synthetic destructive edit.',
		beforeContent: `${before}\n`,
		afterContent: 'replacement\n',
	});
	assert.equal(proposal.risk.level, 'critical');
	assert.ok(proposal.risk.reasons.includes('most_content_removed'));
});

test('approval tokens are hash-bound, risk-scoped, expiring, and durably one-time', async () => {
	await withSyntheticRoot(async (root) => {
		let now = Date.parse('2026-09-15T00:00:00.000Z');
		const proposalHash = 'a'.repeat(64);
		const registryPath = path.join(root, 'approval-uses');
		const authority = new ApprovalTokenAuthority('s'.repeat(32), {
			store: new FileApprovalUseStore(registryPath),
			clock: () => now,
		});
		const token = authority.issue({
			proposalHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'medium',
			ttlMs: 1_000,
		});
		assert.throws(() => authority.verify(token, 'b'.repeat(64), 'low'), /different proposal/u);
		assert.throws(() => authority.verify(token, proposalHash, 'high'), /risk level/u);
		await authority.consume(token, proposalHash, 'low');

		const reopened = new ApprovalTokenAuthority('s'.repeat(32), {
			store: new FileApprovalUseStore(registryPath),
			clock: () => now,
		});
		await assert.rejects(reopened.consume(token, proposalHash, 'low'), /already been consumed/u);

		const expiring = authority.issue({
			proposalHash: 'c'.repeat(64),
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'low',
			ttlMs: 100,
		});
		now += 100;
		assert.throws(() => authority.verify(expiring, 'c'.repeat(64), 'low'), /expired/u);
	});
});

test('hash-chain audit ledger serializes appends and detects on-disk tampering', async () => {
	await withSyntheticRoot(async (root) => {
		const ledgerRoot = path.join(root, 'audit');
		const ledger = new HashChainAuditLedger(ledgerRoot);
		const secondProcessView = new HashChainAuditLedger(ledgerRoot);
		const sourceId = createSourceId('synthetic:audit-source');
		const source = createSourceRef('synthetic-directory', sourceId, 'Notes/Audit.md');
		const base = {
			transactionId: 'txn_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			proposalHash: 'a'.repeat(64),
			planHash: 'b'.repeat(64),
			tokenId: 'approval_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			source,
			operation: 'create' as const,
			baseVersionId: null,
			resultVersionId: null,
		};
		await Promise.all([
			ledger.append({ ...base, type: 'write_started' }),
			secondProcessView.append({ ...base, type: 'write_failed', detail: 'synthetic failure' }),
		]);
		const verified = await ledger.verify();
		assert.deepEqual(verified.map((entry) => entry.sequence), [1, 2]);
		assert.equal(verified[1]?.previousHash, verified[0]?.entryHash);

		const ledgerPath = path.join(ledgerRoot, 'audit.jsonl');
		const lines = (await readFile(ledgerPath, 'utf8')).split('\n');
		const firstEntry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
		firstEntry.detail = 'tampered after publication';
		lines[0] = JSON.stringify(firstEntry);
		await writeFile(ledgerPath, lines.join('\n'), 'utf8');
		await assert.rejects(ledger.verify(), /checksum mismatch/u);
	});
});

test('controlled writer completes create, searchable reingest, fresh-approved rollback, and audit', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		await mkdir(sourceRoot);
		const sourceId = createSourceId('synthetic:controlled-source');
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'synthetic-directory',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'writer-state'),
		});
		const source = createSourceRef(adapter.adapterId, sourceId, 'Inbox/Created.md');
		const driver = {
			requests: 0,
			async requestReingest(): Promise<void> { this.requests += 1; },
			async observe() {
				const snapshot = await adapter.inspect(source);
				return {
					state: snapshot === null ? 'absent' as const : 'present' as const,
					versionId: snapshot?.baseVersion.versionId ?? null,
					searchable: true,
					generationId: `synthetic-generation-${this.requests}`,
				};
			},
		};
		const authority = new ApprovalTokenAuthority('x'.repeat(32), {
			store: new InMemoryApprovalUseStore(),
		});
		const ledger = new HashChainAuditLedger(path.join(root, 'audit'));
		const writer = new ControlledWriter({
			adapters: [adapter],
			approvalVerifier: authority,
			auditLedger: ledger,
			reingestCoordinator: new ReingestCoordinator(driver, { timeoutMs: 1_000 }),
		});
		const proposal = createCorrectionProposal({
			source,
			operation: 'create',
			proposer,
			rationale: 'Add a synthetic reusable note.',
			beforeContent: null,
			afterContent: '# Created\n\nSynthetic evidence.\n',
		});
		const plan = createWritePlan(proposal);
		const differentProposal = createCorrectionProposal({
			source,
			operation: 'create',
			proposer,
			rationale: 'A different synthetic proposal.',
			beforeContent: null,
			afterContent: '# Different\n',
		});
		const differentPlan = createWritePlan(differentProposal);
		const differentApproval = authority.issue({
			proposalHash: differentProposal.proposalHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'medium',
			ttlMs: 10_000,
		});
		await assert.rejects(
			writer.execute({ proposal, plan: differentPlan, approvalToken: differentApproval }),
			/validation failed/u,
		);
		const approval = authority.issue({
			proposalHash: proposal.proposalHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'medium',
			ttlMs: 10_000,
		});
		const receipt = await writer.execute({ proposal, plan, approvalToken: approval });
		assert.equal(receipt.reingest.searchable, true);
		assert.equal(receipt.reingest.versionId, plan.desiredVersion?.versionId);
		assert.equal(await readFile(path.join(sourceRoot, 'Inbox', 'Created.md'), 'utf8'), plan.afterContent);
		await assert.rejects(writer.execute({ proposal, plan, approvalToken: approval }), /approval failed/u);

		const rollbackPlan = createRollbackPlan({
			receipt,
			initiatedBy: proposer,
			reason: 'Undo the synthetic creation.',
		});
		const rollbackApproval = authority.issue({
			proposalHash: rollbackPlan.rollbackHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'high',
			ttlMs: 10_000,
		});
		const rollbackReceipt = await writer.rollback({
			plan: rollbackPlan,
			approvalToken: rollbackApproval,
		});
		assert.equal(rollbackReceipt.restoredVersion, null);
		assert.equal(rollbackReceipt.reingest.searchable, true);
		await assert.rejects(readFile(path.join(sourceRoot, 'Inbox', 'Created.md')), /ENOENT/u);
		assert.deepEqual(
			(await ledger.verify()).map((entry) => entry.type),
			[
				'write_started', 'write_committed', 'reingest_completed',
				'rollback_started', 'rollback_completed', 'reingest_completed',
			],
		);
	});
});

test('model capability negotiation remains provider-neutral and fail-closed', () => {
	const server = createWriteCapabilityManifest('synthetic-server', {
		supported: ['proposal.correction', 'diff.structured', 'approval.bound-token'],
	});
	const result = negotiateWriteCapabilities({
		protocolVersion: CONTROLLED_WRITE_PROTOCOL_VERSION,
		client: { clientId: 'model-a', modelProvider: 'provider-a', modelName: 'model-a' },
		supported: ['proposal.correction', 'diff.structured', 'write.rollback'],
		required: ['proposal.correction', 'write.rollback'],
	}, server);
	assert.equal(result.accepted, false);
	assert.deepEqual(result.common, ['proposal.correction', 'diff.structured']);
	assert.deepEqual(result.missingRequired, ['write.rollback']);
});

test('post-mutation audit failures return verifiable degraded receipts with rollback capability', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		await mkdir(sourceRoot);
		const sourceId = createSourceId('synthetic:degraded-receipts');
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'degraded-directory',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'state'),
		});
		const source = createSourceRef(adapter.adapterId, sourceId, 'Degraded.md');
		const authority = new ApprovalTokenAuthority('d'.repeat(32), {
			store: new InMemoryApprovalUseStore(),
		});
		const approvalVerifier: ApprovalVerifier = {
			verify: authority.verify.bind(authority),
			consume: authority.consume.bind(authority),
		};
		const ledger = new SelectiveFailureLedger(new HashChainAuditLedger(path.join(root, 'audit')));
		const coordinator = new ReingestCoordinator({
			async requestReingest() {},
			async observe() {
				const snapshot = await adapter.inspect(source);
				return snapshot === null
					? { state: 'absent' as const, versionId: null, searchable: true }
					: {
						state: 'present' as const,
						versionId: snapshot.baseVersion.versionId,
						searchable: true,
					};
			},
		}, { timeoutMs: 100 });
		const writer = new ControlledWriter({
			adapters: [adapter],
			approvalVerifier,
			auditLedger: ledger,
			reingestCoordinator: coordinator,
		});
		const proposal = createCorrectionProposal({
			source,
			operation: 'create',
			proposer,
			rationale: 'Synthetic degraded receipt.',
			beforeContent: null,
			afterContent: 'recoverable mutation\n',
		});
		const plan = createWritePlan(proposal);
		ledger.failures.add('write_committed');
		ledger.failures.add('reingest_completed');
		const approval = authority.issue({
			proposalHash: proposal.proposalHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'medium',
			ttlMs: 10_000,
		});
		const receipt = await writer.execute({ proposal, plan, approvalToken: approval });
		assert.equal(receipt.outcome, 'committed_but_degraded');
		assert.deepEqual(receipt.degradations, ['commit_audit_failed', 'reingest_audit_failed']);
		assert.equal(receipt.commitAuditHash, null);
		assert.equal(receipt.reingestAuditHash, null);
		assert.match(receipt.rollbackToken, /^rollback_v1_/u);
		validateWriteReceipt(receipt);
		assert.equal(await readFile(path.join(sourceRoot, 'Degraded.md'), 'utf8'), 'recoverable mutation\n');

		ledger.failures.clear();
		ledger.failures.add('rollback_completed');
		ledger.failures.add('reingest_completed');
		const rollbackPlan = createRollbackPlan({
			receipt,
			initiatedBy: proposer,
			reason: 'Synthetic degraded rollback.',
		});
		const rollbackApproval = authority.issue({
			proposalHash: rollbackPlan.rollbackHash,
			approvedBy: 'synthetic-reviewer',
			maximumRisk: 'high',
			ttlMs: 10_000,
		});
		const rollbackReceipt = await writer.rollback({
			plan: rollbackPlan,
			approvalToken: rollbackApproval,
		});
		assert.equal(rollbackReceipt.outcome, 'rolled_back_but_degraded');
		assert.deepEqual(
			rollbackReceipt.degradations,
			['rollback_audit_failed', 'reingest_audit_failed'],
		);
		assert.equal(rollbackReceipt.reingest.expectedState, 'absent');
		assert.equal(rollbackReceipt.reingest.observedState, 'absent');
		validateRollbackReceipt(rollbackReceipt);
		await assert.rejects(readFile(path.join(sourceRoot, 'Degraded.md')), /ENOENT/u);
	});
});

test('audit lock recovers a dead PID owner but never steals from a live PID', async () => {
	await withSyntheticRoot(async (root) => {
		const auditRoot = path.join(root, 'audit');
		const ledger = new HashChainAuditLedger(auditRoot, { lockTimeoutMs: 30 });
		await ledger.verify();
		const sourceId = createSourceId('synthetic:audit-lock');
		const source = createSourceRef('synthetic-directory', sourceId, 'Lock.md');
		const event: AuditEvent = {
			type: 'write_started',
			transactionId: 'txn_v1_55555555555555555555555555555555',
			proposalHash: '5'.repeat(64),
			planHash: '6'.repeat(64),
			tokenId: 'approval_v1_55555555555555555555555555555555',
			source,
			operation: 'create',
			baseVersionId: null,
			resultVersionId: null,
		};
		const lockPath = path.join(auditRoot, '.audit.lock');
		await writeFile(lockPath, `${JSON.stringify({
			schemaVersion: 1,
			pid: 2_147_483_647,
			token: '5'.repeat(32),
			createdAt: '2000-01-01T00:00:00.000Z',
		})}\n`, { mode: 0o600 });
		assert.equal((await ledger.append(event)).sequence, 1);

		await writeFile(lockPath, `${JSON.stringify({
			schemaVersion: 1,
			pid: process.pid,
			token: '6'.repeat(32),
			createdAt: '2000-01-01T00:00:00.000Z',
		})}\n`, { mode: 0o600 });
		await assert.rejects(ledger.append(event), /live PID/u);
		assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, '6'.repeat(32));
	});
});

test('owned lock release verifies token ownership and preserves a replacement owner', async () => {
	await withSyntheticRoot(async (root) => {
		const lockPath = path.join(root, '.synthetic.lock');
		await assert.rejects(withOwnedFileLock(lockPath, async () => {
			await writeFile(lockPath, `${JSON.stringify({
				schemaVersion: 1,
				pid: process.pid,
				token: '9'.repeat(32),
				createdAt: '2026-09-15T00:00:00.000Z',
			})}\n`, 'utf8');
		}), /owned by another/u);
		assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, '9'.repeat(32));
		await unlink(lockPath);
	});
});

test('reingest coordinator returns an explicit non-searchable timeout outcome', async () => {
	let now = 0;
	const sourceId = createSourceId('synthetic:reingest-timeout');
	const source = createSourceRef('synthetic-directory', sourceId, 'Timeout.md');
	const expected = createCorrectionProposal({
		source,
		operation: 'create',
		proposer,
		rationale: 'Synthetic reingest timeout.',
		beforeContent: null,
		afterContent: 'not visible yet\n',
	}).after?.baseVersion.versionId;
	assert.ok(expected);
	const coordinator = new ReingestCoordinator({
		async requestReingest() {},
		async observe() { return { state: 'absent' as const, versionId: null, searchable: false }; },
	}, {
		timeoutMs: 100,
		pollIntervalMs: 25,
		clock: () => now,
		delay: async (milliseconds) => { now += milliseconds; },
	});
	const outcome = await coordinator.commitAndAwait(source, expected);
	assert.equal(outcome.searchable, false);
	assert.equal(outcome.timedOut, true);
	assert.equal(outcome.elapsedMs, 100);
	assert.ok(outcome.attempts >= 2);
});
