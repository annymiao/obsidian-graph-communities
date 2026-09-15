#!/usr/bin/env node

import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSecondBrainBootstrap } from './secondBrainBootstrap.js';
import type {
	SecondBrainPrincipalPolicy,
	SecondBrainQueryRequest,
	SecondBrainRuntimeApi,
} from './secondBrain/types.js';
import type { HybridQueryOptions, HybridRetrievalMode, TemporalConstraint } from './hybrid/types.js';

export const SECOND_BRAIN_HTTP_VERSION = '1.3.0';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 27_124;
const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_RATE_LIMIT = 120;
const MAXIMUM_REQUEST_DEADLINE_MS = 5_000;
const ALLOWED_BODY_FIELDS = new Set([
	'query',
	'mode',
	'source_ids',
	'project_ids',
	'seed_record_ids',
	'after_ms',
	'before_ms',
	'prefer_recent',
	'limit',
	'candidate_limit',
	'deadline_ms',
	'max_characters',
	'per_evidence_max_characters',
]);

export interface SecondBrainHttpOptions {
	host: '127.0.0.1' | '::1';
	port: number;
	apiKey: string;
	allowedOrigins: ReadonlySet<string>;
	maxBodyBytes: number;
	rateLimitPerMinute: number;
	/** Testable hard wall-clock budget; production configuration is always 5 seconds. */
	requestDeadlineMs?: number;
}

interface RateBucket {
	count: number;
	startedAt: number;
}

interface RequestDeadline {
	controller: AbortController;
	deadlineAt: number;
	dispose: () => void;
}

class HttpError extends Error {
	constructor(readonly status: number, message: string) {
		super(message);
	}
}

export function loadSecondBrainHttpOptions(
	environment: NodeJS.ProcessEnv = process.env,
): SecondBrainHttpOptions {
	const apiKey = environment.OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY?.trim() ?? '';
	if (Buffer.byteLength(apiKey, 'utf8') < 32) {
		throw new Error('OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY is required and must contain at least 32 UTF-8 bytes.');
	}
	const host = environment.OBSIDIAN_SECOND_BRAIN_HTTP_HOST?.trim() || DEFAULT_HOST;
	if (host !== '127.0.0.1' && host !== '::1') {
		throw new Error('OBSIDIAN_SECOND_BRAIN_HTTP_HOST must be exactly 127.0.0.1 or ::1.');
	}
	return {
		host,
		port: strictInteger(
			environment.OBSIDIAN_SECOND_BRAIN_HTTP_PORT,
			DEFAULT_PORT,
			1,
			65_535,
			'OBSIDIAN_SECOND_BRAIN_HTTP_PORT',
		),
		apiKey,
		allowedOrigins: parseOrigins(environment.OBSIDIAN_SECOND_BRAIN_HTTP_ALLOWED_ORIGINS),
		maxBodyBytes: strictInteger(
			environment.OBSIDIAN_SECOND_BRAIN_HTTP_MAX_BODY_BYTES,
			DEFAULT_MAX_BODY_BYTES,
			1_024,
			10_485_760,
			'OBSIDIAN_SECOND_BRAIN_HTTP_MAX_BODY_BYTES',
		),
		rateLimitPerMinute: strictInteger(
			environment.OBSIDIAN_SECOND_BRAIN_HTTP_RATE_LIMIT,
			DEFAULT_RATE_LIMIT,
			1,
			10_000,
			'OBSIDIAN_SECOND_BRAIN_HTTP_RATE_LIMIT',
		),
	};
}

