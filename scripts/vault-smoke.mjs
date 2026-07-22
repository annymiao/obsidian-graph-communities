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
const documents = [];
let resolvedLinkCount = 0;
for (let index = 0; index < files.length; index += 1) {
  const source = relativePaths[index];
  const text = await readFile(files[index], 'utf8');
  documents.push(extractDocument(source, text));
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

const linkGraph = core.buildWeightedGraph(edges, relativePaths);
const model = core.buildHybridGraph(linkGraph, documents, {
  priorityKeywords: 'AI, LLM, ASR, RAG, Agent, 儿童陪伴, 产品规划, 竞品, 合规, 工业设计, 端侧研发',
  projectWeight: 5,
  semanticWeight: 1.4,
  linkWeight: 0.65,
  navigationLinkPenalty: 0.08,
  projectMaxSize: 1200,
});
const analysis = core.analyzeGraph(model.graph, {
  maxCommunities: 24,
  minCommunitySize: 2,
  resolution: 1,
  propagationSteps: 4,
  propagationStrength: 0.52,
  documents: model.documents,
  priorityKeywords: model.priorityKeywords,
});
console.log(JSON.stringify({
  noteCount: files.length,
  resolvedLinkCount,
  communityCount: analysis.clusters.length,
  classifiedNotes: analysis.nodeCount - analysis.neutralCount,
  neutralNotes: analysis.neutralCount,
  detectedProjects: summarizeProjects(model.projects),
  navigationRepresentativeCount: analysis.clusters.filter((cluster) =>
    core.isNavigationDocument(cluster.hub, model.documents.get(cluster.hub))
  ).length,
  dimmedRepresentativeCount: analysis.clusters.filter((cluster) =>
    (model.documents.get(cluster.hub)?.displayWeight ?? 1) < 0.2
  ).length,
  parents: analysis.parents,
  clusters: analysis.clusters.map((cluster) => ({
    label: cluster.label,
    colorHex: cluster.colorHex,
    parentLabel: cluster.parentLabel,
    size: cluster.size,
    visibleSize: cluster.visibleSize,
    representative: cluster.hub,
    representativeGroup: model.documents.get(cluster.hub)?.projectLabel,
    keywords: cluster.keywords,
    navigationRepresentative: core.isNavigationDocument(
      cluster.hub,
      model.documents.get(cluster.hub)
    ),
  })),
}, null, 2));

function summarizeProjects(projects) {
  const counts = new Map();
  for (const project of projects.values()) {
    const key = `${project.label}\u0000${project.key}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, size]) => {
      const [label, path] = key.split('\u0000');
      return { label, path, size };
    })
    .filter((project) => project.size >= 2)
    .sort((a, b) => b.size - a.size || a.label.localeCompare(b.label));
}

function extractDocument(source, text) {
  const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/u);
  const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
  const frontmatterTitle = frontmatter.match(/^title:\s*["']?(.+?)["']?\s*$/imu);
  const frontmatterTags = readFrontmatterList(frontmatter, 'tags?');
  const frontmatterAliases = readFrontmatterList(frontmatter, 'aliases?');
  const inlineTags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]{2,})/gmu)]
    .map((match) => match[1]);
  const headings = [...text.matchAll(/^#{1,3}\s+(.+)$/gmu)]
    .map((match) => match[1].trim())
    .slice(0, 16);
  return {
    id: source,
    path: source,
    title: frontmatterTitle ? frontmatterTitle[1].trim() : path.basename(source, '.md'),
    tags: [...frontmatterTags, ...inlineTags],
    aliases: frontmatterAliases,
    headings,
    content: text.slice(0, 24000),
  };
}

function splitMetadataList(value) {
  if (!value) return [];
  return String(value)
    .replace(/^\[|\]$/g, '')
    .split(/[,，]/u)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function readFrontmatterList(frontmatter, keyPattern) {
  const line = frontmatter.match(new RegExp(`^${keyPattern}:[ \\t]*(.*)$`, 'imu'));
  if (!line) return [];
  if (line[1].trim()) return splitMetadataList(line[1]);
  const start = (line.index || 0) + line[0].length;
  const block = frontmatter.slice(start).split('\n');
  const values = [];
  for (const entry of block) {
    if (/^[^\s#][^:]*:/u.test(entry)) break;
    const item = entry.match(/^\s*-\s*(.+?)\s*$/u);
    if (item) values.push(item[1].replace(/^["']|["']$/g, ''));
  }
  return values;
}

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
