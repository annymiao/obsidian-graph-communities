import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	rmdir,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
	classifyPrivateDirectoryLockInstance,
	PrivateDirectoryLockBusyError,
	PrivateDirectoryLockReleaseError,
	withPrivateDirectoryLock,
} from '../src/persistence/privateDirectoryLock.js';

async function withTemporaryRoot(run: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(tmpdir(), 'private-directory-lock-'));
	let runError: unknown;
	try {
		await run(root);
	} catch (error) {
		runError = error;
	}
	try {
		await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
	} catch (cleanupError) {
		if (runError !== undefined) {
			throw new AggregateError([runError, cleanupError], 'Test and temporary-root cleanup both failed.');
		}
		throw cleanupError;
	}
	if (runError !== undefined) throw runError;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((accept) => {
		resolve = accept;
	});
	return { promise, resolve };
}

async function writeOwner(lockPath: string, pid: number, token = 'a'.repeat(32)): Promise<void> {
	await mkdir(lockPath, { mode: 0o700 });
	await writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
		schemaVersion: 1,
		pid,
		token,
		createdAt: new Date().toISOString(),
	})}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function exitedChildPid(): Promise<number> {
	const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
	const pid = child.pid;
	assert.ok(pid);
	await new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', () => resolve());
	});
	return pid;
}

test('private directory lock classification resists same-inode ABA reuse', () => {
	const expectedIdentity = { dev: 7, ino: 11 };
	const expectedOwner = {
		schemaVersion: 1 as const,
		pid: 101,
		token: 'a'.repeat(32),
		createdAt: '2026-01-01T00:00:00.000Z',
	};
	const successorOwner = {
		schemaVersion: 1 as const,
		pid: 102,
		token: 'b'.repeat(32),
		createdAt: '2026-01-01T00:00:01.000Z',
	};
	assert.equal(classifyPrivateDirectoryLockInstance(
		expectedIdentity,
		expectedOwner,
		expectedIdentity,
		expectedOwner,
	), 'original');
	assert.equal(classifyPrivateDirectoryLockInstance(
		expectedIdentity,
		expectedOwner,
		expectedIdentity,
		successorOwner,
	), 'successor', 'a new owner token wins even when Linux reuses the directory inode');
	assert.equal(classifyPrivateDirectoryLockInstance(
		expectedIdentity,
		expectedOwner,
		{ dev: 7, ino: 12 },
		successorOwner,
	), 'successor', 'a new owner token also identifies a successor with a new inode');
	assert.throws(() => classifyPrivateDirectoryLockInstance(
		expectedIdentity,
		expectedOwner,
		{ dev: 7, ino: 12 },
		expectedOwner,
	), /copied to a different directory instance/u);
});

async function waitForText(stream: Readable, expected: string, timeoutMs = 2_000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		let accumulated = '';
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error(`Timed out waiting for child output: ${expected}`));
		}, timeoutMs);
		const onData = (chunk: Buffer | string): void => {
			accumulated += chunk.toString();
			if (!accumulated.includes(expected)) return;
			cleanup();
			resolve();
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onEnd = (): void => {
			cleanup();
			reject(new Error(`Child output ended before marker: ${expected}`));
		};
		const cleanup = (): void => {
			clearTimeout(timer);
			stream.off('data', onData);
			stream.off('error', onError);
			stream.off('end', onEnd);
		};
		stream.on('data', onData);
		stream.on('error', onError);
		stream.on('end', onEnd);
	});
}

test('private directory lock serializes contenders and removes verified state', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		const firstEntered = deferred();
		const releaseFirst = deferred();
		const events: string[] = [];
		let secondEntered = false;
		const first = withPrivateDirectoryLock(lockPath, async () => {
			events.push('first-enter');
			firstEntered.resolve();
			await releaseFirst.promise;
			events.push('first-leave');
		});
		await firstEntered.promise;
		const second = withPrivateDirectoryLock(lockPath, async () => {
			secondEntered = true;
			events.push('second-enter');
		}, { timeoutMs: 1_000, pollIntervalMs: 5 });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(secondEntered, false);
		releaseFirst.resolve();
		await Promise.all([first, second]);
		assert.deepEqual(events, ['first-enter', 'first-leave', 'second-enter']);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
	});
});

test('private directory lock recovers a verified dead owner', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await writeOwner(lockPath, await exitedChildPid());
		let entered = false;
		await withPrivateDirectoryLock(lockPath, async () => {
			entered = true;
		}, { timeoutMs: 1_000, pollIntervalMs: 5 });
		assert.equal(entered, true);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
	});
});

