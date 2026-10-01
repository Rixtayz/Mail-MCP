# Security policy

Mail-MCP gives an AI assistant access to a personal mailbox. Its promises are that it only acts when a tool is called, that destructive actions stay explicit and reversible by default, that it never exposes a generic "send email" capability, and that the token cache stays on your machine.

A break in any of those promises is treated as a security issue.

## What to report

- A tool result, log line or error message that leaks the access or refresh token, or the token cache contents.
- The token cache written with permissions wider than owner-only, or outside `~/.mail-mcp/` / `MAIL_MCP_CACHE_PATH`.
- A way to send an email to an arbitrary recipient, with arbitrary content, through any tool (the `Mail.Send` permission is meant for `mailto:` unsubscribe requests only).
- A permanent deletion that happens without `permanent: true`, or a bulk action that ignores `dryRun`.
- A network request triggered by message content other than the documented RFC 8058 one-click unsubscribe POST.
- A dependency vulnerability that is actually reachable from this server.

Prompt injection through email content (a message that tells the assistant to delete everything) is a known risk of every mail-connected assistant. Reports are welcome when the server makes it worse, for example through a wrong `destructiveHint` annotation.

## How to report

Please **do not open a public issue**. Use GitHub's private reporting instead: [**Report a vulnerability**](https://github.com/Rixtayz/Mail-MCP/security/advisories/new).

Include the version (`npx -y @rixtay/mail-mcp --version`), your MCP client, and the smallest *synthetic* reproduction (for example the `List-Unsubscribe` header values involved). Never send real messages, addresses or tokens: replace them with placeholders first.

You can expect a first answer within a week. Fixes ship as a patch release, and the advisory is published once a fixed version is on npm.

## Supported versions

Only the latest release on npm receives fixes.
