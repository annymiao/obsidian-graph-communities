import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseFiles = ['main.js', 'manifest.json', 'styles.css'];
const maximumSourceBytes = 5_000_000;
const forbiddenArtifactExtensions = new Set([
  '.7z', '.docx', '.gz', '.pages', '.pdf', '.pptx', '.rar', '.tar', '.xlsx', '.zip',
]);
const forbiddenKnowledgePath = /(?:^|\/)(?:attachments|backups?|notes|obsidian vault|vault)(?:\/|$)/iu;
const localPathPatterns = [
  { label: 'macOS user path', pattern: /(?:file:\/\/)?\/Users\/[^\s'"`/]+(?:\/[^\s'"`]*)?/iu },
  { label: 'macOS volume path', pattern: /(?:file:\/\/)?\/Volumes\/[^\s'"`/]+(?:\/[^\s'"`]*)?/iu },
  { label: 'Linux user path', pattern: /(?:file:\/\/)?\/home\/[^\s'"`/]+(?:\/[^\s'"`]*)?/iu },
  { label: 'macOS private temporary path', pattern: /\/private\/(?:tmp|var)\/[^\s'"`]*/iu },
  { label: 'Windows user path', pattern: /[A-Za-z]:[\\/]Users[\\/][^\s'"`\\/]+/iu },
];
const strongCredentialPatterns = [
  { label: 'private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/u },
  { label: 'GitHub token', pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u },
  { label: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u },
  { label: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}\b/u },
  { label: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u },
  { label: 'live Stripe secret', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/u },
  { label: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{32,}\b/u },
  { label: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { label: 'Bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{24,}\b/iu },
];
const genericSecretAssignment = /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\b\s*[:=]\s*["'`]([A-Za-z0-9+/_=.-]{20,})["'`]/giu;
const safePlaceholder = /(?:change[-_ ]?me|dummy|example|placeholder|replace[-_ ]?with|sample|test[-_]|your[-_ ])/iu;

export function findSensitiveFinding(filename, content) {
  for (const detector of localPathPatterns) {
    if (detector.pattern.test(content)) return `${filename} contains ${detector.label}`;
  }
  for (const detector of strongCredentialPatterns) {
    if (detector.pattern.test(content)) return `${filename} contains a ${detector.label}`;
  }
  genericSecretAssignment.lastIndex = 0;
  for (const match of content.matchAll(genericSecretAssignment)) {
    const value = match[1] || '';
    if (!safePlaceholder.test(value)) {
      return `${filename} contains a credential-like assignment`;
    }
  }
  return null;
}

export async function auditRepository() {
  const contents = new Map(await Promise.all(
    releaseFiles.map(async (filename) => [filename, await readFile(path.join(root, filename), 'utf8')])
  ));
  const manifest = JSON.parse(contents.get('manifest.json'));
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const versions = JSON.parse(await readFile(path.join(root, 'versions.json'), 'utf8'));
  const mcpPackage = JSON.parse(await readFile(path.join(root, 'mcp', 'package.json'), 'utf8'));
  const mcpIndex = await readFile(path.join(root, 'mcp', 'src', 'index.ts'), 'utf8');

  if (manifest.version !== packageJson.version) {
    throw new Error(`Version mismatch: manifest=${manifest.version}, package=${packageJson.version}`);
  }
  if (mcpPackage.version !== packageJson.version) {
    throw new Error(`Version mismatch: root=${packageJson.version}, mcp=${mcpPackage.version}`);
  }
  if (versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error(`versions.json does not map ${manifest.version} to ${manifest.minAppVersion}`);
  }
  const serviceVersion = mcpIndex.match(/KNOWLEDGE_SERVICE_VERSION\s*=\s*['"]([^'"]+)['"]/u)?.[1];
  if (serviceVersion !== mcpPackage.version) {
    throw new Error(`Version mismatch: mcp package=${mcpPackage.version}, service=${serviceVersion || 'missing'}`);
  }

  const repositoryFiles = await listRepositoryFiles();
  for (const filename of repositoryFiles) {
    validateRepositoryPath(filename);
    const absolutePath = path.join(root, filename);
    const fileInfo = await lstat(absolutePath);
    if (fileInfo.isSymbolicLink()) {
      throw new Error(`${filename} is a symbolic link; release sources must be self-contained`);
    }
    if (!fileInfo.isFile()) continue;
    if (fileInfo.size > maximumSourceBytes) {
      throw new Error(`${filename} exceeds the ${maximumSourceBytes}-byte source limit`);
    }
    const buffer = await readFile(absolutePath);
    if (buffer.includes(0)) {
      throw new Error(`${filename} is binary; this repository must remain code and text only`);
    }
    const finding = findSensitiveFinding(filename, buffer.toString('utf8'));
    if (finding) throw new Error(finding);
  }

  const runtime = contents.get('main.js');
  for (const networkApi of ['fetch(', 'XMLHttpRequest', 'WebSocket(', 'EventSource(']) {
    if (runtime.includes(networkApi)) {
      throw new Error(`main.js unexpectedly references network API: ${networkApi}`);
    }
  }

  console.log(
    `Release audit passed: ${releaseFiles.join(', ')} · version ${manifest.version} · ` +
    `${repositoryFiles.length} repository files checked · no personal paths, credentials, binary artifacts, or plugin network APIs.`
  );
}

async function listRepositoryFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 20_000_000 }
  );
  return [...new Set(stdout.split('\0').filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function validateRepositoryPath(filename) {
  const normalized = filename.replace(/\\/gu, '/');
  if (forbiddenKnowledgePath.test(normalized)) {
    throw new Error(`${filename} is inside a personal knowledge or attachment directory`);
  }
  const extension = path.extname(normalized).toLocaleLowerCase();
  if (forbiddenArtifactExtensions.has(extension)) {
    throw new Error(`${filename} is a forbidden document or archive artifact`);
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  await auditRepository();
}
