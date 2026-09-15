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

interface UpgradeFixture {
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

async function createUpgradeFixture(): Promise<UpgradeFixture> {
	const root = await mkdtemp(path.join(tmpdir(), 'obsidian-upgrade-test-'));
	const source = path.join(root, 'source');
	const install = path.join(root, 'installed-mcp');
	const skills = path.join(root, 'skills');
	const skill = path.join(skills, 'obsidian-knowledge');
	const config = path.join(root, 'config.toml');
	const backup = path.join(root, 'backup');
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
		mkdir(path.join(source, 'synthetic-derived-index'), { recursive: true }),
		mkdir(install, { recursive: true }),
		mkdir(skill, { recursive: true }),
		mkdir(privateRuntime, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			path.join(source, 'dist', 'src', 'index.js'),
			"export const KNOWLEDGE_SERVICE_VERSION = '1.3.0';\n",
		),
		writeFile(
			path.join(source, 'dist', 'src', 'http.js'),
			"export const HTTP_SERVICE_VERSION = '1.3.0';\n",
		),
		writeFile(
			path.join(source, 'dist', 'src', 'secondBrainMcp.js'),
			"export const SECOND_BRAIN_MCP_VERSION = '1.3.0';\n",
		),
		writeFile(
			path.join(source, 'dist', 'src', 'secondBrainHttp.js'),
			"export const SECOND_BRAIN_HTTP_VERSION = '1.3.0';\n",
		),
		writeFile(
			path.join(source, 'dist', 'src', 'offlineCompile.js'),
			"export const SECOND_BRAIN_COMPILE_VERSION = '1.3.0';\n",
		),
		writeFile(
			path.join(source, 'package.json'),
			JSON.stringify({
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
			}) + '\n',
		),
		writeFile(path.join(source, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n"),
		writeFile(
			path.join(source, 'skills', 'obsidian-knowledge', 'SKILL.md'),
			'---\nname: obsidian-knowledge\n---\n# new skill\n',
		),
		writeFile(path.join(source, 'dist', '._index.js'), 'metadata\n'),
		writeFile(path.join(source, 'node_modules', '._modules'), 'metadata\n'),
		writeFile(path.join(source, 'skills', 'obsidian-knowledge', '._SKILL.md'), 'metadata\n'),
		writeFile(path.join(source, 'synthetic-vault-note.md'), 'synthetic private body\n'),
		writeFile(
			path.join(source, 'synthetic-derived-index', 'payload.json'),
			'{"synthetic":true}\n',
		),
		writeFile(path.join(source, 'scripts', 'smoke-client.mjs'), 'process.exit(0);\n'),
		writeFile(path.join(source, 'scripts', 'test.mjs'), 'process.exit(0);\n'),
		writeFile(path.join(source, 'scripts', 'upgrade-local.sh'), 'fixture upgrade helper\n'),
		writeFile(path.join(install, 'old.txt'), 'old install\n'),
		writeFile(
			path.join(install, 'package.json'),
			'{"name":"obsidian-knowledge-gateway","version":"0.6.0"}\n',
		),
		writeFile(
			path.join(skill, 'SKILL.md'),
			'---\nname: obsidian-knowledge\n---\n# old skill\n',
		),
		writeFile(config, 'old-config = true\n'),
		writeFile(catalog, '{"synthetic":"compiled-catalog"}\n', { mode: 0o600 }),
		writeFile(runtimeEnvironment, JSON.stringify({
			OBSIDIAN_SECOND_BRAIN_CATALOG_PATH: catalog,
			OBSIDIAN_EMBEDDING_PROVIDER: 'deterministic',
			OBSIDIAN_EMBEDDING_DIMENSION: '64',
			OBSIDIAN_RERANKER_PROVIDER: 'none',
			OBSIDIAN_PRINCIPAL_ID: 'synthetic-upgrade',
			OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS: 'src_v1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			OBSIDIAN_PRINCIPAL_ALLOWED_MODES: 'default,reference',
			OBSIDIAN_TRANSMISSION_REVIEW: 'required',
		}), { mode: 0o600 }),
		writeFile(codex, [
			'#!/bin/sh',
			'printf "%s\\n" "$@" >> "$FAKE_ARGS_PATH"',
			'if [ "$2" = "remove" ]; then',
			'  printf "%s\\n" "removed" > "$FAKE_CONFIG_PATH"',
			'  exit 0',
			'fi',
			'if [ "$2" = "add" ]; then',
			'  printf "%s\\n" "mutated-before-add" > "$FAKE_CONFIG_PATH"',
			'  if [ "${FAKE_FAIL_ADD:-0}" = "1" ]; then exit 9; fi',
			'  printf "%s\\n" "added" > "$FAKE_CONFIG_PATH"',
			'  exit 0',
			'fi',
			'exit 2',
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

async function runUpgrade(
	fixture: UpgradeFixture,
	failAdd: boolean,
): Promise<{ code: number | null; stderr: string }> {
	const script = path.join(process.cwd(), 'scripts', 'upgrade-local.sh');
	const child = spawn('/bin/sh', [
		script,
		fixture.source,
		fixture.install,
		fixture.skills,
		fixture.codex,
		process.execPath,
		fixture.config,
		fixture.backup,
		fixture.runtimeEnvironment,
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

test('upgrade stages, backs up, then switches service, Skill, and config', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const result = await runUpgrade(fixture, false);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(JSON.parse(await readFile(path.join(fixture.install, 'package.json'), 'utf8')).version, '1.3.0');
	assert.equal(
		await readFile(path.join(fixture.install, 'scripts', 'test.mjs'), 'utf8'),
		'process.exit(0);\n',
	);
	assert.equal(
		await readFile(path.join(fixture.install, 'scripts', 'smoke-client.mjs'), 'utf8'),
		'process.exit(0);\n',
	);
	assert.equal(
		await readFile(path.join(fixture.install, 'scripts', 'upgrade-local.sh'), 'utf8'),
		'fixture upgrade helper\n',
	);
	assert.equal(
		await readFile(path.join(fixture.skills, 'obsidian-knowledge', 'SKILL.md'), 'utf8'),
		'---\nname: obsidian-knowledge\n---\n# new skill\n',
	);
	assert.equal(await readFile(fixture.config, 'utf8'), 'added\n');
	assert.equal(await readFile(path.join(fixture.backup, 'install', 'old.txt'), 'utf8'), 'old install\n');
	assert.equal(
		await readFile(path.join(fixture.backup, 'skill', 'SKILL.md'), 'utf8'),
		'---\nname: obsidian-knowledge\n---\n# old skill\n',
	);
	await assert.rejects(stat(path.join(fixture.install, 'dist', '._index.js')), /ENOENT/u);
	await assert.rejects(stat(path.join(fixture.install, 'node_modules', '._modules')), /ENOENT/u);
	await assert.rejects(
		stat(path.join(fixture.skills, 'obsidian-knowledge', '._SKILL.md')),
		/ENOENT/u,
	);
	await assert.rejects(stat(path.join(fixture.install, 'synthetic-vault-note.md')), /ENOENT/u);
	await assert.rejects(stat(path.join(fixture.install, 'synthetic-derived-index')), /ENOENT/u);
	assert.equal(await readFile(path.join(fixture.backup, 'config.toml'), 'utf8'), 'old-config = true\n');
	assert.match(
		await readFile(path.join(fixture.backup, 'BACKUP_READY'), 'utf8'),
		/obsidian-knowledge-mcp-v2/u,
	);
	assert.equal((await stat(path.join(fixture.backup, 'config.toml')).then((item) => item.mode)) & 0o777, 0o600);
	const registeredArguments = await readFile(fixture.codexArguments, 'utf8');
	assert.match(registeredArguments, /OBSIDIAN_SECOND_BRAIN_CATALOG_PATH=/u);
	assert.match(registeredArguments, /OBSIDIAN_EMBEDDING_PROVIDER=deterministic/u);
	assert.match(registeredArguments, /OBSIDIAN_PRINCIPAL_ALLOWED_SOURCE_IDS=/u);
	assert.match(registeredArguments, /OBSIDIAN_TRANSMISSION_REVIEW=required/u);
	assert.match(registeredArguments, /dist\/src\/secondBrainMcp\.js/u);
	assert.equal(registeredArguments.includes('OBSIDIAN_VAULT_PATH'), false);
});

test('failed config registration restores old service, Skill, and config', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const result = await runUpgrade(fixture, true);
	assert.notEqual(result.code, 0);
	assert.equal(await readFile(path.join(fixture.install, 'old.txt'), 'utf8'), 'old install\n');
	assert.equal(
		await readFile(path.join(fixture.skills, 'obsidian-knowledge', 'SKILL.md'), 'utf8'),
		'---\nname: obsidian-knowledge\n---\n# old skill\n',
	);
	assert.equal(await readFile(fixture.config, 'utf8'), 'old-config = true\n');
	assert.match(await readFile(path.join(fixture.backup, 'BACKUP_READY'), 'utf8'), /backup_format/u);
	await assert.rejects(stat(`${fixture.install}.upgrade.lock`), /ENOENT/u);
});

test('overlapping backup layout fails before any installed target is moved', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	fixture.backup = path.join(fixture.install, 'nested-backup');

	const result = await runUpgrade(fixture, false);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /must not overlap/u);
	assert.equal(await readFile(path.join(fixture.install, 'old.txt'), 'utf8'), 'old install\n');
	await assert.rejects(stat(fixture.backup), /ENOENT/u);
	await assert.rejects(stat(`${fixture.install}.upgrade.lock`), /ENOENT/u);
});

test('missing compiled catalog fails before backup, install, or config mutation', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await rm(fixture.catalog);

	const result = await runUpgrade(fixture, false);
	assert.notEqual(result.code, 0);
	assert.equal(await readFile(path.join(fixture.install, 'old.txt'), 'utf8'), 'old install\n');
	assert.equal(await readFile(fixture.config, 'utf8'), 'old-config = true\n');
	await assert.rejects(stat(fixture.backup), /ENOENT/u);
	await assert.rejects(stat(`${fixture.install}.upgrade.lock`), /ENOENT/u);
});

test('an unmarked install directory is never treated as a replaceable MCP target', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	await writeFile(
		path.join(fixture.install, 'package.json'),
		'{"name":"unrelated-directory","version":"1.0.0"}\n',
	);

	const result = await runUpgrade(fixture, false);
	assert.notEqual(result.code, 0);
	assert.match(result.stderr, /not the expected MCP package/u);
	assert.equal(await readFile(path.join(fixture.install, 'old.txt'), 'utf8'), 'old install\n');
	await assert.rejects(stat(fixture.backup), /ENOENT/u);
	await assert.rejects(stat(`${fixture.install}.upgrade.lock`), /ENOENT/u);
});

test('trailing directory slashes still create sibling stages and upgrade safely', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	fixture.install = `${fixture.install}/`;
	fixture.skills = `${fixture.skills}/`;

	const result = await runUpgrade(fixture, false);
	assert.equal(result.code, 0, result.stderr);
	assert.equal(
		JSON.parse(await readFile(path.join(fixture.install, 'package.json'), 'utf8')).version,
		'1.3.0',
	);
	assert.equal(await readFile(path.join(fixture.backup, 'install', 'old.txt'), 'utf8'), 'old install\n');
});

test('legacy request-time upgrade arguments fail closed with compile migration guidance', async (t) => {
	const fixture = await createUpgradeFixture();
	t.after(() => rm(fixture.root, { recursive: true, force: true }));
	const script = path.join(process.cwd(), 'scripts', 'upgrade-local.sh');
	const child = spawn('/bin/sh', [
		script,
		fixture.source,
		fixture.install,
		fixture.skills,
		fixture.codex,
		process.execPath,
		fixture.config,
		fixture.backup,
		'OBSIDIAN_VAULT_PATH',
		fixture.root,
		'trusted-local',
	], { stdio: ['ignore', 'ignore', 'pipe'] });
	let stderr = '';
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk: string) => {
		stderr += chunk;
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	assert.equal(code, 2);
	assert.match(stderr, /Legacy Vault\/request-time arguments are not accepted/u);
	assert.match(stderr, /offlineCompile\.js --once/u);
	assert.equal(await readFile(path.join(fixture.install, 'old.txt'), 'utf8'), 'old install\n');
	assert.equal(await readFile(fixture.config, 'utf8'), 'old-config = true\n');
	await assert.rejects(stat(fixture.backup), /ENOENT/u);
});
