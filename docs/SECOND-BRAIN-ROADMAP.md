# Second-brain roadmap

The long-term goal is a user-owned knowledge layer that can serve different AI models without making any model's private conversation history the source of truth.

The design deliberately does **not** copy human forgetting as a storage rule. Human memory is useful as an attention metaphor, but AI has a different advantage: it can retain more evidence and revisit it cheaply. Therefore:

- keep original material unless the user explicitly deletes it;
- reduce retrieval probability, not existence;
- preserve provenance and time so old evidence can be re-evaluated;
- let importance, recency, task relevance, confidence, and user confirmation affect recall;
- make summaries and associations reversible derived views, never replacements for source evidence.

## Component boundary

This repository contains two independent components:

- **Graph Communities plugin:** local, read-only classification and visualization inside Obsidian. It reads notes to color and focus the graph, does not persist a knowledge index, and never creates, edits, moves, or deletes notes.
- **Optional MCP gateway:** local-first, policy-scoped retrieval that returns small evidence packs to an AI client. Its derived index is rebuildable and sensitive, but the original Markdown remains authoritative.

Version 1.2 does not add memory writeback to either component. It also does not automatically merge identities, decide which conflicting claim is true, or delete/forget source evidence.

## Target five-plane architecture and the v1.2 gap

The production target is a five-plane system. Version 1.2 implements the verified lexical retrieval foundation, not every box in that target. In the tree below, `[done]` means an executable end-to-end path, `[partial]` means the capability exists without the intended separation or reusable contract, and `[planned]` means there is no production implementation yet.

```text
Obsidian second brain
├── Offline compilation plane [partial: still runs inside the request-serving process]
│   ├── [done] safe discovery, policy scan, content/config/pipeline hashes
│   ├── [done] Markdown parsing, heading chunks, exact-body deduplication
│   ├── [done] inverted lexical candidates, BM25, metadata and link structures
│   ├── [planned] vector/ANN index
│   ├── [partial] time and hierarchy metadata, without dedicated indexes
│   ├── [partial] complete-generation crash recovery, without per-file checkpoints
│   └── [done] checksummed staging -> READY -> atomic CURRENT publication
│
├── Local persistence plane [partial: one sensitive snapshot per source and mode]
│   ├── [partial] strict configured source catalog, without a durable catalog/UI/journal
│   ├── [partial] lexical statistics persisted; in-memory postings rebuilt on reopen
│   ├── [planned] vector index
│   ├── [partial] monolithic derived payload containing content, chunks and metadata
│   ├── [done] immutable READY generations
│   └── [done] atomic CURRENT pointer
│
├── Online query plane [partial: lexical retrieval is complete; hybrid retrieval is not]
│   ├── [partial] corpus/scope modes, without per-project authorization IDs
│   ├── [partial] parallel per-source BM25/metadata, without dense retrieval
│   ├── [partial] bounded graph reranking, without RRF or a pluggable reranker
│   ├── [partial] ingestion deduplication and extractive chunk packing
│   └── [partial] traceable evidence or safe abstention; real-corpus five-second acceptance pending
│
├── Controlled write plane [planned in this repository]
│   ├── correction proposals with sources and a structured before/after diff
│   ├── risk policy and human approval token
│   ├── isolated writer adapters with compare-and-swap preconditions
│   ├── append-only audit, receipts and rollback
│   └── commit -> reingest -> new evidence-version receipt
│
└── Reusable interfaces [partial]
    ├── [done] local Markdown-directory read source
    ├── [done] MCP and authenticated local REST read APIs
    ├── [planned] versioned Obsidian/source adapter contract
    ├── [planned] embedding and reranker adapters
    └── [partial] model-neutral reads; no cross-client controlled-write contract
```

The sequencing consequence is important. First make large collections cheap and resumable with a content-hash catalog, change journal/checkpoints, compact lexical postings, per-document recompilation, and a shared artifact specification. A private evaluation track may test optional local embeddings, metadata/time/hierarchy retrievers, RRF, and rerankers in parallel, but none should become the default unless it improves labeled retrieval while preserving scope isolation, traceability, privacy, and the latency target. Source-management UI and additional read adapters follow the stable compiler boundary. Controlled writes come last: no MCP or REST write API should exist until proposal hashes, structured diffs, approval tokens, writer isolation, audit/rollback, and verified reingestion form one closed protocol.

