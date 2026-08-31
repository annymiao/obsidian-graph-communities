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

test('keeps primary skill definitions visible while dimming generic support material', () => {
  const documents = [
    {
      id: 'packages/skills/roadmap/SKILL.md',
      path: 'packages/skills/roadmap/SKILL.md',
      content: '---\nname: roadmap-planning\n---\nProduct manager roadmap planning skill workflow and checklist.',
    },
    {
      id: 'packages/references/roadmap-guide.md',
      path: 'packages/references/roadmap-guide.md',
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

test('uses content context and topics instead of generic storage folders', () => {
  const documents = [
    {
      id: 'Inbox/a.md', path: 'Inbox/a.md',
      content: 'University public course lecture and assignment about transformer language models, tokenization, attention, and LLM training.',
    },
    {
      id: 'Library/b.md', path: 'Library/b.md',
      content: 'University course lecture notes and research paper discussion about transformer language models, tokenizer design, and attention.',
    },
    {
      id: 'Inbox/c.md', path: 'Inbox/c.md',
      content: 'type: knowledge-card\nscope: work\nA software project covering data governance, privacy, compliance, and authorization. The prototype has explicit acceptance criteria.',
    },
    {
      id: 'Library/d.md', path: 'Library/d.md',
      content: 'type: knowledge-card\nscope: competition\nThe product research covers data compliance, privacy protection, copyright, and delivery constraints.',
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
  assert.ok(!labels.has('Inbox'));
  assert.ok(!labels.has('Library'));
  assert.deepEqual(model.documents.get('Inbox/a.md').contextTags, ['academic']);
  assert.ok(model.documents.get('Inbox/a.md').knowledgePoints.some(
    (point) => point.label === '大语言模型与训练'
  ));
  assert.ok(model.documents.get('Library/b.md').knowledgePoints.some(
    (point) => point.label === '大语言模型与训练'
  ));
  assert.ok(model.documents.get('Library/d.md').topicTags.includes('data-compliance'));
});

test('uses extracted knowledge points instead of collection names', () => {
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

test('groups manifest-defined topics under their configured parent', () => {
  const manifest = core.normalizeTopicManifest({
    version: 1,
    themes: [{
      key: 'configured-domain',
      label: 'Configured Domain',
      color: '#3366CC',
      topics: [
        { key: 'configured-speech', label: 'Speech Notes', color: '#2244AA', terms: ['acoustic channel'] },
        { key: 'configured-market', label: 'Market Notes', color: '#6688EE', terms: ['pricing landscape'] },
      ],
    }],
  });
  const documents = [
    {
      id: 'Collection/Engineering/a.md',
      path: 'Collection/Engineering/a.md',
      content: 'Acoustic channel evaluation and signal processing notes.',
    },
    {
      id: 'Collection/Engineering/b.md',
      path: 'Collection/Engineering/b.md',
      content: 'Acoustic channel benchmark and evaluation results.',
    },
    {
      id: 'Collection/Research/c.md',
      path: 'Collection/Research/c.md',
      content: 'Pricing landscape research and comparison.',
    },
    {
      id: 'Collection/Research/d.md',
      path: 'Collection/Research/d.md',
      content: 'Pricing landscape evidence and survey summary.',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    { projectWeight: 3, semanticWeight: 1, topicManifest: manifest }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    maxCommunities: 4,
    minCommunitySize: 2,
    topicManifest: manifest,
  });

  assert.ok([...model.documents.values()].every(
    (document) => document.parentLabel === 'Configured Domain'
  ));
  assert.equal(analysis.parents.length, 1);
  assert.equal(analysis.parents[0].label, 'Configured Domain');
  assert.equal(analysis.parents[0].colorHex, '#3366CC');
  assert.equal(analysis.parents[0].size, 4);
  assert.equal(analysis.colors.get(documents[0].id), 0x2244AA);
  assert.equal(analysis.colors.get(documents[2].id), 0x6688EE);
  assert.ok(analysis.clusters.every(
    (cluster) => cluster.parentKey === 'configured-domain'
  ));
});

test('assigns stable nearby hues to knowledge points in the same domain', () => {
  const languageModels = core.knowledgePointColor('language-models');
  const aiSystems = core.knowledgePointColor('ai-systems');
  const market = core.knowledgePointColor('market-competition');
  const withinAi = core.colorDistance(languageModels, aiSystems);
  const acrossDomains = core.colorDistance(languageModels, market);

  assert.ok(withinAi < acrossDomains, `withinAi=${withinAi}, across=${acrossDomains}`);
  assert.ok(acrossDomains > 130, `expected strong domain contrast, received ${acrossDomains}`);
  assert.notEqual(languageModels, aiSystems);
  assert.equal(
    core.knowledgePointColor('language-models'),
    core.knowledgePointColor('大语言模型与训练')
  );
});

test('keeps unrelated built-in knowledge types visually distinct', () => {
  const speech = core.knowledgePointColor('speech-asr');
  const market = core.knowledgePointColor('market-competition');
  const contrast = core.colorDistance(speech, market);

  assert.ok(contrast > 100, `expected strong topic contrast, received ${contrast}`);
});

test('extracts multiple disciplinary knowledge points from one module article', () => {
  const profile = core.extractKnowledgeProfile({
    id: 'six-modules.md',
    path: 'Collection/Research/six-modules.md',
    title: 'Six Modules',
    tags: [],
    aliases: [],
    headings: ['Emotion', 'Teaching', 'Communication', 'Habits', 'Safety'],
    content: 'The article connects psychology and emotional regulation, learning science and instructional design, language development and communication, habit formation and behavior design, plus safety and ethics.',
  });
  const labels = new Set(profile.knowledgePoints.map((point) => point.label));

  assert.ok(labels.has('Psychology & Emotion'));
  assert.ok(labels.has('Learning Science'));
  assert.ok(labels.has('Language & Communication'));
  assert.ok(labels.has('Behavior & Habits'));
  assert.ok(labels.has('Safety & Ethics'));
});

test('excludes non-knowledge files and exact duplicate copies before graph analysis', () => {
  const documents = [
    {
      id: 'A.md',
      path: 'A.md',
      content: '# Evidence\nA distinct knowledge statement with enough detail.',
    },
    {
      id: 'B.md',
      path: 'B.md',
      content: '# Evidence\nA distinct knowledge statement with enough detail.',
    },
    {
      id: 'ProjectREADME-notes.md',
      path: 'ProjectREADME-notes.md',
      content: '# README\nThis file contains unique prose but remains a README-like summary.',
    },
    {
      id: 'AGENTS.md',
      path: 'AGENTS.md',
      content: '# Instructions\nSystem instructions.',
    },
    {
      id: '._AGENTS.md',
      path: '._AGENTS.md',
      content: 'AppleDouble resource fork metadata',
    },
    {
      id: 'generated/archive.md',
      path: 'generated/archive.md',
      content: '# Generated\nGenerated index content.',
    },
    {
      id: 'Navigation.md',
      path: 'Navigation.md',
      content: '# Navigation\n- [A](A.md)\n- [B](B.md)\n- [C](C.md)',
    },
    {
      id: 'Excluded.md',
      path: 'Excluded.md',
      content: '# Excluded\nKnowledge content.',
      frontmatter: { graph_exclude: true, graph_exclude_reason: 'manual policy' },
    },
    { id: 'Empty.md', path: 'Empty.md', content: '---\ntags: [placeholder]\n---\n' },
  ];
  const result = core.filterEffectiveDocuments(documents);

  assert.deepEqual(result.effective.map((document) => document.id), ['A.md']);
  assert.match(result.excluded.get('B.md'), /duplicate of A\.md/);
  assert.match(result.excluded.get('ProjectREADME-notes.md'), /document/);
  assert.match(result.excluded.get('AGENTS.md'), /document/);
  assert.equal(result.excluded.get('._AGENTS.md'), 'AppleDouble metadata');
  assert.equal(result.excluded.get('generated/archive.md'), 'system or generated path');
  assert.equal(result.excluded.get('Navigation.md'), 'link-only navigation document');
  assert.equal(result.excluded.get('Excluded.md'), 'manual policy');
  assert.equal(result.excluded.get('Empty.md'), 'empty document');
});

test('uses only the primary topic color while retaining secondary topics as metadata', () => {
  const manifest = core.normalizeTopicManifest({
    version: 1,
    themes: [
      {
        key: 'theme-a',
        label: 'Theme A',
        color: '#FF0000',
        topics: [
          { key: 'topic-a1', label: 'Topic A1', color: '#AA1100', terms: ['alpha'] },
          { key: 'topic-a2', label: 'Topic A2', color: '#CC3300', terms: ['beta'] },
        ],
      },
      {
        key: 'theme-b',
        label: 'Theme B',
        color: '#00AAFF',
        topics: [
          { key: 'topic-b1', label: 'Topic B1', color: '#0077CC', terms: ['gamma'] },
        ],
      },
    ],
  });
  assert.equal(manifest.valid, true);
  const documents = [
    {
      id: 'one.md',
      path: 'one.md',
      content: 'alpha beta',
      graphPrimaryTheme: 'theme-a',
      graphPrimaryTopic: 'topic-a1',
      graphSecondaryTopics: ['topic-a2', 'topic-b1'],
    },
    {
      id: 'two.md',
      path: 'two.md',
      content: 'alpha gamma',
      graphPrimaryTheme: 'theme-a',
      graphPrimaryTopic: 'topic-a1',
      graphSecondaryTopics: ['topic-b1'],
    },
    {
      id: 'three.md',
      path: 'three.md',
      content: 'gamma',
      graphPrimaryTheme: 'theme-b',
      graphPrimaryTopic: 'topic-b1',
    },
  ];
  const model = core.buildHybridGraph(
    core.createGraph(documents.map((document) => document.id)),
    documents,
    {
      projectWeight: 0,
      semanticWeight: 0,
      topicManifest: manifest,
    }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    topicManifest: manifest,
    maxCommunities: 1,
  });

  assert.equal(analysis.colors.get('one.md'), 0xAA1100);
  assert.equal(analysis.colors.get('two.md'), 0xAA1100);
  assert.equal(analysis.colors.get('three.md'), 0x0077CC);
  assert.deepEqual(
    model.documents.get('one.md').knowledgePoints.map((point) => point.key),
    ['topic-a1', 'topic-a2', 'topic-b1']
  );
  assert.equal(analysis.semanticThemes.length, 2);
  assert.equal(analysis.semanticThemes[0].size, 2);
  assert.ok(Math.abs(analysis.semanticThemes[0].percentage - (200 / 3)) < 1e-9);
  assert.equal(analysis.semanticTopics.find((topic) => topic.key === 'topic-a2'), undefined);
});

test('natural-break recommendation is percentage-based and has no theme-count cap', () => {
  // Deliberately synthetic distribution: the largest relative drop follows theme 5.
  const themes = [40, 24, 15, 10, 7, 2, 1.5, 0.5]
    .map((percentage, index) => ({
      key: `theme-${index + 1}`,
      size: Math.round(percentage * 100),
      percentage,
    }));
  const recommended = core.naturalBreakRecommendation(themes);

  assert.deepEqual(
    [...recommended],
    ['theme-1', 'theme-2', 'theme-3', 'theme-4', 'theme-5']
  );
  assert.equal(themes.length, 8);
});

test('secondary-only frontmatter remains unclassified and neutral', () => {
  const manifest = core.normalizeTopicManifest({
    version: 1,
    themes: [{
      key: 'theme-a',
      label: 'Theme A',
      color: '#FF0000',
      topics: [{
        key: 'topic-a',
        label: 'Topic A',
        color: '#ABCDEF',
        terms: ['never-matches'],
      }],
    }],
  });
  const documents = [{
    id: 'secondary-only.md',
    path: 'secondary-only.md',
    content: 'This text does not match the taxonomy.',
    graphSecondaryTopics: ['topic-a'],
  }];
  const model = core.buildHybridGraph(
    core.createGraph(['secondary-only.md']),
    documents,
    { projectWeight: 0, semanticWeight: 0, topicManifest: manifest }
  );
  const analysis = core.analyzeGraph(model.graph, {
    documents: model.documents,
    topicManifest: manifest,
    neutralColor: '#8B92A1',
  });
  const document = model.documents.get('secondary-only.md');
  const unclassified = analysis.semanticThemes.find(
    (theme) => theme.key === '@theme:unclassified'
  );

  assert.deepEqual(document.knowledgePoints, []);
  assert.deepEqual(
    document.secondaryKnowledgePoints.map((point) => point.key),
    ['topic-a']
  );
  assert.equal(analysis.colors.get('secondary-only.md'), 0x8B92A1);
  assert.equal(
    analysis.semanticAssignments.get('secondary-only.md'),
    '@topic:unclassified'
  );
  assert.equal(analysis.neutralCount, 1);
  assert.equal(unclassified.recommended, false);
});

test('does not collapse long notes that differ after the classification excerpt', () => {
  const sharedPrefix = 'x'.repeat(24000);
  const result = core.filterEffectiveDocuments([
    { id: 'Long-A.md', path: 'Long-A.md', content: `${sharedPrefix} A-tail` },
    { id: 'Long-B.md', path: 'Long-B.md', content: `${sharedPrefix} B-tail` },
  ]);

  assert.deepEqual(
    result.effective.map((document) => document.id),
    ['Long-A.md', 'Long-B.md']
  );
  assert.equal(result.excluded.size, 0);
});