/** Local, authenticated, read-only HTTP surface. It intentionally has no write route. */
export function createSecondBrainHttpServer(
	runtime: SecondBrainRuntimeApi,
	principal: SecondBrainPrincipalPolicy,
	options: SecondBrainHttpOptions,
): Server {
	validateOptions(options);
	const rateBuckets = new Map<string, RateBucket>();
	return createServer(async (request, response) => {
		const deadline = createRequestDeadline(
			request,
			response,
			options.requestDeadlineMs ?? MAXIMUM_REQUEST_DEADLINE_MS,
		);
		let allowedOrigin: string | null = null;
		try {
			assertLoopbackPeer(request);
			allowedOrigin = validateRequestOrigin(request, options.allowedOrigins);
			applyHeaders(response, allowedOrigin);
			if (request.method === 'OPTIONS') {
				handlePreflight(request, response, allowedOrigin);
				return;
			}
			authorize(request, options.apiKey);
			// Invalid credentials cannot consume the authenticated caller's bucket.
			enforceRateLimit(request, options.rateLimitPerMinute, rateBuckets);
			const url = new URL(request.url ?? '/', 'http://second-brain.local');
			if (url.search !== '') throw new HttpError(400, 'Query-string parameters are not supported.');

			if (url.pathname === '/v2/status') {
				if (request.method !== 'GET') throw new HttpError(405, 'Method not allowed.');
				const status = runtime.status(principal);
				assertBeforeDeadline(deadline);
				sendJson(response, 200, status, deadline);
				return;
			}
			if (url.pathname === '/v2/query') {
				if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
				const body = await readJsonObject(
					request,
					options.maxBodyBytes,
					deadline.controller.signal,
					deadline.deadlineAt,
				);
				const parsed = parseQueryBody(body);
				const remainingMs = deadline.deadlineAt - Date.now();
				if (remainingMs < 1 || deadline.controller.signal.aborted) throw requestTimeout();
				parsed.options.deadlineMs = Math.min(
					parsed.options.deadlineMs ?? MAXIMUM_REQUEST_DEADLINE_MS,
					remainingMs,
				);
				parsed.options.signal = deadline.controller.signal;
				const pack = await runtime.query(principal, parsed.request, parsed.options);
				assertBeforeDeadline(deadline);
				sendJson(response, 200, pack, deadline);
				return;
			}
			throw new HttpError(404, 'Endpoint not found.');
		} catch (error) {
			applyHeaders(response, allowedOrigin);
			handleError(response, error);
		} finally {
			deadline.dispose();
		}
	});
}

function parseQueryBody(body: Record<string, unknown>): {
	request: SecondBrainQueryRequest;
	options: HybridQueryOptions;
} {
	if (Object.keys(body).some((key) => !ALLOWED_BODY_FIELDS.has(key))) {
		throw new HttpError(400, 'Request contains an unsupported field.');
	}
	const query = requiredString(body.query, 32_000, 'query');
	const mode = optionalMode(body.mode) ?? 'default';
	const sourceIds = optionalStringArray(body.source_ids, 16, 128, 'source_ids');
	const projectIds = optionalStringArray(body.project_ids, 64, 128, 'project_ids');
	const seedRecordIds = optionalStringArray(body.seed_record_ids, 16, 128, 'seed_record_ids');
	const after = optionalFiniteNumber(body.after_ms, 'after_ms');
	const before = optionalFiniteNumber(body.before_ms, 'before_ms');
	const preferRecent = optionalBoolean(body.prefer_recent, 'prefer_recent');
	if (after !== undefined && before !== undefined && after > before) {
		throw new HttpError(400, 'after_ms must not be greater than before_ms.');
	}
	const temporal: TemporalConstraint | undefined = (
		after === undefined && before === undefined && preferRecent === undefined
	) ? undefined : {
		...(after === undefined ? {} : { after }),
		...(before === undefined ? {} : { before }),
		...(preferRecent === undefined ? {} : { preferRecent }),
	};
	const request: SecondBrainQueryRequest = {
		text: query,
		mode,
		...(sourceIds === undefined ? {} : { sourceIds }),
		...(projectIds === undefined ? {} : { projectIds }),
		...(seedRecordIds === undefined ? {} : { seedRecordIds }),
		...(temporal === undefined ? {} : { temporal }),
	};
	const limit = optionalInteger(body.limit, 1, 50, 'limit');
	const candidateLimit = optionalInteger(body.candidate_limit, 1, 200, 'candidate_limit');
	const deadlineMs = optionalInteger(body.deadline_ms, 1, 5_000, 'deadline_ms');
	const evidenceMaxCharacters = optionalInteger(body.max_characters, 256, 100_000, 'max_characters');
	const perEvidenceMaxCharacters = optionalInteger(
		body.per_evidence_max_characters,
		128,
		20_000,
		'per_evidence_max_characters',
	);
	return {
		request,
		options: {
			...(limit === undefined ? {} : { limit }),
			...(candidateLimit === undefined ? {} : { candidateLimit }),
			...(deadlineMs === undefined ? {} : { deadlineMs }),
			...(evidenceMaxCharacters === undefined ? {} : { evidenceMaxCharacters }),
			...(perEvidenceMaxCharacters === undefined ? {} : { perEvidenceMaxCharacters }),
		},
	};
}

