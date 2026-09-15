import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	GENERATION_STORE_SCHEMA_VERSION,
	GenerationStore,
	GenerationStoreCorruptionError,
	GenerationStoreError,
} from '../src/generationStore.js';

async function createStoreRoot(): Promise<string> {
	return mkdtemp(path.join(tmpdir(), 'generation-store-test-'));
}

async function withStoreRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await createStoreRoot();
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('publishes a Buffer only after a checksummed READY generation exists', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		assert.equal(await store.readCurrent(), null);

		const source = Buffer.from([0, 1, 2, 3, 255]);
		const manifest = await store.publish(source);
		assert.equal(manifest.schemaVersion, GENERATION_STORE_SCHEMA_VERSION);
		assert.equal(manifest.parentGenerationId, null);
		assert.equal(manifest.payload.kind, 'buffer');
		assert.equal(manifest.payload.byteLength, source.byteLength);
		assert.equal(
			manifest.payload.sha256,
			createHash('sha256').update(source).digest('hex'),
		);

		const generationPath = path.join(root, 'generations', manifest.generationId);
		assert.equal((await lstat(generationPath)).isDirectory(), true);
		assert.equal((await lstat(path.join(generationPath, 'READY'))).isFile(), true);
		const manifestBytes = await readFile(path.join(generationPath, 'manifest.json'));
		const ready = JSON.parse(await readFile(path.join(generationPath, 'READY'), 'utf8')) as {
			manifestSha256: string;
		};
		assert.equal(
			ready.manifestSha256,
			createHash('sha256').update(manifestBytes).digest('hex'),
		);

		const current = await store.readCurrent();
		assert.ok(current);
		assert.equal(current.manifest.generationId, manifest.generationId);
		assert.ok(Buffer.isBuffer(current.payload));
		assert.deepEqual(current.payload, source);
	});
});

test('retains the previous JSON generation and rollback atomically switches CURRENT', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const firstPayload = { version: 1, nested: ['alpha', true, null] };
		const secondPayload = { version: 2, nested: ['beta', false, null] };
		const first = await store.publish(firstPayload);
		const second = await store.publish(secondPayload);

		assert.equal(second.parentGenerationId, first.generationId);
		assert.deepEqual((await store.readCurrent())?.payload, secondPayload);
		assert.deepEqual((await store.readGeneration(first.generationId)).payload, firstPayload);

		const rolledBack = await store.rollback();
		assert.equal(rolledBack.manifest.generationId, first.generationId);
		assert.deepEqual(rolledBack.payload, firstPayload);
		assert.equal((await store.readCurrent())?.manifest.generationId, first.generationId);

		// A healthy rollback keeps the replaced generation as the next previous,
		// allowing a second rollback to act as an explicit redo.
		const redone = await store.rollback();
		assert.equal(redone.manifest.generationId, second.generationId);
		assert.deepEqual(redone.payload, secondPayload);
	});
});

test('prunes only generations no longer referenced by CURRENT or PREVIOUS', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const first = await store.publish({ version: 1 });
		const second = await store.publish({ version: 2 });
		const third = await store.publish({ version: 3 });

		assert.deepEqual(await store.pruneUnreferenced(), [first.generationId]);
		assert.deepEqual(
			(await readdir(path.join(root, 'generations'))).sort(),
			[second.generationId, third.generationId].sort(),
		);
		await assert.rejects(store.readGeneration(first.generationId), /ENOENT/u);
		assert.equal((await store.rollback()).manifest.generationId, second.generationId);
	});
});

test('current-only publication removes the recovery anchor and purges superseded content', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const first = await store.publish({ withdrawn: 'old-private-derived-text' });
		const second = await store.publish({ current: 'safe' }, { retainPrevious: false });

		assert.equal(second.parentGenerationId, first.generationId);
		await assert.rejects(readFile(path.join(root, 'PREVIOUS')), /ENOENT/u);
		assert.deepEqual(await store.pruneUnreferenced(), [first.generationId]);
		await assert.rejects(store.readGeneration(first.generationId), /ENOENT/u);
		await assert.rejects(store.rollback(), /No previous generation/u);
		assert.deepEqual((await store.readCurrent())?.payload, { current: 'safe' });
	});
});

