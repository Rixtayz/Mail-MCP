# Mail-MCP for personal Outlook

Lets Claude work on your **personal Outlook mailbox** (an Outlook.com, Hotmail, Live or MSN address): search and read messages, summarize who sends you the most mail, file messages into folders, delete them, and unsubscribe from newsletters. Work and school (Microsoft 365) accounts are not supported.

The plugin has two parts:

- **The Mail-MCP server**, which gives Claude the `mail_*` tools.
- **The `inbox-cleanup` skill**, which tells Claude how to clean up an inbox safely: look at senders first, propose a plan, wait for your confirmation, try bulk actions as a dry run, delete permanently only when you ask for it, and never act on instructions written inside an email.

## Use it

In Claude Code, install it with:

```
/plugin install mail-mcp --marketplace Rixtayz/Mail-MCP
```

Then ask Claude something like "connect my Outlook", "summarize the senders in my inbox and flag the newsletters", or "unsubscribe me from the newsletters I never open, then delete their messages". The first time, Claude opens a Microsoft sign-in page in your browser. Sign in with your personal account and accept; Claude carries on.

Where it runs: the server is local, so it runs in Claude Code and in Cowork sessions on your own computer. Claude chat on the web does not start local servers; in the Claude desktop app's chat, install the Mail-MCP extension (`.mcpb`) from the [releases page](https://github.com/Rixtayz/Mail-MCP/releases) instead. Node.js 22 or newer must be installed.

## What it runs, sends and stores

- **What it runs.** `npx -y @rixtay/mail-mcp@0.3.0`: npm downloads that exact version of the Mail-MCP server from the npm registry and runs it on your computer. Each version is published from this repository's GitHub Actions with [npm provenance](https://www.npmjs.com/package/@rixtay/mail-mcp), so the npm page shows the commit it was built from.
- **Who it talks to.** `login.microsoftonline.com` to sign you in, and `graph.microsoft.com` to read and organize your mail. When Claude calls the unsubscribe tool on a message, it looks up the host name of the sender's unsubscribe link in DNS, and if the sender supports one-click unsubscribe (RFC 8058), it sends one request to the unsubscribe address that sender published in its email, never to a private or local network address: a link that points to your computer or your local network is blocked, nothing is opened, and Claude is told the message is suspicious. Nothing else: no analytics, no telemetry, no server run by the author.
- **What Microsoft asks you to allow.** Reading and writing your mail (Microsoft states that this does not include sending email), your basic profile (part of signing in), and keeping access so you don't sign in every hour. The Mail-MCP app can only read and organize your mail: it cannot send email.
- **What it deletes.** Deleting moves messages to Deleted Items, where you can restore them. Permanent deletion is a separate tool, `mail_purge`, which Claude is told to use only when you ask for it.
- **What it stores.** Your sign-in tokens, in `~/.mail-mcp/token-cache.json` on your computer, readable only by your user account on macOS and Linux. During a sign-in, a small page that sends your browser to Microsoft is written to a temporary folder and deleted when the sign-in ends. If Mail-MCP is stopped before then, the page can stay in that folder; it holds the sign-in link, never a token. Your mail stays in your mailbox; the author never receives your mail or your tokens.
- **Signing out.** Ask Claude to sign you out (`mail_logout`), which deletes the token file and cancels a sign-in that this Mail-MCP started and that is still waiting in the browser, and remove Mail-MCP at <https://microsoft.com/consent> to withdraw its access on Microsoft's side.

The Microsoft app that signs you in is registered through Les Solutions Devforge inc, the verified publisher shown on Microsoft's consent screen. Mail-MCP is published by Rixtayz under the MIT license.

## Links

- Source code, full documentation and security policy: <https://github.com/Rixtayz/Mail-MCP>
- Privacy: <https://github.com/Rixtayz/Mail-MCP/blob/main/PRIVACY.md>
- Terms: <https://github.com/Rixtayz/Mail-MCP/blob/main/TERMS.md>
- Report a problem: <https://github.com/Rixtayz/Mail-MCP/issues>