async function readJsonObject(
	request: IncomingMessage,
	maximumBytes: number,
	signal: AbortSignal,
	deadlineAt: number,
): Promise<Record<string, unknown>> {
	const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
	if (contentType !== 'application/json') {
		request.resume();
		throw new HttpError(415, 'Content-Type must be application/json.');
	}
	const declared = request.headers['content-length'];
	if (declared !== undefined) {
		if (!/^[0-9]+$/u.test(declared)) {
			request.resume();
			throw new HttpError(400, 'Content-Length is invalid.');
		}
		if (Number(declared) > maximumBytes) {
			request.resume();
			throw new HttpError(413, 'Request body is too large.');
		}
	}
	const body = await readBodyBeforeDeadline(request, maximumBytes, signal, deadlineAt);
	const total = body.byteLength;
	if (total === 0) throw new HttpError(400, 'Request body is required.');
	let parsed: unknown;
	try {
		parsed = JSON.parse(body.toString('utf8'));
	} catch {
		throw new HttpError(400, 'Request body must be valid JSON.');
	}
	if (!isRecord(parsed)) throw new HttpError(400, 'Request body must be a JSON object.');
	return parsed;
}

function readBodyBeforeDeadline(
	request: IncomingMessage,
	maximumBytes: number,
	signal: AbortSignal,
	deadlineAt: number,
): Promise<Buffer> {
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const remainingMs = deadlineAt - Date.now();
		let timer: NodeJS.Timeout | null = null;

		const cleanup = (): void => {
			if (timer !== null) clearTimeout(timer);
			request.removeListener('data', onData);
			request.removeListener('end', onEnd);
			request.removeListener('error', onError);
			signal.removeEventListener('abort', onDeadline);
		};
		const fail = (error: HttpError): void => {
			if (settled) return;
			settled = true;
			cleanup();
			// Drain any remaining bytes so a slow or oversized request does not retain
			// our bounded chunk buffers or poison a keep-alive parser.
			request.resume();
			reject(error);
		};
		const onData = (raw: Buffer | string): void => {
			const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			total += chunk.byteLength;
			if (total > maximumBytes) {
				fail(new HttpError(413, 'Request body is too large.'));
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(Buffer.concat(chunks, total));
		};
		const onError = (): void => fail(new HttpError(400, 'Request body could not be read.'));
		const onDeadline = (): void => fail(requestTimeout());

		if (signal.aborted || remainingMs < 1) {
			fail(requestTimeout());
			return;
		}
		request.on('data', onData);
		request.once('end', onEnd);
		request.once('error', onError);
		signal.addEventListener('abort', onDeadline, { once: true });
		timer = setTimeout(onDeadline, remainingMs);
		timer.unref();
	});
}

