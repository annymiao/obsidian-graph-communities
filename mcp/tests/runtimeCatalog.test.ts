import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { canonicalJson, sha256 } from '../src/write/integrity.js';
import { compileConfiguredSources } from '../src/offlineCompile.js';
import {
	loadSecondBrainBuildConfiguration,
	publishSecondBrainRuntimeCatalog,
	readSecondBrainRuntimeCatalogChecksum,
	readSecondBrainRuntimeCatalogChecksumForConfiguration,
	readSecondBrainRuntimeCatalogSourceBindingChecksum,
	RuntimeCatalogConflictError,
	updateRuntimeCatalogGenerationPin,
	validateSecondBrainBuildArtifacts,
	type SecondBrainBuildConfiguration,
	type SecondBrainGenerationPin,
} from '../src/secondBrainBootstrap.js';

interface CatalogEnvelopeForTest {
	sha256: string;
	catalog: Record<string, unknown> & {
		deploymentConfigSha256: string;
		sources: Array<{
			sourceId: string;
			generationId: string;
			manifestSha256: string;
			label: string;
			writable?: { sourceRoot: string };
		}>;
	};
}

async function withCatalogFixture(
	run: (fixture: {
		root: string;
		configuration: SecondBrainBuildConfiguration;
	}) => Promise<void>,
): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'runtime-catalog-lock-'));
	try {
		const firstSource = path.join(root, 'first-source');
		const secondSource = path.join(root, 'second-source');
		const artifactRoot = path.join(root, 'artifacts');
		await mkdir(firstSource, { recursive: true });
		await mkdir(secondSource, { recursive: true });
		await writeFile(path.join(firstSource, 'first.md'), '# First\n\nalpha initial evidence.\n', 'utf8');
		await writeFile(path.join(secondSource, 'second.md'), '# Second\n\nbeta initial evidence.\n', 'utf8');
		const configuration = await loadSecondBrainBuildConfiguration({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([
				{
					id: 'synthetic:catalog-first',
					name: 'Catalog first',
					path: firstSource,
					kind: 'directory',
					writable: true,
				},
				{
					id: 'synthetic:catalog-second',
					name: 'Catalog second',
					path: secondSource,
					kind: 'directory',
					writable: true,
				},
			]),
			OBSIDIAN_ARTIFACT_PATH: artifactRoot,
			OBSIDIAN_PERSIST_INDEX: 'true',
			OBSIDIAN_EMBEDDING_DIMENSION: '32',
		});
		await run({ root, configuration });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function buildPins(
	configuration: SecondBrainBuildConfiguration,
): Promise<SecondBrainGenerationPin[]> {
	const pins: SecondBrainGenerationPin[] = [];
	for (const source of configuration.sources) {
		const result = await source.compiler.build();
		pins.push({
			sourceId: source.descriptor.sourceId,
			generationId: result.generation.generationId,
			manifestSha256: result.generation.manifestSha256,
		});
	}
	return pins;
}

async function readCatalog(configuration: SecondBrainBuildConfiguration): Promise<CatalogEnvelopeForTest> {
	return JSON.parse(await readFile(configuration.runtimeCatalogPath, 'utf8')) as CatalogEnvelopeForTest;
}

test('runtime catalog validates and publishes the exact build pins, not later CURRENT values', async () => {
	await withCatalogFixture(async ({ root, configuration }) => {
		const expectedChecksum = await readSecondBrainRuntimeCatalogChecksum(configuration.runtimeCatalogPath);
		assert.equal(expectedChecksum, null);
		const pins = await buildPins(configuration);
		await validateSecondBrainBuildArtifacts(configuration, pins);

		const first = configuration.sources[0];
		assert.ok(first);
		await writeFile(
			path.join(root, 'first-source', 'first.md'),
			'# First\n\nalpha later CURRENT marker.\n',
			'utf8',
		);
		const later = await first.compiler.build();
		assert.notEqual(later.generation.generationId, pins[0]?.generationId);

		await publishSecondBrainRuntimeCatalog(configuration, pins, expectedChecksum);
		const catalog = await readCatalog(configuration);
		assert.deepEqual(
			catalog.catalog.sources.map(({ sourceId, generationId, manifestSha256 }) => ({
				sourceId,
				generationId,
				manifestSha256,
			})),
			pins,
		);
		const unchangedCatalog = await readFile(configuration.runtimeCatalogPath, 'utf8');
		await publishSecondBrainRuntimeCatalog(
			configuration,
			pins,
			await readSecondBrainRuntimeCatalogChecksum(configuration.runtimeCatalogPath),
		);
		assert.equal(
			await readFile(configuration.runtimeCatalogPath, 'utf8'),
			unchangedCatalog,
			'an unchanged source set must not churn the runtime catalog',
		);
	});
});

test('runtime catalog CAS rejects a stale full publication and locked updates do not lose pins', async () => {
	await withCatalogFixture(async ({ root, configuration }) => {
		const pins = await buildPins(configuration);
		await validateSecondBrainBuildArtifacts(configuration, pins);
		await publishSecondBrainRuntimeCatalog(configuration, pins, null);
		const staleChecksum = await readSecondBrainRuntimeCatalogChecksum(configuration.runtimeCatalogPath);
		assert.ok(staleChecksum);
		await writeFile(
			path.join(root, 'first-source', 'first.md'),
			'# First\n\nalpha replacement evidence.\n',
			'utf8',
		);
		await writeFile(
			path.join(root, 'second-source', 'second.md'),
			'# Second\n\nbeta replacement evidence.\n',
			'utf8',
		);

		const replacements: SecondBrainGenerationPin[] = [];
		for (const source of configuration.sources) {
			const result = await source.compiler.build();
			replacements.push({
				sourceId: source.descriptor.sourceId,
				generationId: result.generation.generationId,
				manifestSha256: result.generation.manifestSha256,
			});
		}
		const bindingChecksums = new Map(await Promise.all(pins.map(async (pin) => [
			pin.sourceId,
			await readSecondBrainRuntimeCatalogSourceBindingChecksum(
				configuration.runtimeCatalogPath,
				pin.sourceId,
			),
		] as const)));
		await Promise.all(replacements.map((pin) => {
			const previous = pins.find((candidate) => candidate.sourceId === pin.sourceId);
			assert.ok(previous);
			return updateRuntimeCatalogGenerationPin(
				configuration.runtimeCatalogPath,
				pin.sourceId,
				pin.generationId,
				pin.manifestSha256,
				previous.generationId,
				previous.manifestSha256,
				bindingChecksums.get(pin.sourceId)!,
			);
		}));
		const updated = await readCatalog(configuration);
		assert.deepEqual(
			updated.catalog.sources.map(({ sourceId, generationId, manifestSha256 }) => ({
				sourceId,
				generationId,
				manifestSha256,
			})),
			replacements,
		);
		assert.equal(updated.sha256, await readSecondBrainRuntimeCatalogChecksum(configuration.runtimeCatalogPath));

		await assert.rejects(
			publishSecondBrainRuntimeCatalog(configuration, pins, staleChecksum),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_PINS_CHANGED');
				assert.equal(error.retryable, true);
				assert.match(error.message, /changed during offline compilation/u);
				return true;
			},
		);
		assert.deepEqual(await readCatalog(configuration), updated);

		updated.catalog.sources[0]!.label = 'Conflicting operator binding';
		updated.sha256 = sha256(canonicalJson(updated.catalog));
		await writeFile(configuration.runtimeCatalogPath, `${canonicalJson(updated)}\n`, 'utf8');
		await assert.rejects(
			publishSecondBrainRuntimeCatalog(configuration, replacements, staleChecksum),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_BINDING_CHANGED');
				assert.equal(error.retryable, false);
				assert.match(error.message, /owned by another deployment configuration/u);
				return true;
			},
		);
	});
});

