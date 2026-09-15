import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

interface InstallFixture {
	root: string;
	source: string;
	install: string;
	skills: string;
	config: string;
	backup: string;
	runtimeEnvironment: string;
	catalog: string;
	codex: string;
	codexArguments: string;
}

async function createInstallFixture(): Promise<InstallFixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-install-test-'));
	const source = path.join(root, 'source-release');
	const install = path.join(root, 'installed-mcp');
	const skills = path.join(root, 'skills');
	const config = path.join(root, 'config.toml');
	const backup = path.join(root, 'config-before-install.toml');
	const privateRuntime = path.join(root, 'private-runtime');
	const catalog = path.join(privateRuntime, 'runtime-catalog.json');
	const runtimeEnvironment = path.join(privateRuntime, 'runtime-environment.json');
	const codex = path.join(root, 'fake-codex.sh');
	const codexArguments = path.join(root, 'codex-arguments.txt');
	await Promise.all([
		mkdir(path.join(source, 'dist', 'src'), { recursive: true }),
		mkdir(path.join(source, 'node_modules'), { recursive: true }),
		mkdir(path.join(source, 'skills', 'obsidian-knowledge'), { recursive: true }),
		mkdir(path.join(source, 'scripts'), { recursive: true }),
		mkdir(privateRuntime, { recursive: true }),
	]);
	await Promise.all([
		...[
			'secondBrainMcp.js',
			'secondBrainHttp.js',
			'offlineCompile.js',
			'index.js',
			'http.js',
		].map((name) => writeFile(path.join(source, 'dist', 'src', name), 'export {};\n')),
		writeFile(path.join(source, 'package.json'), JSON.stringify({
			name: 'obsidian-knowledge-gateway',
			version: '1.3.0',
			private: true,
			type: 'module',
			dependencies: {},
			bin: {
				'obsidian-knowledge-mcp': 'dist/src/secondBrainMcp.js',
				'obsidian-knowledge-gateway': 'dist/src/secondBrainHttp.js',
				'obsidian-second-brain-compile': 'dist/src/offlineCompile.js',
				'obsidian-knowledge-mcp-legacy': 'dist/src/index.js',
				'obsidian-knowledge-gateway-legacy': 'dist/src/http.js',
			},
			scripts: {
				start: 'node dist/src/secondBrainMcp.js',
				'start:http': 'node dist/src/secondBrainHttp.js',
			},
		}) + '\n'),
		writeFile(path.join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n"),
		writeFile(
			path.join(source, 'skills', 'obsidian-knowledge', 'SKILL.md'),
			'---\nname: obsidian-knowledge\n---\n# synthetic skill\n',
		),
		writeFile(path.join(source, 'scripts', 'smoke-client.mjs'), 'process.exit(0);\n'),
		writeFile(path.join(source, 'scripts', 'test.mjs'), 'process.exit(0);\n'),
		writeFile(path.join(source, 'scripts', 'upgrade-local.sh'), 'fixture upgrade helper\n'),
		writeFile(path.join(source, 'synthetic-note.md'), 'must not be installed\n'),
		writeFile(config, 'original = true\n'),
		writeFile(catalog, '{"synthetic":"compiled"}\n', { mode: 0o600 }),
		writeFile(runtimeEnvironment, JSON.stringify({
			OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: catalog,
			OBSIDIAN_EMBEDDING_PROVIDER: 'deterministic',
			OBSIDIAN_EMBEDDING_DIMENSION: '64',
			OBSIDIAN_RERANKER_PROVIDER: 'none',
			OBSIDIAN_PRINCIPAL_ID: 'synthetic-install',
			OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS: 'src_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			OBSIDIAN_PRINCIPAL_ALLOWED_MODES: 'default',
			OBSIDIAN_TRANSMISSION_REVIEW: 'required',
		}), { mode: 0o600 }),
		writeFile(codex, [
			'#!/bin/sh',
			'printf "%s\\n" "$@" >> "$FAKE_ARGS_PATH"',
			'printf "%s\\n" "mutated" > "$FAKE_CONFIG_PATH"',
			'if [ "${FAKE_FAIL_ADD:-0}" = "1" ]; then exit 9; fi',
			'exit 0',
		].join('\n')),
	]);
	await Promise.all([
		chmod(codex, 0o700),
		chmod(catalog, 0o600),
		chmod(runtimeEnvironment, 0o600),
	]);
	return {
		root,
		source,
		install,
		skills,
		config,
		backup,
		runtimeEnvironment,
		catalog,
		codex,
		codexArguments,
	};
}

