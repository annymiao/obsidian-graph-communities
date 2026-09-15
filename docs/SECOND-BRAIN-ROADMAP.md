# Second-brain roadmap

The long-term goal is a user-owned knowledge layer that different AI models can share without treating any model's private conversation history as the source of truth.

The design does not copy human forgetting as a deletion rule. Human memory is useful as an attention metaphor, while AI's advantage is retaining more attributable evidence and revisiting it cheaply. The system therefore keeps original material until the user explicitly changes it, adjusts recall rather than existence, preserves provenance and time, and treats summaries and associations as reversible derived views.

## Version 1.3: five-layer engineering loop

Version 1.3 implements the complete framework path below with synthetic data. Real private-corpus relevance and the Obsidian desktop approval experience remain acceptance work outside the repository.

```text
Obsidian second brain
├── Offline compilation [implemented]
│   ├── bounded safety scan + source/policy/content hashes
│   ├── strict Markdown parsing, heading chunks, authorization-domain deduplication
│   ├── Catalog + Lexical + Vector + Temporal + Hierarchy + Derived artifacts
│   ├── per-file checkpoints, bounded journal, and final source rescan
│   └── checksummed staging -> READY -> atomic CURRENT
│
├── Local persistence [implemented]
│   ├── immutable generations for each source
│   ├── compact lexical base/deltas and precomputed vector contract
│   ├── cross-layer semantic validation, not checksum-only validation
│   └── atomic runtime catalog pinning each source generation + manifest hash
│
├── Online query [implemented]
│   ├── server-owned Source / Project / Mode / Path ACL
│   ├── parallel BM25 / Dense / Metadata / Temporal / Hierarchy recall
│   ├── RRF, optional fixed-loopback reranker, visibility recheck
│   └── near-deduplication + extractive compression -> Evidence Pack / safe refusal
│
├── Controlled writes [implemented for explicitly writable ordinary directories]
│   ├── source/version-bound proposal + structured Diff + risk
│   ├── private exact human review + internal one-time approval
│   ├── isolated CAS writer + atomic replace
│   ├── hash-chain audit + recovery-aware receipt + reviewed rollback
│   └── commit/rollback -> reingest -> publish pin -> runtime reload
│
└── Reusable interfaces [implemented]
    ├── Obsidian Vault and ordinary-directory read sources
    ├── safe directory writer and injectable Obsidian writer contract
    ├── offline CLI/watch, bound-principal Runtime read API, MCP, read-only HTTP
    ├── deterministic/fixed-loopback Embedding and optional Reranker adapters
    └── provider-neutral Evidence Pack and controlled-write protocol
```

The default installed MCP surface is read-only. Mutation tools are not registered unless an operator explicitly opts into `trusted-mcp-app` and the host can keep app-only tools and resource metadata away from the model. That opt-in is a deployment trust assertion, not cryptographic proof of user presence. HTTP remains read-only.

## Ordering and parallelism

The offline publication chain is strictly ordered:

```text
trusted source configuration
-> scan and hash
-> parse, chunk, deduplicate
-> build and validate every artifact layer
-> final source rescan
-> READY
-> per-source CURRENT
-> atomic multi-source runtime catalog
-> runtime reload
```

One source failing never publishes a mixed multi-source catalog. The catalog pins each source by generation ID and manifest hash, so one source advancing its own `CURRENT` cannot silently change an older online snapshot.

Within a query, five retrieval channels run in parallel over the same already-authorized records. RRF, optional reranking, a second visibility check, deduplication, diversity, and compression then run in order. No-source, no-evidence, source-failure, and deadline outcomes fail closed. The runtime caps a query at five seconds; third-party synchronous code that blocks the Node.js event loop is outside that cooperative guarantee and must run in an isolated worker/process.

## User operation and human decisions

Normal use should require only:

1. Add one or more sources and run the first offline compilation. It may take a long time.
2. Ask questions. With no new files, the online path uses the validated in-memory generation view rather than rereading the folders.
3. If a trusted local host proposes a source change, inspect source, relative path, operation, risk, and full Diff; approve or cancel. Rollback requires a fresh review.

Algorithms may scan, hash, chunk, index, retrieve, rank, compress, identify exact duplicates, and propose associations or corrections. Trusted configuration or a human must decide source/project access, writable scope, which conflicting claim is true, the final durable content, deletion, and rollback.

## How this addresses the three goals

- **Large folders and token use:** corpus size moves into resumable offline compilation. A model receives only a bounded, source-linked Evidence Pack.
- **Long-lived files in different places:** up to 16 roots remain in place while a private catalog presents one authorized search surface with stable logical IDs.
- **Memory across models:** evidence, versions, provenance, and reviewed writes live outside model conversation state and use provider-neutral interfaces.

## Acceptance still required

The framework is complete, but synthetic tests do not prove relevance on a private collection. Before calling it production-validated, test a repository-external gold set for Recall@k/nDCG, safe refusal, language mix, stale/conflicting evidence, project isolation, disconnected sources, and warm-query latency on the target machine. Then validate the injectable writer and private approval panel in a real Obsidian desktop host, including unsaved edits, sync conflicts, failure recovery, and rollback.

Detailed implementation and trust boundaries are documented in [`mcp/docs/FIVE_LAYER_ARCHITECTURE.md`](../mcp/docs/FIVE_LAYER_ARCHITECTURE.md), [`mcp/SECURITY.md`](../mcp/SECURITY.md), and [`docs/PRODUCT_ARCHITECTURE_1.3.md`](PRODUCT_ARCHITECTURE_1.3.md).
