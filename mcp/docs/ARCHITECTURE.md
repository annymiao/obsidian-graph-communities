# Architecture

Obsidian Knowledge Gateway 0.7.0 is a read-only retrieval boundary with a persistent, rebuildable compiler cache—not a second source of truth. Original Markdown is authoritative. Classification, normalized hashes, chunks, lexical statistics, candidate indexes, link graphs, and context packs are derived views that can always be rebuilt from the Vault.

```text
Request in the current single-process runtime
  -> VALIDATE / REUSE BRANCH
     -> validate the CURRENT pointer/schema and its generation checksum/config/IDs
     -> scan current source path + size + mtime + ctime
     -> if unchanged, reconstruct in-memory query maps without changing pointers

  -> REBUILD / PUBLISH BRANCH (when reuse fails or refresh is requested)
     -> bounded Markdown discovery and safe read
     -> path + frontmatter policy, mode allowlist, hard isolation
     -> stable source/document/version/span/chunk IDs
     -> heading-aware chunks + restricted-copy quarantine
     -> exact deduplication + lexical/graph structures
     -> revalidate the source set; retry or fail closed if it changed
     -> checksummed staging generation -> READY -> atomic CURRENT switch
     -> best-effort pruning of superseded retrieval generations

  -> QUERY / REVIEW BRANCH
     -> inverted lexical candidate gate + BM25/metadata scoring
     -> small graph rerank inside the eligible subgraph
     -> token-budgeted evidence pack
     -> private editable MCP review -> one-time approved transmission
```

## Evidence boundary

The service never writes to the Vault and never stores an index in Git. It may store a durable local derived generation in the operating system's application-data directory. Each mode payload contains every eligible note's bounded complete Markdown content and duplicates it in chunk records; it also records the relative path and metadata state of every discovered Markdown file. Separate modes can therefore duplicate content. The payload is sensitive even though it is disposable and must stay outside the Vault, repository, shared folders, and source-control history. Persistence can be disabled completely.

Source paths, headings, line spans, opaque IDs, snippets, and Obsidian links remain attached to results so downstream answers can be traced to a specific version and span of Markdown evidence. Stable IDs are hashes with domain separation; they hide direct path text but are not encryption, authorization, or proof that a source is trustworthy.

A configured per-file character ceiling is a safety bound, not a claim of complete reading. Files above it are marked truncated and are not exact-deduplicated from their partial body. A truncated restricted file instead applies a conservative normalized-prefix quarantine. Directory discovery errors, unsafe file reads, and the configured file-count ceiling fail the entire build closed rather than serving an index whose privacy classification may be incomplete.

## Corpus policy

The semantic corpus describes a note's role:

- `core`: confirmed, reusable knowledge;
- `project`: active working material;
- `reference`: external evidence and reusable source material;
- `history`: superseded or time-scoped evidence;
- `control`: agent, system, or instruction material;
- `generated`: disposable indexes, navigation, and derived artifacts.

The effective scopes are `default`, `project`, `reference`, `history`, and `never`. Query modes are allowlists:

```text
default   = core/default only
project   = core/default + project
reference = core/default + reference
history   = core/default + history
never     = no query mode
```

Default retrieval therefore cannot be polluted by an archive merely because it contains matching words. `read_note`, seed resolution, related-note traversal, lexical scoring, and graph construction all use the same selected mode.

Hard control/generated paths, attachment storage, restricted sensitivity values, malformed policy values, explicit `never`, empty content, and structural indexes are isolated. Legacy prompt material and ordinary `graph_exclude` notes remain reachable only in explicit history mode; structural graph-exclusion reasons such as generated, system, duplicate, navigation, index, or empty remain `never`.

Frontmatter is untrusted source content. It can restrict a path to a narrower scope but cannot promote a non-core path into `default`. This prevents imported Markdown from authorizing its own transmission. A future human-governed promotion mechanism should live in trusted local configuration or an auditable approval registry rather than relying on imported fields alone.

## Chunk and token model

Markdown is divided by ATX heading hierarchy. Fenced blocks using backticks or tildes are tracked so `#` inside code does not become a false section. Oversized sections and long lines are split by a CJK-aware token estimate with bounded overlap and guaranteed cursor progress. Chunks split from one physical line also carry inclusive UTF-16 column coordinates, so their span IDs remain distinct and reproducible.

The estimate deliberately avoids coupling the gateway to one model tokenizer. It is used consistently for chunk size, per-source excerpts, and the complete evidence pack, including source headers. Optional character limits remain secondary safety caps.

