#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import {
	loadSecondBrainBuildConfiguration,
	publishSecondBrainRuntimeCatalog,
	validateSecondBrainBuildArtifacts,
} from './secondBrainBootstrap.js';

export const SECOND_BRAIN_COMPILE_VERSION = '1.3.0';
const DEFAULT_WATCH_INTERVAL_MS = 30_000;

export interface OfflineCompileOptions {
	forceCompaction: boolean;
	watch: boolean;
	watchIntervalMs: number;
}

export interface OfflineSourceCompileSummary {
	sourceId: string;
	label: string;
	kind: 'directory' | 'obsidian-vault';
	projectScoped: boolean;
	generationId: string;
	compiledAt: string;
	activeDocuments: number;
	records: number;
	compiledFiles: number;
	reusedFiles: number;
	resumedFiles: number;
	tombstonedFiles: number;
	duplicateFiles: number;
	skippedSymlinks: number;
	compacted: boolean;
}

export interface OfflineCompileSummary {
	status: 'ready';
	serviceVersion: string;
	runCompletedAt: string;
	sourceCount: number;
	activeDocuments: number;
	records: number;
	vector: {
		adapterId: string;
		modelId: string;
		embeddingKind: 'lexical_hash' | 'semantic';
		dimension: number;
	};
	sources: OfflineSourceCompileSummary[];
}

export function parseOfflineCompileArguments(
	arguments_: readonly string[],
	environment: NodeJS.ProcessEnv = process.env,
): OfflineCompileOptions {
	let forceCompaction = false;
	let watchOverride: boolean | undefined;
	for (const argument of arguments_) {
		if (argument === '--force-compaction') forceCompaction = true;
		else if (argument === '--watch') watchOverride = true;
		else if (argument === '--once') watchOverride = false;
		else throw new Error(`Unsupported offline compiler argument: ${argument}`);
	}
	const configuredInterval = environment.OBSIDIAN_COMPILE_WATCH_MS?.trim();
	const watch = watchOverride ?? (configuredInterval !== undefined && configuredInterval !== '');
	const watchIntervalMs = configuredInterval
		? strictInteger(configuredInterval, 1_000, 3_600_000, 'OBSIDIAN_COMPILE_WATCH_MS')
		: DEFAULT_WATCH_INTERVAL_MS;
	return { forceCompaction, watch, watchIntervalMs };
}

/** Runs one complete, serialized offline build over synthetic/configured local sources. */
export async function compileConfiguredSources(
	environment: NodeJS.ProcessEnv = process.env,
	options: Pick<OfflineCompileOptions, 'forceCompaction'> = { forceCompaction: false },
): Promise<OfflineCompileSummary> {
	const configuration = await loadSecondBrainBuildConfiguration(environment);
	const sources: OfflineSourceCompileSummary[] = [];
	// Deliberately sequential: an explicitly selected local embedding model may
	// have tight memory bounds, while first-build latency has no online SLO.
	for (const source of configuration.sources) {
		const result = await source.compiler.build({ forceCompaction: options.forceCompaction });
		const bundle = result.generation.bundle;
		const activeDocuments = bundle.statistics.activeDocuments;
		const records = bundle.layers.derived.data.documents.reduce(
			(total, document) => total + document.chunks.length,
			0,
		);
		sources.push({
			sourceId: source.descriptor.sourceId,
			label: source.descriptor.label,
			kind: source.descriptor.kind,
			projectScoped: source.descriptor.projectId !== undefined,
			generationId: result.generation.generationId,
			compiledAt: bundle.createdAt,
			activeDocuments,
			records,
			compiledFiles: result.compiledFiles,
			reusedFiles: result.reusedFiles,
			resumedFiles: result.resumedFiles,
			tombstonedFiles: result.tombstonedFiles,
			duplicateFiles: result.duplicateFiles,
			skippedSymlinks: result.skippedSymlinks,
			compacted: result.compacted,
		});
	}
	// The online processes learn about a new complete set only after every
	// source generation above has published successfully.
	await validateSecondBrainBuildArtifacts(configuration);
	await publishSecondBrainRuntimeCatalog(configuration);
	return {
		status: 'ready',
		serviceVersion: SECOND_BRAIN_COMPILE_VERSION,
		runCompletedAt: new Date().toISOString(),
		sourceCount: sources.length,
		activeDocuments: sources.reduce((sum, source) => sum + source.activeDocuments, 0),
		records: sources.reduce((sum, source) => sum + source.records, 0),
		vector: {
			adapterId: configuration.embeddingAdapter.id,
			modelId: configuration.embeddingAdapter.modelId,
			embeddingKind: configuration.embeddingAdapter.kind,
			dimension: configuration.embeddingAdapter.dimension,
		},
		sources,
	};
}

export async function runOfflineCompileCli(
	arguments_: readonly string[] = process.argv.slice(2),
	environment: NodeJS.ProcessEnv = process.env,
	writeOutput: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Promise<void> {
	const options = parseOfflineCompileArguments(arguments_, environment);
	let stopped = false;
	let wake: (() => void) | null = null;
	const stop = (): void => {
		stopped = true;
		wake?.();
	};
	if (options.watch) {
		process.once('SIGINT', stop);
		process.once('SIGTERM', stop);
	}
	try {
		let first = true;
		do {
			const summary = await compileConfiguredSources(environment, {
				forceCompaction: first && options.forceCompaction,
			});
			writeOutput(JSON.stringify(summary));
			first = false;
			if (!options.watch || stopped) break;
			await new Promise<void>((resolve) => {
				wake = resolve;
				const timer = setTimeout(resolve, options.watchIntervalMs);
				const previousWake = wake;
				wake = () => {
					clearTimeout(timer);
					previousWake?.();
				};
			});
			wake = null;
		} while (!stopped);
	} finally {
		if (options.watch) {
			process.removeListener('SIGINT', stop);
			process.removeListener('SIGTERM', stop);
		}
	}
}

function strictInteger(value: string, minimum: number, maximum: number, label: string): number {
	if (!/^[0-9]+$/u.test(value)) throw new Error(`${label} must be an integer.`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
	}
	return parsed;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	runOfflineCompileCli().catch(() => {
		// Do not echo configuration errors that could contain a private host path.
		process.stderr.write('Second-brain offline compilation failed; no source content was emitted.\n');
		process.exitCode = 1;
	});
}
