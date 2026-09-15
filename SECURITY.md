# Security and privacy

## Runtime boundary

Graph Communities runs locally inside Obsidian. It reads complete Markdown notes through Obsidian's Vault API to compute classifications and colors in memory.

The plugin does not:

- send network requests or telemetry;
- require API keys or external services;
- create, edit, move, delete, or export notes;
- include note content in plugin settings;
- persist a generated knowledge index.

The plugin uses Obsidian's internal graph renderer to apply colors and display labels. If that internal interface changes, the expected failure mode is visual only.

## Release boundary

GitHub releases are allowlisted to exactly three installable files:

- `main.js`
- `manifest.json`
- `styles.css`

Vault notes, `.obsidian` settings, local paths, generated indexes, caches, environment files, credentials, and test outputs are excluded. The optional `mcp/` directory contains source code, documentation, and synthetic tests only. `npm run verify` rebuilds both components, scans tracked text files, runs the release audit, and executes both test suites before publication.

AppleDouble metadata (`._*`, `.AppleDouble/`) and local AI/editor tool state such as `.agents/`, `.codex/`, `.cursor/`, and `.vscode/` are ignored repository-wide. Do not force-add them: they can contain local paths, instructions, caches, or machine-specific state.

The optional compiled second-brain service has a separate runtime boundary. Its catalog, generations, chunks, vectors, checkpoints, diffs, approval markers, audit ledger, and rollback material may contain sensitive text or local locators. They must live outside source roots, Git, shared folders, and unencrypted backups with owner-only permissions where the platform supports them.

Online retrieval loads only the immutable generations pinned by the private runtime catalog; it does not scan original sources or re-embed the corpus during a query. Server-created Source/Project/Mode/Path permissions are applied before every retrieval channel and again after fusion/reranking. The authenticated HTTP interface is loopback-only and read-only.

MCP mutation tools are not registered by default. A deployment may enable them only for explicitly writable ordinary-directory sources and only when its host guarantees that app-only tools and private resource metadata do not reach the model. The `trusted-mcp-app` setting is an operator trust assertion, not cryptographic proof of user presence; generic clients must remain read-only or use a separate out-of-band human approval broker. Every enabled write and rollback remains source/version-bound, privately reviewed, audited, and reingested.

Checksums detect corruption and bind versions; they are not encryption and do not defend against a hostile process running as the same OS user. Node.js also lacks a portable `openat`/directory-handle model for every operation, so an adversary able to replace ancestor directories as the same user is outside the documented trust boundary. See [`mcp/SECURITY.md`](mcp/SECURITY.md) for the full compiler, query, write, filesystem, and durability model.

## Reporting a vulnerability

Please report security issues privately through GitHub's **Security → Report a vulnerability** flow. Do not include real Vault notes, credentials, or other sensitive content in a public issue.
