import { homedir } from 'node:os';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createSourceId } from './stableIds.js';
import { ServerConfig } from './types.js';

const DEFAULT_EXCLUDED_FOLDERS = ['.git', '.obsidian', '.trash', 'node_modules'];

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
	};
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
	const normalized = value.trim().toLocaleLowerCase();
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
