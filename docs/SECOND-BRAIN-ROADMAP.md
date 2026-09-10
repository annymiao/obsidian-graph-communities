# Second-brain roadmap

The long-term goal is a user-owned knowledge layer that can serve different AI models without making any model's private conversation history the source of truth.

The design deliberately does **not** copy human forgetting as a storage rule. Human memory is useful as an attention metaphor, but AI has a different advantage: it can retain more evidence and revisit it cheaply. Therefore:

- keep original material unless the user explicitly deletes it;
- reduce retrieval probability, not existence;
- preserve provenance and time so old evidence can be re-evaluated;
- let importance, recency, task relevance, confidence, and user confirmation affect recall;
- make summaries and associations reversible derived views, never replacements for source evidence.

## Ordered delivery

### Phase 1 — bounded, accurate retrieval

Status: implemented in version 0.6.0.

- Isolate stable core, active project, reference, history, control, and generated corpora.
- Default to core; require an explicit request for one broader corpus.
- Chunk long Markdown by structure and rank it with lexical evidence.
- Let the graph rerank evidence but never invent a result.
- Deduplicate exact bodies, abstain when evidence is missing, and enforce a complete context token budget.
- Keep every result traceable to a source span.

### Phase 2 — distributed source organization

Status: planned, not implemented.

- Add read-only source adapters and a catalog for material stored outside one Vault.
- Use stable source IDs, content hashes, locations, access policy, and last-seen state.
- Keep source files where they are; store only portable metadata and rebuildable derived views.
- Require human confirmation for ambiguous identity merges, ownership, access changes, moves, and deletion.

### Phase 3 — cross-model memory

Status: long-term goal, not implemented.

- Define a model-neutral memory exchange format for claims, decisions, preferences, events, open loops, and evidence links.
- Separate observed evidence, model inference, and user-confirmed facts.
- Attach scope, sensitivity, confidence, time, provenance, and supersession to every durable memory.
- Allow any model to read the same approved evidence pack without inheriting another model's hidden state.
- Use human review for durable personal facts, high-impact merges, sharing, and forgetting decisions.

The target architecture is not “a database that remembers everything equally.” It is a retained evidence base plus an adaptive attention system: broad storage, selective retrieval, explicit uncertainty, and user-governed durable memory.