## Ordered delivery

### Phase 1 — bounded, accurate retrieval

Status: implemented in the optional MCP gateway; real-collection acceptance testing remains necessary.

- Isolate stable core, active project, reference, history, control, and generated corpora.
- Default to core; require an explicit retrieval mode for one broader corpus.
- Chunk Markdown by structure and rank lexical candidates with BM25-style scoring.
- Let eligible links and metadata rerank textual evidence within a fixed bound; never create graph-only evidence.
- Deduplicate exact bodies, abstain when evidence is missing, and keep every result traceable to source/document/version/span/chunk IDs.
- Bound chunks and the complete evidence pack with conservative UTF-8-byte units. This is a safety upper bound, not an exact tokenizer count.
- Publish verified index generations through `staging → READY → CURRENT`; validate their schema, pipeline/config fingerprint, checksums, stable IDs, and current source metadata before reuse.
- Keep derived generations outside the Markdown roots and Git by default; rebuild or fail closed instead of serving an unverified partial index.

The target for repeated retrieval without source changes remains under five seconds, but v1.2 does not claim that result for every real collection or machine. The next acceptance step is a fixed, privacy-safe corpus on minimum supported hardware, measuring first build, in-process reuse, reopened-generation reuse, p50/p95/p99, accuracy, and five-second violations.

### Phase 2 — distributed source organization

Status: local filesystem federation is implemented; broader source management is not.

- Configure 1–16 explicit, non-overlapping local Markdown roots with stable logical source identities.
- Keep each source in place and give it a separate verified generation; merge ranked results deterministically under one global context budget.
- Require a returned `sourceId` for ambiguous exact reads and report unavailable sources explicitly rather than silently treating them as empty.
- Preserve the old single-root environment contract for simple local use.

Still planned:

- runtime add/remove UI and a user-readable source catalog;
- filesystem watcher/change journal and incremental per-file compilation;
- non-filesystem connectors and portable access-policy adapters;
- reviewed workflows for ambiguous identity merges, ownership/access changes, moves, and deletion.

### Phase 3 — cross-model memory

Status: protocol and retrieval foundation only; durable-memory automation is not implemented.

The proposed `agent-memory/v1` format should represent claims, decisions, preferences, events, open loops, and evidence links as model-neutral Markdown/frontmatter. If those records are placed in an approved local source, v1.2 can already index and return their Markdown under the same corpus, sensitivity, provenance, stable-ID, and context-budget rules. This is a **read foundation**, not full `agent-memory/v1` conformance: the gateway does not yet validate every schema field or provide a memory-specific query engine.

Later work must:

- distinguish observed evidence, model inference, and user-confirmed facts;
- attach scope, sensitivity, confidence, time, provenance, and supersession to every durable record;
- support explicit provider/model-neutral import and export without inheriting hidden model state;
- propose associations and duplicates algorithmically while preserving the evidence that produced them;
- route durable personal facts, high-impact merges, sharing/access changes, conflicts, and forgetting decisions to human review;
- apply approved changes through a separate, auditable write service with preview, rollback, and idempotency.

## What can be automated and what needs confirmation

Safe read-only automation can extract structure, build lexical indexes, identify exact duplicates, propose related evidence, rank candidates, detect stale generations, and assemble bounded source-linked context. These operations are reversible because they only change derived state.

Human confirmation remains necessary before changing durable meaning or authority: creating a long-lived personal memory, merging uncertain identities, accepting an inferred preference as fact, resolving conflicting evidence, widening access, moving or deleting source files, or forgetting/superseding a user-confirmed record.

The target architecture is not “a database that remembers everything equally.” It is a retained evidence base plus an adaptive attention system: broad storage, selective retrieval, explicit uncertainty, and user-governed durable memory.
