# Graph Communities

[简体中文](README.zh-CN.md)

Graph Communities turns Obsidian's gray graph into a topic-aware knowledge map.
It groups notes primarily by project/folder and strengthens those groups with
local keyword and metadata similarity. Each major topic gets a distinct color;
related topics and bridge notes receive visually related blended colors.

## What it does

- Detects projects automatically from the vault's folder structure.
- Uses titles, paths, tags, aliases, headings, and links as local grouping signals.
- Supports priority keywords such as `AI`, `LLM`, `ASR`, or your own project names.
- Downweights generic navigation notes such as README, index, overview, and resources.
- Selects an informative note—not a navigation file—as the community representative.
- Assigns a distinct, dark-theme-friendly color to every major hub.
- Propagates community affinity through nearby links.
- Blends colors for bridge notes that connect multiple communities.
- Colors links from their endpoint colors and dims cross-community links.
- Works in both global and local graph views.
- Shows an optional legend with human-readable topic/project names and community sizes.
- Keeps graph selection and legend focus in sync: opening a node highlights its category, while clicking a category highlights all of its nodes and internal links.
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

## Interactive focus

- Click a graph node to open it. Its category becomes selected in the legend and the node is emphasized.
- Click a legend category to focus every node in that category and its internal links; unrelated nodes and links are dimmed.
- Click the active category again, or run **Graph Communities: Clear graph community focus**, to restore the complete graph.
- The currently selected note is shown above the legend categories.

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
| Maximum communities | 12 | Limits the number of major topic/project colors |
| Minimum community size | 3 | Keeps tiny fragments neutral or merges them |
| Topic-aware clustering | On | Combines projects, keywords, metadata, and links |
| Priority topic keywords | AI, LLM, ASR, RAG, Agent | Terms that influence grouping and labels |
| Project/folder influence | 5.0 | Keeps notes in the same detected project together |
| Keyword similarity influence | 1.4 | Connects notes with similar local metadata |
| Clustering resolution | 1.0 | Lower = fewer broad groups; higher = more groups |
| Relationship blending | 0.52 | Higher = stronger color mixing across links |
| Blending distance | 4 | Number of link hops used for color propagation |
| Soften peripheral notes | 0.18 | Makes major hubs easier to distinguish |

Use the command palette action **Graph Communities: Recompute graph communities**
after large linking changes. The plugin also recomputes automatically when the
metadata cache resolves or Markdown files change.

## How the algorithm works

1. Detect project boundaries from meaningful folder names. Structural folders
   such as `docs`, `src`, `references`, and `archive` are skipped when possible.
2. Build local keyword vectors from filenames, paths, tags, aliases, and headings.
3. Combine project edges and keyword similarity with downweighted internal links.
4. Assign one base community per major project; the deterministic Louvain model
   remains available when project-first grouping is disabled in code.
5. Pick an informative representative while heavily penalizing README/index notes.
6. Diffuse community-affinity vectors through neighboring notes for a configured
   number of graph hops.
7. Mix the community palette in linear RGB space from each node's affinity
   vector. This produces smooth, relationship-aware transition colors.

The model is local and metadata-based. It does not read body paragraphs, call a
cloud embedding service, or send vault data over the network.

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
