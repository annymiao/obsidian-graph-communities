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

const CHILD_COMPANION_PARENT = {
  key: '@parent:child-companion-work',
  label: '儿童陪伴机器人（工作）',
  color: '#DC2626',
};

const PM_SUMMARY_PARENT = {
  key: '@parent:pm-summary',
  label: 'PM 资料总结',
  color: '#2563EB',
};

const PM_SUMMARY_DOMAINS = [
  {
    key: 'strategy-discovery',
    label: 'PM · 战略与发现',
    color: '#2563EB',
    tag: 'pm summary strategy discovery',
  },
  {
    key: 'execution-growth',
    label: 'PM · 执行与增长',
    color: '#7C3AED',
    tag: 'pm summary execution growth',
  },
  {
    key: 'data-tools',
    label: 'PM · 数据与工具',
    color: '#0891B2',
    tag: 'pm summary data tools',
  },
  {
    key: 'prompts-workflows',
    label: 'PM · 提示词与工作流',
    color: '#C026D3',
    tag: 'pm summary prompts workflows',
  },
];

const PM_SUMMARY_COLORS = new Map(
  PM_SUMMARY_DOMAINS.map((domain) => [domain.label, domain.color])
);

const CHILD_COMPANION_COLORS = new Map([
  ['产品规划与立项', '#EF4444'],
  ['合作与课题研究', '#F43F5E'],
  ['合规与法务', '#BE185D'],
  ['竞品与市场研究', '#EC4899'],
  ['工业设计与供应商', '#DB2777'],
  ['技术与岗位', '#C026D3'],
  ['演示与汇报', '#FB7185'],
  ['端侧研发与验证', '#A855F7'],
  ['招聘', '#E11D48'],
  ['儿童发展与发展心理学', '#DB2777'],
  ['儿童心理与情绪支持', '#BE185D'],
  ['教育学与学习科学', '#F43F5E'],
  ['语言发展与亲子沟通', '#FB7185'],
  ['习惯形成与行为设计', '#E11D48'],
  ['运动发展与具身活动', '#C026D3'],
  ['儿童交互与体验设计', '#EC4899'],
  ['家庭系统与亲子支持', '#C0266D'],
  ['儿童安全与非诊断边界', '#A855F7'],
  ['适龄内容与版权治理', '#D946EF'],
  ['儿童语音与 ASR', '#B91C5C'],
  ['多模态感知与状态估计', '#C2417A'],
  ['轮次管理与安全状态机', '#A21CAF'],
  ['数据隐私与合规治理', '#9D174D'],
  ['硬件与工业设计', '#DB2777'],
  ['机器人控制与物理安全', '#BE123C'],
  ['产品战略与产品发现', '#EF4444'],
  ['产品规划与交付执行', '#F43F5E'],
  ['市场、竞品与商业模式', '#EC4899'],
  ['产品数据、实验与增长', '#D946EF'],
]);

// Knowledge colors are organized as adjacent hue bands. A note's primary
// knowledge point selects the band position; secondary points only tint the
// node inside that neighborhood. This keeps colors semantic and stable across
// recomputes instead of tying them to whichever community happens to rank first.
const KNOWLEDGE_DOMAIN_STYLES = new Map([
  ['儿童发展与教育', { hue: 18, spread: 42, saturation: 0.82, lightness: 0.56 }],
  ['产品与商业', { hue: 45, spread: 24, saturation: 0.84, lightness: 0.50 }],
  ['硬件与具身', { hue: 145, spread: 30, saturation: 0.72, lightness: 0.43 }],
  ['AI 与工程', { hue: 211, spread: 52, saturation: 0.80, lightness: 0.52 }],
  ['治理与证据', { hue: 267, spread: 34, saturation: 0.76, lightness: 0.54 }],
  ['交互与安全', { hue: 322, spread: 44, saturation: 0.78, lightness: 0.52 }],
]);

const CHILD_COMPANION_DOMAIN_STYLES = new Map([
  ['儿童发展与教育', { hue: 358, spread: 24, saturation: 0.88, lightness: 0.56 }],
  ['产品与商业', { hue: 15, spread: 24, saturation: 0.90, lightness: 0.55 }],
  ['硬件与具身', { hue: 338, spread: 18, saturation: 0.80, lightness: 0.48 }],
  ['交互与安全', { hue: 320, spread: 22, saturation: 0.82, lightness: 0.50 }],
  ['治理与证据', { hue: 300, spread: 18, saturation: 0.82, lightness: 0.46 }],
  ['AI 与工程', { hue: 285, spread: 22, saturation: 0.76, lightness: 0.52 }],
]);

const CORE_CHILD_KNOWLEDGE_KEYS = [
  'child-hci',
  'language-development',
  'habit-behavior',
  'emotional-psychology',
  'motor-embodiment',
  'learning-science',
  'child-development',
  'safety-ethics',
  'family-systems',
  'speech-asr',
  'data-compliance',
  'hardware-design',
  'robotics-control',
  'market-competition',
  'product-execution',
];

