# Mail-MCP 0.2.0 — zero-setup install

Design document, 2026-11-16. Status: awaiting approval.

## Why

Mail-MCP fills a real gap: Claude has no connector for personal Outlook.com / Hotmail mailboxes. The code works, but getting to the first email takes about ten steps across three tools: register an app in the Microsoft Entra portal, run a login command in a terminal, edit a JSON config file. Most people who land on the repo from a social post will leave at "Register an app in Microsoft Entra".

The owner wants to announce the project on X and earn stars. Before that, installing it has to be nearly effortless, and nothing about it may look like the author could harvest mail. Security and reliability rank above convenience: if the two conflict, security wins.

## Goals

1. A new user reaches a working mailbox in Claude Desktop with one download, one double-click and one Microsoft sign-in. No Entra portal, no terminal, no JSON.
2. The Microsoft consent screen asks for as little as possible and carries the project's identity (name, logo, privacy and terms links).
3. A sceptical user can check for themselves that the author sees nothing: no server, no telemetry, a package provably built from the public source, clear revocation steps.
4. Existing 0.1.x users keep working without doing anything.

## Non-goals

- Work or school (Microsoft 365) accounts. The product stays personal-accounts only.
- New mail features (drafts, replies, flags, attachments).
- Storing tokens in the OS keychain. Deferred: the native dependency complicates both `npx` and the Desktop bundle. The current file cache stays and is documented honestly.
- The demo GIF and the X post. They come after this release.

## Anti-goals

These would make the release a failure even if everything works:

- Any telemetry, analytics, update ping or other request to a host operated by the author.
- Any code path that sends an email, or any request for the `Mail.Send` permission.
- A token, or the token cache contents, in a tool result, log line or error.
- Claiming in the README or anywhere else that the publisher is "verified" while Microsoft still shows "unverified".

## What is already established

Tested with a real second Outlook.com account on 2026-11-12 and 2026-11-16:

- A personal account that does not own the Entra app can consent to it and use it. The shared-app approach works.
- "Allow public client flows" and pre-declared API permissions in the portal are **not** needed for the authorization-code + PKCE loopback flow. A redirect URI of `http://localhost` on the "Mobile and desktop applications" platform is enough.
- With scopes reduced to `Mail.ReadWrite`, the consent screen shows three lines: read/write mail (Microsoft adds "does not include permission to send"), basic profile (from `openid profile`, which MSAL always requests), and keep access (`offline_access`).
- The consent screen shows a generic "MM" logo and, in bold, "the publisher has not provided links to their terms". Both are fixable in the app's branding settings.
- A personal account completed a sign-in against the production app on 2026-11-16 with `Mail.ReadWrite` only: the granted scopes were `Mail.ReadWrite openid profile`, and a Graph mail call returned 200.
- What the app owner can see is **only partly verified**. A few minutes after that sign-in, the DevForge tenant showed an empty "Users and groups" list and no sign-in log entry for the production app. That matches the expectation that personal accounts sign in through Microsoft's consumer tenant and leave no trace in the owner's tenant, but sign-in logs can lag by hours. **Re-check the next day before `PRIVACY.md` is finalised** (see Testing).
- `@azure/msal-node` 7 serves the loopback success/error templates without a `Content-Type`, so the HTML templates in 0.1.2 render as raw markup. This is a live bug.

The production Entra app exists:

- Name `Mail-MCP`, registered in the DevForge tenant (Les Solutions Devforge inc), publisher domain `devforge.ca`.
- Application (client) ID: `599bb072-c4e2-42b1-b4e5-1d901fc08c66`.
- Audience: any Entra tenant + personal Microsoft accounts (required for publisher verification). The code keeps the `consumers` authority, so only personal accounts can sign in through Mail-MCP.
- Redirect: `http://localhost`, public client. No secret.
- Publisher verification was attempted on 2026-11-16 and failed with Microsoft's generic "temporary problem" error. A retry is pending. **Nothing in this design depends on it succeeding.**

