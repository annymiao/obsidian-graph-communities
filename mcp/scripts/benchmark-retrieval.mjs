#!/usr/bin/env node

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const FIVE_SECONDS_MS = 5_000;
const DEFAULTS = Object.freeze({
	files: 1_000,
	queries: 100,
	longFileCharacters: 250_000,
});
const LIMITS = Object.freeze({
	files: 249_000,
	queries: 100_000,
	longFileCharacters: 19_000_000,
});

const help = `Usage: node scripts/benchmark-retrieval.mjs [options]

Generate a temporary synthetic Vault and benchmark KnowledgeIndex.search().

Options:
  --files N       Number of ordinary Markdown files (default: ${DEFAULTS.files})
  --queries N     Total timed searches, including the first search (default: ${DEFAULTS.queries})
  --long-file N   Characters in one additional long Markdown file; 0 disables it
                  (default: ${DEFAULTS.longFileCharacters})
  -h, --help      Show this help

The script imports the compiled implementation from dist/src. Run
"pnpm run build" before the benchmark when dist is missing or stale.
`;

async function main() {
	assertSupportedNode();
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(help);
		return;
	}

	const { KnowledgeIndex, loadServerConfig } = await loadImplementation();
	let vaultPath;
	let artifactPath;
	const generationStartedAt = performance.now();

	try {
		vaultPath = await mkdtemp(path.join(tmpdir(), 'obsidian-retrieval-benchmark-'));
		artifactPath = await mkdtemp(path.join(tmpdir(), 'obsidian-artifact-benchmark-'));
		await generateSyntheticVault(vaultPath, options);
		const generationMs = performance.now() - generationStartedAt;
		const maximumFiles = Math.min(
			250_000,
			Math.max(100, options.files + (options.longFileCharacters > 0 ? 1 : 0) + 10),
		);
		const maximumFileCharacters = Math.min(
			20_000_000,
			Math.max(5_000_000, options.longFileCharacters + 10_000),
		);
		const config = await loadServerConfig({
			OBSIDIAN_VAULT_PATH: vaultPath,
			OBSIDIAN_MAX_FILES: String(maximumFiles),
			OBSIDIAN_MAX_FILE_CHARACTERS: String(maximumFileCharacters),
			OBSIDIAN_ARTIFACT_PATH: artifactPath,
			OBSIDIAN_SOURCE_IDENTITY: 'benchmark:deterministic-synthetic-vault',
		});
		const index = new KnowledgeIndex(config);
		const cases = buildQueryCases(options);
		const first = await timeSearch(index, cases[0]);
		const cached = [];

		for (let queryIndex = 1; queryIndex < cases.length; queryIndex += 1) {
			cached.push(await timeSearch(index, cases[queryIndex]));
		}

		const stats = await index.getStats(false);
		const reopenedIndex = new KnowledgeIndex(config);
		const reopened = await timeSearch(reopenedIndex, cases[0]);
		const reopenedStats = await reopenedIndex.getStats(false);
		const all = [first, ...cached];
		const report = {
			benchmark: 'KnowledgeIndex synthetic retrieval',
			disclaimer: [
				'This is a synthetic benchmark tool, not a product performance guarantee or SLO.',
				'Results depend on hardware, filesystem, build, corpus shape, and query mix.',
				'Cached timings include a full source-metadata validation before reusing one in-process snapshot; reopenedUnchangedQuery measures verified reuse of the current local generation.',
			].join(' '),
			runtime: {
				node: process.version,
				platform: process.platform,
				architecture: process.arch,
			},
			workload: {
				ordinaryFiles: options.files,
				longFiles: options.longFileCharacters > 0 ? 1 : 0,
				longFileCharacters: options.longFileCharacters,
				totalTimedQueries: options.queries,
				cachedTimedQueries: cached.length,
				queryMix: describeQueryMix(cases),
				thresholdMs: FIVE_SECONDS_MS,
				sourceValidation: 'full metadata scan before every snapshot reuse',
			},
			vault: {
				generationMs: roundMilliseconds(generationMs),
				discoveredNotes: stats.discoveredNoteCount,
				indexedNotes: stats.indexedNoteCount,
				chunks: stats.chunkCount,
				links: stats.linkCount,
				firstGenerationId: stats.indexGenerationId,
				reopenedGenerationId: reopenedStats.indexGenerationId,
				reopenedIndexOrigin: reopenedStats.indexOrigin,
			},
			timingsMs: {
				firstQuery: roundMilliseconds(first.durationMs),
				reopenedUnchangedQuery: roundMilliseconds(reopened.durationMs),
				cachedQueries: summarize(cached.map((measurement) => measurement.durationMs)),
				cachedQueriesByKind: summarizeByKind(cached),
				allQueries: summarize(all.map((measurement) => measurement.durationMs)),
			},
			violationsOver5s: {
				firstQuery: first.durationMs > FIVE_SECONDS_MS ? 1 : 0,
				reopenedUnchangedQuery: reopened.durationMs > FIVE_SECONDS_MS ? 1 : 0,
				cachedQueries: countViolations(cached),
				total: countViolations([...all, reopened]),
			},
			validation: {
				...summarizeValidation(all),
				reopenedQueryValid: reopened.valid,
				reusedPublishedGeneration: reopenedStats.indexOrigin === 'persistent'
					&& reopenedStats.indexGenerationId === stats.indexGenerationId,
			},
		};

		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	} finally {
		if (vaultPath) await rm(vaultPath, { recursive: true, force: true });
		if (artifactPath) await rm(artifactPath, { recursive: true, force: true });
	}
}