test('private directory lock recovers after a real child holder is killed', {
	skip: process.platform === 'win32',
}, async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		const moduleUrl = new URL('../src/persistence/privateDirectoryLock.js', import.meta.url).href;
		const child = spawn(process.execPath, ['--input-type=module', '--eval', [
			"const { withPrivateDirectoryLock } = await import(process.env.SYNTHETIC_LOCK_MODULE_URL);",
			"await withPrivateDirectoryLock(process.env.SYNTHETIC_LOCK_PATH, async () => {",
			"  process.stdout.write('LOCKED\\n');",
			"  setInterval(() => undefined, 1000);",
			"  await new Promise(() => undefined);",
			"});",
		].join('\n')], {
			env: {
				...process.env,
				SYNTHETIC_LOCK_MODULE_URL: moduleUrl,
				SYNTHETIC_LOCK_PATH: lockPath,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		assert.ok(child.stdout);
		try {
			await waitForText(child.stdout, 'LOCKED\n');
			assert.equal((await lstat(lockPath)).isDirectory(), true);
			assert.equal(child.kill('SIGKILL'), true);
			await new Promise<void>((resolve, reject) => {
				child.once('error', reject);
				child.once('exit', () => resolve());
			});
			let entered = false;
			await withPrivateDirectoryLock(lockPath, async () => {
				entered = true;
			}, { timeoutMs: 1_000, pollIntervalMs: 2 });
			assert.equal(entered, true);
			await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		}
	});
});

test('private directory lock serializes simultaneous dead-owner recovery', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await writeOwner(lockPath, await exitedChildPid());
		let active = 0;
		let maximumActive = 0;
		await Promise.all(Array.from({ length: 8 }, (_, index) => withPrivateDirectoryLock(
			lockPath,
			async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise((resolve) => setTimeout(resolve, 3 + index % 2));
				active -= 1;
			},
			{ timeoutMs: 2_000, pollIntervalMs: 2 },
		)));
		assert.equal(maximumActive, 1);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
		await assert.rejects(lstat(`${lockPath}.recovery`), { code: 'ENOENT' });
	});
});

test('private directory lock fails closed on an orphaned recovery claim', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await mkdir(`${lockPath}.recovery`, { mode: 0o700 });
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 20,
				pollIntervalMs: 5,
			}),
			(error: unknown) => {
				assert.ok(error instanceof PrivateDirectoryLockBusyError);
				assert.equal(error.reason, 'transition-gate-busy');
				return true;
			},
		);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
		assert.equal((await lstat(`${lockPath}.recovery`)).isDirectory(), true);
	});
});

test('release timeout is non-retryable and a durable marker permits later live-owner recovery', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		const gatePath = `${lockPath}.recovery`;
		let operationCalls = 0;
		let caught: unknown;
		try {
			await withPrivateDirectoryLock(lockPath, async () => {
				operationCalls += 1;
				await mkdir(gatePath, { mode: 0o700 });
			}, {
				timeoutMs: 100,
				pollIntervalMs: 2,
				releaseTimeoutMs: 20,
			});
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof PrivateDirectoryLockReleaseError);
		assert.equal(caught.code, 'PRIVATE_DIRECTORY_LOCK_RELEASE_INCOMPLETE');
		assert.equal(caught.retryable, false);
		assert.equal(caught.protectedOperationStatus, 'completed');
		assert.equal(caught instanceof PrivateDirectoryLockBusyError, false);
		assert.equal(operationCalls, 1, 'a completed protected operation must not be replayed');

		const owner = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')) as {
			token: string;
		};
		const release = JSON.parse(await readFile(path.join(lockPath, 'released.json'), 'utf8')) as {
			token: string;
		};
		assert.equal(release.token, owner.token);
		await rmdir(gatePath);

		let recoveredCalls = 0;
		await withPrivateDirectoryLock(lockPath, async () => {
			recoveredCalls += 1;
		}, { timeoutMs: 1_000, pollIntervalMs: 2 });
		assert.equal(recoveredCalls, 1, 'matching release marker overrides the still-live owner pid');
		assert.equal(operationCalls, 1);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
	});
});

test('operation and release failures are both retained without becoming retryable busy', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		const gatePath = `${lockPath}.recovery`;
		const operationFailure = new Error('synthetic operation failure');
		let caught: unknown;
		try {
			await withPrivateDirectoryLock(lockPath, async () => {
				await mkdir(gatePath, { mode: 0o700 });
				throw operationFailure;
			}, { releaseTimeoutMs: 20, pollIntervalMs: 2 });
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof PrivateDirectoryLockReleaseError);
		assert.equal(caught.protectedOperationStatus, 'failed');
		assert.equal(caught.retryable, false);
		assert.ok(caught.cause instanceof AggregateError);
		assert.equal(caught.cause.errors[0], operationFailure);
		assert.ok(caught.cause.errors[1] instanceof PrivateDirectoryLockBusyError);
		await rmdir(gatePath);
	});
});