## Decisions made by the owner

- Ship a default client ID belonging to the owner's company, so users skip the Entra portal.
- Keep "bring your own Entra app" as a documented option, for cautious users and as a fallback if Microsoft ever disables the shared app.
- Everything must be secure and reliable; nothing may suggest the author can retrieve data.
- Remove email sending completely (decided 2026-11-16). Today the `mailto:` unsubscribe sends a message whose recipient and text come from the sender's `List-Unsubscribe` header, with no copy in Sent Items; a crafted email could turn "unsubscribe me" into mail sent to a third party from the user's account. Rather than harden that path, it is removed: Mail-MCP never sends email.

## The design

Decisions below marked *(my call)* were made by the designer, not the owner, and are open to challenge.

### 1. Default client ID

- `MAIL_MCP_CLIENT_ID` becomes optional. When it is unset or empty, the server uses the built-in ID above.
- The authority stays `https://login.microsoftonline.com/consumers`.
- `server.json` marks the variable as optional and rewrites its description.
- Compatibility: a 0.1.x user who keeps their own `MAIL_MCP_CLIENT_ID` and existing token cache keeps working with no new sign-in. A user who removes the variable signs in once more against the shared app.

### 2. Permissions

- The only scope requested is `Mail.ReadWrite`. `User.Read` is dropped (no code calls the profile endpoint). `Mail.Send` is never requested, and the `/me/sendMail` call is deleted from the code.
- `mail_unsubscribe` no longer sends anything. Its cascade becomes *(order is my call)*:
  1. RFC 8058 one-click POST, unchanged.
  2. Otherwise, if the header has an HTTPS link: return it for the assistant's browser, as today.
  3. If the header has a `mailto:` target: return it as a ready-to-click `mailto:` link (address, plus the subject and body the sender published), with a `detail` telling the assistant to hand the link to the user, who sends it from their own mail app. The result is `ok: false`: nothing has been sent.
  When both an HTTPS link and a `mailto:` target exist, the result carries both.
- This is a behaviour change for 0.1.x users: `mailto:`-only unsubscribes used to be automatic and now need one click from the user. It goes under "Removed" in the changelog, with the reason.
- A 0.1.x user's existing consent may still include `Mail.Send` on Microsoft's side. The server no longer uses it; the README explains how to remove the app's access and sign in again to shed it.

### 3. Sign-in without a terminal

Two new tools *(my call: explicit tools rather than opening a browser as a side effect of a read-only call)*:

**`mail_login`** — no input.

- Already signed in: returns the account name. No browser.
- Otherwise: starts the same interactive browser sign-in as the CLI, in the background, and opens the system browser. It waits a short while for the user to finish (target: comfortably under a 60-second client timeout) and returns either "signed in as …" or `pending`, with the sign-in URL in case the browser did not open and an instruction to call `mail_login` again once the user is done.
- Only one sign-in is in flight at a time. A second call while one is pending reports its status and does not open another window. An abandoned sign-in gives up after a few minutes and frees the loopback port.
- The result never contains a token. The sign-in URL is safe to return: it holds the client ID and the PKCE challenge only.

**`mail_logout`** — no input. Removes the local token cache and returns the Microsoft page where the user can also revoke the app's access (`https://microsoft.com/consent`, the address Microsoft prints on the consent screen).

Every other tool, when no account is signed in or the token has expired, answers with an error that points the assistant to `mail_login`. The CLI is mentioned only as a fallback.

CLI: `mail-mcp logout` is added; `--help` is updated.

Annotations follow the existing convention; neither tool is read-only, neither is destructive, `mail_login` is open-world.

### 4. Sign-in result page

The success and error templates become plain sentences without markup, so they read correctly whatever content type MSAL sends.

### 5. One-click install for Claude Desktop