async function runInstall(
	fixture: InstallFixture,
	failAdd = false,
): Promise<{ code: number | null; stderr: string }> {
	const script = path.join(process.cwd(), 'scripts', 'install-local.sh');
	const child = spawn('/bin/sh', [
		script,
		fixture.source,
		fixture.install,
		fixture.skills,
		fixture.runtimeEnvironment,
		fixture.codex,
		process.execPath,
		fixture.config,
		fixture.backup,
	], {
		env: {
			...process.env,
			FAKE_CONFIG_PATH: fixture.config,
			FAKE_ARGS_PATH: fixture.codexArguments,
			FAKE_FAIL_ADD: failAdd ? '1' : '0',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	return { code, stderr };
}

test('install registers only compiled runtime configuration and packages no source data', async (t) => {
	const fixture = await createInstallFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const result = await runInstall(fixture);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(await readFile(fixture.config, 'utf8'), 'mutated\n');
	assert.equal(await readFile(fixture.backup, 'utf8'), 'original = true\n');
	assert.equal((await stat(fixture.backup)).mode & 0o777, 0o600);
	assert.equal(
		await readFile(path.join(fixture.install, 'dist', 'src', 'secondBrainMcp.js'), 'utf8'),
		'export {};\n',
	);
	await assert.rejects(stat(path.join(fixture.install, 'synthetic-note.md')), /ENOENT/u);
	await assert.rejects(stat(path.join(fixture.install, 'runtime-environment.json')), /ENOENT/u);
	await assert.rejects(stat(path.join(fixture.install, 'runtime-catalog.json')), /ENOENT/u);
	const argumentsText = await readFile(fixture.codexArguments, 'utf8');
	assert.match(argumentsText, /OBSIDIAN_SECOND_BRAIN_CATALOG_PATH=/u);
	assert.match(argumentsText, /OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS=/u);
	assert.match(argumentsText, /OBSIDIAN_TRANSMISSION_REVIEW=required/u);
	assert.match(argumentsText, /dist\/src\/secondBrainMcp\.js/u);
	assert.equal(argumentsText.includes('OBSIDIAN_VAULT_PATH'), false);
	assert.equal(argumentsText.includes('dist/src/index.js'), false);
});

test('failed initial registration restores config and removes staged installation', async (t) => {
	const fixture = await createInstallFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const result = await runInstall(fixture, true);
	assert.notEqual(result.code, 0);
	assert.equal(await readFile(fixture.config, 'utf8'), 'original = true\n');
	assert.equal(await readFile(fixture.backup, 'utf8'), 'original = true\n');
	await assert.rejects(stat(fixture.install), /ENOENT/u);
	await assert.rejects(stat(path.join(fixture.skills, 'obsidian-knowledge')), /ENOENT/u);
	await assert.rejects(stat(`${fixture.install}.install.lock`), /ENOENT/u);
});

test('a legacy Vault-directory argument fails before any install mutation', async (t) => {
	const fixture = await createInstallFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const legacyVault = path.join(fixture.root, 'legacy-vault');
	await mkdir(legacyVault);
	fixture.runtimeEnvironment = legacyVault;
	const result = await runInstall(fixture);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /v1\.3 default never starts from a Vault path/u);
	assert.match(result.stderr, /offlineCompile\.js --once/u);
	assert.equal(await readFile(fixture.config, 'utf8'), 'original = true\n');
	await assert.rejects(stat(fixture.install), /ENOENT/u);
	await assert.rejects(stat(fixture.backup), /ENOENT/u);
});