test('runtime catalog binding remains owned across fresh watcher rounds', async () => {
	await withCatalogFixture(async ({ configuration }) => {
		const pins = await buildPins(configuration);
		await publishSecondBrainRuntimeCatalog(configuration, pins, null);
		const currentChecksum = await readSecondBrainRuntimeCatalogChecksum(
			configuration.runtimeCatalogPath,
		);
		assert.ok(currentChecksum);

		const firstSource = configuration.sources[0];
		assert.ok(firstSource);
		const conflictingConfiguration: SecondBrainBuildConfiguration = {
			...configuration,
			sources: [
				{
					...firstSource,
					descriptor: {
						...firstSource.descriptor,
						label: 'Different long-lived watcher binding',
					},
				},
				...configuration.sources.slice(1),
			],
		};
		await assert.rejects(
			publishSecondBrainRuntimeCatalog(conflictingConfiguration, pins, currentChecksum),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_BINDING_CHANGED');
				assert.equal(error.retryable, false);
				assert.match(error.message, /owned by another deployment configuration/u);
				return true;
			},
		);
		assert.equal(
			await readSecondBrainRuntimeCatalogChecksum(configuration.runtimeCatalogPath),
			currentChecksum,
			'a fresh checksum must not let another watcher replace the deployment binding',
		);
	});
});

