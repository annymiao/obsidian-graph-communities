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
  maxCommunities: 12,
  minCommunitySize: 3,
  topicAware: true,
  priorityKeywords: 'AI, LLM, ASR, RAG, Agent',
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
  showLegend: true,
};

class GraphCommunitiesPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.analysis = null;
    this.focusedCommunity = null;
    this.focusedCommunityLabel = null;
    this.focusedNodeId = null;
    this.focusSource = null;
    this.hoveredCommunity = null;
    this.hoveredNodeId = null;
    this.rendererHooks = new Map();
    this.documentContentCache = new Map();
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
    const linkGraph = core.graphFromResolvedLinks(
      this.app.metadataCache.resolvedLinks || {},
      files.map((file) => file.path)
    );
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
        };
      }));
      documents.push(...batch);
    }
    return core.buildHybridGraph(linkGraph, documents, {
      priorityKeywords: this.settings.priorityKeywords,
      linkWeight: this.settings.topicAware ? this.settings.linkWeight : 1,
      projectWeight: this.settings.topicAware ? this.settings.projectWeight : 0,
      semanticWeight: this.settings.topicAware ? this.settings.semanticWeight : 0,
      navigationLinkPenalty: this.settings.topicAware
        ? this.settings.navigationLinkPenalty
        : 1,
      projectMaxSize: this.settings.projectMaxSize,
    });
  }

  async readDocumentContent(file) {
    if (!file || !file.path || typeof this.app.vault.cachedRead !== 'function') return '';
    const revision = `${file.stat?.mtime ?? 0}:${file.stat?.size ?? 0}`;
    const cached = this.documentContentCache.get(file.path);
    if (cached && cached.revision === revision) return cached.content;
    try {
      const source = await this.app.vault.cachedRead(file);
      const content = String(source || '').slice(0, 24000);
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
    this.analysis = core.analyzeGraph(model.graph, {
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
    });
    this.hoveredCommunity = null;
    this.hoveredNodeId = null;
    this.restoreFocusAfterRecompute();
    this.updateStatusBar();
    this.paintAll();
  }

  restoreFocusAfterRecompute() {
    if (!this.analysis) return;
    if (this.focusSource === 'node' && this.focusedNodeId) {
      const community = this.analysis.assignments.get(this.focusedNodeId);
      if (community != null && community >= 0) {
        this.focusedCommunity = community;
        this.focusedCommunityLabel = this.clusterLabel(community);
        return;
      }
    }
    if (this.focusSource === 'community' && this.focusedCommunityLabel) {
      const cluster = this.analysis.clusters.find(
        (candidate) => candidate.label === this.focusedCommunityLabel
      );
      if (cluster) {
        this.focusedCommunity = cluster.id;
        return;
      }
    }
    this.clearFocus(false);
  }

  clusterLabel(community) {
    const cluster = this.analysis && this.analysis.clusters.find(
      (candidate) => candidate.id === community
    );
    return cluster ? cluster.label : null;
  }

  focusFromFile(file) {
    if (!this.analysis || !file || !file.path) return;
    const community = this.analysis.assignments.get(file.path);
    if (community == null || community < 0) {
      if (this.focusSource === 'node') this.clearFocus();
      return;
    }
    this.focusedCommunity = community;
    this.focusedCommunityLabel = this.clusterLabel(community);
    this.focusedNodeId = file.path;
    this.focusSource = 'node';
    this.updateStatusBar();
    this.paintAll(true);
  }

  previewFromGraphNode(id) {
    if (!this.analysis || typeof id !== 'string') return;
    const community = this.analysis.assignments.get(id);
    if (community == null || community < 0) {
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
    this.focusedNodeId = null;
    this.focusSource = 'community';
    this.updateStatusBar();
    this.paintAll(true);
  }

  clearFocus(repaint = true) {
    this.clearGraphNodePreview(false);
    this.focusedCommunity = null;
    this.focusedCommunityLabel = null;
    this.focusedNodeId = null;
    this.focusSource = null;
    this.updateStatusBar();
    if (repaint) this.paintAll(true);
  }

  updateStatusBar() {
    if (!this.statusBar || !this.analysis) return;
    const activeCommunity = this.activeLegendCommunity();
    if (activeCommunity != null) {
      const cluster = this.analysis.clusters.find(
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
      `Graph Communities: ${this.analysis.clusters.length} clusters · ${this.analysis.nodeCount} notes`
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
      const rgb = this.analysis.colors.get(node.id);
      if (rgb == null) continue;
      const community = this.analysis.assignments.get(node.id);
      const isFocusedCommunity =
        this.focusedCommunity != null && community === this.focusedCommunity;
      let displayRgb = rgb;
      let alpha = 1;
      if (this.focusedCommunity != null) {
        if (isFocusedCommunity) {
          displayRgb = core.mixRgb(rgb, 0xffffff, node.id === this.focusedNodeId ? 0.34 : 0.1);
        } else {
          const neutral = core.hexToRgbInt(this.settings.neutralColor);
          displayRgb = core.mixRgb(rgb, neutral, 0.72);
          alpha = 0.16;
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
        if (!this.settings.colorEdges) {
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
        const sourceId = nodeId(link.source);
        const targetId = nodeId(link.target);
        const sourceColor = this.analysis.colors.get(sourceId);
        const targetColor = this.analysis.colors.get(targetId);
        if (sourceColor == null || targetColor == null || !link.line) continue;
        const tint = core.blendRgbInts([sourceColor, targetColor], [1, 1]);
        const sourceCommunity = this.analysis.assignments.get(sourceId);
        const targetCommunity = this.analysis.assignments.get(targetId);
        const sameCommunity =
          sourceCommunity != null &&
          sourceCommunity >= 0 &&
          sourceCommunity === targetCommunity;
        let alpha = sameCommunity
          ? this.settings.sameCommunityEdgeOpacity
          : this.settings.crossCommunityEdgeOpacity;
        let displayTint = tint;
        if (this.focusedCommunity != null) {
          const sourceFocused = sourceCommunity === this.focusedCommunity;
          const targetFocused = targetCommunity === this.focusedCommunity;
          if (sourceFocused && targetFocused) {
            alpha = Math.max(alpha, 0.68);
            displayTint = core.mixRgb(tint, 0xffffff, 0.08);
          } else if (sourceFocused || targetFocused) {
            alpha = 0.18;
          } else {
            alpha = 0.025;
            displayTint = core.mixRgb(
              tint,
              core.hexToRgbInt(this.settings.neutralColor),
              0.75
            );
          }
        }
        if (link.line.tint !== displayTint) {
          link.line.tint = displayTint;
          changed = true;
        }
        if (link.line.alpha !== alpha) {
          link.line.alpha = alpha;
          changed = true;
        }
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
    let legend = container.querySelector('.graph-communities-legend');
    if (!this.settings.showLegend || !this.settings.enabled || !this.analysis) {
      if (legend) legend.remove();
      return;
    }
    if (!legend) {
      legend = document.createElement('div');
      legend.className = 'graph-communities-legend';
      container.appendChild(legend);
    }
    legend.replaceChildren();
    const title = document.createElement('div');
    title.className = 'graph-communities-legend-title';
    title.textContent = 'Topic communities';
    legend.appendChild(title);
    const hint = document.createElement('div');
    hint.className = 'graph-communities-legend-hint';
    const activeCommunity = this.activeLegendCommunity();
    const activeLabel = this.clusterLabel(activeCommunity);
    if (this.hoveredNodeId) {
      hint.textContent = `Node: ${displayName(this.hoveredNodeId)} · Category: ${activeLabel}`;
    } else if (this.focusedNodeId) {
      hint.textContent = `Selected: ${displayName(this.focusedNodeId)} · Category: ${activeLabel}`;
    } else if (activeLabel) {
      hint.textContent = `Focused category: ${activeLabel}`;
    } else {
      hint.textContent = 'Click a category to focus · click again to clear';
    }
    legend.appendChild(hint);
    for (const cluster of this.analysis.clusters) {
      const row = document.createElement('div');
      const isActive = cluster.id === activeCommunity;
      row.className = `graph-communities-legend-row${isActive ? ' is-active' : ''}`;
      row.setAttribute && row.setAttribute('role', 'button');
      row.setAttribute && row.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      row.tabIndex = 0;
      const swatch = document.createElement('span');
      swatch.className = 'graph-communities-swatch';
      swatch.style.backgroundColor = cluster.colorHex;
      const label = document.createElement('span');
      label.className = 'graph-communities-label';
      label.textContent = `${cluster.label} (${cluster.size})`;
      label.title = [
        `Representative: ${displayName(cluster.hub)}`,
        cluster.keywords.length ? `Keywords: ${cluster.keywords.join(', ')}` : '',
      ].filter(Boolean).join(' · ');
      row.append(swatch, label);
      if (isActive) {
        const marker = document.createElement('span');
        marker.className = 'graph-communities-selection-marker';
        marker.textContent = this.hoveredCommunity != null ? 'NODE' : 'SELECTED';
        row.appendChild(marker);
      }
      const activate = (event) => {
        if (event && event.stopPropagation) event.stopPropagation();
        this.toggleCommunityFocus(cluster);
      };
      if (typeof row.addEventListener === 'function') {
        row.addEventListener('click', activate);
        row.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate(event);
          }
        });
      }
      legend.appendChild(row);
    }
  }

  restoreAll() {
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
      .setName('Maximum communities')
      .setDesc('Limits the number of distinct major colors. Smaller communities merge into their strongest neighbor.')
      .addSlider((slider) =>
        slider
          .setLimits(2, 18, 1)
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
      .setDesc('Infer academic/project context and topics from bounded local note content, then combine them with metadata and links.')
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
      .setDesc('How strongly neighboring communities influence a node color. Higher values create smoother transitions.')
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
      .setDesc('Number of graph hops used to spread community colors.')
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
      .setDesc('Blend each edge from the colors of its endpoint nodes.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.colorEdges).onChange(async (value) => {
          this.plugin.settings.colorEdges = value;
          await this.plugin.saveSettings(false);
          this.plugin.paintAll();
        })
      );

    new Setting(containerEl)
      .setName('Show community legend')
      .setDesc('Display each community color, hub note, and node count inside the graph view.')
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
