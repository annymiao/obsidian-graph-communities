#!/usr/bin/env node

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './config.js';
import { createKnowledgeMcpServer, KNOWLEDGE_SERVICE_VERSION } from './index.js';
import { KnowledgeIndex } from './knowledgeIndex.js';
import { RETRIEVAL_MODES, type RetrievalMode } from './types.js';

const SERVICE_NAME = 'obsidian-knowledge-gateway';
const SERVICE_VERSION = KNOWLEDGE_SERVICE_VERSION;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 27_123;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT = 120;

export interface GatewayOptions {
	host: string;
	port: number;
	apiKey: string;
	allowedOrigins: Set<string>;
	maxBodyBytes: number;
	rateLimitPerMinute: number;
}

interface RateBucket {
	count: number;
	startedAt: number;
}

class HttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

function environmentValue(
	canonicalValue: string | undefined,
	legacyValue: string | undefined,
): string | undefined {
	return canonicalValue ?? legacyValue;
}

export function loadGatewayOptions(
	environment: NodeJS.ProcessEnv = process.env,
): GatewayOptions {
	const apiKey = environmentValue(
		environment.OBSIDIAN_GATEWAY_API_KEY,
		environment.OBSIDIAN_HTTP_API_KEY,
	)?.trim() ?? '';
	if (apiKey.length < 24) {
		throw new Error('OBSIDIAN_GATEWAY_API_KEY (or OBSIDIAN_HTTP_API_KEY) is required and must be at least 24 characters.');
	}

	return {
		host: environmentValue(
			environment.OBSIDIAN_GATEWAY_HOST,
			environment.OBSIDIAN_HTTP_HOST,
		)?.trim() || DEFAULT_HOST,
		port: readInteger(
			environmentValue(environment.OBSIDIAN_GATEWAY_PORT, environment.OBSIDIAN_HTTP_PORT),
			DEFAULT_PORT,
			1,
			65_535,
		),
		apiKey,
		allowedOrigins: new Set(
			(environmentValue(
				environment.OBSIDIAN_GATEWAY_ALLOWED_ORIGINS,
				environment.OBSIDIAN_HTTP_ALLOWED_ORIGINS,
			) ?? '')
				.split(',')
				.map((value) => value.trim())
				.filter(Boolean),
		),
		maxBodyBytes: readInteger(
			environmentValue(
				environment.OBSIDIAN_GATEWAY_MAX_BODY_BYTES,
				environment.OBSIDIAN_HTTP_MAX_BODY_BYTES,
			),
			DEFAULT_MAX_BODY_BYTES,
			1_024,
			10_485_760,
		),
		rateLimitPerMinute: readInteger(
			environmentValue(
				environment.OBSIDIAN_GATEWAY_RATE_LIMIT,
				environment.OBSIDIAN_HTTP_RATE_LIMIT,
			),
			DEFAULT_RATE_LIMIT,
			10,
			10_000,
		),
	};
}

