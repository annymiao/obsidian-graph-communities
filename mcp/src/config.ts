import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
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

	return {
		vaultPath,
		vaultName: path.basename(vaultPath),
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
