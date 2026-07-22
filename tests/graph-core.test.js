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
      content: 'For product managers and product management teams. Product discovery and customer interview skill: follow the workflow and framework to create a product strategy.',
    },
    {
      id: 'Archive/b.md', path: 'Archive/b.md',
      content: 'Product manager product management product discovery and market research method. This skill provides a step-by-step customer interview workflow and product strategy output contract.',
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

  assert.equal(model.documents.get('Inbox/a.md').projectLabel, 'PM Strategy & Discovery');
  assert.equal(model.documents.get('Inbox/c.md').projectLabel, 'PM Prompts');
  assert.equal(model.documents.get('Inbox/a.md').communityWeight, 0.2);
  assert.equal(model.documents.get('Inbox/a.md').displayWeight, 0.86);
  assert.deepEqual(
    new Set(analysis.clusters.map((cluster) => cluster.label)),
    new Set(['PM Strategy & Discovery', 'PM Prompts'])
  );
});

test('dims duplicate and supporting PM skill artifacts without removing them', () => {
  const common = '---\nname: product-strategy-canvas\n---\n# Product Strategy Canvas\nProduct manager product strategy and discovery skill workflow.';
  const documents = [
    {
      id: 'pm-skills/a/pm-product-strategy/main.md',
      path: 'pm-skills/a/pm-product-strategy/main.md',
      content: common,
    },
    {
      id: 'pm-skills/b/pm-product-strategy/main.md',
      path: 'pm-skills/b/pm-product-strategy/main.md',
      content: `${common}\nVersioned package copy.`,
    },
    {
      id: 'pm-skills/references/pm-product-strategy/main.md',
      path: 'pm-skills/references/pm-product-strategy/main.md',
      content: common,
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 2 }
  );

  assert.equal(model.documents.get(documents[0].id).projectLabel, 'PM Strategy & Discovery');
  assert.equal(model.documents.get(documents[0].id).displayWeight, 0.86);
  assert.equal(model.documents.get(documents[1].id).displayWeight, 0.36);
  assert.equal(model.documents.get(documents[1].id).duplicateOf, documents[0].id);
  assert.equal(model.documents.get(documents[2].id).displayWeight, 0.3);
  assert.equal(model.documents.get(documents[2].id).supportingArtifact, true);
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
  });
  assert.equal(analysis.clusters[0].size, 3);
  assert.equal(analysis.clusters[0].visibleSize, 1);
  assert.equal(analysis.clusters[0].hub, documents[0].id);
});

test('shows packaged PM skill definitions but dims adjacent repository documentation', () => {
  const documents = [
    {
      id: 'pm-skill-research/sources/repo/skills/roadmap/SKILL.md',
      path: 'pm-skill-research/sources/repo/skills/roadmap/SKILL.md',
      content: '---\nname: roadmap-planning\n---\nProduct manager roadmap planning skill workflow and checklist.',
    },
    {
      id: 'pm-skill-research/sources/repo/roadmap-guide.md',
      path: 'pm-skill-research/sources/repo/roadmap-guide.md',
      content: 'Product manager product management roadmap planning skill guide and workflow.',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 2 }
  );

  assert.equal(model.documents.get(documents[0].id).displayWeight, 0.86);
  assert.equal(model.documents.get(documents[1].id).displayWeight, 0.3);
});

test('keeps a single PM summary visible under its summary parent', () => {
  const documents = [{
    id: 'Projects/Product-Management/PM资料总结.md',
    path: 'Projects/Product-Management/PM资料总结.md',
    tags: ['pm-summary', 'product-management'],
    content: '# PM 资料总结\n产品经理资料只保留战略、执行、数据工具和 prompts 的汇总结论。',
  }];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 1 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 3,
  });

  assert.equal(model.documents.get(documents[0].id).projectLabel, 'PM · 战略与发现');
  assert.equal(model.documents.get(documents[0].id).parentLabel, 'PM 资料总结');
  assert.equal(model.documents.get(documents[0].id).displayWeight, 1);
  assert.equal(analysis.clusters.length, 1);
  assert.equal(analysis.parents.length, 1);
  assert.equal(analysis.parents[0].label, 'PM 资料总结');
  assert.equal(analysis.clusters[0].label, 'PM · 战略与发现');
});

