# Architecture

Obsidian Knowledge Gateway 0.6.0 is a read-only retrieval boundary, not a persistent database. Original Markdown is authoritative. Classification, normalized hashes, chunks, BM25 statistics, link graphs, and context packs are disposable in-memory views that can be rebuilt from the Vault.

```text
Vault outside repository
  -> bounded Markdown discovery and read
  -> path + frontmatter retrieval policy
  -> mode allowlist and hard isolation
  -> heading-aware, token-budgeted chunks
  -> restricted-copy quarantine and exact deduplication
  -> BM25 + metadata lexical candidate gate
  -> small graph rerank inside the eligible subgraph
  -> token-budgeted evidence pack
  -> private editable MCP review
  -> one-time approved transmission
```

## Evidence boundary

The service never writes to the Vault and never stores a durable copy of its index in Git or on disk. Source paths, headings, line spans, snippets, and Obsidian links remain attached to results so downstream answers can be traced back to Markdown evidence.

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

Markdown is divided by ATX heading hierarchy. Fenced blocks using backticks or tildes are tracked so `#` inside code does not become a false section. Oversized sections and long lines are split by a CJK-aware token estimate with bounded overlap and guaranteed cursor progress.

The estimate deliberately avoids coupling the gateway to one model tokenizer. It is used consistently for chunk size, per-source excerpts, and the complete evidence pack, including source headers. Optional character limits remain secondary safety caps.

## Retrieval and abstention

Each chunk stores term frequencies and unique terms. Retrieval combines BM25 body evidence with bounded metadata evidence from title, aliases, tags, headings, and path. A candidate must satisfy the lexical evidence gate before graph scoring occurs.

The graph is built only from notes eligible in the selected mode. Direct links, two-hop paths, shared tags, and co-citations contribute a maximum 12% multiplicative rerank. They may reorder a lexical candidate but may not create a graph-only result or cross an isolated note.

This separation gives the system a meaningful abstention rule: if no chunk has sufficient lexical or exact-phrase evidence, search returns an empty result. The gateway does not fabricate a related answer and does not automatically widen from core into project, reference, or history.

## Duplicate safety

Normalized complete bodies are hashed with SHA-256. Within an eligible mode, one representative survives, ordered by retrieval priority before path name, so a historical filename cannot displace the same core body merely by sorting first.

If an isolated control/restricted note has the same normalized body as an otherwise eligible note, the eligible copy is quarantined as well. Truncated files are not assigned a normalized body hash because equality cannot be established from a prefix.

## Runtime and review boundary

Snapshots are cached independently by retrieval mode for a bounded TTL. They are process-memory caches only and disappear when the gateway stops.

MCP content calls create an editable private review draft. The initial tool result contains no Vault text, only an opaque review ID; the user can remove or change content before approval, and the approved result is collectible once. Direct REST endpoints are a separate trusted-client boundary: authentication, origin policy, request limits, and deployment controls protect them, but they do not invoke the Codex review UI.

## Evolution path

Persistent derived storage, if added later, should preserve the same evidence boundary:

1. keep stable document and source-span identifiers;
2. preserve corpus, scope, provenance, generator version, and time on every record;
3. add project IDs before claiming per-project isolation;
4. add semantic retrieval only behind the same lexical, permission, and evaluation gates;
5. require human approval for durable facts, high-impact entity merges, sharing, and deletion.

The guiding principle remains: full retention, broad recall, selective attention, reversible compression, and traceable evidence.
