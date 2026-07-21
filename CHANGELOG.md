# Changelog

## 0.2.0 — 2026-07-21

- Make locally inferred content purpose and topic the primary community boundary.
- Read and cache bounded local body excerpts without network access.
- Consolidate Product Manager material into reduced-weight PM Skills and PM Prompts communities.
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
