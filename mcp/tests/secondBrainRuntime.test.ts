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
			includedPathPrefixes: ['30-shared-knowledge'],
			excludedPathPrefixes: ['30-shared-knowledge/blocked'],
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
