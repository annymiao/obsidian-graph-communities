'use strict';

const DEFAULT_PALETTE = [
  '#5AA9FF',
  '#FF7A7A',
  '#6FE39A',
  '#C58CFF',
  '#FFC857',
  '#46D7D0',
  '#FF86C8',
  '#A8D65E',
  '#FF9F43',
  '#738CFF',
  '#E3A6FF',
  '#6FD0FF',
];

const GENERIC_DOCUMENT_NAMES = new Set([
  'readme', 'index', 'home', 'homepage', 'overview', 'summary', 'contents',
  'toc', 'moc', 'dashboard', 'start', 'welcome', 'docs', 'documentation',
  'resources', 'changelog', 'license', 'contributing', 'sitemap', 'agents',
  'skills', 'library', 'internal', 'site', 'sources', 'source', 'src',
  'references', 'reference', 'examples', 'example', 'tests', 'test', 'github',
  'workflows', 'workflow', 'markdown', 'lectures', 'archive', 'legacy',
  'skill output samples', 'release plans', 'issues archive', 'content',
  '首页', '主页', '目录', '索引', '导航', '总览', '概览', '说明', '欢迎',
  'desktop', 'desktop资料', 'shared knowledge', 'sharedknowledge',
  'shared-knowledge', 'resources', 'resource', '资料', '共享知识', '共用知识',
]);

const GENERIC_TERMS = new Set([
  ...GENERIC_DOCUMENT_NAMES,
  'note', 'notes', 'file', 'files', 'document', 'documents', '项目', '文档',
  '笔记', '内容', '相关', '记录', '工作', '资料', '文件', '知识库',
]);

const CONTENT_TOPIC_RULES = [
  {
    key: 'child-companion',
    label: '儿童陪伴机器人',
    terms: ['儿童陪伴', '陪伴机器人', '宠物伙伴', 'pemory', '儿童模型', '监护人', '家长端'],
  },
  {
    key: 'language-models',
    label: '大语言模型',
    terms: ['language model', 'large language model', 'transformer', 'tokenizer', 'attention', 'rlhf', 'rlvr', 'llm', '语言模型', '大模型', '预训练', '后训练'],
  },
  {
    key: 'speech-asr',
    label: '语音与 ASR',
    terms: ['automatic speech recognition', 'speech recognition', 'speech model', 'asr', '语音识别', '语音模型', '音频', '声学模型'],
  },
  {
    key: 'ai-agents',
    label: 'AI Agent',
    terms: ['coding agent', 'ai agent', 'agentic', 'multi-agent', '智能体', '多智能体', 'codex agent'],
  },
  {
    key: 'ai-systems',
    label: 'AI 系统与训练',
    terms: ['distributed training', 'parallelism', 'inference engine', 'gpu', 'tpu', 'kernel', '训练系统', '分布式训练', '并行训练', '推理系统', '算子优化'],
  },
  {
    key: 'model-evaluation',
    label: '模型评测',
    terms: ['benchmark', 'evaluation', 'evals', '评测', '基准测试', '验收集', '失败样本', '模型选型'],
  },
  {
    key: 'data-compliance',
    label: '数据与合规',
    terms: ['privacy', 'compliance', 'data governance', 'copyright', '隐私', '合规', '数据治理', '版权', '数据红线'],
  },
  {
    key: 'hardware-design',
    label: '硬件与工业设计',
    terms: ['hardware', 'industrial design', 'motor', 'sensor', '硬件', '工业设计', '电机', '传感器', '结构设计'],
  },
  {
    key: 'market-competition',
    label: '市场与竞品',
    terms: ['market research', 'competitor', 'competitive', 'pricing', 'business model', '市场研究', '竞品', '定价', '商业模式'],
  },
  {
    key: 'product-strategy',
    label: '产品策略',
    terms: ['product strategy', 'product vision', 'product roadmap', 'prd', 'user story', '产品策略', '产品定位', '产品规划', '路线图', '用户故事'],
  },
  {
    key: 'prompt-engineering',
    label: 'AI Prompts',
    terms: ['system prompt', 'prompt template', 'prompt engineering', 'you are an ai assistant', '提示词', '系统提示', '提示模板'],
  },
];

const PM_ARTIFACT_TERMS = [
  'product manager', 'product management', '产品经理', '产品管理', 'prd',
  'product roadmap', 'product strategy', 'product vision', 'market sizing',
  'opportunity solution tree', 'user story', 'prioritization', 'go-to-market',
  '产品路线图', '产品策略', '用户故事', '需求优先级', '市场规模',
];

const PROMPT_FORMAT_TERMS = [
  'this prompt', 'prompt template', 'system prompt', 'you are an ai assistant',
  'ask one question at a time', 'instructions:', 'input:', 'output:',
  '提示词', '系统提示', '提示模板', '角色设定', '输出格式',
];

const SKILL_FORMAT_TERMS = [
  'when to use', 'workflow', 'skill', 'framework', 'methodology', 'checklist',
  'step-by-step', 'output contract', '工作流', '技能', '方法论', '框架', '检查清单',
];

function createGraph(nodeIds = []) {
  const graph = new Map();
  for (const id of nodeIds) ensureNode(graph, id);
  return graph;
}

function ensureNode(graph, id) {
  const key = String(id);
  if (!graph.has(key)) graph.set(key, new Map());
  return graph.get(key);
}

function addUndirectedEdge(graph, source, target, weight = 1) {
  const a = String(source);
  const b = String(target);
  const w = Number(weight);
  ensureNode(graph, a);
  ensureNode(graph, b);
  if (a === b || !Number.isFinite(w) || w <= 0) return;
  graph.get(a).set(b, (graph.get(a).get(b) || 0) + w);
  graph.get(b).set(a, (graph.get(b).get(a) || 0) + w);
}

function buildWeightedGraph(edges = [], nodeIds = []) {
  const graph = createGraph(nodeIds);
  for (const edge of edges) {
    if (Array.isArray(edge)) {
      addUndirectedEdge(graph, edge[0], edge[1], edge[2] == null ? 1 : edge[2]);
    } else if (edge && edge.source != null && edge.target != null) {
      addUndirectedEdge(graph, edge.source, edge.target, edge.weight == null ? 1 : edge.weight);
    }
  }
  return graph;
}

function graphFromResolvedLinks(resolvedLinks = {}, nodeIds = []) {
  const graph = createGraph(nodeIds);
  for (const [source, targets] of Object.entries(resolvedLinks || {})) {
    ensureNode(graph, source);
    for (const [target, count] of Object.entries(targets || {})) {
      addUndirectedEdge(graph, source, target, Math.max(1, Number(count) || 1));
    }
  }
  return graph;
}

