# Changelog

## 0.1.0 — 2026-07-21

- Detect note communities from Obsidian's resolved link graph with a deterministic Louvain implementation.
- Assign a distinct color to the strongest hub in each major community.
- Propagate and blend colors across neighboring notes so strongly related notes look similar.
- Blend boundary nodes and graph edges across communities.
- Add configurable resolution, community limits, minimum cluster size, propagation, neutral color, and legend.
- Add deterministic unit tests and a read-only vault smoke-test script.