test('quarantines an unverifiable CURRENT before an authoritative replacement', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const damaged = await store.publish({ version: 'damaged' });
		await rm(path.join(root, 'generations', damaged.generationId), {
			recursive: true,
			force: true,
		});

		assert.equal(await store.quarantineCorruptState(), true);
		const replacement = await store.publish(
			{ version: 'authoritative-rebuild' },
			{ retainPrevious: false },
		);
		assert.equal((await store.readCurrent())?.manifest.generationId, replacement.generationId);
		assert.equal(await store.quarantineCorruptState(), false);
	});
});

test('refuses rollback when a valid CURRENT has no predecessor', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const first = await store.publish({ version: 1 });
		await assert.rejects(store.rollback(), /No previous generation/);
		assert.equal((await store.readCurrent())?.manifest.generationId, first.generationId);
	});
});

test('serializes concurrent publishers without exposing a partial generation', async () => {
	await withStoreRoot(async (root) => {
		const stores = Array.from({ length: 6 }, () => new GenerationStore(root));
		const manifests = await Promise.all(
			stores.map((store, index) => store.publish({ concurrentVersion: index })),
		);
		assert.equal(new Set(manifests.map((manifest) => manifest.generationId)).size, 6);
		const current = await stores[0]?.readCurrent();
		assert.ok(current);
		assert.equal(typeof (current.payload as { concurrentVersion: unknown }).concurrentVersion, 'number');
		for (const manifest of manifests) {
			assert.ok(await stores[0]?.readGeneration(manifest.generationId));
		}
	});
});

test('ignores incomplete staging and temporary pointer files after a simulated crash', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const published = await store.publish({ stable: true });
		const abandoned = path.join(root, '.staging', 'gen-0000000000000-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
		await mkdir(abandoned);
		await writeFile(path.join(abandoned, 'payload.json'), '{"stable":false}', 'utf8');
		await writeFile(path.join(root, '.CURRENT.crash.tmp'), '{', 'utf8');

		const reopened = new GenerationStore(root);
		const current = await reopened.readCurrent();
		assert.equal(current?.manifest.generationId, published.generationId);
		assert.deepEqual(current?.payload, { stable: true });
	});
});

test('refuses a corrupt current payload but can recover the verified previous generation', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const first = await store.publish({ version: 1 });
		const second = await store.publish({ version: 2 });
		await writeFile(
			path.join(root, 'generations', second.generationId, 'payload.json'),
			'{"version":999}',
			'utf8',
		);

		await assert.rejects(store.readCurrent(), GenerationStoreCorruptionError);
		const recovered = await store.rollback();
		assert.equal(recovered.manifest.generationId, first.generationId);
		assert.deepEqual((await store.readCurrent())?.payload, { version: 1 });
	});
});

test('refuses malformed CURRENT instead of silently falling back, while explicit rollback can recover', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const first = await store.publish({ version: 1 });
		await store.publish({ version: 2 });
		await writeFile(path.join(root, 'CURRENT'), '{not-json', 'utf8');

		await assert.rejects(store.readCurrent(), GenerationStoreCorruptionError);
		const recovered = await store.rollback();
		assert.equal(recovered.manifest.generationId, first.generationId);
	});
});

test('recovery keeps the verified PREVIOUS anchor until CURRENT is valid again', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		await store.publish({ version: 1 });
		const second = await store.publish({ version: 2 });
		await store.publish({ version: 3 });
		const previousBefore = await readFile(path.join(root, 'PREVIOUS'));
		await writeFile(path.join(root, 'CURRENT'), '{not-json', 'utf8');

		const recovered = await store.rollback();
		assert.equal(recovered.manifest.generationId, second.generationId);
		assert.deepEqual(await readFile(path.join(root, 'PREVIOUS')), previousBefore);
		assert.equal((await store.readCurrent())?.manifest.generationId, second.generationId);
	});
});