function cloneGraph(graph, weightTransform = (_source, _target, weight) => weight) {
  const cloned = createGraph(graph.keys());
  const seen = new Set();
  for (const [source, neighbors] of graph.entries()) {
    for (const [target, weight] of neighbors.entries()) {
      const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addUndirectedEdge(cloned, source, target, weightTransform(source, target, weight));
    }
  }
  return cloned;
}

function humanizeSegment(value) {
  return String(value || '')
    .replace(/\.md$/i, '')
    .replace(/^\d{1,3}(?:[._-]|\s)+/u, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTerm(value) {
  return humanizeSegment(value).normalize('NFKC').toLocaleLowerCase().trim();
}

function basenameWithoutExtension(id) {
  const parts = String(id || '').split('/');
  return (parts.pop() || '').replace(/\.md$/i, '');
}

function isGenericLabel(value) {
  const normalized = normalizedTerm(value);
  const compact = normalized.replace(/[\s_-]+/g, '');
  if (!normalized) return true;
  if (GENERIC_DOCUMENT_NAMES.has(normalized) || GENERIC_DOCUMENT_NAMES.has(compact)) return true;
  return /(?:readme|index|homepage|dashboard|overview|contents|desktop资料|sharedknowledge|目录|索引|导航|首页|总览|概览|共用知识|共享知识)/iu.test(compact);
}

function isNavigationDocument(id, document = {}) {
  if (document.navigation != null) return Boolean(document.navigation);
  const values = [basenameWithoutExtension(id), document.title, ...(document.aliases || [])];
  return values.filter(Boolean).some((value) => isGenericLabel(value));
}

function tokenizeSemanticText(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase();
  const terms = new Set();
  for (const match of normalized.matchAll(/[a-z][a-z0-9+#.]{1,}/giu)) {
    const term = match[0].replace(/^[._-]+|[._-]+$/g, '');
    if (term.length >= 2 && !GENERIC_TERMS.has(term)) terms.add(term);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];
    if (chunk.length <= 10 && !GENERIC_TERMS.has(chunk)) terms.add(chunk);
    const maximum = Math.min(4, chunk.length);
    for (let size = 2; size <= maximum; size += 1) {
      for (let index = 0; index <= chunk.length - size && index < 18; index += 1) {
        const term = chunk.slice(index, index + size);
        if (!GENERIC_TERMS.has(term)) terms.add(term);
      }
    }
  }
  return [...terms];
}

function addFeature(target, term, weight) {
  const key = normalizedTerm(term);
  if (!key || GENERIC_TERMS.has(key)) return;
  target.set(key, Math.max(target.get(key) || 0, weight));
}

function addTextFeatures(target, value, weight) {
  for (const term of tokenizeSemanticText(value)) addFeature(target, term, weight);
}

function parsePriorityKeywords(value) {
  const entries = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，;；\n]+/u);
  return [...new Set(entries.map((entry) => normalizedTerm(entry)).filter(Boolean))];
}

function normalizeDocumentInput(input, graph) {
  const source = input instanceof Map
    ? [...input.entries()].map(([id, value]) => ({ id, ...(value || {}) }))
    : Array.isArray(input) ? input : [];
  const byId = new Map(source.map((document) => [String(document.id || document.path), document]));
  const documents = new Map();
  for (const id of graph.keys()) {
    const raw = byId.get(id) || {};
    const path = String(raw.path || id);
    documents.set(id, {
      id,
      path,
      title: String(raw.title || basenameWithoutExtension(path)),
      aliases: asStringArray(raw.aliases),
      tags: asStringArray(raw.tags).map((tag) => tag.replace(/^#/, '')),
      headings: asStringArray(raw.headings).slice(0, 16),
      content: String(raw.content || raw.body || '').slice(0, 24000),
      navigation: raw.navigation,
    });
  }
  return documents;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.flatMap(asStringArray).filter(Boolean);
  if (value == null) return [];
  return String(value).split(/[,，]/u).map((entry) => entry.trim()).filter(Boolean);
}

function deriveProjectAssignments(documents, options = {}) {
  const maximumSize = clamp(Math.round(numericOption(options, 'projectMaxSize', 1200)), 10, 4000);
  const counts = new Map();
  for (const document of documents.values()) {
    const directories = document.path.split('/').slice(0, -1);
    for (let depth = 1; depth <= directories.length; depth += 1) {
      const prefix = directories.slice(0, depth).join('/');
      counts.set(prefix, (counts.get(prefix) || 0) + 1);
    }
  }

  const projects = new Map();
  for (const document of documents.values()) {
    const directories = document.path.split('/').slice(0, -1);
    const prefixes = directories.map((_, index) => directories.slice(0, index + 1).join('/'));
    if (!prefixes.length) {
      projects.set(document.id, {
        key: `@root:${document.id}`,
        label: humanizeSegment(document.title) || 'Root',
        size: 1,
      });
      continue;
    }
    let selected = prefixes.find((prefix) => {
      const label = humanizeSegment(prefix.split('/').pop());
      const count = counts.get(prefix) || 0;
      return count >= 2 && count <= maximumSize && !isGenericLabel(label);
    });
    if (!selected) {
      selected = [...prefixes].reverse().find((prefix) => {
        const label = humanizeSegment(prefix.split('/').pop());
        return (counts.get(prefix) || 0) >= 2 && !isGenericLabel(label);
      });
    }
    if (!selected && prefixes.length) selected = prefixes[0];
    const rawLabel = selected ? selected.split('/').pop() : 'Root';
    const projectLabel = humanizeSegment(rawLabel) || 'Root';
    projects.set(document.id, {
      key: selected || 'Root',
      label: projectLabel,
      size: selected ? counts.get(selected) || 1 : 1,
    });
  }
  return projects;
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) >= 0 && count < 4) {
    count += 1;
    index += term.length;
  }
  return count;
}

function scoreTerms(text, terms) {
  let score = 0;
  for (const term of terms) {
    const count = countOccurrences(text, term);
    if (!count) continue;
    const distinctive = term.includes(' ') || term.length >= 4 ? 1.35 : 1;
    score += distinctive * (1 + Math.min(3, count - 1) * 0.35);
  }
  return score;
}

function taxonomyTagLabel(key) {
  const topic = CONTENT_TOPIC_RULES.find((rule) => rule.key === key);
  if (topic) return topic.label;
  return {
    'product-management': 'Product Management',
    skill: 'Skill',
    prompt: 'Prompt',
    academic: '学术',
    project: '项目',
    reference: '参考资料',
  }[key] || humanizeSegment(key);
}

function inferDocumentTaxonomy(document) {
  const contentText = [
    document.content,
    ...document.tags,
    ...document.headings,
    ...document.aliases,
  ].join('\n').normalize('NFKC').toLocaleLowerCase();
  const fallbackText = [document.title, document.path].join('\n')
    .normalize('NFKC').toLocaleLowerCase();
  const searchable = contentText.trim() ? contentText : fallbackText;
  const topics = CONTENT_TOPIC_RULES
    .map((rule) => ({ ...rule, score: scoreTerms(searchable, rule.terms) }))
    .filter((topic) => topic.score >= 1)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

  const explicitPmScore = scoreTerms(searchable, PM_ARTIFACT_TERMS.slice(0, 4));
  const pmArtifactScore = scoreTerms(searchable, PM_ARTIFACT_TERMS.slice(4));
  const pmCorpus = /(?:^|\/)[^/]*(?:pm[- _]?skills?|pm[- _]?prompts?|product[- _]?manager)[^/]*(?:\/|$)/iu
    .test(document.path.normalize('NFKC').toLocaleLowerCase());
  const promptScore = scoreTerms(searchable, PROMPT_FORMAT_TERMS);
  const skillScore = scoreTerms(searchable, SKILL_FORMAT_TERMS);
  let pmRelated = explicitPmScore >= 2.1 || pmCorpus;
  const promptCorpus = /(?:^|\/)[^/]*(?:product[- _]?manager[- _]?prompts?|pm[- _]?prompts?)[^/]*(?:\/|$)/iu
    .test(document.path.normalize('NFKC').toLocaleLowerCase());
  const pmKind = promptCorpus || (promptScore >= 2.2 && promptScore > skillScore * 0.72)
    ? 'prompt'
    : 'skill';

  let academicScore = scoreTerms(searchable, [
    'stanford', 'university', 'lecture', 'assignment', 'course', 'syllabus',
    'research paper', 'arxiv', 'doi.org', '公开课', '课程', '讲义', '论文', '学术研究',
    '学习合同', '本节主线', '自测题', '视频结合学习版',
  ]);
  if (/(?:stanford|university|公开课|课程|\/lectures?\/)/iu.test(document.path)) {
    academicScore += 3;
  }
  if (!pmCorpus && academicScore >= 2.7) pmRelated = false;
  let projectScore = scoreTerms(searchable, [
    'project plan', 'prototype', 'milestone', 'deliverable', 'acceptance criteria',
    'roadmap', 'supplier', '产品', '项目', '原型', '里程碑', '交付', '验收', '供应商',
  ]);
  if (/^(?:10-work|20-competition)(?:\/|$)/iu.test(document.path)) projectScore += 1;
  if (/type:\s*knowledge-card/iu.test(searchable)) projectScore += 3;
  if (/scope:[\s\S]{0,120}(?:work|competition)/iu.test(searchable)) projectScore += 2;
  const context = academicScore >= 2.7 && academicScore > projectScore + 0.7
    ? 'academic'
    : projectScore >= 2.4 ? 'project' : 'reference';

  return {
    context,
    topics,
    pmRelated,
    pmKind,
    promptScore,
    skillScore,
    pmArtifactScore,
  };
}

function deriveTopicAssignments(documents, directoryProjects) {
  const assignments = new Map();
  const counts = new Map();
  for (const document of documents.values()) {
    const taxonomy = inferDocumentTaxonomy(document);
    const directoryProject = directoryProjects.get(document.id);
    const primary = taxonomy.context === 'project'
      ? taxonomy.topics.find((topic) => topic.key === 'child-companion') || taxonomy.topics[0]
      : taxonomy.topics[0];
    let key;
    let label;
    let weightScale = 1;
    let communityWeight = 1;

    if (taxonomy.pmRelated) {
      const prompts = taxonomy.pmKind === 'prompt';
      key = prompts ? '@topic:pm-prompts' : '@topic:pm-skills';
      label = prompts ? 'PM Prompts' : 'PM Skills';
      weightScale = 0.18;
      communityWeight = 0.12;
    } else if (taxonomy.context === 'academic' && primary) {
      key = `@topic:academic:${primary.key}`;
      label = `学术 · ${primary.label}`;
    } else if (taxonomy.context === 'academic') {
      key = '@topic:academic:general';
      label = '学术 · 研究资料';
    } else if (taxonomy.context === 'project' && primary) {
      const secondary = primary.key === 'child-companion'
        ? taxonomy.topics.find((topic) => topic.key !== 'child-companion' && topic.score >= 1.7)
        : null;
      key = secondary
        ? `@topic:project:${primary.key}:${secondary.key}`
        : `@topic:project:${primary.key}`;
      label = secondary
        ? `项目 · 儿童陪伴 / ${secondary.label}`
        : `项目 · ${primary.label}`;
    } else if (primary) {
      key = `@topic:${primary.key}`;
      label = primary.label;
    } else if (directoryProject && !isGenericLabel(directoryProject.label)) {
      key = directoryProject.key;
      label = directoryProject.label;
    } else {
      key = `@root:${document.id}`;
      label = humanizeSegment(document.title) || 'Unclassified';
    }

    counts.set(key, (counts.get(key) || 0) + 1);
    assignments.set(document.id, {
      key,
      label,
      size: 1,
      weightScale,
      communityWeight,
      context: taxonomy.context,
      contextTags: taxonomy.pmRelated ? ['product-management'] : [taxonomy.context],
      topicTags: taxonomy.pmRelated
        ? ['product-management', taxonomy.pmKind]
        : taxonomy.topics.slice(0, 4).map((topic) => topic.key),
    });
  }
  for (const assignment of assignments.values()) assignment.size = counts.get(assignment.key) || 1;
  return assignments;
}

function buildDocumentFeatures(documents, projects, options = {}) {
  const priorityKeywords = parsePriorityKeywords(options.priorityKeywords);
  const features = new Map();
  for (const document of documents.values()) {
    const vector = new Map();
    const labelTerms = new Map();
    const project = projects.get(document.id);
    addTextFeatures(vector, document.title, 1.5);
    addTextFeatures(labelTerms, document.title, 1.5);
    for (const alias of document.aliases) {
      addTextFeatures(vector, alias, 1.8);
      addTextFeatures(labelTerms, alias, 1.8);
    }
    for (const tag of document.tags) {
      addTextFeatures(vector, tag, 4.2);
      addTextFeatures(labelTerms, tag, 4.2);
    }
    const pathSegments = document.path.split('/').slice(0, -1).map(humanizeSegment);
    pathSegments.forEach((segment, index) => {
      const weight = index === pathSegments.length - 1 ? 0.55 : 0.2;
      addTextFeatures(vector, segment, weight);
      if (!isGenericLabel(segment)) addTextFeatures(labelTerms, segment, weight * 0.5);
    });
    for (const heading of document.headings) addTextFeatures(vector, heading, 1.6);

    for (const context of project?.contextTags || []) {
      vector.set(`@context:${context}`, 4.5);
      labelTerms.set(taxonomyTagLabel(context), 5.5);
    }
    for (const topic of project?.topicTags || []) {
      vector.set(`@topic:${topic}`, topic === 'product-management' ? 2.2 : 5.2);
      labelTerms.set(taxonomyTagLabel(topic), topic === 'product-management' ? 5 : 7);
    }
    if (project && !isGenericLabel(project.label)) labelTerms.set(project.label, 12);

    const searchable = [
      document.title,
      ...document.aliases,
      ...document.tags,
      ...document.headings,
      document.content,
    ].join(' ').normalize('NFKC').toLocaleLowerCase();
    const priorityMatches = priorityKeywords.filter((keyword) => searchable.includes(keyword));
    for (const keyword of priorityMatches) {
      vector.set(`@priority:${keyword}`, 4);
      labelTerms.set(keyword, 8);
    }
    features.set(document.id, { vector, labelTerms, priorityMatches });
  }
  return { features, priorityKeywords };
}

function buildHybridGraph(linkGraph, documentInput = [], options = {}) {
  const documents = normalizeDocumentInput(documentInput, linkGraph);
  const directoryProjects = deriveProjectAssignments(documents, options);
  const projects = deriveTopicAssignments(documents, directoryProjects, options);
  const { features, priorityKeywords } = buildDocumentFeatures(documents, projects, options);
  const linkWeight = clamp(numericOption(options, 'linkWeight', 0.65), 0, 10);
  const navigationPenalty = clamp(numericOption(options, 'navigationLinkPenalty', 0.08), 0, 1);
  const graph = cloneGraph(linkGraph, (source, target, weight) => {
    const sourceNavigation = isNavigationDocument(source, documents.get(source));
    const targetNavigation = isNavigationDocument(target, documents.get(target));
    return weight * linkWeight * (sourceNavigation || targetNavigation ? navigationPenalty : 1);
  });

  addProjectEdges(graph, projects, options);
  addSemanticEdges(graph, features, options);
  for (const [id, document] of documents.entries()) {
    const project = projects.get(id);
    const feature = features.get(id);
    document.projectKey = project && project.key;
    document.projectLabel = project && project.label;
    document.labelTerms = feature && feature.labelTerms;
    document.priorityMatches = feature && feature.priorityMatches;
    document.contextTags = project && project.contextTags;
    document.topicTags = project && project.topicTags;
    document.communityWeight = project?.communityWeight == null ? 1 : project.communityWeight;
    document.navigation = isNavigationDocument(id, document);
  }
  return { graph, documents, projects, directoryProjects, features, priorityKeywords };
}

function addProjectEdges(graph, projects, options = {}) {
  const weight = clamp(numericOption(options, 'projectWeight', 5), 0, 10);
  const neighbors = clamp(Math.round(numericOption(options, 'projectNeighbors', 3)), 0, 12);
  if (weight <= 0 || neighbors <= 0) return;
  const groups = new Map();
  for (const [id, project] of projects.entries()) {
    if (!groups.has(project.key)) {
      groups.set(project.key, { members: [], weightScale: project.weightScale ?? 1 });
    }
    groups.get(project.key).members.push(id);
  }
  for (const group of groups.values()) {
    const members = group.members;
    const groupWeight = weight * group.weightScale;
    members.sort((a, b) => a.localeCompare(b));
    if (members.length < 2) continue;
    const seen = new Set();
    const span = Math.min(neighbors, members.length - 1);
    for (let index = 0; index < members.length; index += 1) {
      for (let offset = 1; offset <= span; offset += 1) {
        const targetIndex = (index + offset) % members.length;
        const source = members[index];
        const target = members[targetIndex];
        const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
        if (seen.has(key)) continue;
        seen.add(key);
        addUndirectedEdge(graph, source, target, groupWeight / Math.sqrt(offset));
      }
    }
  }
}

function addSemanticEdges(graph, features, options = {}) {
  const weight = clamp(numericOption(options, 'semanticWeight', 1.4), 0, 12);
  const neighborLimit = clamp(Math.round(numericOption(options, 'semanticNeighbors', 10)), 0, 30);
  const minimumSimilarity = clamp(numericOption(options, 'semanticThreshold', 0.08), 0, 1);
  if (weight <= 0 || neighborLimit <= 0) return;

  const documentCount = Math.max(1, features.size);
  const postings = new Map();
  for (const [id, feature] of features.entries()) {
    for (const [term, value] of feature.vector.entries()) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([id, value]);
    }
  }
  const norms = new Map([...features.keys()].map((id) => [id, 0]));
  const weightedPostings = new Map();
  for (const [term, entries] of postings.entries()) {
    if (entries.length < 2) continue;
    const idf = Math.log((documentCount + 1) / (entries.length + 1)) + 1;
    const weighted = entries.map(([id, value]) => [id, value * idf]);
    weightedPostings.set(term, weighted);
    for (const [id, value] of weighted) norms.set(id, (norms.get(id) || 0) + value * value);
  }
  for (const [id, value] of norms.entries()) norms.set(id, Math.sqrt(value) || 1);

  const dots = new Map();
  const maximumPosting = Math.max(24, Math.round(documentCount * 0.16));
  for (const [term, entries] of weightedPostings.entries()) {
    const isPriority = term.startsWith('@priority:');
    if (!isPriority && entries.length > maximumPosting) continue;
    entries.sort((a, b) => a[0].localeCompare(b[0]));
    const span = entries.length <= 48 ? entries.length - 1 : 8;
    for (let index = 0; index < entries.length; index += 1) {
      for (let offset = 1; offset <= span && offset < entries.length; offset += 1) {
        const targetIndex = (index + offset) % entries.length;
        if (index === targetIndex) continue;
        const [source, sourceValue] = entries[index];
        const [target, targetValue] = entries[targetIndex];
        const key = source < target ? `${source}\u0000${target}` : `${target}\u0000${source}`;
        dots.set(key, (dots.get(key) || 0) + sourceValue * targetValue);
      }
    }
  }

  const candidates = new Map([...features.keys()].map((id) => [id, []]));
  for (const [key, dot] of dots.entries()) {
    const [source, target] = key.split('\u0000');
    const similarity = dot / ((norms.get(source) || 1) * (norms.get(target) || 1));
    if (similarity < minimumSimilarity) continue;
    candidates.get(source).push({ source, target, similarity });
    candidates.get(target).push({ source, target, similarity });
  }
  const selected = new Map();
  for (const edges of candidates.values()) {
    edges.sort((a, b) => b.similarity - a.similarity || a.target.localeCompare(b.target));
    for (const edge of edges.slice(0, neighborLimit)) {
      const key = edge.source < edge.target
        ? `${edge.source}\u0000${edge.target}`
        : `${edge.target}\u0000${edge.source}`;
      selected.set(key, Math.max(selected.get(key) || 0, edge.similarity));
    }
  }
  for (const [key, similarity] of selected.entries()) {
    const [source, target] = key.split('\u0000');
    addUndirectedEdge(graph, source, target, similarity * weight);
  }
}