- A Claude Desktop extension bundle (`.mcpb`) is built from the repo: compiled `dist/`, production dependencies, a manifest with name, description, version, icon, the tool list, and one optional advanced setting, "Your own Entra client ID", mapped to `MAIL_MCP_CLIENT_ID`.
- The builder must write the manifest against the **current** MCPB specification, not from memory.
- `npm run build:mcpb` produces it locally. A CI job attaches `mail-mcp-<version>.mcpb` to each GitHub release.
- The manifest version must equal `package.json`'s; the existing version-consistency check is extended to cover it.

### 6. Verifiable releases

- npm publishing moves from the owner's machine to a GitHub Actions workflow that runs typecheck, tests and build, then publishes with provenance through npm trusted publishing (OIDC, no stored token). The existing MCP Registry workflow stays as is, or is chained after it.
- This needs a one-time setting by the owner on npmjs.com (declare the repo and workflow as trusted publisher). The builder checks the current npm requirements and writes the exact steps for the owner.

### 7. Documentation

- **README**, restructured around the new path:
  - Quick start for Claude Desktop (download the `.mcpb`, install, say "connect my Outlook"), then Claude Code (one line, no variable), then other MCP clients (JSON without `env`).
  - "Security and privacy" section: what the author can see (nothing, and why), every host the server contacts, each line of the consent screen and why it is there, the fact that Mail-MCP cannot send email (Microsoft's own consent screen says so), where the token lives, how to sign out and revoke, how to check the package's provenance.
  - "Use your own Entra app" as an advanced section, cut to the four steps that are actually needed.
  - Commands that set environment variables shown for both bash and PowerShell.
  - The stale "msal-node v6" mention fixed.
- **`PRIVACY.md`** and **`TERMS.md`** at the repo root *(my call: in the repo rather than on devforge.ca, so they are public and versioned)*. Short and plain: the author collects nothing and operates no service; the software is MIT, without warranty. Because DevForge's name is on them, **the owner reads and approves the wording** before release.
- **`SECURITY.md`**: the promise becomes "never sends email, and never asks for the permission to"; any path that sends mail is a reportable break. The new tools are covered.
- **`CHANGELOG.md`**: a 0.2.0 entry.

### 8. Entra app branding (manual, in the portal)

Done once `PRIVACY.md` and `TERMS.md` are on `main`: upload a square logo, set the home page URL (the repo), the terms URL and the privacy URL. The repo has no square logo yet; the builder derives one from the existing artwork in `docs/` or asks the owner for one.

## Testing

- Unit tests (vitest, mocked auth and Graph, as today) for: default vs overridden client ID, including the empty-string case; the new unsubscribe cascade, including a check that no request to `/me/sendMail` is ever made; `mail_login` in its three states (already signed in, completes in time, pending) and the single-flight rule; `mail_logout`.
- The existing suite keeps passing on Node 22 and 24, on Linux, macOS and Windows.
- Manual acceptance, on Windows at least, with a personal account that does not own the Entra app:
  1. Install the `.mcpb` in Claude Desktop with no configuration.
  2. Ask Claude to connect the mailbox; the browser opens; the consent screen shows the three reduced permission lines.
  3. A read tool works.
  4. A `mailto:`-only unsubscribe returns a link, sends nothing, and the link opens a pre-filled message in the user's mail app.
  5. `mail_logout` signs out; the next tool call asks to sign in.
  6. A 0.1.2 setup with its own client ID and existing cache still works after upgrading.
  7. After step 3, the owner looks at the Mail-MCP enterprise application in the DevForge Entra tenant ("Users and groups", "Sign-in logs") the next day. If anything about the test account appears there, the "what the author can see" wording in the README and `PRIVACY.md` is corrected to say exactly what is visible before release.

## Left to the builder

- Internal structure of the auth module and the seams needed to test it.
- The exact wait and give-up durations in `mail_login`.
- Tool descriptions, schemas and error wording, following the style of the existing tools.
- Bundling details for the `.mcpb` and the CI job layout.
- Order of work and how it is split into commits or pull requests.
