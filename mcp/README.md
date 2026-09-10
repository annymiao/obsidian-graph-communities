# Obsidian Knowledge Gateway

Read-only, local-first retrieval for an Obsidian Vault. Version 0.6.0 replaces flat whole-Vault retrieval with bounded Markdown chunks, explicit corpus modes, lexical evidence gating, and an editable MCP transmission review.

The Vault remains outside this repository. The gateway does not modify notes or persist a search index; its derived indexes and caches live only in process memory.

## Retrieval contract

Every note receives one semantic `corpus` and one effective `retrieval_scope`. Normal calls omit `mode` and search only the stable core corpus.

| Request mode | Eligible scopes | Intended use |
| --- | --- | --- |
| `default` | `default` | Confirmed, reusable core knowledge |
| `project` | `default` + `project` | Active working material |
| `reference` | `default` + `reference` | Courses, papers, templates, and source notes |
| `history` | `default` + `history` | Superseded versions, reports, and archived conversations |

There is no model-facing `all` mode. Notes classified as `never` are unavailable in every mode, including exact-path reads and graph traversal. A query with no lexical evidence returns no result and does not silently widen into another corpus.

Version 0.6.0 provides corpus-level project retrieval; it does not yet isolate individual projects by `project_id`.

Classification uses conservative path defaults plus a small, strict frontmatter subset. Supported policy fields include `corpus`, `retrieval_scope`, `type`, `status`, `role`/`record_role`, `sensitivity`, `generated`, `archived`, `graph_exclude`, and `graph_exclude_reason`. Untrusted note metadata may narrow access but cannot promote an archive, reference, generated, attachment, or control path into default retrieval. Invalid, multi-valued, or unsupported YAML constructs are quarantined rather than interpreted permissively.

## Indexing and ranking

The in-memory pipeline:

1. discovers Markdown without following symlinks;
2. classifies each note before it enters a mode-specific snapshot;
3. splits Markdown at real headings while ignoring heading-like text inside fenced code;
4. keeps chunks near an estimated token budget, with bounded overlap;
5. removes normalized exact duplicates, preferring core over broader historical copies;
6. ranks lexically supported chunks with BM25 plus title, alias, tag, heading, and path evidence;
7. uses links, shared tags, and co-citations only as a small reranker of those lexical candidates;
8. packs unique source excerpts into a final estimated-token budget.

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
| `OBSIDIAN_INDEX_TTL_MS` | `30000` | Lifetime of an in-memory mode snapshot |
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

- Filesystem access is read-only; symlinks and excluded directories are skipped.
- Control, generated, attachment, restricted, malformed-policy, and explicit-`never` notes are isolated before scoring and graph construction.
- Returned note text is labelled as untrusted reference data.
- File, result, excerpt, request, and context budgets are enforced in code.
- The original Markdown remains authoritative; chunks, hashes, scores, and graphs are disposable derived views.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the evidence and ranking design and [`SECURITY.md`](SECURITY.md) for the release boundary.
