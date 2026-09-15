# Obsidian Knowledge Gateway

Read-only, local-first retrieval for an Obsidian Vault. Version 0.7.0 adds stable evidence IDs, an inverted lexical candidate index, and verified persistent index generations to the bounded, scope-aware retrieval introduced in 0.6.0.

The Vault remains outside this repository and is always authoritative. The gateway never modifies notes. Its rebuildable derived index is stored locally, outside both the Vault and Git by default, so an unchanged collection can be reopened without rereading and rechunking every note.

## Retrieval contract

Every note receives one semantic `corpus` and one effective `retrieval_scope`. Normal calls omit `mode` and search only the stable core corpus.

| Request mode | Eligible scopes | Intended use |
| --- | --- | --- |
| `default` | `default` | Confirmed, reusable core knowledge |
| `project` | `default` + `project` | Active working material |
| `reference` | `default` + `reference` | Courses, papers, templates, and source notes |
| `history` | `default` + `history` | Superseded versions, reports, and archived conversations |

There is no model-facing `all` mode. Notes classified as `never` are unavailable in every mode, including exact-path reads and graph traversal. A query with no lexical evidence returns no result and does not silently widen into another corpus.

Version 0.7.0 still provides corpus-level project retrieval; it does not yet isolate individual projects by `project_id`.

Classification uses conservative path defaults plus a small, strict frontmatter subset. Supported policy fields include `corpus`, `retrieval_scope`, `type`, `status`, `role`/`record_role`, `sensitivity`, `generated`, `archived`, `graph_exclude`, and `graph_exclude_reason`. Untrusted note metadata may narrow access but cannot promote an archive, reference, generated, attachment, or control path into default retrieval. Invalid, multi-valued, or unsupported YAML constructs are quarantined rather than interpreted permissively.

## Indexing and ranking

The indexing and query pipeline:

1. discovers Markdown without following symlinks;
2. classifies each note before it enters a mode-specific snapshot;
3. splits Markdown at real headings while ignoring heading-like text inside fenced code;
4. keeps chunks near an estimated token budget, with bounded overlap;
5. removes normalized exact duplicates, preferring core over broader historical copies;
6. removes conversational query shells, uses an inverted index to select documents with at least two matching terms, a selective rare term, or strong title/alias/tag evidence, and ranks their chunks with BM25 plus bounded metadata boosts; stripped words are a metadata-only fallback only when the primary query returns nothing;
7. uses links, shared tags, and co-citations only as a small reranker of those lexical candidates;
8. publishes a checksummed immutable generation through `staging → READY → CURRENT`;
9. verifies file path, size, modification time, and change time before reusing a stored generation; and
10. packs unique source excerpts into a final estimated-token budget.

Search matches and context excerpts use opaque stable IDs in the hierarchy `source → document → version → span → chunk`; whole-note and related-note results carry the applicable source/document/version prefix. These IDs do not embed the absolute Vault path, filename, or note text. A content change creates a new version/span/chunk identity while the source and document identities remain stable. Set `OBSIDIAN_SOURCE_IDENTITY` to a durable connector identifier if IDs must survive moving the Vault to another machine; otherwise the canonical local Vault path is hashed as the source identity.

Graph proximity can change ordering by at most 12%; it cannot introduce a graph-only answer. Restricted duplicates quarantine the matching eligible copy rather than leaking the same body from another path.

Token counts are conservative estimates, not provider-specific tokenizer results. The overview reports discovered, indexed, excluded, duplicate, unreadable, and truncated note counts so a character ceiling is never presented as full coverage. If directory discovery, a file read, or the configured file-count ceiling would make the index incomplete, retrieval fails closed instead of serving partial results.

## Build and test

