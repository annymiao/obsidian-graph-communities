import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAXIMUM_CONFIGURATION_BYTES = 64 * 1024;
const MAXIMUM_STATUS_BYTES = 64 * 1024;
const ALLOWED_ENVIRONMENT_KEYS = new Set([
	'OBSIDIAN_SECOND_BRAIN_CATALOG_PATH',
	'OBSIDIAN_EMBEDDING_PROVIDER',
	'OBSIDIAN_EMBEDDING_DIMENSION',
	'OBSIDIAN_EMBEDDING_MODEL',
	'OBSIDIAN_EMBEDDING_PORT',
	'OBSIDIAN_RERANKER_PROVIDER',
	'OBSIDIAN_RERANKER_MODEL',
	'OBSIDIAN_RERANKER_PORT',
	'OBSIDIAN_PRINCIPAL_ID',
	'OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS',
	'OBSIDIAN_PRINCIPAL_ALLOWED_PROJECT_IDS',
	'OBSIDIAN_PRINCIPAL_ALLOWED_MODES',
	'OBSIDIAN_PRINCIPAL_INCLUDED_PATH_PREFIXES',
	'OBSIDIAN_PRINCIPAL_EXCLUDED_PATH_PREFIXES',
	'OBSIDIAN_TRANSMISSION_REVIEW',
	'OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL',
	'OBSIDIAN_ALLOW_CRITICAL_WRITES',
]);
const REQUIRED_ENVIRONMENT_KEYS = [
	'OBSIDIAN_SECOND_BRAIN_CATALOG_PATH',
	'OBSIDIAN_EMBEDDING_PROVIDER',
	'OBSIDIAN_EMBEDDING_DIMENSION',
	'OBSIDIAN_RERANKER_PROVIDER',
	'OBSIDIAN_PRINCIPAL_ID',
	'OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS',
	'OBSIDIAN_PRINCIPAL_ALLOWED_MODES',
	'OBSIDIAN_TRANSMISSION_REVIEW',
];

const [nodeExecutable, serverPath, runtimeEnvironmentPath] = process.argv.slice(2);
if (!nodeExecutable || !serverPath || !runtimeEnvironmentPath) {
	process.stderr.write(
		'usage: smoke-client.mjs NODE SECOND_BRAIN_SERVER PRIVATE_RUNTIME_ENV_JSON\n',
	);
	process.exit(2);
}

const runtimeEnvironment = await loadPrivateRuntimeEnvironment(runtimeEnvironmentPath);
const childEnvironment = { ...process.env };
for (const key of Object.keys(childEnvironment)) {
	if (key.startsWith('OBSIDIAN_')) delete childEnvironment[key];
}
Object.assign(childEnvironment, runtimeEnvironment);

const transport = new StdioClientTransport({
	command: nodeExecutable,
	args: [serverPath],
	env: childEnvironment,
});
const client = new Client({ name: 'obsidian-second-brain-smoke', version: '1.3.0' });

try {
	await client.connect(transport);
	// Deliberately call only the redacted aggregate status tool. A release smoke
	// test must never query, enumerate, or echo source paths or note bodies.
	const result = await client.callTool({
		name: 'get_second_brain_status',
		arguments: {},
	});
	if (result.isError === true) throw new Error('Second-brain status returned an error.');
	const content = Array.isArray(result.content) ? result.content : [];
	const first = content[0];
	if (!first || typeof first !== 'object' || first.type !== 'text'
		|| typeof first.text !== 'string') {
		throw new Error('Second-brain status did not return JSON text.');
	}
	if (Buffer.byteLength(first.text, 'utf8') > MAXIMUM_STATUS_BYTES) {
		throw new Error('Second-brain status exceeded the smoke response limit.');
	}
	let status;
	try {
		status = JSON.parse(first.text);
	} catch {
		throw new Error('Second-brain status was not valid JSON.');
	}
	if (!isRecord(status) || status.ready !== true) {
		throw new Error('Second-brain status is not READY.');
	}
	const vector = isRecord(status.vector) ? status.vector : {};
	process.stdout.write(`${JSON.stringify({
		ready: true,
		revision: safeInteger(status.revision),
		source_count: safeInteger(status.sourceCount),
		active_documents: safeInteger(status.activeDocuments),
		records: safeInteger(status.records),
		vector: {
			embedding_kind: safeShortString(vector.embeddingKind),
			dimension: safeInteger(vector.dimension),
			precomputed: vector.precomputed === true,
		},
	}, null, 2)}\n`);
} finally {
	await client.close();
}