test('groups five PM summary notes into four searchable child categories', () => {
  const documents = [
    ['PM资料总结.md', ['pm-summary', 'pm-summary-root']],
    ['PM资料总结/01-战略与发现.md', ['pm-summary', 'pm-summary-strategy-discovery']],
    ['PM资料总结/02-执行与增长.md', ['pm-summary', 'pm-summary-execution-growth']],
    ['PM资料总结/03-数据与工具.md', ['pm-summary', 'pm-summary-data-tools']],
    ['PM资料总结/04-提示词与工作流.md', ['pm-summary', 'pm-summary-prompts-workflows']],
  ].map(([path, tags]) => ({
    id: path,
    path,
    tags,
    content: `# ${path}\nProduct management summary`,
  }));
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 1 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 8,
    minCommunitySize: 3,
  });

  assert.deepEqual(
    analysis.clusters.map((cluster) => cluster.label).sort(),
    ['PM · 战略与发现', 'PM · 执行与增长', 'PM · 数据与工具', 'PM · 提示词与工作流'].sort()
  );
  assert.equal(analysis.parents.length, 1);
  assert.equal(analysis.parents[0].label, 'PM 资料总结');
  assert.equal(analysis.parents[0].size, 5);
});

test('keeps one canonical PM representative per keyword inside the summary hierarchy', () => {
  const documents = [
    {
      id: 'PM资料总结.md', path: 'PM资料总结.md',
      tags: ['pm-summary', 'pm-summary-root'],
      content: '# PM 资料总结',
    },
    {
      id: 'PM-References/create-prd.md', path: 'PM-References/create-prd.md',
      tags: ['product-management', 'pm-representative', 'pm-skill', 'pm-domain-execution-growth', 'pm-keyword-create-prd'],
      content: 'type: pm-representative\n# Create PRD\nProduct requirements, release, roadmap and delivery workflow.',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 1 }
  );
  const representative = model.documents.get(documents[1].id);

  assert.equal(representative.projectLabel, 'PM · 执行与增长');
  assert.equal(representative.parentLabel, 'PM 资料总结');
  assert.equal(representative.displayWeight, 0.72);
  assert.ok(representative.topicTags.includes('execution-growth'));
});

