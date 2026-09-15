# Obsidian Knowledge MCP 与远程只读网关

Read-only, local-first retrieval for one or more Obsidian-compatible Markdown roots. Version 1.2.0 integrates the stable evidence IDs, inverted lexical candidate index, verified persistent generations, bounded retrieval, and scope isolation from the published 0.7.0 foundation. It adds a strict, transport-aware transmission-review policy and a federated local source catalog, while preserving the original single-Vault environment contract.

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

Version 1.2.0 still provides corpus-level project retrieval; it does not yet isolate individual projects by `project_id`.

Classification uses conservative path defaults plus a small, strict frontmatter subset. Supported policy fields include `corpus`, `retrieval_scope`, `type`, `status`, `role`/`record_role`, `sensitivity`, `generated`, `archived`, `graph_exclude`, and `graph_exclude_reason`. Untrusted note metadata may narrow access but cannot promote an archive, reference, generated, attachment, or control path into default retrieval. Invalid, multi-valued, or unsupported YAML constructs are quarantined rather than interpreted permissively.

## Indexing and ranking

The indexing and query pipeline:

1. discovers Markdown without following symlinks;
2. classifies each note before it enters a mode-specific snapshot;
3. splits Markdown at real headings while ignoring heading-like text inside fenced code;
4. keeps chunks inside a conservative UTF-8-byte token upper bound, with bounded overlap;
5. removes normalized exact duplicates, preferring core over broader historical copies;
6. removes conversational query shells, uses an inverted index to select documents with at least two matching terms, a selective rare term, or strong title/alias/tag evidence, and ranks their chunks with BM25 plus bounded metadata boosts; stripped words are a metadata-only fallback only when the primary query returns nothing;
7. uses links, shared tags, and co-citations only as a small reranker of those lexical candidates;
8. publishes a checksummed immutable generation through `staging → READY → CURRENT`;
9. verifies file path, size, modification time, and change time before reusing a stored generation; and
10. packs unique source excerpts into one conservative UTF-8-byte token upper bound.

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
| `OBSIDIAN_CHUNK_TOKENS` | `700` | Conservative UTF-8-byte token upper-bound units per chunk (`200`–`2000`) |
| `OBSIDIAN_CHUNK_OVERLAP_TOKENS` | `80` | Conservative UTF-8-byte overlap, capped at one third of chunk size |
| `OBSIDIAN_DEFAULT_CONTEXT_TOKENS` | `4000` | Default conservative evidence-pack upper bound |
| `OBSIDIAN_MAX_SOURCE_TOKENS` | `900` | Maximum conservative excerpt upper bound for one source |
| `OBSIDIAN_TRANSMISSION_REVIEW` | `required` | Exact value: `required`, `trusted-local`, or `disabled`; invalid values stop startup |

The content tools accept `mode`. `get_knowledge_context` also accepts `max_tokens`; one unit is one UTF-8 byte, a deliberately conservative upper bound across the supported byte-fallback model tokenizers. This avoids Unicode undercount for emoji/ZWJ, combining marks, and mixed scripts. The older `max_characters` option remains as a secondary compatibility ceiling, and `estimatedTokenCount` reports this conservative upper bound rather than a tokenizer-specific exact count.

Because this hard bound changes chunk boundaries, 1.2 uses retrieval pipeline fingerprint `v1.2-utf8-budget-1`. An existing 0.7 persistent snapshot is rejected and rebuilt once on first retrieval; logical source/document/version IDs remain stable when their source identity, relative path, and content are unchanged.

## Federated local sources

`OBSIDIAN_VAULT_PATH` remains the fully compatible one-source configuration. To search several long-lived local collections, omit it and provide `OBSIDIAN_SOURCES_JSON` as a strict JSON array:

```bash
export OBSIDIAN_SOURCES_JSON='[
  {"id":"primary-notes","name":"Primary notes","path":"/path/to/primary"},
  {"id":"research-archive","name":"Research archive","path":"/path/to/research"}
]'
```

