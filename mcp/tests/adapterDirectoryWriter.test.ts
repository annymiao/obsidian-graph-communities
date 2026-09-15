import assert from 'node:assert/strict';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createSourceId } from '../src/stableIds.js';
import { SafeDirectoryWriterAdapter } from '../src/adapters/directoryWriter.js';
import { InjectableObsidianWriterAdapter } from '../src/adapters/obsidianWriter.js';
import {
	createCorrectionProposal,
	createDocumentSnapshot,
	createSourceRef,
	createWritePlan,
} from '../src/write/proposal.js';
import type { BaseVersion } from '../src/write/contracts.js';

async function withSyntheticRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'directory-adapter-synthetic-'));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const proposer = { clientId: 'synthetic-adapter-test' };

test('directory adapter enforces CAS and leaves no publication temp file', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		await mkdir(path.join(sourceRoot, 'Notes'), { recursive: true });
		await writeFile(path.join(sourceRoot, 'Notes', 'Existing.md'), 'before\n', 'utf8');
		const sourceId = createSourceId('synthetic:directory-cas');
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-cas',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'state'),
		});
		const source = createSourceRef(adapter.adapterId, sourceId, 'Notes/Existing.md');
		const before = await adapter.inspect(source);
		assert.ok(before);
		const proposal = createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Synthetic CAS update.',
			beforeContent: before.content,
			afterContent: 'after\n',
		});
		const plan = createWritePlan(proposal);
		await writeFile(path.join(sourceRoot, 'Notes', 'Existing.md'), 'external change\n', 'utf8');
		await assert.rejects(
			adapter.commit({ transactionId: 'txn_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', plan }),
			/CAS precondition/u,
		);
		assert.equal(await readFile(path.join(sourceRoot, 'Notes', 'Existing.md'), 'utf8'), 'external change\n');

		const latest = await adapter.inspect(source);
		assert.ok(latest);
		const retry = createWritePlan(createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Approved synthetic retry.',
			beforeContent: latest.content,
			afterContent: 'approved\n',
		}));
		await adapter.commit({ transactionId: 'txn_v1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', plan: retry });
		assert.equal(await readFile(path.join(sourceRoot, 'Notes', 'Existing.md'), 'utf8'), 'approved\n');
		assert.deepEqual(
			(await readdir(path.join(sourceRoot, 'Notes'))).filter((name) => name.endsWith('.tmp')),
			[],
		);
	});
});

test('directory adapter rejects traversal, hidden paths, source symlinks, and in-source state', async (context) => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		const outside = path.join(root, 'outside');
		await mkdir(sourceRoot);
		await mkdir(outside);
		const sourceId = createSourceId('synthetic:directory-boundaries');
		assert.throws(
			() => createSourceRef('directory-boundaries', sourceId, '../escape.md'),
			/escape/u,
		);
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-boundaries',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'state'),
		});
		const hidden = createSourceRef(adapter.adapterId, sourceId, '.obsidian/config.md');
		await assert.rejects(adapter.inspect(hidden), /hidden/u);

		try {
			await symlink(outside, path.join(sourceRoot, 'Linked'), 'dir');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				context.skip('Synthetic symlink creation is unavailable on this platform.');
				return;
			}
			throw error;
		}
		const linked = createSourceRef(adapter.adapterId, sourceId, 'Linked/Outside.md');
		await assert.rejects(adapter.inspect(linked), /real directory/u);

		const invalidState = new SafeDirectoryWriterAdapter({
			adapterId: 'invalid-state',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(sourceRoot, 'writer-state'),
		});
		await assert.rejects(invalidState.initialize(), /outside rootPath/u);
	});
});

test('directory rollback capsule is signed, source-bound, CAS-protected, and one-time', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		const stateRoot = path.join(root, 'state');
		await mkdir(sourceRoot);
		await writeFile(path.join(sourceRoot, 'Note.md'), 'before\n', 'utf8');
		const sourceId = createSourceId('synthetic:rollback-capsule');
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-rollback', sourceId, rootPath: sourceRoot, statePath: stateRoot,
		});
		const source = createSourceRef(adapter.adapterId, sourceId, 'Note.md');
		const proposal = createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Synthetic reversible update.',
			beforeContent: 'before\n',
			afterContent: 'after\n',
		});
		const plan = createWritePlan(proposal);
		const transactionId = 'txn_v1_cccccccccccccccccccccccccccccccc';
		const committed = await adapter.commit({ transactionId, plan });
		const rollback = await adapter.rollback({
			transactionId: 'txn_v1_dddddddddddddddddddddddddddddddd',
			originalTransactionId: transactionId,
			source,
			rollbackToken: committed.rollbackToken,
			expectedCurrentVersion: committed.committedVersion,
		});
		assert.equal(rollback.restoredVersion?.versionId, plan.expectedBase?.versionId);
		assert.equal(await readFile(path.join(sourceRoot, 'Note.md'), 'utf8'), 'before\n');
		const consumedMarker = await readFile(
			path.join(stateRoot, 'rollback', `${transactionId}.used`),
			'utf8',
		);
		assert.equal(consumedMarker.includes('before\\n'), false);
		assert.equal(consumedMarker.includes('after\\n'), false);
		assert.equal(consumedMarker.includes('beforeContent'), false);
		await assert.rejects(adapter.rollback({
			transactionId: 'txn_v1_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
			originalTransactionId: transactionId,
			source,
			rollbackToken: committed.rollbackToken,
			expectedCurrentVersion: committed.committedVersion,
		}), /missing or already consumed/u);
	});
});

