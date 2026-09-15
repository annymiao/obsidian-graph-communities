# Security and privacy boundary

This repository is code-only. Reports must never include a real Vault, note, attachment, generated index, credential, absolute local path, or backup.

## Runtime guarantees

- Vault source access is read-only. Filesystem writes are confined to the configured derived-artifact root; the service never modifies, moves, or deletes Vault notes.
- It skips symbolic links and excluded directories.
- Note text is treated as untrusted data and cannot grant tools or permissions.
- Security-sensitive key, value, extension, path, exclusion, and source-ID normalization uses locale-invariant Unicode lowercasing. Host locale changes, including Turkish-I mappings, cannot turn uppercase policy fields or control directories into an authorization bypass.
- HTTP mode requires authentication and should bind to loopback or a protected tunnel.
- Context responses are bounded by explicit result limits and a UTF-8-byte token upper bound. One byte counts as one budget unit, conservatively covering the supported byte-fallback model tokenizers even for emoji/ZWJ, combining marks, and mixed scripts; legacy character caps remain an additional ceiling.
- Generated, control, attachment, malformed-policy, and sensitive notes are inaccessible in every retrieval mode.
- Note-authored frontmatter may narrow access but cannot promote material into a broader retrieval scope.
- Incomplete directory discovery, unsafe file reads, and file-count overflow disable retrieval instead of silently weakening isolation.
- On POSIX, the artifact root and every managed directory must be owned by the current service user and grant no group/other permission bits; new directories request `0700` and files request `0600`. On Windows, confidentiality depends on the application-data directory's user ACL. Payloads and manifests are hashed, while canonical `READY`/`CURRENT` references are schema-checked and must match those hashes before use. Directory `fsync` is best-effort on platforms that do not support it, so a power loss may discard the newest generation; restart validation fails closed and rebuilds instead of trusting incomplete state. The generic store supports explicit one-step rollback, but retrieval snapshots publish current-only and retain one generation after successful pruning.
- A mode payload contains every eligible note's bounded complete Markdown content and duplicates it in chunk records, plus every discovered Markdown file's relative path, size, modification time, and change time. Separate modes can duplicate content. It is sensitive local data even though it is rebuildable.
- Query reuse never changes visibility pointers. A corrupt current snapshot is treated as a cache miss; only a subsequent complete, stable Vault rebuild may quarantine corrupt pointers and publish a replacement.
- MCP transmission behavior is fixed at process startup by the exact `OBSIDIAN_TRANSMISSION_REVIEW` enum. `required` is the default; invalid non-empty values abort startup instead of silently disabling review.
- `OBSIDIAN_SOURCES_JSON` is a strict 1–16 item catalog. Objects accept only `id`, `name`, and absolute `path`; logical IDs are unique, configured source roots must be real non-symlink directories, and canonical roots cannot overlap. The legacy single-source variables are rejected when the catalog is present.
- Federated results expose only an opaque source ID, configured logical name, Vault-relative path, and `obsidian://` URI. Absolute source and artifact paths are never part of model-facing search, context, read, related, overview, or sanitized source-failure output.
- Each source has its own index and persistent generation subtree. A failure is isolated when another source succeeds and is returned explicitly; all-source failure is an error, never a fabricated empty search result.

## Transmission boundary

- `required` keeps the private editable review and one-time approved delivery for both STDIO and HTTP MCP.
- `trusted-local` returns bounded content directly only from the local STDIO server. HTTP MCP still requires review because loopback addressing is not proof that a connection did not arrive through a tunnel.
- `disabled` explicitly returns MCP content directly over every transport. This removes the human transmission checkpoint; use it only when every transport, client, process environment, and downstream model is trusted.
- In direct modes the server does not register the review resource or review-only tools and does not attach review widget metadata or review instructions. The policy cannot be supplied per tool call and note content cannot change it.
- Authenticated REST endpoints remain a separate trusted-client boundary and return data directly regardless of the MCP review setting.

Persistence defaults to the operating system's application-data directory and may be disabled with `OBSIDIAN_PERSIST_INDEX=false`. Never point `OBSIDIAN_ARTIFACT_PATH` at a Vault, repository, shared directory, or unencrypted backup. The current generation payload is limited to 512 MiB; oversize publication or cleanup failure is reported as degraded while the in-memory result remains usable. Successful pruning removes superseded retrieval generations, but a crash between the atomic pointer switch and pruning can leave an orphan containing old text. For a stronger local purge, stop the gateway first and then delete the complete artifact directory. Checksums detect corruption; they do not encrypt the payload or authenticate against a malicious process running as the same user.

JSON generation payloads are recursively validated both before serialization and after parsing: numbers must be finite and all values must be strings, booleans, null, arrays, or plain objects. Recovery switches the self-contained `CURRENT` pointer once and does not advance `PREVIOUS` first, so a process stop immediately before recovery publication preserves the verified anchor. On POSIX, payload files and affected directories, including the store root's parent, are synced before success is reported. Windows filesystems that reject directory `fsync` receive atomic rename visibility but no power-loss durability promise.

Node.js does not expose a portable `openat`/directory-handle-relative API for every operation. The store pins root and managed-directory device/inode identities and rechecks real paths and identities before and after critical access, which detects replacement before data is returned, but it cannot defeat every malicious same-user race between syscalls. Keep artifact roots in a private, local, non-symlink directory writable only by the service user; a hostile process with permission to rename its ancestors is outside the durability/confidentiality claim.

The upgrade helper follows the same trust boundary. It refuses an existing backup, broad or overlapping target layouts, and targets without the expected package/Skill identities. It validates staged package/runtime/direct-dependency versions, removes AppleDouble metadata, stages before replacement, backs up the old service, Skill, and config before changing any target, writes a completion marker last, and restores all three on failure. Its smoke client calls only the aggregate overview and emits no note text or paths. Upgrade backups may contain credentials and runtime code; keep them private and outside Vaults and source control.

These controls reduce accidental disclosure; they are not a replacement for filesystem permissions, full-disk encryption, secret management, or a dedicated DLP system.

## Before publishing a version

1. Review `git status --short` and `git diff --cached --name-only`.
2. Confirm no Vault-like directory, attachment, build output, or dependency tree is tracked.
3. Run the repository release audit, which scans every tracked text file for credential markers and machine-specific absolute paths.
4. Build and run the synthetic test suite.
5. Inspect `git archive` rather than only the working tree.

If sensitive data enters Git history, revoke affected credentials immediately and rewrite the unpublished history before pushing. For a public history incident, follow GitHub's sensitive-data removal guidance and assume cloned copies may persist.