test('malformed live-owner release marker fails closed after grace', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await writeOwner(lockPath, process.pid);
		await writeFile(path.join(lockPath, 'released.json'), '{', { encoding: 'utf8', mode: 0o600 });
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 20,
				pollIntervalMs: 2,
				orphanGraceMs: 1_000,
			}),
			(error: unknown) => {
				assert.ok(error instanceof PrivateDirectoryLockBusyError);
				assert.equal(error.reason, 'owner-busy');
				return true;
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 100,
				pollIntervalMs: 2,
				orphanGraceMs: 1,
			}),
			/malformed release marker for a live owner/u,
		);
		assert.equal((await lstat(lockPath)).isDirectory(), true);
	});
});

test('mismatched release marker token is structural corruption, never abandoned-owner recovery', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await writeOwner(lockPath, await exitedChildPid(), 'a'.repeat(32));
		await writeFile(path.join(lockPath, 'released.json'), `${JSON.stringify({
			schemaVersion: 1,
			token: 'b'.repeat(32),
			releasedAt: new Date().toISOString(),
		})}\n`, { encoding: 'utf8', mode: 0o600 });
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 100,
				pollIntervalMs: 2,
			}),
			/release marker does not match its owner/u,
		);
		assert.equal((await lstat(lockPath)).isDirectory(), true);
	});
});

test('private directory lock recovers an empty owner left by a crashed creator', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await mkdir(lockPath, { mode: 0o700 });
		await writeFile(path.join(lockPath, 'owner.json'), '', { mode: 0o600 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		let entered = false;
		await withPrivateDirectoryLock(lockPath, async () => {
			entered = true;
		}, {
			timeoutMs: 1_000,
			pollIntervalMs: 5,
			orphanGraceMs: 1,
		});
		assert.equal(entered, true);
		await assert.rejects(lstat(lockPath), { code: 'ENOENT' });
	});
});

test('private directory lock times out without evicting a live owner', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await writeOwner(lockPath, process.pid);
		const startedAt = Date.now();
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 40,
				pollIntervalMs: 5,
			}),
			PrivateDirectoryLockBusyError,
		);
		assert.ok(Date.now() - startedAt < 500);
		assert.equal((await lstat(lockPath)).isDirectory(), true);
	});
});

test('private directory lock verifies owner identity before release', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => {
				const ownerPath = path.join(lockPath, 'owner.json');
				const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as Record<string, unknown>;
				owner.token = 'f'.repeat(32);
				await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, 'utf8');
			}),
			(error: unknown) => {
				assert.ok(error instanceof PrivateDirectoryLockReleaseError);
				assert.equal(error.protectedOperationStatus, 'completed');
				assert.match(String(error.cause), /ownership changed before release marker creation/u);
				return true;
			},
		);
		assert.equal((await lstat(lockPath)).isDirectory(), true, 'tampered state must fail closed');
	});
});

test('private directory lock rejects non-private parents and symlink lock state', {
	skip: process.platform === 'win32',
}, async () => {
	await withTemporaryRoot(async (root) => {
		const insecureParent = path.join(root, 'insecure');
		await mkdir(insecureParent, { mode: 0o700 });
		await chmod(insecureParent, 0o755);
		await assert.rejects(
			withPrivateDirectoryLock(path.join(insecureParent, '.lock'), async () => undefined),
			/not be accessible to group or other users/u,
		);

		const privateParent = path.join(root, 'private');
		const symlinkTarget = path.join(root, 'symlink-target');
		await mkdir(privateParent, { mode: 0o700 });
		await mkdir(symlinkTarget, { mode: 0o700 });
		const lockPath = path.join(privateParent, '.lock');
		await symlink(symlinkTarget, lockPath);
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, {
				timeoutMs: 20,
				pollIntervalMs: 5,
			}),
			/must be a real directory/u,
		);
		assert.equal((await lstat(lockPath)).isSymbolicLink(), true);
	});
});

test('private directory lock options are explicitly bounded', async () => {
	await withTemporaryRoot(async (root) => {
		const lockPath = path.join(root, '.runtime-catalog.lock');
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, { timeoutMs: 0 }),
			/timeoutMs must be an integer/u,
		);
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, { orphanGraceMs: 600_000 }),
			/orphanGraceMs must be an integer/u,
		);
		await assert.rejects(
			withPrivateDirectoryLock(lockPath, async () => undefined, { releaseTimeoutMs: 0 }),
			/releaseTimeoutMs must be an integer/u,
		);
	});
});