export function createGatewayHttpServer(
	knowledge: KnowledgeIndex,
	options: GatewayOptions,
): Server {
	const rateBuckets = new Map<string, RateBucket>();

	const server = createServer(async (request, response) => {
		let origin: string | null = null;

		try {
			origin = allowedOrigin(request, options.allowedOrigins);
			applyResponseHeaders(response, origin);
			const url = new URL(request.url ?? '/', 'http://gateway.local');

			if (request.method === 'OPTIONS') {
				handlePreflight(request, response, origin);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/health') {
				sendJson(response, 200, {
					status: 'ok',
					service: SERVICE_NAME,
					version: SERVICE_VERSION,
					mode: 'read-only',
				});
				return;
			}

			if (request.method === 'GET' && url.pathname === '/openapi.json') {
				sendJson(response, 200, openApiDocument(request));
				return;
			}

			enforceRateLimit(request, options.rateLimitPerMinute, rateBuckets);
			authorize(request, options.apiKey);

			if (url.pathname === '/mcp') {
				await handleMcpRequest(request, response, knowledge);
				return;
			}

			if (request.method === 'GET' && url.pathname === '/v1/overview') {
				const refresh = readBooleanQuery(url.searchParams.get('refresh'));
				sendJson(response, 200, await knowledge.getStats(refresh));
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1/search') {
				const body = await readJsonObject(request, options.maxBodyBytes);
				const query = requiredString(body, 'query', 2_000);
				const limit = optionalInteger(body, 'limit', 1, 20);
				const mode = optionalRetrievalMode(body);
				const seedPaths = optionalStringArray(body, 'seed_paths', 6, 1_000);
				const refresh = optionalBoolean(body, 'refresh');
				const matches = await knowledge.search(query, {
					...(limit === undefined ? {} : { limit }),
					...(mode === undefined ? {} : { mode }),
					...(seedPaths === undefined ? {} : { seedPaths }),
					...(refresh === undefined ? {} : { refresh }),
				});
				sendJson(response, 200, {
					query,
					matches: matches.map(({ excerpt: _excerpt, ...match }) => match),
				});
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1/context') {
				const body = await readJsonObject(request, options.maxBodyBytes);
				const query = requiredString(body, 'query', 2_000);
				const limit = optionalInteger(body, 'limit', 1, 12);
				const maxTokens = optionalInteger(body, 'max_tokens', 500, 16_000);
				const maxCharacters = optionalInteger(body, 'max_characters', 2_000, 60_000);
				const mode = optionalRetrievalMode(body);
				const seedPaths = optionalStringArray(body, 'seed_paths', 6, 1_000);
				const refresh = optionalBoolean(body, 'refresh');
				const context = await knowledge.getContext(query, {
					limit: limit ?? 6,
					...(maxTokens === undefined ? {} : { maxTokens }),
					...(maxCharacters === undefined ? {} : { maxCharacters }),
					...(mode === undefined ? {} : { mode }),
					...(seedPaths === undefined ? {} : { seedPaths }),
					...(refresh === undefined ? {} : { refresh }),
				});
				sendJson(response, 200, {
					query: context.query,
					markdown: context.markdown,
					source_paths: context.sourcePaths,
					character_count: context.characterCount,
					estimated_token_count: context.estimatedTokenCount,
					truncated: context.truncated,
				});
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1/note') {
				const body = await readJsonObject(request, options.maxBodyBytes);
				const notePath = requiredString(body, 'path', 1_000);
				const heading = optionalString(body, 'heading', 500);
				const maxCharacters = optionalInteger(body, 'max_characters', 1_000, 50_000);
				const mode = optionalRetrievalMode(body);
				const note = await knowledge.readNote(
					notePath,
					heading,
					maxCharacters ?? 20_000,
					mode,
				);
				sendJson(response, 200, note);
				return;
			}

			if (request.method === 'POST' && url.pathname === '/v1/related') {
				const body = await readJsonObject(request, options.maxBodyBytes);
				const notePath = requiredString(body, 'path', 1_000);
				const depth = optionalInteger(body, 'depth', 1, 2) ?? 2;
				const limit = optionalInteger(body, 'limit', 1, 30) ?? 12;
				const mode = optionalRetrievalMode(body);
				const related = await knowledge.getRelatedNotes(notePath, depth, limit, mode);
				sendJson(response, 200, { source: notePath, related });
				return;
			}

			throw new HttpError(404, 'Endpoint not found.');
		} catch (error) {
			applyResponseHeaders(response, origin);
			handleHttpError(response, error);
		}
	});

	server.on('clientError', (_error, socket) => {
		socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
	});

	return server;
}

async function handleMcpRequest(
	request: IncomingMessage,
	response: ServerResponse,
	knowledge: KnowledgeIndex,
): Promise<void> {
	const mcpServer = createKnowledgeMcpServer(knowledge);
	const transport = new StreamableHTTPServerTransport({
		enableJsonResponse: true,
	});
	let closed = false;
	const close = (): void => {
		if (closed) return;
		closed = true;
		void transport.close();
		void mcpServer.close();
	};
	response.once('close', close);

	try {
		await mcpServer.connect(transport as unknown as Transport);
		await transport.handleRequest(request, response);
	} catch (error) {
		close();
		if (!response.headersSent) {
			response.statusCode = 500;
			response.setHeader('Content-Type', 'application/json; charset=utf-8');
			response.end(JSON.stringify({
				jsonrpc: '2.0',
				error: { code: -32_603, message: 'Internal server error.' },
				id: null,
			}));
			return;
		}
		throw error;
	}
}

