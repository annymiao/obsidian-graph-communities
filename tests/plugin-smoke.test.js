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
  };
  const ids = ['A0.md', 'A1.md', 'A2.md', 'B0.md', 'B1.md', 'B2.md'];
  const nodes = ids.map((id) => ({ id }));
  const graphLinks = [
    { source: nodes[0], target: nodes[1], line: {} },
    { source: nodes[0], target: nodes[3], line: {} },
    { source: nodes[3], target: nodes[4], line: {} },
  ];
  let changedCount = 0;
  const renderer = {
    nodes,
    links: graphLinks,
    colors: {
      fill: { a: 1, rgb: 0x999999 },
      line: { a: 0.8, rgb: 0x777777 },
    },
    changed() { changedCount += 1; },
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
  const status = { text: '', setText(value) { this.text = value; } };
  const app = {
    metadataCache: {
      resolvedLinks: links,
      on(_event, callback) { listeners.push(callback); return callback; },
    },
    vault: {
      getMarkdownFiles() { return ids.map((filePath) => ({ path: filePath })); },
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

  assert.match(status.text, /2 clusters/);
  assert.ok(changedCount > 0);
  assert.ok(nodes.every((node) => node.color && Number.isInteger(node.color.rgb)));
  assert.notEqual(nodes[0].color.rgb, nodes[3].color.rgb);
  assert.equal(legendChildren.length, 1);

  const aCommunity = plugin.analysis.assignments.get('A1.md');
  const bCommunity = plugin.analysis.assignments.get('B1.md');
  assert.notEqual(aCommunity, bCommunity);
  workspaceListeners.get('file-open')[0]({ path: 'A1.md' });
  assert.equal(plugin.focusedCommunity, aCommunity);
  assert.equal(plugin.focusedNodeId, 'A1.md');
  assert.equal(nodes.find((node) => node.id === 'A1.md').color.a, 1);
  assert.equal(nodes.find((node) => node.id === 'B1.md').color.a, 0.16);
  assert.equal(graphLinks[0].line.alpha, 0.68);
  assert.equal(graphLinks[2].line.alpha, 0.025);
  assert.equal(graphLinks[1].line.alpha, 0.18);
  let rows = legendElement.children.filter((child) =>
    child.className.startsWith('graph-communities-legend-row')
  );
  assert.equal(rows.filter((row) => row.className.includes('is-active')).length, 1);

  const bClusterIndex = plugin.analysis.clusters.findIndex(
    (cluster) => cluster.id === bCommunity
  );
  rows[bClusterIndex].eventListeners.get('click')({ stopPropagation() {} });
  assert.equal(plugin.focusSource, 'community');
  assert.equal(plugin.focusedCommunity, bCommunity);
  assert.equal(nodes.find((node) => node.id === 'A1.md').color.a, 0.16);
  assert.equal(nodes.find((node) => node.id === 'B1.md').color.a, 1);
  assert.equal(graphLinks[0].line.alpha, 0.025);
  assert.equal(graphLinks[2].line.alpha, 0.68);
  assert.equal(graphLinks[1].line.alpha, 0.18);

  rows = legendElement.children.filter((child) =>
    child.className.startsWith('graph-communities-legend-row')
  );
  rows[bClusterIndex].eventListeners.get('click')({ stopPropagation() {} });
  assert.equal(plugin.focusedCommunity, null);
  assert.ok(nodes.every((node) => node.color.a === 1));
  assert.equal(graphLinks[0].line.alpha, 0.42);
  assert.equal(graphLinks[1].line.alpha, 0.16);

  plugin.onunload();
  assert.ok(nodes.every((node) => node.color.rgb === 0x999999));
  assert.ok(graphLinks.every((link) => link.line.tint === 0x777777));
  assert.ok(graphLinks.every((link) => link.line.alpha === 0.8));
});