The array must contain 1–16 objects with exactly `id`, `name`, and `path`. IDs are stable logical connector identities and must be unique ignoring ASCII case; names are the logical source labels returned alongside results; paths must be absolute, real directories. Source roots may not overlap and the configured root itself may not be a symlink. `OBSIDIAN_VAULT_PATH` and `OBSIDIAN_SOURCE_IDENTITY` are rejected when this catalog is present rather than being merged implicitly.

Each source owns a separate `KnowledgeIndex`, opaque source ID, and persistent generation tree. With a custom `OBSIDIAN_ARTIFACT_PATH`, that setting becomes a common artifact root and each logical source receives a hashed child directory. No absolute source or artifact path appears in MCP/REST results.

Searches run across sources concurrently and are merged by lexical-plus-bounded-graph score with deterministic source/path/span tie breaks. Context uses that one global ordering and one global token/character budget; it does not concatenate independently budgeted contexts. Search results, context references, note reads, and related notes include `sourceId` and `sourceName`. In a multi-source process, pass the returned `sourceId` as the `source_id` input to `read_note` or `get_related_notes`; omission fails explicitly so identical relative paths cannot select the wrong collection. A failed source is listed in `source_failures` while available sources may still answer, but if every configured source fails the operation returns an error rather than an empty result. The overview exposes aggregate counts, logical source names, availability totals, and sanitized failures only, including when the explicit catalog currently contains one source.

## Transmission review policy

The review policy is fixed by server configuration; it is never a tool argument and cannot be changed by note content or a model call.

| Value | STDIO MCP | HTTP MCP | Intended boundary |
| --- | --- | --- | --- |
| `required` | private editable review, then one-time delivery | private editable review, then one-time delivery | Fail-safe default |
| `trusted-local` | direct bounded result, with no review resource, review tools, widget metadata, or review instructions | review remains required | Recommended when this machine's local STDIO process is the trusted caller |
| `disabled` | direct bounded result | direct bounded result | Explicit global bypass; use only when every MCP transport and client is already trusted |

To disable the panel only for the local Codex STDIO installation:

```bash
export OBSIDIAN_TRANSMISSION_REVIEW='trusted-local'
```

`trusted-local` never treats an HTTP peer address as proof of locality: an HTTP connection may have arrived through a tunnel. Direct results are still bounded, source-linked, read-only, and treated as untrusted reference data.

## HTTP mode

The HTTP gateway is intended for a trusted local client or an authenticated tunnel. Do not expose it directly to the public internet.

```bash
export OBSIDIAN_VAULT_PATH='/path/to/your/vault'
export OBSIDIAN_GATEWAY_API_KEY=<generated-secret-of-at-least-24-characters>
export OBSIDIAN_GATEWAY_HOST='127.0.0.1'
export OBSIDIAN_GATEWAY_PORT='27123'
node dist/src/http.js
```

The older `OBSIDIAN_HTTP_*` names remain accepted for compatibility; `OBSIDIAN_GATEWAY_*` takes precedence.

Direct REST endpoints return authorized data to their authenticated caller; they do not add the Codex review UI. HTTP MCP content tools follow the policy table above. The default and `trusted-local` configurations both create a private editable review draft over HTTP; only the explicit global `disabled` value returns HTTP MCP content directly.

Keep credentials in the process environment or a local secret manager. Never commit them to Git, the Vault, or an example file.

## Local install and upgrade boundary

`scripts/install-local.sh` is intentionally a first-install helper and refuses existing targets. Use `scripts/upgrade-local.sh` for an existing installation after building and testing 1.2. It first proves that the old service and Skill have the expected identities and that source, install, Skill, config, and backup paths do not overlap. The service stage copies only `dist`, `node_modules`, `package.json`, `pnpm-lock.yaml`, and the smoke, test, and upgrade helpers needed for installed-package diagnostics; Vaults, source notes, derived-index directories, and unrelated project files are not copy inputs. It validates the staged package version against the compiled server and every exact direct dependency, strips removable-media AppleDouble `._*` metadata, creates a new private backup containing the old install, Skill, and Codex config, writes `BACKUP_READY` last, smoke-tests the staged server, swaps same-filesystem targets by rename, updates the `obsidian_knowledge` registration, and smoke-tests again. The smoke client calls only the aggregate overview and prints a redacted diagnostic subset, never note text or local paths. Any failure restores the old directories and config; a successful upgrade retains the backup for a deliberate rollback. The backup target must not already exist and must remain outside every Vault, Git repository, shared directory, and unencrypted backup.