Requires Node.js 20 or later and pnpm.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run build
pnpm run test
```

## Local STDIO mode

```bash
export OBSIDIAN_VAULT_PATH='/path/to/your/vault'
node dist/src/index.js
```

Optional settings:

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `OBSIDIAN_EXCLUDE_FOLDERS` | built-in system folders | Additional comma-separated relative folders |
| `OBSIDIAN_INDEX_TTL_MS` | `30000` | Compatibility setting reserved for future watcher reconciliation; v0.7 revalidates source metadata on every request |
| `OBSIDIAN_PERSIST_INDEX` | `true` | Enable verified local derived-index generations |
| `OBSIDIAN_ARTIFACT_PATH` | OS application-data directory | Optional derived-index root; must be outside the Vault |
| `OBSIDIAN_SOURCE_IDENTITY` | canonical Vault path | Optional durable logical source/connector identity used only through an opaque hash |
| `OBSIDIAN_MAX_FILE_CHARACTERS` | `5000000` | Per-file safety ceiling; truncation is reported |
| `OBSIDIAN_MAX_FILES` | `25000` | Maximum discovered Markdown files |
| `OBSIDIAN_CHUNK_TOKENS` | `700` | Estimated tokens per chunk (`200`–`2000`) |
| `OBSIDIAN_CHUNK_OVERLAP_TOKENS` | `80` | Estimated overlap, capped at one third of chunk size |
| `OBSIDIAN_DEFAULT_CONTEXT_TOKENS` | `4000` | Default evidence-pack budget |
| `OBSIDIAN_MAX_SOURCE_TOKENS` | `900` | Maximum excerpt budget for one source |

The content tools accept `mode`. `get_knowledge_context` also accepts `max_tokens`; the older `max_characters` option remains as a secondary compatibility ceiling.

## HTTP mode

The HTTP gateway is intended for a trusted local client or an authenticated tunnel. Do not expose it directly to the public internet.

```bash
export OBSIDIAN_VAULT_PATH='/path/to/your/vault'
export OBSIDIAN_GATEWAY_API_KEY='replace-with-a-random-value-of-at-least-24-characters'
export OBSIDIAN_GATEWAY_HOST='127.0.0.1'
export OBSIDIAN_GATEWAY_PORT='27123'
node dist/src/http.js
```

The older `OBSIDIAN_HTTP_*` names remain accepted for compatibility; `OBSIDIAN_GATEWAY_*` takes precedence.

Direct REST endpoints return authorized data to their authenticated caller; they do not add the Codex review UI. MCP content tools, over STDIO or HTTP MCP transport, create a private editable review draft and return only an opaque review ID. Vault text reaches the model only after the user confirms that draft, and approved content can be collected exactly once.

Keep credentials in the process environment or a local secret manager. Never commit them to Git, the Vault, or an example file.

## Security boundary

- Vault source access is read-only; symlinks and excluded directories are skipped. Writes are confined to the configured derived-artifact root.
- Control, generated, attachment, restricted, malformed-policy, and explicit-`never` notes are isolated before scoring and graph construction.
- Returned note text is labelled as untrusted reference data.
- File, result, excerpt, request, and context budgets are enforced in code.
- The original Markdown remains authoritative; chunks, hashes, scores, and graphs remain disposable derived views.
- On POSIX, persistent payloads request user-only directory/file modes; on Windows, access depends on the application-data directory ACL. Payload and manifest hashes plus validated `READY`/`CURRENT` references are checked before use, and a generation becomes visible atomically only after it is complete. Directory `fsync` is best-effort where the platform does not support it, so a power loss may lose the newest generation; restart validation fails closed and rebuilds instead of trusting incomplete state. Retrieval publication is current-only; after successful cleanup it retains one generation rather than a rollback copy.
- A stored generation is not trusted solely because its checksum matches: schema, pipeline/config fingerprint, stable IDs, and current source metadata are validated too.

Each mode's persistent payload stores the bounded complete Markdown content of every eligible note and duplicates that text in chunk records; it also stores every discovered Markdown file's relative path, size, modification time, and change time. The store accepts one JSON snapshot up to 512 MiB, and separate modes may duplicate eligible content. Treat the directory as sensitive local data: do not put it in the Vault, Git, a shared folder, or an unencrypted backup. `OBSIDIAN_PERSIST_INDEX=false` restores memory-only behavior.

If publication, the 512 MiB limit, or post-publication pruning fails, retrieval continues from the rebuilt in-memory snapshot and reports `persistenceStatus: degraded`. A corrupt current generation is never repaired during reuse: after an authoritative stable Vault rebuild, its pointers may be quarantined and a new current-only generation published, reported as `repaired`. Successful pruning removes superseded retrieval text; a crash between the atomic `CURRENT` switch and pruning can leave an orphan generation. When a stronger purge is required, stop the gateway and delete the complete artifact directory.

This foundation does not yet provide a filesystem watcher, incremental per-file generations, embeddings, multi-source connectors, or automatic note writeback. To avoid a stale authorization window, a complete path/size/mtime/ctime validation scan occurs before every request reuses an in-memory or persisted snapshot. See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for the synthetic benchmark and its non-guarantee boundaries.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the evidence and ranking design and [`SECURITY.md`](SECURITY.md) for the release boundary.
