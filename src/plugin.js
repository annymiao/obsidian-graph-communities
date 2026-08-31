'use strict';

const {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  debounce,
} = require('obsidian');
const core = require('./graph-core');

const DEFAULT_SETTINGS = {
  enabled: true,
  resolution: 1,
  maxCommunities: 24,
  minCommunitySize: 2,
  topicAware: true,
  priorityKeywords: '',
  projectWeight: 5,
  semanticWeight: 1.4,
  linkWeight: 0.65,
  projectMaxSize: 1200,
  navigationLinkPenalty: 0.08,
  propagationSteps: 4,
  propagationStrength: 0.52,
  hubAnchor: 0.72,
  peripheralFade: 0.18,
  neutralColor: '#8B92A1',
  colorEdges: true,
  sameCommunityEdgeOpacity: 0.42,
  crossCommunityEdgeOpacity: 0.16,
  showParentFolderInLabels: true,
  showLegend: true,
};

class GraphCommunitiesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.analysis = null;
    this.focusedCommunity = null;
    this.focusedCommunityLabel = null;
    this.focusedParentKey = null;
    this.focusedParentLabel = null;
    this.focusedNodeId = null;
    this.focusSource = null;
    this.hoveredCommunity = null;
    this.hoveredNodeId = null;
    this.rendererHooks = new Map();
    this.rendererNodeLabelCache = new Map();
    this.documentContentCache = new Map();
    this.documents = new Map();
    this.excludedNodeIds = new Set();
    this.exclusionReasons = new Map();
    this.topicManifest = null;
    this.topicManifestState = 'built-in fallback';
    this.manifestWarningShown = false;
    this.gradientTextureCache = new Map();
    this.gradientLineRecords = new Map();
    this.rendererNodeVisibilityCache = new Map();
    this.recomputeGeneration = 0;
    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText('Graph Communities: waiting');
    this.addSettingTab(new GraphCommunitiesSettingTab(this.app, this));

    this.scheduleRecompute = debounce(() => this.recompute(), 650, true);
    this.schedulePaint = debounce(() => this.paintAll(), 120, true);

    this.registerEvent(this.app.metadataCache.on('resolved', this.scheduleRecompute));
    this.registerEvent(this.app.vault.on('create', this.scheduleRecompute));
    this.registerEvent(this.app.vault.on('delete', this.scheduleRecompute));
    this.registerEvent(this.app.vault.on('rename', this.scheduleRecompute));
    this.registerEvent(this.app.vault.on('modify', this.scheduleRecompute));
    this.registerEvent(this.app.workspace.on('layout-change', this.schedulePaint));
    this.registerEvent(this.app.workspace.on('file-open', (file) => this.focusFromFile(file)));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => {
      const file = this.app.workspace.getActiveFile && this.app.workspace.getActiveFile();
      if (file) this.focusFromFile(file);
      else this.schedulePaint();
    }));

    this.registerInterval(
      window.setInterval(() => {
        if (this.settings.enabled && this.analysis) this.paintAll(false);
      }, 900)
    );

    this.addCommand({
      id: 'recompute-graph-communities',
      name: 'Recompute graph communities',
      callback: () => {
        this.recompute();
        new Notice('Graph Communities: recomputing clusters');
      },
    });

    this.addCommand({
      id: 'clear-graph-community-focus',
      name: 'Clear focused graph community',
      callback: () => this.clearFocus(),
    });

    this.addCommand({
      id: 'toggle-graph-community-colors',
      name: 'Toggle community colors',
      callback: async () => {
        this.settings.enabled = !this.settings.enabled;
        await this.saveSettings(false);
        if (this.settings.enabled) {
          await this.recompute();
        } else {
          this.restoreAll();
        }
      },
    });

    this.app.workspace.onLayoutReady(() => this.recompute());
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) || {});
  }

  async saveSettings(recompute = true) {
    await this.saveData(this.settings);
    if (recompute) this.scheduleRecompute();
    else this.schedulePaint();
  }

  async buildGraph() {
    const files = this.app.vault.getMarkdownFiles();
    const {
      topicManifest,
      topicManifestState,
      topicManifestWarning,
    } = await this.readTopicManifest();
    const activePaths = new Set(files.map((file) => file.path));
    for (const cachedPath of this.documentContentCache.keys()) {
      if (!activePaths.has(cachedPath)) this.documentContentCache.delete(cachedPath);
    }
    const documents = [];
    const batchSize = 48;
    for (let index = 0; index < files.length; index += batchSize) {
      const batch = await Promise.all(files.slice(index, index + batchSize).map(async (file) => {
        const cache = this.app.metadataCache.getFileCache
          ? this.app.metadataCache.getFileCache(file) || {}
          : {};
        const frontmatter = cache.frontmatter || {};
        const tags = [
          ...(cache.tags || []).map((tag) => tag.tag),
          ...toStringArray(frontmatter.tags),
          ...toStringArray(frontmatter.tag),
        ];
        return {
          id: file.path,
          path: file.path,
          title: frontmatter.title || displayName(file.path),
          aliases: [
            ...toStringArray(frontmatter.aliases),
            ...toStringArray(frontmatter.alias),
          ],
          tags,
          headings: (cache.headings || []).map((heading) => heading.heading),
          content: await this.readDocumentContent(file),
          frontmatter,
          graphPrimaryTheme: frontmatter.graph_primary_theme,
          graphPrimaryTopic: frontmatter.graph_primary_topic,
          graphSecondaryTopics: toStringArray(frontmatter.graph_secondary_topics),
          graphExclude: frontmatter.graph_exclude,
          graphExcludeReason: frontmatter.graph_exclude_reason,
        };
      }));
      documents.push(...batch);
    }
    const filtered = core.filterEffectiveDocuments(documents);
    const exclusionReasons = filtered.excluded;
    const excludedNodeIds = new Set(filtered.excluded.keys());
    const effectiveIds = filtered.effective.map((document) => document.id);
    const linkGraph = core.graphFromResolvedLinks(
      this.app.metadataCache.resolvedLinks || {},
      effectiveIds,
      { restrictToNodeIds: true }
    );
    const model = core.buildHybridGraph(linkGraph, filtered.effective, {
      priorityKeywords: this.settings.priorityKeywords,
      linkWeight: this.settings.topicAware ? this.settings.linkWeight : 1,
      projectWeight: this.settings.topicAware ? this.settings.projectWeight : 0,
      semanticWeight: this.settings.topicAware ? this.settings.semanticWeight : 0,
      navigationLinkPenalty: this.settings.topicAware
        ? this.settings.navigationLinkPenalty
        : 1,
      projectMaxSize: this.settings.projectMaxSize,
      topicManifest,
    });
    return {
      ...model,
      topicManifest,
      topicManifestState,
      topicManifestWarning,
      exclusionReasons,
      excludedNodeIds,
    };
  }

  async readTopicManifest() {
    const manifestPath = '.codex/graph/topic-manifest.json';
    try {
      const adapter = this.app.vault.adapter;
      let source = null;
      if (
        adapter &&
        typeof adapter.exists === 'function' &&
        typeof adapter.read === 'function'
      ) {
        if (await adapter.exists(manifestPath)) {
          source = await adapter.read(manifestPath);
        }
      } else {
        const file = typeof this.app.vault.getAbstractFileByPath === 'function'
          ? this.app.vault.getAbstractFileByPath(manifestPath)
          : null;
        if (file) {
          source = typeof this.app.vault.cachedRead === 'function'
            ? await this.app.vault.cachedRead(file)
            : await this.app.vault.read(file);
        }
      }
      if (source == null) {
        return {
          topicManifest: null,
          topicManifestState: 'built-in fallback',
          topicManifestWarning: null,
        };
      }
      const manifest = core.normalizeTopicManifest(JSON.parse(source));
      if (!manifest.valid) throw new Error(manifest.error || 'invalid schema');
      return {
        topicManifest: manifest,
        topicManifestState: 'portable manifest',
        topicManifestWarning: null,
      };
    } catch (error) {
      return {
        topicManifest: null,
        topicManifestState: `manifest invalid · ${error.message || 'parse error'}`,
        topicManifestWarning:
          'Graph Communities: topic manifest is invalid; using built-in topics',
      };
    }
  }

  async readDocumentContent(file) {
    if (!file || !file.path || typeof this.app.vault.cachedRead !== 'function') return '';
    const revision = `${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`;
    const cached = this.documentContentCache.get(file.path);
    if (cached && cached.revision === revision) return cached.content;
    try {
      const source = await this.app.vault.cachedRead(file);
      // Exclusion, duplicate detection, and semantic classification all use
      // the complete local file so the plugin and portable curator agree.
      const content = String(source || '');
      this.documentContentCache.set(file.path, { revision, content });
      return content;
    } catch {
      return '';
    }
  }

  async recompute() {
    const generation = ++this.recomputeGeneration;
    if (!this.settings.enabled) {
      this.restoreAll();
      return;
    }
    this.statusBar.setText('Graph Communities: analyzing note content');
    const model = await this.buildGraph();
    if (generation !== this.recomputeGeneration) return;
    const analysis = core.analyzeGraph(model.graph, {
      resolution: this.settings.resolution,
      maxCommunities: this.settings.maxCommunities,
      minCommunitySize: this.settings.minCommunitySize,
      propagationSteps: this.settings.propagationSteps,
      propagationStrength: this.settings.propagationStrength,
      hubAnchor: this.settings.hubAnchor,
      peripheralFade: this.settings.peripheralFade,
      neutralColor: this.settings.neutralColor,
      documents: model.documents,
      priorityKeywords: model.priorityKeywords,
      projectFirst: this.settings.topicAware,
      topicManifest: model.topicManifest,
    });

    // Publish one generation's derived state together only after it wins the
    // generation check. A slower, older recompute must remain side-effect free.
    this.topicManifest = model.topicManifest;
    this.topicManifestState = model.topicManifestState;
    this.exclusionReasons = model.exclusionReasons;
    this.excludedNodeIds = model.excludedNodeIds;
    this.documents = model.documents;
    this.analysis = analysis;
    if (model.topicManifestWarning && !this.manifestWarningShown) {
      this.manifestWarningShown = true;
      new Notice(model.topicManifestWarning);
    }
    this.hoveredCommunity = null;
    this.hoveredNodeId = null;
    this.restoreFocusAfterRecompute();
    this.updateStatusBar();
    this.paintAll();
  }

  restoreFocusAfterRecompute() {
    if (!this.analysis) return;
    if (this.focusSource === 'node' && this.focusedNodeId) {
      const community = this.nodeCategory(this.focusedNodeId);
      if (community != null) {
        this.focusedCommunity = community;
        this.focusedCommunityLabel = this.clusterLabel(community);
        return;
      }
    }
    if (this.focusSource === 'community' && this.focusedCommunityLabel) {
      const cluster = this.legendClusters().find(
        (candidate) => candidate.label === this.focusedCommunityLabel
      );
      if (cluster) {
        this.focusedCommunity = cluster.id;
        this.focusedParentKey = null;
        return;
      }
    }
    if (this.focusSource === 'parent' && this.focusedParentLabel) {
      const parent = this.legendParents().find(
        (candidate) => candidate.label === this.focusedParentLabel
      );
      if (parent) {
        this.focusedParentKey = parent.key;
        this.focusedCommunity = null;
        return;
      }
    }
    this.clearFocus(false);
  }

  clusterForCommunity(community) {
    return this.analysis && this.legendClusters().find(
      (candidate) => candidate.id === community
    );
  }

  legendClusters() {
    return this.analysis?.semanticTopics?.length
      ? this.analysis.semanticTopics
      : this.analysis?.clusters || [];
  }

  legendParents() {
    return this.analysis?.semanticThemes?.length
      ? this.analysis.semanticThemes
      : this.analysis?.parents || [];
  }

  nodeCategory(id) {
    if (!this.analysis) return null;
    return this.analysis.semanticAssignments?.get(id) ??
      this.analysis.assignments.get(id) ??
      null;
  }

  clusterLabel(community) {
    const cluster = this.clusterForCommunity(community);
    return cluster ? cluster.label : null;
  }

  parentKeyForCommunity(community) {
    return this.clusterForCommunity(community)?.parentKey || null;
  }

  focusIsActive() {
    return this.focusedCommunity != null || this.focusedParentKey != null;
  }

  focusDimsOtherCommunities() {
    return this.focusSource === 'community' || this.focusSource === 'parent';
  }

  communityMatchesFocus(community) {
    if (this.focusedParentKey != null) {
      return this.parentKeyForCommunity(community) === this.focusedParentKey;
    }
    return this.focusedCommunity != null && community === this.focusedCommunity;
  }

  focusFromFile(file) {
    if (!this.analysis || !file || !file.path) return;
    const community = this.nodeCategory(file.path);
    if (community == null) {
      if (this.focusSource === 'node') this.clearFocus();
      return;
    }
    this.focusedCommunity = community;
    this.focusedCommunityLabel = this.clusterLabel(community);
    this.focusedParentKey = null;
    this.focusedParentLabel = null;
    this.focusedNodeId = file.path;
    this.focusSource = 'node';
    this.updateStatusBar();
    this.paintAll(true);
  }

  previewFromGraphNode(id) {
    if (!this.analysis || typeof id !== 'string') return;
    const community = this.nodeCategory(id);
    if (community == null) {
      this.clearGraphNodePreview();
      return;
    }
    if (this.hoveredCommunity === community && this.hoveredNodeId === id) return;
    this.hoveredCommunity = community;
    this.hoveredNodeId = id;
    this.updateStatusBar();
    this.refreshLegends();
  }

  clearGraphNodePreview(refresh = true) {
    if (this.hoveredCommunity == null && this.hoveredNodeId == null) return;
    this.hoveredCommunity = null;
    this.hoveredNodeId = null;
    this.updateStatusBar();
    if (refresh) this.refreshLegends();
  }

  activeLegendCommunity() {
    return this.hoveredCommunity != null ? this.hoveredCommunity : this.focusedCommunity;
  }

  activeLegendParentKey() {
    const activeCommunity = this.activeLegendCommunity();
    return activeCommunity != null
      ? this.parentKeyForCommunity(activeCommunity)
      : this.focusedParentKey;
  }

  refreshLegends() {
    for (const leaf of this.graphLeaves()) this.updateLegend(leaf && leaf.view);
  }

  toggleCommunityFocus(cluster) {
    this.clearGraphNodePreview(false);
    if (this.focusSource === 'community' && this.focusedCommunity === cluster.id) {
      this.clearFocus();
      return;
    }
    this.focusedCommunity = cluster.id;
    this.focusedCommunityLabel = cluster.label;
    this.focusedParentKey = null;
    this.focusedParentLabel = null;
    this.focusedNodeId = null;
    this.focusSource = 'community';
    this.updateStatusBar();
    this.paintAll(true);
  }

  toggleParentFocus(parent) {
    this.clearGraphNodePreview(false);
    if (this.focusSource === 'parent' && this.focusedParentKey === parent.key) {
      this.clearFocus();
      return;
    }
    this.focusedCommunity = null;
    this.focusedCommunityLabel = null;
    this.focusedParentKey = parent.key;
    this.focusedParentLabel = parent.label;
    this.focusedNodeId = null;
    this.focusSource = 'parent';
    this.updateStatusBar();
    this.paintAll(true);
  }

  clearFocus(repaint = true) {
    this.clearGraphNodePreview(false);
    this.focusedCommunity = null;
    this.focusedCommunityLabel = null;
    this.focusedParentKey = null;
    this.focusedParentLabel = null;
    this.focusedNodeId = null;
    this.focusSource = null;
    this.updateStatusBar();
    if (repaint) this.paintAll(true);
  }

  updateStatusBar() {
    if (!this.statusBar || !this.analysis) return;
    if (this.focusedParentKey != null && this.hoveredCommunity == null) {
      const parent = this.legendParents().find(
        (candidate) => candidate.key === this.focusedParentKey
      );
      if (parent) {
        this.statusBar.setText(
          `Graph Communities: ${parent.label} · ${parent.size} notes focused`
        );
        return;
      }
    }
    const activeCommunity = this.activeLegendCommunity();
    if (activeCommunity != null) {
      const cluster = this.legendClusters().find(
        (candidate) => candidate.id === activeCommunity
      );
      if (cluster) {
        this.statusBar.setText(
          `Graph Communities: ${cluster.label} · ${cluster.size} notes ${
            this.hoveredCommunity != null ? 'previewed' : 'focused'
          }`
        );
        return;
      }
    }
    this.statusBar.setText(
      `Graph Communities: ${this.legendParents().length} themes · ` +
      `${this.analysis.effectiveCount ?? this.analysis.nodeCount} effective notes`
    );
  }

  graphLeaves() {
    return [
      ...this.app.workspace.getLeavesOfType('graph'),
      ...this.app.workspace.getLeavesOfType('localgraph'),
    ];
  }

  ensureRendererHook(renderer) {
    if (!renderer) return;
    let hooks = this.rendererHooks.get(renderer);
    if (!hooks) {
      hooks = {};
      this.rendererHooks.set(renderer, hooks);
    }
    this.ensureRendererCallback(renderer, hooks, 'onNodeClick', (_event, id, type) => {
      if (type !== 'tag' && typeof id === 'string') this.focusFromFile({ path: id });
    });
    this.ensureRendererCallback(renderer, hooks, 'onNodeHover', (_event, id, type) => {
      if (type !== 'tag' && typeof id === 'string') this.previewFromGraphNode(id);
    });
    this.ensureRendererCallback(renderer, hooks, 'onNodeUnhover', () => {
      this.clearGraphNodePreview();
    });
  }

  ensureRendererCallback(renderer, hooks, property, before) {
    const installed = hooks[property];
    if (installed && renderer[property] === installed.wrapper) return;
    const original = renderer[property];
    const wrapper = function (...args) {
      before(...args);
      if (typeof original === 'function') return original.apply(this, args);
      return undefined;
    };
    hooks[property] = { original, wrapper };
    renderer[property] = wrapper;
  }

  restoreRendererHooks() {
    for (const [renderer, hooks] of this.rendererHooks) {
      for (const [property, hook] of Object.entries(hooks)) {
        if (renderer[property] === hook.wrapper) renderer[property] = hook.original;
      }
    }
    this.rendererHooks.clear();
  }

  applyNodeLabel(renderer, node) {
    if (!node || typeof node.id !== 'string' || node.type === 'tag') return false;
    let cache = this.rendererNodeLabelCache.get(renderer);
    const shouldQualify = this.settings.showParentFolderInLabels;
    let record = cache && cache.get(node);

    if (!shouldQualify) {
      if (!record) return false;
      const changed = this.restoreNodeLabel(node, record);
      cache.delete(node);
      if (cache.size === 0) this.rendererNodeLabelCache.delete(renderer);
      return changed;
    }

    const label = qualifiedDisplayName(node.id);
    if (!record) {
      if (!cache) {
        cache = new Map();
        this.rendererNodeLabelCache.set(renderer, cache);
      }
      const wrapper = function () {
        return qualifiedDisplayName(this.id);
      };
      record = {
        hadOwnMethod: Object.prototype.hasOwnProperty.call(node, 'getDisplayText'),
        originalMethod: node.getDisplayText,
        wrapper,
      };
      cache.set(node, record);
      node.getDisplayText = wrapper;
    }

    let changed = false;
    if (node.getDisplayText !== record.wrapper) {
      record.hadOwnMethod = Object.prototype.hasOwnProperty.call(node, 'getDisplayText');
      record.originalMethod = node.getDisplayText;
      node.getDisplayText = record.wrapper;
      changed = true;
    }
    if (node.text && node.text.text !== label) {
      node.text.text = label;
      changed = true;
    }
    return changed;
  }

  restoreNodeLabel(node, record) {
    let changed = false;
    if (node.getDisplayText === record.wrapper) {
      if (record.hadOwnMethod) node.getDisplayText = record.originalMethod;
      else delete node.getDisplayText;
      changed = true;
    }
    if (node.text) {
      const originalLabel = typeof node.getDisplayText === 'function'
        ? node.getDisplayText()
        : displayName(node.id);
      if (node.text.text !== originalLabel) {
        node.text.text = originalLabel;
        changed = true;
      }
    }
    return changed;
  }

  restoreAllNodeLabels() {
    for (const [renderer, cache] of this.rendererNodeLabelCache) {
      let changed = false;
      for (const [node, record] of cache) {
        changed = this.restoreNodeLabel(node, record) || changed;
      }
      if (changed && typeof renderer.changed === 'function') renderer.changed();
    }
    this.rendererNodeLabelCache.clear();
  }

  applyNodeVisibility(renderer, node, excluded) {
    if (!node || node.type === 'tag') return false;
    let cache = this.rendererNodeVisibilityCache.get(renderer);
    let record = cache?.get(node);
    if (!excluded) {
      if (!record) return false;
      this.restoreNodeVisibilityRecord(node, record);
      cache.delete(node);
      if (!cache.size) this.rendererNodeVisibilityCache.delete(renderer);
      return true;
    }
    if (!record) {
      if (!cache) {
        cache = new Map();
        this.rendererNodeVisibilityCache.set(renderer, cache);
      }
      const plugin = this;
      record = {
        visuals: new Map(),
        hadOwnRender: Object.prototype.hasOwnProperty.call(node, 'render'),
        originalRender: node.render,
        wrapper: null,
      };
      if (typeof node.render === 'function') {
        record.wrapper = function (...args) {
          const result = record.originalRender.apply(this, args);
          plugin.enforceNodeHidden(node, record);
          return result;
        };
        node.render = record.wrapper;
      }
      cache.set(node, record);
    } else if (
      record.wrapper &&
      node.render !== record.wrapper &&
      typeof node.render === 'function'
    ) {
      record.hadOwnRender = Object.prototype.hasOwnProperty.call(node, 'render');
      record.originalRender = node.render;
      node.render = record.wrapper;
    }
    this.enforceNodeHidden(node, record);
    return true;
  }

  nodeVisibilityTargets(node) {
    return [...new Set([
      node,
      node.text,
      node.circle,
      node.sprite,
      node.graphics,
      node.highlight,
    ].filter(Boolean))];
  }

  enforceNodeHidden(node, record) {
    const visualProperties = ['visible', 'alpha', 'renderable'];
    const interactionProperties = [
      'eventMode',
      'interactive',
      'interactiveChildren',
      'buttonMode',
    ];
    for (const target of this.nodeVisibilityTargets(node)) {
      if (!record.visuals.has(target)) {
        const properties = {};
        for (const property of [...visualProperties, ...interactionProperties]) {
          if (property in target) properties[property] = target[property];
        }
        record.visuals.set(target, properties);
      }
      if (target !== node) {
        if ('visible' in target) target.visible = false;
        if ('alpha' in target) target.alpha = 0;
        if ('renderable' in target) target.renderable = false;
      }
      if ('eventMode' in target) target.eventMode = 'none';
      if ('interactive' in target) target.interactive = false;
      if ('interactiveChildren' in target) target.interactiveChildren = false;
      if ('buttonMode' in target) target.buttonMode = false;
    }
  }

  restoreNodeVisibilityRecord(node, record) {
    if (record.wrapper && node.render === record.wrapper) {
      if (record.hadOwnRender) node.render = record.originalRender;
      else delete node.render;
    }
    for (const [target, properties] of record.visuals) {
      for (const [property, value] of Object.entries(properties)) {
        target[property] = value;
      }
    }
  }

  restoreAllNodeVisibility() {
    for (const [renderer, cache] of this.rendererNodeVisibilityCache) {
      let changed = false;
      for (const [node, record] of cache) {
        this.restoreNodeVisibilityRecord(node, record);
        changed = true;
      }
      if (changed && typeof renderer.changed === 'function') renderer.changed();
    }
    this.rendererNodeVisibilityCache.clear();
  }

  gradientTexture(sourceColor, targetColor, ownerDocument, line) {
    if (sourceColor === targetColor) return null;
    const textureConstructor = line?.texture?.constructor;
    if (!textureConstructor || typeof textureConstructor.from !== 'function') return null;
    const key = `${sourceColor.toString(16)}>${targetColor.toString(16)}`;
    const cached = this.gradientTextureCache.get(key);
    if (cached?.textureConstructor === textureConstructor) return cached.texture;
    try {
      const canvas = ownerDocument.createElement('canvas');
      canvas.width = 64;
      canvas.height = 2;
      const context = canvas.getContext('2d');
      if (!context) return null;
      const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
      gradient.addColorStop(0, core.rgbIntToHex(sourceColor));
      gradient.addColorStop(1, core.rgbIntToHex(targetColor));
      context.fillStyle = gradient;
      context.fillRect(0, 0, canvas.width, canvas.height);
      const texture = textureConstructor.from(canvas);
      if (!texture) return null;
      this.gradientTextureCache.set(key, { texture, textureConstructor });
      return texture;
    } catch {
      return null;
    }
  }

  ensureGradientLineRecord(link) {
    if (!link?.line) return null;
    let record = this.gradientLineRecords.get(link);
    if (record && record.line === link.line) {
      if (
        record.wrapper &&
        link.render !== record.wrapper &&
        typeof link.render === 'function'
      ) {
        record.hadOwnRender = Object.prototype.hasOwnProperty.call(link, 'render');
        record.originalRender = link.render;
        link.render = record.wrapper;
      }
      return record;
    }
    if (record) this.restoreGradientLine(link, record);
    const plugin = this;
    record = {
      link,
      line: link.line,
      originalTexture: link.line.texture,
      originalTint: link.line.tint,
      originalAlpha: link.line.alpha,
      hadOwnRender: Object.prototype.hasOwnProperty.call(link, 'render'),
      originalRender: link.render,
      wrapper: null,
      spec: null,
      hiddenDecorations: new Map(),
    };
    if (typeof record.originalRender === 'function') {
      record.wrapper = function (...args) {
        const result = record.originalRender.apply(this, args);
        plugin.applyGradientLineSpec(record);
        return result;
      };
      link.render = record.wrapper;
    }
    this.gradientLineRecords.set(link, record);
    return record;
  }

  applyGradientLineSpec(record) {
    const line = record?.line;
    const spec = record?.spec;
    if (!line || !spec) return;
    line.texture = spec.texture ?? record.originalTexture;
    line.tint = spec.tint;
    line.alpha = spec.alpha;
    if (spec.kind === 'hidden') this.enforceHiddenLinkDecorations(record);
  }

  setGradientLine(link, sourceColor, targetColor, alpha, ownerDocument) {
    const record = this.ensureGradientLineRecord(link);
    if (!record) return false;
    this.restoreHiddenLinkDecorations(record);
    const texture = this.gradientTexture(sourceColor, targetColor, ownerDocument, record.line);
    record.spec = texture
      ? { texture, tint: 0xffffff, alpha, kind: 'gradient' }
      : {
        texture: record.originalTexture,
        tint: sourceColor === targetColor
          ? sourceColor
          : core.blendRgbInts([sourceColor, targetColor], [1, 1]),
        alpha,
        kind: sourceColor === targetColor ? 'solid' : 'fallback',
      };
    this.applyGradientLineSpec(record);
    return true;
  }

  enforceHiddenLinkDecorations(record) {
    const arrow = record.link?.arrow;
    if (!arrow) return;
    if (!record.hiddenDecorations.has(arrow)) {
      const properties = {};
      for (const property of [
        'visible',
        'alpha',
        'renderable',
        'eventMode',
        'interactive',
        'buttonMode',
      ]) {
        if (property in arrow) properties[property] = arrow[property];
      }
      record.hiddenDecorations.set(arrow, properties);
    }
    if ('visible' in arrow) arrow.visible = false;
    if ('alpha' in arrow) arrow.alpha = 0;
    if ('renderable' in arrow) arrow.renderable = false;
    if ('eventMode' in arrow) arrow.eventMode = 'none';
    if ('interactive' in arrow) arrow.interactive = false;
    if ('buttonMode' in arrow) arrow.buttonMode = false;
  }

  restoreHiddenLinkDecorations(record) {
    for (const [target, properties] of record.hiddenDecorations || []) {
      for (const [property, value] of Object.entries(properties)) {
        target[property] = value;
      }
    }
    record.hiddenDecorations?.clear();
  }

  hideGradientLine(link) {
    const record = this.ensureGradientLineRecord(link);
    if (!record) return false;
    record.spec = {
      texture: record.originalTexture,
      tint: record.originalTint,
      alpha: 0,
      kind: 'hidden',
    };
    this.applyGradientLineSpec(record);
    return true;
  }

  restoreGradientLine(link, record = this.gradientLineRecords.get(link)) {
    if (!record) return;
    if (record.wrapper && link.render === record.wrapper) {
      if (record.hadOwnRender) link.render = record.originalRender;
      else delete link.render;
    }
    this.restoreHiddenLinkDecorations(record);
    if (record.line) {
      record.line.texture = record.originalTexture;
      record.line.tint = record.originalTint;
      record.line.alpha = record.originalAlpha;
    }
    this.gradientLineRecords.delete(link);
  }

  restoreGradientLines(destroyTextures = false) {
    for (const [link, record] of [...this.gradientLineRecords.entries()]) {
      this.restoreGradientLine(link, record);
    }
    if (destroyTextures) {
      for (const { texture } of this.gradientTextureCache.values()) {
        if (texture && typeof texture.destroy === 'function') texture.destroy(true);
      }
      this.gradientTextureCache.clear();
    }
  }

  paintAll(forceChanged = true) {
    if (!this.settings.enabled || !this.analysis) return;
    for (const leaf of this.graphLeaves()) this.paintLeaf(leaf, forceChanged);
  }

  paintLeaf(leaf, forceChanged = true) {
    const view = leaf && leaf.view;
    const renderer = view && view.renderer;
    if (!renderer || !Array.isArray(renderer.nodes)) return;
    this.ensureRendererHook(renderer);
    let changed = false;

    for (const node of renderer.nodes) {
      const excluded = typeof node.id === 'string' && this.excludedNodeIds.has(node.id);
      changed = this.applyNodeVisibility(renderer, node, excluded) || changed;
      if (excluded) {
        const neutral = core.hexToRgbInt(this.settings.neutralColor);
        if (!node.color || node.color.rgb !== neutral || node.color.a !== 0) {
          node.color = { a: 0, rgb: neutral };
          changed = true;
        }
        continue;
      }
      changed = this.applyNodeLabel(renderer, node) || changed;
      const rgb = this.analysis.colors.get(node.id);
      if (rgb == null) continue;
      const community = this.nodeCategory(node.id);
      const isFocusedCommunity = this.communityMatchesFocus(community);
      const visibility = Math.max(
        0.01,
        Math.min(1, this.documents.get(node.id)?.displayWeight ?? 1)
      );
      let displayRgb = rgb;
      let alpha = visibility;
      if (this.focusIsActive()) {
        if (isFocusedCommunity) {
          const categoryFocus = this.focusSource === 'community' || this.focusSource === 'parent';
          if (categoryFocus) {
            // Legend selection should reveal the category's semantic color,
            // not wash it toward white. Full opacity creates the highlight
            // while leaving Obsidian's node size and graph layout untouched.
            displayRgb = rgb;
            alpha = 1;
          } else {
            displayRgb = core.mixRgb(
              rgb,
              0xffffff,
              node.id === this.focusedNodeId ? 0.68 : 0.22
            );
            alpha = node.id === this.focusedNodeId
              ? 1
              : Math.max(visibility, visibility >= 0.5 ? 0.96 : 0.58);
          }
        } else if (this.focusDimsOtherCommunities()) {
          const neutral = core.hexToRgbInt(this.settings.neutralColor);
          displayRgb = core.mixRgb(rgb, neutral, 0.72);
          alpha = Math.max(0.07, visibility * 0.14);
        } else if (this.focusSource === 'node') {
          // Keep unrelated hues intact on node selection, but lower their
          // opacity enough for the selected node and its category to stand out.
          alpha = Math.max(0.24, visibility * 0.55);
        }
      }
      if (!node.color || node.color.rgb !== displayRgb || node.color.a !== alpha) {
        node.color = { a: alpha, rgb: displayRgb };
        changed = true;
      }
    }

    if (Array.isArray(renderer.links)) {
      const defaultLine = renderer.colors && renderer.colors.line;
      for (const link of renderer.links) {
        const sourceId = nodeId(link.source);
        const targetId = nodeId(link.target);
        if (
          this.excludedNodeIds.has(sourceId) ||
          this.excludedNodeIds.has(targetId)
        ) {
          changed = this.hideGradientLine(link) || changed;
          continue;
        }
        if (!this.settings.colorEdges) {
          this.restoreGradientLine(link);
          if (!link.line) continue;
          const defaultTint = defaultLine && defaultLine.rgb;
          const defaultAlpha = defaultLine && defaultLine.a != null ? defaultLine.a : 1;
          if (defaultTint != null && link.line.tint !== defaultTint) {
            link.line.tint = defaultTint;
            changed = true;
          }
          if (link.line.alpha !== defaultAlpha) {
            link.line.alpha = defaultAlpha;
            changed = true;
          }
          continue;
        }
        const sourceColor = this.analysis.colors.get(sourceId);
        const targetColor = this.analysis.colors.get(targetId);
        if (sourceColor == null || targetColor == null || !link.line) continue;
        const tint = core.blendRgbInts([sourceColor, targetColor], [1, 1]);
        const sourceCommunity = this.nodeCategory(sourceId);
        const targetCommunity = this.nodeCategory(targetId);
        const sameCommunity =
          sourceCommunity != null &&
          sourceCommunity === targetCommunity;
        let alpha = sameCommunity
          ? this.settings.sameCommunityEdgeOpacity
          : this.settings.crossCommunityEdgeOpacity;
        const sourceVisibility = Math.max(
          0.01,
          Math.min(1, this.documents.get(sourceId)?.displayWeight ?? 1)
        );
        const targetVisibility = Math.max(
          0.01,
          Math.min(1, this.documents.get(targetId)?.displayWeight ?? 1)
        );
        let displayTint = tint;
        let keepFocusedLinkVisible = false;
        if (this.focusIsActive()) {
          const sourceFocused = this.communityMatchesFocus(sourceCommunity);
          const targetFocused = this.communityMatchesFocus(targetCommunity);
          const touchesSelectedNode = this.focusedNodeId != null &&
            (sourceId === this.focusedNodeId || targetId === this.focusedNodeId);
          if (touchesSelectedNode) {
            alpha = Math.max(alpha, 0.95);
            displayTint = core.mixRgb(tint, 0xffffff, 0.38);
          } else if (sourceFocused && targetFocused) {
            const categoryFocus = this.focusSource === 'community' ||
              this.focusSource === 'parent';
            if (categoryFocus) {
              alpha = 0.98;
              displayTint = tint;
              keepFocusedLinkVisible = true;
            } else {
              alpha = Math.max(alpha, 0.82);
              displayTint = core.mixRgb(tint, 0xffffff, 0.18);
            }
          } else if (!this.focusDimsOtherCommunities()) {
            alpha *= 0.45;
          } else if (sourceFocused || targetFocused) {
            alpha = 0.1;
          } else {
            alpha = 0.01;
            displayTint = core.mixRgb(
              tint,
              core.hexToRgbInt(this.settings.neutralColor),
              0.68
            );
          }
        }
        if (!keepFocusedLinkVisible) {
          alpha *= Math.max(0.06, Math.sqrt(sourceVisibility * targetVisibility));
        }
        const ownerDocument = view.containerEl?.ownerDocument ||
          this.app.workspace.containerEl?.ownerDocument ||
          globalThis.document;
        changed = this.setGradientLine(
          link,
          sourceColor,
          targetColor,
          alpha,
          ownerDocument
        ) || changed;
      }
    }

    const legend = view.containerEl && view.containerEl.querySelector('.graph-communities-legend');
    if (forceChanged || !legend) this.updateLegend(view);
    if ((changed || forceChanged) && typeof renderer.changed === 'function') {
      renderer.changed();
    }
  }

  updateLegend(view) {
    const container = view && view.containerEl;
    if (!container) return;
    const ownerDocument = container.ownerDocument || globalThis.document;
    let legend = container.querySelector('.graph-communities-legend');
    if (!this.settings.showLegend || !this.settings.enabled || !this.analysis) {
      if (legend) legend.remove();
      return;
    }
    if (!legend) {
      legend = ownerDocument.createElement('div');
      legend.className = 'graph-communities-legend';
      container.appendChild(legend);
    }
    legend.className = `graph-communities-legend${
      this.focusIsActive() ? ' is-focused' : ''
    }${this.focusSource === 'community' || this.focusSource === 'parent'
      ? ' is-category-focus'
      : ''
    }${this.hoveredCommunity != null ? ' is-previewing' : ''}`;
    legend.replaceChildren();
    const title = ownerDocument.createElement('div');
    title.className = 'graph-communities-legend-title';
    title.textContent = 'Knowledge themes';
    legend.appendChild(title);
    const hint = ownerDocument.createElement('div');
    hint.className = 'graph-communities-legend-hint';
    const activeCommunity = this.activeLegendCommunity();
    const activeCluster = this.clusterForCommunity(activeCommunity);
    const activeLabel = activeCluster?.label || null;
    const activeParentKey = this.activeLegendParentKey();
    const activeParent = this.legendParents().find(
      (candidate) => candidate.key === activeParentKey
    );
    const categoryPath = [activeParent?.label, activeLabel].filter(Boolean).join(' › ');
    const activeNodeId = this.hoveredNodeId || this.focusedNodeId;
    const activeDocument = this.documents.get(activeNodeId) || {};
    const knowledgeLabels = [
      ...(activeDocument.knowledgePoints || []),
      ...(activeDocument.secondaryKnowledgePoints || []),
    ]
      .filter((point, index, list) =>
        list.findIndex((candidate) => candidate.key === point.key) === index
      )
      .slice(0, 5)
      .map((point) => point.label)
      .join(' · ');
    const knowledgeSuffix = knowledgeLabels ? ` · Knowledge: ${knowledgeLabels}` : '';
    if (this.hoveredNodeId) {
      hint.textContent = `Node: ${qualifiedDisplayName(this.hoveredNodeId)} · Category: ${categoryPath}${knowledgeSuffix}`;
    } else if (this.focusedNodeId) {
      hint.textContent = `Selected: ${qualifiedDisplayName(this.focusedNodeId)} · Category: ${categoryPath}${knowledgeSuffix}`;
    } else if (this.focusedParentKey && activeParent) {
      hint.textContent = `Focused project: ${activeParent.label}`;
    } else if (activeLabel) {
      hint.textContent = `Focused category: ${categoryPath}`;
    } else {
      hint.textContent =
        `Source: ${this.topicManifestState} · ` +
        `${this.analysis.effectiveCount ?? this.analysis.nodeCount} effective · ` +
        `${this.excludedNodeIds.size} excluded · click a theme or topic to focus`;
    }
    legend.appendChild(hint);

    const makeInteractive = (row, activate) => {
      row.setAttribute && row.setAttribute('role', 'button');
      row.tabIndex = 0;
      if (typeof row.addEventListener === 'function') {
        row.addEventListener('click', activate);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event);
          }
        });
      }
    };

    const appendClusterRow = (cluster, child = false) => {
      const row = ownerDocument.createElement('div');
      const parentFocused = this.focusedParentKey != null &&
        cluster.parentKey === this.focusedParentKey;
      const isActive = cluster.id === activeCommunity || parentFocused;
      row.className = `graph-communities-legend-row${child ? ' is-child' : ''}${
        isActive ? ' is-active' : ''
      }`;
      row.setAttribute && row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      row.setAttribute && row.setAttribute('aria-label', `Focus topic ${cluster.label}`);
      const swatch = ownerDocument.createElement('span');
      swatch.className = 'graph-communities-swatch';
      swatch.style.backgroundColor = cluster.colorHex;
      const label = ownerDocument.createElement('span');
      label.className = 'graph-communities-label';
      const percentage = Number.isFinite(cluster.percentage)
        ? ` · ${cluster.percentage.toFixed(1)}%`
        : '';
      label.textContent = `${cluster.label} (${cluster.size}${percentage})`;
      label.title = [
        `Representative: ${qualifiedDisplayName(cluster.hub)}`,
        cluster.visibleSize < cluster.size
          ? `${cluster.size - cluster.visibleSize} duplicate/supporting notes dimmed`
          : '',
        cluster.keywords.length ? `Keywords: ${cluster.keywords.join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      row.append(swatch, label);
      if (isActive) {
        const marker = ownerDocument.createElement('span');
        marker.className = 'graph-communities-selection-marker';
        marker.textContent = this.hoveredCommunity != null
          ? 'NODE'
          : parentFocused ? 'GROUP' : 'SELECTED';
        row.appendChild(marker);
      }
      const activate = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.toggleCommunityFocus(cluster);
      };
      makeInteractive(row, activate);
      legend.appendChild(row);
    };

    const appendParentRow = (parent) => {
      const row = ownerDocument.createElement('div');
      const isActive = parent.key === activeParentKey;
      row.className = `graph-communities-parent-row${isActive ? ' is-active' : ''}`;
      row.setAttribute && row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      row.setAttribute && row.setAttribute('aria-label', `Focus theme ${parent.label}`);
      const swatch = ownerDocument.createElement('span');
      swatch.className = 'graph-communities-swatch is-parent';
      swatch.style.backgroundColor = parent.colorHex;
      const label = ownerDocument.createElement('span');
      label.className = 'graph-communities-label';
      const percentage = Number.isFinite(parent.percentage)
        ? ` · ${parent.percentage.toFixed(1)}%`
        : '';
      label.textContent =
        `${parent.label} (${parent.size}${percentage})${parent.recommended ? ' · main' : ''}`;
      row.append(swatch, label);
      if (isActive) {
        const marker = ownerDocument.createElement('span');
        marker.className = 'graph-communities-selection-marker';
        marker.textContent = this.focusSource === 'parent' ? 'SELECTED' : 'PROJECT';
        row.appendChild(marker);
      }
      const activate = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.toggleParentFocus(parent);
      };
      makeInteractive(row, activate);
      legend.appendChild(row);
    };

    const renderedParents = new Set();
    const legendClusters = this.legendClusters();
    const legendParents = this.legendParents();
    for (const cluster of legendClusters) {
      if (!cluster.parentKey) {
        appendClusterRow(cluster);
        continue;
      }
      if (renderedParents.has(cluster.parentKey)) continue;
      renderedParents.add(cluster.parentKey);
      const parent = legendParents.find(
        (candidate) => candidate.key === cluster.parentKey
      );
      if (parent) appendParentRow(parent);
      for (const childCluster of legendClusters.filter(
        (candidate) => candidate.parentKey === cluster.parentKey
      )) {
        appendClusterRow(childCluster, true);
      }
    }
  }

  restoreAll() {
    this.restoreAllNodeLabels();
    this.restoreAllNodeVisibility();
    this.restoreGradientLines(false);
    for (const leaf of this.graphLeaves()) {
      const view = leaf && leaf.view;
      const renderer = view && view.renderer;
      if (!renderer || !Array.isArray(renderer.nodes)) continue;
      const fill = (renderer.colors && renderer.colors.fill) || { a: 1, rgb: 0x999999 };
      const line = (renderer.colors && renderer.colors.line) || { a: 1, rgb: 0x999999 };
      for (const node of renderer.nodes) node.color = { a: fill.a, rgb: fill.rgb };
      if (Array.isArray(renderer.links)) {
        for (const link of renderer.links) {
          if (!link.line) continue;
          link.line.tint = line.rgb;
          link.line.alpha = line.a == null ? 1 : line.a;
        }
      }
      const legend = view.containerEl && view.containerEl.querySelector('.graph-communities-legend');
      if (legend) legend.remove();
      if (typeof renderer.changed === 'function') renderer.changed();
    }
    if (this.statusBar) this.statusBar.setText('Graph Communities: off');
  }

  onunload() {
    this.restoreRendererHooks();
    this.restoreAll();
    this.restoreGradientLines(true);
  }
}

function nodeId(value) {
  if (typeof value === 'string') return value;
  return value && value.id;
}

function displayName(path) {
  const value = String(path || 'Unknown');
  const basename = value.split('/').pop() || value;
  return basename.replace(/\.md$/i, '');
}

function qualifiedDisplayName(path) {
  const value = String(path || 'Unknown').replace(/\\/gu, '/');
  const parts = value.split('/').filter(Boolean);
  const filename = displayName(value);
  if (parts.length < 2) return filename;
  return `${parts[parts.length - 2]} / ${filename}`;
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.flatMap(toStringArray).filter(Boolean);
  if (value == null) return [];
  return String(value).split(/[,，]/u).map((entry) => entry.trim()).filter(Boolean);
}

class GraphCommunitiesSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Graph Communities' });
    containerEl.createEl('p', {
      text: 'Infer local content purpose and topics, combine them with graph relationships, and color related knowledge communities without changing notes.',
    });

    new Setting(containerEl)
      .setName('Enable community colors')
      .setDesc('Color global and local graph nodes without changing any notes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
          this.plugin.settings.enabled = value;
          await this.plugin.saveSettings(false);
          if (value) await this.plugin.recompute();
          else this.plugin.restoreAll();
        })
      );

    new Setting(containerEl)
      .setName('Internal clustering limit')
      .setDesc('Limits only the relationship engine. The semantic theme legend always shows every active theme and topic.')
      .addSlider((slider) =>
        slider
          .setLimits(2, 36, 1)
          .setValue(this.plugin.settings.maxCommunities)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxCommunities = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Minimum community size')
      .setDesc('Tiny groups are merged into connected major communities or shown in neutral gray.')
      .addSlider((slider) =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.minCommunitySize)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.minCommunitySize = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Topic-aware clustering')
      .setDesc('Infer academic/project context and topics from complete local note content, then combine them with metadata and links.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.topicAware).onChange(async (value) => {
          this.plugin.settings.topicAware = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Priority topic keywords')
      .setDesc('Comma-separated terms that should strongly influence grouping and community labels, for example: AI, ASR, Project Atlas.')
      .addTextArea((textArea) =>
        textArea
          .setPlaceholder('AI, LLM, ASR, Project Atlas')
          .setValue(this.plugin.settings.priorityKeywords)
          .onChange(async (value) => {
            this.plugin.settings.priorityKeywords = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Content category cohesion')
      .setDesc('How strongly notes with the same inferred purpose and topic stay together.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 5, 0.1)
          .setValue(this.plugin.settings.projectWeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.projectWeight = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Topic similarity influence')
      .setDesc('How strongly shared inferred tags, metadata, headings, and low-weight path hints affect grouping.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 5, 0.1)
          .setValue(this.plugin.settings.semanticWeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.semanticWeight = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Clustering resolution')
      .setDesc('Lower values produce fewer, larger communities; higher values produce more, smaller communities.')
      .addSlider((slider) =>
        slider
          .setLimits(0.4, 2.2, 0.05)
          .setValue(this.plugin.settings.resolution)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.resolution = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Relationship blending')
      .setDesc('How strongly neighboring notes influence internal community analysis. A note still displays only its primary topic color.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 0.85, 0.05)
          .setValue(this.plugin.settings.propagationStrength)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.propagationStrength = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Blending distance')
      .setDesc('Number of graph hops used by internal relationship analysis.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 10, 1)
          .setValue(this.plugin.settings.propagationSteps)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.propagationSteps = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Soften peripheral notes')
      .setDesc('Blend low-connectivity notes toward the neutral color so hubs remain visually distinct.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 0.65, 0.05)
          .setValue(this.plugin.settings.peripheralFade)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.peripheralFade = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Neutral node color')
      .setDesc('Used for isolated notes and communities too small to classify.')
      .addColorPicker((picker) =>
        picker.setValue(this.plugin.settings.neutralColor).onChange(async (value) => {
          this.plugin.settings.neutralColor = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Color connections')
      .setDesc('Draw each connection as a true source-to-target color gradient when the renderer supports gradient textures.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.colorEdges).onChange(async (value) => {
          this.plugin.settings.colorEdges = value;
          await this.plugin.saveSettings(false);
          this.plugin.paintAll();
        })
      );

    new Setting(containerEl)
      .setName('Show parent folder in graph labels')
      .setDesc('Display file nodes as “parent folder / filename” so repeated names such as README remain distinguishable.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showParentFolderInLabels).onChange(async (value) => {
          this.plugin.settings.showParentFolderInLabels = value;
          await this.plugin.saveSettings(false);
          this.plugin.paintAll(true);
        })
      );

    new Setting(containerEl)
      .setName('Show community legend')
      .setDesc('Display every active knowledge theme and topic with counts and percentages of effective notes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showLegend).onChange(async (value) => {
          this.plugin.settings.showLegend = value;
          await this.plugin.saveSettings(false);
          this.plugin.paintAll();
        })
      );
  }
}

module.exports = GraphCommunitiesPlugin;
