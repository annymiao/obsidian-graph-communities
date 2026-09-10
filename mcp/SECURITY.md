# Security and privacy boundary

This repository is code-only. Reports must never include a real Vault, note, attachment, generated index, credential, absolute local path, or backup.

## Runtime guarantees

- The service exposes read-only filesystem operations.
- It skips symbolic links and excluded directories.
- Note text is treated as untrusted data and cannot grant tools or permissions.
- HTTP mode requires authentication and should bind to loopback or a protected tunnel.
- Context responses are bounded by explicit result and estimated-token limits; legacy character caps remain available as an additional ceiling.
- Generated, control, attachment, malformed-policy, and sensitive notes are inaccessible in every retrieval mode.
- Note-authored frontmatter may narrow access but cannot promote material into a broader retrieval scope.
- Incomplete directory discovery, unsafe file reads, and file-count overflow disable retrieval instead of silently weakening isolation.

These controls reduce accidental disclosure; they are not a replacement for filesystem permissions, encryption, secret management, or a dedicated DLP system.

## Before publishing a version

1. Review `git status --short` and `git diff --cached --name-only`.
2. Confirm no Vault-like directory, attachment, build output, or dependency tree is tracked.
3. Run the repository release audit, which scans every tracked text file for credential markers and machine-specific absolute paths.
4. Build and run the synthetic test suite.
5. Inspect `git archive` rather than only the working tree.

If sensitive data enters Git history, revoke affected credentials immediately and rewrite the unpublished history before pushing. For a public history incident, follow GitHub's sensitive-data removal guidance and assume cloned copies may persist.