test('directory rollback resumes a signed in-progress state after restoration and restart', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		const stateRoot = path.join(root, 'state');
		await mkdir(sourceRoot);
		await writeFile(path.join(sourceRoot, 'Restart.md'), 'before restart\n', 'utf8');
		const sourceId = createSourceId('synthetic:rollback-restart');
		let injected = false;
		const interrupted = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-restart',
			sourceId,
			rootPath: sourceRoot,
			statePath: stateRoot,
			testOnlyFaultInjector(point) {
				if (point === 'after-rollback-source-restored' && !injected) {
					injected = true;
					throw new Error('synthetic process interruption');
				}
			},
		});
		const source = createSourceRef(interrupted.adapterId, sourceId, 'Restart.md');
		const plan = createWritePlan(createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Synthetic restart-safe rollback.',
			beforeContent: 'before restart\n',
			afterContent: 'after restart\n',
		}));
		const originalTransactionId = 'txn_v1_12121212121212121212121212121212';
		const committed = await interrupted.commit({ transactionId: originalTransactionId, plan });
		const firstRollback = {
			transactionId: 'txn_v1_13131313131313131313131313131313',
			originalTransactionId,
			source,
			rollbackToken: committed.rollbackToken,
			expectedCurrentVersion: committed.committedVersion,
		};
		await assert.rejects(interrupted.rollback(firstRollback), /synthetic process interruption/u);
		assert.equal(await readFile(path.join(sourceRoot, 'Restart.md'), 'utf8'), 'before restart\n');
		const activeStatePath = path.join(stateRoot, 'rollback', `${originalTransactionId}.json`);
		const inProgress = await readFile(activeStatePath, 'utf8');
		assert.match(inProgress, /"state":"in-progress"/u);

		const restarted = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-restart',
			sourceId,
			rootPath: sourceRoot,
			statePath: stateRoot,
		});
		const recovered = await restarted.rollback({
			...firstRollback,
			transactionId: 'txn_v1_14141414141414141414141414141414',
		});
		assert.deepEqual(recovered.restoredVersion, plan.expectedBase);
		const consumed = await readFile(
			path.join(stateRoot, 'rollback', `${originalTransactionId}.used`),
			'utf8',
		);
		assert.match(consumed, /"state":"consumed"/u);
		assert.equal(consumed.includes('before restart'), false);
		await assert.rejects(restarted.rollback({
			...firstRollback,
			transactionId: 'txn_v1_15151515151515151515151515151515',
		}), /missing or already consumed/u);
	});
});

test('injectable Obsidian adapter verifies bridge preconditions and postconditions without obsidian import', async () => {
	const sourceId = createSourceId('synthetic:obsidian-bridge');
	const source = createSourceRef('obsidian-injected', sourceId, 'Note.md');
	let content: string | null = 'before\n';
	let rollbackContent: string | null = null;
	const bridge = {
		async read(): Promise<string | null> { return content; },
		async compareAndSwap(input: { afterContent: string | null }) {
			rollbackContent = content;
			content = input.afterContent;
			return { rollbackToken: 'synthetic-bridge-rollback' };
		},
		async rollback() {
			content = rollbackContent;
			return {};
		},
	};
	const adapter = new InjectableObsidianWriterAdapter({
		adapterId: source.adapterId,
		sourceId,
		bridge,
	});
	const proposal = createCorrectionProposal({
		source,
		operation: 'replace',
		proposer,
		rationale: 'Synthetic injected bridge edit.',
		beforeContent: 'before\n',
		afterContent: 'after\n',
	});
	const plan = createWritePlan(proposal);
	const result = await adapter.commit({
		transactionId: 'txn_v1_ffffffffffffffffffffffffffffffff',
		plan,
	});
	assert.equal(content, 'after\n');
	const rolledBack = await adapter.rollback({
		transactionId: 'txn_v1_11111111111111111111111111111111',
		originalTransactionId: result.transactionId,
		source,
		rollbackToken: result.rollbackToken,
		expectedCurrentVersion: result.committedVersion,
	});
	assert.equal(content, 'before\n');
	assert.deepEqual(
		rolledBack.restoredVersion,
		createDocumentSnapshot(source, 'before\n').baseVersion,
	);

	content = 'external\n';
	await assert.rejects(adapter.commit({
		transactionId: 'txn_v1_22222222222222222222222222222222',
		plan,
	}), /precondition/u);
});

