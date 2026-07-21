import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const core = require('../src/graph-core.js');
const vaultPath = process.argv[2];

if (!vaultPath) {
  console.error('Usage: node scripts/vault-smoke.mjs /path/to/vault');
  process.exit(2);
}

const files = await collectMarkdownFiles(vaultPath);
const relativePaths = files.map((file) => normalize(path.relative(vaultPath, file)));
const pathSet = new Set(relativePaths);
const byBasename = new Map();
for (const relativePath of relativePaths) {
  const basename = path.basename(relativePath, '.md').toLowerCase();
  if (!byBasename.has(basename)) byBasename.set(basename, []);
  byBasename.get(basename).push(relativePath);
}

const edges = [];
let resolvedLinkCount = 0;
for (let index = 0; index < files.length; index += 1) {
  const source = relativePaths[index];
  const text = await readFile(files[index], 'utf8');
  for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const rawTarget = match[1].split('|', 1)[0].split('#', 1)[0].split('^', 1)[0].trim();
    if (!rawTarget) continue;
    const target = resolveTarget(rawTarget, source, pathSet, byBasename);
    if (!target || target === source) continue;
    edges.push([source, target, 1]);
    resolvedLinkCount += 1;
  }
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawDestination = match[1].trim().replace(/^<|>$/g, '').split(/\s+["']/u, 1)[0];
    if (!rawDestination || rawDestination.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(rawDestination)) {
      continue;
    }
    let decoded = rawDestination;
    try { decoded = decodeURIComponent(rawDestination); } catch { /* keep the raw path */ }
    const rawTarget = decoded.split('#', 1)[0].split('?', 1)[0].trim();
    if (!rawTarget || !rawTarget.toLowerCase().endsWith('.md')) continue;
    const target = resolveTarget(rawTarget, source, pathSet, byBasename);
    if (!target || target === source) continue;
    edges.push([source, target, 1]);
    resolvedLinkCount += 1;
  }
}

const graph = core.buildWeightedGraph(edges, relativePaths);
const analysis = core.analyzeGraph(graph, {
  maxCommunities: 9,
  minCommunitySize: 3,
  resolution: 1,
  propagationSteps: 4,
  propagationStrength: 0.52,
});

console.log(JSON.stringify({
  noteCount: files.length,
  resolvedLinkCount,
  communityCount: analysis.clusters.length,
  classifiedNotes: analysis.nodeCount - analysis.neutralCount,
  neutralNotes: analysis.neutralCount,
  clusterSizes: analysis.clusters.map((cluster) => cluster.size),
}, null, 2));

async function collectMarkdownFiles(directory) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (['.obsidian', '.git', 'node_modules'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectMarkdownFiles(absolute));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(absolute);
  }
  return output.sort();
}

function resolveTarget(rawTarget, source, pathSet, byBasename) {
  const hadMarkdownExtension = /\.md$/i.test(rawTarget);
  const normalizedTarget = normalize(rawTarget.replace(/\.md$/i, ''));
  const candidates = [];
  if (normalizedTarget.includes('/')) {
    candidates.push(`${normalizedTarget}.md`);
    candidates.push(normalize(path.join(path.dirname(source), `${normalizedTarget}.md`)));
  } else {
    const matches = byBasename.get(path.basename(normalizedTarget).toLowerCase()) || [];
    if (matches.length === 1) return matches[0];
    candidates.push(normalize(path.join(path.dirname(source), `${normalizedTarget}.md`)));
    candidates.push(`${normalizedTarget}.md`);
    candidates.push(...matches);
  }
  if (hadMarkdownExtension) {
    candidates.unshift(normalize(rawTarget));
    candidates.unshift(normalize(path.join(path.dirname(source), rawTarget)));
  }
  return candidates.find((candidate) => pathSet.has(candidate));
}

function normalize(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '');
}
