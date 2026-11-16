# Contributing

Thanks for taking the time. Mail-MCP is deliberately small, so the most useful contributions are bug reports, fixes, and focused tools that make cleaning up a personal inbox safer or faster.

## Setup

Node.js 22 or newer.

```bash
git clone https://github.com/Rixtayz/Mail-MCP.git
cd Mail-MCP
npm install
npm test
npm run typecheck
npm run build
npm run inspect    # MCP Inspector against dist/index.js
```

The tests mock Microsoft Graph and need no account. To try the server against your own mailbox, run `npm run build && npm run login` and sign in with a personal Microsoft account. No Entra app is needed: the built-in one is used unless you set `MAIL_MCP_CLIENT_ID`.

## Ground rules

1. **No real mail data, ever.** Not in fixtures, not in issues, not in pull requests. Build test messages and headers by hand, with placeholder senders such as `news@example.com`.
2. **Safe by default.** Deletion moves to Deleted Items unless `permanent: true` is passed. Bulk actions support `dryRun`. Every tool declares accurate MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`) so hosts can auto-approve read-only calls and confirm the rest.
3. **No sending, at all.** Mail-MCP never sends email and never requests the `Mail.Send` permission. A feature that needs it is a discussion for an issue first.
4. **Least privilege.** A new Graph permission needs a reason in the pull request, and the README's security section and `SCOPES` in [`src/constants.ts`](src/constants.ts) change together.
5. **Tests first.** Every behavior change comes with a test that fails without it. CI runs on Linux, macOS and Windows with Node 22 and 24.

## Layout

Business logic lives in [`src/mail.ts`](src/mail.ts) and talks to Graph only through [`GraphClient`](src/graph.ts), which tests replace with a mocked `fetch`. Tool definitions in [`src/tools/`](src/tools) stay thin: a zod input schema, an output schema, annotations, and a call into `MailService`.

## Pull requests

- Keep them focused: one change per pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, …).
- Add a line under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.

Security problems go through [SECURITY.md](SECURITY.md) rather than a public issue.

## Releasing (maintainer)

Pushing a tag publishes to npm from GitHub Actions, with provenance, and creates the GitHub release with the Claude Desktop bundle attached.

1. Bump the version in `package.json`, in both `version` fields of `server.json` and in `mcpb/manifest.json`, then run `npm install --package-lock-only`.
2. Move the `Unreleased` entries in `CHANGELOG.md` under a `## [X.Y.Z] - date` heading. The release notes are taken from that section.
3. Commit, then tag and push: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin main vX.Y.Z`.
4. The **Release** workflow checks the tag against `package.json` and that `CHANGELOG.md` has a non-empty section for the version, publishes `@rixtay/mail-mcp` to npm (typecheck, tests and build run first) and creates the GitHub release with `mail-mcp-X.Y.Z.mcpb`. If the `bundle` job fails after `npm` has published, use "Re-run failed jobs", not "Re-run all jobs": re-running all jobs would retry the publish, which fails because the version already exists.
5. Run **Publish to MCP Registry** from the Actions tab. It checks that `server.json` matches the version now on npm, then publishes through GitHub OIDC.

### One-time npm setup

npm publishes without a stored token, through trusted publishing. On npmjs.com, open the package `@rixtay/mail-mcp`, then Settings, Trusted publishing, GitHub Actions, and enter:

- User or organization: `Rixtayz`
- Repository: `Mail-MCP`
- Workflow filename: `release.yml`
- Environment: leave empty
- Allow: `npm publish`

The setting lapses if no publish validates it within 2 days, so set it up shortly before tagging.
