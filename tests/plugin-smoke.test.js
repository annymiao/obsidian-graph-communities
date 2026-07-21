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
  const containerEl = {
    querySelector() { return null; },
    appendChild(child) { legendChildren.push(child); },
  };
  const leaf = { view: { renderer, containerEl } };
  const listeners = [];
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
      on(_event, callback) { listeners.push(callback); return callback; },
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
      return {
        tagName,
        className: '',
        style: {},
        textContent: '',
        children: [],
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        replaceChildren(...children) { this.children = [...children]; },
        remove() {},
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

  plugin.onunload();
  assert.ok(nodes.every((node) => node.color.rgb === 0x999999));
  assert.ok(graphLinks.every((link) => link.line.tint === 0x777777));
  assert.ok(graphLinks.every((link) => link.line.alpha === 0.8));
});
