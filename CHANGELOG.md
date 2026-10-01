# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.1] - 2026-10-01

### Added

- `mcpName` in `package.json` and a `server.json`, for listing in the official MCP Registry as `io.github.Rixtayz/mail-mcp`.
- `mail-mcp --version`.

### Changed

- Node.js 22 or newer is required (`engines`). Node 20 reached end of life in April 2026; CI now runs Node 22 and 24 on Linux, macOS and Windows.

### Fixed

- Sign-in errors now point to `npx -y @rixtay/mail-mcp login`, which works for npx users. They used to suggest `npm run login` in a clone.
- The version reported to MCP clients now comes from `package.json` instead of a hard-coded string.

## [0.1.0] - 2026-09-09

First public release.

### Added

- MCP server over stdio for personal Outlook.com / Hotmail / Live mailboxes through Microsoft Graph, with nine tools: `mail_list_folders`, `mail_create_folder`, `mail_search`, `mail_get_message`, `mail_senders_summary`, `mail_move`, `mail_delete`, `mail_bulk_by_sender` and `mail_unsubscribe`.
- `mail-mcp login`: browser sign-in (authorization code + PKCE, public client, no secret) with a 0600 file token cache.
- Unsubscribe cascade: RFC 8058 one-click POST, then `mailto:`, then a URL for the assistant's browser.
- Safe defaults: deletion moves to Deleted Items, `permanent: true` to purge, `dryRun` on bulk actions, MCP annotations on every tool.

[Unreleased]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Rixtayz/Mail-MCP/releases/tag/v0.1.0