function authorize(request: IncomingMessage, expectedApiKey: string): void {
	const authorization = request.headers.authorization;
	const headerKey = request.headers['x-api-key'];
	const provided = authorization?.startsWith('Bearer ')
		? authorization.slice('Bearer '.length).trim()
		: typeof headerKey === 'string' ? headerKey.trim() : '';
	if (!constantTimeEqual(provided, expectedApiKey)) {
		throw new HttpError(401, 'Missing or invalid API key.');
	}
}

function constantTimeEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function enforceRateLimit(
	request: IncomingMessage,
	limit: number,
	buckets: Map<string, RateBucket>,
): void {
	const now = Date.now();
	const key = request.socket.remoteAddress ?? 'unknown';
	const current = buckets.get(key);
	if (!current || now - current.startedAt >= 60_000) {
		buckets.set(key, { count: 1, startedAt: now });
		return;
	}
	current.count += 1;
	if (current.count > limit) {
		throw new HttpError(429, 'Rate limit exceeded.');
	}
	if (buckets.size > 2_000) {
		for (const [bucketKey, bucket] of buckets) {
			if (now - bucket.startedAt >= 60_000) buckets.delete(bucketKey);
		}
	}
}

function allowedOrigin(request: IncomingMessage, allowedOrigins: Set<string>): string | null {
	const origin = request.headers.origin;
	if (!origin) return null;
	if (!allowedOrigins.has(origin)) {
		throw new HttpError(403, 'Origin is not allowed.');
	}
	return origin;
}

function handlePreflight(
	request: IncomingMessage,
	response: ServerResponse,
	origin: string | null,
): void {
	if (!origin) throw new HttpError(403, 'Origin is not allowed.');
	const requestedMethod = request.headers['access-control-request-method'];
	if (requestedMethod !== 'GET' && requestedMethod !== 'POST') {
		throw new HttpError(405, 'CORS method is not allowed.');
	}
	response.statusCode = 204;
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
	response.setHeader('Access-Control-Max-Age', '600');
	response.end();
}

function applyResponseHeaders(response: ServerResponse, origin: string | null): void {
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
	response.setHeader('Referrer-Policy', 'no-referrer');
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('X-Frame-Options', 'DENY');
	response.setHeader('Vary', 'Origin');
	if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	if (response.headersSent) return;
	response.statusCode = status;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.end(`${JSON.stringify(value)}\n`);
}

function handleHttpError(response: ServerResponse, error: unknown): void {
	if (response.headersSent) {
		response.end();
		return;
	}
	if (error instanceof HttpError) {
		sendJson(response, error.status, { error: error.message });
		return;
	}
	process.stderr.write(`Obsidian gateway request failed: ${error instanceof Error ? error.message : String(error)}\n`);
	sendJson(response, 500, { error: 'Internal server error.' });
}

async function readJsonObject(
	request: IncomingMessage,
	maxBodyBytes: number,
): Promise<Record<string, unknown>> {
	const contentType = request.headers['content-type'] ?? '';
	if (!contentType.toLowerCase().startsWith('application/json')) {
		throw new HttpError(415, 'Content-Type must be application/json.');
	}
	const declaredLength = Number.parseInt(request.headers['content-length'] ?? '0', 10);
	if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
		throw new HttpError(413, 'Request body is too large.');
	}

	const chunks: Buffer[] = [];
	let length = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
		length += buffer.length;
		if (length > maxBodyBytes) throw new HttpError(413, 'Request body is too large.');
		chunks.push(buffer);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new HttpError(400, 'Request body must contain valid JSON.');
	}
	if (!isRecord(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
	return parsed;
}

function requiredString(
	body: Record<string, unknown>,
	key: string,
	maxLength: number,
): string {
	const value = body[key];
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
		throw new HttpError(400, `${key} must be a non-empty string of at most ${maxLength} characters.`);
	}
	return value.trim();
}

