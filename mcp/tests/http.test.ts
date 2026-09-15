import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, test } from 'node:test';
import { loadServerConfig } from '../src/config.js';
import { createGatewayHttpServer, GatewayOptions } from '../src/http.js';
import { KnowledgeIndex } from '../src/knowledgeIndex.js';
import type { TransmissionReviewMode } from '../src/reviewPolicy.js';
import { REVIEW_APP_URI } from '../src/reviewApp.js';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

const API_KEY = 'test-api-key-1234567890abcdef';

let baseUrl = '';
let server: Server | undefined;
let vaultPath = '';
let config: Awaited<ReturnType<typeof loadServerConfig>>;

beforeEach(async () => {
	vaultPath = await createFixtureVault();
	config = await loadServerConfig({
		OBSIDIAN_VAULT_PATH: vaultPath,
		OBSIDIAN_INDEX_TTL_MS: '60000',
		OBSIDIAN_PERSIST_INDEX: 'false',
	});
	await restartGateway('required');
});

async function restartGateway(
	transmissionReviewMode: TransmissionReviewMode,
): Promise<void> {
	await closeGateway();
	const options: GatewayOptions = {
		host: '127.0.0.1',
		port: 0,
		apiKey: API_KEY,
		allowedOrigins: new Set(),
		maxBodyBytes: 1_048_576,
		rateLimitPerMinute: 120,
		transmissionReviewMode,
	};
	server = createGatewayHttpServer(new KnowledgeIndex(config), options);
	await new Promise<void>((resolve, reject) => {
		server?.once('error', reject);
		server?.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
}

async function closeGateway(): Promise<void> {
	const activeServer = server;
	server = undefined;
	if (!activeServer) return;
	activeServer.closeAllConnections();
	await new Promise<void>((resolve) => activeServer.close(() => resolve()));
}

afterEach(async () => {
	await closeGateway();
	await removeFixtureVault(vaultPath);
});

test('REST gateway requires an API key and exposes read-only knowledge', async () => {
	const health = await fetch(`${baseUrl}/health`);
	assert.equal(health.status, 200);
	const healthBody = await health.json() as { mode: string; version: string };
	assert.equal(healthBody.mode, 'read-only');
	assert.equal(healthBody.version, '1.3.0');

	const unauthorized = await fetch(`${baseUrl}/v1/search`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ query: 'Codex' }),
	});
	assert.equal(unauthorized.status, 401);

	const search = await fetch(`${baseUrl}/v1/search`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ query: 'Codex personal MCP', limit: 4 }),
	});
	assert.equal(search.status, 200);
	const result = await search.json() as {
		matches: Array<{ path: string }>;
	};
	assert.ok(result.matches.some((match) => match.path === '30-Shared-Knowledge/MCP 方案.md'));

	const context = await fetch(`${baseUrl}/v1/context`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ query: 'Codex personal MCP', mode: 'default', max_tokens: 500 }),
	});
	assert.equal(context.status, 200);
	const contextResult = await context.json() as {
		estimated_token_count: number;
		truncated: boolean;
	};
	assert.ok(contextResult.estimated_token_count <= 500);
	assert.equal(typeof contextResult.truncated, 'boolean');

	const invalidMode = await fetch(`${baseUrl}/v1/search`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ query: 'Codex', mode: 'everything' }),
	});
	assert.equal(invalidMode.status, 400);
});

test('HTTP MCP endpoint accepts bearer authentication', async () => {
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: {
			headers: { Authorization: `Bearer ${API_KEY}` },
		},
	});
	const client = new Client({ name: 'obsidian-http-test', version: '0.1.0' });

	try {
		await client.connect(transport as unknown as Transport);
		assert.match(client.getInstructions() ?? '', /review panel/u);
		assert.ok(client.getServerCapabilities()?.resources);
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name).sort(),
			[
				'get_knowledge_context',
				'get_related_notes',
				'get_review_draft_for_ui',
				'get_vault_overview',
				'read_note',
				'receive_reviewed_transmission',
				'search_knowledge',
				'submit_review_decision_for_ui',
			],
		);
		const result = await client.callTool({
			name: 'get_vault_overview',
			arguments: {},
		});
		assert.equal(result.isError, undefined);
	} finally {
		await client.close();
	}
});

test('HTTP trusted-local mode still requires private review', async () => {
	await restartGateway('trusted-local');
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: {
			headers: { Authorization: `Bearer ${API_KEY}` },
		},
	});
	const client = new Client({ name: 'obsidian-http-review-test', version: '1.2.0' });

	try {
		await client.connect(transport as unknown as Transport);
		assert.match(client.getInstructions() ?? '', /review panel/u);
		assert.ok(client.getServerCapabilities()?.resources);
		const tools = await client.listTools();
		const contextTool = tools.tools.find((tool) => tool.name === 'get_knowledge_context');
		assert.ok(contextTool);
		assert.equal(contextTool._meta?.['openai/outputTemplate'], REVIEW_APP_URI);
		assert.ok(tools.tools.some((tool) => tool.name === 'receive_reviewed_transmission'));

		const queued = await client.callTool({
			name: 'get_knowledge_context',
			arguments: { query: 'Codex writing system', limit: 1, max_tokens: 500 },
		});
		assert.ok(isRecord(queued));
		assert.ok(isRecord(queued.structuredContent));
		assert.equal(queued.structuredContent.status, 'pending');
		assert.equal(
			JSON.stringify({ content: queued.content, structuredContent: queued.structuredContent })
				.includes('# Obsidian knowledge context'),
			false,
		);
		assert.equal(isRecord(queued._meta) && isRecord(queued._meta.obsidianReview), true);
	} finally {
		await client.close();
	}
});

test('HTTP disabled mode explicitly returns content without review UI metadata', async () => {
	await restartGateway('disabled');
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: {
			headers: { Authorization: `Bearer ${API_KEY}` },
		},
	});
	const client = new Client({ name: 'obsidian-http-direct-test', version: '1.2.0' });

	try {
		await client.connect(transport as unknown as Transport);
		assert.doesNotMatch(
			client.getInstructions() ?? '',
			/review panel|receive_reviewed_transmission|审核/iu,
		);
		assert.equal(client.getServerCapabilities()?.resources, undefined);
		const tools = await client.listTools();
		assert.deepEqual(
			tools.tools.map((tool) => tool.name).sort(),
			[
				'get_knowledge_context',
				'get_related_notes',
				'get_vault_overview',
				'read_note',
				'search_knowledge',
			],
		);
		const contextTool = tools.tools.find((tool) => tool.name === 'get_knowledge_context');
		assert.ok(contextTool);
		assert.equal(contextTool._meta?.['openai/outputTemplate'], undefined);
		assert.equal(contextTool._meta?.ui, undefined);

		const direct = await client.callTool({
			name: 'get_knowledge_context',
			arguments: { query: 'Codex writing system', limit: 1, max_tokens: 500 },
		});
		assert.ok(isRecord(direct));
		assert.ok(isRecord(direct.structuredContent));
		assert.equal(direct.structuredContent.status, 'direct');
		assert.ok(Array.isArray(direct.content));
		assert.match(JSON.stringify(direct.content), /# Obsidian knowledge context/u);
		assert.equal(isRecord(direct._meta) && 'obsidianReview' in direct._meta, false);
	} finally {
		await client.close();
	}
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
