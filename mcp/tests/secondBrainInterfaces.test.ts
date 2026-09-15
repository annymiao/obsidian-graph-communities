import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import {
	chmod,
	link,
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	OneTimeHumanApprovalBroker,
	createSecondBrainBootstrap,
	loadSecondBrainBuildConfiguration,
	loadSecondBrainEmbeddingAdapter,
	readMcpWriteApprovalMode,
} from '../src/secondBrainBootstrap.js';
import {
	compileConfiguredSources,
	parseOfflineCompileArguments,
} from '../src/offlineCompile.js';
import { createSecondBrainMcpServer } from '../src/secondBrainMcp.js';
import type { SecondBrainRuntimeApi } from '../src/secondBrain/types.js';
import {
	createSecondBrainHttpServer,
	loadSecondBrainHttpOptions,
} from '../src/secondBrainHttp.js';
import {
	collectTransmissionReview,
	submitTransmissionReview,
} from '../src/transmissionReview.js';

const API_KEY = 'synthetic-local-api-key-32-bytes-minimum';
const CARD = '---\ntype: knowledge-card\nstatus: active\n---\n';

test('production catalog starts disconnected, and MCP/HTTP enforce reusable safe interfaces', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-interfaces-synthetic-'));
	const ordinaryRoot = path.join(root, 'ordinary-source');
	const projectRoot = path.join(root, 'project-source');
	const artifactRoot = path.join(root, 'local-artifacts');
	const hiddenOrdinary = path.join(root, 'ordinary-source-disconnected');
	const hiddenProject = path.join(root, 'project-source-disconnected');
	let ordinaryHidden = false;
	let projectHidden = false;
	try {
		await mkdir(path.join(ordinaryRoot, '30-Shared-Knowledge'), { recursive: true });
		await mkdir(path.join(ordinaryRoot, 'Ignored'), { recursive: true });
		await mkdir(path.join(projectRoot, 'Projects'), { recursive: true });
		const baseline = `${CARD}# Durable note\n\namber reusable baseline.\n`;
		const corrected = `${CARD}# Durable note\n\nnebula corrected reusable fact.\n`;
		await writeFile(path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'), baseline, 'utf8');
		await writeFile(path.join(ordinaryRoot, 'Ignored', 'private.md'), 'secret ignored marker', 'utf8');
		await writeFile(path.join(projectRoot, 'Projects', 'project.md'), '# Project\n\nquasar project-only marker.\n', 'utf8');

		const offlineEnvironment: NodeJS.ProcessEnv = {
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{
					id: 'synthetic:ordinary',
					name: 'Synthetic ordinary',
					path: ordinaryRoot,
					kind: 'directory',
					writable: true,
				},
				{
					id: 'synthetic:project',
					name: 'Synthetic project',
					path: projectRoot,
					kind: 'directory',
					project_id: 'project-alpha',
				},
			]),
			OBSIDIAN_ARTIFACT_PATH: artifactRoot,
			OBSIDIAN_PERSIST_INDEX: 'true',
			OBSIDIAN_EXCLUDE_FOLDERS: 'Ignored',
			OBSIDIAN_EMBEDDING_DIMENSION: '64',
			OBSIDIAN_TRANSMISSION_REVIEW: 'required',
			OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL: 'trusted-mcp-app',
		};
		const compileSummary = await compileConfiguredSources(offlineEnvironment);
		assert.equal(compileSummary.status, 'ready');
		assert.equal(compileSummary.sourceCount, 2);
		assert.equal(compileSummary.activeDocuments, 2, 'excluded folders must map to compiler prefixes');
		assert.equal(JSON.stringify(compileSummary).includes(root), false);
		assert.equal(JSON.stringify(compileSummary).includes('amber reusable baseline'), false);

		// Advance only one source CURRENT without publishing the global catalog.
		// A production bootstrap must remain on the all-source generation set that
		// the catalog pinned, rather than observing this partial compile.
		await writeFile(
			path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'),
			`${CARD}# Durable note\n\npartial-generation-only marker.\n`,
			'utf8',
		);
		const partialConfiguration = await loadSecondBrainBuildConfiguration(offlineEnvironment);
		const partialSource = partialConfiguration.sources.find(
			(source) => source.descriptor.label === 'Synthetic ordinary',
		);
		assert.ok(partialSource);
		await partialSource.compiler.build();
		await writeFile(
			path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'),
			baseline,
			'utf8',
		);

		const catalogPath = path.join(artifactRoot, 'second-brain-v1', 'runtime-catalog.json');
		const catalogText = await readFile(catalogPath, 'utf8');
		assert.equal((await stat(catalogPath)).mode & 0o077, 0);
		assert.equal(catalogText.includes(ordinaryRoot), true, 'writable source needs a private reingest locator');
		assert.equal(catalogText.includes(projectRoot), false, 'read-only source roots must not enter runtime catalog');
		const onlineEnvironment: NodeJS.ProcessEnv = {
			OBSIDIAN_ARTIFACT_PATH: artifactRoot,
			OBSIDIAN_EMBEDDING_DIMENSION: '64',
			OBSIDIAN_TRANSMISSION_REVIEW: 'required',
			OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL: 'trusted-mcp-app',
		};
		if (process.platform !== 'win32') {
			await chmod(catalogPath, 0o640);
			await assert.rejects(
				createSecondBrainBootstrap(onlineEnvironment),
				/opened or validated safely/u,
			);
			await chmod(catalogPath, 0o600);
			const catalogLink = path.join(root, 'runtime-catalog-hardlink.json');
			await link(catalogPath, catalogLink);
			try {
				await assert.rejects(
					createSecondBrainBootstrap(onlineEnvironment),
					/opened or validated safely/u,
				);
			} finally {
				await unlink(catalogLink);
			}
		}
		await writeFile(catalogPath, catalogText.replace('"createdAt"', '"createdAx"'), 'utf8');
		await assert.rejects(createSecondBrainBootstrap(onlineEnvironment), /checksum mismatch/u);
		await writeFile(catalogPath, catalogText, 'utf8');

		await rename(ordinaryRoot, hiddenOrdinary);
		ordinaryHidden = true;
		await rename(projectRoot, hiddenProject);
		projectHidden = true;
		const bootstrap = await createSecondBrainBootstrap(onlineEnvironment);
		const ordinarySourceId = compileSummary.sources
			.find((source) => source.label === 'Synthetic ordinary')?.sourceId;
		const projectSourceId = compileSummary.sources
			.find((source) => source.label === 'Synthetic project')?.sourceId;
		assert.ok(ordinarySourceId && projectSourceId);
		const restricted = await createSecondBrainBootstrap({
			...onlineEnvironment,
			OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS: ordinarySourceId,
		});
		assert.equal(restricted.runtime.status(restricted.principal).sourceCount, 1);
		assert.equal((await restricted.runtime.query(restricted.principal, {
			text: 'quasar project-only marker',
			mode: 'project',
			sourceIds: [projectSourceId],
		})).status, 'no_evidence', 'request source filters may only narrow the local principal ACL');
		const compiledQuery = await bootstrap.runtime.query(
			bootstrap.principal,
			{ text: 'amber reusable baseline', mode: 'default' },
		);
		assert.equal(compiledQuery.status, 'ok', 'online bootstrap must not stat the disconnected source');
		const partialGenerationQuery = await bootstrap.runtime.query(
			bootstrap.principal,
			{ text: 'partial-generation-only marker', mode: 'default' },
		);
		assert.equal(
			partialGenerationQuery.status,
			'no_evidence',
			'runtime catalog must pin one atomic multi-source generation set',
		);
		const projectQuery = await bootstrap.runtime.query(
			bootstrap.principal,
			{ text: 'quasar project-only marker', mode: 'project' },
		);
		assert.equal(projectQuery.status, 'ok');
		assert.equal(JSON.stringify(bootstrap.runtime.status(bootstrap.principal)).includes(root), false);

		await rename(hiddenOrdinary, ordinaryRoot);
		ordinaryHidden = false;
		// Leave the read-only project disconnected: controlled writes and queries
		// must not require unrelated source availability.

		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const server = createSecondBrainMcpServer(
			bootstrap.runtime,
			bootstrap.principal,
			{
				transport: 'stdio',
				transmissionReviewMode: 'required',
				approvalBroker: bootstrap.approvalBroker,
				controlledWritesEnabled: true,
			},
		);
		const client = new Client({ name: 'synthetic-interface-test', version: '1.3.0' });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
		try {
			const tools = await client.listTools();
			const names = tools.tools.map((tool) => tool.name);
			for (const required of [
				'get_second_brain_status',
				'query_second_brain',
				'prepare_second_brain_write',
				'commit_reviewed_second_brain_write',
				'prepare_second_brain_rollback',
				'commit_reviewed_second_brain_rollback',
				'get_review_draft_for_ui',
				'submit_review_decision_for_ui',
			]) assert.ok(names.includes(required));
			const sourceId = ordinarySourceId;

			const firstPrepared = await client.callTool({
				name: 'prepare_second_brain_write',
				arguments: {
					source_id: sourceId,
					path: '30-Shared-Knowledge/durable.md',
					operation: 'replace',
					rationale: 'Apply a synthetic correction.',
					after_content: corrected,
				},
			});
			const firstPublic = JSON.stringify({
				content: firstPrepared.content,
				structuredContent: firstPrepared.structuredContent,
			});
			assert.equal(firstPublic.includes('ui_token'), false);
			assert.equal(firstPublic.includes('ApprovalToken'), false);
			const firstCredentials = reviewCredentials(firstPrepared);
			const firstPreparedId = requiredStructuredString(firstPrepared, 'prepared_id');

			const crossFlow = await client.callTool({
				name: 'receive_reviewed_second_brain_query',
				arguments: { review_id: firstCredentials.reviewId },
			});
			assert.equal(crossFlow.isError, true, 'query collector must never release a write review');

			const firstDraftResult = await client.callTool({
				name: 'get_review_draft_for_ui',
				arguments: {
					review_id: firstCredentials.reviewId,
					ui_token: firstCredentials.uiToken,
				},
			});
			const firstDraft = privateDraftContent(firstDraftResult);
			await client.callTool({
				name: 'submit_review_decision_for_ui',
				arguments: {
					review_id: firstCredentials.reviewId,
					ui_token: firstCredentials.uiToken,
					action: 'approve',
					content: firstDraft.replace('nebula corrected', 'tampered correction'),
				},
			});
			const editedCommit = await client.callTool({
				name: 'commit_reviewed_second_brain_write',
				arguments: {
					prepared_id: firstPreparedId,
					review_id: firstCredentials.reviewId,
				},
			});
			assert.equal(editedCommit.isError, true);
			assert.match(JSON.stringify(editedCommit.content), /edited/u);
			assert.equal(await readFile(path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'), 'utf8'), baseline);

			const prepared = await client.callTool({
				name: 'prepare_second_brain_write',
				arguments: {
					source_id: sourceId,
					path: '30-Shared-Knowledge/durable.md',
					operation: 'replace',
					rationale: 'Apply a synthetic correction.',
					after_content: corrected,
				},
			});
			const credentials = reviewCredentials(prepared);
			const preparedId = requiredStructuredString(prepared, 'prepared_id');
			const draftResult = await client.callTool({
				name: 'get_review_draft_for_ui',
				arguments: { review_id: credentials.reviewId, ui_token: credentials.uiToken },
			});
			const exactDraft = privateDraftContent(draftResult);
			await client.callTool({
				name: 'submit_review_decision_for_ui',
				arguments: {
					review_id: credentials.reviewId,
					ui_token: credentials.uiToken,
					action: 'approve',
					content: exactDraft,
				},
			});
			const committed = await client.callTool({
				name: 'commit_reviewed_second_brain_write',
				arguments: { prepared_id: preparedId, review_id: credentials.reviewId },
			});
			assert.equal(committed.isError, undefined, firstText(committed));
			assert.equal(JSON.stringify(committed).includes('signature'), false);
			assert.equal(await readFile(path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'), 'utf8'), corrected);
			const receipt = JSON.parse(firstText(committed)) as Record<string, unknown>;

			const rollbackPrepared = await client.callTool({
				name: 'prepare_second_brain_rollback',
				arguments: { receipt, reason: 'Restore the synthetic baseline.' },
			});
			const rollbackCredentials = reviewCredentials(rollbackPrepared);
			const rollbackPreparedId = requiredStructuredString(rollbackPrepared, 'prepared_id');
			const rollbackDraftResult = await client.callTool({
				name: 'get_review_draft_for_ui',
				arguments: {
					review_id: rollbackCredentials.reviewId,
					ui_token: rollbackCredentials.uiToken,
				},
			});
			await client.callTool({
				name: 'submit_review_decision_for_ui',
				arguments: {
					review_id: rollbackCredentials.reviewId,
					ui_token: rollbackCredentials.uiToken,
					action: 'approve',
					content: privateDraftContent(rollbackDraftResult),
				},
			});
			const rolledBack = await client.callTool({
				name: 'commit_reviewed_second_brain_rollback',
				arguments: {
					prepared_id: rollbackPreparedId,
					review_id: rollbackCredentials.reviewId,
				},
			});
			assert.equal(rolledBack.isError, undefined);
			assert.equal(await readFile(path.join(ordinaryRoot, '30-Shared-Knowledge', 'durable.md'), 'utf8'), baseline);
		} finally {
			await client.close();
			await server.close();
		}

		await rename(ordinaryRoot, hiddenOrdinary);
		ordinaryHidden = true;
		const restartedBootstrap = await createSecondBrainBootstrap(onlineEnvironment);
		const restartedQuery = await restartedBootstrap.runtime.query(
			restartedBootstrap.principal,
			{ text: 'amber reusable baseline', mode: 'default' },
		);
		assert.equal(
			restartedQuery.status,
			'ok',
			'approved write and rollback must persist their new generation pins before restart',
		);
		const httpOptions = loadSecondBrainHttpOptions({
			OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY: API_KEY,
			OBSIDIAN_SECOND_BRAIN_HTTP_PORT: '27124',
		});
		const http = createSecondBrainHttpServer(
			restartedBootstrap.runtime,
			restartedBootstrap.principal,
			{ ...httpOptions, port: 0 },
		);
		await new Promise<void>((resolve, reject) => {
			http.once('error', reject);
			http.listen(0, '127.0.0.1', resolve);
		});
		try {
			const address = http.address();
			assert.ok(address && typeof address !== 'string');
			const base = `http://127.0.0.1:${(address as AddressInfo).port}`;
			assert.equal((await fetch(`${base}/v2/status`)).status, 401);
			const statusResponse = await fetch(`${base}/v2/status`, {
				headers: { authorization: `Bearer ${API_KEY}` },
			});
			assert.equal(statusResponse.status, 200);
			assert.equal((await statusResponse.text()).includes(root), false);
			const queryResponse = await fetch(`${base}/v2/query`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${API_KEY}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ query: 'amber reusable baseline', mode: 'default' }),
			});
			assert.equal(queryResponse.status, 200);
			assert.equal((await queryResponse.json() as { status: string }).status, 'ok');
			const writeRoute = await fetch(`${base}/v2/write`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${API_KEY}`,
					'content-type': 'application/json',
				},
				body: '{}',
			});
			assert.equal(writeRoute.status, 404, 'HTTP surface must expose no write route');
			const foreignOrigin = await fetch(`${base}/v2/status`, {
				headers: {
					authorization: `Bearer ${API_KEY}`,
					origin: 'https://untrusted.example',
				},
			});
			assert.equal(foreignOrigin.status, 403);
		} finally {
			http.closeAllConnections();
			await new Promise<void>((resolve) => http.close(() => resolve()));
		}
	} finally {
		if (ordinaryHidden) await rename(hiddenOrdinary, ordinaryRoot).catch(() => undefined);
		if (projectHidden) await rename(hiddenProject, projectRoot).catch(() => undefined);
		await rm(root, { recursive: true, force: true });
	}
});

test('offline configuration rejects artifacts or controlled-write state inside a Git worktree', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'second-brain-git-boundary-synthetic-'));
	try {
		const sourceRoot = path.join(root, 'source');
		const repositoryRoot = path.join(root, 'synthetic-repository');
		const safeArtifacts = path.join(root, 'safe-artifacts');
		const catalogPath = path.join(root, 'private-catalog', 'runtime-catalog.json');
		await mkdir(sourceRoot, { recursive: true });
		await mkdir(path.join(repositoryRoot, '.git'), { recursive: true });
		await writeFile(path.join(sourceRoot, 'synthetic.md'), '# Synthetic\n', 'utf8');
		const baseEnvironment: NodeJS.ProcessEnv = {
			OBSIDIAN_SOURCES_JSON: JSON.stringify([{
				id: 'synthetic:git-boundary',
				name: 'Synthetic boundary source',
				path: sourceRoot,
				kind: 'directory',
				writable: true,
			}]),
			OBSIDIAN_PERSIST_INDEX: 'true',
			OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: catalogPath,
		};
		await assert.rejects(loadSecondBrainBuildConfiguration({
			...baseEnvironment,
			OBSIDIAN_ARTIFACT_PATH: path.join(repositoryRoot, 'generated-artifacts'),
		}), /Compiled artifact state must be outside every Git worktree/u);
		await assert.rejects(loadSecondBrainBuildConfiguration({
			...baseEnvironment,
			OBSIDIAN_ARTIFACT_PATH: safeArtifacts,
			OBSIDIAN_SECOND_BRAIN_WRITE_STATE_PATH: path.join(repositoryRoot, 'write-state'),
		}), /Controlled write state must be outside every Git worktree/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('strict provider, ACL and watch configuration fail closed', async () => {
	assert.equal(readMcpWriteApprovalMode({}), 'disabled');
	assert.equal(readMcpWriteApprovalMode({
		OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL: 'trusted-mcp-app',
	}), 'trusted-mcp-app');
	assert.throws(
		() => readMcpWriteApprovalMode({ OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL: 'true' }),
		/disabled or trusted-mcp-app/u,
	);
	assert.equal(loadSecondBrainEmbeddingAdapter({}).kind, 'lexical_hash');
	assert.throws(
		() => loadSecondBrainEmbeddingAdapter({ OBSIDIAN_EMBEDDING_PROVIDER: 'remote' }),
		/deterministic or loopback/u,
	);
	assert.throws(
		() => loadSecondBrainEmbeddingAdapter({
			OBSIDIAN_EMBEDDING_PROVIDER: 'loopback',
			OBSIDIAN_EMBEDDING_MODEL: 'synthetic/model',
			OBSIDIAN_EMBEDDING_PORT: '9000',
			OBSIDIAN_EMBEDDING_URL: 'https://example.invalid',
		}),
		/host and path are fixed/u,
	);
	assert.deepEqual(parseOfflineCompileArguments(['--once'], {}), {
		forceCompaction: false,
		watch: false,
		watchIntervalMs: 30_000,
	});
	assert.deepEqual(parseOfflineCompileArguments(['--watch', '--force-compaction'], {
		OBSIDIAN_COMPILE_WATCH_MS: '1000',
	}), {
		forceCompaction: true,
		watch: true,
		watchIntervalMs: 1_000,
	});
	assert.equal(parseOfflineCompileArguments(['--once'], {
		OBSIDIAN_COMPILE_WATCH_MS: '1000',
	}).watch, false);
	assert.doesNotThrow(
		() => loadSecondBrainHttpOptions({ OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY: API_KEY }),
	);
	assert.throws(
		() => loadSecondBrainHttpOptions({
			OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY: API_KEY,
			OBSIDIAN_SECOND_BRAIN_HTTP_HOST: '0.0.0.0',
		}),
		/127\.0\.0\.1/u,
	);

	const broker = new OneTimeHumanApprovalBroker(1);
	const review = syntheticReview('a', Date.now() + 60_000);
	const document = broker.registerReview(review);
	assert.throws(() => broker.registerReview(syntheticReview('b', Date.now() + 60_000)), /capacity/u);
	assert.equal(broker.stageExactDecision({
		preparedId: review.preparedId,
		bindingHash: review.bindingHash,
		approvedDocument: `${document} edited`,
		approvedBy: 'local-human:test',
	}), false);
	assert.equal((await broker.requestApproval(review)).approved, false);
	assert.throws(() => broker.registerReview(syntheticReview('c', Date.now() - 1)), /expired/u);

	const gitRoot = await mkdtemp(path.join(tmpdir(), 'second-brain-git-artifact-synthetic-'));
	try {
		const source = path.join(gitRoot, 'source-outside-repository-state');
		const repository = path.join(gitRoot, 'repository');
		await mkdir(source, { recursive: true });
		await mkdir(path.join(repository, '.git'), { recursive: true });
		await assert.rejects(
			loadSecondBrainBuildConfiguration({
				OBSIDIAN_VAULT_PATH: source,
				OBSIDIAN_ARTIFACT_PATH: path.join(repository, 'private-artifacts'),
			}),
			/outside every Git worktree/u,
		);
	} finally {
		await rm(gitRoot, { recursive: true, force: true });
	}
});

test('MCP write and private UI tools require the trusted-host opt-in', async () => {
	const server = createSecondBrainMcpServer(
		{} as SecondBrainRuntimeApi,
		{
			principalId: 'synthetic-read-only-client',
			allowedSourceIds: [],
			allowedModes: ['default'],
		},
		{
			transport: 'stdio',
			transmissionReviewMode: 'disabled',
			approvalBroker: new OneTimeHumanApprovalBroker(),
		},
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'synthetic-read-only-test', version: '1.3.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	try {
		const names = (await client.listTools()).tools.map((tool) => tool.name);
		assert.equal(names.some((name) => name.includes('write') || name.includes('rollback')), false);
		assert.equal(names.includes('get_review_draft_for_ui'), false);
		assert.equal(names.includes('submit_review_decision_for_ui'), false);
	} finally {
		await client.close();
		await server.close();
	}
});

test('HTTP request-entry deadline bounds slow bodies and unauthenticated calls do not drain rate capacity', async () => {
	let queryCalls = 0;
	const runtime = {
		status: () => ({ ready: true }),
		query: async () => {
			queryCalls += 1;
			return {
				status: 'no_evidence',
				query: 'synthetic',
				mode: 'default',
				evidence: [],
				failures: [],
				partial: false,
				elapsedMs: 0,
				deadlineMs: 1,
				refusal: { code: 'no_evidence', message: 'synthetic' },
			};
		},
	} as unknown as SecondBrainRuntimeApi;
	const server = createSecondBrainHttpServer(
		runtime,
		{
			principalId: 'synthetic-http',
			allowedSourceIds: [],
			allowedModes: ['default'],
		},
		{
			host: '127.0.0.1',
			port: 0,
			apiKey: API_KEY,
			allowedOrigins: new Set(),
			maxBodyBytes: 1_024,
			rateLimitPerMinute: 2,
			requestDeadlineMs: 60,
		},
	);
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	let destroySlowRequest: () => void = () => undefined;
	try {
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		const port = (address as AddressInfo).port;
		const startedAt = Date.now();
		const slowResponse = await new Promise<{ status: number; body: string }>((resolve, reject) => {
			let settled = false;
			const request = httpRequest({
				host: '127.0.0.1',
				port,
				path: '/v2/query',
				method: 'POST',
				headers: {
					authorization: `Bearer ${API_KEY}`,
					'content-type': 'application/json',
				},
			}, (response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.once('end', () => {
					settled = true;
					resolve({
						status: response.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8'),
					});
				});
			});
			request.once('error', (error) => {
				if (!settled) reject(error);
			});
			request.write('{"query":"never completed');
			destroySlowRequest = () => request.destroy();
		});
		assert.equal(slowResponse.status, 408);
		assert.match(slowResponse.body, /deadline/u);
		assert.ok(Date.now() - startedAt < 1_000);
		assert.equal(queryCalls, 0, 'a slow body must time out before runtime query');
		destroySlowRequest();

		const base = `http://127.0.0.1:${port}`;
		for (let index = 0; index < 2; index += 1) {
			assert.equal((await fetch(`${base}/v2/status`, {
				headers: { authorization: 'Bearer invalid' },
			})).status, 401);
		}
		assert.equal((await fetch(`${base}/v2/status`, {
			headers: { authorization: `Bearer ${API_KEY}` },
		})).status, 200, 'invalid credentials must not consume the caller rate bucket');
		assert.equal((await fetch(`${base}/v2/status`, {
			headers: { authorization: `Bearer ${API_KEY}` },
		})).status, 429);
	} finally {
		destroySlowRequest();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test('MCP pending write/query bindings have explicit capacity and local expiry', async () => {
	let now = Date.now();
	let commitCalls = 0;
	const writeReview = syntheticReview('p', now + 60_000);
	const runtime = {
		query: async (_principal: unknown, request: { text: string }) => ({
			status: 'no_evidence',
			query: request.text,
			mode: 'default',
			evidence: [],
			failures: [],
			partial: false,
			elapsedMs: 0,
			deadlineMs: 5_000,
			refusal: { code: 'no_evidence', message: 'synthetic' },
		}),
		prepareWrite: async () => writeReview,
		approveAndCommitWrite: async () => {
			commitCalls += 1;
			throw new Error('must not run for an expired UI binding');
		},
	} as unknown as SecondBrainRuntimeApi;
	const broker = new OneTimeHumanApprovalBroker();
	const server = createSecondBrainMcpServer(
		runtime,
		{
			principalId: 'synthetic-pending-review',
			allowedSourceIds: ['synthetic'],
			allowedModes: ['default'],
		},
		{
			transport: 'stdio',
			transmissionReviewMode: 'required',
			approvalBroker: broker,
			controlledWritesEnabled: true,
			pendingReviewCapacity: 1,
			pendingReviewTtlMs: 10,
			now: () => now,
		},
	);
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'synthetic-pending-test', version: '1.3.0' });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	let writeCredentials: { reviewId: string; uiToken: string } | null = null;
	let queryCredentials: { reviewId: string; uiToken: string } | null = null;
	try {
		const prepared = await client.callTool({
			name: 'prepare_second_brain_write',
			arguments: {
				source_id: 'synthetic',
				path: 'synthetic.md',
				operation: 'replace',
				rationale: 'synthetic',
				after_content: 'synthetic',
			},
		});
		writeCredentials = reviewCredentials(prepared);
		const preparedId = requiredStructuredString(prepared, 'prepared_id');
		const atCapacity = await client.callTool({
			name: 'query_second_brain',
			arguments: { query: 'synthetic', mode: 'default' },
		});
		assert.equal(atCapacity.isError, true);
		assert.match(firstText(atCapacity), /capacity/u);

		now += 11;
		const expiredCommit = await client.callTool({
			name: 'commit_reviewed_second_brain_write',
			arguments: { prepared_id: preparedId, review_id: writeCredentials.reviewId },
		});
		assert.equal(expiredCommit.isError, true);
		assert.equal(commitCalls, 0, 'expired UI bindings must never reach mutation');

		const afterCleanup = await client.callTool({
			name: 'query_second_brain',
			arguments: { query: 'synthetic', mode: 'default' },
		});
		assert.equal(afterCleanup.isError, undefined);
		queryCredentials = reviewCredentials(afterCleanup);
	} finally {
		for (const credentials of [writeCredentials, queryCredentials]) {
			if (credentials === null) continue;
			try {
				submitTransmissionReview(credentials.reviewId, credentials.uiToken, 'cancel');
				await collectTransmissionReview(credentials.reviewId).catch(() => undefined);
			} catch {
				// The test is already complete if a defensive cleanup raced expiry.
			}
		}
		await client.close();
		await server.close();
	}
});

function syntheticReview(label: string, expiresAt: number) {
	return {
		schemaVersion: 1 as const,
		preparedId: `prepared_write_v1_${label.repeat(32)}`,
		action: 'write' as const,
		bindingHash: label.repeat(64),
		expiresAt: new Date(expiresAt).toISOString(),
		source: {
			sourceId: `src_v1_${'A'.repeat(43)}`,
			label: 'Synthetic',
			documentPath: 'note.md',
		},
		operation: 'replace' as const,
		risk: { level: 'medium' as const, reasons: ['synthetic'], requiresHumanApproval: true as const },
		reviewText: 'synthetic exact review\n',
		diffHunks: [],
	};
}

function reviewCredentials(result: unknown): { reviewId: string; uiToken: string } {
	assert.ok(isRecord(result) && isRecord(result._meta) && isRecord(result._meta.obsidianReview));
	const reviewId = result._meta.obsidianReview.review_id;
	const uiToken = result._meta.obsidianReview.ui_token;
	assert.equal(typeof reviewId, 'string');
	assert.equal(typeof uiToken, 'string');
	return { reviewId, uiToken } as { reviewId: string; uiToken: string };
}

function requiredStructuredString(result: unknown, key: string): string {
	assert.ok(isRecord(result) && isRecord(result.structuredContent));
	const value = result.structuredContent[key];
	assert.equal(typeof value, 'string');
	return value as string;
}

function privateDraftContent(result: unknown): string {
	assert.ok(isRecord(result) && isRecord(result._meta) && isRecord(result._meta.obsidianReviewDraft));
	const content = result._meta.obsidianReviewDraft.content;
	assert.equal(typeof content, 'string');
	return content as string;
}

function firstText(result: unknown): string {
	assert.ok(isRecord(result) && Array.isArray(result.content));
	const first: unknown = result.content[0];
	assert.ok(isRecord(first) && first.type === 'text' && typeof first.text === 'string');
	return first.text;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === 'object' && value !== null;
}