function weightedDegree(graph, node) {
  let total = 0;
  for (const weight of (graph.get(node) || new Map()).values()) total += weight;
  return total;
}

function totalEdgeWeight(graph) {
  let sum = 0;
  for (const node of graph.keys()) sum += weightedDegree(graph, node);
  return sum / 2;
}

function toIndexedGraph(graph) {
  const ids = [...graph.keys()].sort((a, b) => a.localeCompare(b));
  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = ids.map(() => new Map());
  for (const [source, neighbors] of graph.entries()) {
    const i = index.get(source);
    if (i == null) continue;
    for (const [target, weight] of neighbors.entries()) {
      const j = index.get(target);
      if (j == null || weight <= 0) continue;
      adjacency[i].set(j, (adjacency[i].get(j) || 0) + weight);
    }
  }
  return { ids, adjacency };
}

function deterministicOrder(length, seed) {
  const values = Array.from({ length }, (_, i) => i);
  let state = (seed >>> 0) || 0x9e3779b9;
  const random = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function renumberPartition(partition) {
  const mapping = new Map();
  let next = 0;
  return partition.map((community) => {
    if (!mapping.has(community)) mapping.set(community, next++);
    return mapping.get(community);
  });
}

function oneLouvainLevel(adjacency, resolution, maxPasses, seed) {
  const count = adjacency.length;
  const communities = Array.from({ length: count }, (_, i) => i);
  const degrees = adjacency.map((neighbors) => {
    let sum = 0;
    for (const weight of neighbors.values()) sum += weight;
    return sum;
  });
  const totalDegree = degrees.reduce((sum, value) => sum + value, 0);
  const totals = degrees.slice();
  if (totalDegree <= 0) return { partition: communities, moved: false };

  let movedAtLeastOnce = false;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    let movedThisPass = false;
    const order = deterministicOrder(count, seed + pass * 7919);
    for (const node of order) {
      const degree = degrees[node];
      if (degree <= 0) continue;
      const current = communities[node];
      const weightsByCommunity = new Map();
      for (const [neighbor, weight] of adjacency[node].entries()) {
        if (neighbor === node) continue;
        const community = communities[neighbor];
        weightsByCommunity.set(
          community,
          (weightsByCommunity.get(community) || 0) + weight
        );
      }

      totals[current] -= degree;
      let best = current;
      let bestGain = 0;
      const candidates = [...weightsByCommunity.keys()].sort((a, b) => a - b);
      if (!weightsByCommunity.has(current)) candidates.push(current);
      for (const community of candidates) {
        const connectedWeight = weightsByCommunity.get(community) || 0;
        const gain =
          connectedWeight - resolution * ((totals[community] || 0) * degree) / totalDegree;
        if (
          gain > bestGain + 1e-12 ||
          (Math.abs(gain - bestGain) <= 1e-12 && gain > 0 && community < best)
        ) {
          best = community;
          bestGain = gain;
        }
      }
      communities[node] = best;
      totals[best] = (totals[best] || 0) + degree;
      if (best !== current) {
        movedThisPass = true;
        movedAtLeastOnce = true;
      }
    }
    if (!movedThisPass) break;
  }
  return { partition: renumberPartition(communities), moved: movedAtLeastOnce };
}