## Retrieval and abstention

Each chunk stores term frequencies and unique terms. The inverted gate admits a document when at least two query terms match, one sufficiently selective term matches, or title/alias/tag metadata provides strong evidence. Conversational shell words are removed when a substantive query term remains. Only when that primary query returns nothing may a stripped word fall back to title/alias/tag matching, so a command word such as “search” cannot outrank the requested subject. Retrieval then combines BM25 body evidence with bounded metadata evidence from title, aliases, tags, headings, and path before graph scoring occurs.

The graph is built only from notes eligible in the selected mode. Direct links, two-hop paths, shared tags, and co-citations contribute a maximum 12% multiplicative rerank. They may reorder a lexical candidate but may not create a graph-only result or cross an isolated note.

This separation gives the system a meaningful abstention rule: if no chunk has sufficient lexical or exact-phrase evidence, search returns an empty result. The gateway does not fabricate a related answer and does not automatically widen from core into project, reference, or history.

## Duplicate safety

Normalized complete bodies are hashed with SHA-256. Within an eligible mode, one representative survives, ordered by retrieval priority before path name, so a historical filename cannot displace the same core body merely by sorting first.

If an isolated control/restricted note has the same normalized body as an otherwise eligible note, the eligible copy is quarantined as well. Truncated files are not assigned a normalized body hash because equality cannot be established from a prefix.

## Generation and runtime boundary

Each retrieval mode owns an isolated generation store. A publisher writes payload, manifest, and `READY` into staging, verifies their SHA-256 chain, renames the complete immutable directory into place, then atomically replaces `CURRENT`. Directory `fsync` is best-effort where a platform does not support it, so a power loss may discard the newest generation; restart validation fails closed and rebuilds rather than trusting incomplete state. A valid reuse reads only the generation named by `CURRENT` and never changes a visibility pointer. The generic `GenerationStore` primitive supports `PREVIOUS` and explicit rollback, but retrieval publication deliberately uses current-only retention so withdrawn text is removed after successful pruning. A corrupt current snapshot is treated as a cache miss; only after Markdown has been rebuilt and the source set has passed a final stability check may its pointers be quarantined and a fresh generation published. Corrupt or partial data is never returned as valid.

The artifact payload also carries its schema version, retrieval-pipeline version, stable-ID scheme, source ID, index-affecting configuration fingerprint, and the metadata state of every discovered Markdown file. Every request validates path, size, modification time, and change time before reusing either an in-memory or persisted snapshot; this deliberately avoids a TTL window in which newly private, deleted, or duplicated content could remain visible. A mismatch invokes the rebuild path; after at most three unstable source-set attempts, retrieval fails closed. There remains a small same-user filesystem race after final validation; a watcher/change journal is the planned stronger reconciliation layer.

Publication has atomic visibility, not atomic end-to-end loading or deletion. One mode payload is capped at 512 MiB; oversize publication or cleanup failure leaves the rebuilt in-memory snapshot usable but reports persistence as degraded. Successful pruning removes superseded generations, while a crash between the `CURRENT` switch and pruning can leave an orphan with old text. Stop the gateway first, then delete the artifact directory for the stronger local purge operation.

This is a logical reuse/rebuild separation inside one request-serving process, not yet distinct offline and online runtimes. The current process reconstructs in-memory maps from the artifact, and every request still pays a full file-list/stat validation pass. A filesystem watcher, incremental compiler, compact postings format, hard performance acceptance corpus, and multi-source catalog remain later work.

## Review boundary

MCP content calls create an editable private review draft. The initial tool result contains no Vault text, only an opaque review ID; the user can remove or change content before approval, and the approved result is collectible once. Direct REST endpoints are a separate trusted-client boundary: authentication, origin policy, request limits, and deployment controls protect them, but they do not invoke the Codex review UI.

## Evolution path

The current persistent foundation preserves the same evidence boundary. Subsequent work should:

1. replace periodic full metadata validation with a resumable change journal and watcher reconciliation;
2. persist compact postings and add incremental per-document recompilation;
3. preserve corpus, scope, provenance, generator version, and time on every future record;
4. add project IDs and source adapters before claiming per-project or multi-source isolation;
5. add semantic retrieval only behind the same permission, evidence, and evaluation gates;
6. isolate any future writer behind structured patches, source-hash preconditions, audit, rollback, and human approval for durable facts, high-impact merges, sharing, and deletion.

The guiding principle remains: full retention, broad recall, selective attention, reversible compression, and traceable evidence.
