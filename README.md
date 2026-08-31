# Graph Communities

[简体中文](README.zh-CN.md)

Graph Communities turns Obsidian's gray graph into a content-aware knowledge map.
It assigns every effective note one primary theme and one primary subtopic, then colors the node only with that
subtopic's stable color. Secondary topics remain available as relationship, search, and hover context, but never
blend the node color or enter theme percentages. Structural notes are removed from the visible graph, and each
remaining link is drawn from its source color to its target color.

## What it does

- Reads each local Markdown note in full to infer academic, project, reference, and prompt/skill context.
- Reads `.codex/graph/topic-manifest.json` for the portable taxonomy and explicit theme/subtopic palette, with a built-in offline fallback.
- Extracts a multi-label knowledge profile from each article instead of using its filename as the index.
- Uses exactly one primary subtopic color per effective file; secondary topics do not alter the node color or percentage denominator.
- Ships with a neutral fallback taxonomy spanning research and learning, psychology, language and communication, interaction design, AI and computing, governance, product, market, and hardware concepts.
- Infers themes such as language models, AI systems, agents, speech, compliance, hardware, market research, and product strategy.
- Treats generic storage folders such as Inbox, Library, and Resources as locations—not categories.
- Consolidates Product Manager material into four compact groups: PM Strategy & Discovery, PM Execution & Growth, PM Data & Tools, and PM Prompts.
- Keeps primary packaged `SKILL.md` definitions prominent while de-emphasizing duplicate package copies and supporting material without removing their category color; the legend still reports primary and total counts.
- Keeps one canonical PM Skill or Prompt/Workflow representative per keyword under four reduced-weight PM child communities while excluding duplicate repositories and supporting artifacts.
- Classifies other articles by knowledge extracted from their bodies; collection folder names are fallback evidence only.
- Uses seven high-distinction parent colors for AI and computing, automation and tools, research and learning, data and governance, hardware and robotics, product and business, and design and experience.
- Uses content, tags, aliases, headings, links, and low-weight path hints as grouping signals.
- Supports priority keywords such as `AI`, `LLM`, `ASR`, or your own project names.
- Excludes README-like, AGENTS/system, macOS `._*` AppleDouble, generated, empty, link-only navigation, frontmatter-excluded, and exact-duplicate Markdown files from analysis, counts, visible nodes, and incident links.
- Selects an informative note—not a navigation file—as the community representative.
- Assigns a distinct, dark-theme-friendly color to every major hub.
- Uses links and secondary topics as relationship signals without changing a note's primary color.
- Draws a true source-to-target gradient for different endpoint colors, a solid line for equal colors, and a midpoint-color compatibility fallback when the renderer cannot create textures.
- Works in both global and local graph views.
- Shows every active theme and subtopic in an optional legend, with effective-file counts and percentages and a natural-break “main” suggestion that does not cap the number of themes.
- Displays file nodes as `parent folder / filename` by default, for example `Projects / Plan`, so repeated filenames remain distinguishable.
- Keeps graph selection and legend focus in sync: opening a node highlights its category, while clicking a left-legend category keeps all matching right-side nodes at their original semantic color and full opacity and strengthens their internal links.
- Adds hierarchical legend focus: clicking a theme parent highlights every child category, while opening a note activates both its parent and exact subcategory.
- Opening a graph node strongly brightens the exact node, its category, and incident links while lowering unrelated opacity without removing their hues; explicit category clicks apply a stronger community focus.
- Runs locally and never changes note content.

## Visual model

```text
Orange topic node ─ orange→blue endpoint gradient ─ blue topic node
```

Node size remains controlled by Obsidian. Graph Communities changes color only:

- **Parent swatch** is the theme's high-chroma base color and is reserved for the legend.
- **Node color** is the note's one primary subtopic color.
- **Related child shades** distinguish subtopics inside a theme without collapsing them into the parent color.
- **Gradient direction** follows the native link's source endpoint to its target endpoint.
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
| Maximum communities | 24 | Limits only the relationship-clustering fallback; it does not cap semantic themes or legend rows |
| Minimum community size | 2 | Keeps tiny fragments neutral or merges them |
| Topic-aware clustering | On | Combines local body context, topics, metadata, and links |
| Priority topic keywords | Empty | Optional user-defined terms that influence grouping and labels |
| Content category cohesion | 5.0 | Keeps notes with the same inferred purpose/topic together |
| Topic similarity influence | 1.4 | Connects notes sharing inferred tags and local metadata |
| Clustering resolution | 1.0 | Lower = fewer broad groups; higher = more groups |
| Relationship blending | 0.52 | Controls only the legacy relationship-color fallback, not classified semantic nodes |
| Blending distance | 4 | Link-hop distance used only by the legacy relationship-color fallback |
| Soften peripheral notes | 0.18 | Makes major hubs easier to distinguish |
| Show parent folder in graph labels | On | Displays file nodes as `parent folder / filename` without changing the real file path |

Use the command palette action **Graph Communities: Recompute graph communities**
after large linking changes. The plugin also recomputes automatically when the
metadata cache resolves or Markdown files change.

## How the algorithm works

1. Read each Markdown note in full through Obsidian's local vault API and cache the result by file revision.
2. Infer usage context (academic, project, or reference) and multiple topic tags from body content and metadata.
3. Score a maintained knowledge ontology against the body, headings, aliases, and tags; keep up to eight knowledge points per article with evidence terms.
4. Consolidate Product Manager content under four PM communities and keep only one canonical representative per keyword at reduced graph weight.
5. Treat generic storage folders and filenames as fallback hints, not primary categories.
6. Combine knowledge-point overlap, semantic similarity, and links among effective notes while preserving project and academic diversity.
7. Remove structural and duplicate notes from the effective set before building relationships or percentages.
8. Resolve frontmatter overrides first, then select exactly one primary theme and subtopic for every classified note.
9. Paint each node with the explicit primary subtopic color; keep secondary topics only as relationship and search metadata.
10. Draw native links as endpoint gradients where renderer textures are supported, otherwise use a safe midpoint-color fallback.

The model is fully local and rule-based. It reads complete Markdown notes but does not call a cloud embedding service or send vault data over the network.

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