function createRequestDeadline(
	request: IncomingMessage,
	response: ServerResponse,
	deadlineMs: number,
): RequestDeadline {
	const controller = new AbortController();
	const deadlineAt = Date.now() + deadlineMs;
	const timer = setTimeout(() => controller.abort(requestTimeout()), deadlineMs);
	timer.unref();
	const abortFromClient = (): void => controller.abort(new HttpError(400, 'Request was aborted.'));
	const abortFromResponseClose = (): void => {
		if (!response.writableEnded) abortFromClient();
	};
	request.once('aborted', abortFromClient);
	response.once('close', abortFromResponseClose);
	return {
		controller,
		deadlineAt,
		dispose: () => {
			clearTimeout(timer);
			request.removeListener('aborted', abortFromClient);
			response.removeListener('close', abortFromResponseClose);
		},
	};
}

function requestTimeout(): HttpError {
	return new HttpError(408, 'Second-brain request deadline exceeded.');
}

function assertBeforeDeadline(deadline: RequestDeadline): void {
	if (deadline.controller.signal.aborted || Date.now() >= deadline.deadlineAt) {
		throw requestTimeout();
	}
}

function authorize(request: IncomingMessage, expectedKey: string): void {
	const header = request.headers.authorization;
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
		throw new HttpError(401, 'Bearer authentication is required.');
	}
	const received = Buffer.from(header.slice('Bearer '.length), 'utf8');
	const expected = Buffer.from(expectedKey, 'utf8');
	if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
		throw new HttpError(401, 'Bearer authentication failed.');
	}
}

function assertLoopbackPeer(request: IncomingMessage): void {
	const remote = request.socket.remoteAddress;
	if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
		throw new HttpError(403, 'Only loopback clients are accepted.');
	}
}

function validateRequestOrigin(request: IncomingMessage, allowed: ReadonlySet<string>): string | null {
	const raw = request.headers.origin;
	if (raw === undefined) return null;
	if (Array.isArray(raw) || !allowed.has(raw)) throw new HttpError(403, 'Origin is not allowed.');
	return raw;
}

function handlePreflight(
	request: IncomingMessage,
	response: ServerResponse,
	origin: string | null,
): void {
	if (origin === null) throw new HttpError(403, 'CORS preflight requires an allowed Origin.');
	const requestedMethod = request.headers['access-control-request-method'];
	if (requestedMethod !== 'GET' && requestedMethod !== 'POST') {
		throw new HttpError(405, 'CORS method is not allowed.');
	}
	response.statusCode = 204;
	response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
	response.setHeader('Access-Control-Max-Age', '600');
	response.end();
}

function enforceRateLimit(
	request: IncomingMessage,
	maximum: number,
	buckets: Map<string, RateBucket>,
): void {
	const key = request.socket.remoteAddress ?? 'loopback';
	const now = Date.now();
	const existing = buckets.get(key);
	if (!existing || now - existing.startedAt >= 60_000) {
		buckets.set(key, { count: 1, startedAt: now });
		return;
	}
	existing.count += 1;
	if (existing.count > maximum) throw new HttpError(429, 'Rate limit exceeded.');
}

function applyHeaders(response: ServerResponse, origin: string | null): void {
	if (response.headersSent) return;
	response.setHeader('Cache-Control', 'no-store');
	response.setHeader('X-Content-Type-Options', 'nosniff');
	response.setHeader('Referrer-Policy', 'no-referrer');
	response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
	response.setHeader('Vary', 'Origin');
	if (origin !== null) response.setHeader('Access-Control-Allow-Origin', origin);
}

function sendJson(
	response: ServerResponse,
	status: number,
	value: unknown,
	deadline?: RequestDeadline,
): void {
	if (response.writableEnded) return;
	const body = JSON.stringify(value);
	if (deadline !== undefined) assertBeforeDeadline(deadline);
	response.statusCode = status;
	response.setHeader('Content-Type', 'application/json; charset=utf-8');
	response.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
	response.end(body);
}

function handleError(response: ServerResponse, error: unknown): void {
	if (response.writableEnded) return;
	if (error instanceof HttpError) {
		sendJson(response, error.status, { error: error.message });
		return;
	}
	sendJson(response, 500, { error: 'Second-brain request failed safely.' });
}

function requiredString(value: unknown, maximum: number, label: string): string {
	if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
		throw new HttpError(400, `${label} must be a non-empty string of at most ${maximum} characters.`);
	}
	return value;
}