function assertSupportedNode() {
	const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
	if (!Number.isInteger(major) || major < 20) {
		throw new Error(`Node.js 20 or newer is required; found ${process.version}.`);
	}
}

function parseArguments(argumentsList) {
	const parsed = { ...DEFAULTS, help: false };
	for (let index = 0; index < argumentsList.length; index += 1) {
		const argument = argumentsList[index];
		if (argument === '--help' || argument === '-h') {
			parsed.help = true;
			continue;
		}
		const [name, inlineValue] = argument.split('=', 2);
		if (!['--files', '--queries', '--long-file'].includes(name)) {
			throw new Error(`Unknown option: ${argument}\n\n${help}`);
		}
		const value = inlineValue ?? argumentsList[++index];
		if (value === undefined || value.startsWith('--')) {
			throw new Error(`Missing integer value for ${name}.`);
		}
		if (name === '--files') {
			parsed.files = readInteger(name, value, 1, LIMITS.files);
		} else if (name === '--queries') {
			parsed.queries = readInteger(name, value, 1, LIMITS.queries);
		} else {
			parsed.longFileCharacters = readInteger(
				name,
				value,
				0,
				LIMITS.longFileCharacters,
			);
		}
	}
	return parsed;
}

function readInteger(name, value, minimum, maximum) {
	if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer.`);
	const number = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
		throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
	}
	return number;
}

async function loadImplementation() {
	try {
		return await import('../dist/src/knowledgeIndex.js').then(async ({ KnowledgeIndex }) => {
			const { loadServerConfig } = await import('../dist/src/config.js');
			return { KnowledgeIndex, loadServerConfig };
		});
	} catch (error) {
		if (error && typeof error === 'object' && error.code === 'ERR_MODULE_NOT_FOUND') {
			throw new Error('Compiled gateway files were not found. Run "pnpm run build" first.', {
				cause: error,
			});
		}
		throw error;
	}
}

async function generateSyntheticVault(vaultPath, options) {
	const directory = path.join(vaultPath, '30-Shared-Knowledge', 'Synthetic');
	await mkdir(directory, { recursive: true });
	const batchSize = 64;
	for (let offset = 0; offset < options.files; offset += batchSize) {
		const writes = [];
		const end = Math.min(options.files, offset + batchSize);
		for (let fileIndex = offset; fileIndex < end; fileIndex += 1) {
			const identifier = paddedIdentifier(fileIndex);
			const nextIdentifier = paddedIdentifier((fileIndex + 1) % options.files);
			writes.push(writeFile(
				path.join(directory, `Note-${identifier}.md`),
				ordinaryNote(identifier, nextIdentifier),
				'utf8',
			));
		}
		await Promise.all(writes);
	}

	if (options.longFileCharacters > 0) {
		await writeFile(
			path.join(directory, 'Long-Synthetic-Note.md'),
			longNote(options.longFileCharacters),
			'utf8',
		);
	}
}

function ordinaryNote(identifier, nextIdentifier) {
	return [
		'---',
		'type: knowledge-card',
		'status: active',
		'sensitivity: sanitized',
		'tags: [synthetic-benchmark, retrieval]',
		'---',
		'',
		`# Synthetic retrieval note ${identifier}`,
		'',
		`The deterministic lookup anchor is anchor${identifier}.`,
		'This generated note contains no user data and exists only inside a temporary benchmark Vault.',
		'',
		'## Retrieval design',
		'',
		'Bounded evidence packs preserve source spans while lexical ranking finds explicit query terms.',
		'Graph relationships may reorder supported evidence but must not invent an unsupported result.',
		'',
		'## Related synthetic note',
		'',
		`See [[Note-${nextIdentifier}]] for another deterministic fixture.`,
		'',
		'## Validation statement',
		'',
		`Validation code validation${identifier} is paired only with anchor${identifier}.`,
		'',
	].join('\n');
}

function longNote(requestedCharacters) {
	const prefix = [
		'---',
		'type: knowledge-card',
		'status: active',
		'sensitivity: sanitized',
		'tags: [synthetic-benchmark, long-document]',
		'---',
		'',
		'# Long synthetic retrieval note',
		'',
	].join('\n');
	const tail = [
		'',
		'## Tail evidence',
		'',
		'The unique long-document lookup anchor is longtailanchor.',
		'It verifies that retrieval reaches evidence near the end of a generated long Markdown file.',
		'',
	].join('\n');
	const filler = [
		'## Synthetic section',
		'',
		'Neutral benchmark material repeats predictable words about indexing, chunking, evidence, and retrieval.',
		'It is generated locally and contains no names, private facts, credentials, or imported text.',
		'',
	].join('\n');
	const targetFillerCharacters = Math.max(0, requestedCharacters - prefix.length - tail.length);
	const repeated = filler.repeat(Math.ceil(targetFillerCharacters / filler.length) || 1);
	return `${prefix}${repeated.slice(0, targetFillerCharacters)}${tail}`;
}

