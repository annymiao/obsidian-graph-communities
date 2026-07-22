# Changelog

## 0.4.5 — 2026-07-22

- Display graph file labels as `parent folder / filename` so repeated names such as README and index remain distinguishable.
- Preserve full file paths as graph node IDs, keeping click, hover, links, clustering, and note navigation unchanged.
- Apply the same qualified name to selected-node and representative-note text in the legend.
- Restore Obsidian's original label method and text when the option is disabled or the plugin unloads.
- Limit GitHub release assets to the three installable plugin files and add an automated privacy/security release audit.
- Remove the local RAG-index generator from the public plugin package.

## 0.4.4 — 2026-07-22

- Keep every node selected from the left legend at its original semantic color and full opacity instead of washing it toward white.
- Keep internal links in the selected category at their original blended color and 98% opacity.
- Further fade unrelated nodes and links so the selected category is immediately visible.
- Leave node size, coordinates, graph forces, and layout unchanged during selection.

## 0.4.3 — 2026-07-22

- Make left-legend category and parent selection use the same strong visual tier as direct graph-node selection.
- Brighten every node in the selected category by 58% toward white and raise internal links to 95% opacity.
- Dim unrelated category nodes to 28% opacity and unrelated links to 2.5% while retaining their semantic hues.
- Add an extra high-contrast legend treatment for explicit category selection.

## 0.4.2 — 2026-07-22

- Make the selected graph node substantially brighter and dim unrelated nodes by opacity without removing their hues.
- Strengthen the selected community and its internal links; emphasize links touching the exact selected node.
- Increase category-click contrast between focused and unrelated communities.
- Add a high-contrast legend selection card, larger active swatch, stronger marker, and clear focused hint.

## 0.4.1 — 2026-07-22

- Increase hue separation between the six global knowledge domains.
- Add stronger lightness and saturation variation between distinct knowledge points while keeping related points inside the same domain band.
- Expand the child-companion palette from red through rose and magenta to purple-red.
- Increase visual separation among the four compact PM categories.

## 0.4.0 — 2026-07-22

- Reclassify visible graph communities strictly by primary knowledge point while retaining project and PM parent navigation.
- Add stable semantic hue bands for six knowledge domains and deterministic colors for all 35 knowledge points.
- Blend each article's secondary knowledge points into its node color before relationship propagation.
- Raise the default visible knowledge communities from 12 to 24 and support up to 36.
- Reserve graph capacity for the child project's language, psychology, education, habit, motor, HCI, safety, governance, hardware, and market knowledge points.
- Keep the child-companion parent red while assigning its child knowledge points fixed red/rose/pink/purple-red shades.

## 0.3.0 — 2026-07-22

- Replace filename/folder-first grouping with multi-label knowledge-point extraction from note bodies, headings, aliases, and tags.
- Add a 35-concept ontology spanning child development, psychology, pedagogy, language, behavior, HCI, safety, AI engineering, governance, product, market, and hardware.
- Attach up to eight scored knowledge points and evidence terms to every graph document.
- Group child-companion project notes by disciplinary knowledge points while preserving the red project parent and related child shades.
- Keep 42 canonical PM Skill/Prompt representatives—one per selected keyword—inside four reduced-weight PM child communities.
- Show a selected node's extracted knowledge points in the graph legend.
- Prevent a few project notes from incorrectly assigning an external knowledge community to the project parent.

## 0.2.0 — 2026-07-21

- Make locally inferred content purpose and topic the primary community boundary.
- Read and cache bounded local body excerpts without network access.
- Consolidate Product Manager material into three reduced-weight skill domains plus PM Prompts.
- Strongly dim duplicate PM packages, references, tests, examples, and output samples while retaining total counts in the legend.
- Align project and resource labels with configurable or inferred content collections without publishing local source material.
- Add a hierarchical red color family for the child-companion work parent and its planning, endpoint, market, legal, and industrial-design subcategories.
- Add parent-category focus so project selection, child selection, and graph-node selection remain synchronized.
- Preserve full-graph color when opening nodes and replace aggressive gray focus with light hue-preserving emphasis.
- Keep reduced-weight PM supporting nodes visibly colored instead of nearly transparent and neutralized.
- Recognize a summary-only PM corpus as a `PM 资料总结` parent with four searchable, blue-family child communities outside unrelated project parents.
- Treat Desktop, Shared Knowledge, Resources, and other storage folders as locations rather than categories.
- Add academic/project context plus multi-topic labels from body content and metadata.
- Keep folder identity as a low-weight fallback when content signals are insufficient.
- Add configurable priority keywords such as AI, LLM, ASR, RAG, or project names.
- Downweight README, index, navigation, resource, and other structural notes.
- Use human-readable topic/project labels in the legend instead of hub filenames.
- Prefer informative representative notes over high-degree navigation files.
- Preserve relationship-aware color blending across related projects and topics.
- Synchronize native graph node hover/click states with the legend and add clickable category focus for nodes and internal links.

## 0.1.0 — 2026-07-21

- Detect note communities from Obsidian's resolved link graph with a deterministic Louvain implementation.
- Assign a distinct color to the strongest hub in each major community.
- Propagate and blend colors across neighboring notes so strongly related notes look similar.
- Blend boundary nodes and graph edges across communities.
- Add configurable resolution, community limits, minimum cluster size, propagation, neutral color, and legend.
- Add deterministic unit tests and a read-only vault smoke-test script.