function optionalStringArray(
	value: unknown,
	maximumItems: number,
	maximumLength: number,
	label: string,
): string[] | undefined {
	if (value === undefined) return undefined;
	if (
		!Array.isArray(value)
		|| value.length === 0
		|| value.length > maximumItems
		|| value.some((item) => typeof item !== 'string' || item.length === 0 || item.length > maximumLength)
	) throw new HttpError(400, `${label} is invalid.`);
	return [...new Set(value as string[])];
}

function optionalMode(value: unknown): HybridRetrievalMode | undefined {
	if (value === undefined) return undefined;
	if (value === 'default' || value === 'project' || value === 'reference' || value === 'history') {
		return value;
	}
	throw new HttpError(400, 'mode is invalid.');
}

function optionalInteger(
	value: unknown,
	minimum: number,
	maximum: number,
	label: string,
): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < minimum || value > maximum) {
		throw new HttpError(400, `${label} is invalid.`);
	}
	return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		throw new HttpError(400, `${label} is invalid.`);
	}
	return value;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== 'boolean') throw new HttpError(400, `${label} is invalid.`);
	return value;
}

function parseOrigins(raw: string | undefined): Set<string> {
	const origins = new Set<string>();
	for (const value of (raw ?? '').split(',').map((item) => item.trim()).filter(Boolean)) {
		let parsed: URL;
		try {
			parsed = new URL(value);
		} catch {
			throw new Error('OBSIDIAN_SECOND_BRAIN_HTTP_ALLOWED_ORIGINS contains an invalid origin.');
		}
		if (
			(parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
			|| parsed.origin !== value
			|| parsed.username !== ''
			|| parsed.password !== ''
		) throw new Error('OBSIDIAN_SECOND_BRAIN_HTTP_ALLOWED_ORIGINS must contain exact HTTP origins.');
		origins.add(value);
	}
	return origins;
}

function strictInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string,
): number {
	if (value === undefined || value.trim() === '') return fallback;
	const normalized = value.trim();
	if (!/^[0-9]+$/u.test(normalized)) throw new Error(`${label} must be an integer.`);
	const parsed = Number(normalized);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return parsed;
}

function validateOptions(options: SecondBrainHttpOptions): void {
	if (options.host !== '127.0.0.1' && options.host !== '::1') {
		throw new Error('Second-brain HTTP must bind to loopback.');
	}
	if (Buffer.byteLength(options.apiKey, 'utf8') < 32) throw new Error('Second-brain HTTP API key is too short.');
	if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
		throw new Error('Second-brain HTTP port is invalid.');
	}
	if (!Number.isSafeInteger(options.maxBodyBytes) || options.maxBodyBytes < 1_024) {
		throw new Error('Second-brain HTTP body limit is invalid.');
	}
	if (!Number.isSafeInteger(options.rateLimitPerMinute) || options.rateLimitPerMinute < 1) {
		throw new Error('Second-brain HTTP rate limit is invalid.');
	}
	const requestDeadlineMs = options.requestDeadlineMs ?? MAXIMUM_REQUEST_DEADLINE_MS;
	if (
		!Number.isSafeInteger(requestDeadlineMs)
		|| requestDeadlineMs < 1
		|| requestDeadlineMs > MAXIMUM_REQUEST_DEADLINE_MS
	) throw new Error('Second-brain HTTP request deadline is invalid.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
	const bootstrap = await createSecondBrainBootstrap();
	const options = loadSecondBrainHttpOptions();
	const server = createSecondBrainHttpServer(bootstrap.runtime, bootstrap.principal, options);
	server.listen(options.port, options.host);
	process.once('SIGINT', () => server.close(() => process.exit(0)));
	process.once('SIGTERM', () => server.close(() => process.exit(0)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main().catch(() => {
		process.stderr.write('Compiled second-brain HTTP service failed to start.\n');
		process.exitCode = 1;
	});
}