test('adapter BaseVersion shape is content-addressed for synthetic content', () => {
	const sourceId = createSourceId('synthetic:base-version');
	const source = createSourceRef('synthetic', sourceId, 'Base.md');
	const first: BaseVersion = createDocumentSnapshot(source, 'same\n').baseVersion;
	const second: BaseVersion = createDocumentSnapshot(source, 'same\n').baseVersion;
	const third: BaseVersion = createDocumentSnapshot(source, 'different\n').baseVersion;
	assert.deepEqual(first, second);
	assert.notEqual(first.versionId, third.versionId);
	assert.notEqual(first.contentSha256, third.contentSha256);
});

test('two directory adapter instances serialize publication and only one stale-base plan wins', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		const stateRoot = path.join(root, 'state');
		await mkdir(sourceRoot);
		await writeFile(path.join(sourceRoot, 'Race.md'), 'base\n', 'utf8');
		const sourceId = createSourceId('synthetic:directory-race');
		const first = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-race', sourceId, rootPath: sourceRoot, statePath: stateRoot,
		});
		const second = new SafeDirectoryWriterAdapter({
			adapterId: 'directory-race', sourceId, rootPath: sourceRoot, statePath: stateRoot,
		});
		const source = createSourceRef(first.adapterId, sourceId, 'Race.md');
		const makePlan = (afterContent: string) => createWritePlan(createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Synthetic competing update.',
			beforeContent: 'base\n',
			afterContent,
		}));
		const settled = await Promise.allSettled([
			first.commit({
				transactionId: 'txn_v1_33333333333333333333333333333333',
				plan: makePlan('first\n'),
			}),
			second.commit({
				transactionId: 'txn_v1_44444444444444444444444444444444',
				plan: makePlan('second\n'),
			}),
		]);
		assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
		assert.equal(settled.filter((result) => result.status === 'rejected').length, 1);
		assert.ok(['first\n', 'second\n'].includes(await readFile(path.join(sourceRoot, 'Race.md'), 'utf8')));
	});
});

test('directory writer lock recovers a dead PID owner and refuses a live PID owner', async () => {
	await withSyntheticRoot(async (root) => {
		const sourceRoot = path.join(root, 'source');
		const stateRoot = path.join(root, 'state');
		await mkdir(sourceRoot);
		await writeFile(path.join(sourceRoot, 'Locked.md'), 'base\n', 'utf8');
		const sourceId = createSourceId('synthetic:writer-lock-owner');
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'writer-lock',
			sourceId,
			rootPath: sourceRoot,
			statePath: stateRoot,
			lockTimeoutMs: 30,
		});
		await adapter.initialize();
		const lockPath = path.join(stateRoot, '.writer.lock');
		await writeFile(lockPath, `${JSON.stringify({
			schemaVersion: 1,
			pid: 2_147_483_647,
			token: '7'.repeat(32),
			createdAt: '2000-01-01T00:00:00.000Z',
		})}\n`, { mode: 0o600 });
		const source = createSourceRef(adapter.adapterId, sourceId, 'Locked.md');
		const firstPlan = createWritePlan(createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Recover a synthetic dead writer lock.',
			beforeContent: 'base\n',
			afterContent: 'after stale recovery\n',
		}));
		await adapter.commit({
			transactionId: 'txn_v1_77777777777777777777777777777777',
			plan: firstPlan,
		});
		assert.equal(await readFile(path.join(sourceRoot, 'Locked.md'), 'utf8'), 'after stale recovery\n');

		await writeFile(lockPath, `${JSON.stringify({
			schemaVersion: 1,
			pid: process.pid,
			token: '8'.repeat(32),
			createdAt: '2000-01-01T00:00:00.000Z',
		})}\n`, { mode: 0o600 });
		const secondPlan = createWritePlan(createCorrectionProposal({
			source,
			operation: 'replace',
			proposer,
			rationale: 'Do not steal a synthetic live writer lock.',
			beforeContent: 'after stale recovery\n',
			afterContent: 'must not publish\n',
		}));
		await assert.rejects(adapter.commit({
			transactionId: 'txn_v1_88888888888888888888888888888888',
			plan: secondPlan,
		}), /live PID/u);
		assert.equal(await readFile(path.join(sourceRoot, 'Locked.md'), 'utf8'), 'after stale recovery\n');
		assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).token, '8'.repeat(32));
	});
});
