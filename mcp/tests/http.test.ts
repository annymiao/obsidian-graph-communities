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
import { createFixtureVault, removeFixtureVault } from './fixture.js';

const API_KEY = 'test-api-key-1234567890abcdef';

let baseUrl = '';
let server: Server | undefined;
let vaultPath = '';

beforeEach(async () => {
	vaultPath = await createFixtureVault();
	const config = await loadServerConfig({
		OBSIDIAN_VAULT_PATH: vaultPath,
		OBSIDIAN_INDEX_TTL_MS: '60000',
	});
	const options: GatewayOptions = {
		host: '127.0.0.1',
		port: 0,
		apiKey: API_KEY,
		allowedOrigins: new Set(),
		maxBodyBytes: 1_048_576,
		rateLimitPerMinute: 120,
	};
	server = createGatewayHttpServer(new KnowledgeIndex(config), options);
	await new Promise<void>((resolve, reject) => {
		server?.once('error', reject);
		server?.listen(0, '127.0.0.1', () => resolve());
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;
});

afterEach(async () => {
	if (server) {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server?.close(() => resolve()));
	}
	server = undefined;
	await removeFixtureVault(vaultPath);
});

test('REST gateway requires an API key and exposes read-only knowledge', async () => {
	const health = await fetch(`${baseUrl}/health`);
	assert.equal(health.status, 200);
	const healthBody = await health.json() as { mode: string; version: string };
	assert.equal(healthBody.mode, 'read-only');
	assert.equal(healthBody.version, '0.6.0');

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
