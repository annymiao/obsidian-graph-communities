# Graph Communities

[简体中文](README.zh-CN.md)

Graph Communities turns Obsidian's gray graph into a structural knowledge map.
It automatically detects densely linked note communities, gives each major hub a
distinct color, and blends those colors through the link network. Notes with
similar relationships therefore look similar, while boundary notes visibly mix
the colors of the communities they connect.

## What it does

- Detects communities from Obsidian's resolved internal links.
- Selects the highest-degree note as the visible hub of each community.
- Assigns a distinct, dark-theme-friendly color to every major hub.
- Propagates community affinity through nearby links.
- Blends colors for bridge notes that connect multiple communities.
- Colors links from their endpoint colors and dims cross-community links.
- Works in both global and local graph views.
- Shows an optional legend with each hub and community size.
- Runs locally and never changes note content.

## Visual model

```text
Blue hub ─ blue notes ─ blue/purple bridge ─ purple notes ─ purple hub
```

Node size remains controlled by Obsidian. Graph Communities changes color only:

- **Hue** represents community membership.
- **Color similarity** represents similarity in graph relationships.
- **Mixed color** represents a boundary or bridge between communities.
- **Soft neutral color** represents isolated or unclassified notes.

## Installation

### Manual release installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create `<vault>/.obsidian/plugins/graph-communities/`.
3. Copy the three files into that directory.
4. Restart Obsidian.
5. Open **Settings → Community plugins** and enable **Graph Communities**.

### Development installation

This project has no runtime or build dependencies beyond Node.js:

```bash
npm run verify
node scripts/install-local.mjs /path/to/vault --enable
```

Restart or reload Obsidian after installing a new build.

## Recommended starting settings

| Setting | Default | Effect |
| --- | ---: | --- |
| Maximum communities | 9 | Limits the number of major hub colors |
| Minimum community size | 3 | Keeps tiny fragments neutral or merges them |
| Clustering resolution | 1.0 | Lower = fewer broad groups; higher = more groups |
| Relationship blending | 0.52 | Higher = stronger color mixing across links |
| Blending distance | 4 | Number of link hops used for color propagation |
| Soften peripheral notes | 0.18 | Makes major hubs easier to distinguish |

Use the command palette action **Graph Communities: Recompute graph communities**
after large linking changes. The plugin also recomputes automatically when the
metadata cache resolves or Markdown files change.

## How the algorithm works

1. Build a weighted, undirected graph from Obsidian's resolved links. Multiple
   links between the same notes increase their edge weight.
2. Run a deterministic, dependency-free Louvain pass to maximize modularity.
3. Keep the largest communities and merge small linked fragments into their
   strongest neighboring community.
4. Pick the highest weighted-degree note as each community's hub.
5. Diffuse community-affinity vectors through neighboring notes for a configured
   number of graph hops.
6. Mix the community palette in linear RGB space from each node's affinity
   vector. This produces smooth, relationship-aware transition colors.

The model is structural: it uses links, not note text or cloud embeddings.

## Privacy and safety

- All computation happens inside Obsidian.
- No network requests, analytics, API keys, or external services.
- No note creation, modification, movement, or deletion.
- Settings are stored using Obsidian's standard plugin data mechanism.
- Disabling or unloading the plugin restores the theme's normal node colors.

## Compatibility note

Obsidian does not currently expose node coloring through its public plugin API.
Like other graph-coloring plugins, Graph Communities uses the graph renderer's
internal node and link objects. A future Obsidian update may temporarily require
a compatibility update. The plugin fails visually in that situation; it does not
alter vault data.

## Development

```bash
# Generate main.js from the source files
npm run build

# Syntax checks and deterministic unit tests
npm run verify

# Read-only smoke test against a vault
node scripts/vault-smoke.mjs /path/to/vault
```

Source layout:

- `src/graph-core.js` — dependency-free graph, clustering, affinity, and color logic.
- `src/plugin.js` — Obsidian lifecycle, settings, graph renderer, and legend.
- `scripts/build.mjs` — creates the distributable `main.js`.
- `tests/graph-core.test.js` — deterministic algorithm tests.

## License

MIT