function inducedGraph(adjacency, partition, communityCount) {
  const induced = Array.from({ length: communityCount }, () => new Map());
  for (let node = 0; node < adjacency.length; node += 1) {
    const sourceCommunity = partition[node];
    for (const [neighbor, weight] of adjacency[node].entries()) {
      const targetCommunity = partition[neighbor];
      induced[sourceCommunity].set(
        targetCommunity,
        (induced[sourceCommunity].get(targetCommunity) || 0) + weight
      );
    }
  }
  return induced;
}

function louvainPartition(graph, options = {}) {
  const resolution = clamp(Number(options.resolution) || 1, 0.1, 4);
  const maxPasses = clamp(Math.round(Number(options.maxPasses) || 20), 1, 100);
  const maxLevels = clamp(Math.round(Number(options.maxLevels) || 10), 1, 30);
  const { ids, adjacency: initialAdjacency } = toIndexedGraph(graph);
  if (!ids.length) return new Map();

  let adjacency = initialAdjacency;
  let members = ids.map((_, index) => [index]);
  for (let level = 0; level < maxLevels; level += 1) {
    const { partition } = oneLouvainLevel(
      adjacency,
      resolution,
      maxPasses,
      0x51f15e + level * 104729
    );
    const communityCount = Math.max(...partition) + 1;
    const nextMembers = Array.from({ length: communityCount }, () => []);
    for (let node = 0; node < partition.length; node += 1) {
      nextMembers[partition[node]].push(...members[node]);
    }
    members = nextMembers;
    if (communityCount === adjacency.length) break;
    adjacency = inducedGraph(adjacency, partition, communityCount);
    if (communityCount <= 1) break;
  }

  const result = new Map();
  members.forEach((originalIndexes, community) => {
    for (const index of originalIndexes) result.set(ids[index], community);
  });
  return result;
}

