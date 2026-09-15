# Security and privacy boundary

This repository is code-only. Reports must never include a real Vault, note, attachment, generated index, credential, absolute local path, or backup.

## Runtime guarantees

- Vault source access is read-only. Filesystem writes are confined to the configured derived-artifact root; the service never modifies, moves, or deletes Vault notes.
- It skips symbolic links and excluded directories.
- Note text is treated as untrusted data and cannot grant tools or permissions.
- HTTP mode requires authentication and should bind to loopback or a protected tunnel.
- Context responses are bounded by explicit result and estimated-token limits; legacy character caps remain available as an additional ceiling.
- Generated, control, attachment, malformed-policy, and sensitive notes are inaccessible in every retrieval mode.
- Note-authored frontmatter may narrow access but cannot promote material into a broader retrieval scope.
- Incomplete directory discovery, unsafe file reads, and file-count overflow disable retrieval instead of silently weakening isolation.
- On POSIX, persistent generations request `0700` directories and `0600` files; on Windows, confidentiality depends on the application-data directory's user ACL. Payloads and manifests are hashed, while canonical `READY`/`CURRENT` references are schema-checked and must match those hashes before use. Directory `fsync` is best-effort on platforms that do not support it, so a power loss may discard the newest generation; restart validation fails closed and rebuilds instead of trusting incomplete state. The generic store supports explicit one-step rollback, but retrieval snapshots publish current-only and retain one generation after successful pruning.
- A mode payload contains every eligible note's bounded complete Markdown content and duplicates it in chunk records, plus every discovered Markdown file's relative path, size, modification time, and change time. Separate modes can duplicate content. It is sensitive local data even though it is rebuildable.
- Query reuse never changes visibility pointers. A corrupt current snapshot is treated as a cache miss; only a subsequent complete, stable Vault rebuild may quarantine corrupt pointers and publish a replacement.

Persistence defaults to the operating system's application-data directory and may be disabled with `OBSIDIAN_PERSIST_INDEX=false`. Never point `OBSIDIAN_ARTIFACT_PATH` at a Vault, repository, shared directory, or unencrypted backup. The current generation payload is limited to 512 MiB; oversize publication or cleanup failure is reported as degraded while the in-memory result remains usable. Successful pruning removes superseded retrieval generations, but a crash between the atomic pointer switch and pruning can leave an orphan containing old text. For a stronger local purge, stop the gateway first and then delete the complete artifact directory. Checksums detect corruption; they do not encrypt the payload or authenticate against a malicious process running as the same user.

These controls reduce accidental disclosure; they are not a replacement for filesystem permissions, full-disk encryption, secret management, or a dedicated DLP system.

## Before publishing a version

1. Review `git status --short` and `git diff --cached --name-only`.
2. Confirm no Vault-like directory, attachment, build output, or dependency tree is tracked.
3. Run the repository release audit, which scans every tracked text file for credential markers and machine-specific absolute paths.
4. Build and run the synthetic test suite.
5. Inspect `git archive` rather than only the working tree.

If sensitive data enters Git history, revoke affected credentials immediately and rewrite the unpublished history before pushing. For a public history incident, follow GitHub's sensitive-data removal guidance and assume cloned copies may persist.
