# Changelog

## 1.3.0 — 2026-09-15

- Added the five-layer compiled second-brain path: resumable offline compilation, checksummed multi-layer artifacts, an atomic runtime catalog, deadline-bounded hybrid retrieval, human-approved controlled writes, and reusable model-neutral interfaces.
- Added strict Source/Project/Mode/Path authorization, BM25/Dense/Metadata/Temporal/Hierarchy recall, RRF, optional fixed-loopback reranking, near-duplicate suppression, extractive Evidence Packs, and explicit timeout/no-evidence/source-failure refusals.
- Added source/version-bound proposals, private exact review, durable one-time approval, CAS and atomic directory writes, recovery-aware receipts, hash-chain audit, fresh-approved rollback, reingestion, catalog repinning, and hot reload. Mutation tools remain absent unless a trusted MCP App host explicitly opts in; HTTP remains read-only.
- Hardened private state and publication with owner/mode/link/identity checks, deep cross-layer artifact validation, per-source generation plus manifest-Hash pins, checkpoint recovery, and Git-worktree rejection for artifacts, catalogs, and writer state.
- Made the 1.3 compiler, MCP, and HTTP services the default install and package entries; retained the 1.2 request-time implementation only through explicit legacy commands.
- Added synthetic end-to-end, recovery, authorization, privacy, install/upgrade, interface, and five-second deadline regression coverage. No personal Vault content or generated runtime state is included.

## 1.2.0 — 2026-09-15

- Integrated the published 0.7.0 retrieval foundation: stable evidence identities, verified persistent generations, scope-aware indexing, lexical candidate selection, bounded graph reranking, and synthetic regression/benchmark coverage.
- Added strict `OBSIDIAN_TRANSMISSION_REVIEW=required|trusted-local|disabled` configuration with fail-safe `required` default and startup failure for other non-empty values.
- Made transmission review transport-aware: `trusted-local` returns bounded content directly only over STDIO, still requires review over HTTP, and `disabled` is the explicit global direct-delivery mode.
- Removed review resources, review-only tools, widget metadata, and review instructions from direct-mode MCP servers; direct content results now identify themselves with `status: direct`.
- Updated the bundled Skill to branch on `direct` versus `pending` results instead of assuming every retrieval opens a review panel.
- Added strict, backward-compatible federation through `OBSIDIAN_SOURCES_JSON`: up to 16 non-overlapping, non-symlink local roots with stable logical identities, separate persistent generations, parallel search, deterministic global ranking, and one context budget.
- Added source-aware evidence and exact-read disambiguation. Search/read/related/context results retain opaque `sourceId` plus logical `sourceName`; multi-source reads require the returned `source_id`, partial source failures are explicit, and all-source failure is not treated as empty retrieval.
- Replaced character-class token heuristics with a UTF-8-byte conservative upper bound so emoji/ZWJ, combining marks, and mixed-script content cannot exceed the configured context budget. The retrieval pipeline fingerprint advances to `v1.2-utf8-budget-1`, intentionally rebuilding older chunk snapshots once.
- Made all retrieval-policy, frontmatter-key, path, extension, exclusion, and source-ID case folding locale-invariant, with Turkish-I and uppercase safety-field regressions.
- Enforced current-user-only POSIX permissions on the persistent store root and managed directories, complementing the documented same-user non-adversarial storage boundary.
- Hardened generation storage with recursive post-parse JSON validation, a single atomic recovery pointer transition, pre/post root and directory identity checks around critical filesystem operations, parent-directory sync on supported platforms, and explicit Windows/same-user threat-boundary documentation.
- Added a staged `upgrade-local.sh` flow with package/Skill identity and non-overlap guards, compiled/dependency consistency validation, AppleDouble cleanup, pre-change backup, redacted staged and post-swap smoke tests, atomic per-target renames, config/Skill update, automatic failure rollback, and a retained rollback backup.
- Preserved the existing project package name, first-install helper, and smoke client. No Vault content, generated index, dependency tree, or build output is part of this source migration.

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
