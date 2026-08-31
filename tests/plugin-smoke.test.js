'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('bundled plugin loads, clusters, paints, and restores a mocked graph view', async () => {
  const source = readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const links = {
    'A1.md': { 'A2.md': 3 },
    'B0.md': { 'B1.md': 3, 'B2.md': 3 },
    'B1.md': { 'B2.md': 3 },
    'A0.md': { 'A1.md': 3, 'A2.md': 3, 'B0.md': 0.1 },
    'README.md': { 'A0.md': 1 },
  };
  const ids = [
    'A0.md',
    'A1.md',
    'A2.md',
    'B0.md',
    'B1.md',
    'B2.md',
    'README.md',
  ];
  const graphNodePrototype = {
    getDisplayText() {
      return this.id.split('/').pop().replace(/\.md$/i, '');
    },
    render() {
      for (const target of [this.text, this.circle, this.sprite].filter(Boolean)) {
        target.visible = true;
        target.alpha = 1;
        target.renderable = true;
        target.eventMode = 'static';
        target.interactive = true;
      }
    },
  };
  const nodes = ids.map((id) => {
    const node = Object.create(graphNodePrototype);
    node.id = id;
    node.type = '';
    node.eventMode = 'static';
    node.interactive = true;
    node.text = {
      text: node.getDisplayText(),
      visible: true,
      alpha: 1,
      renderable: true,
      eventMode: 'static',
      interactive: true,
    };
    node.circle = {
      visible: true,
      alpha: 1,
      renderable: true,
      eventMode: 'static',
      interactive: true,
    };
    node.sprite = {
      visible: true,
      alpha: 1,
      renderable: true,
      eventMode: 'static',
      interactive: true,
    };
    return node;
  });
  const generatedTextures = [];
  class FakeTexture {
    constructor(source = 'original') {
      this.source = source;
      this.destroyed = false;
    }
    static from(source) {
      const texture = new FakeTexture(source);
      generatedTextures.push(texture);
      return texture;
    }
    destroy() { this.destroyed = true; }
  }
  const graphLinks = [
    { source: nodes[0], target: nodes[1], line: { texture: new FakeTexture() } },
    { source: nodes[0], target: nodes[3], line: { texture: new FakeTexture() } },
    { source: nodes[3], target: nodes[4], line: { texture: new FakeTexture() } },
    { source: nodes[6], target: nodes[0], line: { texture: new FakeTexture() } },
  ];
  for (const link of graphLinks) {
    link.arrow = {
      visible: true,
      alpha: 1,
      renderable: true,
      eventMode: 'static',
      interactive: true,
    };
    link.render = function () {
      this.line.alpha = 0.8;
      this.arrow.visible = true;
      this.arrow.alpha = 1;
      this.arrow.renderable = true;
      this.arrow.eventMode = 'static';
      this.arrow.interactive = true;
    };
  }
  const originalTextures = graphLinks.map((link) => link.line.texture);
  const effectiveNodes = nodes.slice(0, 6);
  const excludedNode = nodes[6];
  let changedCount = 0;
  let originalNodeClickCount = 0;
  let originalNodeHoverCount = 0;
  let originalNodeUnhoverCount = 0;
  const renderer = {
    nodes,
    links: graphLinks,
    colors: {
      fill: { a: 1, rgb: 0x999999 },
      line: { a: 0.8, rgb: 0x777777 },
    },
    changed() { changedCount += 1; },
    onNodeClick() { originalNodeClickCount += 1; },
    onNodeHover() { originalNodeHoverCount += 1; },
    onNodeUnhover() { originalNodeUnhoverCount += 1; },
  };
  const legendChildren = [];
  let legendElement = null;
  const containerEl = {
    querySelector(selector) {
      return selector === '.graph-communities-legend' ? legendElement : null;
    },
    appendChild(child) {
      legendChildren.push(child);
      if (child.className === 'graph-communities-legend') legendElement = child;
    },
  };
  const leaf = { view: { renderer, containerEl } };
  const listeners = [];
  const workspaceListeners = new Map();
  let cachedReadCount = 0;
  const status = { text: '', setText(value) { this.text = value; } };
  const portableManifest = {
    version: 1,
    themes: [
      {
        key: 'ai-models-systems',
        label: 'AI Models',
        color: '#D78C15',
        topics: [{
          key: 'language-models',
          label: 'Language Models',
          color: '#FE9772',
          terms: ['large language model', 'transformer', 'inference'],
        }],
      },
      {
        key: 'product-business',
        label: 'Product',
        color: '#009C66',
        topics: [{
          key: 'market-competition',
          label: 'Market',
          color: '#4DB35F',
          terms: ['product strategy', 'market', 'pricing'],
        }],
      },
    ],
  };
  const app = {
    metadataCache: {
      resolvedLinks: links,
      on(_event, callback) { listeners.push(callback); return callback; },
    },
    vault: {
      adapter: {
        async exists(filePath) {
          return filePath === '.codex/graph/topic-manifest.json';
        },
        async read() { return JSON.stringify(portableManifest); },
      },
      getMarkdownFiles() {
        return ids.map((filePath) => ({ path: filePath, stat: { mtime: 1, size: 10 } }));
      },
      async cachedRead(file) {
        cachedReadCount += 1;
        if (file.path === 'Long.md') return `${'x'.repeat(24000)}TAIL`;
        return file.path.startsWith('A')
          ? `# ${file.path}\nLarge language model transformer inference ${file.path}`
          : `# ${file.path}\nProduct strategy market pricing research ${file.path}`;
      },
      on(_event, callback) { listeners.push(callback); return callback; },
    },
    workspace: {
      getLeavesOfType(type) { return type === 'graph' ? [leaf] : []; },
      getActiveFile() { return null; },
      on(event, callback) {
        listeners.push(callback);
        if (!workspaceListeners.has(event)) workspaceListeners.set(event, []);
        workspaceListeners.get(event).push(callback);
        return callback;
      },
      onLayoutReady(callback) { callback(); },
    },
  };

  class FakePlugin {
    constructor(fakeApp) { this.app = fakeApp; }
    async loadData() { return { maxCommunities: 4, minCommunitySize: 2, showLegend: true }; }
    async saveData() {}
    addStatusBarItem() { return status; }
    addSettingTab() {}
    registerEvent() {}
    registerInterval() {}
    addCommand() {}
  }
  class FakePluginSettingTab {
    constructor(fakeApp, plugin) { this.app = fakeApp; this.plugin = plugin; }
  }
  class FakeSetting {}
  class FakeNotice {}
  const fakeObsidian = {
    Notice: FakeNotice,
    Plugin: FakePlugin,
    PluginSettingTab: FakePluginSettingTab,
    Setting: FakeSetting,
    debounce: (callback) => callback,
  };
  const fakeDocument = {
    createElement(tagName) {
      if (tagName === 'canvas') {
        const colorStops = [];
        return {
          tagName,
          width: 0,
          height: 0,
          colorStops,
          getContext() {
            return {
              fillStyle: null,
              createLinearGradient() {
                return {
                  addColorStop(offset, color) { colorStops.push([offset, color]); },
                };
              },
              fillRect() {},
            };
          },
        };
      }
      const eventListeners = new Map();
      return {
        tagName,
        className: '',
        style: {},
        textContent: '',
        children: [],
        attributes: {},
        eventListeners,
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = [...children]; },
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(event, callback) { eventListeners.set(event, callback); },
        remove() {
          if (this === legendElement) legendElement = null;
        },
      };
    },
  };
  const moduleObject = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleObject,
    exports: moduleObject.exports,
    require(id) {
      if (id === 'obsidian') return fakeObsidian;
      throw new Error(`Unexpected require: ${id}`);
    },
    window: { setInterval: () => 1 },
    document: fakeDocument,
    console,
  }, { filename: 'main.js' });

  const PluginClass = moduleObject.exports;
  const plugin = new PluginClass(app);
  await plugin.onload();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.match(status.text, /themes/);
  assert.equal(plugin.topicManifestState, 'portable manifest');
  assert.ok(changedCount > 0);
  assert.ok(effectiveNodes.every((node) => node.color && Number.isInteger(node.color.rgb)));
  assert.notEqual(nodes[0].color.rgb, nodes[3].color.rgb);
  assert.equal(excludedNode.color.a, 0);
  assert.equal(excludedNode.text.visible, false);
  assert.equal(excludedNode.circle.visible, false);
  assert.equal(excludedNode.sprite.visible, false);
  assert.equal(excludedNode.eventMode, 'none');
  assert.equal(excludedNode.circle.eventMode, 'none');
  excludedNode.render();
  assert.equal(excludedNode.text.visible, false);
  assert.equal(excludedNode.circle.visible, false);
  assert.equal(excludedNode.circle.renderable, false);
  assert.equal(excludedNode.circle.eventMode, 'none');
  assert.equal(plugin.exclusionReasons.get('README.md'), 'README document');
  assert.equal(graphLinks[3].line.alpha, 0);
  assert.equal(graphLinks[3].arrow.visible, false);
  assert.equal(graphLinks[3].arrow.eventMode, 'none');
  graphLinks[3].render();
  assert.equal(graphLinks[3].line.alpha, 0);
  assert.equal(graphLinks[3].arrow.visible, false);
  assert.equal(graphLinks[3].arrow.renderable, false);
  assert.equal(graphLinks[0].line.texture, originalTextures[0]);
  assert.notEqual(graphLinks[1].line.texture, originalTextures[1]);
  assert.equal(graphLinks[1].line.tint, 0xffffff);
  assert.deepEqual(
    graphLinks[1].line.texture.source.colorStops,
    [
      [0, coreColorHex(nodes[0].color.rgb)],
      [1, coreColorHex(nodes[3].color.rgb)],
    ]
  );
  assert.equal(legendChildren.length, 1);
  assert.equal(cachedReadCount, ids.length);
  await plugin.recompute();
  assert.equal(cachedReadCount, ids.length);
  const completeLongNote = await plugin.readDocumentContent({
    path: 'Long.md',
    stat: { mtime: 2, size: 24004 },
  });
  assert.equal(completeLongNote.length, 24004);
  assert.ok(completeLongNote.endsWith('TAIL'));
  plugin.settings.colorEdges = false;
  plugin.paintAll();
  assert.equal(graphLinks[3].line.alpha, 0);
  plugin.settings.colorEdges = true;
  plugin.paintAll();
  const baselineBLinkTint = graphLinks[2].line.tint;
  const aCommunity = plugin.analysis.semanticAssignments.get('A1.md');
  const bCommunity = plugin.analysis.semanticAssignments.get('B1.md');
  assert.notEqual(aCommunity, bCommunity);
  const originalNodeClick = renderer.onNodeClick;
  const originalNodeHover = renderer.onNodeHover;
  const originalNodeUnhover = renderer.onNodeUnhover;
  plugin.paintAll();
  assert.equal(renderer.onNodeClick, originalNodeClick);
  renderer.onNodeHover({}, 'A1.md', '');
  assert.equal(originalNodeHoverCount, 1);
  assert.equal(plugin.hoveredCommunity, aCommunity);
  assert.equal(plugin.focusedCommunity, null);
  assert.ok(effectiveNodes.every((node) => node.color.a === 1));
  assert.equal(excludedNode.color.a, 0);
  let rows = legendElement.children.filter((child) =>
    child.className.startsWith('graph-communities-legend-row')
  );
  assert.equal(rows.filter((row) => row.className.includes('is-active')).length, 1);
  assert.equal(rows.find((row) => row.className.includes('is-active')).children[2].textContent, 'NODE');
  renderer.onNodeUnhover();
  assert.equal(originalNodeUnhoverCount, 1);
  assert.equal(plugin.hoveredCommunity, null);

  renderer.onNodeClick({}, 'A1.md', '');
  assert.equal(originalNodeClickCount, 1);
  assert.equal(plugin.focusedCommunity, aCommunity);
  assert.equal(plugin.focusedNodeId, 'A1.md');
  assert.equal(nodes.find((node) => node.id === 'A1.md').color.a, 1);
  assert.equal(nodes.find((node) => node.id === 'B1.md').color.a, 0.55);
  assert.notEqual(
    nodes.find((node) => node.id === 'A1.md').color.rgb,
    plugin.analysis.colors.get('A1.md')
  );
  assert.equal(
    nodes.find((node) => node.id === 'B1.md').color.rgb,
    plugin.analysis.colors.get('B1.md')
  );
  assert.equal(graphLinks[0].line.alpha, 0.95);
  assert.equal(graphLinks[2].line.alpha, 0.189);
  assert.ok(Math.abs(graphLinks[1].line.alpha - 0.072) < 1e-9);
  rows = legendElement.children.filter((child) =>
    child.className.startsWith('graph-communities-legend-row')
  );
  assert.equal(rows.filter((row) => row.className.includes('is-active')).length, 1);
  assert.ok(legendElement.className.includes('is-focused'));

  const bClusterIndex = plugin.analysis.semanticTopics.findIndex(
    (cluster) => cluster.id === bCommunity
  );
  rows[bClusterIndex].eventListeners.get('click')({ stopPropagation() {} });
  assert.equal(plugin.focusSource, 'community');
  assert.equal(plugin.focusedCommunity, bCommunity);
  assert.equal(nodes.find((node) => node.id === 'A1.md').color.a, 0.14);
  assert.equal(nodes.find((node) => node.id === 'B1.md').color.a, 1);
  assert.equal(
    nodes.find((node) => node.id === 'B1.md').color.rgb,
    plugin.analysis.colors.get('B1.md')
  );
  assert.equal(graphLinks[0].line.alpha, 0.01);
  assert.equal(graphLinks[2].line.alpha, 0.98);
  assert.equal(graphLinks[2].line.tint, baselineBLinkTint);
  assert.equal(graphLinks[1].line.alpha, 0.1);
  assert.ok(legendElement.className.includes('is-category-focus'));

  rows = legendElement.children.filter((child) =>
    child.className.startsWith('graph-communities-legend-row')
  );
  rows[bClusterIndex].eventListeners.get('click')({ stopPropagation() {} });
  assert.equal(plugin.focusedCommunity, null);
  assert.ok(effectiveNodes.every((node) => node.color.a === 1));
  assert.equal(excludedNode.color.a, 0);
  assert.ok(!legendElement.className.includes('is-focused'));
  assert.ok(!legendElement.className.includes('is-category-focus'));
  assert.equal(graphLinks[0].line.alpha, 0.42);
  assert.equal(graphLinks[1].line.alpha, 0.16);

  const aCluster = plugin.analysis.semanticTopics.find(
    (cluster) => cluster.id === aCommunity
  );
  const projectParent = plugin.analysis.semanticThemes.find(
    (parent) => parent.key === aCluster.parentKey
  );
  plugin.toggleParentFocus(projectParent);
  assert.equal(plugin.focusSource, 'parent');
  assert.equal(plugin.focusedParentKey, projectParent.key);
  assert.equal(nodes.find((node) => node.id === 'A1.md').color.a, 1);
  assert.equal(
    nodes.find((node) => node.id === 'A1.md').color.rgb,
    plugin.analysis.colors.get('A1.md')
  );
  assert.equal(nodes.find((node) => node.id === 'B1.md').color.a, 0.14);
  assert.equal(graphLinks[0].line.alpha, 0.98);
  assert.equal(graphLinks[2].line.alpha, 0.01);
  const parentRow = legendElement.children.find(
    (child) => child.className.includes('graph-communities-parent-row')
  );
  assert.ok(parentRow.className.includes('is-active'));
  parentRow.eventListeners.get('click')({ stopPropagation() {} });
  assert.equal(plugin.focusedParentKey, null);
  assert.ok(effectiveNodes.every((node) => node.color.a === 1));
  assert.equal(excludedNode.color.a, 0);

  const duplicateLabelNodes = ['Folder-A/README.md', 'Folder-B/README.md'].map((id) => {
    const node = Object.create(graphNodePrototype);
    node.id = id;
    node.type = '';
    node.text = { text: node.getDisplayText() };
    return node;
  });
  renderer.nodes.push(...duplicateLabelNodes);
  plugin.paintAll();
  assert.equal(duplicateLabelNodes[0].getDisplayText(), 'Folder-A / README');
  assert.equal(duplicateLabelNodes[0].text.text, 'Folder-A / README');
  assert.equal(duplicateLabelNodes[1].getDisplayText(), 'Folder-B / README');
  assert.equal(duplicateLabelNodes[1].text.text, 'Folder-B / README');

  plugin.onunload();
  assert.notEqual(renderer.onNodeClick, originalNodeClick);
  assert.notEqual(renderer.onNodeHover, originalNodeHover);
  assert.notEqual(renderer.onNodeUnhover, originalNodeUnhover);
  renderer.onNodeClick({}, 'B1.md', '');
  renderer.onNodeHover({}, 'B1.md', '');
  renderer.onNodeUnhover();
  assert.equal(originalNodeClickCount, 2);
  assert.equal(originalNodeHoverCount, 2);
  assert.equal(originalNodeUnhoverCount, 2);
  assert.equal(duplicateLabelNodes[0].getDisplayText(), 'README');
  assert.equal(duplicateLabelNodes[0].text.text, 'README');
  assert.equal(duplicateLabelNodes[1].getDisplayText(), 'README');
  assert.equal(duplicateLabelNodes[1].text.text, 'README');
  assert.ok(nodes.every((node) => node.color.rgb === 0x999999));
  assert.equal(excludedNode.text.visible, true);
  assert.equal(excludedNode.circle.visible, true);
  assert.equal(excludedNode.sprite.visible, true);
  assert.equal(excludedNode.eventMode, 'static');
  assert.equal(excludedNode.circle.eventMode, 'static');
  assert.equal(excludedNode.render, graphNodePrototype.render);
  assert.ok(graphLinks.every((link) => link.line.tint === 0x777777));
  assert.ok(graphLinks.every((link) => link.line.alpha === 0.8));
  assert.ok(graphLinks.every((link) => link.arrow.visible === true));
  assert.ok(graphLinks.every((link) => link.arrow.eventMode === 'static'));
  assert.deepEqual(graphLinks.map((link) => link.line.texture), originalTextures);
  assert.ok(generatedTextures.every((texture) => texture.destroyed));
});

