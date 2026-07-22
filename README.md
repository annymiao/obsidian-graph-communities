# Graph Communities

[简体中文](README.zh-CN.md)

Graph Communities turns Obsidian's gray graph into a content-aware knowledge map.
It extracts multiple knowledge points from every local note, chooses a primary concept for graph grouping,
and uses the remaining concepts, metadata, and links as relationship signals. Each primary knowledge point gets a stable color;
points in the same domain occupy adjacent hues, while secondary concepts and links tint related notes toward one another.

## What it does

- Reads a bounded local excerpt of each note to infer academic, project, reference, and prompt/skill context.
- Extracts a multi-label knowledge profile from each article instead of using its filename as the index.
- Covers child development, psychology, pedagogy, language, habits, motor development, HCI, safety, AI engineering, governance, product, market, and hardware concepts.
- Infers themes such as language models, AI systems, agents, speech, compliance, hardware, market research, and product strategy.
- Treats generic storage folders such as Desktop, Shared Knowledge, and Resources as locations—not categories.
- Consolidates Product Manager material into four compact groups: PM Strategy & Discovery, PM Execution & Growth, PM Data & Tools, and PM Prompts.
- Keeps primary packaged `SKILL.md` definitions prominent while de-emphasizing duplicate package copies and supporting material without removing their category color; the legend still reports primary and total counts.
- Keeps one canonical PM Skill or Prompt/Workflow representative per keyword under four reduced-weight PM child communities while excluding duplicate repositories and supporting artifacts.
- Classifies other articles by knowledge extracted from their bodies; Desktop collection names are fallback evidence only.
- Groups child-companion work under a red `儿童陪伴机器人（工作）` parent and assigns fixed red/rose/pink/purple-red shades to its language, psychology, habit, motor, HCI, safety, governance, and hardware knowledge points.
- Uses high-contrast domain bands: coral/orange for child development and education, bright yellow/amber for product and business, green for hardware and embodiment, blue/cyan for AI and engineering, violet for governance and evidence, and rose/magenta for interaction and safety. Both hue and lightness separate unrelated domains.
- Uses content, tags, aliases, headings, links, and low-weight path hints as grouping signals.
- Supports priority keywords such as `AI`, `LLM`, `ASR`, or your own project names.
- Downweights generic navigation notes such as README, index, overview, and resources.
- Selects an informative note—not a navigation file—as the community representative.
- Assigns a distinct, dark-theme-friendly color to every major hub.
- Propagates community affinity through nearby links.
- Blends colors for bridge notes that connect multiple communities.
- Colors links from their endpoint colors and dims cross-community links.
- Works in both global and local graph views.
- Shows an optional legend with human-readable topic/project names and community sizes.
- Displays file nodes as `parent folder / filename` by default, for example `Projects / README`, so repeated README and index names remain distinguishable.
- Keeps graph selection and legend focus in sync: opening a node highlights its category, while clicking a left-legend category keeps all matching right-side nodes at their original semantic color and full opacity and strengthens their internal links.
- Adds hierarchical legend focus: clicking a project parent highlights every child category, while opening a note activates both its parent and exact subcategory.
- Opening a graph node strongly brightens the exact node, its category, and incident links while lowering unrelated opacity without removing their hues; explicit category clicks apply a stronger community focus.
- Runs locally and never changes note content.

## Visual model

```text
Blue hub ─ blue notes ─ blue/purple bridge ─ purple notes ─ purple hub
```

Node size remains controlled by Obsidian. Graph Communities changes color only:

- **Hue** represents community membership.
- **Domain band** keeps unrelated knowledge types visibly separate while related points use distinct nearby shades.
- **Color similarity** represents similarity in graph relationships.
- **Mixed color** represents a boundary or bridge between communities.
- **Soft neutral color** represents isolated or unclassified notes.

## Interactive focus

- Hover a graph node to preview its category immediately in the legend; click the node to open it and keep that category selected.
- Click a legend category to keep every matching node at its original semantic color and full opacity and strengthen its original-color internal links; unrelated nodes and links are substantially dimmed. Selection does not change node size, coordinates, forces, or layout.
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
| Maximum communities | 24 | Limits visible primary knowledge points; configurable up to 36 |
| Minimum community size | 2 | Keeps tiny fragments neutral or merges them |
| Topic-aware clustering | On | Combines local body context, topics, metadata, and links |
| Priority topic keywords | Child development, pedagogy, psychology, language, habits, motor development, AI, LLM, ASR, RAG, Agent | Terms that influence grouping and labels |
| Content category cohesion | 5.0 | Keeps notes with the same inferred purpose/topic together |
| Topic similarity influence | 1.4 | Connects notes sharing inferred tags and local metadata |
| Clustering resolution | 1.0 | Lower = fewer broad groups; higher = more groups |
| Relationship blending | 0.52 | Higher = stronger color mixing across links |
| Blending distance | 4 | Number of link hops used for color propagation |
| Soften peripheral notes | 0.18 | Makes major hubs easier to distinguish |
| Show parent folder in graph labels | On | Displays file nodes as `parent folder / filename` without changing the real file path |

Use the command palette action **Graph Communities: Recompute graph communities**
after large linking changes. The plugin also recomputes automatically when the
metadata cache resolves or Markdown files change.

## How the algorithm works

1. Read at most the first 24,000 characters of each Markdown note through Obsidian's local vault API and cache the result by file revision.
2. Infer usage context (academic, project, or reference) and multiple topic tags from body content and metadata.
3. Score a maintained knowledge ontology against the body, headings, aliases, and tags; keep up to eight knowledge points per article with evidence terms.
4. Consolidate Product Manager content under four PM communities and keep only one canonical representative per keyword at reduced graph weight.
5. Treat generic storage folders and filenames as fallback hints, not primary categories.
6. Combine knowledge-point overlap, semantic similarity, and downweighted navigation links while preserving project and academic diversity.
7. Pick an informative representative while heavily penalizing README/index notes.
8. Assign a stable hue band to every knowledge domain and a stable position in that band to every primary knowledge point.
9. Tint the primary color with secondary knowledge points, then diffuse community-affinity vectors through neighboring notes for a configured number of graph hops.
10. Mix the knowledge and relationship colors in linear RGB space. This produces smooth, relationship-aware transition colors.

The model is fully local and rule-based. It reads bounded note excerpts but does not call a cloud embedding service or send vault data over the network.

## Privacy and safety

- All computation happens inside Obsidian.
- No network requests, analytics, API keys, or external services.
- No note creation, modification, movement, or deletion.
- Settings are stored using Obsidian's standard plugin data mechanism.
- Disabling or unloading the plugin restores the theme's normal node colors.
- GitHub releases contain only `main.js`, `manifest.json`, and `styles.css`; no vault notes, generated indexes, local paths, or plugin settings are packaged.
- See [SECURITY.md](SECURITY.md) for the release boundary and vulnerability reporting process.

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
- `scripts/audit-release.mjs` — verifies the release allowlist, versions, local-path boundary, and network-free runtime.
- `tests/graph-core.test.js` — deterministic algorithm tests.

## License

MIT