test('deployment fingerprint fences hidden read-only roots and compiler policy before build', async () => {
	await withCatalogFixture(async ({ root, configuration }) => {
		const { writeStateRoot: _writeStateRoot, ...configurationWithoutWriteState } = configuration;
		const readOnlySources = configuration.sources.map((source) => {
			const { writable: _writable, ...readOnlyDescriptor } = source.descriptor;
			return {
				...source,
				config: { ...source.config, writable: false },
				descriptor: readOnlyDescriptor,
			};
		});
		const readOnlyConfiguration: SecondBrainBuildConfiguration = {
			...configurationWithoutWriteState,
			sources: readOnlySources,
		};
		const pins = await buildPins(readOnlyConfiguration);
		await publishSecondBrainRuntimeCatalog(readOnlyConfiguration, pins, null);
		const catalog = await readCatalog(readOnlyConfiguration);
		assert.match(catalog.catalog.deploymentConfigSha256, /^[a-f0-9]{64}$/u);
		assert.equal(
			JSON.stringify(catalog).includes(path.join(root, 'first-source')),
			false,
			'a read-only source root must remain represented only by its deployment digest',
		);

		const firstSource = readOnlySources[0];
		assert.ok(firstSource);
		const alternateRoot = path.join(root, 'alternate-read-only-source');
		await mkdir(alternateRoot);
		const rootChangedConfiguration: SecondBrainBuildConfiguration = {
			...readOnlyConfiguration,
			sources: [
				{
					...firstSource,
					config: { ...firstSource.config, vaultPath: alternateRoot },
				},
				...readOnlySources.slice(1),
			],
		};
		await assert.rejects(
			readSecondBrainRuntimeCatalogChecksumForConfiguration(rootChangedConfiguration),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_BINDING_CHANGED');
				assert.equal(error.retryable, false);
				return true;
			},
		);

		const policyChangedCompiler = Object.create(firstSource.compiler) as typeof firstSource.compiler;
		Object.defineProperty(policyChangedCompiler, 'policyHash', { value: 'a'.repeat(64) });
		const policyChangedConfiguration: SecondBrainBuildConfiguration = {
			...readOnlyConfiguration,
			sources: [
				{ ...firstSource, compiler: policyChangedCompiler },
				...readOnlySources.slice(1),
			],
		};
		await assert.rejects(
			readSecondBrainRuntimeCatalogChecksumForConfiguration(policyChangedConfiguration),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_BINDING_CHANGED');
				assert.equal(error.retryable, false);
				return true;
			},
		);
	});
});

