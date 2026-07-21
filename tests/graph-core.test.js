'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/graph-core');

function clique(prefix, count, weight = 2) {
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    for (let j = i + 1; j < count; j += 1) {
      edges.push([`${prefix}${i}`, `${prefix}${j}`, weight]);
    }
  }
  return edges;
}

test('detects strongly connected communities separated by weak bridges', () => {
  const edges = [
    ...clique('a', 5),
    ...clique('b', 5),
    ...clique('c', 5),
    ['a0', 'b0', 0.2],
    ['b0', 'c0', 0.2],
  ];
  const graph = core.buildWeightedGraph(edges);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 6,
    minCommunitySize: 2,
    resolution: 1,
  });

  assert.equal(analysis.clusters.length, 3);
  assert.equal(analysis.assignments.get('a1'), analysis.assignments.get('a4'));
  assert.equal(analysis.assignments.get('b1'), analysis.assignments.get('b4'));
  assert.equal(analysis.assignments.get('c1'), analysis.assignments.get('c4'));
  assert.notEqual(analysis.assignments.get('a1'), analysis.assignments.get('b1'));
  assert.notEqual(analysis.assignments.get('b1'), analysis.assignments.get('c1'));
});

test('chooses high-degree nodes as community hubs', () => {
  const graph = core.buildWeightedGraph([
    ['hub', 'a', 4],
    ['hub', 'b', 4],
    ['hub', 'c', 4],
    ['a', 'b', 1],
    ['b', 'c', 1],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 2,
    minCommunitySize: 1,
  });
  assert.equal(analysis.clusters[0].hub, 'hub');
});

test('keeps related nodes closer in color than separate community hubs', () => {
  const graph = core.buildWeightedGraph([
    ...clique('left', 5),
    ...clique('right', 5),
    ['left0', 'right0', 0.1],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 4,
    minCommunitySize: 2,
    propagationSteps: 4,
    propagationStrength: 0.55,
  });
  const within = core.colorDistance(
    analysis.colors.get('left1'),
    analysis.colors.get('left2')
  );
  const across = core.colorDistance(
    analysis.colors.get('left1'),
    analysis.colors.get('right1')
  );
  assert.ok(within < across, `within=${within}, across=${across}`);
});

test('blends a boundary node between neighboring communities', () => {
  const graph = core.buildWeightedGraph([
    ...clique('red', 5),
    ...clique('blue', 5),
    ['bridge', 'red0', 2],
    ['bridge', 'blue0', 2],
  ]);
  const analysis = core.analyzeGraph(graph, {
    maxCommunities: 4,
    minCommunitySize: 2,
    propagationSteps: 6,
    propagationStrength: 0.7,
  });
  const vector = analysis.affinities.get('bridge');
  const nonZero = vector.filter((value) => value > 0.05);
  assert.ok(nonZero.length >= 2, `expected mixed affinity, received ${vector}`);
});

test('is deterministic for the same graph and settings', () => {
  const graph = core.buildWeightedGraph([
    ...clique('x', 4),
    ...clique('y', 4),
    ['x0', 'y0', 0.5],
  ]);
  const first = core.analyzeGraph(graph, { maxCommunities: 5 });
  const second = core.analyzeGraph(graph, { maxCommunities: 5 });
  assert.deepEqual([...first.assignments.entries()], [...second.assignments.entries()]);
  assert.deepEqual([...first.colors.entries()], [...second.colors.entries()]);
});

test('builds an undirected weighted graph from Obsidian resolved links', () => {
  const graph = core.graphFromResolvedLinks({
    'A.md': { 'B.md': 2 },
    'B.md': { 'A.md': 1, 'C.md': 1 },
  }, ['D.md']);
  assert.equal(graph.get('A.md').get('B.md'), 3);
  assert.equal(graph.get('B.md').get('A.md'), 3);
  assert.equal(graph.get('B.md').get('C.md'), 1);
  assert.ok(graph.has('D.md'));
});

test('honors zero blending distance instead of replacing it with the default', () => {
  const graph = core.buildWeightedGraph([['left', 'right', 1]]);
  const assignments = new Map([['left', 0], ['right', 1]]);
  const hubs = new Map([[0, 'left'], [1, 'right']]);
  const affinities = core.propagateAffinities(graph, assignments, hubs, 2, {
    propagationSteps: 0,
    propagationStrength: 0.9,
  });
  assert.deepEqual(affinities.get('left'), [1, 0]);
  assert.deepEqual(affinities.get('right'), [0, 1]);
});

test('groups unlinked notes by detected project folders', () => {
  const ids = [
    'Project Alpha/roadmap.md',
    'Project Alpha/research.md',
    'Project Alpha/launch.md',
    'Project Beta/roadmap.md',
    'Project Beta/research.md',
    'Project Beta/launch.md',
  ];
  const linkGraph = core.createGraph(ids);
  const model = core.buildHybridGraph(
    linkGraph,
    ids.map((id) => ({ id, path: id })),
    { projectWeight: 3, semanticWeight: 0, projectMaxSize: 20 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
  });

  assert.equal(
    analysis.assignments.get('Project Alpha/roadmap.md'),
    analysis.assignments.get('Project Alpha/launch.md')
  );
  assert.notEqual(
    analysis.assignments.get('Project Alpha/roadmap.md'),
    analysis.assignments.get('Project Beta/roadmap.md')
  );
  assert.deepEqual(
    new Set(analysis.clusters.map((cluster) => cluster.label)),
    new Set(['Project Alpha', 'Project Beta'])
  );
});