async function loadPrivateRuntimeEnvironment(configuredPath) {
	if (!path.isAbsolute(configuredPath)) {
		throw new Error('Private runtime environment JSON path must be absolute.');
	}
	let stats;
	try {
		stats = await lstat(configuredPath);
	} catch {
		throw new Error('Private runtime environment JSON is unavailable.');
	}
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error('Private runtime environment JSON must be a regular non-symlink file.');
	}
	assertPrivateModeAndOwner(stats, 'Private runtime environment JSON');
	if (stats.size < 2 || stats.size > MAXIMUM_CONFIGURATION_BYTES) {
		throw new Error('Private runtime environment JSON has an invalid size.');
	}
	let parsed;
	try {
		const canonicalPath = await realpath(configuredPath);
		parsed = JSON.parse(await readFile(canonicalPath, 'utf8'));
	} catch {
		throw new Error('Private runtime environment JSON could not be read as JSON.');
	}
	if (!isRecord(parsed)) throw new Error('Private runtime environment JSON must be an object.');
	const keys = Object.keys(parsed);
	if (keys.some((key) => !ALLOWED_ENVIRONMENT_KEYS.has(key))) {
		throw new Error('Private runtime environment JSON contains an unsupported key.');
	}
	const environment = {};
	for (const key of keys) {
		const value = parsed[key];
		if (typeof value !== 'string' || value.length === 0 || value.length > 32_768
			|| /[\0\r\n]/u.test(value)) {
			throw new Error(`Private runtime value ${key} must be a bounded single-line string.`);
		}
		environment[key] = value;
	}
	for (const key of REQUIRED_ENVIRONMENT_KEYS) {
		if (!(key in environment)) throw new Error(`Private runtime configuration is missing ${key}.`);
	}
	validateRuntimeEnvironment(environment);
	await validatePrivateCatalog(environment.OBSIDIAN_SECOND_BRAIN_CATALOG_PATH);
	return environment;
}

function validateRuntimeEnvironment(environment) {
	const embedding = environment.OBSIDIAN_EMBEDDING_PROVIDER;
	if (embedding !== 'deterministic' && embedding !== 'loopback') {
		throw new Error('OBSIDIAN_EMBEDDING_PROVIDER must be deterministic or loopback.');
	}
	if (!/^[0-9]+$/u.test(environment.OBSIDIAN_EMBEDDING_DIMENSION)) {
		throw new Error('OBSIDIAN_EMBEDDING_DIMENSION must be an integer.');
	}
	if (embedding === 'deterministic') {
		if (environment.OBSIDIAN_EMBEDDING_MODEL || environment.OBSIDIAN_EMBEDDING_PORT) {
			throw new Error('Deterministic embedding cannot configure a model or port.');
		}
	} else if (!environment.OBSIDIAN_EMBEDDING_MODEL
		|| !validPort(environment.OBSIDIAN_EMBEDDING_PORT)) {
		throw new Error('Loopback embedding requires a model and loopback port.');
	}

	const reranker = environment.OBSIDIAN_RERANKER_PROVIDER;
	if (reranker !== 'none' && reranker !== 'loopback') {
		throw new Error('OBSIDIAN_RERANKER_PROVIDER must be none or loopback.');
	}
	if (reranker === 'none') {
		if (environment.OBSIDIAN_RERANKER_MODEL || environment.OBSIDIAN_RERANKER_PORT) {
			throw new Error('Disabled reranking cannot configure a model or port.');
		}
	} else if (!environment.OBSIDIAN_RERANKER_MODEL
		|| !validPort(environment.OBSIDIAN_RERANKER_PORT)) {
		throw new Error('Loopback reranking requires a model and loopback port.');
	}

	const modes = commaSeparated(environment.OBSIDIAN_PRINCIPAL_ALLOWED_MODES);
	if (modes.length === 0
		|| modes.some((mode) => !['default', 'project', 'reference', 'history'].includes(mode))) {
		throw new Error('OBSIDIAN_PRINCIPAL_ALLOWED_MODES is invalid.');
	}
	if (commaSeparated(environment.OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS).length === 0) {
		throw new Error('OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS must explicitly name at least one source.');
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(environment.OBSIDIAN_PRINCIPAL_ID)) {
		throw new Error('OBSIDIAN_PRINCIPAL_ID is invalid.');
	}
	if (!['required', 'trusted-local', 'disabled'].includes(environment.OBSIDIAN_TRANSMISSION_REVIEW)) {
		throw new Error('OBSIDIAN_TRANSMISSION_REVIEW is invalid.');
	}
	const writeApproval = environment.OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL;
	if (writeApproval !== undefined && writeApproval !== 'trusted-mcp-app') {
		throw new Error('OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL only accepts trusted-mcp-app.');
	}
	const allowCritical = environment.OBSIDIAN_ALLOW_CRITICAL_WRITES;
	if (allowCritical !== undefined && allowCritical !== 'true' && allowCritical !== 'false') {
		throw new Error('OBSIDIAN_ALLOW_CRITICAL_WRITES must be true or false.');
	}
	if (allowCritical === 'true' && writeApproval !== 'trusted-mcp-app') {
		throw new Error('Critical writes require explicit trusted MCP App write approval.');
	}
}

async function validatePrivateCatalog(catalogPath) {
	if (!path.isAbsolute(catalogPath) || catalogPath === path.parse(catalogPath).root) {
		throw new Error('OBSIDIAN_SECOND_BRAIN_CATALOG_PATH must be an absolute non-root path.');
	}
	let stats;
	try {
		stats = await lstat(catalogPath);
	} catch {
		throw new Error('Compiled runtime catalog is unavailable.');
	}
	if (!stats.isFile() || stats.isSymbolicLink()) {
		throw new Error('Compiled runtime catalog must be a regular non-symlink file.');
	}
	assertPrivateModeAndOwner(stats, 'Compiled runtime catalog');
}

function assertPrivateModeAndOwner(stats, label) {
	if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
		throw new Error(`${label} must not be readable or writable by group/other users.`);
	}
	if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
		throw new Error(`${label} must be owned by the current user.`);
	}
}

function commaSeparated(value) {
	return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function validPort(value) {
	if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) return false;
	const port = Number(value);
	return Number.isSafeInteger(port) && port >= 1_024 && port <= 65_535;
}

function safeInteger(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function safeShortString(value) {
	return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,64}$/u.test(value)
		? value
		: 'unknown';
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
