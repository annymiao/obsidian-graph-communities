import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SafeDirectoryWriterAdapter } from '../src/adapters/directoryWriter.js';
import { OfflineKnowledgeCompiler } from '../src/compiler/offlineKnowledgeCompiler.js';
import { DeterministicLocalEmbedding } from '../src/hybrid/embedding.js';
import { ArtifactGenerationStore } from '../src/persistence/artifactGenerationStore.js';
import type { CompiledArtifactBundle } from '../src/persistence/artifactTypes.js';
import {
	buildCompactPostingIndex,
	materializeLexicalArtifact,
} from '../src/persistence/compactLexical.js';
import {
	createChunkId,
	createSourceId,
	createSpanId,
	type VersionId,
} from '../src/stableIds.js';
import { HashChainAuditLedger } from '../src/write/auditLedger.js';
import {
	SecondBrainRuntime,
	createOfflineEmbeddingProvider,
	type HumanApprovalBroker,
	type HumanApprovalReview,
	type SecondBrainPrincipalPolicy,
} from '../src/secondBrain/index.js';

async function writeNote(root: string, relativePath: string, content: string): Promise<void> {
	const target = path.join(root, relativePath);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, content, 'utf8');
}

test('five-layer runtime queries only compiled generations and closes the human-approved write loop', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-runtime-synthetic-'));
	try {
		const sourceRoot = path.join(root, 'ordinary-source');
		const projectRoot = path.join(root, 'project-source');
		const sourceState = path.join(root, 'ordinary-compiler-state');
		const projectState = path.join(root, 'project-compiler-state');
		const sourceGenerations = path.join(root, 'ordinary-generations');
		const projectGenerations = path.join(root, 'project-generations');
		await mkdir(sourceRoot, { recursive: true });
		await mkdir(projectRoot, { recursive: true });
		const cardFrontmatter = '---\ntype: knowledge-card\nstatus: active\n---\n';
		const baseline = `${cardFrontmatter}# Editable\n\namber baseline signal stays reusable.\n`;
		const corrected = `${cardFrontmatter}# Editable\n\nnebula corrected signal is now reusable.\n`;
		await writeNote(
			sourceRoot,
			'30-Shared-Knowledge/core.md',
			`${cardFrontmatter}# Core\n\norion durable anchor belongs to the reusable core.\n`,
		);
		await writeNote(sourceRoot, '30-Shared-Knowledge/editable.md', baseline);
		await writeNote(
			projectRoot,
			'Projects/secret.md',
			'# Project\n\nquasar private project evidence must remain isolated.\n',
		);

		const embedding = new DeterministicLocalEmbedding(64);
		const sourceId = createSourceId('synthetic:second-brain-ordinary');
		const projectSourceId = createSourceId('synthetic:second-brain-project');
		const sourceCompiler = new OfflineKnowledgeCompiler({
			sourceRoot,
			stateRoot: sourceState,
			generationRoot: sourceGenerations,
			trustedSource: { sourceId },
			embeddingProvider: createOfflineEmbeddingProvider(embedding),
		});
		const projectCompiler = new OfflineKnowledgeCompiler({
			sourceRoot: projectRoot,
			stateRoot: projectState,
			generationRoot: projectGenerations,
			trustedSource: {
				sourceId: projectSourceId,
				projectId: 'project-alpha',
				retrievalScope: 'project',
			},
			embeddingProvider: createOfflineEmbeddingProvider(embedding),
		});
		await Promise.all([sourceCompiler.build(), projectCompiler.build()]);

		await assert.rejects(
			SecondBrainRuntime.open({
				sources: [{
					sourceId,
					label: 'Ordinary notes',
					kind: 'directory',
					generationRoot: sourceGenerations,
				}],
				embeddingAdapter: new DeterministicLocalEmbedding(96),
			}),
			/incompatible/u,
		);

		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'second-brain-directory',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'directory-writer-state'),
		});
		let approvalMode: 'approve' | 'wrong-binding' | 'deny' = 'approve';
		const reviews: HumanApprovalReview[] = [];
		const broker: HumanApprovalBroker = {
			async requestApproval(review) {
				reviews.push(structuredClone(review));
				if (approvalMode === 'wrong-binding') {
					return { approved: true, bindingHash: 'f'.repeat(64), approvedBy: 'synthetic-human' };
				}
				if (approvalMode === 'deny') {
					return { approved: false, bindingHash: review.bindingHash, reason: 'synthetic denial' };
				}
				return { approved: true, bindingHash: review.bindingHash, approvedBy: 'synthetic-human' };
			},
		};
		const writeStateRoot = path.join(root, 'controlled-write-state');
		const runtime = await SecondBrainRuntime.open({
			sources: [
				{
					sourceId,
					label: 'Ordinary notes',
					kind: 'directory',
					generationRoot: sourceGenerations,
					writable: { compiler: sourceCompiler, adapter },
				},
				{
					sourceId: projectSourceId,
					label: 'Project alpha',
					kind: 'directory',
					projectId: 'project-alpha',
					generationRoot: projectGenerations,
				},
			],
			embeddingAdapter: embedding,
			humanApprovalBroker: broker,
			approvalSecret: 'runtime-test-approval-secret-material-32-bytes',
			writeStateRoot,
			maximumPendingReviews: 1,
		});

		const generalPrincipal: SecondBrainPrincipalPolicy = {
			principalId: 'synthetic-general-client',
			allowedSourceIds: [sourceId, projectSourceId],
			allowedModes: ['default', 'project'],
		};
		const projectPrincipal: SecondBrainPrincipalPolicy = {
			...generalPrincipal,
			principalId: 'synthetic-project-client',
			allowedProjectIds: ['project-alpha'],
		};
		const writePrincipal: SecondBrainPrincipalPolicy = {
			...generalPrincipal,
			principalId: 'synthetic-path-scoped-writer',
			includedPathPrefixes: ['30-Shared-Knowledge'],
			excludedPathPrefixes: ['30-Shared-Knowledge/blocked'],
		};
		const caseMismatchPrincipal: SecondBrainPrincipalPolicy = {
			...generalPrincipal,
			principalId: 'synthetic-case-mismatch-client',
			includedPathPrefixes: ['30-shared-knowledge'],
		};
		const excludedWriter: SecondBrainPrincipalPolicy = {
			...writePrincipal,
			principalId: 'synthetic-excluded-writer',
			excludedPathPrefixes: ['30-Shared-Knowledge'],
		};

		const core = await runtime.query(generalPrincipal, { text: 'orion durable anchor', mode: 'default' });
		assert.equal(core.status, 'ok');
		assert.ok(core.deadlineMs <= 4_980, 'runtime must reserve overhead inside the five-second hard limit');
		assert.equal(core.evidence[0]?.sourceId, sourceId);
		const caseMismatchRead = await runtime.query(caseMismatchPrincipal, {
			text: 'orion durable anchor',
			mode: 'default',
		});
		assert.equal(
			caseMismatchRead.status,
			'no_evidence',
			'path ACLs must not fold case on a case-sensitive source',
		);
		const boundRead = runtime.bindRead(generalPrincipal);
		const boundCore = await boundRead.query({ text: 'orion durable anchor', mode: 'default' });
		assert.equal(boundCore.status, 'ok');
		assert.equal(boundRead.status().sourceCount, 1);
		const deniedProject = await runtime.query(generalPrincipal, {
			text: 'quasar private project evidence',
			mode: 'project',
		});
		assert.equal(deniedProject.status, 'no_evidence');
		assert.equal(deniedProject.evidence.length, 0);
		const allowedProject = await runtime.query(projectPrincipal, {
			text: 'quasar private project evidence',
			mode: 'project',
		});
		assert.equal(allowedProject.status, 'ok');
		assert.equal(allowedProject.evidence[0]?.sourceId, projectSourceId);

		const hiddenSourceRoot = path.join(root, 'ordinary-source-disconnected');
		await rename(sourceRoot, hiddenSourceRoot);
		const compiledOnly = await runtime.query(generalPrincipal, {
			text: 'orion durable anchor',
			mode: 'default',
		});
		assert.equal(compiledOnly.status, 'ok', 'online query must not access sourceRoot');
		await rename(hiddenSourceRoot, sourceRoot);

		const visibleStatus = runtime.status(generalPrincipal);
		assert.equal(visibleStatus.sourceCount, 1, 'project source status must also be authorization-filtered');
		assert.equal(visibleStatus.vector.precomputed, true);
		const serializedStatus = JSON.stringify(visibleStatus);
		assert.equal(serializedStatus.includes(root), false);
		assert.equal(serializedStatus.includes('orion durable anchor'), false);

		await assert.rejects(
			runtime.prepareWrite({
				principal: caseMismatchPrincipal,
				sourceId,
				documentPath: '30-Shared-Knowledge/editable.md',
				operation: 'replace',
				rationale: 'A case-colliding include prefix must not authorize a write.',
				afterContent: corrected,
			}),
			/not writable/u,
		);
		await assert.rejects(
			runtime.prepareWrite({
				principal: excludedWriter,
				sourceId,
				documentPath: '30-Shared-Knowledge/editable.md',
				operation: 'replace',
				rationale: 'A path-excluded principal must not create a review.',
				afterContent: corrected,
			}),
			/not writable/u,
		);
		await assert.rejects(
			runtime.prepareWrite({
				principal: writePrincipal,
				sourceId,
				documentPath: 'Elsewhere/not-allowed.md',
				operation: 'create',
				rationale: 'An include prefix can only narrow write authority.',
				afterContent: corrected,
			}),
			/not writable/u,
		);

		approvalMode = 'wrong-binding';
		const wrongBinding = await runtime.prepareWrite({
			principal: writePrincipal,
			sourceId,
			documentPath: '30-Shared-Knowledge/editable.md',
			operation: 'replace',
			rationale: 'Correct the synthetic reusable signal.',
			afterContent: corrected,
			modelProvider: 'synthetic-provider',
			modelName: 'synthetic-model',
		});
		assert.match(wrongBinding.preparedId, /^prepared_write_v1_[a-f0-9]{32}$/u);
		assert.equal(wrongBinding.reviewText.endsWith('\n'), true);
		assert.equal(JSON.stringify(wrongBinding).includes(root), false);
		await assert.rejects(
			runtime.prepareWrite({
				principal: generalPrincipal,
				sourceId,
				documentPath: '30-Shared-Knowledge/editable.md',
				operation: 'replace',
				rationale: 'A second pending review should hit the bound.',
				afterContent: corrected,
			}),
			/pending human review limit/iu,
		);
		await assert.rejects(
			runtime.approveAndCommitWrite(wrongBinding.preparedId),
			/bound to a different review/u,
		);
		await assert.rejects(
			runtime.approveAndCommitWrite(wrongBinding.preparedId),
			/missing, expired, or already used/u,
		);
		assert.equal(await readFile(path.join(sourceRoot, '30-Shared-Knowledge', 'editable.md'), 'utf8'), baseline);

		approvalMode = 'approve';
		const prepared = await runtime.prepareWrite({
			principal: writePrincipal,
			sourceId,
			documentPath: '30-Shared-Knowledge/editable.md',
			operation: 'replace',
			rationale: 'Correct the synthetic reusable signal.',
			afterContent: corrected,
		});
		assert.ok(prepared.reviewText.includes('nebula corrected signal'));
		const receipt = await runtime.approveAndCommitWrite(prepared.preparedId);
		assert.equal(receipt.reingest.searchable, true);
		assert.equal(await readFile(path.join(sourceRoot, '30-Shared-Knowledge', 'editable.md'), 'utf8'), corrected);
		const correctedQuery = await runtime.query(generalPrincipal, {
			text: 'nebula corrected',
			mode: 'default',
		});
		assert.equal(correctedQuery.status, 'ok');
		assert.equal(correctedQuery.evidence[0]?.versionId, receipt.committedVersion?.versionId);

		const rollback = runtime.prepareRollback({
			principal: writePrincipal,
			receipt,
			reason: 'Restore the synthetic baseline.',
		});
		assert.throws(
			() => runtime.prepareRollback({
				principal: excludedWriter,
				receipt,
				reason: 'A path-excluded principal cannot roll back another path.',
			}),
			/not writable/u,
		);
		assert.equal(JSON.stringify(rollback).includes(receipt.rollbackToken), false);
		assert.equal(JSON.stringify(rollback).includes(root), false);
		const rollbackReceipt = await runtime.approveAndRollback(rollback.preparedId);
		assert.equal(rollbackReceipt.reingest.searchable, true);
		assert.equal(await readFile(path.join(sourceRoot, '30-Shared-Knowledge', 'editable.md'), 'utf8'), baseline);
		const restoredQuery = await runtime.query(generalPrincipal, {
			text: 'amber baseline signal',
			mode: 'default',
		});
		assert.equal(restoredQuery.status, 'ok');
		const removedCorrection = await runtime.query(generalPrincipal, {
			text: 'nebula corrected',
			mode: 'default',
		});
		assert.equal(removedCorrection.status, 'no_evidence');

		assert.equal(reviews.length, 3);
		const audit = await new HashChainAuditLedger(path.join(writeStateRoot, 'audit')).verify();
		assert.ok(audit.some((entry) => entry.type === 'write_committed'));
		assert.ok(audit.some((entry) => entry.type === 'rollback_completed'));
		assert.ok(audit.some((entry) => entry.type === 'reingest_completed'));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('controlled reingest validates the exact generation before publishing its durable pin', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-reingest-validation-'));
	try {
		const sourceRoot = path.join(root, 'source');
		const stateRoot = path.join(root, 'compiler-state');
		const generationRoot = path.join(root, 'generations');
		const sourceId = createSourceId('synthetic:reingest-validation');
		const baseline = '---\ntype: knowledge-card\nstatus: active\n---\n# Note\n\namber stable baseline.\n';
		const corrected = '---\ntype: knowledge-card\nstatus: active\n---\n# Note\n\nnebula corrected marker.\n';
		await writeNote(sourceRoot, '30-Shared-Knowledge/note.md', baseline);
		const embedding = new DeterministicLocalEmbedding(32);
		const authoritativeCompiler = new OfflineKnowledgeCompiler({
			sourceRoot,
			stateRoot,
			generationRoot,
			trustedSource: { sourceId },
			embeddingProvider: createOfflineEmbeddingProvider(embedding),
		});
		const initial = await authoritativeCompiler.build();
		const nonexistentGenerationId = `gen-0000000000000-${'f'.repeat(32)}`;
		const returningInvalidPin = {
			sourceId: authoritativeCompiler.sourceId,
			projectId: authoritativeCompiler.projectId,
			policyHash: authoritativeCompiler.policyHash,
			policy: authoritativeCompiler.policy,
			async build() {
				const built = await authoritativeCompiler.build();
				return {
					...built,
					generation: { ...built.generation, generationId: nonexistentGenerationId },
				};
			},
			readCurrent: () => authoritativeCompiler.readCurrent(),
			readGeneration: (generationId: string) => authoritativeCompiler.readGeneration(generationId),
		} as unknown as OfflineKnowledgeCompiler;
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'reingest-validation-directory',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'writer-state'),
		});
		const broker: HumanApprovalBroker = {
			async requestApproval(review) {
				return { approved: true, bindingHash: review.bindingHash, approvedBy: 'synthetic-human' };
			},
		};
		let publishedPins = 0;
		const runtime = await SecondBrainRuntime.open({
			sources: [{
				sourceId,
				label: 'Reingest validation',
				kind: 'directory',
				generationRoot,
				pinnedGenerationId: initial.generation.generationId,
				pinnedManifestSha256: initial.generation.manifestSha256,
				writable: { compiler: returningInvalidPin, adapter },
			}],
			embeddingAdapter: embedding,
			humanApprovalBroker: broker,
			approvalSecret: 'reingest-validation-secret-material-32-bytes',
			writeStateRoot: path.join(root, 'write-state'),
			onGenerationPublished: async () => {
				publishedPins += 1;
			},
		});
		const principal: SecondBrainPrincipalPolicy = {
			principalId: 'synthetic-writer',
			allowedSourceIds: [sourceId],
			allowedModes: ['default'],
		};
		const revisionBefore = runtime.status(principal).revision;
		const prepared = await runtime.prepareWrite({
			principal,
			sourceId,
			documentPath: '30-Shared-Knowledge/note.md',
			operation: 'replace',
			rationale: 'Exercise exact generation validation before durable publication.',
			afterContent: corrected,
		});
		const receipt = await runtime.approveAndCommitWrite(prepared.preparedId);
		assert.equal(receipt.outcome, 'committed_but_degraded');
		assert.equal(receipt.reingest.searchable, false);
		assert.equal(publishedPins, 0, 'an unvalidated generation must never reach the catalog hook');
		assert.equal(runtime.status(principal).revision, revisionBefore);
		const oldView = await runtime.query(principal, { text: 'amber stable baseline', mode: 'default' });
		assert.equal(oldView.status, 'ok', 'failed reingest must retain the prior in-memory generation');
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('concurrent controlled writes serialize the complete reingest and catalog-pin transition per source', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-concurrent-reingest-'));
	try {
		const sourceRoot = path.join(root, 'source');
		const generationRoot = path.join(root, 'generations');
		const sourceId = createSourceId('synthetic:concurrent-reingest');
		await writeNote(sourceRoot, 'seed.md', '# Seed\n\nstable seed evidence.\n');
		const embedding = new DeterministicLocalEmbedding(32);
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot,
			stateRoot: path.join(root, 'compiler-state'),
			generationRoot,
			trustedSource: { sourceId },
			embeddingProvider: createOfflineEmbeddingProvider(embedding),
		});
		const initial = await compiler.build();
		const adapter = new SafeDirectoryWriterAdapter({
			adapterId: 'concurrent-reingest-directory',
			sourceId,
			rootPath: sourceRoot,
			statePath: path.join(root, 'writer-state'),
		});
		const broker: HumanApprovalBroker = {
			async requestApproval(review) {
				return { approved: true, bindingHash: review.bindingHash, approvedBy: 'synthetic-human' };
			},
		};
		let durableGenerationId = initial.generation.generationId;
		let durableManifestSha256 = initial.generation.manifestSha256;
		const transitions: Array<{ expected: string; target: string }> = [];
		const runtime = await SecondBrainRuntime.open({
			sources: [{
				sourceId,
				label: 'Concurrent reingest',
				kind: 'directory',
				generationRoot,
				pinnedGenerationId: durableGenerationId,
				pinnedManifestSha256: durableManifestSha256,
				writable: { compiler, adapter },
			}],
			embeddingAdapter: embedding,
			humanApprovalBroker: broker,
			approvalSecret: 'concurrent-reingest-secret-material-32-bytes',
			writeStateRoot: path.join(root, 'write-state'),
			onGenerationPublished: async (
				_sourceId,
				generationId,
				manifestSha256,
				expectedGenerationId,
				expectedManifestSha256,
			) => {
				assert.equal(expectedGenerationId, durableGenerationId);
				assert.equal(expectedManifestSha256, durableManifestSha256);
				transitions.push({ expected: expectedGenerationId, target: generationId });
				durableGenerationId = generationId;
				durableManifestSha256 = manifestSha256;
			},
		});
		const principal: SecondBrainPrincipalPolicy = {
			principalId: 'synthetic-concurrent-writer',
			allowedSourceIds: [sourceId],
			allowedModes: ['default'],
		};
		const contents = [
			'---\ntype: knowledge-card\nstatus: active\n---\n# First\n\ncerulean concurrent marker.\n',
			'---\ntype: knowledge-card\nstatus: active\n---\n# Second\n\nmagenta concurrent marker.\n',
		];
		const prepared = await Promise.all(contents.map((afterContent, index) => runtime.prepareWrite({
			principal,
			sourceId,
			documentPath: `concurrent-${index + 1}.md`,
			operation: 'create',
			rationale: 'Exercise per-source reingest serialization.',
			afterContent,
		})));
		const receipts = await Promise.all(prepared.map((review) => (
			runtime.approveAndCommitWrite(review.preparedId)
		)));
		assert.ok(receipts.every((receipt) => receipt.outcome === 'committed'));
		assert.ok(receipts.every((receipt) => receipt.reingest.searchable));
		assert.equal(transitions.length, 2);
		assert.equal(transitions[1]?.expected, transitions[0]?.target);
		assert.equal(runtime.status(principal).sources[0]?.generationId, durableGenerationId);
		const durable = await compiler.readGeneration(durableGenerationId);
		assert.deepEqual(
			durable.bundle.layers.derived.data.documents.map((document) => document.path).sort(),
			['concurrent-1.md', 'concurrent-2.md', 'seed.md'],
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('runtime rejects independently rehashed cross-layer semantic drift', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-layer-drift-synthetic-'));
	try {
		const sourceRoot = path.join(root, 'source');
		await mkdir(sourceRoot, { recursive: true });
		await writeNote(
			sourceRoot,
			'note.md',
			'---\ntype: knowledge-card\nstatus: active\n---\n# Verified\n\nalpha beta gamma.\n',
		);
		const sourceId = createSourceId('synthetic:semantic-layer-drift');
		const embedding = new DeterministicLocalEmbedding(32);
		const compiler = new OfflineKnowledgeCompiler({
			sourceRoot,
			stateRoot: path.join(root, 'state'),
			generationRoot: path.join(root, 'valid-generations'),
			trustedSource: { sourceId },
			embeddingProvider: createOfflineEmbeddingProvider(embedding),
		});
		const valid = (await compiler.build()).generation.bundle;
		const cases: Array<{
			name: string;
			mutate: (bundle: CompiledArtifactBundle) => void;
		}> = [
			{
				name: 'catalog/derived content hash drift',
				mutate(bundle) {
					const entry = bundle.layers.catalog.data.entries[0];
					assert.ok(entry);
					entry.contentSha256 = entry.contentSha256 === '0'.repeat(64)
						? '1'.repeat(64)
						: '0'.repeat(64);
				},
			},
			{
				name: 'hierarchy heading drift',
				mutate(bundle) {
					const hierarchy = bundle.layers.hierarchy.data.byOrdinal[0];
					assert.ok(hierarchy);
					hierarchy.headings = [];
				},
			},
			{
				name: 'temporal provenance drift',
				mutate(bundle) {
					const temporal = bundle.layers.temporal.data.byOrdinal[0];
					assert.ok(temporal);
					temporal.firstSeenAt = '2000-01-01T00:00:00.000Z';
				},
			},
			{
				name: 'required chunk lexical index missing',
				mutate(bundle) {
					delete (bundle.layers.lexical.data as { chunkIndex?: unknown }).chunkIndex;
				},
			},
			{
				name: 'chunk lexical version drift',
				mutate(bundle) {
					const identity = bundle.layers.lexical.data.chunkIndex.records[0];
					assert.ok(identity);
					identity.versionId = `ver_v1_${'A'.repeat(43)}`;
				},
			},
			{
				name: 'lexical posting drift',
				mutate(bundle) {
					const materialized = materializeLexicalArtifact(bundle.layers.lexical.data);
					const firstPosting = materialized.postings.values().next().value as Map<number, number> | undefined;
					assert.ok(firstPosting);
					const firstOrdinal = firstPosting.keys().next().value as number | undefined;
					assert.notEqual(firstOrdinal, undefined);
					firstPosting.set(firstOrdinal as number, (firstPosting.get(firstOrdinal as number) ?? 0) + 1);
					const termsByOrdinal = new Map<number, Map<string, number>>();
					for (const [term, posting] of materialized.postings) {
						for (const [ordinal, frequency] of posting) {
							const terms = termsByOrdinal.get(ordinal) ?? new Map<string, number>();
							terms.set(term, frequency);
							termsByOrdinal.set(ordinal, terms);
						}
					}
					bundle.layers.lexical.data = {
						schemaVersion: 1,
						base: buildCompactPostingIndex([...materialized.documentLengths].map(
							([ordinal, documentLength]) => ({
								ordinal,
								documentLength,
								termFrequencies: termsByOrdinal.get(ordinal) ?? new Map(),
							}),
						)),
						deltas: [],
						chunkIndex: bundle.layers.lexical.data.chunkIndex,
					};
				},
			},
			{
				name: 'span/chunk provenance drift',
				mutate(bundle) {
					const document = bundle.layers.derived.data.documents[0];
					const chunk = document?.chunks[0];
					assert.ok(document && chunk);
					const changedSpan = createSpanId(document.versionId as VersionId, {
						startLine: chunk.startLine,
						endLine: chunk.endLine + 1,
					});
					chunk.spanId = changedSpan;
					chunk.chunkId = createChunkId(changedSpan, chunk.content);
				},
			},
		];

		for (const [index, scenario] of cases.entries()) {
			const bundle = structuredClone(valid);
			scenario.mutate(bundle);
			const generationRoot = path.join(root, `tampered-${index}`);
			await new ArtifactGenerationStore(generationRoot).publish({
				compilerVersion: bundle.compilerVersion,
				createdAt: bundle.createdAt,
				policyHash: bundle.policyHash,
				layers: {
					catalog: bundle.layers.catalog.data,
					lexical: bundle.layers.lexical.data,
					derived: bundle.layers.derived.data,
					temporal: bundle.layers.temporal.data,
					hierarchy: bundle.layers.hierarchy.data,
					vector: bundle.layers.vector?.data ?? null,
				},
				statistics: bundle.statistics,
			});
			await assert.rejects(
				SecondBrainRuntime.open({
					sources: [{ sourceId, label: `Synthetic drift ${index}`, kind: 'directory', generationRoot }],
					embeddingAdapter: embedding,
				}),
				/Compiled source/u,
				scenario.name,
			);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
