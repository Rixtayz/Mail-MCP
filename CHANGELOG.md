# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A Claude Desktop extension (`.mcpb`) for one-click install.
- `mail_login` and `mail_logout` tools: the assistant signs the user in and out, so no terminal is needed. `mail-mcp logout` does the same from the command line.

### Changed

- `MAIL_MCP_CLIENT_ID` is now optional. Without it the server uses the built-in Mail-MCP app, so no Entra registration is needed.
- When no account is signed in or the sign-in has expired, tools now tell the assistant to call `mail_login` instead of asking the user to run a terminal command.
- A 403 from Microsoft now tells the assistant to call `mail_login` instead of a terminal command.
- Sign-in always shows Microsoft's account picker, so you choose which account Mail-MCP uses.
- Releases are published from GitHub Actions with npm provenance, and each GitHub release carries the `.mcpb`.

### Security

- Upgraded `@azure/msal-node` to 7.2.2 (GHSA-xcx6-jx8p-x3h5), `@modelcontextprotocol/server` to 2.4.0 (GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq) and `zod` to 4.6.7 (GHSA-mrhx-c7xc-m3w5).

### Fixed

- Signing out with `mail-mcp logout` while a server is running now signs that server out too, instead of letting it restore the old sign-in on its next write.
- The page shown in the browser at the end of sign-in displayed raw HTML tags since 0.1.2. It is now plain text.
- An unreadable token cache file is treated as missing, so the next sign-in replaces it. Its content can no longer appear in an error message.

### Removed

- The `mailto:` unsubscribe no longer sends an email. `mail_unsubscribe` returns a `mailtoUrl` link for the user to open in their own mail app, because the recipient and text came from the sender's header. `Mail.Send` and `User.Read` are no longer requested.

## [0.1.2] - 2026-10-01

### Security

- `mail_unsubscribe` no longer sends the one-click POST to a host that is, or resolves to, a loopback, private, link-local or other non-public address (`localhost`, `127.0.0.1`, `10.x`, `192.168.x`, `169.254.x`, `[::1]`, `fd00::`…). The `List-Unsubscribe` URL is chosen by the sender, so a newsletter could otherwise make your machine POST to your router or a local service. Such links now fall back to `mailto:`, or to a URL for the browser.

### Changed

- Dependencies: `@azure/msal-node` 7, whose browser sign-in now returns through `form_post` (checked with a personal Outlook.com account), and `@modelcontextprotocol/server` 2.1.

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

[Unreleased]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Rixtayz/Mail-MCP/releases/tag/v0.1.0