test('configured compiler rejects another deployment before advancing physical CURRENT', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'runtime-catalog-preflight-'));
	try {
		const firstRoot = path.join(root, 'first-read-only-root');
		const secondRoot = path.join(root, 'second-read-only-root');
		const artifactRoot = path.join(root, 'artifacts');
		const catalogPath = path.join(root, 'runtime-catalog.json');
		await mkdir(firstRoot);
		await mkdir(secondRoot);
		await writeFile(path.join(firstRoot, 'note.md'), '# First\n\nfirst deployment evidence.\n', 'utf8');
		await writeFile(path.join(secondRoot, 'note.md'), '# Second\n\nsecond deployment evidence.\n', 'utf8');
		const environmentFor = (sourceRoot: string): NodeJS.ProcessEnv => ({
			OBSIDIAN_SOURCES_JSON: JSON.stringify([{
				id: 'synthetic:preflight-owner',
				name: 'Preflight owner',
				path: sourceRoot,
				kind: 'directory',
				writable: false,
			}]),
			OBSIDIAN_ARTIFACT_PATH: artifactRoot,
			OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: catalogPath,
			OBSIDIAN_PERSIST_INDEX: 'true',
			OBSIDIAN_EMBEDDING_DIMENSION: '32',
		});
		const firstEnvironment = environmentFor(firstRoot);
		await compileConfiguredSources(firstEnvironment);
		const firstConfiguration = await loadSecondBrainBuildConfiguration(firstEnvironment);
		const source = firstConfiguration.sources[0];
		assert.ok(source);
		const currentPath = path.join(source.descriptor.generationRoot, 'CURRENT');
		const catalogBefore = await readFile(catalogPath, 'utf8');
		const currentBefore = await readFile(currentPath, 'utf8');

		await assert.rejects(
			compileConfiguredSources(environmentFor(secondRoot)),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_BINDING_CHANGED');
				assert.equal(error.retryable, false);
				return true;
			},
		);
		assert.equal(await readFile(catalogPath, 'utf8'), catalogBefore);
		assert.equal(
			await readFile(currentPath, 'utf8'),
			currentBefore,
			'a deployment mismatch must fail before compiler.build advances CURRENT',
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test('runtime catalog v2 is rejected instead of being silently adopted', async () => {
	await withCatalogFixture(async ({ configuration }) => {
		const pins = await buildPins(configuration);
		await publishSecondBrainRuntimeCatalog(configuration, pins, null);
		const legacy = await readCatalog(configuration);
		const {
			deploymentConfigSha256: _deploymentConfigSha256,
			...legacyCatalog
		} = legacy.catalog;
		legacyCatalog.schemaVersion = 2;
		const legacyEnvelope = {
			catalog: legacyCatalog,
			sha256: sha256(canonicalJson(legacyCatalog)),
		};
		await writeFile(
			configuration.runtimeCatalogPath,
			`${canonicalJson(legacyEnvelope)}\n`,
			'utf8',
		);
		await assert.rejects(
			readSecondBrainRuntimeCatalogChecksumForConfiguration(configuration),
			/catalog header is invalid/u,
		);
	});
});

test('runtime catalog source CAS rejects a late publication that would roll a pin back', async () => {
	await withCatalogFixture(async ({ root, configuration }) => {
		const initialPins = await buildPins(configuration);
		await validateSecondBrainBuildArtifacts(configuration, initialPins);
		await publishSecondBrainRuntimeCatalog(configuration, initialPins, null);
		const source = configuration.sources[0];
		const initial = initialPins[0];
		assert.ok(source);
		assert.ok(initial);
		const sourceBindingChecksum = await readSecondBrainRuntimeCatalogSourceBindingChecksum(
			configuration.runtimeCatalogPath,
			initial.sourceId,
		);

		await writeFile(
			path.join(root, 'first-source', 'first.md'),
			'# First\n\nalpha earlier replacement evidence.\n',
			'utf8',
		);
		const earlierBuild = await source.compiler.build();
		await writeFile(
			path.join(root, 'first-source', 'first.md'),
			'# First\n\nalpha newest replacement evidence.\n',
			'utf8',
		);
		const newestBuild = await source.compiler.build();
		assert.notEqual(earlierBuild.generation.generationId, newestBuild.generation.generationId);

		await updateRuntimeCatalogGenerationPin(
			configuration.runtimeCatalogPath,
			initial.sourceId,
			newestBuild.generation.generationId,
			newestBuild.generation.manifestSha256,
			initial.generationId,
			initial.manifestSha256,
			sourceBindingChecksum,
		);
		const unchangedCatalog = await readFile(configuration.runtimeCatalogPath, 'utf8');
		const sentinel = new Date('2001-02-03T04:05:06.000Z');
		await utimes(configuration.runtimeCatalogPath, sentinel, sentinel);
		await updateRuntimeCatalogGenerationPin(
			configuration.runtimeCatalogPath,
			initial.sourceId,
			newestBuild.generation.generationId,
			newestBuild.generation.manifestSha256,
			initial.generationId,
			initial.manifestSha256,
			sourceBindingChecksum,
		);
		assert.equal(
			await readFile(configuration.runtimeCatalogPath, 'utf8'),
			unchangedCatalog,
			'an uncertain-success retry for the exact target pin must not churn the catalog',
		);
		assert.equal(
			(await stat(configuration.runtimeCatalogPath)).mtimeMs,
			sentinel.getTime(),
			'an idempotent exact-target retry must not rewrite the catalog file',
		);
		await assert.rejects(
			updateRuntimeCatalogGenerationPin(
				configuration.runtimeCatalogPath,
				initial.sourceId,
				earlierBuild.generation.generationId,
				earlierBuild.generation.manifestSha256,
				initial.generationId,
				initial.manifestSha256,
				sourceBindingChecksum,
			),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_SOURCE_PIN_CHANGED');
				assert.match(error.message, /source pin changed before publication/u);
				return true;
			},
		);
		const catalog = await readCatalog(configuration);
		assert.equal(catalog.catalog.sources[0]?.generationId, newestBuild.generation.generationId);
		assert.equal(catalog.catalog.sources[0]?.manifestSha256, newestBuild.generation.manifestSha256);
	});
});

