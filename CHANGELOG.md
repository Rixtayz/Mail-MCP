# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A Claude plugin (`plugin/`) for Claude Code and Cowork: the Mail-MCP server, pinned to the released npm version, plus an `inbox-cleanup` skill that has Claude review senders first, confirm with you, dry-run bulk actions and ignore instructions written inside emails. Claude Code users can install it with `/plugin install mail-mcp --marketplace Rixtayz/Mail-MCP`.

### Security

- `mail_unsubscribe` never hands a link to this computer or the local network to the browser. When an unsubscribe link points there, directly or through its DNS name, it answers the new `method: "blocked"` with no link at all and says the message is suspicious; it used to suggest opening that link in a browser. Plain `http://` links and links whose host cannot be checked are blocked too, and an `https` link now wins over an `http` one listed before it.
- The one-click unsubscribe POST connects only to an address that passed the check, so a DNS name that changes its answer between the check and the connection (DNS rebinding) cannot redirect it. NAT64, 6to4 and IPv4-translated addresses, `192.0.0.0/24` and `198.18.0.0/15` are refused as well, and the response body is no longer read.
- A `mailto:` unsubscribe address holding an invisible formatting character, such as a right-to-left override, is ignored. Control characters are removed from the `mailto:` subject and body, which `mail_get_message` and `mail_senders_summary` now cap at 200 and 1,000 characters.

## [0.2.2] - 2026-11-17

### Changed

- Presented as Mail-MCP for personal Outlook: one name for Outlook.com, Hotmail, Live and MSN addresses. The Claude Desktop extension is now called "Mail-MCP for personal Outlook", and the npm, extension and MCP Registry descriptions list the supported addresses.

## [0.2.1] - 2026-11-17

### Fixed

- The Claude Desktop extension did not start: Claude Desktop refused its display name, "Mail-MCP (Outlook.com / Hotmail)", because of the slash ("path escape"). It is now "Mail-MCP (Outlook.com and Hotmail)".

## [0.2.0] - 2026-11-17

### Added

- A Claude Desktop extension (`.mcpb`) for one-click install.
- `mail_login` and `mail_logout` tools: the assistant signs the user in and out, so no terminal is needed. `mail-mcp logout` does the same from the command line.
- `PRIVACY.md` and `TERMS.md`.

### Changed

- `MAIL_MCP_CLIENT_ID` is now optional. Without it the server uses the built-in Mail-MCP app, so no Entra registration is needed.
- When no account is signed in or the sign-in has expired, tools now tell the assistant to call `mail_login` instead of asking the user to run a terminal command.
- A 401 or 403 from Microsoft now passes on Microsoft's error code and message instead of guessing a cause, and tells the assistant to call `mail_logout`, then `mail_login`, if it keeps happening. It used to ask for a terminal command.
- `mail_senders_summary` now shows, for each sender, the method `mail_unsubscribe` will use. A sender that offers both a link and a `mailto:` address shows `browser`, no longer `mailto`, since no email is needed.
- Sign-in always shows Microsoft's account picker, so you choose which account Mail-MCP uses.
- Releases are published from GitHub Actions with npm provenance, and each GitHub release carries the `.mcpb`.
- The README is rewritten around the one-click install, with a security and privacy section.

### Removed

- The `mailto:` unsubscribe no longer sends an email. `mail_unsubscribe` returns a `mailtoUrl` link for the user to open in their own mail app, because the recipient and text came from the sender's header. `Mail.Send` and `User.Read` are no longer requested.

### Fixed

- Deleting the token cache (or running `mail-mcp logout`) while a server is running now signs that server out too.
- When the token cache also held an account signed in under another client ID, the tools could answer that the sign-in had expired while `mail_login` reported the user signed in. Both now use the same account.
- The page shown in the browser at the end of sign-in displayed raw HTML tags since 0.1.2. It is now plain text.
- An unreadable token cache file is treated as missing, so the next sign-in replaces it. Its content can no longer appear in an error message.

### Security

- Upgraded `@azure/msal-node` to 7.2.2 (GHSA-xcx6-jx8p-x3h5), `@modelcontextprotocol/server` to 2.4.0 (GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq) and `zod` to 4.6.7 (GHSA-mrhx-c7xc-m3w5).
- `mail_search` no longer follows a `cursor` (or a `@odata.nextLink`) that points outside Microsoft Graph. A crafted cursor could make 0.1.x send the access token to another host.
- Graph requests also refuse relative paths that leave `/v1.0`, and never follow redirects.

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

[Unreleased]: https://github.com/Rixtayz/Mail-MCP/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/Rixtayz/Mail-MCP/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Rixtayz/Mail-MCP/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Rixtayz/Mail-MCP/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Rixtayz/Mail-MCP/releases/tag/v0.1.0
