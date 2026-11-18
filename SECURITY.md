# Security policy

Mail-MCP gives an AI assistant access to a personal mailbox. Its promises are that it only acts when a tool is called, that destructive actions stay explicit and reversible by default, that it never sends email and never asks for the permission to, and that the token cache stays on your machine.

A break in any of those promises is treated as a security issue.

## What to report

- A tool result, log line or error message that leaks the access or refresh token, or the token cache contents.
- The token cache written with permissions wider than owner-only, outside `~/.mail-mcp/` / `MAIL_MCP_CACHE_PATH`, or at a relative `MAIL_MCP_CACHE_PATH`. On macOS and Linux, also the cache saved in a folder that belongs to another user or that other users can write to. A known limit, not a bug: a custom path cannot be fully protected when any folder above its cache folder belongs to another user (other than root), or other users can write to it and it is not sticky (`/tmp` is sticky, so a folder of your own directly under it is fine). The check reads only the mode bits, so a macOS access control list that lets other users write is not seen (see the README).
- A token left on disk after `mail_logout` or `mail-mcp logout`, such as a temporary file from a save cut short.
- Any path that sends an email, or any request for the `Mail.Send` permission. Mail-MCP only requests `Mail.ReadWrite`.
- A `mail_login` or `mail_logout` result that contains a token, or the token cache contents. `mail_login` may return the Microsoft sign-in URL, which holds no token.
- The sign-in URL passed on the command line of the program that opens the browser (Mail-MCP opens a temporary page instead), or a sign-in still waiting in the browser that can complete after `mail_logout`.
- A permanent deletion by any tool other than `mail_purge`, or by `mail_purge` on messages other than the ids it was given. A bulk action (`mail_bulk_by_sender`) that changes anything without `dryRun: false`.
- A network request triggered by message content other than the documented RFC 8058 one-click unsubscribe POST, or a one-click POST that reaches a loopback, private, link-local or other non-public address.
- An unsubscribe link that `mail_unsubscribe` should answer as `method: "blocked"` (it points to this computer or the local network, is not valid, its host cannot be looked up, or it is plain `http://` with no `mailto:` to use instead) but that it POSTs to or returns as a link to open, or a link that `mail_get_message` or `mail_senders_summary` labels `blocked` but shows anyway.
- A dependency vulnerability that is actually reachable from this server.

Prompt injection through email content (a message that tells the assistant to delete everything) is a known risk of every mail-connected assistant. Reports are welcome when the server makes it worse, for example through a wrong `destructiveHint` annotation, an email body that can end the `<email_content untrusted="true">` frame of `mail_get_message` early, or invisible characters from a message that reach a tool result. Removing hidden content is best effort, and the README lists the ways of hiding text it does not catch; a way it should catch but does not is welcome too.

## How to report

Please **do not open a public issue**. Use GitHub's private reporting instead: [**Report a vulnerability**](https://github.com/Rixtayz/Mail-MCP/security/advisories/new).

Include the version (`npx -y @rixtay/mail-mcp --version`), your MCP client, and the smallest *synthetic* reproduction (for example the `List-Unsubscribe` header values involved). Never send real messages, addresses or tokens: replace them with placeholders first.

You can expect a first answer within a week. Fixes ship as a patch release, and the advisory is published once a fixed version is on npm.

## Supported versions

Only the latest release on npm receives fixes.
