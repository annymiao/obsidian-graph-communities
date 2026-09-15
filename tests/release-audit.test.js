const assert = require('node:assert/strict');
const { test } = require('node:test');

test('release audit detects personal machine paths and credential-shaped values', async () => {
  const { findSensitiveFinding } = await import('../scripts/audit-release.mjs');
  const userPath = ['const source = "', '/', 'Users', '/person/private/note.md";'].join('');
  const volumePath = ['const vault = "', '/', 'Volumes', '/private-drive/vault";'].join('');
  const uncPath = ['const source = "', '\\\\', 'private-server', '\\', 'notes-share', '\\', 'note.md";'].join('');
  const githubToken = ['const token = "', 'github', '_pat_', 'A'.repeat(30), '";'].join('');
  const genericSecret = [
    'const apiKey = "',
    'Q7mK2pV9xR4tN8cL',
    '6sD3wF1h";',
  ].join('');

  assert.match(findSensitiveFinding('source.ts', userPath) || '', /user path/u);
  assert.match(findSensitiveFinding('source.ts', volumePath) || '', /volume path/u);
  assert.match(findSensitiveFinding('source.ts', uncPath) || '', /Windows UNC path/u);
  assert.match(
    findSensitiveFinding(
      'source.ts',
      [
        'const source = "',
        String.raw`\\\\`,
        'private-server',
        String.raw`\\`,
        'notes-share',
        String.raw`\\`,
        'note.md";',
      ].join(''),
    ) || '',
    /escaped Windows UNC path/u,
  );
  assert.match(findSensitiveFinding('source.ts', githubToken) || '', /GitHub token/u);
  assert.match(findSensitiveFinding('source.ts', genericSecret) || '', /credential-like/u);
});

test('release audit permits explicit synthetic placeholders', async () => {
  const { findSensitiveFinding } = await import('../scripts/audit-release.mjs');
  assert.equal(
    findSensitiveFinding('fixture.ts', "const API_KEY = 'test-api-key-1234567890abcdef';"),
    null,
  );
  assert.equal(
    findSensitiveFinding('README.md', "export API_KEY='replace-with-a-random-value';"),
    null,
  );
  assert.equal(findSensitiveFinding('bundle.js', String.raw`const pattern = /\\.md$/iu;`), null);
  assert.equal(
    findSensitiveFinding('fixture.ts', String.raw`const root = 'C:\\Synthetic\\OWNER';`),
    null,
  );
  assert.equal(
    findSensitiveFinding(
      'server.ts',
      "const apiKey = environment.OBSIDIAN_SECOND_BRAIN_HTTP_API_KEY?.trim() ?? '';",
    ),
    null,
  );
});

test('release audit rejects knowledge, credential, and second-brain runtime paths', async () => {
  const { findRepositoryPathFinding } = await import('../scripts/audit-release.mjs');
  for (const candidate of [
    'Vault/private.md',
    'Backups/export.md',
    'state/runtime-catalog.json',
    'cache/generations/gen-example/payload.json',
    'state/rollback/transaction.json',
    'state/audit-ledger/events.jsonl',
    '.env',
    'keys/service.pem',
  ]) {
    assert.equal(typeof findRepositoryPathFinding(candidate), 'string', candidate);
  }

  assert.equal(findRepositoryPathFinding('mcp/src/write/approval.ts'), null);
  assert.equal(findRepositoryPathFinding('docs/PRODUCT_ARCHITECTURE_1.3.md'), null);
});

test('release audit accepts only valid UTF-8 text', async () => {
  const { decodeAuditedText } = await import('../scripts/audit-release.mjs');
  assert.equal(decodeAuditedText('source.ts', Buffer.from('synthetic source\n')), 'synthetic source\n');
  assert.throws(
    () => decodeAuditedText('binary.dat', Buffer.from([0xff, 0x00, 0x81])),
    /binary or is not valid UTF-8/u,
  );
});