function buildQueryCases(options) {
	const cases = [];
	for (let queryIndex = 0; queryIndex < options.queries; queryIndex += 1) {
		if (queryIndex > 0 && queryIndex % 10 === 7) {
			cases.push({
				kind: 'common-terms-hit',
				query: 'retrieval evidence',
				expectedPath: null,
				expectEmpty: false,
				minimumResults: Math.min(8, options.files),
			});
			continue;
		}
		if (options.longFileCharacters > 0 && queryIndex > 0 && queryIndex % 10 === 8) {
			cases.push({
				kind: 'long-tail-hit',
				query: 'longtailanchor',
				expectedPath: '30-Shared-Knowledge/Synthetic/Long-Synthetic-Note.md',
				expectEmpty: false,
			});
			continue;
		}
		if (queryIndex > 0 && queryIndex % 10 === 9) {
			cases.push({
				kind: 'no-hit',
				query: `absentmarkerzz${paddedIdentifier(queryIndex)}`,
				expectedPath: null,
				expectEmpty: true,
			});
			continue;
		}
		const fileIndex = (queryIndex * 7) % options.files;
		const identifier = paddedIdentifier(fileIndex);
		cases.push({
			kind: 'ordinary-hit',
			query: `anchor${identifier}`,
			expectedPath: `30-Shared-Knowledge/Synthetic/Note-${identifier}.md`,
			expectEmpty: false,
		});
	}
	return cases;
}

async function timeSearch(index, queryCase) {
	const startedAt = performance.now();
	const matches = await index.search(queryCase.query, { limit: 8, mode: 'default' });
	const durationMs = performance.now() - startedAt;
	const paths = matches.map((match) => match.path);
	return {
		...queryCase,
		durationMs,
		resultCount: matches.length,
		valid: queryCase.expectEmpty
			? matches.length === 0
			: queryCase.expectedPath === null
				? matches.length >= (queryCase.minimumResults ?? 1)
				: paths.includes(queryCase.expectedPath),
		expectedAtTop: queryCase.expectedPath !== null && paths[0] === queryCase.expectedPath,
	};
}

function describeQueryMix(cases) {
	const counts = {};
	for (const queryCase of cases) counts[queryCase.kind] = (counts[queryCase.kind] ?? 0) + 1;
	return counts;
}

function summarize(values) {
	if (values.length === 0) {
		return { count: 0, p50: null, p95: null, p99: null, minimum: null, maximum: null };
	}
	const sorted = [...values].sort((first, second) => first - second);
	return {
		count: sorted.length,
		p50: roundMilliseconds(percentile(sorted, 50)),
		p95: roundMilliseconds(percentile(sorted, 95)),
		p99: roundMilliseconds(percentile(sorted, 99)),
		minimum: roundMilliseconds(sorted[0]),
		maximum: roundMilliseconds(sorted[sorted.length - 1]),
	};
}

function summarizeByKind(measurements) {
	const grouped = {};
	for (const measurement of measurements) {
		(grouped[measurement.kind] ??= []).push(measurement.durationMs);
	}
	return Object.fromEntries(
		Object.entries(grouped)
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([kind, durations]) => [kind, summarize(durations)]),
	);
}

function percentile(sortedValues, percentileValue) {
	if (sortedValues.length === 1) return sortedValues[0];
	const rank = (percentileValue / 100) * (sortedValues.length - 1);
	const lowerIndex = Math.floor(rank);
	const upperIndex = Math.ceil(rank);
	const lower = sortedValues[lowerIndex];
	const upper = sortedValues[upperIndex];
	if (lowerIndex === upperIndex) return lower;
	return lower + (upper - lower) * (rank - lowerIndex);
}

function countViolations(measurements) {
	return measurements.filter((measurement) => measurement.durationMs > FIVE_SECONDS_MS).length;
}

function summarizeValidation(measurements) {
	const failed = measurements.filter((measurement) => !measurement.valid);
	return {
		passed: measurements.length - failed.length,
		failed: failed.length,
		expectedResultAtTop: measurements.filter((measurement) => measurement.expectedAtTop).length,
		failedCases: failed.slice(0, 10).map((measurement) => ({
			kind: measurement.kind,
			query: measurement.query,
			expectedPath: measurement.expectedPath,
			minimumResults: measurement.minimumResults ?? null,
			resultCount: measurement.resultCount,
		})),
	};
}

function paddedIdentifier(value) {
	return String(value).padStart(6, '0');
}

function roundMilliseconds(value) {
	return Number(value.toFixed(3));
}

main().catch((error) => {
	const message = error instanceof Error ? error.stack ?? error.message : String(error);
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
});
