import { homedir } from 'node:os';
import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { readTransmissionReviewMode } from './reviewPolicy.js';
import { createSourceId } from './stableIds.js';
import { ServerConfig } from './types.js';

const DEFAULT_EXCLUDED_FOLDERS = ['.git', '.obsidian', '.trash', 'node_modules'];
const MAXIMUM_KNOWLEDGE_SOURCES = 16;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface KnowledgeServiceConfig {
	sources: ServerConfig[];
	/** True when sources came from the explicit logical-source catalog. */
	catalogConfigured: boolean;
	transmissionReviewMode: ServerConfig['transmissionReviewMode'];
}

interface ConfiguredKnowledgeSource {
	id: string;
	name: string;
	path: string;
	kind: 'directory' | 'obsidian-vault';
	projectId?: string;
	writable: boolean;
}

export async function loadKnowledgeServiceConfig(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgeServiceConfig> {
	if (environment.OBSIDIAN_SOURCES_JSON === undefined) {
		const source = await loadServerConfig(environment);
		return {
			sources: [source],
			catalogConfigured: false,
			transmissionReviewMode: source.transmissionReviewMode,
		};
	}
	if (environment.OBSIDIAN_VAULT_PATH?.trim()) {
		throw new Error('OBSIDIAN_SOURCES_JSON and OBSIDIAN_VAULT_PATH cannot be used together.');
	}
	if (environment.OBSIDIAN_SOURCE_IDENTITY?.trim()) {
		throw new Error('OBSIDIAN_SOURCE_IDENTITY must be set per source through OBSIDIAN_SOURCES_JSON.id.');
	}

	const configuredSources = parseConfiguredSources(environment.OBSIDIAN_SOURCES_JSON);
	const resolvedRoots = await Promise.all(configuredSources.map(async (source) => {
		if (!path.isAbsolute(source.path)) {
			throw new Error(`Knowledge source "${source.name}" must use an absolute path.`);
		}
		const configuredRoot = path.resolve(source.path);
		if (configuredRoot === path.parse(configuredRoot).root) {
			throw new Error(`Knowledge source "${source.name}" cannot use a filesystem root.`);
		}
		try {
			const configuredRootStats = await lstat(configuredRoot);
			if (configuredRootStats.isSymbolicLink()) {
				throw new Error(`Knowledge source "${source.name}" cannot use a symbolic-link root.`);
			}
			if (!configuredRootStats.isDirectory()) {
				throw new Error(`Knowledge source "${source.name}" must point to a directory.`);
			}
			return await realpath(configuredRoot);
		} catch (error) {
			if (error instanceof Error && error.message.startsWith('Knowledge source "')) throw error;
			throw new Error(`Knowledge source "${source.name}" path is unavailable.`);
		}
	}));

	for (let first = 0; first < resolvedRoots.length; first += 1) {
		for (let second = first + 1; second < resolvedRoots.length; second += 1) {
			const firstRoot = resolvedRoots[first];
			const secondRoot = resolvedRoots[second];
			if (!firstRoot || !secondRoot || !pathsOverlap(firstRoot, secondRoot)) continue;
			throw new Error(
				`Knowledge source roots cannot overlap: "${configuredSources[first]?.name}" and "${configuredSources[second]?.name}".`,
			);
		}
	}

	const persistenceEnabled = readBoolean(environment.OBSIDIAN_PERSIST_INDEX, true);
	const configuredArtifactRoot = persistenceEnabled && environment.OBSIDIAN_ARTIFACT_PATH?.trim()
		? await canonicalizePotentialPath(path.resolve(environment.OBSIDIAN_ARTIFACT_PATH.trim()))
		: null;
	if (configuredArtifactRoot) {
		for (let index = 0; index < resolvedRoots.length; index += 1) {
			const sourceRoot = resolvedRoots[index];
			if (sourceRoot && pathsOverlap(sourceRoot, configuredArtifactRoot)) {
				throw new Error(
					`Persistent index root cannot overlap knowledge source "${configuredSources[index]?.name}".`,
				);
			}
		}
	}

	const sources = await Promise.all(configuredSources.map(async (source, index) => {
		const sourceEnvironment: NodeJS.ProcessEnv = { ...environment };
		delete sourceEnvironment.OBSIDIAN_SOURCES_JSON;
		sourceEnvironment.OBSIDIAN_VAULT_PATH = resolvedRoots[index];
		sourceEnvironment.OBSIDIAN_SOURCE_IDENTITY = source.id;
		if (configuredArtifactRoot) {
			sourceEnvironment.OBSIDIAN_ARTIFACT_PATH = path.join(
				configuredArtifactRoot,
				createSourceId(source.id),
			);
		} else {
			delete sourceEnvironment.OBSIDIAN_ARTIFACT_PATH;
		}
		const loaded = await loadServerConfig(sourceEnvironment);
		return {
			...loaded,
			sourceName: source.name,
			sourceKind: source.kind,
			writable: source.writable,
			...(source.projectId === undefined ? {} : { projectId: source.projectId }),
		};
	}));

	return {
		sources,
		catalogConfigured: true,
		transmissionReviewMode: readTransmissionReviewMode(
			environment.OBSIDIAN_TRANSMISSION_REVIEW,
		),
	};
}

export async function loadServerConfig(
	environment: NodeJS.ProcessEnv = process.env,
): Promise<ServerConfig> {
	const configuredPath = environment.OBSIDIAN_VAULT_PATH?.trim();
	if (!configuredPath) {
		throw new Error('OBSIDIAN_VAULT_PATH is required.');
	}

	const vaultPath = await realpath(path.resolve(configuredPath));
	const vaultStat = await stat(vaultPath);
	if (!vaultStat.isDirectory()) {
		throw new Error('OBSIDIAN_VAULT_PATH must point to a directory.');
	}

	const configuredExclusions = (environment.OBSIDIAN_EXCLUDE_FOLDERS ?? '')
		.split(',')
		.map((value) => normalizeRelativePath(value))
		.filter(Boolean);
	const excludedFolders = new Set(
		[...DEFAULT_EXCLUDED_FOLDERS, ...configuredExclusions].map((value) => {
			return normalizeRelativePath(value);
		}),
	);

	const chunkTokens = readBoundedInteger(
		environment.OBSIDIAN_CHUNK_TOKENS,
		700,
		200,
		2_000,
	);
	const chunkOverlapTokens = Math.min(
		readBoundedInteger(environment.OBSIDIAN_CHUNK_OVERLAP_TOKENS, 80, 0, 400),
		Math.floor(chunkTokens / 3),
	);
	const sourceIdentity = environment.OBSIDIAN_SOURCE_IDENTITY?.trim() || vaultPath;
	const persistenceEnabled = readBoolean(environment.OBSIDIAN_PERSIST_INDEX, true);
	const artifactPath = persistenceEnabled
		? await resolveArtifactPath(environment, sourceIdentity)
		: null;
	if (artifactPath && pathsOverlap(vaultPath, artifactPath)) {
		throw new Error(
			'Persistent index storage and OBSIDIAN_VAULT_PATH must not contain one another.',
		);
	}

	return {
		vaultPath,
		vaultName: path.basename(vaultPath),
		sourceName: path.basename(vaultPath),
		sourceIdentity,
		artifactPath,
		excludedFolders,
		indexTtlMs: readBoundedInteger(
			environment.OBSIDIAN_INDEX_TTL_MS,
			30_000,
			1_000,
			3_600_000,
		),
		maxFileCharacters: readBoundedInteger(
			environment.OBSIDIAN_MAX_FILE_CHARACTERS,
			5_000_000,
			10_000,
			20_000_000,
		),
		maxFiles: readBoundedInteger(
			environment.OBSIDIAN_MAX_FILES,
			25_000,
			100,
			250_000,
		),
		chunkTokens,
		chunkOverlapTokens,
		defaultContextTokens: readBoundedInteger(
			environment.OBSIDIAN_DEFAULT_CONTEXT_TOKENS,
			4_000,
			500,
			16_000,
		),
		maxSourceTokens: readBoundedInteger(
			environment.OBSIDIAN_MAX_SOURCE_TOKENS,
			900,
			200,
			4_000,
		),
		transmissionReviewMode: readTransmissionReviewMode(
			environment.OBSIDIAN_TRANSMISSION_REVIEW,
		),
	};
}

function parseConfiguredSources(raw: string): ConfiguredKnowledgeSource[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('OBSIDIAN_SOURCES_JSON must be a valid JSON array.');
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAXIMUM_KNOWLEDGE_SOURCES) {
		throw new Error(`OBSIDIAN_SOURCES_JSON must contain 1 to ${MAXIMUM_KNOWLEDGE_SOURCES} sources.`);
	}

	const seenIds = new Set<string>();
	return parsed.map((value, index) => {
		if (!isRecord(value)) {
			throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} must be an object.`);
		}
		const supportedKeys = new Set(['id', 'kind', 'name', 'path', 'project_id', 'writable']);
		const keys = Object.keys(value);
		if (keys.some((key) => !supportedKeys.has(key))) {
			throw new Error(
				`OBSIDIAN_SOURCES_JSON item ${index + 1} contains an unsupported field.`,
			);
		}
		const id = strictSourceString(value.id, 'id', index, 128);
		const name = strictSourceString(value.name, 'name', index, 160);
		const sourcePath = strictSourceString(value.path, 'path', index, 4_096);
		const projectId = value.project_id === undefined
			? undefined
			: strictSourceString(value.project_id, 'project_id', index, 128);
		const kind = value.kind === undefined ? 'directory' : value.kind;
		if (kind !== 'directory' && kind !== 'obsidian-vault') {
			throw new Error(
				`OBSIDIAN_SOURCES_JSON item ${index + 1} kind must be directory or obsidian-vault.`,
			);
		}
		const writable = value.writable ?? false;
		if (typeof writable !== 'boolean') {
			throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} writable must be boolean.`);
		}
		if (!SOURCE_ID_PATTERN.test(id)) {
			throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} has an invalid id.`);
		}
		if (projectId !== undefined && !SOURCE_ID_PATTERN.test(projectId)) {
			throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} has an invalid project_id.`);
		}
		if (/\p{Cc}/u.test(name)) {
			throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} has an invalid name.`);
		}
		const comparableId = id.toLowerCase();
		if (seenIds.has(comparableId)) {
			throw new Error(`OBSIDIAN_SOURCES_JSON contains a duplicate source id: ${id}.`);
		}
		seenIds.add(comparableId);
		return {
			id,
			name,
			path: sourcePath,
			kind,
			writable,
			...(projectId === undefined ? {} : { projectId }),
		};
	});
}

function strictSourceString(
	value: unknown,
	field: string,
	index: number,
	maximumLength: number,
): string {
	if (
		typeof value !== 'string'
		|| value.length === 0
		|| value.length > maximumLength
		|| value !== value.trim()
		|| value.includes('\0')
	) {
		throw new Error(`OBSIDIAN_SOURCES_JSON item ${index + 1} has an invalid ${field}.`);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveArtifactPath(
	environment: NodeJS.ProcessEnv,
	sourceIdentity: string,
): Promise<string> {
	const configured = environment.OBSIDIAN_ARTIFACT_PATH?.trim();
	if (configured) return canonicalizePotentialPath(path.resolve(configured));

	let applicationDataRoot: string;
	if (process.platform === 'darwin') {
		applicationDataRoot = path.join(homedir(), 'Library', 'Application Support');
	} else if (process.platform === 'win32') {
		applicationDataRoot = environment.LOCALAPPDATA?.trim()
			|| environment.APPDATA?.trim()
			|| path.join(homedir(), 'AppData', 'Local');
	} else {
		applicationDataRoot = environment.XDG_DATA_HOME?.trim()
			|| path.join(homedir(), '.local', 'share');
	}

	return canonicalizePotentialPath(path.join(
		path.resolve(applicationDataRoot),
		'Obsidian Knowledge Gateway',
		'indexes',
		createSourceId(sourceIdentity),
	));
}

async function canonicalizePotentialPath(candidate: string): Promise<string> {
	let existing = candidate;
	const missingSegments: string[] = [];
	for (;;) {
		try {
			const canonical = await realpath(existing);
			return path.join(canonical, ...missingSegments.reverse());
		} catch (error) {
			if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
			const parent = path.dirname(existing);
			if (parent === existing) throw error;
			missingSegments.push(path.basename(existing));
			existing = parent;
		}
	}
}

function isSameOrDescendant(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return relative === ''
		|| (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathsOverlap(first: string, second: string): boolean {
	return isSameOrDescendant(first, second) || isSameOrDescendant(second, first);
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value?.trim()) return fallback;
	const normalized = value.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
	if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
	throw new Error('OBSIDIAN_PERSIST_INDEX must be true or false.');
}

function readBoundedInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: fallback;
}

function normalizeRelativePath(value: string): string {
	return value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}