function consolidateCommunities(graph, rawPartition, options = {}) {
  const maxCommunities = clamp(
    Math.round(Number(options.maxCommunities) || DEFAULT_PALETTE.length),
    2,
    36
  );
  const minCommunitySize = clamp(
    Math.round(Number(options.minCommunitySize) || 2),
    1,
    1000
  );
  const documents = options.documents instanceof Map ? options.documents : new Map();
  const hasProjects = [...documents.values()].some(
    (document) => document.projectKey && !document.projectKey.startsWith('@root:')
  );
  if (hasProjects && options.projectFirst !== false) {
    return consolidateByProject(graph, documents, maxCommunities, minCommunitySize);
  }
  const groups = new Map();
  for (const node of graph.keys()) {
    if (weightedDegree(graph, node) <= 0) continue;
    const raw = rawPartition.get(node);
    if (raw == null) continue;
    if (!groups.has(raw)) groups.set(raw, []);
    groups.get(raw).push(node);
  }
  const ranked = [...groups.entries()]
    .map(([raw, nodes]) => ({
      raw,
      nodes,
      score: nodes.reduce((sum, node) => sum + weightedDegree(graph, node), 0),
      projectKey: dominantProjectKey(nodes, documents),
    }))
    .sort((a, b) => b.score - a.score || b.nodes.length - a.nodes.length || a.raw - b.raw);

  let eligible = ranked.filter((group) => group.nodes.length >= minCommunitySize);
  if (!eligible.length && ranked.length) eligible = [ranked[0]];
  const kept = [];
  const usedProjects = new Set();
  for (const group of eligible) {
    if (kept.length >= maxCommunities) break;
    if (group.projectKey && usedProjects.has(group.projectKey)) continue;
    kept.push(group);
    if (group.projectKey) usedProjects.add(group.projectKey);
  }
  const preferProjectDiversity = documents.size > 0 && options.preferProjectDiversity !== false;
  if (!preferProjectDiversity) {
    for (const group of eligible) {
      if (kept.length >= maxCommunities) break;
      if (!kept.includes(group)) kept.push(group);
    }
  }
  const keptRaw = new Map(kept.map((group, index) => [group.raw, index]));
  const keptProject = new Map();
  for (const group of kept) {
    if (group.projectKey && !keptProject.has(group.projectKey)) {
      keptProject.set(group.projectKey, keptRaw.get(group.raw));
    }
  }
  const assignments = new Map([...graph.keys()].map((node) => [node, -1]));
  for (const group of kept) {
    const finalCommunity = keptRaw.get(group.raw);
    for (const node of group.nodes) assignments.set(node, finalCommunity);
  }

  for (const group of ranked) {
    if (keptRaw.has(group.raw)) continue;
    const weights = new Map();
    for (const node of group.nodes) {
      for (const [neighbor, weight] of (graph.get(node) || new Map()).entries()) {
        const neighborRaw = rawPartition.get(neighbor);
        const finalCommunity = keptRaw.get(neighborRaw);
        if (finalCommunity == null) continue;
        weights.set(finalCommunity, (weights.get(finalCommunity) || 0) + weight);
      }
    }
    let best = group.projectKey && keptProject.has(group.projectKey)
      ? keptProject.get(group.projectKey)
      : -1;
    let bestWeight = 0;
    if (best < 0) {
      for (const [community, weight] of weights.entries()) {
        if (weight > bestWeight || (weight === bestWeight && community < best)) {
          best = community;
          bestWeight = weight;
        }
      }
    }
    for (const node of group.nodes) assignments.set(node, best);
  }
  return assignments;
}

