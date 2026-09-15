import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REVIEW_APP_URI } from '../src/reviewApp.js';
import { createFixtureVault, removeFixtureVault } from './fixture.js';

let vaultPath = '';

beforeEach(async () => {
	vaultPath = await createFixtureVault();
});

afterEach(async () => {
	await removeFixtureVault(vaultPath);
});

test('stdio server exposes a private MCP App review flow without a review bypass', async () => {
	const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverPath],
		env: {
			...process.env,
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_INDEX_TTL_MS: '60000',
			OBSIDIAN_PERSIST_INDEX: 'false',
		},
	});
	const client = new Client(
		{ name: 'obsidian-knowledge-test', version: '0.1.0' },
		{ capabilities: {} },
	);

	try {
		await client.connect(transport);
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
		tools.tools.forEach((tool) => {
			assert.equal(
				tool.annotations?.readOnlyHint,
				tool.name === 'submit_review_decision_for_ui' ? false : true,
			);
			assert.equal(tool.annotations?.destructiveHint, false);
		});

		for (const tool of tools.tools) {
			if (tool.name === 'get_vault_overview') continue;
			assert.ok(isRecord(tool.inputSchema));
			const properties = tool.inputSchema.properties;
			assert.ok(isRecord(properties));
			assert.equal('review' in properties, false);
		}

			for (const toolName of ['get_knowledge_context', 'search_knowledge', 'read_note', 'get_related_notes']) {
				const tool = tools.tools.find((candidate) => candidate.name === toolName);
				assert.ok(tool);
				assert.ok(isRecord(tool.inputSchema));
				assert.ok(isRecord(tool.inputSchema.properties));
				assert.ok(
					isRecord(tool.inputSchema.properties.mode),
					`${toolName} must expose the retrieval mode instead of bypassing policy`,
				);
				assert.equal(tool._meta?.['openai/outputTemplate'], REVIEW_APP_URI);
				assert.deepEqual((tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility, ['model', 'app']);
			}
			const contextTool = tools.tools.find((candidate) => candidate.name === 'get_knowledge_context');
			assert.ok(contextTool && isRecord(contextTool.inputSchema));
			assert.ok(isRecord(contextTool.inputSchema.properties));
			assert.ok(isRecord(contextTool.inputSchema.properties.max_tokens));
		for (const toolName of ['get_review_draft_for_ui', 'submit_review_decision_for_ui']) {
			const tool = tools.tools.find((candidate) => candidate.name === toolName);
			assert.ok(tool);
			assert.deepEqual((tool._meta?.ui as { visibility?: string[] } | undefined)?.visibility, ['app']);
			assert.equal(tool._meta?.['openai/visibility'], 'private');
		}

		const resource = await client.readResource({ uri: REVIEW_APP_URI });
		assert.equal(resource.contents[0]?.mimeType, 'text/html;profile=mcp-app');
		const resourceContent = resource.contents[0];
		assert.ok(resourceContent && 'text' in resourceContent);
		assert.match(resourceContent.text, /Codex 尚不可见/);

		const queued = await client.callTool({
			name: 'get_knowledge_context',
			arguments: { query: 'Codex 写作系统', limit: 1 },
		});
		assert.ok(isRecord(queued));
		assert.equal(
			JSON.stringify({ content: queued.content, structuredContent: queued.structuredContent })
				.includes('# Obsidian knowledge context'),
			false,
		);
		const privateAuth = isRecord(queued._meta) && isRecord(queued._meta.obsidianReview)
			? queued._meta.obsidianReview
			: null;
		assert.ok(privateAuth);
		assert.equal(typeof privateAuth.review_id, 'string');
		assert.equal(typeof privateAuth.ui_token, 'string');
		assert.equal(
			JSON.stringify({ content: queued.content, structuredContent: queued.structuredContent })
				.includes(String(privateAuth.ui_token)),
			false,
		);

		const draftResult = await client.callTool({
			name: 'get_review_draft_for_ui',
			arguments: {
				review_id: privateAuth.review_id,
				ui_token: privateAuth.ui_token,
			},
		});
		assert.ok(isRecord(draftResult));
		assert.equal(
			JSON.stringify({ content: draftResult.content, structuredContent: draftResult.structuredContent })
				.includes('# Obsidian knowledge context'),
			false,
		);
		const privateDraft = isRecord(draftResult._meta) && isRecord(draftResult._meta.obsidianReviewDraft)
			? draftResult._meta.obsidianReviewDraft
			: null;
		assert.ok(privateDraft);
		assert.match(String(privateDraft.content), /# Obsidian knowledge context/);

		const edited = '用户确认后的测试内容';
		const decision = await client.callTool({
			name: 'submit_review_decision_for_ui',
			arguments: {
				review_id: privateAuth.review_id,
				ui_token: privateAuth.ui_token,
				action: 'approve',
				content: edited,
			},
		});
		assert.equal(decision.isError, undefined);
		const received = await client.callTool({
			name: 'receive_reviewed_transmission',
			arguments: { review_id: privateAuth.review_id },
		});
		assert.ok(isRecord(received));
		assert.ok(Array.isArray(received.content));
		assert.deepEqual(received.content[0], { type: 'text', text: edited });

		const overview = await client.callTool({
			name: 'get_vault_overview',
			arguments: { refresh: true },
		});
		assert.ok(isRecord(overview));
		assert.ok(Array.isArray(overview.content));
		const first: unknown = overview.content[0];
		assert.ok(isRecord(first));
		assert.equal(first.type, 'text');
		if (first.type === 'text' && typeof first.text === 'string') {
			assert.match(first.text, /"noteCount"/);
			assert.match(first.text, /"linkCount"/);
		}
	} finally {
		await client.close();
	}
});

