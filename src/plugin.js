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
  maxCommunities: 9,
  minCommunitySize: 3,
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
    this.registerEvent(this.app.workspace.on('active-leaf-change', this.schedulePaint));

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

  buildGraph() {
    const files = this.app.vault.getMarkdownFiles();
    const graph = core.graphFromResolvedLinks(
      this.app.metadataCache.resolvedLinks || {},
      files.map((file) => file.path)
    );
    return graph;
  }

  async recompute() {
    if (!this.settings.enabled) {
      this.restoreAll();
      return;
    }
    const graph = this.buildGraph();
    this.analysis = core.analyzeGraph(graph, {
      resolution: this.settings.resolution,
      maxCommunities: this.settings.maxCommunities,
      minCommunitySize: this.settings.minCommunitySize,
      propagationSteps: this.settings.propagationSteps,
      propagationStrength: this.settings.propagationStrength,
      hubAnchor: this.settings.hubAnchor,
      peripheralFade: this.settings.peripheralFade,
      neutralColor: this.settings.neutralColor,
    });
    this.statusBar.setText(
      `Graph Communities: ${this.analysis.clusters.length} clusters · ${this.analysis.nodeCount} notes`
    );
    this.paintAll();
  }

  graphLeaves() {
    return [
      ...this.app.workspace.getLeavesOfType('graph'),
      ...this.app.workspace.getLeavesOfType('localgraph'),
    ];
  }

  paintAll(forceChanged = true) {
    if (!this.settings.enabled || !this.analysis) return;
    for (const leaf of this.graphLeaves()) this.paintLeaf(leaf, forceChanged);
  }

  paintLeaf(leaf, forceChanged = true) {
    const view = leaf && leaf.view;
    const renderer = view && view.renderer;
    if (!renderer || !Array.isArray(renderer.nodes)) return;
    let changed = false;

    for (const node of renderer.nodes) {
      const rgb = this.analysis.colors.get(node.id);
      if (rgb == null) continue;
      if (!node.color || node.color.rgb !== rgb || node.color.a !== 1) {
        node.color = { a: 1, rgb };
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
        const alpha = sameCommunity
          ? this.settings.sameCommunityEdgeOpacity
          : this.settings.crossCommunityEdgeOpacity;
        if (link.line.tint !== tint) {
          link.line.tint = tint;
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
    title.textContent = 'Graph communities';
    legend.appendChild(title);
    for (const cluster of this.analysis.clusters) {
      const row = document.createElement('div');
      row.className = 'graph-communities-legend-row';
      const swatch = document.createElement('span');
      swatch.className = 'graph-communities-swatch';
      swatch.style.backgroundColor = cluster.colorHex;
      const label = document.createElement('span');
      label.className = 'graph-communities-label';
      label.textContent = `${displayName(cluster.hub)} (${cluster.size})`;
      row.append(swatch, label);
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
      text: 'Automatically detect link communities. Major hubs receive distinct colors; nearby and boundary notes inherit or blend those colors.',
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