test('uses content context and topics instead of generic storage folders', () => {
  const documents = [
    {
      id: 'Desktop/a.md', path: 'Desktop/a.md',
      content: 'University public course lecture and assignment about transformer language models, tokenization, attention, and LLM training.',
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

  assert.ok(labels.has('数据隐私与合规治理'));
  assert.ok(!labels.has('Desktop'));
  assert.ok(!labels.has('Shared Knowledge'));
  assert.deepEqual(model.documents.get('Desktop/a.md').contextTags, ['academic']);
  assert.ok(model.documents.get('Desktop/a.md').knowledgePoints.some(
    (point) => point.label === '大语言模型与训练'
  ));
  assert.ok(model.documents.get('Shared Knowledge/b.md').knowledgePoints.some(
    (point) => point.label === '大语言模型与训练'
  ));
  assert.ok(model.documents.get('Shared Knowledge/d.md').topicTags.includes('data-compliance'));
});

test('uses extracted knowledge points instead of Desktop collection names', () => {
  const documents = [
    {
      id: 'Projects/Market-Research/a.md',
      path: 'Projects/Market-Research/a.md',
      content: 'Competitive landscape and market analysis notes.',
    },
    {
      id: 'Projects/Industrial-Design/b.md',
      path: 'Projects/Industrial-Design/b.md',
      content: 'Industrial design concept and enclosure design.',
    },
    {
      id: 'Resources/Prompt-Archive/c.md',
      path: 'Resources/Prompt-Archive/c.md',
      content: 'You are an AI assistant. System prompt instructions.',
    },
    {
      id: 'Resources/University-Course/d.md',
      path: 'Resources/University-Course/d.md',
      content: 'University lecture on language modeling.',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 2 }
  );

  assert.equal(model.documents.get(documents[0].id).projectLabel, '市场、竞品与商业模式');
  assert.equal(model.documents.get(documents[1].id).projectLabel, '硬件与工业设计');
  assert.equal(model.documents.get(documents[2].id).projectLabel, 'AI 助手行为与安全策略');
  assert.equal(
    model.documents.get(documents[3].id).projectLabel,
    '课程学习与知识组织'
  );
});

test('groups child companion work under one red parent with related child shades', () => {
  const documents = [
    {
      id: 'Projects/Child-Companion/Engineering/a.md',
      path: 'Projects/Child-Companion/Engineering/a.md',
      content: '儿童陪伴机器人端侧语音识别与模型评测项目交付。',
    },
    {
      id: 'Projects/Child-Companion/Engineering/b.md',
      path: 'Projects/Child-Companion/Engineering/b.md',
      content: '儿童陪伴机器人 ASR、儿童语音和语音识别模型的端侧验证。',
    },
    {
      id: 'Projects/Child-Companion/Market/c.md',
      path: 'Projects/Child-Companion/Market/c.md',
      content: '儿童陪伴机器人竞品分析、市场调研与商业模式。',
    },
    {
      id: 'Projects/Child-Companion/Market/d.md',
      path: 'Projects/Child-Companion/Market/d.md',
      content: '儿童陪伴机器人市场研究、竞品定价和用户需求。',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 1 }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
  });

  assert.ok([...model.documents.values()].every(
    (document) => document.parentLabel === '儿童陪伴机器人（工作）'
  ));
  assert.equal(analysis.parents.length, 1);
  assert.equal(analysis.parents[0].label, '儿童陪伴机器人（工作）');
  assert.equal(analysis.parents[0].colorHex, '#DC2626');
  assert.equal(analysis.parents[0].size, 4);
  const colors = new Map(analysis.clusters.map((cluster) => [cluster.label, cluster.colorHex]));
  assert.equal(
    colors.get('儿童语音与 ASR'),
    core.rgbIntToHex(core.knowledgePointColor('speech-asr', '@parent:child-companion-work'))
  );
  assert.equal(
    colors.get('市场、竞品与商业模式'),
    core.rgbIntToHex(core.knowledgePointColor('market-competition', '@parent:child-companion-work'))
  );
  assert.notEqual(colors.get('儿童语音与 ASR'), colors.get('市场、竞品与商业模式'));
  assert.ok(analysis.clusters.every(
    (cluster) => cluster.parentKey === '@parent:child-companion-work'
  ));
});

test('assigns stable nearby hues to knowledge points in the same domain', () => {
  const languageModels = core.knowledgePointColor('language-models');
  const softwareEngineering = core.knowledgePointColor('software-engineering');
  const market = core.knowledgePointColor('market-competition');
  const withinAi = core.colorDistance(languageModels, softwareEngineering);
  const acrossDomains = core.colorDistance(languageModels, market);

  assert.ok(withinAi < acrossDomains, `withinAi=${withinAi}, across=${acrossDomains}`);
  assert.ok(acrossDomains > 220, `expected strong domain contrast, received ${acrossDomains}`);
  assert.notEqual(languageModels, softwareEngineering);
  assert.equal(
    core.knowledgePointColor('language-models'),
    core.knowledgePointColor('大语言模型与训练')
  );
});

test('keeps child project shades in one family while separating knowledge types', () => {
  const speech = core.knowledgePointColor(
    'speech-asr', '@parent:child-companion-work'
  );
  const market = core.knowledgePointColor(
    'market-competition', '@parent:child-companion-work'
  );
  const contrast = core.colorDistance(speech, market);

  assert.ok(contrast > 150, `expected red-to-purple-red contrast, received ${contrast}`);
});

test('extracts multiple disciplinary knowledge points from one module article', () => {
  const profile = core.extractKnowledgeProfile({
    id: 'six-modules.md',
    path: 'Projects/Child-Companion/Research/six-modules.md',
    title: '六大模块',
    tags: [],
    aliases: [],
    headings: ['情绪陪护', '教学支持', '语言发展', '习惯养成'],
    content: '儿童陪伴机器人包含情绪调节与安抚、教育学和游戏化学习、语言发展与亲子沟通、习惯养成与正向强化，并坚持低压力交互和非诊断边界。',
  });
  const labels = new Set(profile.knowledgePoints.map((point) => point.label));

  assert.ok(labels.has('儿童心理与情绪支持'));
  assert.ok(labels.has('教育学与学习科学'));
  assert.ok(labels.has('语言发展与亲子沟通'));
  assert.ok(labels.has('习惯形成与行为设计'));
  assert.ok(labels.has('儿童安全与非诊断边界'));
});