test('stdio trusted-local mode returns bounded content without review UI metadata', async () => {
	const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverPath],
		env: {
			...process.env,
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_PERSIST_INDEX: 'false',
			OBSIDIAN_TRANSMISSION_REVIEW: 'trusted-local',
		},
	});
	const client = new Client(
		{ name: 'obsidian-knowledge-direct-test', version: '1.2.0' },
		{ capabilities: {} },
	);

	try {
		await client.connect(transport);
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
		for (const toolName of [
			'get_knowledge_context',
			'search_knowledge',
			'read_note',
			'get_related_notes',
		]) {
			const tool = tools.tools.find((candidate) => candidate.name === toolName);
			assert.ok(tool);
			assert.equal(tool._meta?.['openai/outputTemplate'], undefined);
			assert.equal(tool._meta?.ui, undefined);
		}

		const direct = await client.callTool({
			name: 'get_knowledge_context',
			arguments: { query: 'Codex writing system', limit: 1, max_tokens: 500 },
		});
		assert.ok(isRecord(direct));
		assert.ok(isRecord(direct.structuredContent));
		assert.equal(direct.structuredContent.status, 'direct');
		assert.equal('review_id' in direct.structuredContent, false);
		assert.ok(Array.isArray(direct.content));
		const first = direct.content[0];
		assert.ok(isRecord(first));
		assert.equal(first.type, 'text');
		assert.match(String(first.text), /# Obsidian knowledge context/u);
		assert.equal(
			isRecord(direct._meta) && 'obsidianReview' in direct._meta,
			false,
		);
	} finally {
		await client.close();
	}
});

test('stdio federation exposes source IDs and requires one for ambiguous relative paths', async () => {
	const secondVaultPath = await createFixtureVault();
	const serverPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
	const environment: Record<string, string> = Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => {
			return typeof entry[1] === 'string';
		}),
	);
	delete environment.OBSIDIAN_VAULT_PATH;
	environment.OBSIDIAN_SOURCES_JSON = JSON.stringify([
		{ id: 'fixture:first', name: 'First library', path: vaultPath },
		{ id: 'fixture:second', name: 'Second library', path: secondVaultPath },
	]);
	environment.OBSIDIAN_PERSIST_INDEX = 'false';
	environment.OBSIDIAN_TRANSMISSION_REVIEW = 'trusted-local';
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [serverPath],
		env: environment,
	});
	const client = new Client(
		{ name: 'obsidian-knowledge-federation-test', version: '1.2.0' },
		{ capabilities: {} },
	);

	try {
		await client.connect(transport);
		const searched = await client.callTool({
			name: 'search_knowledge',
			arguments: { query: 'Codex writing system', limit: 4 },
		});
		assert.ok(isRecord(searched));
		assert.ok(Array.isArray(searched.content));
		const textBlock = searched.content[0];
		assert.ok(isRecord(textBlock) && typeof textBlock.text === 'string');
		const payload = JSON.parse(textBlock.text) as {
			matches: Array<{ sourceId: string; sourceName: string; path: string }>;
		};
		assert.ok(payload.matches.length >= 2);
		assert.deepEqual(
			new Set(payload.matches.map((match) => match.sourceName)),
			new Set(['First library', 'Second library']),
		);
		assert.equal(JSON.stringify(searched).includes(vaultPath), false);
		assert.equal(JSON.stringify(searched).includes(secondVaultPath), false);

		const selected = payload.matches[0];
		assert.ok(selected);
		const ambiguous = await client.callTool({
			name: 'read_note',
			arguments: { path: selected.path },
		});
		assert.equal(ambiguous.isError, true);
		assert.match(JSON.stringify(ambiguous.content), /source_id is required/u);

		const read = await client.callTool({
			name: 'read_note',
			arguments: { path: selected.path, source_id: selected.sourceId },
		});
		assert.equal(read.isError, undefined);
		assert.match(JSON.stringify(read.content), new RegExp(selected.sourceName, 'u'));
	} finally {
		await client.close();
		await removeFixtureVault(secondVaultPath);
	}
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