test('overlapping recomputes commit only the newest manifest and exclusions', async () => {
  const source = readFileSync(path.join(__dirname, '..', 'src', 'plugin.js'), 'utf8');
  const core = {
    ...require('../src/graph-core'),
    analyzeGraph() { return {}; },
  };
  const manifestReads = [];
  let fileSnapshot = 0;
  const snapshots = [
    ['README.md', 'Old.md'],
    ['CHANGELOG.md', 'New.md'],
  ];
  const app = {
    metadataCache: {
      resolvedLinks: {},
      getFileCache() { return {}; },
    },
    vault: {
      adapter: {
        async exists() { return true; },
        read() {
          return new Promise((resolve) => manifestReads.push(resolve));
        },
      },
      getMarkdownFiles() {
        const paths = snapshots[Math.min(fileSnapshot, snapshots.length - 1)];
        fileSnapshot += 1;
        return paths.map((filePath) => ({
          path: filePath,
          stat: { mtime: fileSnapshot, size: 64 },
        }));
      },
      async cachedRead(file) {
        return `# ${file.path}\nA reusable knowledge note with enough meaningful content.`;
      },
    },
  };

  class FakePlugin {
    constructor(fakeApp) { this.app = fakeApp; }
    async loadData() { return {}; }
  }
  class FakeNotice {}
  const moduleObject = { exports: {} };
  vm.runInNewContext(source, {
    module: moduleObject,
    exports: moduleObject.exports,
    require(id) {
      if (id === 'obsidian') {
        return {
          Notice: FakeNotice,
          Plugin: FakePlugin,
          PluginSettingTab: class {},
          Setting: class {},
          debounce: (callback) => callback,
        };
      }
      if (id === './graph-core') return core;
      throw new Error(`Unexpected require: ${id}`);
    },
    console,
  }, { filename: 'src/plugin.js' });

  const PluginClass = moduleObject.exports;
  const plugin = new PluginClass(app);
  await plugin.loadSettings();
  plugin.analysis = null;
  plugin.documents = new Map();
  plugin.documentContentCache = new Map();
  plugin.excludedNodeIds = new Set();
  plugin.exclusionReasons = new Map();
  plugin.topicManifest = null;
  plugin.topicManifestState = 'built-in fallback';
  plugin.manifestWarningShown = false;
  plugin.recomputeGeneration = 0;
  plugin.statusBar = { setText() {} };
  plugin.restoreFocusAfterRecompute = () => {};
  plugin.updateStatusBar = () => {};
  plugin.paintAll = () => {};

  const firstRecompute = plugin.recompute();
  await waitFor(() => manifestReads.length === 1);
  const secondRecompute = plugin.recompute();
  await waitFor(() => manifestReads.length === 2);

  manifestReads[1](JSON.stringify(topicManifest('new-theme', 'New Theme')));
  await secondRecompute;
  manifestReads[0](JSON.stringify(topicManifest('old-theme', 'Old Theme')));
  await firstRecompute;

  assert.equal(plugin.topicManifest.themes[0].key, 'new-theme');
  assert.equal(plugin.topicManifestState, 'portable manifest');
  assert.deepEqual([...plugin.excludedNodeIds], ['CHANGELOG.md']);
  assert.deepEqual([...plugin.exclusionReasons], [
    ['CHANGELOG.md', 'CHANGELOG document'],
  ]);
  assert.ok(plugin.documents.has('New.md'));
  assert.ok(!plugin.documents.has('Old.md'));
});

function coreColorHex(value) {
  return `#${Number(value).toString(16).padStart(6, '0').toUpperCase()}`;
}

function topicManifest(key, label) {
  return {
    version: 1,
    themes: [{
      key,
      label,
      color: '#336699',
      topics: [{
        key: `${key}-topic`,
        label: `${label} Topic`,
        color: '#6699CC',
        terms: ['knowledge'],
      }],
    }],
  };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for overlapping recompute');
}