The upgrader accepts either the legacy Vault variable or the federated JSON variable without embedding either value in this repository:

```bash
scripts/upgrade-local.sh \
  /path/to/release /path/to/installed-mcp /path/to/skills \
  /path/to/codex /path/to/node /path/to/config.toml /path/to/new-backup \
  OBSIDIAN_VAULT_PATH /path/to/vault trusted-local
```

For federation, replace the final source-variable pair with `OBSIDIAN_SOURCES_JSON` and one quoted JSON value. Do not mix a 1.2 Skill with an older server. A deliberate rollback should be performed while Codex is stopped: verify `BACKUP_READY`, stage copies of the backup's `install`, `skill`, and `config.toml` beside their destinations, then replace each destination by same-filesystem rename. Keep the current version until the restored server passes the smoke client.

## Security boundary

- Vault source access is read-only; symlinks and excluded directories are skipped. Writes are confined to the configured derived-artifact root.
- Control, generated, attachment, restricted, malformed-policy, and explicit-`never` notes are isolated before scoring and graph construction.
- Returned note text is labelled as untrusted reference data.
- File, result, excerpt, request, and context budgets are enforced in code.
- The original Markdown remains authoritative; chunks, hashes, scores, and graphs remain disposable derived views.
- On POSIX, persistent payloads require the artifact root and managed directories to be owned by the current service user with no group/other permission bits; new directories/files request `0700`/`0600`. On Windows, access depends on the application-data directory ACL. Payload and manifest hashes plus validated `READY`/`CURRENT` references are checked before use, and a generation becomes visible atomically only after it is complete. Root and managed-directory identities are checked before and after critical reads, renames, pointer writes, lock transitions, and recursive cleanup. Directory `fsync` is best-effort only on Windows where the API may reject it; atomic visibility remains, but power-loss durability is not claimed there. Restart validation fails closed and rebuilds instead of trusting incomplete state. Retrieval publication is current-only; after successful cleanup it retains one generation rather than a rollback copy.
- A stored generation is not trusted solely because its checksum matches: schema, pipeline/config fingerprint, stable IDs, and current source metadata are validated too.

Each mode's persistent payload stores the bounded complete Markdown content of every eligible note and duplicates that text in chunk records; it also stores every discovered Markdown file's relative path, size, modification time, and change time. The store accepts one JSON snapshot up to 512 MiB, and separate modes may duplicate eligible content. Treat the directory as sensitive local data: do not put it in the Vault, Git, a shared folder, or an unencrypted backup. `OBSIDIAN_PERSIST_INDEX=false` restores memory-only behavior.

If publication, the 512 MiB limit, or post-publication pruning fails, retrieval continues from the rebuilt in-memory snapshot and reports `persistenceStatus: degraded`. A corrupt current generation is never repaired during reuse: after an authoritative stable Vault rebuild, its pointers may be quarantined and a new current-only generation published, reported as `repaired`. Successful pruning removes superseded retrieval text; a crash between the atomic `CURRENT` switch and pruning can leave an orphan generation. When a stronger purge is required, stop the gateway and delete the complete artifact directory.

This foundation does not yet provide a filesystem watcher, incremental per-file generations, embeddings, runtime source add/remove UI, non-filesystem connectors, or automatic note writeback. To avoid a stale authorization window, a complete path/size/mtime/ctime validation scan occurs before every request reuses an in-memory or persisted snapshot. See [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) for the synthetic benchmark and its non-guarantee boundaries.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the evidence and ranking design and [`SECURITY.md`](SECURITY.md) for the release boundary.
