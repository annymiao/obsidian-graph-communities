const assert = require('node:assert/strict');
const { test } = require('node:test');

test('release audit detects personal machine paths and credential-shaped values', async () => {
  const { findSensitiveFinding } = await import('../scripts/audit-release.mjs');
  const userPath = ['const source = "', '/', 'Users', '/person/private/note.md";'].join('');
  const volumePath = ['const vault = "', '/', 'Volumes', '/private-drive/vault";'].join('');
  const githubToken = ['const token = "', 'github', '_pat_', 'A'.repeat(30), '";'].join('');
  const genericSecret = [
    'const apiKey = "',
    'Q7mK2pV9xR4tN8cL',
    '6sD3wF1h";',
  ].join('');

  assert.match(findSensitiveFinding('source.ts', userPath) || '', /user path/u);
  assert.match(findSensitiveFinding('source.ts', volumePath) || '', /volume path/u);
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
});
