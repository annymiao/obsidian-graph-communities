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
│   ├── document-level lexical base/deltas plus required chunkIndex and precomputed vectors
│   ├── cross-layer semantic validation, not checksum-only validation
│   └── atomic runtime catalog pinning each source generation + manifest hash
│
├── Online query [implemented]
│   ├── server-owned Source / Project / Mode / Path ACL
│   ├── concurrently orchestrated BM25 / Dense / Metadata / Temporal / Hierarchy recall
│   ├── RRF, optional fixed-loopback reranker, visibility recheck
│   └── 5,000 ms cooperative budget -> Evidence Pack / safe refusal [SLO acceptance pending]
│
├── Controlled writes [implemented for explicitly writable ordinary directories]
│   ├── source/version-bound proposal + structured Diff + risk
│   ├── private exact human review + internal one-time approval
│   ├── isolated CAS writer + atomic replace
│   ├── hash-chain audit + recovery-aware receipt + reviewed rollback
│   └── commit/rollback -> reingest -> exact validation -> catalog pin CAS -> in-process reload
│
└── Reusable interfaces [implemented]
    ├── Obsidian Vault and ordinary-directory read sources
    ├── safe directory writer and injectable Obsidian writer contract
    ├── offline CLI/watch, bound-principal Runtime read API, MCP, read-only HTTP
    ├── deterministic/fixed-loopback Embedding and optional Reranker adapters
    └── provider-neutral Evidence Pack and controlled-write protocol
```

The default installed MCP surface is read-only. Mutation tools are not registered unless an operator explicitly opts into `trusted-mcp-app`, the host can keep app-only tools and resource metadata away from the model, and the Principal's source/project ACL includes at least one configured writable directory. This advertises source-level eligibility only. Every proposed path is authorized again against the Principal's included/excluded path prefixes and current source version. The opt-in is a deployment trust assertion, not cryptographic proof of user presence. HTTP remains read-only.

## Ordering and parallelism

The offline publication chain is strictly ordered:

```text
trusted source configuration
-> scan and hash
-> parse, chunk, deduplicate
-> build each artifact layer and its checksums
-> final source rescan
-> READY
-> per-source CURRENT
-> deep cross-layer validation of this run's exact generation + manifest pins
-> atomic multi-source runtime catalog
-> restart or recreate the online bootstrap so it reads the new catalog
```

One source failing never publishes a mixed multi-source catalog. A candidate source `CURRENT` may already have advanced before later deep validation fails, but `CURRENT` is only the source store's physical pointer. The catalog pins each source by generation ID and manifest hash, so the online snapshot remains on the old validated pins. An external offline compiler cannot update an already-running process merely by calling `runtime.reload()`: that method reloads the descriptors already bound in memory and does not reread the catalog. Restart or recreate the bootstrap after an external catalog publication.

Within a query, five retrieval channels are concurrently orchestrated over the same already-authorized records; their built-in synchronous CPU loops are not multicore execution. RRF, optional reranking, a second visibility check, deduplication, diversity, and compression then run in order. No-source, no-evidence, source-failure, and deadline outcomes fail closed. The runtime caps the requested cooperative budget at 5,000 ms and does not release a successful Evidence Pack after it observes expiry. The current baseline still performs O(N) visibility/BM25 work and an O(ND) exact Dense scan, including synchronous sorting, so a wall-clock five-second SLO is acceptance work rather than a claim for arbitrary corpus sizes. Non-cooperative adapters must run in an isolated worker/process.

## User operation and human decisions

Normal use should require only:

1. Add one or more sources and run the first offline compilation. It may take a long time.
2. Ask questions. With no new files, the online path uses the validated in-memory generation view rather than rereading the folders.
3. If a trusted local host proposes a source change, inspect source, relative path, operation, risk, and full Diff; approve or cancel. Rollback requires a fresh review.

Watch reconciliation still reads and hashes every eligible Markdown file to prove that the source snapshot is unchanged. If the scan, policy, compiler, and vector contract are unchanged and compaction is not required, it skips parsing and embedding, reuses the same generation ID, and does not rewrite a logically identical runtime catalog. Controlled writes are different from an external compile: the same process validates the exact new generation, CAS-updates its catalog pin and in-memory descriptor, and can then hot-reload that source.

Algorithms may scan, hash, chunk, index, retrieve, rank, compress, identify exact duplicates, and propose associations or corrections. Trusted configuration or a human must decide source/project access, writable scope, which conflicting claim is true, the final durable content, deletion, and rollback.

## How this addresses the three goals

- **Large folders and token use:** corpus size moves into resumable offline compilation. A model receives only a bounded, source-linked Evidence Pack.
- **Long-lived files in different places:** up to 16 roots remain in place while a private catalog presents one authorized search surface with stable logical IDs.
- **Memory across models:** evidence, versions, provenance, and reviewed writes live outside model conversation state and use provider-neutral interfaces.

## Acceptance still required

The framework is complete, but synthetic tests do not prove relevance on a private collection. Before calling it production-validated, test a repository-external gold set for Recall@k/nDCG, safe refusal, language mix, stale/conflicting evidence, project isolation, disconnected sources, and warm-query latency on the target machine. Then validate the injectable writer and private approval panel in a real Obsidian desktop host, including unsaved edits, sync conflicts, failure recovery, and rollback.

Upgrading existing local artifacts requires one source-online rebuild. The online BM25 path now requires persisted `lexical.chunkIndex`; a legacy generation without it fails closed rather than retokenizing Derived content during a query. Runtime catalog schema v3 does not overwrite v2 in place: stop every publisher and online process using it, move the old private catalog to an isolated backup (or select a new catalog path), run `node dist/src/offlineCompile.js --once`, then restart the online service. Compatible generations may be reused; source Markdown is not modified. MCP also limits `after_content` to 262,144 UTF-8 bytes and the complete private review document to 1,000,000 bytes. Because the latter includes Diff, rationale, and binding metadata, the practical limit for a large replace/delete can be smaller; rejection occurs before a file write.

Detailed implementation and trust boundaries are documented in [`docs/FIVE_LAYER_IMPLEMENTATION_AUDIT_1.3.md`](FIVE_LAYER_IMPLEMENTATION_AUDIT_1.3.md), [`mcp/docs/FIVE_LAYER_ARCHITECTURE.md`](../mcp/docs/FIVE_LAYER_ARCHITECTURE.md), [`mcp/SECURITY.md`](../mcp/SECURITY.md), and [`docs/PRODUCT_ARCHITECTURE_1.3.md`](PRODUCT_ARCHITECTURE_1.3.md).
