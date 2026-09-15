# Security and privacy boundary

This repository is code-only. A release, issue, test fixture, benchmark, log or review report must never include a real Vault, note, attachment, runtime catalog, generated index, rollback capsule, audit ledger, credential, machine-specific personal path or backup.

## Trust model

The original Markdown source is authoritative. Everything under the compiler, generation, query and audit stores is a derived or operational view. It can be rebuilt, but it is still sensitive because it may contain complete chunks, metadata, vectors, diffs, previous content and private local locators.

The trusted computing boundary is the local service user, its private source roots, artifact roots, write-state roots, executable and configured local adapters. Note text, frontmatter, model output, query parameters, HTTP callers before authentication and third-party adapter responses are untrusted.

## Offline compiler guarantees

- Source discovery is bounded and does not follow symbolic links. Protected control, generated and excluded paths are filtered before indexing.
- Files are read as stable, bounded UTF-8 snapshots. Unsupported or ambiguous policy input fails closed; note-authored metadata may narrow access but cannot assign a trusted project, broaden mode visibility or enable writes.
- Source, document, version, span and chunk IDs are domain-separated stable hashes. They improve traceability but are not encryption or authorization.
- Exact deduplication is scoped to an authorization domain. A restricted duplicate quarantines an otherwise eligible copy rather than becoming an alternate disclosure path.
- Per-file checkpoints and the compiler journal are private state. Reuse requires matching source, policy, build plan and content Hashes.
- Immediately before publication, the compiler rescans the complete source set. A change during compilation prevents the stale generation from becoming current.
- Each artifact layer is canonicalized and SHA-256 checked. A generation is written to staging, verified, marked `READY`, and only then selected by an atomic `CURRENT` replacement.
- Runtime catalog publication happens after every configured source has completed. It is a checksummed, bounded private file and requests `0600` permissions on POSIX.

## Online query guarantees

- The compiled runtime reads only the local runtime catalog and the immutable generation pinned for each source by `generationId` and `manifestSha256`. Per-source `CURRENT` is consulted when publishing a new catalog, not followed independently by an already-published multi-source view. The runtime does not scan a source directory or recompute full-corpus embeddings during startup or query.
- Consequently, a compiled read-only source can be offline while its local artifacts remain queryable. This is not true for preparing a write or for write-triggered reingestion.
- The loader validates schema, layer Hashes, source/project identity, ordinals, active/tombstoned documents, record/version coverage, compact lexical materialization and Vector adapter/model/kind/dimension/input recipe before publishing an in-memory view.
- Authorization is a server-created Principal. Tool and HTTP inputs can only intersect/narrow its allowed source, project, mode and path sets. Project-scoped records fail closed without an explicitly allowed project.
- Reusable client integrations should call `runtime.bindRead(principal)` once and expose only the returned read facade. Raw Runtime API methods that accept a Principal and operator `reload` are trusted-host internals, not model-callable tools.
- The same visibility predicate is used before retrieval and after fusion/reranking. Hidden records do not enter the BM25 visible-corpus statistics.
- BM25, Dense, Metadata, Temporal and Hierarchy channels receive only visible records. Adapter-supplied IDs, reasons and exception text are replaced with bounded structural diagnostics before model-visible output.
- Evidence is attributable to source/document/version/record and source-relative line spans. Near-duplicate removal and extractive compression do not create unsupported generated facts.
- Query deadline is capped at five seconds. Built-in stages cooperate with `AbortSignal` and `deadlineAt`; timeout, empty evidence and source failure yield explicit safe refusals.

The deadline cannot forcibly interrupt arbitrary synchronous JavaScript that blocks the event loop. A third-party retriever, embedding adapter or reranker must cooperatively observe cancellation and the deadline, or run in an isolated worker/process with an external timeout. Non-cooperative third-party code is outside the five-second claim.

## Transmission and HTTP boundary

- `OBSIDIAN_TRANSMISSION_REVIEW` is parsed once at startup. `required` uses a private editable review before query content reaches a model; `trusted-local` permits direct bounded results only for STDIO; `disabled` explicitly removes read-result review.
- Read-transmission policy never applies to mutation authorization. The MCP mutation surface is absent by default. When a trusted host explicitly enables it, every write and rollback requires its own private exact human approval even when query review is disabled.
- Review drafts and UI tokens use app-only MCP tools. Model-facing calls initially receive opaque IDs and bounded status. A reviewed query result can be collected once.
- `OBSIDIAN_SECOND_BRAIN_WRITE_APPROVAL=trusted-mcp-app` is an operator assertion that the MCP host enforces app-only tool and `_meta` isolation; it is not cryptographic proof of user presence. Generic or multi-model clients that cannot enforce that boundary must remain read-only or inject a separately trusted `HumanApprovalBroker` through the Runtime API.
- The local HTTP service is read-only. It has only `/v2/status` and `/v2/query`, accepts loopback peers, requires a Bearer key of at least 32 UTF-8 bytes, compares it in constant time, rejects unsupported fields and query strings, and applies body, origin and rate limits.
- A loopback address is not proof that a request did not traverse a tunnel. Any tunnel requires separate authentication, encryption and origin/deployment controls.
- Direct REST responses are a trusted-client boundary and do not open the MCP review UI.