test('does not use README or index notes as representative hubs', () => {
  const ids = [
    'Project Phoenix/README.md',
    'Project Phoenix/AI architecture.md',
    'Project Phoenix/Model evaluation.md',
    'Project Phoenix/Product strategy.md',
  ];
  const linkGraph = core.buildWeightedGraph([
    [ids[0], ids[1], 8],
    [ids[0], ids[2], 8],
    [ids[0], ids[3], 8],
  ], ids);
  const model = core.buildHybridGraph(
    linkGraph,
    ids.map((id) => ({ id, path: id })),
    { projectWeight: 3, semanticWeight: 1, navigationLinkPenalty: 0.08 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 2,
    minCommunitySize: 2,
  });

  assert.notEqual(analysis.clusters[0].hub, ids[0]);
  assert.equal(analysis.clusters[0].label, 'Project Phoenix');
});

test('uses priority keywords such as AI across directory boundaries', () => {
  const documents = [
    { id: 'Work/voice/AI speech model.md', path: 'Work/voice/AI speech model.md' },
    { id: 'Research/agents/AI agent memory.md', path: 'Research/agents/AI agent memory.md' },
    { id: 'Work/market/pricing research.md', path: 'Work/market/pricing research.md' },
    { id: 'Research/market/market landscape.md', path: 'Research/market/market landscape.md' },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    {
      priorityKeywords: 'AI',
      projectWeight: 0,
      semanticWeight: 4,
      semanticThreshold: 0.04,
    }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    priorityKeywords: model.priorityKeywords,
    projectFirst: false,
    maxCommunities: 4,
    minCommunitySize: 2,
  });

  assert.equal(
    analysis.assignments.get(documents[0].id),
    analysis.assignments.get(documents[1].id)
  );
  assert.ok(analysis.clusters.some((cluster) => cluster.label === 'AI'));
});

test('classifies PM content as skills or prompts from body semantics', () => {
  const documents = [
    {
      id: 'Inbox/a.md', path: 'Inbox/a.md',
      content: 'For product managers and product management teams. When to use this skill: follow the workflow, framework, and checklist to create a PRD.',
    },
    {
      id: 'Archive/b.md', path: 'Archive/b.md',
      content: 'Product manager operating method for product management. This skill provides a step-by-step workflow and output contract for roadmap prioritization.',
    },
    {
      id: 'Inbox/c.md', path: 'Inbox/c.md',
      content: 'This prompt is for a product manager working in product management. You are an AI assistant. Instructions: ask one question at a time. Input: context. Output: a product strategy.',
    },
    {
      id: 'Archive/d.md', path: 'Archive/d.md',
      content: 'Product manager and product management prompt template. You are an AI assistant. Instructions: collect the input and produce the output in the requested format.',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 2 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
  });

  assert.equal(model.documents.get('Inbox/a.md').projectLabel, 'PM Skills');
  assert.equal(model.documents.get('Inbox/c.md').projectLabel, 'PM Prompts');
  assert.equal(model.documents.get('Inbox/a.md').communityWeight, 0.12);
  assert.deepEqual(
    new Set(analysis.clusters.map((cluster) => cluster.label)),
    new Set(['PM Skills', 'PM Prompts'])
  );
});

test('uses content context and topics instead of generic storage folders', () => {
  const documents = [
    {
      id: 'Desktop/a.md', path: 'Desktop/a.md',
      content: 'Stanford university public course lecture and assignment about transformer language models, tokenization, attention, and LLM training.',
    },
    {
      id: 'Shared Knowledge/b.md', path: 'Shared Knowledge/b.md',
      content: 'University course lecture notes and research paper discussion about transformer language models, tokenizer design, and attention.',
    },
    {
      id: 'Desktop/c.md', path: 'Desktop/c.md',
      content: 'type: knowledge-card\nscope: work\n儿童陪伴机器人项目的数据治理、隐私、合规与监护人授权方案。产品原型需要明确验收标准。',
    },
    {
      id: 'Shared Knowledge/d.md', path: 'Shared Knowledge/d.md',
      content: 'type: knowledge-card\nscope: competition\n陪伴机器人的儿童数据合规、隐私保护和版权红线，属于产品项目交付范围。',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 2 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
  });
  const labels = new Set(analysis.clusters.map((cluster) => cluster.label));

  assert.ok(labels.has('学术 · 大语言模型'));
  assert.ok(labels.has('项目 · 儿童陪伴 / 数据与合规'));
  assert.ok(!labels.has('Desktop'));
  assert.ok(!labels.has('Shared Knowledge'));
  assert.deepEqual(model.documents.get('Desktop/a.md').contextTags, ['academic']);
  assert.ok(model.documents.get('Shared Knowledge/d.md').topicTags.includes('data-compliance'));
});