test('a crash immediately before recovery CURRENT switch preserves PREVIOUS', async () => {
	class CrashBeforeRecoverySwitchStore extends GenerationStore {
		protected override async beforeRecoveryCurrentSwitch(): Promise<void> {
			throw new Error('simulated process stop before CURRENT switch');
		}
	}

	await withStoreRoot(async (root) => {
		const publisher = new GenerationStore(root);
		await publisher.publish({ version: 1 });
		const second = await publisher.publish({ version: 2 });
		await publisher.publish({ version: 3 });
		const previousBefore = await readFile(path.join(root, 'PREVIOUS'));
		await writeFile(path.join(root, 'CURRENT'), '{not-json', 'utf8');

		const crashingRecovery = new CrashBeforeRecoverySwitchStore(root);
		await assert.rejects(
			crashingRecovery.rollback(),
			/simulated process stop/u,
		);
		assert.deepEqual(await readFile(path.join(root, 'PREVIOUS')), previousBefore);
		assert.equal(await readFile(path.join(root, 'CURRENT'), 'utf8'), '{not-json');

		const reopened = new GenerationStore(root);
		const recovered = await reopened.rollback();
		assert.equal(recovered.manifest.generationId, second.generationId);
	});
});

test('refuses manifest and READY corruption', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const manifest = await store.publish(Buffer.from('trusted'));
		const generationPath = path.join(root, 'generations', manifest.generationId);
		await writeFile(path.join(generationPath, 'manifest.json'), '{}\n', 'utf8');
		await assert.rejects(store.readCurrent(), /manifest checksum mismatch/i);
	});

	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const manifest = await store.publish(Buffer.from('trusted'));
		const readyPath = path.join(root, 'generations', manifest.generationId, 'READY');
		await writeFile(readyPath, '{}\n', 'utf8');
		await assert.rejects(store.readCurrent(), /READY marker schema is invalid/i);
	});
});

test('rejects generation id traversal before accessing the filesystem', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		await assert.rejects(store.readGeneration('../outside'), GenerationStoreError);
		await assert.rejects(store.readGeneration('..\\outside'), GenerationStoreError);
	});
});

test('rejects a symlinked generation directory and never reads its target', async (context) => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const manifest = await store.publish({ secret: 'inside' });
		const generationPath = path.join(root, 'generations', manifest.generationId);
		const displacedPath = `${generationPath}.displaced`;
		await rename(generationPath, displacedPath);
		try {
			await symlink(displacedPath, generationPath, 'dir');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				context.skip('Creating symlinks is not permitted on this platform.');
				return;
			}
			throw error;
		}
		await assert.rejects(store.readCurrent(), /real directory/i);
	});
});

test('rejects a symlink used as the configured store root', async (context) => {
	const parent = await createStoreRoot();
	try {
		const realRoot = path.join(parent, 'real');
		const linkedRoot = path.join(parent, 'linked');
		await mkdir(realRoot);
		try {
			await symlink(realRoot, linkedRoot, 'dir');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				context.skip('Creating symlinks is not permitted on this platform.');
				return;
			}
			throw error;
		}
		const store = new GenerationStore(linkedRoot);
		await assert.rejects(store.initialize(), /root must be a real directory/i);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('rejects a POSIX store root accessible to group or other users', async (context) => {
	if (process.platform === 'win32') {
		context.skip('POSIX permission bits are not authoritative on Windows.');
		return;
	}
	await withStoreRoot(async (root) => {
		await chmod(root, 0o750);
		const store = new GenerationStore(root);
		await assert.rejects(
			store.initialize(),
			/must not grant group or other filesystem permissions/u,
		);
		await chmod(root, 0o700);
	});
});

test('rejects non-JSON values and configured payload overflows', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root, { maxPayloadBytes: 4 });
		await assert.rejects(store.publish(Buffer.from('12345')), /maxPayloadBytes/);
		await assert.rejects(
			store.publish({ bad: Number.NaN } as unknown as never),
			/only JSON values/,
		);
		await assert.rejects(
			store.publish({ nested: [{ bad: Number.POSITIVE_INFINITY }] } as unknown as never),
			/only JSON values/,
		);
		await assert.rejects(
			store.publish({ nested: new Date() } as unknown as never),
			/plain objects/,
		);
	});
});