## Controlled write guarantees

- Production writes are disabled by default and only available when both the host opts into `trusted-mcp-app` approval isolation and a source is explicitly configured as a `writable: true` ordinary directory. Current runtime bootstrap does not enable production writes for `kind: "obsidian-vault"`.
- A prepare call reads the current target and produces a source/version-bound proposal, deterministic structured Diff, risk assessment and binding Hash. It does not mutate the source.
- Critical writes are disabled by default. Every accepted risk level still has `requiresHumanApproval: true`.
- The exact approval document is registered with a bounded TTL and bounded capacity. Editing it, cancelling it, using a different binding Hash, allowing it to expire or attempting replay causes denial.
- Approval signing remains internal. The Writer depends on an `ApprovalVerifier`, not a token issuer. One-time token-use markers are persisted before mutation so restart does not reopen replay.
- The directory Writer accepts only normalized source-relative Markdown paths, rejects symlinks, checks source and state roots, verifies expected base versions, serializes writes, and publishes same-directory replacements by atomic rename.
- Rollback content is stored outside the source before mutation and protected by a signed token. It cannot be indexed as knowledge. After successful rollback, the old full-content capsule is removed.
- Audit events form a locally persisted SHA-256 chain. A stale dead-process lock can be quarantined; a live-owner lock is not stolen.
- A successful filesystem commit followed by an audit or reingestion failure returns a recovery-aware `committed_but_degraded` receipt. Callers must not blindly retry it. Rollback has the corresponding `rolled_back_but_degraded` state.
- Rollback is version-bound, consumes the original recovery material once, and requires a fresh human review. It is rejected if the target has changed again.
- Commit and rollback trigger compiler ingestion and runtime reload. Reingestion observes explicit `present` or `absent` state so delete success is not inferred from an ambiguous null.

`InjectableObsidianWriterAdapter` is an interface for an Obsidian plugin bridge; its host implementation, permissions and UI are part of a separate trust boundary and still require real desktop acceptance testing.

## Filesystem and durability limits

On POSIX, managed artifact, catalog, approval, audit and rollback locations require current-user ownership and no group/other permissions; new directories/files request `0700` / `0600`. On Windows, confidentiality relies on the application-data directory ACL.

Payload files and relevant directories are synced before success on supported POSIX filesystems. Windows can reject directory `fsync`; in that case the implementation provides atomic rename visibility and restart validation but does not promise that the newest generation, catalog or audit tail survives sudden power loss.

Node.js does not expose a portable `openat` / directory-handle-relative API for every operation. The implementation rejects symlinks and checks real paths plus directory device/inode identities before and after critical reads, renames, locks and cleanup. This detects ordinary replacement and many races, but it does not claim to defeat every malicious same-user process that can rename an ancestor directory between system calls. Keep sources and state in private local directories whose ancestors are not writable by an untrusted process.

Checksums detect corruption; they do not encrypt content or authenticate it against a hostile process running as the same user. Use least-privilege filesystem permissions, full-disk encryption and a local secret manager.

## Storage and deletion boundary

- Never put `OBSIDIAN_ARTIFACT_PATH`, `OBSIDIAN_SECOND_BRAIN_CATALOG_PATH` or `OBSIDIAN_SECOND_BRAIN_WRITE_STATE_PATH` inside a source, repository, shared folder or unencrypted backup.
- A generation can duplicate Markdown text between Derived chunks and other structures. Vector values and relative paths can also be sensitive.
- Successful compaction/pruning removes superseded derived generations according to store policy, but a crash after `CURRENT` switches and before cleanup can leave an orphan.
- A rollback capsule may temporarily contain the complete previous document. Audit entries and receipts preserve hashes and metadata after content recovery material is consumed.
- For a stronger purge, stop every compiler/query/writer process first, identify the exact private artifact and write-state roots from local configuration, and remove those complete roots through a deliberate local operation. Deleting derived state does not delete original Markdown.

## Release and validation boundary

Before publishing a version:

1. Inspect `git status --short`, the exact staged paths and `git diff --check`.
2. Confirm no Vault-like directory, source note, runtime catalog, generation, audit/rollback state, backup, dependency tree or build output is tracked.
3. Run the release audit over every tracked text file for credentials and personal absolute paths.
4. Build and run the complete synthetic test suite, including offline-to-online, unavailable-source query, project isolation, deadline, approval replay, degraded receipt, rollback, stale lock and HTTP boundary cases.
5. Inspect `git archive`, not only the working tree.

Synthetic tests prove protocol and failure semantics, not personal-corpus relevance. Before production acceptance, run a repository-external private evaluation for retrieval quality and the five-second target on the intended hardware, and perform a real Obsidian desktop UI pass for review, approve/cancel, reingestion and rollback. Never commit that corpus or its judgments.

If sensitive data enters Git history, revoke affected credentials immediately and rewrite unpublished history before pushing. For a public-history incident, follow the hosting provider's sensitive-data removal process and assume cloned copies may persist.