const CHILD_COMPANION_CHILD_LABELS = [
  '产品规划与立项',
  '合作与课题研究',
  '端侧研发与验证',
  '竞品与市场研究',
  '合规与法务',
  '工业设计与供应商',
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
    domain: '项目语境',
    contextOnly: true,
    terms: ['儿童陪伴', '陪伴机器人', '宠物伙伴', '儿童模型', '家长端'],
  },
  {
    key: 'child-development',
    label: '儿童发展与发展心理学',
    domain: '儿童发展与教育',
    terms: ['儿童发展', '发展心理', '发展阶段', '认知发展', '社会性发展', '依恋', '执行功能', '分龄', '年龄阶段', '3-5 岁', '3–5 岁', '6-8 岁', '6–8 岁'],
  },
  {
    key: 'emotional-psychology',
    label: '儿童心理与情绪支持',
    domain: '儿童发展与教育',
    terms: ['儿童心理', '情绪陪护', '情绪支持', '情绪调节', '情绪识别', '情绪感知', '心理安全', '安抚', '哭泣', '低落', '害怕', 'emotion support', 'emotional regulation'],
  },
  {
    key: 'learning-science',
    label: '教育学与学习科学',
    domain: '儿童发展与教育',
    terms: ['教育学', '学习科学', '教学设计', '认知负荷', '脚手架', '游戏化学习', '分级阅读', '幼小衔接', '教研', '识字', '数学启蒙', '英语口语', '绘本', 'learning science', 'pedagogy'],
  },
  {
    key: 'language-development',
    label: '语言发展与亲子沟通',
    domain: '儿童发展与教育',
    terms: ['语言发展', '儿童语言', '表达陪伴', '表达转译', '亲子沟通', '复述确认', '低压力追问', '事件表达', '叙事能力', '语用', '语言能力', 'language development'],
  },
  {
    key: 'habit-behavior',
    label: '习惯形成与行为设计',
    domain: '儿童发展与教育',
    terms: ['习惯养成', '习惯形成', '行为设计', '行为改变', '正向强化', '奖励机制', '生活习惯', '刷牙', '睡前准备', '收拾玩具', 'habit formation', 'behavior design'],
  },
  {
    key: 'motor-embodiment',
    label: '运动发展与具身活动',
    domain: '儿童发展与教育',
    terms: ['运动发展', '身体活动', '动作模仿', '身体部位认知', '节奏律动', '粗大动作', '具身认知', '投影跳格子', 'motor development', 'embodied cognition'],
  },
  {
    key: 'child-hci',
    label: '儿童交互与体验设计',
    domain: '交互与安全',
    terms: ['儿童交互', '人机交互', '宠物化体验', '宠物感', '陪伴体验', '触摸反馈', '表情屏', '多模态交互', '可拒绝', '可退出', 'child-computer interaction', 'human-computer interaction'],
  },
  {
    key: 'family-systems',
    label: '家庭系统与亲子支持',
    domain: '交互与安全',
    terms: ['亲子支持', '家庭支持', '家庭系统', '家庭规则', '家长观察', '家长周报', '监护人', '家长端', '家庭场景', '亲子关系', 'family system'],
  },
  {
    key: 'safety-ethics',
    label: '儿童安全与非诊断边界',
    domain: '交互与安全',
    terms: ['安全边界', '非诊断', '不做诊断', '低压力交互', '拒绝退出', '统一退出', '风险升级', '情绪勒索', '儿童安全', 'safety eval', '危机评估', '能力评价'],
  },
  {
    key: 'content-governance',
    label: '适龄内容与版权治理',
    domain: '交互与安全',
    terms: ['适龄内容', '内容安全', '版权元数据', '内容版权', '分龄内容', '儿童化表达', '内容审查', '敏感内容', '年龄分级', 'age appropriate'],
  },
  {
    key: 'speech-asr',
    label: '儿童语音与 ASR',
    domain: 'AI 与工程',
    terms: ['automatic speech recognition', 'speech recognition', 'speech model', 'asr', '语音识别', '儿童语音', '语音模型', '声学模型', 'wer', 'cer', 'vad', '远场语音'],
  },
  {
    key: 'multimodal-perception',
    label: '多模态感知与状态估计',
    domain: 'AI 与工程',
    terms: ['多模态', 'multimodal', '视觉识别', '姿态识别', '表情识别', '音视频', 'sensor fusion', '传感融合', '状态估计', '参与检测', '摄像头'],
  },
  {
    key: 'interaction-state-machine',
    label: '轮次管理与安全状态机',
    domain: 'AI 与工程',
    terms: ['轮次管理', '状态机', 'state machine', 'backchannel', 'turn policy', '抢话', '插话', '事件队列', '优先级队列', 'listening', 'yield', '拒绝检测'],
  },
  {
    key: 'language-models',
    label: '大语言模型与训练',
    domain: 'AI 与工程',
    terms: ['language model', 'large language model', 'transformer', 'tokenizer', 'attention', 'rlhf', 'rlvr', 'llm', '语言模型', '大模型', '预训练', '后训练', '微调'],
  },
  {
    key: 'ai-agents',
    label: 'AI Agent 与工作流编排',
    domain: 'AI 与工程',
    terms: ['coding agent', 'ai agent', 'agentic', 'multi-agent', '智能体', '多智能体', 'codex agent', 'agent workflow', '工作流编排'],
  },
  {
    key: 'ai-systems',
    label: '端云系统与推理优化',
    domain: 'AI 与工程',
    terms: ['distributed training', 'parallelism', 'inference engine', 'gpu', 'tpu', 'kernel', '端云协同', '端侧推理', '云端请求', '分布式训练', '并行训练', '推理系统', '算子优化', '量化部署', 'slo'],
  },
  {
    key: 'model-evaluation',
    label: '模型评测与实验设计',
    domain: 'AI 与工程',
    terms: ['benchmark', 'evaluation', 'evals', '评测', '基准测试', '验收集', '失败样本', '模型选型', '实验设计', '固定测试集', '置信阈值'],
  },
  {
    key: 'data-engineering',
    label: '数据集与标注工程',
    domain: 'AI 与工程',
    terms: ['数据集', '数据采集', '数据标注', '标注指南', '训练集', '测试集', '样本', '数据版本', '数据质量', 'dataset', 'annotation'],
  },
  {
    key: 'data-compliance',
    label: '数据隐私与合规治理',
    domain: '治理与证据',
    terms: ['privacy', 'compliance', 'data governance', '隐私', '合规', '数据治理', '监护人同意', '授权', '删除', '撤回', '数据出境', '算法备案', '数据红线'],
  },
  {
    key: 'evidence-boundary',
    label: '证据分级与拒判机制',
    domain: '治理与证据',
    terms: ['事实与假设', '证据边界', '证据分级', '拒判', '不确定性', '置信度', '能力声明', '规划与事实', '研究目标', 'evidence', 'abstention'],
  },
  {
    key: 'research-methods',
    label: '研究方法与证据转译',
    domain: '治理与证据',
    terms: ['研究方法', '文献综述', '研究论文', '证据转译', '研究设计', '定性研究', '定量研究', '样本量', '效度', '信度', 'methodology'],
  },
  {
    key: 'hardware-design',
    label: '硬件与工业设计',
    domain: '硬件与具身',
    terms: ['hardware', 'industrial design', 'motor', 'sensor', '硬件', '工业设计', '电机', '传感器', '结构设计', '材料', '外观设计', 'bom'],
  },
  {
    key: 'robotics-control',
    label: '机器人控制与物理安全',
    domain: '硬件与具身',
    terms: ['机器人控制', '运动控制', '底盘', '避障', '建图', '自动回充', '移动安全', '机械安全', '碰撞', 'ros', 'robotics'],
  },
  {
    key: 'market-competition',
    label: '市场、竞品与商业模式',
    domain: '产品与商业',
    terms: ['market research', 'competitor', 'competitive', 'pricing', 'business model', 'market sizing', '市场研究', '竞品', '定价', '商业模式', '市场规模', 'tam', 'sam', 'som'],
  },
  {
    key: 'product-strategy',
    label: '产品战略与产品发现',
    domain: '产品与商业',
    terms: ['product strategy', 'product vision', 'product discovery', '产品策略', '产品定位', '产品愿景', '产品发现', '价值主张', '机会识别', '用户研究', '问题陈述'],
  },
  {
    key: 'product-execution',
    label: '产品规划与交付执行',
    domain: '产品与商业',
    terms: ['product roadmap', 'prd', 'user story', 'sprint', 'release', 'milestone', 'acceptance criteria', '路线图', '用户故事', '需求文档', '迭代计划', '里程碑', '交付', '验收'],
  },
  {
    key: 'metrics-growth',
    label: '产品数据、实验与增长',
    domain: '产品与商业',
    terms: ['north star metric', 'a/b test', 'cohort', 'funnel', 'growth loop', 'go-to-market', '指标体系', '实验分析', '队列分析', '漏斗', '增长循环', '增长渠道', '上市策略'],
  },
  {
    key: 'prompt-engineering',
    label: 'AI 提示词与工作流',
    domain: 'AI 与工程',
    terms: ['system prompt', 'prompt template', 'prompt engineering', 'you are an ai assistant', '提示词', '系统提示', '提示模板', 'prompt builder', '上下文工程'],
  },
  {
    key: 'ai-assistant-policy',
    label: 'AI 助手行为与安全策略',
    domain: 'AI 与工程',
    terms: ['developer message', 'system message', 'system messages', 'assistant behavior', 'tool instructions', 'response format', 'safety policy', 'assistant must', 'assistant tasked', 'user request', 'you are', 'ai assistant', 'helpful assistant', 'search assistant', 'the assistant', 'core identity', 'personality', 'reminder', 'reminders', 'injections', 'policies', '行为规范', '安全策略'],
  },
  {
    key: 'software-engineering',
    label: '软件工程与代码质量',
    domain: 'AI 与工程',
    terms: ['code review', 'code-review', 'debugging', 'debug', 'codebase', 'repository', 'pull request', 'refactor', 'unit test', 'integration test', 'continuous integration', '软件工程', '代码审查', '调试', '测试用例'],
  },
  {
    key: 'tool-automation',
    label: '工具调用与自动化',
    domain: 'AI 与工程',
    terms: ['tool call', 'this tool', 'bio tool', 'web tool', 'browser automation', 'playwright', 'terminal', 'shell command', 'filesystem', 'mcp server', 'command line', 'headless browser', 'run skill', 'dev server', 'agent drives', 'persist information', 'up-to-date information', '工具调用', '浏览器自动化', '命令行'],
  },
  {
    key: 'data-visualization',
    label: '数据可视化与信息设计',
    domain: 'AI 与工程',
    terms: ['data visualization', 'dataviz', 'chart', 'dashboard', 'svg', 'visual encoding', 'interaction design', '数据可视化', '图表', '信息设计'],
  },
  {
    key: 'document-artifacts',
    label: '文档、表格与演示交付',
    domain: 'AI 与工程',
    terms: ['spreadsheet', 'presentation', 'slide deck', 'powerpoint', 'excel', 'pdf document', 'word document', 'report template', '电子表格', '演示文稿', '幻灯片', '文档交付'],
  },
  {
    key: 'research-retrieval',
    label: '研究检索与 RAG',
    domain: '治理与证据',
    terms: ['deep research', 'web search', 'citation', 'retrieval', 'rag', 'knowledge base', 'source attribution', 'research workflow', '检索增强', '知识库', '引用来源', '深度研究'],
  },
  {
    key: 'course-learning',
    label: '课程学习与知识组织',
    domain: '儿童发展与教育',
    terms: ['lecture', 'assignment', 'course', 'syllabus', 'playlist', 'study guide', 'learning objective', '课程', '讲义', '作业', '学习目标', '视频学习'],
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

const PM_DOMAIN_RULES = [
  {
    key: 'strategy-discovery',
    label: 'PM Strategy & Discovery',
    terms: ['product strategy', 'product discovery', 'market research', 'product vision', 'opportunity', 'customer interview', 'persona', 'assumption', '产品策略', '产品发现', '市场研究', '用户访谈', '机会树'],
    pathHints: ['pm-product-strategy', 'pm-product-discovery', 'pm-market-research'],
  },
  {
    key: 'execution-growth',
    label: 'PM Execution & Growth',
    terms: ['execution', 'delivery', 'shipping', 'launch', 'sprint', 'release', 'go-to-market', 'marketing', 'growth', 'roadmap', '执行', '交付', '发布', '增长', '营销', '路线图'],
    pathHints: ['pm-execution', 'pm-ai-shipping', 'pm-go-to-market', 'pm-marketing-growth'],
  },
  {
    key: 'data-tools',
    label: 'PM Data & Tools',
    terms: ['analytics', 'metrics', 'sql', 'experiment', 'cohort', 'dashboard', 'toolkit', 'legal', 'privacy policy', '数据分析', '指标', '实验', '工具包', '法务'],
    pathHints: ['pm-data-analytics', 'pm-toolkit', 'pm-community-additions'],
  },
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

function detectPmSummaryDomain(document) {
  const normalizedPath = String(document.path || '').normalize('NFKC').toLocaleLowerCase();
  const tags = new Set((document.tags || []).map(normalizedTerm));
  if (/(?:^|\/)(?:pm资料总结|pm[- _]?summary)\.md$/iu.test(normalizedPath) ||
      tags.has('pm summary root')) {
    return PM_SUMMARY_DOMAINS[0];
  }
  if (!tags.has('pm summary')) return null;
  return PM_SUMMARY_DOMAINS.find((domain) => tags.has(domain.tag)) || null;
}

function detectPmRepresentativeDomain(document) {
  const tags = new Set((document.tags || []).map(normalizedTerm));
  const representative = tags.has('pm representative') ||
    /^type:\s*pm-representative\s*$/imu.test(document.content || '');
  if (!representative) return null;
  return PM_SUMMARY_DOMAINS.find((domain) =>
    tags.has(`pm domain ${normalizedTerm(domain.key)}`)
  ) || null;
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
  if (/^type:\s*(?:knowledge-index|knowledge-point-index)\s*$/imu.test(document.content || '') ||
      (document.tags || []).some((tag) => normalizedTerm(tag) === 'knowledge index')) {
    return true;
  }
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
  if (/^[a-z0-9+#./ -]+$/iu.test(term)) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'giu');
    let matches = 0;
    for (const _match of text.matchAll(expression)) {
      matches += 1;
      if (matches >= 4) break;
    }
    return matches;
  }
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
  const pmDomain = PM_DOMAIN_RULES.find((rule) => rule.key === key);
  if (pmDomain) return pmDomain.label;
  return {
    'product-management': 'Product Management',
    skill: 'Skill',
    prompt: 'Prompt',
    academic: '学术',
    project: '项目',
    reference: '参考资料',
  }[key] || humanizeSegment(key);
}

function inferPmDomain(document, searchable) {
  const normalizedPath = document.path.normalize('NFKC').toLocaleLowerCase();
  const normalizedTags = new Set((document.tags || []).map(normalizedTerm));
  const ranked = PM_DOMAIN_RULES
    .map((rule) => ({
      ...rule,
      score: scoreTerms(searchable, rule.terms) +
        (rule.pathHints.some((hint) => normalizedPath.includes(hint)) ? 3 : 0) +
        (normalizedTags.has(`pm domain ${normalizedTerm(rule.key)}`) ? 12 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return ranked[0].score > 0
    ? ranked[0]
    : ranked.find((rule) => rule.key === 'execution-growth');
}

function desktopAlignedProjectLabel(primary, secondary) {
  const key = secondary?.key || primary?.key;
  return {
    'product-strategy': '产品规划与立项',
    'market-competition': '竞品与市场研究',
    'data-compliance': '合规与法务',
    'hardware-design': '工业设计与供应商',
    'speech-asr': '端侧研发与验证',
    'language-models': '端侧研发与验证',
    'ai-systems': '端侧研发与验证',
    'model-evaluation': '端侧研发与验证',
    'ai-agents': '合作与课题研究',
    'prompt-engineering': '合作与课题研究',
  }[key] || '合作与课题研究';
}

function desktopWorkCollection(path) {
  const normalizedPath = String(path || '').normalize('NFKC').toLocaleLowerCase();
  const folders = [
    ['01', '产品规划与立项'],
    ['02', '合作与课题研究'],
    ['03', '合规与法务'],
    ['04', '竞品与市场研究'],
    ['05', '工业设计与供应商'],
    ['06', '技术与岗位'],
    ['07', '演示与汇报'],
    ['08', '端侧研发与验证'],
    ['09', '招聘'],
  ];
  for (const [number, label] of folders) {
    if (new RegExp(`(?:^|/)${number}[_ .-]*${label}(?:/|$)`, 'u').test(normalizedPath)) {
      return { key: `@desktop:work:${number}`, label };
    }
  }
  return null;
}

function stableTextHash(value) {
  let hash = 2166136261;
  const text = String(value || '').normalize('NFKC').toLocaleLowerCase().slice(0, 12000);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function pmCanonicalKey(document) {
  const frontmatterName = document.content.match(/^name:\s*["']?([^\n"']+)["']?\s*$/imu)?.[1];
  const heading = document.content.match(/^#\s+(.+)$/mu)?.[1];
  const identity = frontmatterName || (heading && !isGenericLabel(heading) ? heading : '');
  return identity
    ? `name:${normalizedTerm(identity)}`
    : `content:${stableTextHash(document.content)}`;
}

function isPmSupportingArtifact(document) {
  const normalizedPath = document.path.normalize('NFKC').toLocaleLowerCase();
  const explicitSupport = /(?:^|\/)(?:\.github|issues?-archive|tests?|fixtures?|examples?|references?|commands?|library|skill-output-samples|node_modules|docs?|site|scripts?|hooks?|templates?|research|catalog|knowledge|_workflows|_agent-context|comparison)(?:\/|$)/iu
    .test(normalizedPath) || /(?:^|\/)(?:history|changelog|contributing|code_of_conduct|privacy|todos?)\.md$/iu
    .test(normalizedPath);
  if (explicitSupport || isNavigationDocument(document.id, document)) return true;

  const packagedResearchCorpus = /(?:^|\/)pm-skill-research\/sources\//u.test(normalizedPath);
  if (packagedResearchCorpus) return /(?:^|\/)skill\.md$/u.test(normalizedPath) === false;
  return false;
}

function contentTextForKnowledge(document) {
  return [
    document.title,
    document.content,
    ...(document.tags || []),
    ...(document.headings || []),
    ...(document.aliases || []),
  ].join('\n').normalize('NFKC').toLocaleLowerCase();
}

function inferDocumentTaxonomy(document) {
  const contentText = contentTextForKnowledge(document);
  const fallbackText = [document.title, document.path].join('\n')
    .normalize('NFKC').toLocaleLowerCase();
  const searchable = contentText.trim() ? contentText : fallbackText;
  const normalizedTags = new Set((document.tags || []).map(normalizedTerm));
  const topics = CONTENT_TOPIC_RULES
    .map((rule) => ({
      ...rule,
      score: scoreTerms(searchable, rule.terms) +
        (normalizedTags.has(`knowledge point ${normalizedTerm(rule.key)}`) ? 12 : 0),
    }))
    .filter((topic) => topic.score >= 1)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  const knowledgePoints = topics.filter((topic) => !topic.contextOnly);

  const explicitPmScore = scoreTerms(searchable, PM_ARTIFACT_TERMS.slice(0, 4));
  const pmArtifactScore = scoreTerms(searchable, PM_ARTIFACT_TERMS.slice(4));
  const pmCorpus = /(?:^|\/)[^/]*(?:pm[- _]?skills?|pm[- _]?prompts?|product[- _]?manager)[^/]*(?:\/|$)/iu
    .test(document.path.normalize('NFKC').toLocaleLowerCase());
  const promptScore = scoreTerms(searchable, PROMPT_FORMAT_TERMS);
  const skillScore = scoreTerms(searchable, SKILL_FORMAT_TERMS);
  const explicitPmTag = normalizedTags.has('product management') ||
    normalizedTags.has('pm skill') || normalizedTags.has('pm prompt');
  let pmRelated = explicitPmScore >= 2.1 ||
    (explicitPmScore >= 1.3 && Math.max(promptScore, skillScore) >= 1) ||
    pmCorpus || explicitPmTag;
  const promptCorpus = /(?:^|\/)[^/]*(?:product[- _]?manager[- _]?prompts?|pm[- _]?prompts?)[^/]*(?:\/|$)/iu
    .test(document.path.normalize('NFKC').toLocaleLowerCase());
  const pmKind = promptCorpus || (promptScore >= 2.2 && promptScore > skillScore * 0.72)
    ? 'prompt'
    : 'skill';
  const pmDomain = inferPmDomain(document, searchable);

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
  if (/^(?:\d+[-_ .]*)?(?:work|projects?|competition|research)(?:\/|$)/iu.test(document.path)) {
    projectScore += 1;
  }
  if (/type:\s*knowledge-card/iu.test(searchable)) projectScore += 3;
  if (/scope:[\s\S]{0,120}(?:work|competition)/iu.test(searchable)) projectScore += 2;
  const context = academicScore >= 2.7 && academicScore > projectScore + 0.7
    ? 'academic'
    : projectScore >= 2.4 ? 'project' : 'reference';

  return {
    context,
    topics,
    knowledgePoints,
    pmRelated,
    pmKind,
    pmDomain,
    promptScore,
    skillScore,
    pmArtifactScore,
  };
}

function extractKnowledgeProfile(document) {
  const taxonomy = inferDocumentTaxonomy(document);
  const searchable = contentTextForKnowledge(document);
  return {
    context: taxonomy.context,
    pmRelated: taxonomy.pmRelated,
    pmKind: taxonomy.pmKind,
    pmDomain: taxonomy.pmDomain && {
      key: taxonomy.pmDomain.key,
      label: taxonomy.pmDomain.label,
    },
    knowledgePoints: taxonomy.knowledgePoints.map((topic) => ({
      key: topic.key,
      label: topic.label,
      domain: topic.domain,
      score: Number(topic.score.toFixed(2)),
      evidenceTerms: topic.terms.filter((term) => searchable.includes(term)).slice(0, 8),
    })),
  };
}

function deriveTopicAssignments(documents, directoryProjects) {
  const assignments = new Map();
  const counts = new Map();
  for (const document of documents.values()) {
    const taxonomy = inferDocumentTaxonomy(document);
    const directoryProject = directoryProjects.get(document.id);
    const primary = taxonomy.knowledgePoints[0];
    let key;
    let label;
    let weightScale = 1;
    let communityWeight = 1;

    const workCollection = desktopWorkCollection(document.path);
    const childCompanionContext = taxonomy.topics.some((topic) => topic.key === 'child-companion') ||
      Boolean(workCollection);
    const pmSummaryDomain = detectPmSummaryDomain(document);
    const pmRepresentativeDomain = detectPmRepresentativeDomain(document);
    if (pmSummaryDomain) {
      key = `@topic:pm-summary:${pmSummaryDomain.key}`;
      label = pmSummaryDomain.label;
    } else if (pmRepresentativeDomain) {
      key = `@topic:pm-summary:${pmRepresentativeDomain.key}`;
      label = pmRepresentativeDomain.label;
      weightScale = 0.28;
      communityWeight = 0.22;
    } else if (taxonomy.pmRelated) {
      const prompts = taxonomy.pmKind === 'prompt';
      key = prompts ? '@topic:pm-prompts' : `@topic:pm-skills:${taxonomy.pmDomain.key}`;
      label = prompts ? 'PM Prompts' : taxonomy.pmDomain.label;
      weightScale = 0.18;
      communityWeight = 0.12;
    } else if (primary) {
      key = childCompanionContext
        ? `@topic:project-knowledge:${primary.key}`
        : `@knowledge:${primary.key}`;
      label = primary.label;
    } else if (taxonomy.context === 'academic') {
      key = '@knowledge:academic-research';
      label = '学术研究方法';
    } else if (workCollection) {
      key = workCollection.key;
      label = workCollection.label;
    } else if (directoryProject && !isGenericLabel(directoryProject.label)) {
      key = directoryProject.key;
      label = directoryProject.label;
    } else {
      key = `@root:${document.id}`;
      label = humanizeSegment(document.title) || 'Unclassified';
    }

    const parent = pmSummaryDomain || pmRepresentativeDomain
      ? PM_SUMMARY_PARENT
      : taxonomy.pmRelated
        ? null
        : childCompanionContext
          ? CHILD_COMPANION_PARENT
          : null;

    counts.set(key, (counts.get(key) || 0) + 1);
    assignments.set(document.id, {
      key,
      label,
      parentKey: parent?.key,
      parentLabel: parent?.label,
      parentColor: parent?.color,
      size: 1,
      weightScale,
      communityWeight,
      pmRepresentative: Boolean(pmRepresentativeDomain),
      context: taxonomy.context,
      contextTags: pmSummaryDomain || pmRepresentativeDomain
        ? ['product-management', 'summary']
        : taxonomy.pmRelated ? ['product-management'] : [taxonomy.context],
      topicTags: pmSummaryDomain || pmRepresentativeDomain
        ? ['product-management', 'summary', (pmSummaryDomain || pmRepresentativeDomain).key]
        : taxonomy.pmRelated
        ? ['product-management', taxonomy.pmKind, taxonomy.pmDomain.key]
        : taxonomy.knowledgePoints.slice(0, 6).map((topic) => topic.key),
      knowledgePoints: taxonomy.knowledgePoints.slice(0, 8).map((topic) => ({
        key: topic.key,
        label: topic.label,
        domain: topic.domain,
        score: Number(topic.score.toFixed(2)),
        evidenceTerms: topic.terms.filter((term) =>
          contentTextForKnowledge(document).includes(term)
        ).slice(0, 6),
      })),
    });
  }
  applyPmVisibility(documents, assignments);
  for (const assignment of assignments.values()) assignment.size = counts.get(assignment.key) || 1;
  return assignments;
}

function applyPmVisibility(documents, assignments) {
  const seen = new Map();
  const ids = [...assignments.keys()].sort((a, b) => a.localeCompare(b));
  for (const id of ids) {
    const assignment = assignments.get(id);
    if (!assignment?.key.startsWith('@topic:pm-')) continue;
    const document = documents.get(id) || {};
    const canonicalKey = pmCanonicalKey(document);
    assignment.canonicalKey = canonicalKey;
    if (assignment.key.startsWith('@topic:pm-summary:')) {
      assignment.displayWeight = assignment.pmRepresentative ? 0.72 : 1;
      assignment.communityWeight = assignment.pmRepresentative ? 0.22 : 1;
      continue;
    }
    if (assignment.key === '@topic:pm-prompts') {
      assignment.displayWeight = 0.82;
      continue;
    }
    if (isPmSupportingArtifact(document)) {
      assignment.displayWeight = 0.3;
      assignment.communityWeight = 0.008;
      assignment.supportingArtifact = true;
      continue;
    }
    const duplicateKey = `${assignment.key}\u0000${canonicalKey}`;
    if (seen.has(duplicateKey)) {
      assignment.displayWeight = 0.36;
      assignment.communityWeight = 0.012;
      assignment.duplicateOf = seen.get(duplicateKey);
    } else {
      seen.set(duplicateKey, id);
      assignment.displayWeight = 0.86;
      assignment.communityWeight = 0.2;
    }
  }
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
    if (project?.parentKey) vector.set(project.parentKey, 2.4);
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
    document.parentKey = project?.parentKey;
    document.parentLabel = project?.parentLabel;
    document.parentColor = project?.parentColor;
    document.knowledgePoints = project?.knowledgePoints || [];
    document.labelTerms = feature && feature.labelTerms;
    document.priorityMatches = feature && feature.priorityMatches;
    document.contextTags = project && project.contextTags;
    document.topicTags = project && project.topicTags;
    document.communityWeight = project?.communityWeight == null ? 1 : project.communityWeight;
    document.displayWeight = project?.displayWeight == null ? 1 : project.displayWeight;
    document.canonicalKey = project?.canonicalKey;
    document.duplicateOf = project?.duplicateOf;
    document.supportingArtifact = Boolean(project?.supportingArtifact);
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
      projectGroups.set(key, {
        key,
        label: document.projectLabel,
        parentKey: document.parentKey,
        nodes: [],
      });
    }
    projectGroups.get(key).nodes.push(node);
  }
  const ranked = [...projectGroups.values()]
    .filter((group) =>
      group.nodes.length >= minCommunitySize ||
      group.key.startsWith('@topic:pm-summary:') ||
      (
        group.parentKey === CHILD_COMPANION_PARENT.key &&
        group.nodes.length >= 2
      )
    )
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

  const kept = ranked.filter((group) =>
    /^@topic:pm-(?:summary(?::[^:]+)?|skills(?::[^:]+)?|prompts)$/u.test(group.key)
  );
  const externalGroupCount = ranked.filter((group) => /^@knowledge:/u.test(group.key)).length;
  const externalReserve = Math.min(
    externalGroupCount,
    Math.max(3, Math.round(maxCommunities * 0.34))
  );
  const childBudget = Math.max(0, maxCommunities - kept.length - externalReserve);
  let keptProjectKnowledge = 0;
  const addChildGroup = (group) => {
    if (!group || kept.includes(group) || kept.length >= maxCommunities ||
        keptProjectKnowledge >= childBudget) return;
    kept.push(group);
    keptProjectKnowledge += 1;
  };
  for (const key of CORE_CHILD_KNOWLEDGE_KEYS) {
    addChildGroup(ranked.find(
      (group) => group.key === `@topic:project-knowledge:${key}`
    ));
  }
  for (const group of ranked) {
    if (keptProjectKnowledge >= childBudget) break;
    if (group.parentKey === CHILD_COMPANION_PARENT.key) addChildGroup(group);
  }
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
  keepDiverseGroups(/^@knowledge:/u, externalReserve);
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
  const displayWeight = clamp(document.displayWeight ?? 1, 0, 1);
  const visibilityFactor = displayWeight >= 0.2
    ? 0.65 + displayWeight * 0.35
    : 0.025;
  return degreeScore * informationBonus * navigationFactor * visibilityFactor;
}

function summarizeCommunity(nodes, documents, priorityKeywords = [], preferProjects = true) {
  const projectScores = new Map();
  const priorityScores = new Map();
  const termScores = new Map();
  for (const node of nodes) {
    const document = documents.get(node) || {};
    if (document.projectLabel && !isGenericLabel(document.projectLabel)) {
      const projectContribution = document.parentKey === CHILD_COMPANION_PARENT.key
        ? 1.25
        : 1;
      projectScores.set(
        document.projectLabel,
        (projectScores.get(document.projectLabel) || 0) + projectContribution
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

function knowledgeRule(value) {
  const normalized = String(value || '');
  return CONTENT_TOPIC_RULES.find(
    (rule) => !rule.contextOnly && (rule.key === normalized || rule.label === normalized)
  );
}

function knowledgePointColor(value, parentKey = null) {
  const rule = knowledgeRule(value);
  if (!rule) return null;
  const styles = parentKey === CHILD_COMPANION_PARENT.key
    ? CHILD_COMPANION_DOMAIN_STYLES
    : KNOWLEDGE_DOMAIN_STYLES;
  const style = styles.get(rule.domain);
  if (!style) return null;
  const peers = CONTENT_TOPIC_RULES.filter(
    (candidate) => !candidate.contextOnly && candidate.domain === rule.domain
  );
  const index = Math.max(0, peers.findIndex((candidate) => candidate.key === rule.key));
  const offset = peers.length <= 1
    ? 0
    : ((index / (peers.length - 1)) - 0.5) * style.spread;
  const toneOffsets = [0.07, -0.045, 0.025, -0.075, 0.055, -0.015];
  const saturationOffsets = [0.04, -0.06, 0.08, -0.02, 0.02];
  const maximumSaturation = parentKey === CHILD_COMPANION_PARENT.key ? 0.94 : 0.88;
  return hslToRgbInt(
    style.hue + offset,
    clamp(
      style.saturation + saturationOffsets[index % saturationOffsets.length],
      0.58,
      maximumSaturation
    ),
    clamp(style.lightness + toneOffsets[index % toneOffsets.length], 0.38, 0.64)
  );
}

function documentKnowledgeColor(document = {}) {
  const points = (document.knowledgePoints || []).slice(0, 6);
  if (!points.length) return null;
  const colors = [];
  const weights = [];
  const primaryScore = Math.max(1, Number(points[0]?.score) || 1);
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const color = knowledgePointColor(point.key || point.label, document.parentKey);
    if (color == null) continue;
    colors.push(color);
    if (index === 0) {
      weights.push(1);
    } else {
      const relativeScore = clamp((Number(point.score) || 0) / primaryScore, 0.12, 1);
      weights.push((0.24 * relativeScore) / Math.sqrt(index));
    }
  }
  return colors.length ? blendRgbInts(colors, weights) : null;
}

function nodesByCommunity(assignments) {
  const communities = new Map();
  for (const [node, community] of assignments.entries()) {
    if (community == null || community < 0) continue;
    if (!communities.has(community)) communities.set(community, []);
    communities.get(community).push(node);
  }
  return communities;
}

function dominantDocumentValue(nodes, documents, field) {
  const counts = new Map();
  for (const node of nodes) {
    const value = documents.get(node)?.[field];
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0]?.[0];
}

function dominantHierarchyValue(nodes, documents, field) {
  const counts = new Map();
  for (const node of nodes) {
    const value = documents.get(node)?.[field] || null;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const [value, count] = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))[0] || [];
  return value && count > nodes.length / 2 ? value : undefined;
}

function childCompanionColor(label, index = 0) {
  if (CHILD_COMPANION_COLORS.has(label)) {
    return hexToRgbInt(CHILD_COMPANION_COLORS.get(label));
  }
  const fallback = ['#E54866', '#D9468D', '#C23B78', '#F05B78', '#B83F88'];
  return hexToRgbInt(fallback[index % fallback.length]);
}

function pmSummaryColor(label, index = 0) {
  if (PM_SUMMARY_COLORS.has(label)) return hexToRgbInt(PM_SUMMARY_COLORS.get(label));
  const fallback = ['#3B82F6', '#6366F1', '#06B6D4', '#8B5CF6'];
  return hexToRgbInt(fallback[index % fallback.length]);
}

function generateCommunityPalette(assignments, hubs, documents, options = {}) {
  const communities = nodesByCommunity(assignments);
  const hasChildCompanionProject = [...communities.values()].some((nodes) =>
    dominantHierarchyValue(nodes, documents, 'parentKey') === CHILD_COMPANION_PARENT.key
  );
  const fallbackPalette = hasChildCompanionProject
    ? ['#5AA9FF', '#6FE39A', '#C58CFF', '#FFC857', '#46D7D0', '#738CFF', '#A8D65E', '#FF9F43', '#6FD0FF', '#14B8A6', '#8B5CF6', '#EAB308']
    : DEFAULT_PALETTE;
  const palette = generatePalette(hubs.size, options.palette || fallbackPalette);
  let projectIndex = 0;
  let pmSummaryIndex = 0;
  for (const community of hubs.keys()) {
    const nodes = communities.get(community) || [];
    const parentKey = dominantHierarchyValue(nodes, documents, 'parentKey');
    const label = dominantDocumentValue(nodes, documents, 'projectLabel');
    const semanticColor = knowledgePointColor(label, parentKey);
    if (semanticColor != null) {
      palette[community] = semanticColor;
      projectIndex += 1;
    } else if (parentKey === PM_SUMMARY_PARENT.key) {
      palette[community] = pmSummaryColor(label, pmSummaryIndex);
      pmSummaryIndex += 1;
    }
  }
  return palette;
}

function colorize(graph, assignments, hubs, affinities, options = {}) {
  const communityCount = hubs.size;
  const documents = options.documents instanceof Map ? options.documents : new Map();
  const palette = generateCommunityPalette(assignments, hubs, documents, options);
  const neutral = hexToRgbInt(options.neutralColor || '#8B92A1');
  const peripheralFade = clamp(numericOption(options, 'peripheralFade', 0.18), 0, 0.85);
  const maxDegree = Math.max(1, ...[...graph.keys()].map((node) => weightedDegree(graph, node)));
  const hubSet = new Set(hubs.values());
  const colors = new Map();
  for (const node of graph.keys()) {
    const vector = affinities.get(node) || [];
    if (!vector.length || vector.every((value) => value <= 0)) {
      colors.set(node, neutral);
      continue;
    }
    let mixed = blendRgbInts(palette, vector);
    const semanticColor = documentKnowledgeColor(documents.get(node));
    if (semanticColor != null) mixed = mixRgb(mixed, semanticColor, 0.28);
    if (hubSet.has(node)) {
      colors.set(node, palette[assignments.get(node)] || mixed);
      continue;
    }
    const degreeRatio = Math.log1p(weightedDegree(graph, node)) / Math.log1p(maxDegree);
    const confidence = Math.max(...vector);
    const displayWeight = clamp(documents.get(node)?.displayWeight ?? 1, 0, 1);
    const corpusFade = (1 - displayWeight) * 0.06;
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
  const { colors, palette } = colorize(graph, assignments, hubs, affinities, analysisOptions);
  const communities = nodesByCommunity(assignments);
  const usedLabels = new Map();
  const usedFinalLabels = new Set();
  const clusters = [...hubs.entries()].map(([id, hub]) => {
    const nodes = communities.get(id) || [];
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
    const parentKey = dominantHierarchyValue(nodes, documents, 'parentKey');
    const parentLabel = dominantHierarchyValue(nodes, documents, 'parentLabel');
    const parentColor = dominantHierarchyValue(nodes, documents, 'parentColor');
    return {
      id,
      hub,
      label,
      keywords: summary.keywords.map(displayTopicLabel),
      color: palette[id],
      colorHex: rgbIntToHex(palette[id]),
      parentKey,
      parentLabel,
      parentColorHex: parentColor || null,
      size: nodes.length,
      visibleSize: nodes.filter(
        (node) => {
          const document = documents.get(node) || {};
          return !document.supportingArtifact && !document.duplicateOf;
        }
      ).length,
      totalDegree: nodes.reduce((sum, node) => sum + weightedDegree(graph, node), 0),
    };
  });
  const parentMap = new Map();
  for (const cluster of clusters) {
    if (!cluster.parentKey || !cluster.parentLabel) continue;
    if (!parentMap.has(cluster.parentKey)) {
      parentMap.set(cluster.parentKey, {
        key: cluster.parentKey,
        label: cluster.parentLabel,
        colorHex: cluster.parentColorHex || '#DC2626',
        size: 0,
        visibleSize: 0,
        communityIds: [],
      });
    }
    const parent = parentMap.get(cluster.parentKey);
    parent.size += cluster.size;
    parent.visibleSize += cluster.visibleSize;
    parent.communityIds.push(cluster.id);
  }
  return {
    graph,
    assignments,
    affinities,
    colors,
    palette,
    clusters,
    parents: [...parentMap.values()],
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
  CONTENT_TOPIC_RULES,
  DEFAULT_PALETTE,
  PM_DOMAIN_RULES,
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
  extractKnowledgeProfile,
  graphFromResolvedLinks,
  hexToRgbInt,
  humanizeSegment,
  isNavigationDocument,
  knowledgePointColor,
  louvainPartition,
  mixRgb,
  propagateAffinities,
  parsePriorityKeywords,
  rgbIntToHex,
  totalEdgeWeight,
  weightedDegree,
};
