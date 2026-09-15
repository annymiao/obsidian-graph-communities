# Changelog

## 1.3.0 — 2026-09-15

- Added the five-layer compiled second-brain path: resumable offline compilation, checksummed multi-layer artifacts, an atomic runtime catalog, cooperative-budget hybrid retrieval, human-approved controlled writes, and reusable model-neutral interfaces.
- Added transition-gated build/generation/catalog locks, durable token-bound release markers, non-retryable post-operation release errors, cross-process cache refresh, typed watch retries, a hash-only schema-v3 deployment fence covering read-only roots and compiler policy, source-binding CAS, idempotent pin retries, and per-source serialization of the full controlled-reingest/publish/reload transition.
- Hardened lock handoff for Linux directory-inode reuse and slow owner publication: directory locks use random owner tokens as their primary instance identity, while file locks boundedly retry incomplete `O_EXCL` owner publication and still fail closed on timeout or structural violations.
- Revalidated catalog, generation, compiler, writer, and controlled-write state against Git/source boundaries again during online bootstrap, including canonicalized symlink targets.
- Canonicalized explicit private-state paths before Git/source isolation checks; no-op reuse now rejects Hash-valid cross-layer drift, and catalog-pinned generations must not use generic pruning before catalog-aware GC exists.
- Added required record/version-bound chunk Lexical persistence for online BM25. Legacy local generations without `lexical.chunkIndex` fail closed and require one source-online offline rebuild; original Markdown is unchanged.
- Added cross-process publication locks, exact build-pin validation, catalog checksum compare-and-swap, and no-op reuse of the same generation and catalog bytes after an unchanged full read-and-hash reconciliation.
- Added strict Source/Project/Mode/Path authorization, BM25/Dense/Metadata/Temporal/Hierarchy recall, RRF, optional fixed-loopback reranking, near-duplicate suppression, extractive Evidence Packs, and explicit timeout/no-evidence/source-failure refusals.
- Defined 5,000 ms as a cooperative query budget and safe-release boundary rather than a proven arbitrary-scale wall-clock SLO; the O(ND) exact Dense scan and O(N) visibility/BM25 baselines still require private-corpus performance acceptance.
- Added source/version-bound proposals, private exact review, durable one-time approval, CAS and atomic directory writes, recovery-aware receipts, hash-chain audit, fresh-approved rollback, reingestion, catalog repinning, and hot reload. Mutation tools remain absent unless a trusted MCP App host explicitly opts in; HTTP remains read-only.
- Made capability reporting explicitly source-level in the documentation while retaining per-path authorization during every prepare. MCP accepts at most 262,144 UTF-8 bytes of `after_content`; the complete private review transport is capped at 1,000,000 bytes.
- Documented that an external offline catalog publication requires an online bootstrap restart/recreation because `runtime.reload()` does not reread the catalog, whereas the in-process controlled-write path validates, repins, updates its descriptor, and hot-reloads the affected source.
- Hardened private state and publication with owner/mode/link/identity checks, deep cross-layer artifact validation, per-source generation plus manifest-Hash pins, checkpoint recovery, and Git-worktree rejection for artifacts, catalogs, and writer state.
- Explicitly reject FAT/exFAT and other filesystems that cannot enforce private permission and managed-directory invariants as runtime-state roots; macOS deployments keep sensitive state in a private APFS application-data directory even when repository code lives on an external volume.
- Made the 1.3 compiler, MCP, and HTTP services the default install and package entries; retained the 1.2 request-time implementation only through explicit legacy commands.
- Added synthetic end-to-end, recovery, authorization, privacy, install/upgrade, interface, and cooperative deadline-behavior regression coverage. No personal Vault content or generated runtime state is included.

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
