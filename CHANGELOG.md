# Changelog

## 0.2.0 — 2026-07-21

- Make project/folder identity the primary community boundary.
- Add local keyword similarity from titles, paths, tags, aliases, and headings.
- Add configurable priority keywords such as AI, LLM, ASR, RAG, or project names.
- Downweight README, index, navigation, resource, and other structural notes.
- Use human-readable topic/project labels in the legend instead of hub filenames.
- Prefer informative representative notes over high-degree navigation files.
- Preserve relationship-aware color blending across related projects and topics.

## 0.1.0 — 2026-07-21

- Detect note communities from Obsidian's resolved link graph with a deterministic Louvain implementation.
- Assign a distinct color to the strongest hub in each major community.
- Propagate and blend colors across neighboring notes so strongly related notes look similar.
- Blend boundary nodes and graph edges across communities.
- Add configurable resolution, community limits, minimum cluster size, propagation, neutral color, and legend.
- Add deterministic unit tests and a read-only vault smoke-test script.