function consolidateByProject(graph, documents, maxCommunities, minCommunitySize) {
  const projectGroups = new Map();
  for (const node of graph.keys()) {
    const document = documents.get(node) || {};
    const key = document.projectKey;
    if (!key || key.startsWith('@root:')) continue;
    if (!projectGroups.has(key)) {
      projectGroups.set(key, { key, label: document.projectLabel, nodes: [] });
    }
    projectGroups.get(key).nodes.push(node);
  }
  const ranked = [...projectGroups.values()]
    .filter((group) => group.nodes.length >= minCommunitySize)
    .map((group) => ({
      ...group,
      effectiveSize: group.nodes.reduce(
        (sum, node) => sum + (documents.get(node)?.communityWeight ?? 1),
        0
      ),
      score: group.nodes.reduce((sum, node) => sum + weightedDegree(graph, node), 0),
    }))
    .sort((a, b) => b.effectiveSize - a.effectiveSize || b.score - a.score ||
      b.nodes.length - a.nodes.length || a.key.localeCompare(b.key));
  if (!ranked.length) return new Map([...graph.keys()].map((node) => [node, -1]));

  const kept = ranked.filter((group) => /^@topic:pm-(?:skills|prompts)$/u.test(group.key));
  const keepDiverseGroups = (pattern, limit) => {
    let added = 0;
    for (const group of ranked) {
      if (kept.length >= maxCommunities || added >= limit) break;
      if (pattern.test(group.key) && !kept.includes(group)) {
        kept.push(group);
        added += 1;
      }
    }
  };
  keepDiverseGroups(/^@topic:project:/u, 4);
  keepDiverseGroups(/^@topic:academic:/u, 2);
  for (const group of ranked) {
    if (kept.length >= maxCommunities) break;
    if (!kept.includes(group)) kept.push(group);
  }
  const communityByProject = new Map(kept.map((group, index) => [group.key, index]));
  const assignments = new Map([...graph.keys()].map((node) => [node, -1]));
  for (const group of kept) {
    const community = communityByProject.get(group.key);
    for (const node of group.nodes) assignments.set(node, community);
  }

  for (const group of ranked) {
    if (kept.includes(group)) continue;
    const weights = new Map();
    for (const node of group.nodes) {
      for (const [neighbor, weight] of (graph.get(node) || new Map()).entries()) {
        const community = assignments.get(neighbor);
        if (community == null || community < 0) continue;
        weights.set(community, (weights.get(community) || 0) + weight);
      }
    }
    const best = [...weights.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? -1;
    for (const node of group.nodes) assignments.set(node, best);
  }

  for (const node of graph.keys()) {
    if ((assignments.get(node) ?? -1) >= 0) continue;
    const weights = new Map();
    for (const [neighbor, weight] of (graph.get(node) || new Map()).entries()) {
      const community = assignments.get(neighbor);
      if (community == null || community < 0) continue;
      weights.set(community, (weights.get(community) || 0) + weight);
    }
    const best = [...weights.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
    if (best != null) assignments.set(node, best);
  }
  return assignments;
}

function dominantProjectKey(nodes, documents) {
  const counts = new Map();
  for (const node of nodes) {
    const key = documents.get(node) && documents.get(node).projectKey;
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

function chooseHubs(graph, assignments, documents = new Map()) {
  const clusters = new Map();
  for (const [node, community] of assignments.entries()) {
    if (community < 0) continue;
    if (!clusters.has(community)) clusters.set(community, []);
    clusters.get(community).push(node);
  }
  const hubs = new Map();
  for (const [community, nodes] of clusters.entries()) {
    nodes.sort((a, b) => {
      const scoreDifference = representativeScore(graph, b, documents.get(b)) -
        representativeScore(graph, a, documents.get(a));
      return scoreDifference || a.localeCompare(b);
    });
    hubs.set(community, nodes[0]);
  }
  return hubs;
}

function representativeScore(graph, node, document = {}) {
  const degreeScore = Math.log1p(weightedDegree(graph, node));
  const titleTerms = tokenizeSemanticText(document.title || basenameWithoutExtension(node));
  const informationBonus = 1 + Math.min(0.45, titleTerms.length * 0.045);
  const navigationFactor = isNavigationDocument(node, document) ? 0.06 : 1;
  return degreeScore * informationBonus * navigationFactor;
}

function summarizeCommunity(nodes, documents, priorityKeywords = [], preferProjects = true) {
  const projectScores = new Map();
  const priorityScores = new Map();
  const termScores = new Map();
  for (const node of nodes) {
    const document = documents.get(node) || {};
    if (document.projectLabel && !isGenericLabel(document.projectLabel)) {
      projectScores.set(
        document.projectLabel,
        (projectScores.get(document.projectLabel) || 0) + 1
      );
    }
    for (const keyword of document.priorityMatches || []) {
      priorityScores.set(keyword, (priorityScores.get(keyword) || 0) + 1);
    }
    for (const [term, weight] of document.labelTerms || []) {
      if (isGenericLabel(term) || GENERIC_TERMS.has(normalizedTerm(term))) continue;
      termScores.set(term, (termScores.get(term) || 0) + weight);
    }
  }

  const rank = (scores) => [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const priorityOrder = new Map(priorityKeywords.map((keyword, index) => [keyword, index]));
  const priorityRanked = rank(priorityScores).sort((a, b) => {
    const aOrder = priorityOrder.has(a[0]) ? priorityOrder.get(a[0]) : Number.MAX_SAFE_INTEGER;
    const bOrder = priorityOrder.has(b[0]) ? priorityOrder.get(b[0]) : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder || b[1] - a[1] || a[0].localeCompare(b[0]);
  });
  const projectRanked = rank(projectScores);
  const termRanked = rank(termScores);
  const strongPriorityMinimum = Math.max(2, Math.ceil(nodes.length * 0.55));
  const fallbackPriorityMinimum = Math.max(2, Math.ceil(nodes.length * 0.25));
  const projectMinimum = Math.max(2, Math.ceil(nodes.length * 0.15));
  let label;
  if (preferProjects && projectRanked[0] && projectRanked[0][1] >= projectMinimum) {
    label = projectRanked[0][0];
  } else if (priorityRanked[0] && priorityRanked[0][1] >= strongPriorityMinimum) {
    label = priorityRanked[0][0];
  } else if (priorityRanked[0] && priorityRanked[0][1] >= fallbackPriorityMinimum) {
    label = priorityRanked[0][0];
  } else if (projectRanked[0] && projectRanked[0][1] >= projectMinimum) {
    label = projectRanked[0][0];
  } else if (termRanked[0]) {
    label = termRanked[0][0];
  } else {
    label = 'Community';
  }
  const keywords = [...new Set([
    ...projectRanked.map(([term]) => term),
    ...termRanked.map(([term]) => term),
    ...priorityRanked.map(([term]) => term),
  ])]
    .filter((term) => term !== label && !isGenericLabel(term))
    .slice(0, 4);
  return { label: humanizeSegment(label) || 'Community', keywords };
}

function normalizeVector(vector) {
  const sum = vector.reduce((total, value) => total + value, 0);
  if (sum <= 0) return vector;
  return vector.map((value) => value / sum);
}

function numericOption(options, key, fallback) {
  const value = Number(options[key]);
  return Number.isFinite(value) ? value : fallback;
}

function propagateAffinities(graph, assignments, hubs, communityCount, options = {}) {
  const steps = clamp(Math.round(numericOption(options, 'propagationSteps', 4)), 0, 20);
  const strength = clamp(numericOption(options, 'propagationStrength', 0.52), 0, 0.95);
  const hubAnchor = clamp(numericOption(options, 'hubAnchor', 0.72), 0, 1);
  const oneHot = new Map();
  for (const node of graph.keys()) {
    const vector = Array(communityCount).fill(0);
    const community = assignments.get(node);
    if (community != null && community >= 0) vector[community] = 1;
    oneHot.set(node, vector);
  }
  let current = new Map([...oneHot.entries()].map(([node, vector]) => [node, vector.slice()]));

  for (let step = 0; step < steps; step += 1) {
    const next = new Map();
    for (const node of graph.keys()) {
      const base = oneHot.get(node);
      const vector = base.map((value) => value * (1 - strength));
      const degree = weightedDegree(graph, node);
      if (degree > 0) {
        for (const [neighbor, weight] of graph.get(node).entries()) {
          const neighborVector = current.get(neighbor);
          if (!neighborVector) continue;
          const ratio = (strength * weight) / degree;
          for (let i = 0; i < communityCount; i += 1) {
            vector[i] += neighborVector[i] * ratio;
          }
        }
      }
      next.set(node, normalizeVector(vector));
    }
    for (const [community, hub] of hubs.entries()) {
      const vector = next.get(hub) || Array(communityCount).fill(0);
      vector[community] += hubAnchor;
      next.set(hub, normalizeVector(vector));
    }
    current = next;
  }

  for (const [community, hub] of hubs.entries()) {
    const vector = Array(communityCount).fill(0);
    vector[community] = 1;
    current.set(hub, vector);
  }
  return current;
}

function hslToRgbInt(hue, saturation = 0.72, lightness = 0.6) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const s = clamp(saturation, 0, 1);
  const l = clamp(lightness, 0, 1);
  if (s === 0) {
    const gray = Math.round(l * 255);
    return (gray << 16) | (gray << 8) | gray;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const convert = (t0) => {
    let t = t0;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = Math.round(convert(h + 1 / 3) * 255);
  const g = Math.round(convert(h) * 255);
  const b = Math.round(convert(h - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

function hexToRgbInt(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{3}$|^[0-9a-fA-F]{6}$/.test(normalized)) return 0x8b92a1;
  const expanded =
    normalized.length === 3
      ? normalized.split('').map((character) => character + character).join('')
      : normalized;
  return parseInt(expanded, 16);
}

function rgbIntToHex(rgb) {
  return `#${(rgb >>> 0).toString(16).padStart(6, '0').slice(-6).toUpperCase()}`;
}

function srgbToLinear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(channel) {
  const value = channel <= 0.0031308
    ? channel * 12.92
    : 1.055 * Math.pow(channel, 1 / 2.4) - 0.055;
  return Math.round(clamp(value, 0, 1) * 255);
}

function blendRgbInts(colors, weights) {
  let total = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  for (let i = 0; i < colors.length; i += 1) {
    const weight = Math.max(0, Number(weights[i]) || 0);
    if (!weight) continue;
    const color = colors[i];
    red += srgbToLinear((color >> 16) & 0xff) * weight;
    green += srgbToLinear((color >> 8) & 0xff) * weight;
    blue += srgbToLinear(color & 0xff) * weight;
    total += weight;
  }
  if (!total) return 0x8b92a1;
  const r = linearToSrgb(red / total);
  const g = linearToSrgb(green / total);
  const b = linearToSrgb(blue / total);
  return (r << 16) | (g << 8) | b;
}

function mixRgb(a, b, amount) {
  return blendRgbInts([a, b], [1 - clamp(amount, 0, 1), clamp(amount, 0, 1)]);
}

function generatePalette(count, configuredPalette = DEFAULT_PALETTE) {
  const colors = configuredPalette.map(hexToRgbInt);
  const goldenAngle = 137.507764;
  while (colors.length < count) {
    colors.push(hslToRgbInt(210 + goldenAngle * colors.length, 0.76, 0.61));
  }
  return colors.slice(0, count);
}

function colorize(graph, assignments, hubs, affinities, options = {}) {
  const communityCount = hubs.size;
  const palette = generatePalette(communityCount, options.palette || DEFAULT_PALETTE);
  const neutral = hexToRgbInt(options.neutralColor || '#8B92A1');
  const peripheralFade = clamp(numericOption(options, 'peripheralFade', 0.18), 0, 0.85);
  const maxDegree = Math.max(1, ...[...graph.keys()].map((node) => weightedDegree(graph, node)));
  const hubSet = new Set(hubs.values());
  const documents = options.documents instanceof Map ? options.documents : new Map();
  const colors = new Map();
  for (const node of graph.keys()) {
    const vector = affinities.get(node) || [];
    if (!vector.length || vector.every((value) => value <= 0)) {
      colors.set(node, neutral);
      continue;
    }
    const mixed = blendRgbInts(palette, vector);
    if (hubSet.has(node)) {
      colors.set(node, palette[assignments.get(node)] || mixed);
      continue;
    }
    const degreeRatio = Math.log1p(weightedDegree(graph, node)) / Math.log1p(maxDegree);
    const confidence = Math.max(...vector);
    const communityWeight = clamp(documents.get(node)?.communityWeight ?? 1, 0, 1);
    const corpusFade = (1 - communityWeight) * 0.28;
    const fade = clamp(
      peripheralFade * (1 - degreeRatio) * (0.65 + 0.35 * (1 - confidence)) + corpusFade,
      0,
      0.72
    );
    colors.set(node, mixRgb(mixed, neutral, fade));
  }
  return { colors, palette };
}

function analyzeGraph(graph, options = {}) {
  const documents = options.documents instanceof Map
    ? options.documents
    : normalizeDocumentInput(options.documents || [], graph);
  const analysisOptions = { ...options, documents };
  const rawPartition = louvainPartition(graph, analysisOptions);
  const assignments = consolidateCommunities(graph, rawPartition, analysisOptions);
  const hubs = chooseHubs(graph, assignments, documents);
  const affinities = propagateAffinities(
    graph,
    assignments,
    hubs,
    hubs.size,
    options
  );
  const { colors, palette } = colorize(graph, assignments, hubs, affinities, options);
  const usedLabels = new Map();
  const usedFinalLabels = new Set();
  const clusters = [...hubs.entries()].map(([id, hub]) => {
    const nodes = [...assignments.entries()]
      .filter(([, community]) => community === id)
      .map(([node]) => node);
    const summary = summarizeCommunity(
      nodes,
      documents,
      options.priorityKeywords || [],
      options.projectFirst !== false
    );
    const baseLabel = displayTopicLabel(summary.label);
    let label = baseLabel;
    const duplicateCount = usedLabels.get(baseLabel) || 0;
    if (duplicateCount > 0) {
      const qualifier = summary.keywords.find(
        (keyword) => displayTopicLabel(keyword) !== baseLabel
      );
      label = qualifier ? `${label} · ${displayTopicLabel(qualifier)}` : `${label} ${duplicateCount + 1}`;
    }
    if (usedFinalLabels.has(label)) label = `${label} ${duplicateCount + 1}`;
    usedLabels.set(baseLabel, duplicateCount + 1);
    usedFinalLabels.add(label);
    return {
      id,
      hub,
      label,
      keywords: summary.keywords.map(displayTopicLabel),
      color: palette[id],
      colorHex: rgbIntToHex(palette[id]),
      size: nodes.length,
      totalDegree: nodes.reduce((sum, node) => sum + weightedDegree(graph, node), 0),
    };
  });
  return {
    graph,
    assignments,
    affinities,
    colors,
    palette,
    clusters,
    neutralCount: [...assignments.values()].filter((community) => community < 0).length,
    nodeCount: graph.size,
    edgeWeight: totalEdgeWeight(graph),
  };
}

function displayTopicLabel(value) {
  const label = humanizeSegment(value) || 'Community';
  return /^[a-z][a-z0-9+#.]{1,4}$/i.test(label) ? label.toUpperCase() : label;
}

function colorDistance(a, b) {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

module.exports = {
  DEFAULT_PALETTE,
  addUndirectedEdge,
  analyzeGraph,
  blendRgbInts,
  buildHybridGraph,
  buildWeightedGraph,
  chooseHubs,
  colorDistance,
  consolidateCommunities,
  createGraph,
  ensureNode,
  graphFromResolvedLinks,
  hexToRgbInt,
  humanizeSegment,
  isNavigationDocument,
  louvainPartition,
  mixRgb,
  propagateAffinities,
  parsePriorityKeywords,
  rgbIntToHex,
  totalEdgeWeight,
  weightedDegree,
};