test('runtime catalog source CAS rejects a stale writer after its source binding changes', async () => {
	await withCatalogFixture(async ({ root, configuration }) => {
		const pins = await buildPins(configuration);
		await validateSecondBrainBuildArtifacts(configuration, pins);
		await publishSecondBrainRuntimeCatalog(configuration, pins, null);
		const pin = pins[0];
		assert.ok(pin);
		const staleBindingChecksum = await readSecondBrainRuntimeCatalogSourceBindingChecksum(
			configuration.runtimeCatalogPath,
			pin.sourceId,
		);

		const replacementRoot = path.join(root, 'replacement-first-source');
		await mkdir(replacementRoot, { mode: 0o700 });
		const envelope = await readCatalog(configuration);
		const source = envelope.catalog.sources.find((candidate) => candidate.sourceId === pin.sourceId);
		assert.ok(source?.writable);
		source.writable.sourceRoot = replacementRoot;
		envelope.sha256 = sha256(canonicalJson(envelope.catalog));
		await writeFile(configuration.runtimeCatalogPath, `${canonicalJson(envelope)}\n`, 'utf8');

		await assert.rejects(
			updateRuntimeCatalogGenerationPin(
				configuration.runtimeCatalogPath,
				pin.sourceId,
				pin.generationId,
				pin.manifestSha256,
				pin.generationId,
				pin.manifestSha256,
				staleBindingChecksum,
			),
			(error: unknown) => {
				assert.ok(error instanceof RuntimeCatalogConflictError);
				assert.equal(error.code, 'RUNTIME_CATALOG_SOURCE_BINDING_CHANGED');
				assert.match(error.message, /source binding changed before publication/u);
				return true;
			},
		);
		assert.equal(
			(await readCatalog(configuration)).catalog.sources
				.find((candidate) => candidate.sourceId === pin.sourceId)?.writable?.sourceRoot,
			replacementRoot,
		);
	});
});

test('runtime catalog exact pin sets reject missing, duplicate, and malformed entries', async () => {
	await withCatalogFixture(async ({ configuration }) => {
		const pins = await buildPins(configuration);
		await assert.rejects(
			validateSecondBrainBuildArtifacts(configuration, pins.slice(1)),
			/exactly cover/u,
		);
		await assert.rejects(
			validateSecondBrainBuildArtifacts(configuration, [pins[0]!, pins[0]!]),
			/invalid, duplicated, or out of scope/u,
		);
		await assert.rejects(
			validateSecondBrainBuildArtifacts(configuration, [
				{ ...pins[0]!, manifestSha256: 'f'.repeat(63) },
				pins[1]!,
			]),
			/invalid, duplicated, or out of scope/u,
		);
	});
});
