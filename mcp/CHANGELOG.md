# Changelog

## 0.7.0 — 2026-09-15

- Added deterministic opaque `source → document → version → span → chunk` identities.
- Added immutable local generations published through `staging → READY → CURRENT` with checksums and writer serialization. The generic store supports previous-generation recovery; retrieval snapshots use current-only retention for safer withdrawal.
- Reuse now verifies artifact schema, pipeline/config fingerprint, stable identities, and current file metadata before serving a stored generation.
- Added an inverted lexical candidate index so unchanged queries score only documents containing query terms.
- Added a privacy-safe synthetic benchmark for first build, cached queries, and reopened-generation reuse.
- Retrieval generations use current-only retention after successful pruning, query reuse never mutates visibility pointers, and corrupt state is replaced only after a stable authoritative rebuild.
- Documented that persistence defaults on, stores bounded complete eligible Markdown plus chunk copies, and degrades rather than claiming durability when a 512 MiB payload or cleanup cannot be completed.

## 0.6.0 — 2026-09-10

- Replaced flat whole-Vault retrieval with four explicit modes: core-only `default`, or core plus `project`, `reference`, or `history`.
- Added conservative path/frontmatter policy resolution and hard `never` isolation for control, generated, attachment, restricted, empty, malformed-policy, and structural content.
- Prevented untrusted frontmatter, Legacy prompts, and generated artifacts from promoting themselves into default retrieval.
- Added heading-aware Markdown chunks with fenced-code handling, CJK-aware token estimates, bounded overlap, and progress guarantees for oversized lines.
- Replaced whole-document term scoring with chunk-level BM25 plus bounded title, alias, tag, heading, phrase, and path evidence.
- Limited graph relationships to reranking lexically supported candidates inside the selected corpus; graph-only matches now abstain.
- Added normalized complete-body deduplication, core-first representative selection, restricted-copy quarantine, and explicit truncation diagnostics.
- Added estimated-token budgets for the complete context pack and each source while retaining the legacy character cap as a secondary limit.
- Fail closed on unsupported YAML policy syntax, incomplete directory scans, unsafe file reads, and file-count overflow; bound raw file reads before NUL removal.
- Applied the same mode authorization to search, context, exact note reads, seeds, and related-note traversal.
- Kept all indexes ephemeral and read-only; no Vault content, local index, credential, attachment, or machine-specific path is stored in the repository.
- Retained the private editable MCP review and one-time approved transmission flow; documented that authenticated direct REST calls are a separate trusted-client boundary.
- Added synthetic regression coverage for corpus isolation, long-tail retrieval, duplicate safety, abstention, token limits, fenced headings, sensitive prefixes, and HTTP/MCP review boundaries.

## 0.5.0 — 2026-08-31

- Fixed the first audited, code-only framework snapshot.
- Included the read-only STDIO MCP server and authenticated local HTTP gateway.
- Included editable, one-time transmission review before Vault excerpts reach the model.
- Included synthetic retrieval, graph, traversal, authentication, and review-flow tests.
- Excluded all real Vault content, attachments, backups, generated indexes, credentials, and machine-specific paths.