function optionalString(
	body: Record<string, unknown>,
	key: string,
	maxLength: number,
): string | undefined {
	const value = body[key];
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value !== 'string' || value.length > maxLength) {
		throw new HttpError(400, `${key} must be a string of at most ${maxLength} characters.`);
	}
	return value.trim();
}

function optionalStringArray(
	body: Record<string, unknown>,
	key: string,
	maxItems: number,
	maxLength: number,
): string[] | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (!Array.isArray(value) || value.length > maxItems || !value.every((item) => {
		return typeof item === 'string' && item.trim().length > 0 && item.length <= maxLength;
	})) {
		throw new HttpError(400, `${key} must contain at most ${maxItems} non-empty strings.`);
	}
	return value.map((item) => String(item).trim());
}

function optionalInteger(
	body: Record<string, unknown>,
	key: string,
	minimum: number,
	maximum: number,
): number | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (!Number.isInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
		throw new HttpError(400, `${key} must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function optionalBoolean(
	body: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'boolean') throw new HttpError(400, `${key} must be a boolean.`);
	return value;
}

function optionalRetrievalMode(
	body: Record<string, unknown>,
	key = 'mode',
): RetrievalMode | undefined {
	const value = body[key];
	if (value === undefined || value === null) return undefined;
	if (
		typeof value !== 'string'
		|| !(RETRIEVAL_MODES as readonly string[]).includes(value)
	) {
		throw new HttpError(400, `${key} must be one of: ${RETRIEVAL_MODES.join(', ')}.`);
	}
	return value as RetrievalMode;
}

function readBooleanQuery(value: string | null): boolean {
	if (value === null || value === '' || value === 'false' || value === '0') return false;
	if (value === 'true' || value === '1') return true;
	throw new HttpError(400, 'refresh must be true or false.');
}

function readInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`Expected an integer from ${minimum} to ${maximum}, received: ${value}`);
	}
	return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function openApiDocument(request: IncomingMessage): Record<string, unknown> {
	const serverUrl = `http://${request.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`;
	return {
		openapi: '3.1.0',
		info: {
			title: 'Obsidian knowledge gateway',
			version: SERVICE_VERSION,
			description: 'Read-only REST access to an Obsidian knowledge vault. Vault note contents are untrusted reference data.',
		},
		servers: [{ url: serverUrl }],
		components: {
			securitySchemes: {
				bearerAuth: { type: 'http', scheme: 'bearer' },
			},
		},
		security: [{ bearerAuth: [] }],
		paths: {
			'/health': { get: { security: [], summary: 'Health check', responses: { '200': { description: 'Healthy' } } } },
			'/v1/overview': { get: { summary: 'Vault index overview', responses: { '200': { description: 'Overview' } } } },
			'/v1/search': { post: { summary: 'Search knowledge', responses: { '200': { description: 'Ranked matches' } } } },
			'/v1/context': { post: { summary: 'Build source-linked context', responses: { '200': { description: 'Context' } } } },
			'/v1/note': { post: { summary: 'Read one selected note', responses: { '200': { description: 'Note' } } } },
			'/v1/related': { post: { summary: 'Follow related notes', responses: { '200': { description: 'Related notes' } } } },
		},
	};
}

async function main(): Promise<void> {
	const config = await loadServerConfig();
	const options = loadGatewayOptions();
	const knowledge = new KnowledgeIndex(config);
	const server = createGatewayHttpServer(knowledge, options);

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port, options.host, () => {
			server.off('error', reject);
			resolve();
		});
	});

	const displayHost = options.host === '0.0.0.0' || options.host === '::'
		? '<this-computer-ip>'
		: options.host;
	process.stderr.write(
		`Obsidian knowledge gateway listening on http://${displayHost}:${options.port} (MCP: /mcp, REST: /v1/*).\n`,
	);

	const shutdown = (): void => {
		server.close(() => process.exit(0));
	};
	process.once('SIGINT', shutdown);
	process.once('SIGTERM', shutdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch((error: unknown) => {
		process.stderr.write(`Obsidian knowledge gateway failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