test('detects managed-directory replacement after initialization', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		await store.initialize();
		const generations = path.join(root, 'generations');
		await rename(generations, `${generations}.displaced`);
		await mkdir(generations, { mode: 0o700 });
		await assert.rejects(
			store.readCurrent(),
			/generations changed after initialization/u,
		);
	});
});

test('detects an ancestor replaced by a symlink before returning data', async (context) => {
	const parent = await createStoreRoot();
	try {
		const container = path.join(parent, 'container');
		const root = path.join(container, 'store');
		await mkdir(container, { mode: 0o700 });
		await mkdir(root, { mode: 0o700 });
		const store = new GenerationStore(root);
		await store.publish({ safe: true });

		const displaced = path.join(parent, 'container-displaced');
		const attacker = path.join(parent, 'attacker');
		await rename(container, displaced);
		await mkdir(attacker, { mode: 0o700 });
		await mkdir(path.join(attacker, 'store'), { mode: 0o700 });
		await mkdir(path.join(attacker, 'store', 'generations'), { mode: 0o700 });
		await mkdir(path.join(attacker, 'store', '.staging'), { mode: 0o700 });
		try {
			await symlink(attacker, container, 'dir');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EPERM') {
				context.skip('Creating symlinks is not permitted on this platform.');
				return;
			}
			throw error;
		}

		await assert.rejects(
			store.readCurrent(),
			/changed after initialization|unexpected symlink/u,
		);
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
});

test('rejects a checksummed JSON payload that decodes outside JsonValue', async () => {
	await withStoreRoot(async (root) => {
		const store = new GenerationStore(root);
		const published = await store.publish({ finite: true });
		const generationPath = path.join(root, 'generations', published.generationId);
		const payloadBytes = Buffer.from('1e400', 'utf8');
		await writeFile(path.join(generationPath, 'payload.json'), payloadBytes);

		const manifest = JSON.parse(
			await readFile(path.join(generationPath, 'manifest.json'), 'utf8'),
		) as {
			payload: { byteLength: number; sha256: string };
		};
		manifest.payload.byteLength = payloadBytes.byteLength;
		manifest.payload.sha256 = createHash('sha256').update(payloadBytes).digest('hex');
		const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		await writeFile(path.join(generationPath, 'manifest.json'), manifestBytes);

		const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
		const ready = JSON.parse(
			await readFile(path.join(generationPath, 'READY'), 'utf8'),
		) as { manifestSha256: string };
		ready.manifestSha256 = manifestSha256;
		await writeFile(
			path.join(generationPath, 'READY'),
			`${JSON.stringify(ready, null, 2)}\n`,
			'utf8',
		);

		const current = JSON.parse(await readFile(path.join(root, 'CURRENT'), 'utf8')) as {
			manifestSha256: string;
		};
		current.manifestSha256 = manifestSha256;
		await writeFile(path.join(root, 'CURRENT'), `${JSON.stringify(current, null, 2)}\n`, 'utf8');

		await assert.rejects(store.readCurrent(), /JSON payload is invalid/i);
	});
});

test('rejects a filesystem root as the store path', () => {
	assert.throws(
		() => new GenerationStore(path.parse(process.cwd()).root),
		/filesystem root/i,
	);
});
