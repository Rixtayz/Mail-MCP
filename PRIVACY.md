# Privacy

Mail-MCP is open-source software that lets an AI assistant work on your personal Outlook mailbox (Outlook.com, Hotmail, Live or MSN address). This page says what happens to your data.

## Who publishes it

Mail-MCP is published by Rixtayz. The code is public at <https://github.com/Rixtayz/Mail-MCP>.

The Microsoft app that signs you in, named Mail-MCP, is registered through Les Solutions Devforge inc (domain `devforge.ca`), which is why Microsoft's consent screen shows that name as the verified publisher.

## Where it runs

Mail-MCP runs on your own computer, started by your MCP client (Claude Desktop, Claude Code or another). It is not a hosted service.

## What the publisher collects

Nothing. The publisher runs no server for Mail-MCP, and the software sends the publisher no data: no telemetry, no analytics, no usage reports. The publisher has no access to your mail or to your sign-in tokens, which stay on your computer.

## Which services the software talks to

- Microsoft sign-in (`login.microsoftonline.com`), to sign you in.
- Microsoft Graph (`graph.microsoft.com`), to read and organize your mail.
- The unsubscribe address a sender published in its own email, only when you ask to unsubscribe and the sender supports one-click unsubscribe (RFC 8058), and never when that address is on your computer or your local network.

Your mail is read by your AI assistant under the terms of the assistant's own provider. Mail-MCP does not control that.

## What is stored on your computer

A sign-in file, `~/.mail-mcp/token-cache.json` (or the absolute path in `MAIL_MCP_CACHE_PATH`), readable by your user only where the operating system enforces file modes. It holds Microsoft sign-in tokens, never your password. On macOS and Linux, `~/.mail-mcp` is made owner-only (mode 700), and the file is not saved in a folder that belongs to another user or that other users can write to. On Windows the file has the permissions of its folder. The [README](README.md#security-and-privacy) gives the details and their limits.

During a sign-in, a small page that sends your browser on to the Microsoft sign-in page is written to a new temporary folder, and deleted when the sign-in ends. It holds the sign-in link, never a token.

## Permissions and revoking

Mail-MCP asks Microsoft for `Mail.ReadWrite` only. It cannot send email and does not request the permission to. To revoke access:

- Ask your assistant to sign you out (`mail_logout`), or run `npx -y @rixtay/mail-mcp logout`. This deletes the sign-in file, and any temporary copy a save cut short left next to it.
- To also withdraw the app's access on Microsoft's side, open <https://microsoft.com/consent> and remove Mail-MCP.

## Contact

Open an issue at <https://github.com/Rixtayz/Mail-MCP/issues>. For a security problem, use the private route in [SECURITY.md](SECURITY.md). Do not put real email content or tokens in an issue.
