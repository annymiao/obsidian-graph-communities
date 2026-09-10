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

## Reporting a vulnerability

Please report security issues privately through GitHub's **Security → Report a vulnerability** flow. Do not include real Vault notes, credentials, or other sensitive content in a public issue.
